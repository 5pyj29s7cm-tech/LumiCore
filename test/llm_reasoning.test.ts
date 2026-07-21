import { describe, expect, it } from 'vitest';
import { formatDeepSeekRequest, makeLLMCallStreaming, parseDeepSeekResponse } from '../server/llm/providers';

describe('LLM reasoning output handling', () => {
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
