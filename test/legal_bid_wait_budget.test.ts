import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { buildBidChapters } from '../server/regions/packs/cn/legal_work_product_quality';
import * as cases from '../server/org/legal_cases';
import { LEGAL_BID_MAX_MODEL_BUDGET_MS, LEGAL_BID_TOOL_TIMEOUT_MS } from '../server/legal/budgets';
import './helpers';
import { bidStructuredReply, bidPromptSources, sdkCompletion } from './legal_bid_fixture';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { getDataDirectory } from '../server/config/data_path';
import { generateBidHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { decodeToolResult } from '../server/tools/result_envelope';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
let app: Awaited<ReturnType<typeof makeApp>>;
const userId = 'bid-sdk-wait-test-owner';
const source = '虚构验收材料：报价254400元，专项资质与履约证据尚未核实。SDK-BID-SOURCE-TAIL';
const promptOf = (params: any) => params.messages.find((message: any) => message.role === 'user')?.content || '';
const bodyOf = (params: any) => '# 本章工作稿\n' + (promptOf(params).includes('本次只输出“商务') ? '商务响应只依虚构输入，含税报价254400元，专项资质原件未提供，主体授权与保证金保持待补核实。' : promptOf(params).includes('本次只输出“技术') ? '技术响应与实施计划限于本项目已提供范围，设备数量、人员证书、场地和验收证据仍待责任人确认。' : '逐项响应、偏差与待补材料明确保留；不宣布资格审查、评分、法律核准或正式投标提交已经通过。');
const completeResponse = (params: any) => ({ choices: [{ message: { role: 'assistant', content: bidStructuredReply(promptOf(params), bodyOf(params)) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const response = (params: any) => sdkCompletion(params, completeResponse(params));
const snapshot = () => { const dir = getDataDirectory('legal_document_progress'); return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')])); };
const fixture = (create: any, caseId: string, parent?: AbortSignal) => ({ args: { projectName: '虚构SDK长响应标书', requirements: source, persistCase: false, caseId }, context: { userId, domain: 'personal', source: 'legal-direct-tool', executionSignal: parent, llmGetters: { getRelay: () => ({ chat: { completions: { create } } }) } } });
const run = async (f: ReturnType<typeof fixture>, forceRegenerate = true) => decodeToolResult(await generateBidHandler({ ...f.args, forceRegenerate }, f.context));
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
beforeEach(() => { vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit(); upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit(); });

describe('bid wait budget reaches the actual streamed SDK with existing deadline guards', () => {
  it('allows real SDK-mocked 70-second chapter responses past both the old 45 and 60 seconds, preserving max16384 and concurrency two', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let active = 0, peak = 0; const times: Array<{ start: number; end: number }> = [];
    const create = vi.fn((params: any, options: any) => { if (promptOf(params).includes('待核对JSON草稿：')) return response(params); active++; peak = Math.max(peak, active); const record = { start: Date.now(), end: 0 }; times.push(record); return (async function* () { try { yield* sdkCompletion(params, completeResponse(params), 70_000, options.signal); } finally { active--; record.end = Date.now(); } })(); });
    const resultPromise = run(fixture(create, 'slow-70s-sdk-case'));
    await vi.advanceTimersByTimeAsync(69_999); expect(create).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(70_001); const result = await resultPromise;
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(6); expect(peak).toBe(2);
    expect(times.map(time => time.end - time.start)).toEqual([70000, 70000, 70000]);
    for (const [params] of create.mock.calls) expect(params).toMatchObject({ model: 'aliyun/deepseek-v4-flash', max_tokens: 16384 });
    expect(result.content).toContain(source); expect(result.content).toContain('逐项响应与偏差：来源绑定正文与事实一致性复核已取得');
    expect(getToolExecutionTimeoutMs('legal_generate_bid')).toBe(LEGAL_BID_TOOL_TIMEOUT_MS); expect(getToolExecutionTimeoutMs('legal_review_contract')).toBe(120_000);
  });

  it('stops three never-returning SDK chapters in two 180-second worker waves without caching them as completed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const create = vi.fn(() => new Promise(() => {})); const f = fixture(create, 'never-returning-sdk-case'), before = snapshot(), start = Date.now();
    const resultPromise = run(f); await vi.advanceTimersByTimeAsync(180_001); expect(create).toHaveBeenCalledTimes(3); await vi.advanceTimersByTimeAsync(180_001);
    const result = await resultPromise; expect(Date.now() - start).toBeLessThanOrEqual(360_002); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content.match(/正文未完成，不能计为完成/g)).toHaveLength(3); expect(result.content).toContain('接续复用 0 章'); expect(result.content).toContain(source); expect(snapshot()).toEqual(before);
  });

  it('honors caller cancellation before the bid deadline even if the SDK ignores AbortSignal and settles later', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController(); const create = vi.fn((params: any, options: any) => sdkCompletion(params, completeResponse(params), 70_000, options.signal));
    const f = fixture(create, 'parent-cancelled-sdk-case', controller.signal), before = snapshot();
    const cancelled = expect(run(f)).rejects.toThrow('virtual caller cancelled'); await vi.advanceTimersByTimeAsync(10_000); expect(create).toHaveBeenCalledTimes(2); controller.abort(new Error('virtual caller cancelled')); await cancelled;
    await vi.advanceTimersByTimeAsync(70_000); expect(create).toHaveBeenCalledTimes(2); expect(snapshot()).toEqual(before);
  });

  it('allows the sole remaining chapter its serial 159-second draft and 30-second review without regenerating reviewed chapters', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OFFLINE_BUDGET_REGRESSION_ONLY'));
    let recovering = false; const phases: Array<{ review: boolean; start: number; end: number }> = [];
    const create = vi.fn((params: any, options: any) => {
      const review = promptOf(params).includes('待核对JSON草稿：');
      if (!recovering) return !review && promptOf(params).includes('本次只输出“技术')
        ? Promise.reject(new Error('virtual technical chapter outage')) : response(params);
      const phase = { review, start: Date.now(), end: 0 }; phases.push(phase);
      return (async function* () { try { yield* sdkCompletion(params, completeResponse(params), review ? 30_000 : 159_000, options.signal); } finally { phase.end = Date.now(); } })();
    });
    const f = fixture(create, 'sole-remaining-serial-stages-case');
    const first = await run(f);
    expect(first.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(create).toHaveBeenCalledTimes(5);
    recovering = true; create.mockClear(); const pending = run(f, false);
    await vi.advanceTimersByTimeAsync(159_001); expect(create).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_001); const result = await pending;
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(2);
    expect(promptOf(create.mock.calls[0][0])).toContain('本次只输出“技术方案与实施计划”');
    expect(phases.map(phase => phase.end - phase.start)).toEqual([159_000, 30_000]);
    expect(result.content).toContain('接续复用 2 章'); expect(result.content).toContain(source);
    expect(network).not.toHaveBeenCalled();
  });

  it('retains two actual SDK-generated chapters and retries only the missing chapter on the same source and selected model', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let failTechnical = true; const create = vi.fn((params: any, options: any) => { if (promptOf(params).includes('待核对JSON草稿：')) return response(params); if (failTechnical && promptOf(params).includes('本次只输出“技术')) return Promise.reject(new Error('virtual technical chapter outage')); return sdkCompletion(params, completeResponse(params), 70_000, options.signal); });
    const f = fixture(create, 'partial-real-sdk-case'), firstPromise = run(f); await vi.advanceTimersByTimeAsync(140_001); const first = await firstPromise;
    expect(first.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(create).toHaveBeenCalledTimes(5); expect(first.content).toContain('技术方案与实施计划：正文未完成');
    failTechnical = false; create.mockClear(); const secondPromise = run(f, false); await vi.advanceTimersByTimeAsync(70_001); const second = await secondPromise;
    expect(second.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(2); expect(promptOf(create.mock.calls[0][0])).toContain('本次只输出“技术方案与实施计划”'); expect(second.content).toContain('接续复用 2 章'); expect(second.content).toContain(source);
  });
});

const capacityBody='本段为离线程序验收的拟议响应，只以服务器绑定原件作为来源，未知条件和证明保持待核实，不作事实、资质、评分、法律或者正式提交核准。';
function capacityFixture(){
 const userId='bid-budget-offline-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId),item=cases.createCase(orgId,userId,{title:'虚构六源输出容量离线验收'}),requestId=crypto.randomUUID();
 upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned',fallbackCandidates:[],allowCloudFallback:false});
 const sourceFixture=JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures/legal_bid_six_materials_164.json'),'utf8'));
 const directory=getDataDirectory(path.join('synthetic-bid-capacity',userId));const inputs=sourceFixture.materials.map((material:any,index:number)=>{const file=path.join(directory,String(index+1).padStart(2,'0')+'-synthetic-original.txt');fs.writeFileSync(file,material.content,'utf8');return{path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};});
 const before=new Set(fs.readdirSync(getDataDirectory('legal_document_progress'))),events:any[]=[],plan={needed:10000,technicalDraftMs:0,technicalReviewMs:0,allDraftMs:0,allReviewMs:0,invalid:false};
 const create=vi.fn(async(params:any,options:any)=>{
  const prompt=String(params.messages.find((m:any)=>m.role==='user')?.content||''),review=prompt.includes('待核对JSON草稿：'),sources=bidPromptSources(prompt),draft=review?JSON.parse(prompt.split('待核对JSON草稿：')[1]):null;
  const sections=review?draft.entries.map((e:any)=>({id:e.sectionId})):JSON.parse(prompt.split('\n指定子节：')[1]),technical=sections[0].id==='technical-plan';
  const event={kind:review?'review':'draft',ids:sections.map((s:any)=>s.id),maxTokens:params.max_tokens,effort:params.reasoning_effort,format:params.response_format,at:Date.now(),abortedAt:null as number|null,sourceCount:sources.length,materialCount:new Set(sources.map((s:any)=>s.materialId)).size,promptChars:prompt.length,reviewDuplicatesSections:review&&prompt.includes('指定子节：'),reviewSectionIds:review?JSON.parse(prompt.split('\n指定子节：')[1].split('\n原始材料：')[0]).map((section:any)=>section.id):[],reviewSourceIds:review?draft.entries.flatMap((entry:any)=>entry.sourceIds):[],removedReviewMetadataChars:review?'\n指定子节：'.length+JSON.stringify(buildBidChapters(sources).flatMap(ch=>ch.sections).filter(s=>sections.some((chosen:any)=>chosen.id===s.id))).length:0};events.push(event);
  expect(params.stream).toBe(true);expect(params.reasoning_effort).toBe('low');expect(params.response_format).toEqual({type:'json_object'});expect(sources).toHaveLength(164);expect(new Set(sources.map((s:any)=>s.materialId)).size).toBe(6);
  for(const file of inputs)expect(crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex')).toBe(file.sha256);
  if(params.max_tokens<plan.needed)return sdkCompletion(params,{choices:[{message:{content:null},finish_reason:'length'}],usage:{prompt_tokens:9000,completion_tokens:params.max_tokens,total_tokens:9000+params.max_tokens}});
  const entries=review?draft.entries:sections.map((s:any,index:number)=>({sectionId:s.id,sourceIds:plan.invalid&&technical&&index===1?['UNREGISTERED-SOURCE']:[sources.some((f:any)=>f.id===s.id)?s.id:sources[0].id],response:capacityBody,missing:'本例只验证容量和控制流，原始资料与正式使用条件仍待核验。'}));
  const content=JSON.stringify(review?{complete:true,entries,unresolved:[]}:{entries});
  const delay=review?(technical?plan.technicalReviewMs:0)||plan.allReviewMs:(technical?plan.technicalDraftMs:0)||plan.allDraftMs;
  options.signal?.addEventListener('abort',()=>{event.abortedAt=Date.now();},{once:true});
  return sdkCompletion(params,{choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:9000,completion_tokens:plan.needed,total_tokens:9000+plan.needed}},delay,options.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);const context:any={userId,domain:'personal',requestId,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const run=(signal?:AbortSignal)=>registry.execute('legal_generate_bid',{caseId:item.id,projectName:'Offline-capacity-'+item.id,filePaths:inputs.map(i=>i.path),maxChars:60000,persistCase:true},{...context,requestId:crypto.randomUUID(),executionSignal:signal}).then(decodeToolResult);
 const checkpoint=()=>fs.readdirSync(getDataDirectory('legal_document_progress')).filter(f=>!before.has(f)).map(f=>({file:path.join(getDataDirectory('legal_document_progress'),f),value:JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'),f),'utf8'))}))[0];
 return{run,create,events,plan,checkpoint,orgId,item};
}
describe('one existing bid workflow preserves all six originals under its bounded output contract',()=>{
 it('passes actual native16K/low/JSON to SDK, retains164 sources and56 response targets, and does not add stages',async()=>{
  const f=capacityFixture(),result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(result.content).toContain('56/56');expect(f.create).toHaveBeenCalledTimes(14);expect(f.events.every(e=>e.maxTokens===16384)).toBe(true);
  const responseDrafts=f.events.filter(e=>e.kind==='draft'&&/^F\d+$/.test(e.ids[0]));expect(responseDrafts.flatMap(e=>e.ids)).toHaveLength(56);expect(new Set(responseDrafts.flatMap(e=>e.ids)).size).toBe(56);expect(responseDrafts.every(e=>e.ids.length<=12)).toBe(true);
  const reviews=f.events.filter(e=>e.kind==='review');expect(reviews).toHaveLength(7);
  for(const review of reviews){expect(review.reviewSectionIds).toEqual(review.ids);expect(review.reviewSectionIds).toEqual(f.events.find(e=>e.kind==='draft'&&e.ids[0]===review.ids[0])!.ids);}
  expect(Object.values(f.checkpoint().value.documents).every((d:any)=>d.reviewed)).toBe(true);
 });
 it('waits for100s draft then100s review within the unchanged finite batch, rather than cancelling at90s',async()=>{
  const f=capacityFixture();f.plan.needed=100;f.plan.technicalDraftMs=100000;f.plan.technicalReviewMs=100000;vi.useFakeTimers();const pending=f.run();await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='draft'&&e.ids[0]==='technical-plan')).toBe(true));await vi.advanceTimersByTimeAsync(205000);vi.useRealTimers();const result=await pending;expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.events.filter(e=>e.ids[0]==='technical-plan').map(e=>e.kind)).toEqual(['draft','review']);expect(f.events.filter(e=>e.ids[0]==='technical-plan').every(e=>e.abortedAt===null)).toBe(true);expect(f.create).toHaveBeenCalledTimes(14);
 });
 it('still cancels a190s single stage at180s and does not archive a partial packet',async()=>{
  const f=capacityFixture();f.plan.needed=100;f.plan.technicalDraftMs=190000;vi.useFakeTimers();const pending=f.run();await vi.waitFor(()=>expect(f.events.some(e=>e.kind==='draft'&&e.ids[0]==='technical-plan')).toBe(true));await vi.advanceTimersByTimeAsync(181000);vi.useRealTimers();const result=await pending;expect(result.receipt).toMatchObject({ok:false,status:'partial'});const event=f.events.find(e=>e.ids[0]==='technical-plan');expect(event.abortedAt-event.at).toBe(180000);expect(cases.getCase(f.orgId,f.item.id)!.materials).toHaveLength(0);
 });
 it('keeps the whole720s/outer750s bounds and retains completed units honestly when a full slow workload cannot finish',async()=>{
  expect(LEGAL_BID_MAX_MODEL_BUDGET_MS).toBe(720000);expect(LEGAL_BID_TOOL_TIMEOUT_MS).toBe(750000);const f=capacityFixture();f.plan.needed=100;f.plan.allDraftMs=160000;f.plan.allReviewMs=160000;vi.useFakeTimers();const pending=f.run();await vi.waitFor(()=>expect(f.events).toHaveLength(2));const start=f.events[0].at;await vi.advanceTimersByTimeAsync(721000);vi.useRealTimers();const result=await pending;expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.content).toContain('本轮预算耗尽');expect(f.events.some(e=>e.abortedAt-start===720000)).toBe(true);expect(f.events.length).toBeLessThan(14);expect(Object.values(f.checkpoint().value.documents).some((d:any)=>d.reviewed)).toBe(true);expect(cases.getCase(f.orgId,f.item.id)!.materials).toHaveLength(0);
 });
 it('preserves caller cancellation without retries, further units or archival',async()=>{
  const f=capacityFixture();f.plan.needed=100;f.plan.allDraftMs=100000;vi.useFakeTimers();const c=new AbortController(),pending=expect(f.run(c.signal)).rejects.toThrow('offline caller stopped');await vi.waitFor(()=>expect(f.events).toHaveLength(2));await vi.advanceTimersByTimeAsync(1000);c.abort(new Error('offline caller stopped'));await pending;expect(f.events).toHaveLength(2);expect(cases.getCase(f.orgId,f.item.id)!.materials).toHaveLength(0);
 });
 it('reuses reviewed units and reviews only an exact own pending unit with no new drafts',async()=>{
  const f=capacityFixture();f.plan.needed=100;expect((await f.run()).receipt).toMatchObject({ok:true});const checkpoint=f.checkpoint();checkpoint.value.documents.technical.reviewed=false;fs.writeFileSync(checkpoint.file,JSON.stringify(checkpoint.value));f.events.length=0;expect((await f.run()).receipt).toMatchObject({ok:true});expect(f.events.map(e=>e.kind)).toEqual(['review']);expect(f.events[0].ids).toEqual(['technical-plan','schedule','delivery-risk']);f.events.length=0;expect((await f.run()).receipt).toMatchObject({ok:true});expect(f.events).toHaveLength(0);
 });
 it('does not use higher capacity to bypass unknown-source rejection or claim partial as archived',async()=>{
  const f=capacityFixture();f.plan.needed=100;f.plan.invalid=true;const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.content).toContain('引用了未登记的原始材料编号');const technicalReviews=f.events.filter(e=>e.kind==='review'&&e.ids[0]==='technical-plan');expect(technicalReviews).toHaveLength(1);expect(technicalReviews[0].reviewSourceIds).toContain('UNREGISTERED-SOURCE');expect(technicalReviews[0].reviewSectionIds).toEqual(f.events.find(e=>e.kind==='draft'&&e.ids[0]==='technical-plan')!.ids);expect(cases.getCase(f.orgId,f.item.id)!.materials).toHaveLength(0);
 });
});
