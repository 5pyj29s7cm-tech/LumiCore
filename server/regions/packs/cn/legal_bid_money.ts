import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { SourceDraftValidationError, type Source } from './legal_reasoning_generation';

type Basis = 'net' | 'tax' | 'gross' | 'source';
type Role = 'unit' | 'line' | 'total' | 'auxiliary';
type Material = { id: string; title: string; content: string };
export type BidMoneyFact = {
  source: Source; header: Source; materialSha256: string; column: number;
  role: Role; basis: Basis; amount: string; rowKey: string; rowLabel: string;
};
export type BidMoneyContract = { tableCount: number; tableSources: Source[]; facts: BidMoneyFact[]; required: boolean; issues: string[]; uniqueTableTotalSourceId?: string };
export class BidMoneyVerificationError extends SourceDraftValidationError {}

// Values are bounded to 24 decimal characters; quantity×price and any in-memory row sum stay below 80 significant digits.
const MoneyDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const decimal = (text: string): Decimal | null => text.trim().length <= 24 && /^\d+(?:\.\d{1,2})?$/.test(text.trim()) ? new MoneyDecimal(text.trim()) : null;
const headerText = (text: string) => text.replace(/[\s（）()]/g, '');
// i18n-allow: Closed quotation-table column labels, not general intent classification.
const headers = ['服务项目', '数量', '未税单价元', '未税金额元', '税额元', '含税金额元'];
// i18n-allow: Monetary-format lexer only. Unsupported numerals/signs are detected, never interpreted or normalized.
const unmanagedMoney = /[+\-−﹣－]?[\p{N}零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟.,]+\s*(?:亿元|万元|元)|[¥￥]|(?:未税(?:单价|金额|合计)?|含税(?:金额|合计)?|税额(?:合计)?|单价|总报价|总价|总额|合计)\s*(?:[:：=]|为)?\s*[+\-−﹣－]?[\p{N}零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟]/u;
// i18n-allow: Existing bare column labels are source metadata only; a missing-value statement is not a monetary claim.
const sourceMoneyHeader = /未税|含税|税额|单价/u;

