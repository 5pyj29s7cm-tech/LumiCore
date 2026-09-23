// Canonical, dependency-free ecommerce analysis core shared by the MCP skill and client workbench.
export const ECOMMERCE_REPORT_ROW_LIMIT = 50_000;

export type EcommerceReportKind = 'orders' | 'campaigns' | 'inventory' | 'afterSales' | 'reviews';

export type EcommerceTableRow = Record<string, string | number>;

export interface EcommerceTable {
  headers: string[];
  rows: EcommerceTableRow[];
  delimiter?: string;
}

export type EcommerceColumnMapping = Partial<Record<string, string>>;

export interface EcommerceAnalysisOptions {
  grossMarginRate?: number;
  targetStockDays?: number;
  columnMappings?: Partial<Record<EcommerceReportKind, EcommerceColumnMapping>>;
}

export interface EcommerceFieldDefinition {
  field: string;
  recommended: boolean;
}

export type EcommerceRiskCode =
  | 'missing_cost'
  | 'negative_profit'
  | 'high_ad_cost'
  | 'low_roas'
  | 'high_refund'
  | 'negative_reviews'
  | 'urgent_restock';

export interface EcommerceRisk {
  code: EcommerceRiskCode;
  severity: 'high' | 'medium';
  value: number;
  items: string[];
}

export interface EcommerceSourceSummary {
  kind: EcommerceReportKind;
  rowCount: number;
  mappedFields: string[];
  missingRecommendedFields: string[];
}

export interface EcommerceSkuPerformance {
  sku: string;
  revenue: number;
  refunds: number;
  contributionProfit: number;
  contributionMargin: number;
  units: number;
}

export interface EcommerceCampaignPerformance {
  campaign: string;
  spend: number;
  revenue: number;
  orders: number;
  roas: number;
  cpa: number | null;
  status: 'scale' | 'watch' | 'fix';
}

export interface EcommerceInventoryAlert {
  sku: string;
  stock: number;
  dailySales: number;
  daysCover: number | null;
  reorderPoint: number;
  suggestedOrderQty: number;
  status: 'urgent' | 'watch';
}

export type EcommerceReviewTopic =
  | 'quality'
  | 'fit'
  | 'logistics'
  | 'listing_mismatch'
  | 'service'
  | 'value'
  | 'packaging'
  | 'other';

export interface EcommerceReviewTopicInsight {
  topic: EcommerceReviewTopic;
  count: number;
  negativeCount: number;
  negativeRate: number;
  samples: string[];
}

export interface EcommerceNegativeReviewSample {
  sku: string;
  content: string;
  rating: number | null;
  topic: EcommerceReviewTopic;
}

export interface EcommerceReviewInsights {
  totalReviews: number;
  averageRating: number | null;
  positiveRate: number;
  neutralRate: number;
  negativeRate: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  topics: EcommerceReviewTopicInsight[];
  negativeSamples: EcommerceNegativeReviewSample[];
}

export interface EcommerceWorkbenchSnapshot {
  metrics: {
    gmv: number;
    netRevenue: number;
    contributionProfit: number;
    contributionMargin: number;
    adSpend: number;
    roas: number;
    refundRate: number;
    orderCount: number;
  };
  topSkus: EcommerceSkuPerformance[];
  campaigns: EcommerceCampaignPerformance[];
  inventoryAlerts: EcommerceInventoryAlert[];
  reviewInsights: EcommerceReviewInsights;
  risks: EcommerceRisk[];
  sources: EcommerceSourceSummary[];
  assumptions: {
    grossMarginRate: number;
    targetStockDays: number;
  };
}

interface ColumnDefinition {
  aliases: string[];
  recommended?: boolean;
}

type ColumnDefinitions = Record<string, ColumnDefinition>;

