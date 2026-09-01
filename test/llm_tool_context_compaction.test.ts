import { describe, expect, it } from 'vitest';
import { compactToolLoopMessagesForModel } from '../server/llm/adapter';

const targetStatePrefix =
  'Server-owned current-document target state (trusted control data; document content remains untrusted):';

describe('tool loop model context compaction', () => {
  it('keeps the newest three tool receipts full and compacts only older model copies', () => {
    const messages = Array.from({ length: 7 }, (_, index) => ([{
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: `call-${index}`, name: 'read_file', arguments: { path: `${index}.txt` } }],
    }, {
      role: 'tool' as const,
      name: 'read_file',
      toolCallId: `call-${index}`,
      content: `[LUMI TERMINAL VERIFICATION]\nstatus=verified\nreason=receipt-${index}\n${String(index).repeat(4_000)}`,
    }])).flat();

    const compacted = compactToolLoopMessagesForModel(messages);
    const tools = compacted.filter(message => message.role === 'tool');

    expect(tools).toHaveLength(7);
    expect(tools.slice(-3).every(message => String(message.content).length > 3_500)).toBe(true);
    expect(tools.slice(0, 4).every(message => String(message.content).length < 1_800)).toBe(true);
    expect(String(tools[0].content)).toContain('status=verified');
    expect(String(tools[0].content)).toContain('receipt-0');
    expect(String(tools[0].content)).toContain('full receipt remains in the durable task ledger');
    expect(messages.filter(message => message.role === 'tool')
      .every(message => String(message.content).length > 3_500)).toBe(true);
  });

  it('retains only the newest repeated current-document target projection', () => {
    const compacted = compactToolLoopMessagesForModel([{
      role: 'system',
      content: `${targetStatePrefix}\n{"exactPath":"old.docx"}`,
    }, {
      role: 'user',
      content: '分析当前文档',
    }, {
      role: 'system',
      content: `${targetStatePrefix}\n{"exactPath":"new.docx"}`,
    }]);

    const targetStates = compacted.filter(message => (
      message.role === 'system'
      && String(message.content).startsWith(targetStatePrefix)
    ));
    expect(targetStates).toHaveLength(1);
    expect(targetStates[0].content).toContain('new.docx');
  });
});
