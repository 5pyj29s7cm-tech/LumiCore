import { describe, expect, it } from 'vitest';
import { bindIndustrySourceArguments, parseEcommerceTodaySource } from '../server/industry/source_bound_arguments';
import {
  analyzeCampaignRoi,
  analyzeOrderProfit,
  buildAfterSalesRiskReport,
} from '../server/skills/bundled/ecommerce-ops/logic';

const context = {
  industryWorkflowProductLine: 'ecommerce',
  industryWorkflowEntryId: 'today-operations',
  industryWorkflowSourceInput: [
    '销售额：120000元',
    '订单：600单',
    '广告花费：18000元',
    '商品成本：54000元',
    '平台及物流成本：12000元',
    '退款：9000元',
  ].join('\n'),
} as any;

describe('digest-bound industry source arguments', () => {
  it('keeps exact operating amounts in their intended profit buckets', () => {
    const args = bindIndustrySourceArguments(
      'business_ecommerce_ecommerce_order_profit',
      { orderText: 'corrupted model paraphrase' },
      context,
    );
    expect(args.orderText).toBe(
      'All-store revenue 120000 cogs 54000 shipping 12000 ad spend 18000 refund 9000 units 600',
    );
  });

  it('keeps refund amount separate from refund count', () => {
    const args = bindIndustrySourceArguments(
      'business_ecommerce_after_sales_risk_report',
      { afterSalesText: 'All-store refunds 9000' },
      context,
    );
    expect(args).toMatchObject({
      afterSalesText: 'All-store orders 600 refund amount 9000',
      totalOrders: 600,
      totalRevenue: 120000,
    });
    expect(args.afterSalesText).not.toContain('refunds 9000');
  });

  it('does not rewrite tools outside the exact bound workflow', () => {
    const requested = { afterSalesText: 'original' };
    expect(bindIndustrySourceArguments(
      'business_ecommerce_after_sales_risk_report',
      requested,
      { ...context, industryWorkflowEntryId: 'store-data' },
    )).toBe(requested);
  });

  it('binds listing inventory facts without turning a refund count into money', () => {
    const listingContext = {
      industryWorkflowProductLine: 'ecommerce',
      industryWorkflowEntryId: 'listing-automation',
      industryWorkflowSourceInput: [
        'SKU：A001',
        '\u5e93\u5b58\uff1a420\u4ef6',
        '\u65e5\u5747\u9500\u91cf\uff1a18\u4ef6',
        '\u4f9b\u5e94\u5546\u4ea4\u671f\uff1a12\u5929',
        '\u5b89\u5168\u5e93\u5b58\uff1a7\u5929',
        '\u9000\u6b3e\uff1a31\u5355',
      ].join('\n'),
    } as any;

    const args = bindIndustrySourceArguments(
      'business_ecommerce_inventory_restock_plan',
      { inventoryText: 'model changed the numbers' },
      listingContext,
    );
    expect(args.inventoryText).toBe('A001 stock 420 daily 18 lead 12 safety 7');

    const requestedProfit = { orderText: 'refund 31' };
    expect(bindIndustrySourceArguments(
      'business_ecommerce_ecommerce_order_profit',
      requestedProfit,
      listingContext,
    )).toBe(requestedProfit);
  });

  it('binds every labelled listing fact and preserves unknown product identity', () => {
    const listingContext = {
      industryWorkflowProductLine: 'ecommerce',
      industryWorkflowEntryId: 'listing-automation',
      industryWorkflowSourceInput: [
        'SKU-A',
        '\u5e73\u53f0\u6296\u97f3\u5c0f\u5e97',
        '\u5e93\u5b585\u4ef6\uff0c\u65e5\u5747\u9500\u91cf2\u4ef6\uff0c\u4f9b\u5e94\u5546\u4ea4\u671f7\u5929\uff0c\u5b89\u5168\u5e93\u5b583\u5929',
        '\u552e\u4ef7199\u5143\uff0c\u5546\u54c1\u6210\u672c90\u5143\uff0c\u7269\u6d4110\u5143\uff0c\u5e73\u53f0\u8d39\u73875%',
        '\u8fd130\u592920\u5355\uff0c\u9000\u6b3e4\u5355\uff0c\u9000\u6b3e\u539f\u56e0\u4e3b\u8981\u662f\u201c\u62bd\u5c49\u5361\u987f\u201d',
        '\u5408\u89c4\u8bc1\u660e\u548c\u8d28\u68c0\u6279\u6b21\u53f7\u672a\u63d0\u4f9b',
      ].join('\n'),
    } as any;

    expect(bindIndustrySourceArguments(
      'business_ecommerce_inventory_restock_plan', {}, listingContext,
    ).inventoryText).toBe('SKU-A stock 5 daily 2 lead 7 safety 3');
    expect(bindIndustrySourceArguments(
      'business_ecommerce_ecommerce_order_profit', {}, listingContext,
    ).orderText).toBe('SKU-A revenue 3980 cogs 1800 shipping 200 platform fee 199 units 20');
    expect(bindIndustrySourceArguments(
      'business_ecommerce_after_sales_risk_report', {}, listingContext,
    )).toMatchObject({ afterSalesText: 'SKU-A orders 20 refunds 4 \u62bd\u5c49\u5361\u987f', totalOrders: 20 });
    expect(bindIndustrySourceArguments(
      'business_ecommerce_product_listing_optimizer', { productName: '\u684c\u9762\u6536\u7eb3\u76d2' }, listingContext,
    )).toMatchObject({
      productName: 'SKU-A (product name unknown)',
      platform: '\u6296\u97f3\u5c0f\u5e97',
      priceRange: '199',
    });
  });

  it('produces consistent profit, ROI, and refund-amount results end to end', () => {
    const profitArgs = bindIndustrySourceArguments(
      'business_ecommerce_ecommerce_order_profit', {}, context,
    );
    const campaignArgs = bindIndustrySourceArguments(
      'business_ecommerce_campaign_roi_analyzer', {}, context,
    );
    const afterSalesArgs = bindIndustrySourceArguments(
      'business_ecommerce_after_sales_risk_report', {}, context,
    );

    expect(analyzeOrderProfit(profitArgs).summary).toMatchObject({
      revenue: 120000,
      refunds: 9000,
      netRevenue: 111000,
      cogs: 54000,
      shipping: 12000,
      adSpend: 18000,
      contributionProfit: 27000,
      contributionMargin: 24.32,
    });
    expect(analyzeCampaignRoi(campaignArgs).summary).toMatchObject({
      spend: 18000,
      revenue: 120000,
      orders: 600,
      roas: 6.67,
      cpa: 30,
    });
    expect(buildAfterSalesRiskReport(afterSalesArgs).summary).toMatchObject({
      totalOrders: 600,
      totalRefundCount: 0,
      totalRefundAmount: 9000,
      refundRate: null,
      refundAmountRate: 7.5,
    });
  });

  it('never turns revenue into COGS or ad spend into shipping when costs are missing', () => {
    const source = '请为“稳定性验收店”执行今日经营分析。数据期间是2026年8月15日，币种CNY：订单120单，销售额36000元，广告花费7200元，退款金额3600元，售后8单；SKU-A库存6件，SKU-B库存80件。';
    const incompleteContext = {
      industryWorkflowProductLine: 'ecommerce',
      industryWorkflowEntryId: 'today-operations',
      industryWorkflowSourceInput: source,
    } as any;
    expect(parseEcommerceTodaySource(source)).toMatchObject({
      revenue: 36000,
      orders: 120,
      adSpend: 7200,
      refundAmount: 3600,
      afterSalesCount: 8,
      reportingPeriod: '2026-08-15',
      currency: 'CNY',
      inventory: [
        { sku: 'SKU-A', stock: 6 },
        { sku: 'SKU-B', stock: 80 },
      ],
    });
    expect(parseEcommerceTodaySource(source).cogs).toBeUndefined();
    expect(parseEcommerceTodaySource(source).shipping).toBeUndefined();
    expect(() => bindIndustrySourceArguments(
      'business_ecommerce_ecommerce_order_profit',
      { orderText: 'revenue 36000 cogs 36000 shipping 7200' },
      incompleteContext,
    )).toThrow(/missing COGS/i);
    expect(bindIndustrySourceArguments(
      'business_ecommerce_campaign_roi_analyzer',
      { campaignText: 'wrong' },
      incompleteContext,
    )).toEqual({ campaignText: 'All-store spend 7200 revenue 36000 orders 120' });
  });

  it('parses a labelled compact Chinese inventory list without dropping SKUs', () => {
    const source = '\u5e97\u94fa\uff1a\u7a33\u5b9a\u6027\u9a8c\u6536\u5e97\uff1b\u9500\u552e\u989d\uff1a120000\u5143\uff1b\u8ba2\u5355\uff1a600\u5355\uff1b\u5e93\u5b58\uff1aSKU-A 8\u4ef6\uff0cSKU-B 120\u4ef6\u3002';
    expect(parseEcommerceTodaySource(source).inventory).toEqual([
      { sku: 'SKU-A', stock: 8 },
      { sku: 'SKU-B', stock: 120 },
    ]);
  });
});
