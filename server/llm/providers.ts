import { ParsedToolCall, NormalizedLLMResponse } from '../tools/types';
import { withCloudResilience } from '../cloud/resilience';
import { isProviderLocalOnly, isStrictPrivacy, requireLocalProvider } from '../config/privacy';
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
  buildProviderOutboundMessagesEvidence,
  normalizeProviderOutboundMessagesEvidence,
  type ProviderOutboundMessagesEvidence,
} from './outbound_message_evidence';
import {
  assertRegisteredProviderModel,
  getRegisteredOpenAIClient,
  isExtensionProviderId,
  isRegisteredOpenAICompatibleProvider,
  isRegisteredProviderLocal,
} from '../extensions/registry';
import { prepareModelRequestContext } from './request_context_budget';

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
  nativeDeviceId?: string;
  executionSessionId?: string;
  nativeClientIdentitySha256?: string;
  audioInputKind?: 'physical_microphone' | 'synthetic_accepted_transcript';
  syntheticAudio?: boolean;
  captureSessionId?: string;
  sttReceiptId?: string;
  contextChainId?: string;
  previousRequestId?: string;
  interactionId?: string;
  source?: string;
  responseFormat?: LLMResponseFormat;
  signal?: AbortSignal;
  /** Provider-independent lifecycle deadlines for one model attempt. */
  attemptTimeouts?: Partial<ModelAttemptTimeouts>;
  /** Total input budget across system, history, current input, and tool schemas. */
  inputTokenBudget?: number;
  role?: 'reasoning' | 'vision' | 'world';
  selectionMode?: UserLLMSelectionMode;
  fallbackCandidates?: UserLLMFallbackCandidate[];
  allowCloudFallback?: boolean;
  /** Per-request routing boundary. Unlike global strict mode, this survives graph recovery. */
  dataRoutingPolicy?: 'policy_scoped' | 'local_only';
  /**
   * Execute exactly `provider`/`model` and never consult stored preferences,
   * automatic routing, or fallbackCandidates. Model-graph execution sets this
   * because the graph itself is the authoritative, budgeted failover plan.
   */
  noImplicitFailover?: boolean;
  /** True only for a candidate compiled from the user's stored route policy. */
  authorizedRoutingCandidate?: boolean;
  /** Local-only declaration names that preflight must retain or fail closed. */
  localRequiredToolNames?: string[];
  /**
   * Opt in to SSE for the official relay.  The currently deployed official
   * gateway accepts the OpenAI-compatible request but its SSE parser is
   * unreliable, so the safe/default transport is a single non-stream call.
   * This escape hatch is intentionally per-call and is not user-controlled
   * through chat text.
   */
  relayStreaming?: boolean;
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
  /** Server-only durable transcript provenance; never serialized to a provider. */
  sourceMessageId?: string;
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

const providerSourceUserSlots = new WeakMap<object, string>();

function markProviderSourceUserSlot<T extends object>(message: T, sourceMessageId: unknown): T {
  const durableId = String(sourceMessageId || '').trim();
  if (durableId) providerSourceUserSlots.set(message, durableId);
  return message;
}

function providerSourceUserSlot(messages: object[]): {
  sourceMessageId?: string;
  sourceMessageIndex: number | null;
} {
  let found: { sourceMessageId: string; sourceMessageIndex: number } | null = null;
  messages.forEach((message, sourceMessageIndex) => {
    const sourceMessageId = providerSourceUserSlots.get(message);
    if (!sourceMessageId) return;
    if (found) throw new Error('provider_outbound_multiple_source_messages');
    found = { sourceMessageId, sourceMessageIndex };
  });
  return found || { sourceMessageIndex: null };
}

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
  if (!isStrictPrivacy() && config.dataRoutingPolicy !== 'local_only') return;
  if (extensionProviderForCall(config)) {
    if (!isRegisteredProviderLocal(config.provider, config.userId)) {
      throw new Error(`[Privacy] Local-only routing active. Extension provider "${config.provider}" is not declared as a loopback-only local provider.`);
    }
    return;
  }
  if (config.dataRoutingPolicy === 'local_only' && !isProviderLocalOnly(config.provider)) {
    throw new Error(`[Privacy] Local-only routing active. Cloud provider "${config.provider}" is blocked. Use ollama or lmstudio.`);
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
    inputTokenBudget: config.inputTokenBudget,
    allowCloudFallback: config.allowCloudFallback !== false
      && preferred?.allowCloudFallback !== false
      && !isStrictPrivacy(),
  };
}

