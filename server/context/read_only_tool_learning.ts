import crypto from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import { toolRecordSucceeded } from '../cognition/task_execution_ledger';
import { toolRegistry } from '../tools/registry';
import type { ToolExecutionRecord } from '../tools/types';

export interface ReadOnlyToolPatternRow {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  featureHashes: string[];
  toolSequence: Array<{ name: string; argumentKeys: string[] }>;
  successCount: number;
  confidence: number;
  observationRefs: string[];
  createdAt: string;
  updatedAt: string;
  lastMatchedAt: string;
}

export interface RankedReadOnlyToolPattern {
  patternId: string;
  toolNames: string[];
  confidence: number;
  similarity: number;
  score: number;
  action: 'direct_prefetch' | 'hint' | 'discard';
}

const SAFE_SIDE_EFFECTS = new Set(['none', 'local_read', 'network_read']);
const MAX_PATTERNS_PER_SCOPE = 200;

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeScope(domain?: string, orgId?: string): { domain: 'personal' | 'work'; orgId: string } {
  return domain === 'work' && orgId
    ? { domain: 'work', orgId: String(orgId) }
    : { domain: 'personal', orgId: '' };
}

function featureHashes(text: string): string[] {
  const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const wordFeatures = normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{1,4}/gu) || [];
  const han = Array.from(normalized.replace(/[^\u3400-\u9fff]/gu, ''));
  const hanBigrams = han.slice(0, -1).map((char, index) => `${char}${han[index + 1]}`);
  return Array.from(new Set([...wordFeatures, ...hanBigrams].slice(0, 80).map(feature => digest(feature).slice(0, 16))));
}

function scopeMatches(row: ReadOnlyToolPatternRow, userId: string, domain: 'personal' | 'work', orgId: string): boolean {
  return row.userId === userId && row.domain === domain && row.orgId === orgId;
}

function recordIsStrictReadOnly(record: ToolExecutionRecord): boolean {
  if (!toolRecordSucceeded(record)) return false;
  const manifest = toolRegistry.getCapabilityManifestEntry(record.name);
  const operation = record.capability?.operation || manifest?.operation || record.evidence?.operation || 'unknown';
  if (operation !== 'observe' && operation !== 'test') return false;
  const sideEffects = record.capability?.sideEffects || manifest?.sideEffects || [];
  if (sideEffects.length === 0) return false;
  if (sideEffects.some(effect => !SAFE_SIDE_EFFECTS.has(effect.type) || effect.reversible !== true)) return false;
  if (record.terminalVerification?.status === 'failed' || record.terminalVerification?.status === 'unverified') return false;
  if (record.capability?.verification.required && record.terminalVerification?.status !== 'verified') return false;
  if (record.envelope && record.envelope.status !== 'verified_success') return false;
  return true;
}

function confidenceFor(successCount: number): number {
  return Number(Math.min(0.96, 0.45 + Math.max(0, successCount) * 0.12).toFixed(4));
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function recordReadOnlyToolPattern(input: {
  userId: string;
  userText: string;
  toolRecords: ToolExecutionRecord[];
  domain?: string;
  orgId?: string;
  observationRef?: string;
  now?: string;
}): { recorded: boolean; reason: string; pattern?: ReadOnlyToolPatternRow } {
  const records = input.toolRecords || [];
  if (records.length === 0) return { recorded: false, reason: 'no_tool_records' };
  // Reject mixed chains wholesale: a learned read-only sequence may never hide
  // a write, desktop-control, process or external-commit step between reads.
  if (!records.every(recordIsStrictReadOnly)) return { recorded: false, reason: 'chain_not_strict_read_only' };
  const features = featureHashes(input.userText);
  if (features.length === 0) return { recorded: false, reason: 'no_intent_features' };
  const scope = normalizeScope(input.domain, input.orgId);
  const toolSequence = records.map(record => ({
    name: record.name,
    argumentKeys: Object.keys(record.arguments || {}).sort().slice(0, 30),
  }));
  const signature = digest({ features: [...features].sort(), toolSequence });
  const observationRef = digest(input.observationRef || `${signature}:${records.map(record => record.requestId || record.id || '').join(':')}`).slice(0, 32);
  const db = readDB();
  if (!Array.isArray(db.readOnlyToolPatterns)) db.readOnlyToolPatterns = [];
  const rows = db.readOnlyToolPatterns as ReadOnlyToolPatternRow[];
  let row = rows.find(candidate => candidate.id === `readonly_${signature.slice(0, 32)}` && scopeMatches(candidate, input.userId, scope.domain, scope.orgId));
  const now = input.now || new Date().toISOString();
  if (!row) {
    row = {
      id: `readonly_${signature.slice(0, 32)}`,
      userId: input.userId,
      domain: scope.domain,
      orgId: scope.orgId,
      featureHashes: features,
      toolSequence,
      successCount: 0,
      confidence: 0,
      observationRefs: [],
      createdAt: now,
      updatedAt: now,
      lastMatchedAt: '',
    };
    rows.push(row);
  }
  if (row.observationRefs.includes(observationRef)) return { recorded: false, reason: 'duplicate_observation', pattern: row };
  row.observationRefs = [...row.observationRefs, observationRef].slice(-100);
  row.successCount += 1;
  row.confidence = confidenceFor(row.successCount);
  row.updatedAt = now;

  const scopedRows = rows
    .filter(candidate => scopeMatches(candidate, input.userId, scope.domain, scope.orgId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const evicted = new Set(scopedRows.slice(MAX_PATTERNS_PER_SCOPE).map(candidate => candidate.id));
  if (evicted.size > 0) db.readOnlyToolPatterns = rows.filter(candidate => !evicted.has(candidate.id));
  writeDB(db);
  return { recorded: true, reason: 'verified_read_only_pattern', pattern: { ...row, toolSequence: row.toolSequence.map(step => ({ ...step, argumentKeys: [...step.argumentKeys] })) } };
}

export function rankReadOnlyToolPatterns(input: {
  userId: string;
  userText: string;
  domain?: string;
  orgId?: string;
  availableTools?: string[];
  now?: string;
}): RankedReadOnlyToolPattern[] {
  const scope = normalizeScope(input.domain, input.orgId);
  const features = featureHashes(input.userText);
  if (features.length === 0) return [];
  const available = input.availableTools ? new Set(input.availableTools) : null;
  const db = readDB();
  const rows = (Array.isArray(db.readOnlyToolPatterns) ? db.readOnlyToolPatterns : []) as ReadOnlyToolPatternRow[];
  const ranked = rows
    .filter(row => scopeMatches(row, input.userId, scope.domain, scope.orgId))
    .map(row => {
      const similarity = jaccard(features, row.featureHashes || []);
      const score = Number((row.confidence * (0.6 + similarity * 0.4)).toFixed(4));
      const fullToolNames = row.toolSequence.map(step => step.name);
      // A learned chain is atomic. Returning a partial chain after policy or
      // registry filtering could change its meaning and bypass a missing step.
      const toolNames = available && fullToolNames.some(name => !available.has(name))
        ? []
        : fullToolNames;
      const action: RankedReadOnlyToolPattern['action'] = score > 0.85
        ? 'direct_prefetch'
        : score >= 0.5
          ? 'hint'
          : 'discard';
      return { patternId: row.id, toolNames, confidence: row.confidence, similarity, score, action };
    })
    .filter(candidate => candidate.toolNames.length > 0 && candidate.action !== 'discard')
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return ranked;
}
