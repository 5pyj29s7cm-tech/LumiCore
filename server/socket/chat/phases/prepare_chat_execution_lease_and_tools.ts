import { extendTurnBindings } from "../../../cognition/turn_bindings";
import type { ToolExecutionRecord, ToolContext } from "../../../tools/types";
import { buildInteractionModeOverlay } from "../../../cognition/turn_flow";
import { withDesktopExecutionReceipt } from "../../../desktop/execution_runtime";
import { executionBoundaryPromptOverlay, restrictVisibleToolNamesForExecutionBoundary } from "../../../tools/remote_policy";
import { buildLumiOperatingKernelPrompt } from "../../../cognition/operating_kernel";
import { startConversationActionExecutionHeartbeat } from "../../../conversation/manager";
import { buildDurableTaskDeterministicToolRecoveryCall, buildStructuredMediaDeterministicToolRecoveryCall } from "../../../cognition/deterministic_tool_recovery";
import { coalesceToolExecutionRecords, taskReceiptsToRecords } from "../../../cognition/task_execution_ledger";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { buildVisionRoutingOverlay } from "../../../cognition/vision_routing";
import { createDesktopRelay } from "../../desktop_relay";
import { createConversationReceiptObserver } from "../../../conversation/execution_receipt_archive";
import { recordChatExecutionPersistenceUnknownDurably } from "../../chat_execution_registry";
import { bindPreparedTaskMessageRelation } from "../../../cognition/task_concurrency";
import type { prepareChatTerminalWriters } from './prepare_chat_terminal_writers';
import { chatDurabilityUnknownText } from './shared';

export async function prepareChatExecutionLeaseAndTools(context: NonNullable<Awaited<ReturnType<typeof prepareChatTerminalWriters>>["context"]>) {

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
      console.log('[ChatHandler] tool gate:', context.executionDecision.allowToolUse ? 'authorized' : 'off', 'session:', context.toolSessionActive ? 'active' : 'conversation', 'operationMode:', context.operationMode, 'effective:', context.effectiveOperationMode, 'surface:', context.turnFlow.surface, 'clientActionOnly:', context.clientActionOnlyTurn, 'selfRepair:', context.selfRepairTurn, 'capabilityLane:', context.capabilitySelection.lane, 'trace:', context.intentTrace.summary, 'route:', context.toolRoute ? `${context.toolRoute.toolNames.length}/${context.toolRoute.totalAvailable} ${context.toolRoute.categories.join(',') || 'fallback'}` : 'none');
      if (context.turnAuthorization.isCurrent()) context.socket.emit('agent:intent_trace', context.intentTrace);
      if (context.toolRoute && context.turnAuthorization.isCurrent()) {
        context.socket.emit('agent:tool_route', {
          requestId: context.requestId,
          conversationId: context.conversationId,
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
    durableTaskId,
    taskAwareRecords,
    toolContext,
    priorTaskRecords,
    desktopRelay,
  }) };
}
