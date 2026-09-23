import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({ call: vi.fn(), streaming: vi.fn(), run: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: mocks.call, makeLLMCallStreaming: mocks.streaming }));
vi.mock('../server/llm/adapter', async original => { const actual=await original<typeof import('../server/llm/adapter')>(); mocks.run.mockImplementation(actual.runWithTools); return { ...actual, runWithTools:mocks.run }; });
vi.mock('../server/memory', async original => ({ ...await original<typeof import('../server/memory')>(), queryMemories:vi.fn(()=>[]), queryMemoriesVector:vi.fn(async()=>[]), extractMemories:vi.fn(async()=>({memories:[],reminders:[]})) }));
vi.mock('../server/agents/rag', async original => ({ ...await original<typeof import('../server/agents/rag')>(), retrieveChunks:vi.fn(async()=>[]) }));
vi.mock('../server/conversation/summary_scheduler', async original => ({ ...await original<typeof import('../server/conversation/summary_scheduler')>(), scheduleConversationSummary:vi.fn() }));

import { initDatabase, querySQL, readDB } from '../db_layer';
import { findConversationActionTask, getConversationActionStateByTaskId } from '../server/conversation/action_ledger';
import { startIsolatedConversation, getMessages, addMessage } from '../server/conversation/manager';
import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { clearAllPendingConfirmationsForTests } from '../server/tools/pending_confirmation';
import { loadXlsxWorkbook } from '../server/utils/spreadsheet';
import { hasRequestedArtifactPostWriteReadback } from '../server/cognition/action_contract';

