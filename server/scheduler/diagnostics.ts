import { redactDiagnosticSecrets } from "../client/diagnostic_sanitizer";

/** Keep scheduler state and logs diagnostic without retaining credentials. */
export function redactSchedulerDiagnostic(value: unknown): string {
  return redactDiagnosticSecrets(value instanceof Error ? value.message : value)
    .replace(/\[redacted(?: private key)?\]/giu, '[REDACTED]')
    .slice(0, 2_000);
}
