import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureDatabaseInitialized, querySQL, runSQL } from '../db_layer';
import {
  beginChatExecution,
  beginQueuedChatExecution,
  beginChatSidecarExecution,
  getChatExecution,
  getChatSidecarCancellationTarget,
  initializeChatExecutionRegistryPersistence,
  markChatExecutionCancelling,
  persistChatSidecarCancellationIntent,
  recordChatExecutionEvent,
  resetChatExecutionRegistryForTests,
  waitForChatExecutionPersistence,
  waitForChatSidecarCancellationIntent,
  type ChatExecutionPersistenceAdapter,
  type ChatExecutionScope,
  type PersistedChatExecutionReceipt,
} from '../server/socket/chat_execution_registry';

const scope: ChatExecutionScope = {
  userId: 'user-1',
  domain: 'personal',
  source: 'chat',
};

function memoryPersistence(seed: PersistedChatExecutionReceipt[] = []) {
  const rows = seed.map(row => structuredClone(row));
  let upsertCount = 0;
  const identity = (row: PersistedChatExecutionReceipt) => [
    row.userId,
    row.domain,
    row.orgId,
    row.source,
    row.conversationId,
    row.requestId,
  ].join('|');
  const adapter: ChatExecutionPersistenceAdapter = {
    async loadRecoverable(nowIso) {
      return rows
        .filter(row => row.expiresAt > nowIso)
        .map(row => structuredClone(row));
    },
    async upsert(receipt) {
      upsertCount += 1;
      const index = rows.findIndex(row => identity(row) === identity(receipt));
      if (index >= 0) rows.splice(index, 1, structuredClone(receipt));
      else rows.push(structuredClone(receipt));
    },
    async purgeExpired(nowIso) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].expiresAt <= nowIso) rows.splice(index, 1);
      }
    },
  };
  return { adapter, rows, get upsertCount() { return upsertCount; } };
}

afterEach(() => {
  vi.useRealTimers();
  resetChatExecutionRegistryForTests();
});

