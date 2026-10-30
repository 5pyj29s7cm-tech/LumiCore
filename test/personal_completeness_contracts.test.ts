import { afterEach, expect, it, vi } from 'vitest';
import { knowledgeIngestionVerified } from '../src/lib/knowledgeIngestionState';
import { withRequestDeadline } from '../src/lib/requestDeadline';
const verified = { ingestionStatus: 'verified', extractionStatus: 'indexed', coverage: { verified: true, sourceRevisionCurrent: true, extractionCoverage: 1, chunkStorageCoverage: 1, embeddingCoverage: 1, blockers: [] } };
afterEach(() => vi.useRealTimers());
it.each(['partial', 'failed', 'unsupported', 'pending', '', 'verified'])('rejects %s extraction despite a verified label', extractionStatus => {
  expect(knowledgeIngestionVerified({ ...verified, extractionStatus })).toBe(false);
});
it.each(['extractionCoverage', 'chunkStorageCoverage', 'embeddingCoverage'])('rejects incomplete %s', field => {
  expect(knowledgeIngestionVerified({ ...verified, coverage: { ...verified.coverage, [field]: 0.5 } })).toBe(false);
});
it('requires current source, empty blockers and coverage confirmation, supports metadata projection', () => {
  expect(knowledgeIngestionVerified(verified)).toBe(true);
  expect(knowledgeIngestionVerified({ ...verified, coverage: undefined, ingestionCoverage: verified.coverage })).toBe(true);
  expect(knowledgeIngestionVerified({ ...verified, coverage: undefined })).toBe(false);
  expect(knowledgeIngestionVerified({ ...verified, coverage: { ...verified.coverage, sourceRevisionCurrent: false } })).toBe(false);
  expect(knowledgeIngestionVerified({ ...verified, coverage: { ...verified.coverage, blockers: ['missing citation'] } })).toBe(false);
});
it('bounds non-cooperative requests, cancels on owner change and clears its timer', async () => {
  vi.useFakeTimers(); let signal!: AbortSignal;
  const hung = withRequestDeadline(s => { signal = s; return new Promise(() => {}); });
  const check = expect(hung).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(10_001); await check; expect(signal.aborted).toBe(true);
  const owner = new AbortController(); const cancelled = withRequestDeadline(() => new Promise(() => {}), owner.signal);
  const cancelCheck = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' }); owner.abort(); await cancelCheck;
  expect(vi.getTimerCount()).toBe(0);
});
