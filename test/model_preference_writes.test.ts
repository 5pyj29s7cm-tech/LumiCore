import { expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';
import { LUMI_OFFICIAL_DEFAULT_MODELS, normalizeLumiOfficialModel } from '../shared/model_provider_capabilities';
const contextFile = 'src/contexts/AppContext.tsx';
const reply = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data });
function deferred() { let resolve!: (data: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
function harness(role: 'llm' | 'vision') {
  const storage = new Map<string, string>(), config = { ready: true, loadError: '', provider: 'openai', model: 'original', models: {}, apiKey: '', selectionMode: 'pinned', fallbackCandidates: [], allowCloudFallback: true };
  const net = vi.fn(async (_url: string, init: any) => reply({ ...JSON.parse(init.body), success: true }));
  const deps: any = {
    AbortSignal, apiFetch: net, apiJson: extractSourceExpression('src/services/apiClient.ts', 'apiJson', { apiFetch: net }),
    localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
    aiConfigRef: { current: { ...config } }, visionConfigRef: { current: { ...config } }, authGenerationRef: { current: 0 },
    modelPreferenceRequestRef: { current: 0 }, visionPreferenceRequestRef: { current: 0 },
    modelAccountRef: { current: 'owner' }, user: { uid: 'owner' },
    modelWriteTailsRef: { current: { llm: Promise.resolve(), vision: Promise.resolve() } }, visionWriteTailRef: { current: Promise.resolve() },
    setAiConfig: vi.fn(), setVisionConfig: vi.fn(), saveServerKeys: vi.fn().mockResolvedValue(undefined), toast: { success: vi.fn(), error: vi.fn() },
    window: { dispatchEvent: vi.fn() }, CustomEvent: class { constructor(readonly type: string) {} }, LUMI_OFFICIAL_DEFAULT_MODELS, normalizeLumiOfficialModel,
  };
  for (const name of ['DEFAULT_AI_CONFIG', 'DEFAULT_VISION_CONFIG']) {
    try { deps[name] = extractSourceExpression(contextFile, name, deps); } catch { /* Baselines use browser initializers. */ }
  }
  try { deps.setModelState = extractSourceExpression(contextFile, 'setModelState', deps); deps.applyModelPreference = extractSourceExpression(contextFile, 'applyModelPreference', deps); deps.updateModelConfig = extractSourceExpression(contextFile, 'updateModelConfig', deps); } catch { /* Previous source has two separate writers. */ }
  return { ...deps, net, storage, current: () => (role === 'llm' ? deps.aiConfigRef : deps.visionConfigRef).current,
    update: extractSourceExpression(contextFile, role === 'llm' ? 'updateAIConfig' : 'updateVisionConfig', deps) };
}

it.each(['llm', 'vision'] as const)('%s orders saves, retains confirmed state after failure, and merges inactive choices', async role => {
  const h = harness(role), first = deferred(); h.net.mockReturnValueOnce(first.promise).mockResolvedValueOnce(reply({ error: 'denied' }, 403));
  const a = h.update({ model: 'first' }, { ollama: 'custom-local' }), b = h.update({ model: 'second' }, { lmstudio: 'other-local' });
  await vi.waitFor(() => expect(h.net).toHaveBeenCalledTimes(1)); expect(h.current().model).toBe('original');
  first.resolve(reply({ ...JSON.parse(h.net.mock.calls[0][1].body), success: true }));
  expect(await a).toBe(true); expect(await b).toBe(false); expect(h.current().model).toBe('first');
  expect(JSON.parse(h.net.mock.calls[1][1].body).models).toMatchObject({ ollama: 'custom-local', lmstudio: 'other-local', openai: 'second' });
  expect(await h.update({ model: 'recovered' })).toBe(true); expect(h.current().model).toBe('recovered');
});

it.each(['llm', 'vision'] as const)('%s waits for credentials, rejects failed credentials and never stores secrets', async role => {
  const h = harness(role), key = deferred(); h.saveServerKeys.mockReturnValueOnce(key.promise);
  const saving = h.update({ model: 'with-key', apiKey: 'synthetic-key' }); await vi.waitFor(() => expect(h.saveServerKeys).toHaveBeenCalledOnce());
  expect(h.net).not.toHaveBeenCalled(); expect(JSON.stringify([...h.storage])).not.toContain('synthetic-key'); expect(h.current().apiKey).toBe('');
  key.resolve(undefined); expect(await saving).toBe(true); expect(JSON.stringify(h.net.mock.calls)).not.toContain('synthetic-key');
  h.saveServerKeys.mockRejectedValueOnce(new Error('key denied')); expect(await h.update({ model: 'rejected', apiKey: 'next-synthetic-key' })).toBe(false);
  expect(h.net).toHaveBeenCalledOnce(); expect(h.current().model).toBe('with-key');
  h.saveServerKeys.mockImplementationOnce(async () => { h.authGenerationRef.current++; });
  expect(await h.update({ model: 'signed-out', apiKey: 'synthetic-key' })).toBe(false); expect(h.net).toHaveBeenCalledOnce();
});

it.each(['llm', 'vision'] as const)('%s drops queued writes and late confirmations after account invalidation', async role => {
  const h = harness(role), pending = deferred(); h.net.mockReturnValueOnce(pending.promise);
  const first = h.update({ model: 'old-account' }), queued = h.update({ model: 'queued' });
  await vi.waitFor(() => expect(h.net).toHaveBeenCalledTimes(1)); h.authGenerationRef.current++;
  pending.resolve(reply({ ...JSON.parse(h.net.mock.calls[0][1].body), success: true }));
  expect(await first).toBe(false); expect(await queued).toBe(false); expect(h.net).toHaveBeenCalledTimes(1);
  expect(h.current().model).toBe('original'); expect(h.toast.success).not.toHaveBeenCalled(); expect(h.window.dispatchEvent).not.toHaveBeenCalled();
});

it.each(['llm', 'vision'] as const)('%s requires a complete confirmation and permits retry', async role => {
  const h = harness(role); h.net.mockResolvedValueOnce(reply({})); expect(await h.update({ model: 'unconfirmed' })).toBe(false); expect(h.current().model).toBe('original');
  expect(await h.update({ model: 'confirmed' })).toBe(true); expect(h.current().model).toBe('confirmed'); expect(h.window.dispatchEvent).toHaveBeenCalledOnce();
});

it.each(['llm', 'vision'] as const)('%s delegates unknown model defaults to the saved backend configuration', async role => {
  const h = harness(role); h.net.mockResolvedValueOnce(reply({ provider: 'qwen', model: 'server-chosen', models: { qwen: 'server-chosen', openai: 'saved-server-choice' } }));
  expect(await h.update({ provider: 'qwen' })).toBe(true); expect(JSON.parse(h.net.mock.calls[0][1].body)).toMatchObject({ provider: 'qwen', model: '', models: {} });
  expect(h.current().model).toBe('server-chosen'); expect(h.current().models.openai).toBe('saved-server-choice');
});

it('keeps role queues independent and retains the reasoning route policy', async () => {
  const h = harness('llm'), pending = deferred(); h.net.mockReturnValueOnce(pending.promise);
  const first = h.update({ selectionMode: 'ordered_fallback', fallbackCandidates: [{ provider: 'ollama', model: 'fallback' }], allowCloudFallback: false });
  await vi.waitFor(() => expect(h.net).toHaveBeenCalledTimes(1));
  const vision = extractSourceExpression(contextFile, 'updateVisionConfig', h); expect(await vision({ model: 'vision-current' })).toBe(true);
  const request = JSON.parse(h.net.mock.calls[0][1].body); pending.resolve(reply(request)); expect(await first).toBe(true);
  expect(h.current()).toMatchObject({ selectionMode: 'ordered_fallback', fallbackCandidates: request.fallbackCandidates, allowCloudFallback: false });
  expect(h.visionConfigRef.current.model).toBe('vision-current');
});

it.each(['llm', 'vision'] as const)('%s releases a stalled save without retrying it', async role => {
  const h = harness(role), controller = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
  h.net.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
  try {
    const first = h.update({ model: 'stalled' }), next = h.update({ model: 'next' }); await vi.waitFor(() => expect(h.net).toHaveBeenCalledOnce());
    expect(timeout).toHaveBeenCalledWith(15_000); controller.abort(new Error('deadline exceeded'));
    expect(await first).toBe(false); expect(await next).toBe(true); expect(h.net).toHaveBeenCalledTimes(2); expect(h.current().model).toBe('next');
  } finally { timeout.mockRestore(); }
});

it('forwards the save deadline through credential persistence and read-back verification', async () => {
  const file = 'src/services/settingsKeys.ts', signal = new AbortController().signal;
  const net = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ success: true, saved: ['OPENAI_API_KEY'] }) }).mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ OPENAI_API_KEY: true }) });
  const deps: any = { apiFetch: net, readJsonSafely: extractSourceExpression(file, 'readJsonSafely', {}), window: undefined };
  deps.getSavedKeyStatus = extractSourceExpression(file, 'getSavedKeyStatus', deps);
  const result = await extractSourceExpression(file, 'saveServerKeys', deps)({ OPENAI_API_KEY: 'synthetic-key' }, signal);
  expect(result.status).toEqual({ OPENAI_API_KEY: true });
  expect(net.mock.calls).toHaveLength(2); expect(net.mock.calls.every(([, init]) => init.signal === signal)).toBe(true);
});
