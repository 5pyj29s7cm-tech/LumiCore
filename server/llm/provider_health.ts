import { readDB, writeDB } from '../../db_layer';
import { getCircuitStatus, type CircuitState } from '../cloud/circuit_breaker';

export interface ProviderProbeRecord {
  provider: string;
  model: string;
  ok: boolean;
  testedAt: string;
  latencyMs?: number;
  error?: string;
  errorCategory?: string;
}

export type ProviderReadiness = 'unconfigured' | 'healthy' | 'unknown' | 'unhealthy';

export interface ProviderAvailability {
  configured: boolean;
  available: boolean;
  candidateEligible: boolean;
  readiness: ProviderReadiness;
  reason: string;
  circuitState: CircuitState;
  lastProbe: ProviderProbeRecord | null;
  lastObservation: ProviderRuntimeObservation | null;
}

export interface ProviderRuntimeObservation {
  provider: string;
  model: string;
  status: 'succeeded' | 'failed' | 'skipped';
  observedAt: string;
  durationMs?: number;
  reason?: string;
  errorCategory?: string;
}

const POSITIVE_PROBE_FRESH_MS = 5 * 60_000;
const FAILED_PROBE_BACKOFF_MS = 30_000;

function providerProbeKey(provider: string): string {
  return `provider_probe_${provider}`;
}

export function readProviderProbe(provider: string): ProviderProbeRecord | null {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((item: any) => item.key === providerProbeKey(provider));
    return setting?.value ? JSON.parse(setting.value) : null;
  } catch {
    return null;
  }
}

export function saveProviderProbe(probe: ProviderProbeRecord): void {
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const key = providerProbeKey(probe.provider);
    const value = JSON.stringify(probe);
    const setting = db.settings.find((item: any) => item.key === key);
    if (setting) setting.value = value;
    else db.settings.push({ key, value });
    writeDB(db);
  } catch {}
}

/** Latest durable model-attempt evidence, without prompt, response, or error text. */
export function readProviderRuntimeObservation(provider: string, model: string): ProviderRuntimeObservation | null {
  try {
    const db = readDB();
    const receipts = Array.isArray(db.modelRoutingReceipts) ? db.modelRoutingReceipts : [];
    for (let receiptIndex = receipts.length - 1; receiptIndex >= 0; receiptIndex -= 1) {
      const receipt = receipts[receiptIndex] as any;
      const attempts = Array.isArray(receipt?.attempts) ? receipt.attempts : [];
      for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
        const attempt = attempts[attemptIndex];
        if (String(attempt?.provider || '') !== provider || String(attempt?.model || '') !== model) continue;
        return {
          provider,
          model,
          status: attempt.status,
          observedAt: String(attempt.completedAt || receipt.completedAt || ''),
          ...(attempt.durationMs !== undefined ? { durationMs: Math.max(0, Math.trunc(Number(attempt.durationMs) || 0)) } : {}),
          ...(attempt.reason ? { reason: String(attempt.reason).slice(0, 100) } : {}),
          ...(attempt.errorCategory ? { errorCategory: String(attempt.errorCategory).slice(0, 64) } : {}),
        };
      }
    }
  } catch {}
  return null;
}

function probeAppliesToModel(probe: ProviderProbeRecord | null, model: string): boolean {
  if (!probe) return false;
  const probedModel = String(probe.model || '').trim();
  return !probedModel || probedModel === String(model || '').trim();
}

function timestampAgeMs(timestamp: string, now: number): number {
  const testedAt = Date.parse(timestamp || '');
  return Number.isFinite(testedAt) ? Math.max(0, now - testedAt) : Number.POSITIVE_INFINITY;
}

function probeAgeMs(probe: ProviderProbeRecord, now: number): number {
  return timestampAgeMs(probe.testedAt, now);
}

/** Read-only circuit state for status surfaces. It never advances cooldown state. */
export function getProviderCircuitState(provider: string, model = ''): CircuitState {
  const keys = new Set([provider, model ? `${provider}:${model}` : ''].filter(Boolean));
  const matches = getCircuitStatus().filter(entry => keys.has(entry.key));
  if (matches.some(entry => entry.state === 'open')) return 'open';
  if (matches.some(entry => entry.state === 'half-open')) return 'half-open';
  return 'closed';
}

/**
 * Separate configuration from observed health. A key/client is necessary to
 * attempt a provider, but it is not proof that the provider can answer.
 */
export function assessProviderAvailability(input: {
  provider: string;
  model: string;
  configured: boolean;
  runtimeHealthy?: boolean;
  now?: number;
}): ProviderAvailability {
  const now = input.now ?? Date.now();
  const lastProbe = readProviderProbe(input.provider);
  const lastObservation = readProviderRuntimeObservation(input.provider, input.model);
  const applicableProbe = probeAppliesToModel(lastProbe, input.model) ? lastProbe : null;
  const circuitState = getProviderCircuitState(input.provider, input.model);

  if (!input.configured) {
    return {
      configured: false,
      available: false,
      candidateEligible: false,
      readiness: 'unconfigured',
      reason: 'provider_not_configured',
      circuitState,
      lastProbe,
      lastObservation,
    };
  }
  if (circuitState !== 'closed') {
    return {
      configured: true,
      available: false,
      candidateEligible: false,
      readiness: 'unhealthy',
      reason: `circuit_${circuitState.replace('-', '_')}`,
      circuitState,
      lastProbe,
      lastObservation,
    };
  }
  if (applicableProbe && !applicableProbe.ok && probeAgeMs(applicableProbe, now) < FAILED_PROBE_BACKOFF_MS) {
    return {
      configured: true,
      available: false,
      candidateEligible: false,
      readiness: 'unhealthy',
      reason: 'recent_probe_failed',
      circuitState,
      lastProbe,
      lastObservation,
    };
  }

  const observationAgeMs = lastObservation
    ? timestampAgeMs(lastObservation.observedAt, now)
    : Number.POSITIVE_INFINITY;
  if (lastObservation?.status === 'failed' && observationAgeMs < FAILED_PROBE_BACKOFF_MS) {
    return {
      configured: true,
      available: false,
      candidateEligible: true,
      readiness: 'unhealthy',
      reason: 'recent_model_failure',
      circuitState,
      lastProbe,
      lastObservation,
    };
  }
  const positiveEvidence = input.runtimeHealthy === true
    || Boolean(applicableProbe?.ok && probeAgeMs(applicableProbe, now) < POSITIVE_PROBE_FRESH_MS)
    || Boolean(lastObservation?.status === 'succeeded' && observationAgeMs < POSITIVE_PROBE_FRESH_MS);
  const successReason = input.runtimeHealthy
    ? 'runtime_detected'
    : applicableProbe?.ok && probeAgeMs(applicableProbe, now) < POSITIVE_PROBE_FRESH_MS
      ? 'probe_succeeded'
      : 'recent_model_success';
  return {
    configured: true,
    available: positiveEvidence,
    candidateEligible: true,
    readiness: positiveEvidence ? 'healthy' : 'unknown',
    reason: positiveEvidence ? successReason : 'health_not_yet_verified',
    circuitState,
    lastProbe,
    lastObservation,
  };
}

/** A recent explicit failed probe is a bounded failover backoff, not a permanent ban. */
export function recentProviderProbeFailure(provider: string, model: string, now = Date.now()): boolean {
  const probe = readProviderProbe(provider);
  return Boolean(
    probe
    && probeAppliesToModel(probe, model)
    && !probe.ok
    && probeAgeMs(probe, now) < FAILED_PROBE_BACKOFF_MS,
  );
}
