import './helpers';
import { describe, expect, it } from 'vitest';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';

describe('factual restatements do not invent calendar work', () => {
  it('retains the factual restatement while removing an unrequested scheduling tail', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: '现在完整说出明天这件事。',
      responseText: '明天去客户办公室，讨论交付范围。就在日程里记着了，到时候我提醒你。', toolRecords: [] });
    expect(result).toMatchObject({ blocked: false, text: '明天去客户办公室，讨论交付范围。' });
  });
  it('does not turn an entirely fabricated reminder into an empty successful answer', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: '现在完整说出明天这件事。',
      responseText: '就在日程里记着了，到时候我提醒你。', toolRecords: [] });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('没有记录到提醒');
  });
  it.each([
    '原话是“到时候我提醒你”，这不是已经设置的提醒。',
    '如果你确认，到时候我提醒你。',
    '没有在日程里记下，也没有设置提醒。',
  ])('preserves quoted, conditional or negative descriptions: %s', responseText => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: '复述刚才的原话。', responseText, toolRecords: [] });
    expect(result).toMatchObject({ blocked: false, text: responseText });
  });
  it('does not apply the factual-restatement correction to fictional dialogue', () => {
    const responseText = '小船长说：到时候我提醒你。';
    expect(finalizeLumiResponse({ source: 'chat', taskText: '写一句童话人物的台词。', responseText, toolRecords: [] }))
      .toMatchObject({ blocked: false, text: responseText });
  });
});
