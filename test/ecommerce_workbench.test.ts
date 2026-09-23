import { describe, expect, it } from 'vitest';
import {
  analyzeEcommerceWorkbench,
  getEcommerceFieldDefinitions,
  parseDelimitedReport,
  parseReviewPaste,
  suggestEcommerceColumnMapping,
  tableFromMatrix,
} from '../shared/ecommerce_workbench';
import { buildEcommerceTemplateCsv, getEcommercePlatformPreset } from '../shared/ecommerce_platform_presets';

describe('ecommerce workbench report ingestion', () => {
  it('parses quoted CSV cells and preserves embedded delimiters', () => {
    const table = parseDelimitedReport('订单号,SKU,销售额,备注\n1,"SKU,A",1200,"首单,已支付"');

    expect(table.headers).toEqual(['订单号', 'SKU', '销售额', '备注']);
    expect(table.rows[0]).toMatchObject({ SKU: 'SKU,A', 备注: '首单,已支付' });
  });

  it('accepts spreadsheet matrices with numeric cell values', () => {
    const table = tableFromMatrix([
      ['SKU', '可售库存', '日均销量'],
      ['SKU-A', 50, 10],
    ]);

    expect(table.rows[0]).toEqual({ SKU: 'SKU-A', 可售库存: 50, 日均销量: 10 });
  });

  it('provides platform templates and suggested field mappings', () => {
    const table = parseDelimitedReport('主订单编号,商家编码,实付金额,商品成本\n1,SKU-A,1200,500');
    const mapping = suggestEcommerceColumnMapping('orders', table);

    expect(getEcommercePlatformPreset('douyin').label).toContain('抖店');
    expect(buildEcommerceTemplateCsv('shopify', 'orders')).toContain('net sales');
    expect(mapping).toMatchObject({ orderId: '主订单编号', sku: '商家编码', revenue: '实付金额', cogs: '商品成本' });
    expect(getEcommerceFieldDefinitions('orders').find(item => item.field === 'revenue')?.recommended).toBe(true);
    expect(buildEcommerceTemplateCsv('taobao', 'reviews')).toContain('评价内容');
  });
});

