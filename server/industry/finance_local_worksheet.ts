import { createHash } from 'node:crypto';
import { readSetting, writeSettingDurably } from '../persistence/settings_repository';
import { listIndustryWorkspaceContexts, type IndustryWorkspaceScope } from './workspace_context';
import { isFinanceWorksheetEntry, isFinanceWorksheetRows, type FinanceWorksheetEntry, type FinanceWorksheetRecord } from '../../shared/finance_local_worksheet';

export class FinanceWorksheetError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const writing = new Set<string>();
function worksheetKey(scope: IndustryWorkspaceScope, entryId: unknown, workspaceId: string) {
  if (!isFinanceWorksheetEntry(entryId)) throw new FinanceWorksheetError('Unsupported local worksheet.', 400);
  if (!scope.userId || scope.userId === 'anonymous' || !['personal','work'].includes(scope.domain) || (scope.domain === 'work' && !scope.orgId)) {
    throw new FinanceWorksheetError('Authenticated worksheet scope required.', 403);
  }
  if (!workspaceId || workspaceId.length > 200 || (workspaceId !== '_unbound'
    && !listIndustryWorkspaceContexts({ ...scope, productLine: 'finance' }).some(item => item.id === workspaceId))) {
    throw new FinanceWorksheetError('Finance workspace not found in this scope.', 404);
  }
  return 'finance_local_worksheet:' + createHash('sha256').update(JSON.stringify([scope.userId, scope.domain, scope.domain === 'work' ? scope.orgId : '', entryId, workspaceId])).digest('hex');
}
function readRecord(key: string, entryId: FinanceWorksheetEntry, workspaceId: string): FinanceWorksheetRecord | null {
  const raw = readSetting(key);
  if (raw === undefined) return null;
  try {
    const record = JSON.parse(raw);
    if (record?.entryId !== entryId || record.workspaceId !== workspaceId || !Number.isSafeInteger(record.version) || record.version < 1
      || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || !isFinanceWorksheetRows(entryId, record.rows)) throw new Error();
    return record;
  } catch { throw new FinanceWorksheetError('Stored worksheet is invalid. It was not replaced.', 503); }
}
export function readFinanceWorksheet(scope: IndustryWorkspaceScope, entryId: string, workspaceId: string) {
  const key = worksheetKey(scope, entryId, workspaceId);
  if (writing.has(key)) throw new FinanceWorksheetError('Worksheet save is still being confirmed. Retry reading shortly.', 409);
  return readRecord(key, entryId as FinanceWorksheetEntry, workspaceId);
}
export async function saveFinanceWorksheet(scope: IndustryWorkspaceScope, entryId: string, workspaceId: string, rows: unknown, expectedVersion: unknown) {
  const key = worksheetKey(scope, entryId, workspaceId);
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0 || Number(expectedVersion) >= Number.MAX_SAFE_INTEGER
    || !isFinanceWorksheetRows(entryId as FinanceWorksheetEntry, rows) || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 1_500_000) {
    throw new FinanceWorksheetError('Invalid or oversized worksheet.', 400);
  }
  if (writing.has(key)) throw new FinanceWorksheetError('Another worksheet save is in progress. Reload before saving.', 409);
  const previous = readRecord(key, entryId as FinanceWorksheetEntry, workspaceId);
  if ((previous?.version || 0) !== expectedVersion) throw new FinanceWorksheetError('Worksheet changed in another session. Reload before saving.', 409);
  const record: FinanceWorksheetRecord = { entryId: entryId as FinanceWorksheetEntry, workspaceId, rows, updatedAt: new Date().toISOString(), version: Number(expectedVersion) + 1 };
  writing.add(key);
  try {
    // The per-key lock spans the durability barrier; concurrent readers never receive an uncommitted revision.
    await writeSettingDurably(key, JSON.stringify(record));
    return record;
  } catch { throw new FinanceWorksheetError('Worksheet persistence failed. Reload the confirmed state before retrying.', 503); }
  finally { writing.delete(key); }
}
