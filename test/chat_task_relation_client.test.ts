import { describe, expect, it } from 'vitest';
import {
  ChatTaskRelationLedger,
  normalizeServerTaskRelation,
} from '../src/lib/chatTaskRelations';

function taskEvent(input: {
  requestId: string;
  conversationId?: string;
  revision: number;
  targetRequestId?: string;
}) {
  return {
    requestId: input.requestId,
    conversationId: input.conversationId || 'conversation-a',
    taskRelation: {
      relation: 'continue',
      feedback: 'correction',
      binding: 'active_task',
      operation: 'replan',
      taskId: 'task-a',
      revision: input.revision,
      targetRequestId: input.targetRequestId || input.requestId,
      preservesRootGoal: true,
      requiresRootVerification: false,
      reason: 'adjacent_active_action',
    },
  } as const;
}

describe('chat task relation client ledger', () => {
  it('normalizes server-owned relation fields and rejects unstructured input', () => {
    expect(normalizeServerTaskRelation(taskEvent({ requestId: 'request-a', revision: 7 }))).toMatchObject({
      taskId: 'task-a',
      revision: 7,
      targetRequestId: 'request-a',
      binding: 'active_task',
    });
    expect(normalizeServerTaskRelation({ requestId: 'request-a', taskRelation: { taskId: 'client-invented' } })).toBeNull();
  });

  it('sends request/task/revision fences and ignores delayed lower revisions', () => {
    const ledger = new ChatTaskRelationLedger();
    ledger.record(taskEvent({ requestId: 'request-a', revision: 7 }));
    expect(ledger.controlTarget({
      conversationId: 'conversation-a',
      foregroundRequestId: 'request-a',
    })).toEqual({
      controlTargetRequestId: 'request-a',
      controlTargetTaskId: 'task-a',
      controlTargetRevision: 7,
    });

    ledger.record(taskEvent({ requestId: 'request-b', revision: 8 }));
    ledger.record(taskEvent({ requestId: 'request-delayed', revision: 7 }));
    expect(ledger.controlTarget({ conversationId: 'conversation-a' })).toEqual({
      controlTargetRequestId: 'request-b',
      controlTargetTaskId: 'task-a',
      controlTargetRevision: 8,
    });
  });

  it('does not leak a task target into another conversation', () => {
    const ledger = new ChatTaskRelationLedger();
    ledger.record(taskEvent({ requestId: 'request-a', revision: 3 }));
    expect(ledger.controlTarget({ conversationId: 'conversation-b' })).toEqual({});
  });

  it('drops the obsolete request lease when the durable task becomes previous', () => {
    const ledger = new ChatTaskRelationLedger();
    ledger.record(taskEvent({ requestId: 'request-active', revision: 7 }));
    ledger.record({
      requestId: 'request-active',
      conversationId: 'conversation-a',
      taskRelation: {
        relation: 'continue',
        feedback: 'accept',
        binding: 'previous_task',
        operation: 'verify',
        taskId: 'task-a',
        revision: 8,
        // Legacy/delayed terminals may still contain this field. It is no
        // longer a live request lease and must not survive normalization.
        targetRequestId: 'request-active',
        preservesRootGoal: true,
        requiresRootVerification: true,
        reason: 'durable_previous_action',
      },
    });

    expect(ledger.controlTarget({ conversationId: 'conversation-a' })).toEqual({});
    expect(ledger.controlTarget({
      conversationId: 'conversation-a',
      foregroundRequestId: 'request-active',
    })).toEqual({ controlTargetRequestId: 'request-active' });
  });
});
