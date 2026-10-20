import './helpers';
import { describe, expect, it } from 'vitest';
import { buildLitigationPacketDrafts, type LitigationAnalysisEntry } from '../server/regions/packs/cn/legal_tools/litigation_drafts';
import type { EvidenceReviewRow } from '../server/regions/packs/cn/legal_tools/case_workflow';

const quote = '虚构民事起诉状文字摘录已提供；主张不是法院认定或双方确认，原件与完整材料仍待核验。';
const ownQuote = '我方材料不表示对方承认，亦不能证明对方从未承认。';
function row(index: number, name: string, content: string): EvidenceReviewRow {
  return { index, name, fact: '', proofPurpose: '', authenticity: '', legality: '', relevance: '', gap: '',
    materialId: 'synthetic-material-' + index, sourceLabel: '已登记原始文字；原件未核验',
    sources: [{ id: 'F' + index, materialId: 'synthetic-material-' + index, title: name, quote: content, locator: '提供材料正文第1行' }],
    pendingCompilation: false, proposals: [] };
}
const rows = [row(1, '虚构对方诉状摘录', quote), row(2, '虚构我方说明', ownQuote)];
const analysis: LitigationAnalysisEntry = { sectionId: 'evidence', sources: rows.flatMap(r => r.sources),
  response: '现有摘录仅用于条件分析，不能把未核实写成否定事实。', missing: '原件、材料归属及证明力仍待核验。' };
const analyses = new Map([['21_cross-examination-opinion', [analysis]]]);
const args = { caseName: '虚构旧材料模板验收', parties: '虚构原告/虚构被告', claims: '仅按已提供材料形成条件答辩' };
function byName(drafts: ReturnType<typeof buildLitigationPacketDrafts>, name: string) {
  return drafts.find(d => d.baseName === name)!.markdown;
}

describe('litigation template uses registered originals without contradictory empty placeholders', () => {
  it.each([undefined, '', ' \n\t '])('omits the duplicate opponent section when no explicit material block exists: %j', opponentMaterials => {
    const drafts = buildLitigationPacketDrafts({ ...args, opponentMaterials }, '被告', rows, analyses);
    const defense = byName(drafts, '20_statement-of-defense');
    const cross = byName(drafts, '21_cross-examination-opinion');
    expect(defense).not.toContain('## 对方诉请及材料');
    expect(cross).not.toContain('## 对方材料范围');
    for (const document of [defense, cross]) {
      expect(document).not.toContain('［对方起诉状及证据材料待补充］');
      expect(document).toContain(quote);
      expect(document).toContain(ownQuote);
      expect(document).toContain('F1');
      expect(document).toContain('F2');
    }
    expect(defense).toContain('## 答辩目标\n' + args.claims);
    expect(defense).toContain('［受理/审理法院待补充］');
    expect(defense).toContain('［待签字/盖章］');
    expect(cross).toContain(analysis.response);
    expect(cross).toContain(analysis.missing);
  });

  it('retains an explicitly supplied opponent block verbatim without treating the other registered originals as opponent evidence', () => {
    const opponentMaterials = '仅本段由用户明确指定为对方材料。\n原件未核验，不表示全部事实已确认。';
    const drafts = buildLitigationPacketDrafts({ ...args, opponentMaterials }, '被告', rows, analyses);
    expect(byName(drafts, '20_statement-of-defense')).toContain('## 对方诉请及材料\n' + opponentMaterials);
    expect(byName(drafts, '21_cross-examination-opinion')).toContain('## 对方材料范围\n' + opponentMaterials);
    expect(byName(drafts, '20_statement-of-defense')).toContain(ownQuote);
  });

  it.each(['原告', '被告', '通用'] as const)('keeps one complete evidence catalog for %s without a duplicate placeholder matrix', role => {
    const purpose = '拟议用途：核对材料原句；不能据此认定对方已经承认。';
    const input = rows.map(row => ({ ...row, proofPurpose: purpose, authenticity: '原件待核', legality: '取得方式待核', relevance: '与争点对应关系待核' }));
    const snapshot = JSON.stringify(input);
    const drafts = buildLitigationPacketDrafts(args, role, input);
    expect(drafts.some(document => document.baseName === '03_evidence-review-matrix')).toBe(false);
    const catalog = drafts.find(document => /^(16_|27_)/.test(document.baseName))!.markdown;
    for (const text of [quote, ownQuote, purpose, '真实性：原件待核', '合法性：取得方式待核', '关联性：与争点对应关系待核']) expect(catalog).toContain(text);
    expect(catalog).not.toContain('见03证据审查矩阵');
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.each(['原告', '被告', '通用'] as const)('retains temporal verification and lawyer review for %s without forcing current law', role => {
    const temporalArgs = { ...args, factDate: '2000-01-01', procedureDate: '2026-10-01' };
    const before = JSON.stringify(temporalArgs);
    const drafts = buildLitigationPacketDrafts(temporalArgs, role, []);
    for (const document of drafts) {
      expect(document.markdown).not.toContain('现行有效');
      expect(document.markdown).toContain('案件相应时间适用版本');
      expect(document.markdown).toContain('案件相应时间适用法律');
      expect(document.markdown).toContain('律师复核');
      expect(document.markdown).not.toContain('时效已经届满');
    }
    expect(JSON.stringify(temporalArgs)).toBe(before);
  });
});
