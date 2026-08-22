import { ensureDatabaseInitialized, querySQL, runSQL } from '../../db_layer';

export type ChatExecutionStatus =
  | 'acknowledged'
  | 'planning'
  | 'executing'
  | 'waiting_confirmation'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ChatExecutionScope = {
  userId: string;
  domain: 'personal' | 'work';
  orgId?: string;
  source: string;
  conversationId?: string;
};

export type ChatExecutionEvent = {
  event: string;
  payload: Record<string, any>;
};

export type ChatExecutionSnapshot = {
  requestId: string;
  source: string;
  /** Sidecar requests have durable receipts but never own the foreground slot. */
  sidecar?: boolean;
  /** Reserved behind another foreground turn; exact-id resumable, never active. */
  queued?: boolean;
  status: ChatExecutionStatus;
  createdAt: string;
  updatedAt: string;
  terminal: boolean;
  lastEvent?: ChatExecutionEvent;
  terminalEvent?: ChatExecutionEvent;
};

type StoredExecution = ChatExecutionSnapshot & {
  scopeKey: string;
  recoveryScopeKey: string;
  controlIntentTarget?: string;
  controlIntentDurable?: boolean;
  controlIntentBarrier?: Promise<void>;
};

export type PersistedChatExecutionReceipt = {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  source: string;
  conversationId: string;
  requestId: string;
  status: 'cancelling' | 'completed' | 'cancelled' | 'failed';
  event: string;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type ChatExecutionPersistenceAdapter = {
  loadRecoverable(nowIso: string): Promise<PersistedChatExecutionReceipt[]>;
  upsert(receipt: PersistedChatExecutionReceipt): Promise<void>;
  purgeExpired(nowIso: string): Promise<void>;
};

const TERMINAL_RETENTION_MS = 30 * 60 * 1000;
const CONTROL_INTENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PERSISTENT_PURGE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TERMINAL_TEXT_CHARS = 8_000;
const MAX_TERMINAL_ERROR_CHARS = 1_000;
const executions = new Map<string, StoredExecution>();
const activeByScope = new Map<string, string>();
let persistenceAdapter: ChatExecutionPersistenceAdapter | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();
let lastPersistentPurgeAt = 0;

function normalizedScopeKey(scope: ChatExecutionScope): string {
  const orgId = scope.domain === 'work' ? String(scope.orgId || '') : '';
  return `${scope.userId}:${scope.domain}:${orgId}:${scope.source || 'chat'}:${String(scope.conversationId || '')}`;
}

function normalizedRecoveryScopeKey(scope: ChatExecutionScope): string {
  const orgId = scope.domain === 'work' ? String(scope.orgId || '') : '';
  return `${scope.userId}:${scope.domain}:${orgId}:${scope.source || 'chat'}`;
}

function executionKey(scope: ChatExecutionScope, requestId: string): string {
  return `${normalizedScopeKey(scope)}:${requestId}`;
}

function compactString(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/\0/g, '').trim().slice(0, limit)
    : '';
}

