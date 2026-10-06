import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { executeConfirmedChatTurn } from "../confirmation_execution";
import type { NormalizedMessage } from "../../../llm/providers";
import type { LLMResult } from "../../../llm/adapter";
import { createPreFinalizationTextGate, shouldDeferModelOutputUntilFinalized } from "../../../cognition/response_delivery";
import { extractSentiment } from "../../../cognition/sentiment";
import type { prepareChatRuntimeControlAndModel } from './prepare_chat_runtime_control_and_model';

export async function prepareChatModelState(context: NonNullable<Awaited<ReturnType<typeof prepareChatRuntimeControlAndModel>>["context"]>) {

      if (context.pendingConfirmation) { await executeConfirmedChatTurn(context); { return { terminal: true as const, context: undefined }; } }

      let responseText = '';
      let completionGuard: LLMResult['completionGuard'];
      let llmWasCalled = false;
      const allToolRecords = context.requestToolRecords;
      // Keep the same token-budgeted conversation that drove the normal turn
      // available to the one-shot execution recovery. Falling back to only the
      // latest task makes the recovery model forget constraints and prior user
      // corrections precisely when it needs them most.
      let normalTurnMessages: NormalizedMessage[] = [];
      // ── Model-owned natural-language dispatch ──
      // Natural-language chat has no deterministic quick-command path. Surface
      // recognition and legacy quick matches are advisory inputs to the shared
      // model/tool loop; structured UI events use their dedicated handlers.
      context.abortController.signal.throwIfAborted();
      context.turnAuthorization.assertCurrent();
      // ── Sentiment analysis: detect emotional charge in user input ──
      const sentiment = extractSentiment(context.text);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        console.log('[ChatHandler] sentiment:', sentiment);
      }

      // Auto-select model: flash for simple chat, pro for complex tasks
      console.log('[ChatHandler] Using exact configured reasoning model:', context.activeProvider, '/', context.activeModel);

      const deferCompletionStream = shouldDeferModelOutputUntilFinalized({
        taskText: context.executionTaskText,
        allowToolUse: context.toolSessionActive,
        flow: context.turnFlow,
      });
      const chatTextGate = createPreFinalizationTextGate();
  return { terminal: false as const, context: extendTurnBindings(context, {
    get responseText(): typeof responseText { return responseText; },
    set responseText(value: typeof responseText) { responseText = value; },
    get normalTurnMessages(): typeof normalTurnMessages { return normalTurnMessages; },
    set normalTurnMessages(value: typeof normalTurnMessages) { normalTurnMessages = value; },
    deferCompletionStream,
    chatTextGate,
    get completionGuard(): typeof completionGuard { return completionGuard; },
    set completionGuard(value: typeof completionGuard) { completionGuard = value; },
    get llmWasCalled(): typeof llmWasCalled { return llmWasCalled; },
    set llmWasCalled(value: typeof llmWasCalled) { llmWasCalled = value; },
    allToolRecords,
    sentiment,
  }) };
}
