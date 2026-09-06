import './helpers';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({ invoke: vi.fn(), release: null as (() => void) | null }));
vi.mock('../server/llm/adapter', async original => ({ ...await original<typeof import('../server/llm/adapter')>(), runWithTools: model.invoke }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: model.invoke, makeLLMCallStreaming: model.invoke }));
vi.mock('../server/memory', async original => ({ ...await original<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []), extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
}));
vi.mock('../server/agents/rag', async original => ({ ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []) }));
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { initSocketRuntime } from '../server/runtime/socket';
import { mountOrgRoutes } from '../server/org/routes';
import { mountConversationRoutes } from '../server/routes/conversations';
import { createOrg, addMember, updateMemberRole } from '../server/org/db';
import { addMessage, getOrCreateActiveConversation } from '../server/conversation/manager';
import { beginChatExecution, getChatExecution, recordChatExecutionTerminalEventDurably, waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';
import { flushDBOrThrow } from '../db_layer';

let app: Awaited<ReturnType<typeof makeApp>>;
let io: Server;
const clients: Socket[] = [];
beforeAll(async () => {
  app = await makeApp();
  mountOrgRoutes(app.apiRouter);
  mountConversationRoutes(app.apiRouter, JWT_SECRET);
  io = new Server(app.server, { transports: ['websocket'] });
  const getter = () => ({});
  initSocketRuntime({ io, jwtSecret: JWT_SECRET, llm: {
    getDeepSeek: getter, getGemini: getter, getOpenAI: getter, getAnthropic: getter,
    getQwen: getter, getArk: getter, getOllama: getter, getLmStudio: getter,
    getXiaomi: getter, getKimi: getter, getGlm: getter, getRelay: getter,
    isOllamaAvailable: () => false, isLmStudioAvailable: () => false,
  } });
  const localFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input));
    if (url.origin !== app.url) throw new Error('Audit prohibits external network');
    return localFetch(input, init);
  });
});
afterAll(async () => {
  model.release?.();
  for (const client of clients) client.disconnect();
  await new Promise<void>(resolve => io.close(() => resolve()));
  vi.unstubAllGlobals();
  await waitForChatExecutionPersistence();
});
function event(client: Socket, name: string, payload: unknown) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 5000);
    client.once(name, value => { clearTimeout(timer); resolve(value); });
    client.emit(name, payload);
  });
}
async function fixture() {
  const uid = `audit10-member-${randomUUID()}`;
  const owner = `audit10-owner-${randomUUID()}`;
  const orgId = createOrg('Synthetic audit organization', randomUUID(), owner).id;
  addMember(orgId, owner, 'owner'); addMember(orgId, uid, 'member');
  const token = jwt.sign({ uid, orgId, role: 'user' }, JWT_SECRET);
  const client = connect(app.url, { transports: ['websocket'], auth: { token } });
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  const work = getOrCreateActiveConversation(uid, 'lumi', 'work', orgId);
  const personal = getOrCreateActiveConversation(uid, 'lumi', 'personal', '');
  const other = getOrCreateActiveConversation(`other-${uid}`, 'lumi', 'work', orgId);
  const write = (conversation: typeof work, content: string) => addMessage({
    userId: conversation.userId, agentId: 'lumi', conversationId: conversation.id,
    domain: conversation.domain, orgId: conversation.orgId, role: 'assistant', content,
  });
  write(work, 'SYNTHETIC_WORK_HISTORY'); write(personal, 'SYNTHETIC_PERSONAL_HISTORY'); write(other, 'SYNTHETIC_OTHER_USER');
  await flushDBOrThrow();
  const remove = async () => {
    const response = await fetch(`${app.url}/api/org/org/${orgId}/members/${uid}`, { method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt.sign({ uid: owner, orgId, role: 'user' }, JWT_SECRET)}` } });
    expect(response.status).toBe(200);
    expect((await fetch(`${app.url}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
  };
  return { uid, orgId, token, client, work, personal, other, remove, write };
}

it('normal work history is readable but excludes another user and the same users personal conversation', async () => {
  const f = await fixture();
  expect(JSON.stringify(await event(f.client, 'chat:messages', { conversationId: f.work.id }))).toContain('SYNTHETIC_WORK_HISTORY');
  expect((await event(f.client, 'chat:messages', { conversationId: f.other.id })).messages).toEqual([]);
  expect((await event(f.client, 'chat:messages', { conversationId: f.personal.id })).messages).toEqual([]);
  const scope = { userId: f.uid, domain: 'work' as const, orgId: f.orgId, source: 'chat', conversationId: f.work.id };
  const requestId = randomUUID();
  beginChatExecution(scope, requestId);
  await recordChatExecutionTerminalEventDurably(scope, requestId, 'agent:response', { text: 'SYNTHETIC_WORK_RECOVERY', finalized: true });
  expect((await f.client.timeout(5000).emitWithAck('agent:execution_resume', { ...scope, requestId })).snapshot.terminalEvent.payload.text).toBe('SYNTHETIC_WORK_RECOVERY');
  updateMemberRole(f.orgId, f.uid, 'viewer');
  expect(JSON.stringify(await event(f.client, 'chat:messages', { conversationId: f.work.id }))).toContain('SYNTHETIC_WORK_HISTORY');
});

it('revocation denies newly persisted organization history on the original connected socket', async () => {
  const f = await fixture();
  await f.remove();
  f.write(f.work, 'SYNTHETIC_WRITTEN_AFTER_REVOCATION');
  await flushDBOrThrow();
  expect(f.client.connected).toBe(true);
  const messages = await event(f.client, 'chat:messages', { conversationId: f.work.id });
  const list = await event(f.client, 'chat:conversations', {});
  expect(messages.messages).toEqual([]);
  expect(messages.error).toBeTruthy();
  expect(list.conversations).toEqual([]);
  expect((await event(f.client, 'chat:messages', { conversationId: f.other.id })).messages).toEqual([]);
});

it('a revoked work credential cannot recover a personal execution or replay its terminal event', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const scope = { userId: f.uid, domain: 'personal' as const, orgId: '', source: 'chat', conversationId: f.personal.id };
  beginChatExecution(scope, requestId);
  await recordChatExecutionTerminalEventDurably(scope, requestId, 'agent:response', {
    text: 'SYNTHETIC_PRIVATE_RECOVERY', finalized: true, blocked: false,
  });
  const request = { requestId, source: 'chat', domain: 'work', orgId: f.orgId, conversationId: f.personal.id };
  expect((await f.client.timeout(5000).emitWithAck('agent:execution_resume', request)).ok).toBe(false);
  await f.remove();
  const replays: unknown[] = [];
  f.client.on('agent:response', data => replays.push(data));
  const resumed = await f.client.timeout(5000).emitWithAck('agent:execution_resume', request);
  expect(resumed.ok).toBe(false);
  expect(resumed.snapshot).toBeUndefined();
  const abort = await f.client.timeout(5000).emitWithAck('agent:abort_chat', request);
  expect(abort.ok).toBe(false);
  const before = model.invoke.mock.calls.length;
  const denied = await f.client.timeout(5000).emitWithAck('agent:chat', { text: 'Explain the synthetic plan', requestId: randomUUID(), conversationId: f.work.id });
  expect(denied).toMatchObject({ ok: false, error: 'Workspace access is unavailable.' });
  expect(model.invoke.mock.calls).toHaveLength(before);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(replays).toEqual([]);
  const personalClient = connect(app.url, { transports: ['websocket'], auth: { token: jwt.sign({ uid: f.uid, role: 'user' }, JWT_SECRET) } });
  clients.push(personalClient);
  await new Promise<void>((resolve, reject) => { personalClient.once('connect', resolve); personalClient.once('connect_error', reject); });
  const authorized = await personalClient.timeout(5000).emitWithAck('agent:execution_resume', request);
  expect(authorized.ok).toBe(true);
  expect(authorized.snapshot.terminalEvent.payload.text).toBe('SYNTHETIC_PRIVATE_RECOVERY');
});

