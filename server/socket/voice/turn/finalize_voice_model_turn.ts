import { runResolvedLumiRecovery } from "../../../cognition/turn_recovery";
import { logger } from "../../../../logger";
import { extractTopics, trackTopic } from "../../../conversation/manager";
import { finalizeLumiResponseForDelivery } from "../../../cognition/response_delivery";
import { toolRegistry } from "../../../tools/registry";
import { withDesktopExecutionReceipt } from "../../../desktop/execution_runtime";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../../../personality/state";
import { recordTokenUsageBatch } from "../../../llm/token_tracker";

import { createTurnResponseFinalizer } from "../../../cognition/turn_response_finalizer";
import { extractSentiment } from "../../../cognition/sentiment";
import { himTick } from "../../../personality/him";
import type { executeVoiceModelTurn } from './execute_voice_model_turn';

export async function finalizeVoiceModelTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceModelTurn>>["context"]>) {

    const responseFinalizer = createTurnResponseFinalizer({
      taskText: context.actionIntentText, flow: context.turnFlow, taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      pendingConfirmation: () => context.pendingConfirmationCreatedThisTurn,
      controlPauseReason: () => context.desktopRelay.getControlPauseReason(), pauseTaskText: context.routedUserText,
    });
    const desktopPauseBlocksCurrentTask = (records = context.taskAwareRecords(context.toolResults)) => responseFinalizer.isDesktopPaused(records);
    let finalResponse = responseFinalizer.finalize({
      responseText: context.responseText, completionGuard: context.completionGuard, toolRecords: context.taskAwareRecords(context.toolResults), source: 'voice',
    });
    const guardRecovery = await finalizeLumiResponseForDelivery({
      taskText: context.routedUserText, source: 'voice',
      responseText: context.responseText,
      initialFinalization: finalResponse,
      allowToolUse: context.toolSessionActive,
      pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
      requiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
      aborted: !context.isCurrentTurn() || desktopPauseBlocksCurrentTask(),
      // Losing the current voice turn is cancellation. A desktop pause is a
      // resumable customer-visible state and must not become AbortError.
      isAborted: () => !context.isCurrentTurn(),
      isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
        trustedConfirmationRequestText: responseFinalizer.confirmationRequestText,
      toolRecords: context.taskAwareRecords(context.toolResults),
      attempt: async attempt => {
        logger.warn('[Audio] Recovering blocked execution internally.');
          context.turnAuthorization.assertCurrent();
      const recoveryLifecycle = context.observeVoiceTools();
      const recovery = await runResolvedLumiRecovery({
        responseText: context.responseText, recovery: attempt,
        model: {
      execution: context.executionPipeline,
        messages: context.recoveryConversationMessages,
        registry: toolRegistry,
        config: {
            provider: context.provider,
            model: context.effectiveModel,
            modelTurnState: context.modelTurnState,
            userId: context.session.userId,
            domain: context.voiceScope.domain,
            orgId: context.voiceScope.orgId,
            signal: context.pipelineAbort.signal,
            inputTokenBudget: context.voiceInputTokenBudget,
            ...context.reasoningRoutePolicy,
          },
        onToolCall: recoveryLifecycle.onToolCall,
        maxIterations: Math.max(2, Math.min(12, context.routedToolPolicy.maxIterations || context.maxIterations || 8)),
        context: {
            ...context.toolContext,
            ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
            source: 'voice_guard_recovery',
            isCancelled: () => !context.isCurrentTurn(),
            onToolStart: recoveryLifecycle.onToolStart,
          },
        getters: context.llmGetters,
        },
      });
        recordTokenUsageBatch(context.session.userId, recovery.usageRecords, () => `voice_guard_recovery_${Date.now()}`, 'voice');
        return {
          ...recovery,
          toolRecords: withDesktopExecutionReceipt(recovery.toolRecords || [], context.desktopExecutionTracker),
        };
      },
      refinalize: (candidateText, records, recoveryCompletionGuard) => {
        const recoveredRecords = context.taskAwareRecords(records);
        return responseFinalizer.finalize({
          responseText: candidateText, completionGuard: recoveryCompletionGuard,
          toolRecords: recoveredRecords, source: 'voice_guard_recovery',
        });
      },
    });
    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }
    finalResponse = guardRecovery.finalization;
    context.toolResults = withDesktopExecutionReceipt(guardRecovery.toolRecords, context.desktopExecutionTracker);
    context.responseText = finalResponse.text;
    if (finalResponse.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${finalResponse.reason}`);
    }

    let mainTerminalCommitted = false;
    if (context.responseText) {
      logger.info(`[Audio] Response: "${context.responseText.slice(0, 80)}" (${context.toolResults.length} tool calls)`);
      mainTerminalCommitted = await context.finishVoiceTerminal({
        text: context.responseText,
        source: "voice",
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
        cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : context.executionPipeline.normalizedIntent.kind,
        llmWasCalled: true,
        toolCalls: context.toolResults,
        speechText: context.responseText,
        notification: finalResponse.notification,
        persistTerminalState: () => {
          // commitVoiceTerminal consumes the receipts and blocks the task in
          // the same assistant write. Releasing the lease here would classify
          // these current receipts as stale and lose cross-channel progress.
          return context.persistVoiceTakeoverExecution(context.responseText, {
            toolRecords: context.toolResults,
            source: 'voice',
            sourceInteractionId: `voice_main_${Date.now()}`,
            finalizationBlocked: finalResponse.blocked,
            assistantTextTrusted: !finalResponse.blocked,
            finalizationReason: finalResponse.reason,
          });
        },
      });
    } else {
      await Promise.allSettled(context.ttsPromises);
    }

    // Candidate model text is never spoken before the strict
    // database and terminal-receipt fences have both committed.
    if (!context.isCurrentTurn()) { return { terminal: true as const, context: undefined }; }

    // The user, assistant, task writeback, and terminal receipt committed
    // before TTS. Playback or
    // disconnect failures must never make a completed/blocked task disappear.
    // Topic tracking — extract and record topics for cross-session continuity
    if (!finalResponse.blocked) {
      try {
        const topics = extractTopics(context.userText + ' ' + context.responseText);
        for (const topic of topics) {
          trackTopic(context.conversationTurn.conversation.id, topic);
        }
      } catch {}
    }
    // Text sentiment analysis on user input (matching chat.ts behavior)
    const textSentiment = extractSentiment(context.userText);
    if (textSentiment.valence !== 0 || textSentiment.urgency > 0 || textSentiment.frustration > 0) {
      try {
        const es = loadEmotionalState(context.voiceStateKey);
        const updated = updateEmotionalState(es, {
          type: 'sentiment_analysis',
          timestamp: new Date().toISOString(),
          userId: context.session.userId,
          sentiment: {
            valence: textSentiment.valence,
            frustration: textSentiment.frustration,
            urgency: textSentiment.urgency,
          },
        });
        saveEmotionalState(context.voiceStateKey, updated);
        try { const hm = loadHIMState(context.voiceStateKey); const { him: nh } = himTick(updated, hm); saveHIMState(context.voiceStateKey, nh); } catch {}
      } catch { /* best-effort */ }
    }
    if (mainTerminalCommitted && !finalResponse.blocked) {
      context.persistVoiceLearning(context.responseText, { toolRecords: context.toolResults, logLabel: 'voice' });
    }
  return { terminal: false as const, context };
}
