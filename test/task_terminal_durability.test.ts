import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitChatTerminalBoundary } from '../server/socket/chat_terminal_boundary';
import {
  beginChatExecution,
  getChatExecution,
  initializeChatExecutionRegistryPersistence,
  recordChatExecutionTerminalEventDurably,
  resetChatExecutionRegistryForTests,
  type ChatExecutionPersistenceAdapter,
  type ChatExecutionScope,
  type PersistedChatExecutionReceipt,
} from '../server/socket/chat_execution_registry';
import {
  persistTaskWorkflowCheckpointDurably,
  TaskWorkflowCheckpointError,
} from '../server/socket/task';

const taskScope: ChatExecutionScope = {
  userId: 'task-user',
  domain: 'personal',
  source: 'task',
};

function memoryPersistence() {
  const rows: PersistedChatExecutionReceipt[] = [];
  const adapter: ChatExecutionPersistenceAdapter = {
    async loadRecoverable(nowIso) {
      return rows
        .filter(row => row.expiresAt > nowIso)
        .map(row => structuredClone(row));
    },
    async upsert(receipt) {
      const index = rows.findIndex(row => row.requestId === receipt.requestId);
      if (index >= 0) rows.splice(index, 1, structuredClone(receipt));
      else rows.push(structuredClone(receipt));
    },
    async purgeExpired() {},
  };
  return { adapter, rows };
}

afterEach(() => {
  resetChatExecutionRegistryForTests();
  vi.restoreAllMocks();
});

describe('task terminal durability', () => {
  it('publishes a task terminal only after state, transcript, DB flush and strict receipt', async () => {
    const order: string[] = [];
    const committed = await commitChatTerminalBoundary({
      persistTerminalState: () => {
        order.push('state');
        return { recorded: true };
      },
      persistAssistantMessage: () => { order.push('message'); },
      flush: async () => { order.push('flush'); },
      persistTerminalReceipt: async () => {
        order.push('receipt');
        return true;
      },
      persistUnknownReceipt: async () => {
        order.push('unknown_receipt');
        return true;
      },
      publishCommitted: () => { order.push('publish_success'); },
      publishUnknown: () => { order.push('publish_unknown'); },
    });

    expect(committed).toBe(true);
    expect(order).toEqual(['state', 'message', 'flush', 'receipt', 'publish_success']);
  });

  it('quarantines a DB flush failure and never publishes the staged success', async () => {
    const order: string[] = [];
    const committed = await commitChatTerminalBoundary({
      persistTerminalState: () => { order.push('state'); },
      persistAssistantMessage: () => { order.push('message'); },
      flush: async () => {
        order.push('flush_failed');
        throw new Error('disk unavailable');
      },
      persistTerminalReceipt: async () => {
        order.push('success_receipt');
        return true;
      },
      persistUnknownReceipt: async () => {
        order.push('unknown_receipt');
        return true;
      },
      publishCommitted: () => { order.push('publish_success'); },
      publishUnknown: () => { order.push('publish_unknown'); },
    });

    expect(committed).toBe(false);
    expect(order).toEqual([
      'state',
      'message',
      'flush_failed',
      'unknown_receipt',
      'publish_unknown',
    ]);
  });

  it('recovers the exact durable task terminal after a registry restart', async () => {
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, Date.now());
    beginChatExecution(taskScope, 'task-reconnect');
    await expect(recordChatExecutionTerminalEventDurably(
      taskScope,
      'task-reconnect',
      'agent:response',
      { text: 'durable task result', finalized: true, blocked: false },
      { text: 'unknown' },
    )).resolves.toBe(true);

    resetChatExecutionRegistryForTests();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, Date.now());

    expect(getChatExecution(taskScope, 'task-reconnect')).toMatchObject({
      requestId: 'task-reconnect',
      terminal: true,
      status: 'completed',
      terminalEvent: {
        event: 'agent:response',
        payload: { text: 'durable task result' },
      },
    });
  });
});

