const SECRET_ASSIGNMENT_RE = /(["']?(?:(?:[a-z0-9][a-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|token|secret|password|passwd|passcode|credential)|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\[redacted\]|[^\s,;}\]]+)/gi;
const SECRET_FIELD_RE = /^(?:(?:[a-z0-9][a-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|token|secret|password|passwd|passcode|credential)|authorization|cookie)$/i;
const AUTHORIZATION_RE = /(\bauthorization["']?\s*[:=]\s*["']?)(?:(bearer|basic)\s+)?(?:\[redacted\]|[^\s,;'"}\]]+)/gi;

/** Remove credentials from text exposed in model/frontend diagnostics. */
export function redactDiagnosticSecrets(value: unknown): string {
  return String(value ?? '')
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      '[redacted private key]',
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
      '$1[redacted]:[redacted]@',
    )
    .replace(AUTHORIZATION_RE, (_match, prefix: string, scheme: string | undefined) => (
      `${prefix}${scheme ? `${scheme} ` : ''}[redacted]`
    ))
    .replace(/Bearer\s+(?:\[redacted\]|[^\s,;'"}\]]+)/gi, 'Bearer [redacted]')
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(SECRET_ASSIGNMENT_RE, (_match, prefix: string, secretValue: string) => {
      const quote = secretValue.startsWith('"')
        ? '"'
        : secretValue.startsWith("'")
        ? "'"
        : '';
      return `${prefix}${quote}[redacted]${quote}`;
    });
}

/** A bounded error string for public runtime/health output. */
export function safeRuntimeError(value: unknown): string | undefined {
  const sanitized = redactDiagnosticSecrets(value).slice(0, 400);
  return sanitized || undefined;
}

/** Clone a public diagnostic payload without changing the internal source state. */
export function sanitizeDiagnosticValue<T>(value: T): T {
  if (typeof value === 'string') return redactDiagnosticSecrets(value) as T;
  if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticValue(item)) as T;
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = SECRET_FIELD_RE.test(key)
      ? '[redacted]'
      : sanitizeDiagnosticValue(item);
  }
  return sanitized as T;
}
