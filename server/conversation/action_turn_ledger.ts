import { createHash, randomUUID } from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';

export const DEFAULT_CONVERSATION_ACTION_TURN_LEASE_TTL_MS = 90_000;
export const MAX_CONVERSATION_ACTION_TURN_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

export type ConversationActionTurnStatus =
  | 'accepted'
  | 'leased'
  | 'terminal'
  | 'cancelled'
  | 'persistence_unknown';

export type ConversationActionTurnTerminalStatus = Exclude<
  ConversationActionTurnStatus,
  'accepted' | 'leased'
>;

export interface ConversationActionTurnIdentity {
  conversationId: string;
  userId: string;
  requestId: string;
}

export interface ConversationActionTurn extends ConversationActionTurnIdentity {
  id: string;
  domain: string;
  orgId: string;
  userMessageId: string;
  taskId: string;
  channel: string;
  source: string;
  status: ConversationActionTurnStatus;
  leaseOwnerId: string;
  leaseEpoch: string;
  leaseAcquiredAt: string;
  leaseHeartbeatAt: string;
  leaseExpiresAt: string;
  terminalMessageId: string;
  terminalReason: string;
  recoveryReason: string;
  recoveredAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string;
}

export interface AcceptConversationActionTurnInput extends ConversationActionTurnIdentity {
  userMessageId: string;
  domain?: string;
  orgId?: string;
  channel?: string;
  source?: string;
  now?: Date | string | number;
}

export type AcceptConversationActionTurnResult =
  | { accepted: true; created: boolean; turn: ConversationActionTurn }
  | { accepted: false; created: false; reason: 'identity_conflict'; turn: ConversationActionTurn };

export interface AcquireConversationActionTurnLeaseInput extends ConversationActionTurnIdentity {
  leaseOwnerId: string;
  processEpoch?: string;
  ttlMs?: number;
  expectedRevision?: number;
  now?: Date | string | number;
}

export type AcquireConversationActionTurnLeaseResult =
  | {
      acquired: true;
      recovered: boolean;
      renewed: boolean;
      turn: ConversationActionTurn;
    }
  | {
      acquired: false;
      recovered: boolean;
      renewed: false;
      reason: 'not_found' | 'busy' | 'terminal' | 'revision_mismatch';
      turn: ConversationActionTurn | null;
    };

export interface BindConversationActionTurnTaskInput extends ConversationActionTurnIdentity {
  taskId: string;
  expectedRevision?: number;
  now?: Date | string | number;
}

export type BindConversationActionTurnTaskResult =
  | { bound: true; changed: boolean; turn: ConversationActionTurn }
  | {
      bound: false;
      changed: false;
      reason: 'not_found' | 'terminal' | 'task_conflict' | 'revision_mismatch';
      turn: ConversationActionTurn | null;
    };

export interface ReleaseConversationActionTurnLeaseInput extends ConversationActionTurnIdentity {
  leaseOwnerId: string;
  processEpoch?: string;
  reason: string;
  expectedRevision?: number;
  now?: Date | string | number;
}

export type ReleaseConversationActionTurnLeaseResult =
  | { released: true; changed: boolean; turn: ConversationActionTurn }
  | {
      released: false;
      changed: false;
      reason: 'not_found' | 'lease_mismatch' | 'revision_mismatch' | 'terminal';
      turn: ConversationActionTurn | null;
    };

export interface FinalizeConversationActionTurnInput extends ConversationActionTurnIdentity {
  status: ConversationActionTurnTerminalStatus;
  terminalMessageId?: string;
  reason?: string;
  leaseOwnerId?: string;
  processEpoch?: string;
  expectedRevision?: number;
  /** Reserved for recovery from independently verified durable evidence. */
  force?: boolean;
  now?: Date | string | number;
}

export interface QuarantineConversationActionTurnPersistenceInput
  extends ConversationActionTurnIdentity {
  reason: string;
  now?: Date | string | number;
}

