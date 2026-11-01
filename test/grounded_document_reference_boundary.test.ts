import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { inspectPublicExecutionReferences } from '../server/cognition/user_output_protection';

async function readFixture(literal: 'none' | 'source' | 'request' = 'none', long = false) {
 const identities={id:'private-read-'+randomUUID(),requestId:'private-request-'+randomUUID(),taskId:'private-task-'+randomUUID()};
 const file=path.join(String(process.env.LUMI_DATA_DIR),'reference-'+randomUUID()+'.txt');
 const body='Original requested source.\n'+(long?'Source paragraph. '.repeat(3500):'Source detail.')+'\nSOURCE_TAIL'+(literal==='source'?'\nLiteral source identifier: '+identities.id:'');
 fs.writeFileSync(file,body);
 const task='Read the file "'+file+'" and return its full contents.'+(literal==='request'?' Reference supplied by user: '+identities.id:'');
 const registry=new ToolRegistry();registerFileOpsTools(registry);
 const record=await executeToolCall({registry,id:identities.id,name:'read_file',arguments:{path:file},context:{userId:'reference-test',...identities,authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:task,routedTaskText:task}});
 expect(isCanonicalToolExecutionRecord(record)).toBe(true);expect(record.envelope?.status).toBe('verified_success');
 const input={taskText:task,responseText:body,toolRecords:[record],source:'chat',requestId:identities.requestId,taskId:identities.taskId};
 return {identities,body,record,input};
}

describe('grounded document results preserve source while fencing private references',()=>{
 it.each(['id','requestId','taskId'] as const)('removes an appended private %s from an otherwise verified read',async key=>{
  const f=await readFixture('none',key==='id');const value=f.identities[key];const answer=f.body+'\nExecution reference: '+value;
  const proof=inspectPublicExecutionReferences({task:f.input.taskText,toolCalls:[f.record],requestId:f.input.requestId,taskId:f.input.taskId},answer);
  expect(proof.privateReferences).toContain(value);
  const result=finalizeLumiResponse({...f.input,responseText:answer});
  expect(result.blocked).toBe(true);expect(result.text).not.toContain(value);expect(result.text).toBe(f.body);
 });
 it('keeps the complete final source line beside an inline private annotation',async()=>{
  const f=await readFixture();const result=finalizeLumiResponse({...f.input,responseText:f.body+'; execution reference: '+f.identities.id});
  expect(result.blocked).toBe(true);expect(result.text).toBe(f.body);expect(result.text).not.toContain(f.identities.id);
 });
 it.each(['source','request'] as const)('preserves the identical identifier when already supplied in the %s',async literal=>{
  const f=await readFixture(literal);const answer=literal==='source'?f.body:f.body+'\nUser reference: '+f.identities.id;
  const result=finalizeLumiResponse({...f.input,responseText:answer});
  expect(result.blocked).toBe(false);expect(result.text).toBe(answer);expect(result.text).toContain(f.identities.id);
 });
 it.each(['requestId','taskId'] as const)('cannot use a foreign %s to grant a grounded source exception',async key=>{
  const f=await readFixture('source');const input={...f.input,[key]:'foreign-scope'};
  expect(inspectPublicExecutionReferences({task:input.taskText,toolCalls:[f.record],requestId:input.requestId,taskId:input.taskId},f.body).currentRecords).toHaveLength(0);
  expect(finalizeLumiResponse(input).blocked).toBe(true);
 });
});
