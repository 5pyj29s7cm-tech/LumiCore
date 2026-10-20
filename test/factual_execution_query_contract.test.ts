import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initDatabase, flushDBOrThrow, readDB } from '../db_layer';
import { getOrCreateActiveConversation, addMessageIdempotent } from '../server/conversation/manager';
import { preparePlannedConversationExecution } from '../server/conversation/planned_execution';
import { isConversationExecutionFactQuestion as legacyFactQuestion, getConversationExecutionFacts, formatConversationExecutionFactAnswer } from '../server/conversation/execution_facts';
import { isConversationExecutionFactQuestion, hasMixedStatusExecutionIntent } from '../server/cognition/normalized_action_intent';
import { hasExplicitNoToolInstruction as toolIntentNoTools } from '../server/cognition/tool_intent';
import { hasExplicitNoToolInstruction as pureNoTools } from '../server/cognition/no_tool_instruction';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildActionContract } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
const question='这轮对话里你有没有真的执行工具或创建任务？只按事实回答。';
const denial='没有。这轮对话我没有调用任何工具，也没有创建任务，只是文字交流。';
beforeAll(()=>initDatabase());
afterEach(()=>vi.restoreAllMocks());
function pipeline(text: string, channel: 'chat'|'voice'='chat', identity={userId:'factual-query-user',requestId:'factual-query-request'}) {
 const registry=new ToolRegistry();registerAllTools(registry);
 return buildLumiExecutionPipeline({requestId:identity.requestId,userText:text,dispatch:{userId:identity.userId,channel,source:channel,text,operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:10}});
}
describe('one factual execution query contract from admission to finalization',()=>{
 it('keeps the old execution-facts API as the same pure predicate',()=>{expect(legacyFactQuestion).toBe(isConversationExecutionFactQuestion);expect(legacyFactQuestion(question)).toBe(true);});
 it.each(['chat','voice'] as const)('does not turn the factual %s query into artifact creation with or without complete flow',channel=>{
  const execution=pipeline(question,channel);
  expect(execution.normalizedIntent).toMatchObject({kind:'status_query',operation:'status',target:'previous_action',sideEffectClass:'none'});
  expect(execution.turnIntent.boundary).toBe('conversation');
  expect(execution.turnIntent.flow.allowToolUseForTurn).toBe(false);
  expect(execution.turnIntent.flow.completionEvidenceNeeded).toBe(false);
  expect(execution.executionRequested).toBe(false);
  expect(execution.capabilityPlan.taskLedgerRequired).toBe(false);
  expect(buildActionContract(question).applies).toBe(false);
  const input={taskText:question,responseText:denial,toolRecords:[],source:channel};
  expect(finalizeLumiResponse(input)).toMatchObject({blocked:false,text:denial});
  expect(finalizeLumiResponse({...input,flow:execution.turnIntent.flow})).toMatchObject({blocked:false,text:denial});
 });
 it('reads only this accepted conversation facts without creating an action task',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('FACT_QUERY_MUST_NOT_EXECUTE_NETWORK'));
  const userId='factual-'+randomUUID(),requestId='request-'+randomUUID();
  const conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id;
  const userMessageId=addMessageIdempotent({userId,conversationId,requestId,agentId:'lumi',role:'user',content:question,domain:'personal',orgId:'',source:'chat',channel:'chat',deferActionPreparation:true});
  await flushDBOrThrow();
  const execution=pipeline(question,'chat',{userId,requestId});
  const prepared=preparePlannedConversationExecution({execution,conversationId,userId,requestId,userMessageId,userText:question,bindConversationTurn:true});
  expect(prepared.kind).toBe('conversation');expect(prepared.state).toBeNull();
  const facts=getConversationExecutionFacts({conversationId,userId,domain:'personal',orgId:'',currentRequestId:requestId});
  expect(facts.toolCalls).toEqual([]);expect(facts.tasks).toEqual([]);
  const answer=formatConversationExecutionFactAnswer(facts,question);
  const final=finalizeLumiResponse({taskText:question,responseText:answer,toolRecords:[],source:'chat',flow:execution.turnIntent.flow,requestId});
  expect(final).toMatchObject({blocked:false,text:answer});
  expect(final.text).toMatch(/没有.*工具.*没有.*任务/u);
  expect(readDB().interactions.find((row:any)=>row.id===userMessageId)?.message).toBe(question);
  expect(readDB().conversationActionTasks.some((row:any)=>row.conversationId===conversationId)).toBe(false);
  expect(network).not.toHaveBeenCalled();
 });
 it.each([
  question+'现在新建文本文件 D:/synthetic-factual-mixed.txt，只写入“测试”。',
  'Did you execute any tools or create tasks in this conversation? Then create the file D:/synthetic-factual-mixed.txt with the content: test.',
 ])('keeps the independent real action in a mixed query: %s',text=>{
  expect(isConversationExecutionFactQuestion(text)).toBe(false);
  const execution=pipeline(text);
  expect(execution.normalizedIntent.kind).not.toBe('status_query');
  expect(execution.executionRequested).toBe(true);
  expect(execution.turnIntent.flow.allowToolUseForTurn).toBe(true);
  expect(buildActionContract(text).kind).toBe('artifact_work');
  expect(finalizeLumiResponse({taskText:text,responseText:'',toolRecords:[],source:'chat',flow:execution.turnIntent.flow}).blocked).toBe(true);
 });
});


