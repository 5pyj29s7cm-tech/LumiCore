import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import * as sources from '../server/legal/sources';
import * as kb from '../server/legal/kb';
import { searchOfficialStatuteRecords, officialQueryLocator } from '../server/legal/statute_authority_refresh';
import { statuteEffectivenessLabel, statuteSourceLanguage } from '../server/regions/messages/statute_source_messages';
import { searchStatuteHandler } from '../server/regions/packs/cn/legal_tools/knowledge';
import { searchExternalAuthoritiesHandler } from '../server/regions/packs/cn/legal_tools/company_research';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
let serial = 0;
async function fixture(mode: 'readable' | 'metadata-only' = 'readable', status = 3) {
  const title = `虚构国际化${++serial}法`;
  const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(title),
    new Paragraph('第一条　来源原文甲事项。'), new Paragraph('第二条　来源原文乙事项。')] }] }));
  const row = { title, bbbs: 'synthetic-' + serial, gbrq: '2004-01-01', sxrq: '2004-07-01', sxx: status,
    zdjgName: '虚构机关', flxz: '合成类别', content: [{ title: '第一条' }, { title: '第二条' }], ossFile: { ossWordPath: 'synthetic-original.docx' } };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/law-search/search/list') return new Response(JSON.stringify({ code: 200, rows: [row] }));
    if (url.pathname === '/law-search/download/pc') {
      if (mode === 'metadata-only') throw new Error('Synthetic original unavailable');
      return new Response(JSON.stringify({ code: 200, data: { url: 'https://flkoss.obs-bj2.cucloud.cn/synthetic-original.docx' } }));
    }
    if (url.href === 'https://flkoss.obs-bj2.cucloud.cn/synthetic-original.docx') return new Response(new Uint8Array(original));
    throw new Error('Unexpected request denied by isolated fixture: ' + url.href);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { title, row, fetchMock };
}

