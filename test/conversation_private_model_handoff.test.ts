import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  buildOrchestrationPrivateNodeHandoffs,
} from '../server/agents/orchestrator';
import {
  buildModelGraphNodeReceipt,
  compileModelExecutionGraph,
} from '../server/agents/model_execution_graph';
import {
  getConversationModelExecutionRecovery,
  persistConversationModelExecutionCheckpoint,
} from '../server/conversation/manager';
import type { ConversationActionTaskRow } from '../server/conversation/action_ledger';

function durableTask(input: {
  taskId: string;
  conversationId: string;
  userId: string;
}): ConversationActionTaskRow {
  const now = new Date().toISOString();
  return {
    id: input.taskId,
    conversationId: input.conversationId,
    userId: input.userId,
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: 'analysis',
    operation: 'inspect',
    goal: 'resume a verified model graph',
    target: 'local runtime',
    status: 'executing',
    blocker: '',
    activeRequestId: '',
    completionSource: '',
    context: '{}',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
  };
}

describe('conversation private model handoff recovery', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('hydrates exact encrypted handoffs while the ordinary ledger remains digest-only', () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const userId = `private-recovery-user-${suffix}`;
    const conversationId = `private-recovery-conversation-${suffix}`;
    const taskId = `private-recovery-task-${suffix}`;
    const db = readDB();
    db.conversationActionTasks ||= [];
    db.conversationActionTasks.push(durableTask({ taskId, conversationId, userId }));
    writeDB(db);

    const compilation = compileModelExecutionGraph({
      taskId,
      nodes: [{
        nodeId: 'tool-source',
        type: 'internal_agent',
        role: 'search',
        taskDescription: 'Read a verified local source',
        executionMode: 'lumi',
        candidates: [{ provider: 'ollama', model: 'qwen3:8b', locality: 'local', priority: 0 }],
        dependsOn: [],
        inputRefs: [],
        outputSchema: { type: 'string' },
        timeoutMs: 30_000,
        maxRetries: 1,
      }, {
        nodeId: 'model-analysis',
        type: 'internal_agent',
        role: 'analysis',
        taskDescription: 'Analyze the verified source',
        executionMode: 'lumi',
        candidates: [{ provider: 'ollama', model: 'qwen3:8b', locality: 'local', priority: 0 }],
        dependsOn: ['tool-source'],
        inputRefs: [],
        outputSchema: { type: 'string', minLength: 8, maxLength: 2_000 },
        sideEffectFree: true,
        acceptanceMode: 'validated_model_output',
        timeoutMs: 30_000,
        maxRetries: 1,
      }],
    });
    expect(compilation.errors).toEqual([]);
    const toolReceipt = buildModelGraphNodeReceipt({
      graph: compilation.graph,
      node: compilation.graph.nodes[0],
      status: 'succeeded',
      startedAt: '2026-08-26T00:00:00.000Z',
      completedAt: '2026-08-26T00:00:01.000Z',
      output: 'PRIVATE_TOOL_HANDOFF_CONTENT',
      evidenceKind: 'tool_terminal_verification',
      evidenceRefs: ['tool:private-recovery-terminal'],
    });
    const modelReceipt = buildModelGraphNodeReceipt({
      graph: compilation.graph,
      node: compilation.graph.nodes[1],
      status: 'succeeded',
      startedAt: '2026-08-26T00:00:01.000Z',
      completedAt: '2026-08-26T00:00:02.000Z',
      output: 'PRIVATE_VALIDATED_MODEL_HANDOFF_CONTENT',
      evidenceKind: 'validated_model_output',
    });
    const receipts = [toolReceipt, modelReceipt];

    expect(persistConversationModelExecutionCheckpoint({
      conversationId,
      userId,
      taskId,
      executionGraph: compilation.graph,
      nodeReceipts: receipts,
      privateNodeHandoffs: buildOrchestrationPrivateNodeHandoffs(receipts),
    })).toBe(true);

    const persistedTask = readDB().conversationActionTasks.find((candidate: ConversationActionTaskRow) => candidate.id === taskId);
    const persistedContext = String(persistedTask?.context || '{}');
    expect(persistedContext).not.toContain('PRIVATE_TOOL_HANDOFF_CONTENT');
    expect(persistedContext).not.toContain('PRIVATE_VALIDATED_MODEL_HANDOFF_CONTENT');
    expect(persistedContext).not.toContain('privateNodeHandoffs');

    const recovery = getConversationModelExecutionRecovery({ conversationId, userId, taskId });
    expect(recovery?.receipts).toHaveLength(2);
    expect(recovery?.receipts.find(receipt => receipt.nodeId === 'tool-source')?.outputSummary)
      .toBe('PRIVATE_TOOL_HANDOFF_CONTENT');
    expect(recovery?.receipts.find(receipt => receipt.nodeId === 'model-analysis')).toMatchObject({
      outputSummary: 'PRIVATE_VALIDATED_MODEL_HANDOFF_CONTENT',
      evidenceKind: 'validated_model_output',
      verified: true,
    });
    expect(getConversationModelExecutionRecovery({ conversationId, userId: `${userId}-other`, taskId })).toBeNull();

    expect(persistConversationModelExecutionCheckpoint({
      conversationId,
      userId,
      taskId,
      executionGraph: compilation.graph,
      nodeReceipts: receipts,
      privateNodeHandoffs: buildOrchestrationPrivateNodeHandoffs(receipts).map((handoff, index) => (
        index === 0 ? { ...handoff, outputSummary: 'UNRELATED_PRIVATE_PAYLOAD' } : handoff
      )),
    })).toBe(false);
    expect(String(persistedTask.context)).toBe(persistedContext);

    const context = JSON.parse(persistedContext);
    context.modelNodeReceipts[0].outputDigest = '0'.repeat(64);
    persistedTask.context = JSON.stringify(context);
    writeDB(readDB());
    const mismatched = getConversationModelExecutionRecovery({ conversationId, userId, taskId });
    expect(mismatched?.receipts.find(receipt => receipt.nodeId === 'tool-source')?.outputSummary).toBeUndefined();
    expect(mismatched?.receipts.find(receipt => receipt.nodeId === 'model-analysis')?.outputSummary)
      .toBe('PRIVATE_VALIDATED_MODEL_HANDOFF_CONTENT');
  });
});
