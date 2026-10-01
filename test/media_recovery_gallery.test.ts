import { extractSourceExpression } from './source_expression';
import { expect, it } from 'vitest';
import { extractMediaGenerationArtifacts, resolveMediaGenerationOperation } from '../src/lib/mediaGenerationArtifacts';

// Read the real history-to-gallery path; a recovery query is not a new generation.
const expression = extractSourceExpression.bind(null, 'src/components/AgentChatPage.tsx');
const generationNames = expression('MEDIA_GENERATION_TOOL_NAMES', {});
const gallery = expression('extractPersistedMediaArtifacts', {
  MEDIA_GENERATION_TOOL_NAMES: generationNames,
  parsePersistedToolRecords: expression('parsePersistedToolRecords', {}),
  extractMediaGenerationArtifacts,
});
const result = { ok: true, status: 'generated', verified: true, verificationStatus: 'verified',
  images: ['C:/synthetic-generated/recovered.png'], artifacts: [{ type: 'image', path: 'C:/synthetic-generated/recovered.png' }] };

it.each(['generate_image', 'get_image_generation_status'])('displays a verified %s artifact after history reload', name => {
  const artifacts = gallery({ requestId: 'owned-history-request', toolCalls: JSON.stringify([
    { name, arguments: name === 'generate_image' ? { prompt: 'Synthetic image' } : { recoveryId: 'synthetic-recovery' }, result: JSON.stringify(result) },
  ]) });
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]).toMatchObject({ kind: 'image', operation: 'text_to_image', requestId: 'owned-history-request',
    path: 'C:/synthetic-generated/recovered.png', url: '/api/files/generated?path=C%3A%2Fsynthetic-generated%2Frecovered.png&inline=1' });
});

it('does not expose pending query output or treat a query as fresh generation parameters', () => {
  expect(generationNames.has('get_image_generation_status')).toBe(false);
  expect(gallery({ toolCalls: [{ name: 'get_image_generation_status', result: { ...result, ok: false, verified: false, status: 'pending' } }] })).toEqual([]);
  expect(gallery({ toolCalls: [{ name: 'unrelated_tool', result }] })).toEqual([]);
});


it.each(['image', 'video'])('keeps real %s receipts pending preview and merges duplicates without losing validation', mode => {
  const mediaGenerationArtifactsRef = { current: [] as any[] };
  const mediaGenerationArtifactValidationRef = { current: null as any };
  const status: Array<{ status: string; detail: string }> = [];
  const receive = expression('receiveMediaArtifacts', {
    extractMediaGenerationArtifacts, resolveMediaGenerationOperation,
    mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef,
    setMediaGenerationArtifacts: () => {},
    setMediaGeneration: (value: { status: string; detail: string }) => status.push(value),
    mediaGenerationText: { validatingArtifact: 'Checking preview', artifactCountMismatch: 'Wrong count' },
  });
  const active = { requestId: 'current-request', mode, request: { mode, size: '1024x1024', count: 2 } };
  const receipt = { ...result, images: [], artifacts: [{ type: mode, path: 'C:/synthetic-generated/first.' + (mode === 'image' ? 'png' : 'mp4') }] };
  expect(receive('The output is ready', active)).toBe(false);
  expect(receive({ ...receipt, verified: false }, active)).toBe(false);
  expect(mediaGenerationArtifactValidationRef.current).toBeNull();
  expect(receive(receipt, active)).toBe(true);
  expect(status.at(-1)).toEqual(mode === 'image' ? { status: 'error', detail: 'Wrong count' } : { status: 'generating', detail: 'Checking preview' });
  const first = mediaGenerationArtifactsRef.current[0];
  expect(first).toMatchObject({ kind: mode, requestId: active.requestId, operation: 'text_to_' + mode });
  const prior = mediaGenerationArtifactValidationRef.current;
  prior.readyIds.add(first.id); prior.readyIds.add('stale-artifact'); prior.failedIds.add('stale-failure');
  prior.finalized = true; prior.terminalSucceeded = true;
  expect(receive(receipt, active)).toBe(true);
  expect(mediaGenerationArtifactsRef.current).toHaveLength(1);
  expect([...mediaGenerationArtifactValidationRef.current.readyIds]).toEqual([first.id]);
  expect(mediaGenerationArtifactValidationRef.current.failedIds.size).toBe(0);
  expect(mediaGenerationArtifactValidationRef.current.terminalSucceeded).toBe(true);
  const next = { ...receipt, artifacts: [{ type: mode, path: 'C:/synthetic-generated/second.' + (mode === 'image' ? 'png' : 'mp4') }] };
  receive(next, active);
  expect(mediaGenerationArtifactsRef.current).toHaveLength(2);
  expect(mediaGenerationArtifactValidationRef.current.contractValid).toBe(true);
  expect(status.at(-1)).toEqual({ status: 'generating', detail: 'Checking preview' }); // A receipt alone cannot complete the studio.
  receive(next, active, false);
  expect(mediaGenerationArtifactsRef.current).toHaveLength(1);
  expect(mediaGenerationArtifactValidationRef.current).toMatchObject({ finalized: false, terminalSucceeded: false, terminalBlocked: false });
  expect(mediaGenerationArtifactValidationRef.current.readyIds.size).toBe(0);
});
