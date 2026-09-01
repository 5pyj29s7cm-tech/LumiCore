/**
 * agent:task socket handler — multi-turn tool-augmented AI pipeline
 */
import { Server, Socket } from "socket.io";
import { flushDBOrThrow, readDB, writeDB } from "../../db_layer";
import { recordTokenUsage } from "../llm/token_tracker";
import { NormalizedMessage } from "../llm/providers";
import { resolveModelRequestInputBudget } from "../llm/request_context_budget";
import { buildConfirmedStepContinuationMessages, runWithTools, LLMUsageRecord } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { executeToolCall } from "../tools/execution_engine";
import { queryMemories, addMemory, addReminder, extractMemories, CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, vectorMemoryBias } from "../personality/state";
import { personalityRegistry } from "../personality";
import { canOutputHolographic, textToHolographicOutput } from "../output/holographic";
import {
  getConversationForScope,
  getOrCreateActiveConversation,
  getMessages,
  getMessagesByTokenBudget,
  addMessageIdempotent,
  extractTopics,
  trackTopic,
  getTopicContext,
  getConversationSummary,
  getConversationActionStatus,
  prepareConversationActionExecution,
  persistConversationExecutionPlan,
  cancelConversationActionExecution,
  createDurableForegroundReleaseGate,
  setConversationActionExecutionStatus,
  startConversationActionExecutionHeartbeat,
  updateConversationActionFocus,
  convergeConversationActionRequestLease,
  convergeConversationActionRequestLeaseDurably,
  finalizeForegroundRequestDurably,
  type ConvergeConversationActionRequestLeaseResult,
  type FinalizeForegroundRequestResult,
  type ForegroundRequestDurabilityDependencies,
} from "../conversation/manager";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext, CognitiveResult } from "../cognition";
import { loadHIMState, saveHIMState, updateEmotionalStateWithHIM } from "../personality/state";
import { formatClientSelfPromptForTurn } from "../client/self_model";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { bindCapabilityExecutionPlanTask } from "../cognition/capability_execution_plan";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { shouldBlockForDesktopControlPause } from '../cognition/desktop_control_pause';
import {
  recoverBlockedExecutionOnce,
  sanitizeExecutionResponseForDelivery,
  sanitizeExecutionNotificationForDelivery,
} from "../cognition/execution_guard_recovery";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
} from "../cognition/response_delivery";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { buildTextReplyStyleOverlay } from '../cognition/reply_style';
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { canAutoApproveAction } from "../tools/action_constitution";
import {
  buildTransportNeutralConfirmationScope,
  confirmationArgumentsMatch,
  consumePendingConfirmationDurably,
  formatPendingConfirmationPrompt,
  pendingConfirmationMatchesExactProposal,
  recordPendingConfirmationDurably,
} from "../tools/pending_confirmation";
import { ensurePendingConfirmationPersistenceInitialized } from '../tools/pending_confirmation_repository';
import { buildPendingAssistantOfferContextFromTranscript } from '../cognition/pending_assistant_offer';
import {
  admitAcceptedUserTurnDurably,
  resolveAcceptedTurnConfirmation,
  runAfterAcceptedUserTurnAdmission,
} from './action_turn_durability';
import type { ToolExecutionRecord } from "../tools/types";
import {
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  formatConversationActionTaskStatus,
} from "../cognition/action_continuation";
import { buildDurableTaskDeterministicToolRecoveryCall } from '../cognition/deterministic_tool_recovery';
import {
  coalesceToolExecutionRecords,
  confirmedStepNeedsContinuation,
  taskReceiptsToRecords,
  toolRecordSucceeded,
} from "../cognition/task_execution_ledger";
import { createDesktopRelay } from "./desktop_relay";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import {
  buildSocketToolSecurityContext,
  resolveSocketScope,
  scopedEmotionalStateKey,
} from "./scope";
import {
  CN_TASK_EXECUTION_MESSAGES,
  CN_VOICE_WORK_MESSAGES,
} from "../regions/packs/cn/voice_fast_path_messages";
import { formatDesktopControlPausePresentation } from '../regions/packs/cn/desktop_control_messages';
import { normalizeVoiceHistory as normalizeTaskHistory } from './voice_history';
import {
  beginChatExecutionDurably,
  beginQueuedChatExecution,
  beginChatSidecarExecution,
  getChatExecution,
  getChatSidecarCancellationTarget,
  markChatExecutionCancelling,
  persistChatSidecarCancellationIntent,
  recordChatExecutionEvent,
  recordChatExecutionPersistenceUnknownDurably,
  recordChatExecutionTerminalEventDurably,
  waitForChatSidecarCancellationIntent,
  type ChatExecutionScope,
} from "./chat_execution_registry";
import { commitChatTerminalBoundary } from "./chat_terminal_boundary";
import {
  sanitizeChatAgentErrorPayload,
} from "./chat_public_error";
import { classifyActiveTaskMessage } from "../cognition/task_concurrency";
import { SerialExecutionQueue } from "../cognition/serial_execution_queue";
import {
  executionBoundaryPromptOverlay,
  restrictSystemPromptForExecutionBoundary,
  restrictToolPolicyForExecutionBoundary,
  restrictVisibleToolNamesForExecutionBoundary,
  restrictVisibleToolRouteForExecutionBoundary,
} from "../tools/remote_policy";

const taskExecutionQueue = new SerialExecutionQueue();

export interface TaskForegroundRequestIdentity {
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly expectedTaskId?: string;
}

export interface TaskForegroundRequestReleaseResult {
  convergence: ConvergeConversationActionRequestLeaseResult;
  finalization: FinalizeForegroundRequestResult | null;
  converged: boolean;
}

/** Converge durable Task ownership before desktop/queue resources leave. */
export async function convergeTaskForegroundRequestBeforeRelease(input: {
  readonly identity: TaskForegroundRequestIdentity;
  readonly aborted: boolean;
  readonly reason?: string;
  readonly assistantState?: string;
}, dependencies: ForegroundRequestDurabilityDependencies = {}): Promise<TaskForegroundRequestReleaseResult> {
  let convergence = convergeConversationActionRequestLease({
    ...input.identity,
    deferLocalOwnerClear: true,
  });
  if (convergence.converged) {
    convergence = await convergeConversationActionRequestLeaseDurably(input.identity, dependencies);
    return { convergence, finalization: null, converged: true };
  }
  const finalization = await finalizeForegroundRequestDurably({
    ...input.identity,
    outcome: input.aborted ? 'cancelled' : 'blocked',
    assistantMessageId: convergence.assistantMessageId || undefined,
    reason: input.reason || (input.aborted
      ? 'Task foreground request was aborted before release.'
      : 'Task foreground executor exited without a fully converged terminal.'),
    assistantState: input.assistantState,
  }, dependencies);
  return {
    convergence,
    finalization,
    converged: finalization.converged,
  };
}

function taskExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}

function taskExecutionKey(scope: ChatExecutionScope): string {
  return `${scope.userId}:${scope.domain}:${scope.orgId || ''}:${scope.source}`;
}

export function taskDurabilityUnknownText(): string {
  return 'Lumi could not durably confirm this task result. Refresh the task state before retrying.';
}

