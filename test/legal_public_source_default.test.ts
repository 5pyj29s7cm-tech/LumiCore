import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sources from '../server/legal/sources';
import { searchExternalAuthoritiesHandler } from '../server/regions/packs/cn/legal_tools/company_research';
import { formatToolRecordForModel } from '../server/llm/tool_loop/receipts';
afterEach(()=>vi.restoreAllMocks());
describe('existing public statute lookup default',()=>{
 it('keeps a requested original and source identity in the first model window before long result tables', async () => {
  const title = '霁川档案规则';
  const url = 'https://authority.invalid/detail/record-synthetic-47';
  const queriedAt = '2086-04-12T09:10:11.000Z';
  const original = ['来源名称：' + title, '官方记录：record-synthetic-47', '公布日期：2085-03-02；施行日期：2085-05-01', '来源链接：' + url, '查询时间：' + queriedAt, '请求条文（来源原文摘录）：', '第十七条', 'ORIGINAL_PROVISION_UNKNOWN_47', '第二十三条', 'SECOND_ORIGINAL_PROVISION_47'].join('\n');
  const rows = Array.from({ length: 5 }, (_, index) => ({ sourceId:'synthetic-authority',sourceName:'Synthetic authority',title:index === 0 ? title : '近似来源 ' + index,summary:('Observed summary ' + index + ' ').repeat(60),url:index === 0 ? url : 'https://authority.invalid/detail/other-' + index,publishDate:'2085-03-02',effectiveStatus:'observed version',queriedAt,sourceEndpoint:'https://authority.invalid/api/original/' + index,...(index === 0 ? {sourceText:original} : index === 1 ? {sourceText:'OTHER_SOURCE_EXCERPT_' + 'x'.repeat(2_000)} : {}) }));
  vi.spyOn(sources,'searchLegalAuthorityDatabase').mockResolvedValue(rows);
  const report = await searchExternalAuthoritiesHandler({query:'《' + title + '》第十七条 第二十三条',type:'law',persistCase:false},{userId:'original-window-test',domain:'personal'});
  const window = formatToolRecordForModel({name:'unknown_observation_tool',result:report} as any);
  for (const fact of [title,'record-synthetic-47','2085-03-02','2085-05-01',url,queriedAt,'ORIGINAL_PROVISION_UNKNOWN_47','SECOND_ORIGINAL_PROVISION_47']) expect(window).toContain(fact);
  expect(report.indexOf('ORIGINAL_PROVISION_UNKNOWN_47')).toBeLessThan(report.indexOf('| 序号 | 来源 |'));
  for (const row of rows) { expect(report).toContain(row.title); expect(report).toContain(row.summary); expect(report).toContain(row.url); }
  expect(report).toContain('类案排序：');
  expect(report).toContain('未导入');
 });

 const cases=[{label:'law lookup without a private source',args:{type:'law'},context:{},expected:true},{label:'explicit public lookup opt-out',args:{type:'law',includeOfficialWeb:false},context:{},expected:false},{label:'case lookup does not pretend FLK was queried',args:{type:'case'},context:{},expected:false},{label:'local-only routing remains local',args:{type:'mixed'},context:{dataRoutingPolicy:'local_only'},expected:false}];
 for(const c of cases)it(c.label,async()=>{
  const search=vi.spyOn(sources,'searchLegalAuthorityDatabase').mockResolvedValue([]);
  await searchExternalAuthoritiesHandler({query:'通用法源检索',persistCase:false,...c.args},{userId:'public-source-default-test',domain:'personal',...c.context});
  expect(search).toHaveBeenCalledWith(expect.objectContaining({includeOfficialWeb:c.expected}));
 });
});
