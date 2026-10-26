import { describe, expect, it } from 'vitest';
import { prepareModelRequestContext, estimateModelRequestInputTokens } from '../server/llm/request_context_budget';
import { promptBlockMessage } from '../server/llm/prompt_blocks';
import type { NormalizedMessage } from '../server/llm/providers';

function continuationPressure(requiredOldSource = false) {
  const current: NormalizedMessage = { role:'user', sourceMessageId:'current-accepted-source', content:('Facts remain complete; verify the supplied sequence and sources without changing files. ').repeat(2).slice(0,166) };
  const oldCalls = [0,1].map(i => ({id:'old-observation-'+i,name:'unknown_observation',arguments:{query:'independent source '+i}}));
  const oldAssistant: NormalizedMessage = {role:'assistant',content:null,reasoningContent:'OPAQUE_UNMODIFIED_'.repeat(450),toolCalls:oldCalls};
  const oldTools: NormalizedMessage[] = oldCalls.map((call,i)=>({role:'tool',name:call.name,toolCallId:call.id,content:('原始观察正文'.repeat(950)+'SOURCE_IDENTITY_'+i+' '.repeat(4000)).slice(0,7632)}));
  const stop: NormalizedMessage = {role:'assistant',content:'The draft awaits a source check.',reasoningContent:'OPAQUE_STOP_'.repeat(1800)};
  const latestAssistant: NormalizedMessage = {role:'assistant',content:'Runtime verification.',toolCalls:[{id:'current-readback',name:'unknown_observation',arguments:{query:'one selected source section'}}]};
  const latestTool: NormalizedMessage = {role:'tool',name:'unknown_observation',toolCallId:'current-readback',content:'Selected section returned; verify against the draft.'};
  const toolDeclarations=['unknown_observation','other_read','other_inspect','other_verify'].map(name=>({type:'function' as const,function:{name,description:'原有不可裁剪的受保护工具声明'.repeat(85),parameters:{type:'object',properties:{query:{type:'string'}}}}}));
  const messages: NormalizedMessage[] = [...(requiredOldSource ? [promptBlockMessage({id:'required-sole-source',kind:'receipt',authority:'tool',required:true,content:'必须保留的唯一原始来源正文'.repeat(1100)})] : []),promptBlockMessage({id:'current-authorization',kind:'authorization',authority:'server',required:true,content:'AUTHORIZATION '.repeat(1100)}),current,oldAssistant,...oldTools,stop,latestAssistant,latestTool];
  return {input:{messages,toolDeclarations,protectedToolNames:toolDeclarations.map(tool=>tool.function.name),inputTokenBudget:24000,preserveAssistantReasoning:true},current,oldAssistant,oldTools,stop,latestAssistant,latestTool};
}

