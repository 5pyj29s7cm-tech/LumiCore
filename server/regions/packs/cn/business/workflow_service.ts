import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readDB, writeDB, flushDBOrThrow } from '../../../../../db_layer';
import { getConversationForScope, getOrCreateActiveConversation } from '../../../../conversation/manager';
import {
  ensureBackgroundConversationActionTask,
  settleBackgroundConversationActionTask,
  appendConversationActionReceipts,
  findConversationActionTask,
} from '../../../../conversation/action_ledger';
import type { ToolExecutionRecord } from '../../../../tools/types';
import { verifyWorkTakeoverResult, type WorkTakeoverResultVerification } from '../../../../work_takeover/result_verifier';
import {
  createWorkTakeoverTask,
  getWorkTakeoverTask,
  listWorkTakeoverTasks,
  updateWorkTakeoverTask,
  type WorkTakeoverTask,
  type WorkTakeoverStatus,
} from '../../../../work_takeover/tasks';
import { BUSINESS_LINES, businessContract } from '../../../../industry/business_catalog';
import {
  getIndustryWorkflowContract,
  getIndustryWorkflowContracts,
  normalizeIndustryProductLine,
  type IndustryWorkflowContract,
} from '../../../../industry/workflow_contracts';
import { workflowWorkspaceContext } from '../../../../industry/workspace_context';

export interface IndustryWorkflowScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

export interface StartIndustryWorkflowInput extends IndustryWorkflowScope {
  entryId: string;
  sourceInput?: string;
  source?: string;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  conversationId?: string;
  conversationTaskId?: string;
  requestId?: string;
}

export interface IndustryWorkflowStartResult {
  task: WorkTakeoverTask;
  conversationId: string;
  conversationTaskId: string;
  requestId: string;
  contract: IndustryWorkflowContract;
  handoffPrompt: string;
  reused?: boolean;
}

export interface RecordIndustryWorkflowInput extends IndustryWorkflowScope {
  taskId: string;
  resultText?: string;
  filePaths?: string[];
  toolRecords?: ToolExecutionRecord[];
  source?: string;
}

export interface IndustryWorkflowRecordResult {
  task: WorkTakeoverTask;
  verification: WorkTakeoverResultVerification;
  conversationTaskId: string;
  archivedFilePaths: string[];
}

function compact(value: unknown, limit = 5000): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.keys(candidate as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const child = (candidate as Record<string, unknown>)[key];
        if (child !== undefined) result[key] = normalize(child);
        return result;
      }, {});
  };
  return JSON.stringify(normalize(value));
}

function contractForCurrentProduct(entryId: unknown): IndustryWorkflowContract {
  const contract = businessContract(entryId);
  if (!contract) throw new Error('Unknown business workflow: ' + String(entryId || ''));
  return contract;
}

function scopeMatches(task: WorkTakeoverTask, scope: IndustryWorkflowScope): boolean {
  return task.userId === scope.userId
    && task.domain === scope.domain
    && String(task.orgId || '') === String(scope.orgId || '');
}

function workflowMetadata(task: WorkTakeoverTask): Record<string, any> {
  const metadata = task.metadata?.industryWorkflow;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

function taskContract(task: WorkTakeoverTask): IndustryWorkflowContract {
  const metadata = workflowMetadata(task);
  const contract = contractForCurrentProduct(metadata.entryId);
  if (metadata.productLine !== contract.productLine) throw new Error('Industry workflow product boundary mismatch.');
  return contract;
}

function buildTaskSummary(contract: IndustryWorkflowContract, sourceInput: string): string {
  const normalized = compact(sourceInput, 12_000);
  return [
    `${contract.title} workflow prepared by the ${contract.productLine} client.`,
    normalized ? `Source input digest=${sha256(normalized)}; characters=${normalized.length}.` : 'Source input is collected by the execution surface when the task continues.',
    'Completion is allowed only after server-side evidence verification.',
  ].join(' ');
}

function firstCapturedValue(source: string, patterns: RegExp[], limit = 300): string {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const value = compact(match?.[1], limit);
    if (value) return value;
  }
  return '';
}

function explicitFinanceWorkspaceContext(sourceInput: string): Record<string, unknown> | null {
  const name = firstCapturedValue(sourceInput, [
    /(?:主体|企业名称|公司名称)\s*(?:为|[:：=])?\s*[“"']([^”"'；;，,。\n]+)[”"']/u,
    /(?:主体|企业名称|公司名称)\s*(?:为|[:：=])\s*([^；;，,。\n]+)/u,
  ], 160);
  const accountingPeriod = firstCapturedValue(sourceInput, [
    /(?:会计期间|账期|所属期)\s*(?:为|[:：=])?\s*(20\d{2}-(?:0[1-9]|1[0-2]))/u,
  ], 20);
  const currency = firstCapturedValue(sourceInput, [
    /(?:币种)\s*(?:为|[:：=])?\s*([A-Z]{3})\b/iu,
  ], 10).toUpperCase();
  const accountingBasis = firstCapturedValue(sourceInput, [
    /(?:核算基础|会计基础)\s*(?:为|[:：=])?\s*([^；;，,。\n]+)/u,
  ], 80);
  const attributes = Object.fromEntries(Object.entries({
    entityName: name,
    accountingPeriod,
    currency,
    accountingBasis,
  }).filter(([, value]) => Boolean(value)));
  if (!name && Object.keys(attributes).length === 0) return null;
  return {
    kind: 'entity',
    ...(name ? { name } : {}),
    attributes,
    requestScoped: true,
  };
}

function mergeIndustryWorkspaceContext(
  activeWorkspace: Record<string, unknown> | null,
  suppliedWorkspace: Record<string, unknown>,
  explicitWorkspace: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!activeWorkspace && !Object.keys(suppliedWorkspace).length && !explicitWorkspace) return null;
  const activeName = compact(activeWorkspace?.name, 160);
  const explicitName = compact(explicitWorkspace?.name, 160);
  const entityChanged = Boolean(activeName && explicitName && activeName.localeCompare(explicitName, undefined, { sensitivity: 'accent' }) !== 0);
  const merged = {
    ...(activeWorkspace || {}),
    ...suppliedWorkspace,
    ...(explicitWorkspace || {}),
    attributes: {
      ...parseObject(activeWorkspace?.attributes),
      ...parseObject(suppliedWorkspace.attributes),
      ...parseObject(explicitWorkspace?.attributes),
    },
  };
  if (entityChanged) {
    delete (merged as Record<string, unknown>).id;
    delete (merged as Record<string, unknown>).updatedAt;
  }
  return merged;
}

