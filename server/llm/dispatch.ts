import { type ProviderGetters as SharedProviderGetters, providerGetterArguments as getterArguments } from "./provider_getters";
import { ModelAttemptDeadlineError } from './provider/deadlines';
import type { NormalizedMessage, StreamCallback, LLMCallConfig } from './provider/contracts';
import { makeLLMCallDirect } from './provider/buffered';
import { makeLLMCallStreamingDirect } from './provider/streaming';
import { NormalizedLLMResponse } from '../tools/types';
import {
  resolveAutoLocalModelCandidates,
} from './local_models';
import {
  modelRoutingErrorDigest,
  modelAttemptCompletion,
  modelRoutingErrorReason,
  type ModelRouteAttempt,
  type ModelRoutingTrace,
} from './model_routing_receipts';
import {
  isRegisteredOpenAICompatibleProvider,
  isRegisteredProviderLocal,
} from '../extensions/registry';
import { isCircuitClosed, getProviderConfigurationEpoch } from '../cloud/circuit_breaker';
import { modelCandidateKey } from './model_turn_state';
import { recentProviderProbeFailure } from './provider_health';
import { buildModelExecutionAwareness } from '../cognition/vision_routing';
import {
  providerOutboundEvidenceFrom,
} from './provider/outbound_evidence';

export interface DispatchConfig extends LLMCallConfig {
  /** Explicit cloud fallback selected by the user. Never `auto`. */
  provider: string;
  model: string;
  /** Preferred local model for automatic local-first routing. */
  localModel?: string;
  requestedProvider?: string;
  requestedModel?: string;
}

export type LLMGetters = SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama'>>;

export interface DispatchedLLMResponse extends NormalizedLLMResponse {
  tier: 'local' | 'cloud';
  routing: ModelRoutingTrace;
}

function messagesForCandidate(
  messages: NormalizedMessage[],
  config: DispatchConfig,
  candidate: { provider: string; model: string },
): NormalizedMessage[] {
  const firstConversationMessage = messages.findIndex(message => message.role !== 'system');
  const insertAt = firstConversationMessage < 0 ? messages.length : firstConversationMessage;
  // Each attempt receives a fresh note; neither the shared transcript nor the
  // configured preference is mutated when a later candidate takes over.
  return [
    ...messages.slice(0, insertAt),
    { role: 'system', content: buildModelExecutionAwareness({
      provider: config.requestedProvider || config.provider,
      model: config.requestedModel || config.model,
    }, candidate) },
    ...messages.slice(insertAt),
  ];
}

function callArguments(config: DispatchConfig, provider: string, model: string) {
  return {
    ...config,
    provider: provider as any,
    model,
    selectionMode: 'pinned' as const,
    fallbackCandidates: [],
    allowCloudFallback: false,
    authorizedRoutingCandidate: true,
  };
}


function attemptErrorCategory(error: unknown): string {
  const reason = modelRoutingErrorReason(error);
  const attached = String((error as any)?.cloudCategory || '').trim();
  return reason === 'empty_response' || reason === 'output_limit' ? reason : attached || reason;
}

function completedAttempt(
  candidate: { provider: string; model: string },
  status: ModelRouteAttempt['status'],
  startedAtMs: number,
  options: {
    reason?: string;
    error?: unknown;
    response?: NormalizedLLMResponse;
    visibleOutputCommitted?: boolean;
    configurationEpoch?: string;
  } = {},
): ModelRouteAttempt {
  const completedAtMs = Date.now();
  const outboundMessagesEvidence = providerOutboundEvidenceFrom(
    options.response || options.error,
  );
  return {
    ...candidate,
    status,
    ...(options.configurationEpoch ? { configurationEpoch: options.configurationEpoch } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.error !== undefined ? {
      errorCategory: attemptErrorCategory(options.error),
      errorDigest: modelRoutingErrorDigest(options.error),
    } : {}),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    ...(outboundMessagesEvidence ? { outboundMessagesEvidence } : {}),
    ...modelAttemptCompletion(options.response || (options.error instanceof ModelAttemptDeadlineError ? options.error : {})),
    ...(options.visibleOutputCommitted !== undefined
      ? { visibleOutputCommitted: options.visibleOutputCommitted }
      : {}),
  };
}

