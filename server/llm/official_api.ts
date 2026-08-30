/**
 * Lumi official API transport.
 *
 * The official gateway uses the same authentication and base URL for every
 * model lane.  Text chat already uses the OpenAI SDK; the helpers below keep
 * the non-chat lanes on the same credential source and provide small,
 * testable request/response primitives for image, video, retrieval and voice.
 * Endpoint paths are overridable for a deployment whose gateway exposes a
 * namespaced route, while the defaults follow the OpenAI-compatible contract.
 */
import {
  relayApiKey,
  relayBaseUrl,
  relayConfigured,
  relayEndpoint,
  isRelayOriginUrl,
  relayPath,
} from '../relay/config';

export interface OfficialApiConfig {
  apiKey: string;
  baseUrl: string;
}

export interface OfficialApiRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OfficialApiResponse<T = any> {
  response: Response;
  body: T;
}

export interface OfficialApiModelDescriptor {
  id: string;
  capability: string;
  endpoint: string;
  ownedBy: string;
}

export interface OfficialApiModelCatalog {
  models: OfficialApiModelDescriptor[];
  byRole: Record<string, string[]>;
}

const OFFICIAL_MODEL_CAPABILITY_ROLES: Readonly<Record<string, readonly string[]>> = {
  chat: ['reasoning'],
  multimodal_chat: ['vision', 'world'],
  image_generation: ['image_generation'],
  video_generation: ['video_generation'],
  embedding: ['embedding'],
  rerank: ['rerank'],
  speech_recognition: ['speech_recognition'],
  speech_synthesis: ['speech_synthesis'],
};

/** Return credentials without exposing them in logs or public receipts. */
export function getOfficialApiConfig(): OfficialApiConfig {
  return {
    apiKey: relayApiKey(),
    baseUrl: relayBaseUrl(),
  };
}

export function isOfficialApiConfigured(): boolean {
  return relayConfigured();
}

/**
 * Resolve a relative official endpoint. A full URL override is accepted for
 * deployments that route one lane to a separate gateway host.
 */
export function officialApiUrl(path: string, fullUrlEnv?: string): string {
  const configuredFullUrl = fullUrlEnv ? String(process.env[fullUrlEnv] || '').trim() : '';
  if (configuredFullUrl) {
    const value = configuredFullUrl.replace(/\/+$/, '');
    if (!isRelayOriginUrl(value)) {
      throw new Error('Official API endpoint overrides must stay on the configured gateway origin.');
    }
    return value;
  }
  if (/^https?:\/\//i.test(String(path || '').trim())) {
    const value = String(path).trim().replace(/\/+$/, '');
    if (!isRelayOriginUrl(value)) {
      throw new Error('Official API endpoint overrides must stay on the configured gateway origin.');
    }
    return value;
  }
  return relayEndpoint(path, path);
}

export function officialApiPath(envName: string | readonly string[], fallback: string): string {
  const names = Array.isArray(envName) ? [...envName] : [envName];
  return relayPath(...names) || fallback;
}

/** Resolve an authenticated WebSocket route on the configured gateway. */
export function officialApiWebSocketUrl(path: string, model?: string): string {
  const url = new URL(officialApiUrl(path));
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new Error('Lumi Official API WebSocket endpoint must use HTTP(S).');
  if (model) url.searchParams.set('model', model);
  return url.toString();
}

export function officialApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { apiKey } = getOfficialApiConfig();
  if (!apiKey) throw new Error('RELAY_API_KEY is not configured. Set it in Settings > AI Providers > Official.');
  const safeExtra = Object.fromEntries(
    Object.entries(extra).filter(([name]) => !/^(authorization|cookie|proxy-authorization|set-cookie)$/i.test(name)),
  );
  return {
    ...safeExtra,
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Headers that are safe to send to a provider-hosted media URL.  A media URL
 * is often returned by a different origin (and may be signed already), so
 * forwarding the gateway bearer/cookies would turn a normal download into a
 * credential disclosure.  Keep benign negotiation headers such as Accept.
 */
function externalMediaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extra).filter(([name]) => !/^(authorization|cookie|proxy-authorization|set-cookie)$/i.test(name)),
  );
}

