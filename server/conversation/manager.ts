import { getMessageByRequestId } from './manager/request_identity';
export { getMessageByRequestId } from './manager/request_identity';
import { acceptConversationActionTurn } from "./action_turn_ledger";
import { normalizeCompletionFeedbackForPersistence } from "./completion_feedback";
import { readDatabaseTables, commitDatabaseTables } from "../../db_layer";
import type { Conversation, MessageRecord } from "./manager/contracts";
import { archiveBoundConversationActionReceipts } from "./ledger/receipt_archive";
import type { ConversationActionTerminalDisposition } from "./ledger/contracts";
import { normalizeNativeRequestBinding } from "../devices/native_identity";
import { normalizeVoiceTurnProvenance } from "../socket/voice_provenance";
import { partitionConversationReceiptsByOwnership } from "./receipt_ownership";
import { finalizeConversationActionRequestInDb, finalizeManagerActionTurnFromAssistant } from "./action_execution_runtime";
import { conversationMatchesScope } from "./conversation_lifecycle";
import { normalizeToolCalls, updateConversationForMessage } from './manager/message_updates';
import { finalizePersistedAssistantActionTurnInDb } from './manager/turn_binding';

export { type Conversation, type MessageRecord, type ConversationTurnOptions, type ConversationTurnResult } from "./manager/contracts";
export { compactRecordForPrompt, getMessages, getMessagesByTokenBudget, getMessagesThroughExternalMessage } from "./manager/message_history";
export { type DurableForegroundReleaseGateSnapshot, type DurableForegroundReleaseGate, type CreateDurableForegroundReleaseGateInput, createDurableForegroundReleaseGate } from "./manager/foreground_release_gate";
export { type AutoSummaryCheckResult, checkAutoSummary, beginConversationSummary, cancelConversationSummary, setConversationSummary, getConversationSummary, trackTopic, extractTopics, getTopicContext } from "./summary_state";
export { CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS, CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS, type ConversationTerminalPersistenceUnknownProjection, type ConversationTerminalDurabilityStage, runWithConversationTerminalDurabilityStage, renewConversationActionExecutionLease, type ConversationActionExecutionLeaseLoss, type ConversationActionExecutionHeartbeat, startConversationActionExecutionHeartbeat } from "./action_execution_runtime";
export { finalizeForegroundRequest, type SupersedeConversationActionExecutionRequestInput, type SupersedeConversationActionExecutionRequestResult, convergeConversationActionRequestLease, convergeForegroundRequestBeforeRelease, convergeConversationActionRequestLeaseDurably, finalizeForegroundRequestDurably } from "./foreground_finalization";
export { type ConvergeConversationActionRequestLeaseInput, type ConversationActionRequestLeaseEvidence, type ConvergeConversationActionRequestLeaseResult, type ForegroundRequestFinalizationOutcome, type FinalizeForegroundRequestInput, type ForegroundRequestFinalizationEvidence, type FinalizeForegroundRequestResult, type ForegroundRequestDurabilityDependencies, type ForegroundRequestIdentity, type ForegroundRequestReleaseInput, type ForegroundRequestReleaseResult } from "./foreground_request_types";
export { getConversationFocusThreads, updateConversationActionFocus, getConversationActionStatus, getConversationForScope, getOrCreateActiveConversation, startNewConversation, startIsolatedConversation, type DeletedConversationData, deleteConversationData, shouldRolloverConversationForTurn, getOrCreateConversationForTurn, closeConversation, getActiveConversation, setConversationMode, getUserConversations, activateConversation, type BindConversationActionExecutionTurnInput, type BoundConversationActionExecutionTurn, getMessagesForAgent } from "./conversation_lifecycle";
export { commitConversationTerminalDurabilityStage } from './manager/terminal_durability';
export { quarantineConversationTerminalDurabilityStage } from './manager/terminal_durability';
export type { RejectedConversationActionExecution } from './manager/execution_preparation';
export type { ConversationActionExecutionPreparation } from './manager/execution_preparation';
export { bindConversationActionExecutionTurn } from './manager/turn_binding';
export { prepareConversationActionExecution } from './manager/execution_preparation';
export { persistConversationExecutionPlan } from './manager/execution_preparation';
export { cancelConversationActionExecution } from './manager/execution_control';
export { completeConversationActionFromUserObservation } from './manager/execution_control';
export { settleConversationActionExecutionRequest } from './manager/execution_control';
export { supersedeConversationActionExecutionRequest } from './manager/execution_control';
export { recoverOrphanedConversationActionExecutions } from './manager/recovery';
export { setConversationActionExecutionStatus } from './manager/execution_control';

