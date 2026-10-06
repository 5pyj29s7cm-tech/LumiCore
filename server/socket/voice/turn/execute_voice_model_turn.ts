import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { logger } from "../../../../logger";
import { getMessagesByTokenBudget } from "../../../conversation/manager";
import { markVoiceLatencyMilestone } from "../../../monitor/voice_latency_store";
import { toolRegistry } from "../../../tools/registry";
import { withDesktopExecutionReceipt } from "../../../desktop/execution_runtime";
import type { LLMConfig } from "../../../llm/adapter";
import { recordTokenUsageBatch } from "../../../llm/token_tracker";
import type { NormalizedMessage } from "../../../llm/providers";
import { normalizeVoiceHistory } from "../../voice_history";
import { runLumiTurn } from "../../../llm/lumi_turn";
import type { executeVoiceModeAndMessagingTurn } from './execute_voice_mode_and_messaging_turn';

export async function executeVoiceModelTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceModeAndMessagingTurn>>["context"]>) {


    // Reuse the configured model and the shared execution decision.
    const effectiveModel = context.voiceModel;
    logger.info(`[Audio] Intent: ${context.executionPipeline.normalizedIntent.kind}, model: ${effectiveModel}`);

    // The shared loop and any bounded recovery receive the same persisted
    // conversation, including both user and assistant messages with their roles.
    const recentMsgs = getMessagesByTokenBudget(context.conversationTurn.conversation.id, 6_000, 6, context.requestId).filter(message => !(
      message.role === 'user' && message.externalMessageId === context.requestId
    ));
    const voiceHistory: NormalizedMessage[] = normalizeVoiceHistory(recentMsgs);
    const historyChars = voiceHistory.reduce((total, message) => (
      total + (typeof message.content === 'string' ? message.content.length : 0)
    ), 0);
    logger.info(`[Audio] Prompt budget request=${context.requestId} systemChars=${context.voiceSystemPrompt.length} historyMessages=${voiceHistory.length} historyChars=${historyChars}`);

    const messages: NormalizedMessage[] = [
      { role: 'system', content: context.voiceSystemPrompt },
      ...voiceHistory,
      { role: 'user', content: context.userText, sourceMessageId: context.voiceUserMessageId },
    ];
    const recoveryConversationMessages = messages;

    const modelConfig: LLMConfig = {
      modelTurnState: context.modelTurnState,
      provider: context.provider,
      model: effectiveModel,
      userId: context.session.userId,
      domain: context.voiceScope.domain,
      orgId: context.voiceScope.orgId,
      conversationId: context.conversationTurn.conversation.id,
      requestId: context.requestId,
      source: 'voice',
      signal: context.pipelineAbort.signal,
      inputTokenBudget: context.voiceInputTokenBudget,
      ...context.reasoningRoutePolicy,
    };
    const onChunk = (chunk: string) => {
      if (!context.isCurrentTurn()) return;
      if (chunk) markVoiceLatencyMilestone(context.requestId, 'firstModelTokenAt');
      context.responseText += chunk;
      context.maybeStartSpeculativeSpeech();
      if (!context.deferCompletionSpeech) {
        const safeText = context.modelTextGate.push(chunk);
        if (safeText) context.emitAgent('agent:chunk', { text: safeText, agentName: 'Lumi' });
      }
    };
    context.turnAuthorization.assertCurrent();
    // Both transports use the same execution loop and conversational recovery.
    // Voice owns recognition, speech and presentation; it cannot independently
    // decide to repeat a tool, end an unfinished task or discard a receipt.
    markVoiceLatencyMilestone(context.requestId, 'firstModelRequestAt');
    const toolLifecycle = context.observeVoiceTools(record => context.toolResults.push(record));
    const result = context.toolSessionActive
      ? await runLumiTurn({
        messages: messages,
        registry: toolRegistry,
        config: modelConfig,
        onToolCall: toolLifecycle.onToolCall,
        maxIterations: context.maxIterations,
        onStreamChunk: onChunk,
        context: {
            ...context.toolContext,
            ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
            priorToolRecords: context.taskAwareRecords(context.toolResults),
            onToolStart: toolLifecycle.onToolStart,
          },
        getters: context.llmGetters,
      })
      : await runLumiTurn({
          messages,
          config: modelConfig,
          onChunk,
          getters: context.llmGetters,
          isCancelled: () => !context.isCurrentTurn(),
          assertCurrent: () => context.turnAuthorization.assertCurrent(),
          taskText: context.userText,
        });
    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }
    context.responseText = result.text || '';
    context.completionGuard = result.completionGuard;
    recordTokenUsageBatch(context.session.userId, result.usageRecords, context.requestId, 'voice');

    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }

    if (context.pendingConfirmationCreatedThisTurn) {
      context.responseText = context.trustedVoiceConfirmationText!;
    }

    context.modelTextGate.finish();
    const finalizedDesktopRecords = withDesktopExecutionReceipt(context.toolResults, context.desktopExecutionTracker);
    if (finalizedDesktopRecords.length > context.toolResults.length) {
      context.toolResults.push(...finalizedDesktopRecords.slice(context.toolResults.length));
    }
  return { terminal: false as const, context: extendTurnBindings(context, {
    recoveryConversationMessages: recoveryConversationMessages as typeof recoveryConversationMessages,
    effectiveModel: effectiveModel as typeof effectiveModel,
  }) };
}
