import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { makeApp } from './helpers';

let cleanup = () => {};
let localServer: http.Server;
let port = 0;
let LocalModels: typeof import('../server/llm/local_models');

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  LocalModels = await import('../server/llm/local_models');
  localServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'qwen-local:7b' }, { name: 'nomic-embed-text' }] }));
      return;
    }
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'local-chat-model' }, { id: 'text-embedding-model' }] }));
      return;
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'OK' }, done: true }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    localServer.listen(0, '127.0.0.1', () => {
      port = (localServer.address() as any).port;
      resolve();
    });
    localServer.on('error', reject);
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => localServer.close(() => resolve()));
  cleanup();
});

describe('local model runtime configuration', () => {
  it('normalizes OpenAI-compatible /v1 URLs without duplicating the path', () => {
    expect(LocalModels.normalizeLocalModelBaseUrl('lmstudio', `http://127.0.0.1:${port}/v1`))
      .toBe(`http://127.0.0.1:${port}`);
  });

  it('detects Ollama and ignores embedding-only models for chat availability', async () => {
    const result = await LocalModels.probeLocalModel('ollama', `http://localhost:${port}`);
    expect(result.detected).toBe(true);
    expect(result.inferenceHealthy).toBe(true);
    expect(result.healthStatus).toBe('healthy');
    expect(result.models).toEqual(['qwen-local:7b', 'nomic-embed-text']);
    expect(LocalModels.isTextGenerationModel('nomic-embed-text')).toBe(false);
  });

  it('persists a reachable LM Studio endpoint and exposes its chat models', async () => {
    const result = await LocalModels.refreshLocalModelConfig('lmstudio', `http://localhost:${port}`);
    const saved = LocalModels.getLocalModelConfig('lmstudio');
    expect(result.detected).toBe(true);
    expect(saved.detected).toBe(true);
    expect(saved.models).toContain('local-chat-model');
    expect(saved.lastInferenceAt).toBeTruthy();
  });

  it('clears stale availability when the service is no longer reachable', async () => {
    const result = await LocalModels.refreshLocalModelConfig('ollama', 'http://127.0.0.1:9', { timeoutMs: 500 });
    expect(result.detected).toBe(false);
    expect(LocalModels.getLocalModelConfig('ollama').detected).toBe(false);
  });

  it('persists the IPv4 fallback after a localhost probe fails', async () => {
    const result = await LocalModels.probeLocalModel('ollama', 'http://localhost:9', { timeoutMs: 500 });
    expect(result.detected).toBe(false);
    expect(result.baseUrl).toBe('http://127.0.0.1:9');
  });

  it('does not report catalog-only reachability as inference health', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const target = String(input);
      if (target.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'listed-but-broken' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'engine unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await LocalModels.probeLocalModel('lmstudio', 'http://127.0.0.1:17777', {
      fetchImpl,
      timeoutMs: 500,
      inferenceTimeoutMs: 500,
    });
    expect(result).toMatchObject({
      serviceReachable: true,
      inferenceHealthy: false,
      detected: false,
      healthStatus: 'catalog_only',
      models: ['listed-but-broken'],
    });
    expect(result.lastError).toContain('Inference probe failed');
  });

  it('bounds local inference concurrency and exposes queue pressure', async () => {
    const before = LocalModels.getLocalModelQueueSnapshot('ollama');
    let active = 0;
    let maxActive = 0;
    const jobs = Array.from({ length: before.concurrency + 3 }, (_, index) => (
      LocalModels.runLocalModelInference('ollama', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 15 + index));
        active -= 1;
        return index;
      })
    ));
    await expect(Promise.all(jobs)).resolves.toHaveLength(before.concurrency + 3);
    const after = LocalModels.getLocalModelQueueSnapshot('ollama');
    expect(maxActive).toBeLessThanOrEqual(before.concurrency);
    expect(after.active).toBe(0);
    expect(after.queued).toBe(0);
    expect(after.completed - before.completed).toBe(before.concurrency + 3);
    expect(after.maxObservedQueue).toBeGreaterThan(0);
  });

  it('removes a cancelled request from the local inference queue', async () => {
    const snapshot = LocalModels.getLocalModelQueueSnapshot('ollama');
    let releaseBlockers = () => {};
    const blocker = new Promise<void>(resolve => { releaseBlockers = resolve; });
    const activeJobs = Array.from({ length: snapshot.concurrency }, () => (
      LocalModels.runLocalModelInference('ollama', async () => {
        await blocker;
        return 'done';
      })
    ));
    await new Promise(resolve => setTimeout(resolve, 5));
    const controller = new AbortController();
    const queued = LocalModels.runLocalModelInference(
      'ollama',
      async () => 'must-not-run',
      { signal: controller.signal },
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(LocalModels.getLocalModelQueueSnapshot('ollama').queued).toBeGreaterThan(0);
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(LocalModels.getLocalModelQueueSnapshot('ollama').queued).toBe(0);
    releaseBlockers();
    await Promise.all(activeJobs);
  });

  it('suppresses reconnect storms during backoff and permits an explicit recovery probe', async () => {
    LocalModels.saveLocalModelConfig('lmstudio', {
      baseUrl: `http://127.0.0.1:${port}`,
      detected: false,
      serviceReachable: false,
      inferenceHealthy: false,
      healthStatus: 'backoff',
      models: ['local-chat-model'],
      consecutiveFailures: 3,
      nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
      lastError: 'temporary disconnect',
    });
    const blockedFetch = vi.fn(fetch) as typeof fetch;
    await expect(LocalModels.ensureLocalModelReady('lmstudio', 'local-chat-model', {
      fetchImpl: blockedFetch,
    })).rejects.toThrow(/backing off/);
    expect(blockedFetch).not.toHaveBeenCalled();

    const recovered = await LocalModels.ensureLocalModelReady('lmstudio', 'local-chat-model', {
      force: true,
      timeoutMs: 1_000,
      inferenceTimeoutMs: 1_000,
    });
    expect(recovered.model).toBe('local-chat-model');
    expect(LocalModels.getLocalModelConfig('lmstudio')).toMatchObject({
      detected: true,
      inferenceHealthy: true,
      healthStatus: 'healthy',
      consecutiveFailures: 0,
    });
  });
});

describe('LLM client hot reconfiguration', () => {
  it('rebuilds cloud clients after a key changes and disables them after removal', async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key-one';
    vi.resetModules();
    const { createLLMRuntime } = await import('../server/runtime/llm');
    const runtime = createLLMRuntime();
    const first = runtime.getOpenAI();
    process.env.OPENAI_API_KEY = 'test-openai-key-two';
    const second = runtime.getOpenAI();
    delete process.env.OPENAI_API_KEY;
    const removed = runtime.getOpenAI();

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(removed).toBeNull();

    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  it('rebuilds relay clients when the base URL changes', async () => {
    const originalKey = process.env.RELAY_API_KEY;
    const originalUrl = process.env.RELAY_BASE_URL;
    process.env.RELAY_API_KEY = 'relay-test-key';
    process.env.RELAY_BASE_URL = 'http://127.0.0.1:18001/v1';
    vi.resetModules();
    const { createLLMRuntime } = await import('../server/runtime/llm');
    const runtime = createLLMRuntime();
    const first = runtime.getRelay();
    process.env.RELAY_BASE_URL = 'http://127.0.0.1:18002/v1';
    const second = runtime.getRelay();

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    if (originalKey === undefined) delete process.env.RELAY_API_KEY;
    else process.env.RELAY_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.RELAY_BASE_URL;
    else process.env.RELAY_BASE_URL = originalUrl;
  });
});
