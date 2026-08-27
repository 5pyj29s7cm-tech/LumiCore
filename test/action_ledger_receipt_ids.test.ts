import './helpers';
import { describe, expect, it } from 'vitest';
import {
  archiveBoundConversationActionReceipts,
  appendConversationActionReceipts,
  conversationActionStateFromTask,
  finalizeConversationActionTask,
  repairContradictoryConversationActionReceipts,
  repairTerminalConversationActionTaskLeases,
  settleBackgroundConversationActionTask,
  syncConversationActionTaskLedger,
  type ConversationActionTaskRow,
} from '../server/conversation/action_ledger';
import {
  buildConversationActionContinuationState,
  normalizeConversationActionState,
} from '../server/cognition/action_continuation';

function task(id: string): ConversationActionTaskRow {
  return {
    id,
    conversationId: 'conversation-1',
    userId: 'user-1',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: 'artifact_work',
    operation: 'create',
    goal: 'create an artifact',
    target: '',
    status: 'executing',
    blocker: '',
    activeRequestId: '',
    completionSource: '',
    context: '{}',
    revision: 1,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    completedAt: '',
  };
}

function activeTurn(taskId: string, requestId: string) {
  return {
    conversationId: 'conversation-1',
    userId: 'user-1',
    requestId,
    taskId,
    status: 'leased',
  };
}