function errorWithRoutingTrace(error: unknown, routing: ModelRoutingTrace): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperty(target, 'routing', {
      configurable: true,
      enumerable: false,
      value: routing,
      writable: false,
    });
    return target;
  } catch {
    const wrapped = new Error(target.message, { cause: target });
    wrapped.name = target.name;
    Object.defineProperty(wrapped, 'routing', {
      configurable: false,
      enumerable: false,
      value: routing,
      writable: false,
    });
    return wrapped;
  }
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
  if (config.modelTurnState?.failedCandidates.has(modelCandidateKey(candidate.provider, candidate.model))) {
    return 'failed_earlier_this_turn';
  }
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

function routeAttemptReason(attempt: ModelRouteAttempt): string {
  return attempt.reason || (attempt.status === 'skipped' ? 'candidate_skipped' : 'candidate_failed');
}

/** Preserve route order; a skipped candidate cannot replace an actual failure. */
function dominantRouteReason(attempts: ModelRouteAttempt[]): string {
  const first = attempts.find(attempt => attempt.status === 'failed')
    || attempts.find(attempt => attempt.status === 'skipped');
  return first ? routeAttemptReason(first) : '';
}

type RoutingCandidate = { provider: string; model: string };
type RoutingPhase = 'ordered' | 'local' | 'cloud';

/** One attempt ledger for buffered and streaming calls, including local-first routing. */
async function dispatchCandidatePhase(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
  candidates: RoutingCandidate[],
  phase: RoutingPhase,
  attempts: ModelRouteAttempt[],
  onChunk?: StreamCallback,
): Promise<{ result?: DispatchedLLMResponse; lastError: unknown }> {
  let lastError: unknown = new Error(phase === 'cloud'
    ? 'No cloud fallback is configured' : 'No configured model candidate is available');
  for (const [index, candidate] of candidates.entries()) {
    const getter = candidate.provider === 'ollama' ? getters.getOllama : getters.getLmStudio;
    const blocked = phase === 'local'
      ? (!getter?.() ? 'runtime_client_unavailable' : '')
      : phase === 'ordered' && index > 0 && config.allowCloudFallback === false
        && !isLocalProvider(candidate.provider, config.userId)
        ? 'privacy_policy_blocked'
        : candidateBlockReason(candidate, config, getters, phase === 'ordered' && index === 0);
    if (blocked) {
      attempts.push(skippedAttempt(candidate, blocked));
      // Policy/configuration skips must not replace an attempted primary failure.
      if (phase !== 'ordered') lastError = new Error(blocked);
      continue;
    }
    config.signal?.throwIfAborted();
    const visibility = onChunk
      ? createCandidateVisibility(onChunk, config.bufferStreamUntilCandidateSuccess === true)
      : undefined;
    const startedAt = Date.now();
    const configurationEpoch = getProviderConfigurationEpoch(candidate.provider);
    let result: NormalizedLLMResponse | undefined;
    try {
      const candidateMessages = messagesForCandidate(messages, config, candidate);
      const arguments_ = callArguments(config, candidate.provider, candidate.model);
      result = visibility
        ? await makeLLMCallStreamingDirect(candidateMessages, toolDeclarations, arguments_, visibility.accept, ...getterArguments(getters))
        : await makeLLMCallDirect(candidateMessages, toolDeclarations, arguments_, ...getterArguments(getters));
      config.signal?.throwIfAborted();
      if (!responseHasSemanticContent(result)) throw new Error('Model candidate completed without semantic content');
      visibility?.finish(result.text, config.bufferStreamUntilCandidateSuccess === true && Boolean(result.toolCalls?.length));
    } catch (error) {
      const reason = config.signal?.aborted ? 'cancelled'
        : result && !responseHasSemanticContent(result) ? 'empty_response' : modelRoutingErrorReason(error);
      lastError = error;
      attempts.push(completedAttempt(candidate, 'failed', startedAt, {
        reason, error, response: result, configurationEpoch,
        ...(visibility ? { visibleOutputCommitted: visibility.committed } : {}),
      }));
      const routing = routingTrace({ config, attempts, fallbackReason: reason });
      if (config.signal?.aborted) throw errorWithRoutingTrace(error, routing);
      if (!canFailOverAfter(error, config, visibility?.committed)) {
        throw new ModelRoutingDispatchError(String((error as any)?.message || error), routing);
      }
      continue;
    }
    attempts.push(completedAttempt(candidate, 'succeeded', startedAt, {
      response: result, configurationEpoch,
      ...(visibility ? { visibleOutputCommitted: visibility.committed } : {}),
    }));
    return {
      lastError,
      result: {
        ...result!,
        tier: isLocalProvider(candidate.provider, config.userId) ? 'local' : 'cloud',
        routing: routingTrace({
          config, attempts,
          selectedProvider: candidate.provider,
          selectedModel: candidate.model,
          fallbackReason: phase === 'local' || phase === 'ordered' && index === 0 ? ''
            : dominantRouteReason(attempts.slice(0, -1)) || (phase === 'cloud' ? 'no_healthy_local_model' : 'primary_failed'),
        }),
      },
    };
  }
  return { lastError };
}

