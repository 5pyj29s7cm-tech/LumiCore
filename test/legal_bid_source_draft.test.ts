import { bidPromptSources } from './legal_bid_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { readBidRequirementInput } from '../server/regions/packs/cn/legal_tools/documents';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import * as quality from '../server/regions/packs/cn/legal_work_product_quality';
import { legalDocumentProgress } from '../server/regions/packs/cn/legal_document_progress';
import { upsertUserPreferredLLM, getUserPreferredLLMConfig } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { parseDocument } from '../server/legal/parser';
import { bidStructuredReply } from './legal_bid_fixture';

let app: Awaited<ReturnType<typeof makeApp>>, directory: string;
const registry = new ToolRegistry(), userId = 'bid-source-registered-owner';
const promptOf = (params: any) => String(params.messages.find((message: any) => message.role === 'user')?.content || '');
const proposal = '这是根据所选原件形成的拟议方案，仅供责任人复核；未给资格、数量、签章及付款凭证保持待补，不能据此认定资格合格或正式递交。';
const args = () => ({ projectName, folderPath: directory, persistCase: false });
const originals = {
  clarification: 'C01：工作日4小时远程响应，到场时间未提供。',
  facts: '投标人虚构甲公司；许可证、履约记录和签章均未提供。BID-ORIGINAL-FACTS-28473',
  quote: '条目,未税,税额,含税\n服务,240000,14400,254400\n"带逗号,报价说明",待确认,待确认,待确认',
  missing: 'D01：专项资质原件未提供，不能认定已经满足。BID-ORIGINAL-MISSING-28473',
  schedule: '条目,阶段,期限\nT01,启动清点,5个工作日\nT02,培训,2次每次2小时',
};
let create: ReturnType<typeof vi.fn>, projectName = '';
const context = () => ({ userId, domain: 'personal', source: 'legal-direct-tool', authenticated: true, authRole: 'admin',
  localExecution: true, executionBoundary: 'trusted_local', llmGetters: { getRelay: () => ({ chat: { completions: { create } } }) } } as any);
