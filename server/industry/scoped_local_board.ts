import { createHash } from 'node:crypto';
import { readSetting, writeSettingDurably } from '../persistence/settings_repository';
import { listIndustryWorkspaceContexts, type IndustryWorkspaceScope } from './workspace_context';
import { isLocalOperationsBoardId, isLocalOperationsBoardRows, type LocalOperationsBoardId, type LocalOperationsBoardRecord } from '../../shared/local_operations_board';

export class LocalBoardError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const writing = new Set<string>();
const MAX_BYTES = 1_500_000;
function keyFor(scope: IndustryWorkspaceScope, boardId: unknown, workspaceId: string) {
  if (!isLocalOperationsBoardId(boardId)) throw new LocalBoardError('Unsupported local board.', 400);
  if (!scope.userId || scope.userId === 'anonymous' || !['personal', 'work'].includes(scope.domain) || (scope.domain === 'work' && !scope.orgId)) {
    throw new LocalBoardError('Authenticated board scope required.', 403);
  }
  if (!workspaceId || workspaceId.length > 200 || (boardId === 'social-calendar' && workspaceId !== '_unbound')
    || (workspaceId !== '_unbound' && !listIndustryWorkspaceContexts({ ...scope, productLine: 'ecommerce' }).some(item => item.id === workspaceId))) {
    throw new LocalBoardError('Board workspace not found in this scope.', 404);
  }
  return 'scoped_local_board:' + createHash('sha256').update(JSON.stringify([scope.userId, scope.domain, scope.domain === 'work' ? scope.orgId : '', boardId, workspaceId])).digest('hex');
}
function readRecord(key: string, boardId: LocalOperationsBoardId, workspaceId: string): LocalOperationsBoardRecord | null {
  const raw = readSetting(key);
  if (raw === undefined) return null;
  try {
    const record = JSON.parse(raw);
    if (record?.boardId !== boardId || record.workspaceId !== workspaceId || !Number.isSafeInteger(record.version) || record.version < 1
      || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || !isLocalOperationsBoardRows(boardId, record.rows)
      || Buffer.byteLength(JSON.stringify(record.rows), 'utf8') > MAX_BYTES) throw new Error();
    return record;
  } catch { throw new LocalBoardError('Stored board is invalid. It was not replaced.', 503); }
}
export function readLocalOperationsBoard(scope: IndustryWorkspaceScope, boardId: string, workspaceId: string) {
  const key = keyFor(scope, boardId, workspaceId);
  if (writing.has(key)) throw new LocalBoardError('Board save is still being confirmed. Retry reading shortly.', 409);
  return readRecord(key, boardId as LocalOperationsBoardId, workspaceId);
}
export async function saveLocalOperationsBoard(scope: IndustryWorkspaceScope, boardId: string, workspaceId: string, rows: unknown, expectedVersion: unknown) {
  const key = keyFor(scope, boardId, workspaceId);
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0 || Number(expectedVersion) >= Number.MAX_SAFE_INTEGER
    || !isLocalOperationsBoardRows(boardId as LocalOperationsBoardId, rows) || Buffer.byteLength(JSON.stringify(rows), 'utf8') > MAX_BYTES) {
    throw new LocalBoardError('Invalid or oversized local board.', 400);
  }
  if (writing.has(key)) throw new LocalBoardError('Another save is in progress. Reload before saving.', 409);
  const previous = readRecord(key, boardId as LocalOperationsBoardId, workspaceId);
  if ((previous?.version || 0) !== expectedVersion) throw new LocalBoardError('Board changed in another session. Reload before saving.', 409);
  const record: LocalOperationsBoardRecord = { boardId: boardId as LocalOperationsBoardId, workspaceId, rows, version: Number(expectedVersion) + 1, updatedAt: new Date().toISOString() };
  writing.add(key);
  try {
    // Reuse the settings repository's durable transaction and rollback; do not expose its pending revision.
    await writeSettingDurably(key, JSON.stringify(record));
    return record;
  } catch { throw new LocalBoardError('Board persistence failed. Reload the confirmed state before retrying.', 503); }
  finally { writing.delete(key); }
}
