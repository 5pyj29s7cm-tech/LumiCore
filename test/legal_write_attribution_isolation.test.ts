import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import * as EDB from '../server/org/db';
import * as Cases from '../server/org/legal_cases';
import { createLegalArticle } from '../server/legal/kb';
import { legalExecutionContext, legalExecutionSignal, legalWrite } from '../server/legal/execution';
import { defineLegalTool, legalCapability, withLegalReceipt } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

beforeAll(async () => { await initDatabase(); });
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function scope() {
  const userId = 'write-owner-' + randomUUID();
  const org = EDB.createOrg('Synthetic write attribution', 'scope-' + randomUUID(), userId);
  EDB.addMember(org.id, userId, 'owner');
  return { orgId: org.id, userId };
}
function context(s: ReturnType<typeof scope>, signal?: AbortSignal): ToolContext {
  const requestId = 'request-' + randomUUID();
  return { ...s, domain: 'work', requestId, taskId: 'task-' + randomUUID(), turnId: requestId,
    authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local',
    executionSignal: signal, allowLocalFileWrites: true, actionIntent: 'Archive the synthetic case and its local knowledge note.',
    routedTaskText: 'Archive the synthetic case and its local knowledge note.' } as ToolContext;
}
function register(registry: ToolRegistry, name: string, handler: (args: Record<string, any>, context?: ToolContext) => Promise<string>,
  profile: Parameters<typeof withLegalReceipt>[1] = { status: 'archived', expectCaseMutation: 'always' }) {
  registry.register(defineLegalTool({ name, description: 'Offline real-write attribution boundary',
    properties: { orgId: { type: 'string' }, userId: { type: 'string' } }, required: ['orgId', 'userId'],
    handler: withLegalReceipt(handler, profile), capability: legalCapability({ id: 'test.' + name, operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'synthetic owned case and legal article', reversible: true }], successStatuses: ['archived'] }) }));
}
async function call(registry: ToolRegistry, name: string, s: ReturnType<typeof scope>, c = context(s)) {
  return executeToolCall({ registry, name, id: name + '-' + randomUUID(), arguments: { ...s }, context: c });
}
function assertReal(record: ToolExecutionRecord) { expect(isCanonicalToolExecutionRecord(record)).toBe(true); expect(record.adapterStarted).toBe(true); }
function observe(name: string, data: unknown) { if (process.env.PROBE_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.PROBE_EVIDENCE_DIR, name + '.json'), JSON.stringify(data, null, 2)); }
const material = { type: 'evidence' as const, title: 'Synthetic payment note', content: 'Only a virtual receipt; not a confirmed debt.', source: 'tool' as const };