export function registerTaskHandler(
  socket: Socket,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI: () => any;
    getAnthropic: () => any;
    getQwen: () => any;
    getOllama?: () => any;
    getLmStudio?: () => any;
    getArk?: () => any;
    getXiaomi?: () => any;
    getKimi?: () => any;
    getGlm?: () => any;
    getRelay?: () => any;
  },
  sensoryFn: (uid: string) => any,
  userIdFn: (s: Socket) => string,
  io: Server,
) {
  socket.on('agent:task_cancel', (
    data: { requestId?: string; domain?: 'personal' | 'work'; orgId?: string | null } = {},
    ack?: (payload: { ok: boolean; requestId?: string; status?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const resolvedScope = resolveSocketScope(socket, uid, data);
    const executionScope: ChatExecutionScope = {
      userId: uid,
      domain: resolvedScope.domain,
      orgId: resolvedScope.orgId,
      source: 'task',
    };
    const snapshot = getChatExecution(executionScope, data.requestId);
    if (!snapshot || snapshot.terminal) {
      try {
        ack?.({
          ok: Boolean(snapshot?.terminal),
          requestId: snapshot?.requestId || data.requestId,
          status: snapshot?.status,
          error: snapshot ? undefined : 'Active task not found',
        });
      } catch {}
      if (snapshot?.terminalEvent) {
        socket.emit(snapshot.terminalEvent.event, {
          ...snapshot.terminalEvent.payload,
          replayed: true,
        });
      }
      return;
    }
    const active = taskExecutionQueue.getByRequestId(
      taskExecutionKey(executionScope),
      snapshot.requestId,
    );
    if (!active || active.requestId !== snapshot.requestId) {
      try { ack?.({ ok: false, requestId: snapshot.requestId, error: 'Task cancellation handle is unavailable' }); } catch {}
      return;
    }
    markChatExecutionCancelling(executionScope, snapshot.requestId);
    io.to(taskExecutionRoom(executionScope)).emit('agent:status', {
      status: 'cancelling',
      source: 'task',
      requestId: snapshot.requestId,
    });
    active.cancel();
    // The cancellation signal is exact because it targets the serial request
    // lease. Do not guess an active conversation here: the owning executor
    // settles its immutable action/task identity before releasing resources.
    try { ack?.({ ok: true, requestId: snapshot.requestId, status: 'cancelling' }); } catch {}
  });

  socket.on("agent:task", async (
    data: { text: string; history?: any[]; personalityId?: string; conversationId?: string; domain?: 'personal' | 'work'; orgId?: string; requestId?: string; controlTargetRequestId?: string },
    ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const taskScope = resolveSocketScope(socket, uid, data);
    const toolSecurityContext = buildSocketToolSecurityContext(socket, taskScope);
    const requestId = typeof data.requestId === 'string' && data.requestId.trim()
      ? data.requestId.trim().slice(0, 120)
      : `task_${crypto.randomUUID()}`;
    const executionScope: ChatExecutionScope = {
      userId: uid,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      source: 'task',
    };
    const executionRoom = taskExecutionRoom(executionScope);
    const executionKey = taskExecutionKey(executionScope);
    const normalizeAgentPayload = (
      event: string,
      payload: Record<string, any> = {},
    ): Record<string, any> => {
      const publicPayload: Record<string, any> = event === 'agent:response'
        ? sanitizeExecutionResponseForDelivery(payload, { task: data.text })
        : event === 'agent:notification'
          ? sanitizeExecutionNotificationForDelivery(payload, { task: data.text })
        : event === 'agent:error'
          ? sanitizeChatAgentErrorPayload(payload)
          : payload;
      return { ...publicPayload, source: publicPayload.source || 'task', requestId };
    };
    const publishRecordedAgent = (event: string, normalizedPayload: Record<string, any>) => {
      io.to(executionRoom).emit(event, normalizedPayload);
    };
    let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = normalizeAgentPayload(event, payload);
      if (
        event === 'agent:error'
        || (event === 'agent:response' && normalizedPayload.finalized === true)
      ) {
        console.error('[TaskHandler] Rejected a terminal event outside the strict durability boundary.');
        return false;
      }
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
      publishRecordedAgent(event, normalizedPayload);
      return true;
    };
    const emitTask = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = { ...payload, source: payload.source || 'task', requestId };
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return;
      io.to(executionRoom).emit(event, normalizedPayload);
    };
    const commitTaskTerminal = async (input: {
      event?: 'agent:response' | 'agent:error';
      payload: Record<string, any>;
      persistTerminalState?: () => any;
      persistAssistantMessage?: () => void;
      publishAfter?: (terminalState: any) => void;
      errorContext?: string;
    }): Promise<boolean> => {
      if (actionLeaseHeartbeat?.isLeaseLost()) {
        await actionLeaseHeartbeat.leaseLoss;
        return false;
      }
      const event = input.event || 'agent:response';
      const terminalPayload = normalizeAgentPayload(event, input.payload);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: taskDurabilityUnknownText(),
        agentName: String(input.payload.agentName || 'Lumi'),
        sidecar: input.payload.sidecar === true,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      const committed = await commitChatTerminalBoundary({
        persistTerminalState: input.persistTerminalState || (() => undefined),
        persistAssistantMessage: input.persistAssistantMessage || (() => undefined),
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
          executionScope,
          requestId,
          event,
          terminalPayload,
          unknownPayload,
        ),
        persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
          executionScope,
          requestId,
          unknownPayload,
        ),
        publishCommitted: terminalState => {
          input.publishAfter?.(terminalState);
          publishRecordedAgent(event, terminalPayload);
        },
        publishUnknown: () => {
          publishRecordedAgent('agent:response', unknownPayload);
        },
        persistenceUnknownProjection: {
          text: unknownPayload.text,
          completionFeedback: unknownPayload.completionFeedback,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => {
          console.error(`[TaskHandler] ${input.errorContext || 'Terminal'} persistence failed:`, error);
        },
      });
      if (committed) actionLeaseHeartbeat?.stop();
      return committed;
    };
    const persistEarlyTerminalTranscript = (
      assistantText: string,
      cognitiveIntent: string,
    ) => {
      const conversation = getOrCreateActiveConversation(
        uid,
        '',
        taskScope.domain,
        taskScope.orgId,
      );
      addMessageIdempotent({
        userId: uid,
        agentId: '',
        conversationId: conversation.id,
        role: 'user',
        content: data.text,
        personality: data.personalityId || 'lumi',
        mode: 'task',
        source: 'task',
        channel: 'task',
        cognitiveIntent,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        requestId,
        skipActionContinuation: true,
      });
      addMessageIdempotent({
        userId: uid,
        agentId: '',
        conversationId: conversation.id,
        role: 'assistant',
        content: assistantText,
        personality: data.personalityId || 'lumi',
        mode: 'task',
        source: 'task',
        channel: 'task',
        cognitiveIntent,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        requestId,
        skipActionContinuation: true,
      });
      return conversation;
    };

    let existingExecution = getChatExecution(executionScope, requestId);
    if (existingExecution) {
      if (existingExecution.sidecar === true && !existingExecution.terminal) {
        try {
          await waitForChatSidecarCancellationIntent(executionScope, requestId);
        } catch (error: any) {
          const publicError = sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' });
          await commitTaskTerminal({
            event: 'agent:error',
            payload: { code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED', sidecar: true },
            persistAssistantMessage: () => {
              persistEarlyTerminalTranscript(publicError.message, 'task_control_failed');
            },
            errorContext: 'Recovered control receipt failure terminal',
          });
          try { ack?.({ ok: false, requestId, error: publicError.message }); } catch {}
          return;
        }
        existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(executionScope, requestId);
        if (durableTarget && !taskExecutionQueue.getByRequestId(executionKey, durableTarget)) {
          const staleControlPayload = {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            source: 'task',
            requestId,
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          };
          const committed = await commitTaskTerminal({
            payload: staleControlPayload,
            persistAssistantMessage: () => {
              persistEarlyTerminalTranscript(
                staleControlPayload.text,
                'task_control_stale',
              );
            },
            errorContext: 'Recovered stale control terminal',
          });
          try {
            ack?.({
              ok: committed,
              requestId,
              receivedAt: existingExecution.createdAt,
              error: committed ? undefined : 'Terminal persistence outcome is unknown',
            });
          } catch {}
          return;
        }
      }
      try { ack?.({ ok: true, requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        socket.emit(existingExecution.terminalEvent.event, { ...existingExecution.terminalEvent.payload, replayed: true });
      } else {
        socket.emit('agent:status', {
          status: existingExecution.status === 'acknowledged' || existingExecution.status === 'planning'
            ? existingExecution.queued === true ? 'queued' : 'thinking'
            : existingExecution.status,
          source: 'task',
          requestId,
          resumed: true,
        });
      }
      return;
    }


    // A reconnected client can resend a request while it is still waiting
    // behind another task. Keep one executor for that request id.
    const queuedDuplicate = taskExecutionQueue.getByRequestId(executionKey, requestId);
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
        source: 'task',
        requestId,
        resumed: true,
      });
      return;
    }

    const runningTask = taskExecutionQueue.getCurrent(executionKey);
    const controlTargetRequestId = String(data.controlTargetRequestId || '').trim().slice(0, 120);
    const activeConversationForStatus = runningTask
      ? getOrCreateActiveConversation(uid, '', taskScope.domain, taskScope.orgId)
      : null;
    const activeMessageRelation = runningTask
      ? classifyActiveTaskMessage(
          data.text,
          activeConversationForStatus?.actionContinuationState,
        )
      : null;
    if (runningTask && activeMessageRelation === 'status') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      // Natural-language status turns have no client fence. Bind them to the
      // server-owned foreground lease; still reject an explicitly stale id.
      if (controlTargetRequestId && controlTargetRequestId !== runningTask.requestId) {
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        const staleText = CN_TASK_EXECUTION_MESSAGES.staleControl;
        await commitTaskTerminal({
          payload: {
            text: staleText,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          },
          persistAssistantMessage: () => {
            persistEarlyTerminalTranscript(staleText, 'task_control_stale');
          },
          errorContext: 'Stale status control terminal',
        });
        return;
      }
      const activeConversation = activeConversationForStatus!;
      const statusText = getConversationActionStatus(
        activeConversation.id,
        uid,
        data.text,
        activeConversation.actionContinuationState,
      ) || CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt;
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitTaskTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: 'task',
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: '',
        },
        persistAssistantMessage: () => {
          addMessageIdempotent({ userId: uid, agentId: '', conversationId: activeConversation.id, role: 'user', content: data.text, mode: 'task', source: 'task', channel: 'task', domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status', requestId, skipActionContinuation: true });
          addMessageIdempotent({ userId: uid, agentId: '', conversationId: activeConversation.id, role: 'assistant', content: statusText, mode: 'task', source: 'task', channel: 'task', domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status', requestId, skipActionContinuation: true });
        },
        publishAfter: () => {
          io.to(executionRoom).emit('chat:conversation_updated', {
            conversationId: activeConversation.id,
            agentId: '',
            source: 'task',
            requestId,
          });
        },
        errorContext: 'Task status terminal',
      });
      return;
    }

    const previous = taskExecutionQueue.getTail(executionKey);
    let acknowledged = false;
    if (previous && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      const cancellationTargetRequestId = controlTargetRequestId || previous.requestId;
      try {
        await persistChatSidecarCancellationIntent(executionScope, requestId, cancellationTargetRequestId);
      } catch (error: any) {
        await commitTaskTerminal({
          event: 'agent:error',
          payload: {
            code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED',
            sidecar: true,
          },
          persistAssistantMessage: () => {
            persistEarlyTerminalTranscript(
              sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' }).message,
              'task_control_failed',
            );
          },
          errorContext: 'Cancellation intent failure terminal',
        });
        try {
          ack?.({
            ok: false,
            requestId,
            error: sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' }).message,
          });
        } catch {}
        return;
      }
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      emitAgent('agent:status', { status: 'cancelling', sidecar: true });
      const currentTarget = taskExecutionQueue.getByRequestId(executionKey, cancellationTargetRequestId);
      if (!currentTarget) {
        const staleText = CN_TASK_EXECUTION_MESSAGES.staleControl;
        await commitTaskTerminal({
          payload: {
            text: staleText,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          },
          persistAssistantMessage: () => {
            persistEarlyTerminalTranscript(staleText, 'task_control_stale');
          },
          errorContext: 'Stale cancellation terminal',
        });
        return;
      }
      try {
        await taskExecutionQueue.cancelRequest(executionKey, cancellationTargetRequestId);
      } catch (error: any) {
        const settlementTimedOut = error?.code === 'serial_execution_cancellation_timeout';
        const failureText = settlementTimedOut
          ? CN_TASK_EXECUTION_MESSAGES.cancellationSettlementTimedOut
          : sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_CANCEL_FAILED' }).message;
        await commitTaskTerminal({
          ...(settlementTimedOut ? {} : { event: 'agent:error' as const }),
          payload: settlementTimedOut ? {
            text: failureText,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'cancellation_settlement_timeout',
          } : {
            code: 'CHAT_CONTROL_CANCEL_FAILED',
            sidecar: true,
          },
          persistAssistantMessage: () => {
            persistEarlyTerminalTranscript(
              failureText,
              settlementTimedOut ? 'cancellation_settlement_timeout' : 'task_control_failed',
            );
          },
          errorContext: settlementTimedOut
            ? 'Cancellation settlement timeout terminal'
            : 'Cancellation settlement failure terminal',
        });
        return;
      }
      const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
      await commitTaskTerminal({
        payload: {
          text: cancelledText,
          agentName: 'Lumi',
          source: 'task',
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'cancelled_by_user',
        },
        persistAssistantMessage: () => {
          persistEarlyTerminalTranscript(cancelledText, 'task_cancelled');
        },
        errorContext: 'Cancellation terminal',
      });
      return;
    }

    const taskStateKey = scopedEmotionalStateKey(uid, taskScope);
    const selectedConversation = data.conversationId
      ? getConversationForScope(data.conversationId, uid, taskScope.domain, taskScope.orgId)
      : null;
    const convForHistory = selectedConversation || getOrCreateActiveConversation(uid, '', taskScope.domain, taskScope.orgId);
    try {
      await ensurePendingConfirmationPersistenceInitialized();
    } catch (error) {
      console.error('[TaskHandler] Encrypted confirmation store is unavailable:', error);
      publishRecordedAgent('agent:response', normalizeAgentPayload('agent:response', {
        text: taskDurabilityUnknownText(),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      }));
      return;
    }
    const pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
      messages: getMessages(convForHistory.id, 4),
      userId: uid,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      conversationId: convForHistory.id,
      taskId: convForHistory.actionContinuationState?.taskId,
    });
    const confirmationChannelScope = buildTransportNeutralConfirmationScope({
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      conversationId: convForHistory.id,
    });
    let confirmationScope = buildTransportNeutralConfirmationScope({
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      conversationId: convForHistory.id,
      taskId: convForHistory.actionContinuationState?.taskId,
    });
    const taskAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => addMessageIdempotent({
        userId: uid,
        agentId: '',
        conversationId: convForHistory.id,
        role: 'user',
        content: data.text,
        personality: data.personalityId || 'lumi',
        mode: 'task',
        source: 'task',
        channel: 'task',
        cognitiveIntent: 'task_received',
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        requestId,
        deferActionPreparation: true,
      }),
      flush: flushDBOrThrow,
      onPersistenceUnknown: async error => {
        console.error('[TaskHandler] Accepted user turn could not be flushed:', error);
        const unknownPayload = normalizeAgentPayload('agent:response', {
          text: taskDurabilityUnknownText(),
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
    if (!taskAdmission) {
      return;
    }
    const taskUserMessageId = taskAdmission.persisted;
    const confirmationResolution = await resolveAcceptedTurnConfirmation({
      admission: taskAdmission,
      userId: uid,
      userText: data.text,
      actionState: convForHistory.actionContinuationState,
      taskScope: confirmationScope,
      channelScope: confirmationChannelScope,
    });
    confirmationScope = confirmationResolution.scope;
    const pendingConfirmation = confirmationResolution.pending;
    const pendingConfirmationPrompt = confirmationResolution.prompt;
    const correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

    const taskLease = runAfterAcceptedUserTurnAdmission(taskAdmission, () => {
      if (previous && activeMessageRelation === 'replace') {
        void taskExecutionQueue.cancelAll(executionKey);
      }
      beginQueuedChatExecution(executionScope, requestId);
      return taskExecutionQueue.reserve(executionKey, requestId);
    });
    const taskAbortController = taskLease.controller;
    let releaseDesktopControlLease: (() => void) | null = null;
    let taskForegroundRequestIdentity: TaskForegroundRequestIdentity | null = null;
    const releaseTaskTransportResources = (): void => {
      actionLeaseHeartbeat?.stop();
      releaseDesktopControlLease?.();
      releaseDesktopControlLease = null;
      taskLease.release();
    };
    const taskReleaseGate = createDurableForegroundReleaseGate({
      converge: async reason => {
        if (!taskForegroundRequestIdentity) return true;
        const releaseResult = await convergeTaskForegroundRequestBeforeRelease({
          identity: taskForegroundRequestIdentity,
          aborted: taskAbortController.signal.aborted,
          reason,
        });
        if (!releaseResult.converged) {
          console.error('[TaskHandler] foreground_request_finalization_incomplete', {
            code: 'TASK_FOREGROUND_FINALIZATION_INCOMPLETE',
            identity: taskForegroundRequestIdentity,
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
      releaseResources: releaseTaskTransportResources,
      onFailure: ({ error }) => {
        if (error instanceof Error && error.message === 'foreground_request_not_durably_converged') return;
        const convergenceError = error as any;
        console.error('[TaskHandler] foreground_request_finalization_failed', {
          code: 'TASK_FOREGROUND_FINALIZATION_FAILED',
          identity: taskForegroundRequestIdentity,
          errorName: String(convergenceError?.name || 'Error'),
          errorMessage: String(convergenceError?.message || 'Unknown convergence error'),
        });
      },
      onRecoveryTakeover: ({ attempts }) => console.error('[TaskHandler] foreground_release_recovery_takeover', {
        code: 'TASK_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
        identity: taskForegroundRequestIdentity,
        attempts,
      }),
    });
    const releaseTask = (
      reason = 'Task foreground request reached its release boundary.',
    ): Promise<boolean> => taskReleaseGate.release(reason);

    if (previous) {
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      io.to(executionRoom).emit('agent:status', {
        status: activeMessageRelation === 'replace' ? 'replacing' : 'queued',
        source: 'task',
        requestId,
        waitingForRequestId: previous.requestId,
      });
    }
    if (!await taskLease.waitForTurn()) {
      const waitTimedOut = taskLease.state === 'timed_out';
      const cancelledText = waitTimedOut
        ? CN_TASK_EXECUTION_MESSAGES.queueWaitTimedOut
        : CN_TASK_EXECUTION_MESSAGES.cancelled;
      await commitTaskTerminal({
        payload: {
          text: cancelledText,
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: waitTimedOut ? 'queue_wait_timeout' : 'cancelled',
        },
        persistAssistantMessage: () => {
          persistEarlyTerminalTranscript(
            cancelledText,
            waitTimedOut ? 'queue_wait_timeout' : 'task_cancelled',
          );
        },
        errorContext: waitTimedOut ? 'Queued wait timeout terminal' : 'Queued cancellation terminal',
      });
      await releaseTask();
      return;
    }
    const replacementUnknownPayload = {
      text: 'The task transition could not be durably recorded. Please verify before retrying.',
      agentName: 'Lumi',
      source: 'task',
      requestId,
      conversationId: data.conversationId,
      finalized: true,
      blocked: true,
      reason: 'persistence_unknown',
    };
    let superseded = null as Awaited<ReturnType<typeof beginChatExecutionDurably>>;
    try {
      superseded = await runAfterAcceptedUserTurnAdmission(
        taskAdmission,
        () => beginChatExecutionDurably(
          executionScope,
          requestId,
          replacementUnknownPayload,
        ),
      );
    } catch (error) {
      console.error('[TaskHandler] Superseded terminal persistence failed:', error);
      try {
        persistEarlyTerminalTranscript(taskDurabilityUnknownText(), 'task_persistence_unknown');
        await flushDBOrThrow();
      } catch (transcriptError) {
        console.error('[TaskHandler] Replacement transcript persistence failed:', transcriptError);
      }
      try {
        await recordChatExecutionPersistenceUnknownDurably(
          executionScope,
          requestId,
          replacementUnknownPayload,
        );
      } catch (unknownError) {
        console.error('[TaskHandler] Replacement unknown receipt persistence failed:', unknownError);
      }
      publishRecordedAgent(
        'agent:response',
        normalizeAgentPayload('agent:response', replacementUnknownPayload),
      );
      await releaseTask();
      return;
    }
    if (superseded?.terminalEvent) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    if (!acknowledged) {
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
    }
    const taskActionBridge = buildRecentActionContinuationBridge(
      data.text,
      // The accepted current user row is removed below; seven persisted rows
      // therefore leave three complete historical turns for continuation.
      getMessagesByTokenBudget(convForHistory.id, 6_000, 7)
        .filter(message => message.id !== taskUserMessageId)
        .slice(-24),
      convForHistory.actionContinuationState,
      taskUserMessageId,
    );
    const taskContinuationContext = [taskActionBridge, pendingConfirmationPrompt]
      .filter(Boolean)
      .join('\n\n');
    const routedTaskText = [data.text, taskContinuationContext].filter(Boolean).join('\n\n');
    const interactionId = crypto.randomUUID();

    // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
    const personalityPreConfig = personalityRegistry.getForUser(
      data.personalityId || 'lumi',
      uid,
      taskScope.domain === 'work' ? taskScope.orgId : undefined,
    );
    const retrievalBiases = personalityPreConfig?.personalityVector
      ? vectorMemoryBias(personalityPreConfig.personalityVector)
      : { typeWeights: {}, perspectiveWeights: {} };

    const relevantMemories = queryMemories({
      userId: uid, query: routedTaskText, limit: 5, minConfidence: 0.4,
      retrievalTypeWeights: retrievalBiases.typeWeights,
      retrievalPerspectiveWeights: retrievalBiases.perspectiveWeights,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
    });

    const emotionalState = loadEmotionalState(taskStateKey);
    const isNovelTask = relevantMemories.length < 2;

    const sensory = sensoryFn(uid);
    const { config: personality, systemPrompt: systemInstruction } = personalityRegistry.buildSystemPrompt(
      data.personalityId || 'lumi',
      { mode: 'task', sensory },
      {
        memories: relevantMemories.length > 0 ? relevantMemories : undefined,
        emotionalState,
        userId: uid,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
      },
    );

    const userLLMPrefs = getScopedPreferredLLM(uid, taskScope);
    let activeProvider = userLLMPrefs.provider || 'deepseek';
    let activeModel = userLLMPrefs.model;
    const reasoningRoutePolicy = {
      selectionMode: userLLMPrefs.selectionMode,
      fallbackCandidates: userLLMPrefs.fallbackCandidates,
      allowCloudFallback: userLLMPrefs.allowCloudFallback,
      conversationId: convForHistory.id,
      requestId,
      interactionId,
      source: 'task',
      inputTokenBudget: resolveModelRequestInputBudget(),
    };

    // ── Load persisted conversation history (survives page reload) ──
    const boundaryPersonalityToolPolicy = restrictToolPolicyForExecutionBoundary(
      personality.toolPolicy,
      toolSecurityContext.executionBoundary,
    );
    const boundaryAllowedToolNames = new Set(boundaryPersonalityToolPolicy.allowedTools || []);
    const boundaryForbiddenTools = toolSecurityContext.executionBoundary === 'remote_restricted'
      ? toolRegistry.getToolDeclarations({
          context: {
            ...toolSecurityContext,
            userId: uid,
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            source: 'task',
            autonomous: false,
          },
        })
          .map(declaration => declaration.function.name)
          .filter(name => !boundaryAllowedToolNames.has('*') && !boundaryAllowedToolNames.has(name))
      : [];
    const executionPipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: uid,
        text: data.text,
        continuationContext: taskContinuationContext,
        channel: 'task',
        source: 'task',
        category: 'command',
        operationMode: 'assistant',
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        targetIsLumi: personality.id === 'lumi',
      },
      registry: toolRegistry,
      personalityToolPolicy: boundaryPersonalityToolPolicy,
      actionTaskState: convForHistory.actionContinuationState,
      additionalForbiddenTools: boundaryForbiddenTools,
      pendingAssistantOfferContext,
      source: 'task',
    });
    const turnDispatch = executionPipeline.turnIntent;
    const turnFlow = turnDispatch.flow;
    const workSurfaceRoute = turnFlow.workSurfaceRoute;
    const visionIntent = turnFlow.visionIntent;
    const executionDecision = executionPipeline.execution;
    const modelToolPolicy = executionPipeline.authorizationPolicy;
    const modelToolProjection = executionPipeline.modelToolProjection;
    const pipelineToolContext = {
      currentTurnExecutionRequested: executionPipeline.executionRequested,
      trustedActionContinuation: executionPipeline.trustedActionContinuation,
    };
    const visibleToolRoute = restrictVisibleToolRouteForExecutionBoundary(
      executionDecision.toolRoute,
      toolSecurityContext.executionBoundary,
    );
    const toolSessionActive = executionPipeline.executionRequested;
    const actionFollowupIntent = classifyConversationActionFollowupIntent(
      data.text,
      convForHistory.actionContinuationState,
    );
    const actionTaskExecution = prepareConversationActionExecution({
      conversationId: convForHistory.id,
      userId: uid,
      userText: data.text,
      requestId,
      userMessageId: taskUserMessageId,
      toolPolicy: modelToolPolicy,
      forceTask: executionPipeline.capabilityPlan.taskLedgerRequired,
      forceResume: Boolean(pendingConfirmation || executionPipeline.trustedActionContinuation),
    });
    const runtimeOwnedDeterministicRecoveryCall = 'bindingFailure' in actionTaskExecution
      ? null
      : buildDurableTaskDeterministicToolRecoveryCall(
          actionTaskExecution.state,
          requestId,
          confirmationResolution.revokedCorrectionBasis,
        );
    if ('bindingFailure' in actionTaskExecution) {
      const staleText = actionTaskExecution.bindingFailure === 'busy'
        ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
        : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
      await commitTaskTerminal({
        payload: {
          text: staleText,
          agentName: personality.name,
          source: 'task_turn_binding',
          finalized: true,
          blocked: true,
          reason: actionTaskExecution.diagnosticCode,
        },
        persistAssistantMessage: () => {
          addMessageIdempotent({
            userId: uid,
            agentId: '',
            conversationId: convForHistory.id,
            role: 'assistant',
            content: staleText,
            personality: personality.id,
            mode: 'task',
            source: 'task',
            channel: 'task',
            cognitiveIntent: actionTaskExecution.diagnosticCode,
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            requestId,
            skipActionContinuation: true,
          });
        },
        publishAfter: () => {
          io.to(executionRoom).emit('chat:conversation_updated', {
            conversationId: convForHistory.id,
            agentId: '',
            source: 'task',
            requestId,
          });
        },
        errorContext: 'Action turn binding terminal',
      });
      await releaseTask();
      return;
    }
    taskForegroundRequestIdentity = Object.freeze({
      conversationId: convForHistory.id,
      userId: uid,
      requestId,
      expectedTaskId: actionTaskExecution.state?.taskId,
    });
    try {
    actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({
      conversationId: convForHistory.id,
      userId: uid,
      requestId,
      abortController: taskAbortController,
      onPersistenceUnknown: async () => {
        const recorded = await recordChatExecutionPersistenceUnknownDurably(
          executionScope,
          requestId,
          replacementUnknownPayload,
        );
        if (recorded) {
          publishRecordedAgent(
            'agent:response',
            normalizeAgentPayload('agent:response', replacementUnknownPayload),
          );
        }
      },
    });
    if (actionTaskExecution.state?.taskId) {
      executionPipeline.executionPlan = bindCapabilityExecutionPlanTask(
        executionPipeline.executionPlan,
        actionTaskExecution.state.taskId,
      );
      persistConversationExecutionPlan({
        conversationId: convForHistory.id,
        userId: uid,
        plan: executionPipeline.executionPlan,
      });
      updateConversationActionFocus({
        taskId: actionTaskExecution.state.taskId,
        userId: uid,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        commitment: actionTaskExecution.state.goal,
        nextAction: actionTaskExecution.state.latestInstruction || actionTaskExecution.state.goal,
        resumePoint: actionTaskExecution.kind === 'resume'
          ? actionTaskExecution.state.assistantState || actionTaskExecution.state.latestBlocker || ''
          : '',
      });
    }
    const priorTaskRecords = actionTaskExecution.kind === 'resume'
      ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
      : [];
    const taskAwareRecords = (records: ToolExecutionRecord[]) => (
      coalesceToolExecutionRecords([...priorTaskRecords, ...records])
    );
    if (
      toolSessionActive
      && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
    ) {
      setConversationActionExecutionStatus(convForHistory.id, uid, 'executing', { requestId });
    }
    const deferTaskModelOutput =
      toolSessionActive
      || shouldDeferModelOutputUntilFinalized({
        taskText: routedTaskText,
        flow: turnFlow,
      });
    const taskTextGate = createPreFinalizationTextGate();
    const intentTrace = executionPipeline.intentTrace;
    const capabilitySelection = executionPipeline.capabilityPlan;
    const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
      channel: 'task',
      text: routedTaskText,
      flow: turnFlow,
      capabilitySelection,
      capabilityExecutionPlan: executionPipeline.executionPlan,
    });
    const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
    const attachDesktopReceipt = (records: ToolExecutionRecord[]) => (
      withDesktopExecutionReceipt(records, desktopExecutionTracker)
    );
    if (visibleToolRoute) {
      emitAgent('agent:tool_route', {
        categories: visibleToolRoute.categories,
        reasons: visibleToolRoute.reasons,
        toolNames: visibleToolRoute.toolNames,
        totalAvailable: visibleToolRoute.totalAvailable,
        truncated: visibleToolRoute.truncated,
        source: 'task',
        trace: intentTrace,
      });
    }
    emitAgent('agent:intent_trace', intentTrace);
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
      source: 'task',
    });
    if (desktopExecutionPolicy.applies && toolSecurityContext.executionBoundary !== 'remote_restricted') {
      emitAgent('agent:desktop_execution_policy', {
        reason: desktopExecutionPolicy.reason,
        evidenceTools: desktopExecutionPolicy.evidenceTools,
        actuationTools: desktopExecutionPolicy.actuationTools,
        verificationTools: desktopExecutionPolicy.verificationTools,
        source: 'task',
      });
    }
    let effectiveSystemPrompt = restrictSystemPromptForExecutionBoundary(
      systemInstruction,
      toolSecurityContext.executionBoundary,
    );
    if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
      effectiveSystemPrompt += '\n\n' + formatClientSelfPromptForTurn(uid, routedTaskText, taskScope);
    }
    if (!remoteRestricted) {
      effectiveSystemPrompt += '\n\n' + turnDispatch.promptOverlay;
      effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
    }
    effectiveSystemPrompt += '\n\n' + executionBoundaryPromptOverlay(
      executionDecision.promptOverlay,
      toolSecurityContext.executionBoundary,
    );
    if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
      effectiveSystemPrompt += '\n\n' + capabilitySelection.promptOverlay;
    }
    if (desktopExecutionPolicy.promptOverlay && toolSecurityContext.executionBoundary !== 'remote_restricted') {
      effectiveSystemPrompt += '\n\n' + desktopExecutionPolicy.promptOverlay;
    }
    if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
      effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
        userId: uid,
        text: routedTaskText,
        flow: turnFlow,
        toolRegistry,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
      });
    }
    if (workSurfaceRoute.promptOverlay && toolSecurityContext.executionBoundary !== 'remote_restricted') {
      effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
    }
    const visionRoutingOverlay = visionIntent
      && toolSecurityContext.executionBoundary !== 'remote_restricted'
      ? buildVisionRoutingOverlay(uid, routedTaskText)
      : '';
    if (visionRoutingOverlay) {
      effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
    }
    let taskHistory: NormalizedMessage[] = [];
    if (convForHistory) {
      const summaryContext = getConversationSummary(convForHistory.id);
      if (summaryContext) {
        effectiveSystemPrompt += `\n\n## Conversation Context\n${summaryContext}`;
      }
      const recentMsgs = getMessagesByTokenBudget(convForHistory.id, 6_000, 7)
        .filter(message => message.id !== taskUserMessageId);
      // Persisted assistant rows store their text in `message`. Treating every
      // `message` as a user turn inverted assistant replies after reload and
      // made task-mode continuations lose the actual dialogue contract.
      taskHistory = normalizeTaskHistory(recentMsgs);
      // Inject topic context for continuity
      const topicCtx = getTopicContext(convForHistory.id);
      if (topicCtx) effectiveSystemPrompt += topicCtx;
    }
    if (!remoteRestricted) {
      effectiveSystemPrompt += '\n\n' + buildLumiOperatingKernelPrompt({
        channel: 'task',
        flow: turnFlow,
      });
    }
    effectiveSystemPrompt += '\n\n' + buildTextReplyStyleOverlay('task');

    const messages: NormalizedMessage[] = [
      { role: 'system', content: effectiveSystemPrompt },
      ...taskHistory,
      { role: 'user', content: routedTaskText, sourceMessageId: taskUserMessageId },
    ];
    const desktopRelay = createDesktopRelay({
      io,
      userId: uid,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      source: 'task',
      taskId: actionTaskExecution.state?.taskId,
      requestId,
      requestSocket: socket,
      cancelOnRequestSocketDisconnect: false,
      signal: taskAbortController.signal,
    });
    releaseDesktopControlLease = () => desktopRelay.releaseControlLease('task_turn_complete');
    const persistTaskLearning = (
      assistantText: string,
      options: {
        toolRecords?: ToolExecutionRecord[];
        sourceInteractionId?: string;
        logLabel?: string;
      } = {},
    ) => {
      persistLumiPostTurnLearning(
        {
          userId: uid,
          userText: data.text,
          defaultChannel: 'task',
          flow: turnFlow,
          getToolNames: () => toolRegistry.getToolDeclarations({
            context: { userId: uid, domain: taskScope.domain, orgId: taskScope.orgId, source: 'task' },
          }).map(declaration => declaration.function.name),
          domain: taskScope.domain,
          orgId: taskScope.orgId,
          defaultSourceInteractionId: interactionId,
          agentId: '',
          log: { info: console.log, warn: console.warn },
        },
        assistantText,
        options,
      );
    };
    const persistTaskExecutionWriteback = (
      assistantText: string,
      toolRecords: ToolExecutionRecord[] = [],
      sourceInteractionId: string = interactionId,
      finalization?: { blocked?: boolean; reason?: string },
    ) => {
      const executionWriteback = persistWorkTakeoverTurnExecution({
        userId: uid,
        userText: data.text,
        assistantText,
        source: 'task',
        interactionId: sourceInteractionId,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        flow: turnFlow,
        capabilitySelection,
        toolRecords,
        finalizationBlocked: finalization?.blocked === true,
        assistantTextTrusted: finalization?.blocked !== true,
        finalizationReason: finalization?.reason,
      });
      return executionWriteback;
    };
    const publishTaskExecutionWriteback = (executionWriteback: any) => {
      if (!executionWriteback?.recorded) return;
      publishRecordedAgent(
        'agent:task_execution_writeback',
        normalizeAgentPayload('agent:task_execution_writeback', {
          ...executionWriteback,
          source: 'task',
        }),
      );
    };
    let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
    const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
      if (pendingConfirmationCreatedThisTurn) return false;
      if (
        pendingConfirmation
        && await consumePendingConfirmationDurably(
          uid,
          pendingConfirmation.id,
          toolName,
          args,
          confirmationScope,
        )
      ) {
        console.log(`[TaskHandler] Consumed one-time confirmation for "${toolName}".`);
        return true;
      }
      if (
        !correctionRequiresFreshConfirmation
        && canAutoApproveAction(toolName, args, { actionIntent: routedTaskText })
      ) return true;
      const exactWriteCorrection = correctionRequiresFreshConfirmation
        && confirmationResolution.revokedCorrectionBasis?.toolName === 'write_file';
      if (
        exactWriteCorrection
        && (
          !runtimeOwnedDeterministicRecoveryCall
          || toolName !== runtimeOwnedDeterministicRecoveryCall.name
          || !confirmationArgumentsMatch(args, runtimeOwnedDeterministicRecoveryCall.arguments)
        )
      ) {
        throw new Error('Corrected write confirmation did not match the runtime-owned exact proposal');
      }
      const pending = await recordPendingConfirmationDurably(uid, toolName, args, 'task', {
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        channelId: confirmationChannelScope.channelId,
        taskId: actionTaskExecution.state?.taskId,
        originRequestId: requestId,
        actionIntent: routedTaskText,
      });
      if (
        correctionRequiresFreshConfirmation
        && !pendingConfirmationMatchesExactProposal(
          pending,
          toolName,
          args,
          { taskId: actionTaskExecution.state?.taskId, originRequestId: requestId },
        )
      ) {
        throw new Error('Corrected action confirmation was not bound to the current task request');
      }
      pendingConfirmationCreatedThisTurn = pending;
      setConversationActionExecutionStatus(convForHistory.id, uid, 'waiting_confirmation', {
        assistantState: formatPendingConfirmationPrompt(pending),
        requestId,
      });
      console.warn(`[TaskHandler] Tool "${toolName}" is waiting for one-time confirmation ${pending.id}.`);
      return false;
    };

    if (actionFollowupIntent === 'status') {
      const statusText = getConversationActionStatus(
        convForHistory.id,
        uid,
        data.text,
        convForHistory.actionContinuationState,
      );
      await commitTaskTerminal({
        payload: {
          text: statusText,
          agentName: personality.name,
          source: 'task_status',
          finalized: true,
          blocked: false,
          reason: '',
        },
        persistAssistantMessage: () => {
          addMessageIdempotent({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: statusText, personality: personality.id, mode: 'task', source: 'task', channel: 'task', domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status', requestId, skipActionContinuation: true });
        },
        publishAfter: () => {
          io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
        },
        errorContext: 'Conversation task status terminal',
      });
      return;
    }

    if (pendingConfirmation) {
      const confirmedTask = pendingConfirmation.actionIntent || data.text;
      const confirmedArgs = pendingConfirmation.exactArgs || {};
      const confirmationRecordId =
        `task-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const consumed = await consumePendingConfirmationDurably(
        uid,
        pendingConfirmation.id,
        pendingConfirmation.toolName,
        confirmedArgs,
        confirmationScope,
      );
      const confirmationRecord = await executeToolCall({
        registry: toolRegistry,
        id: confirmationRecordId,
        name: pendingConfirmation.toolName,
        arguments: confirmedArgs,
        context: {
          ...toolSecurityContext,
          ...pipelineToolContext,
          userId: uid,
          taskId: actionTaskExecution.state?.taskId,
          conversationId: convForHistory.id,
          turnId: requestId,
          requestId,
          domain: taskScope.domain,
          orgId: taskScope.orgId,
          desktopRelay,
          llmGetters,
          source: 'task_confirmation',
          supervisedExternalCommits: true,
          isCancelled: () => taskAbortController.signal.aborted,
          userConfirmed: true,
          actionIntent: confirmedTask,
          routedTaskText: confirmedTask,
          toolPolicy: modelToolPolicy,
          desktopExecutionTracker,
        },
        preflight: () => consumed
          ? { allowed: true, arguments: confirmedArgs }
          : {
              allowed: false,
              arguments: confirmedArgs,
              reason: 'The one-time confirmation expired before execution.',
            },
      });
      emitAgent("agent:tool_call", {
        name: confirmationRecord.name,
        arguments: confirmationRecord.arguments,
        result: confirmationRecord.result?.slice(0, 500),
        error: confirmationRecord.error,
      });
      let confirmationRecords: ToolExecutionRecord[] = [confirmationRecord];
      let confirmationResponse = toolRecordSucceeded(confirmationRecord)
        ? CN_TASK_EXECUTION_MESSAGES.confirmationExecuted
        : CN_TASK_EXECUTION_MESSAGES.confirmationFailed(
            confirmationRecord.error || confirmationRecord.result,
          );
      if (
        confirmedStepNeedsContinuation(
          confirmedTask,
          taskAwareRecords([confirmationRecord]),
        )
        && !taskAbortController.signal.aborted
      ) {
        const continuation = await runWithTools(
          [
            { role: 'system', content: effectiveSystemPrompt },
            ...buildConfirmedStepContinuationMessages(confirmedTask, confirmationRecord, {
              messageId: taskUserMessageId,
              text: data.text,
            }),
          ],
          toolRegistry,
          {
            provider: activeProvider,
            model: activeModel,
            userId: uid,
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            signal: taskAbortController.signal,
            ...reasoningRoutePolicy,
          },
          record => {
            emitAgent("agent:tool_call", {
              name: record.name,
              arguments: record.arguments,
              result: record.result?.slice(0, 500),
              error: record.error,
            });
          },
          modelToolPolicy.maxIterations || 25,
          llmGetters.getDeepSeek,
          llmGetters.getGemini,
          llmGetters.getOpenAI,
          llmGetters.getAnthropic,
          llmGetters.getQwen,
          undefined,
          {
            ...toolSecurityContext,
            ...pipelineToolContext,
            userId: uid,
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            desktopRelay,
            requestConfirmation,
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
            toolPolicy: modelToolPolicy,
            modelToolProjection,
            priorToolRecords: [confirmationRecord],
            desktopExecutionTracker,
            isCancelled: () => taskAbortController.signal.aborted,
            llmGetters,
            source: 'task_confirmation_resume',
            supervisedExternalCommits: true,
          },
          llmGetters.getOllama,
          llmGetters.getLmStudio,
          llmGetters.getArk,
          llmGetters.getXiaomi,
          llmGetters.getKimi,
          llmGetters.getGlm,
          llmGetters.getRelay,
        );
        confirmationRecords = continuation.toolCalls?.length
          ? continuation.toolCalls
          : [confirmationRecord];
        confirmationResponse = pendingConfirmationCreatedThisTurn
          ? CN_TASK_EXECUTION_MESSAGES.waitingConfirmation(confirmedTask)
          : continuation.text || confirmationResponse;
      }
      confirmationRecords = attachDesktopReceipt(confirmationRecords);
      const finalConfirmation = finalizeLumiResponse({
        taskText: confirmedTask,
        responseText: confirmationResponse,
        toolRecords: taskAwareRecords(confirmationRecords),
        source: 'task_confirmation',
        flow: { ...turnFlow, routeText: confirmedTask },
        taskId: actionTaskExecution.state?.taskId,
        requestId,
      });
      confirmationRecord.executionOrigin = 'confirmed_action_resume';
      const terminalCommitted = await commitTaskTerminal({
        payload: {
          text: finalConfirmation.text,
          agentName: personality.name,
          source: 'task_confirmation',
          finalized: true,
          blocked: finalConfirmation.blocked,
          reason: finalConfirmation.reason || '',
        },
        persistTerminalState: () => persistTaskExecutionWriteback(
          finalConfirmation.text,
          confirmationRecords,
          `${interactionId}_confirmation`,
          { blocked: finalConfirmation.blocked, reason: finalConfirmation.reason },
        ),
        persistAssistantMessage: () => {
          addMessageIdempotent({
            userId: uid,
            agentId: '',
            conversationId: convForHistory.id,
            role: 'assistant',
            content: finalConfirmation.text,
            personality: personality.id,
            mode: 'task',
            source: 'task',
            channel: 'task',
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            toolCalls: confirmationRecords,
            cognitiveIntent: finalConfirmation.blocked ? 'work_product_guard' : 'confirmation',
            requestId,
            ...(finalConfirmation.blocked && actionTaskExecution.state?.taskId ? {
              terminalTaskDisposition: {
                outcome: 'blocked' as const,
                taskId: actionTaskExecution.state.taskId,
                requestId,
                reason: finalConfirmation.reason
                  || 'The confirmed task request ended without verified goal-level completion evidence.',
              },
            } : {}),
          });
        },
        publishAfter: executionWriteback => {
          if (finalConfirmation.notification) {
            publishRecordedAgent(
              'agent:notification',
              normalizeAgentPayload('agent:notification', finalConfirmation.notification),
            );
          }
          publishTaskExecutionWriteback(executionWriteback);
          io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
        },
        errorContext: 'Confirmation terminal',
      });
      if (terminalCommitted && !finalConfirmation.blocked) {
        persistTaskLearning(finalConfirmation.text, { toolRecords: confirmationRecords, logLabel: 'task confirmation' });
      }
      return;
    }

    let cognition: CognitiveResult | undefined;

    try {
      emitAgent("agent:status", { status: "thinking", agentName: personality.name });

      // ── Lumi Cognitive Engine: classify intent BEFORE calling any LLM ──
      const cognitiveCtx: CognitiveContext = {
        userId: uid,
        personalityId: personality.id,
        personalityName: personality.name,
        llmProvider: activeProvider,
        llmModel: activeModel,
        isLLMAvailable: true,
      };
      cognition = await processInput(routedTaskText, cognitiveCtx);
      if (taskLease.signal.aborted) {
        const cancellationError = new Error('Task cancelled');
        cancellationError.name = 'AbortError';
        throw cancellationError;
      }

      // Cognitive complexity may influence prompting and token budgets, but the
      // exact model selected by the user must not be silently replaced.
      console.log(`[Task] Using configured model: ${activeProvider}/${activeModel} for category: ${cognition.intent.category}`);

      if (cognition.directToolExecuted && cognition.responseText) {
        console.log(`[Cognition] Task handled directly: ${cognition.intent.category}/${cognition.intent.subIntent}`);
        const directToolRecords = attachDesktopReceipt(
          cognition.toolRecords || (cognition.toolRecord ? [cognition.toolRecord] : []),
        );
        const finalDirect = finalizeLumiResponse({
          taskText: data.text,
          responseText: cognition.responseText,
          toolRecords: taskAwareRecords(directToolRecords),
          source: 'task',
          flow: turnFlow,
          taskId: actionTaskExecution.state?.taskId,
          requestId,
        });
        const directResponseText = finalDirect.text;
        const terminalCommitted = await commitTaskTerminal({
          payload: {
            text: directResponseText,
            agentName: personality.name,
            source: 'task',
            finalized: true,
            blocked: finalDirect.blocked,
            reason: finalDirect.reason,
          },
          persistTerminalState: () => {
            const db = readDB();
            db.interactions.push({
              id: interactionId,
              content: data.text,
              response: directResponseText,
              role: "user",
              personality: personality.id,
              timestamp: new Date().toISOString(),
              mode: 'task',
              cognitiveIntent: cognition!.intent.category,
              llmWasCalled: false,
              userId: uid,
              conversationId: convForHistory.id,
              domain: taskScope.domain,
              orgId: taskScope.orgId,
            } as any);
            writeDB(db);
            return persistTaskExecutionWriteback(
              directResponseText,
              directToolRecords,
              `${interactionId}_direct`,
              { blocked: finalDirect.blocked, reason: finalDirect.reason },
            );
          },
          persistAssistantMessage: () => {
            addMessageIdempotent({
              userId: uid,
              agentId: '',
              conversationId: convForHistory.id,
              role: 'assistant',
              content: directResponseText,
              personality: personality.id,
              mode: 'task',
              source: 'task',
              channel: 'task',
              domain: taskScope.domain,
              orgId: taskScope.orgId,
              toolCalls: directToolRecords.length ? directToolRecords : undefined,
              cognitiveIntent: finalDirect.blocked ? 'work_product_guard' : cognition!.intent.category,
              llmWasCalled: false,
              requestId,
              ...(finalDirect.blocked && actionTaskExecution.state?.taskId ? {
                terminalTaskDisposition: {
                  outcome: 'blocked' as const,
                  taskId: actionTaskExecution.state.taskId,
                  requestId,
                  reason: finalDirect.reason
                    || 'The direct task request ended without verified goal-level completion evidence.',
                },
              } : {}),
            });
          },
          publishAfter: executionWriteback => {
            if (finalDirect.notification) {
              publishRecordedAgent(
                'agent:notification',
                normalizeAgentPayload('agent:notification', finalDirect.notification),
              );
            }
            publishTaskExecutionWriteback(executionWriteback);
            io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
          },
          errorContext: 'Direct cognition terminal',
        });
        if (terminalCommitted) {
          persistTaskLearning(directResponseText, {
            toolRecords: directToolRecords,
            logLabel: 'task direct cognition',
          });
        }
        return;
      }

      const result = await runWithTools(
        messages,
        toolRegistry,
        { provider: activeProvider, model: activeModel, userId: uid, domain: taskScope.domain, orgId: taskScope.orgId, signal: taskAbortController.signal, ...reasoningRoutePolicy },
        (record) => {
          emitAgent("agent:tool_call", {
            name: record.name,
            arguments: record.arguments,
            result: record.result?.slice(0, 500),
            error: record.error,
          });
        },
        modelToolPolicy.maxIterations || 25,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        (chunk) => {
          if (!taskLease.signal.aborted && !deferTaskModelOutput) {
            const safeText = taskTextGate.push(chunk);
            if (safeText) {
              emitTask("task:chunk", { text: safeText, agentName: personality.name });
              emitAgent("agent:chunk", { text: safeText, agentName: personality.name });
            }
          }
        },
        { ...toolSecurityContext, ...pipelineToolContext, userId: uid, taskId: actionTaskExecution.state?.taskId, taskRevision: actionTaskExecution.state?.revision, conversationId: convForHistory.id, turnId: requestId, requestId, domain: taskScope.domain, orgId: taskScope.orgId, desktopRelay, requestConfirmation, actionIntent: data.text, routedTaskText, ...(runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall } : {}), toolPolicy: modelToolPolicy, modelToolProjection, desktopExecutionTracker, isCancelled: () => taskLease.signal.aborted, llmGetters, source: 'task', supervisedExternalCommits: true },
        llmGetters.getOllama,
        llmGetters.getLmStudio,
        llmGetters.getArk,
        llmGetters.getXiaomi,
        llmGetters.getKimi,
        llmGetters.getGlm,
        llmGetters.getRelay,
      );

      // Persist token usage
      for (const u of result.usageRecords) {
        recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId, 'task');
      }
      taskTextGate.finish();
      let finalTaskToolRecords = attachDesktopReceipt(result.toolCalls);

      if (taskLease.signal.aborted) {
        const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
        const cancelledResponse = finalizeLumiResponse({
          taskText: data.text,
          responseText: cancelledText,
          toolRecords: finalTaskToolRecords,
          source: 'task',
          flow: turnFlow,
          taskId: actionTaskExecution.state?.taskId,
          requestId,
        });
        const terminalCommitted = await commitTaskTerminal({
          payload: {
            text: cancelledResponse.text,
            agentName: personality.name,
            source: 'task',
            finalized: true,
            blocked: false,
            reason: 'cancelled',
          },
          persistTerminalState: () => {
            cancelConversationActionExecution(
              convForHistory.id,
              uid,
              cancelledText,
              requestId,
            );
            return persistTaskExecutionWriteback(
              cancelledResponse.text,
              finalTaskToolRecords,
              `${interactionId}_cancelled`,
              { blocked: true, reason: 'cancelled' },
            );
          },
          persistAssistantMessage: () => {
            addMessageIdempotent({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: cancelledResponse.text, personality: personality.id, mode: 'task', source: 'task', channel: 'task', domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: finalTaskToolRecords.length ? finalTaskToolRecords : undefined, cognitiveIntent: 'task_cancelled', requestId });
          },
          publishAfter: executionWriteback => {
            publishTaskExecutionWriteback(executionWriteback);
            io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
          },
          errorContext: 'Cancelled task terminal',
        });
        if (terminalCommitted) {
          persistTaskLearning(cancelledResponse.text, {
            toolRecords: finalTaskToolRecords,
            sourceInteractionId: `${interactionId}_cancelled`,
            logLabel: 'task cancelled',
          });
        }
        return;
      }

      let finalTaskText = result.text;
      let finalTaskResponse: ReturnType<typeof finalizeLumiResponse> = pendingConfirmationCreatedThisTurn
        ? {
            text: formatPendingConfirmationPrompt(pendingConfirmationCreatedThisTurn),
            blocked: false,
            reason: 'waiting_confirmation',
          }
        : finalizeLumiResponse({
            taskText: data.text,
            responseText: finalTaskText,
            toolRecords: taskAwareRecords(finalTaskToolRecords),
            source: 'task',
            flow: turnFlow,
            taskId: actionTaskExecution.state?.taskId,
            requestId,
          });
      const desktopPauseBlocksCurrentTask = () => {
        return shouldBlockForDesktopControlPause({
          pauseReason: desktopRelay.getControlPauseReason(),
          waitingForConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
          taskText: routedTaskText,
          toolRecords: taskAwareRecords(finalTaskToolRecords),
        });
      };
      if (desktopPauseBlocksCurrentTask()) {
        const pausePresentation = formatDesktopControlPausePresentation(routedTaskText);
        finalTaskResponse = {
          ...finalTaskResponse,
          text: pausePresentation.text,
          blocked: true,
          reason: pausePresentation.reason,
        };
      }
      const guardRecovery = await recoverBlockedExecutionOnce({
        task: routedTaskText,
        responseText: finalTaskText,
        finalization: finalTaskResponse,
        allowToolUse: toolSessionActive,
        pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
        requiresFreshConfirmation: correctionRequiresFreshConfirmation,
        aborted: taskLease.signal.aborted || desktopPauseBlocksCurrentTask(),
        isAborted: () => taskLease.signal.aborted || desktopPauseBlocksCurrentTask(),
        isPendingConfirmation: () => Boolean(pendingConfirmationCreatedThisTurn),
        toolRecords: finalTaskToolRecords,
        attempt: async ({ instruction, priorToolRecords, recordTool }) => {
          console.warn('[TaskHandler] Recovering blocked execution internally.');
          const recovery = await runWithTools(
            [
              ...messages,
              { role: 'assistant', content: finalTaskText },
              { role: 'user', content: instruction },
            ],
            toolRegistry,
            {
              provider: activeProvider,
              model: activeModel,
              userId: uid,
              domain: taskScope.domain,
              orgId: taskScope.orgId,
              signal: taskAbortController.signal,
              ...reasoningRoutePolicy,
            },
            record => {
              recordTool(record);
              emitAgent('agent:tool_call', {
                name: record.name,
                arguments: record.arguments,
                result: record.result?.slice(0, 500),
                error: record.error,
              });
            },
            Math.max(2, Math.min(12, modelToolPolicy.maxIterations || 8)),
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
            undefined,
            {
              ...toolSecurityContext,
              ...pipelineToolContext,
              userId: uid,
              taskId: actionTaskExecution.state?.taskId,
              conversationId: convForHistory.id,
              turnId: requestId,
              requestId,
              domain: taskScope.domain,
              orgId: taskScope.orgId,
              desktopRelay,
              requestConfirmation,
              actionIntent: data.text,
              routedTaskText,
              ...(runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall } : {}),
              toolPolicy: modelToolPolicy,
              modelToolProjection,
              priorToolRecords,
              desktopExecutionTracker,
              isCancelled: () => taskLease.signal.aborted,
              llmGetters,
              taskRevision: actionTaskExecution.state?.revision,
              source: 'task_guard_recovery',
              supervisedExternalCommits: true,
            },
            llmGetters.getOllama,
            llmGetters.getLmStudio,
            llmGetters.getArk,
            llmGetters.getXiaomi,
            llmGetters.getKimi,
            llmGetters.getGlm,
            llmGetters.getRelay,
          );
          for (const usage of recovery.usageRecords) {
            recordTokenUsage(uid, usage.provider, usage.model, {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }, interactionId, 'task');
          }
          return {
            text: recovery.text,
            toolRecords: attachDesktopReceipt(recovery.toolCalls),
          };
        },
        finalize: (candidateText, records) => pendingConfirmationCreatedThisTurn
          ? {
              text: formatPendingConfirmationPrompt(pendingConfirmationCreatedThisTurn),
              blocked: false,
              reason: 'waiting_confirmation',
            }
          : finalizeLumiResponse({
              taskText: data.text,
              responseText: candidateText,
              toolRecords: taskAwareRecords(records),
              source: 'task_guard_recovery',
              flow: turnFlow,
              taskId: actionTaskExecution.state?.taskId,
              requestId,
            }),
      });
      finalTaskResponse = guardRecovery.finalization;
      finalTaskToolRecords = attachDesktopReceipt(guardRecovery.toolRecords);
      finalTaskText = finalTaskResponse.text;
      const holoTask = canOutputHolographic(sensory)
        ? textToHolographicOutput(finalTaskText)
        : undefined;
      const taskTerminalPayload = {
        text: finalTaskText,
        agentName: personality.name,
        holographic: holoTask,
        source: 'task',
        finalized: true,
        blocked: finalTaskResponse.blocked,
        reason: finalTaskResponse.reason,
      };

      // Log with conversation linkage
      const db = readDB();
      const conv = convForHistory;
      if (!conv.title) {
        conv.title = data.text.slice(0, 50);
        writeDB(db);
      }
      db.interactions.push({
        id: interactionId,
        content: data.text,
        response: finalTaskText,
        role: "user",
        personality: personality.id,
        timestamp: new Date().toISOString(),
        mode: 'task',
        toolCalls: finalTaskToolRecords.map((tc: any) => ({ name: tc.name, args: tc.arguments })),
        conversationId: conv.id,
        userId: uid,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
      } as any);
      writeDB(db);

      const executionWriteback = persistTaskExecutionWriteback(
        finalTaskText,
        finalTaskToolRecords,
        interactionId,
        { blocked: finalTaskResponse.blocked, reason: finalTaskResponse.reason },
      );
      const terminalCommitted = await commitTaskTerminal({
        payload: taskTerminalPayload,
        persistTerminalState: () => executionWriteback,
        persistAssistantMessage: () => {
          if (!finalTaskText) return;
          addMessageIdempotent({
            userId: uid,
            agentId: '',
            conversationId: convForHistory.id,
            role: 'assistant',
            content: finalTaskText,
            personality: personality.id,
            mode: 'task',
            source: 'task',
            channel: 'task',
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            toolCalls: finalTaskToolRecords.length ? finalTaskToolRecords : undefined,
            cognitiveIntent: finalTaskResponse.blocked ? 'work_product_guard' : cognition!.intent.category,
            llmWasCalled: true,
            requestId,
            ...(finalTaskResponse.blocked && actionTaskExecution.state?.taskId ? {
              terminalTaskDisposition: {
                outcome: 'blocked' as const,
                taskId: actionTaskExecution.state.taskId,
                requestId,
                reason: finalTaskResponse.reason
                  || 'The task request ended without verified goal-level completion evidence.',
              },
            } : {}),
          });
        },
        publishAfter: () => {
          if (finalTaskResponse.notification) {
            publishRecordedAgent(
              'agent:notification',
              normalizeAgentPayload('agent:notification', finalTaskResponse.notification),
            );
          }
          publishTaskExecutionWriteback(executionWriteback);
          io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
        },
        errorContext: 'Task terminal',
      });
      if (!terminalCommitted) return;
      persistTaskLearning(finalTaskText, { toolRecords: finalTaskToolRecords, logLabel: 'task' });

      // Async memory extraction
      const locationTag = sensory.locationTag || undefined;
      extractMemories(
        {
          userMessage: data.text,
          assistantResponse: finalTaskText,
          existingMemories: relevantMemories.map(m => m.content),
          provider: activeProvider,
          model: activeModel,
          userId: uid,
          locationTag,
          domain: taskScope.domain,
          orgId: taskScope.orgId,
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      ).then(extracted => {
        for (const mem of extracted.memories) {
          addMemory({
            userId: uid,
            type: mem.type,
            content: mem.content,
            keywords: mem.keywords,
            confidence: mem.confidence,
            sourceInteractionId: db.interactions[db.interactions.length - 1]?.id || '',
          } as any, { location: locationTag, domain: taskScope.domain, orgId: taskScope.orgId, source: 'system' });
        }
        for (const rem of extracted.reminders) {
          addReminder({
            userId: uid,
            content: rem.content,
            dueAt: rem.dueAt,
            sourceInteractionId: db.interactions[db.interactions.length - 1]?.id || '',
            domain: taskScope.domain,
            orgId: taskScope.orgId,
          });
        }
        const totalExtracted = extracted.memories.length + extracted.reminders.length;
        if (totalExtracted > 0) {
          console.log(`[Memory] Extracted ${extracted.memories.length} memories + ${extracted.reminders.length} reminders for user ${uid}`);
        }
      }).catch(err => console.error('[Memory] Extraction failed:', err));

      // Update emotional state with sentiment analysis + HIM
      const sentiment = extractSentiment(data.text);
      let updatedState = updateEmotionalState(emotionalState, {
        type: 'interaction',
        userId: uid,
        timestamp: new Date().toISOString(),
      });
      if (sentiment.valence !== 0 || sentiment.frustration > 0 || sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, {
          type: 'sentiment_analysis',
          sentiment,
          userId: uid,
          timestamp: new Date().toISOString(),
        });
      }
      if (isNovelTask) {
        updatedState = updateEmotionalState(updatedState, {
          type: 'novel_topic',
          userId: uid,
          timestamp: new Date().toISOString(),
        });
      }
      const himState = loadHIMState(taskStateKey);
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: uid }, himState, data.text.slice(0, 40));
      saveEmotionalState(taskStateKey, himUpdated);
      saveHIMState(taskStateKey, newHim);

      // Post-commit conversation enrichment never gates or precedes the terminal receipt.
      if (convForHistory) {
        try {
          const topics = extractTopics(data.text + ' ' + finalTaskText);
          for (const topic of topics) trackTopic(convForHistory.id, topic);
        } catch {}
      }

    } catch (err: any) {
      if (taskLease.signal.aborted || err?.name === 'AbortError') {
        const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
        const cancellationRecords = cognition?.toolRecords
          || (cognition?.toolRecord ? [cognition.toolRecord] : []);
        await commitTaskTerminal({
          payload: {
            text: cancelledText,
            agentName: personality.name,
            finalized: true,
            blocked: false,
            reason: 'cancelled',
          },
          persistTerminalState: () => {
            cancelConversationActionExecution(
              convForHistory.id,
              uid,
              cancelledText,
              requestId,
            );
            return persistTaskExecutionWriteback(
              cancelledText,
              cancellationRecords,
              `${interactionId}_cancelled`,
              { blocked: true, reason: 'cancelled' },
            );
          },
          persistAssistantMessage: () => {
            addMessageIdempotent({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: cancelledText, personality: personality.id, mode: 'task', source: 'task', channel: 'task', domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: cancellationRecords.length ? cancellationRecords : undefined, cognitiveIntent: 'task_cancelled', requestId });
          },
          publishAfter: executionWriteback => {
            publishTaskExecutionWriteback(executionWriteback);
            io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
          },
          errorContext: 'Caught cancellation terminal',
        });
        return;
      }
      console.error("[Agent Task Error]:", err);
      handleLLMFailure(
        cognition?.intent || { category: 'unknown', confidence: 0, entities: {}, needsLLM: true },
        err,
      );
      const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
      const failureReason = 'task_execution_failed';
      const failureRecords = cognition?.toolRecords
        || (cognition?.toolRecord ? [cognition.toolRecord] : []);
      await commitTaskTerminal({
        payload: {
          text: failureText,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: true,
          reason: failureReason,
        },
        persistTerminalState: () => {
          setConversationActionExecutionStatus(convForHistory.id, uid, 'blocked', {
            blocker: failureText,
            assistantState: failureText,
            requestId,
          });
          return persistTaskExecutionWriteback(
            failureText,
            failureRecords,
            `${interactionId}_failed`,
            { blocked: true, reason: failureReason },
          );
        },
        persistAssistantMessage: () => {
          addMessageIdempotent({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: failureText, personality: personality.id, mode: 'task', source: 'task', channel: 'task', domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: failureRecords.length ? failureRecords : undefined, cognitiveIntent: 'task_execution_failed', requestId });
        },
        publishAfter: executionWriteback => {
          publishTaskExecutionWriteback(executionWriteback);
          io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
        },
        errorContext: 'Failed task terminal',
      });
    }
    } catch (lifecycleError: any) {
      const aborted = taskAbortController.signal.aborted || lifecycleError?.name === 'AbortError';
      const terminalText = aborted
        ? CN_TASK_EXECUTION_MESSAGES.cancelled
        : CN_VOICE_WORK_MESSAGES.processingFailed;
      console.error('[TaskHandler] post_binding_lifecycle_failed', {
        code: aborted ? 'TASK_FOREGROUND_ABORTED' : 'TASK_FOREGROUND_EXECUTION_FAILED',
        identity: taskForegroundRequestIdentity,
        errorName: String(lifecycleError?.name || 'Error'),
        errorMessage: String(lifecycleError?.message || 'Unknown Task lifecycle error'),
      });
      await commitTaskTerminal({
        payload: {
          text: terminalText,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: !aborted,
          reason: aborted ? 'cancelled' : 'task_execution_failed',
        },
        persistTerminalState: () => aborted
          ? cancelConversationActionExecution(
              convForHistory.id,
              uid,
              terminalText,
              requestId,
            )
          : setConversationActionExecutionStatus(convForHistory.id, uid, 'blocked', {
              blocker: terminalText,
              assistantState: terminalText,
              requestId,
            }),
        persistAssistantMessage: () => {
          addMessageIdempotent({
            userId: uid,
            agentId: '',
            conversationId: convForHistory.id,
            role: 'assistant',
            content: terminalText,
            personality: personality.id,
            mode: 'task',
            source: 'task',
            channel: 'task',
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            cognitiveIntent: aborted ? 'task_cancelled' : 'task_execution_failed',
            llmWasCalled: false,
            requestId,
          });
        },
        publishAfter: () => {
          io.to(executionRoom).emit('chat:conversation_updated', {
            conversationId: convForHistory.id,
            agentId: '',
            source: 'task',
            requestId,
          });
        },
        errorContext: aborted
          ? 'Post-binding cancellation terminal'
          : 'Post-binding lifecycle failure terminal',
      });
    } finally {
      await releaseTask();
    }
  });
}