const run = async (extra = {}) => decodeToolResult(await registry.execute('legal_generate_bid', { ...args(), ...extra }, context()));
const sourceBody = (content: string) => content.split('## 逐章生成进度')[0];
const bodyResponse = (params: any, mutate?: (value: any, prompt: string) => void) => {
  const prompt = promptOf(params), value = JSON.parse(bidStructuredReply(prompt, proposal));
  if (value.entries) mutate?.(value, prompt);
  return sdkCompletion(params, { choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
};

beforeAll(async () => {
  app = await makeApp(); registerLegalTools(registry);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-bid-source-'));
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 8; page++) pdf.addPage().drawText(page === 1 ? 'R01: supplied test scope, service only.' : page === 8 ? 'R25: original return requires authorization. TAIL-BID-PDF-SOURCE-892413' : 'Virtual supplied page ' + page, { size: 10 });
  fs.writeFileSync(path.join(directory, '01-tender.pdf'), await pdf.save());
  for (const [name, value] of Object.entries(originals)) fs.writeFileSync(path.join(directory, name + (name === 'quote' || name === 'schedule' ? '.csv' : '.txt')), value);

});
afterAll(() => { fs.rmSync(directory, { recursive: true, force: true }); app.cleanup(); });
beforeEach(() => {
  resetCircuit(); vi.stubEnv('LUMI_PRIVACY', 'standard'); projectName = '虚构来源绑定项目-' + crypto.randomUUID();
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  create = vi.fn(async (params: any) => bodyResponse(params));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit(); });

describe('registered bid tool compiles proposals against actual original sources', () => {
  it('reads six actual originals through the registry and SDK, derives actual directory and source coverage, and preserves DOCX body', async () => {
    const input = await readBidRequirementInput(args());
    expect(input.sources).toHaveLength(6); expect(input.materials).toHaveLength(6); expect(input.skipped).toEqual([]);
    const result = await run({ forceRegenerate: true });
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(6);
    const body = sourceBody(result.content), sources = buildMaterialSources(input.materials), chapters = quality.buildBidChapters(sources);
    for (const [params] of create.mock.calls) {
      expect(params).toMatchObject({ model: 'aliyun/deepseek-v4-flash', max_tokens: 16384, response_format: { type: 'json_object' } });
      if (promptOf(params).includes('待核对JSON草稿：')) continue;
      const actualSources = bidPromptSources(promptOf(params));
      expect(actualSources).toEqual(sources);
      for (const original of Object.values(originals)) for (const line of original.split('\n')) expect(actualSources.some((source: any) => source.quote === line)).toBe(true);
    }
    expect(body).toContain('1. 商务响应与报价 / 投标函工作稿');
    expect(body).toContain('### 投标函工作稿');
    expect(body).toContain('### 付款方案与拟议计算');
    expect(body).toContain('TAIL-BID-PDF-SOURCE-892413');
    expect(body).toContain(originals.clarification); expect(body).toContain(originals.missing);
    expect(body).toContain('已识别编号条目的来源绑定拟议响应：' + chapters[2].sections.length + '/' + chapters[2].sections.length);
    expect(body).toContain('所有内容仍待核验');
    expect(body).not.toContain('R2 | 待投标人'); expect(body).not.toContain('已核准付款计算');
    const artifact = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);
    const docx = await parseDocument(artifact);
    expect(docx?.text).toContain('投标函工作稿'); expect(docx?.text).toContain('TAIL-BID-PDF-SOURCE-892413');
    expect(docx?.text).toContain(originals.facts); expect(docx?.text).toContain(originals.schedule.split('\n').at(-1)!);
  });

  it.each(['unknown-source', 'duplicate-section', 'missing-section'])('rejects %s instead of declaring generated or caching model statements as originals', async invalid => {
    create.mockImplementation(async (params: any) => bodyResponse(params, value => {
      if (invalid === 'unknown-source') value.entries[0].sourceIds = ['MODEL-INVENTED-SOURCE'];
      if (invalid === 'duplicate-section') value.entries[1] = value.entries[0];
      if (invalid === 'missing-section') value.entries.pop();
    }));
    const result = await run({ forceRegenerate: true });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(sourceBody(result.content)).toContain('尚未取得章节正文');
    expect(sourceBody(result.content)).not.toContain('### 投标函工作稿');
    expect(result.content).not.toContain('MODEL-INVENTED-VERIFIED-FACT');
    expect(result.content).toContain(invalid === 'unknown-source' ? '复核校验未通过：第1项引用了未登记的原始材料编号' : invalid === 'duplicate-section' ? '起草校验未通过：第2项重复使用同一章节编号' : '起草校验未通过：工作稿章节数量不完整（要求3项，返回2项）'); expect(result.content).not.toContain('MODEL-INVENTED-SOURCE'); expect(result.content).toContain('接续复用 0 章');
    create.mockClear(); create.mockImplementation(async (params: any) => bodyResponse(params, (value, prompt) => {
      if (invalid === 'unknown-source' && prompt.includes('待核对JSON草稿：')) for (const entry of value.entries) entry.sourceIds = bidPromptSources(prompt).map((source: any) => source.id);
    }));
    expect((await run()).receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(invalid === 'unknown-source' ? 3 : 6);
    if(invalid==='unknown-source')for(const [request]of create.mock.calls)expect(promptOf(request)).toContain('待核对JSON草稿：');
  });

  it('compiles valid registered responses while ignoring unused facts and approval metadata', async () => {
    const marker = 'UNUSED-MODEL-APPROVAL-METADATA';
    create.mockImplementation(async (params: any) => bodyResponse(params, value => {
      value.notes = marker; value.verified = true;
      for (const entry of value.entries) { entry.facts = marker; entry.verified = true; entry.quote = marker; }
    }));
    const result = await run({ forceRegenerate: true });
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(create).toHaveBeenCalledTimes(6);
    expect(result.content).not.toContain(marker);
    expect(result.content).toContain('未作事实认定或核准');
    expect(result.content).toContain(originals.clarification);
    expect(result.content).toContain(originals.missing);
  });

  it('rejects a response that cites another real source instead of its own requirement, keeping coverage and partial truthfully separate', async () => {
    create.mockImplementation(async (params: any) => bodyResponse(params, (value, prompt) => {
      if (!prompt.includes('本次只输出“逐项')) return;
      const sources = bidPromptSources(prompt);
      value.entries[0].sourceIds = [sources.find((source: any) => source.id !== value.entries[0].sectionId).id];
    }));
    const result = await run({ forceRegenerate: true });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('接续复用 0 章'); expect(result.content).toContain('已识别编号条目的来源绑定拟议响应：0/');
    expect(result.content).toContain('逐项响应与偏差：正文未完成');
    expect(sourceBody(result.content)).toContain('### 投标函工作稿');
    create.mockClear(); create.mockImplementation(async (params:any)=>bodyResponse(params,(value,prompt)=>{
      if(prompt.includes('待核对JSON草稿：'))for(const entry of value.entries){const source=bidPromptSources(prompt).find((s:any)=>s.id===entry.sectionId);expect(source).toBeDefined();entry.sourceIds=[source.id];}
    }));
    const resumed = await run();
    expect(resumed.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(1);
    expect(promptOf(create.mock.calls[0][0])).toContain('待核对JSON草稿：');
  });

  it('does not reuse the previous free-text recipe and invalidates actual chapter instruction changes', async () => {
    const input = await readBidRequirementInput(args()), orgId = 'personal_' + userId;
    const preference = getUserPreferredLLMConfig(userId, { domain: 'personal' });
    const old = legalDocumentProgress(JSON.stringify({ recipe: 'bid-chapters-v1', userId, domain: 'personal', orgId,
      caseId: '', projectName: args().projectName, requirements: input.requirements, preference }), true);
    for (const id of ['business', 'technical', 'response']) old.save(id, 'OLD-FREE-TEXT-MUST-NOT-BECOME-NEW-ACCEPTANCE'.repeat(3), false);
    const result = await run();
    expect(create).toHaveBeenCalledTimes(6); expect(result.content).not.toContain('OLD-FREE-TEXT-MUST-NOT-BECOME-NEW-ACCEPTANCE');
    create.mockClear(); const original = quality.buildBidChapters;
    vi.spyOn(quality, 'buildBidChapters').mockImplementation(sources => original(sources).map(chapter => ({ ...chapter, instruction: chapter.instruction + '本次变更实际配方。' })));
    expect((await run()).receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(create).toHaveBeenCalledTimes(6);
  });

  it('recognizes generic original numbering without classifying letters and reports unnumbered source range honestly', () => {
    const text = 'AA17：项目服务范围原句。\n2.1）付款条件原句。\n三、交付约定原句。\n未编号背景材料，不能自动当作另一条招标要求。';
    const sources = buildMaterialSources([{ id: 'generic', title: '通用原件.txt', content: text }]);
    const chapters = quality.buildBidChapters(sources), response = chapters[2];
    expect(response.sections.map(section => section.title)).toEqual(['AA17：', '2.1）', '三、']);
    const entries = quality.resolveBidChapter({ entries: response.sections.map(section => ({
      sectionId: section.id, sourceIds: [section.id], response: proposal, missing: '来源仅说明条件，仍待责任人核验',
    })) }, sources, response);
    const report = quality.buildGroundedBidDraft('通用编号', text, sources, chapters, new Map([['response', entries]]));
    expect(report).toContain('已识别编号条目的来源绑定拟议响应：3/3');
    expect(report).toContain('未进入编号集合的原文段落：1/4');
    expect(report).toContain('F4（通用原件.txt；提供材料正文第4行）');
    expect(report).not.toContain('| R1 |');
  });

  it('reports the existing folder file limit as unread source instead of declaring a complete generated bid', async () => {
    const input = await readBidRequirementInput({ ...args(), maxFiles: 1 });
    expect(input.sources).toHaveLength(1);
    expect(input.skipped).toEqual([expect.stringContaining('仍有材料未读取')]);
    const result = await run({ maxFiles: 1, useModel: false });
    expect(create).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('文件数量超过本次读取上限 1');
    expect(result.content).toContain('## 未读取材料');
  });

  it('keeps unnumbered originals without inventing R1 and does not manufacture a bid letter in source-only mode', async () => {
    const result = await run({ requirements: '未编号原件：资料量、工期、报价和签章未提供。UNNUMBERED-BID-SOURCE-98321', folderPath: '', useModel: false });
    expect(create).not.toHaveBeenCalled();
    expect(result.content).toContain('UNNUMBERED-BID-SOURCE-98321');
    expect(sourceBody(result.content)).toContain('不据此断言全文件要求已逐项响应');
    expect(sourceBody(result.content)).toContain('尚未取得章节正文');
    expect(sourceBody(result.content)).not.toContain('### 投标函工作稿');
    expect(sourceBody(result.content)).not.toContain('| R1 |');
    expect(result.content).toContain('不计为模型完整标书验收通过');
  });
  it.each([
    { label: 'unique repeated source fields', names: ['虚构清泉项目', '虚构清泉项目'], numbers: ['BID-SOURCE-001', 'BID-SOURCE-001'], expectedName: '虚构清泉项目', expectedNumber: 'BID-SOURCE-001' },
    { label: 'conflicting source numbers', names: ['虚构清泉项目', '虚构清泉项目'], numbers: ['BID-SOURCE-001', 'BID-SOURCE-002'], expectedName: '虚构清泉项目', expectedNumber: '编号待核实' },
    { label: 'conflicting source names and numbers', names: ['虚构清泉项目', '虚构云桥项目'], numbers: ['BID-SOURCE-001', 'BID-SOURCE-002'], expectedName: '', expectedNumber: '编号待核实' },
  ])('binds the exported page header to $label without silently selecting a conflicting original', async sample => {
    const requirements = sample.names.map((name, index) => '项目名称：' + name + '\n项目编号：' + sample.numbers[index] + '\nR0' + (index + 1) + '：仅用于页眉来源验收，未作事实核准。').join('\n');
    const result = await run({ requirements, folderPath: '', useModel: false });
    expect(create).not.toHaveBeenCalled();
    expect(result.content).toContain('不计为模型完整标书验收通过');
    const artifact = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);
    const zip = await JSZip.loadAsync(fs.readFileSync(artifact));
    const headers = await Promise.all(zip.file(/^word\/header\d+\.xml$/).map(file => file.async('string')));
    const footers = await Promise.all(zip.file(/^word\/footer\d+\.xml$/).map(file => file.async('string')));
    expect(headers).toHaveLength(1); expect(footers).toHaveLength(1);
    expect(headers[0]).toContain(sample.expectedName || projectName); expect(headers[0]).toContain(sample.expectedNumber);
    if (!sample.expectedName) for (const name of new Set(sample.names)) expect(headers[0]).not.toContain(name);
    if (sample.expectedName) expect(headers[0]).not.toContain(projectName);
    if (sample.expectedNumber === '编号待核实') for (const number of sample.numbers) expect(headers[0]).not.toContain(number);
    expect(footers[0]).toMatch(/<w:instrText\b[^>]*>\s*PAGE\s*<\/w:instrText>/);
    const body = await zip.file('word/document.xml')!.async('string');
    for (const sourceText of [...new Set(sample.names), ...new Set(sample.numbers)]) expect(body).toContain(sourceText);
  });

  it.each([
    { requirement: 'R07：每页含项目名称、项目编号和“虚构验收草稿”。', expected: ['虚构验收草稿'] },
    { requirement: 'R07：每页不得包含“内部机密”。', expected: [] },
    { requirement: 'R07：每页注明“内部稿”。\nR08：每页注明“正式稿”。', expected: [] },
  ])('prints only a unique explicitly required page label: $requirement', async sample => {
    const result = await run({ requirements: '项目名称：虚构清泉项目\n项目编号：BID-LABEL-001\n' + sample.requirement, folderPath: '', useModel: false });
    expect(create).not.toHaveBeenCalled();
    const artifact = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);
    const zip = await JSZip.loadAsync(fs.readFileSync(artifact));
    const header = await zip.file(/^word\/header\d+\.xml$/)[0].async('string');
    expect(header).toContain('虚构清泉项目'); expect(header).toContain('BID-LABEL-001');
    for (const label of ['虚构验收草稿', '内部机密', '内部稿', '正式稿']) {
      if (sample.expected.includes(label)) expect(header).toContain(label);
      else expect(header).not.toContain(label);
    }
  });
});
