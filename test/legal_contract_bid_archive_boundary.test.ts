import { contractStructuredReply, sdkCompletionFixture } from './legal_contract_fixture';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import { decodeToolResult } from '../server/tools/result_envelope';
import { bidStructuredReply } from './legal_bid_fixture';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
async function fixture(model: boolean) {
  const cases = await import('../server/org/legal_cases');
  const { reviewContractHandler, generateBidHandler } = await import('../server/regions/packs/cn/legal_tools/contracts');
  const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
  const userId = 'contract-bid-boundary-' + Math.random().toString(36).slice(2), orgId = cases.legalWorkspaceNamespace(userId);
  const item = cases.createCase(orgId, userId, { title: '虚构归档边界', party: '虚构甲/虚构乙' });
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'offline-fixture', selectionMode: 'pinned' });
  const create = vi.fn(async (params: any) => {
    const prompt = String(params.messages.find((m: any) => m.role === 'user')?.content || '');
    const text = '本段仅用于虚构初审验收，合同原文和资格证明仍须责任人核验，未确认任何未知主体、资质、报价或履行事实。';
    return sdkCompletionFixture((prompt.includes('指定子节：') || prompt.includes('待核对JSON草稿：')) ? bidStructuredReply(prompt, text) : contractStructuredReply(prompt, text), 'stop', params.stream);
  });
  const context: any = { userId, domain: 'personal', localExecution: true, executionBoundary: 'trusted_local', ...(model ? { llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } } : {}) };
  const { ensureLegalDeliveryRoot } = await import('../server/regions/packs/cn/legal_tools/context');
  const outputDir = fs.mkdtempSync(path.join(ensureLegalDeliveryRoot(orgId), 'contract-bid-boundary-')); 
  const args = { caseId: item.id, caseName: item.title, persistCase: true, outputDir };
  return { cases, orgId, userId, item, context, create, outputDir, args, reviewContractHandler, generateBidHandler };
}
it.each([false, true])('contract review preserves partial output without archiving it; complete=%s', async model => {
  const f = await fixture(model); try {
    const result = decodeToolResult(await f.reviewContractHandler({ ...f.args, contract: '虚构采购合同：总价80万元，甲方称已支付20万元。交付及付款日期均待核验。' }, f.context));
    expect(result.receipt).toMatchObject({ ok: model, status: model ? 'reviewed' : 'partial' });
    expect(f.cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(model ? 1 : 0);
    expect(result.content).toContain(model ? '第 1 段模型分析' : '深度审查未全部完成');
    expect(f.create).toHaveBeenCalledTimes(model ? 1 : 0);
  } finally { fs.rmSync(f.outputDir, { recursive: true, force: true }); }
});
it.each([false, true])('bid preserves local draft without archiving an unfinished model result; complete=%s', async model => {
  const f = await fixture(model); try {
    const result = decodeToolResult(await f.generateBidHandler({ ...f.args, projectName: '虚构项目', requirements: '投标文件须提供主体资料、技术方案和报价，金额与资质证明待责任人核实。' }, f.context));
    expect(result.receipt).toMatchObject({ ok: model, status: model ? 'generated' : 'partial' });
    expect(f.cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(model ? 1 : 0);
    expect(result.content).toContain('DOCX 文件：');
    if (!model) expect(result.content).toContain('正文未完成');
    if (model) expect(f.create).toHaveBeenCalled(); else expect(f.create).not.toHaveBeenCalled();
  } finally { fs.rmSync(f.outputDir, { recursive: true, force: true }); }
});
