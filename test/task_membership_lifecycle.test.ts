import './helpers';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const probe = vi.hoisted(() => ({ process: vi.fn(), model: vi.fn(),
  flush: null as null | ((actual: () => Promise<void>) => Promise<void>),
  consume: null as null | (() => Promise<void>),
  receipt: null as null | ((sql: string, params: any[]) => Promise<void>),
}));
vi.mock('../db_layer', async original => {
  const actual = await original<typeof import('../db_layer')>();
  return { ...actual, flushDBOrThrow: () => probe.flush ? probe.flush(actual.flushDBOrThrow) : actual.flushDBOrThrow(),
    runSQL: async (...args: Parameters<typeof actual.runSQL>) => {
      const result = await actual.runSQL(...args);
      await probe.receipt?.(args[0], args[1] || []);
      return result;
    } };
});
vi.mock('../server/tools/pending_confirmation', async original => {
  const actual = await original<typeof import('../server/tools/pending_confirmation')>();
  return { ...actual, consumePendingConfirmationDurably: async (...args: Parameters<typeof actual.consumePendingConfirmationDurably>) => {
    const result = await actual.consumePendingConfirmationDurably(...args);
    await probe.consume?.(); return result;
  } };
});
vi.mock('../server/cognition', async original => ({
  ...await original<typeof import('../server/cognition')>(),
  processInput: (...args: any[]) => probe.process(...args),
}));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => probe.model(...args),
}));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(),
  queryMemories: () => [], queryMemoriesVector: async () => [],
  extractMemories: async () => ({ memories: [], reminders: [] }),
}));

import { makeApp, JWT_SECRET } from './helpers';
import { readDB, flushDBOrThrow, querySQL } from '../db_layer';
import { createOrg, addMember, getMember } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { initSocketRuntime } from '../server/runtime/socket';
import { addMessage, bindConversationActionExecutionTurn, getOrCreateActiveConversation, prepareConversationActionExecution, setConversationActionExecutionStatus } from '../server/conversation/manager';
import { getChatExecution } from '../server/socket/chat_execution_registry';
import { recordPendingConfirmationDurably, buildTransportNeutralConfirmationScope } from '../server/tools/pending_confirmation';
import { toolRegistry } from '../server/tools/registry';

let app: Awaited<ReturnType<typeof makeApp>>;
let io: Server;
const clients: Socket[] = [];
let release: (() => void) | undefined;
let outbound: ReturnType<typeof vi.fn>;
const publicTool = vi.fn(async () => JSON.stringify({ status: 'completed', items: [{ title: 'Synthetic fixture', url: 'https://example.invalid/fixture' }] }));

beforeAll(async () => {
  app = await makeApp();
  mountOrgRoutes(app.apiRouter);
  mountCommandCenterPlanRoutes(app.apiRouter);
  io = new Server(app.server, { transports: ['websocket'] });
  const getter = () => null;
  initSocketRuntime({ io, jwtSecret: JWT_SECRET, llm: {
    getDeepSeek: getter, getGemini: getter, getOpenAI: getter, getAnthropic: getter,
    getQwen: getter, getArk: getter, getOllama: getter, getLmStudio: getter,
    getXiaomi: getter, getKimi: getter, getGlm: getter, getRelay: getter,
    isOllamaAvailable: () => false, isLmStudioAvailable: () => false,
  } });
  const fetchLocal = globalThis.fetch;
  outbound = vi.fn(async (input: any, init?: RequestInit) => {
    const target = new URL(typeof input === 'string' ? input : input.url || String(input));
    if (target.origin !== app.url) throw new Error('Audit forbids external network');
    return fetchLocal(input, init);
  });
  vi.stubGlobal('fetch', outbound);
  probe.model.mockImplementation(() => { throw new Error('Audit forbids real model calls'); });
  toolRegistry.register({ name: 'web_search', description: 'Synthetic public search; no network', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, handler: publicTool });
});
afterEach(() => {
  release?.(); release = undefined;
  for (const client of clients.splice(0)) client.disconnect();
  probe.process.mockReset();
  probe.model.mockReset(); probe.flush = null; probe.consume = null; probe.receipt = null; publicTool.mockClear();
});
afterAll(async () => {
  toolRegistry.unregister('web_search');
  vi.unstubAllGlobals();
  await new Promise<void>(resolve => io.close(() => resolve()));
});

