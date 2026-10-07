import { type ChatExecutionScope, type DurableChatCancellationBinding, type DurableChatCancellationStatusFence, type StoredExecution, type PersistedChatExecutionReceipt, CONTROL_INTENT_RETENTION_MS } from './contracts';
import { resolveSidecarDurability, rejectSidecarDurability, executionState } from './state';
import { executionKey, ownsChatExecution } from './identity';
import { compactString, finiteRevision, exactTerminalTaskBinding } from './payload';
import { enqueueStrictPersistence, purgeExpiredExecutions } from './persistence';
import { copySnapshot, resolveExecution } from './snapshots';

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
  scope = { ...scope };
  const record = executionState.executions.get(executionKey(scope, requestId));
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
  const assertOwnership = () => {
    if (!ownsChatExecution(scope, requestId, record)) {
      throw new Error('Chat sidecar cancellation authority changed before durable commit');
    }
  };
  const barrier = enqueueStrictPersistence(async adapter => {
    assertOwnership();
    await adapter.upsert(receipt);
  }).then(() => {
    assertOwnership();
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
    const record = executionState.executions.get(key);
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
          const failed = executionState.executions.get(key);
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
  const record = executionState.executions.get(executionKey(scope, requestId));
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

  const controls = [...executionState.executions.values()].filter(record => (
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
