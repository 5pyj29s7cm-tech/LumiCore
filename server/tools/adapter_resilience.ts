import crypto from 'node:crypto';
import type { CapabilityManifestEntry, ToolContext } from './types';

export type AdapterResilienceFamily = 'client' | 'desktop' | 'wechat' | 'cad' | 'mcp';
export type AdapterCircuitState = 'closed' | 'open' | 'half_open';

interface AdapterResilienceConfig {
  failureThreshold: number;
  cooldownMs: number;
}

interface AdapterCircuitRecord {
  key: string;
  family: AdapterResilienceFamily;
  owner: string;
  state: AdapterCircuitState;
  consecutiveFailures: number;
  openedAt: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  lastError: string;
  probeInFlight: boolean;
}

export interface AdapterExecutionPermit {
  tracked: boolean;
  allowed: boolean;
  family?: AdapterResilienceFamily;
  key?: string;
  recoveryProbe: boolean;
  reason: string;
}

export interface AdapterRetryPolicy {
  maxAttempts: number;
  jitterMs: number;
  retryTransientOnly: true;
  reason: string;
}

const CONFIG: Record<AdapterResilienceFamily, AdapterResilienceConfig> = {
  client: { failureThreshold: 3, cooldownMs: 10_000 },
  desktop: { failureThreshold: 3, cooldownMs: 15_000 },
  wechat: { failureThreshold: 2, cooldownMs: 30_000 },
  cad: { failureThreshold: 2, cooldownMs: 60_000 },
  mcp: { failureThreshold: 3, cooldownMs: 30_000 },
};

const circuits = new Map<string, AdapterCircuitRecord>();

export function classifyAdapterResilienceFamily(
  toolName: string,
): AdapterResilienceFamily | null {
  const name = String(toolName || '').toLowerCase();
  if (/^client_/.test(name)) return 'client';
  if (/^wechat_/.test(name)) return 'wechat';
  if (/^(?:cad_|floorplan_)|^mcp_cad-drafting_/.test(name)) return 'cad';
  if (/^mcp_/.test(name)) return 'mcp';
  if (/^(?:desktop_|computer_use$)/.test(name)) return 'desktop';
  return null;
}

function circuitKey(family: AdapterResilienceFamily, context?: ToolContext): string {
  const owner = String(context?.userId || 'runtime').trim() || 'runtime';
  return `${family}:${owner}`;
}

function recordFor(family: AdapterResilienceFamily, context?: ToolContext): AdapterCircuitRecord {
  const key = circuitKey(family, context);
  let record = circuits.get(key);
  if (!record) {
    record = {
      key,
      family,
      owner: String(context?.userId || 'runtime').trim() || 'runtime',
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: 0,
      lastFailureAt: 0,
      lastSuccessAt: 0,
      lastError: '',
      probeInFlight: false,
    };
    circuits.set(key, record);
  }
  return record;
}

function isExternalCommit(capability: CapabilityManifestEntry): boolean {
  return capability.sideEffects.some(effect => (
    effect.type === 'external_communication' || effect.type === 'external_state_change'
  ));
}

function isSafeRecoveryProbe(capability: CapabilityManifestEntry): boolean {
  return !isExternalCommit(capability)
    && (capability.operation === 'observe' || capability.operation === 'test');
}

