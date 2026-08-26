import {
  NormalizedMessage,
  makeLLMCallDirect,
  makeLLMCallStreamingDirect,
  StreamCallback,
  type ModelAttemptTimeouts,
} from './providers';
import { NormalizedLLMResponse } from '../tools/types';
import {
  resolveAutoLocalModelCandidates,
} from './local_models';
import {
  modelRoutingErrorDigest,
  modelRoutingErrorReason,
  type ModelRouteAttempt,
  type ModelRoutingTrace,
} from './model_routing_receipts';
import type { UserLLMFallbackCandidate, UserLLMSelectionMode } from './user_preferences';
import {
  isRegisteredOpenAICompatibleProvider,
  isRegisteredProviderLocal,
} from '../extensions/registry';
import { isCircuitClosed } from '../cloud/circuit_breaker';
import { recentProviderProbeFailure } from './provider_health';

export interface DispatchConfig {
  /** Explicit cloud fallback selected by the user. Never `auto`. */
  provider: string;
  model: string;
  /** Preferred local model for automatic local-first routing. */
  localModel?: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
  signal?: AbortSignal;
  attemptTimeouts?: Partial<ModelAttemptTimeouts>;
  inputTokenBudget?: number;
  allowCloudFallback?: boolean;
  selectionMode?: UserLLMSelectionMode;
  fallbackCandidates?: UserLLMFallbackCandidate[];
  requestedProvider?: string;
  requestedModel?: string;
}

export interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI: () => any;
  getAnthropic: () => any;
  getQwen: () => any;
  getOllama: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
  isOllamaAvailable?: () => boolean;
  isLmStudioAvailable?: () => boolean;
}

export interface DispatchedLLMResponse extends NormalizedLLMResponse {
  tier: 'local' | 'cloud';
  routing: ModelRoutingTrace;
}

function callArguments(config: DispatchConfig, provider: string, model: string) {
  return {
    provider: provider as any,
    model,
    maxTokens: config.maxTokens,
    userId: config.userId,
    domain: config.domain,
    orgId: config.orgId,
    signal: config.signal,
    attemptTimeouts: config.attemptTimeouts,
    inputTokenBudget: config.inputTokenBudget,
    selectionMode: 'pinned' as const,
    fallbackCandidates: [],
    allowCloudFallback: false,
    authorizedRoutingCandidate: true,
  };
}

function getterArguments(getters: LLMGetters) {
  return [
    getters.getDeepSeek,
    getters.getGemini,
    getters.getOpenAI,
    getters.getAnthropic,
    getters.getQwen,
    getters.getOllama,
    getters.getLmStudio,
    getters.getArk,
    getters.getXiaomi,
    getters.getKimi,
    getters.getGlm,
    getters.getRelay,
  ] as const;
}

function attemptErrorCategory(error: unknown): string {
  const attached = String((error as any)?.cloudCategory || '').trim();
  return attached || modelRoutingErrorReason(error);
}

function completedAttempt(
  candidate: { provider: string; model: string },
  status: ModelRouteAttempt['status'],
  startedAtMs: number,
  options: {
    reason?: string;
    error?: unknown;
    visibleOutputCommitted?: boolean;
  } = {},
): ModelRouteAttempt {
  const completedAtMs = Date.now();
  return {
    ...candidate,
    status,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.error !== undefined ? {
      errorCategory: attemptErrorCategory(options.error),
      errorDigest: modelRoutingErrorDigest(options.error),
    } : {}),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    ...(options.visibleOutputCommitted !== undefined
      ? { visibleOutputCommitted: options.visibleOutputCommitted }
      : {}),
  };
}

function skippedAttempt(
  candidate: { provider: string; model: string },
  reason: string,
): ModelRouteAttempt {
  // No provider call happened. Keep this deterministic instead of measuring
  // event-loop time between two Date.now() calls and occasionally reporting
  // a misleading 1 ms "execution" for a policy/health skip.
  const at = new Date().toISOString();
  return {
    ...candidate,
    status: 'skipped',
    reason,
    startedAt: at,
    completedAt: at,
    durationMs: 0,
  };
}

