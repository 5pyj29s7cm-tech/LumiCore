import { createHash } from "crypto";
import type { WorkflowScope, WorkflowDefinition } from './contracts';

const SECRET_KEY_RE = /password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin/i;

const SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{12,}\b)/i;

export function nowIso(): string {
  return new Date().toISOString();
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeScope(scope?: Partial<WorkflowScope>): WorkflowScope {
  const domain = scope?.domain === 'work' ? 'work' : 'personal';
  return { domain, orgId: domain === 'work' ? String(scope?.orgId || '') : '' };
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function definitionHash(input: Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'>): string {
  const hashable = clone(input) as Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'>;
  // Review/publish is an attestation over semantic content, not a content mutation.
  delete (hashable.provenance as Partial<WorkflowDefinition['provenance']>).reviewedByUser;
  return createHash('sha256').update(JSON.stringify(stableValue(hashable))).digest('hex');
}

function secretReference(path: string): Record<string, string> {
  return { $secretRef: path || 'runtime_input' };
}

/** Values written to the workflow ledger never contain credentials or raw provider secrets. */
export function redactWorkflowValue(value: unknown, path = 'value', depth = 0): unknown {
  if (depth > 8) return '[nested data omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item, index) => redactWorkflowValue(item, `${path}.${index}`, depth + 1));
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) return secretReference(path);
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 100_000) {
      try { return redactWorkflowValue(JSON.parse(trimmed), path, depth + 1); } catch { /* Preserve non-JSON text below. */ }
    }
    const scrubbed = value.replace(
      /((?:password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin)\s*["']?\s*[:=]\s*["']?)([^,\s"'\\}]+)/gi,
      '$1[redacted]',
    );
    return scrubbed.length > 8_000 ? `${scrubbed.slice(0, 8_000)}...` : scrubbed;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 120)
      .map(([key, item]) => [
        key,
        SECRET_KEY_RE.test(key)
          ? secretReference(`${path}.${key}`)
          : redactWorkflowValue(item, `${path}.${key}`, depth + 1),
      ]),
  );
}

export function boundedRedactedWorkflowValue(value: unknown, path: string, maxChars = 4_000): unknown {
  const redacted = redactWorkflowValue(value, path);
  let serialized = '';
  try { serialized = JSON.stringify(redacted); } catch { serialized = String(redacted ?? ''); }
  if (serialized.length <= maxChars) return redacted;
  return {
    truncated: true,
    preview: serialized.slice(0, maxChars),
  };
}