describe('existing factual scopes and explicit mixed actions share one normalization boundary',()=>{
 it.each([
  '你刚才实际完成了什么？原文件改过吗？只根据这次已经保存的操作记录告诉我，不要再执行操作。',
  question+'不要再执行操作。',
  'Did you execute any tools or create tasks in this conversation? Only answer from existing records; do not execute a new action.',
 ])('retains a pure factual query without treating its no-execution clause as action: %s',text=>{
  expect(isConversationExecutionFactQuestion(text)).toBe(true);
  const execution=pipeline(text);
  expect(execution.normalizedIntent).toMatchObject({kind:'status_query',sideEffectClass:'none'});
  expect(execution.turnIntent.flow.allowToolUseForTurn).toBe(false);
  expect(execution.executionRequested).toBe(false);
  expect(execution.capabilityPlan.taskLedgerRequired).toBe(false);
 });
 it.each([
  [question+'现在打开聊天界面。','client_navigation'],
  ['Did you execute any tools or create tasks in this conversation? Then open Chat.','client_navigation'],
  [question+'现在打开 Windows 计算器。','desktop_operation'],
 ] as const)('does not let the factual sidecar consume a concrete non-artifact action: %s',(text,kind)=>{
  expect(isConversationExecutionFactQuestion(text)).toBe(false);
  const execution=pipeline(text);
  expect(execution.normalizedIntent.kind).toBe(kind);
  expect(execution.executionRequested).toBe(true);
 });
});


describe('the original no-tool veto is shared without weakening positive continuation',()=>{
 it('preserves the existing API identity and double-negation exception',()=>{
  expect(toolIntentNoTools).toBe(pureNoTools);
  expect(pureNoTools('不要再执行操作。')).toBe(true);
  expect(pureNoTools('并不是不要使用工具。')).toBe(false);
 });
 it.each(['任务完成了吗再执行','任务没完成就再执行'])('retains an affirmative continuation without turning it into factual history: %s',text=>{
  expect(pureNoTools(text)).toBe(false);
  expect(hasMixedStatusExecutionIntent(text)).toBe(true);
  const execution=pipeline(text);
  expect(execution.normalizedIntent.kind).not.toBe('status_query');
  expect(execution.executionRequested).toBe(true);
  expect(isConversationExecutionFactQuestion(text)).toBe(false);
 });
});
