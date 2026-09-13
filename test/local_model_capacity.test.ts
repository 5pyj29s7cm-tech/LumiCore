import { afterEach, expect, it, vi } from 'vitest';
import { loadedLocalContextTokens } from '../server/llm/local_model_capacity';
import { modelRoutingErrorReason } from '../server/llm/model_routing_receipts';
import { LocalModelContextBudgetError } from '../server/llm/local_context_budget';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const client = { baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-only' };
const payload = (entry: object) => ({ ok: true, json: async () => ({ data: [entry] }) });

it('uses the exact loaded model capacity and preserves an explicitly smaller limit', async () => {
  const request = vi.fn().mockResolvedValue(payload({ id: 'model', state: 'loaded', loaded_context_length: 8192, max_context_length: 32768 }));
  vi.stubGlobal('fetch', request); vi.stubEnv('LUMI_LOCAL_MODEL_CONTEXT_TOKENS', '');
  expect(await loadedLocalContextTokens('lmstudio', client, 'model')).toBe(8192);
  expect(String(request.mock.calls[0][0])).toBe('http://127.0.0.1:1234/api/v0/models');
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  vi.stubEnv('LUMI_LOCAL_MODEL_CONTEXT_TOKENS', '4096');
  expect(await loadedLocalContextTokens('lmstudio', client, 'model')).toBe(4096);
});
it.each([
  { id: 'other', state: 'loaded', loaded_context_length: 8192 },
  { id: 'model', state: 'not-loaded', loaded_context_length: 8192 },
  { id: 'model', state: 'loaded', max_context_length: 32768 },
  { id: 'model', state: 'loaded', loaded_context_length: '8192' },
  { id: 'model', state: 'loaded', loaded_context_length: 999999 },
])('does not infer loaded capacity from an unrelated or invalid entry %j', async entry => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(payload(entry)));
  expect(await loadedLocalContextTokens('lmstudio', client, 'model')).toBeUndefined();
});
it('retains the conservative fallback when metadata is unavailable; never probes cloud providers', async () => {
  const request = vi.fn().mockRejectedValue(new Error('metadata unavailable'));
  vi.stubGlobal('fetch', request);
  expect(await loadedLocalContextTokens('lmstudio', client, 'model')).toBeUndefined();
  expect(await loadedLocalContextTokens('relay', client, 'model')).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(modelRoutingErrorReason(new LocalModelContextBudgetError('bounded', 4096, 2000))).toBe('local_context_budget_exceeded');
});
