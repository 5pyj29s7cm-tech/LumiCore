import './helpers';
import { describe, expect, it } from 'vitest';
import { resolveExactConversationCorrection } from '../server/conversation/exact_correction';

describe('exact conversation correction', () => {
  it('never rewrites a prior command instead of executing a file edit', () => {
    const task = '把刚才报表的 B类数量改成6，其余不变，另存到 D:/LumiCore-Audit-Reports/采购报表_更新.xlsx，检查公式和图表，并告诉我新总金额。';
    expect(resolveExactConversationCorrection(task, [{ role: 'user', message: task }])).toBeNull();
    expect(resolveExactConversationCorrection('将周三改为周四，其余内容不变', [
      { role: 'assistant', message: '会议时间是周三。' },
      { role: 'user', message: '将周三改为周四，其余内容不变' },
    ])).toBe('会议时间是周四。');
  });
  it('repeats only the immediately preceding assistant reply after a delivery stall', () => {
    expect(resolveExactConversationCorrection(
      'sorry, 你刚刚又卡住了，重新说。',
      [
        { role: 'assistant', message: '旧任务需要整理客户资料。' },
        { role: 'user', message: '你是谁？' },
        { role: 'assistant', message: '我是 Lumi，是你的常驻智能伙伴。' },
      ],
    )).toBe('我是 Lumi，是你的常驻智能伙伴。');

    expect(resolveExactConversationCorrection(
      'repeat that',
      [
        { role: 'assistant', message: 'Older answer.' },
        { role: 'user', message: 'Who are you?' },
        { role: 'assistant', message: 'I am Lumi, your persistent AI partner.' },
      ],
    )).toBe('I am Lumi, your persistent AI partner.');
  });

  it('changes only the requested phrase in the latest matching factual sentence', () => {
    const result = resolveExactConversationCorrection(
      '把“售后责任”改成“数据归属”，其他不变。',
      [
        { role: 'user', message: '明天去看硬件社区合作，重点问交付方式和售后责任。' },
        { role: 'assistant', message: '你明天的安排是去看硬件社区合作，要重点问清楚交付方式和售后责任。我记住了，不动手做计划。' },
      ],
    );

    expect(result).toBe('你明天的安排是去看硬件社区合作，要重点问清楚交付方式和数据归属。');
    expect(result).toContain('交付方式');
    expect(result).not.toContain('交货方式');
  });

  it('supports unquoted replacement language while preserving the rest', () => {
    expect(resolveExactConversationCorrection(
      '将周三改为周四，其余内容不变',
      [{ role: 'assistant', message: '会议时间是周三，地点是园区会议室。' }],
    )).toBe('会议时间是周四，地点是园区会议室。');
  });

  it('does not intercept an ordinary edit command without an exact-preservation cue', () => {
    expect(resolveExactConversationCorrection(
      '把合同里的甲方名称改成灵序科技',
      [{ role: 'assistant', message: '合同里的甲方名称需要核对。' }],
    )).toBeNull();
  });

  it('returns null when the original phrase is not in conversation history', () => {
    expect(resolveExactConversationCorrection(
      '把“售后责任”改成“数据归属”，其他不变。',
      [{ role: 'assistant', message: '明天去园区。' }],
    )).toBeNull();
  });
});
