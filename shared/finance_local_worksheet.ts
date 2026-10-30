/** User-maintained source records only. These fields do not define tax rules or post journal entries. */
export const FINANCE_WORKSHEET_COLUMNS = {
  'business-dashboard': ['period', 'metric', 'amount', 'currency', 'source', 'notes'],
  'invoice-tax': ['date', 'invoiceNumber', 'counterparty', 'netAmount', 'taxAmount', 'currency', 'source', 'notes'],
  accounting: ['date', 'reference', 'account', 'debit', 'credit', 'currency', 'source', 'notes'],
  'cash-risk': ['date', 'kind', 'amount', 'currency', 'scenario', 'source', 'notes'],
} as const;
export type FinanceWorksheetEntry = keyof typeof FINANCE_WORKSHEET_COLUMNS;
export type FinanceWorksheetRow = { id: string; cells: Record<string, string>; reviewStatus: 'pending' | 'reviewed' };
export type FinanceWorksheetRecord = {
  entryId: FinanceWorksheetEntry; workspaceId: string; rows: FinanceWorksheetRow[]; updatedAt: string; version: number;
};
export const MAX_FINANCE_WORKSHEET_ROWS = 1000;
export function isFinanceWorksheetEntry(value: unknown): value is FinanceWorksheetEntry {
  return typeof value === 'string' && Object.hasOwn(FINANCE_WORKSHEET_COLUMNS, value);
}
export function isFinanceWorksheetRows(entryId: FinanceWorksheetEntry, rows: unknown): rows is FinanceWorksheetRow[] {
  if (!Array.isArray(rows) || rows.length > MAX_FINANCE_WORKSHEET_ROWS) return false;
  const columns: readonly string[] = FINANCE_WORKSHEET_COLUMNS[entryId], ids = new Set<string>();
  return rows.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id','cells','reviewStatus'].includes(key))
      || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id)
      || !['pending','reviewed'].includes(row.reviewStatus) || !row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)
      || Object.keys(row.cells).length !== columns.length
      || !columns.every(key => Object.hasOwn(row.cells, key) && typeof row.cells[key] === 'string' && row.cells[key].length <= 2000)) return false;
    ids.add(row.id); return true;
  });
}