/** A strict projection over the existing document parser's physical rows. No OCR or guessed columns. */
export function buildBidMoneyContract(materials: readonly Material[], sources: readonly Source[]): BidMoneyContract {
  const facts: BidMoneyFact[] = [];
  const tableSources = new Map<string, Source>();
  const issues: string[] = [];
  let required = false, tableCount = 0;
  const byLocation = new Map(sources.map(source => [source.materialId + '\0' + source.locator, source]));
  for (const material of materials) {
    const lines = material.content.split(/\r?\n/);
    const materialSha256 = sha256(material.content);
    const declaredSourceAt = (index: number) => byLocation.get(material.id + '\0提供材料正文第' + (index + 1) + '行');
    const sourceAt = (index: number) => {
      const source = declaredSourceAt(index);
      return source?.quote === lines[index].trim() ? source : undefined;
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (sourceMoneyHeader.test(line) || unmanagedMoney.test(line)) required = true;
      const delimiter = line.includes('\t') ? '\t' : ',';
      const cells = line.split(delimiter).map(headerText);
      if (!headers.every(label => cells.includes(label))) continue;
      tableCount++;
      required = true;
      // Source scope follows the existing blank/# block boundary, even when a later physical row cannot be parsed.
      const rows: number[] = [];
      for (let row = index + 1; row < lines.length && lines[row].trim() && !lines[row].startsWith('#'); row++) {
        rows.push(row);
      }
      for (const row of [index, ...rows]) {
        const source = declaredSourceAt(row);
        if (source) tableSources.set(source.id, source);
      }
      const header = sourceAt(index);
      const columns = headers.map(label => cells.indexOf(label));
      if (!header || line.includes('"') || columns.some((column, at) => cells.lastIndexOf(headers[at]) !== column)) {
        issues.push('报价表列或来源位置不唯一'); continue;
      }
      const [labelAt, quantityAt, unitAt, netAt, taxAt, grossAt] = columns;
      const tableFacts: BidMoneyFact[] = [];
      const sums = { net: new MoneyDecimal(0), tax: new MoneyDecimal(0), gross: new MoneyDecimal(0) };
      let lineCount = 0, totals = 0, invalid = false;
      for (const row of rows) {
        const raw = lines[row].trim();
        const values = raw.split(delimiter).map(value => value.trim());
        if (raw.includes('"') || values.length !== cells.length) { invalid = true; break; }
        const source = sourceAt(row);
        if (!source) { invalid = true; break; }
        const net = decimal(values[netAt]), tax = decimal(values[taxAt]), gross = decimal(values[grossAt]);
        // Only raw-empty quantity/unit/net/tax cells establish an auxiliary row; failed decimal parsing never does.
        if (!values[quantityAt] && !values[unitAt] && !values[netAt] && !values[taxAt]) {
          if (values[grossAt] && !gross) { invalid = true; break; }
          if (gross) tableFacts.push({ source, header, materialSha256, rowKey: values[0], rowLabel: values[labelAt],
            role: 'auxiliary', basis: 'source', column: grossAt + 1, amount: gross.toFixed(2) });
          continue; // Source-only auxiliary values never enter quotation arithmetic or inherit a tax basis.
        }
        if (!net || !tax || !gross || !net.plus(tax).equals(gross)) { invalid = true; break; }
        const quantity = decimal(values[quantityAt]), unit = decimal(values[unitAt]);
        // i18n-allow: An explicit table aggregate label plus arithmetic identifies a total, never its row code.
        const total = !values[quantityAt] && !values[unitAt] && /(?:合计|总计|grand\s+total|total)\s*$/iu.test(values[labelAt]);
        if (total) {
          if (!lineCount || ++totals !== 1 || !net.equals(sums.net) || !tax.equals(sums.tax) || !gross.equals(sums.gross)) { invalid = true; break; }
        } else {
          if (totals || !quantity || !unit || !quantity.times(unit).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).equals(net)) { invalid = true; break; }
          lineCount++;
          sums.net = sums.net.plus(net); sums.tax = sums.tax.plus(tax); sums.gross = sums.gross.plus(gross);
        }
        const base = { source, header, materialSha256, rowKey: values[0], rowLabel: values[labelAt] };
        const role: Role = total ? 'total' : 'line';
        for (const [basis, column, value] of [['net', netAt, net], ['tax', taxAt, tax], ['gross', grossAt, gross]] as const) {
          tableFacts.push({ ...base, role, basis, column: column + 1, amount: value.toFixed(2) });
        }
        if (!total && unit) tableFacts.push({ ...base, role: 'unit', basis: 'net', column: unitAt + 1, amount: unit.toFixed(2) });
      }
      if (invalid || totals !== 1) issues.push('报价表行结构、分项算术或唯一合计未核验');
      else facts.push(...tableFacts);
    }
  }
  if (required && !facts.length) issues.push('未取得可核验的结构化报价表');
  const totalSources = [...new Set(facts.filter(fact => fact.role === 'total').map(fact => fact.source.id))];
  return { tableCount, tableSources: [...tableSources.values()], facts, required, issues: [...new Set(issues)], ...(totalSources.length === 1 ? { uniqueTableTotalSourceId: totalSources[0] } : {}) };
}

export type BidMoneyCheck = { passed: boolean; code: 'closed_fields_checked' | 'not_applicable' | 'line_amount_as_total' | 'unverified'; claimCount: number };
type MoneyEntry = { response: string; missing?: string; sources: Source[] };
const sameSource = (left: Source, right: Source) => left.id === right.id && left.materialId === right.materialId && left.locator === right.locator && left.quote === right.quote;
// Closed source-column names; a model label never changes the source row's verified role.
const fields: Record<string, { role: Role; basis: Basis }> = {
  '未税单价': { role: 'unit', basis: 'net' },
  '未税金额': { role: 'line', basis: 'net' },
  '税额': { role: 'line', basis: 'tax' },
  '含税金额': { role: 'line', basis: 'gross' },
  '未税合计': { role: 'total', basis: 'net' },
  '税额合计': { role: 'total', basis: 'tax' },
  '含税合计': { role: 'total', basis: 'gross' },
  '原表附列金额': { role: 'auxiliary', basis: 'source' },
};
const fieldPattern = /【([^【】|\r\n]+)\|([^【】:：\r\n]+)[:：]([^【】\r\n]+)】/gu;
const unresolvedField = /【[^【】\r\n]*\|/u;
const separator = (character: string) => /[。；;\n|]/u.test(character);

