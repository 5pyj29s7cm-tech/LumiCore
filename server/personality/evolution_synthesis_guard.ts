import { createHash } from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import type { Memory } from '../memory/types';

const SETTING_PREFIX = 'personality_evolution_synthesis_guard_v1_';
const ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const BASE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface EvolutionEvidenceCursor {
  fingerprint: string;
  memoryCount: number;
  latestEvidenceAt: string;
}

export interface EvolutionSynthesisGuardState {
  schemaVersion: 1;
  status: 'attempting' | 'backoff' | 'ready';
  consecutiveFailures: number;
  lastAttemptAt: string;
  retryAfter: string;
  attemptedEvidence: EvolutionEvidenceCursor;
  latestObservedEvidence: EvolutionEvidenceCursor;
  lastFailureCategory?: string;
  lastFailureMessage?: string;
}

export interface EvolutionScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

export interface EvolutionSynthesisAdmission {
  allowed: boolean;
  reason: 'ready' | 'backoff' | 'attempt_in_progress';
  retryAfter?: string;
}

function scopeIdentity(scope: EvolutionScope): string {
  return JSON.stringify([scope.userId || 'anonymous', scope.domain, scope.orgId || '']);
}

export function evolutionScopeKey(scope: EvolutionScope): string {
  return createHash('sha256').update(scopeIdentity(scope)).digest('hex').slice(0, 32);
}

function settingKey(scope: EvolutionScope): string {
  return `${SETTING_PREFIX}${evolutionScopeKey(scope)}`;
}

function parseCursor(value: unknown): EvolutionEvidenceCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fingerprint = String(raw.fingerprint || '').trim();
  const memoryCount = Number(raw.memoryCount);
  const latestEvidenceAt = String(raw.latestEvidenceAt || '').trim();
  if (!fingerprint || !Number.isFinite(memoryCount) || memoryCount < 0) return null;
  return { fingerprint, memoryCount, latestEvidenceAt };
}

function parseState(value: unknown): EvolutionSynthesisGuardState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const attemptedEvidence = parseCursor(raw.attemptedEvidence);
  const latestObservedEvidence = parseCursor(raw.latestObservedEvidence);
  const status = raw.status;
  if (
    raw.schemaVersion !== 1
    || (status !== 'attempting' && status !== 'backoff' && status !== 'ready')
    || !attemptedEvidence
    || !latestObservedEvidence
  ) return null;
  return {
    schemaVersion: 1,
    status,
    consecutiveFailures: Math.max(0, Math.floor(Number(raw.consecutiveFailures) || 0)),
    lastAttemptAt: String(raw.lastAttemptAt || ''),
    retryAfter: String(raw.retryAfter || ''),
    attemptedEvidence,
    latestObservedEvidence,
    ...(raw.lastFailureCategory ? { lastFailureCategory: String(raw.lastFailureCategory) } : {}),
    ...(raw.lastFailureMessage ? { lastFailureMessage: String(raw.lastFailureMessage) } : {}),
  };
}

export function getEvolutionSynthesisGuardState(scope: EvolutionScope): EvolutionSynthesisGuardState | null {
  try {
    const row = (readDB().settings || []).find((item: any) => item?.key === settingKey(scope));
    return row?.value ? parseState(JSON.parse(row.value)) : null;
  } catch {
    return null;
  }
}

function persistState(scope: EvolutionScope, state: EvolutionSynthesisGuardState | null): void {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  const key = settingKey(scope);
  const index = db.settings.findIndex((item: any) => item?.key === key);
  if (!state) {
    if (index >= 0) {
      db.settings.splice(index, 1);
      writeDB(db);
    }
    return;
  }
  const row = { key, value: JSON.stringify(state) };
  if (index >= 0) db.settings[index] = row;
  else db.settings.push(row);
  writeDB(db);
}

function normalizedEvidenceTime(memory: Pick<Memory, 'createdAt' | 'updatedAt'>): string {
  return String(memory.updatedAt || memory.createdAt || '');
}

/**
 * A content-addressed cursor prevents rank/count caps from hiding newly added
 * or corrected evidence. No owner text is duplicated into the guard record.
 */
