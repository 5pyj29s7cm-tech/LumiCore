import { makeApp } from './helpers';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as cases from '../server/org/legal_cases';
import { generateArgumentOrOpinionHandler, extractDisputeFocusHandler } from '../server/regions/packs/cn/legal_tools/argument_drafting';
import { decodeToolResult } from '../server/tools/result_envelope';
import { makeLLMCall } from '../server/llm/providers';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
let cleanup = () => {};
beforeAll(async () => { const app = await makeApp(); cleanup = app.cleanup; });
afterAll(() => cleanup());
describe('strict legal argument source prerequisites', () => {
  it('does not archive an unfinished focus result into the existing case', async () => {
    const userId = 'focus-failure-owner', orgId = 'personal:' + userId;
    const file = cases.createCase(orgId, userId, { title: 'Unfinished synthetic focus' });
    const before = JSON.stringify(cases.getCase(orgId, file.id, userId));
    const result = decodeToolResult(await extractDisputeFocusHandler({ caseId: file.id, caseName: file.title, materials: '甲方仅主张付款，对方未确认；尾句 FOCUS_TAIL_593。' }, { userId, domain: 'personal' }));
    expect(result.receipt).toEqual({ ok: false, status: 'partial' });
    expect(result.content).toContain('FOCUS_TAIL_593');
    expect(JSON.stringify(cases.getCase(orgId, file.id, userId))).toBe(before);
    expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it('retains a full original source and reports partial without a bound archived case instead of returning a legal template as completed', async () => {
    const materials = '甲方仅主张交货，对方未确认；付款和验收原件均待核实。\n'.repeat(2000) + 'STRICT_ARGUMENT_TAIL_511';
    const result = decodeToolResult(await generateArgumentOrOpinionHandler({ caseName: '虚构来源验收', materials, persistCase: false }, { userId: 'strict-original-owner' }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningLinked: false, reasoningReviewed: false });
    expect(result.content).toContain('拟议正文未完成'); expect(result.content).toContain('STRICT_ARGUMENT_TAIL_511');
    expect(result.content).not.toContain('基础事实、证据、法源和风险的工作稿衔接');
    expect(makeLLMCall).not.toHaveBeenCalled();
  });
});
