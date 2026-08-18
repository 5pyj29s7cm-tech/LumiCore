import { describe, expect, it } from 'vitest';
import { nextStreamItemWithIdleTimeout } from '../server/llm/providers';

describe('LLM stream idle timeout', () => {
  it('returns a timeout when the provider never delivers the next frame', async () => {
    const iterator: AsyncIterator<string> = {
      next: () => new Promise(() => {}),
    };
    await expect(nextStreamItemWithIdleTimeout(iterator, 10)).resolves.toEqual({ timedOut: true });
  });

  it('returns the next frame before the deadline', async () => {
    const iterator: AsyncIterator<string> = {
      next: async () => ({ done: false, value: 'ok' }),
    };
    await expect(nextStreamItemWithIdleTimeout(iterator, 100)).resolves.toEqual({
      timedOut: false,
      item: { done: false, value: 'ok' },
    });
  });
});
