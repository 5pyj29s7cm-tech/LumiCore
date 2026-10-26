import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({model:vi.fn()}));
vi.mock('../server/llm/providers',async()=>({...await vi.importActual<any>('../server/llm/providers'),makeLLMCall:mocks.model}));
import { resolveRequiredToolNamesForModel } from '../server/llm/tool_loop/runtime_activation';
import { prepareToolLoopModelResponse } from '../server/llm/tool_loop/model_response';
import { prepareModelRequestContext } from '../server/llm/request_context_budget';
import { promptBlockMessage } from '../server/llm/prompt_blocks';
import { ToolRegistry, isToolNameAllowedByPolicy } from '../server/tools/registry';

const names=['source_observer','past_failed','past_complete','client_capability_manifest'];
const records:any[]=[{name:'past_failed',error:'Old observation timed out.',terminalVerification:{status:'failed'}},{name:'past_complete',terminalVerification:{status:'verified'}}];
function state(pressure=false){
 const registry=new ToolRegistry();const handlers=names.map(()=>vi.fn(async()=> 'unused'));
 names.forEach((name,i)=>registry.register({name,description:'An existing permitted observation.',permission:'public',securityLevel:'safe',parameters:{type:'object',properties:Object.fromEntries(Array.from({length:pressure?150:1},(_,n)=>['bounded_filter_'+n,{type:'string'}]))},handler:handlers[i]}));
 const current=('Explain the supplied facts and source data here, preserving every given fact and prohibition. Do not create or change files. ').repeat(2).slice(0,166);
 const toolPolicy:any={allowedTools:['*'],forbiddenTools:Array.from({length:200},(_,i)=>'unused_tool_not_declared_'+String(i).padStart(3,'0')+'_guard'),requireConfirmation:['past_complete','not_exposed_confirmation'],maxIterations:5};
 const context:any={userId:'isolated-schema-user',requestId:'schema-current-request',taskId:'schema-current-task',toolPolicy,modelToolProjection:{maxTools:4,toolNames:names,requiredToolNames:['source_observer'],discoveryToolName:'client_capability_manifest'}};
 const source:any={role:'user',sourceMessageId:'schema-accepted-source',content:current};
 const latestAssistant:any={role:'assistant',content:null,reasoningContent:pressure?'OPAQUE_SIGNED_PROVIDER '.repeat(1050):'OPAQUE_SHORT',toolCalls:[{id:'latest-current-call',name:'past_complete',arguments:{query:'current source'}}]};
 const latestTool:any={role:'tool',toolCallId:'latest-current-call',name:'past_complete',content:pressure?'原始来源正文'.repeat(500):'The observed source data.'};
 const conversationHistory:any[]=[promptBlockMessage({id:'current-task-state',kind:'task_state',authority:'server',required:true,content:pressure?'S'.repeat(7872):'Current accepted task.'}),source,latestAssistant,latestTool];
 return{registry,handlers,toolPolicy,current,source,latestAssistant,latestTool,state:{toolRegistry:registry,toolExecutionContext:context,context,executionLog:records,priorExecutionRecords:[],primaryTask:'Explain the supplied facts and source data.',conversationHistory,messages:[source],config:{provider:'deepseek',model:'isolated-no-network',requestId:context.requestId,inputTokenBudget:24000},providerGetters:{},toolSessionActive:true,deterministicRecoveryToolCallIds:new Set()} as any};
}
beforeEach(()=>vi.resetAllMocks());
describe('current model schema and authorization scope',()=>{
 it('does not permanently require earlier failed or completed observation schemas',()=>{
  expect(resolveRequiredToolNamesForModel({modelToolProjection:{requiredToolNames:['source_observer'],discoveryToolName:'client_capability_manifest'}} as any,'Explain these supplied facts.',names.map(name=>({function:{name}})),records)).toEqual(['source_observer','client_capability_manifest']);
 });
 it('retains the routed winner, explicit user tool, server verification subset and discovery',()=>{
  const declarations=['routed_winner','server_verifier','explicit_user_tool','client_capability_manifest','past_failed'].map(name=>({function:{name}}));
  expect(resolveRequiredToolNamesForModel({modelToolProjection:{requiredToolNames:['server_verifier']}} as any,'Use explicit_user_tool for this request.',declarations,records)).toEqual(['routed_winner','server_verifier','explicit_user_tool','client_capability_manifest']);
 });
 it('retains creator, independent readback and requested application open tools',()=>{
  const declarations=['create_docx','read_docx','desktop_open','desktop_path_info'].map(name=>({function:{name}}));
  expect(resolveRequiredToolNamesForModel(undefined,'Create D:/work/output.docx, read it back and open it in WPS.',declarations,records)).toEqual(expect.arrayContaining(['create_docx','read_docx','desktop_open']));
 });
 it('retains external send verification even after old unrelated observations',()=>{
  const declarations=['wechat_send_file','wechat_send_message','desktop_active_window','desktop_capture_screen','past_failed'].map(name=>({function:{name}}));
  expect(resolveRequiredToolNamesForModel(undefined,'把 D:/work/output.docx 发给微信联系人林森。',declarations,records)).toEqual(expect.arrayContaining(['wechat_send_file','desktop_active_window','desktop_capture_screen']));
 });
 it('projects only current declared prohibitions and confirmations without mutating live policy',async()=>{
  const f=state();const before=JSON.stringify(f.toolPolicy);mocks.model.mockResolvedValue({text:'The explanation.',toolCalls:null});
  await prepareToolLoopModelResponse(f.state,4);
  const auth=mocks.model.mock.calls[0][0].find((message:any)=>message.promptBlock?.id==='current-execution-authorization');
  expect(auth.promptBlock.fields.declaredTools).toEqual(names);expect(auth.promptBlock.fields.forbiddenTools).toEqual([]);
  expect(auth.promptBlock.fields.confirmationTools).toEqual(['past_complete']);expect(auth.promptBlock.required).toBe(true);
  expect(JSON.stringify(f.toolPolicy)).toBe(before);expect(isToolNameAllowedByPolicy(f.toolPolicy.forbiddenTools[0],f.toolPolicy)).toBe(false);
 });
 it('retains the whole latest provider batch and current 166-character input under C2-scale pressure',async()=>{
  const f=state(true);let prepared:any;
  mocks.model.mockImplementation(async(messages:any[],toolDeclarations:any[],config:any)=>{prepared=prepareModelRequestContext({messages,toolDeclarations,inputTokenBudget:24000,protectedToolNames:config.protectedToolNames,preserveAssistantReasoning:true});return{text:'The explanation.',toolCalls:null};});
  await prepareToolLoopModelResponse(f.state,4);
  expect(mocks.model.mock.calls[0][2].protectedToolNames).toEqual(['source_observer','client_capability_manifest']);
  expect(prepared.messages.find((message:any)=>message.sourceMessageId===f.source.sourceMessageId)).toEqual(f.source);
  expect(prepared.messages.find((message:any)=>message.toolCalls?.[0]?.id==='latest-current-call')).toEqual(f.latestAssistant);
  expect(prepared.messages.find((message:any)=>message.toolCallId==='latest-current-call')).toEqual(f.latestTool);
  expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(24000);expect(f.current).toHaveLength(166);
 });
 it('keeps global denial authoritative even when no forbidden schema is exposed',async()=>{
  const f=state();f.toolPolicy.forbiddenTools=['*'];mocks.model.mockResolvedValue({text:'No action was performed.',toolCalls:null});
  await prepareToolLoopModelResponse(f.state,4);
  expect(mocks.model.mock.calls[0][1]).toEqual([]);expect(isToolNameAllowedByPolicy(names[0],f.toolPolicy)).toBe(false);
  const auth=mocks.model.mock.calls[0][0].find((message:any)=>message.promptBlock?.id==='current-execution-authorization');
  expect(auth.promptBlock.fields.forbiddenTools).toEqual(['*']);expect(f.handlers.every(handler=>handler.mock.calls.length===0)).toBe(true);
 });
 it('keeps canonical history unchanged while each provider attempt receives one current authorization block',async()=>{const f=state();const before=JSON.stringify(f.state.conversationHistory);mocks.model.mockResolvedValue({text:'Observed answer.',toolCalls:null});await prepareToolLoopModelResponse(f.state,4);await prepareToolLoopModelResponse(f.state,5);expect(JSON.stringify(f.state.conversationHistory)).toBe(before);for(const call of mocks.model.mock.calls)expect(call[0].filter((m:any)=>m.promptBlock?.id==='current-execution-authorization')).toHaveLength(1);});
});
