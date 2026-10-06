import { reserveConversationExecution } from '../cognition/conversation_execution';
import { resolveConversationForEntry, type AnchoredConversationEntry, type EntryConversationScope } from './entry_conversation';
import { captureConversationAuthorization } from './lifecycle';

/** A durable task anchor never creates or switches the user's active transcript. */
export function reserveAnchoredEntryExecution(input: {
  userId: string; scope: EntryConversationScope; entry: AnchoredConversationEntry;
  conversationId?: string; requestId: string; signal: AbortSignal; abort(reason: unknown): void;
}) {
  const conversation = resolveConversationForEntry(input.userId, input.scope, input.entry, input.conversationId);
  if (!conversation) {
    if (input.conversationId) throw Object.assign(new Error('The bound conversation is unavailable or unauthorized in this execution scope'), { code: 'CONVERSATION_ENTRY_UNAVAILABLE' });
    return null;
  }
  const authorization = captureConversationAuthorization({
    userId: input.userId, domain: input.scope.domain === 'work' ? 'work' : 'personal',
    orgId: input.scope.orgId, agentId: conversation.agentId,
  }, () => conversation.id);
  authorization.assertCurrent();
  const admission = reserveConversationExecution({
    userId: input.userId, domain: input.scope.domain === 'work' ? 'work' : 'personal',
    orgId: input.scope.orgId, conversationId: conversation.id, source: input.entry.kind,
  }, input.requestId, input.signal);
  const cancel = () => input.abort(admission.controller.signal.reason);
  admission.controller.signal.addEventListener('abort', cancel, { once: true });
  if (admission.controller.signal.aborted) cancel();
  const stopWatch = authorization.watch(admission.controller);
  return {
    conversation,
    isCurrent: authorization.isCurrent,
    assertCurrent: authorization.assertCurrent,
    async waitForTurn() { await admission.waitForTurn(); authorization.assertCurrent(); },
    release() {
      stopWatch();
      admission.controller.signal.removeEventListener('abort', cancel);
      admission.release();
    },
  };
}