describe('ecommerce workbench analysis', () => {
  it('combines order, campaign, inventory, and after-sales exports', () => {
    const snapshot = analyzeEcommerceWorkbench({
      orders: parseDelimitedReport([
        '订单号,SKU,销售额,商品成本,运费,平台费,广告费,退款金额,件数',
        '1,SKU-A,1200,500,80,60,120,0,10',
        '2,SKU-B,800,500,50,40,0,100,5',
      ].join('\n')),
      campaigns: parseDelimitedReport([
        '计划名称,消耗,成交金额,订单数',
        'Campaign-A,300,1500,15',
        'Campaign-B,200,300,3',
      ].join('\n')),
      inventory: parseDelimitedReport([
        'SKU,可售库存,日均销量,采购周期,安全库存天数',
        'SKU-A,50,10,7,3',
        'SKU-B,500,5,7,3',
      ].join('\n')),
      afterSales: parseDelimitedReport([
        'SKU,订单数,退款单数,退款金额,投诉数',
        'SKU-A,200,24,1200,6',
      ].join('\n')),
    });

    expect(snapshot.metrics).toMatchObject({
      gmv: 2000,
      netRevenue: 1900,
      contributionProfit: 550,
      contributionMargin: 28.95,
      adSpend: 500,
      roas: 3.6,
      refundRate: 12,
      orderCount: 2,
    });
    expect(snapshot.topSkus[0]).toMatchObject({ sku: 'SKU-A', contributionProfit: 440 });
    expect(snapshot.campaigns.map(item => [item.campaign, item.status])).toEqual([
      ['Campaign-A', 'scale'],
      ['Campaign-B', 'fix'],
    ]);
    expect(snapshot.inventoryAlerts[0]).toMatchObject({
      sku: 'SKU-A',
      status: 'urgent',
      reorderPoint: 100,
      suggestedOrderQty: 350,
    });
    expect(snapshot.risks.map(risk => risk.code)).toEqual(expect.arrayContaining(['high_refund', 'urgent_restock']));
  });

  it('flags revenue rows whose cost field is unavailable', () => {
    const snapshot = analyzeEcommerceWorkbench({
      orders: parseDelimitedReport('订单号,SKU,销售额\n1,SKU-A,1200\n2,SKU-B,800'),
    });

    expect(snapshot.sources[0].missingRecommendedFields).toContain('cogs');
    expect(snapshot.risks[0]).toMatchObject({ code: 'missing_cost', severity: 'high', value: 2 });
  });

  it('honors manual field mapping and calculation assumptions', () => {
    const orders = parseDelimitedReport('货品,回款,进价\nSKU-X,1000,400');
    const inventory = parseDelimitedReport('货品,仓库数量,每天卖出\nSKU-X,20,10');
    const snapshot = analyzeEcommerceWorkbench({ orders, inventory }, {
      grossMarginRate: 0.5,
      targetStockDays: 14,
      columnMappings: {
        orders: { sku: '货品', revenue: '回款', cogs: '进价' },
        inventory: { sku: '货品', stock: '仓库数量', dailySales: '每天卖出' },
      },
    });

    expect(snapshot.metrics).toMatchObject({ gmv: 1000, contributionProfit: 600 });
    expect(snapshot.topSkus[0].sku).toBe('SKU-X');
    expect(snapshot.inventoryAlerts[0]).toMatchObject({ sku: 'SKU-X', suggestedOrderQty: 220 });
    expect(snapshot.assumptions).toEqual({ grossMarginRate: 0.5, targetStockDays: 14 });
  });

  it('analyzes review sentiment, ratings, topics, and negative-review risk', () => {
    const snapshot = analyzeEcommerceWorkbench({
      reviews: parseDelimitedReport([
        'SKU,评价内容,评分,评价时间',
        'SKU-A,"质量很好，物流很快",5,2026-08-01',
        'SKU-A,"尺寸偏小，与描述不符",2,2026-08-02',
        'SKU-B,"客服不回复，包装破损，联系 13800138000",1,2026-08-03',
        'SKU-B,"一般",3,2026-08-04',
      ].join('\n')),
    });

    expect(snapshot.reviewInsights).toMatchObject({
      totalReviews: 4,
      averageRating: 2.75,
      positiveRate: 25,
      neutralRate: 25,
      negativeRate: 50,
      positiveCount: 1,
      neutralCount: 1,
      negativeCount: 2,
    });
    expect(snapshot.reviewInsights.topics.map(topic => topic.topic)).toEqual(expect.arrayContaining([
      'quality', 'fit', 'logistics', 'listing_mismatch', 'service', 'packaging',
    ]));
    expect(snapshot.reviewInsights.negativeSamples).toHaveLength(2);
    expect(snapshot.reviewInsights.negativeSamples[1].content).toContain('[phone]');
    expect(snapshot.reviewInsights.negativeSamples[1].content).not.toContain('13800138000');
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ code: 'negative_reviews', severity: 'high', value: 50 }));
  });

  it('classifies one-comment-per-row matrices without a rating column', () => {
    const reviews = parseReviewPaste('很喜欢，值得推荐\n物流太慢，收到时包装破损\n一般');
    const snapshot = analyzeEcommerceWorkbench({ reviews });

    expect(snapshot.reviewInsights).toMatchObject({ totalReviews: 3, positiveCount: 1, neutralCount: 1, negativeCount: 1 });
    expect(snapshot.reviewInsights.averageRating).toBeNull();
    expect(snapshot.reviewInsights.topics.map(topic => topic.topic)).toEqual(expect.arrayContaining(['logistics', 'packaging']));
  });
});
