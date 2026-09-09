import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  DEFAULT_MODELS, getUserPreferredLLM, getUserPreferredLLMConfig, upsertUserPreferredLLM,
} from '../server/llm/user_preferences';
import { compileReasoningFailoverCandidates } from '../server/llm/failover_policy';
import { parseOfficialApiModelCatalog } from '../server/llm/official_api';
import { selectOfficialRoleModel } from '../server/llm/model_configuration';
import {
  LUMI_OFFICIAL_DEFAULT_MODELS, LUMI_OFFICIAL_REASONING_DEFAULTS_VERSION,
} from '../shared/model_provider_capabilities';

const current = 'aliyun/deepseek-v4-flash';
const previous = 'aliyun/qwen-plus';
let sequence = 0;
function seed(overrides: Record<string, unknown> = {}) {
  const userId = `official-default-migration-${++sequence}`;
  const db = readDB();
  db.settings.push({ key: `llm_prefs_${userId}`, value: JSON.stringify({
    schemaVersion: 2, provider: 'relay', models: { relay: previous, qwen: 'qwen-plus', lmstudio: 'local-personal-model' },
    autoFallbackProvider: 'relay', autoFallbackModel: previous, allowCloudFallback: true,
    fallbackCandidates: [
      { provider: 'relay', model: previous }, { provider: 'qwen', model: 'qwen-plus' },
      { provider: 'relay', model: current }, { provider: 'lmstudio', model: 'local-personal-model' },
    ], ...overrides,
  }) });
  writeDB(db);
  return userId;
}
function stored(userId: string) {
  return readDB().settings.find(row => row.key === `llm_prefs_${userId}`)?.value;
}

