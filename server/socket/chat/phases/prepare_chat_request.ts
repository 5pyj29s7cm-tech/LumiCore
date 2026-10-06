import { createChatMessageWriter } from "../message_writer";
import { normalizeIncomingAttachments, buildChatAttachmentContext, buildStoredAttachmentSummary, shouldAllowLocalFileWriteForTurn } from "../attachments";
import { buildClientSurfaceContinuationBridge } from "../client_surface";
import { runLumiTurn, type ToolSessionOptions } from "../../../llm/lumi_turn";
import type { ProviderGetters as SharedProviderGetters } from "../../../llm/provider_getters";
import type { Server, Socket } from "socket.io";
import type { ToolExecutionRecord } from "../../../tools/types";
import { buildMediaArtifactReceipt, type MediaArtifactReceipt } from "../../media_artifact_receipt";
import { captureChatAuthorization } from "../../chat_authorization";
import { captureConversationAuthorization, combineRequestAuthorizations } from "../../../conversation/lifecycle";
import { normalizeStructuredMediaRequest, structuredMediaRoutingEnvelope } from "../../../../shared/media_generation";
import { createModelTurnState } from "../../../llm/model_turn_state";
import { shouldPersistPostTurnLearningSource } from "../../../cognition/post_turn_learning";
import type { getPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { ensurePendingConfirmationPersistenceInitialized } from "../../../tools/pending_confirmation_repository";
import { getMemoryAvatar } from "../../../memory_avatar/store";
import { captureMemoryAvatarAuthorization } from "../../../memory_avatar/lifecycle";
import { getMessageByRequestId, getConversationForScope, getOrCreateActiveConversation } from "../../../conversation/manager";
import { buildSocketNativeRequestBinding } from "../../native_request_binding";
import type { createConversationReceiptObserver } from "../../../conversation/execution_receipt_archive";
import { buildSocketToolSecurityContext, resolveAuthorizedSocketScope } from "../../scope";
import { buildNaturalReplyStyleOverlay, chatDurabilityUnknownText } from './shared';

export async function prepareChatRequest(socket: Socket, llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>, sensoryFn: (uid: string) => any, userIdFn: (s: Socket) => string, io: Server, data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown }, ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void) {

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
      return runLumiTurn({ ...input, getters: llmGetters, config: { ...input.config, modelTurnState, conversationId: selectedConversationId || input.config.conversationId, workflowSource: eventSource } });
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
