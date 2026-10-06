import { extendTurnBindings } from "../cognition/turn_bindings";
import { createToolLifecycleCallbacks } from "./tool_lifecycle";
import { Server, Socket } from "socket.io";
import { type AudioSession, getVoiceStateKey, type VoiceInputTiming } from "./voice/session";
import type { LLMGetters as LlmGetters } from '../llm/dispatch';
import { reserveConversationExecution, type ConversationResourceLifetime } from '../cognition/conversation_execution';
import { isVoiceprintGateOpen, blockUnverifiedVoice } from "./voice/voiceprint";
import { captureChatAuthorization } from './chat_authorization';
import { assessVoiceTranscriptForExecution } from '../cognition/voice_transcript_guard';
import { logger } from "../../logger";
import { getConfiguredVoiceModel, getVoicePreference } from '../config/voice_preference';
import { synthesizeSpeech, getActiveProvider as getTTSProvider, getFallbackProvider as getTTSFallbackProvider, isTtsCancellationError, resolveEmotionVoice } from "../tts/adapter";
import { isVoiceCorrectionContinuation, isVoiceCurrentActivityQuestion, isVoiceReferentialFollowup, mergeInterruptedVoiceTurn } from "./voice_turn_state";
import { CN_VOICE_FAST_PATH_MESSAGES, CN_VOICE_WORK_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../regions/messages/task_execution_messages";
import { getConversationForScope, getOrCreateActiveConversation, getOrCreateConversationForTurn, addMessageIdempotent, getMessages, getMessagesByTokenBudget, extractTopics, trackTopic, getTopicContext, getConversationSummary, getConversationActionStatus, prepareConversationActionExecution, persistConversationExecutionPlan, completeConversationActionFromUserObservation, createDurableForegroundReleaseGate, setConversationActionExecutionStatus, startConversationActionExecutionHeartbeat, updateConversationActionFocus, type ForegroundRequestIdentity as VoiceForegroundRequestIdentity } from "../conversation/manager";
import { buildForegroundWeChatSendArgs } from "../regions/packs/cn/foreground_wechat_intent";
import { ensurePendingConfirmationPersistenceInitialized } from '../tools/pending_confirmation_repository';
import { sanitizeVoiceAgentErrorPayload, voiceDurabilityUnknownText } from './voice_durability';
import { buildRecentActionContinuationBridge, formatConversationActionTaskStatus, isUserObservedTaskCompletion } from "../cognition/action_continuation";
import { randomUUID } from "node:crypto";
import { createVoiceExecutionReceiptCollector } from './voice_execution_receipts';
import { issueVoiceTurnProvenance } from './voice_provenance';
import { createModelTurnState } from '../llm/model_turn_state';
import { beginChatExecutionDurably, recordChatExecutionEvent, recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, type ChatExecutionScope } from './chat_execution_registry';
import { recoverBlockedExecutionOnce, sanitizeExecutionResponseForDelivery, sanitizeExecutionNotificationForDelivery } from "../cognition/execution_guard_recovery";
import { projectCustomerVisibleExecutionEvent } from './public_agent_event_projection';
import { buildSocketToolSecurityContext } from "./scope";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, consumePendingConfirmationDurably, getPendingConfirmationDurably, formatPendingConfirmationRequest, recordPendingConfirmationDurably } from "../tools/pending_confirmation";
import { buildPendingAssistantOfferContextFromTranscript } from '../cognition/pending_assistant_offer';
import { resolveUserTurn } from '../cognition/turn_resolution';
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation, runAfterAcceptedUserTurnAdmission } from './action_turn_durability';
import { flushDBOrThrow } from "../../db_layer";
import { isCapabilityMetaQuestion } from "../cognition/capability_meta";
import { hasClientActionOnlyIntent, hasExplicitToolIntent, isUserCorrectionOrExplanationQuestion } from "../cognition/tool_intent";
import { markVoiceLatencyMilestone, startVoiceLatencyTrace } from "../monitor/voice_latency_store";
import { emitVoiceWorkProgress, startVoiceWorkHeartbeat, stopVoiceWorkHeartbeat } from "./voice/work_progress";
import { detectRequestedOperationMode, isPureOperationModeSwitchRequest, type OperationMode } from "../cognition/operation_modes";
import { collectAnticipatoryContext } from "../context/anticipatory_context";
import { queryMemories } from "../memory/store";
import { CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory/types";
import { retrieveChunks } from "../agents/rag";
import { searchKnowledgeBase } from "../org/kb";
import { personalityRegistry } from "../personality";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { toolRegistry } from "../tools/registry";
import { TASK_TARGET_HISTORY_LIMIT } from '../conversation/task_target_anchor';
import { resolveVoiceModelInputBudget, VOICE_DESKTOP_LEASE_WAIT_MS } from './voice_runtime_policy';
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { commitChatTerminalBoundary, persistAuthorizedTerminalReceipt } from './chat_terminal_boundary';
import { resolveSingleVoiceTtsRoute, type LockedVoiceTurnTtsRoute, resolveVoiceForProvider, lockVoiceTurnTtsRoute, canFallbackVoiceTurnTtsRoute } from "./voice/selection";
import { emitVoiceTtsFailure, voiceTransportState, computeVolumeGain, resetSilenceTimer, enforceVoiceForegroundConvergenceBeforeRelease } from "./voice_transport_runtime";
import { addEchoText, voiceEchoScope } from "./voice/echo";
import { bindCapabilityExecutionPlanTask } from "../cognition/capability_execution_plan";
import { coalesceToolExecutionRecords, recordsToTaskReceipts, taskReceiptsToRecords, confirmedStepNeedsContinuation, toolRecordSucceeded } from "../cognition/task_execution_ledger";
import { ToolExecutionRecord } from "../tools/types";
import { executionBoundaryPromptOverlay, restrictSystemPromptForExecutionBoundary, restrictVisibleToolNamesForExecutionBoundary } from "../tools/remote_policy";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { formatCompactClientSelfPrompt } from "../client/self_model";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import { isExplicitMemoryRequest, persistTurnMemory, scheduleTurnMemory } from '../memory/turn_memory';
import { createConversationReceiptObserver } from '../conversation/execution_receipt_archive';
import { isDirectDesktopTool, createDesktopRelay } from "./desktop_relay";

import { buildDurableTaskDeterministicToolRecoveryCall } from '../cognition/deterministic_tool_recovery';
import { createTurnConfirmation } from '../tools/turn_confirmation';
import { createPreFinalizationTextGate, shouldDeferModelOutputUntilFinalized, shouldForwardPreFinalizationProgress } from "../cognition/response_delivery";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../personality/state";
import { buildConfirmedStepContinuationMessages, type LLMConfig, type LLMResult } from "../llm/adapter";
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import type { TTSProvider } from '../tts/types';
import { voiceProfileScope } from '../tts/profile_store';
import { extractFirstCompleteSpeechSentence } from "../tts/speculative_sentence";
import { createVoiceTerminalCompletion } from "./voice/terminal_completion";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../conversation/exact_correction";
import { executeToolCall } from "../tools/execution_engine";
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from "../cognition/result_finalizer";

import { recordTokenUsageBatch } from "../llm/token_tracker";
import { collectRecentActionToolRecords, describeRecentActionsFromHistory } from "./voice_action_history";
import { formatOperationModeSwitchResponse } from "../regions/messages/operation_mode_messages";
import { buildForegroundMessagingArguments, executeForegroundMessagingAction } from "../cognition/foreground_messaging_execution";
import { formatCnVoiceWeChatSendError, formatCnVoiceWeChatSendResult } from "../regions/messages/messaging_messages";
import { NormalizedMessage } from "../llm/providers";
import { normalizeVoiceHistory } from './voice_history';
import { runLumiTurn } from "../llm/lumi_turn";
import { createTurnResponseFinalizer } from '../cognition/turn_response_finalizer';
import { extractSentiment } from "../cognition/sentiment";
import { himTick } from "../personality/him";
import { shouldAllowVoiceLocalFileWriteForTurn, buildVoiceReplyStyleOverlay } from "./voice_turn_policy";

async function prepareVoiceIdentityAndAdmission(socket: Socket, session: AudioSession, userText: string, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, io: Server, userReceivedAt = new Date().toISOString(), voiceAuthorized = false, inputTiming: VoiceInputTiming = {}, resources: ConversationResourceLifetime = {}) {

  if (!voiceAuthorized && !isVoiceprintGateOpen(session)) {
    blockUnverifiedVoice(socket, session, 'Rejected voice command from unverified speaker');
    { return { terminal: true as const, context: undefined }; }
  }

  const turnAuthorization = session.authorization || captureChatAuthorization(session.userId, session);
  if (!turnAuthorization.isCurrent()) { return { terminal: true as const, context: undefined }; }
  let transcriptExecutionGuard = assessVoiceTranscriptForExecution(userText);
  if (transcriptExecutionGuard.action === 'clarify') {
    logger.warn(
      `[Audio] Guarded uncertain final transcript reason=${transcriptExecutionGuard.reason} chars=${userText.length}; no tool route will be admitted`,
    );
  }

  // Snapshot the whole TTS selection before any awaited work. A settings or
  // voice change received while this turn is planning/generating belongs to
  // the next assistant response and cannot split this one across speakers.
  const turnVoicePreference = getVoicePreference();
  const turnTtsSelection = Object.freeze({
    provider: getTTSProvider(),
    requestedVoiceId: session.currentVoiceId,
    switchGeneration: session.voiceSwitchGeneration,
    model: getConfiguredVoiceModel('tts', turnVoicePreference),
  });

  const pendingInterruptedTurn = session.pendingInterruptedTurn;
  const interruptedTurnAge = pendingInterruptedTurn
    ? Date.now() - pendingInterruptedTurn.interruptedAt
    : Number.POSITIVE_INFINITY;
  const interruptedActivityResponse = isVoiceCurrentActivityQuestion(userText)
    ? pendingInterruptedTurn
      && interruptedTurnAge >= 0
      && interruptedTurnAge <= 30_000
      ? CN_VOICE_FAST_PATH_MESSAGES.interruptedActivity(
          pendingInterruptedTurn.text.replace(/\s+/g, ' ').trim().slice(0, 60),
        )
      : CN_VOICE_FAST_PATH_MESSAGES.idleActivity
    : null;
  let interruptedMerge = mergeInterruptedVoiceTurn(pendingInterruptedTurn, userText);
  if (!interruptedMerge.usedInterruptedTurn && isVoiceCorrectionContinuation(userText)) {
    try {
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, session.domain, session.orgId);
      const priorAction = getMessagesByTokenBudget(conv.id)
        .slice(-16)
        .reverse()
        .find((record: any) => {
          if (record?.role !== 'user') return false;
          const priorText = String(record?.message || '').trim();
          return Boolean(priorText && buildForegroundWeChatSendArgs(priorText));
        });
      if (priorAction) {
        interruptedMerge = mergeInterruptedVoiceTurn({
          text: String((priorAction as any).message || ''),
          interruptedAt: new Date((priorAction as any).timestamp || 0).getTime(),
        }, userText, Date.now(), 120_000);
      }
    } catch {}
  }
  const actionIntentText = interruptedMerge.routingText || userText;
  if (interruptedMerge.usedInterruptedTurn) {
    logger.info(`[Audio] Applied correction to interrupted voice request: "${userText.slice(0, 80)}"`);
  }

  const conversationTurn = getOrCreateConversationForTurn(
    session.userId,
    session.agentId,
    session.domain,
    session.orgId,
    { userText: actionIntentText },
  );
  if (transcriptExecutionGuard.action === 'allow') {
    transcriptExecutionGuard = assessVoiceTranscriptForExecution(userText, {
      pendingAction: conversationTurn.conversation.actionContinuationState?.unfinished === true,
    });
  }
  try {
    await ensurePendingConfirmationPersistenceInitialized();
  } catch (error) {
    logger.error('[Audio] Encrypted confirmation store is unavailable:', error);
    socket.emit('agent:response', {
      text: voiceDurabilityUnknownText(),
      agentName: 'Lumi',
      source: 'voice',
      channel: 'voice',
      finalized: true,
      blocked: true,
      reason: 'persistence_unknown',
    });
    { return { terminal: true as const, context: undefined }; }
  }
  turnAuthorization.assertCurrent();
  const userObservedCompletion = isUserObservedTaskCompletion(
    actionIntentText,
    conversationTurn.conversation.actionContinuationState,
  );
  const userObservedCompletionTask = userObservedCompletion
    ? conversationTurn.conversation.actionContinuationState
    : null;
  if (conversationTurn.rolledOver) {
    logger.info(
      `[Audio] Rolled over oversized conversation ${conversationTurn.previousConversationId} -> ${conversationTurn.conversation.id}`,
    );
  }

  const requestId = `voice_${randomUUID()}`;
  const executionReceipts = createVoiceExecutionReceiptCollector(requestId);
  const voiceTurnProvenance = issueVoiceTurnProvenance(
    session.voiceCaptureProvenance,
    {
      requestId,
      chunkSequence: inputTiming.captureChunkSequence,
      sttProvider: inputTiming.sttProvider,
    },
  );
  session.activeTurnProvenance = voiceTurnProvenance;
  const pipelineAbort = new AbortController();
  const modelTurnState = createModelTurnState();
  let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
  const isCurrentTurn = () => turnAuthorization.isCurrent() && session.pipelineAbortController === pipelineAbort && !pipelineAbort.signal.aborted;
  let finalAgentResponseDelivered = false;
  const voiceScope = {
    domain: session.domain,
    orgId: session.orgId,
    orgRole: String(socket.data?.authenticatedOrgRole || '') || undefined,
  };
  const writeVoiceMessage = (message: Omit<Parameters<typeof addMessageIdempotent>[0],
    'userId' | 'agentId' | 'personality' | 'mode' | 'channel' | 'domain' | 'orgId'>) => addMessageIdempotent({
    ...message,
    userId: session.userId, agentId: session.agentId, personality: session.personalityId,
    mode: 'voice', channel: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId,
  });
  const executionScope: ChatExecutionScope = {
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    source: 'voice',
    conversationId: conversationTurn.conversation.id,
  };
  let trustedVoiceConfirmationText: string | undefined;
  const normalizeAgentPayload = (
    event: string,
    payload: Record<string, any> = {},
  ): Record<string, any> => {
    const sanitizedPayload: Record<string, any> = event === 'agent:response'
      ? sanitizeExecutionResponseForDelivery(payload, {
          task: actionIntentText,
          trustedConfirmationRequestText: trustedVoiceConfirmationText,
        })
      : event === 'agent:notification'
        ? sanitizeExecutionNotificationForDelivery(payload, { task: actionIntentText })
      : event === 'agent:error'
        ? sanitizeVoiceAgentErrorPayload()
        : payload;
    const publicPayload = projectCustomerVisibleExecutionEvent(event, sanitizedPayload, {
      taskText: actionIntentText,
    });
    return {
      ...publicPayload,
      source: publicPayload.source || 'voice',
      channel: publicPayload.channel || 'voice',
      requestId,
      conversationId: conversationTurn.conversation.id,
    };
  };
  const publishRecordedAgent = (event: string, payload: Record<string, any>) => {
    if (!turnAuthorization.isCurrent()) {
      if (!finalAgentResponseDelivered && (event === 'agent:error' || (event === 'agent:response' && payload.finalized))) {
        finalAgentResponseDelivered = true;
        socket.emit('agent:response', { text: CN_TASK_EXECUTION_MESSAGES.cancelled, source: 'voice', channel: 'voice', requestId, conversationId: conversationTurn.conversation.id, finalized: true, blocked: true, reason: 'cancelled' });
      }
      return;
    }
    socket.emit(event, payload);
    if (event === 'agent:response' && payload.finalized === true) {
      finalAgentResponseDelivered = true;
    }
  };
  const emitAgent = (event: string, payload: any = {}) => {
    if (!isCurrentTurn() || session.activeTurnRequestId !== requestId) return;
    const normalizedPayload = normalizeAgentPayload(event, payload);
    if (
      event === 'agent:error'
      || (event === 'agent:response' && normalizedPayload.finalized === true)
    ) {
      logger.error('[Audio] Rejected a terminal event outside the strict voice durability boundary');
      return false;
    }
    if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
    publishRecordedAgent(event, normalizedPayload);
    return true;
  };
  const executionUnknownPayload = normalizeAgentPayload('agent:response', {
    text: voiceDurabilityUnknownText(),
    agentName: 'Lumi',
    finalized: true,
    blocked: true,
    reason: 'persistence_unknown',
  });
  const toolSecurityContext = buildSocketToolSecurityContext(socket, voiceScope);
  const confirmationChannelScope = buildTransportNeutralConfirmationScope({
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    conversationId: conversationTurn.conversation.id,
  });
  let confirmationScope = buildTransportNeutralConfirmationScope({
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    conversationId: conversationTurn.conversation.id,
    taskId: conversationTurn.conversation.actionContinuationState?.taskId,
  });
  const voiceStateKey = getVoiceStateKey(session);
  let pendingConfirmation: Awaited<ReturnType<typeof getPendingConfirmationDurably>> = null;
  let pendingConfirmationPrompt = '';
  let recentVoiceHistory: any[] = [];
  let actionContinuationBridge = '';
  try {
    const conversation = conversationTurn.conversation;
    recentVoiceHistory = getMessages(conversation.id, 30);
    actionContinuationBridge = buildRecentActionContinuationBridge(
      actionIntentText,
      recentVoiceHistory,
      conversation.actionContinuationState,
      requestId,
    );
  } catch {}
  const pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
    messages: recentVoiceHistory,
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    conversationId: conversationTurn.conversation.id,
    taskId: conversationTurn.conversation.actionContinuationState?.taskId,
  });
  let voiceUserMessagePersisted = false;
  let voiceUserMessageId = '';
  const persistVoiceUserMessage = (cognitiveIntent = 'voice_received') => {
    if (voiceUserMessagePersisted) return voiceUserMessageId;
    voiceUserMessageId = writeVoiceMessage({
      conversationId: conversationTurn.conversation.id,
      role: 'user',
      content: userText,
      source: 'voice',
      cognitiveIntent,
      llmWasCalled: false,
      receivedAt: userReceivedAt,
      timestamp: userReceivedAt,
      requestId,
      ...(voiceTurnProvenance || {}),
      deferActionPreparation: true,
    });
    voiceUserMessagePersisted = true;
    return voiceUserMessageId;
  };
  // Once a verified final transcript is admitted to the execution lane it is
  // durable. Routing, model, tool, TTS, cancellation, or disconnect failures
  // may affect its result, but can no longer erase the user's instruction.
  const acceptedVoiceResolution = resolveUserTurn({requestId,userText,state:conversationTurn.conversation.actionContinuationState,options:{pendingAssistantOfferContext}});
  const voiceAdmission = await admitAcceptedUserTurnDurably({
    persistAcceptedUserTurn: () => persistVoiceUserMessage(),
    flush: flushDBOrThrow,
    onPersistenceUnknown: async error => {
      logger.error('[Audio] Accepted voice turn could not be flushed:', error);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: voiceDurabilityUnknownText(),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      try {
        await recordChatExecutionPersistenceUnknownDurably(executionScope, requestId, unknownPayload);
      } catch {}
      publishRecordedAgent('agent:response', unknownPayload);
    },
  });
  if (!voiceAdmission) {
    { return { terminal: true as const, context: undefined }; }
  }
  voiceUserMessageId = voiceAdmission.persisted;
  resources.admission = reserveConversationExecution({userId:session.userId,domain:voiceScope.domain,orgId:voiceScope.orgId,conversationId:conversationTurn.conversation.id,source:'voice'},requestId,pipelineAbort.signal);
  await resources.admission.waitForTurn();
  turnAuthorization.assertCurrent();
  conversationTurn.conversation = getConversationForScope(conversationTurn.conversation.id,session.userId,voiceScope.domain,voiceScope.orgId) || conversationTurn.conversation;
  if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
    await runAfterAcceptedUserTurnAdmission(voiceAdmission, () => (
      clearPendingConfirmationDurably(session.userId, buildTransportNeutralConfirmationScope({
        domain: session.domain,
        orgId: session.orgId,
        conversationId: conversationTurn.previousConversationId!,
      }))
    ));
  }
  const confirmationResolution = await resolveAcceptedTurnConfirmation({
    admission: voiceAdmission,
    userId: session.userId,
    userText,
    taskRelation:acceptedVoiceResolution.taskRelation,
    actionState: conversationTurn.conversation.actionContinuationState,
    taskScope: confirmationScope,
    channelScope: confirmationChannelScope,
  });
  pendingConfirmation = confirmationResolution.pending;
  pendingConfirmationPrompt = confirmationResolution.prompt;
  confirmationScope = confirmationResolution.scope;
  const correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

  try {
    const superseded = await runAfterAcceptedUserTurnAdmission(
      voiceAdmission,
      () => beginChatExecutionDurably(
        executionScope,
        requestId,
        executionUnknownPayload,
      ),
    );
    if (superseded?.terminalEvent) {
      publishRecordedAgent(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
  } catch (error) {
    logger.error('[Audio] Voice execution reservation could not be durably established:', error);
    publishRecordedAgent('agent:response', executionUnknownPayload);
    if (session.isActive) socket.emit('audio:status', { status: 'listening', requestId });
    { return { terminal: true as const, context: undefined }; }
  }
  return { terminal: false as const, context: {
    session: session as typeof session,
    get transcriptExecutionGuard(): typeof transcriptExecutionGuard { return transcriptExecutionGuard; },
    set transcriptExecutionGuard(value: typeof transcriptExecutionGuard) { transcriptExecutionGuard = value; },
    actionIntentText: actionIntentText as typeof actionIntentText,
    requestId: requestId as typeof requestId,
    inputTiming: inputTiming as typeof inputTiming,
    pipelineAbort: pipelineAbort as typeof pipelineAbort,
    userText: userText as typeof userText,
    executionReceipts: executionReceipts as typeof executionReceipts,
    turnAuthorization: turnAuthorization as typeof turnAuthorization,
    emitAgent: emitAgent as typeof emitAgent,
    socket: socket as typeof socket,
    get actionContinuationBridge(): typeof actionContinuationBridge { return actionContinuationBridge; },
    set actionContinuationBridge(value: typeof actionContinuationBridge) { actionContinuationBridge = value; },
    get pendingConfirmationPrompt(): typeof pendingConfirmationPrompt { return pendingConfirmationPrompt; },
    set pendingConfirmationPrompt(value: typeof pendingConfirmationPrompt) { pendingConfirmationPrompt = value; },
    voiceScope: voiceScope as typeof voiceScope,
    sensoryFn: sensoryFn as typeof sensoryFn,
    acceptedVoiceResolution: acceptedVoiceResolution as typeof acceptedVoiceResolution,
    toolSecurityContext: toolSecurityContext as typeof toolSecurityContext,
    conversationTurn: conversationTurn as typeof conversationTurn,
    pendingAssistantOfferContext: pendingAssistantOfferContext as typeof pendingAssistantOfferContext,
    userObservedCompletion: userObservedCompletion as typeof userObservedCompletion,
    get voiceUserMessageId(): typeof voiceUserMessageId { return voiceUserMessageId; },
    set voiceUserMessageId(value: typeof voiceUserMessageId) { voiceUserMessageId = value; },
    get pendingConfirmation(): typeof pendingConfirmation { return pendingConfirmation; },
    set pendingConfirmation(value: typeof pendingConfirmation) { pendingConfirmation = value; },
    get interruptedMerge(): typeof interruptedMerge { return interruptedMerge; },
    set interruptedMerge(value: typeof interruptedMerge) { interruptedMerge = value; },
    normalizeAgentPayload: normalizeAgentPayload as typeof normalizeAgentPayload,
    writeVoiceMessage: writeVoiceMessage as typeof writeVoiceMessage,
    voiceTurnProvenance: voiceTurnProvenance as typeof voiceTurnProvenance,
    executionScope: executionScope as typeof executionScope,
    executionUnknownPayload: executionUnknownPayload as typeof executionUnknownPayload,
    publishRecordedAgent: publishRecordedAgent as typeof publishRecordedAgent,
    isCurrentTurn: isCurrentTurn as typeof isCurrentTurn,
    get actionLeaseHeartbeat(): typeof actionLeaseHeartbeat { return actionLeaseHeartbeat; },
    set actionLeaseHeartbeat(value: typeof actionLeaseHeartbeat) { actionLeaseHeartbeat = value; },
    get confirmationScope(): typeof confirmationScope { return confirmationScope; },
    set confirmationScope(value: typeof confirmationScope) { confirmationScope = value; },
    llmGetters: llmGetters as typeof llmGetters,
    io: io as typeof io,
    confirmationResolution: confirmationResolution as typeof confirmationResolution,
    confirmationChannelScope: confirmationChannelScope as typeof confirmationChannelScope,
    correctionRequiresFreshConfirmation: correctionRequiresFreshConfirmation as typeof correctionRequiresFreshConfirmation,
    get trustedVoiceConfirmationText(): typeof trustedVoiceConfirmationText { return trustedVoiceConfirmationText; },
    set trustedVoiceConfirmationText(value: typeof trustedVoiceConfirmationText) { trustedVoiceConfirmationText = value; },
    voiceStateKey: voiceStateKey as typeof voiceStateKey,
    turnTtsSelection: turnTtsSelection as typeof turnTtsSelection,
    persistVoiceUserMessage: persistVoiceUserMessage as typeof persistVoiceUserMessage,
    resources: resources as typeof resources,
    get finalAgentResponseDelivered(): typeof finalAgentResponseDelivered { return finalAgentResponseDelivered; },
    set finalAgentResponseDelivered(value: typeof finalAgentResponseDelivered) { finalAgentResponseDelivered = value; },
    get recentVoiceHistory(): typeof recentVoiceHistory { return recentVoiceHistory; },
    set recentVoiceHistory(value: typeof recentVoiceHistory) { recentVoiceHistory = value; },
    userObservedCompletionTask: userObservedCompletionTask as typeof userObservedCompletionTask,
    modelTurnState: modelTurnState as typeof modelTurnState,
    interruptedActivityResponse: interruptedActivityResponse as typeof interruptedActivityResponse,
  } };
}

async function prepareVoiceContextAndRouting(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceIdentityAndAdmission>>["context"]>) {


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
    const convForTopic = getOrCreateActiveConversation(context.session.userId, context.session.agentId, context.voiceScope.domain, context.voiceScope.orgId);
    if (wantsHistoricalVoiceContext) {
      const summary = getConversationSummary(convForTopic.id);
      if (summary) topicContext += `\n\n## Conversation Context\n${summary}`;
      const tc = getTopicContext(convForTopic.id);
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
  const actionTaskExecution = turnFlow.conceptualCapabilityQuestion
    || context.transcriptExecutionGuard.action === 'clarify'
    ? { state: null, kind: 'conversation' as const }
    : context.userObservedCompletion
    ? {
        state: null,
        kind: 'conversation' as const,
      }
    : prepareConversationActionExecution({
        conversationId: context.conversationTurn.conversation.id,
        userId: context.session.userId,
        userText: context.actionIntentText,
        requestId: context.requestId,
        userMessageId: context.voiceUserMessageId,
        toolPolicy: routedToolPolicy,
        followupIntent: actionFollowupIntent,
        forceTask: toolSessionActive,
        forceResume: Boolean(
          context.pendingConfirmation
          || context.interruptedMerge.usedInterruptedTurn
          || executionPipeline.trustedActionContinuation
        ),
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
    actionTaskExecution: actionTaskExecution as typeof actionTaskExecution,
    executionPipeline: executionPipeline as typeof executionPipeline,
    toolSessionActive: toolSessionActive as typeof toolSessionActive,
    executionDecision: executionDecision as typeof executionDecision,
    operationMode: operationMode as typeof operationMode,
    effectiveOperationMode: effectiveOperationMode as typeof effectiveOperationMode,
    turnFlow: turnFlow as typeof turnFlow,
    clientActionOnlyTurn: clientActionOnlyTurn as typeof clientActionOnlyTurn,
    selfRepairTurn: selfRepairTurn as typeof selfRepairTurn,
    capabilitySelection: capabilitySelection as typeof capabilitySelection,
    intentTrace: intentTrace as typeof intentTrace,
    visibleToolRoute: visibleToolRoute as typeof visibleToolRoute,
    desktopExecutionPolicy: desktopExecutionPolicy as typeof desktopExecutionPolicy,
    workSurfaceRoute: workSurfaceRoute as typeof workSurfaceRoute,
    visionIntent: visionIntent as typeof visionIntent,
    routedUserText: routedUserText as typeof routedUserText,
    baseVoiceOverlay: baseVoiceOverlay as typeof baseVoiceOverlay,
    turnDispatch: turnDispatch as typeof turnDispatch,
    get voiceOrganizationKnowledge(): typeof voiceOrganizationKnowledge { return voiceOrganizationKnowledge; },
    set voiceOrganizationKnowledge(value: typeof voiceOrganizationKnowledge) { voiceOrganizationKnowledge = value; },
    fullPersonalityPrompt: fullPersonalityPrompt as typeof fullPersonalityPrompt,
    get topicContext(): typeof topicContext { return topicContext; },
    set topicContext(value: typeof topicContext) { topicContext = value; },
    routedToolPolicy: routedToolPolicy as typeof routedToolPolicy,
    allowLocalFileWrites: allowLocalFileWrites as typeof allowLocalFileWrites,
    localWriteIntentReason: localWriteIntentReason as typeof localWriteIntentReason,
    modelToolProjection: modelToolProjection as typeof modelToolProjection,
    desktopExecutionTracker: desktopExecutionTracker as typeof desktopExecutionTracker,
    actionFollowupIntent: actionFollowupIntent as typeof actionFollowupIntent,
    voiceInputTokenBudget: voiceInputTokenBudget as typeof voiceInputTokenBudget,
    requestedMode: requestedMode as typeof requestedMode,
  }) };
}

async function prepareVoiceExecutionAndPrompt(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceContextAndRouting>>["context"]>) {

  // Every accepted voice turn owns a durable request identity, including
  // conceptual/taskless turns. Without it, an exception in one of those paths
  // could release the voice/desktop lane without a terminal audit record.
  const foregroundRequestIdentity: VoiceForegroundRequestIdentity = Object.freeze({
    conversationId: context.conversationTurn.conversation.id,
    userId: context.session.userId,
    requestId: context.requestId,
    ...(context.actionTaskExecution.state?.taskId
      ? { expectedTaskId: context.actionTaskExecution.state.taskId }
      : {}),
  });
  context.session.activeForegroundRequestIdentity = foregroundRequestIdentity;
  context.executionReceipts.bindTask(foregroundRequestIdentity.expectedTaskId);
  context.actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({
    conversationId: context.conversationTurn.conversation.id,
    userId: context.session.userId,
    requestId: context.requestId,
    abortController: context.pipelineAbort,
    onPersistenceUnknown: async () => {
      const recorded = await recordChatExecutionPersistenceUnknownDurably(
        context.executionScope,
        context.requestId,
        context.executionUnknownPayload,
      );
      if (recorded) context.publishRecordedAgent('agent:response', context.executionUnknownPayload);
    },
  });
  if (context.actionTaskExecution.state?.taskId) {
    context.executionPipeline.executionPlan = bindCapabilityExecutionPlanTask(
      context.executionPipeline.executionPlan,
      context.actionTaskExecution.state.taskId,
    );
    persistConversationExecutionPlan({
      conversationId: context.conversationTurn.conversation.id,
      userId: context.session.userId,
      plan: context.executionPipeline.executionPlan,
    });
  }
  if (context.actionTaskExecution.kind === 'new') {
    // A concrete replacement task invalidates an older confirmation boundary
    // on this exact voice channel.
    await clearPendingConfirmationDurably(context.session.userId, context.confirmationScope);
  }
  if (
    context.actionTaskExecution.state?.taskId
    && (context.actionTaskExecution.kind === 'new' || context.actionTaskExecution.kind === 'resume')
  ) {
    context.session.activeTaskConversationId = context.conversationTurn.conversation.id;
    context.session.activeTaskRequestId = context.requestId;
    context.session.activeTaskId = context.actionTaskExecution.state.taskId;
    try {
      updateConversationActionFocus({
        taskId: context.actionTaskExecution.state.taskId,
        userId: context.session.userId,
        domain: context.session.domain,
        orgId: context.session.orgId,
        commitment: context.actionTaskExecution.state.goal,
        nextAction: context.actionIntentText,
        resumePoint: context.actionTaskExecution.kind === 'resume'
          ? context.actionTaskExecution.state.assistantState || context.actionTaskExecution.state.latestBlocker || ''
          : '',
      });
    } catch {}
  }
  const priorTaskRecords = context.actionTaskExecution.kind === 'resume'
    ? taskReceiptsToRecords(context.actionTaskExecution.state?.receipts || [])
    : [];
  const taskAwareRecords = (records: ToolExecutionRecord[]) => (
    coalesceToolExecutionRecords([...priorTaskRecords, ...records])
  );
  if (
    context.toolSessionActive
    && (context.actionTaskExecution.kind === 'new' || context.actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(
      context.conversationTurn.conversation.id,
      context.session.userId,
      'executing',
      { requestId: context.requestId },
    );
  }
  const remoteRestricted = context.toolSecurityContext.executionBoundary === 'remote_restricted';
  logger.info(`[Audio] tool gate: ${context.executionDecision.allowToolUse ? 'authorized' : 'off'} session=${context.toolSessionActive ? 'active' : 'conversation'} mode=${context.operationMode} effective=${context.effectiveOperationMode} surface=${context.turnFlow.surface} clientActionOnly=${context.clientActionOnlyTurn} selfRepair=${context.selfRepairTurn} capabilityLane=${context.capabilitySelection.lane} trace=${context.intentTrace.summary} route=${context.visibleToolRoute ? `${context.visibleToolRoute.toolNames.length}/${context.visibleToolRoute.totalAvailable}` : 'none'}`);
  context.emitAgent('agent:intent_trace', context.intentTrace);
  if (context.visibleToolRoute) {
    context.emitAgent('agent:tool_route', {
      categories: context.visibleToolRoute.categories,
      reasons: context.visibleToolRoute.reasons,
      toolNames: context.visibleToolRoute.toolNames,
      totalAvailable: context.visibleToolRoute.totalAvailable,
      truncated: context.visibleToolRoute.truncated,
      source: 'voice',
      trace: context.intentTrace,
    });
  }
  const visiblePreferredTools = restrictVisibleToolNamesForExecutionBoundary(
    context.capabilitySelection.preferredTools,
    context.toolSecurityContext.executionBoundary,
  );
  context.emitAgent('agent:capability_selection', {
    lane: remoteRestricted
      ? (visiblePreferredTools.length > 0 ? 'web_or_account' : 'conversation')
      : context.capabilitySelection.lane,
    primary: remoteRestricted
      ? (visiblePreferredTools[0] || 'conversation')
      : context.capabilitySelection.primary,
    reasons: remoteRestricted
      ? ['remote execution boundary applied']
      : context.capabilitySelection.reasons,
    preferredTools: visiblePreferredTools,
    source: 'voice',
  });
  if (context.desktopExecutionPolicy.applies && context.toolSecurityContext.executionBoundary !== 'remote_restricted') {
    context.emitAgent('agent:desktop_execution_policy', {
      reason: context.desktopExecutionPolicy.reason,
      evidenceTools: context.desktopExecutionPolicy.evidenceTools,
      actuationTools: context.desktopExecutionPolicy.actuationTools,
      verificationTools: context.desktopExecutionPolicy.verificationTools,
      source: 'voice',
    });
  }
  const needsExecutionPrompt = context.toolSessionActive && !remoteRestricted;
  const opModeOverlay = remoteRestricted ? '' : '\n\n' + buildInteractionModeOverlay(context.turnFlow);
  const workSurfaceOverlay = context.workSurfaceRoute.promptOverlay && needsExecutionPrompt ? '\n\n' + context.workSurfaceRoute.promptOverlay : '';
  const visionRoutingOverlay = context.visionIntent && context.effectiveOperationMode !== 'meeting' && needsExecutionPrompt ? '\n\n' + buildVisionRoutingOverlay(context.session.userId, context.routedUserText) : '';
  const interactionOverlay = remoteRestricted
    ? context.baseVoiceOverlay
    : context.toolSessionActive
      ? context.baseVoiceOverlay + '\n\n## Interaction Mode\nThis turn has an authorized execution plan. Use only the declarations provided for this request, keep spoken progress brief, and do not claim completion without a verified receipt.'
      : context.baseVoiceOverlay + '\n\n## Interaction Mode\nThis turn is conversational. Do not call tools, operate the desktop, or claim that you are taking actions. Answer naturally unless the user gives an explicit command.';

  const clientSelfPrompt = !remoteRestricted && (needsExecutionPrompt || isCapabilityMetaQuestion(context.actionIntentText))
    ? '\n\n' + formatCompactClientSelfPrompt(context.session.userId, context.voiceScope)
    : '';
  const dispatchOverlay = needsExecutionPrompt ? '\n\n' + context.turnDispatch.promptOverlay : '';
  const executionOverlay = needsExecutionPrompt || remoteRestricted
    ? '\n\n' + executionBoundaryPromptOverlay(
        context.executionDecision.promptOverlay,
        context.toolSecurityContext.executionBoundary,
      )
    : '';
  const capabilitySelectionOverlay = needsExecutionPrompt ? '\n\n' + context.capabilitySelection.promptOverlay : '';
  const desktopExecutionOverlay = context.desktopExecutionPolicy.promptOverlay && needsExecutionPrompt ? '\n\n' + context.desktopExecutionPolicy.promptOverlay : '';
  const turnFlowOverlay = remoteRestricted ? '' : '\n\n' + context.turnFlow.promptOverlay;
  const runtimeCapabilityOverlay = needsExecutionPrompt
    ? '\n\n' + buildLumiRuntimeCapabilityContext({
        userId: context.session.userId,
        text: context.turnFlow.routeText,
        flow: context.turnFlow,
        toolRegistry,
        domain: context.voiceScope.domain,
        orgId: context.voiceScope.orgId,
      })
    : '';
  const operatingKernelOverlay = needsExecutionPrompt
    ? '\n\n' + buildLumiOperatingKernelPrompt({
        channel: 'voice',
        flow: context.turnFlow,
      })
    : '';
  const actionContinuationOverlay = context.actionContinuationBridge ? `\n\n${context.actionContinuationBridge}` : '';
  const pendingConfirmationOverlay = context.pendingConfirmationPrompt ? `\n\n${context.pendingConfirmationPrompt}` : '';
  const organizationKnowledgeOverlay = context.voiceOrganizationKnowledge
    ? `\n\n## Company Knowledge Base\n${context.voiceOrganizationKnowledge}\n\nUse this authorized organization knowledge when relevant and cite article titles when referencing it.`
    : '';
  const voiceSystemPrompt = restrictSystemPromptForExecutionBoundary(
    context.fullPersonalityPrompt,
    context.toolSecurityContext.executionBoundary,
  ) + interactionOverlay + opModeOverlay + workSurfaceOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + actionContinuationOverlay + pendingConfirmationOverlay + clientSelfPrompt + context.topicContext + organizationKnowledgeOverlay + dispatchOverlay + turnFlowOverlay + executionOverlay + capabilitySelectionOverlay + desktopExecutionOverlay + runtimeCapabilityOverlay + operatingKernelOverlay;

  const userLLMPrefs = getScopedPreferredLLM(context.session.userId, context.voiceScope);
  const provider = userLLMPrefs.provider || 'deepseek';
  const voiceModel = userLLMPrefs.model;
  const reasoningRoutePolicy = {
    selectionMode: userLLMPrefs.selectionMode,
    fallbackCandidates: userLLMPrefs.fallbackCandidates,
    allowCloudFallback: userLLMPrefs.allowCloudFallback,
    conversationId: context.conversationTurn.conversation.id,
    requestId: context.requestId,
    ...(context.voiceTurnProvenance || {}),
    interactionId: context.requestId,
    source: 'voice',
  };
  return { terminal: false as const, context: extendTurnBindings(context, {
    provider: provider as typeof provider,
    voiceModel: voiceModel as typeof voiceModel,
    reasoningRoutePolicy: reasoningRoutePolicy as typeof reasoningRoutePolicy,
    foregroundRequestIdentity: foregroundRequestIdentity as typeof foregroundRequestIdentity,
    taskAwareRecords: taskAwareRecords as typeof taskAwareRecords,
    voiceSystemPrompt: voiceSystemPrompt as typeof voiceSystemPrompt,
  }) };
}

async function prepareVoiceReceiptsAndTools(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceExecutionAndPrompt>>["context"]>) {

  const scheduleVoiceSummary = (conversationId: string) => {
    if (!context.turnAuthorization.isCurrent()) return;
    scheduleConversationSummary({
      isAuthorized: context.turnAuthorization.isCurrent,
      userId: context.session.userId,
      provider: context.provider,
      model: context.voiceModel,
      ...context.reasoningRoutePolicy,
      conversationId,
      source: 'voice_summary',
      domain: context.voiceScope.domain,
      orgId: context.voiceScope.orgId,
      llmGetters: context.llmGetters,
      log: {
        info: message => logger.info(message),
        warn: (message, error) => logger.warn(message, error),
      },
    });
  };
  let voiceAssistantMessagePersisted = false;
  let voiceAssistantMessageId = '';
  const persistVoiceAssistantMessage = (
    conversationId: string,
    text: string,
    options: {
      toolCalls?: ToolExecutionRecord[];
      cognitiveIntent?: string;
      llmWasCalled?: boolean;
      source?: string;
      terminalTaskDisposition?: {
        outcome: 'blocked';
        taskId: string;
        requestId: string;
        reason: string;
      };
    } = {},
  ): string => {
    if (voiceAssistantMessagePersisted || !String(text || '').trim()) {
      return voiceAssistantMessageId;
    }
    voiceAssistantMessageId = context.writeVoiceMessage({
      conversationId,
      role: 'assistant',
      content: text,
      source: options.source || 'voice',
      toolCalls: options.toolCalls?.length ? options.toolCalls : undefined,
      cognitiveIntent: options.cognitiveIntent || 'voice_response',
      llmWasCalled: options.llmWasCalled === true,
      requestId: context.requestId,
      ...(context.voiceTurnProvenance || {}),
      taskIntent: context.toolSessionActive ? 'task' : 'conversation',
      terminalTaskDisposition: options.terminalTaskDisposition,
    });
    voiceAssistantMessagePersisted = true;
    return voiceAssistantMessageId;
  };
  const persistSidecarConversation = (conversationId: string) => {
    const history = context.session.sidecarHistory.splice(0);
    for (const [index, item] of history.entries()) {
      if (!item.persist) continue;
      const sidecarRequestId = `${context.requestId}:sidecar:${index}`;
      context.writeVoiceMessage({
        conversationId,
        role: 'user',
        content: item.userText,
        source: 'voice_sidecar',
        cognitiveIntent: item.cognitiveIntent,
        llmWasCalled: false,
        receivedAt: item.userReceivedAt,
        timestamp: item.userReceivedAt,
        requestId: sidecarRequestId,
        skipActionContinuation: true,
      });
      context.writeVoiceMessage({
        conversationId,
        role: 'assistant',
        content: item.responseText,
        source: 'voice_sidecar',
        cognitiveIntent: item.cognitiveIntent,
        llmWasCalled: item.llmWasCalled,
        receivedAt: item.responseAt,
        timestamp: item.responseAt,
        requestId: sidecarRequestId,
        skipActionContinuation: true,
      });
    }
  };

  const maxIterations = context.toolSessionActive
    ? Math.max(1, context.routedToolPolicy.maxIterations || 1)
    : 1;
  const toolResultPreviewLimit = 500;
  const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
  const emitToolLifecycle = (payload: {
    correlationId: string;
    name: string;
    arguments: Record<string, any>;
    result?: string;
    error?: string;
  }) => {
    if (context.session.isBackgroundWork) {
      context.session.activeWorkStatus = 'executing';
      context.session.activeWorkStep = payload.error !== undefined
        ? `${payload.name} failed`
        : payload.result !== undefined
          ? `${payload.name} completed`
          : `Running ${payload.name}`;
      if (payload.result !== undefined || payload.error !== undefined) context.session.activeWorkToolCalls++;
      emitVoiceWorkProgress(
        context.socket,
        context.session,
        context.requestId,
        payload.error !== undefined
          ? 'blocked'
          : payload.result !== undefined
            ? 'step_completed'
            : 'executing',
      );
    }
    const normalized = { ...payload, args: payload.arguments, source: 'voice' };
    context.emitAgent("agent:tool_call", normalized);
    context.emitAgent("agent:tool", normalized);
  };

  const receiptObserver = createConversationReceiptObserver({
    userId: context.session.userId, conversationId: context.conversationTurn.conversation.id,
    taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId, turnRowId: context.actionTaskExecution.turnRowId, ...context.voiceScope,
  }, context.turnAuthorization.isCurrent);
  const desktopRelay = createDesktopRelay({
    io: context.io,
    userId: context.session.userId,
    domain: context.voiceScope.domain,
    orgId: context.voiceScope.orgId,
    source: 'voice',
    taskId: context.actionTaskExecution.state?.taskId,
    requestId: context.requestId,
    requestSocket: context.socket,
    emitToolLifecycle,
    onLateResult: receiptObserver.onDesktopLateResult,
    formatResultForLifecycle: formatToolResultForUi,
    cancelOnRequestSocketDisconnect: true,
    signal: context.pipelineAbort.signal,
    leaseTimeoutMs: VOICE_DESKTOP_LEASE_WAIT_MS,
  });

  const runtimeOwnedDeterministicRecoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
    context.actionTaskExecution.state,
    context.requestId,
    context.confirmationResolution.revokedCorrectionBasis,
  );
  let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
  const requestConfirmation = createTurnConfirmation({
    userId: context.session.userId, source: 'voice', requestId: context.requestId, actionIntent: context.actionIntentText,
    autoApprovalIntent: context.routedUserText,
    pending: context.pendingConfirmation,
    consumeScope: () => context.confirmationScope,
    proposalScope: () => ({ ...context.confirmationChannelScope, taskId: context.actionTaskExecution.state?.taskId }),
    correctionRequiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
    exactWriteCorrection: context.correctionRequiresFreshConfirmation && context.confirmationResolution.revokedCorrectionBasis?.toolName === 'write_file',
    recoveryCall: () => runtimeOwnedDeterministicRecoveryCall,
    isCancelled: () => context.pipelineAbort.signal.aborted,
    onPending: pending => {
      pendingConfirmationCreatedThisTurn = pending;
      context.trustedVoiceConfirmationText = formatPendingConfirmationRequest(pending);
      setConversationActionExecutionStatus(context.conversationTurn.conversation.id, context.session.userId, 'waiting_confirmation', {
        assistantState: context.trustedVoiceConfirmationText, requestId: context.requestId,
      });
    },
  });

  const toolContext = {
    ...context.toolSecurityContext,
    currentTurnExecutionRequested: context.executionPipeline.executionRequested,
    resolutionId: context.executionPipeline.resolution.id,
    trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
    acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
            currentAppTarget: context.turnFlow.currentAppEditTarget,
    userId: context.session.userId,
    taskId: context.actionTaskExecution.state?.taskId,
    conversationId: context.conversationTurn.conversation.id,
    turnId: context.requestId,
    turnRowId: context.actionTaskExecution.turnRowId,
    requestId: context.requestId,
    domain: context.voiceScope.domain,
    orgId: context.voiceScope.orgId,
    desktopRelay,
    llmGetters: context.llmGetters,
    taskRevision: context.actionTaskExecution.state?.revision,
    source: 'voice',
    supervisedExternalCommits: true,
    allowLocalFileWrites: context.allowLocalFileWrites,
    localWriteIntentReason: context.localWriteIntentReason,
    actionIntent: context.actionIntentText,
    routedTaskText: context.turnFlow.routeText,
    ...(context.effectiveOperationMode === 'assistant' || context.effectiveOperationMode === 'autonomous' || context.clientActionOnlyTurn || context.selfRepairTurn ? { requestConfirmation } : {}),
    executionSignal: context.pipelineAbort?.signal,
    isCancelled: () => !context.isCurrentTurn(),
    onToolStart: context.executionReceipts.onToolStart,
    onToolRecord: (record: ToolExecutionRecord) => {
      context.executionReceipts.onToolRecord(record);
      receiptObserver.onToolRecord(record);
    },
    onToolFinished: context.executionReceipts.onToolFinished,
    onProgress: (step: string) => {
      if (!context.isCurrentTurn()) return;
      if (context.session.isBackgroundWork && step.trim()) {
        context.session.activeWorkStatus = 'executing';
        context.session.activeWorkStep = step.trim().slice(0, 160);
        emitVoiceWorkProgress(context.socket, context.session, context.requestId, 'executing');
      }
      if (shouldForwardPreFinalizationProgress(step)) {
        context.emitAgent("agent:progress", { text: step, agentName: "Lumi" });
      }
    },
    toolPolicy: context.routedToolPolicy,
    modelToolProjection: context.modelToolProjection,
    desktopExecutionTracker: context.desktopExecutionTracker,
  };
  const observeVoiceTools = (onRecord?: (record: ToolExecutionRecord) => void) => createToolLifecycleCallbacks({
    emit: emitToolLifecycle, correlationPrefix: 'voice-tool', formatResult: formatToolResultForUi,
    isCurrent: context.isCurrentTurn, onStart: toolContext.onToolStart, onRecord,
  });
  const turnEmotionState = (() => {
    try { return loadEmotionalState(context.voiceStateKey); } catch { return undefined; }
  })();
  let responseText = '';
  let completionGuard: LLMResult['completionGuard'];
  let toolResults: ToolExecutionRecord[] = [];
  const persistVoiceLearning = (
    assistantText: string,
    options: {
      channel?: 'voice' | 'workflow';
      toolRecords?: ToolExecutionRecord[];
      sourceInteractionId?: string;
      logLabel?: string;
    } = {},
  ) => {
    if (!context.turnAuthorization.isCurrent()) return;
    persistLumiPostTurnLearning(
      {
        userId: context.session.userId,
        userText: context.userText,
        defaultChannel: 'voice',
        flow: context.turnFlow,
        getToolNames: () => toolRegistry.getToolDeclarations({
          context: { userId: context.session.userId, domain: context.voiceScope.domain, orgId: context.voiceScope.orgId, source: 'voice' },
        }).map(declaration => declaration.function.name),
        domain: context.voiceScope.domain,
        orgId: context.voiceScope.orgId,
        defaultSourceInteractionId: `voice_${Date.now()}`,
        agentId: context.session.agentId,
        log: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
      },
      assistantText,
      options,
    );
  };
  const persistVoiceTakeoverExecution = (
    assistantText: string,
    options: {
      toolRecords?: ToolExecutionRecord[];
      source?: string;
      sourceInteractionId?: string;
      finalizationBlocked?: boolean;
      assistantTextTrusted?: boolean;
      finalizationReason?: string;
    } = {},
  ) => {
    const currentToolRecords = options.toolRecords || [];
    // History explanations may carry old tool receipts for finalization, but
    // only a ledger produced by this turn is eligible for task writeback.
    if (currentToolRecords.length === 0) return null;
    const executionWriteback = persistWorkTakeoverTurnExecution({
      userId: context.session.userId,
      userText: context.actionIntentText,
      assistantText,
      source: options.source || 'voice',
      interactionId: options.sourceInteractionId || `voice_${Date.now()}`,
      domain: context.voiceScope.domain,
      orgId: context.voiceScope.orgId,
      flow: context.turnFlow,
      capabilitySelection: context.capabilitySelection,
      toolRecords: currentToolRecords,
      finalizationBlocked: options.finalizationBlocked === true,
      assistantTextTrusted: options.assistantTextTrusted
        ?? options.finalizationBlocked !== true,
      finalizationReason: options.finalizationReason,
    });
    return executionWriteback;
  };
  const ttsPromises: Promise<void>[] = [];
  const deferCompletionSpeech = shouldDeferModelOutputUntilFinalized({
    taskText: context.actionIntentText,
    allowToolUse: context.toolSessionActive,
    flow: context.turnFlow,
  });
  const modelTextGate = createPreFinalizationTextGate();
  return { terminal: false as const, context: extendTurnBindings(context, {
    turnEmotionState: turnEmotionState as typeof turnEmotionState,
    deferCompletionSpeech: deferCompletionSpeech as typeof deferCompletionSpeech,
    get responseText(): typeof responseText { return responseText; },
    set responseText(value: typeof responseText) { responseText = value; },
    ttsPromises: ttsPromises as typeof ttsPromises,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    persistSidecarConversation: persistSidecarConversation as typeof persistSidecarConversation,
    persistVoiceAssistantMessage: persistVoiceAssistantMessage as typeof persistVoiceAssistantMessage,
    scheduleVoiceSummary: scheduleVoiceSummary as typeof scheduleVoiceSummary,
    desktopRelay: desktopRelay as typeof desktopRelay,
    emitToolLifecycle: emitToolLifecycle as typeof emitToolLifecycle,
    toolContext: toolContext as typeof toolContext,
    formatToolResultForUi: formatToolResultForUi as typeof formatToolResultForUi,
    observeVoiceTools: observeVoiceTools as typeof observeVoiceTools,
    get completionGuard(): typeof completionGuard { return completionGuard; },
    set completionGuard(value: typeof completionGuard) { completionGuard = value; },
    persistVoiceLearning: persistVoiceLearning as typeof persistVoiceLearning,
    persistVoiceTakeoverExecution: persistVoiceTakeoverExecution as typeof persistVoiceTakeoverExecution,
    modelTextGate: modelTextGate as typeof modelTextGate,
    get toolResults(): typeof toolResults { return toolResults; },
    set toolResults(value: typeof toolResults) { toolResults = value; },
    maxIterations: maxIterations as typeof maxIterations,
    runtimeOwnedDeterministicRecoveryCall: runtimeOwnedDeterministicRecoveryCall as typeof runtimeOwnedDeterministicRecoveryCall,
  }) };
}

async function prepareVoiceSpeech(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceReceiptsAndTools>>["context"]>) {


  // ── Generation gating: only latest command gets TTS output ──
  context.session.bgGeneration++;
  let turnSpeechGeneration = -1;
  let turnSpeechAbort: AbortController | null = null;
  let ttsQueue: Promise<void> = Promise.resolve();
  type SynthesizedSpeech = Awaited<ReturnType<typeof synthesizeSpeech>> & { ttsRequestedAt: number; ttsReadyAt: number };
  let lockedTurnTtsRoute: LockedVoiceTurnTtsRoute | null | undefined;
  let lockedTurnTtsRoutePromise: Promise<LockedVoiceTurnTtsRoute | null> | null = null;
  let turnTtsEmittedSegments = 0;
  let turnTtsFallbackAttempted = false;
  let turnTtsUnavailable = false;

  const resolveLockedRoute = async (
    provider: TTSProvider,
    requestedVoiceId: string | null,
  ): Promise<LockedVoiceTurnTtsRoute | null> => {
    const voiceResolution = await resolveVoiceForProvider(
      voiceProfileScope(context.session.userId, context.session.domain, context.session.orgId),
      provider,
      requestedVoiceId,
    );
    if (!voiceResolution.voiceId) return null;
    const emotionVoice = resolveEmotionVoice(voiceResolution.voiceId, context.turnEmotionState);
    return lockVoiceTurnTtsRoute({
      provider,
      voiceId: emotionVoice.voiceId,
      ...(provider === 'relay' && context.turnTtsSelection.model ? { model: context.turnTtsSelection.model } : {}),
      ...(emotionVoice.speechRate !== undefined ? { speechRate: emotionVoice.speechRate } : {}),
      ...(emotionVoice.pitch !== undefined ? { pitch: emotionVoice.pitch } : {}),
      ...(emotionVoice.volume !== undefined ? { volume: emotionVoice.volume } : {}),
    });
  };

  const getLockedTurnTtsRoute = (): Promise<LockedVoiceTurnTtsRoute | null> => {
    if (lockedTurnTtsRoute !== undefined) return Promise.resolve(lockedTurnTtsRoute);
    if (lockedTurnTtsRoutePromise) return lockedTurnTtsRoutePromise;
    lockedTurnTtsRoutePromise = (async () => {
      if (!context.turnTtsSelection.provider || !context.turnTtsSelection.requestedVoiceId) return null;
      const route = await resolveLockedRoute(
        context.turnTtsSelection.provider,
        context.turnTtsSelection.requestedVoiceId,
      );
      // Reconcile the server selection for future turns, but never overwrite a
      // newer explicit switch that arrived while this route was resolving.
      if (
        route
        && route.voiceId !== context.turnTtsSelection.requestedVoiceId
        && context.session.voiceSwitchGeneration === context.turnTtsSelection.switchGeneration
        && context.session.currentVoiceId === context.turnTtsSelection.requestedVoiceId
      ) {
        const previousVoiceId = context.session.currentVoiceId;
        context.session.currentVoiceId = route.voiceId;
        context.session.voiceSwitchGeneration += 1;
        context.socket.emit('audio:voice_changed', {
          voiceId: route.voiceId,
          previousVoiceId,
          sessionId: context.session.sessionId,
          provider: route.provider,
          fallback: true,
          reason: 'provider_compatibility',
        });
      }
      return route;
    })().then(route => {
      lockedTurnTtsRoute = route;
      lockedTurnTtsRoutePromise = null;
      return route;
    }, error => {
      lockedTurnTtsRoutePromise = null;
      throw error;
    });
    return lockedTurnTtsRoutePromise;
  };

  const tryLockTurnTtsFallback = async (
    failedRoute: LockedVoiceTurnTtsRoute,
    error: unknown,
    signal: AbortSignal,
  ): Promise<LockedVoiceTurnTtsRoute | null> => {
    if (!canFallbackVoiceTurnTtsRoute({
      emittedSegments: turnTtsEmittedSegments,
      fallbackAttempted: turnTtsFallbackAttempted,
      error,
      signal,
    })) return null;
    turnTtsFallbackAttempted = true;
    const fallbackProvider = getTTSFallbackProvider(failedRoute.provider, { requireWarmLocal: true });
    if (!fallbackProvider || fallbackProvider === failedRoute.provider) return null;
    const fallbackRoute = await resolveLockedRoute(
      fallbackProvider,
      context.turnTtsSelection.requestedVoiceId,
    );
    if (!fallbackRoute) return null;
    lockedTurnTtsRoute = fallbackRoute;
    logger.warn(
      `[Audio TTS] Primary route failed before playback; locked request=${context.requestId} fallback=${fallbackRoute.provider} voice=${fallbackRoute.voiceId}`,
    );
    return fallbackRoute;
  };

  const synthesizeOnRoute = async (
    text: string,
    route: LockedVoiceTurnTtsRoute,
    signal: AbortSignal,
  ) => {
    context.turnAuthorization.assertCurrent();
    const ttsRequestedAt = Date.now();
    const result = await synthesizeSpeech(text, {
      provider: route.provider,
      voiceId: route.voiceId,
      model: route.model,
      speechRate: route.speechRate,
      pitch: route.pitch,
      volume: route.volume,
      signal,
      allowFallback: false,
    });
    return { ...result, ttsRequestedAt, ttsReadyAt: Date.now() };
  };

  let speculativeSpeech: {
    text: string;
    requestedAt: number;
    controller: AbortController;
    promise: Promise<{ result?: SynthesizedSpeech; route?: LockedVoiceTurnTtsRoute; error?: unknown }>;
  } | null = null;

  const ensureTurnSpeechController = () => {
    if (
      !turnSpeechAbort
      || turnSpeechAbort.signal.aborted
      || turnSpeechGeneration !== context.session.bgGeneration
    ) {
      if (context.session.ttsAbortController && context.session.ttsAbortController !== turnSpeechAbort) {
        context.session.ttsAbortController.abort();
      }
      turnSpeechAbort = new AbortController();
      turnSpeechGeneration = context.session.bgGeneration;
      context.session.ttsAbortController = turnSpeechAbort;
    }
    return { controller: turnSpeechAbort, generation: turnSpeechGeneration };
  };

  const estimatePlaybackMs = (audioBuffer: Buffer, text: string): number => {
    const fallback = Math.min(18000, Math.max(2200, text.length * 185 + 700));
    try {
      if (
        Buffer.isBuffer(audioBuffer) &&
        audioBuffer.length > 44 &&
        audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
        audioBuffer.toString('ascii', 8, 12) === 'WAVE'
      ) {
        const byteRate = audioBuffer.readUInt32LE(28);
        let offset = 12;
        while (offset + 8 <= audioBuffer.length) {
          const chunkId = audioBuffer.toString('ascii', offset, offset + 4);
          const chunkSize = audioBuffer.readUInt32LE(offset + 4);
          if (chunkId === 'data' && byteRate > 0) {
            return Math.min(30000, Math.max(1000, Math.round(chunkSize / byteRate * 1000) + 450));
          }
          offset += 8 + chunkSize + (chunkSize % 2);
        }
      }
    } catch {}
    return fallback;
  };

  const maybeStartSpeculativeSpeech = () => {
    if (
      speculativeSpeech
      || context.toolSessionActive
      || context.deferCompletionSpeech
      || !context.turnTtsSelection.provider
      || !context.turnTtsSelection.requestedVoiceId
      || context.pipelineAbort?.signal.aborted
    ) return;
    const firstSentence = extractFirstCompleteSpeechSentence(context.responseText);
    if (!firstSentence) return;
    const controller = new AbortController();
    context.pipelineAbort?.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const promise = getLockedTurnTtsRoute()
      .then(async route => {
        if (!route) return { error: new Error('No compatible TTS route is available') };
        const result = await synthesizeOnRoute(firstSentence, route, controller.signal);
        return { result, route };
      })
      .catch(error => ({ error }));
    speculativeSpeech = {
      text: firstSentence,
      requestedAt: Date.now(),
      controller,
      promise,
    };
  };

  const synthesizeWithLockedTurnRoute = async (
    text: string,
    signal: AbortSignal,
    preparedFailure?: { route?: LockedVoiceTurnTtsRoute; error: unknown; requestedAt?: number },
  ): Promise<{ result: SynthesizedSpeech; route: LockedVoiceTurnTtsRoute }> => {
    const ttsRequestedAt = preparedFailure?.requestedAt ?? Date.now();
    let route = preparedFailure?.route || await getLockedTurnTtsRoute();
    if (!route) throw preparedFailure?.error || new Error('No compatible TTS route is available');

    if (preparedFailure) {
      const fallback = await tryLockTurnTtsFallback(route, preparedFailure.error, signal);
      if (!fallback) throw preparedFailure.error;
      route = fallback;
    }

    try {
      return { result: { ...await synthesizeOnRoute(text, route, signal), ttsRequestedAt }, route };
    } catch (error) {
      const fallback = await tryLockTurnTtsFallback(route, error, signal);
      if (!fallback) throw error;
      return { result: { ...await synthesizeOnRoute(text, fallback, signal), ttsRequestedAt }, route: fallback };
    }
  };

  const flushSentence = (sentence: string): Promise<number> => {
    const txt = sentence.trim();
    if (!txt || txt.length <= 1 || turnTtsUnavailable || !context.session.isActive || context.session.suppressedSpeechRequestIds.has(context.requestId)) return Promise.resolve(0);
    if (!/[a-zA-Z一-鿿㐀-䶿\d]/.test(txt)) return Promise.resolve(0);
    const speech = ensureTurnSpeechController();
    if (!context.isCurrentTurn() || speech.controller.signal.aborted) return Promise.resolve(0);
    let resolvePlayback: (value: number) => void = () => {};
    const playbackDone = new Promise<number>(resolve => { resolvePlayback = resolve; });
    // Serialize TTS to avoid 429 rate limits
    ttsQueue = ttsQueue.then(async () => {
      if (!context.isCurrentTurn() || speech.controller.signal.aborted) {
        resolvePlayback(0);
        return;
      }
      if (context.session.bgGeneration !== speech.generation) {
        resolvePlayback(0);
        return;
      }
      if (turnTtsUnavailable) {
        resolvePlayback(0);
        return;
      }
      context.session.isSpeaking = true;
      voiceTransportState.ttsSpeakingCount++;
      try {
        const initialRoute = await getLockedTurnTtsRoute();
        if (!initialRoute) {
          turnTtsUnavailable = true;
          logger.warn('[Audio TTS] No configured healthy provider; delivering text and reporting the unavailable audio lane');
          emitVoiceTtsFailure(context.socket, context.requestId, 'conversation');
          resolvePlayback(0);
          return;
        }
        let synthesized: { result: SynthesizedSpeech; route: LockedVoiceTurnTtsRoute };
        if (speculativeSpeech?.text === txt) {
          const prepared = await speculativeSpeech.promise;
          if (prepared.result && prepared.route === initialRoute) {
            synthesized = { result: prepared.result, route: prepared.route };
          } else {
            synthesized = await synthesizeWithLockedTurnRoute(
              txt,
              speech.controller.signal,
              { route: prepared.route || initialRoute, error: prepared.error || new Error('Speculative TTS route changed'), requestedAt: speculativeSpeech.requestedAt },
            );
          }
          speculativeSpeech = null;
        } else {
          if (speculativeSpeech) {
            speculativeSpeech.controller.abort();
            speculativeSpeech = null;
          }
          synthesized = await synthesizeWithLockedTurnRoute(txt, speech.controller.signal);
        }
        if (context.isCurrentTurn() && !speech.controller.signal.aborted && context.session.bgGeneration === speech.generation) {
          // Only the audio segment actually accepted for playback owns these
          // timestamps. Discarded speculative speech is not a delivery metric.
          markVoiceLatencyMilestone(context.requestId, 'firstTtsRequestedAt', synthesized.result.ttsRequestedAt);
          markVoiceLatencyMilestone(context.requestId, 'firstTtsReadyAt', synthesized.result.ttsReadyAt);
          context.socket.emit("audio:status", { status: "speaking", requestId: context.requestId });
          addEchoText(txt, voiceEchoScope(context.session));
          const volumeGain = computeVolumeGain();
          context.socket.emit("audio:response", {
            buffer: synthesized.result.audioBuffer,
            format: synthesized.result.format,
            volumeGain,
            requestId: context.requestId,
            lane: 'conversation',
          });
          turnTtsEmittedSegments += 1;
          logger.info(
            `[Audio TTS] Emitted request=${context.requestId} provider=${synthesized.route.provider} voice=${synthesized.route.voiceId} bytes=${synthesized.result.audioBuffer.length}`,
          );
          const playbackMs = estimatePlaybackMs(synthesized.result.audioBuffer, txt);
          setTimeout(() => resolvePlayback(0), playbackMs);
        } else {
          resolvePlayback(0);
        }
      } catch (e: any) {
        if (isTtsCancellationError(e, speech.controller.signal)) {
          resolvePlayback(0);
          return;
        }
        logger.warn(`[Audio TTS] ${e.message?.slice(0, 80)}`);
        turnTtsUnavailable = true;
        emitVoiceTtsFailure(context.socket, context.requestId, 'conversation');
        resolvePlayback(0);
      } finally {
        if (context.session.bgGeneration === speech.generation) context.session.isSpeaking = false;
        // Keep voiceTransportState.ttsSpeakingCount elevated for 3s after synthesis — client playback continues
        const decay = () => { voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1); };
        const t = setTimeout(decay, 3000);
        context.session.ttsDecayTimers.push(t);
      }
    });
    context.ttsPromises.push(ttsQueue);
    return playbackDone;
  };

  const queueFinalizedSpeech = (text: string) => {
    if (!context.isCurrentTurn()) return;
    if (context.session.isBackgroundWork) {
      context.session.activeWorkStatus = context.pendingConfirmationCreatedThisTurn
        ? 'waiting_confirmation'
        : 'completed';
    }
    if (context.session.suppressedSpeechRequestIds.has(context.requestId)) return;
    context.session.bgGeneration++;
    const sentences = String(text || '').split(/(?<=[。！？.!?\n])/u);
    const firstFinalSentence = String(sentences[0] || '').trim();
    if (speculativeSpeech && speculativeSpeech.text !== firstFinalSentence) {
      speculativeSpeech.controller.abort();
      speculativeSpeech = null;
    }
    for (const sentence of sentences) {
      if (context.pipelineAbort?.signal.aborted) break;
      flushSentence(sentence);
    }
  };
  return { terminal: false as const, context: extendTurnBindings(context, {
    queueFinalizedSpeech: queueFinalizedSpeech as typeof queueFinalizedSpeech,
    get speculativeSpeech(): typeof speculativeSpeech { return speculativeSpeech; },
    set speculativeSpeech(value: typeof speculativeSpeech) { speculativeSpeech = value; },
    get turnSpeechAbort(): typeof turnSpeechAbort { return turnSpeechAbort; },
    set turnSpeechAbort(value: typeof turnSpeechAbort) { turnSpeechAbort = value; },
    maybeStartSpeculativeSpeech: maybeStartSpeculativeSpeech as typeof maybeStartSpeculativeSpeech,
  }) };
}

