import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock('../server/llm/adapter', () => ({ runWithTools: fixture.loop }));
import { runToolSession } from '../server/llm/tool_session';

describe('named tool session channel boundary', () => {
  it('preserves all 12 provider identities and separates streaming from execution context', async () => {
    const keys = ['getDeepSeek','getGemini','getOpenAI','getAnthropic','getQwen','getOllama','getLmStudio','getArk','getXiaomi','getKimi','getGlm','getRelay'] as const;
    const getters = Object.fromEntries(keys.map(key => [key, vi.fn(() => key)]));
    const messages: any[] = [{ role: 'user', content: 'Synthetic read' }];
    const registry = {} as any, config = { provider: 'relay', model: 'fixture', modelTurnState: {} as any };
    const context = { executionSignal: new AbortController().signal } as any;
    const onToolCall = vi.fn(), onStreamChunk = vi.fn(), receipt = { text: 'receipt' };
    fixture.loop.mockResolvedValueOnce(receipt);
    await expect(runToolSession({ messages, registry, config, getters, context, onToolCall, onStreamChunk, maxIterations: 7 })).resolves.toBe(receipt);
    const args = fixture.loop.mock.calls.at(-1)!;
    expect(args.slice(0, 5)).toEqual([messages, registry, config, onToolCall, 7]);
    expect(args[10]).toBe(onStreamChunk); expect(args[11]).toBe(context);
    [5,6,7,8,9,12,13,14,15,16,17,18].forEach((index, n) => expect(args[index]).toBe(getters[keys[n]]));
    Object.values(getters).forEach(getter => expect(getter).not.toHaveBeenCalled());
  });
  it('leaves missing clients and the iteration default to the shared adapter', () => {
    runToolSession({ messages: [], registry: {} as any, config: { provider: 'deepseek', model: 'fixture' } });
    expect(fixture.loop.mock.calls.at(-1)!.slice(3)).toEqual(Array(16).fill(undefined));
  });
  it('returns the same cancellation or persistence rejection without retrying', async () => {
    const error = Object.assign(new Error('synthetic revoked'), { name: 'AbortError' });
    fixture.loop.mockRejectedValueOnce(error); const before = fixture.loop.mock.calls.length;
    await expect(runToolSession({ messages: [], registry: {} as any, config: { provider: 'relay', model: 'fixture' } })).rejects.toBe(error);
    expect(fixture.loop.mock.calls.length).toBe(before + 1);
  });
});
