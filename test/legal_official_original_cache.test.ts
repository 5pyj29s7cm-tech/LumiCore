import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchFLK,searchLegalAuthorityDatabase } from '../server/legal/sources';
import { getDataDirectory } from '../server/config/data_path';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const json=(payload:unknown)=>Response.json(payload);
async function prime(title:string,near=false,query=title){
 const {Document,Packer,Paragraph}=await import('docx');
 const original=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(title),...Array.from({length:9},(_,i)=>new Paragraph('第'+(i+1)+'条　唯一真实原文-'+(i+1)+'。'))]}]}));
 const details={bbbs:'real-'+title,title,gbrq:'2080-03-01',sxrq:'2080-09-01',sxx:3,content:{children:[{title:'第九条'}]},ossFile:{ossWordPath:'original/'+title+'.docx'}};
 const calls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>{const value=String(url);calls.push(value);
  if(value.endsWith('/search/list'))return json({code:200,rows:[{bbbs:details.bbbs,title},...(near?[{bbbs:'unrelated-record',title:'另一事项关于'+title+'的规定'}]:[])]});
  if(value.includes('/flfgDetails?'))return json({code:200,data:details});
  if(value.includes('/download/pc?'))return json({code:200,data:{url:'https://flkoss.obs-bj2.cucloud.cn/'+details.ossFile.ossWordPath}});
  return new Response(new Uint8Array(original));
 }));
 const rows=await searchFLK(query);
 const dir=getDataDirectory('legal_cache');
 const cacheFile=fs.readdirSync(dir).filter(name=>name.startsWith('flk-original-v1_')).map(name=>path.join(dir,name)).find(file=>{try{const rows=JSON.parse(fs.readFileSync(file,'utf8'));return rows[0]?.title===title;}catch{return false;}})!;
 return {rows,cacheFile,calls,details};
}
describe('Existing official search cache reuses only a bound fresh original',()=>{
 it('projects requested unknown articles from the same fresh original without another network request or public full-book snapshot',async()=>{
  const {rows,details}=await prime('未知晶岚缓存法');
  const noNetwork=vi.fn(async()=>{throw Error('Unexpected repeat network');});vi.stubGlobal('fetch',noNetwork);
  const selected=await searchLegalAuthorityDatabase({query:'《'+details.title+'》第五条 第八条 第九十九条',type:'law',includeOfficialWeb:true,sourceIds:['national-law-regulations']});
  expect(noNetwork).not.toHaveBeenCalled();expect(selected).toHaveLength(1);
  const row=selected[0];expect(Object.keys(row.statuteSource!.provisions)).toEqual(['5','8']);
  expect(row.statuteSource).toMatchObject({recordId:details.bbbs,versionDate:details.gbrq,requestedArticleKeys:['5','8','99'],queriedAt:rows[0].queriedAt,originalSha256:rows[0].statuteSource!.originalSha256});
  expect(row.sourceText).toContain('唯一真实原文-5。');expect(row.sourceText).toContain('唯一真实原文-8。');
  expect(row.sourceText).not.toContain('唯一真实原文-1。');expect(row.sourceText).not.toContain('唯一真实原文-9。');
  expect(row.sourceText).toContain('第99条：本次未定位');
  expect(row.sourceText).toContain('缓存');
  expect((rows[0] as any)._originalCache).toBeUndefined();expect((row.raw as any)._originalCache).toBeUndefined();
 });
 it.each([
  ['关于适用《未知风羽规则》的若干规定','关于适用未知风羽规则的若干规定'],
  ['关于'+ '未知跨域公共档案'.repeat(8)+'事项的管理条例',undefined],
 ] as const)('uses only the actual canonical title and keeps long query keys distinct: %s',async(title,query)=>{
  const {details}=await prime(title,false,query||title);
  const noNetwork=vi.fn(async()=>{throw Error('Unexpected repeat network');});vi.stubGlobal('fetch',noNetwork);
  const selected=await searchFLK(details.title+' 第五条');
  expect(noNetwork).not.toHaveBeenCalled();
  expect(selected).toHaveLength(1);expect(Object.keys(selected[0].statuteSource!.provisions)).toEqual(['5']);
  expect(selected[0].sourceText).not.toContain('唯一真实原文-1。');
 });
 it.each([false,true])('reuses a full private original after a selected success or an existing selected query cache hit: %s',async hydrate=>{
  const title='未知完整原件'+(hydrate?'甲':'乙')+'索引法';
  const {details}=await prime(title,false,title+' 第五条');
  if(hydrate){const dir=getDataDirectory('legal_cache');for(const name of fs.readdirSync(dir).filter(name=>name.startsWith('flk-original-v1_')))fs.unlinkSync(path.join(dir,name));}
  const noNetwork=vi.fn(async()=>{throw Error('Unexpected repeat network');});vi.stubGlobal('fetch',noNetwork);
  if(hydrate)expect((await searchFLK(title+' 第五条'))[0].statuteSource!.requestedArticleKeys).toEqual(['5']);
  const selected=await searchFLK(title+' 第八条');
  expect(noNetwork).not.toHaveBeenCalled();expect(Object.keys(selected[0].statuteSource!.provisions)).toEqual(['8']);
  expect(selected[0].sourceText).not.toContain('唯一真实原文-5。');
  const missing=vi.fn(async()=>json({code:200,rows:[]}));vi.stubGlobal('fetch',missing);
  expect(await searchFLK(details.title)).toEqual([]);expect(missing).toHaveBeenCalled();
 });
 it.each(['raw-sha','body-sha','version','record','metadata-only','legacy-unbound','stale','expired-file'] as const)('does not reuse an invalid or stale original binding: %s',async mode=>{
  const {cacheFile,details}=await prime('未知缓存边界法-'+mode);
  const cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
  expect(cached[0]._originalCache).toBeDefined();
  if(mode==='raw-sha')cached[0]._originalCache.originalText+='伪造尾部';
  if(mode==='body-sha')cached[0]._originalCache.bodySha256='b'.repeat(64);
  if(mode==='version')cached[0]._originalCache.versionDate='2079-01-01';
  if(mode==='record')cached[0]._originalCache.recordId='another-record';
  if(mode==='metadata-only'){delete cached[0]._originalCache;delete cached[0].statuteSource.originalSha256;}
  if(mode==='legacy-unbound')delete cached[0]._originalCache;
  if(mode==='stale')cached[0].statuteSource.queriedAt=new Date(Date.now()-25*60*60*1000).toISOString();
  fs.writeFileSync(cacheFile,JSON.stringify(cached));
  if(mode==='expired-file'){const old=new Date(Date.now()-25*60*60*1000);fs.utimesSync(cacheFile,old,old);}
  const network=vi.fn(async()=>json({code:200,rows:[]}));vi.stubGlobal('fetch',network);
  expect(await searchFLK('《'+details.title+'》第五条')).toEqual([]);
  expect(network).toHaveBeenCalled();
 });
 it('does not bypass raw hash validation on an exact selected-query cache hit',async()=>{
  const title='未知原查询哈希核验法';const query=title+' 第五条';await prime(title,false,query);
  const dir=getDataDirectory('legal_cache');for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.json'))){const file=path.join(dir,name);const rows=JSON.parse(fs.readFileSync(file,'utf8'));if(rows[0]?.title!==title)continue;for(const row of rows)if(row._originalCache)row._originalCache.originalText+='损坏的缓存尾部';fs.writeFileSync(file,JSON.stringify(rows));}
  const network=vi.fn(async()=>json({code:200,rows:[]}));vi.stubGlobal('fetch',network);
  expect(await searchFLK(query)).toEqual([]);expect(network).toHaveBeenCalled();
 });
 it('retains a metadata-only version beside a successful selected version instead of hiding ambiguity',async()=>{
  const title='未知同名版本保留法';
  const {Document,Packer,Paragraph}=await import('docx');
  const original=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(title),new Paragraph('第一条　该版本唯一真实原文。')]}]}));
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>{const value=String(url);
   if(value.endsWith('/search/list'))return json({code:200,rows:[{bbbs:'read-version',title},{bbbs:'metadata-version',title}]});
   if(value.includes('/flfgDetails?')){const metadata=value.includes('metadata-version');return json({code:200,data:{bbbs:metadata?'metadata-version':'read-version',title,gbrq:metadata?'2082-01-01':'2080-01-01',sxrq:metadata?'2082-02-01':'2080-02-01',sxx:3,content:{children:[{title:'第一条'}]},...(metadata?{}:{ossFile:{ossWordPath:'actual/version.docx'}})}});}
   if(value.includes('/download/pc?'))return json({code:200,data:{url:'https://flkoss.obs-bj2.cucloud.cn/actual/version.docx'}});
   return new Response(new Uint8Array(original));
  }));
  expect(await searchFLK(title+' 第一条')).toHaveLength(2);
  const dir=getDataDirectory('legal_cache');const index=fs.readdirSync(dir).filter(name=>name.startsWith('flk-original-v1_')).map(name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))).find(rows=>rows[0]?.title===title);
  expect(index).toHaveLength(2);expect(index.some((row:any)=>row.docId==='metadata-version'&&!row._originalCache)).toBe(true);
  const network=vi.fn(async()=>json({code:200,rows:[]}));vi.stubGlobal('fetch',network);
  expect(await searchFLK(title+' 第二条')).toEqual([]);expect(network).toHaveBeenCalled();
 });
 it('prioritizes exact full titles before downloading unrelated title-containing records',async()=>{
  const {rows,calls}=await prime('未知青禾条例',true);
  expect(rows).toHaveLength(1);expect(rows[0].title).toBe('未知青禾条例');
  expect(calls.filter(url=>url.includes('/flfgDetails?'))).toHaveLength(1);
 });
});