describe('official reasoning default migration', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses the official default for a background user with no settings, without borrowing another user or BYOK routes', async () => {
    const configuredUser = seed({ provider: 'deepseek', models: { deepseek: 'explicit-private-model' } });
    const newUser = `unconfigured-background-${++sequence}`;
    const pref = getUserPreferredLLM(newUser);
    const config = getUserPreferredLLMConfig(newUser, {
      source: 'scheduler_predictive_assistant', domain: 'personal', orgId: '', maxTokens: 100,
    });
    expect(config).toMatchObject({ provider: 'relay', model: current, userId: newUser, source: 'scheduler_predictive_assistant' });
    expect(config.fallbackCandidates).toEqual([]);
    expect(compileReasoningFailoverCandidates({ primaryProvider: pref.provider, primaryModel: pref.model, preferences: pref })).toEqual([]);
    expect(getUserPreferredLLM(configuredUser)).toMatchObject({ provider: 'deepseek', model: 'explicit-private-model' });
    expect(stored(newUser)).toBeUndefined();

    const { makeLLMCall } = await import('../server/llm/providers');
    const { resetCircuit } = await import('../server/cloud/circuit_breaker');
    const official = vi.fn(async () => { throw Object.assign(new Error('official rejected'), { status: 403 }); });
    const byok = vi.fn(async () => ({ choices: [{ message: { content: 'must not be contacted' } }] }));
    try {
      await expect(makeLLMCall([{ role: 'user', content: 'isolated scheduler test' }], [], config,
        () => ({ chat: { completions: { create: byok } } }), () => null,
        undefined, undefined, () => ({ chat: { completions: { create: byok } } }),
        undefined, undefined, undefined, undefined, undefined, undefined,
        () => ({ chat: { completions: { create: official } } }),
      )).rejects.toThrow('official rejected');
      expect(official).toHaveBeenCalledTimes(1);
      expect(byok).not.toHaveBeenCalled();
    } finally { resetCircuit(); }
  });

  it('uses the same official cloud default for a local-only selection without inventing BYOK fallback models', () => {
    const userId = seed({ provider: 'lmstudio', models: { lmstudio: 'explicit-local' },
      autoFallbackProvider: undefined, autoFallbackModel: undefined, fallbackCandidates: [],
    });
    expect(getUserPreferredLLMConfig(userId)).toMatchObject({ provider: 'lmstudio', model: 'explicit-local' });
    const pref = getUserPreferredLLM(userId);
    expect(pref.autoFallbackProvider).toBe('relay');
    expect(compileReasoningFailoverCandidates({ primaryProvider: pref.provider, primaryModel: pref.model, preferences: pref }))
      .toEqual([{ provider: 'relay', model: current }]);
  });

  it('migrates every stored official fallback entry once and retains the local backup', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const userId = seed();
    const resolved = getUserPreferredLLM(userId);
    expect(DEFAULT_MODELS.relay).toBe(current);
    expect(LUMI_OFFICIAL_DEFAULT_MODELS.reasoning).toBe(current);
    expect(resolved).toMatchObject({ model: current, autoFallbackModel: current,
      officialDefaultsVersion: LUMI_OFFICIAL_REASONING_DEFAULTS_VERSION });
    expect(resolved.models).toEqual({ relay: current, lmstudio: 'local-personal-model' });
    expect(resolved.fallbackCandidates).toEqual([{ provider: 'lmstudio', model: 'local-personal-model' }]);
    expect(getUserPreferredLLMConfig(userId)).toMatchObject({ provider: 'relay', model: current });
    const first = stored(userId);
    expect(getUserPreferredLLM(userId)).toEqual(resolved);
    expect(stored(userId)).toBe(first);
  });

  it('previews a migration without persisting it during a role-apply preflight', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const userId = seed();
    const before = stored(userId);
    expect(getUserPreferredLLM(userId, { persistMigration: false }).model).toBe(current);
    expect(stored(userId)).toBe(before);
  });

  it.each(['auto', 'ollama', 'lmstudio'])('migrates a %s primary cloud backup without replacing its local model', provider => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const userId = seed({ provider, models: { [provider]: 'local-personal-model', relay: previous } });
    const resolved = getUserPreferredLLM(userId);
    expect(resolved).toMatchObject({ provider, model: 'local-personal-model',
      autoFallbackProvider: 'relay', autoFallbackModel: current });
    expect(resolved.fallbackCandidates).toEqual(([
      { provider: 'relay', model: current }, { provider: 'lmstudio', model: 'local-personal-model' },
    ]).filter(candidate => candidate.provider !== provider));
    const candidates = compileReasoningFailoverCandidates({ primaryProvider: provider, primaryModel: resolved.model, preferences: resolved });
    expect(candidates).toContainEqual({ provider: 'relay', model: current });
    expect(candidates).not.toContainEqual({ provider: 'qwen', model: 'qwen-plus' });
  });

  it('keeps independent BYOK qwen selections and their fallback ordering', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const userId = seed({ provider: 'qwen', models: { qwen: 'qwen-plus' },
      autoFallbackProvider: 'qwen', autoFallbackModel: 'qwen-plus',
      fallbackCandidates: [{ provider: 'qwen', model: 'qwen-custom-backup' }, { provider: 'ollama', model: 'local-personal-model' }],
    });
    const resolved = getUserPreferredLLM(userId);
    expect(resolved).toMatchObject({ provider: 'qwen', model: 'qwen-plus', autoFallbackModel: 'qwen-plus' });
    expect(resolved.models.qwen).toBe('qwen-plus');
    expect(resolved.fallbackCandidates.map(candidate => candidate.model)).toEqual(['qwen-custom-backup', 'local-personal-model']);
  });

  it('preserves a custom relay deployment and a new explicitly chosen legacy alias', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://custom-gateway.example.test/v1');
    const custom = getUserPreferredLLM(seed());
    expect(custom.model).toBe(previous);
    expect(custom.fallbackCandidates).toContainEqual({ provider: 'qwen', model: 'qwen-plus' });
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const userId = `explicit-official-${++sequence}`;
    upsertUserPreferredLLM(userId, { provider: 'relay', model: previous,
      fallbackCandidates: [{ provider: 'qwen', model: 'qwen-plus' }] });
    expect(getUserPreferredLLM(userId)).toMatchObject({ model: previous, autoFallbackModel: previous,
      fallbackCandidates: [{ provider: 'qwen', model: 'qwen-plus' }] });
  });

  it('does not let a stale auto field replace a selected primary in the model map', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const resolved = getUserPreferredLLM(seed({ models: { relay: 'aliyun/kimi-k3' } }));
    expect(resolved).toMatchObject({ model: 'aliyun/kimi-k3', models: { relay: 'aliyun/kimi-k3' }, autoFallbackModel: 'aliyun/kimi-k3' });
  });

  it('preserves an older flat custom selection while migrating only its old official backup', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const resolved = getUserPreferredLLM(seed({ models: {}, model: 'aliyun/kimi-k3' }));
    expect(resolved).toMatchObject({ model: 'aliyun/kimi-k3', models: { relay: 'aliyun/kimi-k3' }, autoFallbackModel: 'aliyun/kimi-k3' });
    expect(resolved.fallbackCandidates).toContainEqual({ provider: 'relay', model: current });
  });

  it('does not select the retired reasoning default when the required replacement is absent', () => {
    expect(selectOfficialRoleModel('reasoning', [previous], current, { explicitSelection: false })).toBeNull();
    expect(selectOfficialRoleModel('reasoning', [previous, current, 'aliyun/kimi-k3'], current)).toMatchObject({ model: current });
    expect(selectOfficialRoleModel('reasoning', [current, 'aliyun/kimi-k3'], 'aliyun/kimi-k3')).toMatchObject({ model: 'aliyun/kimi-k3' });
  });

  it('cannot resurrect the failed direct qwen default from an official failover chain', () => {
    vi.stubEnv('RELAY_BASE_URL', 'https://zhuan.huaczy.com/v1');
    const resolved = getUserPreferredLLM(seed());
    const candidates = compileReasoningFailoverCandidates({ primaryProvider: 'relay', primaryModel: resolved.model, preferences: resolved });
    expect(candidates).not.toContainEqual({ provider: 'qwen', model: 'qwen-plus' });
    expect(candidates).not.toContainEqual({ provider: 'relay', model: previous });
    expect(candidates).toContainEqual({ provider: 'lmstudio', model: 'local-personal-model' });
  });
});

