import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  });

  it('keeps auxiliary runtimes and frontend persistence free of hidden model overrides', async () => {
    const fs = await import('node:fs/promises');
    const [mcp, narrative, generator, appContext] = await Promise.all([
      fs.readFile('server/mcp/lumi_server.ts', 'utf8'),
      fs.readFile('server/memory/narrative.ts', 'utf8'),
      fs.readFile('server/skills/generator.ts', 'utf8'),
      fs.readFile('src/contexts/AppContext.tsx', 'utf8'),
    ]);
    expect(mcp).not.toMatch(/model:\s*['"]deepseek-v4-(?:flash|pro)['"]/);
    expect(narrative).not.toMatch(/provider:\s*['"]deepseek['"]/);
    expect(generator).toContain('request.model || preferred.model');
    const updateStart = appContext.indexOf('const updateAIConfig');
    const updateEnd = appContext.indexOf('const updateVisionConfig', updateStart);
    expect(appContext.slice(updateStart, updateEnd)).not.toContain('setAiConfig(prev =>');
  });
});
