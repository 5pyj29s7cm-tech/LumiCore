import type { NormalizedLLMResponse } from "../../tools/types";

export function extractUsage(rawResponse: any) {
  const usage = rawResponse.usage || rawResponse.usageMetadata;
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens || usage.promptTokenCount || usage.input_tokens || usage.inputTokens || 0,
    completionTokens: usage.completion_tokens || usage.candidatesTokenCount || usage.output_tokens || usage.outputTokens || 0,
    totalTokens: usage.total_tokens || usage.totalTokenCount || 0,
  };
}

export class ModelToolArgumentsError extends Error {
  readonly code = 'MODEL_TOOL_ARGUMENTS_INVALID';

  constructor(reason: string) {
    // Do not include model-supplied arguments: they may contain private data.
    super(`Model returned invalid tool-call arguments: ${reason}`);
    this.name = 'ModelToolArgumentsError';
  }
}

export function parseToolArguments(value: unknown): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value || '{}') : (value ?? {});
  } catch {
    throw new ModelToolArgumentsError('incomplete or malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelToolArgumentsError('expected an object');
  }
  return parsed as Record<string, any>;
}

export function assertToolResponseComplete(reason: unknown): void {
  if (reason === 'length' || reason === 'max_tokens' || reason === 'content_filter') {
    throw new ModelToolArgumentsError('response ended before the tool turn completed');
  }
}

export function completionMetadata(reason: unknown): Pick<NormalizedLLMResponse, 'finishReason'> {
  if (reason == null || reason === '') return {};
  const value = String(reason).toLowerCase();
  if (['stop', 'end_turn', 'stop_sequence'].includes(value)) return { finishReason: 'stop' };
  if (['length', 'max_tokens'].includes(value)) return { finishReason: 'length' };
  if (['tool_calls', 'function_call', 'tool_use'].includes(value)) return { finishReason: 'tool_calls' };
  if (['content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content', 'spii', 'refusal'].includes(value)) return { finishReason: 'content_filter' };
  return { finishReason: 'unknown' };
}
