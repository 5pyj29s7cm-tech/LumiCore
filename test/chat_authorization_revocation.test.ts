import { makeApp } from './helpers';
import { afterEach, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({ model: vi.fn(), retrieval: vi.fn() }));
vi.mock('../server/llm/adapter', async original => ({
  ...await original<typeof import('../server/llm/adapter')>(), runWithTools: mocks.model,
}));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(), makeLLMCallStreaming: mocks.model, makeLLMCall: mocks.model,
}));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: mocks.retrieval,
  extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
}));
vi.mock('../server/agents/rag', async original => ({
  ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []),
}));

import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { createOrg, addMember, removeMember, updateMemberRole } from '../server/org/db';
import { getChatExecution, waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';

const marker = 'SYNTHETIC_ORG_MEMORY_TEST';
const outcome = () => ({ text: `A synthetic response ${marker}`, toolCalls: [], usageRecords: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let io: Server;
let client: Socket;
let sequence = 0;
afterEach(async () => {
  client?.close();
  if (io) await new Promise<void>(resolve => io.close(() => resolve()));
  await waitForChatExecutionPersistence();
  vi.clearAllMocks();
});

async function openChat() {
  const app = await makeApp();
  const suffix = String(++sequence);
  const userId = `chat-auth-member-${suffix}`;
  const org = createOrg('Synthetic chat auth org', `chat-auth-org-${suffix}`, `chat-auth-owner-${suffix}`);
  addMember(org.id, userId, 'member');
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'work', org.id).id;
  if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);
  mocks.retrieval.mockImplementation(async () => []);
  mocks.model.mockImplementation(async () => outcome());
  io = new Server(app.server, { transports: ['websocket'] });
  io.on('connection', socket => {
    Object.assign(socket.data, { authenticatedUserId: userId, authenticatedRole: 'user', authenticatedOrgId: org.id, authenticatedOrgRole: 'member', trustedLocalExecution: true });
    socket.join(`user:${userId}:org:${org.id}`);
    registerChatHandler(socket, {
      getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}),
      getQwen: () => ({}), getOllama: () => ({}), isOllamaAvailable: () => false,
      getLmStudio: () => ({}), isLmStudioAvailable: () => false, getRelay: () => ({}),
    }, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
  });
  client = createClient(app.url, { transports: ['websocket'], reconnection: false });
  await new Promise<void>(resolve => client.once('connect', resolve));
  const scope = { userId, domain: 'work' as const, orgId: org.id, source: 'command-center-chat', conversationId };
  const send = (requestId: string) => client.timeout(5000).emitWithAck('agent:chat', {
    text: '请解释我们之前记录的项目安排。', history: [], agentId: 'lumi', ...scope, requestId,
  });
  const terminal = (requestId: string) => new Promise<any>(resolve => {
    const listener = (data: any) => {
      if (data.requestId !== requestId) return;
      client.off('agent:response', listener);
      resolve(data);
    };
    client.on('agent:response', listener);
  });
  return { userId, org, scope, send, terminal };
}

it.each(['remove', 'remove-rejoin', 'downgrade'])('cancels retrieval and suppresses old work content after %s', async change => {
  const h = await openChat();
  const started = deferred();
  const gate = deferred();
  let signal: AbortSignal | undefined;
  mocks.retrieval.mockImplementation(async (options: any) => {
    signal = options.signal;
    started.resolve();
    await gate.promise;
    return [{ id: 'test-memory', type: 'semantic', content: marker, confidence: 1, importance: 1, keywords: '[]' }];
  });
  const requestId = `chat-auth-${change}`;
  const response = h.terminal(requestId);
  await h.send(requestId);
  await started.promise;
  if (change === 'downgrade') updateMemberRole(h.org.id, h.userId, 'viewer');
  else {
    removeMember(h.org.id, h.userId);
    if (change === 'remove-rejoin') addMember(h.org.id, h.userId, 'member');
  }
  try {
    const result = await response;
    expect(result.reason).toBe('cancelled');
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(signal?.aborted).toBe(true);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(getChatExecution(h.scope, requestId)).toMatchObject({ terminal: true, status: 'cancelled' });
  } finally { gate.resolve(); }
}, 10000);

it('preserves a normally authorized organization reply', async () => {
  const h = await openChat();
  const response = h.terminal('chat-auth-normal');
  await h.send('chat-auth-normal');
  expect((await response).text).toContain(marker);
  expect(mocks.model).toHaveBeenCalledTimes(1);
});

it('aborts an active model but waits for its actual return before publishing the cancellation', async () => {
  const h = await openChat();
  const started = deferred();
  const gate = deferred();
  let signal: AbortSignal | undefined;
  mocks.model.mockImplementation(async (...args: any[]) => {
    signal = args[2]?.signal;
    started.resolve();
    await gate.promise;
    return outcome();
  });
  const response = h.terminal('chat-auth-running');
  await h.send('chat-auth-running');
  await started.promise;
  removeMember(h.org.id, h.userId);
  try {
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(getChatExecution(h.scope, 'chat-auth-running')?.terminal).toBe(false);
  } finally { gate.resolve(); }
  const result = await response;
  expect(result.reason).toBe('cancelled');
  expect(JSON.stringify(result)).not.toContain(marker);
});

it('cancels a queued request on removal without starting a second model', async () => {
  const h = await openChat();
  const started = deferred();
  const gate = deferred();
  let signal: AbortSignal | undefined;
  mocks.model.mockImplementation(async (...args: any[]) => { signal = args[2]?.signal; started.resolve(); await gate.promise; return outcome(); });
  const first = h.terminal('chat-auth-first');
  await h.send('chat-auth-first');
  await started.promise;
  const second = h.terminal('chat-auth-queued');
  await h.send('chat-auth-queued');
  removeMember(h.org.id, h.userId);
  try {
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(mocks.model).toHaveBeenCalledTimes(1);
  } finally { gate.resolve(); }
  expect((await first).reason).toBe('cancelled');
  expect((await second).reason).toBe('cancelled');
  expect(mocks.model).toHaveBeenCalledTimes(1);
}, 10000);
