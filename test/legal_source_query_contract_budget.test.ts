import { describe, expect, it } from 'vitest';
import { external_researchTools } from '../server/regions/packs/cn/legal_tools/definitions_external_research';
import { prepareModelRequestContext, estimateModelRequestTextTokens } from '../server/llm/request_context_budget';
import { promptBlockMessage } from '../server/llm/prompt_blocks';

const tool=external_researchTools().find(tool=>tool.name==='legal_search_external_authorities')!;
describe('official source query contract survives the actual schema budget',()=>{
 it.each([4096,24000])('keeps article selection and batch use visible after %i-token request projection',budget=>{
  const current={role:'user' as const,sourceMessageId:'query-contract-current-source',content:'Use the supplied facts and official source text. Return the analysis here without creating or changing files.'};
  const authorization=promptBlockMessage({id:'current-execution-authorization',kind:'authorization',authority:'server',required:true,content:'Only the selected source tool is authorized.'});
  const prepared=prepareModelRequestContext({messages:[{role:'system',content:'Optional background style '.repeat(15000)},current,authorization],
   toolDeclarations:[{type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}}],inputTokenBudget:budget,protectedToolNames:[tool.name]});
  expect(prepared.compacted).toBe(true);
  const projected=prepared.toolDeclarations.find(declaration=>declaration.function.name===tool.name)!.function;
  const query=projected.parameters.properties.query.description;
  expect(projected.description).toMatch(/法名[+＋]条号/u);
  expect(projected.description).toContain('同法多条一次查');
  expect(projected.description).toContain('实际原文');
  expect(query).toMatch(/法名[+＋]具体条号/u);
  expect(query).toContain('同法多条一次查');expect(query).toContain('未知条号');expect(query).toContain('主题定位');expect(query).toContain('不同法源分查');
  expect(projected.description+' '+query).not.toContain('compacted');
  expect(estimateModelRequestTextTokens(projected.description)).toBeLessThanOrEqual(140);
  expect(estimateModelRequestTextTokens(query)).toBeLessThanOrEqual(80);
  expect(projected.parameters.required).toEqual(['query']);
  expect(Object.keys(projected.parameters.properties)).toEqual(Object.keys(tool.parameters.properties));
  expect(prepared.messages.find(message=>message.sourceMessageId===current.sourceMessageId)).toEqual(current);
  expect(prepared.messages.find(message=>message.promptBlock?.id==='current-execution-authorization')).toEqual(authorization);
  expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(budget);
 });
});
