import type { ToolExecutionRecord } from '../tools/types';

const INCOMPLETE_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'error',
  'failed',
  'in_progress',
  'partial',
  'pending',
  'queued',
  'requires_setup',
  'submitted_unverified',
  'timeout',
  'timed_out',
]);

function parseStructuredResult(value: string): Record<string, unknown> | null {
  let parsed: unknown = value;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

export function summarizeToolRecordForPersistence(record: ToolExecutionRecord): string {
  if (record.error) return `[Tool: ${record.name}] Error: ${record.error}`;

  const payload = parseStructuredResult(String(record.result || '').trim());
  const status = typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : '';
  if (status && INCOMPLETE_STATUSES.has(status)) {
    return `[Tool: ${record.name}] Status: ${status}`;
  }
  if (payload?.ok === false) return `[Tool: ${record.name}] Not completed`;
  if (payload?.completionMarkerExists === false) {
    return `[Tool: ${record.name}] Missing completion evidence`;
  }
  return `[Tool: ${record.name}] Done`;
}