function exactCloudFallback(config: DispatchConfig): RoutingCandidate {
  const provider = String(config.provider || '').trim();
  const model = String(config.model || '').trim();
  if (!provider || !model || provider === 'auto') {
    throw new Error('Automatic model routing requires an explicit cloud fallback provider and model');
  }
  return { provider, model };
}

async function dispatchCall(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
  onChunk?: StreamCallback,
): Promise<DispatchedLLMResponse> {
  const attempts: ModelRouteAttempt[] = [];
  if (config.selectionMode === 'auto') {
    const local = await dispatchCandidatePhase(messages, toolDeclarations, config, getters,
      (await resolveAutoLocalModelCandidates(config.localModel)).slice(0, 8), 'local', attempts, onChunk);
    if (local.result) return local.result;
    if (config.allowCloudFallback === false) {
      throw new ModelRoutingDispatchError(
        '[Privacy] Strict mode: no healthy local LLM/model is available. Start Ollama or LM Studio and load the selected model.',
        routingTrace({ config, attempts, fallbackReason: 'privacy_policy_blocked' }),
      );
    }
  }
  const phase = config.selectionMode === 'auto' ? 'cloud' : 'ordered';
  const candidates = phase === 'cloud'
    ? orderedCandidates({ ...config, ...exactCloudFallback(config) }).filter(candidate => !isLocalProvider(candidate.provider, config.userId))
    : orderedCandidates(config);
  const outcome = await dispatchCandidatePhase(messages, toolDeclarations, config, getters, candidates, phase, attempts, onChunk);
  if (outcome.result) return outcome.result;
  throw new ModelRoutingDispatchError(
    String((outcome.lastError as any)?.message || outcome.lastError),
    routingTrace({ config, attempts, fallbackReason: dominantRouteReason(attempts) || modelRoutingErrorReason(outcome.lastError) }),
  );
}

export function dispatchLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<DispatchedLLMResponse> {
  return dispatchCall(messages, toolDeclarations, config, getters);
}

export function dispatchLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  onChunk: StreamCallback,
  getters: LLMGetters,
): Promise<DispatchedLLMResponse> {
  return dispatchCall(messages, toolDeclarations, config, getters, onChunk);
}

interface CandidateVisibility {
  readonly committed: boolean;
  accept: StreamCallback;
  finish: (resultText: string | null, discardPending?: boolean) => void;
}

function createCandidateVisibility(
  onChunk: StreamCallback,
  bufferUntilSuccess = false,
): CandidateVisibility {
  let committed = false;
  let pending: string[] = [];
  return {
    get committed() { return committed; },
    accept(chunk: string) {
      if (bufferUntilSuccess) {
        pending.push(chunk);
        return;
      }
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
    finish(resultText: string | null, discardPending = false) {
      if (committed) return;
      if (discardPending) {
        // Tool-selection narration is only a model proposal. The adapter must
        // execute and adjudicate the calls before any user-visible status is
        // emitted, so discard this candidate's buffered prose.
        pending = [];
        return;
      }
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
