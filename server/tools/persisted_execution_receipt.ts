import type {
  ToolExecutionEnvelope,
  ToolExecutionEnvelopeStatus,
} from './types';

export interface PersistedToolExecutionReceiptLike {
  taskId?: unknown;
  turnId?: unknown;
  requestId?: unknown;
  idempotencyKey?: unknown;
  toolName?: unknown;
  targetIdentity?: unknown;
  outcome?: unknown;
  envelope?: unknown;
}

export interface PersistedToolExecutionReceiptExpectation {
  rowTaskId?: string;
  envelopeTaskId?: string;
  turnId?: string;
  requestId?: string;
  toolName?: string;
  outcome?: ToolExecutionEnvelopeStatus;
}

export interface PersistedToolExecutionReceiptInspection {
  valid: boolean;
  reason: string;
  envelope?: ToolExecutionEnvelope;
  verificationStatus: '' | 'verified' | 'unverified' | 'failed';
  verificationBasis: '' | 'terminal_verification' | 'compatibility_inference';
  explicitlyTerminalVerified: boolean;
}

const ENVELOPE_STATUSES = new Set<ToolExecutionEnvelopeStatus>([
  'verified_success',
  'failed',
  'timeout',
  'forbidden',
  'waiting_confirmation',
  'unknown_outcome',
  'target_mismatch',
]);

const VERIFICATION_STATUSES = new Set(['verified', 'unverified', 'failed'] as const);
const VERIFICATION_BASES = new Set(['terminal_verification', 'compatibility_inference'] as const);

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseEnvelope(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function invalid(reason: string): PersistedToolExecutionReceiptInspection {
  return {
    valid: false,
    reason,
    verificationStatus: '',
    verificationBasis: '',
    explicitlyTerminalVerified: false,
  };
}

/**
 * Validate the durable row/envelope binding before an action receipt is used
 * as acceptance evidence. This is structural fail-closed validation, not a
 * cryptographic authenticity claim: every identity and outcome stored outside
 * the envelope must agree with the canonical envelope written for that call.
 *
 * Scheduler audit rows intentionally use a stable row task id and a distinct
 * per-run envelope task id. Callers must provide both expected identities for
 * that special case; ordinary capability/conversation receipts default to an
 * exact row/envelope task-id match.
 */
export function inspectPersistedToolExecutionReceipt(
  row: PersistedToolExecutionReceiptLike,
  expected: PersistedToolExecutionReceiptExpectation = {},
): PersistedToolExecutionReceiptInspection {
  const envelope = parseEnvelope(row?.envelope);
  if (!envelope) return invalid('missing_or_invalid_envelope');
  if (envelope.version !== 1) return invalid('unsupported_envelope_version');

  const rowTaskId = text(row.taskId);
  const rowTurnId = text(row.turnId);
  const rowRequestId = text(row.requestId);
  const rowToolName = text(row.toolName);
  const rowOutcome = text(row.outcome) as ToolExecutionEnvelopeStatus;
  const rowIdempotencyKey = text(row.idempotencyKey);
  const rowTargetIdentity = text(row.targetIdentity);

  const envelopeTaskId = text(envelope.taskId);
  const envelopeTurnId = text(envelope.turnId);
  const envelopeRequestId = text(envelope.requestId);
  const envelopeToolName = text(envelope.toolName);
  const envelopeStatus = text(envelope.status) as ToolExecutionEnvelopeStatus;
  const envelopeIdempotencyKey = text(envelope.idempotencyKey);
  const envelopeTargetIdentity = text(envelope.targetIdentity);

  if (!rowTaskId || !rowTurnId || !rowRequestId || !rowToolName || !rowOutcome || !rowIdempotencyKey) {
    return invalid('missing_row_execution_identity');
  }
  if (!envelopeTaskId || !envelopeTurnId || !envelopeRequestId || !envelopeToolName || !envelopeIdempotencyKey) {
    return invalid('missing_envelope_execution_identity');
  }
  if (!ENVELOPE_STATUSES.has(rowOutcome) || !ENVELOPE_STATUSES.has(envelopeStatus)) {
    return invalid('invalid_execution_outcome');
  }
  if (!text(envelope.completedAt)) return invalid('missing_envelope_completion_time');

  const expectedRowTaskId = text(expected.rowTaskId) || rowTaskId;
  const expectedEnvelopeTaskId = text(expected.envelopeTaskId) || expectedRowTaskId;
  const expectedTurnId = text(expected.turnId) || rowTurnId;
  const expectedRequestId = text(expected.requestId) || rowRequestId;
  const expectedToolName = text(expected.toolName) || rowToolName;
  const expectedOutcome = (text(expected.outcome) || rowOutcome) as ToolExecutionEnvelopeStatus;

  if (rowTaskId !== expectedRowTaskId || envelopeTaskId !== expectedEnvelopeTaskId) {
    return invalid('task_identity_mismatch');
  }
  if (rowTurnId !== expectedTurnId || envelopeTurnId !== expectedTurnId) {
    return invalid('turn_identity_mismatch');
  }
  if (rowRequestId !== expectedRequestId || envelopeRequestId !== expectedRequestId) {
    return invalid('request_identity_mismatch');
  }
  if (rowToolName !== expectedToolName || envelopeToolName !== expectedToolName) {
    return invalid('tool_identity_mismatch');
  }
  if (rowOutcome !== expectedOutcome || envelopeStatus !== expectedOutcome) {
    return invalid('outcome_status_mismatch');
  }
  if (rowIdempotencyKey !== envelopeIdempotencyKey) {
    return invalid('idempotency_identity_mismatch');
  }
  if (rowTargetIdentity !== envelopeTargetIdentity) {
    return invalid('target_identity_mismatch');
  }

  const verification = envelope.verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    return invalid('missing_envelope_verification');
  }
  const verificationStatus = text(verification.status) as PersistedToolExecutionReceiptInspection['verificationStatus'];
  const verificationBasis = text(verification.basis) as PersistedToolExecutionReceiptInspection['verificationBasis'];
  if (!VERIFICATION_STATUSES.has(verificationStatus as any)) {
    return invalid('invalid_verification_status');
  }
  if (verificationBasis && !VERIFICATION_BASES.has(verificationBasis as any)) {
    return invalid('invalid_verification_basis');
  }

  return {
    valid: true,
    reason: 'valid',
    envelope: envelope as ToolExecutionEnvelope,
    verificationStatus,
    verificationBasis,
    explicitlyTerminalVerified: verificationStatus === 'verified'
      && verificationBasis === 'terminal_verification',
  };
}
