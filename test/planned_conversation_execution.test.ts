import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runResolvedLumiTurn } from '../server/cognition/turn_model';
vi.mock('../server/llm/lumi_turn', async () => ({ ...await vi.importActual<typeof import('../server/llm/lumi_turn')>('../server/llm/lumi_turn'), runLumiTurn: async (input: any) => {
  const { executeToolCall } = await import('../server/tools/execution_engine');
  const record = await executeToolCall({registry: input.registry, id: input.config.requestId+':observed', name: 'web_search', arguments: {query: 'synthetic evidence'}, context: input.context});
  await input.onToolCall(record);
  return {response: 'Synthetic evidence', toolCalls: [record]};
} }));
async function observeBoundPlan(input: Awaited<ReturnType<typeof accepted>>) {
  expect(input.execution.executionPlan).toBeUndefined();
  await runResolvedLumiTurn({ execution: input.execution, registry: input.registry, messages: [], config: {provider: 'deepseek', model: 'synthetic',requestId: input.requestId}, getters: {},
    context: {userId: input.userId,conversationId: input.conversationId,taskId: input.execution.taskId}, onToolCall: async () => {} });
  expect(input.execution.executionPlan?.decisionAuthority).toBe('registry_bound_call');
  expect(input.execution.executionPlan?.nodes).toHaveLength(1);
  expect(input.execution.executionPlan?.nodes[0]).toMatchObject({toolName:'web_search',state:'terminal'});
}

import { recordPendingConfirmationDurably, clearAllPendingConfirmationsForTests, buildTransportNeutralConfirmationScope, getPendingConfirmationDurably } from '../server/tools/pending_confirmation';
import { randomUUID } from 'node:crypto';
import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { getOrCreateActiveConversation, getConversationForScope, addMessageIdempotent } from '../server/conversation/manager';
import { preparePlannedConversationExecution } from '../server/conversation/planned_execution';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';

beforeAll(() => initDatabase());
afterEach(() => clearAllPendingConfirmationsForTests());
async function accepted(text: string, previous?: { userId: string; conversationId: string }) {
  const userId = previous?.userId || 'planned-owner-' + randomUUID();
  const conversationId = previous?.conversationId || getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const requestId = randomUUID();
  const userMessageId = addMessageIdempotent({ userId, conversationId, agentId: 'lumi', requestId, source: 'planned-fixture', channel: 'chat', domain: 'personal', orgId: '', role: 'user', content: text, deferActionPreparation: true });
  await flushDBOrThrow();
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Public evidence fixture', permission: 'public', securityLevel: 'safe', parameters: { type: 'object', properties: { query: { type: 'string' } } }, handler: async () => 'Fixture evidence' });
  const execution = buildLumiExecutionPipeline({ requestId, dispatch: { userId, text, channel: 'chat', source: 'planned-fixture', domain: 'personal', orgId: '' }, registry, isSanctuary: false,
    personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 4 },
    actionTaskState: getConversationForScope(conversationId, userId, 'personal', '')?.actionContinuationState,
  });
  return { userId, conversationId, requestId, userMessageId, userText: text, execution, registry };
}
async function unfinished() {
  const input = await accepted('Search the public web for synthetic cloud examples.');
  const preparation = preparePlannedConversationExecution(input);
  expect(preparation.state?.taskId).toBeTruthy();
  addMessageIdempotent({ userId: input.userId, conversationId: input.conversationId, agentId: 'lumi', requestId: input.requestId, source: 'planned-fixture', channel: 'chat', domain: 'personal', orgId: '', role: 'assistant', content: 'The evidence is not available yet.',
    terminalTaskDisposition: { outcome: 'blocked', taskId: preparation.state!.taskId, requestId: input.requestId, reason: 'Fixture source unavailable.' },
  });
  await flushDBOrThrow();
  return { input, taskId: preparation.state!.taskId };
}

