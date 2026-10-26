import { describe, expect, it } from 'vitest';
import { extractStatuteReferences, normalizeStatuteReferenceTitle, checkStatuteProvision } from '../server/regions/packs/cn/statute_provisions';
const articles = (text: string) => extractStatuteReferences(text).filter(ref => /第[^《》]+条/.test(ref.citation));
describe('Scoped statute reference declarations', () => {
  it('normalizes cosmetic book-title styles without resolving an unknown law identity',()=>{
    expect(normalizeStatuteReferenceTitle('《关于适用〈未知风岚法〉的规定》')).toBe(normalizeStatuteReferenceTitle('关于适用《未知风岚法》的规定'));
    expect(normalizeStatuteReferenceTitle('  未知风岚法 ')).toBe('未知风岚法');
    expect(normalizeStatuteReferenceTitle('另一未知规则')).not.toBe(normalizeStatuteReferenceTitle('未知风岚法'));
  });
  it('uses an independent unique title inside the same Markdown section for list provisions', () => {
    const refs=articles('## 原文依据\n\n《未知星河法》（版本 2087）\n\n- **第十三条第二款**：“该款的完整引文。”\n- 第十九条：另一条正文。');
    expect(refs.map(ref=>ref.citation)).toEqual(['《未知星河法》第十三条第二款','《未知星河法》第十九条']);
    expect(refs[0].quotedText).toBe('该款的完整引文。');
    expect(refs[0]).toMatchObject({lawName:'未知星河法',articleKey:'13'});
  });
  it('reuses numeric addition and child-section parsing under one law heading', () => {
    expect(articles('### 《虚构清风条例》\n- 第7条之二：“附加条文”\n#### 细项\n- 第九条').map(ref=>ref.citation))
      .toEqual(['《虚构清风条例》第7条之二','《虚构清风条例》第九条']);
  });
  it('switches declarations and stops at an explicit different source', () => {
    expect(articles('## 范围\n《虚构甲法》\n- 第二条\n《虚构乙法》\n- 第三条\n- 《虚构丙法》第四条\n- 第五条').map(ref=>ref.citation))
      .toEqual(['《虚构甲法》第二条','《虚构乙法》第三条','《虚构丙法》第四条']);
  });
  it.each([
    '## 范围\n《虚构甲法》\n- 第二条\n## 新事项\n- 第三条',
    '### 范围\n《虚构甲法》\n- 第二条\n# 新事项\n- 第三条',
    '## 范围\n《虚构甲法》\n- 第二条\n这只是独立的其他事项。\n- 第三条',
  ])('does not carry an implicit title beyond its structural scope: %s', text => {
    expect(articles(text).map(ref=>ref.citation)).toEqual(['《虚构甲法》第二条']);
  });
  it.each([
    '我提到《虚构甲法》，下一句是别的事项。\n- 第三条',
    '《虚构甲法》与《虚构乙法》\n- 第三条',
    '> 《虚构甲法》\n- 第三条',
    '\x60\x60\x60text\n《虚构甲法》\n\x60\x60\x60\n- 第三条',
    '| 来源 |\n| --- |\n| 《虚构甲法》 |\n- 第三条',
    '“《虚构甲法》”\n- 第三条',
    '《虚构甲法》\n\n第三条可能适用于另一段论述。',
    '《虚构甲法》\n\n> - 第三条：“引用示例”',
  ])('does not join ordinary prose, ambiguous, quoted, code or table context: %s', text => {
    expect(articles(text)).toEqual([]);
  });
  it('keeps explicit bold references, nested titles and exact quoted text', () => {
    const refs=articles('**《未知规则》第十九条**：“显式引文”\n**《关于适用〈未知规则〉的规定》第二十八条第一款**：“另一引文”');
    expect(refs.map(ref=>[ref.lawName,ref.articleKey,ref.quotedText])).toEqual([
      ['未知规则','19','显式引文'],['关于适用〈未知规则〉的规定','28','另一引文']]);
  });
  it('keeps bold locator quotes with an intervening explanatory parenthesis', () => {
    const ref=articles('**《未知规则》第十九条**（原文）：“完整原句”')[0];
    expect(ref.quotedText).toBe('完整原句');
  });
  it.each([
    '| 《未知规则》第十条 | 原文 |',
    '> 《未知规则》第十条：“引文”',
    '    《未知规则》第十条',
    '```text\n《未知规则》第十条\n```',
  ])('preserves existing explicit citations in formatted material without inferring implicit scope: %s', text=>{
    expect(articles(text).map(ref=>ref.citation)).toEqual(['《未知规则》第十条']);
  });
  it.each([
    '**《未知规则》第十九条**：**“错误引文”**',
    '**《未知规则》第十九条（原文）**：“错误引文”',
    '**《未知规则》第十九条**（原文）：**“错误引文”**',
    '__《未知规则》第十九条__：__“错误引文”__',
  ])('retains a same-line literal quotation across emphasis boundaries and bounded labels: %s', text=>{
    const ref=articles(text)[0];
    expect(ref.quotedText).toBe('错误引文');
    const check=checkStatuteProvision(ref.citation,{recordId:'fixture',versionDate:'2087-01-01',fetchedAt:'2087-02-01',sourceUrl:'https://authority.invalid/fixture',sha256:'a'.repeat(64),
      provisions:{'19':{text:'这是唯一实际原文。',paragraphs:['这是唯一实际原文。']}}},ref.quotedText);
    expect(check.quotationVerified).toBe(false);
    expect(check.verificationStatus).toBe('text_mismatch');
  });
  it.each([
    '《未知规则》第十九条\n“另一段的内容”',
    '《未知规则》第十九条'+ '('+'长'.repeat(161)+')'+'：“另一事项”',
    '《未知规则》第十九条 无关散文：“另一事项”',
  ])('does not join a later line or unbounded commentary into a literal quote: %s', text=>{
    expect(articles(text)[0].quotedText).toBeUndefined();
  });
  it('keeps explicit same-line shared-title citations and does not attach a later paragraph', () => {
    expect(articles('《未知规则》第十三条、第二十条\n\n第八条是独立散文。').map(ref=>ref.citation))
      .toEqual(['《未知规则》第十三条','《未知规则》第二十条']);
  });
});

