import { ensureDatabaseInitialized, querySQL, runSQL } from '../../db_layer';
import { normalizeCompletionFeedbackForPersistence } from '../conversation/completion_feedback';

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

export type DurableChatCancellationBinding = {
  controlRequestId: string;
  targetRequestId: string;
  controlTerminal: ChatExecutionSnapshot;
  targetTerminal: ChatExecutionSnapshot;
};

/**
 * Durable conversation/task identity observed by the status route. Recovery
 * receipts alone cannot establish "current": after a restart they contain
 * bounded terminal history, while the conversation ledger may already own a
 * newer accepted request.
 */
export type DurableChatCancellationStatusFence = {
  currentTask?: {
    taskId: string;
    revision: number;
    activeRequestId?: string;
    unfinished: boolean;
  };
  relation?: {
    binding: string;
    taskId?: string;
    revision?: number;
    targetRequestId?: string;
  };
  requestedTarget?: {
    requestId?: string;
    taskId?: string;
    revision?: number;
  };
};

type StoredExecution = ChatExecutionSnapshot & {
  scopeKey: string;
  recoveryScopeKey: string;
  controlIntentTarget?: string;
  controlIntentDurable?: boolean;
  controlIntentBarrier?: Promise<void>;
  /** Installed at sidecar reservation so duplicates can wait before a more
   * specific control-intent or terminal receipt barrier has been created. */
  sidecarDurabilityBarrier?: Promise<void>;
  resolveSidecarDurability?: () => void;
  rejectSidecarDurability?: (error: unknown) => void;
  sidecarDurabilitySettled?: boolean;
  /**
   * A strict terminal is kept private until its durable receipt settles. This
   * prevents reconnect/retry readers from replaying a success that only exists
   * in memory while the database write is still in flight.
   */
  terminalReceiptPending?: {
    status: 'completed' | 'cancelled' | 'failed';
    event: ChatExecutionEvent;
    updatedAt: string;
  };
  terminalReceiptDurable?: boolean;
  terminalReceiptBarrier?: Promise<void>;
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

function finiteRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? Math.trunc(revision) : undefined;
}

