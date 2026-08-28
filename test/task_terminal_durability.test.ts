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

const taskScope: ChatExecutionScope = {
  userId: 'task-user',
  domain: 'personal',
  source: 'task',
};

function memoryPersistence() {
  const rows: PersistedChatExecutionReceipt[] = [];
  const adapter: ChatExecutionPersistenceAdapter = {
    async loadRecoverable(nowIso) {
      return rows.filter(row => row.expiresAt > nowIso).map(row => structuredClone(row));
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
    expect(order).toEqual(['state', 'message', 'flush_failed', 'unknown_receipt', 'publish_unknown']);
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

  it('wires all task terminals through the strict durability boundary', () => {
    const source = readFileSync(path.join(process.cwd(), 'server/socket/task.ts'), 'utf8');
    expect(source.match(/await commitTaskTerminal\(\{/g)?.length || 0).toBeGreaterThanOrEqual(10);
    expect(source).not.toMatch(/emitAgent\(["']agent:response["']/);
    expect(source).not.toMatch(/emitAgent\(["']agent:error["']/);
    expect(source).toContain('beginChatExecutionDurably(');
    expect(source).toContain('flush: flushDBOrThrow');
    expect(source).not.toContain('executeWorkflow(');
  });
});
