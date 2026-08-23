import { ParsedToolCall, NormalizedLLMResponse } from '../tools/types';
import { withCloudResilience } from '../cloud/resilience';
import { isStrictPrivacy, requireLocalProvider } from '../config/privacy';
import {
  getScopedPreferredLLM,
  type UserLLMFallbackCandidate,
  type UserLLMSelectionMode,
} from './user_preferences';
import { compileReasoningFailoverCandidates } from './failover_policy';
import { getUserPreferredVision } from './vision_preferences';
import { getUserPreferredWorldModel } from './world_preferences';
import { ensureLocalModelReady, runLocalModelInference, type LocalModelProvider } from './local_models';
import { prepareLocalModelRequest } from './local_context_budget';
import {
  modelRoutingErrorDigest,
  modelRoutingErrorReason,
  persistModelRoutingReceipt,
  type ModelRoutingTrace,
} from './model_routing_receipts';
import {
  assertRegisteredProviderModel,
  getRegisteredOpenAIClient,
  isExtensionProviderId,
  isRegisteredOpenAICompatibleProvider,
  isRegisteredProviderLocal,
} from '../extensions/registry';

export type MessageContent =
  | string
  | null
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }>;

export type LLMResponseFormat = 'json_object';

export type ReasoningProvider = string;

export interface LLMCallConfig {
  provider: ReasoningProvider;
  model: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
  conversationId?: string;
  requestId?: string;
  interactionId?: string;
  source?: string;
  responseFormat?: LLMResponseFormat;
  signal?: AbortSignal;
  /** Provider-independent lifecycle deadlines for one model attempt. */
  attemptTimeouts?: Partial<ModelAttemptTimeouts>;
  role?: 'reasoning' | 'vision' | 'world';
  selectionMode?: UserLLMSelectionMode;
  fallbackCandidates?: UserLLMFallbackCandidate[];
  allowCloudFallback?: boolean;
  /** True only for a candidate compiled from the user's stored route policy. */
  authorizedRoutingCandidate?: boolean;
}

export interface ModelAttemptTimeouts {
  /** Time allowed to establish the provider response/stream. */
  requestMs: number;
  /** Time allowed before the first transport frame arrives. */
  firstByteMs: number;
  /** Time allowed before text or a tool call is produced. */
  semanticContentMs: number;
  /** Maximum gap between transport frames after streaming starts. */
  idleMs: number;
  /** Hard wall-clock limit for the complete attempt. */
  absoluteMs: number;
}

export const DEFAULT_MODEL_ATTEMPT_TIMEOUTS: Readonly<ModelAttemptTimeouts> = Object.freeze({
  requestMs: 20_000,
  firstByteMs: 20_000,
  semanticContentMs: 45_000,
  idleMs: 20_000,
  absoluteMs: 60_000,
});

export type ModelAttemptDeadlineStage =
  | 'request'
  | 'first_byte'
  | 'semantic_content'
  | 'idle'
  | 'absolute'
  | 'cancelled';

export class ModelAttemptDeadlineError extends Error {
  readonly stage: ModelAttemptDeadlineStage;
  readonly timeoutMs: number;
  readonly callerCancelled: boolean;

  constructor(stage: ModelAttemptDeadlineStage, timeoutMs: number, options: { cause?: unknown; completedEmpty?: boolean } = {}) {
    const message = stage === 'cancelled'
      ? 'Model attempt cancelled by caller'
      : options.completedEmpty
        ? 'Model attempt completed without semantic content'
        : `Model attempt ${stage} timeout after ${timeoutMs}ms`;
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelAttemptDeadlineError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.callerCancelled = stage === 'cancelled';
  }
}

function positiveTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

export function resolveModelAttemptTimeouts(config?: Partial<ModelAttemptTimeouts>): ModelAttemptTimeouts {
  const resolved: ModelAttemptTimeouts = {
    requestMs: positiveTimeout(config?.requestMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.requestMs),
    firstByteMs: positiveTimeout(config?.firstByteMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.firstByteMs),
    semanticContentMs: positiveTimeout(config?.semanticContentMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.semanticContentMs),
    idleMs: positiveTimeout(config?.idleMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.idleMs),
    absoluteMs: positiveTimeout(config?.absoluteMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.absoluteMs),
  };
  // Stage deadlines cannot outlive the enclosing attempt. Keeping the values
  // configurable makes this mechanism usable by future models without adding
  // provider- or model-name branches.
  resolved.requestMs = Math.min(resolved.requestMs, resolved.absoluteMs);
  resolved.firstByteMs = Math.min(resolved.firstByteMs, resolved.absoluteMs);
  resolved.semanticContentMs = Math.min(resolved.semanticContentMs, resolved.absoluteMs);
  resolved.idleMs = Math.min(resolved.idleMs, resolved.absoluteMs);
  return resolved;
}

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

function decodeBasicXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseLegacyParameterValue(value: string): unknown {
  const decoded = decodeBasicXmlEntities(value).trim();
  if (!decoded) return '';
  try { return JSON.parse(decoded); } catch { return decoded; }
}

/**
 * Some OpenAI-compatible models occasionally print the older XML function-call
 * protocol in message content instead of returning structured tool_calls. Only
 * convert names that were declared for this exact model request.
 */
export function parseLegacyXmlToolCalls(
  text: string | null,
  toolDeclarations: ToolDeclaration[],
): ParsedToolCall[] | null {
  const raw = String(text || '');
  if (!/<(?:function_calls|invoke)\b/i.test(raw)) return null;
  const allowed = new Set(toolDeclarations.map(declaration => declaration.function.name));
  if (allowed.size === 0) return null;

  const calls: ParsedToolCall[] = [];
  const invokeRe = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  for (const match of raw.matchAll(invokeRe)) {
    const name = decodeBasicXmlEntities(match[1]).trim();
    if (!allowed.has(name)) continue;
    const args: Record<string, any> = {};
    const body = match[2] || '';
    const parameterRe = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    for (const parameter of body.matchAll(parameterRe)) {
      args[decodeBasicXmlEntities(parameter[1]).trim()] = parseLegacyParameterValue(parameter[2]);
    }
    calls.push({
      id: `legacy-xml-${calls.length}-${name}`,
      name,
      arguments: args,
    });
  }
  return calls.length > 0 ? calls : null;
}

function createLegacyProtocolChunkFilter(onChunk: (chunk: string) => void) {
  let state: 'pending' | 'normal' | 'suppressed' = 'pending';
  let pending = '';
  const prefixes = ['<function_calls', '<tool_calls', '<invoke', '```xml<function_calls', '```xml<tool_calls'];
  return {
    emit(chunk: string) {
      if (state === 'normal') { onChunk(chunk); return; }
      if (state === 'suppressed') return;
      pending += chunk;
      const probe = pending.trimStart().replace(/\s+/g, '').toLowerCase();
      if (!probe) return;
      if (prefixes.some(prefix => prefix.startsWith(probe))) return;
      if (prefixes.some(prefix => probe.startsWith(prefix))) {
        state = 'suppressed';
        pending = '';
        return;
      }
      state = 'normal';
      onChunk(pending);
      pending = '';
    },
    flush() {
      if (state === 'pending' && pending) onChunk(pending);
      pending = '';
    },
  };
}

type OpenAICompatibleMessage = {
  role: string;
  content: MessageContent;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
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

function messagesNeedVision(messages: NormalizedMessage[]): boolean {
  return messages.some(message => Array.isArray(message.content)
    && message.content.some(part => part.type === 'image_url'));
}

function extensionProviderForCall(config: LLMCallConfig): boolean {
  return isRegisteredOpenAICompatibleProvider(config.provider, config.userId);
}

function extensionProviderFailure(provider: string, error: unknown): Error {
  const messages: string[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const message = String(current?.message || current || '').trim();
    if (message && !messages.includes(message)) messages.push(message);
    current = current?.cause;
  }
  const detail = [...messages].reverse().find(message => !/^Connection error\.?$/i.test(message))
    || messages[0]
    || 'unknown provider error';
  return new Error(`Extension provider ${provider} failed: ${detail}`, { cause: error });
}

function assertProviderAllowedByPrivacy(config: LLMCallConfig): void {
  if (!isStrictPrivacy()) return;
  if (extensionProviderForCall(config)) {
    if (!isRegisteredProviderLocal(config.provider, config.userId)) {
      throw new Error(`[Privacy] Strict mode active. Extension provider "${config.provider}" is not declared as a loopback-only local provider.`);
    }
    return;
  }
  requireLocalProvider(config.provider);
}

function assertQwenAllowedByUserPrefs(config: { provider: string; model: string; userId?: string; domain?: string; orgId?: string; role?: 'reasoning' | 'vision' | 'world'; authorizedRoutingCandidate?: boolean }): void {
  if (config.provider !== 'qwen') return;
  if (config.authorizedRoutingCandidate === true) return;

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

function autoDispatchPreference(config: LLMCallConfig) {
  const preferred = config.userId
    ? getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId })
    : null;
  return {
    provider: preferred?.autoFallbackProvider || 'deepseek',
    model: preferred?.autoFallbackModel || preferred?.models?.deepseek || 'deepseek-v4-flash',
    localModel: config.model || preferred?.model,
    requestedProvider: config.provider,
    requestedModel: config.model,
    selectionMode: 'auto' as const,
    fallbackCandidates: config.fallbackCandidates || preferred?.fallbackCandidates || [],
    maxTokens: config.maxTokens,
    userId: config.userId,
    domain: config.domain,
    orgId: config.orgId,
    signal: config.signal,
    attemptTimeouts: config.attemptTimeouts,
    allowCloudFallback: config.allowCloudFallback !== false
      && preferred?.allowCloudFallback !== false
      && !isStrictPrivacy(),
  };
}

