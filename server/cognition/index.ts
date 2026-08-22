/**
 * Lumi Cognitive Engine — the independent decision-making layer.
 *
 * This engine sits BETWEEN the socket handlers and the LLM. It:
 * 1. Preserves legacy deterministic classifications as read-only hints
 * 2. Passes response/action ownership to the shared model capability loop
 * 3. Falls back to a transport-safe response only after model recovery fails
 *
 * Architecture:
 *   User Input → [advisory cognition] → Model + capability manifest → Response
 */

import { classifyIntent, classifyIntentLLM, extractSentiment, IntentResult, SentimentResult } from './intent';
import { generateFallback, isLLMDown } from './fallback';
import { getModeConfig, ConversationMode, ModeConfig } from './modes';
import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { CN_DURABLE_EXECUTION_MESSAGES } from '../i18n/durable_execution_messages';

export { classifyIntent, classifyIntentLLM, extractSentiment, generateFallback, isLLMDown, getModeConfig };
export type { IntentResult, SentimentResult } from './intent';
export type { FallbackResponse } from './fallback';
export type { ConversationMode, ModeConfig } from './modes';

export interface CognitiveContext {
  userId: string;
  agentId?: string;
  personalityId: string;
  personalityName: string;
  llmProvider: string;
  llmModel: string;
  isLLMAvailable: boolean;
}

export interface CognitiveResult {
  /** The final response text to send to the user */
  responseText: string;
  /** The classified intent (for logging / workflow recording) */
  intent: IntentResult;
  /** Whether the LLM was actually called */
  llmWasCalled: boolean;
  /** Whether a direct tool was executed (no LLM) */
  directToolExecuted: boolean;
  /** Result from direct tool execution, if any */
  toolResult?: string;
  /** Grounded receipt for a direct tool execution. */
  toolRecord?: ToolExecutionRecord;
  /** Complete receipt ledger when a deterministic path needs multiple reads. */
  toolRecords?: ToolExecutionRecord[];
  /** Whether the response came from the fallback system */
  isFallback: boolean;
}

/**
 * Run the full cognitive pipeline on a user input.
 *
 * Flow:
 * 1. Classify intent
 * 2. Return the classification as an advisory hint
 * 3. The caller invokes the model with the policy-filtered capability manifest
 *
 * Returns a CognitiveResult with an empty response when the model should own
 * the turn.
 */
export async function processInput(
  input: string,
  ctx: CognitiveContext,
  llmClassifier?: (prompt: string, userText: string) => Promise<string>,
  toolContext?: ToolContext,
): Promise<CognitiveResult> {
  const regexIntent = classifyIntent(input);

  // Second-stage LLM classification for ambiguous inputs
  let intent: IntentResult = regexIntent;
  // The local classifier already knows common conversation, question and
  // command shapes. A second model call on every short utterance doubled
  // voice latency without improving routing; reserve it for genuinely unknown
  // inputs only.
  if (llmClassifier && regexIntent.category === 'unknown' && regexIntent.confidence < 0.65) {
    intent = await classifyIntentLLM(input, regexIntent, llmClassifier);
  }

  // Natural-language cognition is advisory. `directToolCall` remains available
  // for shadow comparison, but cannot execute here or synthesize a terminal
  // answer. Tool choice belongs to the model over the authorized manifest.
  void ctx;
  void toolContext;
  return {
    responseText: '',
    intent,
    llmWasCalled: false,
    directToolExecuted: false,
    isFallback: false,
  };
}

/**
 * Last-resort transport response after the configured model recovery chain is
 * exhausted. This must not impersonate the model with intent-specific canned
 * conversation or advertise direct-command shortcuts.
 */
export function handleLLMFailure(
  intent: IntentResult,
  error: Error,
  toolResult?: string,
): CognitiveResult {
  void error;
  return {
    responseText: CN_DURABLE_EXECUTION_MESSAGES.modelFailure,
    intent,
    llmWasCalled: true,
    directToolExecuted: false,
    toolResult,
    isFallback: true,
  };
}