function parsePayload(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function sanitizeTerminalPayload(
  scope: ChatExecutionScope,
  record: StoredExecution,
): Record<string, any> {
  const terminal = record.terminalEvent;
  if (!terminal) return {};
  const payload = terminal.payload || {};
  const sanitized: Record<string, any> = {
    source: record.source,
    requestId: record.requestId,
    conversationId: compactString(scope.conversationId, 180),
    sidecar: record.sidecar === true,
    finalized: payload.finalized === true,
    blocked: payload.blocked === true,
  };

  // Recovery needs the final user-visible receipt, not the complete execution
  // payload. Persist only an allowlisted, bounded subset: never tool inputs,
  // attachments, history, provider traces, or arbitrary nested metadata.
  const reason = compactString(payload.reason, 80);
  const agentName = compactString(payload.agentName, 120);
  if (reason) sanitized.reason = reason;
  if (agentName) sanitized.agentName = agentName;
  if (record.sidecar === true && record.controlIntentTarget) {
    sanitized.controlIntent = 'cancel';
    sanitized.targetRequestId = compactString(record.controlIntentTarget, 180);
  }
  if (terminal.event === 'agent:response') {
    const text = compactString(payload.text, MAX_TERMINAL_TEXT_CHARS);
    if (text) sanitized.text = text;
  } else if (terminal.event === 'agent:error') {
    const message = compactString(payload.message, MAX_TERMINAL_ERROR_CHARS);
    if (message) sanitized.message = message;
    const code = compactString(payload.code, 120);
    if (code) sanitized.code = code;
  }
  return sanitized;
}

function persistedReceipt(
  scope: ChatExecutionScope,
  record: StoredExecution,
): PersistedChatExecutionReceipt | null {
  if (!record.terminal || !record.terminalEvent) return null;
  if (!['completed', 'cancelled', 'failed'].includes(record.status)) return null;
  if (!['agent:response', 'agent:error'].includes(record.terminalEvent.event)) return null;
  return {
    userId: compactString(scope.userId, 180),
    domain: scope.domain === 'work' ? 'work' : 'personal',
    orgId: scope.domain === 'work' ? compactString(scope.orgId, 180) : '',
    source: compactString(scope.source || record.source || 'chat', 120) || 'chat',
    conversationId: compactString(scope.conversationId, 180),
    requestId: compactString(record.requestId, 180),
    status: record.status as PersistedChatExecutionReceipt['status'],
    event: compactString(record.terminalEvent.event, 120),
    payload: sanitizeTerminalPayload(scope, record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: new Date(
      Date.parse(record.updatedAt)
      + (record.sidecar === true ? CONTROL_INTENT_RETENTION_MS : TERMINAL_RETENTION_MS),
    ).toISOString(),
  };
}

function receiptIdentity(receipt: PersistedChatExecutionReceipt): string {
  return [
    receipt.userId,
    receipt.domain,
    receipt.orgId,
    receipt.source,
    receipt.conversationId,
    receipt.requestId,
  ].join('\u001f');
}

function enqueuePersistence(operation: (adapter: ChatExecutionPersistenceAdapter) => Promise<void>): void {
  const adapter = persistenceAdapter;
  if (!adapter) return;
  persistenceQueue = persistenceQueue
    .then(() => operation(adapter))
    .catch(error => {
      console.warn('[ChatExecution] Durable terminal receipt write failed:', error);
    });
}

function enqueueStrictPersistence(
  operation: (adapter: ChatExecutionPersistenceAdapter) => Promise<void>,
): Promise<void> {
  const adapter = persistenceAdapter;
  if (!adapter) return Promise.reject(new Error('Chat execution persistence is unavailable'));
  const attempt = persistenceQueue.then(() => operation(adapter));
  persistenceQueue = attempt.catch(error => {
    console.warn('[ChatExecution] Durable control receipt write failed:', error);
  });
  return attempt;
}

function persistTerminal(scope: ChatExecutionScope, record: StoredExecution): void {
  const receipt = persistedReceipt(scope, record);
  if (!receipt) return;
  enqueuePersistence(adapter => adapter.upsert(receipt));
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
};

function copySnapshot(record?: StoredExecution): ChatExecutionSnapshot | null {
  if (!record) return null;
  const {
    scopeKey: _scopeKey,
    recoveryScopeKey: _recoveryScopeKey,
    controlIntentTarget: _controlIntentTarget,
    controlIntentDurable: _controlIntentDurable,
    controlIntentBarrier: _controlIntentBarrier,
    ...snapshot
  } = record;
  return {
    ...snapshot,
    lastEvent: snapshot.lastEvent
      ? { event: snapshot.lastEvent.event, payload: { ...snapshot.lastEvent.payload } }
      : undefined,
    terminalEvent: snapshot.terminalEvent
      ? { event: snapshot.terminalEvent.event, payload: { ...snapshot.terminalEvent.payload } }
      : undefined,
  };
}

function purgeExpiredExecutions(now = Date.now()): void {
  for (const [key, record] of executions.entries()) {
    const retentionMs = record.sidecar === true
      ? CONTROL_INTENT_RETENTION_MS
      : TERMINAL_RETENTION_MS;
    if (!record.terminal && record.sidecar !== true) continue;
    if (now - Date.parse(record.updatedAt) <= retentionMs) continue;
    executions.delete(key);
    if (activeByScope.get(record.scopeKey) === key) activeByScope.delete(record.scopeKey);
  }
  if (persistenceAdapter && now - lastPersistentPurgeAt >= PERSISTENT_PURGE_INTERVAL_MS) {
    lastPersistentPurgeAt = now;
    enqueuePersistence(adapter => adapter.purgeExpired(new Date(now).toISOString()));
  }
}

function terminalStatusForEvent(event: string, payload: Record<string, any>): ChatExecutionStatus | null {
  if (event === 'agent:error') return 'failed';
  if (event !== 'agent:response') return null;
  const reason = String(payload.reason || '').trim().toLowerCase();
  if (reason === 'cancelled' || reason === 'canceled') return 'cancelled';
  if (payload.blocked === true || payload.finalized !== true) return 'failed';
  return 'completed';
}

function statusForEvent(
  current: ChatExecutionStatus,
  event: string,
  payload: Record<string, any>,
): ChatExecutionStatus {
  const terminalStatus = terminalStatusForEvent(event, payload);
  if (terminalStatus) return terminalStatus;
  if (event === 'agent:confirm_tool') return 'waiting_confirmation';
  if (event === 'agent:tool' || event === 'agent:tool_call') return 'executing';
  if (event === 'agent:status') {
    const status = String(payload.status || '').trim().toLowerCase();
    if (status === 'thinking') return 'planning';
    if (status === 'responding' || status === 'executing') return 'executing';
    if (status === 'waiting_confirmation') return 'waiting_confirmation';
    if (status === 'cancelling') return 'cancelling';
    if (status === 'error') return 'failed';
  }
  return current;
}

export function beginChatExecution(
  scope: ChatExecutionScope,
  requestId: string,
): ChatExecutionSnapshot | null {
  purgeExpiredExecutions();
  const scopeKey = normalizedScopeKey(scope);
  const previousKey = activeByScope.get(scopeKey);
  const previous = previousKey ? executions.get(previousKey) : undefined;
  let superseded: ChatExecutionSnapshot | null = null;
  if (previous && !previous.terminal && previous.requestId !== requestId) {
    const now = new Date().toISOString();
    const payload = {
      text: '[Cancelled]',
      agentName: 'Lumi',
      source: previous.source,
      requestId: previous.requestId,
      conversationId: scope.conversationId,
      finalized: true,
      blocked: true,
      reason: 'cancelled',
    };
    previous.status = 'cancelled';
    previous.terminal = true;
    previous.updatedAt = now;
    previous.lastEvent = { event: 'agent:response', payload };
    previous.terminalEvent = previous.lastEvent;
    superseded = copySnapshot(previous);
    persistTerminal(scope, previous);
  }

  const now = new Date().toISOString();
  const key = executionKey(scope, requestId);
  const reserved = executions.get(key);
  if (reserved && !reserved.terminal && reserved.queued === true) {
    reserved.queued = false;
    reserved.status = 'acknowledged';
    reserved.updatedAt = now;
    activeByScope.set(scopeKey, key);
    return superseded;
  }
  executions.set(key, {
    scopeKey,
    recoveryScopeKey: normalizedRecoveryScopeKey(scope),
    requestId,
    source: scope.source || 'chat',
    status: 'acknowledged',
    createdAt: now,
    updatedAt: now,
    terminal: false,
  });
  activeByScope.set(scopeKey, key);
  return superseded;
}

/** Reserve a FIFO request before it becomes the active foreground execution. */
export function beginQueuedChatExecution(
  scope: ChatExecutionScope,
  requestId: string,
): boolean {
  purgeExpiredExecutions();
  const key = executionKey(scope, requestId);
  if (executions.has(key)) return false;
  const now = new Date().toISOString();
  executions.set(key, {
    scopeKey: normalizedScopeKey(scope),
    recoveryScopeKey: normalizedRecoveryScopeKey(scope),
    requestId,
    source: scope.source || 'chat',
    queued: true,
    status: 'acknowledged',
    createdAt: now,
    updatedAt: now,
    terminal: false,
  });
  return true;
}

/**
 * Reserve an idempotency receipt for a status/cancellation side conversation.
 *
 * A sidecar is addressable by its exact request id and persists its terminal
 * result, but deliberately never participates in `activeByScope`. This keeps a
 * retried control utterance from superseding (or becoming) the foreground
 * execution for the conversation.
 *
 * Returns false when the exact request was already reserved, so a caller can
 * replay its existing receipt without executing the side effect again.
 */
export function beginChatSidecarExecution(
  scope: ChatExecutionScope,
  requestId: string,
): boolean {
  purgeExpiredExecutions();
  const key = executionKey(scope, requestId);
  if (executions.has(key)) return false;

  const now = new Date().toISOString();
  executions.set(key, {
    scopeKey: normalizedScopeKey(scope),
    recoveryScopeKey: normalizedRecoveryScopeKey(scope),
    requestId,
    source: scope.source || 'chat',
    sidecar: true,
    status: 'acknowledged',
    createdAt: now,
    updatedAt: now,
    terminal: false,
  });
  return true;
}

/**
 * Durably fence a request-scoped cancellation before touching the foreground
 * queue. If this barrier rejects, the caller must fail closed and must not run
 * the cancellation side effect.
 */
export async function persistChatSidecarCancellationIntent(
  scope: ChatExecutionScope,
  requestId: string,
  targetRequestId: string,
): Promise<void> {
  const record = executions.get(executionKey(scope, requestId));
  if (!record || record.sidecar !== true || record.terminal) {
    throw new Error('Chat sidecar cancellation receipt is not reserved');
  }
  const normalizedTargetRequestId = compactString(targetRequestId, 180);
  if (!normalizedTargetRequestId) throw new Error('Chat sidecar cancellation target is missing');
  if (record.controlIntentTarget && record.controlIntentTarget !== normalizedTargetRequestId) {
    throw new Error('Chat sidecar cancellation target changed for the same request');
  }
  if (record.controlIntentDurable === true) return;
  if (record.controlIntentBarrier) return record.controlIntentBarrier;

  const now = new Date().toISOString();
  const payload = {
    status: 'cancelling',
    source: record.source,
    requestId,
    conversationId: compactString(scope.conversationId, 180),
    sidecar: true,
    controlIntent: 'cancel',
    targetRequestId: normalizedTargetRequestId,
  };
  record.controlIntentTarget = normalizedTargetRequestId;

  const receipt: PersistedChatExecutionReceipt = {
    userId: compactString(scope.userId, 180),
    domain: scope.domain === 'work' ? 'work' : 'personal',
    orgId: scope.domain === 'work' ? compactString(scope.orgId, 180) : '',
    source: compactString(scope.source || record.source || 'chat', 120) || 'chat',
    conversationId: compactString(scope.conversationId, 180),
    requestId: compactString(requestId, 180),
    status: 'cancelling',
    event: 'agent:status',
    payload,
    createdAt: record.createdAt,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + CONTROL_INTENT_RETENTION_MS).toISOString(),
  };
  const barrier = enqueueStrictPersistence(adapter => adapter.upsert(receipt)).then(() => {
    record.controlIntentDurable = true;
    record.status = 'cancelling';
    record.updatedAt = now;
    record.lastEvent = { event: 'agent:status', payload };
  });
  record.controlIntentBarrier = barrier;
  try {
    await barrier;
  } finally {
    if (record.controlIntentBarrier === barrier) record.controlIntentBarrier = undefined;
  }
}

/** Wait for a duplicate control request's original durable reservation. */
export async function waitForChatSidecarCancellationIntent(
  scope: ChatExecutionScope,
  requestId: string,
): Promise<void> {
  const record = executions.get(executionKey(scope, requestId));
  if (!record || record.sidecar !== true || record.terminal) return;
  if (record.controlIntentDurable === true) return;
  if (!record.controlIntentBarrier) {
    throw new Error('Chat sidecar cancellation intent is not durably reserved');
  }
  await record.controlIntentBarrier;
  // Re-read after awaiting: apart from avoiding stale state, this prevents
  // TypeScript from retaining the pre-await `false | undefined` narrowing.
  const refreshed = executions.get(executionKey(scope, requestId));
  if (refreshed?.controlIntentDurable !== true) {
    throw new Error('Chat sidecar cancellation intent is not durably reserved');
  }
}

/** Exact target captured by the durable cancellation tombstone, if any. */
export function getChatSidecarCancellationTarget(
  scope: ChatExecutionScope,
  requestId: string,
): string {
  const record = executions.get(executionKey(scope, requestId));
  if (!record || record.sidecar !== true || record.controlIntentDurable !== true) return '';
  return record.controlIntentTarget || '';
}

export function recordChatExecutionEvent(
  scope: ChatExecutionScope,
  requestId: string,
  event: string,
  payload: Record<string, any>,
): boolean {
  const key = executionKey(scope, requestId);
  const record = executions.get(key);
  if (!record) return false;

  // Once a terminal event has been committed, late errors from an aborted async
  // branch must not overwrite or duplicate the user-visible result.
  if (record.terminal) return false;

  const normalizedPayload = {
    ...payload,
    source: payload.source || record.source,
    requestId,
  };
  const status = statusForEvent(record.status, event, normalizedPayload);
  const terminal = ['completed', 'cancelled', 'failed'].includes(status);
  const nextEvent = { event, payload: normalizedPayload };
  record.status = status;
  record.updatedAt = new Date().toISOString();
  record.terminal = terminal;
  record.lastEvent = nextEvent;
  if (terminal) {
    record.terminalEvent = nextEvent;
    persistTerminal(scope, record);
  }
  return true;
}

export function markChatExecutionCancelling(
  scope: ChatExecutionScope,
  requestId?: string,
): ChatExecutionSnapshot | null {
  const record = resolveExecution(scope, requestId);
  if (!record || record.terminal) return copySnapshot(record);
  record.status = 'cancelling';
  record.updatedAt = new Date().toISOString();
  record.lastEvent = {
    event: 'agent:status',
    payload: {
      status: 'cancelling',
      source: record.source,
      requestId: record.requestId,
      conversationId: scope.conversationId,
    },
  };
  return copySnapshot(record);
}

export function getChatExecution(
  scope: ChatExecutionScope,
  requestId?: string,
): ChatExecutionSnapshot | null {
  purgeExpiredExecutions();
  return copySnapshot(resolveExecution(scope, requestId));
}

function resolveExecution(scope: ChatExecutionScope, requestId?: string): StoredExecution | undefined {
  if (requestId) {
    const exact = executions.get(executionKey(scope, requestId));
    if (exact) return exact;

    // A native client can persist the request before the server assigns the
    // first conversation id. Reconnect probes must still recover that exact
    // request without weakening user/domain/source isolation. Request ids are
    // generated per turn, so only accept a unique match in the recovery scope.
    const recoveryScopeKey = normalizedRecoveryScopeKey(scope);
    const matches = [...executions.values()].filter(record => (
      record.requestId === requestId
      && record.recoveryScopeKey === recoveryScopeKey
    ));
    return matches.length === 1 ? matches[0] : undefined;
  }
  const key = activeByScope.get(normalizedScopeKey(scope));
  return key ? executions.get(key) : undefined;
}

export async function initializeChatExecutionRegistryPersistence(
  adapter: ChatExecutionPersistenceAdapter = sqlitePersistenceAdapter,
  now = Date.now(),
): Promise<number> {
  persistenceAdapter = adapter;
  lastPersistentPurgeAt = now;
  const nowIso = new Date(now).toISOString();
  await adapter.purgeExpired(nowIso);
  const receipts = await adapter.loadRecoverable(nowIso);
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
    const scopeKey = normalizedScopeKey(scope);
    const key = executionKey(scope, receipt.requestId);
    const recoveredEvent: ChatExecutionEvent = {
      event: receipt.event,
      payload: {
        ...receiptPayload,
        source: receipt.source,
        requestId: receipt.requestId,
        conversationId: receipt.conversationId,
      },
    };
    executions.set(key, {
      scopeKey,
      recoveryScopeKey: normalizedRecoveryScopeKey(scope),
      requestId: receipt.requestId,
      source: receipt.source,
      sidecar: recoveredEvent.payload.sidecar === true,
      controlIntentTarget: isSidecarControlIntent
        ? compactString(recoveredEvent.payload.targetRequestId, 180)
        : undefined,
      controlIntentDurable: isSidecarControlIntent,
      status: receipt.status,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      terminal: isTerminalReceipt,
      lastEvent: recoveredEvent,
      terminalEvent: isTerminalReceipt ? recoveredEvent : undefined,
    });

    if (recoveredEvent.payload.sidecar !== true) {
      const activeKey = activeByScope.get(scopeKey);
      const active = activeKey ? executions.get(activeKey) : undefined;
      if (!active || Date.parse(active.updatedAt) <= updatedAtMs) activeByScope.set(scopeKey, key);
    }
    hydrated += 1;
  }
  return hydrated;
}

export async function waitForChatExecutionPersistence(): Promise<void> {
  await persistenceQueue;
}

export function resetChatExecutionRegistryForTests(): void {
  executions.clear();
  activeByScope.clear();
  persistenceAdapter = null;
  persistenceQueue = Promise.resolve();
  lastPersistentPurgeAt = 0;
}