async function setup(options: { confirmation?: boolean; response?: boolean; beforeSend?: (data: { uid: string; requestId: string; conversationId: string }) => void } = {}) {
  const uid = `audit9-member-${randomUUID()}`;
  const owner = `audit9-owner-${randomUUID()}`;
  const orgId = createOrg('Synthetic task cancellation audit', `audit9-${randomUUID()}`, owner).id;
  addMember(orgId, owner, 'owner'); addMember(orgId, uid, 'member');
  const token = jwt.sign({ uid, orgId, role: 'user' }, JWT_SECRET);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const client = connect(app.url, { transports: ['websocket'], auth: { token } });
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  expect(io.sockets.sockets.get(client.id!)?.data.authenticatedOrgId).toBe(orgId);
  const conversationId = getOrCreateActiveConversation(uid, '', 'work', orgId).id;
  const requestId = `audit9-task-${randomUUID()}`;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  if (options.confirmation) {
    const originRequestId = `audit9-proposal-${randomUUID()}`;
    const userText = '请搜索公开测试资料。';
    const userMessageId = addMessage({ userId: uid, agentId: '', conversationId, role: 'user', content: userText,
      domain: 'work', orgId, source: 'task', channel: 'task', requestId: originRequestId, deferActionPreparation: true });
    bindConversationActionExecutionTurn({ conversationId, userId: uid, userText, requestId: originRequestId, userMessageId });
    const prepared = prepareConversationActionExecution({ conversationId, userId: uid, userText,
      requestId: originRequestId, userMessageId, forceTask: true, forceNewTask: true,
      toolPolicy: { allowedTools: ['web_search'], requireConfirmation: [], forbiddenTools: [], maxIterations: 2 } });
    expect(prepared.state?.taskId).toBeTruthy();
    setConversationActionExecutionStatus(conversationId, uid, 'blocked', { blocker: 'Waiting for exact user confirmation.', requestId: originRequestId });
    addMessage({ userId: uid, agentId: '', conversationId, role: 'assistant', content: '请确认执行公开资料搜索。',
      domain: 'work', orgId, source: 'task', channel: 'task', requestId: originRequestId,
      completionFeedback: { status: 'blocked', incomplete: ['Waiting for exact user confirmation.'], nextSteps: [] } });
    await flushDBOrThrow();
    const scope = buildTransportNeutralConfirmationScope({ domain: 'work', orgId, conversationId,
      taskId: prepared.state!.taskId, originRequestId });
    await recordPendingConfirmationDurably(uid, 'web_search', { query: 'Synthetic fixture' }, 'task', { ...scope, actionIntent: userText });
    probe.consume = async () => { entered(); await held; };
  } else if (options.response) {
    probe.process.mockResolvedValue({ responseText: '', intent: { category: 'conversation', confidence: 1, entities: {}, needsLLM: true }, llmWasCalled: false, directToolExecuted: false, isFallback: false });
    probe.model.mockResolvedValue({ text: 'A synthetic explanation with no external actions.', toolCalls: [] });
    entered();
  } else probe.process.mockImplementationOnce(async () => { entered(); await held; throw new Error('Synthetic cognition stopped at test boundary'); });
  const responses: any[] = [];
  client.on('agent:response', payload => { if (payload.requestId === requestId) responses.push(payload); });
  options.beforeSend?.({ uid, requestId, conversationId });
  const ack = await client.timeout(5_000).emitWithAck('agent:task', {
    text: options.confirmation ? '确认执行' : options.response ? '解释一下什么是计划。不要调用任何工具。' : '请分析季度报告的重点和执行建议。', requestId, conversationId, domain: 'work', orgId,
  });
  expect(ack).toMatchObject({ ok: true, requestId });
  await started;
  const remove = async () => {
    const result = await fetch(`${app.url}/api/org/org/${orgId}/members/${uid}`, { method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt.sign({ uid: owner, orgId, role: 'user' }, JWT_SECRET)}` } });
    expect(result.status).toBe(200); expect(getMember(orgId, uid)?.status).not.toBe('active');
    expect((await fetch(`${app.url}/api/command-center/plans`, { headers })).status).toBe(403);
  };
  const finish = async () => {
    await vi.waitFor(() => expect(getChatExecution({ userId: uid, domain: 'work', orgId, source: 'task' }, requestId)?.terminal).toBe(true));
    await vi.waitFor(() => {
      const turn = readDB().conversationActionTurns.find((row: any) => row.userId === uid && row.requestId === requestId);
      expect(turn?.leaseOwnerId || '').toBe('');
    });
    await flushDBOrThrow();
    return getChatExecution({ userId: uid, domain: 'work', orgId, source: 'task' }, requestId)!;
  };
  return { uid, orgId, requestId, client, responses, remove, conversationId, finish };
}

it.each([false, true])('actual task cancellation keeps the original scope after membership removal=%s', async removed => {
  const test = await setup();
  if (removed) await test.remove();
  const cancellation = await test.client.timeout(5_000).emitWithAck('agent:task_cancel', {
    requestId: test.requestId, domain: 'work', orgId: test.orgId,
  });
  expect(cancellation).toMatchObject({ ok: true, requestId: test.requestId, status: 'cancelling' });
  release!();
  const terminal = await test.finish();
  expect(terminal.status).toBe('cancelled');
  if (removed) expect(test.responses).toEqual([]);
  else expect(test.responses[0]?.reason).toBe('request_cancelled');
  const rows = await querySQL<any>('SELECT * FROM interactions WHERE userId = ?', [test.uid]);
  const assistant = rows.find((row: any) => row.role === 'assistant');
  expect(assistant).toMatchObject({ domain: 'work', orgId: test.orgId });
  if (removed) {
    const denied = await test.client.timeout(5_000).emitWithAck('agent:task', { text: 'A new personal task', requestId: randomUUID(), domain: 'personal' });
    expect(denied.ok).toBe(false);
    const replay = await test.client.timeout(5_000).emitWithAck('agent:task_cancel', { requestId: test.requestId });
    expect(replay).toMatchObject({ ok: true, status: 'cancelled' });
    expect(test.responses).toEqual([]);
    expect(readDB().conversations.some((row: any) => row.userId === test.uid && row.domain === 'personal')).toBe(false);
  }
  expect(probe.model).not.toHaveBeenCalled();
}, 20_000);

it('automatically cancels a planning task on removal without a user cancellation message', async () => {
  const test = await setup();
  await test.remove();
  await vi.waitFor(() => expect(getChatExecution({ userId: test.uid, domain: 'work', orgId: test.orgId, source: 'task' }, test.requestId)?.status).toBe('cancelling'));
  release!();
  expect((await test.finish()).status).toBe('cancelled');
  expect(test.responses).toEqual([]); expect(probe.model).not.toHaveBeenCalled();
});

it('cancels queued work on removal before it can acquire the executor', async () => {
  const test = await setup();
  const queuedId = `audit9-queued-${randomUUID()}`;
  const responses: any[] = [];
  test.client.on('agent:response', payload => { if (payload.requestId === queuedId) responses.push(payload); });
  expect(await test.client.timeout(5_000).emitWithAck('agent:task', {
    text: '另外，请分析下一季度的工作重点。', requestId: queuedId, conversationId: test.conversationId,
  })).toMatchObject({ ok: true, requestId: queuedId });
  const scope = { userId: test.uid, domain: 'work' as const, orgId: test.orgId, source: 'task' };
  expect(getChatExecution(scope, queuedId)?.queued).toBe(true);
  await test.remove();
  await vi.waitFor(() => expect(getChatExecution(scope, queuedId)?.status).toBe('cancelling'));
  expect(probe.process).toHaveBeenCalledOnce();
  expect(responses).toEqual([]);
  release!();
  expect((await test.finish()).status).toBe('cancelled');
  await vi.waitFor(() => expect(getChatExecution(scope, queuedId)?.status).toBe('cancelled'));
  expect(probe.process).toHaveBeenCalledOnce();
  expect(probe.model).not.toHaveBeenCalled();
});

it('does not allow another organization member to cancel a known request id', async () => {
  const test = await setup();
  const otherUid = `audit9-other-${randomUUID()}`;
  addMember(test.orgId, otherUid, 'member');
  const other = connect(app.url, { transports: ['websocket'], auth: {
    token: jwt.sign({ uid: otherUid, orgId: test.orgId, role: 'user' }, JWT_SECRET),
  } });
  clients.push(other);
  await new Promise<void>((resolve, reject) => { other.once('connect', resolve); other.once('connect_error', reject); });
  expect(await other.timeout(5_000).emitWithAck('agent:task_cancel', { requestId: test.requestId, userId: test.uid }))
    .toMatchObject({ ok: false, error: 'Active task not found' });
  expect(getChatExecution({ userId: test.uid, domain: 'work', orgId: test.orgId, source: 'task' }, test.requestId)?.terminal).toBe(false);
  await test.remove(); release!(); await test.finish();
});

it.each([false, true])('checks membership again after the durable confirmation wait (removed=%s)', async removed => {
  const test = await setup({ confirmation: true });
  if (removed) await test.remove();
  release!();
  const terminal = await test.finish();
  if (removed) {
    expect(publicTool).not.toHaveBeenCalled(); expect(terminal.status).toBe('cancelled'); expect(test.responses).toEqual([]);
  } else {
    const assistant = readDB().interactions.find((row: any) => row.userId === test.uid && row.requestId === test.requestId && row.role === 'assistant');
    expect(assistant?.toolCalls?.[0]?.error || '').toBe('');
    expect(publicTool).toHaveBeenCalledOnce();
  }
});

it.each(['flush', 'receipt'])('replaces an unpublished terminal with durable cancellation when membership changes during %s', async boundary => {
  let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void; const gate = new Promise<void>(resolve => { proceed = resolve; });
  let held = false;
  const test = await setup({ response: true, beforeSend: ({ uid, requestId }) => {
    if (boundary === 'flush') probe.flush = async actual => {
      if (!held && readDB().interactions.some((row: any) => row.userId === uid && row.role === 'assistant' && row.requestId === requestId)) {
        held = true; entered(); await gate;
      }
      await actual();
    };
    else probe.receipt = async (sql, params) => {
      if (!held && sql.includes('INSERT INTO chat_execution_terminal_receipts') && params[0] === uid && params[5] === requestId) {
        held = true; entered(); await gate;
      }
    };
  } });
  try {
    await pending;
    await test.remove();
    proceed();
    const terminal = await test.finish();
    expect(terminal.status).toBe('cancelled');
    expect(test.responses).toEqual([]);
    const assistant = readDB().interactions.find((row: any) => row.userId === test.uid && row.role === 'assistant');
    expect(assistant?.completionFeedback?.status).toBe('cancelled');
    expect(assistant?.message).not.toContain('A synthetic explanation');
    const receipts = await querySQL<any>('SELECT status, payload FROM chat_execution_terminal_receipts WHERE userId = ? AND requestId = ?', [test.uid, test.requestId]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('cancelled');
    expect(receipts[0].payload).not.toContain('A synthetic explanation');
  } finally { proceed(); }
}, 15_000);
