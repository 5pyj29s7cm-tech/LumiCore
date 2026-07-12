import { readDB, writeDB } from '../../db_layer';

export type LocalModelProvider = 'ollama' | 'lmstudio';

export interface LocalModelConfig {
  baseUrl: string;
  detected: boolean;
  models: string[];
  updatedAt?: string;
  lastError?: string;
}

export interface LocalModelProbeResult extends LocalModelConfig {
  latencyMs: number;
}

export const LOCAL_MODEL_DEFAULT_URLS: Record<LocalModelProvider, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
};

const SETTING_KEYS: Record<LocalModelProvider, string> = {
  ollama: 'ollama_config',
  lmstudio: 'lmstudio_config',
};

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

export function getLocalModelConfig(provider: LocalModelProvider): LocalModelConfig {
  const fallback: LocalModelConfig = {
    baseUrl: normalizeLocalModelBaseUrl(provider, process.env[provider === 'ollama' ? 'OLLAMA_BASE_URL' : 'LMSTUDIO_BASE_URL']),
    detected: false,
    models: [],
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
    updatedAt: config.updatedAt || new Date().toISOString(),
    ...(config.lastError ? { lastError: config.lastError.slice(0, 300) } : {}),
  };
  const db = readDB();
  if (!db.settings) (db as any).settings = [];
  const key = SETTING_KEYS[provider];
  const existing = (db.settings || []).findIndex((setting: any) => setting.key === key);
  if (existing >= 0) db.settings[existing].value = JSON.stringify(payload);
  else db.settings.push({ key, value: JSON.stringify(payload) });
  writeDB(db);
  return payload;
}

export async function probeLocalModel(
  provider: LocalModelProvider,
  rawBaseUrl?: unknown,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelProbeResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 5000, 30_000));
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
      return {
        baseUrl,
        detected,
        models,
        updatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...(!detected ? { lastError: 'The service is reachable but no text-generation model is loaded' } : {}),
      };
    } catch (error: any) {
      lastError = error?.name === 'TimeoutError' ? 'Connection timed out' : (error?.message || 'Connection failed');
    }
  }

  return {
    baseUrl: candidates[candidates.length - 1],
    detected: false,
    models: [],
    updatedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    lastError: lastError.slice(0, 300) || 'Connection failed',
  };
}

export async function refreshLocalModelConfig(
  provider: LocalModelProvider,
  rawBaseUrl?: unknown,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelProbeResult> {
  const current = getLocalModelConfig(provider);
  const result = await probeLocalModel(provider, rawBaseUrl || current.baseUrl, options);
  saveLocalModelConfig(provider, result);
  return result;
}