describe('Explicit Markdown locator and adjacent literal blockquotes', () => {
  const snapshot = { recordId: 'fixture', versionDate: '2087-01-01', fetchedAt: '2087-02-01', sourceUrl: 'https://authority.invalid/fixture', sha256: 'a'.repeat(64),
    provisions: { '17': { text: '第一款实际原文。\n\n第二款实际原文。', paragraphs: ['第一款实际原文。', '第二款实际原文。'] } } };
  it.each(['**', '__', '*', '_'])('binds a paired same-line locator wrapper %s to its exact title', marker => {
    const refs = articles('《未知证据规则》' + marker + '第十七条第二款' + marker + '：“第二款实际原文。”');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ citation: '《未知证据规则》第十七条第二款', articleKey: '17', quotedText: '第二款实际原文。' });
  });
  it('attaches consecutive adjacent quote lines and removes only paired display emphasis', () => {
    const refs = articles('《未知证据规则》**第十七条**：\n\n> 第一款**实际**原文。\n> 第二款__实际__原文。');
    expect(refs).toHaveLength(1);
    expect(refs[0].quotedText).toBe('第一款实际原文。\n第二款实际原文。');
    expect(checkStatuteProvision(refs[0].citation, snapshot, refs[0].quotedText).quotationVerified).toBe(true);
  });
  it('retains strict mismatch and paragraph-location failure after parsing the display form', () => {
    const wrong = articles('《未知证据规则》**第十七条第二款**：\n> 错误的原文。')[0];
    expect(wrong.quotedText).toBe('错误的原文。');
    expect(checkStatuteProvision(wrong.citation, snapshot, wrong.quotedText).verificationStatus).toBe('text_mismatch');
    const missing = articles('《未知证据规则》**第十七条第三款**：\n> 第二款实际原文。')[0];
    expect(checkStatuteProvision(missing.citation, snapshot, missing.quotedText).verificationStatus).toBe('not_found');
  });
  it.each([
    '《未知证据规则》第十七条：\n## 另一事项\n> 不属于上条的文字。',
    '《未知证据规则》第十七条：\n《另一未知规则》第一条：\n> 不属于上条的文字。',
    '《未知证据规则》第十七条：\n另一段普通解释。\n> 不属于上条的文字。',
    '《未知证据规则》第十七条：\n```text\n> 不属于上条的文字。\n```',
    '```text\n《未知证据规则》第十七条：\n> 示例代码内的文字。\n```',
  ])('does not attach a quote across structural or code boundaries: %s', text => {
    expect(articles(text)[0].quotedText).toBeUndefined();
  });
  it('stops one literal block before a new cited law, heading or code fence', () => {
    for (const boundary of ['> 《另一未知规则》第一条：', '> ## 另一标题', '> ```text']) {
      const refs = articles('《未知证据规则》第十七条第二款：\n> 第二款实际原文。\n' + boundary + '\n> 不能归入上条。');
      expect(refs[0].quotedText).toBe('第二款实际原文。');
    }
  });
  it.each([
    '《未知证据规则》**第十七条*',
    '《未知证据规则》**\n第十七条**',
    '《未知证据规则》解释另一事项 **第十七条**',
  ])('does not repair unpaired, cross-line or intervening-prose locators: %s', text => {
    expect(articles(text)).toEqual([]);
  });
  it('does not treat unpaired emphasis or a later separate block as verified quote text', () => {
    const refs = articles('《未知证据规则》第十七条第二款：\n> 第二款**实际原文。\n\n> 后一个独立块。');
    expect(refs[0].quotedText).toBe('第二款**实际原文。');
    expect(checkStatuteProvision(refs[0].citation, snapshot, refs[0].quotedText).verificationStatus).toBe('text_mismatch');
  });
});
