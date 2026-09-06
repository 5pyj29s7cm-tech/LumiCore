import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB, runSQL } from '../db_layer';
import { mountMemoryAvatarRoutes } from '../server/routes/memory_avatar_routes';
import { buildMemoryAvatarContext, getMemoryAvatar } from '../server/memory_avatar/store';
import { captureMemoryAvatarAuthorization } from '../server/memory_avatar/lifecycle';
import { addScopedVoiceProfile, voiceProfileScope } from '../server/tts/profile_store';
import { addMessageIdempotent, getOrCreateActiveConversation } from '../server/conversation/manager';
import { generateSystemPrompt } from '../server/personality/engine';

let base = '';
let server: Awaited<ReturnType<typeof makeApp>>['server'];
let sequence = 0;
const uid = 'territory-owner';
async function request(path = '', method = 'GET', body?: any, user = uid) {
  const response = await fetch(`${base}/api/memory-avatars${path}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid: user, username: user, role: 'user' }, JWT_SECRET)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const create = (extra = {}) => request('', 'POST', { name: 'Synthetic companion', clientRequestId: `create-${++sequence}`, ...extra });
beforeAll(async () => {
  const app = await makeApp(); base = app.url; server = app.server;
  mountMemoryAvatarRoutes(app.apiRouter, LLM_GETTERS);
});
afterAll(async () => {
  await runSQL('PRAGMA query_only=OFF'); await flushDBOrThrow();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('creates a blank, fully usable tool-free personality without distillation', async () => {
  const result = await create({ personalityConfig: {} });
  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({ revision: 1, memoryCount: 0, isFrozen: true, appearance: { style: 'human3d' }, voice: {} });
  expect(result.body).not.toHaveProperty('userId');
  expect(result.body).not.toHaveProperty('payload');
  expect(result.body.personalityConfig.toolPolicy).toEqual({ allowedTools: [], requireConfirmation: [], forbiddenTools: ['*'], maxIterations: 0 });
  expect(generateSystemPrompt(result.body.personalityConfig, { mode: 'chat' })).toContain('Synthetic companion');
});

it('makes simultaneous create retries idempotent and rejects conflicting reuse', async () => {
  const body = { name: 'Idempotent', clientRequestId: `parallel-${++sequence}` };
  const [a, b] = await Promise.all([request('', 'POST', body), request('', 'POST', body)]);
  expect([a.status, b.status]).toEqual([201, 201]); expect(a.body.id).toBe(b.body.id);
  expect((await request('', 'POST', { ...body, name: 'Changed' })).status).toBe(409);
});

it('keeps materials private by owner and avatar, including the full later text', async () => {
  const a = (await create()).body;
  const b = (await create()).body;
  const text = 'Ordinary preface. '.repeat(700) + 'The unique violet observatory appointment is Thursday.';
  const added = await request(`/${a.id}/materials`, 'POST', { revision: a.revision, clientRequestId: 'material-private', title: 'Observatory', kind: 'document', text });
  expect(added.status).toBe(201);
  expect(added.body.avatar.revision).toBe(2);
  expect(added.body.material.memoryCount).toBeGreaterThan(1);
  expect((await request(`/${a.id}/materials`)).body.materials[0].text).toBe(text);
  expect(buildMemoryAvatarContext(uid, a.id, 'violet observatory Thursday', 1800).join('\n')).toContain('unique violet');
  expect(buildMemoryAvatarContext(uid, b.id, 'violet').join('\n')).not.toContain('unique violet');
  expect((await request(`/${a.id}/materials`, 'GET', undefined, 'other-owner')).status).toBe(404);
  expect((await request(`/${a.id}`, 'PATCH', { revision: 2, name: 'Stolen' }, 'other-owner')).status).toBe(404);
  expect((readDB().memories || []).filter((row: any) => row.agentId === a.id)).toHaveLength(0);
});

it('rejects stale changes and preserves source revision on title/appearance edits', async () => {
  const a = (await create()).body;
  const appearance = { ...a.appearance, preset: 'feminine', skinColor: '#123456' };
  const changed = await request(`/${a.id}`, 'PATCH', { revision: 1, name: 'Renamed', appearance });
  expect(changed.status).toBe(200); expect(changed.body.revision).toBe(2);
  expect((await request(`/${a.id}`, 'PATCH', { revision: 1, name: 'Stale' })).status).toBe(409);
  await closeDatabase(); await initDatabase();
  expect((await request(`/${a.id}`)).body).toMatchObject({ name: 'Renamed', revision: 2, appearance, personalityConfig: { name: 'Renamed' } });
  const clear = await request(`/${a.id}`, 'PATCH', { revision: 2, narrative: '' });
  expect(clear.status).toBe(200);
});

it('checks voice ownership and validates appearance before changing any fields', async () => {
  const a = (await create()).body;
  addScopedVoiceProfile(voiceProfileScope('other-owner', 'personal', ''), { voiceId: 'private-other-voice', name: 'Private', provider: 'cosyvoice' });
  expect((await request(`/${a.id}`, 'PATCH', { revision: 1, name: 'Not applied', voice: { voiceId: 'private-other-voice' } })).status).toBe(403);
  expect((await request(`/${a.id}`, 'PATCH', { revision: 1, name: 'Not applied', appearance: { ...a.appearance, skinColor: 'url(other)' } })).status).toBe(400);
  expect((await request(`/${a.id}`)).body).toMatchObject({ name: a.name, revision: 1 });
});

it('retries the same create after real SQLite write failure without making a second avatar', async () => {
  const body = { clientRequestId: `save-failure-${++sequence}`, name: 'Recoverable' };
  await flushDBOrThrow(); await runSQL('PRAGMA query_only=ON');
  try { expect((await request('', 'POST', body))).toMatchObject({ status: 503, body: { code: 'memory_avatar_save_failed' } }); }
  finally { await runSQL('PRAGMA query_only=OFF'); }
  const retried = await request('', 'POST', body);
  expect(retried.status).toBe(201);
  await closeDatabase(); await initDatabase();
  expect((await request()).body.avatars.filter((avatar: any) => avatar.name === 'Recoverable')).toHaveLength(1);
  expect((await request(`/${retried.body.id}`)).status).toBe(200);
});

it('retries append after SQLite failure, and retains complete data across reopen', async () => {
  const a = (await create()).body;
  const body = { revision: 1, clientRequestId: 'material-retry', title: 'Diary', text: 'A synthetic garden memory.', kind: 'text' };
  await runSQL('PRAGMA query_only=ON');
  try { expect((await request(`/${a.id}/materials`, 'POST', body)).status).toBe(503); }
  finally { await runSQL('PRAGMA query_only=OFF'); }
  expect((await request(`/${a.id}/materials`, 'POST', body)).status).toBe(201);
  await closeDatabase(); await initDatabase();
  expect((await request(`/${a.id}/materials`)).body).toMatchObject({ revision: 2, materials: [{ text: body.text, title: 'Diary' }] });
  expect((await request(`/${a.id}/materials`)).body.materials).toHaveLength(1);
});

it('keeps a live turn on append, but cancels old turns on exact-source removal', async () => {
  const a = (await create()).body;
  const guard = captureMemoryAvatarAuthorization(uid, a.id);
  const controller = new AbortController(); const release = guard.watch(controller);
  const added = await request(`/${a.id}/materials`, 'POST', { revision: 1, clientRequestId: 'remove-source', title: 'Private', kind: 'text', text: 'Unique source to remove.' });
  expect(guard.isCurrent()).toBe(true); expect(controller.signal.aborted).toBe(false);
  const removed = await request(`/${a.id}/materials/${added.body.material.id}`, 'DELETE', { revision: 2 });
  expect(removed.status).toBe(200); expect(controller.signal.aborted).toBe(true); expect(guard.isCurrent()).toBe(false);
  expect(buildMemoryAvatarContext(uid, a.id, 'Unique')).toEqual([]);
  expect(captureMemoryAvatarAuthorization(uid, a.id).isCurrent()).toBe(true);
  expect((await request(`/${a.id}/materials`, 'POST', { revision: 3, clientRequestId: 'remove-source', title: 'Private', kind: 'text', text: 'Unique source to remove.' })).status).toBe(409);
  release();
});

it('archives durably, cancels its live turn, and retains sources as an explicit archive', async () => {
  const a = (await create({ narrative: 'Archived biography' })).body;
  const guard = captureMemoryAvatarAuthorization(uid, a.id);
  const controller = new AbortController(); guard.watch(controller);
  expect((await request(`/${a.id}`, 'DELETE', { revision: 99 })).status).toBe(409);
  expect(controller.signal.aborted).toBe(false);
  expect((await request(`/${a.id}`, 'DELETE', { revision: 1 })).status).toBe(200);
  expect(controller.signal.aborted).toBe(true);
  expect((await request(`/${a.id}`)).status).toBe(404);
  expect((await request(`/${a.id}/history`)).status).toBe(404);
  expect((await request(`/${a.id}`, 'DELETE', { revision: 1 })).status).toBe(200);
  await closeDatabase(); await initDatabase();
  expect(getMemoryAvatar(uid, a.id)).toMatchObject({ status: 'archived', narrative: 'Archived biography' });
});


it('exposes stable history IDs for text and voice replay deduplication without raw media', async () => {
  const a = (await create()).body;
  const conversation = getOrCreateActiveConversation(uid, a.id, 'personal', '');
  const id = addMessageIdempotent({ userId: uid, agentId: a.id, conversationId: conversation.id, requestId: 'avatar-history-request',
    role: 'assistant', content: 'Synthetic persisted reply', domain: 'personal', orgId: '', source: 'memory-avatar', channel: 'chat' });
  await flushDBOrThrow();
  const history = await request(`/${a.id}/history`);
  expect(history.status).toBe(200);
  expect(history.body).toContainEqual(expect.objectContaining({ id, requestId: 'avatar-history-request', role: 'assistant', content: 'Synthetic persisted reply' }));
  expect(Object.keys(history.body[0]).sort()).toEqual(['content', 'id', 'requestId', 'role', 'timestamp']);
});