function buildHandoffPrompt(task: WorkTakeoverTask, contract: IndustryWorkflowContract): string {
  const workspace = parseObject(workflowMetadata(task).context?.industryWorkspace);
  return [
    `Continue the existing industry workflow task ${task.id}; do not create a duplicate task.`,
    `Workflow: ${contract.title} (${contract.productLine}/${contract.entryId}).`,
    workspace.id
      ? `Bound ${String(workspace.kind || 'business')} workspace: ${String(workspace.name || workspace.id)} (${String(workspace.id)}). Reuse its attributes and do not guess another business target.`
      : workspace.name
        ? `Request-scoped ${String(workspace.kind || 'business')} workspace: ${String(workspace.name)}. Use the explicit identity and attributes from this request; do not fall back to a previously active business target.`
      : 'No business workspace is bound. You may analyze the explicitly supplied data without a workspace. Ask for identity only if account access or a target-specific external action is actually necessary.',
    'This task and its source have already been loaded and bound by the server. Execute the relevant domain tool directly; do not spend extra turns re-reading the task or looking up workspaces for inline analysis.',
    contract.executionTools?.length ? `Use the registered domain tools: ${contract.executionTools.join(', ')}.` : '',
    contract.requiredToolReceipts?.length ? `Completion requires these verified receipts: ${contract.requiredToolReceipts.join(', ')}.` : '',
    `Required local artifact labels: ${contract.requiredArtifactLabels.join(', ')}.`,
    `Required evidence terms: ${contract.expectedContentTerms.join(', ')}.`,
    contract.requiredToolEvidence?.length
      ? `Required domain-tool receipts before generic file creation: ${contract.requiredToolEvidence.join(', ')}.`
      : '',
    `Confirmation boundaries: ${contract.confirmationBoundaries.join(' ')}`,
    contract.requiresFileArtifact
      ? `A real non-empty file is mandatory. Accepted extensions: ${contract.acceptedFileExtensions.join(', ')}. Model text alone is not completion.`
      : 'A persisted, reviewable result is mandatory. Model narration that is not archived and verified is not completion.',
    'A source-bound domain tool returning persisted=true and status=verified has already archived and verified its result. Summarize that receipt directly. Otherwise submit actual executed receipts to industry_workflow_complete; never manufacture evidence.',
    'If verification does not pass, report the blocker and next step; never claim completion from a draft, plan, or opened screen.',
  ].join('\n');
}

function enforceRequiredToolEvidence(
  verification: WorkTakeoverResultVerification,
  task: WorkTakeoverTask,
  contract: IndustryWorkflowContract,
  records: ToolExecutionRecord[],
): WorkTakeoverResultVerification {
  const required = contract.requiredToolEvidence || contract.requiredToolReceipts || [];
  if (!required.length) return verification;
  const verifiedTools = new Set(records.filter(record => (
    !record.error
    && String(record.result || '').trim()
    && record.terminalVerification?.status === 'verified'
    && recordMatchesWorkflowBinding(task, record)
  )).map(record => record.name));
  const missing = required.filter(name => !verifiedTools.has(name));
  const check = {
    id: 'required_domain_tool_evidence',
    label: '必需行业能力已实际执行',
    passed: missing.length === 0,
    detail: missing.length
      ? `缺少已验证回执：${missing.join('、')}`
      : `已验证：${required.join('、')}`,
  };
  if (!missing.length) return { ...verification, checks: [...verification.checks, check] };
  const blocker = check.detail;
  const blockers = Array.from(new Set([...verification.blockers, blocker]));
  return {
    ...verification,
    passed: false,
    status: verification.status === 'blocked' ? 'blocked' : 'needs_review',
    summary: `任务结果需要复核：${blockers.join('；')}`,
    checks: [...verification.checks, check],
    blockers,
  };
}

function isNonDeliverableResultText(value: string): boolean {
  const text = compact(value, 6000);
  if (!text) return true;
  return /工具处理次数到上限|还没来得及整理成最终结论|没有检测到已生成的可验证文件|尚未完成|无法完成|tool loop reached its limit|before lumi could write the final answer|no verified generated file/i.test(text);
}

function addFailedVerificationCheck(
  verification: WorkTakeoverResultVerification,
  input: { id: string; label: string; detail: string },
): WorkTakeoverResultVerification {
  const check = { ...input, passed: false };
  const blockers = Array.from(new Set([...verification.blockers, input.detail]));
  return {
    ...verification,
    passed: false,
    status: verification.status === 'blocked' ? 'blocked' : 'needs_review',
    summary: `任务结果需要复核：${blockers.join('；')}`,
    checks: [...verification.checks, check],
    blockers,
  };
}

function enforceReviewableCurrentResult(
  verification: WorkTakeoverResultVerification,
  resultText: string,
): WorkTakeoverResultVerification {
  if (!isNonDeliverableResultText(resultText)) {
    return {
      ...verification,
      checks: [...verification.checks, {
        id: 'reviewable_current_result',
        label: '本轮形成可复核结论',
        passed: true,
        detail: `本轮结果长度=${resultText.replace(/\s+/g, '').length}`,
      }],
    };
  }
  return addFailedVerificationCheck(verification, {
    id: 'reviewable_current_result',
    label: '本轮形成可复核结论',
    detail: '本轮只有失败、超限或未完成说明，不能作为交付结果。',
  });
}

function verifiedPayloads(
  task: WorkTakeoverTask,
  records: ToolExecutionRecord[],
  toolName: string,
): Record<string, any>[] {
  return records.filter(candidate => (
    candidate.name === toolName
    && !candidate.error
    && candidate.terminalVerification?.status === 'verified'
    && String(candidate.result || '').trim()
    && recordMatchesWorkflowBinding(task, candidate)
  )).map(record => parseRecordPayload(record)).filter((payload): payload is Record<string, any> => (
    Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
  ));
}

function verifiedPayload(
  task: WorkTakeoverTask,
  records: ToolExecutionRecord[],
  toolName: string,
): Record<string, any> | null {
  return verifiedPayloads(task, records, toolName).slice(-1)[0] || null;
}

function money(value: unknown, currency = 'CNY'): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '未提供';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
}

