import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildMaterialSources} from '../server/regions/packs/cn/legal_reasoning_generation';
import {buildBidChapters,resolveBidChapter,buildGroundedBidDraft} from '../server/regions/packs/cn/legal_work_product_quality';
const fixtureDirectory=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','legal_bid_actual_62');
const input=JSON.parse(fs.readFileSync(path.join(fixtureDirectory,'actual-62.json'),'utf8'));
const sources=buildMaterialSources(input.sourceRead.map((file:any,index:number)=>({id:'synthetic-source-'+index,title:'招标文件 '+path.basename(file.file),content:file.text})));
const chapters=buildBidChapters(sources);
const drafts=new Map<string,ReturnType<typeof resolveBidChapter>>();
let cursor=0;
for(const chapter of chapters){
  const raw=chapter.sections.map(section=>{const block=input.blocks[cursor++];expect(block.title).toBe(section.title);return{sectionId:section.id,sourceIds:block.sourceIds,response:block.response,missing:block.missing}});
  drafts.set(chapter.id,resolveBidChapter({entries:raw},sources,chapter));
}
const markdown=buildGroundedBidDraft(input.projectName,'',sources,chapters,drafts);
const row=(title:string,body=markdown)=>body.split('\n').find(line=>line.startsWith('| '+title+' |'))!;
const entry=(title:string)=>drafts.get('response')!.find(value=>chapters[2].sections.find(s=>s.id===value.sectionId)?.title===title)!;
const cell=(value:string)=>value.replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
describe('same62 actual bid responses preserve their selected sources in the worksheet',()=>{
  it('retains all164 original paragraphs,56 response targets and62 exact response/missing texts',()=>{
    expect(sources).toHaveLength(164);expect(chapters[2].sections).toHaveLength(56);expect(cursor).toBe(62);
    for(const block of input.blocks){expect(markdown).toContain('#### 拟议响应（模型工作稿，未作事实认定或核准）\n\n'+block.response);expect(markdown).toContain('#### 待补与核验\n\n'+block.missing)}
    expect(markdown).toContain('56/56 项');
    for(const file of input.sourceRead)expect(createHash('sha256').update(fs.readFileSync(path.join(fixtureDirectory,file.file))).digest('hex')).toBe(file.sha256);
  });
  it.each(['R09【报价组成】','R15【阶段计划】','R18【服务响应】','E05【业绩 10 分】'])('preserves every already-selected source id/title/locator for %s',title=>{
    const value=entry(title);expect(value.sources.length).toBeGreaterThan(1);
    for(const source of value.sources)expect(row(title)).toContain(source.id+'；'+source.title+'；'+source.locator);
  });
  it.each(['R03【限价】','D02【超限价】','D03【虚假证明】','D05【期限与提交】','F01【目录】'])('shows the original missing text without treating its nonempty string as a missing-business decision: %s',title=>{
    expect(row(title)).toContain(cell(entry(title).missing));
    expect(row(title)).toContain('已取得拟议响应；内容待核验，未核准');expect(row(title)).not.toContain('有待补项');
  });
  it('does not invent an unselected team source or claim it is verified',()=>{
    const team=entry('E04【团队 10 分】');expect(team.sources.map(s=>s.id)).toEqual(['F76','F77']);
    expect(team.response).toContain('拟投入人员（B05）');expect(row('E04【团队 10 分】')).not.toContain('F130；');expect(row('E04【团队 10 分】')).not.toContain('已核验证明');
    expect(row('B05：')).toContain('F130；');
  });
  it('keeps qualification absence explicit and never publishes review/qualification approval',()=>{
    const qualification=row('D01【必缺资格】');expect(qualification).toContain('专项维护资质证原件或可核验电子证');expect(qualification).toContain('未核准');
    expect(markdown).toContain('本次资格只能“待补/无法确认”');expect(markdown).toContain('不生成证明或签认');
  });
  it('keeps a missing response unavailable rather than borrowing another response source or declaring generated',()=>{
    const incomplete=new Map(drafts);incomplete.set('response',drafts.get('response')!.filter(e=>e.sectionId!==entry('R09【报价组成】').sectionId));
    const missing=buildGroundedBidDraft(input.projectName,'',sources,chapters,incomplete);
    expect(row('R09【报价组成】',missing)).toContain('尚未取得来源绑定的逐项响应，待补');expect(row('R09【报价组成】',missing)).not.toContain('F139；');expect(missing).toContain('55/56 项');
  });
});
