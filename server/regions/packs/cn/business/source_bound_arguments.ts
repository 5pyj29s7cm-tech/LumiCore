import type { ToolContext } from '../../../../tools/types';

export interface EcommerceInventoryFact {
  sku: string;
  stock: number;
  dailySales?: number;
}

export interface EcommerceTodaySourceFacts {
  revenue?: number;
  orders?: number;
  adSpend?: number;
  cogs?: number;
  shipping?: number;
  platformFees?: number;
  refundAmount?: number;
  afterSalesCount?: number;
  reportingPeriod?: string;
  currency?: string;
  inventory: EcommerceInventoryFact[];
}

function numberFrom(source: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function exactText(source: string, label: RegExp): string | undefined {
  const match = source.match(new RegExp(`(?:${label.source})\\s*[:\\uFF1A]?\\s*([^\\r\\n;\\uFF1B]+)`, 'iu'));
  return match?.[1]?.trim() || undefined;
}

/**
 * Parse only explicitly labelled operating facts. There is deliberately no
 * positional fallback: a sales amount can never become COGS, ad spend can
 * never become shipping, and a refund amount can never become a case count.
 */
export function parseEcommerceTodaySource(sourceInput: string): EcommerceTodaySourceFacts {
  const source = String(sourceInput || '');
  const revenue = numberFrom(source, [
    /(?:\u9500\u552e\u989d|\u6210\u4ea4\u989d|\u8425\u4e1a\u989d|GMV|revenue|sales)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
  ]);
  const orders = numberFrom(source, [
    /(?:\u8ba2\u5355(?:\u6570|\u91cf)?|\u6210\u4ea4\u5355\u91cf|orders?)\s*[:\uFF1A=]?\s*(-?[\d,]+(?:\.\d+)?)(?:\s*(?:\u5355|\u7b14))?/iu,
  ]);
  const adSpend = numberFrom(source, [
    /(?:\u5e7f\u544a(?:\u82b1\u8d39|\u6d88\u8017|\u652f\u51fa)?|\u6295\u653e(?:\u82b1\u8d39|\u6d88\u8017|\u652f\u51fa)?|ad\s*spend)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
  ]);
  const cogs = numberFrom(source, [
    /(?:\u5546\u54c1\u6210\u672c|\u91c7\u8d2d\u6210\u672c|\u8d27\u54c1\u6210\u672c|\u9500\u552e\u6210\u672c|COGS)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
  ]);
  const shipping = numberFrom(source, [
    /(?:\u7269\u6d41\u6210\u672c|\u8fd0\u8d39|shipping)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
  ]);
  const platformFees = numberFrom(source, [
    /(?:\u5e73\u53f0(?:\u8d39|\u8d39\u7528|\u4f63\u91d1)|platform\s*fees?)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
  ]);
  const combinedChannelCost = numberFrom(source, [
    /(?:\u5e73\u53f0\u53ca\u7269\u6d41\u6210\u672c|\u5e73\u53f0\u4e0e\u7269\u6d41\u6210\u672c)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
  ]);
  const refundAmount = numberFrom(source, [
    /(?:\u9000\u6b3e\u91d1\u989d|\u552e\u540e\u91d1\u989d|refund\s*amount)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu,
    /(?:\u9000\u6b3e)\s*[:\uFF1A=]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)\s*(?:\u5143|CNY|RMB)/iu,
  ]);
  const afterSalesCount = numberFrom(source, [
    /(?:\u552e\u540e(?:\u5355|\u4ef6|\u6570|\u6570\u91cf)?|\u9000\u6b3e(?:\u6570|\u5355\u6570|\u7b14\u6570)|after[-\s]?sales(?:\s*count)?)\s*[:\uFF1A=]?\s*(-?[\d,]+(?:\.\d+)?)(?:\s*(?:\u5355|\u4ef6|\u7b14))?/iu,
  ]);

  const inventory: EcommerceInventoryFact[] = [];
  const seenSkus = new Set<string>();
  const inventoryPattern = /([A-Za-z0-9][A-Za-z0-9._-]{0,40})\s*\u5e93\u5b58\s*[:\uFF1A=]?\s*(-?[\d,]+(?:\.\d+)?)(?:\s*(?:\u4ef6|\u4e2a|pcs?))?/giu;
  for (const match of source.matchAll(inventoryPattern)) {
    const sku = String(match[1] || '').trim();
    const stock = Number(String(match[2] || '').replace(/,/g, ''));
    if (!sku || !Number.isFinite(stock) || seenSkus.has(sku.toLowerCase())) continue;
    seenSkus.add(sku.toLowerCase());
    inventory.push({ sku, stock });
  }
  const inventoryDailyPattern = /(?:SKU\s*)?([A-Za-z0-9][A-Za-z0-9._-]{0,40})\s*\u5e93\u5b58\s*[:\uFF1A=]?\s*(-?[\d,]+(?:\.\d+)?)\s*(?:\u4ef6|\u4e2a|pcs?)?[^\u3002\uFF1B;\r\n]{0,32}?\u65e5\u5747\u9500\u91cf\s*[:\uFF1A=]?\s*(-?[\d,]+(?:\.\d+)?)/giu;
  for (const match of source.matchAll(inventoryDailyPattern)) {
    const sku = String(match[1] || '').trim();
    const stock = Number(String(match[2] || '').replace(/,/g, ''));
    const dailySales = Number(String(match[3] || '').replace(/,/g, ''));
    if (!sku || !Number.isFinite(stock) || !Number.isFinite(dailySales)) continue;
    const existing = inventory.find(item => item.sku.toLowerCase() === sku.toLowerCase());
    if (existing) existing.dailySales = dailySales;
    else {
      seenSkus.add(sku.toLowerCase());
      inventory.push({ sku, stock, dailySales });
    }
  }
  const compactInventoryBlock = source.match(
    /(?:\u5e93\u5b58|inventory)\s*[:\uFF1A]\s*([^\u3002\uFF1B;\r\n]+)/iu,
  )?.[1] || '';
  const compactInventoryPattern = /([A-Za-z0-9][A-Za-z0-9._-]{0,40})\s*[:=]?\s*(-?[\d,]+(?:\.\d+)?)(?:\s*(?:\u4ef6|\u4e2a|pcs?))?/giu;
  for (const match of compactInventoryBlock.matchAll(compactInventoryPattern)) {
    const sku = String(match[1] || '').trim();
    const stock = Number(String(match[2] || '').replace(/,/g, ''));
    if (!sku || !Number.isFinite(stock) || seenSkus.has(sku.toLowerCase())) continue;
    seenSkus.add(sku.toLowerCase());
    inventory.push({ sku, stock });
  }

  const periodMatch = source.match(/\b(20\d{2})[\u5e74\/-](\d{1,2})[\u6708\/-](\d{1,2})(?:\u65e5)?\b/u);
  const reportingPeriod = periodMatch
    ? `${periodMatch[1]}-${periodMatch[2].padStart(2, '0')}-${periodMatch[3].padStart(2, '0')}`
    : undefined;
  const currencyMatch = source.match(/\b(CNY|RMB|USD|EUR|HKD)\b/iu);

  return {
    revenue,
    orders,
    adSpend,
    cogs,
    shipping: shipping ?? combinedChannelCost,
    platformFees,
    refundAmount,
    afterSalesCount,
    reportingPeriod,
    currency: currencyMatch?.[1]?.toUpperCase(),
    inventory,
  };
}