describe('official source localization preserves authoritative evidence', () => {
  it.each([['zh', '来源名称：', '现行有效'], ['en', 'Source title: ', 'In force']] as const)('localizes %s metadata while preserving source text and identities', async (language, label, status) => {
    const f = await fixture();
    const result = (await sources.searchFLK(f.title, language))[0];
    expect(result.status).toBe(status); expect(result.title).toBe(f.title); expect(result.docId).toBe(f.row.bbbs);
    expect(result.sourceText).toContain(label + f.title);
    expect(result.sourceText).toContain('第1条\n来源原文甲事项。');
    expect(result.statuteSource).toMatchObject({ recordId: f.row.bbbs, effectivenessCode: 3, versionDate: '2004-01-01' });
    expect(result.statuteSource?.originalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty('_sourceTextByLanguage'); expect(result).not.toHaveProperty('_originalCache');
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('switches whole-result display language without a source request or changed evidence', async () => {
    const f = await fixture();
    const zh = (await sources.searchFLK(f.title, 'zh'))[0];
    const en = (await sources.searchFLK(f.title, 'en'))[0];
    const back = (await sources.searchFLK(f.title, 'zh'))[0];
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    expect(en.sourceText).toContain('Source title: '); expect(en.sourceText).not.toContain('来源名称：');
    expect(en.statuteSource).toEqual(zh.statuteSource); expect(en.queriedAt).toBe(zh.queriedAt);
    expect(en.url).toBe(zh.url); expect(en.sourceEndpoint).toBe(zh.sourceEndpoint);
    expect(back).toEqual(zh);
  });

  it('reprojects selected cached provisions in English without expanding scope or refetching', async () => {
    const f = await fixture();
    const whole = (await sources.searchFLK(f.title, 'zh'))[0];
    const selected = (await sources.searchFLK(f.title + ' 第二条 第九条', 'en'))[0];
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    expect(selected.sourceText).toContain('no new online query was made');
    expect(selected.sourceText).toContain('第2条\n来源原文乙事项。');
    expect(selected.sourceText).toContain('第9条: Not located in this read');
    expect(selected.sourceText).not.toContain('来源原文甲事项。');
    expect(selected.statuteSource?.requestedArticleKeys).toEqual(['2', '9']);
    expect(Object.keys(selected.statuteSource?.provisions || {})).toEqual(['2']);
    expect(selected.statuteSource?.originalSha256).toBe(whole.statuteSource?.originalSha256);
    expect(selected.statuteSource?.queriedAt).toBe(whole.statuteSource?.queriedAt);
  });

  it('localizes cached metadata-only failure without retrying or inventing original content', async () => {
    const f = await fixture('metadata-only', 1);
    const zh = (await sources.searchFLK(f.title, 'zh'))[0];
    const en = (await sources.searchFLK(f.title, 'en'))[0];
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    expect(zh.status).toBe('已废止'); expect(en.status).toBe('Repealed');
    expect(en.sourceText).toContain('body extraction did not finish: Synthetic original unavailable');
    expect(en.sourceText).not.toContain('来源原文甲事项'); expect(en.statuteSource?.originalSha256).toBeUndefined();
    expect(en.statuteSource?.provisions).toEqual({}); expect(en.statuteSource).toEqual(zh.statuteSource);
  });

  it('propagates explicit English context through the source database API without renaming the source', async () => {
    const f = await fixture();
    const result = (await sources.searchLegalAuthorityDatabase({ query: f.title, type: 'law', sourceIds: ['flk'], includeOfficialWeb: true, language: 'en' }))[0];
    expect(result.sourceId).toBe('national-law-regulations'); expect(result.sourceName).toBe('国家法律法规数据库');
    expect(result.effectiveStatus).toBe('In force'); expect(result.sourceText).toContain('Original query: ' + f.title);
    expect(result.statuteSource?.recordId).toBe(f.row.bbbs);
  });

  it('preserves Chinese citation grammar, ambiguous-title rejection and canonical added-article labels', async () => {
    expect(officialQueryLocator('《虚构测试法》第十二条之一')).toEqual({ title: '虚构测试法', articleKeys: ['12-1'] });
    expect(officialQueryLocator('《虚构甲法》 《虚构乙法》 第三条')).toBeUndefined();
    const f = await fixture();
    const row = (await searchOfficialStatuteRecords(f.title + ' 第十二条之一', 5, 'en'))[0];
    expect(row.sourceText).toContain('第12条之1: Not located in this read');
    expect(row.statuteSource.provisions).toEqual({});
  });

  it.each([[1, '已废止', 'Repealed'], [2, '已修改', 'Amended'], [3, '现行有效', 'In force'], [4, '尚未生效', 'Not yet effective'], [99, '未知', 'Unknown']] as const)('keeps official effectiveness code %i independent from presentation', (code, zh, en) => {
    expect(statuteEffectivenessLabel(code, 'zh')).toBe(zh); expect(statuteEffectivenessLabel(code, 'en')).toBe(en);
  });
});

describe('tool entry language context', () => {
  it.each([searchStatuteHandler, searchExternalAuthoritiesHandler])('uses the current English user text independently of a Chinese statute query', async handler => {
    vi.spyOn(kb, 'searchStatutes').mockResolvedValue([]);
    const search = vi.spyOn(sources, 'searchLegalAuthorityDatabase').mockResolvedValue([]);
    await handler({ query: '中华人民共和国虚构测试法', persistCase: false, includeOfficialWeb: true }, {
      userId: 'synthetic-user', actionIntent: '此前中文任务', completionRequest: { currentText: 'Please show the original source and its metadata in English.' },
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: '中华人民共和国虚构测试法', language: 'en' }));
  });
  it.each([searchStatuteHandler, searchExternalAuthoritiesHandler])('keeps the compatible Chinese default without user-language context', async handler => {
    vi.spyOn(kb, 'searchStatutes').mockResolvedValue([]);
    const search = vi.spyOn(sources, 'searchLegalAuthorityDatabase').mockResolvedValue([]);
    await handler({ query: 'Synthetic source identifier', persistCase: false }, { userId: 'synthetic-user' });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ language: 'zh' }));
  });
  it('uses Chinese user instructions and does not infer a locale from a returned source title', () => {
    expect(statuteSourceLanguage('请显示来源元数据。')).toBe('zh'); expect(statuteSourceLanguage()).toBe('zh');
  });
});
