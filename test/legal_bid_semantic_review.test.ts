import { bidPromptSources } from './legal_bid_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { parseDocument } from '../server/legal/parser';
import * as cases from '../server/org/legal_cases';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as quality from '../server/regions/packs/cn/legal_work_product_quality';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const original = 'R01：最高限价300000元，投标人含税报价254400元。SOURCE-ONLY-ONCE-63481\nR02：启动后5个工作日完成清点。\nE01：价格30分，未给竞争报价，不计算得分。\nE02：实施方案25分，不是价格评分。\nR04：暂拟按含税报价30%启动、40%中期、30%终验付款；是否需发票/验收单待确认。\nR05：每月巡检；设备清单未提供，新增服务承诺待确认。';
const bad = '清单提供后3个工作日内更新巡检计划；启动后5日完成清点；E02价格评分；三期付款30%、40%、30%，尚未列各期金额。';
const corrected = '建议设备清单提供后3个工作日内更新，待责任人确认；启动后5个工作日完成清点；价格评分依据E01；含税基数254400元：30%×254400=76320元，40%×254400=101760元，30%×254400=76320元，合计254400元。发票/验收付款前提仍待核实。';
type Mode = 'correct' | 'pass' | 'reject' | 'binding' | 'section' | 'malformed' | 'pending' | 'metadata' | 'reorder' | 'unresolved' | 'incomplete-entries' | 'truncated';
async function setup(mode: Mode = 'correct') {
  const userId = 'bid-reviewed-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-bid-review', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const c = cases.createCase(orgId, userId, { title: 'Synthetic bid semantic closure', factDate: '2026-09-01' });
  const existingCheckpoints = new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
  const plan = { mode, slowBusiness: 0, slowReview: 0 }; const events: Array<{ kind: string; chapter: string; at: number }> = [];
  const create = vi.fn(async (request: any, options: any) => {
    const prompt = String(request.messages.find((m: any) => m.role === 'user')?.content || '');
    const reviewing = prompt.includes('待核对JSON草稿：'); let content: string, chapter: string;
    if (!reviewing) {
      const sources = bidPromptSources(prompt); const sections = JSON.parse(prompt.split('\n指定子节：')[1]);
      chapter = prompt.includes('本次只输出“商务') ? 'business' : prompt.includes('本次只输出“技术') ? 'technical' : 'response';
      content = JSON.stringify({ entries: sections.map((s: any) => ({ sectionId: s.id, sourceIds: sources.some((source: any) => source.id === s.id) ? [s.id] : sources.map((source: any) => source.id), response: plan.mode === 'correct' ? bad : corrected, missing: '原件、付款前提仍需核验' })) });
    } else {
      const draft = JSON.parse(prompt.split('待核对JSON草稿：')[1]);
      chapter = draft.entries[0].sectionId === 'bid-letter' ? 'business' : draft.entries[0].sectionId === 'technical-plan' ? 'technical' : 'response';
      if (plan.mode === 'correct') for (const entry of draft.entries) entry.response = corrected;
      if (plan.mode === 'incomplete-entries' && chapter === 'business') delete draft.entries[0].response;
      if (plan.mode === 'metadata') { draft.entries[0].verified = true; draft.entries[0].notes = 'UNTRUSTED-REVIEW-METADATA'; }
      if (plan.mode === 'binding' && chapter === 'business') draft.entries[0].sourceIds = draft.entries[0].sourceIds.filter((id: string) => id !== 'F4');
      if (plan.mode === 'reorder' && chapter === 'business') draft.entries[0].sourceIds.reverse();
      if (plan.mode === 'section' && chapter === 'business') draft.entries[0].sectionId = 'business-response';
      content = plan.mode === 'malformed' && chapter === 'business' ? '{not json' : JSON.stringify({ complete: !(plan.mode === 'reject' && chapter === 'business'), entries: draft.entries, unresolved: plan.mode === 'unresolved' && chapter === 'business' ? ['原稿选源不支持结论，不能安全修正'] : [] });
    }
    events.push({ kind: reviewing ? 'review' : 'draft', chapter, at: Date.now() });
    const delay = !reviewing && chapter === 'business' ? plan.slowBusiness : reviewing && chapter === 'business' ? plan.mode === 'pending' ? 185_000 : plan.slowReview : 0;
    const result = { choices: [{ message: { content }, finish_reason: plan.mode === 'truncated' && reviewing && chapter === 'business' ? 'length' : 'stop' }] };
    return sdkCompletion(request, result, delay, options.signal);
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const args = { caseId: c.id, projectName: 'Bid-' + c.id, requirements: original, persistCase: true };
  const context: import('../server/tools/types').ToolContext = { userId, domain: 'personal' as const, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' as const, llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = (executionSignal?: AbortSignal) => registry.execute('legal_generate_bid', args, { ...context, executionSignal, requestId: crypto.randomUUID() }).then(decodeToolResult);
  const checkpoints = () => fs.readdirSync(getDataDirectory('legal_document_progress')).filter(name => !existingCheckpoints.has(name)).map(name => ({ name, value: JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'), name), 'utf8')) }));
  return { userId, orgId, c, create, plan, events, args, context, run, checkpoints };
}
describe('bid draft and fact review share the same source-bound entry schema', () => {
  it('applies all four factual corrections to proposed JSON values and transports corrected text and untouched originals to DOCX', async () => {
    const f = await setup(); const result = await f.run(); expect(result.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(f.events.filter(e => e.kind === 'review')).toHaveLength(3); expect(f.create).toHaveBeenCalledTimes(6);
    expect(result.content).toContain(corrected); expect(result.content).not.toContain(bad); expect(result.content).toContain(original);
    for (const [request] of f.create.mock.calls) { const prompt = String(request.messages.find((m: any) => m.role === 'user').content); if (prompt.includes('待核对JSON草稿：')) expect(prompt.split('SOURCE-ONLY-ONCE-63481')).toHaveLength(2); }
    const file = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length); expect((await parseDocument(file))?.text).toContain(corrected);
    const cache = f.checkpoints().find(saved => Object.keys(saved.value.documents).length === 3)!.value; for (const draft of Object.values(cache.documents) as any[]) expect(draft.reviewed).toBe(true);
  });
  it.each(['reject', 'unresolved'] as const)('clears only the explicitly rejected %s chapter and redrafts it next time without retrying this task', async mode => {
    const f = await setup(mode); const first = await f.run(); expect(first.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(f.create).toHaveBeenCalledTimes(6);
    expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0); expect(first.content).toMatch(/下次.*重新起草/);
    const checkpoint = f.checkpoints()[0].value.documents; expect(checkpoint.business).toBeUndefined(); expect(checkpoint.technical.reviewed).toBe(true); expect(checkpoint.response.reviewed).toBe(true);
    const before = f.events.length; f.plan.mode = 'pass'; const second = await f.run(); expect(second.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(f.events.slice(before).map(e => [e.kind, e.chapter])).toEqual([['draft', 'business'], ['review', 'business']]);
  });
  it.each(['malformed', 'incomplete-entries', 'truncated', 'section'] as const)('retains a %s review as pending and resumes only review, never redrafting completed or pending chapters', async mode => {
    const f = await setup(mode); const first = await f.run(); expect(first.receipt).toMatchObject({ ok: false, status: 'partial' });
    const checkpoint = f.checkpoints()[0].value.documents; expect(checkpoint.business.reviewed).toBe(false); expect(checkpoint.technical.reviewed).toBe(true); expect(checkpoint.response.reviewed).toBe(true);
    const before = f.events.length; f.plan.mode = 'pass'; expect((await f.run()).receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(f.events.slice(before).map(e => [e.kind, e.chapter])).toEqual([['review', 'business']]); const complete = f.events.length; await f.run(); expect(f.events).toHaveLength(complete);
  });
  it('accepts removal of an unrelated registered implementation-score citation while preserving the actual price original and section identity',async()=>{
    const f=await setup('binding');const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(6);expect(result.content).toContain(corrected);expect(result.content).toContain(original);
    const checkpoint=f.checkpoints()[0].value.documents;expect(checkpoint.business.reviewed).toBe(true);expect(checkpoint.technical.reviewed).toBe(true);expect(checkpoint.response.reviewed).toBe(true);
    const entry=JSON.parse(checkpoint.business.markdown).entries.find((e:any)=>e.sectionId==='bid-letter');expect(entry.sourceIds).toContain('F1');expect(entry.sourceIds).not.toContain('F4');expect(entry.sourceIds.every((id:string)=>/^F[1-6]$/.test(id))).toBe(true);expect(entry.response).toBe(corrected);
    expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);
  });
  it('drops unused review approval metadata from the canonical four-field checkpoint', async () => {
    const f = await setup('metadata'); const result = await f.run(); expect(f.events.filter(e => e.kind === 'review')).toHaveLength(3); expect(result.receipt).toMatchObject({ ok: true }); expect(result.content).not.toContain('UNTRUSTED-REVIEW-METADATA');
    const cache = f.checkpoints().find(saved => Object.keys(saved.value.documents).length === 3)!.value;
    for (const saved of Object.values(cache.documents) as any[]) for (const entry of JSON.parse(saved.markdown).entries) expect(Object.keys(entry).sort()).toEqual(['missing', 'response', 'sectionId', 'sourceIds']);
  });
  it('accepts source-ID order changes while final source identities remain registered', async () => { const f = await setup('reorder'); expect((await f.run()).receipt).toMatchObject({ ok: true, status: 'generated' }); expect(f.events.filter(e => e.kind === 'review')).toHaveLength(3); });
  it('keeps the 180-second single-call review limit and preserves fast reviewed chapters within the finite workload budget', async () => {
    const f = await setup('pending'); f.plan.slowBusiness = 89_500; vi.useFakeTimers(); const pending = f.run(); await vi.advanceTimersByTimeAsync(2_000);
    expect(f.events.some(e => e.kind === 'review' && e.chapter === 'technical')).toBe(true); await vi.advanceTimersByTimeAsync(358_001);
    expect((await pending).receipt).toMatchObject({ ok: false, status: 'partial' }); expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    const before = f.events.length; f.plan.mode = 'pass'; f.plan.slowBusiness = 0; let resumed: Awaited<ReturnType<typeof f.run>> | undefined; const continued = f.run().then(result => { resumed = result; return result; }); await vi.waitFor(() => expect(resumed).toBeDefined()); expect((await continued).receipt).toMatchObject({ ok: true }); expect(f.events.slice(before).map(e => [e.kind, e.chapter])).toEqual([['review', 'business']]);
  });
  it('honors caller cancellation during review without caching the unfinished chapter as reviewed or archiving it', async () => {
    const f = await setup('pass'); f.plan.slowReview = 70_000; vi.useFakeTimers(); const controller = new AbortController();
    const settled = expect(f.run(controller.signal)).rejects.toThrow('virtual bid review cancelled');
    await vi.advanceTimersByTimeAsync(10_000); expect(f.events.some(e => e.kind === 'review' && e.chapter === 'business')).toBe(true); controller.abort(new Error('virtual bid review cancelled'));
    await settled; expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    for (const saved of f.checkpoints()) expect(saved.value.documents.business?.reviewed).not.toBe(true);
    const before = f.events.length; await vi.advanceTimersByTimeAsync(70_001); expect(f.events).toHaveLength(before);
  });
  it('invalidates reviewed checkpoints after actual review instructions change', async () => {
    const f = await setup('pass'); await f.run(); f.create.mockClear(); const before = quality.buildBidChapters;
    vi.spyOn(quality, 'buildBidChapters').mockImplementation((...args) => before(...args).map(chapter => ({ ...chapter, instruction: chapter.instruction + '\nSYNTHETIC-REVIEW-RECIPE-CHANGE' })));
    expect((await f.run()).receipt).toMatchObject({ ok: true }); expect(f.create).toHaveBeenCalledTimes(6);
  });
});
