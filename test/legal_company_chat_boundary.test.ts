import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { classifyExecutionGuardIntent, sanitizeExecutionResponseForDelivery } from '../server/cognition/execution_guard_recovery';
import { taskCompletionFromReceipts, recordsToTaskReceipts } from '../server/cognition/task_execution_ledger';
import { finalizeLumiResponseForDelivery } from '../server/cognition/response_delivery';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { buildActionContract } from '../server/cognition/action_contract';
import { hasLegalExternalPlatformResultEvidence } from '../server/cognition/result_policy_evidence';
import { mcpManager } from '../server/mcp/client';
import * as SourceAdapters from '../server/legal/sources';
import * as Cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const text = '请通过我已配置的企查查官方数据源，查询“企查查科技股份有限公司”的工商登记信息。只查询企查查的工商登记这一项，不查询其他平台、不查询股东或风险，不入案、不写入知识库、不发送任何消息。请清楚列出实际查询到的企业名称、登记状态、成立日期和注册资本，并说明来源和查询时间；如果调用失败或未拿到真实回执，请直接说明失败，不要凭记忆补写。';
const raw = JSON.stringify({企业名称:'虚构企业查询样本有限公司',统一社会信用代码:'SYNTHETIC-QCC-BOUNDARY',登记状态:'存续',成立日期:'2020-01-02',注册资本:'10万元'});
beforeAll(async () => { app = await makeApp(); const { registerAllTools } = await import('../server/tools/definitions'); registerAllTools(registry); });
afterAll(() => app.cleanup());
beforeEach(() => {
  for (const key of ['QICHACHA_API_KEY','QICHACHA_APP_KEY','QICHACHA_SECRET_KEY','TIANYANCHA_API_KEY','QIXINBAO_API_KEY']) vi.stubEnv(key, '');
  vi.stubEnv('QICHACHA_API_KEY', 'synthetic-offline-qcc');
  vi.stubGlobal('fetch',vi.fn(async () => { throw Error('Offline fixture forbids network'); }));
  vi.spyOn(mcpManager,'callToolForServer').mockResolvedValue(raw);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture(sourceText = text) {
  const userId = 'qcc-chat-boundary-' + randomUUID(), requestId = randomUUID(), taskId = 'task_' + randomUUID();
  const taskText = sourceText.replaceAll('企查查科技股份有限公司', '虚构企业查询样本有限公司');
  const pipeline = buildLumiExecutionPipeline({ dispatch: { userId, text:taskText, channel: 'chat', source: 'command-center-chat', operationMode: 'assistant', targetIsLumi: true, domain: 'personal' }, registry, executionBoundary: 'trusted_local' });
  const context = { userId, requestId, taskId, turnId:requestId, domain:'personal', authenticated:true, authRole:'user', localExecution:true, executionBoundary:'trusted_local', source:'command-center-chat', toolPolicy:pipeline.authorizationPolicy, acceptedActionContract:pipeline.turnIntent.flow.acceptedActionContract } as any;
  return { userId, requestId, taskId, taskText, pipeline, context };
}
const run = (f: ReturnType<typeof fixture>, args: Record<string,unknown> = {}) => executeToolCall({id:'qcc-fixture-'+randomUUID(),registry,name:'legal_company_database_lookup',arguments:{name:'虚构企业查询样本有限公司',sourceIds:['qichacha'],persistCase:false,...args},context:f.context});
const evidence = (record: Awaited<ReturnType<typeof run>>, f: ReturnType<typeof fixture>) => hasLegalExternalPlatformResultEvidence([record], {requestId:f.requestId,taskId:f.taskId,taskText:f.taskText});
describe('company lookup current-turn read boundary', () => {
  it('projects the actual source instead of client state, messaging, or document production', () => {
    const { pipeline } = fixture();
    expect(pipeline.turnIntent.boundary).toBe('tool_action');
    expect(pipeline.turnIntent.flow.clientActionOnlyTurn).toBe(false);
    expect(pipeline.turnIntent.flow.selfRepairTurn).toBe(false);
    expect(pipeline.turnIntent.flow.acceptedActionContract?.contract.kind).toBe('none');
    expect(pipeline.modelToolProjection.toolNames).toContain('legal_company_database_lookup');
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('legal_case_workspace');
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('legal_import_materials_to_kb');
    expect(pipeline.modelToolProjection.toolNames.some(name => /send_message|send_file/.test(name))).toBe(false);
  });
  it('retains real asset and equity observation tools without creating document obligations', () => {
    const query='查被执行人财产线索和股权穿透';
    const pipeline=buildLumiExecutionPipeline({dispatch:{userId:'asset-observe-fixture',text:query,channel:'chat',source:'command-center-chat',operationMode:'assistant',targetIsLumi:true,domain:'personal'},registry,executionBoundary:'trusted_local'});
    expect(pipeline.turnIntent.flow.acceptedActionContract?.contract.kind).toBe('none');
    expect(pipeline.modelToolProjection.toolNames).toContain('legal_trace_assets');
    expect(pipeline.modelToolProjection.toolNames).toContain('legal_equity_penetration');
  });
  it('keeps the fresh source query as execution when its failure clause only asks for truthful reporting', () => {
    expect(classifyExecutionGuardIntent(text)).toBe('action_execution');
    for (const followup of ['刚才查询的结果是什么？', '请查询刚才任务的回执。', '请查找上次任务的执行结果。']) expect(classifyExecutionGuardIntent(followup)).toBe('status_query');
  });
  it('allows a current verified atomic source query to finish without requiring document production', async () => {
    const f=fixture(),record=await run(f);
    expect(taskCompletionFromReceipts(f.taskText,recordsToTaskReceipts([record]),undefined,{requestId:f.requestId,taskId:f.taskId}).complete).toBe(true);
  });
  it('projects the same observed query as clear public content and completed feedback', async () => {
    const f=fixture(),record=await run(f),candidate='已通过企查查查询虚构企业查询样本有限公司。登记状态：存续；成立日期：2020-01-02；注册资本：10万元。来源为企查查官方 MCP，本次查询时间见当前回执。';
    const result=await finalizeLumiResponseForDelivery({taskText:f.taskText,responseText:candidate,toolRecords:[record],source:'chat',flow:f.pipeline.turnIntent.flow,taskId:f.taskId,requestId:f.requestId,allowToolUse:true});
    expect(result.finalization.blocked).toBe(false);
    const publicResult=sanitizeExecutionResponseForDelivery(result.finalization,{task:f.taskText,toolRecords:[record],requestId:f.requestId,taskId:f.taskId});
    expect(publicResult.blocked).toBe(false);expect(publicResult.text).toContain('2020-01-02');expect(publicResult.text).toContain('10万元');
    const feedback=buildForegroundTaskCompletionFeedback({taskId:f.taskId,taskLabel:f.taskText,toolRecords:[record],finalization:publicResult});
    expect(feedback?.status).toBe('completed');expect(taskCompletionFromReceipts(f.taskText,recordsToTaskReceipts([record]),undefined,{requestId:f.requestId,taskId:f.taskId}).complete).toBe(true);
  });
  it('does not complete a missing, stale, cross-task, wrong-subject, compound, or mismatched source query', async () => {
    const f=fixture(),record=await run(f),receipts=recordsToTaskReceipts([record]),current={requestId:f.requestId,taskId:f.taskId};
    for(const [goal,rows,turn] of [
      [f.taskText,[],current],
      [f.taskText,receipts,{...current,requestId:'stale-turn'}],
      [f.taskText,receipts,{...current,taskId:'other-task'}],
      [f.taskText,receipts.map(row=>({...row,scopeConflict:true as const})),current],
      [f.taskText.replaceAll('虚构企业查询样本有限公司','另一虚构公司'),receipts,current],
      [f.taskText+'另查询股东信息。',receipts,current],
      [f.taskText+'另查询“另一虚构公司”的工商。',receipts,current],
      [f.taskText+'并创建 D:/fixture/extra.txt。',receipts,current],
    ] as const)expect(taskCompletionFromReceipts(goal,[...rows],undefined,turn).complete).toBe(false);
    for(const sourceChange of [{sourceEndpoint:'https://other.invalid/mcp/company/stream'},{sourceTool:'get_company_risk_scan'},{queryType:'risk'},{status:'partial'}]){
      const changed=structuredClone(receipts);Object.assign((changed[0].receipt as any).sourceResults[0],sourceChange);
      expect(taskCompletionFromReceipts(f.taskText,changed,undefined,current).complete).toBe(false);
    }
  });
  it('requires every requested query range before completing a same-company multi-range lookup', async () => {
    const f=fixture('请通过企查查查询“企查查科技股份有限公司”的工商登记和股东信息，不入案、不写入知识库、不发送。'),registration=await run(f);
    const current={requestId:f.requestId,taskId:f.taskId};
    expect(taskCompletionFromReceipts(f.taskText,recordsToTaskReceipts([registration]),undefined,current).complete).toBe(false);
    expect(hasLegalExternalPlatformResultEvidence([registration],{...current,taskText:f.taskText})).toBe(false);
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify([{股东名称:'虚构股东',持股比例:'100%'}]));
    const shareholders=await run(f,{queryType:'shareholders'});
    expect(shareholders.receipt).toMatchObject({ok:true,status:'observed',sourceResults:[{queryType:'shareholders',sourceTool:'get_shareholder_info'}]});
    expect(taskCompletionFromReceipts(f.taskText,recordsToTaskReceipts([registration,shareholders]),undefined,current).complete).toBe(true);
    expect(hasLegalExternalPlatformResultEvidence([registration,shareholders],{...current,taskText:f.taskText})).toBe(true);
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the existing non-QCC HTTPS source contract when its actual source receipt is present', async () => {
    vi.spyOn(SourceAdapters,'searchCompanySources').mockResolvedValueOnce([{name:'虚构企业查询样本有限公司',sourceName:'Synthetic authorized HTTPS provider',sourceText:JSON.stringify({name:'虚构企业查询样本有限公司',creditCode:'SYNTHETIC-TYC'}),sourceEndpoint:'https://authorized-provider.invalid/company',queriedAt:'2026-01-02T03:04:05Z'}] as any);
    const f=fixture('请通过天眼查查询“企查查科技股份有限公司”的工商登记，不入案、不写入知识库、不发送。'),record=await run(f,{sourceIds:['tianyancha']});
    expect(record.receipt).toMatchObject({ok:true,status:'observed',sourceResults:[{sourceEndpoint:'https://authorized-provider.invalid/company'}]});expect(evidence(record,f)).toBe(true);
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('binds prohibited persistence off before canonical execution even if the model requests it', async () => {
    const f=fixture(), orgId=Cases.legalWorkspaceNamespace(f.userId), item=Cases.createCase(orgId,f.userId,{title:'Synthetic source-only case'});
    const before=JSON.stringify(Cases.getCase(orgId,item.id,f.userId));
    const record=await run(f,{caseId:item.id,persistCase:true,confirmedForKb:true});
    expect(record.arguments).toMatchObject({persistCase:false,confirmedForKb:false});
    expect(record.receipt).toMatchObject({ok:true,status:'observed',sourceResults:[{status:'observed',sourceTool:'get_company_registration_info',sourceEndpoint:'https://agent.qcc.com/mcp/company/stream'}]});
    expect(record.result).toContain(raw);expect(record.result).toContain('未配置');
    expect(evidence(record,f)).toBe(true);
    expect(JSON.stringify(Cases.getCase(orgId,item.id,f.userId))).toBe(before);
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['authorization','empty'])('does not promote a real %s source failure despite an observed-looking narrative', async mode => {
    if(mode==='authorization')vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(Error('HTTP 401 synthetic'));
    else vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce('[]');
    const f=fixture(),record=await run(f);
    expect(record.receipt).toMatchObject({ok:false,status:'partial',sourceResults:[]});expect(evidence(record,f)).toBe(false);
    expect(record.result).not.toContain('企业不存在');expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a stale receipt, a copied record, and post-seal result alteration', async () => {
    const f=fixture(),record=await run(f);
    expect(hasLegalExternalPlatformResultEvidence([record],{requestId:'a-different-turn',taskId:f.taskId,taskText:f.taskText})).toBe(false);
    expect(hasLegalExternalPlatformResultEvidence([{...record}],{requestId:f.requestId,taskId:f.taskId,taskText:f.taskText})).toBe(false);
    record.result += '\nAdded unsupported platform result';expect(evidence(record,f)).toBe(false);
  });
  it('cannot substitute another selected database for the requested official QCC source', async () => {
    vi.stubEnv('TIANYANCHA_API_KEY','synthetic-tyc');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({error_code:0,result:{name:'Different synthetic provider',creditCode:'OTHER-SOURCE'}}),{status:200}));
    const f=fixture(),record=await run(f,{sourceIds:['tianyancha']});
    expect(record.receipt).toMatchObject({ok:true,status:'observed'});expect(evidence(record,f)).toBe(false);
    expect(record.result).toContain('OTHER-SOURCE');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves genuine client navigation and genuine file creation contracts', () => {
    expect(buildActionContract('打开知识库').preferredTools).toContain('client_action');
    expect(buildActionContract('创建 C:\\fixture\\report.txt，写入 synthetic text').kind).toBe('artifact_work');
    const f=fixture();
    expect(registry.prepareExecution('legal_company_database_lookup',{name:'Synthetic',persistCase:true,confirmedForKb:true},{...f.context,acceptedActionContract:undefined}).arguments).toMatchObject({persistCase:true,confirmedForKb:true});
  });
});
