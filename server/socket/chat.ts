import { registerChatExecutionControls, chatExecutionRoom } from './chat/connection_controls';
import { extendTurnBindings } from "../cognition/turn_bindings";
import { createChatTerminalReply } from './chat/terminal_reply';
import { createChatMessageWriter } from "./chat/message_writer";
import { executeChatModelTurn } from "./chat/model_execution";
import { answerPriorTaskStatus } from "./chat/prior_task_status";
import { prepareChatPromptContext } from "./chat/prompt_context";
import { retrieveChatContext } from "./chat/context_retrieval";
import { completeChatTurn } from "./chat/result_delivery";
import { executeConfirmedChatTurn } from "./chat/confirmation_execution";
import { isNamedPersistentWorkTaskStatusQuery } from '../cognition/action_contract';
import { buildRecentFailureExplanation } from "./chat/history";
export { normalizeChatHistoryRecord } from "./chat/history";
import { normalizeIncomingAttachments, buildChatAttachmentContext, buildStoredAttachmentSummary, shouldAllowLocalFileWriteForTurn } from "./chat/attachments";
export { buildChatAttachmentContext } from "./chat/attachments";
import { buildClientSurfaceContinuationBridge, isShortClientContinuation, getVerifiedClientModeChange } from "./chat/client_surface";
export { buildClientSurfaceContinuationBridge } from "./chat/client_surface";
import { runToolSession, type ToolSessionOptions } from "../llm/tool_session";
import { type ProviderGetters as SharedProviderGetters } from "../llm/provider_getters";
import { createTurnConfirmation } from '../tools/turn_confirmation';
import { readRuntimeWorkForTurn } from '../cognition/runtime_work_read';
import { reserveConversationExecution, getConversationExecution, getCurrentConversationExecution, cancelConversationExecution } from '../cognition/conversation_execution';
import { resolveUserTurn, type TurnResolution } from '../cognition/turn_resolution';
import { revalidateAcceptedTaskRelation } from '../cognition/task_concurrency';
import { isExplicitMemoryRequest, persistTurnMemory } from '../memory/turn_memory';
/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
import { Server, Socket } from "socket.io";
import { TASK_TARGET_HISTORY_LIMIT } from '../conversation/task_target_anchor';
import { flushDBOrThrow, readDatabaseTables } from "../../db_layer";

import { NormalizedMessage } from "../llm/providers";

import { resolveModelRequestInputBudget } from "../llm/request_context_budget";
import { ToolExecutionRecord, type ToolContext } from "../tools/types";
import { buildMediaArtifactReceipt, type MediaArtifactReceipt } from './media_artifact_receipt';
import { collectChatArtifacts } from '../conversation/chat_artifacts';
import { projectCustomerVisibleExecutionEvent } from './public_agent_event_projection';
import { runtimeShutdownCancellation } from '../runtime/shutdown_work';
import { captureChatAuthorization } from './chat_authorization';
import { captureConversationAuthorization, combineRequestAuthorizations } from '../conversation/lifecycle';
import { readScopedDeletionReceipt } from '../persistence/durable_scope_mutation';
import { normalizeStructuredMediaRequest, structuredMediaRoutingEnvelope } from '../../shared/media_generation';
import { toolRegistry } from "../tools/registry";
import { executeToolCall } from "../tools/execution_engine";
import { type LLMResult } from "../llm/adapter";
import { createModelTurnState } from '../llm/model_turn_state';

import { normalizeOperationMode } from "../cognition/operation_modes";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildOperationModeMetaResponse } from "../cognition/capability_meta";

import { buildLumiCapabilitySelection } from "../cognition/capability_selection";

import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";

import { buildForegroundTaskCompletionFeedback } from "../cognition/acceptance_evidence";
import { normalizeCompletionFeedbackForPersistence } from "../conversation/completion_feedback";
import { sanitizeExecutionResponseForDelivery, sanitizeExecutionNotificationForDelivery } from "../cognition/execution_guard_recovery";
import { executionBoundaryPromptOverlay, restrictVisibleToolNamesForExecutionBoundary } from "../tools/remote_policy";

import { createPreFinalizationTextGate, shouldDeferModelOutputUntilFinalized, shouldForwardPreFinalizationProgress } from "../cognition/response_delivery";

import { buildTextReplyStyleOverlay } from '../cognition/reply_style';
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiPostTurnLearning, shouldPersistPostTurnLearningSource } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { formatClientSelfPromptForTurn } from "../client/self_model";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, formatPendingConfirmationRequest, getPendingConfirmationDurably, isExplicitConfirmationReply, isConfirmationCancellation, recordPendingConfirmationDurably } from "../tools/pending_confirmation";
import { ensurePendingConfirmationPersistenceInitialized } from '../tools/pending_confirmation_repository';
import { buildPendingAssistantOfferContextFromTranscript, resolvePendingRuntimeCleanupOffer } from '../cognition/pending_assistant_offer';
import { formatRuntimeCleanupReceipt } from "../regions/messages/runtime_cleanup_messages";
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation, runAfterAcceptedUserTurnAdmission } from './action_turn_durability';

import { personalityRegistry } from "../personality";
import { getMemoryAvatar } from '../memory_avatar/store';
import { captureMemoryAvatarAuthorization } from '../memory_avatar/lifecycle';

import { getOrCreateConversationForTurn, addMessage, updateAssistantMessageTerminalPresentation, getMessageByRequestId, getMessages, setConversationMode, getConversationForScope, getOrCreateActiveConversation, getConversationActionStatus, bindConversationActionExecutionTurn, cancelConversationActionExecution, completeConversationActionFromUserObservation, createDurableForegroundReleaseGate, convergeForegroundRequestBeforeRelease, prepareConversationActionExecution, setConversationActionExecutionStatus, startConversationActionExecutionHeartbeat, type ForegroundRequestIdentity as ChatForegroundRequestIdentity, type ForegroundRequestReleaseInput, type ForegroundRequestReleaseResult as ChatForegroundRequestReleaseResult, type ForegroundRequestDurabilityDependencies } from "../conversation/manager";
import { getConversationActionStateByTaskId, getConversationActionStateFromLedger, getLatestConversationActionState } from "../conversation/action_ledger";
import { findAdjacentVerifiedConfirmedAction } from '../conversation/duplicate_confirmation';
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../conversation/exact_correction";
import { findLatestRepeatableAssistantReply } from '../conversation/assistant_restatement';

import { extractSentiment } from "../cognition/sentiment";
import { buildRecentActionContinuationBridge, conversationActionRequiresFreshConfirmationReview, formatConversationActionTaskStatus, isUserObservedTaskCompletion, pendingRuntimeCancellationRecheck } from "../cognition/action_continuation";
import { buildDurableTaskDeterministicToolRecoveryCall, buildStructuredMediaDeterministicToolRecoveryCall } from '../cognition/deterministic_tool_recovery';
import { coalesceToolExecutionRecords, taskReceiptsToRecords } from "../cognition/task_execution_ledger";
import { summarizeToolRecordForPersistence } from "../cognition/tool_record_status";
import { classifyRuntimeWorkIntent } from '../cognition/runtime_work_intent';

import { buildResponseLanguageInstruction } from "../utils/language";

import { CN_VOICE_WORK_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../regions/messages/task_execution_messages";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import { buildSocketNativeRequestBinding } from './native_request_binding';
export { buildSocketNativeRequestBinding } from './native_request_binding';
export type { SocketNativeRequestBinding } from './native_request_binding';
import { createDesktopRelay } from "./desktop_relay";
import { createConversationReceiptObserver } from '../conversation/execution_receipt_archive';

import { buildSocketToolSecurityContext, resolveAuthorizedSocketScope } from "./scope";
import { beginChatExecutionDurably, beginQueuedChatExecution, beginChatSidecarExecution, getDurableChatCancellationForCurrentExecution, getChatExecution, getChatSidecarCancellationTarget, markChatExecutionCancelling, persistChatSidecarCancellationIntent, recordChatExecutionEvent, recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, waitForChatSidecarCancellationIntent, type ChatExecutionScope } from "./chat_execution_registry";
import { commitChatTerminalBoundary, persistAuthorizedTerminalReceipt as persistAuthorizedReceipt } from "./chat_terminal_boundary";
import { chatPublicErrorCodeForException, sanitizeChatAgentErrorPayload } from "./chat_public_error";
import { formatActiveTaskRelationContext, resolveActiveTaskMessageRelation, taskRelationFollowupIntent, bindPreparedTaskMessageRelation, type ActiveTaskMessageResolution } from "../cognition/task_concurrency";

export type {
  ForegroundRequestIdentity as ChatForegroundRequestIdentity,
  ForegroundRequestReleaseResult as ChatForegroundRequestReleaseResult,
} from '../conversation/manager';

export async function convergeChatForegroundRequestBeforeRelease(
  input: ForegroundRequestReleaseInput,
  dependencies: ForegroundRequestDurabilityDependencies = {},
): Promise<ChatForegroundRequestReleaseResult> {
  return convergeForegroundRequestBeforeRelease({
    ...input,
    channel: 'Chat',
  }, dependencies);
}

function chatDurabilityUnknownText(userText: string): string {
  return /[\u3400-\u9fff]/u.test(userText)
    ? CN_TASK_EXECUTION_MESSAGES.persistenceUnknown
    : 'The final state of this turn could not be saved reliably, so I did not mark it complete. If an external action may have run, verify its actual result before retrying.';
}

function buildNaturalReplyStyleOverlay(source?: string): string {
  return buildTextReplyStyleOverlay(source === 'voice' ? 'voice' : 'chat');
}

async function prepareChatRequest(socket: Socket, llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>, sensoryFn: (uid: string) => any, userIdFn: (s: Socket) => string, io: Server, data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown }, ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void) {

    const turnTimingStartedAt = performance.now();
    const turnTiming: Record<string, number> = {};
    const markTurnTiming = (phase: string) => { turnTiming[phase] = Math.round(performance.now() - turnTimingStartedAt); };
    console.log('[ChatHandler] agent:chat RECEIVED:', JSON.stringify({
      requestId: String(data?.requestId || '').slice(0, 120),
      source: String(data?.source || '').slice(0, 80),
      textLength: String(data?.text || '').length,
      attachmentCount: Array.isArray(data?.attachments) ? data.attachments.length : 0,
      mediaOperation: data?.mediaRequest && typeof data.mediaRequest === 'object'
        ? String((data.mediaRequest as Record<string, unknown>).operation || '').slice(0, 40)
        : '',
    }));
    const { history, personalityId = "lumi", category, agentId, mode: payloadMode, source } = data;
    const attachments = normalizeIncomingAttachments(data.attachments);
    const rawUserText = typeof data.text === 'string' ? data.text.trim() : '';
    const visibleUserText = rawUserText || (attachments.length > 0 ? 'Please review the attached file(s).' : '');
    const attachmentContext = buildChatAttachmentContext(attachments);
    const historyItems = Array.isArray(history) ? history : [];
    let chatContextBridge = buildClientSurfaceContinuationBridge(visibleUserText, historyItems);
    let actionContinuationBridge = '';
    const text = [visibleUserText, attachmentContext].filter(Boolean).join('\n\n');
    const storedUserContent = buildStoredAttachmentSummary(visibleUserText, attachments);
    const allowLocalFileWrites = shouldAllowLocalFileWriteForTurn(visibleUserText, attachments);
    const localWriteIntentReason = allowLocalFileWrites
      ? `Current chat request explicitly asked Lumi to generate/export a local deliverable: "${visibleUserText.slice(0, 120)}"`
      : undefined;
    const requestId = typeof data.requestId === 'string' && data.requestId.trim()
      ? data.requestId.trim().slice(0, 120)
      : `chat_${crypto.randomUUID()}`;
    const structuredMediaRequest = normalizeStructuredMediaRequest(data.mediaRequest);
    if (data.mediaRequest !== undefined && !structuredMediaRequest) {
      try { ack?.({ ok: false, requestId, error: 'Invalid media workbench request' }); } catch {}
      { return { terminal: true as const, context: undefined }; }
    }
    const mediaRoutingEnvelope = structuredMediaRequest
      ? structuredMediaRoutingEnvelope(structuredMediaRequest)
      : '';
    const requestReceivedAt = new Date().toISOString();
    const eventSource = source || 'chat';
    const toolResultPreviewLimit = 500;
    const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
    let latestMediaArtifactReceipt: MediaArtifactReceipt | undefined;
    const formatMediaArtifactReceiptForUi = (
      name: string,
      args?: Record<string, any>,
      result?: string,
      error?: string,
    ) => {
      const receipt = buildMediaArtifactReceipt(name, args, result, error);
      if (receipt) latestMediaArtifactReceipt = receipt;
      return receipt;
    };
    const requestedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    const uid = userIdFn(socket);
    const nativeRequestBinding = buildSocketNativeRequestBinding(socket);
    let pendingConfirmation: Awaited<ReturnType<typeof getPendingConfirmationDurably>> = null;
    let pendingConfirmationPrompt = '';
    // Execution evidence belongs to the request, including when a later model
    // call is cancelled. Keep it reachable by the outer terminal boundary.
    const requestToolRecords: ToolExecutionRecord[] = [];
    let requestTaskId: string | undefined;
    let receiptObserver: ReturnType<typeof createConversationReceiptObserver> | undefined;
    let collectRequestTerminalRecords = () => requestToolRecords;
    const rememberRequestToolRecord = (record: ToolExecutionRecord) => {
      if (!record?.name) return;
      if (record.id && requestToolRecords.some(item => item.id === record.id)) return;
      requestToolRecords.push(record);
    };
    console.log('[ChatHandler] uid:', uid, 'agentId:', requestedAgentId || 'lumi', 'source:', source);

    // UI scope hints cannot turn an invalid work credential into personal access.
    const socketScope = resolveAuthorizedSocketScope(socket, uid);
    if (!socketScope) {
      try { ack?.({ ok: false, requestId, error: 'Workspace access is unavailable.' }); } catch {}
      { return { terminal: true as const, context: undefined }; }
    }
    // Only a user-owned Memory Avatar may opt into the private persona lane.
    // Ordinary chat always remains the single LumiCore identity; arbitrary
    // client-supplied Agent IDs cannot create another conversation owner or
    // grant a different execution policy.  This is the server-side single-core
    // boundary; LAP and the private Memory Avatar surface remain explicit lanes.
    const requestedMemoryAvatar = requestedAgentId.startsWith('memory_avatar_')
      ? getMemoryAvatar(uid, requestedAgentId)
      : null;
    if (
      requestedAgentId.startsWith('memory_avatar_')
      && (!requestedMemoryAvatar || requestedMemoryAvatar.status !== 'active')
    ) {
      try { ack?.({ ok: false, requestId, error: 'Memory Avatar is unavailable for this user' }); } catch {}
      { return { terminal: true as const, context: undefined }; }
    }
    const memoryAvatar = requestedMemoryAvatar;
    const conversationAgentId = memoryAvatar?.id || 'lumi';
    const isMemoryAvatar = Boolean(memoryAvatar && memoryAvatar.status === 'active');
    // A Memory Avatar is a personal, private reflection even when the shell
    // is currently connected to an organization workspace. Never let the
    // transport's work scope pull company KB/RAG or org-scoped memories into
    // that conversation.
    const requestScope = isMemoryAvatar
      ? { domain: 'personal' as const, orgId: '' }
      : socketScope;
    const resolvedDomain = requestScope.domain;
    const resolvedOrgId = requestScope.orgId;
    const addMessageIdempotent = createChatMessageWriter({
      userId: uid, agentId: conversationAgentId, domain: resolvedDomain, orgId: resolvedOrgId,
      requestId, source: eventSource, getNativeBinding: () => buildSocketNativeRequestBinding(socket),
    });
    const allowAdaptiveLearning = !isMemoryAvatar && shouldPersistPostTurnLearningSource(eventSource);
    const toolSecurityContext = {
      ...buildSocketToolSecurityContext(socket, requestScope),
      onToolRecord: (record: ToolExecutionRecord) => receiptObserver?.onToolRecord(record),
    };
    const ownerAuthorization = isMemoryAvatar
      ? captureMemoryAvatarAuthorization(uid, conversationAgentId)
      : captureChatAuthorization(uid, requestScope);
    let selectedConversationId = '';
    const conversationAuthorization = captureConversationAuthorization(
      { userId: uid, agentId: conversationAgentId, ...requestScope }, () => selectedConversationId,
    );
    const turnAuthorization = combineRequestAuthorizations(ownerAuthorization, conversationAuthorization);
    const modelTurnState = createModelTurnState();
    const runAuthorizedTools = (input: ToolSessionOptions) => {
      turnAuthorization.assertCurrent();
      // Preserve the accepted conversation and transport provenance through
      // every execution/recovery path, including reusable workflow traces.
      return runToolSession({ ...input, getters: llmGetters, config: { ...input.config, modelTurnState, conversationId: selectedConversationId || input.config.conversationId, workflowSource: eventSource } });
    };
    const rejectRevokedRequest = () => {
      if (turnAuthorization.isCurrent()) return false;
      try { ack?.({ ok: false, requestId, error: !conversationAuthorization.isCurrent() ? 'Conversation is no longer available. Start a new conversation.' : isMemoryAvatar ? 'Memory avatar or its sources changed. Start a new request.' : 'Organization access changed. Start a new request in an available workspace.' }); } catch {}
      return true;
    };
    const requestedConversationId = String(data.conversationId || '').trim();
    const persistedRequestTurn = getMessageByRequestId({
      userId: uid,
      agentId: conversationAgentId,
      requestId,
      role: 'user',
      source: eventSource,
      channel: 'chat',
    });
    const persistedRequestConversation = persistedRequestTurn?.conversationId
      ? getConversationForScope(
          persistedRequestTurn.conversationId,
          uid,
          resolvedDomain,
          resolvedOrgId,
        )
      : null;
    const selectedConversation = persistedRequestConversation || (requestedConversationId
      ? getConversationForScope(requestedConversationId, uid, resolvedDomain, resolvedOrgId)
      : getOrCreateActiveConversation(uid, conversationAgentId, resolvedDomain, resolvedOrgId));
    const explicitlyBoundConversation = Boolean(
      requestedConversationId
      && selectedConversation?.id === requestedConversationId,
    );
    if (
      !selectedConversation
      || selectedConversation.agentId !== conversationAgentId
      || (
        selectedConversation.status !== 'active'
        && !persistedRequestTurn
        && !explicitlyBoundConversation
      )
    ) {
      try { ack?.({ ok: false, requestId, error: 'Conversation is unavailable for this user, agent, or workspace' }); } catch {}
      { return { terminal: true as const, context: undefined }; }
    }
    selectedConversationId = selectedConversation.id;
    try {
      await ensurePendingConfirmationPersistenceInitialized();
    } catch (error) {
      console.error('[ChatHandler] Encrypted confirmation store is unavailable:', error);
      try { ack?.({ ok: false, requestId, error: 'Secure confirmation storage is unavailable' }); } catch {}
      { return { terminal: true as const, context: undefined }; }
    }
    if (rejectRevokedRequest()) { return { terminal: true as const, context: undefined }; }
  return { terminal: false as const, context: {
    get selectedConversationId(): typeof selectedConversationId { return selectedConversationId; },
    set selectedConversationId(value: typeof selectedConversationId) { selectedConversationId = value; },
    uid: uid as typeof uid,
    resolvedDomain: resolvedDomain as typeof resolvedDomain,
    resolvedOrgId: resolvedOrgId as typeof resolvedOrgId,
    selectedConversation: selectedConversation as typeof selectedConversation,
    visibleUserText: visibleUserText as typeof visibleUserText,
    eventSource: eventSource as typeof eventSource,
    requestId: requestId as typeof requestId,
    get collectRequestTerminalRecords(): typeof collectRequestTerminalRecords { return collectRequestTerminalRecords; },
    set collectRequestTerminalRecords(value: typeof collectRequestTerminalRecords) { collectRequestTerminalRecords = value; },
    get latestMediaArtifactReceipt(): typeof latestMediaArtifactReceipt { return latestMediaArtifactReceipt; },
    set latestMediaArtifactReceipt(value: typeof latestMediaArtifactReceipt) { latestMediaArtifactReceipt = value; },
    conversationAgentId: conversationAgentId as typeof conversationAgentId,
    turnAuthorization: turnAuthorization as typeof turnAuthorization,
    socket: socket as typeof socket,
    markTurnTiming: markTurnTiming as typeof markTurnTiming,
    turnTiming: turnTiming as typeof turnTiming,
    isMemoryAvatar: isMemoryAvatar as typeof isMemoryAvatar,
    io: io as typeof io,
    conversationAuthorization: conversationAuthorization as typeof conversationAuthorization,
    addMessageIdempotent: addMessageIdempotent as typeof addMessageIdempotent,
    ack: ack as typeof ack,
    rejectRevokedRequest: rejectRevokedRequest as typeof rejectRevokedRequest,
    data: data as typeof data,
    storedUserContent: storedUserContent as typeof storedUserContent,
    requestReceivedAt: requestReceivedAt as typeof requestReceivedAt,
    toolSecurityContext: toolSecurityContext as typeof toolSecurityContext,
    attachments: attachments as typeof attachments,
    get pendingConfirmation(): typeof pendingConfirmation { return pendingConfirmation; },
    set pendingConfirmation(value: typeof pendingConfirmation) { pendingConfirmation = value; },
    get pendingConfirmationPrompt(): typeof pendingConfirmationPrompt { return pendingConfirmationPrompt; },
    set pendingConfirmationPrompt(value: typeof pendingConfirmationPrompt) { pendingConfirmationPrompt = value; },
    llmGetters: llmGetters as typeof llmGetters,
    formatToolResultForUi: formatToolResultForUi as typeof formatToolResultForUi,
    memoryAvatar: memoryAvatar as typeof memoryAvatar,
    personalityId: personalityId as typeof personalityId,
    text: text as typeof text,
    requestScope: requestScope as typeof requestScope,
    get chatContextBridge(): typeof chatContextBridge { return chatContextBridge; },
    set chatContextBridge(value: typeof chatContextBridge) { chatContextBridge = value; },
    payloadMode: payloadMode as typeof payloadMode,
    get actionContinuationBridge(): typeof actionContinuationBridge { return actionContinuationBridge; },
    set actionContinuationBridge(value: typeof actionContinuationBridge) { actionContinuationBridge = value; },
    historyItems: historyItems as typeof historyItems,
    sensoryFn: sensoryFn as typeof sensoryFn,
    mediaRoutingEnvelope: mediaRoutingEnvelope as typeof mediaRoutingEnvelope,
    structuredMediaRequest: structuredMediaRequest as typeof structuredMediaRequest,
    category: category as typeof category,
    get requestTaskId(): typeof requestTaskId { return requestTaskId; },
    set requestTaskId(value: typeof requestTaskId) { requestTaskId = value; },
    get receiptObserver(): typeof receiptObserver { return receiptObserver; },
    set receiptObserver(value: typeof receiptObserver) { receiptObserver = value; },
    allowLocalFileWrites: allowLocalFileWrites as typeof allowLocalFileWrites,
    localWriteIntentReason: localWriteIntentReason as typeof localWriteIntentReason,
    requestToolRecords: requestToolRecords as typeof requestToolRecords,
    nativeRequestBinding: nativeRequestBinding as typeof nativeRequestBinding,
    rememberRequestToolRecord: rememberRequestToolRecord as typeof rememberRequestToolRecord,
    formatMediaArtifactReceiptForUi: formatMediaArtifactReceiptForUi as typeof formatMediaArtifactReceiptForUi,
    runAuthorizedTools: runAuthorizedTools as typeof runAuthorizedTools,
    history: history as typeof history,
    allowAdaptiveLearning: allowAdaptiveLearning as typeof allowAdaptiveLearning,
    buildNaturalReplyStyleOverlay: buildNaturalReplyStyleOverlay as typeof buildNaturalReplyStyleOverlay,
    chatDurabilityUnknownText: chatDurabilityUnknownText as typeof chatDurabilityUnknownText,
  } };
}

