import type { ParsedToolCall, NormalizedLLMResponse } from "../../tools/types";
import type { LLMResponseFormat, NormalizedMessage, OpenAICompatibleMessage, OpenAICompatibleRequestParams, OpenAICompatibleRequest, ToolDeclaration, MessageContent } from './contracts';
import { contentToText, hasMeaningfulContent } from './content';
import { markProviderSourceUserSlot } from './request_context';
import { completionMetadata, extractUsage, assertToolResponseComplete, parseToolArguments } from './response';
import { parseLegacyXmlToolCalls } from './legacy_protocol';

export function responseFormatParameter(format?: LLMResponseFormat) {
  return format === 'json_object' ? { type: 'json_object' as const } : format;
}

export function toolResultAsUserMessage(m: NormalizedMessage): OpenAICompatibleMessage | null {
  const text = contentToText(m.content).trim();
  if (!text) return null;
  const name = m.name ? ` ${m.name}` : '';
  return {
    role: 'user',
    content: `[Tool result${name}]\n${text}`,
  };
}

export function buildOpenAICompatibleMessages(
  messages: NormalizedMessage[],
  options: { includeAssistantReasoning?: boolean } = {},
): OpenAICompatibleMessage[] {
  const raw: OpenAICompatibleMessage[] = [];

  for (const m of messages) {
    const roleMap: Record<string, string> = { assistant: 'assistant', tool: 'tool', system: 'system', user: 'user' };
    const role = roleMap[m.role] || 'user';

    if (role === 'tool') {
      if (!m.toolCallId) {
        const fallback = toolResultAsUserMessage(m);
        if (fallback) raw.push(fallback);
        continue;
      }
      raw.push({
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: m.toolCallId,
        ...(m.name ? { name: m.name } : {}),
      });
      continue;
    }

    const validToolCalls = (m.toolCalls || [])
      .filter(tc => tc?.id && tc?.name)
      .map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      }));

    if (!hasMeaningfulContent(m.content) && validToolCalls.length === 0) continue;

    const formattedMessage: OpenAICompatibleMessage = {
      role,
      content: m.content ?? '',
      ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
      ...(role === 'assistant' && options.includeAssistantReasoning && m.reasoningContent
        ? { reasoning_content: m.reasoningContent }
        : {}),
    };
    raw.push(m.role === 'user' && m.sourceMessageId
      ? markProviderSourceUserSlot(formattedMessage, m.sourceMessageId)
      : formattedMessage);
  }

  const sanitized: OpenAICompatibleMessage[] = [];
  const expectedToolIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];

    if (entry.role === 'assistant' && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
      const ids = entry.tool_calls.map((tc: any) => tc.id).filter(Boolean);
      const following = raw.slice(i + 1, i + 1 + ids.length);
      const hasImmediateResults =
        ids.length === entry.tool_calls.length &&
        following.length === ids.length &&
        following.every(next => next.role === 'tool' && next.tool_call_id && ids.includes(next.tool_call_id));

      if (hasImmediateResults) {
        sanitized.push(entry);
        ids.forEach(id => expectedToolIds.add(id));
      } else if (hasMeaningfulContent(entry.content)) {
        const { tool_calls, ...plainAssistant } = entry;
        sanitized.push(plainAssistant);
      }
      continue;
    }

    if (entry.role === 'tool') {
      if (entry.tool_call_id && expectedToolIds.has(entry.tool_call_id)) {
        sanitized.push(entry);
        expectedToolIds.delete(entry.tool_call_id);
      } else {
        const fallback = toolResultAsUserMessage({
          role: 'tool',
          content: entry.content,
          toolCallId: entry.tool_call_id,
          name: entry.name,
        });
        if (fallback) sanitized.push(fallback);
      }
      continue;
    }

    sanitized.push(entry);
  }

  return sanitized;
}

