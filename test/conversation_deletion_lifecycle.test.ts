import { makeApp, JWT_SECRET } from './helpers';
import { afterEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';

const fixture = vi.hoisted(() => ({ model: vi.fn(), extract: vi.fn(), beforeFlush: null as null | (() => Promise<void>), beforeDelete: null as null | (() => Promise<void>) }));
vi.mock('../server/llm/adapter', async original => ({
  ...await original<typeof import('../server/llm/adapter')>(), runWithTools: fixture.model,
}));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(), makeLLMCallStreaming: fixture.model, makeLLMCall: fixture.model,
}));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []), extractMemories: fixture.extract,
}));
vi.mock('../server/agents/rag', async original => ({
  ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []),
}));
vi.mock('../server/socket/chat_terminal_boundary', async original => {
  const actual = await original<typeof import('../server/socket/chat_terminal_boundary')>();
  return { ...actual, commitChatTerminalBoundary: (input: Parameters<typeof actual.commitChatTerminalBoundary>[0]) => actual.commitChatTerminalBoundary({
    ...input, flush: async () => {
      const wait = fixture.beforeFlush; fixture.beforeFlush = null;
      await wait?.(); await input.flush();
    },
  }) };
});
vi.mock('../server/tools/pending_confirmation', async original => {
  const actual = await original<typeof import('../server/tools/pending_confirmation')>();
  return { ...actual, revokePendingConfirmationChannelDurably: async (...args: Parameters<typeof actual.revokePendingConfirmationChannelDurably>) => {
    const count = await actual.revokePendingConfirmationChannelDurably(...args);
    const wait = fixture.beforeDelete; fixture.beforeDelete = null;
    await wait?.(); return count;
  } };
});

