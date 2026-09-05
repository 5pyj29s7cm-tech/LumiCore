import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { saveKeys } from '../server/config/keys';
import { getUserPreferredLLM } from '../server/llm/user_preferences';
import { getUserPreferredVision } from '../server/llm/vision_preferences';
import { getUserWorldModelPrefs } from '../server/llm/world_preferences';
import { getUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import { getUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { getVoicePreference, setVoicePreference } from '../server/config/voice_preference';
import { LUMI_OFFICIAL_SUPPORTED_ROLES, LUMI_OFFICIAL_UNSUPPORTED_ROLES } from '../shared/model_provider_capabilities';
import { mountSystemRoutes } from '../server/routes/system_routes';
import { updateLumiModelConfiguration } from '../server/llm/model_configuration';
import { readDB, writeDB } from '../db_layer';

describe('Lumi official API one-click adaptation', () => {
  const requestTimeoutMs = 15_000;
  let url = '';
  let cleanup: (() => void) | undefined;
  const userId = 'official-api-apply-test-user';
  const token = jwt.sign({ uid: userId, username: 'official-test', role: 'admin' }, JWT_SECRET);
  const userToken = jwt.sign({ uid: `${userId}-ordinary-user`, username: 'ordinary-test', role: 'user' }, JWT_SECRET);
  let initialVoicePreference: ReturnType<typeof getVoicePreference>;
  const completeCatalogModels = [
    { id: 'aliyun/qwen-plus', capability: 'chat' },
    { id: 'aliyun/qwen2.5-vl-72b', capability: 'multimodal_chat' },
    { id: 'aliyun/qwen3-vl-flash', capability: 'multimodal_chat' },
    { id: 'aliyun/qwen-image', capability: 'image_generation' },
    { id: 'aliyun/qwen-image-edit-2509', capability: 'image_edit' },
    { id: 'aliyun/Wan2.2-T2V-A14B', capability: 'video_generation' },
    { id: 'aliyun/Wan2.2-I2V-A14B', capability: 'video_generation' },
    { id: 'aliyun/bge-m3', capability: 'embedding' },
    { id: 'aliyun/bge-reranker-v2-m3', capability: 'rerank' },
    { id: 'aliyun/qwen-audio-3.0-asr-flash-streaming', capability: 'speech_recognition' },
    { id: 'aliyun/cosyvoice-v3-flash', capability: 'speech_synthesis' },
  ];
  let activeCatalogModels = completeCatalogModels;

  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    initialVoicePreference = getVoicePreference();
    app.app.get('/official/v1/models', (req, res) => {
      if (req.headers.authorization !== 'Bearer sk-official-apply-test') {
        return res.status(401).json({ error: { message: 'unauthorized' } });
      }
      return res.json({
        object: 'list',
        data: activeCatalogModels,
      });
    });
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
    saveKeys({
      RELAY_API_KEY: 'sk-official-apply-test',
      RELAY_BASE_URL: `${url}/official/v1`,
    });
  });

  afterAll(() => {
    if (initialVoicePreference) setVoicePreference(initialVoicePreference);
    saveKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' });
    cleanup?.();
  });

  it('requires authentication', async () => {
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(401);
  });

  it('does not let a normal account change the instance-wide voice route', async () => {
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(403);
  });

  it('applies only verified official adapters and reports the rest', async () => {
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      provider: 'relay',
      verification: 'catalog_verified_and_configuration_persisted',
      catalog: { modelCount: 11, roleCount: 11 },
    });
    expect(body.applied.map((item: any) => item.role)).toEqual([...LUMI_OFFICIAL_SUPPORTED_ROLES]);
    expect(body.skipped.map((item: any) => item.role)).toEqual([...LUMI_OFFICIAL_UNSUPPORTED_ROLES]);
    expect(Object.keys(body.roles).sort()).toEqual([...LUMI_OFFICIAL_SUPPORTED_ROLES, ...LUMI_OFFICIAL_UNSUPPORTED_ROLES].sort());
    expect(getUserPreferredLLM(userId).provider).toBe('relay');
    expect(getUserPreferredVision(userId).provider).toBe('relay');
    expect(getUserWorldModelPrefs(userId).provider).toBe('relay');
    expect(getUserRetrievalModelPreferences(userId).embedding.provider).toBe('relay');
    expect(body.skipped.every((item: any) => item.reason === 'adapter_not_available')).toBe(true);
    expect(body.applied).toHaveLength(11);
    expect(body.applied.map((item: any) => item.model)).toEqual([
      'aliyun/qwen-plus',
      'aliyun/qwen2.5-vl-72b',
      'aliyun/qwen3-vl-flash',
      'aliyun/qwen-image',
      'aliyun/qwen-image-edit-2509',
      'aliyun/Wan2.2-T2V-A14B',
      'aliyun/Wan2.2-I2V-A14B',
      'aliyun/bge-m3',
      'aliyun/bge-reranker-v2-m3',
      'aliyun/qwen-audio-3.0-asr-flash-streaming',
      'aliyun/cosyvoice-v3-flash',
    ]);
    expect(getUserPreferredGenerationModels(userId)).toMatchObject({
      imageEdit: { provider: 'relay', model: 'aliyun/qwen-image-edit-2509' },
      video: { provider: 'relay', model: 'aliyun/Wan2.2-T2V-A14B' },
      imageToVideo: { provider: 'relay', model: 'aliyun/Wan2.2-I2V-A14B' },
    });
    expect(body.roles.vision.selectionReason).toBe('recommended_default');
    expect(body.roles.world.selectionReason).toBe('recommended_default');
    expect(getVoicePreference()).toMatchObject({
      stt: 'relay',
      sttModel: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
      tts: 'relay',
      ttsModel: 'aliyun/cosyvoice-v3-flash',
    });
    expect(JSON.stringify(body)).not.toContain('sk-official-apply-test');
  });

  it('preflights every role and writes nothing when the catalog is incomplete', async () => {
    const incompleteUserId = `${userId}-incomplete`;
    const incompleteToken = jwt.sign({ uid: incompleteUserId, username: 'incomplete-test', role: 'admin' }, JWT_SECRET);
    const before = getUserPreferredLLM(incompleteUserId);
    activeCatalogModels = completeCatalogModels.filter(model => model.capability !== 'image_edit');
    try {
      const response = await fetch(`${url}/api/preferences/official/apply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${incompleteToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'OFFICIAL_API_CATALOG_INCOMPLETE',
        error: expect.stringContaining('image_edit'),
      });
      expect(getUserPreferredLLM(incompleteUserId)).toEqual(before);
    } finally {
      activeCatalogModels = completeCatalogModels;
    }
  });

  it('persists only live-catalog speech models and exposes the effective ids', async () => {
    const response = await fetch(`${url}/api/voice/provider`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stt: 'relay',
        sttModel: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
        tts: 'relay',
        ttsModel: 'aliyun/cosyvoice-v3-flash',
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pref).toMatchObject({
      sttModel: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
      ttsModel: 'aliyun/cosyvoice-v3-flash',
    });
    expect(body.active).toMatchObject({
      sttModel: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
      ttsModel: 'aliyun/cosyvoice-v3-flash',
    });

    const rejected = await fetch(`${url}/api/voice/provider`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stt: 'relay', sttModel: 'aliyun/not-in-catalog' }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(rejected.status).toBe(400);
  });

  it('migrates retired namespaces through the catalog and persists the same world model family', async () => {
    const migrationUserId = `${userId}-namespace-migration`;
    const migrationToken = jwt.sign({ uid: migrationUserId, username: 'migration-test', role: 'admin' }, JWT_SECRET);
    updateLumiModelConfiguration(migrationUserId, {
      role: 'world', provider: 'relay', model: 'huawei_maas/qwen2.5-vl-72b',
    });
    updateLumiModelConfiguration(migrationUserId, {
      role: 'embedding', provider: 'relay', model: 'huawei_maas/bge-m3',
    });
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST', headers: { Authorization: `Bearer ${migrationToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.roles.world).toMatchObject({
      model: 'aliyun/qwen2.5-vl-72b', selectionReason: 'catalog_namespace_migration',
    });
    expect(body.roles.embedding).toMatchObject({
      model: 'aliyun/bge-m3', selectionReason: 'catalog_namespace_migration',
    });
    expect(getUserWorldModelPrefs(migrationUserId).model).toBe('aliyun/qwen2.5-vl-72b');
    expect(getUserRetrievalModelPreferences(migrationUserId).embedding.model).toBe('aliyun/bge-m3');
  });

  it('writes no roles when a saved custom model would need a family change', async () => {
    const customUserId = `${userId}-custom`;
    const customToken = jwt.sign({ uid: customUserId, username: 'custom-test', role: 'admin' }, JWT_SECRET);
    updateLumiModelConfiguration(customUserId, {
      role: 'world', provider: 'relay', model: 'custom/private-world-model',
    });
    const before = getUserPreferredLLM(customUserId);
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST', headers: { Authorization: `Bearer ${customToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'OFFICIAL_API_MODEL_SELECTION_UNAVAILABLE',
      error: expect.stringContaining('Explicitly choose a replacement model'),
    });
    expect(getUserPreferredLLM(customUserId)).toEqual(before);
    expect(getUserWorldModelPrefs(customUserId).model).toBe('custom/private-world-model');
  });

  it('still adapts non-official provider choices to the official defaults', async () => {
    const externalUserId = `${userId}-external-providers`;
    const externalToken = jwt.sign({ uid: externalUserId, username: 'external-test', role: 'admin' }, JWT_SECRET);
    updateLumiModelConfiguration(externalUserId, { role: 'reasoning', provider: 'qwen', model: 'qwen-private-chat' });
    updateLumiModelConfiguration(externalUserId, { role: 'vision', provider: 'qwen', model: 'qwen-private-vision' });
    updateLumiModelConfiguration(externalUserId, { role: 'world', provider: 'qwen', model: 'qwen-private-world' });
    updateLumiModelConfiguration(externalUserId, { role: 'image_generation', provider: 'qwen', model: 'qwen-private-image' });
    updateLumiModelConfiguration(externalUserId, { role: 'embedding', provider: 'qwen', model: 'qwen-private-embedding' });
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST', headers: { Authorization: `Bearer ${externalToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toHaveLength(11);
    expect(body.roles.reasoning.model).toBe('aliyun/qwen-plus');
    expect(body.roles.vision.model).toBe('aliyun/qwen2.5-vl-72b');
    expect(body.roles.world.model).toBe('aliyun/qwen3-vl-flash');
    expect(body.roles.image_generation.model).toBe('aliyun/qwen-image');
    expect(body.roles.embedding.model).toBe('aliyun/bge-m3');
  });

  it('does not replace an explicitly saved recommended model when it leaves the catalog', async () => {
    const pinnedDefaultUserId = `${userId}-explicit-default`;
    const pinnedDefaultToken = jwt.sign({ uid: pinnedDefaultUserId, username: 'explicit-default-test', role: 'admin' }, JWT_SECRET);
    updateLumiModelConfiguration(pinnedDefaultUserId, { role: 'world', provider: 'relay', model: 'aliyun/qwen3-vl-flash' });
    const before = getUserPreferredLLM(pinnedDefaultUserId);
    activeCatalogModels = completeCatalogModels.filter(model => model.id !== 'aliyun/qwen3-vl-flash');
    try {
      const response = await fetch(`${url}/api/preferences/official/apply`, {
        method: 'POST', headers: { Authorization: `Bearer ${pinnedDefaultToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'OFFICIAL_API_MODEL_SELECTION_UNAVAILABLE' });
      expect(getUserPreferredLLM(pinnedDefaultUserId)).toEqual(before);
      expect(getUserWorldModelPrefs(pinnedDefaultUserId).model).toBe('aliyun/qwen3-vl-flash');
    } finally {
      activeCatalogModels = completeCatalogModels;
    }
  });

  it('preserves the selected official world model over a legacy deployment model', async () => {
    const selectedUserId = `${userId}-deployment-conflict`;
    const selectedToken = jwt.sign({ uid: selectedUserId, username: 'deployment-test', role: 'admin' }, JWT_SECRET);
    updateLumiModelConfiguration(selectedUserId, { role: 'world', provider: 'relay', model: 'custom/live-world' });
    const previous = process.env.RELAY_WORLD_MODEL;
    process.env.RELAY_WORLD_MODEL = 'huawei_maas/qwen2.5-vl-72b';
    activeCatalogModels = [...completeCatalogModels, { id: 'custom/live-world', capability: 'multimodal_chat' }];
    try {
      const response = await fetch(`${url}/api/preferences/official/apply`, {
        method: 'POST', headers: { Authorization: `Bearer ${selectedToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).roles.world).toMatchObject({
        model: 'custom/live-world', selectionReason: 'preserved_live_selection',
      });
      expect(getUserWorldModelPrefs(selectedUserId).model).toBe('custom/live-world');
    } finally {
      if (previous === undefined) delete process.env.RELAY_WORLD_MODEL;
      else process.env.RELAY_WORLD_MODEL = previous;
      activeCatalogModels = completeCatalogModels;
    }
  });

  it('does not persist a legacy reasoning read migration when later preflight fails', async () => {
    const legacyUserId = `${userId}-legacy-preflight`;
    const legacyToken = jwt.sign({ uid: legacyUserId, username: 'legacy-test', role: 'admin' }, JWT_SECRET);
    const key = `llm_prefs_${legacyUserId}`;
    const original = JSON.stringify({ provider: 'relay', models: { relay: 'gpt-4o' } });
    const db = readDB();
    db.settings.push({ key, value: original });
    writeDB(db);
    activeCatalogModels = completeCatalogModels.filter(model => model.capability !== 'image_edit');
    try {
      const response = await fetch(`${url}/api/preferences/official/apply`, {
        method: 'POST', headers: { Authorization: `Bearer ${legacyToken}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      expect(response.status).toBe(409);
      expect(readDB().settings.find(setting => setting.key === key)?.value).toBe(original);
    } finally {
      activeCatalogModels = completeCatalogModels;
    }
  });
});