function parts(values: Array<[string, number | undefined]>): string {
  return values
    .filter((item): item is [string, number] => item[1] !== undefined)
    .map(([label, value]) => `${label} ${value}`)
    .join(' ');
}

function requireMetric(value: number | undefined, label: string, toolName: string): number {
  if (value !== undefined) return value;
  throw new Error(`Bound source data is missing ${label}; ${toolName} was stopped instead of guessing.`);
}

/**
 * Industry workflow source data is bound by digest before it reaches this
 * adapter. Analyzer arguments always come from the exact labelled facts, not
 * an LLM paraphrase.
 */
export function bindIndustrySourceArguments(
  toolName: string,
  requested: Record<string, any>,
  context?: ToolContext,
): Record<string, any> {
  if (
    context?.industryWorkflowProductLine !== 'ecommerce'
    || !context.industryWorkflowSourceInput
  ) return requested;

  const source = context.industryWorkflowSourceInput;
  if (context.industryWorkflowEntryId === 'listing-automation') {
    const sku = source.match(/\b(SKU[-_.A-Za-z0-9]{1,40})\b/iu)?.[1]
      || source.match(/SKU\s*[:\uFF1A]\s*([A-Za-z0-9._-]{1,40})/iu)?.[1]
      || 'SKU';
    const platform = source.match(/(?:\u5e73\u53f0)(?:\u662f|\u4e3a|[:\uFF1A])?\s*([^\uFF0C,\u3002\uFF1B;\r\n]{2,24})/u)?.[1]?.trim();
    const price = numberFrom(source, [/(?:\u552e\u4ef7|\u5355\u4ef7)\s*[:\uFF1A]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu]);
    const cost = numberFrom(source, [/(?:\u5546\u54c1\u6210\u672c|\u91c7\u8d2d\u6210\u672c|\u8d27\u54c1\u6210\u672c)\s*[:\uFF1A]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu]);
    const shipping = numberFrom(source, [/(?:\u7269\u6d41|\u8fd0\u8d39)(?:\u6210\u672c)?\s*[:\uFF1A]?\s*(?:[\u00A5\uFFE5$]\s*)?(-?[\d,]+(?:\.\d+)?)/iu]);
    const feeRate = numberFrom(source, [/(?:\u5e73\u53f0\u8d39\u7387|\u4f63\u91d1\u7387)\s*[:\uFF1A]?\s*(-?[\d,]+(?:\.\d+)?)\s*%?/iu]);
    const orders = numberFrom(source, [/(?:\u8fd1\s*\d+\s*\u5929\s*)?(-?[\d,]+(?:\.\d+)?)\s*\u5355/iu]);
    const refunds = numberFrom(source, [/(?:\u9000\u6b3e|\u9000\u8d27)\s*[:\uFF1A]?\s*(-?[\d,]+(?:\.\d+)?)\s*\u5355/iu]);
    const refundReason = source.match(/(?:\u9000\u6b3e\u539f\u56e0|\u9000\u8d27\u539f\u56e0)(?:\u4e3b\u8981\u662f|\u4e3a|[:\uFF1A])?\s*["\u201c\u201d]?([^"\u201c\u201d\uFF0C,\u3002\uFF1B;\r\n]{1,80})/u)?.[1]?.trim();
    const unknowns = [
      /\u5408\u89c4\u8bc1\u660e[^\u3002\uFF1B;\r\n]{0,20}(?:\u672a\u63d0\u4f9b|\u7f3a\u5931|\u672a\u77e5)/u.test(source) ? '\u5408\u89c4\u8bc1\u660e\u672a\u63d0\u4f9b' : '',
      /\u8d28\u68c0\u6279\u6b21\u53f7[^\u3002\uFF1B;\r\n]{0,20}(?:\u672a\u63d0\u4f9b|\u7f3a\u5931|\u672a\u77e5)/u.test(source) ? '\u8d28\u68c0\u6279\u6b21\u53f7\u672a\u63d0\u4f9b' : '',
    ].filter(Boolean);

    if (toolName === 'business_ecommerce_inventory_restock_plan') {
      const stock = numberFrom(source, [/(?:\u5e93\u5b58)\s*[:\uFF1A]?\s*(-?[\d,]+(?:\.\d+)?)/iu]);
      const dailySales = numberFrom(source, [/(?:\u65e5\u5747\u9500\u91cf)\s*[:\uFF1A]?\s*(-?[\d,]+(?:\.\d+)?)/iu]);
      const leadTimeDays = numberFrom(source, [/(?:\u4f9b\u5e94\u5546\u4ea4\u671f|\u4ea4\u671f)\s*[:\uFF1A]?\s*(-?[\d,]+(?:\.\d+)?)/iu]);
      const safetyStockDays = numberFrom(source, [/(?:\u5b89\u5168\u5e93\u5b58)\s*[:\uFF1A]?\s*(-?[\d,]+(?:\.\d+)?)/iu]);
      if ([stock, dailySales, leadTimeDays, safetyStockDays].some(value => value === undefined)) return requested;
      return {
        ...requested,
        inventoryText: `${sku} stock ${stock} daily ${dailySales} lead ${leadTimeDays} safety ${safetyStockDays}`,
      };
    }
    if (toolName === 'business_ecommerce_ecommerce_order_profit') {
      if ([price, cost, shipping, feeRate, orders].some(value => value === undefined)) return requested;
      const revenue = price! * orders!;
      return {
        ...requested,
        orderText: parts([
          [`${sku} revenue`, revenue],
          ['cogs', cost! * orders!],
          ['shipping', shipping! * orders!],
          ['platform fee', revenue * feeRate! / 100],
          ['units', orders],
        ]),
      };
    }
    if (toolName === 'business_ecommerce_after_sales_risk_report') {
      if (orders === undefined || refunds === undefined) return requested;
      return {
        ...requested,
        afterSalesText: `${sku} orders ${orders} refunds ${refunds}${refundReason ? ` ${refundReason}` : ''}`,
        totalOrders: orders,
      };
    }
    if (toolName === 'business_ecommerce_product_listing_optimizer') {
      return {
        productName: `${sku} (product name unknown)`,
        ...(platform ? { platform } : {}),
        ...(price !== undefined ? { priceRange: `${price}` } : {}),
        constraints: [
          ...unknowns,
          refundReason ? `Known return issue: ${refundReason}` : '',
          'Draft only. Listing, delisting, repricing, procurement, and publishing require item-level approval.',
        ].filter(Boolean).join('; '),
      };
    }
    return requested;
  }

  if (context.industryWorkflowEntryId !== 'today-operations') return requested;
  const facts = parseEcommerceTodaySource(source);

  if (toolName === 'business_ecommerce_ecommerce_order_profit') {
    const revenue = requireMetric(facts.revenue, 'sales revenue', toolName);
    const cogs = requireMetric(facts.cogs, 'COGS', toolName);
    const shipping = requireMetric(facts.shipping, 'shipping/platform cost', toolName);
    const adSpend = requireMetric(facts.adSpend, 'ad spend', toolName);
    const refundAmount = requireMetric(facts.refundAmount, 'refund amount', toolName);
    return {
      ...requested,
      orderText: parts([
        ['All-store revenue', revenue],
        ['cogs', cogs],
        ['shipping', shipping],
        ['platform fee', facts.platformFees],
        ['ad spend', adSpend],
        ['refund', refundAmount],
        ['units', facts.orders],
      ]),
    };
  }
  if (toolName === 'business_ecommerce_campaign_roi_analyzer') {
    const revenue = requireMetric(facts.revenue, 'sales revenue', toolName);
    const adSpend = requireMetric(facts.adSpend, 'ad spend', toolName);
    return {
      ...requested,
      campaignText: parts([
        ['All-store spend', adSpend],
        ['revenue', revenue],
        ['orders', facts.orders],
      ]),
      ...(facts.cogs !== undefined && revenue > 0 ? { grossMarginRate: (revenue - facts.cogs) / revenue } : {}),
    };
  }
  if (toolName === 'business_ecommerce_after_sales_risk_report') {
    if (facts.refundAmount === undefined && facts.afterSalesCount === undefined) {
      throw new Error(`Bound source data is missing refund amount/count; ${toolName} was stopped instead of guessing.`);
    }
    return {
      ...requested,
      afterSalesText: parts([
        ['All-store orders', facts.orders],
        ['refunds', facts.afterSalesCount],
        ['refund amount', facts.refundAmount],
      ]),
      ...(facts.orders !== undefined ? { totalOrders: facts.orders } : {}),
      ...(facts.revenue !== undefined ? { totalRevenue: facts.revenue } : {}),
    };
  }
  return requested;
}
