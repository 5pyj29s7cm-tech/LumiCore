import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { sdkCompletionFixture } from './legal_contract_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import * as quality from '../server/regions/packs/cn/legal_work_product_quality';
import { draftContractHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { SourceDraftValidationError } from '../server/regions/packs/cn/legal_reasoning_generation';
import type { ToolContext } from '../server/tools/types';

const userId = 'synthetic-contract-diagnostics-owner';
const workspace = cases.legalWorkspaceNamespace(userId), registry = new ToolRegistry();
const original = '虚构甲与虚构乙只进行无偿双向保密合作，期限为签署后两年。签署日期、地点和损失待确认，不设付款、交付验收或担保。';
const marker = 'PRIVATE-CONTRACT-MODEL-SECRET-DO-NOT-LOG';
let app: Awaited<ReturnType<typeof makeApp>>;
let transform: (value: any) => any, raw: string | null, finishReason: string, providerFailure: Error | null;
let beforeReturn: (() => void) | undefined;
let warn: ReturnType<typeof vi.spyOn>;
function payload() {
  return { complete: true, entries: quality.CONTRACT_DRAFT_SECTIONS.map(section => ({
    sectionId: section.id, sourceIds: ['F2'],
    response: '双方仅进行无偿双向保密合作；本栏目未确认的交易条件保持待双方确认，不代表法律或事实已核准。',
    missing: '签署日期、主体登记和争议解决待双方确认。',
  })) };
}
const create = vi.fn(async (params: any) => {
  if (providerFailure) throw providerFailure;
  beforeReturn?.();
  return sdkCompletionFixture(raw ?? JSON.stringify(transform(payload())), finishReason, params.stream);
});
const baseContext: ToolContext = { userId, domain: 'personal', authenticated: true, authRole: 'user',
  localExecution: true, executionBoundary: 'trusted_local', source: 'legal-direct-tool',
  llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
async function run(persistCase = true, executionSignal?: AbortSignal) {
  const item = cases.createCase(workspace, userId, { title: '虚构合同诊断-' + crypto.randomUUID() });
  const requestId = crypto.randomUUID();
  const invoke = () => registry.execute('legal_draft_contract', { caseId: item.id, type: '无偿双向保密协议', details: original, persistCase },
    { ...baseContext, requestId, ...(executionSignal ? { executionSignal } : {}) });
  return { item, requestId, invoke };
}
function diagnosticLogs() { return warn.mock.calls.filter(call => call[0] === '[LegalContractDraft]'); }
function assertPartial(result: ReturnType<typeof decodeToolResult>, itemId: string, requestId: string, reason: string) {
  expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, artifacts: [] });
  expect(result.content).toContain(reason);
  expect(result.content).not.toContain(marker);
  expect(cases.getCase(workspace, itemId, userId)!.materials).toHaveLength(0);
  expect(create).toHaveBeenCalledTimes(1);
  expect(diagnosticLogs()).toHaveLength(1);
  expect(diagnosticLogs()[0]).toEqual(['[LegalContractDraft]', { requestId, reason }]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
}
beforeAll(async () => {
  app = await makeApp(); registerLegalTools(registry);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-contract-diagnostic', selectionMode: 'pinned', allowCloudFallback: false });
});
afterAll(() => app.cleanup());
beforeEach(() => {
  create.mockClear(); transform = value => value; raw = null; finishReason = 'stop'; providerFailure = null; beforeReturn = undefined;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
describe('registered contract draft exposes safe rejection stages without weakening completion', () => {
  it('preserves a complete generated draft and the one requested archive', async () => {
    const f = await run(), result = decodeToolResult(await f.invoke());
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: true });
    expect(cases.getCase(workspace, f.item.id, userId)!.materials).toHaveLength(1);
    for (const section of quality.CONTRACT_DRAFT_SECTIONS) expect(result.content).toContain(section.title);
    expect(create).toHaveBeenCalledTimes(1); expect(diagnosticLogs()).toHaveLength(0);
  });
  it('preserves persistCase:false for a complete work draft', async () => {
    const f = await run(false), result = decodeToolResult(await f.invoke());
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: false });
    expect(cases.getCase(workspace, f.item.id, userId)!.materials).toHaveLength(0);
    expect(create).toHaveBeenCalledTimes(1); expect(diagnosticLogs()).toHaveLength(0);
  });
  it('describes a null result as unavailable rather than inventing a timeout, with no SDK call', async () => {
    const f = await run();
    const result = decodeToolResult(await draftContractHandler({ caseId: f.item.id, type: '无偿保密协议', details: original, persistCase: false },
      { userId, domain: 'personal', requestId: f.requestId }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('未取得合同正文'); expect(result.content).not.toContain('超时');
    expect(create).not.toHaveBeenCalled(); expect(cases.getCase(workspace, f.item.id, userId)!.materials).toHaveLength(0);
    expect(diagnosticLogs()).toEqual([['[LegalContractDraft]', { requestId: f.requestId, reason: '未取得合同正文' }]]);
  });
  it('reports JSON rejection without exposing parser snippets from non-JSON model output', async () => {
    raw = marker + ' secret=private-value';
    const f = await run(), result = decodeToolResult(await f.invoke());
    assertPartial(result, f.item.id, f.requestId, '合同起草 JSON 解析失败');
    expect(result.content).not.toContain('请核对模型服务');
  });
  it.each(['missing-list', 'missing-section', 'unknown-source', 'empty-body', 'incomplete', 'unresolved', 'bad-missing'] as const)('keeps %s partial with controlled validation diagnostics', async fault => {
    transform = value => fault === 'missing-list' ? { complete: true, explanation: marker }
      : fault === 'missing-section' ? { ...value, entries: value.entries.slice(1) }
      : fault === 'unknown-source' ? { ...value, entries: value.entries.map((entry: any) => ({ ...entry, sourceIds: [marker] })) }
      : fault === 'empty-body' ? { ...value, entries: value.entries.map((entry: any) => ({ ...entry, response: '# 标题' })) }
      : fault === 'bad-missing' ? { ...value, entries: value.entries.map((entry: any) => ({ ...entry, missing: null })) }
      : fault === 'incomplete' ? { ...value, complete: false }
      : { ...value, unresolved: [marker] };
    const f = await run(), result = decodeToolResult(await f.invoke());
    assertPartial(result, f.item.id, f.requestId, '合同栏目、来源或正文完整性校验未通过');
  });
  it('retains the output-limit rejection rather than accepting a truncated draft', async () => {
    finishReason = 'length';
    const f = await run(), result = decodeToolResult(await f.invoke());
    assertPartial(result, f.item.id, f.requestId, '模型输出额度耗尽，合同正文截断');
  });
  it('does not trust arbitrary text carried by an existing validation error type', async () => {
    vi.spyOn(quality, 'resolveContractWorkProduct').mockImplementationOnce(() => { throw new SourceDraftValidationError(marker); });
    const f = await run(), result = decodeToolResult(await f.invoke());
    assertPartial(result, f.item.id, f.requestId, '合同栏目、来源或正文完整性校验未通过');
  });
  it('keeps an empty completion outside archives and does not expose upstream diagnostics', async () => {
    raw = '   ';
    const f = await run(), result = decodeToolResult(await f.invoke());
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(cases.getCase(workspace, f.item.id, userId)!.materials).toHaveLength(0);
    expect(create).toHaveBeenCalledTimes(1); expect(diagnosticLogs()).toHaveLength(1);
    expect(JSON.stringify(diagnosticLogs())).not.toContain(marker);
  });
  it('keeps an unsafe provider failure partial and logs only a static reason plus request identity', async () => {
    providerFailure = new Error(marker + ' api_key=not-a-real-key');
    const f = await run(), result = decodeToolResult(await f.invoke());
    assertPartial(result, f.item.id, f.requestId, '模型调用或合同解析失败');
  });
  it.each(['before-request', 'during-request'] as const)('propagates caller cancellation %s without logging a completion failure', async when => {
    const controller = new AbortController();
    if (when === 'before-request') controller.abort(new Error('Synthetic caller cancellation'));
    else beforeReturn = () => controller.abort(new Error('Synthetic caller cancellation'));
    const f = await run(true, controller.signal);
    await expect(f.invoke()).rejects.toThrow();
    expect(cases.getCase(workspace, f.item.id, userId)!.materials).toHaveLength(0);
    expect(create).toHaveBeenCalledTimes(when === 'before-request' ? 0 : 1);
    expect(diagnosticLogs()).toHaveLength(0);
  });
});
