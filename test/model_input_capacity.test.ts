import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const extension=vi.hoisted(()=>({model:vi.fn(),local:vi.fn(),client:vi.fn()}));
vi.mock('../server/extensions/registry',async()=>({...await vi.importActual<any>('../server/extensions/registry'),assertRegisteredProviderModel:extension.model,isRegisteredProviderLocal:extension.local,getRegisteredOpenAIClient:extension.client}));
import { prepareCompatibleModelRequest } from '../server/llm/provider/request_preparation';
import { parseOfficialApiModelCatalog, listOfficialApiModels } from '../server/llm/official_api';
import { ModelRequestSourceProvenanceError, prepareModelRequestContext, resolveModelRequestInputBudget } from '../server/llm/request_context_budget';
import { prepareLocalModelRequest } from '../server/llm/local_context_budget';
import type { NormalizedMessage } from '../server/llm/providers';

const client={baseURL:'https://provider.fixture.invalid/v1'};
const getters=Array.from({length:12},()=>()=>client) as any;
const small:NormalizedMessage[]=[{role:'user',sourceMessageId:'capacity-current-source',content:'Keep the supplied facts and prohibitions exactly. Answer here without creating files.'}];
async function prepare(config:any={provider:'relay',model:'aliyun/deepseek-v4-pro'},messages=small,maxTokens=8000,extensionProvider=false,tools:any[]=[]){
 return prepareCompatibleModelRequest(messages,tools,config,maxTokens,getters,extensionProvider,false);
}
async function catalog(model:any){
 return listOfficialApiModels({fetchImpl:vi.fn(async()=>new Response(JSON.stringify({data:[model]}),{status:200,headers:{'content-type':'application/json'}})) as any});
}
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('LUMI_MODEL_INPUT_TOKEN_BUDGET','');vi.stubEnv('RELAY_BASE_URL','https://catalog-'+Math.random().toString(36).slice(2)+'.fixture.invalid/v1');vi.stubEnv('RELAY_API_KEY','isolated-catalog-placeholder');extension.local.mockReturnValue(false);extension.client.mockReturnValue(client);});
afterEach(()=>vi.unstubAllEnvs());
describe('actual selected model input capacity',()=>{
 it('sends more than 131072 tokens of original input intact to the documented exact 1M model',async()=>{
  const original='SOURCE_BEGIN '+ 'independent_source_fact '.repeat(21000)+' SOURCE_MIDDLE_KEEP '+ 'tail_source_fact '.repeat(6000)+' SOURCE_END';
  const messages:NormalizedMessage[]=[{role:'user',sourceMessageId:'large-current-source',content:original}];
  const result=await prepare(undefined,messages,8192);
  expect(result.preparedContext.originalEstimatedInputTokens).toBeGreaterThan(131072);
  expect(result.preparedContext.messages).toEqual(messages);expect(result.preparedContext.compacted).toBe(false);
  expect(result.preparedContext.budgetTokens).toBe(1000000-8192);
  expect(result.params.max_tokens).toBe(8192);
 });
 it('retains valid provider capacity fields and lets provider limits override documented model defaults',async()=>{
  const row={id:'aliyun/deepseek-v4-pro',capability:'chat',provider_model_name:'deepseek-v4-pro-0813',context_window:16384,max_input_tokens:12000,max_output_tokens:6000};
  expect(parseOfficialApiModelCatalog({data:[row]}).models[0]).toMatchObject({contextWindow:16384,maxInputTokens:12000,maxOutputTokens:6000});
  await catalog(row);const result=await prepare(undefined,small,4096);expect(result.preparedContext.budgetTokens).toBe(12000);
 });
 it('does not round a real small provider capacity up to the former 4096 minimum',async()=>{
  await catalog({id:'aliyun/deepseek-v4-pro',capability:'chat',context_window:1024,max_input_tokens:900});
  const result=await prepare(undefined,small,512);expect(result.preparedContext.budgetTokens).toBe(512);
 });
 it('does not invent a 24k or 1M application cap for an unknown cloud model',async()=>{
  const original='UNKNOWN_MODEL_SOURCE '+ 'unbounded_by_app_not_provider '.repeat(18000);
  const result=await prepare({provider:'openai',model:'unknown-cloud-model'},[{role:'user',sourceMessageId:'unknown-current-source',content:original}],4096);
  expect(result.preparedContext.budgetTokens).toBe(Infinity);expect(result.preparedContext.compacted).toBe(false);expect(result.preparedContext.messages[0].content).toBe(original);
 });
 it('preserves caller and environment budgets without the old 131072 clamp',async()=>{
  expect(resolveModelRequestInputBudget(240000)).toBe(240000);expect(resolveModelRequestInputBudget(200)).toBe(200);expect(resolveModelRequestInputBudget()).toBe(Infinity);
  const explicit=await prepare({provider:'relay',model:'aliyun/deepseek-v4-pro',inputTokenBudget:240000});expect(explicit.preparedContext.budgetTokens).toBe(240000);
  vi.stubEnv('LUMI_MODEL_INPUT_TOKEN_BUDGET','9000');const env=await prepare({provider:'relay',model:'aliyun/deepseek-v4-pro',inputTokenBudget:12000});expect(env.preparedContext.budgetTokens).toBe(9000);
 });
 it('uses exact signed extension model capacity and recomputes for a different attempt',async()=>{
  extension.model.mockReturnValue({id:'signed-small',capabilities:{text:true,tools:true},contextWindow:12000,maxOutputTokens:4000});
  const config:any={provider:'relay',model:'aliyun/deepseek-v4-pro'};const before=JSON.stringify(config);
  const large=await prepare(config,small,2000);const signed=await prepare({provider:'signed-provider',model:'signed-small'},small,2000,true);
  expect(large.preparedContext.budgetTokens).toBe(998000);expect(signed.preparedContext.budgetTokens).toBe(10000);expect(JSON.stringify(config)).toBe(before);
 });
 it('does not reserve an unrequested theoretical maximum output',async()=>{
  extension.model.mockReturnValue({id:'signed-small',capabilities:{text:true,tools:true},contextWindow:12000,maxOutputTokens:4000});
  const result=await prepareCompatibleModelRequest(small,[],{provider:'signed-provider',model:'signed-small'} as any,undefined,getters,true,false);
  expect(result.preparedContext.budgetTokens).toBe(12000);expect(result.params.max_tokens).toBeUndefined();
 });

 it('keeps a source within actual input capacity when output budget is unspecified',async()=>{
  const original='EXACT_BEGIN '+ '事'.repeat(600000)+' EXACT_END';
  const messages:NormalizedMessage[]=[{role:'user',sourceMessageId:'uncapped-output-source',content:original}];
  const before=JSON.stringify(messages);
  const result=await prepareCompatibleModelRequest(messages,[],{provider:'relay',model:'aliyun/deepseek-v4-pro'},undefined,getters,false,false);
  expect(result.preparedContext.originalEstimatedInputTokens).toBeGreaterThan(606784);
  expect(result.preparedContext.originalEstimatedInputTokens).toBeLessThan(1000000);
  expect(result.preparedContext.budgetTokens).toBe(1000000);
  expect(result.preparedContext.compacted).toBe(false);
  expect(result.params.messages[0].content).toBe(original);
  expect(result.params.max_tokens).toBeUndefined();
  expect(JSON.stringify(messages)).toBe(before);
 });
 it('rejects a full current source exceeding the real provider input limit rather than clipping it',async()=>{
  await catalog({id:'aliyun/deepseek-v4-pro',capability:'chat',context_window:1024,max_input_tokens:900,max_output_tokens:512});
  const messages:NormalizedMessage[]=[{role:'user',sourceMessageId:'real-small-capacity',content:'原'.repeat(3000)}];
  const before=JSON.stringify(messages);
  try{
   await prepareCompatibleModelRequest(messages,[],{provider:'relay',model:'aliyun/deepseek-v4-pro'},undefined,getters,false,false);
   throw new Error('Expected real input-capacity rejection');
  }catch(error){
   expect(error).toBeInstanceOf(ModelRequestSourceProvenanceError);
   expect((error as ModelRequestSourceProvenanceError).capacityExceeded).toBe(true);
  }
  expect(JSON.stringify(messages)).toBe(before);
 });

 it('keeps local loaded/working capacity and explicit voice-sized request limits',async()=>{
  const local=prepareLocalModelRequest({messages:small,toolDeclarations:[],contextTokens:4096,maxTokens:512});expect(local.inputBudgetTokens).toBeLessThanOrEqual(4096-512);expect(local.inputBudgetTokens).toBe(3175);
  const voice=await prepare({provider:'relay',model:'aliyun/deepseek-v4-pro',inputTokenBudget:16000},small,2000);expect(voice.preparedContext.budgetTokens).toBe(16000);
 });
 it('does not use stale catalog limits after the configured gateway changes',async()=>{
  await catalog({id:'aliyun/deepseek-v4-pro',capability:'chat',context_window:16000,max_input_tokens:14000});vi.stubEnv('RELAY_BASE_URL','https://another.fixture.invalid/v1');
  const result=await prepare(undefined,small,2000);expect(result.preparedContext.budgetTokens).toBe(998000);
 });
 it('keeps malformed source and tool protocol failures distinct when there is no application cap',()=>{
  expect(()=>prepareModelRequestContext({messages:[...small,{role:'user',sourceMessageId:'second-source',content:'Ambiguous.'}],toolDeclarations:[]})).toThrow(ModelRequestSourceProvenanceError);
  try{prepareModelRequestContext({messages:[...small,{role:'tool',toolCallId:'orphan',content:'Unpaired source.'}],toolDeclarations:[],preserveAssistantReasoning:true});throw Error('Expected provenance rejection');}catch(error){expect(error).toBeInstanceOf(ModelRequestSourceProvenanceError);expect((error as any).capacityExceeded).toBe(false);}
 });
});
