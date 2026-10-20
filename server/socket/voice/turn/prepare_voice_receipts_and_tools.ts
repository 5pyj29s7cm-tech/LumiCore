import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { createToolLifecycleCallbacks, type ToolLifecyclePayload } from "../../tool_lifecycle";
import { inferPhase, projectCustomerVisibleExecutionEvent } from "../../public_agent_event_projection";
import { logger } from "../../../../logger";
import { setConversationActionExecutionStatus } from "../../../conversation/manager";
import { formatPendingConfirmationRequest, type recordPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { emitVoiceWorkProgress } from "../work_progress";
import { toolRegistry } from "../../../tools/registry";
import { VOICE_DESKTOP_LEASE_WAIT_MS } from "../../voice_runtime_policy";
import type { ToolExecutionRecord, ToolContext } from "../../../tools/types";
import { scheduleConversationSummary } from "../../../conversation/summary_scheduler";
import { createConversationReceiptObserver } from "../../../conversation/execution_receipt_archive";
import { createDesktopRelay } from "../../desktop_relay";
import { buildDurableTaskDeterministicToolRecoveryCall } from "../../../cognition/deterministic_tool_recovery";
import { createTurnConfirmation } from "../../../tools/turn_confirmation";
import { createPreFinalizationTextGate, shouldDeferModelOutputUntilFinalized, shouldForwardPreFinalizationProgress } from "../../../cognition/response_delivery";
import { loadEmotionalState } from "../../../personality/state";
import type { LLMResult } from "../../../llm/adapter";
import { persistLumiPostTurnLearning } from "../../../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../../../work_takeover/execution_writeback";
import type { prepareVoiceExecutionAndPrompt } from './prepare_voice_execution_and_prompt';

export async function prepareVoiceReceiptsAndTools(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceExecutionAndPrompt>>["context"]>) {

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
    phase?: ToolLifecyclePayload['phase'];
  }) => {
    if (context.session.isBackgroundWork) {
      const phase = inferPhase(payload);
      context.session.activeWorkStatus = phase === 'waiting_confirmation' ? 'waiting_confirmation' : 'executing';
      context.session.activeWorkStep = projectCustomerVisibleExecutionEvent('agent:tool', payload, { taskText: context.session.activeTurnText }).publicText || '';
      if (payload.result !== undefined || payload.error !== undefined) context.session.activeWorkToolCalls++;
      emitVoiceWorkProgress(context.socket, context.session, context.requestId,
        phase === 'completed' ? 'step_completed' : phase === 'working' ? 'executing'
          : phase === 'waiting_confirmation' ? 'waiting_confirmation' : 'blocked');
    }
    const normalized = { ...payload, args: payload.arguments, source: 'voice' };
    context.emitAgent("agent:tool_call", normalized);
    context.emitAgent("agent:tool", normalized);
  };

  let receiptObserver = createConversationReceiptObserver({
    userId: context.session.userId, conversationId: context.conversationTurn.conversation.id,
    taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId, turnRowId: context.actionTaskExecution.turnRowId, ...context.voiceScope,
  }, context.turnAuthorization.isCurrent);
  const createTurnDesktopRelay = () => createDesktopRelay({
    io: context.io,
    userId: context.session.userId,
    domain: context.voiceScope.domain,
    orgId: context.voiceScope.orgId,
    source: 'voice',
    taskId: context.actionTaskExecution.state?.taskId,
    requestId: context.requestId,
    requestSocket: context.socket,
    emitToolLifecycle,
    onLateResult: event => receiptObserver.onDesktopLateResult(event),
    formatResultForLifecycle: formatToolResultForUi,
    cancelOnRequestSocketDisconnect: true,
    signal: context.pipelineAbort.signal,
    leaseTimeoutMs: VOICE_DESKTOP_LEASE_WAIT_MS,
  });

  let desktopRelay = createTurnDesktopRelay();
  const prepareSelectedToolCall: NonNullable<ToolContext['prepareSelectedToolCall']> = async () => {
    context.turnAuthorization.assertCurrent();
    context.pipelineAbort.signal.throwIfAborted();
    const owner = context.actionTaskExecution.prepareSelectedToolCall;
    if (!owner) throw new Error('The selected tool has no accepted audit owner.');
    const neededBinding = !context.actionTaskExecution.state?.taskId;
    const binding = await owner(context.pipelineAbort.signal);
    if (neededBinding) {
      context.foregroundRequestIdentity = Object.freeze({ ...context.foregroundRequestIdentity, expectedTaskId: binding.taskId });
      context.session.activeForegroundRequestIdentity = context.foregroundRequestIdentity;
      context.executionReceipts.bindTask(binding.taskId);
      context.session.activeTaskConversationId = context.conversationTurn.conversation.id;
      context.session.activeTaskRequestId = context.requestId;
      context.session.activeTaskId = binding.taskId;
      receiptObserver = createConversationReceiptObserver({ userId: context.session.userId,
        conversationId: context.conversationTurn.conversation.id, taskId: binding.taskId, requestId: context.requestId,
        turnRowId: binding.turnRowId, ...context.voiceScope,
      }, context.turnAuthorization.isCurrent);
      desktopRelay = createTurnDesktopRelay();
      toolContext.desktopRelay = desktopRelay;
    }
    context.turnAuthorization.assertCurrent();
    return { ...binding, desktopRelay };
  };
  const runtimeOwnedDeterministicRecoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
    context.actionTaskExecution.state,
    context.requestId,
    context.confirmationResolution.revokedCorrectionBasis,
  );
  let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
  const requestConfirmation = createTurnConfirmation({
    userId: context.session.userId, source: 'voice', requestId: context.requestId, actionIntent: context.actionIntentText,
    autoApprovalIntent: context.routedUserText,
    allowLocalFileWrites: context.allowLocalFileWrites,
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
    prepareSelectedToolCall,
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
    turnEmotionState,
    deferCompletionSpeech,
    get responseText(): typeof responseText { return responseText; },
    set responseText(value: typeof responseText) { responseText = value; },
    ttsPromises,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    persistSidecarConversation,
    persistVoiceAssistantMessage,
    scheduleVoiceSummary,
    get desktopRelay() { return desktopRelay; },
    emitToolLifecycle,
    toolContext,
    formatToolResultForUi,
    observeVoiceTools,
    get completionGuard(): typeof completionGuard { return completionGuard; },
    set completionGuard(value: typeof completionGuard) { completionGuard = value; },
    persistVoiceLearning,
    persistVoiceTakeoverExecution,
    modelTextGate,
    get toolResults(): typeof toolResults { return toolResults; },
    set toolResults(value: typeof toolResults) { toolResults = value; },
    maxIterations,
    runtimeOwnedDeterministicRecoveryCall,
  }) };
}