function providerClientConfigured(provider: string, getters: LLMGetters, userId?: string): boolean | null {
  const getter = provider === 'deepseek' ? getters.getDeepSeek
    : provider === 'gemini' ? getters.getGemini
    : provider === 'openai' ? getters.getOpenAI
    : provider === 'anthropic' ? getters.getAnthropic
    : provider === 'qwen' ? getters.getQwen
    : provider === 'ollama' ? getters.getOllama
    : provider === 'lmstudio' ? getters.getLmStudio
    : provider === 'ark' ? getters.getArk
    : provider === 'xiaomi' ? getters.getXiaomi
    : provider === 'kimi' ? getters.getKimi
    : provider === 'glm' ? getters.getGlm
    : provider === 'relay' ? getters.getRelay
    : undefined;
  if (getter) {
    try { return Boolean(getter()); } catch { return false; }
  }
  // Extension clients are resolved by the signed registry inside the direct
  // adapter. Unknown here means "let that authoritative gate decide".
  if (isRegisteredOpenAICompatibleProvider(provider, userId)) return null;
  return false;
}

function candidateBlockReason(
  candidate: { provider: string; model: string },
  config: DispatchConfig,
  getters: LLMGetters,
  allowUnconfiguredPrimary = false,
): string {
  if (!allowUnconfiguredPrimary && providerClientConfigured(candidate.provider, getters, config.userId) === false) {
    return 'provider_not_configured';
  }
  if (!isCircuitClosed(candidate.provider) || !isCircuitClosed(candidate.provider, candidate.model)) {
    return 'circuit_open';
  }
  if (recentProviderProbeFailure(candidate.provider, candidate.model)) {
    return 'recent_probe_failed';
  }
  return '';
}

function responseHasSemanticContent(result: NormalizedLLMResponse): boolean {
  return Boolean(String(result.text || '').trim() || result.toolCalls?.length);
}

function canFailOverAfter(error: unknown, config: DispatchConfig, visibleOutputCommitted = false): boolean {
  if (config.signal?.aborted || visibleOutputCommitted) return false;
  const reason = modelRoutingErrorReason(error);
  return reason !== 'cancelled' && reason !== 'privacy_policy_blocked';
}

