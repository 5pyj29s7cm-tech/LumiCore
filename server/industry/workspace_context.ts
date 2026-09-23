import crypto from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import { BUSINESS_LINES, type BusinessLine } from './business_catalog';

export interface IndustryWorkspaceScope { userId: string; domain: 'personal' | 'work'; orgId: string; productLine?: string }
export interface IndustryWorkspaceContext {
  id: string; productLine: BusinessLine; scopeId: string; ownerUserId: string;
  kind: 'store' | 'entity'; name: string; attributes: Record<string, string>; createdAt: string; updatedAt: string;
}
const RECORDS_KEY = 'industry_workspace_contexts_v1';
const ACTIVE_KEY = 'industry_workspace_active_v1';
const FIELD_ALLOWLIST = {
  ecommerce: ['platform', 'storeId', 'accountLabel', 'reportingPeriod', 'currency', 'timezone', 'entityId'],
  finance: ['entityName', 'taxpayerId', 'jurisdiction', 'taxpayerType', 'accountingPeriod', 'currency', 'accountingBasis'],
};
function clean(value: unknown, limit = 300) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function scopeId(scope: IndustryWorkspaceScope) {
  if (!clean(scope.userId) || scope.userId === 'anonymous') throw new Error('Authenticated workspace owner required');
  if (scope.domain === 'work' && !clean(scope.orgId)) throw new Error('Organization identity required');
  return scope.domain === 'work' ? `work:${scope.orgId}` : `personal:${scope.userId}`;
}
function readObject(db: any, key: string): any {
  try { return JSON.parse(db.settings?.find((row: any) => row.key === key)?.value || '{}'); } catch { return {}; }
}
function saveObject(db: any, key: string, value: unknown) {
  db.settings ||= [];
  const row = db.settings.find((item: any) => item.key === key);
  if (row) row.value = JSON.stringify(value); else db.settings.push({ key, value: JSON.stringify(value) });
}
function records(db: any): IndustryWorkspaceContext[] { const value = readObject(db, RECORDS_KEY); return Array.isArray(value.items) ? value.items : []; }
function selectionKey(scope: IndustryWorkspaceScope, line: string) { return `${line}:${scopeId(scope)}:${scope.userId}`; }
function clone(record: IndustryWorkspaceContext) { return { ...record, attributes: { ...record.attributes } }; }
export function listIndustryWorkspaceContexts(scope: IndustryWorkspaceScope): IndustryWorkspaceContext[] {
  const id = scopeId(scope);
  return records(readDB()).filter(row => row.scopeId === id && BUSINESS_LINES.includes(row.productLine) && (!scope.productLine || row.productLine === scope.productLine)).map(clone);
}
export function getActiveIndustryWorkspaceContext(scope: IndustryWorkspaceScope): IndustryWorkspaceContext | null {
  const available = listIndustryWorkspaceContexts(scope);
  const selections = readObject(readDB(), ACTIVE_KEY);
  const active = available.filter(row => selections[selectionKey(scope, row.productLine)] === row.id);
  return active.length === 1 ? active[0] : null;
}
export function bindIndustryWorkspaceContext(scope: IndustryWorkspaceScope, input: { id?: unknown; productLine?: unknown; name?: unknown; attributes?: Record<string, unknown> }): IndustryWorkspaceContext {
  const db = readDB(); const all = records(db); const id = scopeId(scope);
  const requested = clean(input.id, 200);
  let record = requested ? all.find(row => row.id === requested && row.scopeId === id && (!scope.productLine || row.productLine === scope.productLine)) : undefined;
  if (requested && !record) throw new Error('Workspace not found in this scope');
  const line = record?.productLine || input.productLine || scope.productLine;
  if (line !== 'ecommerce' && line !== 'finance') throw new Error('Select ecommerce or finance explicitly');
  const attributes = Object.fromEntries(FIELD_ALLOWLIST[line].map(field => [field, clean(input.attributes?.[field], 500)]).filter(([, value]) => value));
  if (attributes.entityId && !all.some(row => row.id === attributes.entityId && row.scopeId === id && row.productLine === 'finance')) throw new Error('Linked company not found in this scope');
  const name = clean(input.name, 160) || attributes.accountLabel || attributes.storeId || attributes.entityName;
  if (!record && !name) throw new Error('A store or company name is required');
  const now = new Date().toISOString();
  if (record) { record.name = name || record.name; record.attributes = { ...record.attributes, ...attributes }; record.updatedAt = now; }
  else { record = { id: `industry_subject_${crypto.randomUUID()}`, productLine: line, scopeId: id, ownerUserId: scope.userId, kind: line === 'ecommerce' ? 'store' : 'entity', name, attributes, createdAt: now, updatedAt: now }; all.push(record); }
  saveObject(db, RECORDS_KEY, { schemaVersion: 1, items: all });
  const active = readObject(db, ACTIVE_KEY); active[selectionKey(scope, line)] = record.id;
  saveObject(db, ACTIVE_KEY, active); writeDB(db); return clone(record);
}
export function selectIndustryWorkspaceContext(scope: IndustryWorkspaceScope, id: unknown) { return bindIndustryWorkspaceContext(scope, { id }); }
export function workflowWorkspaceContext(scope: IndustryWorkspaceScope): Record<string, unknown> | null {
  const active = getActiveIndustryWorkspaceContext(scope);
  return active ? { id: active.id, productLine: active.productLine, kind: active.kind, name: active.name, attributes: active.attributes, updatedAt: active.updatedAt } : null;
}