describe('chat execution registry', () => {
  it('keeps an active execution queryable independently of a socket instance', () => {
    beginChatExecution(scope, 'request-1');
    recordChatExecutionEvent(scope, 'request-1', 'agent:status', {
      status: 'thinking',
      source: 'chat',
      requestId: 'request-1',
    });

    expect(getChatExecution(scope, 'request-1')).toMatchObject({
      requestId: 'request-1',
      status: 'planning',
      terminal: false,
    });
  });

  it('keeps a queued request resumable beyond the client safety probe and promotes it in place', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    vi.setSystemTime(now);
    expect(beginQueuedChatExecution(scope, 'queued-B')).toBe(true);

    vi.setSystemTime(now + 121_000);
    expect(getChatExecution(scope, 'queued-B')).toMatchObject({ queued: true, terminal: false });
    expect(beginChatExecution(scope, 'queued-B')).toBeNull();
    expect(getChatExecution(scope, 'queued-B')).toMatchObject({ queued: false, terminal: false });
  });

  it('commits cancellation and rejects late events from a superseded execution', () => {
    beginChatExecution(scope, 'request-1');
    const superseded = beginChatExecution(scope, 'request-2');

    expect(superseded).toMatchObject({
      requestId: 'request-1',
      status: 'cancelled',
      terminal: true,
      terminalEvent: { event: 'agent:response' },
    });
    expect(recordChatExecutionEvent(scope, 'request-1', 'agent:error', { message: 'late failure' })).toBe(false);
    expect(getChatExecution(scope)).toMatchObject({ requestId: 'request-2', status: 'acknowledged' });
  });

  it('exposes cancelling before a terminal cancellation response', () => {
    beginChatExecution(scope, 'request-1');
    expect(markChatExecutionCancelling(scope, 'request-1')).toMatchObject({ status: 'cancelling', terminal: false });

    expect(recordChatExecutionEvent(scope, 'request-1', 'agent:response', {
      text: '[Cancelled]',
      finalized: true,
      blocked: true,
      reason: 'cancelled',
    })).toBe(true);
    expect(getChatExecution(scope, 'request-1')).toMatchObject({ status: 'cancelled', terminal: true });
  });

  it('accepts an ordinary terminal exactly once', () => {
    beginChatExecution(scope, 'request-terminal-once');
    const payload = { text: 'complete', finalized: true, blocked: false };

    expect(recordChatExecutionEvent(scope, 'request-terminal-once', 'agent:response', payload)).toBe(true);
    expect(recordChatExecutionEvent(scope, 'request-terminal-once', 'agent:response', payload)).toBe(false);
    expect(getChatExecution(scope, 'request-terminal-once')?.terminalEvent?.payload.text).toBe('complete');
  });

  it('isolates personal and work executions for the same user', () => {
    const workScope: ChatExecutionScope = { ...scope, domain: 'work', orgId: 'org-1' };
    beginChatExecution(scope, 'personal-request');
    beginChatExecution(workScope, 'work-request');

    expect(getChatExecution(scope)?.requestId).toBe('personal-request');
    expect(getChatExecution(workScope)?.requestId).toBe('work-request');
  });

  it('keeps executions in separate conversations from superseding each other', () => {
    const firstConversation: ChatExecutionScope = { ...scope, conversationId: 'conversation-1' };
    const secondConversation: ChatExecutionScope = { ...scope, conversationId: 'conversation-2' };

    expect(beginChatExecution(firstConversation, 'request-1')).toBeNull();
    expect(beginChatExecution(secondConversation, 'request-2')).toBeNull();

    expect(getChatExecution(firstConversation)).toMatchObject({ requestId: 'request-1', terminal: false });
    expect(getChatExecution(secondConversation)).toMatchObject({ requestId: 'request-2', terminal: false });
  });

  it('keeps a sidecar status receipt idempotent without replacing the foreground execution', async () => {
    const now = Date.now();
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, now);
    const conversationScope: ChatExecutionScope = { ...scope, conversationId: 'conversation-sidecar' };
    beginChatExecution(conversationScope, 'foreground-A');

    expect(beginChatSidecarExecution(conversationScope, 'status-S')).toBe(true);
    expect(recordChatExecutionEvent(conversationScope, 'status-S', 'agent:response', {
      text: 'still working',
      sidecar: true,
      finalized: true,
      blocked: false,
    })).toBe(true);
    expect(recordChatExecutionEvent(conversationScope, 'status-S', 'agent:response', {
      text: 'duplicate',
      sidecar: true,
      finalized: true,
      blocked: false,
    })).toBe(false);
    await waitForChatExecutionPersistence();

    expect(persistence.upsertCount).toBe(1);
    expect(persistence.rows).toHaveLength(1);
    expect(getChatExecution(conversationScope)).toMatchObject({ requestId: 'foreground-A', terminal: false });
    expect(getChatExecution(conversationScope, 'status-S')).toMatchObject({ sidecar: true, terminal: true });
  });

  it('recovers a durable cancellation tombstone without making it active or cancelling newer work', async () => {
    const now = Date.now();
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, now);
    const conversationScope: ChatExecutionScope = { ...scope, conversationId: 'conversation-control' };
    beginChatExecution(conversationScope, 'foreground-A');
    expect(beginChatSidecarExecution(conversationScope, 'cancel-C')).toBe(true);
    await persistChatSidecarCancellationIntent(conversationScope, 'cancel-C', 'foreground-A');
    await expect(persistChatSidecarCancellationIntent(
      conversationScope,
      'cancel-C',
      'foreground-B',
    )).rejects.toThrow(/target changed/i);

    // Simulate a crash after the intent barrier but before cancelAll/terminal.
    resetChatExecutionRegistryForTests();
    expect(await initializeChatExecutionRegistryPersistence(persistence.adapter, now + 1_000)).toBe(1);
    expect(getChatExecution(conversationScope, 'cancel-C')).toMatchObject({
      sidecar: true,
      status: 'cancelling',
      terminal: false,
    });
    expect(getChatSidecarCancellationTarget(conversationScope, 'cancel-C')).toBe('foreground-A');

    beginChatExecution(conversationScope, 'foreground-B');
    expect(beginChatSidecarExecution(conversationScope, 'cancel-C')).toBe(false);
    expect(getChatExecution(conversationScope)).toMatchObject({ requestId: 'foreground-B', terminal: false });
  });

  it('fails closed when the durable cancellation barrier cannot be written', async () => {
    const failing: ChatExecutionPersistenceAdapter = {
      async loadRecoverable() { return []; },
      async purgeExpired() {},
      async upsert() { throw new Error('disk unavailable'); },
    };
    await initializeChatExecutionRegistryPersistence(failing, Date.now());
    expect(beginChatSidecarExecution(scope, 'cancel-write-failure')).toBe(true);
    const cancelAll = vi.fn();

    try {
      await persistChatSidecarCancellationIntent(scope, 'cancel-write-failure', 'foreground-A');
      cancelAll();
    } catch {}

    expect(cancelAll).not.toHaveBeenCalled();
  });

  it('makes a duplicate control request await the same durable barrier before acknowledging', async () => {
    let rejectWrite!: (error: Error) => void;
    const deferredWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const adapter: ChatExecutionPersistenceAdapter = {
      async loadRecoverable() { return []; },
      async purgeExpired() {},
      async upsert() { await deferredWrite; },
    };
    await initializeChatExecutionRegistryPersistence(adapter, Date.now());
    expect(beginChatSidecarExecution(scope, 'cancel-deferred')).toBe(true);

    const original = persistChatSidecarCancellationIntent(
      scope,
      'cancel-deferred',
      'foreground-A',
    );
    let duplicateAcknowledged = false;
    const duplicate = waitForChatSidecarCancellationIntent(scope, 'cancel-deferred')
      .then(() => { duplicateAcknowledged = true; });
    await Promise.resolve();
    expect(duplicateAcknowledged).toBe(false);

    rejectWrite(new Error('crash before fsync'));
    const [originalResult, duplicateResult] = await Promise.allSettled([original, duplicate]);
    expect(originalResult.status).toBe('rejected');
    expect(duplicateResult.status).toBe('rejected');
    expect(duplicateAcknowledged).toBe(false);
  });

  it('retains a settled cancellation sidecar for the full control replay window', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    vi.setSystemTime(now);
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, now);
    expect(beginChatSidecarExecution(scope, 'cancel-retained')).toBe(true);
    await persistChatSidecarCancellationIntent(scope, 'cancel-retained', 'foreground-A');
    expect(recordChatExecutionEvent(scope, 'cancel-retained', 'agent:response', {
      text: 'cancelled',
      sidecar: true,
      finalized: true,
      blocked: false,
      reason: 'cancelled_by_user',
    })).toBe(true);
    await waitForChatExecutionPersistence();

    resetChatExecutionRegistryForTests();
    const later = now + 31 * 60 * 1_000;
    vi.setSystemTime(later);
    expect(await initializeChatExecutionRegistryPersistence(persistence.adapter, later)).toBe(1);
    expect(beginChatSidecarExecution(scope, 'cancel-retained')).toBe(false);
  });

  it('purges an abandoned in-memory sidecar after the control replay window', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    vi.setSystemTime(now);
    expect(beginChatSidecarExecution(scope, 'cancel-abandoned')).toBe(true);

    vi.setSystemTime(now + 24 * 60 * 60 * 1_000 + 1);
    expect(getChatExecution(scope, 'cancel-abandoned')).toBeNull();
  });

  it('recovers a unique request before the native client knows its conversation id', () => {
    const assignedConversation: ChatExecutionScope = { ...scope, conversationId: 'conversation-1' };
    beginChatExecution(assignedConversation, 'request-1');
    recordChatExecutionEvent(assignedConversation, 'request-1', 'agent:status', { status: 'thinking' });

    expect(getChatExecution(scope, 'request-1')).toMatchObject({
      requestId: 'request-1',
      status: 'planning',
      terminal: false,
    });
    expect(getChatExecution({ ...scope, userId: 'another-user' }, 'request-1')).toBeNull();
  });

  it('recovers a bounded terminal receipt after a registry restart', async () => {
    const now = Date.parse('2026-08-20T00:00:00.000Z');
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, now);
    const assignedConversation: ChatExecutionScope = { ...scope, conversationId: 'conversation-1' };

    beginChatExecution(assignedConversation, 'request-durable');
    expect(recordChatExecutionEvent(assignedConversation, 'request-durable', 'agent:response', {
      text: `done:${'x'.repeat(20_000)}`,
      agentName: 'Lumi',
      finalized: true,
      blocked: false,
      attachments: [{ path: 'D:/private/secret.txt', content: 'attachment-secret' }],
      toolCalls: [{ arguments: { apiKey: 'tool-secret' } }],
      providerTrace: { prompt: 'trace-secret' },
    })).toBe(true);
    await waitForChatExecutionPersistence();

    expect(persistence.rows).toHaveLength(1);
    expect(persistence.rows[0].payload.text).toHaveLength(8_000);
    expect(JSON.stringify(persistence.rows[0].payload)).not.toContain('attachment-secret');
    expect(JSON.stringify(persistence.rows[0].payload)).not.toContain('tool-secret');
    expect(JSON.stringify(persistence.rows[0].payload)).not.toContain('trace-secret');

    resetChatExecutionRegistryForTests();
    expect(await initializeChatExecutionRegistryPersistence(persistence.adapter, now + 1_000)).toBe(1);
    expect(getChatExecution(scope, 'request-durable')).toMatchObject({
      requestId: 'request-durable',
      status: 'completed',
      terminal: true,
      terminalEvent: {
        event: 'agent:response',
        payload: {
          requestId: 'request-durable',
          conversationId: 'conversation-1',
          finalized: true,
        },
      },
    });
  });

  it('keeps durable recovery isolated by user, domain, organization, and source', async () => {
    const now = Date.parse('2026-08-20T01:00:00.000Z');
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, now);
    const workScope: ChatExecutionScope = {
      userId: 'user-1',
      domain: 'work',
      orgId: 'org-1',
      source: 'task',
      conversationId: 'work-conversation',
    };
    beginChatExecution(workScope, 'shared-request-id');
    recordChatExecutionEvent(workScope, 'shared-request-id', 'agent:response', {
      text: 'work complete',
      finalized: true,
    });
    await waitForChatExecutionPersistence();

    resetChatExecutionRegistryForTests();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, now + 1_000);
    expect(getChatExecution({ ...workScope, conversationId: undefined }, 'shared-request-id')).toMatchObject({
      status: 'completed',
    });
    expect(getChatExecution({ ...workScope, userId: 'user-2' }, 'shared-request-id')).toBeNull();
    expect(getChatExecution({ ...workScope, domain: 'personal', orgId: '' }, 'shared-request-id')).toBeNull();
    expect(getChatExecution({ ...workScope, orgId: 'org-2' }, 'shared-request-id')).toBeNull();
    expect(getChatExecution({ ...workScope, source: 'chat' }, 'shared-request-id')).toBeNull();
  });

  it('purges expired durable receipts instead of hydrating them', async () => {
    const now = Date.parse('2026-08-20T02:00:00.000Z');
    const persistence = memoryPersistence([{
      userId: 'user-1',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      conversationId: 'old-conversation',
      requestId: 'expired-request',
      status: 'completed',
      event: 'agent:response',
      payload: { text: 'old result', finalized: true },
      createdAt: new Date(now - 3_600_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
    }]);

    expect(await initializeChatExecutionRegistryPersistence(persistence.adapter, now)).toBe(0);
    expect(persistence.rows).toHaveLength(0);
    expect(getChatExecution(scope, 'expired-request')).toBeNull();
  });

  it('round-trips a terminal receipt through the real SQLite store across reopen', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sqliteScope: ChatExecutionScope = {
      userId: `sqlite-user-${suffix}`,
      domain: 'personal',
      source: 'chat',
      conversationId: `sqlite-conversation-${suffix}`,
    };
    const requestId = `sqlite-request-${suffix}`;

    await ensureDatabaseInitialized();
    await initializeChatExecutionRegistryPersistence();
    beginChatExecution(sqliteScope, requestId);
    recordChatExecutionEvent(sqliteScope, requestId, 'agent:response', {
      text: 'durable SQLite result',
      finalized: true,
      blocked: false,
      internalPayload: 'must-not-be-persisted',
    });
    await waitForChatExecutionPersistence();

    const stored = await querySQL<any>(
      `SELECT payload FROM chat_execution_terminal_receipts
       WHERE userId = ? AND requestId = ?`,
      [sqliteScope.userId, requestId],
    );
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].payload)).toMatchObject({
      text: 'durable SQLite result',
      requestId,
      finalized: true,
    });
    expect(stored[0].payload).not.toContain('must-not-be-persisted');

    resetChatExecutionRegistryForTests();
    await closeDatabase();
    await ensureDatabaseInitialized();
    expect(await initializeChatExecutionRegistryPersistence()).toBeGreaterThanOrEqual(1);
    expect(getChatExecution({ ...sqliteScope, conversationId: undefined }, requestId)).toMatchObject({
      status: 'completed',
      terminal: true,
      terminalEvent: {
        event: 'agent:response',
        payload: { text: 'durable SQLite result', requestId },
      },
    });

    await runSQL(
      'DELETE FROM chat_execution_terminal_receipts WHERE userId = ? AND requestId = ?',
      [sqliteScope.userId, requestId],
    );
  });
});