describe('real shared-loop document delivery and Socket terminal consistency', () => {
  const root=String(process.env.LUMI_DATA_DIR);
  const userId='document-delivery-socket-user';
  const csv=path.join(root,'LC-TASK-ORDERS.csv').replace(/\\/g,'/');
  const csvText='商品,数量,单价\n水杯,2,12\n笔记本,3,8\n贴纸,4,3\n';
  let http:HttpServer, io:SocketIOServer, client:Socket, serial=0;
  let plan: Array<{text:string;toolCalls?:any[]}> = [];
  let invocation=0;
  let runBaseline=0;
  let activeRequestId='';
  const contexts:any[]=[];
  const providerTrace:any[]=[];
  beforeAll(async()=>{
    await initDatabase(); clearAllPendingConfirmationsForTests(); registerAllTools(toolRegistry);
    fs.writeFileSync(csv,csvText);
    const respond=async(_messages:any[],_declarations:any[],options:any,onChunk?:((text:string)=>void))=>{
      if(options?.source==='chat_intent_classifier')return {text:JSON.stringify({category:'command',confidence:0.99,entities:{}})};
      if(options?.source!=='chat')return {text:JSON.stringify({correctsIdentity:false})};
      if(options?.requestId!==activeRequestId)return {text:''};
      if(plan[0]?.toolCalls?.length && mocks.run.mock.calls.length===runBaseline)return {text:''};
      const context=mocks.run.mock.calls.at(-1)?.[11];if(context)contexts.push(context);
      const answer=plan[Math.min(invocation++,plan.length-1)] || {text:'没有可靠结果。'};
      providerTrace.push({requestId:options.requestId,invocation,tools:answer.toolCalls?.map(item=>item.name),visible:_declarations.map(item=>item.function?.name),targetPrompt:_messages.filter(item=>item.role==='system'&&String(item.content).includes('Server-resolved file reference for the current continuation:')).map(item=>item.content).join('\n')});
      if(!answer.toolCalls?.length)onChunk?.(answer.text);
      return {...answer,usage:{promptTokens:10,completionTokens:10,totalTokens:20}};
    };
    mocks.call.mockImplementation(respond);mocks.streaming.mockImplementation(respond);
    http=createServer();io=new SocketIOServer(http,{transports:['websocket']});
    io.on('connection',socket=>{
      socket.data.authenticatedUserId=userId;socket.data.authenticatedRole='admin';socket.data.trustedLocalExecution=true;socket.join(`user:${userId}:personal`);
      const getter=()=>({});
      registerChatHandler(socket,{getDeepSeek:getter,getGemini:getter,getOpenAI:getter,getAnthropic:getter,getQwen:getter,getOllama:getter,isOllamaAvailable:()=>false,getLmStudio:getter,isLmStudioAvailable:()=>false,getArk:getter,getXiaomi:getter,getKimi:getter,getGlm:getter,getRelay:getter},
        ()=>({audio:false,visual:false,spatial:false,haptic:false,holographic:false,activeDeviceTypes:[],deviceCount:0}),()=>userId,io);
    });
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    const address=http.address();if(!address||typeof address==='string')throw Error('Missing test address');
    client=createSocketClient(`http://127.0.0.1:${address.port}`,{transports:['websocket']});
    await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});
  });
  afterAll(async()=>{clearAllPendingConfirmationsForTests();client?.disconnect();if(io)await new Promise<void>(resolve=>io.close(()=>resolve()));if(http?.listening)await new Promise<void>(resolve=>http.close(()=>resolve()));});
  function conversation(){return startIsolatedConversation(userId,'lumi','personal','').id;}
  async function turn(conversationId:string,text:string,responses:typeof plan){
    plan=responses;invocation=0;runBaseline=mocks.run.mock.calls.length;
    const requestId=`document-turn-${++serial}`;
    activeRequestId=requestId;
    const response=new Promise<any>((resolve,reject)=>{const timeout=setTimeout(()=>{client.off('agent:response',handler);reject(Error(`Timed out ${requestId}`));},15000);const handler=(event:any)=>{if(event.requestId===requestId&&event.finalized){clearTimeout(timeout);client.off('agent:response',handler);resolve(event);}};client.on('agent:response',handler);});
    const history=getMessages(conversationId,80).map(row=>({role:row.role,content:row.message}));
    const ack=await client.timeout(5000).emitWithAck('agent:chat',{text,history,agentId:'lumi',domain:'personal',source:'command-center-chat',operationMode:'assistant',requestId,conversationId});
    expect(ack.ok,JSON.stringify(ack)).toBe(true);
    const terminal=await response;
    const persisted=(await querySQL<any>("SELECT id,message,completionFeedback,toolCalls FROM interactions WHERE conversationId=? AND requestId=? AND role='assistant'",[conversationId,requestId]));
    expect(persisted).toHaveLength(1);expect(persisted[0].message).toBe(terminal.text);
    const receipts=await querySQL<any>('SELECT taskId,toolName,outcome,envelope FROM conversation_action_receipts WHERE conversationId=? AND requestId=?',[conversationId,requestId]);
    return {terminal,persisted:persisted[0],receipts,requestId,calls:invocation};
  }
  const read=(file=csv)=>({text:'',toolCalls:[{id:`read-${serial}`,name:'read_file',arguments:{path:file}}]});
  it('repairs missing document content in the same task and verifies the repaired version before completion',async()=>{
    const id=conversation(),output=path.join(root,'checkpoint-repair.docx').replace(/\\/g,'/');
    const blocks:any[]=[{type:'heading',text:'会议安排'},{type:'paragraph',text:'6人参加，预算1200元。'},
      {type:'heading',text:'会议议题'},{type:'paragraph',text:'交付时间与数据归属'}];
    const create=(fixed:boolean)=>({text:'',toolCalls:[{id:`docx-${fixed}`,name:'create_docx',arguments:{outputPath:output,title:'项目会议',blocks:[...blocks,...(fixed?[{type:'heading',text:'会议结论'},{type:'paragraph',text:''}]:[])]}}]});
    const result=await turn(id,`新建 ${output}。资料：6人参加，预算1200元，讨论交付时间和数据归属。整理为安排、议题、留空的会议结论。回读检查，不要打开软件窗口。`,[create(false),create(true),{text:'所有内容都完成了。'}]);
    expect(result.terminal,JSON.stringify(result.terminal)).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(result.calls).toBe(2);
    expect(result.receipts.filter(row=>row.outcome==='verified_success').map(row=>row.toolName)).toEqual(['create_docx','read_docx','create_docx','read_docx']);
    expect(result.terminal.text).toContain('会议结论');
    expect(result.terminal.completionFeedback.completed).toContain('已核实：会议结论');
    expect(JSON.parse(result.persisted.completionFeedback).status).toBe('completed');
    expect(result.receipts.every(row=>row.taskId===result.receipts[0].taskId)).toBe(true);
    expect(result.receipts[0].taskId).toBeTruthy();
    const stored = getConversationActionStateByTaskId(readDB(), { conversationId: id, userId, taskId: result.receipts[0].taskId });
    expect(stored, JSON.stringify(stored)).toMatchObject({ status: 'completed', unfinished: false });
  });
  it('recalls saved partial progress and its next step instead of saying no result exists', async () => {
    const id = conversation(), output = path.join(root, 'partial-document.docx').replace(/\\/g, '/');
    const incomplete = { text: '', toolCalls: [{ id: 'partial-create', name: 'create_docx', arguments: {
      outputPath: output, title: '会议安排', blocks: [{ type: 'heading', text: '安排' }, { type: 'paragraph', text: '6人，1200元' },
        { type: 'heading', text: '议题' }, { type: 'paragraph', text: '交付时间' }],
    } }] };
    const result = await turn(id, `生成 ${output}，整理为安排、议题、留空的会议结论。请回读，不要打开窗口。`, [incomplete]);
    expect(result.terminal.blocked).toBe(true);
    expect(result.terminal.completionFeedback.incomplete.join('\n')).toContain('会议结论');
    const status = await turn(id, '刚才那份会议安排实际做到了哪一步？请根据已有记录告诉我，不要重新生成或操作文件。', [{ text: '没有结果。' }]);
    expect(status.calls).toBe(0); expect(status.receipts).toHaveLength(0);
    expect(status.terminal.text).toContain('文件已保存');
    expect(status.terminal.text).toContain('缺少要求的内容：会议结论');
    expect(status.terminal.text).toContain('下一步');
    expect(status.terminal.text).not.toContain('没有找到已完成');
  });
  it('preserves the exact plan target, delivers 60 then 84, and recalls the already-delivered answer without a model call',async()=>{
    const id=conversation();
    const original=await turn(id,`LC-UI-任务连续性复测：我要处理 ${csv}，按数量乘单价计算每项金额和总额。现在只简单说明准备怎么做，不要读取文件，也不要执行操作。`,[{text:'准备先读取订单，再按数量乘单价计算各项金额和总额；本轮没有执行。'}]);
    expect(original.receipts).toHaveLength(0);
    const execution=await turn(id,'现在执行刚才的读取和计算，把每项金额和总额告诉我，不修改原文件。',[read(),{text:'已完成读取和计算：\n- 水杯：2 × 12 = 24 元\n- 笔记本：3 × 8 = 24 元\n- 贴纸：4 × 3 = 12 元\n总额：60 元。原文件未修改。'}]);
    expect(contexts.some(context=>context.requestId===execution.requestId&&String(context.acceptedTaskTarget?.target.path||'').replace(/\\/g,'/')===csv),JSON.stringify(contexts.map(context=>({requestId:context.requestId,target:context.acceptedTaskTarget})))).toBe(true);
    expect(execution.receipts.map(row=>[row.toolName,row.outcome])).toEqual([['read_file','verified_success']]);
    expect(execution.terminal).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(execution.terminal.text).toContain('60');expect(execution.terminal.text).not.toContain('还没完成');
    const correction=await turn(id,'水杯的数量改成4，其余不变。只告诉我重新计算后的各项金额和总额，原文件不动。',[read(),{text:'已重新计算：\n- 水杯：4 × 12 = 48 元\n- 笔记本：3 × 8 = 24 元\n- 贴纸：4 × 3 = 12 元\n总额：84 元。原文件未修改。'}]);
    expect(correction.terminal).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(correction.terminal.text).toContain('84');
    const status=await turn(id,'你刚才实际完成了什么？原文件改过吗？只根据这次已经保存的操作记录告诉我，不要再执行操作。',[{text:'错误候选：从来没有输出任何计算结果。'}]);
    expect(status.calls).toBe(0);expect(status.receipts).toHaveLength(0);
    expect(status.terminal.text).toContain('84');expect(status.terminal.text).toContain('没有文件写入或修改操作');
    expect(status.terminal.text).toContain('文件读取 2 次');expect(status.terminal.text).not.toContain('read_file');
    expect(status.terminal.text).not.toContain('没有输出');expect(fs.readFileSync(csv,'utf8')).toBe(csvText);
    // Reproduce legacy persisted status-only tasks after a successful action.
    // The next read-only follow-up must still reach the actual delivery.
    const db = readDB();
    const completedTask = db.conversationActionTasks.find(row => row.id === correction.receipts[0].taskId)!;
    const legacyStatusTask = { ...completedTask, id: 'legacy-empty-status-task',
      goal: '刚才报表实际改好了吗？新总额多少？只根据已经保存的结果回答，不要重新操作文件。',
      status: 'blocked', context: '{}', createdAt: new Date(Date.now() + 1000).toISOString() };
    db.conversationActionTasks.push(legacyStatusTask);
    expect(findConversationActionTask(db, { conversationId: id, userId, taskId: legacyStatusTask.id })?.id).toBe(legacyStatusTask.id);
    const resultStatus = await turn(id,'刚才报表实际改好了吗？新总额多少？只根据已经保存的结果回答，不要重新操作文件。',[{text:'这次还没完成，没有可验证的执行结果。'}]);
    expect(resultStatus.calls).toBe(0);expect(resultStatus.receipts).toHaveLength(0);
    expect(resultStatus.terminal.text).toContain('84');expect(resultStatus.terminal.text).not.toContain('这次还没完成');
    const failedAction = { ...legacyStatusTask, id: 'real-blocked-action', goal: '创建下一份采购报表', createdAt: new Date(Date.now() + 2000).toISOString() };
    db.conversationActionTasks.push(failedAction);
    expect(findConversationActionTask(db, { conversationId: id, userId, latest: true })?.id).toBe(failedAction.id);
  });
  it.each(['已读取文件，任务已完成。','这项操作还没完成。已经完成的部分会保留，可以从这里重试。'])('retains a successful read but never marks an undelivered calculation completed: %s',async text=>{
    const result=await turn(conversation(),`读取 ${csv}，按数量乘单价计算每项金额和总额，保留原文件。`,[read(),{text}]);
    expect(result.receipts.some(row=>row.toolName==='read_file'&&row.outcome==='verified_success')).toBe(true);
    expect(result.terminal.blocked).toBe(true);
    expect(result.terminal.completionFeedback?.status).not.toBe('completed');
    expect(JSON.parse(result.persisted.completionFeedback).status).not.toBe('completed');
  });
  it('does not accept an invented continuation target from an unrelated actual file read',async()=>{
    const result=await turn(conversation(),'现在执行刚才的读取和计算，把每项金额和总额告诉我，不修改原文件。',[read(),{text:'已完成，总额60元。'}]);
    expect(result.receipts.filter(row=>row.toolName==='read_file'&&row.outcome==='verified_success')).toHaveLength(0);
    expect(result.terminal.completionFeedback?.status).not.toBe('completed');
    expect(result.terminal.text).not.toContain('已完成，总额60');
  });
  it('delivers actual XLSX readback after same-conversation save-as without changing the source workbook',async()=>{
    const id=conversation(),first=path.join(root,'LC-REPAIRED-V2-ORDERS.xlsx').replace(/\\/g,'/'),second=path.join(root,'LC-REPAIRED-V2-ORDERS-4.xlsx').replace(/\\/g,'/');
    const create=(output:string,quantity:number)=>({text:'',toolCalls:[{id:`create-${serial}`,name:'create_xlsx',arguments:{filename:'orders',outputPath:output,sheets:[{name:'订单',headers:['商品','数量','单价','金额'],data:[['水杯',quantity,12,quantity*12]]}]}}]});
    const readback=(filePath:string)=>({text:'',toolCalls:[{id:`readback-${serial}-${path.basename(filePath)}`,name:'read_xlsx',arguments:{filePath}}]});
    const initial=await turn(id,`新建 ${first}，只有一个工作表“订单”，表头为商品、数量、单价、金额，只有一条数据：水杯，2，12，24。实际保存后回读表格并告诉我内容。`,[create(first,2),readback(first),{text:'已完成文件。'}]);
    expect(initial.terminal.text,JSON.stringify({trace:providerTrace.filter(row=>row.requestId===initial.requestId),records:JSON.parse(initial.persisted.toolCalls)})).toContain('24');
    const result=await turn(id,`刚才生成的表格，水杯数量改成4，按数量乘单价更新金额，其余不变。原文件不动，另存为 ${second}。保存后回读修改后的表格并告诉我结果。`,[
      readback(first),
      {text:'',toolCalls:[{id:'actual-modification',name:'modify_xlsx',arguments:{filePath:first,outputPath:second,operations:[{sheet:'订单',cell:'B2',value:4},{sheet:'订单',cell:'D2',value:48}]}}]},
      readback(second),{text:'文件已完成。'},
    ]);
    expect(result.terminal,JSON.stringify({terminal:result.terminal,tools:JSON.parse(result.persisted.toolCalls)})).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(result.terminal.text).toContain('48');expect(result.terminal.text).toContain('水杯');expect(result.terminal.text).toContain('回读结果');
    expect(result.calls).toBe(2); // Read and modify selected by the model; exact saved-output readback is bound by the runtime.
    const targetPrompt = providerTrace.find(row=>row.requestId===result.requestId)?.targetPrompt || '';
    expect(JSON.parse(targetPrompt.split('\n')[1]).path.replace(/\\/g,'/')).toBe(first);
    const records = JSON.parse(result.persisted.toolCalls);
    const readbackTask = '保存后回读修改后的表格并告诉我结果。';
    expect(hasRequestedArtifactPostWriteReadback(records, readbackTask)).toBe(true);
    expect(hasRequestedArtifactPostWriteReadback(records.slice(0, -1), readbackTask)).toBe(false);
    expect(hasRequestedArtifactPostWriteReadback(records.map((record: any) => record.name === 'read_xlsx'
      ? { ...record, arguments: { filePath: first } } : record), readbackTask)).toBe(false);
    expect(result.receipts.some(row=>row.toolName==='read_xlsx'&&row.outcome==='verified_success')).toBe(true);
    expect((await loadXlsxWorkbook(first)).getWorksheet('订单')?.getCell('D2').value).toBe(24);
    expect((await loadXlsxWorkbook(second)).getWorksheet('订单')?.getCell('D2').value).toBe(48);
  });
  it.each([false,true])('exports the prior CSV and reads the new XLSX without confusing input and output identities (initial model unavailable: %s)',async(initialUnavailable)=>{
    const id=conversation(),output=path.join(root,'csv-export.xlsx').replace(/\\/g,'/');
    await turn(id,`读取 ${csv}，按数量乘单价计算每项金额和总额，原文件不动。`,initialUnavailable?[{text:''}]:[read(),{text:'读取计算完成，水杯24、笔记本24、贴纸12，总额60。原文件未修改。'}]);
    const result=await turn(id,`把刚才读取的那份 CSV 做成 Excel，按 CSV 文件里的原始数量。工作表叫“订单”，列为商品、数量、单价、金额，增加总额行。原文件不动，另存为 ${output}。实际保存后回读，告诉我各项金额和总额。`,[
      read(),
      {text:'',toolCalls:[{id:'csv-export-create',name:'create_xlsx',arguments:{outputPath:output,sheets:[{name:'订单',headers:['商品','数量','单价','金额'],data:[['水杯',2,12,24],['笔记本',3,8,24],['贴纸',4,3,12],['总额','','',60]]}]}}]},
      {text:'',toolCalls:[{id:'csv-export-readback',name:'read_xlsx',arguments:{filePath:output,sheetName:'订单'}}]},
      {text:'文件已保存。'},
    ]);
    expect(result.terminal,JSON.stringify({ terminal: result.terminal, records: JSON.parse(result.persisted.toolCalls), trace: providerTrace.filter(row=>row.requestId===result.requestId), context:{actionIntent:contexts.at(-1)?.actionIntent,routedTaskText:contexts.at(-1)?.routedTaskText,acceptedTaskTarget:contexts.at(-1)?.acceptedTaskTarget,trustedActionContinuation:contexts.at(-1)?.trustedActionContinuation} })).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(result.terminal.text).toContain('60');
    expect(result.receipts.filter(row=>row.outcome==='verified_success').map(row=>row.toolName)).toEqual(['read_file','create_xlsx','read_xlsx']);
    expect((await loadXlsxWorkbook(output)).getWorksheet('订单')?.getCell('D5').value).toBe(60);
    expect(result.terminal.fileArtifacts[0].path.replaceAll('\\', '/')).toBe(output);
    expect(result.terminal.fileArtifacts[0].kind).toBe('sheet');
    expect(new URL(result.terminal.fileArtifacts[0].url, 'http://local.invalid').searchParams.get('conversationId')).toBe(id);
    expect(fs.readFileSync(csv,'utf8')).toBe(csvText);
    const editedOutput=path.join(root,'csv-export-updated.xlsx').replace(/\\/g,'/');
    const edited=await turn(id,'水杯数量改成4，其余不变，更新刚才生成的 Excel，保存后回读告诉我结果。',[
      {text:'',toolCalls:[{id:'edit-read',name:'read_xlsx',arguments:{filePath:output,sheetName:'订单'}}]},
      {text:'',toolCalls:[{id:'edit-write',name:'modify_xlsx',arguments:{filePath:output,outputPath:output,operations:[{sheet:'订单',cell:'B2',value:4},{sheet:'订单',cell:'D2',value:48},{sheet:'订单',cell:'D5',value:84}]}}]},
      {text:'',toolCalls:[{id:'edit-verify',name:'read_xlsx',arguments:{filePath:editedOutput,sheetName:'订单'}}]},
      {text:'已经修改并保存。'},
    ]);
    expect(edited.terminal,JSON.stringify({terminal:edited.terminal,records:JSON.parse(edited.persisted.toolCalls).map((r:any)=>({name:r.name,error:r.error,result:r.result}))})).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(edited.terminal.reason).not.toBe('task_status');
    expect(edited.terminal.text).toContain('84');
    expect(edited.receipts.filter(row=>row.outcome==='verified_success').map(row=>row.toolName)).toEqual(['read_xlsx','modify_xlsx','read_xlsx']);
    const savedEdit=JSON.parse(JSON.parse(edited.persisted.toolCalls).find((r:any)=>r.name==='modify_xlsx').result).path;
    expect(savedEdit).not.toBe(output);
    expect((await loadXlsxWorkbook(savedEdit)).getWorksheet('订单')?.getCell('D5').value).toBe(84);
    expect((await loadXlsxWorkbook(output)).getWorksheet('订单')?.getCell('D5').value).toBe(60);
    expect(fs.readFileSync(csv,'utf8')).toBe(csvText);
    const retryOutput=path.join(root,'csv-export-again.xlsx').replace(/\\/g,'/');
    // Keep the real read/creation receipts, but move them outside the old
    // 18-message context window with unrelated, persisted conversational turns.
    for(let i=0;i<20;i++)addMessage({userId,conversationId:id,role:i%2?'assistant':'user',content:'谢谢。',requestId:`filler-${i}`,deferActionPreparation:true});
    const retry=await turn(id,`把刚才读取的那份 CSV 做成 Excel，按 CSV 文件里的原始数量。原文件不动，另存为 ${retryOutput}。实际保存后回读，告诉我各项金额和总额。`,[
      read(),
      {text:'',toolCalls:[{id:'csv-retry-create',name:'create_xlsx',arguments:{outputPath:retryOutput,sheets:[{name:'订单',headers:['商品','数量','单价','金额'],data:[['水杯',2,12,24],['笔记本',3,8,24],['贴纸',4,3,12],['总额','','',60]]}]}}]},
      {text:'',toolCalls:[{id:'csv-retry-readback',name:'read_xlsx',arguments:{filePath:retryOutput,sheetName:'订单'}}]},
      {text:'文件已保存。'},
    ]);
    expect(retry.terminal,JSON.stringify(retry.terminal)).toMatchObject({blocked:false,completionFeedback:{status:'completed'}});
    expect(retry.terminal.text).toContain('60');
    expect(retry.receipts.filter(row=>row.outcome==='verified_success').map(row=>row.toolName)).toEqual(['read_file','create_xlsx','read_xlsx']);
  });
});
