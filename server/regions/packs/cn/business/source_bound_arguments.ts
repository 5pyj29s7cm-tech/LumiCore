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
