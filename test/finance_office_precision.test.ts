import { describe, expect, it } from 'vitest';
import {
  analyzeBudgetVariance,
  analyzeArApAging,
  analyzeFinancialRatios,
  estimateTaxPosition,
  forecastCashflow,
  reconcileLedgerEntries,
  reviewStatementConsistency,
  roundMoney,
} from '../server/skills/bundled/finance-office/logic';
import {
  createFinanceAuditReceipt,
  withFinanceAuditReceipt,
} from '../server/skills/bundled/finance-office/audit';

describe('finance-office decimal calculation policy', () => {
  it('rounds monetary values to two decimals with ROUND_HALF_UP', () => {
    expect(roundMoney('1.005')).toBe(1.01);
    expect(roundMoney('-1.005')).toBe(-1.01);
    expect(roundMoney('0.1')).toBe(0.1);
  });

  it('accepts base-10 decimal strings without accumulating binary float drift', () => {
    const forecast = forecastCashflow({
      openingCash: '0.10',
      receivables: '0.20',
      payables: '0.00',
      monthlyIncome: '0.105',
      monthlyExpense: '0.005',
      months: 2,
    });

    expect(forecast.forecast).toEqual([
      { month: 1, projectedCash: 0.4 },
      { month: 2, projectedCash: 0.5 },
    ]);
  });

  it('keeps tax calculations exact across string inputs and user-provided rates', () => {
    const report = estimateTaxPosition({
      revenue: '10000.10',
      deductibleCost: '4000.05',
      deductibleExpense: '2000.05',
      nonDeductibleExpense: '500.00',
      vatOutputTax: '1300.10',
      vatInputTax: '400.05',
      incomeTaxRate: '25%',
      surchargeRate: '12%',
    });

    expect(report.accountingProfit).toBe(4000);
    expect(report.taxableProfitEstimate).toBe(4500);
    expect(report.vatPayable).toBe(900.05);
    expect(report.estimatedIncomeTax).toBe(1125);
    expect(report.cashTaxEstimate).toBe(2133.06);
  });
});

