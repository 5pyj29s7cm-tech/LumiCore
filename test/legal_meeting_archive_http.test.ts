import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import * as LegalCases from '../server/org/legal_cases';
import { createOrg, addMember } from '../server/org/db';
import { mountChatRoutes, formatMeetingTranscriptForAnalysis } from '../server/routes/chat_routes';
import { makeLLMCall } from '../server/llm/providers';
import { meetingMinutesToCaseHandler } from '../server/regions/packs/cn/legal_tools/meetings';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
let app: Awaited<ReturnType<typeof makeApp>>;
const userId = 'virtual-meeting-archive-owner';
const namespace = LegalCases.legalWorkspaceNamespace(userId);
const notes = Array.from({ length: 320 }, (_, i) => ({ id: 'virtual-note-' + i, time: 100000 + i, text: '虚构完整原句 ' + i, speakerLabel: i % 2 ? '模拟甲' : '模拟乙' }));
const report = '虚构摘要；付款和法院期限仍待原件核对。SUMMARY TAIL';
const token = (uid = userId, orgId?: string) => jwt.sign({ uid, role: 'admin', ...(orgId ? { orgId } : {}) }, JWT_SECRET);
const mount = (target: Awaited<ReturnType<typeof makeApp>>) => { const absent = () => null; mountChatRoutes(target.apiRouter, JWT_SECRET, { getDeepSeek: absent, getGemini: absent, getOpenAI: absent, getAnthropic: absent, getQwen: absent }); };
async function archive(body: any, auth = token(), target = app) {
  const response = await fetch(target.url + '/api/meeting/archive', { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
function fixture(label: string) { const item = LegalCases.createCase(namespace, userId, { title: '虚构入案 ' + label, notes: '原案件备注，不是会议摘要。' }); return { item, body: { notes, report, startedAt: 100000, endedAt: 200000, meetingId: 'record-' + item.id, legalCase: { id: item.id, title: '调用方错误标题不得覆盖案件名' } } }; }
beforeAll(async () => { app = await makeApp(); mount(app); });
afterAll(() => app.cleanup());
afterEach(() => { vi.restoreAllMocks(); vi.mocked(makeLLMCall).mockReset(); });
describe('one authenticated no-model meeting archive endpoint', () => {
  it('returns verified actual case/material IDs and keeps every original separate from the report', async () => {
    const { item, body } = fixture('完整保全'); const result = await archive(body);
    expect(result.status).toBe(200); expect(result.data).toMatchObject({ ok: true, status: 'archived', meetingId: body.meetingId, caseId: item.id, summaryPresent: true });
    const saved = LegalCases.getCase(namespace, item.id, userId)!; expect(result.data.caseFile).toEqual(saved); expect(saved.materials).toHaveLength(2);
    const original = saved.materials.find(m => m.id === result.data.materialIds.transcript)!; const minutes = saved.materials.find(m => m.id === result.data.materialIds.minutes)!;
    expect(original).toMatchObject({ type: 'consultation', source: 'import', content: formatMeetingTranscriptForAnalysis(notes) });
    expect(original.content).toContain('虚构完整原句 319'); expect(original.content).not.toContain(report); expect(original.title).toContain(item.title); expect(original.title).not.toContain(body.legalCase.title);
    expect(minutes).toMatchObject({ type: 'note', source: 'tool' }); expect(minutes.content).toContain(report); expect(minutes.content).not.toContain(notes[0].text); expect(minutes.content).not.toContain(notes[319].text); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('reuses the same materials on duplicate/concurrent requests and through a fresh router instance', async () => {
    const { item, body } = fixture('幂等重开'); const first = await archive(body); const duplicate = await Promise.all([archive(body), archive(body)]);
    for (const reply of duplicate) { expect(reply.status).toBe(200); expect(reply.data.materialIds).toEqual(first.data.materialIds); }
    const reopened = await makeApp(); mount(reopened);
    try { const reply = await archive(body, token(), reopened); expect(reply.status).toBe(200); expect(reply.data.materialIds).toEqual(first.data.materialIds); } finally { reopened.cleanup(); }
    expect(LegalCases.getCase(namespace, item.id, userId)!.materials).toHaveLength(2); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('uses the record identity for an undated meeting without inventing a session date', async () => {
    const { item, body } = fixture('未提供会议时间'); const { startedAt, endedAt, ...undated } = body;
    const first = await archive(undated), second = await archive(undated); expect(first.status).toBe(200); expect(second.data.materialIds).toEqual(first.data.materialIds);
    const saved = LegalCases.getCase(namespace, item.id, userId)!; expect(saved.materials).toHaveLength(2); expect(saved.materials.every(material => material.title.includes('时间未提供') && material.title.includes(body.meetingId))).toBe(true);
    expect(saved.materials.find(material => material.type === 'note')!.content).toContain('会议时间：未提供'); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('saves originals without a report and adds only a new summary when one is later supplied', async () => {
    const { item, body } = fixture('没有总结'); const initial = await archive({ ...body, report: '' });
    expect(initial.status).toBe(200); expect(initial.data.summaryPresent).toBe(false); const saved = LegalCases.getCase(namespace, item.id, userId)!;
    expect(saved.materials.find(m => m.id === initial.data.materialIds.minutes)!.content).toContain('尚未生成总结');
    const completed = await archive(body); expect(completed.status).toBe(200); expect(completed.data.materialIds.transcript).toBe(initial.data.materialIds.transcript);
    expect(completed.data.materialIds.minutes).not.toBe(initial.data.materialIds.minutes); expect(LegalCases.getCase(namespace, item.id, userId)!.materials).toHaveLength(3); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('rejects missing identity/originals rather than creating an unbound archive', async () => {
    const { item, body } = fixture('必需输入'); for (const changed of [{ legalCase: {} }, { meetingId: '' }, { notes: [] }, { report: {} }]) expect((await archive({ ...body, ...changed })).status).toBe(400);
    expect(LegalCases.getCase(namespace, item.id, userId)!.materials).toHaveLength(0); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('never falls back from an explicit invalid case ID to a matching title or a new case', async () => {
    const { item, body } = fixture('不模糊创建'); const before = LegalCases.listCases(namespace, '', 200, userId).length;
    expect((await archive({ ...body, legalCase: { id: 'missing-case', title: item.title } })).status).toBe(404);
    await expect(meetingMinutesToCaseHandler({ caseId: 'missing-case', caseName: item.title, transcript: '虚构原文' }, { userId, domain: 'personal' })).rejects.toThrow('unavailable');
    expect(LegalCases.listCases(namespace, '', 200, userId)).toHaveLength(before); expect(LegalCases.getCase(namespace, item.id, userId)!.materials).toHaveLength(0);
  });
  it('ignores caller scope and refuses another personal owner or organization case', async () => {
    const { item, body } = fixture('认证域'); expect((await archive({ ...body, domain: 'work', orgId: 'forged-org' })).status).toBe(200);
    expect((await archive(body, token('different-personal-owner'))).status).toBe(404);
    const org = createOrg('虚构域隔离组织', 'virtual-archive-domain', userId); addMember(org.id, userId, 'owner');
    expect((await archive(body, token(userId, org.id))).status).toBe(404); expect(LegalCases.getCase(namespace, item.id, userId)!.materials).toHaveLength(2); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('uses authenticated organization membership and denies viewers while allowing the actual owner', async () => {
    const org = createOrg('虚构会议归档组织', 'virtual-archive-roles', userId); addMember(org.id, userId, 'owner'); addMember(org.id, 'virtual-meeting-viewer', 'viewer');
    const item = LegalCases.createCase(org.id, userId, { title: '虚构组织会谈' }); const body = { notes, report, meetingId: 'org-record', startedAt: 100000, legalCase: { id: item.id } };
    expect((await archive(body, token('virtual-meeting-viewer', org.id))).status).toBe(403);
    const result = await archive({ ...body, domain: 'personal', orgId: 'wrong-org' }, token(userId, org.id)); expect(result.status).toBe(200); expect(result.data.caseFile.orgId).toBe(org.id); expect(LegalCases.getCase(org.id, item.id, userId)!.materials).toHaveLength(2); expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('does not claim success on a partial write and reuses its saved original on recovery', async () => {
    const { item, body } = fixture('中断恢复'); const add = LegalCases.addMaterial;
    const spy = vi.spyOn(LegalCases, 'addMaterial').mockImplementation((...args) => args[3].type === 'note' ? null : add(...args));
    const failed = await archive(body); expect(failed.status).toBe(500); expect(failed.data.ok).not.toBe(true); const original = LegalCases.getCase(namespace, item.id, userId)!.materials[0]; expect(original.type).toBe('consultation');
    spy.mockRestore(); const recovered = await archive(body); expect(recovered.status).toBe(200); expect(recovered.data.materialIds.transcript).toBe(original.id); expect(LegalCases.getCase(namespace, item.id, userId)!.materials).toHaveLength(2); expect(makeLLMCall).not.toHaveBeenCalled();
  });
});