import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { getOrCreateActiveConversation, startIsolatedConversation } from '../server/conversation/manager';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { mountConversationRoutes } from '../server/routes/conversations';
import { mountInteractionsRoutes } from '../server/routes/interactions_routes';
import { waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';
import { readDB, flushDBOrThrow, querySQL, runSQL, closeDatabase, initDatabase } from '../db_layer';
import * as database from '../db_layer';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';

const marker = 'SYNTHETIC_ROUND8_DELETED_CONVERSATION_REPLY';
const outcome = (text = marker) => ({ text, toolCalls: [], usageRecords: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let io: Server;
let client: Socket;
let sequence = 0;
const unblock: Array<() => void> = [];
const inFlight: Promise<unknown>[] = [];
afterEach(async () => {
  for (const release of unblock.splice(0)) release();
  await Promise.allSettled(inFlight.splice(0));
  await runtimeBackgroundWork.waitForIdle();
  await runSQL('PRAGMA query_only=OFF');
  client?.close();
  if (io) await new Promise<void>(resolve => io.close(() => resolve()));
  await waitForChatExecutionPersistence();
  await flushDBOrThrow();
  fixture.beforeFlush = null;
  fixture.beforeDelete = null;
  vi.clearAllMocks();
});

async function openChat() {
  const app = await makeApp();
  mountConversationRoutes(app.apiRouter, JWT_SECRET);
  mountInteractionsRoutes(app.apiRouter, JWT_SECRET);
  const userId = `round8-delete-${++sequence}`;
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const token = jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
  if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);
  const entered = deferred();
  const gate = deferred();
  unblock.push(gate.resolve);
  fixture.model.mockImplementation(async (...args: any[]) => {
    if (args[2]?.source === 'chat_intent_classifier') return outcome('{"category":"question","confidence":0.99,"entities":{}}');
    entered.resolve();
    await gate.promise;
    return outcome();
  });
  fixture.extract.mockResolvedValue({ memories: [], reminders: [] });
  const finished = deferred();
  const errors: unknown[] = [];
  const emitted: Array<[string, any]> = [];
  io = new Server(app.server, { transports: ['websocket'] });
  io.on('connection', socket => {
    Object.assign(socket.data, { authenticatedUserId: userId, authenticatedRole: 'user', trustedLocalExecution: true });
    socket.join(`user:${userId}:personal`);
    socket.on('fixture:barrier', ack => ack());
    registerChatHandler(socket, {
      getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}),
      getQwen: () => ({}), getOllama: () => ({}), isOllamaAvailable: () => false,
      getLmStudio: () => ({}), isLmStudioAvailable: () => false, getRelay: () => ({}),
    }, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
    const handler = socket.listeners('agent:chat')[0];
    socket.off('agent:chat', handler);
    socket.on('agent:chat', (data, ack) => {
      inFlight.push(Promise.resolve(handler(data, ack)).catch(error => { errors.push(String(error)); }).finally(finished.resolve));
    });
  });
  client = createClient(app.url, { transports: ['websocket'], reconnection: false });
  client.onAny((event, data) => emitted.push([event, data]));
  await new Promise<void>(resolve => client.once('connect', resolve));
  const requestId = `round8-delete-request-${sequence}`;
  const send = () => client.timeout(5000).emitWithAck('agent:chat', {
    text: '请解释我们之前记录的项目安排。', history: [], agentId: 'lumi', userId,
    domain: 'personal', orgId: '', source: 'command-center-chat', conversationId, requestId,
  });
  const remove = (id = conversationId, authToken = token, domain = 'personal') => fetch(`${app.url}/api/conversations/${id}?domain=${domain}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
  });
  const drain = () => client.timeout(5000).emitWithAck('fixture:barrier');
  const history = () => fetch(`${app.url}/api/interactions?limit=80`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json());
  const recover = () => client.timeout(5000).emitWithAck('agent:execution_resume', { requestId, source: 'command-center-chat', domain: 'personal', conversationId });
  return { server: app.server, userId, conversationId, requestId, send, remove, drain, history, recover, entered, gate, emitted, finished, errors };
}

it('control: ordinary completed chat persists a reply and starts eligible memory extraction', async () => {
  const h = await openChat();
  await h.send();
  await h.entered.promise;
  h.gate.resolve();
  await h.finished.promise;
  await h.drain();
  await vi.waitFor(() => expect(h.emitted.some(([event, payload]) => event === 'agent:response' && payload.text?.includes(marker))).toBe(true));
  expect(h.errors).toEqual([]);
  expect(readDB().interactions.some(row => row.conversationId === h.conversationId && row.message.includes(marker))).toBe(true);
  expect(fixture.extract).toHaveBeenCalledOnce();
  expect((await querySQL('SELECT * FROM chat_execution_terminal_receipts WHERE conversationId = ?', [h.conversationId])).length).toBeGreaterThan(0);
  const removed = await h.remove();
  expect(removed.status).toBe(200);
  await flushDBOrThrow();
  expect(readDB().interactions.filter(row => row.conversationId === h.conversationId)).toHaveLength(0);
  expect(await querySQL('SELECT * FROM chat_execution_terminal_receipts WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
  expect((await h.recover()).ok).toBe(false);
});

it('deleting while a model is pending prevents late transcript, recovery receipt and memory extraction', async () => {
  const h = await openChat();
  await h.send();
  await h.entered.promise;
  expect(readDB().interactions.some(row => row.conversationId === h.conversationId)).toBe(true);
  const removed = await h.remove();
  const receipt = await removed.json();
  expect(removed.status).toBe(200);
  expect(receipt.success).toBe(true);
  await flushDBOrThrow();
  expect(readDB().conversations.some(row => row.id === h.conversationId)).toBe(false);
  expect(readDB().interactions.filter(row => row.conversationId === h.conversationId)).toHaveLength(0);
  h.gate.resolve();
  await h.finished.promise;
  await h.drain();
  await flushDBOrThrow();
  const orphanRows = readDB().interactions.filter(row => row.conversationId === h.conversationId);
  const diskRows = await querySQL('SELECT id, conversationId, role, message FROM interactions WHERE conversationId = ?', [h.conversationId]);
  const visibleHistory = await h.history();
  expect(h.errors).toEqual([]);
  expect(orphanRows).toHaveLength(0);
  expect(diskRows).toHaveLength(0);
  expect(visibleHistory.some((row: any) => row.conversationId === h.conversationId)).toBe(false);
  expect(fixture.extract).not.toHaveBeenCalled();
  expect(JSON.stringify(h.emitted)).not.toContain(marker);
  expect(await querySQL('SELECT * FROM chat_execution_terminal_receipts WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
  expect((await h.recover()).ok).toBe(false);
});

it('deletion during a staged terminal flush also prevents recovery and enrichment', async () => {
  const h = await openChat();
  const entered = deferred();
  const gate = deferred();
  unblock.push(gate.resolve);
  fixture.beforeFlush = async () => { entered.resolve(); await gate.promise; };
  await h.send(); h.gate.resolve();
  await entered.promise;
  expect(readDB().interactions.some(row => row.conversationId === h.conversationId && row.role === 'assistant')).toBe(true);
  expect((await h.remove()).status).toBe(200);
  gate.resolve();
  await h.finished.promise; await h.drain();
  await flushDBOrThrow();
  expect(h.errors).toEqual([]);
  expect(await querySQL('SELECT * FROM interactions WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
  expect(await querySQL('SELECT * FROM chat_execution_terminal_receipts WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
  expect(JSON.stringify(h.emitted)).not.toContain(marker);
  expect(fixture.extract).not.toHaveBeenCalled();
});

it('deletion waits for an in-flight recovery write and removes its private receipt before success', async () => {
  const h = await openChat();
  const entered = deferred(); const gate = deferred();
  unblock.push(gate.resolve);
  const originalRun = database.runSQL;
  let paused = false;
  const spy = vi.spyOn(database, 'runSQL').mockImplementation(async (sql, params) => {
    if (!paused && sql.includes('INSERT INTO chat_execution_terminal_receipts')) {
      paused = true; entered.resolve(); await gate.promise;
    }
    return originalRun(sql, params);
  });
  try {
    await h.send(); h.gate.resolve(); await entered.promise;
    let acknowledged = false;
    const deletion = h.remove().then(response => { acknowledged = true; return response; });
    await vi.waitFor(() => expect(readDB().conversations.some(row => row.id === h.conversationId)).toBe(false));
    expect(acknowledged).toBe(false);
    gate.resolve();
    expect((await deletion).status).toBe(200);
    await h.finished.promise; await h.drain();
    expect(h.errors).toEqual([]);
    expect(await querySQL('SELECT * FROM interactions WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
    expect(await querySQL('SELECT * FROM chat_execution_terminal_receipts WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
    expect(JSON.stringify(h.emitted)).not.toContain(marker);
    expect(fixture.extract).not.toHaveBeenCalled();
  } finally { gate.resolve(); spy.mockRestore(); }
});

it.each([false, true])('deletion blocks late enrichment writes, including corrections=%s', async correction => {
  const h = await openChat();
  const entered = deferred();
  const gate = deferred();
  unblock.push(gate.resolve);
  let signal: AbortSignal | undefined;
  fixture.extract.mockImplementation(async (context: any) => {
    signal = context.signal; entered.resolve(); await gate.promise;
    return { memories: [{ content: marker, type: 'fact', keywords: ['synthetic'], confidence: 0.9 }], reminders: [{ content: marker, dueAt: '2099-01-01T00:00:00.000Z' }] };
  });
  if (correction) {
    await client.timeout(5000).emitWithAck('agent:chat', { text: '不对，我们之前记录的项目安排是另一个日期。', history: [], agentId: 'lumi', domain: 'personal', orgId: '', source: 'command-center-chat', conversationId: h.conversationId, requestId: h.requestId });
  } else await h.send();
  h.gate.resolve(); await entered.promise;
  expect((await h.remove()).status).toBe(200);
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  gate.resolve();
  await h.finished.promise; await runtimeBackgroundWork.waitForIdle();
  await flushDBOrThrow();
  expect(h.errors).toEqual([]);
  expect(readDB().memories.some(row => row.content === marker)).toBe(false);
  expect(readDB().reminders.some(row => row.content === marker)).toBe(false);
  expect(await querySQL('SELECT * FROM interactions WHERE conversationId = ?', [h.conversationId])).toHaveLength(0);
});

it('failed deletion persistence is retryable and its confirmed result survives reopening the database', async () => {
  const h = await openChat();
  await flushDBOrThrow();
  fixture.beforeDelete = async () => { await runSQL('PRAGMA query_only=ON'); };
  const failed = await h.remove();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ code: 'CONVERSATION_DELETE_NOT_DURABLE', retryable: true });
  expect(readDB().conversations.some(row => row.id === h.conversationId)).toBe(false);
  expect(await querySQL('SELECT id FROM conversations WHERE id = ?', [h.conversationId])).toHaveLength(1);
  await runSQL('PRAGMA query_only=OFF');
  const retry = await h.remove();
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ success: true, replayed: true });
  expect(await querySQL('SELECT id FROM conversations WHERE id = ?', [h.conversationId])).toHaveLength(0);
  await closeDatabase(); await initDatabase();
  const reopenedRetry = await h.remove();
  expect(reopenedRetry.status).toBe(200);
  expect(await reopenedRetry.json()).toMatchObject({ success: true, replayed: true });
});

it('rechecks work membership after waiting for confirmation cleanup and the deletion queue', async () => {
  const h = await openChat();
  const org = createOrg('Synthetic deletion scope', `deletion-scope-${sequence}`, `deletion-owner-${sequence}`);
  addMember(org.id, h.userId, 'member');
  const first = getOrCreateActiveConversation(h.userId, 'lumi', 'work', org.id);
  const second = startIsolatedConversation(h.userId, 'lumi', 'work', org.id);
  const token = jwt.sign({ uid: h.userId, username: h.userId, role: 'user', orgId: org.id, orgRole: 'member' }, JWT_SECRET);
  const entered = deferred(); const gate = deferred(); const bothArrived = deferred();
  unblock.push(gate.resolve);
  let requests = 0;
  h.server.on('request', req => { if (req.method === 'DELETE' && ++requests === 2) bothArrived.resolve(); });
  fixture.beforeDelete = async () => { entered.resolve(); await gate.promise; };
  await flushDBOrThrow();
  const pendingFirst = h.remove(first.id, token, 'work');
  await entered.promise;
  const pendingSecond = h.remove(second.id, token, 'work');
  await bothArrived.promise;
  removeMember(org.id, h.userId);
  gate.resolve();
  expect((await pendingFirst).status).toBe(403);
  expect((await pendingSecond).status).toBe(403);
  expect(readDB().conversations.some(row => row.id === first.id)).toBe(true);
  expect(readDB().conversations.some(row => row.id === second.id)).toBe(true);
});