function errorMessage(body: any, response: Response): string {
  const value = body?.error?.message
    || body?.error?.detail
    || body?.message
    || body?.detail
    || body?.reason
    || response.statusText
    || `HTTP ${response.status}`;
  return String(value).replace(/(?:Bearer\s+|sk-[A-Za-z0-9_-]{6,})[^\s]*/gi, '[redacted]').slice(0, 500);
}

async function readBody(response: Response): Promise<any> {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    return response.json().catch(() => ({}));
  }
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}

/** Make one authenticated request with a bounded timeout and safe errors. */
export async function officialApiRequest<T = any>(
  path: string,
  options: OfficialApiRequestOptions = {},
): Promise<OfficialApiResponse<T>> {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.max(1_000, Math.trunc(Number(options.timeoutMs)))
    : 60_000;
  const callerSignal = options.signal;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(officialApiUrl(path), {
      method: options.method || 'GET',
      headers: officialApiHeaders(options.headers),
      body: options.body,
      signal: controller.signal,
    });
    const body = await readBody(response);
    if (!response.ok) throw new Error(`Lumi Official API request failed (${response.status}): ${errorMessage(body, response)}`);
    return { response, body: body as T };
  } catch (error: any) {
    if (error?.name === 'AbortError' && !callerSignal?.aborted) {
      throw new Error(`Lumi Official API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}

/**
 * Read the live model catalog exposed by the official gateway. Only public
 * routing metadata is returned; credentials and upstream configuration never
 * leave the server.
 */
export async function listOfficialApiModels(
  options: Pick<OfficialApiRequestOptions, 'fetchImpl' | 'signal' | 'timeoutMs'> = {},
): Promise<OfficialApiModelCatalog> {
  const { body } = await officialApiRequest<any>('/models', {
    method: 'GET',
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs || 15_000,
  });
  const rawModels = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const models: OfficialApiModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels.slice(0, 2_000)) {
    const id = String(raw?.id || '').trim().slice(0, 200);
    const capability = String(raw?.capability || '').trim().toLowerCase().slice(0, 80);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(id) || !capability || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      capability,
      endpoint: String(raw?.endpoint || '').trim().slice(0, 240),
      ownedBy: String(raw?.owned_by || raw?.ownedBy || '').trim().slice(0, 120),
    });
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  const byRole: Record<string, string[]> = {};
  for (const model of models) {
    for (const role of OFFICIAL_MODEL_CAPABILITY_ROLES[model.capability] || []) {
      (byRole[role] ||= []).push(model.id);
    }
  }
  return { models, byRole };
}

/** Fetch binary content through the official gateway (for video/audio URLs). */
export async function officialApiBinary(
  pathOrUrl: string,
  options: OfficialApiRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch;
  const absolute = /^https?:\/\//i.test(pathOrUrl);
  const url = absolute ? pathOrUrl : officialApiUrl(pathOrUrl);
  let headers: Record<string, string> = {};
  if (!absolute) {
    headers = officialApiHeaders(options.headers);
  } else {
    // A completed media task may return a provider-hosted URL. Never forward
    // Lumi's bearer token to a different origin; only configured-gateway URLs
    // are allowed to receive it.
    const sameOrigin = isRelayOriginUrl(url);
    if (sameOrigin) {
      headers = officialApiHeaders(options.headers);
    } else {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('Official API media URL is invalid.'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw new Error('Official API media URL must be an HTTPS URL without credentials.');
      }
      headers = externalMediaHeaders(options.headers);
    }
  }
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.max(1_000, Math.trunc(Number(options.timeoutMs)))
    : 90_000;
  const callerSignal = options.signal;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await readBody(response);
      throw new Error(`Lumi Official API binary request failed (${response.status}): ${errorMessage(body, response)}`);
    }
    return response;
  } catch (error: any) {
    if (error?.name === 'AbortError' && !callerSignal?.aborted) {
      throw new Error(`Lumi Official API binary request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}

/** Read a binary response with a hard upper bound before materializing it. */
export async function readOfficialApiBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const limit = Math.max(1, Math.trunc(Number(maxBytes) || 1));
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`Official API binary response exceeds the ${limit} byte limit.`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error(`Official API binary response exceeds the ${limit} byte limit.`);
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`Official API binary response exceeds the ${limit} byte limit.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export function officialApiModel(envName: string, fallback: string): string {
  return String(relayPath(envName) || fallback).trim() || fallback;
}
