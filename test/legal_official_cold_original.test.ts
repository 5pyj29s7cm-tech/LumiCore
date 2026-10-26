import './helpers';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Document, Packer, Paragraph} from 'docx';
import {searchOfficialStatuteRecords} from '../server/legal/statute_authority_refresh';
import {searchFLK} from '../server/legal/sources';

const title='虚构冷源规则';
const row=(id:string,sxx=3)=>({bbbs:id,title,sxx,gbrq:'2004-01-01',sxrq:'2004-07-01',zdjgName:'示例机关'});
const json=(value:unknown)=>new Response(JSON.stringify(value));
async function original(name=title,body='第二条　实际原件乙事项。') { return Packer.toBuffer(new Document({sections:[{children:[new Paragraph(name),new Paragraph('第一条　实际原件甲事项。'),new Paragraph(body)]}]})); }
function fixture(rows:ReturnType<typeof row>[],docs:Record<string,Buffer>,mode='readable') {
 return vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const url=new URL(String(input));
  if(url.pathname==='/law-search/search/list'){expect(init?.method).toBe('POST');return json({code:200,rows});}
  if(url.pathname==='/law-search/search/flfgDetails') throw new Error('Fixture record details timed out');
  if(url.pathname==='/law-search/download/pc') {
   expect(url.searchParams.get('format')).toBe('docx');expect(url.searchParams.get('fileId')).toBe('');
   const id=url.searchParams.get('bbbs')!;expect(rows.some(r=>r.bbbs===id)).toBe(true);
   if(mode==='resolver-failure')throw new Error('Fixture original resolver unavailable');
   return json({code:200,data:{url:(mode==='wrong-host'?'https://untrusted.invalid/':'https://flkoss.obs-bj2.cucloud.cn/')+id+'.docx'}});
  }
  if(url.hostname==='flkoss.obs-bj2.cucloud.cn')return new Response(new Uint8Array(docs[url.pathname.slice(1,-5)]));
  throw new Error('Unexpected network request blocked');
 });
}
afterEach(()=>vi.unstubAllGlobals());

describe('official cold original has no mandatory detail-page dependency',()=>{
 it('reads selected original text using the actual list identity when the detail endpoint is unavailable',async()=>{
  const fetchMock=fixture([row('cold')],{cold:await original()});vi.stubGlobal('fetch',fetchMock);
  const result=(await searchOfficialStatuteRecords(title+' 第二条'))[0];
  expect(result.statuteSource).toMatchObject({title,recordId:'cold',versionDate:'2004-01-01',effectiveDate:'2004-07-01',effectivenessCode:3,requestedArticleKeys:['2']});
  expect(Object.keys(result.statuteSource.provisions)).toEqual(['2']);expect(result.statuteSource.provisions['2'].text).toContain('实际原件乙事项。');
  expect(result.statuteSource.originalSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.sourceText).toContain('未作外部条数或完整性核验');
  expect(result.sourceEndpoint).toBe('https://flk.npc.gov.cn/law-search/search/list');
  expect(fetchMock.mock.calls.some(c=>String(c[0]).includes('flfgDetails'))).toBe(false);
 });
 it('keeps a highlighted list title canonical across the typed source and subsequent cache selection',async()=>{
  const highlighted=Array.from(title).map(c=>'<em class="highlight">'+c+'</em>').join('');
  const fetchMock=fixture([{...row('highlighted'),title:highlighted}],{highlighted:await original()});vi.stubGlobal('fetch',fetchMock);
  const selected=(await searchFLK(title+' 第二条'))[0];
  expect(selected.title).toBe(title);expect(selected.statuteSource?.title).toBe(title);
  const followup=(await searchFLK(title+' 第一条'))[0];
  expect(followup.statuteSource?.recordId).toBe('highlighted');expect(followup.statuteSource?.provisions['1'].text).toContain('实际原件甲事项。');
  expect(fetchMock).toHaveBeenCalledTimes(3);
 });
 it('keeps same-title versions bound to their own list identity, status and original',async()=>{
  const fetchMock=fixture([row('old',1),row('current',3)],{old:await original(title,'第二条　历史版本正文。'),current:await original(title,'第二条　当前版本正文。')});vi.stubGlobal('fetch',fetchMock);
  const results=await searchOfficialStatuteRecords(title+' 第二条');
  expect(results.map(r=>[r.statuteSource.recordId,r.statuteSource.effectivenessCode,r.statuteSource.provisions['2'].text])).toEqual([['old',1,'历史版本正文。'],['current',3,'当前版本正文。']]);
  expect(results[0].statuteSource.originalSha256).not.toBe(results[1].statuteSource.originalSha256);
 });
 it.each(['resolver-failure','wrong-host'])('retains metadata without inventing body evidence after %s',async mode=>{
  const fetchMock=fixture([row('unread',1)],{unread:await original()},mode);vi.stubGlobal('fetch',fetchMock);
  const result=(await searchOfficialStatuteRecords(title+' 第二条'))[0];
  expect(result.statuteSource.recordId).toBe('unread');expect(result.statuteSource.effectivenessCode).toBe(1);expect(result.statuteSource.originalSha256).toBeUndefined();
  expect(result.statuteSource.provisions).toEqual({});expect(result.sourceText).toContain('正文提取未完成');expect(result.sourceText).not.toContain('实际原件乙事项。');
  expect(fetchMock.mock.calls.some(c=>String(c[0]).includes('untrusted.invalid'))).toBe(false);
 });
 it('does not attach a differently titled original to the selected record',async()=>{
  vi.stubGlobal('fetch',fixture([row('wrong-title')],{'wrong-title':await original('另一虚构规则')}));
  const result=(await searchOfficialStatuteRecords(title+' 第二条'))[0];
  expect(result.statuteSource.originalSha256).toBeUndefined();expect(result.statuteSource.provisions).toEqual({});expect(result.sourceText).toContain('Official document title mismatch');
 });
 it('does not claim selected provisions when a readable original has no locatable article boundaries',async()=>{
  vi.stubGlobal('fetch',fixture([row('no-locator')],{'no-locator':await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(title),new Paragraph('正文未提供可定位的条号。')]}]}))}));
  const result=(await searchOfficialStatuteRecords(title+' 第二条'))[0];
  expect(result.statuteSource.originalSha256).toBeUndefined();expect(result.statuteSource.provisions).toEqual({});expect(result.sourceText).toContain('Requested article boundaries unavailable');
 });
});