/**
 * An explicit caller budget is a contract. Classifiers and other bounded
 * control-plane calls must not silently become 4k-token reasoning requests
 * merely because the selected model can reason. Full reasoning calls that do
 * not provide a budget keep the generous default.
 */
export function resolveModelMaxTokens(model: string, requested?: number): number | undefined {
  if (Number.isFinite(requested) && Number(requested) > 0) {
    return Math.max(1, Math.floor(Number(requested)));
  }
  return isReasoningModel(model) ? 8_000 : undefined;
}

function pinnedFailoverDispatchPreference(config: LLMCallConfig) {
  if (config.noImplicitFailover === true) return null;
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

/**
 * Normalize a completed OpenAI-compatible response, including the legacy XML
 * function-call protocol some gateways emit when their streaming adapter is
 * unavailable.  Keeping this in one place makes the relay's non-stream
 * fallback behave exactly like the normal streaming parser.
 */
function parseOpenAICompatibleResponse(
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

type ResponseWithProviderOutboundEvidence = NormalizedLLMResponse & {
  _providerOutboundMessagesEvidence?: ProviderOutboundMessagesEvidence;
};

type ErrorWithProviderOutboundEvidence = Error & {
  providerOutboundMessagesEvidence?: ProviderOutboundMessagesEvidence;
};

function attachProviderOutboundEvidence(
  response: NormalizedLLMResponse,
  evidence: ProviderOutboundMessagesEvidence,
): ResponseWithProviderOutboundEvidence {
  return { ...response, _providerOutboundMessagesEvidence: evidence };
}

function providerOutboundEvidenceFrom(value: unknown): ProviderOutboundMessagesEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return normalizeProviderOutboundMessagesEvidence(
    (value as ResponseWithProviderOutboundEvidence)._providerOutboundMessagesEvidence
      || (value as ErrorWithProviderOutboundEvidence).providerOutboundMessagesEvidence,
  ) || undefined;
}

function attachProviderOutboundEvidenceToError(
  error: unknown,
  evidence: ProviderOutboundMessagesEvidence,
): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperty(target, 'providerOutboundMessagesEvidence', {
      configurable: true,
      enumerable: false,
      value: evidence,
      writable: false,
    });
    return target;
  } catch {
    const wrapped = new Error(target.message, { cause: target });
    wrapped.name = target.name;
    Object.defineProperty(wrapped, 'providerOutboundMessagesEvidence', {
      configurable: false,
      enumerable: false,
      value: evidence,
      writable: false,
    });
    return wrapped;
  }
}

async function executeWithProviderOutboundEvidence(
  evidence: ProviderOutboundMessagesEvidence,
  operation: () => Promise<NormalizedLLMResponse>,
): Promise<ResponseWithProviderOutboundEvidence> {
  try {
    return attachProviderOutboundEvidence(await operation(), evidence);
  } catch (error) {
    throw attachProviderOutboundEvidenceToError(error, evidence);
  }
}

function withoutPrivateProviderOutboundEvidence(
  response: ResponseWithProviderOutboundEvidence,
): NormalizedLLMResponse {
  const result = { ...response };
  delete result._providerOutboundMessagesEvidence;
  return result;
}

function traceWithProviderOutboundEvidence(
  trace: ModelRoutingTrace,
  evidence: ProviderOutboundMessagesEvidence | undefined,
  status: 'succeeded' | 'failed',
): ModelRoutingTrace {
  if (!evidence) return trace;
  let attached = false;
  const attempts = trace.attempts.map(attempt => {
    const matches = attempt.provider === evidence.provider
      && attempt.model === evidence.model
      && attempt.status === status;
    if (!matches || attached) return attempt;
    attached = true;
    return { ...attempt, outboundMessagesEvidence: evidence };
  });
  if (!attached) {
    // Never mint a new routing attempt from evidence alone. A provider payload
    // without the matching real attempt remains intentionally unpersisted.
    return trace;
  }
  return { ...trace, attempts };
}

