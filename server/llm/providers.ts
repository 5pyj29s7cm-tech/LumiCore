import { ParsedToolCall, NormalizedLLMResponse } from '../tools/types';
import { withCloudResilience } from '../cloud/resilience';
import { isStrictPrivacy, requireLocalProvider } from '../config/privacy';
import { getScopedPreferredLLM } from './user_preferences';
import { getUserPreferredVision } from './vision_preferences';
import { getUserPreferredWorldModel } from './world_preferences';

export type MessageContent =
  | string
  | null
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }>;

export type LLMResponseFormat = 'json_object';

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  toolCalls?: ParsedToolCall[];
  toolCallId?: string;
  name?: string;
  reasoningContent?: string | null;
}

interface ToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

type OpenAICompatibleMessage = {
  role: string;
  content: MessageContent;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
};

function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map(part => part.type === 'text' ? part.text : '[image]')
    .join('\n')
    .trim();
}

function hasMeaningfulContent(content: MessageContent): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!content) return false;
  return content.length > 0;
}

function isQwenVisionModel(model: string): boolean {
  return /(?:qwen.*vl|vl-|vl_|vision)/i.test(model || '');
}

function assertQwenAllowedByUserPrefs(config: { provider: string; model: string; userId?: string; domain?: string; orgId?: string; role?: 'reasoning' | 'vision' | 'world' }): void {
  if (config.provider !== 'qwen') return;

  if (!config.userId) {
    throw new Error('Qwen model call blocked: missing user preference context. Pass userId so Lumi can respect the selected brain/vision provider.');
  }

  if (config.role === 'world') {
    const world = getUserPreferredWorldModel(config.userId);
    if (world.provider === 'qwen') return;
    throw new Error(`Qwen desktop-action call blocked: the current action role is ${world.provider}/${world.model}. Select Qwen-VL under Settings > World Model > Desktop Action Model.`);
  }

  if (isQwenVisionModel(config.model) || config.role === 'vision') {
    const vision = getUserPreferredVision(config.userId);
    if (vision.provider === 'qwen') return;
    throw new Error(`Qwen-VL call blocked: the current visual-perception role is ${vision.provider}/${vision.model}. Select Qwen-VL under Settings > World Model > Visual Perception.`);
  }

  const preferred = getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId });
  if (preferred.provider !== 'qwen') {
    throw new Error(`Qwen LLM call blocked: current primary reasoning brain is ${preferred.provider}/${preferred.model}. Change Primary Reasoning Brain to Qwen to use Alibaba LLM.`);
  }
}

function toolResultAsUserMessage(m: NormalizedMessage): OpenAICompatibleMessage | null {
  const text = contentToText(m.content).trim();
  if (!text) return null;
  const name = m.name ? ` ${m.name}` : '';
  return {
    role: 'user',
    content: `[Tool result${name}]\n${text}`,
  };
}

function buildOpenAICompatibleMessages(messages: NormalizedMessage[]): OpenAICompatibleMessage[] {
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

    raw.push({
      role,
      content: m.content ?? '',
      ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
    });
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

// ── DeepSeek (OpenAI-compatible) ──

export function formatDeepSeekRequest(params: {
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
  user?: string;
  response_format?: { type: 'json_object' };
} {
  const openaiMessages = buildOpenAICompatibleMessages(params.messages);

  const hasTools = params.toolDeclarations.length > 0;

  return {
    model: params.model,
    messages: openaiMessages,
    ...(hasTools ? { tools: params.toolDeclarations, tool_choice: 'auto' } : {}),
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    ...(params.userId ? { user: params.userId.replace(/[^a-zA-Z0-9_-]/g, '_') } : {}),
    ...(params.responseFormat === 'json_object' ? { response_format: { type: 'json_object' as const } } : {}),
  };
}

function extractUsage(rawResponse: any) {
  const usage = rawResponse.usage || rawResponse.usageMetadata;
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens || usage.promptTokenCount || usage.input_tokens || usage.inputTokens || 0,
    completionTokens: usage.completion_tokens || usage.candidatesTokenCount || usage.output_tokens || usage.outputTokens || 0,
    totalTokens: usage.total_tokens || usage.totalTokenCount || 0,
  };
}

export function parseDeepSeekResponse(rawResponse: any): NormalizedLLMResponse {
  const message = rawResponse.choices?.[0]?.message;
  if (!message) return { text: null, toolCalls: null };

  // Keep hidden reasoning hidden. `reasoning_content` is useful for diagnostics
  // and follow-up model calls, but it must never become user-visible text/TTS.
  const text = message.content || null;
  const reasoningContent = message.reasoning_content || null;
  const usage = extractUsage(rawResponse);

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ParsedToolCall[] = message.tool_calls.map((tc: any) => {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch { /* ignore parse errors */ }
      return { id: tc.id, name: tc.function?.name || '', arguments: args };
    });
    return { text, toolCalls, reasoningContent, usage };
  }

  return { text, toolCalls: null, reasoningContent, usage };
}

