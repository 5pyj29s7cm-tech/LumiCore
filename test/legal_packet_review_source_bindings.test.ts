import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import * as cases from '../server/org/legal_cases';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { sdkCompletion } from './legal_bid_fixture';
const fixture=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_packet_review_sources.json',import.meta.url)),'utf8'));
beforeAll(initDatabase);
type Mode='corrected'|'legacy'|'missing'|'foreign'|'empty'|'null'|'catalog-foreign'|'forged-quote';
async function run(mode:Mode='corrected'){
 const userId='review-sources-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
 const c=cases.createCase(orgId,userId,{title:'Synthetic source correction '+crypto.randomUUID(),party:fixture.args.parties,clientRole:'plaintiff',objective:fixture.args.claims});
 for(const m of [...fixture.materials].reverse())cases.addMaterial(orgId,userId,c.id,m);
 const before=JSON.stringify(cases.getCase(orgId,c.id)!.materials),outputDir=getDataDirectory(path.join('packet-source-review',c.id));
 upsertUserPreferredLLM(userId,{provider:'relay',model:'synthetic-source-review',selectionMode:'pinned'});
 const events:Array<{phase:string;baseName:string;prompt:string}>=[];
 const create=vi.fn((request:any,options:any)=>{
  if(options.signal.aborted)throw new Error('Synthetic SDK request was aborted');
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');let payload:any,baseName:string,phase:string;
  if(prompt.includes('## 当前文书\n')){
   const target=JSON.parse(prompt.split('## 当前文书\n')[1]);baseName=target.baseName;phase='draft';
   const rows=JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
   payload={baseName,complete:true,entries:baseName.startsWith('16_')?rows.map((row:any)=>({sectionId:row.sectionId,sourceIds:row.sources.map((s:any)=>s.id),response:'仅拟议本材料证明目的，真实性、日期和关联性待核验，不将待核事实写为存在或不存在。',missing:''})):target.sections.map((s:any)=>({sectionId:s.id,...fixture.draft}))};
  }else{
   const documents=JSON.parse(prompt.split('文书列表：')[1]);baseName=documents[0].baseName.split('/')[0];phase='review';
   payload={documents:documents.map((d:any,index:number)=>{
    const catalog=baseName.startsWith('16_');const out:any={baseName:d.baseName,complete:true,unresolved:[],corrections:catalog?[]:[{paragraphId:'P1',replacement:fixture.syntheticReview.response,reason:'Synthetic correction preserves attribution and unknowns while correcting existing source binding.'}]};
    if(!catalog&&mode!=='legacy')out.sourceIds=mode==='missing'?['F99999']:mode==='foreign'?['outside-case:F10']:mode==='empty'?[]:mode==='null'?null:fixture.syntheticReview.sourceIds;
    if(catalog&&mode==='catalog-foreign')out.sourceIds=documents[(index+1)%documents.length].sourceIds||['F99999'];
    if(!catalog&&mode==='forged-quote')out.sources=[{id:'F10',quote:'FORGED-QUOTE-NOT-AUTHORIZED'}];
    return out;
   })};
  }
  events.push({phase,baseName,prompt});
  return sdkCompletion(request,{choices:[{index:0,message:{role:'assistant',content:JSON.stringify(payload)},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}},0,options.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);
 const result=decodeToolResult(await registry.execute('legal_generate_litigation_packet',{...fixture.args,caseId:c.id,caseName:c.title,facts:fixture.materials[0].content,outputDir,includeDocx:false,writeFiles:true,persistCase:false},{userId,domain:'personal',authenticated:true,authRole:'user',source:'legal-direct-tool',localExecution:true,executionBoundary:'trusted_local',requestId:crypto.randomUUID(),llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}}));
 const body=fs.readFileSync(path.join(outputDir,'10_civil-complaint.md'),'utf8');
 const law=body.split('## 法律依据\n')[1]?.split('\n## ')[0]||'';
 return {result,body,law,events,create,before,after:JSON.stringify(cases.getCase(orgId,c.id)!.materials)};
}
describe('packet existing single review can correct the registered source binding',()=>{
 it('uses corrected F10/F14 bindings with the corrected response through the actual packet SDK review path',async()=>{
  expect(crypto.createHash('sha256').update(fixture.historical.row).digest('hex')).toBe(fixture.historical.rowSha256);
  expect(fixture.draft.sourceIds).toContain('F9');expect(fixture.draft.sourceIds).not.toContain('F10');expect(fixture.draft.response).toContain('F9');
  const f=await run();expect(f.result.receipt).toMatchObject({ok:true,status:'generated',persisted:false});
  expect(f.law).toContain('F10；虚构付款回单复印件文字摘录；提供材料正文第2行：文字记载金额20万元；甲方称该笔是本案付款。');
  expect(f.law).toContain('F14；虚构聊天记录文字摘录；提供材料正文第2行：摘录称乙方说“下周安排发货”。');
  expect(f.law).not.toContain('F9；');expect(f.law).not.toContain('F13；');expect(f.law).toContain(fixture.syntheticReview.response);
  expect(f.create).toHaveBeenCalledTimes(4);expect(f.events.filter(e=>e.phase==='review')).toHaveLength(2);expect(f.after).toBe(f.before);
 });
 it('keeps legacy responses without sourceIds on their existing binding without claiming its semantic relevance was proven',async()=>{
  const f=await run('legacy');expect(f.result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.law).toContain('F9；');expect(f.law).toContain('F13；');expect(f.law).toContain('真实性及合同对应关系待核验');expect(f.after).toBe(f.before);expect(f.create).toHaveBeenCalledTimes(4);
 });
 it.each(['missing','foreign','empty','null'] as const)('rejects supplied %s source IDs without archiving or adding a retry',async mode=>{
  const f=await run(mode);expect(f.result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.law).not.toContain(fixture.syntheticReview.response);expect(f.after).toBe(f.before);expect(f.create).toHaveBeenCalledTimes(4);
 });
 it('restricts an evidence catalog correction to the original source row',async()=>{
  const f=await run('catalog-foreign');expect(f.result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.after).toBe(f.before);expect(f.create).toHaveBeenCalledTimes(4);
 });
 it('compiles original quotes from current authorized sources, ignoring any supplied quote text',async()=>{
  const f=await run('forged-quote');expect(f.result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.law).toContain('文字记载金额20万元；甲方称该笔是本案付款。');expect(f.body).not.toContain('FORGED-QUOTE-NOT-AUTHORIZED');expect(f.after).toBe(f.before);
 });
});