/** Probe both local runtimes and try the exact configured model first. */
async function tryLocal(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<{ result: NormalizedLLMResponse | null; attempts: ModelRouteAttempt[]; selected?: { provider: string; model: string } }> {
  const candidates = await resolveAutoLocalModelCandidates(config.localModel);
  const selected = candidates.slice(0, 8);
  const attempts: ModelRouteAttempt[] = [];

  for (const candidate of selected) {
    const getter = candidate.provider === 'ollama' ? getters.getOllama : getters.getLmStudio;
    if (!getter?.()) {
      attempts.push(skippedAttempt(candidate, 'runtime_client_unavailable'));
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await makeLLMCallDirect(
        messages,
        toolDeclarations,
        callArguments(config, candidate.provider, candidate.model),
        ...getterArguments(getters),
      );
      if (responseHasSemanticContent(result)) {
        attempts.push(completedAttempt(candidate, 'succeeded', startedAt));
        return { result, attempts, selected: { provider: candidate.provider, model: candidate.model } };
      }
      attempts.push(completedAttempt(candidate, 'failed', startedAt, { reason: 'empty_response' }));
      console.log(`[Dispatch] ${candidate.provider}/${candidate.model} returned an empty response`);
    } catch (error: any) {
      if (config.signal?.aborted) throw error;
      attempts.push(completedAttempt(candidate, 'failed', startedAt, {
        reason: modelRoutingErrorReason(error),
        error,
      }));
      console.log(`[Dispatch] ${candidate.provider}/${candidate.model} failed (${error?.message || error})`);
    }
  }
  return { result: null, attempts };
}

function routingTrace(input: {
  config: DispatchConfig;
  selectedProvider?: string;
  selectedModel?: string;
  fallbackReason?: string;
  attempts: ModelRouteAttempt[];
}): ModelRoutingTrace {
  return {
    requestedProvider: String(input.config.requestedProvider || input.config.provider || ''),
    requestedModel: String(input.config.requestedModel || input.config.localModel || input.config.model || ''),
    selectionMode: input.config.selectionMode || 'auto',
    selectedProvider: String(input.selectedProvider || ''),
    selectedModel: String(input.selectedModel || ''),
    fallbackReason: String(input.fallbackReason || ''),
    attempts: input.attempts.map(attempt => ({ ...attempt })),
  };
}

export class ModelRoutingDispatchError extends Error {
  readonly routing: ModelRoutingTrace;

  constructor(message: string, routing: ModelRoutingTrace) {
    super(message);
    this.name = 'ModelRoutingDispatchError';
    this.routing = routing;
  }
}

function orderedCandidates(config: DispatchConfig): Array<{ provider: string; model: string }> {
  const raw = [
    { provider: config.provider, model: config.model },
    ...(config.fallbackCandidates || []),
  ];
  const unique = new Map<string, { provider: string; model: string }>();
  for (const candidate of raw) {
    const provider = String(candidate.provider || '').trim();
    const model = String(candidate.model || '').trim();
    if (!provider || provider === 'auto' || !model) continue;
    const key = `${provider}\u0000${model}`;
    if (!unique.has(key)) unique.set(key, { provider, model });
  }
  return [...unique.values()].slice(0, 12);
}

function isLocalProvider(provider: string, userId?: string): boolean {
  return provider === 'ollama' || provider === 'lmstudio' || isRegisteredProviderLocal(provider, userId);
}

const ROUTE_REASON_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  // Terminal policy/caller decisions are the most important explanation when
  // they are the reason an attempted route stopped.
  cancelled: 1_000,
  privacy_policy_blocked: 950,
  // Actionable provider failures outrank generic availability failures.
  provider_auth_failed: 900,
  quota_or_billing: 850,
  timeout: 800,
  provider_unreachable: 750,
  model_unavailable: 700,
  unsupported_provider_or_model: 650,
  provider_call_failed: 600,
  empty_response: 550,
  unknown_error: 500,
  candidate_failed: 450,
  // Health/configuration skips only explain a route when no candidate was
  // actually attempted and failed.
  circuit_open: 400,
  recent_probe_failed: 350,
  runtime_client_unavailable: 300,
  provider_not_configured: 250,
  candidate_skipped: 200,
});

function routeAttemptReason(attempt: ModelRouteAttempt): string {
  return attempt.reason || (attempt.status === 'skipped' ? 'candidate_skipped' : 'candidate_failed');
}

/**
 * Select one stable top-level diagnostic without discarding the per-candidate
 * attempt history. A real failed call always outranks a candidate that was
 * merely skipped, so a trailing unconfigured optional provider cannot hide a
 * primary quota/auth/timeout/provider failure. Within the selected status we
 * use an explicit priority and preserve route order as the tie-breaker.
 */
function dominantRouteReason(attempts: ModelRouteAttempt[]): string {
  const failed = attempts.filter(attempt => attempt.status === 'failed');
  const candidates = failed.length > 0
    ? failed
    : attempts.filter(attempt => attempt.status === 'skipped');
  let selected = '';
  let selectedPriority = Number.NEGATIVE_INFINITY;
  for (const attempt of candidates) {
    const reason = routeAttemptReason(attempt);
    const priority = ROUTE_REASON_PRIORITY[reason] ?? 0;
    if (priority > selectedPriority) {
      selected = reason;
      selectedPriority = priority;
    }
  }
  return selected;
}