const ORDER_COLUMNS: ColumnDefinitions = {
  orderId: { aliases: ['订单编号', '订单号', '主订单编号', '主订单号', '子订单编号', '订单ID', 'order id', 'order number', 'order no'] }, // i18n-allow -- marketplace header aliases
  sku: { aliases: ['sku', '商家编码', '商家SKU编码', '规格编码', '商品编码', '商品SKU', '外部商家编码', '货号', 'sku id', 'merchant sku', 'variant sku'], recommended: true }, // i18n-allow -- marketplace header aliases
  revenue: { aliases: ['销售额', '成交金额', '实付金额', '买家实付金额', '订单应付金额', '支付金额', '订单金额', '商品金额', '商家实收金额', 'gmv', 'revenue', 'sales', 'paid amount', 'net sales', 'total sales'], recommended: true }, // i18n-allow -- marketplace header aliases
  cogs: { aliases: ['商品成本', '采购成本', '进货成本', '销售成本', 'cogs', 'cost', 'cost of goods'], recommended: true }, // i18n-allow -- marketplace header aliases
  shipping: { aliases: ['物流成本', '发货运费', '运费', '快递费', 'shipping', 'freight'] }, // i18n-allow -- marketplace header aliases
  fees: { aliases: ['平台服务费', '平台费', '佣金', '达人佣金', '渠道推广服务费', '技术服务费', '支付手续费', 'commission', 'platform fee', 'fee', 'fees'] }, // i18n-allow -- marketplace header aliases
  adSpend: { aliases: ['广告消耗', '广告费', '投流消耗', '推广费', 'ad spend', 'ads', 'marketing spend'] }, // i18n-allow -- marketplace header aliases
  refunds: { aliases: ['退款金额', '成功退款金额', '退货退款金额', '售后退款', 'refund amount', 'refund', 'refunds'] }, // i18n-allow -- marketplace header aliases
  otherCost: { aliases: ['其他成本', '包装成本', '赠品成本', 'other cost', 'misc cost'] }, // i18n-allow -- marketplace header aliases
  units: { aliases: ['商品数量', '购买数量', '销售数量', '销量', '件数', 'quantity', 'qty', 'units'] }, // i18n-allow -- marketplace header aliases
};

const CAMPAIGN_COLUMNS: ColumnDefinitions = {
  campaign: { aliases: ['计划名称', '广告计划', '广告组', '单元名称', '推广计划名称', 'campaign', 'campaign name', 'ad group'], recommended: true }, // i18n-allow -- marketplace header aliases
  spend: { aliases: ['广告消耗', '消耗', '总消耗', '花费', '广告费', '投放金额', 'spend', 'ad spend', 'cost'], recommended: true }, // i18n-allow -- marketplace header aliases
  revenue: { aliases: ['成交金额', '广告成交金额', '直接成交金额', '支付ROI成交金额', '支付金额', 'gmv', 'revenue', 'sales', 'conversion value'], recommended: true }, // i18n-allow -- marketplace header aliases
  orders: { aliases: ['成交订单数', '支付订单数', '订单数', '转化数', 'orders', 'conversions', 'purchases'] }, // i18n-allow -- marketplace header aliases
  clicks: { aliases: ['点击量', '点击数', 'clicks'] }, // i18n-allow -- marketplace header aliases
  impressions: { aliases: ['曝光量', '展现量', '曝光', 'impressions', 'views'] }, // i18n-allow -- marketplace header aliases
};

const INVENTORY_COLUMNS: ColumnDefinitions = {
  sku: { aliases: ['sku', '商家编码', '商家SKU编码', '规格编码', '商品编码', '商品SKU', '货号', 'sku id', 'merchant sku', 'variant sku'], recommended: true }, // i18n-allow -- marketplace header aliases
  stock: { aliases: ['可售库存', '可用库存', '现货库存', '库存数量', '当前库存', '仓库可用库存', 'stock', 'inventory', 'on hand', 'available'], recommended: true }, // i18n-allow -- marketplace header aliases
  dailySales: { aliases: ['日均销量', '日销', '每日销量', '销售速度', 'daily', 'daily sales', 'velocity'], recommended: true }, // i18n-allow -- marketplace header aliases
  leadTime: { aliases: ['采购周期', '补货周期', '到货天数', '交期', 'lead', 'lead time', 'lead days'] }, // i18n-allow -- marketplace header aliases
  safetyDays: { aliases: ['安全库存天数', '安全天数', 'safety', 'safety days', 'buffer days'] }, // i18n-allow -- marketplace header aliases
};

