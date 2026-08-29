import { getKey } from '../config/keys';

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost'
    || value.endsWith('.localhost')
    || value === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(value);
}

/** Keep environment-based relay settings fail-closed as well as UI-saved ones. */
function isSafeBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || parsed.hash) return false;
    return parsed.protocol === 'https:' || isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/** Return whether a URL belongs to the configured official gateway origin. */
export function isRelayOriginUrl(value: string): boolean {
  try {
    const base = relayBaseUrl();
    if (!base || !isSafeBaseUrl(base)) return false;
    const candidate = new URL(value);
    return isSafeBaseUrl(candidate.toString()) && candidate.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** Configuration shared by the official OpenAI-compatible relay adapters. */
export function relayApiKey(): string {
  return String(process.env.RELAY_API_KEY || getKey('RELAY_API_KEY') || '').trim();
}

export function relayBaseUrl(): string {
  return String(process.env.RELAY_BASE_URL || getKey('RELAY_BASE_URL') || '').trim().replace(/\/+$/, '');
}

export function relayConfigured(): boolean {
  const base = relayBaseUrl();
  return Boolean(relayApiKey() && base && isSafeBaseUrl(base));
}

/** Base URL suitable for the OpenAI SDK's `/chat/completions` resolution. */
export function relayOpenAIBaseUrl(): string {
  const base = relayBaseUrl();
  if (!base) return '';
  if (/\/v1$/i.test(base)) return base;
  return `${base}/v1`;
}

/**
 * Resolve a relay route relative to RELAY_BASE_URL. Both `/v1` and a host-only
 * base URL are accepted, and an absolute override is passed through unchanged.
 */
export function relayEndpoint(path: string | undefined, defaultPath: string): string {
  const base = relayBaseUrl();
  if (!base) throw new Error('RELAY_BASE_URL is not configured. Set it in Settings > AI Providers > Official.');
  if (!isSafeBaseUrl(base)) throw new Error('RELAY_BASE_URL must use HTTPS unless it targets a loopback service.');
  const selected = String(path || defaultPath).trim();
  if (/^https?:\/\//i.test(selected)) {
    const absolute = selected.replace(/\/+$/, '');
    if (!isRelayOriginUrl(absolute)) {
      throw new Error('Official API endpoint overrides must stay on the configured gateway origin.');
    }
    return absolute;
  }
  // ModelDepot's rerank endpoint is intentionally rooted at /api/v1 while
  // the other OpenAI-compatible lanes are rooted at /v1. Resolve /api/*
  // against the host origin so a saved /v1 base never becomes /v1/api/v1/*.
  if (/^\/?api\//i.test(selected)) {
    try {
      const origin = new URL(base).origin;
      return `${origin}/${selected.replace(/^\/+/, '')}`.replace(/([^:]\/)\/+/g, '$1');
    } catch {
      // Fall through to conservative base-relative resolution below.
    }
  }
  let suffix = selected.replace(/^\/+/, '');
  const baseHasV1 = /\/v1$/i.test(base);
  if (baseHasV1 && /^v1(?:\/|$)/i.test(suffix)) suffix = suffix.replace(/^v1(?:\/|$)/i, '');
  if (!baseHasV1 && !/^v1(?:\/|$)/i.test(suffix)) suffix = `v1/${suffix}`;
  const joined = suffix ? `${base}/${suffix}` : base;
  return joined.replace(/([^:]\/)\/+/g, '$1');
}

export function relayPath(...names: string[]): string | undefined {
  for (const name of names) {
    const value = String(process.env[name] || getKey(name as any) || '').trim();
    if (value) return value;
  }
  return undefined;
}

export function relayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = relayApiKey();
  if (!key) throw new Error('RELAY_API_KEY is not configured. Set it in Settings > AI Providers > Official.');
  // Callers may add content headers, but cannot accidentally replace the
  // credential header with a user-controlled value. Header names are case
  // insensitive, so filter before adding the authoritative value.
  const safeExtra = Object.fromEntries(
    Object.entries(extra).filter(([name]) => !/^(authorization|cookie|proxy-authorization|set-cookie)$/i.test(name)),
  );
  return { ...safeExtra, Authorization: `Bearer ${key}` };
}
