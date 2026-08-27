import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  createDurableForegroundReleaseGate,
  finalizeForegroundRequest,
  finalizeForegroundRequestDurably,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  startConversationActionExecutionHeartbeat,
  type FinalizeForegroundRequestInput,
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
  const userId = `foreground-finalize-${label}-${nonce}`;
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
    channel: 'chat',
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
  const taskId = prepared.state!.taskId!;
  expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
    .toMatchObject({ status: 'leased', taskId });
  return { conversationId: conversation.id, userId, requestId, taskId };
}

function persistExactAssistant(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId?: string;
}): string {
  const db = readDB();
  const now = new Date().toISOString();
  const assistantMessageId = input.assistantMessageId || `assistant-${input.requestId}`;
  db.interactions.push({
    id: assistantMessageId,
    userId: input.userId,
    agentId: 'lumi',
    conversationId: input.conversationId,
    message: 'The foreground request reached its durable assistant boundary.',
    response: '',
    role: 'assistant',
    requestId: input.requestId,
    domain: 'personal',
    source: 'test',
    channel: 'chat',
    timestamp: now,
    receivedAt: now,
  });
  writeDB(db);
  return assistantMessageId;
}

function taskRow(taskId: string): any {
  return readDB().conversationActionTasks.find((row: any) => row.id === taskId);
}

function conversationRow(conversationId: string, userId: string): any {
  return readDB().conversations.find((row: any) => (
    row.id === conversationId && row.userId === userId
  ));
}

