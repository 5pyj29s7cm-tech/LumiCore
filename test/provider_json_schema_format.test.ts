import './helpers';
import { describe, expect, it } from 'vitest';
import { formatDeepSeekRequest, formatOpenAIRequest, formatQwenRequest, type LLMResponseFormat } from '../server/llm/providers';

describe('structured response request format', () => {
  it.each([formatOpenAIRequest, formatDeepSeekRequest, formatQwenRequest])('preserves the requested JSON schema while retaining legacy JSON mode', format => {
    const params = { model: 'configured-model', messages: [{ role: 'user' as const, content: 'Return a JSON draft.' }], toolDeclarations: [] };
    const schema: LLMResponseFormat = { type: 'json_schema', json_schema: { name: 'draft', strict: false, schema: { type: 'object', properties: { handlerCode: { type: 'string' } }, required: ['handlerCode'] } } };
    expect(format({ ...params, responseFormat: schema }).response_format).toEqual(schema);
    expect(format({ ...params, responseFormat: 'json_object' }).response_format).toEqual({ type: 'json_object' });
    expect(format(params)).not.toHaveProperty('response_format');
  });
});