describe('foreground task workflow checkpoints', () => {
  const graph = {
    graphId: 'graph-1',
    taskId: 'task-1',
    nodes: [],
    arbitration: 'first_verified',
  } as any;
  const recoveredReceipt = { graphId: 'graph-1', taskId: 'task-1', nodeId: 'old' } as any;
  const waveReceipt = { graphId: 'graph-1', taskId: 'task-1', nodeId: 'wave' } as any;

  it('persists and flushes every checkpoint before the workflow can continue', async () => {
    const order: string[] = [];
    await persistTaskWorkflowCheckpointDurably({
      conversationId: 'conversation-1',
      userId: 'task-user',
      taskId: 'task-1',
      checkpoint: {
        phase: 'wave_completed',
        executionGraph: graph,
        nodeReceipts: [waveReceipt],
        privateNodeHandoffs: [],
        completedNodeIds: ['wave'],
      },
    }, {
      persist: input => {
        order.push(`persist:${input.nodeReceipts[0]?.nodeId}`);
        return true;
      },
      flush: async () => { order.push('flush'); },
    });

    expect(order).toEqual(['persist:wave', 'flush']);
  });

  it('fails closed before flush when the task-owned checkpoint is rejected', async () => {
    const flush = vi.fn(async () => undefined);
    await expect(persistTaskWorkflowCheckpointDurably({
      conversationId: 'conversation-1',
      userId: 'task-user',
      taskId: 'task-1',
      checkpoint: {
        phase: 'compiled',
        executionGraph: graph,
        nodeReceipts: [],
        privateNodeHandoffs: [],
        completedNodeIds: [],
      },
    }, {
      persist: () => false,
      flush,
    })).rejects.toBeInstanceOf(TaskWorkflowCheckpointError);
    expect(flush).not.toHaveBeenCalled();
  });

  it('preserves restart receipts at the compiled fence, then replaces them with the completed wave', async () => {
    const persisted: any[] = [];
    const dependencies = {
      persist: (input: any) => {
        persisted.push(input);
        return true;
      },
      flush: async () => undefined,
    };
    await persistTaskWorkflowCheckpointDurably({
      conversationId: 'conversation-1',
      userId: 'task-user',
      taskId: 'task-1',
      resumeNodeReceipts: [recoveredReceipt],
      checkpoint: {
        phase: 'compiled',
        executionGraph: graph,
        nodeReceipts: [],
        privateNodeHandoffs: [],
        completedNodeIds: [],
      },
    }, dependencies);
    await persistTaskWorkflowCheckpointDurably({
      conversationId: 'conversation-1',
      userId: 'task-user',
      taskId: 'task-1',
      resumeNodeReceipts: [recoveredReceipt],
      checkpoint: {
        phase: 'wave_completed',
        executionGraph: graph,
        nodeReceipts: [waveReceipt],
        privateNodeHandoffs: [],
        completedNodeIds: ['wave'],
      },
    }, dependencies);

    expect(persisted[0].nodeReceipts).toEqual([recoveredReceipt]);
    expect(persisted[0].privateNodeHandoffs).toBeUndefined();
    expect(persisted[1].nodeReceipts).toEqual([waveReceipt]);
  });

  it('wires all task terminals through the strict helper and checkpoints executeWorkflow', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'server/socket/task.ts'),
      'utf8',
    );
    expect(source.match(/await commitTaskTerminal\(\{/g)?.length || 0).toBeGreaterThanOrEqual(12);
    expect(source).not.toMatch(/emitAgent\(["']agent:response["']/);
    expect(source).not.toMatch(/emitAgent\(["']agent:error["']/);
    expect(source).toContain('beginChatExecutionDurably(');
    expect(source).toContain('await persistTaskWorkflowCheckpointDurably({');
    expect(source).toContain('if (orchErr instanceof TaskWorkflowCheckpointError || workflowCheckpointed) throw orchErr;');
    expect(source).toContain('await flush();');
  });
});