const AFTER_SALES_COLUMNS: ColumnDefinitions = {
  sku: { aliases: ['sku', '商家编码', '商家SKU编码', '规格编码', '商品编码', '商品SKU', '货号', 'sku id', 'merchant sku', 'variant sku'], recommended: true }, // i18n-allow -- marketplace header aliases
  orders: { aliases: ['订单数', '销售单量', '总订单数', 'orders', 'sales count'], recommended: true }, // i18n-allow -- marketplace header aliases
  refundCount: { aliases: ['退款单数', '退货数', '售后数', 'refund count', 'refunds', 'returns'], recommended: true }, // i18n-allow -- marketplace header aliases
  refundAmount: { aliases: ['退款金额', '售后金额', 'refund amount', 'refund value'] }, // i18n-allow -- marketplace header aliases
  complaints: { aliases: ['投诉数', '差评数', '纠纷数', 'complaints', 'bad reviews'] }, // i18n-allow -- marketplace header aliases
};

const REVIEW_COLUMNS: ColumnDefinitions = {
  sku: { aliases: ['sku', '商家编码', '商家SKU编码', '规格编码', '商品编码', '商品SKU', '货号', 'sku id', 'merchant sku', 'variant sku'] }, // i18n-allow -- marketplace header aliases
  content: { aliases: ['评价内容', '评论内容', '买家评价', '用户评价', '评价', '评论', 'content', 'review content', 'comment content', 'review', 'comment'], recommended: true }, // i18n-allow -- marketplace header aliases
  rating: { aliases: ['评分', '星级', '商品评分', '评价星级', '评论星级', 'rating', 'stars', 'star rating'] }, // i18n-allow -- marketplace header aliases
  date: { aliases: ['评价时间', '评论时间', '创建时间', '提交时间', 'review date', 'comment date', 'created at', 'date'] }, // i18n-allow -- marketplace header aliases
  helpful: { aliases: ['有用数', '点赞数', '赞数', 'helpful', 'helpful count', 'likes'] }, // i18n-allow -- marketplace header aliases
};

const DEFINITIONS_BY_KIND: Record<EcommerceReportKind, ColumnDefinitions> = {
  orders: ORDER_COLUMNS,
  campaigns: CAMPAIGN_COLUMNS,
  inventory: INVENTORY_COLUMNS,
  afterSales: AFTER_SALES_COLUMNS,
  reviews: REVIEW_COLUMNS,
};

const REVIEW_TOPIC_KEYWORDS: Record<Exclude<EcommerceReviewTopic, 'other'>, string[]> = {
  quality: ['质量', '破损', '损坏', '坏了', '瑕疵', '做工', '掉色', '异味', '开裂', 'broken', 'defect', 'damaged', 'quality'], // i18n-allow -- review recognition terms
  fit: ['尺寸', '尺码', '偏小', '偏大', '太小', '太大', '不合适', '不贴合', 'size', 'sizing', 'fit'], // i18n-allow -- review recognition terms
  logistics: ['物流', '快递', '发货', '到货', '延迟', '送达', 'shipping', 'delivery', 'logistics', 'late'], // i18n-allow -- review recognition terms
  listing_mismatch: ['不符', '描述', '图片', '色差', '货不对板', 'not as described', 'different from', 'misleading', 'photo'], // i18n-allow -- review recognition terms
  service: ['客服', '售后', '态度', '回复', '无人处理', 'service', 'support', 'response'], // i18n-allow -- review recognition terms
  value: ['价格', '太贵', '性价比', '不值', '便宜', 'price', 'value', 'expensive', 'overpriced'], // i18n-allow -- review recognition terms
  packaging: ['包装', '盒子', '外箱', '封装', 'packaging', 'package', 'box'], // i18n-allow -- review recognition terms
};

const NEGATIVE_REVIEW_KEYWORDS = [
  '差', '不好', '失望', '破损', '损坏', '坏了', '瑕疵', '慢', '不符', '退货', '退款', '难用', '异味', '掉色', '偏小', '偏大', '不回复', '不值', '不推荐', // i18n-allow -- review recognition terms
  'poor', 'bad', 'broken', 'slow', 'disappoint', 'not as described', 'not good', 'refund', 'defect', 'damaged', 'terrible',
];

