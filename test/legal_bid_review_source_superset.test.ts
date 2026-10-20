import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {beforeAll,afterEach,expect,it,vi} from 'vitest';
import {initDatabase} from '../db_layer';
import {ToolRegistry} from '../server/tools/registry';
import {registerLegalTools} from '../server/tools/definitions/legal_tools';
import {decodeToolResult} from '../server/tools/result_envelope';
import {getDataDirectory} from '../server/config/data_path';
import {upsertUserPreferredLLM} from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import {bidPromptSources,sdkCompletion} from './legal_bid_fixture';
import {resetCircuit} from '../server/cloud/circuit_breaker';
const fixture=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_bid_six_materials_164.json',import.meta.url)),'utf8'));
const body='本项为来源范围内的拟议响应；投标人计划、原件及评分前提尚待责任人逐项核验，不补造证照、签章或正式提交。';
const revised='拟议状态：材料缺失；拟投入团队为虚构林样0.5人年、虚构周样1人年、虚构何样0.5人年。证书及劳动关系证明未提供，偏差性质及评分仍待责任人核验，不视为资格通过。';
type Mode='add'|'same'|'reorder'|'remove'|'unknown'|'section'|'own'|'duplicate';
beforeAll(()=>initDatabase());afterEach(()=>{vi.restoreAllMocks();resetCircuit();});
async function setup(mode:Mode){
 const userId='bid-review-superset-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
 const c=cases.createCase(orgId,userId,{title:'Synthetic source-binding review'});
 upsertUserPreferredLLM(userId,{provider:'relay',model:'synthetic-bid-superset',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});
 const dir=getDataDirectory('binding-'+userId), originals:string[]=[], files:string[]=[];
 for(const [i,m]of fixture.materials.entries()){const file=path.join(dir,String(i+1).padStart(2,'0')+'.txt');fs.writeFileSync(file,m.content);files.push(file);originals.push(m.content);}
 const previous=new Set(fs.readdirSync(getDataDirectory('legal_document_progress'))),prompts:string[]=[];
 let exactTeamSources:any[]=[];
 const create=vi.fn((request:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user').content);prompts.push(prompt);
  const sources=bidPromptSources(prompt);expect(sources).toHaveLength(164);
  expect(sources.find((s:any)=>s.id==='F76').quote).toContain('E04');expect(sources.find((s:any)=>s.id==='F130').quote).toContain('B05');
  const review=prompt.includes('待核对JSON草稿：');let value:any;
  if(!review){const sections=JSON.parse(prompt.split('\n指定子节：')[1]);value={entries:sections.map((s:any)=>({sectionId:s.id,sourceIds:s.id==='F76'?(mode==='remove'?['F76','F77','F122']:['F76','F77']):sources.some((x:any)=>x.id===s.id)?[s.id]:['F1'],response:body,missing:'原始证照和适用前提待补，不冒充核验通过'}))};}
  else {value=JSON.parse(prompt.split('待核对JSON草稿：')[1]);value.complete=true;value.unresolved=[];const target=value.entries.find((e:any)=>e.sectionId==='F76');
   if(target){expect(target.sourceIds).toEqual(mode==='remove'?['F76','F77','F122']:['F76','F77']);if(mode==='add')target.sourceIds.push('F130');
    if(mode==='reorder')target.sourceIds.reverse();
    if(mode==='remove')target.sourceIds=['F76','F77','F130'];
    if(mode==='unknown')target.sourceIds.push('F999999');
    if(mode==='own')target.sourceIds=['F77','F130'];
    if(mode==='section')target.sectionId='business-response';
    if(mode==='duplicate')value.entries[1].sectionId='F76';
    target.response=revised;exactTeamSources=sources.filter((s:any)=>target.sourceIds.includes(s.id));}}
  return sdkCompletion(request,{choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
 });
 const registry=new ToolRegistry();registerLegalTools(registry);
 const context:any={userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',requestId:crypto.randomUUID(),llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const result=decodeToolResult(await registry.execute('legal_generate_bid',{caseId:c.id,projectName:'Synthetic-'+c.id,filePaths:files,maxChars:60000,persistCase:true},context));
 const documents=fs.readdirSync(getDataDirectory('legal_document_progress')).filter(f=>!previous.has(f)).flatMap(f=>Object.values(JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'),f),'utf8')).documents)) as any[];
 for(let i=0;i<files.length;i++)expect(fs.readFileSync(files[i],'utf8')).toBe(originals[i]);expect(create).toHaveBeenCalledTimes(14);expect(prompts.filter(p=>p.includes('待核对JSON草稿：'))).toHaveLength(7);
 return{result,documents,prompts,create,c,orgId,userId,exactTeamSources};
}
it('actual registered bid review can add omitted registered F130 while retaining F76/F77 and compile original provenance',async()=>{
 const f=await setup('add');expect(f.result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.result.content).toContain('56/56 项');
 const doc=f.documents.find(d=>JSON.parse(d.markdown).entries.some((e:any)=>e.sectionId==='F76'));expect(doc.reviewed).toBe(true);
 const entry=JSON.parse(doc.markdown).entries.find((e:any)=>e.sectionId==='F76');expect(entry.sourceIds).toEqual(['F76','F77','F130']);expect(entry.response).toBe(revised);
 expect(f.exactTeamSources.map(s=>s.id)).toEqual(['F76','F77','F130']);expect(f.result.content).toContain(f.exactTeamSources.find(s=>s.id==='F130').quote);
 expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);
 expect(f.prompts.some(p=>p.includes('sourceIds只选正文实际采用的已登记相关原文，必须含本项实际原文ID'))).toBe(true);expect(f.prompts.some(p=>p.includes('在response直接填明本项状态'))).toBe(true);
});
it.each(['same','reorder'] as const)('preserves existing review behavior for %s source bindings',async mode=>{
 const f=await setup(mode);expect(f.result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.result.content).toContain('56/56 项');
 const doc=f.documents.find(d=>JSON.parse(d.markdown).entries.some((e:any)=>e.sectionId==='F76'));expect(doc.reviewed).toBe(true);expect(new Set(JSON.parse(doc.markdown).entries.find((e:any)=>e.sectionId==='F76').sourceIds)).toEqual(new Set(['F76','F77']));
});
it.each(['unknown','section','own','duplicate'] as const)('rejects %s changes as partial with no automatic case material and no extra SDK attempt',async mode=>{
 const f=await setup(mode);expect(f.result.receipt).toMatchObject({ok:false,status:'partial'});expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 for(const d of f.documents){const value=JSON.parse(d.markdown);if(value.entries.some((e:any)=>e.sectionId==='F76'))expect(d.reviewed).not.toBe(true);expect(d.markdown).not.toContain('F999999');}
 expect(f.create).toHaveBeenCalledTimes(14);
});

it('corrects an unrelated registered training citation to actual team evidence while preserving the requirement self and complete source context',async()=>{
 const f=await setup('remove');expect(f.result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.result.content).toContain('56/56 项');
 const doc=f.documents.find(d=>JSON.parse(d.markdown).entries.some((e:any)=>e.sectionId==='F76'));expect(doc.reviewed).toBe(true);
 const entry=JSON.parse(doc.markdown).entries.find((e:any)=>e.sectionId==='F76');expect(entry.sourceIds).toEqual(['F76','F77','F130']);expect(entry.sourceIds).not.toContain('F122');expect(entry.response).toBe(revised);
 expect(f.exactTeamSources.find(s=>s.id==='F130')?.quote).toContain('B05');expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);expect(f.create).toHaveBeenCalledTimes(14);
});
