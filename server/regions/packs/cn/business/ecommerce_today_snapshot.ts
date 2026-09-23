import type { ToolContext, ToolExecutionRecord } from '../../../../tools/types';
import { parseEcommerceTodaySource } from '../../../../industry/source_bound_arguments';
import { recordIndustryWorkflowExecution, startOrReuseIndustryWorkflow } from '../../../../industry/workflow_service';

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function amount(value: number | undefined, digits = 0): string {
  return value === undefined
    ? '\u672a\u63d0\u4f9b'
    : value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function percent(value: number | undefined): string {
  return value === undefined ? '\u672a\u63d0\u4f9b' : `${amount(value, 2)}%`;
}

export interface EcommerceTodaySnapshotReceipt {
  ok: boolean;
  status: string;
  persisted: boolean;
  taskId: string;
  conversationTaskId: string;
  message: string;
  sourceBound: true;
  externalMutation: false;
  snapshot: Record<string, unknown>;
  missingMetrics: string[];
  verification: Record<string, unknown>;
}

/**
 * Deterministic, receipt-producing daily snapshot for labelled inline data.
 * It is intentionally narrow: it never logs into a store and never turns an
 * absent cost field into zero. Larger imports continue through the regular
 * industry workflow and file-reading tools.
 */
export function executeEcommerceTodaySnapshot(context?: ToolContext): EcommerceTodaySnapshotReceipt {
  const sourceInput = String(context?.industryWorkflowSourceInput || context?.actionIntent || context?.routedTaskText || '').trim();
  const facts = parseEcommerceTodaySource(sourceInput);
  if (facts.revenue === undefined || facts.orders === undefined) {
    throw new Error('\u4eca\u65e5\u7ecf\u8425\u5feb\u7167\u7f3a\u5c11\u660e\u786e\u7684\u9500\u552e\u989d\u6216\u8ba2\u5355\u6570\uff0c\u5df2\u505c\u6b62\u8ba1\u7b97\u800c\u4e0d\u662f\u731c\u6d4b\u3002');
  }

  const userId = context?.userId || 'anonymous';
  const domain = context?.domain === 'work' ? 'work' as const : 'personal' as const;
  const orgId = domain === 'work' ? String(context?.orgId || '') : '';
  const requestId = String(context?.requestId || context?.turnId || `industry_today_${Date.now()}`);
  const started = startOrReuseIndustryWorkflow({
    userId,
    domain,
    orgId,
    entryId: 'today-operations',
    sourceInput,
    source: context?.source || 'industry_structured_snapshot',
    context: { sourceBound: true, externalMutation: false },
    idempotencyKey: `industry-today-snapshot:${requestId}`,
    conversationId: context?.conversationId,
    conversationTaskId: context?.taskId,
    requestId,
  }, context?.industryWorkflowTaskId);

  const averageOrderValue = facts.orders > 0 ? round(facts.revenue / facts.orders) : undefined;
  const roas = facts.adSpend !== undefined && facts.adSpend > 0 ? round(facts.revenue / facts.adSpend) : undefined;
  const adSpendRate = facts.adSpend !== undefined && facts.revenue > 0 ? round(facts.adSpend / facts.revenue * 100) : undefined;
  const refundAmountRate = facts.refundAmount !== undefined && facts.revenue > 0 ? round(facts.refundAmount / facts.revenue * 100) : undefined;
  const afterSalesRate = facts.afterSalesCount !== undefined && facts.orders > 0 ? round(facts.afterSalesCount / facts.orders * 100) : undefined;
  const lowStock = facts.inventory.filter(item => item.stock <= 10);

  const missingMetrics = [
    facts.cogs === undefined ? '\u5546\u54c1\u6210\u672c' : '',
    facts.shipping === undefined ? '\u7269\u6d41\u6210\u672c' : '',
    facts.platformFees === undefined ? '\u5e73\u53f0\u8d39/\u4f63\u91d1' : '',
    facts.adSpend === undefined ? '\u5e7f\u544a\u82b1\u8d39' : '',
    facts.refundAmount === undefined ? '\u9000\u6b3e\u91d1\u989d' : '',
  ].filter(Boolean);

  const workflow = started.task.metadata?.industryWorkflow || {};
  const workspace = workflow.context?.industryWorkspace || {};
  const storeName = String(workspace.name || '\u5f53\u524d\u5e97\u94fa');
  const platform = String(workspace.attributes?.platform || '\u5f53\u524d\u5e73\u53f0');
  const reportingPeriod = facts.reportingPeriod
    || String(workspace.attributes?.reportingPeriod || '\u5f53\u524d\u5468\u671f');
  const currency = facts.currency || String(workspace.attributes?.currency || 'CNY');
  const riskLines = [
    ...(lowStock.length
      ? [`- P0 \u5e93\u5b58\u98ce\u9669\uff1a${lowStock.map(item => `${item.sku} \u4ec5 ${amount(item.stock)} \u4ef6`).join('\uff1b')}\u3002`]
      : []),
    ...(afterSalesRate !== undefined
      ? [`- P0 \u552e\u540e\u5173\u6ce8\uff1a${amount(facts.afterSalesCount)} \u5355\uff0c\u5360\u8ba2\u5355 ${percent(afterSalesRate)}\uff1b\u9700\u6309 SKU \u548c\u539f\u56e0\u62c6\u5206\u540e\u624d\u80fd\u5b9a\u6027\u3002`]
      : []),
    ...(refundAmountRate !== undefined
      ? [`- P0 \u9000\u6b3e\u91d1\u989d\u5360\u6bd4\uff1a${percent(refundAmountRate)}\uff1b\u8fd9\u662f\u5f53\u524d\u6570\u636e\u7684\u98ce\u9669\u4fe1\u53f7\uff0c\u4e0d\u4ee3\u66ff\u5e97\u94fa\u9608\u503c\u3002`]
      : []),
    ...(adSpendRate !== undefined
      ? [`- P1 \u6295\u653e\u5360\u6bd4\uff1a${percent(adSpendRate)}\uff0cROAS ${amount(roas, 2)}\uff1b\u56e0\u7f3a\u5c11\u6bdb\u5229\u53e3\u5f84\uff0c\u4e0d\u5224\u5b9a\u662f\u5426\u76c8\u5229\u3002`]
      : []),
  ];
  if (riskLines.length === 0) riskLines.push('- \u5df2\u8ba1\u7b97\u5feb\u7167\uff0c\u4f46\u73b0\u6709\u5b57\u6bb5\u4e0d\u8db3\u4ee5\u8bbe\u5b9a\u5e97\u94fa\u5f02\u5e38\u9608\u503c\u3002');

  const actionLines = [
    ...(lowStock.length ? ['1. P0\uff5c\u5546\u54c1/\u4f9b\u5e94\u94fe\u8d1f\u8d23\u4eba\uff1a\u6838\u5bf9\u4f4e\u5e93\u5b58 SKU \u7684\u65e5\u9500\u3001\u5728\u9014\u5e93\u5b58\u548c\u4ea4\u671f\uff0c\u518d\u51b3\u5b9a\u8865\u8d27\u6216\u9650\u6d41\u3002'] : []),
    ...(facts.afterSalesCount !== undefined ? [`${lowStock.length ? 2 : 1}. P0\uff5c\u5ba2\u670d/\u552e\u540e\u8d1f\u8d23\u4eba\uff1a\u590d\u6838 ${amount(facts.afterSalesCount)} \u5355\u552e\u540e\uff0c\u6309 SKU\u3001\u539f\u56e0\u548c\u8d23\u4efb\u5f52\u5c5e\u5f52\u7c7b\u3002`] : []),
    `${(lowStock.length ? 1 : 0) + (facts.afterSalesCount !== undefined ? 1 : 0) + 1}. P1\uff5c\u6295\u653e\u8d1f\u8d23\u4eba\uff1a\u5148\u6309\u8ba1\u5212\u62c6\u5206\u6d88\u8017\u3001\u6536\u5165\u548c\u8ba2\u5355\uff0c\u5728\u8865\u9f50\u6bdb\u5229\u540e\u518d\u51b3\u5b9a\u653e\u91cf\u6216\u7f29\u91cf\u3002`,
    `${(lowStock.length ? 1 : 0) + (facts.afterSalesCount !== undefined ? 1 : 0) + 2}. P1\uff5c\u6570\u636e/\u8d22\u52a1\u8d1f\u8d23\u4eba\uff1a\u8865\u9f50${missingMetrics.join('\u3001') || '\u5404\u6210\u672c\u53e3\u5f84'}\uff0c\u518d\u751f\u6210\u6bdb\u5229\u4e0e\u8d21\u732e\u5229\u6da6\u3002`,
  ];

  const message = [
    `\u4eca\u65e5\u7ecf\u8425\u5206\u6790\u5df2\u5b8c\u6210\uff0c\u5e76\u7531\u670d\u52a1\u5668\u6309\u539f\u59cb\u5b57\u6bb5\u751f\u6210\u56de\u6267\uff08\u4efb\u52a1 ${started.task.id}\uff09\u3002`,
    '',
    `## ${storeName}\uff5c${platform}\uff5c${reportingPeriod}\uff5c${currency}`,
    '',
    '### \u53ef\u590d\u6838\u7ecf\u8425\u5feb\u7167',
    `- \u9500\u552e\u989d\uff1a${amount(facts.revenue)} \u5143\uff1b\u8ba2\u5355\uff1a${amount(facts.orders)} \u5355\uff1b\u5ba2\u5355\u4ef7\uff1a${amount(averageOrderValue, 2)} \u5143\u3002`,
    `- \u5e7f\u544a\u82b1\u8d39\uff1a${amount(facts.adSpend)} \u5143\uff1b\u6295\u653e\u5360\u6bd4\uff1a${percent(adSpendRate)}\uff1bROAS\uff1a${amount(roas, 2)}\u3002`,
    `- \u9000\u6b3e\u91d1\u989d\uff1a${amount(facts.refundAmount)} \u5143\uff1b\u9000\u6b3e\u91d1\u989d\u5360\u6bd4\uff1a${percent(refundAmountRate)}\u3002`,
    `- \u552e\u540e\uff1a${amount(facts.afterSalesCount)} \u5355\uff1b\u552e\u540e\u7387\uff1a${percent(afterSalesRate)}\u3002`,
    `- \u5e93\u5b58\uff1a${facts.inventory.length ? facts.inventory.map(item => `${item.sku} ${amount(item.stock)} \u4ef6`).join('\uff1b') : '\u672a\u63d0\u4f9b SKU \u5e93\u5b58'}\u3002`,
    '',
    '### \u5f02\u5e38/\u98ce\u9669\u4fe1\u53f7',
    ...riskLines,
    '',
    '### \u6309\u4f18\u5148\u7ea7\u7684\u884c\u52a8\u6e05\u5355',
    ...actionLines,
    '',
    `\u53e3\u5f84\u7f3a\u53e3\uff1a${missingMetrics.length ? missingMetrics.join('\u3001') : '\u65e0'}\u3002${missingMetrics.length ? '\u56e0\u6b64\u672c\u6b21\u4e0d\u8ba1\u7b97\u6bdb\u5229\u6216\u8d21\u732e\u5229\u6da6\uff0c\u4e5f\u4e0d\u628a\u7f3a\u5931\u503c\u5f53\u6210 0\u3002' : ''}`,
    '\u6267\u884c\u8fb9\u754c\uff1a\u672c\u6b21\u53ea\u5206\u6790\u4f60\u63d0\u4f9b\u7684\u6570\u636e\uff0c\u672a\u8fde\u63a5\u3001\u4fee\u6539\u6216\u5411\u771f\u5b9e\u5e97\u94fa\u63d0\u4ea4\u4efb\u4f55\u64cd\u4f5c\u3002',
  ].join('\n');

  const snapshot = {
    revenue: facts.revenue,
    orders: facts.orders,
    averageOrderValue,
    adSpend: facts.adSpend,
    adSpendRate,
    roas,
    refundAmount: facts.refundAmount,
    refundAmountRate,
    afterSalesCount: facts.afterSalesCount,
    afterSalesRate,
    inventory: facts.inventory,
    lowStock,
  };
  const calculationReceipt: ToolExecutionRecord = {
    id: `industry-today-${requestId}`,
    taskId: started.conversationTaskId,
    turnId: requestId,
    requestId,
    name: 'industry_ecommerce_today_snapshot',
    arguments: { sourceBound: true },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      taskId: started.task.id,
      conversationTaskId: started.conversationTaskId,
      sourceBound: true,
      externalMutation: false,
      snapshot,
      missingMetrics,
    }),
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'Every metric was calculated from explicitly labelled source fields.',
    },
  };
  const recorded = recordIndustryWorkflowExecution({
    userId,
    domain,
    orgId,
    taskId: started.task.id,
    resultText: message,
    toolRecords: [calculationReceipt],
    source: context?.source || 'industry_structured_snapshot',
  });

  return {
    ok: recorded.verification.passed,
    status: recorded.verification.passed ? 'verified' : recorded.verification.status,
    persisted: true,
    taskId: recorded.task.id,
    conversationTaskId: recorded.conversationTaskId,
    message,
    sourceBound: true,
    externalMutation: false,
    snapshot,
    missingMetrics,
    verification: recorded.verification as unknown as Record<string, unknown>,
  };
}
