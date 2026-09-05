import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: { settings: [] as any[] } }));
vi.mock('../db_layer', () => ({ readDB: () => state.db, writeDB: () => {} }));
vi.mock('../server/cloud/circuit_breaker', () => ({ resetCircuit: () => {} }));
import { ensureLocalModelReady, getLocalModelConfig, runLocalModelInference, saveLocalModelConfig } from '../server/llm/local_models';

const baseUrl = 'http://127.0.0.1:59999';
const catalog = () => new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), { status: 200 });
const healthy = () => new Response(JSON.stringify({ choices: [{ message: { content: 'SYNTHETIC_OK' } }] }), { status: 200 });
beforeEach(() => {
  state.db = { settings: [] };
  saveLocalModelConfig('lmstudio', { baseUrl, detected: false, models: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('per-model local readiness', () => {
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
