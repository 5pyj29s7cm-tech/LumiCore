import { readDB, writeDB } from '../../db_layer';
import { resetCircuit } from '../cloud/circuit_breaker';

export type LocalModelProvider = 'ollama' | 'lmstudio';

export interface LocalModelConfig {
  baseUrl: string;
  detected: boolean;
  models: string[];
  serviceReachable?: boolean;
  inferenceHealthy?: boolean;
  healthStatus?: 'healthy' | 'catalog_only' | 'backoff' | 'unavailable';
  lastInferenceAt?: string;
  lastInferenceLatencyMs?: number;
  consecutiveFailures?: number;
  nextRetryAt?: string;
  updatedAt?: string;
  lastError?: string;
}

export interface LocalModelProbeResult extends LocalModelConfig {
  latencyMs: number;
}

export interface LocalModelSelection {
  provider: LocalModelProvider;
  model: string;
  baseUrl: string;
}

export interface LocalModelQueueSnapshot {
  provider: LocalModelProvider;
  concurrency: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  rejected: number;
  maxObservedQueue: number;
}

export const LOCAL_MODEL_DEFAULT_URLS: Record<LocalModelProvider, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
};

const SETTING_KEYS: Record<LocalModelProvider, string> = {
  ollama: 'ollama_config',
  lmstudio: 'lmstudio_config',
};
const LOCAL_PROBE_TTL_MS = Math.max(2_000, Number(process.env.LUMI_LOCAL_MODEL_PROBE_TTL_MS) || 15_000);
const probeInFlight = new Map<LocalModelProvider, Promise<LocalModelProbeResult>>();
const LOCAL_MODEL_MAX_QUEUE = Math.max(1, Math.min(256, Number(process.env.LUMI_LOCAL_MODEL_MAX_QUEUE) || 32));
const LOCAL_MODEL_QUEUE_TIMEOUT_MS = Math.max(1_000, Math.min(300_000, Number(process.env.LUMI_LOCAL_MODEL_QUEUE_TIMEOUT_MS) || 45_000));

interface LocalModelQueueWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface LocalModelQueueState {
  concurrency: number;
  active: number;
  queue: LocalModelQueueWaiter[];
  completed: number;
  failed: number;
  rejected: number;
  maxObservedQueue: number;
}

function configuredConcurrency(provider: LocalModelProvider): number {
  const key = provider === 'ollama' ? 'LUMI_OLLAMA_CONCURRENCY' : 'LUMI_LMSTUDIO_CONCURRENCY';
  const fallback = provider === 'ollama' ? 1 : 2;
  return Math.max(1, Math.min(16, Number(process.env[key]) || fallback));
}

const localModelQueues = new Map<LocalModelProvider, LocalModelQueueState>();

function queueState(provider: LocalModelProvider): LocalModelQueueState {
  let state = localModelQueues.get(provider);
  if (!state) {
    state = {
      concurrency: configuredConcurrency(provider),
      active: 0,
      queue: [],
      completed: 0,
      failed: 0,
      rejected: 0,
      maxObservedQueue: 0,
    };
    localModelQueues.set(provider, state);
  }
  return state;
}

export function normalizeLocalModelBaseUrl(provider: LocalModelProvider, rawValue?: unknown): string {
  const raw = String(rawValue || LOCAL_MODEL_DEFAULT_URLS[provider]).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Local model URL must be a valid http:// or https:// address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Local model URL must use http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentials are not allowed inside the local model URL');
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/i, '').replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

export function isTextGenerationModel(model: string): boolean {
  return Boolean(model) && !/(?:embed|embedding|whisper|rerank|re-rank|bge[-_]|nomic[-_]?embed)/i.test(model);
}

function releaseQueueSlot(provider: LocalModelProvider): void {
  const state = queueState(provider);
  const waiter = state.queue.shift();
  if (!waiter) {
    state.active = Math.max(0, state.active - 1);
    return;
  }
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  waiter.resolve(() => releaseQueueSlot(provider));
}

