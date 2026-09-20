import type { ToolExecutionRecord } from '../tools/types';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';

/** A saved workbook is only part of a formula/chart request. */
export function missingSpreadsheetRequirements(task: string, records: ToolExecutionRecord[]): string[] {
  const writes = records.filter(record => /^(?:create_xlsx|modify_xlsx)$/.test(record.name)
    && !record.error && record.terminalVerification?.status === 'verified');
  const write = writes.at(-1);
  if (!write) return [];
  const receipt = parseReceiptObject(toolRecordTerminalPayload(write));
  const missing: string[] = [];
  // i18n-allow: Spreadsheet requirements in user instructions.
  if (/(?:\u516c\u5f0f)|\bformulas?\b/iu.test(task) && !(receipt?.formulaCount > 0)) missing.push('formulas');
  if (Array.isArray(receipt?.unresolvedFormulas) && receipt.unresolvedFormulas.length) missing.push('calculation');
  // i18n-allow: Structured chart requests, excluding a negated chart clause.
  const positive = task.split(/[，,。；;\n]/u).filter(clause => !/(?:\u4e0d\u8981|\u4e0d\u7528|\u65e0\u9700)|\b(?:no|without|do not|don't)\b/iu.test(clause)).join(' ');
  // i18n-allow: Explicit requirement for a formula-backed aggregate row.
  if (/(?:总计|合计|总金额|总额).{0,24}公式|公式.{0,24}(?:总计|合计|总金额|总额)|\b(?:total.{0,30}formula|formula.{0,30}total)/iu.test(positive)
    && receipt?.totalFormulaCount === 0) missing.push('grand_total_formula');
  if (/(?:\u67f1\u72b6\u56fe|\u6761\u5f62\u56fe|\u56fe\u8868)|\b(?:charts?|bar\s+graph)\b/iu.test(positive) && !(receipt?.chartCount > 0)) missing.push('chart');
  return missing;
}
