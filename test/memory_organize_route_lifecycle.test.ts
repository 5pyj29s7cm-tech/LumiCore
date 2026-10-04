import './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: bridge.model }));
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { mountMemoryRoutes } from '../server/routes/memory_routes';
import { addMemory } from '../server/memory/store';
import { readDB } from '../db_layer';
import * as OrgDB from '../server/org/db';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); mountMemoryRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS); });
afterAll(() => app.cleanup());
function seed(userId: string, domain: 'personal' | 'work' = 'personal', orgId = '') {
  return [1, 2, 3].map(n => addMemory({ userId, type: 'fact', content: 'Organization fixture '+n, keywords: [], confidence: 1,
    sourceInteractionId: 'manual' }, { domain, orgId, deduplicate: false, generateEmbedding: false, source: 'manual', userApproved: true }));
}
function request(userId: string, orgId = '') {
  return fetch(app.url+'/api/memory/auto-organize', { method: 'POST', headers: { Authorization: 'Bearer '+jwt.sign({ uid: userId, ...(orgId ? { orgId } : {}) }, JWT_SECRET) } });
}
function deferredReply() {
  let release!: (value: any) => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  bridge.model.mockImplementationOnce(async (_messages, _tools, config) => { expect(config.signal).toBeInstanceOf(AbortSignal); entered(); return new Promise(resolve => { release = resolve; }); });
  return { ready, reply: (ids: string[]) => release({ text: JSON.stringify({ branches: [{ title: 'Current topics', memoryIds: ids }] }) }) };
}
describe('REST uses the shared bounded memory organizer', () => {
  it('rereads edited candidates and ignores IDs that were not in the accepted plan', async () => {
    const uid = 'rest-organize-unchanged', memories = seed(uid);
    const unrelated = seed(uid+'-foreign')[0];
    const held = deferredReply(), response = request(uid); await held.ready;
    readDB().memories.find(row => row.id === memories[1].id).content = 'Edited while planning';
    held.reply([memories[0].id, memories[0].id, memories[1].id, unrelated.id]);
    const result = await response; expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ success: true, branchesCreated: 1, memoriesAssigned: 1 });
    expect(readDB().memories.find(row => row.id === memories[1].id).parentId).toBeNull();
    expect(readDB().memories.find(row => row.id === unrelated.id).parentId).toBeNull();
  });
  it('does not apply a late work-scope plan after active membership is revoked', async () => {
    const uid = 'rest-organize-revoked', org = OrgDB.createOrg('Synthetic organizer', 'rest-organize-revoked', uid);
    OrgDB.addMember(org.id, uid, 'owner');
    const memories = seed(uid, 'work', org.id), held = deferredReply(), response = request(uid, org.id); await held.ready;
    OrgDB.setMemberStatus(org.id, uid, 'suspended'); held.reply(memories.map(row => row.id));
    expect((await response).status).toBe(403);
    const current = readDB().memories.filter(row => row.userId === uid);
    expect(current).toHaveLength(3); expect(current.every(row => !row.parentId)).toBe(true);
  });
  it('keeps invalid-model JSON as an unsuccessful response and creates no branch', async () => {
    const uid = 'rest-organize-invalid'; seed(uid); bridge.model.mockResolvedValueOnce({ text: 'invalid JSON' });
    const result = await request(uid); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ success: false, reason: 'LLM returned invalid JSON' });
    expect(readDB().memories.filter(row => row.userId === uid)).toHaveLength(3);
  });
});