async function acquireQueueSlot(
  provider: LocalModelProvider,
  signal?: AbortSignal,
): Promise<() => void> {
  const state = queueState(provider);
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  if (state.active < state.concurrency) {
    state.active += 1;
    return () => releaseQueueSlot(provider);
  }
  if (state.queue.length >= LOCAL_MODEL_MAX_QUEUE) {
    state.rejected += 1;
    throw new Error(`${provider} inference queue is full (${LOCAL_MODEL_MAX_QUEUE} waiting)`);
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: LocalModelQueueWaiter = {
      resolve,
      reject,
      signal,
      timer: setTimeout(() => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        state.rejected += 1;
        reject(new Error(`${provider} inference queue wait timed out after ${LOCAL_MODEL_QUEUE_TIMEOUT_MS}ms`));
      }, LOCAL_MODEL_QUEUE_TIMEOUT_MS),
    };
    if (signal) {
      waiter.onAbort = () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        state.rejected += 1;
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    state.queue.push(waiter);
    state.maxObservedQueue = Math.max(state.maxObservedQueue, state.queue.length);
  });
}

export async function runLocalModelInference<T>(
  provider: LocalModelProvider,
  operation: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const release = await acquireQueueSlot(provider, options.signal);
  const state = queueState(provider);
  const startedAt = Date.now();
  try {
    const result = await operation();
    state.completed += 1;
    markLocalModelHealthy(provider, Date.now() - startedAt);
    return result;
  } catch (error) {
    state.failed += 1;
    markLocalModelUnhealthy(provider, error);
    throw error;
  } finally {
    release();
  }
}

export function getLocalModelQueueSnapshot(provider: LocalModelProvider): LocalModelQueueSnapshot {
  const state = queueState(provider);
  return {
    provider,
    concurrency: state.concurrency,
    active: state.active,
    queued: state.queue.length,
    completed: state.completed,
    failed: state.failed,
    rejected: state.rejected,
    maxObservedQueue: state.maxObservedQueue,
  };
}

function candidateBaseUrls(provider: LocalModelProvider, rawValue?: unknown): string[] {
  const primary = normalizeLocalModelBaseUrl(provider, rawValue);
  const candidates = [primary];
  const parsed = new URL(primary);
  if (parsed.hostname.toLowerCase() === 'localhost') {
    const ipv4 = new URL(primary);
    ipv4.hostname = '127.0.0.1';
    candidates.push(ipv4.toString().replace(/\/$/, ''));
  }
  return [...new Set(candidates)];
}

async function probeLocalInference(
  provider: LocalModelProvider,
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();
  const endpoint = provider === 'ollama' ? '/api/chat' : '/v1/chat/completions';
  const body = provider === 'ollama'
    ? {
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        stream: false,
        options: { num_predict: 2, temperature: 0 },
      }
    : {
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        stream: false,
        max_tokens: 2,
        temperature: 0,
      };
  const response = await fetchImpl(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`inference HTTP ${response.status}`);
  const data = await response.json() as any;
  const valid = provider === 'ollama'
    ? Boolean(data?.message && typeof data.message.content === 'string')
    : Boolean(Array.isArray(data?.choices) && data.choices[0]?.message);
  if (!valid) throw new Error('inference response was not OpenAI/Ollama chat-compatible');
  return Date.now() - startedAt;
}

