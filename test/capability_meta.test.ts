import { describe, expect, it } from 'vitest';
import {
  buildCapabilityMetaResponse,
  isCapabilityMetaQuestion,
} from '../server/cognition/capability_meta';

describe('capability access explanations', () => {
  it.each([
    '\u4f60\u73b0\u5728\u4e0d\u662f\u52a9\u624b\u6a21\u5f0f\u5417',
    '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
    '\u5f53\u524d\u4f1a\u8bdd\u662f\u4e0d\u662f\u53ea\u6302\u8f7d\u4e86\u4e24\u4e2a\u5de5\u5177',
    'How can I make Lumi use other tools?',
  ])('recognizes a conceptual question without treating it as work: %s', (text) => {
    expect(isCapabilityMetaQuestion(text)).toBe(true);
  });

  it.each([
    '\u67e5\u4e00\u4e0b\u8bb0\u5fc6\u5e93\u91cc\u6709\u6ca1\u6709\u5f20\u52c7\u7684\u4fe1\u606f',
    '\u7528\u8bb0\u5fc6\u68c0\u7d22\u5de5\u5177\u67e5\u4e00\u4e0b\u9879\u76ee\u8bb0\u5f55',
    '\u4e3a\u4ec0\u4e48\u521a\u624d\u6ca1\u6709\u8c03\u7528\u8bb0\u5fc6\u5de5\u5177',
  ])('does not consume real actions or prior-turn corrections: %s', (text) => {
    expect(isCapabilityMetaQuestion(text)).toBe(false);
  });

  it('explains the integrated command-center entry and per-turn routing truth', () => {
    const response = buildCapabilityMetaResponse({
      text: '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
      operationMode: 'assistant',
      source: 'command-center-chat',
    });

    expect(response).toContain('\u5df2\u7ecf\u662f\u52a9\u624b\u6a21\u5f0f');
    expect(response).toContain('\u552f\u4e00\u7684\u6587\u5b57\u5165\u53e3');
    expect(response).toContain('\u6bcf\u8f6e\u53ea\u9009\u51fa');
    expect(response).toContain('\u8def\u7531\u95ee\u9898');
    expect(response).not.toContain('\u53bb\u6307\u6325\u4e2d\u5fc3');
  });
});
