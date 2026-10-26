import { describe, expect, it } from 'vitest';
import {
  formatDeepSeekRequest,
  makeLLMCallStreaming,
  makeLLMCallDirect,
  makeLLMCallStreamingDirect,
  parseDeepSeekResponse,
  resolveModelMaxTokens,
} from '../server/llm/providers';

describe('LLM reasoning output handling', () => {
  it('honors explicit small control-plane budgets on reasoning-capable models', () => {
    expect(resolveModelMaxTokens('deepseek-v4-flash', 60)).toBe(60);
    expect(resolveModelMaxTokens('deepseek-v4-pro', 512)).toBe(512);
    expect(resolveModelMaxTokens('deepseek-v4-pro')).toBeUndefined();
    expect(resolveModelMaxTokens('deepseek-chat')).toBeUndefined();
  });


  it.each([false, true])('omits an implicit output cap through the actual provider path (streaming=%s)', async streaming => {
    const sent: any[] = [];
    const answer = 'provider output segment '.repeat(1000);
    const fakeClient = { chat: { completions: { create: async (params: any) => {
      sent.push(params);
      if (streaming) return (async function* () {
        yield { choices: [{ delta: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 9000, total_tokens: 9100 } };
      })();
      return { choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 9000, total_tokens: 9100 } };
    } } } };
    const config = { provider: 'deepseek', model: 'deepseek-v4-pro' };
    const before = JSON.stringify(config);
    const messages = [{ role: 'user' as const, content: 'Return the supplied provider output.', sourceMessageId: 'uncapped-output-current' }];
    const result = streaming
      ? await makeLLMCallStreamingDirect(messages, [], config, () => {}, () => fakeClient, () => null)
      : await makeLLMCallDirect(messages, [], config, () => fakeClient, () => null);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('max_tokens');
    expect(sent[0]).not.toHaveProperty('max_completion_tokens');
    expect(sent[0]).not.toHaveProperty('reasoning_effort');
    expect(sent[0]).not.toHaveProperty('thinking');
    expect(result.text).toBe(answer);
    expect(result.usage?.completionTokens).toBe(9000);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('retains an explicit small output budget in the actual provider request', async () => {
    const sent: any[] = [];
    const client = { chat: { completions: { create: async (params: any) => {
      sent.push(params);
      return { choices: [{ message: { content: 'classified' }, finish_reason: 'stop' }] };
    } } } };
    await makeLLMCallDirect([{ role: 'user', content: 'Classify the supplied input.' }], [],
      { provider: 'deepseek', model: 'deepseek-v4-pro', maxTokens: 60 }, () => client, () => null);
    expect(sent[0].max_tokens).toBe(60);
  });

  it('keeps non-streaming reasoning_content out of user-visible text', () => {
    const parsed = parseDeepSeekResponse({
      choices: [{
        message: {
          content: '',
          reasoning_content: '我在思考，不应该展示给用户。',
        },
      }],
    });

    expect(parsed.text).toBeNull();
    expect(parsed.reasoningContent).toBe('我在思考，不应该展示给用户。');
  });

  it('does not stream reasoning_content to the UI or TTS callback', async () => {
    async function* stream() {
      yield { choices: [{ delta: { reasoning_content: '内部推理1' } }] };
      yield { choices: [{ delta: { reasoning_content: '内部推理2' } }] };
      yield { choices: [{ delta: { content: '正式回答。' } }] };
    }

    const fakeClient = {
      chat: {
        completions: {
          create: async () => stream(),
        },
      },
    };
    const chunks: string[] = [];
    const result = await makeLLMCallStreaming(
      [{ role: 'user', content: '测试' }],
      [],
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      chunk => chunks.push(chunk),
      () => fakeClient,
      () => null,
    );

    expect(chunks).toEqual(['正式回答。']);
    expect(result.text).toBe('正式回答。');
    expect(result.reasoningContent).toBe('内部推理1内部推理2');
  });

  it('downgrades orphan tool messages before sending OpenAI-compatible requests', () => {
    const request = formatDeepSeekRequest({
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'tool', content: '工具结果但没有 id', name: 'demo_tool' },
      ],
      toolDeclarations: [],
    });

    expect(request.messages[1]).toEqual({
      role: 'user',
      content: '[Tool result demo_tool]\n工具结果但没有 id',
    });
  });

  it('strips unmatched assistant tool calls from dirty history', () => {
    const request = formatDeepSeekRequest({
      model: 'deepseek-chat',
      messages: [
        { role: 'assistant', content: '我调用工具', toolCalls: [{ id: 'call_1', name: 'demo_tool', arguments: {} }] },
        { role: 'user', content: '下一句' },
      ],
      toolDeclarations: [],
    });

    expect(request.messages).toEqual([
      { role: 'assistant', content: '我调用工具' },
      { role: 'user', content: '下一句' },
    ]);
  });

  it('keeps valid assistant tool call pairs for active tool loops', () => {
    const request = formatDeepSeekRequest({
      model: 'deepseek-chat',
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'demo_tool', arguments: { q: 'x' } }] },
        { role: 'tool', content: 'ok', toolCallId: 'call_1', name: 'demo_tool' },
      ],
      toolDeclarations: [],
    });

    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'demo_tool', arguments: '{"q":"x"}' },
        }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'call_1', name: 'demo_tool' },
    ]);
  });

  it('returns DeepSeek reasoning_content with an assistant tool call on the next round', () => {
    const request = formatDeepSeekRequest({
      model: 'deepseek-reasoner',
      messages: [
        {
          role: 'assistant',
          content: null,
          reasoningContent: '需要先读取当前窗口。',
          toolCalls: [{ id: 'call_reasoning_1', name: 'desktop_active_window', arguments: {} }],
        },
        { role: 'tool', content: '{"title":"WPS"}', toolCallId: 'call_reasoning_1', name: 'desktop_active_window' },
      ],
      toolDeclarations: [],
    });

    expect(request.messages[0]).toMatchObject({
      role: 'assistant',
      reasoning_content: '需要先读取当前窗口。',
    });
  });
});

