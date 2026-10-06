/** Deterministic key ordering for unbounded JSON identities; array order is retained. */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key]),
  ]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
