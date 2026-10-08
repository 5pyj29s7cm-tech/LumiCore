import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { resolveModelRequestInputBudget } from "../../../llm/request_context_budget";
import { toolRegistry } from "../../../tools/registry";
import { executeToolCall } from "../../../tools/execution_engine";
import { buildForegroundTaskCompletionFeedback } from "../../../cognition/acceptance_evidence";
import { formatRuntimeCleanupReceipt } from "../../../regions/messages/runtime_cleanup_messages";
import { addMessage } from "../../../conversation/manager";
import { scheduleConversationSummary } from "../../../conversation/summary_scheduler";
import { summarizeToolRecordForPersistence } from "../../../cognition/tool_record_status";
import { buildResponseLanguageInstruction } from "../../../utils/language";
import { getScopedPreferredLLM } from "../../../llm/user_preferences";
import type { prepareChatExecutionLeaseAndTools } from './prepare_chat_execution_lease_and_tools';
import { chatDurabilityUnknownText } from './shared';

export async function prepareChatRuntimeControlAndModel(context: NonNullable<Awaited<ReturnType<typeof prepareChatExecutionLeaseAndTools>>["context"]>) {

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
              finalization: { blocked: !cleanupVerified,
              reason: cleanupVerified ? '' : cleanupRecord.error
                || cleanupRecord.terminalVerification?.reason
                || cleanupReason },
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
    reasoningRoutePolicy,
    scheduleChatSummary,
  }) };
}