async function prepareVoiceRelease(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceSpeech>>["context"]>) {


  const commitVoiceTerminal = async <T = unknown>(input: {
    text: string;
    source: string;
    blocked: boolean;
    reason?: string;
    cognitiveIntent: string;
    llmWasCalled: boolean;
    toolCalls?: ToolExecutionRecord[];
    speechText?: string;
    notification?: Record<string, any>;
    persistTerminalState?: () => T;
    publishAfter?: (terminalState: T | undefined) => void;
  }): Promise<boolean> => {
    // An interrupted/superseded turn no longer owns persistence, publication,
    // or speech. Its cancellation terminal is committed by the transport
    // handler against the captured request identity instead.
    if (!context.isCurrentTurn()) return false;
    if (context.actionLeaseHeartbeat?.isLeaseLost()) {
      await context.actionLeaseHeartbeat.leaseLoss;
      return false;
    }
    const terminalPayload = context.normalizeAgentPayload('agent:response', {
      text: input.text,
      agentName: 'Lumi',
      source: input.source,
      finalized: true,
      blocked: input.blocked,
      reason: input.reason || '',
    });
    const committed = await commitChatTerminalBoundary<T | undefined>({
      persistTerminalState: () => {
        if (!context.isCurrentTurn()) throw Object.assign(new Error('Voice turn superseded'), { name: 'AbortError' });
        context.persistVoiceUserMessage(input.cognitiveIntent);
        context.persistSidecarConversation(context.conversationTurn.conversation.id);
        return input.persistTerminalState?.();
      },
      persistAssistantMessage: () => {
        if (!context.isCurrentTurn()) throw Object.assign(new Error('Voice turn superseded'), { name: 'AbortError' });
        // Keep the request lease alive until the assistant row has consumed
        // the terminal tool receipts. Settling it first clears the pending
        // turn and makes the durable transcript lose the very evidence needed
        // to complete the task.
        const assistantMessageId = context.persistVoiceAssistantMessage(
          context.conversationTurn.conversation.id,
          input.text,
          {
            toolCalls: input.toolCalls,
            cognitiveIntent: input.cognitiveIntent,
            llmWasCalled: input.llmWasCalled,
            source: input.source,
            terminalTaskDisposition: input.blocked && context.foregroundRequestIdentity?.expectedTaskId
              ? {
                  outcome: 'blocked',
                  taskId: context.foregroundRequestIdentity.expectedTaskId,
                  requestId: context.requestId,
                  reason: input.reason || 'Voice terminal response reported a blocked execution.',
                }
              : undefined,
          },
        );
        return assistantMessageId;
      },
      flush: flushDBOrThrow,
      persistTerminalReceipt: () => persistAuthorizedTerminalReceipt({ scope: context.executionScope, requestId: context.requestId,
        event: 'agent:response', payload: terminalPayload, unknownPayload: context.executionUnknownPayload,
        authorization: context.turnAuthorization, channel: 'voice', flush: flushDBOrThrow }),
      persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
        context.executionScope,
        context.requestId,
        context.executionUnknownPayload,
      ),
      publishCommitted: terminalState => {
        if (!context.turnAuthorization.isCurrent()) { context.publishRecordedAgent('agent:response', terminalPayload); return; }
        if (!context.isCurrentTurn()) return;
        if (input.notification) {
          context.publishRecordedAgent(
            'agent:notification',
            context.normalizeAgentPayload('agent:notification', input.notification),
          );
        }
        const executionWriteback = terminalState as any;
        if (executionWriteback?.recorded) {
          context.publishRecordedAgent(
            'agent:task_execution_writeback',
            context.normalizeAgentPayload('agent:task_execution_writeback', executionWriteback),
          );
        }
        context.publishRecordedAgent('agent:response', terminalPayload);
        context.socket.emit('chat:conversation_updated', {
          conversationId: context.conversationTurn.conversation.id,
          agentId: context.session.agentId,
          source: input.source,
          requestId: context.requestId,
        });
        context.scheduleVoiceSummary(context.conversationTurn.conversation.id);
        if (String(input.speechText || '').trim()) context.queueFinalizedSpeech(input.speechText!);
        input.publishAfter?.(terminalState);
      },
      publishUnknown: () => {
        context.publishRecordedAgent('agent:response', context.executionUnknownPayload);
      },
      persistenceUnknownProjection: {
        text: context.executionUnknownPayload.text,
        completionFeedback: context.executionUnknownPayload.completionFeedback,
        reason: 'Terminal persistence outcome is unknown.',
      },
      onPersistenceError: error => {
        logger.error(`[Audio] ${input.source} terminal persistence failed:`, error);
      },
    });
    if (committed && !terminalPayload.blocked && context.turnAuthorization.isCurrent()) scheduleTurnMemory({
      userId: context.session.userId, domain: context.voiceScope.domain, orgId: context.voiceScope.orgId, userText: context.userText,
      channel: 'voice', source: 'voice', requestId: context.requestId, conversationId: context.conversationTurn.conversation.id,
      agentId: context.session.agentId, authorization: context.turnAuthorization, llmGetters: context.llmGetters,
    });
    return committed;
  };

  const releaseVoiceTransportResources = (): void => {
    context.resources.admission?.release();
    context.actionLeaseHeartbeat?.stop();
    context.speculativeSpeech?.controller.abort();
    context.speculativeSpeech = null;
    context.desktopRelay.releaseControlLease('voice_turn_complete');

    // An older aborted pipeline must never clear state/controllers that already
    // belong to a newer barge-in turn.
    if (context.session.pipelineAbortController !== context.pipelineAbort) return;
    if (
      context.session.activeTaskConversationId
      && context.session.activeTaskRequestId === context.requestId
    ) {
      context.session.activeTaskConversationId = null;
      context.session.activeTaskRequestId = null;
      context.session.activeTaskId = null;
    }
    if (context.session.activeForegroundRequestIdentity?.requestId === context.requestId) {
      context.session.activeForegroundRequestIdentity = null;
    }
    context.session.sidecarAbortController?.abort();
    context.session.sidecarAbortController = null;
    context.session.sidecarGeneration++;
    context.session.sidecarHistory = [];
    context.session.isSpeaking = false;
    context.session.isProcessing = false;
    context.session.isBackgroundWork = false;
    context.session.activeWorkStatus = 'idle';
    context.session.activeWorkStep = '';
    context.session.activeWorkToolCalls = 0;
    stopVoiceWorkHeartbeat(context.session);
    if (context.session.ttsAbortController === context.turnSpeechAbort) context.session.ttsAbortController = null;
    context.session.pipelineAbortController = null;
    context.session.activeTurnText = '';
    context.session.activeRoutingText = '';

    if (context.session.isActive) {
      resetSilenceTimer(context.session, context.socket);
      context.socket.emit('audio:status', { status: 'listening', requestId: context.requestId });
      context.emitAgent('agent:status', { status: 'idle' });
    }
    context.session.activeTurnRequestId = null;
    context.session.activeTurnProvenance = null;
    context.session.suppressedSpeechRequestIds.delete(context.requestId);
  };
  const voiceReleaseGate = createDurableForegroundReleaseGate({
    converge: async reason => {
      // The cancellation owner must consume completed/in-flight tool receipts
      // before this old pipeline can settle its task or release the lease.
      if (context.executionReceipts.cancellation) await context.executionReceipts.cancellation;
      // Durable ownership always converges before any heartbeat, desktop lease,
      // or mutable voice work lane is released. This remains safe for an older
      // aborted pipeline because the immutable identity is local to this turn.
      const releaseResult = await enforceVoiceForegroundConvergenceBeforeRelease({
        identity: context.foregroundRequestIdentity,
        aborted: context.pipelineAbort.signal.aborted,
        reason,
        assistantState: context.finalAgentResponseDelivered ? context.responseText : undefined,
      });
      return Boolean(releaseResult?.converged);
    },
    releaseResources: releaseVoiceTransportResources,
    onRecoveryTakeover: ({ attempts }) => logger.error('[Audio] voice_foreground_release_recovery_takeover', {
      code: 'VOICE_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
      identity: context.foregroundRequestIdentity,
      attempts,
    }),
  });
  context.resources.ownedByDurableRelease = true;
  const releaseVoiceTurnResources = (
    reason = 'Voice turn reached its release boundary.',
  ): Promise<boolean> => {
    const cancel = !context.turnAuthorization.isCurrent() && !context.finalAgentResponseDelivered
      ? context.session.cancelAuthorizationTurn?.(context.requestId)
      : undefined;
    return Promise.resolve(cancel).then(() => voiceReleaseGate.release(reason));
  };

  const finishVoiceTerminal = createVoiceTerminalCompletion({
    commit: commitVoiceTerminal,
    drainSpeech: () => Promise.allSettled(context.ttsPromises),
    isCurrent: context.isCurrentTurn,
  });
  return { terminal: false as const, context: extendTurnBindings(context, {
    finishVoiceTerminal: finishVoiceTerminal as typeof finishVoiceTerminal,
    releaseVoiceTurnResources: releaseVoiceTurnResources as typeof releaseVoiceTurnResources,
  }) };
}

