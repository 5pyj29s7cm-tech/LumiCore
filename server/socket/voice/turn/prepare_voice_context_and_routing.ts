import { preparePlannedConversationExecution } from "../../../conversation/planned_execution";
import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { logger } from "../../../../logger";
import { synthesizeSpeech, getActiveProvider as getTTSProvider, isTtsCancellationError } from "../../../tts/adapter";
import { isVoiceReferentialFollowup } from "../../voice_turn_state";
import { CN_VOICE_WORK_MESSAGES } from "../../../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { getMessages, getTopicContext, getConversationSummary } from "../../../conversation/manager";
import { recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably } from "../../chat_execution_registry";
import { flushDBOrThrow } from "../../../../db_layer";
import { isCapabilityMetaQuestion } from "../../../cognition/capability_meta";
import { hasClientActionOnlyIntent, hasExplicitToolIntent, isUserCorrectionOrExplanationQuestion } from "../../../cognition/tool_intent";
import { startVoiceLatencyTrace } from "../../../monitor/voice_latency_store";
import { emitVoiceWorkProgress, startVoiceWorkHeartbeat, stopVoiceWorkHeartbeat } from "../work_progress";
import { detectRequestedOperationMode } from "../../../cognition/operation_modes";
import { collectAnticipatoryContext } from "../../../context/anticipatory_context";
import { queryMemories } from "../../../memory/store";
import { CONVERSATIONAL_MEMORY_EVIDENCE } from "../../../memory/types";
import { retrieveChunks } from "../../../agents/rag";
import { searchKnowledgeBase } from "../../../org/kb";
import { personalityRegistry } from "../../../personality";
import { getStoredOperationMode } from "../../../cognition/operation_mode_store";
import { buildLumiExecutionPipeline } from "../../../cognition/execution_pipeline";
import { toolRegistry } from "../../../tools/registry";
import { TASK_TARGET_HISTORY_LIMIT } from "../../../conversation/task_target_anchor";
import { resolveVoiceModelInputBudget } from "../../voice_runtime_policy";
import { buildDesktopExecutionStabilityPolicy } from "../../../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker } from "../../../desktop/execution_runtime";
import { commitChatTerminalBoundary } from "../../chat_terminal_boundary";
import { resolveSingleVoiceTtsRoute } from "../selection";
import { captureVoiceTurnOwner, emitVoiceTtsFailure, voiceTransportState, computeVolumeGain, resetSilenceTimer } from "../../voice_transport_runtime";
import { addEchoText, voiceEchoScope } from "../echo";
import { shouldAllowVoiceLocalFileWriteForTurn } from "../../voice_turn_policy";
import type { prepareVoiceIdentityAndAdmission } from './prepare_voice_identity_and_admission';

