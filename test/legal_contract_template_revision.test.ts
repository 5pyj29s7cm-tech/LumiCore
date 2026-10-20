import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';

const userId = 'synthetic-nda-template-revision-owner';
const registry = new ToolRegistry();
const sections = ['主体与角色', '合同目的与范围', '双方权利义务', '履行与期限', '对价与费用适用性', '责任、终止与争议处理', '签署、生效与待确认事项'];
const original = '虚构星汐资料有限公司与虚构砚河评估有限公司的原完整工作稿。\n第一条：双方互负保密义务，合作无偿，不设付款、实物交付验收或担保义务。\n第二条：仅处理合作评估中披露且明确标示的保密资料；公开信息不在范围内，但因披露方违约导致公开的除外。\n第三条：保密期限为签署后两年。签署日期、签章代表和违约损失数额待双方确认。\n第四条：争议提交法院诉讼，具体地点待确认。\n第五条：未经许可不得向第三方披露；未明确标示资料不当然保密。';
const details = '保留原稿其他条款，仅删除公开信息排除的新增例外；保密期限仍为签署后两年；法院/仲裁尚未选择，应保留□诉讼 □仲裁[待双方确认]，不得预选。';
const bodies = [
  '虚构星汐资料有限公司与虚构砚河评估有限公司均为披露方与接收方，互负保密义务；登记情况未查验。',
  '仅处理合作评估中披露且明确标示的保密资料。公开信息不在范围内，不附新增例外；未明确标示资料不当然保密。',
  '未经许可不得向第三方披露，双方仅为合作评估使用保密资料，原稿其余用途与保护义务保留。',
  '保密期限为签署后两年。签署日期待双方确认，不改为披露后或终止后两年。',
  '合作无偿，不设付款、实物交付验收或担保义务；未增加费用和保证义务。',
  '争议解决保留□诉讼 □仲裁[待双方确认]，未选择法院或仲裁机构；具体地点和违约损失数额待双方确认。',
  '签署日期、签章代表和违约损失数额待双方确认；此工作稿未签署、未经主体或法条核准。',
];
let reply: any;
const create = vi.fn(async (request: any) => request.stream
  ? (async function* () { yield { choices: [{ delta: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }, finish_reason: 'stop' }] }; })()
  : { choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }, finish_reason: 'stop' }] });
