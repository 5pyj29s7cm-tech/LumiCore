import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import { getConversationActionStateByTaskId } from '../server/conversation/action_ledger';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import {
  addMessageIdempotent,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
} from '../server/conversation/manager';

const TOOL_POLICY = {
  allowedTools: ['search_files', 'read_file'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

function prepareRequest(label: string) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const userId = `terminal-disposition-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = `request-${label}-${nonce}`;
  const userText = `Investigate lifecycle evidence for ${label}.`;
  const userMessageId = addMessageIdempotent({
    userId,
    agentId: 'lumi',
    conversationId: conversation.id,
    role: 'user',
    content: userText,
    requestId,
    deferActionPreparation: true,
    domain: 'personal',
    source: 'test',
    channel: 'voice',
  });
  const prepared = prepareConversationActionExecution({
    conversationId: conversation.id,
    userId,
    userText,
    requestId,
    userMessageId,
    toolPolicy: TOOL_POLICY,
    forceTask: true,
  });
  expect(prepared.state?.taskId).toBeTruthy();
  return {
    userId,
    conversationId: conversation.id,
    requestId,
    taskId: prepared.state!.taskId!,
  };
}

function successRecord(scope: ReturnType<typeof prepareRequest>, suffix = 'search') {
  return {
    id: `success-${suffix}-${scope.requestId}`,
    key: `search_files:${suffix}`,
    name: 'search_files',
    arguments: { directory: 'isolated', pattern: `${suffix}.txt` },
    result: '[]',
    error: '',
    outcome: 'success',
    terminalVerification: {
      status: 'verified',
      strategy: 'terminal_receipt',
      reason: 'The isolated search returned a terminal observation.',
    },
    adapterStarted: true,
    taskId: scope.taskId,
    requestId: scope.requestId,
    turnId: scope.requestId,
    recordedAt: new Date().toISOString(),
  };
}

function failureRecord(scope: ReturnType<typeof prepareRequest>) {
  return {
    id: `failure-read-${scope.requestId}`,
    key: 'read_file:missing',
    name: 'read_file',
    arguments: { path: 'missing.txt' },
    result: '',
    error: 'The requested file was not found.',
    outcome: 'failure',
    terminalVerification: {
      status: 'failed',
      strategy: 'terminal_receipt',
      reason: 'No file content was returned.',
    },
    adapterStarted: false,
    taskId: scope.taskId,
    requestId: scope.requestId,
    turnId: scope.requestId,
    recordedAt: new Date().toISOString(),
  };
}

function persistAssistant(
  scope: ReturnType<typeof prepareRequest>,
  records: any[],
  disposition?: { outcome: 'blocked'; taskId: string; requestId: string; reason: string },
) {
  return addMessageIdempotent({
    userId: scope.userId,
    agentId: 'lumi',
    conversationId: scope.conversationId,
    role: 'assistant',
    content: disposition
      ? 'The request stopped at a verified blocker and can be resumed.'
      : 'The request produced its terminal response.',
    requestId: scope.requestId,
    domain: 'personal',
    source: 'test',
    channel: 'voice',
    taskIntent: 'task',
    toolCalls: records,
    terminalTaskDisposition: disposition,
  });
}

function taskRow(scope: ReturnType<typeof prepareRequest>): any {
  return (readDB().conversationActionTasks || []).find((row: any) => (
    row.id === scope.taskId
    && row.conversationId === scope.conversationId
    && row.userId === scope.userId
  ));
}

describe('transport-neutral terminal task disposition', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('keeps partial success plus a terminal failure blocked while archiving every receipt', () => {
    const scope = prepareRequest('partial-then-failed');
    const successfulSearch = successRecord(scope);
    const failedRead = failureRecord(scope);
    const reason = `Final read failed: ${'bounded '.repeat(80)}`;

    persistAssistant(scope, [successfulSearch, failedRead], {
      outcome: 'blocked',
      taskId: scope.taskId,
      requestId: scope.requestId,
      reason,
    });

    const state = getConversationActionStateByTaskId(readDB(), scope);
    expect(state).toMatchObject({
      taskId: scope.taskId,
      status: 'blocked',
      unfinished: true,
    });
    expect(state?.activeRequestId).toBeUndefined();
    expect(state?.completionSource).toBeUndefined();
    expect(state?.latestBlocker).toMatch(/^Final read failed:/u);
    expect(state?.latestBlocker.length).toBeLessThanOrEqual(380);
    expect(state?.receipts.map(receipt => receipt.name)).toEqual(
      expect.arrayContaining(['search_files', 'read_file']),
    );
    expect(taskCompletionFromReceipts(state?.goal || '', state?.receipts || []).complete).toBe(true);

    const archived = (readDB().conversationActionReceipts || []).filter((row: any) => (
      row.taskId === scope.taskId && row.requestId === scope.requestId
    ));
    expect(archived.map((row: any) => row.toolName)).toEqual(
      expect.arrayContaining(['search_files', 'read_file']),
    );
    expect(taskRow(scope)).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      completionSource: '',
    });
    const finalization = JSON.parse(taskRow(scope).context).taskFinalization;
    expect(finalization).toMatchObject({
      outcome: 'blocked',
      requestId: scope.requestId,
    });
    expect(finalization.reason.length).toBeLessThanOrEqual(380);
    expect(getConversationActionTurn(scope)).toMatchObject({
      status: 'terminal',
      taskId: scope.taskId,
      requestId: scope.requestId,
    });
  });

  it('applies the exact blocked disposition even when the same batch contains a stale receipt', () => {
    const scope = prepareRequest('mixed-current-and-stale');
    const staleRequestId = `previous-${scope.requestId}`;
    const staleReceipt = {
      ...successRecord(scope, 'stale'),
      id: `stale-${scope.requestId}`,
      key: 'search_files:stale-request',
      requestId: staleRequestId,
      turnId: staleRequestId,
    };
    const currentReceipt = successRecord(scope, 'current');
    const reason = 'The current request reached a verified blocker after its observation.';

    persistAssistant(scope, [staleReceipt, currentReceipt], {
      outcome: 'blocked',
      taskId: scope.taskId,
      requestId: scope.requestId,
      reason,
    });

    expect(getConversationActionStateByTaskId(readDB(), scope)).toMatchObject({
      taskId: scope.taskId,
      status: 'blocked',
      unfinished: true,
      latestBlocker: reason,
    });
    expect(taskRow(scope)).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      completionSource: '',
    });
    expect(JSON.parse(taskRow(scope).context).taskFinalization).toMatchObject({
      outcome: 'blocked',
      requestId: scope.requestId,
      reason,
    });

    const archived = (readDB().conversationActionReceipts || []).filter((row: any) => (
      row.taskId === scope.taskId
    ));
    expect(archived).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: staleRequestId, toolName: 'search_files' }),
      expect.objectContaining({ requestId: scope.requestId, toolName: 'search_files' }),
    ]));
    expect(getConversationActionTurn(scope)).toMatchObject({
      status: 'terminal',
      taskId: scope.taskId,
      requestId: scope.requestId,
    });
  });

  it('keeps the default all-success inference completed', () => {
    const scope = prepareRequest('all-success');
    persistAssistant(scope, [successRecord(scope, 'first'), successRecord(scope, 'second')]);

    expect(getConversationActionStateByTaskId(readDB(), scope)).toMatchObject({
      taskId: scope.taskId,
      status: 'completed',
      unfinished: false,
      completionSource: 'tool_receipt',
    });
    expect(taskRow(scope)).toMatchObject({
      status: 'completed',
      activeRequestId: '',
      completionSource: 'tool_receipt',
    });
  });

  it('preserves the previous receipt inference when no disposition is supplied', () => {
    const scope = prepareRequest('legacy-inference');
    persistAssistant(scope, [successRecord(scope), failureRecord(scope)]);

    expect(getConversationActionStateByTaskId(readDB(), scope)).toMatchObject({
      taskId: scope.taskId,
      status: 'completed',
      unfinished: false,
      completionSource: 'tool_receipt',
    });
    const archived = (readDB().conversationActionReceipts || []).filter((row: any) => (
      row.taskId === scope.taskId && row.requestId === scope.requestId
    ));
    expect(archived).toHaveLength(2);
  });

  it('rejects wrong request/task fences and cannot rewrite another request completed task', () => {
    const wrongRequest = prepareRequest('wrong-request');
    persistAssistant(wrongRequest, [successRecord(wrongRequest)], {
      outcome: 'blocked',
      taskId: wrongRequest.taskId,
      requestId: `other-${wrongRequest.requestId}`,
      reason: 'Must not apply across request ownership.',
    });
    expect(taskRow(wrongRequest).status).toBe('completed');

    const wrongTask = prepareRequest('wrong-task');
    persistAssistant(wrongTask, [successRecord(wrongTask)], {
      outcome: 'blocked',
      taskId: `other-${wrongTask.taskId}`,
      requestId: wrongTask.requestId,
      reason: 'Must not apply across task ownership.',
    });
    expect(taskRow(wrongTask).status).toBe('completed');

    const completed = taskRow(wrongTask);
    const completedFinalization = JSON.parse(completed.context).taskFinalization;
    addMessageIdempotent({
      userId: wrongTask.userId,
      agentId: 'lumi',
      conversationId: wrongTask.conversationId,
      role: 'assistant',
      content: 'Late terminal from another request.',
      requestId: `late-${wrongTask.requestId}`,
      domain: 'personal',
      source: 'test',
      channel: 'voice',
      taskIntent: 'task',
      terminalTaskDisposition: {
        outcome: 'blocked',
        taskId: wrongTask.taskId,
        requestId: `late-${wrongTask.requestId}`,
        reason: 'A late request must not reverse a completed task.',
      },
    });
    expect(taskRow(wrongTask)).toMatchObject({
      status: 'completed',
      completionSource: 'tool_receipt',
    });
    expect(JSON.parse(taskRow(wrongTask).context).taskFinalization)
      .toEqual(completedFinalization);
  });
});
