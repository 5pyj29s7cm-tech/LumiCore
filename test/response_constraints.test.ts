import { describe, expect, it } from 'vitest';
import {
  countResponseSentences,
  getExplicitSentenceCountConstraint,
  sentenceCountCorrectionInstruction,
} from '../server/cognition/response_constraints';

describe('explicit response constraints', () => {
  it('detects a missing sentence in an explicit two-sentence request', () => {
    expect(getExplicitSentenceCountConstraint(
      '请只用两句话回答：你是谁；你能如何帮助我。',
      '我是 Lumi。',
    )).toEqual({ expected: 2, actual: 1 });
  });

  it('accepts exactly two Chinese sentences', () => {
    expect(getExplicitSentenceCountConstraint(
      '总共严格两句话，不要调用工具。',
      '我是 Lumi。我能帮你处理文件和任务。',
    )).toEqual({ expected: 2, actual: 2 });
  });

  it('counts a final sentence without terminal punctuation', () => {
    expect(countResponseSentences('第一句。第二句')).toBe(2);
  });

  it('builds a bounded rewrite instruction', () => {
    expect(sentenceCountCorrectionInstruction(2)).toContain('严格为 2 句话');
  });
});
