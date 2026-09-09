import { makeApp } from './helpers';
import { afterEach, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';

const fixture = vi.hoisted(() => ({
  model: vi.fn(),
  memoryPlan: vi.fn(),
  beforeTerminalFlush: null as null | (() => Promise<void>),
  beforeRelease: null as null | (() => Promise<void>),
  beforeSidecarPersistenceReturn: null as null | (() => Promise<void>),
}));
vi.mock('../server/llm/adapter', async original => ({
  ...await original<typeof import('../server/llm/adapter')>(), runWithTools: fixture.model,
}));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(), makeLLMCallStreaming: fixture.model, makeLLMCall: fixture.model,
}));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []),
}));
vi.mock('../server/agents/rag', async original => ({
  ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []),
}));
vi.mock('../server/socket/chat_terminal_boundary', async original => {
  const actual = await original<typeof import('../server/socket/chat_terminal_boundary')>();
  return {
    ...actual,
    commitChatTerminalBoundary: (input: Parameters<typeof actual.commitChatTerminalBoundary>[0]) => actual.commitChatTerminalBoundary({
      ...input,
      flush: async () => {
        const wait = fixture.beforeTerminalFlush;
        fixture.beforeTerminalFlush = null;
        await wait?.();
        await input.flush();
      },
    }),
  };
});
vi.mock('../server/conversation/manager', async original => {
  const actual = await original<typeof import('../server/conversation/manager')>();
  return {
    ...actual,
    createDurableForegroundReleaseGate: (input: Parameters<typeof actual.createDurableForegroundReleaseGate>[0]) => actual.createDurableForegroundReleaseGate({
      ...input,
      converge: async reason => {
        const converged = await input.converge(reason);
        const wait = fixture.beforeRelease;
        fixture.beforeRelease = null;
        await wait?.();
        return converged;
      },
    }),
  };
});
vi.mock('../server/socket/chat_execution_registry', async original => {
  const actual = await original<typeof import('../server/socket/chat_execution_registry')>();
  return {
    ...actual,
    persistChatSidecarCancellationIntent: async (...args: Parameters<typeof actual.persistChatSidecarCancellationIntent>) => {
      await actual.persistChatSidecarCancellationIntent(...args);
      const wait = fixture.beforeSidecarPersistenceReturn;
      fixture.beforeSidecarPersistenceReturn = null;
      await wait?.();
    },
  };
});

import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { getChatExecution, waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { INTENT_CLASSIFIER_MAX_TOKENS, INTENT_CLASSIFIER_TIMEOUT_MS } from '../server/cognition/intent_classifier';

const marker = 'SYNTHETIC_ORG_TERMINAL_CONTENT';
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
  client?.close();
  if (io) await new Promise<void>(resolve => io.close(() => resolve()));
  await waitForChatExecutionPersistence();
  fixture.beforeTerminalFlush = null;
  fixture.beforeRelease = null;
  fixture.beforeSidecarPersistenceReturn = null;
  vi.clearAllMocks();
});

