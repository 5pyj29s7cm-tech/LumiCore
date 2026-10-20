import './helpers';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, flushDBOrThrow } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, prepareConversationActionExecution } from '../server/conversation/manager';
import { buildDesktopExecutionPlan } from '../server/desktop/execution_plan';
import { DesktopExecutionTracker, withDesktopExecutionReceipt } from '../server/desktop/execution_runtime';
import { ToolRegistry } from '../server/tools/registry';
import { registerScreenMonitorTools } from '../server/tools/definitions/screen_monitor';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { recordPendingConfirmationDurably, buildTransportNeutralConfirmationScope } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); });
const goal = '打开网易云音乐，播放音乐。';
async function owner() {
  const userId = 'desktop-record-binding-' + randomUUID(), requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const userMessageId = addMessageIdempotent({ userId, conversationId, requestId, agentId: 'lumi', role: 'user', content: goal,
    domain: 'personal', orgId: '', deferActionPreparation: true });
  await flushDBOrThrow();
  const prepared = prepareConversationActionExecution({ userId, conversationId, requestId, userMessageId,
    userText: goal, forceTask: true, toolPolicy: { allowedTools: ['desktop_active_window', 'desktop_open'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } });
  if ('bindingFailure' in prepared || !prepared.state?.taskId) throw new Error('The actual accepted fixture task was not admitted');
  await flushDBOrThrow();
  return { userId, conversationId, requestId, taskId: prepared.state.taskId, turnId: requestId, turnRowId: prepared.turnRowId };
}
function nativeFixture(identity: Awaited<ReturnType<typeof owner>>) {
  const registry = new ToolRegistry(); registerDesktopTools(registry); registerScreenMonitorTools(registry);
  let foreground = { title: 'LumiCore', processName: 'lumi-core.exe', processId: 10 };
  const desktopRelay = vi.fn(async (name: string) => {
    if (name === 'desktop_active_window') return JSON.stringify(foreground);
    if (name === 'desktop_open') {
      foreground = { title: '网易云音乐', processName: 'cloudmusic.exe', processId: 4242 };
      return 'Focused running app 网易云音乐 (pid 4242, window "网易云音乐")';
    }
    throw new Error('Unexpected offline native command');
  });
  const context: ToolContext = { ...identity, authenticated: true, authRole: 'admin', localExecution: true,
    executionBoundary: 'trusted_local', currentTurnExecutionRequested: true, userConfirmed: true,
    domain: 'personal', orgId: '', actionIntent: goal, routedTaskText: goal, source: 'desktop-binding-fixture', desktopRelay,
    toolPolicy: { allowedTools: ['desktop_active_window', 'desktop_open'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } };
  const call = (name: string, tracker: DesktopExecutionTracker, more: Partial<ToolContext> = {}) => executeToolCall({ registry,
    id: randomUUID(), name, arguments: name === 'desktop_open' ? { target: '网易云音乐' } : {},
    context: { ...context, desktopExecutionTracker: tracker, ...more } });
  return { registry, call, context, desktopRelay };
}

describe('desktop aggregate identity and waiting confirmation', () => {
  it('keeps a real waiting-confirmation record without adding a target-mismatch terminal', async () => {
    const identity = await owner();
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: goal, lane: 'desktop_control' }));
    expect(tracker.plan.taskId).toBe('');
    const native = nativeFixture(identity);
    const observed = await native.call('desktop_active_window', tracker);
    expect(isCanonicalToolExecutionRecord(observed)).toBe(true);
    const before = withDesktopExecutionReceipt([observed], tracker);
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId: identity.conversationId, taskId: identity.taskId });
    const requestConfirmation = vi.fn(async (name: string, args: Record<string, any>) => {
      await recordPendingConfirmationDurably(identity.userId, name, args, 'voice', { ...scope, originRequestId: identity.requestId, actionIntent: goal });
      return false;
    });
    const waiting = await native.call('desktop_open', tracker, { userConfirmed: false, requestConfirmation });
    expect(isCanonicalToolExecutionRecord(waiting)).toBe(true);
    expect(waiting.envelope?.status).toBe('waiting_confirmation');
    expect(waiting.adapterStarted).not.toBe(true);
    expect(requestConfirmation).toHaveBeenCalledOnce();
    const projected = withDesktopExecutionReceipt([...before, waiting], tracker);
    expect(projected).toEqual([observed, waiting]);
    expect(native.desktopRelay.mock.calls.filter(([name]) => name === 'desktop_open')).toHaveLength(0);
    expect(tracker.plan.taskId).toBe(identity.taskId);
  });

  it('replaces a prior derived mismatch with the fresh same-task verified launch receipt', async () => {
    const identity = await owner(), native = nativeFixture(identity);
    const plan = buildDesktopExecutionPlan({ text: '打开网易云音乐', lane: 'desktop_control' });
    const tracker = new DesktopExecutionTracker(plan);
    const before = await native.call('desktop_active_window', tracker);
    expect(before.envelope?.status, JSON.stringify(before)).toBe('verified_success');
    const blocked = withDesktopExecutionReceipt([before], tracker);
    const oldAggregate = blocked.find(record => record.name === 'desktop_execution_plan_receipt')!;
    expect(oldAggregate).toMatchObject({ taskId: identity.taskId, requestId: identity.requestId,
      turnId: identity.turnId, turnRowId: identity.turnRowId, terminalVerification: { status: 'failed' } });
    expect(JSON.parse(oldAggregate.result)).toMatchObject({ finalState: 'target_mismatch', completionVerified: false });
    const opened = await native.call('desktop_open', tracker);
    expect(opened.envelope?.status).toBe('verified_success');
    const updated = withDesktopExecutionReceipt([...blocked, opened], tracker);
    expect(updated.filter(record => record.name === 'desktop_execution_plan_receipt')).toHaveLength(1);
    const aggregate = updated.find(record => record.name === 'desktop_execution_plan_receipt')!;
    expect(aggregate).toMatchObject({ id: oldAggregate.id, taskId: identity.taskId, requestId: identity.requestId,
      turnId: identity.turnId, turnRowId: identity.turnRowId, terminalVerification: { status: 'verified' } });
    expect(aggregate.error).toBeUndefined();
    expect(JSON.parse(aggregate.result)).toMatchObject({ taskId: identity.taskId, completionVerified: true, finalState: 'verified_success' });
  });

  it('refuses a usable aggregate from serialized or taskless records', async () => {
    const identity = await owner(), native = nativeFixture(identity);
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: '打开网易云音乐', lane: 'desktop_control' }));
    const opened = await native.call('desktop_open', tracker);
    const serialized = JSON.parse(JSON.stringify(opened)) as ToolExecutionRecord;
    const unbound = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: '打开网易云音乐', lane: 'desktop_control' }));
    unbound.record(serialized);
    expect(isCanonicalToolExecutionRecord(serialized)).toBe(false);
    expect(withDesktopExecutionReceipt([serialized], unbound)).toEqual([serialized]);
    expect(unbound.plan.taskId).toBe('');
    const taskless = await executeToolCall({ registry: native.registry, id: randomUUID(), name: 'desktop_active_window', arguments: {},
      context: { ...native.context, taskId: undefined, desktopExecutionTracker: unbound } });
    expect(isCanonicalToolExecutionRecord(taskless)).toBe(true);
    expect(withDesktopExecutionReceipt([taskless], unbound)).toEqual([taskless]);
    expect(unbound.plan.taskId).toBe('');
  });

  it('never rebinds a locked tracker from another canonical task or request', async () => {
    const identity = await owner(), native = nativeFixture(identity);
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: '打开网易云音乐', lane: 'desktop_control' }));
    const opened = await native.call('desktop_open', tracker);
    const first = withDesktopExecutionReceipt([opened], tracker).find(record => record.name === 'desktop_execution_plan_receipt')!;
    expect(first).toMatchObject({ taskId: identity.taskId, requestId: identity.requestId });
    const firstState = tracker.receipt();
    const another = await owner(), foreign = nativeFixture(another);
    const foreignTask = await foreign.call('desktop_active_window', tracker);
    expect(isCanonicalToolExecutionRecord(foreignTask)).toBe(true);
    expect(withDesktopExecutionReceipt([foreignTask], tracker)).toEqual([foreignTask]);
    expect(tracker.receipt()).toEqual(firstState);
    const foreignRequest = await native.call('desktop_active_window', tracker, { requestId: randomUUID(), turnId: randomUUID() });
    expect(isCanonicalToolExecutionRecord(foreignRequest)).toBe(true);
    expect(withDesktopExecutionReceipt([foreignRequest], tracker)).toEqual([foreignRequest]);
    expect(tracker.receipt()).toEqual(firstState);
    const stable = withDesktopExecutionReceipt([opened], tracker).find(record => record.name === 'desktop_execution_plan_receipt')!;
    expect(stable).toMatchObject({ taskId: identity.taskId, requestId: identity.requestId });
  });
});
