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
    { id: 'huawei_maas/qwen2.5-vl-72b', capability: 'multimodal_chat' },
    { id: 'aliyun/qwen3-vl-flash', capability: 'multimodal_chat' },
    { id: 'huawei_maas/qwen-image', capability: 'image_generation' },
    { id: 'huawei_maas/qwen-image-edit-2509', capability: 'image_edit' },
    { id: 'huawei_maas/Wan2.2-T2V-A14B', capability: 'video_generation' },
    { id: 'huawei_maas/Wan2.2-I2V-A14B', capability: 'video_generation' },
    { id: 'huawei_maas/bge-m3', capability: 'embedding' },
    { id: 'huawei_maas/bge-reranker-v2-m3', capability: 'rerank' },
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
      'huawei_maas/qwen2.5-vl-72b',
      'aliyun/qwen3-vl-flash',
      'huawei_maas/qwen-image',
      'huawei_maas/qwen-image-edit-2509',
      'huawei_maas/Wan2.2-T2V-A14B',
      'huawei_maas/Wan2.2-I2V-A14B',
      'huawei_maas/bge-m3',
      'huawei_maas/bge-reranker-v2-m3',
      'aliyun/qwen-audio-3.0-asr-flash-streaming',
      'aliyun/cosyvoice-v3-flash',
    ]);
    expect(getUserPreferredGenerationModels(userId)).toMatchObject({
      imageEdit: { provider: 'relay', model: 'huawei_maas/qwen-image-edit-2509' },
      video: { provider: 'relay', model: 'huawei_maas/Wan2.2-T2V-A14B' },
      imageToVideo: { provider: 'relay', model: 'huawei_maas/Wan2.2-I2V-A14B' },
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
});