export function buildEvolutionEvidenceCursor(
  memories: Array<Pick<Memory, 'id' | 'content' | 'confidence' | 'createdAt' | 'updatedAt'>>,
): EvolutionEvidenceCursor {
  const ordered = [...memories].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const hash = createHash('sha256');
  let latestEvidenceAt = '';
  for (const memory of ordered) {
    const evidenceAt = normalizedEvidenceTime(memory);
    if (evidenceAt > latestEvidenceAt) latestEvidenceAt = evidenceAt;
    hash.update(JSON.stringify([
      memory.id,
      evidenceAt,
      Number(memory.confidence).toFixed(4),
      memory.content,
    ]));
    hash.update('\n');
  }
  return {
    fingerprint: hash.digest('hex'),
    memoryCount: ordered.length,
    latestEvidenceAt,
  };
}

/** Record evidence seen by a follower while another synthesis is running. */
export function observeEvolutionEvidence(scope: EvolutionScope, evidence: EvolutionEvidenceCursor): void {
  const state = getEvolutionSynthesisGuardState(scope);
  if (!state || state.latestObservedEvidence.fingerprint === evidence.fingerprint) return;
  persistState(scope, { ...state, latestObservedEvidence: evidence });
}

/**
 * Atomically claims a durable attempt lease, or rejects background retries
 * while an earlier attempt/backoff window is live. A manual request may bypass
 * backoff, but never an active single-flight in the current process.
 */
export function beginEvolutionSynthesis(
  scope: EvolutionScope,
  evidence: EvolutionEvidenceCursor,
  options: { force?: boolean; now?: number } = {},
): EvolutionSynthesisAdmission {
  const now = options.now ?? Date.now();
  const state = getEvolutionSynthesisGuardState(scope);
  const retryAt = state?.retryAfter ? new Date(state.retryAfter).getTime() : 0;
  if (state && !options.force && Number.isFinite(retryAt) && retryAt > now) {
    if (state.latestObservedEvidence.fingerprint !== evidence.fingerprint) {
      persistState(scope, { ...state, latestObservedEvidence: evidence });
    }
    return {
      allowed: false,
      reason: state.status === 'attempting' ? 'attempt_in_progress' : 'backoff',
      retryAfter: state.retryAfter,
    };
  }

  const attemptedAt = new Date(now).toISOString();
  persistState(scope, {
    schemaVersion: 1,
    status: 'attempting',
    consecutiveFailures: state?.consecutiveFailures || 0,
    lastAttemptAt: attemptedAt,
    retryAfter: new Date(now + ATTEMPT_LEASE_MS).toISOString(),
    attemptedEvidence: evidence,
    latestObservedEvidence: evidence,
  });
  return { allowed: true, reason: 'ready' };
}

export function recordEvolutionSynthesisFailure(
  scope: EvolutionScope,
  evidence: EvolutionEvidenceCursor,
  failure: { category: string; message: string },
  now = Date.now(),
): EvolutionSynthesisGuardState {
  const previous = getEvolutionSynthesisGuardState(scope);
  const consecutiveFailures = Math.max(1, (previous?.consecutiveFailures || 0) + 1);
  const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.min(5, consecutiveFailures - 1)));
  const state: EvolutionSynthesisGuardState = {
    schemaVersion: 1,
    status: 'backoff',
    consecutiveFailures,
    lastAttemptAt: previous?.lastAttemptAt || new Date(now).toISOString(),
    retryAfter: new Date(now + backoffMs).toISOString(),
    attemptedEvidence: evidence,
    latestObservedEvidence: previous?.latestObservedEvidence || evidence,
    lastFailureCategory: failure.category.slice(0, 80),
    lastFailureMessage: failure.message.slice(0, 240),
  };
  persistState(scope, state);
  return state;
}

/**
 * Clear a successful attempt only when no newer evidence was observed while it
 * ran. Otherwise retain a ready marker so the next trigger sees the pending
 * cursor immediately instead of treating it as processed.
 */
export function recordEvolutionSynthesisSuccess(
  scope: EvolutionScope,
  evidence: EvolutionEvidenceCursor,
  now = Date.now(),
): void {
  const previous = getEvolutionSynthesisGuardState(scope);
  if (previous && previous.latestObservedEvidence.fingerprint !== evidence.fingerprint) {
    persistState(scope, {
      schemaVersion: 1,
      status: 'ready',
      consecutiveFailures: 0,
      lastAttemptAt: new Date(now).toISOString(),
      retryAfter: new Date(now).toISOString(),
      attemptedEvidence: evidence,
      latestObservedEvidence: previous.latestObservedEvidence,
    });
    return;
  }
  persistState(scope, null);
}
