import './helpers';
import { describe, expect, it } from 'vitest';
import replays from './fixtures/live_video_completion_20261008.json';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { evaluateMediaGenerationEvidence, mediaContractForRequest } from '../server/cognition/contracts/media_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { recordsToTaskReceipts, taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../server/tools/types';
import type { LumiTurnFlow } from '../server/cognition/turn_flow';

describe('one completion contract across the media task lifecycle', () => {
  it.each(replays)('replays the real $lane output consistently in final response, feedback and durable completion', replay => {
    const record = replay.record as ToolExecutionRecord;
    const contract = buildActionContract(replay.taskText);
    expect(normalizeActionIntent(replay.taskText)).toMatchObject({ kind: 'media_generation', target: 'generate_video' });
    expect(contract).toMatchObject({ kind: 'media_generation', mediaGeneration: { toolName: 'generate_video', duration: 30, audioRequired: false } });
    expect(contract.mediaPlayback).toBeUndefined();
    expect(evaluateMediaGenerationEvidence(contract, [record], replay).complete).toBe(true);
    expect(hasCoreActionEvidence(contract, [record], replay.taskText, undefined, replay)).toBe(true);
    const final = finalizeLumiResponse({ ...replay, source: replay.lane, responseText: 'Generated.', toolRecords: [record] });
    expect(final).toMatchObject({ blocked: false });
    expect(final.text).toContain('不含音轨');
    expect(buildForegroundTaskCompletionFeedback({ taskId: replay.taskId, taskLabel: replay.taskText, toolRecords: [record], finalization: final }))
      .toMatchObject({ status: 'completed', blockers: [], incomplete: [] });
    expect(buildForegroundTaskCompletionFeedback({ taskId: replay.taskId, taskLabel: replay.taskText, toolRecords: [record] })).toBeUndefined();
    expect(taskCompletionFromReceipts(replay.taskText, recordsToTaskReceipts([record]), undefined, replay).complete).toBe(true);
  });

  it.each([
    ['duration', { duration: 5 }, 'media_settings_mismatch'],
    ['size', { size: '832x480' }, 'media_settings_mismatch'],
    ['audio', { hasAudio: false }, 'media_audio_requirement_unmet'],
  ])('rejects $0 consistently in every completion consumer', (dimension, override, reason) => {
    const replay = replays[0];
    const original = replay.record as ToolExecutionRecord;
    const taskText = dimension === 'audio' ? '生成30秒带英文配音的视频' : replay.taskText;
    const request = { operation: 'text_to_video' as const, prompt: taskText, duration: 30, size: '1920x1080' };
    const contract = mediaContractForRequest(request);
    const payload = JSON.parse(original.result!);
    payload.actualSettings = { ...payload.actualSettings, ...(override as object) };
    const record = { ...original, result: JSON.stringify(payload) };
    const flow = { routeText: taskText, structuredMediaRequest: request, acceptedActionContract: { taskText, contract } } as LumiTurnFlow;
    const final = finalizeLumiResponse({ ...replay, taskText, source: 'chat', responseText: 'Done.', toolRecords: [record], flow });
    expect(evaluateMediaGenerationEvidence(contract, [record], replay)).toMatchObject({ complete: false, reason });
    expect(final).toMatchObject({ blocked: true, reason });
    expect(buildForegroundTaskCompletionFeedback({ taskId: replay.taskId, taskLabel: taskText, toolRecords: [record], finalization: final })?.status).toBe('blocked');
    expect(hasCoreActionEvidence(contract, [record], taskText, undefined, replay)).toBe(false);
  });

  it('does not turn a desktop observation, a DOCX, a stale receipt or an unverified video into a completed video task', () => {
    const replay = replays[0];
    const original = replay.record as ToolExecutionRecord;
    const contract = buildActionContract(replay.taskText);
    for (const record of [
      { ...original, name: 'client_get_state', result: '{"ok":true}' },
      { ...original, name: 'create_docx', result: '{"ok":true,"path":"D:/generated/storyboard.docx"}' },
      { ...original, requestId: 'older-request' },
      { ...original, taskId: 'older-task' },
      { ...original, terminalVerification: undefined },
    ]) {
      expect(hasCoreActionEvidence(contract, [record], replay.taskText, undefined, replay)).toBe(false);
      expect(taskCompletionFromReceipts(replay.taskText, recordsToTaskReceipts([record]), undefined, replay).complete).toBe(false);
    }
  });

  it('keeps creative scene actions separate from additional computer operations', () => {
    expect(buildActionContract('生成30秒视频，画面里打开礼盒').kind).toBe('media_generation');
    expect(buildActionContract('生成图片和视频').mediaGeneration?.standalone).toBe(false);
    expect(buildActionContract('生成30秒视频，然后打开视频').mediaGeneration?.standalone).toBe(false);
    expect(buildActionContract('生成30秒视频，然后发给客户').mediaGeneration?.standalone).toBe(false);
    expect(buildActionContract('播放这个视频').mediaPlayback).toBe('play');
    expect(buildActionContract('暂停视频').mediaPlayback).toBe('pause');
    expect(buildActionContract('生成视频脚本Word文档').kind).not.toBe('media_generation');
  });

  it('keeps structured creative brief nouns inside the accepted generation operation', () => {
    const request = { operation: 'text_to_video' as const, prompt: 'Open the product box. A customer sends a gift, then plays with the toy.', duration: 30, size: '1920x1080' };
    const contract = mediaContractForRequest(request);
    expect(contract).toMatchObject({ kind: 'media_generation', mediaGeneration: { standalone: true, toolName: 'generate_video' } });
  });

  it('reports an incomplete image count as an image requirement', () => {
    const replay = replays[0];
    const taskText = '生成两张图片';
    const record = { ...replay.record, name: 'generate_image', arguments: { n: 2, size: '1024x1024' },
      result: JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', images: ['D:/generated/one.png'] }) } as ToolExecutionRecord;
    const final = finalizeLumiResponse({ ...replay, taskText, source: 'chat', responseText: 'Done.', toolRecords: [record] });
    expect(final).toMatchObject({ blocked: true, reason: 'media_settings_mismatch' });
    expect(final.text).toContain('图片数量或参数');
    expect(final.text).not.toContain('视频');
  });

  it('keeps a finalizer failure visible even when no tool receipt exists', () => {
    expect(buildForegroundTaskCompletionFeedback({ taskId: 'no-output', taskLabel: '生成视频',
      finalization: { blocked: true, reason: 'generation_failed' } }))
      .toMatchObject({ status: 'blocked', completed: [], blockers: ['generation_failed'] });
  });

  it('projects an already adjudicated result without reclassifying its label, while preserving transport failure priority', () => {
    const replay = replays[0];
    const record = replay.record as ToolExecutionRecord;
    const finalization = { blocked: false, reason: 'verified_generation' };
    expect(buildForegroundTaskCompletionFeedback({ taskId: replay.taskId, taskLabel: '播放这个视频', toolRecords: [record], finalization }))
      .toMatchObject({ status: 'completed', blockers: [] });
    expect(buildForegroundTaskCompletionFeedback({ taskId: replay.taskId, taskLabel: replay.taskText, toolRecords: [record], finalization, status: 'persistence_unknown' }))
      .toMatchObject({ status: 'blocked', completed: [] });
  });
});
