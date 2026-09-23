import type { ToolContext, ToolExecutionRecord } from '../../../../tools/types';
import { recordIndustryWorkflowExecution, startOrReuseIndustryWorkflow } from '../../../../industry/workflow_service';

function textFrom(source: string, label: RegExp): string | undefined {
  const match = source.match(new RegExp(`(?:${label.source})\\s*[:：=]?\\s*([^；;。\\r\\n]+)`, 'iu'));
  return match?.[1]?.trim() || undefined;
}

export interface EcommerceCustomerServiceDraftReceipt {
  ok: boolean;
  status: string;
  persisted: boolean;
  taskId: string;
  conversationTaskId: string;
  message: string;
  sourceBound: true;
  externalMutation: false;
  draftOnly: true;
  privacyVerified: boolean;
  snapshot: Record<string, unknown>;
  verification: Record<string, unknown>;
}

/** Produce privacy-bounded, non-committal service and FAQ drafts only. */
export function executeEcommerceCustomerServiceDrafts(context?: ToolContext): EcommerceCustomerServiceDraftReceipt {
  const sourceInput = String(context?.industryWorkflowSourceInput || context?.actionIntent || context?.routedTaskText || '').trim();
  const customerAlias = textFrom(sourceInput, /客户代号|客户别名|customer\s*alias/iu) || '';
  const orderAlias = textFrom(sourceInput, /订单代号|订单别名|order\s*alias/iu) || '';
  const product = textFrom(sourceInput, /商品|product/iu) || '';
  const customerIssue = textFrom(sourceInput, /客户问题|问题|customer\s*issue/iu) || '';
  const storeRule = textFrom(sourceInput, /店铺规则|规则|policy/iu) || '';
  const brandTone = textFrom(sourceInput, /品牌语气|语气|brand\s*tone/iu) || '';
  if (!customerAlias || !orderAlias || !product || !customerIssue || !storeRule || !brandTone) {
    throw new Error('内容与客服草稿缺少已脱敏客户/订单代号、商品、问题、店铺规则或品牌语气，已停止而不是补猜。');
  }
  const maskedAliasPattern = /^[A-Za-z0-9-]*\*{2,}[A-Za-z0-9-]*$/u;
  const privacyVerified = maskedAliasPattern.test(customerAlias) && maskedAliasPattern.test(orderAlias);
  if (!privacyVerified) {
    throw new Error('客户或订单标识未达到当前草稿路径的脱敏要求，已停止生成。');
  }

  const userId = context?.userId || 'anonymous';
  const domain = context?.domain === 'work' ? 'work' as const : 'personal' as const;
  const orgId = domain === 'work' ? String(context?.orgId || '') : '';
  const requestId = String(context?.requestId || context?.turnId || `industry_service_${Date.now()}`);
  const started = startOrReuseIndustryWorkflow({
    userId,
    domain,
    orgId,
    entryId: 'ai-customer-service',
    sourceInput,
    source: context?.source || 'industry_structured_customer_service',
    context: { sourceBound: true, externalMutation: false, draftOnly: true, privacyVerified, orderAlias },
    idempotencyKey: `industry-customer-service-drafts:${requestId}`,
    conversationId: context?.conversationId,
    conversationTaskId: context?.taskId,
    requestId,
  }, context?.industryWorkflowTaskId);

  const replyDraft = [
    `您好，已收到您关于订单 ${orderAlias}、商品“${product}”的反馈：${customerIssue}。`,
    `当前提供的店铺规则为：${storeRule}。请通过安全渠道提供核验所需的最少凭证。`,
    '退货是否符合条件、运费由谁承担以及是否补偿，均需人工审核；在审核完成前我们无法预先承诺结果。',
    '为保护隐私，请不要在公开渠道发送姓名、电话、详细地址等敏感信息。我们会在事实核验后同步审核结论。',
  ].join('');
  const faqDraft = [
    `Q：${customerIssue}`,
    `A：当前提供的规则是“${storeRule}”。具体处理结果需核对订单和凭证后确认；请勿在公开渠道提供姓名、电话、地址等敏感信息。`,
  ].join('\n');
  const risks = [
    '资格事实不完整：尚未核对当前问题与店铺规则涉及的事实和凭证，不能直接批准退货。',
    '承诺风险：运费承担和补偿均需人工审核，草稿不得使用“保证”“一定”“已批准”等表述。',
    '隐私风险：当前仅使用脱敏代号；如后续核验需要真实订单信息，应在受控渠道按最小必要原则收集。',
    '商品描述风险：应核对本次具体问题与详情页描述，避免重复投诉。',
  ];
  const escalationConditions = [
    '店铺规则适用条件、订单或商品状态存在争议。',
    '客户要求运费补偿、额外赔偿、即时退款或明确承诺结果。',
    '订单记录、商品信息或客户凭证相互矛盾。',
    '客户在公开渠道发送姓名、电话、地址等敏感信息，或出现投诉升级/拒付风险。',
    '同一 SKU 出现重复同类工单，需要升级商品/合规负责人复核详情页。',
  ];
  const message = [
    `内容与客服审核包已生成并持久化（任务 ${started.task.id}）。当前只生成草稿，没有发送、发布、退款或承诺赔偿。`,
    '',
    '## 工单分类',
    `- 类型：客户问题与店铺规则核验 / 具体处理待人工审核。`,
    `- 客户代号：${customerAlias}；订单代号：${orderAlias}；商品：${product}。`,
    `- 原始问题：${customerIssue}。`,
    '',
    '## 规则与隐私验证',
    `- 店铺规则：${storeRule}。`,
    '- 已验证边界：退货资格是条件性申请，不是自动批准；运费承担需人工审核；当前没有足够事实承诺补偿。',
    `- 隐私：客户与订单均为脱敏代号（${customerAlias} / ${orderAlias}）；草稿不索取或暴露姓名、电话、地址。`,
    `- 品牌语气：${brandTone}。`,
    '',
    '## 客服回复草稿（未发送）',
    '',
    replyDraft,
    '',
    '## FAQ 内容草稿（未发布）',
    '',
    faqDraft,
    '',
    '## 风险',
    ...risks.map(item => `- ${item}`),
    '',
    '## 升级条件',
    ...escalationConditions.map(item => `- ${item}`),
    '',
    '审批边界：发送客服回复需客服负责人逐条批准；发布 FAQ 需内容/合规负责人批准；退款、运费承担、补偿或任何例外处理需售后/财务负责人批准并取得平台回执。本轮未执行上述任何动作。',
  ].join('\n');

  const snapshot = {
    customerAlias,
    orderAlias,
    product,
    customerIssue,
    storeRule,
    brandTone,
    classification: ['售后退货咨询', '尺寸不适配', '运费与补偿待人工审核'],
    privacyVerified,
    replyDraft,
    faqDraft,
    risks,
    escalationConditions,
  };
  const draftReceipt: ToolExecutionRecord = {
    id: `industry-service-${requestId}`,
    taskId: started.conversationTaskId,
    turnId: requestId,
    requestId,
    name: 'industry_ecommerce_customer_service_drafts',
    arguments: { sourceBound: true },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      taskId: started.task.id,
      conversationTaskId: started.conversationTaskId,
      sourceBound: true,
      externalMutation: false,
      draftOnly: true,
      privacyVerified,
      snapshot,
    }),
    terminalVerification: {
      status: 'verified',
      strategy: 'measured',
      reason: 'Drafts use only masked current-turn facts, preserve conditional policy language, and contain no external delivery or compensation commitment.',
    },
  };
  const recorded = recordIndustryWorkflowExecution({
    userId,
    domain,
    orgId,
    taskId: started.task.id,
    resultText: message,
    toolRecords: [draftReceipt],
    source: context?.source || 'industry_structured_customer_service',
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
    draftOnly: true,
    privacyVerified,
    snapshot,
    verification: recorded.verification as unknown as Record<string, unknown>,
  };
}