export function formatOpenAICompatibleRequest(
  params: OpenAICompatibleRequestParams,
  options: { includeAssistantReasoning?: boolean } = {},
): OpenAICompatibleRequest {
  const openaiMessages = buildOpenAICompatibleMessages(params.messages, options);

  const hasTools = params.toolDeclarations.length > 0;

  return {
    model: params.model,
    messages: openaiMessages,
    ...(hasTools ? { tools: params.toolDeclarations, tool_choice: 'auto' } : {}),
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    ...(params.userId ? { user: params.userId.replace(/[^a-zA-Z0-9_-]/g, '_') } : {}),
    ...(params.responseFormat ? { response_format: responseFormatParameter(params.responseFormat) } : {}),
  };
}

export function formatDeepSeekRequest(params: OpenAICompatibleRequestParams): OpenAICompatibleRequest {
  return formatOpenAICompatibleRequest(params, { includeAssistantReasoning: true });
}

export function parseDeepSeekResponse(rawResponse: any): NormalizedLLMResponse {
  const message = rawResponse.choices?.[0]?.message;
  if (!message) return { text: null, toolCalls: null, ...completionMetadata(rawResponse.choices?.[0]?.finish_reason) };

  // Keep hidden reasoning hidden. `reasoning_content` is useful for diagnostics
  // and follow-up model calls, but it must never become user-visible text/TTS.
  const text = message.content || null;
  const reasoningContent = message.reasoning_content || null;
  const usage = extractUsage(rawResponse);
  const completion = completionMetadata(rawResponse.choices?.[0]?.finish_reason);

  if (message.tool_calls && message.tool_calls.length > 0) {
    assertToolResponseComplete(rawResponse.choices?.[0]?.finish_reason);
    const toolCalls: ParsedToolCall[] = message.tool_calls.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name || '',
      arguments: parseToolArguments(tc.function?.arguments),
    }));
    return { text, toolCalls, reasoningContent, usage, ...completion };
  }

  return { text, toolCalls: null, reasoningContent, usage, ...completion };
}

/**
 * Normalize a completed OpenAI-compatible response, including the legacy XML
 * function-call protocol some gateways emit when their streaming adapter is
 * unavailable.  Keeping this in one place makes the relay's non-stream
 * fallback behave exactly like the normal streaming parser.
 */
export function parseOpenAICompatibleResponse(
  rawResponse: any,
  toolDeclarations: ToolDeclaration[],
): NormalizedLLMResponse {
  const parsed = parseDeepSeekResponse(rawResponse);
  if (parsed.toolCalls?.length) return parsed;
  const legacyToolCalls = parseLegacyXmlToolCalls(parsed.text, toolDeclarations);
  return legacyToolCalls
    ? { ...parsed, text: null, toolCalls: legacyToolCalls }
    : parsed;
}

// ── OpenAI (same API format as DeepSeek) ──

export function formatOpenAIRequest(params: OpenAICompatibleRequestParams): OpenAICompatibleRequest {
  return formatOpenAICompatibleRequest(params);
}

export const parseOpenAIResponse = parseDeepSeekResponse;

// ── Qwen / DashScope (OpenAI-compatible API) ──

export function formatQwenRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
  userId?: string;
  responseFormat?: LLMResponseFormat;
}): {
  model: string;
  messages: Array<{ role: string; content: MessageContent; tool_calls?: any; tool_call_id?: string }>;
  tools?: ToolDeclaration[];
  tool_choice?: string;
  max_tokens?: number;
  response_format?: ReturnType<typeof responseFormatParameter>;
} {
  const openaiMessages = buildOpenAICompatibleMessages(params.messages);

  const hasTools = params.toolDeclarations.length > 0;

  return {
    model: params.model,
    messages: openaiMessages,
    ...(hasTools ? { tools: params.toolDeclarations, tool_choice: 'auto' } : {}),
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    ...(params.responseFormat ? { response_format: responseFormatParameter(params.responseFormat) } : {}),
    // DashScope does not support the OpenAI `user` parameter — omit it
  };
}

export function isReasoningModel(model: string): boolean {
  return /reasoner|v4-(pro|flash)|gpt-5|o[134]|r1/i.test(model);
}
