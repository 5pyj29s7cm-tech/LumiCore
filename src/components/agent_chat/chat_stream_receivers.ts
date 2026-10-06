import type { ChatStreamReceiverInput } from '../AgentChatPage';
import { makeChatMessageId } from "./history";
import { MEDIA_GENERATION_TOOL_NAMES, isExpectedMediaGenerationTool } from "./media_artifacts";
import { describeToolProgress, type ChatProgressTone } from "@/lib/chatProgress";
import { sanitizeAgentStreamingTextForDisplay, sanitizeAgentResponseTextForDisplay, shouldDisplayAgentResponse } from "@/lib/agentResponseDelivery";
import { type ServerTaskRelationEvent } from "@/lib/chatTaskRelations";
import { extractMediaGenerationArtifacts, mediaGenerationArgumentsMatch, resolveMediaGenerationOperation } from "@/lib/mediaGenerationArtifacts";

export function createChatStreamReceivers({ acceptChatExecutionEvent, taskRelationLedgerRef, isZh, setMessages, agentName, streamingRawTextRef, streamingMsgIdsRef, activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaGenerationArtifacts, setMediaGeneration, mediaGenerationText, seenWorkflowToolEvents, chatTurnUiMetaRef, chatRequestLedgerRef, currentTurnUiMetaRef, setWorkflowStatus, pushChatProgress }: ChatStreamReceiverInput) {


    const isCurrentChatEvent = (data?: { requestId?: string; source?: string; conversationId?: string }) => (
      acceptChatExecutionEvent(data)
    );

    const recordTaskRelation = (data?: ServerTaskRelationEvent) => {
      if (!data) return;
      taskRelationLedgerRef.current.record(data);
    };

    const onProactive = (data: {
      message: string;
      timestamp: string;
      requestId?: string;
      conversationId?: string;
      source?: string;
      type?: string;
      taskId?: string;
      finalized?: boolean;
      blocked?: boolean;
      reason?: string;
    }) => {
      const proactiveType = data.type || data.taskId;
      if (proactiveType === 'greeting' && localStorage.getItem('lumi_allow_proactive_voice') !== 'true') return;
      if ((data.requestId || data.source) && !isCurrentChatEvent(data)) return;
      if (!shouldDisplayAgentResponse({ ...data, text: data.message })) return;
      const publicMessage = sanitizeAgentResponseTextForDisplay(data.message, isZh ? 'zh' : 'en');
      if (!publicMessage) return;
      setMessages(prev => {
        if (prev.some(m => m.text === publicMessage && m.type === 'agent')) return prev;
        return [...prev, {
          id: `proactive-${Date.now()}`,
          text: publicMessage,
          userName: agentName,
          timestamp: data.timestamp || new Date().toISOString(),
          type: 'agent',
          source: 'proactive',
        }];
      });
    };

    const onChunk = (data: { text: string; agentName: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const streamKey = String(data.requestId || '__legacy__');
      const rawText = `${streamingRawTextRef.current.get(streamKey) || ''}${data.text}`;
      streamingRawTextRef.current.set(streamKey, rawText);
      const publicText = sanitizeAgentStreamingTextForDisplay(rawText, isZh ? 'zh' : 'en');
      if (!publicText) return;
      const currentStreamId = streamingMsgIdsRef.current.get(streamKey);
      if (currentStreamId) {
        const sid = currentStreamId;
        setMessages(prev => prev.map(m =>
          m.id === sid ? { ...m, text: publicText } : m
        ));
      } else {
        const id = makeChatMessageId('stream');
        streamingMsgIdsRef.current.set(streamKey, id);
        setMessages(prev => [...prev, {
          id,
          text: publicText,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent'
        }]);
      }
    };

    const receiveMediaArtifacts = (
      receipt: unknown,
      active: NonNullable<typeof activeMediaGenerationRef.current>,
      merge = true,
    ): boolean => {
      const incoming = extractMediaGenerationArtifacts(receipt, active.mode)
        .filter(artifact => artifact.kind === active.mode)
        .map(artifact => ({ ...artifact, requestId: active.requestId, operation: resolveMediaGenerationOperation(active.request) }));
      if (!incoming.length) return false;
      const artifacts = merge ? [...mediaGenerationArtifactsRef.current, ...incoming].filter((artifact, index, all) => (
        all.findIndex(candidate => candidate.kind === artifact.kind && candidate.url === artifact.url) === index
      )) : incoming;
      const prior = merge ? mediaGenerationArtifactValidationRef.current : null;
      const expectedIds = new Set(artifacts.map(artifact => artifact.id));
      const requiredCount = active.mode === 'image' ? Math.max(1, Number(active.request.count) || 1) : 1;
      const contractValid = artifacts.length >= requiredCount;
      mediaGenerationArtifactValidationRef.current = {
        expectedIds,
        readyIds: new Set([...(prior?.readyIds || [])].filter(id => expectedIds.has(id))),
        failedIds: new Set([...(prior?.failedIds || [])].filter(id => expectedIds.has(id))),
        requiredCount,
        contractValid,
        finalized: prior?.finalized || false,
        terminalSucceeded: prior?.terminalSucceeded || false,
        terminalBlocked: prior?.terminalBlocked || false,
      };
      mediaGenerationArtifactsRef.current = artifacts;
      setMediaGenerationArtifacts(artifacts);
      setMediaGeneration({ status: contractValid ? 'generating' : 'error', detail: contractValid ? mediaGenerationText.validatingArtifact : mediaGenerationText.artifactCountMismatch });
      return true;
    };

    const onTool = (data: { correlationId?: string; name: string; args?: any; arguments?: any; result?: string; artifactReceipt?: unknown; error?: string; publicText?: string; requestId?: string; source?: string; conversationId?: string; taskRelation?: unknown }) => {
      if (!isCurrentChatEvent(data)) return;
      recordTaskRelation(data);
      const requestId = String(data.requestId || '').trim();
      const args = data.arguments ?? data.args;
      const phase = data.error !== undefined
        ? 'error'
        : data.artifactReceipt !== undefined || data.result !== undefined
          ? 'result'
          : 'start';
      const eventRequestKey = requestId || '__legacy__';
      const workflowEventKey = data.correlationId
        ? `${eventRequestKey}:${data.correlationId}:${phase}`
        : `${eventRequestKey}:${data.name}:${phase}:${String(data.result ?? data.error ?? '').slice(0, 120)}`;
      if (seenWorkflowToolEvents.current.has(workflowEventKey)) return;
      seenWorkflowToolEvents.current.add(workflowEventKey);

      const activeMediaGeneration = activeMediaGenerationRef.current;
      const mediaToolBelongsToActiveRequest = activeMediaGeneration?.requestId === requestId
        && MEDIA_GENERATION_TOOL_NAMES.has(data.name);
      if (
        mediaToolBelongsToActiveRequest
        && activeMediaGeneration
        && !isExpectedMediaGenerationTool(activeMediaGeneration.request, data.name)
      ) {
        mediaGenerationArtifactValidationRef.current = null;
        setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
      }
      if (
        mediaToolBelongsToActiveRequest
        && activeMediaGeneration
        && isExpectedMediaGenerationTool(activeMediaGeneration.request, data.name)
      ) {
        if (data.error !== undefined) {
          mediaGenerationArtifactValidationRef.current = null;
          setMediaGeneration({ status: 'error', detail: mediaGenerationText.toolFailed });
        } else if (data.artifactReceipt !== undefined || data.result !== undefined) {
          if (!mediaGenerationArgumentsMatch(activeMediaGeneration.request, args)) {
            mediaGenerationArtifactValidationRef.current = null;
            setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
          } else if (!receiveMediaArtifacts(data.artifactReceipt ?? data.result, activeMediaGeneration)) {
            mediaGenerationArtifactValidationRef.current = null;
            setMediaGeneration({ status: 'generating', detail: mediaGenerationText.toolReturnedNoArtifact });
          }
        } else {
          setMediaGeneration({ status: 'generating', detail: '' });
        }
      }

      const turnMeta = chatTurnUiMetaRef.current.get(requestId);
      if (turnMeta) turnMeta.hadTool = true;
      if (!requestId || chatRequestLedgerRef.current.foreground === requestId) {
        currentTurnUiMetaRef.current.hadTool = true;
      }
      if (requestId && chatRequestLedgerRef.current.foreground !== requestId) return;
      setWorkflowStatus('executing');
      const customerToolText = sanitizeAgentResponseTextForDisplay(
        data.publicText || describeToolProgress(data.name, phase, isZh),
        isZh ? 'zh' : 'en',
      );
      pushChatProgress(customerToolText, phase === 'error' ? 'error' : 'tool');
    };

    const onProgress = (data: { text?: string; publicText?: string; tone?: ChatProgressTone; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const requestId = String(data.requestId || '').trim();
      if (!requestId || chatRequestLedgerRef.current.foreground === requestId) {
        pushChatProgress(sanitizeAgentResponseTextForDisplay(data.publicText || data.text || '', isZh ? 'zh' : 'en'), data.tone || 'tool');
      }
      if (activeMediaGenerationRef.current?.requestId === requestId && data.text?.trim()) {
        setMediaGeneration({ status: 'generating', detail: data.text.trim() });
      }
    };
  return { isCurrentChatEvent, recordTaskRelation, onProactive, onChunk, receiveMediaArtifacts, onTool, onProgress };
}
