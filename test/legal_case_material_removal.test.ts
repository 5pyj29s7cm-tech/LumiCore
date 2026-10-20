import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { issueDesktopSessionProof, DESKTOP_SESSION_HEADER } from '../server/config/desktop_bootstrap';
import * as cases from '../server/org/legal_cases';
import * as kb from '../server/org/kb';
import { addMember, createOrg, listAuditLog } from '../server/org/db';
import { setOrganizationResourcePolicy } from '../server/org/resource_acl';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
let app: Awaited<ReturnType<typeof makeApp>>;
const owner = 'material-remove-owner', other = 'material-remove-other', viewer = 'material-remove-viewer';
const identity = { schemaVersion: 1 as const, clientKind: 'local_acceptance_harness' as const, pid: process.pid,
  startedAtUnixMs: Date.now() - 1000, executablePath: process.execPath, executableSha256: 'd'.repeat(64),
  binaryHashUnavailable: false, buildId: 'c'.repeat(40), buildIdSemantics: 'baseline_commit' as const,
  sourceFingerprint: 'e'.repeat(64), sourceDirty: false, appVersion: '3.1.0' };
function headers(uid = owner, orgId = '', proofUid = uid): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET),
    [DESKTOP_SESSION_HEADER]: issueDesktopSessionProof(proofUid, identity).proof };
}
function fixture(orgId = cases.legalWorkspaceNamespace(owner)) {
  const c = cases.createCase(orgId, owner, { title: 'Synthetic unlink case', factDate: '2026-09-01' });
  const m = cases.addMaterial(orgId, owner, c.id, { type: 'evidence', title: 'Original synthetic source', source: 'import', content: 'SOURCE-UNLINK-TAIL' })!;
  const endpoint = app.url + '/api/legal/cases/' + c.id + '/materials/' + m.id;
  return { c, m, endpoint, revision: () => cases.getMaterialReview(orgId, owner, c.id, m.id)!.revision };
}
async function remove(f: ReturnType<typeof fixture>, h = headers(), revision = f.revision()) {
  return fetch(f.endpoint, { method: 'DELETE', headers: h, body: JSON.stringify({ expectedRevision: revision }) });
}
beforeAll(async () => { app = await makeApp(); const noModel = () => null;
  mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: noModel, getGemini: noModel, getOpenAI: noModel, getAnthropic: noModel, getQwen: noModel }); });
