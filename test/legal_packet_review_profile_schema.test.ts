import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { packetDraftFixture } from './legal_packet_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import { getUserPreferredLLMConfig, upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { legalDocumentReviewPrompt, legalDocumentBatchReviewPrompt } from '../server/regions/packs/cn/legal_document_grounding';
const captured = vi.hoisted(() => ({ scopes: [] as Array<string | null> }));
vi.mock('../server/regions/packs/cn/legal_document_progress', async original => {
  const actual = await original<typeof import('../server/regions/packs/cn/legal_document_progress')>();
  return { ...actual, legalDocumentProgress: (...args: Parameters<typeof actual.legalDocumentProgress>) => { captured.scopes.push(args[0]); return actual.legalDocumentProgress(...args); } };
});
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
it('uses provider-default effort for actual packet draft/review SDK requests and a distinct recipe without changing user preferences', async () => {
  const userId = 'packet-profile-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned' });
  const before = getUserPreferredLLMConfig(userId);
  const c = cases.createCase(orgId, userId, { title: 'Synthetic review profile case', party: 'Synthetic A / Synthetic B', factDate: '2026-09-01' });
  const events: Array<{phase: string; request: any}> = [];
  const create = vi.fn(async (request: any) => {
    const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
    const drafting = prompt.includes('## 当前文书');
    events.push({ phase: drafting ? 'draft' : 'review', request });
    const body = '# Synthetic conditional analysis\nOriginal material remains unverified; no payment, delivery, additional remedy, admission or legal qualification is established by this fixture.';
    const content = drafting ? JSON.stringify(packetDraftFixture(prompt, { baseName: JSON.parse(prompt.split('## 当前文书\n')[1]).baseName, markdown: body }))
      : JSON.stringify({ documents: JSON.parse(prompt.split('文书列表：')[1]).map((document: any) => ({ baseName: document.baseName, complete: true, corrections: [], unresolved: [] })) });
    return sdkCompletion(request, { choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  captured.scopes = [];
  const result = decodeToolResult(await registry.execute('legal_generate_litigation_packet', {
    caseId: c.id, caseName: c.title, role: '原告', parties: c.party, claims: 'Original contract performance only; no added remedy.',
    facts: 'Synthetic A alleges a payment; success, allocation, delivery and dates remain unverified.', evidence: 'Synthetic contract copy and payment note; originals not verified.',
    includeDocx: false, persistCase: true,
  }, { userId, requestId: crypto.randomUUID(), domain: 'personal', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local',
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } }));
  expect(result.receipt).toMatchObject({ ok: true, status: 'generated', draftMode: 'model' });
  expect(events.filter(event => event.phase === 'draft')).toHaveLength(2);
  expect(events.filter(event => event.phase === 'review')).toHaveLength(2);
  for (const {request} of events) { expect(request).toMatchObject({ max_tokens: 16384, stream: true, response_format: { type: 'json_object' } }); expect(request).not.toHaveProperty('reasoning_effort'); }
  expect(captured.scopes).toHaveLength(1);
  const scope = JSON.parse(captured.scopes[0]!);
  expect(scope.preference).not.toHaveProperty('reasoningEffort'); expect(scope.recipe).not.toHaveProperty('reviewReasoningEffort');
  const oldLowScope = { ...scope, preference: { ...scope.preference, reasoningEffort: 'low' }, recipe: { ...scope.recipe, reviewReasoningEffort: 'low' } };
  const key = (value: string) => crypto.createHash('sha256').update('legal-document-review-v2\n' + value).digest('hex');
  expect(key(captured.scopes[0]!)).not.toBe(key(JSON.stringify(oldLowScope)));
  expect(getUserPreferredLLMConfig(userId)).toEqual(before);
  expect(cases.getCase(orgId, c.id)!.materials.filter(material => material.source === 'tool')).toHaveLength(1);
});
describe.each(['single', 'batch'] as const)('one real output schema for %s source review', mode => {
  it('preserves supplied sources, paragraph IDs and all shared factual safeguards without a dummy document', () => {
    const sources = 'S1 Original amount800000; A alleges200000 paid, not established payment. Due date and authenticity remain unverified.';
    const markdown = '# Conditional draft\nOnly original performance is requested; the alleged payment, full conditions and dates remain unverified.';
    const prompt = mode === 'single' ? legalDocumentReviewPrompt(markdown, sources) : legalDocumentBatchReviewPrompt([{ baseName: '10_civil-complaint/Facts' , markdown }], sources);
    expect(prompt.match(/仅输出 JSON /g)).toHaveLength(1);
    expect(prompt).toContain(sources);
    for (const rule of ['未知不能写成肯定或否定事实', '不能伪装成当事人主张', '确定性法律或证据资格结论须有本次提供的法律来源支持', '末尾待核备注不能抵销其中无依据的断言', '不扩展材料和诉求从未提及的争议', '只有有来源支持的条件草稿才属于核对完成']) expect(prompt).toContain(rule);
    const payload = JSON.parse(prompt.split(mode === 'single' ? '待核对文书：\n' : '文书列表：')[1]);
    const lines = mode === 'single' ? payload : payload[0].lines;
    expect(lines).toEqual([{ paragraphId: 'P1', text: '# Conditional draft' }, { paragraphId: 'P2', text: markdown.split('\n')[1] }]);
    if (mode === 'batch') { expect(prompt).not.toContain('待核对文书：'); expect(payload[0].baseName).toBe('10_civil-complaint/Facts'); }
  });
});
