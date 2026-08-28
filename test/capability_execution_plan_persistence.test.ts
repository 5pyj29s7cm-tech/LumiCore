import { describe, expect, it } from 'vitest';
import {
  attachConversationExecutionPlan,
  type ConversationActionTaskRow,
} from '../server/conversation/action_ledger';
import {
  bindCapabilityExecutionPlanTask,
  type CapabilityExecutionPlan,
} from '../server/cognition/capability_execution_plan';

function task(id = 'task-durable'): ConversationActionTaskRow {
  return {
    id,
    conversationId: 'conversation-1',
    userId: 'user-1',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: 'messaging_send',
    operation: 'mutate',
    goal: 'send payload digest',
    target: 'Alice',
    status: 'planning',
    blocker: '',
    activeRequestId: '',
    completionSource: '',
    context: '{}',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '',
  };
}

function plan(): CapabilityExecutionPlan {
  return {
    schemaVersion: 1,
    planId: 'plan-temporary',
    taskId: 'task-temporary',
    intent: {
      kind: 'messaging_send',
      operation: 'mutate',
      subject: 'user',
      target: 'Alice',
      payload: 'the secret message body',
      sideEffectClass: 'external_commit',
      relation: 'new',
      confidence: 0.99,
      rule: 'test',
    },
    nodes: [],
    edges: [],
    risk: {
      sideEffectClass: 'external_commit',
      requiresConfirmation: true,
      failClosed: true,
      confirmationBinding: {
        taskId: 'task-temporary',
        tool: '',
        target: 'Alice',
        payloadDigest: 'digest',
      },
      reasons: ['external commit'],
    },
    expectedEvidence: [],
    fallbackPolicy: {
      retryClass: 'none',
      maxRetries: 0,
      jitter: false,
      reconcileUnknownOutcome: true,
      allowLegacyRoute: false,
      onTargetMismatch: 'stop',
      onUnknownOutcome: 'reconcile_then_stop',
    },
    contextRefs: [],
    decisionAuthority: 'semantic_planner',
    scriptAuthority: 'adapter_only',
  };
}

describe('capability execution plan persistence', () => {
  it('rebinds confirmation to the durable task and stores no raw payload', () => {
    const rebound = bindCapabilityExecutionPlanTask(plan(), 'task-durable');
    const db = { conversationActionTasks: [task()], conversationActionReceipts: [] };
    const persisted = attachConversationExecutionPlan(db, {
      conversationId: 'conversation-1',
      userId: 'user-1',
      plan: rebound,
      now: '2026-01-01T00:00:01.000Z',
    });
    const context = JSON.parse(String(persisted?.context || '{}'));

    expect(rebound.taskId).toBe('task-durable');
    expect(rebound.risk.confirmationBinding?.taskId).toBe('task-durable');
    expect(context.executionPlan.intent.payload).toBe('');
    expect(context.executionPlan.intent.payloadDigest).toHaveLength(64);
    expect(JSON.stringify(context)).not.toContain('the secret message body');
    expect(context.executionPlan.scriptAuthority).toBe('adapter_only');
  });

  it('refuses to attach a plan across conversation/user boundaries', () => {
    const db = { conversationActionTasks: [task()], conversationActionReceipts: [] };
    const rebound = bindCapabilityExecutionPlanTask(plan(), 'task-durable');

    expect(attachConversationExecutionPlan(db, {
      conversationId: 'other-conversation',
      userId: 'user-1',
      plan: rebound,
    })).toBeNull();
    expect(attachConversationExecutionPlan(db, {
      conversationId: 'conversation-1',
      userId: 'other-user',
      plan: rebound,
    })).toBeNull();
  });
});