function financeNumberFromSummary(value: unknown, labels: string[]): number | undefined {
  const text = String(value || '');
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${escaped}\\s*(?:=|:|：|为)?\\s*([+-]?[0-9][0-9,]*(?:\\.[0-9]+)?)`, 'u'));
    if (!match) continue;
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function financeWorkspaceLines(task: WorkTakeoverTask): string[] {
  const workspace = parseObject(workflowMetadata(task).context?.industryWorkspace);
  const attributes = parseObject(workspace.attributes);
  return [
    workspace.name ? `主体：${String(workspace.name)}` : '',
    attributes.accountingPeriod ? `账期：${String(attributes.accountingPeriod)}` : '',
    attributes.currency ? `币种：${String(attributes.currency)}` : '',
    attributes.accountingBasis ? `核算基础：${String(attributes.accountingBasis)}` : '',
  ].filter(Boolean);
}

function buildFinanceReviewableResult(
  task: WorkTakeoverTask,
  contract: IndustryWorkflowContract,
  records: ToolExecutionRecord[],
): string | null {
  if (contract.productLine !== 'finance') return null;
  const required = contract.requiredToolEvidence || contract.requiredToolReceipts || [];
  if (!required.length || required.some(name => !verifiedPayload(task, records, name))) return null;
  const lines = [contract.title === 'Cash and risk' ? '资金与风险复核报告' : `${contract.title}复核结果`, ...financeWorkspaceLines(task)];

  if (contract.entryId === 'cash-risk') {
    const cashScenarios = verifiedPayloads(task, records, 'business_finance_cashflow_forecast');
    const agingReports = verifiedPayloads(task, records, 'business_finance_ar_ap_aging');
    const baselineCash = cashScenarios[0]!;
    const receivableAging = (agingReports.find(report => report.type === 'receivable') || agingReports[0])!;
    const payableAging = agingReports.find(report => report.type === 'payable');
    const currency = String(receivableAging?.currency || payableAging?.currency || 'CNY');
    const baselineEnding = Number((Array.isArray(baselineCash?.forecast) ? baselineCash.forecast : []).slice(-1)[0]?.projectedCash);
    const scenarioLabel = (scenario: Record<string, any>, index: number): string => {
      if (index === 0) return '基准情景';
      const ending = Number((Array.isArray(scenario.forecast) ? scenario.forecast : []).slice(-1)[0]?.projectedCash);
      if (Number.isFinite(ending) && Number.isFinite(baselineEnding)) return ending >= baselineEnding ? '乐观情景' : '压力情景';
      return `补充情景${index}`;
    };
    lines.push(
      '',
      '现金预测',
      `- 期初现金：${money(baselineCash.openingCash, currency)}`,
      `- 基准情景一次性计入应收：${money(baselineCash.receivables, currency)}`,
      `- 基准情景一次性扣除应付：${money(baselineCash.payables, currency)}`,
      ...cashScenarios.flatMap((scenario, index) => [
        `${scenarioLabel(scenario, index)}：`,
        ...((Array.isArray(scenario.forecast) ? scenario.forecast : []).map((row: any) => `- 第${row.month}个月预计现金：${money(row.projectedCash, currency)}`)),
      ]),
      '',
      `应收账龄（截至 ${String(receivableAging.asOfDate || '未提供')}）`,
      `- 应收合计：${money(receivableAging.totalAmount, currency)}`,
      ...((Array.isArray(receivableAging.rows) ? receivableAging.rows : []).map((row: any) => (
        `- ${String(row.counterparty || '未命名往来方')}：${money(row.amount, currency)}，到期日 ${String(row.dueDate || '未提供')}，${Number(row.daysOverdue) > 0 ? `逾期 ${row.daysOverdue} 天（${String(row.bucket || '')}）` : '尚未到期'}`
      ))),
      ...(payableAging ? [
        '',
        `应付账龄（截至 ${String(payableAging.asOfDate || '未提供')}）`,
        `- 应付合计：${money(payableAging.totalAmount, currency)}`,
        ...((Array.isArray(payableAging.rows) ? payableAging.rows : []).map((row: any) => (
          `- ${String(row.counterparty || '未命名往来方')}：${money(row.amount, currency)}，到期日 ${String(row.dueDate || '未提供')}，${Number(row.daysOverdue) > 0 ? `逾期 ${row.daysOverdue} 天（${String(row.bucket || '')}）` : '尚未到期'}`
        ))),
      ] : []),
      '',
      '计算口径与判断',
      '- 现金预测把应收和应付作为预测起点的一次性现金变动，之后按每月收入减每月支出的净额滚动。',
      '- 账龄日采用工具回执中的截至日期；未提供实际回款概率、付款节奏和授信额度，因此结果是基础情景，不是银行余额承诺。',
      cashScenarios.some(scenario => (Array.isArray(scenario.forecast) ? scenario.forecast : []).some((row: any) => Number(row.projectedCash) < 0))
        ? '- 压力情景出现现金转负，应优先核实回款折扣、成本上升参数、应付到期分布和最低现金安全线。'
        : '- 各情景现金暂未转负，但仍应结合实际回款、应付到期分布和最低现金安全线复核。',
    );
  } else if (contract.entryId === 'business-dashboard') {
    const outline = verifiedPayload(task, records, 'business_finance_finance_report_outline')!;
    const ratio = verifiedPayload(task, records, 'business_finance_financial_ratio_analysis')!;
    const currency = String(ratio.currency || 'CNY');
    const metrics = new Map((Array.isArray(ratio.metrics) ? ratio.metrics : []).map((metric: any) => [String(metric.name), metric.value]));
    const metric = (name: string, unit: string): string => {
      const value = metrics.get(name);
      return value == null ? '未提供足够数据' : `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 })}${unit}`;
    };
    lines.push(
      '',
      '经营指标复核',
      `- 收入：${money(financeNumberFromSummary(outline.dataSummary, ['收入']), currency)}；毛利：${money(ratio.grossProfit, currency)}`,
      `- 毛利率：${metric('gross_margin', '%')}；营业利润率：${metric('operating_margin', '%')}；净利率：${metric('net_margin', '%')}`,
      `- 流动比率：${metric('current_ratio', '')}；资产负债率：${metric('debt_to_assets', '%')}；债务权益比：${metric('debt_to_equity', '')}`,
      `- ROA：${metric('return_on_assets', '%')}；ROE：${metric('return_on_equity', '%')}；经营现金转换：${metric('operating_cash_conversion', '')}`,
      `- 管理报表章节：${(Array.isArray(outline.sections) ? outline.sections : []).join('、') || '已形成管理报表大纲'}`,
      '- 口径：全部指标仅依据用户提供的本期数据；ROA、ROE 使用期末余额，未替代历史期间、同行或审计比较。',
    );
  } else if (contract.entryId === 'invoice-tax') {
    const invoice = verifiedPayload(task, records, 'business_finance_vat_invoice_review')!;
    const tax = verifiedPayload(task, records, 'business_finance_tax_position_estimator')!;
    const currency = String(invoice.currency || tax.currency || 'CNY');
    const duplicateIssues = (Array.isArray(invoice.issues) ? invoice.issues : [])
      .filter((issue: unknown) => /duplicate|重复/i.test(String(issue)));
    lines.push(
      '',
      '发票与税负复核',
      `- 发票行数：${Number(invoice.invoiceCount || 0)}；含税合计：${money(invoice.totals?.grossAmount, currency)}；不含税合计：${money(invoice.totals?.netAmount, currency)}；税额合计：${money(invoice.totals?.vatAmount, currency)}`,
      `- 重复风险：${duplicateIssues.length ? duplicateIssues.join('；') : '未识别到重复发票号与金额组合'}`,
      `- 税率分组：${Object.keys(parseObject(invoice.totalsByRate)).join('、') || '未提供'}`,
      `- 应纳增值税估算：${money(tax.vatPayable, currency)}；附加税估算：${money(tax.estimatedSurcharge, currency)}；所得税估算：${money(tax.estimatedIncomeTax, currency)}；现金税负估算：${money(tax.cashTaxEstimate, currency)}`,
      '- 风险提示：重复发票不得重复抵扣；税率、发票真实性、业务用途和进项抵扣资格仍需原始凭证复核。',
    );
  } else if (contract.entryId === 'accounting') {
    const ledger = verifiedPayload(task, records, 'business_finance_ledger_reconciliation')!;
    const aging = verifiedPayload(task, records, 'business_finance_ar_ap_aging')!;
    const currency = String(ledger.currency || aging.currency || 'CNY');
    lines.push(
      '',
      '账务核对与应收账龄',
      `- 账簿合计：${money(ledger.totals?.book, currency)}；银行合计：${money(ledger.totals?.bank, currency)}；差异：${money(ledger.totals?.difference, currency)}`,
      `- 已匹配：${Array.isArray(ledger.matched) ? ledger.matched.length : 0} 项；账簿未匹配：${Array.isArray(ledger.unmatchedBook) ? ledger.unmatchedBook.length : 0} 项；银行未匹配：${Array.isArray(ledger.unmatchedBank) ? ledger.unmatchedBank.length : 0} 项。`,
      `- 应收合计：${money(aging.totalAmount, currency)}；账龄分桶：${Object.entries(parseObject(aging.totalsByBucket)).map(([bucket, amount]) => `${bucket}=${money(amount, currency)}`).join('；') || '未提供'}`,
      ...((Array.isArray(aging.rows) ? aging.rows : []).map((row: any) => `- ${String(row.counterparty || '未命名往来方')}：${money(row.amount, currency)}；到期日 ${String(row.dueDate || '未提供')}；${Number(row.daysOverdue) > 0 ? `逾期${row.daysOverdue}天，${String(row.bucket || '')}` : '未到期'}`)),
      '- 风险与建议：先核实上述差异的原始流水、凭证和期间归属；对逾期应收建立责任人和回款节点。',
    );
  } else {
    const summaries = required.map(name => {
      const payload = verifiedPayload(task, records, name)!;
      const values = Object.entries(payload)
        .filter(([key, value]) => key !== 'auditReceipt' && ['string', 'number', 'boolean'].includes(typeof value))
        .slice(0, 8)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('；');
      return `- ${values || '已形成结构化计算和复核回执。'}`;
    });
    lines.push('', '已完成的本地复核', ...summaries);
  }

  const generatedPaths = records.flatMap(record => {
    if (!['create_xlsx', 'create_docx', 'create_pdf'].includes(record.name) || record.error) return [];
    try {
      const filePath = String(JSON.parse(String(record.result || '{}')).path || '').trim();
      return filePath ? [filePath] : [];
    } catch {
      return [];
    }
  });
  if (generatedPaths.length > 0) {
    lines.push('', '本地交付物', ...generatedPaths.map(filePath => `- ${filePath}`));
  }

  lines.push(
    '',
    '人工确认事项',
    '- 复核原始账簿、合同、发票、银行流水及期后回款，确认输入完整且归属期间正确。',
    '- 本轮未登录银行或税局，未付款、申报、上传、发送或进行任何外部提交。',
    '- 对外报送、记账、申报、付款和正式交付仍需财税负责人确认并取得外部回执。',
  );
  return lines.filter(Boolean).join('\n');
}

function resultWithWorkflowReceipt(
  resultText: string,
  taskId: string,
  verification: WorkTakeoverResultVerification,
): string {
  const receiptLines = [
    `任务编号：${taskId}`,
    `验证回执：${verification.verificationId}`,
    `验证状态：${verification.passed ? '已通过' : verification.status}`,
  ];
  const suffix = receiptLines.join('\n');
  const bodyLimit = Math.max(0, 5000 - suffix.length - 2);
  return [compact(resultText, bodyLimit), suffix].filter(Boolean).join('\n\n');
}

function conversationTaskIdFor(task: WorkTakeoverTask): string {
  return compact(workflowMetadata(task).conversationTaskId, 200);
}

function correlationFor(task: WorkTakeoverTask): { conversationId: string; conversationTaskId: string; requestId: string } {
  const metadata = workflowMetadata(task);
  return {
    conversationId: compact(metadata.conversationId, 200),
    conversationTaskId: compact(metadata.conversationTaskId, 200),
    requestId: compact(metadata.requestId, 200),
  };
}

function safeFilePaths(input: string[], contract: IndustryWorkflowContract): string[] {
  const accepted = new Set(contract.acceptedFileExtensions.map(extension => extension.toLowerCase()));
  const paths: string[] = [];
  for (const raw of input.slice(0, 30)) {
    const filePath = String(raw || '').trim();
    if (!filePath || paths.includes(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 16) continue;
      if (accepted.size > 0 && !accepted.has(path.extname(filePath).toLowerCase())) continue;
      paths.push(filePath);
    } catch {}
  }
  return paths;
}

function collectPathCandidates(value: unknown, result: string[], depth = 0): void {
  if (depth > 5 || value == null || result.length >= 60) return;
  if (Array.isArray(value)) {
    value.slice(0, 60).forEach(item => collectPathCandidates(item, result, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:path|filePath|outputPath|artifactPath|receiptPath|presentationPath|pdfPath|documentPath|imagePath|cadPath)$/i.test(key) && typeof child === 'string') {
      result.push(child);
    } else if (/(?:paths|files|artifacts|outputs|deliverables)$/i.test(key) || typeof child === 'object') {
      collectPathCandidates(child, result, depth + 1);
    }
  }
}

function parseRecordPayload(record: ToolExecutionRecord): unknown {
  if (record.receipt && typeof record.receipt === 'object') return record.receipt;
  let value: unknown = record.result;
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}

function recordIdentityDigest(record: ToolExecutionRecord): string {
  return sha256(canonicalJson({
    id: record.id,
    taskId: record.taskId,
    requestId: record.requestId,
    name: record.name,
    arguments: record.arguments,
    result: record.result,
    receipt: record.receipt,
    adapterStarted: record.adapterStarted,
    error: record.error,
    evidence: record.evidence,
    capability: record.capability,
    terminalVerification: record.terminalVerification,
    envelope: record.envelope,
  }));
}

function payloadTaskBindings(record: ToolExecutionRecord): Array<{
  taskId: string;
  conversationTaskId: string;
  requestId: string;
}> {
  const payloads: Record<string, unknown>[] = [];
  if (record.receipt && typeof record.receipt === 'object' && !Array.isArray(record.receipt)) {
    payloads.push(record.receipt as Record<string, unknown>);
  }
  let resultPayload: unknown = record.result;
  for (let depth = 0; depth < 3 && typeof resultPayload === 'string'; depth += 1) {
    try { resultPayload = JSON.parse(resultPayload); } catch { break; }
  }
  if (resultPayload && typeof resultPayload === 'object' && !Array.isArray(resultPayload)) {
    payloads.push(resultPayload as Record<string, unknown>);
  }
  return payloads.map(payload => {
    const payloadTask = parseObject(payload.task);
    return {
      taskId: compact(payload.taskId || payload.workTakeoverTaskId || payloadTask.id, 200),
      conversationTaskId: compact(payload.conversationTaskId, 200),
      requestId: compact(payload.requestId, 200),
    };
  });
}

function recordMatchesWorkflowBinding(task: WorkTakeoverTask, record: ToolExecutionRecord): boolean {
  const correlation = correlationFor(task);
  if (
    !correlation.conversationTaskId
    || !correlation.requestId
    || compact(record.taskId, 200) !== correlation.conversationTaskId
    || compact(record.requestId, 200) !== correlation.requestId
  ) return false;
  if (
    record.envelope
    && (
      compact(record.envelope.taskId, 200) !== correlation.conversationTaskId
      || compact(record.envelope.requestId, 200) !== correlation.requestId
    )
  ) return false;
  return payloadTaskBindings(record).every(payloadBinding => (
    (!payloadBinding.taskId || payloadBinding.taskId === task.id)
    && (!payloadBinding.conversationTaskId || payloadBinding.conversationTaskId === correlation.conversationTaskId)
    && (!payloadBinding.requestId || payloadBinding.requestId === correlation.requestId)
  ));
}

function recordFilePaths(records: ToolExecutionRecord[], contract: IndustryWorkflowContract): string[] {
  const candidates: string[] = [];
  records
    .filter(record => /^(?:create_|write_file|generate_|export_|save_|document_|cad_)/i.test(record.name))
    .forEach(record => collectPathCandidates(parseRecordPayload(record), candidates));
  return safeFilePaths(candidates, contract);
}

function persistedToolRun(record: ToolExecutionRecord): Record<string, any> {
  return {
    id: compact(record.id || `industry_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, 200),
    toolName: compact(record.name, 200),
    status: record.error || !String(record.result || '').trim() ? 'failed' : 'completed',
    error: compact(record.error, 1000),
    argumentsDigest: sha256(JSON.stringify(record.arguments || {})),
    toolArgs: record.arguments && typeof record.arguments === 'object' ? record.arguments : {},
    result: compact(record.result, 3000),
    resultDigest: sha256(record.result),
    receipt: record.receipt && typeof record.receipt === 'object' ? record.receipt : undefined,
    terminalVerification: record.terminalVerification,
    envelope: record.envelope,
    taskId: record.taskId || '',
    requestId: record.requestId || '',
    recordIdentityDigest: recordIdentityDigest(record),
    recordedAt: new Date().toISOString(),
  };
}

