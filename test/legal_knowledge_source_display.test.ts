import './helpers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { searchStatutes, searchSimilarCases } from '../server/legal/kb';
import { searchLegalAuthorityDatabase } from '../server/legal/sources';
vi.mock('../server/legal/kb', async original=>({...await original<typeof import('../server/legal/kb')>(),searchStatutes:vi.fn(),searchSimilarCases:vi.fn()}));
vi.mock('../server/legal/sources',async original=>({...await original<typeof import('../server/legal/sources')>(),searchLegalAuthorityDatabase:vi.fn()}));
const registry=new ToolRegistry();let app:Awaited<ReturnType<typeof makeApp>>;
const context={userId:'law-source-view-owner',domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local'} as any;
beforeAll(async()=>{app=await makeApp();registerLegalTools(registry);});afterAll(()=>app.cleanup());afterEach(()=>vi.resetAllMocks());
const row=(overrides={})=>({articleId:'source-a',title:'虚构法源条款',chunk:'仅供界面验收的虚构法源原文。'.repeat(40)+'尾段条件：适用例外必须核验，未提供不等于不存在。',citationKey:'SOURCE:ARTICLE:10',sourceUrl:'https://example.invalid/law/10',isEffective:false,verificationStatus:'missing',...overrides}) as any;
async function statute(value:any){vi.mocked(searchStatutes).mockResolvedValue([value]);vi.mocked(searchLegalAuthorityDatabase).mockResolvedValue([]);return registry.execute('legal_search_statute',{query:'验收法源'},context);}
describe('registered legal source display preserves status, authorized originals and court order',()=>{
 it.each(['missing','unavailable','expired','changed'])('does not turn unknown verification %s into repeal or applicable law',async verificationStatus=>{const text=await statute(row({verificationStatus}));expect(text).toContain('待核验有效性');expect(text).not.toMatch(/已废止|现行有效/);});
 it('preserves the entire authorized original and citation instead of dropping the exception tail',async()=>{const source=row();const text=await statute(source);expect(text).toContain(source.chunk);expect(text).toContain(source.citationKey);expect(searchStatutes).toHaveBeenCalledWith('personal:law-source-view-owner','验收法源',5,context.userId);});
 it('distinguishes verified source state from case applicability and historical repeal',async()=>{const verified=await statute(row({verificationStatus:'verified',isEffective:true}));expect(verified).toContain('来源状态已核验，适用性待复核');expect(verified).not.toContain('本案适用已通过');const repealed=await statute(row({verificationStatus:'repealed'}));expect(repealed).toContain('已废止，需检查历史适用');});
 it('does not invent missing statute text or replace it with a title',async()=>{const text=await statute(row({chunk:''}));expect(text).toContain('未取得可展示的法条全文');expect(text).toContain('SOURCE:ARTICLE:10');expect(text).not.toContain('尾段条件');});
 it('keeps the real external-source boundary when neither authorized owner returns results',async()=>{vi.mocked(searchStatutes).mockResolvedValue([]);vi.mocked(searchLegalAuthorityDatabase).mockResolvedValue([]);const text=await registry.execute('legal_search_statute',{query:'未命中法源'},context);expect(text).toContain('未找到');expect(text).not.toMatch(/现行有效|已废止|来源状态已核验/);});
 it('orders found cases Supreme, High, Intermediate and Basic while preserving exact source excerpts',async()=>{const text='虚构裁判原文'.repeat(100)+'尾句：未证明并不等于事实不存在。';const cases=[{court:'模拟市基层人民法院',title:'基层',score:99},{court:'模拟省高级人民法院',title:'高院',score:3},{court:'最高人民法院',title:'最高',score:1},{court:'模拟市中级人民法院',title:'中院',score:8}].map((x,i)=>({...x,articleId:'case-'+i,citationKey:'CASE:'+i,caseNumber:'模拟案号'+i,source:'keyword' as const,chunk:text}));vi.mocked(searchSimilarCases).mockResolvedValue(cases);const output=await registry.execute('legal_search_case',{query:'虚构裁判',limit:4},context);expect(output.indexOf('**最高**')).toBeLessThan(output.indexOf('**高院**'));expect(output.indexOf('**高院**')).toBeLessThan(output.indexOf('**中院**'));expect(output.indexOf('**中院**')).toBeLessThan(output.indexOf('**基层**'));for(const c of cases){expect(output).toContain(c.chunk);expect(output).toContain(c.citationKey);}expect(searchSimilarCases).toHaveBeenCalledWith('personal:law-source-view-owner','虚构裁判',16,context.userId);});
});
