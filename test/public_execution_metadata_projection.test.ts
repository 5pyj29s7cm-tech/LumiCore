import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import fixture from './fixtures/public_official_company_annotations_20261021.json';
import { initDatabase, readDatabaseTables, commitDatabaseTables } from '../db_layer';
import { projectConversationMessageForCustomer } from '../server/routes/conversations';
import { sanitizeUserFacingExecutionOutput } from '../server/cognition/user_output_protection';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { projectExecutionReferenceText } from '../shared/public_execution_language';
import { capabilityContract } from '../server/tools/capability_contracts';

const machine = /status=observed|get_company_registration_info|agent\.qcc\.com\/mcp\/company\/stream|persisted=false|changedCaseIds|confirmedForKb|已核验终端回执/u;
const fields = ['| 企业名称 | 企查查科技股份有限公司 |', '| 登记状态 | 在业 |', '| 成立日期 | 2014-03-12 |', '| 注册资本 | 36225万元（实缴资本 36225万元） |'];
function expectBusiness(text: string) {
  for (const field of fields) expect(text).toContain(field);
  expect(text).toContain('企查查官方 MCP');
  expect(text).toContain('2026-10-20T23:24:13.287Z');
  expect(text).toContain('未入案');
  expect(text).toContain('未导入知识库');
  expect(text).toContain('而非律师复核后的法律认定');
  expect(text).not.toMatch(machine);
  expect(text).not.toMatch(/没有完成|没有拿到|重试|(?:调用工具|端点)[:：]\s*(?:\n|$)/u);
}
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
 const db = readDatabaseTables(['conversationActionTasks', 'conversationActionTurns', 'conversationActionReceipts', 'interactions']);
 db.conversationActionTasks = structuredClone(fixture.tasks) as typeof db.conversationActionTasks;
 db.conversationActionTurns = structuredClone(fixture.turns) as typeof db.conversationActionTurns;
 db.conversationActionReceipts = structuredClone(fixture.receipts) as typeof db.conversationActionReceipts;
 db.interactions = structuredClone(fixture.interactions) as typeof db.interactions;
 commitDatabaseTables(db);
});
async function canonicalRecord() {
 const registry = new ToolRegistry();
 registry.register({name:'fixture_metadata_query',description:'Saved official query fixture, no network',permission:'user',securityLevel:'safe',
  parameters:{type:'object',properties:{}},capability:capabilityContract({id:'test.metadata-query',family:'test',lane:'web',operation:'observe',risk:'low',
   sideEffects:[{type:'network_read',scope:'saved fixture only',reversible:true}],verification:{strategy:'terminal_receipt',required:true,requiredFields:['ok','status'],successStatuses:['observed'],successSignals:[],limitations:[]}}),
  handler:async()=>JSON.stringify(fixture.record.receipt)});
 const record=await executeToolCall({registry,id:'fixture-canonical-metadata',name:'fixture_metadata_query',arguments:fixture.record.arguments,
  context:{userId:fixture.tasks[0].userId,conversationId:fixture.tasks[0].conversationId,domain:'personal',orgId:'',requestId:fixture.record.requestId,taskId:fixture.record.taskId,
   authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:fixture.question,routedTaskText:fixture.question}});
 expect(isCanonicalToolExecutionRecord(record)).toBe(true);expect(record.terminalVerification?.status).toBe('verified');
 return record;
}
it('projects only saved actual machine annotations at the live verified-result boundary',async()=>{
 const record=await canonicalRecord();
 const text=sanitizeUserFacingExecutionOutput(fixture.answer,{task:fixture.question,taskId:record.taskId,requestId:record.requestId,toolRecords:[record]});
 expectBusiness(text);
});
it('projects the saved actual history from SQL verified evidence without changing the stored answer or receipt',()=>{
 const db=readDatabaseTables(['interactions','conversationActionReceipts']);
 const original=db.interactions.find(row=>row.role==='assistant')!;
 const stored=JSON.stringify(db);
 const projected=projectConversationMessageForCustomer(original);
 expectBusiness(projected.message);expect(projected.blocked).not.toBe(true);
 fs.writeFileSync(path.join(String(process.env.LUMI_TEST_TMPDIR || process.env.LUMI_DATA_DIR),'actual-qcc-public-projection.txt'),projected.message);
 expect(JSON.stringify(readDatabaseTables(['interactions','conversationActionReceipts']))).toBe(stored);
 expect(original.message).toBe(fixture.answer);
});
it('preserves explicit technical questions and their exact answer fields',async()=>{
 const record=await canonicalRecord();
 const question='Explain status=observed, get_company_registration_info, https://agent.qcc.com/mcp/company/stream, persisted=false, changedCaseIds, confirmedForKb, registration and 已核验终端回执.';
 expect(sanitizeUserFacingExecutionOutput(fixture.answer,{task:question,taskId:record.taskId,requestId:record.requestId,toolRecords:[record]})).toBe(fixture.answer);
 const db=readDatabaseTables(['interactions']);
 const original=db.interactions.find(row=>row.role==='user')!;original.message=question;commitDatabaseTables(db);
 const reply=db.interactions.find(row=>row.role==='assistant')!;
 expect(projectConversationMessageForCustomer(reply).message).toBe(fixture.answer);
});
it('does not infer machine annotation authority from unverified or foreign current records',async()=>{
 const record=await canonicalRecord();
 for(const records of [[],[structuredClone(record)],[record]]) {
  const output=sanitizeUserFacingExecutionOutput(fixture.answer,{task:fixture.question,requestId:'foreign-request',taskId:record.taskId,toolRecords:records});
  expect(output).toBe(fixture.answer);
 }
 const failed='本次查询返回401，未取得企业登记信息。不能据此判断该企业不存在。';
 expect(sanitizeUserFacingExecutionOutput(failed,{task:fixture.question,toolRecords:[record],taskId:record.taskId,requestId:record.requestId})).toBe(failed);
});

