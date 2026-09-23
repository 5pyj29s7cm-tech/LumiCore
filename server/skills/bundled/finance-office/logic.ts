import Decimal from 'decimal.js';

export type NumericInput = number | string | null | undefined;

export interface AmountLine {
  label: string;
  amount: number;
}

function toDecimal(value: NumericInput | Decimal, fallback: NumericInput = 0): Decimal {
  try {
    const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
    const decimal = new Decimal(normalized === '' || normalized === null || normalized === undefined ? fallback || 0 : normalized);
    return decimal.isFinite() ? decimal : new Decimal(fallback || 0);
  } catch {
    return new Decimal(fallback || 0);
  }
}

export function roundMoney(value: NumericInput | Decimal): number {
  return toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

function toRate(value: NumericInput): number | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    const raw = new Decimal(String(value).replace('%', '').replace(/,/g, '').trim());
    if (!raw.isFinite()) return null;
    return (raw.greaterThan(1) ? raw.dividedBy(100) : raw).toNumber();
  } catch {
    return null;
  }
}

function sumDecimals(values: Array<NumericInput | Decimal>): Decimal {
  return values.reduce<Decimal>((sum, value) => sum.plus(toDecimal(value)), new Decimal(0));
}

function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

export function parseLines(text: string): AmountLine[] {
  return String(text || '').split(/\n|;/).map(line => {
    const amount = Number((line.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/) || ['0'])[0].replace(/,/g, ''));
    const label = line.replace(/-?\d+(?:,\d{3})*(?:\.\d+)?/, '').trim() || 'item';
    return { label, amount };
  }).filter(item => item.amount !== 0 || item.label !== 'item');
}

export function summarizeExpenses(args: {
  expenseText?: string;
  currency?: string;
}) {
  const items = parseLines(String(args.expenseText || ''));
  const total = sumDecimals(items.map(item => item.amount));
  const anomalyThreshold = Decimal.max(total.abs().times('0.5'), 10000);
  return {
    currency: args.currency || 'CNY',
    itemCount: items.length,
    total: roundMoney(total),
    items,
    anomalies: items.filter(item => toDecimal(item.amount).abs().greaterThan(anomalyThreshold)),
    reviewNotes: [
      'Match each expense to invoice/receipt and approval policy.',
      'Check duplicates by date, vendor, amount, and payer.',
      'Separate reimbursable, non-reimbursable, tax-deductible, and project-specific costs.',
    ],
  };
}

export function forecastCashflow(args: {
  openingCash?: NumericInput;
  receivables?: NumericInput;
  payables?: NumericInput;
  monthlyIncome?: NumericInput;
  monthlyExpense?: NumericInput;
  months?: number;
}) {
  const months = Math.min(Math.max(Number(args.months || 3), 1), 24);
  let cash = toDecimal(args.openingCash).plus(toDecimal(args.receivables)).minus(toDecimal(args.payables));
  const monthlyNet = toDecimal(args.monthlyIncome).minus(toDecimal(args.monthlyExpense));
  const rows = [];
  for (let i = 1; i <= months; i++) {
    cash = cash.plus(monthlyNet);
    rows.push({ month: i, projectedCash: roundMoney(cash) });
  }
  return {
    openingCash: roundMoney(args.openingCash),
    receivables: roundMoney(args.receivables),
    payables: roundMoney(args.payables),
    forecast: rows,
    riskFlags: rows.filter(row => row.projectedCash < 0).map(row => `Month ${row.month} projected cash is negative.`),
  };
}

export function buildFinanceReportOutline(args: {
  period?: string;
  businessType?: string;
  dataSummary?: string;
}) {
  return {
    period: args.period,
    businessType: args.businessType || 'general business',
    sections: [
      'Executive summary',
      'Revenue and gross margin',
      'Cost and expense movement',
      'Cash-flow and runway',
      'Receivables and payables',
      'Tax position and invoice status',
      'Budget variance',
      'Risks and next actions',
    ],
    dataSummary: args.dataSummary,
    checks: [
      'Reconcile totals to source ledger or spreadsheet.',
      'Explain large month-over-month changes.',
      'Separate cash-flow facts from profit/loss facts.',
      'Tie tax and invoice summaries back to source documents.',
      'Have finance/accounting staff review before external use.',
    ],
  };
}

