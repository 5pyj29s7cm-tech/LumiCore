import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeOrderProfit,
  analyzeEcommerceSnapshot,
  analyzeReviewInsights,
  analyzeCampaignRoi,
  buildAfterSalesRiskReport,
  buildListingOptimizer,
  normalizeReviewSourceImport,
  planInventoryRestock,
  reconcileSettlement,
} from './logic';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerEcommerceSkillTools(server: { registerTool(name: string, config: any, handler: (args: any) => Promise<any>): unknown }): void {

server.registerTool('product_listing_optimizer', {
  description: 'Create marketplace-ready product title options, selling points, search keywords, image shot list, and compliance checks.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    productName: z.string().describe('Product name or SKU family'),
    platform: z.string().optional().describe('Marketplace or channel, e.g. Taobao, Douyin, Amazon, Shopify'),
    audience: z.string().optional().describe('Target shopper segment'),
    keywords: z.union([z.string(), z.array(z.string())]).optional().describe('Search keywords, one per line or as an array'),
    differentiators: z.union([z.string(), z.array(z.string())]).optional().describe('Product differentiators or proof points'),
    priceRange: z.string().optional().describe('Price band or offer structure'),
    constraints: z.string().optional().describe('Platform, legal, category, brand, or inventory constraints'),
  },
}, async (args: any) => ok(buildListingOptimizer(args)));

server.registerTool('ecommerce_order_profit', {
  description: 'Analyze pasted order/SKU lines into contribution profit, margin, ad-cost rate, break-even ad spend, and risk flags.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    orderText: z.string().describe('Order or SKU lines. Example: SKU A sales 1200 cost 500 shipping 80 ads 120 fee 60 refund 0 units 10.'),
    currency: z.string().optional().describe('Currency code or symbol'),
    defaultPlatformFeeRate: z.number().optional().describe('Default platform fee rate if no fee is found. Accepts 0.05 or 5 for 5%.'),
    defaultAdCostRate: z.number().optional().describe('Default ad cost rate if no ad spend is found. Accepts 0.12 or 12 for 12%.'),
  },
}, async (args: any) => ok(analyzeOrderProfit(args)));

server.registerTool('inventory_restock_plan', {
  description: 'Create a SKU restock plan from inventory, daily sales velocity, supplier lead time, safety stock, and target stock days.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    inventoryText: z.string().describe('Inventory lines. Example: SKU A stock 120 daily 8 lead 10 safety 5.'),
    targetStockDays: z.number().optional().describe('Target days of stock after reorder. Default 30.'),
    defaultLeadTimeDays: z.number().optional().describe('Default supplier lead time in days if line has no lead time.'),
    defaultSafetyStockDays: z.number().optional().describe('Default safety stock days if line has no safety value.'),
  },
}, async (args: any) => ok(planInventoryRestock(args)));

