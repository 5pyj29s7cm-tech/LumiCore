import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { makeApp } from './helpers';

let cleanup = () => {};
let server: http.Server;
let port = 0;
const requestedModels: string[] = [];
let servedModels = ['lm-alpha', 'lm-beta'];

function createServer(): http.Server {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: servedModels.map(id => ({ id })) }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        requestedModels.push(String(body.model || ''));
        res.end(JSON.stringify({
          id: 'local-completion',
          choices: [{ message: { role: 'assistant', content: `local:${body.model}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
}

async function listen(targetPort = 0): Promise<void> {
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(targetPort, '127.0.0.1', () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
}

async function closeServer(): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  await listen();
});

afterAll(async () => {
  await closeServer();
  cleanup();
});

describe('reasoning model switching stability', () => {
  it('enforces a task-scoped local-only boundary even when global strict privacy is off', async () => {
    const providers = await import('../server/llm/providers');
    const cloudCall = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'must not run' } }],
    }));

    await expect(providers.makeLLMCall(
      [{ role: 'user', content: 'private graph payload' }],
      [],
      {
        provider: 'deepseek',
        model: 'cloud-model',
        userId: 'local-only-graph-user',
        dataRoutingPolicy: 'local_only',
        noImplicitFailover: true,
      },
      () => ({ chat: { completions: { create: cloudCall } } }),
      () => null,
    )).rejects.toThrow('Local-only routing active');
    expect(cloudCall).not.toHaveBeenCalled();
  });

  it('migrates legacy aliases once while preserving literal schema-v2 model ids', async () => {
    const { readDB, writeDB } = await import('../db_layer');
    const prefs = await import('../server/llm/user_preferences');
    const legacyUser = 'legacy-model-route-user';
    const legacyKey = `llm_prefs_${legacyUser}`;
    const db = readDB();
    db.settings = (db.settings || []).filter((setting: any) => setting.key !== legacyKey);
    db.settings.push({
      key: legacyKey,
      value: JSON.stringify({
        provider: 'deepseek',
        models: { deepseek: 'deepseek-chat' },
        autoFallbackProvider: 'deepseek',
        autoFallbackModel: 'deepseek-chat',
      }),
    });
    writeDB(db);

    const migrated = prefs.getUserPreferredLLM(legacyUser);
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      selectionMode: 'pinned',
    });
    expect(migrated.legacyMigration?.entries).toContainEqual({
      provider: 'deepseek',
      from: 'deepseek-chat',
      to: 'deepseek-v4-flash',
    });
    const firstMigrationAt = migrated.legacyMigration?.migratedAt;
    const stored = JSON.parse((readDB().settings || []).find((setting: any) => setting.key === legacyKey).value);
    expect(stored.schemaVersion).toBe(2);
    expect(prefs.getUserPreferredLLM(legacyUser).legacyMigration?.migratedAt).toBe(firstMigrationAt);

    const literal = prefs.upsertUserPreferredLLM('literal-model-route-user', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      selectionMode: 'pinned',
    });
    expect(literal.model).toBe('deepseek-chat');
  });

  it('keeps a pinned primary as first choice and automatically fails over on billing failure', async () => {
    const providers = await import('../server/llm/providers');
    const receipts = await import('../server/llm/model_routing_receipts');
    const prefs = await import('../server/llm/user_preferences');
    const circuits = await import('../server/cloud/circuit_breaker');
    const userId = 'pinned-route-user';
    prefs.upsertUserPreferredLLM(userId, {
      provider: 'deepseek',
      model: 'pinned-billing-primary',
      selectionMode: 'pinned',
      fallbackCandidates: [],
      allowCloudFallback: true,
    });
    let fallbackCalls = 0;
    const deepSeekClient = {
      chat: { completions: { create: async () => {
        throw new Error('402 Payment Required: insufficient balance secret-account-detail');
      } } },
    };
    const qwenClient = {
      chat: { completions: { create: async () => {
        fallbackCalls += 1;
        return { choices: [{ message: { role: 'assistant', content: 'healthy configured fallback' } }] };
      } } },
    };

    const result = await providers.makeLLMCall(
      [{ role: 'user', content: 'recover from the pinned provider' }],
      [],
      {
        ...prefs.getUserPreferredLLMConfig(userId),
        conversationId: 'pinned-failover-conversation',
        requestId: 'pinned-failover-request',
        selectionMode: 'pinned',
      },
      () => deepSeekClient,
      () => null,
      () => null,
      () => null,
      () => qwenClient,
    );
    expect(result.text).toBe('healthy configured fallback');
    expect(fallbackCalls).toBe(1);
    expect(result.routing).toMatchObject({
      requestedProvider: 'deepseek',
      requestedModel: 'pinned-billing-primary',
      selectionMode: 'pinned',
      selectedProvider: 'qwen',
      selectedModel: 'qwen-plus',
    });
    expect(result.routing?.attempts.slice(0, 2).map(attempt => ({
      provider: attempt.provider,
      status: attempt.status,
      reason: attempt.reason,
      errorCategory: attempt.errorCategory,
    }))).toEqual([
      { provider: 'deepseek', status: 'failed', reason: 'quota_or_billing', errorCategory: 'quota' },
      { provider: 'qwen', status: 'succeeded', reason: undefined, errorCategory: undefined },
    ]);
    const receipt = receipts.listModelRoutingReceipts(userId, 1)[0];
    expect(receipt).toMatchObject({
      status: 'succeeded',
      selectedProvider: 'qwen',
      selectedModel: 'qwen-plus',
      conversationId: 'pinned-failover-conversation',
      requestId: 'pinned-failover-request',
    });
    expect(receipt.attempts[0]).toMatchObject({
      durationMs: expect.any(Number),
      errorCategory: 'quota',
      errorDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(receipt)).not.toContain('secret-account-detail');
    const { assessProviderAvailability } = await import('../server/llm/provider_health');
    expect(assessProviderAvailability({
      provider: 'qwen',
      model: 'qwen-plus',
      configured: true,
    })).toMatchObject({
      available: true,
      candidateEligible: true,
      readiness: 'healthy',
      reason: 'recent_model_success',
      lastObservation: { status: 'succeeded' },
    });
    circuits.resetCircuit('deepseek', 'pinned-billing-primary');
  });

  it('keeps an exact graph candidate inside its provider boundary even when it is the stored primary', async () => {
    const providers = await import('../server/llm/providers');
    const receipts = await import('../server/llm/model_routing_receipts');
    const prefs = await import('../server/llm/user_preferences');
    const circuits = await import('../server/cloud/circuit_breaker');
    const userId = 'exact-graph-provider-user';
    prefs.upsertUserPreferredLLM(userId, {
      provider: 'deepseek',
      model: 'exact-primary',
      selectionMode: 'pinned',
      fallbackCandidates: [{ provider: 'qwen', model: 'global-fallback-must-not-run' }],
      allowCloudFallback: true,
    });
    const deepSeekClient = {
      chat: { completions: { create: async () => {
        throw new Error('402 exact candidate unavailable');
      } } },
    };
    const qwenGetter = vi.fn(() => ({
      chat: { completions: { create: async () => ({
        choices: [{ message: { role: 'assistant', content: 'escaped graph boundary' } }],
      }) } },
    }));

    try {
      await expect(providers.makeLLMCall(
        [{ role: 'user', content: 'execute only the compiled graph candidate' }],
        [],
        {
          ...prefs.getUserPreferredLLMConfig(userId),
          conversationId: 'exact-graph-provider-conversation',
          requestId: 'exact-graph-provider-request',
          noImplicitFailover: true,
          authorizedRoutingCandidate: true,
        },
        () => deepSeekClient,
        () => null,
        () => null,
        () => null,
        qwenGetter,
      )).rejects.toThrow('402 exact candidate unavailable');

      expect(qwenGetter).not.toHaveBeenCalled();
      const receipt = receipts.listModelRoutingReceipts(userId, 1)[0];
      expect(receipt).toMatchObject({
        status: 'failed',
        requestedProvider: 'deepseek',
        requestedModel: 'exact-primary',
        selectedProvider: '',
        selectedModel: '',
      });
      expect(receipt.attempts).toHaveLength(1);
      expect(receipt.attempts[0]).toMatchObject({
        provider: 'deepseek', model: 'exact-primary', status: 'failed',
      });
    } finally {
      circuits.resetCircuit('deepseek', 'exact-primary');
    }
  });

  it('does not leave a local-only exact Ollama candidate for a cloud fallback', async () => {
    const providers = await import('../server/llm/providers');
    const local = await import('../server/llm/local_models');
    const previous = local.getLocalModelConfig('ollama');
    const cloudGetter = vi.fn(() => ({
      chat: { completions: { create: async () => ({
        choices: [{ message: { role: 'assistant', content: 'cloud must not run' } }],
      }) } },
    }));
    local.saveLocalModelConfig('ollama', {
      ...previous,
      detected: false,
      serviceReachable: false,
      inferenceHealthy: false,
      healthStatus: 'backoff',
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      lastError: 'local-only candidate unavailable',
    });

    try {
      await expect(providers.makeLLMCall(
        [{ role: 'user', content: 'stay local' }],
        [],
        {
          provider: 'ollama',
          model: 'exact-local-model',
          selectionMode: 'ordered_fallback',
          fallbackCandidates: [{ provider: 'qwen', model: 'forbidden-cloud-model' }],
          allowCloudFallback: true,
          noImplicitFailover: true,
          authorizedRoutingCandidate: true,
        },
        () => null,
        () => null,
        () => null,
        () => null,
        cloudGetter,
        () => ({ chat: { completions: { create: vi.fn() } } }),
      )).rejects.toThrow(/local-only candidate unavailable|backing off/i);
      expect(cloudGetter).not.toHaveBeenCalled();
    } finally {
      local.saveLocalModelConfig('ollama', previous);
    }
  });

  it('uses ordered fallbacks exactly and records the model that actually answered', async () => {
    const providers = await import('../server/llm/providers');
    const receipts = await import('../server/llm/model_routing_receipts');
    const openAIModels: string[] = [];
    const openAIClient = {
      chat: { completions: { create: async (request: any) => {
        openAIModels.push(String(request.model || ''));
        return { choices: [{ message: { role: 'assistant', content: `selected:${request.model}` } }] };
      } } },
    };

    const result = await providers.makeLLMCall(
      [{ role: 'user', content: 'follow the route' }],
      [],
      {
        provider: 'gemini',
        model: 'primary-gemini',
        userId: 'ordered-route-user',
        conversationId: 'ordered-route-conversation',
        requestId: 'ordered-route-request',
        interactionId: 'ordered-route-interaction',
        source: 'chat',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [
          { provider: 'anthropic', model: 'second-anthropic' },
          { provider: 'openai', model: 'third-openai' },
        ],
        allowCloudFallback: true,
      },
      () => null,
      () => null,
      () => openAIClient,
      () => null,
    );

    expect(result.text).toBe('selected:third-openai');
    expect(openAIModels).toEqual(['third-openai']);
    expect(result.routing).toMatchObject({
      requestedProvider: 'gemini',
      requestedModel: 'primary-gemini',
      selectionMode: 'ordered_fallback',
      selectedProvider: 'openai',
      selectedModel: 'third-openai',
    });
    expect(result.routing?.attempts.map(attempt => `${attempt.provider}/${attempt.model}:${attempt.status}`)).toEqual([
      'gemini/primary-gemini:failed',
      'anthropic/second-anthropic:skipped',
      'openai/third-openai:succeeded',
    ]);
    const receipt = receipts.listModelRoutingReceipts('ordered-route-user', 1)[0];
    expect(receipt).toMatchObject({
      status: 'succeeded',
      selectedProvider: 'openai',
      selectedModel: 'third-openai',
      conversationId: 'ordered-route-conversation',
      requestId: 'ordered-route-request',
      interactionId: 'ordered-route-interaction',
      source: 'chat',
    });
    expect(receipt.attempts).toEqual(result.routing?.attempts);
    const { flushDB, querySQL } = await import('../db_layer');
    await flushDB();
    const persisted = await querySQL<any>(
      'SELECT selectedProvider, selectedModel, attempts FROM model_routing_receipts WHERE id = ?',
      [receipt.id],
    );
    expect(persisted[0]).toMatchObject({ selectedProvider: 'openai', selectedModel: 'third-openai' });
    expect(JSON.parse(persisted[0].attempts)).toEqual(receipt.attempts);
  });

  it('does not block an explicitly selected cloud primary when cloud fallback is disabled', async () => {
    const providers = await import('../server/llm/providers');
    const openAIClient = {
      chat: { completions: { create: async (request: any) => ({
        choices: [{ message: { role: 'assistant', content: `primary:${request.model}` } }],
      }) } },
    };
    const result = await providers.makeLLMCall(
      [{ role: 'user', content: 'primary only' }],
      [],
      {
        provider: 'openai',
        model: 'explicit-cloud-primary',
        userId: 'primary-cloud-route-user',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'anthropic', model: 'blocked-cloud-fallback' }],
        allowCloudFallback: false,
      },
      () => null,
      () => null,
      () => openAIClient,
      () => null,
    );
    expect(result.text).toBe('primary:explicit-cloud-primary');
    expect(result.routing?.attempts).toHaveLength(1);
    expect(result.routing?.attempts[0]).toMatchObject({
      provider: 'openai', model: 'explicit-cloud-primary', status: 'succeeded', durationMs: expect.any(Number),
    });
  });

  it('does not cross the cloud fallback boundary when failover is disabled', async () => {
    const providers = await import('../server/llm/providers');
    let fallbackCalls = 0;
    const failingPrimary = {
      chat: { completions: { create: async () => { throw new Error('503 primary unavailable'); } } },
    };
    const fallback = {
      chat: { completions: { create: async () => {
        fallbackCalls += 1;
        return { choices: [{ message: { role: 'assistant', content: 'must not run' } }] };
      } } },
    };
    await expect(providers.makeLLMCall(
      [{ role: 'user', content: 'primary only' }],
      [],
      {
        provider: 'deepseek',
        model: 'no-cloud-fallback-primary',
        selectionMode: 'pinned',
        fallbackCandidates: [{ provider: 'openai', model: 'blocked-cloud-fallback' }],
        allowCloudFallback: false,
      },
      () => failingPrimary,
      () => null,
      () => fallback,
    )).rejects.toThrow('503 primary unavailable');
    expect(fallbackCalls).toBe(0);
  });

  it('skips an open-circuit pinned primary and records the health decision', async () => {
    const providers = await import('../server/llm/providers');
    const circuits = await import('../server/cloud/circuit_breaker');
    const primaryCreate = async () => {
      throw new Error('open-circuit primary must not be called');
    };
    let fallbackCalls = 0;
    const fallback = {
      chat: { completions: { create: async () => {
        fallbackCalls += 1;
        return { choices: [{ message: { role: 'assistant', content: 'circuit fallback' } }] };
      } } },
    };
    circuits.recordFailure(
      'gemini',
      'open-circuit-primary',
      new Error('known outage'),
      { openImmediately: true },
    );

    const result = await providers.makeLLMCall(
      [{ role: 'user', content: 'route around the outage' }],
      [],
      {
        provider: 'gemini',
        model: 'open-circuit-primary',
        selectionMode: 'pinned',
        fallbackCandidates: [{ provider: 'openai', model: 'healthy-circuit-fallback' }],
        allowCloudFallback: true,
      },
      () => null,
      () => ({ getGenerativeModel: () => ({ generateContent: primaryCreate }) }),
      () => fallback,
    );
    expect(result.text).toBe('circuit fallback');
    expect(fallbackCalls).toBe(1);
    expect(result.routing?.fallbackReason).toBe('circuit_open');
    expect(result.routing?.attempts[0]).toMatchObject({
      provider: 'gemini',
      model: 'open-circuit-primary',
      status: 'skipped',
      reason: 'circuit_open',
      durationMs: 0,
    });
    circuits.resetCircuit('gemini', 'open-circuit-primary');
  });

  it('uses the exact selected LM Studio model without restarting the runtime client', async () => {
    const local = await import('../server/llm/local_models');
    const prefs = await import('../server/llm/user_preferences');
    const providers = await import('../server/llm/providers');
    const { createLLMRuntime } = await import('../server/runtime/llm');
    await local.refreshLocalModelConfig('lmstudio', `http://127.0.0.1:${port}`);
    await local.refreshLocalModelConfig('ollama', 'http://127.0.0.1:9', { timeoutMs: 500 });
    const runtime = createLLMRuntime();

    prefs.upsertUserPreferredLLM('switch-user', { provider: 'lmstudio', model: 'lm-alpha' });
    const first = prefs.getUserPreferredLLMConfig('switch-user');
    const firstResult = await providers.makeLLMCall(
      [{ role: 'user', content: 'first' }], [], first,
      runtime.getDeepSeek, runtime.getGemini, runtime.getOpenAI, runtime.getAnthropic, runtime.getQwen,
      runtime.getOllama, runtime.getLmStudio, runtime.getArk, runtime.getXiaomi, runtime.getKimi, runtime.getGlm, runtime.getRelay,
    );

    prefs.upsertUserPreferredLLM('switch-user', { provider: 'lmstudio', model: 'lm-beta' });
    const second = prefs.getUserPreferredLLMConfig('switch-user');
    const secondResult = await providers.makeLLMCall(
      [{ role: 'user', content: 'second' }], [], second,
      runtime.getDeepSeek, runtime.getGemini, runtime.getOpenAI, runtime.getAnthropic, runtime.getQwen,
      runtime.getOllama, runtime.getLmStudio, runtime.getArk, runtime.getXiaomi, runtime.getKimi, runtime.getGlm, runtime.getRelay,
    );

    expect(firstResult.text).toBe('local:lm-alpha');
    expect(secondResult.text).toBe('local:lm-beta');
    expect(requestedModels.slice(-2)).toEqual(['lm-alpha', 'lm-beta']);
  });

  it('re-probes a healthy local runtime when the newly selected model is absent from the fresh cache', async () => {
    const local = await import('../server/llm/local_models');
    await local.refreshLocalModelConfig('lmstudio', `http://127.0.0.1:${port}`);
    expect(local.getLocalModelConfig('lmstudio').models).not.toContain('lm-gamma');
    servedModels = ['lm-alpha', 'lm-beta', 'lm-gamma'];
    const selected = await local.ensureLocalModelReady('lmstudio', 'lm-gamma');
    expect(selected.model).toBe('lm-gamma');
    expect(local.getLocalModelConfig('lmstudio').models).toContain('lm-gamma');
  });

  it('uses LM Studio in automatic mode and preserves the prior cloud model as fallback', async () => {
    const prefs = await import('../server/llm/user_preferences');
    const providers = await import('../server/llm/providers');
    const { createLLMRuntime } = await import('../server/runtime/llm');
    const runtime = createLLMRuntime();
    let cloudCalls = 0;
    const openAIClient = {
      chat: { completions: { create: async (request: any) => {
        cloudCalls += 1;
        return { choices: [{ message: { role: 'assistant', content: `cloud:${request.model}` } }] };
      } } },
    };

    prefs.upsertUserPreferredLLM('auto-user', { provider: 'openai', model: 'gpt-user-choice' });
    const automatic = prefs.upsertUserPreferredLLM('auto-user', {
      provider: 'auto',
      model: 'lm-alpha',
      models: { auto: 'lm-alpha', lmstudio: 'lm-alpha' },
    });
    expect(automatic.autoFallbackProvider).toBe('openai');
    expect(automatic.autoFallbackModel).toBe('gpt-user-choice');

    const result = await providers.makeLLMCall(
      [{ role: 'user', content: 'automatic local' }], [], prefs.getUserPreferredLLMConfig('auto-user'),
      runtime.getDeepSeek, runtime.getGemini, () => openAIClient, runtime.getAnthropic, runtime.getQwen,
      runtime.getOllama, runtime.getLmStudio, runtime.getArk, runtime.getXiaomi, runtime.getKimi, runtime.getGlm, runtime.getRelay,
    );
    expect(result.text).toBe('local:lm-alpha');
    expect(cloudCalls).toBe(0);
  });

  it('falls back to the configured cloud model on disconnect and reconnects locally without a restart', async () => {
    const local = await import('../server/llm/local_models');
    const prefs = await import('../server/llm/user_preferences');
    const providers = await import('../server/llm/providers');
    const { createLLMRuntime } = await import('../server/runtime/llm');
    const runtime = createLLMRuntime();
    let fallbackModel = '';
    const openAIClient = {
      chat: { completions: { create: async (request: any) => {
        fallbackModel = String(request.model || '');
        return { choices: [{ message: { role: 'assistant', content: `fallback:${request.model}` } }] };
      } } },
    };

    await closeServer();
    const fallback = await providers.makeLLMCall(
      [{ role: 'user', content: 'offline' }], [], prefs.getUserPreferredLLMConfig('auto-user'),
      runtime.getDeepSeek, runtime.getGemini, () => openAIClient, runtime.getAnthropic, runtime.getQwen,
      runtime.getOllama, runtime.getLmStudio, runtime.getArk, runtime.getXiaomi, runtime.getKimi, runtime.getGlm, runtime.getRelay,
    );
    expect(fallback.text).toBe('fallback:gpt-user-choice');
    expect(fallbackModel).toBe('gpt-user-choice');
    expect(local.getLocalModelConfig('lmstudio').detected).toBe(false);

    await listen(port);
    const reconnectState = local.getLocalModelConfig('lmstudio');
    local.saveLocalModelConfig('lmstudio', {
      ...reconnectState,
      nextRetryAt: new Date(Date.now() - 1).toISOString(),
    });
    prefs.upsertUserPreferredLLM('auto-user', { provider: 'lmstudio', model: 'lm-beta' });
    const recovered = await providers.makeLLMCall(
      [{ role: 'user', content: 'recovered' }], [], prefs.getUserPreferredLLMConfig('auto-user'),
      runtime.getDeepSeek, runtime.getGemini, () => openAIClient, runtime.getAnthropic, runtime.getQwen,
      runtime.getOllama, runtime.getLmStudio, runtime.getArk, runtime.getXiaomi, runtime.getKimi, runtime.getGlm, runtime.getRelay,
    );
    expect(recovered.text).toBe('local:lm-beta');
    expect(local.getLocalModelConfig('lmstudio').detected).toBe(true);
  });

  it('contains no channel-level model substitution rules', async () => {
    const fs = await import('node:fs/promises');
    const [chat, voice, task] = await Promise.all([
      fs.readFile('server/socket/chat.ts', 'utf8'),
      fs.readFile('server/socket/voice.ts', 'utf8'),
      fs.readFile('server/socket/task.ts', 'utf8'),
    ]);
    expect(chat).not.toMatch(/activeModel\s*=\s*isComplex/);
    expect(voice).not.toMatch(/effectiveModel\s*=\s*isComplex/);
    expect(voice).not.toContain("provider === 'deepseek' ? 'deepseek-v4-pro'");
    expect(task).toContain('let activeModel = userLLMPrefs.model');
    expect(task).not.toMatch(/activeModel\s*=\s*isComplex/);
    expect(task).not.toContain('Model auto-selected');
    for (const source of [chat, voice, task]) {
      expect(source).toContain('const reasoningRoutePolicy = {');
      expect(source).toContain('selectionMode: userLLMPrefs.selectionMode');
      expect(source).toContain('fallbackCandidates: userLLMPrefs.fallbackCandidates');
      expect(source).toContain('allowCloudFallback: userLLMPrefs.allowCloudFallback');
      expect(source).toMatch(/(?:makeLLMCall(?:Streaming)?|runWithTools)\([\s\S]{0,1600}\.\.\.reasoningRoutePolicy/);
    }
  });

  it('keeps auxiliary runtimes and frontend persistence free of hidden model overrides', async () => {
    const fs = await import('node:fs/promises');
    const [mcp, narrative, generator, appContext, settings] = await Promise.all([
      fs.readFile('server/mcp/lumi_server.ts', 'utf8'),
      fs.readFile('server/memory/narrative.ts', 'utf8'),
      fs.readFile('server/skills/generator.ts', 'utf8'),
      fs.readFile('src/contexts/AppContext.tsx', 'utf8'),
      fs.readFile('src/components/Settings.tsx', 'utf8'),
    ]);
    expect(mcp).not.toMatch(/model:\s*['"]deepseek-v4-(?:flash|pro)['"]/);
    expect(narrative).not.toMatch(/provider:\s*['"]deepseek['"]/);
    expect(generator).toContain('request.model || preferred.model');
    expect(settings).not.toContain('persistModel(generationModels[0])');
    const updateStart = appContext.indexOf('const updateAIConfig');
    const updateEnd = appContext.indexOf('const updateVisionConfig', updateStart);
    expect(appContext.slice(updateStart, updateEnd)).not.toContain('setAiConfig(prev =>');
  });
});