async function openChat(withTask: boolean) {
  const app = await makeApp();
  const suffix = String(++sequence);
  const userId = `chat-terminal-member-${suffix}`;
  const org = createOrg('Synthetic terminal org', `chat-terminal-org-${suffix}`, `chat-terminal-owner-${suffix}`);
  addMember(org.id, userId, 'member');
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'work', org.id).id;
  if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);
  fixture.model.mockImplementation(async (...args: any[]) => {
    if (args[2]?.source === 'memory_turn') return outcome(JSON.stringify(await fixture.memoryPlan(args[2])));
    if (args[2]?.source === 'chat_intent_classifier') return outcome('{"category":"question","confidence":0.99,"entities":{}}');
    if (!withTask) return outcome();
    const context = args[11];
    expect(context?.taskId).toBeTruthy();
    return { ...outcome(), toolCalls: [{
      name: 'read_file', arguments: { path: 'synthetic-project.txt' },
      result: JSON.stringify({ content: marker }), adapterStarted: true,
      id: 'synthetic-read', taskId: context.taskId, requestId: context.requestId, turnId: context.requestId,
      executionOrigin: 'model_selected', outcome: 'success',
      evidence: { capability: 'file', operation: 'observe', assurance: 'observed', scope: ['synthetic-project.txt'] },
      terminalVerification: { status: 'verified' },
      envelope: { status: 'verified_success', toolName: 'read_file', requestId: context.requestId,
        targetIdentity: 'synthetic-project.txt', result: { content: marker }, verification: { status: 'verified' } },
    }] };
  });
  fixture.memoryPlan.mockResolvedValue({ changes: [] });
  const finished = deferred();
  const completions = new Map<string, ReturnType<typeof deferred>>();
  const completionFor = (id: string) => {
    let completion = completions.get(id);
    if (!completion) { completion = deferred(); completions.set(id, completion); }
    return completion;
  };
  const acknowledgements: Array<{ requestId: string; payload: any }> = [];
  const errors: unknown[] = [];
  const emitted: Array<[string, any]> = [];
  io = new Server(app.server, { transports: ['websocket'] });
  io.on('connection', socket => {
    Object.assign(socket.data, { authenticatedUserId: userId, authenticatedRole: 'user', authenticatedOrgId: org.id, authenticatedOrgRole: 'member', trustedLocalExecution: true });
    socket.join(`user:${userId}:org:${org.id}`);
    socket.on('fixture:barrier', ack => ack());
    registerChatHandler(socket, {
      getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}),
      getQwen: () => ({}), getOllama: () => ({}), isOllamaAvailable: () => false,
      getLmStudio: () => ({}), isLmStudioAvailable: () => false, getRelay: () => ({}),
    }, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
    const handler = socket.listeners('agent:chat')[0];
    socket.off('agent:chat', handler);
    socket.on('agent:chat', (data, ack) => {
      const trackedAck = (payload: any) => { acknowledgements.push({ requestId: data.requestId, payload }); ack?.(payload); };
      const completion = Promise.resolve(handler(data, trackedAck)).catch(error => { errors.push(error); }).finally(() => {
        completionFor(data.requestId).resolve();
        finished.resolve();
      });
      inFlight.push(completion);
    });
  });
  client = createClient(app.url, { transports: ['websocket'], reconnection: false });
  client.onAny((event, data) => emitted.push([event, data]));
  await new Promise<void>(resolve => client.once('connect', resolve));
  const requestId = `terminal-request-${suffix}`;
  const scope = { userId, domain: 'work' as const, orgId: org.id, source: 'command-center-chat', conversationId };
  const send = (id = requestId, text = withTask ? '请读取 synthetic-project.txt 文件，并告诉我文件内容。' : '请解释我们之前记录的项目安排。') => client.timeout(5000).emitWithAck('agent:chat', {
    text, history: [], agentId: 'lumi', ...scope, requestId: id,
  });
  const drain = () => client.timeout(5000).emitWithAck('fixture:barrier');
  return { userId, org, scope, requestId, send, drain, emitted, finished: finished.promise, completionFor, acknowledgements, errors };
}

it('an authorized completed tool chat publishes its durable task relation', async () => {
  const h = await openChat(true);
  await h.send();
  await h.finished;
  await h.drain();
  await vi.waitFor(() => expect(h.emitted.some(([event, payload]) => event === 'agent:response' && payload.text.includes(marker))).toBe(true));
  expect(h.errors).toEqual([]);
  expect(h.emitted.filter(([event]) => event === 'agent:task_relation')).toEqual(expect.arrayContaining([
    ['agent:task_relation', expect.objectContaining({ phase: 'terminal_persisted', relation: expect.objectContaining({ taskId: expect.any(String) }) })],
  ]));
});

it('an authorized conversational chat starts eligible memory extraction after release', async () => {
  const h = await openChat(false);
  await h.send();
  await h.finished;
  await h.drain();
  expect(h.errors).toEqual([]);
  await vi.waitFor(() => expect(fixture.memoryPlan).toHaveBeenCalledOnce());
});

