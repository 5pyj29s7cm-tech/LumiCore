/**
 * agent:task socket handler — multi-turn tool-augmented AI pipeline
 */
import { Server, Socket } from "socket.io";
import { readDB, writeDB } from "../../db_layer";
import { recordTokenUsage } from "../llm/token_tracker";
import { NormalizedMessage } from "../llm/providers";
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
  getMessagesByTokenBudget,
  addMessage,
  extractTopics,
  trackTopic,
  getTopicContext,
  getConversationSummary,
  getConversationActionStatus,
  prepareConversationActionExecution,
  persistConversationExecutionPlan,
  persistConversationModelExecutionResult,
  getConversationModelExecutionRecovery,
  cancelConversationActionExecution,
  setConversationActionExecutionStatus,
  updateConversationActionFocus,
} from "../conversation/manager";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext, CognitiveResult } from "../cognition";
import {
  buildSkillDescription,
  classifyComplexity,
  decomposeTask,
  executeWorkflow,
  isTerminalOrchestrationToolEvent,
  matchWorkers,
  aggregateWithLLM,
  recordWorkflowPattern,
  shouldAttemptOrchestration,
  shouldDistillSkill,
} from "../agents/orchestrator";
import { markLatestUserTurn } from "../agents/background_delivery";
import { loadHIMState, saveHIMState, updateEmotionalStateWithHIM } from "../personality/state";
import { shouldExposeAgentWork } from "../cognition/tool_intent";
import { formatClientSelfPrompt } from "../client/self_model";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { buildModelToolProjection } from "../cognition/capability_selection";
import { bindCapabilityExecutionPlanTask } from "../cognition/capability_execution_plan";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import {
  recoverBlockedExecutionOnce,
  sanitizeExecutionResponseForDelivery,
} from "../cognition/execution_guard_recovery";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
} from "../cognition/response_delivery";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { canAutoApproveAction } from "../tools/action_constitution";
import {
  clearPendingConfirmation,
  consumePendingConfirmation,
  formatPendingConfirmationPrompt,
  getPendingConfirmation,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from "../tools/pending_confirmation";
import type { ToolExecutionRecord } from "../tools/types";
import {
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  formatConversationActionTaskStatus,
} from "../cognition/action_continuation";
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
import { CN_TASK_EXECUTION_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
import { normalizeVoiceHistory as normalizeTaskHistory } from './voice_history';
import {
  beginChatExecution,
  beginQueuedChatExecution,
  beginChatSidecarExecution,
  getChatExecution,
  getChatSidecarCancellationTarget,
  markChatExecutionCancelling,
  persistChatSidecarCancellationIntent,
  recordChatExecutionEvent,
  waitForChatSidecarCancellationIntent,
  type ChatExecutionScope,
} from "./chat_execution_registry";
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

function taskExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}

function taskExecutionKey(scope: ChatExecutionScope): string {
  return `${scope.userId}:${scope.domain}:${scope.orgId || ''}:${scope.source}`;
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
    try {
      const conversation = getOrCreateActiveConversation(
        uid,
        '',
        resolvedScope.domain,
        resolvedScope.orgId,
      );
      cancelConversationActionExecution(conversation.id, uid);
    } catch {}
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
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      const publicPayload = event === 'agent:response'
        ? sanitizeExecutionResponseForDelivery(payload, { task: data.text })
        : payload;
      const normalizedPayload = { ...publicPayload, source: publicPayload.source || 'task', requestId };
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
      io.to(executionRoom).emit(event, normalizedPayload);
      return true;
    };
    const emitTask = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = { ...payload, source: payload.source || 'task', requestId };
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return;
      io.to(executionRoom).emit(event, normalizedPayload);
    };

    let existingExecution = getChatExecution(executionScope, requestId);
    if (existingExecution) {
      if (existingExecution.sidecar === true && !existingExecution.terminal) {
        try {
          await waitForChatSidecarCancellationIntent(executionScope, requestId);
        } catch (error: any) {
          try { ack?.({ ok: false, requestId, error: String(error?.message || 'Control receipt is not durable') }); } catch {}
          return;
        }
        existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(executionScope, requestId);
        if (durableTarget && !taskExecutionQueue.getByRequestId(executionKey, durableTarget)) {
          recordChatExecutionEvent(executionScope, requestId, 'agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            source: 'task',
            requestId,
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          });
          existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
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
      if (!controlTargetRequestId || controlTargetRequestId !== runningTask.requestId) {
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        emitAgent('agent:response', {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
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
      const statusCommitted = emitAgent('agent:response', {
        text: statusText,
        agentName: 'Lumi',
        source: 'task',
        requestId,
        sidecar: true,
        finalized: true,
        blocked: false,
        reason: '',
      });
      if (statusCommitted) {
        addMessage({ userId: uid, agentId: '', conversationId: activeConversation.id, role: 'user', content: data.text, domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status', requestId });
        addMessage({ userId: uid, agentId: '', conversationId: activeConversation.id, role: 'assistant', content: statusText, domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status', requestId });
      }
      return;
    }

    const previous = taskExecutionQueue.getTail(executionKey);
    let acknowledged = false;
    if (previous && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      if (!controlTargetRequestId) {
        emitAgent('agent:response', {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'missing_control_target',
        });
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        return;
      }
      try {
        await persistChatSidecarCancellationIntent(executionScope, requestId, controlTargetRequestId);
      } catch (error: any) {
        const message = String(error?.message || 'Unable to reserve task cancellation request');
        emitAgent('agent:error', {
          message,
          code: 'TASK_CONTROL_RECEIPT_WRITE_FAILED',
          sidecar: true,
        });
        try { ack?.({ ok: false, requestId, error: message }); } catch {}
        return;
      }
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      emitAgent('agent:status', { status: 'cancelling', sidecar: true });
      const currentTarget = taskExecutionQueue.getByRequestId(executionKey, controlTargetRequestId);
      if (!currentTarget) {
        emitAgent('agent:response', {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        });
        return;
      }
      try {
        await taskExecutionQueue.cancelRequest(executionKey, controlTargetRequestId);
      } catch (error: any) {
        emitAgent('agent:error', {
          message: String(error?.message || 'Task cancellation did not settle'),
          code: 'TASK_CONTROL_CANCEL_FAILED',
          sidecar: true,
        });
        return;
      }
      emitAgent('agent:response', {
        text: CN_TASK_EXECUTION_MESSAGES.cancelled,
        agentName: 'Lumi',
        source: 'task',
        requestId,
        sidecar: true,
        finalized: true,
        blocked: false,
        reason: 'cancelled_by_user',
      });
      return;
    }

    if (previous && activeMessageRelation === 'replace') {
      void taskExecutionQueue.cancelAll(executionKey);
    }
    beginQueuedChatExecution(executionScope, requestId);
    const taskLease = taskExecutionQueue.reserve(executionKey, requestId);
    const taskAbortController = taskLease.controller;
    let releaseDesktopControlLease: (() => void) | null = null;
    const releaseTask = () => {
      releaseDesktopControlLease?.();
      releaseDesktopControlLease = null;
      taskLease.release();
    };

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
      emitAgent('agent:response', {
        text: CN_TASK_EXECUTION_MESSAGES.cancelled,
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'cancelled',
      });
      releaseTask();
      return;
    }
    const superseded = beginChatExecution(executionScope, requestId);
    if (superseded?.terminalEvent) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    markLatestUserTurn(executionScope, requestId);
    if (!acknowledged) {
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
    }
    const taskStateKey = scopedEmotionalStateKey(uid, taskScope);
    const confirmationScope = {
      source: 'task',
      taskId: requestId,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      channelId: socket.id,
    };
    if (isConfirmationCancellation(data.text)) clearPendingConfirmation(uid, confirmationScope);
    const pendingConfirmation = isExplicitConfirmationReply(data.text)
      ? getPendingConfirmation(uid, confirmationScope)
      : null;
    const pendingConfirmationPrompt = pendingConfirmation
      ? formatPendingConfirmationPrompt(pendingConfirmation)
      : '';
    const selectedConversation = data.conversationId
      ? getConversationForScope(data.conversationId, uid, taskScope.domain, taskScope.orgId)
      : null;
    const convForHistory = selectedConversation || getOrCreateActiveConversation(uid, '', taskScope.domain, taskScope.orgId);
    const taskActionBridge = buildRecentActionContinuationBridge(
      data.text,
      getMessagesByTokenBudget(convForHistory.id).slice(-24),
      convForHistory.actionContinuationState,
    );
    const routedTaskText = [data.text, taskActionBridge, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
    const interactionId = crypto.randomUUID();
    const exposeAgentWork = shouldExposeAgentWork(routedTaskText);

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
    };

    // ── Load persisted conversation history (survives page reload) ──
    const executionPipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: uid,
        text: routedTaskText,
        channel: 'task',
        source: 'task',
        category: 'command',
        operationMode: 'assistant',
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        targetIsLumi: personality.id === 'lumi',
      },
      registry: toolRegistry,
      personalityToolPolicy: personality.toolPolicy,
      actionTaskState: convForHistory.actionContinuationState,
      source: 'task',
    });
    const turnDispatch = executionPipeline.turnIntent;
    const turnFlow = turnDispatch.flow;
    const workSurfaceRoute = turnFlow.workSurfaceRoute;
    const visionIntent = turnFlow.visionIntent;
    const executionDecision = executionPipeline.execution;
    executionDecision.toolPolicy = restrictToolPolicyForExecutionBoundary(
      executionDecision.toolPolicy,
      toolSecurityContext.executionBoundary,
    );
    executionDecision.maxIterations = executionDecision.toolPolicy.maxIterations;
    executionDecision.toolRoute = restrictVisibleToolRouteForExecutionBoundary(
      executionDecision.toolRoute,
      toolSecurityContext.executionBoundary,
    );
    const modelToolProjection = buildModelToolProjection(executionDecision);
    const actionFollowupIntent = classifyConversationActionFollowupIntent(
      data.text,
      convForHistory.actionContinuationState,
    );
    const actionTaskExecution = prepareConversationActionExecution({
      conversationId: convForHistory.id,
      userId: uid,
      userText: data.text,
      requestId,
      toolPolicy: executionDecision.toolPolicy,
      forceResume: Boolean(pendingConfirmation || actionFollowupIntent === 'execute'),
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
      executionDecision.allowToolUse
      && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
    ) {
      setConversationActionExecutionStatus(convForHistory.id, uid, 'executing', { requestId });
    }
    const deferTaskModelOutput =
      executionDecision.allowToolUse
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
    if (executionDecision.toolRoute) {
      emitAgent('agent:tool_route', {
        categories: executionDecision.toolRoute.categories,
        reasons: executionDecision.toolRoute.reasons,
        toolNames: executionDecision.toolRoute.toolNames,
        totalAvailable: executionDecision.toolRoute.totalAvailable,
        truncated: executionDecision.toolRoute.truncated,
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
      effectiveSystemPrompt += '\n\n' + formatClientSelfPrompt(uid, taskScope);
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
      const recentMsgs = getMessagesByTokenBudget(convForHistory.id);
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

    const messages: NormalizedMessage[] = [
      { role: 'system', content: effectiveSystemPrompt },
      ...taskHistory,
      { role: 'user', content: routedTaskText },
    ];
    const desktopRelay = createDesktopRelay({
      io,
      userId: uid,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      source: 'task',
      taskId: requestId,
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
          getToolNames: () => toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
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
      });
      if (executionWriteback.recorded) {
        emitAgent('agent:task_execution_writeback', {
          ...executionWriteback,
          source: 'task',
        });
      }
      return executionWriteback;
    };
    let pendingConfirmationCreatedThisTurn: ReturnType<typeof recordPendingConfirmation> | null = null;
    const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
      if (
        pendingConfirmation
        && consumePendingConfirmation(
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
      if (canAutoApproveAction(toolName, args, { actionIntent: routedTaskText })) return true;
      const pending = recordPendingConfirmation(uid, toolName, args, 'task', {
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        channelId: socket.id,
        taskId: actionTaskExecution.state?.taskId,
        actionIntent: routedTaskText,
      });
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
      emitAgent('agent:response', {
        text: statusText,
        agentName: personality.name,
        source: 'task_status',
        finalized: true,
        blocked: false,
        reason: '',
      });
      addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status' });
      addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: statusText, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'task_status' });
      io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
      emitAgent('agent:status', { status: 'idle' });
      releaseTask();
      return;
    }

    if (pendingConfirmation) {
      const confirmedTask = pendingConfirmation.actionIntent || data.text;
      const confirmedArgs = pendingConfirmation.exactArgs || {};
      const confirmationRecordId =
        `task-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const consumed = consumePendingConfirmation(
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
          userId: uid,
          taskId: actionTaskExecution.state?.taskId || requestId,
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
          toolPolicy: executionDecision.toolPolicy,
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
            ...buildConfirmedStepContinuationMessages(confirmedTask, confirmationRecord),
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
          executionDecision.maxIterations || 25,
          llmGetters.getDeepSeek,
          llmGetters.getGemini,
          llmGetters.getOpenAI,
          llmGetters.getAnthropic,
          llmGetters.getQwen,
          undefined,
          {
            ...toolSecurityContext,
            userId: uid,
            domain: taskScope.domain,
            orgId: taskScope.orgId,
            desktopRelay,
            requestConfirmation,
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
            toolPolicy: executionDecision.toolPolicy,
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
      });
      emitAgent('agent:response', {
        text: finalConfirmation.text,
        agentName: personality.name,
        source: 'task_confirmation',
        finalized: true,
        blocked: finalConfirmation.blocked,
        reason: finalConfirmation.reason || '',
      });
      addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, cognitiveIntent: 'confirmation' });
      addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: finalConfirmation.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: confirmationRecords, cognitiveIntent: finalConfirmation.blocked ? 'work_product_guard' : 'confirmation' });
      persistTaskExecutionWriteback(finalConfirmation.text, confirmationRecords, `${interactionId}_confirmation`);
      if (!finalConfirmation.blocked) persistTaskLearning(finalConfirmation.text, { toolRecords: confirmationRecords, logLabel: 'task confirmation' });
      emitAgent('agent:status', { status: 'idle' });
      releaseTask();
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
        });
        const directResponseText = finalDirect.text;
        if (finalDirect.blocked && finalDirect.notification) emitAgent("agent:notification", finalDirect.notification);
        emitAgent("agent:response", {
          text: directResponseText,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: finalDirect.blocked,
          reason: finalDirect.reason,
        });
        emitAgent("agent:status", { status: "idle" });

        // Still log the interaction
        const db = readDB();
        db.interactions.push({
          id: interactionId,
          content: data.text,
          response: directResponseText,
          role: "user",
          personality: personality.id,
          timestamp: new Date().toISOString(),
          mode: 'task',
          cognitiveIntent: cognition.intent.category,
          llmWasCalled: false,
          userId: uid,
          conversationId: convForHistory.id,
          domain: taskScope.domain,
          orgId: taskScope.orgId,
        } as any);
        writeDB(db);
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId });
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: directResponseText, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: directToolRecords.length ? directToolRecords : undefined });
        persistTaskExecutionWriteback(directResponseText, directToolRecords, `${interactionId}_direct`);
        persistTaskLearning(directResponseText, {
          toolRecords: directToolRecords,
          logLabel: 'task direct cognition',
        });
        releaseTask();
        return;
      }

      // ── Orchestrator: decompose complex tasks into sub-tasks for worker agents ──
      let orchestratedText = '';
      const orchestratedToolRecords: ToolExecutionRecord[] = [];
      if (!pendingConfirmation && (cognition.intent.category === 'command' || cognition.intent.category === 'code' || cognition.intent.category === 'question')) {
        const orchestrationContext = {
          ...toolSecurityContext,
          userId: uid,
          personalityId: data.personalityId || 'lumi',
          domain: taskScope.domain,
          orgId: taskScope.orgId,
          toolPolicy: executionDecision.toolPolicy,
          rootTaskText: routedTaskText,
          taskId: actionTaskExecution.state?.taskId,
          desktopExecutionTracker,
        };
        const complexity = classifyComplexity(routedTaskText, orchestrationContext);
        const shouldOrchestrate = shouldAttemptOrchestration({
          channel: 'task',
          text: turnFlow.routeText,
          complexity,
          allowToolUse: executionDecision.allowToolUse,
          clientActionOnly: turnFlow.clientActionOnlyTurn,
          selfRepair: turnFlow.selfRepairTurn,
          artifactFirst: workSurfaceRoute.artifactFirst,
          directDesktop: workSurfaceRoute.directDesktop,
          capabilityLane: capabilitySelection.lane,
          cognitionCategory: cognition.intent.category,
        });
        if (shouldOrchestrate) {
          const db = readDB();
          const availableAgents = (db.agents || []).filter((a: any) => {
            if (a.status === 'offline' || a.status === 'terminated') return false;
            if (taskScope.domain === 'work') {
              return a.domain === 'work' && a.orgId === taskScope.orgId;
            }
            return a.domain !== 'work' && !a.orgId && (!a.ownerUid || a.ownerUid === uid);
          });
          if (availableAgents.length >= 1) {
            try {
              emitAgent("agent:status", { status: "thinking", agentName: exposeAgentWork ? "Lumi Orchestrator" : personality.name, phase: exposeAgentWork ? 'orchestrator' : 'background' });
              const scopedLlmConfig = { provider: activeProvider, model: activeModel, userId: uid, domain: taskScope.domain, orgId: taskScope.orgId, signal: taskAbortController.signal, ...reasoningRoutePolicy };
              const subTasks = await decomposeTask(data.text, scopedLlmConfig, orchestrationContext, llmGetters);
              if (exposeAgentWork && !deferTaskModelOutput) emitTask("task:chunk", { text: `[Orchestrator] Decomposed into ${subTasks.length} sub-tasks\n`, agentName: "Lumi" });

              const assignments = matchWorkers(subTasks, availableAgents);
              if (exposeAgentWork && !deferTaskModelOutput) emitTask("task:chunk", { text: `[Orchestrator] Assigned to ${assignments.length} worker(s)\n`, agentName: "Lumi" });

              const taskModelRecovery = actionTaskExecution.state?.taskId
                ? getConversationModelExecutionRecovery({
                    conversationId: convForHistory.id,
                    userId: uid,
                    taskId: actionTaskExecution.state.taskId,
                  })
                : null;
              const workflowResult = await executeWorkflow(
                assignments,
                {
                  ...orchestrationContext,
                  desktopRelay,
                  desktopExecutionTracker,
                  resumeNodeReceipts: taskModelRecovery?.receipts,
                },
                scopedLlmConfig,
                llmGetters,
                availableAgents,
                (record, meta) => {
                  emitAgent("agent:tool_call", {
                    correlationId: record.id,
                    name: record.name,
                    arguments: record.arguments,
                    result: record.result?.slice(0, 500),
                    error: record.error,
                    source: 'task',
                    worker: meta,
                  });
                  if (isTerminalOrchestrationToolEvent(record)) {
                    orchestratedToolRecords.push({ ...record, result: record.result || '' });
                  }
                },
              );
              if (actionTaskExecution.state?.taskId) {
                persistConversationModelExecutionResult({
                  conversationId: convForHistory.id,
                  userId: uid,
                  taskId: actionTaskExecution.state.taskId,
                  workflowResult,
                });
              }
              const aggregated = await aggregateWithLLM(workflowResult, data.text, scopedLlmConfig, llmGetters, uid, taskScope);
              orchestratedText = aggregated;

              const skillTags = subTasks.map(s => s.requiredSkill);
              recordWorkflowPattern(data.text, subTasks.length, skillTags, uid, taskScope.domain, taskScope.orgId);

              if (shouldDistillSkill(data.text)) {
                const skillDesc = buildSkillDescription(data.text, workflowResult);
                emitAgent("agent:proactive", {
                  type: 'distill_hint',
                  message: 'I notice this type of task is recurring. I can create an automated skill for this — would you like me to?',
                  skillDescription: skillDesc,
                  timestamp: new Date().toISOString(),
                });
              }
              if (exposeAgentWork && !deferTaskModelOutput) {
              emitTask("task:chunk", { text: `\n[Orchestrator] Workflow result ready for final validation — ${workflowResult.totalAgentsUsed} agent(s) used\n`, agentName: "Lumi" });
              }
            } catch (orchErr: any) {
              console.error('[Orchestrator] Task workflow failed, falling back to normal execution:', orchErr.message);
            }
          }
        }
      }

      if (orchestratedText) {
        const finalOrchestratedToolRecords = attachDesktopReceipt(orchestratedToolRecords);
        const finalOrchestrated = finalizeLumiResponse({
          taskText: data.text,
          responseText: orchestratedText,
          toolRecords: taskAwareRecords(finalOrchestratedToolRecords),
          source: 'task',
          flow: turnFlow,
        });
        orchestratedText = finalOrchestrated.text;
        if (finalOrchestrated.blocked) {
          if (finalOrchestrated.notification) emitAgent("agent:notification", finalOrchestrated.notification);
        }
        // Orchestrator handled the task — emit result and skip normal LLM path
        emitAgent("agent:response", {
          text: orchestratedText,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: finalOrchestrated.blocked,
          reason: finalOrchestrated.reason,
        });
        emitAgent("agent:status", { status: "idle" });
        releaseTask();

        const db = readDB();
        const conv = convForHistory;
        db.interactions.push({
          id: interactionId, content: data.text, response: orchestratedText,
          role: "user", personality: personality.id, timestamp: new Date().toISOString(),
          mode: 'task', cognitiveIntent: cognition.intent.category, llmWasCalled: true,
          userId: uid, conversationId: conv.id, domain: taskScope.domain, orgId: taskScope.orgId,
        } as any);
        writeDB(db);
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId });
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: orchestratedText, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: finalOrchestratedToolRecords.length ? finalOrchestratedToolRecords : undefined });

        // Update emotional state
        let updatedState = updateEmotionalState(emotionalState, { type: 'interaction', userId: uid, timestamp: new Date().toISOString() });
        if (isNovelTask) {
          updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: uid, timestamp: new Date().toISOString() });
        }
        saveEmotionalState(taskStateKey, updatedState);
        persistTaskExecutionWriteback(orchestratedText, finalOrchestratedToolRecords, `${interactionId}_orchestrated`);
        persistTaskLearning(orchestratedText, {
          toolRecords: finalOrchestratedToolRecords,
          logLabel: 'task orchestrated',
        });
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
        executionDecision.maxIterations || 25,
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
        { ...toolSecurityContext, userId: uid, taskId: actionTaskExecution.state?.taskId || requestId, conversationId: convForHistory.id, turnId: requestId, requestId, domain: taskScope.domain, orgId: taskScope.orgId, desktopRelay, requestConfirmation, actionIntent: routedTaskText, routedTaskText, toolPolicy: executionDecision.toolPolicy, modelToolProjection, desktopExecutionTracker, isCancelled: () => taskLease.signal.aborted, llmGetters, source: 'task', supervisedExternalCommits: true },
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
        const cancelledResponse = finalizeLumiResponse({
          taskText: data.text,
          responseText: '任务已取消。',
          toolRecords: finalTaskToolRecords,
          source: 'task',
          flow: turnFlow,
        });
        emitAgent("agent:response", {
          text: cancelledResponse.text,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: true,
          reason: 'cancelled',
        });
        emitAgent("agent:status", { status: "idle" });
        persistTaskExecutionWriteback(cancelledResponse.text, finalTaskToolRecords, `${interactionId}_cancelled`);
        persistTaskLearning(cancelledResponse.text, {
          toolRecords: finalTaskToolRecords,
          sourceInteractionId: `${interactionId}_cancelled`,
          logLabel: 'task cancelled',
        });
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
          });
      const guardRecovery = await recoverBlockedExecutionOnce({
        task: routedTaskText,
        responseText: finalTaskText,
        finalization: finalTaskResponse,
        allowToolUse: executionDecision.allowToolUse,
        pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
        aborted: taskLease.signal.aborted,
        isAborted: () => taskLease.signal.aborted,
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
            Math.max(2, Math.min(12, executionDecision.maxIterations || 8)),
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
            undefined,
            {
              ...toolSecurityContext,
              userId: uid,
              taskId: actionTaskExecution.state?.taskId || requestId,
              conversationId: convForHistory.id,
              turnId: requestId,
              requestId,
              domain: taskScope.domain,
              orgId: taskScope.orgId,
              desktopRelay,
              requestConfirmation,
              actionIntent: routedTaskText,
              routedTaskText,
              toolPolicy: executionDecision.toolPolicy,
              modelToolProjection,
              priorToolRecords,
              desktopExecutionTracker,
              isCancelled: () => taskLease.signal.aborted,
              llmGetters,
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
            }),
      });
      finalTaskResponse = guardRecovery.finalization;
      finalTaskToolRecords = attachDesktopReceipt(guardRecovery.toolRecords);
      finalTaskText = finalTaskResponse.text;
      if (finalTaskResponse.blocked) {
        if (finalTaskResponse.notification) emitAgent("agent:notification", finalTaskResponse.notification);
      }
      const holoTask = canOutputHolographic(sensory)
        ? textToHolographicOutput(finalTaskText)
        : undefined;
      emitAgent("agent:response", {
        text: finalTaskText,
        agentName: personality.name,
        holographic: holoTask,
        source: 'task',
        finalized: true,
        blocked: finalTaskResponse.blocked,
        reason: finalTaskResponse.reason,
      });
      emitAgent("agent:status", { status: "idle" });

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

      persistTaskExecutionWriteback(finalTaskText, finalTaskToolRecords);
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

      // ── Persist messages via conversation manager for cross-session continuity ──
      if (convForHistory) {
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId });
        if (finalTaskText) {
          addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: finalTaskText, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId, toolCalls: finalTaskToolRecords.length ? finalTaskToolRecords : undefined });
        }
        try {
          const topics = extractTopics(data.text + ' ' + finalTaskText);
          for (const topic of topics) trackTopic(convForHistory.id, topic);
        } catch {}
        io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
      }

    } catch (err: any) {
      if (taskLease.signal.aborted || err?.name === 'AbortError') {
        emitAgent('agent:response', {
          text: 'Task cancelled.',
          agentName: personality.name,
          finalized: true,
          blocked: true,
          reason: 'cancelled',
        });
        return;
      }
      console.error("[Agent Task Error]:", err);
      const cf = handleLLMFailure(cognition?.intent || { category: 'unknown', confidence: 0, entities: {}, needsLLM: true }, err);
      const finalFailure = finalizeLumiResponse({
        taskText: data.text,
        responseText: cf.responseText,
        toolRecords: cognition?.toolRecords
          || (cognition?.toolRecord ? [cognition.toolRecord] : []),
        source: 'task',
        flow: turnFlow,
      });
      emitAgent("agent:response", {
        text: finalFailure.text,
        agentName: personality.name,
        source: 'task',
        finalized: true,
        blocked: finalFailure.blocked,
        reason: finalFailure.reason,
      });
      emitAgent("agent:status", { status: "error" });
    } finally {
      releaseTask();
    }
  });
}



