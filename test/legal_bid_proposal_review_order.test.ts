import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initDatabase, closeDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { buildMaterialSources, resolveSourceDraftEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
import * as quality from '../server/regions/packs/cn/legal_work_product_quality';
import * as documents from '../server/regions/packs/cn/legal_tools/documents';
import * as cases from '../server/org/legal_cases';
import { bidPromptSources, sdkCompletion } from './legal_bid_fixture';
import { hypotheticalCurrentMoneyReview, hypotheticalCurrentMoneyResponse, assertHypotheticalMoneyPublicProof } from './legal_bid_current_money_review_fixture';
import originals from './fixtures/legal_bid_six_materials_164.json';
import capturedDraft from './fixtures/legal_bid_unregistered_source_draft.json';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sources = buildMaterialSources(originals.materials);
const unitIds = capturedDraft.entries.map(entry => entry.sectionId);
const codes = [['R',25],['C',3],['E',6],['D',5]].flatMap(([prefix,count]) => Array.from({length:Number(count)},(_,i)=>String(prefix)+(i+1).toString().padStart(2,'0')));
const statusTable = ['| 编号 | 状态 | 待核事项 |','| --- | --- | --- |',...codes.map(code=>'| '+code+' | 拟响应待确认 | 原件及适用前提待责任人核验 |')].join('\n');
const deviationTable = ['| 原要求 | 投标人响应及偏差 | 待补前提 |','| --- | --- | --- |','| 资格及原件 | 未提供，不认定符合或不符合 | 证书原件待补 |','| 真实平台 | 未配置，提交条件待确认 | 平台及账号待确认 |','| 详细地址 | 未给，不能承诺具体进场 | 地址待确认 |','| 资料量 | 未确认，不承诺无限量 | 数量待确认 |','| 报价证明 | 待补，不认定报价已核 | 成本依据待补 |'].join('\n');
let network: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { await initDatabase(); });
beforeEach(() => { network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('OFFLINE_BID_CANDIDATE')); });
afterAll(async () => { await closeDatabase(); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks(); });
type Mode = 'correct'|'keep-unknown'|'drop-valid'|'change-section'|'change-fact-source'|'reject'|'bad-json'|'cancel'|'missing-body'|'tables';
async function setup(mode:Mode='correct', badDraft?:'duplicate'|'missing-body'|'non-string-source') {
  const userId='bid-unaccepted-'+crypto.randomUUID(), orgId=cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});
  const c=cases.createCase(orgId,userId,{title:'Synthetic unaccepted bid proposal',factDate:'2026-09-01'});
  const initialFiles=new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
  vi.spyOn(documents,'readBidRequirementInput').mockResolvedValue({requirements:originals.materials.map(m=>'# '+m.title+'\n'+m.content).join('\n\n'),sources:originals.materials.map(m=>m.title),materials:clone(originals.materials),skipped:[]});
  const originalBuild=quality.buildBidChapters;
  vi.spyOn(quality,'buildBidChapters').mockImplementation(input=>{
    const response=originalBuild(input).find(chapter=>chapter.id==='response')!;
    return [{...response,sections:response.sections.filter(section=>(mode==='tables'?['F39','F101']:unitIds).includes(section.id))}];
  });
  const controller=new AbortController(), plan={mode}, events:Array<{review:boolean;draft:any}> = [];
  const create=vi.fn(async (request:any, options:any)=>{
    const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');
    expect(bidPromptSources(prompt)).toEqual(sources); expect(sources).toHaveLength(164);
    expect(request).toMatchObject({max_tokens:16384,reasoning_effort:'low',stream:true,response_format:{type:'json_object'}});
    const review=prompt.includes('待核对JSON草稿：'); let value:any;
    if(!review) {
      value=plan.mode==='tables'?{entries:JSON.parse(prompt.split('\n指定子节：')[1]).map((section:any)=>({sectionId:section.id,sourceIds:section.id==='F39'?['F39','F40']:['F101','F102'],response:'本节仅承诺另行填写所要求的表格和矩阵，草稿暂未给出实际逐行内容。',missing:'原文要求的表格和逐编号状态尚待补齐'}))}:clone(capturedDraft);
      if(plan.mode==='drop-valid')value.entries[5].sourceIds.push('F122');
      if(badDraft==='duplicate')value.entries[1].sectionId=value.entries[0].sectionId;
      if(badDraft==='missing-body')delete value.entries[0].response;
      if(badDraft==='non-string-source')value.entries[0].sourceIds.push(7);
    } else {
      const proposal=JSON.parse(prompt.split('待核对JSON草稿：')[1]);
      if(plan.mode!=='tables') { expect(proposal.entries[5].sourceIds).toContain('B10'); expect(proposal.entries[6].sourceIds).toContain('P04'); }
      events.push({review,draft:clone(proposal)});
      if(plan.mode==='cancel')controller.abort(new Error('cancel unaccepted review'));
      if(plan.mode==='bad-json')return sdkCompletion(request,{choices:[{message:{content:'{not JSON'},finish_reason:'stop'}]},0,options.signal);
      // This SDK mock is a new hypothetical review, never an edit to the captured actual result.
      value={complete:plan.mode!=='reject',unresolved:[],entries:proposal.entries.map((entry:any)=>({...entry,sourceIds:entry.sourceIds.filter((id:string)=>id!=='B10'&&id!=='P04')}))};
      value.entries=hypotheticalCurrentMoneyReview(value.entries,'proposal');
      if(plan.mode==='keep-unknown')value.entries=clone(proposal.entries);
      if(plan.mode==='correct') { value.entries[5].sourceIds.push('F135'); value.entries[6].sourceIds.push('F142'); }
      if(plan.mode==='drop-valid')value.entries[5].sourceIds=value.entries[5].sourceIds.filter((id:string)=>id!=='F122');
      if(plan.mode==='change-fact-source')value.entries[5].sourceIds=value.entries[5].sourceIds.filter((id:string)=>id!=='F54').concat('F135');
      if(plan.mode==='change-section')value.entries[5].sectionId=value.entries[4].sectionId;
      if(plan.mode==='missing-body')delete value.entries[0].response;
      if(plan.mode==='tables') { value.entries[0].response=deviationTable; value.entries[1].response=statusTable; value.entries.forEach((entry:any)=>entry.missing='原件及适用前提待核，未作资格或评分认定'); }
    }
    if(!review)events.push({review,draft:clone(value)});
    return sdkCompletion(request,{choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]},0,options.signal);
  });
  const registry=new ToolRegistry(); registerLegalTools(registry);
  const context={userId,domain:'personal' as const,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local' as const,executionSignal:controller.signal,llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
  const args={caseId:c.id,projectName:'Synthetic bid '+c.id,requirements:'Use frozen parsed fictional six materials',persistCase:true};
  const run=()=>registry.execute('legal_generate_bid',args,{...context,requestId:crypto.randomUUID()}).then(decodeToolResult);
  const checkpoint=()=>fs.readdirSync(getDataDirectory('legal_document_progress')).filter(name=>!initialFiles.has(name)).map(name=>JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'),name),'utf8'))).find(value=>value.documents.response)?.documents.response;
  const archived=()=>cases.getCase(orgId,c.id)!.materials.filter(m=>m.source==='tool');
  return {run,plan,events,create,checkpoint,archived};
}
describe('only unaccepted bid proposals defer registered-ID validation until the existing review',()=>{
  it('defaults to strict final resolution and never constructs a Source for B10/P04',()=>{
    const response=quality.buildBidChapters(sources).find(chapter=>chapter.id==='response')!;
    const chapter={...response,sections:response.sections.filter(section=>unitIds.includes(section.id))};
    expect(()=>quality.resolveBidChapter(capturedDraft,sources,chapter)).toThrow(/未登记/);
    const proposed=quality.resolveBidChapter(capturedDraft,sources,chapter,true);
    expect(proposed[5].sourceIds).toEqual(capturedDraft.entries[5].sourceIds);
    expect(proposed[6].sourceIds).toEqual(capturedDraft.entries[6].sourceIds);
    for(const entry of proposed)for(const source of entry.sources)expect(sources).toContain(source);
    expect(proposed.flatMap(entry=>entry.sources).some(source=>['B10','P04'].includes(source.id))).toBe(false);
    expect(()=>resolveSourceDraftEntries(capturedDraft,sources,unitIds)).toThrow(/未登记/);
  });
  it('routes the captured 12-entry draft through exactly one original review with all 164 originals and strict accepted bindings',async()=>{
    const f=await setup(); const result=await f.run();
    expect(result.receipt).toMatchObject({ok:true,status:'generated'}); expect(f.create).toHaveBeenCalledTimes(2); expect(f.events.map(event=>event.review)).toEqual([false,true]);
    const saved=f.checkpoint(); expect(saved.reviewed).toBe(true);
    const accepted=JSON.parse(saved.markdown).entries; expect(accepted).toHaveLength(12);
    expect(accepted[5].sourceIds).toContain('F135'); expect(accepted[6].sourceIds).toContain('F142');
    expect(accepted.flatMap((entry:any)=>entry.sourceIds).some((id:string)=>['B10','P04'].includes(id))).toBe(false);
    for(const [i,entry] of capturedDraft.entries.entries())for(const id of entry.sourceIds.filter(id=>sources.some(source=>source.id===id)))expect(accepted[i].sourceIds).toContain(id);
    expect(f.archived()).toHaveLength(1);assertHypotheticalMoneyPublicProof(result.content,'proposal');
  });
  it('keeps continued unknown IDs unaccepted, uncompiled and unarchived after the same two calls',async()=>{
    const f=await setup('keep-unknown');const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.checkpoint().reviewed).toBe(false);expect(JSON.parse(f.checkpoint().markdown).entries[5].sourceIds).toContain('B10');
    expect(result.content).not.toContain(capturedDraft.entries[5].response); expect(f.archived()).toHaveLength(0);
  });
  it.each(['drop-valid','change-fact-source'] as const)('allows corrected auxiliary source selection %s with strict registered/self final entries and no extra model stage',async mode=>{
    const f=await setup(mode);const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(2);expect(f.events.map(event=>event.review)).toEqual([false,true]);
    const saved=f.checkpoint();expect(saved.reviewed).toBe(true);const accepted=JSON.parse(saved.markdown).entries;
    for(const entry of accepted){expect(entry.sourceIds).toContain(entry.sectionId);expect(entry.sourceIds.every((id:string)=>sources.some(source=>source.id===id))).toBe(true);expect(entry.sourceIds.some((id:string)=>['B10','P04'].includes(id))).toBe(false);}
    expect(accepted[5].response).toBe(capturedDraft.entries[5].response);expect(accepted[6].response).toBe(hypotheticalCurrentMoneyResponse('proposal','F122'));
    if(mode==='drop-valid'){expect(f.events.find(event=>!event.review)!.draft.entries[5].sourceIds).toContain('F122');expect(accepted[5].sourceIds).not.toContain('F122');expect(accepted[6].sourceIds).toContain('F142');}
    else{expect(accepted[5].sourceIds).toContain('F135');expect(accepted[5].sourceIds).not.toContain('F54');}
    expect(f.archived()).toHaveLength(1);assertHypotheticalMoneyPublicProof(result.content,'proposal');
  });
  it.each(['change-section','reject'] as const)('rejects %s without a third model call or success/cache promotion',async mode=>{
    const f=await setup(mode);expect((await f.run()).receipt).toMatchObject({ok:false,status:'partial'});expect(f.create).toHaveBeenCalledTimes(2);expect(f.archived()).toHaveLength(0);
    if(mode==='reject')expect(f.checkpoint()).toBeUndefined();else{expect(f.checkpoint().reviewed).toBe(false);expect(JSON.parse(f.checkpoint().markdown).entries[5].sourceIds).toContain('B10');}
  });
  it('preserves raw pending IDs after malformed review and resumes only that review; a fully reviewed unit uses zero further SDK calls',async()=>{
    const f=await setup('bad-json');expect((await f.run()).receipt).toMatchObject({ok:false,status:'partial'});expect(f.create).toHaveBeenCalledTimes(2);expect(f.checkpoint().reviewed).toBe(false);
    expect(JSON.parse(f.checkpoint().markdown).entries[6].sourceIds).toContain('P04');expect(f.archived()).toHaveLength(0);
    f.plan.mode='correct';const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});assertHypotheticalMoneyPublicProof(result.content,'proposal');expect(f.create).toHaveBeenCalledTimes(3);expect(f.events.map(event=>event.review)).toEqual([false,true,true]);
    expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(3);
  });
  it('does not promote a corrected review with a missing actual body',async()=>{
    const f=await setup('missing-body');expect((await f.run()).receipt).toMatchObject({ok:false,status:'partial'});expect(f.create).toHaveBeenCalledTimes(2);expect(f.checkpoint().reviewed).toBe(false);expect(f.archived()).toHaveLength(0);
  });
  it.each(['duplicate','missing-body','non-string-source'] as const)('still blocks malformed draft %s before review',async shape=>{
    const f=await setup('correct',shape);expect((await f.run()).receipt).toMatchObject({ok:false,status:'partial'});expect(f.create).toHaveBeenCalledTimes(1);expect(f.checkpoint()).toBeUndefined();expect(f.archived()).toHaveLength(0);
  });
  it('honors parent cancellation during the original review and leaves an unaccepted pending checkpoint',async()=>{
    const f=await setup('cancel');await expect(f.run()).rejects.toThrow(/cancel unaccepted review/);expect(f.create).toHaveBeenCalledTimes(2);expect(f.checkpoint().reviewed).toBe(false);expect(f.archived()).toHaveLength(0);
  });
  it('transports an actual deviation table and every one of 39 matrix codes in response, rather than replacing them with the internal coverage table',async()=>{
    const f=await setup('tables');const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(2);
    expect(result.content).toContain(deviationTable);expect(result.content).toContain(statusTable);expect(result.content.indexOf(statusTable)).toBeLessThan(result.content.indexOf('## 已识别编号条目响应覆盖与补料工作表'));
    expect(codes).toHaveLength(39);for(const code of codes)expect(statusTable.split('\n').filter(line=>line.startsWith('| '+code+' |'))).toHaveLength(1);
    const file=result.content.split('\n').find(line=>line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);const parsed=await documents.parseLegalDocument(file,{});expect(parsed?.text).toContain('真实平台');for(const code of codes)expect(parsed?.text).toContain(code);
    for(const entry of JSON.parse(f.checkpoint().markdown).entries)expect(entry.sourceIds.every((id:string)=>sources.some(source=>source.id===id))).toBe(true);
    const prompts=f.create.mock.calls.map(([request]:any[])=>String(request.messages.find((m:any)=>m.role==='user').content));expect(prompts[1]).not.toContain('正确部分保留、不扩写');expect(prompts[1]).toContain('补齐原文明确要求');expect(prompts.every(prompt=>prompt.includes('完整Markdown表'))).toBe(true);
  });
});