describe('DeepSeek reasoning protocol through actual request preparation', () => {
  const tool = { type: 'function' as const, function: { name: 'protocol_lookup', description: 'Read a synthetic value.', parameters: { type: 'object', properties: {} } } };
  const firstReason = 'First synthetic private protocol state. '.repeat(75);
  const secondReason = 'Second synthetic private protocol state. '.repeat(75);
  const oldReason = 'Retained previous answer protocol state.';
  const messages = (): any[] => [
    { role: 'system', content: 'Ordinary style context. '.repeat(3000) },
    { role: 'user', content: 'A previous independent question.' },
    { role: 'assistant', content: 'A previous complete answer.', reasoningContent: oldReason },
    { role: 'user', content: 'Use the existing numbers and inspect the requested source.', sourceMessageId: 'reasoning-source-user' },
    { role: 'assistant', content: null, reasoningContent: firstReason, toolCalls: [{ id: 'protocol-first', name: 'protocol_lookup', arguments: {} }] },
    { role: 'tool', name: 'protocol_lookup', toolCallId: 'protocol-first', content: 'First source was observed.' },
    { role: 'assistant', content: null, reasoningContent: secondReason, toolCalls: [{ id: 'protocol-second', name: 'protocol_lookup', arguments: {} }] },
    { role: 'tool', name: 'protocol_lookup', toolCallId: 'protocol-second', content: 'The second exact source is missing.' },
  ];
  it.each([false, true])('preserves complete reasoning and both tool batches through compaction (streaming=%s)', async streaming => {
    const { prepareCompatibleModelRequest } = await import('../server/llm/provider/request_preparation');
    const original = messages();
    const unchanged = JSON.stringify(original);
    const compacted = original;
    expect(compacted.filter(m => m.role === 'assistant').map(m => m.reasoningContent)).toEqual([oldReason, firstReason, secondReason]);
    const client = { chat: { completions: {} } };
    const getters = Array.from({ length: 12 }, () => () => client);
    const prepared = await prepareCompatibleModelRequest(compacted, [tool], { provider: 'relay', model: 'aliyun/deepseek-v4-pro', inputTokenBudget: 4096 }, 512, getters as any, false, streaming);
    expect(prepared.preparedContext.compacted).toBe(true);
    expect(prepared.params.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.reasoning_content)).toEqual([oldReason, firstReason, secondReason]);
    expect(prepared.params.messages.flatMap((m: any) => (m.tool_calls || []).map((call: any) => call.id))).toEqual(['protocol-first', 'protocol-second']);
    expect(prepared.params.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['protocol-first', 'protocol-second']);
    expect(prepared.params.tool_choice).toBe('auto');
    expect(prepared.params.model).toBe('aliyun/deepseek-v4-pro');
    expect(prepared.params.thinking).toBeUndefined();
    expect(JSON.stringify(original)).toBe(unchanged);
  });
  it.each([
    { provider: 'relay', model: 'aliyun/deepseek-v4-pro', tools: true, reasoning: true },
    { provider: 'deepseek', model: 'deepseek-v4-pro', tools: true, reasoning: true },
    { provider: 'relay', model: 'aliyun/deepseek-v4-pro', tools: false, reasoning: false },
    { provider: 'openai', model: 'deepseek-v4-pro', tools: true, reasoning: false },
    { provider: 'relay', model: 'openai/gpt-4o', tools: true, reasoning: false },
    { provider: 'qwen', model: 'qwen-plus', tools: true, reasoning: false },
  ])('keeps protocol fields scoped to the existing DeepSeek provider/model contract: %j', async example => {
    const { prepareCompatibleModelRequest } = await import('../server/llm/provider/request_preparation');
    const input = [{ role: 'user' as const, content: 'Continue.' }, { role: 'assistant' as const, content: 'Earlier answer.', reasoningContent: oldReason }];
    const client = { chat: { completions: {} } };
    const prepared = await prepareCompatibleModelRequest(input, example.tools ? [tool] : [], { provider: example.provider, model: example.model }, 128, Array.from({ length: 12 }, () => () => client) as any, false, false);
    expect(prepared.params.messages.find((m: any) => m.role === 'assistant')?.reasoning_content).toBe(example.reasoning ? oldReason : undefined);
  });
  it('fails closed when the full current protocol state cannot fit instead of clipping or clearing it', async () => {
    const { prepareCompatibleModelRequest } = await import('../server/llm/provider/request_preparation');
    const input = messages();
    input[6] = { ...input[6], reasoningContent: 'UNCLIPPED_PRIVATE_PROTOCOL_STATE '.repeat(2000) };
    const client = { chat: { completions: {} } };
    await expect(prepareCompatibleModelRequest(input, [tool], { provider: 'relay', model: 'aliyun/deepseek-v4-pro', inputTokenBudget: 4096 }, 128, Array.from({ length: 12 }, () => () => client) as any, false, true)).rejects.toThrow(/budget cannot retain/i);
  });
  it('retains earlier tool batches across a synthetic recovery user message within the annotated accepted turn', async () => {
    const { prepareCompatibleModelRequest } = await import('../server/llm/provider/request_preparation');
    const input = messages();
    input.splice(6, 0, { role: 'user', content: 'Continue the same accepted request using the preserved tool receipts.' });
    const client = { chat: { completions: {} } };
    const prepared = await prepareCompatibleModelRequest(input, [tool], { provider: 'relay', model: 'aliyun/deepseek-v4-pro', inputTokenBudget: 4096 }, 512, Array.from({ length: 12 }, () => () => client) as any, false, true);
    expect(prepared.preparedContext.compacted).toBe(true);
    expect(prepared.params.messages.flatMap((m: any) => (m.tool_calls || []).map((call: any) => call.id))).toEqual(['protocol-first', 'protocol-second']);
    expect(prepared.params.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['protocol-first', 'protocol-second']);
    expect(prepared.params.messages.filter((m: any) => m.role === 'assistant' && m.tool_calls).map((m: any) => m.reasoning_content)).toEqual([firstReason, secondReason]);
  });

});


