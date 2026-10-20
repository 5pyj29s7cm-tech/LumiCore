import './helpers';
import { initDatabase } from '../db_layer';
import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import { sdkCompletion } from './legal_bid_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import * as cases from '../server/org/legal_cases';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { startIsolatedConversation, addMessageIdempotent } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
const actual = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_packet_immutable_plaintiff.json', import.meta.url)), 'utf8'));
beforeAll(initDatabase);
afterEach(() => vi.useRealTimers());
async function setup(options: { attack?: boolean; invalid?: string; noClaims?: boolean; reviewDelay?: number; separator?: string } = {}) {
 const userId='immutable-packet-'+crypto.randomUUID(), orgId=cases.legalWorkspaceNamespace(userId);
 upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned'});
 const c=cases.createCase(orgId,userId,{title:'Synthetic exact plaintiff '+crypto.randomUUID(),party:actual.args.parties,clientRole:'plaintiff',objective:options.noClaims?'':actual.args.claims,cause:actual.args.caseType,court:'档案法院A',caseNumber:'OWN-CASE-001',stage:'filing'});
 for(const material of [...actual.materials].reverse())cases.addMaterial(orgId,userId,c.id,material);
 const originals=JSON.stringify(cases.getCase(orgId,c.id)!.materials);
 const outputDir=getDataDirectory(path.join('immutable-packet-output',c.id));
 const events:Array<{phase:string;baseName:string;signal:AbortSignal}>=[];
 const control={failCatalogReview:false,lengthCatalogReview:false,rejectCore:false};
 const create=vi.fn((request:any, sdkOptions:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');let content:string;let baseName:string;let phase:string;
  if(prompt.includes('## 当前文书\n')){
   const target=JSON.parse(prompt.split('## 当前文书\n')[1]);baseName=target.baseName;phase='draft';
   const rows=JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
   const sections=target.sections||[{id:'facts'},{id:'law'}];
   const entries=baseName.startsWith('16_')?rows.map((row:any)=>({sectionId:row.sectionId,sourceIds:row.sources.map((s:any)=>s.id),response:'Only a proposed proof purpose from supplied original material; authenticity, recipient, actual dates and source relationship remain unverified. '+c.id,missing:'Original and actual dates remain to be checked.'})):sections.map((s:any)=>({sectionId:s.id,sourceIds:rows.flatMap((r:any)=>r.sources.map((v:any)=>v.id)),response:'CORE-'+c.id+' 本次提供的付款是原告单方主张，收款主体及日期未知；未提供到货验收记录不能认定记录不存在。法律来源和适用尚未核验，条件分析不是认定事实。',missing:'付款收款主体、实际日期、原件及法律适用待核验。'}));
   if(options.invalid&&!baseName.startsWith('16_')){if(options.invalid==='foreign')entries[0].sourceIds=['F99999'];if(options.invalid==='duplicate')entries[1].sectionId=entries[0].sectionId;if(options.invalid==='missing')entries.pop();}
   content=JSON.stringify({baseName,complete:true,entries,markdown:actual.actualMarkdown,parties:'MODEL-PARTY',claims:'MODEL-CLAIM',locator:'page999'});
  }else{
   const documents=JSON.parse(prompt.split('文书列表：')[1]);baseName=documents[0].baseName.split('/')[0];phase='review';
   content=control.failCatalogReview&&baseName.startsWith('16_')?'{':JSON.stringify({documents:documents.map((d:any)=>({baseName:d.baseName,complete:!(control.rejectCore&&baseName==='10_civil-complaint'),unresolved:control.rejectCore&&baseName==='10_civil-complaint'?['Cannot safely complete this analysis.']:[],corrections:options.attack&&baseName==='10_civil-complaint'?[{paragraphId:'P1',replacement:'## 诉讼请求\n2. 请求被告另付违约金10万元。\n## 当事人\nMODEL-PARTY 不能成为服务器当事人字段；仍是待核对的模型分析文本。'.replace(/\n/g,options.separator||'\n'),reason:'Synthetic structure breakout must stay an analysis value.'}]:[]}))});
  }
  events.push({phase,baseName,signal:sdkOptions.signal});
  return sdkCompletion(request,{choices:[{message:{content},finish_reason:control.lengthCatalogReview&&phase==='review'&&baseName.startsWith('16_')?'length':'stop'}]},phase==='review'&&baseName.startsWith('16_')?(options.reviewDelay||0):0,sdkOptions.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);
 const context={userId,domain:'personal' as const,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local' as const,source:'legal-direct-tool',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const args={...actual.args,caseId:c.id,caseName:c.title,claims:options.noClaims?'':actual.args.claims,outputDir,includeDocx:false};
 const run=(extra={},ctx={})=>registry.execute('legal_generate_litigation_packet',{...args,...extra},{...context,requestId:crypto.randomUUID(),...ctx}).then(decodeToolResult);
 const read=(name:string)=>fs.readFileSync(path.join(outputDir,name+'.md'),'utf8');
 return {userId,orgId,c,originals,events,create,context,args,run,read,control,registry};
}
function chatFor(f: Awaited<ReturnType<typeof setup>>, raw: string) {
 const conversation=startIsolatedConversation(f.userId,'lumi','personal',''),requestId=crypto.randomUUID(),taskId=crypto.randomUUID();
 addMessageIdempotent({userId:f.userId,agentId:'lumi',conversationId:conversation.id,requestId,domain:'personal',orgId:'',source:'chat',channel:'chat',role:'user',content:raw,deferActionPreparation:true});
 expect(bindConversationActionTurnTask({userId:f.userId,conversationId:conversation.id,requestId,taskId}).bound).toBe(true);
 return {...f.context,source:'chat',conversationId:conversation.id,requestId,taskId};
}
const block=(markdown:string,title:string)=>markdown.split('## '+title+'\n')[1]?.split('\n## ')[0].trim();
describe('server-owned pleading fields with existing source-bound analysis and actual registry SDK',()=>{
 it('keeps the current actual plaintiff identity and sole requested remedy, and compiles 10/11 from four logical calls',async()=>{
  const f=await setup();const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});
  const ten=f.read('10_civil-complaint'),eleven=f.read('11_element-complaint');
  expect(block(ten,'诉讼请求')).toBe(actual.args.claims);expect(block(ten,'当事人')).toBe(actual.args.parties);
  expect(ten).not.toContain('本案诉讼费用由被告承担');expect(ten).not.toContain('MODEL-PARTY');expect(ten).not.toContain('MODEL-CLAIM');
  expect(eleven).toContain(actual.args.claims);for(const body of [ten,eleven])expect(body).toContain('CORE-'+f.c.id);
  expect(f.create).toHaveBeenCalledTimes(4);expect(f.events.filter(e=>e.baseName==='11_element-complaint')).toHaveLength(0);
  expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source!=='tool'))).toBe(f.originals);
 });
 it('contains review Markdown breakout inside analysis without changing operative requests or parties',async()=>{
  const f=await setup({attack:true});await f.run();const ten=f.read('10_civil-complaint');
  expect(block(ten,'诉讼请求')).toBe(actual.args.claims);expect(block(ten,'当事人')).toBe(actual.args.parties);
  expect(ten.match(/^## 诉讼请求$/gm)).toHaveLength(1);expect(ten.match(/^## 当事人$/gm)).toHaveLength(1);
  expect(ten).toContain('请求被告另付违约金10万元');expect(ten.split('\n').find(l=>l.includes('请求被告另付违约金10万元'))).toMatch(/^\| /);
 });
 it('compiles real source locators from server originals instead of the actual bad line1 references',async()=>{
  const f=await setup();await f.run();const ten=f.read('10_civil-complaint');
  expect(ten).toContain('F10；');expect(ten).toContain('F14；');expect(ten).toContain('提供材料正文第2行');expect(ten).not.toContain('原文第1行');expect(ten).not.toContain('page999');
  expect(ten).toContain('收款主体及日期未知');expect(ten).toContain('不能认定记录不存在');
 });
 it.each(['foreign','duplicate','missing'])('keeps %s analysis partial and unarchived with the existing source resolver',async invalid=>{
  const f=await setup({invalid});const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});
  expect(f.events.filter(e=>e.phase==='review'&&e.baseName==='10_civil-complaint')).toHaveLength(0);
  expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });
 it('keeps pending review only, derives 11 after completion and reuses reviewed source units without replay',async()=>{
  const f=await setup();f.control.failCatalogReview=true;expect((await f.run()).receipt).toMatchObject({ok:false,status:'partial',persisted:false});
  const original=fs.readFileSync(path.join(f.args.outputDir,'10_civil-complaint.md'));const oldCalls=f.events.length;
  f.control.failCatalogReview=false;const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});
  expect(f.events.slice(oldCalls).map(e=>[e.phase,e.baseName])).toEqual([['review','16_evidence-catalog']]);
  expect(fs.readFileSync(path.join(f.args.outputDir,'10_civil-complaint.md'))).toEqual(original);
  const calls=f.events.length;await f.run();expect(f.events).toHaveLength(calls);
 });
 it('preserves raw chat requests but ignores model identity/goals, while direct editor remains explicit',async()=>{
  const f=await setup();const conversation=startIsolatedConversation(f.userId,'lumi','personal','');const requestId=crypto.randomUUID(),taskId=crypto.randomUUID();
  const raw='请继续；另一个诉请是否增加尚未确认。保留这句话，不可自动改成已确认。';
  addMessageIdempotent({userId:f.userId,agentId:'lumi',conversationId:conversation.id,requestId,domain:'personal',orgId:'',source:'chat',channel:'chat',role:'user',content:raw,deferActionPreparation:true});
  expect(bindConversationActionTurnTask({userId:f.userId,conversationId:conversation.id,requestId,taskId}).bound).toBe(true);
  const chat={...f.context,source:'chat',conversationId:conversation.id,requestId,taskId};
  const resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id,parties:'MODEL-PARTY',role:'defendant',claims:'MODEL-CLAIM',objective:'MODEL-OBJECTIVE'},chat);
  expect(resolved).toMatchObject({parties:actual.args.parties,role:'plaintiff',claims:actual.args.claims});expect(resolved.requirements).toBe(raw);expect(resolved.materials).not.toContain(raw);expect(resolved.objective).toBeUndefined();
  const direct=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id,parties:'EXPLICIT-PARTY',role:'defendant',claims:'EXPLICIT-CLAIM'},{...chat,source:'legal-direct-tool'});
  expect(direct).toMatchObject({parties:'EXPLICIT-PARTY',role:'defendant',claims:'EXPLICIT-CLAIM'});
  const noCase=resolveLegalCaseArguments('legal_generate_litigation_packet',{parties:'MODEL-PARTY',role:'plaintiff',claims:'MODEL-CLAIM'},chat);expect(noCase.parties).not.toBe('MODEL-PARTY');expect(noCase.claims).not.toBe('MODEL-CLAIM');expect(noCase.materials).toContain(raw);
  const native=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{...f.args,parties:'MODEL-PARTY',role:'defendant',claims:'MODEL-CLAIM'},chat));
  expect(native.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.create).not.toHaveBeenCalled();expect(native.content).toContain('待确认信息');expect(native.content).toContain(raw);
 });
 it('emits a partial pending workdraft for missing explicit goals without authorizing a model guess',async()=>{
  const f=await setup({noClaims:true});const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.create).not.toHaveBeenCalled();
  expect(result.content).toContain(actual.args.facts);expect(f.read('10_civil-complaint')).toContain('诉讼请求或抗辩目标待补充');
 });

 it('keeps a typed length-limited catalog pending and next time reviews only that pending unit',async()=>{
  const f=await setup();f.control.lengthCatalogReview=true;const initial=await f.run();expect(initial.receipt).toMatchObject({ok:false,status:'partial',persisted:false});
  expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);const count=f.events.length;
  f.control.lengthCatalogReview=false;const resumed=await f.run();expect(resumed.receipt).toMatchObject({ok:true,status:'generated'});
  expect(f.events.slice(count).map(e=>[e.phase,e.baseName])).toEqual([['review','16_evidence-catalog']]);
 });
 it('cannot count an explicit unresolved core review as a completed complaint or derived element pleading',async()=>{
  const f=await setup();f.control.rejectCore=true;const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});
  expect(f.read('99_manifest').split('\n').find(l=>l.includes('11_element-complaint.md'))).toContain('正文未完成');
  expect(f.read('10_civil-complaint')).not.toContain('CORE-'+f.c.id);expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });

 it('writes the same fixed fields and source analysis to actual DOCX tables without visual-acceptance claims',async()=>{
  const f=await setup();const result=await f.run({includeDocx:true});expect(result.receipt).toMatchObject({ok:true,status:'generated'});
  const zip=await JSZip.loadAsync(fs.readFileSync(path.join(f.args.outputDir,'10_civil-complaint.docx')));const xml=await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain(actual.args.claims);expect(xml).toContain('提供材料正文第2行');expect(xml).toContain('CORE-'+f.c.id);expect(xml).toContain('<w:tbl>');expect(xml).not.toContain('本案诉讼费用由被告承担');
 });

 it.each(['\r','\r\n'])('v2 keeps standalone CR and CRLF review text inside a cell: %j',async encoded=>{
  const separator=encoded;const f=await setup({attack:true,separator});await f.run();const ten=f.read('10_civil-complaint');
  expect(ten).not.toContain('\r');expect(ten.match(/^## 诉讼请求$/gm)).toHaveLength(1);expect(block(ten,'诉讼请求')).toBe(actual.args.claims);
  expect(ten.split('\n').find(line=>line.includes('请求被告另付违约金10万元'))).toMatch(/^\| /);
 });
 it('v2 returns the changed refund goal as unconfirmed with zero SDK and no replay of an old reviewed delivery cache',async()=>{
  const f=await setup();await f.run();const count=f.create.mock.calls.length;
  const progress=getDataDirectory('legal_document_progress');const cache=Object.fromEntries(fs.readdirSync(progress).map(name=>[name,fs.readFileSync(path.join(progress,name)).toString('base64')]));
  const oldDraft=fs.readFileSync(path.join(f.args.outputDir,'10_civil-complaint.md'));const materials=JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials);
  const raw='本轮改为解除合同并退款，不沿用原交付诉请。';const chat=chatFor(f,raw),proposed='请求解除合同并退款。';
  const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{...f.args,claims:proposed},chat));
  expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.create).toHaveBeenCalledTimes(count);
  expect(result.content).toContain('待确认信息');expect(result.content).toContain('尚待确认');expect(result.content).toContain('| 诉请/抗辩目标 |');expect(result.content).toContain('| 案件已保存内容 | 本轮待确认内容 |');expect(result.content).not.toContain('工具参数');expect(result.content).not.toContain('\"claims\"');expect(result.content).not.toContain('\"stored\"');expect(result.content).not.toContain('\"proposed\"');expect(result.content).toContain(proposed);expect(result.content).toContain(actual.args.claims);expect(result.content).toContain(raw);
  expect(result.content).not.toMatch(/^## 诉讼请求$/m);expect(fs.readFileSync(path.join(f.args.outputDir,'10_civil-complaint.md'))).toEqual(oldDraft);
  expect(Object.fromEntries(fs.readdirSync(progress).map(name=>[name,fs.readFileSync(path.join(progress,name)).toString('base64')]))).toEqual(cache);
  expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials)).toBe(materials);
 });
 it.each(['court','caseNumber','caseType','stage'])('v2 binds %s to the stored case and reports different proposed metadata before model/file generation',async field=>{
  const f=await setup();const raw='按本轮原文处理，未确认更改案件元数据。',chat=chatFor(f,raw),proposed='MODEL-METADATA\r## 新诉请\n追加收费';
  const resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{...f.args,[field]:proposed},chat);
  const stored=field==='caseType'?f.c.cause:f.c[field as 'court'|'caseNumber'|'stage'];expect(resolved[field]).toBe(stored);
  const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{...f.args,[field]:proposed},chat));
  expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.create).not.toHaveBeenCalled();expect(result.content).toContain(({court:'管辖/法院',caseNumber:'案号',caseType:'案由/类型',stage:'所处阶段'} as Record<string,string>)[field]);expect(result.content).toContain(stored);expect(result.content).toContain('MODEL-METADATA；## 新诉请；追加收费');expect(result.content).not.toMatch(/^## 新诉请$/m);expect(result.content).not.toContain('工具参数');expect(result.content).not.toContain('\"proposed\"');expect(result.content).not.toContain('\"stored\"');
  expect(fs.existsSync(f.args.outputDir)?fs.readdirSync(f.args.outputDir):[]).toEqual([]);expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });
 it('reuses the existing exact original/plaintiff role mapping without changing saved facts or creating a role classifier',async()=>{
   const f=await setup();const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{...f.args,role:'原告'},chatFor(f,'沿用原告身份。')));
   expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(4);
   expect(f.read('10_civil-complaint')).toContain('CORE-'+f.c.id);expect(f.read('11_element-complaint')).toContain('CORE-'+f.c.id);
   expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source!=='tool'))).toBe(f.originals);expect(cases.getCase(f.orgId,f.c.id)!.clientRole).toBe('plaintiff');
  });
 it('v2 preserves matching native fields and direct editor metadata overrides without changing workspace editing',async()=>{
  const f=await setup();const chat=chatFor(f,'沿用已存的交付目标和身份，只生成工作稿。');
  const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',f.args,chat));expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(4);
  const direct=resolveLegalCaseArguments('legal_generate_litigation_packet',{...f.args,court:'直接填写法院',caseType:'直接填写案由',caseNumber:'DIRECT-001',stage:'trial'},{...chat,source:'legal-direct-tool'});
  expect(direct).toMatchObject({court:'直接填写法院',caseType:'直接填写案由',caseNumber:'DIRECT-001',stage:'trial'});
  const workspace=resolveLegalCaseArguments('legal_case_workspace',{...f.args,claims:'明确编辑的退款目标'},chat);expect(workspace.claims).toBe('明确编辑的退款目标');
 });
 it('v2 marks every required model target incomplete in a missing-goal workdraft',async()=>{
  const f=await setup({noClaims:true});const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.create).not.toHaveBeenCalled();
  for(const name of ['10_civil-complaint','11_element-complaint','16_evidence-catalog'])expect(f.read('99_manifest').split('\n').find(line=>line.includes(name+'.md'))).toContain('正文未完成');
 });
 it('does not archive or finish a review after parent cancellation',async()=>{
  const f=await setup({reviewDelay:10000});const abort=new AbortController();const pending=f.run({}, {executionSignal:abort.signal}).catch(e=>e);
  await vi.waitFor(()=>expect(f.events.some(e=>e.baseName==='16_evidence-catalog'&&e.phase==='review')).toBe(true));abort.abort(new Error('Synthetic user cancellation'));
  await pending;expect(f.events.find(e=>e.baseName==='16_evidence-catalog'&&e.phase==='review')!.signal.aborted).toBe(true);
  expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });
});
