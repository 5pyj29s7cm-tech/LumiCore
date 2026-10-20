import { preparePlannedConversationExecution } from "../../../conversation/planned_execution";
import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { buildRecentFailureExplanation } from "../history";
import { createTurnConfirmation } from "../../../tools/turn_confirmation";
import { flushDBOrThrow } from "../../../../db_layer";
import type { ToolExecutionRecord, ToolContext } from "../../../tools/types";
import type { MediaArtifactReceipt } from "../../media_artifact_receipt";
import { toolRegistry } from "../../../tools/registry";
import { buildOperationModeMetaResponse } from "../../../cognition/capability_meta";
import type { buildLumiCapabilitySelection } from "../../../cognition/capability_selection";
import { buildDesktopExecutionStabilityPolicy } from "../../../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker } from "../../../desktop/execution_runtime";
import { persistLumiPostTurnLearning } from "../../../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../../../work_takeover/execution_writeback";
import { buildTransportNeutralConfirmationScope, formatPendingConfirmationRequest, type recordPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { updateAssistantMessageTerminalPresentation, getMessages, getConversationActionStatus, setConversationActionExecutionStatus } from "../../../conversation/manager";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../../../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../../../conversation/exact_correction";
import { recordChatExecutionPersistenceUnknownDurably } from "../../chat_execution_registry";
import { commitChatTerminalBoundary } from "../../chat_terminal_boundary";
import type { ActiveTaskMessageResolution } from "../../../cognition/task_concurrency";
import type { prepareChatConversationContext } from './prepare_chat_conversation_context';

export async function prepareChatTerminalWriters(context: NonNullable<Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof prepareChatConversationContext>>["resume"]>>>["context"]>) {

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
        allowLocalFileWrites: context.allowLocalFileWrites,
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
        actionIntent: context.executionPipeline.normalizedIntent,
        taskId: context.executionPipeline.taskRelation.taskId || context.requestId,
      });
      const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
      const toolRoute = executionDecision.toolRoute;
      const modelCapabilityPolicy = context.executionPipeline.authorizationPolicy;
      const modelToolProjection = context.executionPipeline.modelToolProjection;
      const toolSessionActive = !context.isMemoryAvatar && context.executionPipeline.executionRequested;
      const actionTaskExecution = preparePlannedConversationExecution({
        execution: context.executionPipeline, conversationId: context.conversationId,
        bindConversationTurn: true,
        userId: context.uid, userText: context.visibleUserText, requestId: context.requestId, userMessageId: context.acceptedUserMessageId,
        pendingConfirmation: context.pendingConfirmation,
        acceptedRuntimeCleanup: Boolean(context.acceptedRuntimeCleanupOffer && context.conversationId),
      });
  return { terminal: false as const, context: extendTurnBindings(context, {
    actionTaskExecution,
    get runtimeOwnedDeterministicRecoveryCall(): typeof runtimeOwnedDeterministicRecoveryCall { return runtimeOwnedDeterministicRecoveryCall; },
    set runtimeOwnedDeterministicRecoveryCall(value: typeof runtimeOwnedDeterministicRecoveryCall) { runtimeOwnedDeterministicRecoveryCall = value; },
    emitToolLifecycle,
    modelCapabilityPolicy,
    modelToolProjection,
    desktopExecutionTracker,
    toolSessionActive,
    executionDecision,
    effectiveOperationMode,
    clientActionOnlyTurn,
    selfRepairTurn,
    capabilitySelection,
    intentTrace,
    toolRoute,
    desktopExecutionPolicy,
    workSurfaceRoute,
    requestToolConfirmation,
    commitRecordedTerminal,
    persistChatTakeoverExecution,
    interactionId,
    refreshTerminalPayloadTaskRelation,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    get pendingConfirmationAssistantState(): typeof pendingConfirmationAssistantState { return pendingConfirmationAssistantState; },
    set pendingConfirmationAssistantState(value: typeof pendingConfirmationAssistantState) { pendingConfirmationAssistantState = value; },
    persistChatLearning,
    visionIntent,
  }) };
}
