import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import * as database from '../db_layer';
import { mountSystemRoutes } from '../server/routes/system_routes';
import { saveKeys } from '../server/config/keys';
import { getUserPreferredLLM, upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { applyLumiOfficialModelConfiguration, getLumiModelConfiguration, LUMI_MODEL_ROLES, updateLumiModelConfiguration } from '../server/llm/model_configuration';
import { getVoicePreference, setVoicePreference } from '../server/config/voice_preference';
import { listOfficialApiModels } from '../server/llm/official_api';

const catalog = [
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

describe('official model configuration concurrent ownership', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  const fakeCreate = vi.fn(async (payload: any) => {
    if (payload.model === 'audit-missing-model') throw Object.assign(new Error('404 model not found'), { status: 404 });
    return { choices: [{ message: { content: 'synthetic OK' } }] };
  });
  const client = { chat: { completions: { create: fakeCreate } } };
  const headers = (userId: string) => ({
    Authorization: `Bearer ${jwt.sign({ uid: userId, username: userId, role: 'admin' }, JWT_SECRET)}`,
    'Content-Type': 'application/json',
  });
  const request = (path: string, uid: string, method: string, body?: unknown) => fetch(`${app.url}/api${path}`, {
    method, headers: headers(uid), signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    app = await makeApp();
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit() {} }, { getDeepSeek: () => client });
    app.app.get('/audit-official/v1/models', (_req, res) => res.json({ data: catalog }));
    vi.stubEnv('RELAY_API_KEY', 'audit-synthetic-relay-key');
    vi.stubEnv('RELAY_BASE_URL', `${app.url}/audit-official/v1`);
    saveKeys({ RELAY_API_KEY: 'audit-synthetic-relay-key', RELAY_BASE_URL: `${app.url}/audit-official/v1` });
  });
  beforeEach(() => { setVoicePreference({ stt: 'auto', tts: 'auto', sttModel: undefined, ttsModel: undefined }); });
  afterEach(() => { vi.restoreAllMocks(); fakeCreate.mockClear(); resetCircuit(); });
  afterAll(() => { vi.unstubAllEnvs(); app.server.close(); });

  async function failApplyAfter(uid: string, whileWaiting: () => Promise<void> | void) {
    await database.flushDBOrThrow();
    let reached!: () => void;
    const atFlush = new Promise<void>(resolve => { reached = resolve; });
    let fail!: (error: Error) => void;
    const held = new Promise<void>((_resolve, reject) => { fail = reject; });
    vi.spyOn(database, 'flushDBOrThrow').mockImplementationOnce(() => { reached(); return held; });
    const pending = request('/preferences/official/apply', uid, 'POST');
    await atFlush;
    try { await whileWaiting(); }
    finally {
      fail(new Error('EIO controlled configuration persistence boundary'));
      expect((await pending).status).toBe(500);
    }
  }

  function selections(uid: string) {
    const configuration = getLumiModelConfiguration(uid);
    if (!('roles' in configuration)) throw new Error('Expected the complete model-role configuration');
    return Object.fromEntries(Object.entries(configuration.roles).map(([role, value]) => [role, {
      provider: String(value.provider || ''), model: String(value.model || ''),
    }]));
  }

  it('control: a successful official apply followed by a new preference preserves the new selection', async () => {
    const uid = 'audit9-apply-serial';
    expect((await request('/preferences/official/apply', uid, 'POST')).status).toBe(200);
    expect((await request('/preferences/llm', uid, 'PUT', { provider: 'openai', model: 'audit-latest-model' })).status).toBe(200);
    await database.flushDBOrThrow();
    expect(getUserPreferredLLM(uid)).toMatchObject({ provider: 'openai', model: 'audit-latest-model' });
  });

  it('a failed pending apply preserves a newer model selection already flushed to SQLite', async () => {
    const uid = 'audit9-apply-race';
    upsertUserPreferredLLM(uid, { provider: 'deepseek', model: 'audit-original-model' });
    await database.flushDBOrThrow();
    const originalFlush = database.flushDBOrThrow;
    let reached!: () => void;
    const atFlush = new Promise<void>(resolve => { reached = resolve; });
    let rejectFlush!: (error: Error) => void;
    const heldFlush = new Promise<void>((_resolve, reject) => { rejectFlush = reject; });
    vi.spyOn(database, 'flushDBOrThrow').mockImplementationOnce(() => { reached(); return heldFlush; });
    const applyRequest = request('/preferences/official/apply', uid, 'POST');
    await atFlush;
    const newer = await request('/preferences/llm', uid, 'PUT', { provider: 'openai', model: 'audit-latest-model' });
    expect(newer.status).toBe(200);
    await originalFlush();
    expect(getUserPreferredLLM(uid)).toMatchObject({ provider: 'openai', model: 'audit-latest-model' });
    rejectFlush(new Error('EIO synthetic delayed persistence failure of the older apply'));
    const oldResult = await applyRequest;
    expect(oldResult.status).toBe(500);
    expect(await oldResult.json()).toMatchObject({ ok: false, error: expect.stringContaining('could not be persisted') });
    expect(getUserPreferredLLM(uid)).toMatchObject({ provider: 'openai', model: 'audit-latest-model' });
  });

  it('real SQLite read-only failure preserves the later acknowledged choice', async () => {
    const uid = 'audit9-apply-real-sqlite';
    upsertUserPreferredLLM(uid, { provider: 'deepseek', model: 'audit-original-model' });
    await database.flushDBOrThrow();
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    let locked!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const hold = database.withDatabaseSqlWriteLock(async session => {
      await session.run('PRAGMA query_only=ON');
      locked();
      await gate;
    });
    await lockReady;
    try {
      const oldApply = request('/preferences/official/apply', uid, 'POST');
      await vi.waitFor(() => expect(getUserPreferredLLM(uid).provider).toBe('relay'));
      expect((await request('/preferences/llm', uid, 'PUT', { provider: 'openai', model: 'audit-newer-choice' })).status).toBe(200);
      expect(getUserPreferredLLM(uid).model).toBe('audit-newer-choice');
      unlock();
      await hold;
      expect((await oldApply).status).toBe(500);
      expect(getUserPreferredLLM(uid)).toMatchObject({ provider: 'openai', model: 'audit-newer-choice' });
    } finally {
      unlock();
      await hold;
      await database.runSQL('PRAGMA query_only=OFF');
      await database.flushDBOrThrow();
    }
    const rows = await database.querySQL<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`llm_prefs_${uid}`]);
    expect(JSON.parse(rows[0].value)).toMatchObject({ provider: 'openai', models: { openai: 'audit-newer-choice' } });
  });

  it.each(LUMI_MODEL_ROLES)('preserves a later %s role write while compensating every still-owned sibling', async role => {
    const uid = `role-isolation-${role}`;
    const before = selections(uid);
    const model = `audit/new-${role}`;
    await failApplyAfter(uid, () => {
      updateLumiModelConfiguration(uid, { role, provider: 'relay', model });
    });
    const after = selections(uid);
    expect(after[role]).toEqual({ provider: 'relay', model });
    for (const sibling of LUMI_MODEL_ROLES) {
      if (sibling !== role) expect(after[sibling], `rollback of ${sibling}`).toEqual(before[sibling]);
    }
  });

  it('preserves explicit same-value saves and ABA changes for all roles', async () => {
    const uid = 'role-same-value-aba';
    let reaffirmed: ReturnType<typeof selections>;
    await failApplyAfter(uid, () => {
      reaffirmed = selections(uid);
      for (const role of LUMI_MODEL_ROLES) {
        updateLumiModelConfiguration(uid, { role, provider: 'relay', model: `audit/intermediate-${role}` });
        updateLumiModelConfiguration(uid, { role, ...reaffirmed[role] });
      }
    });
    expect(selections(uid)).toEqual(reaffirmed!);
  });

  it('serializes official batches across users and continues after the first batch fails', async () => {
    const nextUid = 'official-queue-second-user';
    const verifiedCatalog = await listOfficialApiModels();
    let next!: ReturnType<typeof applyLumiOfficialModelConfiguration>;
    let settled = false;
    await failApplyAfter('official-queue-first-user', async () => {
      next = applyLumiOfficialModelConfiguration(nextUid, { catalog: verifiedCatalog });
      void next.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(getUserPreferredLLM(nextUid).provider).toBe('deepseek');
    });
    expect((await next).ok).toBe(true);
    expect(getUserPreferredLLM(nextUid).provider).toBe('relay');
    expect(getVoicePreference()).toMatchObject({ stt: 'relay', tts: 'relay' });
  });
});
