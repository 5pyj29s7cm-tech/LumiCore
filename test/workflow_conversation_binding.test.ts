import './helpers';
import { beforeAll, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'), makeLLMCall: model.call,
}));
import { initDatabase, readDB } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { inspectPersistedToolExecutionReceipt } from '../server/tools/persisted_execution_receipt';
import { runWithTools } from '../server/llm/adapter';
import { resolveConversationWorkflowRun } from '../server/workflows/conversation_binding';
import { getWorkflowRun, listWorkflowRuns } from '../server/workflows/runtime';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolContext } from '../server/tools/types';

beforeAll(async () => { await initDatabase(); });

it('observes the exact durable run before asking the model to continue, then returns verified completion without another model call', async () => {
  const registry = new ToolRegistry(); registerWorkflowTools(registry);
  const effect = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed', total: 72 }));
  registry.register({ name: 'binding_fixture', description: 'fixture', permission: 'public', securityLevel: 'safe', parameters: {}, handler: effect });
  const context: ToolContext = { userId: 'binding-user', conversationId: 'binding-conversation', taskId: 'binding-task',
    requestId: 'binding-start', turnId: 'binding-start', domain: 'personal', orgId: '', authenticated: true, localExecution: true,
    executionBoundary: 'trusted_local', requestConfirmation: async () => true,
    toolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 5 } };
  const saved = JSON.parse(await registry.execute('save_workflow', { name: 'binding-workflow', steps: [{ tool: 'binding_fixture', args: {} }] }, context));
  await registry.execute('publish_workflow', { name: saved.name, expectedHash: saved.hash }, context);
  const record = await executeToolCall({ registry, name: 'run_workflow', arguments: { name: saved.name }, context });
  expect(record.envelope?.status).toBe('verified_success');
  const started = JSON.parse(record.result!);
  await vi.waitFor(() => expect(getWorkflowRun(started.runId, context.userId!)?.status).toBe('waiting_confirmation'));
  const db = readDB();
  db.conversationActionTasks.push({ id: context.taskId, conversationId: context.conversationId, userId: context.userId,
    domain: 'personal', orgId: '', parentTaskId: '', rootUserMessageId: 'root', intentKind: 'workflow', operation: 'execute',
    goal: 'Run binding-workflow', target: '', status: 'waiting_confirmation', blocker: '', activeRequestId: '', completionSource: '',
    context: '{}', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: '' } as any);
  const envelope = record.envelope!;
  const row = { taskId: envelope.taskId, conversationId: context.conversationId, turnId: envelope.turnId, requestId: envelope.requestId,
    idempotencyKey: envelope.idempotencyKey, toolName: envelope.toolName, targetIdentity: envelope.targetIdentity,
    outcome: envelope.status, envelope: JSON.stringify(envelope), id: 'binding-receipt', inputDigest: '', createdAt: new Date().toISOString() } as any;
  db.conversationActionReceipts.push(row);
  expect(inspectPersistedToolExecutionReceipt(row)).toMatchObject({ valid: true, explicitlyTerminalVerified: true });
  expect(resolveConversationWorkflowRun(context)?.runId).toBe(started.runId);
  for (const mismatch of [{ userId: 'other' }, { conversationId: 'other' }, { taskId: 'other' }, { domain: 'work', orgId: 'other' }]) {
    expect(resolveConversationWorkflowRun({ ...context, ...mismatch })).toBeNull();
  }
  expect(resolveConversationWorkflowRun(context, { ...db, conversationActionReceipts: [{ ...row, requestId: 'forged' }] })).toBeNull();
  const duplicate = { ...envelope, result: { ...(envelope.result as any), runId: 'second-run' } };
  expect(resolveConversationWorkflowRun(context, { ...db, conversationActionReceipts: [row, { ...row, envelope: JSON.stringify(duplicate) }] },
    id => ({ ...getWorkflowRun(started.runId, context.userId!)!, runId: id }))).toBeNull();
  let calls = 0;
  model.call.mockImplementation(async (messages: any[]) => {
    if (++calls === 1) {
      const output = [...messages].reverse().find(item => item.role === 'tool' && item.name === 'get_workflow_run').content;
      const observed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
      expect(observed.runId).toBe(started.runId);
      expect(observed.status).toBe('waiting_confirmation');
      expect(effect).not.toHaveBeenCalled();
      return { text: null, toolCalls: [{ id: 'approve-current', name: 'decide_workflow_confirmation', arguments: {
        runId: observed.runId, expectedRevision: observed.revision, confirmationId: observed.confirmation.confirmationId, approved: true,
      } }] };
    }
    if (calls === 2) {
      await vi.waitFor(() => expect(getWorkflowRun(started.runId, context.userId!)?.status).toBe('completed'));
      return { text: null, toolCalls: [{ id: 'verify-current', name: 'get_workflow_run', arguments: { runId: started.runId } }] };
    }
    throw new Error('The verified completion must not need another model call.');
  });
  const text = '继续完成刚才未完成的任务。';
  const result = await runWithTools([{ role: 'user', content: text }], registry,
    { provider: 'deepseek', model: 'fixture', requestId: 'binding-continue' }, undefined, 5,
    () => null, () => null, () => null, () => null, () => null, undefined,
    { ...context, requestId: 'binding-continue', turnId: 'binding-continue', trustedActionContinuation: true, actionIntent: text,
      currentTurnExecutionRequested: true, routedTaskText: 'Run the published workflow binding-workflow and complete its remaining steps.' });
  expect(result.toolCalls.map(item => ({ name: item.name, error: item.error }))).toEqual([
    { name: 'get_workflow_run', error: undefined }, { name: 'decide_workflow_confirmation', error: undefined }, { name: 'get_workflow_run', error: undefined }]);
  expect(result.toolCalls[0].executionOrigin).toBe('deterministic_route');
  expect(effect).toHaveBeenCalledTimes(1);
  expect(listWorkflowRuns(context.userId!)).toHaveLength(1);
  expect(calls).toBe(2);
  expect(finalizeLumiResponse({ taskText: text, responseText: result.text, toolRecords: result.toolCalls,
    taskId: context.taskId, requestId: 'binding-continue', source: 'chat' })).toMatchObject({ blocked: false, reason: 'workflow_completed' });
});