describe('consumed tool continuation budget',()=>{
  it('keeps the latest complete protocol and accepted input while selecting consumed batches atomically at 24k',()=>{
    const fixture=continuationPressure();
    const prepared=prepareModelRequestContext(fixture.input);
    expect(prepared.messages.find(message=>message.sourceMessageId===fixture.current.sourceMessageId)).toEqual(fixture.current);
    expect(prepared.messages.find(message=>message.toolCalls?.[0]?.id==='current-readback')).toEqual(fixture.latestAssistant);
    expect(prepared.messages.find(message=>message.toolCallId==='current-readback')).toEqual(fixture.latestTool);
    const oldPresent=prepared.messages.filter(message=>message===fixture.oldAssistant || message.toolCalls?.[0]?.id==='old-observation-0' || fixture.oldTools.some(tool=>tool.toolCallId===message.toolCallId));
    expect(oldPresent.length).toBe(0);
    expect(prepared.toolDeclarations.map(tool=>tool.function.name)).toEqual(fixture.input.protectedToolNames);
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(24000);
    expect(estimateModelRequestInputTokens(prepared.messages,prepared.toolDeclarations)).toBe(prepared.estimatedInputTokens);
    expect(fixture.input.messages).toContain(fixture.stop);
    expect(fixture.oldAssistant.reasoningContent).toBe('OPAQUE_UNMODIFIED_'.repeat(450));
    expect(fixture.stop.reasoningContent).toBe('OPAQUE_STOP_'.repeat(1800));
  });
  it('does not reactivate a consumed source batch when a real server receipt follows the exact stopped draft',()=>{
    const fixture=continuationPressure();
    const selected=promptBlockMessage({id:'current-selected-original',kind:'receipt',authority:'server',required:true,
      content:'Actual selected original; source identity fixture-42, version 2085-03-02, https://authority.invalid/42. '+ '原文数据'.repeat(375)});
    fixture.input.messages=fixture.input.messages.filter(message=>message!==fixture.latestAssistant && message!==fixture.latestTool);
    fixture.input.messages.push(selected);
    const prepared=prepareModelRequestContext(fixture.input);
    expect(prepared.messages.find(message=>message.sourceMessageId===fixture.current.sourceMessageId)).toEqual(fixture.current);
    expect(prepared.messages.find(message=>message.promptBlock?.id==='current-selected-original')).toEqual(selected);
    expect(prepared.messages.some(message=>message.toolCalls?.[0]?.id==='old-observation-0' || fixture.oldTools.some(tool=>tool.toolCallId===message.toolCallId))).toBe(false);
    expect(prepared.messages.find(message=>message.reasoningContent===fixture.stop.reasoningContent)).toEqual(fixture.stop);
    expect(prepared.toolDeclarations.map(tool=>tool.function.name)).toEqual(fixture.input.protectedToolNames);
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(24000);
  });
  it('keeps the only required original source in full ahead of optional consumed batches',()=>{
    const fixture=continuationPressure(true);
    const prepared=prepareModelRequestContext(fixture.input);
    expect(prepared.messages.find(message=>message.promptBlock?.id==='required-sole-source')).toEqual(fixture.input.messages[0]);
    expect(prepared.messages.find(message=>message.toolCallId==='current-readback')).toEqual(fixture.latestTool);
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(24000);
  });
  it('still fails when the required original source and current protocol cannot fit together',()=>{
    const fixture=continuationPressure(true);
    const block=fixture.input.messages[0].promptBlock!;
    fixture.input.messages[0]=promptBlockMessage({...block,content:block.content.repeat(2)});
    expect(()=>prepareModelRequestContext(fixture.input)).toThrow(/protected|complete assistant tool_call/);
  });
  it('never clips a stopped assistant message while retaining its opaque reasoning',()=>{
    const fixture=continuationPressure();fixture.stop.content='An exact signed provider draft. '.repeat(2000);
    const prepared=prepareModelRequestContext(fixture.input);
    const retained=prepared.messages.find(message=>message.reasoningContent===fixture.stop.reasoningContent);
    if(retained)expect(retained).toEqual(fixture.stop);
    expect(fixture.stop.reasoningContent).toBe('OPAQUE_STOP_'.repeat(1800));
  });
  it('retains every complete batch unchanged when capacity permits',()=>{
    const fixture=continuationPressure();
    const prepared=prepareModelRequestContext({...fixture.input,inputTokenBudget:64000});
    expect(prepared.messages.filter(message=>message.role==='tool')).toEqual([...fixture.oldTools,fixture.latestTool]);
    expect(prepared.messages.find(message=>message.toolCalls?.[0]?.id==='old-observation-0')).toEqual(fixture.oldAssistant);
  });
});


