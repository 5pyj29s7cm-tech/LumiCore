/** User-entered planning/review records, not platform actions or measured analytics. */
export const LOCAL_OPERATIONS_BOARD_COLUMNS = {
  'social-calendar': ['date', 'channel', 'campaign', 'content', 'views', 'interactions', 'source', 'notes'],
  'trend-discovery': ['date', 'topic', 'metric', 'value', 'unit', 'source', 'notes'],
  'listing-automation': ['sku', 'platform', 'title', 'price', 'currency', 'source', 'notes'],
  'ai-customer-service': ['ticketId', 'channel', 'customer', 'question', 'response', 'source', 'notes'],
} as const;
export type LocalOperationsBoardId = keyof typeof LOCAL_OPERATIONS_BOARD_COLUMNS;
export type LocalOperationsBoardRow = { id: string; cells: Record<string, string>; reviewStatus: 'pending' | 'reviewed' };
export type LocalOperationsBoardRecord = { boardId: LocalOperationsBoardId; workspaceId: string; rows: LocalOperationsBoardRow[]; updatedAt: string; version: number };
export const MAX_LOCAL_OPERATIONS_BOARD_ROWS = 1000;
export function isLocalOperationsBoardId(value: unknown): value is LocalOperationsBoardId {
  return typeof value === 'string' && Object.hasOwn(LOCAL_OPERATIONS_BOARD_COLUMNS, value);
}
export function isLocalOperationsBoardRows(boardId: LocalOperationsBoardId, rows: unknown): rows is LocalOperationsBoardRow[] {
  if (!Array.isArray(rows) || rows.length > MAX_LOCAL_OPERATIONS_BOARD_ROWS) return false;
  const columns: readonly string[] = LOCAL_OPERATIONS_BOARD_COLUMNS[boardId], ids = new Set<string>();
  return rows.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'cells', 'reviewStatus'].includes(key))
      || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id)
      || !['pending', 'reviewed'].includes(row.reviewStatus) || !row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)
      || Object.keys(row.cells).length !== columns.length
      || !columns.every(key => Object.hasOwn(row.cells, key) && typeof row.cells[key] === 'string' && row.cells[key].length <= 2000)) return false;
    ids.add(row.id); return true;
  });
}
