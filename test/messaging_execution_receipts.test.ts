import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry, toolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import { getMessages, startNewConversation } from '../server/conversation/manager';
import type { IncomingMessage } from '../server/messaging/types';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

const model = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../server/llm/adapter', async original => ({
  ...(await original<typeof import('../server/llm/adapter')>()), runWithTools: model.run,
}));
let routes: typeof import('../server/messaging/routes');
let sequence = 0;
beforeAll(async () => {
  await initDatabase();
  registerAllTools(toolRegistry);
  routes = await import('../server/messaging/routes');
});
beforeEach(() => {
  model.run.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external calls in receipt fixture')));
});
afterEach(async () => { await flushDBOrThrow(); vi.unstubAllGlobals(); });

function fixture(platform: IncomingMessage['platform'] = 'wechat') {
  const id = `remote-receipt-${++sequence}`;
  const target = path.join(String(process.env.LUMI_DATA_DIR), `${id}.txt`);
  fs.writeFileSync(target, 'Quantity: 4; unit price: 25.');
  const message: IncomingMessage = {
    platform, userId: `external-${id}`, boundUserId: id, chatId: id, chatType: 'private',
    userName: 'Fixture', messageId: id, text: `请读取 ${target} 并计算总价，然后生成报告。`,
    raw: {}, timestamp: new Date().toISOString(),
  };
  const registry = new ToolRegistry();
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  registry.register({
    name: 'read_file', description: 'Isolated receipt fixture', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => { started(); await gate; return fs.readFileSync(target, 'utf8'); },
  });
  let execution: Promise<ToolExecutionRecord>;
  let context: ToolContext;
  const install = (late = false) => model.run.mockImplementation(async (...args: any[]) => {
    context = args[11];
    execution = executeToolCall({ registry, id: `${id}-read`, name: 'read_file', arguments: { path: target }, context });
    await Promise.race([entered, execution.then(record => { throw new Error(`Fixture handler not reached: ${JSON.stringify(record)}`); })]);
    if (!late) { release(); await args[3]?.(await execution); }
    throw new Error('Synthetic model timeout after tool dispatch');
  });
  const receipts = () => readDB().conversationActionReceipts.filter((row: any) => row.requestId === `${platform}_bot:${id}`);
  const task = () => readDB().conversationActionTasks.find((row: any) => row.userId === id);
  return { id, message, target, install, release, receipts, task, context: () => context, execution: () => execution };
}

