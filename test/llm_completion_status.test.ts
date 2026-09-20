import './helpers';
import { describe, expect, it } from 'vitest';
import { parseDeepSeekResponse, parseGeminiResponse, parseAnthropicResponse } from '../server/llm/providers';

describe('plain text completion status', () => {
  it.each(['stop', 'length', 'content_filter'] as const)('preserves OpenAI-compatible %s without tool calls', finishReason => {
    expect(parseDeepSeekResponse({ choices: [{ finish_reason: finishReason, message: { content: 'Partial text' } }] }))
      .toMatchObject({ text: 'Partial text', finishReason, toolCalls: null });
  });
  it('normalizes provider termination reasons without inventing a stop for missing metadata', () => {
    expect(parseGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Partial' }] } }] }).finishReason).toBe('length');
    expect(parseAnthropicResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Complete.' }] }).finishReason).toBe('stop');
    expect(parseDeepSeekResponse({ choices: [{ message: { content: 'Legacy' } }] }).finishReason).toBeUndefined();
    expect(parseDeepSeekResponse({ choices: [{ finish_reason: 'unexpected', message: { content: 'Partial' } }] }).finishReason).toBe('unknown');
    expect(parseDeepSeekResponse({ choices: [{ finish_reason: 'content_filter' }] }).finishReason).toBe('content_filter');
  });
});
