import type { ParsedToolCall, NormalizedLLMResponse } from "../../tools/types";
import type { MessageContent, NormalizedMessage, ToolDeclaration, LLMResponseFormat } from './contracts';
import { markProviderSourceUserSlot } from './request_context';
import { completionMetadata, extractUsage } from './response';

// ── Gemini ──

export function geminiPartsFromContent(content: MessageContent): any[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!content) return [{ text: '' }];

  const parts: any[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
      continue;
    }

    const url = part.image_url?.url || '';
    const dataUrl = url.match(/^data:([^;]+);base64,(.+)$/);
    if (dataUrl) {
      parts.push({
        inlineData: {
          mimeType: dataUrl[1],
          data: dataUrl[2],
        },
      });
    } else if (url) {
      parts.push({
        fileData: {
          mimeType: 'image/jpeg',
          fileUri: url,
        },
      });
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

export function formatGeminiRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
  responseFormat?: LLMResponseFormat;
}): {
  modelConfig: {
    model: string;
    systemInstruction?: string;
    tools?: Array<{ functionDeclarations: any[] }>;
    generationConfig?: { maxOutputTokens?: number; responseMimeType?: string };
  };
  contents: Array<{ role: string; parts: any[] }>;
} {
  // Extract system message for Gemini's separate systemInstruction param
  let systemInstruction: string | undefined;
  const nonSystemMessages = params.messages.filter(m => {
    if (m.role === 'system' && m.content) {
      systemInstruction = m.content as string;
      return false;
    }
    return true;
  });

  // Convert messages to Gemini contents format
  const contents: Array<{ role: string; parts: any[] }> = [];

  for (const m of nonSystemMessages) {
    if (m.role === 'tool') {
      // Tool results become user messages with functionResponse
      const prevContent = contents.length > 0 ? contents[contents.length - 1] : null;
      if (prevContent && prevContent.role === 'model') {
        // Append functionResponse to a new user message
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.name || '',
              response: { content: m.content || '' },
            },
          }],
        });
      } else {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.name || '',
              response: { content: m.content || '' },
            },
          }],
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) {
        parts.push(...geminiPartsFromContent(m.content));
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          });
        }
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // user messages
    const userContent = {
      role: 'user',
      parts: geminiPartsFromContent(m.content),
    };
    contents.push(m.sourceMessageId
      ? markProviderSourceUserSlot(userContent, m.sourceMessageId)
      : userContent);
  }

  const hasTools = params.toolDeclarations.length > 0;

  const modelConfig: any = { model: params.model };
  if (systemInstruction) modelConfig.systemInstruction = systemInstruction;
  if (hasTools) {
    modelConfig.tools = [{
      functionDeclarations: params.toolDeclarations.map(td => ({
        name: td.function.name,
        description: td.function.description,
        parameters: td.function.parameters,
      })),
    }];
  }
  if (params.maxTokens || params.responseFormat === 'json_object') {
    modelConfig.generationConfig = {
      ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
      ...(params.responseFormat === 'json_object' ? { responseMimeType: 'application/json' } : {}),
    };
  }

  return { modelConfig, contents };
}

export function parseGeminiResponse(rawResponse: any): NormalizedLLMResponse {
  const candidate = rawResponse.candidates?.[0];
  if (!candidate) return { text: null, toolCalls: null };

  const parts = candidate.content?.parts || [];
  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];

  for (const part of parts) {
    if (part.text) {
      textParts.push(part.text);
    }
    if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${toolCalls.length}`,
        name: part.functionCall.name || '',
        arguments: part.functionCall.args || {},
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    ...completionMetadata(candidate.finishReason),
    usage: extractUsage(rawResponse),
  };
}
