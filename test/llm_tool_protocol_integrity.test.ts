import './helpers';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeLLMCallStreamingDirect, parseDeepSeekResponse, type NormalizedMessage } from '../server/llm/providers';
import { dispatchLLMCallStreaming, type LLMGetters } from '../server/llm/dispatch';
import { resetCircuit } from '../server/cloud/circuit_breaker';

vi.mock('../server/llm/local_models', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/local_models')>(),
  resolveAutoLocalModelCandidates: vi.fn(async () => []),
  ensureLocalModelReady: vi.fn(async (_provider: string, model: string) => model),
}));

const timeouts = { requestMs: 1000, firstByteMs: 1000, semanticContentMs: 1000, idleMs: 1000, absoluteMs: 3000 };
const declarations = [{ type: 'function' as const, function: {
  name: 'lookup', description: 'Read a synthetic record',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
} }];
const messages: NormalizedMessage[] = [{ role: 'user', content: 'Look up the supplied records.' }];

function start() {
  return { type: 'message_start', message: { id: 'synthetic_message', type: 'message', role: 'assistant', content: [],
    model: 'synthetic-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } };
}

function finish(reason: string) {
  return [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: 'message_stop' }];
}

function textBlock(index: number, text: string) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ];
}

function toolBlock(index: number, id: string, fragments: string[]) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'lookup', input: {} } },
    ...fragments.map(partial_json => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
    { type: 'content_block_stop', index },
  ];
}

function anthropic(events: unknown[]) {
  // Exercise the installed SDK's real iterator and JSON assembly, with no network.
  const sse = events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Anthropic({ apiKey: 'synthetic-test-key', maxRetries: 0, fetch: async () => (
    new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  ) });
}

function callAnthropic(events: unknown[], chunks: string[] = []) {
  const client = anthropic(events);
  return makeLLMCallStreamingDirect(messages, declarations,
    { provider: 'anthropic', model: 'synthetic-model', attemptTimeouts: timeouts },
    text => chunks.push(text), () => null, () => null, () => null, () => client);
}

function compatible(frames: any[]) {
  return { chat: { completions: { create: vi.fn(async function* () { yield* frames; }) } } };
}

function toolFrame(args: string) {
  return { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: args } }] } }] };
}

function getters(overrides: Partial<LLMGetters>): LLMGetters {
  return { getDeepSeek: () => null, getGemini: () => null, getOpenAI: () => null, getAnthropic: () => null,
    getQwen: () => null, getOllama: () => null, getArk: () => null, getXiaomi: () => null,
    getKimi: () => null, getGlm: () => null, getRelay: () => null, ...overrides };
}

afterEach(() => resetCircuit());

describe('complete model text and tool arguments', () => {
  it('delivers actual SDK text deltas once and returns the final text', async () => {
    const chunks: string[] = [];
    const result = await callAnthropic([start(), ...textBlock(0, 'Hello '), ...textBlock(1, 'again'), ...finish('end_turn')], chunks);
    expect(chunks.join('')).toBe('Hello again');
    expect(result.text).toBe('Hello again');
    expect(result.toolCalls).toBeNull();
  });

  it('keeps split JSON attached to its own tool across mixed content blocks', async () => {
    const chunks: string[] = [];
    const result = await callAnthropic([start(), ...textBlock(0, 'Checking'),
      ...toolBlock(1, 'call_a', ['{"query":', '"record_a"}']),
      ...toolBlock(2, 'call_b', ['{"query":"record_b"}']),
      ...toolBlock(3, 'call_empty', ['{}']), ...finish('tool_use')], chunks);
    expect(result.text).toBe('Checking');
    expect(chunks).toEqual(['Checking']);
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'lookup', arguments: { query: 'record_a' } },
      { id: 'call_b', name: 'lookup', arguments: { query: 'record_b' } },
      { id: 'call_empty', name: 'lookup', arguments: {} },
    ]);
  });

  it('rejects an Anthropic tool turn cut off by the output budget', async () => {
    await expect(callAnthropic([start(), ...toolBlock(0, 'call_a', ['{"query":"a"}']), ...finish('max_tokens')]))
      .rejects.toMatchObject({ code: 'MODEL_TOOL_ARGUMENTS_INVALID' });
  });

  it.each(['{"query":"unfinished', '[]', 'null', '42', '"text"'])('rejects invalid non-streaming arguments %s', raw => {
    expect(() => parseDeepSeekResponse({ choices: [{ message: { tool_calls: [
      { id: 'call_a', function: { name: 'lookup', arguments: raw } },
    ] } }] })).toThrow('invalid tool-call arguments');
  });

  it('preserves a legitimate empty object and complete object', () => {
    const result = parseDeepSeekResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
      { id: 'call_a', function: { name: 'lookup', arguments: '{}' } },
      { id: 'call_b', function: { name: 'lookup', arguments: '{"query":"a"}' } },
    ] } }] });
    expect(result.toolCalls?.map(call => call.arguments)).toEqual([{}, { query: 'a' }]);
  });

  it('assembles complete compatible stream fragments without losing values', async () => {
    const client = compatible([toolFrame('{"query":'), toolFrame('"a"}'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
    const result = await makeLLMCallStreamingDirect(messages, declarations,
      { provider: 'deepseek', model: 'synthetic-model', attemptTimeouts: timeouts }, () => {}, () => client, () => null);
    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'lookup', arguments: { query: 'a' } }]);
  });

  it.each(['{"query":"unfinished', '{}'])('rejects budget-truncated compatible tool turns: %s', raw => {
    const client = compatible([toolFrame(raw), { choices: [{ delta: {}, finish_reason: 'length' }] }]);
    return expect(makeLLMCallStreamingDirect(messages, declarations,
      { provider: 'deepseek', model: 'synthetic-model', attemptTimeouts: timeouts }, () => {}, () => client, () => null))
      .rejects.toMatchObject({ code: 'MODEL_TOOL_ARGUMENTS_INVALID' });
  });

  it('rejects malformed stream arguments even without a length finish reason', async () => {
    const client = compatible([toolFrame('{"query":'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
    await expect(makeLLMCallStreamingDirect(messages, declarations,
      { provider: 'deepseek', model: 'synthetic-model', attemptTimeouts: timeouts }, () => {}, () => client, () => null))
      .rejects.toMatchObject({ code: 'MODEL_TOOL_ARGUMENTS_INVALID' });
  });

  it('routes an incomplete tool response to the configured fallback instead of reporting success', async () => {
    const primary = compatible([toolFrame('{"query":"unfinished'), { choices: [{ delta: {}, finish_reason: 'length' }] }]);
    const fallback = compatible([{ choices: [{ delta: { content: 'Recovered answer' }, finish_reason: 'stop' }] }]);
    const result = await dispatchLLMCallStreaming(messages, declarations, {
      provider: 'deepseek', model: 'bad-primary', selectionMode: 'ordered_fallback', allowCloudFallback: true,
      fallbackCandidates: [{ provider: 'openai', model: 'good-fallback' }],
      bufferStreamUntilCandidateSuccess: true, attemptTimeouts: timeouts,
    }, () => {}, getters({ getDeepSeek: () => primary, getOpenAI: () => fallback }));
    expect(result.text).toBe('Recovered answer');
    expect(result.toolCalls).toBeNull();
    expect(result.routing.attempts).toEqual([
      expect.objectContaining({ provider: 'deepseek', status: 'failed', reason: 'invalid_tool_arguments' }),
      expect.objectContaining({ provider: 'openai', status: 'succeeded' }),
    ]);
    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});
