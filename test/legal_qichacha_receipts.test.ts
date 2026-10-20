import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { mcpManager } from '../server/mcp/client';
import { searchCompanySources, listLegalSourceCapabilities } from '../server/legal/sources';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { createCase, getCase } from '../server/org/legal_cases';
import { legalWorkspaceId } from '../server/regions/packs/cn/legal_tools/context';

const company = JSON.stringify({企业名称:'虚构单密钥企业',统一社会信用代码:'SYNTHETIC-QCC-ID',法定代表人:'模拟甲',登记状态:'存续',注册资本:'10万元'});
const fixtureSecret = 'fixture-qcc-do-not-echo';
const registry = new ToolRegistry();
const userId = 'qcc-receipt-fixture-owner';
const context = { userId, domain:'personal', authenticated:true, authRole:'user' } as any;
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); registerLegalTools(registry); });
afterAll(() => app.cleanup());
beforeEach(() => {
  for (const key of ['QICHACHA_API_KEY','QICHACHA_APP_KEY','QICHACHA_SECRET_KEY','QICHACHA_BASE_URL','TIANYANCHA_API_KEY','QIXINBAO_API_KEY']) vi.stubEnv(key,'');
  vi.stubEnv('QICHACHA_API_KEY',fixtureSecret);
  vi.stubGlobal('fetch',vi.fn(async () => { throw Error('Offline fixture prohibits network'); }));
  vi.spyOn(mcpManager,'callToolForServer').mockResolvedValue(company);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const run = (args: Record<string, unknown> = {}, name = 'legal_company_database_lookup') => executeToolCall({registry,name,arguments:{name:'虚构单密钥企业',sourceIds:['qichacha'],persistCase:false,...args},context});

describe('shared QCC query contract and truthful failure receipts', () => {
  it('uses one official MCP key and returns exact Chinese registration data once',async () => {
    const result = await run();
    expect(result.receipt).toMatchObject({ok:true,status:'observed'});
    expect(result.result).toContain('虚构单密钥企业');
    expect(result.result).toContain('SYNTHETIC-QCC-ID');
    expect(result.result).toContain(company);
    expect(result.result).toContain('get_company_registration_info');
    expect(result.result).toContain('https://agent.qcc.com/mcp/company/stream');
    expect(listLegalSourceCapabilities().find(s=>s.id==='qichacha')).toMatchObject({configured:true,canAutoQuery:true});
    expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-company','get_company_registration_info',{searchKey:'虚构单密钥企业'},expect.objectContaining({configuration:expect.objectContaining({headers:{Authorization:'Bearer '+fixtureSecret}})}));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.result).not.toContain(fixtureSecret);
  });
  it.each([
    ['authorization', () => Promise.reject(Error('HTTP 401 Bearer '+fixtureSecret))],
    ['authorization', () => Promise.resolve(JSON.stringify({code:403,message:fixtureSecret}))],
    ['timeout', () => Promise.reject(Object.assign(Error(fixtureSecret),{name:'TimeoutError'}))],
    ['connection', () => Promise.reject(Error('proxy connection failure '+fixtureSecret))],
    ['provider', () => Promise.resolve(JSON.stringify({code:429,message:fixtureSecret}))],
    ['response', () => Promise.resolve('<html>'+fixtureSecret+'</html>')],
    ['response', () => Promise.resolve(JSON.stringify({unexpected:'provider data'}))],
    ['empty', () => Promise.resolve('[]')],
    ['empty', () => Promise.resolve('{}')],
  ] as const)('reports %s failures explicitly without leaking provider text or archiving',async (kind,reply) => {
    vi.mocked(mcpManager.callToolForServer).mockImplementationOnce(reply);
    const item=createCase(legalWorkspaceId({},context),userId,{title:'虚构失败查询'});
    const result=await run({caseId:item.id,persistCase:true,confirmedForKb:true});
    expect(result.receipt).toMatchObject({ok:false,status:'partial'});
    expect(result.result).toContain('[QCC_'+kind.toUpperCase()+']');
    expect(result.result).not.toContain(fixtureSecret);
    expect(result.result).not.toContain('企业不存在');
    expect(getCase(item.orgId,item.id,userId)!.materials).toHaveLength(0);
    expect(result.result).toContain('未归档');
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps failed MCP queries distinct from an empty company list at the connector boundary',async () => {
    vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(Error('HTTP 403 '+fixtureSecret));
    await expect(searchCompanySources('虚构主体',['qichacha'])).rejects.toThrow('[QCC_AUTHORIZATION]');
  });
  it('does not fall back to a separately priced legacy product when MCP fails',async () => {
    vi.stubEnv('QICHACHA_APP_KEY','legacy-fixture');vi.stubEnv('QICHACHA_SECRET_KEY','legacy-secret');
    vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(Error('HTTP 401'));
    const result=await run();
    expect(result.receipt).toMatchObject({ok:false,status:'partial'});
    expect(fetch).not.toHaveBeenCalled();
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });
  it('retains another selected provider result and reports the failed source as partial',async () => {
    vi.stubEnv('TIANYANCHA_API_KEY','fixture-tyc');
    vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(Error('HTTP 401'));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({error_code:0,result:{name:'另一虚构来源企业',creditCode:'SECOND-SOURCE'}}),{status:200}));
    const result=await run({name:'双源-'+Date.now(),sourceIds:['qichacha','tianyancha']});
    expect(result.result).toContain('SECOND-SOURCE');expect(result.result).toContain('[QCC_AUTHORIZATION]');
    expect(result.receipt).toMatchObject({ok:false,status:'partial'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('executes one expressly selected risk query without an additional registration query',async () => {
    const raw=JSON.stringify({企业名称:'虚构单密钥企业',风险提示:[{说明:'虚构原始风险记录'}]});
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(raw);
    const result=await run({queryType:'risk'});
    expect(result.receipt).toMatchObject({ok:true,status:'observed'});expect(result.result).toContain(raw);
    expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-risk','get_company_risk_scan',{searchKey:'虚构单密钥企业'},expect.any(Object));
  });
  it('keeps an explicitly selected risk failure partial and readable',async () => {
    vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(Error('HTTP 403 '+fixtureSecret));
    const result=await run({queryType:'risk'});
    expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.result).toContain('[QCC_AUTHORIZATION]');expect(result.result).not.toContain(fixtureSecret);
  });
  it('does not convert absent risk fields to zero or incomplete trace work to success',async () => {
    const sources=await searchCompanySources('虚构单密钥企业',['qichacha']);
    expect(sources[0].riskInfo).toEqual({enforcementCount:null,dishonestyCount:null,restrictionsCount:null});
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(company).mockRejectedValueOnce(Error('HTTP 403'));
    const result=await run({},'legal_trace_assets');
    expect(result.result).toContain('SYNTHETIC-QCC-ID');expect(result.result).toContain('未取得该项来源');expect(result.result).toContain('[QCC_AUTHORIZATION]');
    expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(fetch).not.toHaveBeenCalled();
  });
  it('does not mark equity tracing complete when registration contains no shareholder evidence',async () => {
    const result=await run({},'legal_equity_penetration');
    expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.result).toContain('股权穿透尚未完成');
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });
  it('blocks a local-only query before dispatch',async () => {
    await expect(searchCompanySources('虚构主体',['qichacha'],{localOnly:true})).rejects.toThrow('local-only');
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});