function toolRunMatchesRecord(run: Record<string, any>, record: ToolExecutionRecord): boolean {
  return Boolean(compact(run.recordIdentityDigest, 128))
    && compact(run.id, 200) === compact(record.id, 200)
    && compact(run.recordIdentityDigest, 128) === recordIdentityDigest(record);
}

function toolRecordReplayState(task: WorkTakeoverTask, records: ToolExecutionRecord[]): 'none' | 'exact' | 'conflict' {
  if (!records.length || records.some(record => !compact(record.id, 200))) return 'none';
  const current = Array.isArray(task.metadata?.workTakeoverToolRuns) ? task.metadata.workTakeoverToolRuns : [];
  const incoming = new Map<string, string>();
  let matched = 0;
  for (const record of records) {
    const recordId = compact(record.id, 200);
    const identity = recordIdentityDigest(record);
    const duplicateIdentity = incoming.get(recordId);
    if (duplicateIdentity && duplicateIdentity !== identity) return 'conflict';
    if (duplicateIdentity) continue;
    incoming.set(recordId, identity);
    const existing = current.find((run: any) => compact(run?.id, 200) === recordId);
    if (!existing) continue;
    if (!toolRunMatchesRecord(existing, record)) return 'conflict';
    matched += 1;
  }
  return matched === incoming.size ? 'exact' : 'none';
}

