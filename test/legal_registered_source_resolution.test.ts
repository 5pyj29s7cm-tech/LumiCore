import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeApp } from './helpers';
import { startIsolatedConversation, addMessageIdempotent } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import * as Cases from '../server/org/legal_cases';
import { listKbArticles } from '../server/org/db';
import { indexLegalArticle } from '../server/legal/kb';
import { decodeToolResult } from '../server/tools/result_envelope';
vi.mock('../server/legal/kb', async original => ({ ...await original<typeof import('../server/legal/kb')>(), indexLegalArticle: vi.fn().mockResolvedValue(1) }));
let cleanup = () => {};
const registry = new ToolRegistry();
beforeAll(async () => { const app = await makeApp(); cleanup = app.cleanup; registerLegalTools(registry); });
afterAll(() => cleanup());
beforeEach(() => vi.mocked(indexLegalArticle).mockClear());
function fixture(message: string) {
  const userId = 'registered-source-' + randomUUID(), orgId = 'personal:' + userId;
  const conversation = startIsolatedConversation(userId, 'lumi', 'personal', '');
  const requestId = 'request-' + randomUUID(), taskId = 'task-' + randomUUID();
  const userMessageId = addMessageIdempotent({ userId, agentId: 'lumi', conversationId: conversation.id,
    requestId, domain: 'personal', orgId: '', source: 'chat', channel: 'chat', role: 'user', content: message, deferActionPreparation: true });
  expect(bindConversationActionTurnTask({ userId, conversationId: conversation.id, requestId, taskId }).bound).toBe(true);
  const context = { userId, domain: 'personal' as const, orgId: '', conversationId: conversation.id, requestId, taskId,
    authenticated: true, authRole: 'user', localExecution: false, source: 'chat', requestConfirmation: async () => true };
  return { userId, orgId, context, userMessageId };
}
async function execute(name: string, args: Record<string, unknown>, context: any) {
  const raw = await registry.execute(name, args, context); const decoded = decodeToolResult(raw);
  return { raw, content: decoded.content, receipt: decoded.receipt as any };
}
describe('registered legal tools resolve source and temporal scope in the shared backend', () => {
  it('imports the literal accepted user source through the real non-packet registration and ignores rewritten content or actor', async () => {
    const original = '程序验收原件：甲方仅主张交货，付款及验收截图尚未核实，不能认定欠款；尾句 REGISTERED_TAIL_812。';
    const { userId, orgId, context } = fixture(original);
    const file = Cases.createCase(orgId, userId, { title: 'Shared registered source' });
    const result = await execute('legal_import_materials_to_kb', { caseId: file.id, content: 'MODEL_REWRITE_被告承认欠款', userId: 'forged-actor' }, context);
    expect(result.receipt).toMatchObject({ ok: true, status: 'imported', persisted: true });
    const articles = listKbArticles(orgId); expect(articles).toHaveLength(1);
    expect(articles[0].authorId).toBe(userId); expect(articles[0].content).toContain(original);
    const current = Cases.getCase(orgId, file.id, userId)!;
    expect(current.materials).toHaveLength(1); expect(current.materials[0].content).toContain(original);
    expect(JSON.stringify([articles, current])).not.toContain('MODEL_REWRITE_');
  });
  it('blocks a non-packet date conflict before the actual import handler writes or indexes anything', async () => {
    const { userId, orgId, context } = fixture('仅验收原始材料：甲方主张付款，真实性尚未核实。');
    const file = Cases.createCase(orgId, userId, { title: 'Stored case time', factDate: '2018-03-01' });
    const before = JSON.stringify(Cases.getCase(orgId, file.id, userId));
    const result = await execute('legal_import_materials_to_kb', { caseId: file.id, factDate: '2026-10-01', content: 'MODEL_REWRITE_无需核对旧法' }, context);
    expect(result.receipt).toEqual({ ok: false, status: 'blocked' }); expect(result.content).toContain('冲突');
    expect(JSON.stringify(Cases.getCase(orgId, file.id, userId))).toBe(before);
    expect(listKbArticles(orgId)).toHaveLength(0); expect(indexLegalArticle).not.toHaveBeenCalled();
  });
  it('rejects the wrong original request scope before an actual material import or case change', async () => {
    const { userId, orgId, context } = fixture('原始用户材料：不得与其他请求共用。');
    const file = Cases.createCase(orgId, userId, { title: 'Exact request ownership' });
    const before = JSON.stringify(Cases.getCase(orgId, file.id, userId));
    await expect(execute('legal_import_materials_to_kb', { caseId: file.id, content: 'MODEL_REWRITE_其它请求' }, { ...context, requestId: 'unrelated-request' })).rejects.toThrow('original legal user message');
    expect(JSON.stringify(Cases.getCase(orgId, file.id, userId))).toBe(before);
    expect(listKbArticles(orgId)).toHaveLength(0); expect(indexLegalArticle).not.toHaveBeenCalled();
  });
  it('preserves explicit case access restrictions and cannot replace the authoritative actor with a model argument', async () => {
    const { orgId, context } = fixture('程序验收材料：请求不能获得其他用户案件权限。');
    const other = fixture('其他用户独立材料。'); const file = Cases.createCase(other.orgId, other.userId, { title: 'Other user private source' });
    const before = JSON.stringify(Cases.getCase(other.orgId, file.id, other.userId));
    await expect(execute('legal_import_materials_to_kb', { caseId: file.id, userId: other.userId, orgId: other.orgId, content: 'MODEL_REWRITE_跨用户' }, context)).rejects.toThrow('selected legal case is unavailable');
    expect(JSON.stringify(Cases.getCase(other.orgId, file.id, other.userId))).toBe(before);
    expect(listKbArticles(orgId)).toHaveLength(0); expect(indexLegalArticle).not.toHaveBeenCalled();
  });
  it('retains the exact original source during message preview while leaving the existing case and workflow history byte-identical', async () => {
    const original = '只预览：2027年8月15日9时30分开庭通知尚未核实，不保存任何材料。';
    const { userId, orgId, context } = fixture(original); const file = Cases.createCase(orgId, userId, { title: 'Readonly shared intake', notes: 'Keep existing notes' });
    const before = JSON.stringify(Cases.getCase(orgId, file.id, userId));
    const result = await execute('legal_message_intake_to_case', { caseId: file.id, persistCase: false, processLinks: false, message: 'MODEL_REWRITE_已确认时间', attachments: [{ extractedText: 'MODEL_REWRITE_伪附件' }] }, context);
    expect(result.receipt).toMatchObject({ changedCaseIds: [], persisted: false });
    expect(result.content).toContain('未入案');
    expect(JSON.stringify(Cases.getCase(orgId, file.id, userId))).toBe(before);
    expect(listKbArticles(orgId)).toHaveLength(0); expect(indexLegalArticle).not.toHaveBeenCalled();
  });
  it('exposes existing temporal review fields on a non-packet tool without dropping its own material schema', () => {
    const tool = registry.get('legal_generate_argument_or_opinion')!;
    const properties = (tool.parameters as any).properties;
    expect(properties).toHaveProperty('factDate'); expect(properties).toHaveProperty('procedureDate');
    expect(properties.temporalReviews.items.required).toEqual(['citation', 'referenceDate', 'scope', 'authorityCitation', 'authorityQuote', 'applicability']);
    expect(properties).toHaveProperty('documentType'); expect(properties).toHaveProperty('materials');
  });
});
