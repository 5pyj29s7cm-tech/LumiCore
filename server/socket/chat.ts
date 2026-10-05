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
import { formatRuntimeCleanupReceipt } from '../i18n/runtime_cleanup_messages';
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation, runAfterAcceptedUserTurnAdmission } from './action_turn_durability';

import { personalityRegistry } from "../personality";
import { getMemoryAvatar } from '../memory_avatar/store';
import { captureMemoryAvatarAuthorization } from '../memory_avatar/lifecycle';

import { getOrCreateConversationForTurn, addMessage, addMessageIdempotent as addMessageIdempotentUnbound, updateAssistantMessageTerminalPresentation, getMessageByRequestId, getMessages, setConversationMode, getConversationForScope, getOrCreateActiveConversation, getConversationActionStatus, bindConversationActionExecutionTurn, cancelConversationActionExecution, completeConversationActionFromUserObservation, createDurableForegroundReleaseGate, convergeForegroundRequestBeforeRelease, prepareConversationActionExecution, setConversationActionExecutionStatus, startConversationActionExecutionHeartbeat, type ForegroundRequestIdentity as ChatForegroundRequestIdentity, type ForegroundRequestReleaseInput, type ForegroundRequestReleaseResult as ChatForegroundRequestReleaseResult, type ForegroundRequestDurabilityDependencies } from "../conversation/manager";
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

import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_WORK_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
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

// Foreground executions outlive an individual Socket.IO connection. Keeping the
// queue at module scope lets a reconnected client query or cancel the same
// execution instead of creating an orphan tied to the old socket instance.

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

function chatExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}

function chatDurabilityUnknownText(userText: string): string {
  return /[\u3400-\u9fff]/u.test(userText)
    ? CN_TASK_EXECUTION_MESSAGES.persistenceUnknown
    : 'The final state of this turn could not be saved reliably, so I did not mark it complete. If an external action may have run, verify its actual result before retrying.';
}

function buildNaturalReplyStyleOverlay(source?: string): string {
  return buildTextReplyStyleOverlay(source === 'voice' ? 'voice' : 'chat');
}

