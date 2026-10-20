import { describe, expect, it } from 'vitest';
import { applyLegalDocumentReview, legalDocumentBatchReviewPrompt } from '../server/regions/packs/cn/legal_document_grounding';

const original = '# 文书草稿\n双方确认总价九万元，已有付款记录七万元，剩余二万元。原告多次催讨未付，已构成违约。付款期限未提供。';
const edit = { original: '原告多次催讨未付，已构成违约。', replacement: '催告事实及到期时间须另行核实。', reason: '材料没有催告或期限记录。' };
describe('legal document fact review', () => {
  it('locates model corrections by server-provided line number, including repeated lines', () => {
    const result = applyLegalDocumentReview({ complete: true, unresolved: [], corrections: [{ paragraphId: 'P3', replacement: '本行事实须核实。', reason: '第二处也不能断言催告。' }] }, original + '\n' + original.split('\n')[1]);
    expect(result.errors).toEqual([]);
    expect(result.markdown.endsWith('本行事实须核实。')).toBe(true);
    expect(result.markdown.startsWith(original)).toBe(true);
  });
  it('accepts a complete located correction when the optional commentary is omitted', () => {
    expect(applyLegalDocumentReview({ complete: true, corrections: [{ paragraphId: 'P2', replacement: '双方确认总价九万元，已有付款记录七万元，剩余二万元的期限和是否构成违约尚需核实。' }] }, original).errors).toEqual([]);
  });
  it('applies only exact non-overlapping replacements and preserves the supplied amounts', () => {
    const result = applyLegalDocumentReview({ complete: true, corrections: [edit], unresolved: [] }, original);
    expect(result.errors).toEqual([]);
    expect(result.markdown).toContain('已有付款记录七万元，剩余二万元');
    expect(result.markdown).not.toContain('多次催讨');
  });
  it.each([
    null, { complete: false, corrections: [], unresolved: [] },
    { complete: true, corrections: [], unresolved: ['仍有无依据事实'] },
    { complete: true, corrections: [{ ...edit, original: '不存在的原文' }], unresolved: [] },
    { complete: true, corrections: [edit, edit], unresolved: [] },
    { complete: true, corrections: [{ ...edit, replacement: null }], unresolved: [] },
  ])('rejects incomplete or ungrounded edits without partially modifying the draft', value => {
    const result = applyLegalDocumentReview(value, original);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.markdown).toBe(original);
  });
  it('does not silently replace several identical spans', () => {
    expect(applyLegalDocumentReview({ complete: true, corrections: [edit], unresolved: [] }, original + original).errors).toContain('文书修正未能唯一对应原文。');
  });
  it('keeps unsupported assertions distinct from source-supported conditional drafts in the existing batch review', () => {
    const sources = 'S1 原文：履行情况与原件形式均待核实；本次仅请求交付设备。';
    const draft = '# 待核稿\n请求附加费用；原件无签章；对方未履行。待补证。';
    const prompt = legalDocumentBatchReviewPrompt([{ baseName: 'current', markdown: draft }], sources);
    expect(prompt).toContain(sources);
    expect(prompt).toContain('请求附加费用；原件无签章；对方未履行。待补证。');
    expect(prompt).toContain('只有有来源支持的条件草稿才属于核对完成');
    expect(prompt).toContain('确定性法律或证据资格结论须有本次提供的法律来源支持');
    expect(prompt).not.toContain('条件或待补证的，属于核对完成');
    const result = applyLegalDocumentReview({ complete: true, corrections: [{ paragraphId: 'P2', replacement: '仅请求交付设备；履行情况及原件形式待核，不能据此作确定性结论，须将原始合同、付款对应关系和履行情况逐一核对。' }], unresolved: [] }, draft);
    expect(result.errors).toEqual([]);
    expect(result.markdown).not.toContain('附加费用');
    expect(result.markdown).not.toContain('无签章');
    expect(result.markdown).toContain('仅请求交付设备');
  });
  it('counts only changed replacements while retaining duplicate and overlap checks for no-op entries', () => {
    const unchanged = applyLegalDocumentReview({ complete: true, corrections: [{ paragraphId: 'P2', replacement: original.split('\n')[1], reason: '保持原行。' }], unresolved: [] }, original);
    expect(unchanged.errors).toEqual([]);
    expect(unchanged.corrections).toBe(0);
    expect(unchanged.markdown).toBe(original);
    const overlap = applyLegalDocumentReview({ complete: true, corrections: [{ paragraphId: 'P2', replacement: original.split('\n')[1] }, { paragraphId: 'P2', replacement: '不得重复覆盖同一来源行。' }], unresolved: [] }, original);
    expect(overlap.errors).toContain('文书修正片段相互重叠。');
    expect(overlap.markdown).toBe(original);
  });
});