function toolRunHistory(task: WorkTakeoverTask, records: ToolExecutionRecord[]): any[] {
  const current = Array.isArray(task.metadata?.workTakeoverToolRuns)
    ? task.metadata.workTakeoverToolRuns.slice(-30)
    : [];
  const merged = [...current];
  for (const record of records.slice(-30)) {
    const appended = persistedToolRun(record);
    const sameId = compact(record.id, 200)
      ? merged.find((run: any) => compact(run?.id, 200) === compact(record.id, 200))
      : undefined;
    if (sameId) {
      if (!toolRunMatchesRecord(sameId, record)) {
        throw new Error('A conflicting industry tool receipt reused an existing record id.');
      }
      continue;
    }
    const duplicateWithoutId = !compact(record.id, 200) && merged.some((run: any) => (
      compact(run?.recordIdentityDigest, 128) === appended.recordIdentityDigest
    ));
    if (!duplicateWithoutId) merged.push(appended);
  }
  return merged.slice(-30);
}

function verificationRecord(
  task: WorkTakeoverTask,
  verification: WorkTakeoverResultVerification,
  correlation: ReturnType<typeof correlationFor>,
): ToolExecutionRecord {
  const verified = verification.passed;
  const receipt = {
    ok: verified,
    status: verified ? 'verified' : verification.status,
    persisted: true,
    workTakeoverTaskId: task.id,
    conversationTaskId: correlation.conversationTaskId,
    verificationId: verification.verificationId,
    verificationStatus: verification.status,
    blockerCount: verification.blockers.length,
  };
  return {
    id: `industry_receipt_${verification.verificationId}`,
    name: 'industry_workflow_verify',
    arguments: { taskId: task.id, entryId: workflowMetadata(task).entryId },
    result: JSON.stringify(receipt),
    receipt,
    ...(verified ? {} : { error: verification.summary }),
    taskId: correlation.conversationTaskId,
    requestId: correlation.requestId,
    idempotencyKey: `industry:${task.id}:${verification.verificationId}`,
    terminalVerification: {
      status: verified ? 'verified' : 'failed',
      strategy: 'artifact',
      reason: verification.summary,
    },
    capability: {
      capabilityId: 'industry.workflow.verify',
      lane: 'industry',
      operation: 'test',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'industry workflow archive and receipt ledger', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'verificationId'],
        requiredValues: { ok: true, persisted: true },
        successStatuses: ['verified'],
        failureStatuses: ['blocked', 'needs_review'],
        successSignals: ['server-side industry workflow verifier passed'],
        limitations: ['This verifies the scoped industry deliverable, not any unrequested external side effect.'],
      },
    },
  };
}

export function listCurrentIndustryWorkflowContracts(): IndustryWorkflowContract[] {
  return BUSINESS_LINES.flatMap(line => getIndustryWorkflowContracts(line));
}

