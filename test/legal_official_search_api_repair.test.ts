import { afterEach, describe, expect, it, vi } from 'vitest';
import './helpers';
import { searchFLK, searchLegalAuthorityDatabase } from '../server/legal/sources';
import { searchOfficialStatuteRecords } from '../server/legal/statute_authority_refresh';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const detail = (id: string, title: string, sxx = 3) => ({ bbbs: id, title, sxx, gbrq: '2004-01-01', sxrq: '2004-07-01', zdjgName: '虚构发布机关', content: { children: [{ title: '第一条', text: 'OFFICIAL-SOURCE-TAIL' }] } });
const sequence = (...values: Response[]) => vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => { const next = values.shift(); if (!next) throw new Error('Unexpected official request'); return next; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Official legal search uses the existing structured authority owner', () => {
  it.each([
    ['《银河交通条例》 实际事项与责任', '银河交通条例'],
    ['虚构流光法 义务事项 后续条件', '虚构流光法'],
  ])('queries an explicit title before whitespace-separated topics: %s', async (query, title) => {
    const fetchMock = sequence(json({ code: 200, rows: [detail('topic-record', title)] }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await searchOfficialStatuteRecords(query))[0].details.title).toBe(title);
    expect(fetchMock.mock.calls.slice(0, 1).map(call => JSON.parse(String(call[1]?.body)).searchContent)).toEqual([title]);
  });

  it.each([
    '《银河交通条例》 《虚构流光法》 事项',
    '银河交通条例 虚构流光法 事项',
    '《银河交通条例》第三条 《虚构流光法》第四条',
    '银河交通条例 第三条 虚构流光法第四条',
  ])('does not merge multiple explicit statute titles into one fallback query: %s', async query => {
    const fetchMock = sequence(json({ code: 200, rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchOfficialStatuteRecords(query)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['verified-outline', 'missing-outline', 'download-failure'])('puts actual source identity and dates before body without duplicating its raw directory: %s', async mode => {
    const { Document, Packer, Paragraph } = await import('docx');
    const title = '虚构星潮规范';
    const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(title), new Paragraph('第一条　唯一实际原件正文。')] }] }));
    const sourcePath = 'official-read/metadata-front.docx';
    const metadata = { ...detail('metadata-' + mode, title, 1), gbrq: '1997-03-14', sxrq: '1998-09-01', zdjgName: '未知合成机关', flxz: '合成规范类别',
      content: mode === 'missing-outline' ? null : { children: [{ title: '第一条', outlineOnly: 'DIRECTORY-ONLY-BLOAT'.repeat(1000) }] },
      ossFile: { ossWordPath: sourcePath }, extraInternalField: 'RAW-INTERNAL-PROOF' };
    const fetchMock = sequence(json({ code: 200, rows: [metadata] }), json({ code: 200, data: { url: 'https://flkoss.obs-bj2.cucloud.cn/' + (mode === 'download-failure' ? 'wrong.docx' : sourcePath) } }), new Response(new Uint8Array(original)));
    vi.stubGlobal('fetch', fetchMock);
    const row = (await searchOfficialStatuteRecords('合成前置元数据-' + mode))[0];
    expect(row.details).toEqual(metadata);
    const evidence = (row as any).statuteSource;
    expect(evidence).toMatchObject({sourceId:'national-law-regulations',title,recordId:metadata.bbbs,versionDate:'1997-03-14',effectiveDate:'1998-09-01',effectivenessCode:1,sourceUrl:row.sourceUrl,queriedAt:row.queriedAt,provisions:{}});
    if(mode==='download-failure') expect(evidence.originalSha256).toBeUndefined();
    else {
      const {createHash}=await import('node:crypto'); const {extractRawText}=await import('mammoth');
      expect(evidence.originalSha256).toBe(createHash('sha256').update((await extractRawText({buffer:original})).value).digest('hex'));
    }
    for (const field of ['公布日期：1997-03-14', '施行日期：1998-09-01', '效力代码：1', '制定机关：未知合成机关', metadata.bbbs, title, sourcePath]) {
      expect(row.sourceText.indexOf(field)).toBeGreaterThanOrEqual(0);
      expect(row.sourceText.indexOf(field)).toBeLessThan(1000);
    }
    expect(row.sourceText).not.toContain('DIRECTORY-ONLY-BLOAT');
    expect(row.sourceText).not.toContain('RAW-INTERNAL-PROOF');
    expect(row.sourceText.length).toBeLessThan(2500);
    if (mode === 'download-failure') {
      expect(row.sourceText).toContain('正文提取未完成：Official text download location mismatch');
      expect(row.sourceText).not.toContain('唯一实际原件正文。');
    } else {
      expect(row.sourceText.indexOf('施行日期：1998-09-01')).toBeLessThan(row.sourceText.indexOf('唯一实际原件正文。'));
    }
  });

  it.each([
    ['《虚构晶石规则》第十三条', '虚构晶石规则', '13'],
    ['虚构云帆法 第三编 责任 第十九条', '虚构云帆法', '19'],
    ['《陌生实体规范》 第7条之二', '陌生实体规范', '7-2'],
  ])('adapts an explicit title and locator while preserving the original query: %s', async (query, title, article) => {
    const { Document, Packer, Paragraph } = await import('docx');
    const paragraphs = [new Paragraph(title)];
    for (let n = 1; n <= 20; n++) {
      paragraphs.push(new Paragraph('第' + n + '条　原文项目-' + n + '：' + '条文背景内容。'.repeat(70)));
      if (n === 7) paragraphs.push(new Paragraph('第7条之二　附加条文实际文字。'));
    }
    const original = await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
    const filePath = 'official-read/located-article.docx';
    const fetchMock = sequence(json({ code: 200, rows: [{ ...detail('located-' + article, title), content: { children: [{ title: '第二十条' }] }, ossFile: { ossWordPath: filePath } }] }), json({ code: 200, data: { url: 'https://flkoss.obs-bj2.cucloud.cn/' + filePath } }), new Response(new Uint8Array(original)));
    vi.stubGlobal('fetch', fetchMock);
    const row = (await searchOfficialStatuteRecords(query))[0];
    expect(fetchMock.mock.calls.slice(0, 1).map(call => JSON.parse(String(call[1]?.body)).searchContent)).toEqual([title]);
    expect(row.sourceText).toContain(query);
    const expectedBody = article === '7-2' ? '附加条文实际文字。' : '原文项目-' + article + '：';
    expect(row.sourceText!.indexOf(expectedBody)).toBeGreaterThanOrEqual(0);
    expect(row.sourceText!.indexOf(expectedBody)).toBeLessThan(1000);
    expect(row.sourceText).not.toContain('原文项目-1：');
    expect(row.sourceText).not.toContain('原文项目-20：');
    expect(row.sourceText).toContain('本次仅返回明确请求的条文');
    expect(row.sourceText.length).toBeLessThan(2500);
    expect(row.sourceText.split(expectedBody)).toHaveLength(2);
    const evidence=(row as any).statuteSource;
    expect(Object.keys(evidence.provisions)).toEqual([article]);
    expect(evidence.requestedArticleKeys).toEqual([article]);
    expect(evidence.provisions[article].text).toContain(expectedBody);
    expect(evidence).toMatchObject({title,recordId:'located-'+article,versionDate:'2004-01-01',effectiveDate:'2004-07-01',effectivenessCode:3,sourceUrl:row.sourceUrl});
    expect(evidence.originalSha256).toMatch(/^[a-f0-9]{64}$/);
  });


  it.each(['partial-missing', 'all-missing', 'missing-outline'])('projects only requested unknown provisions and honestly marks unavailable articles: %s', async mode => {
    const { Document, Packer, Paragraph } = await import('docx');
    const title = '虚构穹顶办法';
    const query = mode === 'all-missing' ? '《' + title + '》第九十九条' : '《' + title + '》第四条、第十七条、第九十九条';
    const paragraphs = [new Paragraph(title)];
    for (let n=1;n<=20;n++) paragraphs.push(new Paragraph('第' + n + '条　独立正文-' + n + '：' + '本条全部实际文字。'.repeat(20)));
    const original = await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
    const filePath = 'official-read/requested-only-' + mode + '.docx';
    vi.stubGlobal('fetch', sequence(json({code:200,rows:[{...detail('projection-'+mode,title),content:mode==='missing-outline'?null:{children:[{title:'第二十条'}]},ossFile:{ossWordPath:filePath}}]}), json({code:200,data:{url:'https://flkoss.obs-bj2.cucloud.cn/'+filePath}}), new Response(new Uint8Array(original))));
    const row=(await searchOfficialStatuteRecords(query))[0];
    expect(row.sourceText).toContain('第99条：本次未定位，未取得该条正文');
    expect(row.sourceText).not.toContain('独立正文-1：');expect(row.sourceText).not.toContain('独立正文-20：');
    expect(row.sourceText.length).toBeLessThan(2500);
    if(mode==='all-missing'){expect(row.sourceText).not.toContain('独立正文-4：');expect(row.sourceText).not.toContain('独立正文-17：');}
    else {expect(row.sourceText).toContain('独立正文-4：'+'本条全部实际文字。'.repeat(20));expect(row.sourceText).toContain('独立正文-17：'+'本条全部实际文字。'.repeat(20));}
    if(mode==='missing-outline'){expect(row.sourceText).toContain('未作外部条数或完整性核验');expect(row.sourceText).not.toContain('条号与官方目录一致');}
    else expect(row.sourceText).toContain('条号与官方目录一致');
    expect(row.details.ossFile?.ossWordPath).toBe(filePath);
    const evidence=(row as any).statuteSource;
    expect(Object.keys(evidence.provisions)).toEqual(mode==='all-missing'?[]:['4','17']);
    expect(evidence.provisions['99']).toBeUndefined();
    expect(evidence.requestedArticleKeys).toEqual(mode==='all-missing'?['99']:['4','17','99']);
    expect(evidence.originalSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['运输损害 原因 第三条', '合同违约责任', '发生在第二章附近的争议'])('keeps a thematic query unchanged without guessing a statute title: %s', async query => {
    const fetchMock = sequence(json({ code: 200, rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchOfficialStatuteRecords(query)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).searchContent).toBe(query);
  });

  it('does not invent a hit after both the original query and explicit title return empty', async () => {
    const query = '《虚构未登记条例》第四条';
    const fetchMock = sequence(json({ code: 200, rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchOfficialStatuteRecords(query)).toEqual([]);
    expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).searchContent)).toEqual(['虚构未登记条例']);
  });

  it.each(['readable-original', 'wrong-title', 'wrong-download-path'])('reads an original without an outline only at its proven scope: %s', async mode => {
    const { Document, Packer, Paragraph } = await import('docx');
    const title = '虚构无目录来源法规';
    const original = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph(mode === 'wrong-title' ? '另一来源标题' : title), new Paragraph('第一条　原件载明的甲事项。'), new Paragraph('第二条　原件载明的乙事项。'),
    ] }] }));
    const sourcePath = 'official-read/no-outline.docx';
    const sourceUrl = 'https://flkoss.obs-bj2.cucloud.cn/' + (mode === 'wrong-download-path' ? 'other.docx' : sourcePath);
    const fetchMock = sequence(json({ code: 200, rows: [{ ...detail('no-outline-' + mode, title), content: null, ossFile: { ossWordPath: sourcePath } }] }), json({ code: 200, data: { url: sourceUrl } }), new Response(new Uint8Array(original)));
    vi.stubGlobal('fetch', fetchMock);
    const row = (await searchOfficialStatuteRecords('空目录原件-' + mode))[0];
    expect(fetchMock).toHaveBeenCalledTimes(mode === 'wrong-download-path' ? 2 : 3);
    if (mode === 'readable-original') {
      expect(row.sourceText).toContain('原件载明的甲事项。');
      expect(row.sourceText).toContain('原件载明的乙事项。');
      expect(row.sourceText).toContain('未作外部条数或完整性核验');
      expect(row.sourceText).not.toContain('已提取并核对全部');
      expect(row.sourceText).not.toContain('正文提取未完成');
    } else {
      expect(row.sourceText).toContain('正文提取未完成');
      expect(row.sourceText).not.toContain('原件载明的甲事项。');
      expect(row.sourceText).not.toContain('已提取并核对全部');
    }
  });

  it('reads and verifies the official original through the existing DOCX chain before exposing statutory bodies', async () => {
    const { Document, Packer, Paragraph } = await import('docx');
    const title = '虚构正文核对法规';
    const original = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph(title), new Paragraph('第一条　原件第一项明确义务。'), new Paragraph('第二条　原件第二项适用条件。'),
    ] }] }));
    const sourcePath = 'official-read/verified-source.docx';
    const sourceUrl = 'https://flkoss.obs-bj2.cucloud.cn/' + sourcePath;
    const fetchMock = sequence(json({ code: 200, rows: [{ ...detail('body-record', title), content: { children: [{ title: '第二条' }] }, ossFile: { ossWordPath: sourcePath } }] }), json({ code: 200, data: { url: sourceUrl } }), new Response(new Uint8Array(original)));
    vi.stubGlobal('fetch', fetchMock);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    const { getDataDirectory } = await import('../server/config/data_path');
    const directory = getDataDirectory('legal_cache');
    fs.mkdirSync(directory, { recursive: true });
    const oldPath = path.join(directory, 'flk-api-v1_' + Buffer.from('正文原件核对').toString('base64').replace(/[/+=]/g, '_').slice(0, 80) + '.json');
    const oldMetadata = JSON.stringify([{ title, sourceText: 'LEGACY_DIRECTORY_ONLY' }]);
    fs.writeFileSync(oldPath, oldMetadata);
    const priorBodyCachePath = oldPath.replace('flk-api-v1_', 'flk-api-v2_');
    fs.writeFileSync(priorBodyCachePath, oldMetadata);
    const priorMetadataCachePath = oldPath.replace('flk-api-v1_', 'flk-api-v4_');
    fs.writeFileSync(priorMetadataCachePath, oldMetadata);
    const priorWholeBodyCachePath = oldPath.replace('flk-api-v1_', 'flk-api-v5_');
    fs.writeFileSync(priorWholeBodyCachePath, oldMetadata);
    const priorUntypedBodyCachePath = oldPath.replace('flk-api-v1_', 'flk-api-v6_');
    fs.writeFileSync(priorUntypedBodyCachePath, oldMetadata);
    const priorDisplayOnlyCachePath = oldPath.replace('flk-api-v1_', 'flk-api-v7_');
    fs.writeFileSync(priorDisplayOnlyCachePath, oldMetadata);
    const row = (await searchFLK('正文原件核对'))[0];
    expect(row.sourceText).not.toContain('LEGACY_DIRECTORY_ONLY');
    expect(fs.readFileSync(oldPath, 'utf8')).toBe(oldMetadata);
    expect(fs.readFileSync(priorBodyCachePath, 'utf8')).toBe(oldMetadata);
    expect(fs.readFileSync(priorMetadataCachePath, 'utf8')).toBe(oldMetadata);
    expect(fs.readFileSync(priorWholeBodyCachePath, 'utf8')).toBe(oldMetadata);
    expect(fs.readFileSync(priorUntypedBodyCachePath, 'utf8')).toBe(oldMetadata);
    expect(fs.readFileSync(priorDisplayOnlyCachePath, 'utf8')).toBe(oldMetadata);
    expect(row.sourceText).toContain('原件第一项明确义务。');
    expect(row.sourceText).toContain('原件第二项适用条件。');
    expect((row as any).statuteSource).toMatchObject({recordId:'body-record',provisions:{}});
    expect((row as any).statuteSource.originalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.sourceText).toContain('已提取并核对全部 2 条正文');
    expect(row.sourceText).toContain('body-record');
    expect(row.sourceText).toContain(sourcePath);
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'https://flk.npc.gov.cn/law-search/search/list',
      'https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=body-record&fileId=', sourceUrl,
    ]);
  });

  it.each(['wrong-download-path', 'missing-final-article'])('keeps metadata explicit instead of claiming full text after %s', async failure => {
    const { Document, Packer, Paragraph } = await import('docx');
    const title = '虚构失败范围法规';
    const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(title), new Paragraph('第一条　唯一已提供正文。')] }] }));
    const sourcePath = 'official-read/expected-source.docx';
    const sourceUrl = 'https://flkoss.obs-bj2.cucloud.cn/' + (failure === 'wrong-download-path' ? 'other-source.docx' : sourcePath);
    const fetchMock = sequence(json({ code: 200, rows: [{ ...detail(failure, title), content: { children: [{ title: '第二条' }] }, ossFile: { ossWordPath: sourcePath } }] }), json({ code: 200, data: { url: sourceUrl } }), new Response(new Uint8Array(original)));
    vi.stubGlobal('fetch', fetchMock);
    const row = (await searchFLK('原件失败-' + failure))[0];
    expect(row.title).toBe(title);
    expect(row.sourceText).toContain('已取得来源元数据');
    expect(row.sourceText).toContain('正文提取未完成');
    expect(row.sourceText).not.toContain('已提取并核对全部');
    expect(row.sourceText).toContain(sourcePath);
    expect(fetchMock).toHaveBeenCalledTimes(failure === 'wrong-download-path' ? 2 : 3);
  });

  it('reads actual search/list metadata, preserving a repealed historical version and its provenance', async () => {
    const fetchMock = sequence(json({ code: 200, rows: [detail('old-record', '虚构旧法', 1)] }));
    vi.stubGlobal('fetch', fetchMock);
    const rows = await searchLegalAuthorityDatabase({ query: '旧法来源回归', type: 'law', sourceIds: ['national-law-regulations'], includeOfficialWeb: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '虚构旧法', effectiveStatus: '已废止', publishDate: '2004-01-01', sourceName: '国家法律法规数据库' });
    expect(rows[0].url).toContain('/detail?id=old-record&title=');
    expect(rows[0].sourceEndpoint).toBe('https://flk.npc.gov.cn/law-search/search/list');
    expect(rows[0].sourceText).not.toContain('OFFICIAL-SOURCE-TAIL');
    expect(rows[0].sourceText).toContain('公布日期：2004-01-01；施行日期：2004-07-01');
    expect(rows[0].queriedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((rows[0] as any).statuteSource).toMatchObject({recordId:'old-record',versionDate:'2004-01-01',effectiveDate:'2004-07-01',effectivenessCode:1,provisions:{}});
    expect((rows[0] as any).statuteSource.originalSha256).toBeUndefined();
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(['https://flk.npc.gov.cn/law-search/search/list', 'https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=old-record&fileId=']);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ searchContent: '旧法来源回归', sxx: [] });
  });
  it.each([[1, '已废止'], [2, '已修改'], [3, '现行有效'], [4, '尚未生效']] as const)('preserves official effectiveness code %s as %s without discarding old versions', async (code, status) => {
    vi.stubGlobal('fetch', sequence(json({ code: 200, rows: [detail('version-' + code, '虚构版本法', code)] })));
    expect((await searchFLK('效力码回归-' + code))[0].status).toBe(status);
  });
  it('returns a valid empty search without caching it as a successful search', async () => {
    const fetchMock = sequence(json({ code: 200, rows: [] }), json({ code: 200, rows: [detail('later', '虚构后续法')] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchFLK('同词空后命中')).toEqual([]);
    expect(await searchFLK('同词空后命中')).toHaveLength(1);
    expect(await searchFLK('同词空后命中')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('distinguishes an unavailable official endpoint from zero search hits and retries the next call', async () => {
    const fetchMock = sequence(json({ message: 'unavailable' }, 503), json({ code: 200, rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchFLK('故障回归词')).rejects.toThrow('HTTP 503');
    await expect(searchFLK('故障回归词')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([{ code: 200 }, { code: 200, rows: {} }, { code: 200, rows: [{ title: 'missing identity' }] }, { code: 403, msg: 'official access denied' }])('does not turn malformed or rejected structured data into empty successful hits: %j', async payload => {
    vi.stubGlobal('fetch', sequence(json(payload)));
    await expect(searchFLK('异常结构-' + JSON.stringify(payload))).rejects.toThrow();
  });
  it.each([{ title: '虚构对应法' }, { bbbs: 'record', title: '' }])('rejects a search row without its actual identity: %j', async data => {
    vi.stubGlobal('fetch', sequence(json({ code: 200, rows: [data] })));
    await expect(searchFLK('虚构对应法')).rejects.toThrow(/identities/i);
  });
  it('does not start an official request when that source was not requested', async () => {
    const fetchMock = sequence(); vi.stubGlobal('fetch', fetchMock);
    expect(await searchLegalAuthorityDatabase({ query: '未启用官网', type: 'law', sourceIds: ['national-law-regulations'], includeOfficialWeb: false })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('public source queries resolve the actual national formal title',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('routes an explicit source query only to the public official API and preserves its full-title original',async()=>{
  const {Document,Packer,Paragraph}=await import('docx');
  const {searchExternalAuthoritiesHandler}=await import('../server/regions/packs/cn/legal_tools/company_research');
  const {ToolRegistry}=await import('../server/tools/registry');
  const {executeToolCall}=await import('../server/tools/execution_engine');
  const short='虚构星潮记录法',full='中华人民共和国'+short,first='记录来源应逐项保存。',second='核对结果应标注原文位置。';
  const original=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(full),new Paragraph('第一条　'+first),new Paragraph('第二条　'+second)]}]}));
  const recordId='initial-public-dispatch',wordPath='initial-public-dispatch.docx',wordUrl='https://flkoss.obs-bj2.cucloud.cn/'+wordPath;
  const fetchMock=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);
   if(url==='https://flk.npc.gov.cn/law-search/search/list'){expect(JSON.parse(String(init?.body))).toMatchObject({searchContent:short});return json({code:200,rows:[{...detail(recordId,full,1),content:{children:[{title:'第一条'},{title:'第二条'}]},ossFile:{ossWordPath:wordPath}}]});}
   if(url==='https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs='+recordId+'&fileId=')return json({code:200,data:{url:wordUrl}});
   if(url===wordUrl)return new Response(new Uint8Array(original));
   throw Error('Unexpected nonofficial dispatch: '+url);
  });vi.stubGlobal('fetch',fetchMock);
  vi.stubEnv('PKULAW_API_KEY','isolated-private-key');vi.stubEnv('PKULAW_BASE_URL','https://private.invalid/api');
  const name='legal_search_external_authorities',context:any={userId:'initial-dispatch-user',requestId:'initial-dispatch-request',taskId:'initial-dispatch-task',authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',toolPolicy:{allowedTools:[name],forbiddenTools:[],requireConfirmation:[],maxIterations:5}};
  const arguments_={query:short+' 第1条 第2条',type:'law',sourceIds:['national-law-regulations'],includeOfficialWeb:true,persistCase:false,confirmedForKb:false};
  const registry=new ToolRegistry();registry.register({name,description:'Existing external authority handler',permission:'public',securityLevel:'safe',parameters:{type:'object',properties:{query:{type:'string'},sourceIds:{type:'array',items:{type:'string'}}},required:['query']},capability:{id:'test.real-official-dispatch',family:'legal',lane:'industry',operation:'observe',risk:'low',sideEffects:[],verification:{strategy:'terminal_receipt',required:true,requiredFields:['ok'],requiredValues:{ok:true},successSignals:['observation returned'],limitations:[]}},handler:searchExternalAuthoritiesHandler});
  const record=await executeToolCall({registry,id:'initial-public-read',name,arguments:arguments_,context});
  const receipt=record.receipt as {statuteSources:unknown[]};expect(record.terminalVerification?.status).toBe('verified');expect(receipt.statuteSources).toHaveLength(1);
  expect(receipt.statuteSources[0]).toMatchObject({title:full,recordId,sourceId:'national-law-regulations',requestedArticleKeys:['1','2'],provisions:{'1':{text:first},'2':{text:second}}});
  expect(fetchMock).toHaveBeenCalledTimes(3);
 });
 it('prefers an actual exact title over a national-prefixed candidate',async()=>{
  const short='虚构确名法';const fetchMock=sequence(json({code:200,rows:[detail('exact-short',short),{bbbs:'prefixed',title:'中华人民共和国'+short}]}));vi.stubGlobal('fetch',fetchMock);
  const rows=await searchOfficialStatuteRecords(short+' 第1条');expect(rows.map(row=>row.details.bbbs)).toEqual(['exact-short']);expect(fetchMock).toHaveBeenCalledTimes(2);
 });
 it.each([['虚构责任法',['中华人民共和国虚构甲责任法','中华人民共和国虚构乙责任法']],['责任法',['中华人民共和国侵权责任法']],['虚构规则',['某市虚构规则','最高人民法院虚构规则']]])('does not expand arbitrary or ambiguous suffix %s',async(short,titles)=>{
  const fetchMock=sequence(json({code:200,rows:(titles as string[]).map((title,index)=>({bbbs:'wrong-'+index,title}))}));vi.stubGlobal('fetch',fetchMock);expect(await searchOfficialStatuteRecords(short+' 第1条')).toEqual([]);expect(fetchMock).toHaveBeenCalledOnce();
 });
 it('keeps two versions of the same actual full title as distinct identities',async()=>{
  const short='虚构多版本法',full='中华人民共和国'+short;const fetchMock=sequence(json({code:200,rows:[detail('v1',full,1), {...detail('v2',full),gbrq:'2005-01-01'}]}));vi.stubGlobal('fetch',fetchMock);
  const rows=await searchOfficialStatuteRecords(short+' 第1条');expect(rows.map(row=>row.statuteSource.recordId)).toEqual(['v1','v2']);expect(rows.map(row=>row.statuteSource.versionDate)).toEqual(['2004-01-01','2005-01-01']);expect(fetchMock).toHaveBeenCalledTimes(3);
 });
 it('rejects an unidentified actual row before formal-prefix discovery',async()=>{
  const short='虚构对应关系法',full='中华人民共和国'+short;const fetchMock=sequence(json({code:200,rows:[{title:full}]}));vi.stubGlobal('fetch',fetchMock);await expect(searchOfficialStatuteRecords(short+' 第1条')).rejects.toThrow(/identities/i);
 });
});
