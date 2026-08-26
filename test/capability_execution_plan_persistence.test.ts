import { describe, expect, it } from 'vitest';
import {
  attachConversationExecutionPlan,
  attachConversationModelExecutionGraph,
  loadConversationModelExecutionRecovery,
  type ConversationActionTaskRow,
} from '../server/conversation/action_ledger';
import {
  bindCapabilityExecutionPlanTask,
  type CapabilityExecutionPlan,
} from '../server/cognition/capability_execution_plan';
import { compileModelExecutionGraph, buildModelGraphNodeReceipt } from '../server/agents/model_execution_graph';

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

  it('persists a compiled model graph and digest-only node receipts on the same task', () => {
    const db = { conversationActionTasks: [task()], conversationActionReceipts: [] };
    const compilation = compileModelExecutionGraph({
      taskId: 'task-durable',
      nodes: [{
        nodeId: 'research',
        type: 'internal_agent',
        role: 'analysis',
        taskDescription: 'Research the exact durable source',
        executionMode: 'scholar',
        candidates: [{ provider: 'ollama', model: 'qwen3:8b', locality: 'local', priority: 0 }],
        dependsOn: [],
        inputRefs: [],
        outputSchema: { type: 'string' },
        timeoutMs: 30_000,
        maxRetries: 1,
      }],
    });
    const receipt = buildModelGraphNodeReceipt({
      graph: compilation.graph,
      node: compilation.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      output: 'sensitive worker output that must not be persisted',
      evidenceKind: 'tool_terminal_verification',
      evidenceRefs: ['tool:research-terminal-receipt'],
    });
    const persisted = attachConversationModelExecutionGraph(db, {
      conversationId: 'conversation-1',
      userId: 'user-1',
      taskId: 'task-durable',
      graph: compilation.graph,
      receipts: [receipt],
    });
    const context = JSON.parse(String(persisted?.context || '{}'));

    expect(context.modelExecutionGraph.graphId).toBe(compilation.graph.graphId);
    expect(context.modelExecutionGraph.nodes[0]).toMatchObject({
      taskDescription: 'Research the exact durable source',
      executionMode: 'scholar',
    });
    expect(context.modelNodeReceipts[0]).toMatchObject({
      nodeId: 'research',
      verified: true,
      evidenceKind: 'tool_terminal_verification',
      evidenceRefs: ['tool:research-terminal-receipt'],
    });
    expect(context.modelNodeReceipts[0].outputDigest).toHaveLength(64);
    expect(context.modelNodeReceipts[0].outputSummary).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('sensitive worker output');

    const recovery = loadConversationModelExecutionRecovery(db, {
      conversationId: 'conversation-1',
      userId: 'user-1',
      taskId: 'task-durable',
    });
    expect(recovery?.graph.graphId).toBe(compilation.graph.graphId);
    expect(recovery?.receipts).toHaveLength(1);
    expect(recovery?.receipts[0]).toMatchObject({
      taskId: 'task-durable',
      nodeId: 'research',
      verified: true,
      evidenceKind: 'tool_terminal_verification',
      evidenceRefs: ['tool:research-terminal-receipt'],
      nodeFingerprint: receipt.nodeFingerprint,
    });
    expect(loadConversationModelExecutionRecovery(db, {
      conversationId: 'other-conversation',
      userId: 'user-1',
      taskId: 'task-durable',
    })).toBeNull();
    expect(loadConversationModelExecutionRecovery(db, {
      conversationId: 'conversation-1',
      userId: 'other-user',
      taskId: 'task-durable',
    })).toBeNull();
  });

  it('recovers a digest-only validated model output receipt without persisting its handoff', () => {
    const db = { conversationActionTasks: [task()], conversationActionReceipts: [] };
    const compilation = compileModelExecutionGraph({
      taskId: 'task-durable',
      nodes: [{
        nodeId: 'analysis-deliverable',
        type: 'internal_agent',
        role: 'analysis',
        taskDescription: 'Analyze the supplied traces and explain the bottleneck',
        executionMode: 'lumi',
        candidates: [{ provider: 'ollama', model: 'qwen3:8b', locality: 'local', priority: 0 }],
        dependsOn: [],
        inputRefs: [],
        outputSchema: { type: 'string', minLength: 8, maxLength: 2_000 },
        sideEffectFree: true,
        acceptanceMode: 'validated_model_output',
        timeoutMs: 30_000,
        maxRetries: 1,
      }],
    });
    expect(compilation.ok).toBe(true);
    const receipt = buildModelGraphNodeReceipt({
      graph: compilation.graph,
      node: compilation.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      output: 'The lease timeout is the dominant bottleneck.',
      evidenceKind: 'validated_model_output',
    });
    expect(receipt.verified).toBe(true);

    const persisted = attachConversationModelExecutionGraph(db, {
      conversationId: 'conversation-1',
      userId: 'user-1',
      taskId: 'task-durable',
      graph: compilation.graph,
      receipts: [receipt],
    });
    const context = JSON.parse(String(persisted?.context || '{}'));
    expect(JSON.stringify(context)).not.toContain('lease timeout');
    expect(context.modelNodeReceipts[0].outputSummary).toBeUndefined();
    expect(loadConversationModelExecutionRecovery(db, {
      conversationId: 'conversation-1',
      userId: 'user-1',
      taskId: 'task-durable',
    })?.receipts[0]).toMatchObject({
      nodeId: 'analysis-deliverable',
      evidenceKind: 'validated_model_output',
      evidenceRefs: [`model_output:${receipt.outputDigest}`],
      verified: true,
    });

    const tampered = JSON.parse(String(persisted?.context || '{}'));
    tampered.modelNodeReceipts[0].evidenceRefs = [`model_output:${'0'.repeat(64)}`];
    persisted!.context = JSON.stringify(tampered);
    expect(loadConversationModelExecutionRecovery(db, {
      conversationId: 'conversation-1',
      userId: 'user-1',
      taskId: 'task-durable',
    })?.receipts).toEqual([]);
  });
});