describe('atomic foreground request finalization', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('publishes terminal only from an exact assistant and repeats without mutations', () => {
    const request = prepareRequest('terminal');
    const assistantMessageId = persistExactAssistant(request);
    const input: FinalizeForegroundRequestInput = {
      ...request,
      outcome: 'terminal',
      assistantMessageId,
      assistantState: 'Completed with a durable assistant transcript.',
      now: '2026-08-27T10:00:00.000Z',
    };

    const first = finalizeForegroundRequest(input);
    expect(first).toMatchObject({
      ...request,
      requestedOutcome: 'terminal',
      effectiveOutcome: 'terminal',
      taskStatus: 'completed',
      actionTurnStatus: 'terminal',
      converged: true,
      changed: true,
      evidence: {
        conversation: 'found',
        actionTurn: 'found',
        task: 'found',
        assistant: 'found',
      },
      localOwnerCleared: true,
    });
    expect(taskRow(request.taskId)).toMatchObject({ status: 'completed', activeRequestId: '' });
    expect(conversationRow(request.conversationId, request.userId).actionContinuationState)
      .toBeUndefined();
    expect(conversationRow(request.conversationId, request.userId).pendingActionContinuation)
      .toBeUndefined();
    expect(getConversationActionTurn(request)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
      leaseOwnerId: '',
    });

    const taskRevision = taskRow(request.taskId).revision;
    const turnRevision = getConversationActionTurn(request)!.revision;
    expect(finalizeForegroundRequest(input)).toMatchObject({
      taskStatus: 'completed',
      actionTurnStatus: 'terminal',
      converged: true,
      changed: false,
      localOwnerCleared: false,
    });
    expect(taskRow(request.taskId).revision).toBe(taskRevision);
    expect(getConversationActionTurn(request)!.revision).toBe(turnRevision);
  });

  it('keeps a task blocked/resumable but quarantines a request with no assistant', () => {
    const request = prepareRequest('blocked-without-assistant');
    const input: FinalizeForegroundRequestInput = {
      ...request,
      outcome: 'blocked',
      reason: 'Executor raised before an assistant transcript was persisted.',
      now: '2026-08-27T10:01:00.000Z',
    };

    expect(finalizeForegroundRequest(input)).toMatchObject({
      effectiveOutcome: 'blocked',
      taskStatus: 'blocked',
      actionTurnStatus: 'persistence_unknown',
      converged: true,
      changed: true,
      evidence: { assistant: 'unbound' },
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      completedAt: '',
    });
    expect(conversationRow(request.conversationId, request.userId).actionContinuationState)
      .toMatchObject({ taskId: request.taskId, status: 'blocked', unfinished: true });
    expect(conversationRow(request.conversationId, request.userId).actionContinuationState.activeRequestId)
      .toBeUndefined();
    expect(getConversationActionTurn(request)).toMatchObject({
      status: 'persistence_unknown',
      terminalMessageId: '',
      leaseOwnerId: '',
    });

    const taskRevision = taskRow(request.taskId).revision;
    const turnRevision = getConversationActionTurn(request)!.revision;
    expect(finalizeForegroundRequest(input)).toMatchObject({ changed: false, converged: true });
    expect(taskRow(request.taskId).revision).toBe(taskRevision);
    expect(getConversationActionTurn(request)!.revision).toBe(turnRevision);
  });

  it('rolls an unproved terminal request back to persistence_unknown', () => {
    const request = prepareRequest('terminal-without-assistant');
    const result = finalizeForegroundRequest({
      ...request,
      outcome: 'terminal',
      now: '2026-08-27T10:02:00.000Z',
    });

    expect(result).toMatchObject({
      requestedOutcome: 'terminal',
      effectiveOutcome: 'persistence_unknown',
      taskStatus: 'blocked',
      actionTurnStatus: 'persistence_unknown',
      reason: 'assistant_unbound',
      evidence: { assistant: 'unbound' },
    });
    expect(taskRow(request.taskId)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    const context = JSON.parse(taskRow(request.taskId).context);
    expect(context.terminalPersistence).toMatchObject({
      status: 'persistence_unknown',
      requestId: request.requestId,
    });
  });

  it('cancels task, live pointer, pending projection, and action turn idempotently', () => {
    const request = prepareRequest('cancelled');
    const input: FinalizeForegroundRequestInput = {
      ...request,
      outcome: 'cancelled',
      reason: 'Cancelled by the user.',
      now: '2026-08-27T10:03:00.000Z',
    };

    expect(finalizeForegroundRequest(input)).toMatchObject({
      effectiveOutcome: 'cancelled',
      taskStatus: 'cancelled',
      actionTurnStatus: 'cancelled',
      converged: true,
      changed: true,
    });
    expect(taskRow(request.taskId)).toMatchObject({ status: 'cancelled', activeRequestId: '' });
    expect(conversationRow(request.conversationId, request.userId).actionContinuationState)
      .toBeUndefined();
    expect(conversationRow(request.conversationId, request.userId).pendingActionContinuation)
      .toBeUndefined();
    expect(finalizeForegroundRequest(input)).toMatchObject({ changed: false, converged: true });
  });

  it('fails closed when expectedTaskId disagrees with the immutable turn binding', () => {
    const request = prepareRequest('task-mismatch');
    const assistantMessageId = persistExactAssistant(request);
    const beforeTask = { ...taskRow(request.taskId) };

    const result = finalizeForegroundRequest({
      ...request,
      expectedTaskId: `different-${request.taskId}`,
      outcome: 'terminal',
      assistantMessageId,
      now: '2026-08-27T10:04:00.000Z',
    });

    expect(result).toMatchObject({
      effectiveOutcome: 'persistence_unknown',
      taskId: request.taskId,
      taskStatus: beforeTask.status,
      actionTurnStatus: 'persistence_unknown',
      converged: false,
      reason: 'expected_task_binding_mismatch',
      evidence: { task: 'mismatch', assistant: 'found' },
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: beforeTask.status,
      activeRequestId: beforeTask.activeRequestId,
      revision: beforeTask.revision,
    });
  });

  it('fails closed on ambiguous assistant evidence instead of guessing a terminal row', () => {
    const request = prepareRequest('ambiguous-assistant');
    const assistantMessageId = persistExactAssistant(request);
    const db = readDB();
    const assistant = db.interactions.find((row: any) => row.id === assistantMessageId);
    // Deliberately corrupt only the in-memory fixture. Remove the duplicate
    // synchronously before the debounced SQLite snapshot can enforce its PK.
    db.interactions.push({ ...assistant });

    const result = finalizeForegroundRequest({
      ...request,
      outcome: 'terminal',
      assistantMessageId,
      now: '2026-08-27T10:05:00.000Z',
    });
    expect(result).toMatchObject({
      effectiveOutcome: 'persistence_unknown',
      taskStatus: 'blocked',
      actionTurnStatus: 'persistence_unknown',
      reason: 'assistant_ambiguous',
      evidence: { assistant: 'ambiguous' },
    });
    const duplicateIndex = db.interactions.map((row: any) => row.id).lastIndexOf(assistantMessageId);
    db.interactions.splice(duplicateIndex, 1);
    writeDB(db);
  });

  it('quarantines the request and never reports convergence when its task row is missing', () => {
    const request = prepareRequest('missing-task');
    const db = readDB();
    db.conversationActionTasks = db.conversationActionTasks.filter((row: any) => (
      row.id !== request.taskId
    ));
    writeDB(db);

    const result = finalizeForegroundRequest({
      ...request,
      outcome: 'blocked',
      reason: 'The exact durable task row is missing.',
      now: '2026-08-27T10:06:00.000Z',
    });
    expect(result).toMatchObject({
      effectiveOutcome: 'persistence_unknown',
      actionTurnStatus: 'persistence_unknown',
      converged: false,
      evidence: { task: 'missing' },
    });
    expect(getConversationActionTurn(request)).toMatchObject({
      status: 'persistence_unknown',
      leaseOwnerId: '',
    });
  });

  it('quarantines duplicate task bindings without mutating either ambiguous task row', () => {
    const request = prepareRequest('ambiguous-task');
    const db = readDB();
    const original = taskRow(request.taskId);
    // As above, this duplicate exists only for the synchronous ambiguity
    // check and is removed before a SQLite snapshot is allowed to run.
    db.conversationActionTasks.push({ ...original });

    const result = finalizeForegroundRequest({
      ...request,
      outcome: 'terminal',
      now: '2026-08-27T10:07:00.000Z',
    });
    expect(result).toMatchObject({
      effectiveOutcome: 'persistence_unknown',
      actionTurnStatus: 'persistence_unknown',
      converged: false,
      evidence: { task: 'ambiguous', assistant: 'unbound' },
    });
    const duplicates = readDB().conversationActionTasks.filter((row: any) => row.id === request.taskId);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((row: any) => row.status !== 'completed')).toBe(true);
    db.conversationActionTasks.splice(db.conversationActionTasks.lastIndexOf(duplicates[1]), 1);
    writeDB(db);
  });

  it('uses expectedTaskId only to release an exact orphaned task request fail-closed', () => {
    const request = prepareRequest('missing-turn-exact-task');
    const db = readDB();
    db.conversationActionTurns = db.conversationActionTurns.filter((row: any) => !(
      row.conversationId === request.conversationId
      && row.userId === request.userId
      && row.requestId === request.requestId
    ));
    writeDB(db);

    const result = finalizeForegroundRequest({
      ...request,
      expectedTaskId: request.taskId,
      outcome: 'blocked',
      reason: 'The action-turn row is missing; the exact task request must stop owning execution.',
      now: '2026-08-27T10:08:00.000Z',
    });
    expect(result).toMatchObject({
      effectiveOutcome: 'persistence_unknown',
      taskId: request.taskId,
      taskStatus: 'blocked',
      actionTurnStatus: 'missing',
      converged: false,
      evidence: { actionTurn: 'missing', task: 'found' },
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      completedAt: '',
    });
    expect(JSON.parse(taskRow(request.taskId).context).terminalPersistence).toMatchObject({
      status: 'persistence_unknown',
      requestId: request.requestId,
    });
    expect(conversationRow(request.conversationId, request.userId).actionContinuationState)
      .toMatchObject({ status: 'blocked', unfinished: true });
  });

  it('does not touch a task when a missing turn caller cannot prove the active request', () => {
    const request = prepareRequest('missing-turn-task-mismatch');
    const db = readDB();
    db.conversationActionTurns = db.conversationActionTurns.filter((row: any) => !(
      row.conversationId === request.conversationId
      && row.userId === request.userId
      && row.requestId === request.requestId
    ));
    const task = taskRow(request.taskId);
    task.activeRequestId = `newer-${request.requestId}`;
    const beforeStatus = task.status;
    const beforeRevision = task.revision;
    writeDB(db);

    const result = finalizeForegroundRequest({
      ...request,
      expectedTaskId: request.taskId,
      outcome: 'blocked',
      now: '2026-08-27T10:09:00.000Z',
    });
    expect(result).toMatchObject({
      effectiveOutcome: 'persistence_unknown',
      actionTurnStatus: 'missing',
      converged: false,
      evidence: { actionTurn: 'missing', task: 'mismatch' },
    });
    expect(taskRow(request.taskId)).toMatchObject({
      status: beforeStatus,
      activeRequestId: `newer-${request.requestId}`,
      revision: beforeRevision,
    });
  });

  it.each(['completed', 'failed'] as const)(
    'rolls a durable %s task back when no exact assistant proves user visibility',
    status => {
      const request = prepareRequest(`terminal-task-without-assistant-${status}`);
      const db = readDB();
      const task = taskRow(request.taskId);
      task.status = status;
      task.activeRequestId = '';
      task.completedAt = '2026-08-27T10:10:00.000Z';
      writeDB(db);

      const result = finalizeForegroundRequest({
        ...request,
        expectedTaskId: request.taskId,
        outcome: 'blocked',
        now: '2026-08-27T10:11:00.000Z',
      });
      expect(result).toMatchObject({
        effectiveOutcome: 'persistence_unknown',
        taskStatus: 'blocked',
        actionTurnStatus: 'persistence_unknown',
        converged: true,
        evidence: { task: 'found', assistant: 'unbound' },
      });
      expect(taskRow(request.taskId)).toMatchObject({
        status: 'blocked',
        activeRequestId: '',
        completedAt: '',
      });
    },
  );

  it('keeps a completed task when the exact durable assistant proves its terminal', () => {
    const request = prepareRequest('completed-task-with-assistant');
    const assistantMessageId = persistExactAssistant(request);
    const db = readDB();
    const task = taskRow(request.taskId);
    task.status = 'completed';
    task.activeRequestId = '';
    task.completedAt = '2026-08-27T10:12:00.000Z';
    writeDB(db);

    const result = finalizeForegroundRequest({
      ...request,
      expectedTaskId: request.taskId,
      outcome: 'terminal',
      assistantMessageId,
      now: '2026-08-27T10:13:00.000Z',
    });
    expect(result).toMatchObject({
      effectiveOutcome: 'terminal',
      taskStatus: 'completed',
      actionTurnStatus: 'terminal',
      converged: true,
      evidence: { task: 'found', assistant: 'found' },
    });
    expect(taskRow(request.taskId).status).toBe('completed');
  });

  it('retains every owner/resource after a strict flush failure and flushes an idempotent retry', async () => {
    const request = prepareRequest('strict-flush-retry');
    const abortController = new AbortController();
    const managerHeartbeat = startConversationActionExecutionHeartbeat({
      ...request,
      abortController,
    });
    const socketHeartbeatStop = vi.fn(() => managerHeartbeat.stop());
    const desktopRelease = vi.fn();
    const serialRelease = vi.fn();
    let flushCalls = 0;
    let persistedProjection = '';
    const flush = vi.fn(async () => {
      flushCalls += 1;
      if (flushCalls === 1) throw new Error('simulated strict flush failure');
      persistedProjection = JSON.stringify({
        task: taskRow(request.taskId),
        turn: getConversationActionTurn(request),
      });
    });
    const gate = createDurableForegroundReleaseGate({
      converge: async () => {
        const result = await finalizeForegroundRequestDurably({
          ...request,
          expectedTaskId: request.taskId,
          outcome: 'blocked',
          reason: 'The executor raised before a durable terminal was flushed.',
        }, { flush });
        return result.converged;
      },
      releaseResources: () => {
        socketHeartbeatStop();
        desktopRelease();
        serialRelease();
      },
      retryDelaysMs: [20],
      recoveryTakeoverAfterAttempts: 3,
    });

    // The core already staged a fail-closed terminal in memory, but failure of
    // the strict barrier must retain both manager and channel ownership.
    expect(await gate.release('first finally attempt')).toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(persistedProjection).toBe('');
    expect(taskRow(request.taskId)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    expect(getConversationActionTurn(request)).toMatchObject({ status: 'persistence_unknown' });
    expect(abortController.signal.aborted).toBe(false);
    expect(managerHeartbeat.isRunning()).toBe(true);
    expect(socketHeartbeatStop).not.toHaveBeenCalled();
    expect(desktopRelease).not.toHaveBeenCalled();
    expect(serialRelease).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({ resourcesReleased: false, recoveryOwned: false });

    // Retry sees an idempotent/no-op core, but still crosses the strict flush
    // boundary. Only then may manager ownership and transport resources clear.
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(await gate.release('finally retry')).toBe(true);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(JSON.parse(persistedProjection)).toMatchObject({
      task: { status: 'blocked', activeRequestId: '' },
      turn: { status: 'persistence_unknown' },
    });
    expect(abortController.signal.aborted).toBe(true);
    expect(managerHeartbeat.isRunning()).toBe(false);
    expect(socketHeartbeatStop).toHaveBeenCalledOnce();
    expect(desktopRelease).toHaveBeenCalledOnce();
    expect(serialRelease).toHaveBeenCalledOnce();
    expect(gate.snapshot()).toMatchObject({ resourcesReleased: true, recoveryOwned: false });
    gate.dispose();
  });

  it('uses an explicit recovery owner instead of spinning forever or claiming convergence', async () => {
    const socketHeartbeatStop = vi.fn();
    const desktopRelease = vi.fn();
    const serialRelease = vi.fn();
    const recoveryTakeover = vi.fn();
    const gate = createDurableForegroundReleaseGate({
      converge: vi.fn(async () => false),
      releaseResources: () => {
        socketHeartbeatStop();
        desktopRelease();
        serialRelease();
      },
      onRecoveryTakeover: recoveryTakeover,
      retryDelaysMs: [20],
      recoveryTakeoverAfterAttempts: 2,
    });

    expect(await gate.release('structural failure')).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      attempts: 1,
      resourcesReleased: false,
      recoveryOwned: false,
      retryScheduled: true,
    });
    expect(socketHeartbeatStop).not.toHaveBeenCalled();
    expect(desktopRelease).not.toHaveBeenCalled();
    expect(serialRelease).not.toHaveBeenCalled();

    // The second failure transfers only recovery responsibility. It frees the
    // scarce lanes, still returns false, and leaves one low-frequency worker.
    await vi.waitFor(() => expect(recoveryTakeover).toHaveBeenCalledOnce(), {
      timeout: 1_000,
      interval: 1,
    });
    expect(await gate.release('structural failure')).toBe(false);
    expect(recoveryTakeover).toHaveBeenCalledOnce();
    expect(socketHeartbeatStop).toHaveBeenCalledOnce();
    expect(desktopRelease).toHaveBeenCalledOnce();
    expect(serialRelease).toHaveBeenCalledOnce();
    expect(gate.snapshot()).toMatchObject({
      attempts: 2,
      resourcesReleased: true,
      recoveryOwned: true,
      retryScheduled: true,
    });
    gate.dispose();
    expect(gate.snapshot().retryScheduled).toBe(false);
  });
});