export async function prepareVoiceContextAndRouting(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceIdentityAndAdmission>>["context"]>) {


  context.turnAuthorization.assertCurrent();
  context.session.pendingInterruptedTurn = null;
  context.session.isSpeaking = false;
  context.session.isProcessing = true;
  context.session.isBackgroundWork = context.transcriptExecutionGuard.action !== 'clarify'
    && !isCapabilityMetaQuestion(context.actionIntentText)
    && hasExplicitToolIntent(context.actionIntentText);
  context.session.activeWorkStatus = context.session.isBackgroundWork ? 'planning' : 'idle';
  context.session.activeWorkStep = '';
  context.session.activeWorkToolCalls = 0;
  startVoiceLatencyTrace({
    requestId: context.requestId,
    provider: context.inputTiming.sttProvider,
    domain: context.session.domain,
    speechEndedAt: context.inputTiming.speechEndedAt,
    asrFinalAt: context.inputTiming.asrFinalAt,
    pipelineStartedAt: Date.now(),
  });
  context.session.pipelineAbortController = context.pipelineAbort;
  context.session.activeTurnText = context.userText;
  context.session.voiceTurnGeneration += 1;
  context.session.activeTurnRequestId = context.requestId;
  context.session.activeExecutionReceipts = context.executionReceipts;
  context.session.activeRoutingText = context.actionIntentText;
  context.resources.owner = captureVoiceTurnOwner(context.session);
  context.turnAuthorization.assertCurrent();
  context.emitAgent("agent:status", { status: "thinking", agentName: "Lumi" });
  context.socket.emit("audio:status", { status: "thinking", requestId: context.requestId });
  if (context.session.isBackgroundWork) {
    emitVoiceWorkProgress(context.socket, context.session, context.requestId, 'planning', CN_VOICE_WORK_MESSAGES.workAccepted);
    startVoiceWorkHeartbeat(context.socket, context.session, context.requestId);
  }
  const routedUserText = [context.actionIntentText, context.actionContinuationBridge, context.pendingConfirmationPrompt].filter(Boolean).join('\n\n');
  context.session.activeRoutingText = context.actionIntentText;
  const requestedModeHint = detectRequestedOperationMode(context.userText);
  const skipKnowledgeRetrieval = context.transcriptExecutionGuard.action === 'clarify'
    || Boolean(requestedModeHint)
    || isCapabilityMetaQuestion(context.userText)
    || hasClientActionOnlyIntent(context.userText)
    || isUserCorrectionOrExplanationQuestion(context.userText);
  const allowLocalFileWrites = shouldAllowVoiceLocalFileWriteForTurn(routedUserText);
  const localWriteIntentReason = allowLocalFileWrites
    ? `Current voice request explicitly asked Lumi to generate/export a local deliverable: "${context.userText.slice(0, 120)}"`
    : undefined;

  // Cross-session context is read-only and prefetched in parallel. A slow
  // knowledge source must not hold the spoken turn open indefinitely.
  let voiceMemories: any[] = [];
  const voiceRagKnowledge: string[] = [];
  let voiceOrganizationKnowledge = '';
  if (!skipKnowledgeRetrieval) {
    const ragAgentIds = Array.from(new Set([context.session.agentId, 'lumi'].filter(Boolean)));
    // Memory and knowledge are mutable user data. Read the authoritative
    // stores each turn; a second TTL cache can replay data the user deleted.
    const prefetch = await collectAnticipatoryContext([
      {
        key: 'memory',
        operation: 'read',
        sideEffectClass: 'none',
        run: () => queryMemories({
          userId: context.session.userId,
          query: routedUserText,
          limit: 5,
          minConfidence: 0.4,
          domain: context.voiceScope.domain,
          orgId: context.voiceScope.orgId,
          evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
        }),
      },
      ...ragAgentIds.map(ragAgentId => ({
        key: `rag:${ragAgentId}`,
        operation: 'read' as const,
        sideEffectClass: 'none' as const,
        run: (signal?: AbortSignal) => retrieveChunks(context.session.userId, ragAgentId, routedUserText, 3, {
          domain: context.voiceScope.domain,
          orgId: context.voiceScope.domain === 'work' ? context.voiceScope.orgId : '',
          signal,
        }),
      })),
      ...(context.voiceScope.domain === 'work' && context.voiceScope.orgId ? [{
        key: 'organization',
        operation: 'read' as const,
        sideEffectClass: 'none' as const,
        run: (signal?: AbortSignal) => searchKnowledgeBase(context.voiceScope.orgId, routedUserText, { limit: 3, userId: context.session.userId, signal }),
      }] : []),
    ], { deadlineMs: 1_300, signal: context.pipelineAbort.signal });

    voiceMemories = Array.isArray(prefetch.values.memory) ? prefetch.values.memory : [];
    for (const ragAgentId of ragAgentIds) {
      const chunks = prefetch.values[`rag:${ragAgentId}`];
      if (!Array.isArray(chunks)) continue;
      for (const chunk of chunks) {
        const content = String((chunk as any)?.content || '').trim();
        if (content && !voiceRagKnowledge.includes(content)) voiceRagKnowledge.push(content);
        if (voiceRagKnowledge.length >= 5) break;
      }
      if (voiceRagKnowledge.length >= 5) break;
    }
    const organizationResults = prefetch.values.organization;
    if (Array.isArray(organizationResults)) {
      voiceOrganizationKnowledge = organizationResults
        .map((result: any) => `[${result.title}] ${result.chunk}`)
        .join('\n');
    }
    if (prefetch.failed.length > 0 || prefetch.timedOut.length > 0) {
      logger.warn(`[Audio] Read-only context prefetch partial: failed=${prefetch.failed.map(item => item.key).join(',') || 'none'} timedOut=${prefetch.timedOut.join(',') || 'none'} elapsedMs=${prefetch.elapsedMs}`);
    }
  } else {
    logger.info('[Audio] Skipped memory/RAG retrieval for deterministic or corrective voice turn');
  }

  context.turnAuthorization.assertCurrent();
  const sensoryAudio = context.sensoryFn(context.session.userId);
  const personalityConfig = personalityRegistry.getForUser(
    context.session.personalityId || 'lumi',
    context.session.userId,
    context.voiceScope.orgId,
  ) || personalityRegistry.getDefault();

  // ── Unified personality prompt + voice-specific overlay ──
  // Same core prompt as text chat — one Lumi, one framework.
  const baseVoiceOverlay = [
    '\n## Voice Mode',
    '- You are SPEAKING, not typing. Be conversational and natural, like talking to a friend.',
    '- Keep spoken responses concise; the user is listening, not reading.',
  ].join('\n');

  // Inject older summary/topic continuity only for a genuinely referential
  // utterance. Feeding a long task summary into every ordinary voice question
  // made completed app commands compete with the current sentence.
  let topicContext = '';
  const wantsHistoricalVoiceContext = Boolean(
    context.actionContinuationBridge
    || isVoiceReferentialFollowup(context.userText)
    // i18n-allow: history-recall recognition; not user-visible copy.
    || /(?:刚才|刚刚|之前|上次|以前|我们聊过|还记得)|\b(?:earlier|before|previously|last time|we discussed|remember)\b/iu.test(context.userText),
  );
  try {
    if (wantsHistoricalVoiceContext) {
      const summary = getConversationSummary(context.conversationTurn.conversation.id);
      if (summary) topicContext += `\n\n## Conversation Context\n${summary}`;
      const tc = getTopicContext(context.conversationTurn.conversation.id);
      if (tc) topicContext += tc;
    }
  } catch {}

  const operationMode = (() => {
    try {
      return getStoredOperationMode(context.session.userId);
    } catch {}
    return 'assistant';
  })();
  const requestedMode = requestedModeHint;
  const executionPipeline = buildLumiExecutionPipeline({
    requestId: context.requestId, userText: context.userText, acceptedResolution:context.acceptedVoiceResolution,
    dispatch: {
      userId: context.session.userId,
      text: context.actionIntentText,
      continuationContext: [context.actionContinuationBridge, context.pendingConfirmationPrompt]
        .filter(Boolean)
        .join('\n\n'),
      channel: 'voice',
      source: 'voice',
      domain: context.voiceScope.domain,
      orgId: context.voiceScope.orgId,
      surface: 'voice',
      operationMode,
      requestedMode,
      targetIsLumi: true,
    },
    registry: toolRegistry,
    personalityToolPolicy: personalityConfig.toolPolicy,
    executionBoundary: context.toolSecurityContext.executionBoundary,
    actionTaskState: context.conversationTurn.conversation.actionContinuationState,
    persistedConversationHistory: getMessages(context.conversationTurn.conversation.id, TASK_TARGET_HISTORY_LIMIT)
      .filter(record => record.requestId !== context.requestId),
    pendingAssistantOfferContext: context.pendingAssistantOfferContext,
    traceText: context.actionIntentText,
    source: 'voice',
  });
  const turnDispatch = executionPipeline.turnIntent;
  const turnFlow = turnDispatch.flow;
  const effectiveOperationMode = turnFlow.effectiveOperationMode;
  const selfRepairTurn = turnFlow.selfRepairTurn;
  const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
  const workSurfaceRoute = turnFlow.workSurfaceRoute;
  const visionIntent = turnFlow.visionIntent;
  const executionDecision = executionPipeline.execution;
  const requestedToolSession = context.transcriptExecutionGuard.action === 'clarify'
    ? false
    : executionPipeline.executionRequested;
  const voiceInputTokenBudget = resolveVoiceModelInputBudget({
    text: context.actionIntentText,
    allowToolUse: requestedToolSession,
  });
  const { systemPrompt: fullPersonalityPrompt } = personalityRegistry.buildSystemPrompt(
    context.session.personalityId || 'lumi',
    {
      mode: requestedToolSession ? 'task' : 'chat',
      sensory: sensoryAudio,
      uiContext: 'voice',
    },
    {
      userId: context.session.userId,
      memories: voiceMemories.length > 0 ? voiceMemories : undefined,
      ragKnowledge: voiceRagKnowledge.length > 0 ? voiceRagKnowledge : undefined,
      userText: routedUserText,
      domain: context.voiceScope.domain,
      orgId: context.voiceScope.orgId,
    },
  );
  context.session.isBackgroundWork = requestedToolSession;
  context.session.activeWorkStatus = requestedToolSession ? 'planning' : 'idle';
  if (requestedToolSession && !context.session.workHeartbeatTimer) {
    emitVoiceWorkProgress(context.socket, context.session, context.requestId, 'planning', CN_VOICE_WORK_MESSAGES.workAccepted);
    startVoiceWorkHeartbeat(context.socket, context.session, context.requestId);
  } else if (!requestedToolSession) {
    stopVoiceWorkHeartbeat(context.session);
  }
  const intentTrace = executionPipeline.intentTrace;
  const capabilitySelection = executionPipeline.capabilityPlan;
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'voice',
    text: turnFlow.routeText,
    flow: turnFlow,
    capabilitySelection,
    capabilityExecutionPlan: executionPipeline.executionPlan,
  });
  const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
  const routedToolPolicy = executionPipeline.authorizationPolicy;
  const modelToolProjection = executionPipeline.modelToolProjection;
  const visibleToolRoute = executionDecision.toolRoute;
  const toolSessionActive = requestedToolSession;
  const actionFollowupIntent = executionPipeline.actionFollowupIntent;
  const actionTaskExecution = preparePlannedConversationExecution({
    execution: executionPipeline, conversationId: context.conversationTurn.conversation.id,
    userId: context.session.userId, userText: context.actionIntentText, requestId: context.requestId, userMessageId: context.voiceUserMessageId,
    pendingConfirmation: context.pendingConfirmation,
    acceptedInterruptedTurn: context.interruptedMerge.usedInterruptedTurn,
    observationOnly: turnFlow.conceptualCapabilityQuestion || context.transcriptExecutionGuard.action === 'clarify' || context.userObservedCompletion,
    bindConversationTurn: true,
  });
  if ('bindingFailure' in actionTaskExecution) {
    const staleText = actionTaskExecution.bindingFailure === 'busy'
      ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
      : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
    stopVoiceWorkHeartbeat(context.session);
    context.session.isBackgroundWork = false;
    context.session.activeWorkStatus = 'idle';
    context.session.activeWorkStep = '';
    const bindingTerminalPayload = context.normalizeAgentPayload('agent:response', {
      text: staleText,
      agentName: 'Lumi',
      source: 'voice_turn_binding',
      finalized: true,
      blocked: true,
      reason: actionTaskExecution.diagnosticCode,
    });
    const bindingCommitted = await commitChatTerminalBoundary({
      persistTerminalState: () => undefined,
      persistAssistantMessage: () => context.writeVoiceMessage({
        conversationId: context.conversationTurn.conversation.id,
        role: 'assistant',
        content: staleText,
        source: 'voice_turn_binding',
        cognitiveIntent: actionTaskExecution.diagnosticCode,
        llmWasCalled: false,
        requestId: context.requestId,
        ...(context.voiceTurnProvenance || {}),
        taskIntent: 'conversation',
        skipActionContinuation: true,
      }),
      flush: flushDBOrThrow,
      persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
        context.executionScope,
        context.requestId,
        'agent:response',
        bindingTerminalPayload,
        context.executionUnknownPayload,
      ),
      persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
        context.executionScope,
        context.requestId,
        context.executionUnknownPayload,
      ),
      publishCommitted: () => {
        context.publishRecordedAgent('agent:response', bindingTerminalPayload);
        context.socket.emit('chat:conversation_updated', {
          conversationId: context.conversationTurn.conversation.id,
          agentId: context.session.agentId,
          source: 'voice_turn_binding',
          requestId: context.requestId,
        });
      },
      publishUnknown: () => context.publishRecordedAgent('agent:response', context.executionUnknownPayload),
      persistenceUnknownProjection: {
        text: context.executionUnknownPayload.text,
        completionFeedback: context.executionUnknownPayload.completionFeedback,
        reason: 'Terminal persistence outcome is unknown.',
      },
      onPersistenceError: error => {
        logger.error('[Audio] Voice binding terminal persistence failed:', error);
      },
    });
    let bindingSpeechCounted = false;
    try {
      const ttsProvider = getTTSProvider();
      if (bindingCommitted && ttsProvider && context.session.currentVoiceId && context.session.isActive) {
        const ttsRoute = await resolveSingleVoiceTtsRoute(context.session, ttsProvider, context.session.currentVoiceId);
        if (!ttsRoute) throw new Error(`Provider ${ttsProvider} has no compatible voice`);
        context.session.isSpeaking = true;
        voiceTransportState.ttsSpeakingCount++;
        bindingSpeechCounted = true;
        const ttsResult = await synthesizeSpeech(staleText, {
          provider: ttsRoute.provider,
          voiceId: ttsRoute.voiceId,
          model: ttsRoute.model,
          speechRate: ttsRoute.speechRate,
          pitch: ttsRoute.pitch,
          volume: ttsRoute.volume,
          signal: context.pipelineAbort.signal,
          allowFallback: false,
        });
        if (context.isCurrentTurn()) {
          context.socket.emit('audio:status', { status: 'speaking', requestId: context.requestId });
          addEchoText(staleText, voiceEchoScope(context.session));
          context.socket.emit('audio:response', {
            buffer: ttsResult.audioBuffer,
            format: ttsResult.format,
            volumeGain: computeVolumeGain(),
            lane: 'conversation',
            requestId: context.requestId,
          });
        }
      }
    } catch (bindingSpeechError: any) {
      if (!isTtsCancellationError(bindingSpeechError, context.pipelineAbort.signal)) {
        logger.warn(`[Audio] Failed to speak stale/busy turn response: ${bindingSpeechError?.message || String(bindingSpeechError)}`);
        emitVoiceTtsFailure(context.socket, context.requestId, 'conversation');
      }
    } finally {
      if (bindingSpeechCounted) {
        const decay = () => { voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1); };
        const timer = setTimeout(decay, 3000);
        context.session.ttsDecayTimers.push(timer);
      }
      if (context.session.pipelineAbortController === context.pipelineAbort) {
        context.session.isSpeaking = false;
        context.session.isProcessing = false;
        context.session.activeWorkToolCalls = 0;
        context.session.activeTurnText = '';
        context.session.activeRoutingText = '';
        if (context.session.isActive) {
          resetSilenceTimer(context.session, context.socket);
          context.socket.emit('audio:status', { status: 'listening', requestId: context.requestId });
          context.emitAgent('agent:status', { status: 'idle' });
        }
        context.session.pipelineAbortController = null;
        context.session.activeTurnRequestId = null;
        context.session.suppressedSpeechRequestIds.delete(context.requestId);
      }
    }
    { return { terminal: true as const, context: undefined }; }
  }
  return { terminal: false as const, context: extendTurnBindings(context, {
    actionTaskExecution,
    executionPipeline,
    toolSessionActive,
    executionDecision,
    operationMode,
    effectiveOperationMode,
    turnFlow,
    clientActionOnlyTurn,
    selfRepairTurn,
    capabilitySelection,
    intentTrace,
    visibleToolRoute,
    desktopExecutionPolicy,
    workSurfaceRoute,
    visionIntent,
    routedUserText,
    baseVoiceOverlay,
    turnDispatch,
    get voiceOrganizationKnowledge(): typeof voiceOrganizationKnowledge { return voiceOrganizationKnowledge; },
    set voiceOrganizationKnowledge(value: typeof voiceOrganizationKnowledge) { voiceOrganizationKnowledge = value; },
    fullPersonalityPrompt,
    get topicContext(): typeof topicContext { return topicContext; },
    set topicContext(value: typeof topicContext) { topicContext = value; },
    routedToolPolicy,
    allowLocalFileWrites,
    localWriteIntentReason,
    modelToolProjection,
    desktopExecutionTracker,
    actionFollowupIntent,
    voiceInputTokenBudget,
    requestedMode,
  }) };
}