afterAll(() => app.cleanup());
describe('case-only material removal', () => {
  it('returns an exact receipt and retains physical originals and knowledge articles', async () => {
    const f = fixture(); const file = path.join(process.env.LUMI_DATA_DIR!, 'original-not-deleted.txt'); fs.writeFileSync(file, 'ORIGINAL-BYTES');
    const article = kb.createArticle(f.c.orgId, owner, { title: f.m.title, content: f.m.content }, { index: false });
    cases.updateCase(f.c.orgId, owner, f.c.id, { materials: [{ ...f.m, localPath: file }] });
    const response = await remove(f); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, caseId: f.c.id, materialId: f.m.id, case: { id: f.c.id, materials: [], removedMaterialIds: [f.m.id] } });
    expect(fs.readFileSync(file, 'utf8')).toBe('ORIGINAL-BYTES'); expect(kb.getArticle(f.c.orgId, article.id, owner)?.content).toBe(f.m.content);
    expect(listAuditLog(f.c.orgId, null).filter(e => e.action === 'legal_case.material.remove' && e.resourceId === f.c.id)).toHaveLength(1);
  });
  it('does not revive removed originals, generated text or artifacts through either stale write path', async () => {
    const f = fixture(); const before = cases.getCase(f.c.orgId, f.c.id, owner)!;
    cases.recordWorkflowRun(f.c.orgId, owner, f.c.id, { tool: 'synthetic_test', ok: true, status: 'generated', materialIds: [f.m.id], artifacts: ['not-deleted.docx'], displayText: 'REMOVED-RESULT' });
    expect((await remove(f)).status).toBe(200);
    for (const saved of [cases.upsertCaseSnapshot(f.c.orgId, owner, { ...before, removedMaterialIds: [] }),
      cases.updateCase(f.c.orgId, owner, f.c.id, { materials: before.materials, removedMaterialIds: [], workflowRuns: before.workflowRuns })!]) {
      expect(saved.materials).toEqual([]); expect(saved.removedMaterialIds).toContain(f.m.id); expect(saved.workflowRuns).toEqual([]);
    }
    cases.recordWorkflowRun(f.c.orgId, owner, f.c.id, { tool: 'late', ok: true, status: 'generated', materialIds: [f.m.id], artifacts: [], displayText: 'LATE-REMOVED-RESULT' });
    expect(cases.getCase(f.c.orgId, f.c.id, owner)?.workflowRuns).toEqual([]);
    const fresh = cases.addMaterial(f.c.orgId, owner, f.c.id, { type: f.m.type, title: f.m.title, content: f.m.content, source: f.m.source })!;
    expect(fresh.id).not.toBe(f.m.id); expect(cases.getCase(f.c.orgId, f.c.id, owner)?.materials.map(m => m.id)).toEqual([fresh.id]);
  });
  it('keeps only the latest same-tool display text while retaining previous artifact authorization metadata', () => {
    const f = fixture();
    cases.recordWorkflowRun(f.c.orgId, owner, f.c.id, { tool: 'synthetic', ok: true, status: 'generated', materialIds: [f.m.id], artifacts: ['prior-authorized.docx'], displayText: 'OLD-FULL-RESULT' });
    cases.recordWorkflowRun(f.c.orgId, owner, f.c.id, { tool: 'another', ok: true, status: 'generated', materialIds: [], artifacts: [], displayText: 'UNRELATED-RESULT' });
    cases.recordWorkflowRun(f.c.orgId, owner, f.c.id, { tool: 'synthetic', ok: false, status: 'failed', materialIds: [], artifacts: [], displayText: 'LATEST-REAL-FAILURE' });
    const runs = cases.getCase(f.c.orgId, f.c.id, owner)!.workflowRuns!;
    expect(runs[0]).toMatchObject({ tool: 'synthetic', ok: false, displayText: 'LATEST-REAL-FAILURE' });
    expect(runs.find(run => run.tool === 'another')?.displayText).toBe('UNRELATED-RESULT');
    expect(runs[2]).toMatchObject({ ok: true, materialIds: [f.m.id], artifacts: ['prior-authorized.docx'] }); expect(runs[2]).not.toHaveProperty('displayText');
  });
  it('changes the real source fingerprint and makes an existing draft review stale', async () => {
    const f = fixture(); const draft = cases.addMaterial(f.c.orgId, owner, f.c.id, { type: 'pleading', source: 'tool', title: 'Synthetic draft', content: 'UNAPPROVED-DRAFT' })!;
    const prior = cases.getCase(f.c.orgId, f.c.id, owner)!;
    cases.recordMaterialReview(f.c.orgId, owner, f.c.id, draft.id, { decision: 'confirmed', expectedRevision: cases.getMaterialReview(f.c.orgId, owner, f.c.id, draft.id)!.revision });
    expect((await remove(f)).status).toBe(200); const after = cases.getCase(f.c.orgId, f.c.id, owner)!;
    expect(legalCaseSourceFingerprint(after)).not.toBe(legalCaseSourceFingerprint(prior));
    expect(after.materials.map(m => m.id)).toEqual([draft.id]); expect(cases.getMaterialReview(f.c.orgId, owner, f.c.id, draft.id)?.status).toBe('stale');
  });
  it('rejects stale revisions, anonymous/bearer-only requests, proof mismatch and wrong personal/case targets', async () => {
    const f = fixture(), g = fixture(), old = f.revision(); cases.updateCase(f.c.orgId, owner, f.c.id, { factDate: '2026-09-02' });
    expect((await remove(f, headers(), old)).status).toBe(409);
    expect((await fetch(f.endpoint, { method: 'DELETE' })).status).toBe(401);
    const noProof = headers(); delete noProof[DESKTOP_SESSION_HEADER]; expect((await remove(f, noProof)).status).toBe(403);
    expect((await remove(f, headers(owner, '', other))).status).toBe(403);
    expect((await remove(f, headers(other))).status).toBe(404);
    expect((await fetch(g.endpoint.replace(g.m.id, f.m.id), { method: 'DELETE', headers: headers(), body: JSON.stringify({ expectedRevision: f.revision() }) })).status).toBe(404);
    expect(cases.getCase(f.c.orgId, f.c.id, owner)?.materials.map(m => m.id)).toContain(f.m.id);
  });
  it('allows a writable organization member but refuses viewers, inactive membership and restricted ACL', async () => {
    const org = createOrg('Synthetic material unlink org', 'synthetic-material-unlink-org', owner);
    addMember(org.id, owner, 'owner'); addMember(org.id, other, 'member'); addMember(org.id, viewer, 'viewer');
    const f = fixture(org.id); expect((await remove(f, headers(viewer, org.id))).status).toBe(403);
    expect((await remove(f, headers('not-a-member', org.id))).status).toBe(403);
    setOrganizationResourcePolicy({ orgId: org.id, actorUserId: owner, resourceType: 'legal_case', resourceId: f.c.id, ownerUserId: owner, classification: 'restricted', grants: [] });
    expect((await remove(f, headers(other, org.id))).status).toBeGreaterThanOrEqual(400);
    const open = fixture(org.id); expect((await remove(open, headers(other, org.id))).status).toBe(200);
    expect(cases.getCase(org.id, open.c.id, owner)?.materials).toEqual([]);
  });
});