// ── Gemini ──

function geminiPartsFromContent(content: MessageContent): any[] {
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
    contents.push({
      role: 'user',
      parts: geminiPartsFromContent(m.content),
    });
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
    usage: extractUsage(rawResponse),
  };
}

// ── OpenAI (same API format as DeepSeek) ──

export const formatOpenAIRequest = formatDeepSeekRequest;
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
  response_format?: { type: 'json_object' };
} {
  const openaiMessages = buildOpenAICompatibleMessages(params.messages);

  const hasTools = params.toolDeclarations.length > 0;

  return {
    model: params.model,
    messages: openaiMessages,
    ...(hasTools ? { tools: params.toolDeclarations, tool_choice: 'auto' } : {}),
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    ...(params.responseFormat === 'json_object' ? { response_format: { type: 'json_object' as const } } : {}),
    // DashScope does not support the OpenAI `user` parameter — omit it
  };
}

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
      anthropicMessages.push({ role: 'user', content: m.content || '' });
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
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage: extractUsage(rawResponse),
  };
}

// ── LLM Call Router ──

export async function makeLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: { provider: 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen' | 'ark' | 'ollama' | 'lmstudio' | 'xiaomi' | 'kimi' | 'glm' | 'relay' | 'auto'; model: string; maxTokens?: number; userId?: string; domain?: string; orgId?: string; responseFormat?: LLMResponseFormat; role?: 'reasoning' | 'vision' | 'world' },  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<NormalizedLLMResponse> {
  assertQwenAllowedByUserPrefs(config);

  // ── Privacy gate: strict mode blocks cloud providers ──
  // Reasoning models need high token budget — their CoT eats into max_tokens
  const maxTokens = isReasoningModel(config.model)
    ? Math.max(config.maxTokens || 8000, 4000)
    : config.maxTokens;

  if (isStrictPrivacy()) {
    if (config.provider === 'auto') {
      // In strict mode, auto routes to local-only dispatch
      const { dispatchLLMCall } = await import('./dispatch');
      const localGetters = { getDeepSeek, getGemini, getOpenAI: getOpenAI || (() => null), getAnthropic: getAnthropic || (() => null), getQwen: getQwen || (() => null), getArk: getArk || (() => null), getOllama, isOllamaAvailable: () => !!getOllama?.(), getLmStudio, isLmStudioAvailable: () => !!getLmStudio?.() };
      if (getOllama?.()) {
        try {
          const req = formatDeepSeekRequest({ model: 'llama3.2', messages, toolDeclarations, maxTokens: maxTokens, userId: config.userId });
          const client = getOllama();
          const res = await withCloudResilience(
            () => client.chat.completions.create(req),
            { provider: 'ollama', maxRetries: 1 }
          );
          return parseOpenAIResponse(res);
        } catch {
          if (getLmStudio?.()) {
            try {
              const req = formatDeepSeekRequest({ model: config.model, messages, toolDeclarations, maxTokens: maxTokens, userId: config.userId });
              const client = getLmStudio();
              const res = await client.chat.completions.create(req);
              return parseOpenAIResponse(res);
            } catch {}
          }
          throw new Error('[Privacy] Strict mode: no local LLM available. Start Ollama or LM Studio.');
        }
      }
      if (getLmStudio?.()) {
        const req = formatDeepSeekRequest({ model: config.model, messages, toolDeclarations, maxTokens: maxTokens, userId: config.userId });
        const client = getLmStudio();
        const res = await client.chat.completions.create(req);
        return parseOpenAIResponse(res);
      }
      throw new Error('[Privacy] Strict mode: no local LLM provider available. Set up Ollama or LM Studio.');
    }
    requireLocalProvider(config.provider);
  }

  // ── Auto/hybrid dispatch: local Ollama → cloud DeepSeek fallback ──
  if (config.provider === 'auto' && getOllama) {
    const { dispatchLLMCall } = await import('./dispatch');
    const getters = { getDeepSeek, getGemini, getOpenAI: getOpenAI || (() => null), getAnthropic: getAnthropic || (() => null), getQwen: getQwen || (() => null), getArk: getArk || (() => null), getOllama, isOllamaAvailable: () => !!getOllama?.(), getLmStudio, isLmStudioAvailable: () => !!getLmStudio?.() };
    const result = await dispatchLLMCall(messages, toolDeclarations, { provider: 'deepseek', model: 'deepseek-v4-flash', maxTokens: maxTokens, userId: config.userId }, getters);
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage };
  }

  // OpenAI-compatible path: DeepSeek, Qwen, Ark, Ollama, LM Studio
  if (config.provider === 'deepseek' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const client = config.provider === 'deepseek' ? getDeepSeek()
      : config.provider === 'qwen' ? getQwen?.()
      : config.provider === 'ark' ? getArk?.()
      : config.provider === 'lmstudio' ? getLmStudio?.()
      : config.provider === 'xiaomi' ? getXiaomi?.()
      : config.provider === 'kimi' ? getKimi?.()
      : config.provider === 'glm' ? getGlm?.()
      : config.provider === 'relay' ? getRelay?.()
      : getOllama?.();
    if (!client) throw new Error(`${config.provider} not configured`);

    const fmt = config.provider === 'qwen' ? formatQwenRequest : formatDeepSeekRequest;
    const isLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
    const params: any = fmt({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      responseFormat: config.responseFormat,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    if (config.provider === 'xiaomi') {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }

    const response = await withCloudResilience(
      () => client.chat.completions.create(params),
      { provider: config.provider, model: config.model },
    );
    return parseDeepSeekResponse(response);
  }

  if (config.provider === 'gemini') {
    const client = getGemini();
    if (!client) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');

    const { modelConfig, contents } = formatGeminiRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      responseFormat: config.responseFormat,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    const result = await withCloudResilience(
      () => modelInstance.generateContent({ contents }),
      { provider: 'gemini', model: config.model },
    );
    return parseGeminiResponse(result);
  }

  if (config.provider === 'openai') {
    const client = getOpenAI?.();
    if (!client) throw new Error('OpenAI not configured (OPENAI_API_KEY missing)');

    const params: any = formatOpenAIRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      userId: config.userId,
      responseFormat: config.responseFormat,
    });
    if (isReasoningModel(config.model)) {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }

    const response = await withCloudResilience(
      () => client.chat.completions.create(params),
      { provider: 'openai', model: config.model },
    );
    return parseOpenAIResponse(response);
  }

  if (config.provider === 'anthropic') {
    const client = getAnthropic?.();
    if (!client) throw new Error('Anthropic not configured (ANTHROPIC_API_KEY missing)');

    const params = formatAnthropicRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const response = await withCloudResilience(
      () => client.messages.create(params),
      { provider: 'anthropic', model: config.model },
    );
    return parseAnthropicResponse(response);
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}