function pinnedFailoverDispatchPreference(config: LLMCallConfig) {
  if (config.role === 'vision' || config.role === 'world') return null;
  // A disabled/removed signed provider is an explicit trust-state change.
  // Preserve the selection and surface that state instead of routing around it.
  if (isExtensionProviderId(config.provider)
    && !isRegisteredOpenAICompatibleProvider(config.provider, config.userId)) return null;
  const preferred = config.userId
    ? getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId })
    : null;
  const isStoredReasoningPrimary = Boolean(
    preferred
    && preferred.provider === config.provider
    && preferred.model === config.model,
  );
  const explicitCandidates = config.fallbackCandidates || [];
  if (!isStoredReasoningPrimary && explicitCandidates.length === 0) return null;

  const fallbackCandidates = compileReasoningFailoverCandidates({
    primaryProvider: config.provider,
    primaryModel: config.model,
    explicitCandidates,
    preferences: isStoredReasoningPrimary ? preferred : null,
  });
  if (fallbackCandidates.length === 0) return null;
  return {
    ...config,
    requestedProvider: config.provider,
    requestedModel: config.model,
    selectionMode: 'pinned' as const,
    fallbackCandidates,
    allowCloudFallback: config.allowCloudFallback !== false
      && preferred?.allowCloudFallback !== false
      && !isStrictPrivacy(),
  };
}