describe('Kimi K3 tool continuation through the existing compatible request path', () => {
  const tool = { type: 'function' as const, function: { name: 'synthetic_source_lookup', description: 'Read the supplied synthetic source.', parameters: { type: 'object', properties: {} } } };
  const opaque = 'SYNTHETIC_OPAQUE_K3_CONTINUATION_DO_NOT_DISPLAY';
  const current = 'Use only the supplied facts and original source. Answer this request.';
  const source = 'ORIGINAL_SOURCE_BEGIN\nThe supplied event has a recorded date.\nORIGINAL_SOURCE_END';
  const history = (): any[] => [
    { role: 'system', content: 'Optional historical background. '.repeat(1500) },
    { role: 'user', content: current, sourceMessageId: 'kimi-current-accepted-source' },
    { role: 'assistant', content: null, reasoningContent: opaque, toolCalls: [{ id: 'synthetic-k3-call', name: tool.function.name, arguments: {} }] },
    { role: 'tool', name: tool.function.name, toolCallId: 'synthetic-k3-call', content: source },
  ];
  it.each([
    { provider: 'relay', model: 'aliyun/kimi-k3' },
    { provider: 'relay', model: 'tencent_cloud/kimi-k3' },
    { provider: 'kimi', model: 'kimi-k3' },
    { provider: 'kimi', model: 'Kimi-K3' },
  ])('returns exact opaque state with paired tools for the known K3 contract %j', async config => {
    const { prepareCompatibleModelRequest } = await import('../server/llm/provider/request_preparation');
    const input = history(); const unchanged = JSON.stringify(input);
    const prepared = await prepareCompatibleModelRequest(input, [tool], { ...config, inputTokenBudget: 4096 }, 512,
      Array.from({ length: 12 }, () => () => ({ chat: { completions: {} } })) as any, false, false);
    expect(prepared.preparedContext.compacted).toBe(true);
    expect(prepared.params.messages.find((m: any) => m.tool_calls)?.reasoning_content).toBe(opaque);
    expect(prepared.params.messages.flatMap((m: any) => (m.tool_calls || []).map((c: any) => c.id))).toEqual(['synthetic-k3-call']);
    expect(prepared.params.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['synthetic-k3-call']);
    expect(prepared.params.messages.find((m: any) => m.role === 'user').content).toBe(current);
    expect(prepared.params.messages.find((m: any) => m.role === 'tool').content).toBe(source);
    expect(prepared.params).not.toHaveProperty('thinking');
    expect(prepared.params).not.toHaveProperty('reasoning_effort');
    expect(prepared.params).not.toHaveProperty('preserve_thinking');
    expect(prepared.params).not.toHaveProperty('temperature');
    expect(JSON.stringify(input)).toBe(unchanged);
  });
  it.each([
    { provider: 'relay', model: 'aliyun/kimi-k3', tools: false },
    { provider: 'openai', model: 'kimi-k3', tools: true },
    { provider: 'relay', model: 'unrelated/kimi-k3-copy', tools: true },
  ])('does not generalize the K3 tool-only protocol to %j', async config => {
    const { prepareCompatibleModelRequest } = await import('../server/llm/provider/request_preparation');
    const prepared = await prepareCompatibleModelRequest(history(), config.tools ? [tool] : [], config, 512,
      Array.from({ length: 12 }, () => () => ({ chat: { completions: {} } })) as any, false, false);
    expect(prepared.params.messages.find((m: any) => m.role === 'assistant')?.reasoning_content).toBeUndefined();
    expect(prepared.params).not.toHaveProperty('thinking');
    expect(prepared.params).not.toHaveProperty('reasoning_effort');
  });
  it('keeps opaque protocol state in the provider request and out of visible K3 streaming output', async () => {
    const sent: any[] = [], chunks: string[] = [];
    const client = { chat: { completions: { create: async (params: any) => {
      sent.push(params);
      if (!params.stream) return { choices: [{ message: { content: 'Visible answer only.', reasoning_content: 'SYNTHETIC_NEW_PRIVATE_K3_STATE' }, finish_reason: 'stop' }] };
      return (async function* () {
        yield { choices: [{ delta: { reasoning_content: 'SYNTHETIC_NEW_PRIVATE_K3_STATE' } }] };
        yield { choices: [{ delta: { content: 'Visible answer only.' }, finish_reason: 'stop' }] };
      })();
    } } } };
    const input = history(), unchanged = JSON.stringify(input);
    const config = { provider: 'relay', model: 'aliyun/kimi-k3', inputTokenBudget: 4096 };
    const configUnchanged = JSON.stringify(config);
    const result = await (makeLLMCallStreamingDirect as any)(input, [tool], config, (chunk: string) => chunks.push(chunk),
      ...Array.from({ length: 12 }, () => () => client));
    expect(sent).toHaveLength(1);
    expect(sent[0].messages.find((m: any) => m.tool_calls).reasoning_content).toBe(opaque);
    expect(chunks).toEqual(['Visible answer only.']);
    expect(result.text).toBe('Visible answer only.');
    expect(result.reasoningContent).toBe('SYNTHETIC_NEW_PRIVATE_K3_STATE');
    expect(JSON.stringify(chunks)).not.toContain('SYNTHETIC_');
    expect(sent[0]).not.toHaveProperty('thinking');
    expect(sent[0]).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(input)).toBe(unchanged);
    expect(JSON.stringify(config)).toBe(configUnchanged);
  });
});
