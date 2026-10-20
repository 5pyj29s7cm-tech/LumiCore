import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/providers', async original => ({ ...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model }));
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerChatSongTools } from '../server/tools/definitions/chat_song_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { buildActionEvidenceContract, buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { requestedArtifactInstructions } from '../server/cognition/artifact_progress';
import { requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { requiresArtifactPostWriteReadback, requiresArtifactOpen } from '../server/cognition/action_request';
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

it('finalizes the saved real Chinese mixed-source failure component by component, including after an optional model failure', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/compound_source_readback_live_20261021.json'), 'utf8'));
  const directory = path.join(String(process.env.LUMI_DATA_DIR), 'client-linked-probe/files').replace(/\\/g, '/');
  const remap = (value: any): any => typeof value === 'string' ? value.split(saved.originalPrefix).join(directory) : Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)])) : value;
  const live = remap(saved), text = live.prompt, records = live.records;
  fs.mkdirSync(directory, { recursive: true });
  for (const record of records.filter((row: any) => row.name === 'read_file')) fs.writeFileSync(record.arguments.path, record.result);
  const turn = { requestId: live.requestId, taskId: live.taskId };
  const acceptedActionContract = { taskText: text, contract: buildActionContract(text) };
  const input = { ...turn, taskText: text, responseText: '', source: 'chat', toolRecords: records, flow: { routeText: text, acceptedActionContract } };
  const contract = buildActionEvidenceContract(text, undefined, acceptedActionContract);
  expect(contract.components).toHaveLength(3); expect(hasCoreActionEvidence(contract, records, text, undefined, turn)).toBe(true);
  for (const completionGuard of [undefined, { text: 'Optional model call failed.', blocked: true, reason: 'model_failed_before_tool_execution' }]) {
    const finalized = finalizeLumiResponse({ ...input, completionGuard } as any);
    expect(finalized.blocked).toBe(false);
    for (const body of [live.sourceBody, ...live.outputBodies]) expect(finalized.text).toContain(body);
    expect(finalized.text).not.toContain('缺少要求的内容'); expect(finalized.text).not.toContain('尚未确认在指定软件中打开');
    expect(tryFinalizeVerifiedBoundedAction({ ...input, completionGuard } as any)?.blocked).toBe(false);
  }
  for (const missing of [records[0].id, records[2].id, records[4].id]) {
    const partial = records.filter((row: any) => row.id !== missing);
    expect(finalizeLumiResponse({ ...input, toolRecords: partial } as any).blocked).toBe(true);
    expect(tryFinalizeVerifiedBoundedAction({ ...input, toolRecords: partial } as any)).toBeNull();
  }
  expect(finalizeLumiResponse({ ...input, requestId: 'other-request' } as any).blocked).toBe(true);
  expect(finalizeLumiResponse({ ...input, taskId: 'other-task' } as any).blocked).toBe(true);
});

it.each([
  ['创建 D:/report.txt，内容为“打开浏览器”。不要打开软件。', false],
  ['创建 D:/report.txt。不要签署、提交、发送、发布、联网或打开桌面软件。', false],
  ['Save a report. Do not sign, send, publish or open it.', false],
  ['创建 D:/report.txt 并打开文件。', true],
  ['不要打开甲文件，但打开乙文件。', true],
  ['Save a report, then open it.', true],
  ['Do not open the source, but open the saved report.', true],
])('keeps coordinated negative opening scoped: %s', (text, expected) => { expect(requiresArtifactOpen(text)).toBe(expected); });

it('stops the real entry engine after its first verified existing-video retrieval without another model call', async () => {
  const userId='retrieval-once-'+randomUUID(),requestId=randomUUID(),conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id;
  const identity={userId,conversationId,requestId,agentId:'lumi',domain:'personal' as const,orgId:''};
  const projectId='a590fef2-1d8f-4cea-a2b6-6a3ed5567e6a';
  const text='请把已有聊天唱歌工程 '+projectId+'（第23版，作品“律师，先别替我气·完整剧情对唱”）已经保存的聊天记录版120秒视频，以可播放或下载的视频附件发在这里。只读取并取回既有成片，不要重新生成、渲染、导出，不要修改对白、歌曲、工程、模板或任何素材文件。找不到或当前成片已过期就明确说明，不要编造附件。';
  const outputPath=path.join(String(process.env.LUMI_DATA_DIR),'existing-retrieval-once.mp4');
  const bytes=Buffer.from('Offline owned video fixture; no generated media or audio-quality claim.');fs.writeFileSync(outputPath,bytes);
  const registry=new ToolRegistry();let reads=0;
  registerChatSongTools(registry);
  registry.get('chat_song_read')!.handler=async()=>{reads++;return JSON.stringify({ok:true,verified:true,status:'retrieved',projectId,revision:23,selectedStyle:'chat',outputPath,artifacts:[{type:'video',path:outputPath,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]});};
  model.mockReset();model.mockImplementation(async()=>{if(model.mock.calls.length>1)throw Error('The already verified read must terminate without another model call.');return{text:'',toolCalls:[{id:'existing-read-once',name:'chat_song_read',arguments:{projectId,revision:23,includeOutput:true}}]};});
  const result:any=await runLumiEntryTurn({entry:{source:'chat',channel:'chat',historyLimit:10,failureText:'Not complete.',failureReason:'fixture'},identity,userText:text,authorization:captureRequestAuthorization(()=>true,'Revoked'),controller:new AbortController(),
    planning:{dispatch:{...identity,text,source:'chat',channel:'chat',operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:3},executionBoundary:'trusted_local'},
    assemble:()=>({systemPrompt:'Offline existing retrieval fixture.',model:{registry,config:{provider:'deepseek',model:'offline-fixture',userId,requestId},getters:{},maxIterations:3,context:{authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:text,routedTaskText:text}}}),deliver:value=>value}as any);
  expect(model.mock.calls.length, JSON.stringify({ reads, taskId: result.taskId, records: result.toolRecords.map((r:any)=>({ name:r.name,taskId:r.taskId,error:r.error,verification:r.terminalVerification,envelope:r.envelope?.status })), finalized:result.finalized })).toBe(1);expect(reads).toBe(1);expect(result.toolRecords).toHaveLength(1);expect(result.toolRecords[0].envelope.status).toBe('verified_success');
  expect(result.finalized).toMatchObject({blocked:false,reason:'artifact_retrieved'});expect(result.finalized.fileArtifacts).toHaveLength(1);expect(result.finalized.fileArtifacts[0].path).toBe(outputPath);
  expect(readDB().conversationActionTasks.find((task:any)=>task.id===result.taskId)?.status).toBe('completed');expect(fs.readFileSync(outputPath)).toEqual(bytes);
});

it.each([' ', '\n', '\r\n'])('requires the same current-turn evidence across claim whitespace %s', separator => {
  const text='已查询到工商登记信息。'+separator+'企业名称：企查查科技股份有限公司；登记状态：在业；成立日期：2014-03-12；注册资本：36225万元。'+separator+'来源：企查查官方MCP；查询时间：2026-10-20T22:26:27.226Z。';
  expect(finalizeLumiResponse({taskText:'通过企查查查询该公司的工商登记信息。',responseText:text,toolRecords:[],taskId:'missing-source-task',requestId:'missing-source-request',source:'chat'})).toMatchObject({blocked:true,reason:'Missing external legal platform result evidence.'});
});
