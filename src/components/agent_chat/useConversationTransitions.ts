
import { type ConversationHistoryItem, type ConversationHistoryContextMenu } from "./contracts";

import type { ChatAttachmentReference } from "@/lib/chatAttachmentReferences";
import React, { useCallback, useEffect, useMemo } from 'react';

import { ChatViewWorkRegistry } from '@/lib/chatViewWork';

import { toast } from 'sonner';
import { useAppConfirm } from '@/lib/appConfirm';


import { uiMessage } from "../../i18n/uiMessages";


const CONVERSATION_HISTORY_PAGE_SIZE = 40;
const CHAT_HISTORY_LIMIT = 300;
type useConversationTransitionsInput = {
conversationTransitionRef: React.RefObject<symbol>;
isCreatingConversation: boolean;
restoringConversationId: string;
setConversationTransitionPending: React.Dispatch<React.SetStateAction<boolean>>;
setIsCreatingConversation: React.Dispatch<React.SetStateAction<boolean>>;
invalidateChatViewWork: () => void;
chatViewWorkRef: React.RefObject<ChatViewWorkRegistry>;
scopedConversationUrl: (path: string) => string;
activeDomain: "personal" | "work";
detachPreviousExecution: () => void;
bindAttachmentContextToConversation: (conversationId: string, options?: { carryCurrent?: boolean; }) => void;
setConversationHistory: React.Dispatch<React.SetStateAction<ConversationHistoryItem[]>>;
setMessages: (update: React.SetStateAction<any[]>) => void;
setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentReference[]>>;
pendingAttachmentsRef: React.RefObject<ChatAttachmentReference[]>;
setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
setSearchResults: React.Dispatch<React.SetStateAction<any[]>>;
setSearchError: React.Dispatch<React.SetStateAction<string>>;
messageInputRef: React.RefObject<HTMLInputElement>;
agentId: any;
isOpen: boolean;
conversationHistoryLoadingRef: React.RefObject<boolean>;
conversationHistoryHasMoreRef: React.RefObject<boolean>;
conversationHistoryRequestRef: React.RefObject<number>;
conversationHistoryOffsetRef: React.RefObject<number>;
setConversationHistoryLoadingMore: React.Dispatch<React.SetStateAction<boolean>>;
setConversationHistoryLoading: React.Dispatch<React.SetStateAction<boolean>>;
setConversationHistoryHasMore: React.Dispatch<React.SetStateAction<boolean>>;
setConversationHistorySelectorExpanded: React.Dispatch<React.SetStateAction<boolean>>;
activeOrgId: string;
conversationHistoryOpen: boolean;
isOfficeCommandCenter: boolean;
conversationHistory: ConversationHistoryItem[];
conversationHistorySelectorExpanded: boolean;
conversationHistoryHasMore: boolean;
conversationHistoryListRef: React.RefObject<HTMLDivElement>;
setConversationHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
attachmentConversationIdRef: React.RefObject<string>;
setRestoringConversationId: React.Dispatch<React.SetStateAction<string>>;
normalizePersistedMessages: (rawMessages: any[]) => any[];
deletingConversationId: string;
t: any;
isZh: boolean;
setConversationContextMenu: React.Dispatch<React.SetStateAction<ConversationHistoryContextMenu>>;
appConfirm: ReturnType<typeof useAppConfirm>;
setDeletingConversationId: React.Dispatch<React.SetStateAction<string>>;
};
export function useConversationTransitions({ conversationTransitionRef, isCreatingConversation, restoringConversationId, setConversationTransitionPending, setIsCreatingConversation, invalidateChatViewWork, chatViewWorkRef, scopedConversationUrl, activeDomain, detachPreviousExecution, bindAttachmentContextToConversation, setConversationHistory, setMessages, setPendingAttachments, pendingAttachmentsRef, setSearchQuery, setSearchResults, setSearchError, messageInputRef, agentId, isOpen, conversationHistoryLoadingRef, conversationHistoryHasMoreRef, conversationHistoryRequestRef, conversationHistoryOffsetRef, setConversationHistoryLoadingMore, setConversationHistoryLoading, setConversationHistoryHasMore, setConversationHistorySelectorExpanded, activeOrgId, conversationHistoryOpen, isOfficeCommandCenter, conversationHistory, conversationHistorySelectorExpanded, conversationHistoryHasMore, conversationHistoryListRef, setConversationHistoryOpen, attachmentConversationIdRef, setRestoringConversationId, normalizePersistedMessages, deletingConversationId, t, isZh, setConversationContextMenu, appConfirm, setDeletingConversationId }: useConversationTransitionsInput) {

  const activateTranscript = useCallback((conversationId: string, messages: any[]) => {
    detachPreviousExecution();
    bindAttachmentContextToConversation(conversationId);
    setMessages(messages); // The page setter synchronizes its ref and revision.
    setPendingAttachments([]);
    pendingAttachmentsRef.current = [];
    setSearchQuery('');
    setSearchResults([]);
    setSearchError('');
  }, [detachPreviousExecution, bindAttachmentContextToConversation, setMessages, setPendingAttachments, pendingAttachmentsRef, setSearchQuery, setSearchResults, setSearchError]);

  const startNewTextConversation = useCallback(async () => {
    if (conversationTransitionRef.current || isCreatingConversation || restoringConversationId) return;
    const transition = Symbol('new-conversation');
    conversationTransitionRef.current = transition;
    setConversationTransitionPending(true);
    setIsCreatingConversation(true);
    invalidateChatViewWork();
    const work = chatViewWorkRef.current.begin();
    try {
      const response = await fetch(scopedConversationUrl('/api/conversations/new'), {
        signal: work.signal,
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, domain: activeDomain }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.conversation?.id) {
        throw new Error(result?.error || 'Unable to create a new conversation');
      }
      if (!work.isCurrent()) return;

      // Detach the text surface from the previous execution without cancelling
      // its durable task. Any late receipt remains attached to the archived
      // conversation and the task widget continues to report its real status.
      activateTranscript(result.conversation.id, []);
      setConversationHistory(previous => [result.conversation, ...previous.filter(item => item.id !== result.conversation.id)]);
      requestAnimationFrame(() => messageInputRef.current?.focus());
    } catch (error: any) {
      if (work.isCurrent()) toast.error(error?.message || 'Unable to create a new conversation');
    } finally {
      work.finish();
      if (conversationTransitionRef.current === transition) {
        conversationTransitionRef.current = null;
        setConversationTransitionPending(false);
        setIsCreatingConversation(false);
      }
    }
  }, [activeDomain, agentId, activateTranscript, chatViewWorkRef, conversationTransitionRef, invalidateChatViewWork, isCreatingConversation, messageInputRef, restoringConversationId, scopedConversationUrl, setConversationHistory, setConversationTransitionPending, setIsCreatingConversation]);

  useEffect(() => {
    if (!isOpen) return;
    const startNewConversation = () => { void startNewTextConversation(); };
    window.addEventListener('lumi:new-conversation', startNewConversation);
    return () => window.removeEventListener('lumi:new-conversation', startNewConversation);
  }, [isOpen, startNewTextConversation]);

  const loadConversationHistory = useCallback(async ({ append = false }: { append?: boolean } = {}) => {
    if (conversationHistoryLoadingRef.current) return;
    if (append && !conversationHistoryHasMoreRef.current) return;

    const requestId = ++conversationHistoryRequestRef.current;
    const offset = append ? conversationHistoryOffsetRef.current : 0;
    conversationHistoryLoadingRef.current = true;
    if (append) setConversationHistoryLoadingMore(true);
    else setConversationHistoryLoading(true);

    try {
      const response = await fetch(
        scopedConversationUrl(`/api/conversations?limit=${CONVERSATION_HISTORY_PAGE_SIZE}&offset=${offset}`),
        { credentials: 'include' },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Unable to load conversation history');
      if (requestId !== conversationHistoryRequestRef.current) return;

      const page = (Array.isArray(result?.conversations) ? result.conversations : [])
        .filter((item: any) => String(item?.id || '').trim()) as ConversationHistoryItem[];
      setConversationHistory(previous => {
        const merged = new Map<string, ConversationHistoryItem>();
        if (append) {
          previous.forEach(item => merged.set(String(item.id), item));
        }
        page.forEach(item => merged.set(String(item.id), item));
        return [...merged.values()];
      });

      conversationHistoryOffsetRef.current = offset + page.length;
      const hasMore = typeof result?.hasMore === 'boolean'
        ? result.hasMore
        : page.length >= CONVERSATION_HISTORY_PAGE_SIZE;
      conversationHistoryHasMoreRef.current = hasMore;
      setConversationHistoryHasMore(hasMore);
    } catch (error: any) {
      if (requestId === conversationHistoryRequestRef.current && !append) {
        toast.error(error?.message || 'Unable to load conversation history');
      }
    } finally {
      if (requestId === conversationHistoryRequestRef.current) {
        conversationHistoryLoadingRef.current = false;
        setConversationHistoryLoading(false);
        setConversationHistoryLoadingMore(false);
      }
    }
  }, [conversationHistoryHasMoreRef, conversationHistoryLoadingRef, conversationHistoryOffsetRef, conversationHistoryRequestRef, scopedConversationUrl, setConversationHistory, setConversationHistoryHasMore, setConversationHistoryLoading, setConversationHistoryLoadingMore]);

  // Reset the paging cursor when the user switches domain/agent. A stale
  // response from the previous scope is ignored by the request generation.
  useEffect(() => {
    conversationHistoryRequestRef.current += 1;
    conversationHistoryOffsetRef.current = 0;
    conversationHistoryHasMoreRef.current = true;
    conversationHistoryLoadingRef.current = false;
    setConversationHistory([]);
    setConversationHistoryHasMore(true);
    setConversationHistoryLoading(false);
    setConversationHistoryLoadingMore(false);
    setConversationHistorySelectorExpanded(false);
  }, [activeDomain, activeOrgId, agentId, conversationHistoryHasMoreRef, conversationHistoryLoadingRef, conversationHistoryOffsetRef, conversationHistoryRequestRef, setConversationHistory, setConversationHistoryHasMore, setConversationHistoryLoading, setConversationHistoryLoadingMore, setConversationHistorySelectorExpanded]);

  useEffect(() => {
    if (!conversationHistoryOpen) setConversationHistorySelectorExpanded(false);
  }, [conversationHistoryOpen, setConversationHistorySelectorExpanded]);

  // The office rail is visible by default and loads its first page without a
  // popover click. Re-opening a collapsed rail reuses the existing pages.
  useEffect(() => {
    if (!isOpen || !isOfficeCommandCenter || !conversationHistoryOpen) return;
    if (conversationHistory.length > 0 || conversationHistoryLoadingRef.current) return;
    if (!conversationHistoryHasMoreRef.current) return;
    void loadConversationHistory();
  }, [conversationHistory, conversationHistoryHasMoreRef, conversationHistoryLoadingRef, conversationHistoryOpen, isOfficeCommandCenter, isOpen, loadConversationHistory]);

  // If the first page does not fill the rail, keep asking for pages until the
  // list has a scrollable viewport (or the server reports that it is done).
  // This makes "无极" history useful even for users whose first page is short,
  // without requiring a manual drag on an invisible scrollbar.
  useEffect(() => {
    if (!isOpen || !isOfficeCommandCenter || !conversationHistoryOpen || !conversationHistorySelectorExpanded || !conversationHistoryHasMore) return;
    const list = conversationHistoryListRef.current;
    if (!list || list.scrollHeight > list.clientHeight + 8) return;
    const frame = requestAnimationFrame(() => {
      const current = conversationHistoryListRef.current;
      if (!current || current.scrollHeight > current.clientHeight + 8) return;
      void loadConversationHistory({ append: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationHistory, conversationHistoryHasMore, conversationHistoryListRef, conversationHistoryOpen, conversationHistorySelectorExpanded, isOfficeCommandCenter, isOpen, loadConversationHistory]);

  const toggleConversationHistory = useCallback(() => {
    setConversationHistoryOpen(current => !current);
  }, [setConversationHistoryOpen]);

  const handleConversationHistoryScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!conversationHistorySelectorExpanded) return;
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight > 96) return;
    void loadConversationHistory({ append: true });
  }, [conversationHistorySelectorExpanded, loadConversationHistory]);

  const handleConversationHistorySelectorBlur = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget && event.currentTarget.contains(nextTarget as Node)) return;
    setConversationHistorySelectorExpanded(false);
  }, [setConversationHistorySelectorExpanded]);

  // Keep the active transcript at the front of the collapsed deck. The full
  // list still preserves the server's recency order after the selector opens.
  const orderedConversationHistory = useMemo(() => {
    const activeId = conversationHistory.find(item => item.status === 'active')?.id || attachmentConversationIdRef.current;
    if (!activeId) return conversationHistory;
    return [...conversationHistory].sort((left, right) => {
      if (left.id === activeId) return -1;
      if (right.id === activeId) return 1;
      return 0;
    });
  }, [attachmentConversationIdRef, conversationHistory]);

  const restoreTextConversation = useCallback(async (conversationId: string) => {
    if (!conversationId || conversationTransitionRef.current || restoringConversationId || isCreatingConversation) return;
    if (conversationId === attachmentConversationIdRef.current) {
      return;
    }
    const transition = Symbol('restore-conversation');
    conversationTransitionRef.current = transition;
    setConversationTransitionPending(true);
    setRestoringConversationId(conversationId);
    invalidateChatViewWork();
    const work = chatViewWorkRef.current.begin();
    try {
      const activateResponse = await fetch(scopedConversationUrl(`/api/conversations/${encodeURIComponent(conversationId)}/activate`), {
        signal: work.signal,
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, domain: activeDomain }),
      });
      const activateResult = await activateResponse.json().catch(() => ({}));
      if (!activateResponse.ok || !activateResult?.conversation?.id) {
        throw new Error(activateResult?.error || 'Unable to open this conversation');
      }
      if (!work.isCurrent()) return;
      const messageResponse = await fetch(
        scopedConversationUrl(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${CHAT_HISTORY_LIMIT}`),
        { credentials: 'include', signal: work.signal },
      );
      const messageResult = await messageResponse.json().catch(() => ({}));
      if (!messageResponse.ok) throw new Error(messageResult?.error || 'Unable to load this conversation');
      if (!work.isCurrent()) return;

      // Switching transcripts only detaches this chat surface. Durable tasks
      // keep running and remain visible exclusively in the task widget.
      activateTranscript(conversationId, normalizePersistedMessages(Array.isArray(messageResult?.messages) ? messageResult.messages : []));
      setConversationHistory(previous => previous.map(item => ({
        ...item,
        status: item.id === conversationId ? 'active' : item.status === 'active' ? 'closed' : item.status,
      })));
      setConversationHistorySelectorExpanded(false);
      requestAnimationFrame(() => messageInputRef.current?.focus());
    } catch (error: any) {
      if (work.isCurrent()) toast.error(error?.message || 'Unable to open this conversation');
    } finally {
      work.finish();
      if (conversationTransitionRef.current === transition) {
        conversationTransitionRef.current = null;
        setConversationTransitionPending(false);
        setRestoringConversationId('');
      }
    }
  }, [conversationTransitionRef, restoringConversationId, isCreatingConversation, attachmentConversationIdRef, setConversationTransitionPending, setRestoringConversationId, invalidateChatViewWork, chatViewWorkRef, scopedConversationUrl, agentId, activeDomain, activateTranscript, normalizePersistedMessages, setConversationHistory, setConversationHistorySelectorExpanded, messageInputRef]);

  const deleteConversationFromHistory = useCallback(async (conversationId: string) => {
    const id = String(conversationId || '').trim();
    if (!id || deletingConversationId || restoringConversationId) return;

    const conversation = conversationHistory.find(item => String(item.id) === id);
    const title = conversation?.displayTitle || conversation?.title || conversation?.preview || t.untitled || 'Untitled';
    const deleteLabel = t.delete || uiMessage('org-settings.delete.5b875326d1', isZh ? 'zh' : 'en');
    setConversationContextMenu(null);
    const confirmed = await appConfirm({
      title: deleteLabel,
      message: `${deleteLabel}: ${title}?`,
      confirmText: deleteLabel,
      cancelText: t.cancel || 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) {
      return;
    }

    setDeletingConversationId(id);
    try {
      const response = await fetch(scopedConversationUrl(`/api/conversations/${encodeURIComponent(id)}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Unable to delete conversation');

      const isCurrentConversation = id === attachmentConversationIdRef.current;
      setConversationHistory(previous => previous.filter(item => String(item.id) !== id));
      // One row disappeared before the next offset is requested; move the
      // cursor back so an item is not skipped at the page boundary.
      conversationHistoryOffsetRef.current = Math.max(0, conversationHistoryOffsetRef.current - 1);

      if (isCurrentConversation) {
        // Keep the chat surface usable after deleting its active transcript.
        await startNewTextConversation();
      } else {
        toast.success(t.deleted || uiMessage('reminder-panel.deleted.e8250ae78f', isZh ? 'zh' : 'en'));
      }
    } catch (error: any) {
      toast.error(error?.message || t.deleteFailed || uiMessage('org-settings.delete-failed-value0.98201beb15', isZh ? 'zh' : 'en'));
    } finally {
      setDeletingConversationId('');
    }
  }, [appConfirm, attachmentConversationIdRef, conversationHistory, conversationHistoryOffsetRef, deletingConversationId, isZh, restoringConversationId, scopedConversationUrl, setConversationContextMenu, setConversationHistory, setDeletingConversationId, startNewTextConversation, t.cancel, t.delete, t.deleteFailed, t.deleted, t.untitled]);
return { handleConversationHistorySelectorBlur, startNewTextConversation, handleConversationHistoryScroll, orderedConversationHistory, restoreTextConversation, toggleConversationHistory, deleteConversationFromHistory };
}