export function getAdapterRetryPolicy(
  toolName: string,
  capability: CapabilityManifestEntry,
): AdapterRetryPolicy {
  const retrySafe = (capability.operation === 'observe' || capability.operation === 'test')
    && capability.sideEffects.every(effect => effect.reversible && (
      effect.type === 'local_read'
      || effect.type === 'network_read'
      || effect.type === 'none'
    ));
  if (!retrySafe) {
    return {
      maxAttempts: 1,
      jitterMs: 0,
      retryTransientOnly: true,
      reason: 'mutation, external commit, or non-idempotent capability',
    };
  }
  const nameHash = [...String(toolName || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    maxAttempts: 2,
    jitterMs: 75 + (nameHash % 126),
    retryTransientOnly: true,
    reason: 'idempotent observation with reversible read-only side effects',
  };
}

export function beforeAdapterExecution(input: {
  toolName: string;
  capability: CapabilityManifestEntry;
  context?: ToolContext;
  now?: number;
}): AdapterExecutionPermit {
  const family = classifyAdapterResilienceFamily(input.toolName);
  if (!family) return { tracked: false, allowed: true, recoveryProbe: false, reason: 'untracked adapter family' };
  const record = recordFor(family, input.context);
  const now = input.now ?? Date.now();
  if (record.state === 'closed') {
    return { tracked: true, allowed: true, family, key: record.key, recoveryProbe: false, reason: 'circuit closed' };
  }
  if (record.state === 'half_open' && record.probeInFlight) {
    return { tracked: true, allowed: false, family, key: record.key, recoveryProbe: false, reason: 'recovery probe already in flight' };
  }
  const cooldownElapsed = now - record.openedAt >= CONFIG[family].cooldownMs;
  if (!cooldownElapsed) {
    return { tracked: true, allowed: false, family, key: record.key, recoveryProbe: false, reason: 'adapter circuit cooldown is active' };
  }
  if (!isSafeRecoveryProbe(input.capability)) {
    return {
      tracked: true,
      allowed: false,
      family,
      key: record.key,
      recoveryProbe: false,
      reason: 'adapter circuit requires a read-only recovery probe; mutations and external commits cannot probe',
    };
  }
  record.state = 'half_open';
  record.probeInFlight = true;
  return { tracked: true, allowed: true, family, key: record.key, recoveryProbe: true, reason: 'read-only half-open recovery probe' };
}

export function adapterFailureIsTransient(error: unknown): boolean {
  return /timed?\s*out|timeout|econnreset|econnrefused|epipe|socket|connection|disconnect|unavailable|process exited|crash|transport closed|broken pipe/i
    .test(String((error as any)?.message || error || ''));
}

function adapterFailureCategory(error: unknown): string {
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (/timed?\s*out|timeout/.test(message)) return 'timeout';
  if (/econnreset|econnrefused|epipe|socket|connection|disconnect|broken pipe/.test(message)) return 'connection';
  if (/process exited|crash|transport closed/.test(message)) return 'process_or_transport';
  if (/unavailable/.test(message)) return 'unavailable';
  return 'transient_failure';
}

export function recordAdapterExecutionSuccess(
  permit: AdapterExecutionPermit,
  now = Date.now(),
): void {
  if (!permit.tracked || !permit.key) return;
  const record = circuits.get(permit.key);
  if (!record) return;
  record.state = 'closed';
  record.consecutiveFailures = 0;
  record.openedAt = 0;
  record.lastSuccessAt = now;
  record.lastError = '';
  record.probeInFlight = false;
}

export function recordAdapterExecutionFailure(
  permit: AdapterExecutionPermit,
  error: unknown,
  options: { force?: boolean; now?: number } = {},
): void {
  if (!permit.tracked || !permit.key || !permit.family) return;
  if (!options.force && !adapterFailureIsTransient(error)) {
    const unchanged = circuits.get(permit.key);
    if (unchanged && permit.recoveryProbe) unchanged.probeInFlight = false;
    return;
  }
  const record = circuits.get(permit.key);
  if (!record) return;
  const now = options.now ?? Date.now();
  record.consecutiveFailures += 1;
  record.lastFailureAt = now;
  record.lastError = adapterFailureCategory(error);
  record.probeInFlight = false;
  if (record.state === 'half_open' || record.consecutiveFailures >= CONFIG[permit.family].failureThreshold) {
    record.state = 'open';
    record.openedAt = now;
  }
}

export function cancelAdapterExecutionPermit(permit: AdapterExecutionPermit): void {
  if (!permit.tracked || !permit.key || !permit.recoveryProbe) return;
  const record = circuits.get(permit.key);
  if (record) record.probeInFlight = false;
}

export function getAdapterResilienceSnapshot() {
  const now = Date.now();
  return {
    generatedAt: new Date(now).toISOString(),
    families: Object.fromEntries((Object.keys(CONFIG) as AdapterResilienceFamily[]).map(family => {
      const records = [...circuits.values()].filter(record => record.family === family);
      return [family, {
        config: { ...CONFIG[family] },
        trackedOwners: records.length,
        openCircuits: records.filter(record => record.state === 'open').length,
        halfOpenCircuits: records.filter(record => record.state === 'half_open').length,
        circuits: records.slice(0, 50).map(record => ({
          ownerDigest: crypto.createHash('sha256').update(record.owner).digest('hex').slice(0, 16),
          state: record.state,
          consecutiveFailures: record.consecutiveFailures,
          cooldownRemainingMs: record.state === 'open'
            ? Math.max(0, CONFIG[family].cooldownMs - (now - record.openedAt))
            : 0,
          lastFailureAt: record.lastFailureAt ? new Date(record.lastFailureAt).toISOString() : '',
          lastSuccessAt: record.lastSuccessAt ? new Date(record.lastSuccessAt).toISOString() : '',
          lastError: record.lastError,
        })),
      }];
    })),
  };
}

export function resetAdapterResilienceForTests(): void {
  circuits.clear();
}
