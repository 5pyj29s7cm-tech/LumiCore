import { describe, expect, it } from 'vitest';
import {
  estimateLocalRequestInputTokens,
  LocalModelContextBudgetError,
  prepareLocalModelRequest,
} from '../server/llm/local_context_budget';

const tools = [{
  type: 'function' as const,
  function: {
    name: 'desktop_open',
    description: 'Open an exact local target and return verified foreground state.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
  },
}];

describe('local model context budget', () => {
  it('compacts a production-sized history below a 4096-token local context', () => {
    const newest = '\u73b0\u5728\u5c31\u7528\u5de5\u5177\u6253\u5f00\u684c\u9762\u4e0a\u7684\u5ba2\u6237\u65b9\u6848\u3002';
    const messages: any[] = [
      { role: 'system', content: `Safety and execution policy\n${'policy boundary '.repeat(2_000)}` },
      ...Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `old turn ${index} ${'historical details '.repeat(260)}`,
      })),
      { role: 'user', content: newest },
    ];

    const prepared = prepareLocalModelRequest({
      messages,
      toolDeclarations: tools,
      maxTokens: 8_000,
      contextTokens: 4_096,
    });

    expect(prepared.compacted).toBe(true);
    expect(prepared.maxTokens).toBeLessThanOrEqual(1_024);
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(prepared.inputBudgetTokens);
    expect(estimateLocalRequestInputTokens(prepared.messages, tools)).toBe(prepared.estimatedInputTokens);
    expect(prepared.messages.some(message => message.role === 'user' && String(message.content).includes(newest))).toBe(true);
    expect(prepared.messages.some(message => message.role === 'system')).toBe(true);
  });

  it('fails before contacting the runtime when tool schemas alone exceed the context', () => {
    const oversizedTools = [{
      ...tools[0],
      function: { ...tools[0].function, description: 'schema '.repeat(8_000) },
    }];
    expect(() => prepareLocalModelRequest({
      messages: [{ role: 'user', content: 'hello' }],
      toolDeclarations: oversizedTools,
      contextTokens: 4_096,
    })).toThrow(LocalModelContextBudgetError);
  });
});
