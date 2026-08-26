import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';

export type RemoteDeviceConfig = Record<string, string>;

const MAX_REMOTE_DEVICES = 64;
const MAX_REMOTE_DEVICE_NAME = 120;
const MAX_REMOTE_DEVICE_URL = 2_048;

/**
 * A URL projection safe for diagnostics and local-administrator responses.
 * Connector query values are opaque and may be credentials even when their
 * parameter names are unconventional, so no query value crosses the boundary.
 */
export function sanitizeMcpEndpoint(value: unknown): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, '[configured]');
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[configured endpoint]';
  }
}

export function sanitizeMcpLogValue(value: unknown): string {
  return redactDiagnosticSecrets(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}

export function publicMcpToolFailure(): string {
  return 'Lumi could not complete this MCP operation. Check the local runtime logs and retry.';
}

export function normalizeRemoteDeviceConfig(value: unknown): RemoteDeviceConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_REMOTE_DEVICES) return null;

  const normalized: RemoteDeviceConfig = {};
  for (const [rawName, rawUrl] of entries) {
    const name = String(rawName || '').trim();
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (
      !name
      || name !== rawName
      || name.length > MAX_REMOTE_DEVICE_NAME
      || /[\u0000-\u001f\u007f]/.test(name)
      || !url
      || url.length > MAX_REMOTE_DEVICE_URL
    ) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    } catch {
      return null;
    }
    normalized[name] = url;
  }
  return normalized;
}

export function projectRemoteDeviceConfig(value: unknown): RemoteDeviceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const projected: RemoteDeviceConfig = {};
  for (const [name, endpoint] of Object.entries(value as Record<string, unknown>).slice(0, MAX_REMOTE_DEVICES)) {
    const safeName = String(name || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_REMOTE_DEVICE_NAME);
    const safeEndpoint = sanitizeMcpEndpoint(endpoint);
    if (safeName && safeEndpoint) projected[safeName] = safeEndpoint;
  }
  return projected;
}

export function projectMcpServerHealth<T extends Record<string, any>>(health: T): T {
  const projected: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(health || {})) {
    if (!item || typeof item !== 'object') continue;
    projected[name] = {
      status: String(item.status || 'disconnected'),
      consecutiveCrashes: Math.max(0, Number(item.consecutiveCrashes || 0)),
      lastCrashTime: item.lastCrashTime ? String(item.lastCrashTime) : undefined,
      lastSuccessfulConnect: item.lastSuccessfulConnect ? String(item.lastSuccessfulConnect) : undefined,
      lastError: item.lastError
        ? 'MCP server runtime unavailable. Inspect the local runtime logs for details.'
        : undefined,
    };
  }
  return projected as T;
}

export function mayReceiveMcpHealthUpdate(socketData: unknown): boolean {
  const data = socketData && typeof socketData === 'object'
    ? socketData as Record<string, unknown>
    : {};
  return data.authenticatedRole === 'admin' && data.trustedLocalExecution === true;
}
