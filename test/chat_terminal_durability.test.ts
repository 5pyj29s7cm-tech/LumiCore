import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commitChatTerminalBoundary } from '../server/socket/chat_terminal_boundary';
import {
  beginChatExecution,
  getChatExecution,
  initializeChatExecutionRegistryPersistence,
  recordChatExecutionPersistenceUnknownDurably,
  recordChatExecutionTerminalEventDurably,
  resetChatExecutionRegistryForTests,
  type ChatExecutionPersistenceAdapter,
  type PersistedChatExecutionReceipt,
} from '../server/socket/chat_execution_registry';

afterEach(() => {
  resetChatExecutionRegistryForTests();
});

describe('chat terminal durability boundary', () => {
  it('publishes success, task relation, and conversation updates only after the strict flush', async () => {
    const events: string[] = [];
    let releaseFlush!: () => void;
    let releaseReceipt!: () => void;
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve; });
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });

    const commit = commitChatTerminalBoundary({
      persistTerminalState: () => {
        events.push('persist:terminal');
        return { recorded: true };
      },
      persistAssistantMessage: () => {
        events.push('persist:assistant');
      },
      flush: async () => {
        events.push('flush:start');
        await flushGate;
        events.push('flush:end');
      },
      persistTerminalReceipt: async () => {
        events.push('receipt:start');
        await receiptGate;
        events.push('receipt:end');
        return true;
      },
      persistUnknownReceipt: async () => {
        events.push('receipt:unknown');
        return true;
      },
      publishCommitted: state => {
        expect(state).toEqual({ recorded: true });
        events.push('publish:response');
        events.push('publish:task_relation');
        events.push('publish:conversation_updated');
      },
      publishUnknown: () => {
        events.push('publish:unknown');
      },
    });

    await Promise.resolve();
    expect(events).toEqual([
      'persist:terminal',
      'persist:assistant',
      'flush:start',
    ]);

    releaseFlush();
    await vi.waitFor(() => expect(events).toContain('receipt:start'));
    expect(events).not.toContain('publish:response');
    releaseReceipt();
    await expect(commit).resolves.toBe(true);
    expect(events).toEqual([
      'persist:terminal',
      'persist:assistant',
      'flush:start',
      'flush:end',
      'receipt:start',
      'receipt:end',
      'publish:response',
      'publish:task_relation',
      'publish:conversation_updated',
    ]);
  });

  it('publishes only an unknown/blocked outcome when the strict flush fails', async () => {
    const events: string[] = [];
    const onPersistenceError = vi.fn();

    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => {
        events.push('persist:terminal');
        return null;
      },
      persistAssistantMessage: () => {
        events.push('persist:assistant');
      },
      flush: async () => {
        events.push('flush');
        throw new Error('database unavailable token=private');
      },
      persistTerminalReceipt: async () => {
        events.push('receipt');
        return true;
      },
      persistUnknownReceipt: async () => {
        events.push('receipt:unknown');
        return true;
      },
      publishCommitted: () => {
        events.push('publish:success');
      },
      publishUnknown: () => {
        events.push('publish:unknown');
      },
      onPersistenceError,
    })).resolves.toBe(false);

    expect(events).toEqual([
      'persist:terminal',
      'persist:assistant',
      'flush',
      'receipt:unknown',
      'publish:unknown',
    ]);
    expect(onPersistenceError).toHaveBeenCalledOnce();
  });

  it('does not flush or publish success when the assistant row cannot be staged', async () => {
    const flush = vi.fn(async () => undefined);
    const publishCommitted = vi.fn();
    const publishUnknown = vi.fn();

    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => ({ recorded: true }),
      persistAssistantMessage: () => {
        throw new Error('assistant persistence failed');
      },
      flush,
      persistTerminalReceipt: async () => true,
      persistUnknownReceipt: async () => true,
      publishCommitted,
      publishUnknown,
    })).resolves.toBe(false);

    expect(flush).not.toHaveBeenCalled();
    expect(publishCommitted).not.toHaveBeenCalled();
    expect(publishUnknown).toHaveBeenCalledOnce();
  });

  it('publishes only persistence_unknown when the strict terminal receipt fails', async () => {
    const events: string[] = [];
    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => {
        events.push('persist:terminal');
        return null;
      },
      persistAssistantMessage: () => {
        events.push('persist:assistant');
      },
      flush: async () => {
        events.push('flush');
      },
      persistTerminalReceipt: async () => {
        events.push('receipt');
        throw new Error('receipt fsync failed');
      },
      persistUnknownReceipt: async () => {
        events.push('receipt:unknown');
        return true;
      },
      publishCommitted: () => {
        events.push('publish:success');
      },
      publishUnknown: () => {
        events.push('publish:unknown');
      },
    })).resolves.toBe(false);

    expect(events).toEqual([
      'persist:terminal',
      'persist:assistant',
      'flush',
      'receipt',
      'receipt:unknown',
      'publish:unknown',
    ]);
  });

  it('does not republish when a concurrent durable owner already committed the receipt', async () => {
    const publishCommitted = vi.fn();
    const publishUnknown = vi.fn();
    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => null,
      persistAssistantMessage: () => undefined,
      flush: async () => undefined,
      persistTerminalReceipt: async () => false,
      persistUnknownReceipt: async () => true,
      publishCommitted,
      publishUnknown,
    })).resolves.toBe(false);

    expect(publishCommitted).not.toHaveBeenCalled();
    expect(publishUnknown).not.toHaveBeenCalled();
  });

  it('does not publish a duplicate unknown when another caller owns its durable quarantine', async () => {
    const publishCommitted = vi.fn();
    const publishUnknown = vi.fn();
    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => null,
      persistAssistantMessage: () => undefined,
      flush: async () => { throw new Error('primary flush failed'); },
      persistTerminalReceipt: async () => true,
      persistUnknownReceipt: async () => false,
      publishCommitted,
      publishUnknown,
    })).resolves.toBe(false);

    expect(publishCommitted).not.toHaveBeenCalled();
    expect(publishUnknown).not.toHaveBeenCalled();
  });

  it('turns a primary flush failure into a recoverable unknown terminal instead of leaving it active', async () => {
    const rows: PersistedChatExecutionReceipt[] = [];
    const adapter: ChatExecutionPersistenceAdapter = {
      async loadRecoverable() { return rows.map(row => structuredClone(row)); },
      async purgeExpired() {},
      async upsert(receipt) { rows.splice(0, rows.length, structuredClone(receipt)); },
    };
    const scope = { userId: 'user-boundary', domain: 'personal' as const, source: 'chat' };
    await initializeChatExecutionRegistryPersistence(adapter, Date.now());
    beginChatExecution(scope, 'request-flush-failure');
    const success = { text: 'uncommitted success', finalized: true, blocked: false };
    const unknown = {
      text: 'The result could not be safely recorded.',
      finalized: true,
      blocked: true,
      reason: 'persistence_unknown',
    };
    const publishCommitted = vi.fn();
    const publishUnknown = vi.fn();

    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => null,
      persistAssistantMessage: () => undefined,
      flush: async () => { throw new Error('primary flush failed'); },
      persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
        scope,
        'request-flush-failure',
        'agent:response',
        success,
        unknown,
      ),
      persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
          scope,
          'request-flush-failure',
          unknown,
        ),
      publishCommitted,
      publishUnknown,
    })).resolves.toBe(false);

    expect(publishCommitted).not.toHaveBeenCalled();
    expect(publishUnknown).toHaveBeenCalledOnce();
    expect(getChatExecution(scope, 'request-flush-failure')).toMatchObject({
      terminal: true,
      status: 'failed',
      terminalEvent: { payload: { reason: 'persistence_unknown', blocked: true } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ reason: 'persistence_unknown', blocked: true });
    expect(JSON.stringify(rows[0])).not.toContain('uncommitted success');
  });

  it('wires both chat finalization paths through the same strict boundary', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'server/socket/chat.ts'),
      'utf8',
    );
    const starts = [...source.matchAll(/const terminalCommitted = await commitChatTerminalBoundary\(\{/g)]
      .map(match => match.index || 0);

    expect(starts).toHaveLength(2);
    expect(source).toContain('import { flushDBOrThrow, readDB, writeDB } from "../../db_layer";');
    expect(source.match(/reason: 'persistence_unknown'/g)?.length || 0).toBeGreaterThanOrEqual(2);

    for (const start of starts) {
      const end = source.indexOf('if (!terminalCommitted)', start);
      const boundary = source.slice(start, end);
      const terminalState = boundary.indexOf('persistTerminalState:');
      const takeoverWrite = boundary.indexOf('persistChatTakeoverExecution(', terminalState);
      const assistantWrite = boundary.indexOf('persistAssistantMessage:', takeoverWrite);
      const flush = boundary.indexOf('flush: flushDBOrThrow', assistantWrite);
      const receipt = boundary.indexOf('persistTerminalReceipt:', flush);
      const strictReceipt = boundary.indexOf('recordChatExecutionTerminalEventDurably(', receipt);
      const committed = boundary.indexOf('publishCommitted:', strictReceipt);
      const response = boundary.indexOf("publishRecordedAgent('agent:response'", committed);
      const relation = boundary.indexOf('publishDurableTaskRelation()', response);
      const conversationUpdate = boundary.indexOf('emitConversationUpdated(', relation);

      expect(terminalState).toBeGreaterThan(-1);
      expect(takeoverWrite).toBeGreaterThan(terminalState);
      expect(assistantWrite).toBeGreaterThan(takeoverWrite);
      expect(flush).toBeGreaterThan(assistantWrite);
      expect(receipt).toBeGreaterThan(flush);
      expect(strictReceipt).toBeGreaterThan(receipt);
      expect(committed).toBeGreaterThan(strictReceipt);
      expect(response).toBeGreaterThan(committed);
      expect(relation).toBeGreaterThan(response);
      expect(conversationUpdate).toBeGreaterThan(relation);
      expect(boundary).not.toContain("emitAgent('agent:notification'");
      expect(boundary).not.toContain("emitAgent('agent:task_execution_writeback'");
      expect(boundary).toMatch(/publishRecordedAgent\(\s*'agent:notification'/);
      expect(boundary).toMatch(/publishRecordedAgent\(\s*'agent:task_execution_writeback'/);
    }

    expect(source).not.toContain('A completed model turn must unlock the native chat surface before');
  });
});
