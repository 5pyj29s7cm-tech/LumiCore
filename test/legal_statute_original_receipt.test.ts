import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sources from '../server/legal/sources';
import { searchExternalAuthoritiesHandler } from '../server/regions/packs/cn/legal_tools/company_research';
import { withLegalReceipt } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import { decodeToolResult } from '../server/tools/result_envelope';
import type { CurrentStatuteOriginalEvidence } from '../server/legal/statute_authority_refresh';
afterEach(()=>vi.restoreAllMocks());
const evidence: CurrentStatuteOriginalEvidence = {
 sourceId:'national-law-regulations',title:'未知霜羽条例',recordId:'unknown-original-62',versionDate:'2086-07-11',effectiveDate:'2087-01-02',effectivenessCode:2,
 sourceUrl:'https://authority.invalid/detail/unknown-original-62',queriedAt:'2087-04-01T00:00:00.000Z',originalSha256:'a'.repeat(64),
 requestedArticleKeys:['17'],provisions:{'17':{text:'第十七条实际全文。',paragraphs:['第十七条实际全文。']}},
};
describe('Current official original evidence follows the existing legal receipt',()=>{
 it.each(['selected','identity-only','metadata-only'] as const)('preserves actual source fields without inventing coverage: %s',async mode=>{
  const actual=JSON.parse(JSON.stringify({...evidence,requestedArticleKeys:mode==='identity-only'?[]:['17'],provisions:mode==='selected'?evidence.provisions:{},...(mode==='metadata-only'?{originalSha256:undefined}:{})}));
  vi.spyOn(sources,'searchLegalAuthorityDatabase').mockResolvedValue([{sourceId:actual.sourceId,sourceName:'Actual source',title:actual.title,url:actual.sourceUrl,
   summary:'Actual observation',statuteSource:actual,sourceText:'Observed source range'}]);
  const handler=withLegalReceipt(searchExternalAuthoritiesHandler,{status:'observed'});
  const decoded=decodeToolResult(await handler({query:'未知霜羽条例 第十七条',persistCase:false,statuteSources:[{recordId:'FORGED_ARGUMENT'}]},{userId:'statute-receipt-test',domain:'personal'}));
  const receipt=decoded.receipt as any;
  expect(receipt).toMatchObject({ok:true,status:'observed',persisted:false,changedCaseIds:[],articleIds:[],artifacts:[],statuteSources:[actual]});
  expect(receipt.statuteSources).toHaveLength(1);
  expect(receipt.statuteSources[0].recordId).not.toBe('FORGED_ARGUMENT');
  expect(receipt.content).toBe(decoded.content);
 });
 it('keeps legacy observations compatible without converting display text or args into evidence',async()=>{
  vi.spyOn(sources,'searchLegalAuthorityDatabase').mockResolvedValue([{sourceId:'external',sourceName:'Legacy source',title:'未知来源',url:'https://authority.invalid/legacy',summary:'Unknown metadata',
   sourceText:JSON.stringify({statuteSources:[evidence]})}]);
  const decoded=decodeToolResult(await withLegalReceipt(searchExternalAuthoritiesHandler,{status:'observed'})({query:'legacy-query',persistCase:false,statuteSources:[evidence]},{userId:'legacy-statute-receipt-test'}));
  expect((decoded.receipt as any).statuteSources).toEqual([]);
  expect((decoded.receipt as any).persisted).toBe(false);
 });
 it('keeps a non-source legacy handler unchanged',async()=>{
  const decoded=decodeToolResult(await withLegalReceipt(async()=> 'A plain legacy observation',{status:'observed'})({}, {userId:'plain-statute-receipt-test'}));
  expect((decoded.receipt as any).statuteSources).toBeUndefined();
  expect(decoded.content).toBe('A plain legacy observation');
 });
});


