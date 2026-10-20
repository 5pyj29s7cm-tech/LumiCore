import { prepareToolLoop } from '../server/llm/tool_loop/loop_setup';
import { formatDesktopControlPausePresentation } from '../server/regions/messages/desktop_control_messages';
import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
const playbackMock = vi.hoisted(() => vi.fn());
vi.mock('../server/agents/computer_use',()=>({computerUseLoop:playbackMock}));
vi.mock('../server/llm/providers', async original => ({...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model}));
import { initDatabase, closeDatabase, readDB, readDatabaseTables, commitDatabaseTables } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { recoverOrphanedConversationActionExecutions } from '../server/conversation/manager/recovery';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalCliTools } from '../server/tools/definitions/external_cli_tools';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { executeConfirmedToolStep } from '../server/tools/confirmed_step';
import { recordPendingConfirmationDurably } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import { saveStoredDesktopExecutionPreference } from '../server/cognition/operation_mode_store';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
beforeAll(()=>initDatabase());
beforeEach(()=>{model.mockReset();playbackMock.mockReset();vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('OUTSIDE_FIXTURE_NETWORK_FORBIDDEN'));});
function fixture(iterations: number, tail = ''){
 const userId='outside-terminal-'+randomUUID();
 const conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id;
 const requestId=randomUUID();
 const filePath=path.join(String(process.env.LUMI_DATA_DIR),'source-'+requestId+'.txt');
 const original='ISOLATED_SOURCE_CONTENT\nSOURCE_TAIL_86751';fs.writeFileSync(filePath,original);
 const text='Read the file '+filePath+' and show its complete contents.'+tail;
 const registry=new ToolRegistry();registerFileOpsTools(registry);
 const read=registry.get('read_file')!; const handler=vi.fn(read.handler);read.handler=handler; const chunks:string[]=[];
 const identity={userId,conversationId,requestId,agentId:'lumi',domain:'personal' as const,orgId:''};
 const input:any={entry:{source:'isolated-terminal-boundary',channel:'chat',historyLimit:10,failureText:'The request did not finish.',failureReason:'isolated'},identity,userText:text,authorization:captureRequestAuthorization(()=>true,'Revoked'),controller:new AbortController(),planning:{dispatch:{...identity,text,source:'isolated-terminal-boundary',channel:'chat',operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:iterations},executionBoundary:'trusted_local'},assemble:()=>({systemPrompt:'Use the actual source.',model:{registry,config:{provider:'deepseek',model:'isolated-no-network',userId,requestId},getters:{},maxIterations:iterations,onStreamChunk:(chunk:string)=>chunks.push(chunk),context:{authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:text,routedTaskText:text}}}),deliver:r=>r};
 return {input,identity,filePath,original,handler,chunks,readGoal:'Read the file '+filePath+' and show its complete contents.'};
}


describe('typed physical pause delivery state',()=>{
 it('keeps a successful pure source read pending when only the server pause was delivered',async()=>{
  const f=fixture(3);let paused=false;const base=f.input.assemble;f.input.assemble=()=>{const data=base();const relay:any=async()=>{throw Error('NO_DESKTOP');};relay.getControlPauseReason=()=>paused?'physical input':'';data.model.context.desktopRelay=relay;data.model.onToolCall=()=>{paused=true;};return data;};model.mockResolvedValueOnce({text:'',toolCalls:[{id:'pure-read-before-pause',name:'read_file',arguments:{path:f.filePath}}]});const r:any=await runLumiEntryTurn(f.input);expect(model).toHaveBeenCalledTimes(1);expect(f.handler).toHaveBeenCalledTimes(1);expect(r.toolRecords[0].envelope.status).toBe('verified_success');expect(r.toolRecords[0].result).toContain(f.original);expect(r.finalized.text).toBe(formatDesktopControlPausePresentation(f.input.userText).text);expect(r.finalized.text).not.toContain('SOURCE_TAIL_86751');expect(r.finalized.blocked).toBe(true);const row:any=readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId);expect(row.status).toBe('blocked');expect(JSON.parse(row.context).actionState.unfinished).toBe(true);
 });
 it.each(['waiting_confirmation','cancelled','failed'] as const)('preserves an explicit %s verdict instead of replacing it with a physical pause',reason=>{
  const f=fixture(1);const text=formatDesktopControlPausePresentation(f.input.userText).text;const verdict={text,blocked:true,reason};const relay:any=async()=>{throw Error('NO_DESKTOP');};relay.getControlPauseReason=()=> 'physical input';const prepared=prepareToolLoop([{role:'user',content:f.input.userText}],f.input.planning.registry,{provider:'deepseek',model:'isolated-no-network'},{},undefined,1,undefined,{desktopRelay:relay});const result=prepared.state!.finish(text,verdict);expect(result.completionGuard).toEqual(verdict);expect(result.toolCalls).toEqual([]);expect(model).not.toHaveBeenCalled();expect(f.handler).not.toHaveBeenCalled();
 });
 it('retains the typed pause when an explicit undefined verdict was supplied',()=>{
  const f=fixture(1);const presentation=formatDesktopControlPausePresentation(f.input.userText);const relay:any=async()=>{throw Error('NO_DESKTOP');};relay.getControlPauseReason=()=> 'physical input';const prepared=prepareToolLoop([{role:'user',content:f.input.userText}],f.input.planning.registry,{provider:'deepseek',model:'isolated-no-network'},{},undefined,1,undefined,{desktopRelay:relay});const result=prepared.state!.finish(presentation.text,undefined);expect(result.completionGuard).toEqual({...presentation,blocked:true});expect(result.toolCalls).toEqual([]);expect(model).not.toHaveBeenCalled();expect(f.handler).not.toHaveBeenCalled();
 });

});
