import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeBudgetVariance,
  analyzeFinancialRatios,
  analyzeArApAging,
  buildFinanceReportOutline,
  buildEcommerceTaxWorkpaper,
  buildTaxChecklist,
  estimateTaxPosition,
  forecastCashflow,
  reconcileLedgerEntries,
  reviewStatementConsistency,
  reviewVatInvoices,
  summarizeExpenses,
} from './logic';
import { withFinanceAuditReceipt } from './audit';

const decimalInput = z.union([
  z.number(),
  z.string().regex(/^-?(?:\d+\.?\d*|\.\d+)$/, 'Expected a base-10 decimal value'),
]);

const reconciliationEntry = z.object({
  id: z.string().min(1).max(120).describe('Stable row or transaction identifier'),
  amount: decimalInput.describe('Signed amount; use the same sign convention on both sides'),
  date: z.string().optional().describe('Optional transaction date in YYYY-MM-DD format'),
  reference: z.string().max(500).optional().describe('Optional bank or ledger reference'),
  description: z.string().max(1000).optional().describe('Optional transaction description'),
});

function ok(tool: string, args: Record<string, unknown>, data: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(withFinanceAuditReceipt(tool, args, data), null, 2),
    }],
  };
}

export function registerFinanceSkillTools(server: { registerTool(name: string, config: any, handler: (args: any) => Promise<any>): unknown }): void {

server.registerTool('expense_summary', {
  description: 'Summarize expense lines into totals, categories, anomalies, and reimbursement review notes. Input can be pasted from receipts or a spreadsheet.',
  inputSchema: {
    expenseText: z.string().describe('Expense lines, one per line. Include amount and short description.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('expense_summary', args, summarizeExpenses(args)));

server.registerTool('cashflow_forecast', {
  description: 'Create a simple cash-flow forecast from opening cash, receivables, payables, recurring income, and recurring expenses.',
  inputSchema: {
    openingCash: decimalInput.describe('Starting cash balance'),
    receivables: decimalInput.optional().describe('Expected incoming cash'),
    payables: decimalInput.optional().describe('Expected outgoing payables'),
    monthlyIncome: decimalInput.optional().describe('Recurring monthly income'),
    monthlyExpense: decimalInput.optional().describe('Recurring monthly expense'),
    months: z.number().optional().describe('Number of months to forecast, default 3'),
  },
}, async (args: any) => ok('cashflow_forecast', args, forecastCashflow(args)));

server.registerTool('finance_report_outline', {
  description: 'Generate a management finance report outline from period, business type, and raw data summary.',
  inputSchema: {
    period: z.string().describe('Reporting period'),
    businessType: z.string().optional().describe('Company or project type'),
    dataSummary: z.string().describe('Known revenue, cost, cash, receivable, payable, or KPI summary'),
  },
}, async (args: any) => ok('finance_report_outline', args, buildFinanceReportOutline(args)));

server.registerTool('vat_invoice_review', {
  description: 'Review pasted invoice lines for gross/net/VAT totals, missing rates, negative invoices, and duplicate invoice/amount signals.',
  inputSchema: {
    invoiceText: z.string().describe('Invoice lines. Include invoice number/vendor/description, amount, and tax rate when known.'),
    currency: z.string().optional().describe('Currency code or symbol'),
    defaultVatRate: decimalInput.optional().describe('Optional default VAT/tax rate. Accepts 0.13 or 13 for 13%.'),
    amountIncludesVat: z.boolean().optional().describe('Whether amounts are tax-inclusive. Defaults to true.'),
  },
}, async (args: any) => ok('vat_invoice_review', args, reviewVatInvoices(args)));

server.registerTool('tax_period_checklist', {
  description: 'Create a period tax workpaper checklist for finance teams, including source-data close, invoice checks, filing evidence, and risk flags. This is not final tax advice.',
  inputSchema: {
    period: z.string().describe('Reporting or filing period'),
    jurisdiction: z.string().optional().describe('Jurisdiction or country/region code, e.g. CN, US-CA, EU-DE'),
    taxpayerType: z.string().optional().describe('Taxpayer status, e.g. small-scale VAT taxpayer, general taxpayer, sole proprietor, company'),
    businessType: z.string().optional().describe('Business model or industry'),
    taxes: z.union([z.string(), z.array(z.string())]).optional().describe('Known tax types to include'),
    hasPayroll: z.boolean().optional().describe('Whether payroll exists in this period'),
    hasCrossBorder: z.boolean().optional().describe('Whether cross-border trade, services, or payments exist'),
    hasMarketplaceIncome: z.boolean().optional().describe('Whether marketplace/e-commerce platform income exists'),
    dueDate: z.string().optional().describe('Known filing due date if already confirmed'),
  },
}, async (args: any) => ok('tax_period_checklist', args, buildTaxChecklist(args)));

server.registerTool('tax_position_estimator', {
  description: 'Estimate a management-view tax position from revenue, deductible costs/expenses, VAT output/input tax, and user-provided tax rates. For scenario planning only.',
  inputSchema: {
    revenue: decimalInput.describe('Revenue or taxable turnover for the period'),
    deductibleCost: decimalInput.optional().describe('Deductible direct cost'),
    deductibleExpense: decimalInput.optional().describe('Deductible operating expense'),
    nonDeductibleExpense: decimalInput.optional().describe('Expenses to add back for taxable profit estimation'),
    taxAdjustmentsDecrease: decimalInput.optional().describe('Adjustments that reduce taxable profit'),
    vatOutputTax: decimalInput.optional().describe('Output VAT/tax amount'),
    vatInputTax: decimalInput.optional().describe('Creditable input VAT/tax amount'),
    incomeTaxRate: decimalInput.optional().describe('User-provided income tax rate. Accepts 0.25 or 25 for 25%.'),
    surchargeRate: decimalInput.optional().describe('User-provided surcharge rate on VAT/tax payable. Accepts 0.12 or 12 for 12%.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('tax_position_estimator', args, estimateTaxPosition(args)));

server.registerTool('ar_ap_aging', {
  description: 'Build an accounts receivable/payable aging table from pasted ledger lines with amounts and due dates, including overdue buckets and risk flags.',
  inputSchema: {
    ledgerText: z.string().describe('Ledger lines. Example: Customer A 3000 due 2026-05-10; Supplier B 1200 2026-07-01.'),
    asOfDate: z.string().optional().describe('Aging date in YYYY-MM-DD format. Defaults to today.'),
    type: z.enum(['receivable', 'payable']).optional().describe('Ledger type. Defaults to receivable.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('ar_ap_aging', args, analyzeArApAging(args)));

server.registerTool('ecommerce_tax_workpaper', {
  description: 'Create an e-commerce tax workpaper bridge from platform revenue/refunds/fees/ads/freight to invoices, VAT, evidence, and risk flags.',
  inputSchema: {
    period: z.string().describe('Reporting or tax period'),
    platform: z.string().optional().describe('Marketplace or store platform'),
    settlementText: z.string().optional().describe('Optional pasted settlement lines used when explicit amounts are not provided'),
    orderRevenue: decimalInput.optional().describe('Gross order/platform revenue for the period'),
    refunds: decimalInput.optional().describe('Refunds/returns for the period'),
    platformFees: decimalInput.optional().describe('Platform commissions or service fees'),
    adSpend: decimalInput.optional().describe('Platform advertising spend'),
    freight: decimalInput.optional().describe('Freight/logistics cost'),
    cogs: decimalInput.optional().describe('Cost of goods sold'),
    invoiceIssuedAmount: decimalInput.optional().describe('Invoice amount issued for taxable platform revenue'),
    vatOutputTax: decimalInput.optional().describe('Output VAT/tax amount'),
    vatInputTax: decimalInput.optional().describe('Creditable input VAT/tax amount'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('ecommerce_tax_workpaper', args, buildEcommerceTaxWorkpaper(args)));

server.registerTool('ledger_reconciliation', {
  description: 'Reconcile structured book and bank entries with exact signed amounts, bounded date tolerance, reference matching, ambiguous-match reporting, and an audit receipt. Read-only calculation only.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    bookEntries: z.array(reconciliationEntry).max(5000).describe('General-ledger or cash-book entries'),
    bankEntries: z.array(reconciliationEntry).max(5000).describe('Bank statement entries using the same amount sign convention'),
    dateToleranceDays: z.number().int().min(0).max(31).optional().describe('Maximum date difference for automatic matching; default 3'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('ledger_reconciliation', args, reconcileLedgerEntries(args)));

server.registerTool('financial_ratio_analysis', {
  description: 'Calculate core profitability, liquidity, leverage, return, and cash-conversion ratios from user-provided statement values. Missing or zero-denominator metrics remain explicitly unavailable.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    revenue: decimalInput.optional(),
    costOfRevenue: decimalInput.optional(),
    operatingIncome: decimalInput.optional(),
    netIncome: decimalInput.optional(),
    currentAssets: decimalInput.optional(),
    currentLiabilities: decimalInput.optional(),
    totalAssets: decimalInput.optional(),
    totalLiabilities: decimalInput.optional(),
    equity: decimalInput.optional(),
    operatingCashFlow: decimalInput.optional(),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('financial_ratio_analysis', args, analyzeFinancialRatios(args)));

server.registerTool('budget_variance_analysis', {
  description: 'Compare budget and actual values by category, classify favorable and unfavorable variances, apply explicit materiality thresholds, and summarize operating-result variance.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    lines: z.array(z.object({
      category: z.string().min(1).max(200),
      budget: decimalInput,
      actual: decimalInput,
      kind: z.enum(['revenue', 'expense']),
    })).min(1).max(2000),
    materialityPercent: z.number().min(0).max(1000).optional().describe('Default 10 percent'),
    materialityAmount: decimalInput.optional().describe('Absolute variance threshold; default 0'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('budget_variance_analysis', args, analyzeBudgetVariance(args)));

server.registerTool('statement_consistency_review', {
  description: 'Check the balance-sheet equation, cash roll-forward, retained-earnings roll-forward, and pretax-to-net-income arithmetic using an explicit tolerance. This is not an audit opinion.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    totalAssets: decimalInput.optional(),
    totalLiabilities: decimalInput.optional(),
    totalEquity: decimalInput.optional(),
    cashBeginning: decimalInput.optional(),
    operatingCashFlow: decimalInput.optional(),
    investingCashFlow: decimalInput.optional(),
    financingCashFlow: decimalInput.optional(),
    foreignExchangeEffect: decimalInput.optional(),
    cashEnding: decimalInput.optional(),
    retainedEarningsBeginning: decimalInput.optional(),
    netIncome: decimalInput.optional(),
    dividends: decimalInput.optional(),
    retainedEarningsAdjustments: decimalInput.optional(),
    retainedEarningsEnding: decimalInput.optional(),
    pretaxIncome: decimalInput.optional(),
    incomeTaxExpense: decimalInput.optional(),
    reportedNetIncome: decimalInput.optional(),
    tolerance: decimalInput.optional().describe('Maximum absolute difference considered passed; default 0.01'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok('statement_consistency_review', args, reviewStatementConsistency(args)));

}
