import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/regions/packs/cn/legal_tools/context', async original => ({ ...await original<Record<string, unknown>>(), runLegalLLM: vi.fn() }));
vi.mock('../server/regions/packs/cn/legal_tools/argument_drafting', () => ({ generateArgumentOrOpinionHandler: vi.fn() }));
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { generateArgumentOrOpinionHandler } from '../server/regions/packs/cn/legal_tools/argument_drafting';
import { analyzeFolderAndDraftArgumentHandler } from '../server/regions/packs/cn/legal_tools/folder_analysis';
import { encodeToolResult, decodeToolResult } from '../server/tools/result_envelope';
const folders: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-folder-receipt-')); folders.push(folder);
  fs.writeFileSync(path.join(folder, '原件.txt'), '仅验收：付款及交货条件尚未核实。\n'.repeat(2600) + 'SOURCE_TAIL_8981');
  return folder;
}
describe('folder completion follows existing typed argument receipt', () => {
  it('preserves the entire source and temporal inputs while a genuinely successful child receipt permits completion', async () => {
    const folder = fixture(); vi.mocked(runLegalLLM).mockResolvedValue('拟议分析，仍需核对原件。');
    vi.mocked(generateArgumentOrOpinionHandler).mockResolvedValue(encodeToolResult('代理词真实正文', { ok: true, status: 'generated' }));
    const result = decodeToolResult(await analyzeFolderAndDraftArgumentHandler({ folderPath: folder, writeFiles: false,
      factDate: '2018-03-01', procedureDate: '2026-10-13', temporalReviews: [{ statuteName: '虚构法源' }] }, {}));
    expect(result.receipt).toEqual({ ok: true, status: 'generated', analysisGenerated: true, argumentGenerated: true });
    expect(vi.mocked(runLegalLLM).mock.calls[0][0]).toContain('SOURCE_TAIL_8981');
    const args = vi.mocked(generateArgumentOrOpinionHandler).mock.calls[0][0];
    expect(args).toMatchObject({ facts: '', issues: [], factDate: '2018-03-01', procedureDate: '2026-10-13', temporalReviews: [{ statuteName: '虚构法源' }] });
    expect(args.materials).toContain('SOURCE_TAIL_8981');
  });
  it.each([
    ['structured child failure', encodeToolResult('代理词未完成；保留原文。', { ok: false, status: 'partial' })],
    ['unverified legacy prose', '代理词已完成，不能用这段话冒充真实回执'],
  ])('does not call the whole workflow complete on %s', async (_, child) => {
    const folder = fixture(); const output = path.join(folder, 'outputs');
    vi.mocked(runLegalLLM).mockResolvedValue('拟议分析文本。');
    vi.mocked(generateArgumentOrOpinionHandler).mockResolvedValue(child);
    const result = decodeToolResult(await analyzeFolderAndDraftArgumentHandler({ folderPath: folder, outputDir: output }, {}));
    expect(result.receipt).toEqual({ ok: false, status: 'partial', analysisGenerated: true, argumentGenerated: false });
    expect(result.content).toContain('处理未完成');
    expect(fs.readFileSync(path.join(output, '03_代理词草稿.md'), 'utf8')).toBe(decodeToolResult(child).content);
    expect(fs.readFileSync(path.join(output, '03_代理词草稿.md'), 'utf8')).not.toContain('LUMI_TOOL_RECEIPT:');
  });
  it('retains original text and reports partial when the analysis fails despite a completed child draft', async () => {
    const folder = fixture(); const output = path.join(folder, 'outputs');
    vi.mocked(runLegalLLM).mockResolvedValue('');
    vi.mocked(generateArgumentOrOpinionHandler).mockResolvedValue(encodeToolResult('代理词真实正文', { ok: true, status: 'generated' }));
    const result = decodeToolResult(await analyzeFolderAndDraftArgumentHandler({ folderPath: folder, outputDir: output }, {}));
    expect(result.receipt).toEqual({ ok: false, status: 'partial', analysisGenerated: false, argumentGenerated: true });
    const analysis = fs.readFileSync(path.join(output, '01_案情分析与争议焦点.md'), 'utf8');
    expect(analysis).toContain('案情分析未完成'); expect(analysis).toContain('SOURCE_TAIL_8981');
    expect(analysis).not.toContain('质量异议或拒付抗辩是否成立');
  });
});
