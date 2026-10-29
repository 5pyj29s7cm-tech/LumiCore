import './helpers';
import { prepareChatEvents } from '../server/socket/chat/phases/prepare_chat_events';
import { projectConversationMessageForCustomer } from '../server/routes/conversations';
import { resolveGeneratedDownloadPath } from '../server/files/knowledge/paths';
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


it('completes the exact desktop Word to PDF handoff after real reads without an extra model closeout', async () => {
  const os = (await import('node:os')).default;
  const { Document, Packer, Paragraph } = await import('docx');
  const { registerDocumentTools } = await import('../server/tools/definitions/document_tools');
  const { registerPdfTools } = await import('../server/tools/definitions/pdf_tools');
  const { extractPdfTextContent } = await import('../server/utils/pdf_text');
  const home = path.join(String(process.env.LUMI_DATA_DIR), 'word-pdf-entry-home-' + randomUUID());
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const desktop = path.join(home, 'Desktop'); fs.mkdirSync(desktop, { recursive: true });
    const source = path.join(desktop, '共同验收修订.docx'), output = path.join(desktop, '共同验收修订.pdf');
    const body = '共同验收修订\n蓝色纸盒，共3个\n橙色书签，共9个';
    fs.writeFileSync(source, await Packer.toBuffer(new Document({ sections: [{ children: body.split('\n').map(text => new Paragraph(text)) }] })));
    const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const userId = 'real-word-pdf-' + randomUUID(), requestId = randomUUID();
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', ''), conversationId = conversation.id;
    const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
    const text = '读取桌面的“共同验收修订.docx”，将全部文字制作成桌面的“共同验收修订.pdf”，保留标题和两条内容，不修改原Word。核对PDF文字后，把原Word和PDF两个文件都发到当前聊天。';
    const registry = new ToolRegistry(); registerDocumentTools(registry); registerPdfTools(registry);
    let round = 0, unnecessaryModelCalls = 0; model.mockReset(); model.mockImplementation(async () => {
      if (++round === 1) return { text: '', toolCalls: [{ id: 'real-source-docx-read', name: 'read_docx', arguments: { filePath: source } }] };
      if (round === 2) return { text: '', toolCalls: [{ id: 'real-exact-pdf-create', name: 'create_pdf', arguments: { outputPath: output, title: '共同验收修订', content: body } }] };
      if (readDB().conversationActionReceipts.some((row: any) => row.requestId === requestId && row.toolName === 'read_pdf' && row.outcome === 'verified_success')) { unnecessaryModelCalls++; throw Error('Verified Word and PDF handoff must finish without another model closeout.'); }
      if (round === 3) return { text: '', toolCalls: [{ id: 'real-pdf-readback', name: 'read_pdf', arguments: { filePath: output } }] };
      unnecessaryModelCalls++; throw Error('Unexpected additional model call for an exact three-tool handoff.');
    });
    const result: any = await runLumiEntryTurn({ entry: { source: 'chat', channel: 'chat', historyLimit: 10, failureText: 'Not complete.', failureReason: 'fixture' }, identity, userText: text,
      authorization: captureRequestAuthorization(() => true, 'Revoked'), controller: new AbortController(),
      planning: { dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry,
        personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 4 }, executionBoundary: 'trusted_local' },
      assemble: () => ({ systemPrompt: 'Offline real-document handoff fixture; model selects only the next tool.', model: { registry,
        config: { provider: 'deepseek', model: 'offline-fixture', userId, requestId }, getters: {}, maxIterations: 4,
        context: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local', actionIntent: text, routedTaskText: text,
          allowLocalFileWrites: true, requestConfirmation: async () => true } } }), deliver: value => value } as any);
    expect(unnecessaryModelCalls).toBe(0); expect(round).toBeGreaterThanOrEqual(2); expect(round).toBeLessThanOrEqual(3); expect(result.toolRecords.map((record: any) => record.name)).toEqual(['read_docx', 'create_pdf', 'read_pdf']);
    expect(result.toolRecords.every((record: any) => record.envelope?.status === 'verified_success'), JSON.stringify(result.toolRecords.map((record: any) => ({name:record.name,error:record.error,result:record.result,verification:record.terminalVerification,envelope:record.envelope?.status})))).toBe(true);
    expect(result.finalized.blocked, JSON.stringify(result.finalized)).toBe(false);
    expect(readDB().conversationActionTasks.find((task: any) => task.id === result.taskId)?.status).toBe('completed');
    const expected = [source, output].sort();
    expect(result.finalized.fileArtifacts.map((file: any) => file.path).sort()).toEqual(expected);
    const events = await prepareChatEvents({ uid: userId, requestId, selectedConversationId: conversationId, selectedConversation: conversation,
      visibleUserText: text, resolvedDomain: 'personal', resolvedOrgId: '', eventSource: 'command-center-chat', conversationAgentId: 'lumi',
      durableTaskId: result.taskId, collectRequestTerminalRecords: () => result.toolRecords } as any);
    const terminal = events.context!.normalizeAgentPayload('agent:response', { ...result.finalized, finalized: true });
    expect(terminal.blocked).toBe(false); expect(terminal.fileArtifacts.map((file: any) => file.path).sort()).toEqual(expected);
    const stored = readDB().interactions.find((row: any) => row.requestId === requestId && row.role === 'assistant');
    expect(stored).toBeTruthy();
    const history = projectConversationMessageForCustomer(stored);
    expect(history.fileArtifacts.map((file: any) => file.path).sort()).toEqual(expected);
    const req = { user: { uid: userId, role: 'admin' }, query: { conversationId } } as any;
    for (const file of expected) expect(resolveGeneratedDownloadPath(file, req)).toBe(fs.realpathSync.native(file));
    expect(createHash('sha256').update(fs.readFileSync(source)).digest('hex')).toBe(sourceHash);
    const pdfText = (await extractPdfTextContent(output)).text.replace(/\s+/gu, '');
    for (const line of body.split('\n')) expect(pdfText).toContain(line.replace(/\s+/gu, ''));
    expect(pdfText).not.toContain('共7个');
  } finally { homedir.mockRestore(); }
});