function extractInvoiceNo(line: string, fallback: string): string {
  // i18n-allow: Source-record field recognition, not user-facing copy.
  const match = line.match(/(?:invoice|inv|发票|票号|号码|number|no\.?)\s*[:#：-]?\s*([A-Za-z0-9-]{4,})/i);
  return match?.[1] || fallback;
}

function extractPercent(line: string, fallbackRate: number | null): number | null {
  const percent = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return toRate(percent[1]);
  return fallbackRate;
}

function extractAmount(line: string): number {
  const matches = Array.from(line.matchAll(/(?<![A-Za-z0-9-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9-]|\s*%)/g)).map(m => Number(m[0].replace(/,/g, '')));
  return matches.length > 0 ? matches[matches.length - 1] : 0;
}

export function reviewVatInvoices(args: {
  invoiceText?: string;
  currency?: string;
  defaultVatRate?: NumericInput;
  amountIncludesVat?: boolean;
}) {
  const fallbackRate = toRate(args.defaultVatRate);
  const amountIncludesVat = args.amountIncludesVat !== false;
  const lines = String(args.invoiceText || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
  const seen = new Map<string, number>();
  const rows = lines.map((line, idx) => {
    const amount = extractAmount(line);
    const vatRate = extractPercent(line, fallbackRate);
    const amountValue = toDecimal(amount);
    const rateValue = toDecimal(vatRate);
    const tax = vatRate === null
      ? new Decimal(0)
      : (amountIncludesVat
          ? amountValue.times(rateValue).dividedBy(new Decimal(1).plus(rateValue))
          : amountValue.times(rateValue));
    const netAmount = amountIncludesVat ? amountValue.minus(tax) : amountValue;
    const invoiceNo = extractInvoiceNo(line, `line-${idx + 1}`);
    const duplicateKey = `${invoiceNo}|${roundMoney(amount)}`;
    seen.set(duplicateKey, (seen.get(duplicateKey) || 0) + 1);
    return {
      lineNo: idx + 1,
      invoiceNo,
      description: line,
      amount: roundMoney(amount),
      vatRate,
      netAmount: roundMoney(netAmount),
      vatAmount: roundMoney(tax),
      amountIncludesVat,
    };
  });

  const totalsByRate = rows.reduce<Record<string, { amount: number; netAmount: number; vatAmount: number; count: number }>>((acc, row) => {
    const key = row.vatRate === null ? 'missing_rate' : `${roundMoney(toDecimal(row.vatRate).times(100))}%`;
    acc[key] = acc[key] || { amount: 0, netAmount: 0, vatAmount: 0, count: 0 };
    acc[key].amount = roundMoney(toDecimal(acc[key].amount).plus(row.amount));
    acc[key].netAmount = roundMoney(toDecimal(acc[key].netAmount).plus(row.netAmount));
    acc[key].vatAmount = roundMoney(toDecimal(acc[key].vatAmount).plus(row.vatAmount));
    acc[key].count += 1;
    return acc;
  }, {});

  for (const total of Object.values(totalsByRate)) {
    total.amount = roundMoney(total.amount);
    total.netAmount = roundMoney(total.netAmount);
    total.vatAmount = roundMoney(total.vatAmount);
  }

  const issues = [
    ...rows.filter(row => row.amount === 0).map(row => `Line ${row.lineNo} has no recognizable amount.`),
    ...rows.filter(row => row.vatRate === null).map(row => `Line ${row.lineNo} has no VAT/tax rate.`),
    ...rows.filter(row => row.amount < 0).map(row => `Line ${row.lineNo} is negative; confirm if it is a refund or red-letter invoice.`),
    ...Array.from(seen.entries()).filter(([, count]) => count > 1).map(([key]) => `Possible duplicate invoice/amount: ${key}.`),
  ];

  return {
    currency: args.currency || 'CNY',
    invoiceCount: rows.length,
    totals: {
      grossAmount: roundMoney(sumDecimals(rows.map(row => row.amount))),
      netAmount: roundMoney(sumDecimals(rows.map(row => row.netAmount))),
      vatAmount: roundMoney(sumDecimals(rows.map(row => row.vatAmount))),
    },
    totalsByRate,
    rows,
    issues,
    reviewNotes: [
      'Confirm invoice authenticity, buyer/seller names, tax IDs, dates, and business purpose.',
      'Match invoice amounts to contracts, orders, receipts, bank payments, and ledger entries.',
      'Treat this as a reconciliation aid; final tax treatment should be reviewed by a qualified accountant.',
    ],
  };
}

export function buildTaxChecklist(args: {
  period?: string;
  jurisdiction?: string;
  taxpayerType?: string;
  businessType?: string;
  taxes?: string | string[];
  hasPayroll?: boolean;
  hasCrossBorder?: boolean;
  hasMarketplaceIncome?: boolean;
  dueDate?: string;
}) {
  const jurisdiction = args.jurisdiction || 'CN';
  const selectedTaxes = splitList(args.taxes);
  const taxes = selectedTaxes.length > 0 ? selectedTaxes : (
    jurisdiction.toUpperCase().includes('CN')
      ? ['VAT or other indirect taxes if applicable', 'Corporate income tax prepayment or annual settlement', 'Payroll individual income tax if applicable', 'Surcharges and stamp tax if applicable']
      : ['Sales/VAT/GST if applicable', 'Income tax estimate or filing', 'Payroll tax if applicable', 'Local business taxes if applicable']
  );

  const riskFlags = [];
  if (args.hasPayroll) riskFlags.push('Payroll exists: reconcile salaries, social benefits, and individual income tax filings.');
  if (args.hasCrossBorder) riskFlags.push('Cross-border activity exists: review withholding tax, customs, FX, and invoice evidence.');
  if (args.hasMarketplaceIncome) riskFlags.push('Marketplace income exists: reconcile platform statements, refunds, ad spend, service fees, and invoices.');

  return {
    period: args.period || 'current period',
    jurisdiction,
    taxpayerType: args.taxpayerType || 'unspecified',
    businessType: args.businessType || 'general business',
    dueDate: args.dueDate || 'Confirm with the local tax authority or accountant.',
    taxes,
    checklist: [
      'Close source data: sales, refunds, purchases, expenses, payroll, bank, platform statements, and invoices.',
      'Reconcile revenue to contracts/orders/settlement statements and bank receipts.',
      'Reconcile deductible costs and expenses to valid invoices, approval records, and payment evidence.',
      'Check output/input tax, invoice status, negative invoices, and unusual tax-rate lines.',
      'Prepare filing workpapers with assumptions, adjustments, screenshots, and reviewer sign-off.',
      'Archive submitted forms, payment vouchers, and supporting ledgers after filing.',
    ],
    riskFlags,
    boundary: 'Planning aid only. Tax rules and deadlines vary by jurisdiction, taxpayer status, industry, and current policy.',
  };
}

export function estimateTaxPosition(args: {
  revenue?: NumericInput;
  deductibleCost?: NumericInput;
  deductibleExpense?: NumericInput;
  nonDeductibleExpense?: NumericInput;
  taxAdjustmentsDecrease?: NumericInput;
  vatOutputTax?: NumericInput;
  vatInputTax?: NumericInput;
  incomeTaxRate?: NumericInput;
  surchargeRate?: NumericInput;
  currency?: string;
}) {
  const revenue = toDecimal(args.revenue);
  const deductibleCost = toDecimal(args.deductibleCost);
  const deductibleExpense = toDecimal(args.deductibleExpense);
  const accountingProfit = revenue.minus(deductibleCost).minus(deductibleExpense);
  const taxableProfitEstimate = accountingProfit
    .plus(toDecimal(args.nonDeductibleExpense))
    .minus(toDecimal(args.taxAdjustmentsDecrease));
  const incomeTaxRate = toRate(args.incomeTaxRate);
  const surchargeRate = toRate(args.surchargeRate);
  const hasVatInputs = args.vatOutputTax !== undefined || args.vatInputTax !== undefined;
  const vatPayable = hasVatInputs
    ? Decimal.max(toDecimal(args.vatOutputTax).minus(toDecimal(args.vatInputTax)), 0)
    : null;
  const estimatedIncomeTax = incomeTaxRate === null
    ? null
    : Decimal.max(taxableProfitEstimate, 0).times(toDecimal(incomeTaxRate));
  const estimatedSurcharge = surchargeRate === null || vatPayable === null
    ? null
    : vatPayable.times(toDecimal(surchargeRate));
  const cashTaxEstimate = [estimatedIncomeTax, vatPayable, estimatedSurcharge]
    .filter((value): value is Decimal => value instanceof Decimal)
    .reduce((sum, value) => sum.plus(value), new Decimal(0));

  return {
    currency: args.currency || 'CNY',
    revenue: roundMoney(revenue),
    accountingProfit: roundMoney(accountingProfit),
    taxableProfitEstimate: roundMoney(taxableProfitEstimate),
    vatPayable: vatPayable === null ? null : roundMoney(vatPayable),
    estimatedSurcharge: estimatedSurcharge === null ? null : roundMoney(estimatedSurcharge),
    estimatedIncomeTax: estimatedIncomeTax === null ? null : roundMoney(estimatedIncomeTax),
    cashTaxEstimate: roundMoney(cashTaxEstimate),
    assumptions: {
      incomeTaxRate,
      surchargeRate,
      ratesAreUserProvided: true,
    },
    reviewNotes: [
      'Input tax rates and adjustments should come from the company accountant or current local policy.',
      'Non-deductible expenses and tax adjustment decreases require source documentation.',
      'Use this for scenario planning, not as a final tax filing calculation.',
    ],
  };
}

function parseDate(value: string | undefined): Date | null {
  const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function findDate(value: string): string | undefined {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
}

function daysBetween(from: Date, to: Date): number {
  const ms = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
    - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.floor(ms / 86400000);
}

function agingBucket(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

function splitLedgerLines(value: string): string[] {
  return String(value || '')
    .split(/\r?\n|[;；]|，(?=[^，；;\n]*\d+(?:,\d{3})*(?:\.\d+)?[^，；;\n]*\d{4}-\d{2}-\d{2})/)
    .map(line => line.trim())
    .filter(Boolean);
}

export function analyzeArApAging(args: {
  ledgerText?: string;
  asOfDate?: string;
  type?: 'receivable' | 'payable';
  currency?: string;
}) {
  const asOf = parseDate(args.asOfDate) || new Date();
  const rows = splitLedgerLines(String(args.ledgerText || '')).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const dueDateText = findDate(text);
    const dueDate = parseDate(dueDateText);
    const amount = extractAmount(text);
    const daysOverdue = dueDate ? daysBetween(dueDate, asOf) : 0;
    const counterparty = text
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/(?<![A-Za-z0-9-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9-]|\s*%)/g, '')
  // i18n-allow: Source-record field recognition, not user-facing copy.
      .replace(/(?:\bdue\b|到期|元)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `party-${index + 1}`;
    return {
      lineNo: index + 1,
      counterparty,
      dueDate: dueDateText || null,
      amount: roundMoney(amount),
      daysOverdue,
      bucket: dueDate ? agingBucket(daysOverdue) : 'missing_due_date',
    };
  }).filter((row): row is NonNullable<typeof row> => Boolean(row));

  const totalsByBucket = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.bucket] = roundMoney(toDecimal(acc[row.bucket] || 0).plus(row.amount));
    return acc;
  }, {});

  return {
    type: args.type || 'receivable',
    currency: args.currency || 'CNY',
    asOfDate: asOf.toISOString().slice(0, 10),
    rows,
    totalAmount: roundMoney(sumDecimals(rows.map(row => row.amount))),
    totalsByBucket,
    riskFlags: [
      ...rows.filter(row => row.bucket === '90+').map(row => `${row.counterparty}: ${row.amount} is overdue more than 90 days.`),
      ...rows.filter(row => row.bucket === 'missing_due_date').map(row => `${row.counterparty}: missing due date.`),
      ...rows.filter(row => row.amount < 0).map(row => `${row.counterparty}: negative amount; confirm credit note, prepayment, or write-off.`),
    ],
    nextActions: args.type === 'payable'
      ? [
          'Prioritize overdue supplier payments by business continuity, penalties, and cash plan.',
          'Reconcile payable balances to contracts, invoices, goods receipts, and bank payments.',
          'Confirm whether negative payable lines are prepayments or supplier credits.',
        ]
      : [
          'Prioritize 90+ day receivables for collection, impairment review, or legal escalation.',
          'Reconcile receivables to contracts, invoices, delivery/service evidence, and bank receipts.',
          'Confirm whether negative receivable lines are refunds, credit notes, or advances received.',
        ],
  };
}