async function prepareChatEvents(context: NonNullable<Awaited<ReturnType<typeof prepareChatRequest>>["context"]>) {

    const pendingAssistantOfferTranscript = getMessages(context.selectedConversationId, 4);
    let pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
      messages: pendingAssistantOfferTranscript,
      userId: context.uid,
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      conversationId: context.selectedConversationId,
      taskId: context.selectedConversation.actionContinuationState?.taskId,
    });
    let acceptedRuntimeCleanupOffer = resolvePendingRuntimeCleanupOffer(
      context.visibleUserText,
      pendingAssistantOfferContext,
    );
    const explicitRuntimeWorkStatusRequest = classifyRuntimeWorkIntent(
      context.visibleUserText,
      pendingAssistantOfferContext,
    ) === 'status';
    let confirmationChannelScope = buildTransportNeutralConfirmationScope({
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      conversationId: context.selectedConversationId,
    });
    let confirmationScope = buildTransportNeutralConfirmationScope({
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      conversationId: context.selectedConversationId,
      taskId: context.selectedConversation.actionContinuationState?.taskId,
    });
    const confirmationCancellationRequested = isConfirmationCancellation(context.visibleUserText);
    let pendingConfirmationCleared = false;
    let correctionRequiresFreshConfirmation = false;
    let executionScope: ChatExecutionScope & { conversationId: string } = {
      userId: context.uid,
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      source: context.eventSource,
      conversationId: context.selectedConversationId,
      requireConversation: true,
    };
    let executionRoom = chatExecutionRoom(executionScope);
    let resolvedTaskRelation: ActiveTaskMessageResolution | null = null;
    let acceptedTurnResolution: TurnResolution | undefined;
    const refreshResolvedTaskRelationFromLedger = (
      exactConversationId: string,
      exactTaskId = resolvedTaskRelation?.taskId || '',
      exactRequestId = context.requestId,
    ): ActiveTaskMessageResolution | null => {
      if (!exactConversationId || !resolvedTaskRelation) return null;
      const db = readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]);
      const requestTurns = (db.conversationActionTurns || []).filter((turn: any) => (
        turn.conversationId === exactConversationId
        && turn.userId === context.uid
        && turn.requestId === exactRequestId
        && String(turn.taskId || '').trim()
      ));
      // A deterministic tool turn may acquire its durable task only when the
      // assistant/tool receipt is persisted. The immutable request binding is
      // safer than selecting whichever task happens to be newest.
      const requestBoundTaskId = requestTurns.length === 1
        ? String(requestTurns[0].taskId || '').trim()
        : '';
      const normalizedTaskId = String(exactTaskId || requestBoundTaskId || '').trim();
      const durableConversation = (db.conversations || []).find((candidate: any) => (
        candidate.id === exactConversationId && candidate.userId === context.uid
      ));
      const durableState = normalizedTaskId
        ? getConversationActionStateByTaskId(db, {
            conversationId: exactConversationId,
            userId: context.uid,
            taskId: normalizedTaskId,
          })
        : durableConversation?.actionContinuationState;
      if (!durableState?.taskId) return null;
      resolvedTaskRelation = {
        ...resolvedTaskRelation,
        binding: durableState.unfinished ? 'active_task' : 'previous_task',
        taskId: durableState.taskId,
        revision: durableState.revision,
        // An idle/terminal durable task no longer owns this request lease.
        targetRequestId: durableState.activeRequestId || undefined,
      };
      return resolvedTaskRelation;
    };
    const normalizeAgentPayload = (
      event: string,
      payload: Record<string, any> = {},
      outputProtection: { trustedConfirmationRequestText?: string } = {},
    ): Record<string, any> => {
      const sanitizedPayload: Record<string, any> = event === 'agent:response'
        ? sanitizeExecutionResponseForDelivery(payload, {
            task: context.visibleUserText,
            toolRecords: context.collectRequestTerminalRecords(),
            ...outputProtection,
          })
        : event === 'agent:notification'
          ? sanitizeExecutionNotificationForDelivery(payload, { task: context.visibleUserText })
        : event === 'agent:error'
          ? sanitizeChatAgentErrorPayload(payload)
          : payload;
      const publicPayload = projectCustomerVisibleExecutionEvent(event, sanitizedPayload, {
        taskText: context.visibleUserText,
      });
      const completionFeedback = normalizeCompletionFeedbackForPersistence(publicPayload.completionFeedback);
      const boundedPublicPayload = { ...publicPayload };
      delete boundedPublicPayload.completionFeedback;
      return {
        ...boundedPublicPayload,
        ...(event === 'agent:response'
          ? { fileArtifacts: collectChatArtifacts(context.collectRequestTerminalRecords(), context.selectedConversationId) }
          : {}),
        ...(event === 'agent:response' && context.latestMediaArtifactReceipt
          ? { artifactReceipt: context.latestMediaArtifactReceipt }
          : {}),
        // Every client-visible event carries the conversation owner.  The
        // desktop shell shares one user-level socket across Lumi, LAP, and
        // Memory Avatar surfaces; consumers must be able to reject a late
        // event from another surface instead of treating it as their own.
        agentId: context.conversationAgentId,
        ...(completionFeedback ? { completionFeedback } : {}),
        source: boundedPublicPayload.source || context.eventSource,
        requestId: context.requestId,
        conversationId: context.selectedConversationId,
        ...(resolvedTaskRelation ? { taskRelation: resolvedTaskRelation } : {}),
      };
    };
    let authorizationNoticeSent = false;
    const publishRecordedAgent = (event: string, normalizedPayload: Record<string, any>) => {
      if (!context.turnAuthorization.isCurrent()) {
        // Keep the originating UI from hanging, without publishing the old
        // workspace's text, tool output, task details, or completion claims.
        if (!authorizationNoticeSent && (event === 'agent:response' || event === 'agent:error')) {
          authorizationNoticeSent = true;
          context.socket.emit('agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.cancelled, agentName: 'Lumi',
            source: context.eventSource, requestId: context.requestId, conversationId: context.selectedConversationId,
            finalized: true, blocked: false, reason: 'cancelled',
          });
        }
        return;
      }
      if (event === 'agent:response') {
        if (process.env.LUMI_CHAT_LATENCY_DIAGNOSTICS === '1') {
          context.markTurnTiming('responseReady');
          console.log('[ChatTiming]', JSON.stringify({ requestId: context.requestId, ...context.turnTiming }));
        }
        // The originating native client must receive the terminal frame even
        // if its room membership changed during reconnect or conversation
        // rollover. Other signed-in clients still receive the same terminal
        // event through the user/workspace room without duplicating it here.
        context.socket.emit(event, normalizedPayload);
        context.socket.to(executionRoom).emit(event, normalizedPayload);
        return;
      }
      if (context.isMemoryAvatar) {
        // Memory Avatar requests are forced into the personal data scope. An
        // organization-authenticated socket may not be a member of that room,
        // so deliver its private stream/status frames directly to the socket
        // that initiated the request instead of silently dropping them.
        context.socket.emit(event, normalizedPayload);
        return;
      }
      context.io.to(executionRoom).emit(event, normalizedPayload);
    };
    let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      if (!context.conversationAuthorization.isCurrent()) return false;
      const normalizedPayload = normalizeAgentPayload(event, payload);
      // A late duplicate from the same handler is not a reconnect replay. The
      // explicit request/recovery entry points above own replay delivery; doing
      // it here turns one committed terminal into a second UI terminal frame.
      if (!recordChatExecutionEvent(executionScope, context.requestId, event, normalizedPayload)) return false;
      publishRecordedAgent(event, normalizedPayload);
      return true;
    };
    const persistAuthorizedTerminalReceipt = (
      event: 'agent:response' | 'agent:error', payload: Record<string, any>, unknownPayload: Record<string, any>,
    ) => persistAuthorizedReceipt({ scope: executionScope, requestId: context.requestId, event, payload, unknownPayload,
      authorization: context.turnAuthorization, conversationIsCurrent: context.conversationAuthorization.isCurrent, channel: 'chat', flush: flushDBOrThrow });
    const commitDeterministicTerminal = async (input: {
      event?: 'agent:response' | 'agent:error';
      payload: Record<string, any>;
      persistAssistantMessage?: () => void;
      publishAfter?: () => void;
      errorContext?: string;
    }): Promise<boolean> => {
      if (!context.conversationAuthorization.isCurrent()) return false;
      if (actionLeaseHeartbeat?.isLeaseLost()) {
        await actionLeaseHeartbeat.leaseLoss;
        return false;
      }
      const terminalEvent = input.event || 'agent:response';
      const terminalPayload = normalizeAgentPayload(terminalEvent, input.payload);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(context.visibleUserText),
        agentName: String(input.payload.agentName || 'Lumi'),
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      const committed = await commitChatTerminalBoundary({
        persistTerminalState: () => undefined,
        persistAssistantMessage: () => {
          input.persistAssistantMessage?.();
          const relation = refreshResolvedTaskRelationFromLedger(
            context.selectedConversationId,
            resolvedTaskRelation?.taskId,
          );
          if (relation) {
            terminalPayload.taskRelation = relation;
            unknownPayload.taskRelation = relation;
          }
        },
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => persistAuthorizedTerminalReceipt(
          terminalEvent,
          terminalPayload,
          unknownPayload,
        ),
        persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            context.requestId,
            unknownPayload,
          ),
        publishCommitted: () => {
          publishRecordedAgent(terminalEvent, terminalPayload);
          input.publishAfter?.();
        },
        publishUnknown: () => {
          // The success receipt failed its strict barrier. Publish only the
          // sanitized unknown frame already installed in the in-memory
          // quarantine; do not route it through the registry a second time.
          publishRecordedAgent('agent:response', unknownPayload);
        },
        persistenceUnknownProjection: {
          text: unknownPayload.text,
          completionFeedback: unknownPayload.completionFeedback,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => {
          console.error(`[ChatHandler] ${input.errorContext || 'Deterministic terminal'} persistence failed:`, error);
        },
      });
      if (committed) actionLeaseHeartbeat?.stop();
      return committed;
    };
    const commitChatReply = createChatTerminalReply({
      commit: commitDeterministicTerminal, write: context.addMessageIdempotent, getConversationId: () => context.selectedConversationId,
    });
    const emitConversationUpdated = (payload: Record<string, any>) => {
      if (!context.turnAuthorization.isCurrent()) return;
      context.io.to(executionRoom).emit('chat:conversation_updated', {
        ...payload,
        requestId: context.requestId,
        originSocketId: context.socket.id,
      });
    };
    console.log('[ChatHandler] domain:', context.resolvedDomain, 'orgId:', context.resolvedOrgId);
  return { terminal: false as const, context: extendTurnBindings(context, {
    get executionScope(): typeof executionScope { return executionScope; },
    set executionScope(value: typeof executionScope) { executionScope = value; },
    normalizeAgentPayload: normalizeAgentPayload as typeof normalizeAgentPayload,
    publishRecordedAgent: publishRecordedAgent as typeof publishRecordedAgent,
    get acceptedTurnResolution(): typeof acceptedTurnResolution { return acceptedTurnResolution; },
    set acceptedTurnResolution(value: typeof acceptedTurnResolution) { acceptedTurnResolution = value; },
    get pendingAssistantOfferContext(): typeof pendingAssistantOfferContext { return pendingAssistantOfferContext; },
    set pendingAssistantOfferContext(value: typeof pendingAssistantOfferContext) { pendingAssistantOfferContext = value; },
    get resolvedTaskRelation(): typeof resolvedTaskRelation { return resolvedTaskRelation; },
    set resolvedTaskRelation(value: typeof resolvedTaskRelation) { resolvedTaskRelation = value; },
    commitChatReply: commitChatReply as typeof commitChatReply,
    get confirmationScope(): typeof confirmationScope { return confirmationScope; },
    set confirmationScope(value: typeof confirmationScope) { confirmationScope = value; },
    get confirmationChannelScope(): typeof confirmationChannelScope { return confirmationChannelScope; },
    set confirmationChannelScope(value: typeof confirmationChannelScope) { confirmationChannelScope = value; },
    get pendingConfirmationCleared(): typeof pendingConfirmationCleared { return pendingConfirmationCleared; },
    set pendingConfirmationCleared(value: typeof pendingConfirmationCleared) { pendingConfirmationCleared = value; },
    commitDeterministicTerminal: commitDeterministicTerminal as typeof commitDeterministicTerminal,
    emitAgent: emitAgent as typeof emitAgent,
    get acceptedRuntimeCleanupOffer(): typeof acceptedRuntimeCleanupOffer { return acceptedRuntimeCleanupOffer; },
    set acceptedRuntimeCleanupOffer(value: typeof acceptedRuntimeCleanupOffer) { acceptedRuntimeCleanupOffer = value; },
    get executionRoom(): typeof executionRoom { return executionRoom; },
    set executionRoom(value: typeof executionRoom) { executionRoom = value; },
    confirmationCancellationRequested: confirmationCancellationRequested as typeof confirmationCancellationRequested,
    get correctionRequiresFreshConfirmation(): typeof correctionRequiresFreshConfirmation { return correctionRequiresFreshConfirmation; },
    set correctionRequiresFreshConfirmation(value: typeof correctionRequiresFreshConfirmation) { correctionRequiresFreshConfirmation = value; },
    get actionLeaseHeartbeat(): typeof actionLeaseHeartbeat { return actionLeaseHeartbeat; },
    set actionLeaseHeartbeat(value: typeof actionLeaseHeartbeat) { actionLeaseHeartbeat = value; },
    emitConversationUpdated: emitConversationUpdated as typeof emitConversationUpdated,
    explicitRuntimeWorkStatusRequest: explicitRuntimeWorkStatusRequest as typeof explicitRuntimeWorkStatusRequest,
    refreshResolvedTaskRelationFromLedger: refreshResolvedTaskRelationFromLedger as typeof refreshResolvedTaskRelationFromLedger,
    persistAuthorizedTerminalReceipt: persistAuthorizedTerminalReceipt as typeof persistAuthorizedTerminalReceipt,
  }) };
}

