import { randomUUID } from 'node:crypto';

export type CircuitState = 'closed' | 'open' | 'half-open';
interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastStateChange: number;
  cooldownMs?: number;
  version: number;
  probe?: symbol;
}
const circuits = new Map<string, CircuitEntry>();
const providerGenerations = new Map<string, number>();
let configurationGeneration = randomUUID();
const CONFIG = {
  failureThreshold: 5,
  halfOpenSuccessThreshold: 2,
  cooldownMs: 30_000,
  failureWindowMs: 60_000,
};
export function setCircuitBreakerConfig(overrides: Partial<typeof CONFIG>): void {
  Object.assign(CONFIG, overrides);
}
function circuitKey(provider: string, model?: string): string {
  return model ? provider + ':' + model : provider;
}
/** Process-local epochs expire historical health evidence after restart or reconfiguration. */
export function getProviderConfigurationEpoch(provider: string): string {
  return configurationGeneration + ':' + (providerGenerations.get(provider) || 0);
}
function entryFor(key: string): CircuitEntry {
  let entry = circuits.get(key);
  if (!entry) {
    entry = { state: 'closed', failureCount: 0, successCount: 0, lastFailureTime: 0, lastStateChange: 0, version: 0 };
    circuits.set(key, entry);
  }
  return entry;
}
function eligible(entry: CircuitEntry | undefined): boolean {
  if (!entry || entry.state === 'closed') return true;
  if (entry.state === 'open') {
    if (Date.now() - entry.lastStateChange < (entry.cooldownMs ?? CONFIG.cooldownMs)) return false;
    entry.state = 'half-open';
    entry.version++;
    entry.lastStateChange = Date.now();
    entry.successCount = 0;
    delete entry.cooldownMs;
  }
  return !entry.probe;
}
/** Eligibility only. Actual calls must acquire a lease before starting work. */
export function isCircuitClosed(provider: string, model?: string): boolean {
  return eligible(circuits.get(provider)) && (!model || eligible(circuits.get(circuitKey(provider, model))));
}
/** Status reads never transition or reserve a recovery probe. */
export function isCircuitHealthy(provider: string, model?: string): boolean {
  return [provider, ...(model ? [circuitKey(provider, model)] : [])]
    .every(key => !circuits.has(key) || circuits.get(key)!.state === 'closed');
}
export interface CircuitCall {
  readonly configurationEpoch: string;
}
interface CallGate {
  key: string;
  entry: CircuitEntry;
  version: number;
  probe?: symbol;
  report: boolean;
}
const calls = new WeakMap<CircuitCall, { provider: string; gates: CallGate[] }>();
/** Admission, recovery ownership and settlement share this single owner. */
export function acquireCircuitCall(provider: string, model?: string): CircuitCall | null {
  const keys = [provider, ...(model ? [circuitKey(provider, model)] : [])];
  if (!keys.every(key => eligible(circuits.get(key)))) return null;
  const gates = keys.map(key => {
    const entry = entryFor(key);
    const recovering = entry.state === 'half-open';
    const probe = recovering ? Symbol(key) : undefined;
    if (probe) entry.probe = probe;
    return { key, entry, version: entry.version, probe, report: key === circuitKey(provider, model) || recovering };
  });
  const call = { configurationEpoch: getProviderConfigurationEpoch(provider) };
  calls.set(call, { provider, gates });
  return call;
}
export function releaseCircuitCall(call: CircuitCall): void {
  const owned = calls.get(call);
  if (!owned) return;
  for (const gate of owned.gates) {
    if (gate.probe && gate.entry.probe === gate.probe) delete gate.entry.probe;
  }
  calls.delete(call);
}
function settleCall(call: CircuitCall, update: (entry: CircuitEntry) => void): void {
  const owned = calls.get(call);
  if (!owned) return;
  const current = call.configurationEpoch === getProviderConfigurationEpoch(owned.provider)
    && owned.gates.every(gate => circuits.get(gate.key) === gate.entry
      && gate.entry.version === gate.version
      && (!gate.probe || gate.entry.probe === gate.probe));
  releaseCircuitCall(call);
  if (current) for (const gate of owned.gates) if (gate.report) update(gate.entry);
}
function succeed(entry: CircuitEntry): void {
  if (entry.state === 'half-open') {
    if (++entry.successCount >= CONFIG.halfOpenSuccessThreshold) {
      entry.state = 'closed';
      entry.version++;
      entry.failureCount = 0;
      entry.successCount = 0;
      entry.lastStateChange = Date.now();
    }
  } else if (entry.state === 'closed') {
    entry.failureCount = Math.max(0, entry.failureCount - 1);
  }
}
export function recordSuccess(provider: string, model?: string, call?: CircuitCall): void {
  if (call) return settleCall(call, succeed);
  const entry = entryFor(circuitKey(provider, model));
  // Legacy synchronous reports cannot consume a recovery lease owned by a call.
  if (!entry.probe) succeed(entry);
}
type FailureOptions = { openImmediately?: boolean; cooldownMs?: number };
function fail(entry: CircuitEntry, options: FailureOptions): void {
  const now = Date.now();
  if (now - entry.lastFailureTime > CONFIG.failureWindowMs) entry.failureCount = 0;
  entry.failureCount++;
  entry.lastFailureTime = now;
  if ((options.openImmediately || entry.failureCount >= CONFIG.failureThreshold || entry.state === 'half-open')
    && entry.state !== 'open') {
    entry.state = 'open';
    entry.version++;
    entry.lastStateChange = now;
    entry.successCount = 0;
    delete entry.probe;
    entry.cooldownMs = Number.isFinite(options.cooldownMs) ? Math.max(0, Number(options.cooldownMs)) : undefined;
  }
}
export function recordFailure(
  provider: string, model?: string, _error?: Error,
  options: FailureOptions = {}, call?: CircuitCall,
): void {
  if (call) return settleCall(call, entry => fail(entry, options));
  fail(entryFor(circuitKey(provider, model)), options);
}
export function resetCircuit(provider?: string, model?: string): void {
  if (!provider) {
    configurationGeneration = randomUUID();
    providerGenerations.clear();
    circuits.clear();
  } else if (model) {
    circuits.delete(circuitKey(provider, model));
  } else {
    providerGenerations.set(provider, (providerGenerations.get(provider) || 0) + 1);
    for (const key of circuits.keys()) if (key === provider || key.startsWith(provider + ':')) circuits.delete(key);
  }
}
export function getCircuitStatus(): Array<{
  key: string; state: CircuitState; failureCount: number; lastFailureTime: number;
}> {
  return [...circuits].filter(([, entry]) => entry.failureCount > 0 || entry.state !== 'closed')
    .map(([key, entry]) => ({ key, state: entry.state, failureCount: entry.failureCount, lastFailureTime: entry.lastFailureTime }));
}
