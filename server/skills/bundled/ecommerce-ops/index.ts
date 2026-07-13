import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeOrderProfit,
  analyzeCampaignRoi,
  buildAfterSalesRiskReport,
  buildListingOptimizer,
  planInventoryRestock,
  reconcileSettlement,
} from './logic';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'ecommerce-ops', version: '1.3.0' }, { capabilities: { tools: {} } });

server.registerTool('product_listing_optimizer', {
  description: 'Create marketplace-ready product title options, selling points, search keywords, image shot list, and compliance checks.',
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
  inputSchema: {
    orderText: z.string().describe('Order or SKU lines. Example: SKU A sales 1200 cost 500 shipping 80 ads 120 fee 60 refund 0 units 10.'),
    currency: z.string().optional().describe('Currency code or symbol'),
    defaultPlatformFeeRate: z.number().optional().describe('Default platform fee rate if no fee is found. Accepts 0.05 or 5 for 5%.'),
    defaultAdCostRate: z.number().optional().describe('Default ad cost rate if no ad spend is found. Accepts 0.12 or 12 for 12%.'),
  },
}, async (args: any) => ok(analyzeOrderProfit(args)));

server.registerTool('inventory_restock_plan', {
  description: 'Create a SKU restock plan from inventory, daily sales velocity, supplier lead time, safety stock, and target stock days.',
  inputSchema: {
    inventoryText: z.string().describe('Inventory lines. Example: SKU A stock 120 daily 8 lead 10 safety 5.'),
    targetStockDays: z.number().optional().describe('Target days of stock after reorder. Default 30.'),
    defaultLeadTimeDays: z.number().optional().describe('Default supplier lead time in days if line has no lead time.'),
    defaultSafetyStockDays: z.number().optional().describe('Default safety stock days if line has no safety value.'),
  },
}, async (args: any) => ok(planInventoryRestock(args)));

server.registerTool('platform_settlement_reconcile', {
  description: 'Reconcile a pasted platform settlement statement into payments, refunds, fees, ad spend, freight, adjustments, expected net, and evidence checklist.',
  inputSchema: {
    settlementText: z.string().describe('Pasted platform settlement or monthly statement lines'),
    expectedOrderRevenue: z.number().optional().describe('Expected gross order revenue from order export'),
    expectedRefunds: z.number().optional().describe('Expected refunds from order/refund export'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(reconcileSettlement(args)));

server.registerTool('campaign_roi_analyzer', {
  description: 'Analyze marketplace ad/campaign lines into ROAS, CPA, margin-aware contribution after ads, scale candidates, and campaigns to fix or trim.',
  inputSchema: {
    campaignText: z.string().describe('Campaign lines. Example: Campaign A spend 300 revenue 1500 orders 20 clicks 800 impressions 20000.'),
    currency: z.string().optional().describe('Currency code or symbol'),
    grossMarginRate: z.number().optional().describe('Gross margin rate before ads. Accepts 0.35 or 35 for 35%. Default 35%.'),
    targetRoas: z.number().optional().describe('Target ROAS. Defaults to gross-margin break-even.'),
  },
}, async (args: any) => ok(analyzeCampaignRoi(args)));

server.registerTool('after_sales_risk_report', {
  description: 'Analyze refund/return/complaint lines by SKU, estimate refund rates, infer likely cause buckets, and list high-risk SKUs.',
  inputSchema: {
    afterSalesText: z.string().describe('After-sales lines. Example: SKU A orders 300 refunds 25 refundAmount 1200 complaints 6 quality.'),
    totalOrders: z.number().optional().describe('Overall order count for the period if not included in lines'),
    totalRevenue: z.number().optional().describe('Overall revenue for refund amount rate'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(buildAfterSalesRiskReport(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