export type FinalizeConversationActionTurnResult =
  | { finalized: true; changed: boolean; turn: ConversationActionTurn }
  | {
      finalized: false;
      changed: false;
      reason:
        | 'not_found'
        | 'lease_mismatch'
        | 'revision_mismatch'
        | 'terminal_conflict'
        | 'terminal_message_required';
      turn: ConversationActionTurn | null;
    };

export interface ReconcileConversationActionTurnLeaseInput extends ConversationActionTurnIdentity {
  processEpoch?: string;
  now?: Date | string | number;
  /** False is durable evidence that the accepted user transcript no longer exists. */
  transcriptPresent?: boolean;
  /** A status observed from durable transcript/task evidence, not an LLM inference. */
  observedStatus?: ConversationActionTurnTerminalStatus;
  terminalMessageId?: string;
  reason?: string;
}

export interface ReconcileConversationActionTurnLeaseResult {
  reconciled: boolean;
  action:
    | 'none'
    | 'released'
    | 'terminal'
    | 'cancelled'
    | 'persistence_unknown';
  reason: string;
  turn: ConversationActionTurn | null;
}

export interface ReconcileConversationActionTurnLeasesInput {
  processEpoch?: string;
  now?: Date | string | number;
}

export interface ReconcileConversationActionTurnLeasesResult {
  inspected: number;
  released: number;
  turns: ConversationActionTurn[];
}

export interface ListConversationActionTurnsInput {
  conversationId?: string;
  userId?: string;
  taskId?: string;
  statuses?: ConversationActionTurnStatus[];
}

const PROCESS_EPOCH = `lumi:${process.pid}:${randomUUID()}`;
const TERMINAL_STATUSES = new Set<ConversationActionTurnStatus>([
  'terminal',
  'cancelled',
  'persistence_unknown',
]);

function required(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optional(value: unknown): string {
  return String(value || '').trim();
}

function resolveNow(value?: Date | string | number): { ms: number; iso: string } {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new TypeError('now must be a valid date');
  return { ms, iso: date.toISOString() };
}

function resolveTtlMs(value?: number): number {
  const ttlMs = value === undefined
    ? DEFAULT_CONVERSATION_ACTION_TURN_LEASE_TTL_MS
    : Number(value);
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > MAX_CONVERSATION_ACTION_TURN_LEASE_TTL_MS) {
    throw new RangeError(
      `ttlMs must be between 1 and ${MAX_CONVERSATION_ACTION_TURN_LEASE_TTL_MS}`,
    );
  }
  return Math.floor(ttlMs);
}

function deterministicTurnId(identity: ConversationActionTurnIdentity): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([identity.conversationId, identity.userId, identity.requestId]))
    .digest('hex')
    .slice(0, 32);
  return `action_turn_${digest}`;
}

function cloneTurn(turn: ConversationActionTurn): ConversationActionTurn {
  return { ...turn };
}

function isTerminalStatus(status: ConversationActionTurnStatus): status is ConversationActionTurnTerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

function turnRows(db: any): ConversationActionTurn[] {
  if (!Array.isArray(db.conversationActionTurns)) db.conversationActionTurns = [];
  return db.conversationActionTurns as ConversationActionTurn[];
}

function identityFrom(input: ConversationActionTurnIdentity): ConversationActionTurnIdentity {
  return {
    conversationId: required(input.conversationId, 'conversationId'),
    userId: required(input.userId, 'userId'),
    requestId: required(input.requestId, 'requestId'),
  };
}

function findTurnIndex(rows: ConversationActionTurn[], identity: ConversationActionTurnIdentity): number {
  return rows.findIndex(turn => turn.conversationId === identity.conversationId
    && turn.userId === identity.userId
    && turn.requestId === identity.requestId);
}

function clearLease(turn: ConversationActionTurn): void {
  turn.leaseOwnerId = '';
  turn.leaseEpoch = '';
  turn.leaseAcquiredAt = '';
  turn.leaseHeartbeatAt = '';
  turn.leaseExpiresAt = '';
}

