import './helpers';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import { buildBidChapters } from '../server/regions/packs/cn/legal_work_product_quality';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bidStructuredReply, sdkCompletion } from './legal_bid_fixture';
import { getDataDirectory } from '../server/config/data_path';
import { generateBidHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getUserPreferredLLM, upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import * as cases from '../server/org/legal_cases';
vi.mock('../server/llm/local_models', async original => ({ ...await original<typeof import('../server/llm/local_models')>(), ensureLocalModelReady: vi.fn(async () => ({})), runLocalModelInference: vi.fn(async (_provider, operation) => operation()) }));
vi.mock('../server/llm/local_model_capacity', async original => ({ ...await original<typeof import('../server/llm/local_model_capacity')>(), loadedLocalContextTokens: vi.fn(async () => 32768) }));
const original = 'R01【范围】仅为虚构验收，服务条款、主体资格与原件真实性均待核实；不得生成提交或签章证明。';
const proposed = '本节为虚构材料的条件响应，引用完整原句，不认定资格、事实、法律或投标已核准；未提供证明仍待补，不作新付款和期限承诺。';
const promptOf = (request: any) => String(request.messages.find((message: any) => message.role === 'user')?.content || '');
const ledgerSnapshot = () => { const file = path.join(getDataDirectory('org'), 'legal_cases.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
beforeAll(async () => { await (await import('../db_layer')).initDatabase(); });
beforeEach(() => { vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit(); });
function setup(localOnly = false, delayMs = 0) {
  const userId = 'bid-effort-' + crypto.randomUUID();
  upsertUserPreferredLLM(userId, { provider: localOnly ? 'lmstudio' : 'relay', model: localOnly ? 'synthetic-loaded-local' : 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const create = vi.fn((request: any, options: any) => sdkCompletion(request, { choices: [{ message: { content: bidStructuredReply(promptOf(request), proposed) }, finish_reason: 'stop' }] }, delayMs, options.signal));
  const cloud = vi.fn(() => ({ chat: { completions: { create } } }));
  const local = vi.fn(() => ({ chat: { completions: { create } } }));
  const context = { userId, domain: 'personal', source: 'legal-direct-tool', ...(localOnly ? { dataRoutingPolicy: 'local_only' as const } : {}),
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, ...(localOnly ? { getRelay: cloud, getLmStudio: local } : { getRelay: cloud }) } };
  const args = { projectName: '虚构标书低推理传递-' + userId, requirements: original, persistCase: false, useModel: true };
  return { userId, create, cloud, local, context, args };
}
describe('existing bid phases retain the bounded structured profile and configured model', () => {
  it('uses the same user model with the restored bounded bid effort for both draft and review, preserving streamed JSON and one six-phase pass', async () => {
    const f = setup(), before = JSON.stringify(getUserPreferredLLM(f.userId)), ledger = ledgerSnapshot();
    const result = decodeToolResult(await generateBidHandler(f.args, f.context));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(f.create).toHaveBeenCalledTimes(6);
    const requests = f.create.mock.calls.map(([request]) => request);
    expect(requests.filter(request => promptOf(request).includes('待核对JSON草稿：'))).toHaveLength(3);
    expect(requests.filter(request => promptOf(request).includes('本次只输出“'))).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({ model: 'aliyun/deepseek-v4-flash', reasoning_effort: 'low', max_tokens: 16384, stream: true, response_format: { type: 'json_object' } });
      expect(request.thinking?.type).not.toBe('disabled');
      expect(promptOf(request)).toContain(original);
    }
    expect(JSON.stringify(getUserPreferredLLM(f.userId))).toBe(before);
    expect(ledgerSnapshot()).toBe(ledger);
  });
  it('retains all164 original paragraphs and56 targets through the actual fourteen-phase SDK and decoder while grouping only metadata', async () => {
    const f = setup();
    const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/legal_bid_six_materials_164.json'), 'utf8'));
    const directory = getDataDirectory(path.join('synthetic-bid-six-sources', f.userId));
    const materials = fixture.materials.map((material: any, index: number) => {
      const filename = String(index + 1).padStart(2, '0') + '-synthetic-original.txt';
      fs.writeFileSync(path.join(directory, filename), material.content, 'utf8');
      return { id: String(index + 1), title: '招标文件 ' + filename, content: material.content };
    });
    const originals = buildMaterialSources(materials); expect(originals).toHaveLength(164); expect(buildBidChapters(originals)[2].sections).toHaveLength(56);
    const result = decodeToolResult(await generateBidHandler({ ...f.args, requirements: undefined, filePaths: materials.map((_: any, index: number) => path.join(directory, String(index + 1).padStart(2, '0') + '-synthetic-original.txt')), maxChars: 60_000 }, f.context));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(result.content).toContain('56/56 项'); expect(f.create).toHaveBeenCalledTimes(14);
    for (const [request] of f.create.mock.calls) {
      const prompt = promptOf(request), grouped = JSON.parse(prompt.split('\n原始材料：')[1].split(/\n(?:本次只输出|待核对JSON草稿：)/)[0]);
      expect(grouped).toHaveLength(6);
      const restored = grouped.flatMap((material: any) => material.paragraphs.map((paragraph: any) => ({ id: paragraph.id, materialId: material.materialId, title: material.title, quote: paragraph.quote, locator: paragraph.locator })));
      expect(restored).toEqual(originals); expect(JSON.stringify(grouped).length).toBeLessThan(JSON.stringify(originals).length);
      if (prompt.includes('待核对JSON草稿：')) {
        const draft = prompt.split('待核对JSON草稿：')[1]; expect(draft).toBe(JSON.stringify(JSON.parse(draft)));
      }
    }
    for (let index = 0; index < materials.length; index++) expect(fs.readFileSync(path.join(directory, String(index + 1).padStart(2, '0') + '-synthetic-original.txt'), 'utf8')).toBe(fixture.materials[index].content);
  });
  it.each([undefined, 'high'] as const)('keeps the existing default/explicit helper effort=%s on the real installed SDK wire', async effort => {
    const f = setup(); const wire: any[] = [];
    const fetch = vi.fn(async (_url: any, init: any) => { const body=JSON.parse(init.body); wire.push(body); const chunk=(content: string | null, finish: string | null)=>({id:'synthetic-sdk',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:content===null?{}:{content},finish_reason:finish}]}); return new Response('data: '+JSON.stringify(chunk('{"ok":true}',null))+'\n\ndata: '+JSON.stringify(chunk(null,'stop'))+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}}); });
    const sdk = new OpenAI({apiKey:'synthetic-offline-only',baseURL:'https://synthetic.invalid/v1',maxRetries:0,fetch:fetch as any});
    const result = await runLegalLLM('只作默认法律调用参数回归，不生成真实法律结论。', { ...f.context, llmGetters: { ...f.context.llmGetters, getRelay: () => sdk } }, 128, true, 180_000, effort);
    expect(result).toBe('{"ok":true}'); expect(fetch).toHaveBeenCalledOnce(); expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({model:'aliyun/deepseek-v4-flash',max_tokens:128,stream:true,response_format:{type:'json_object'}});
    if(effort)expect(wire[0].reasoning_effort).toBe(effort);else expect(wire[0]).not.toHaveProperty('reasoning_effort');
    expect(wire[0]).not.toHaveProperty('thinking');
  });
  it('keeps local_only on the local adapter without a cloud request or unsupported effort parameter', async () => {
    const f = setup(true), before = JSON.stringify(getUserPreferredLLM(f.userId));
    const result = decodeToolResult(await generateBidHandler(f.args, f.context));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(f.create).toHaveBeenCalledTimes(6); expect(f.cloud).not.toHaveBeenCalled(); expect(f.local).toHaveBeenCalled();
    for (const [request] of f.create.mock.calls) { expect(request.model).toBe('synthetic-loaded-local'); expect(request).not.toHaveProperty('reasoning_effort'); expect(promptOf(request)).toContain(original); }
    expect(JSON.stringify(getUserPreferredLLM(f.userId))).toBe(before);
  });
  it('honors the original caller cancellation with no retry, completed DOCX or case archive', async () => {
    const f = setup(false, 70_000), controller = new AbortController(), orgId = cases.legalWorkspaceNamespace(f.userId);
    const item = cases.createCase(orgId, f.userId, { title: '虚构取消预算验收' }); vi.useFakeTimers();
    const pending = generateBidHandler({ ...f.args, caseId: item.id, persistCase: true }, { ...f.context, executionSignal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000); controller.abort(new Error('Synthetic bid owner cancellation')); await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(Error); expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
    expect(cases.getCase(orgId, item.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  });
});