it.each([
  '另外通过微信把新文件发送给王经理。',
  '再用微信给李女士发送文件。',
])('preserves an additional messaging action beside source and output components: %s', send => {
  const text = sourceRead + ' ' + firstWrite + ' ' + send;
  const contract = buildActionEvidenceContract(text);
  expect(contract.components).toHaveLength(3);
  const messaging = contract.components!.filter(item => item.contract.kind === 'messaging_send');
  expect(messaging).toHaveLength(1);
  expect(messaging[0].text).toContain('微信');
  expect(messaging[0].contract.preferredTools).toContain('wechat_send_file');
  expect(hasCoreActionEvidence(messaging[0].contract, [], messaging[0].text)).toBe(false);
});
it('does not turn current-chat file handoff into an additional messaging action', () => {
  const text = '读取桌面的“源文.docx”，将全部文字制作成桌面的“转出.pdf”。核对PDF文字后，把原Word和PDF两个文件都发到当前聊天。';
  const contract = buildActionEvidenceContract(text);
  expect(contract.components).toHaveLength(2);
  expect(contract.components!.every(item => item.contract.kind === 'artifact_work')).toBe(true);
});
it.each([
  '不要通过微信把新文件发送给王经理。',
  '怎么通过微信发送这个文件？',
])('does not add negated or informational messaging to artifact obligations: %s', suffix => {
  const contract = buildActionEvidenceContract(sourceRead + ' ' + firstWrite + ' ' + suffix);
  expect(contract.components).toHaveLength(2);
  expect(contract.components!.some(item => item.contract.kind === 'messaging_send')).toBe(false);
});
it('does not turn quoted output content into an additional messaging action', () => {
  const contract = buildActionEvidenceContract(sourceRead + ' Then create D:/note.txt containing “通过微信给王经理发送文件”。');
  expect(contract.components).toHaveLength(2);
  expect(contract.components!.some(item => item.contract.kind === 'messaging_send')).toBe(false);
});

