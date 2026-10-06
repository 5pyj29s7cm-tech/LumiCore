import type { ParsedToolCall, NormalizedLLMResponse } from "../../tools/types";
import type { NormalizedMessage, ToolDeclaration } from './contracts';
import { markProviderSourceUserSlot } from './request_context';
import { assertToolResponseComplete, parseToolArguments, completionMetadata, extractUsage } from './response';

// ── Anthropic ──

export function formatAnthropicRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
}): { model: string; max_tokens: number; system?: string; messages: any[]; tools?: any[] } {
  // Extract system message to top-level
  let system: string | undefined;
  const nonSystem = params.messages.filter(m => {
    if (m.role === 'system' && m.content) {
      system = m.content as string;
      return false;
    }
    return true;
  });

  const anthropicMessages: any[] = [];

  for (const m of nonSystem) {
    if (m.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '' }],
      });
    } else if (m.role === 'assistant') {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
      }
      anthropicMessages.push({ role: 'assistant', content });
    } else {
      const userMessage = { role: 'user', content: m.content || '' };
      anthropicMessages.push(m.sourceMessageId
        ? markProviderSourceUserSlot(userMessage, m.sourceMessageId)
        : userMessage);
    }
  }

  const hasTools = params.toolDeclarations.length > 0;
  const tools = hasTools
    ? params.toolDeclarations.map(td => ({
        name: td.function.name,
        description: td.function.description,
        input_schema: td.function.parameters,
      }))
    : undefined;

  return {
    model: params.model,
    max_tokens: params.maxTokens || 4096,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
    ...(tools ? { tools } : {}),
  };
}

export function parseAnthropicResponse(rawResponse: any): NormalizedLLMResponse {
  const content = rawResponse.content || [];
  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
    if (block.type === 'tool_use') {
      assertToolResponseComplete(rawResponse.stop_reason);
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: parseToolArguments(block.input),
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    ...completionMetadata(rawResponse.stop_reason),
    usage: extractUsage(rawResponse),
  };
}
