import { describe, expect, it } from 'vitest';
import { parseLegacyXmlToolCalls } from '../server/llm/providers';

describe('legacy XML tool protocol compatibility', () => {
  const declarations = [
    {
      type: 'function' as const,
      function: { name: 'set_client_mode', description: '', parameters: {} },
    },
    {
      type: 'function' as const,
      function: { name: 'client_get_state', description: '', parameters: {} },
    },
  ];

  it('converts declared XML invocations into structured calls', () => {
    expect(parseLegacyXmlToolCalls(
      '<function_calls><invoke name="set_client_mode"><parameter name="mode">assistant</parameter></invoke></function_calls>',
      declarations,
    )).toEqual([expect.objectContaining({
      name: 'set_client_mode',
      arguments: { mode: 'assistant' },
    })]);
  });

  it('does not execute undeclared XML tool names', () => {
    expect(parseLegacyXmlToolCalls(
      '<function_calls><invoke name="desktop_run_command"><parameter name="command">whoami</parameter></invoke></function_calls>',
      declarations,
    )).toBeNull();
  });
});