describe('remote channel execution evidence', () => {
  it.each(['wechat', 'feishu', 'wecom'] as const)('retains completed steps when %s model continuation fails', async platform => {
    const f = fixture(platform); f.install();
    const reply = await routes.processWithPersonality(f.message, {});
    expect(reply).toContain('没有完成');
    expect(model.run).toHaveBeenCalledOnce();
    await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(1);
    const requestId = platform + "_bot:" + f.id;
    const turn = readDB().conversationActionTurns.find((row: any) => row.requestId === requestId);
    const identity = { requestId, externalMessageId: f.id, turnRowId: turn.id };
    expect(f.context()).toMatchObject(identity);
    expect(await f.execution()).toMatchObject({ ...identity, resolutionId: f.context().resolutionId });
    expect(f.receipts()[0]).toMatchObject(identity);
    expect(JSON.parse(f.receipts()[0].envelope)).toMatchObject({ ...identity, resolutionId: f.context().resolutionId });
    const task = f.task();
    expect(task.status).toBe('blocked');
    const assistant = getMessages(task.conversationId).find(row => row.role === 'assistant');
    expect(assistant?.toolCalls).toEqual([expect.objectContaining({ name: 'read_file', result: 'Quantity: 4; unit price: 25.' })]);
    expect(JSON.parse(task.context).actionState.receipts).toEqual([expect.objectContaining({ name: 'read_file' })]);
  });

  it('archives a late canonical result without changing the closed request or starting more work', async () => {
    const f = fixture(); f.install(true);
    await routes.processWithPersonality(f.message, {});
    const taskBefore = JSON.stringify(f.task());
    const turnsBefore = JSON.stringify(readDB().conversationActionTurns);
    f.release(); await f.execution(); await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(1);
    expect(JSON.stringify(f.task())).toBe(taskBefore);
    expect(JSON.stringify(readDB().conversationActionTurns)).toBe(turnsBefore);
    expect(model.run).toHaveBeenCalledOnce();
  });

  it('binds both desktop routes to the request and releases their leases on failure', async () => {
    const f = fixture(); f.install();
    const releaseScoped = vi.fn(); const releasePersonal = vi.fn();
    const scoped = vi.fn((..._args: any[]) => Object.assign(async () => '{}', { releaseControlLease: releaseScoped }));
    const personal = vi.fn((..._args: any[]) => Object.assign(async () => '{}', { releaseControlLease: releasePersonal }));
    await routes.processWithPersonality(f.message, { createScopedDesktopRelay: scoped, createPersonalDesktopRelay: personal });
    const lifecycle = scoped.mock.calls[0][4];
    expect(lifecycle).toMatchObject({ taskId: f.task().id, requestId: `wechat_bot:${f.id}`, signal: expect.any(AbortSignal) });
    expect(personal.mock.calls[0][2]).toBe(lifecycle);
    expect(releaseScoped).toHaveBeenCalledOnce();
    expect(releasePersonal).toHaveBeenCalledOnce();
    await lifecycle.onLateResult({ correlationId: `${f.id}-native`, name: 'desktop_open', arguments: { path: f.target }, result: '{"ok":true}' });
    const native = f.receipts().find((row: any) => row.toolName === 'desktop_open');
    expect(JSON.parse(native.envelope).verification).toMatchObject({ status: 'unverified' });
    expect(f.task().status).toBe('blocked');
  });

  it('keeps the terminal reply in the accepted conversation when the user opens a new chat', async () => {
    const f = fixture(); f.install();
    const run = model.run.getMockImplementation()!;
    let nextConversationId = '';
    model.run.mockImplementation(async (...args: any[]) => {
      nextConversationId = startNewConversation(f.id, routes.messagingConversationAgentId(f.message)).id;
      return run(...args);
    });
    await routes.processWithPersonality(f.message, {});
    expect(nextConversationId).not.toBe(f.task().conversationId);
    const oldMessages = getMessages(f.task().conversationId);
    expect(oldMessages.filter(row => row.role === 'assistant')).toHaveLength(1);
    expect(getMessages(nextConversationId)).toHaveLength(0);
    expect(f.task().status).toBe('blocked');
  });

  it('does not mark a read-only task completed if the response itself failed', async () => {
    const f = fixture(); f.message.text = `请读取 ${f.target}`; f.install();
    await routes.processWithPersonality(f.message, {});
    expect(f.receipts()).toHaveLength(1);
    expect(f.task().status).toBe('blocked');
  });

  it('does not archive a late result after the original platform binding is revoked', async () => {
    const f = fixture();
    const bindings = await import('../server/messaging/bindings');
    const { captureMessagingBinding } = await import('../server/messaging/turn_authorization');
    const code = bindings.createBindingCode('wechat', f.id, '', 'personal');
    const binding = bindings.consumeBindingCode('wechat', code.code, f.message.userId, f.message.chatId)!;
    f.message.bindingAuthorization = captureMessagingBinding(binding);
    f.install(true);
    await routes.processWithPersonality(f.message, {});
    bindings.deleteBindingForUser(f.id, binding.id, '', 'personal');
    f.release(); await f.execution(); await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(0);
    expect(f.task().status).toBe('blocked');
  });

  it('keeps archiving already started work when admission is closed for shutdown', async () => {
    const f = fixture(); f.install(true);
    await routes.processWithPersonality(f.message, {});
    const before = JSON.stringify(f.task());
    await routes.stopMessagingIngressAndDrain();
    f.release(); await f.execution(); await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(1);
    expect(JSON.stringify(f.task())).toBe(before);
  });
});
