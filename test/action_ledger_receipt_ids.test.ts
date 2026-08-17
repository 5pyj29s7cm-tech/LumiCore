import './helpers';
import { describe, expect, it } from 'vitest';
import {
  archiveBoundConversationActionReceipts,
  appendConversationActionReceipts,
  repairContradictoryConversationActionReceipts,
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

describe('conversation action receipt ids', () => {
  it('allocates a new durable row id when one tool record is associated with another task', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const record = { id: 'tool-call-1', name: 'write_file', arguments: { path: 'result.md' }, result: 'ok' };

    appendConversationActionReceipts(db, { task: task('task-a'), records: [record] });
    appendConversationActionReceipts(db, { task: task('task-b'), records: [record] });

    expect(db.conversationActionReceipts).toHaveLength(2);
    expect(new Set(db.conversationActionReceipts.map((item: any) => item.id)).size).toBe(2);
    expect(db.conversationActionReceipts[0].id).toBe('tool-call-1');
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
    const db: any = { conversationActionTasks: [waitingTask], conversationActionReceipts: [] };

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

    expect(cancelled).toMatchObject({ status: 'cancelled', latestBlocker: '', unfinished: false });
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
});
