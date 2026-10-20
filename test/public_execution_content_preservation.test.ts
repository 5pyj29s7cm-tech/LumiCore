import {describe,expect,it} from 'vitest';
import {containsInternalExecutionLanguage,sanitizePublicExecutionText} from '../shared/public_execution_language';
import {sanitizeUserFacingExecutionOutput} from '../server/cognition/user_output_protection';
import {finalizeLumiResponse} from '../server/cognition/result_finalizer';
import {normalizeChatHistoryRecord} from '../server/socket/chat/history';
import {normalizeVoiceHistoryRecord} from '../server/socket/voice_history';
import {sanitizeAgentResponseTextForDisplay} from '../src/lib/agentResponseDelivery';

// Four public fields from the saved official registration source, not a new network query.
const registration='企业名称：企查查科技股份有限公司；登记状态：在业；成立日期：2014-03-12；注册资本：36225万元。\n来源：企查查官方MCP；查询时间：2026-10-20T22:26:27.226Z。';
const projectors=[sanitizePublicExecutionText,sanitizeUserFacingExecutionOutput];
describe('public execution projection preserves delivered business content',()=>{
 it.each(['真实回执','执行回执','工具回执','终态回执','回读回执','验收回执'])('does not treat ordinary %s vocabulary as a failure verdict',word=>{
  const text='已取得'+word+'。\n'+registration;
  expect(containsInternalExecutionLanguage(text)).toBe(false);
  for(const project of projectors)expect(project(text)).toBe(text);
 });
 it('keeps the same source facts at frontend display and both chat and voice history boundaries',()=>{
  const text='已取得真实回执。\n'+registration;
  expect(sanitizeAgentResponseTextForDisplay(text,'zh')).toBe(text);
  for(const normalize of [normalizeChatHistoryRecord,normalizeVoiceHistoryRecord])expect(normalize({role:'assistant',message:text})).toEqual([{role:'assistant',content:text}]);
 });
 it('removes only an internal instruction sentence beside the source facts',()=>{
  const text='企业名称：企查查科技股份有限公司。Lumi must resume the real tool route. 登记状态：在业；成立日期：2014-03-12；注册资本：36225万元。';
  for(const project of projectors){const actual=project(text);expect(actual).toContain('企业名称：企查查科技股份有限公司');expect(actual).toContain('登记状态：在业');expect(actual).toContain('成立日期：2014-03-12');expect(actual).toContain('注册资本：36225万元');expect(actual).not.toMatch(/Lumi must|tool route|没有完成|没有拿到/u);}
 });
 it('keeps original evidence facts when removing an internal report label',()=>{
  const text='证据：付款回单仅有复印件，原件尚未核验。\n'+registration;
  for(const project of projectors){const actual=project(text);expect(actual).toContain('付款回单仅有复印件，原件尚未核验');expect(actual).toContain(registration);expect(actual).not.toMatch(/没有完成|证据：/u);}
 });
 it('removes a complete tool-protocol fragment without losing surrounding results',()=>{
  const text=registration+'\n<tool_calls><invoke name="desktop_open"><parameter name="task">Do not show this raw instruction</parameter></invoke></tool_calls>\n公司信息仅证明本次工商查询。';
  for(const project of projectors){const actual=project(text);expect(actual).toContain(registration);expect(actual).toContain('公司信息仅证明本次工商查询');expect(actual).not.toMatch(/tool_calls|invoke|parameter|desktop_open|raw instruction|没有完成/u);}
 });
 it('keeps a natural real failure unchanged and does not convert it to success',()=>{
  const text='本次查询返回401，未取得企业登记信息。不能据此判断该企业不存在。';
  for(const project of projectors)expect(project(text)).toBe(text);
 });
 it('retains a concrete failed terminal state alongside a partial success',()=>{
  const text='文件已保存。\nStatus: failed.\nEvidence: Desktop execution ended as target_mismatch.';
  for(const project of projectors){const actual=project(text);expect(actual).toContain('文件已保存');expect(actual).toMatch(/没有完成|不一致|did not finish|no longer matched/iu);expect(actual).not.toMatch(/Status:|Evidence:|target_mismatch/u);}
 });
 it('does not turn a bare unproved internal completed label into a new completion claim',()=>{
  for(const project of projectors)expect(project('Status: completed.')).not.toMatch(/已经完成|This step is complete|successfully/iu);
 });
 it('removes the old unsupported tools-disabled and category-switch directives rather than presenting them as facts',()=>{
  const directive='本轮没有真实回执证明“工具没打开”，也不存在需要你切换的“工具可用模式”。如果任务没有执行，Lumi 应该继续真实工具链，不能把内部路由问题推给你。';
  for(const project of projectors){const actual=project(directive+'\n'+registration);expect(actual).toContain(registration);expect(actual).not.toMatch(/工具没打开|工具可用模式|Lumi 应该|内部路由|没有完成/u);}
 });
 it('still strips raw legacy confirmation parameters while retaining the result before the dump',()=>{
  const text=registration+'\n\n这项操作还没有执行，需要你确认后才能继续。\n操作：computer_use\n参数：{"task":"wait for next model instruction","max_steps":20}';
  for(const project of projectors){const actual=project(text);expect(actual).toContain(registration);expect(actual).not.toMatch(/computer_use|max_steps|next model instruction/u);}
 });
 it('does not let display preservation create verified company completion without a current source receipt',()=>{
  const result=finalizeLumiResponse({taskText:'通过企查查查询该公司的工商登记信息。',responseText:'已查询到工商登记信息。\n'+registration,toolRecords:[],taskId:'missing-source-task',requestId:'missing-source-request',source:'chat'});
  expect(result.blocked).toBe(true);
 });
});