describe('planned conversation task ownership', () => {
  it('binds a fresh executable request to its exact already durable transcript', async () => {
    const input = await accepted('Search the public web for synthetic cloud examples.');
    expect(input.execution.executionRequested).toBe(true);
    const prepared = preparePlannedConversationExecution(input);
    expect(prepared.kind).toBe('new');
    expect(prepared.state?.activeRequestId).toBe(input.requestId);
    expect(prepared.state?.latestInstructionRef).toBe(input.userMessageId);
    await observeBoundPlan(input);
    expect(input.execution.executionPlan!.taskId).toBe(prepared.state!.taskId);
    const persistedPlan = JSON.parse(readDB().conversationActionTasks.find((row: any) => row.id === prepared.state!.taskId).context).executionPlan;
    expect(persistedPlan).toMatchObject({ taskId: prepared.state!.taskId, planId: input.execution.executionPlan.planId });
    expect(persistedPlan.intent.payload).toBe('');
    expect(readDB().conversationActionTurns.find((row: any) => row.requestId === input.requestId)).toMatchObject({ taskId: prepared.state!.taskId, userMessageId: input.userMessageId });
  });
  it('keeps an accepted continuation on the exact unfinished task', async () => {
    const previous = await unfinished(); const input = await accepted('Continue the unfinished task.', previous.input);
    expect(input.execution.taskRelation.taskId).toBe(previous.taskId);
    const prepared = preparePlannedConversationExecution(input);
    expect(prepared.kind).toBe('resume'); expect(prepared.state?.taskId).toBe(previous.taskId);
    expect(prepared.state?.activeRequestId).toBe(input.requestId);
    await observeBoundPlan(input);
    expect(input.execution.executionPlan!.taskId).toBe(previous.taskId);
    expect(JSON.parse(readDB().conversationActionTasks.find((row: any) => row.id === previous.taskId).context).executionPlan.planId).toBe(input.execution.executionPlan.planId);
  });
  it('gives an unrelated concrete action its own task and preserves the supersession edge', async () => {
    const previous = await unfinished(); const input = await accepted('Start a separate task: Search the public web for synthetic ocean examples.', previous.input);
    const prepared = preparePlannedConversationExecution(input);
    expect(prepared.kind).toBe('new'); expect(prepared.state?.taskId).not.toBe(previous.taskId);
    expect(prepared.state?.supersededTaskId).toBe(previous.taskId);
  });
  it('does not borrow an unfinished task for an ordinary conversational turn', async () => {
    const previous = await unfinished(); const input = await accepted('Hello.', previous.input);
    const before = JSON.stringify(readDB().conversationActionTasks.filter((row: any) => row.conversationId === input.conversationId));
    expect(preparePlannedConversationExecution(input)).toMatchObject({ kind: 'conversation', state: null });
    expect(JSON.stringify(readDB().conversationActionTasks.filter((row: any) => row.conversationId === input.conversationId))).toBe(before);
  });
  it('creates a separate narrowly authorized task for a bound runtime cleanup offer', async () => {
    const previous = await unfinished(); const input = await accepted('Continue the unfinished task.', previous.input);
    const prepared = preparePlannedConversationExecution({ ...input, acceptedRuntimeCleanup: true });
    expect(prepared.kind).toBe('new'); expect(prepared.state?.taskId).not.toBe(previous.taskId);
    expect(prepared.state?.policySnapshot).toMatchObject({ allowedTools: ['runtime_work_cancel'], maxIterations: 1 });
  });
  it('prepares a taskless exact durable grant without borrowing a prior task', async () => {
    const input = await accepted('Okay.');
    expect(input.execution.capabilityPlan.taskLedgerRequired).toBe(false);
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', orgId: '', conversationId: input.conversationId });
    const pending = await recordPendingConfirmationDurably(input.userId, 'web_search', { query: 'fixture' }, 'chat', scope);
    expect((await getPendingConfirmationDurably(input.userId, scope))?.id).toBe(pending.id);
    const prepared = preparePlannedConversationExecution({ ...input, pendingConfirmation: pending });
    expect(prepared.kind).toBe('new'); expect(prepared.state?.activeRequestId).toBe(input.requestId);
  });
  it('resumes the task named by an accepted bound confirmation', async () => {
    const previous = await unfinished(); const input = await accepted('Okay.', previous.input);
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', orgId: '', conversationId: input.conversationId, taskId: previous.taskId });
    const pending = await recordPendingConfirmationDurably(input.userId, 'web_search', { query: 'fixture' }, 'chat', scope);
    expect((await getPendingConfirmationDurably(input.userId, scope))?.id).toBe(pending.id);
    const prepared = preparePlannedConversationExecution({ ...input, pendingConfirmation: pending });
    expect(prepared.kind).toBe('resume'); expect(prepared.state?.taskId).toBe(previous.taskId);
    expect(prepared.state?.activeRequestId).toBe(input.requestId);
  });
  it('cannot prepare fresh or cleanup work without the admitted conversation', async () => {
    const input = await accepted('Search the public web for synthetic cloud examples.');
    const before = JSON.stringify(readDB().conversationActionTasks);
    for (const acceptedRuntimeCleanup of [false, true]) expect(preparePlannedConversationExecution({ ...input, conversationId: undefined, acceptedRuntimeCleanup })).toMatchObject({ kind: 'conversation', state: null });
    expect(JSON.stringify(readDB().conversationActionTasks)).toBe(before);
  });
  it('does not acquire an action task for an entry-owned observational exit', async () => {
    const input = await accepted('Search the public web for synthetic cloud examples.');
    const before = JSON.stringify(readDB().conversationActionTasks);
    expect(preparePlannedConversationExecution({ ...input, observationOnly: true, bindConversationTurn: true })).toMatchObject({ kind: 'conversation', state: null });
    expect(JSON.stringify(readDB().conversationActionTasks)).toBe(before);
  });
  it('rejects the old accepted task after a different task becomes the current durable pointer', async () => {
    const previous = await unfinished(); const delayed = await accepted('Continue the unfinished task.', previous.input);
    expect(delayed.execution.taskRelation.taskId).toBe(previous.taskId);
    const later = await accepted('Start a separate task: Search the public web for synthetic ocean examples.', previous.input);
    const latest = preparePlannedConversationExecution(later);
    addMessageIdempotent({ userId: later.userId, conversationId: later.conversationId, agentId: 'lumi', requestId: later.requestId, source: 'planned-fixture', channel: 'chat', domain: 'personal', orgId: '', role: 'assistant', content: 'The later task is still unfinished.',
      terminalTaskDisposition: { outcome: 'blocked', taskId: latest.state!.taskId, requestId: later.requestId, reason: 'Later task awaits evidence.' },
    });
    await flushDBOrThrow();
    const before = JSON.stringify(readDB().conversationActionTasks.filter((row: any) => row.conversationId === later.conversationId));
    expect(preparePlannedConversationExecution(delayed)).toMatchObject({ bindingFailure: 'stale', diagnosticCode: 'conversation_action_task_binding_stale' });
    expect(getConversationForScope(later.conversationId, later.userId, 'personal', '')?.actionContinuationState?.taskId).toBe(latest.state!.taskId);
    expect(JSON.stringify(readDB().conversationActionTasks.filter((row: any) => row.conversationId === later.conversationId))).toBe(before);
  });
  it('cannot resume a planned task using a durable grant that names a different task', async () => {
    const previous = await unfinished(); const input = await accepted('Continue the unfinished task.', previous.input);
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', orgId: '', conversationId: input.conversationId, taskId: 'another-task' });
    const pending = await recordPendingConfirmationDurably(input.userId, 'web_search', { query: 'fixture' }, 'chat', scope);
    const before = JSON.stringify(readDB().conversationActionTasks.filter((row: any) => row.conversationId === input.conversationId));
    expect(preparePlannedConversationExecution({ ...input, pendingConfirmation: pending })).toMatchObject({ bindingFailure: 'stale' });
    expect(JSON.stringify(readDB().conversationActionTasks.filter((row: any) => row.conversationId === input.conversationId))).toBe(before);
    expect((await getPendingConfirmationDurably(input.userId, scope))?.id).toBe(pending.id);
  });
  it('keeps a taskless grant separate from an unrelated unfinished task', async () => {
    const previous = await unfinished(); const input = await accepted('Okay.', previous.input);
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', orgId: '', conversationId: input.conversationId });
    const pending = await recordPendingConfirmationDurably(input.userId, 'web_search', { query: 'a separately approved observation' }, 'chat', scope);
    const prepared = preparePlannedConversationExecution({ ...input, pendingConfirmation: pending });
    expect(prepared.kind).toBe('new'); expect(prepared.state?.taskId).not.toBe(previous.taskId);
    expect(prepared.state?.activeRequestId).toBe(input.requestId);
  });
  it('rejects a mismatched request identity before any task or turn is changed', async () => {
    const input = await accepted('Search the public web for synthetic cloud examples.');
    const before = JSON.stringify([readDB().conversationActionTasks, readDB().conversationActionTurns]);
    expect(() => preparePlannedConversationExecution({ ...input, requestId: 'another-request' })).toThrow('accepted turn');
    expect(JSON.stringify([readDB().conversationActionTasks, readDB().conversationActionTurns])).toBe(before);
  });
});
