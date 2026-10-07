import { conversationExists } from '../../conversation/lifecycle';
import { type ChatExecutionScope, type StoredExecution, type PersistedChatExecutionReceipt } from './contracts';
import { executionState } from './state';

export function normalizedScopeKey(scope: ChatExecutionScope): string {
  return JSON.stringify([...scopeIdentity(scope), String(scope.conversationId || '')]);
}

export function normalizedRecoveryScopeKey(scope: ChatExecutionScope): string {
  return JSON.stringify(scopeIdentity(scope));
}

export function executionKey(scope: ChatExecutionScope, requestId: string): string {
  return JSON.stringify([normalizedScopeKey(scope), requestId]);
}

export function conversationReceiptAllowed(scope: ChatExecutionScope): boolean {
  return !scope.requireConversation || conversationExists(String(scope.conversationId || ''), scope);
}

export function receiptIdentity(receipt: PersistedChatExecutionReceipt): string {
  return JSON.stringify([receipt.userId, receipt.domain, receipt.orgId,
    receipt.source, receipt.conversationId, receipt.requestId]);
}

function scopeIdentity(scope: ChatExecutionScope) {
  return [scope.userId, scope.domain, scope.domain === 'work' ? String(scope.orgId || '') : '', scope.source || 'chat'];
}

export function ownsChatExecution(scope: ChatExecutionScope, requestId: string, record: StoredExecution): boolean {
  return conversationReceiptAllowed(scope) && executionState.executions.get(executionKey(scope, requestId)) === record;
}