server.registerTool('platform_settlement_reconcile', {
  description: 'Reconcile a pasted platform settlement statement into payments, refunds, fees, ad spend, freight, adjustments, expected net, and evidence checklist.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    settlementText: z.string().describe('Pasted platform settlement or monthly statement lines'),
    expectedOrderRevenue: z.number().optional().describe('Expected gross order revenue from order export'),
    expectedRefunds: z.number().optional().describe('Expected refunds from order/refund export'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(reconcileSettlement(args)));

server.registerTool('campaign_roi_analyzer', {
  description: 'Analyze marketplace ad/campaign lines into ROAS, CPA, margin-aware contribution after ads, scale candidates, and campaigns to fix or trim.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    campaignText: z.string().describe('Campaign lines. Example: Campaign A spend 300 revenue 1500 orders 20 clicks 800 impressions 20000.'),
    currency: z.string().optional().describe('Currency code or symbol'),
    grossMarginRate: z.number().optional().describe('User-provided gross margin before ads. Accepts 0.35 or 35 for 35%. If missing, profit remains unknown; never invent a margin.'),
    targetRoas: z.number().optional().describe('Target ROAS. Defaults to gross-margin break-even.'),
  },
}, async (args: any) => ok(analyzeCampaignRoi(args)));

server.registerTool('after_sales_risk_report', {
  description: 'Analyze refund/return/complaint lines by SKU, estimate refund rates, infer likely cause buckets, and list high-risk SKUs.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    afterSalesText: z.string().describe('After-sales lines. Example: SKU A orders 300 refunds 25 refundAmount 1200 complaints 6 quality.'),
    totalOrders: z.number().optional().describe('Overall order count for the period if not included in lines'),
    totalRevenue: z.number().optional().describe('Overall revenue for refund amount rate'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(buildAfterSalesRiskReport(args)));

server.registerTool('review_insight_analyzer', {
  description: 'Read-only analysis of CSV, TSV, JSON, JSONL, or one-comment-per-line marketplace reviews into rating, sentiment, issue themes, negative samples, and negative-review risk. Records are deduplicated and personal identifiers are masked before analysis.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    reviewText: z.string().min(1).max(10_000_000).describe('CSV, TSV, JSON, JSONL, or one review per line'),
    sourceFormat: z.enum(['auto', 'csv', 'tsv', 'json', 'jsonl', 'plain']).optional().describe('Source format. Defaults to auto-detection.'),
    platform: z.string().max(160).optional().describe('Marketplace/channel applied when the export omits a platform column'),
    storeId: z.string().max(160).optional().describe('Store identifier applied when the export omits a store column'),
    contentColumn: z.string().optional().describe('Exact source column containing review text when auto-detection is insufficient'),
    skuColumn: z.string().optional().describe('Exact source SKU column'),
    ratingColumn: z.string().optional().describe('Exact source rating/star column'),
    dateColumn: z.string().optional().describe('Exact source review-date column'),
    helpfulColumn: z.string().optional().describe('Exact source helpful/like-count column'),
  },
}, async (args: any) => ok(analyzeReviewInsights(args)));

server.registerTool('review_source_normalizer', {
  description: 'Normalize supplied CSV, TSV, JSON, JSONL, or plain-text reviews into a versioned read-only schema, mask PII, strip URL secrets, generate stable IDs, deduplicate records, paginate output, and run the existing review insight analysis. Does not read local files or call external platforms.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    sourceText: z.string().min(1).max(10_000_000).describe('Review export content supplied directly by the user or another authorized tool'),
    sourceFormat: z.enum(['auto', 'csv', 'tsv', 'json', 'jsonl', 'plain']).optional().describe('Source format. Defaults to auto-detection.'),
    platform: z.string().max(160).optional().describe('Marketplace/channel override, such as shopline, shopify, woocommerce, taobao, or douyin'),
    storeId: z.string().max(160).optional().describe('Store identifier override used for multi-store isolation'),
    mapping: z.object({
      reviewId: z.string().optional(),
      platform: z.string().optional(),
      storeId: z.string().optional(),
      productId: z.string().optional(),
      sku: z.string().optional(),
      rating: z.string().optional(),
      content: z.string().optional(),
      createdAt: z.string().optional(),
      verifiedPurchase: z.string().optional(),
      replyStatus: z.string().optional(),
      sourceUrl: z.string().optional(),
      helpfulCount: z.string().optional(),
    }).optional().describe('Exact source columns or dotted JSON paths when automatic mapping is insufficient'),
    cursor: z.number().int().min(0).optional().describe('Zero-based normalized-record cursor. Defaults to 0.'),
    limit: z.number().int().min(1).max(500).optional().describe('Maximum normalized records returned on this page. Defaults to 100.'),
  },
}, async (args: any) => ok(normalizeReviewSourceImport(args)));

server.registerTool('ecommerce_snapshot_analyzer', {
  description: 'Combine one or more marketplace report exports into the same read-only profit, ROAS, refund, inventory, review, SKU, and risk snapshot used by the Commerce Command Center.',
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  inputSchema: {
    ordersReport: z.string().max(10_000_000).optional().describe('Delimited orders/profit report with a header row'),
    campaignsReport: z.string().max(10_000_000).optional().describe('Delimited campaign performance report with a header row'),
    inventoryReport: z.string().max(10_000_000).optional().describe('Delimited inventory report with a header row'),
    afterSalesReport: z.string().max(10_000_000).optional().describe('Delimited refunds/after-sales report with a header row'),
    reviewsReport: z.string().max(10_000_000).optional().describe('Delimited review report or one review per line'),
    grossMarginRate: z.number().optional().describe('Gross margin rate used for campaign break-even, e.g. 0.35 or 35 for 35%'),
    targetStockDays: z.number().min(1).max(365).optional().describe('Target inventory days used for suggested reorder quantity'),
  },
}, async (args: any) => ok(analyzeEcommerceSnapshot(args)));

}
