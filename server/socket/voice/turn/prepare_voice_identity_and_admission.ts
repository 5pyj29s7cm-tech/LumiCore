import { captureConversationAuthorization, captureRequestAuthorization, combineRequestAuthorizations } from '../../../conversation/lifecycle';
import { resolveConversationForEntry } from '../../../conversation/entry_conversation';
import type { Server, Socket } from "socket.io";
import { type AudioSession, getVoiceStateKey, type VoiceInputTiming, type VoiceInputResources } from "../session";
import type { LLMGetters as LlmGetters } from "../../../llm/dispatch";
import { reserveConversationExecution } from "../../../cognition/conversation_execution";
import { isVoiceprintGateOpen, blockUnverifiedVoice } from "../voiceprint";
import { captureChatAuthorization } from "../../chat_authorization";
import { assessVoiceTranscriptForExecution } from "../../../cognition/voice_transcript_guard";
import { logger } from "../../../../logger";
import { getConfiguredVoiceModel, getVoicePreference } from "../../../config/voice_preference";
import { getActiveProvider as getTTSProvider } from "../../../tts/adapter";
import { isVoiceCorrectionContinuation, isVoiceCurrentActivityQuestion, mergeInterruptedVoiceTurn } from "../../voice_turn_state";
import { CN_VOICE_FAST_PATH_MESSAGES } from "../../../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { getConversationForScope, addMessageIdempotent, getMessages, getMessagesByTokenBudget, type startConversationActionExecutionHeartbeat } from "../../../conversation/manager";
import { buildForegroundWeChatSendArgs } from "../../../regions/packs/cn/foreground_wechat_intent";
import { ensurePendingConfirmationPersistenceInitialized } from "../../../tools/pending_confirmation_repository";
import { sanitizeVoiceAgentErrorPayload, voiceDurabilityUnknownText } from "../../voice_durability";
import { buildRecentActionContinuationBridge, isUserObservedTaskCompletion } from "../../../cognition/action_continuation";
import { randomUUID } from "node:crypto";
import { createVoiceExecutionReceiptCollector } from "../../voice_execution_receipts";
import { issueVoiceTurnProvenance } from "../../voice_provenance";
import { createModelTurnState } from "../../../llm/model_turn_state";
import { beginChatExecutionDurably, recordChatExecutionEvent, recordChatExecutionPersistenceUnknownDurably, type ChatExecutionScope } from "../../chat_execution_registry";
import { sanitizeExecutionResponseForDelivery, sanitizeExecutionNotificationForDelivery } from "../../../cognition/execution_guard_recovery";
import { projectCustomerVisibleExecutionEvent } from "../../public_agent_event_projection";
import { buildSocketToolSecurityContext } from "../../scope";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, type getPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { buildPendingAssistantOfferContextFromTranscript } from "../../../cognition/pending_assistant_offer";
import { resolveUserTurn } from "../../../cognition/turn_resolution";
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation, runAfterAcceptedUserTurnAdmission } from "../../action_turn_durability";
import { flushDBOrThrow } from "../../../../db_layer";

