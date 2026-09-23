import { analyzeEcommerceWorkbench } from '../../../../skills/bundled/ecommerce-ops/workbench';
import crypto from 'node:crypto';
import type { ToolExecutionRecord } from '../../../../tools/types';
import { updateWorkTakeoverTask } from '../../../../work_takeover/tasks';
import {
  getIndustryWorkflowTask,
  recordIndustryWorkflowExecution,
  type IndustryWorkflowRecordResult,
  type IndustryWorkflowScope,
} from '../../../../industry/workflow_service';

const REPORT_KINDS = new Set(['orders', 'campaigns', 'inventory', 'afterSales', 'reviews']);
const RISK_CODES = new Set([
  'missing_cost',
  'negative_profit',
  'high_ad_cost',
  'low_roas',
  'high_refund',
  'negative_reviews',
  'urgent_restock',
]);

function text(value: unknown, limit = 160): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedList(value: unknown, limit: number, itemLimit = 120): string[] {
  return Array.isArray(value)
    ? value.slice(0, limit).map(item => text(item, itemLimit)).filter(Boolean)
    : [];
}

function sourceFileName(value: unknown): string {
  return text(value, 180).split(/[\\/]/).pop() || '';
}

export interface EcommerceWorkbenchArchiveSummary {
  schemaVersion: 1;
  platform: string;
  assumptions: { grossMarginPercent: number; targetStockDays: number };
  sources: Array<{
    kind: string;
    sourceName: string;
    rowCount: number;
    mappedFields: string[];
    missingRecommendedFields: string[];
  }>;
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
  risks: Array<{ code: string; severity: 'high' | 'medium'; value: number; items: string[] }>;
  topSkus: Array<{ sku: string; revenue: number; contributionProfit: number; contributionMargin: number; units: number }>;
  campaigns: Array<{ campaign: string; spend: number; revenue: number; orders: number; roas: number; status: string }>;
  inventoryAlerts: Array<{ sku: string; stock: number; dailySales: number; daysCover: number | null; suggestedOrderQty: number; status: string }>;
  reviewSummary: {
    totalReviews: number;
    averageRating: number | null;
    positiveRate: number;
    negativeRate: number;
    topics: Array<{ topic: string; count: number; negativeCount: number; negativeRate: number }>;
  };
}

