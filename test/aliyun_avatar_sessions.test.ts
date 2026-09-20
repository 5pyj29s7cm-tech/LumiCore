import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AliyunAvatarSessions, emptyAliyunAvatarRecord, type AliyunAvatarRecord } from '../server/memory_avatar/aliyun_sessions';
import { PortraitError } from '../server/memory_avatar/portrait_provider';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { mountMemoryAvatarPortraitRoutes } from '../server/memory_avatar/portrait_routes';
const state = vi.hoisted(() => ({ strict: false }));
vi.mock('../server/config/privacy', () => ({ isStrictPrivacy: () => state.strict }));
vi.mock('../server/memory_avatar/store', () => ({ getMemoryAvatar: vi.fn() }));
vi.mock('../server/memory_avatar/lifecycle', () => ({ captureMemoryAvatarAuthorization: vi.fn() }));
vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => 'synthetic-aliyun-jwt-secret' }));
vi.mock('../server/org/db', () => ({ getMember: () => ({ status: 'active', role: 'member' }) }));
const scope = { userId: 'owner', avatarId: 'person', callSessionId: 'call' };
const rtc = { appId: 'app', channel: 'channel', token: 'ephemeral-token', timestamp: 12345678, clientUserId: 'client', serverUserId: 'server', avatarUserId: 'avatar' };
const config = { enabled: true, cloudConsent: true, accessKeyId: 'fixtureKeyId', accessKeySecret: 'fixtureKeySecret', projectId: 'project-one', instanceId: 'instance-one' };
let data: Map<string, AliyunAvatarRecord>, provider: { create: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }, manager: AliyunAvatarSessions;
let controllers: Set<AbortController>;
let write: Mock<(id: string, record: AliyunAvatarRecord) => void>;
function makeManager() {
  return new AliyunAvatarSessions({ provider: provider as any, repository: { read: id => structuredClone(data.get(id) || emptyAliyunAvatarRecord()), write },
    avatar: ((userId: string, avatarId: string) => userId === 'owner' && ['person', 'other-person'].includes(avatarId) ? { status: 'active' } : null) as any,
    authorize: (() => ({ assertCurrent() {}, isCurrent: () => true, watch: (controller: AbortController) => { controllers.add(controller); return () => controllers.delete(controller); } })) as any });
}
beforeEach(async () => {
  state.strict = false; data = new Map(); controllers = new Set();
  write = vi.fn((id: string, record: AliyunAvatarRecord) => { data.set(id, structuredClone(record)); });
  provider = { create: vi.fn().mockResolvedValue({ sessionId: 'remote-one', rtc }), close: vi.fn().mockResolvedValue(undefined) };
  manager = makeManager(); await manager.configure('owner', 'person', config);
});
afterEach(async () => { state.strict = false; provider.close.mockResolvedValue(undefined); await manager.stop(scope); await runtimeBackgroundWork.waitForIdle(); vi.useRealTimers(); });
const create = (id = 'create-one') => manager.create(scope, id, true);
async function ready() { const offer = await create(); manager.markReady(scope, offer.portraitSessionId); return offer; }