export async function prepareVoiceIdentityAndAdmission(socket: Socket, session: AudioSession, userText: string, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, io: Server, userReceivedAt = new Date().toISOString(), voiceAuthorized = false, inputTiming: VoiceInputTiming = {}, resources: VoiceInputResources = {}) {

  if (!voiceAuthorized && !isVoiceprintGateOpen(session)) {
    blockUnverifiedVoice(socket, session, 'Rejected voice command from unverified speaker');
    { return { terminal: true as const, context: undefined, entry: undefined, resume: undefined }; }
  }

  const scopeAuthorization = session.authorization || captureChatAuthorization(session.userId, session);
  if (!scopeAuthorization.isCurrent()) { return { terminal: true as const, context: undefined, entry: undefined, resume: undefined }; }
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
      const conv = resolveConversationForEntry(session.userId, session, { kind: 'voice', phase: 'select', agentId: session.agentId }, session.conversationId);
      if (!conv) throw new Error('Voice conversation is unavailable');
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

  const conversationTurn = resolveConversationForEntry(session.userId, session, {
    kind: 'voice', phase: 'admit', agentId: session.agentId, userText: actionIntentText,
  }, session.conversationId);
  session.conversationId = conversationTurn.conversation.id;
  const ownerAuthorization = captureRequestAuthorization(() => resources.owner?.isCurrent() ?? true, 'Voice request was superseded.');
  const turnAuthorization = combineRequestAuthorizations(scopeAuthorization, ownerAuthorization, captureConversationAuthorization({
    userId: session.userId, domain: session.domain, orgId: session.orgId, agentId: session.agentId,
  }, () => conversationTurn.conversation.id));
  if (transcriptExecutionGuard.action === 'allow') {
    transcriptExecutionGuard = assessVoiceTranscriptForExecution(userText, {
      pendingAction: conversationTurn.conversation.actionContinuationState?.unfinished === true,
    });
  }
  try {
    await ensurePendingConfirmationPersistenceInitialized();
  } catch (error) {
    if (!(resources.owner?.isCurrent() ?? true)) return { terminal: true as const, context: undefined, entry: undefined, resume: undefined };
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
    { return { terminal: true as const, context: undefined, entry: undefined, resume: undefined }; }
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
  resources.request = Object.freeze({ ...executionScope, requestId, agentId: session.agentId,
    personalityId: session.personalityId, provenance: voiceTurnProvenance, authorization: turnAuthorization, signal: pipelineAbort.signal });
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
    if (!(resources.owner?.isCurrent() ?? true)) return;
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
    persistAcceptedUserTurn: () => { turnAuthorization.assertCurrent(); return persistVoiceUserMessage(); },
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
    { return { terminal: true as const, context: undefined, entry: undefined, resume: undefined }; }
  }
  turnAuthorization.assertCurrent();
  voiceUserMessageId = voiceAdmission.persisted;
  resources.admission = reserveConversationExecution({userId:session.userId,domain:voiceScope.domain,orgId:voiceScope.orgId,conversationId:conversationTurn.conversation.id,source:'voice'},requestId,pipelineAbort.signal,{authorization:turnAuthorization,abort:reason=>{if(!pipelineAbort.signal.aborted)pipelineAbort.abort(reason);}});
  return { terminal: false as const, context: undefined, entry: {
    session, userText, requestId, voiceScope, conversationTurn, turnAuthorization, pipelineAbort, resources,
  }, resume: async () => {
  turnAuthorization.assertCurrent();
  conversationTurn.conversation = getConversationForScope(conversationTurn.conversation.id,session.userId,voiceScope.domain,voiceScope.orgId)!;
  if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
    await runAfterAcceptedUserTurnAdmission(voiceAdmission, () => (
      clearPendingConfirmationDurably(session.userId, buildTransportNeutralConfirmationScope({
        domain: session.domain,
        orgId: session.orgId,
        conversationId: conversationTurn.previousConversationId!,
      }))
    ));
  }
  turnAuthorization.assertCurrent();
  const confirmationResolution = await resolveAcceptedTurnConfirmation({
    admission: voiceAdmission,
    userId: session.userId,
    userText,
    taskRelation:acceptedVoiceResolution.taskRelation,
    actionState: conversationTurn.conversation.actionContinuationState,
    taskScope: confirmationScope,
    channelScope: confirmationChannelScope,
  });
  turnAuthorization.assertCurrent();
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
    if ((resources.owner?.isCurrent() ?? true) && session.isActive) socket.emit('audio:status', { status: 'listening', requestId });
    { return { terminal: true as const, context: undefined, entry: undefined, resume: undefined }; }
  }
  turnAuthorization.assertCurrent();
  return { terminal: false as const, context: {
    session,
    get transcriptExecutionGuard(): typeof transcriptExecutionGuard { return transcriptExecutionGuard; },
    set transcriptExecutionGuard(value: typeof transcriptExecutionGuard) { transcriptExecutionGuard = value; },
    actionIntentText,
    requestId,
    inputTiming,
    pipelineAbort,
    userText,
    executionReceipts,
    turnAuthorization,
    emitAgent,
    socket,
    get actionContinuationBridge(): typeof actionContinuationBridge { return actionContinuationBridge; },
    set actionContinuationBridge(value: typeof actionContinuationBridge) { actionContinuationBridge = value; },
    get pendingConfirmationPrompt(): typeof pendingConfirmationPrompt { return pendingConfirmationPrompt; },
    set pendingConfirmationPrompt(value: typeof pendingConfirmationPrompt) { pendingConfirmationPrompt = value; },
    voiceScope,
    sensoryFn,
    acceptedVoiceResolution,
    toolSecurityContext,
    conversationTurn,
    pendingAssistantOfferContext,
    userObservedCompletion,
    get voiceUserMessageId(): typeof voiceUserMessageId { return voiceUserMessageId; },
    set voiceUserMessageId(value: typeof voiceUserMessageId) { voiceUserMessageId = value; },
    get pendingConfirmation(): typeof pendingConfirmation { return pendingConfirmation; },
    set pendingConfirmation(value: typeof pendingConfirmation) { pendingConfirmation = value; },
    get interruptedMerge(): typeof interruptedMerge { return interruptedMerge; },
    set interruptedMerge(value: typeof interruptedMerge) { interruptedMerge = value; },
    normalizeAgentPayload,
    writeVoiceMessage,
    voiceTurnProvenance,
    executionScope,
    executionUnknownPayload,
    publishRecordedAgent,
    isCurrentTurn,
    get actionLeaseHeartbeat(): typeof actionLeaseHeartbeat { return actionLeaseHeartbeat; },
    set actionLeaseHeartbeat(value: typeof actionLeaseHeartbeat) { actionLeaseHeartbeat = value; },
    get confirmationScope(): typeof confirmationScope { return confirmationScope; },
    set confirmationScope(value: typeof confirmationScope) { confirmationScope = value; },
    llmGetters,
    io,
    confirmationResolution,
    confirmationChannelScope,
    correctionRequiresFreshConfirmation,
    get trustedVoiceConfirmationText(): typeof trustedVoiceConfirmationText { return trustedVoiceConfirmationText; },
    set trustedVoiceConfirmationText(value: typeof trustedVoiceConfirmationText) { trustedVoiceConfirmationText = value; },
    voiceStateKey,
    turnTtsSelection,
    persistVoiceUserMessage,
    resources,
    get finalAgentResponseDelivered(): typeof finalAgentResponseDelivered { return finalAgentResponseDelivered; },
    set finalAgentResponseDelivered(value: typeof finalAgentResponseDelivered) { finalAgentResponseDelivered = value; },
    get recentVoiceHistory(): typeof recentVoiceHistory { return recentVoiceHistory; },
    set recentVoiceHistory(value: typeof recentVoiceHistory) { recentVoiceHistory = value; },
    userObservedCompletionTask,
    modelTurnState,
    interruptedActivityResponse,
  } };
  } };
}
