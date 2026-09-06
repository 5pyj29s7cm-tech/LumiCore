import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, runSQL } from '../db_layer';
import { mountMemoryRoutes } from '../server/routes/memory_routes';
import { mountDeviceRoutes } from '../server/routes/device_routes';
import { initSocketRuntime } from '../server/runtime/socket';
import * as OrgDB from '../server/org/db';

// Only unrelated execution/model boundaries are replaced. Real auth, rooms,
// device registration, memory handlers, notifications and SQLite remain active.
vi.mock('../server/socket/chat', () => ({ registerChatHandler: vi.fn() }));
vi.mock('../server/socket/task', () => ({ registerTaskHandler: vi.fn() }));
vi.mock('../server/socket/voice', () => ({ registerVoiceHandlers: vi.fn() }));
vi.mock('../server/socket/perception', () => ({ registerPerceptionHandlers: vi.fn() }));
vi.mock('../server/socket/ambient', () => ({ registerAmbientHandlers: vi.fn() }));
vi.mock('../server/socket/conversations', () => ({ registerConversationHandlers: vi.fn() }));
vi.mock('../server/socket/wake', () => ({ registerWakeHandlers: vi.fn() }));
vi.mock('../server/socket/terminal', () => ({ registerTerminalHandlers: vi.fn() }));
vi.mock('../server/socket/client_self', () => ({ registerClientSelfHandlers: vi.fn() }));
vi.mock('../server/socket/focus', () => ({ registerFocusHandlers: vi.fn() }));
vi.mock('../server/socket/scene', () => ({ registerSceneHandlers: vi.fn() }));
vi.mock('../server/personality', () => ({ personalityRegistry: { load: vi.fn(), setBroadcast: vi.fn() } }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: vi.fn(() => { throw new Error('No model in sync audit'); }) }));
vi.mock('../server/llm/embedding_provider', () => ({
  getEmbeddingRoute: () => ({ primary: { provider: 'audit', model: 'none' } }),
  generateConfiguredEmbedding: async () => { throw new Error('No embeddings in sync audit'); },
}));

