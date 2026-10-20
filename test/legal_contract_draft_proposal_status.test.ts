import './helpers';
import { initDatabase } from '../db_layer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { sdkCompletion } from './legal_bid_fixture';
import { resolveContractWorkProduct, CONTRACT_REVIEW_SECTIONS, CONTRACT_DRAFT_SECTIONS } from '../server/regions/packs/cn/legal_work_product_quality';
const actual=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_contract_draft_proposal_status.json',import.meta.url)),'utf8'));
const notice='本栏以下全部为拟议条款，须双方确认；不得替代另列的原始要求。';
beforeAll(initDatabase);
async function run(payload:any=actual.payload){
 // Re-key only this mock protocol to current IDs; preserved historical payload and bodies remain byte-identical.
 payload={...payload,entries:payload.entries.map((entry:any,index:number)=>({...entry,sectionId:CONTRACT_DRAFT_SECTIONS[index].id}))};
 const userId='nda-presentation-'+crypto.randomUUID();upsertUserPreferredLLM(userId,{provider:'relay',model:'synthetic-nda-presentation',selectionMode:'pinned'});
 const create=vi.fn((request:any,options:any)=>sdkCompletion(request,{choices:[{message:{content:JSON.stringify(payload)},finish_reason:'stop'}]},0,options.signal));
 const registry=new ToolRegistry();registerLegalTools(registry);
 const output=decodeToolResult(await registry.execute('legal_draft_contract',{...actual.args,caseName:'Synthetic NDA proposed '+crypto.randomUUID(),persistCase:false},{userId,domain:'personal',authenticated:true,authRole:'user',source:'legal-direct-tool',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}}));
 return {output,create};
}
describe('draft-only existing section proposal status using actual historical payload',()=>{
 it('marks every original section including the three actually unlabelled clauses, without changing their text or adding model calls',async()=>{
  const f=await run();expect(f.output.receipt).toMatchObject({ok:true,status:'generated',persisted:false});expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.output.content.split(notice)).toHaveLength(8);
  for(const entry of actual.payload.entries){const title=({parties:'主体与角色',scope:'合同目的与范围',obligations:'双方权利义务',performance:'履行与期限',consideration:'对价与费用适用性','liability-dispute':'责任、终止与争议处理',execution:'签署、生效与待确认事项'} as any)[entry.sectionId];expect(f.output.content).toContain('## '+title+'\n\n'+notice+'\n\n'+entry.response);}
  for(const original of ['披露后合理期限内','双方在披露前已知悉且不负保密义务的信息','本合同一式两份，双方各执一份'])expect(f.output.content).toContain(original);
 });
 it('keeps server-owned original requirements separate from proposed wording, not as user-approved model clauses',async()=>{
  const f=await run();expect(f.create).toHaveBeenCalledTimes(1);expect(f.output.content).toContain('## 当事人原始要求（原文）\n\n> '+actual.args.details);
  expect(f.output.content.indexOf('## 当事人原始要求（原文）')).toBeLessThan(f.output.content.indexOf('## 主体与角色'));
  expect(f.output.content).not.toContain('栏目与原始来源结构已校验');expect(f.output.content).toContain('不得替代原始要求');
 });
 it('leaves the existing review output and source checker unchanged',()=>{
  const sources=[{id:'F2',materialId:'contract-details',title:'Synthetic source',quote:actual.args.details,locator:'provided full text'}];
  const payload={complete:true,entries:CONTRACT_REVIEW_SECTIONS.map(section=>({sectionId:section.id,sourceIds:['F2'],response:'Only an unverified review proposal; source conditions and unknown dates require checking.',missing:''}))};
  const review=resolveContractWorkProduct(JSON.stringify(payload),sources,CONTRACT_REVIEW_SECTIONS);expect(review).not.toContain(notice);expect(review).not.toContain('当事人原始要求');
  expect(()=>resolveContractWorkProduct(JSON.stringify({...payload,entries:payload.entries.map(e=>({...e,sourceIds:['F999']}))}),sources,CONTRACT_REVIEW_SECTIONS)).toThrow();
 });
 it.each(['foreign-source','empty-body'])('keeps %s partial rather than counting program labels as body or source proof',async kind=>{
  const payload=structuredClone(actual.payload);if(kind==='foreign-source')payload.entries[0].sourceIds=['F999'];else for(const entry of payload.entries)entry.response='';
  const f=await run(payload);expect(f.create).toHaveBeenCalledTimes(1);expect(f.output.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.output.content).not.toContain(notice);expect(f.output.content).not.toContain('## 当事人原始要求');
 });
});
