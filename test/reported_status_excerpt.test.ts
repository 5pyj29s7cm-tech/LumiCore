import './helpers';
import { describe, expect, it } from 'vitest';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { guardCompletionClaims } from '../server/work_product/completion_guard';

describe('reported source-status text is a bounded data span', () => {
  const task = '请解释给出的材料，在聊天中回答。';
  it.each(['记录中的状态短语如下。', '手册的状态是：', 'The log status reads:'])('preserves the one explicitly labelled status line: %s', prefix => {
    const response = prefix + '\n正在执行——';
    expect(finalizeLumiResponse({ taskText: task, responseText: response, source: 'chat', toolRecords: [] })).toMatchObject({ text: response, blocked: false });
    expect(guardCompletionClaims({ task, response, toolCalls: [] })).toMatchObject({ text: response, blocked: false });
  });
  it.each(['正在执行——', '已经完成环境检查。\n正在执行——', '记录中的状态短语如下。\n示例结束。\n正在执行——'])('does not exempt an independent current execution claim: %s', response => {
    expect(finalizeLumiResponse({ taskText: '可以', responseText: response, source: 'chat', toolRecords: [] }).blocked).toBe(true);
  });
  it('still rejects a separate false save following a labelled status line', () => {
    const response = '记录中的状态短语如下。\n正在执行——\nI saved D:/fixtures/output.txt.';
    expect(finalizeLumiResponse({ taskText: task, responseText: response, source: 'chat', toolRecords: [] }).blocked).toBe(true);
    expect(guardCompletionClaims({ task, response, toolCalls: [] }).blocked).toBe(true);
  });
  it('does not complete an actual read request from quoted status text', () => {
    expect(finalizeLumiResponse({ taskText: '读取 D:/fixtures/input.txt 全文。', responseText: '记录中的状态短语如下。\n正在执行——', source: 'chat', toolRecords: [] }).blocked).toBe(true);
  });
});