export function getLocalModelConfig(provider: LocalModelProvider): LocalModelConfig {
  const fallback: LocalModelConfig = {
    baseUrl: normalizeLocalModelBaseUrl(provider, process.env[provider === 'ollama' ? 'OLLAMA_BASE_URL' : 'LMSTUDIO_BASE_URL']),
    detected: false,
    models: [],
    serviceReachable: false,
    inferenceHealthy: false,
    healthStatus: 'unavailable',
    consecutiveFailures: 0,
  };
  try {
    const db = readDB();
    const row = (db.settings || []).find((setting: any) => setting.key === SETTING_KEYS[provider]);
    if (!row?.value) return fallback;
    const stored = JSON.parse(row.value);
    return {
      baseUrl: normalizeLocalModelBaseUrl(provider, stored.baseUrl || fallback.baseUrl),
      detected: stored.detected === true,
      models: Array.isArray(stored.models) ? stored.models.filter((model: unknown) => typeof model === 'string') : [],
      serviceReachable: stored.serviceReachable === true || stored.detected === true,
      inferenceHealthy: stored.inferenceHealthy === true || stored.detected === true,
      healthStatus: ['healthy', 'catalog_only', 'backoff', 'unavailable'].includes(stored.healthStatus)
        ? stored.healthStatus
        : stored.detected === true ? 'healthy' : 'unavailable',
      lastInferenceAt: typeof stored.lastInferenceAt === 'string' ? stored.lastInferenceAt : undefined,
      lastInferenceLatencyMs: Number.isFinite(Number(stored.lastInferenceLatencyMs))
        ? Math.max(0, Number(stored.lastInferenceLatencyMs))
        : undefined,
      consecutiveFailures: Math.max(0, Math.trunc(Number(stored.consecutiveFailures) || 0)),
      nextRetryAt: typeof stored.nextRetryAt === 'string' ? stored.nextRetryAt : undefined,
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : undefined,
      lastError: typeof stored.lastError === 'string' ? stored.lastError : undefined,
    };
  } catch {
    return fallback;
  }
}

export function saveLocalModelConfig(provider: LocalModelProvider, config: LocalModelConfig): LocalModelConfig {
  const payload: LocalModelConfig = {
    baseUrl: normalizeLocalModelBaseUrl(provider, config.baseUrl),
    detected: config.detected === true,
    models: Array.isArray(config.models) ? [...new Set(config.models.filter(Boolean))] : [],
    serviceReachable: config.serviceReachable === true,
    inferenceHealthy: config.inferenceHealthy === true,
    healthStatus: config.healthStatus || (config.detected ? 'healthy' : 'unavailable'),
    ...(config.lastInferenceAt ? { lastInferenceAt: config.lastInferenceAt } : {}),
    ...(Number.isFinite(config.lastInferenceLatencyMs) ? { lastInferenceLatencyMs: config.lastInferenceLatencyMs } : {}),
    consecutiveFailures: Math.max(0, Math.trunc(Number(config.consecutiveFailures) || 0)),
    ...(config.nextRetryAt ? { nextRetryAt: config.nextRetryAt } : {}),
    updatedAt: config.updatedAt || new Date().toISOString(),
    ...(config.lastError ? { lastError: config.lastError.slice(0, 300) } : {}),
  };
  let db: any;
  try {
    db = readDB();
  } catch {
    // Embedders and connection-test harnesses may construct the LLM runtime
    // before the durable database. The live probe result remains authoritative
    // for this call and will be persisted after normal runtime initialization.
    if (payload.detected) resetCircuit(provider);
    return payload;
  }
  if (!db.settings) (db as any).settings = [];
  const key = SETTING_KEYS[provider];
  const existing = (db.settings || []).findIndex((setting: any) => setting.key === key);
  if (existing >= 0) db.settings[existing].value = JSON.stringify(payload);
  else db.settings.push({ key, value: JSON.stringify(payload) });
  writeDB(db);
  if (payload.detected) resetCircuit(provider);
  return payload;
}

