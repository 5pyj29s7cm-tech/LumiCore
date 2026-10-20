import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildActionContract } from '../server/cognition/action_contract';
import { hasLegalExternalPlatformResultEvidence } from '../server/cognition/result_policy_evidence';
import { mcpManager } from '../server/mcp/client';
import * as Cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const text = '请通过我已配置的企查查官方数据源，查询“企查查科技股份有限公司”的工商登记信息。只查询企查查的工商登记这一项，不查询其他平台、不查询股东或风险，不入案、不写入知识库、不发送任何消息。请清楚列出实际查询到的企业名称、登记状态、成立日期和注册资本，并说明来源和查询时间；如果调用失败或未拿到真实回执，请直接说明失败，不要凭记忆补写。';
const raw = JSON.stringify({企业名称:'虚构企业查询样本',统一社会信用代码:'SYNTHETIC-QCC-BOUNDARY',登记状态:'存续',成立日期:'2020-01-02',注册资本:'10万元'});
beforeAll(async () => { app = await makeApp(); const { registerAllTools } = await import('../server/tools/definitions'); registerAllTools(registry); });
afterAll(() => app.cleanup());
beforeEach(() => {
  for (const key of ['QICHACHA_API_KEY','QICHACHA_APP_KEY','QICHACHA_SECRET_KEY','TIANYANCHA_API_KEY','QIXINBAO_API_KEY']) vi.stubEnv(key, '');
  vi.stubEnv('QICHACHA_API_KEY', 'synthetic-offline-qcc');
  vi.stubGlobal('fetch',vi.fn(async () => { throw Error('Offline fixture forbids network'); }));
  vi.spyOn(mcpManager,'callToolForServer').mockResolvedValue(raw);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture() {
  const userId = 'qcc-chat-boundary-' + randomUUID(), requestId = randomUUID();
  const pipeline = buildLumiExecutionPipeline({ dispatch: { userId, text, channel: 'chat', source: 'command-center-chat', operationMode: 'assistant', targetIsLumi: true, domain: 'personal' }, registry, executionBoundary: 'trusted_local' });
  const context = { userId, requestId, domain:'personal', authenticated:true, authRole:'user', localExecution:true, executionBoundary:'trusted_local', source:'command-center-chat', toolPolicy:pipeline.authorizationPolicy, acceptedActionContract:pipeline.turnIntent.flow.acceptedActionContract } as any;
  return { userId, requestId, pipeline, context };
}
const run = (f: ReturnType<typeof fixture>, args: Record<string,unknown> = {}) => executeToolCall({registry,name:'legal_company_database_lookup',arguments:{name:'虚构企业查询样本-'+f.requestId,sourceIds:['qichacha'],persistCase:false,...args},context:f.context});
const evidence = (record: Awaited<ReturnType<typeof run>>, f: ReturnType<typeof fixture>) => hasLegalExternalPlatformResultEvidence([record], {requestId:f.requestId,taskText:text});
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
    expect(hasLegalExternalPlatformResultEvidence([record],{requestId:'a-different-turn',taskText:text})).toBe(false);
    expect(hasLegalExternalPlatformResultEvidence([{...record}],{requestId:f.requestId,taskText:text})).toBe(false);
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