export function registerChatHandler(
  socket: Socket,
  llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>,
  sensoryFn: (uid: string) => any,
  userIdFn: (s: Socket) => string,
  io: Server,
) {
  socket.on("agent:execution_resume", (
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null; conversationId?: string } = {},
    ack?: (payload: { ok: boolean; snapshot?: ReturnType<typeof getChatExecution>; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const requestScope = resolveAuthorizedSocketScope(socket, uid);
    if (!requestScope) {
      try { ack?.({ ok: false, error: 'Workspace access is unavailable.' }); } catch {}
      return;
    }
    const scope: ChatExecutionScope = {
      userId: uid,
      domain: requestScope.domain,
      orgId: requestScope.orgId,
      source: data.source || 'chat',
      conversationId: data.conversationId,
    };
    const snapshot = getChatExecution(scope, data.requestId);
    try {
      ack?.(snapshot
        ? { ok: true, snapshot }
        : { ok: false, error: 'Execution not found or no longer recoverable' });
    } catch {}
    if (snapshot?.terminalEvent) {
      socket.emit(snapshot.terminalEvent.event, {
        ...snapshot.terminalEvent.payload,
        replayed: true,
      });
    }
  });

  // Abort is request-scoped and acknowledged. This handler only records that
  // the server accepted the cancellation signal; the foreground owner remains
  // the sole writer of the request's terminal transcript/task/receipt. Writing
  // a second terminal here used to race the foreground catch and could claim
  // "cancelled" while a provider that ignored AbortSignal was still running.
  socket.on("agent:abort_chat", async (
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null; conversationId?: string } = {},
    ack?: (payload: { ok: boolean; requestId?: string; status?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    // Revoked credentials may only stop their exact original request. They
    // never become personal credentials and cannot read a recovery payload.
    if (socket.data?.authenticatedUserId !== uid || !data.requestId) {
      try { ack?.({ ok: false, error: 'An authenticated exact request is required.' }); } catch {}
      return;
    }
    const originalOrgId = String(socket.data?.authenticatedOrgId || '').trim();
    const requestScope = { domain: originalOrgId ? 'work' as const : 'personal' as const, orgId: originalOrgId };
    const scope: ChatExecutionScope = {
      userId: uid,
      domain: requestScope.domain,
      orgId: requestScope.orgId,
      source: data.source || 'chat',
      conversationId: data.conversationId,
    };
    const snapshot = getChatExecution(scope, data.requestId);
    if (!snapshot || snapshot.terminal) {
      try {
        ack?.({
          ok: Boolean(snapshot?.terminal),
          requestId: snapshot?.requestId || data.requestId,
          status: snapshot?.status,
          error: snapshot ? undefined : 'Active execution not found',
        });
      } catch {}
      return;
    }

    const targetConversationId = scope.conversationId || snapshot.conversationId || '';
    const session = getConversationExecution({ ...scope, conversationId: targetConversationId }, snapshot.requestId);
    if (!session || session.requestId !== snapshot.requestId) {
      try { ack?.({ ok: false, requestId: snapshot.requestId, error: 'Execution controller is unavailable' }); } catch {}
      return;
    }
    markChatExecutionCancelling(scope, snapshot.requestId);
    const room = chatExecutionRoom(scope);
    const cancellingPayload = {
      status: 'cancelling',
      source: scope.source,
      requestId: snapshot.requestId,
      conversationId: targetConversationId,
    };
    io.to(room).emit('agent:status', cancellingPayload);
    session.cancel();
    try { ack?.({ ok: true, requestId: snapshot.requestId, status: 'cancelling' }); } catch {}
  });

  socket.on("agent:chat", async (
    data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown },
    ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void,
  ) => {
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
      return;
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
      return;
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
      return;
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
      return;
    }
    selectedConversationId = selectedConversation.id;
    try {
      await ensurePendingConfirmationPersistenceInitialized();
    } catch (error) {
      console.error('[ChatHandler] Encrypted confirmation store is unavailable:', error);
      try { ack?.({ ok: false, requestId, error: 'Secure confirmation storage is unavailable' }); } catch {}
      return;
    }
    if (rejectRevokedRequest()) return;
    const pendingAssistantOfferTranscript = getMessages(selectedConversationId, 4);
    let pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
      messages: pendingAssistantOfferTranscript,
      userId: uid,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
      taskId: selectedConversation.actionContinuationState?.taskId,
    });
    let acceptedRuntimeCleanupOffer = resolvePendingRuntimeCleanupOffer(
      visibleUserText,
      pendingAssistantOfferContext,
    );
    const explicitRuntimeWorkStatusRequest = classifyRuntimeWorkIntent(
      visibleUserText,
      pendingAssistantOfferContext,
    ) === 'status';
    let confirmationChannelScope = buildTransportNeutralConfirmationScope({
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
    });
    let confirmationScope = buildTransportNeutralConfirmationScope({
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
      taskId: selectedConversation.actionContinuationState?.taskId,
    });
    const confirmationCancellationRequested = isConfirmationCancellation(visibleUserText);
    let pendingConfirmationCleared = false;
    let correctionRequiresFreshConfirmation = false;
    let executionScope: ChatExecutionScope & { conversationId: string } = {
      userId: uid,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      source: eventSource,
      conversationId: selectedConversationId,
      requireConversation: true,
    };
    let executionRoom = chatExecutionRoom(executionScope);
    let resolvedTaskRelation: ActiveTaskMessageResolution | null = null;
    let acceptedTurnResolution: TurnResolution | undefined;
    const refreshResolvedTaskRelationFromLedger = (
      exactConversationId: string,
      exactTaskId = resolvedTaskRelation?.taskId || '',
      exactRequestId = requestId,
    ): ActiveTaskMessageResolution | null => {
      if (!exactConversationId || !resolvedTaskRelation) return null;
      const db = readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]);
      const requestTurns = (db.conversationActionTurns || []).filter((turn: any) => (
        turn.conversationId === exactConversationId
        && turn.userId === uid
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
        candidate.id === exactConversationId && candidate.userId === uid
      ));
      const durableState = normalizedTaskId
        ? getConversationActionStateByTaskId(db, {
            conversationId: exactConversationId,
            userId: uid,
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
            task: visibleUserText,
            toolRecords: collectRequestTerminalRecords(),
            ...outputProtection,
          })
        : event === 'agent:notification'
          ? sanitizeExecutionNotificationForDelivery(payload, { task: visibleUserText })
        : event === 'agent:error'
          ? sanitizeChatAgentErrorPayload(payload)
          : payload;
      const publicPayload = projectCustomerVisibleExecutionEvent(event, sanitizedPayload, {
        taskText: visibleUserText,
      });
      const completionFeedback = normalizeCompletionFeedbackForPersistence(publicPayload.completionFeedback);
      const boundedPublicPayload = { ...publicPayload };
      delete boundedPublicPayload.completionFeedback;
      return {
        ...boundedPublicPayload,
        ...(event === 'agent:response'
          ? { fileArtifacts: collectChatArtifacts(collectRequestTerminalRecords(), selectedConversationId) }
          : {}),
        ...(event === 'agent:response' && latestMediaArtifactReceipt
          ? { artifactReceipt: latestMediaArtifactReceipt }
          : {}),
        // Every client-visible event carries the conversation owner.  The
        // desktop shell shares one user-level socket across Lumi, LAP, and
        // Memory Avatar surfaces; consumers must be able to reject a late
        // event from another surface instead of treating it as their own.
        agentId: conversationAgentId,
        ...(completionFeedback ? { completionFeedback } : {}),
        source: boundedPublicPayload.source || eventSource,
        requestId,
        conversationId: selectedConversationId,
        ...(resolvedTaskRelation ? { taskRelation: resolvedTaskRelation } : {}),
      };
    };
    let authorizationNoticeSent = false;
    const publishRecordedAgent = (event: string, normalizedPayload: Record<string, any>) => {
      if (!turnAuthorization.isCurrent()) {
        // Keep the originating UI from hanging, without publishing the old
        // workspace's text, tool output, task details, or completion claims.
        if (!authorizationNoticeSent && (event === 'agent:response' || event === 'agent:error')) {
          authorizationNoticeSent = true;
          socket.emit('agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.cancelled, agentName: 'Lumi',
            source: eventSource, requestId, conversationId: selectedConversationId,
            finalized: true, blocked: false, reason: 'cancelled',
          });
        }
        return;
      }
      if (event === 'agent:response') {
        if (process.env.LUMI_CHAT_LATENCY_DIAGNOSTICS === '1') {
          markTurnTiming('responseReady');
          console.log('[ChatTiming]', JSON.stringify({ requestId, ...turnTiming }));
        }
        // The originating native client must receive the terminal frame even
        // if its room membership changed during reconnect or conversation
        // rollover. Other signed-in clients still receive the same terminal
        // event through the user/workspace room without duplicating it here.
        socket.emit(event, normalizedPayload);
        socket.to(executionRoom).emit(event, normalizedPayload);
        return;
      }
      if (isMemoryAvatar) {
        // Memory Avatar requests are forced into the personal data scope. An
        // organization-authenticated socket may not be a member of that room,
        // so deliver its private stream/status frames directly to the socket
        // that initiated the request instead of silently dropping them.
        socket.emit(event, normalizedPayload);
        return;
      }
      io.to(executionRoom).emit(event, normalizedPayload);
    };
    let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      if (!conversationAuthorization.isCurrent()) return false;
      const normalizedPayload = normalizeAgentPayload(event, payload);
      // A late duplicate from the same handler is not a reconnect replay. The
      // explicit request/recovery entry points above own replay delivery; doing
      // it here turns one committed terminal into a second UI terminal frame.
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
      publishRecordedAgent(event, normalizedPayload);
      return true;
    };
    const persistAuthorizedTerminalReceipt = (
      event: 'agent:response' | 'agent:error', payload: Record<string, any>, unknownPayload: Record<string, any>,
    ) => persistAuthorizedReceipt({ scope: executionScope, requestId, event, payload, unknownPayload,
      authorization: turnAuthorization, conversationIsCurrent: conversationAuthorization.isCurrent, channel: 'chat', flush: flushDBOrThrow });
    const commitDeterministicTerminal = async (input: {
      event?: 'agent:response' | 'agent:error';
      payload: Record<string, any>;
      persistAssistantMessage?: () => void;
      publishAfter?: () => void;
      errorContext?: string;
    }): Promise<boolean> => {
      if (!conversationAuthorization.isCurrent()) return false;
      if (actionLeaseHeartbeat?.isLeaseLost()) {
        await actionLeaseHeartbeat.leaseLoss;
        return false;
      }
      const terminalEvent = input.event || 'agent:response';
      const terminalPayload = normalizeAgentPayload(terminalEvent, input.payload);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
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
            selectedConversationId,
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
            requestId,
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
    const emitConversationUpdated = (payload: Record<string, any>) => {
      if (!turnAuthorization.isCurrent()) return;
      io.to(executionRoom).emit('chat:conversation_updated', {
        ...payload,
        requestId,
        originSocketId: socket.id,
      });
    };
    console.log('[ChatHandler] domain:', resolvedDomain, 'orgId:', resolvedOrgId);

    // Request ids are idempotency keys. Socket.IO may deliver a buffered emit
    // after reconnect; acknowledging the existing execution avoids running the
    // same user action twice.
    let existingExecution = getChatExecution(executionScope, requestId);
    if (existingExecution) {
      if (existingExecution.sidecar === true && !existingExecution.terminal) {
        try {
          await waitForChatSidecarCancellationIntent(executionScope, requestId);
        } catch (error: any) {
          const publicCode = error?.code === 'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE'
            ? 'CHAT_EXECUTION_FAILED'
            : 'CHAT_CONTROL_RECEIPT_WRITE_FAILED';
          try {
            ack?.({
              ok: false,
              requestId,
              error: sanitizeChatAgentErrorPayload({ code: publicCode }).message,
            });
          } catch {}
          return;
        }
        existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(executionScope, requestId);
        if (durableTarget && !getConversationExecution(executionScope, durableTarget)) {
          // The process can restart after the durable fence but before the
          // side effect/terminal write. With no matching lease, converge the
          // tombstone to a terminal no-op; never replay cancellation onto a
          // later task.
          const staleControlPayload = normalizeAgentPayload('agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            source: eventSource,
            requestId,
            conversationId: selectedConversationId,
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          });
          const unknownPayload = normalizeAgentPayload('agent:response', {
            text: chatDurabilityUnknownText(visibleUserText),
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'persistence_unknown',
          });
          try {
            await flushDBOrThrow();
            await recordChatExecutionTerminalEventDurably(
              executionScope,
              requestId,
              'agent:response',
              staleControlPayload,
              unknownPayload,
            );
          } catch (error: any) {
            console.error('[ChatHandler] Recovered control terminal persistence failed:', error);
            try {
              await recordChatExecutionPersistenceUnknownDurably(
                executionScope,
                requestId,
                unknownPayload,
              );
            } catch (unknownError) {
              console.error('[ChatHandler] Recovered control unknown receipt persistence failed:', unknownError);
            }
            publishRecordedAgent('agent:response', unknownPayload);
            try { ack?.({ ok: false, requestId, error: 'Terminal persistence outcome is unknown' }); } catch {}
            return;
          }
          existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        }
      }
      if (rejectRevokedRequest()) return;
      try { ack?.({ ok: true, requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        socket.emit(existingExecution.terminalEvent.event, {
          ...existingExecution.terminalEvent.payload,
          replayed: true,
        });
      } else {
        const resumableStatus = existingExecution.status === 'planning' || existingExecution.status === 'acknowledged'
          ? existingExecution.queued === true ? 'queued' : 'thinking'
          : existingExecution.status;
        socket.emit('agent:status', {
          status: resumableStatus,
          source: eventSource,
          requestId,
          resumed: true,
        });
      }
      return;
    }

    // Reconnect/retry may resend a request that is already reserved but has
    // not reached beginChatExecution yet. Acknowledge the existing lease;
    // never attach a second handler to the same queued request.
    const queuedDuplicate = getConversationExecution(executionScope, requestId);
    if (queuedDuplicate) {
      try {
        ack?.({
          ok: true,
          requestId,
          receivedAt: new Date().toISOString(),
        });
      } catch {}
      socket.emit('agent:status', {
        status: queuedDuplicate.state === 'active' ? 'thinking' : 'queued',
        source: eventSource,
        requestId,
        resumed: true,
      });
      return;
    }

    // A status question is a side conversation, not a replacement command.
    // Answer it without aborting/superseding the foreground executor.
    const observedExistingSession = getCurrentConversationExecution(executionScope);
    // Socket delivery happens immediately after the terminal durability fence,
    // while queue-resource release finishes a few microtasks later. A fast
    // follow-up can therefore observe the old queue slot even though its
    // request already has a durable terminal. Do not answer that follow-up as
    // "still executing"; let it queue briefly and resolve against the ledger.
    const existingSession = observedExistingSession
      && getChatExecution(executionScope, observedExistingSession.requestId)?.terminal !== true
      ? observedExistingSession
      : null;
    const controlTargetRequestId = String(data.controlTargetRequestId || '').trim().slice(0, 120);
    const controlTargetTaskId = String(data.controlTargetTaskId || '').trim().slice(0, 180);
    const controlTargetRevision = typeof data.controlTargetRevision === 'number'
      && Number.isFinite(data.controlTargetRevision)
      ? Math.max(0, Math.trunc(data.controlTargetRevision))
      : undefined;
    // The serial queue key already includes the explicitly selected
    // conversation id. Resolve status against that exact conversation; using
    // the user's globally active chat here leaks isolated/native E2E sidecars
    // into an unrelated personal transcript.
    const activeConversationForStatus = existingSession ? getConversationForScope(
      selectedConversationId,
      uid,
      resolvedDomain,
      resolvedOrgId,
    ) : null;
    acceptedTurnResolution = resolveUserTurn({
      requestId, userText: visibleUserText,
      state: activeConversationForStatus?.actionContinuationState || selectedConversation.actionContinuationState,
      options: {
        activeRequestId: existingSession?.requestId,
        controlTargetRequestId,
        controlTargetTaskId,
        controlTargetRevision,
        pendingAssistantOfferContext,
      },
    });
    resolvedTaskRelation = { ...acceptedTurnResolution.taskRelation };
    if (!isMemoryAvatar && acceptedTurnResolution.queryTarget === 'runtime_work'
      && acceptedTurnResolution.userIntent.operation === 'status') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      const admission = await admitAcceptedUserTurnDurably({
        persistAcceptedUserTurn: () => addMessageIdempotent({conversationId:selectedConversationId,role:'user',
          content:storedUserContent,receivedAt:requestReceivedAt,skipActionContinuation:true,
        }),
        flush:flushDBOrThrow,
        onPersistenceUnknown:async error=>{
          const payload=normalizeAgentPayload('agent:response',{text:chatDurabilityUnknownText(visibleUserText),
            agentName:'Lumi',finalized:true,blocked:true,reason:'persistence_unknown',sidecar:true});
          try {await recordChatExecutionPersistenceUnknownDurably(executionScope,requestId,payload);}
          catch {console.error('[ChatHandler] Runtime status admission persistence failed:',error);}
          publishRecordedAgent('agent:response',payload);
          try {ack?.({ok:false,requestId,error:'Accepted user turn persistence is unknown'});} catch {}
        },
      });
      if (!admission) return;
      try {ack?.({ok:true,requestId,receivedAt:requestReceivedAt});} catch {}
      const result = await readRuntimeWorkForTurn({
        resolution:acceptedTurnResolution,userId:uid,domain:resolvedDomain,orgId:resolvedOrgId,
        conversationId:selectedConversationId,source:eventSource,registry:toolRegistry,
        securityContext:toolSecurityContext,authorization:turnAuthorization,
        personalityToolPolicy: (personalityRegistry.getForUser('lumi', uid, resolvedDomain === 'work' ? resolvedOrgId : undefined)
          || personalityRegistry.getDefault()).toolPolicy,
      });
      await commitDeterministicTerminal({
        payload:{text:result.text,agentName:'Lumi',finalized:true,blocked:result.blocked,
          reason:'runtime_work_status',sidecar:true},
        persistAssistantMessage:()=>addMessageIdempotent({conversationId:selectedConversationId,role:'assistant',
          content:result.text,toolCalls:[result.record],cognitiveIntent:'runtime_work_status',
          llmWasCalled:false,skipActionContinuation:true,
        }),
        errorContext:'Read-only runtime status terminal',
      });
      return;
    }
    const durableStatusTaskState = activeConversationForStatus?.actionContinuationState
      || selectedConversation.actionContinuationState;
    const durablePostCancelBinding = !existingSession && resolvedTaskRelation.feedback === 'status'
      ? getDurableChatCancellationForCurrentExecution(executionScope, {
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
            binding: resolvedTaskRelation.binding,
            taskId: resolvedTaskRelation.taskId,
            revision: resolvedTaskRelation.revision,
            targetRequestId: resolvedTaskRelation.targetRequestId,
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
      && resolvedTaskRelation.feedback === 'status'
      && exactPostCancelTargetTerminal?.terminal === true
      && exactPostCancelTargetTerminal.terminalEvent
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      addMessageIdempotent({
        conversationId: selectedConversationId,
        role: 'user',
        content: storedUserContent,
        cognitiveIntent: 'task_status',
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      const statusText = String(
        exactPostCancelTargetTerminal.terminalEvent.payload?.text
        || CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt,
      ).trim();
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: eventSource,
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'target_execution_status',
          controlIntent: 'status',
          targetRequestId: exactPostCancelStatusTarget,
        },
        persistAssistantMessage: () => addMessageIdempotent({
          conversationId: selectedConversationId,
          role: 'assistant',
          content: statusText,
          cognitiveIntent: 'task_status',
          llmWasCalled: false,
          skipActionContinuation: true,
        }),
        errorContext: 'Exact post-cancellation status terminal',
      });
      return;
    }
    if (
      resolvedTaskRelation.binding === 'stale'
      && resolvedTaskRelation.relation !== 'queue'
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      addMessageIdempotent({
        conversationId: selectedConversationId,
        role: 'user',
        content: storedUserContent,
        cognitiveIntent: 'stale_task_control',
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: resolvedTaskRelation.reason,
        },
        persistAssistantMessage: () => addMessageIdempotent({
          conversationId: selectedConversationId,
          role: 'assistant',
          content: CN_TASK_EXECUTION_MESSAGES.staleControl,
          cognitiveIntent: 'stale_task_control',
          llmWasCalled: false,
          skipActionContinuation: true,
        }),
        errorContext: 'Stale task control terminal',
      });
      return;
    }
    if (
      !existingSession
      && resolvedTaskRelation.feedback === 'cancel'
      && resolvedTaskRelation.taskId
      && selectedConversation.actionContinuationState?.unfinished
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      addMessageIdempotent({
        conversationId: selectedConversationId,
        role: 'user',
        content: storedUserContent,
        cognitiveIntent: 'task_cancel',
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      const cancelled = cancelConversationActionExecution(
        selectedConversationId,
        uid,
        'Cancelled by the user.',
        selectedConversation.actionContinuationState?.activeRequestId
          ? controlTargetRequestId || undefined
          : undefined,
      );
      const clearedTaskConfirmation = await clearPendingConfirmationDurably(uid, confirmationScope);
      const clearedTasklessConfirmation = await clearPendingConfirmationDurably(uid, confirmationChannelScope);
      pendingConfirmationCleared = clearedTaskConfirmation || clearedTasklessConfirmation;
      const cancelledCurrentTask = cancelled?.taskId === resolvedTaskRelation.taskId
        && cancelled.status === 'cancelled';
      const responseText = cancelledCurrentTask
        ? CN_TASK_EXECUTION_MESSAGES.cancelled
        : CN_TASK_EXECUTION_MESSAGES.staleControl;
      if (cancelledCurrentTask) {
        resolvedTaskRelation = { ...resolvedTaskRelation, revision: cancelled?.revision };
      }
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: responseText,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: cancelledCurrentTask ? 'cancelled_by_user' : 'stale_control',
        },
        persistAssistantMessage: () => addMessageIdempotent({
          conversationId: selectedConversationId,
          role: 'assistant',
          content: responseText,
          cognitiveIntent: 'task_cancel',
          skipActionContinuation: true,
        }),
        errorContext: 'Task cancellation terminal',
      });
      return;
    }
    if (
      existingSession
      && !isNamedPersistentWorkTaskStatusQuery(visibleUserText)
      && resolvedTaskRelation.feedback === 'status'
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      // Natural-language status controls do not carry UI fence metadata. The
      // server-observed foreground lease is authoritative in that case; an
      // explicitly supplied stale target was already rejected above.
      if (controlTargetRequestId && controlTargetRequestId !== existingSession.requestId) {
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        await commitDeterministicTerminal({ payload: {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        }, errorContext: 'Stale status control terminal' });
        return;
      }
      const activeConversation = activeConversationForStatus || selectedConversation;
      if (activeConversation) {
        addMessageIdempotent({
          conversationId: activeConversation.id,
          role: 'user',
          content: storedUserContent,
          cognitiveIntent: 'task_status',
          receivedAt: requestReceivedAt,
          timestamp: requestReceivedAt,
          skipActionContinuation: true,
        });
      }
      const statusText = activeConversation && resolvedTaskRelation.taskId
        ? getConversationActionStatus(activeConversation.id, uid, visibleUserText, activeConversation.actionContinuationState)
        : CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt;
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: eventSource,
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: '',
        },
        persistAssistantMessage: activeConversation
          ? () => addMessageIdempotent({ conversationId: activeConversation.id, role: 'assistant', content: statusText, cognitiveIntent: 'task_status', skipActionContinuation: true })
          : undefined,
        errorContext: 'Active task status terminal',
      });
      return;
    }

    // A new utterance does not destroy an active task. Continuations and
    // independent work wait behind the current foreground lease; only an
    // explicit replacement aborts it.
    const previousSession = getCurrentConversationExecution(executionScope, 'tail');
    if (previousSession && previousSession.requestId !== existingSession?.requestId) {
      resolvedTaskRelation = resolveActiveTaskMessageRelation(
        visibleUserText,
        activeConversationForStatus?.actionContinuationState || selectedConversation.actionContinuationState,
        {
          acceptedFeedback: resolvedTaskRelation.feedback,
          activeRequestId: previousSession.requestId,
          controlTargetRequestId,
          controlTargetTaskId,
          controlTargetRevision,
          pendingAssistantOfferContext,
        },
      );
    }
    const activeMessageRelation = previousSession ? resolvedTaskRelation.relation : null;
    let acknowledged = false;
    if (previousSession && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      // A typed/spoken "停止" has no client request id. Bind it to the exact
      // server-owned lease selected by the resolver. UI controls may still
      // supply an immutable fence, and stale explicit fences are rejected
      // before this branch.
      const cancellationTargetRequestId = controlTargetRequestId
        || resolvedTaskRelation.targetRequestId
        || previousSession.requestId;
      try {
        // A buffered cancellation must be durably fenced before it can touch
        // the foreground queue. On restart, this tombstone makes replay a
        // status lookup instead of a second cancellation of newer work.
        await persistChatSidecarCancellationIntent(executionScope, requestId, cancellationTargetRequestId);
      } catch (error: any) {
        const publicError = sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' });
        await commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: publicError.message,
            code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED',
            sidecar: true,
          },
          errorContext: 'Cancellation reservation failure terminal',
        });
        try { ack?.({ ok: false, requestId, error: publicError.message }); } catch {}
        return;
      }
      addMessageIdempotent({
        conversationId: selectedConversationId,
        role: 'user',
        content: storedUserContent,
        cognitiveIntent: 'task_cancel',
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      emitAgent('agent:status', { status: 'cancelling', sidecar: true });
      if (!turnAuthorization.isCurrent()) {
        // This control already has a durable reservation and an acceptance
        // acknowledgement. Settle it without touching its old target.
        await commitDeterministicTerminal({
          payload: {
            text: CN_TASK_EXECUTION_MESSAGES.cancelled, agentName: 'Lumi',
            sidecar: true, finalized: true, blocked: false, reason: 'cancelled',
          },
          persistAssistantMessage: () => addMessageIdempotent({ conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.cancelled, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
          errorContext: 'Revoked cancellation control terminal',
        });
        return;
      }
      const currentTarget = getConversationExecution(executionScope, cancellationTargetRequestId);
      if (!currentTarget) {
        await commitDeterministicTerminal({
          payload: {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          },
          persistAssistantMessage: () => addMessageIdempotent({ conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.staleControl, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
          errorContext: 'Stale cancellation terminal',
        });
        return;
      }
      try {
        await cancelConversationExecution(executionScope, cancellationTargetRequestId);
      } catch (error: any) {
        const settlementTimedOut = error?.code === 'serial_execution_cancellation_timeout';
        const failureText = settlementTimedOut
          ? CN_TASK_EXECUTION_MESSAGES.cancellationSettlementTimedOut
          : sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_CANCEL_FAILED' }).message;
        await commitDeterministicTerminal({
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
          persistAssistantMessage: settlementTimedOut ? () => addMessageIdempotent({ conversationId: selectedConversationId, role: 'assistant', content: failureText, cognitiveIntent: 'cancellation_settlement_timeout', skipActionContinuation: true }) : undefined,
          errorContext: settlementTimedOut
            ? 'Cancellation settlement timeout terminal'
            : 'Cancellation failure terminal',
        });
        return;
      }
      await commitDeterministicTerminal({
        payload: {
          text: CN_TASK_EXECUTION_MESSAGES.cancelled,
          agentName: 'Lumi',
          source: eventSource,
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'cancelled_by_user',
        },
        persistAssistantMessage: () => addMessageIdempotent({ conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.cancelled, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
        errorContext: 'Cancellation completion terminal',
      });
      return;
    }

    // Bind and persist the foreground user turn before it waits behind any
    // older lease. This keeps receive order durable even when the model/tool
    // phase is long or the process exits before a terminal assistant result.
    const conversationTurn = getOrCreateConversationForTurn(
      uid,
      conversationAgentId,
      resolvedDomain,
      resolvedOrgId,
      { userText: visibleUserText, conversationId: selectedConversationId },
    );
    let conversation = conversationTurn.conversation;
    const userObservedCompletionTaskId = attachments.length === 0
      && isUserObservedTaskCompletion(visibleUserText, conversation.actionContinuationState)
      ? conversation.actionContinuationState?.taskId
      : undefined;
    if (conversation.id !== selectedConversationId) {
      selectedConversationId = conversation.id;
      pendingAssistantOfferContext = undefined;
      acceptedRuntimeCleanupOffer = null;
      confirmationChannelScope = buildTransportNeutralConfirmationScope({
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        conversationId: selectedConversationId,
      });
      confirmationScope = buildTransportNeutralConfirmationScope({
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        conversationId: selectedConversationId,
      });
      executionScope = { ...executionScope, conversationId: selectedConversationId };
      executionRoom = chatExecutionRoom(executionScope);
      pendingConfirmation = null;
      pendingConfirmationPrompt = '';
    }
    if (rejectRevokedRequest()) return;
    markTurnTiming('admissionStart');
    const chatAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => addMessageIdempotent({
        conversationId: conversation.id,
        role: 'user',
        content: storedUserContent,
        cognitiveIntent: confirmationCancellationRequested
          ? 'task_cancel'
          : resolvedTaskRelation.binding === 'active_task' || resolvedTaskRelation.binding === 'previous_task'
            ? `task_${resolvedTaskRelation.feedback}`
            : undefined,
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        deferActionPreparation: !confirmationCancellationRequested,
        skipActionContinuation: confirmationCancellationRequested,
      }),
      flush: flushDBOrThrow,
      onPersistenceUnknown: error => {
        console.error('[ChatHandler] Accepted user turn could not be flushed:', error);
        const unknownPayload = normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
        });
        publishRecordedAgent('agent:response', unknownPayload);
        try { ack?.({ ok: false, requestId, error: 'Accepted user turn persistence is unknown' }); } catch {}
      },
    });
    if (!chatAdmission) {
      return;
    }
    markTurnTiming('admissionEnd');
    const acceptedUserMessageId = chatAdmission.persisted;
    if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
      await runAfterAcceptedUserTurnAdmission(chatAdmission, () => (
        clearPendingConfirmationDurably(uid, buildTransportNeutralConfirmationScope({
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          conversationId: conversationTurn.previousConversationId!,
        }))
      ));
    }
    const confirmationResolution = await resolveAcceptedTurnConfirmation({
      admission: chatAdmission,
      userId: uid,
      userText: visibleUserText,
      taskRelation: resolvedTaskRelation || undefined,
        actionState: conversation.actionContinuationState,
      taskScope: confirmationScope,
      channelScope: confirmationChannelScope,
    });
    pendingConfirmation = confirmationResolution.pending;
    pendingConfirmationPrompt = confirmationResolution.prompt;
    confirmationScope = confirmationResolution.scope;
    pendingConfirmationCleared = confirmationResolution.cleared;
    correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

    // Install the lease before waiting. Otherwise two messages arriving while
    // the same task is active both wait for that task and wake concurrently,
    // allowing the later request to supersede the earlier queued request.
    const sessionLease = runAfterAcceptedUserTurnAdmission(chatAdmission, () => {
      if (previousSession && activeMessageRelation === 'replace' && turnAuthorization.isCurrent()) {
        void cancelConversationExecution(executionScope);
      }
      beginQueuedChatExecution(executionScope, requestId);
      return reserveConversationExecution(executionScope, requestId);
    });
    const abortController = sessionLease.controller;
    const markRequestCancellation = () => markChatExecutionCancelling(executionScope, requestId);
    abortController.signal.addEventListener('abort', markRequestCancellation, { once: true });
    const stopAuthorizationWatch = turnAuthorization.watch(abortController);
    if (abortController.signal.aborted) markRequestCancellation();
    const isChatCancelled = () => !turnAuthorization.isCurrent() || abortController.signal.aborted;
    const forwardToolProgress = (step: string) => {
      if (!isChatCancelled() && shouldForwardPreFinalizationProgress(step)) {
        emitAgent('agent:progress', { text: step, agentName: 'Lumi' });
      }
    };
    const unregisterShutdownCancellation = runtimeShutdownCancellation.register(abortController);
    let releaseDesktopControlLease: (() => void) | null = null;
    let foregroundRequestIdentity: ChatForegroundRequestIdentity | null = null;
    const releaseChatTransportResources = (): void => {
      stopAuthorizationWatch();
      abortController.signal.removeEventListener('abort', markRequestCancellation);
      unregisterShutdownCancellation();
      actionLeaseHeartbeat?.stop();
      releaseDesktopControlLease?.();
      releaseDesktopControlLease = null;
      sessionLease.release();
    };
    const chatReleaseGate = createDurableForegroundReleaseGate({
      converge: async reason => {
        // Pre-binding exits own no durable action-turn lease.
        if (!foregroundRequestIdentity) return true;
        // An explicit deletion removes this request's transcript and action
        // projection together. Once that deletion is durable there is no
        // deleted lease to reconstruct or endlessly retry. Independently
        // running native work retains its own execution/settlement fencing.
        if (!conversationAuthorization.isCurrent() && readScopedDeletionReceipt(
          { userId: uid, domain: resolvedDomain, orgId: resolvedOrgId },
          'conversation', selectedConversationId,
        )) {
          await flushDBOrThrow();
          return true;
        }
        const releaseResult = await convergeChatForegroundRequestBeforeRelease({
          identity: foregroundRequestIdentity,
          aborted: abortController.signal.aborted,
          reason,
        });
        if (!releaseResult.converged) {
          console.error('[ChatHandler] foreground_request_finalization_incomplete', {
            code: 'CHAT_FOREGROUND_FINALIZATION_INCOMPLETE',
            identity: foregroundRequestIdentity,
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
          identity: foregroundRequestIdentity,
          errorName: String(convergenceError?.name || 'Error'),
          errorMessage: String(convergenceError?.message || 'Unknown convergence error'),
        });
      },
      onRecoveryTakeover: ({ attempts }) => console.error('[ChatHandler] foreground_release_recovery_takeover', {
        code: 'CHAT_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
        identity: foregroundRequestIdentity,
        attempts,
      }),
    });
    const releaseChatSession = (
      reason = 'Chat foreground request reached its release boundary.',
    ): Promise<boolean> => chatReleaseGate.release(reason);

    if (sessionLease.waitingForRequestId) {
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      if (turnAuthorization.isCurrent()) io.to(executionRoom).emit('agent:status', {
        status: activeMessageRelation === 'replace' ? 'replacing' : 'queued',
        source: eventSource,
        requestId,
        waitingForRequestId: sessionLease.waitingForRequestId,
        taskRelation: resolvedTaskRelation,
      });
    }
    if (!await sessionLease.waitForTurn().then(() => true, error => {
      if (!abortController.signal.aborted) throw error;
      return false;
    })) {
      const waitTimedOut = sessionLease.state === 'timed_out';
      const terminalText = waitTimedOut
        ? CN_TASK_EXECUTION_MESSAGES.queueWaitTimedOut
        : CN_TASK_EXECUTION_MESSAGES.cancelled;
      await commitDeterministicTerminal({
        payload: {
          text: terminalText,
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: waitTimedOut ? 'queue_wait_timeout' : 'cancelled',
        },
        persistAssistantMessage: () => addMessageIdempotent({ conversationId: selectedConversationId, role: 'assistant', content: terminalText, cognitiveIntent: waitTimedOut ? 'queue_wait_timeout' : 'task_cancel', }),
        errorContext: waitTimedOut ? 'Queued wait timeout terminal' : 'Queued cancellation terminal',
      });
      await releaseChatSession();
      return;
    }
    let superseded = null as Awaited<ReturnType<typeof beginChatExecutionDurably>>;
    try {
      superseded = await runAfterAcceptedUserTurnAdmission(
        chatAdmission,
        () => beginChatExecutionDurably(executionScope, requestId, {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: 'Lumi',
        }),
      );
    } catch (error) {
      console.error('[ChatHandler] Superseded terminal persistence failed:', error);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      try {
        await recordChatExecutionPersistenceUnknownDurably(
          executionScope,
          requestId,
          unknownPayload,
        );
      } catch (unknownError) {
        console.error('[ChatHandler] Replacement unknown receipt persistence failed:', unknownError);
      }
      publishRecordedAgent('agent:response', unknownPayload);
      await releaseChatSession();
      return;
    }
    if (superseded?.terminalEvent && turnAuthorization.isCurrent()) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    if (!acknowledged) {
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
    }

    try {
      // The turn may have waited behind one or more executions. Re-read the
      // durable conversation and resolve the user's feedback against that
      // exact revision. Never merge a receive-time task id/revision over a
      // newer state: explicit controls are optimistic-concurrency fences.
      turnAuthorization.assertCurrent();
      const refreshedConversation = getConversationForScope(
        conversation.id,
        uid,
        resolvedDomain,
        resolvedOrgId,
      );
      if (!refreshedConversation) {
        await commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: 'Conversation is unavailable for this user or workspace',
            code: 'CHAT_CONVERSATION_REFRESH_FAILED',
          },
          errorContext: 'Conversation refresh failure terminal',
        });
        await releaseChatSession();
        return;
      }
      conversation = refreshedConversation;
      // Explicit memory edits own a durable turn without entering task/tool planning.
      if (!isMemoryAvatar && isExplicitMemoryRequest(visibleUserText)) {
        const receipt = await persistTurnMemory({ userId: uid, domain: resolvedDomain, orgId: resolvedOrgId,
          userText: visibleUserText, channel: 'chat', source: eventSource, requestId, conversationId: conversation.id,
          agentId: conversationAgentId, authorization: turnAuthorization, signal: abortController.signal, llmGetters });
        await commitDeterministicTerminal({
          payload: { text: receipt.text, agentName: 'Lumi', finalized: true, blocked: receipt.status === 'failed',
            reason: receipt.status === 'saved' ? 'memory_saved' : 'memory_not_saved' },
          persistAssistantMessage: () => addMessageIdempotent({
            conversationId: conversation.id, role: 'assistant', content: receipt.text, cognitiveIntent: 'memory',
            llmWasCalled: true, skipActionContinuation: true }),
          errorContext: 'Explicit memory terminal',
        });
        await releaseChatSession();
        return;
      }
      resolvedTaskRelation = revalidateAcceptedTaskRelation(resolvedTaskRelation, conversation.actionContinuationState);
      emitAgent('agent:task_relation', { relation: resolvedTaskRelation });
      if (resolvedTaskRelation.binding === 'stale' || (
        userObservedCompletionTaskId
        && conversation.actionContinuationState?.taskId !== userObservedCompletionTaskId
      )) {
        await commitDeterministicTerminal({
          payload: {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: resolvedTaskRelation.reason || 'stale_control',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            conversationId: conversation.id,
            role: 'assistant',
            content: CN_TASK_EXECUTION_MESSAGES.staleControl,
            cognitiveIntent: 'stale_task_control',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          errorContext: 'Stale foreground task terminal',
        });
        await releaseChatSession();
        return;
      }

      if (userObservedCompletionTaskId && isUserObservedTaskCompletion(visibleUserText, conversation.actionContinuationState)) {
        const observedTask = conversation.actionContinuationState!;
        await clearPendingConfirmationDurably(uid, buildTransportNeutralConfirmationScope({
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          conversationId: conversation.id,
          taskId: observedTask.taskId,
        }));
        pendingConfirmation = null;
        pendingConfirmationPrompt = '';
        const responseText = formatConversationActionTaskStatus({
          ...observedTask, status: 'completed', unfinished: false,
          latestBlocker: '', completionSource: 'user_observation',
        });
        await commitDeterministicTerminal({
          payload: {
            text: responseText, agentName: 'Lumi', finalized: true,
            blocked: false, reason: 'task_user_observation',
          },
          persistAssistantMessage: () => {
            const completed = completeConversationActionFromUserObservation(
              conversation.id, uid, visibleUserText,
              { taskId: observedTask.taskId!, requestId, userMessageId: acceptedUserMessageId },
            );
            if (!completed) throw new Error('User observation no longer owns the pending task');
            addMessageIdempotent({ conversationId: conversation.id,
              role: 'assistant', content: responseText,
              source: 'chat_task_user_observation',
              cognitiveIntent: 'task_user_observation', llmWasCalled: false, skipActionContinuation: true,
            });
          },
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id, agentId: conversationAgentId,
            source: 'chat_task_user_observation',
          }),
          errorContext: 'User-observed task completion terminal',
        });
        await releaseChatSession();
        return;
      }

      if (resolvedTaskRelation.feedback === 'repeat') {
        // Restatement is an exact adjacent-turn read, not a planning request.
        // Resolve it from the persisted transcript so it cannot fall back to
        // an older task, consume model capacity, or inherit tool permissions.
        const repeatTranscript = getMessages(conversation.id);
        let acceptedRepeatIndex = -1;
        for (let index = repeatTranscript.length - 1; index >= 0; index -= 1) {
          const item = repeatTranscript[index];
          if (
            item.role === 'user'
            && String(item.requestId || item.externalMessageId || '') === requestId
          ) {
            acceptedRepeatIndex = index;
            break;
          }
        }
        const responseText = findLatestRepeatableAssistantReply(
          acceptedRepeatIndex >= 0 ? repeatTranscript.slice(0, acceptedRepeatIndex) : [],
        ) || CN_TASK_EXECUTION_MESSAGES.noRepeatableReply;
        await commitDeterministicTerminal({
          payload: {
            text: responseText,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: 'repeat_previous_reply',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            conversationId: conversation.id,
            role: 'assistant',
            content: responseText,
            cognitiveIntent: 'task_repeat',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: eventSource,
          }),
          errorContext: 'Adjacent reply repeat terminal',
        });
        await releaseChatSession();
        return;
      }

      const adjacentConfirmedAction = !pendingConfirmation
        && !conversation.actionContinuationState?.unfinished
        && isExplicitConfirmationReply(visibleUserText)
        ? findAdjacentVerifiedConfirmedAction({
            messages: getMessages(conversation.id, 32),
            currentRequestId: requestId,
          })
        : null;
      const repeatedConfirmationWithoutPending = Boolean(adjacentConfirmedAction);
      if (repeatedConfirmationWithoutPending) {
        const responseText = CN_TASK_EXECUTION_MESSAGES.noPendingConfirmation;
        await commitDeterministicTerminal({
          payload: {
            text: responseText,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: 'no_pending_confirmation',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            conversationId: conversation.id,
            role: 'assistant',
            content: responseText,
            cognitiveIntent: 'duplicate_confirmation_noop',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: eventSource,
          }),
          errorContext: 'Duplicate confirmation no-op terminal',
        });
        await releaseChatSession();
        return;
      }

      // Prior-turn receipt questions are deterministic ledger reads. Resolve
      // them before memory embeddings, RAG, personality assembly, or any model
      // client so a slow provider cannot block a local execution-status answer.
      const runtimeStatusOwnsThisTurn = explicitRuntimeWorkStatusRequest
        && !(
          resolvedTaskRelation.feedback === 'status'
          && ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
          && Boolean(resolvedTaskRelation.taskId)
        );
      const acceptedFollowupIntent = runtimeStatusOwnsThisTurn
        ? 'none' as const
        : taskRelationFollowupIntent(resolvedTaskRelation);
      const acceptedNormalizedIntent = acceptedTurnResolution!.userIntent;
      const confirmationNeedsFreshReview = Boolean(
        acceptedFollowupIntent === 'status'
        && isExplicitConfirmationReply(visibleUserText)
        && conversationActionRequiresFreshConfirmationReview(
          conversation.actionContinuationState,
        ),
      );
      const asksToRecheckPreviousAction = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'previous_action';
      const asksAboutBoundConversationTask = acceptedFollowupIntent === 'status'
        && ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
        && Boolean(resolvedTaskRelation.taskId)
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
        ? String(resolvedTaskRelation.taskId || '').trim()
        : '';
      const mayUseUnboundRecheckFallback = asksToRecheckPreviousAction
        && !serverBoundRecheckTaskId
        && resolvedTaskRelation.binding === 'conversation'
        && !controlTargetRequestId
        && !controlTargetTaskId
        && controlTargetRevision === undefined;
      const previousActionState = asksToRecheckPreviousAction
        ? serverBoundRecheckTaskId
          ? getConversationActionStateByTaskId(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
              conversationId: conversation.id,
              userId: uid,
              taskId: serverBoundRecheckTaskId,
            })
          : mayUseUnboundRecheckFallback
            ? getConversationActionStateFromLedger(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
                conversationId: conversation.id,
                userId: uid,
                query: visibleUserText,
              })
            : null
        : null;
      const runtimeCancellationRecheck = pendingRuntimeCancellationRecheck(previousActionState);
      if (await answerPriorTaskStatus({ runtimeCancellationRecheck, get conversation() { return conversation; }, set conversation(value) { conversation = value; }, uid, visibleUserText, requestId, acceptedUserMessageId, get foregroundRequestIdentity() { return foregroundRequestIdentity; }, set foregroundRequestIdentity(value) { foregroundRequestIdentity = value; }, get resolvedTaskRelation() { return resolvedTaskRelation; }, set resolvedTaskRelation(value) { resolvedTaskRelation = value; }, emitAgent, toolSecurityContext, resolvedDomain, resolvedOrgId, get acceptedTurnResolution() { return acceptedTurnResolution; }, set acceptedTurnResolution(value) { acceptedTurnResolution = value; }, previousActionState, abortController, isChatCancelled, formatToolResultForUi, commitDeterministicTerminal, conversationAgentId, addMessageIdempotent, emitConversationUpdated, conversationTurn, releaseChatSession, acceptedFollowupIntent, confirmationNeedsFreshReview, asksAboutBoundConversationTask, asksAboutRecentConversationTask, acceptedNormalizedIntent, serverBoundRecheckTaskId })) return;

      // `deferActionPreparation` persisted only the transcript while this
      // request waited. Now that this request owns the serial lease, bind its
      // exact user row. A different pending request is an integrity failure,
      // not permission to overwrite the pointer and mis-attribute receipts.
      if (resolvedTaskRelation.feedback !== 'status') {
        const preserveExistingTask = (
          ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
          && ['continue', 'correction', 'accept', 'retry', 'repeat'].includes(
            resolvedTaskRelation.feedback,
          )
        );
        const boundTurn = bindConversationActionExecutionTurn({
          conversationId: conversation.id,
          userId: uid,
          userText: visibleUserText,
          requestId,
          userMessageId: acceptedUserMessageId,
          preserveExistingTask,
        });
        if (!boundTurn) {
          await commitDeterministicTerminal({
            event: 'agent:error',
            payload: {
              message: 'Unable to bind this queued message to the action pipeline',
              code: 'CHAT_ACTION_TURN_BIND_FAILED',
            },
            errorContext: 'Action turn binding failure terminal',
          });
          await releaseChatSession();
          return;
        }
        conversation = getConversationForScope(
          conversation.id,
          uid,
          resolvedDomain,
          resolvedOrgId,
        ) || conversation;
      }
      let { relevantMemories, ragChunks, emotionalState, personalityConfig, kbContext, isNovel, himState, emotionKey } = await retrieveChatContext({ isMemoryAvatar, memoryAvatar, get personalityId() { return personalityId; }, uid, resolvedDomain, resolvedOrgId, markTurnTiming, text, conversationAgentId, abortController, turnAuthorization, requestScope });

      // ── Conversation mode: get/create conversation, apply mode from payload ──
      const conversationId = conversation?.id;
      if (conversationTurn.rolledOver) {
        console.log(
          '[ChatHandler] rolled over oversized conversation:',
          conversationTurn.previousConversationId,
          '->',
          conversationId,
        );
        // The client may still send its old local transcript after a server-side
        // rollover. Re-evaluate direct client intent without letting that stale
        // transcript reactivate a prior UI task.
        chatContextBridge = buildClientSurfaceContinuationBridge(visibleUserText, []);
        await clearPendingConfirmationDurably(uid, confirmationScope);
        pendingConfirmation = null;
        pendingConfirmationPrompt = '';
      }
      const conversationMode = payloadMode || conversation?.mode || undefined;
      if (conversation && payloadMode && payloadMode !== conversation.mode) {
        setConversationMode(conversation.id, payloadMode);
      }
      console.log('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      if (conversationId && confirmationCancellationRequested) {
        const cancelled = cancelConversationActionExecution(conversationId, uid);
        const cancelledCurrentTask = cancelled?.status === 'cancelled';
        if (cancelledCurrentTask || pendingConfirmationCleared) {
          const responseText = pendingConfirmationCleared
            ? '已取消刚才等待确认的操作；它没有执行，也不会继续发送。'
            : CN_TASK_EXECUTION_MESSAGES.cancelled;
          await commitDeterministicTerminal({
            payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
            persistAssistantMessage: () => addMessageIdempotent({ conversationId, role: 'assistant', content: responseText, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
            publishAfter: () => emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId }),
            errorContext: 'Pending confirmation cancellation terminal',
          });
          await releaseChatSession();
          return;
        }
        const boundTerminalTask = resolvedTaskRelation.taskId
          ? getConversationActionStateByTaskId(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
              conversationId,
              userId: uid,
              taskId: resolvedTaskRelation.taskId,
            })
          : getLatestConversationActionState(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), { conversationId, userId: uid });
        if (boundTerminalTask && !boundTerminalTask.unfinished) {
          const english = !/[\u3400-\u9fff]/u.test(visibleUserText);
          const responseText = english
            ? boundTerminalTask.status === 'completed'
              ? `The task "${boundTerminalTask.goal || 'the previous task'}" is already completed. Cancellation cannot undo its recorded result, and I did not execute anything again.`
              : `The task "${boundTerminalTask.goal || 'the previous task'}" is already ${boundTerminalTask.status || 'terminal'}. There is nothing left to stop, and I did not execute anything again.`
            : CN_TASK_EXECUTION_MESSAGES.terminalCannotCancel(
                boundTerminalTask.goal,
                boundTerminalTask.status || 'terminal',
              );
          await commitDeterministicTerminal({
            payload: {
              text: responseText,
              agentName: 'Lumi',
              finalized: true,
              blocked: false,
              reason: 'task_already_terminal',
            },
            persistAssistantMessage: () => addMessageIdempotent({
              conversationId,
              role: 'assistant',
              content: responseText,
              cognitiveIntent: 'task_already_terminal',
              llmWasCalled: false,
              skipActionContinuation: true,
            }),
            publishAfter: () => emitConversationUpdated({
              conversationId,
              agentId: conversationAgentId,
              source: 'chat',
              rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            }),
            errorContext: 'Terminal task cancellation no-op',
          });
          await releaseChatSession();
          return;
        }
        const responseText = '当前没有等待确认或正在执行的操作。';
        await commitDeterministicTerminal({
          payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
          persistAssistantMessage: () => addMessageIdempotent({ conversationId, role: 'assistant', content: responseText, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
          publishAfter: () => emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId }),
          errorContext: 'No pending confirmation terminal',
        });
        await releaseChatSession();
        return;
      }

      const persistedConversationHistory = conversationId
        ? getMessages(conversationId, TASK_TARGET_HISTORY_LIMIT).filter(record => !(
            record.role === 'user'
            && (
              record.requestId === requestId
              || (
                record.externalMessageId === requestId
                && record.source === eventSource
                && record.channel === 'chat'
              )
            )
          ))
        : [];
      if (!chatContextBridge && conversationId && isShortClientContinuation(visibleUserText)) {
        const dbHistoryItems = persistedConversationHistory.slice(-12)
          .map(record => ({ role: record.role, message: record.message, response: record.response }));
        chatContextBridge = buildClientSurfaceContinuationBridge(visibleUserText, dbHistoryItems);
      }
      actionContinuationBridge = explicitRuntimeWorkStatusRequest
        ? ''
        : buildRecentActionContinuationBridge(
            visibleUserText,
            conversationTurn.rolledOver
              ? persistedConversationHistory
              : [...historyItems, ...persistedConversationHistory],
            conversation?.actionContinuationState,
          );
      const taskRelationContext = formatActiveTaskRelationContext(
        resolvedTaskRelation,
        conversation?.actionContinuationState,
      );
      if (taskRelationContext) {
        actionContinuationBridge = [actionContinuationBridge, taskRelationContext]
          .filter(Boolean)
          .join('\n\n');
      }
      const operationMode = (() => {
        if (typeof data.operationMode === 'string') return normalizeOperationMode(data.operationMode);
        try {
          return getStoredOperationMode(uid);
        } catch {}
        return 'assistant';
      })();
      let { turnFlow, executionPipeline, personality, effectiveSystemPrompt, executionTaskText, completionTaskText } = await prepareChatPromptContext({ get sensoryFn() { return sensoryFn; }, uid, get relevantMemories() { return relevantMemories; }, get ragChunks() { return ragChunks; }, get emotionalState() { return emotionalState; }, text, resolvedDomain, resolvedOrgId, isMemoryAvatar, get personalityConfig() { return personalityConfig; }, get personalityId() { return personalityId; }, toolSecurityContext, conversationId, conversationMode, get buildNaturalReplyStyleOverlay() { return buildNaturalReplyStyleOverlay; }, eventSource, get pendingConfirmationPrompt() { return pendingConfirmationPrompt; }, set pendingConfirmationPrompt(value) { pendingConfirmationPrompt = value; }, get chatContextBridge() { return chatContextBridge; }, set chatContextBridge(value) { chatContextBridge = value; }, get actionContinuationBridge() { return actionContinuationBridge; }, set actionContinuationBridge(value) { actionContinuationBridge = value; }, visibleUserText, mediaRoutingEnvelope, requestId, get acceptedTurnResolution() { return acceptedTurnResolution; }, set acceptedTurnResolution(value) { acceptedTurnResolution = value; }, structuredMediaRequest, get category() { return category; }, operationMode, conversationAgentId, get conversation() { return conversation; }, set conversation(value) { conversation = value; }, get resolvedTaskRelation() { return resolvedTaskRelation; }, set resolvedTaskRelation(value) { resolvedTaskRelation = value; }, persistedConversationHistory, get pendingAssistantOfferContext() { return pendingAssistantOfferContext; }, set pendingAssistantOfferContext(value) { pendingAssistantOfferContext = value; }, attachments, get kbContext() { return kbContext; } });

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
        emitAgent("agent:tool_call", normalized);
        emitAgent("agent:tool", normalized);
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
        if (!turnAuthorization.isCurrent()) return;
        persistLumiPostTurnLearning(
          {
            userId: uid,
            userText: text,
            defaultChannel: 'chat',
            flow: turnFlow,
            getToolNames: () => toolRegistry.getToolDeclarations({
              context: { userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource },
            }).map(declaration => declaration.function.name),
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            defaultSourceInteractionId: interactionId,
            agentId: conversationAgentId,
            source: eventSource,
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
          userId: uid,
          userText: text,
          assistantText,
          source: options.source || 'chat',
          interactionId: options.sourceInteractionId || interactionId,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          flow: turnFlow,
          capabilitySelection: options.capabilitySelection || executionPipeline.capabilityPlan,
          toolRecords: currentToolRecords,
          finalizationBlocked: options.finalizationBlocked === true,
          assistantTextTrusted: options.assistantTextTrusted
            ?? options.finalizationBlocked !== true,
          finalizationReason: options.finalizationReason,
        });
        return executionWriteback;
      };
      const refreshDurableTaskRelation = (
        exactTaskId = resolvedTaskRelation?.taskId || '',
      ): ActiveTaskMessageResolution | null => {
        return refreshResolvedTaskRelationFromLedger(conversationId, exactTaskId);
      };
      const refreshTerminalPayloadTaskRelation = (
        payload: Record<string, any>,
        exactTaskId = resolvedTaskRelation?.taskId || '',
      ) => {
        const relation = refreshDurableTaskRelation(exactTaskId);
        if (relation) payload.taskRelation = relation;
        return relation;
      };
      const publishDurableTaskRelation = (exactTaskId = resolvedTaskRelation?.taskId || '') => {
        if (!turnAuthorization.isCurrent()) return;
        const relation = refreshDurableTaskRelation(exactTaskId);
        if (!relation) return;
        io.to(executionRoom).emit('agent:task_relation', {
          relation,
          taskRelation: relation,
          source: eventSource,
          requestId,
          conversationId,
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
        persistTerminalReceipt: () => persistAuthorizedTerminalReceipt(
          'agent:response', input.payload, input.unknownPayload,
        ),
        persistUnknownReceipt: async () => {
          if (input.repairUnknownAssistant && conversationId) {
            const updated = updateAssistantMessageTerminalPresentation({
              userId: uid, conversationId, requestId, content: input.unknownPayload.text,
              completionFeedback: input.unknownPayload.completionFeedback, source: eventSource, channel: 'chat',
            });
            if (!updated) addMessageIdempotent({ conversationId,
              role: 'assistant', content: input.unknownPayload.text, personality: personality.id,
              cognitiveIntent: 'persistence_unknown', llmWasCalled: input.llmWasCalled,
              completionFeedback: input.unknownPayload.completionFeedback });
            try { await flushDBOrThrow(); } catch {}
          }
          return recordChatExecutionPersistenceUnknownDurably(executionScope, requestId, input.unknownPayload);
        },
        publishCommitted: executionWriteback => {
          if (input.notification) publishRecordedAgent('agent:notification', normalizeAgentPayload('agent:notification', input.notification));
          if (executionWriteback?.recorded) publishRecordedAgent('agent:task_execution_writeback', normalizeAgentPayload('agent:task_execution_writeback', executionWriteback));
          publishRecordedAgent('agent:response', input.payload);
          publishDurableTaskRelation();
          if (conversationId) emitConversationUpdated({ conversationId, agentId: conversationAgentId,
            source: input.updateSource || 'chat', rolledOver: conversationTurn.rolledOver,
            previousConversationId: conversationTurn.previousConversationId });
        },
        publishUnknown: () => publishRecordedAgent('agent:response', input.unknownPayload),
        persistenceUnknownProjection: { text: input.unknownPayload.text,
          completionFeedback: input.unknownPayload.completionFeedback, reason: 'Terminal persistence outcome is unknown.' },
        onPersistenceError: error => console.error('[ChatHandler] ' + input.errorContext, error),
      });

      const actionFollowupIntent = executionPipeline.actionFollowupIntent;
      const operationModeMetaText = buildOperationModeMetaResponse({
        text: visibleUserText,
        operationMode: turnFlow.operationMode,
        source: eventSource,
      });
      const executionFactText = conversationId && isConversationExecutionFactQuestion(visibleUserText)
        ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId,
          userId: uid,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          currentRequestId: requestId,
        }), visibleUserText)
        : '';
      const exactCorrectionText = conversationId
        ? resolveExactConversationCorrection(visibleUserText, persistedConversationHistory)
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
        await commitDeterministicTerminal({
          payload: {
            text: deterministicConversationResponse.text,
            agentName: personality.name,
            finalized: true,
            blocked: false,
            reason: deterministicConversationResponse.intent,
          },
          persistAssistantMessage: conversationId
            ? () => addMessageIdempotent({
            conversationId,
            role: 'assistant',
            content: deterministicConversationResponse.text,
            personality: personality.id,
            source: deterministicConversationResponse.source,
            cognitiveIntent: deterministicConversationResponse.intent,
            llmWasCalled: false,
          })
            : undefined,
          publishAfter: conversationId
            ? () => {
            emitConversationUpdated({
            conversationId,
            agentId: conversationAgentId,
            source: deterministicConversationResponse.source,
            rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            });
          }
            : undefined,
          errorContext: 'Deterministic conversation terminal',
        });
        await releaseChatSession();
        return;
      }

      const groundedTurnEvidence: string[] = [];
      if (conversationId && actionFollowupIntent === 'status') {
        groundedTurnEvidence.push(`Current action status evidence:\n${getConversationActionStatus(
          conversationId,
          uid,
          visibleUserText,
          conversation?.actionContinuationState,
          resolvedTaskRelation.taskId || '',
        )}`);
      }
      const recentFailureExplanation = conversationId && !pendingConfirmation
        ? buildRecentFailureExplanation(visibleUserText, getMessages(conversationId, 24))
        : '';
      if (recentFailureExplanation) {
        groundedTurnEvidence.push(`Recent failure evidence:\n${recentFailureExplanation}`);
      }
      if (groundedTurnEvidence.length) {
        effectiveSystemPrompt += [
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
        userId: uid, source: eventSource, requestId, actionIntent: visibleUserText,
        pending: pendingConfirmation,
        consumeScope: () => confirmationScope,
        proposalScope: () => {
          confirmationScope = buildTransportNeutralConfirmationScope({
            domain: resolvedDomain, orgId: resolvedOrgId, conversationId: conversationId || selectedConversationId,
            taskId: actionTaskExecution.state?.taskId, originRequestId: requestId,
          });
          confirmationChannelScope = buildTransportNeutralConfirmationScope({
            domain: resolvedDomain, orgId: resolvedOrgId, conversationId: conversationId || selectedConversationId,
          });
          return confirmationScope;
        },
        correctionRequiresFreshConfirmation,
        exactWriteCorrection: correctionRequiresFreshConfirmation && confirmationResolution.revokedCorrectionBasis?.toolName === 'write_file',
        recoveryCall: () => runtimeOwnedDeterministicRecoveryCall,
        assertCurrent: () => turnAuthorization.assertCurrent(),
        isCancelled: isChatCancelled,
        onPending: pending => {
          pendingConfirmationCreatedThisTurn = pending;
          pendingConfirmationAssistantState = formatPendingConfirmationRequest(pending);
          if (conversationId) setConversationActionExecutionStatus(conversationId, uid, 'waiting_confirmation', {
            assistantState: pendingConfirmationAssistantState, requestId,
          });
        },
      });

      emitAgent("agent:status", { status: "thinking", agentName: personality.name });
      console.log('[ChatHandler] emitted agent:status thinking');

      // Inject operation mode prompt overlay
      const effectiveOperationMode = turnFlow.effectiveOperationMode;
      const selfRepairTurn = turnFlow.selfRepairTurn;
      const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
      const workSurfaceRoute = turnFlow.workSurfaceRoute;
      const visionIntent = turnFlow.visionIntent;
      const executionDecision = executionPipeline.execution;
      const intentTrace = executionPipeline.intentTrace;
      const capabilitySelection = executionPipeline.capabilityPlan;
      const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
        channel: 'chat',
        text: turnFlow.routeText,
        flow: turnFlow,
        capabilitySelection,
        capabilityExecutionPlan: executionPipeline.executionPlan,
      });
      const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
      const toolRoute = executionDecision.toolRoute;
      const modelCapabilityPolicy = executionPipeline.authorizationPolicy;
      const modelToolProjection = executionPipeline.modelToolProjection;
      const existingActionState = conversation?.actionContinuationState;
      const toolSessionActive = !isMemoryAvatar && executionPipeline.executionRequested
        && modelToolProjection.toolNames.length > 0;
      // The semantic execution plan owns durable task creation. Main Chat may
      // expose a tool manifest to the model for open-ended reasoning, but that
      // alone does not make a greeting or ordinary conversation an executable
      // task. Only turns whose flow requires completion evidence/tool work (or
      // a pending confirmation) receive a durable task identity before relay.
      const bindsExistingAction = Boolean(
        existingActionState?.taskId
        && ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
        && ['continue', 'correction', 'accept', 'retry'].includes(resolvedTaskRelation.feedback),
      );
      // Cleanup creates its own task; a bound continuation or pending grant resumes the existing task.
      const resumesAction = Boolean(
        (bindsExistingAction && conversationId) || (existingActionState?.taskId && pendingConfirmation),
      );
      const preparation = acceptedRuntimeCleanupOffer && conversationId
        ? {
            conversationId,
            toolPolicy: { allowedTools: ['runtime_work_cancel'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 },
            forceTask: true, forceNewTask: true, preserveExistingTask: false,
          }
        : resumesAction
          ? {
              conversationId: conversationId || selectedConversationId,
              toolPolicy: modelCapabilityPolicy, followupIntent: actionFollowupIntent,
              forceResume: true, preserveExistingTask: true,
            }
          : conversationId && (capabilitySelection.taskLedgerRequired || pendingConfirmation || structuredMediaRequest)
            ? { conversationId, toolPolicy: modelCapabilityPolicy, followupIntent: actionFollowupIntent, forceTask: true }
            : null;
      const actionTaskExecution = preparation
        ? prepareConversationActionExecution({
            userId: uid, userText: visibleUserText, requestId, userMessageId: acceptedUserMessageId,
            ...preparation,
          })
        : { state: null, kind: 'conversation' as const, turnRowId: undefined };
      if ('bindingFailure' in actionTaskExecution) {
        const staleText = actionTaskExecution.bindingFailure === 'busy'
          ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
          : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
        await commitDeterministicTerminal({
          payload: {
            text: staleText,
            agentName: personality.name,
            source: 'chat_turn_binding',
            finalized: true,
            blocked: true,
            reason: actionTaskExecution.diagnosticCode,
          },
          persistAssistantMessage: () => addMessageIdempotent({
            conversationId: conversation.id,
            role: 'assistant',
            content: staleText,
            personality: personality.id,
            source: 'chat_turn_binding',
            cognitiveIntent: actionTaskExecution.diagnosticCode,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: 'chat_turn_binding',
          }),
          errorContext: 'Action turn binding terminal',
        });
        await releaseChatSession();
        return;
      }
      const durableTaskId = actionTaskExecution.state?.taskId;
      requestTaskId = durableTaskId;
      receiptObserver = createConversationReceiptObserver({
        userId: uid, conversationId: conversation.id, taskId: durableTaskId,
        requestId, turnRowId: actionTaskExecution.turnRowId, domain: resolvedDomain, orgId: resolvedOrgId,
      }, turnAuthorization.isCurrent);
      if (structuredMediaRequest && actionTaskExecution.state?.taskId) {
        const structuredMediaRecoveryCall = buildStructuredMediaDeterministicToolRecoveryCall(
          structuredMediaRequest,
          {
            taskId: actionTaskExecution.state.taskId,
            taskRevision: Math.max(0, Math.trunc(Number(actionTaskExecution.state.revision) || 0)),
            requestId,
          },
        );
        if (!structuredMediaRecoveryCall) {
          throw new Error('Unable to bind the structured media request to its durable task');
        }
        runtimeOwnedDeterministicRecoveryCall = structuredMediaRecoveryCall;
      } else {
        runtimeOwnedDeterministicRecoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
          actionTaskExecution.state,
          requestId,
          confirmationResolution.revokedCorrectionBasis,
        );
      }
      foregroundRequestIdentity = Object.freeze({
        conversationId: conversation.id,
        userId: uid,
        requestId,
        ...(durableTaskId ? { expectedTaskId: durableTaskId } : {}),
      });
      const leaseUnknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
        agentName: personality.name,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({
        conversationId: conversation.id,
        userId: uid,
        requestId,
        abortController,
        onPersistenceUnknown: async () => {
          const recorded = await recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            requestId,
            leaseUnknownPayload,
          );
          if (recorded) publishRecordedAgent('agent:response', leaseUnknownPayload);
        },
      });
      if (durableTaskId) {
        resolvedTaskRelation = bindPreparedTaskMessageRelation(resolvedTaskRelation, actionTaskExecution);
        emitAgent('agent:task_relation', { relation: resolvedTaskRelation, phase: 'prepared' });
      }
      // ── Desktop relay: route tools to the user's registered desktop client, not only this chat socket ──
      const desktopRelay = createDesktopRelay({
        io,
        userId: uid,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        source: 'chat',
        taskId: durableTaskId,
        requestId,
        requestSocket: socket,
        emitToolLifecycle,
        onLateResult: receiptObserver.onDesktopLateResult,
        formatResultForLifecycle: formatToolResultForUi,
        // The foreground execution belongs to the durable task, not to this
        // transport connection. The relay still has its own bounded timeout.
        cancelOnRequestSocketDisconnect: false,
        signal: abortController.signal,
      });
      releaseDesktopControlLease = () => desktopRelay.releaseControlLease('chat_turn_complete');
      // The admitted request owns one capability context across execution, confirmation and recovery.
      const toolContext: ToolContext = {
        ...toolSecurityContext,
        userId: uid,
        taskId: durableTaskId,
        conversationId: conversation.id,
        turnId: requestId,
        turnRowId: actionTaskExecution.turnRowId,
        requestId,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        desktopRelay,
        llmGetters,
        supervisedExternalCommits: true,
        allowLocalFileWrites,
        localWriteIntentReason,
        executionSignal: abortController.signal,
        isCancelled: isChatCancelled,
        onProgress: forwardToolProgress,
        toolPolicy: modelCapabilityPolicy,
        modelToolProjection,
        actionIntent: visibleUserText,
        currentTurnExecutionRequested: executionPipeline.executionRequested,
        resolutionId: executionPipeline.resolution.id,
        trustedActionContinuation: executionPipeline.trustedActionContinuation,
        routedTaskText: turnFlow.routeText,
        acceptedTaskTarget: turnFlow.acceptedTaskTarget,
        currentAppTarget: turnFlow.currentAppEditTarget,
      };

      const priorTaskRecords = actionTaskExecution.kind === 'resume'
        ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
        : [];
      const taskAwareRecords = (records: ToolExecutionRecord[]) => (
        coalesceToolExecutionRecords([...priorTaskRecords, ...records])
      );
      collectRequestTerminalRecords = () => withDesktopExecutionReceipt(requestToolRecords, desktopExecutionTracker);
      const needsExecutionPrompt = toolSessionActive && toolSecurityContext.executionBoundary !== 'remote_restricted';
      if (needsExecutionPrompt || (toolSecurityContext.executionBoundary !== 'remote_restricted' && turnFlow.conceptualCapabilityQuestion)) {
        effectiveSystemPrompt += '\n\n' + formatClientSelfPromptForTurn(uid, visibleUserText, { domain: resolvedDomain, orgId: resolvedOrgId });
      }
      console.log('[ChatHandler] tool gate:', executionDecision.allowToolUse ? 'authorized' : 'off', 'session:', toolSessionActive ? 'active' : 'conversation', 'operationMode:', operationMode, 'effective:', effectiveOperationMode, 'surface:', turnFlow.surface, 'clientActionOnly:', clientActionOnlyTurn, 'selfRepair:', selfRepairTurn, 'capabilityLane:', capabilitySelection.lane, 'trace:', intentTrace.summary, 'route:', toolRoute ? `${toolRoute.toolNames.length}/${toolRoute.totalAvailable} ${toolRoute.categories.join(',') || 'fallback'}` : 'none');
      if (turnAuthorization.isCurrent()) socket.emit('agent:intent_trace', intentTrace);
      if (toolRoute && turnAuthorization.isCurrent()) {
        socket.emit('agent:tool_route', {
          categories: toolRoute.categories,
          reasons: toolRoute.reasons,
          toolNames: toolRoute.toolNames,
          totalAvailable: toolRoute.totalAvailable,
          truncated: toolRoute.truncated,
          trace: intentTrace,
        });
      }
      const visiblePreferredTools = restrictVisibleToolNamesForExecutionBoundary(
        capabilitySelection.preferredTools,
        toolSecurityContext.executionBoundary,
      );
      const remoteRestricted = toolSecurityContext.executionBoundary === 'remote_restricted';
      emitAgent('agent:capability_selection', {
        lane: remoteRestricted
          ? (visiblePreferredTools.length > 0 ? 'web_or_account' : 'conversation')
          : capabilitySelection.lane,
        primary: remoteRestricted
          ? (visiblePreferredTools[0] || 'conversation')
          : capabilitySelection.primary,
        reasons: remoteRestricted
          ? ['remote execution boundary applied']
          : capabilitySelection.reasons,
        preferredTools: visiblePreferredTools,
        source: eventSource,
      });
      if (desktopExecutionPolicy.applies && toolSecurityContext.executionBoundary !== 'remote_restricted') {
        emitAgent('agent:desktop_execution_policy', {
          reason: desktopExecutionPolicy.reason,
          evidenceTools: desktopExecutionPolicy.evidenceTools,
          actuationTools: desktopExecutionPolicy.actuationTools,
          verificationTools: desktopExecutionPolicy.verificationTools,
          source: eventSource,
        });
      }
      if (!remoteRestricted) {
        effectiveSystemPrompt += '\n\n' + buildInteractionModeOverlay(turnFlow);
      }
      if (workSurfaceRoute.promptOverlay && needsExecutionPrompt) {
        effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
      }
      effectiveSystemPrompt += '\n\n' + executionBoundaryPromptOverlay(
        executionDecision.promptOverlay,
        toolSecurityContext.executionBoundary,
      );
      if (needsExecutionPrompt) {
        effectiveSystemPrompt += '\n\n' + capabilitySelection.promptOverlay;
      }
      if (desktopExecutionPolicy.promptOverlay && needsExecutionPrompt) {
        effectiveSystemPrompt += '\n\n' + desktopExecutionPolicy.promptOverlay;
      }
      const visionRoutingOverlay = effectiveOperationMode !== 'meeting'
        && needsExecutionPrompt
        ? buildVisionRoutingOverlay(uid, text)
        : '';
      if (visionRoutingOverlay) {
        effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
      }
      if (needsExecutionPrompt) {
        effectiveSystemPrompt += '\n\n' + buildLumiOperatingKernelPrompt({
          channel: 'chat',
          flow: turnFlow,
        });
      }

      const executesAcceptedRuntimeCleanupOffer = Boolean(
        acceptedRuntimeCleanupOffer
        && resolvedTaskRelation.feedback === 'accept'
        && resolvedTaskRelation.taskRelation === 'confirm'
      );
      if (executesAcceptedRuntimeCleanupOffer) {
        const offeredToolCall = acceptedRuntimeCleanupOffer!.toolCall;
        const exactArguments = {
          taskIds: [...offeredToolCall.arguments.taskIds],
        };
        const cleanupRecord = await executeToolCall({
          registry: toolRegistry,
          id: `runtime_cleanup_offer_${requestId}`,
          name: offeredToolCall.name,
          arguments: exactArguments,
          executionOrigin: 'deterministic_route',
          context: {
            ...toolSecurityContext,
            userId: uid,
            taskId: durableTaskId,
            conversationId: conversation.id,
            turnId: requestId,
            turnRowId: actionTaskExecution.turnRowId,
            requestId,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            toolPolicy: modelCapabilityPolicy,
            actionIntent: visibleUserText,
            currentTurnExecutionRequested: executionPipeline.executionRequested,
              resolutionId: executionPipeline.resolution.id,
            trustedActionContinuation: executionPipeline.trustedActionContinuation,
            routedTaskText: visibleUserText,
            acceptedTaskTarget: turnFlow.acceptedTaskTarget,
            currentAppTarget: turnFlow.currentAppEditTarget,
            requestConfirmation: requestToolConfirmation,
            executionSignal: abortController.signal,
            isCancelled: isChatCancelled,
          },
        });
        emitToolLifecycle({
          correlationId: cleanupRecord.id || `runtime_cleanup_offer_${requestId}`,
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
        const cleanupText = formatRuntimeCleanupReceipt(visibleUserText, cleanupReceipt);
        const cleanupReason = cleanupVerified
          ? 'runtime_cleanup_offer_completed'
          : 'runtime_cleanup_offer_incomplete';
        const cleanupCompletionFeedback = durableTaskId
          ? buildForegroundTaskCompletionFeedback({
              taskId: durableTaskId,
              taskLabel: visibleUserText,
              toolRecords: taskAwareRecords([cleanupRecord]),
              blocked: !cleanupVerified,
              reason: cleanupVerified ? '' : cleanupRecord.error
                || cleanupRecord.terminalVerification?.reason
                || cleanupReason,
            })
          : undefined;
        const cleanupTerminalPayload = normalizeAgentPayload('agent:response', {
          text: cleanupText,
          agentName: personality.name,
          finalized: true,
          blocked: !cleanupVerified,
          reason: cleanupReason,
          completionFeedback: cleanupCompletionFeedback,
        });
        const cleanupUnknownPayload = normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: personality.name,
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
          completionFeedback: durableTaskId
            ? buildForegroundTaskCompletionFeedback({
                taskId: durableTaskId,
                taskLabel: visibleUserText,
                toolRecords: taskAwareRecords([cleanupRecord]),
                status: 'persistence_unknown',
                reason: 'Terminal persistence outcome is unknown.',
              })
            : undefined,
        });
        const cleanupCommitted = await commitRecordedTerminal({
          persistTerminalState: () => persistChatTakeoverExecution(cleanupText, {
            toolRecords: [cleanupRecord],
            source: 'chat_runtime_cleanup_offer',
            sourceInteractionId: interactionId,
            capabilitySelection,
            finalizationBlocked: !cleanupVerified,
            assistantTextTrusted: cleanupVerified,
            finalizationReason: cleanupReason,
          }),
        persistAssistantMessage: () => {
            const summary = summarizeToolRecordForPersistence(cleanupRecord);
            if (summary) {
              addMessage({
                userId: uid,
                agentId: conversationAgentId,
                conversationId: conversation.id,
                role: 'tool',
                content: summary,
                domain: resolvedDomain,
                orgId: resolvedOrgId,
              });
            }
            addMessageIdempotent({
              conversationId: conversation.id,
              role: 'assistant',
              content: cleanupText,
              personality: personality.id,
              source: 'chat_runtime_cleanup_offer',
              toolCalls: [cleanupRecord],
              cognitiveIntent: cleanupReason,
              llmWasCalled: false,
              completionFeedback: cleanupCompletionFeedback,
            });
            // `addMessageIdempotent` finalizes the foreground action and may
            // remove the live conversation pointer. Rebuild from the durable
            // task row now, before the recovery receipt captures this payload.
            refreshTerminalPayloadTaskRelation(cleanupTerminalPayload, durableTaskId);
          },
          payload: cleanupTerminalPayload,
          unknownPayload: cleanupUnknownPayload,
          updateSource: 'chat_runtime_cleanup_offer',
          errorContext: 'Runtime cleanup offer terminal persistence failed:'
        });
        if (cleanupCommitted) {
          actionLeaseHeartbeat?.stop();
        }
        await releaseChatSession();
        return;
      }

      // Keep this late so English system/tool context cannot pull the reply language.
      effectiveSystemPrompt += '\n\n' + buildResponseLanguageInstruction(text);

      // Work-domain chats use organization LLM prefs when configured. If the org
      // has no explicit policy, they visibly inherit the user's personal prefs.
      const userLLMPrefs = getScopedPreferredLLM(uid, { domain: resolvedDomain, orgId: resolvedOrgId });
      let activeProvider = userLLMPrefs.provider || 'deepseek';
      let activeModel = userLLMPrefs.model;
      const reasoningRoutePolicy = {
        // Image/person setup already has bounded schemas and receipts. Avoid spending
        // the semantic-output deadline on hidden reasoning before the first tool call.
        ...(toolRoute?.categories.includes('memory_avatar') ? { thinkingMode: 'disabled' as const } : {}),
        selectionMode: userLLMPrefs.selectionMode,
        fallbackCandidates: userLLMPrefs.fallbackCandidates,
        allowCloudFallback: userLLMPrefs.allowCloudFallback,
        conversationId: conversationId || '',
        requestId,
        ...(nativeRequestBinding || {}),
        interactionId,
        source: 'chat',
        inputTokenBudget: resolveModelRequestInputBudget(),
      };

      // Hybrid dispatch is opt-in only; do not change providers unless the user chose auto.
      if (llmGetters.isOllamaAvailable() && userLLMPrefs.provider === 'auto') {
        // Availability is observational only; automatic routing resolves the
        // user's exact local model and cloud fallback in the shared dispatcher.
        console.log('[Chat] Automatic model routing enabled with persisted local and fallback selections');
      }

      const scheduleChatSummary = (targetConversationId: string) => {
        scheduleConversationSummary({
          isAuthorized: turnAuthorization.isCurrent,
          userId: uid,
          provider: activeProvider,
          model: activeModel,
          ...reasoningRoutePolicy,
          conversationId: targetConversationId,
          source: 'chat_summary',
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          llmGetters,
          log: { info: console.log, warn: console.warn },
        });
      };
      if (pendingConfirmation) { await executeConfirmedChatTurn({ toolContext, get pendingConfirmation() { return pendingConfirmation; }, set pendingConfirmation(value) { pendingConfirmation = value; }, visibleUserText, uid, get confirmationScope() { return confirmationScope; }, set confirmationScope(value) { confirmationScope = value; }, emitAgent, get personality() { return personality; }, emitToolLifecycle, durableTaskId, requestId, resolvedDomain, resolvedOrgId, abortController, isChatCancelled, get turnFlow() { return turnFlow; }, modelCapabilityPolicy, rememberRequestToolRecord, formatToolResultForUi, formatMediaArtifactReceiptForUi, taskAwareRecords, runAuthorizedTools, get effectiveSystemPrompt() { return effectiveSystemPrompt; }, set effectiveSystemPrompt(value) { effectiveSystemPrompt = value; }, acceptedUserMessageId, get activeProvider() { return activeProvider; }, set activeProvider(value) { activeProvider = value; }, get activeModel() { return activeModel; }, set activeModel(value) { activeModel = value; }, reasoningRoutePolicy, requestToolConfirmation, desktopExecutionTracker, interactionId, turnAuthorization, get socket() { return socket; }, requestToolRecords, get pendingConfirmationCreatedThisTurn() { return pendingConfirmationCreatedThisTurn; }, set pendingConfirmationCreatedThisTurn(value) { pendingConfirmationCreatedThisTurn = value; }, normalizeAgentPayload, conversationId, get pendingConfirmationAssistantState() { return pendingConfirmationAssistantState; }, set pendingConfirmationAssistantState(value) { pendingConfirmationAssistantState = value; }, get chatDurabilityUnknownText() { return chatDurabilityUnknownText; }, get actionLeaseHeartbeat() { return actionLeaseHeartbeat; }, set actionLeaseHeartbeat(value) { actionLeaseHeartbeat = value; }, releaseChatSession, commitRecordedTerminal, persistChatTakeoverExecution, capabilitySelection, addMessageIdempotent, refreshTerminalPayloadTaskRelation, scheduleChatSummary, persistChatLearning }); return; }

      let responseText = '';
      let completionGuard: LLMResult['completionGuard'];
      let llmWasCalled = false;
      const allToolRecords = requestToolRecords;
      // Keep the same token-budgeted conversation that drove the normal turn
      // available to the one-shot execution recovery. Falling back to only the
      // latest task makes the recovery model forget constraints and prior user
      // corrections precisely when it needs them most.
      let normalTurnMessages: NormalizedMessage[] = [];
      // ── Model-owned natural-language dispatch ──
      // Natural-language chat has no deterministic quick-command path. Surface
      // recognition and legacy quick matches are advisory inputs to the shared
      // model/tool loop; structured UI events use their dedicated handlers.
      abortController.signal.throwIfAborted();
      turnAuthorization.assertCurrent();
      // ── Sentiment analysis: detect emotional charge in user input ──
      const sentiment = extractSentiment(text);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        console.log('[ChatHandler] sentiment:', sentiment);
      }

      // Auto-select model: flash for simple chat, pro for complex tasks
      console.log('[ChatHandler] Using exact configured reasoning model:', activeProvider, '/', activeModel);

      const deferCompletionStream = shouldDeferModelOutputUntilFinalized({
        taskText: executionTaskText,
        allowToolUse: toolSessionActive,
        flow: turnFlow,
      });
      const chatTextGate = createPreFinalizationTextGate();
      await executeChatModelTurn({ toolContext, get responseText() { return responseText; }, set responseText(value) { responseText = value; }, conversationId, requestId, eventSource, get history() { return history; }, get activeProvider() { return activeProvider; }, set activeProvider(value) { activeProvider = value; }, get activeModel() { return activeModel; }, set activeModel(value) { activeModel = value; }, uid, visionIntent, effectiveOperationMode, get effectiveSystemPrompt() { return effectiveSystemPrompt; }, text, acceptedUserMessageId, toolSessionActive, get normalTurnMessages() { return normalTurnMessages; }, set normalTurnMessages(value) { normalTurnMessages = value; }, markTurnTiming, deferCompletionStream, chatTextGate, emitAgent, get personality() { return personality; }, resolvedDomain, resolvedOrgId, abortController, reasoningRoutePolicy, get llmGetters() { return llmGetters; }, isChatCancelled, turnAuthorization, get completionGuard() { return completionGuard; }, set completionGuard(value) { completionGuard = value; }, get llmWasCalled() { return llmWasCalled; }, set llmWasCalled(value) { llmWasCalled = value; }, interactionId, get socket() { return socket; }, modelCapabilityPolicy, runAuthorizedTools, allToolRecords, formatToolResultForUi, formatMediaArtifactReceiptForUi, actionTaskExecution, emitToolLifecycle, priorTaskRecords, get runtimeOwnedDeterministicRecoveryCall() { return runtimeOwnedDeterministicRecoveryCall; }, set runtimeOwnedDeterministicRecoveryCall(value) { runtimeOwnedDeterministicRecoveryCall = value; }, desktopExecutionTracker, requestToolConfirmation });

      chatTextGate.finish();
      const finalizedDesktopRecords = withDesktopExecutionReceipt(allToolRecords, desktopExecutionTracker);
      if (finalizedDesktopRecords.length > allToolRecords.length) {
        allToolRecords.push(...finalizedDesktopRecords.slice(allToolRecords.length));
      }
      const verifiedClientMode = getVerifiedClientModeChange(allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(uid, verifiedClientMode);
      const finalTaskRecords = taskAwareRecords(allToolRecords);
      await completeChatTurn({ toolContext, get pendingConfirmationCreatedThisTurn() { return pendingConfirmationCreatedThisTurn; }, set pendingConfirmationCreatedThisTurn(value) { pendingConfirmationCreatedThisTurn = value; }, get executionTaskText() { return executionTaskText; }, get responseText() { return responseText; }, set responseText(value) { responseText = value; }, get completionGuard() { return completionGuard; }, set completionGuard(value) { completionGuard = value; }, finalTaskRecords, get turnFlow() { return turnFlow; }, durableTaskId, requestId, taskAwareRecords, allToolRecords, desktopRelay, toolSessionActive, get correctionRequiresFreshConfirmation() { return correctionRequiresFreshConfirmation; }, set correctionRequiresFreshConfirmation(value) { correctionRequiresFreshConfirmation = value; }, abortController, isChatCancelled, get llmWasCalled() { return llmWasCalled; }, set llmWasCalled(value) { llmWasCalled = value; }, runAuthorizedTools, get normalTurnMessages() { return normalTurnMessages; }, set normalTurnMessages(value) { normalTurnMessages = value; }, get activeProvider() { return activeProvider; }, set activeProvider(value) { activeProvider = value; }, get activeModel() { return activeModel; }, set activeModel(value) { activeModel = value; }, uid, resolvedDomain, resolvedOrgId, reasoningRoutePolicy, rememberRequestToolRecord, formatToolResultForUi, formatMediaArtifactReceiptForUi, emitAgent, modelCapabilityPolicy, get personality() { return personality; }, actionTaskExecution, get llmGetters() { return llmGetters; }, emitToolLifecycle, visibleUserText, get executionPipeline() { return executionPipeline; }, get runtimeOwnedDeterministicRecoveryCall() { return runtimeOwnedDeterministicRecoveryCall; }, set runtimeOwnedDeterministicRecoveryCall(value) { runtimeOwnedDeterministicRecoveryCall = value; }, desktopExecutionTracker, requestToolConfirmation, interactionId, priorTaskRecords, conversationId, get completionTaskText() { return completionTaskText; }, normalizeAgentPayload, get pendingConfirmationAssistantState() { return pendingConfirmationAssistantState; }, set pendingConfirmationAssistantState(value) { pendingConfirmationAssistantState = value; }, get chatDurabilityUnknownText() { return chatDurabilityUnknownText; }, get actionLeaseHeartbeat() { return actionLeaseHeartbeat; }, set actionLeaseHeartbeat(value) { actionLeaseHeartbeat = value; }, releaseChatSession, commitRecordedTerminal, persistChatTakeoverExecution, capabilitySelection, conversationAgentId, addMessageIdempotent, eventSource, refreshTerminalPayloadTaskRelation, turnAuthorization, text, scheduleChatSummary, isMemoryAvatar, persistChatLearning, allowAdaptiveLearning, get emotionalState() { return emotionalState; }, sentiment, get isNovel() { return isNovel; }, get himState() { return himState; }, get emotionKey() { return emotionKey; }, get socket() { return socket; } });

    } catch (error: any) {
      if (isChatCancelled() || error?.name === 'AbortError') {
        const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
        const cancelledRecords = collectRequestTerminalRecords();
        const cancelledFeedback = requestTaskId ? buildForegroundTaskCompletionFeedback({
          taskId: requestTaskId,
          taskLabel: visibleUserText,
          toolRecords: cancelledRecords,
          status: 'cancelled',
          reason: 'Cancelled by the user; completed steps remain recorded.',
        }) : undefined;
        await commitDeterministicTerminal({
          payload: {
            text: cancelledText,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: 'cancelled',
            completionFeedback: cancelledFeedback,
          },
          persistAssistantMessage: () => addMessageIdempotent({
            conversationId: selectedConversationId,
            role: 'assistant',
            content: cancelledText,
            cognitiveIntent: 'task_cancelled',
            llmWasCalled: true,
            toolCalls: cancelledRecords.length ? cancelledRecords : undefined,
            completionFeedback: cancelledFeedback,
            ...(requestTaskId ? { terminalTaskDisposition: {
              outcome: 'cancelled' as const,
              taskId: requestTaskId,
              requestId,
              reason: 'Cancelled by the user; completed steps remain recorded.',
            } } : {}),
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: selectedConversationId,
            agentId: conversationAgentId,
            source: eventSource,
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
      const failedRecords = collectRequestTerminalRecords();
      const failedFeedback = requestTaskId ? buildForegroundTaskCompletionFeedback({
        taskId: requestTaskId,
        taskLabel: visibleUserText,
        toolRecords: failedRecords,
        blocked: true,
        reason: String(publicError.reason || 'chat_execution_failed'),
      }) : undefined;
      await commitDeterministicTerminal({
        payload: {
          text: failureText,
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: String(publicError.reason || 'chat_execution_failed'),
          completionFeedback: failedFeedback,
        },
        persistAssistantMessage: () => addMessageIdempotent({
          conversationId: selectedConversationId,
          role: 'assistant',
          content: failureText,
          cognitiveIntent: String(publicError.code || 'CHAT_EXECUTION_FAILED').toLowerCase(),
          llmWasCalled: false,
          toolCalls: failedRecords.length ? failedRecords : undefined,
          completionFeedback: failedFeedback,
          ...(requestTaskId ? { terminalTaskDisposition: {
            outcome: 'blocked' as const,
            taskId: requestTaskId,
            requestId,
            reason: String(publicError.reason || 'chat_execution_failed'),
          } } : {}),
        }),
        publishAfter: () => emitConversationUpdated({
          conversationId: selectedConversationId,
          agentId: conversationAgentId,
          source: eventSource,
        }),
        errorContext: 'Unhandled chat failure terminal',
      });
    } finally {
      await releaseChatSession();
    }
  });
}
