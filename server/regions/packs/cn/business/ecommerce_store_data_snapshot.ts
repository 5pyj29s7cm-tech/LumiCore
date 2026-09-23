import type { ToolContext, ToolExecutionRecord } from '../../../../tools/types';
import { parseEcommerceTodaySource } from '../../../../industry/source_bound_arguments';
import { recordIndustryWorkflowExecution, startOrReuseIndustryWorkflow } from '../../../../industry/workflow_service';

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function amount(value: number | undefined, digits = 2): string {
  return value === undefined
    ? '未提供'
    : value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function labelledText(source: string, label: RegExp): string | undefined {
  const match = source.match(new RegExp(`(?:${label.source})\\s*[:：=]?\\s*([^；;。\\r\\n]+)`, 'iu'));
  return match?.[1]?.trim() || undefined;
}

function reportingPeriod(source: string): string | undefined {
  const range = source.match(/(?:期间|数据期间|reporting\s*period)\s*[:：=]?\s*(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|—|-)\s*(20\d{2}-\d{2}-\d{2})/iu);
  if (range) return `${range[1]} 至 ${range[2]}`;
  return labelledText(source, /期间|数据期间|reporting\s*period/iu);
}

export interface EcommerceStoreDataSnapshotReceipt {
  ok: boolean;
  status: string;
  persisted: boolean;
  taskId: string;
  conversationTaskId: string;
  message: string;
  sourceBound: true;
  externalMutation: false;
  snapshot: Record<string, unknown>;
  missingFields: string[];
  verification: Record<string, unknown>;
}

/**
 * Deterministic store-data diagnosis for explicitly labelled inline facts.
 * Inline facts are the sole source of truth for this path: no bound workspace,
 * previous report, account session, or external platform is read or mutated.
 */
export function executeEcommerceStoreDataSnapshot(context?: ToolContext): EcommerceStoreDataSnapshotReceipt {
  const sourceInput = String(context?.industryWorkflowSourceInput || context?.actionIntent || context?.routedTaskText || '').trim();
  const facts = parseEcommerceTodaySource(sourceInput);
  if (facts.revenue === undefined || facts.orders === undefined) {
    throw new Error('店铺数据诊断缺少明确的销售额或订单数，已停止计算而不是猜测。');
  }

  const platform = labelledText(sourceInput, /平台|platform/iu) || '未提供';
  const period = reportingPeriod(sourceInput) || '未提供';
  const currency = facts.currency || '未提供';
  const timezone = labelledText(sourceInput, /时区|timezone/iu);
  const userId = context?.userId || 'anonymous';
  const domain = context?.domain === 'work' ? 'work' as const : 'personal' as const;
  const orgId = domain === 'work' ? String(context?.orgId || '') : '';
  const requestId = String(context?.requestId || context?.turnId || `industry_store_data_${Date.now()}`);
  const started = startOrReuseIndustryWorkflow({
    userId,
    domain,
    orgId,
    entryId: 'store-data',
    sourceInput,
    source: context?.source || 'industry_structured_store_data',
    context: {
      sourceBound: true,
      externalMutation: false,
      inlineFactsOnly: true,
      platform,
      reportingPeriod: period,
      currency,
    },
    idempotencyKey: `industry-store-data-snapshot:${requestId}`,
    conversationId: context?.conversationId,
    conversationTaskId: context?.taskId,
    requestId,
  }, context?.industryWorkflowTaskId);

  const averageOrderValue = facts.orders > 0 ? round(facts.revenue / facts.orders) : undefined;
  const refundRate = facts.afterSalesCount !== undefined && facts.orders > 0
    ? round(facts.afterSalesCount / facts.orders * 100)
    : undefined;
  const refundAmountRate = facts.refundAmount !== undefined && facts.revenue > 0
    ? round(facts.refundAmount / facts.revenue * 100)
    : undefined;
  const roas = facts.adSpend !== undefined && facts.adSpend > 0
    ? round(facts.revenue / facts.adSpend)
    : undefined;
  const inventory = facts.inventory.map(item => ({
    ...item,
    daysCover: item.dailySales !== undefined && item.dailySales > 0
      ? round(item.stock / item.dailySales)
      : undefined,
  }));

  const missingFields = [
    timezone ? '' : '时区',
    facts.cogs === undefined ? '商品成本' : '',
    facts.shipping === undefined ? '物流成本' : '',
    facts.platformFees === undefined ? '平台费/佣金' : '',
    ...inventory.filter(item => item.dailySales === undefined).map(item => `${item.sku} 日均销量`),
  ].filter(Boolean);

  const mappingLines = [
    `- 平台 → platform：${platform}`,
    `- 期间 → reportingPeriod：${period}`,
    `- 币种 → currency：${currency}`,
    `- 销售额 → revenue：${amount(facts.revenue)} 元`,
    `- 订单数 → orders：${amount(facts.orders, 0)} 单`,
    `- 广告花费 → adSpend：${amount(facts.adSpend)} 元`,
    `- 退款数 → refundCount：${amount(facts.afterSalesCount, 0)} 单`,
    `- 退款金额 → refundAmount：${amount(facts.refundAmount)} 元`,
    ...inventory.map(item => `- ${item.sku} 库存/日均销量 → stock/dailySales：${amount(item.stock, 0)} / ${amount(item.dailySales, 2)}`),
  ];
  const inventoryLines = inventory.length
    ? inventory.map(item => (
        `- ${item.sku}：${amount(item.stock, 0)} ÷ ${amount(item.dailySales, 2)} = ${amount(item.daysCover, 2)} 天`
      ))
    : ['- 未提供可识别的 SKU 库存。'];
  const riskLines = [
    ...inventory.filter(item => item.daysCover !== undefined && item.daysCover <= 3)
      .map(item => `- P0 断货风险：${item.sku} 仅可售 ${amount(item.daysCover, 2)} 天。`),
    ...inventory.filter(item => item.daysCover !== undefined && item.daysCover > 3 && item.daysCover <= 7)
      .map(item => `- P1 库存关注：${item.sku} 可售 ${amount(item.daysCover, 2)} 天。`),
    ...(refundRate !== undefined
      ? [`- P1 退款率为 ${amount(refundRate, 2)}%；需与店铺品类阈值和退款原因分布比较后再定性。`]
      : []),
    ...(missingFields.length
      ? [`- P1 数据口径缺口：${missingFields.join('、')}；因此不计算毛利或贡献利润，也不把缺失值当成 0。`]
      : []),
  ];
  if (riskLines.length === 0) riskLines.push('- 当前内联字段未触发可确定的异常，但仍需结合店铺阈值复核。');

  const message = [
    `店铺数据诊断已完成，并按本轮内联字段生成持久回执（任务 ${started.task.id}）。`,
    '',
    `## ${platform}｜${period}｜${currency}`,
    '',
    '### 字段映射',
    ...mappingLines,
    '',
    '### 计算公式与结果',
    `- 客单价 = 销售额 ÷ 订单数 = ${amount(facts.revenue)} ÷ ${amount(facts.orders, 0)} = ${amount(averageOrderValue, 2)} 元。`,
    `- 退款率 = 退款数 ÷ 订单数 × 100% = ${amount(facts.afterSalesCount, 0)} ÷ ${amount(facts.orders, 0)} × 100% = ${amount(refundRate, 2)}%。`,
    `- 退款金额率 = 退款金额 ÷ 销售额 × 100% = ${amount(facts.refundAmount)} ÷ ${amount(facts.revenue)} × 100% = ${amount(refundAmountRate, 2)}%。`,
    `- 广告投入产出（ROAS）= 销售额 ÷ 广告花费 = ${amount(facts.revenue)} ÷ ${amount(facts.adSpend)} = ${amount(roas, 2)}。`,
    '- 库存可售天数 = 库存 ÷ 日均销量：',
    ...inventoryLines,
    '',
    '### 缺失字段',
    `- ${missingFields.length ? missingFields.join('、') : '无'}`,
    '',
    '### 异常与风险',
    ...riskLines,
    '',
    '执行边界：本轮只读取并计算你在当前消息中提供的字段；没有读取旧工作区、登录外部平台、修改店铺、发送消息或提交任何外部操作。',
  ].join('\n');

  const snapshot = {
    platform,
    reportingPeriod: period,
    currency,
    revenue: facts.revenue,
    orders: facts.orders,
    averageOrderValue,
    refundCount: facts.afterSalesCount,
    refundRate,
    refundAmount: facts.refundAmount,
    refundAmountRate,
    adSpend: facts.adSpend,
    roas,
    inventory,
  };
  const calculationReceipt: ToolExecutionRecord = {
    id: `industry-store-data-${requestId}`,
    taskId: started.conversationTaskId,
    turnId: requestId,
    requestId,
    name: 'industry_ecommerce_store_data_snapshot',
    arguments: { sourceBound: true },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      taskId: started.task.id,
      conversationTaskId: started.conversationTaskId,
      sourceBound: true,
      externalMutation: false,
      inlineFactsOnly: true,
      snapshot,
      missingFields,
    }),
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'Every metric and mapping was calculated from explicitly labelled inline fields in the current turn.',
    },
  };
  const recorded = recordIndustryWorkflowExecution({
    userId,
    domain,
    orgId,
    taskId: started.task.id,
    resultText: message,
    toolRecords: [calculationReceipt],
    source: context?.source || 'industry_structured_store_data',
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
    missingFields,
    verification: recorded.verification as unknown as Record<string, unknown>,
  };
}