const uid = 'round8-sync-owner';
let orgId = '';
let orgTwo = '';
let workTwo: Socket;
let otherWork: Socket;
let app: Awaited<ReturnType<typeof makeApp>>;
let io: Server;
let personal: Socket;
let work: Socket;
let other: Socket;
const events: Record<string, any[]> = { personal: [], work: [], other: [], workTwo: [], otherWork: [] };
const token = (user = uid, organization = '') => jwt.sign({ uid: user, username: user, role: 'user', ...(organization ? { orgId: organization } : {}) }, JWT_SECRET);
async function request(path: string, method = 'GET', body?: unknown, organization = '', user = uid) {
  const response = await fetch(`${app.url}/api${path}`, { method,
    headers: { Authorization: `Bearer ${token(user, organization)}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function client(label: string, user = uid, organization = '') {
  const socket = connect(app.url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: token(user, organization), fingerprint: `audit-${label}` } });
  socket.on('memories:changed', value => events[label].push(value));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
async function settleEvents() {
  await Promise.all([personal, work, other, workTwo, otherWork].map(socket => new Promise<void>(resolve => {
    socket.once('pong', () => resolve()); socket.emit('ping');
  })));
}
beforeAll(async () => {
  app = await makeApp();
  orgId = OrgDB.createOrg('Synthetic sync org', 'round8-sync-org', uid).id;
  OrgDB.addMember(orgId, uid, 'owner');
  OrgDB.addMember(orgId, 'round8-sync-other', 'member');
  orgTwo = OrgDB.createOrg('Synthetic second sync org', 'round8-sync-org-two', uid).id;
  OrgDB.addMember(orgTwo, uid, 'owner');
  mountMemoryRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);
  mountDeviceRoutes(app.apiRouter, JWT_SECRET);
  io = new Server(app.server);
  initSocketRuntime({ io, jwtSecret: JWT_SECRET, llm: { ...LLM_GETTERS } as any });
  personal = await client('personal'); work = await client('work', uid, orgId); other = await client('other', 'round8-sync-other');
  workTwo = await client('workTwo', uid, orgTwo); otherWork = await client('otherWork', 'round8-sync-other', orgId);
  await flushDBOrThrow();
});
afterAll(async () => {
  await runSQL('PRAGMA query_only=OFF'); await flushDBOrThrow();
  personal?.disconnect(); work?.disconnect(); other?.disconnect(); workTwo?.disconnect(); otherWork?.disconnect();
  await new Promise<void>(resolve => io.close(() => resolve()));
});

const changeEvents = (id: string, action?: string) => Object.fromEntries(Object.entries(events)
  .map(([key, values]) => [key, values.filter(e => e.memoryId === id && (!action || e.action === action))]));
let sequence = 0;
const create = (organization = '') => request('/memories', 'POST', {
  type: 'fact', content: `Synthetic ${++sequence} topic ${crypto.randomUUID()}`, confidence: 0.8,
}, organization);
async function reopen() { await closeDatabase(); await initDatabase(); }

it('saves a personal memory before success and notifies only the personal owner', async () => {
  const result = await create();
  expect(result.status).toBe(200); await settleEvents();
  expect(await querySQL('SELECT content FROM memories WHERE id=?', [result.body.id])).toEqual([{ content: result.body.content }]);
  const delivery = changeEvents(result.body.id);
  expect(delivery.personal).toHaveLength(1);
  expect(delivery.personal[0]).toMatchObject({ userId: uid, domain: 'personal', orgId: '' });
  for (const name of ['work', 'workTwo', 'other', 'otherWork']) expect(delivery[name]).toHaveLength(0);
});

it('notifies exactly the owner and organization for work create/update/delete, excluding a second organization and fellow member', async () => {
  for (const [organization, label] of [[orgId, 'work'], [orgTwo, 'workTwo']]) {
    const created = await create(organization); expect(created.status).toBe(200);
    expect((await request(`/memories/${created.body.id}`, 'PUT', { content: 'Updated scoped synthetic record' }, organization)).status).toBe(200);
    expect((await request(`/memories/${created.body.id}`, 'DELETE', undefined, organization)).status).toBe(200);
    await settleEvents();
    const delivery = changeEvents(created.body.id);
    expect(delivery[label].map(e => e.action)).toEqual(['added', 'updated', 'deleted']);
    expect(delivery[label].every(e => e.domain === 'work' && e.orgId === organization)).toBe(true);
    for (const name of Object.keys(events).filter(name => name !== label)) expect(delivery[name]).toHaveLength(0);
  }
});

it('returns 503 without broadcasting an unsaved update, then saves the explicit retry before acknowledging it', async () => {
  const created = await create(); expect(created.status).toBe(200);
  const updatedText = 'Durably updated after synthetic disk recovery';
  await runSQL('PRAGMA query_only=ON');
  try {
    const failed = await request(`/memories/${created.body.id}`, 'PUT', { content: updatedText });
    expect(failed).toMatchObject({ status: 503, body: { code: 'PERSISTENCE_UNAVAILABLE', retryable: true, persistence: 'pending' } });
    await settleEvents(); expect(changeEvents(created.body.id, 'updated').personal).toHaveLength(0);
    expect(await querySQL('SELECT content FROM memories WHERE id=?', [created.body.id])).toEqual([{ content: created.body.content }]);
    expect(readDB().memories.find((m: any) => m.id === created.body.id)?.content).toBe(updatedText);
  } finally { await runSQL('PRAGMA query_only=OFF'); }
  expect((await request(`/memories/${created.body.id}`, 'PUT', { content: updatedText })).status).toBe(200);
  expect(await querySQL('SELECT content FROM memories WHERE id=?', [created.body.id])).toEqual([{ content: updatedText }]);
  await settleEvents(); expect(changeEvents(created.body.id, 'updated').personal).toHaveLength(1);
});

it('keeps a scoped deletion receipt through failed-save retries and restart without rolling back unrelated writes', async () => {
  const created = await create(orgId); expect(created.status).toBe(200);
  const path = `/memories/${created.body.id}`;
  await runSQL('PRAGMA query_only=ON');
  try {
    expect((await request(path, 'DELETE', undefined, orgId)).status).toBe(503);
    expect((await request(path, 'DELETE', undefined, orgId)).status).toBe(503);
    expect((await request(path, 'DELETE', undefined, orgTwo)).status).toBe(404);
    expect((await request(path, 'DELETE', undefined, orgId, 'round8-sync-other')).status).toBe(404);
    await settleEvents(); expect(changeEvents(created.body.id, 'deleted').work).toHaveLength(0);
    expect(await querySQL('SELECT id FROM memories WHERE id=?', [created.body.id])).toHaveLength(1);
    expect(readDB().memories.some((m: any) => m.id === created.body.id)).toBe(false);
    const { writeDB } = await import('../db_layer');
    const db = readDB(); db.settings.push({ key: 'round8-unrelated-write', value: 'retained' }); writeDB(db);
  } finally { await runSQL('PRAGMA query_only=OFF'); }
  expect((await request(path, 'DELETE', undefined, orgId)).status).toBe(200);
  expect(await querySQL('SELECT id FROM memories WHERE id=?', [created.body.id])).toHaveLength(0);
  expect(await querySQL('SELECT value FROM settings WHERE key=?', ['round8-unrelated-write'])).toEqual([{ value: 'retained' }]);
  await reopen();
  expect((await request(path, 'DELETE', undefined, orgId)).status).toBe(200);
  expect((await request(path, 'DELETE', undefined, orgTwo)).status).toBe(404);
  expect((await request('/memories/not-an-owned-id', 'DELETE', undefined, orgId)).status).toBe(404);
});

it('makes pair/unpair retries durable and serializes concurrent pairs without losing either device', async () => {
  personal.emit('device:register', { name: 'Synthetic primary browser', type: 'web', capabilities: { audio: false } });
  const second = await client('personal');
  try {
    // Different fingerprints are essential for distinct device registry entries.
    second.auth = { token: token(), fingerprint: 'audit-second-device' };
    second.disconnect().connect();
    await new Promise<void>((resolve, reject) => { second.once('connect', resolve); second.once('connect_error', reject); });
    second.emit('device:register', { name: 'Synthetic second browser', type: 'web', capabilities: { audio: false } });
    await new Promise<void>(resolve => { second.once('pong', () => resolve()); second.emit('ping'); });
    await settleEvents();
    const listed = await request('/devices');
    const ids = listed.body.devices.filter((d: any) => d.name.startsWith('Synthetic')).map((d: any) => d.id);
    expect(ids).toHaveLength(2);
    const key = `paired_devices_${uid}_personal`;
    await flushDBOrThrow(); await runSQL('PRAGMA query_only=ON');
    try {
      expect((await request('/devices/pair', 'POST', { deviceId: ids[0] })).status).toBe(503);
      expect(await querySQL('SELECT value FROM settings WHERE key=?', [key])).toHaveLength(0);
      expect((await request('/devices/pair', 'POST', { deviceId: ids[0] }, '', 'round8-sync-other')).status).toBe(404);
    } finally { await runSQL('PRAGMA query_only=OFF'); }
    const paired = await Promise.all([ids[0], ids[1], ids[0]].map(deviceId => request('/devices/pair', 'POST', { deviceId })));
    expect(paired.map(result => result.status)).toEqual([200, 200, 200]);
    expect(new Set(JSON.parse((await querySQL('SELECT value FROM settings WHERE key=?', [key]))[0].value))).toEqual(new Set(ids));
    await runSQL('PRAGMA query_only=ON');
    try {
      expect((await request(`/devices/pair/${encodeURIComponent(ids[0])}`, 'DELETE')).status).toBe(503);
      expect((await request(`/devices/pair/${encodeURIComponent(ids[0])}`, 'DELETE')).status).toBe(503);
      expect(JSON.parse((await querySQL('SELECT value FROM settings WHERE key=?', [key]))[0].value)).toContain(ids[0]);
    } finally { await runSQL('PRAGMA query_only=OFF'); }
    expect((await request(`/devices/pair/${encodeURIComponent(ids[0])}`, 'DELETE')).status).toBe(200);
    await reopen();
    expect((await request(`/devices/pair/${encodeURIComponent(ids[0])}`, 'DELETE')).status).toBe(200);
    expect((await request('/devices')).body.pairedDeviceIds).toEqual([ids[1]]);
  } finally { second.disconnect(); }
});

it('uses an explicit protection target for safe retry and does not advise blindly retrying the old toggle', async () => {
  const created = await create(); expect(created.status).toBe(200);
  const path = `/memory/${created.body.id}/protect`;
  await runSQL('PRAGMA query_only=ON');
  try {
    expect((await request(path, 'PUT', { protected: true })).status).toBe(503);
    expect(readDB().memories.find((m: any) => m.id === created.body.id)?.tier).toBe('core_identity');
    expect((await request(path, 'PUT', { protected: true })).status).toBe(503);
  } finally { await runSQL('PRAGMA query_only=OFF'); }
  expect((await request(path, 'PUT', { protected: true }))).toMatchObject({ status: 200, body: { success: true, protected: true } });
  expect((await querySQL('SELECT tier FROM memories WHERE id=?', [created.body.id]))[0].tier).toBe('core_identity');
  await runSQL('PRAGMA query_only=ON');
  try {
    expect(await request(path, 'PUT', {})).toMatchObject({ status: 503, body: { retryable: false } });
    expect(await request(path, 'PUT', { protected: false })).toMatchObject({ status: 503, body: { retryable: true } });
  } finally { await runSQL('PRAGMA query_only=OFF'); }
  const notificationsBefore = changeEvents(created.body.id, 'updated').personal.length;
  expect(await request(path, 'PUT', { protected: false })).toMatchObject({ status: 200, body: { protected: false } });
  await settleEvents();
  expect(changeEvents(created.body.id, 'updated').personal).toHaveLength(notificationsBefore + 1);
  expect((await querySQL('SELECT tier FROM memories WHERE id=?', [created.body.id]))[0].tier).toBe('growth');
});
