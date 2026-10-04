import crypto from 'node:crypto';
import { readSetting, updateSettings } from '../persistence/settings_repository';
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
function readObject(value: string | undefined): any {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
function records(value = readSetting(RECORDS_KEY)): IndustryWorkspaceContext[] {
  const parsed = readObject(value); return Array.isArray(parsed.items) ? parsed.items : [];
}
function selectionKey(scope: IndustryWorkspaceScope, line: string) { return `${line}:${scopeId(scope)}:${scope.userId}`; }
function clone(record: IndustryWorkspaceContext) { return { ...record, attributes: { ...record.attributes } }; }
export function listIndustryWorkspaceContexts(scope: IndustryWorkspaceScope): IndustryWorkspaceContext[] {
  const id = scopeId(scope);
  return records().filter(row => row.scopeId === id && BUSINESS_LINES.includes(row.productLine) && (!scope.productLine || row.productLine === scope.productLine)).map(clone);
}
export function getActiveIndustryWorkspaceContext(scope: IndustryWorkspaceScope): IndustryWorkspaceContext | null {
  const available = listIndustryWorkspaceContexts(scope);
  const selections = readObject(readSetting(ACTIVE_KEY));
  const active = available.filter(row => selections[selectionKey(scope, row.productLine)] === row.id);
  return active.length === 1 ? active[0] : null;
}
export function bindIndustryWorkspaceContext(scope: IndustryWorkspaceScope, input: { id?: unknown; productLine?: unknown; name?: unknown; attributes?: Record<string, unknown> }): IndustryWorkspaceContext {
  let updated!: IndustryWorkspaceContext;
  updateSettings([RECORDS_KEY, ACTIVE_KEY], previous => {
    const all = records(previous[RECORDS_KEY]); const id = scopeId(scope);
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
    const active = readObject(previous[ACTIVE_KEY]); active[selectionKey(scope, line)] = record.id;
    updated = clone(record);
    return { [RECORDS_KEY]: JSON.stringify({ schemaVersion: 1, items: all }), [ACTIVE_KEY]: JSON.stringify(active) };
  });
  return updated;
}
export function selectIndustryWorkspaceContext(scope: IndustryWorkspaceScope, id: unknown) { return bindIndustryWorkspaceContext(scope, { id }); }
export function workflowWorkspaceContext(scope: IndustryWorkspaceScope): Record<string, unknown> | null {
  const active = getActiveIndustryWorkspaceContext(scope);
  return active ? { id: active.id, productLine: active.productLine, kind: active.kind, name: active.name, attributes: active.attributes, updatedAt: active.updatedAt } : null;
}
