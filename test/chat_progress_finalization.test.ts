import { describe, expect, it } from 'vitest';
import { describeTurnCompletionProgress } from '../src/lib/chatProgress';

describe('chat progress finalization semantics', () => {
  it('does not treat the mere presence of a tool event as task completion', () => {
    const withTool = describeTurnCompletionProgress(false, true, true);
    const withoutTool = describeTurnCompletionProgress(false, false, true);

    expect(withTool).toEqual(withoutTool);
    expect(withTool.tone).toBe('error');
  });

  it('shows a finalized response as delivered without inventing completion', () => {
    const result = describeTurnCompletionProgress(false, true, true, {
      finalized: true,
      blocked: false,
    });
    const ordinaryReply = describeTurnCompletionProgress(false, false, false, {
      finalized: true,
      blocked: false,
    });

    expect(result).toEqual(ordinaryReply);
    expect(result.tone).toBe('done');
  });

  it('keeps a finalizer-blocked response in the error state even after tools ran', () => {
    const result = describeTurnCompletionProgress(false, true, true, {
      finalized: true,
      blocked: true,
      reason: 'missing verified evidence',
    });

    expect(result.tone).toBe('error');
  });
});