it('a revoked work socket may stop its exact old owner and rejects an unknown request', async () => {
  const f = await fixture();
  const serverSocket = io.sockets.sockets.get(f.client.id!)!;
  // The native admission boundary is synthetic; JWT/member/Socket handling and
  // the foreground execution owner are real. No external tools are registered.
  serverSocket.data.trustedLocalExecution = true;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { model.release = resolve; });
  model.invoke.mockImplementation(async (...args: any[]) => {
    if (args[2]?.source === 'chat_intent_classifier') return { text: '{"category":"question","confidence":0.99,"entities":{}}', toolCalls: [] };
    entered(); await gate;
    return { text: 'Synthetic late response', toolCalls: [], usageRecords: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const requestId = randomUUID();
  const scope = { userId: f.uid, domain: 'work' as const, orgId: f.orgId, source: 'command-center-chat', conversationId: f.work.id };
  const ack = await f.client.timeout(5000).emitWithAck('agent:chat', { ...scope, requestId, text: '请解释一下这个合成项目的安排。' });
  expect(ack.ok).toBe(true);
  await started;
  try {
    await f.remove();
    const stopped = await f.client.timeout(5000).emitWithAck('agent:abort_chat', { ...scope, requestId });
    expect(stopped).toMatchObject({ ok: true, requestId, status: 'cancelling' });
    const wrong = await f.client.timeout(5000).emitWithAck('agent:abort_chat', { ...scope, requestId: randomUUID() });
    expect(wrong.ok).toBe(false);
    expect(getChatExecution(scope, requestId)?.terminal).toBe(false);
  } finally { model.release?.(); }
  await vi.waitFor(() => expect(getChatExecution(scope, requestId)?.terminal).toBe(true), { timeout: 5000 });
  await waitForChatExecutionPersistence();
});
