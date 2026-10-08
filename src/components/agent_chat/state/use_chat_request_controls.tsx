import { chatRecoveryCopy } from '@/i18n/locales/chatRecovery';
import { ChatExecutionWatch } from "@/lib/chatExecutionWatch";
import { useConversationTransitions } from "../useConversationTransitions";
import type { ChatAttachment, ChatSendOptions } from "../contracts";
import { makeChatMessageId, buildChatHistoryPayload } from "../history";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { needsVisibleToolEvidence } from "@/lib/chatProgress";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import { MAX_CHAT_ATTACHMENTS, serializeChatAttachment, mergeChatAttachmentReferences } from "@/lib/chatAttachmentReferences";
import { ownedPendingChatExecutions } from "@/lib/chatExecutionRecovery";
import { type PersistedPendingChatExecution } from "@/lib/chatEventReceipts";
import type { useChatSocketEvents } from './use_chat_socket_events';
import { ACTIVE_CHAT_EXECUTION_TTL_MS } from './shared';

export function useChatRequestControls(previousBindings: ReturnType<typeof useChatSocketEvents>) {
  const { isFounder, socket, activeExecutionStorageKey, chatViewWorkRef, agentId, activeDomain, activeOrgId, recoveryOwner, clearPersistedExecution, isOfficeCommandCenter, chatRequestLedgerRef, chatTurnTimerGuardRef, setIsTyping, lastResumedRequestIdsRef, pushChatProgress, isZh, attachmentConversationIdRef, scopedConversationUrl, bindAttachmentContextToConversation, chatExecutionSource, activeMediaGenerationRef, settleTrackedChatRequest, setWorkflowStatus, mediaStudioOpenRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaGenerationArtifacts, setMediaGeneration, mediaGenerationText, setMediaStudioMode, setMediaSources, conversationTransitionRef, isCreatingConversation, restoringConversationId, setConversationTransitionPending, setIsCreatingConversation, invalidateChatViewWork, detachPreviousExecution, setConversationHistory, setMessages, setPendingAttachments, pendingAttachmentsRef, setSearchQuery, setSearchResults, setSearchError, messageInputRef, isOpen, conversationHistoryLoadingRef, conversationHistoryHasMoreRef, conversationHistoryRequestRef, conversationHistoryOffsetRef, setConversationHistoryLoadingMore, setConversationHistoryLoading, setConversationHistoryHasMore, setConversationHistorySelectorExpanded, conversationHistoryOpen, conversationHistory, conversationHistorySelectorExpanded, conversationHistoryHasMore, conversationHistoryListRef, setConversationHistoryOpen, setRestoringConversationId, normalizePersistedMessages, deletingConversationId, t, setConversationContextMenu, appConfirm, setDeletingConversationId, scrollRef, chatProgressLines, messages, clearChatProgress, seenWorkflowToolEvents, rememberConversationAttachments, clearStoredAttachments, pendingAttachments, chatUploadsRef, attachmentUploadText, conversationAttachmentsRef, user, messagesRef, chatTurnUiMetaRef, currentTurnUiMetaRef, setDraftText, taskRelationLedgerRef, persistActiveExecution, dropRequestStream, chatExecutionWatchesRef, agentCategory, operationMode } = previousBindings;


  const attachChatExecutionWatch = useCallback((execution: Pick<PersistedPendingChatExecution, 'requestId' | 'source' | 'domain' | 'orgId' | 'conversationId' | 'mediaGeneration'>, firstProbeMs = 120000) => {
    const existing = chatExecutionWatchesRef.current.get(execution.requestId);
    if (existing) return existing;
    const requestId = execution.requestId;
    const copy = chatRecoveryCopy(isZh);
    const watcher = new ChatExecutionWatch({
      requestId, source: execution.source, firstProbeMs,
      probe: reply => {
        if (!socket.connected) { reply(); return; }
        socket.emit('agent:execution_resume', {
          requestId, source: execution.source, domain: execution.domain, orgId: execution.orgId || null,
          conversationId: execution.conversationId || undefined,
        }, reply);
      },
      onSnapshot: snapshot => {
        if (!chatRequestLedgerRef.current.has(requestId)) return;
        if (snapshot.conversationId) {
          execution.conversationId = snapshot.conversationId;
          if (!attachmentConversationIdRef.current) bindAttachmentContextToConversation(snapshot.conversationId, { carryCurrent: true });
          persistActiveExecution(requestId);
        }
        if (isOfficeCommandCenter && execution.mediaGeneration && activeMediaGenerationRef.current?.requestId !== requestId) {
          const request = execution.mediaGeneration;
          activeMediaGenerationRef.current = { requestId, mode: request.mode, request };
          mediaStudioOpenRef.current = true;
          mediaGenerationArtifactsRef.current = [];
          mediaGenerationArtifactValidationRef.current = null;
          setMediaGenerationArtifacts([]);
          setMediaGeneration({ status: 'generating', detail: mediaGenerationText.statusGenerating });
          setMediaStudioMode(request.mode);
          setMediaSources({
            primaryImage: request.primaryImage || '', primaryArtifactId: request.primaryArtifactId || '',
            referenceImages: request.referenceImages || [], referenceArtifactIds: request.referenceArtifactIds || [],
            referenceImage: request.referenceImage || '', referenceArtifactId: request.referenceArtifactId || '',
          });
        }
        if (snapshot.terminal || requestId !== chatRequestLedgerRef.current.foreground) return;
        if (snapshot.status === 'waiting_confirmation') setWorkflowStatus('waiting_confirmation');
        else if (snapshot.status === 'cancelling') setWorkflowStatus('cancelling');
        else if (snapshot.status === 'executing') setWorkflowStatus('executing');
        else setWorkflowStatus('thinking');
        setIsTyping(true);
      },
      onEvent: (event, error) => {
        if (!chatRequestLedgerRef.current.has(requestId)) return;
        const terminal = event === 'rejected' || event === 'no_ack' || event === 'lost';
        const foreground = chatRequestLedgerRef.current.foreground === requestId;
        const detail = event === 'rejected' ? (error || copy.rejected)
          : terminal ? copy.missing
          : event === 'ack_timeout' ? copy.waiting
          : event === 'probe_timeout' ? copy.recovering : copy.accepted;
        if (foreground) {
          clearChatProgress();
          pushChatProgress(detail, terminal ? 'error' : 'thinking');
          if (event === 'acknowledged') setWorkflowStatus(chatTurnUiMetaRef.current.get(requestId)?.hadTool ? 'executing' : 'thinking');
        }
        if (activeMediaGenerationRef.current?.requestId === requestId && terminal) {
          setMediaGeneration({ status: 'error', detail: event === 'rejected' ? mediaGenerationText.backendRejected : mediaGenerationText.backendLostTask });
          activeMediaGenerationRef.current = null;
        }
        if (terminal) {
          dropRequestStream(requestId);
          const tracked = settleTrackedChatRequest(requestId);
          setIsTyping(tracked.remaining > 0);
          if (tracked.remaining === 0) setWorkflowStatus('error');
        }
      },
    });
    chatExecutionWatchesRef.current.set(requestId, watcher);
    return watcher;
  }, [activeMediaGenerationRef, attachmentConversationIdRef, bindAttachmentContextToConversation, chatExecutionWatchesRef, chatRequestLedgerRef, chatTurnUiMetaRef, clearChatProgress, dropRequestStream, isOfficeCommandCenter, isZh, mediaGenerationArtifactValidationRef, mediaGenerationArtifactsRef, mediaGenerationText.backendLostTask, mediaGenerationText.backendRejected, mediaGenerationText.statusGenerating, mediaStudioOpenRef, persistActiveExecution, pushChatProgress, setIsTyping, setMediaGeneration, setMediaGenerationArtifacts, setMediaSources, setMediaStudioMode, setWorkflowStatus, settleTrackedChatRequest, socket]);

  useEffect(() => {
    if (isFounder || !socket) return;
    const resumeActiveExecution = async () => {
      if (!activeExecutionStorageKey) return;
      let pending: PersistedPendingChatExecution[] = [];
      try {
        localStorage.removeItem(`lumi_active_chat_execution:${agentId}:${activeDomain}:${activeOrgId || ''}`);
        pending = ownedPendingChatExecutions(JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null'), recoveryOwner);
      } catch { localStorage.removeItem(activeExecutionStorageKey); }
      pending = pending.filter(execution => {
        const startedAt = Date.parse(execution.startedAt);
        const valid = Number.isFinite(startedAt) && Date.now() - startedAt <= ACTIVE_CHAT_EXECUTION_TTL_MS;
        if (!valid) clearPersistedExecution(execution.requestId);
        return valid;
      });
      if (pending.length === 0) return;
      for (const execution of pending) {
        if (!chatRequestLedgerRef.current.has(execution.requestId)) chatRequestLedgerRef.current.begin(execution.requestId);
      }
      chatTurnTimerGuardRef.current.begin(chatRequestLedgerRef.current.foreground);
      setIsTyping(true);
      if (pending.some(execution => !lastResumedRequestIdsRef.current.has(execution.requestId))) {
        pending.forEach(execution => lastResumedRequestIdsRef.current.add(execution.requestId));
        clearChatProgress();
        pushChatProgress(chatRecoveryCopy(isZh).recovering, 'thinking');
      }
      for (const execution of pending) attachChatExecutionWatch(execution).resume();
    };
    socket.on('connect', resumeActiveExecution);
    if (socket.connected) void resumeActiveExecution();
    return () => { socket.off('connect', resumeActiveExecution); };
  }, [activeDomain, activeExecutionStorageKey, activeOrgId, agentId, attachChatExecutionWatch, chatRequestLedgerRef, chatTurnTimerGuardRef, clearChatProgress, clearPersistedExecution, isFounder, isZh, lastResumedRequestIdsRef, pushChatProgress, recoveryOwner, setIsTyping, socket]);
  const { handleConversationHistorySelectorBlur, startNewTextConversation, handleConversationHistoryScroll, orderedConversationHistory, restoreTextConversation, toggleConversationHistory, deleteConversationFromHistory } = useConversationTransitions({
    conversationTransitionRef, isCreatingConversation, restoringConversationId, setConversationTransitionPending,
    setIsCreatingConversation, invalidateChatViewWork, chatViewWorkRef, scopedConversationUrl, activeDomain,
    detachPreviousExecution, bindAttachmentContextToConversation, setConversationHistory, setMessages,
    setPendingAttachments, pendingAttachmentsRef, setSearchQuery, setSearchResults, setSearchError, messageInputRef,
    agentId, isOpen, conversationHistoryLoadingRef, conversationHistoryHasMoreRef, conversationHistoryRequestRef,
    conversationHistoryOffsetRef, setConversationHistoryLoadingMore, setConversationHistoryLoading,
    setConversationHistoryHasMore, setConversationHistorySelectorExpanded, activeOrgId, conversationHistoryOpen,
    isOfficeCommandCenter, conversationHistory, conversationHistorySelectorExpanded, conversationHistoryHasMore,
    conversationHistoryListRef, setConversationHistoryOpen, attachmentConversationIdRef, setRestoringConversationId,
    normalizePersistedMessages, deletingConversationId, t, isZh, setConversationContextMenu, appConfirm,
    setDeletingConversationId
  });

  useEffect(() => {
    // Scroll to bottom when messages change (new messages, initial load)
    if (scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [chatProgressLines.length, messages, scrollRef]);

  // Scroll to bottom on mount when messages first load
  useEffect(() => {
    if (messages.length > 0 && scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [isOpen, messages.length, scrollRef]);

  useEffect(() => {
    if (isOpen) return;
    setWorkflowStatus('idle');
    clearChatProgress();
    seenWorkflowToolEvents.current.clear();
  }, [clearChatProgress, isOpen, seenWorkflowToolEvents, setWorkflowStatus]);

  const rememberAttachmentContext = useCallback((attachments: ChatAttachment[]) => {
    const reusable = attachments
      .filter(item => item.path || item.transcript || item.content || item.preview)
      .map(serializeChatAttachment);
    if (reusable.length === 0) return;
    rememberConversationAttachments(reusable);
  }, [rememberConversationAttachments]);

  const clearConversationAttachmentContext = useCallback(() => {
    clearStoredAttachments();
    toast.success(uiMessage('agent-chat-page.session-materials-cleared.53bea199b2'));
  }, [clearStoredAttachments]);

  const sendText = useCallback(async (
    text: string,
    attachments: ChatAttachment[] = pendingAttachments,
    options: ChatSendOptions = {},
  ) => {
    // All entry points (form, Enter, shell command, suggested text) use this
    // synchronous barrier, including the interval before React re-renders.
    if (conversationTransitionRef.current) return;
    if (chatUploadsRef.current.busy || chatUploadsRef.current.canRetry) {
      toast.info(chatUploadsRef.current.busy ? attachmentUploadText.processing : attachmentUploadText.failed);
      return;
    }
    const trimmedText = text.trim();
    const directAttachments = attachments.map(serializeChatAttachment);
    const reusableConversationAttachments = options.includeConversationAttachments === false
      ? []
      : conversationAttachmentsRef.current.map(serializeChatAttachment);
    const attachmentMerge = mergeChatAttachmentReferences(
      reusableConversationAttachments,
      directAttachments,
    );
    const outgoingAttachments = attachmentMerge.attachments;
    const reusedConversationAttachmentContext =
      options.includeConversationAttachments !== false
      && conversationAttachmentsRef.current.length > 0
      && directAttachments.length === 0;
    if (attachmentMerge.overflowCount > 0) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
    }
    if ((!trimmedText && outgoingAttachments.length === 0) || !user) return;
    const outgoingText = trimmedText || uiMessage('agent-chat-page.please-review-these-attachments.6b61a7fa38');

    const userMsg = {
      id: makeChatMessageId('user'),
      text: outgoingText,
      attachments: directAttachments,
      userName: user.displayName || user.username || (t.chatUserFallback || 'User'),
      timestamp: new Date().toISOString(),
      type: 'user'
    };
    const priorMessages = messagesRef.current.length > 0 ? messagesRef.current : messages;
    const requestId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    options.onRequestCreated?.(requestId);
    const wasIdle = chatRequestLedgerRef.current.size === 0;
    chatTurnUiMetaRef.current.set(requestId, {
      hadTool: false,
      needsEvidence: needsVisibleToolEvidence(outgoingText, outgoingAttachments.length > 0),
      finalization: null,
    });
    if (wasIdle) {
      currentTurnUiMetaRef.current = chatTurnUiMetaRef.current.get(requestId)!;
      clearChatProgress();
      pushChatProgress(
        reusedConversationAttachmentContext
          ? uiMessage('agent-chat-page.using-session-materials.66f4979b61', (isZh) ? 'zh' : 'en')
          : outgoingAttachments.length > 0
          ? (uiMessage('agent-chat-page.i-am-checking-your-attachments.79cfe8a290', (isZh) ? 'zh' : 'en'))
          : (uiMessage('agent-chat-page.i-am-checking-your-request.05a5e81231', (isZh) ? 'zh' : 'en')),
        'thinking'
      );
      setWorkflowStatus('thinking');
    }

    setMessages(prev => {
      const base = prev.length >= priorMessages.length ? prev : priorMessages;
      return [...base, userMsg];
    });
    setDraftText('');
    setPendingAttachments(prev => {
      const next = prev.filter(item => !outgoingAttachments.some(sent => sent.id === item.id));
      pendingAttachmentsRef.current = next;
      return next;
    });
    if (outgoingAttachments.length > 0) rememberAttachmentContext(outgoingAttachments);
    setIsTyping(true);
    const { controlTargetRequestId } = chatRequestLedgerRef.current.begin(requestId);
    const taskControlTarget = taskRelationLedgerRef.current.controlTarget({
      conversationId: attachmentConversationIdRef.current,
      foregroundRequestId: controlTargetRequestId,
    });
    if (wasIdle) chatTurnTimerGuardRef.current.begin(requestId);
    persistActiveExecution(requestId);

    const watcher = attachChatExecutionWatch({
      requestId, source: chatExecutionSource, domain: activeDomain, orgId: activeOrgId,
      conversationId: attachmentConversationIdRef.current || undefined,
      ...(activeMediaGenerationRef.current?.requestId === requestId ? { mediaGeneration: activeMediaGenerationRef.current.request } : {}),
    }, outgoingAttachments.length > 0 ? 180000 : 120000);

    const chatPayload = {
      text: outgoingText,
      attachments: outgoingAttachments,
      history: buildChatHistoryPayload(priorMessages),
      personalityId: 'lumi',
      category: agentCategory,
      agentId,
      domain: activeDomain,
      orgId: activeOrgId || null,
      source: chatExecutionSource,
      operationMode,
      ...(options.mediaRequest ? { mediaRequest: options.mediaRequest } : {}),
      requestId,
      controlTargetRequestId: taskControlTarget.controlTargetRequestId || undefined,
      controlTargetTaskId: taskControlTarget.controlTargetTaskId,
      controlTargetRevision: taskControlTarget.controlTargetRevision,
      conversationId: attachmentConversationIdRef.current || undefined,
    };

    socket.emit("agent:chat", chatPayload, (ack?: { ok?: boolean; error?: string }) => watcher.acknowledge(ack));

    // No frontend AI fallback here. If the realtime backend is down, show the
    // connection problem instead of generating a second, inconsistent answer.
    return requestId;
  }, [pendingAttachments, conversationTransitionRef, chatUploadsRef, conversationAttachmentsRef, user, t.chatUserFallback, messagesRef, messages, chatRequestLedgerRef, chatTurnUiMetaRef, setMessages, setDraftText, setPendingAttachments, rememberAttachmentContext, setIsTyping, taskRelationLedgerRef, attachmentConversationIdRef, chatTurnTimerGuardRef, persistActiveExecution, attachChatExecutionWatch, chatExecutionSource, agentCategory, agentId, activeDomain, activeOrgId, operationMode, socket, attachmentUploadText.processing, attachmentUploadText.failed, currentTurnUiMetaRef, clearChatProgress, pushChatProgress, isZh, setWorkflowStatus, pendingAttachmentsRef, activeMediaGenerationRef]);
  return {
    ...previousBindings, sendText, handleConversationHistorySelectorBlur, startNewTextConversation, handleConversationHistoryScroll,
    orderedConversationHistory, restoreTextConversation, toggleConversationHistory, clearConversationAttachmentContext, deleteConversationFromHistory
  } as const;
}