const POSITIVE_REVIEW_KEYWORDS = [
  '很好', '满意', '喜欢', '推荐', '不错', '很快', '值得', '好用', '精致', '好', 'excellent', 'great', 'good', 'love', 'recommend', 'fast', 'satisfied', // i18n-allow -- review recognition terms
];

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-/\\:：]+/g, '')
    .replace(/[()（）\[\]【】]/g, '');
}

function detectDelimiter(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).slice(0, 5);
  const candidates = ['\t', ',', ';'];
  const score = (delimiter: string) => lines.reduce((sum, line) => {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '"') quoted = !quoted;
      else if (!quoted && line[index] === delimiter) count += 1;
    }
    return sum + count;
  }, 0);
  return candidates.sort((left, right) => score(right) - score(left))[0];
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      row.push(field.trim());
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  row.push(field.trim());
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

export function tableFromMatrix(matrix: Array<Array<string | number | null | undefined>>, delimiter?: string): EcommerceTable {
  const nonEmpty = matrix.filter(row => row.some(value => String(value ?? '').trim() !== ''));
  if (nonEmpty.length < 2) throw new Error('The report must contain a header row and at least one data row.');
  const rawHeaders = nonEmpty[0].map((value, index) => String(value ?? '').trim() || `column_${index + 1}`);
  const seen = new Map<string, number>();
  const headers = rawHeaders.map(header => {
    const count = (seen.get(header) || 0) + 1;
    seen.set(header, count);
    return count === 1 ? header : `${header}_${count}`;
  });
  const rows = nonEmpty.slice(1, ECOMMERCE_REPORT_ROW_LIMIT + 1).map(values => Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? '']),
  ));
  return { headers, rows, delimiter };
}

export function parseDelimitedReport(text: string): EcommerceTable {
  const delimiter = detectDelimiter(text);
  const matrix = parseDelimitedRows(text, delimiter);
  return tableFromMatrix(matrix, delimiter);
}

export function parseReviewPaste(text: string): EcommerceTable {
  const nonEmptyLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const firstLine = nonEmptyLines[0] || '';
  const looksLikeTable = /\t|;/.test(firstLine)
    || (firstLine.includes(',') && /(sku|评价|评论|review|comment|rating|评分|星级)/i.test(firstLine)); // i18n-allow -- pasted-header recognition
  return looksLikeTable
    ? parseDelimitedReport(text)
    : tableFromMatrix([['评价内容'], ...nonEmptyLines.map(line => [line])]); // i18n-allow -- normalized internal header
}

function resolveColumns(
  table: EcommerceTable,
  definitions: ColumnDefinitions,
  overrides: EcommerceColumnMapping = {},
): Record<string, string | undefined> {
  const normalizedHeaders = table.headers.map(header => ({ header, normalized: normalizeHeader(header) }));
  return Object.fromEntries(Object.entries(definitions).map(([field, definition]) => {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) {
      const override = overrides[field];
      return [field, override && table.headers.includes(override) ? override : undefined];
    }
    const aliases = definition.aliases.map(normalizeHeader).sort((left, right) => right.length - left.length);
    const exact = normalizedHeaders.find(item => aliases.includes(item.normalized));
    if (exact) return [field, exact.header];
    const withUnit = normalizedHeaders.find(item => aliases.some(alias => alias.length >= 3 && item.normalized.startsWith(alias)));
    return [field, withUnit?.header];
  }));
}

export function getEcommerceFieldDefinitions(kind: EcommerceReportKind): EcommerceFieldDefinition[] {
  return Object.entries(DEFINITIONS_BY_KIND[kind]).map(([field, definition]) => ({
    field,
    recommended: Boolean(definition.recommended),
  }));
}