describe('documented gateway catalog identity', () => {
  it('uses callable route ids and keeps upstream versions as metadata only', () => {
    // Public gateway /api/v1/models shape verified on 2026-09-08.
    const catalog = parseOfficialApiModelCatalog({ success: true, data: { items: [
      { id: 1, route_id: current, provider_model_name: 'deepseek-v4-flash-0731', provider: 'DeepSeek', capability: 'chat', enabled: true },
      { id: 2, route_id: 'aliyun/deepseek-v4-pro', provider_model_name: 'deepseek-v4-pro-0813', capability: 'chat', enabled: true },
      { id: 3, route_id: 'aliyun/kimi-k3', capability: 'chat', enabled: true },
      { id: 4, route_id: previous, provider_model_name: 'qwen3.7-plus', capability: 'chat', enabled: true },
      { id: 5, route_id: 'aliyun/disabled', capability: 'chat', enabled: false },
      { id: 6, model_name: 'not-a-callable-id', capability: 'chat', enabled: true },
    ] } });
    expect(catalog.byRole.reasoning).toEqual([current, 'aliyun/deepseek-v4-pro', 'aliyun/kimi-k3', previous]);
    expect(catalog.models[0]).toMatchObject({ id: current, upstreamModel: 'deepseek-v4-flash-0731', ownedBy: 'DeepSeek' });
    expect(catalog.models.find(model => model.id === previous)?.upstreamModel).toBe('qwen3.7-plus');
    expect(catalog.byRole.reasoning).not.toContain('aliyun/qwen3.7-plus');
  });
});
