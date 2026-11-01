import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAuthoritativeStatuteSources, searchOfficialStatuteRecords } from '../server/legal/statute_authority_refresh';
import type { StatuteVerificationCatalogEntry } from '../server/legal/kb';
const json=(payload:unknown)=>Response.json(payload);
const title='未知逐风条例';
const details={bbbs:'timeout-source-81',title,gbrq:'2081-04-02',sxrq:'2081-07-01',sxx:3,content:{children:[{title:'第一条'}]},ossFile:{ossWordPath:'actual/unknown-source.docx'}};
const pending=(_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{const signal=init?.signal;signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Official request timeouts retain their own cause and public stage',()=>{
 it.each(['search','download-url','document'] as const)('labels the existing 12s source timer at %s',async stage=>{
  vi.useFakeTimers();
  const fetchMock=vi.fn((url:unknown,init?:RequestInit)=>{
   const endpoint=String(url);
   if(stage==='search' || (stage==='download-url' && endpoint.includes('/download/pc?')) || (stage==='document' && endpoint.startsWith('https://flkoss.'))) return pending(url,init);
   if(endpoint.endsWith('/search/list'))return Promise.resolve(json({code:200,rows:[{bbbs:details.bbbs,title}]}));
   if(endpoint.includes('/flfgDetails?'))return Promise.resolve(json({code:200,data:details}));
   if(endpoint.includes('/download/pc?'))return Promise.resolve(json({code:200,data:{url:'https://flkoss.obs-bj2.cucloud.cn/'+details.ossFile.ossWordPath}}));
   throw Error('Unexpected fixture endpoint');
  });
  vi.stubGlobal('fetch',fetchMock);
  const operation=searchOfficialStatuteRecords('未知来源超时范围',1).then(value=>({value,error:undefined as unknown}),error=>({value:undefined,error}));
  await vi.advanceTimersByTimeAsync(11999);
  const before=fetchMock.mock.calls.at(-1)?.[1]?.signal;
  expect(before?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result=await operation;
  const text=stage==='search'?String(result.error):(result.value?.[0].sourceText||'');
  expect(text).toContain('Official source');expect(text).toContain('timed out after 12000ms');
  expect(text).toContain(stage==='search'?'/search/list':stage==='download-url'?'/download/pc?':'https://flkoss.obs-bj2.cucloud.cn/actual/unknown-source.docx');
  expect(text).not.toContain('This operation was aborted');
  if(stage==='download-url'||stage==='document'){
   expect(result.value?.[0].statuteSource.provisions).toEqual({});
   expect(result.value?.[0].statuteSource.originalSha256).toBeUndefined();
  }
 });
 it('labels the existing 12s source timer at details',async()=>{
  vi.useFakeTimers();
  const entry: StatuteVerificationCatalogEntry = {
   key:title,title,sourceTitle:title,recordId:details.bbbs,
   verification:{source:'synthetic fixture',sourceUrl:'https://flk.npc.gov.cn/detail?id='+details.bbbs,
    verifiedAt:'2081-04-02',reviewAfter:'2081-08-01',versionDate:details.gbrq,effectiveDate:details.sxrq,articleMax:1},
  };
  const fetchMock=vi.fn((url:string|URL|Request,init?:RequestInit)=>{
   if(!String(url).includes('/flfgDetails?bbbs=timeout-source-81'))throw Error('Unexpected fixture endpoint');
   return pending(url,init);
  });
  // Current search uses the cold original route; the details timer belongs to refresh.
  const operation=refreshAuthoritativeStatuteSources({catalog:[entry],fetchImpl:fetchMock,
   persist:false,writeHistory:false,requestDelayMs:0,now:new Date('2081-05-01T00:00:00.000Z')});
  await vi.advanceTimersByTimeAsync(11999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal=fetchMock.mock.calls[0][1]?.signal;
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result=await operation;
  expect(signal?.aborted).toBe(true);
  expect(result.unavailable).toBe(1);
  expect(result.verified).toBe(0);
  expect(result.checks[0].status).toBe('unavailable');
  const text=result.checks[0].reasons.join('\n');
  expect(text).toContain('Official source');
  expect(text).toContain('timed out after 12000ms');
  expect(text).toContain('/flfgDetails?bbbs=timeout-source-81');
  expect(text).not.toContain('This operation was aborted');
  expect(result.archivePath).toBeUndefined();
 });
 it('preserves an abort not caused by its private timer',async()=>{
  const userAbort=new DOMException('A real parent cancellation fixture','AbortError');
  vi.stubGlobal('fetch',vi.fn(async()=>{throw userAbort;}));
  await expect(searchOfficialStatuteRecords('真实取消原样保留')).rejects.toBe(userAbort);
 });
});
