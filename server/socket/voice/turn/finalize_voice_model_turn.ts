import { logger } from "../../../../logger";
import { extractTopics, trackTopic } from "../../../conversation/manager";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../../../personality/state";

import { extractSentiment } from "../../../cognition/sentiment";
import { himTick } from "../../../personality/him";
import type { executeVoiceModeAndMessagingTurn } from './execute_voice_mode_and_messaging_turn';
import type { ExecutedLumiTurn } from '../../../cognition/turn_execution';

export async function finalizeVoiceModelTurn(context: NonNullable<Awaited<ReturnType<typeof executeVoiceModeAndMessagingTurn>>["context"]>, completed: ExecutedLumiTurn) {

    if (!context.isCurrentTurn()) return { terminal: true as const, context: undefined };
    context.responseText = completed.finalized.text;
    context.toolResults = completed.toolRecords;
    const finalResponse = completed.finalized;
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
