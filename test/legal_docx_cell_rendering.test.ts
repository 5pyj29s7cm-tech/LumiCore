import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { writeDocxFromMarkdown } from '../server/regions/packs/cn/legal_tools/documents';
import { buildBidChapters, resolveBidChapter, buildGroundedBidDraft } from '../server/regions/packs/cn/legal_work_product_quality';
import { assertBidMoneyClaims, buildBidMoneyContract } from '../server/regions/packs/cn/legal_bid_money';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import fixture from './fixtures/legal_bid_six_materials_164.json';

async function exportedXml(markdown: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-cell-render-'));
  try {
    const file = path.join(dir, 'response.docx');
    await writeDocxFromMarkdown(markdown, file);
    return await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml')!.async('string');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function cellText(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>/g)].map(match => match[1] === undefined ? '\n'
    : match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => entity === 'amp' ? '&' : entity === 'lt' ? '<' : entity === 'gt' ? '>' : entity === 'quot' ? '"' : "'")).join('');
}

describe('source-preserving legal Markdown cell rendering', () => {

  it('keeps literal source HTML, escaped entities, pipes and backslashes distinct from compiler cell breaks', async () => {
    const materials = [
      { id: 'literal-a', title: String.raw`虚构原件\\A|B<br>&lt;br&gt;.txt`, content: String.raw`R01【保真】原文含字面<br>、&lt;br&gt;、A|B及C:\\work\\case，不得改写。` },
      { id: 'literal-b', title: '第二原件TAIL', content: '第二段原文未提供，不表示不存在。' },
    ];
    const sources = buildMaterialSources(materials), chapters = buildBidChapters(sources);
    const entry = { sectionId: sources[0].id, sources, response: '拟议保留原文，来源和未知前提仍需核实，不声称已经完成。', missing: '材料待补，不表示客观不存在。' };
    const xml = await exportedXml(buildGroundedBidDraft('虚构字符保真', '', sources, chapters, new Map([['response', [entry]]])));
    const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(match => match[0]);
    expect(rows).toHaveLength(2);
    const cells = [...rows[1].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
    expect(cells).toHaveLength(6);
    expect(cellText(cells[1])).toBe(sources.map(source => source.id + '；' + source.title + '；' + source.locator).join('\n'));
    expect((cells[1].match(/<w:br\b/g) || [])).toHaveLength(1);
    expect(cellText(cells[2])).toBe(sources[0].quote);
    expect(cells[2]).not.toContain('<w:br');
    expect(cells[2]).toContain('&lt;br&gt;');
    expect(cells[2]).toContain('&amp;lt;br&amp;gt;');
    expect(xml).not.toContain('<script');
  });

  it('retains long source lists as native cell line breaks and allows natural row pagination', async () => {
    const materials = Array.from({ length: 24 }, (_, index) => ({ id: 'long-' + index,
      title: '来源' + index + '虚构完整标题'.repeat(8) + (index === 23 ? 'LASTSOURCE24' : ''),
      content: index ? '普通原始说明，未提供其他事实。' : 'R01【长来源】必须保留完整原件定位。' }));
    const sources = buildMaterialSources(materials), chapters = buildBidChapters(sources);
    const entry = { sectionId: sources[0].id, sources, response: '本项保留完整来源定位，实施前提和结论待核验，不用截短来源来伪装已完成。', missing: '前提待确认。' };
    const xml = await exportedXml(buildGroundedBidDraft('虚构长来源', '', sources, chapters, new Map([['response', [entry]]])));
    const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(match => match[0]);
    expect(rows).toHaveLength(2);
    const cells = [...rows[1].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
    expect(cellText(cells[1])).toBe(sources.map(source => source.id + '；' + source.title + '；' + source.locator).join('\n'));
    expect((cells[1].match(/<w:br\b/g) || [])).toHaveLength(23);
    expect(cells[1]).toContain('LASTSOURCE24');
    expect(rows[1]).not.toMatch(/<w:(?:cantSplit|trHeight|keepNext|keepLines)\b/);
    expect((xml.match(/<w:tblHeader\b/g) || [])).toHaveLength(1);
  });

  it('renders the five source-bound quotation fields without relaxing same-source money-role rejection', async () => {
    const sources = buildMaterialSources(fixture.materials), chapters = buildBidChapters(sources);
    const contract = buildBidMoneyContract(fixture.materials, sources);
    const response = chapters.find(chapter => chapter.id === 'response')!;
    const chosen = { ...response, sections: response.sections.filter(section => ['F41', 'F59'].includes(section.id)) };
    const values = { entries: [
      { sectionId: 'F41', sourceIds: ['F41', 'F42', 'F143'], response: '【F143|含税合计:254400.00元】\n【F143|未税合计:240000.00元】\n【F143|税额合计:14400.00元】', missing: '数量和设备型号待核实。' },
      { sectionId: 'F59', sourceIds: ['F59', 'F60', 'F122', 'F142'], response: '拟议培训2次，每次2小时，参与者名单待确认。\n\n【F142|未税单价:3000.00元】\n【F142|未税金额:6000.00元】', missing: '参与者名单待提供。' },
    ] };
    const accepted = assertBidMoneyClaims(resolveBidChapter(values, sources, chosen), contract);
    const xml = await exportedXml(buildGroundedBidDraft('虚构闭合报价', '', sources, [chosen], new Map([['response', accepted]])));
    const bodies = cellText(xml).split('拟议响应（模型工作稿，未作事实认定或核准）').slice(1).map(text => text.split('待补与核验')[0]).join('\n');
    for (const amount of ['254400.00元', '240000.00元', '14400.00元', '3000.00元', '6000.00元']) expect(bodies).toContain(amount);
    expect(bodies).toContain('报价表含税合计'); expect(bodies).toContain('培训');
    expect(bodies).not.toContain('【F');
    expect(() => assertBidMoneyClaims(accepted.map(entry => entry.sectionId === 'F59' ? { ...entry,
      response: entry.response.replace('未税金额:6000.00元', '未税合计:6000.00元') } : entry), contract)).toThrow('报价表金额字段或来源角色尚未核验');
  });

});
