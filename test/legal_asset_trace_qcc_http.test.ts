import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { toolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { mcpManager } from '../server/mcp/client';
import * as Cases from '../server/org/legal_cases';
import { searchEnforcementRecords } from '../server/legal/sources';
const nativeFetch=globalThis.fetch;
const name='虚构财产快查主体有限公司', userId='synthetic-asset-http-owner';
const company=JSON.stringify({企业名称:name,统一社会信用代码:'SYNTHETIC-ASSET-QCC',登记状态:'存续',成立日期:'2020-01-02',注册资本:'10万元'});
const enforcement=JSON.stringify({主体名称:name,被执行信息:[{案号:'SYNTHETIC-CASE-001',执行法院:'虚构法院',执行标的:'10万元'}]});
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const businessContent=({workflowRuns:_runs,updatedAt:_time,updatedBy:_actor,...content}:any)=>JSON.stringify(content);
let app:Awaited<ReturnType<typeof makeApp>>;
const token=jwt.sign({uid:userId,username:userId,role:'user'},JWT_SECRET);
beforeAll(async()=>{app=await makeApp();const nil=()=>null;mountChatRoutes(app.apiRouter,JWT_SECRET,{getDeepSeek:nil,getGemini:nil,getOpenAI:nil,getAnthropic:nil,getQwen:nil});registerLegalTools(toolRegistry);});
afterAll(()=>app.cleanup());
beforeEach(()=>{
 for(const key of ['QICHACHA_API_KEY','QICHACHA_APP_KEY','QICHACHA_SECRET_KEY','TIANYANCHA_API_KEY','QIXINBAO_API_KEY'])vi.stubEnv(key,'');
 vi.stubEnv('QICHACHA_API_KEY','synthetic-authorized-risk-key');
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('External HTTP forbidden in offline fixture');}));
 vi.spyOn(mcpManager,'callToolForServer').mockImplementation(async(_server,tool)=>tool==='get_company_registration_info'?company:enforcement);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
async function page(args:Record<string,unknown>={}){const response=await nativeFetch(app.url+'/api/legal/tool/legal_trace_assets',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({args:{name,persistCase:false,confirmedForKb:false,...args}})});expect(response.status).toBe(200);return response.json();}
describe('property quick scan uses the actual authorized source through the page API',()=>{
 it('returns both original sources with exact origin, tool, time and SHA without inventing enforcement fields or archiving',async()=>{
  const data=await page();expect(data.receipt).toMatchObject({ok:true,status:'observed',persisted:false,changedCaseIds:[],artifacts:[],sourceResults:[
   {subject:name,queryType:'registration',sourceTool:'get_company_registration_info',sourceEndpoint:'https://agent.qcc.com/mcp/company/stream',sourceTextSha256:sha(company)},
   {subject:name,queryType:'enforcement',sourceTool:'get_judgment_debtor_info',sourceEndpoint:'https://agent.qcc.com/mcp/risk/stream',sourceTextSha256:sha(enforcement)}]});
  expect(data.verification.status).toBe('verified');expect(data.caseUpdates).toEqual([]);expect(data.text).toContain(company);expect(data.text).toContain(enforcement);expect(data.text).toContain(sha(enforcement));
  expect(data.text).toContain('未取得该项来源');expect(data.text).not.toContain('被执行记录: 0 条');expect(data.text).not.toContain('不存在被执行记录');
  for(const source of data.receipt.sourceResults)expect(Number.isFinite(Date.parse(source.queriedAt))).toBe(true);
  expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(2);expect(vi.mocked(mcpManager.callToolForServer).mock.calls.map(row=>row[1])).toEqual(['get_company_registration_info','get_judgment_debtor_info']);expect(fetch).not.toHaveBeenCalled();
 });
 it.each(['authorization','timeout','empty'] as const)('keeps real registration, reports %s risk failure and leaves original case materials unchanged',async kind=>{
  vi.mocked(mcpManager.callToolForServer).mockImplementation(async(_server,tool)=>{if(tool==='get_company_registration_info')return company;if(kind==='empty')return '[]';throw kind==='authorization'?Error('HTTP 403 synthetic-authorized-risk-key'):Object.assign(Error('synthetic-authorized-risk-key'),{name:'TimeoutError'});});
  const orgId=Cases.legalWorkspaceNamespace(userId),item=Cases.createCase(orgId,userId,{title:'Synthetic risk partial case'}),before=businessContent(Cases.getCase(orgId,item.id,userId));
  const data=await page({caseId:item.id,persistCase:true});expect(data.receipt).toMatchObject({ok:false,status:'partial',persisted:false,changedCaseIds:[],sourceResults:[{queryType:'registration'}]});expect(data.receipt.sourceResults).toHaveLength(1);expect(data.verification.status).not.toBe('verified');
  expect(data.text).toContain('SYNTHETIC-ASSET-QCC');expect(data.text).toContain('[QCC_'+kind.toUpperCase()+']');expect(data.text).not.toContain('synthetic-authorized-risk-key');expect(data.text).not.toContain('被执行记录: 0 条');expect(data.text).not.toContain('不存在被执行记录');const after=Cases.getCase(orgId,item.id,userId)!;expect(businessContent(after)).toBe(before);expect(after.workflowRuns?.[0]).toMatchObject({ok:false,status:'partial',materialIds:[],artifacts:[]});expect(fetch).not.toHaveBeenCalled();
 });
 it('does not query the network with no configured risk authorization',async()=>{vi.stubEnv('QICHACHA_API_KEY','');await expect(searchEnforcementRecords(name)).rejects.toThrow('authorized webpage');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();});
 it('enforces local-only before either existing source dispatch',async()=>{await expect(searchEnforcementRecords(name,{localOnly:true})).rejects.toThrow('local-only');const record=await executeToolCall({registry:toolRegistry,name:'legal_trace_assets',arguments:{name,persistCase:false},context:{userId,authenticated:true,authRole:'user',dataRoutingPolicy:'local_only'} as any});expect(record.error).toContain('local-only');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();});
});
