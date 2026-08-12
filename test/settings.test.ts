import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { mountSystemRoutes } from '../server/routes/system_routes';

let url: string;
let cleanup: () => void;

describe('Settings & Keys API', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
  });

  afterAll(() => cleanup?.());

  it('GET /settings/keys returns masked key status', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
    expect(body).toHaveProperty('DASHSCOPE_API_KEY');
    expect(body).toHaveProperty('DEEPSEEK_API_KEY');
  });

  it('POST /settings/keys saves and reports saved', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-test' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toContain('DEEPSEEK_API_KEY');

    // Read back
    const read = await fetch(`${url}/api/settings/keys`, {
      signal: AbortSignal.timeout(5000),
    });
    const readBody = await read.json();
    expect(readBody.DEEPSEEK_API_KEY).toBe(true);
  });

  it('POST /settings/keys rejects empty payload', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('POST /settings/keys rejects legacy Doubao credentials', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { DOUBAO_SPEECH_KEY: '12345:legacy-token' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('new-console API Key value'),
    });
  });

  it('stores reasoning routing policy and exposes sanitized routing receipts', async () => {
    const update = await fetch(`${url}/api/preferences/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'lmstudio',
        model: 'exact-local-model',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [
          { provider: 'ollama', model: 'exact-ollama-model' },
          { provider: 'openai', model: 'exact-cloud-model' },
        ],
        allowCloudFallback: false,
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      schemaVersion: 2,
      provider: 'lmstudio',
      model: 'exact-local-model',
      selectionMode: 'ordered_fallback',
      allowCloudFallback: false,
      fallbackCandidates: [
        { provider: 'ollama', model: 'exact-ollama-model' },
        { provider: 'openai', model: 'exact-cloud-model' },
      ],
    });

    const { persistModelRoutingReceipt } = await import('../server/llm/model_routing_receipts');
    persistModelRoutingReceipt({
      userId: 'anonymous',
      domain: 'personal',
      orgId: '',
      conversationId: 'settings-route-conversation',
      requestId: 'settings-route-request',
      interactionId: 'settings-route-interaction',
      source: 'settings_test',
      status: 'failed',
      requestedProvider: 'lmstudio',
      requestedModel: 'exact-local-model',
      selectionMode: 'ordered_fallback',
      selectedProvider: '',
      selectedModel: '',
      fallbackReason: 'provider_unreachable',
      attempts: [{
        provider: 'lmstudio',
        model: 'exact-local-model',
        status: 'failed',
        reason: 'provider_unreachable',
        errorDigest: 'only-a-digest-is-exposed',
      }],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 12,
    });

    const response = await fetch(`${url}/api/preferences/llm/routing-receipts?limit=1&requestId=settings-route-request`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      requestedProvider: 'lmstudio',
      requestedModel: 'exact-local-model',
      fallbackReason: 'provider_unreachable',
      conversationId: 'settings-route-conversation',
      requestId: 'settings-route-request',
      interactionId: 'settings-route-interaction',
      source: 'settings_test',
      attempts: [{ errorDigest: 'only-a-digest-is-exposed' }],
    });
    expect(JSON.stringify(body)).not.toContain('API key');
  });

  it('stores image and video generation roles independently', async () => {
    const update = await fetch(`${url}/api/preferences/generation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: {
          provider: 'qwen',
          model: 'wan-image-direct',
          models: {
            openai: 'gpt-image-custom',
            qwen: 'wan-image-custom',
          },
        },
        video: {
          provider: 'minimax',
          model: 'wan-video-direct',
          models: {
            qwen: 'wan-video-custom',
            minimax: 'MiniMax-Hailuo-02',
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(update.status).toBe(200);
    const updateBody = await update.json();
    expect(updateBody.image).toMatchObject({
      provider: 'qwen',
      model: 'wan-image-custom',
      models: {
        openai: 'gpt-image-custom',
        qwen: 'wan-image-custom',
      },
    });
    expect(updateBody.video).toMatchObject({
      provider: 'minimax',
      model: 'MiniMax-Hailuo-02',
      models: {
        qwen: 'wan-video-custom',
        minimax: 'MiniMax-Hailuo-02',
      },
    });

    const read = await fetch(`${url}/api/preferences/generation`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.image.model).toBe('wan-image-custom');
    expect(readBody.video.model).toBe('MiniMax-Hailuo-02');
  });

  it('rejects unsupported generation model providers', async () => {
    const res = await fetch(`${url}/api/preferences/generation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: { provider: 'unsupported' },
        video: { provider: 'qwen' },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('stores an independent World Model and can return to Vision inheritance', async () => {
    const independent = await fetch(`${url}/api/preferences/world`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'qwen',
        model: 'qwen-vl-direct',
        models: { qwen: 'qwen-vl-world-custom' },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(independent.status).toBe(200);
    const independentBody = await independent.json();
    expect(independentBody).toMatchObject({
      provider: 'qwen',
      model: 'qwen-vl-world-custom',
      resolved: {
        provider: 'qwen',
        model: 'qwen-vl-world-custom',
        inheritedFromVision: false,
      },
    });

    const inherited = await fetch(`${url}/api/preferences/world`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'inherit_vision',
        model: '',
        models: independentBody.models,
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(inherited.status).toBe(200);
    const inheritedBody = await inherited.json();
    expect(inheritedBody.provider).toBe('inherit_vision');
    expect(inheritedBody.resolved.inheritedFromVision).toBe(true);
    expect(typeof inheritedBody.resolved.provider).toBe('string');
    expect(typeof inheritedBody.resolved.model).toBe('string');
  });

  it('rejects unsupported World Model providers', async () => {
    const res = await fetch(`${url}/api/preferences/world`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'unsupported', model: 'anything' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('stores the knowledge retrieval model independently', async () => {
    const update = await fetch(`${url}/api/preferences/retrieval-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embedding: {
          provider: 'qwen',
          model: 'text-embedding-v4',
          fallbackProvider: 'ollama',
          fallbackModel: 'nomic-embed-text',
        },
        rerank: {
          enabled: true,
          provider: 'siliconflow',
          model: 'Qwen/Qwen3-Reranker-4B',
          topN: 8,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(update.status).toBe(200);
    const updateBody = await update.json();
    expect(updateBody).toMatchObject({
      embedding: { provider: 'qwen', model: 'text-embedding-v4' },
      rerank: { enabled: true, provider: 'siliconflow', model: 'Qwen/Qwen3-Reranker-4B', topN: 8 },
    });

    const read = await fetch(`${url}/api/preferences/retrieval-model`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody).toMatchObject({
      embedding: {
        provider: 'qwen',
        model: 'text-embedding-v4',
        fallbackProvider: 'ollama',
        fallbackModel: 'nomic-embed-text',
      },
      rerank: {
        enabled: true,
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Reranker-4B',
        topN: 8,
      },
    });
  });
});
