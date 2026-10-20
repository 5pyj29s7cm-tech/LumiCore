import { legalBatchModelBudgetMs } from '../server/legal/budgets';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeApp } from './helpers';
import { generateBidHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { readBidRequirementInput } from '../server/regions/packs/cn/legal_tools/documents';
import { makeLLMCall } from '../server/llm/providers';
import { decodeToolResult } from '../server/tools/result_envelope';
import { parseDocument } from '../server/legal/parser';
import { getUserPreferredLLMConfig } from '../server/llm/user_preferences';
import { getDataDirectory } from '../server/config/data_path';
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { bidStructuredReply } from './legal_bid_fixture';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
vi.mock('../server/llm/user_preferences', async original => ({ ...await original<typeof import('../server/llm/user_preferences')>(), getUserPreferredLLMConfig: vi.fn() }));
let app: Awaited<ReturnType<typeof makeApp>>;
const context = { userId: 'bid-progress-owner', domain: 'work', orgId: 'bid-progress-org', authenticated: true, llmGetters: {} };
const preference = { provider: 'relay', model: 'synthetic-short-draft', userId: context.userId, selectionMode: 'ordered_fallback', fallbackCandidates: [{provider:'lmstudio',model:'synthetic-local'}], allowCloudFallback: true } as any;
const requirements = 'R01采购仅用于虚构验收。R02含税报价254400元，最高限价300000元。D01专项资质未提供。TAIL-BID-SOURCE-982741';
const args = { projectName: '虚构分章验收项目', requirements, persistCase: false, caseId: 'synthetic-case-a' };
const sectionBody = (prompt: string) => '# 本章正文\n' + (prompt.includes('本次只输出“商务') ? '商务采购主体、含税报价254400元及最高限价300000元保持原值，专项资质原件未提供，不认定资格已通过。' : prompt.includes('本次只输出“技术') ? '技术实施范围仅限本次虚构材料，数量和资源待确认；验收办法与备份目标仍须按来源核对，未进行真实履行或验收。' : 'R01仅虚构验收；R02报价254400元；D01资质原件缺失，证明与资格待核验；评分和最终提交均不认定已经完成。');
const sectionText = (prompt: string) => bidStructuredReply(prompt, sectionBody(prompt));
const promptOf = (messages: any[]) => String(messages.find(m => m.role === 'user')?.content || '');
const run = async (extra = {}, ctx = context) => decodeToolResult(await generateBidHandler({ ...args, ...extra }, ctx));
const fill = () => vi.mocked(makeLLMCall).mockImplementation(async messages => ({text: sectionText(promptOf(messages)), toolCalls:null} as any));
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
afterEach(() => { vi.mocked(makeLLMCall).mockReset(); vi.mocked(getUserPreferredLLMConfig).mockReset(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('bounded bid chapters reuse the existing source-scoped progress', () => {
  beforeAll(() => vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options})));
  it('rejects an output directory outside the legal delivery root before paying for chapters or saving progress', async () => {
    vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options})); fill();
    const directory = getDataDirectory('legal_document_progress');
    const snapshot = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
    const before = snapshot();
    await expect(run({ forceRegenerate: true, caseId: 'invalid-output-path-case', outputDir: path.join(os.tmpdir(), 'lumi-bid-outside-' + crypto.randomUUID()) })).rejects.toThrow(/must stay within the legal delivery root/);
    expect(makeLLMCall).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
  it('keeps successful chapters and resumes only the missing chapter without changing routing', async () => {
    vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options}));
    vi.mocked(makeLLMCall).mockImplementation(async messages => { const prompt = promptOf(messages); if(prompt.includes('本次只输出“技术')) throw new Error('synthetic provider outage'); return {text:sectionText(prompt),toolCalls:null} as any; });
    const first = await run({forceRegenerate:true});
    expect(first.receipt).toMatchObject({ok:false,status:'partial'});
    expect(first.content).toContain('技术方案与实施计划：正文未完成');
    expect(first.content).toContain('R01仅虚构验收');
    expect(makeLLMCall).toHaveBeenCalledTimes(5);
    for(const call of vi.mocked(makeLLMCall).mock.calls) expect(call[2]).toMatchObject({provider:preference.provider,model:preference.model,selectionMode:'ordered_fallback',fallbackCandidates:preference.fallbackCandidates,maxTokens:16384,attemptTimeouts:{absoluteMs:180000,semanticContentMs:180000}});
    vi.mocked(makeLLMCall).mockClear(); fill();
    const second = await run();
    expect(second.receipt).toMatchObject({ok:true,status:'generated'});
    expect(second.content).toContain('接续复用 2 章');
    expect(second.content).toContain('不代表事实、资格、评分及正式提交已核准');
    expect(makeLLMCall).toHaveBeenCalledTimes(2);
    expect(promptOf(vi.mocked(makeLLMCall).mock.calls[0][0])).toContain('本次只输出“技术方案与实施计划”');
    const docxPath = second.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length).trim();
    const actual = await parseDocument(docxPath); expect(actual?.text).toContain(requirements); expect(actual?.text).toContain('TAIL-BID-SOURCE-982741');
  });
  it('resumes raw checkpoints with extra unused metadata through the same safe field projection', async () => {
    vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options}));
    const marker = 'UNUSED-RAW-CACHE-METADATA-' + crypto.randomUUID();
    const input = { projectName: '元数据投影缓存-' + crypto.randomUUID() };
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const value = JSON.parse(sectionText(promptOf(messages)));
      value.notes = marker; value.verified = true;
      for (const entry of value.entries || []) { entry.fact = marker; entry.quote = marker; entry.verified = true; }
      return { text: JSON.stringify(value), toolCalls: null } as any;
    });
    const beforeNames = new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
    const first = await run({ ...input, forceRegenerate: true });
    expect(first.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(first.content).not.toContain(marker); expect(first.content).toContain(requirements);
    expect(makeLLMCall).toHaveBeenCalledTimes(6);
    const directory = getDataDirectory('legal_document_progress');
    const saved = fs.readdirSync(directory).filter(name => !beforeNames.has(name)).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
      .find(item => Object.keys(item.documents || {}).length === 3);
    expect(saved).toBeTruthy();
    expect(Object.keys(saved.documents)).toHaveLength(3);
    for (const draft of Object.values(saved.documents) as any[]) { expect(draft.reviewed).toBe(true); expect(draft.markdown).not.toContain(marker); expect(Object.keys(JSON.parse(draft.markdown)).sort()).toEqual(['entries']); }
    vi.mocked(makeLLMCall).mockClear();
    const resumed = await run(input);
    expect(resumed.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(resumed.content).toContain('接续复用 3 章');
    expect(resumed.content).toContain(requirements);
    expect(resumed.content).not.toContain(marker);
    expect(resumed.content).toContain('内容与计算仍待责任人核验');
    expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it.each(['source','owner','domain','case','model','date','policy'])('invalidates saved chapters after changing %s', async change => {
    vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options})); fill(); await run({forceRegenerate:true}); vi.mocked(makeLLMCall).mockClear();
    const extra = change==='source' ? {requirements:requirements+'R03来源变更。'} : change==='case' ? {caseId:'synthetic-case-b'} : {};
    const ctx = change==='owner' ? {...context,userId:'different-owner'} : change==='domain' ? {...context,domain:'personal'} : change==='date' ? {...context,factDate:'2026-10-01'} : change==='policy' ? {...context,dataRoutingPolicy:'local_only'} : context;
    if(change==='model') vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options,model:'different-model'}));
    expect((await run(extra,ctx)).receipt).toMatchObject({ok:true,status:'generated'}); expect(makeLLMCall).toHaveBeenCalledTimes(6);
  });
  it('rejects truncated or heading-only chapter bodies and keeps the full source', async () => {
    vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options}));
    vi.mocked(makeLLMCall).mockImplementation(async messages => ({text:promptOf(messages).includes('本次只输出“商务')?'partial output':'# '+'只有目录'.repeat(30),finishReason:promptOf(messages).includes('本次只输出“商务')?'length':'stop',toolCalls:null} as any));
    const result = await run({forceRegenerate:true}); expect(result.receipt).toMatchObject({ok:false,status:'partial'}); expect(result.content).toContain(requirements); expect(result.content).toContain('不能当成已完成标书');
    expect(result.content).toContain('商务响应与报价：正文未完成，不能计为完成；原因：输出额度耗尽，正文截断');
    expect(result.content).toContain('技术方案与实施计划：正文未完成，不能计为完成；原因：起草 JSON 解析失败，未取得可核验正文');
  });
  it.each(['length', 'max_tokens', 'MAX_TOKENS'])('shows exhausted output capacity and never caches a long %s chapter as complete', async finishReason => {
    vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options}));
    vi.mocked(makeLLMCall).mockResolvedValue({ text: '# 截断章\n' + 'TRUNCATED-BODY-MUST-NOT-BECOME-CACHED-DRAFT'.repeat(20), finishReason, toolCalls: null } as any);
    await expect(runLegalLLM('复现原4096输出额度耗尽', context, 4096, false, 45000)).rejects.toMatchObject({ reason: 'output_limit' });
    expect(vi.mocked(makeLLMCall).mock.calls[0][2]).toMatchObject({ maxTokens: 4096 });
    vi.mocked(makeLLMCall).mockClear();
    const directory = getDataDirectory('legal_document_progress');
    const snapshot = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
    const before = snapshot(), input = { caseId: 'truncated-' + finishReason };
    const first = await run({ ...input, forceRegenerate: true });
    expect(first.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(first.content.match(/原因：输出额度耗尽，正文截断，未保存为完成章节/g)).toHaveLength(3);
    expect(first.content).not.toContain('TRUNCATED-BODY-MUST-NOT-BECOME-CACHED-DRAFT');
    expect(first.content).toContain(requirements);
    expect(first.content).toContain('接续复用 0 章');
    expect(makeLLMCall).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(makeLLMCall).mock.calls) expect(call[2]).toMatchObject({ maxTokens: 16384 });
    expect(snapshot()).toEqual(before);
    vi.mocked(makeLLMCall).mockClear();
    const next = await run(input);
    expect(next.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(next.content).toContain('接续复用 0 章');
    expect(makeLLMCall).toHaveBeenCalledTimes(3);
    expect(snapshot()).toEqual(before);
  });
  it('uses two workers under the finite workload-derived bid budget and records unstarted chapters as missing', async () => {
    let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);vi.mocked(getUserPreferredLLMConfig).mockImplementation((_user, options) => ({...preference,...options}));
    let release: undefined | (()=>void); let calls=0;
    vi.mocked(makeLLMCall).mockImplementation(async messages => {calls++;await new Promise<void>(resolve=>{ if(calls===1) release=resolve; else { now+=legalBatchModelBudgetMs(6)+1000; release?.(); resolve(); } });return {text:sectionText(promptOf(messages)),toolCalls:null} as any;});
    const result = await run({forceRegenerate:true}); expect(makeLLMCall).toHaveBeenCalledTimes(2); expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.content).toContain('逐项响应与偏差：正文未完成，不能计为完成；原因：本轮预算耗尽，章节未开始');
  });
});
describe('bid file collector normalizes each existing source path once', () => {
  it('reads a file once across relative, absolute and folder inputs while preserving CSV source text', async () => {
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'lumi-bid-dedup-'));const file=path.join(folder,'quote.csv');const raw='项目,未税,税额,含税\n归档,240000,14400,254400\n"说明,含逗号",待确认,待确认,待确认';fs.writeFileSync(file,raw);
    try {const result=await readBidRequirementInput({filePath:file,filePaths:[path.relative(process.cwd(),file),file],folderPath:folder});expect(result.skipped).toEqual([]);expect(result.sources).toHaveLength(1);expect(result.requirements.split(raw)).toHaveLength(2);} finally {fs.rmSync(folder,{recursive:true,force:true});}
  });
});
