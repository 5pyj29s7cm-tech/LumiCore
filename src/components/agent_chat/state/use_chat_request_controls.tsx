import { ChatExecutionWatch } from "@/lib/chatExecutionWatch";
import { useConversationTransitions } from "../useConversationTransitions";
import type { ChatAttachment, ChatExecutionSnapshot, ChatSendOptions } from "../contracts";
import { makeChatMessageId, buildChatHistoryPayload } from "../history";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { needsVisibleToolEvidence } from "@/lib/chatProgress";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import { MAX_CHAT_ATTACHMENTS, serializeChatAttachment, mergeChatAttachmentReferences } from "@/lib/chatAttachmentReferences";
import { ownedPendingChatExecutions } from "@/lib/chatExecutionRecovery";
import { upsertPersistedPendingChatExecution, type PersistedPendingChatExecution } from "@/lib/chatEventReceipts";
import type { useChatSocketEvents } from './use_chat_socket_events';
import { ACTIVE_CHAT_EXECUTION_TTL_MS } from './shared';

export function useChatRequestControls(previousBindings: ReturnType<typeof useChatSocketEvents>) {
  const { isFounder, socket, activeExecutionStorageKey, chatViewWorkRef, agentId, activeDomain, activeOrgId, recoveryOwner, clearPersistedExecution, isOfficeCommandCenter, chatRequestLedgerRef, chatTurnTimerGuardRef, setIsTyping, lastResumedRequestIdsRef, pushChatProgress, isZh, attachmentConversationIdRef, scopedConversationUrl, bindAttachmentContextToConversation, chatExecutionSource, activeMediaGenerationRef, resetMediaGenerationSurface, settleTrackedChatRequest, setWorkflowStatus, mediaStudioOpenRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaGenerationArtifacts, setMediaGeneration, mediaGenerationText, setMediaStudioMode, setMediaSources, conversationTransitionRef, isCreatingConversation, restoringConversationId, setConversationTransitionPending, setIsCreatingConversation, invalidateChatViewWork, detachPreviousExecution, setConversationHistory, setMessages, setPendingAttachments, pendingAttachmentsRef, setSearchQuery, setSearchResults, setSearchError, messageInputRef, isOpen, conversationHistoryLoadingRef, conversationHistoryHasMoreRef, conversationHistoryRequestRef, conversationHistoryOffsetRef, setConversationHistoryLoadingMore, setConversationHistoryLoading, setConversationHistoryHasMore, setConversationHistorySelectorExpanded, conversationHistoryOpen, conversationHistory, conversationHistorySelectorExpanded, conversationHistoryHasMore, conversationHistoryListRef, setConversationHistoryOpen, setRestoringConversationId, normalizePersistedMessages, deletingConversationId, t, setConversationContextMenu, appConfirm, setDeletingConversationId, scrollRef, chatProgressLines, messages, clearChatProgress, seenWorkflowToolEvents, rememberConversationAttachments, clearStoredAttachments, pendingAttachments, chatUploadsRef, attachmentUploadText, conversationAttachmentsRef, user, messagesRef, chatTurnUiMetaRef, currentTurnUiMetaRef, setDraftText, taskRelationLedgerRef, persistActiveExecution, dropRequestStream, activeChatViewDetachersRef, agentCategory, operationMode } = previousBindings;


  useEffect(() => {
    if (isFounder || !socket) return;

    let disposed = false;
    let recoveryAttempt = 0;
    const resumeActiveExecution = async () => {
      if (!activeExecutionStorageKey) return;
      const attempt = ++recoveryAttempt;
      let ownsView = chatViewWorkRef.current.capture();
      const isCurrentRecovery = () => !disposed && attempt === recoveryAttempt && ownsView();
      let pending: PersistedPendingChatExecution[] = [];
      try {
        // Legacy keys have no verifiable user owner; only the v3 key is read.
        localStorage.removeItem(`lumi_active_chat_execution:${agentId}:${activeDomain}:${activeOrgId || ''}`);
        pending = ownedPendingChatExecutions(
          JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null'),
          recoveryOwner,
        );
      } catch {
        localStorage.removeItem(activeExecutionStorageKey);
      }
      pending = pending.filter((execution) => {
        const startedAt = Date.parse(execution.startedAt);
        const valid = Number.isFinite(startedAt)
          && Date.now() - startedAt <= ACTIVE_CHAT_EXECUTION_TTL_MS;
        if (!valid) clearPersistedExecution(execution.requestId);
        return valid;
      });
      if (pending.length === 0) return;

      const mediaExecution = isOfficeCommandCenter
        ? [...pending].reverse().find(execution => execution.mediaGeneration)
        : undefined;
      for (const execution of pending) {
        if (!chatRequestLedgerRef.current.has(execution.requestId)) {
          chatRequestLedgerRef.current.begin(execution.requestId);
        }
      }
      chatTurnTimerGuardRef.current.begin(chatRequestLedgerRef.current.foreground);
      setIsTyping(true);
      if (pending.some(execution => !lastResumedRequestIdsRef.current.has(execution.requestId))) {
        pending.forEach(execution => lastResumedRequestIdsRef.current.add(execution.requestId));
        pushChatProgress(uiMessage('agent-chat-page.restoring-task-state.0fb759a4dc', isZh ? 'zh' : 'en'), 'thinking');
      }

      let fallbackConversationId = String(attachmentConversationIdRef.current || '').trim();
      if (!fallbackConversationId && pending.some(execution => !execution.conversationId)) {
        try {
          const activeResponse = await fetch(scopedConversationUrl('/api/conversations/active'), { credentials: 'include' });
          const activeData = await activeResponse.json();
          if (!isCurrentRecovery()) return;
          fallbackConversationId = String(activeData.activeConversation?.id || '').trim();
          if (fallbackConversationId && !attachmentConversationIdRef.current) {
            bindAttachmentContextToConversation(fallbackConversationId, { carryCurrent: true });
            // This recovery itself adopted the server's conversation; later
            // user navigation must still invalidate its acknowledgement.
            ownsView = chatViewWorkRef.current.capture();
            const stored = JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null');
            let updated = { version: 2 as const, pending: ownedPendingChatExecutions(stored, recoveryOwner) };
            for (const execution of pending) {
              if (!execution.conversationId) updated = upsertPersistedPendingChatExecution(updated, { ...execution, conversationId: fallbackConversationId });
            }
            localStorage.setItem(activeExecutionStorageKey, JSON.stringify(updated));
          }
        } catch {}
      }

      if (!isCurrentRecovery()) return;
      for (const execution of pending) {
        const recoveryConversationId = String(
          execution.conversationId || fallbackConversationId || '',
        ).trim();
        socket.emit('agent:execution_resume', {
          requestId: execution.requestId,
          source: execution.source || chatExecutionSource,
          domain: execution.domain,
          orgId: execution.orgId || null,
          conversationId: recoveryConversationId || undefined,
        }, (result?: { ok?: boolean; snapshot?: ChatExecutionSnapshot; error?: string }) => {
          if (!isCurrentRecovery() || !chatRequestLedgerRef.current.has(execution.requestId)) return;
          const snapshot = result?.snapshot;
          if (!result?.ok || !snapshot || snapshot.requestId !== execution.requestId || snapshot.source !== execution.source) {
            if (activeMediaGenerationRef.current?.requestId === execution.requestId) resetMediaGenerationSurface();
            const tracked = settleTrackedChatRequest(execution.requestId);
            setIsTyping(tracked.remaining > 0);
            if (tracked.remaining === 0) {
              setWorkflowStatus('error');
              pushChatProgress(
                result?.error || uiMessage('agent-chat-page.previous-task-not-recoverable.17e6ad375c', isZh ? 'zh' : 'en'),
                'error',
              );
            }
            return;
          }
          // Restore local references only after this user's exact execution
          // has been found by the authenticated backend.
          if (mediaExecution?.requestId === execution.requestId && mediaExecution.mediaGeneration) {
            const request = mediaExecution.mediaGeneration;
            activeMediaGenerationRef.current = { requestId: execution.requestId, mode: request.mode, request };
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
          if (snapshot.terminal || execution.requestId !== chatRequestLedgerRef.current.foreground) return;
          if (snapshot.status === 'waiting_confirmation') setWorkflowStatus('waiting_confirmation');
          else if (snapshot.status === 'cancelling') setWorkflowStatus('cancelling');
          else if (snapshot.status === 'executing') setWorkflowStatus('executing');
          else setWorkflowStatus('thinking');
          setIsTyping(chatRequestLedgerRef.current.size > 0);
        });
      }
    };

    socket.on('connect', resumeActiveExecution);
    if (socket.connected) resumeActiveExecution();
    return () => { disposed = true; socket.off('connect', resumeActiveExecution); };
  }, [attachmentConversationIdRef, activeDomain, activeExecutionStorageKey, activeOrgId, agentId, bindAttachmentContextToConversation, chatExecutionSource, clearPersistedExecution, isFounder, isOfficeCommandCenter, isZh, mediaGenerationText.statusGenerating, pushChatProgress, recoveryOwner, resetMediaGenerationSurface, scopedConversationUrl, settleTrackedChatRequest, socket, chatViewWorkRef, chatTurnTimerGuardRef, chatRequestLedgerRef, setIsTyping, lastResumedRequestIdsRef, setWorkflowStatus, activeMediaGenerationRef, mediaStudioOpenRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaGenerationArtifacts, setMediaGeneration, setMediaStudioMode, setMediaSources]);
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

    const watcher = new ChatExecutionWatch({
      requestId, source: chatExecutionSource, firstProbeMs: outgoingAttachments.length > 0 ? 180000 : 120000,
      probe: reply => socket.emit('agent:execution_resume', {
        requestId, source: chatExecutionSource, domain: activeDomain, orgId: activeOrgId || null,
        conversationId: attachmentConversationIdRef.current || undefined,
      }, reply),
      onEvent: (event, error) => {
        const terminal = event === 'rejected' || event === 'no_ack' || event === 'lost';
        const foreground = chatRequestLedgerRef.current.foreground === requestId;
        const detail = error || ({
          rejected: uiMessage('agent-chat-page.the-backend-did-not-accept.44d78fa21a', isZh ? 'zh' : 'en'),
          no_ack: uiMessage('agent-chat-page.the-backend-has-not-acknowledged.4a6f380020', isZh ? 'zh' : 'en'),
          ack_timeout: uiMessage('agent-chat-page.the-backend-has-not-acknowledged.4a6f380020', isZh ? 'zh' : 'en'),
          lost: uiMessage('agent-chat-page.backend-lost-task.8bbc4d5800', isZh ? 'zh' : 'en'),
          acknowledged: uiMessage('agent-chat-page.the-backend-has-received-this.859b50e7ed', isZh ? 'zh' : 'en'),
          working: uiMessage('agent-chat-page.the-backend-has-accepted-this.aa53249e15', isZh ? 'zh' : 'en'),
          probe_timeout: socket.connected
            ? uiMessage('agent-chat-page.rechecking-task-state.7d8729d39f', isZh ? 'zh' : 'en')
            : uiMessage('agent-chat-page.connection-lost-task-will-resume.52cd95319f', isZh ? 'zh' : 'en'),
        }[event]);
        if (foreground) {
          if (terminal || event === 'ack_timeout') setWorkflowStatus('error');
          pushChatProgress(detail, terminal || event === 'ack_timeout' ? 'error' : 'thinking');
        }
        if (activeMediaGenerationRef.current?.requestId === requestId) {
          if (event === 'acknowledged') setMediaGeneration({ status: 'submitting', detail: '' });
          else if (terminal || event === 'ack_timeout') {
            setMediaGeneration({ status: 'error', detail: error || (event === 'lost' ? mediaGenerationText.backendLostTask
              : event === 'rejected' ? mediaGenerationText.backendRejected : mediaGenerationText.backendNoAck) });
            if (terminal) activeMediaGenerationRef.current = null;
          }
        }
        if (terminal) {
          dropRequestStream(requestId);
          const tracked = settleTrackedChatRequest(requestId);
          setIsTyping(tracked.remaining > 0);
        }
      },
    });
    activeChatViewDetachersRef.current.set(requestId, () => watcher.dispose());

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
  }, [pendingAttachments, conversationTransitionRef, chatUploadsRef, conversationAttachmentsRef, user, t.chatUserFallback, messagesRef, messages, chatRequestLedgerRef, chatTurnUiMetaRef, setMessages, setDraftText, setPendingAttachments, rememberAttachmentContext, setIsTyping, taskRelationLedgerRef, attachmentConversationIdRef, chatTurnTimerGuardRef, persistActiveExecution, chatExecutionSource, activeChatViewDetachersRef, agentCategory, agentId, activeDomain, activeOrgId, operationMode, socket, attachmentUploadText.processing, attachmentUploadText.failed, currentTurnUiMetaRef, clearChatProgress, pushChatProgress, isZh, setWorkflowStatus, pendingAttachmentsRef, activeMediaGenerationRef, setMediaGeneration, mediaGenerationText.backendLostTask, mediaGenerationText.backendRejected, mediaGenerationText.backendNoAck, dropRequestStream, settleTrackedChatRequest]);
  return {
    ...previousBindings, sendText, handleConversationHistorySelectorBlur, startNewTextConversation, handleConversationHistoryScroll,
    orderedConversationHistory, restoreTextConversation, toggleConversationHistory, clearConversationAttachmentContext, deleteConversationFromHistory
  } as const;
}
