import { cloneDatabaseValue } from '../../db/snapshot_changes';
import { type ChatExecutionScope, type ChatExecutionSnapshot, type StoredExecution } from './contracts';
import { executionState } from './state';
import { normalizedScopeKey, normalizedRecoveryScopeKey, executionKey } from './identity';
import { purgeExpiredExecutions } from './persistence';

export function copySnapshot(record?: StoredExecution): ChatExecutionSnapshot | null {
  if (!record) return null;
  const {
    inProcess: _inProcess,
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
  return cloneDatabaseValue(snapshot);
}

export function getChatExecution(
  scope: ChatExecutionScope,
  requestId?: string,
): ChatExecutionSnapshot | null {
  purgeExpiredExecutions();
  return copySnapshot(resolveExecution(scope, requestId));
}

export function resolveExecution(scope: ChatExecutionScope, requestId?: string): StoredExecution | undefined {
  if (requestId) {
    const exact = executionState.executions.get(executionKey(scope, requestId));
    if (exact) return exact;

    if (scope.conversationId) return undefined;
    // A native client can persist the request before the server assigns the
    // first conversation id. Reconnect probes must still recover that exact
    // request without weakening user/domain/source isolation. Request ids are
    // generated per turn, so only accept a unique match in the recovery scope.
    const recoveryScopeKey = normalizedRecoveryScopeKey(scope);
    const matches = [...executionState.executions.values()].filter(record => (
      record.requestId === requestId
      && record.recoveryScopeKey === recoveryScopeKey
    ));
    return matches.length === 1 ? matches[0] : undefined;
  }
  const key = executionState.activeByScope.get(normalizedScopeKey(scope));
  return key ? executionState.executions.get(key) : undefined;
}