function autoDispatchGetters(
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
) {
  return {
    getDeepSeek,
    getGemini,
    getOpenAI: getOpenAI || (() => null),
    getAnthropic: getAnthropic || (() => null),
    getQwen: getQwen || (() => null),
    getOllama: getOllama || (() => null),
    getLmStudio: getLmStudio || (() => null),
    getArk: getArk || (() => null),
    getXiaomi: getXiaomi || (() => null),
    getKimi: getKimi || (() => null),
    getGlm: getGlm || (() => null),
    getRelay: getRelay || (() => null),
  };
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

function buildOpenAICompatibleMessages(
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

    raw.push({
      role,
      content: m.content ?? '',
      ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
      ...(role === 'assistant' && options.includeAssistantReasoning && m.reasoningContent
        ? { reasoning_content: m.reasoningContent }
        : {}),
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

type OpenAICompatibleRequestParams = {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
  userId?: string;
  responseFormat?: LLMResponseFormat;
};

type OpenAICompatibleRequest = {
  model: string;
  messages: OpenAICompatibleMessage[];
  tools?: ToolDeclaration[];
  tool_choice?: string;
  max_tokens?: number;
  user?: string;
  response_format?: { type: 'json_object' };
};

function formatOpenAICompatibleRequest(
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
    ...(params.responseFormat === 'json_object' ? { response_format: { type: 'json_object' as const } } : {}),
  };
}

export function formatDeepSeekRequest(params: OpenAICompatibleRequestParams): OpenAICompatibleRequest {
  return formatOpenAICompatibleRequest(params, { includeAssistantReasoning: true });
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

function directRoutingTrace(config: LLMCallConfig, status: 'succeeded' | 'failed', error?: unknown): ModelRoutingTrace {
  const reason = status === 'failed' ? modelRoutingErrorReason(error) : '';
  return {
    requestedProvider: config.provider,
    requestedModel: config.model,
    selectionMode: 'pinned',
    selectedProvider: status === 'succeeded' ? config.provider : '',
    selectedModel: status === 'succeeded' ? config.model : '',
    fallbackReason: reason,
    attempts: [{
      provider: config.provider,
      model: config.model,
      status,
      ...(reason ? { reason, errorDigest: modelRoutingErrorDigest(error) } : {}),
    }],
  };
}

function persistRoutingTrace(
  config: LLMCallConfig,
  trace: ModelRoutingTrace,
  status: 'succeeded' | 'failed',
  startedAtMs: number,
): void {
  try {
    persistModelRoutingReceipt({
      userId: config.userId || 'anonymous',
      domain: config.domain || 'personal',
      orgId: config.orgId || '',
      conversationId: config.conversationId || '',
      requestId: config.requestId || '',
      interactionId: config.interactionId || '',
      source: config.source || '',
      status,
      ...trace,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
  } catch (error) {
    // Production initializes the durable database before serving calls. Some
    // isolated provider harnesses intentionally omit it; never replace a real
    // model result with a fabricated receipt in that environment.
    console.warn('[ModelRouting] Could not persist routing receipt:', (error as Error)?.message || error);
  }
}

function resolvedSelectionMode(config: LLMCallConfig): UserLLMSelectionMode {
  if (config.provider === 'auto') return 'auto';
  if (config.selectionMode === 'ordered_fallback') return 'ordered_fallback';
  return 'pinned';
}

export async function makeLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
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
  const startedAt = Date.now();
  const selectionMode = resolvedSelectionMode(config);
  const pinnedFailover = selectionMode === 'pinned'
    ? pinnedFailoverDispatchPreference(config)
    : null;
  try {
    let result: NormalizedLLMResponse;
    if (selectionMode === 'auto' || selectionMode === 'ordered_fallback' || pinnedFailover) {
      const { dispatchLLMCall } = await import('./dispatch');
      const dispatchConfig = selectionMode === 'auto'
        ? autoDispatchPreference({ ...config, selectionMode })
        : pinnedFailover
          ? pinnedFailover
        : {
            ...config,
            selectionMode,
            requestedProvider: config.provider,
            requestedModel: config.model,
            allowCloudFallback: config.allowCloudFallback !== false && !isStrictPrivacy(),
          };
      result = await dispatchLLMCall(
        messages,
        toolDeclarations,
        dispatchConfig,
        autoDispatchGetters(getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay),
      );
    } else {
      result = await makeLLMCallDirect(
        messages,
        toolDeclarations,
        { ...config, selectionMode: 'pinned' },
        getDeepSeek,
        getGemini,
        getOpenAI,
        getAnthropic,
        getQwen,
        getOllama,
        getLmStudio,
        getArk,
        getXiaomi,
        getKimi,
        getGlm,
        getRelay,
      );
    }
    const trace = result.routing || directRoutingTrace(config, 'succeeded');
    persistRoutingTrace(config, trace, 'succeeded', startedAt);
    return { ...result, routing: trace };
  } catch (error) {
    const trace = (error as any)?.routing as ModelRoutingTrace | undefined
      || directRoutingTrace(config, 'failed', error);
    persistRoutingTrace(config, trace, 'failed', startedAt);
    throw error;
  }
}

export async function makeLLMCallDirect(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
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

  // ── Privacy gate: strict mode blocks cloud providers ──
  // Reasoning models need high token budget — their CoT eats into max_tokens
  const maxTokens = isReasoningModel(config.model)
    ? Math.max(config.maxTokens || 8000, 4000)
    : config.maxTokens;

  if (config.provider === 'auto') {
    throw new Error('Automatic model routing must be resolved before direct provider execution');
  }

  assertProviderAllowedByPrivacy(config);

  // OpenAI-compatible path: DeepSeek, Qwen, Ark, Ollama, LM Studio
  const extensionProvider = extensionProviderForCall(config);
  if (extensionProvider || config.provider === 'deepseek' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const supervisedLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
    const isLocal = supervisedLocal || (extensionProvider && isRegisteredProviderLocal(config.provider, config.userId));
    if (supervisedLocal) await ensureLocalModelReady(config.provider as LocalModelProvider, config.model, { timeoutMs: 8_000 });
    if (extensionProvider) {
      assertRegisteredProviderModel(config.provider, config.model, {
        userId: config.userId,
        needsVision: messagesNeedVision(messages),
        needsTools: toolDeclarations.length > 0,
        needsJson: config.responseFormat === 'json_object',
      });
    }
    const client = extensionProvider ? getRegisteredOpenAIClient(config.provider, config.userId)
      : config.provider === 'deepseek' ? getDeepSeek()
      : config.provider === 'qwen' ? getQwen?.()
      : config.provider === 'ark' ? getArk?.()
      : config.provider === 'lmstudio' ? getLmStudio?.()
      : config.provider === 'xiaomi' ? getXiaomi?.()
      : config.provider === 'kimi' ? getKimi?.()
      : config.provider === 'glm' ? getGlm?.()
      : config.provider === 'relay' ? getRelay?.()
      : getOllama?.();
    if (!client) throw new Error(`${config.provider} not configured`);

    const fmt = config.provider === 'qwen'
      ? formatQwenRequest
      : config.provider === 'deepseek'
        ? formatDeepSeekRequest
        : formatOpenAIRequest;
    const localRequest = isLocal
      ? prepareLocalModelRequest({ messages, toolDeclarations, maxTokens })
      : null;
    const params: any = fmt({
      model: config.model,
      messages: localRequest?.messages || messages,
      toolDeclarations,
      maxTokens: localRequest?.maxTokens || maxTokens,
      responseFormat: config.responseFormat,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    if (config.provider === 'xiaomi') {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }

    const attemptTimeouts = resolveModelAttemptTimeouts(config.attemptTimeouts);
    const execute = () => withCloudResilience(
        operationSignal => client.chat.completions.create(
          params,
          operationSignal ? { signal: operationSignal } : undefined,
        ),
        {
          provider: config.provider,
          model: config.model,
          maxRetries: isLocal ? 1 : undefined,
          signal: config.signal,
          timeoutMs: attemptTimeouts.absoluteMs,
        },
      );
    let response: any;
    try {
      response = supervisedLocal
        ? await runLocalModelInference(config.provider as LocalModelProvider, execute, { signal: config.signal })
        : await execute();
    } catch (error) {
      if (extensionProvider) throw extensionProviderFailure(config.provider, error);
      throw error;
    }
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
      operationSignal => (modelInstance as any).generateContent(
        { contents },
        operationSignal ? { signal: operationSignal } : undefined,
      ),
      {
        provider: 'gemini',
        model: config.model,
        signal: config.signal,
        timeoutMs: resolveModelAttemptTimeouts(config.attemptTimeouts).absoluteMs,
      },
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
      operationSignal => client.chat.completions.create(
        params,
        operationSignal ? { signal: operationSignal } : undefined,
      ),
      {
        provider: 'openai',
        model: config.model,
        signal: config.signal,
        timeoutMs: resolveModelAttemptTimeouts(config.attemptTimeouts).absoluteMs,
      },
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
      operationSignal => client.messages.create(
        params,
        operationSignal ? { signal: operationSignal } : undefined,
      ),
      {
        provider: 'anthropic',
        model: config.model,
        signal: config.signal,
        timeoutMs: resolveModelAttemptTimeouts(config.attemptTimeouts).absoluteMs,
      },
    );
    return parseAnthropicResponse(response);
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}

// ── Streaming LLM Call Router ──

export type StreamCallback = (chunk: string) => void;

const STREAM_IDLE_TIMEOUT_MS = 20_000;

export async function nextStreamItemWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; item: IteratorResult<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      iterator.next().then(item => ({ timedOut: false as const, item })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type AttemptDeadline = { stage: Exclude<ModelAttemptDeadlineStage, 'cancelled'>; dueAt: number; timeoutMs: number };

/**
 * Supervises one provider attempt from request creation through the terminal
 * stream frame. Every wait is raced outside the SDK, so an implementation that
 * ignores AbortSignal cannot hold the chat execution open indefinitely.
 */
class ModelAttemptSupervisor {
  readonly signal: AbortSignal;
  readonly timeouts: ModelAttemptTimeouts;
  private readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private firstByteSeen = false;
  private semanticContentSeen = false;
  private lastFrameAt = this.startedAt;

  constructor(private readonly callerSignal: AbortSignal | undefined, config?: Partial<ModelAttemptTimeouts>) {
    this.timeouts = resolveModelAttemptTimeouts(config);
    this.signal = callerSignal
      ? AbortSignal.any([callerSignal, this.controller.signal])
      : this.controller.signal;
  }

  request<T>(operation: () => PromiseLike<T>): Promise<T> {
    return this.wait(
      Promise.resolve().then(operation),
      [
        { stage: 'request', dueAt: this.startedAt + this.timeouts.requestMs, timeoutMs: this.timeouts.requestMs },
        this.absoluteDeadline(),
      ],
    );
  }

  async next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
    const lifecycleDeadline: AttemptDeadline = this.firstByteSeen
      ? { stage: 'idle', dueAt: this.lastFrameAt + this.timeouts.idleMs, timeoutMs: this.timeouts.idleMs }
      : { stage: 'first_byte', dueAt: this.startedAt + this.timeouts.firstByteMs, timeoutMs: this.timeouts.firstByteMs };
    const deadlines = [lifecycleDeadline, this.absoluteDeadline()];
    if (!this.semanticContentSeen) {
      deadlines.push({
        stage: 'semantic_content',
        dueAt: this.startedAt + this.timeouts.semanticContentMs,
        timeoutMs: this.timeouts.semanticContentMs,
      });
    }
    const item = await this.wait(Promise.resolve().then(() => iterator.next()), deadlines);
    if (!item.done) {
      this.firstByteSeen = true;
      this.lastFrameAt = Date.now();
    }
    return item;
  }

  completion<T>(operation: PromiseLike<T>): Promise<T> {
    const deadlines = [this.absoluteDeadline()];
    if (!this.semanticContentSeen) {
      deadlines.push({
        stage: 'semantic_content',
        dueAt: this.startedAt + this.timeouts.semanticContentMs,
        timeoutMs: this.timeouts.semanticContentMs,
      });
    }
    return this.wait(Promise.resolve(operation), deadlines);
  }

  markSemanticContent(): void {
    this.semanticContentSeen = true;
  }

  assertSemanticContent(): void {
    if (this.semanticContentSeen) return;
    const error = new ModelAttemptDeadlineError('semantic_content', this.timeouts.semanticContentMs, { completedEmpty: true });
    this.abort(error);
    throw error;
  }

  abort(error: Error): void {
    if (!this.controller.signal.aborted) this.controller.abort(error);
  }

  private absoluteDeadline(): AttemptDeadline {
    return {
      stage: 'absolute',
      dueAt: this.startedAt + this.timeouts.absoluteMs,
      timeoutMs: this.timeouts.absoluteMs,
    };
  }

  private wait<T>(operation: Promise<T>, deadlines: AttemptDeadline[]): Promise<T> {
    if (this.callerSignal?.aborted) {
      void operation.catch(() => {});
      return Promise.reject(new ModelAttemptDeadlineError('cancelled', 0, { cause: this.callerSignal.reason }));
    }
    const deadline = deadlines.reduce((earliest, candidate) => candidate.dueAt < earliest.dueAt ? candidate : earliest);
    const remainingMs = deadline.dueAt - Date.now();
    if (remainingMs <= 0) {
      const error = new ModelAttemptDeadlineError(deadline.stage, deadline.timeoutMs);
      this.abort(error);
      void operation.catch(() => {});
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.callerSignal?.removeEventListener('abort', onCallerAbort);
        callback();
      };
      const onCallerAbort = () => finish(() => {
        reject(new ModelAttemptDeadlineError('cancelled', 0, { cause: this.callerSignal?.reason }));
      });
      const timer = setTimeout(() => finish(() => {
        const error = new ModelAttemptDeadlineError(deadline.stage, deadline.timeoutMs);
        this.abort(error);
        reject(error);
      }), remainingMs);
      this.callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      operation.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    });
  }
}

function stopIterator(iterator: AsyncIterator<unknown> | undefined): void {
  if (!iterator?.return) return;
  try {
    const stopped = iterator.return();
    void Promise.resolve(stopped).catch(() => {});
  } catch {
    // The attempt has already reached a terminal error; iterator cleanup is
    // best-effort and must never replace that error.
  }
}

function isReasoningModel(model: string): boolean {
  return /reasoner|v4-(pro|flash)|gpt-5|o[134]|r1/i.test(model);
}

export async function makeLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
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
  const startedAt = Date.now();
  const selectionMode = resolvedSelectionMode(config);
  const pinnedFailover = selectionMode === 'pinned'
    ? pinnedFailoverDispatchPreference(config)
    : null;
  try {
    let result: NormalizedLLMResponse;
    if (selectionMode === 'auto' || selectionMode === 'ordered_fallback' || pinnedFailover) {
      const { dispatchLLMCallStreaming } = await import('./dispatch');
      const dispatchConfig = selectionMode === 'auto'
        ? autoDispatchPreference({ ...config, selectionMode })
        : pinnedFailover
          ? pinnedFailover
        : {
            ...config,
            selectionMode,
            requestedProvider: config.provider,
            requestedModel: config.model,
            allowCloudFallback: config.allowCloudFallback !== false && !isStrictPrivacy(),
          };
      result = await dispatchLLMCallStreaming(
        messages,
        toolDeclarations,
        dispatchConfig,
        onChunk,
        autoDispatchGetters(getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay),
      );
    } else {
      result = await makeLLMCallStreamingDirect(
        messages,
        toolDeclarations,
        { ...config, selectionMode: 'pinned' },
        onChunk,
        getDeepSeek,
        getGemini,
        getOpenAI,
        getAnthropic,
        getQwen,
        getOllama,
        getLmStudio,
        getArk,
        getXiaomi,
        getKimi,
        getGlm,
        getRelay,
      );
    }
    const trace = result.routing || directRoutingTrace(config, 'succeeded');
    persistRoutingTrace(config, trace, 'succeeded', startedAt);
    return { ...result, routing: trace };
  } catch (error) {
    const trace = (error as any)?.routing as ModelRoutingTrace | undefined
      || directRoutingTrace(config, 'failed', error);
    persistRoutingTrace(config, trace, 'failed', startedAt);
    throw error;
  }
}

export async function makeLLMCallStreamingDirect(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
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
  if (config.provider !== 'auto') assertProviderAllowedByPrivacy(config);

  // Reasoning models need high token budget
  const maxTokens = isReasoningModel(config.model)
    ? Math.max(config.maxTokens || 8000, 4000)
    : config.maxTokens;

  // ── Auto/hybrid dispatch: local Ollama → cloud DeepSeek fallback ──
  if (config.provider === 'auto') {
    throw new Error('Automatic model routing must be resolved before direct provider execution');
  }

  // ── DeepSeek / OpenAI / Qwen / Ark / Ollama / LM Studio (OpenAI-compatible streaming) ──
  const extensionProvider = extensionProviderForCall(config);
  if (extensionProvider || config.provider === 'deepseek' || config.provider === 'openai' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const supervisedLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
    const isLocal = supervisedLocal || (extensionProvider && isRegisteredProviderLocal(config.provider, config.userId));
    if (supervisedLocal) await ensureLocalModelReady(config.provider as LocalModelProvider, config.model, { timeoutMs: 8_000 });
    if (extensionProvider) {
      assertRegisteredProviderModel(config.provider, config.model, {
        userId: config.userId,
        needsVision: messagesNeedVision(messages),
        needsTools: toolDeclarations.length > 0,
        needsJson: config.responseFormat === 'json_object',
        needsStreaming: true,
      });
    }
    const client = extensionProvider ? getRegisteredOpenAIClient(config.provider, config.userId)
      : config.provider === 'deepseek' ? getDeepSeek()
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

    const fmt = config.provider === 'qwen'
      ? formatQwenRequest
      : config.provider === 'deepseek'
        ? formatDeepSeekRequest
        : formatOpenAIRequest;
    const localRequest = isLocal
      ? prepareLocalModelRequest({ messages, toolDeclarations, maxTokens })
      : null;
    const params: any = fmt({
      model: config.model,
      messages: localRequest?.messages || messages,
      toolDeclarations,
      maxTokens: localRequest?.maxTokens || maxTokens,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    if (config.provider === 'xiaomi' || (config.provider === 'openai' && isReasoningModel(config.model))) {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }
    params.stream = true;

    const consumeStream = async (operationSignal?: AbortSignal): Promise<NormalizedLLMResponse> => {
      const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
      const accumulatedText: string[] = [];
      const accumulatedReasoning: string[] = [];
      const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();
      const legacyProtocolFilter = createLegacyProtocolChunkFilter(onChunk);
      let streamUsage: any = undefined;
      let iterator: AsyncIterator<any> | undefined;

      try {
        const stream: any = await supervisor.request(() => client.chat.completions.create(
          params,
          { signal: supervisor.signal },
        ));
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await supervisor.next(iterator);
          if (next.done) break;
          const chunk = next.value;
          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) {
              accumulatedText.push(delta.content);
              if (String(delta.content).trim()) supervisor.markSemanticContent();
              legacyProtocolFilter.emit(delta.content);
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
                if (tc.id || tc.function?.name || tc.function?.arguments) supervisor.markSemanticContent();
              }
            }
          }
          if (chunk.usage) streamUsage = chunk.usage;
        }
        supervisor.assertSemanticContent();
        legacyProtocolFilter.flush();

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
        const legacyToolCalls = parseLegacyXmlToolCalls(text, toolDeclarations);
        if (legacyToolCalls) {
          return { text: null, toolCalls: legacyToolCalls, reasoningContent, usage };
        }
        return { text, toolCalls: null, reasoningContent, usage };
      } catch (error) {
        supervisor.abort(error instanceof Error ? error : new Error(String(error)));
        stopIterator(iterator);
        throw error;
      }
    };
    const executeStream = () => withCloudResilience(
      consumeStream,
      {
        provider: config.provider,
        model: config.model,
        // Retrying an acquired stream can replay partial output. Candidate
        // failover is owned by dispatch, which buffers until a full success.
        maxRetries: 0,
        signal: config.signal,
      },
    );
    try {
      return supervisedLocal
        ? await runLocalModelInference(config.provider as LocalModelProvider, executeStream, { signal: config.signal })
        : await executeStream();
    } catch (error) {
      if (extensionProvider) throw extensionProviderFailure(config.provider, error);
      throw error;
    }
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
    return withCloudResilience(
      async operationSignal => {
        const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
        const accumulatedText: string[] = [];
        const toolCalls: ParsedToolCall[] = [];
        let iterator: AsyncIterator<any> | undefined;
        try {
          const result: any = await supervisor.request(() => (modelInstance as any).generateContentStream(
            { contents },
            { signal: supervisor.signal },
          ));
          iterator = result.stream[Symbol.asyncIterator]();
          while (true) {
            const next = await supervisor.next(iterator);
            if (next.done) break;
            const chunk = next.value;
            const text = chunk.text();
            if (text) {
              accumulatedText.push(text);
              if (String(text).trim()) supervisor.markSemanticContent();
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
                supervisor.markSemanticContent();
              }
            }
          }

          // The aggregate promise is part of the same health attempt. A
          // handshake and terminal stream are not success until it settles.
          const aggregated = await supervisor.completion(result.response);
          const parsed = parseGeminiResponse(aggregated);
          if (parsed.text?.trim() || (parsed.toolCalls?.length || 0) > 0) supervisor.markSemanticContent();
          supervisor.assertSemanticContent();
          return {
            text: accumulatedText.length > 0 ? accumulatedText.join('') : parsed.text,
            toolCalls: parsed.toolCalls && parsed.toolCalls.length > 0 ? parsed.toolCalls : (toolCalls.length > 0 ? toolCalls : null),
            usage: parsed.usage,
          };
        } catch (error) {
          supervisor.abort(error instanceof Error ? error : new Error(String(error)));
          stopIterator(iterator);
          throw error;
        }
      },
      { provider: 'gemini', model: config.model, maxRetries: 0, signal: config.signal },
    );
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

    return withCloudResilience(
      async operationSignal => {
        const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
        const textParts: string[] = [];
        const toolCalls: ParsedToolCall[] = [];
        const toolUseAccumulators: Map<string, { id: string; name: string; args: Record<string, any> }> = new Map();
        let iterator: AsyncIterator<any> | undefined;
        try {
          const stream: any = await supervisor.request(() => client.messages.stream(
            params,
            { signal: supervisor.signal },
          ));
          iterator = stream[Symbol.asyncIterator]();
          while (true) {
            const next = await supervisor.next(iterator);
            if (next.done) break;
            const event = next.value;
            if (event.type === 'text' && event.text) {
              textParts.push(event.text);
              if (String(event.text).trim()) supervisor.markSemanticContent();
              onChunk(event.text);
            }
            if (event.type === 'content_block_start' && (event as any).content_block?.type === 'tool_use') {
              const block = (event as any).content_block;
              toolUseAccumulators.set(block.id, { id: block.id, name: block.name, args: {} });
              supervisor.markSemanticContent();
            }
            if (event.type === 'content_block_delta' && (event as any).delta?.type === 'input_json_delta') {
              const delta = (event as any).delta;
              const acc = [...toolUseAccumulators.values()].find(a => !a.name || Object.keys(a.args).length === 0);
              if (acc) {
                try { acc.args = { ...acc.args, ...JSON.parse(delta.partial_json || '{}') }; } catch {}
              }
              if (delta.partial_json) supervisor.markSemanticContent();
            }
          }

          const finalMessage: any = await supervisor.completion<any>(stream.finalMessage());
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
                supervisor.markSemanticContent();
              }
            }
          }
          supervisor.assertSemanticContent();
          return {
            text: textParts.length > 0 ? textParts.join('') : null,
            toolCalls: toolCalls.length > 0 ? toolCalls : null,
            usage: extractUsage(finalMessage),
          };
        } catch (error) {
          supervisor.abort(error instanceof Error ? error : new Error(String(error)));
          stopIterator(iterator);
          throw error;
        }
      },
      { provider: 'anthropic', model: config.model, maxRetries: 0, signal: config.signal },
    );
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