describe('conversation action receipt ids', () => {
  function contradictoryReceipt(
    basis: 'terminal_verification' | 'compatibility_inference' | undefined,
    mutateEnvelope?: (envelope: Record<string, any>) => void,
  ) {
    const taskId = 'task-contradictory';
    const turnId = 'turn-contradictory';
    const requestId = 'request-contradictory';
    const idempotencyKey = 'idempotency-contradictory';
    const toolName = 'controlled_probe';
    const targetIdentity = 'target-contradictory';
    const envelope: Record<string, any> = {
      version: 1,
      status: 'failed',
      toolName,
      taskId,
      turnId,
      requestId,
      idempotencyKey,
      targetIdentity,
      completedAt: '2026-08-16T00:00:01.000Z',
      result: { ok: true, status: 'completed', failed: 0 },
      verification: {
        status: 'verified',
        ...(basis ? { basis } : {}),
        reason: 'Structured terminal verification succeeded.',
      },
    };
    mutateEnvelope?.(envelope);
    return {
      id: 'receipt-contradictory',
      taskId,
      conversationId: 'conversation-1',
      turnId,
      requestId,
      idempotencyKey,
      toolName,
      targetIdentity,
      inputDigest: 'input-digest',
      envelope: JSON.stringify(envelope),
      outcome: 'failed',
      createdAt: '2026-08-16T00:00:01.000Z',
    };
  }

  it('allocates a new durable row id when one tool record is associated with another task', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const record = { id: 'tool-call-1', name: 'write_file', arguments: { path: 'result.md' }, result: 'ok' };

    appendConversationActionReceipts(db, { task: task('task-a'), records: [record] });
    appendConversationActionReceipts(db, { task: task('task-b'), records: [record] });

    expect(db.conversationActionReceipts).toHaveLength(2);
    expect(new Set(db.conversationActionReceipts.map((item: any) => item.id)).size).toBe(2);
    expect(db.conversationActionReceipts[0].id).toBe('tool-call-1');
  });

  it('persists the exact model routing receipt that selected a tool call', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    appendConversationActionReceipts(db, {
      task: task('task-model-bound'),
      requestId: 'request-model-bound',
      records: [{
        id: 'tool-model-bound',
        name: 'read_file',
        arguments: { path: 'result.md' },
        result: 'verified',
        modelRoutingReceiptId: 'routing-model-bound',
        executionOrigin: 'model_selected',
      }],
    });

    expect(db.conversationActionReceipts[0]).toMatchObject({
      requestId: 'request-model-bound',
      modelRoutingReceiptId: 'routing-model-bound',
      executionOrigin: 'model_selected',
    });
  });

  it('keeps persistence_unknown quarantined across ordinary task sync and finalization', () => {
    const actionTask = task('task-persistence-unknown');
    const marker = {
      status: 'persistence_unknown' as const,
      requestId: 'request-persistence-unknown',
      quarantinedAt: '2026-08-16T00:00:01.000Z',
    };
    const quarantinedState = normalizeConversationActionState({
      version: 2,
      taskId: actionTask.id,
      goal: actionTask.goal,
      latestInstruction: actionTask.goal,
      status: 'blocked',
      unfinished: true,
      latestBlocker: 'persistence_unknown: terminal durability failed',
      sourcePaths: [],
      evidenceTools: [],
      assistantState: '',
      toolSummaries: [],
      receipts: [],
      terminalPersistence: marker,
      revision: 2,
      updatedAt: marker.quarantinedAt,
    })!;
    actionTask.status = 'blocked';
    actionTask.blocker = quarantinedState.latestBlocker;
    actionTask.revision = quarantinedState.revision;
    actionTask.updatedAt = marker.quarantinedAt;
    actionTask.context = JSON.stringify({
      terminalPersistence: marker,
      taskFinalization: {
        outcome: 'persistence_unknown',
        requestId: marker.requestId,
        finalizedAt: marker.quarantinedAt,
      },
      actionState: quarantinedState,
    });
    const conversation: any = {
      id: actionTask.conversationId,
      userId: actionTask.userId,
      domain: actionTask.domain,
      orgId: actionTask.orgId,
      actionContinuationState: quarantinedState,
    };
    const db: any = {
      conversations: [conversation],
      conversationActionTasks: [actionTask],
      conversationActionReceipts: [],
    };
    const unsafeCompleted = normalizeConversationActionState({
      ...quarantinedState,
      status: 'completed',
      unfinished: false,
      terminalPersistence: undefined,
      completionSource: 'tool_receipt',
      revision: 3,
      updatedAt: '2026-08-16T00:00:02.000Z',
    })!;
    const unsafeEchoedMarkerCompleted = normalizeConversationActionState({
      ...unsafeCompleted,
      terminalPersistence: marker,
    })!;

    syncConversationActionTaskLedger(db, {
      conversation,
      state: unsafeEchoedMarkerCompleted,
      now: unsafeEchoedMarkerCompleted.updatedAt,
    });
    expect(actionTask).toMatchObject({ status: 'blocked', completedAt: '' });

    syncConversationActionTaskLedger(db, {
      conversation,
      state: unsafeCompleted,
      now: unsafeCompleted.updatedAt,
    });
    const finalized = finalizeConversationActionTask(db, {
      conversation,
      state: unsafeCompleted,
      outcome: 'completed',
      requestId: marker.requestId,
      completionSource: 'tool_receipt',
      now: '2026-08-16T00:00:03.000Z',
    });

    expect(finalized?.state).toMatchObject({
      status: 'blocked',
      unfinished: true,
      terminalPersistence: marker,
    });
    expect(actionTask).toMatchObject({ status: 'blocked', completedAt: '' });
    expect(JSON.parse(actionTask.context)).toMatchObject({
      terminalPersistence: marker,
      taskFinalization: { outcome: 'persistence_unknown', requestId: marker.requestId },
      actionState: { status: 'blocked', terminalPersistence: marker },
    });
    expect(conversation.actionContinuationState).toMatchObject({
      status: 'blocked',
      terminalPersistence: marker,
    });
  });

  it('settles a background-owned action through the common task finalizer', () => {
    const actionTask = task('task-background-finalization');
    actionTask.activeRequestId = 'request-background-finalization';
    actionTask.context = JSON.stringify({
      source: 'command_center_plan',
      actionState: normalizeConversationActionState({
        version: 2,
        taskId: actionTask.id,
        goal: actionTask.goal,
        latestInstruction: actionTask.goal,
        status: 'executing',
        unfinished: true,
        latestBlocker: '',
        activeRequestId: actionTask.activeRequestId,
        sourcePaths: [],
        evidenceTools: [],
        assistantState: '',
        toolSummaries: [],
        receipts: [],
        revision: 1,
        updatedAt: actionTask.updatedAt,
      }),
    });
    const db: any = {
      conversationActionTasks: [actionTask],
      conversationActionReceipts: [],
    };

    settleBackgroundConversationActionTask(db, {
      taskId: actionTask.id,
      userId: actionTask.userId,
      requestId: actionTask.activeRequestId,
      status: 'completed',
      now: '2026-08-16T00:00:03.000Z',
      records: [{
        id: 'background-finalizer-receipt',
        taskId: actionTask.id,
        requestId: actionTask.activeRequestId,
        name: 'background_orchestration_finalizer',
        arguments: {},
        result: JSON.stringify({ status: 'verified', verified: true }),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Background work reached verified completion.',
        },
      }],
    });

    expect(actionTask).toMatchObject({
      status: 'completed',
      activeRequestId: '',
      completionSource: 'tool_receipt',
      completedAt: '2026-08-16T00:00:03.000Z',
    });
    expect(JSON.parse(actionTask.context)).toMatchObject({
      source: 'command_center_plan',
      taskFinalization: {
        outcome: 'completed',
        requestId: 'request-background-finalization',
        finalizedAt: '2026-08-16T00:00:03.000Z',
      },
      actionState: { status: 'completed', unfinished: false },
    });
  });

  it('does not duplicate one logical receipt when the same task is revisited by another request', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const record = {
      id: 'tool-call-logical',
      name: 'wechat_send_message',
      arguments: { contact: 'recipient', message: 'test' },
      result: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
      error: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
      idempotencyKey: 'same-logical-action',
    };
    const actionTask = task('task-logical');

    appendConversationActionReceipts(db, { task: actionTask, records: [{ ...record, requestId: 'request-1' }] });
    appendConversationActionReceipts(db, { task: actionTask, records: [{ ...record, id: 'tool-call-retry', requestId: 'request-2' }] });

    expect(db.conversationActionReceipts).toHaveLength(1);
    expect(db.conversationActionReceipts[0].requestId).toBe('request-1');
  });

  it('keeps confirmation-blocked external commits in waiting_confirmation instead of blocked', () => {
    const waitingTask = task('task-waiting');
    waitingTask.goal = 'messaging_send:recipient payload_sha256=test';
    waitingTask.target = 'recipient';
    waitingTask.activeRequestId = 'request-waiting';
    waitingTask.context = JSON.stringify({
      actionState: {
        version: 2,
        taskId: waitingTask.id,
        status: 'executing',
        receipts: [],
        revision: 1,
        goal: waitingTask.goal,
        latestInstruction: waitingTask.goal,
        appTarget: waitingTask.target,
        sourcePaths: [],
        latestBlocker: '',
        unfinished: true,
        evidenceTools: [],
        assistantState: '',
        toolSummaries: [],
        activeRequestId: waitingTask.activeRequestId,
        updatedAt: waitingTask.updatedAt,
      },
    });
    const db: any = {
      conversationActionTasks: [waitingTask],
      conversationActionReceipts: [],
      conversationActionTurns: [activeTurn(waitingTask.id, waitingTask.activeRequestId)],
    };

    archiveBoundConversationActionReceipts(db, {
      conversationId: waitingTask.conversationId,
      userId: waitingTask.userId,
      records: [{
        id: 'confirmation-receipt',
        taskId: waitingTask.id,
        requestId: waitingTask.activeRequestId,
        name: 'wechat_send_message',
        arguments: { contact: 'recipient', message: 'test' },
        result: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
        error: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
      }],
    });

    expect(waitingTask.status).toBe('waiting_confirmation');
    expect(waitingTask.blocker).toBe('');
    expect(JSON.parse(String(waitingTask.context)).actionState.status).toBe('waiting_confirmation');
    expect(db.conversationActionReceipts[0].outcome).toBe('waiting_confirmation');
  });

  it('keeps the active conversation pointer waiting when the confirmation receipt is persisted', () => {
    const next = buildConversationActionContinuationState({
      previous: {
        version: 2,
        taskId: 'task-confirmation-pointer',
        status: 'executing',
        receipts: [],
        revision: 1,
        goal: 'send a message to recipient',
        latestInstruction: 'send a message to recipient',
        appTarget: 'recipient',
        sourcePaths: [],
        latestBlocker: '',
        unfinished: true,
        evidenceTools: [],
        assistantState: '',
        toolSummaries: [],
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
      userText: 'send a message to recipient',
      assistantText: 'Waiting for confirmation.',
      toolCalls: [{
        id: 'confirmation-pointer-receipt',
        name: 'wechat_send_message',
        arguments: { contact: 'recipient', message: 'test' },
        result: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
        error: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
      }],
      requestId: 'request-confirmation-pointer',
    });

    expect(next).toMatchObject({
      status: 'waiting_confirmation',
      latestBlocker: '',
      unfinished: true,
    });
  });

  it('clears a stale confirmation blocker after the task is cancelled', () => {
    const cancelled = normalizeConversationActionState({
      version: 2,
      taskId: 'task-cancelled-confirmation',
      status: 'cancelled',
      receipts: [{
        id: 'cancelled-confirmation-receipt',
        key: 'wechat_send_message:test',
        name: 'wechat_send_message',
        arguments: { contact: 'recipient', message: 'test' },
        result: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
        error: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
        outcome: 'failure',
        recordedAt: '2026-08-17T00:00:00.000Z',
      }],
      revision: 2,
      goal: 'send a message to recipient',
      latestInstruction: 'send a message to recipient',
      appTarget: 'recipient',
      sourcePaths: [],
      latestBlocker: 'Tool "wechat_send_message" requires user confirmation and was not approved.',
      unfinished: false,
      evidenceTools: [],
      assistantState: 'cancelled',
      toolSummaries: [],
      updatedAt: '2026-08-17T00:01:00.000Z',
    });

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      latestBlocker: '',
      unfinished: false,
      activeRequestId: undefined,
    });
  });

  it('never exposes a request lease on completed continuation state', () => {
    const completed = normalizeConversationActionState({
      version: 2,
      taskId: 'task-completed-with-stale-lease',
      status: 'completed',
      receipts: [],
      revision: 2,
      goal: 'open the requested document',
      latestInstruction: 'open the requested document',
      unfinished: true,
      activeRequestId: 'request-must-be-cleared',
      updatedAt: '2026-08-17T00:01:00.000Z',
    });

    expect(completed).toMatchObject({
      status: 'completed',
      unfinished: false,
      activeRequestId: undefined,
    });
  });

  it.each(['blocked', 'waiting_confirmation'] as const)(
    'keeps a %s task resumable without exposing its old execution lease',
    status => {
      const resumable = task(`task-${status}`);
      resumable.status = status;
      resumable.activeRequestId = 'request-that-already-returned';
      resumable.context = JSON.stringify({
        actionState: {
          version: 2,
          taskId: resumable.id,
          status,
          receipts: [],
          revision: 2,
          goal: resumable.goal,
          latestInstruction: resumable.goal,
          unfinished: true,
          activeRequestId: 'request-that-already-returned',
          updatedAt: resumable.updatedAt,
        },
      });

      expect(conversationActionStateFromTask(resumable)).toMatchObject({
        status,
        unfinished: true,
        activeRequestId: undefined,
      });
    },
  );

  it('keeps a verifying request leased and treats failed as a terminal task', () => {
    const verifying = task('task-verifying');
    verifying.status = 'verifying';
    verifying.activeRequestId = 'request-verifying';
    verifying.context = JSON.stringify({
      actionState: {
        version: 2,
        taskId: verifying.id,
        status: 'verifying',
        receipts: [],
        revision: 2,
        goal: verifying.goal,
        latestInstruction: verifying.goal,
        unfinished: true,
        activeRequestId: verifying.activeRequestId,
        updatedAt: verifying.updatedAt,
      },
    });
    expect(conversationActionStateFromTask(verifying)).toMatchObject({
      status: 'verifying',
      unfinished: true,
      activeRequestId: 'request-verifying',
    });

    const failed = task('task-failed');
    failed.status = 'failed';
    failed.activeRequestId = 'request-must-not-survive';
    failed.blocker = 'No compatible execution path remained.';
    failed.context = JSON.stringify({
      actionState: {
        version: 2,
        taskId: failed.id,
        status: 'failed',
        receipts: [],
        revision: 3,
        goal: failed.goal,
        latestInstruction: failed.goal,
        latestBlocker: failed.blocker,
        unfinished: true,
        activeRequestId: failed.activeRequestId,
        updatedAt: failed.updatedAt,
      },
    });
    expect(conversationActionStateFromTask(failed)).toMatchObject({
      status: 'failed',
      unfinished: false,
      activeRequestId: undefined,
      latestBlocker: failed.blocker,
    });

    const db: any = { conversationActionTasks: [failed], conversationActionReceipts: [] };
    archiveBoundConversationActionReceipts(db, {
      conversationId: failed.conversationId,
      userId: failed.userId,
      records: [{
        id: 'late-success-after-failure',
        taskId: failed.id,
        requestId: 'late-request',
        name: 'write_file',
        arguments: { path: 'late.md' },
        result: JSON.stringify({ ok: true, status: 'completed' }),
        terminalVerification: {
          status: 'verified',
          strategy: 'artifact',
          reason: 'Late receipt is archived without reopening the terminal task.',
        },
      }],
    });
    expect(failed.status).toBe('failed');
    expect(conversationActionStateFromTask(failed)).toMatchObject({
      status: 'failed',
      unfinished: false,
    });
  });

  it('archives a late success from R1 without changing the same-task R2 owner or live pointer', () => {
    const successorRequestId = 'request-successor-r2';
    const historicalRequestId = 'request-historical-r1';
    const actionTask = task('task-shared-successor');
    actionTask.goal = 'remember this task state';
    actionTask.activeRequestId = successorRequestId;
    actionTask.context = JSON.stringify({
      source: 'foreground',
      actionState: {
        version: 2,
        taskId: actionTask.id,
        status: 'executing',
        receipts: [],
        revision: 4,
        goal: actionTask.goal,
        latestInstruction: 'continue with the corrected target',
        unfinished: true,
        latestBlocker: '',
        activeRequestId: successorRequestId,
        sourcePaths: [],
        evidenceTools: [],
        assistantState: '',
        toolSummaries: [],
        updatedAt: '2026-08-17T00:02:00.000Z',
      },
    });
    const liveState = normalizeConversationActionState(JSON.parse(actionTask.context).actionState)!;
    const conversation: any = {
      id: actionTask.conversationId,
      userId: actionTask.userId,
      actionContinuationState: liveState,
      pendingActionContinuation: {
        userText: 'continue with the corrected target',
        messageId: 'message-r2',
        requestId: successorRequestId,
        updatedAt: '2026-08-17T00:02:00.000Z',
      },
    };
    const db: any = {
      conversations: [conversation],
      conversationActionTasks: [actionTask],
      conversationActionReceipts: [],
      conversationActionTurns: [
        { ...activeTurn(actionTask.id, historicalRequestId), status: 'cancelled' },
        activeTurn(actionTask.id, successorRequestId),
      ],
    };
    const beforeTask = JSON.parse(JSON.stringify(actionTask));
    const beforeLive = JSON.parse(JSON.stringify(conversation.actionContinuationState));
    const beforePending = JSON.parse(JSON.stringify(conversation.pendingActionContinuation));

    const result = archiveBoundConversationActionReceipts(db, {
      conversationId: actionTask.conversationId,
      userId: actionTask.userId,
      records: [{
        id: 'late-r1-success',
        taskId: actionTask.id,
        requestId: historicalRequestId,
        name: 'write_file',
        arguments: { path: 'obsolete-target.txt' },
        result: JSON.stringify({ ok: true, status: 'completed' }),
        terminalVerification: {
          status: 'verified',
          strategy: 'artifact',
          reason: 'historical receipt',
        },
      }],
      now: '2026-08-17T00:03:00.000Z',
    });

    expect(result).toMatchObject({ archived: 1, taskIds: [actionTask.id] });
    expect(db.conversationActionReceipts).toHaveLength(1);
    expect(actionTask).toEqual(beforeTask);
    expect(conversation.actionContinuationState).toEqual(beforeLive);
    expect(conversation.pendingActionContinuation).toEqual(beforePending);
    expect(db.conversationActionTurns[1]).toMatchObject({
      requestId: successorRequestId,
      taskId: actionTask.id,
      status: 'leased',
    });
  });

  it.each([
    { label: 'stale requestless pair', authorityUserId: 'message-old', assistantMode: '' },
    { label: 'proactive requestless pair', authorityUserId: 'message-current', assistantMode: 'proactive' },
  ])('keeps a $label audit-only even when its receipt verifies success', ({
    authorityUserId,
    assistantMode,
  }) => {
    const actionTask = task(`task-requestless-${authorityUserId}-${assistantMode || 'stale'}`);
    actionTask.context = JSON.stringify({
      actionState: {
        version: 2,
        taskId: actionTask.id,
        status: 'executing',
        receipts: [],
        revision: 1,
        goal: actionTask.goal,
        latestInstruction: actionTask.goal,
        unfinished: true,
        latestBlocker: '',
        sourcePaths: [],
        evidenceTools: [],
        assistantState: '',
        toolSummaries: [],
        updatedAt: actionTask.updatedAt,
      },
    });
    const conversation: any = {
      id: actionTask.conversationId,
      userId: actionTask.userId,
      actionContinuationState: JSON.parse(actionTask.context).actionState,
      pendingActionContinuation: {
        userText: 'current requestless work',
        messageId: 'message-current',
        updatedAt: actionTask.updatedAt,
      },
    };
    const assistantId = `assistant-${authorityUserId}-${assistantMode || 'stale'}`;
    const db: any = {
      conversations: [conversation],
      interactions: [
        {
          id: 'message-current',
          conversationId: actionTask.conversationId,
          userId: actionTask.userId,
          role: 'user',
        },
        {
          id: 'message-old',
          conversationId: actionTask.conversationId,
          userId: actionTask.userId,
          role: 'user',
        },
        {
          id: assistantId,
          conversationId: actionTask.conversationId,
          userId: actionTask.userId,
          role: 'assistant',
          mode: assistantMode,
        },
      ],
      conversationActionTasks: [actionTask],
      conversationActionReceipts: [],
      conversationActionTurns: [],
    };
    const beforeTask = JSON.parse(JSON.stringify(actionTask));
    const beforeLive = JSON.parse(JSON.stringify(conversation.actionContinuationState));

    const result = archiveBoundConversationActionReceipts(db, {
      conversationId: actionTask.conversationId,
      userId: actionTask.userId,
      records: [{
        id: `receipt-${assistantId}`,
        taskId: actionTask.id,
        name: 'write_file',
        arguments: { path: 'requestless-result.txt' },
        result: JSON.stringify({ ok: true, status: 'completed' }),
        terminalVerification: {
          status: 'verified',
          strategy: 'artifact',
          reason: 'requestless success must still prove current pairing',
        },
      }],
      currentPairingAuthority: {
        userMessageId: authorityUserId,
        assistantMessageId: assistantId,
      },
    });

    expect(result).toMatchObject({ archived: 1, adjudicatedTaskIds: [] });
    expect(actionTask).toEqual(beforeTask);
    expect(conversation.actionContinuationState).toEqual(beforeLive);
    expect(conversation.pendingActionContinuation.messageId).toBe('message-current');
  });

  it('repairs historical terminal task leases without changing completion ordering', () => {
    const completedTask = task('task-completed-stale-row');
    completedTask.status = 'completed';
    completedTask.activeRequestId = 'request-stale';
    completedTask.completedAt = '2026-08-16T00:00:05.000Z';
    completedTask.updatedAt = '2026-08-16T00:00:05.000Z';
    completedTask.context = JSON.stringify({
      actionState: {
        version: 2,
        taskId: completedTask.id,
        status: 'completed',
        receipts: [],
        revision: 1,
        goal: completedTask.goal,
        latestInstruction: completedTask.goal,
        unfinished: false,
        activeRequestId: 'request-stale',
        updatedAt: completedTask.updatedAt,
      },
    });
    const db: any = { conversationActionTasks: [completedTask], conversationActionReceipts: [] };

    expect(repairTerminalConversationActionTaskLeases(db)).toBe(1);
    expect(completedTask).toMatchObject({
      status: 'completed',
      activeRequestId: '',
      updatedAt: '2026-08-16T00:00:05.000Z',
      completedAt: '2026-08-16T00:00:05.000Z',
      revision: 2,
    });
    expect(JSON.parse(String(completedTask.context)).actionState).toMatchObject({
      status: 'completed',
      unfinished: false,
    });
    expect(JSON.parse(String(completedTask.context)).actionState.activeRequestId).toBeUndefined();
    expect(repairTerminalConversationActionTaskLeases(db)).toBe(0);
  });

  it('repairs an already-persisted cancelled task that still has a confirmation blocker', () => {
    const cancelledTask = task('task-cancelled-row');
    cancelledTask.status = 'cancelled';
    cancelledTask.blocker = 'Tool "wechat_send_message" requires user confirmation and was not approved.';
    cancelledTask.context = JSON.stringify({
      actionState: {
        version: 2,
        taskId: cancelledTask.id,
        status: 'cancelled',
        receipts: [],
        revision: 2,
        goal: 'send a message to recipient',
        latestInstruction: 'send a message to recipient',
        appTarget: 'recipient',
        sourcePaths: [],
        latestBlocker: cancelledTask.blocker,
        unfinished: false,
        evidenceTools: [],
        assistantState: 'cancelled',
        toolSummaries: [],
        updatedAt: cancelledTask.updatedAt,
      },
    });
    const db: any = { conversationActionTasks: [cancelledTask], conversationActionReceipts: [] };

    expect(repairContradictoryConversationActionReceipts(db)).toBe(1);
    expect(cancelledTask.blocker).toBe('');
    expect(JSON.parse(String(cancelledTask.context)).actionState.latestBlocker).toBe('');
  });

  it('repairs a contradictory receipt only when the full durable identity has explicit terminal verification', () => {
    const verifiedDb: any = {
      conversationActionTasks: [],
      conversationActionReceipts: [contradictoryReceipt('terminal_verification')],
    };
    expect(repairContradictoryConversationActionReceipts(verifiedDb)).toBe(1);
    expect(verifiedDb.conversationActionReceipts[0].outcome).toBe('verified_success');
    expect(JSON.parse(verifiedDb.conversationActionReceipts[0].envelope)).toMatchObject({
      status: 'verified_success',
      verification: { status: 'verified', basis: 'terminal_verification' },
    });

    for (const receipt of [
      contradictoryReceipt(undefined),
      contradictoryReceipt('compatibility_inference'),
      contradictoryReceipt('terminal_verification', envelope => { envelope.requestId = 'forged-request'; }),
      contradictoryReceipt('terminal_verification', envelope => { envelope.toolName = 'forged-tool'; }),
      contradictoryReceipt('terminal_verification', envelope => { envelope.status = 'verified_success'; }),
    ]) {
      const db: any = { conversationActionTasks: [], conversationActionReceipts: [receipt] };
      expect(repairContradictoryConversationActionReceipts(db)).toBe(0);
      expect(db.conversationActionReceipts[0].outcome).toBe('failed');
    }
  });
});
