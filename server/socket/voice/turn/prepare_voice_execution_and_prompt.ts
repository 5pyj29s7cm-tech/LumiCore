import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { logger } from "../../../../logger";
import { setConversationActionExecutionStatus, startConversationActionExecutionHeartbeat, updateConversationActionFocus, type ForegroundRequestIdentity as VoiceForegroundRequestIdentity } from "../../../conversation/manager";
import { recordChatExecutionPersistenceUnknownDurably } from "../../chat_execution_registry";
import { clearPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { isCapabilityMetaQuestion } from "../../../cognition/capability_meta";
import { toolRegistry } from "../../../tools/registry";
import { coalesceToolExecutionRecords, taskReceiptsToRecords } from "../../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../../tools/types";
import { executionBoundaryPromptOverlay, restrictSystemPromptForExecutionBoundary, restrictVisibleToolNamesForExecutionBoundary } from "../../../tools/remote_policy";
import { buildInteractionModeOverlay } from "../../../cognition/turn_flow";
import { buildVisionRoutingOverlay } from "../../../cognition/vision_routing";
import { formatCompactClientSelfPrompt } from "../../../client/self_model";
import { buildLumiRuntimeCapabilityContext } from "../../../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../../../cognition/operating_kernel";
import { getScopedPreferredLLM } from "../../../llm/user_preferences";
import { buildVoiceReplyStyleOverlay } from "../../voice_turn_policy";
import type { prepareVoiceContextAndRouting } from './prepare_voice_context_and_routing';

export async function prepareVoiceExecutionAndPrompt(context: NonNullable<Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof prepareVoiceContextAndRouting>>["resume"]>>>["context"]>) {

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
  const voiceSystemPrompt = restrictSystemPromptForExecutionBoundary(
    context.fullPersonalityPrompt,
    context.toolSecurityContext.executionBoundary,
  ) + interactionOverlay + opModeOverlay + workSurfaceOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + actionContinuationOverlay + pendingConfirmationOverlay + clientSelfPrompt + context.topicContext + dispatchOverlay + turnFlowOverlay + executionOverlay + capabilitySelectionOverlay + desktopExecutionOverlay + runtimeCapabilityOverlay + operatingKernelOverlay;

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
    provider,
    voiceModel,
    reasoningRoutePolicy,
    foregroundRequestIdentity,
    taskAwareRecords,
    voiceSystemPrompt,
  }) };
}
