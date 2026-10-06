import { useEffect } from "react";
import { buildChatConversationScopeKey } from "@/lib/chatConversationScope";
import { shouldApplyInitialConversationMessages } from "@/lib/conversationSync";
import type { useChatHistoryAndRequests } from './use_chat_history_and_requests';
import { CHAT_HISTORY_LIMIT } from './shared';

export function useChatScopeInitialization(previousBindings: ReturnType<typeof useChatHistoryAndRequests>) {
  const { agentId, user, activeDomain, activeOrgId, lastConversationScopeRef, invalidateChatViewWork, setIsCreatingConversation, setRestoringConversationId, initialLoadDoneRef, detachPreviousExecution, attachmentContextStoragePrefix, setMessages, setPendingAttachments, pendingAttachmentsRef, bindAttachmentContextToConversation, isFounder, attachmentConversationIdRef, messagesRef, conversationTransitionRef, setConversationTransitionPending, scopedConversationUrl, chatRequestLedgerRef, normalizePersistedMessages } = previousBindings;


  useEffect(() => {
    if (!agentId) return;

    // On user/agent/domain switch, reset and reload
    const conversationScopeKey = `${user?.uid || user?.id || user?.username || 'anonymous'}:${buildChatConversationScopeKey(agentId, activeDomain, activeOrgId)}`;
    if (conversationScopeKey !== lastConversationScopeRef.current) {
      invalidateChatViewWork();
      setIsCreatingConversation(false);
      setRestoringConversationId('');
      lastConversationScopeRef.current = conversationScopeKey;
      initialLoadDoneRef.current = false;
      detachPreviousExecution(false, true);
      try {
        // Remove the pre-fix scope-only key, which could contain plaintext and
        // could incorrectly survive into a different conversation.
        localStorage.removeItem(attachmentContextStoragePrefix);
      } catch {}
      setMessages([]);
      setPendingAttachments([]);
      pendingAttachmentsRef.current = [];
      bindAttachmentContextToConversation('');
    }

    // Only load once; do not overwrite live conversation.
    if (isFounder || initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;

    const initialConversationId = attachmentConversationIdRef.current;
    const initialMessageCount = messagesRef.current.length;
    const transition = Symbol('initial-conversation');
    conversationTransitionRef.current = transition;
    setConversationTransitionPending(true);
    let cancelled = false;

    // Load the single active conversation messages. The request may resolve
    // after the user has already started a live turn or switched transcripts;
    // in that case the persisted snapshot must not replace the visible chat.
    void (async () => {
      try {
        const activeResponse = await fetch(scopedConversationUrl('/api/conversations/active'));
        const data = await activeResponse.json();
        const conversationId = String(data.activeConversation?.id || '').trim();
        if (!conversationId) return;
        if (
          cancelled
          || lastConversationScopeRef.current !== conversationScopeKey
          || chatRequestLedgerRef.current.size > 0
          || attachmentConversationIdRef.current !== initialConversationId
          || messagesRef.current.length !== initialMessageCount
        ) return;

        bindAttachmentContextToConversation(conversationId);
        const msgRes = await fetch(scopedConversationUrl(`/api/conversations/${conversationId}/messages?limit=${CHAT_HISTORY_LIMIT}`));
        const msgData = await msgRes.json();
        if (!Array.isArray(msgData.messages)) return;
        if (!shouldApplyInitialConversationMessages({
          cancelled,
          expectedScopeKey: conversationScopeKey,
          currentScopeKey: lastConversationScopeRef.current,
          loadedConversationId: conversationId,
          currentConversationId: attachmentConversationIdRef.current,
          activeRequestId: chatRequestLedgerRef.current.foreground,
          textChatActive: chatRequestLedgerRef.current.size > 0,
          messageCountAtStart: initialMessageCount,
          currentMessageCount: messagesRef.current.length,
        })) return;
        const persistedMessages = normalizePersistedMessages(msgData.messages);
        setMessages(persistedMessages);
      } catch {} finally {
        if (conversationTransitionRef.current === transition) {
          conversationTransitionRef.current = null;
          setConversationTransitionPending(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (conversationTransitionRef.current === transition) {
        conversationTransitionRef.current = null;
        setConversationTransitionPending(false);
      }
    };
  }, [attachmentConversationIdRef, activeDomain, activeOrgId, agentId, attachmentContextStoragePrefix, bindAttachmentContextToConversation, invalidateChatViewWork, isFounder, normalizePersistedMessages, detachPreviousExecution, scopedConversationUrl, setMessages, user?.uid, user?.id, user?.username, lastConversationScopeRef, initialLoadDoneRef, messagesRef, conversationTransitionRef, setConversationTransitionPending, setIsCreatingConversation, setRestoringConversationId, setPendingAttachments, pendingAttachmentsRef, chatRequestLedgerRef]);
  return {
    ...previousBindings
  } as const;
}
