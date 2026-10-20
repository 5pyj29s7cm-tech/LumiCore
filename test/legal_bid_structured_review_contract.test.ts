import { bidPromptSources } from './legal_bid_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { makeApp } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();}); afterAll(()=>app.cleanup());
const original='R14：总报价不包括新设备，设备清单未提供。RAW-SOURCE-2671\nR15：启动后5个工作日完成清点，资料量待确认。';
const initial='起草拟议正文，身份、期限与证明仍须核对，不能当作已经核准的真实投标承诺。';
const revised='拟议修订：保持原文R14、R15及5个工作日；“引号”、"双引号"、反斜杠\\和\n实际换行保留。付款及未知设备数量仍待确认。';
async function setup(mode:'entries'|'empty'|'old-lines'='entries') {
 const userId='bid-schema-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
 upsertUserPreferredLLM(userId,{provider:'relay',model:'synthetic-bid-schema',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});
 const c=cases.createCase(orgId,userId,{title:'Synthetic JSON review '+userId}); const existing=new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
 const plan={mode}; const events:Array<{review:boolean;chapter:string;prompt:string}>=[];
 const create=vi.fn(async(params:any)=>{
  const prompt=String(params.messages.find((m:any)=>m.role==='user').content), old=prompt.includes('待核对文书：\n'),review=old||prompt.includes('待核对JSON草稿：');
  let draft:any;
  if(review) draft=old?JSON.parse(JSON.parse(prompt.split('待核对文书：\n')[1]).map((line:any)=>line.text).join('\n')):JSON.parse(prompt.split('待核对JSON草稿：')[1]);
  else {const sources=bidPromptSources(prompt),sections=JSON.parse(prompt.split('\n指定子节：')[1]);draft={entries:sections.map((s:any)=>({sectionId:s.id,sourceIds:sources.some((source:any)=>source.id===s.id)?[s.id]:sources.map((source:any)=>source.id),response:initial,missing:'原始证明和数量待核验'}))};}
  const chapter=draft.entries[0].sectionId==='bid-letter'?'business':draft.entries[0].sectionId==='technical-plan'?'technical':'response';
  events.push({review,chapter,prompt}); let content;
  if(!review) content=JSON.stringify(draft);
  else if(plan.mode==='old-lines') content=JSON.stringify({complete:true,corrections:[],unresolved:[]});
  else {for(const e of draft.entries)e.response=revised; if(plan.mode==='empty'&&chapter==='business')draft.entries[0].response=''; content=JSON.stringify({...draft,complete:true,unresolved:[]});}
  return sdkCompletion(params,{choices:[{message:{content},finish_reason:'stop'}]});
 });
 const registry=new ToolRegistry();registerLegalTools(registry); const context:import('../server/tools/types').ToolContext={userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const run=()=>registry.execute('legal_generate_bid',{caseId:c.id,projectName:'Schema-'+c.id,requirements:original,persistCase:true},{...context,requestId:crypto.randomUUID()}).then(decodeToolResult);
 const cache=()=>fs.readdirSync(getDataDirectory('legal_document_progress')).filter(f=>!existing.has(f)).map(f=>JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'),f),'utf8')))[0];
 return{run,events,create,plan,cache,orgId,c};
}
it('uses the same source-bound JSON schema for draft and review through actual registered SSE SDK calls',async()=>{
 const f=await setup();const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(6);
 expect(result.content).toContain(revised);expect(result.content).not.toContain(initial);expect(result.content).toContain(original);
 for(const e of f.events.filter(e=>e.review)){expect(e.prompt).not.toContain('paragraphId');expect(e.prompt).not.toContain('corrections');expect(e.prompt.split('RAW-SOURCE-2671')).toHaveLength(2);expect(e.prompt).toContain('sourceIds不是原文条款号');}
 for(const doc of Object.values(f.cache().documents) as any[])expect(doc.reviewed).toBe(true);
});
it('keeps an empty reviewed response pending and resumes only that review while reusing the other reviewed chapters',async()=>{
 const f=await setup('empty');const first=await f.run();expect(first.receipt).toMatchObject({ok:false,status:'partial'});expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 expect(f.cache().documents.business.reviewed).toBe(false);expect(f.cache().documents.technical.reviewed).toBe(true);expect(f.cache().documents.response.reviewed).toBe(true);
 const n=f.events.length;f.plan.mode='entries';expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});expect(f.events.slice(n).map(e=>[e.review,e.chapter])).toEqual([[true,'business']]);
});
it('refuses a complete:true old P-line result without reviewed entries instead of falsely archiving it',async()=>{
 const f=await setup('old-lines');const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);expect(f.create).toHaveBeenCalledTimes(6);
 for(const doc of Object.values(f.cache().documents) as any[])expect(doc.reviewed).toBe(false);
});
