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

export const SECRET_DETAIL = /((?:password|passphrase|secret|token|api.?key|authorization|cookie|credential))\s*[:=]\s*\S+/gi;
export const STRUCTURED_SECRET_DETAIL = /("(?:password|passphrase|secret|token|api.?key|authorization|cookie|credential)"\s*:\s*")[^"]+/gi;
export const BEARER_SECRET = /\bBearer\s+\S+/gi;
// i18n-allow -- Chinese internal execution-guard recognition; not user-visible copy.
export const INTERNAL_GUARD_DETAIL = /No successful (?:current-turn )?tool execution|without a current-turn tool receipt|No tool execution started|execution-status claim|Missing (?:verified in-app UI mutation|in-app UI mutation|core|verified|current-turn|in-app|desktop|client|content-read|action) evidence|tool-call protocol leaked|internal tool request|fictional tool-mode|fictional user-switchable tool availability|claimed tool execution without matching tool records|Internal execution recovery|我还不能说正在执行|这一轮没有记录到成功的真实工具执行|这一轮没有成功执行任何工具|我需要先真正调用对应工具|再按当前轮回执汇报进度/iu;
// Old builds rendered the verifier's internal report as assistant prose. Keep
// recognizing that shape at the final boundary so replayed history or a model
// imitation cannot put protocol vocabulary back into customer chat.
export const INTERNAL_EXECUTION_REPORT = /(?:(?:^|\n)\s*(?:状态\s*[:：]\s*(?:受阻|失败|已完成)|Status\s*:\s*(?:blocked|failed|completed))[\s\S]{0,800}(?:^|\n)\s*(?:证据|Evidence)\s*[:：])|(?:^|\n)\s*(?:具体阻塞|执行回馈)\s*[:：]?|(?:^|\n)\s*(?:Concrete blocker|Execution feedback)\s*:|(?:原目标|已有进度|已执行步骤).{0,80}(?:回执|目标状态)/imu; // i18n-allow: reviewed legacy execution-report recognition; not user-visible copy.
export function redactReceiptDetail(value: unknown, maxLength = 180): string {
  const detail = typeof value === 'string'
    ? value
    : (() => {
        try { return JSON.stringify(value) ?? ''; } catch { return String(value ?? ''); }
      })();
  const redacted = detail
    .replace(STRUCTURED_SECRET_DETAIL, '$1[redacted]')
    .replace(SECRET_DETAIL, '$1=[redacted]')
    .replace(BEARER_SECRET, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!redacted || INTERNAL_GUARD_DETAIL.test(redacted) || INTERNAL_EXECUTION_REPORT.test(redacted)) return '';
  return redacted.slice(0, maxLength);
}

/**
 * Shared final-boundary sanitizer for compact user-visible diagnostics.
 * Internal verifier prose is an implementation signal for automatic recovery,
 * never a task blocker that should enter chat history or task feedback.
 */
export function sanitizeExecutionDiagnosticForPublicFeedback(
  value: unknown,
  maxLength = 500,
): string {
  return redactReceiptDetail(value, Math.max(1, Math.min(500, maxLength)));
}