export async function probeLocalModel(
  provider: LocalModelProvider,
  rawBaseUrl?: unknown,
  options: { timeoutMs?: number; inferenceTimeoutMs?: number; requestedModel?: string; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelProbeResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 5000, 30_000));
  const inferenceTimeoutMs = Math.max(
    timeoutMs,
    Math.min(options.inferenceTimeoutMs || 20_000, 120_000),
  );
  const path = provider === 'ollama' ? '/api/tags' : '/v1/models';
  const startedAt = Date.now();
  const candidates = candidateBaseUrls(provider, rawBaseUrl);
  let lastError = '';

  for (const baseUrl of candidates) {
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const data = await response.json() as any;
      const rawModels = provider === 'ollama' ? data?.models : data?.data;
      const models = (Array.isArray(rawModels) ? rawModels : [])
        .map((model: any) => provider === 'ollama' ? model?.name : model?.id)
        .filter((model: unknown): model is string => typeof model === 'string' && model.trim().length > 0);
      const detected = models.some(isTextGenerationModel);
      const requestedProbeModel = String(options.requestedModel || '').trim();
      const probeModel = requestedProbeModel && models.includes(requestedProbeModel) && isTextGenerationModel(requestedProbeModel)
        ? requestedProbeModel
        : models.find(isTextGenerationModel);
      if (!detected || !probeModel) {
        return {
          baseUrl,
          detected: false,
          serviceReachable: true,
          inferenceHealthy: false,
          healthStatus: 'catalog_only',
          models,
          updatedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          lastError: 'The service is reachable but no text-generation model is loaded',
        };
      }
      try {
        const inferenceLatencyMs = await probeLocalInference(provider, baseUrl, probeModel, fetchImpl, inferenceTimeoutMs);
        return {
          baseUrl,
          detected: true,
          serviceReachable: true,
          inferenceHealthy: true,
          healthStatus: 'healthy',
          models,
          updatedAt: new Date().toISOString(),
          lastInferenceAt: new Date().toISOString(),
          lastInferenceLatencyMs: inferenceLatencyMs,
          consecutiveFailures: 0,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error: any) {
        const message = error?.name === 'TimeoutError'
          ? 'Inference probe timed out'
          : `Inference probe failed: ${error?.message || 'unknown error'}`;
        return {
          baseUrl,
          detected: false,
          serviceReachable: true,
          inferenceHealthy: false,
          healthStatus: 'catalog_only',
          models,
          updatedAt: new Date().toISOString(),
          consecutiveFailures: 1,
          latencyMs: Date.now() - startedAt,
          lastError: message.slice(0, 300),
        };
      }
    } catch (error: any) {
      lastError = error?.name === 'TimeoutError' ? 'Connection timed out' : (error?.message || 'Connection failed');
    }
  }

  return {
    baseUrl: candidates[candidates.length - 1],
    detected: false,
    serviceReachable: false,
    inferenceHealthy: false,
    healthStatus: 'unavailable',
    models: [],
    updatedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    lastError: lastError.slice(0, 300) || 'Connection failed',
  };
}

export async function refreshLocalModelConfig(
  provider: LocalModelProvider,
  rawBaseUrl?: unknown,
  options: { timeoutMs?: number; inferenceTimeoutMs?: number; requestedModel?: string; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelProbeResult> {
  const current = getLocalModelConfig(provider);
  const result = await probeLocalModel(provider, rawBaseUrl || current.baseUrl, options);
  let durableResult: LocalModelProbeResult = !result.detected && result.models.length === 0 && current.models.length > 0
    ? { ...result, models: current.models }
    : result;
  if (!durableResult.detected) {
    const failureCount = Math.max(1, Number(current.consecutiveFailures || 0) + 1);
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(failureCount - 1, 5)));
    durableResult = {
      ...durableResult,
      consecutiveFailures: failureCount,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      healthStatus: durableResult.serviceReachable ? 'catalog_only' : 'backoff',
    };
  }
  saveLocalModelConfig(provider, durableResult);
  return durableResult;
}

function configIsFresh(config: LocalModelConfig, now = Date.now()): boolean {
  const updatedAt = Date.parse(config.updatedAt || '');
  return config.detected
    && config.inferenceHealthy !== false
    && Number.isFinite(updatedAt)
    && now - updatedAt <= LOCAL_PROBE_TTL_MS;
}