function persistRoutingTrace(
  config: LLMCallConfig,
  trace: ModelRoutingTrace,
  status: 'succeeded' | 'failed',
  startedAtMs: number,
  outboundMessagesEvidence?: ProviderOutboundMessagesEvidence,
): string | undefined {
  try {
    const persistedTrace = traceWithProviderOutboundEvidence(
      trace,
      outboundMessagesEvidence,
      status,
    );
    const receipt = persistModelRoutingReceipt({
      userId: config.userId || 'anonymous',
      domain: config.domain || 'personal',
      orgId: config.orgId || '',
      conversationId: config.conversationId || '',
      requestId: config.requestId || '',
      nativeDeviceId: config.nativeDeviceId || '',
      executionSessionId: config.executionSessionId || '',
      nativeClientIdentitySha256: config.nativeClientIdentitySha256 || '',
      audioInputKind: config.audioInputKind,
      syntheticAudio: config.syntheticAudio,
      captureSessionId: config.captureSessionId || '',
      sttReceiptId: config.sttReceiptId || '',
      contextChainId: config.contextChainId || '',
      previousRequestId: config.previousRequestId || '',
      interactionId: config.interactionId || '',
      source: config.source || '',
      status,
      ...persistedTrace,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
    return receipt.id;
  } catch (error) {
    // Production initializes the durable database before serving calls. Some
    // isolated provider harnesses intentionally omit it; never replace a real
    // model result with a fabricated receipt in that environment.
    console.warn('[ModelRouting] Could not persist routing receipt:', (error as Error)?.message || error);
    return undefined;
  }
}

function resolvedSelectionMode(config: LLMCallConfig): UserLLMSelectionMode {
  // An exact candidate is deliberately reduced to the direct provider path.
  // In particular, `auto` is not meaningful under this contract and will be
  // rejected by the direct adapter instead of silently expanding into a route.
  if (config.noImplicitFailover === true) return 'pinned';
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
    const outboundMessagesEvidence = providerOutboundEvidenceFrom(result);
    const trace = result.routing || directRoutingTrace(config, 'succeeded');
    const routingReceiptId = persistRoutingTrace(
      config,
      trace,
      'succeeded',
      startedAt,
      outboundMessagesEvidence,
    );
    return {
      ...withoutPrivateProviderOutboundEvidence(result),
      routing: trace,
      ...(routingReceiptId ? { routingReceiptId } : {}),
    };
  } catch (error) {
    const trace = (error as any)?.routing as ModelRoutingTrace | undefined
      || directRoutingTrace(config, 'failed', error);
    persistRoutingTrace(
      config,
      trace,
      'failed',
      startedAt,
      providerOutboundEvidenceFrom(error),
    );
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
  const preparedContext = prepareModelRequestContext({
    messages,
    toolDeclarations,
    inputTokenBudget: config.inputTokenBudget,
  });
  messages = preparedContext.messages;
  toolDeclarations = preparedContext.toolDeclarations;
  assertQwenAllowedByUserPrefs(config);

  // ── Privacy gate: strict mode blocks cloud providers ──
  // Reasoning models need high token budget — their CoT eats into max_tokens
  const maxTokens = resolveModelMaxTokens(config.model, config.maxTokens);

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
      ? prepareLocalModelRequest({
          messages,
          toolDeclarations,
          maxTokens,
          compactToolDeclarations: true,
          requiredToolNames: config.localRequiredToolNames,
        })
      : null;
    const params: any = fmt({
      model: config.model,
      messages: localRequest?.messages || messages,
      toolDeclarations: localRequest?.toolDeclarations || toolDeclarations,
      maxTokens: localRequest?.maxTokens || maxTokens,
      responseFormat: config.responseFormat,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    if (config.provider === 'xiaomi') {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'openai_compatible',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      ...outboundSourceSlot,
    });

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
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
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
    });
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

    const outboundSourceSlot = providerSourceUserSlot(contents);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'gemini',
      messages: contents,
      toolDeclarations: modelConfig.tools || [],
      system: modelConfig.systemInstruction,
      ...outboundSourceSlot,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
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
    });
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

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'openai_compatible',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      ...outboundSourceSlot,
    });

    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
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
    });
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

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'anthropic',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      system: params.system,
      ...outboundSourceSlot,
    });

    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
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
    });
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

/**
 * A few OpenAI-compatible gateways accept `stream: true` but fail while
 * opening/terminating the SSE response (for example `chat_stream_error`).
 * Only those transport/protocol failures are eligible for the relay fallback;
 * authentication, quota, and ordinary network failures must still surface so
 * dispatch can make an informed routing decision instead of issuing a second
 * billable request blindly.
 */
