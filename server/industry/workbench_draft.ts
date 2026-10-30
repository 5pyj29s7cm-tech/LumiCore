import crypto from 'node:crypto';
import { readSettingJson, writeSettingDurably } from '../persistence/settings_repository';
import { listIndustryWorkspaceContexts, type IndustryWorkspaceScope } from './workspace_context';

function key(scope: IndustryWorkspaceScope, workspaceId: string) {
  if (workspaceId !== '_unbound' && !listIndustryWorkspaceContexts({ ...scope, productLine: 'ecommerce' }).some(item => item.id === workspaceId)) throw new Error('Workspace not found in this scope');
  return 'industry_ecommerce_draft:' + crypto.createHash('sha256').update(JSON.stringify([scope.userId, scope.domain, scope.orgId, workspaceId])).digest('hex');
}
export function validWorkbenchDraft(value: any): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.sources && typeof value.sources === 'object' && !Array.isArray(value.sources)
    && Object.entries(value.sources).every(([kind, source]: [string, any]) => ['orders','inventory','campaigns','reviews','afterSales'].includes(kind)
      && source && typeof source.name === 'string' && source.table && Array.isArray(source.table.headers) && source.table.headers.every((item: unknown) => typeof item === 'string')
      && Array.isArray(source.table.rows) && source.table.rows.length <= 50000 && source.table.rows.every((row: any) => row && typeof row === 'object' && !Array.isArray(row) && Object.values(row).every((cell: any) => typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell))))
      && source.mapping && typeof source.mapping === 'object' && !Array.isArray(source.mapping) && Object.values(source.mapping).every(item => typeof item === 'string'))
    && typeof value.selectedPlatform === 'string' && Number.isFinite(value.grossMarginPercent) && Number.isFinite(value.targetStockDays)
    && typeof value.pasteValue === 'string' && typeof value.archiveTaskId === 'string' && JSON.stringify(value).length <= 1_500_000);
}
export function readWorkbenchDraft(scope: IndustryWorkspaceScope, workspaceId: string) {
  const record = readSettingJson<any>(key(scope, workspaceId));
  if (record && !validWorkbenchDraft(record.draft)) throw new Error('Stored draft is invalid');
  return record;
}
export async function saveWorkbenchDraft(scope: IndustryWorkspaceScope, workspaceId: string, draft: unknown) {
  if (!validWorkbenchDraft(draft)) throw new Error('Invalid or oversized workbench draft');
  const record = { draft, savedAt: new Date().toISOString() };
  await writeSettingDurably(key(scope, workspaceId), JSON.stringify(record)); return record;
}