it('removal during the real terminal flush publishes only a safe cancellation and no old task relation', async () => {
  const h = await openChat(true);
  const entered = deferred();
  const gate = deferred();
  unblock.push(gate.resolve);
  fixture.beforeTerminalFlush = async () => { entered.resolve(); await gate.promise; };
  await h.send();
  await entered.promise;
  await h.drain();
  expect(fixture.model).toHaveBeenCalled();
  expect(h.emitted.some(([event]) => event === 'agent:response')).toBe(false);
  const beforeRevocation = h.emitted.length;
  removeMember(h.org.id, h.userId);
  gate.resolve();
  await h.finished;
  await h.drain();
  await vi.waitFor(() => expect(h.emitted.some(([event, payload]) => event === 'agent:response' && payload.reason === 'cancelled')).toBe(true));
  expect(h.errors).toEqual([]);
  const late = h.emitted.slice(beforeRevocation);
  expect(late.filter(([event]) => event === 'agent:response')).toHaveLength(1);
  expect(JSON.stringify(late)).not.toContain(marker);
  expect(late.some(([event]) => event === 'agent:task_relation')).toBe(false);
  expect(late.some(([event]) => event === 'chat:conversation_updated')).toBe(false);
  expect(fixture.memoryPlan).not.toHaveBeenCalled();
});

it('removal while releasing a completed chat prevents starting a derived memory model', async () => {
  const h = await openChat(false);
  const entered = deferred();
  const gate = deferred();
  unblock.push(gate.resolve);
  fixture.beforeRelease = async () => { entered.resolve(); await gate.promise; };
  await h.send();
  await entered.promise;
  await vi.waitFor(() => expect(h.emitted.some(([event, payload]) => event === 'agent:response' && payload.text.includes(marker))).toBe(true));
  expect(fixture.memoryPlan).not.toHaveBeenCalled();
  removeMember(h.org.id, h.userId);
  gate.resolve();
  await h.finished;
  await h.drain();
  expect(h.errors).toEqual([]);
  expect(fixture.memoryPlan).not.toHaveBeenCalled();
});

it('settles a revoked cancel sidecar once without prematurely finalizing the held foreground model', async () => {
  const h = await openChat(false);
  const modelStarted = deferred();
  const modelGate = deferred();
  const sidecarEntered = deferred();
  const sidecarGate = deferred();
  unblock.push(modelGate.resolve, sidecarGate.resolve);
  let signal: AbortSignal | undefined;
  fixture.model.mockImplementation(async (...args: any[]) => {
    signal = args[2]?.signal;
    modelStarted.resolve();
    await modelGate.promise;
    return outcome();
  });
  await h.send();
  await modelStarted.promise;
  const controlId = `${h.requestId}-cancel`;
  fixture.beforeSidecarPersistenceReturn = async () => { sidecarEntered.resolve(); await sidecarGate.promise; };
  const controlAck = h.send(controlId, '停止');
  await sidecarEntered.promise;
  expect(getChatExecution(h.scope, controlId)).toMatchObject({ sidecar: true, terminal: false });
  expect(h.acknowledgements.filter(item => item.requestId === controlId)).toHaveLength(0);
  removeMember(h.org.id, h.userId);
  sidecarGate.resolve();
  expect(await controlAck).toMatchObject({ ok: true, requestId: controlId });
  await h.completionFor(controlId).promise;
  await h.drain();
  expect(h.errors).toEqual([]);
  const controlTerminals = h.emitted.filter(([event, payload]) => event === 'agent:response' && payload.requestId === controlId);
  expect(controlTerminals).toHaveLength(1);
  expect(controlTerminals[0][1]).toMatchObject({ finalized: true, blocked: false, reason: 'cancelled' });
  expect(JSON.stringify(controlTerminals)).not.toContain(marker);
  expect(h.acknowledgements.filter(item => item.requestId === controlId)).toEqual([
    { requestId: controlId, payload: expect.objectContaining({ ok: true, requestId: controlId }) },
  ]);
  expect(getChatExecution(h.scope, controlId)).toMatchObject({ sidecar: true, terminal: true, status: 'cancelled' });
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  expect(getChatExecution(h.scope, h.requestId)?.terminal).toBe(false);
  expect(h.emitted.some(([event, payload]) => event === 'agent:response' && payload.requestId === h.requestId)).toBe(false);
  expect(fixture.model).toHaveBeenCalledOnce();
  modelGate.resolve();
  await h.completionFor(h.requestId).promise;
  await h.drain();
  expect(getChatExecution(h.scope, h.requestId)).toMatchObject({ terminal: true, status: 'cancelled' });
  expect(h.emitted.filter(([event, payload]) => event === 'agent:response' && payload.requestId === h.requestId)).toHaveLength(1);
  expect(h.acknowledgements.filter(item => item.requestId === controlId)).toHaveLength(1);
}, 10000);

