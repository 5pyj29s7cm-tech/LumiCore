import { parseStoredObject as parsePayload } from '../../tools/receipt_payload';
import { ensureDatabaseInitialized, querySQL, runSQL } from '../../../db_layer';

import { type ChatExecutionScope, type ChatExecutionEvent, type ChatExecutionPersistenceAdapter, TERMINAL_RETENTION_MS, CONTROL_INTENT_RETENTION_MS, PERSISTENT_PURGE_INTERVAL_MS } from './contracts';
import { resolveSidecarDurability, executionState } from './state';
import { normalizedScopeKey, normalizedRecoveryScopeKey, normalizedConversationKey, executionKey, receiptIdentity } from './identity';
import { compactString } from './payload';

export function enqueueStrictPersistence(
  operation: (adapter: ChatExecutionPersistenceAdapter) => Promise<void>,
): Promise<void> {
  // Strict terminal writes may be reached by isolated Socket handlers in tests
  // or during a narrow startup race before recovery hydration completes. The
  // built-in SQLite adapter remains a valid durable sink in that window; never
  // downgrade a strict write to the legacy fire-and-forget/no-op behavior.
  const adapter = executionState.persistenceAdapter || sqlitePersistenceAdapter;
  const attempt = executionState.persistenceQueue.then(() => operation(adapter));
  executionState.persistenceQueue = attempt.catch(error => {
    console.warn('[ChatExecution] Persistence queue operation failed:', error);
  });
  return attempt;
}

const sqlitePersistenceAdapter: ChatExecutionPersistenceAdapter = {
  async loadRecoverable(nowIso) {
    await ensureDatabaseInitialized();
    const rows = await querySQL<any>(
      `SELECT userId, domain, orgId, source, conversationId, requestId,
              status, event, payload, createdAt, updatedAt, expiresAt
       FROM chat_execution_terminal_receipts
       WHERE expiresAt > ?
       ORDER BY updatedAt ASC`,
      [nowIso],
    );
    return rows.map(row => ({ ...row, payload: parsePayload(row.payload) }));
  },
  async upsert(receipt) {
    await ensureDatabaseInitialized();
    await runSQL(
      `INSERT INTO chat_execution_terminal_receipts
        (userId, domain, orgId, source, conversationId, requestId,
         status, event, payload, createdAt, updatedAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(userId, domain, orgId, source, conversationId, requestId)
       DO UPDATE SET status = excluded.status, event = excluded.event,
         payload = excluded.payload, updatedAt = excluded.updatedAt,
         expiresAt = excluded.expiresAt`,
      [
        receipt.userId,
        receipt.domain,
        receipt.orgId,
        receipt.source,
        receipt.conversationId,
        receipt.requestId,
        receipt.status,
        receipt.event,
        JSON.stringify(receipt.payload),
        receipt.createdAt,
        receipt.updatedAt,
        receipt.expiresAt,
      ],
    );
  },
  async purgeExpired(nowIso) {
    await ensureDatabaseInitialized();
    await runSQL('DELETE FROM chat_execution_terminal_receipts WHERE expiresAt <= ?', [nowIso]);
  },
  async deleteConversation(scope) {
    await ensureDatabaseInitialized();
    await runSQL(
      'DELETE FROM chat_execution_terminal_receipts WHERE userId = ? AND domain = ? AND orgId = ? AND conversationId = ?',
      [scope.userId, scope.domain, scope.domain === 'work' ? String(scope.orgId || '') : '', String(scope.conversationId || '')],
    );
  },
};

/** Delete recovery copies too, after any receipt write already in flight. */
export async function forgetConversationChatExecutionsDurably(
  scope: Pick<ChatExecutionScope, 'userId' | 'domain' | 'orgId' | 'conversationId'>,
): Promise<void> {
  scope = { ...scope };
  if (!scope.conversationId) throw new Error('A conversation identity is required for deletion');
  executionState.recoveryBatch?.retiredConversations.add(normalizedConversationKey(scope));
  for (const [key, record] of executionState.executions) {
    if (record.scopeKey !== normalizedScopeKey({ ...scope, source: record.source })) continue;
    // Release duplicate sidecar waiters without keeping private recovery text.
    resolveSidecarDurability(record);
    executionState.executions.delete(key);
    if (executionState.activeByScope.get(record.scopeKey) === key) executionState.activeByScope.delete(record.scopeKey);
  }
  await enqueueStrictPersistence(async adapter => {
    if (!adapter.deleteConversation) throw new Error('Conversation recovery deletion is unavailable');
    await adapter.deleteConversation(scope);
  });
}

export function purgeExpiredExecutions(now = Date.now()): void {
  for (const [key, record] of executionState.executions.entries()) {
    const retentionMs = record.sidecar === true
      ? CONTROL_INTENT_RETENTION_MS
      : TERMINAL_RETENTION_MS;
    if (!record.terminal && record.sidecar !== true) continue;
    if (now - Date.parse(record.updatedAt) <= retentionMs) continue;
    executionState.executions.delete(key);
    if (executionState.activeByScope.get(record.scopeKey) === key) executionState.activeByScope.delete(record.scopeKey);
  }
  if (executionState.persistenceAdapter && now - executionState.lastPersistentPurgeAt >= PERSISTENT_PURGE_INTERVAL_MS) {
    executionState.lastPersistentPurgeAt = now;
    void enqueueStrictPersistence(adapter => adapter.purgeExpired(new Date(now).toISOString()));
  }
}

