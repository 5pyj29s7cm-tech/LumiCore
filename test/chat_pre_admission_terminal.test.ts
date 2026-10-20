import { makeApp } from './helpers';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';
const fixture = vi.hoisted(() => ({ model: vi.fn(), admission: vi.fn(), capturedContext: null as any, injectController: null as AbortController | null, beforeFlush: null as null | (() => void | Promise<void>) }));
vi.mock('../server/llm/adapter', async original => ({ ...await original<typeof import('../server/llm/adapter')>(), runWithTools: fixture.model }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: fixture.model, makeLLMCallStreaming: fixture.model }));
vi.mock('../server/socket/chat/phases/admit_chat_foreground_turn', async original => {
  const actual = await original<typeof import('../server/socket/chat/phases/admit_chat_foreground_turn')>();
  return { ...actual, admitChatForegroundTurn: (...args: Parameters<typeof actual.admitChatForegroundTurn>) => { fixture.admission(); return actual.admitChatForegroundTurn(...args); } };
});
vi.mock('../server/socket/chat/phases/prepare_chat_events', async original => {
  const actual = await original<typeof import('../server/socket/chat/phases/prepare_chat_events')>();
  return { ...actual, prepareChatEvents: async (...args: Parameters<typeof actual.prepareChatEvents>) => {
    const prepared = await actual.prepareChatEvents(...args);
    if (!prepared.terminal) {
      fixture.capturedContext = prepared.context;
      if (fixture.injectController) Object.assign(prepared.context, { abortController: fixture.injectController });
    }
    return prepared;
  } };
});
vi.mock('../server/socket/chat_terminal_boundary', async original => {
  const actual = await original<typeof import('../server/socket/chat_terminal_boundary')>();
  return { ...actual, commitChatTerminalBoundary: (input: Parameters<typeof actual.commitChatTerminalBoundary>[0]) => actual.commitChatTerminalBoundary({
    ...input, flush: async () => { const before = fixture.beforeFlush; fixture.beforeFlush = null; await before?.(); await input.flush(); },
  }) };
});
import { flushDBOrThrow, readDB } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, prepareConversationActionExecution, setConversationActionExecutionStatus, settleConversationActionExecutionRequest } from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { getConversationActionStateByTaskId } from '../server/conversation/ledger/queries';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { registerChatHandler } from '../server/socket/chat';
import { getChatExecution, waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';
import { getCurrentConversationExecution } from '../server/cognition/conversation_execution';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
let io: Server, client: Socket, http: any;
const inFlight: Promise<unknown>[] = [];
afterEach(async () => {
  await Promise.allSettled(inFlight.splice(0)); client?.close();
  if (io) await new Promise<void>(resolve => io.close(() => resolve()));
  if (http?.listening) await new Promise<void>(resolve => http.close(() => resolve()));
  await waitForChatExecutionPersistence(); fixture.beforeFlush = null; fixture.injectController = null; fixture.capturedContext = null; vi.clearAllMocks();
});
async function open() {
  const app = await makeApp(); http = app.server;
  const suffix = randomUUID(), userId = 'pre-admission-member-' + suffix;
  const org = createOrg('Synthetic sidecar organization', 'sidecar-' + suffix, 'sidecar-owner-' + suffix); addMember(org.id, userId, 'member');
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'work', org.id).id;
  const seedRequestId = 'pre-admission-seed-' + suffix, userText = 'Read a synthetic unavailable file and retain the pending operation.';
  const userMessageId = addMessageIdempotent({ userId, conversationId, requestId: seedRequestId, role: 'user', agentId: 'lumi', content: userText, domain: 'work', orgId: org.id, deferActionPreparation: true });
  await flushDBOrThrow();
  const prepared = prepareConversationActionExecution({ userId, conversationId, requestId: seedRequestId, userMessageId, userText, forceTask: true, toolPolicy: { allowedTools: ['read_file'], forbiddenTools: [], requireConfirmation: [], maxIterations: 1 } });
  if ('bindingFailure' in prepared || !prepared.state) throw Error('Synthetic waiting task preparation failed');
  const taskId = prepared.state.taskId;
  setConversationActionExecutionStatus(conversationId, userId, 'waiting_confirmation', { requestId: seedRequestId, assistantState: 'Synthetic operation awaits confirmation.' });
  settleConversationActionExecutionRequest(conversationId, userId, seedRequestId);
  await flushDBOrThrow();
  expect(getConversationActionStateByTaskId(readDB(), { userId, conversationId, taskId })).toMatchObject({ taskId, status: 'waiting_confirmation', unfinished: true });
  const scope = { userId, domain: 'work' as const, orgId: org.id, source: 'command-center-chat', conversationId };
  expect(getCurrentConversationExecution(scope)).toBeFalsy();
  if (!toolRegistry.get('runtime_work_status')) registerAllTools(toolRegistry);
  fixture.model.mockImplementation(() => { throw Error('A pre-admission sidecar must not call any model'); });
  const events: Array<[string, any]> = [], errors: unknown[] = [], done = new Map<string, () => void>();
  io = new Server(app.server, { transports: ['websocket'] });
  io.on('connection', socket => {
    Object.assign(socket.data, { authenticatedUserId: userId, authenticatedRole: 'user', authenticatedOrgId: org.id, authenticatedOrgRole: 'member', trustedLocalExecution: true });
    socket.join('user:' + userId + ':org:' + org.id); socket.on('fixture:barrier', ack => ack());
    registerChatHandler(socket, { getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}), getQwen: () => ({}), getOllama: () => ({}), isOllamaAvailable: () => false, getLmStudio: () => ({}), isLmStudioAvailable: () => false, getRelay: () => ({}) }, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
    const handler = socket.listeners('agent:chat')[0]; socket.off('agent:chat', handler);
    socket.on('agent:chat', (data, ack) => { const completion = Promise.resolve(handler(data, ack)).catch(error => { errors.push(error); }).finally(() => done.get(data.requestId)?.()); inFlight.push(completion); });
  });
  client = createClient(app.url, { transports: ['websocket'], reconnection: false }); client.onAny((event, value) => events.push([event, value]));
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  async function send(text: string) {
    const requestId = 'pre-admission-control-' + randomUUID(); let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; }); done.set(requestId, finish);
    const ack = await client.timeout(5000).emitWithAck('agent:chat', { ...scope, agentId: 'lumi', text, history: [], requestId });
    expect(ack).toMatchObject({ ok: true, requestId }); await finished; await client.timeout(5000).emitWithAck('fixture:barrier'); await waitForChatExecutionPersistence();
    const terminal = events.filter(([event, value]) => event === 'agent:response' && value.requestId === requestId);
    expect(terminal).toHaveLength(1); expect(errors).toEqual([]); expect(fixture.model).not.toHaveBeenCalled(); expect(fixture.admission).not.toHaveBeenCalled();
    expect(fixture.capturedContext.isChatCancelled).toBeUndefined(); // Prove this never reached admission's callback installation.
    expect(terminal[0][1].reason).not.toBe('persistence_unknown');
    const messages = readDB().interactions.filter((row: any) => row.userId === userId && row.conversationId === conversationId && row.requestId === requestId && row.role === 'assistant');
    expect(messages).toHaveLength(1); expect(messages[0].message || messages[0].content).toBe(terminal[0][1].text);
    const actionTurn = getConversationActionTurn({ userId, conversationId, requestId });
    expect(actionTurn?.taskId || '').toBe(''); expect(actionTurn?.status).not.toBe('persistence_unknown');
    expect(getChatExecution(scope, requestId)).toMatchObject({ terminal: true, sidecar: true });
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === userId)).toHaveLength(1);
    return { requestId, payload: terminal[0][1], actionTurn };
  }
  return { send, taskId, scope, org, userId, conversationId };
}
it('durably cancels a waiting task through the actual Socket.IO pre-admission sidecar', async () => {
  const h = await open(), result = await h.send('取消');
  expect(result.payload).toMatchObject({ finalized: true, blocked: false, reason: 'cancelled_by_user' });
  expect(getConversationActionStateByTaskId(readDB(), { userId: h.userId, conversationId: h.conversationId, taskId: h.taskId })).toMatchObject({ status: 'cancelled', unfinished: false });
  expect(getChatExecution(h.scope, result.requestId)).toMatchObject({ terminal: true, status: 'completed', sidecar: true });
});
it.each(['后台正在执行什么任务？', '现在有哪些正在运行的Lumi任务？只查询状态，不取消、不暂停、不重试。'])('durably answers runtime status without admission or changing the waiting task: %s', async text => {
  const h = await open(), before = JSON.stringify(readDB().conversationActionTasks.find((row: any) => row.id === h.taskId));
  const result = await h.send(text);
  expect(result.payload).toMatchObject({ finalized: true, reason: 'runtime_work_status' });
  expect(JSON.stringify(readDB().conversationActionTasks.find((row: any) => row.id === h.taskId))).toBe(before);
  expect(getChatExecution(h.scope, result.requestId)).toMatchObject({ terminal: true, status: 'completed', sidecar: true });
});
it('revoked authorization at the real status terminal flush cannot publish an old sidecar result', async () => {
  const h = await open(); fixture.beforeFlush = () => { removeMember(h.org.id, h.userId); };
  const result = await h.send('后台正在执行什么任务？');
  expect(result.payload).toMatchObject({ finalized: true, reason: 'cancelled' });
  expect(result.payload).not.toHaveProperty('taskRelation');
  expect(getChatExecution(h.scope, result.requestId)).toMatchObject({ terminal: true, status: 'cancelled' });
  expect(getConversationActionStateByTaskId(readDB(), { userId: h.userId, conversationId: h.conversationId, taskId: h.taskId })).toMatchObject({ status: 'waiting_confirmation', unfinished: true });
});
it('an AbortSignal acquired before admission is still honored at the exact status terminal flush', async () => {
  const h = await open(), controller = new AbortController(); fixture.injectController = controller;
  fixture.beforeFlush = () => { controller.abort(new DOMException('Synthetic sidecar cancellation', 'AbortError')); };
  const result = await h.send('后台正在执行什么任务？');
  expect(result.payload).toMatchObject({ finalized: true, reason: 'cancelled' });
  expect(result.payload).not.toHaveProperty('taskRelation');
  expect(getChatExecution(h.scope, result.requestId)).toMatchObject({ terminal: true, status: 'cancelled' });
  expect(getConversationActionStateByTaskId(readDB(), { userId: h.userId, conversationId: h.conversationId, taskId: h.taskId })).toMatchObject({ status: 'waiting_confirmation', unfinished: true });
});