describe('finance-office audit receipt', () => {
  it('records calculation policy and supplied field names without echoing private runtime fields', () => {
    const generatedAt = new Date('2026-08-09T12:00:00.000Z');
    const receipt = createFinanceAuditReceipt('cashflow_forecast', {
      openingCash: '100.00',
      monthlyIncome: '10.00',
      empty: '',
      _lumiScopeId: 'org:private',
    }, generatedAt);

    expect(receipt).toMatchObject({
      tool: 'cashflow_forecast',
      skillVersion: '1.5.0',
      generatedAt: '2026-08-09T12:00:00.000Z',
      sourceBasis: 'user_provided_inputs',
      inputFields: ['monthlyIncome', 'openingCash'],
      calculationPolicy: {
        engine: 'decimal.js',
        monetaryScale: 2,
        rounding: 'ROUND_HALF_UP',
      },
      reviewRequired: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('org:private');
  });

  it('attaches the receipt without replacing the calculation result', () => {
    const result = withFinanceAuditReceipt(
      'expense_summary',
      { expenseText: 'Taxi 10.10' },
      { total: 10.1 },
      new Date('2026-08-09T12:00:00.000Z'),
    );

    expect(result.total).toBe(10.1);
    expect(result.auditReceipt.tool).toBe('expense_summary');
  });
});

describe('finance-office deterministic analysis tools', () => {
  it('separates Chinese-punctuation receivable lines instead of merging counterparties and amounts', () => {
    const report = analyzeArApAging({
      ledgerText: '甲客户300000元到期2026-07-15，乙客户500000元到期2026-09-10',
      asOfDate: '2026-08-31',
      type: 'receivable',
      currency: 'CNY',
    });

    expect(report.totalAmount).toBe(800000);
    expect(report.rows).toEqual([
      expect.objectContaining({ counterparty: '甲客户', amount: 300000, dueDate: '2026-07-15', daysOverdue: 47, bucket: '31-60' }),
      expect.objectContaining({ counterparty: '乙客户', amount: 500000, dueDate: '2026-09-10', daysOverdue: -10, bucket: 'current' }),
    ]);
  });

  it('reconciles one-to-one entries and keeps ambiguous candidates for review', () => {
    const report = reconcileLedgerEntries({
      bookEntries: [
        { id: 'book-1', amount: '100.00', date: '2026-08-01', reference: 'ORDER-1' },
        { id: 'book-2', amount: '-20.00', date: '2026-08-02' },
      ],
      bankEntries: [
        { id: 'bank-1', amount: '100.00', date: '2026-08-02', reference: 'ORDER-1 receipt' },
        { id: 'bank-2', amount: '-20.00', date: '2026-08-02' },
        { id: 'bank-3', amount: '-20.00', date: '2026-08-03' },
      ],
      dateToleranceDays: 3,
    });

    expect(report.matched).toEqual([expect.objectContaining({ bookId: 'book-1', bankId: 'bank-1' })]);
    expect(report.ambiguous).toEqual([expect.objectContaining({
      bookId: 'book-2',
      candidateBankIds: ['bank-2', 'bank-3'],
    })]);
    expect(report.status).toBe('needs_review');
  });

  it('calculates ratios without manufacturing values for missing or zero denominators', () => {
    const report = analyzeFinancialRatios({
      revenue: '1000',
      costOfRevenue: '600',
      operatingIncome: '150',
      netIncome: '100',
      totalAssets: '0',
      totalLiabilities: '500',
      equity: '500',
      operatingCashFlow: '125',
    });

    expect(report.metrics.find(item => item.name === 'gross_margin')?.value).toBe(40);
    expect(report.metrics.find(item => item.name === 'operating_cash_conversion')?.value).toBe(1.25);
    expect(report.metrics.find(item => item.name === 'return_on_assets')?.value).toBeNull();
  });

  it('uses favorable-sign variance consistently for revenue and expense lines', () => {
    const report = analyzeBudgetVariance({
      lines: [
        { category: 'Sales', kind: 'revenue', budget: '1000', actual: '1100' },
        { category: 'Marketing', kind: 'expense', budget: '200', actual: '250' },
      ],
      materialityPercent: 5,
      materialityAmount: '10',
    });

    expect(report.rows).toEqual([
      expect.objectContaining({ category: 'Sales', favorableVariance: 100, assessment: 'favorable' }),
      expect.objectContaining({ category: 'Marketing', favorableVariance: -50, assessment: 'unfavorable' }),
    ]);
    expect(report.totals.favorableOperatingVariance).toBe(50);
  });

  it('does not flag a zero-budget, zero-actual line as a material variance', () => {
    const report = analyzeBudgetVariance({
      lines: [{ category: 'New initiative', kind: 'expense', budget: '0', actual: '0' }],
    });
    expect(report.rows[0]).toMatchObject({ favorableVariance: 0, material: false });
    expect(report.reviewRequired).toBe(false);
  });

  it('distinguishes failed arithmetic from checks that lack source fields', () => {
    const report = reviewStatementConsistency({
      totalAssets: '1000.02',
      totalLiabilities: '600',
      totalEquity: '400',
      cashBeginning: '100',
      operatingCashFlow: '20',
      investingCashFlow: '-10',
      financingCashFlow: '0',
      foreignExchangeEffect: '0',
      cashEnding: '110',
      tolerance: '0.01',
    });

    expect(report.checks.find(item => item.id === 'balance_sheet_equation')?.status).toBe('failed');
    expect(report.checks.find(item => item.id === 'cash_flow_rollforward')?.status).toBe('passed');
    expect(report.checks.find(item => item.id === 'retained_earnings_rollforward')?.status).toBe('not_evaluated');
  });
});