function sumByLabels(text: string, labels: RegExp[]): number {
  let total = new Decimal(0);
  for (const line of String(text || '').split(/\n|;/)) {
    if (!labels.some(label => label.test(line))) continue;
    total = total.plus(toDecimal(extractAmount(line)));
  }
  return total.toNumber();
}

function argOrParsed(value: NumericInput, parsed: number): Decimal {
  return toDecimal(value === undefined || value === null || value === '' ? parsed : value);
}

export function buildEcommerceTaxWorkpaper(args: {
  period?: string;
  platform?: string;
  settlementText?: string;
  orderRevenue?: NumericInput;
  refunds?: NumericInput;
  platformFees?: NumericInput;
  adSpend?: NumericInput;
  freight?: NumericInput;
  cogs?: NumericInput;
  invoiceIssuedAmount?: NumericInput;
  vatOutputTax?: NumericInput;
  vatInputTax?: NumericInput;
  currency?: string;
}) {
  const text = String(args.settlementText || '');
  // i18n-allow: Source-record field recognition, not user-facing copy.
  const orderRevenue = argOrParsed(args.orderRevenue, sumByLabels(text, [/payment|paid|receipt|sales|revenue|gmv|收款|结算收入|货款|成交|销售额/]));
  // i18n-allow: Source-record field recognition, not user-facing copy.
  const refunds = argOrParsed(args.refunds, sumByLabels(text, [/refund|return|退款|退货|售后/]));
  // i18n-allow: Source-record field recognition, not user-facing copy.
  const platformFees = argOrParsed(args.platformFees, sumByLabels(text, [/fee|commission|平台费|佣金|服务费|技术服务/]));
  // i18n-allow: Source-record field recognition, not user-facing copy.
  const adSpend = argOrParsed(args.adSpend, sumByLabels(text, [/\bads?\b|\bad.?spend\b|广告|投流|推广/]));
  // i18n-allow: Source-record field recognition, not user-facing copy.
  const freight = argOrParsed(args.freight, sumByLabels(text, [/shipping|freight|物流|运费|快递/]));
  const cogs = toDecimal(args.cogs);
  const invoiceIssuedAmount = toDecimal(args.invoiceIssuedAmount);
  const taxableRevenueCandidate = orderRevenue.minus(refunds);
  const platformNetCash = taxableRevenueCandidate.minus(platformFees).minus(adSpend).minus(freight);
  const grossProfitEstimate = taxableRevenueCandidate.minus(cogs).minus(freight).minus(platformFees).minus(adSpend);
  const invoiceGap = invoiceIssuedAmount.minus(taxableRevenueCandidate);
  const vatPayable = args.vatOutputTax === undefined && args.vatInputTax === undefined
    ? null
    : Decimal.max(toDecimal(args.vatOutputTax).minus(toDecimal(args.vatInputTax)), 0);
  const materialGap = Decimal.max(taxableRevenueCandidate.abs().times('0.02'), 100);

  return {
    period: args.period || 'current period',
    platform: args.platform || 'marketplace',
    currency: args.currency || 'CNY',
    revenueBridge: {
      orderRevenue: roundMoney(orderRevenue),
      refunds: roundMoney(refunds),
      taxableRevenueCandidate: roundMoney(taxableRevenueCandidate),
      platformFees: roundMoney(platformFees),
      adSpend: roundMoney(adSpend),
      freight: roundMoney(freight),
      platformNetCash: roundMoney(platformNetCash),
      cogs: roundMoney(cogs),
      grossProfitEstimate: roundMoney(grossProfitEstimate),
    },
    invoiceBridge: {
      invoiceIssuedAmount: roundMoney(invoiceIssuedAmount),
      invoiceGap: roundMoney(invoiceGap),
      invoiceCoverageRate: taxableRevenueCandidate.greaterThan(0)
        ? roundMoney(invoiceIssuedAmount.dividedBy(taxableRevenueCandidate).times(100))
        : null,
    },
    vatBridge: {
      vatOutputTax: args.vatOutputTax === undefined ? null : roundMoney(args.vatOutputTax),
      vatInputTax: args.vatInputTax === undefined ? null : roundMoney(args.vatInputTax),
      vatPayable: vatPayable === null ? null : roundMoney(vatPayable),
    },
    riskFlags: [
      ...(invoiceGap.abs().greaterThan(materialGap) ? [`Invoice amount differs from taxable revenue candidate by ${roundMoney(invoiceGap)}.`] : []),
      ...(invoiceIssuedAmount.isZero() && taxableRevenueCandidate.greaterThan(0) ? ['No issued invoice amount provided for positive platform revenue.'] : []),
      ...(vatPayable === null ? ['VAT output/input tax not provided; add tax ledger or invoice summary before filing review.'] : []),
      ...(platformFees.plus(adSpend).greaterThan(taxableRevenueCandidate.times('0.35')) ? ['Platform fees plus ads exceed 35% of revenue; review profitability and deductible evidence.'] : []),
    ],
    evidenceChecklist: [
      'Platform settlement statement and order export for the exact period.',
      'Refund/return export and after-sales evidence.',
      'Ad spend statement, platform service-fee invoice, freight invoice, and payment records.',
      'Issued invoice list, red-letter invoice list, and VAT input invoice summary.',
      'Accounting entries that reconcile platform net cash to bank receipts.',
    ],
    boundary: 'Workpaper aid only. Revenue recognition, invoicing, and tax filing positions must be reviewed by finance/accounting staff.',
  };
}

