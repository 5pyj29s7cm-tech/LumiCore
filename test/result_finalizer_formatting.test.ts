import './helpers';
import { describe, expect, it } from 'vitest';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { LumiTurnFlow } from '../server/cognition/turn_flow';

const flow = { effectiveOperationMode: 'assistant' } as LumiTurnFlow;

function finalize(text: string) {
  return finalizeLumiResponse({
    taskText: '请按现有数据说明明细，保留原来的排版。',
    responseText: text,
    source: 'chat',
    flow,
    toolRecords: [{
      name: 'read_file',
      arguments: { path: 'C:/synthetic/LC-FORMATTING.csv' },
      result: '商品,数量,单价\n水杯,2,12\n笔记本,3,8\n',
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'The synthetic read returned.' },
    }],
  });
}

describe('result finalizer preserves layout while correcting operation-mode claims', () => {
  it.each([
    ['Markdown table', '**工作表：订单**\n\n| 商品 | 数量 | 单价 | 金额 |\n|---|---|---|---|\n| 水杯 | 2 | 12 | 24 |\n| 笔记本 | 3 | 8 | 24 |'],
    ['calculation list', '计算如下：\n\n- 水杯：4 × 12 = 48 元\n- 笔记本：3 × 8 = 24 元\n- 贴纸：4 × 3 = 12 元\n\n总额：84 元。'],
    ['CRLF and code fence', '字段示例：\r\n\r\n```json\r\n{\r\n  "amount": 12.5,\r\n  "filename": "orders.v2.csv"\r\n}\r\n```'],
    ['punctuation-only lines', '金额为 12.5。\n\n...\n\n**说明**\n- 保留原文！！'],
  ])('preserves %s when there is no contradictory claim', (_label, text) => {
    const result = finalize(text);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(text);
  });

  it('removes a contradictory current-mode sentence without joining the remaining table rows', () => {
    const table = '**订单**\n\n| 商品 | 金额 |\n|---|---|\n| 水杯 | 24 |';
    const result = finalize(`我当前聊天模式。\n\n${table}`);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(table);
    expect(result.text).not.toContain('聊天模式');
  });

  it('removes an already-satisfied switch prerequisite while retaining separate list items', () => {
    const list = '- 水杯：24 元\n- 笔记本：24 元';
    const result = finalize(`需要先切换到助手模式。\n\n${list}`);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(list);
  });

  it('retains a true mode statement and its paragraph boundaries', () => {
    const text = '我当前助手模式。\n\n金额明细：\n- 水杯：24 元\n- 笔记本：24 元';
    const result = finalize(text);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(text);
  });

  it('keeps surrounding paragraphs when a contradictory sentence is removed from the middle', () => {
    const result = finalize('商品明细：\n- 水杯：24 元\n\n我当前聊天模式。\n\n说明：金额按数量乘单价计算。');
    expect(result.blocked).toBe(false);
    expect(result.text).toBe('商品明细：\n- 水杯：24 元\n\n\n\n说明：金额按数量乘单价计算。');
  });
});