async function dispatchOrderedCall(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<DispatchedLLMResponse> {
  const candidates = orderedCandidates(config);
  const attempts: ModelRouteAttempt[] = [];
  let lastError: unknown = new Error('No configured model candidate is available');
  for (const [index, candidate] of candidates.entries()) {
    // `allowCloudFallback` governs fallback candidates, not the primary model
    // the user explicitly selected. Strict privacy is still enforced inside
    // the direct provider adapter for every cloud call.
    if (index > 0 && config.allowCloudFallback === false && !isLocalProvider(candidate.provider, config.userId)) {
      attempts.push(skippedAttempt(candidate, 'privacy_policy_blocked'));
      continue;
    }
    const blocked = candidateBlockReason(candidate, config, getters, index === 0);
    if (blocked) {
      attempts.push(skippedAttempt(candidate, blocked));
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await makeLLMCallDirect(
        messages,
        toolDeclarations,
        callArguments(config, candidate.provider, candidate.model),
        ...getterArguments(getters),
      );
      if (!responseHasSemanticContent(result)) {
        throw new Error('Model candidate completed without semantic content');
      }
      attempts.push(completedAttempt(candidate, 'succeeded', startedAt));
      return {
        ...result,
        tier: isLocalProvider(candidate.provider, config.userId) ? 'local' : 'cloud',
        routing: routingTrace({
          config,
          selectedProvider: candidate.provider,
          selectedModel: candidate.model,
          fallbackReason: index === 0 ? '' : dominantRouteReason(attempts.slice(0, -1)) || 'primary_failed',
          attempts,
        }),
      };
    } catch (error) {
      if (config.signal?.aborted) throw error;
      lastError = error;
      attempts.push(completedAttempt(candidate, 'failed', startedAt, {
        reason: modelRoutingErrorReason(error),
        error,
      }));
      if (!canFailOverAfter(error, config)) {
        throw new ModelRoutingDispatchError(
          String((error as any)?.message || error),
          routingTrace({ config, attempts, fallbackReason: modelRoutingErrorReason(error) }),
        );
      }
    }
  }
  const trace = routingTrace({ config, attempts, fallbackReason: dominantRouteReason(attempts) || modelRoutingErrorReason(lastError) });
  throw new ModelRoutingDispatchError(String((lastError as any)?.message || lastError), trace);
}

function exactCloudFallback(config: DispatchConfig): { provider: string; model: string } {
  const provider = String(config.provider || '').trim();
  const model = String(config.model || '').trim();
  if (!provider || !model || provider === 'auto') {
    throw new Error('Automatic model routing requires an explicit cloud fallback provider and model');
  }
  return { provider, model };
}

export async function dispatchLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<DispatchedLLMResponse> {
  if (config.selectionMode !== 'auto') {
    return dispatchOrderedCall(messages, toolDeclarations, config, getters);
  }
  const local = await tryLocal(messages, toolDeclarations, config, getters);
  if (local.result && local.selected) {
    return {
      ...local.result,
      tier: 'local',
      routing: routingTrace({
        config,
        selectedProvider: local.selected.provider,
        selectedModel: local.selected.model,
        attempts: local.attempts,
      }),
    };
  }
  if (config.allowCloudFallback === false) {
    const error = new Error('[Privacy] Strict mode: no healthy local LLM/model is available. Start Ollama or LM Studio and load the selected model.');
    throw new ModelRoutingDispatchError(error.message, routingTrace({
      config,
      attempts: local.attempts,
      fallbackReason: 'privacy_policy_blocked',
    }));
  }

  const cloudCandidates = orderedCandidates({
    ...config,
    ...exactCloudFallback(config),
  }).filter(candidate => !isLocalProvider(candidate.provider, config.userId));
  const attempts = [...local.attempts];
  let lastError: unknown = new Error('No cloud fallback is configured');
  for (const fallback of cloudCandidates) {
    console.log(`[Dispatch] Routing to configured cloud fallback: ${fallback.provider}/${fallback.model}`);
    const blocked = candidateBlockReason(fallback, config, getters);
    if (blocked) {
      attempts.push(skippedAttempt(fallback, blocked));
      lastError = new Error(blocked);
      continue;
    }
    const startedAt = Date.now();
    try {
      const cloudResult = await makeLLMCallDirect(
        messages,
        toolDeclarations,
        callArguments(config, fallback.provider, fallback.model),
        ...getterArguments(getters),
      );
      if (!responseHasSemanticContent(cloudResult)) {
        throw new Error('Model candidate completed without semantic content');
      }
      attempts.push(completedAttempt(fallback, 'succeeded', startedAt));
      return {
        ...cloudResult,
        tier: 'cloud',
        routing: routingTrace({
          config,
          selectedProvider: fallback.provider,
          selectedModel: fallback.model,
          fallbackReason: dominantRouteReason(attempts.slice(0, -1)) || 'no_healthy_local_model',
          attempts,
        }),
      };
    } catch (error) {
      if (config.signal?.aborted) throw error;
      lastError = error;
      attempts.push(completedAttempt(fallback, 'failed', startedAt, {
        reason: modelRoutingErrorReason(error),
        error,
      }));
      if (!canFailOverAfter(error, config)) {
        throw new ModelRoutingDispatchError(
          String((error as any)?.message || error),
          routingTrace({ config, attempts, fallbackReason: modelRoutingErrorReason(error) }),
        );
      }
    }
  }
  throw new ModelRoutingDispatchError(
    String((lastError as any)?.message || lastError),
    routingTrace({ config, attempts, fallbackReason: dominantRouteReason(attempts) || modelRoutingErrorReason(lastError) }),
  );
}

export async function dispatchLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  onChunk: StreamCallback,
  getters: LLMGetters,
): Promise<DispatchedLLMResponse> {
  if (config.selectionMode !== 'auto') {
    const candidates = orderedCandidates(config);
    const attempts: ModelRouteAttempt[] = [];
    let lastError: unknown = new Error('No configured model candidate is available');
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0 && config.allowCloudFallback === false && !isLocalProvider(candidate.provider, config.userId)) {
        attempts.push(skippedAttempt(candidate, 'privacy_policy_blocked'));
        continue;
      }
      const blocked = candidateBlockReason(candidate, config, getters, index === 0);
      if (blocked) {
        attempts.push(skippedAttempt(candidate, blocked));
        continue;
      }
      const visibility = createCandidateVisibility(onChunk);
      const startedAt = Date.now();
      let result: NormalizedLLMResponse;
      try {
        result = await attemptStreamingCandidate(messages, toolDeclarations, config, candidate, getters, visibility);
      } catch (error) {
        if (config.signal?.aborted) throw error;
        lastError = error;
        attempts.push(completedAttempt(candidate, 'failed', startedAt, {
          reason: modelRoutingErrorReason(error),
          error,
          visibleOutputCommitted: visibility.committed,
        }));
        if (!canFailOverAfter(error, config, visibility.committed)) {
          throw new ModelRoutingDispatchError(
            String((error as any)?.message || error),
            routingTrace({ config, attempts, fallbackReason: modelRoutingErrorReason(error) }),
          );
        }
        continue;
      }
      attempts.push(completedAttempt(candidate, 'succeeded', startedAt, {
        visibleOutputCommitted: visibility.committed,
      }));
      return {
        ...result,
        tier: isLocalProvider(candidate.provider, config.userId) ? 'local' : 'cloud',
        routing: routingTrace({
          config,
          selectedProvider: candidate.provider,
          selectedModel: candidate.model,
          fallbackReason: index === 0 ? '' : dominantRouteReason(attempts.slice(0, -1)) || 'primary_failed',
          attempts,
        }),
      };
    }
    throw new ModelRoutingDispatchError(
      String((lastError as any)?.message || lastError),
      routingTrace({ config, attempts, fallbackReason: dominantRouteReason(attempts) || modelRoutingErrorReason(lastError) }),
    );
  }

  const localCandidates = (await resolveAutoLocalModelCandidates(config.localModel)).slice(0, 8);
  const attempts: ModelRouteAttempt[] = [];
  for (const candidate of localCandidates) {
    const getter = candidate.provider === 'ollama' ? getters.getOllama : getters.getLmStudio;
    if (!getter?.()) {
      attempts.push(skippedAttempt(candidate, 'runtime_client_unavailable'));
      continue;
    }
    const visibility = createCandidateVisibility(onChunk);
    const startedAt = Date.now();
    let result: NormalizedLLMResponse;
    try {
      result = await attemptStreamingCandidate(messages, toolDeclarations, config, candidate, getters, visibility);
    } catch (error) {
      if (config.signal?.aborted) throw error;
      attempts.push(completedAttempt(candidate, 'failed', startedAt, {
        reason: modelRoutingErrorReason(error),
        error,
        visibleOutputCommitted: visibility.committed,
      }));
      if (!canFailOverAfter(error, config, visibility.committed)) {
        throw new ModelRoutingDispatchError(
          String((error as any)?.message || error),
          routingTrace({ config, attempts, fallbackReason: modelRoutingErrorReason(error) }),
        );
      }
      continue;
    }
    attempts.push(completedAttempt(candidate, 'succeeded', startedAt, {
      visibleOutputCommitted: visibility.committed,
    }));
    return {
      ...result,
      tier: 'local',
      routing: routingTrace({
        config,
        selectedProvider: candidate.provider,
        selectedModel: candidate.model,
        attempts,
      }),
    };
  }

  if (config.allowCloudFallback === false) {
    const error = new Error('[Privacy] Strict mode: no healthy local LLM/model is available. Start Ollama or LM Studio and load the selected model.');
    throw new ModelRoutingDispatchError(error.message, routingTrace({
      config,
      attempts,
      fallbackReason: 'privacy_policy_blocked',
    }));
  }

  const cloudCandidates = orderedCandidates({
    ...config,
    ...exactCloudFallback(config),
  }).filter(candidate => !isLocalProvider(candidate.provider, config.userId));
  let lastError: unknown = new Error('No cloud fallback is configured');
  for (const candidate of cloudCandidates) {
    const blocked = candidateBlockReason(candidate, config, getters);
    if (blocked) {
      attempts.push(skippedAttempt(candidate, blocked));
      continue;
    }
    const visibility = createCandidateVisibility(onChunk);
    const startedAt = Date.now();
    let result: NormalizedLLMResponse;
    try {
      result = await attemptStreamingCandidate(messages, toolDeclarations, config, candidate, getters, visibility);
    } catch (error) {
      if (config.signal?.aborted) throw error;
      lastError = error;
      attempts.push(completedAttempt(candidate, 'failed', startedAt, {
        reason: modelRoutingErrorReason(error),
        error,
        visibleOutputCommitted: visibility.committed,
      }));
      if (!canFailOverAfter(error, config, visibility.committed)) {
        throw new ModelRoutingDispatchError(
          String((error as any)?.message || error),
          routingTrace({ config, attempts, fallbackReason: modelRoutingErrorReason(error) }),
        );
      }
      continue;
    }
    attempts.push(completedAttempt(candidate, 'succeeded', startedAt, {
      visibleOutputCommitted: visibility.committed,
    }));
    return {
      ...result,
      tier: 'cloud',
      routing: routingTrace({
        config,
        selectedProvider: candidate.provider,
        selectedModel: candidate.model,
        fallbackReason: dominantRouteReason(attempts.slice(0, -1)) || 'no_healthy_local_model',
        attempts,
      }),
    };
  }
  throw new ModelRoutingDispatchError(
    String((lastError as any)?.message || lastError),
    routingTrace({ config, attempts, fallbackReason: dominantRouteReason(attempts) || modelRoutingErrorReason(lastError) }),
  );
}