it('keeps normal finalization blocked when source and output succeeded but the extra file send did not', () => {
  const fixtureParent = String(process.env.LUMI_DATA_DIR);
  const root = fs.mkdtempSync(path.join(fixtureParent, 'pending-file-send-'));
  const source = path.join(root, 'source.txt');
  const output = path.join(root, 'output.txt');
  const turn = { requestId: 'pending-send-request', taskId: 'pending-send-task' };
  const verifiedRead = { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Current complete text read.' };
  try {
    fs.writeFileSync(source, 'SOURCE'); fs.writeFileSync(output, 'DONE');
    const text = 'Read the file "' + source + '" and show its complete contents. Then create the file "' + output + '" containing "DONE" and read it back. 另外通过微信把新文件发送给王经理。';
    const records = [
      { id: 'source-read', name: 'read_file', arguments: { path: source }, result: 'SOURCE', ...turn, terminalVerification: verifiedRead },
      { id: 'output-write', name: 'write_file', arguments: { path: output, content: 'DONE' }, result: 'File written: ' + output, ...turn,
        terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'Current local output exists.' } },
      { id: 'output-read', name: 'read_file', arguments: { path: output }, result: 'DONE', ...turn, terminalVerification: verifiedRead },
    ];
    const contract = buildActionEvidenceContract(text);
    expect(contract.components!.some(item => item.contract.kind === 'messaging_send')).toBe(true);
    expect(hasCoreActionEvidence(contract, records, text, undefined, turn)).toBe(false);
    expect(finalizeLumiResponse({ taskText: text, responseText: '文件已全部发给王经理，任务已完成。', toolRecords: records, source: 'chat', ...turn }).blocked).toBe(true);
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(fixtureParent) + path.sep)) throw new Error('Fixture cleanup escaped its isolated directory.');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each(['甲仓：12袋。\n乙仓：21袋。', '原记录合计：12袋。\n补充记录：21袋。'])('preserves the complete compound answer without promoting file readback to verified calculation: %s', body => {
  const root = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'compound-calculation-'));
  const source = path.join(root, 'source.txt');
  const output = path.join(root, 'output.txt');
  const computed = body + '\n两仓合计：33袋。';
  fs.writeFileSync(source, body); fs.writeFileSync(output, computed);
  const turn = { requestId: 'compound-calculation-request', taskId: 'compound-calculation-task' };
  const verifiedRead = { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Current complete local read.' };
  const records = [
    { id: 'source-read', name: 'read_file', arguments: { path: source }, result: body, ...turn, terminalVerification: verifiedRead },
    { id: 'output-write', name: 'write_file', arguments: { path: output, content: computed }, result: 'File written: ' + output, ...turn,
      terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'Current local output exists.' } },
    { id: 'output-read', name: 'read_file', arguments: { path: output }, result: computed, ...turn, terminalVerification: verifiedRead },
  ];
  const text = `完整读取“${source}”并展示全部正文；创建“${output}”，保留来源的全部文字，末尾追加一行两仓合计袋数；写完后回读并检查新文件，将全部正文直接发到本聊天。不要修改原文件。`;
  const input = { ...turn, taskText: text, responseText: computed, toolRecords: records, source: 'chat' };
  expect(buildActionEvidenceContract(text).components, JSON.stringify(buildActionEvidenceContract(text))).toHaveLength(2);
  const result = finalizeLumiResponse(input);
  expect(result.blocked).toBe(true);
  expect(result.reason).toContain('analysis_completion_unverified');
  expect(result.text).toContain(computed);
  expect(result.text).not.toContain('分析结论还没有生成');
  expect(finalizeLumiResponse({ ...input, responseText: '' }).blocked).toBe(true);
  for (const missing of ['source-read', 'output-write', 'output-read']) {
    const incomplete = finalizeLumiResponse({ ...input, toolRecords: records.filter(record => record.id !== missing) });
    expect(incomplete.blocked, missing + ': ' + JSON.stringify(incomplete)).toBe(true);
  }
  expect(finalizeLumiResponse({ ...input, toolRecords: [records[0]] }).blocked).toBe(true);
  for (const uncomputed of [body, '报告\n' + body]) {
    fs.writeFileSync(output, uncomputed);
    const rawRecords = [records[0], { ...records[1], arguments: { path: output, content: uncomputed } }, { ...records[2], result: uncomputed }];
    expect(finalizeLumiResponse({ ...input, responseText: uncomputed, toolRecords: rawRecords }).blocked, uncomputed).toBe(true);
  }
  for (const unrelated of ['生成结果：1个文件。', '示例文字：“合计99袋”，并非本文件计算结果。', '版本=2026。', '结果：3种颜色。']) {
    const unrelatedBody = body + '\n' + unrelated;
    fs.writeFileSync(output, unrelatedBody);
    const unrelatedRecords = [records[0], { ...records[1], arguments: { path: output, content: unrelatedBody } }, { ...records[2], result: unrelatedBody }];
    for (const responseText of ['', body, computed, unrelatedBody]) {
      expect(finalizeLumiResponse({ ...input, responseText, toolRecords: unrelatedRecords }).blocked, unrelated + ': ' + responseText).toBe(true);
    }
  }
  fs.writeFileSync(output, computed);
  for (const invalidRead of [
    { ...records[2], requestId: 'older-request' },
    { ...records[2], arguments: { path: path.join(root, 'unrelated.txt') } },
  ]) {
    expect(finalizeLumiResponse({ ...input, toolRecords: [records[0], records[1], invalidRead] }).blocked).toBe(true);
  }
  const missingOutput = text + ` Then create the file "${path.join(root, 'another.txt')}" containing "SECOND" and read it back.`;
  expect(buildActionEvidenceContract(missingOutput).components).toHaveLength(3);
  expect(finalizeLumiResponse({ ...input, taskText: missingOutput }).blocked).toBe(true);
  for (const analysis of ['另外总结源文件', '计算源文件总额']) {
    const separateAnalysis = `完整读取“${source}”并展示全部正文；创建“${output}”；${analysis}。`;
    expect(finalizeLumiResponse({ ...input, taskText: separateAnalysis, responseText: body, toolRecords: records.slice(0, 2) }).blocked, analysis).toBe(true);
  }
  const analysisText = `请读取并计算“${source}”中的两仓合计袋数。`;
  for (const responseText of ['', body]) {
    expect(finalizeLumiResponse({ ...turn, taskText: analysisText, responseText, toolRecords: [records[0]], source: 'chat' }).blocked).toBe(true);
  }
  expect(finalizeLumiResponse({ ...turn, taskText: `完整读取“${source}”。`, responseText: body, toolRecords: [records[0]], source: 'chat',
    flow: { rootTaskText: analysisText } as any }).blocked).toBe(true);
  for (const analysis of ['总结两份内容', '比较两份内容', '计算两份的合计']) {
    const readAndAnalyze = `完整读取“${source}”并展示全部正文；完整读取“${output}”并展示全部正文；${analysis}。`;
    const readRecords = [records[0], records[2]];
    expect(buildActionEvidenceContract(readAndAnalyze).components).toHaveLength(2);
    expect(finalizeLumiResponse({ ...turn, taskText: readAndAnalyze, responseText: body + '\n' + computed, toolRecords: readRecords, source: 'chat' }).blocked, analysis).toBe(true);
  }
  expect(fs.readFileSync(source, 'utf8')).toBe(body);
});