export function addMessage(msg: {
  userId: string;
  agentId?: string;
  conversationId?: string;
  role: string;
  content: string;
  response?: string;
  personality?: string;
  mode?: string;
  toolCalls?: any;
  domain?: string;
  orgId?: string;
  source?: string;
  channel?: string;
  cognitiveIntent?: string;
  llmWasCalled?: boolean;
  externalMessageId?: string;
  routeSequence?: number;
  receivedAt?: string;
  timestamp?: string;
  /** Immutable foreground request identity used to reject late replies. */
  requestId?: string;
  /** Proof-bound native request provenance; absent on web/remote/harness turns. */
  nativeDeviceId?: string;
  executionSessionId?: string;
  nativeClientIdentitySha256?: string;
  audioInputKind?: 'physical_microphone' | 'synthetic_accepted_transcript';
  syntheticAudio?: boolean;
  captureSessionId?: string;
  sttReceiptId?: string;
  contextChainId?: string;
  previousRequestId?: string;
  /** Explicit structured intent emitted by the model/runtime for this reply. */
  taskIntent?: 'task' | 'conversation';
  /** User-visible structured outcome; normalized before it reaches memory/SQLite. */
  completionFeedback?: unknown;
  /** @internal Request/task-fenced semantic result from a foreground transport. */
  terminalTaskDisposition?: ConversationActionTerminalDisposition;
  /**
   * Persist the accepted instruction before routing/tool selection finishes,
   * while leaving creation of the real task state to the foreground executor.
   */
  deferActionPreparation?: boolean;
  /**
   * Side-channel progress/chat records must not replace the pending action
   * pointer owned by the foreground task.
   */
  skipActionContinuation?: boolean;
}): string {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  // Conversation IDs are parent identities, not optional labels. A delayed
  // model/voice/tool reply must never recreate content after that parent was
  // deleted. Unbound legacy interactions remain supported without an ID.
  if (msg.conversationId && !(db.conversations || []).some((conversation: Conversation) => (
    conversation.id === msg.conversationId
    && conversation.userId === msg.userId
    && (!msg.agentId || conversation.agentId === msg.agentId)
    && conversationMatchesScope(conversation, msg.domain, msg.orgId)
  ))) return '';
  const id = 'msg_' + crypto.randomUUID();
  const now = msg.timestamp || new Date().toISOString();
  const normalizedToolCalls = normalizeToolCalls(msg.toolCalls);
  const completionFeedback = normalizeCompletionFeedbackForPersistence(msg.completionFeedback);
  const nativeRequestBinding = normalizeNativeRequestBinding(msg);
  const voiceTurnProvenance = normalizeVoiceTurnProvenance(msg);

  const interaction: any = {
    id,
    userId: msg.userId,
    agentId: msg.agentId || '',
    conversationId: msg.conversationId || '',
    module: msg.personality || '',
    message: msg.content,
    response: msg.response || '',
    role: msg.role,
    personality: msg.personality || '',
    mode: msg.mode || '',
    toolCalls: normalizedToolCalls,
    domain: msg.domain || 'personal',
    orgId: msg.orgId || '',
    source: msg.source || '',
    channel: msg.channel || '',
    cognitiveIntent: msg.cognitiveIntent || '',
    llmWasCalled: msg.llmWasCalled === true,
    externalMessageId: msg.externalMessageId || '',
    routeSequence: Number.isFinite(msg.routeSequence) ? msg.routeSequence : undefined,
    receivedAt: msg.receivedAt || '',
    requestId: msg.requestId || '',
    nativeDeviceId: nativeRequestBinding?.nativeDeviceId || '',
    executionSessionId: nativeRequestBinding?.executionSessionId || '',
    nativeClientIdentitySha256: nativeRequestBinding?.nativeClientIdentitySha256 || '',
    audioInputKind: voiceTurnProvenance?.audioInputKind || '',
    syntheticAudio: voiceTurnProvenance?.syntheticAudio,
    captureSessionId: voiceTurnProvenance?.captureSessionId || '',
    sttReceiptId: voiceTurnProvenance?.sttReceiptId || '',
    contextChainId: voiceTurnProvenance?.contextChainId || '',
    previousRequestId: voiceTurnProvenance?.previousRequestId || '',
    taskIntent: msg.taskIntent || '',
    ...(completionFeedback ? { completionFeedback } : {}),
    timestamp: now,
  };

  if (!db.interactions) db.interactions = [];
  db.interactions.push(interaction);

  // The transcript row and accepted turn enter the same in-memory persistence
  // snapshot. Callers must flush this snapshot before any side-effecting tool
  // execution; the ledger then becomes the sole durable request authority.
  if (msg.role === 'user' && msg.conversationId && msg.requestId) {
    const accepted = acceptConversationActionTurn({
      conversationId: msg.conversationId,
      userId: msg.userId,
      requestId: msg.requestId,
      userMessageId: id,
      domain: msg.domain,
      orgId: msg.orgId,
      channel: msg.channel,
      source: msg.source,
      now,
    });
    if (!accepted.accepted) {
      const insertedIndex = db.interactions.findIndex((row: any) => row.id === id);
      if (insertedIndex >= 0) db.interactions.splice(insertedIndex, 1);
      return accepted.turn.userMessageId;
    }
  }
  const terminalArchiveId = updateConversationForMessage(db, msg, id, now, normalizedToolCalls);
  if (terminalArchiveId !== undefined) return terminalArchiveId;


  if (
    msg.role === 'assistant'
    && msg.mode !== 'proactive'
    && msg.conversationId
    && msg.requestId
  ) {
    finalizePersistedAssistantActionTurnInDb(db, {
      conversationId: msg.conversationId,
      userId: msg.userId,
      requestId: msg.requestId,
      assistantMessageId: id,
      assistantText: msg.content,
      now,
    });
  }

  commitDatabaseTables(db);
  return id;
}