async function executeVoiceConfirmedAndDeterministicTurn(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceRelease>>["context"]>) {

    if (context.transcriptExecutionGuard.action === 'clarify') {
      // Resolve uncertain STT before confirmation, meeting control, or tools.
      context.responseText = context.transcriptExecutionGuard.responseText;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_transcript_guard',
        blocked: false,
        reason: context.transcriptExecutionGuard.reason,
        cognitiveIntent: 'voice_transcript_clarification',
        llmWasCalled: false,
        speechText: context.responseText,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (!context.session.agentId?.startsWith('memory_avatar_') && isExplicitMemoryRequest(context.userText)) {
        const receipt = await persistTurnMemory({ userId: context.session.userId, domain: context.voiceScope.domain, orgId: context.voiceScope.orgId,
          userText: context.userText, channel: 'voice', source: 'voice', requestId: context.requestId, conversationId: context.conversationTurn.conversation.id,
          agentId: context.session.agentId, authorization: context.turnAuthorization, signal: context.pipelineAbort.signal, llmGetters: context.llmGetters });
        context.responseText = receipt.text;
        await context.finishVoiceTerminal({ text: receipt.text, speechText: receipt.text, source: 'voice_memory',
          blocked: receipt.status === 'failed', reason: receipt.status === 'saved' ? 'memory_saved' : 'memory_not_saved',
          cognitiveIntent: 'memory', llmWasCalled: true, toolCalls: [] });
      { return { terminal: true as const, context: undefined }; }
    }

    const deterministicConversationResponse = (() => {
      if (context.userObservedCompletion) return null;
      if (isConversationExecutionFactQuestion(context.actionIntentText)) {
        return {
          text: formatConversationExecutionFactAnswer(getConversationExecutionFacts({
            conversationId: context.conversationTurn.conversation.id,
            userId: context.session.userId,
            domain: context.voiceScope.domain,
            orgId: context.voiceScope.orgId,
            currentRequestId: context.requestId,
            taskId: context.actionTaskExecution.state?.taskId
              || context.conversationTurn.conversation.actionContinuationState?.taskId
              || undefined,
          }), context.actionIntentText),
          intent: 'execution_facts',
          source: 'voice_conversation_execution_facts',
        };
      }
      const corrected = resolveExactConversationCorrection(context.actionIntentText, context.recentVoiceHistory);
      return corrected
        ? { text: corrected, intent: 'exact_correction', source: 'voice_exact_correction' }
        : null;
    })();
    if (deterministicConversationResponse) {
      context.responseText = deterministicConversationResponse.text;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: deterministicConversationResponse.source,
        blocked: false,
        reason: deterministicConversationResponse.intent,
        cognitiveIntent: deterministicConversationResponse.intent,
        llmWasCalled: false,
        speechText: context.responseText,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (context.userObservedCompletion) {
      const conversation = context.conversationTurn.conversation;
      const observedTask = context.userObservedCompletionTask!;
      await clearPendingConfirmationDurably(context.session.userId, buildTransportNeutralConfirmationScope({
        domain: context.voiceScope.domain, orgId: context.voiceScope.orgId,
        conversationId: conversation.id, taskId: observedTask.taskId,
      }));
      context.pendingConfirmation = null;
      context.pendingConfirmationPrompt = '';
      context.responseText = formatConversationActionTaskStatus({
        ...observedTask, status: 'completed', unfinished: false,
        latestBlocker: '', completionSource: 'user_observation',
      });
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_task_user_observation',
        blocked: false,
        reason: '',
        cognitiveIntent: 'task_user_observation',
        llmWasCalled: false,
        speechText: context.responseText,
        persistTerminalState: () => {
          const completed = completeConversationActionFromUserObservation(
            conversation.id, context.session.userId, context.userText,
            { taskId: observedTask.taskId!, requestId: context.requestId, userMessageId: context.voiceUserMessageId },
          );
          if (!completed) throw new Error('User observation no longer owns the pending task');
          return completed;
        },
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (context.actionFollowupIntent === 'status') {
      context.responseText = getConversationActionStatus(
        context.conversationTurn.conversation.id,
        context.session.userId,
        context.actionIntentText,
        context.conversationTurn.conversation.actionContinuationState,
      );
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_task_status',
        blocked: false,
        reason: '',
        cognitiveIntent: 'task_status',
        llmWasCalled: false,
        speechText: context.responseText,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    // A short confirmation utterance is a continuation of the exact pending
    // action, not a fresh chat turn. Execute the stored tool/arguments directly
    // so the model cannot forget, rewrite, or merely print the tool protocol.
    if (context.pendingConfirmation) {
      const confirmedTask = context.pendingConfirmation.actionIntent || context.actionIntentText;
      const confirmedArgs = context.pendingConfirmation.exactArgs || {};
      const confirmationConsumed = await consumePendingConfirmationDurably(
        context.session.userId,
        context.pendingConfirmation.id,
        context.pendingConfirmation.toolName,
        confirmedArgs,
        context.confirmationScope,
      );
      const confirmationRecordId =
        `voice-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      context.session.isBackgroundWork = true;
      context.session.activeWorkStatus = 'executing';
      context.session.activeWorkStep = `Running ${context.pendingConfirmation.toolName}`;
      if (!isDirectDesktopTool(context.pendingConfirmation.toolName)) {
        context.emitToolLifecycle({
          correlationId: confirmationRecordId,
          name: context.pendingConfirmation.toolName,
          arguments: confirmedArgs,
        });
      }
      const confirmationRecord = await executeToolCall({
        registry: toolRegistry,
        id: confirmationRecordId,
        name: context.pendingConfirmation.toolName,
        arguments: confirmedArgs,
        context: {
          ...context.toolContext,
          toolPolicy: context.routedToolPolicy,
          userConfirmed: true,
          requestConfirmation: undefined,
          actionIntent: confirmedTask,
          routedTaskText: confirmedTask,
        },
        preflight: () => confirmationConsumed
          ? { allowed: true, arguments: confirmedArgs }
          : {
              allowed: false,
              arguments: confirmedArgs,
              reason: 'The one-time confirmation expired before execution.',
            },
      });
      if (!context.isCurrentTurn()) {
        { return { terminal: true as const, context: undefined }; }
      }
      if (!isDirectDesktopTool(confirmationRecord.name)) {
        if (confirmationRecord.error) {
          context.emitToolLifecycle({
            correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
            name: confirmationRecord.name,
            arguments: confirmedArgs,
            error: confirmationRecord.error,
          });
        } else {
          context.emitToolLifecycle({
            correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
            name: confirmationRecord.name,
            arguments: confirmedArgs,
            result: context.formatToolResultForUi(confirmationRecord.result),
          });
        }
      }
      const confirmationSucceeded = toolRecordSucceeded(confirmationRecord);
      confirmationRecord.executionOrigin = 'confirmed_action_resume';
      let confirmationRecords: ToolExecutionRecord[] = [confirmationRecord];
      let confirmationLlmWasCalled = false;
      const completedConfirmedAction = tryFinalizeVerifiedBoundedAction({
        taskText: confirmedTask,
        responseText: '',
        toolRecords: context.taskAwareRecords([confirmationRecord]),
        source: 'voice_confirmation',
        flow: { ...context.turnFlow, routeText: confirmedTask },
        taskId: context.actionTaskExecution.state?.taskId,
        requestId: context.requestId,
      });
      let confirmationCandidate = completedConfirmedAction?.text || (confirmationSucceeded
        ? CN_VOICE_FAST_PATH_MESSAGES.confirmationExecuted
        : CN_VOICE_FAST_PATH_MESSAGES.confirmationFailed(
            recordsToTaskReceipts([confirmationRecord])[0]?.error
              || confirmationRecord.error
              || confirmationRecord.result,
          ));

      if (!completedConfirmedAction && confirmedStepNeedsContinuation(confirmedTask, context.taskAwareRecords([confirmationRecord])) && context.isCurrentTurn()) {
        // Confirmation is a boundary inside the same task, not the end of the
        // task. Continue the remaining plan immediately with the exact confirmed
        // receipt in context; a later hard boundary will stop once again.
        context.turnAuthorization.assertCurrent();
        const continuation = await runLumiTurn({
          messages: [
            { role: 'system', content: context.voiceSystemPrompt },
            ...buildConfirmedStepContinuationMessages(confirmedTask, confirmationRecord, {
              messageId: context.voiceUserMessageId,
              text: context.userText,
            }),
          ],
          registry: toolRegistry,
          config: {
            provider: context.provider,
            model: context.voiceModel,
            modelTurnState: context.modelTurnState,
            userId: context.session.userId,
            domain: context.voiceScope.domain,
            orgId: context.voiceScope.orgId,
            signal: context.pipelineAbort.signal,
            inputTokenBudget: context.voiceInputTokenBudget,
            ...context.reasoningRoutePolicy,
          },
          onToolCall: context.observeVoiceTools().onToolCall,
          maxIterations: Math.max(1, context.routedToolPolicy.maxIterations || 5),
          context: {
            ...context.toolContext,
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
            toolPolicy: context.routedToolPolicy,
            priorToolRecords: context.taskAwareRecords([confirmationRecord]),
          },
          getters: context.llmGetters,
        });
        if (!context.isCurrentTurn()) {
          { return { terminal: true as const, context: undefined }; }
        }
        confirmationRecords = coalesceToolExecutionRecords([confirmationRecord, ...(continuation.toolCalls || [])]);
        confirmationLlmWasCalled = continuation.usageRecords.length > 0;
        recordTokenUsageBatch(context.session.userId, continuation.usageRecords, context.requestId, 'voice');
        context.completionGuard = continuation.completionGuard;
        confirmationCandidate = context.pendingConfirmationCreatedThisTurn
          ? context.trustedVoiceConfirmationText!
          : continuation.text || confirmationCandidate;
      }
      confirmationRecords = withDesktopExecutionReceipt(confirmationRecords, context.desktopExecutionTracker);
      const confirmedFinal = context.pendingConfirmationCreatedThisTurn
        ? {
            text: context.trustedVoiceConfirmationText!,
            blocked: false,
            reason: 'waiting_confirmation',
            notification: undefined,
          }
        : finalizeLumiResponse({
            taskText: confirmedTask,
            responseText: confirmationCandidate,
            completionGuard: context.completionGuard,
            toolRecords: context.taskAwareRecords(confirmationRecords),
            source: 'voice_confirmation',
            flow: { ...context.turnFlow, routeText: confirmedTask },
            taskId: context.actionTaskExecution.state?.taskId,
            requestId: context.requestId,
          });
      context.responseText = confirmedFinal.text;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_confirmation',
        blocked: confirmedFinal.blocked,
        reason: confirmedFinal.reason || '',
        cognitiveIntent: confirmedFinal.blocked ? 'work_product_guard' : 'confirmation',
        llmWasCalled: confirmationLlmWasCalled,
        toolCalls: confirmationRecords,
        speechText: context.responseText,
        notification: confirmedFinal.notification,
      }, {
        onCommitted: () => {
          context.persistVoiceLearning(context.responseText, {
            toolRecords: confirmationRecords,
            sourceInteractionId: `voice_confirmation_${Date.now()}`,
            logLabel: 'voice confirmation',
          });
        },
      });
      { return { terminal: true as const, context: undefined }; }
    }

    let recentActionExplanation: string | null = context.interruptedActivityResponse;
    let recentActionEvidence: ToolExecutionRecord[] = [];
    try {
      const conversation = getOrCreateActiveConversation(context.session.userId, context.session.agentId, context.voiceScope.domain, context.voiceScope.orgId);
      const recentActionHistory = context.recentVoiceHistory.length > 0
        ? context.recentVoiceHistory
        : getMessages(conversation.id, 30);
      recentActionEvidence = collectRecentActionToolRecords(recentActionHistory);
      if (!recentActionExplanation) {
        recentActionExplanation = describeRecentActionsFromHistory(context.userText, recentActionHistory);
      }
    } catch {}
    if (recentActionExplanation) {
      const finalizedRecentAction = finalizeLumiResponse({
        taskText: context.actionIntentText,
        responseText: recentActionExplanation,
        toolRecords: recentActionEvidence,
        source: 'voice_action_history',
        flow: context.turnFlow,
      });
      context.responseText = finalizedRecentAction.text;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_action_history',
        blocked: finalizedRecentAction.blocked,
        reason: finalizedRecentAction.reason || '',
        cognitiveIntent: finalizedRecentAction.blocked ? 'work_product_guard' : 'action_history',
        llmWasCalled: false,
        speechText: context.responseText,
        notification: finalizedRecentAction.notification,
      }, {
        onCommitted: () => {
          context.persistVoiceLearning(context.responseText, {
            sourceInteractionId: `voice_action_history_${Date.now()}`,
            logLabel: 'voice action history explanation',
          });
        },
      });
      { return { terminal: true as const, context: undefined }; }
    }
  return { terminal: false as const, context };
}

async function executeVoiceModeAndMessagingTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceConfirmedAndDeterministicTurn>>["context"]>) {


    // Explicit meeting control keeps its immediate client acknowledgement.
    const directlyAppliedMode: OperationMode | null = context.requestedMode === 'meeting' ? 'meeting' : null;
    if (directlyAppliedMode) {
      const modeToolRecord: ToolExecutionRecord = {
        id: `voice-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'client_action',
        arguments: {
          action: 'start_meeting_mode',
          mode: directlyAppliedMode,
          confirmed: true,
        },
        result: '',
      };
      try {
        modeToolRecord.result = await context.desktopRelay('client_action', modeToolRecord.arguments)
          || JSON.stringify({ ok: false, error: 'Client returned no mode-switch receipt' });
      } catch (err: any) {
        modeToolRecord.error = err?.message || String(err);
        context.emitAgent('agent:notification', {
          type: 'client_action',
          level: 'warning',
          message: `Mode switch did not reach the client: ${err?.message || err}`,
        });
      }
      if (!context.isCurrentTurn()) {
        { return { terminal: true as const, context: undefined }; }
      }
      const modeSynced = toolRecordSucceeded(modeToolRecord);
      if (modeSynced) {
        saveStoredOperationMode(context.session.userId, directlyAppliedMode);
      }

      if (isPureOperationModeSwitchRequest(context.userText, context.requestedMode)) {
        context.responseText = formatOperationModeSwitchResponse(directlyAppliedMode, modeSynced, context.userText);
        const finalizedMode = finalizeLumiResponse({
          taskText: context.actionIntentText,
          responseText: context.responseText,
          toolRecords: [modeToolRecord],
          source: 'voice',
          flow: context.turnFlow,
          taskId: context.actionTaskExecution.state?.taskId,
          requestId: context.requestId,
        });
        context.responseText = finalizedMode.text;
        await context.finishVoiceTerminal({
          text: context.responseText,
          source: "voice_mode",
          blocked: finalizedMode.blocked,
          reason: finalizedMode.reason || '',
          cognitiveIntent: finalizedMode.blocked ? 'work_product_guard' : 'operation_mode',
          llmWasCalled: false,
          toolCalls: [modeToolRecord],
          speechText: context.responseText,
          notification: finalizedMode.notification,
          persistTerminalState: () => context.persistVoiceTakeoverExecution(context.responseText, {
            toolRecords: [modeToolRecord],
            source: 'voice_mode',
            sourceInteractionId: `voice_mode_${Date.now()}`,
            finalizationBlocked: finalizedMode.blocked,
            assistantTextTrusted: !finalizedMode.blocked,
            finalizationReason: finalizedMode.reason,
          }),
        }, {
          onCommitted: () => {
            context.persistVoiceLearning(context.responseText, {
              toolRecords: [modeToolRecord],
              sourceInteractionId: `voice_mode_${Date.now()}`,
              logLabel: 'voice mode switch',
            });
          },
        });
        { return { terminal: true as const, context: undefined }; }
      }
    }

    const foregroundWeChatReadArgs = buildForegroundMessagingArguments('read', context.executionPipeline.normalizedIntent);
    const foregroundWeChatSendArgs = buildForegroundMessagingArguments('send', context.executionPipeline.normalizedIntent);
    // Read intent retains precedence: incoming messages must never enter a send capability.
    const foregroundMessagingAction = foregroundWeChatReadArgs ? 'read' : 'send';
    const foregroundMessagingArgs = foregroundWeChatReadArgs || foregroundWeChatSendArgs;
    if (foregroundMessagingArgs && context.toolSessionActive && !context.clientActionOnlyTurn && !context.selfRepairTurn) {
      const reading = foregroundMessagingAction === 'read';
      const source = reading ? 'voice_foreground_messaging_read' : 'voice_foreground_messaging';
      const correlationId = `voice-wechat-${foregroundMessagingAction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let toolRecord: ToolExecutionRecord = { id: correlationId,
        name: reading ? 'wechat_read_recent_chat' : 'wechat_send_message', arguments: foregroundMessagingArgs, result: '' };
      try {
        const foregroundExecution = await executeForegroundMessagingAction({
          action: foregroundMessagingAction, normalizedIntent: context.executionPipeline.normalizedIntent,
          executionPlan: context.executionPipeline.executionPlan, registry: toolRegistry, correlationId,
          arguments: foregroundMessagingArgs, context: context.toolContext,
          onLifecycle: event => context.emitToolLifecycle({ correlationId: event.correlationId,
            name: event.name, arguments: event.arguments,
            ...(event.phase === 'finish' && event.result ? { result: context.formatToolResultForUi(event.result) } : {}),
            ...(event.error ? { error: event.error } : {}),
          }),
        });
        toolRecord = foregroundExecution.record;
        if (toolRecord.error) throw new Error(toolRecord.error);
        if (!context.isCurrentTurn()) {
          { return { terminal: true as const, context: undefined }; }
        }
        const parsed = foregroundExecution.parsed;
        const contact = String(foregroundMessagingArgs.contact || '').trim();
        if (reading) {
          const summary = String(parsed.contentSummary || '').trim();
          const evidence = String(parsed.uiSnapshotPreview || '').slice(0, 1200);
          context.responseText = parsed.read && summary
            ? contact
              ? `我已经定位到你和${contact}的微信聊天。可见最近内容如下：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
              : `我已经读到当前微信聊天的可见最近内容：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
            : parsed.read
              ? contact
                ? `我已经定位到你和${contact}的微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
                : `我已经定位到当前微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
              : `这次还没完成。卡住的位置：微信前台聊天读取。${String(parsed.visionError || parsed.note || '没有拿到可读的聊天内容证据。')}`; // i18n-allow: reviewed Chinese messaging-read blocker.
        } else {
          context.responseText = formatCnVoiceWeChatSendResult(contact, String(foregroundMessagingArgs.message || '').trim(),
            parsed.sent === true && parsed.verificationStatus === 'verified');
        }
      } catch (error: any) {
        toolRecord.error = error?.message || String(error);
        if (!context.isCurrentTurn()) {
          { return { terminal: true as const, context: undefined }; }
        }
        context.responseText = reading
          ? `这次还没完成。卡住的位置：微信前台聊天读取：${toolRecord.error}。我不会把只打开或聚焦微信说成已读到聊天内容。` // i18n-allow: reviewed Chinese messaging-read failure receipt.
          : formatCnVoiceWeChatSendError(toolRecord.error);
      }
      const directFinal = finalizeLumiResponse({ taskText: context.actionIntentText, responseText: context.responseText, toolRecords: [toolRecord],
        source: 'voice', flow: context.turnFlow, taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId });
      context.responseText = directFinal.text;
      const interactionId = () => `voice_wechat_${foregroundMessagingAction}_${Date.now()}`;
      await context.finishVoiceTerminal({ text: context.responseText, source, blocked: directFinal.blocked,
        reason: directFinal.reason || '', cognitiveIntent: directFinal.blocked ? 'work_product_guard' : reading ? 'messaging_read' : 'messaging',
        llmWasCalled: false, toolCalls: [toolRecord], speechText: context.responseText, notification: directFinal.notification,
        persistTerminalState: () => context.persistVoiceTakeoverExecution(context.responseText, { toolRecords: [toolRecord], source,
          sourceInteractionId: interactionId(), finalizationBlocked: directFinal.blocked,
          assistantTextTrusted: !directFinal.blocked, finalizationReason: directFinal.reason }),
      }, {
        onCommitted: () => context.persistVoiceLearning(context.responseText, { toolRecords: [toolRecord], sourceInteractionId: interactionId(),
          logLabel: reading ? 'voice foreground messaging read' : 'voice foreground messaging' }),
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }
  return { terminal: false as const, context };
}

async function executeVoiceModelTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceModeAndMessagingTurn>>["context"]>) {


    // Reuse the configured model and the shared execution decision.
    const effectiveModel = context.voiceModel;
    logger.info(`[Audio] Intent: ${context.executionPipeline.normalizedIntent.kind}, model: ${effectiveModel}`);

    // The shared loop and any bounded recovery receive the same persisted
    // conversation, including both user and assistant messages with their roles.
    const recentMsgs = getMessagesByTokenBudget(context.conversationTurn.conversation.id, 6_000, 6, context.requestId).filter(message => !(
      message.role === 'user' && message.externalMessageId === context.requestId
    ));
    const voiceHistory: NormalizedMessage[] = normalizeVoiceHistory(recentMsgs);
    const historyChars = voiceHistory.reduce((total, message) => (
      total + (typeof message.content === 'string' ? message.content.length : 0)
    ), 0);
    logger.info(`[Audio] Prompt budget request=${context.requestId} systemChars=${context.voiceSystemPrompt.length} historyMessages=${voiceHistory.length} historyChars=${historyChars}`);

    const messages: NormalizedMessage[] = [
      { role: 'system', content: context.voiceSystemPrompt },
      ...voiceHistory,
      { role: 'user', content: context.userText, sourceMessageId: context.voiceUserMessageId },
    ];
    const recoveryConversationMessages = messages;

    const modelConfig: LLMConfig = {
      modelTurnState: context.modelTurnState,
      provider: context.provider,
      model: effectiveModel,
      userId: context.session.userId,
      domain: context.voiceScope.domain,
      orgId: context.voiceScope.orgId,
      conversationId: context.conversationTurn.conversation.id,
      requestId: context.requestId,
      source: 'voice',
      signal: context.pipelineAbort.signal,
      inputTokenBudget: context.voiceInputTokenBudget,
      ...context.reasoningRoutePolicy,
    };
    const onChunk = (chunk: string) => {
      if (!context.isCurrentTurn()) return;
      if (chunk) markVoiceLatencyMilestone(context.requestId, 'firstModelTokenAt');
      context.responseText += chunk;
      context.maybeStartSpeculativeSpeech();
      if (!context.deferCompletionSpeech) {
        const safeText = context.modelTextGate.push(chunk);
        if (safeText) context.emitAgent('agent:chunk', { text: safeText, agentName: 'Lumi' });
      }
    };
    context.turnAuthorization.assertCurrent();
    // Both transports use the same execution loop and conversational recovery.
    // Voice owns recognition, speech and presentation; it cannot independently
    // decide to repeat a tool, end an unfinished task or discard a receipt.
    markVoiceLatencyMilestone(context.requestId, 'firstModelRequestAt');
    const toolLifecycle = context.observeVoiceTools(record => context.toolResults.push(record));
    const result = context.toolSessionActive
      ? await runLumiTurn({
        messages: messages,
        registry: toolRegistry,
        config: modelConfig,
        onToolCall: toolLifecycle.onToolCall,
        maxIterations: context.maxIterations,
        onStreamChunk: onChunk,
        context: {
            ...context.toolContext,
            ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
            priorToolRecords: context.taskAwareRecords(context.toolResults),
            onToolStart: toolLifecycle.onToolStart,
          },
        getters: context.llmGetters,
      })
      : await runLumiTurn({
          messages,
          config: modelConfig,
          onChunk,
          getters: context.llmGetters,
          isCancelled: () => !context.isCurrentTurn(),
          assertCurrent: () => context.turnAuthorization.assertCurrent(),
          taskText: context.userText,
        });
    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }
    context.responseText = result.text || '';
    context.completionGuard = result.completionGuard;
    recordTokenUsageBatch(context.session.userId, result.usageRecords, context.requestId, 'voice');

    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }

    if (context.pendingConfirmationCreatedThisTurn) {
      context.responseText = context.trustedVoiceConfirmationText!;
    }

    context.modelTextGate.finish();
    const finalizedDesktopRecords = withDesktopExecutionReceipt(context.toolResults, context.desktopExecutionTracker);
    if (finalizedDesktopRecords.length > context.toolResults.length) {
      context.toolResults.push(...finalizedDesktopRecords.slice(context.toolResults.length));
    }
  return { terminal: false as const, context: extendTurnBindings(context, {
    recoveryConversationMessages: recoveryConversationMessages as typeof recoveryConversationMessages,
    effectiveModel: effectiveModel as typeof effectiveModel,
  }) };
}

async function finalizeVoiceModelTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceModelTurn>>["context"]>) {

    const responseFinalizer = createTurnResponseFinalizer({
      taskText: context.actionIntentText, flow: context.turnFlow, taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      pendingConfirmation: () => context.pendingConfirmationCreatedThisTurn,
      controlPauseReason: () => context.desktopRelay.getControlPauseReason(), pauseTaskText: context.routedUserText,
    });
    const desktopPauseBlocksCurrentTask = (records = context.taskAwareRecords(context.toolResults)) => responseFinalizer.isDesktopPaused(records);
    let finalResponse = responseFinalizer.finalize({
      responseText: context.responseText, completionGuard: context.completionGuard, toolRecords: context.taskAwareRecords(context.toolResults), source: 'voice',
    });
    const guardRecovery = await recoverBlockedExecutionOnce({
      task: context.routedUserText,
      responseText: context.responseText,
      finalization: finalResponse,
      allowToolUse: context.toolSessionActive,
      pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
      requiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
      aborted: !context.isCurrentTurn() || desktopPauseBlocksCurrentTask(),
      // Losing the current voice turn is cancellation. A desktop pause is a
      // resumable customer-visible state and must not become AbortError.
      isAborted: () => !context.isCurrentTurn(),
      isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
      toolRecords: context.taskAwareRecords(context.toolResults),
      attempt: async ({ instruction, priorToolRecords, recordTool }) => {
        logger.warn('[Audio] Recovering blocked execution internally.');
          context.turnAuthorization.assertCurrent();
      const recoveryLifecycle = context.observeVoiceTools(recordTool);
      const recovery = await runLumiTurn({
        messages: [
              ...context.recoveryConversationMessages,
              { role: 'assistant', content: context.responseText },
              { role: 'user', content: instruction },
          ],
        registry: toolRegistry,
        config: {
            provider: context.provider,
            model: context.effectiveModel,
            modelTurnState: context.modelTurnState,
            userId: context.session.userId,
            domain: context.voiceScope.domain,
            orgId: context.voiceScope.orgId,
            signal: context.pipelineAbort.signal,
            inputTokenBudget: context.voiceInputTokenBudget,
            ...context.reasoningRoutePolicy,
          },
        onToolCall: recoveryLifecycle.onToolCall,
        maxIterations: Math.max(2, Math.min(12, context.routedToolPolicy.maxIterations || context.maxIterations || 8)),
        context: {
            ...context.toolContext,
            ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
            source: 'voice_guard_recovery',
            priorToolRecords,
            isCancelled: () => !context.isCurrentTurn(),
            onToolStart: recoveryLifecycle.onToolStart,
          },
        getters: context.llmGetters,
      });
        recordTokenUsageBatch(context.session.userId, recovery.usageRecords, () => `voice_guard_recovery_${Date.now()}`, 'voice');
        return {
          text: recovery.text,
          completionGuard: recovery.completionGuard,
          toolRecords: withDesktopExecutionReceipt(recovery.toolCalls, context.desktopExecutionTracker),
        };
      },
      finalize: (candidateText, records, recoveryCompletionGuard) => {
        const recoveredRecords = context.taskAwareRecords(records);
        return responseFinalizer.finalize({
          responseText: candidateText, completionGuard: recoveryCompletionGuard,
          toolRecords: recoveredRecords, source: 'voice_guard_recovery',
        });
      },
    });
    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }
    finalResponse = guardRecovery.finalization;
    context.toolResults = withDesktopExecutionReceipt(guardRecovery.toolRecords, context.desktopExecutionTracker);
    context.responseText = finalResponse.text;
    if (finalResponse.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${finalResponse.reason}`);
    }

    let mainTerminalCommitted = false;
    if (context.responseText) {
      logger.info(`[Audio] Response: "${context.responseText.slice(0, 80)}" (${context.toolResults.length} tool calls)`);
      mainTerminalCommitted = await context.finishVoiceTerminal({
        text: context.responseText,
        source: "voice",
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
        cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : context.executionPipeline.normalizedIntent.kind,
        llmWasCalled: true,
        toolCalls: context.toolResults,
        speechText: context.responseText,
        notification: finalResponse.notification,
        persistTerminalState: () => {
          // commitVoiceTerminal consumes the receipts and blocks the task in
          // the same assistant write. Releasing the lease here would classify
          // these current receipts as stale and lose cross-channel progress.
          return context.persistVoiceTakeoverExecution(context.responseText, {
            toolRecords: context.toolResults,
            source: 'voice',
            sourceInteractionId: `voice_main_${Date.now()}`,
            finalizationBlocked: finalResponse.blocked,
            assistantTextTrusted: !finalResponse.blocked,
            finalizationReason: finalResponse.reason,
          });
        },
      });
    } else {
      await Promise.allSettled(context.ttsPromises);
    }

    // Candidate model text is never spoken before the strict
    // database and terminal-receipt fences have both committed.
    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }

    const conv = getOrCreateActiveConversation(context.session.userId, context.session.agentId, context.voiceScope.domain, context.voiceScope.orgId);
    // The user, assistant, task writeback, and terminal receipt committed
    // before TTS. Playback or
    // disconnect failures must never make a completed/blocked task disappear.
    // Topic tracking — extract and record topics for cross-session continuity
    if (!finalResponse.blocked) {
      try {
        const topics = extractTopics(context.userText + ' ' + context.responseText);
        for (const topic of topics) {
          trackTopic(conv.id, topic);
        }
      } catch {}
    }
    // Text sentiment analysis on user input (matching chat.ts behavior)
    const textSentiment = extractSentiment(context.userText);
    if (textSentiment.valence !== 0 || textSentiment.urgency > 0 || textSentiment.frustration > 0) {
      try {
        const es = loadEmotionalState(context.voiceStateKey);
        const updated = updateEmotionalState(es, {
          type: 'sentiment_analysis',
          timestamp: new Date().toISOString(),
          userId: context.session.userId,
          sentiment: {
            valence: textSentiment.valence,
            frustration: textSentiment.frustration,
            urgency: textSentiment.urgency,
          },
        });
        saveEmotionalState(context.voiceStateKey, updated);
        try { const hm = loadHIMState(context.voiceStateKey); const { him: nh } = himTick(updated, hm); saveHIMState(context.voiceStateKey, nh); } catch {}
      } catch { /* best-effort */ }
    }
    if (mainTerminalCommitted && !finalResponse.blocked) {
      context.persistVoiceLearning(context.responseText, { toolRecords: context.toolResults, logLabel: 'voice' });
    }
  return { terminal: false as const, context };
}

async function processAdmittedVoiceTurn(socket: Socket, session: AudioSession, userText: string, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, io: Server, userReceivedAt = new Date().toISOString(), voiceAuthorized = false, inputTiming: VoiceInputTiming = {}, resources: ConversationResourceLifetime = {}): Promise<void> {
  const prepareVoiceIdentityAndAdmissionResult = await prepareVoiceIdentityAndAdmission(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
  if (prepareVoiceIdentityAndAdmissionResult.terminal) return;
  const prepareVoiceContextAndRoutingResult = await prepareVoiceContextAndRouting(prepareVoiceIdentityAndAdmissionResult.context);
  if (prepareVoiceContextAndRoutingResult.terminal) return;
  const prepareVoiceExecutionAndPromptResult = await prepareVoiceExecutionAndPrompt(prepareVoiceContextAndRoutingResult.context);
  if (prepareVoiceExecutionAndPromptResult.terminal) return;
  const prepareVoiceReceiptsAndToolsResult = await prepareVoiceReceiptsAndTools(prepareVoiceExecutionAndPromptResult.context);
  if (prepareVoiceReceiptsAndToolsResult.terminal) return;
  const prepareVoiceSpeechResult = await prepareVoiceSpeech(prepareVoiceReceiptsAndToolsResult.context);
  if (prepareVoiceSpeechResult.terminal) return;
  const prepareVoiceReleaseResult = await prepareVoiceRelease(prepareVoiceSpeechResult.context);
  if (prepareVoiceReleaseResult.terminal) return;
  const context = prepareVoiceReleaseResult.context;
  try {
  const executeVoiceConfirmedAndDeterministicTurnResult = await executeVoiceConfirmedAndDeterministicTurn(context);
  if (executeVoiceConfirmedAndDeterministicTurnResult.terminal) return;
  const executeVoiceModeAndMessagingTurnResult = await executeVoiceModeAndMessagingTurn(executeVoiceConfirmedAndDeterministicTurnResult.context);
  if (executeVoiceModeAndMessagingTurnResult.terminal) return;
  const executeVoiceModelTurnResult = await executeVoiceModelTurn(executeVoiceModeAndMessagingTurnResult.context);
  if (executeVoiceModelTurnResult.terminal) return;
  const finalizeVoiceModelTurnResult = await finalizeVoiceModelTurn(executeVoiceModelTurnResult.context);
  if (finalizeVoiceModelTurnResult.terminal) return;

  }  catch (err: any) {
    if (isTtsCancellationError(err, context.pipelineAbort.signal)) {
      logger.info('[Audio] Pipeline aborted (barge-in or stop)');
    } else {
      logger.error("[Audio Error]:", err);
      if (context.finalAgentResponseDelivered) {
        logger.warn('[Audio] Post-response persistence failed; suppressing a contradictory UI error');
      } else {
        const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
        await context.finishVoiceTerminal({
          text: failureText,
          source: 'voice_error',
          blocked: true,
          reason: 'voice_processing_failed',
          cognitiveIntent: 'voice_processing_failed',
          llmWasCalled: false,
          toolCalls: context.toolResults,
          speechText: failureText,
        });
      }
    }
  } finally {

    await context.releaseVoiceTurnResources('Voice model/tool pipeline reached its finally boundary.');
  }
}

export async function processVoiceInput(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
  userReceivedAt = new Date().toISOString(),
  voiceAuthorized = false,
  inputTiming: VoiceInputTiming = {},
  resources: ConversationResourceLifetime = {},
): Promise<void> {
  return processAdmittedVoiceTurn(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
}
export { respondAlongsideActiveVoiceWork } from "./voice_side_response";
