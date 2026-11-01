import './helpers';
import {beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {initDatabase,readDB} from '../db_layer';
import {addMessageIdempotent,getOrCreateActiveConversation,prepareConversationActionExecution} from '../server/conversation/manager';
import {createConversationReceiptObserver} from '../server/conversation/execution_receipt_archive';
import {ToolRegistry} from '../server/tools/registry';
import {executeToolCall} from '../server/tools/execution_engine';
import {encodeToolResult} from '../server/tools/result_envelope';
import {persistModelRoutingReceipt} from '../server/llm/model_routing_receipts';
import {buildActionEvidenceContract} from '../server/cognition/action_contract';
import {mergeTaskReceipts,recordsToTaskReceipts,taskCompletionFromReceipts,taskReceiptsToRecords} from '../server/cognition/task_execution_ledger';
import type {ToolExecutionRecord} from '../server/tools/types';
beforeAll(()=>initDatabase());
async function observed(name='web_search',payload?:unknown,options:{routeOwner?:string;noRoute?:boolean;mutation?:boolean}={}){
 const userId='observation-'+randomUUID(),conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id,requestId=randomUUID();
 const goal=name==='web_search'?'Search the public web for synthetic examples.':'通过企查查查询虚构测试公司的工商登记信息。';
 const userMessageId=addMessageIdempotent({userId,conversationId,requestId,source:'mcp_chat',domain:'personal',orgId:'',agentId:'lumi',role:'user',content:goal,deferActionPreparation:true});
 const prepared=prepareConversationActionExecution({userId,conversationId,requestId,userText:goal,userMessageId,forceTask:true,toolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:2}});
 if('bindingFailure'in prepared||!prepared.state?.taskId)throw Error('fixture owner missing');
 const scope={userId,conversationId,requestId,taskId:prepared.state.taskId,domain:'personal',orgId:''};
 const now=new Date().toISOString();
 const sourceText=JSON.stringify({name:'虚构测试公司',registration:'Synthetic fixture'});
 const response=payload ?? (name==='legal_company_database_lookup' ? {ok:true,status:'observed',persisted:false,sourceResults:[{
  status:'observed',subject:'虚构测试公司',queryType:'registration',sourceTool:'get_company_registration_info',sourceEndpoint:'https://agent.qcc.com/mcp/company/stream',
  queriedAt:now,sourceText,sourceTextSha256:createHash('sha256').update(sourceText).digest('hex'),
 }]} : {ok:true,results:[{title:'Synthetic source',url:'https://example.invalid/source'}]});
 const route=options.noRoute?undefined:persistModelRoutingReceipt({...scope,userId:options.routeOwner||userId,interactionId:'',source:'mcp_chat',status:'succeeded',startedAt:now,completedAt:now,durationMs:0,requestedProvider:'deepseek',requestedModel:'fixture',selectionMode:'pinned',selectedProvider:'deepseek',selectedModel:'fixture',fallbackReason:'',attempts:[{provider:'deepseek',model:'fixture',status:'succeeded'}]});
 const registry=new ToolRegistry();registry.register({name,description:'Isolated source fixture',permission:'public',securityLevel:'safe',parameters:{type:'object',properties:{query:{type:'string'},name:{type:'string'}}},capability:{operation:options.mutation?'mutate':'observe',sideEffects:options.mutation?[{type:'local_write',scope:'isolated fixture only',reversible:true}]:[],verification:{strategy:'terminal_receipt',required:true,requiredFields:[],successSignals:['source returned'],limitations:['Only this query is observed.']}},handler:async()=>name==='legal_company_database_lookup'?encodeToolResult(JSON.stringify(response),response):JSON.stringify(response)});
 const record=await executeToolCall({registry,id:'call-'+randomUUID(),name,arguments:{query:'synthetic',...(name==='legal_company_database_lookup'?{name:'虚构测试公司'}:{})},context:{...scope,turnId:requestId,turnRowId:prepared.turnRowId},executionOrigin:'model_selected',modelRoutingReceiptId:route?.id});
 if(!options.mutation)expect(record.error).toBeUndefined();await createConversationReceiptObserver({...scope,turnRowId:prepared.turnRowId},()=>true).onToolRecord(record);return{goal,scope,record,registry,complete:(records:ToolExecutionRecord[]=[record],changedScope=scope,changedGoal=goal)=>taskCompletionFromReceipts(changedGoal,recordsToTaskReceipts(records),undefined,changedScope).complete};
}
describe('durable completion of model selected read observations',()=>{
 it('accepts the exact previously persisted official company source without requiring a lost memory brand',()=>{
  const live=JSON.parse(fs.readFileSync(path.join(process.cwd(),'test/fixtures/read_observation_official_company_live_20261021.json'),'utf8'));
  const db=readDB();db.conversationActionTasks.push(live.task);db.conversationActionTurns.push(...live.turns);db.conversationActionReceipts.push(...live.receipts);db.interactions.push(...live.roots);db.modelRoutingReceipts.push(...live.routes);
  const state=JSON.parse(live.task.context).actionState;
  const scope={userId:live.task.userId,conversationId:live.task.conversationId,taskId:live.task.id,requestId:live.sourceRequestId,domain:live.task.domain,orgId:live.task.orgId};
  expect(state.receipts[0].modelRoutingReceiptId).toBeTruthy();
  expect(taskCompletionFromReceipts(live.task.goal,state.receipts,state.taskCapsule,scope).complete).toBe(true);
  expect(taskCompletionFromReceipts(live.task.goal,state.receipts,state.taskCapsule,{...scope,requestId:'other-request'}).complete).toBe(false);
 });
 it.each(['web_search','legal_company_database_lookup'])('completes %s only with a real source and model route',async name=>{const f=await observed(name);expect(f.complete()).toBe(true);});
 it('rejects empty results and success metadata alone',async()=>{const f=await observed('web_search',{ok:true,status:'observed',results:[],total:0});expect(f.complete()).toBe(false);expect(f.complete([])).toBe(false);});
 it('rejects an unbranded copied result and a forged success record',async()=>{const f=await observed();expect(f.complete([{...f.record,id:'unpersisted-call'}])).toBe(false);expect(f.complete([{...f.record}])).toBe(true);expect(f.complete([{name:'web_search',arguments:{},result:'success'}])).toBe(false);});
 it('rejects foreign owner, task, request and routing identity',async()=>{const f=await observed('web_search',undefined,{routeOwner:'other-owner'});expect(f.complete()).toBe(false);const g=await observed();expect(g.complete([g.record],{...g.scope,userId:'foreign'})).toBe(false);expect(g.complete([g.record],{...g.scope,requestId:randomUUID()})).toBe(false);expect(g.complete([g.record],{...g.scope,taskId:'foreign'})).toBe(false);});
 it('rejects a missing model routing receipt',async()=>{const f=await observed('web_search',undefined,{noRoute:true});expect(f.complete()).toBe(false);});
 it('does not promote a mutation or mixed write effect as read observation',async()=>{const f=await observed('web_search',{ok:true,results:['source']},{mutation:true});expect(f.complete()).toBe(false);});
 it('does not discharge an additional requested file production from a search receipt',async()=>{const f=await observed();const goal='Search the public web then create the PDF report D:/outputs/report.pdf.';expect(buildActionEvidenceContract(goal).applies).toBe(true);expect(f.complete([f.record],f.scope,goal)).toBe(false);});
 it('preserves real model provenance across persist, restore and merge with another result',async()=>{const f=await observed();const restored=JSON.parse(JSON.stringify(recordsToTaskReceipts([f.record])));const records=taskReceiptsToRecords(restored);expect(records[0].executionOrigin).toBe('model_selected');expect(records[0].modelRoutingReceiptId).toBe(f.record.modelRoutingReceiptId);const merged=mergeTaskReceipts(restored,[]);expect(taskCompletionFromReceipts(f.goal,merged,undefined,f.scope).complete).toBe(true);});
 it('uses the accepted current task goal after a lawful correction rather than the historic first question',async()=>{const f=await observed();const task=readDB().conversationActionTasks.find(x=>x.id===f.scope.taskId)!;const corrected='Search the public web for synthetic corrected examples.';task.goal=corrected;task.context=JSON.stringify({...JSON.parse(task.context),actionState:{...JSON.parse(task.context).actionState,goal:corrected,latestInstruction:corrected}});expect(f.complete([f.record],f.scope,corrected)).toBe(true);expect(f.complete()).toBe(false);});
});


