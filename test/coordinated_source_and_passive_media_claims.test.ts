import './helpers';
import { describe, expect, it } from 'vitest';
import { responseExecutionClaims } from '../server/work_product/response_execution_claims';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { mediaContractForRequest } from '../server/cognition/contracts/media_contract';
import type { ToolExecutionRecord } from '../server/tools/types';

const scope = { requestId: 'claim-request', taskId: 'claim-task' };
const sourceClaim = 'I have searched and verified the original sources.';
const videoClaim = 'The requested video is generated.';
const task = 'Explain the supplied facts in chat.';
const verified = { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Isolated host receipt fixture.' };
const source: ToolExecutionRecord = { ...scope, name: 'url_fetch', arguments: { url: 'https://example.test/source' },
  result: 'A retrieved source paragraph.', terminalVerification: verified };
const check = (response: string, toolCalls: ToolExecutionRecord[] = [], taskText = task) =>
  guardCompletionClaims({ task: taskText, response, toolCalls, ...scope, claimsOnly: true });
const read = (body: string): ToolExecutionRecord => ({ ...scope, name: 'read_file', arguments: { path: 'D:/fixtures/source.txt' },
  result: body, terminalVerification: verified });

describe('coordinated source assertions retain their evidence requirement', () => {
  it('recognizes the verification predicate split by the shared clause projection', () => {
    expect(responseExecutionClaims(sourceClaim).claims).toEqual([
      { kind: 'source_verification', text: sourceClaim, immediate: false },
    ]);
  });
  it.each(['no receipt', 'failed receipt', 'successful retrieval', 'old request', 'old task', 'empty hits', 'self-described verified'])
    ('does not treat %s as source verification', variant => {
      const records = variant === 'no receipt' ? [] : [{ ...source,
        ...(variant === 'failed receipt' ? { error: 'unavailable' } : {}),
        ...(variant === 'old request' ? { requestId: 'old-request' } : {}),
        ...(variant === 'old task' ? { taskId: 'old-task' } : {}),
        ...(variant === 'empty hits' ? { result: JSON.stringify({ results: [] }) } : {}),
        ...(variant === 'self-described verified' ? { result: JSON.stringify({ verified: true }) } : {}),
      }];
      expect(check(sourceClaim, records).blocked).toBe(true);
    });
  it('permits a source observation with a real current body, without claiming verification', () => {
    const response = 'I have searched the original sources.';
    expect(check(response, [source])).toMatchObject({ blocked: false, text: response });
    for (const records of [[], [{ ...source, requestId: 'old' }], [{ ...source, taskId: 'old' }], [{ ...source, result: '' }]]) {
      expect(check(response, records).blocked).toBe(true);
    }
  });
  it.each([
    'I have not searched and verified the original sources.',
    'I did not search and verify the original sources.',
    'If I have searched and verified the original sources, I should cite them.',
    'The source says "I have searched and verified the original sources."',
    '```text\nI have searched and verified the original sources.\n```',
    'I have searched. Verified the original sources is a heading.',
    'I have searched; verified the original sources is a heading.',
    'I have searched and "verified the original sources" is a quotation.',
    'I have searched and not verified sources. Verified the original sources is a heading.',
  ])('preserves non-asserted text without carrying a subject across its boundary: %s', response => {
    expect(check(response)).toMatchObject({ blocked: false, text: response });
  });
  it.each([sourceClaim, videoClaim])('preserves a requested source body once, but checks an independent repeated assertion: %s', response => {
    const taskText = 'Read D:/fixtures/source.txt.';
    expect(check(response, [read(response)], taskText)).toMatchObject({ blocked: false, text: response });
    expect(check(response + '\n' + response, [read(response)], taskText).blocked).toBe(true);
    expect(check(response, [read(response)], 'Explain the supplied facts.').blocked).toBe(true);
  });
});

describe('passive video completion uses the accepted media contract and its current receipt', () => {
  const videoTask = 'Generate a video.';
  const contract = mediaContractForRequest({ operation: 'text_to_video', prompt: videoTask, duration: 6, size: '1280x720' });
  const video: ToolExecutionRecord = { ...scope, name: 'generate_video', arguments: { duration: 6, size: '1280x720' },
    result: JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', settingsMatch: true,
      actualSettings: { duration: 6, size: '1280x720', hasAudio: false }, outputPath: 'D:/fixtures/generated.mp4' }), terminalVerification: verified };
  const checkVideo = (records: ToolExecutionRecord[], response = videoClaim) => guardCompletionClaims({ task: videoTask,
    response, toolCalls: records, ...scope, acceptedActionContract: { taskText: videoTask, contract } });
  it('allows the passive claim with a current verified video matching the accepted settings', () => {
    expect(responseExecutionClaims(videoClaim).claims).toEqual([{ kind: 'artifact', text: videoClaim, immediate: false, mediaKind: 'video' }]);
    expect(checkVideo([video])).toMatchObject({ blocked: false, text: videoClaim });
  });
  it.each(['missing', 'source read', 'source search', 'text producer', 'image producer', 'old request', 'old task',
    'unverified', 'failed', 'missing artifact', 'remote location', 'settings mismatch'])('rejects %s as video completion', variant => {
    const records = variant === 'missing' ? []
      : variant === 'source read' ? [read('Original text.')]
      : variant === 'source search' ? [source]
      : [{ ...video,
        ...(variant === 'text producer' ? { name: 'write_file', arguments: { path: 'D:/fixtures/output.txt' }, result: JSON.stringify({ ok: true, path: 'D:/fixtures/output.txt' }) } : {}),
        ...(variant === 'image producer' ? { name: 'generate_image' } : {}),
        ...(variant === 'old request' ? { requestId: 'old' } : {}),
        ...(variant === 'old task' ? { taskId: 'old' } : {}),
        ...(variant === 'unverified' ? { terminalVerification: { ...verified, status: 'unverified' as const } } : {}),
        ...(variant === 'failed' ? { error: 'Generation failed.' } : {}),
        ...(variant === 'missing artifact' ? { result: JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified' }) } : {}),
        ...(variant === 'remote location' ? { result: video.result!.replace('D:/fixtures/generated.mp4', 'https://example.test/generated.mp4') } : {}),
        ...(variant === 'settings mismatch' ? { result: video.result!.replace('"settingsMatch":true', '"settingsMatch":false') } : {}),
      }];
    expect(checkVideo(records).blocked).toBe(true);
  });
  it('does not let a video receipt authorize a new request or substitute for another accepted media kind', () => {
    expect(check(videoClaim, [video]).blocked).toBe(true);
    const imageContract = mediaContractForRequest({ operation: 'text_to_image', prompt: 'Generate an image.', size: '1024x1024' });
    expect(guardCompletionClaims({ task: 'Generate an image.', response: videoClaim, toolCalls: [video], ...scope,
      claimsOnly: true, acceptedActionContract: { taskText: 'Generate an image.', contract: imageContract } }).blocked).toBe(true);
  });
  it('allows only the actual video artifact path or its exact filename in a delivery claim', () => {
    for (const target of ['D:/fixtures/generated.mp4', 'generated.mp4']) {
      const response = `The requested video is generated at ${target}.`;
      expect(checkVideo([video], response)).toMatchObject({ blocked: false, text: response });
    }
  });
  it('rejects an explicitly claimed different video path or filename', () => {
    for (const target of ['D:/other/generated.mp4', 'D:/fixtures/other.mp4', 'other.mp4']) {
      expect(checkVideo([video], `The requested video is generated at ${target}.`).blocked).toBe(true);
    }
  });
  it('does not borrow an unrelated ordinary producer to substantiate the claimed video path', () => {
    const producer: ToolExecutionRecord = { ...scope, name: 'write_file', arguments: { path: 'D:/fixtures/other.mp4' },
      result: JSON.stringify({ ok: true, path: 'D:/fixtures/other.mp4' }), terminalVerification: verified };
    expect(checkVideo([video, producer], 'The requested video is generated at D:/fixtures/other.mp4.').blocked).toBe(true);
  });
  it.each([
    'The requested video has not been generated.',
    'The requested video was not generated.',
    'If the requested video is generated, review it before publication.',
    'The source says "The requested video is generated."',
    '```text\nThe requested video is generated.\n```',
    'Is the requested video generated?',
    'Video is generated by encoding frames.',
  ])('preserves a denial, condition, quotation or question: %s', response => {
    expect(check(response)).toMatchObject({ blocked: false, text: response });
  });
});