function resolveMoneyEntries(entries: readonly MoneyEntry[], contract: BidMoneyContract): { check: BidMoneyCheck; responses: string[] } {
  let claimCount = 0;
  const responses: string[] = [];
  const stop = (code: 'line_amount_as_total' | 'unverified') => ({ check: { passed: false, code, claimCount }, responses: [] });
  const tableSourceById = new Map(contract.tableSources.map(source => [source.id, source]));
  for (const entry of entries) {
    const matches = [...entry.response.matchAll(new RegExp(fieldPattern.source, 'gu'))];
    const scoped = entry.sources.filter(source => tableSourceById.has(source.id));
    if (scoped.some(source => !sameSource(source, tableSourceById.get(source.id)!))) return stop('unverified');
    if (!scoped.length && !matches.length) {
      if (unresolvedField.test(entry.response) || unresolvedField.test(entry.missing || '')) return stop('unverified');
      responses.push(entry.response); continue;
    }
    let outside = entry.response;
    for (const match of [...matches].reverse()) outside = outside.slice(0, match.index) + ' '.repeat(match[0].length) + outside.slice(match.index! + match[0].length);
    if (unmanagedMoney.test(outside) || unresolvedField.test(outside) || unmanagedMoney.test(entry.missing || '') || unresolvedField.test(entry.missing || '')) return stop('unverified');
    if (!matches.length) { responses.push(entry.response); continue; }
    if (contract.issues.length) return stop('unverified');
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    for (const match of matches) {
      claimCount++;
      let start = match.index!, end = start + match[0].length;
      while (start > 0 && !separator(outside[start - 1])) start--;
      while (end < outside.length && !separator(outside[end])) end++;
      // The server renders the whole monetary sentence/cell, so surrounding prose cannot relabel a valid line token as a project total.
      if (outside.slice(start, end).trim() || matches.filter(item => item.index! >= start && item.index! < end).length !== 1) return stop('unverified');
      const spec = fields[match[2].trim()];
      const value = match[3].trim().match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(亿元|万元|元)$/u);
      if (!spec || !value || value[1].replace(/,/g, '').length > 24) return stop('unverified');
      const amount = new MoneyDecimal(value[1].replace(/,/g, '')).times(value[2] === '亿元' ? 100000000 : value[2] === '万元' ? 10000 : 1);
      const sourceId = match[1].trim();
      const selected = contract.facts.filter(fact => fact.source.id === sourceId && entry.sources.some(source => sameSource(source, fact.source)));
      if (spec.role === 'total' && selected.some(fact => fact.role !== 'total')) return stop('line_amount_as_total');
      if (spec.role === 'total' && contract.uniqueTableTotalSourceId !== sourceId) return stop('unverified');
      const fact = selected.find(item => item.role === spec.role && item.basis === spec.basis && new MoneyDecimal(item.amount).equals(amount));
      if (!fact) return stop('unverified');
      // i18n-allow: Human-readable projection of verified table fields, not model-provided labels or source IDs.
      const basis = fact.basis === 'source' ? '' : fact.basis === 'net' ? '未税' : fact.basis === 'gross' ? '含税' : '税额';
      const label = fact.role === 'auxiliary' ? fact.source.title + '中的“' + fact.rowLabel + '”（原表附列金额）'
        : fact.role === 'total' ? fact.source.title + '的报价表' + basis + '合计'
          : fact.source.title + '中的“' + fact.rowLabel + '”' + (fact.role === 'unit' ? '（未税单价）' : '（分项' + basis + '金额）');
      replacements.push({ start: match.index!, end: match.index! + match[0].length, text: label + '：' + fact.amount + '元' });
    }
    let rendered = entry.response;
    for (const item of replacements.reverse()) rendered = rendered.slice(0, item.start) + item.text + rendered.slice(item.end);
    responses.push(rendered);
  }
  return { check: { passed: true, code: claimCount ? 'closed_fields_checked' : 'not_applicable', claimCount }, responses };
}

/** Checks only the explicit closed monetary contract; it does not certify arbitrary natural-language finance. */
export function verifyBidMoneyClaims(entries: readonly MoneyEntry[], contract: BidMoneyContract): BidMoneyCheck {
  return resolveMoneyEntries(entries, contract).check;
}

/** The raw four-field proposal remains in canonical review/cache; only this server-owned projection reaches the existing compiler. */
export function assertBidMoneyClaims<T extends MoneyEntry>(entries: readonly T[], contract: BidMoneyContract): Array<T & { monetaryResponse: string }> {
  const resolved = resolveMoneyEntries(entries, contract);
  if (!resolved.check.passed) throw new BidMoneyVerificationError('报价表金额字段或来源角色尚未核验，已保留草稿，不能计为完成章节。');
  return entries.map((entry, index) => ({ ...entry, monetaryResponse: resolved.responses[index] }));
}
