import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/providers', async original => ({ ...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model }));
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { buildActionEvidenceContract, buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { requestedArtifactInstructions } from '../server/cognition/artifact_progress';
import { requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';
import { tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { requiresArtifactPostWriteReadback } from '../server/cognition/action_request';
import { hasClientActionIntent, hasClientActionOnlyIntent, shouldAllowToolUseForTurn } from '../server/cognition/tool_intent';
beforeAll(async () => { await initDatabase(); });
const sourceRead = 'Read the file "D:/source.txt" and show its complete contents.';
const firstWrite = 'Then create the file "D:/first.txt" containing "FIRST" and read it back.';
const secondWrite = 'Then create the file "D:/second.txt" containing "SECOND" and read it back.';
it.each([sourceRead+' '+firstWrite+' '+secondWrite,firstWrite+' '+sourceRead+' '+secondWrite,firstWrite+' '+secondWrite+' '+sourceRead])('preserves a required source read wherever it occurs', text => {
  const contract = buildActionEvidenceContract(text);
  expect(contract.components).toHaveLength(3);
  expect(contract.components!.filter(item => item.text.includes('show its complete contents'))).toHaveLength(1);
  expect(requestedArtifactInstructions(text).map(item => item.path)).toEqual(['D:/first.txt','D:/second.txt']);
});
it.each(['Read the available source and show its complete contents.', '读取已有资料。', '读取附件。'])('keeps the required unresolved source %s incomplete', source => {
  const text = source+' '+firstWrite;
  const contract = buildActionEvidenceContract(text);
  expect(contract.components).toHaveLength(2);
  expect(hasCoreActionEvidence(contract, [], text)).toBe(false);
});
it('does not promote an output readback, quoted payload or optional exploration to another source', () => {
  expect(buildActionEvidenceContract(firstWrite+' Read the file "D:/first.txt".').components).toBeUndefined();
  expect(buildActionEvidenceContract('If needed, inspect the available source. '+firstWrite).components).toBeUndefined();
  expect(buildActionEvidenceContract('Create the file "D:/first.txt" containing "Read the available source.".').components).toBeUndefined();
  expect(requestsExactReadOnlyArtifactInspection('What is the source of happiness?')).toBe(false);
});
it.each(['D:/lumiOS-variants/lumi-legal-client/source.txt','C:/Users/Owner/Documents/client health/show settings.txt'])('keeps location %s as an operand', source => {
  const text = `Read the file "${source}" and show its complete contents. ${firstWrite}`;
  expect(hasClientActionIntent(text)).toBe(false); expect(hasClientActionOnlyIntent(text)).toBe(false);
  expect(buildActionContract(text).kind).toBe('artifact_work');
});
it.each(['打开Lumi设置','查看客户端健康状态'])('keeps real client control available: %s', text => { expect(shouldAllowToolUseForTurn(text, 'chat', 'assistant')).toBe(true); if (text === '打开Lumi设置') expect(hasClientActionIntent(text)).toBe(true); });
it('recognizes and-read-it-back across long path operands but not quoted document content', () => {
  expect(requiresArtifactPostWriteReadback('Create the file "D:/'+'long-folder/'.repeat(40)+'report.txt" containing "DONE" and read it back.')).toBe(true);
  expect(requiresArtifactPostWriteReadback('Create the file "D:/report.txt" containing "and read it back".')).toBe(false);
});
it('naturally continues missing per-output readback and completes only after source and both outputs are verified', async () => {
  const userId='compound-readback-'+randomUUID(),requestId=randomUUID(),conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id;
  const identity={userId,conversationId,requestId,agentId:'lumi',domain:'personal' as const,orgId:''};
  const source=path.join(String(process.env.LUMI_DATA_DIR),'source.txt'),first=path.join(String(process.env.LUMI_DATA_DIR),'first.txt'),second=path.join(String(process.env.LUMI_DATA_DIR),'second.txt');
  fs.writeFileSync(source,'SOURCE_FULL_BODY\nSOURCE_TAIL_SENTINEL');
  const text=`Read the file "${source}" and show its complete contents. Then create the file "${first}" containing "FIRST_DONE" and read it back. Then create the file "${second}" containing "SECOND_DONE" and read it back.`;
  const registry=new ToolRegistry();registerFileOpsTools(registry);let round=0;
  model.mockReset();model.mockImplementation(async()=>{
    if(++round===1)return{text:'',toolCalls:[{id:'source-read',name:'read_file',arguments:{path:source}},{id:'first-write',name:'write_file',arguments:{path:first,content:'FIRST_DONE'}},{id:'second-write',name:'write_file',arguments:{path:second,content:'SECOND_DONE'}},{id:'second-readback',name:'read_file',arguments:{path:second}}]};
    if(round===2){const rows=readDB().conversationActionReceipts.filter((row:any)=>row.requestId===requestId);expect(rows.filter((row:any)=>row.toolName==='write_file'&&row.outcome==='verified_success')).toHaveLength(2);expect(rows.some((row:any)=>row.toolName==='read_file'&&row.targetIdentity===first)).toBe(false);return{text:'',toolCalls:[{id:'first-readback',name:'read_file',arguments:{path:first}}]};}
    return{text:'SOURCE_FULL_BODY\nSOURCE_TAIL_SENTINEL\nFIRST_DONE\nSECOND_DONE',toolCalls:[]};
  });
  const result:any=await runLumiEntryTurn({entry:{source:'chat',channel:'chat',historyLimit:10,failureText:'Not complete.',failureReason:'fixture'},identity,userText:text,authorization:captureRequestAuthorization(()=>true,'Revoked'),controller:new AbortController(),
    planning:{dispatch:{...identity,text,source:'chat',channel:'chat',operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:4},executionBoundary:'trusted_local'},
    assemble:()=>({systemPrompt:'Offline compound receipt fixture.',model:{registry,config:{provider:'deepseek',model:'offline-fixture',userId,requestId},getters:{},maxIterations:4,context:{authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:text,routedTaskText:text,allowLocalFileWrites:true,requestConfirmation:async()=>true}}}),deliver:value=>value}as any);
  expect(model.mock.calls.length).toBeGreaterThanOrEqual(2);expect(model.mock.calls.length).toBeLessThanOrEqual(3);expect(result.toolRecords.map((record:any)=>record.id)).toEqual(['source-read','first-write','second-write','second-readback','first-readback']);
  expect(result.toolRecords.every((record:any)=>record.envelope?.status==='verified_success')).toBe(true);expect(result.finalized.blocked).toBe(false);expect(result.finalized.text).toContain('SOURCE_TAIL_SENTINEL');
  expect(result.finalized.fileArtifacts.map((file:any)=>file.path).sort()).toEqual([first,second].sort());
  expect(readDB().conversationActionTasks.find((task:any)=>task.id===result.taskId)?.status).toBe('completed');
  const contract=buildActionEvidenceContract(text),turn={requestId,taskId:result.taskId};expect(hasCoreActionEvidence(contract,result.toolRecords,text,undefined,turn)).toBe(true);
  for(const missing of ['source-read','first-readback','second-readback']) { const partial=result.toolRecords.filter((record:any)=>record.id!==missing);expect(hasCoreActionEvidence(contract,partial,text,undefined,turn)).toBe(false);expect(tryFinalizeVerifiedBoundedAction({ ...turn, taskText:text, responseText:'', toolRecords:partial, source:'chat' })).toBeNull(); }
  expect(fs.readFileSync(first,'utf8')).toBe('FIRST_DONE');expect(fs.readFileSync(second,'utf8')).toBe('SECOND_DONE');
});

it('preserves the exact prepared Chinese live request with one source and two per-output readbacks', () => {
  const text = "先完整读取明确指定的源文件 <RUN_DIR>/files/source-<RUN_ID>.txt，并逐字展示其完整原文。请创建本次验收专用文件 <RUN_DIR>/files/甲-<RUN_ID>.txt，原样写入“[虚构验收甲-<RUN_ID>]\n物品：蓝色纸盒\n数量：3\n仅为程序验收，不构成任何真实业务。\n甲文件到此结束。”。写完后回读并检查甲文件。然后创建另一份独立文件 <RUN_DIR>/files/乙-<RUN_ID>.txt，原样写入“[虚构验收乙-<RUN_ID>]\n物品：橙色书签\n数量：7\n这是与甲文件独立的第二份验收内容。\n乙文件到此结束。”。写完后回读并检查乙文件。最后逐份完整展示读取到的全部原文。除读取上述明确源文件外，只创建和回读以上两个虚构本地文件；不要签署、提交、发送、发布、联网或打开桌面软件。两份都写入并完整回读后才能说完成，任何一步未完成请明确说明。".replaceAll('<RUN_DIR>', 'D:/lumiOS/.codex-run/client-final-acceptance-test').replaceAll('<RUN_ID>', 'offline-closure');
  const contract = buildActionEvidenceContract(text);
  const outputs = requestedArtifactInstructions(text);
  expect(outputs.map(item => item.path)).toEqual(['D:/lumiOS/.codex-run/client-final-acceptance-test/files/甲-offline-closure.txt', 'D:/lumiOS/.codex-run/client-final-acceptance-test/files/乙-offline-closure.txt']);
  expect(contract.components).toHaveLength(3);
  expect(contract.components!.filter(item => item.text.includes('完整读取明确指定的源文件'))).toHaveLength(1);
  expect(outputs.every(item => requiresArtifactPostWriteReadback(item.text))).toBe(true);
  expect(contract.components!.filter(item => item.text.startsWith('写完后回读'))).toHaveLength(0);
});

it.each(['What is the source of happiness?', 'I like this typeface.', 'A prototype can be useful.'])('does not infer desktop work from an English substring: %s', text => { expect(buildActionContract(text).kind).toBe('none'); });
it.each(['Open Notepad', '查看桌面'])('keeps explicit desktop work: %s', text => { expect(buildActionContract(text)).toMatchObject({ applies:true, kind:'desktop_operation' }); });
