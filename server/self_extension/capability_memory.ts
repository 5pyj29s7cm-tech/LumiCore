import { readDB, writeDB } from '../../db_layer';

export type CapabilityLearningStatus =
  | 'learned'
  | 'experiment_prepared'
  | 'experiment_passed'
  | 'needs_confirmation'
  | 'needs_research'
  | 'needs_core_work'
  | 'blocked';

export interface CapabilityRoute {
  id: string;
  label: string;
  interfacePattern: 'native_api' | 'script_bridge' | 'mcp' | 'browser_dom' | 'windows_uia' | 'file_handoff' | 'skill' | 'core';
  preferredTools: string[];
  fallbackTools: string[];
  avoid: string[];
  reason: string;
  confirmationRequired: string[];
}

export interface CapabilityExperimentRecord {
  status: 'not_needed' | 'prepared' | 'passed' | 'needs_review' | 'blocked';
  summary: string;
  toolCalls: Array<{ name: string; args: Record<string, any>; status: string; result?: any; error?: string }>;
  artifacts: Array<{ label: string; path: string; exists: boolean }>;
  verification: Array<{ label: string; passed: boolean; detail: string }>;
}

export interface CapabilityLearningRecord {
  id: string;
  userId: string;
  scopeDomain: 'personal' | 'work';
  orgId: string;
  domain: string;
  goal: string;
  context?: string;
  observedFailure?: string;
  status: CapabilityLearningStatus;
  selectedRoute: CapabilityRoute;
  planReadiness: string;
  existingTools: string[];
  nextUse: {
    triggerHints: string[];
    preferredTools: string[];
    firstStep: string;
    reportRule: string;
  };
  experiment: CapabilityExperimentRecord;
  safety: string[];
  createdAt: string;
  updatedAt: string;
}

const SETTINGS_KEY = 'capability_learning_records_v1';
const MAX_RECORDS = 250;

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(compact).filter(Boolean)));
}

function readRecords(): CapabilityLearningRecord[] {
  const db = readDB();
  const row = (db.settings || []).find((item: any) => item.key === SETTINGS_KEY);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((record: any) => {
      const orgId = String(record?.orgId || '').trim();
      const scopeDomain = record?.scopeDomain === 'work' && orgId ? 'work' : 'personal';
      return {
        ...record,
        scopeDomain,
        orgId: scopeDomain === 'work' ? orgId : '',
      } as CapabilityLearningRecord;
    });
  } catch {
    return [];
  }
}

function writeRecords(records: CapabilityLearningRecord[]) {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  const value = JSON.stringify(records
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_RECORDS));
  const index = db.settings.findIndex((item: any) => item.key === SETTINGS_KEY);
  if (index >= 0) db.settings[index].value = value;
  else db.settings.push({ key: SETTINGS_KEY, value });
  writeDB(db);
}

function scoreRecord(record: CapabilityLearningRecord, goal: string, domain?: string): number {
  const terms = unique([
    domain,
    ...goal.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/i).filter(item => item.length >= 2),
  ]);
  const haystack = [
    record.domain,
    record.goal,
    record.context,
    record.observedFailure,
    record.selectedRoute.id,
    record.selectedRoute.label,
    record.selectedRoute.reason,
    record.selectedRoute.preferredTools.join(' '),
    record.nextUse.triggerHints.join(' '),
  ].join(' ').toLowerCase();
  let score = 0;
  if (domain && record.domain === domain) score += 40;
  if (record.status === 'experiment_passed' || record.status === 'learned') score += 20;
  if (record.status === 'experiment_prepared') score += 12;
  for (const term of terms) {
    if (term && haystack.includes(term.toLowerCase())) score += 3;
  }
  return score;
}

