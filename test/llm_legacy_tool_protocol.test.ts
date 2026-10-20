import { describe, expect, it } from 'vitest';
import { parseLegacyXmlToolCalls } from '../server/llm/providers';
import { createLegacyProtocolChunkFilter } from '../server/llm/provider/legacy_protocol';

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
  it('executes the screenshot protocol once through the declared-tool adapter', () => {
    const text = '我先读取当前界面。\n\n<client_get_state>\n</client_get_state>';
    expect(parseLegacyXmlToolCalls(text, declarations)).toEqual([
      expect.objectContaining({ name: 'client_get_state', arguments: {} }),
    ]);
    expect(parseLegacyXmlToolCalls(text, [])).toBeNull();
    expect(parseLegacyXmlToolCalls('<desktop_run_command></desktop_run_command>', declarations)).toBeNull();
    expect(parseLegacyXmlToolCalls('&lt;client_get_state&gt;&lt;/client_get_state&gt;', declarations)).toBeNull();
  });

  it('preserves direct-tag arguments and refuses malformed bodies', () => {
    for (const body of ['{"mode":"assistant"}', '<parameter name="mode">assistant</parameter>']) {
      expect(parseLegacyXmlToolCalls('<set_client_mode>' + body + '</set_client_mode>', declarations))
        .toEqual([expect.objectContaining({ name: 'set_client_mode', arguments: { mode: 'assistant' } })]);
    }
    for (const body of ['not JSON', '{"mode":', '[]', 'null', '42', '<parameter name="mode">assistant</parameter>garbage']) {
      expect(parseLegacyXmlToolCalls('<set_client_mode>' + body + '</set_client_mode>', declarations), body).toBeNull();
    }
    expect(parseLegacyXmlToolCalls('<client_get_state>', declarations)).toBeNull();
    expect(parseLegacyXmlToolCalls('<clientXgetXstate></clientXgetXstate>', declarations)).toBeNull();
  });

  it('suppresses protocol anywhere in the stream at every chunk boundary', () => {
    const prose = '我会按当前界面介绍。\n\n';
    for (const protocol of [
      '<client_get_state></client_get_state>',
      '<function_calls><invoke name="client_get_state"></invoke></function_calls>',
      '&lt;client_get_state&gt;&lt;/client_get_state&gt;',
    ]) {
      const text = prose + protocol;
      for (let split = 1; split < text.length; split += 1) {
        const chunks: string[] = [];
        const filter = createLegacyProtocolChunkFilter(chunk => chunks.push(chunk));
        filter.emit(text.slice(0, split));
        filter.emit(text.slice(split));
        filter.flush();
        expect(chunks.join(''), String(split)).toBe(prose);
      }
      const chunks: string[] = [];
      const filter = createLegacyProtocolChunkFilter(chunk => chunks.push(chunk));
      for (const character of text) filter.emit(character);
      filter.flush();
      expect(chunks.join('')).toBe(prose);
    }
  });

  it('keeps ordinary prose, HTML, and comparisons readable', () => {
    for (const text of ['正常文字', '<div>hello</div>', 'a < 2 and b > 1', 'fish & chips', 'x < 3']) {
      const chunks: string[] = [];
      const filter = createLegacyProtocolChunkFilter(chunk => chunks.push(chunk));
      for (const character of text) filter.emit(character);
      filter.flush();
      expect(chunks.join('')).toBe(text);
    }
  });
});