export function startIndustryWorkflow(input: StartIndustryWorkflowInput): IndustryWorkflowStartResult {
  const contract = contractForCurrentProduct(input.entryId);
  const sourceInput = compact(input.sourceInput, 12_000);
  const activeWorkspace = workflowWorkspaceContext({ ...input, productLine: contract.productLine });
  const suppliedWorkspace = parseObject(input.context?.industryWorkspace);
  const explicitWorkspace = contract.productLine === 'finance'
    ? explicitFinanceWorkspaceContext(sourceInput)
    : null;
  const workflowWorkspace = mergeIndustryWorkspaceContext(activeWorkspace, suppliedWorkspace, explicitWorkspace);
  const boundContext = { ...(input.context || {}), ...(workflowWorkspace ? { industryWorkspace: workflowWorkspace } : {}) };
  const idempotencyKey = compact(input.idempotencyKey, 300);
  if (idempotencyKey) {
    const existing = listIndustryWorkflowTasks(input, 200).find(task => (
      workflowMetadata(task).idempotencyKey === idempotencyKey
      && workflowMetadata(task).entryId === contract.entryId
    ));
    if (existing) {
      const correlation = correlationFor(existing);
      return {
        task: existing,
        conversationId: correlation.conversationId,
        conversationTaskId: correlation.conversationTaskId,
        requestId: correlation.requestId,
        contract,
        handoffPrompt: buildHandoffPrompt(existing, contract),
        reused: true,
      };
    }
  }
  const requestId = compact(input.requestId, 200) || `industry_request_${crypto.randomUUID()}`;
  const requestedConversationId = compact(input.conversationId, 200);
  const conversation = (requestedConversationId
    ? getConversationForScope(requestedConversationId, input.userId, input.domain, input.orgId)
    : null) || getOrCreateActiveConversation(input.userId, 'lumi', input.domain, input.orgId);
  const requestedConversationTaskId = compact(input.conversationTaskId, 200);
  const existingConversationTaskId = requestedConversationTaskId && (readDB().conversationActionTasks || []).some((candidate: any) => (
    candidate.id === requestedConversationTaskId
    && candidate.conversationId === conversation.id
    && candidate.userId === input.userId
    && candidate.domain === input.domain
    && String(candidate.orgId || '') === String(input.orgId || '')
  )) ? requestedConversationTaskId : '';
  const task = createWorkTakeoverTask({
    userId: input.userId,
    domain: input.domain,
    orgId: input.orgId,
    title: contract.title,
    category: contract.category,
    source: input.source || 'industry_client',
    status: 'in_progress',
    summary: buildTaskSummary(contract, sourceInput),
    recommendedWorkflow: contract.recommendedWorkflow,
    nextActions: contract.nextActions,
    artifactsToPrepare: contract.requiredArtifactLabels,
    allowedNow: ['Read scoped source records', 'Run safe local analysis', 'Create reviewable local drafts and files', 'Verify and archive local results'],
    confirmationRequired: contract.confirmationBoundaries,
    risks: ['Missing or ambiguous source data must be reported, not guessed', 'Model narration is not completion evidence'],
    metadata: {
      industryWorkflow: {
        schemaVersion: 1,
        productLine: contract.productLine,
        variantId: 'main',
        entryId: contract.entryId,
        idempotencyKey,
        inputDigest: sha256(sourceInput),
        inputLength: sourceInput.length,
        requestId,
        conversationId: conversation.id,
        context: boundContext,
        contract: {
          requiredArtifactLabels: contract.requiredArtifactLabels,
          expectedContentTerms: contract.expectedContentTerms,
          confirmationBoundaries: contract.confirmationBoundaries,
          requiresFileArtifact: contract.requiresFileArtifact,
          acceptedFileExtensions: contract.acceptedFileExtensions,
        },
        createdAt: new Date().toISOString(),
      },
    },
  });
  const conversationTaskId = existingConversationTaskId || `industry_${task.id}`;
  const linkedTask = updateWorkTakeoverTask(input.userId, task.id, {
    metadata: {
      industryWorkflow: {
        ...workflowMetadata(task),
        conversationTaskId,
      },
    },
    note: `Linked to conversation action task ${conversationTaskId}.`,
  }) || task;

  const db = readDB();
  const industryContext = {
    workTakeoverTaskId: task.id,
    productLine: contract.productLine,
    entryId: contract.entryId,
    inputDigest: sha256(sourceInput),
    workspace: workflowWorkspace,
  };
  if (existingConversationTaskId) {
    const actionTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.id === existingConversationTaskId);
    const existingContext = parseObject(actionTask?.context);
    actionTask.context = JSON.stringify({ ...existingContext, industryWorkflow: industryContext });
    actionTask.updatedAt = new Date().toISOString();
  } else {
    ensureBackgroundConversationActionTask(db, {
      taskId: conversationTaskId,
      conversationId: conversation.id,
      userId: input.userId,
      domain: input.domain,
      orgId: input.orgId,
      goal: `Execute and verify ${contract.title} industry workflow`,
      target: `${contract.productLine}:${contract.entryId}`,
      requestId,
      source: 'industry_workflow',
      context: { industryWorkflow: industryContext },
    });
  }
  writeDB(db);

  return {
    task: linkedTask,
    conversationId: conversation.id,
    conversationTaskId,
    requestId,
    contract,
    handoffPrompt: buildHandoffPrompt(linkedTask, contract),
  };
}

export function listIndustryWorkflowTasks(scope: IndustryWorkflowScope, limit = 50): WorkTakeoverTask[] {
  return listWorkTakeoverTasks({
    userId: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
    limit: Math.max(1, Math.min(Number(limit) || 50, 200)),
  }).filter(task => {
    const metadata = workflowMetadata(task);
    return BUSINESS_LINES.includes(metadata.productLine) && Boolean(metadata.entryId);
  });
}

export function getIndustryWorkflowTask(scope: IndustryWorkflowScope, taskId: string): WorkTakeoverTask | null {
  const task = getWorkTakeoverTask(scope.userId, taskId);
  if (!task || !scopeMatches(task, scope)) return null;
  const metadata = workflowMetadata(task);
  return BUSINESS_LINES.includes(metadata.productLine) && metadata.entryId ? task : null;
}

export function reconcileInterruptedIndustryWorkflowTasks(): number {
  const db = readDB();
  let reconciled = 0;
  for (const actionTask of db.conversationActionTasks || []) {
    if (!['blocked', 'cancelled', 'completed'].includes(String(actionTask.status || ''))) continue;
    const context = parseObject(actionTask.context);
    const industry = parseObject(context.industryWorkflow);
    if (!BUSINESS_LINES.includes(industry.productLine as any)) continue;
    const workTakeoverTaskId = compact(industry.workTakeoverTaskId, 200);
    if (!workTakeoverTaskId) continue;
    const task = getWorkTakeoverTask(String(actionTask.userId || ''), workTakeoverTaskId);
    if (!task || !['queued', 'in_progress'].includes(task.status)) continue;
    const metadata = workflowMetadata(task);
    if (!BUSINESS_LINES.includes(metadata.productLine)) continue;
    const verificationPassed = task.metadata?.workTakeoverVerification?.passed === true;
    const nextStatus: WorkTakeoverStatus = actionTask.status === 'cancelled'
      ? 'cancelled'
      : actionTask.status === 'completed' && verificationPassed
        ? 'delivered'
        : 'blocked';
    const blocker = nextStatus === 'blocked'
      ? compact(actionTask.blocker, 1000) || 'The previous runtime ended before this industry workflow reached a verified terminal receipt.'
      : '';
    updateWorkTakeoverTask(task.userId, task.id, {
      status: nextStatus,
      blockedBy: blocker ? Array.from(new Set([...task.blockedBy, blocker])) : [],
      metadata: {
        industryWorkflowLastAttempt: {
          ...(task.metadata?.industryWorkflowLastAttempt || {}),
          status: nextStatus === 'delivered' ? 'passed' : nextStatus,
          reason: blocker,
          reconciledFromConversationTaskId: String(actionTask.id || ''),
          at: new Date().toISOString(),
        },
      },
      note: nextStatus === 'delivered'
        ? 'Industry workflow reconciled from a verified completed conversation task.'
        : 'Interrupted industry workflow reconciled from its persistent conversation task; no work was replayed.',
    });
    reconciled += 1;
  }
  return reconciled;
}

