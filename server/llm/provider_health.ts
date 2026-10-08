import { readSettingJson, writeSetting } from '../persistence/settings_repository';
import { createProviderRuntimeObservationReader, findProviderRuntimeObservation } from './model_routing_receipts';
import { getCircuitStatus, getProviderConfigurationEpoch, type CircuitState } from '../cloud/circuit_breaker';

export interface ProviderProbeRecord {
  provider: string;
  model: string;
  ok: boolean;
  testedAt: string;
  configurationEpoch?: string;
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
  configurationEpoch?: string;
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
  return readSettingJson<ProviderProbeRecord>(providerProbeKey(provider));
}

export function saveProviderProbe(probe: ProviderProbeRecord): boolean {
  const configurationEpoch = probe.configurationEpoch ?? getProviderConfigurationEpoch(probe.provider);
  if (configurationEpoch !== getProviderConfigurationEpoch(probe.provider)) return false;
  writeSetting(providerProbeKey(probe.provider), JSON.stringify({ ...probe, configurationEpoch }));
  return true;
}

/** Latest durable model-attempt evidence, without prompt, response, or error text. */
export function readProviderRuntimeObservation(provider: string, model: string): ProviderRuntimeObservation | null {
  return findProviderRuntimeObservation(provider, model);
}

function probeAppliesToModel(probe: ProviderProbeRecord | null, model: string): boolean {
  if (!probe || probe.configurationEpoch !== getProviderConfigurationEpoch(probe.provider)) return false;
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
type ProviderAvailabilityInput = {
  provider: string;
  model: string;
  configured: boolean;
  runtimeHealthy?: boolean;
  now?: number;
};

/** A fresh request-scoped snapshot; never cache health across configuration changes. */
export function createProviderAvailabilityReader(): (input: ProviderAvailabilityInput) => ProviderAvailability {
  const readObservation = createProviderRuntimeObservationReader();
  return input => assessProviderAvailabilityFromSnapshot(input, readObservation);
}

export function assessProviderAvailability(input: ProviderAvailabilityInput): ProviderAvailability {
  return createProviderAvailabilityReader()(input);
}

function assessProviderAvailabilityFromSnapshot(input: ProviderAvailabilityInput, readObservation: typeof findProviderRuntimeObservation): ProviderAvailability {
  const now = input.now ?? Date.now();
  const lastProbe = readProviderProbe(input.provider);
  const lastObservation = readObservation(input.provider, input.model);
  const applicableProbe = probeAppliesToModel(lastProbe, input.model) ? lastProbe : null;
  const configurationEpoch = getProviderConfigurationEpoch(input.provider);
  const observation = lastObservation?.configurationEpoch === configurationEpoch ? lastObservation
    : readObservation(input.provider, input.model, configurationEpoch);
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

  const observationAgeMs = observation
    ? timestampAgeMs(observation.observedAt, now)
    : Number.POSITIVE_INFINITY;
  if (observation?.status === 'failed' && observationAgeMs < FAILED_PROBE_BACKOFF_MS) {
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
    || Boolean(observation?.status === 'succeeded' && observationAgeMs < POSITIVE_PROBE_FRESH_MS);
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