// ── Streaming LLM Call Router ──

export type StreamCallback = (chunk: string) => void;

function isReasoningModel(model: string): boolean {
  return /reasoner|v4-(pro|flash)|gpt-5|o[134]|r1/i.test(model);
}

export async function makeLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: { provider: 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen' | 'ark' | 'ollama' | 'lmstudio' | 'xiaomi' | 'kimi' | 'glm' | 'relay' | 'auto'; model: string; maxTokens?: number; userId?: string; domain?: string; orgId?: string; signal?: AbortSignal; role?: 'reasoning' | 'vision' | 'world' },
  onChunk: StreamCallback,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<NormalizedLLMResponse> {
  assertQwenAllowedByUserPrefs(config);

  // ── Privacy gate ──
  if (isStrictPrivacy() && config.provider !== 'auto') {
    requireLocalProvider(config.provider);
  }

  // Reasoning models need high token budget
  const maxTokens = isReasoningModel(config.model)
    ? Math.max(config.maxTokens || 8000, 4000)
    : config.maxTokens;

  // ── Auto/hybrid dispatch: local Ollama → cloud DeepSeek fallback ──
  if (config.provider === 'auto' && getOllama) {
    const { dispatchLLMCallStreaming } = await import('./dispatch');
    const getters = { getDeepSeek, getGemini, getOpenAI: getOpenAI || (() => null), getAnthropic: getAnthropic || (() => null), getQwen: getQwen || (() => null), getArk: getArk || (() => null), getOllama, isOllamaAvailable: () => !!getOllama?.(), getLmStudio, isLmStudioAvailable: () => !!getLmStudio?.() };
    const result = await dispatchLLMCallStreaming(messages, toolDeclarations, { provider: 'deepseek', model: 'deepseek-v4-flash', maxTokens: maxTokens, userId: config.userId, signal: config.signal }, onChunk, getters);
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage };
  }

  // ── DeepSeek / OpenAI / Qwen / Ark / Ollama / LM Studio (OpenAI-compatible streaming) ──
  if (config.provider === 'deepseek' || config.provider === 'openai' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const client = config.provider === 'deepseek' ? getDeepSeek()
      : config.provider === 'openai' ? getOpenAI?.()
      : config.provider === 'qwen' ? getQwen?.()
      : config.provider === 'ark' ? getArk?.()
      : config.provider === 'lmstudio' ? getLmStudio?.()
      : config.provider === 'xiaomi' ? getXiaomi?.()
      : config.provider === 'kimi' ? getKimi?.()
      : config.provider === 'glm' ? getGlm?.()
      : config.provider === 'relay' ? getRelay?.()
      : getOllama?.();
    if (!client) throw new Error(`${config.provider} not configured`);

    const fmt = config.provider === 'qwen' ? formatQwenRequest : formatDeepSeekRequest;
    const isLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
    const params: any = fmt({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    if (config.provider === 'xiaomi' || (config.provider === 'openai' && isReasoningModel(config.model))) {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }
    params.stream = true;

    const stream: any = await withCloudResilience(
      () => client.chat.completions.create(params, { signal: config.signal }),
      { provider: config.provider, model: config.model },
    );
    const accumulatedText: string[] = [];
    const accumulatedReasoning: string[] = [];
    const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();
    let streamUsage: any = undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        if (delta.content) {
          accumulatedText.push(delta.content);
          onChunk(delta.content);
        }

        if (delta.reasoning_content) {
          accumulatedReasoning.push(delta.reasoning_content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulators.has(idx)) {
              toolCallAccumulators.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
            }
            const acc = toolCallAccumulators.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }
      }
      if (chunk.usage) streamUsage = chunk.usage;
    }

    const usage = extractUsage({ usage: streamUsage });

    const text = accumulatedText.length > 0 ? accumulatedText.join('') : null;
    const reasoningContent = accumulatedReasoning.length > 0 ? accumulatedReasoning.join('') : null;
    if (toolCallAccumulators.size > 0) {
      const toolCalls: ParsedToolCall[] = [...toolCallAccumulators.values()].map(acc => {
        let args: Record<string, any> = {};
        try { args = JSON.parse(acc.args || '{}'); } catch { /* ignore parse errors */ }
        return { id: acc.id, name: acc.name, arguments: args };
      });
      return { text, toolCalls, reasoningContent, usage };
    }
    return { text, toolCalls: null, reasoningContent, usage };
  }

  // ── Gemini streaming ──
  if (config.provider === 'gemini') {
    const client = getGemini();
    if (!client) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');

    const { modelConfig, contents } = formatGeminiRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    const result: any = await withCloudResilience(
      () => modelInstance.generateContentStream({ contents }),
      { provider: 'gemini', model: config.model },
    );

    const accumulatedText: string[] = [];
    const toolCalls: ParsedToolCall[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        accumulatedText.push(text);
        onChunk(text);
      }
      const calls = chunk.functionCalls();
      if (calls) {
        for (let i = 0; i < calls.length; i++) {
          toolCalls.push({
            id: `gemini-${Date.now()}-${toolCalls.length}`,
            name: calls[i].name || '',
            arguments: calls[i].args || {},
          });
        }
      }
    }

    // Also check the aggregated response for function calls + usage
    const aggregated = await result.response;
    const parsed = parseGeminiResponse(aggregated);

    return {
      text: accumulatedText.length > 0 ? accumulatedText.join('') : parsed.text,
      toolCalls: parsed.toolCalls && parsed.toolCalls.length > 0 ? parsed.toolCalls : (toolCalls.length > 0 ? toolCalls : null),
      usage: parsed.usage,
    };
  }

  // ── Anthropic streaming ──
  if (config.provider === 'anthropic') {
    const client = getAnthropic?.();
    if (!client) throw new Error('Anthropic not configured (ANTHROPIC_API_KEY missing)');

    const params = formatAnthropicRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const stream: any = await withCloudResilience(
      () => client.messages.stream(params),
      { provider: 'anthropic', model: config.model },
    );

    const textParts: string[] = [];
    const toolCalls: ParsedToolCall[] = [];
    // Accumulate tool_use blocks during stream (not just from finalMessage)
    const toolUseAccumulators: Map<string, { id: string; name: string; args: Record<string, any> }> = new Map();

    for await (const event of stream) {
      if (event.type === 'text' && event.text) {
        textParts.push(event.text);
        onChunk(event.text);
      }
      if (event.type === 'content_block_start' && (event as any).content_block?.type === 'tool_use') {
        const block = (event as any).content_block;
        toolUseAccumulators.set(block.id, { id: block.id, name: block.name, args: {} });
      }
      if (event.type === 'content_block_delta' && (event as any).delta?.type === 'input_json_delta') {
        const delta = (event as any).delta;
        // Partial JSON — accumulate for complete parse at end
        const acc = [...toolUseAccumulators.values()].find(a => !a.name || Object.keys(a.args).length === 0);
        if (acc) {
          try { acc.args = { ...acc.args, ...JSON.parse(delta.partial_json || '{}') }; } catch {}
        }
      }
    }

    // Get final message for complete tool use blocks + usage
    const finalMessage = await stream.finalMessage();
    // Prefer stream-accumulated tool calls; fall back to finalMessage blocks
    if (toolUseAccumulators.size > 0) {
      for (const acc of toolUseAccumulators.values()) {
        toolCalls.push({ id: acc.id, name: acc.name, arguments: acc.args });
      }
    } else {
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input || {},
          });
        }
      }
    }

    return {
      text: textParts.length > 0 ? textParts.join('') : null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage: extractUsage(finalMessage),
    };
  }

  throw new Error(`Unsupported streaming provider: ${config.provider}`);
}

// ── Token estimation ──────────────────────────────────────────────────────

/**
 * Quick token count heuristic.
 * English: ~4 chars/token. CJK: ~1.5 chars/token.
 * Fallback: 3 chars/token for mixed content.
 */
export function estimateTokenCount(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk++;
    } else if (code < 0x80) {
      ascii++;
    } else {
      // Punctuation, emoji, etc — count as 1 token each
      cjk++;
    }
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);
}
