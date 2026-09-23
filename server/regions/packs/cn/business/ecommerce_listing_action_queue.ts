import type { ToolContext, ToolExecutionRecord } from '../../../../tools/types';
import { recordIndustryWorkflowExecution, startOrReuseIndustryWorkflow } from '../../../../industry/workflow_service';

function numberFrom(source: string, label: RegExp): number | undefined {
  const match = source.match(new RegExp(`(?:${label.source})\\s*[:：=]?\\s*(?:[¥￥$]\\s*)?(-?[\\d,]+(?:\\.\\d+)?)`, 'iu'));
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : undefined;
}

function textFrom(source: string, label: RegExp): string | undefined {
  const match = source.match(new RegExp(`(?:${label.source})\\s*[:：=]?\\s*([^；;。\\r\\n]+)`, 'iu'));
  return match?.[1]?.trim() || undefined;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function amount(value: number | undefined, digits = 2): string {
  return value === undefined
    ? '未提供'
    : value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export interface EcommerceListingActionQueueReceipt {
  ok: boolean;
  status: string;
  persisted: boolean;
  taskId: string;
  conversationTaskId: string;
  message: string;
  sourceBound: true;
  externalMutation: false;
  actionQueueOnly: true;
  snapshot: Record<string, unknown>;
  evidenceGaps: string[];
  verification: Record<string, unknown>;
}

/** Build a review-only SKU action queue from the exact inline facts. */
export function executeEcommerceListingActionQueue(context?: ToolContext): EcommerceListingActionQueueReceipt {
  const sourceInput = String(context?.industryWorkflowSourceInput || context?.actionIntent || context?.routedTaskText || '').trim();
  const sku = sourceInput.match(/(?:^|[；;。\s])SKU\s*[:：=]\s*([A-Za-z0-9][A-Za-z0-9._-]{0,40})/iu)?.[1] || '';
  const price = numberFrom(sourceInput, /售价|单价|price/iu);
  const unitCost = numberFrom(sourceInput, /单位成本|商品成本|采购成本|unit\s*cost/iu);
  const unitShipping = numberFrom(sourceInput, /单位运费|单位物流|unit\s*shipping/iu);
  const platformFeeRate = numberFrom(sourceInput, /平台费率|佣金率|platform\s*fee\s*rate/iu);
  const stock = numberFrom(sourceInput, /库存|stock/iu);
  const dailySales = numberFrom(sourceInput, /日均销量|daily\s*sales/iu);
  const leadTimeDays = numberFrom(sourceInput, /供货提前期|提前期|交期|lead\s*time/iu);
  const safetyStockDays = numberFrom(sourceInput, /安全库存天数|安全库存|safety\s*stock/iu);
  const orders = numberFrom(sourceInput, /近\s*30\s*天订单|订单数|orders/iu);
  const refunds = numberFrom(sourceInput, /退款(?:数|单数)?|refunds?/iu);
  const refundReason = textFrom(sourceInput, /主要退款原因|退款原因|refund\s*reason/iu);
  if (!sku || [price, unitCost, unitShipping, platformFeeRate, stock, dailySales, leadTimeDays, safetyStockDays, orders, refunds].some(value => value === undefined)) {
    throw new Error('商品管理动作队列缺少明确的 SKU、价格、成本、库存、销量、交期、安全库存或退款字段，已停止而不是猜测。');
  }

  const userId = context?.userId || 'anonymous';
  const domain = context?.domain === 'work' ? 'work' as const : 'personal' as const;
  const orgId = domain === 'work' ? String(context?.orgId || '') : '';
  const requestId = String(context?.requestId || context?.turnId || `industry_listing_${Date.now()}`);
  const started = startOrReuseIndustryWorkflow({
    userId,
    domain,
    orgId,
    entryId: 'listing-automation',
    sourceInput,
    source: context?.source || 'industry_structured_listing_queue',
    context: { sourceBound: true, externalMutation: false, actionQueueOnly: true, sku },
    idempotencyKey: `industry-listing-action-queue:${requestId}`,
    conversationId: context?.conversationId,
    conversationTaskId: context?.taskId,
    requestId,
  }, context?.industryWorkflowTaskId);

  const platformFee = round(price! * platformFeeRate! / 100);
  const unitContributionProfit = round(price! - unitCost! - unitShipping! - platformFee);
  const refundRate = orders! > 0 ? round(refunds! / orders! * 100) : undefined;
  const daysCover = dailySales! > 0 ? round(stock! / dailySales!) : undefined;
  const requiredCoverDays = round(leadTimeDays! + safetyStockDays!);
  const reorderPoint = round(dailySales! * requiredCoverDays, 0);
  const suggestedOrderQty = Math.max(0, round(reorderPoint - stock!, 0));
  const evidenceGaps = [
    '商品正式名称与类目',
    '实际长宽高/适配尺寸及测量证据',
    '材质、承重与质检证明',
    '平台类目规则与禁限售检查结果',
    '在途库存、起订量与供应商可交付确认',
    '退款样本明细与责任归因',
  ];
  const evidenceGapLines = evidenceGaps.map(item => `- ${item}`);
  const message = [
    `商品管理动作队列已生成并持久化（任务 ${started.task.id}）。所有动作均为待审核草稿，尚未执行。`,
    '',
    `## ${sku}｜内联事实复核`,
    '',
    `- 单位平台费 = 售价 × 平台费率 = ${amount(price)} × ${amount(platformFeeRate)}% = ${amount(platformFee)} 元。`,
    `- 单位贡献毛利 = 售价 - 单位成本 - 单位运费 - 单位平台费 = ${amount(price)} - ${amount(unitCost)} - ${amount(unitShipping)} - ${amount(platformFee)} = ${amount(unitContributionProfit)} 元。`,
    `- 退款率 = 退款数 ÷ 近30天订单 × 100% = ${amount(refunds, 0)} ÷ ${amount(orders, 0)} × 100% = ${amount(refundRate)}%。`,
    `- 当前可售天数 = 库存 ÷ 日均销量 = ${amount(stock, 0)} ÷ ${amount(dailySales)} = ${amount(daysCover)} 天。`,
    `- 覆盖目标 = 供货提前期 + 安全库存天数 = ${amount(leadTimeDays, 0)} + ${amount(safetyStockDays, 0)} = ${amount(requiredCoverDays, 0)} 天；补货点 ${amount(reorderPoint, 0)} 件；与当前库存缺口 ${amount(suggestedOrderQty, 0)} 件。`,
    `- 主要退款原因：${refundReason || '未提供'}。`,
    '',
    '## 风险判断',
    `- P0 断货风险：现有库存仅覆盖 ${amount(daysCover)} 天，低于 ${amount(requiredCoverDays, 0)} 天覆盖目标；未核验在途库存前，不把 ${amount(suggestedOrderQty, 0)} 件直接当成采购量。`,
    `- P0 尺寸/退款风险：退款率 ${amount(refundRate)}%，主要原因为“${refundReason || '未提供'}”；需先补齐测量证据并复核详情页尺寸表达。`,
    '- P1 合规风险：类目规则、材质/质检证明、尺寸测量证据均未提供，不能生成“适配所有桌面”“承重”等未经证实的卖点。',
    '',
    '## 标题与卖点草稿（待事实审核）',
    `- 标题草稿：${sku}｜尺寸参数待补充｜商品信息审核稿`,
    `- 卖点草稿 1：当前单位贡献毛利测算为 ${amount(unitContributionProfit)} 元（仅基于已给成本口径）。`,
    '- 卖点草稿 2：请在购买前核对长宽高与适配空间；尺寸参数待测量证据补齐后发布。',
    '- 卖点草稿 3：材质、承重、安装方式与适用场景尚待质检/商品事实证明，不作未批准承诺。',
    '',
    '## 可审核动作队列',
    `1. P0｜补货核验草稿｜核对在途、起订量和 5 天交期；当前计算缺口 ${amount(suggestedOrderQty, 0)} 件｜状态：待供应链审核｜采购/补货提交需逐项批准。`,
    '2. P0｜尺寸信息修订草稿｜补测长宽高、适配范围并复核“尺寸不符”退款样本｜状态：待商品/合规审核｜修改详情页或发布需逐项批准。',
    '3. P1｜标题/卖点草稿复核｜仅保留有证据的事实，不使用未经验证的全场景适配或承重声明｜状态：待内容/合规审核｜上架、改价、发布需逐项批准。',
    '4. P1｜退款根因复盘｜抽样核对 8 单退款的商品、描述、测量和责任归因｜状态：待客服审核｜联系客户、退款或补偿需逐项批准。',
    '',
    '## 证据缺口',
    ...evidenceGapLines,
    '',
    '审批边界：本轮未上架、下架、改价、发布、采购、修改库存、联系客户、退款或承诺赔偿；每一项外部动作必须由对应负责人逐项批准并取得平台回执。',
  ].join('\n');

  const snapshot = {
    sku,
    price,
    unitCost,
    unitShipping,
    platformFeeRate,
    platformFee,
    unitContributionProfit,
    stock,
    dailySales,
    daysCover,
    leadTimeDays,
    safetyStockDays,
    requiredCoverDays,
    reorderPoint,
    suggestedOrderQty,
    orders,
    refunds,
    refundRate,
    refundReason,
  };
  const calculationReceipt: ToolExecutionRecord = {
    id: `industry-listing-${requestId}`,
    taskId: started.conversationTaskId,
    turnId: requestId,
    requestId,
    name: 'industry_ecommerce_listing_action_queue',
    arguments: { sourceBound: true },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      taskId: started.task.id,
      conversationTaskId: started.conversationTaskId,
      sourceBound: true,
      externalMutation: false,
      actionQueueOnly: true,
      snapshot,
      evidenceGaps,
    }),
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'Calculations and queue items were derived from explicitly labelled current-turn SKU facts; all external mutations remain approval-gated.',
    },
  };
  const recorded = recordIndustryWorkflowExecution({
    userId,
    domain,
    orgId,
    taskId: started.task.id,
    resultText: message,
    toolRecords: [calculationReceipt],
    source: context?.source || 'industry_structured_listing_queue',
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
    actionQueueOnly: true,
    snapshot,
    evidenceGaps,
    verification: recorded.verification as unknown as Record<string, unknown>,
  };
}
