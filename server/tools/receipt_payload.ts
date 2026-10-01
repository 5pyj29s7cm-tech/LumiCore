import type { ToolExecutionRecord } from './types';

/**
 * Decode the legacy receipt shapes emitted by built-in, MCP, and relayed
 * tools. Some adapters serialize an already-serialized JSON value, so one
 * parse is not enough. Keep the loop bounded and leave ordinary text intact.
 */
export function parseNestedJson(value: unknown, maxDepth = 5): unknown {
  let parsed = value;
  for (let depth = 0; depth < maxDepth && typeof parsed === 'string'; depth += 1) {
    const current = parsed.trim();
    if (!current) return '';
    try {
      parsed = JSON.parse(current);
    } catch {
      break;
    }
  }
  return parsed;
}

export function hasMeaningfulReceiptValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  return true;
}

/** Prefer the machine receipt, but do not let an empty compatibility field
 * hide a real handler result. */
export function toolRecordTerminalPayload(
  record: Pick<ToolExecutionRecord, 'receipt' | 'result'>,
): unknown {
  const receipt = parseNestedJson(record.receipt);
  if (hasMeaningfulReceiptValue(receipt)) return receipt;
  return parseNestedJson(record.result);
}

export function toolRecordHasTerminalPayload(
  record: Pick<ToolExecutionRecord, 'receipt' | 'result'>,
): boolean {
  return hasMeaningfulReceiptValue(toolRecordTerminalPayload(record));
}

export function toolRecordTerminalText(
  record: Pick<ToolExecutionRecord, 'receipt' | 'result'>,
): string {
  const payload = toolRecordTerminalPayload(record);
  if (!hasMeaningfulReceiptValue(payload)) return '';
  if (typeof payload === 'string') return payload.trim();
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function parseReceiptObject(value: unknown): Record<string, any> | null {
  const parsed = parseNestedJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : null;
}

const TERMINAL_FAILURE_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'denied',
  'error',
  'failed',
  'forbidden',
  'incomplete',
  'needs_confirmation',
  'not_found',
  'not_ready',
  'partial',
  'pending',
  'queued',
  'requires_confirmation',
  'requires_setup',
  'submitted_unverified',
  'timed_out',
  'timeout',
  'unverified',
  'uncertain',
  'not_verified',
]);

const SEMANTIC_FALSE_FIELDS = [
  'sent',
  'opened',
  'saved',
  'written',
  'created',
  'generated',
  'submitted',
  'targetMatched',
  'resultVerified',
  'geometryReady',
  'geometryVerified',
  'executableGeometryAvailable',
] as const;

export function toolRecordSucceeded(record: ToolExecutionRecord): boolean {
  const compact = (value: unknown, limit: number) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  if (!record?.name || compact(record.error, 600)) return false;
  if (record.terminalVerification?.status === 'failed') return false;
  if (!toolRecordHasTerminalPayload(record)) return false;
  const result = compact(toolRecordTerminalText(record), 4000);
  const raw = toolRecordTerminalPayload(record);
  const structuredPayload = raw && typeof raw === 'object' ? raw : null;
  if (structuredPayload && !Array.isArray(structuredPayload)) {
    const payload = structuredPayload as Record<string, any>;
    const verification = payload.verification && typeof payload.verification === 'object'
      ? payload.verification as Record<string, any>
      : {};
    const status = compact(
      payload.status
        || payload.verificationStatus
        || verification.status,
      80,
    ).toLowerCase();
    // The dedicated WPS create adapter deliberately leaves a newly-created
    // document unsaved unless the user explicitly requested a save path.
    // `saved: false` is therefore a verified state of that create operation,
    // not evidence that document creation failed. Save contracts are checked
    // separately by the action contract and still require `saved: true` plus
    // a concrete path.
    const ignoredFalseFields = /^(?:wps_create_document|wps_create_document_with_text)$/i.test(record.name)
      ? new Set<string>(['saved'])
      : new Set<string>();
    const declaredProgress = record.terminalVerification?.status === 'verified'
      && record.capability?.verification.successStatuses?.includes(status)
      && ['started', 'queued', 'running', 'waiting_confirmation', 'paused'].includes(status);
    if (declaredProgress) ignoredFalseFields.add('completed');
    const explicitlyFailedOutcome = SEMANTIC_FALSE_FIELDS.some(field => (
      !ignoredFalseFields.has(field) && payload[field] === false
    ));
    const verifiedRuntimeCancellation = record.name === 'runtime_work_cancel'
      && payload.ok === true
      && Number(payload.failedCount || 0) === 0
      && (status === 'idle' || status === 'cancelled');
    if (verifiedRuntimeCancellation) return true;
    if (
      payload.ok === false
      || payload.success === false
      || payload.failed === true
      || payload.completed === false && !declaredProgress
      || payload.verified === false
      || explicitlyFailedOutcome
      || payload.completionMarkerExists === false
      || payload.requiresConfirmation === true
      || payload.confirmationRequired === true
      || TERMINAL_FAILURE_STATUSES.has(status)
      || compact(payload.error || verification.error, 400)
    ) return false;
    // A structured terminal receipt is authoritative. Do not scan its JSON
    // text for words such as `failed` after the structured value explicitly
    // reported `failed: 0`; that production bug inverted verified client
    // actions into failures.
    return true;
  }
  if (Array.isArray(structuredPayload)) return true;
  return !/(?:requires? (?:user )?confirmation|permission denied|not allowed|forbidden|timed out|(?:^|\b)(?:failed|error|blocked)(?:\b|:))/i.test(result);
}

// Persisted rows contain one JSON layer; do not reinterpret strings as nested receipts.
export function parseStoredObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

export function parseStoredArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