export interface ReconciliationEntry {
  id: string;
  amount: NumericInput;
  date?: string;
  reference?: string;
  description?: string;
}

function normalizeReference(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function entryDateDistance(left?: string, right?: string): number | null {
  const leftDate = parseDate(left);
  const rightDate = parseDate(right);
  if (!leftDate || !rightDate) return null;
  return Math.abs(daysBetween(leftDate, rightDate));
}

export function reconcileLedgerEntries(args: {
  bookEntries: ReconciliationEntry[];
  bankEntries: ReconciliationEntry[];
  dateToleranceDays?: number;
  currency?: string;
}) {
  const dateToleranceDays = Math.max(0, Math.min(31, Math.floor(args.dateToleranceDays ?? 3)));
  const bookEntries = Array.isArray(args.bookEntries) ? args.bookEntries : [];
  const bankEntries = Array.isArray(args.bankEntries) ? args.bankEntries : [];
  const remainingBankIndexes = new Set(bankEntries.map((_, index) => index));
  const matched: Array<Record<string, unknown>> = [];
  const ambiguous: Array<Record<string, unknown>> = [];
  const unmatchedBook: ReconciliationEntry[] = [];

  for (const book of bookEntries) {
    const bookAmount = toDecimal(book.amount);
    const amountCandidates = [...remainingBankIndexes].filter(index => {
      const bank = bankEntries[index];
      if (!bookAmount.equals(toDecimal(bank.amount))) return false;
      const distance = entryDateDistance(book.date, bank.date);
      return distance === null || distance <= dateToleranceDays;
    });

    const bookReference = normalizeReference(book.reference || book.description);
    const referenceCandidates = bookReference
      ? amountCandidates.filter(index => {
          const bankReference = normalizeReference(bankEntries[index].reference || bankEntries[index].description);
          return Boolean(bankReference) && (bankReference === bookReference
            || bankReference.includes(bookReference)
            || bookReference.includes(bankReference));
        })
      : [];
    const candidates = referenceCandidates.length === 1 ? referenceCandidates : amountCandidates;

    if (candidates.length === 1) {
      const bankIndex = candidates[0];
      const bank = bankEntries[bankIndex];
      remainingBankIndexes.delete(bankIndex);
      matched.push({
        bookId: book.id,
        bankId: bank.id,
        amount: roundMoney(bookAmount),
        dateDistanceDays: entryDateDistance(book.date, bank.date),
        matchBasis: referenceCandidates.length === 1 ? 'amount_date_reference' : 'amount_date',
      });
    } else if (candidates.length > 1) {
      ambiguous.push({
        bookId: book.id,
        amount: roundMoney(bookAmount),
        candidateBankIds: candidates.map(index => bankEntries[index].id),
      });
      unmatchedBook.push(book);
    } else {
      unmatchedBook.push(book);
    }
  }

  const unmatchedBank = [...remainingBankIndexes].map(index => bankEntries[index]);
  const bookTotal = sumDecimals(bookEntries.map(entry => entry.amount));
  const bankTotal = sumDecimals(bankEntries.map(entry => entry.amount));
  const difference = bookTotal.minus(bankTotal);
  const duplicateBookIds = bookEntries
    .map(entry => entry.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  const duplicateBankIds = bankEntries
    .map(entry => entry.id)
    .filter((id, index, all) => all.indexOf(id) !== index);

  return {
    status: unmatchedBook.length === 0
      && unmatchedBank.length === 0
      && ambiguous.length === 0
      && difference.isZero()
      ? 'reconciled'
      : 'needs_review',
    currency: args.currency || 'CNY',
    dateToleranceDays,
    totals: {
      book: roundMoney(bookTotal),
      bank: roundMoney(bankTotal),
      difference: roundMoney(difference),
    },
    matched,
    unmatchedBook,
    unmatchedBank,
    ambiguous,
    duplicateIds: {
      book: Array.from(new Set(duplicateBookIds)),
      bank: Array.from(new Set(duplicateBankIds)),
    },
    limitations: [
      'Automatic matching uses exact signed amounts, date tolerance, and optional reference text; it does not infer split, merged, fee-netted, or foreign-exchange transactions.',
      'Use the same debit/credit sign convention for book and bank entries before reconciliation.',
    ],
  };
}

function supplied(value: NumericInput): boolean {
  return value !== undefined && value !== null && value !== '';
}

function roundedRatio(numerator: NumericInput | Decimal, denominator: NumericInput | Decimal, percent = false): number | null {
  const base = toDecimal(denominator);
  if (base.isZero()) return null;
  const value = toDecimal(numerator).dividedBy(base).times(percent ? 100 : 1);
  return value.toDecimalPlaces(percent ? 2 : 4, Decimal.ROUND_HALF_UP).toNumber();
}

export function analyzeFinancialRatios(args: {
  revenue?: NumericInput;
  costOfRevenue?: NumericInput;
  operatingIncome?: NumericInput;
  netIncome?: NumericInput;
  currentAssets?: NumericInput;
  currentLiabilities?: NumericInput;
  totalAssets?: NumericInput;
  totalLiabilities?: NumericInput;
  equity?: NumericInput;
  operatingCashFlow?: NumericInput;
  currency?: string;
}) {
  const grossProfit = supplied(args.revenue) && supplied(args.costOfRevenue)
    ? toDecimal(args.revenue).minus(toDecimal(args.costOfRevenue))
    : null;
  const metric = (
    name: string,
    numerator: NumericInput | Decimal | null,
    denominator: NumericInput | Decimal | null,
    percent: boolean,
    formula: string,
  ) => ({
    name,
    value: numerator === null || denominator === null ? null : roundedRatio(numerator, denominator, percent),
    unit: percent ? 'percent' : 'ratio',
    formula,
  });

  const metrics = [
    metric('gross_margin', grossProfit, supplied(args.revenue) ? args.revenue! : null, true, '(revenue - cost_of_revenue) / revenue'),
    metric('operating_margin', supplied(args.operatingIncome) ? args.operatingIncome! : null, supplied(args.revenue) ? args.revenue! : null, true, 'operating_income / revenue'),
    metric('net_margin', supplied(args.netIncome) ? args.netIncome! : null, supplied(args.revenue) ? args.revenue! : null, true, 'net_income / revenue'),
    metric('current_ratio', supplied(args.currentAssets) ? args.currentAssets! : null, supplied(args.currentLiabilities) ? args.currentLiabilities! : null, false, 'current_assets / current_liabilities'),
    metric('debt_to_assets', supplied(args.totalLiabilities) ? args.totalLiabilities! : null, supplied(args.totalAssets) ? args.totalAssets! : null, true, 'total_liabilities / total_assets'),
    metric('debt_to_equity', supplied(args.totalLiabilities) ? args.totalLiabilities! : null, supplied(args.equity) ? args.equity! : null, false, 'total_liabilities / equity'),
    metric('return_on_assets', supplied(args.netIncome) ? args.netIncome! : null, supplied(args.totalAssets) ? args.totalAssets! : null, true, 'net_income / ending_total_assets'),
    metric('return_on_equity', supplied(args.netIncome) ? args.netIncome! : null, supplied(args.equity) ? args.equity! : null, true, 'net_income / ending_equity'),
    metric('operating_cash_conversion', supplied(args.operatingCashFlow) ? args.operatingCashFlow! : null, supplied(args.netIncome) ? args.netIncome! : null, false, 'operating_cash_flow / net_income'),
  ];

  return {
    currency: args.currency || 'CNY',
    grossProfit: grossProfit === null ? null : roundMoney(grossProfit),
    metrics,
    unavailableMetrics: metrics.filter(item => item.value === null).map(item => item.name),
    reviewNotes: [
      'ROA and ROE use ending balances because average opening balances were not provided.',
      'A ratio describes the supplied period only; compare with consistent prior periods, peers, and accounting policies before drawing conclusions.',
    ],
  };
}

export interface BudgetVarianceLine {
  category: string;
  budget: NumericInput;
  actual: NumericInput;
  kind: 'revenue' | 'expense';
}

export function analyzeBudgetVariance(args: {
  lines: BudgetVarianceLine[];
  materialityPercent?: number;
  materialityAmount?: NumericInput;
  currency?: string;
}) {
  const materialityPercent = Math.max(0, Math.min(1000, args.materialityPercent ?? 10));
  const materialityAmount = toDecimal(args.materialityAmount);
  const rows = (Array.isArray(args.lines) ? args.lines : []).map(line => {
    const budget = toDecimal(line.budget);
    const actual = toDecimal(line.actual);
    const favorableVariance = line.kind === 'revenue'
      ? actual.minus(budget)
      : budget.minus(actual);
    const variancePercent = budget.isZero()
      ? null
      : favorableVariance.dividedBy(budget.abs()).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    const material = !favorableVariance.isZero()
      && favorableVariance.abs().greaterThanOrEqualTo(materialityAmount)
      && (variancePercent === null || Math.abs(variancePercent) >= materialityPercent);
    return {
      category: line.category,
      kind: line.kind,
      budget: roundMoney(budget),
      actual: roundMoney(actual),
      favorableVariance: roundMoney(favorableVariance),
      variancePercent,
      assessment: favorableVariance.isPositive() ? 'favorable' : favorableVariance.isNegative() ? 'unfavorable' : 'on_budget',
      material,
    };
  });

  const revenueRows = rows.filter(row => row.kind === 'revenue');
  const expenseRows = rows.filter(row => row.kind === 'expense');
  const sumRow = (items: typeof rows, field: 'budget' | 'actual' | 'favorableVariance') => sumDecimals(items.map(item => item[field]));
  const revenueBudget = sumRow(revenueRows, 'budget');
  const revenueActual = sumRow(revenueRows, 'actual');
  const expenseBudget = sumRow(expenseRows, 'budget');
  const expenseActual = sumRow(expenseRows, 'actual');

  return {
    currency: args.currency || 'CNY',
    materiality: {
      percent: materialityPercent,
      amount: roundMoney(materialityAmount),
      rule: 'absolute amount threshold AND percentage threshold; zero-budget rows use amount threshold only',
    },
    rows,
    totals: {
      revenueBudget: roundMoney(revenueBudget),
      revenueActual: roundMoney(revenueActual),
      expenseBudget: roundMoney(expenseBudget),
      expenseActual: roundMoney(expenseActual),
      budgetedOperatingResult: roundMoney(revenueBudget.minus(expenseBudget)),
      actualOperatingResult: roundMoney(revenueActual.minus(expenseActual)),
      favorableOperatingVariance: roundMoney(revenueActual.minus(expenseActual).minus(revenueBudget.minus(expenseBudget))),
    },
    materialVariances: rows.filter(row => row.material),
    reviewRequired: rows.some(row => row.material),
  };
}

export interface StatementConsistencyCheck {
  id: string;
  status: 'passed' | 'failed' | 'not_evaluated';
  expected?: number;
  reported?: number;
  difference?: number;
  tolerance: number;
  formula: string;
  missingFields?: string[];
}

export function reviewStatementConsistency(args: {
  totalAssets?: NumericInput;
  totalLiabilities?: NumericInput;
  totalEquity?: NumericInput;
  cashBeginning?: NumericInput;
  operatingCashFlow?: NumericInput;
  investingCashFlow?: NumericInput;
  financingCashFlow?: NumericInput;
  foreignExchangeEffect?: NumericInput;
  cashEnding?: NumericInput;
  retainedEarningsBeginning?: NumericInput;
  netIncome?: NumericInput;
  dividends?: NumericInput;
  retainedEarningsAdjustments?: NumericInput;
  retainedEarningsEnding?: NumericInput;
  pretaxIncome?: NumericInput;
  incomeTaxExpense?: NumericInput;
  reportedNetIncome?: NumericInput;
  tolerance?: NumericInput;
  currency?: string;
}) {
  const tolerance = Decimal.max(toDecimal(args.tolerance, '0.01').abs(), 0);
  const check = (
    id: string,
    expectedInputs: Array<[string, NumericInput]>,
    reportedField: [string, NumericInput],
    calculateExpected: (values: Decimal[]) => Decimal,
    formula: string,
  ): StatementConsistencyCheck => {
    const missingFields = [...expectedInputs, reportedField]
      .filter(([, value]) => !supplied(value))
      .map(([name]) => name);
    if (missingFields.length > 0) {
      return { id, status: 'not_evaluated', tolerance: roundMoney(tolerance), formula, missingFields };
    }
    const expected = calculateExpected(expectedInputs.map(([, value]) => toDecimal(value)));
    const reported = toDecimal(reportedField[1]);
    const difference = reported.minus(expected);
    return {
      id,
      status: difference.abs().lessThanOrEqualTo(tolerance) ? 'passed' : 'failed',
      expected: roundMoney(expected),
      reported: roundMoney(reported),
      difference: roundMoney(difference),
      tolerance: roundMoney(tolerance),
      formula,
    };
  };

  const checks = [
    check(
      'balance_sheet_equation',
      [['totalLiabilities', args.totalLiabilities], ['totalEquity', args.totalEquity]],
      ['totalAssets', args.totalAssets],
      ([liabilities, equity]) => liabilities.plus(equity),
      'total_assets = total_liabilities + total_equity',
    ),
    check(
      'cash_flow_rollforward',
      [
        ['cashBeginning', args.cashBeginning],
        ['operatingCashFlow', args.operatingCashFlow],
        ['investingCashFlow', args.investingCashFlow],
        ['financingCashFlow', args.financingCashFlow],
        ['foreignExchangeEffect', args.foreignExchangeEffect],
      ],
      ['cashEnding', args.cashEnding],
      ([beginning, operating, investing, financing, fx]) => beginning.plus(operating).plus(investing).plus(financing).plus(fx),
      'cash_ending = cash_beginning + operating_cf + investing_cf + financing_cf + fx_effect',
    ),
    check(
      'retained_earnings_rollforward',
      [
        ['retainedEarningsBeginning', args.retainedEarningsBeginning],
        ['netIncome', args.netIncome],
        ['dividends', args.dividends],
        ['retainedEarningsAdjustments', args.retainedEarningsAdjustments],
      ],
      ['retainedEarningsEnding', args.retainedEarningsEnding],
      ([beginning, netIncome, dividends, adjustments]) => beginning.plus(netIncome).minus(dividends).plus(adjustments),
      'retained_earnings_ending = beginning + net_income - dividends + adjustments',
    ),
    check(
      'income_statement_bridge',
      [['pretaxIncome', args.pretaxIncome], ['incomeTaxExpense', args.incomeTaxExpense]],
      ['reportedNetIncome', args.reportedNetIncome],
      ([pretaxIncome, incomeTax]) => pretaxIncome.minus(incomeTax),
      'reported_net_income = pretax_income - income_tax_expense',
    ),
  ];

  return {
    currency: args.currency || 'CNY',
    overallStatus: checks.some(item => item.status === 'failed')
      ? 'failed'
      : checks.every(item => item.status === 'passed')
        ? 'passed'
        : checks.some(item => item.status === 'passed')
          ? 'passed_with_incomplete_checks'
          : 'insufficient_data',
    checks,
    summary: {
      passed: checks.filter(item => item.status === 'passed').length,
      failed: checks.filter(item => item.status === 'failed').length,
      notEvaluated: checks.filter(item => item.status === 'not_evaluated').length,
    },
    boundary: 'Arithmetic consistency checks do not establish accounting-standard compliance, completeness, valuation accuracy, or audit assurance.',
  };
}