function normalizeSummary(value: unknown): EcommerceWorkbenchArchiveSummary {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
  const snapshot = input.snapshot && typeof input.snapshot === 'object' && !Array.isArray(input.snapshot)
    ? input.snapshot as Record<string, any>
    : {};
  const sourceNames = input.sourceNames && typeof input.sourceNames === 'object' && !Array.isArray(input.sourceNames)
    ? input.sourceNames as Record<string, unknown>
    : {};
  const seenKinds = new Set<string>();
  const sources = (Array.isArray(snapshot.sources) ? snapshot.sources : [])
    .slice(0, REPORT_KINDS.size)
    .map((raw: any) => {
      const kind = text(raw?.kind, 32);
      if (!REPORT_KINDS.has(kind) || seenKinds.has(kind)) return null;
      seenKinds.add(kind);
      return {
        kind,
        sourceName: sourceFileName(sourceNames[kind]),
        rowCount: Math.max(0, Math.min(50_000, Math.trunc(finite(raw?.rowCount)))),
        mappedFields: boundedList(raw?.mappedFields, 30, 64),
        missingRecommendedFields: boundedList(raw?.missingRecommendedFields, 30, 64),
      };
    })
    .filter((source): source is NonNullable<typeof source> => Boolean(source));
  if (!sources.length || sources.every(source => source.rowCount === 0)) {
    throw new Error('A non-empty normalized Store Data source summary is required for archive.');
  }

  const metrics = snapshot.metrics && typeof snapshot.metrics === 'object' ? snapshot.metrics : {};
  const review = snapshot.reviewInsights && typeof snapshot.reviewInsights === 'object' ? snapshot.reviewInsights : {};
  return {
    schemaVersion: 1,
    platform: text(input.platform, 64) || 'generic',
    assumptions: {
      grossMarginPercent: Math.max(0, Math.min(100, finite(input.grossMarginPercent, 35))),
      targetStockDays: Math.max(1, Math.min(365, finite(input.targetStockDays, 30))),
    },
    sources,
    metrics: {
      gmv: finite(metrics.gmv),
      netRevenue: finite(metrics.netRevenue),
      contributionProfit: finite(metrics.contributionProfit),
      contributionMargin: finite(metrics.contributionMargin),
      adSpend: finite(metrics.adSpend),
      roas: finite(metrics.roas),
      refundRate: finite(metrics.refundRate),
      orderCount: finite(metrics.orderCount),
    },
    risks: (Array.isArray(snapshot.risks) ? snapshot.risks : []).slice(0, 30).flatMap((raw: any) => {
      const code = text(raw?.code, 48);
      if (!RISK_CODES.has(code)) return [];
      return [{
        code,
        severity: raw?.severity === 'high' ? 'high' as const : 'medium' as const,
        value: finite(raw?.value),
        items: boundedList(raw?.items, 30, 96),
      }];
    }),
    topSkus: (Array.isArray(snapshot.topSkus) ? snapshot.topSkus : []).slice(0, 30).map((raw: any) => ({
      sku: text(raw?.sku, 96),
      revenue: finite(raw?.revenue),
      contributionProfit: finite(raw?.contributionProfit),
      contributionMargin: finite(raw?.contributionMargin),
      units: finite(raw?.units),
    })).filter(item => item.sku),
    campaigns: (Array.isArray(snapshot.campaigns) ? snapshot.campaigns : []).slice(0, 30).map((raw: any) => ({
      campaign: text(raw?.campaign, 120),
      spend: finite(raw?.spend),
      revenue: finite(raw?.revenue),
      orders: finite(raw?.orders),
      roas: finite(raw?.roas),
      status: text(raw?.status, 24),
    })).filter(item => item.campaign),
    inventoryAlerts: (Array.isArray(snapshot.inventoryAlerts) ? snapshot.inventoryAlerts : []).slice(0, 50).map((raw: any) => ({
      sku: text(raw?.sku, 96),
      stock: finite(raw?.stock),
      dailySales: finite(raw?.dailySales),
      daysCover: raw?.daysCover === null ? null : finite(raw?.daysCover),
      suggestedOrderQty: finite(raw?.suggestedOrderQty),
      status: text(raw?.status, 24),
    })).filter(item => item.sku),
    reviewSummary: {
      totalReviews: finite(review.totalReviews),
      averageRating: review.averageRating === null ? null : finite(review.averageRating),
      positiveRate: finite(review.positiveRate),
      negativeRate: finite(review.negativeRate),
      topics: (Array.isArray(review.topics) ? review.topics : []).slice(0, 12).map((raw: any) => ({
        topic: text(raw?.topic, 48),
        count: finite(raw?.count),
        negativeCount: finite(raw?.negativeCount),
        negativeRate: finite(raw?.negativeRate),
      })).filter(item => item.topic),
    },
  };
}

function archiveResultText(summary: EcommerceWorkbenchArchiveSummary, digest: string): string {
  const sourceLine = summary.sources.map(source => (
    `${source.kind}: rows=${source.rowCount}, mapping=${source.mappedFields.join('|') || 'none'}, missing=${source.missingRecommendedFields.join('|') || 'none'}`
  )).join('; ');
  const riskLine = summary.risks.length
    ? summary.risks.map(risk => `${risk.code}=${risk.value}`).join('; ')
    : 'none observed in the normalized snapshot';
  return [
    'Store data diagnosis archived from a server-normalized workbench input summary.',
    `Source and mapping summary: ${sourceLine}.`,
    `Revenue/GMV=${summary.metrics.gmv}; net revenue=${summary.metrics.netRevenue}; orders=${summary.metrics.orderCount}.`,
    `Refund rate=${summary.metrics.refundRate}%; advertising ROAS=${summary.metrics.roas}; contribution profit=${summary.metrics.contributionProfit}.`,
    `Inventory alerts=${summary.inventoryAlerts.length}; review rows=${summary.reviewSummary.totalReviews}; risks=${riskLine}.`,
    `Input summary digest=${digest}.`,
    'Boundary: this receipt proves local normalization, calculation-archive intake, and persistent analysis only. It does not prove any external store read or mutation.',
  ].join('\n');
}

