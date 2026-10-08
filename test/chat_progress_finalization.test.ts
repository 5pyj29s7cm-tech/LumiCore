import { describe, expect, it } from 'vitest';
import { describeTurnCompletionProgress } from '../src/lib/chatProgress';

describe('chat progress finalization semantics', () => {
  it('keeps a delivered reply unverified until the server finalizes it', () => {
    const result = describeTurnCompletionProgress(false);
    expect(result.tone).toBe('tool');
    expect(result.text).toContain('has not been verified');
  });

  it('shows a finalized response as delivered without inventing completion', () => {
    const result = describeTurnCompletionProgress(false, {
      finalized: true,
      blocked: false,
    });
    expect(result.tone).toBe('done');
  });

  it.each([{ reason: 'waiting_confirmation', blocked: false }, { status: 'waiting_for_confirmation', blocked: false }, { reason: 'waiting_confirmation', blocked: true }, { status: 'waiting_for_confirmation', blocked: true }])('keeps confirmation visible independently of the blocked flag: %j', boundary => {
    expect(describeTurnCompletionProgress(false, { ...boundary, finalized: true }).tone).toBe('confirmation');
  });

  it('keeps a finalizer-blocked response in the error state even after tools ran', () => {
    const result = describeTurnCompletionProgress(false, {
      finalized: true,
      blocked: true,
      reason: 'missing verified evidence',
    });

    expect(result.tone).toBe('error');
  });
});