describe('persisted observations from repeated provider IDs',()=>{
 async function nextBatch(f: Awaited<ReturnType<typeof observed>>) {
  const now=new Date().toISOString();
  const route=persistModelRoutingReceipt({...f.scope,interactionId:'',source:'mcp_chat',status:'succeeded',startedAt:now,completedAt:now,durationMs:0,requestedProvider:'deepseek',requestedModel:'fixture',selectionMode:'pinned',selectedProvider:'deepseek',selectedModel:'fixture',fallbackReason:'',attempts:[{provider:'deepseek',model:'fixture',status:'succeeded'}]});
  const record=await executeToolCall({registry:f.registry,id:f.record.id,name:f.record.name,arguments:{...f.record.arguments},context:{...f.scope,turnId:f.record.turnId,turnRowId:f.record.turnRowId},executionOrigin:'model_selected',modelRoutingReceiptId:route.id});
  await createConversationReceiptObserver({...f.scope,turnRowId:f.record.turnRowId},()=>true).onToolRecord(record);
  return record;
 }
 it('matches the second real row by its bound batch/key when the provider ID collides',async()=>{
  const payload={ok:true,results:[{title:'First source version',url:'https://authority.invalid/first'}]};
  const f=await observed('web_search',payload);
  payload.results[0]={title:'Second source version',url:'https://authority.invalid/second'};
  const second=await nextBatch(f);
  expect(second.error).toBeUndefined();expect(second.id).toBe(f.record.id);
  expect(second.modelRoutingReceiptId).not.toBe(f.record.modelRoutingReceiptId);
  expect(second.idempotencyKey).not.toBe(f.record.idempotencyKey);
  const rows=readDB().conversationActionReceipts.filter(row=>row.taskId===f.scope.taskId);
  expect(rows).toHaveLength(2);expect(new Set(rows.map(row=>row.id)).size).toBe(2);
  expect(rows.find(row=>row.modelRoutingReceiptId===second.modelRoutingReceiptId)?.id).not.toBe(second.id);
  expect(f.complete([f.record,second])).toBe(true);
  expect(f.complete([second])).toBe(true);
  expect(second.result).toContain('Second source version');
 });
 it('keeps exact provider ID, request, task, route and input hash fences after a row-ID collision',async()=>{
  const f=await observed();const second=await nextBatch(f);
  expect(f.complete([second])).toBe(true);
  for(const forged of [
   {...second,id:'unpersisted-call'},
   {...second,requestId:'another-request'},
   {...second,taskId:'another-task'},
   {...second,modelRoutingReceiptId:f.record.modelRoutingReceiptId},
   {...second,idempotencyKey:f.record.idempotencyKey},
   {...second,arguments:{query:'different original input'}},
  ])expect(f.complete([forged])).toBe(false);
 });
});
