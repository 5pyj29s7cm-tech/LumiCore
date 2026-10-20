import './helpers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import { createOrg, addMember } from '../server/org/db';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { makeLLMCall } from '../server/llm/providers';
import * as Cases from '../server/org/legal_cases';
import { bindIndustryWorkspaceContext } from '../server/industry/workspace_context';
import { buildReasoningSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import { legalRuleParts } from '../server/regions/packs/cn/legal_reasoning_links';
import { legalCaseSourceFingerprint, isLegalSourceMaterial } from '../shared/legal_workflow_receipts';
import { archiveLegalReportToCase } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { verifyCitation } from '../server/legal/kb';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
const registry = new ToolRegistry();
const context = { userId:'shared-case-owner', domain:'work', orgId:'', authenticated:true, authRole:'admin', localExecution:true, executionBoundary:'trusted_local', llmGetters:{} } as any;
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{ app=await makeApp(); context.orgId=createOrg('Shared case source fixture','shared-case-source',context.userId).id; addMember(context.orgId,context.userId,'owner'); installCivilCodeFixture(); registerLegalTools(registry); });
afterAll(()=>app.cleanup()); afterEach(()=>vi.resetAllMocks());
const execute=async(name:string,args:any,extra={})=>{const out=decodeToolResult(await registry.execute(name,args,{...context,...extra}));if(!out.receipt||typeof out.receipt!=='object')throw Error('Missing structured legal receipt');return {...out,receipt:out.receipt as Record<string,unknown>};};
function item() { const c=Cases.createCase(context.orgId,context.userId,{title:'虚构来源核验案',party:'甲公司；乙公司',clientPartyName:'甲公司',clientRole:'原告',objective:'仅核验草稿',cause:'买卖合同纠纷',court:'模拟法院',stage:'trial',factDate:'2026-09-01',notes:'原始摘要不得清空'}); const m=Cases.addMaterial(context.orgId,context.userId,c.id,{type:'evidence',source:'manual',title:'虚构回单原文',content:'甲方称已签收设备，尚欠二万元；违约金全文未提供。'})!; return{c,m}; }
function responses() { const quote=verifyCitation('《民法典》第585条').sourceText!;const checks=legalRuleParts(quote).map(p=>({partId:p.id,sourceIds:['F1'],status:'conditional',application:'需结合约定全文及实际损失核实，未提供不等于未约定。',conclusion:'仅凭现有材料不能确定违约金数额。',missingPremises:['完整约定及损失凭据待补充']}));return[{text:JSON.stringify({entries:[{issue:'违约金待核实',ruleId:'R1',checks}]}),toolCalls:null},{text:JSON.stringify({reviews:[{index:1,checks}],uncoveredIssues:[]}),toolCalls:null}]; }
describe('shared backend original case sources and reasoning archive boundary',()=>{
 it('keeps raw chat materials as originals and supplies them to the existing reasoning resolver and packet files',async()=>{
  const raw='虚构采购回单全文：甲方主张已支付二万元，真实性待核实；合同全文尚未提供。';
  const title='仅用于验收的原始材料案件';
  const result=await execute('legal_case_workspace',{caseName:title,materials:raw,role:'原告',factDate:'2026-09-01'}, {actionIntent:'新建案件'});
  expect(result.receipt?.ok).toBe(true); const c=Cases.listCases(context.orgId,title,10,context.userId).find(c=>c.title===title)!;
  const original=c.materials.find(m=>m.content===raw)!;expect(original).toMatchObject({source:'manual',title:'聊天原始材料'});expect(isLegalSourceMaterial(original)).toBe(true);
  const sources=buildReasoningSources(c,'《民法典》第585条',context.orgId,{actorUserId:context.userId});expect(sources.sources).toContainEqual(expect.objectContaining({materialId:original.id,quote:raw}));
  const [draft,review]=responses(); vi.mocked(makeLLMCall).mockResolvedValueOnce(draft).mockResolvedValueOnce(review);
  const matrix=await execute('legal_case_reasoning_matrix',{caseId:c.id,legalAuthorities:'《民法典》第585条',writeFiles:false});expect(matrix.receipt).toMatchObject({ok:true,reasoningLinked:true});
  const prompt=String(vi.mocked(makeLLMCall).mock.calls[0][0].find(m=>m.role==='user')!.content);expect(prompt).toContain(raw);expect(prompt).toContain(original.id);
  const packet=await execute('legal_generate_litigation_packet',{caseId:c.id}, {llmGetters:undefined});expect(packet.receipt?.ok).toBe(false);
  const file=(packet.receipt?.artifacts as string[]).find(p=>p.endsWith('16_evidence-catalog.md'))!;expect(fs.readFileSync(file,'utf8')).toContain(raw);
 });
 it('preserves omitted fields, exact original dedupe, and material tombstones on continuing an existing case',async()=>{
  const {c}=item();const args={caseId:c.id,materials:'原始补充内容，尚待核验'};await execute('legal_case_workspace',args);const first=Cases.getCase(context.orgId,c.id,context.userId)!;
  await execute('legal_case_workspace',args);const second=Cases.getCase(context.orgId,c.id,context.userId)!;expect(second.materials).toHaveLength(first.materials.length);const removed=second.materials.find(m=>m.content===args.materials)!;const revision=Cases.getMaterialReview(context.orgId,context.userId,c.id,removed.id)!;Cases.removeMaterial(context.orgId,context.userId,c.id,removed.id,revision.revision);
  await execute('legal_case_workspace',{caseId:c.id});expect(Cases.getCase(context.orgId,c.id,context.userId)).toMatchObject({party:c.party,cause:c.cause,court:c.court,stage:c.stage,factDate:c.factDate,clientPartyName:c.clientPartyName,clientRole:c.clientRole,objective:c.objective,notes:first.notes,removedMaterialIds:[removed.id]});
 });
 it('creates a new identity for an explicit same-name new request rather than consuming the active case',async()=>{
  const {c}=item();bindIndustryWorkspaceContext({userId:context.userId,domain:'work',orgId:context.orgId,productLine:'legal'},{name:c.title,attributes:{caseId:c.id,caseName:c.title}});
  const before=Cases.getCase(context.orgId,c.id,context.userId)!;const result=await execute('legal_case_workspace',{caseId:c.id,caseName:c.title,materials:'新案原始内容'}, {actionIntent:'新建案件，同名也是独立新案'});
  expect(result.receipt?.ok).toBe(true);const same=Cases.listCases(context.orgId,c.title,100,context.userId).filter(x=>x.title===c.title);expect(same.some(x=>x.id!==c.id&&x.materials.some(m=>m.content==='新案原始内容'))).toBe(true);expect(Cases.getCase(context.orgId,c.id,context.userId)).toEqual(before);
 });
 it.each(['no-model','empty','missing-source','wrong-source'])('does not archive a failed matrix (%s), while retaining the actual output file and originals',async mode=>{
  const {c,m}=item();const initial=Cases.getCase(context.orgId,c.id,context.userId)!;const quote=verifyCitation('《民法典》第585条').sourceText!;
  const args:any={caseId:c.id,legalAuthorities:'《民法典》第585条',writeFiles:true};
  if(mode==='empty')vi.mocked(makeLLMCall).mockResolvedValue({text:'{"entries":[]}',toolCalls:null});
  if(mode==='missing-source'||mode==='wrong-source')args.reasoningLinks=[{issue:'违约金待核实',ruleCitation:'《民法典》第585条',ruleQuote:quote,fact:m.content,evidence:mode==='missing-source'?[]:[{materialId:'foreign-material-id',quote:m.content,locator:'原句'}],application:'待完整约定核实',conclusion:'暂不能确认',limitations:'待补材料'}];
  const out=await execute('legal_case_reasoning_matrix',args,mode==='no-model'?{llmGetters:undefined}:{});expect(out.receipt).toMatchObject({ok:false,status:'partial',reasoningLinked:false});expect(out.content).not.toContain('底稿已生成');expect(out.content).toContain('未归档');
  const after=Cases.getCase(context.orgId,c.id,context.userId)!;expect(after.materials).toEqual(initial.materials);expect(after.notes).toBe(initial.notes);expect(after.workflowRuns?.at(-1)).toMatchObject({ok:false,status:'partial',materialIds:[]});
  const file=(out.receipt?.artifacts as string[]).find(p=>path.basename(p)==='legal-reasoning-matrix.md')!;expect(fs.readFileSync(file,'utf8')).toContain('来源关联检查：未通过');expect(fs.readFileSync(file,'utf8')).toContain('违约金全文未提供');
  const delivery=await execute('legal_finalize_delivery_package',{caseId:c.id,content:'依据《民法典》第585条分析。当前材料不足以确定违约金。',includeDocx:false});expect(delivery.receipt).toMatchObject({ok:false,status:'blocked'});expect(delivery.content).toContain('正式交付包未生成');
 });
 it('archives only source-verified model and review results with the exact source fingerprint',async()=>{
  const {c,m}=item();const initial=Cases.getCase(context.orgId,c.id,context.userId)!;const [draft,review]=responses();vi.mocked(makeLLMCall).mockResolvedValueOnce(draft).mockResolvedValueOnce(review);
  const out=await execute('legal_case_reasoning_matrix',{caseId:c.id,legalAuthorities:'《民法典》第585条',writeFiles:false});expect(makeLLMCall).toHaveBeenCalledTimes(2);expect(out.receipt).toMatchObject({ok:true,reasoningLinked:true,reasoningReviewed:true});
  const analysis=Cases.getCase(context.orgId,c.id,context.userId)!.materials.find(x=>x.reasoningLinks?.length)!;expect(analysis.reasoningBasis).toBe(legalCaseSourceFingerprint(initial));expect(analysis.reasoningLinks![0].evidence[0]).toMatchObject({materialId:m.id,quote:m.content});expect(analysis.reasoningLinks![0].application).toContain('未提供不等于未约定');
  const delivery=await execute('legal_finalize_delivery_package',{caseId:c.id,content:'依据《民法典》第585条进行条件分析。'+analysis.reasoningLinks![0].conclusion,includeDocx:false});expect(delivery.receipt?.ok).toBe(true);const linksFile=(delivery.receipt.artifacts as string[]).find(p=>p.endsWith('05_reasoning-links.md'))!;expect(fs.readFileSync(linksFile,'utf8')).toContain(m.content);
 });
 it('does not create a case for a standalone incomplete matrix',async()=>{const before=Cases.listCases(context.orgId,'',1000,context.userId).length;const out=await execute('legal_case_reasoning_matrix',{caseName:'虚构未完成独立矩阵',facts:'只有当事人主张，未提供证据',writeFiles:false},{llmGetters:undefined});expect(out.receipt?.ok).toBe(false);expect(Cases.listCases(context.orgId,'',1000,context.userId)).toHaveLength(before);});
 it('does not pass a heading-only formal delivery without original links',async()=>{const {c}=item();const out=await execute('legal_finalize_delivery_package',{caseId:c.id,content:'依据《民法典》第585条。尚不能确定具体违约金。',reasoningSummary:'大前提：民法典规定约定违约金及依法调整规则。小前提：当事人主张有交货及欠款，需要核验原件。结论：结合大前提分析付款义务及违约金，最终金额有待证据核验。',includeDocx:false});expect(out.receipt).toMatchObject({ok:false,status:'blocked'});expect(out.content).toContain('来源关联未通过');});
 it.each(['','当事人提供的原始条款，真实与否待核验'])('never uses generated work product as a new case fact summary (%s)',raw=>{const title='虚构报告新案-'+(raw?'有原件':'无原件');archiveLegalReportToCase({caseName:title,contract:raw},{orgId:context.orgId,userId:context.userId,caseName:title,title:'AI生成的工作报告',content:'这是生成报告的推断，禁止被当作原始事实。'});const c=Cases.listCases(context.orgId,title,1,context.userId)[0];expect(c.notes).toBe(raw);expect(c.notes).not.toContain('这是生成报告');expect(c.materials).toHaveLength(1);expect(isLegalSourceMaterial(c.materials[0])).toBe(false);});
 it('rejects a different organization target before reading or updating its case',async()=>{const {c}=item();const before=Cases.getCase(context.orgId,c.id,context.userId)!;const otherOrg=createOrg('Separate owner fixture','separate-owner-'+c.id,'foreign-owner').id;addMember(otherOrg,'foreign-owner','owner');await expect(execute('legal_case_reasoning_matrix',{caseId:c.id,facts:'不可挪用'},{userId:'foreign-owner',orgId:otherOrg})).rejects.toThrow();expect(Cases.getCase(context.orgId,c.id,context.userId)).toEqual(before);});

});