async function attemptStreamingCandidate(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  candidate: { provider: string; model: string },
  getters: LLMGetters,
  visibility: CandidateVisibility,
): Promise<NormalizedLLMResponse> {
  const result = await makeLLMCallStreamingDirect(
    messages,
    toolDeclarations,
    callArguments(config, candidate.provider, candidate.model),
    visibility.accept,
    ...getterArguments(getters),
  );
  if (!String(result.text || '').trim() && !(result.toolCalls?.length)) {
    throw new Error('Model candidate completed without semantic content');
  }
  visibility.finish(result.text);
  return result;
}

interface CandidateVisibility {
  readonly committed: boolean;
  accept: StreamCallback;
  finish: (resultText: string | null) => void;
}

function createCandidateVisibility(onChunk: StreamCallback): CandidateVisibility {
  let committed = false;
  let pending: string[] = [];
  return {
    get committed() { return committed; },
    accept(chunk: string) {
      if (committed) {
        onChunk(chunk);
        return;
      }
      pending.push(chunk);
      if (!String(chunk).trim()) return;
      committed = true;
      for (const buffered of pending) onChunk(buffered);
      pending = [];
    },
    finish(resultText: string | null) {
      if (committed) return;
      if (pending.length > 0) {
        committed = true;
        for (const buffered of pending) onChunk(buffered);
        pending = [];
        return;
      }
      if (resultText) {
        committed = true;
        onChunk(resultText);
      }
    },
  };
}
