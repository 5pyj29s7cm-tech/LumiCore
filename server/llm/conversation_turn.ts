import {
  makeLLMCallStreaming,
  type NormalizedMessage,
  type StreamCallback,
} from './providers';
import type { LLMConfig, LLMResult, LLMUsageRecord } from './adapter';
import type { LLMGetters } from './dispatch';
import type { NormalizedLLMResponse } from '../tools/types';
import { resolveConversationModelConfig } from './conversation_profile';
import { createModelTurnState } from './model_turn_state';
import {
  getExplicitSentenceCountConstraint,
  sentenceCountCorrectionInstruction,
} from '../cognition/response_constraints';
import {
  CN_STREAM_INTERRUPTION_RECOVERY_INSTRUCTION,
  formatConversationIncompleteMessage,
} from '../i18n/response_recovery_messages';

export interface ConversationTurnInput {
  messages: NormalizedMessage[];
  config: LLMConfig;
  getters: Pick<LLMGetters, 'getDeepSeek' | 'getGemini'> & Partial<LLMGetters>;
  onChunk?: StreamCallback;
  isCancelled?: () => boolean;
  /** Revalidate the original owner/conversation before every provider call. */
  assertCurrent?: () => void;
  taskText?: string;
}

export interface ConversationTurnResult extends LLMResult {
  completion: 'complete' | 'incomplete';
  corrected: boolean;
}

/**
 * Text and voice use the same no-tool response policy. Only the first draft
 * streams to the caller; at most one complete replacement is then selected.
 * This helper never authorizes or dispatches tools.
 */
export async function runConversationTurn(input: ConversationTurnInput): Promise<ConversationTurnResult> {
  const { getters } = input;
  const usageRecords: LLMUsageRecord[] = [];
  const userContent = [...input.messages].reverse().find(message => message.role === 'user')?.content;
  const taskText = input.taskText ?? (Array.isArray(userContent)
    ? userContent.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    : String(userContent || ''));
  const config = resolveConversationModelConfig(taskText, {
    ...input.config,
    modelTurnState: input.config.modelTurnState ?? createModelTurnState(),
  });
  const assertActive = () => {
    if (config.signal?.aborted || input.isCancelled?.()) {
      throw new DOMException('Conversation turn cancelled', 'AbortError');
    }
    input.assertCurrent?.();
  };
  const recordUsage = (response: NormalizedLLMResponse) => {
    if (!response.usage) return;
    usageRecords.push({
      provider: response.routing?.selectedProvider || config.provider,
      model: response.routing?.selectedModel || config.model,
      requestedProvider: response.routing?.requestedProvider,
      requestedModel: response.routing?.requestedModel,
      selectionMode: response.routing?.selectionMode,
      fallbackReason: response.routing?.fallbackReason,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    });
  };
  const callModel = async (messages: NormalizedMessage[], onChunk: StreamCallback) => {
    assertActive();
    const response = await makeLLMCallStreaming(
      messages, [], config, chunk => {
        if (config.signal?.aborted || input.isCancelled?.()) return;
        onChunk(chunk);
      },
      getters.getDeepSeek, getters.getGemini, getters.getOpenAI,
      getters.getAnthropic, getters.getQwen, getters.getOllama,
      getters.getLmStudio, getters.getArk, getters.getXiaomi,
      getters.getKimi, getters.getGlm, getters.getRelay,
    );
    recordUsage(response);
    assertActive();
    return response;
  };
  const isComplete = (response: NormalizedLLMResponse, text: string) => {
    const constraint = getExplicitSentenceCountConstraint(taskText, text);
    return Boolean(text.trim())
      && !response.streamIncomplete
      && !response.toolCalls?.length
      && (!constraint || constraint.actual === constraint.expected);
  };
  const incomplete = (reason: string): ConversationTurnResult => {
    const text = formatConversationIncompleteMessage(taskText);
    return {
      text,
      toolCalls: [],
      usageRecords,
      completion: 'incomplete',
      corrected: false,
      completionGuard: { text, blocked: true, reason },
    };
  };

  const response = await callModel(input.messages, chunk => {
    input.onChunk?.(chunk);
  });
  // Streamed preview is not a terminal provider result. In particular, a
  // cancelled/empty result must never become complete from leftover chunks.
  const firstText = String(response.text || '').trim();
  if (isComplete(response, firstText)) {
    return { text: firstText, toolCalls: [], usageRecords, completion: 'complete', corrected: false };
  }

  const sentenceConstraint = getExplicitSentenceCountConstraint(taskText, firstText);
  const recoveryInstruction = sentenceConstraint && sentenceConstraint.actual !== sentenceConstraint.expected
    ? sentenceCountCorrectionInstruction(sentenceConstraint.expected)
    : CN_STREAM_INTERRUPTION_RECOVERY_INSTRUCTION;
  assertActive();
  let corrected: NormalizedLLMResponse;
  try {
    corrected = await callModel([
      ...input.messages,
      ...(firstText ? [{ role: 'assistant' as const, content: firstText }] : []),
      { role: 'user', content: recoveryInstruction },
    ], () => {});
  } catch (error) {
    // Revoked ownership and cancellation must reach the transport's durable
    // cancellation boundary. An ordinary repair failure retains usage already
    // incurred and cannot turn the initial incomplete draft into success.
    assertActive();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return incomplete('conversation_repair_failed');
  }
  const correctedText = String(corrected.text || '').trim();
  if (!isComplete(corrected, correctedText)) return incomplete('conversation_response_incomplete');
  return { text: correctedText, toolCalls: [], usageRecords, completion: 'complete', corrected: true };
}
