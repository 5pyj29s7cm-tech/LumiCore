import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { createOrg, addMember } from '../server/org/db';
import * as cases from '../server/org/legal_cases';
import * as articles from '../server/org/kb';
import { processNoticeLinkHandler } from '../server/regions/packs/cn/legal_tools/notice_intake';
vi.mock('../server/legal/kb', async original => ({ ...await original<typeof import('../server/legal/kb')>(), indexLegalArticle: vi.fn().mockResolvedValue(0) }));
let cleanup = () => {};
beforeAll(async () => { const app = await makeApp(); cleanup = app.cleanup; });
afterAll(() => cleanup());
const sourceBody = '<html><body><p>FIRST SOURCE</p><p>'+ 'Synthetic source paragraph '.repeat(1800)+'TAIL MUST SURVIVE</p></body></html>';
function scope(name: string) { const userId='notice-owner-'+name; const orgId=createOrg('Synthetic notice organization', 'notice-'+name+'-'+Date.now(), userId).id; addMember(orgId,userId,'owner'); const caseFile=cases.createCase(orgId,userId,{title:'Synthetic notice case '+name}); return {userId,orgId,caseFile}; }
describe('notice source completeness', () => {
  it('keeps a long webpage intact in both the source note and existing case archive while keeping the displayed excerpt bounded', async () => {
    const {userId,orgId,caseFile}=scope('archive');
    const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(sourceBody,{headers:{'content-type':'text/html'}}));
    try {
      const output=await processNoticeLinkHandler({caseId:caseFile.id,caseName:caseFile.title,url:'https://court.example.test/source',extractedTextLimit:600},{userId,orgId,domain:'work'});
      const reportPath=output.match(/留痕报告：([^\r\n]+)/)?.[1]; expect(reportPath).toBeTruthy();
      const report=fs.readFileSync(reportPath!,'utf8'); expect(report).toContain('FIRST SOURCE'); expect(report).toContain('TAIL MUST SURVIVE');
      expect(cases.getCase(orgId,caseFile.id,userId)!.materials.some(material=>material.content.includes('TAIL MUST SURVIVE'))).toBe(true);
      expect(output).not.toContain('TAIL MUST SURVIVE');
      expect(output).toContain('正式 PDF 尚未取得'); expect(output).toContain('partial');
    } finally {fetchMock.mockRestore();}
  });
  it('stores full long webpage text in the authorized organization knowledge article', async () => {
    const {userId,orgId,caseFile}=scope('knowledge');
    const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(sourceBody,{headers:{'content-type':'text/html'}}));
    try {
      const output=await processNoticeLinkHandler({caseId:caseFile.id,caseName:caseFile.title,url:'https://court.example.test/source',confirmedForKb:true},{userId,orgId,domain:'work'});
      const articleId=output.match(/articleId=([^，\s]+)/)?.[1]; expect(articleId).toBeTruthy();
      const article=articles.getArticle(orgId,articleId!,userId)!; expect(article.content).toContain('TAIL MUST SURVIVE'); expect(article.content.length).toBeGreaterThan(40000);
    } finally {fetchMock.mockRestore();}
  });
  it('keeps a login page as browser handoff and never calls it a completed document download', async () => {
    const {userId,orgId,caseFile}=scope('login');
    const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<html><input type="password"></html>',{headers:{'content-type':'text/html'}}));
    try {
      const output=await processNoticeLinkHandler({caseId:caseFile.id,caseName:caseFile.title,url:'https://court.example.test/login'},{userId,orgId,domain:'work'});
      expect(output).toContain('browser_handoff'); expect(output).not.toContain('已下载材料并保存'); expect(articles.listArticles(orgId,undefined,userId)).toHaveLength(0);
    } finally {fetchMock.mockRestore();}
  });
});