export function recordEcommerceWorkbenchArchive(input: IndustryWorkflowScope & {
  taskId: string;
  workbenchInput: unknown;
  source?: string;
}): IndustryWorkflowRecordResult & { normalizedInputSummary: EcommerceWorkbenchArchiveSummary; inputDigest: string } {
  const task = getIndustryWorkflowTask(input, input.taskId);
  if (!task) throw new Error('Industry workflow task was not found in the active user scope.');
  if (task.metadata?.industryWorkflow?.entryId !== 'store-data') {
    throw new Error('Structured Store Data archive input is accepted only for the store-data workflow.');
  }
  const raw = input.workbenchInput as Record<string, any>;
  const reports = raw?.reports;
  if (!reports || typeof reports !== 'object' || Array.isArray(reports) || JSON.stringify(reports).length > 1_500_000) throw new Error('Bounded original report rows are required; browser totals are not verification evidence.');
  for (const [kind, table] of Object.entries(reports) as [string, any][]) {
    if (!REPORT_KINDS.has(kind) || !Array.isArray(table?.headers) || !Array.isArray(table?.rows) || table.rows.length > 50_000
      || table.headers.some((cell: any) => typeof cell !== 'string')
      || table.rows.some((row: any) => !row || typeof row !== 'object' || Array.isArray(row) || Object.values(row).some(cell => !['string', 'number'].includes(typeof cell)))) throw new Error('Invalid report table');
  }
  const snapshot = analyzeEcommerceWorkbench(reports, { grossMarginRate: Math.max(0, Math.min(100, Number(raw.grossMarginPercent) || 0)) / 100, targetStockDays: Number(raw.targetStockDays) || 30, columnMappings: raw.columnMappings });
  const normalizedInputSummary = normalizeSummary({ ...raw, snapshot });
  const inputDigest = crypto.createHash('sha256')
    .update(JSON.stringify(normalizedInputSummary))
    .digest('hex');
  const receiptId = `industry-workbench-archive-${inputDigest.slice(0, 20)}`;
  const previousVerification = task.metadata?.workTakeoverVerification;
  const exactReplay = task.metadata?.industryWorkflow?.normalizedInputDigest === inputDigest
    && Array.isArray(task.metadata?.workTakeoverToolRuns)
    && task.metadata.workTakeoverToolRuns.some((run: any) => (
      run?.id === receiptId
      && run?.toolName === 'industry_ecommerce_store_data_snapshot'
      && run?.taskId === String(task.metadata?.industryWorkflow?.conversationTaskId || '')
      && run?.requestId === String(task.metadata?.industryWorkflow?.requestId || '')
    ));
  if (exactReplay && previousVerification) {
    return {
      task,
      verification: previousVerification,
      conversationTaskId: String(task.metadata?.industryWorkflow?.conversationTaskId || ''),
      archivedFilePaths: [],
      normalizedInputSummary,
      inputDigest,
    };
  }
  updateWorkTakeoverTask(input.userId, task.id, {
    metadata: {
      industryWorkflow: {
        ...(task.metadata?.industryWorkflow || {}),
        normalizedInputSummary,
        originalReports: reports,
        originalColumnMappings: raw.columnMappings || {},
        normalizedInputDigest: inputDigest,
        normalizedInputArchivedAt: new Date().toISOString(),
      },
    },
    note: 'Server normalized and persisted the Store Data workbench input summary before verification.',
  });
  const resultText = archiveResultText(normalizedInputSummary, inputDigest);
  const receipt: ToolExecutionRecord = {
    id: receiptId,
    name: 'industry_ecommerce_store_data_snapshot',
    arguments: { sourceBound: true, inputDigest },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      persisted: true,
      taskId: task.id,
      conversationTaskId: String(task.metadata?.industryWorkflow?.conversationTaskId || ''),
      sourceBound: true,
      externalMutation: false,
      inputDigest,
      summary: normalizedInputSummary,
    }),
    taskId: String(task.metadata?.industryWorkflow?.conversationTaskId || ''),
    requestId: String(task.metadata?.industryWorkflow?.requestId || ''),
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'The server validated, bounded, digested, and persisted the structured Store Data workbench summary in this archive turn.',
    },
  };
  const recorded = recordIndustryWorkflowExecution({
    ...input,
    resultText,
    toolRecords: [receipt],
    source: input.source || 'ecommerce_data_workbench_archive',
  });
  return { ...recorded, normalizedInputSummary, inputDigest };
}
