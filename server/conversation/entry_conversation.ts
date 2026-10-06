import type { Conversation, ConversationTurnResult } from './manager/contracts';
import { getMessageByRequestId } from './manager/request_identity';
import { getConversationForScope, getOrCreateActiveConversation, getOrCreateConversationForTurn, startIsolatedConversation } from './conversation_lifecycle';

export interface EntryConversationScope { domain?: string; orgId?: string; }
export type AdmittedConversationEntry = { kind: 'chat' | 'voice'; phase: 'admit'; agentId: string; userText?: string };
export type AnchoredConversationEntry = { kind: 'rest' | 'autonomy'; agentId?: string };
export type SelectedConversationEntry =
  | AnchoredConversationEntry
  | { kind: 'chat'; phase: 'select'; agentId: string; requestId: string; source: string }
  | { kind: 'voice'; phase: 'select'; agentId: string }
  | { kind: 'messaging'; agentId: string; requestId: string }
  | { kind: 'mcp'; agentId: string; resumeConversationId?: string };
export type ConversationEntryDescriptor = AdmittedConversationEntry | SelectedConversationEntry;

export function resolveConversationForEntry(userId: string, scope: EntryConversationScope, entry: AdmittedConversationEntry, clientConversationId?: string): ConversationTurnResult;
export function resolveConversationForEntry(userId: string, scope: EntryConversationScope, entry: SelectedConversationEntry, clientConversationId?: string): Conversation | null;
/** Accepted requests stay bound to their transcript; a client id never grants ownership. */
export function resolveConversationForEntry(
  userId: string, scope: EntryConversationScope, entry: ConversationEntryDescriptor, clientConversationId?: string,
): Conversation | ConversationTurnResult | null {
  const requestedId = String(clientConversationId || '').trim();
  if ((entry.kind === 'rest' || entry.kind === 'autonomy') && !requestedId) return null;
  if ('phase' in entry && entry.phase === 'admit') {
    return getOrCreateConversationForTurn(userId, entry.agentId, scope.domain, scope.orgId, {
      userText: entry.userText, conversationId: requestedId,
    });
  }
  const owned = (id: string) => {
    const conversation = getConversationForScope(id, userId, scope.domain, scope.orgId);
    return conversation && (entry.agentId === undefined || conversation.agentId === entry.agentId) ? conversation : null;
  };
  if (entry.kind === 'chat' || entry.kind === 'messaging') {
    const accepted = getMessageByRequestId({
      userId, agentId: entry.agentId, requestId: entry.requestId, role: 'user',
      ...(entry.kind === 'chat' ? { source: entry.source, channel: 'chat' } : {
        domain: scope.domain || 'personal', orgId: scope.orgId || '',
      }),
    });
    // A deleted or revoked accepted binding must not silently become a new turn.
    if (accepted) return accepted.conversationId ? owned(accepted.conversationId) : null;
  }
  if (requestedId) return owned(requestedId);
  if (entry.kind === 'rest' || entry.kind === 'autonomy') return null;
  if (entry.kind === 'mcp') {
    if (clientConversationId) return null;
    const prior = entry.resumeConversationId ? owned(entry.resumeConversationId) : null;
    return prior || startIsolatedConversation(userId, entry.agentId, scope.domain, scope.orgId);
  }
  return getOrCreateActiveConversation(userId, entry.agentId, scope.domain, scope.orgId);
}
