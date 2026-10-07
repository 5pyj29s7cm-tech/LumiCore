import { type ChatExecutionScope, type ChatExecutionSnapshot, type StoredExecution } from './contracts';
import { createSidecarDurabilityBoundary, executionState } from './state';
import { normalizedScopeKey, normalizedRecoveryScopeKey, executionKey, conversationReceiptAllowed } from './identity';
import { purgeExpiredExecutions } from './persistence';
import { copySnapshot } from './snapshots';
import { recordChatExecutionTerminalEventDurably, recordChatExecutionPersistenceUnknownDurably } from './terminal';

export function beginChatExecution(
  scope: ChatExecutionScope,
  requestId: string,
): ChatExecutionSnapshot | null {
  scope = { ...scope };
  if (!conversationReceiptAllowed(scope)) throw new Error('Chat execution conversation is no longer available');
  purgeExpiredExecutions();
  const scopeKey = normalizedScopeKey(scope);
  const previousKey = executionState.activeByScope.get(scopeKey);
  const previous = previousKey ? executionState.executions.get(previousKey) : undefined;
  if (previous && !previous.terminal && previous.requestId !== requestId) {
    throw new Error('Active chat execution must be durably superseded before replacement');
  }

  const now = new Date().toISOString();
  const key = executionKey(scope, requestId);
  const reserved = executionState.executions.get(key);
  if (reserved && !reserved.terminal && reserved.queued === true) {
    reserved.queued = false;
    reserved.status = 'acknowledged';
    reserved.updatedAt = now;
    executionState.activeByScope.set(scopeKey, key);
    return null;
  }
  executionState.executions.set(key, createReservation(scope, requestId, {}, now));
  executionState.activeByScope.set(scopeKey, key);
  return null;
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
  scope = { ...scope };
  purgeExpiredExecutions();
  const scopeKey = normalizedScopeKey(scope);
  const previousKey = executionState.activeByScope.get(scopeKey);
  const previous = previousKey ? executionState.executions.get(previousKey) : undefined;
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

  if (!conversationReceiptAllowed(scope)
    || (previous && executionState.executions.get(previousKey!) !== previous)
    || (previous && executionState.activeByScope.get(scopeKey) !== previousKey)) {
    throw new Error('Chat execution replacement authority changed before reservation');
  }
  beginChatExecution(scope, requestId);
  return superseded;
}

/** Reserve a FIFO request before it becomes the active foreground execution. */
export function beginQueuedChatExecution(
  scope: ChatExecutionScope,
  requestId: string,
): boolean {
  scope = { ...scope };
  if (!conversationReceiptAllowed(scope)) return false;
  purgeExpiredExecutions();
  const key = executionKey(scope, requestId);
  if (executionState.executions.has(key)) return false;
  executionState.executions.set(key, createReservation(scope, requestId, { queued: true }));
  return true;
}

/**
 * Reserve an idempotency receipt for a status/cancellation side conversation.
 *
 * A sidecar is addressable by its exact request id and persists its terminal
 * result, but deliberately never participates in `executionState.activeByScope`. This keeps a
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
  scope = { ...scope };
  if (!conversationReceiptAllowed(scope)) return false;
  purgeExpiredExecutions();
  const key = executionKey(scope, requestId);
  if (executionState.executions.has(key)) return false;

  const durabilityBoundary = createSidecarDurabilityBoundary();
  executionState.executions.set(key, createReservation(scope, requestId, { sidecar: true, ...durabilityBoundary }));
  return true;
}

function createReservation(
  scope: ChatExecutionScope, requestId: string, extra: Partial<StoredExecution> = {},
  now = new Date().toISOString(),
): StoredExecution {
  return {
    scopeKey: normalizedScopeKey(scope), recoveryScopeKey: normalizedRecoveryScopeKey(scope),
    ...(scope.conversationId ? { conversationId: String(scope.conversationId) } : {}),
    inProcess: true, requestId, source: scope.source || 'chat',
    status: 'acknowledged', createdAt: now, updatedAt: now, terminal: false, ...extra,
  };
}
