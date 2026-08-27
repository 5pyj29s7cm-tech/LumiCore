import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  convergeConversationActionRequestLease,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  supersedeConversationActionExecutionRequest,
} from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

function prepareRequest(label: string) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `request-supersession-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = `request-${label}-${nonce}`;
  const userText = `Run the ${label} task.`;
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
    conversationId: conversation.id,
    userId,
    requestId,
    taskId: prepared.state!.taskId!,
  };
}

function taskRow(taskId: string): any {
  return readDB().conversationActionTasks.find((row: any) => row.id === taskId);
}

function conversationRow(conversationId: string, userId: string): any {
  return readDB().conversations.find((row: any) => (
    row.id === conversationId && row.userId === userId
  ));
}

function setRequestTaskStatus(
  request: ReturnType<typeof prepareRequest>,
  status: 'executing' | 'waiting_confirmation',
): void {
  const db = readDB();
  const task = db.conversationActionTasks.find((row: any) => row.id === request.taskId);
  const conversation = db.conversations.find((row: any) => (
    row.id === request.conversationId && row.userId === request.userId
  ));
  const context = JSON.parse(String(task.context || '{}'));
  const actionState = {
    ...(context.actionState || {}),
    taskId: request.taskId,
    status,
    unfinished: true,
    activeRequestId: request.requestId,
  };
  task.status = status;
  task.activeRequestId = request.requestId;
  task.context = JSON.stringify({ ...context, actionState });
  conversation.actionContinuationState = actionState;
  writeDB(db);
}

describe('conversation action request supersession', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it.each(['executing', 'waiting_confirmation'] as const)(
    'atomically supersedes a %s request without cancelling or quarantining its task',
    status => {
      const request = prepareRequest(`atomic-${status}`);
      setRequestTaskStatus(request, status);
      const input = {
        conversationId: request.conversationId,
        userId: request.userId,
        requestId: request.requestId,
        expectedTaskId: request.taskId,
        reason: 'Exact voice continuation was accepted.',
        now: '2026-08-27T11:00:00.000Z',
      };

      expect(supersedeConversationActionExecutionRequest(input)).toMatchObject({
        requestedOutcome: 'superseded',
        effectiveOutcome: 'superseded',
        taskId: request.taskId,
        taskStatus: 'blocked',
        actionTurnStatus: 'cancelled',
        converged: true,
        changed: true,
        superseded: true,
      });
      expect(getConversationActionTurn(request)).toMatchObject({
        taskId: request.taskId,
        status: 'cancelled',
        terminalMessageId: '',
        terminalReason: expect.stringMatching(/^superseded:/),
        leaseOwnerId: '',
      });
      expect(taskRow(request.taskId)).toMatchObject({
        status: 'blocked',
        activeRequestId: '',
        completedAt: '',
      });
      const context = JSON.parse(String(taskRow(request.taskId).context || '{}'));
      expect(context.terminalPersistence).toBeUndefined();
      expect(context.actionState?.terminalPersistence).toBeUndefined();
      expect(context.actionState?.latestBlocker || '').toBe('');
      expect(context.taskFinalization).toMatchObject({
        outcome: 'blocked',
        requestDisposition: 'superseded',
        reason: expect.stringMatching(/^superseded:/),
      });
      expect(conversationRow(request.conversationId, request.userId)).toMatchObject({
        actionContinuationState: {
          taskId: request.taskId,
          status: 'blocked',
          unfinished: true,
        },
      });
      expect(conversationRow(request.conversationId, request.userId).pendingActionContinuation)
        .toBeUndefined();

      const taskRevision = taskRow(request.taskId).revision;
      const turnRevision = getConversationActionTurn(request)!.revision;
      expect(supersedeConversationActionExecutionRequest(input)).toMatchObject({
        superseded: true,
        converged: true,
        changed: false,
      });
      expect(taskRow(request.taskId).revision).toBe(taskRevision);
      expect(getConversationActionTurn(request)!.revision).toBe(turnRevision);
    },
  );

  it('lets a successor request resume the same task and makes an old finally request-scoped', () => {
    const request = prepareRequest('successor');
    setRequestTaskStatus(request, 'executing');
    expect(supersedeConversationActionExecutionRequest({
      conversationId: request.conversationId,
      userId: request.userId,
      requestId: request.requestId,
      expectedTaskId: request.taskId,
    }).superseded).toBe(true);

    const nextRequestId = `successor-${request.requestId}`;
    const nextUserText = 'Continue the exact corrected task.';
    const nextUserMessageId = addMessageIdempotent({
      userId: request.userId,
      agentId: 'lumi',
      conversationId: request.conversationId,
      role: 'user',
      content: nextUserText,
      requestId: nextRequestId,
      deferActionPreparation: true,
      domain: 'personal',
      source: 'test',
      channel: 'voice',
    });
    const resumed = prepareConversationActionExecution({
      conversationId: request.conversationId,
      userId: request.userId,
      userText: nextUserText,
      requestId: nextRequestId,
      userMessageId: nextUserMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
      forceResume: true,
    });
    expect(resumed).toMatchObject({
      kind: 'resume',
      state: {
        taskId: request.taskId,
        activeRequestId: nextRequestId,
        status: 'planning',
        unfinished: true,
      },
    });
    expect(getConversationActionTurn({
      conversationId: request.conversationId,
      userId: request.userId,
      requestId: nextRequestId,
    })).toMatchObject({ status: 'leased', taskId: request.taskId });

    const delayedOldFinally = convergeConversationActionRequestLease(request);
    expect(delayedOldFinally).toMatchObject({
      finalStatus: 'cancelled',
      converged: true,
      reason: 'already_converged',
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: 'planning',
      activeRequestId: nextRequestId,
    });
    expect(getConversationActionTurn({
      conversationId: request.conversationId,
      userId: request.userId,
      requestId: nextRequestId,
    })).toMatchObject({ status: 'leased', taskId: request.taskId });
  });

  it('fails closed on an expected task mismatch without cancelling the real task', () => {
    const request = prepareRequest('expected-task-mismatch');
    setRequestTaskStatus(request, 'executing');
    const before = { ...taskRow(request.taskId) };
    const result = supersedeConversationActionExecutionRequest({
      conversationId: request.conversationId,
      userId: request.userId,
      requestId: request.requestId,
      expectedTaskId: `different-${request.taskId}`,
    });

    expect(result).toMatchObject({
      superseded: false,
      effectiveOutcome: 'persistence_unknown',
      converged: false,
      evidence: { task: 'mismatch' },
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: before.status,
      activeRequestId: before.activeRequestId,
      revision: before.revision,
    });
    expect(getConversationActionTurn(request)?.status).not.toBe('cancelled');
  });

  it('never clears or cancels an explicit newer task owner', () => {
    const request = prepareRequest('newer-owner');
    setRequestTaskStatus(request, 'executing');
    const newerRequestId = `newer-${request.requestId}`;
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === request.taskId);
    const conversation = db.conversations.find((row: any) => row.id === request.conversationId);
    const context = JSON.parse(String(task.context || '{}'));
    const newerState = {
      ...(context.actionState || {}),
      status: 'executing',
      unfinished: true,
      activeRequestId: newerRequestId,
    };
    task.activeRequestId = newerRequestId;
    task.context = JSON.stringify({ ...context, actionState: newerState });
    conversation.actionContinuationState = newerState;
    writeDB(db);
    const beforeRevision = taskRow(request.taskId).revision;

    const result = supersedeConversationActionExecutionRequest({
      conversationId: request.conversationId,
      userId: request.userId,
      requestId: request.requestId,
      expectedTaskId: request.taskId,
    });
    expect(result).toMatchObject({
      superseded: false,
      effectiveOutcome: 'persistence_unknown',
      converged: false,
      reason: 'task_active_request_mismatch',
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: 'executing',
      activeRequestId: newerRequestId,
      revision: beforeRevision,
    });
    expect(conversationRow(request.conversationId, request.userId).actionContinuationState)
      .toMatchObject({ taskId: request.taskId, activeRequestId: newerRequestId });
    expect(getConversationActionTurn(request)?.status).not.toBe('cancelled');
  });
});