async function resolveChatControlTurn(context: NonNullable<Awaited<ReturnType<typeof prepareChatEvents>>["context"]>) {

    // Request ids are idempotency keys. Socket.IO may deliver a buffered emit
    // after reconnect; acknowledging the existing execution avoids running the
    // same user action twice.
    let existingExecution = getChatExecution(context.executionScope, context.requestId);
    if (existingExecution) {
      if (existingExecution.sidecar === true && !existingExecution.terminal) {
        try {
          await waitForChatSidecarCancellationIntent(context.executionScope, context.requestId);
        } catch (error: any) {
          const publicCode = error?.code === 'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE'
            ? 'CHAT_EXECUTION_FAILED'
            : 'CHAT_CONTROL_RECEIPT_WRITE_FAILED';
          try {
            context.ack?.({
              ok: false,
              requestId: context.requestId,
              error: sanitizeChatAgentErrorPayload({ code: publicCode }).message,
            });
          } catch {}
          { return { terminal: true as const, context: undefined }; }
        }
        existingExecution = getChatExecution(context.executionScope, context.requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(context.executionScope, context.requestId);
        if (durableTarget && !getConversationExecution(context.executionScope, durableTarget)) {
          // The process can restart after the durable fence but before the
          // side effect/terminal write. With no matching lease, converge the
          // tombstone to a terminal no-op; never replay cancellation onto a
          // later task.
          const staleControlPayload = context.normalizeAgentPayload('agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            source: context.eventSource,
            requestId: context.requestId,
            conversationId: context.selectedConversationId,
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          });
          const unknownPayload = context.normalizeAgentPayload('agent:response', {
            text: chatDurabilityUnknownText(context.visibleUserText),
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'persistence_unknown',
          });
          try {
            await flushDBOrThrow();
            await recordChatExecutionTerminalEventDurably(
              context.executionScope,
              context.requestId,
              'agent:response',
              staleControlPayload,
              unknownPayload,
            );
          } catch (error: any) {
            console.error('[ChatHandler] Recovered control terminal persistence failed:', error);
            try {
              await recordChatExecutionPersistenceUnknownDurably(
                context.executionScope,
                context.requestId,
                unknownPayload,
              );
            } catch (unknownError) {
              console.error('[ChatHandler] Recovered control unknown receipt persistence failed:', unknownError);
            }
            context.publishRecordedAgent('agent:response', unknownPayload);
            try { context.ack?.({ ok: false, requestId: context.requestId, error: 'Terminal persistence outcome is unknown' }); } catch {}
            { return { terminal: true as const, context: undefined }; }
          }
          existingExecution = getChatExecution(context.executionScope, context.requestId) || existingExecution;
        }
      }
      if (context.rejectRevokedRequest()) { return { terminal: true as const, context: undefined }; }
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        context.socket.emit(existingExecution.terminalEvent.event, {
          ...existingExecution.terminalEvent.payload,
          replayed: true,
        });
      } else {
        const resumableStatus = existingExecution.status === 'planning' || existingExecution.status === 'acknowledged'
          ? existingExecution.queued === true ? 'queued' : 'thinking'
          : existingExecution.status;
        context.socket.emit('agent:status', {
          status: resumableStatus,
          source: context.eventSource,
          requestId: context.requestId,
          resumed: true,
        });
      }
      { return { terminal: true as const, context: undefined }; }
    }

    // Reconnect/retry may resend a request that is already reserved but has
    // not reached beginChatExecution yet. Acknowledge the existing lease;
    // never attach a second handler to the same queued request.
    const queuedDuplicate = getConversationExecution(context.executionScope, context.requestId);
    if (queuedDuplicate) {
      try {
        context.ack?.({
          ok: true,
          requestId: context.requestId,
          receivedAt: new Date().toISOString(),
        });
      } catch {}
      context.socket.emit('agent:status', {
        status: queuedDuplicate.state === 'active' ? 'thinking' : 'queued',
        source: context.eventSource,
        requestId: context.requestId,
        resumed: true,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    // A status question is a side conversation, not a replacement command.
    // Answer it without aborting/superseding the foreground executor.
    const observedExistingSession = getCurrentConversationExecution(context.executionScope);
    // Socket delivery happens immediately after the terminal durability fence,
    // while queue-resource release finishes a few microtasks later. A fast
    // follow-up can therefore observe the old queue slot even though its
    // request already has a durable terminal. Do not answer that follow-up as
    // "still executing"; let it queue briefly and resolve against the ledger.
    const existingSession = observedExistingSession
      && getChatExecution(context.executionScope, observedExistingSession.requestId)?.terminal !== true
      ? observedExistingSession
      : null;
    const controlTargetRequestId = String(context.data.controlTargetRequestId || '').trim().slice(0, 120);
    const controlTargetTaskId = String(context.data.controlTargetTaskId || '').trim().slice(0, 180);
    const controlTargetRevision = typeof context.data.controlTargetRevision === 'number'
      && Number.isFinite(context.data.controlTargetRevision)
      ? Math.max(0, Math.trunc(context.data.controlTargetRevision))
      : undefined;
    // The serial queue key already includes the explicitly selected
    // conversation id. Resolve status against that exact conversation; using
    // the user's globally active chat here leaks isolated/native E2E sidecars
    // into an unrelated personal transcript.
    const activeConversationForStatus = existingSession ? getConversationForScope(
      context.selectedConversationId,
      context.uid,
      context.resolvedDomain,
      context.resolvedOrgId,
    ) : null;
    context.acceptedTurnResolution = resolveUserTurn({
      requestId: context.requestId, userText: context.visibleUserText,
      state: activeConversationForStatus?.actionContinuationState || context.selectedConversation.actionContinuationState,
      options: {
        activeRequestId: existingSession?.requestId,
        controlTargetRequestId,
        controlTargetTaskId,
        controlTargetRevision,
        pendingAssistantOfferContext: context.pendingAssistantOfferContext,
      },
    });
    context.resolvedTaskRelation = { ...context.acceptedTurnResolution.taskRelation };
    if (!context.isMemoryAvatar && context.acceptedTurnResolution.queryTarget === 'runtime_work'
      && context.acceptedTurnResolution.userIntent.operation === 'status') {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      const admission = await admitAcceptedUserTurnDurably({
        persistAcceptedUserTurn: () => context.addMessageIdempotent({conversationId:context.selectedConversationId,role:'user',
          content:context.storedUserContent,receivedAt:context.requestReceivedAt,skipActionContinuation:true,
        }),
        flush:flushDBOrThrow,
        onPersistenceUnknown:async error=>{
          const payload=context.normalizeAgentPayload('agent:response',{text:chatDurabilityUnknownText(context.visibleUserText),
            agentName:'Lumi',finalized:true,blocked:true,reason:'persistence_unknown',sidecar:true});
          try {await recordChatExecutionPersistenceUnknownDurably(context.executionScope,context.requestId,payload);}
          catch {console.error('[ChatHandler] Runtime status admission persistence failed:',error);}
          context.publishRecordedAgent('agent:response',payload);
          try {context.ack?.({ok:false,requestId: context.requestId,error:'Accepted user turn persistence is unknown'});} catch {}
        },
      });
      if (!admission) { return { terminal: true as const, context: undefined }; }
      try {context.ack?.({ok:true,requestId: context.requestId,receivedAt:context.requestReceivedAt});} catch {}
      const result = await readRuntimeWorkForTurn({
        resolution:context.acceptedTurnResolution,userId:context.uid,domain:context.resolvedDomain,orgId:context.resolvedOrgId,
        conversationId:context.selectedConversationId,source:context.eventSource,registry:toolRegistry,
        securityContext:context.toolSecurityContext,authorization:context.turnAuthorization,
        personalityToolPolicy: (personalityRegistry.getForUser('lumi', context.uid, context.resolvedDomain === 'work' ? context.resolvedOrgId : undefined)
          || personalityRegistry.getDefault()).toolPolicy,
      });
      await context.commitChatReply({
        text:result.text,
        blocked:result.blocked,
        reason:'runtime_work_status',
        sidecar:true,
        message: () => ({
          toolCalls:[result.record],
          cognitiveIntent:'runtime_work_status',
          llmWasCalled:false,
          skipActionContinuation:true,
        }),
        errorContext:'Read-only runtime status terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    const durableStatusTaskState = activeConversationForStatus?.actionContinuationState
      || context.selectedConversation.actionContinuationState;
    const durablePostCancelBinding = !existingSession && context.resolvedTaskRelation.feedback === 'status'
      ? getDurableChatCancellationForCurrentExecution(context.executionScope, {
          ...(durableStatusTaskState?.taskId
            ? {
                currentTask: {
                  taskId: durableStatusTaskState.taskId,
                  revision: Number.isFinite(Number(durableStatusTaskState.revision))
                    ? Math.max(0, Math.trunc(Number(durableStatusTaskState.revision)))
                    : -1,
                  activeRequestId: durableStatusTaskState.activeRequestId,
                  unfinished: durableStatusTaskState.unfinished === true,
                },
              }
            : {}),
          relation: {
            binding: context.resolvedTaskRelation.binding,
            taskId: context.resolvedTaskRelation.taskId,
            revision: context.resolvedTaskRelation.revision,
            targetRequestId: context.resolvedTaskRelation.targetRequestId,
          },
          requestedTarget: {
            requestId: controlTargetRequestId,
            taskId: controlTargetTaskId,
            revision: controlTargetRevision,
          },
        })
      : null;
    const exactPostCancelStatusTarget = durablePostCancelBinding?.targetRequestId
      && (!controlTargetRequestId || controlTargetRequestId === durablePostCancelBinding.targetRequestId)
      ? durablePostCancelBinding.targetRequestId
      : '';
    const exactPostCancelTargetTerminal = exactPostCancelStatusTarget
      ? durablePostCancelBinding?.targetTerminal || null
      : null;
    if (
      !existingSession
      && context.resolvedTaskRelation.feedback === 'status'
      && exactPostCancelTargetTerminal?.terminal === true
      && exactPostCancelTargetTerminal.terminalEvent
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'task_status',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      const statusText = String(
        exactPostCancelTargetTerminal.terminalEvent.payload?.text
        || CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt,
      ).trim();
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitChatReply({
        text: statusText,
        source: context.eventSource,
        requestId: context.requestId,
        sidecar: true,
        reason: 'target_execution_status',
        controlIntent: 'status',
        targetRequestId: exactPostCancelStatusTarget,
        message: () => ({
          cognitiveIntent: 'task_status',
          llmWasCalled: false,
          skipActionContinuation: true,
        }),
        errorContext: 'Exact post-cancellation status terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    if (
      context.resolvedTaskRelation.binding === 'stale'
      && context.resolvedTaskRelation.relation !== 'queue'
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'stale_task_control',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitChatReply({
        text: CN_TASK_EXECUTION_MESSAGES.staleControl,
        sidecar: true,
        reason: context.resolvedTaskRelation.reason,
        message: () => ({
          cognitiveIntent: 'stale_task_control',
          llmWasCalled: false,
          skipActionContinuation: true,
        }),
        errorContext: 'Stale task control terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    if (
      !existingSession
      && context.resolvedTaskRelation.feedback === 'cancel'
      && context.resolvedTaskRelation.taskId
      && context.selectedConversation.actionContinuationState?.unfinished
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'task_cancel',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      const cancelled = cancelConversationActionExecution(
        context.selectedConversationId,
        context.uid,
        'Cancelled by the user.',
        context.selectedConversation.actionContinuationState?.activeRequestId
          ? controlTargetRequestId || undefined
          : undefined,
      );
      const clearedTaskConfirmation = await clearPendingConfirmationDurably(context.uid, context.confirmationScope);
      const clearedTasklessConfirmation = await clearPendingConfirmationDurably(context.uid, context.confirmationChannelScope);
      context.pendingConfirmationCleared = clearedTaskConfirmation || clearedTasklessConfirmation;
      const cancelledCurrentTask = cancelled?.taskId === context.resolvedTaskRelation.taskId
        && cancelled.status === 'cancelled';
      const responseText = cancelledCurrentTask
        ? CN_TASK_EXECUTION_MESSAGES.cancelled
        : CN_TASK_EXECUTION_MESSAGES.staleControl;
      if (cancelledCurrentTask) {
        context.resolvedTaskRelation = { ...context.resolvedTaskRelation, revision: cancelled?.revision };
      }
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitChatReply({
        text: responseText,
        sidecar: true,
        reason: cancelledCurrentTask ? 'cancelled_by_user' : 'stale_control',
        message: () => ({
          cognitiveIntent: 'task_cancel',
          skipActionContinuation: true,
        }),
        errorContext: 'Task cancellation terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    if (
      existingSession
      && !isNamedPersistentWorkTaskStatusQuery(context.visibleUserText)
      && context.resolvedTaskRelation.feedback === 'status'
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      // Natural-language status controls do not carry UI fence metadata. The
      // server-observed foreground lease is authoritative in that case; an
      // explicitly supplied stale target was already rejected above.
      if (controlTargetRequestId && controlTargetRequestId !== existingSession.requestId) {
        try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
        await context.commitDeterministicTerminal({ payload: {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        }, errorContext: 'Stale status control terminal' });
        { return { terminal: true as const, context: undefined }; }
      }
      const activeConversation = activeConversationForStatus || context.selectedConversation;
      if (activeConversation) {
        context.addMessageIdempotent({
          conversationId: activeConversation.id,
          role: 'user',
          content: context.storedUserContent,
          cognitiveIntent: 'task_status',
          receivedAt: context.requestReceivedAt,
          timestamp: context.requestReceivedAt,
          skipActionContinuation: true,
        });
      }
      const statusText = activeConversation && context.resolvedTaskRelation.taskId
        ? getConversationActionStatus(activeConversation.id, context.uid, context.visibleUserText, activeConversation.actionContinuationState)
        : CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt;
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitDeterministicTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: context.eventSource,
          requestId: context.requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: '',
        },
        persistAssistantMessage: activeConversation
          ? () => context.addMessageIdempotent({ conversationId: activeConversation.id, role: 'assistant', content: statusText, cognitiveIntent: 'task_status', skipActionContinuation: true })
          : undefined,
        errorContext: 'Active task status terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
  return { terminal: false as const, context: extendTurnBindings(context, {
    existingSession: existingSession as typeof existingSession,
    activeConversationForStatus: activeConversationForStatus as typeof activeConversationForStatus,
    controlTargetRequestId: controlTargetRequestId as typeof controlTargetRequestId,
    controlTargetTaskId: controlTargetTaskId as typeof controlTargetTaskId,
    controlTargetRevision: controlTargetRevision as typeof controlTargetRevision,
  }) };
}

async function admitChatForegroundTurn(context: NonNullable<Awaited<ReturnType<typeof resolveChatControlTurn>>["context"]>) {

    // A new utterance does not destroy an active task. Continuations and
    // independent work wait behind the current foreground lease; only an
    // explicit replacement aborts it.
    const previousSession = getCurrentConversationExecution(context.executionScope, 'tail');
    if (previousSession && previousSession.requestId !== context.existingSession?.requestId) {
      context.resolvedTaskRelation = resolveActiveTaskMessageRelation(
        context.visibleUserText,
        context.activeConversationForStatus?.actionContinuationState || context.selectedConversation.actionContinuationState,
        {
          acceptedFeedback: context.resolvedTaskRelation.feedback,
          activeRequestId: previousSession.requestId,
          controlTargetRequestId: context.controlTargetRequestId,
          controlTargetTaskId: context.controlTargetTaskId,
          controlTargetRevision: context.controlTargetRevision,
          pendingAssistantOfferContext: context.pendingAssistantOfferContext,
        },
      );
    }
    const activeMessageRelation = previousSession ? context.resolvedTaskRelation.relation : null;
    let acknowledged = false;
    if (previousSession && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      // A typed/spoken "停止" has no client request id. Bind it to the exact
      // server-owned lease selected by the resolver. UI controls may still
      // supply an immutable fence, and stale explicit fences are rejected
      // before this branch.
      const cancellationTargetRequestId = context.controlTargetRequestId
        || context.resolvedTaskRelation.targetRequestId
        || previousSession.requestId;
      try {
        // A buffered cancellation must be durably fenced before it can touch
        // the foreground queue. On restart, this tombstone makes replay a
        // status lookup instead of a second cancellation of newer work.
        await persistChatSidecarCancellationIntent(context.executionScope, context.requestId, cancellationTargetRequestId);
      } catch (error: any) {
        const publicError = sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' });
        await context.commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: publicError.message,
            code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED',
            sidecar: true,
          },
          errorContext: 'Cancellation reservation failure terminal',
        });
        try { context.ack?.({ ok: false, requestId: context.requestId, error: publicError.message }); } catch {}
        { return { terminal: true as const, context: undefined }; }
      }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'task_cancel',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      try {
        context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      context.emitAgent('agent:status', { status: 'cancelling', sidecar: true });
      if (!context.turnAuthorization.isCurrent()) {
        // This control already has a durable reservation and an acceptance
        // acknowledgement. Settle it without touching its old target.
        await context.commitChatReply({
          text: CN_TASK_EXECUTION_MESSAGES.cancelled,
          sidecar: true,
          reason: 'cancelled',
          message: () => ({
            cognitiveIntent: 'task_cancel',
            skipActionContinuation: true,
          }),
          errorContext: 'Revoked cancellation control terminal',
        });
        { return { terminal: true as const, context: undefined }; }
      }
      const currentTarget = getConversationExecution(context.executionScope, cancellationTargetRequestId);
      if (!currentTarget) {
        await context.commitChatReply({
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          sidecar: true,
          reason: 'stale_control',
          message: () => ({
            cognitiveIntent: 'task_cancel',
            skipActionContinuation: true,
          }),
          errorContext: 'Stale cancellation terminal',
        });
        { return { terminal: true as const, context: undefined }; }
      }
      try {
        await cancelConversationExecution(context.executionScope, cancellationTargetRequestId);
      } catch (error: any) {
        const settlementTimedOut = error?.code === 'serial_execution_cancellation_timeout';
        const failureText = settlementTimedOut
          ? CN_TASK_EXECUTION_MESSAGES.cancellationSettlementTimedOut
          : sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_CANCEL_FAILED' }).message;
        await context.commitDeterministicTerminal({
          ...(settlementTimedOut ? {} : { event: 'agent:error' as const }),
          payload: settlementTimedOut ? {
            text: failureText,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'cancellation_settlement_timeout',
          } : {
            message: failureText,
            code: 'CHAT_CONTROL_CANCEL_FAILED',
            sidecar: true,
          },
          persistAssistantMessage: settlementTimedOut ? () => context.addMessageIdempotent({ conversationId: context.selectedConversationId, role: 'assistant', content: failureText, cognitiveIntent: 'cancellation_settlement_timeout', skipActionContinuation: true }) : undefined,
          errorContext: settlementTimedOut
            ? 'Cancellation settlement timeout terminal'
            : 'Cancellation failure terminal',
        });
        { return { terminal: true as const, context: undefined }; }
      }
      await context.commitChatReply({
        text: CN_TASK_EXECUTION_MESSAGES.cancelled,
        source: context.eventSource,
        requestId: context.requestId,
        sidecar: true,
        reason: 'cancelled_by_user',
        message: () => ({
          cognitiveIntent: 'task_cancel',
          skipActionContinuation: true,
        }),
        errorContext: 'Cancellation completion terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }

    // Bind and persist the foreground user turn before it waits behind any
    // older lease. This keeps receive order durable even when the model/tool
    // phase is long or the process exits before a terminal assistant result.
    const conversationTurn = getOrCreateConversationForTurn(
      context.uid,
      context.conversationAgentId,
      context.resolvedDomain,
      context.resolvedOrgId,
      { userText: context.visibleUserText, conversationId: context.selectedConversationId },
    );
    let conversation = conversationTurn.conversation;
    const userObservedCompletionTaskId = context.attachments.length === 0
      && isUserObservedTaskCompletion(context.visibleUserText, conversation.actionContinuationState)
      ? conversation.actionContinuationState?.taskId
      : undefined;
    if (conversation.id !== context.selectedConversationId) {
      context.selectedConversationId = conversation.id;
      context.pendingAssistantOfferContext = undefined;
      context.acceptedRuntimeCleanupOffer = null;
      context.confirmationChannelScope = buildTransportNeutralConfirmationScope({
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        conversationId: context.selectedConversationId,
      });
      context.confirmationScope = buildTransportNeutralConfirmationScope({
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        conversationId: context.selectedConversationId,
      });
      context.executionScope = { ...context.executionScope, conversationId: context.selectedConversationId };
      context.executionRoom = chatExecutionRoom(context.executionScope);
      context.pendingConfirmation = null;
      context.pendingConfirmationPrompt = '';
    }
    if (context.rejectRevokedRequest()) { return { terminal: true as const, context: undefined }; }
    context.markTurnTiming('admissionStart');
    const chatAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => context.addMessageIdempotent({
        conversationId: conversation.id,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: context.confirmationCancellationRequested
          ? 'task_cancel'
          : context.resolvedTaskRelation.binding === 'active_task' || context.resolvedTaskRelation.binding === 'previous_task'
            ? `task_${context.resolvedTaskRelation.feedback}`
            : undefined,
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        deferActionPreparation: !context.confirmationCancellationRequested,
        skipActionContinuation: context.confirmationCancellationRequested,
      }),
      flush: flushDBOrThrow,
      onPersistenceUnknown: error => {
        console.error('[ChatHandler] Accepted user turn could not be flushed:', error);
        const unknownPayload = context.normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(context.visibleUserText),
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
        });
        context.publishRecordedAgent('agent:response', unknownPayload);
        try { context.ack?.({ ok: false, requestId: context.requestId, error: 'Accepted user turn persistence is unknown' }); } catch {}
      },
    });
    if (!chatAdmission) {
      { return { terminal: true as const, context: undefined }; }
    }
    context.markTurnTiming('admissionEnd');
    const acceptedUserMessageId = chatAdmission.persisted;
    if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
      await runAfterAcceptedUserTurnAdmission(chatAdmission, () => (
        clearPendingConfirmationDurably(context.uid, buildTransportNeutralConfirmationScope({
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          conversationId: conversationTurn.previousConversationId!,
        }))
      ));
    }
    const confirmationResolution = await resolveAcceptedTurnConfirmation({
      admission: chatAdmission,
      userId: context.uid,
      userText: context.visibleUserText,
      taskRelation: context.resolvedTaskRelation || undefined,
        actionState: conversation.actionContinuationState,
      taskScope: context.confirmationScope,
      channelScope: context.confirmationChannelScope,
    });
    context.pendingConfirmation = confirmationResolution.pending;
    context.pendingConfirmationPrompt = confirmationResolution.prompt;
    context.confirmationScope = confirmationResolution.scope;
    context.pendingConfirmationCleared = confirmationResolution.cleared;
    context.correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

    // Install the lease before waiting. Otherwise two messages arriving while
    // the same task is active both wait for that task and wake concurrently,
    // allowing the later request to supersede the earlier queued request.
    const sessionLease = runAfterAcceptedUserTurnAdmission(chatAdmission, () => {
      if (previousSession && activeMessageRelation === 'replace' && context.turnAuthorization.isCurrent()) {
        void cancelConversationExecution(context.executionScope);
      }
      beginQueuedChatExecution(context.executionScope, context.requestId);
      return reserveConversationExecution(context.executionScope, context.requestId);
    });
    const abortController = sessionLease.controller;
    const markRequestCancellation = () => markChatExecutionCancelling(context.executionScope, context.requestId);
    abortController.signal.addEventListener('abort', markRequestCancellation, { once: true });
    const stopAuthorizationWatch = context.turnAuthorization.watch(abortController);
    if (abortController.signal.aborted) markRequestCancellation();
    const isChatCancelled = () => !context.turnAuthorization.isCurrent() || abortController.signal.aborted;
    const forwardToolProgress = (step: string) => {
      if (!isChatCancelled() && shouldForwardPreFinalizationProgress(step)) {
        context.emitAgent('agent:progress', { text: step, agentName: 'Lumi' });
      }
    };
    const unregisterShutdownCancellation = runtimeShutdownCancellation.register(abortController);
    let releaseDesktopControlLease: (() => void) | null = null;
    let foregroundRequestIdentity: ChatForegroundRequestIdentity | null = null;
  return { terminal: false as const, context: extendTurnBindings(context, {
    stopAuthorizationWatch: stopAuthorizationWatch as typeof stopAuthorizationWatch,
    abortController: abortController as typeof abortController,
    markRequestCancellation: markRequestCancellation as typeof markRequestCancellation,
    unregisterShutdownCancellation: unregisterShutdownCancellation as typeof unregisterShutdownCancellation,
    get releaseDesktopControlLease(): typeof releaseDesktopControlLease { return releaseDesktopControlLease; },
    set releaseDesktopControlLease(value: typeof releaseDesktopControlLease) { releaseDesktopControlLease = value; },
    sessionLease: sessionLease as typeof sessionLease,
    get foregroundRequestIdentity(): typeof foregroundRequestIdentity { return foregroundRequestIdentity; },
    set foregroundRequestIdentity(value: typeof foregroundRequestIdentity) { foregroundRequestIdentity = value; },
    get acknowledged(): typeof acknowledged { return acknowledged; },
    set acknowledged(value: typeof acknowledged) { acknowledged = value; },
    activeMessageRelation: activeMessageRelation as typeof activeMessageRelation,
    chatAdmission: chatAdmission as typeof chatAdmission,
    get conversation(): typeof conversation { return conversation; },
    set conversation(value: typeof conversation) { conversation = value; },
    userObservedCompletionTaskId: userObservedCompletionTaskId as typeof userObservedCompletionTaskId,
    acceptedUserMessageId: acceptedUserMessageId as typeof acceptedUserMessageId,
    isChatCancelled: isChatCancelled as typeof isChatCancelled,
    conversationTurn: conversationTurn as typeof conversationTurn,
    confirmationResolution: confirmationResolution as typeof confirmationResolution,
    forwardToolProgress: forwardToolProgress as typeof forwardToolProgress,
  }) };
}

async function startChatForegroundTurn(context: NonNullable<Awaited<ReturnType<typeof admitChatForegroundTurn>>["context"]>) {

    const releaseChatTransportResources = (): void => {
      context.stopAuthorizationWatch();
      context.abortController.signal.removeEventListener('abort', context.markRequestCancellation);
      context.unregisterShutdownCancellation();
      context.actionLeaseHeartbeat?.stop();
      context.releaseDesktopControlLease?.();
      context.releaseDesktopControlLease = null;
      context.sessionLease.release();
    };
    const chatReleaseGate = createDurableForegroundReleaseGate({
      converge: async reason => {
        // Pre-binding exits own no durable action-turn lease.
        if (!context.foregroundRequestIdentity) return true;
        // An explicit deletion removes this request's transcript and action
        // projection together. Once that deletion is durable there is no
        // deleted lease to reconstruct or endlessly retry. Independently
        // running native work retains its own execution/settlement fencing.
        if (!context.conversationAuthorization.isCurrent() && readScopedDeletionReceipt(
          { userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId },
          'conversation', context.selectedConversationId,
        )) {
          await flushDBOrThrow();
          return true;
        }
        const releaseResult = await convergeChatForegroundRequestBeforeRelease({
          identity: context.foregroundRequestIdentity,
          aborted: context.abortController.signal.aborted,
          reason,
        });
        if (!releaseResult.converged) {
          console.error('[ChatHandler] foreground_request_finalization_incomplete', {
            code: 'CHAT_FOREGROUND_FINALIZATION_INCOMPLETE',
            identity: context.foregroundRequestIdentity,
            convergence: {
              finalStatus: releaseResult.convergence.finalStatus,
              reason: releaseResult.convergence.reason,
              evidence: releaseResult.convergence.evidence,
            },
            finalization: releaseResult.finalization ? {
              effectiveOutcome: releaseResult.finalization.effectiveOutcome,
              taskStatus: releaseResult.finalization.taskStatus,
              actionTurnStatus: releaseResult.finalization.actionTurnStatus,
              reason: releaseResult.finalization.reason,
              evidence: releaseResult.finalization.evidence,
            } : null,
          });
        }
        return releaseResult.converged;
      },
      releaseResources: releaseChatTransportResources,
      onFailure: ({ error }) => {
        if (error instanceof Error && error.message === 'foreground_request_not_durably_converged') return;
        const convergenceError = error as any;
        console.error('[ChatHandler] foreground_request_finalization_failed', {
          code: 'CHAT_FOREGROUND_FINALIZATION_FAILED',
          identity: context.foregroundRequestIdentity,
          errorName: String(convergenceError?.name || 'Error'),
          errorMessage: String(convergenceError?.message || 'Unknown convergence error'),
        });
      },
      onRecoveryTakeover: ({ attempts }) => console.error('[ChatHandler] foreground_release_recovery_takeover', {
        code: 'CHAT_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
        identity: context.foregroundRequestIdentity,
        attempts,
      }),
    });
    const releaseChatSession = (
      reason = 'Chat foreground request reached its release boundary.',
    ): Promise<boolean> => chatReleaseGate.release(reason);

    if (context.sessionLease.waitingForRequestId) {
      try {
        context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() });
        context.acknowledged = true;
      } catch {}
      if (context.turnAuthorization.isCurrent()) context.io.to(context.executionRoom).emit('agent:status', {
        status: context.activeMessageRelation === 'replace' ? 'replacing' : 'queued',
        source: context.eventSource,
        requestId: context.requestId,
        waitingForRequestId: context.sessionLease.waitingForRequestId,
        taskRelation: context.resolvedTaskRelation,
      });
    }
    if (!await context.sessionLease.waitForTurn().then(() => true, error => {
      if (!context.abortController.signal.aborted) throw error;
      return false;
    })) {
      const waitTimedOut = context.sessionLease.state === 'timed_out';
      const terminalText = waitTimedOut
        ? CN_TASK_EXECUTION_MESSAGES.queueWaitTimedOut
        : CN_TASK_EXECUTION_MESSAGES.cancelled;
      await context.commitChatReply({
        text: terminalText,
        blocked: true,
        reason: waitTimedOut ? 'queue_wait_timeout' : 'cancelled',
        message: () => ({
          cognitiveIntent: waitTimedOut ? 'queue_wait_timeout' : 'task_cancel',
        }),
        errorContext: waitTimedOut ? 'Queued wait timeout terminal' : 'Queued cancellation terminal',
      });
      await releaseChatSession();
      { return { terminal: true as const, context: undefined }; }
    }
    let superseded = null as Awaited<ReturnType<typeof beginChatExecutionDurably>>;
    try {
      superseded = await runAfterAcceptedUserTurnAdmission(
        context.chatAdmission,
        () => beginChatExecutionDurably(context.executionScope, context.requestId, {
          text: chatDurabilityUnknownText(context.visibleUserText),
          agentName: 'Lumi',
        }),
      );
    } catch (error) {
      console.error('[ChatHandler] Superseded terminal persistence failed:', error);
      const unknownPayload = context.normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(context.visibleUserText),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      try {
        await recordChatExecutionPersistenceUnknownDurably(
          context.executionScope,
          context.requestId,
          unknownPayload,
        );
      } catch (unknownError) {
        console.error('[ChatHandler] Replacement unknown receipt persistence failed:', unknownError);
      }
      context.publishRecordedAgent('agent:response', unknownPayload);
      await releaseChatSession();
      { return { terminal: true as const, context: undefined }; }
    }
    if (superseded?.terminalEvent && context.turnAuthorization.isCurrent()) {
      context.io.to(context.executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    if (!context.acknowledged) {
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
    }
  return { terminal: false as const, context: extendTurnBindings(context, {
    releaseChatSession: releaseChatSession as typeof releaseChatSession,
  }) };
}

async function prepareChatPriorTaskQuery(context: NonNullable<Awaited<ReturnType<typeof startChatForegroundTurn>>["context"]>) {

      // The turn may have waited behind one or more executions. Re-read the
      // durable conversation and resolve the user's feedback against that
      // exact revision. Never merge a receive-time task id/revision over a
      // newer state: explicit controls are optimistic-concurrency fences.
      context.turnAuthorization.assertCurrent();
      const refreshedConversation = getConversationForScope(
        context.conversation.id,
        context.uid,
        context.resolvedDomain,
        context.resolvedOrgId,
      );
      if (!refreshedConversation) {
        await context.commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: 'Conversation is unavailable for this user or workspace',
            code: 'CHAT_CONVERSATION_REFRESH_FAILED',
          },
          errorContext: 'Conversation refresh failure terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }
      context.conversation = refreshedConversation;
      // Explicit memory edits own a durable turn without entering task/tool planning.
      if (!context.isMemoryAvatar && isExplicitMemoryRequest(context.visibleUserText)) {
        const receipt = await persistTurnMemory({ userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId,
          userText: context.visibleUserText, channel: 'chat', source: context.eventSource, requestId: context.requestId, conversationId: context.conversation.id,
          agentId: context.conversationAgentId, authorization: context.turnAuthorization, signal: context.abortController.signal, llmGetters: context.llmGetters });
        await context.commitChatReply({
          text: receipt.text,
          blocked: receipt.status === 'failed',
          reason: receipt.status === 'saved' ? 'memory_saved' : 'memory_not_saved',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'memory',
            llmWasCalled: true,
            skipActionContinuation: true,
          }),
          errorContext: 'Explicit memory terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }
      context.resolvedTaskRelation = revalidateAcceptedTaskRelation(context.resolvedTaskRelation, context.conversation.actionContinuationState);
      context.emitAgent('agent:task_relation', { relation: context.resolvedTaskRelation });
      if (context.resolvedTaskRelation.binding === 'stale' || (
        context.userObservedCompletionTaskId
        && context.conversation.actionContinuationState?.taskId !== context.userObservedCompletionTaskId
      )) {
        await context.commitChatReply({
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          reason: context.resolvedTaskRelation.reason || 'stale_control',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'stale_task_control',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          errorContext: 'Stale foreground task terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      if (context.userObservedCompletionTaskId && isUserObservedTaskCompletion(context.visibleUserText, context.conversation.actionContinuationState)) {
        const observedTask = context.conversation.actionContinuationState!;
        await clearPendingConfirmationDurably(context.uid, buildTransportNeutralConfirmationScope({
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          conversationId: context.conversation.id,
          taskId: observedTask.taskId,
        }));
        context.pendingConfirmation = null;
        context.pendingConfirmationPrompt = '';
        const responseText = formatConversationActionTaskStatus({
          ...observedTask, status: 'completed', unfinished: false,
          latestBlocker: '', completionSource: 'user_observation',
        });
        await context.commitDeterministicTerminal({
          payload: {
            text: responseText, agentName: 'Lumi', finalized: true,
            blocked: false, reason: 'task_user_observation',
          },
          persistAssistantMessage: () => {
            const completed = completeConversationActionFromUserObservation(
              context.conversation.id, context.uid, context.visibleUserText,
              { taskId: observedTask.taskId!, requestId: context.requestId, userMessageId: context.acceptedUserMessageId },
            );
            if (!completed) throw new Error('User observation no longer owns the pending task');
            context.addMessageIdempotent({ conversationId: context.conversation.id,
              role: 'assistant', content: responseText,
              source: 'chat_task_user_observation',
              cognitiveIntent: 'task_user_observation', llmWasCalled: false, skipActionContinuation: true,
            });
          },
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id, agentId: context.conversationAgentId,
            source: 'chat_task_user_observation',
          }),
          errorContext: 'User-observed task completion terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      if (context.resolvedTaskRelation.feedback === 'repeat') {
        // Restatement is an exact adjacent-turn read, not a planning request.
        // Resolve it from the persisted transcript so it cannot fall back to
        // an older task, consume model capacity, or inherit tool permissions.
        const repeatTranscript = getMessages(context.conversation.id);
        let acceptedRepeatIndex = -1;
        for (let index = repeatTranscript.length - 1; index >= 0; index -= 1) {
          const item = repeatTranscript[index];
          if (
            item.role === 'user'
            && String(item.requestId || item.externalMessageId || '') === context.requestId
          ) {
            acceptedRepeatIndex = index;
            break;
          }
        }
        const responseText = findLatestRepeatableAssistantReply(
          acceptedRepeatIndex >= 0 ? repeatTranscript.slice(0, acceptedRepeatIndex) : [],
        ) || CN_TASK_EXECUTION_MESSAGES.noRepeatableReply;
        await context.commitChatReply({
          text: responseText,
          reason: 'repeat_previous_reply',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'task_repeat',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id,
            agentId: context.conversationAgentId,
            source: context.eventSource,
          }),
          errorContext: 'Adjacent reply repeat terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      const adjacentConfirmedAction = !context.pendingConfirmation
        && !context.conversation.actionContinuationState?.unfinished
        && isExplicitConfirmationReply(context.visibleUserText)
        ? findAdjacentVerifiedConfirmedAction({
            messages: getMessages(context.conversation.id, 32),
            currentRequestId: context.requestId,
          })
        : null;
      const repeatedConfirmationWithoutPending = Boolean(adjacentConfirmedAction);
      if (repeatedConfirmationWithoutPending) {
        const responseText = CN_TASK_EXECUTION_MESSAGES.noPendingConfirmation;
        await context.commitChatReply({
          text: responseText,
          reason: 'no_pending_confirmation',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'duplicate_confirmation_noop',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id,
            agentId: context.conversationAgentId,
            source: context.eventSource,
          }),
          errorContext: 'Duplicate confirmation no-op terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      // Prior-turn receipt questions are deterministic ledger reads. Resolve
      // them before memory embeddings, RAG, personality assembly, or any model
      // client so a slow provider cannot block a local execution-status answer.
      const runtimeStatusOwnsThisTurn = context.explicitRuntimeWorkStatusRequest
        && !(
          context.resolvedTaskRelation.feedback === 'status'
          && ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
          && Boolean(context.resolvedTaskRelation.taskId)
        );
      const acceptedFollowupIntent = runtimeStatusOwnsThisTurn
        ? 'none' as const
        : taskRelationFollowupIntent(context.resolvedTaskRelation);
      const acceptedNormalizedIntent = context.acceptedTurnResolution!.userIntent;
      const confirmationNeedsFreshReview = Boolean(
        acceptedFollowupIntent === 'status'
        && isExplicitConfirmationReply(context.visibleUserText)
        && conversationActionRequiresFreshConfirmationReview(
          context.conversation.actionContinuationState,
        ),
      );
      const asksToRecheckPreviousAction = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'previous_action';
      const asksAboutBoundConversationTask = acceptedFollowupIntent === 'status'
        && ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
        && Boolean(context.resolvedTaskRelation.taskId)
        && (
          acceptedNormalizedIntent.kind === 'none'
          || (
            acceptedNormalizedIntent.kind === 'status_query'
            && ['previous_action', 'recent_task'].includes(acceptedNormalizedIntent.target)
          )
        );
      const asksAboutRecentConversationTask = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'recent_task';
      const serverBoundRecheckTaskId = asksToRecheckPreviousAction
        ? String(context.resolvedTaskRelation.taskId || '').trim()
        : '';
      const mayUseUnboundRecheckFallback = asksToRecheckPreviousAction
        && !serverBoundRecheckTaskId
        && context.resolvedTaskRelation.binding === 'conversation'
        && !context.controlTargetRequestId
        && !context.controlTargetTaskId
        && context.controlTargetRevision === undefined;
      const previousActionState = asksToRecheckPreviousAction
        ? serverBoundRecheckTaskId
          ? getConversationActionStateByTaskId(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
              conversationId: context.conversation.id,
              userId: context.uid,
              taskId: serverBoundRecheckTaskId,
            })
          : mayUseUnboundRecheckFallback
            ? getConversationActionStateFromLedger(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
                conversationId: context.conversation.id,
                userId: context.uid,
                query: context.visibleUserText,
              })
            : null
        : null;
      const runtimeCancellationRecheck = pendingRuntimeCancellationRecheck(previousActionState);
  return { terminal: false as const, context: extendTurnBindings(context, {
    runtimeCancellationRecheck: runtimeCancellationRecheck as typeof runtimeCancellationRecheck,
    previousActionState: previousActionState as typeof previousActionState,
    acceptedFollowupIntent: acceptedFollowupIntent as typeof acceptedFollowupIntent,
    confirmationNeedsFreshReview: confirmationNeedsFreshReview as typeof confirmationNeedsFreshReview,
    asksAboutBoundConversationTask: asksAboutBoundConversationTask as typeof asksAboutBoundConversationTask,
    asksAboutRecentConversationTask: asksAboutRecentConversationTask as typeof asksAboutRecentConversationTask,
    acceptedNormalizedIntent: acceptedNormalizedIntent as typeof acceptedNormalizedIntent,
    serverBoundRecheckTaskId: serverBoundRecheckTaskId as typeof serverBoundRecheckTaskId,
  }) };
}

async function prepareChatConversationContext(context: NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>["context"]>) {

      if (await answerPriorTaskStatus(context)) { return { terminal: true as const, context: undefined }; }

      // `deferActionPreparation` persisted only the transcript while this
      // request waited. Now that this request owns the serial lease, bind its
      // exact user row. A different pending request is an integrity failure,
      // not permission to overwrite the pointer and mis-attribute receipts.
      if (context.resolvedTaskRelation.feedback !== 'status') {
        const preserveExistingTask = (
          ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
          && ['continue', 'correction', 'accept', 'retry', 'repeat'].includes(
            context.resolvedTaskRelation.feedback,
          )
        );
        const boundTurn = bindConversationActionExecutionTurn({
          conversationId: context.conversation.id,
          userId: context.uid,
          userText: context.visibleUserText,
          requestId: context.requestId,
          userMessageId: context.acceptedUserMessageId,
          preserveExistingTask,
        });
        if (!boundTurn) {
          await context.commitDeterministicTerminal({
            event: 'agent:error',
            payload: {
              message: 'Unable to bind this queued message to the action pipeline',
              code: 'CHAT_ACTION_TURN_BIND_FAILED',
            },
            errorContext: 'Action turn binding failure terminal',
          });
          await context.releaseChatSession();
          { return { terminal: true as const, context: undefined }; }
        }
        context.conversation = getConversationForScope(
          context.conversation.id,
          context.uid,
          context.resolvedDomain,
          context.resolvedOrgId,
        ) || context.conversation;
      }
      let { relevantMemories, ragChunks, emotionalState, personalityConfig, kbContext, isNovel, himState, emotionKey } = await retrieveChatContext(context);

      // ── Conversation mode: get/create conversation, apply mode from payload ──
      const conversationId = context.conversation?.id;
      if (context.conversationTurn.rolledOver) {
        console.log(
          '[ChatHandler] rolled over oversized conversation:',
          context.conversationTurn.previousConversationId,
          '->',
          conversationId,
        );
        // The client may still send its old local transcript after a server-side
        // rollover. Re-evaluate direct client intent without letting that stale
        // transcript reactivate a prior UI task.
        context.chatContextBridge = buildClientSurfaceContinuationBridge(context.visibleUserText, []);
        await clearPendingConfirmationDurably(context.uid, context.confirmationScope);
        context.pendingConfirmation = null;
        context.pendingConfirmationPrompt = '';
      }
      const conversationMode = context.payloadMode || context.conversation?.mode || undefined;
      if (context.conversation && context.payloadMode && context.payloadMode !== context.conversation.mode) {
        setConversationMode(context.conversation.id, context.payloadMode);
      }
      console.log('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      if (conversationId && context.confirmationCancellationRequested) {
        const cancelled = cancelConversationActionExecution(conversationId, context.uid);
        const cancelledCurrentTask = cancelled?.status === 'cancelled';
        if (cancelledCurrentTask || context.pendingConfirmationCleared) {
          const responseText = context.pendingConfirmationCleared
            ? '已取消刚才等待确认的操作；它没有执行，也不会继续发送。'
            : CN_TASK_EXECUTION_MESSAGES.cancelled;
          await context.commitDeterministicTerminal({
            payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
            persistAssistantMessage: () => context.addMessageIdempotent({ conversationId, role: 'assistant', content: responseText, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
            publishAfter: () => context.emitConversationUpdated({ conversationId, agentId: context.conversationAgentId, source: 'chat', rolledOver: context.conversationTurn.rolledOver, previousConversationId: context.conversationTurn.previousConversationId }),
            errorContext: 'Pending confirmation cancellation terminal',
          });
          await context.releaseChatSession();
          { return { terminal: true as const, context: undefined }; }
        }
        const boundTerminalTask = context.resolvedTaskRelation.taskId
          ? getConversationActionStateByTaskId(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
              conversationId,
              userId: context.uid,
              taskId: context.resolvedTaskRelation.taskId,
            })
          : getLatestConversationActionState(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), { conversationId, userId: context.uid });
        if (boundTerminalTask && !boundTerminalTask.unfinished) {
          const english = !/[\u3400-\u9fff]/u.test(context.visibleUserText);
          const responseText = english
            ? boundTerminalTask.status === 'completed'
              ? `The task "${boundTerminalTask.goal || 'the previous task'}" is already completed. Cancellation cannot undo its recorded result, and I did not execute anything again.`
              : `The task "${boundTerminalTask.goal || 'the previous task'}" is already ${boundTerminalTask.status || 'terminal'}. There is nothing left to stop, and I did not execute anything again.`
            : CN_TASK_EXECUTION_MESSAGES.terminalCannotCancel(
                boundTerminalTask.goal,
                boundTerminalTask.status || 'terminal',
              );
          await context.commitChatReply({
            text: responseText,
            reason: 'task_already_terminal',
            message: () => ({
              conversationId,
              cognitiveIntent: 'task_already_terminal',
              llmWasCalled: false,
              skipActionContinuation: true,
            }),
            publishAfter: () => context.emitConversationUpdated({
              conversationId,
              agentId: context.conversationAgentId,
              source: 'chat',
              rolledOver: context.conversationTurn.rolledOver,
              previousConversationId: context.conversationTurn.previousConversationId,
            }),
            errorContext: 'Terminal task cancellation no-op',
          });
          await context.releaseChatSession();
          { return { terminal: true as const, context: undefined }; }
        }
        const responseText = '当前没有等待确认或正在执行的操作。';
        await context.commitDeterministicTerminal({
          payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
          persistAssistantMessage: () => context.addMessageIdempotent({ conversationId, role: 'assistant', content: responseText, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
          publishAfter: () => context.emitConversationUpdated({ conversationId, agentId: context.conversationAgentId, source: 'chat', rolledOver: context.conversationTurn.rolledOver, previousConversationId: context.conversationTurn.previousConversationId }),
          errorContext: 'No pending confirmation terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      const persistedConversationHistory = conversationId
        ? getMessages(conversationId, TASK_TARGET_HISTORY_LIMIT).filter(record => !(
            record.role === 'user'
            && (
              record.requestId === context.requestId
              || (
                record.externalMessageId === context.requestId
                && record.source === context.eventSource
                && record.channel === 'chat'
              )
            )
          ))
        : [];
      if (!context.chatContextBridge && conversationId && isShortClientContinuation(context.visibleUserText)) {
        const dbHistoryItems = persistedConversationHistory.slice(-12)
          .map(record => ({ role: record.role, message: record.message, response: record.response }));
        context.chatContextBridge = buildClientSurfaceContinuationBridge(context.visibleUserText, dbHistoryItems);
      }
      context.actionContinuationBridge = context.explicitRuntimeWorkStatusRequest
        ? ''
        : buildRecentActionContinuationBridge(
            context.visibleUserText,
            context.conversationTurn.rolledOver
              ? persistedConversationHistory
              : [...context.historyItems, ...persistedConversationHistory],
            context.conversation?.actionContinuationState,
          );
      const taskRelationContext = formatActiveTaskRelationContext(
        context.resolvedTaskRelation,
        context.conversation?.actionContinuationState,
      );
      if (taskRelationContext) {
        context.actionContinuationBridge = [context.actionContinuationBridge, taskRelationContext]
          .filter(Boolean)
          .join('\n\n');
      }
      const operationMode = (() => {
        if (typeof context.data.operationMode === 'string') return normalizeOperationMode(context.data.operationMode);
        try {
          return getStoredOperationMode(context.uid);
        } catch {}
        return 'assistant';
      })();
      let { turnFlow, executionPipeline, personality, effectiveSystemPrompt, executionTaskText, completionTaskText } = await prepareChatPromptContext(extendTurnBindings(context, {
    get relevantMemories(): typeof relevantMemories { return relevantMemories; },
    set relevantMemories(value: typeof relevantMemories) { relevantMemories = value; },
    get ragChunks(): typeof ragChunks { return ragChunks; },
    set ragChunks(value: typeof ragChunks) { ragChunks = value; },
    get emotionalState(): typeof emotionalState { return emotionalState; },
    set emotionalState(value: typeof emotionalState) { emotionalState = value; },
    get personalityConfig(): typeof personalityConfig { return personalityConfig; },
    set personalityConfig(value: typeof personalityConfig) { personalityConfig = value; },
    conversationId: conversationId as typeof conversationId,
    conversationMode: conversationMode as typeof conversationMode,
    operationMode: operationMode as typeof operationMode,
    persistedConversationHistory: persistedConversationHistory as typeof persistedConversationHistory,
    get kbContext(): typeof kbContext { return kbContext; },
    set kbContext(value: typeof kbContext) { kbContext = value; },
  }));
  return { terminal: false as const, context: extendTurnBindings(context, {
    get turnFlow(): typeof turnFlow { return turnFlow; },
    set turnFlow(value: typeof turnFlow) { turnFlow = value; },
    get executionPipeline(): typeof executionPipeline { return executionPipeline; },
    set executionPipeline(value: typeof executionPipeline) { executionPipeline = value; },
    conversationId: conversationId as typeof conversationId,
    get personality(): typeof personality { return personality; },
    set personality(value: typeof personality) { personality = value; },
    persistedConversationHistory: persistedConversationHistory as typeof persistedConversationHistory,
    get effectiveSystemPrompt(): typeof effectiveSystemPrompt { return effectiveSystemPrompt; },
    set effectiveSystemPrompt(value: typeof effectiveSystemPrompt) { effectiveSystemPrompt = value; },
    operationMode: operationMode as typeof operationMode,
    get executionTaskText(): typeof executionTaskText { return executionTaskText; },
    set executionTaskText(value: typeof executionTaskText) { executionTaskText = value; },
    get completionTaskText(): typeof completionTaskText { return completionTaskText; },
    set completionTaskText(value: typeof completionTaskText) { completionTaskText = value; },
    get emotionalState(): typeof emotionalState { return emotionalState; },
    set emotionalState(value: typeof emotionalState) { emotionalState = value; },
    get isNovel(): typeof isNovel { return isNovel; },
    set isNovel(value: typeof isNovel) { isNovel = value; },
    get himState(): typeof himState { return himState; },
    set himState(value: typeof himState) { himState = value; },
    get emotionKey(): typeof emotionKey { return emotionKey; },
    set emotionKey(value: typeof emotionKey) { emotionKey = value; },
  }) };
}

async function prepareChatTerminalWriters(context: NonNullable<Awaited<ReturnType<typeof prepareChatConversationContext>>["context"]>) {

      const interactionId = crypto.randomUUID();

      const emitToolLifecycle = (payload: {
        correlationId: string;
        name: string;
        arguments: Record<string, any>;
        args?: Record<string, any>;
        result?: string;
        error?: string;
        artifactReceipt?: MediaArtifactReceipt;
      }) => {
        const normalized = { ...payload, args: payload.args ?? payload.arguments };
        context.emitAgent("agent:tool_call", normalized);
        context.emitAgent("agent:tool", normalized);
      };
      const persistChatLearning = (
        assistantText: string,
        options: {
          channel?: 'chat' | 'workflow';
          toolRecords?: ToolExecutionRecord[];
          sourceInteractionId?: string;
          logLabel?: string;
        } = {},
      ) => {
        if (!context.turnAuthorization.isCurrent()) return;
        persistLumiPostTurnLearning(
          {
            userId: context.uid,
            userText: context.text,
            defaultChannel: 'chat',
            flow: context.turnFlow,
            getToolNames: () => toolRegistry.getToolDeclarations({
              context: { userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId, source: context.eventSource },
            }).map(declaration => declaration.function.name),
            domain: context.resolvedDomain,
            orgId: context.resolvedOrgId,
            defaultSourceInteractionId: interactionId,
            agentId: context.conversationAgentId,
            source: context.eventSource,
            log: { info: console.log, warn: console.warn },
          },
          assistantText,
          options,
        );
      };
      const persistChatTakeoverExecution = (
        assistantText: string,
        options: {
          toolRecords?: ToolExecutionRecord[];
          source?: string;
          sourceInteractionId?: string;
          capabilitySelection?: ReturnType<typeof buildLumiCapabilitySelection>;
          finalizationBlocked?: boolean;
          assistantTextTrusted?: boolean;
          finalizationReason?: string;
        } = {},
      ) => {
        const currentToolRecords = options.toolRecords || [];
        // Historical/status-only responses have no current-turn execution
        // ledger and must not replay old receipts into task state.
        if (currentToolRecords.length === 0) return null;
        const executionWriteback = persistWorkTakeoverTurnExecution({
          userId: context.uid,
          userText: context.text,
          assistantText,
          source: options.source || 'chat',
          interactionId: options.sourceInteractionId || interactionId,
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          flow: context.turnFlow,
          capabilitySelection: options.capabilitySelection || context.executionPipeline.capabilityPlan,
          toolRecords: currentToolRecords,
          finalizationBlocked: options.finalizationBlocked === true,
          assistantTextTrusted: options.assistantTextTrusted
            ?? options.finalizationBlocked !== true,
          finalizationReason: options.finalizationReason,
        });
        return executionWriteback;
      };
      const refreshDurableTaskRelation = (
        exactTaskId = context.resolvedTaskRelation?.taskId || '',
      ): ActiveTaskMessageResolution | null => {
        return context.refreshResolvedTaskRelationFromLedger(context.conversationId, exactTaskId);
      };
      const refreshTerminalPayloadTaskRelation = (
        payload: Record<string, any>,
        exactTaskId = context.resolvedTaskRelation?.taskId || '',
      ) => {
        const relation = refreshDurableTaskRelation(exactTaskId);
        if (relation) payload.taskRelation = relation;
        return relation;
      };
      const publishDurableTaskRelation = (exactTaskId = context.resolvedTaskRelation?.taskId || '') => {
        if (!context.turnAuthorization.isCurrent()) return;
        const relation = refreshDurableTaskRelation(exactTaskId);
        if (!relation) return;
        context.io.to(context.executionRoom).emit('agent:task_relation', {
          relation,
          taskRelation: relation,
          source: context.eventSource,
          requestId: context.requestId,
          conversationId: context.conversationId,
          phase: 'terminal_persisted',
        });
      };

      /** One receipt/publication path for cleanup, confirmation and model results. */
      const commitRecordedTerminal = (input: {
        payload: Record<string, any>;
        unknownPayload: Record<string, any>;
        persistTerminalState: () => ReturnType<typeof persistChatTakeoverExecution>;
        persistAssistantMessage: () => void;
        notification?: Record<string, any>;
        llmWasCalled?: boolean;
        repairUnknownAssistant?: boolean;
        updateSource?: string;
        errorContext: string;
      }) => commitChatTerminalBoundary({
        persistTerminalState: input.persistTerminalState,
        persistAssistantMessage: input.persistAssistantMessage,
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => context.persistAuthorizedTerminalReceipt(
          'agent:response', input.payload, input.unknownPayload,
        ),
        persistUnknownReceipt: async () => {
          if (input.repairUnknownAssistant && context.conversationId) {
            const updated = updateAssistantMessageTerminalPresentation({
              userId: context.uid, conversationId: context.conversationId, requestId: context.requestId, content: input.unknownPayload.text,
              completionFeedback: input.unknownPayload.completionFeedback, source: context.eventSource, channel: 'chat',
            });
            if (!updated) context.addMessageIdempotent({ conversationId: context.conversationId,
              role: 'assistant', content: input.unknownPayload.text, personality: context.personality.id,
              cognitiveIntent: 'persistence_unknown', llmWasCalled: input.llmWasCalled,
              completionFeedback: input.unknownPayload.completionFeedback });
            try { await flushDBOrThrow(); } catch {}
          }
          return recordChatExecutionPersistenceUnknownDurably(context.executionScope, context.requestId, input.unknownPayload);
        },
        publishCommitted: executionWriteback => {
          if (input.notification) context.publishRecordedAgent('agent:notification', context.normalizeAgentPayload('agent:notification', input.notification));
          if (executionWriteback?.recorded) context.publishRecordedAgent('agent:task_execution_writeback', context.normalizeAgentPayload('agent:task_execution_writeback', executionWriteback));
          context.publishRecordedAgent('agent:response', input.payload);
          publishDurableTaskRelation();
          if (context.conversationId) context.emitConversationUpdated({ conversationId: context.conversationId, agentId: context.conversationAgentId,
            source: input.updateSource || 'chat', rolledOver: context.conversationTurn.rolledOver,
            previousConversationId: context.conversationTurn.previousConversationId });
        },
        publishUnknown: () => context.publishRecordedAgent('agent:response', input.unknownPayload),
        persistenceUnknownProjection: { text: input.unknownPayload.text,
          completionFeedback: input.unknownPayload.completionFeedback, reason: 'Terminal persistence outcome is unknown.' },
        onPersistenceError: error => console.error('[ChatHandler] ' + input.errorContext, error),
      });

      const actionFollowupIntent = context.executionPipeline.actionFollowupIntent;
      const operationModeMetaText = buildOperationModeMetaResponse({
        text: context.visibleUserText,
        operationMode: context.turnFlow.operationMode,
        source: context.eventSource,
      });
      const executionFactText = context.conversationId && isConversationExecutionFactQuestion(context.visibleUserText)
        ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId: context.conversationId,
          userId: context.uid,
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          currentRequestId: context.requestId,
        }), context.visibleUserText)
        : '';
      const exactCorrectionText = context.conversationId
        ? resolveExactConversationCorrection(context.visibleUserText, context.persistedConversationHistory)
        : null;
      const deterministicConversationResponse = operationModeMetaText
        ? {
            text: operationModeMetaText,
            intent: 'operation_mode_facts',
            source: 'chat_operation_mode_facts',
          }
        : executionFactText
        ? {
            text: executionFactText,
            intent: 'execution_facts',
            source: 'chat_conversation_execution_facts',
          }
        : exactCorrectionText
          ? {
              text: exactCorrectionText,
              intent: 'exact_correction',
              source: 'chat_exact_correction',
            }
          : null;
      if (deterministicConversationResponse) {
        await context.commitDeterministicTerminal({
          payload: {
            text: deterministicConversationResponse.text,
            agentName: context.personality.name,
            finalized: true,
            blocked: false,
            reason: deterministicConversationResponse.intent,
          },
          persistAssistantMessage: context.conversationId
            ? () => context.addMessageIdempotent({
            conversationId: context.conversationId,
            role: 'assistant',
            content: deterministicConversationResponse.text,
            personality: context.personality.id,
            source: deterministicConversationResponse.source,
            cognitiveIntent: deterministicConversationResponse.intent,
            llmWasCalled: false,
          })
            : undefined,
          publishAfter: context.conversationId
            ? () => {
            context.emitConversationUpdated({
            conversationId: context.conversationId,
            agentId: context.conversationAgentId,
            source: deterministicConversationResponse.source,
            rolledOver: context.conversationTurn.rolledOver,
              previousConversationId: context.conversationTurn.previousConversationId,
            });
          }
            : undefined,
          errorContext: 'Deterministic conversation terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      const groundedTurnEvidence: string[] = [];
      if (context.conversationId && actionFollowupIntent === 'status') {
        groundedTurnEvidence.push(`Current action status evidence:\n${getConversationActionStatus(
          context.conversationId,
          context.uid,
          context.visibleUserText,
          context.conversation?.actionContinuationState,
          context.resolvedTaskRelation.taskId || '',
        )}`);
      }
      const recentFailureExplanation = context.conversationId && !context.pendingConfirmation
        ? buildRecentFailureExplanation(context.visibleUserText, getMessages(context.conversationId, 24))
        : '';
      if (recentFailureExplanation) {
        groundedTurnEvidence.push(`Recent failure evidence:\n${recentFailureExplanation}`);
      }
      if (groundedTurnEvidence.length) {
        context.effectiveSystemPrompt += [
          '',
          '## Grounded current-turn evidence',
          'Use these server-grounded facts to answer the newest user turn naturally. They are evidence, not a canned response: reason over them, preserve uncertainty, and do not invent execution beyond recorded receipts.',
          ...groundedTurnEvidence,
        ].join('\n\n');
      }

      let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
      let runtimeOwnedDeterministicRecoveryCall: ToolContext['runtimeOwnedDeterministicRecoveryCall'] | null = null;
      let pendingConfirmationAssistantState = '';
      const requestToolConfirmation = createTurnConfirmation({
        userId: context.uid, source: context.eventSource, requestId: context.requestId, actionIntent: context.visibleUserText,
        pending: context.pendingConfirmation,
        consumeScope: () => context.confirmationScope,
        proposalScope: () => {
          context.confirmationScope = buildTransportNeutralConfirmationScope({
            domain: context.resolvedDomain, orgId: context.resolvedOrgId, conversationId: context.conversationId || context.selectedConversationId,
            taskId: actionTaskExecution.state?.taskId, originRequestId: context.requestId,
          });
          context.confirmationChannelScope = buildTransportNeutralConfirmationScope({
            domain: context.resolvedDomain, orgId: context.resolvedOrgId, conversationId: context.conversationId || context.selectedConversationId,
          });
          return context.confirmationScope;
        },
        correctionRequiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
        exactWriteCorrection: context.correctionRequiresFreshConfirmation && context.confirmationResolution.revokedCorrectionBasis?.toolName === 'write_file',
        recoveryCall: () => runtimeOwnedDeterministicRecoveryCall,
        assertCurrent: () => context.turnAuthorization.assertCurrent(),
        isCancelled: context.isChatCancelled,
        onPending: pending => {
          pendingConfirmationCreatedThisTurn = pending;
          pendingConfirmationAssistantState = formatPendingConfirmationRequest(pending);
          if (context.conversationId) setConversationActionExecutionStatus(context.conversationId, context.uid, 'waiting_confirmation', {
            assistantState: pendingConfirmationAssistantState, requestId: context.requestId,
          });
        },
      });

      context.emitAgent("agent:status", { status: "thinking", agentName: context.personality.name });
      console.log('[ChatHandler] emitted agent:status thinking');

      // Inject operation mode prompt overlay
      const effectiveOperationMode = context.turnFlow.effectiveOperationMode;
      const selfRepairTurn = context.turnFlow.selfRepairTurn;
      const clientActionOnlyTurn = context.turnFlow.clientActionOnlyTurn;
      const workSurfaceRoute = context.turnFlow.workSurfaceRoute;
      const visionIntent = context.turnFlow.visionIntent;
      const executionDecision = context.executionPipeline.execution;
      const intentTrace = context.executionPipeline.intentTrace;
      const capabilitySelection = context.executionPipeline.capabilityPlan;
      const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
        channel: 'chat',
        text: context.turnFlow.routeText,
        flow: context.turnFlow,
        capabilitySelection,
        capabilityExecutionPlan: context.executionPipeline.executionPlan,
      });
      const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
      const toolRoute = executionDecision.toolRoute;
      const modelCapabilityPolicy = context.executionPipeline.authorizationPolicy;
      const modelToolProjection = context.executionPipeline.modelToolProjection;
      const existingActionState = context.conversation?.actionContinuationState;
      const toolSessionActive = !context.isMemoryAvatar && context.executionPipeline.executionRequested
        && modelToolProjection.toolNames.length > 0;
      // The semantic execution plan owns durable task creation. Main Chat may
      // expose a tool manifest to the model for open-ended reasoning, but that
      // alone does not make a greeting or ordinary conversation an executable
      // task. Only turns whose flow requires completion evidence/tool work (or
      // a pending confirmation) receive a durable task identity before relay.
      const bindsExistingAction = Boolean(
        existingActionState?.taskId
        && ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
        && ['continue', 'correction', 'accept', 'retry'].includes(context.resolvedTaskRelation.feedback),
      );
      // Cleanup creates its own task; a bound continuation or pending grant resumes the existing task.
      const resumesAction = Boolean(
        (bindsExistingAction && context.conversationId) || (existingActionState?.taskId && context.pendingConfirmation),
      );
      const preparation = context.acceptedRuntimeCleanupOffer && context.conversationId
        ? {
            conversationId: context.conversationId,
            toolPolicy: { allowedTools: ['runtime_work_cancel'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 },
            forceTask: true, forceNewTask: true, preserveExistingTask: false,
          }
        : resumesAction
          ? {
              conversationId: context.conversationId || context.selectedConversationId,
              toolPolicy: modelCapabilityPolicy, followupIntent: actionFollowupIntent,
              forceResume: true, preserveExistingTask: true,
            }
          : context.conversationId && (capabilitySelection.taskLedgerRequired || context.pendingConfirmation || context.structuredMediaRequest)
            ? { conversationId: context.conversationId, toolPolicy: modelCapabilityPolicy, followupIntent: actionFollowupIntent, forceTask: true }
            : null;
      const actionTaskExecution = preparation
        ? prepareConversationActionExecution({
            userId: context.uid, userText: context.visibleUserText, requestId: context.requestId, userMessageId: context.acceptedUserMessageId,
            ...preparation,
          })
        : { state: null, kind: 'conversation' as const, turnRowId: undefined };
  return { terminal: false as const, context: extendTurnBindings(context, {
    actionTaskExecution: actionTaskExecution as typeof actionTaskExecution,
    get runtimeOwnedDeterministicRecoveryCall(): typeof runtimeOwnedDeterministicRecoveryCall { return runtimeOwnedDeterministicRecoveryCall; },
    set runtimeOwnedDeterministicRecoveryCall(value: typeof runtimeOwnedDeterministicRecoveryCall) { runtimeOwnedDeterministicRecoveryCall = value; },
    emitToolLifecycle: emitToolLifecycle as typeof emitToolLifecycle,
    modelCapabilityPolicy: modelCapabilityPolicy as typeof modelCapabilityPolicy,
    modelToolProjection: modelToolProjection as typeof modelToolProjection,
    desktopExecutionTracker: desktopExecutionTracker as typeof desktopExecutionTracker,
    toolSessionActive: toolSessionActive as typeof toolSessionActive,
    executionDecision: executionDecision as typeof executionDecision,
    effectiveOperationMode: effectiveOperationMode as typeof effectiveOperationMode,
    clientActionOnlyTurn: clientActionOnlyTurn as typeof clientActionOnlyTurn,
    selfRepairTurn: selfRepairTurn as typeof selfRepairTurn,
    capabilitySelection: capabilitySelection as typeof capabilitySelection,
    intentTrace: intentTrace as typeof intentTrace,
    toolRoute: toolRoute as typeof toolRoute,
    desktopExecutionPolicy: desktopExecutionPolicy as typeof desktopExecutionPolicy,
    workSurfaceRoute: workSurfaceRoute as typeof workSurfaceRoute,
    requestToolConfirmation: requestToolConfirmation as typeof requestToolConfirmation,
    commitRecordedTerminal: commitRecordedTerminal as typeof commitRecordedTerminal,
    persistChatTakeoverExecution: persistChatTakeoverExecution as typeof persistChatTakeoverExecution,
    interactionId: interactionId as typeof interactionId,
    refreshTerminalPayloadTaskRelation: refreshTerminalPayloadTaskRelation as typeof refreshTerminalPayloadTaskRelation,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    get pendingConfirmationAssistantState(): typeof pendingConfirmationAssistantState { return pendingConfirmationAssistantState; },
    set pendingConfirmationAssistantState(value: typeof pendingConfirmationAssistantState) { pendingConfirmationAssistantState = value; },
    persistChatLearning: persistChatLearning as typeof persistChatLearning,
    visionIntent: visionIntent as typeof visionIntent,
  }) };
}

async function prepareChatExecutionLeaseAndTools(context: NonNullable<Awaited<ReturnType<typeof prepareChatTerminalWriters>>["context"]>) {

      if ('bindingFailure' in context.actionTaskExecution) {
        const staleText = context.actionTaskExecution.bindingFailure === 'busy'
          ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
          : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
        await context.commitDeterministicTerminal({
          payload: {
            text: staleText,
            agentName: context.personality.name,
            source: 'chat_turn_binding',
            finalized: true,
            blocked: true,
            reason: context.actionTaskExecution.diagnosticCode,
          },
          persistAssistantMessage: () => context.addMessageIdempotent({
            conversationId: context.conversation.id,
            role: 'assistant',
            content: staleText,
            personality: context.personality.id,
            source: 'chat_turn_binding',
            cognitiveIntent: context.actionTaskExecution.diagnosticCode,
            skipActionContinuation: true,
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id,
            agentId: context.conversationAgentId,
            source: 'chat_turn_binding',
          }),
          errorContext: 'Action turn binding terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }
      const durableTaskId = context.actionTaskExecution.state?.taskId;
      context.requestTaskId = durableTaskId;
      context.receiptObserver = createConversationReceiptObserver({
        userId: context.uid, conversationId: context.conversation.id, taskId: durableTaskId,
        requestId: context.requestId, turnRowId: context.actionTaskExecution.turnRowId, domain: context.resolvedDomain, orgId: context.resolvedOrgId,
      }, context.turnAuthorization.isCurrent);
      if (context.structuredMediaRequest && context.actionTaskExecution.state?.taskId) {
        const structuredMediaRecoveryCall = buildStructuredMediaDeterministicToolRecoveryCall(
          context.structuredMediaRequest,
          {
            taskId: context.actionTaskExecution.state.taskId,
            taskRevision: Math.max(0, Math.trunc(Number(context.actionTaskExecution.state.revision) || 0)),
            requestId: context.requestId,
          },
        );
        if (!structuredMediaRecoveryCall) {
          throw new Error('Unable to bind the structured media request to its durable task');
        }
        context.runtimeOwnedDeterministicRecoveryCall = structuredMediaRecoveryCall;
      } else {
        context.runtimeOwnedDeterministicRecoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
          context.actionTaskExecution.state,
          context.requestId,
          context.confirmationResolution.revokedCorrectionBasis,
        );
      }
      context.foregroundRequestIdentity = Object.freeze({
        conversationId: context.conversation.id,
        userId: context.uid,
        requestId: context.requestId,
        ...(durableTaskId ? { expectedTaskId: durableTaskId } : {}),
      });
      const leaseUnknownPayload = context.normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(context.visibleUserText),
        agentName: context.personality.name,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      context.actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({
        conversationId: context.conversation.id,
        userId: context.uid,
        requestId: context.requestId,
        abortController: context.abortController,
        onPersistenceUnknown: async () => {
          const recorded = await recordChatExecutionPersistenceUnknownDurably(
            context.executionScope,
            context.requestId,
            leaseUnknownPayload,
          );
          if (recorded) context.publishRecordedAgent('agent:response', leaseUnknownPayload);
        },
      });
      if (durableTaskId) {
        context.resolvedTaskRelation = bindPreparedTaskMessageRelation(context.resolvedTaskRelation, context.actionTaskExecution);
        context.emitAgent('agent:task_relation', { relation: context.resolvedTaskRelation, phase: 'prepared' });
      }
      // ── Desktop relay: route tools to the user's registered desktop client, not only this chat socket ──
      const desktopRelay = createDesktopRelay({
        io: context.io,
        userId: context.uid,
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        source: 'chat',
        taskId: durableTaskId,
        requestId: context.requestId,
        requestSocket: context.socket,
        emitToolLifecycle: context.emitToolLifecycle,
        onLateResult: context.receiptObserver.onDesktopLateResult,
        formatResultForLifecycle: context.formatToolResultForUi,
        // The foreground execution belongs to the durable task, not to this
        // transport connection. The relay still has its own bounded timeout.
        cancelOnRequestSocketDisconnect: false,
        signal: context.abortController.signal,
      });
      context.releaseDesktopControlLease = () => desktopRelay.releaseControlLease('chat_turn_complete');
      // The admitted request owns one capability context across execution, confirmation and recovery.
      const toolContext: ToolContext = {
        ...context.toolSecurityContext,
        userId: context.uid,
        taskId: durableTaskId,
        conversationId: context.conversation.id,
        turnId: context.requestId,
        turnRowId: context.actionTaskExecution.turnRowId,
        requestId: context.requestId,
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        desktopRelay,
        llmGetters: context.llmGetters,
        supervisedExternalCommits: true,
        allowLocalFileWrites: context.allowLocalFileWrites,
        localWriteIntentReason: context.localWriteIntentReason,
        executionSignal: context.abortController.signal,
        isCancelled: context.isChatCancelled,
        onProgress: context.forwardToolProgress,
        toolPolicy: context.modelCapabilityPolicy,
        modelToolProjection: context.modelToolProjection,
        actionIntent: context.visibleUserText,
        currentTurnExecutionRequested: context.executionPipeline.executionRequested,
        resolutionId: context.executionPipeline.resolution.id,
        trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
        routedTaskText: context.turnFlow.routeText,
        acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
        currentAppTarget: context.turnFlow.currentAppEditTarget,
      };

      const priorTaskRecords = context.actionTaskExecution.kind === 'resume'
        ? taskReceiptsToRecords(context.actionTaskExecution.state?.receipts || [])
        : [];
      const taskAwareRecords = (records: ToolExecutionRecord[]) => (
        coalesceToolExecutionRecords([...priorTaskRecords, ...records])
      );
      context.collectRequestTerminalRecords = () => withDesktopExecutionReceipt(context.requestToolRecords, context.desktopExecutionTracker);
      const needsExecutionPrompt = context.toolSessionActive && context.toolSecurityContext.executionBoundary !== 'remote_restricted';
      if (needsExecutionPrompt || (context.toolSecurityContext.executionBoundary !== 'remote_restricted' && context.turnFlow.conceptualCapabilityQuestion)) {
        context.effectiveSystemPrompt += '\n\n' + formatClientSelfPromptForTurn(context.uid, context.visibleUserText, { domain: context.resolvedDomain, orgId: context.resolvedOrgId });
      }
      console.log('[ChatHandler] tool gate:', context.executionDecision.allowToolUse ? 'authorized' : 'off', 'session:', context.toolSessionActive ? 'active' : 'conversation', 'operationMode:', context.operationMode, 'effective:', context.effectiveOperationMode, 'surface:', context.turnFlow.surface, 'clientActionOnly:', context.clientActionOnlyTurn, 'selfRepair:', context.selfRepairTurn, 'capabilityLane:', context.capabilitySelection.lane, 'trace:', context.intentTrace.summary, 'route:', context.toolRoute ? `${context.toolRoute.toolNames.length}/${context.toolRoute.totalAvailable} ${context.toolRoute.categories.join(',') || 'fallback'}` : 'none');
      if (context.turnAuthorization.isCurrent()) context.socket.emit('agent:intent_trace', context.intentTrace);
      if (context.toolRoute && context.turnAuthorization.isCurrent()) {
        context.socket.emit('agent:tool_route', {
          categories: context.toolRoute.categories,
          reasons: context.toolRoute.reasons,
          toolNames: context.toolRoute.toolNames,
          totalAvailable: context.toolRoute.totalAvailable,
          truncated: context.toolRoute.truncated,
          trace: context.intentTrace,
        });
      }
      const visiblePreferredTools = restrictVisibleToolNamesForExecutionBoundary(
        context.capabilitySelection.preferredTools,
        context.toolSecurityContext.executionBoundary,
      );
      const remoteRestricted = context.toolSecurityContext.executionBoundary === 'remote_restricted';
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
        source: context.eventSource,
      });
      if (context.desktopExecutionPolicy.applies && context.toolSecurityContext.executionBoundary !== 'remote_restricted') {
        context.emitAgent('agent:desktop_execution_policy', {
          reason: context.desktopExecutionPolicy.reason,
          evidenceTools: context.desktopExecutionPolicy.evidenceTools,
          actuationTools: context.desktopExecutionPolicy.actuationTools,
          verificationTools: context.desktopExecutionPolicy.verificationTools,
          source: context.eventSource,
        });
      }
      if (!remoteRestricted) {
        context.effectiveSystemPrompt += '\n\n' + buildInteractionModeOverlay(context.turnFlow);
      }
      if (context.workSurfaceRoute.promptOverlay && needsExecutionPrompt) {
        context.effectiveSystemPrompt += '\n\n' + context.workSurfaceRoute.promptOverlay;
      }
      context.effectiveSystemPrompt += '\n\n' + executionBoundaryPromptOverlay(
        context.executionDecision.promptOverlay,
        context.toolSecurityContext.executionBoundary,
      );
      if (needsExecutionPrompt) {
        context.effectiveSystemPrompt += '\n\n' + context.capabilitySelection.promptOverlay;
      }
      if (context.desktopExecutionPolicy.promptOverlay && needsExecutionPrompt) {
        context.effectiveSystemPrompt += '\n\n' + context.desktopExecutionPolicy.promptOverlay;
      }
      const visionRoutingOverlay = context.effectiveOperationMode !== 'meeting'
        && needsExecutionPrompt
        ? buildVisionRoutingOverlay(context.uid, context.text)
        : '';
      if (visionRoutingOverlay) {
        context.effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
      }
      if (needsExecutionPrompt) {
        context.effectiveSystemPrompt += '\n\n' + buildLumiOperatingKernelPrompt({
          channel: 'chat',
          flow: context.turnFlow,
        });
      }
  return { terminal: false as const, context: extendTurnBindings(context, {
    durableTaskId: durableTaskId as typeof durableTaskId,
    taskAwareRecords: taskAwareRecords as typeof taskAwareRecords,
    toolContext: toolContext as typeof toolContext,
    priorTaskRecords: priorTaskRecords as typeof priorTaskRecords,
    desktopRelay: desktopRelay as typeof desktopRelay,
  }) };
}

async function prepareChatRuntimeControlAndModel(context: NonNullable<Awaited<ReturnType<typeof prepareChatExecutionLeaseAndTools>>["context"]>) {

      const executesAcceptedRuntimeCleanupOffer = Boolean(
        context.acceptedRuntimeCleanupOffer
        && context.resolvedTaskRelation.feedback === 'accept'
        && context.resolvedTaskRelation.taskRelation === 'confirm'
      );
      if (executesAcceptedRuntimeCleanupOffer) {
        const offeredToolCall = context.acceptedRuntimeCleanupOffer!.toolCall;
        const exactArguments = {
          taskIds: [...offeredToolCall.arguments.taskIds],
        };
        const cleanupRecord = await executeToolCall({
          registry: toolRegistry,
          id: `runtime_cleanup_offer_${context.requestId}`,
          name: offeredToolCall.name,
          arguments: exactArguments,
          executionOrigin: 'deterministic_route',
          context: {
            ...context.toolSecurityContext,
            userId: context.uid,
            taskId: context.durableTaskId,
            conversationId: context.conversation.id,
            turnId: context.requestId,
            turnRowId: context.actionTaskExecution.turnRowId,
            requestId: context.requestId,
            domain: context.resolvedDomain,
            orgId: context.resolvedOrgId,
            toolPolicy: context.modelCapabilityPolicy,
            actionIntent: context.visibleUserText,
            currentTurnExecutionRequested: context.executionPipeline.executionRequested,
              resolutionId: context.executionPipeline.resolution.id,
            trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
            routedTaskText: context.visibleUserText,
            acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
            currentAppTarget: context.turnFlow.currentAppEditTarget,
            requestConfirmation: context.requestToolConfirmation,
            executionSignal: context.abortController.signal,
            isCancelled: context.isChatCancelled,
          },
        });
        context.emitToolLifecycle({
          correlationId: cleanupRecord.id || `runtime_cleanup_offer_${context.requestId}`,
          name: cleanupRecord.name,
          arguments: cleanupRecord.arguments,
          result: cleanupRecord.result,
          error: cleanupRecord.error,
        });
        let cleanupReceipt: Record<string, any> = {
          ok: false,
          status: 'failed',
          requestedTaskIds: exactArguments.taskIds,
          cancelledTaskIds: [],
          cancellingTaskIds: [],
          notCancelledTaskIds: exactArguments.taskIds,
          targetResults: exactArguments.taskIds.map(taskId => ({ taskId, status: 'failed' })),
        };
        try {
          const parsed = JSON.parse(String(cleanupRecord.result || '{}'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            cleanupReceipt = parsed;
          }
        } catch {}
        const cleanupVerified = !cleanupRecord.error
          && cleanupRecord.terminalVerification?.status === 'verified';
        const cleanupText = formatRuntimeCleanupReceipt(context.visibleUserText, cleanupReceipt);
        const cleanupReason = cleanupVerified
          ? 'runtime_cleanup_offer_completed'
          : 'runtime_cleanup_offer_incomplete';
        const cleanupCompletionFeedback = context.durableTaskId
          ? buildForegroundTaskCompletionFeedback({
              taskId: context.durableTaskId,
              taskLabel: context.visibleUserText,
              toolRecords: context.taskAwareRecords([cleanupRecord]),
              blocked: !cleanupVerified,
              reason: cleanupVerified ? '' : cleanupRecord.error
                || cleanupRecord.terminalVerification?.reason
                || cleanupReason,
            })
          : undefined;
        const cleanupTerminalPayload = context.normalizeAgentPayload('agent:response', {
          text: cleanupText,
          agentName: context.personality.name,
          finalized: true,
          blocked: !cleanupVerified,
          reason: cleanupReason,
          completionFeedback: cleanupCompletionFeedback,
        });
        const cleanupUnknownPayload = context.normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(context.visibleUserText),
          agentName: context.personality.name,
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
          completionFeedback: context.durableTaskId
            ? buildForegroundTaskCompletionFeedback({
                taskId: context.durableTaskId,
                taskLabel: context.visibleUserText,
                toolRecords: context.taskAwareRecords([cleanupRecord]),
                status: 'persistence_unknown',
                reason: 'Terminal persistence outcome is unknown.',
              })
            : undefined,
        });
        const cleanupCommitted = await context.commitRecordedTerminal({
          persistTerminalState: () => context.persistChatTakeoverExecution(cleanupText, {
            toolRecords: [cleanupRecord],
            source: 'chat_runtime_cleanup_offer',
            sourceInteractionId: context.interactionId,
            capabilitySelection: context.capabilitySelection,
            finalizationBlocked: !cleanupVerified,
            assistantTextTrusted: cleanupVerified,
            finalizationReason: cleanupReason,
          }),
        persistAssistantMessage: () => {
            const summary = summarizeToolRecordForPersistence(cleanupRecord);
            if (summary) {
              addMessage({
                userId: context.uid,
                agentId: context.conversationAgentId,
                conversationId: context.conversation.id,
                role: 'tool',
                content: summary,
                domain: context.resolvedDomain,
                orgId: context.resolvedOrgId,
              });
            }
            context.addMessageIdempotent({
              conversationId: context.conversation.id,
              role: 'assistant',
              content: cleanupText,
              personality: context.personality.id,
              source: 'chat_runtime_cleanup_offer',
              toolCalls: [cleanupRecord],
              cognitiveIntent: cleanupReason,
              llmWasCalled: false,
              completionFeedback: cleanupCompletionFeedback,
            });
            // `addMessageIdempotent` finalizes the foreground action and may
            // remove the live conversation pointer. Rebuild from the durable
            // task row now, before the recovery receipt captures this payload.
            context.refreshTerminalPayloadTaskRelation(cleanupTerminalPayload, context.durableTaskId);
          },
          payload: cleanupTerminalPayload,
          unknownPayload: cleanupUnknownPayload,
          updateSource: 'chat_runtime_cleanup_offer',
          errorContext: 'Runtime cleanup offer terminal persistence failed:'
        });
        if (cleanupCommitted) {
          context.actionLeaseHeartbeat?.stop();
        }
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      // Keep this late so English system/tool context cannot pull the reply language.
      context.effectiveSystemPrompt += '\n\n' + buildResponseLanguageInstruction(context.text);

      // Work-domain chats use organization LLM prefs when configured. If the org
      // has no explicit policy, they visibly inherit the user's personal prefs.
      const userLLMPrefs = getScopedPreferredLLM(context.uid, { domain: context.resolvedDomain, orgId: context.resolvedOrgId });
      let activeProvider = userLLMPrefs.provider || 'deepseek';
      let activeModel = userLLMPrefs.model;
      const reasoningRoutePolicy = {
        // Image/person setup already has bounded schemas and receipts. Avoid spending
        // the semantic-output deadline on hidden reasoning before the first tool call.
        ...(context.toolRoute?.categories.includes('memory_avatar') ? { thinkingMode: 'disabled' as const } : {}),
        selectionMode: userLLMPrefs.selectionMode,
        fallbackCandidates: userLLMPrefs.fallbackCandidates,
        allowCloudFallback: userLLMPrefs.allowCloudFallback,
        conversationId: context.conversationId || '',
        requestId: context.requestId,
        ...(context.nativeRequestBinding || {}),
        interactionId: context.interactionId,
        source: 'chat',
        inputTokenBudget: resolveModelRequestInputBudget(),
      };

      // Hybrid dispatch is opt-in only; do not change providers unless the user chose auto.
      if (context.llmGetters.isOllamaAvailable() && userLLMPrefs.provider === 'auto') {
        // Availability is observational only; automatic routing resolves the
        // user's exact local model and cloud fallback in the shared dispatcher.
        console.log('[Chat] Automatic model routing enabled with persisted local and fallback selections');
      }

      const scheduleChatSummary = (targetConversationId: string) => {
        scheduleConversationSummary({
          isAuthorized: context.turnAuthorization.isCurrent,
          userId: context.uid,
          provider: activeProvider,
          model: activeModel,
          ...reasoningRoutePolicy,
          conversationId: targetConversationId,
          source: 'chat_summary',
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          llmGetters: context.llmGetters,
          log: { info: console.log, warn: console.warn },
        });
      };
  return { terminal: false as const, context: extendTurnBindings(context, {
    get activeProvider(): typeof activeProvider { return activeProvider; },
    set activeProvider(value: typeof activeProvider) { activeProvider = value; },
    get activeModel(): typeof activeModel { return activeModel; },
    set activeModel(value: typeof activeModel) { activeModel = value; },
    reasoningRoutePolicy: reasoningRoutePolicy as typeof reasoningRoutePolicy,
    scheduleChatSummary: scheduleChatSummary as typeof scheduleChatSummary,
  }) };
}

async function prepareChatModelState(context: NonNullable<Awaited<ReturnType<typeof prepareChatRuntimeControlAndModel>>["context"]>) {

      if (context.pendingConfirmation) { await executeConfirmedChatTurn(context); { return { terminal: true as const, context: undefined }; } }

      let responseText = '';
      let completionGuard: LLMResult['completionGuard'];
      let llmWasCalled = false;
      const allToolRecords = context.requestToolRecords;
      // Keep the same token-budgeted conversation that drove the normal turn
      // available to the one-shot execution recovery. Falling back to only the
      // latest task makes the recovery model forget constraints and prior user
      // corrections precisely when it needs them most.
      let normalTurnMessages: NormalizedMessage[] = [];
      // ── Model-owned natural-language dispatch ──
      // Natural-language chat has no deterministic quick-command path. Surface
      // recognition and legacy quick matches are advisory inputs to the shared
      // model/tool loop; structured UI events use their dedicated handlers.
      context.abortController.signal.throwIfAborted();
      context.turnAuthorization.assertCurrent();
      // ── Sentiment analysis: detect emotional charge in user input ──
      const sentiment = extractSentiment(context.text);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        console.log('[ChatHandler] sentiment:', sentiment);
      }

      // Auto-select model: flash for simple chat, pro for complex tasks
      console.log('[ChatHandler] Using exact configured reasoning model:', context.activeProvider, '/', context.activeModel);

      const deferCompletionStream = shouldDeferModelOutputUntilFinalized({
        taskText: context.executionTaskText,
        allowToolUse: context.toolSessionActive,
        flow: context.turnFlow,
      });
      const chatTextGate = createPreFinalizationTextGate();
  return { terminal: false as const, context: extendTurnBindings(context, {
    get responseText(): typeof responseText { return responseText; },
    set responseText(value: typeof responseText) { responseText = value; },
    get normalTurnMessages(): typeof normalTurnMessages { return normalTurnMessages; },
    set normalTurnMessages(value: typeof normalTurnMessages) { normalTurnMessages = value; },
    deferCompletionStream: deferCompletionStream as typeof deferCompletionStream,
    chatTextGate: chatTextGate as typeof chatTextGate,
    get completionGuard(): typeof completionGuard { return completionGuard; },
    set completionGuard(value: typeof completionGuard) { completionGuard = value; },
    get llmWasCalled(): typeof llmWasCalled { return llmWasCalled; },
    set llmWasCalled(value: typeof llmWasCalled) { llmWasCalled = value; },
    allToolRecords: allToolRecords as typeof allToolRecords,
    sentiment: sentiment as typeof sentiment,
  }) };
}

async function executeChatModelAndDelivery(context: NonNullable<Awaited<ReturnType<typeof prepareChatModelState>>["context"]>) {

      await executeChatModelTurn(context);

      context.chatTextGate.finish();
      const finalizedDesktopRecords = withDesktopExecutionReceipt(context.allToolRecords, context.desktopExecutionTracker);
      if (finalizedDesktopRecords.length > context.allToolRecords.length) {
        context.allToolRecords.push(...finalizedDesktopRecords.slice(context.allToolRecords.length));
      }
      const verifiedClientMode = getVerifiedClientModeChange(context.allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(context.uid, verifiedClientMode);
      const finalTaskRecords = context.taskAwareRecords(context.allToolRecords);
      await completeChatTurn(extendTurnBindings(context, {
    finalTaskRecords: finalTaskRecords as typeof finalTaskRecords,
  }));
  return { terminal: false as const, context };
}

async function processChatTurn(socket: Socket, llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>, sensoryFn: (uid: string) => any, userIdFn: (s: Socket) => string, io: Server, data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown }, ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void): Promise<void> {
  const prepareChatRequestResult = await prepareChatRequest(socket, llmGetters, sensoryFn, userIdFn, io, data, ack);
  if (prepareChatRequestResult.terminal) return;
  const prepareChatEventsResult = await prepareChatEvents(prepareChatRequestResult.context);
  if (prepareChatEventsResult.terminal) return;
  const resolveChatControlTurnResult = await resolveChatControlTurn(prepareChatEventsResult.context);
  if (resolveChatControlTurnResult.terminal) return;
  const admitChatForegroundTurnResult = await admitChatForegroundTurn(resolveChatControlTurnResult.context);
  if (admitChatForegroundTurnResult.terminal) return;
  const startChatForegroundTurnResult = await startChatForegroundTurn(admitChatForegroundTurnResult.context);
  if (startChatForegroundTurnResult.terminal) return;
  const context = startChatForegroundTurnResult.context;
  try {
  const prepareChatPriorTaskQueryResult = await prepareChatPriorTaskQuery(context);
  if (prepareChatPriorTaskQueryResult.terminal) return;
  const prepareChatConversationContextResult = await prepareChatConversationContext(prepareChatPriorTaskQueryResult.context);
  if (prepareChatConversationContextResult.terminal) return;
  const prepareChatTerminalWritersResult = await prepareChatTerminalWriters(prepareChatConversationContextResult.context);
  if (prepareChatTerminalWritersResult.terminal) return;
  const prepareChatExecutionLeaseAndToolsResult = await prepareChatExecutionLeaseAndTools(prepareChatTerminalWritersResult.context);
  if (prepareChatExecutionLeaseAndToolsResult.terminal) return;
  const prepareChatRuntimeControlAndModelResult = await prepareChatRuntimeControlAndModel(prepareChatExecutionLeaseAndToolsResult.context);
  if (prepareChatRuntimeControlAndModelResult.terminal) return;
  const prepareChatModelStateResult = await prepareChatModelState(prepareChatRuntimeControlAndModelResult.context);
  if (prepareChatModelStateResult.terminal) return;
  const executeChatModelAndDeliveryResult = await executeChatModelAndDelivery(prepareChatModelStateResult.context);
  if (executeChatModelAndDeliveryResult.terminal) return;

  }  catch (error: any) {
      if (context.isChatCancelled() || error?.name === 'AbortError') {
        const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
        const cancelledRecords = context.collectRequestTerminalRecords();
        const cancelledFeedback = context.requestTaskId ? buildForegroundTaskCompletionFeedback({
          taskId: context.requestTaskId,
          taskLabel: context.visibleUserText,
          toolRecords: cancelledRecords,
          status: 'cancelled',
          reason: 'Cancelled by the user; completed steps remain recorded.',
        }) : undefined;
        await context.commitChatReply({
          text: cancelledText,
          reason: 'cancelled',
          completionFeedback: cancelledFeedback,
          message: () => ({
            cognitiveIntent: 'task_cancelled',
            llmWasCalled: true,
            toolCalls: cancelledRecords.length ? cancelledRecords : undefined,
            completionFeedback: cancelledFeedback,
            ...(context.requestTaskId ? { terminalTaskDisposition: {
              outcome: 'cancelled' as const,
              taskId: context.requestTaskId,
              requestId: context.requestId,
              reason: 'Cancelled by the user; completed steps remain recorded.',
            } } : {}),
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.selectedConversationId,
            agentId: context.conversationAgentId,
            source: context.eventSource,
          }),
          errorContext: 'Caught chat cancellation terminal',
        });
        return;
      }
      console.error("[Socket Agent Error]:", error);
      const publicError = sanitizeChatAgentErrorPayload({
        code: chatPublicErrorCodeForException(error),
      });
      const failureText = publicError.code === 'CHAT_PRIVACY_RESTRICTED'
        ? CN_VOICE_WORK_MESSAGES.privacyRestricted
        : publicError.code === 'CHAT_MODEL_ROUTES_UNAVAILABLE'
        ? CN_VOICE_WORK_MESSAGES.modelRoutesUnavailable
        : CN_VOICE_WORK_MESSAGES.processingFailed;
      const failedRecords = context.collectRequestTerminalRecords();
      const failedFeedback = context.requestTaskId ? buildForegroundTaskCompletionFeedback({
        taskId: context.requestTaskId,
        taskLabel: context.visibleUserText,
        toolRecords: failedRecords,
        blocked: true,
        reason: String(publicError.reason || 'chat_execution_failed'),
      }) : undefined;
      await context.commitChatReply({
        text: failureText,
        blocked: true,
        reason: String(publicError.reason || 'chat_execution_failed'),
        completionFeedback: failedFeedback,
        message: () => ({
          cognitiveIntent: String(publicError.code || 'CHAT_EXECUTION_FAILED').toLowerCase(),
          llmWasCalled: false,
          toolCalls: failedRecords.length ? failedRecords : undefined,
          completionFeedback: failedFeedback,
          ...(context.requestTaskId ? { terminalTaskDisposition: {
            outcome: 'blocked' as const,
            taskId: context.requestTaskId,
            requestId: context.requestId,
            reason: String(publicError.reason || 'chat_execution_failed'),
          } } : {}),
        }),
        publishAfter: () => context.emitConversationUpdated({
          conversationId: context.selectedConversationId,
          agentId: context.conversationAgentId,
          source: context.eventSource,
        }),
        errorContext: 'Unhandled chat failure terminal',
      });
    } finally {

      await context.releaseChatSession();
  }
}

export function registerChatHandler(
  socket: Socket,
  llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>,
  sensoryFn: (uid: string) => any,
  userIdFn: (s: Socket) => string,
  io: Server,
) {
  registerChatExecutionControls(socket, userIdFn, io);

  socket.on("agent:chat", async (data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown }, ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void) => processChatTurn(socket, llmGetters, sensoryFn, userIdFn, io, data, ack));
}