export function settleIndustryWorkflowConversationTask(
  task: WorkTakeoverTask,
  verification: WorkTakeoverResultVerification,
): void {
  const correlation = correlationFor(task);
  if (!correlation.conversationTaskId) return;
  const record = verificationRecord(task, verification, correlation);
  const db = readDB();
  settleBackgroundConversationActionTask(db, {
    taskId: correlation.conversationTaskId,
    userId: task.userId,
    records: [record],
    status: verification.passed ? 'completed' : 'blocked',
    blocker: verification.passed ? '' : verification.summary,
    requestId: correlation.requestId,
  });
  writeDB(db);
}

export function recordIndustryWorkflowExecution(input: RecordIndustryWorkflowInput): IndustryWorkflowRecordResult {
  const existing = getIndustryWorkflowTask(input, input.taskId);
  if (!existing) throw new Error('Industry workflow task was not found in the active user scope.');
  const contract = taskContract(existing);
  const toolRecords = (input.toolRecords || []).slice(-40);
  const resultText = compact(
    buildFinanceReviewableResult(existing, contract, toolRecords) || input.resultText,
    5000,
  );
  const explicitPaths = safeFilePaths(input.filePaths || [], contract);
  const discoveredPaths = recordFilePaths(toolRecords, contract);
  const filePaths = Array.from(new Set([...explicitPaths, ...discoveredPaths]));
  const submissionDigest = sha256(canonicalJson({
    resultText,
    files: filePaths.map(filePath => {
      const stat = fs.statSync(filePath);
      return { path: filePath, size: stat.size, modifiedAtMs: stat.mtimeMs };
    }),
    toolRecords: toolRecords.map(recordIdentityDigest),
  }));
  const previousArtifactCount = existing.artifacts.length;
  const previousDraftCount = existing.drafts.length;

  if (!resultText && filePaths.length === 0 && toolRecords.length === 0) {
    throw new Error('No result, file, or tool receipt was supplied for verification.');
  }
  const previousVerification = existing.metadata?.workTakeoverVerification as WorkTakeoverResultVerification | undefined;
  if (existing.status === 'delivered' && previousVerification?.passed && toolRecords.some(record => {
    if (record.error || record.terminalVerification?.status !== 'verified' || !recordMatchesWorkflowBinding(existing, record)) return false;
    const receipt = parseObject(record.result);
    return receipt.ok === true && receipt.status === 'verified' && (
      (record.name === 'industry_workflow_complete' && parseObject(receipt.task).id === existing.id)
      || ((contract.requiredToolReceipts || []).includes(record.name) && receipt.persisted === true && receipt.taskId === existing.id)
    );
  })) {
    return { task: existing, verification: previousVerification, conversationTaskId: conversationTaskIdFor(existing), archivedFilePaths: safeFilePaths(existing.artifacts.map(item => item.path || ''), contract) };
  }
  const replayState = toolRecordReplayState(existing, toolRecords);
  if (replayState === 'conflict') {
    throw new Error('A conflicting industry tool receipt reused an existing record id.');
  }
  if (replayState === 'exact' && previousVerification) {
    const previousSubmissionDigest = compact(existing.metadata?.industryWorkflowLastAttempt?.submissionDigest, 128);
    if (previousSubmissionDigest && previousSubmissionDigest !== submissionDigest) {
      throw new Error('An industry workflow replay reused the same tool receipt with a different submission.');
    }
    const previousResultDigest = compact(existing.metadata?.industryWorkflowLastAttempt?.resultDigest, 128);
    if (!previousSubmissionDigest && resultText && previousResultDigest && previousResultDigest !== sha256(resultText)) {
      throw new Error('An industry workflow replay reused the same tool receipt with a different result.');
    }
    return {
      task: existing,
      verification: previousVerification,
      conversationTaskId: conversationTaskIdFor(existing),
      archivedFilePaths: safeFilePaths(existing.artifacts.map(artifact => artifact.path || ''), contract),
    };
  }
  if (contract.requiresFileArtifact && filePaths.length === 0) {
    const blocker = `A real non-empty file is required (${contract.acceptedFileExtensions.join(', ')}); model text alone cannot complete this workflow.`;
    const blocked = updateWorkTakeoverTask(input.userId, existing.id, {
      status: 'blocked',
      blockedBy: Array.from(new Set([...existing.blockedBy, blocker])),
      result: resultText || blocker,
      metadata: {
        workTakeoverToolRuns: toolRunHistory(existing, toolRecords),
        industryWorkflowLastAttempt: {
          status: 'blocked',
          reason: blocker,
          resultDigest: sha256(resultText),
          submissionDigest,
          at: new Date().toISOString(),
        },
      },
      note: blocker,
    }) || existing;
    const verification = verifyWorkTakeoverResult(blocked, {
      requiredArtifactLabels: contract.requiredArtifactLabels,
      expectedContentTerms: contract.expectedContentTerms,
      minMatchedContentTerms: contract.minMatchedContentTerms,
      minFileBytes: 16,
      requireExternalOutcome: false,
      outcomeEvidence: toolRecords,
      requireOutputEvidence: true,
    });
    const blockedWithReceipt = updateWorkTakeoverTask(input.userId, blocked.id, {
      result: resultWithWorkflowReceipt(blocked.result || resultText || blocker, blocked.id, verification),
      metadata: {
        workTakeoverVerification: verification,
        industryWorkflowLastAttempt: {
          ...(blocked.metadata?.industryWorkflowLastAttempt || {}),
          status: verification.status,
          verificationId: verification.verificationId,
        },
      },
    }) || blocked;
    settleIndustryWorkflowConversationTask(blockedWithReceipt, verification);
    return { task: blockedWithReceipt, verification, conversationTaskId: conversationTaskIdFor(blockedWithReceipt), archivedFilePaths: [] };
  }

  let updated = updateWorkTakeoverTask(input.userId, existing.id, {
    status: 'in_progress',
    result: resultText || `Verified file candidates: ${filePaths.map(filePath => path.basename(filePath)).join(', ')}`,
    ...(contract.draftRequired && resultText ? { draftReply: resultText } : {}),
    metadata: {
      workTakeoverToolRuns: toolRunHistory(existing, toolRecords),
      industryWorkflowLastAttempt: {
        status: 'verifying',
        source: input.source || 'industry_client',
        resultDigest: sha256(resultText),
        submissionDigest,
        fileDigests: filePaths.map(filePath => ({ path: filePath, digest: sha256(`${filePath}:${fs.statSync(filePath).size}`) })),
        at: new Date().toISOString(),
      },
    },
    artifact: {
      type: filePaths.length ? (contract.entryId === 'cad' ? 'cad' : 'file') : 'document',
      label: contract.requiredArtifactLabels[0],
      path: filePaths[0],
      content: resultText || undefined,
      status: 'prepared',
    },
    note: 'Industry workflow result submitted for server-side verification.',
  }) || existing;

  for (const filePath of filePaths.slice(1)) {
    updated = updateWorkTakeoverTask(input.userId, updated.id, {
      artifact: {
        type: contract.entryId === 'cad' ? 'cad' : 'file',
        label: `${contract.requiredArtifactLabels[0]}: ${path.basename(filePath)}`,
        path: filePath,
        status: 'prepared',
      },
    }) || updated;
  }

  const currentAttemptTask: WorkTakeoverTask = {
    ...updated,
    result: resultText,
    artifacts: updated.artifacts.slice(previousArtifactCount),
    drafts: updated.drafts.slice(previousDraftCount),
  };
  const verification = enforceReviewableCurrentResult(enforceRequiredToolEvidence(verifyWorkTakeoverResult(currentAttemptTask, {
    filePaths,
    draftRequired: contract.draftRequired === true,
    requiredArtifactLabels: contract.requiredArtifactLabels,
    expectedContentTerms: contract.expectedContentTerms,
    minMatchedContentTerms: contract.minMatchedContentTerms,
    minFileBytes: 16,
    requireExternalOutcome: false,
    outcomeEvidence: toolRecords,
    requireOutputEvidence: true,
  }), currentAttemptTask, contract, toolRecords), resultText);
  const status: WorkTakeoverStatus = verification.passed
    ? 'delivered'
    : verification.status === 'blocked'
      ? 'blocked'
      : 'waiting_confirmation';
  const terminalResultText = resultWithWorkflowReceipt(resultText, updated.id, verification);
  updated = updateWorkTakeoverTask(input.userId, updated.id, {
    status,
    result: terminalResultText,
    ...(contract.draftRequired && terminalResultText ? { draftReply: terminalResultText } : {}),
    blockedBy: verification.passed ? [] : Array.from(new Set([...updated.blockedBy, ...verification.blockers])),
    metadata: {
      workTakeoverVerification: verification,
      industryWorkflowLastAttempt: {
        ...(updated.metadata?.industryWorkflowLastAttempt || {}),
        status: verification.status,
        verificationId: verification.verificationId,
      },
    },
    artifact: {
      type: 'checklist',
      label: 'Industry workflow verification receipt',
      content: JSON.stringify({
        verificationId: verification.verificationId,
        status: verification.status,
        checkedAt: verification.checkedAt,
        checks: verification.checks,
      }, null, 2),
      status: verification.passed ? 'delivered' : 'needs_review',
    },
    note: verification.summary,
  }) || updated;
  settleIndustryWorkflowConversationTask(updated, verification);
  return {
    task: updated,
    verification,
    conversationTaskId: conversationTaskIdFor(updated),
    archivedFilePaths: filePaths,
  };
}