describe('registered legal write ownership', () => {
  it('does not credit no-write A with concurrent real-write B in the same organization and user', async () => {
    const s = scope(), registry = new ToolRegistry(), entered = gate(), release = gate();
    let bCase!: Cases.OrgLegalCaseFile, bArticle!: ReturnType<typeof createLegalArticle>;
    const aHandler = vi.fn(async () => { entered.resolve(); await release.promise; return 'Synthetic A performed no write.'; });
    const bHandler = vi.fn(async () => {
      bCase = legalWrite(() => Cases.createCase(s.orgId, s.userId, { title: 'Synthetic B case' }));
      legalWrite(() => Cases.addMaterial(s.orgId, s.userId, bCase.id, material));
      bArticle = legalWrite(() => createLegalArticle(s.orgId, s.userId, { title: 'Synthetic B note', content: 'B wrote this actual local note.', articleType: 'case_material' }));
      return 'Synthetic B archived its case and note.';
    });
    register(registry, 'legal_attribution_a', aHandler, { status: 'archived', expectCaseMutation: 'always', requireArticleMutation: true });
    register(registry, 'legal_attribution_b', bHandler, { status: 'archived', expectCaseMutation: 'always', requireArticleMutation: true });
    const pendingA = call(registry, 'legal_attribution_a', s);
    await Promise.race([entered.promise, pendingA.then(record => { throw new Error('A did not reach its real handler: ' + record.error); })]);
    const b = await call(registry, 'legal_attribution_b', s); release.resolve(); const a = await pendingA;
    observe('concurrent-a-no-write-b-real-write', { a, b, bCaseId: bCase?.id, bArticleId: bArticle?.id, persistedCase: bCase && Cases.getCase(s.orgId, bCase.id, s.userId), persistedArticle: bArticle && EDB.listKbArticles(s.orgId).find(row => row.id === bArticle.id) });
    expect(aHandler).toHaveBeenCalledTimes(1); expect(bHandler).toHaveBeenCalledTimes(1); assertReal(a); assertReal(b);
    expect(b.envelope?.status).toBe('verified_success'); expect(b.receipt).toMatchObject({ persisted: true, changedCaseIds: [bCase.id], articleIds: [bArticle.id] });
    expect(Cases.getCase(s.orgId, bCase.id, s.userId)?.materials).toHaveLength(1);
    expect(EDB.listKbArticles(s.orgId).map(row => row.id)).toContain(bArticle.id);
    expect(a.envelope?.status).toBe('failed');
    expect(a.error).toContain('not persisted to the requested case workspace');
    expect((a.receipt as any)?.changedCaseIds || []).not.toContain(bCase.id);
    expect((a.receipt as any)?.articleIds || []).not.toContain(bArticle.id);
  });

  it('attributes a real update, newly added material and article to only this registered attempt', async () => {
    const s = scope(), registry = new ToolRegistry();
    const earlier = Cases.createCase(s.orgId, s.userId, { title: 'Earlier case outside the attempt' });
    const target = Cases.createCase(s.orgId, s.userId, { title: 'Synthetic target' });
    let added!: Cases.OrgLegalCaseMaterial, article!: ReturnType<typeof createLegalArticle>;
    register(registry, 'legal_attribution_positive', async (_args, owner) => {
      expect(legalExecutionContext()).toBe(owner);
      legalWrite(() => Cases.updateCase(s.orgId, s.userId, target.id, { title: 'Actually updated target' }));
      added = legalWrite(() => Cases.addMaterial(s.orgId, s.userId, target.id, material))!;
      article = legalWrite(() => createLegalArticle(s.orgId, s.userId, { title: 'Actual local knowledge note', content: 'Synthetic positive content.', articleType: 'case_material' }));
      return 'The synthetic local material and article were archived.';
    }, { status: 'archived', expectCaseMutation: 'always', requireArticleMutation: true });
    const result = await call(registry, 'legal_attribution_positive', s); assertReal(result);
    expect(result.envelope?.status).toBe('verified_success');
    expect(result.receipt).toMatchObject({ ok: true, persisted: true, changedCaseIds: [target.id], articleIds: [article.id] });
    expect((result.receipt as any).changedCaseIds).not.toContain(earlier.id);
    const actual = Cases.getCase(s.orgId, target.id, s.userId)!;
    expect(actual.title).toBe('Actually updated target'); expect(actual.materials.map(row => row.id)).toEqual([added.id]);
    const sourceDigest = createHash('sha256').update(JSON.stringify([added.source, added.title, added.content, added.fileName || '', added.localPath || ''])).digest('hex');
    expect((result.receipt as any).materialSources).toEqual([{ caseId: target.id, materialId: added.id, sourceDigest }]);
  });

  it('restores parent ownership after a real nested registered legal call without crediting child writes', async () => {
    const s = scope(), registry = new ToolRegistry(); let parentCase!: Cases.OrgLegalCaseFile, childCase!: Cases.OrgLegalCaseFile, childArticle!: ReturnType<typeof createLegalArticle>, child!: ToolExecutionRecord;
    register(registry, 'legal_attribution_child', async () => {
      childCase = legalWrite(() => Cases.createCase(s.orgId, s.userId, { title: 'Nested child case' }));
      childArticle = legalWrite(() => createLegalArticle(s.orgId, s.userId, { title: 'Nested child article', content: 'Child actual write.', articleType: 'case_material' }));
      return 'Child local archive exists.';
    }, { status: 'archived', expectCaseMutation: 'always', requireArticleMutation: true });
    register(registry, 'legal_attribution_parent', async (_args, owner) => {
      expect(legalExecutionContext()).toBe(owner);
      parentCase = legalWrite(() => Cases.createCase(s.orgId, s.userId, { title: 'Parent actual case' }));
      child = await call(registry, 'legal_attribution_child', s, owner);
      expect(legalExecutionContext()).toBe(owner);
      legalWrite(() => Cases.addMaterial(s.orgId, s.userId, parentCase.id, material));
      return 'Parent local archive exists.';
    });
    const parent = await call(registry, 'legal_attribution_parent', s); assertReal(parent); assertReal(child);
    expect(parent.envelope?.status).toBe('verified_success'); expect(child.envelope?.status).toBe('verified_success');
    expect(parent.receipt).toMatchObject({ changedCaseIds: [parentCase.id], articleIds: [] });
    expect(child.receipt).toMatchObject({ changedCaseIds: [childCase.id], articleIds: [childArticle.id] });
    expect((parent.receipt as any).materialSources.map((row: any) => row.caseId)).toEqual([parentCase.id]);
    expect(legalExecutionContext()).toBeUndefined();
  });

  it('keeps separate users and organizations out of a real overlapping receipt', async () => {
    const aScope = scope(), bScope = scope(), registry = new ToolRegistry(), entered = gate(), release = gate();
    let aCase!: Cases.OrgLegalCaseFile, bCase!: Cases.OrgLegalCaseFile;
    register(registry, 'legal_attribution_scope_a', async () => { aCase = legalWrite(() => Cases.createCase(aScope.orgId, aScope.userId, { title: 'Scope A' })); entered.resolve(); await release.promise; return 'A archive exists.'; });
    register(registry, 'legal_attribution_scope_b', async () => { bCase = legalWrite(() => Cases.createCase(bScope.orgId, bScope.userId, { title: 'Scope B' })); return 'B archive exists.'; });
    const pendingA = call(registry, 'legal_attribution_scope_a', aScope); await entered.promise;
    const b = await call(registry, 'legal_attribution_scope_b', bScope); release.resolve(); const a = await pendingA;
    expect(a.receipt).toMatchObject({ changedCaseIds: [aCase.id] }); expect(b.receipt).toMatchObject({ changedCaseIds: [bCase.id] });
    expect(Cases.getCase(aScope.orgId, bCase.id, aScope.userId)).toBeNull();
  });

  it('retains the original attempt signal and prevents a real late write after cancellation', async () => {
    const s = scope(), registry = new ToolRegistry(), controller = new AbortController(), entered = gate(), release = gate(); const write = vi.fn(() => Cases.createCase(s.orgId, s.userId, { title: 'Must not be written' }));
    register(registry, 'legal_attribution_cancel', async (_args, owner) => {
      expect(legalExecutionContext()).toBe(owner);
      const signal = legalExecutionSignal(); expect(signal).toBe(owner?.executionSignal); expect(signal?.aborted).toBe(false);
      entered.resolve(); await release.promise; expect(signal?.aborted).toBe(true); legalWrite(write); return 'Must never report this write.';
    });
    const pending = call(registry, 'legal_attribution_cancel', s, context(s, controller.signal));
    await Promise.race([entered.promise, pending.then(record => { throw new Error('Cancelled-attempt handler did not enter: ' + record.error); })]);
    controller.abort(new DOMException('Synthetic cancellation', 'AbortError')); release.resolve(); const result = await pending;
    assertReal(result); expect(write).not.toHaveBeenCalled(); expect(result.envelope?.status).toBe('failed');
    expect(Cases.listCases(s.orgId, '', 20, s.userId)).toEqual([]); expect(legalExecutionContext()).toBeUndefined();
  });

  it('does not invent rollback or a successful receipt when cancellation follows an actual committed write', async () => {
    const s = scope(), registry = new ToolRegistry(), controller = new AbortController(), entered = gate(), release = gate(); let created!: Cases.OrgLegalCaseFile;
    register(registry, 'legal_attribution_after_write_cancel', async () => {
      created = legalWrite(() => Cases.createCase(s.orgId, s.userId, { title: 'Committed before cancellation' })); entered.resolve(); await release.promise; return 'Late text cannot settle success.';
    });
    const pending = call(registry, 'legal_attribution_after_write_cancel', s, context(s, controller.signal)); await entered.promise;
    controller.abort(new DOMException('Synthetic cancellation after write', 'AbortError')); release.resolve(); const result = await pending;
    assertReal(result); expect(Cases.getCase(s.orgId, created.id, s.userId)?.title).toBe('Committed before cancellation');
    expect(result.envelope?.status).toBe('failed'); expect(result.receipt).toBeUndefined();
  });
});
