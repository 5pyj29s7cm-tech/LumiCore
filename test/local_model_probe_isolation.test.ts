import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: { settings: [] as any[] } }));
vi.mock('../db_layer', () => ({ readDB: () => state.db, writeDB: (db: typeof state.db) => { state.db = db; } }));
vi.mock('../server/cloud/circuit_breaker', () => ({ resetCircuit: () => {} }));
import { ensureLocalModelReady, getLocalModelConfig, refreshLocalModelConfig, runLocalModelInference, saveLocalModelConfig } from '../server/llm/local_models';

const baseUrl = 'http://127.0.0.1:59999';
const catalog = () => new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), { status: 200 });
const healthy = () => new Response(JSON.stringify({ choices: [{ message: { content: 'SYNTHETIC_OK' } }] }), { status: 200 });
beforeEach(() => {
  state.db = { settings: [] };
  saveLocalModelConfig('lmstudio', { baseUrl, detected: false, models: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('per-model local readiness', () => {
  it.each([false, true])('rejects obsolete probes after an endpoint switch (return to original=%s)', async returnToOriginal => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const oldTransport = vi.fn(async (url: unknown) => { await blocked; return String(url).endsWith('/models') ? catalog() : healthy(); });
    const old = ensureLocalModelReady('lmstudio', 'model-a', { fetchImpl: oldTransport as typeof fetch });
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const otherUrl = 'http://127.0.0.1:59998';
    const transport = vi.fn(async (url: unknown) => String(url).endsWith('/models') ? catalog() : healthy()) as typeof fetch;
    await refreshLocalModelConfig('lmstudio', otherUrl, { fetchImpl: transport });
    if (returnToOriginal) saveLocalModelConfig('lmstudio', { baseUrl, detected: false, models: [] });
    const latest = ensureLocalModelReady('lmstudio', 'model-a', { fetchImpl: transport });
    try { if (returnToOriginal) await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(4)); } finally { release(); }
    await rejected;
    await expect(latest).resolves.toMatchObject({ baseUrl: returnToOriginal ? baseUrl : otherUrl, model: 'model-a' });
    expect(getLocalModelConfig('lmstudio')).toMatchObject({ baseUrl: returnToOriginal ? baseUrl : otherUrl, detected: true, probedModel: 'model-a' });
  });

  it.each(['https://example.test', 'http://user:password@localhost:1234', 'file:///tmp/model'])('rejects forbidden addresses before changing durable configuration: %s', async url => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const original = getLocalModelConfig('lmstudio');
    await expect(refreshLocalModelConfig('lmstudio', url)).rejects.toThrow();
    expect(getLocalModelConfig('lmstudio')).toEqual(original); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not inherit a previous endpoint catalogue when the new endpoint is offline', async () => {
    saveLocalModelConfig('lmstudio', { baseUrl, detected: true, models: ['old-endpoint-model'] });
    await refreshLocalModelConfig('lmstudio', 'http://127.0.0.1:59998', { fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(getLocalModelConfig('lmstudio')).toMatchObject({ baseUrl: 'http://127.0.0.1:59998', detected: false, models: [] });
  });

  it('does not run queued calls or record late health after switching away and back', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), operation = vi.fn(async () => 'stale');
    const active = [runLocalModelInference('lmstudio', () => blocked), runLocalModelInference('lmstudio', () => blocked)];
    const queued = runLocalModelInference('lmstudio', operation), rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    saveLocalModelConfig('lmstudio', { baseUrl: 'http://127.0.0.1:59998', detected: false, models: [] });
    saveLocalModelConfig('lmstudio', { baseUrl, detected: false, models: [] });
    release(); await Promise.all(active); await rejected;
    expect(operation).not.toHaveBeenCalled(); expect(getLocalModelConfig('lmstudio')).toMatchObject({ baseUrl, detected: false, consecutiveFailures: 0 });
  });

  it('attributes late inference failure and success to the actual model instead of the last probe', async () => {
    saveLocalModelConfig('lmstudio', { baseUrl, detected: true, serviceReachable: true, models: ['model-a', 'model-b'], probedModel: 'model-a' });
    let failA!: (error: Error) => void;
    const first = runLocalModelInference('lmstudio', () => new Promise<void>((_resolve, reject) => { failA = reject; }), { model: 'model-a' });
    const rejected = expect(first).rejects.toThrow('model A failed');
    await vi.waitFor(() => expect(failA).toBeTypeOf('function'));
    await runLocalModelInference('lmstudio', async () => 'B succeeded', { model: 'model-b' });
    expect(getLocalModelConfig('lmstudio').probedModel).toBe('model-b');
    failA(new Error('model A failed'));
    await rejected;
    expect(getLocalModelConfig('lmstudio')).toMatchObject({ probedModel: 'model-a', detected: false });
    let finishB!: () => void;
    const last = runLocalModelInference('lmstudio', () => new Promise<void>(resolve => { finishB = resolve; }), { model: 'model-b' });
    await vi.waitFor(() => expect(finishB).toBeTypeOf('function'));
    saveLocalModelConfig('lmstudio', { baseUrl, detected: true, models: ['model-a', 'model-b'], probedModel: 'model-a' });
    finishB();
    await last;
    expect(getLocalModelConfig('lmstudio')).toMatchObject({ probedModel: 'model-b', detected: true });
  });

  it('does not overwrite a changed endpoint when an older inference finishes', async () => {
    let finish!: () => void;
    const pending = runLocalModelInference('lmstudio', () => new Promise<void>(resolve => { finish = resolve; }), { model: 'model-a' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    saveLocalModelConfig('lmstudio', { baseUrl: 'http://127.0.0.1:59998', detected: false, models: [] });
    finish();
    await pending;
    expect(getLocalModelConfig('lmstudio')).toMatchObject({ baseUrl: 'http://127.0.0.1:59998', detected: false });
  });

  it('does not share another model failure or apply its inference backoff', async () => {
    let releaseA!: () => void;
    const blockedA = new Promise<void>(resolve => { releaseA = resolve; });
    const posts: string[] = [];
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return catalog();
      const model = JSON.parse(String(init?.body)).model;
      posts.push(model);
      if (model === 'model-a') { await blockedA; return new Response('{}', { status: 400 }); }
      return healthy();
    }) as typeof fetch;
    const first = ensureLocalModelReady('lmstudio', 'model-a', { fetchImpl: transport });
    const failure = expect(first).rejects.toThrow(/inference HTTP 400/);
    try {
      await vi.waitFor(() => expect(posts).toEqual(['model-a']));
      const second = ensureLocalModelReady('lmstudio', 'model-b', { fetchImpl: transport });
      await expect(second).resolves.toMatchObject({ model: 'model-b' });
      expect(posts).toEqual(['model-a', 'model-b']);
    } finally { releaseA(); }
    await failure;
    expect(getLocalModelConfig('lmstudio').probedModel).toBe('model-a');
    await expect(ensureLocalModelReady('lmstudio', 'model-b', { fetchImpl: transport })).resolves.toMatchObject({ model: 'model-b' });
    expect(posts).toEqual(['model-a', 'model-b', 'model-b']);
  });

  it('coalesces matching model probes and keeps success scoped to that model', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const posts: string[] = [];
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return catalog();
      posts.push(JSON.parse(String(init?.body)).model);
      await blocked;
      return healthy();
    }) as typeof fetch;
    const first = ensureLocalModelReady('lmstudio', 'model-a', { fetchImpl: transport });
    const second = ensureLocalModelReady('lmstudio', 'model-a', { fetchImpl: transport });
    await vi.waitFor(() => expect(posts).toEqual(['model-a']));
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await ensureLocalModelReady('lmstudio', 'model-a', { fetchImpl: transport });
    expect(posts).toEqual(['model-a']);
    await ensureLocalModelReady('lmstudio', 'model-b', { fetchImpl: transport });
    expect(posts).toEqual(['model-a', 'model-b']);
  });
});
