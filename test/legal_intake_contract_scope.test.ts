import './helpers';
import {describe,expect,it} from 'vitest';
import {buildActionContract} from '../server/cognition/action_contract';
import {isLegalEntryTurn,isRemoteLegalMessageTurn,LEGAL_ENTRY_PREFERRED_TOOLS} from '../server/cognition/legal_entry';
import {hasRequestedArtifactMutation,shouldAllowToolUseForTurn} from '../server/cognition/tool_intent';

describe('remote legal intake is discovery context rather than an implicit document order',()=>{
 it.each([
  '请解释一般法律问题并列出官方原文链接。事实仅限所给材料，直接聊天回答。',
  '请比较两个观点并提供法律来源链接; 所用材料仅限当前消息。',
  '事实仅限所给材料。请解释一般法律问题并列出官方原文链接，直接聊天回答。',
  '请讨论微信通知链接的一般法律问题，仅分析给出的材料。',
 ])('does not create a document obligation from source or remote-intake nouns: %s',text=>{
  expect(hasRequestedArtifactMutation(text)).toBe(false);
  expect(buildActionContract(text)).toMatchObject({kind:'none',applies:false});
 });
 it.each(['请根据微信发来的案件材料起草代理词。','请起草民事起诉状。'])('retains the explicit legal-document classification: %s',text=>{
  expect(hasRequestedArtifactMutation(text)).toBe(true);
  expect(buildActionContract(text)).toMatchObject({kind:'legal_document',applies:true});
 });
 it('preserves an actual remote message read instead of forcing formal drafting',()=>{
  const text='请读取微信发来的材料链接并在聊天中总结，不归档。';
  expect(isRemoteLegalMessageTurn(text)).toBe(true);
  expect(buildActionContract(text)).toMatchObject({kind:'messaging_read',applies:true});
  expect(shouldAllowToolUseForTurn(text)).toBe(true);
 });
 it('retains discovery of real remote intake and the source tools',()=>{
  const text='将微信发来的通知链接材料归档入案。';
  expect(isRemoteLegalMessageTurn(text)).toBe(true);expect(isLegalEntryTurn(text)).toBe(true);
  expect(shouldAllowToolUseForTurn(text)).toBe(true);
  expect(LEGAL_ENTRY_PREFERRED_TOOLS).toContain('legal_search_external_authorities');
  expect(LEGAL_ENTRY_PREFERRED_TOOLS).toContain('legal_message_intake_to_case');
 });
});