function mergeIndexFor(input: Omit<CapabilityLearningRecord, 'id' | 'createdAt' | 'updatedAt'>, records: CapabilityLearningRecord[]): number {
  const index = records
    .map((record, idx) => {
      if (record.userId !== input.userId) return { idx, score: -1 };
      if (record.scopeDomain !== input.scopeDomain || record.orgId !== input.orgId) return { idx, score: -1 };
      let score = 0;
      if (record.domain === input.domain) score += 30;
      if (record.selectedRoute.id === input.selectedRoute.id) score += 70;
      if (record.selectedRoute.interfacePattern === input.selectedRoute.interfacePattern) score += 15;
      const triggerOverlap = record.nextUse.triggerHints.filter(item => input.nextUse.triggerHints.includes(item)).length;
      score += triggerOverlap * 5;
      const textScore = scoreRecord(record, input.goal, input.domain);
      score += Math.min(textScore, 30);
      return { idx, score };
    })
    .filter(item => item.score >= 100)
    .sort((a, b) => b.score - a.score)[0]?.idx;
  return typeof index === 'number' ? index : -1;
}

function mergeRecord(previous: CapabilityLearningRecord | null, incoming: CapabilityLearningRecord): CapabilityLearningRecord {
  if (!previous) return incoming;
  return {
    ...incoming,
    id: previous.id,
    createdAt: previous.createdAt,
    existingTools: unique([...previous.existingTools, ...incoming.existingTools]),
    nextUse: {
      ...incoming.nextUse,
      triggerHints: unique([...previous.nextUse.triggerHints, ...incoming.nextUse.triggerHints]).slice(0, 16),
      preferredTools: unique([...incoming.nextUse.preferredTools, ...previous.nextUse.preferredTools]).slice(0, 16),
    },
    safety: unique([...previous.safety, ...incoming.safety]),
  };
}

export function listCapabilityLearningRecords(filter: {
  userId?: string;
  scopeDomain?: 'personal' | 'work';
  orgId?: string;
  domain?: string;
  goal?: string;
  status?: CapabilityLearningStatus;
  limit?: number;
} = {}): CapabilityLearningRecord[] {
  let records = readRecords();
  if (filter.userId) records = records.filter(record => record.userId === filter.userId);
  if (filter.scopeDomain) records = records.filter(record => record.scopeDomain === filter.scopeDomain);
  if (filter.scopeDomain === 'work' || filter.orgId) {
    records = records.filter(record => record.orgId === String(filter.orgId || '').trim());
  }
  if (filter.domain) records = records.filter(record => record.domain === filter.domain);
  if (filter.status) records = records.filter(record => record.status === filter.status);
  if (filter.goal) {
    records = records
      .map(record => ({ record, score: scoreRecord(record, filter.goal || '', filter.domain) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
      .map(item => item.record);
  } else {
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return records.slice(0, Math.max(1, Math.min(Number(filter.limit) || 20, 100)));
}

export function upsertCapabilityLearningRecord(input: Omit<CapabilityLearningRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): CapabilityLearningRecord {
  const records = readRecords();
  const timestamp = nowIso();
  const existingIndex = input.id ? records.findIndex(record => record.id === input.id) : mergeIndexFor(input, records);
  const previous = existingIndex >= 0 ? records[existingIndex] : null;
  const incoming: CapabilityLearningRecord = {
    ...input,
    scopeDomain: input.scopeDomain === 'work' && input.orgId ? 'work' : 'personal',
    orgId: input.scopeDomain === 'work' && input.orgId ? String(input.orgId) : '',
    id: previous?.id || input.id || id('cap_learn'),
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  const record = mergeRecord(previous, incoming);
  if (existingIndex >= 0) records[existingIndex] = record;
  else records.push(record);
  writeRecords(records);
  return record;
}

export function summarizeCapabilityRecord(record: CapabilityLearningRecord): string {
  return [
    `${record.selectedRoute.label}：${record.status}`,
    `触发：${record.nextUse.triggerHints.slice(0, 4).join('；')}`,
    `优先工具：${record.nextUse.preferredTools.slice(0, 6).join(', ')}`,
    `验证：${record.experiment.verification.filter(item => item.passed).length}/${record.experiment.verification.length}`,
  ].filter(Boolean).join('\n');
}
