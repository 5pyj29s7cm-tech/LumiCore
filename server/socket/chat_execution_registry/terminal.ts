import { cloneDatabaseValue } from '../../db/snapshot_changes';
import { type ChatExecutionScope, type ChatExecutionEvent, type ChatExecutionSnapshot, type StoredExecution } from './contracts';
import { resolveSidecarDurability, rejectSidecarDurability, executionState } from './state';
import { executionKey, conversationReceiptAllowed, ownsChatExecution } from './identity';
import { persistedReceipt, terminalStatusForEvent, statusForEvent, unknownTerminalEvent } from './payload';
import { enqueueStrictPersistence } from './persistence';
import { copySnapshot, resolveExecution } from './snapshots';

export function recordChatExecutionEvent(
  scope: ChatExecutionScope,
  requestId: string,
  event: string,
  payload: Record<string, any>,
): boolean {
  if (!conversationReceiptAllowed(scope)) return false;
  const key = executionKey(scope, requestId);
  const record = executionState.executions.get(key);
  if (!record) return false;

  // Once a terminal event has been committed, late errors from an aborted async
  // branch must not overwrite or duplicate the user-visible result.
  if (record.terminal || record.terminalReceiptPending) return false;

  const normalizedPayload = {
    ...cloneDatabaseValue(payload),
    source: payload.source || record.source,
    requestId,
  };
  const status = statusForEvent(record.status, event, normalizedPayload);
  // Terminal publication belongs exclusively to the strict durable entry point.
  if (['completed', 'cancelled', 'failed'].includes(status)) return false;
  const nextEvent = { event, payload: normalizedPayload };
  record.status = status;
  record.updatedAt = new Date().toISOString();
  record.lastEvent = nextEvent;
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
  options: {
    /** A caller-owned authority may change while either durable barrier waits.
     * Return only a safer replacement terminal; null keeps the current one.
     */
    refreshTerminal?: () => Promise<{ event: 'agent:response' | 'agent:error'; payload: Record<string, any> } | null>;
  } = {},
): Promise<boolean> {
  scope = { ...scope };
  if (!conversationReceiptAllowed(scope)) return false;
  const key = executionKey(scope, requestId);
  const record = executionState.executions.get(key);
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
    ...cloneDatabaseValue(payload),
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
  let receipt = persistedReceipt(scope, candidate);
  if (!receipt) throw new Error('Chat terminal event cannot produce a durable receipt');

  // Install the private pending marker synchronously, before the first await,
  // so another handler cannot append a late event or observe a success frame.
  let ownsPublication = true;
  record.terminalReceiptPending = pending;
  const barrier = enqueueStrictPersistence(async adapter => {
    let replacements = 0;
    const refresh = async () => {
      const replacement = await options.refreshTerminal?.();
      if (!replacement) return false;
      // One-way revocation only. Repeatedly changing a terminal is an owner
      // error and must follow the existing unknown/quarantine failure path.
      if (++replacements > 1) throw new Error('Chat terminal authority did not converge');
      const safePayload = { ...cloneDatabaseValue(replacement.payload), source: replacement.payload.source || record.source, requestId };
      const safeStatus = terminalStatusForEvent(replacement.event, safePayload);
      if (!safeStatus || safeStatus === 'completed') throw new Error('Chat terminal authority cannot refresh to success');
      pending.status = safeStatus;
      pending.event = { event: replacement.event, payload: safePayload };
      pending.updatedAt = new Date().toISOString();
      receipt = persistedReceipt(scope, { ...candidate, status: safeStatus, updatedAt: pending.updatedAt,
        lastEvent: pending.event, terminalEvent: pending.event });
      if (!receipt) throw new Error('Chat refreshed terminal cannot produce a durable receipt');
      return true;
    };
    await refresh();
    if (ownsChatExecution(scope, requestId, record)) await adapter.upsert(receipt!);
    if (await refresh()) {
      if (ownsChatExecution(scope, requestId, record)) await adapter.upsert(receipt!);
      await refresh();
    }
  })
    .then(() => {
      if (!ownsChatExecution(scope, requestId, record)) {
        ownsPublication = false;
        record.terminalReceiptPending = undefined;
        record.terminalReceiptBarrier = undefined;
        resolveSidecarDurability(record);
        return;
      }
      if (record.terminalReceiptPending !== pending) {
        throw new Error('Chat terminal receipt ownership changed before commit');
      }
      installTerminal(record, pending.status, pending.event, pending.updatedAt, true);
      record.terminalReceiptBarrier = undefined;
      resolveSidecarDurability(record);
    })
    .catch(error => {
      if (!ownsChatExecution(scope, requestId, record)) {
        ownsPublication = false;
        record.terminalReceiptPending = undefined;
        record.terminalReceiptBarrier = undefined;
        resolveSidecarDurability(record);
        return;
      }
      if (record.terminalReceiptPending === pending) {
        installTerminal(record, 'failed',
          unknownTerminalEvent(scope, record, requestId, persistenceUnknownPayload),
          new Date().toISOString(), false);
      }
      record.terminalReceiptBarrier = undefined;
      rejectSidecarDurability(record, error);
      throw error;
    });
  record.terminalReceiptBarrier = barrier;
  await barrier;
  return ownsPublication && ownsChatExecution(scope, requestId, record);
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
  scope = { ...scope };
  if (!conversationReceiptAllowed(scope)) return false;
  const record = executionState.executions.get(executionKey(scope, requestId));
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
  if (!ownsChatExecution(scope, requestId, record) || record.terminalReceiptDurable === true) return false;
  if (record.terminalReceiptBarrier) {
    await record.terminalReceiptBarrier;
    return false;
  }

  const now = new Date().toISOString();
  const unknownEvent = unknownTerminalEvent(scope, record, requestId, cloneDatabaseValue(payload));
  // Quarantine synchronously before the durable attempt so a reconnect in the
  // same tick can never observe the prior active state or an uncommitted
  // success.
  installTerminal(record, 'failed', unknownEvent, now, false);

  const receipt = persistedReceipt(scope, record);
  if (!receipt) throw new Error('Persistence-unknown terminal cannot produce a durable receipt');
  const barrier = enqueueStrictPersistence(async adapter => {
    if (ownsChatExecution(scope, requestId, record)) await adapter.upsert(receipt);
  }).then(
    () => {
      if (!ownsChatExecution(scope, requestId, record)) return;
      record.terminalReceiptDurable = true;
      resolveSidecarDurability(record);
    },
    error => {
      if (!ownsChatExecution(scope, requestId, record)) return;
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
  return ownsChatExecution(scope, requestId, record) && Boolean(record.terminalReceiptDurable);
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

function installTerminal(
  record: StoredExecution, status: 'completed' | 'cancelled' | 'failed',
  event: ChatExecutionEvent, updatedAt: string, durable: boolean,
): void {
  Object.assign(record, { status, updatedAt, terminal: true, lastEvent: event, terminalEvent: event,
    terminalReceiptDurable: durable, terminalReceiptPending: undefined });
}