function exactTerminalTaskBinding(
  value: unknown,
  requestId: string,
): { taskId: string; revision: number; targetRequestId: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const taskId = compactString(candidate.taskId, 180);
  const targetRequestId = compactString(candidate.targetRequestId, 180);
  const revision = finiteRevision(candidate.revision);
  if (!taskId || revision === undefined || targetRequestId !== compactString(requestId, 180)) {
    return undefined;
  }
  return { taskId, revision, targetRequestId };
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
  const completionFeedback = normalizeCompletionFeedbackForPersistence(payload.completionFeedback);
  if (completionFeedback) sanitized.completionFeedback = completionFeedback;
  const taskBinding = exactTerminalTaskBinding(payload.taskRelation, record.requestId);
  if (taskBinding) sanitized.taskBinding = taskBinding;
  if (record.sidecar === true && record.controlIntentTarget) {
    sanitized.controlIntent = 'cancel';
    sanitized.targetRequestId = compactString(record.controlIntentTarget, 180);
  } else if (
    record.sidecar === true
    && payload.controlIntent === 'status'
    && compactString(payload.targetRequestId, 180)
  ) {
    // A post-terminal status sidecar is a read-only exact-target query. Keep
    // only its bounded target fence so acceptance/reconnect readers can prove
    // it did not silently drift to a newer or merely "latest" execution.
    sanitized.controlIntent = 'status';
    sanitized.targetRequestId = compactString(payload.targetRequestId, 180);
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
  // Strict terminal writes may be reached by isolated Socket handlers in tests
  // or during a narrow startup race before recovery hydration completes. The
  // built-in SQLite adapter remains a valid durable sink in that window; never
  // downgrade a strict write to the legacy fire-and-forget/no-op behavior.
  const adapter = persistenceAdapter || sqlitePersistenceAdapter;
  const attempt = persistenceQueue.then(() => operation(adapter));
  persistenceQueue = attempt.catch(error => {
    console.warn('[ChatExecution] Strict durable receipt write failed:', error);
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
    sidecarDurabilityBarrier: _sidecarDurabilityBarrier,
    resolveSidecarDurability: _resolveSidecarDurability,
    rejectSidecarDurability: _rejectSidecarDurability,
    sidecarDurabilitySettled: _sidecarDurabilitySettled,
    terminalReceiptPending: _terminalReceiptPending,
    terminalReceiptDurable: _terminalReceiptDurable,
    terminalReceiptBarrier: _terminalReceiptBarrier,
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

function terminalStatusForEvent(
  event: string,
  payload: Record<string, any>,
): 'completed' | 'cancelled' | 'failed' | null {
  if (event === 'agent:error') return 'failed';
  if (event !== 'agent:response') return null;
  const reason = String(payload.reason || '').trim().toLowerCase();
  if (
    reason === 'cancelled'
    || reason === 'canceled'
    || reason === 'request_cancelled'
  ) return 'cancelled';
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
    if (status === 'thinking' || status === 'responding') return 'planning';
    // A model composing its answer is not task execution. Explicit execution
    // status is accepted only when the server emitter attaches its own proof;
    // model-authored text or an untrusted status frame cannot promote the
    // durable request to `executing`.
    if (status === 'executing' && payload.executionAccepted === true) return 'executing';
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
  if (previous && !previous.terminal && previous.requestId !== requestId) {
    throw new Error('Active chat execution must be durably superseded before replacement');
  }

  const now = new Date().toISOString();
  const key = executionKey(scope, requestId);
  const reserved = executions.get(key);
  if (reserved && !reserved.terminal && reserved.queued === true) {
    reserved.queued = false;
    reserved.status = 'acknowledged';
    reserved.updatedAt = now;
    activeByScope.set(scopeKey, key);
    return null;
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
  return null;
}

function createSidecarDurabilityBoundary(): Pick<StoredExecution,
  | 'sidecarDurabilityBarrier'
  | 'resolveSidecarDurability'
  | 'rejectSidecarDurability'
  | 'sidecarDurabilitySettled'
> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const barrier = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // The original handler commonly settles the boundary before a duplicate
  // exists. Mark the rejection observed without changing what later awaiters
  // receive from the original promise.
  void barrier.catch(() => undefined);
  return {
    sidecarDurabilityBarrier: barrier,
    resolveSidecarDurability: resolve,
    rejectSidecarDurability: reject,
    sidecarDurabilitySettled: false,
  };
}

function resolveSidecarDurability(record: StoredExecution): void {
  if (record.sidecar !== true || record.sidecarDurabilitySettled === true) return;
  record.sidecarDurabilitySettled = true;
  record.resolveSidecarDurability?.();
}

function rejectSidecarDurability(record: StoredExecution, error: unknown): void {
  if (record.sidecar !== true || record.sidecarDurabilitySettled === true) return;
  record.sidecarDurabilitySettled = true;
  record.rejectSidecarDurability?.(error);
}

/**
 * Strict replacement entry point. The previous foreground cancellation receipt
 * must settle before the replacement becomes active or its cancellation frame
 * can be published by the caller.
 */
export async function beginChatExecutionDurably(
  scope: ChatExecutionScope,
  requestId: string,
  persistenceUnknownPayload: Record<string, any> = {},
): Promise<ChatExecutionSnapshot | null> {
  purgeExpiredExecutions();
  const scopeKey = normalizedScopeKey(scope);
  const previousKey = activeByScope.get(scopeKey);
  const previous = previousKey ? executions.get(previousKey) : undefined;
  let superseded: ChatExecutionSnapshot | null = null;

  if (previous?.requestId === requestId) {
    if (previous.terminalReceiptPending) {
      const barrier = previous.terminalReceiptBarrier;
      if (!barrier) throw new Error('Previous chat terminal receipt barrier is missing');
      await barrier;
    }
    return null;
  }
  if (previous && !previous.terminal) {
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
    let ownsPublication = false;
    try {
      ownsPublication = await recordChatExecutionTerminalEventDurably(
        scope,
        previous.requestId,
        'agent:response',
        payload,
        persistenceUnknownPayload,
      );
    } catch (error) {
      try {
        await recordChatExecutionPersistenceUnknownDurably(
          scope,
          previous.requestId,
          persistenceUnknownPayload,
        );
      } catch {
        // The in-memory unknown quarantine installed by the failed strict
        // terminal must survive even when its own durable write also fails.
      }
      throw error;
    }
    if (ownsPublication) superseded = copySnapshot(previous);
  }

  beginChatExecution(scope, requestId);
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
  const durabilityBoundary = createSidecarDurabilityBoundary();
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
    ...durabilityBoundary,
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
    resolveSidecarDurability(record);
  }).catch(error => {
    rejectSidecarDurability(record, error);
    throw error;
  });
  record.controlIntentBarrier = barrier;
  try {
    await barrier;
  } finally {
    if (record.controlIntentBarrier === barrier) record.controlIntentBarrier = undefined;
  }
}

function sidecarDurabilityError(
  code: 'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE' | 'CHAT_SIDECAR_CONTROL_INTENT_NOT_DURABLE',
  message: string,
  cause?: unknown,
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string; cause?: unknown };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Wait for a duplicate sidecar's durable publication boundary.
 *
 * Status sidecars never have a cancellation-intent barrier. Once their strict
 * terminal write starts, that terminal barrier is the only valid duplicate
 * boundary. Cancellation sidecars also prefer an in-flight terminal barrier
 * over their older intent fence, so a duplicate cannot observe "cancelling"
 * after the terminal commit has already taken ownership.
 */
export async function waitForChatSidecarCancellationIntent(
  scope: ChatExecutionScope,
  requestId: string,
): Promise<void> {
  const key = executionKey(scope, requestId);
  for (;;) {
    const record = executions.get(key);
    if (!record || record.sidecar !== true || record.requestId !== requestId) {
      throw sidecarDurabilityError(
        'CHAT_SIDECAR_CONTROL_INTENT_NOT_DURABLE',
        'Chat sidecar durable reservation is missing',
      );
    }

    if (record.terminalReceiptPending) {
      const barrier = record.terminalReceiptBarrier;
      if (!barrier) {
        throw sidecarDurabilityError(
          'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE',
          'Chat sidecar terminal receipt barrier is missing',
        );
      }
      try {
        await barrier;
      } catch (cause) {
        throw sidecarDurabilityError(
          'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE',
          'Chat sidecar terminal receipt is not durably committed',
          cause,
        );
      }
      continue;
    }

    if (record.terminal) {
      if (record.terminalReceiptDurable === true) return;
      const barrier = record.terminalReceiptBarrier;
      if (barrier) {
        try {
          await barrier;
        } catch (cause) {
          throw sidecarDurabilityError(
            'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE',
            'Chat sidecar terminal receipt is not durably committed',
            cause,
          );
        }
        continue;
      }
      throw sidecarDurabilityError(
        'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE',
        'Chat sidecar terminal receipt is not durably committed',
      );
    }

    if (record.controlIntentDurable === true) return;
    const controlBarrier = record.controlIntentBarrier;
    if (!controlBarrier) {
      const sidecarBarrier = record.sidecarDurabilityBarrier;
      if (sidecarBarrier) {
        try {
          await sidecarBarrier;
        } catch (cause) {
          const failed = executions.get(key);
          const terminalFailure = Boolean(
            failed?.terminalReceiptPending
            || failed?.terminal
            || failed?.terminalReceiptBarrier,
          );
          throw sidecarDurabilityError(
            terminalFailure
              ? 'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE'
              : 'CHAT_SIDECAR_CONTROL_INTENT_NOT_DURABLE',
            terminalFailure
              ? 'Chat sidecar terminal receipt is not durably committed'
              : 'Chat sidecar cancellation intent is not durably reserved',
            cause,
          );
        }
        continue;
      }
      throw sidecarDurabilityError(
        'CHAT_SIDECAR_CONTROL_INTENT_NOT_DURABLE',
        'Chat sidecar cancellation intent is not durably reserved',
      );
    }
    try {
      await controlBarrier;
    } catch (cause) {
      throw sidecarDurabilityError(
        'CHAT_SIDECAR_CONTROL_INTENT_NOT_DURABLE',
        'Chat sidecar cancellation intent is not durably reserved',
        cause,
      );
    }
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

/**
 * Resolve the durable cancellation receipt for the conversation's current
 * foreground execution.
 *
 * This intentionally does not inspect transcript adjacency. Cancellation can
 * finalize the foreground assistant row after the stop sidecar row, so the
 * visually last message is not a reliable execution relation. The binding is
 * accepted only when both ends have strict durable terminal receipts and the
 * sidecar tombstone names the exact current foreground request.
 */
function terminalMatchesStatusFence(
  target: StoredExecution,
  fence?: DurableChatCancellationStatusFence,
): boolean {
  if (!fence) return true;
  const currentTask = fence.currentTask;
  const relation = fence.relation;
  const requestedTarget = fence.requestedTarget;
  const targetBinding = exactTerminalTaskBinding(
    target.terminalEvent?.payload?.taskBinding || target.terminalEvent?.payload?.taskRelation,
    target.requestId,
  );

  // An accepted/nonterminal task is authoritative even when its process-local
  // queue disappeared during restart. It may only resolve the exact request
  // that owns its durable live pointer; an idle unfinished task cannot safely
  // fall back to older terminal history.
  if (currentTask) {
    const currentTaskId = compactString(currentTask.taskId, 180);
    const currentRequestId = compactString(currentTask.activeRequestId, 180);
    const currentRevision = finiteRevision(currentTask.revision);
    if (!currentTaskId || currentRevision === undefined || !targetBinding) return false;
    if (currentTask.unfinished && !currentRequestId) return false;
    if (currentRequestId && currentRequestId !== target.requestId) return false;
    if (
      targetBinding.taskId !== currentTaskId
      || targetBinding.revision !== currentRevision
    ) return false;
  }

  if (relation) {
    const relationRequestId = compactString(relation.targetRequestId, 180);
    const relationTaskId = compactString(relation.taskId, 180);
    const relationRevision = finiteRevision(relation.revision);
    if (relation.binding === 'active_task' && !relationRequestId) return false;
    if (relationRequestId && relationRequestId !== target.requestId) return false;
    if (relationTaskId || relationRevision !== undefined) {
      if (!targetBinding) return false;
      if (relationTaskId && relationTaskId !== targetBinding.taskId) return false;
      if (relationRevision !== undefined && relationRevision !== targetBinding.revision) return false;
    }
  }
  if (requestedTarget) {
    const requestedRequestId = compactString(requestedTarget.requestId, 180);
    const requestedTaskId = compactString(requestedTarget.taskId, 180);
    const requestedRevision = finiteRevision(requestedTarget.revision);
    if (requestedRequestId && requestedRequestId !== target.requestId) return false;
    if (requestedTaskId || requestedRevision !== undefined) {
      if (!targetBinding) return false;
      if (requestedTaskId && requestedTaskId !== targetBinding.taskId) return false;
      if (requestedRevision !== undefined && requestedRevision !== targetBinding.revision) return false;
    }
  }
  return true;
}

export function getDurableChatCancellationForCurrentExecution(
  scope: ChatExecutionScope,
  fence?: DurableChatCancellationStatusFence,
): DurableChatCancellationBinding | null {
  purgeExpiredExecutions();
  const target = resolveExecution(scope);
  if (
    !target
    || target.sidecar === true
    || target.terminal !== true
    || target.terminalReceiptDurable !== true
    || target.status !== 'cancelled'
    || !target.terminalEvent
  ) return null;
  if (!terminalMatchesStatusFence(target, fence)) return null;

  const controls = [...executions.values()].filter(record => (
    record.scopeKey === target.scopeKey
    && record.sidecar === true
    && record.terminal === true
    && record.terminalReceiptDurable === true
    && record.controlIntentDurable === true
    && record.controlIntentTarget === target.requestId
    && record.terminalEvent?.payload?.controlIntent === 'cancel'
    && compactString(record.terminalEvent?.payload?.targetRequestId, 180) === target.requestId
  ));
  // More than one durable tombstone is an ambiguous control history even when
  // both name the same target. A status query must fail closed rather than
  // silently picking a receipt.
  if (controls.length !== 1) return null;
  const [control] = controls;
  const controlTerminal = copySnapshot(control);
  const targetTerminal = copySnapshot(target);
  if (!controlTerminal || !targetTerminal) return null;
  return {
    controlRequestId: control.requestId,
    targetRequestId: target.requestId,
    controlTerminal,
    targetTerminal,
  };
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
  if (record.terminal || record.terminalReceiptPending) return false;

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

/**
 * Stage one terminal event, durably persist its bounded recovery receipt, and
 * only then make the terminal observable to reconnect/retry readers.
 *
 * The returned boolean is publication ownership: `true` means this caller
 * wrote the receipt and may publish the terminal frame; `false` means an
 * identical request already owns (or durably completed) the terminal. A
 * failed write rejects and quarantines the in-memory execution as a sanitized
 * `persistence_unknown`, so neither a concurrent duplicate nor a reconnect can
 * replay the uncommitted success.
 */
export async function recordChatExecutionTerminalEventDurably(
  scope: ChatExecutionScope,
  requestId: string,
  event: 'agent:response' | 'agent:error',
  payload: Record<string, any>,
  persistenceUnknownPayload: Record<string, any> = {},
): Promise<boolean> {
  const key = executionKey(scope, requestId);
  const record = executions.get(key);
  if (!record) throw new Error('Chat execution is not reserved');

  if (record.terminalReceiptPending) {
    const barrier = record.terminalReceiptBarrier;
    if (!barrier) throw new Error('Chat terminal receipt barrier is missing');
    await barrier;
    return false;
  }
  if (record.terminal) {
    if (record.terminalReceiptDurable === true) return false;
    throw new Error('Chat terminal receipt is not durably committed');
  }

  const normalizedPayload = {
    ...payload,
    source: payload.source || record.source,
    requestId,
    ...(record.sidecar === true
      && record.controlIntentDurable === true
      && record.controlIntentTarget
      ? {
          controlIntent: 'cancel',
          targetRequestId: record.controlIntentTarget,
        }
      : {}),
  };
  const status = terminalStatusForEvent(event, normalizedPayload);
  if (!status) throw new Error('Strict chat terminal receipt requires a terminal event');
  const updatedAt = new Date().toISOString();
  const nextEvent: ChatExecutionEvent = { event, payload: normalizedPayload };
  const pending: NonNullable<StoredExecution['terminalReceiptPending']> = {
    status,
    event: nextEvent,
    updatedAt,
  };
  const candidate: StoredExecution = {
    ...record,
    status,
    updatedAt,
    terminal: true,
    lastEvent: nextEvent,
    terminalEvent: nextEvent,
  };
  const receipt = persistedReceipt(scope, candidate);
  if (!receipt) throw new Error('Chat terminal event cannot produce a durable receipt');

  // Install the private pending marker synchronously, before the first await,
  // so another handler cannot append a late event or observe a success frame.
  record.terminalReceiptPending = pending;
  const barrier = enqueueStrictPersistence(adapter => adapter.upsert(receipt))
    .then(() => {
      if (record.terminalReceiptPending !== pending) {
        throw new Error('Chat terminal receipt ownership changed before commit');
      }
      record.status = pending.status;
      record.updatedAt = pending.updatedAt;
      record.terminal = true;
      record.lastEvent = pending.event;
      record.terminalEvent = pending.event;
      record.terminalReceiptDurable = true;
      record.terminalReceiptPending = undefined;
      record.terminalReceiptBarrier = undefined;
      resolveSidecarDurability(record);
    })
    .catch(error => {
      if (record.terminalReceiptPending === pending) {
        const completionFeedback = normalizeCompletionFeedbackForPersistence(
          persistenceUnknownPayload.completionFeedback,
        );
        const unknownEvent: ChatExecutionEvent = {
          event: 'agent:response',
          payload: {
            text: compactString(persistenceUnknownPayload.text, MAX_TERMINAL_TEXT_CHARS),
            agentName: compactString(persistenceUnknownPayload.agentName, 120) || 'Lumi',
            source: record.source,
            requestId,
            conversationId: compactString(scope.conversationId, 180),
            sidecar: record.sidecar === true,
            finalized: true,
            blocked: true,
            reason: 'persistence_unknown',
            ...(completionFeedback ? { completionFeedback } : {}),
          },
        };
        record.status = 'failed';
        record.updatedAt = new Date().toISOString();
        record.terminal = true;
        record.lastEvent = unknownEvent;
        record.terminalEvent = unknownEvent;
        record.terminalReceiptDurable = false;
        record.terminalReceiptPending = undefined;
      }
      record.terminalReceiptBarrier = undefined;
      rejectSidecarDurability(record, error);
      throw error;
    });
  record.terminalReceiptBarrier = barrier;
  await barrier;
  return true;
}

/**
 * Fail-closed companion for a primary persistence failure. The unknown frame
 * is safe to expose immediately, but this function still attempts to make that
 * quarantine recoverable across a process restart. If the write also fails,
 * the in-memory execution remains terminal `persistence_unknown`.
 */
export async function recordChatExecutionPersistenceUnknownDurably(
  scope: ChatExecutionScope,
  requestId: string,
  payload: Record<string, any> = {},
): Promise<boolean> {
  const record = executions.get(executionKey(scope, requestId));
  if (!record) throw new Error('Chat execution is not reserved');

  if (record.terminalReceiptPending) {
    const pendingBarrier = record.terminalReceiptBarrier;
    if (!pendingBarrier) throw new Error('Chat terminal receipt barrier is missing');
    try {
      await pendingBarrier;
    } catch {
      // The failed success attempt already installed the safe in-memory
      // quarantine. Continue by trying to persist that unknown receipt.
    }
  }
  if (record.terminalReceiptDurable === true) return false;
  if (record.terminalReceiptBarrier) {
    await record.terminalReceiptBarrier;
    return false;
  }

  const now = new Date().toISOString();
  const completionFeedback = normalizeCompletionFeedbackForPersistence(payload.completionFeedback);
  const unknownEvent: ChatExecutionEvent = {
    event: 'agent:response',
    payload: {
      text: compactString(payload.text, MAX_TERMINAL_TEXT_CHARS),
      agentName: compactString(payload.agentName, 120) || 'Lumi',
      source: record.source,
      requestId,
      conversationId: compactString(scope.conversationId, 180),
      sidecar: record.sidecar === true,
      finalized: true,
      blocked: true,
      reason: 'persistence_unknown',
      ...(completionFeedback ? { completionFeedback } : {}),
    },
  };
  // Quarantine synchronously before the durable attempt so a reconnect in the
  // same tick can never observe the prior active state or an uncommitted
  // success.
  record.status = 'failed';
  record.updatedAt = now;
  record.terminal = true;
  record.lastEvent = unknownEvent;
  record.terminalEvent = unknownEvent;
  record.terminalReceiptDurable = false;
  record.terminalReceiptPending = undefined;

  const receipt = persistedReceipt(scope, record);
  if (!receipt) throw new Error('Persistence-unknown terminal cannot produce a durable receipt');
  const barrier = enqueueStrictPersistence(adapter => adapter.upsert(receipt)).then(
    () => {
      record.terminalReceiptDurable = true;
      resolveSidecarDurability(record);
    },
    error => {
      record.terminalReceiptDurable = false;
      rejectSidecarDurability(record, error);
      throw error;
    },
  );
  record.terminalReceiptBarrier = barrier;
  try {
    await barrier;
  } finally {
    if (record.terminalReceiptBarrier === barrier) record.terminalReceiptBarrier = undefined;
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
