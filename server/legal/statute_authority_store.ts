import { readSettingRecord, writeSetting } from "../persistence/settings_repository";


export const STATUTE_AUTHORITY_REFRESH_SETTING_KEY = 'legal_statute_authority_refresh_v1';

export type StatuteAuthorityCheckStatus = 'verified' | 'changed' | 'invalid' | 'unavailable';

export interface StatuteAuthorityObservedVersion {
  recordId: string;
  title: string;
  versionDate: string;
  effectiveDate: string;
  effectivenessCode: number | null;
  category: string;
  issuingAuthority: string;
  articleMax: number | null;
  sourceUrl: string;
  wordPath?: string;
  pdfPath?: string;
}

export interface StatuteAuthorityCheck {
  title: string;
  status: StatuteAuthorityCheckStatus;
  checkedAt: string;
  expectedVersionDate: string;
  expectedEffectiveDate: string;
  expectedArticleMax: number | null;
  expectedRecordId?: string;
  observed?: StatuteAuthorityObservedVersion;
  fingerprint?: string;
  lastVerifiedAt?: string;
  reviewAfter?: string;
  previousFingerprint?: string;
  reasons: string[];
  consecutiveFailures: number;
}

export interface StatuteAuthorityRefreshRun {
  runAt: string;
  completedAt: string;
  checked: number;
  verified: number;
  changed: number;
  invalid: number;
  unavailable: number;
  newPendingReview: number;
}

export interface StatuteAuthorityRefreshState {
  version: 1;
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  checks: Record<string, StatuteAuthorityCheck>;
  runs: StatuteAuthorityRefreshRun[];
}

function emptyState(): StatuteAuthorityRefreshState {
  return {
    version: 1,
    lastRunAt: null,
    lastSuccessfulRunAt: null,
    checks: {},
    runs: [],
  };
}

function normalizeState(raw: unknown): StatuteAuthorityRefreshState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const source = raw as Partial<StatuteAuthorityRefreshState>;
  return {
    version: 1,
    lastRunAt: typeof source.lastRunAt === 'string' ? source.lastRunAt : null,
    lastSuccessfulRunAt: typeof source.lastSuccessfulRunAt === 'string' ? source.lastSuccessfulRunAt : null,
    checks: source.checks && typeof source.checks === 'object' ? source.checks : {},
    runs: Array.isArray(source.runs) ? source.runs.slice(-30) : [],
  };
}

export function loadStatuteAuthorityRefreshState(): StatuteAuthorityRefreshState {
  try {
    const row = readSettingRecord(STATUTE_AUTHORITY_REFRESH_SETTING_KEY);
    if (!row?.value) return emptyState();
    return normalizeState(JSON.parse(row.value));
  } catch {
    return emptyState();
  }
}

export function saveStatuteAuthorityRefreshState(state: StatuteAuthorityRefreshState): void {
  writeSetting(STATUTE_AUTHORITY_REFRESH_SETTING_KEY, JSON.stringify(normalizeState(state)));
}

export function getStatuteAuthorityCheck(title: string): StatuteAuthorityCheck | null {
  const normalized = String(title || '').replace(/\s+/g, '').trim();
  if (!normalized) return null;
  const state = loadStatuteAuthorityRefreshState();
  return Object.values(state.checks).find(check => check.title.replace(/\s+/g, '') === normalized) || null;
}

export function resetStatuteAuthorityRefreshStateForTest(): void {
  writeSetting(STATUTE_AUTHORITY_REFRESH_SETTING_KEY, undefined);
}