export function validateIndustryWorkflowSourceInput(task: WorkTakeoverTask, value: unknown): string {
  const sourceInput = compact(value, 12_000);
  if (!sourceInput) return '';
  const expectedDigest = compact(workflowMetadata(task).inputDigest, 128);
  if (!expectedDigest || sha256(sourceInput) !== expectedDigest) {
    throw new Error('Industry workflow source input does not match the source bound when the task was created.');
  }
  return sourceInput;
}

export function interruptIndustryWorkflow(scope: IndustryWorkflowScope, id: string, cancelled: boolean, reason: string): void {
  const task = getIndustryWorkflowTask(scope, id);
  if (!task || task.status === 'delivered') return;
  updateWorkTakeoverTask(scope.userId, id, { status: cancelled ? 'cancelled' : 'blocked', blockedBy: [reason], note: reason });
  const db = readDB();
  settleBackgroundConversationActionTask(db, { taskId: conversationTaskIdFor(task), userId: scope.userId, records: [], status: cancelled ? 'cancelled' : 'blocked', blocker: reason, requestId: correlationFor(task).requestId });
  writeDB(db);
}

/** Persist each completed execution before another model request can time out. */
export async function observeIndustryWorkflowTool(scope: IndustryWorkflowScope, id: string, record: ToolExecutionRecord): Promise<void> {
  const task = getIndustryWorkflowTask(scope, id);
  if (!task) throw new Error('Industry workflow task was not found in the active user scope.');
  const correlation = correlationFor(task);
  if (!recordMatchesWorkflowBinding(task, record)) throw new Error('Industry tool receipt does not match the bound workflow.');
  const db = readDB();
  const action = findConversationActionTask(db, { userId: scope.userId, conversationId: correlation.conversationId, taskId: correlation.conversationTaskId });
  if (!action) throw new Error('The linked conversation task was not found.');
  appendConversationActionReceipts(db, { task: action, records: [record], requestId: correlation.requestId });
  writeDB(db);
  // Keep observation separate from delivery verification and its replay digest.
  const observations = Array.isArray(task.metadata?.industryObservedTools) ? task.metadata.industryObservedTools : [];
  updateWorkTakeoverTask(scope.userId, id, { metadata: { industryObservedTools: [...observations.filter((item: any) => item.id !== record.id), { id: record.id, name: record.name, error: record.error || null, status: record.terminalVerification?.status || 'unverified', at: new Date().toISOString() }].slice(-40) } });
  await flushDBOrThrow();
}

export function startOrReuseIndustryWorkflow(
  input: StartIndustryWorkflowInput,
  boundTaskId?: string,
): IndustryWorkflowStartResult {
  const candidate = !boundTaskId && input.requestId
    ? listIndustryWorkflowTasks(input, 200).find(task => {
        const meta = workflowMetadata(task);
        return meta.requestId === input.requestId && meta.entryId === input.entryId && meta.inputDigest === sha256(compact(input.sourceInput, 12_000));
      })
    : null;
  const taskId = compact(boundTaskId || candidate?.id, 200);
  if (!taskId) return startIndustryWorkflow(input);
  const existing = getIndustryWorkflowTask(input, taskId);
  if (!existing) throw new Error('The bound industry workflow task was not found in the active user scope.');
  const contract = taskContract(existing);
  if (contract.entryId !== String(input.entryId || '').trim()) {
    throw new Error('The bound industry workflow task does not match the requested entry.');
  }
  const sourceInput = compact(input.sourceInput, 12_000);
  if (sourceInput) validateIndustryWorkflowSourceInput(existing, sourceInput);
  const correlation = correlationFor(existing);
  return {
    task: existing,
    conversationId: correlation.conversationId,
    conversationTaskId: correlation.conversationTaskId,
    requestId: correlation.requestId,
    contract,
    handoffPrompt: buildHandoffPrompt(existing, contract),
    reused: true,
  };
}
