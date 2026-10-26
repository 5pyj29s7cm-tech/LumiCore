import './helpers';
import { describe, expect, it } from 'vitest';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { buildModelToolProjection } from '../server/cognition/capability_selection';
import { LEGAL_ENTRY_PREFERRED_TOOLS } from '../server/cognition/legal_entry';
const names = [...new Set([...LEGAL_ENTRY_PREFERRED_TOOLS, 'web_search', 'url_fetch', 'work_product_plan', 'work_product_verify', 'client_capability_manifest'])];
const declarations = names.map(name => ({type: 'function' as const, function: {name, description:name, parameters:{type:'object',properties:{}}}}));
function projection(text: string, forbiddenTools: string[] = []) {
 const route=routeToolsForTurn(text,declarations,{maxTools:14});
 return {route, projected:buildModelToolProjection({allowToolUse:true,baseToolPolicy:{allowedTools:names,forbiddenTools,requireConfirmation:[],maxIterations:12},toolPolicy:{allowedTools:names,forbiddenTools,requireConfirmation:[],maxIterations:12},maxIterations:12,toolRoute:route} as any,{preferredTools:LEGAL_ENTRY_PREFERRED_TOOLS})};
}
describe('public primary sources remain reachable in legal research',()=>{
 for(const text of ['请解释租赁合同的法律适用，给出可核对的官方来源；只在聊天回答。','核对法条适用日期及司法解释原文，不制作文书。','Explain the applicable legal rules and cite official sources. Do not create a document.']) {
  it('retains public search and source-body retrieval within the normal route budget: '+text,()=>{
   const {route,projected}=projection(text);
   expect(route.toolNames.length).toBeLessThanOrEqual(14);
   expect(projected.toolNames).toEqual(expect.arrayContaining(['web_search','url_fetch']));
   expect(projected.requiredToolNames).toEqual(expect.arrayContaining(['legal_search_external_authorities','web_search','url_fetch']));
   expect(projected.toolNames[0]).toBe('legal_search_external_authorities');
  });
 }
 it('preserves explicit policy denials rather than widening public access',()=>{
  const {projected}=projection('请核对法律条文和官方来源。',['web_search','url_fetch']);
  expect(projected.toolNames).not.toContain('web_search');expect(projected.toolNames).not.toContain('url_fetch');
  expect(projected.requiredToolNames).not.toContain('web_search');
 });
 it('does not add legal source requirements to ordinary conversation',()=>{
  const {route}=projection('讲一个关于春天的简短故事。');
  expect(route.requiredTools||[]).not.toContain('web_search');
 });
});
