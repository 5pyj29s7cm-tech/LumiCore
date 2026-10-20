import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import * as Cases from '../server/org/legal_cases';
import { getDataDirectory } from '../server/config/data_path';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
beforeAll(async () => { app = await makeApp(); const { registerAllTools } = await import('../server/tools/definitions'); registerAllTools(registry); installCivilCodeFixture(); });
afterAll(() => app.cleanup());
beforeEach(() => { vi.stubEnv('TENDER_DATA_API_KEY', ''); vi.stubEnv('TENDER_DATA_BASE_URL', ''); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External network forbidden by fixture'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture() {
  const userId = 'two-tools-' + randomUUID(), orgId = Cases.legalWorkspaceNamespace(userId);
  const item = Cases.createCase(orgId, userId, { title: 'Synthetic shared tools', factDate: '2026-09-01', notes: 'Only a synthetic claim; original facts remain unverified.', party: 'Synthetic A / Synthetic B', cause: '买卖合同纠纷', court: '待确认' });
  Cases.addMaterial(orgId, userId, item.id, { source: 'manual', type: 'evidence', title: 'Original unverified source', content: 'Only the claimant alleges payment; originals and association are unverified. SOURCE-TAIL-881' });
  const context = { userId, domain: 'personal', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', source: 'legal-direct-tool' } as any;
  return { item, userId, orgId, context };
}
const run = (name: string, args: Record<string, any>, context: any) => executeToolCall({ registry, name, arguments: args, context });
function configure() { vi.stubEnv('TENDER_DATA_API_KEY', 'synthetic-tender-fixture'); vi.stubEnv('TENDER_DATA_BASE_URL', 'https://tender.invalid/search'); }
describe('the two existing Legal tools execute through Main full registration', () => {
  it('exposes both exact SDK declarations with explicit capability and evidence metadata', () => {
    const names = registry.getToolDeclarations().map(tool => tool.function.name);
    for (const name of ['legal_search_tender_projects', 'legal_verify_archived_delivery']) {
      expect(names.filter(value => value === name)).toHaveLength(1);
      const entry = registry.getCapabilityManifest().find(value => value.toolName === name)!;
      expect(entry.evidence?.declarationSource).toBe('tool_definition'); expect(entry.metadataSources.risk).toBe('tool_definition');
      expect((registry.get(name)!.parameters as any).properties).toHaveProperty('temporalReviews');
    }
  });
  it('calls the configured actual source mapping once and archives only its observed project', async () => {
    configure(); const f = fixture(), keyword = 'Unique project ' + randomUUID();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ items: [{ title: 'Observed synthetic project', projectNumber: 'SYN-91', purchaser: 'Synthetic Buyer', bidder: 'Synthetic Bidder', amount: '70000', publishDate: '2026-09-15', url: 'https://tender.invalid/notice/91' }] }), { status: 200 }));
    const result = await run('legal_search_tender_projects', { keyword, caseId: f.item.id, persistCase: true }, f.context);
    expect(result.receipt).toMatchObject({ ok: true, status: 'observed', persisted: true, changedCaseIds: [f.item.id] });
    expect(fetch).toHaveBeenCalledTimes(1); expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('keyword=');
    expect(result.result).toContain('Observed synthetic project'); expect(result.result).toContain('SYN-91'); expect(result.result).toContain('https://tender.invalid/notice/91');
    expect(result.result).toContain('仅凭中标公告不能认定债权真实存在');
    const saved = Cases.getCase(f.orgId, f.item.id, f.userId)!; expect(saved.materials).toHaveLength(2); expect(saved.materials.find(material => material.source === 'manual')?.content).toBe('Only the claimant alleges payment; originals and association are unverified. SOURCE-TAIL-881'); expect(saved.materials.find(material => material.source === 'tool')?.content).toContain('Observed synthetic project');
  });
  it.each(['unconfigured', 'empty', 'http-failed'])('keeps %s tender results partial without archiving a fabricated project or changing original materials', async mode => {
    const f = fixture(), originals = JSON.stringify(Cases.getCase(f.orgId, f.item.id, f.userId)!.materials);
    if (mode !== 'unconfigured') { configure(); vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(mode === 'empty' ? { items: [] } : { error: 'Synthetic authorization failure' }), { status: mode === 'empty' ? 200 : 401 })); }
    const result = await run('legal_search_tender_projects', { keyword: 'No observed source ' + randomUUID(), caseId: f.item.id, persistCase: true }, f.context);
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, changedCaseIds: [] }); expect(result.terminalVerification?.status).toBe('failed');
    expect(result.result).not.toContain('案件空间：已归档'); expect(result.result).toContain('待官网核验');
    expect(JSON.stringify(Cases.getCase(f.orgId, f.item.id, f.userId)!.materials)).toBe(originals);
    expect(fetch).toHaveBeenCalledTimes(mode === 'unconfigured' ? 0 : 1);
  });
  it('retains distinct tender queries sharing a long prefix in separate source-cache entries', async () => {
    configure(); const f = fixture(), prefix = 'Same very long project prefix '.repeat(10) + randomUUID(); let calls = 0;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [{ title: ++calls === 1 ? 'First observed project' : 'Second observed project' }] }), { status: 200 }));
    const first = await run('legal_search_tender_projects', { keyword: prefix + ' A', persistCase: false }, f.context);
    const second = await run('legal_search_tender_projects', { keyword: prefix + ' B', persistCase: false }, f.context);
    expect(first.result).toContain('First observed project'); expect(second.result).toContain('Second observed project'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects another owner case before tender network access or archive mutation', async () => {
    configure(); const own = fixture(), other = fixture(), before = JSON.stringify(Cases.getCase(other.orgId, other.item.id, other.userId));
    const result = await run('legal_search_tender_projects', { keyword: 'Forbidden owner', caseId: other.item.id, orgId: other.orgId, userId: other.userId, persistCase: true }, own.context);
    expect((result.receipt as { ok?: boolean } | undefined)?.ok).not.toBe(true); expect(result.result).not.toContain('SOURCE-TAIL-881'); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(Cases.getCase(other.orgId, other.item.id, other.userId))).toBe(before);
  });
  it('does not replace a requested archived report with another report or mistake missing law/court/review for approval', async () => {
    const f = fixture(); Cases.addMaterial(f.orgId, f.userId, f.item.id, { source: 'tool', type: 'contract', title: 'Synthetic target contract', content: 'No verified statutory citation. Lawyer review passed.' });
    Cases.addMaterial(f.orgId, f.userId, f.item.id, { source: 'tool', type: 'note', title: 'Unrelated asset report', content: 'Unrelated report must never substitute for requested contract.' });
    const missing = await run('legal_verify_archived_delivery', { caseId: f.item.id, materialTitle: 'Different exact requested report', persistCase: false }, f.context);
    expect(missing.result).toContain('未找到与请求名称匹配'); expect(missing.result).not.toContain('核验材料：Unrelated asset report'); expect(missing.result).toContain('不可正式交付');
    const target = await run('legal_verify_archived_delivery', { caseId: f.item.id, materialTitle: 'Synthetic target contract', persistCase: false }, f.context);
    expect(target.receipt).toMatchObject({ ok: true, status: 'verified', persisted: false }); expect(target.result).toContain('核验材料：Synthetic target contract');
    expect(target.result).toMatch(/引用与法源状态\n- 阻断/); expect(target.result).toMatch(/管辖信息\n- 阻断/); expect(target.result).toMatch(/律师复核边界\n- 待确认/); expect(target.result).toContain('不可正式交付'); expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps archived material ownership and original fact date authoritative for verification', async () => {
    const own = fixture(), other = fixture(); Cases.addMaterial(other.orgId, other.userId, other.item.id, { source: 'tool', type: 'contract', title: 'PRIVATE-OTHER-CONTRACT', content: 'Private source not accessible.' });
    const denied = await run('legal_verify_archived_delivery', { caseId: other.item.id, orgId: other.orgId, userId: other.userId, materialTitle: 'PRIVATE-OTHER-CONTRACT', persistCase: false }, own.context);
    expect((denied.receipt as { ok?: boolean } | undefined)?.ok).not.toBe(true); expect(denied.result).not.toContain('核验材料：PRIVATE-OTHER-CONTRACT');
    const material = Cases.addMaterial(own.orgId, own.userId, own.item.id, { source: 'tool', type: 'contract', title: 'Saved date contract', content: '依据《民法典》第585条核对违约金。' })!;
    const conflict = await run('legal_verify_archived_delivery', { caseId: own.item.id, materialTitle: material.title, factDate: '2019-01-01', persistCase: false }, own.context);
    expect(conflict.receipt).toMatchObject({ ok: false, status: 'blocked' }); expect(Cases.getCase(own.orgId, own.item.id, own.userId)?.factDate).toBe('2026-09-01');
    const verified = await run('legal_verify_archived_delivery', { caseId: own.item.id, materialTitle: material.title, persistCase: false }, own.context);
    expect(verified.result).toMatch(/引用与法源状态\n- 通过/); expect(verified.result).toContain('律师核准记录待确认');
  });
  it('reads the existing human review owner and marks it stale after the actual archived file bytes change', async () => {
    const f = fixture(), file = path.join(getDataDirectory('parity-files'), f.item.id + '.txt');
    fs.writeFileSync(file, 'Synthetic original delivery bytes');
    const material = Cases.addMaterial(f.orgId, f.userId, f.item.id, { source: 'tool', type: 'contract', title: 'Version-bound archived contract', content: '依据《民法典》第585条核对违约金。', localPath: file })!;
    const revision = Cases.getMaterialReview(f.orgId, f.userId, f.item.id, material.id)!.revision;
    Cases.recordMaterialReview(f.orgId, f.userId, f.item.id, material.id, { expectedRevision: revision, decision: 'confirmed' });
    const confirmed = await run('legal_verify_archived_delivery', { caseId: f.item.id, materialTitle: material.title, persistCase: false }, f.context);
    expect(confirmed.result).toContain('本版本人工复核记录已确认'); expect(confirmed.result).not.toContain('自动认定可正式交付。\n');
    fs.writeFileSync(file, 'Synthetic changed delivery bytes');
    const stale = await run('legal_verify_archived_delivery', { caseId: f.item.id, materialTitle: material.title, persistCase: false }, f.context);
    expect(stale.result).toContain('旧人工复核记录不适用于当前版本'); expect(stale.result).toContain('不可正式交付');
  });
});
