import { bidPromptSources } from './legal_bid_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { buildMaterialSources, resolveSourceDraftEntries, resolveMaterialOutline, resolveReasoningEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>, folder: string;
beforeAll(async () => { app = await makeApp(); folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-failure-stages-')); });
afterAll(() => { fs.rmSync(folder, { recursive: true, force: true }); app.cleanup(); });
afterEach(() => vi.restoreAllMocks());
const proposal = 'This synthetic proposal uses only supplied originals; missing supporting documents, dates, conditions and approvals remain subject to confirmation.';
const privateDetail = 'PRIVATE_PROVIDER_OR_MODEL_DETAIL_MUST_NOT_LEAK';
type Mode = 'pass' | 'request' | 'empty' | 'json' | 'source' | 'save' | 'review-request' | 'review-json' | 'review-save';
function fixture(count: number, mode: Mode = 'pass') {
  const userId = 'bid-stage-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-stage-model', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const item = cases.createCase(orgId, userId, { title: 'Synthetic bid stage case' });
  const original = Array.from({ length: count }, (_, index) => (index === 0 ? 'R01：' : '材料原句 ') + 'Supplied original ' + (index + 1) + ' retained; unknown matters require confirmation.').join('\n');
  const file = path.join(folder, crypto.randomUUID() + '.txt'); fs.writeFileSync(file, original);
  const plan = { mode }; const events: string[] = [];
  const create = vi.fn(async (params: any) => {
    const prompt = String(params.messages.find((m: any) => m.role === 'user')?.content || ''); const review = prompt.includes('待核对JSON草稿：');
    const draft = review ? JSON.parse(prompt.split('待核对JSON草稿：')[1]) : null;
    const sections = review ? draft.entries : JSON.parse(prompt.split('\n指定子节：')[1]);
    const business = review ? sections[0].sectionId === 'bid-letter' : prompt.includes('本次只输出“商务'); events.push((review ? 'review-' : 'draft-') + (business ? 'business' : review ? sections[0].sectionId : sections[0].id));
    if (business && ((!review && plan.mode === 'request') || (review && plan.mode === 'review-request'))) throw new Error(privateDetail);
    let content: string | null = review ? JSON.stringify({ complete: true, entries: draft.entries, unresolved: [] }) : JSON.stringify({ entries: sections.map((section: any) => ({ sectionId: section.id, sourceIds: bidPromptSources(prompt).map((source: any) => source.id), response: proposal, missing: 'Documents and qualifications remain to be checked.' })) });
    if (business && ((!review && plan.mode === 'json') || (review && plan.mode === 'review-json'))) content = '{' + privateDetail;
    if (business && !review && plan.mode === 'empty') content = null;
    if (business && !review && plan.mode === 'source') { const value = JSON.parse(content!); value.entries[0].sourceIds = [privateDetail]; content = JSON.stringify(value); }
    return sdkCompletion(params, { choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  if (mode === 'save' || mode === 'review-save') { const rename = fs.renameSync; vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => { if (String(newPath).includes('legal_document_progress')) { const data = JSON.parse(fs.readFileSync(String(oldPath), 'utf8')); if (data.documents.business && data.documents.business.reviewed === (mode === 'review-save')) throw new Error(privateDetail); } return rename(oldPath, newPath); }); }
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const context: import('../server/tools/types').ToolContext = { userId, domain: 'personal', requestId: crypto.randomUUID(), authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = () => registry.execute('legal_generate_bid', { projectName: 'Synthetic-' + item.id, caseId: item.id, filePath: file, persistCase: true }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
  return { userId, orgId, item, original, file, create, events, plan, run };
}
describe('bid existing source projection and honest failure stages', () => {
  it.each([31, 164])('accepts all %i actual original lines through registry, SDK draft/review, checkpoint and reuse', async count => {
    const f = fixture(count); const result = await f.run(); expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(f.create).toHaveBeenCalledTimes(6); expect(f.events.filter(event => event.startsWith('review-'))).toHaveLength(3);
    expect(result.content).toContain('Supplied original ' + count + ' retained'); expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(1);
    f.create.mockClear(); const resumed = await f.run(); expect(resumed.receipt).toMatchObject({ ok: true }); expect(resumed.content).toContain('接续复用 3 章'); expect(f.create).not.toHaveBeenCalled();
  });
  it('still rejects unknown/empty references and wrong sections, and deduplicates real references without changing source bytes', () => {
    const sources = buildMaterialSources([{ id: 'supplied-original', title: 'Synthetic originals', content: Array.from({ length: 164 }, (_, i) => 'Actual original line ' + (i + 1)).join('\n') }]);
    const entry = { sectionId: 'section', sourceIds: sources.map(s => s.id), response: proposal, missing: '' };
    for (const invalid of [{ ...entry, sourceIds: [] }, { ...entry, sourceIds: ['invented'] }, { ...entry, sectionId: 'wrong' }]) expect(() => resolveSourceDraftEntries({ entries: [invalid] }, sources, ['section'])).toThrow();
    expect(() => resolveMaterialOutline({ entries: [{ issue: 'Synthetic issue', sourceIds: entry.sourceIds }] }, sources)).toThrow();
    expect(resolveReasoningEntries({ entries: [{ issue: 'Synthetic issue', ruleId: 'R1', sourceIds: entry.sourceIds, application: proposal, conclusion: proposal, limitations: proposal }] }, { sources, rules: [{ id: 'R1', citation: 'Synthetic test rule only', quote: 'Not a verified actual statute.' }] }).errors.length).toBeGreaterThan(0);
    const result = resolveSourceDraftEntries({ entries: [{ ...entry, sourceIds: [...entry.sourceIds, sources[0].id] }] }, sources, ['section']); expect(result[0].sources).toHaveLength(164); for (let index = 0; index < sources.length; index++) expect(result[0].sources[index]).toBe(sources[index]);
  });
  it.each([['request', '起草请求失败'], ['empty', '起草返回空正文'], ['json', '起草 JSON 解析失败'], ['source', '复核校验未通过：第1项引用了未登记的原始材料编号'], ['save', '起草进度保存失败'], ['review-request', '复核请求失败'], ['review-json', '复核 JSON 解析失败'], ['review-save', '复核进度保存失败']] as const)('reports known %s control-flow stage without private details or fake archival', async (mode, expected) => {
    const f = fixture(31, mode); const result = await f.run(); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(result.content).toContain(expected); expect(result.content).not.toContain(privateDetail); expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    expect(f.create).toHaveBeenCalledTimes(mode === 'save' ? 3 : mode === 'review-save' ? 5 : ['request', 'empty', 'json'].includes(mode) ? 5 : 6); expect(result.content).toContain('Supplied original 31 retained');
  });
});
