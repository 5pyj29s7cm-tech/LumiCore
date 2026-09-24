import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeLLMCall, makeLLMCallStreaming } from '../server/llm/providers';
import { createModelTurnState } from '../server/llm/model_turn_state';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import '../server/llm/dispatch';

afterEach(() => { resetCircuit(); vi.useRealTimers(); });

describe('shared interactive provider deadlines', () => {
  it.each([false, true])('times out a silent relay once and skips it during recovery (streaming=%s)', async streaming => {
    vi.useFakeTimers();
    let primarySignal: AbortSignal | undefined;
    let finishLate: (value: unknown) => void = () => {};
    const create = vi.fn((params, options) => {
      if (params.model === 'primary') {
        primarySignal = options.signal;
        return new Promise(resolve => { finishLate = resolve; });
      }
      return Promise.resolve({ choices: [{ message: { content: 'backup result' }, finish_reason: 'stop' }] });
    });
    const none = () => null;
    const client = () => ({ chat: { completions: { create } } });
    const config = { provider: 'relay', model: 'primary', selectionMode: 'ordered_fallback' as const,
      fallbackCandidates: [{ provider: 'relay' as const, model: 'backup' }], modelTurnState: createModelTurnState(),
      attemptTimeouts: { semanticContentMs: 25, absoluteMs: 200 } };
    const chunks: string[] = [];
    const call = () => streaming
      ? makeLLMCallStreaming([{ role: 'user', content: 'Synthetic task' }], [], config, chunk => chunks.push(chunk),
        none, none, none, none, none, none, none, none, none, none, none, client)
      : makeLLMCall([{ role: 'user', content: 'Synthetic task' }], [], config,
        none, none, none, none, none, none, none, none, none, none, none, client);
    const first = call();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(26);
    expect((await first).text).toBe('backup result');
    expect(primarySignal?.aborted).toBe(true);
    expect(create.mock.calls.map(args => args[0].model)).toEqual(['primary', 'backup']);
    const recovery = await call();
    expect(recovery.routing?.attempts[0]).toMatchObject({ model: 'primary', status: 'skipped', reason: 'failed_earlier_this_turn' });
    expect(create.mock.calls.map(args => args[0].model)).toEqual(['primary', 'backup', 'backup']);
    finishLate({ choices: [{ message: { content: 'stale primary result' } }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(chunks).not.toContain('stale primary result');
    config.modelTurnState = createModelTurnState();
    const nextUserTurn = call();
    await vi.advanceTimersByTimeAsync(26);
    await nextUserTurn;
    expect(create.mock.calls.filter(args => args[0].model === 'primary')).toHaveLength(2);
  });
});