describe('assistant-scoped tool call identifiers', () => {
  function repeatedBatchMessages(): NormalizedMessage[] {
    return [
      { role: 'user', sourceMessageId: 'current-accepted-source', content: 'Compare the two supplied observations. No file changes. 未知仍未知，不改动资料。' },
      { role: 'assistant', content: null, reasoningContent: 'SYNTHETIC_OPAQUE_FIRST', toolCalls: [
        { id: 'read:0', name: 'unknown_read', arguments: { query: 'first source' } },
        { id: 'read:1', name: 'unknown_read', arguments: { query: 'second source' } },
      ] },
      { role: 'tool', name: 'unknown_read', toolCallId: 'read:1', content: 'SOURCE_B version=2092-03-04 https://authority.invalid/b full second observation' },
      { role: 'tool', name: 'unknown_read', toolCallId: 'read:0', content: 'SOURCE_A version=2091-01-02 https://authority.invalid/a full first observation' },
      { role: 'assistant', content: null, reasoningContent: 'SYNTHETIC_OPAQUE_SECOND', toolCalls: [
        { id: 'read:0', name: 'unknown_read', arguments: { query: 'third source' } },
        { id: 'read:1', name: 'unknown_read', arguments: { query: 'fourth source' } },
      ] },
      { role: 'tool', name: 'unknown_read', toolCallId: 'read:0', content: 'SOURCE_C version=2093-05-06 https://authority.invalid/c distinct third observation' },
      { role: 'tool', name: 'unknown_read', toolCallId: 'read:1', content: 'SOURCE_D version=2094-07-08 https://authority.invalid/d distinct fourth observation' },
    ];
  }
  function prepare(messages: NormalizedMessage[], preserveAssistantReasoning = true) {
    return prepareModelRequestContext({ messages, toolDeclarations: [], inputTokenBudget: 64000,
      preserveAssistantReasoning, atomicToolProtocol: !preserveAssistantReasoning });
  }
  it.each([true, false])('retains independently paired batches with reused IDs and all original data (opaque=%s)', preserve => {
    const messages = repeatedBatchMessages();
    const before = JSON.stringify(messages);
    const result = prepare(messages, preserve);
    expect(result.messages).toEqual(messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(result.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual(messages.filter(message => message.role === 'tool').map(message => message.content));
  });
  it('drops a consumed batch atomically without confusing its reused ID with the latest result', () => {
    const fixture = continuationPressure();
    fixture.latestAssistant.toolCalls![0].id = 'old-observation-0';
    fixture.latestTool.toolCallId = 'old-observation-0';
    const result = prepareModelRequestContext(fixture.input);
    expect(result.messages.find(message => message.sourceMessageId === fixture.current.sourceMessageId)).toEqual(fixture.current);
    expect(result.messages.filter(message => message.role === 'tool')).toEqual([fixture.latestTool]);
    expect(result.messages.filter(message => message.toolCalls?.length)).toEqual([fixture.latestAssistant]);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(24000);
  });
  it('still rejects two equal IDs within one assistant batch', () => {
    const messages = repeatedBatchMessages();
    messages[1].toolCalls![1].id = 'read:0';
    expect(() => prepare(messages)).toThrow(/malformed assistant tool_call batch/);
  });
  it('still rejects missing IDs within a batch', () => {
    const messages = repeatedBatchMessages();
    messages[4].toolCalls![1].id = '';
    expect(() => prepare(messages)).toThrow(/malformed assistant tool_call batch/);
  });
  it('does not use a later reused-ID receipt to satisfy an incomplete earlier batch', () => {
    const messages = repeatedBatchMessages();
    messages.splice(3, 1);
    expect(() => prepare(messages)).toThrow(/incomplete tool continuation/);
  });
  it('does not pair an old ID with an unrelated later assistant batch', () => {
    const messages = repeatedBatchMessages();
    messages[4].toolCalls = [{ id: 'different-call', name: 'unknown_read', arguments: {} }];
    expect(() => prepare(messages)).toThrow(/orphan or duplicate tool receipt/);
  });
  it('still rejects duplicate results inside a batch', () => {
    const messages = repeatedBatchMessages();
    messages[6].toolCallId = 'read:0';
    expect(() => prepare(messages)).toThrow(/orphan or duplicate tool receipt/);
  });
  it('does not accept an outstanding old call after a new user boundary', () => {
    const messages = repeatedBatchMessages().slice(0, 4);
    messages.splice(3, 0, { role: 'user', content: 'A different user turn.' });
    expect(() => prepare(messages)).toThrow(/orphan or duplicate tool receipt/);
  });
});
