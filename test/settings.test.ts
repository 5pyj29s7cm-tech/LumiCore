import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { mountSystemRoutes } from '../server/routes/system_routes';
import jwt from 'jsonwebtoken';

let url: string;
let cleanup: () => void;
const adminToken = jwt.sign({ uid: 'settings-admin', username: 'admin', role: 'admin' }, JWT_SECRET);
const userToken = jwt.sign({ uid: 'settings-user', username: 'user', role: 'user' }, JWT_SECRET);
const otherUserToken = jwt.sign({ uid: 'settings-other-user', username: 'other', role: 'user' }, JWT_SECRET);
const adminHeaders = (json = false) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  Authorization: `Bearer ${adminToken}`,
});
const userHeaders = (json = false) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  Authorization: `Bearer ${userToken}`,
});

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
      headers: adminHeaders(),
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
      headers: adminHeaders(true),
      body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-test' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toContain('DEEPSEEK_API_KEY');

    // Read back
    const read = await fetch(`${url}/api/settings/keys`, {
      headers: adminHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    const readBody = await read.json();
    expect(readBody.DEEPSEEK_API_KEY).toBe(true);
  });

  it('POST /settings/keys rejects empty payload', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('POST /settings/keys rejects legacy Doubao credentials', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ keys: { DOUBAO_SPEECH_KEY: '12345:legacy-token' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('new-console API Key value'),
    });
  });

  it('requires a local authenticated administrator for key status and writes', async () => {
    const anonymous = await fetch(`${url}/api/settings/keys`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(anonymous.status).toBe(401);

    const nonAdmin = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'must-not-save' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(nonAdmin.status).toBe(403);
  });

  it('keeps public health minimal and gates detailed host diagnostics to the local administrator', async () => {
    const publicHealth = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(publicHealth.status).toBe(200);
    const publicBody = await publicHealth.json();
    expect(publicBody).toMatchObject({
      status: expect.stringMatching(/^(?:ok|degraded)$/),
      runtime: { version: expect.any(String), buildId: expect.any(String) },
      database: { dirty: expect.any(Boolean) },
    });
    expect(publicBody.process).toBeUndefined();
    expect(publicBody.functionalProbes).toBeUndefined();
    expect(publicBody.supervisedRuntimes).toBeUndefined();

    const anonymousDetail = await fetch(`${url}/api/health?details=1`);
    expect(anonymousDetail.status).toBe(401);
    const userDetail = await fetch(`${url}/api/health?details=1`, {
      headers: userHeaders(),
    });
    expect(userDetail.status).toBe(403);
    const adminDetail = await fetch(`${url}/api/health?details=1`, {
      headers: adminHeaders(),
    });
    expect(adminDetail.status).toBe(200);
    expect(await adminDetail.json()).toHaveProperty('functionalProbes');
  });

  it('requires authentication for model, preference, and host telemetry surfaces', async () => {
    for (const endpoint of [
      '/api/llm/providers',
      '/api/preferences/llm',
      '/api/system/stats',
      '/api/monitor/latency',
      '/api/tools',
    ]) {
      const response = await fetch(`${url}${endpoint}`, { signal: AbortSignal.timeout(5000) });
      expect(response.status, endpoint).toBe(401);
    }
    for (const endpoint of [
      '/api/runtime/logs',
      '/api/ecosystem/stats',
      '/api/ollama/config',
      '/api/lmstudio/config',
      '/api/scheduler/tasks',
    ]) {
      const response = await fetch(`${url}${endpoint}`, {
        headers: userHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status, endpoint).toBe(403);
    }
  });

  it('exposes only allowlisted user-scoped settings and isolates them by owner', async () => {
    const save = await fetch(`${url}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        key: 'tool_overrides',
        value: { safe_tool: { enabled: true, securityLevel: 'safe' } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(save.status).toBe(200);

    const own = await fetch(`${url}/api/settings/tool_overrides`, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(await own.json()).toEqual({ safe_tool: { enabled: true, securityLevel: 'safe' } });

    const other = await fetch(`${url}/api/settings/tool_overrides`, {
      headers: { Authorization: `Bearer ${otherUserToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(await other.json()).toBeNull();

    const privateRead = await fetch(`${url}/api/settings/biometric_settings-user`, {
      headers: { Authorization: `Bearer ${otherUserToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(privateRead.status).toBe(404);

    const privateWrite = await fetch(`${url}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherUserToken}`,
      },
      body: JSON.stringify({ key: 'self_improvement_program_v1', value: { enabled: true } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(privateWrite.status).toBe(400);
  });

  it('rejects insecure remote Base URLs while preserving loopback development endpoints', async () => {
    const insecure = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ keys: { RELAY_BASE_URL: 'http://relay.example/v1' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(insecure.status).toBe(400);
    expect(await insecure.json()).toMatchObject({
      error: expect.stringContaining('must use HTTPS'),
    });

    const loopback = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ keys: { RELAY_BASE_URL: 'http://127.0.0.1:8000/v1' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(loopback.status).toBe(200);
  });

  it('does not report a merely configured LLM provider as available', async () => {
    const { saveKeys } = await import('../server/config/keys');
    saveKeys({ DEEPSEEK_API_KEY: 'sk-health-status-test' });
    const response = await fetch(`${url}/api/llm/providers`, {
      headers: userHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers.deepseek).toMatchObject({
      configured: true,
      available: false,
      candidateEligible: true,
      readiness: 'unknown',
      reason: 'health_not_yet_verified',
      circuitState: 'closed',
    });

    const { saveProviderProbe } = await import('../server/llm/provider_health');
    saveProviderProbe({
      provider: 'deepseek',
      model: body.providers.deepseek.model,
      ok: true,
      testedAt: new Date().toISOString(),
      latencyMs: 12,
    });
    const verifiedResponse = await fetch(`${url}/api/llm/providers`, {
      headers: userHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    const verified = await verifiedResponse.json();
    expect(verified.providers.deepseek).toMatchObject({
      configured: true,
      available: true,
      candidateEligible: true,
      readiness: 'healthy',
      reason: 'probe_succeeded',
    });

    const circuits = await import('../server/cloud/circuit_breaker');
    circuits.recordFailure(
      'deepseek',
      body.providers.deepseek.model,
      new Error('known provider outage'),
      { openImmediately: true },
    );
    const unhealthyResponse = await fetch(`${url}/api/llm/providers`, {
      headers: userHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    const unhealthy = await unhealthyResponse.json();
    expect(unhealthy.providers.deepseek).toMatchObject({
      configured: true,
      available: false,
      candidateEligible: false,
      readiness: 'unhealthy',
      reason: 'circuit_open',
      circuitState: 'open',
    });
    circuits.resetCircuit('deepseek', body.providers.deepseek.model);
  });

  it('stores reasoning routing policy and exposes sanitized routing receipts', async () => {
    const update = await fetch(`${url}/api/preferences/llm`, {
      method: 'PUT',
      headers: userHeaders(true),
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
      userId: 'settings-user',
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
      headers: userHeaders(),
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
      headers: userHeaders(true),
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
      headers: userHeaders(),
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
      headers: userHeaders(true),
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
      headers: userHeaders(true),
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
      headers: userHeaders(true),
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
      headers: userHeaders(true),
      body: JSON.stringify({ provider: 'unsupported', model: 'anything' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('stores the knowledge retrieval model independently', async () => {
    const update = await fetch(`${url}/api/preferences/retrieval-model`, {
      method: 'PUT',
      headers: userHeaders(true),
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
      headers: userHeaders(),
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
