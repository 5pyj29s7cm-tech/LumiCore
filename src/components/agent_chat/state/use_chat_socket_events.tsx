import { CREATION_EXECUTION_SOURCE } from '../../../../shared/creation_workspace';
import { createChatStreamReceivers } from "../chat_stream_receivers";
import { makeChatMessageId } from "../history";
import { useEffect } from "react";
import type { ChatArtifact } from "../../../../shared/chat_artifacts";
import { projectAgentActivity } from "@/lib/agentStatusTruth";
import { toast } from "sonner";
import { describeTurnCompletionProgress, type ChatResponseFinalization } from "@/lib/chatProgress";
import { normalizeTaskCompletionFeedback } from "../../workflowTypes";
import { uiMessage } from "../../../i18n/uiMessages";
import { describeAgentResponseDelivery, isFinalizedSuccessfulResponse, isTerminalAgentStatus, sanitizeAgentResponseTextForDisplay, shouldDisplayAgentResponse } from "@/lib/agentResponseDelivery";
import { shouldReloadPersistedConversation } from "@/lib/conversationSync";
import { finalizeStreamedChatMessage, takeChatStreamBucket } from "@/lib/chatEventReceipts";
import type { ServerTaskRelationEvent } from "@/lib/chatTaskRelations";
import { extractMediaGenerationArtifacts, mediaGenerationReceiptSettingsMatch, type MediaGenerationArtifact } from "@/lib/mediaGenerationArtifacts";
import type { useChatScopeInitialization } from './use_chat_scope_initialization';
import { CHAT_HISTORY_LIMIT } from './shared';