it('preserves exact original source blocks containing identical metadata names and removes only an appended annotation',()=>{
 const source='Original evidence: `status=observed`, `persisted=false`, `changedCaseIds`, `confirmedForKb`, `get_company_registration_info` and https://agent.qcc.com/mcp/company/stream. TAIL';
 const suffix='\n- 调用工具：`get_company_registration_info`\n- 端点：`https://agent.qcc.com/mcp/company/stream`\n企业名称仍为企查查科技股份有限公司（`status=observed`）。';
 const text=projectExecutionReferenceText(source+suffix,[],[source],['status=observed','persisted=false','changedCaseIds','confirmedForKb','get_company_registration_info','https://agent.qcc.com/mcp/company/stream']);
 expect(text.startsWith(source)).toBe(true);expect(text.slice(source.length)).not.toMatch(machine);
 expect(text).toContain('企业名称仍为企查查科技股份有限公司。');
});

it('keeps an exact real source URL and every business table byte beside an inline status annotation',async()=>{
 const record=await canonicalRecord();
 const table=fixture.answer.slice(fixture.answer.indexOf('| 项目 |'),fixture.answer.indexOf('\n\n**来源'));
 const answer=fixture.answer+'\n公开来源：https://www.qcc.com/';
 const text=sanitizeUserFacingExecutionOutput(answer,{task:fixture.question,taskId:record.taskId,requestId:record.requestId,toolRecords:[record]});
 expect(text).toContain(table);expect(text).toContain('https://www.qcc.com/');expectBusiness(text);
});
it('does not use a raw assistant-payload receipt to mint a history projection exception',()=>{
 const db=readDatabaseTables(['conversationActionReceipts','interactions']);db.conversationActionReceipts=[];commitDatabaseTables(db);
 const reply=db.interactions.find(row=>row.role==='assistant')!;
 expect(projectConversationMessageForCustomer(reply).message).toBe(fixture.answer);
});
