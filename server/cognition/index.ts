/**
 * Lumi Cognitive Engine — the independent decision-making layer.
 *
 * This engine sits BETWEEN the socket handlers and the LLM. It:
 * 1. Classifies every user input before it reaches any LLM
 * 2. Executes simple commands directly (no LLM call needed)
 * 3. Passes complex requests to the LLM with enriched context
 * 4. Falls back to local responses when the LLM is unavailable
 *
 * Architecture:
 *   User Input → [Cognitive Engine] → Direct Tool OR LLM → Response
 *
 * Lumi is the dominant decision-maker. The LLM is just a swappable
 * text generation module — Lumi's identity, intent understanding,
 * and tool routing all work independently of it.
 */

import { classifyIntent, classifyIntentLLM, extractSentiment, IntentResult, SentimentResult } from './intent';
import { generateFallback, isLLMDown } from './fallback';
import { toolRegistry } from '../tools/registry';
import { getModeConfig, ConversationMode, ModeConfig } from './modes';
import type { ToolContext, ToolExecutionRecord } from '../tools/types';

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
  /** Whether the response came from the fallback system */
  isFallback: boolean;
}

/**
 * Run the full cognitive pipeline on a user input.
 *
 * Flow:
 * 1. Classify intent
 * 2. If direct tool call possible and confidence high → execute and return
 * 3. Otherwise → caller should invoke LLM (we return null for responseText,
 *    signaling "pass through to LLM")
 *
 * Returns a CognitiveResult with responseText = null if the LLM should handle it.
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
  if (llmClassifier && regexIntent.confidence < 0.65) {
    intent = await classifyIntentLLM(input, regexIntent, llmClassifier);
  }

  // ── Path A: Direct tool call (skip LLM entirely) ──
  if (intent.directToolCall && intent.confidence >= 0.75 && !intent.needsLLM) {
    try {
      const toolResult = await toolRegistry.execute(
        intent.directToolCall.name,
        intent.directToolCall.args,
        toolContext,
      );

      const fallback = generateFallback(intent, toolResult);
      return {
        responseText: fallback?.text || toolResult,
        intent,
        llmWasCalled: false,
        directToolExecuted: true,
        toolResult,
        toolRecord: {
          id: `cognition-${Date.now()}`,
          name: intent.directToolCall.name,
          arguments: intent.directToolCall.args,
          result: toolResult,
        },
        isFallback: !!fallback,
      };
    } catch (err: any) {
      // Direct tool failed — fall through to LLM path
      console.log(`[Cognition] Direct tool '${intent.directToolCall.name}' failed: ${err.message}, falling through to LLM`);
      return {
        responseText: '',
        intent,
        llmWasCalled: false,
        directToolExecuted: false,
        toolResult: err.message,
        isFallback: false,
      };
    }
  }

  // ── Path B: Needs LLM — signal caller to invoke LLM ──
  return {
    responseText: '',
    intent,
    llmWasCalled: false,
    directToolExecuted: false,
    isFallback: false,
  };
}

/**
 * Handle LLM failure by generating a fallback response based on the intent.
 */
export function handleLLMFailure(
  intent: IntentResult,
  error: Error,
  toolResult?: string,
): CognitiveResult {
  const down = isLLMDown(error);
  const fallback = generateFallback(intent, toolResult);

  if (fallback && !fallback.isPlaceholder) {
    return {
      responseText: fallback.text,
      intent,
      llmWasCalled: true,
      directToolExecuted: false,
      toolResult,
      isFallback: true,
    };
  }

  if (down) {
    return {
      responseText: `Lumi 的语言模块暂时不可用（${error.message.slice(0, 80)}）。\n\n但我核心功能还在 — 你可以直接给我指令，比如"打开记事本"、"搜索文件"、"列出桌面"。`,
      intent,
      llmWasCalled: true,
      directToolExecuted: false,
      isFallback: true,
    };
  }

  return {
    responseText: `出错了：${error.message}`,
    intent,
    llmWasCalled: true,
    directToolExecuted: false,
    isFallback: true,
  };
}
