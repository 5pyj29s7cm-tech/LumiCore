import './helpers';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {searchOfficialStatuteRecords} from '../server/legal/statute_authority_refresh';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Explicit single-law title queries cannot read another law with the same article',()=>{
 it.each(['《未知晴川法》第五条 当事人应当履行义务','未知晴川法 相关事项 第五条 当事人应当履行义务'])('queries only the unique explicit law title before any record read: %s',async query=>{
  const calls:string[]=[];const fetchMock=vi.fn(async(url:unknown,init?:RequestInit)=>{calls.push(String(url));
   const title=JSON.parse(String(init?.body)).searchContent;
   expect(title).toBe('未知晴川法');
   return Response.json({code:200,rows:[{bbbs:'unrelated-source',title:'另一无关规则'}]});
  });vi.stubGlobal('fetch',fetchMock);
  expect(await searchOfficialStatuteRecords(query)).toEqual([]);expect(calls).toEqual(['https://flk.npc.gov.cn/law-search/search/list']);
 });
 it.each(['未知晴川法。另一个独立事项 第五条','未知晴川法\n相关事项 第五条','未知晴川法 未知澄溪条例 第五条'])('does not combine a title across a sentence or another explicit law: %s',async query=>{
  const fetchMock=vi.fn(async(_url:unknown,init?:RequestInit)=>{expect(JSON.parse(String(init?.body)).searchContent).toBe(query);return Response.json({code:200,rows:[]});});vi.stubGlobal('fetch',fetchMock);
  expect(await searchOfficialStatuteRecords(query)).toEqual([]);expect(fetchMock).toHaveBeenCalledTimes(1);
 });
});
