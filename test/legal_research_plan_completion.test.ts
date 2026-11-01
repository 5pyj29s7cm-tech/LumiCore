import './helpers';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { external_researchTools } from '../server/regions/packs/cn/legal_tools/definitions_external_research';
import { externalResearchPlanHandler } from '../server/regions/packs/cn/legal_tools/external_workspace';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { encodeToolResult } from '../server/tools/result_envelope';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { isCanonicalToolExecutionRecord } from '../server/tools/canonical_execution_record';
import { hasCurrentLegalResearchPlanEvidence } from '../server/cognition/legal_research_plan_evidence';
import { claimsExternalLegalPlatformResult } from '../server/cognition/result_policy_evidence';
import * as Cases from '../server/org/legal_cases';
vi.mock('../server/regions/packs/cn/legal_tools/external_workspace', async original => ({ ...await original<Record<string,unknown>>(), externalResearchPlanHandler:vi.fn() }));
const taskText='生成法蝉、Alpha 和裁判文书网检索计划';
const responseText='已生成授权协作检索行动单，待律师登录法蝉、Alpha 和裁判文书网核验并归档来源。';
const report='# Synthetic research plan\nSearch order and source-register columns. No platform was queried.';
beforeAll(()=>initDatabase());
beforeEach(()=>{vi.mocked(externalResearchPlanHandler).mockReset().mockResolvedValue(report);});
async function fixture(args:Record<string,unknown>={}) {
 const userId='plan-fixture-'+randomUUID(),requestId=randomUUID(),taskId=randomUUID();
 const registry=new ToolRegistry();registry.register(external_researchTools().find(tool=>tool.name==='legal_external_research_plan')!);
 const record=await executeToolCall({registry,name:'legal_external_research_plan',arguments:{persistCase:false,...args},context:{userId,requestId,taskId,turnId:requestId,authenticated:true,authRole:'user',domain:'personal',orgId:'',localExecution:true,executionBoundary:'trusted_local'}});
 return {record,requestId,taskId,finalize:(response=responseText,task=taskText,records=[record],scope:{requestId:string;taskId:string}={requestId,taskId})=>finalizeLumiResponse({taskText:task,responseText:response,toolRecords:records,source:'chat',...scope})};
}
describe('current canonical legal research plan delivery',()=>{
 it('returns typed plan-only evidence and accepts a plan-only claim',async()=>{
  const f=await fixture();expect(f.record.error).toBeUndefined();expect(isCanonicalToolExecutionRecord(f.record)).toBe(true);
  expect(f.record.receipt).toMatchObject({ok:true,status:'planned',persisted:false,changedCaseIds:[],artifacts:[],content:report});
  expect(f.record.terminalVerification?.status).toBe('verified');
  const result=f.finalize();expect(result.blocked).toBe(false);expect(result.text).toBe(responseText);
  expect(externalResearchPlanHandler).toHaveBeenCalledTimes(1);
 });
 it('does not upgrade a partial handler result to a completed plan',async()=>{
  vi.mocked(externalResearchPlanHandler).mockResolvedValue(encodeToolResult('Only a partial plan exists.',{ok:false,status:'partial'}));
  const f=await fixture();expect(f.finalize().blocked).toBe(true);
 });
 it('does not use a plan as evidence of platform results or external sending',async()=>{
  const f=await fixture();
  for(const response of ['已生成授权协作检索行动单。已在法蝉查到裁判结果。','已生成授权协作检索行动单。已发送给客户。'])expect(f.finalize(response).blocked,response).toBe(true);
 });
 it('rejects legacy prose, copied records, old requests and other tasks',async()=>{
  const f=await fixture();
  expect(f.finalize(responseText,taskText,[{name:f.record.name,arguments:{},result:report}]).blocked).toBe(true);
  expect(f.finalize(responseText,taskText,[{...f.record}]).blocked).toBe(true);
  for(const scope of [{requestId:'old',taskId:f.taskId},{requestId:f.requestId,taskId:'other'}, {requestId:'',taskId:''}])expect(f.finalize(responseText,taskText,[f.record],scope).blocked).toBe(true);
 });
 it.each(['', encodeToolResult('Plan incomplete.',{ok:false,status:'blocked'})])('does not complete on empty or blocked content',async content=>{
  vi.mocked(externalResearchPlanHandler).mockResolvedValue(content);
  const f=await fixture();expect(f.finalize().blocked).toBe(true);
 });
 it('does not convert generation without persistence into an archive claim',async()=>{
  const f=await fixture();expect(f.finalize('已生成并归档授权协作检索行动单。').blocked).toBe(true);
 });
 it('proves an optional archive only from the exact registry-owned material write',async()=>{
  vi.mocked(externalResearchPlanHandler).mockImplementation(async(args,context)=>{
    const userId=context.userId,orgId=Cases.legalWorkspaceNamespace(userId);
    const item=Cases.createCase(orgId,userId,{title:args.caseName});
    Cases.addMaterial(orgId,userId,item.id,{title:'Synthetic research plan',type:'note',content:report,source:'tool'});
    return report;
  });
  const f=await fixture({caseName:'Isolated research plan',persistCase:true});
  expect(f.record.error).toBeUndefined();expect(f.record.receipt).toMatchObject({ok:true,status:'planned',persisted:true});
  expect((f.record.receipt as any).materialSources).toHaveLength(1);
  expect(f.finalize('已生成并归档授权协作检索行动单。').blocked).toBe(false);
 });
 it('fails a requested archive if the handler made no case material write',async()=>{
  const f=await fixture({caseName:'Unwritten plan',persistCase:true});
  expect(f.record.error).toContain('not persisted');expect(f.finalize().blocked).toBe(true);
 });
 it.each(['已生成另一案件检索行动单。','已生成 D:/fixtures/extra.docx。','已生成授权协作检索行动单并发给客户。'])('does not expand a plan receipt to another target or effect: %s',async response=>{
  const f=await fixture();expect(f.finalize(response).blocked).toBe(true);
 });
 it.each(['不要生成法蝉检索计划。','请解释“生成法蝉检索计划”。','假设生成法蝉检索计划。','生成法蝉检索计划。查询工商登记。','生成法蝉检索计划，并查到该公司的裁判结果。','生成法蝉检索计划并发送给客户。'])('does not use a plan receipt to complete a different or mixed request: %s',async task=>{
  const f=await fixture();expect(hasCurrentLegalResearchPlanEvidence([f.record],{taskText:task,requestId:f.requestId,taskId:f.taskId},'已生成授权协作检索行动单。')).toBe(false);
  expect(f.finalize('已生成授权协作检索行动单。',task).blocked).toBe(true);
 });
 it.each([
  ['已生成授权协作检索行动单。已在法蝉查到裁判结果。',true],
  ['已生成授权协作检索行动单并已在法蝉查到裁判结果。',true],
  ['行动单中已在法蝉查到裁判结果。',true],
  ['已生成授权协作检索行动单，待律师登录法蝉查询。',false],
  ['已生成授权协作检索行动单。没有查询到法蝉结果。',false],
  ['原文写着“已在法蝉查到裁判结果”。',false],
  ['假设已经在法蝉查到裁判结果。',false],
 ])('keeps platform-result assertion local to its affirmative clause: %s',(text,expected)=>{
  expect(claimsExternalLegalPlatformResult(text)).toBe(expected);
 });
});
