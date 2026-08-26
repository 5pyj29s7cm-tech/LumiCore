import crypto from 'node:crypto';
import type { NormalizedSideEffectClass } from './normalized_action_intent';
import type { ToolExecutionEnvelopeStatus, ToolExecutionRecord } from '../tools/types';
import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';

export type DurableTaskFailureClass =
  | 'transient'
  | 'dependency_unavailable'
  | 'precondition'
  | 'confirmation_required'
  | 'policy_blocked'
  | 'target_mismatch'
  | 'verification_failed'
  | 'unknown_outcome'
  | 'lease_lost'
  | 'permanent';

export type DurableTaskRecoveryDecision = 'retry' | 'replan' | 'block' | 'fail';

export interface DurableTaskReceiptSnapshot {
  id: string;
  name: string;
  idempotencyKey: string;
  status: ToolExecutionEnvelopeStatus | 'success' | 'failure' | 'unverified';
  verificationStatus: 'verified' | 'unverified' | 'failed';
  operation: string;
  sideEffects: Array<{ type: string; reversible: boolean }>;
  resultDigest: string;
  error: string;
  recordedAt: string;
}

export interface DurableTaskDiagnosis {
  id: string;
  failureClass: DurableTaskFailureClass;
  decision: DurableTaskRecoveryDecision;
  retrySafe: boolean;
  fingerprint: string;
  reason: string;
  attempt: number;
  recoveryCount: number;
  consecutiveCount: number;
  diagnosedAt: string;
  nextAttemptAt?: string;
}

export interface DurableTaskPlanRevision {
  revision: number;
  strategy: 'retry_same_plan' | 'resume_verified_receipts' | 'replan_safe_path';
  reason: string;
  preservedReceiptIds: string[];
  /** Structured binding used by graph recovery; prose IDs alone are not a safety gate. */
  preservedReceipts?: Array<Pick<
    DurableTaskReceiptSnapshot,
    'id' | 'operation' | 'sideEffects' | 'verificationStatus'
  >>;
  createdAt: string;
}

export interface DurableTaskRecoveryState {
  version: 1;
  diagnoses: DurableTaskDiagnosis[];
  planRevisions: DurableTaskPlanRevision[];
  lastFailureClass?: DurableTaskFailureClass;
  lastFailureFingerprint?: string;
  consecutiveFailureCount: number;
  nextAttemptAt?: string;
  blockedReason?: string;
}

export interface DiagnoseDurableTaskFailureInput {
  error: unknown;
  toolRecords?: ToolExecutionRecord[];
  receiptSnapshots?: DurableTaskReceiptSnapshot[];
  sideEffectClass?: NormalizedSideEffectClass;
  verificationFailure?: boolean;
  leaseLost?: boolean;
  attempt: number;
  recoveryCount: number;
  previous?: DurableTaskRecoveryState;
  maxAttempts?: number;
  maxRecoveries?: number;
  maxConsecutiveFailures?: number;
  now?: Date;
  baseDelayMs?: number;
}

export interface DurableResumeSafety {
  allowed: boolean;
  strategy: 'fresh' | 'resume_verified_receipts' | 'replay_read_only' | 'block_unknown_outcome' | 'block_unsafe_replay';
  reason: string;
}