export function useChatSocketEvents(previousBindings: ReturnType<typeof useChatScopeInitialization>) {
  const { isCreationWorkspace, isFounder, socket, acceptChatExecutionEvent, taskRelationLedgerRef, isZh, setMessages, agentName, streamingRawTextRef, streamingMsgIdsRef, activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaGenerationArtifacts, setMediaGeneration, mediaGenerationText, seenWorkflowToolEvents, chatTurnUiMetaRef, chatRequestLedgerRef, currentTurnUiMetaRef, setWorkflowStatus, pushChatProgress, terminalReceiptsRef, settleTrackedChatRequest, setIsTyping, finishChatProgress, scheduleWorkflowReset, clearChatProgress, dropRequestStream, t, agentNameRef, attachmentConversationIdRef, chatExecutionSource, bindAttachmentContextToConversation, agentId, chatViewWorkRef, messagesRevisionRef, historyRefreshRevisionRef, scopedConversationUrl, normalizePersistedMessages, activeDomain, activeOrgId, clearPersistedExecution } = previousBindings;


  useEffect(() => {
    if (isFounder || !socket) return;
    const { isCurrentChatEvent, recordTaskRelation, onProactive, onChunk, receiveMediaArtifacts, onTool, onProgress } = createChatStreamReceivers({
    acceptChatExecutionEvent, taskRelationLedgerRef, isZh, setMessages, agentName, streamingRawTextRef,
    streamingMsgIdsRef, activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef,
    setMediaGenerationArtifacts, setMediaGeneration, mediaGenerationText, seenWorkflowToolEvents, chatTurnUiMetaRef,
    chatRequestLedgerRef, currentTurnUiMetaRef, setWorkflowStatus, pushChatProgress
  });


    const onResponse = (data: {
      text: string;
      agentName: string;
      source?: string;
      requestId?: string;
      conversationId?: string;
      finalized?: boolean;
      blocked?: boolean;
      reason?: string;
      sidecar?: boolean;
      taskRelation?: unknown;
      completionFeedback?: unknown;
      artifactReceipt?: unknown;
      fileArtifacts?: ChatArtifact[];
    }) => {
      if (!isCurrentChatEvent(data)) return;
      recordTaskRelation(data);
      if (!terminalReceiptsRef.current.claim(data)) return;
      const requestId = String(data.requestId || '').trim();
      const turnMeta = chatTurnUiMetaRef.current.get(requestId);
      const streamId = takeChatStreamBucket(streamingMsgIdsRef.current, streamingRawTextRef.current, requestId);
      const tracked = settleTrackedChatRequest(requestId);
      const hasRemainingRequests = tracked.remaining > 0;
      const completionFeedback = normalizeTaskCompletionFeedback(data.completionFeedback);
      const responseTerminalReason = String(data.reason || '').trim().toLowerCase();
      const responseWasCancelled = responseTerminalReason === 'cancelled' || responseTerminalReason === 'canceled';
      const responseReceipt = data.artifactReceipt && typeof data.artifactReceipt === 'object'
        ? data.artifactReceipt as Record<string, any>
        : null;
      const responseOperation: MediaGenerationArtifact['operation'] = responseReceipt?.toolName === 'ai_edit_image'
        ? 'image_edit'
        : responseReceipt?.toolName === 'generate_video'
          ? (responseReceipt?.settings?.hasReference ? 'image_to_video' : 'text_to_video')
          : responseReceipt?.toolName === 'generate_image'
            ? 'text_to_image'
            : undefined;
      const responseMediaArtifacts = extractMediaGenerationArtifacts(data.artifactReceipt).map(artifact => ({
        ...artifact,
        requestId,
        ...(responseOperation ? { operation: responseOperation } : {}),
      }));
      const responseFileArtifacts = Array.isArray(data.fileArtifacts) ? data.fileArtifacts : [];
      setIsTyping(hasRemainingRequests);

      const mediaReceiptDisplayable = (responseMediaArtifacts.length > 0 || responseFileArtifacts.length > 0) && isFinalizedSuccessfulResponse(data);
      const displayable = shouldDisplayAgentResponse(data) || mediaReceiptDisplayable;
      const deliveredText = sanitizeAgentResponseTextForDisplay(
        data.text?.trim() || (mediaReceiptDisplayable ? mediaGenerationText.mediaCompleted : ''),
        isZh ? 'zh' : 'en',
      );
      if (streamId) {
        if (displayable && deliveredText) {
          // Capture the id before deleting its request bucket. React may run
          // this updater after the handler returns.
          setMessages(prev => finalizeStreamedChatMessage(prev, streamId, deliveredText).map(message => (
            message.id === streamId
              ? {
                  ...message,
                  ...(completionFeedback ? { completionFeedback } : {}),
                  ...(responseMediaArtifacts.length ? { mediaArtifacts: responseMediaArtifacts } : {}),
                  fileArtifacts: responseFileArtifacts,
                  conversationId: data.conversationId,
                }
              : message
          )));
        } else if (!displayable) {
          setMessages(prev => prev.filter(message => message.id !== streamId));
        }
      } else if (displayable && deliveredText) {
        setMessages(prev => [...prev, {
          id: makeChatMessageId('agent'),
          text: deliveredText,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent',
          ...(completionFeedback ? { completionFeedback } : {}),
          ...(responseMediaArtifacts.length ? { mediaArtifacts: responseMediaArtifacts } : {}),
          fileArtifacts: responseFileArtifacts,
          conversationId: data.conversationId,
        }]);
      }

      const activeMediaGeneration = activeMediaGenerationRef.current;
      if (activeMediaGeneration?.requestId === requestId) {
        // Only an agent:tool result can complete the studio. Model-authored
        // response text may describe an artifact, but is not execution proof.
        let hasArtifact = mediaGenerationArtifactsRef.current.some(
          artifact => artifact.kind === activeMediaGeneration.mode,
        );
        let replayReceiptRejected = false;
        if (data.artifactReceipt !== undefined && !mediaGenerationReceiptSettingsMatch(activeMediaGeneration.request, data.artifactReceipt)) {
          replayReceiptRejected = true;
          setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
        } else if (!hasArtifact && data.artifactReceipt !== undefined) {
          hasArtifact = receiveMediaArtifacts(data.artifactReceipt, activeMediaGeneration, false);
        }
        const validation = mediaGenerationArtifactValidationRef.current;
        const terminalSucceeded = isFinalizedSuccessfulResponse(data);
        if (!terminalSucceeded) {
          if (validation) {
            validation.finalized = true;
            validation.terminalSucceeded = false;
            validation.terminalBlocked = Boolean(data.blocked);
          }
          setMediaGeneration({ status: responseWasCancelled ? 'cancelled' : 'error', detail: responseWasCancelled
            ? mediaGenerationText.statusCancelled
            : describeAgentResponseDelivery({
                ...data,
                text: data.text || mediaGenerationText.taskBlocked,
              }, isZh) });
        } else if (replayReceiptRejected) {
          // Preserve the exact settings mismatch reported above.
        } else if (!hasArtifact || !validation?.contractValid) {
          setMediaGeneration({ status: 'error', detail: mediaGenerationText.taskEndedNoArtifact });
        } else {
          validation.finalized = true;
          validation.terminalSucceeded = true;
          validation.terminalBlocked = false;
          if (validation.readyIds.size >= validation.requiredCount) {
            setMediaGeneration({ status: 'completed', detail: '' });
          } else {
            setMediaGeneration({ status: 'generating', detail: mediaGenerationText.validatingArtifact });
          }
        }
        activeMediaGenerationRef.current = null;
      }

      if (hasRemainingRequests) {
        // Every terminal owns only its own UI bucket. This applies to an
        // ordinary FIFO predecessor as well as a sidecar.
        return;
      }

      const finalization: ChatResponseFinalization = {
        finalized: data.finalized,
        blocked: data.blocked,
        reason: data.reason,
      };
      currentTurnUiMetaRef.current = turnMeta || currentTurnUiMetaRef.current;
      currentTurnUiMetaRef.current.finalization = finalization;
      if (!displayable) {
        setWorkflowStatus('error');
        const rejected = describeTurnCompletionProgress(
          isZh,
          turnMeta?.hadTool ?? currentTurnUiMetaRef.current.hadTool,
          true,
          { finalized: false, blocked: true, reason: data.reason },
        );
        finishChatProgress(rejected.text, rejected.tone);
        scheduleWorkflowReset(data.requestId);
        return;
      }
      const finalizedSuccess = isFinalizedSuccessfulResponse(data);
      const wasCancelled = responseWasCancelled;
      setWorkflowStatus(
        wasCancelled
          ? 'cancelled'
          : data.blocked ? 'error' : finalizedSuccess ? 'done' : 'idle'
      );
      const completion = describeTurnCompletionProgress(
        isZh,
        turnMeta?.hadTool ?? currentTurnUiMetaRef.current.hadTool,
        turnMeta?.needsEvidence ?? currentTurnUiMetaRef.current.needsEvidence,
        finalization,
      );
      finishChatProgress(completion.text, completion.tone);
      if (data.blocked || finalizedSuccess) scheduleWorkflowReset(data.requestId);
      // Auto-speak disabled
    };

    const onStatus = (data: { status: string; requestId?: string; source?: string; conversationId?: string; taskRelation?: unknown; executionAccepted?: boolean }) => {
      if (!isCurrentChatEvent(data)) return;
      recordTaskRelation(data);
      const activeStatus = ['queued', 'replacing', 'acknowledged', 'planning', 'thinking', 'responding', 'executing', 'waiting_confirmation', 'cancelling'].includes(data.status);
      const terminalStatus = isTerminalAgentStatus(data.status);
      const terminalTracking = terminalStatus
        ? settleTrackedChatRequest(data.requestId)
        : null;
      setIsTyping(activeStatus || chatRequestLedgerRef.current.size > 0 || Boolean(terminalTracking?.remaining));
      const requestId = String(data.requestId || '').trim();
      if (data.status === 'cancelling' && activeMediaGenerationRef.current?.requestId === requestId) {
        setMediaGeneration({ status: 'cancelling', detail: mediaGenerationText.statusCancelling });
      }
      if (!terminalStatus && requestId && requestId !== chatRequestLedgerRef.current.foreground) return;
      const turnMeta = chatTurnUiMetaRef.current.get(requestId);
      const activity = projectAgentActivity(data.status, {
        executionAccepted: data.executionAccepted,
        hasToolEvidence: turnMeta?.hadTool ?? currentTurnUiMetaRef.current.hadTool,
      });
      if (activity === 'thinking') {
        setWorkflowStatus('thinking');
        pushChatProgress(uiMessage('agent-chat-page.i-am-figuring-out-how.017a8f967e', (isZh) ? 'zh' : 'en'), 'thinking');
      } else if (activity === 'executing') {
        setWorkflowStatus('executing');
      } else if (activity === 'waiting_confirmation') {
        setWorkflowStatus('waiting_confirmation');
      } else if (activity === 'cancelling') {
        setWorkflowStatus('cancelling');
      } else if (data.status === 'idle') {
        if (!terminalTracking?.remaining) {
          setIsTyping(false);
          if (!currentTurnUiMetaRef.current.finalization) {
            setWorkflowStatus('idle');
            clearChatProgress();
            seenWorkflowToolEvents.current.clear();
          }
        }
      } else if (isTerminalAgentStatus(data.status)) {
        if (activeMediaGenerationRef.current?.requestId === String(data.requestId || '').trim()) {
          const cancelled = data.status === 'cancelled' || data.status === 'canceled';
          setMediaGeneration({ status: cancelled ? 'cancelled' : 'error', detail: cancelled ? mediaGenerationText.statusCancelled : mediaGenerationText.taskFailed });
          activeMediaGenerationRef.current = null;
        }
        if (!terminalTracking?.remaining) {
          setIsTyping(false);
          setWorkflowStatus('error');
          finishChatProgress(
            uiMessage('agent-chat-page.something-went-wrong-i-am.01c198a67b', (isZh) ? 'zh' : 'en'),
            'error'
          );
          scheduleWorkflowReset(data.requestId);
        }
      }
      if (terminalStatus) {
        // Drop partial streaming chunks that were never finalized
        dropRequestStream(data.requestId);
      }
    };

    const onError = (data: { message: string; code?: string; requestId?: string; source?: string; conversationId?: string; sidecar?: boolean }) => {
      if (!isCurrentChatEvent(data)) return;
      if (!terminalReceiptsRef.current.claim(data)) return;
      const message = sanitizeAgentResponseTextForDisplay(
        data.message || (t.failedToRouteNeuralMesh || 'Failed to route through Neural Mesh.'),
        isZh ? 'zh' : 'en',
      );
      if (activeMediaGenerationRef.current?.requestId === String(data.requestId || '').trim()) {
        setMediaGeneration({ status: 'error', detail: message || mediaGenerationText.taskFailed });
        activeMediaGenerationRef.current = null;
      }
      const tracked = settleTrackedChatRequest(data.requestId);
      const hasRemainingRequests = tracked.remaining > 0;
      setIsTyping(hasRemainingRequests);
      if (!hasRemainingRequests) {
        setWorkflowStatus('error');
        finishChatProgress(
          uiMessage('agent-chat-page.something-went-wrong-i-am.01c198a67b', (isZh) ? 'zh' : 'en'),
          'error'
        );
        scheduleWorkflowReset(data.requestId);
      }
      dropRequestStream(data.requestId);
      setMessages(prev => {
        const text = `${t.requestFailed || 'Request failed'}\n\n${message}`;
        if (prev.some(m => m.type === 'agent' && m.text === text)) return prev;
        return [...prev, {
          id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          userName: agentNameRef.current || 'Lumi',
          timestamp: new Date().toISOString(),
          type: 'agent',
          source: 'error',
        }];
      });
    };

    const onTaskRelation = (data: ServerTaskRelationEvent) => {
      const eventSource = String(data?.source || '').trim();
      const eventConversationId = String(data?.conversationId || '').trim();
      const currentConversationId = attachmentConversationIdRef.current;
      if (eventSource && eventSource !== chatExecutionSource) return;
      if (currentConversationId && eventConversationId && eventConversationId !== currentConversationId) return;
      if (!currentConversationId && eventConversationId) {
        bindAttachmentContextToConversation(eventConversationId, { carryCurrent: true });
      }
      recordTaskRelation(data);
    };

    // conversation_updated: only reload for non-text-chat channels (voice, etc.)
    // Text chat state is managed live via agent:chunk/agent:response; API reload here
    // would replace messages with different ids, causing React to remount & re-animate them.
    const onConversationUpdated = (data: {
      conversationId: string;
      agentId: string;
      source?: string;
      requestId?: string;
      originSocketId?: string;
      rolledOver?: boolean;
      previousConversationId?: string;
    }) => {
      if (data.agentId !== agentId) return;
      if ((data.source === CREATION_EXECUTION_SOURCE) !== isCreationWorkspace) return;
      const currentConversationId = attachmentConversationIdRef.current;
      const isCurrentRollover = data.rolledOver === true
        && Boolean(currentConversationId)
        && data.previousConversationId === currentConversationId;
      if (data.conversationId && data.conversationId !== currentConversationId && (isCurrentRollover || !currentConversationId)) {
        bindAttachmentContextToConversation(data.conversationId, {
          carryCurrent: isCurrentRollover,
        });
      }
      if (currentConversationId && data.conversationId !== currentConversationId && !isCurrentRollover) return;
      if (!shouldReloadPersistedConversation({
        event: data,
        currentConversationId,
        currentSocketId: socket.id,
        activeRequestId: chatRequestLedgerRef.current.foreground,
      })) return;
      const work = chatViewWorkRef.current.begin();
      const messageRevision = messagesRevisionRef.current;
      const refreshRevision = ++historyRefreshRevisionRef.current;
      fetch(scopedConversationUrl(`/api/conversations/${data.conversationId}/messages?limit=${CHAT_HISTORY_LIMIT}`), { signal: work.signal })
        .then(r => r.json())
        .then(result => {
          if (!work.isCurrent()
            || data.conversationId !== attachmentConversationIdRef.current
            || refreshRevision !== historyRefreshRevisionRef.current
            || messageRevision !== messagesRevisionRef.current
            || chatRequestLedgerRef.current.size > 0) return;
          if (result.messages && Array.isArray(result.messages)) {
            streamingMsgIdsRef.current.clear();
            streamingRawTextRef.current.clear();
            setMessages(normalizePersistedMessages(result.messages));
          }
        })
        .catch(() => {})
        .finally(() => work.finish());
    };

    const onDesktopControlState = (data: any) => {
      const id = `desktop-control-${String(data?.leaseId || data?.taskId || 'current')}`;
      const status = String(data?.status || '');
      if (status === 'released' || status === 'expired') {
        toast.dismiss(id);
      } else if (status === 'paused') {
        toast.warning('Lumi paused desktop control because user activity or a higher-priority task was detected.', { id, duration: 6000 });
      } else if (status === 'waiting') {
        toast('Desktop control is waiting for the current owner to finish.', { id, duration: 4000 });
      } else if (status === 'active') {
        toast('Lumi is controlling the desktop for the active task.', { id, duration: 2500 });
      }
    };

    if (!isCreationWorkspace) socket.on("agent:proactive", onProactive);
    if (!isCreationWorkspace) socket.on("agent:desktop_control_state", onDesktopControlState);
    socket.on("agent:chunk", onChunk);
    socket.on("agent:progress", onProgress);
    socket.on("agent:tool", onTool);
    socket.on("agent:tool_call", onTool);
    socket.on("agent:response", onResponse);
    socket.on("agent:status", onStatus);
    socket.on("agent:task_relation", onTaskRelation);
    socket.on("agent:error", onError);
    socket.on("chat:conversation_updated", onConversationUpdated);

    return () => {
      socket.off("agent:proactive", onProactive);
      socket.off("agent:desktop_control_state", onDesktopControlState);
      socket.off("agent:chunk", onChunk);
      socket.off("agent:progress", onProgress);
      socket.off("agent:tool", onTool);
      socket.off("agent:tool_call", onTool);
      socket.off("agent:response", onResponse);
      socket.off("agent:status", onStatus);
      socket.off("agent:task_relation", onTaskRelation);
      socket.off("agent:error", onError);
      socket.off("chat:conversation_updated", onConversationUpdated);
    };
  }, [isCreationWorkspace, attachmentConversationIdRef, activeDomain, activeOrgId, acceptChatExecutionEvent, agentId, agentName, bindAttachmentContextToConversation, chatExecutionSource, clearChatProgress, clearPersistedExecution, dropRequestStream, finishChatProgress, isFounder, isZh, mediaGenerationText, normalizePersistedMessages, pushChatProgress, scheduleWorkflowReset, scopedConversationUrl, setMessages, settleTrackedChatRequest, socket, t.failedToRouteNeuralMesh, t.requestFailed, t.workflowAnalyzing, t.workflowError, taskRelationLedgerRef, streamingRawTextRef, streamingMsgIdsRef, activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaGenerationArtifacts, setMediaGeneration, seenWorkflowToolEvents, chatTurnUiMetaRef, chatRequestLedgerRef, currentTurnUiMetaRef, setWorkflowStatus, terminalReceiptsRef, setIsTyping, agentNameRef, chatViewWorkRef, messagesRevisionRef, historyRefreshRevisionRef]);
  return {
    ...previousBindings
  } as const;
}
