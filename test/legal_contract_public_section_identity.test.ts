import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { CONTRACT_DRAFT_SECTIONS } from '../server/regions/packs/cn/legal_work_product_quality';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import { sdkCompletionFixture } from './legal_contract_fixture';
const expected=['主体与角色','合同目的与范围','双方权利义务','履行与期限','对价与费用适用性','责任、终止与争议处理','签署、生效与待确认事项'];
const original='仅用于程序验收。虚构甲公司与虚构乙公司双向无偿保密，期限签署后两年；具体日期和代表待确认，不增设付款或担保义务。';
const owner='synthetic-public-section-owner',workspace=cases.legalWorkspaceNamespace(owner),registry=new ToolRegistry();
let app: Awaited<ReturnType<typeof makeApp>>, transform=(x:any)=>x, lastPrompt='';
const create=vi.fn(async(params:any)=>{
 lastPrompt=String(params.messages.find((m:any)=>m.role==='user')?.content);
 const sections=JSON.parse(lastPrompt.match(/^指定栏目：(.+)$/m)![1]);
 const data=JSON.parse(lastPrompt.match(/^原始材料：(.+)$/m)![1]);
 const payload={complete:true,entries:sections.map((section:any)=>({sectionId:section.id,sourceIds:[data.find((s:any)=>s.materialId==='contract-details').id],response:'本栏拟议条款遵循双方无偿保密要求；具体签署安排见《'+sections.at(-1).id+'》栏目，日期与代表仍待双方确认。',missing:''}))};
 return sdkCompletionFixture(JSON.stringify(transform(payload)),'stop',params.stream);
});
beforeAll(async()=>{app=await makeApp();registerLegalTools(registry);upsertUserPreferredLLM(owner,{provider:'relay',model:'synthetic-public-section',selectionMode:'pinned',allowCloudFallback:false});});
afterAll(()=>app.cleanup());beforeEach(()=>{create.mockClear();transform=x=>x;lastPrompt='';});
async function run(){const item=cases.createCase(workspace,owner,{title:'虚构栏目验收-'+crypto.randomUUID()});const before=JSON.stringify(cases.getCase(workspace,item.id,owner));const result=decodeToolResult(await registry.execute('legal_draft_contract',{caseId:item.id,type:'双向保密协议',details:original,persistCase:false},{userId:owner,domain:'personal',authenticated:true,authRole:'user',source:'legal-direct-tool',localExecution:true,executionBoundary:'trusted_local',requestId:crypto.randomUUID(),llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}}));expect(JSON.stringify(cases.getCase(workspace,item.id,owner))).toBe(before);expect(create).toHaveBeenCalledTimes(1);return result;}
it('gives the model only the seven existing public headings as section identity, no alternate execution vocabulary',()=>{expect(CONTRACT_DRAFT_SECTIONS).toEqual(expected.map(title=>({id:title,title})));expect(new Set(CONTRACT_DRAFT_SECTIONS.map(x=>x.id)).size).toBe(7);});
it('renders a generated cross-reference to the exact visible heading without an internal English alias',async()=>{const result=await run();expect(result.receipt).toMatchObject({ok:true,status:'generated',persisted:false});for(const heading of expected)expect(result.content).toContain('## '+heading);expect(result.content).toContain('见《签署、生效与待确认事项》栏目');expect(result.content).not.toContain('《execution》');expect(lastPrompt).not.toContain('重复位置引用同一条款');expect(JSON.parse(lastPrompt.match(/^原始材料：(.+)$/m)![1]).find((s:any)=>s.materialId==='contract-details').quote).toBe(original);});
it('rejects obsolete internal section IDs rather than silently translating unaccepted model output',async()=>{transform=x=>({...x,entries:x.entries.map((e:any,i:number)=>i===6?{...e,sectionId:'execution'}:e)});const result=await run();expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});});
it.each(['foreign-source','missing-section','empty-body','incomplete'])('retains strict %s completion and source boundaries',async kind=>{transform=x=>kind==='incomplete'?{...x,complete:false}:({...x,entries:kind==='missing-section'?x.entries.slice(1):x.entries.map((e:any)=>kind==='foreign-source'?{...e,sourceIds:['F404']}:{...e,response:''})});const result=await run();expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});});
