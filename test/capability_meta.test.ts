import { describe, expect, it } from 'vitest';
import {
  buildCapabilityMetaResponse,
  isCapabilityMetaQuestion,
  isSelfIntroductionMetaQuestion,
} from '../server/cognition/capability_meta';

describe('capability access explanations', () => {
  it('answers a first-user self introduction without old-task or unverified service claims', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u5b9e\u673a\u9a8c\u6536\u00b7\u8eab\u4efd\u4e0e\u5f15\u5bfc\uff1a\u8bf7\u50cf\u7b2c\u4e00\u6b21\u9762\u5bf9\u65b0\u7528\u6237\u4e00\u6837\uff0c\u4ecb\u7ecd\u4f60\u662f\u8c01\u3001\u80fd\u505a\u4ec0\u4e48\u3001\u4e0d\u80fd\u4fdd\u8bc1\u4ec0\u4e48\u3001\u9047\u5230\u6267\u884c\u5931\u8d25\u600e\u4e48\u5904\u7406\u3002\u4e0d\u8981\u8c03\u7528\u5de5\u5177\u3002';
    expect(isSelfIntroductionMetaQuestion(text)).toBe(true);
    expect(isCapabilityMetaQuestion(text)).toBe(true);
    const response = buildCapabilityMetaResponse({ text, operationMode: 'assistant', source: 'command-center-chat' }) || '';
    expect(response).toContain('\u6211\u662f Lumi');
    expect(response).toContain('\u79c1\u6709\u5316');
    expect(response).toContain('\u8fd9\u6b21\u7eaf\u4ecb\u7ecd\u4e0d\u4f1a\u865a\u6784\u4efb\u4f55\u5df2\u8fde\u63a5\u670d\u52a1');
    expect(response).not.toContain('\u6587\u4ef6\u4efb\u52a1\u72b6\u6001');
    expect(response).not.toMatch(/\d+\s*\u4e2a(?:\u5de5\u5177|\u6280\u80fd|MCP)/u);
    expect(response.split(/\n\n/)).toHaveLength(5);
  });

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