export async function ensureLocalModelReady(
  provider: LocalModelProvider,
  requestedModel?: string,
  options: { timeoutMs?: number; inferenceTimeoutMs?: number; force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelSelection> {
  let config = getLocalModelConfig(provider);
  const requested = String(requestedModel || '').trim();
  const retryAt = Date.parse(config.nextRetryAt || '');
  if (!options.force && !config.detected && Number.isFinite(retryAt) && retryAt > Date.now()) {
    throw new Error(`${provider} reconnect is backing off until ${config.nextRetryAt}: ${config.lastError || 'local model unavailable'}`);
  }
  let probed = false;
  const probe = async (): Promise<LocalModelProbeResult> => {
    let pending = probeInFlight.get(provider);
    if (!pending) {
      pending = refreshLocalModelConfig(provider, config.baseUrl, {
        timeoutMs: options.timeoutMs || 5_000,
        inferenceTimeoutMs: options.inferenceTimeoutMs,
        requestedModel: requested,
        fetchImpl: options.fetchImpl,
      }).finally(() => {
        probeInFlight.delete(provider);
      });
      probeInFlight.set(provider, pending);
    }
    probed = true;
    return pending;
  };
  if (options.force || !configIsFresh(config)) {
    config = await probe();
  }
  if (!config.detected) {
    throw new Error(`${provider} is not reachable: ${config.lastError || 'local model probe failed'}`);
  }
  let textModels = config.models.filter(isTextGenerationModel);
  // A model may have been loaded after the last healthy probe. Refresh once
  // before reporting an exact user selection as unavailable.
  if (requested && !textModels.includes(requested) && !probed) {
    config = await probe();
    if (!config.detected) {
      throw new Error(`${provider} is not reachable: ${config.lastError || 'local model probe failed'}`);
    }
    textModels = config.models.filter(isTextGenerationModel);
  }
  if (requested && !textModels.includes(requested)) {
    throw new Error(`${provider} model "${requested}" is not loaded. Available text models: ${textModels.join(', ') || 'none'}`);
  }
  const model = requested || textModels[0];
  if (!model) throw new Error(`${provider} is reachable but no text-generation model is loaded`);
  return { provider, model, baseUrl: config.baseUrl };
}

export function markLocalModelUnhealthy(provider: LocalModelProvider, error: unknown): void {
  const message = String((error as any)?.message || error || 'Local model call failed');
  if ((error as any)?.name === 'AbortError' || /abort|cancelled by user/i.test(message)) return;
  const current = getLocalModelConfig(provider);
  const consecutiveFailures = Math.max(1, Number(current.consecutiveFailures || 0) + 1);
  const baseDelayMs = Math.min(30_000, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 5)));
  const jitterMs = Math.floor(Math.random() * Math.min(500, baseDelayMs * 0.2));
  saveLocalModelConfig(provider, {
    ...current,
    detected: false,
    inferenceHealthy: false,
    healthStatus: 'backoff',
    consecutiveFailures,
    nextRetryAt: new Date(Date.now() + baseDelayMs + jitterMs).toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: message.slice(0, 300),
  });
}

export function markLocalModelHealthy(provider: LocalModelProvider, latencyMs?: number): void {
  const current = getLocalModelConfig(provider);
  saveLocalModelConfig(provider, {
    ...current,
    detected: true,
    serviceReachable: true,
    inferenceHealthy: true,
    healthStatus: 'healthy',
    lastInferenceAt: new Date().toISOString(),
    ...(Number.isFinite(latencyMs) ? { lastInferenceLatencyMs: Math.max(0, Number(latencyMs)) } : {}),
    consecutiveFailures: 0,
    nextRetryAt: undefined,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
  });
}

export async function resolveAutoLocalModelCandidates(
  preferredModel?: string,
): Promise<LocalModelSelection[]> {
  const providers: LocalModelProvider[] = ['ollama', 'lmstudio'];
  const settled = await Promise.allSettled(providers.map(provider => ensureLocalModelReady(provider)));
  const available = settled.flatMap((result, index) => {
    if (result.status !== 'fulfilled') return [];
    const config = getLocalModelConfig(providers[index]);
    const models = config.models.filter(isTextGenerationModel);
    return models.map(model => ({ provider: providers[index], model, baseUrl: config.baseUrl }));
  });
  const preferred = String(preferredModel || '').trim();
  return available.sort((left, right) => {
    const leftScore = left.model === preferred ? 1 : 0;
    const rightScore = right.model === preferred ? 1 : 0;
    return rightScore - leftScore;
  });
}