function isRelayStreamingFallbackError(error: unknown): boolean {
  const messages: string[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const values = [
      current?.message,
      current?.code,
      current?.type,
      current?.error?.message,
      current?.error?.code,
      current?.response?.data,
      current?.body,
    ];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      let message = '';
      try { message = typeof value === 'string' ? value : JSON.stringify(value); } catch { /* ignore malformed provider metadata */ }
      if (message?.trim()) messages.push(message.trim());
    }
    current = current?.cause;
  }
  const text = messages.join(' | ');
  return /chat[_ -]?stream[_ -]?error|stream(?:ing)?\s+(?:error|failed|unsupported|unavailable|not supported)|(?:not|isn't)\s+(?:an?\s+)?async(?:\s+)?iterable|without semantic content|(?:could not|unable to|failed to)\s+(?:parse|decode).*json|json(?:\s+parse|\s+decod)|unexpected token|invalid\s+json/i.test(text);
}

/**
 * Do not replay a relay request when the gateway has already told us that the
 * credential, account, or route is invalid. Those failures need to remain
 * visible to the normal route policy; only a response-format/streaming fault
 * should be transparently retried as a non-stream request.
 */
function isRelayNonRetryableStreamingError(error: unknown): boolean {
  const status = Number((error as any)?.status || (error as any)?.response?.status || 0);
  if ([401, 402, 403, 404, 429].includes(status)) return true;
  const values: string[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    for (const value of [current?.message, current?.type, current?.code, current?.error?.message, current?.error?.type]) {
      if (value !== undefined && value !== null) values.push(String(value));
    }
    current = current?.cause;
  }
  return /(?:unauthori[sz]ed|forbidden|invalid\s+(?:api\s*)?key|quota|insufficient\s+balance|overdue|payment\s+required|access\s+denied)/i.test(values.join(' | '));
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
    const outboundMessagesEvidence = providerOutboundEvidenceFrom(result);
    const trace = result.routing || directRoutingTrace(config, 'succeeded');
    const routingReceiptId = persistRoutingTrace(
      config,
      trace,
      'succeeded',
      startedAt,
      outboundMessagesEvidence,
    );
    return {
      ...withoutPrivateProviderOutboundEvidence(result),
      routing: trace,
      ...(routingReceiptId ? { routingReceiptId } : {}),
    };
  } catch (error) {
    const trace = (error as any)?.routing as ModelRoutingTrace | undefined
      || directRoutingTrace(config, 'failed', error);
    persistRoutingTrace(
      config,
      trace,
      'failed',
      startedAt,
      providerOutboundEvidenceFrom(error),
    );
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
  const preparedContext = prepareModelRequestContext({
    messages,
    toolDeclarations,
    inputTokenBudget: config.inputTokenBudget,
  });
  messages = preparedContext.messages;
  toolDeclarations = preparedContext.toolDeclarations;
  assertQwenAllowedByUserPrefs(config);

  // ── Privacy gate ──
  if (config.provider !== 'auto') assertProviderAllowedByPrivacy(config);

  // Reasoning models need high token budget
  const maxTokens = resolveModelMaxTokens(config.model, config.maxTokens);

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
      ? prepareLocalModelRequest({
          messages,
          toolDeclarations,
          maxTokens,
          compactToolDeclarations: true,
          requiredToolNames: config.localRequiredToolNames,
        })
      : null;
    const params: any = fmt({
      model: config.model,
      messages: localRequest?.messages || messages,
      toolDeclarations: localRequest?.toolDeclarations || toolDeclarations,
      maxTokens: localRequest?.maxTokens || maxTokens,
      responseFormat: config.responseFormat,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    if (config.provider === 'xiaomi' || (config.provider === 'openai' && isReasoningModel(config.model))) {
      if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }
    // The official relay currently fails its SSE endpoint after an empty
    // handshake frame.  Use the reliable JSON response by default; callers
    // may explicitly opt in after verifying a relay deployment's streaming
    // contract.  Other OpenAI-compatible providers retain normal streaming.
    const relayStreamingEnabled = config.provider !== 'relay'
      || config.relayStreaming === true
      || /^(1|true|yes|on)$/i.test(String(process.env.RELAY_ENABLE_STREAMING || '').trim());
    params.stream = relayStreamingEnabled;

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'openai_compatible',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      ...outboundSourceSlot,
    });

    // Some official relay deployments accept the OpenAI-compatible request
    // but currently fail their SSE path with an empty first frame followed by
    // `chat_stream_error`.  Keep track of semantic output so a transport
    // failure after partial output is never replayed into the conversation.
    let relayStreamSemanticSeen = false;
    let relayStreamFrameSeen = false;

    const consumeStream = async (operationSignal?: AbortSignal): Promise<NormalizedLLMResponse> => {
      relayStreamSemanticSeen = false;
      relayStreamFrameSeen = false;
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
          relayStreamFrameSeen = true;
          const chunk = next.value;
          if (config.provider === 'relay' && chunk?.error) {
            const relayError = chunk.error;
            const detail = typeof relayError === 'string'
              ? relayError
              : String(relayError.message || relayError.code || 'relay stream error');
            const error = new Error(detail);
            if (relayError && typeof relayError === 'object' && relayError.code) {
              (error as any).code = relayError.code;
            }
            throw error;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) {
              accumulatedText.push(delta.content);
              if (String(delta.content).trim()) {
                relayStreamSemanticSeen = true;
                supervisor.markSemanticContent();
              }
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
                if (tc.id || tc.function?.name || tc.function?.arguments) {
                  relayStreamSemanticSeen = true;
                  supervisor.markSemanticContent();
                }
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

    /**
     * Retry the same request without SSE when the relay's streaming protocol
     * itself is the failure.  This runs inside the same cloud-resilience
     * attempt, so a successful fallback records one successful provider call
     * and does not open the relay circuit because of the expected stream quirk.
     */
    const consumeRelayNonStreaming = async (operationSignal?: AbortSignal): Promise<NormalizedLLMResponse> => {
      const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
      const nonStreamingParams = { ...params, stream: false };
      try {
        const response = await supervisor.request(() => client.chat.completions.create(
          nonStreamingParams,
          { signal: supervisor.signal },
        ));
        const parsed = parseOpenAICompatibleResponse(response, toolDeclarations);
        if (!String(parsed.text || '').trim() && !(parsed.toolCalls?.length)) {
          supervisor.assertSemanticContent();
        }
        supervisor.markSemanticContent();
        // The stream path has already buffered output until a semantic frame;
        // emit the completed non-stream result exactly once.
        if (parsed.text) onChunk(parsed.text);
        return parsed;
      } catch (error) {
        supervisor.abort(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    };

    const executeRelayStreamWithFallback = async (operationSignal?: AbortSignal): Promise<NormalizedLLMResponse> => {
      try {
        return await consumeStream(operationSignal);
      } catch (streamError) {
        // Never replay a request after visible or structured output has been
        // emitted, and never mask caller cancellation with a second request.
        // The official gateway has returned parser/SDK errors with an almost
        // empty error object (the useful `chat_stream_error` only appeared in
        // the raw SSE body).  Requiring a recognised message or a frame here
        // therefore made the recovery branch unreachable in production.  A
        // relay failure before any semantic output is, by definition, safe to
        // retry as a transport-shape fallback; keep only cancellation,
        // credential/quota and partial-output guards as hard exclusions.
        if (config.provider !== 'relay'
          || relayStreamSemanticSeen
          || operationSignal?.aborted
          || config.signal?.aborted
          || isRelayNonRetryableStreamingError(streamError)) {
          throw streamError;
        }
        console.warn('[LLM] Official relay streaming failed before semantic output; retrying non-stream transport.', {
          frameSeen: relayStreamFrameSeen,
          error: streamError instanceof Error ? streamError.message : String(streamError),
        });
        return consumeRelayNonStreaming(operationSignal);
      }
    };

    const executeStream = () => withCloudResilience(
      config.provider === 'relay'
        ? (relayStreamingEnabled ? executeRelayStreamWithFallback : consumeRelayNonStreaming)
        : consumeStream,
      {
        provider: config.provider,
        model: config.model,
        // Retrying an acquired stream can replay partial output. Candidate
        // failover is owned by dispatch, which buffers until a full success.
        maxRetries: 0,
        signal: config.signal,
      },
    );
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
      try {
        return supervisedLocal
          ? await runLocalModelInference(config.provider as LocalModelProvider, executeStream, { signal: config.signal })
          : await executeStream();
      } catch (error) {
        if (extensionProvider) throw extensionProviderFailure(config.provider, error);
        throw error;
      }
    });
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

    const outboundSourceSlot = providerSourceUserSlot(contents);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'gemini',
      messages: contents,
      toolDeclarations: modelConfig.tools || [],
      system: modelConfig.systemInstruction,
      ...outboundSourceSlot,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => withCloudResilience(
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
    ));
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

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'anthropic',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      system: params.system,
      ...outboundSourceSlot,
    });

    return executeWithProviderOutboundEvidence(outboundEvidence, async () => withCloudResilience(
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
    ));
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
