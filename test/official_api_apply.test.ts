import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { saveKeys } from '../server/config/keys';
import { getUserPreferredLLM } from '../server/llm/user_preferences';
import { getUserPreferredVision } from '../server/llm/vision_preferences';
import { getUserWorldModelPrefs } from '../server/llm/world_preferences';
import { getUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import { LUMI_OFFICIAL_SUPPORTED_ROLES, LUMI_OFFICIAL_UNSUPPORTED_ROLES } from '../shared/model_provider_capabilities';
import { mountSystemRoutes } from '../server/routes/system_routes';

describe('Lumi official API one-click adaptation', () => {
  let url = '';
  let cleanup: (() => void) | undefined;
  const userId = 'official-api-apply-test-user';
  const token = jwt.sign({ uid: userId, username: 'official-test', role: 'admin' }, JWT_SECRET);
  const userToken = jwt.sign({ uid: `${userId}-ordinary-user`, username: 'ordinary-test', role: 'user' }, JWT_SECRET);

  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
    saveKeys({
      RELAY_API_KEY: 'sk-official-apply-test',
      RELAY_BASE_URL: 'http://127.0.0.1:8000/v1',
    });
  });

  afterAll(() => {
    saveKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' });
    cleanup?.();
  });

  it('requires authentication', async () => {
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
  });

  it('does not let a normal account change the instance-wide voice route', async () => {
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
  });

  it('applies only verified official adapters and reports the rest', async () => {
    const response = await fetch(`${url}/api/preferences/official/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, provider: 'relay', verification: 'configuration_persisted' });
    expect(body.applied.map((item: any) => item.role)).toEqual([...LUMI_OFFICIAL_SUPPORTED_ROLES]);
    expect(body.skipped.map((item: any) => item.role)).toEqual([...LUMI_OFFICIAL_UNSUPPORTED_ROLES]);
    expect(Object.keys(body.roles).sort()).toEqual([...LUMI_OFFICIAL_SUPPORTED_ROLES, ...LUMI_OFFICIAL_UNSUPPORTED_ROLES].sort());
    expect(getUserPreferredLLM(userId).provider).toBe('relay');
    expect(getUserPreferredVision(userId).provider).toBe('relay');
    expect(getUserWorldModelPrefs(userId).provider).toBe('relay');
    expect(getUserRetrievalModelPreferences(userId).embedding.provider).toBe('relay');
    expect(body.skipped.every((item: any) => item.reason === 'adapter_not_available')).toBe(true);
    expect(body.applied).toHaveLength(9);
    expect(body.applied.map((item: any) => item.model)).toEqual([
      'aliyun/qwen-plus',
      'huawei_maas/qwen2.5-vl-72b',
      'huawei_maas/qwen2.5-vl-72b',
      'huawei_maas/qwen-image',
      'huawei_maas/Wan2.2-T2V-A14B',
      'huawei_maas/bge-m3',
      'huawei_maas/bge-reranker-v2-m3',
      'whisper-1',
      'tts-1',
    ]);
    expect(JSON.stringify(body)).not.toContain('sk-official-apply-test');
  });
});
