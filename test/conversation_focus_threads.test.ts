import { describe, expect, it } from 'vitest';
import {
  listConversationFocusThreads,
  readConversationFocusThread,
  reconcileConversationFocusThread,
  updateConversationFocusThread,
} from '../server/conversation/focus_threads';
import { syncConversationActionTaskLedger } from '../server/conversation/action_ledger';

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: 'desktop_operation',
    operation: 'mutate',
    goal: 'Prepare the report',
    target: 'report.docx',
    status: 'executing' as const,
    blocker: '',
    activeRequestId: 'req-1',
    completionSource: '',
    context: '{}',
    revision: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:01:00.000Z',
    completedAt: '',
    ...overrides,
  };
}

describe('conversation focus threads', () => {
  it('projects the existing durable task id instead of creating a second task system', () => {
    const focus = readConversationFocusThread(task());
    expect(focus).toMatchObject({
      threadId: 'focus_task-1',
      taskId: 'task-1',
      evidenceTaskId: 'task-1',
      goal: 'Prepare the report',
      status: 'executing',
      commitment: 'Prepare the report',
    });
  });

  it('persists commitments and resume points without allowing status replacement', () => {
    const db = { conversationActionTasks: [task()] };
    const focus = updateConversationFocusThread(db, {
      taskId: 'task-1',
      userId: 'user-1',
      commitment: 'Deliver a verified report',
      nextAction: 'Check the exported PDF',
      resumePoint: 'Resume after page layout verification',
      dueAt: '2026-08-11T09:00:00+08:00',
      now: '2026-08-10T00:02:00.000Z',
    });

    expect(focus).toMatchObject({
      status: 'executing',
      commitment: 'Deliver a verified report',
      nextAction: 'Check the exported PDF',
      resumePoint: 'Resume after page layout verification',
      dueAt: '2026-08-11T01:00:00.000Z',
    });
    expect(db.conversationActionTasks[0].status).toBe('executing');
  });

  it('derives confirmation waits and clears actions at a terminal state', () => {
    const waiting = reconcileConversationFocusThread({}, task({ status: 'waiting_confirmation' }));
    expect(waiting.waitingFor).toBe('user_confirmation');

    const completed = reconcileConversationFocusThread({
      taskId: 'task-1',
      nextAction: 'send it',
      waitingFor: 'user_confirmation',
    }, task({ status: 'completed' }));
    expect(completed.nextAction).toBe('');
    expect(completed.waitingFor).toBe('');
  });

  it('enforces personal and organization scope when listing or updating', () => {
    const db = {
      conversationActionTasks: [
        task(),
        task({ id: 'task-org-a', domain: 'work', orgId: 'org-a' }),
        task({ id: 'task-org-b', domain: 'work', orgId: 'org-b' }),
      ],
    };
    expect(listConversationFocusThreads(db, { userId: 'user-1', domain: 'work', orgId: 'org-a' }).map(item => item.taskId)).toEqual(['task-org-a']);
    expect(updateConversationFocusThread(db, { taskId: 'task-org-b', userId: 'user-1', domain: 'work', orgId: 'org-a', nextAction: 'leak' })).toBeNull();
  });

  it('adds the focus projection during normal action-ledger synchronization', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const row = syncConversationActionTaskLedger(db, {
      conversation: { id: 'conv-1', userId: 'user-1', domain: 'personal' },
      state: {
        version: 2,
        taskId: 'task-sync',
        goal: 'Open the exact client page',
        latestInstruction: 'Open the exact client page',
        status: 'executing',
        unfinished: true,
        updatedAt: '2026-08-10T00:00:00.000Z',
        sourcePaths: [],
        evidenceTools: [],
        assistantState: '',
        toolSummaries: [],
        receipts: [],
      } as any,
    });
    const context = JSON.parse(String(row?.context || '{}'));
    expect(context.focusThread).toMatchObject({ taskId: 'task-sync', evidenceTaskId: 'task-sync', status: 'executing' });
  });
});
