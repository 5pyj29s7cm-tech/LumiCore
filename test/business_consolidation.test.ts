import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { analyzeCampaignRoi } from '../server/skills/bundled/ecommerce-ops/logic';
import { bindIndustryWorkspaceContext, getActiveIndustryWorkspaceContext, listIndustryWorkspaceContexts, selectIndustryWorkspaceContext } from '../server/industry/workspace_context';
import { getIndustryWorkflowTask, interruptIndustryWorkflow, observeIndustryWorkflowTool, startIndustryWorkflow } from '../server/industry/workflow_service';
beforeAll(async () => { await initDatabase(); });
describe('main business consolidation', () => {
  it('delivers verified source-bound analysis without another model summary, but never completes additional work', () => {
    const message = '销售额36000元，120单，客单价300元；ROAS 5，退款金额占比10%。未提供成本，不计算利润。';
    const input = { taskText: '请分析今日店铺经营：销售额36000元，订单120单，广告费7200元，退款3600元。', responseText: 'The model timed out.', source: 'chat', requestId: 'business-request', taskId: 'business-task', toolRecords: [{ name: 'industry_ecommerce_today_snapshot', arguments: { sourceBound: true }, requestId: 'business-request', taskId: 'business-task', result: JSON.stringify({ ok: true, status: 'verified', persisted: true, sourceBound: true, externalMutation: false, conversationTaskId: 'business-task', message }), terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'Source-bound persisted analysis' } }] };
    expect(tryFinalizeVerifiedBoundedAction(input)).toMatchObject({ blocked: false, text: message });
    expect(finalizeLumiResponse(input)).toMatchObject({ blocked: false, text: message });
    expect(tryFinalizeVerifiedBoundedAction({ ...input, requestId: 'another-request' })).toBeNull();
    expect(tryFinalizeVerifiedBoundedAction({ ...input, taskText: input.taskText + '另外生成一张商品海报。' })).toBeNull();
    expect(tryFinalizeVerifiedBoundedAction({ ...input, taskText: input.taskText + '导出Excel文件。' })).toBeNull();
  });
  it('never treats an absent gross margin as a supplied 35 percent profit basis', () => {
    const result = analyzeCampaignRoi({ campaignText: 'Campaign A spend 7200 revenue 36000 orders 120' });
    expect(result.summary.roas).toBe(5);
    expect(result.summary.contributionAfterAds).toBeNull();
    expect(result.assumptions.grossMarginRate).toBeNull();
    expect(result.scaleCandidates).toEqual([]);
    expect(analyzeCampaignRoi({ campaignText: 'Campaign A spend 7200 revenue 36000 orders 120', grossMarginRate: 0.5 }).summary.contributionAfterAds).toBe(10800);
  });
  it('retains scoped execution receipts when a later model call is cancelled', async () => {
    const scope = { userId: 'business-cancellation', domain: 'personal' as const, orgId: '' };
    const started = startIndustryWorkflow({ ...scope, entryId: 'today-operations', sourceInput: 'orders 10, revenue 500' });
    const record = { id: 'business-observed-tool', taskId: started.conversationTaskId, requestId: started.requestId, name: 'industry_workspace_status', arguments: {}, result: JSON.stringify({ ok: true, active: null }), terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'read completed' } };
    await observeIndustryWorkflowTool(scope, started.task.id, record);
    await observeIndustryWorkflowTool(scope, started.task.id, record);
    await expect(observeIndustryWorkflowTool({ ...scope, userId: 'another-owner' }, started.task.id, record)).rejects.toThrow();
    await expect(observeIndustryWorkflowTool(scope, started.task.id, { ...record, taskId: 'unrelated' })).rejects.toThrow();
    interruptIndustryWorkflow(scope, started.task.id, true, 'Cancelled while waiting for the next model response');
    const task = getIndustryWorkflowTask(scope, started.task.id)!;
    expect(task.status).toBe('cancelled');
    expect(task.metadata?.industryObservedTools).toHaveLength(1);
    const receipts = readDB().conversationActionReceipts.filter(item => item.taskId === started.conversationTaskId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].toolName).toBe(record.name);
    expect(started.handoffPrompt).not.toContain('First call work_takeover_task_get');
  });
  it('keeps stores and companies independently bound without crossing owners or organizations', () => {
    const scope = { userId: 'business-owner', domain: 'personal' as const, orgId: '' };
    const company = bindIndustryWorkspaceContext(scope, { productLine: 'finance', name: 'Company A', attributes: { accountingPeriod: '2026-09', currency: 'CNY' } });
    const store = bindIndustryWorkspaceContext(scope, { productLine: 'ecommerce', name: 'Store A', attributes: { entityId: company.id, reportingPeriod: '2026-09', currency: 'CNY' } });
    expect(getActiveIndustryWorkspaceContext({ ...scope, productLine: 'finance' })?.id).toBe(company.id);
    expect(getActiveIndustryWorkspaceContext({ ...scope, productLine: 'ecommerce' })?.id).toBe(store.id);
    expect(getActiveIndustryWorkspaceContext(scope)).toBeNull();
    expect(listIndustryWorkspaceContexts({ ...scope, userId: 'another-owner' })).toEqual([]);
    expect(() => selectIndustryWorkspaceContext({ ...scope, userId: 'another-owner' }, company.id)).toThrow();
    expect(() => listIndustryWorkspaceContexts({ ...scope, domain: 'work' })).toThrow();
    const ecommerce = startIndustryWorkflow({ ...scope, entryId: 'today-operations', sourceInput: 'orders 10, revenue 500' });
    const finance = startIndustryWorkflow({ ...scope, entryId: 'accounting', sourceInput: 'reconcile September' });
    expect(ecommerce.task.metadata?.industryWorkflow?.context?.industryWorkspace?.id).toBe(store.id);
    expect(finance.task.metadata?.industryWorkflow?.context?.industryWorkspace?.id).toBe(company.id);
    selectIndustryWorkspaceContext(scope, company.id);
    expect(getIndustryWorkflowTask(scope, ecommerce.task.id)?.metadata?.industryWorkflow?.context?.industryWorkspace?.id).toBe(store.id);
  });
  it.each(['chat', 'voice'] as const)('makes domain calculations reachable through the existing %s pipeline', channel => {
    const registry = new ToolRegistry(); registerAllTools(registry);
    for (const [text, expected] of [
      ['请核对这份发票的税额并生成票税复核报告', 'business_finance_vat_invoice_review'],
      ['请计算店铺订单利润，分析销售额、成本、广告费和退款', 'business_ecommerce_ecommerce_order_profit'],
      ['这是隔离验收，不写入日常记忆。请执行今日经营分析：订单120单，销售额36000元，广告花费7200元，退款金额3600元，售后8单；SKU-A库存6件，SKU-B库存80件。不要连接真实店铺，缺少成本时不要计算利润。', 'industry_ecommerce_today_snapshot'],
    ]) {
      const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'business-routing', channel, source: channel, operationMode: 'assistant', text, targetIsLumi: true }, registry,
        personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 20 } });
      expect(pipeline.executionRequested).toBe(true);
      expect(pipeline.modelToolProjection.toolNames).toContain(expected);
    }
  });
  it('keeps general no-write and external-store prohibitions while allowing the requested local analysis', () => {
    const registry = new ToolRegistry(); registerAllTools(registry);
    const make = (text: string) => buildLumiExecutionPipeline({ dispatch: { userId: 'business-fences', channel: 'chat', source: 'chat', operationMode: 'assistant', text, targetIsLumi: true }, registry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 20 } });
    const scoped = make('请分析店铺今日经营数据：销售额500元，订单10单。不要写入日常记忆，不要修改真实店铺。');
    expect(scoped.modelToolProjection.toolNames).toContain('industry_ecommerce_today_snapshot');
    expect(scoped.authorizationPolicy.forbiddenTools).toContain('industry_workspace_bind');
    const global = make('请分析店铺销售额，但不要写入任何文件，不要保存任何数据。');
    expect(global.modelToolProjection.toolNames).not.toContain('industry_ecommerce_today_snapshot');
  });
});