const context = { userId, domain: 'personal' as const, authenticated: true, authRole: 'user' as const,
  localExecution: true, executionBoundary: 'trusted_local' as const, source: 'legal-direct-tool',
  llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
const ledgerSnapshot = () => { const file = path.join(getDataDirectory('org'), 'legal_cases.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
let sequence = 0;
const invoke = (extra: Record<string, any> = {}, signal?: AbortSignal) => registry.execute('legal_draft_contract', {
  type: '无偿双向保密协议', details, templateText: original, persistCase: false, ...extra,
}, { ...context, requestId: 'nda-template-revision-' + (++sequence), ...(signal ? { executionSignal: signal } : {}) });
const promptSources = () => {
  const prompt = create.mock.calls[0][0].messages.map((m: any) => String(m.content)).join('\n');
  return { prompt, sources: JSON.parse(prompt.match(/^原始材料：(.+)$/m)![1]) as Array<{ id: string; quote: string }> };
};
beforeAll(async () => {
  await initDatabase(); registerLegalTools(registry);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-nda-template-revision', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
});
beforeEach(() => {
  create.mockClear(); reply = { complete: true, entries: sections.map((id, index) => ({ sectionId: id, sourceIds: ['F2', 'F3'], response: bodies[index], missing: '' })) };
});
describe('existing contract tool revises a complete supplied NDA rather than requiring a construction template', () => {
  it('declares the existing complete-template amendment inputs without changing tool identity', () => {
    const tool = registry.get('legal_draft_contract')!;
    expect(tool.parameters.properties).toMatchObject({ templateText: { type: 'string' }, templatePath: { type: 'string' } });
    expect(tool.parameters.required).toEqual(['type']);
    expect(tool.description).toContain('修改');
  });
  it('sends the whole original and narrow amendments byte-for-byte to one real adapter call, retaining negative clauses and no archive', async () => {
    const before = ledgerSnapshot(), result = decodeToolResult(await invoke());
    expect(create).toHaveBeenCalledTimes(1);
    const { prompt, sources } = promptSources();
    expect(sources.find(item => item.id === 'F2')?.quote).toBe(details);
    expect(sources.find(item => item.id === 'F3')?.quote).toBe(original);
    expect(prompt).toContain('原用户要求保留范围与否定条件');
    expect(prompt).toContain('没有模板正文时不得声称使用官方示范文本');
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: false, artifacts: [] });
    for (const body of bodies) expect(result.content).toContain(body);
    expect(result.content).toContain('未归档（persistCase=false）');
    expect(result.content).not.toContain('未找到');
    expect(result.content).not.toContain('价款、期限、违约责任仍需人工补齐');
    expect(ledgerSnapshot()).toBe(before);
  });
  it('does not mutate an existing case when a supplied full-template amendment explicitly disables persistence', async () => {
    const workspace = cases.legalWorkspaceNamespace(userId);
    const item = cases.createCase(workspace, userId, { title: '虚构已有NDA局部修订案件' });
    const before = ledgerSnapshot();
    const result = decodeToolResult(await invoke({ caseId: item.id }));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: false });
    expect(cases.getCase(workspace, item.id, userId)!.materials).toHaveLength(0);
    expect(ledgerSnapshot()).toBe(before); expect(create).toHaveBeenCalledTimes(1);
  });
  it('uses an existing template file through the same parser without changing its bytes', async () => {
    const file = path.join(getDataDirectory('contract-fixtures'), 'complete-nda-original.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original, 'utf8'); const before = ledgerSnapshot();
    const result = decodeToolResult(await invoke({ templateText: '', templatePath: file }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(promptSources().sources.some(source => source.quote.includes(original))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: false });
    expect(ledgerSnapshot()).toBe(before);
  });
  it('blocks a partly unreadable template before a model call even when pasted text exists', async () => {
    const before = ledgerSnapshot();
    const result = decodeToolResult(await invoke({ templatePath: path.join(getDataDirectory('contract-fixtures'), 'missing-nda.txt') }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'blocked', persisted: false });
    expect(result.content).toContain('合同模板正文未完整读取');
    expect(create).not.toHaveBeenCalled(); expect(ledgerSnapshot()).toBe(before);
  });
  it.each(['not-json', 'missing-section', 'unknown-source', 'incomplete', 'empty-body'] as const)('keeps %s outside completed work and archives', async fault => {
    reply = fault === 'not-json' ? 'PRIVATE-MODEL-DIAGNOSTIC-NOT-FOR-USER'
      : fault === 'missing-section' ? { ...reply, entries: reply.entries.slice(1) }
      : fault === 'unknown-source' ? { ...reply, entries: reply.entries.map((entry: any) => ({ ...entry, sourceIds: ['F999'] })) }
      : fault === 'incomplete' ? { ...reply, complete: false }
      : { ...reply, entries: reply.entries.map((entry: any) => ({ ...entry, response: '# 标题' })) };
    const before = ledgerSnapshot(), result = decodeToolResult(await invoke());
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(result.content).not.toContain('PRIVATE-MODEL-DIAGNOSTIC-NOT-FOR-USER');
    expect(create).toHaveBeenCalledTimes(1); expect(ledgerSnapshot()).toBe(before);
  });
  it('does not rewrite a model semantic error into a compliant answer merely to pass input constraints', async () => {
    const wrong = '法院诉讼已经选定，公开信息也应保密。此为故意错误的模型夹具，法律语义验收必须拒绝。';
    reply.entries[5].response = wrong;
    const before = ledgerSnapshot(), result = decodeToolResult(await invoke());
    expect(result.content).toContain(wrong);
    expect(result.content).toContain('不代表正式核验通过');
    expect(create).toHaveBeenCalledTimes(1); expect(ledgerSnapshot()).toBe(before);
  });
  it('propagates cancellation before generation without writing the case or calling a provider', async () => {
    const before = ledgerSnapshot(), controller = new AbortController(); controller.abort();
    await expect(invoke({}, controller.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled(); expect(ledgerSnapshot()).toBe(before);
  });
});
