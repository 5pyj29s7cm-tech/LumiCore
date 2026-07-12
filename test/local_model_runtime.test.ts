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
    expect(result.models).toEqual(['qwen-local:7b', 'nomic-embed-text']);
    expect(LocalModels.isTextGenerationModel('nomic-embed-text')).toBe(false);
  });

  it('persists a reachable LM Studio endpoint and exposes its chat models', async () => {
    const result = await LocalModels.refreshLocalModelConfig('lmstudio', `http://localhost:${port}`);
    const saved = LocalModels.getLocalModelConfig('lmstudio');
    expect(result.detected).toBe(true);
    expect(saved.detected).toBe(true);
    expect(saved.models).toContain('local-chat-model');
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