describe('Aliyun owner-scoped audio renderer', () => {
  it('protects every Aliyun route and never falls back to D-ID for an unready Aliyun session', async () => {
    const app = express(), router = express.Router(), did = { create: vi.fn(), speak: vi.fn() };
    app.use(express.json()); app.use('/api', router); mountMemoryAvatarPortraitRoutes(router, did as any, manager);
    const server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
      const address = server.address() as { port: number };
      const request = async (route: string, method = 'GET', body?: any, identity: any = { uid: 'owner' }) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/memory-avatars/person/portrait/${route}`, { method,
          headers: { 'Content-Type': 'application/json', ...(identity ? { Authorization: `Bearer ${jwt.sign(identity, 'synthetic-aliyun-jwt-secret')}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() };
      };
      expect((await request('aliyun/config', 'GET', undefined, null)).status).toBe(401);
      expect((await request('aliyun/config', 'GET', undefined, { uid: 'owner', orgId: 'team' })).status).toBe(403);
      expect((await request('aliyun/config', 'GET', undefined, { uid: 'intruder' })).status).toBe(404);
      const response = await request('aliyun/config'); expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toMatch(/fixtureKey/);
      expect((await request('streams', 'POST', { callSessionId: 'call', clientRequestId: 'did-create', cloudConsent: true })).status).toBe(409);
      expect((await request('speak', 'POST', { callSessionId: 'call', requestId: 'speech', format: 'wav', audioBase64: 'YWJj' })).status).toBe(409);
      expect(did.create).not.toHaveBeenCalled(); expect(did.speak).not.toHaveBeenCalled();
      const offered = await request('aliyun/streams', 'POST', { callSessionId: 'call', clientRequestId: 'api-create', cloudConsent: true });
      expect(offered.status).toBe(201);
      expect((await request(`aliyun/streams/${offered.body.portraitSessionId}/ready`, 'POST', { callSessionId: 'other-call' })).status).toBe(404);
      expect((await request(`aliyun/streams/${offered.body.portraitSessionId}/ready`, 'POST', { callSessionId: 'call' })).status).toBe(200);
      expect((await request('speak', 'POST', { callSessionId: 'call', requestId: 'speech', format: 'wav', audioBase64: 'YWJj' })).body.browserAudio).toBe(true);
      expect((await request('aliyun/streams/by-request/api-create', 'DELETE', { callSessionId: 'call' })).status).toBe(200);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('redacts long-lived keys and binds projects independently to each person', async () => {
    await manager.configure('owner', 'other-person', { ...config, projectId: 'project-two' });
    expect(manager.config('owner', 'person').projectId).toBe('project-one');
    expect(manager.config('owner', 'other-person').projectId).toBe('project-two');
    expect(JSON.stringify(manager.config('owner', 'person'))).not.toMatch(/fixtureKey/);
    expect(() => manager.config('intruder', 'person')).toThrow();
  });
  it('creates only after durable reservation, requires renderer readiness, and authorizes audio once', async () => {
    provider.create.mockImplementation(async () => {
      expect(data.get('owner')!.sessions[0].status).toBe('creating');
      return { sessionId: 'remote-one', rtc };
    });
    const offer = await create(); expect(manager.ready(scope)).toBe(false);
    manager.markReady(scope, offer.portraitSessionId);
    const input = { ...scope, requestId: 'speech-one', audioBuffer: Buffer.from('test-audio'), format: 'mp3' };
    expect(manager.speak(input)).toMatchObject({ browserAudio: true, status: 'accepted', requestId: 'speech-one' });
    expect(() => manager.speak(input)).toThrow();
    expect(() => manager.speak({ ...input, userId: 'intruder', requestId: 'speech-two' })).toThrow();
  });
  it('blocks remote creation when the local reservation cannot be saved', async () => {
    write.mockImplementationOnce(() => { throw new Error('storage full'); });
    await expect(create()).rejects.toThrow(); expect(provider.create).not.toHaveBeenCalled();
  });
  it('persists cancellation before a delayed create reaches the server', async () => {
    await manager.stopByRequest(scope, 'create-one');
    await expect(create()).rejects.toThrow(); expect(provider.create).not.toHaveBeenCalled();
  });
  it('closes the exact late-created session when cancellation races its response', async () => {
    let resolve!: (value: any) => void;
    provider.create.mockImplementation(() => new Promise(done => { resolve = done; }));
    const creating = create(); void creating.catch(() => {});
    const stopping = manager.stopByRequest(scope, 'create-one');
    resolve({ sessionId: 'late-remote', rtc });
    await expect(creating).rejects.toThrow(); await stopping;
    expect(provider.close).toHaveBeenCalledWith({ accessKeyId: 'fixtureKeyId', accessKeySecret: 'fixtureKeySecret' }, 'instance-one', 'late-remote');
    expect(data.get('owner')!.sessions[0]).toMatchObject({ status: 'stopped', credential: undefined });
  });
  it('blocks new paid creates after an unknown outcome instead of retrying', async () => {
    provider.create.mockRejectedValue(new PortraitError('aliyun_create_unknown', 'unknown', 503, true));
    await expect(create()).rejects.toThrow(); await runtimeBackgroundWork.waitForIdle();
    await expect(create('different-request')).rejects.toThrow();
    expect(provider.create).toHaveBeenCalledTimes(1); expect(manager.config('owner', 'person').cleanupPending).toBe(true);
  });
  it('keeps old keys only for cleanup after key replacement', async () => {
    await ready(); await manager.configure('owner', 'person', { ...config, accessKeySecret: 'newFixtureSecret' });
    expect(manager.ready(scope)).toBe(false);
    expect(provider.close.mock.calls[0][0].accessKeySecret).toBe('fixtureKeySecret');
  });
  it('retires a lost client, while heartbeats keep a live session open', async () => {
    vi.useFakeTimers(); const offer = await ready();
    await vi.advanceTimersByTimeAsync(60_000); manager.heartbeat(scope, offer.portraitSessionId);
    await vi.advanceTimersByTimeAsync(60_000); expect(provider.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_001); expect(provider.close).toHaveBeenCalledTimes(1);
    expect(manager.ready(scope)).toBe(false);
  });
  it('revokes cloud audio immediately in strict mode and after source invalidation', async () => {
    await ready(); state.strict = true; expect(manager.ready(scope)).toBe(false);
    expect(() => manager.speak({ ...scope, requestId: 'r', audioBuffer: Buffer.from('a'), format: 'wav' })).toThrow();
    state.strict = false; for (const controller of controllers) controller.abort();
    await runtimeBackgroundWork.waitForIdle(); expect(manager.ready(scope)).toBe(false); expect(provider.close).toHaveBeenCalled();
  });
  it('recovers recorded sessions after restart by closing, never creating again', async () => {
    await ready(); const restarted = makeManager(); restarted.config('owner', 'person');
    await runtimeBackgroundWork.waitForIdle();
    expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.close).toHaveBeenCalledWith(expect.anything(), 'instance-one', 'remote-one');
  });
});
