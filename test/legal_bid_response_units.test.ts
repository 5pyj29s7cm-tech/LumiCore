import { bidPromptSources } from './legal_bid_fixture';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import { sdkCompletion } from './legal_bid_fixture';
import { buildBidChapters, buildGroundedBidDraft, resolveBidChapter } from '../server/regions/packs/cn/legal_work_product_quality';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const body = '本项仅依据绑定原句提出待责任人复核的响应方案，资料、履行条件与承诺仍需确认，不认定已具备资格或完成正式提交。';
async function setup(count = 25) {
  const userId = 'bid-units-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  const source = Array.from({length:count}, (_, i) => 'R' + String(i + 1).padStart(2, '0') + '：虚构服务要求第' + (i + 1) + '项，仅以此原句为准；未提供的条件待核实。SOURCE-UNIT-' + (i + 1)).join('\n');
  const c = cases.createCase(orgId, userId, {title:'Virtual numbered response units'});
  upsertUserPreferredLLM(userId, { provider:'relay', model:'synthetic-unit-model', selectionMode:'pinned', allowCloudFallback:false, fallbackCandidates:[] });
  const existing = new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
  const plan = { pending:'', failing:'', delay:'', delayMs:0 };
  const events: Array<{kind:string;ids:string[];sources:any[]}> = [];
  const create = vi.fn(async (request:any, options:any) => {
    const prompt = String(request.messages.find((m:any)=>m.role==='user')?.content || '');
    const reviewing = prompt.includes('待核对JSON草稿：');
    const sources = bidPromptSources(prompt);
    const draft = reviewing ? JSON.parse(prompt.split('待核对JSON草稿：')[1]) : null;
    const ids = reviewing ? draft.entries.map((e:any)=>e.sectionId) : JSON.parse(prompt.split('\n指定子节：')[1]).map((s:any)=>s.id);
    events.push({ kind:reviewing?'review':'draft', ids, sources });
    if (!reviewing && ids.includes(plan.failing)) throw new Error('synthetic source unit outage');
    const content = reviewing ? ids.includes(plan.pending) ? '{not JSON' : JSON.stringify({complete:true,entries:draft.entries,unresolved:[]}) : JSON.stringify({entries:ids.map((id:string)=>({sectionId:id,sourceIds:sources.some((s:any)=>s.id===id)?[id]:[sources[0].id],response:body,missing:'条件与证明待核实'}))});
    return sdkCompletion(request,{choices:[{message:{content},finish_reason:'stop'}]}, reviewing && ids.includes(plan.delay) ? plan.delayMs : 0, options.signal);
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const args = {caseId:c.id,projectName:'Unit-'+c.id,requirements:source,persistCase:true};
  const context:any = {userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
  const run = (signal?:AbortSignal) => registry.execute('legal_generate_bid',args,{...context,requestId:crypto.randomUUID(),executionSignal:signal}).then(decodeToolResult);
  const checkpoints = () => fs.readdirSync(getDataDirectory('legal_document_progress')).filter(name=>!existing.has(name)).map(name=>({file:path.join(getDataDirectory('legal_document_progress'),name),value:JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'),name),'utf8'))}));
  return {source,c,orgId,plan,events,create,run,checkpoints};
}
describe('registered numbered bid responses share existing bounded workers and checkpoints',()=>{
  it('generates and reviews 56 original numbered responses in units of at most 12, then compiles the same three main chapters',async()=>{
    const f=await setup(56), result=await f.run();
    expect(result.receipt).toMatchObject({ok:true,status:'generated'});
    const draftEvents=f.events.filter(e=>e.kind==='draft');
    expect(draftEvents).toHaveLength(7); expect(f.events.filter(e=>e.kind==='review')).toHaveLength(7);
    for(const event of f.events) expect(event.ids.length).toBeLessThanOrEqual(12);
    const responseIds=draftEvents.flatMap(e=>e.ids.filter(id=>/^F\d+$/.test(id)));
    expect(responseIds).toEqual(Array.from({length:56},(_,i)=>'F'+(i+1)));
    for(const event of draftEvents) expect(event.sources.map(s=>s.quote).join('\n')).toBe(f.source);
    expect(result.content).toContain('已识别编号条目的来源绑定拟议响应：56/56');
    for(const title of ['商务响应与报价','技术方案与实施计划','逐项响应与偏差']) expect(result.content.split('\n## '+title+'\n')).toHaveLength(2);
    const documents=f.checkpoints()[0].value.documents;
    expect(documents.response).toBeUndefined(); expect(Object.keys(documents).filter(key=>key.startsWith('response:'))).toHaveLength(5);
    for(const saved of Object.values(documents) as any[]) expect(saved.reviewed).toBe(true);
  });
  it('renders only reviewed partial response entries and resumes pending review plus a missing unit without redoing accepted units',async()=>{
    const f=await setup(); f.plan.pending='F13'; f.plan.failing='F25';
    const result=await f.run(); expect(result.receipt).toMatchObject({ok:false,status:'partial'});
    expect(result.content).toContain('已识别编号条目的来源绑定拟议响应：12/25');
    expect(result.content).toContain('### R12：'); expect(result.content).not.toContain('### R13：');
    expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
    const saved=f.checkpoints()[0].value.documents;
    expect(saved['response:'+Array.from({length:12},(_,i)=>'F'+(i+1)).join(',')].reviewed).toBe(true);
    expect(saved['response:'+Array.from({length:12},(_,i)=>'F'+(i+13)).join(',')].reviewed).toBe(false);
    const before=f.events.length; f.plan.pending=''; f.plan.failing='';
    expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});
    const resumed=f.events.slice(before); expect(resumed).toHaveLength(3);
    expect(resumed.filter(e=>e.kind==='draft').map(e=>e.ids)).toEqual([['F25']]);
    expect(resumed.filter(e=>e.kind==='review').flatMap(e=>e.ids).sort()).toEqual(Array.from({length:13},(_,i)=>'F'+(i+13)).sort());
  });
  it.each(['whole-reviewed','technical-pending'])('retains exact existing checkpoints (%s) without forcing new draft calls',async mode=>{
    const f=await setup(); await f.run();
    const saved=f.checkpoints()[0], documents=saved.value.documents;
    if(mode==='whole-reviewed') {
      const entries=Object.keys(documents).filter(key=>key.startsWith('response:')).flatMap(key=>JSON.parse(documents[key].markdown).entries);
      expect(entries).toHaveLength(25);
      for(const key of Object.keys(documents).filter(key=>key.startsWith('response:'))) delete documents[key];
      documents.response={markdown:JSON.stringify({entries}),reviewed:true};
    } else documents.technical.reviewed=false;
    fs.writeFileSync(saved.file,JSON.stringify(saved.value));
    const before=f.events.length;
    expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});
    expect(f.events.slice(before).filter(e=>e.kind==='draft')).toHaveLength(0);
    expect(f.events.slice(before).filter(e=>e.kind==='review')).toHaveLength(mode==='whole-reviewed'?0:1);
    if(mode==='technical-pending') expect(f.events.at(-1)!.ids).toEqual(['technical-plan','schedule','delivery-risk']);
  });
  it('keeps a timed-out unit as pending and only reviews it on continuation under the same shared deadline',async()=>{
    const f=await setup(); f.plan.delay='F13'; f.plan.delayMs=185000; vi.useFakeTimers();
    let settled: Awaited<ReturnType<typeof f.run>> | undefined;
    const pending=f.run().then(value => { settled=value; return value; });
    await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='review'&&e.ids.includes('F13'))).toBe(true));
    await vi.advanceTimersByTimeAsync(180001);
    // Keep the clock active until the existing DOCX writer drains its queued work.
    // Resetting fake timers while Packer is pending silently drops that callback.
    await vi.waitFor(()=>expect(settled).toBeDefined());
    vi.useRealTimers(); const result=await pending;
    expect(result.receipt).toMatchObject({ok:false,status:'partial'}); expect(result.content).toContain('已识别编号条目的来源绑定拟议响应：13/25');
    expect(f.checkpoints()[0].value.documents['response:'+Array.from({length:12},(_,i)=>'F'+(i+13)).join(',')].reviewed).toBe(false);
    expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
    vi.useRealTimers(); const before=f.events.length; f.plan.delay='';
    expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});
    expect(f.events.slice(before).map(e=>e.kind)).toEqual(['review']); expect(f.events.at(-1)!.ids).toHaveLength(12);
  });
  it('does not promote canceled unit reviews or archive a canceled task',async()=>{
    const f=await setup(); f.plan.delay='F13'; f.plan.delayMs=70000; vi.useFakeTimers(); const controller=new AbortController();
    const pending=expect(f.run(controller.signal)).rejects.toThrow('cancel virtual bid units');
    await vi.advanceTimersByTimeAsync(2000); expect(f.events.some(e=>e.kind==='review'&&e.ids.includes('F13'))).toBe(true);
    controller.abort(new Error('cancel virtual bid units')); await pending;
    expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
    expect(f.checkpoints()[0].value.documents['response:'+Array.from({length:12},(_,i)=>'F'+(i+13)).join(',')].reviewed).toBe(false);
  });
  it('safely compiles a sparse chapter map without inventing or dereferencing absent entries',()=>{
    const source='R01：唯一第一条原始要求。\nR02：第二条实际要求。', sources=buildMaterialSources([{id:'fixture',title:'source',content:source}]), chapters=buildBidChapters(sources);
    const partial={...chapters[2],sections:[chapters[2].sections[1]]};
    const entries=resolveBidChapter({entries:[{sectionId:'F2',sourceIds:['F2'],response:body,missing:''}]},sources,partial);
    const result=buildGroundedBidDraft('Sparse',source,sources,chapters,new Map([['response',entries]]));
    expect(result).toContain('已识别编号条目的来源绑定拟议响应：1/2'); expect(result).toContain('### R02：'); expect(result).not.toContain('### R01：');
  });
});
