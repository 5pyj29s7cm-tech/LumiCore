import { describe, expect, it } from 'vitest';
import {
  analyzeArApAging,
  buildEcommerceTaxWorkpaper,
  estimateTaxPosition,
  reviewVatInvoices,
} from '../server/skills/bundled/finance-office/logic';
import {
  analyzeCampaignRoi,
  analyzeOrderProfit,
  buildAfterSalesRiskReport,
  planInventoryRestock,
  reconcileSettlement,
} from '../server/skills/bundled/ecommerce-ops/logic';

describe('finance and tax skill logic', () => {
  it('reviews VAT invoice text into gross, net, and tax totals', () => {
    const report = reviewVatInvoices({
      invoiceText: 'INV-001 vendor A office supplies 1130 13%\nINV-002 vendor B service 560 6%',
      amountIncludesVat: true,
    });

    expect(report.invoiceCount).toBe(2);
    expect(report.totals.grossAmount).toBe(1690);
    expect(report.totals.vatAmount).toBe(161.7);
    expect(report.totalsByRate['13%'].count).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it('estimates tax position from user-provided rates and adjustments', () => {
    const report = estimateTaxPosition({
      revenue: 10000,
      deductibleCost: 4000,
      deductibleExpense: 2000,
      nonDeductibleExpense: 500,
      vatOutputTax: 1300,
      vatInputTax: 400,
      incomeTaxRate: 0.25,
      surchargeRate: 0.12,
    });

    expect(report.accountingProfit).toBe(4000);
    expect(report.taxableProfitEstimate).toBe(4500);
    expect(report.vatPayable).toBe(900);
    expect(report.estimatedIncomeTax).toBe(1125);
    expect(report.cashTaxEstimate).toBe(2133);
  });

  it('buckets receivables into aging ranges', () => {
    const report = analyzeArApAging({
      ledgerText: 'Customer A 3000 due 2026-03-01\nCustomer B 1000 due 2026-06-20',
      asOfDate: '2026-06-29',
    });

    expect(report.totalAmount).toBe(4000);
    expect(report.totalsByBucket['90+']).toBe(3000);
    expect(report.totalsByBucket['1-30']).toBe(1000);
    expect(report.riskFlags[0]).toContain('3000');
  });

  it('bridges e-commerce revenue to invoices and VAT workpapers', () => {
    const report = buildEcommerceTaxWorkpaper({
      period: '2026-06',
      platform: 'Shopify',
      orderRevenue: 10000,
      refunds: 1000,
      platformFees: 800,
      adSpend: 1200,
      freight: 500,
      cogs: 4500,
      invoiceIssuedAmount: 8500,
      vatOutputTax: 1105,
      vatInputTax: 400,
    });

    expect(report.revenueBridge.taxableRevenueCandidate).toBe(9000);
    expect(report.revenueBridge.grossProfitEstimate).toBe(2000);
    expect(report.invoiceBridge.invoiceGap).toBe(-500);
    expect(report.vatBridge.vatPayable).toBe(705);
    expect(report.riskFlags[0]).toContain('Invoice amount differs');
  });
});

describe('ecommerce operations skill logic', () => {
  it('analyzes SKU contribution profit and margin', () => {
    const report = analyzeOrderProfit({
      orderText: 'SKU-A sales 1200 cost 500 shipping 80 ads 120 fee 60 refund 0 units 10',
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].contributionProfit).toBe(440);
    expect(report.rows[0].contributionMargin).toBe(36.67);
    expect(report.summary.adCostRate).toBe(10);
  });

  it('marks inventory below reorder point as urgent', () => {
    const report = planInventoryRestock({
      inventoryText: 'SKU-A stock 50 daily 10 lead 7 safety 3',
      targetStockDays: 30,
    });

    expect(report.urgentSkus).toEqual(['SKU-A']);
    expect(report.rows[0].reorderPoint).toBe(100);
    expect(report.rows[0].suggestedOrderQty).toBe(350);
  });

  it('reconciles marketplace settlement statements against expected order net', () => {
    const report = reconcileSettlement({
      settlementText: 'payment 1000\nrefund 100\nplatform fee 50\nads 80\nshipping 30\nadjust compensation 10',
      expectedOrderRevenue: 1000,
      expectedRefunds: 100,
    });

    expect(report.settlementNet).toBe(750);
    expect(report.expectedNet).toBe(900);
    expect(report.gapToExpected).toBe(-150);
  });

  it('analyzes campaign ROI against margin-aware break-even', () => {
    const report = analyzeCampaignRoi({
      campaignText: 'Campaign-A spend 300 revenue 1500 orders 15 clicks 600 impressions 10000',
      grossMarginRate: 0.4,
    });

    expect(report.rows[0].roas).toBe(5);
    expect(report.rows[0].cpa).toBe(20);
    expect(report.rows[0].contributionAfterAds).toBe(300);
    expect(report.scaleCandidates).toEqual(['Campaign-A']);
  });

  it('parses Chinese ecommerce metrics and full-width separators without inventing rows', () => {
    const profit = analyzeOrderProfit({
      orderText: 'SKU-A \u9500\u552e\u989d1200 \u6210\u672c500 \u8fd0\u8d3980 \u5e7f\u544a120 \u5e73\u53f0\u8d3960 \u9000\u6b3e0 \u6570\u91cf10',
    });
    const campaigns = analyzeCampaignRoi({
      campaignText: '\u8ba1\u5212A \u5e7f\u544a\u8d39300 \u9500\u552e\u989d1500 \u8ba2\u535520 \u70b9\u51fb800 \u66dd\u514920000\uff1b\u8ba1\u5212B \u5e7f\u544a\u8d39200 \u9500\u552e\u989d300 \u8ba2\u53553',
      grossMarginRate: 0.4,
    });

    expect(profit.rows[0]).toMatchObject({
      sku: 'SKU-A',
      revenue: 1200,
      contributionProfit: 440,
    });
    expect(campaigns.rows).toHaveLength(2);
    expect(campaigns.rows[0]).toMatchObject({ campaign: 'A', roas: 5, cpa: 15 });
    expect(campaigns.rows[1]).toMatchObject({ campaign: 'B', status: 'trim_or_fix' });
  });

  it('surfaces high-risk after-sales SKUs and causes', () => {
    const report = buildAfterSalesRiskReport({
      afterSalesText: 'SKU-A orders 200 refunds 24 refundAmount 1200 complaints 6 quality',
      totalRevenue: 10000,
    });

    expect(report.rows[0].refundRate).toBe(12);
    expect(report.rows[0].cause).toBe('quality');
    expect(report.highRiskSkus).toEqual(['SKU-A']);
    expect(report.summary.refundAmountRate).toBe(12);
  });
});
