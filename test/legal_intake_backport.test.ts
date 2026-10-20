import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { createOrg, addMember, listKbArticles } from '../server/org/db';
import * as cases from '../server/org/legal_cases';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { indexLegalArticle } from '../server/legal/kb';
import { getDataDirectory } from '../server/config/data_path';
import { ENCRYPTED_PDF_BASE64 } from './fixtures/encrypted_pdf';
import { decodeToolResult } from '../server/tools/result_envelope';
vi.mock('../server/legal/kb', async original => ({ ...await original<typeof import('../server/legal/kb')>(), indexLegalArticle: vi.fn().mockResolvedValue(1) }));
let cleanup = () => {};
const userId = 'synthetic-intake-backport-owner';
let orgId = '';
const registry = new ToolRegistry();
beforeAll(async () => {
  const app = await makeApp(); cleanup = app.cleanup;
  orgId = createOrg('Synthetic intake backport organization', 'synthetic-intake-backport', userId).id;
  addMember(orgId, userId, 'owner'); registerLegalTools(registry);
});
afterAll(() => cleanup());
afterEach(() => vi.mocked(indexLegalArticle).mockReset().mockResolvedValue(1));
async function intake(name: string, args: Record<string, unknown>) {
  const output = await registry.execute(name, { processLinks: false, ...args }, {
    userId, orgId, domain: 'work', authenticated: true, authRole: 'user', orgRole: 'owner',
    localExecution: false, requestConfirmation: async () => true,
  });
  const decoded = decodeToolResult(output);
  return { content: decoded.content, receipt: decoded.receipt as any, raw: output };
}
describe('shared legal intake backport', () => {
  it('retries the same password-protected source in the original case without article or material duplication', async () => {
    const filePath = path.join(getDataDirectory('backport-input'), 'protected.pdf');
    fs.writeFileSync(filePath, Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'));
    const file = cases.createCase(orgId, userId, { title: 'Encrypted synthetic intake' });
    const before = listKbArticles(orgId).length;
    const missing = await intake('legal_import_materials_to_kb', { filePath, caseId: file.id });
    expect(missing.receipt.ok).toBe(false); expect(missing.content).toContain('PDF_PASSWORD_REQUIRED');
    const wrong = await intake('legal_import_materials_to_kb', { filePath, caseId: file.id, password: 'wrong-test-password' });
    expect(wrong.receipt.ok).toBe(false); expect(wrong.content).toContain('PDF_PASSWORD_INCORRECT');
    expect(wrong.raw).not.toContain('wrong-test-password'); expect(listKbArticles(orgId)).toHaveLength(before);
    const first = await intake('legal_import_materials_to_kb', { filePath, caseId: file.id, password: 'open-sesame' });
    const retry = await intake('legal_import_materials_to_kb', { filePath, caseId: file.id, password: 'open-sesame' });
    expect(first.receipt).toMatchObject({ ok: true, status: 'imported' });
    expect(retry.receipt).toMatchObject({ ok: true, status: 'imported' });
    expect(retry.receipt.articleIds).toEqual(first.receipt.articleIds);
    expect(listKbArticles(orgId)).toHaveLength(before + 1);
    expect(cases.getCase(orgId, file.id, userId)?.materials).toHaveLength(1);
    expect(JSON.stringify([first, retry, listKbArticles(orgId), cases.getCase(orgId, file.id, userId)])).not.toContain('open-sesame');
  });
  it('keeps the saved original and reuses it after an indexing failure', async () => {
    const file = cases.createCase(orgId, userId, { title: 'Interrupted synthetic index' });
    const before = listKbArticles(orgId).length;
    const materials = '程序验收原始材料：付款主体及交货日期仍未核实；必须保留尾句 INDEX_TAIL_771。';
    vi.mocked(indexLegalArticle).mockRejectedValueOnce(new Error('synthetic indexing interruption'));
    const partial = await intake('legal_import_materials_to_kb', { caseId: file.id, materials });
    expect(partial.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(partial.content).toContain('原文已保存，向量索引未完成');
    const retry = await intake('legal_import_materials_to_kb', { caseId: file.id, materials });
    expect(retry.receipt).toMatchObject({ ok: true, status: 'imported' });
    expect(listKbArticles(orgId)).toHaveLength(before + 1);
    expect(cases.getCase(orgId, file.id, userId)?.materials).toHaveLength(1);
    expect(cases.getCase(orgId, file.id, userId)?.materials[0].content).toContain('INDEX_TAIL_771');
  });
  it('does not update the existing case or attachments during read-only message preview', async () => {
    const file = cases.createCase(orgId, userId, { title: 'Readonly synthetic case', notes: 'Original note', stage: 'consultation' });
    const before = JSON.stringify(cases.getCase(orgId, file.id, userId));
    const preview = await intake('legal_message_intake_to_case', { caseId: file.id, persistCase: false,
      message: '仅预览法院通知：2027年8月15日9时30分开庭，尚未核实。', attachments: [{ fileName: 'preview.txt', extractedText: 'Never archive this preview.' }] });
    expect(JSON.stringify(cases.getCase(orgId, file.id, userId))).toBe(before);
    expect(preview.receipt.changedCaseIds).toEqual([]);
    expect(preview.content).toContain('未入案'); expect(preview.content).not.toContain('已入案');
  });
  it('uses already bound original material instead of appending rewritten message or attachment content', async () => {
    const file = cases.createCase(orgId, userId, { title: 'Original bound message' });
    const materials = '原始消息：甲方仅主张已经付款，尚未核对原件；不得认定金额。';
    const result = await intake('legal_message_intake_to_case', { caseId: file.id, materials,
      message: 'MODEL_REWRITE_欠款已确认', attachments: [{ fileName: 'invented.txt', extractedText: 'MODEL_REWRITE_附件已确认' }] });
    expect(result.receipt.ok).toBe(true);
    const current = cases.getCase(orgId, file.id, userId)!;
    expect(current.materials).toHaveLength(1); expect(current.materials[0].content).toContain(materials);
    expect(JSON.stringify(current.materials)).not.toContain('MODEL_REWRITE_');
  });
});