export function suggestEcommerceColumnMapping(kind: EcommerceReportKind, table: EcommerceTable): EcommerceColumnMapping {
  const resolved = resolveColumns(table, DEFINITIONS_BY_KIND[kind]);
  return Object.fromEntries(Object.entries(resolved).filter(([, column]) => Boolean(column))) as EcommerceColumnMapping;
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const original = String(value ?? '').normalize('NFKC').trim();
  if (!original || original === '--' || original === '-') return 0;
  const negative = /^\(.*\)$/.test(original);
  const multiplier = original.includes('亿') ? 100_000_000 : original.includes('万') ? 10_000 : 1; // i18n-allow -- localized numeric unit parsing
  const match = original.replace(/[,，\s¥￥$€£]/g, '').match(/-?\d+(?:\.\d+)?/);
  const valueNumber = match ? Number(match[0]) * multiplier : 0;
  return negative ? -Math.abs(valueNumber) : valueNumber;
}

function textValue(row: EcommerceTableRow, column: string | undefined, fallback: string): string {
  const value = column ? String(row[column] ?? '').trim() : '';
  return value || fallback;
}

function numberValue(row: EcommerceTableRow, column: string | undefined): number {
  return column ? numeric(row[column]) : 0;
}

function sanitizeReviewContent(value: unknown): string {
  const content = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(^|\D)1[3-9]\d{9}(?=\D|$)/g, '$1[phone]')
    .replace(/\b\d{8,}\b/g, '[id]')
    .replace(/\s+/g, ' ')
    .trim();
  return content.length > 180 ? `${content.slice(0, 177)}...` : content;
}

function reviewRating(value: unknown): number | null {
  const match = String(value ?? '').normalize('NFKC').match(/(?:^|\D)([1-5](?:\.\d+)?)(?:\D|$)/);
  if (!match) return null;
  const rating = Number(match[1]);
  return rating >= 1 && rating <= 5 ? rating : null;
}

function includesReviewKeyword(content: string, keyword: string): boolean {
  return content.includes(keyword);
}

function reviewSentiment(content: string, rating: number | null): 'positive' | 'neutral' | 'negative' {
  if (rating !== null) return rating >= 4 ? 'positive' : rating <= 2 ? 'negative' : 'neutral';
  const normalized = content.toLowerCase();
  if (NEGATIVE_REVIEW_KEYWORDS.some(keyword => includesReviewKeyword(normalized, keyword))) return 'negative';
  if (POSITIVE_REVIEW_KEYWORDS.some(keyword => includesReviewKeyword(normalized, keyword))) return 'positive';
  return 'neutral';
}

function reviewTopics(content: string): EcommerceReviewTopic[] {
  const normalized = content.toLowerCase();
  const topics = Object.entries(REVIEW_TOPIC_KEYWORDS)
    .filter(([, keywords]) => keywords.some(keyword => includesReviewKeyword(normalized, keyword)))
    .map(([topic]) => topic as EcommerceReviewTopic);
  return topics.length > 0 ? topics : ['other'];
}

function sourceSummary(kind: EcommerceReportKind, table: EcommerceTable, columns: Record<string, string | undefined>): EcommerceSourceSummary {
  const definitions = DEFINITIONS_BY_KIND[kind];
  return {
    kind,
    rowCount: table.rows.length,
    mappedFields: Object.keys(columns).filter(field => Boolean(columns[field])),
    missingRecommendedFields: Object.entries(definitions)
      .filter(([field, definition]) => definition.recommended && !columns[field])
      .map(([field]) => field),
  };
}

