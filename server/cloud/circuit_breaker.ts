/**
 * Circuit Breaker for cloud API providers.
 *
 * Tracks failures per provider + model combination and opens the circuit
 * when the failure threshold is exceeded (fail-fast) rather than hammering
 * a failing endpoint. After the cooldown period, half-open probes determine
 * if the service has recovered.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  successCount: number;      // consecutive successes in half-open
  lastFailureTime: number;
  lastStateChange: number;
}

const circuits = new Map<string, CircuitEntry>();

const CONFIG = {
  /** Failures before circuit opens (within failureWindowMs) */
  failureThreshold: 5,
  /** Consecutive successes in half-open to close circuit */
  halfOpenSuccessThreshold: 2,
  /** Cooldown before transitioning from open → half-open (ms) */
  cooldownMs: 30_000,
  /** Reset failure count if no failures within this window (ms) */
  failureWindowMs: 60_000,
};

export function setCircuitBreakerConfig(overrides: Partial<typeof CONFIG>) {
  Object.assign(CONFIG, overrides);
}

function circuitKey(provider: string, model?: string): string {
  return model ? `${provider}:${model}` : provider;
}

/**
 * Check if a circuit is closed (allowing requests).
 * If open, checks if cooldown has expired → transitions to half-open.
 */
export function isCircuitClosed(provider: string, model?: string): boolean {
  const key = circuitKey(provider, model);
  const entry = circuits.get(key);

  // No entry means never failed — closed
  if (!entry) return true;

  if (entry.state === 'closed') return true;

  if (entry.state === 'open') {
    const elapsed = Date.now() - entry.lastStateChange;
    if (elapsed >= CONFIG.cooldownMs) {
      // Transition to half-open — allow a probe
      entry.state = 'half-open';
      entry.lastStateChange = Date.now();
      console.log(`[CircuitBreaker] ${key} → half-open (cooldown elapsed)`);
      return true; // Allow one probe request
    }
    return false;
  }

  // half-open — allow the probe
  return true;
}

/**
 * Read-only health check. Unlike isCircuitClosed, this never advances an open
 * circuit into half-open merely because a status screen was viewed.
 */
export function isCircuitHealthy(provider: string, model?: string): boolean {
  const entry = circuits.get(circuitKey(provider, model));
  return !entry || entry.state === 'closed';
}

/**
 * Record a successful call. Closes the circuit if half-open threshold is met.
 */
export function recordSuccess(provider: string, model?: string): void {
  const key = circuitKey(provider, model);
  let entry = circuits.get(key);
  if (!entry) {
    entry = { state: 'closed', failureCount: 0, successCount: 0, lastFailureTime: 0, lastStateChange: 0 };
    circuits.set(key, entry);
  }

  if (entry.state === 'half-open') {
    entry.successCount++;
    if (entry.successCount >= CONFIG.halfOpenSuccessThreshold) {
      entry.state = 'closed';
      entry.failureCount = 0;
      entry.successCount = 0;
      entry.lastStateChange = Date.now();
      console.log(`[CircuitBreaker] ${key} → closed (recovered)`);
    }
  } else if (entry.state === 'closed') {
    // Reset failure window on success
    entry.failureCount = Math.max(0, entry.failureCount - 1);
  }
}

/**
 * Record a failure. Opens the circuit if threshold is exceeded.
 */
export function recordFailure(
  provider: string,
  model?: string,
  error?: Error,
  options: { openImmediately?: boolean } = {},
): void {
  const key = circuitKey(provider, model);
  let entry = circuits.get(key);
  const now = Date.now();

  if (!entry) {
    entry = { state: 'closed', failureCount: 0, successCount: 0, lastFailureTime: now, lastStateChange: now };
    circuits.set(key, entry);
  }

  // Reset counter if failure window has passed
  if (now - entry.lastFailureTime > CONFIG.failureWindowMs) {
    entry.failureCount = 0;
  }

  entry.failureCount++;
  entry.lastFailureTime = now;

  const shouldOpen = options.openImmediately || entry.failureCount >= CONFIG.failureThreshold || entry.state === 'half-open';
  if (shouldOpen && entry.state !== 'open') {
    entry.state = 'open';
    entry.lastStateChange = now;
    entry.successCount = 0;
    console.log(`[CircuitBreaker] ${key} → OPEN (${entry.failureCount} failures)${error ? ` — ${error.message}` : ''}`);
  }
}

/**
 * Reset a specific circuit or all circuits.
 */
export function resetCircuit(provider?: string, model?: string): void {
  if (provider) {
    const key = circuitKey(provider, model);
    circuits.delete(key);
  } else {
    circuits.clear();
  }
}

/**
 * Get status of all tracked circuits.
 */
export function getCircuitStatus(): Array<{
  key: string;
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
}> {
  const result: Array<{
    key: string;
    state: CircuitState;
    failureCount: number;
    lastFailureTime: number;
  }> = [];

  for (const [key, entry] of circuits.entries()) {
    if (entry.failureCount > 0 || entry.state !== 'closed') {
      result.push({
        key,
        state: entry.state,
        failureCount: entry.failureCount,
        lastFailureTime: entry.lastFailureTime,
      });
    }
  }

  return result;
}