const TRANSIENT_RE = /timed?\s*out|timeout|econnreset|econnrefused|epipe|socket|connection|disconnect|temporar|try again|rate.?limit|429|502|503|504|service unavailable|transport closed|broken pipe|network/i;
const DEPENDENCY_RE = /provider|model|mcp|adapter|sidecar|worker|runtime|service|dependency|no worker agent|not ready|not configured|process exited|crash|unavailable/i;
const CONFIRMATION_RE = /confirm|confirmation|approval|user consent|requires?\s+user|\u786e\u8ba4|\u6279\u51c6|\u6388\u6743/i;
const POLICY_RE = /forbidden|denied|not allowed|policy|safety gate|permission|unauthori[sz]ed|\u7981\u6b62|\u62d2\u7edd|\u65e0\u6743/i;
const PRECONDITION_RE = /missing input|precondition|requires? setup|not configured|not found|invalid target|missing target|missing credential|\u7f3a\u5c11|\u672a\u627e\u5230/i;
function compact(value: unknown, limit = 700): string {
  return redactDiagnosticSecrets(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseStatus(record: ToolExecutionRecord): DurableTaskReceiptSnapshot['status'] {
  if (record.envelope?.status) return record.envelope.status;
  if (record.error) return TRANSIENT_RE.test(record.error) ? 'timeout' : 'failure';
  if (record.terminalVerification?.status === 'verified') return 'success';
  if (record.terminalVerification?.status === 'failed') return 'failure';
  return String(record.result || '').trim() ? 'unverified' : 'failure';
}

export function snapshotDurableToolRecord(
  record: ToolExecutionRecord,
  recordedAt = new Date().toISOString(),
): DurableTaskReceiptSnapshot {
  return {
    id: compact(record.id, 180) || digest([record.name, record.idempotencyKey, record.arguments]).slice(0, 32),
    name: compact(record.name, 180),
    idempotencyKey: compact(record.idempotencyKey || record.envelope?.idempotencyKey, 300),
    status: parseStatus(record),
    verificationStatus: record.envelope?.verification.status
      || record.terminalVerification?.status
      || (record.error ? 'failed' : 'unverified'),
    operation: compact(record.capability?.operation || record.evidence?.operation || 'unknown', 40),
    sideEffects: (record.capability?.sideEffects || []).slice(0, 20).map(effect => ({
      type: compact(effect.type, 80),
      reversible: effect.reversible === true,
    })),
    resultDigest: digest({ result: record.result || '', receipt: record.receipt, envelope: record.envelope?.result }),
    error: compact(record.envelope?.error || record.error, 500),
    recordedAt,
  };
}

export function snapshotDurableToolRecords(records: ToolExecutionRecord[]): DurableTaskReceiptSnapshot[] {
  const byId = new Map<string, DurableTaskReceiptSnapshot>();
  for (const record of records.slice(-100)) {
    const snapshot = snapshotDurableToolRecord(record);
    byId.set(snapshot.id, snapshot);
  }
  return Array.from(byId.values()).slice(-80);
}

function isExternal(snapshot: DurableTaskReceiptSnapshot): boolean {
  return snapshot.sideEffects.some(effect => (
    effect.type === 'external_state_change'
    || effect.type === 'external_communication'
    || effect.type === 'credential_access'
  ));
}

function hasUnsafeReplay(snapshot: DurableTaskReceiptSnapshot): boolean {
  if (snapshot.operation === 'observe' || snapshot.operation === 'test') {
    return snapshot.sideEffects.some(effect => !['none', 'local_read', 'network_read'].includes(effect.type));
  }
  return snapshot.sideEffects.some(effect => effect.type !== 'none')
    || !['observe', 'test'].includes(snapshot.operation);
}

function hasUnknownOutcome(snapshots: DurableTaskReceiptSnapshot[]): boolean {
  return snapshots.some(snapshot => snapshot.status === 'unknown_outcome');
}

function safeToReplay(snapshots: DurableTaskReceiptSnapshot[]): boolean {
  return !hasUnknownOutcome(snapshots) && snapshots.every(snapshot => !hasUnsafeReplay(snapshot));
}

function nextDelayMs(fingerprint: string, attempt: number, baseDelayMs: number): number {
  const exponent = Math.max(0, Math.min(5, attempt - 1));
  const jitter = Number.parseInt(fingerprint.slice(0, 4), 16) % Math.max(1, Math.floor(baseDelayMs / 3));
  return Math.min(60_000, baseDelayMs * (2 ** exponent) + jitter);
}

export function diagnoseDurableTaskFailure(input: DiagnoseDurableTaskFailureInput): DurableTaskDiagnosis {
  const now = input.now || new Date();
  const diagnosedAt = now.toISOString();
  const snapshots = input.receiptSnapshots || snapshotDurableToolRecords(input.toolRecords || []);
  const rawReason = compact(input.error instanceof Error ? input.error.message : input.error, 700)
    || (input.verificationFailure ? 'Completion evidence did not satisfy the task acceptance criteria.' : 'Unknown durable task failure.');
  const envelopeStatuses = new Set(snapshots.map(item => item.status));
  const external = input.sideEffectClass === 'external_commit' || snapshots.some(isExternal);
  const timedOut = envelopeStatuses.has('timeout') || TRANSIENT_RE.test(rawReason);

  let failureClass: DurableTaskFailureClass;
  if (input.leaseLost) failureClass = 'lease_lost';
  else if (hasUnknownOutcome(snapshots) || (external && timedOut)) failureClass = 'unknown_outcome';
  else if (envelopeStatuses.has('waiting_confirmation') || CONFIRMATION_RE.test(rawReason)) failureClass = 'confirmation_required';
  else if (envelopeStatuses.has('target_mismatch')) failureClass = 'target_mismatch';
  else if (envelopeStatuses.has('forbidden') || POLICY_RE.test(rawReason)) failureClass = 'policy_blocked';
  else if (input.verificationFailure) failureClass = 'verification_failed';
  else if (PRECONDITION_RE.test(rawReason)) failureClass = 'precondition';
  else if (DEPENDENCY_RE.test(rawReason)) failureClass = 'dependency_unavailable';
  else if (timedOut) failureClass = 'transient';
  else failureClass = 'permanent';

  const fingerprint = digest({
    failureClass,
    reason: rawReason.toLowerCase().replace(/\b\d+\b/g, '#'),
    statuses: Array.from(envelopeStatuses).sort(),
    tools: snapshots.map(item => item.name).sort(),
  });
  const previousCount = input.previous?.lastFailureFingerprint === fingerprint
    ? input.previous.consecutiveFailureCount
    : 0;
  const consecutiveCount = previousCount + 1;
  const retrySafe = !external && safeToReplay(snapshots);
  const maxAttempts = Math.max(1, input.maxAttempts || 3);
  const maxRecoveries = Math.max(0, input.maxRecoveries ?? 2);
  const maxConsecutiveFailures = Math.max(1, input.maxConsecutiveFailures || 2);
  const withinBudget = input.attempt < maxAttempts
    && input.recoveryCount <= maxRecoveries
    && consecutiveCount <= maxConsecutiveFailures;

  let decision: DurableTaskRecoveryDecision = 'fail';
  if (['unknown_outcome', 'confirmation_required', 'policy_blocked', 'target_mismatch', 'precondition', 'lease_lost'].includes(failureClass)) {
    decision = 'block';
  } else if (failureClass === 'verification_failed' && retrySafe && withinBudget) {
    decision = 'replan';
  } else if (['transient', 'dependency_unavailable'].includes(failureClass) && retrySafe && withinBudget) {
    decision = 'retry';
  } else if (!retrySafe || !withinBudget) {
    decision = 'block';
  }

  const diagnosis: DurableTaskDiagnosis = {
    id: `diagnosis_${fingerprint.slice(0, 16)}_${input.attempt}`,
    failureClass,
    decision,
    retrySafe,
    fingerprint,
    reason: rawReason,
    attempt: input.attempt,
    recoveryCount: input.recoveryCount,
    consecutiveCount,
    diagnosedAt,
  };
  if (decision === 'retry' || decision === 'replan') {
    diagnosis.nextAttemptAt = new Date(
      now.getTime() + nextDelayMs(fingerprint, input.attempt, Math.max(100, input.baseDelayMs || 1_000)),
    ).toISOString();
  }
  return diagnosis;
}

export function updateDurableTaskRecovery(
  previous: DurableTaskRecoveryState | undefined,
  diagnosis: DurableTaskDiagnosis,
  receipts: DurableTaskReceiptSnapshot[] = [],
): DurableTaskRecoveryState {
  const state: DurableTaskRecoveryState = previous
    ? {
        ...previous,
        diagnoses: [...previous.diagnoses],
        planRevisions: [...previous.planRevisions],
      }
    : {
        version: 1,
        diagnoses: [],
        planRevisions: [],
        consecutiveFailureCount: 0,
      };
  state.diagnoses = [...state.diagnoses, diagnosis].slice(-20);
  state.lastFailureClass = diagnosis.failureClass;
  state.lastFailureFingerprint = diagnosis.fingerprint;
  state.consecutiveFailureCount = diagnosis.consecutiveCount;
  state.nextAttemptAt = diagnosis.nextAttemptAt;
  state.blockedReason = diagnosis.decision === 'block' || diagnosis.decision === 'fail'
    ? diagnosis.reason
    : undefined;
  if (diagnosis.decision === 'retry' || diagnosis.decision === 'replan') {
    const revision: DurableTaskPlanRevision = {
      revision: (state.planRevisions.at(-1)?.revision || 0) + 1,
      strategy: diagnosis.decision === 'replan' ? 'replan_safe_path' : 'retry_same_plan',
      reason: diagnosis.reason,
      preservedReceiptIds: receipts
        .filter(receipt => receipt.verificationStatus === 'verified')
        .map(receipt => receipt.id)
        .slice(-80),
      preservedReceipts: receipts
        .filter(receipt => receipt.verificationStatus === 'verified')
        .slice(-80)
        .map(receipt => ({
          id: receipt.id,
          operation: receipt.operation,
          sideEffects: receipt.sideEffects.map(effect => ({ ...effect })),
          verificationStatus: receipt.verificationStatus,
        })),
      createdAt: diagnosis.diagnosedAt,
    };
    state.planRevisions = [...state.planRevisions, revision].slice(-20);
  }
  return state;
}

export function evaluateDurableResumeSafety(
  receipts: DurableTaskReceiptSnapshot[] = [],
  hasPersistentReceiptLedger = false,
): DurableResumeSafety {
  if (receipts.length === 0) return { allowed: true, strategy: 'fresh', reason: 'No terminal tool receipt was recorded before interruption.' };
  if (hasUnknownOutcome(receipts)) {
    return {
      allowed: false,
      strategy: 'block_unknown_outcome',
      reason: 'A prior tool call has an unknown outcome; automatic replay is forbidden.',
    };
  }
  if (safeToReplay(receipts)) {
    return { allowed: true, strategy: 'replay_read_only', reason: 'Only read-only or test receipts will be replayed.' };
  }
  const allSideEffectsVerified = receipts
    .filter(hasUnsafeReplay)
    .every(receipt => receipt.verificationStatus === 'verified' && Boolean(receipt.id));
  if (hasPersistentReceiptLedger && allSideEffectsVerified) {
    return {
      allowed: true,
      strategy: 'resume_verified_receipts',
      reason: 'Verified side-effect receipts are available to the persistent execution graph and must be reused.',
    };
  }
  return {
    allowed: false,
    strategy: 'block_unsafe_replay',
    reason: 'The interrupted task contains side effects that cannot be proven safe to replay.',
  };
}

export function isDurableTaskReady(nextAttemptAt: string | undefined, now = Date.now()): boolean {
  return !nextAttemptAt || new Date(nextAttemptAt).getTime() <= now;
}
