import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getScopedPreferredLLM } from '../server/llm/user_preferences';
import { registerModelConfigurationTools } from '../server/tools/definitions/model_configuration_tools';
import { ToolRegistry } from '../server/tools/registry';

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerModelConfigurationTools(registry);
  return registry;
}

describe('Lumi model configuration tools', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('exposes structured read, update, and test tools', () => {
    const declarations = createRegistry().getToolDeclarations();
    expect(declarations.map(item => item.function.name)).toEqual([
      'model_configuration_get',
      'model_configuration_update',
      'model_configuration_test',
    ]);
    const update = declarations.find(item => item.function.name === 'model_configuration_update');
    expect(update?.function.parameters.properties.role.enum).toEqual(expect.arrayContaining([
      'reasoning',
      'world',
      'video_generation',
      'embedding',
      'speech_synthesis',
    ]));
  });

  it('updates a role directly and refreshes the connected client', async () => {
    const registry = createRegistry();
    const desktopRelay = vi.fn(async () => JSON.stringify({ ok: true }));
    const result = JSON.parse(await registry.execute('model_configuration_update', {
      role: 'video_generation',
      provider: 'minimax',
      model: 'MiniMax-Hailuo-02',
      testAfterUpdate: false,
    }, {
      userId: 'model-config-video-user',
      domain: 'work',
      orgId: 'org-does-not-own-models',
      desktopRelay,
    }));

    expect(result).toMatchObject({
      ok: true,
      saved: true,
      scope: 'lumi',
      sharedAcrossPersonalAndOrganizationDomains: true,
      organizationOverridesSupported: false,
      updated: {
        role: 'video_generation',
        configuration: {
          provider: 'minimax',
          model: 'MiniMax-Hailuo-02',
        },
      },
      client: { connected: true, refreshed: true },
    });
    expect(desktopRelay).toHaveBeenCalledWith('client_action', {
      action: 'refresh_model_configuration',
      payload: { roles: ['video_generation'] },
    });
  });

  it('uses one reasoning preference in personal and organization domains', async () => {
    const registry = createRegistry();
    await registry.execute('model_configuration_update', {
      role: 'reasoning',
      provider: 'qwen',
      model: 'qwen-max',
      testAfterUpdate: false,
    }, {
      userId: 'shared-lumi-model-user',
      domain: 'work',
      orgId: 'org-a',
    });

    expect(getScopedPreferredLLM('shared-lumi-model-user', { domain: 'personal' })).toMatchObject({
      provider: 'qwen',
      model: 'qwen-max',
      source: 'personal',
    });
    expect(getScopedPreferredLLM('shared-lumi-model-user', { domain: 'work', orgId: 'org-b' })).toMatchObject({
      provider: 'qwen',
      model: 'qwen-max',
      source: 'personal',
    });
  });

  it('selects the correct default when a role changes provider without a model id', async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute('model_configuration_update', {
      role: 'embedding',
      provider: 'qwen',
      fallbackProvider: '',
      testAfterUpdate: false,
    }, { userId: 'model-config-embedding-default-user' }));

    expect(result.updated.configuration).toMatchObject({
      provider: 'qwen',
      model: 'text-embedding-v4',
      fallbackProvider: '',
    });
  });

  it('runs the default post-update connection test and reports real evidence', async () => {
    const registry = createRegistry();
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'OK' } }] }));
    const result = JSON.parse(await registry.execute('model_configuration_update', {
      role: 'reasoning',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    }, {
      userId: 'model-config-live-test-user',
      llmGetters: {
        getDeepSeek: () => ({ chat: { completions: { create } } }),
        getGemini: () => null,
      },
    }));

    expect(result.test).toMatchObject({
      ok: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('does not report a saved model as verified when its live test fails', async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute('model_configuration_update', {
      role: 'reasoning',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    }, { userId: 'model-config-failed-test-user' }));

    expect(result).toMatchObject({
      ok: false,
      saved: true,
      verified: false,
      status: 'saved_but_test_failed',
      test: { ok: false },
    });
  });

  it('rejects unsupported providers without changing the role', async () => {
    const registry = createRegistry();
    await expect(registry.execute('model_configuration_update', {
      role: 'video_generation',
      provider: 'not-a-video-provider',
      model: 'anything',
      testAfterUpdate: false,
    }, { userId: 'model-config-invalid-user' })).rejects.toThrow('Unsupported video provider');
  });
});