export function analyzeEcommerceWorkbench(
  reports: Partial<Record<EcommerceReportKind, EcommerceTable>>,
  options: EcommerceAnalysisOptions = {},
): EcommerceWorkbenchSnapshot {
  const grossMarginRate = Math.min(Math.max(options.grossMarginRate ?? 0.35, 0), 1);
  const targetStockDays = Math.max(1, options.targetStockDays ?? 30);
  const sources: EcommerceSourceSummary[] = [];

  let gmv = 0;
  let refunds = 0;
  let cogs = 0;
  let shipping = 0;
  let fees = 0;
  let orderAdSpend = 0;
  let otherCost = 0;
  let orderCount = 0;
  let missingCostRows = 0;
  const skuMap = new Map<string, Omit<EcommerceSkuPerformance, 'contributionMargin'>>();

  if (reports.orders) {
    const table = reports.orders;
    const columns = resolveColumns(table, ORDER_COLUMNS, options.columnMappings?.orders);
    sources.push(sourceSummary('orders', table, columns));
    const uniqueOrders = new Set<string>();
    table.rows.forEach((row, index) => {
      const revenue = numberValue(row, columns.revenue);
      const rowRefunds = numberValue(row, columns.refunds);
      const rowCogs = numberValue(row, columns.cogs);
      const rowShipping = numberValue(row, columns.shipping);
      const rowFees = numberValue(row, columns.fees);
      const rowAdSpend = numberValue(row, columns.adSpend);
      const rowOtherCost = numberValue(row, columns.otherCost);
      const units = Math.max(0, numberValue(row, columns.units) || 1);
      const sku = textValue(row, columns.sku, `row-${index + 1}`);
      const contributionProfit = revenue - rowRefunds - rowCogs - rowShipping - rowFees - rowAdSpend - rowOtherCost;
      const current = skuMap.get(sku) || { sku, revenue: 0, refunds: 0, contributionProfit: 0, units: 0 };
      current.revenue += revenue;
      current.refunds += rowRefunds;
      current.contributionProfit += contributionProfit;
      current.units += units;
      skuMap.set(sku, current);
      gmv += revenue;
      refunds += rowRefunds;
      cogs += rowCogs;
      shipping += rowShipping;
      fees += rowFees;
      orderAdSpend += rowAdSpend;
      otherCost += rowOtherCost;
      if (revenue > 0 && (!columns.cogs || String(row[columns.cogs] ?? '').trim() === '')) missingCostRows += 1;
      if (columns.orderId) uniqueOrders.add(String(row[columns.orderId] ?? '').trim() || `row-${index + 1}`);
    });
    orderCount = columns.orderId ? uniqueOrders.size : table.rows.length;
  }

  let campaignSpend = 0;
  let campaignRevenue = 0;
  const campaigns: EcommerceCampaignPerformance[] = [];
  if (reports.campaigns) {
    const table = reports.campaigns;
    const columns = resolveColumns(table, CAMPAIGN_COLUMNS, options.columnMappings?.campaigns);
    sources.push(sourceSummary('campaigns', table, columns));
    const breakEvenRoas = grossMarginRate > 0 ? 1 / grossMarginRate : 0;
    table.rows.forEach((row, index) => {
      const spend = numberValue(row, columns.spend);
      const revenue = numberValue(row, columns.revenue);
      const orders = Math.max(0, numberValue(row, columns.orders));
      const roas = spend > 0 ? revenue / spend : 0;
      campaigns.push({
        campaign: textValue(row, columns.campaign, `campaign-${index + 1}`),
        spend: round(spend),
        revenue: round(revenue),
        orders: round(orders, 0),
        roas: round(roas),
        cpa: orders > 0 ? round(spend / orders) : null,
        status: roas >= breakEvenRoas * 1.2 ? 'scale' : roas < breakEvenRoas * 0.85 ? 'fix' : 'watch',
      });
      campaignSpend += spend;
      campaignRevenue += revenue;
    });
    campaigns.sort((left, right) => right.spend - left.spend);
  }

  const inventoryAlerts: EcommerceInventoryAlert[] = [];
  if (reports.inventory) {
    const table = reports.inventory;
    const columns = resolveColumns(table, INVENTORY_COLUMNS, options.columnMappings?.inventory);
    sources.push(sourceSummary('inventory', table, columns));
    table.rows.forEach((row, index) => {
      const sku = textValue(row, columns.sku, `row-${index + 1}`);
      const stock = Math.max(0, numberValue(row, columns.stock));
      const dailySales = Math.max(0, numberValue(row, columns.dailySales));
      const leadTime = Math.max(0, numberValue(row, columns.leadTime) || 7);
      const safetyDays = Math.max(0, numberValue(row, columns.safetyDays) || 3);
      if (dailySales <= 0) return;
      const daysCover = stock / dailySales;
      const reorderPoint = dailySales * (leadTime + safetyDays);
      const status = stock <= reorderPoint ? 'urgent' : daysCover <= leadTime + safetyDays + 7 ? 'watch' : null;
      if (!status) return;
      inventoryAlerts.push({
        sku,
        stock: round(stock),
        dailySales: round(dailySales),
        daysCover: round(daysCover),
        reorderPoint: round(reorderPoint),
        suggestedOrderQty: round(Math.max(dailySales * (leadTime + safetyDays + targetStockDays) - stock, 0)),
        status,
      });
    });
    inventoryAlerts.sort((left, right) => (left.status === right.status ? (left.daysCover ?? 0) - (right.daysCover ?? 0) : left.status === 'urgent' ? -1 : 1));
  }

  let afterSalesOrders = 0;
  let refundCount = 0;
  let afterSalesRefundAmount = 0;
  const highRefundSkus: string[] = [];
  if (reports.afterSales) {
    const table = reports.afterSales;
    const columns = resolveColumns(table, AFTER_SALES_COLUMNS, options.columnMappings?.afterSales);
    sources.push(sourceSummary('afterSales', table, columns));
    table.rows.forEach((row, index) => {
      const sku = textValue(row, columns.sku, `row-${index + 1}`);
      const orders = Math.max(0, numberValue(row, columns.orders));
      const rowRefundCount = Math.max(0, numberValue(row, columns.refundCount));
      const complaints = Math.max(0, numberValue(row, columns.complaints));
      afterSalesOrders += orders;
      refundCount += rowRefundCount;
      afterSalesRefundAmount += Math.max(0, numberValue(row, columns.refundAmount));
      if ((orders > 0 && rowRefundCount / orders >= 0.1) || complaints >= 5) highRefundSkus.push(sku);
    });
  }

  let totalReviews = 0;
  let ratingTotal = 0;
  let ratingCount = 0;
  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  const reviewTopicMap = new Map<EcommerceReviewTopic, Omit<EcommerceReviewTopicInsight, 'negativeRate'>>();
  const negativeSamples: EcommerceNegativeReviewSample[] = [];
  if (reports.reviews) {
    const table = reports.reviews;
    const columns = resolveColumns(table, REVIEW_COLUMNS, options.columnMappings?.reviews);
    sources.push(sourceSummary('reviews', table, columns));
    table.rows.forEach((row, index) => {
      const content = sanitizeReviewContent(columns.content ? row[columns.content] : '');
      const rating = reviewRating(columns.rating ? row[columns.rating] : '');
      if (!content && rating === null) return;
      const sentiment = reviewSentiment(content, rating);
      const topics = reviewTopics(content);
      totalReviews += 1;
      if (rating !== null) {
        ratingTotal += rating;
        ratingCount += 1;
      }
      if (sentiment === 'positive') positiveCount += 1;
      else if (sentiment === 'negative') negativeCount += 1;
      else neutralCount += 1;
      topics.forEach(topic => {
        const current = reviewTopicMap.get(topic) || { topic, count: 0, negativeCount: 0, samples: [] };
        current.count += 1;
        if (sentiment === 'negative') {
          current.negativeCount += 1;
          if (content && current.samples.length < 3) current.samples.push(content);
        }
        reviewTopicMap.set(topic, current);
      });
      if (sentiment === 'negative' && negativeSamples.length < 20) {
        negativeSamples.push({
          sku: textValue(row, columns.sku, `row-${index + 1}`),
          content: content || '(no review text)',
          rating,
          topic: topics[0],
        });
      }
    });
  }

  const reviewTopicsSummary = Array.from(reviewTopicMap.values()).map(topic => ({
    ...topic,
    negativeRate: topic.count > 0 ? round(topic.negativeCount / topic.count * 100) : 0,
  })).sort((left, right) => right.negativeCount - left.negativeCount || right.count - left.count);
  const reviewInsights: EcommerceReviewInsights = {
    totalReviews,
    averageRating: ratingCount > 0 ? round(ratingTotal / ratingCount) : null,
    positiveRate: totalReviews > 0 ? round(positiveCount / totalReviews * 100) : 0,
    neutralRate: totalReviews > 0 ? round(neutralCount / totalReviews * 100) : 0,
    negativeRate: totalReviews > 0 ? round(negativeCount / totalReviews * 100) : 0,
    positiveCount,
    neutralCount,
    negativeCount,
    topics: reviewTopicsSummary,
    negativeSamples,
  };

  if (refunds <= 0 && afterSalesRefundAmount > 0) refunds = afterSalesRefundAmount;
  const netRevenue = gmv - refunds;
  const contributionAdSpend = orderAdSpend > 0 ? orderAdSpend : campaignSpend;
  const reportedAdSpend = campaignSpend > 0 ? campaignSpend : orderAdSpend;
  const contributionProfit = netRevenue - cogs - shipping - fees - contributionAdSpend - otherCost;
  const contributionMargin = netRevenue > 0 ? contributionProfit / netRevenue : 0;
  const roasRevenue = campaignRevenue > 0 ? campaignRevenue : gmv;
  const roas = reportedAdSpend > 0 ? roasRevenue / reportedAdSpend : 0;
  const refundRate = afterSalesOrders > 0 ? refundCount / afterSalesOrders : gmv > 0 ? refunds / gmv : 0;
  const topSkus = Array.from(skuMap.values()).map(item => ({
    ...item,
    revenue: round(item.revenue),
    refunds: round(item.refunds),
    contributionProfit: round(item.contributionProfit),
    contributionMargin: item.revenue - item.refunds > 0 ? round(item.contributionProfit / (item.revenue - item.refunds) * 100) : 0,
    units: round(item.units, 0),
  })).sort((left, right) => right.revenue - left.revenue).slice(0, 20);

  const risks: EcommerceRisk[] = [];
  if (missingCostRows > 0) risks.push({ code: 'missing_cost', severity: 'high', value: missingCostRows, items: [] });
  const negativeSkus = topSkus.filter(item => item.contributionProfit < 0).map(item => item.sku);
  if (negativeSkus.length) risks.push({ code: 'negative_profit', severity: 'high', value: negativeSkus.length, items: negativeSkus.slice(0, 8) });
  const adCostRate = netRevenue > 0 ? reportedAdSpend / netRevenue : 0;
  if (adCostRate > 0.3) risks.push({ code: 'high_ad_cost', severity: 'medium', value: round(adCostRate * 100), items: [] });
  const breakEvenRoas = grossMarginRate > 0 ? 1 / grossMarginRate : 0;
  if (reportedAdSpend > 0 && roas < breakEvenRoas) risks.push({ code: 'low_roas', severity: 'high', value: round(roas), items: campaigns.filter(item => item.status === 'fix').map(item => item.campaign).slice(0, 8) });
  if (refundRate >= 0.05) risks.push({ code: 'high_refund', severity: refundRate >= 0.1 ? 'high' : 'medium', value: round(refundRate * 100), items: highRefundSkus.slice(0, 8) });
  if (reviewInsights.negativeRate >= 10) risks.push({
    code: 'negative_reviews',
    severity: reviewInsights.negativeRate >= 20 ? 'high' : 'medium',
    value: reviewInsights.negativeRate,
    items: reviewInsights.topics.filter(topic => topic.negativeCount > 0).map(topic => topic.topic).slice(0, 8),
  });
  const urgentSkus = inventoryAlerts.filter(item => item.status === 'urgent').map(item => item.sku);
  if (urgentSkus.length) risks.push({ code: 'urgent_restock', severity: 'high', value: urgentSkus.length, items: urgentSkus.slice(0, 8) });

  return {
    metrics: {
      gmv: round(gmv),
      netRevenue: round(netRevenue),
      contributionProfit: round(contributionProfit),
      contributionMargin: round(contributionMargin * 100),
      adSpend: round(reportedAdSpend),
      roas: round(roas),
      refundRate: round(refundRate * 100),
      orderCount,
    },
    topSkus,
    campaigns: campaigns.slice(0, 20),
    inventoryAlerts: inventoryAlerts.slice(0, 30),
    reviewInsights,
    risks,
    sources,
    assumptions: { grossMarginRate, targetStockDays },
  };
}
