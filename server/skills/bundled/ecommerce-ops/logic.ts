export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toRate(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(n)) return fallback;
  return n > 1 ? n / 100 : n;
}

function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

function extractNumbers(text: string): number[] {
  return Array.from(text.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)).map(m => Number(m[0].replace(/,/g, '')));
}

function firstMetric(line: string, labels: RegExp[]): number | undefined {
  const normalized = line.replace(/,/g, '');
  for (const label of labels) {
    const match = normalized.match(new RegExp(`(?:${label.source})\\s*[:=：]?\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
    if (match) return Number(match[1]);
  }
  return undefined;
}

function skuFromLine(line: string, index: number): string {
  const firstToken = line.trim().split(/[\s,;\uFF0C\uFF1B\t]+/)[0];
  if (/^[\p{L}\p{N}][\p{L}\p{N}._-]+$/u.test(firstToken)
    && !/^(sku|spu|item|\u5546\u54C1|\u8D27\u53F7|\u6B3E\u53F7)$/iu.test(firstToken)) {
    return firstToken;
  }
  const explicit = line.match(/(?:sku|spu|item|\u5546\u54C1|\u8D27\u53F7|\u6B3E\u53F7)\s*[:=\uFF1A]?\s*([\p{L}\p{N}._-]+)/iu);
  if (explicit) return explicit[1];
  const firstPart = line.split(/[,;\uFF0C\uFF1B\t]/)[0]?.trim();
  return firstPart ? firstPart.slice(0, 60) : `item-${index + 1}`;
}

export function buildListingOptimizer(args: {
  productName?: string;
  platform?: string;
  audience?: string;
  keywords?: string | string[];
  differentiators?: string | string[];
  priceRange?: string;
  constraints?: string;
}) {
  const productName = args.productName || 'Product';
  const platform = args.platform || 'marketplace';
  const audience = args.audience || 'target shoppers';
  const keywords = splitList(args.keywords);
  const differentiators = splitList(args.differentiators);
  const topKeywords = keywords.slice(0, 5);
  const topDiffs = differentiators.slice(0, 4);
  const benefit = topDiffs[0] || topKeywords[0] || 'core benefit';

  return {
    productName,
    platform,
    audience,
    titleOptions: [
      [productName, benefit, topKeywords[0]].filter(Boolean).join(' | '),
      [productName, topKeywords.slice(0, 2).join(' '), args.priceRange].filter(Boolean).join(' - '),
      `${productName} for ${audience}${topKeywords[0] ? `, ${topKeywords[0]}` : ''}`,
    ],
    sellingPoints: [
      `Lead with the shopper problem and the strongest proof for ${benefit}.`,
      ...topDiffs.map(item => `Turn "${item}" into one concrete benefit with a use case.`),
      'State package contents, size/spec, compatibility, and after-sales terms plainly.',
    ].slice(0, 6),
    searchKeywords: topKeywords,
    imageShotList: [
      'Main image: product clear, full item visible, clean background.',
      'Use-scene image: show the product solving the shopper problem.',
      'Detail image: material, size, interface, ingredients, or craftsmanship.',
      'Comparison/spec image: clarify what is included and what is not.',
      'Trust image: warranty, certification, reviews, or service promise when verifiable.',
    ],
    complianceChecks: [
      'Avoid unverifiable absolute claims such as best, cure, guaranteed, official, or lowest price.',
      'Check restricted words, category rules, trademark usage, and ad-law sensitive claims for the platform.',
      'Do not imply certifications, medical effects, origin, or authorization unless source proof exists.',
    ],
    constraints: args.constraints || '',
  };
}

export interface OrderMetricRow {
  sku: string;
  revenue: number;
  cogs: number;
  shipping: number;
  platformFees: number;
  adSpend: number;
  refunds: number;
  otherCost: number;
  units: number;
}

export function parseOrderRows(orderText: string, defaults: {
  platformFeeRate?: number;
  adCostRate?: number;
} = {}): OrderMetricRow[] {
  const platformFeeRate = toRate(defaults.platformFeeRate);
  const adCostRate = toRate(defaults.adCostRate);
  return String(orderText || '').split(/\r?\n|;|\uFF1B/).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const nums = extractNumbers(text);
    const revenue = firstMetric(text, [/gmv|revenue|sales|amount|销售额|成交额|收入|实收|货款/]) ?? nums[0] ?? 0;
    const cogs = firstMetric(text, [/cogs|cost|成本|采购|进货/]) ?? nums[1] ?? 0;
    const shipping = firstMetric(text, [/shipping|freight|物流|运费|快递/]) ?? nums[2] ?? 0;
    const platformFees = firstMetric(text, [/fee|commission|平台费|佣金|服务费|技术服务/]) ?? (revenue * platformFeeRate);
    const adSpend = firstMetric(text, [/\bads?\b|\bad.spend\b|marketing|广告|投流|推广/]) ?? (revenue * adCostRate);
    const refunds = firstMetric(text, [/refund|return|退款|退货|售后/]) ?? 0;
    const otherCost = firstMetric(text, [/other|misc|其他|包装|赠品|达人/]) ?? 0;
    const units = firstMetric(text, [/units|qty|quantity|件数|数量|单量|销量/]) ?? 1;
    return {
      sku: skuFromLine(text, index),
      revenue: roundMoney(revenue),
      cogs: roundMoney(cogs),
      shipping: roundMoney(shipping),
      platformFees: roundMoney(platformFees),
      adSpend: roundMoney(adSpend),
      refunds: roundMoney(refunds),
      otherCost: roundMoney(otherCost),
      units: Math.max(1, Math.round(units)),
    };
  }).filter((row): row is OrderMetricRow => Boolean(row));
}

export function analyzeOrderProfit(args: {
  orderText?: string;
  currency?: string;
  defaultPlatformFeeRate?: number;
  defaultAdCostRate?: number;
}) {
  const rows = parseOrderRows(String(args.orderText || ''), {
    platformFeeRate: args.defaultPlatformFeeRate,
    adCostRate: args.defaultAdCostRate,
  }).map(row => {
    const netRevenue = row.revenue - row.refunds;
    const contributionProfit = netRevenue - row.cogs - row.shipping - row.platformFees - row.adSpend - row.otherCost;
    const margin = netRevenue > 0 ? contributionProfit / netRevenue : 0;
    return {
      ...row,
      netRevenue: roundMoney(netRevenue),
      contributionProfit: roundMoney(contributionProfit),
      contributionMargin: roundMoney(margin * 100),
      adCostRate: netRevenue > 0 ? roundMoney(row.adSpend / netRevenue * 100) : 0,
      breakEvenAdSpend: roundMoney(Math.max(netRevenue - row.cogs - row.shipping - row.platformFees - row.otherCost, 0)),
    };
  });

  const summary = rows.reduce((acc, row) => {
    acc.revenue += row.revenue;
    acc.refunds += row.refunds;
    acc.netRevenue += row.netRevenue;
    acc.cogs += row.cogs;
    acc.shipping += row.shipping;
    acc.platformFees += row.platformFees;
    acc.adSpend += row.adSpend;
    acc.otherCost += row.otherCost;
    acc.contributionProfit += row.contributionProfit;
    acc.units += row.units;
    return acc;
  }, {
    revenue: 0,
    refunds: 0,
    netRevenue: 0,
    cogs: 0,
    shipping: 0,
    platformFees: 0,
    adSpend: 0,
    otherCost: 0,
    contributionProfit: 0,
    units: 0,
  });
  for (const key of Object.keys(summary) as Array<keyof typeof summary>) {
    summary[key] = roundMoney(summary[key]);
  }

  const flags = [
    ...rows.filter(row => row.contributionProfit < 0).map(row => `${row.sku}: contribution profit is negative.`),
    ...rows.filter(row => row.netRevenue > 0 && row.adSpend / row.netRevenue > 0.3).map(row => `${row.sku}: ad spend is above 30% of net revenue.`),
    ...rows.filter(row => row.netRevenue > 0 && row.refunds / row.revenue > 0.1).map(row => `${row.sku}: refunds exceed 10% of revenue.`),
  ];

  return {
    currency: args.currency || 'CNY',
    rows,
    summary: {
      ...summary,
      contributionMargin: summary.netRevenue > 0 ? roundMoney(summary.contributionProfit / summary.netRevenue * 100) : 0,
      adCostRate: summary.netRevenue > 0 ? roundMoney(summary.adSpend / summary.netRevenue * 100) : 0,
    },
    flags,
    nextActions: [
      'Check negative-margin SKUs before scaling ads or discounts.',
      'Reconcile platform fees, refunds, freight, and ad spend to platform statements.',
      'Split profit by SKU, channel, campaign, and fulfillment method before making budget decisions.',
    ],
  };
}

export interface InventoryRow {
  sku: string;
  stock: number;
  dailySales: number;
  leadTimeDays: number;
  safetyStockDays: number;
}

export function parseInventoryRows(inventoryText: string, defaults: {
  leadTimeDays?: number;
  safetyStockDays?: number;
} = {}): InventoryRow[] {
  return String(inventoryText || '').split(/\r?\n|;|\uFF1B/).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const nums = extractNumbers(text);
    const stock = firstMetric(text, [/stock|inventory|on.hand|库存|现货|可售/]) ?? nums[0] ?? 0;
    const dailySales = firstMetric(text, [/daily|velocity|日销|日均|每天|每日/]) ?? nums[1] ?? 0;
    const leadTimeDays = firstMetric(text, [/lead|arrival|采购周期|备货周期|到货|交期/]) ?? toNumber(defaults.leadTimeDays, nums[2] ?? 7);
    const safetyStockDays = firstMetric(text, [/safety|buffer|安全库存|安全天数/]) ?? toNumber(defaults.safetyStockDays, nums[3] ?? 3);
    return {
      sku: skuFromLine(text, index),
      stock: roundMoney(stock),
      dailySales: roundMoney(dailySales),
      leadTimeDays: Math.max(0, roundMoney(leadTimeDays)),
      safetyStockDays: Math.max(0, roundMoney(safetyStockDays)),
    };
  }).filter((row): row is InventoryRow => Boolean(row));
}

export function planInventoryRestock(args: {
  inventoryText?: string;
  targetStockDays?: number;
  defaultLeadTimeDays?: number;
  defaultSafetyStockDays?: number;
}) {
  const targetStockDays = Math.max(1, toNumber(args.targetStockDays, 30));
  const rows = parseInventoryRows(String(args.inventoryText || ''), {
    leadTimeDays: args.defaultLeadTimeDays,
    safetyStockDays: args.defaultSafetyStockDays,
  }).map(row => {
    const daysCover = row.dailySales > 0 ? row.stock / row.dailySales : Infinity;
    const reorderPoint = row.dailySales * (row.leadTimeDays + row.safetyStockDays);
    const targetStock = row.dailySales * (row.leadTimeDays + row.safetyStockDays + targetStockDays);
    const suggestedOrderQty = Math.max(targetStock - row.stock, 0);
    return {
      ...row,
      daysCover: Number.isFinite(daysCover) ? roundMoney(daysCover) : null,
      reorderPoint: roundMoney(reorderPoint),
      targetStock: roundMoney(targetStock),
      suggestedOrderQty: roundMoney(suggestedOrderQty),
      status: row.dailySales <= 0
        ? 'no_velocity'
        : row.stock <= reorderPoint
          ? 'reorder_now'
          : daysCover <= row.leadTimeDays + row.safetyStockDays + 7
            ? 'watch'
            : 'healthy',
    };
  });

  return {
    targetStockDays,
    rows,
    urgentSkus: rows.filter(row => row.status === 'reorder_now').map(row => row.sku),
    reviewNotes: [
      'Check seasonality, campaign calendar, supplier MOQ, cash constraints, and warehouse capacity before placing orders.',
      'Use paid orders or shipped orders consistently; mixing metrics will distort velocity.',
      'Separate slow-moving stock from out-of-stock risk before discounting.',
    ],
  };
}

function sumLabeledAmounts(text: string, labels: RegExp[]): number {
  let total = 0;
  for (const line of String(text || '').split(/\r?\n|;|\uFF1B/)) {
    if (!labels.some(label => label.test(line))) continue;
    total += extractNumbers(line).slice(-1)[0] || 0;
  }
  return total;
}

export function reconcileSettlement(args: {
  settlementText?: string;
  expectedOrderRevenue?: number;
  expectedRefunds?: number;
  currency?: string;
}) {
  const text = String(args.settlementText || '');
  const grossPayments = sumLabeledAmounts(text, [/payment|paid|receipt|收款|结算收入|货款|成交/]);
  const refunds = sumLabeledAmounts(text, [/refund|return|退款|退货|售后/]) || toNumber(args.expectedRefunds);
  const platformFees = sumLabeledAmounts(text, [/fee|commission|平台费|佣金|服务费|技术服务/]);
  const adSpend = sumLabeledAmounts(text, [/\bads?\b|\bad.spend\b|广告|投流|推广/]);
  const shipping = sumLabeledAmounts(text, [/shipping|freight|物流|运费|快递/]);
  const adjustments = sumLabeledAmounts(text, [/adjust|补差|调整|赔付|罚款|扣款/]);
  const settlementNet = grossPayments - refunds - platformFees - adSpend - shipping + adjustments;
  const expectedNet = toNumber(args.expectedOrderRevenue) - toNumber(args.expectedRefunds);

  return {
    currency: args.currency || 'CNY',
    grossPayments: roundMoney(grossPayments),
    refunds: roundMoney(refunds),
    platformFees: roundMoney(platformFees),
    adSpend: roundMoney(adSpend),
    shipping: roundMoney(shipping),
    adjustments: roundMoney(adjustments),
    settlementNet: roundMoney(settlementNet),
    expectedNet: args.expectedOrderRevenue === undefined ? null : roundMoney(expectedNet),
    gapToExpected: args.expectedOrderRevenue === undefined ? null : roundMoney(settlementNet - expectedNet),
    checklist: [
      'Match settlement period to order paid/shipped/refunded dates.',
      'Separate platform commission, payment fee, ad spend, freight, penalties, compensation, and coupons.',
      'Tie settlement net to bank receipts and ledger entries.',
      'Keep platform statement, order export, invoice list, and refund evidence together for tax and audit review.',
    ],
  };
}

function rowName(line: string, index: number): string {
  const firstToken = line.trim().split(/[\s,;\uFF0C\uFF1B\t]+/)[0];
  if (/^(?:campaign|ad.?group)[-_.][\p{L}\p{N}._-]+$/iu.test(firstToken)) return firstToken;
  const explicit = line.match(/(?:campaign|ad.?group|\u8BA1\u5212|\u5E7F\u544A\u7EC4)\s*[:=\uFF1A]?\s*([^\s,;\uFF0C\uFF1B:\uFF1A]+)/i);
  if (explicit?.[1]) return explicit[1];
  return skuFromLine(line, index);
}

export function analyzeCampaignRoi(args: {
  campaignText?: string;
  currency?: string;
  grossMarginRate?: number;
  targetRoas?: number;
}) {
  const grossMarginRate = toRate(args.grossMarginRate, 0.35);
  const targetRoas = Math.max(toNumber(args.targetRoas, grossMarginRate > 0 ? 1 / grossMarginRate : 3), 0);
  const rows = String(args.campaignText || '').split(/\r?\n|;|\uFF1B/).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const nums = extractNumbers(text);
    const spend = firstMetric(text, [/\bad.?spend\b|\bspend\b|\bcost\b|广告费|消耗|投放|花费/]) ?? nums[0] ?? 0;
    const revenue = firstMetric(text, [/gmv|revenue|sales|turnover|销售额|成交额|收入/]) ?? nums[1] ?? 0;
    const orders = firstMetric(text, [/orders?|conversions?|purchases?|订单|成交单|转化/]) ?? nums[2] ?? 0;
    const clicks = firstMetric(text, [/clicks?|点击/]) ?? 0;
    const impressions = firstMetric(text, [/impressions?|views?|曝光|展现/]) ?? 0;
    const roas = spend > 0 ? revenue / spend : 0;
    const contributionAfterAds = revenue * grossMarginRate - spend;
    return {
      campaign: rowName(text, index),
      spend: roundMoney(spend),
      revenue: roundMoney(revenue),
      orders: Math.max(0, Math.round(orders)),
      clicks: Math.max(0, Math.round(clicks)),
      impressions: Math.max(0, Math.round(impressions)),
      roas: roundMoney(roas),
      cpa: orders > 0 ? roundMoney(spend / orders) : null,
      aov: orders > 0 ? roundMoney(revenue / orders) : null,
      cpc: clicks > 0 ? roundMoney(spend / clicks) : null,
      conversionRate: clicks > 0 ? roundMoney(orders / clicks * 100) : null,
      contributionAfterAds: roundMoney(contributionAfterAds),
      status: contributionAfterAds < 0 || roas < targetRoas * 0.85
        ? 'trim_or_fix'
        : roas >= targetRoas * 1.2
          ? 'scale_candidate'
          : 'watch',
    };
  }).filter((row): row is NonNullable<typeof row> => Boolean(row));

  const summary = rows.reduce((acc, row) => {
    acc.spend += row.spend;
    acc.revenue += row.revenue;
    acc.orders += row.orders;
    acc.clicks += row.clicks;
    acc.impressions += row.impressions;
    acc.contributionAfterAds += row.contributionAfterAds;
    return acc;
  }, { spend: 0, revenue: 0, orders: 0, clicks: 0, impressions: 0, contributionAfterAds: 0 });

  return {
    currency: args.currency || 'CNY',
    assumptions: { grossMarginRate, targetRoas },
    rows,
    summary: {
      spend: roundMoney(summary.spend),
      revenue: roundMoney(summary.revenue),
      orders: summary.orders,
      clicks: summary.clicks,
      impressions: summary.impressions,
      roas: summary.spend > 0 ? roundMoney(summary.revenue / summary.spend) : 0,
      cpa: summary.orders > 0 ? roundMoney(summary.spend / summary.orders) : null,
      contributionAfterAds: roundMoney(summary.contributionAfterAds),
    },
    scaleCandidates: rows.filter(row => row.status === 'scale_candidate').map(row => row.campaign),
    fixList: rows.filter(row => row.status === 'trim_or_fix').map(row => row.campaign),
    nextActions: [
      'Compare ROAS against gross-margin break-even, not just platform-reported sales.',
      'Separate new-customer acquisition campaigns from remarketing campaigns.',
      'Review creative, audience, keyword, and SKU margin before increasing budget.',
    ],
  };
}

function inferAfterSalesCause(text: string): string {
  if (/quality|broken|defect|damaged|瑕疵|质量|坏|破损/i.test(text)) return 'quality';
  if (/logistics|shipping|delay|lost|快递|物流|延迟|丢件/i.test(text)) return 'logistics';
  if (/size|fit|颜色|尺寸|尺码|不合适/i.test(text)) return 'fit_or_expectation';
  if (/description|photo|mislead|描述|图片|不符/i.test(text)) return 'listing_mismatch';
  if (/service|客服|态度|响应/i.test(text)) return 'service';
  return 'unspecified';
}

export function buildAfterSalesRiskReport(args: {
  afterSalesText?: string;
  totalOrders?: number;
  totalRevenue?: number;
  currency?: string;
}) {
  const rows = String(args.afterSalesText || '').split(/\r?\n|;|\uFF1B/).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const nums = extractNumbers(text);
    const orders = firstMetric(text, [/orders?|sales.?count|订单|销量|单量/]) ?? nums[0] ?? 0;
    const refundCount = firstMetric(text, [/refund.?count|returns?|refunds?|退款数|退货数|售后数/]) ?? nums[1] ?? 0;
    const refundAmount = firstMetric(text, [/refund.?amount|refund.?value|退款金额|售后金额/]) ?? nums[2] ?? 0;
    const complaints = firstMetric(text, [/complaints?|bad.?reviews?|差评|投诉|纠纷/]) ?? 0;
    const refundRate = orders > 0 ? refundCount / orders : 0;
    return {
      sku: rowName(text, index),
      orders: Math.max(0, Math.round(orders)),
      refundCount: Math.max(0, Math.round(refundCount)),
      refundAmount: roundMoney(refundAmount),
      complaints: Math.max(0, Math.round(complaints)),
      refundRate: roundMoney(refundRate * 100),
      cause: inferAfterSalesCause(text),
      status: refundRate >= 0.1 || complaints >= 5
        ? 'high_risk'
        : refundRate >= 0.05 || complaints >= 2
          ? 'watch'
          : 'normal',
    };
  }).filter((row): row is NonNullable<typeof row> => Boolean(row));

  const totalOrders = toNumber(args.totalOrders, rows.reduce((sum, row) => sum + row.orders, 0));
  const totalRefundCount = rows.reduce((sum, row) => sum + row.refundCount, 0);
  const totalRefundAmount = rows.reduce((sum, row) => sum + row.refundAmount, 0);
  const causeCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.cause] = (acc[row.cause] || 0) + row.refundCount + row.complaints;
    return acc;
  }, {});

  return {
    currency: args.currency || 'CNY',
    rows,
    summary: {
      totalOrders,
      totalRefundCount,
      totalRefundAmount: roundMoney(totalRefundAmount),
      refundRate: totalOrders > 0 ? roundMoney(totalRefundCount / totalOrders * 100) : 0,
      refundAmountRate: toNumber(args.totalRevenue) > 0 ? roundMoney(totalRefundAmount / toNumber(args.totalRevenue) * 100) : null,
      causeCounts,
    },
    highRiskSkus: rows.filter(row => row.status === 'high_risk').map(row => row.sku),
    nextActions: [
      'Open the top-risk SKU pages and compare customer expectations against title, images, size/spec table, and promises.',
      'Tag after-sales causes before deciding whether to change product, listing, logistics, or customer-service scripts.',
      'Feed refund amounts back into SKU profit analysis before scaling promotions.',
    ],
  };
}
