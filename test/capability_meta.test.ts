import { describe, expect, it } from 'vitest';
import {
  buildCapabilityMetaResponse,
  buildOperationModeMetaResponse,
  isCapabilityMetaQuestion,
  isCurrentOperationModeQuestion,
  isOperationModeInventoryQuestion,
  isSelfIntroductionMetaQuestion,
} from '../server/cognition/capability_meta';

describe('capability access explanations', () => {
  it.each([
    '\u4f60\u6709\u591a\u5c11\u79cd\u6a21\u5f0f',
    '\u4f60\u6709\u51e0\u79cd\u6a21\u5f0f',
    '\u6709\u54ea\u4e9b\u6a21\u5f0f',
    '\u6a21\u5f0f\u6709\u591a\u5c11\u79cd',
    '\u8bf7\u5217\u51fa\u6240\u6709\u6a21\u5f0f',
    '\u6211\u4eec\u4e0d\u662f\u53ea\u6709\u4e09\u4e2a\u6a21\u5f0f\u5417',
    '\u4f60\u8bf4\u7684\u4e03\u79cd\u6a21\u5f0f\u5bf9\u5417',
    '\u4e09\u4e2a\u6a21\u5f0f\u5206\u522b\u662f\u4ec0\u4e48',
    'How many modes do you have?',
  ])('answers operation-mode inventory from the canonical three-mode taxonomy: %s', (text) => {
    expect(isOperationModeInventoryQuestion(text)).toBe(true);
    expect(isCapabilityMetaQuestion(text)).toBe(true);
    const response = buildOperationModeMetaResponse({ text, operationMode: 'assistant' }) || '';
    expect(response).toMatch(/(?:3 \u79cd|exactly 3)/i);
    expect(response).toContain('chat');
    expect(response).toContain('assistant');
    expect(response).toContain('autonomous');
    expect(response).toContain('meeting');
    expect(response).not.toMatch(/scholar|office|mentor|celebrate|companion|founder|comfort/i);
    expect(response).not.toContain('client.modes');
  });

  it.each([
    '\u4f60\u73b0\u5728\u662f\u4ec0\u4e48\u6a21\u5f0f',
    '\u4f60\u73b0\u5728\u4e0d\u662f\u52a9\u624b\u6a21\u5f0f\u5417',
    '\u662f\u52a9\u624b\u6a21\u5f0f\u5417',
    '\u4f60\u5f53\u524d\u6a21\u5f0f\u662f\u4ec0\u4e48',
    '\u5f53\u524d\u6a21\u5f0f\u662f\u4ec0\u4e48',
  ])('answers the persisted current operation mode without inventing a client-state read: %s', (text) => {
    expect(isCurrentOperationModeQuestion(text)).toBe(true);
    expect(isOperationModeInventoryQuestion(text)).toBe(false);
    const response = buildOperationModeMetaResponse({ text, operationMode: 'assistant' }) || '';
    expect(response).toContain('assistant');
    expect(response).not.toMatch(/\u5df2\u9a8c\u8bc1|\u5df2\u8bfb\u53d6|client\.modes/u);
  });

  it.each([
    '\u5207\u6362\u5230\u81ea\u4e3b\u6a21\u5f0f',
    '\u6253\u5f00\u6df1\u8272\u6a21\u5f0f',
    '\u6df1\u8272\u6a21\u5f0f\u662f\u4ec0\u4e48',
  ])('does not consume a mode action or unrelated UI mode as taxonomy meta: %s', (text) => {
    expect(isOperationModeInventoryQuestion(text)).toBe(false);
    expect(isCurrentOperationModeQuestion(text)).toBe(false);
    expect(buildOperationModeMetaResponse({ text, operationMode: 'assistant' })).toBeNull();
  });

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
    '如何使用桌面工具打开记事本？',
    'How can I use desktop tools to open Notepad?',
  ])('recognizes a conceptual question without treating it as work: %s', (text) => {
    expect(isCapabilityMetaQuestion(text)).toBe(true);
  });

  it.each([
    '你能不能使用桌面工具打开记事本？现在打开它。',
    'Can you use desktop tools to open Notepad? Open it now.',
    '介绍一下你自己并演示桌面操作。',
  ])('does not consume a concrete immediate action as capability meta: %s', (text) => {
    expect(isCapabilityMetaQuestion(text)).toBe(false);
    expect(buildCapabilityMetaResponse({ text, operationMode: 'assistant' })).toBeNull();
  });

  it.each([
    '\u67e5\u4e00\u4e0b\u8bb0\u5fc6\u5e93\u91cc\u6709\u6ca1\u6709\u5f20\u52c7\u7684\u4fe1\u606f',
    '\u7528\u8bb0\u5fc6\u68c0\u7d22\u5de5\u5177\u67e5\u4e00\u4e0b\u9879\u76ee\u8bb0\u5f55',
    '\u4e3a\u4ec0\u4e48\u521a\u624d\u6ca1\u6709\u8c03\u7528\u8bb0\u5fc6\u5de5\u5177',
    '\u610f\u56fe\u8bc6\u522b\u9a8c\u6536\uff1a\u4e0d\u8981\u6253\u5f00\u8ba1\u7b97\u5668\uff0c\u4e0d\u8981\u542f\u52a8\u4efb\u4f55\u5e94\u7528\uff0c\u4e5f\u4e0d\u8981\u8c03\u7528\u5de5\u5177\u3002\u4f60\u53ea\u9700\u8bf4\u660e\uff1a\u5982\u679c\u6211\u672a\u6765\u660e\u786e\u8981\u6c42\u6253\u5f00\u8ba1\u7b97\u5668\uff0c\u4f60\u4f1a\u600e\u4e48\u6267\u884c\u548c\u6838\u9a8c\uff1b\u54ea\u4e9b\u9ad8\u5f71\u54cd\u52a8\u4f5c\u4ecd\u9700\u786e\u8ba4\u3002\u6700\u540e\u660e\u786e\u5199\u51fa\u672c\u8f6e\u662f\u5426\u6267\u884c\u4e86\u4efb\u4f55\u52a8\u4f5c\u3002',
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
