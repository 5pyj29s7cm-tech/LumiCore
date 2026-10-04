import { describe, expect, it } from 'vitest';
import { replacePromptBlock } from '../server/llm/prompt_blocks';
import type { NormalizedMessage } from '../server/llm/providers';
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

  it('replaces the obsolete target before model compaction regardless of its wording', () => {
    const messages: NormalizedMessage[] = [{ role: 'user', content: '分析当前文档' }];
    replacePromptBlock(messages, { id: 'current-document-target', kind: 'task_state', authority: 'server',
      required: true, content: '任意旧标题', fields: { exactPath: 'old.docx', revision: 1 } });
    replacePromptBlock(messages, { id: 'current-document-target', kind: 'task_state', authority: 'server',
      required: true, content: 'plain new heading', fields: { exactPath: 'new.docx', revision: 2 } });
    expect(messages).toHaveLength(2);
    const compacted = compactToolLoopMessagesForModel(messages);
    expect(compacted.filter(message => message.promptBlock?.id === 'current-document-target')).toHaveLength(1);
    expect(JSON.stringify(compacted)).toContain('new.docx');
    expect(JSON.stringify(compacted)).not.toContain('old.docx');
  });

  it('does not infer a state slot from text that resembles a server target heading', () => {
    const messages: NormalizedMessage[] = [
      { role: 'system', content: targetStatePrefix + ' old quoted document' },
      { role: 'system', content: targetStatePrefix + ' new quoted document' },
    ];
    expect(compactToolLoopMessagesForModel(messages)).toEqual(messages);
  });});
