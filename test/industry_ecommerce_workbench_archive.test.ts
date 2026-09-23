import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { recordEcommerceWorkbenchArchive } from '../server/industry/ecommerce_workbench_archive';
import { startIndustryWorkflow } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

describe('Store Data server-owned archive receipt', () => {
  it('persists a bounded normalized summary and verifies through the required domain receipt', () => {
    const userId = `workbench_archive_${Date.now()}`;
    const started = startIndustryWorkflow({
      userId,
      domain: 'personal',
      orgId: '',
      entryId: 'store-data',
      sourceInput: JSON.stringify({ platform: 'douyin', sourceRows: [{ kind: 'orders', rowCount: 2 }] }),
      source: 'archive_test',
    });
    const recorded = recordEcommerceWorkbenchArchive({
      userId,
      domain: 'personal',
      orgId: '',
      taskId: started.task.id,
      source: 'archive_test',
      workbenchInput: {
        reports: { orders: { headers: ['sku', 'revenue'], rows: [{ sku: 'SKU-1', revenue: 600 }, { sku: 'SKU-1', revenue: 600 }] }, inventory: { headers: ['sku', 'stock', 'dailySales'], rows: [{ sku: 'SKU-1', stock: 3, dailySales: 2 }] } },
        platform: 'douyin',
        sourceNames: { orders: 'C:\\private\\orders.csv', inventory: '../inventory.csv' },
        grossMarginPercent: 35,
        targetStockDays: 30,
        snapshot: {
          sources: [
            { kind: 'orders', rowCount: 2, mappedFields: ['sku', 'revenue'], missingRecommendedFields: ['cogs'] },
            { kind: 'inventory', rowCount: 1, mappedFields: ['sku', 'stock', 'dailySales'], missingRecommendedFields: [] },
          ],
          metrics: {
            gmv: 1200,
            netRevenue: 1140,
            contributionProfit: 300,
            contributionMargin: 26.32,
            adSpend: 100,
            roas: 12,
            refundRate: 5,
            orderCount: 20,
          },
          risks: [{ code: 'missing_cost', severity: 'medium', value: 1, items: ['SKU-1'] }],
          topSkus: [{ sku: 'SKU-1', revenue: 1200, contributionProfit: 300, contributionMargin: 25, units: 20 }],
          campaigns: [],
          inventoryAlerts: [{ sku: 'SKU-1', stock: 4, dailySales: 2, daysCover: 2, suggestedOrderQty: 56, status: 'urgent' }],
          reviewInsights: {
            totalReviews: 2,
            averageRating: 3.5,
            positiveRate: 50,
            negativeRate: 50,
            topics: [{ topic: 'fit', count: 1, negativeCount: 1, negativeRate: 100 }],
            negativeSamples: [{ content: 'PRIVATE REVIEW CONTENT MUST NOT BE PERSISTED' }],
          },
        },
      },
    });

    expect(recorded.task.status).toBe('delivered');
    expect(recorded.verification.passed).toBe(true);
    expect(recorded.verification.checks.find(check => check.id === 'required_domain_tool_evidence')?.passed).toBe(true);
    expect(recorded.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(recorded.normalizedInputSummary.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'orders', sourceName: 'orders.csv', rowCount: 2 }),
      expect.objectContaining({ kind: 'inventory', sourceName: 'inventory.csv', rowCount: 1 }),
    ]));
    expect(recorded.task.metadata.industryWorkflow.normalizedInputDigest).toBe(recorded.inputDigest);
    expect(recorded.task.result).toContain('server-normalized workbench input summary');
    expect(JSON.stringify(recorded.task)).not.toContain('PRIVATE REVIEW CONTENT MUST NOT BE PERSISTED');
    expect(JSON.stringify(recorded.task)).not.toContain('C:\\private');
    expect(JSON.stringify(recorded.task)).not.toContain('../inventory.csv');
    expect(recorded.task.metadata.workTakeoverToolRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'industry_ecommerce_store_data_snapshot',
        terminalVerification: expect.objectContaining({ status: 'verified' }),
      }),
    ]));
  });
});
