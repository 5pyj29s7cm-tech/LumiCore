import './helpers';
import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { encodeToolResult } from '../server/tools/result_envelope';
import { external_researchTools } from '../server/regions/packs/cn/legal_tools/definitions_external_research';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { claimsExternalLegalPlatformResult, hasVerifiedCompanyLookupEvidence } from '../server/cognition/result_policy_evidence';
import { buildActionContract } from '../server/cognition/action_contract';

const subject='虚构来源边界样本有限公司';
const task=`通过企查查查询“${subject}”的工商登记信息。`;
const answer='已查询到工商登记信息。\n企业名称：'+subject+'；登记状态：存续。';
const scope={requestId:'company-claim-request',taskId:'company-claim-task'};
const finalize=(text=answer,records:Awaited<ReturnType<typeof sourceFixture>>['record'][]=[],goal=task,current=scope)=>
 finalizeLumiResponse({taskText:goal,responseText:text,toolRecords:records,source:'chat',...current});

async function sourceFixture(status='observed',name=subject) {
 const body='企业名称：'+name+'；登记状态：存续。';
 // Real canonical executor/definition metadata, wholly synthetic source handler.
 // This proves receipt interpretation, not any platform call or business query.
 const handler=vi.fn(async()=>encodeToolResult(body,{ok:status==='observed',status,persisted:false,changedCaseIds:[],sourceResults:[{
  status,subject:name,queryType:'registration',sourceTool:'get_company_registration_info',
  sourceEndpoint:'https://agent.qcc.com/mcp/company/stream',queriedAt:'2026-11-01T00:00:00Z',
  sourceTextSha256:createHash('sha256').update(body).digest('hex'),
 }]}));
 const registry=new ToolRegistry();
 registry.register({...external_researchTools().find(tool=>tool.name==='legal_company_database_lookup')!,handler});
 const record=await executeToolCall({registry,id:'company-claim-'+randomUUID(),name:'legal_company_database_lookup',
  arguments:{name,queryType:'registration',sourceIds:['qichacha'],persistCase:false},
  context:{userId:'company-claim-fixture',...scope,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local'}});
 expect(handler).toHaveBeenCalledTimes(1);expect(isCanonicalToolExecutionRecord(record)).toBe(true);
 return {record,handler};
}

describe('company result claims require the requested current source',()=>{
 it.each([task,'通过企查查查询该公司的工商登记信息。'])('blocks absent evidence even without repeating the company in the claim: %s',goal=>{
  expect(buildActionContract(goal).kind).toBe('none');
  expect(claimsExternalLegalPlatformResult(answer,goal)).toBe(true);
  expect(finalize(answer,[],goal).blocked).toBe(true);
 });
 it.each(['工商登记','股东','实控人','风险','被执行','失信','限高'])('reuses the supported query range for %s',range=>{
  const goal=`通过企查查查询该公司的${range}信息。`;
  expect(claimsExternalLegalPlatformResult(`已查询到${range}信息。`,goal)).toBe(true);
 });
 it.each([
  '尚未查询到工商登记信息。','没有查询到工商登记信息。','本轮未查询到工商登记信息。',
  '原文写着“已查询到工商登记信息”。','```text\n已查询到工商登记信息。\n```',
  '假设已查询到工商登记信息。','如果已查询到工商登记信息，需要核对主体。',
  '请查询工商登记信息。','工商登记信息是企业登记机关记录的事项。',
 ])('does not turn supplied or uncompleted prose into a query receipt: %s',text=>{
  expect(claimsExternalLegalPlatformResult(text,task)).toBe(false);
 });
 it('does not use an unrelated requested range or an information-only request to widen the new clause rule',()=>{
  expect(claimsExternalLegalPlatformResult('已查询到股东信息。',task)).toBe(false);
  expect(claimsExternalLegalPlatformResult('已查询到工商登记信息。','解释这句话。')).toBe(false);
 });
 it('retains a completed claim after a separate negative or quoted clause',()=>{
  for(const prefix of ['没有查询到股东信息。','原文写着“尚未查询到工商登记信息”。'])
   expect(finalize(prefix+answer).blocked).toBe(true);
 });
 it('allows the exact current canonical source and preserves the returned fields',async()=>{
  const {record}=await sourceFixture();
  expect(hasVerifiedCompanyLookupEvidence([record],{...scope,taskText:task})).toBe(true);
  const result=finalize(answer,[record]);expect(result.blocked).toBe(false);expect(result.text).toContain(subject);expect(result.text).toContain('存续');
 });
 it('does not infer a company for a pronoun-only request from an arbitrary receipt',async()=>{
  const {record}=await sourceFixture();expect(finalize(answer,[record],'通过企查查查询该公司的工商登记信息。').blocked).toBe(true);
 });
 it.each(['request','task','subject','clone','partial'] as const)('rejects %s scope or receipt substitution',async kind=>{
  const {record}=await sourceFixture(kind==='partial'?'partial':'observed',kind==='subject'?'另一虚构企业有限公司':subject);
  const records=kind==='clone'?[{...record}]:[record];
  const current={...scope,...(kind==='request'?{requestId:'another-request'}:kind==='task'?{taskId:'another-task'}:{})};
  expect(finalize(answer,records,task,current).blocked).toBe(true);
 });
});
