import { describe, expect, it } from 'vitest';
import {
  estimateLocalRequestInputTokens,
  LocalModelContextBudgetError,
  prepareLocalModelRequest,
} from '../server/llm/local_context_budget';
import { ModelRequestSourceProvenanceError } from '../server/llm/request_context_budget';

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

  it('projects a 4096-token local attempt without dropping required or discovery schemas', () => {
    const routedTools = [
      'read_file',
      ...Array.from({ length: 10 }, (_, index) => `optional_${index}`),
      'required_tail_tool',
      'client_capability_manifest',
    ].map((name, index) => ({
      type: 'function' as const,
      function: {
        name,
        description: `${name} routed schema ${'bounded detail '.repeat(55 + (index % 3) * 8)}`,
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: `${name} exact target ${'field '.repeat(20)}` },
          },
          required: ['target'],
        },
      },
    }));
    const originalNames = routedTools.map(tool => tool.function.name);

    const prepared = prepareLocalModelRequest({
      messages: [
        { role: 'system', content: 'Keep the accepted task and real tool receipt aligned.' },
        { role: 'user', content: 'Use required_tail_tool after the actual file receipt is available.' },
      ],
      toolDeclarations: routedTools,
      maxTokens: 768,
      contextTokens: 4_096,
      compactToolDeclarations: true,
      requiredToolNames: ['read_file', 'required_tail_tool', 'client_capability_manifest'],
    });

    const projectedNames = prepared.toolDeclarations.map(tool => tool.function.name);
    expect(prepared.contextTokens).toBe(4_096);
    expect(prepared.toolDeclarationsCompacted).toBe(true);
    expect(projectedNames.length).toBeLessThan(originalNames.length);
    expect(projectedNames).toEqual(originalNames.filter(name => projectedNames.includes(name)));
    expect(projectedNames).toEqual(expect.arrayContaining([
      'read_file',
      'required_tail_tool',
      'client_capability_manifest',
    ]));
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(prepared.inputBudgetTokens);
  });

  it('fails closed when required tools and accepted messages cannot share a 4096-token context', () => {
    const requiredTools = ['read_file', 'required_tail_tool', 'client_capability_manifest']
      .map(name => ({
        type: 'function' as const,
        function: {
          name,
          description: `${name} ${'required schema detail '.repeat(260)}`,
          parameters: { type: 'object', properties: {} },
        },
      }));

    expect(() => prepareLocalModelRequest({
      messages: [{ role: 'user', content: 'Retain this accepted task.' }],
      toolDeclarations: requiredTools,
      contextTokens: 4_096,
      compactToolDeclarations: true,
      requiredToolNames: requiredTools.map(tool => tool.function.name),
    })).toThrow(/required tool declarations.*leaving too little room/i);
  });

  it('retains an accepted source and a complete multi-tool continuation as one atomic boundary', () => {
    const sourceMessageId = 'local-multi-tool-source';
    const toolCalls = [
      { id: 'local-call-a', name: 'read_file', arguments: { path: 'A.txt' } },
      { id: 'local-call-b', name: 'read_file', arguments: { path: 'B.txt' } },
    ];
    const prepared = prepareLocalModelRequest({
      messages: [
        { role: 'system', content: `Safety boundary ${'large policy '.repeat(2_000)}` },
        {
          role: 'user',
          content: 'ACCEPTED_MULTI_TOOL_SOURCE read both exact fixtures.',
          sourceMessageId,
        },
        { role: 'assistant', content: null, toolCalls },
        {
          role: 'tool',
          content: 'MULTI_TOOL_RECEIPT_A exact result A',
          toolCallId: 'local-call-a',
          name: 'read_file',
        },
        {
          role: 'tool',
          content: 'MULTI_TOOL_RECEIPT_B exact result B',
          toolCallId: 'local-call-b',
          name: 'read_file',
        },
      ] as any[],
      toolDeclarations: tools,
      contextTokens: 4_096,
      compactToolDeclarations: true,
      requiredToolNames: ['read_file'],
    });

    const source = prepared.messages.find(message => message.sourceMessageId === sourceMessageId);
    const assistant = prepared.messages.find(message => message.role === 'assistant');
    const receipts = prepared.messages.filter(message => message.role === 'tool');
    expect(String(source?.content)).toContain('ACCEPTED_MULTI_TOOL_SOURCE');
    expect(assistant?.toolCalls).toEqual(toolCalls);
    expect(receipts.map(message => message.toolCallId)).toEqual(['local-call-a', 'local-call-b']);
    expect(receipts.map(message => message.content)).toEqual([
      'MULTI_TOOL_RECEIPT_A exact result A',
      'MULTI_TOOL_RECEIPT_B exact result B',
    ]);
    expect(prepared.messages.indexOf(assistant!)).toBeLessThan(prepared.messages.indexOf(receipts[0]));
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(prepared.inputBudgetTokens);
  });

  it('fails closed instead of degrading an orphan tool receipt into a user message', () => {
    expect(() => prepareLocalModelRequest({
      messages: [
        { role: 'user', content: 'Accepted source.' },
        { role: 'tool', content: 'orphan receipt', toolCallId: 'orphan-call', name: 'read_file' },
      ] as any[],
      toolDeclarations: tools,
      contextTokens: 4_096,
      compactToolDeclarations: true,
    })).toThrow(/orphan.*tool receipt/i);
  });

  it('fails closed when any call in a multi-tool batch lacks its receipt', () => {
    expect(() => prepareLocalModelRequest({
      messages: [
        { role: 'user', content: 'Accepted source.' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'complete-call', name: 'read_file', arguments: { path: 'A.txt' } },
            { id: 'missing-call', name: 'read_file', arguments: { path: 'B.txt' } },
          ],
        },
        {
          role: 'tool',
          content: 'only one receipt',
          toolCallId: 'complete-call',
          name: 'read_file',
        },
      ] as any[],
      toolDeclarations: tools,
      contextTokens: 4_096,
      compactToolDeclarations: true,
    })).toThrow(/incomplete tool continuation/i);
  });

  it('fails closed when an atomic tool-call/receipt boundary exceeds the local message budget', () => {
    expect(() => prepareLocalModelRequest({
      messages: [
        { role: 'user', content: 'Accepted source must remain.' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'oversized-call', name: 'read_file', arguments: { path: 'huge.txt' } }],
        },
        {
          role: 'tool',
          content: `OVERSIZED_ATOMIC_RECEIPT ${'receipt payload '.repeat(4_000)}`,
          toolCallId: 'oversized-call',
          name: 'read_file',
        },
      ] as any[],
      toolDeclarations: [],
      contextTokens: 4_096,
      compactToolDeclarations: true,
    })).toThrow(/complete assistant tool_call\/tool receipt boundary/i);
  });

  it('retains the annotated source and a trailing synthetic user through local-model compaction', () => {
    const sourceMessageId = 'local-durable-source-1';
    const prepared = prepareLocalModelRequest({
      messages: [
        { role: 'system', content: `Safety boundary. ${'large policy '.repeat(1_500)}` },
        ...Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `old turn ${index} ${'large history '.repeat(300)}`,
        })),
        {
          role: 'user',
          content: `LOCAL_ANNOTATED_SOURCE_SENTINEL ${'accepted instruction '.repeat(800)}`,
          sourceMessageId,
        },
        { role: 'assistant', content: 'Recover the interrupted execution.' },
        {
          role: 'user',
          content: `LOCAL_SYNTHETIC_RECOVERY_SENTINEL ${'synthetic guidance '.repeat(800)}`,
        },
      ] as any[],
      toolDeclarations: tools,
      maxTokens: 768,
      contextTokens: 4_096,
    });

    const source = prepared.messages.find(message => message.sourceMessageId === sourceMessageId);
    expect(String(source?.content)).toContain('LOCAL_ANNOTATED_SOURCE_SENTINEL');
    expect(String(prepared.messages.at(-1)?.content)).toContain('LOCAL_SYNTHETIC_RECOVERY_SENTINEL');
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(prepared.inputBudgetTokens);
  });

  it('fails closed on multiple annotated sources before local-model inference', () => {
    expect(() => prepareLocalModelRequest({
      messages: [
        { role: 'user', content: 'first source', sourceMessageId: 'source-1' },
        { role: 'user', content: 'second source', sourceMessageId: 'source-2' },
      ],
      toolDeclarations: [],
      contextTokens: 4_096,
    })).toThrow(ModelRequestSourceProvenanceError);
  });
});