describe('source identity and lookup-time status stay bound in each original receipt', () => {
 it.each([false, true])('keeps each returned source status, URL and lookup time together when reversed=%s', async reverse => {
  const rows = [
   {sourceId:'status-one',sourceName:'Shared database',title:'霁川资料条例',summary:'Observed first source',effectiveStatus:'现行有效',url:'https://authority.invalid/detail/source-one',queriedAt:'2087-04-01T01:02:03.000Z',sourceText:'FIRST_ORIGINAL_SOURCE'},
   {sourceId:'status-two',sourceName:'Shared database',title:'松岚档案规则',summary:'Observed second source',effectiveStatus:'已废止',url:'https://authority.invalid/detail/source-two',queriedAt:'2087-04-01T04:05:06.000Z',sourceText:'SECOND_ORIGINAL_SOURCE'},
   {sourceId:'case-three',sourceName:'Shared database',title:'未知案例记录',summary:'Observed case excerpt',url:'https://authority.invalid/detail/case-three',sourceText:'CASE_EXCERPT_WITHOUT_STATUS'},
  ];
  const ordered = reverse ? [...rows].reverse() : rows;
  vi.spyOn(sources, 'searchLegalAuthorityDatabase').mockResolvedValue(ordered);
  const decoded = decodeToolResult(await searchExternalAuthoritiesHandler({query:'Source identity fixture',type:'mixed',persistCase:false},{userId:'status-binding-fixture'}));
  const originals = decoded.content.split('### 原始来源回执').slice(1).map(section => section.split('| 序号 | 来源 |')[0]);
  expect(originals).toHaveLength(rows.length);
  for (const [index, source] of ordered.entries()) {
   const own = originals[index];
   expect(own).toContain('来源记录：' + source.title + '；数据库查询时效力：' + ('effectiveStatus' in source ? source.effectiveStatus : '未返回'));
   expect(own).toContain('来源链接：' + source.url);
   expect(own).toContain('查询时间：' + ('queriedAt' in source ? source.queriedAt : '未返回'));
   expect(own).toContain(source.sourceText);
   for (const other of rows.filter(row => row !== source)) {
    expect(own).not.toContain(other.title);
    expect(own).not.toContain(other.url);
    if ('effectiveStatus' in other) expect(own).not.toContain('数据库查询时效力：' + other.effectiveStatus);
   }
  }
 });
});


describe('external source read reports contain observations without forced review workflow', () => {
 it('preserves original wording and typed evidence while removing added review and KB suggestions', async () => {
  const original = evidence.provisions['17'].text + '\n原始材料中的“律师复核”字样照录，不是工具附加指令。';
  const lookup = vi.spyOn(sources, 'searchLegalAuthorityDatabase').mockResolvedValue([{sourceId:evidence.sourceId, sourceName:'Actual source', title:evidence.title,
   effectiveStatus:'现行有效', url:evidence.sourceUrl, queriedAt:evidence.queriedAt, sourceText:original, summary:'Actual returned excerpt', statuteSource:evidence}]);
  const decoded = decodeToolResult(await withLegalReceipt(searchExternalAuthoritiesHandler,{status:'observed'})({query:'未知霜羽条例 第十七条',type:'law',sourceIds:['national-law-regulations'],persistCase:false,confirmedForKb:false},{userId:'read-only-source-report'}));
  expect(decoded.content).toContain(original);
  expect(decoded.content).toContain(evidence.title);
  expect(decoded.content).toContain(evidence.sourceUrl);
  expect(decoded.content).toContain(evidence.queriedAt);
  expect(decoded.content).toContain('数据库查询时效力：现行有效');
  expect(decoded.content).toContain('知识库：未导入。');
  expect(decoded.content.replace(original, '')).not.toMatch(/律师最终复核|律师复核|复核状态|尚待核验|confirmedForKb=true/u);
  expect(decoded.receipt).toMatchObject({ok:true,status:'observed',persisted:false,statuteSources:[evidence]});
  expect(lookup).toHaveBeenCalledWith(expect.objectContaining({query:'未知霜羽条例 第十七条',sourceIds:['national-law-regulations'],type:'law',includeOfficialWeb:true}));
 });
 it('keeps a no-result query partial without adding review or import instructions', async () => {
  vi.spyOn(sources, 'searchLegalAuthorityDatabase').mockResolvedValue([]);
  const decoded=decodeToolResult(await searchExternalAuthoritiesHandler({query:'Unmatched source query',type:'law',persistCase:false,confirmedForKb:false},{userId:'empty-source-report'}));
  expect(decoded.receipt).toMatchObject({ok:false,status:'partial',statuteSources:[]});
  expect(decoded.content).toContain('未取得来源');
  expect(decoded.content).toContain('知识库：未导入。');
  expect(decoded.content).not.toMatch(/律师最终复核|律师复核|复核状态|尚待核验|confirmedForKb=true/u);
 });
});