export async function initializeChatExecutionRegistryPersistence(
  adapter: ChatExecutionPersistenceAdapter = sqlitePersistenceAdapter,
  now = Date.now(),
): Promise<number> {
  const batch = { retiredConversations: new Set<string>() };
  executionState.recoveryBatch = batch;
  try {
    executionState.persistenceAdapter = adapter;
    executionState.lastPersistentPurgeAt = now;
    const nowIso = new Date(now).toISOString();
    let receipts: import('./contracts').PersistedChatExecutionReceipt[] = [];
    // Recovery reads share the receipt queue: an already accepted deletion
    // must settle before a new read can observe recovery rows.
    await enqueueStrictPersistence(async acceptedAdapter => {
      if (executionState.recoveryBatch !== batch) return;
      await acceptedAdapter.purgeExpired(nowIso);
      if (executionState.recoveryBatch !== batch) return;
      receipts = await acceptedAdapter.loadRecoverable(nowIso);
    });
    if (executionState.recoveryBatch !== batch) return 0;
    const seen = new Set<string>();
    let hydrated = 0;

    for (const receipt of receipts) {
      if (seen.has(receiptIdentity(receipt))) continue;
      seen.add(receiptIdentity(receipt));
      if (!receipt.userId || !receipt.requestId || !receipt.source) continue;
      if (receipt.domain !== 'personal' && receipt.domain !== 'work') continue;
      const receiptPayload = parsePayload(receipt.payload);
      const isSidecarControlIntent = receipt.status === 'cancelling'
        && receipt.event === 'agent:status'
        && receiptPayload.sidecar === true
        && receiptPayload.controlIntent === 'cancel';
      const isTerminalReceipt = ['completed', 'cancelled', 'failed'].includes(receipt.status)
        && ['agent:response', 'agent:error'].includes(receipt.event)
        && (receipt.event !== 'agent:error' || receipt.status === 'failed');
      const isTerminalCancellationBinding = isTerminalReceipt
        && receiptPayload.sidecar === true
        && receiptPayload.controlIntent === 'cancel'
        && Boolean(compactString(receiptPayload.targetRequestId, 180));
      if (!isSidecarControlIntent && !isTerminalReceipt) continue;
      const updatedAtMs = Date.parse(receipt.updatedAt);
      const expiresAtMs = Date.parse(receipt.expiresAt);
      if (!Number.isFinite(updatedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;

      const scope: ChatExecutionScope = {
        userId: receipt.userId,
        domain: receipt.domain,
        orgId: receipt.domain === 'work' ? receipt.orgId : '',
        source: receipt.source,
        conversationId: receipt.conversationId,
      };
      if (batch.retiredConversations.has(normalizedConversationKey(scope))) continue;
      const scopeKey = normalizedScopeKey(scope);
      const key = executionKey(scope, receipt.requestId);
      if (executionState.executions.get(key)?.inProcess) continue;
      const recoveredEvent: ChatExecutionEvent = {
        event: receipt.event,
        payload: {
          ...receiptPayload,
          source: receipt.source,
          requestId: receipt.requestId,
          conversationId: receipt.conversationId,
        },
      };
      executionState.executions.set(key, {
        scopeKey,
        recoveryScopeKey: normalizedRecoveryScopeKey(scope),
        requestId: receipt.requestId,
        source: receipt.source,
        ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
        sidecar: recoveredEvent.payload.sidecar === true,
        controlIntentTarget: isSidecarControlIntent || isTerminalCancellationBinding
          ? compactString(recoveredEvent.payload.targetRequestId, 180)
          : undefined,
        controlIntentDurable: isSidecarControlIntent || isTerminalCancellationBinding,
        status: receipt.status,
        createdAt: receipt.createdAt,
        updatedAt: receipt.updatedAt,
        terminal: isTerminalReceipt,
        lastEvent: recoveredEvent,
        terminalEvent: isTerminalReceipt ? recoveredEvent : undefined,
        terminalReceiptDurable: isTerminalReceipt,
      });

      if (recoveredEvent.payload.sidecar !== true) {
        const activeKey = executionState.activeByScope.get(scopeKey);
        const active = activeKey ? executionState.executions.get(activeKey) : undefined;
        if (!active || (!active.inProcess && Date.parse(active.updatedAt) <= updatedAtMs)) executionState.activeByScope.set(scopeKey, key);
      }
      hydrated += 1;
    }
    return hydrated;
  } finally {
    if (executionState.recoveryBatch === batch) executionState.recoveryBatch = null;
  }
}

export async function waitForChatExecutionPersistence(): Promise<void> {
  await executionState.persistenceQueue;
}