function staleLeaseReason(
  turn: ConversationActionTurn,
  processEpoch: string,
  nowMs: number,
): string {
  if (turn.status !== 'leased') return '';
  if (!turn.leaseOwnerId || !turn.leaseEpoch || !turn.leaseExpiresAt) return 'lease_incomplete';
  if (turn.leaseEpoch !== processEpoch) return 'process_epoch_changed';
  const expiresAt = Date.parse(turn.leaseExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return 'lease_expired';
  return '';
}

function releaseStaleLease(
  turn: ConversationActionTurn,
  processEpoch: string,
  nowMs: number,
  nowIso: string,
): string {
  const reason = staleLeaseReason(turn, processEpoch, nowMs);
  if (!reason) return '';
  turn.status = 'accepted';
  clearLease(turn);
  turn.recoveryReason = reason;
  turn.recoveredAt = nowIso;
  turn.updatedAt = nowIso;
  turn.revision += 1;
  return reason;
}

function applyTerminalState(
  turn: ConversationActionTurn,
  input: Pick<FinalizeConversationActionTurnInput, 'status' | 'terminalMessageId' | 'reason'>,
  nowIso: string,
): void {
  turn.status = input.status;
  turn.terminalMessageId = optional(input.terminalMessageId);
  turn.terminalReason = optional(input.reason);
  turn.terminalAt = nowIso;
  turn.updatedAt = nowIso;
  turn.revision += 1;
  clearLease(turn);
}

function terminalStateIsIdempotent(
  turn: ConversationActionTurn,
  input: Pick<FinalizeConversationActionTurnInput, 'status' | 'terminalMessageId'>,
): boolean {
  if (turn.status !== input.status) return false;
  const messageId = optional(input.terminalMessageId);
  return !messageId || !turn.terminalMessageId || turn.terminalMessageId === messageId;
}

export function getConversationActionTurnProcessEpoch(): string {
  return PROCESS_EPOCH;
}

export function isConversationActionTurnTerminalStatus(
  status: ConversationActionTurnStatus,
): status is ConversationActionTurnTerminalStatus {
  return isTerminalStatus(status);
}

export function acceptConversationActionTurn(
  input: AcceptConversationActionTurnInput,
): AcceptConversationActionTurnResult {
  const identity = identityFrom(input);
  const userMessageId = required(input.userMessageId, 'userMessageId');
  const { iso } = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const existingIndex = findTurnIndex(rows, identity);
  if (existingIndex >= 0) {
    const existing = rows[existingIndex];
    if (existing.userMessageId !== userMessageId) {
      return {
        accepted: false,
        created: false,
        reason: 'identity_conflict',
        turn: cloneTurn(existing),
      };
    }
    return { accepted: true, created: false, turn: cloneTurn(existing) };
  }

  const turn: ConversationActionTurn = {
    id: deterministicTurnId(identity),
    ...identity,
    domain: optional(input.domain) || 'personal',
    orgId: optional(input.orgId),
    userMessageId,
    taskId: '',
    channel: optional(input.channel),
    source: optional(input.source),
    status: 'accepted',
    leaseOwnerId: '',
    leaseEpoch: '',
    leaseAcquiredAt: '',
    leaseHeartbeatAt: '',
    leaseExpiresAt: '',
    terminalMessageId: '',
    terminalReason: '',
    recoveryReason: '',
    recoveredAt: '',
    revision: 1,
    createdAt: iso,
    updatedAt: iso,
    terminalAt: '',
  };
  rows.push(turn);
  writeDB(db);
  return { accepted: true, created: true, turn: cloneTurn(turn) };
}

export function getConversationActionTurn(
  input: ConversationActionTurnIdentity,
): ConversationActionTurn | null {
  const identity = identityFrom(input);
  const rows = turnRows(readDB());
  const index = findTurnIndex(rows, identity);
  return index >= 0 ? cloneTurn(rows[index]) : null;
}

export function listConversationActionTurns(
  input: ListConversationActionTurnsInput = {},
): ConversationActionTurn[] {
  const statuses = input.statuses ? new Set(input.statuses) : null;
  return turnRows(readDB())
    .filter(turn => !input.conversationId || turn.conversationId === input.conversationId)
    .filter(turn => !input.userId || turn.userId === input.userId)
    .filter(turn => !input.taskId || turn.taskId === input.taskId)
    .filter(turn => !statuses || statuses.has(turn.status))
    .map(cloneTurn);
}

export function acquireConversationActionTurnLease(
  input: AcquireConversationActionTurnLeaseInput,
): AcquireConversationActionTurnLeaseResult {
  const identity = identityFrom(input);
  const leaseOwnerId = required(input.leaseOwnerId, 'leaseOwnerId');
  const processEpoch = optional(input.processEpoch) || PROCESS_EPOCH;
  const ttlMs = resolveTtlMs(input.ttlMs);
  const now = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const index = findTurnIndex(rows, identity);
  if (index < 0) {
    return { acquired: false, recovered: false, renewed: false, reason: 'not_found', turn: null };
  }

  const turn = rows[index];
  if (input.expectedRevision !== undefined && turn.revision !== input.expectedRevision) {
    return {
      acquired: false,
      recovered: false,
      renewed: false,
      reason: 'revision_mismatch',
      turn: cloneTurn(turn),
    };
  }
  if (isTerminalStatus(turn.status)) {
    return {
      acquired: false,
      recovered: false,
      renewed: false,
      reason: 'terminal',
      turn: cloneTurn(turn),
    };
  }

  const recoveryReason = releaseStaleLease(turn, processEpoch, now.ms, now.iso);
  const recovered = Boolean(recoveryReason);
  if (turn.status === 'leased') {
    if (turn.leaseOwnerId !== leaseOwnerId || turn.leaseEpoch !== processEpoch) {
      return {
        acquired: false,
        recovered,
        renewed: false,
        reason: 'busy',
        turn: cloneTurn(turn),
      };
    }
    turn.leaseHeartbeatAt = now.iso;
    turn.leaseExpiresAt = new Date(now.ms + ttlMs).toISOString();
    turn.updatedAt = now.iso;
    turn.revision += 1;
    writeDB(db);
    return { acquired: true, recovered, renewed: true, turn: cloneTurn(turn) };
  }

  turn.status = 'leased';
  turn.leaseOwnerId = leaseOwnerId;
  turn.leaseEpoch = processEpoch;
  turn.leaseAcquiredAt = now.iso;
  turn.leaseHeartbeatAt = now.iso;
  turn.leaseExpiresAt = new Date(now.ms + ttlMs).toISOString();
  turn.updatedAt = now.iso;
  turn.revision += 1;
  writeDB(db);
  return { acquired: true, recovered, renewed: false, turn: cloneTurn(turn) };
}

export function bindConversationActionTurnTask(
  input: BindConversationActionTurnTaskInput,
): BindConversationActionTurnTaskResult {
  const identity = identityFrom(input);
  const taskId = required(input.taskId, 'taskId');
  const { iso } = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const index = findTurnIndex(rows, identity);
  if (index < 0) return { bound: false, changed: false, reason: 'not_found', turn: null };
  const turn = rows[index];
  if (turn.taskId === taskId) return { bound: true, changed: false, turn: cloneTurn(turn) };
  if (input.expectedRevision !== undefined && turn.revision !== input.expectedRevision) {
    return {
      bound: false,
      changed: false,
      reason: 'revision_mismatch',
      turn: cloneTurn(turn),
    };
  }
  if (isTerminalStatus(turn.status)) {
    return { bound: false, changed: false, reason: 'terminal', turn: cloneTurn(turn) };
  }
  if (turn.taskId) {
    return { bound: false, changed: false, reason: 'task_conflict', turn: cloneTurn(turn) };
  }
  turn.taskId = taskId;
  turn.updatedAt = iso;
  turn.revision += 1;
  writeDB(db);
  return { bound: true, changed: true, turn: cloneTurn(turn) };
}

/**
 * Voluntarily yields a live lease without unbinding the durable task. This is
 * the required transition before a task waits for confirmation or becomes
 * blocked; the next user turn may then acquire its own request lease.
 */
export function releaseConversationActionTurnLease(
  input: ReleaseConversationActionTurnLeaseInput,
): ReleaseConversationActionTurnLeaseResult {
  const identity = identityFrom(input);
  const leaseOwnerId = required(input.leaseOwnerId, 'leaseOwnerId');
  const processEpoch = optional(input.processEpoch) || PROCESS_EPOCH;
  const releaseReason = required(input.reason, 'reason');
  const { iso } = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const index = findTurnIndex(rows, identity);
  if (index < 0) return { released: false, changed: false, reason: 'not_found', turn: null };
  const turn = rows[index];
  if (isTerminalStatus(turn.status)) {
    return { released: false, changed: false, reason: 'terminal', turn: cloneTurn(turn) };
  }
  if (turn.status === 'accepted') {
    return { released: true, changed: false, turn: cloneTurn(turn) };
  }
  if (input.expectedRevision !== undefined && turn.revision !== input.expectedRevision) {
    return {
      released: false,
      changed: false,
      reason: 'revision_mismatch',
      turn: cloneTurn(turn),
    };
  }
  if (turn.leaseOwnerId !== leaseOwnerId || turn.leaseEpoch !== processEpoch) {
    return {
      released: false,
      changed: false,
      reason: 'lease_mismatch',
      turn: cloneTurn(turn),
    };
  }
  turn.status = 'accepted';
  clearLease(turn);
  turn.recoveryReason = releaseReason;
  turn.recoveredAt = iso;
  turn.updatedAt = iso;
  turn.revision += 1;
  writeDB(db);
  return { released: true, changed: true, turn: cloneTurn(turn) };
}

export function finalizeConversationActionTurn(
  input: FinalizeConversationActionTurnInput,
): FinalizeConversationActionTurnResult {
  const identity = identityFrom(input);
  const now = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const index = findTurnIndex(rows, identity);
  if (index < 0) return { finalized: false, changed: false, reason: 'not_found', turn: null };
  const turn = rows[index];
  if (input.status === 'terminal' && !optional(input.terminalMessageId)) {
    return {
      finalized: false,
      changed: false,
      reason: 'terminal_message_required',
      turn: cloneTurn(turn),
    };
  }
  if (turn.status === 'terminal' || turn.status === 'cancelled') {
    if (terminalStateIsIdempotent(turn, input)) {
      return { finalized: true, changed: false, turn: cloneTurn(turn) };
    }
    return {
      finalized: false,
      changed: false,
      reason: 'terminal_conflict',
      turn: cloneTurn(turn),
    };
  }
  if (turn.status === 'persistence_unknown' && input.status === 'persistence_unknown') {
    if (terminalStateIsIdempotent(turn, input)) {
      return { finalized: true, changed: false, turn: cloneTurn(turn) };
    }
    return {
      finalized: false,
      changed: false,
      reason: 'terminal_conflict',
      turn: cloneTurn(turn),
    };
  }
  if (input.expectedRevision !== undefined && turn.revision !== input.expectedRevision) {
    return {
      finalized: false,
      changed: false,
      reason: 'revision_mismatch',
      turn: cloneTurn(turn),
    };
  }
  if (turn.status === 'leased' && !input.force) {
    const leaseOwnerId = optional(input.leaseOwnerId);
    const processEpoch = optional(input.processEpoch) || PROCESS_EPOCH;
    if (!leaseOwnerId || turn.leaseOwnerId !== leaseOwnerId || turn.leaseEpoch !== processEpoch) {
      return {
        finalized: false,
        changed: false,
        reason: 'lease_mismatch',
        turn: cloneTurn(turn),
      };
    }
  }

  applyTerminalState(turn, input, now.iso);
  writeDB(db);
  return { finalized: true, changed: true, turn: cloneTurn(turn) };
}

/**
 * Exceptional durability transition used only after a strict terminal fence
 * fails. Unlike normal finalization, this must supersede an in-memory terminal
 * projection that may have been staged after an earlier successful fence but
 * before its terminal receipt failed.
 *
 * The caller supplies the shared database object so the transcript, task and
 * action-turn quarantine can be rewritten synchronously as one memory state
 * before any delayed snapshot observes it.
 */
export function quarantineConversationActionTurnPersistenceInDb(
  db: any,
  input: QuarantineConversationActionTurnPersistenceInput,
): FinalizeConversationActionTurnResult {
  const identity = identityFrom(input);
  const { iso } = resolveNow(input.now);
  const rows = turnRows(db);
  const index = findTurnIndex(rows, identity);
  if (index < 0) return { finalized: false, changed: false, reason: 'not_found', turn: null };
  const turn = rows[index];
  const reason = required(input.reason, 'reason');
  if (
    turn.status === 'persistence_unknown'
    && turn.terminalReason === reason
    && !turn.terminalMessageId
  ) {
    return { finalized: true, changed: false, turn: cloneTurn(turn) };
  }

  turn.status = 'persistence_unknown';
  turn.terminalMessageId = '';
  turn.terminalReason = reason;
  turn.terminalAt = iso;
  turn.recoveryReason = reason;
  turn.recoveredAt = iso;
  turn.updatedAt = iso;
  turn.revision += 1;
  clearLease(turn);
  return { finalized: true, changed: true, turn: cloneTurn(turn) };
}

export function reconcileConversationActionTurnLease(
  input: ReconcileConversationActionTurnLeaseInput,
): ReconcileConversationActionTurnLeaseResult {
  const identity = identityFrom(input);
  const processEpoch = optional(input.processEpoch) || PROCESS_EPOCH;
  const now = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const index = findTurnIndex(rows, identity);
  if (index < 0) {
    return { reconciled: false, action: 'none', reason: 'not_found', turn: null };
  }
  const turn = rows[index];

  let observedStatus = input.observedStatus;
  let reason = optional(input.reason);
  if (!observedStatus && input.transcriptPresent === false && !isTerminalStatus(turn.status)) {
    observedStatus = turn.status === 'leased' ? 'persistence_unknown' : 'cancelled';
    reason = reason || (turn.status === 'leased'
      ? 'accepted transcript missing after execution lease was acquired'
      : 'accepted transcript missing before execution lease was acquired');
  }
  if (observedStatus) {
    const result = finalizeConversationActionTurn({
      ...identity,
      status: observedStatus,
      terminalMessageId: input.terminalMessageId,
      reason,
      force: true,
      now: now.iso,
    });
    if (result.finalized === false) {
      return {
        reconciled: false,
        action: 'none',
        reason: result.reason,
        turn: result.turn,
      };
    }
    return {
      reconciled: result.changed,
      action: observedStatus,
      reason: reason || (result.changed ? 'durable_terminal_evidence' : 'already_reconciled'),
      turn: result.turn,
    };
  }

  const recoveryReason = releaseStaleLease(turn, processEpoch, now.ms, now.iso);
  if (!recoveryReason) {
    return { reconciled: false, action: 'none', reason: 'lease_current', turn: cloneTurn(turn) };
  }
  writeDB(db);
  return {
    reconciled: true,
    action: 'released',
    reason: recoveryReason,
    turn: cloneTurn(turn),
  };
}

export function reconcileConversationActionTurnLeases(
  input: ReconcileConversationActionTurnLeasesInput = {},
): ReconcileConversationActionTurnLeasesResult {
  const processEpoch = optional(input.processEpoch) || PROCESS_EPOCH;
  const now = resolveNow(input.now);
  const db = readDB();
  const rows = turnRows(db);
  const released: ConversationActionTurn[] = [];
  for (const turn of rows) {
    if (releaseStaleLease(turn, processEpoch, now.ms, now.iso)) released.push(cloneTurn(turn));
  }
  if (released.length > 0) writeDB(db);
  return { inspected: rows.length, released: released.length, turns: released };
}
