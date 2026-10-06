import type { ToolExecutionRecord } from "../../tools/types";

const INCOMPLETE_AUTONOMOUS_TOOL_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'draft',
  'error',
  'failed',
  'in_progress',
  'partial',
  'pending',
  'prepared',
  'queued',
  'requires_setup',
  'submitted_unverified',
  'timeout',
  'timed_out',
  'unknown',
  'unverified',
]);

export function parseStructuredToolResult(value: string): Record<string, unknown> | null {
  let parsed: unknown = String(value || '').trim();
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

export function isSuccessfulAutonomousToolRecord(record: ToolExecutionRecord): boolean {
  if (record.error || !String(record.result || '').trim()) return false;
  const payload = parseStructuredToolResult(record.result);
  if (!payload) return true;
  if (
    payload.ok === false
    || payload.success === false
    || payload.verified === false
    || payload.completed === false
    || payload.completionMarkerExists === false
  ) {
    return false;
  }
  if (typeof payload.error === 'string' && payload.error.trim()) return false;
  const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  return !status || !INCOMPLETE_AUTONOMOUS_TOOL_STATUSES.has(status);
}

export function upsertToolLedger(ledger: ToolExecutionRecord[], record: ToolExecutionRecord): void {
  const id = String(record.id || '').trim();
  const index = id
    ? ledger.findIndex(item => item.id === id)
    : ledger.findIndex(item => (
        item.name === record.name
        && JSON.stringify(item.arguments || {}) === JSON.stringify(record.arguments || {})
      ));
  const normalized: ToolExecutionRecord = {
    ...record,
    arguments: { ...(record.arguments || {}) },
    result: record.result || '',
  };
  if (index >= 0) ledger[index] = normalized;
  else ledger.push(normalized);
}
