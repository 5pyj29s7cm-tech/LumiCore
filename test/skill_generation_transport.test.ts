import './helpers';
import {describe,it,expect,vi} from 'vitest';
import {parseGeneratedSkillResponse} from '../server/skills/generator';
import {makeLLMCallDirect} from '../server/llm/providers';

describe('skill generation source transport',()=>{
 it('preserves regex, quotes and line breaks without a second decode',()=>{
  const source=String.raw`const rows = args.text.split(/\r?\n/);
const quoted = '"value"';
result = JSON.stringify({rows,quoted});`;
  const text='```json\n'+JSON.stringify({skillName:'lines',inputSchema:{type:'object'}})+'\n```\n```typescript\n'+source+'\n```';
  expect(parseGeneratedSkillResponse(text).handlerCode).toBe(source);
  expect(parseGeneratedSkillResponse(JSON.stringify({handlerCode:source})).handlerCode).toBe(source);
  expect(()=>parseGeneratedSkillResponse(text+'\nUnrequested additional code')).toThrow();
 });
 it.each([
  ['relay','aliyun/deepseek-v4-pro',true,true],
  ['relay','aliyun/deepseek-v4-pro',false,false],
  ['relay','aliyun/kimi-k3',true,false],
  ['deepseek','deepseek-v4-pro',true,true],
 ] as const)('scopes direct generation mode to a supported requested call (%s/%s/%s)',async(provider,model,direct,expected)=>{
  const create=vi.fn().mockResolvedValue({choices:[{message:{content:'done'},finish_reason:'stop'}]});
  const getClient=()=>({chat:{completions:{create}}}), none=()=>null;
  await makeLLMCallDirect([{role:'user',content:'Synthetic draft.'}],[],{provider,model,...(direct?{thinkingMode:'disabled' as const}:{})},getClient,none,none,none,none,none,none,none,none,none,none,getClient);
  expect(create.mock.calls[0][0].thinking).toEqual(expected?{type:'disabled'}:undefined);
 });
});
