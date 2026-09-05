import './helpers';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { officialApiRequest, officialApiBinary } from '../server/llm/official_api';
import { makeLLMCall, makeLLMCallDirect } from '../server/llm/providers';
import { saveLocalModelConfig } from '../server/llm/local_models';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { chatPublicErrorCodeForException } from '../server/socket/chat_public_error';

beforeAll(() => initDatabase());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const messages = [{ role: 'user' as const, content: 'synthetic private prompt' }];
const unavailable = () => null;

describe('strict mode execution boundaries', () => {
  it('hides and denies every automatic tool even when its declaration claims no side effects', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'must not run');
    registry.register({ name: 'synthetic_local_tool', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler,
      capability: { sideEffects: [] } });
    expect(registry.getToolDeclarations()).toEqual([]);
    expect(registry.resolveSecurity('synthetic_local_tool').level).toBe('forbidden');
    await expect(registry.execute('synthetic_local_tool', {}, { userConfirmed: true })).rejects.toThrow(/Privacy/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('blocks official API JSON and media requests before transport', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const transport = vi.fn();
    await expect(officialApiRequest('/chat/completions', { fetchImpl: transport })).rejects.toThrow(/Privacy/);
    await expect(officialApiBinary('https://example.test/private.mp4', { fetchImpl: transport })).rejects.toThrow(/Privacy/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks cloud image and video even through a direct handler call', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const transport = vi.spyOn(globalThis, 'fetch');
    const registry = new ToolRegistry();
    registerImageTools(registry);
    registerVideoTools(registry);
    for (const name of ['generate_image', 'generate_image_dalle', 'generate_video']) {
      const tool = registry.get(name);
      expect(tool, name).toBeDefined();
      await expect(tool!.handler({ prompt: 'synthetic private prompt' }, {})).rejects.toThrow(/Privacy/);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks a cloud primary and all cloud fallback candidates before their SDK getters', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const getter = vi.fn(() => { throw new Error('must not access cloud SDK'); });
    await expect(makeLLMCall(messages, [], {
      provider: 'deepseek', model: 'synthetic-cloud', selectionMode: 'ordered_fallback',
      fallbackCandidates: [{ provider: 'openai', model: 'synthetic-fallback' }],
    }, getter, getter, getter)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects a remote endpoint labeled as local, while an available loopback model can answer', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const model = 'synthetic-local-model';
    const config = { baseUrl: 'https://example.test', detected: true, models: [model], inferenceHealthy: true, probedModel: model };
    saveLocalModelConfig('lmstudio', config);
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'local answer' }, finish_reason: 'stop' }] }));
    const getter = vi.fn(() => ({ chat: { completions: { create } } }));
    await expect(makeLLMCallDirect(messages, [], { provider: 'lmstudio', model }, unavailable, unavailable, unavailable, unavailable, unavailable, unavailable, getter)).rejects.toThrow(/Privacy/);
    expect(getter).not.toHaveBeenCalled();
    saveLocalModelConfig('lmstudio', { ...config, baseUrl: 'http://127.0.0.1:1234' });
    const result = await makeLLMCallDirect(messages, [], { provider: 'lmstudio', model }, unavailable, unavailable, unavailable, unavailable, unavailable, unavailable, getter);
    expect(result.text).toBe('local answer');
    expect(create).toHaveBeenCalledOnce();
  });

  it('gives a privacy-specific recovery message rather than suggesting payment for cloud service', () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    expect(chatPublicErrorCodeForException(new Error('[Privacy] private provider details'))).toBe('CHAT_PRIVACY_RESTRICTED');
    expect(chatPublicErrorCodeForException({ name: 'ModelRoutingDispatchError' })).toBe('CHAT_PRIVACY_RESTRICTED');
  });
});
