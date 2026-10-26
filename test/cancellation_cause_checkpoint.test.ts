import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCallStreaming: model }));
import { runWithTools } from '../server/llm/adapter';
import { ToolLoopModelBudgetError } from '../server/llm/tool_loop/model_budget';
import { ModelAttemptDeadlineError } from '../server/llm/provider/deadlines';
import { buildVerifiedToolCheckpoint } from '../server/llm/tool_loop/checkpoints';
import { modelRoutingErrorReason } from '../server/llm/model_routing_receipts';
import { formatCnToolFailureDetail } from '../server/regions/messages/voice_fast_path_messages';
import { chatPublicErrorCodeForException } from '../server/socket/chat_public_error';
import { sanitizeExecutionResponseForDelivery } from '../server/cognition/execution_guard_recovery';
import { ToolRegistry } from '../server/tools/registry';
import { encodeToolResult } from '../server/tools/result_envelope';
const getters = [() => null, () => null, () => null, () => null, () => null] as const;
beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('cancellation and deadline causes stay distinct', () => {
 it.each(['AbortError: This operation was aborted', 'The request was aborted'])('does not infer user input from an unqualified abort: %s', raw => {
  const text = formatCnToolFailureDetail(raw);
  expect(text).toContain('打断'); expect(text).not.toMatch(/新的输入|停止操作|被你|按你的要求/u);
 });
 it.each([
  () => new ToolLoopModelBudgetError(120000),
  () => new ModelAttemptDeadlineError('cancelled', 0, {cause: new ToolLoopModelBudgetError(120000)}),
  () => Object.assign(new Error('request was aborted', {cause: new ModelAttemptDeadlineError('absolute', 30000)}), {name:'AbortError'}),
 ])('keeps the underlying model deadline through cancellation wrappers', create => {
  const error = create(); expect(modelRoutingErrorReason(error)).toBe('timeout');
  expect(chatPublicErrorCodeForException(error)).toBe('CHAT_MODEL_TIMEOUT');
 });
 it('keeps actual caller cancellation and empty model output distinct from deadline', () => {
  expect(modelRoutingErrorReason(new ModelAttemptDeadlineError('cancelled',0,{cause:new DOMException('Stopped by user','AbortError')}))).toBe('cancelled');
  expect(modelRoutingErrorReason(new ModelAttemptDeadlineError('semantic_content',100,{completedEmpty:true}))).toBe('empty_response');
 });
 it('keeps the deadline category and verified draft at the public checkpoint', async () => {
  const registry = new ToolRegistry(); const body='The requested draft is available; later analysis is pending.';
  registry.register({name:'fixture_generated_work', description:'Return synthetic requested draft',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',capability:{operation:'create',sideEffects:[{type:'local_state_change',scope:'synthetic only',reversible:true}],verification:{required:true,strategy:'terminal_receipt',requiredFields:['ok','status','content'],requiredValues:{ok:true},successStatuses:['generated'],successSignals:['synthetic body'],limitations:[]}},handler:async()=>encodeToolResult(body,{ok:true,status:'generated',content:body})});
  const {executeToolCall}=await import('../server/tools/execution_engine');
  const context:any={authenticated:true,authRole:'admin',userId:'cause-fixture',domain:'personal',requestId:'cause-request',taskId:'cause-task',currentTurnExecutionRequested:true,actionIntent:'生成工作稿并作分析',localExecution:true};
  const row=await executeToolCall({registry,name:'fixture_generated_work',arguments:{},context}); expect(row.error).toBeUndefined();
  const result=buildVerifiedToolCheckpoint([row],context.actionIntent,context,new ToolLoopModelBudgetError(120000));
  expect(result).toMatchObject({blocked:true,reason:'model_wait_deadline'}); expect(result.text).toContain('模型');expect(result.text).toContain('超时');expect(result.text).toContain(body);expect(result.text).not.toMatch(/新的输入|停止操作/u);
  expect(sanitizeExecutionResponseForDelivery(result,{task:context.actionIntent,toolRecords:[row],requestId:context.requestId,taskId:context.taskId})).toMatchObject({blocked:true,reason:'model_wait_deadline'});
 });
 it('passes the model budget cause into the checkpoint after an actual completed observation', async () => {
  vi.useFakeTimers(); const registry=new ToolRegistry();const handler=vi.fn(async()=>encodeToolResult('Observed source only',{ok:true,status:'observed'}));
  registry.register({name:'fixture_observe',description:'Read synthetic state',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',capability:{operation:'observe',sideEffects:[{type:'local_read',scope:'synthetic only',reversible:true}],verification:{required:true,strategy:'terminal_receipt',requiredFields:['ok'],requiredValues:{ok:true},successSignals:['synthetic state'],limitations:[]}},handler});
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'observe',name:'fixture_observe',arguments:{}}]}).mockImplementationOnce(()=>new Promise(()=>{}));
  const pending=runWithTools([{role:'user',content:'请分析给定事实。'}],registry,{provider:'deepseek',model:'synthetic',modelWaitBudgetMs:40},()=>{},2,...getters,()=>{}, {authenticated:true,authRole:'admin',userId:'cause-fixture',requestId:'cause-loop',taskId:'cause-loop-task',actionIntent:'请分析给定事实。',localExecution:true});
  await vi.advanceTimersByTimeAsync(41);const result=await pending;
  expect(handler).toHaveBeenCalledOnce();expect(result.toolCalls).toHaveLength(1);expect(result.completionGuard).toMatchObject({blocked:true,reason:'model_wait_deadline'});expect(result.text).toContain('超时');expect(result.text).not.toContain('cancelled by the user');
 });
 it('keeps a real caller stop terminal instead of presenting a model timeout',async()=>{
  vi.useFakeTimers();const controller=new AbortController();model.mockImplementation(()=>new Promise(()=>{}));
  const pending=runWithTools([{role:'user',content:'Explain this fact.'}],new ToolRegistry(),{provider:'deepseek',model:'synthetic',signal:controller.signal,modelWaitBudgetMs:500},undefined,1,...getters,()=>{});
  await vi.advanceTimersByTimeAsync(1);controller.abort(new DOMException('User stopped current turn','AbortError'));const result=await pending;
  expect(result.text).toBe('Task was cancelled by the user.');expect(result.completionGuard?.reason).not.toBe('model_wait_deadline');
 });
});