export type IdempotentConversationMessage = Parameters<typeof addMessage>[0] & {
  conversationId: string;
  requestId: string;
};

/**
 * Find the durable transcript row for one accepted socket request. Native chat
 * mirrors the request id into externalMessageId because that column survives a
 * database restart; older in-memory rows can still be found through requestId.
 */


/**
 * Persist one role exactly once for a received socket request. The monotonic
 * routeSequence is used as a durable receive/commit order for native chat;
 * user rows are written when accepted, while assistant rows take their order
 * only when the terminal result is committed.
 */
export function addMessageIdempotent(msg: IdempotentConversationMessage): string {
  const requestId = String(msg.requestId || '').trim();
  if (!requestId) return addMessage(msg);
  const existing = getMessageByRequestId({
    userId: msg.userId,
    agentId: msg.agentId,
    conversationId: msg.conversationId,
    requestId,
    role: msg.role,
    source: msg.source,
    channel: msg.channel,
  });
  if (existing) {
    if (msg.role === 'user') {
      acceptConversationActionTurn({
        conversationId: msg.conversationId,
        userId: msg.userId,
        requestId,
        userMessageId: existing.id,
        domain: msg.domain,
        orgId: msg.orgId,
        channel: msg.channel,
        source: msg.source,
        now: existing.receivedAt || existing.timestamp,
      });
    } else if (msg.role === 'assistant') {
      const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
      const conversation = (db.conversations || []).find((item: Conversation) => (
        item.id === msg.conversationId && item.userId === msg.userId
      ));
      if (conversation) {
        const replayRecords = normalizeToolCalls(msg.toolCalls) || [];
        const receiptOwnership = partitionConversationReceiptsByOwnership(replayRecords, {
          taskId: conversation.actionContinuationState?.taskId,
          requestId: conversation.actionContinuationState?.activeRequestId
            || conversation.pendingActionContinuation?.requestId,
        });
        if (receiptOwnership.staleRecords.length > 0) {
          // The transcript row is immutable and already user-visible. A late
          // transport replay may contribute only archive-bound receipts; it
          // must never append or rewrite the assistant projection.
          archiveBoundConversationActionReceipts(db, {
            conversationId: conversation.id,
            userId: conversation.userId,
            records: receiptOwnership.staleRecords,
            turnId: requestId,
          });
        }
        finalizeConversationActionRequestInDb(db, conversation, requestId, {
          assistantState: existing.message,
          fallbackBlocker: 'The terminal assistant record was replayed without a verified task outcome.',
        });
      }
      finalizeManagerActionTurnFromAssistant({
        conversationId: msg.conversationId,
        userId: msg.userId,
        requestId,
        assistantMessageId: existing.id,
        reason: 'idempotent assistant transcript replay',
        now: existing.receivedAt || existing.timestamp,
      });
      commitDatabaseTables(db);
    }
    return existing.id;
  }

  const rows = (readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]).interactions || []).filter((item: any) => (
    item.conversationId === msg.conversationId
  ));
  const nextRouteSequence = rows.reduce((largest: number, item: any) => (
    Number.isFinite(Number(item.routeSequence))
      ? Math.max(largest, Math.floor(Number(item.routeSequence)))
      : largest
  ), 0) + 1;

  return addMessage({
    ...msg,
    requestId,
    externalMessageId: msg.externalMessageId || requestId,
    routeSequence: Number.isFinite(msg.routeSequence) ? msg.routeSequence : nextRouteSequence,
  });
}

/**
 * Replace only the user-visible terminal projection of an already accepted
 * assistant turn. This is used when cancellation or a failed durability fence
 * supersedes a response that was staged in memory before the strict flush.
 */
export function updateAssistantMessageTerminalPresentation(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  content: string;
  completionFeedback: unknown;
  source?: string;
  channel?: string;
}): boolean {
  const completionFeedback = normalizeCompletionFeedbackForPersistence(input.completionFeedback);
  if (!completionFeedback) return false;
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const requestId = String(input.requestId || '').trim();
  const row = (db.interactions || []).find((item: any) => (
    item.userId === input.userId
    && item.conversationId === input.conversationId
    && item.role === 'assistant'
    && (!input.source || item.source === input.source)
    && (!input.channel || item.channel === input.channel)
    && (
      String(item.requestId || '') === requestId
      || String(item.externalMessageId || '') === requestId
    )
  ));
  if (!row) return false;
  const content = String(input.content || '').replace(/\0/g, '').trim().slice(0, 8_000);
  row.message = content;
  row.content = content;
  row.response = '';
  row.completionFeedback = completionFeedback;
  commitDatabaseTables(db);
  return true;
}
