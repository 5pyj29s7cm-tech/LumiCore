import { contractStructuredReply, sdkCompletionFixture } from './legal_contract_fixture';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { buildSourceOnlyContractReview } from '../server/regions/packs/cn/legal_tools/contracts';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import type { ToolContext } from '../server/tools/types';
const inputs = [
  { id: 'jurisdiction', text: '采购合同。争议由乙方所在地法院管辖。甲方登记住所为北京市海淀区，乙方登记住所为杭州市西湖区。履行地为乙方所在地。', invented: '争议约定由甲方所在地法院管辖' },
  { id: 'payment', text: '设备采购合同。付款日期为2026年9月1日，付款比例100%，一次性全额付款；银行实际到账认定为付款完成，起算日为到账次日。乙方于付款后30日内交货。验收按附件一明确标准进行。', invented: '原文没有写明付款时间、比例、到账认定' },
  { id: 'penalty', text: '设备采购合同。乙方每逾期一日按合同总价5%支付违约金；违约金累计上限为合同总价10%，设3个工作日宽限期；只计算归责于乙方的迟延。验收标准详见附件一。', invented: '原文没有上限、宽限期' },
];
let app: Awaited<ReturnType<typeof makeApp>>, mode: 'ok' | 'failure' | 'truncated' = 'ok';
const registry = new ToolRegistry(), userId = 'contract-rule-removal-owner', orgId = cases.legalWorkspaceNamespace(userId);
const analysis = '模拟模型逐条初审：原文为乙方所在地管辖，付款节点及违约金上限按原文保留，具体效力和完整附件仍待律师核验。MODEL-REVIEW-END';
const create = vi.fn(async (params: any) => { if (mode === 'failure') throw new Error('Synthetic provider failure'); return sdkCompletionFixture(contractStructuredReply(String(params.messages.find((m:any)=>m.role==='user')?.content || ''), analysis), mode === 'truncated' ? 'length' : 'stop', params.stream); });
const context: ToolContext = { userId, domain: 'personal', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', source: 'legal-direct-tool', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
function fixture() { return cases.createCase(orgId, userId, { title: '虚构合同规则删减-' + crypto.randomUUID() }); }
const run = (caseId: string, extra = {}) => registry.execute('legal_review_contract', { caseId, contract: inputs.map(x => x.text).join('\n'), persistCase: true, ...extra }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
beforeAll(async () => { app = await makeApp(); registerLegalTools(registry); upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-contract-review', selectionMode: 'pinned', allowCloudFallback: false }); });
afterAll(() => app.cleanup());
beforeEach(() => { create.mockClear(); mode = 'ok'; });
describe('contract review does not rejudge source facts with keyword rules', () => {
  it.each(inputs)('preserves complete $id original without inventing a contradictory finding', input => {
    const output = buildSourceOnlyContractReview(input.text); expect(output).toContain(input.text); expect(output).not.toContain(input.invented);
    expect(output).toContain('待人工核对'); expect(output).not.toContain('未识别到预设高风险表达');
  });
  it('keeps source-only input readable but partial, without a model call or archived completed review', async () => {
    const item = fixture(), result = await run(item.id, { sourceOnly: true }); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    for (const input of inputs) expect(result.content).toContain(input.text); expect(result.content).toContain('原文输入覆盖：全文'); expect(result.content).not.toContain('原文规则检查：全文');
    expect(create).not.toHaveBeenCalled(); expect(cases.getCase(orgId, item.id, userId)!.materials).toHaveLength(0);
  });
  it('returns the actual successful model review without appending a second automatic risk judgment', async () => {
    const item = fixture(), result = await run(item.id); expect(result.receipt).toMatchObject({ ok: true, status: 'reviewed' }); expect(result.content).toContain(analysis);
    for (const input of inputs) expect(result.content).not.toContain(input.invented); expect(result.content).not.toContain('合同审查结果（仅依据原文）'); expect(result.content).not.toContain('原文规则检查：全文');
    expect(create).toHaveBeenCalledTimes(1); expect(cases.getCase(orgId, item.id, userId)!.materials).toHaveLength(1);
  });
  it.each(['failure', 'truncated'] as const)('keeps %s output partial and out of completed archives', async failure => {
    const item = fixture(); mode = failure; const result = await run(item.id); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(result.content).toContain('深度审查未全部完成'); expect(result.content).not.toContain(analysis); expect(cases.getCase(orgId, item.id, userId)!.materials).toHaveLength(0);
  });
});