it('parent cancellation during optional classification never starts the main reply', async () => {
  const h = await openChat(false);
  const classifierStarted = deferred();
  const classifierGate = deferred();
  unblock.push(classifierGate.resolve);
  let classifierSignal: AbortSignal | undefined;
  fixture.model.mockImplementation(async (...args: any[]) => {
    if (args[2]?.source === 'chat_intent_classifier') {
      classifierSignal = args[2].signal;
      classifierStarted.resolve();
      // Model intentionally ignores abort, exercising the bounded wrapper.
      await classifierGate.promise;
      return outcome('{"category":"question","confidence":0.9,"entities":{}}');
    }
    return outcome('THIS_MAIN_REPLY_MUST_NOT_START');
  });
  await h.send(h.requestId, '请计算 1234.5 × 3.6 - 75.6，只给结果。');
  await classifierStarted.promise;
  expect(await client.timeout(5000).emitWithAck('agent:abort_chat', {
    ...h.scope, requestId: h.requestId,
  })).toMatchObject({ ok: true });
  await h.finished;
  await h.drain();
  expect(classifierSignal?.aborted).toBe(true);
  expect(fixture.model).toHaveBeenCalledOnce();
  expect(fixture.model.mock.calls[0][2]).toMatchObject({ source: 'chat_intent_classifier', noImplicitFailover: true });
  expect(h.errors).toEqual([]);
  expect(getChatExecution(h.scope, h.requestId)).toMatchObject({ terminal: true, status: 'cancelled' });
  expect(JSON.stringify(h.emitted)).not.toContain('THIS_MAIN_REPLY_MUST_NOT_START');
  classifierGate.resolve();
}, 10000);

it('a classifier deadline yields to the main reply without narrowing its configured fallback policy', async () => {
  const h = await openChat(false);
  upsertUserPreferredLLM(h.userId, {
    provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'ordered_fallback',
    fallbackCandidates: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }], allowCloudFallback: true,
  });
  const classifierGate = deferred();
  unblock.push(classifierGate.resolve);
  let classifierSignal: AbortSignal | undefined;
  let classifierConfig: any;
  let mainConfig: any;
  fixture.model.mockImplementation(async (...args: any[]) => {
    if (args[2]?.source === 'chat_intent_classifier') {
      classifierConfig = args[2];
      classifierSignal = args[2].signal;
      await classifierGate.promise;
      return outcome('{"category":"question","confidence":0.9,"entities":{}}');
    }
    mainConfig = args[2];
    return outcome('4368.6');
  });
  await h.send(h.requestId, '请计算 1234.5 × 3.6 - 75.6，只给结果。');
  await h.finished;
  await h.drain();
  expect(classifierConfig).toMatchObject({
    maxTokens: INTENT_CLASSIFIER_MAX_TOKENS, noImplicitFailover: true,
    attemptTimeouts: { absoluteMs: INTENT_CLASSIFIER_TIMEOUT_MS }, fallbackCandidates: [],
  });
  expect(classifierSignal?.aborted).toBe(true);
  expect(mainConfig).toMatchObject({
    provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'ordered_fallback',
    fallbackCandidates: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }], allowCloudFallback: true,
  });
  expect(mainConfig.noImplicitFailover).not.toBe(true);
  expect(mainConfig.signal.aborted).toBe(false);
  expect(h.errors).toEqual([]);
  expect(h.emitted.some(([event, payload]) => event === 'agent:response' && payload.text === '4368.6')).toBe(true);
  classifierGate.resolve();
}, 15000);
