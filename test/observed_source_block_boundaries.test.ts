import './helpers';
import { describe, expect, it } from 'vitest';
import { guardCompletionClaims, omitObservedSourceBlocks } from '../server/work_product/completion_guard';

describe('exact displayed source blocks remain data at arbitrary document length', () => {
  const body = 'SOURCE_BEGIN\n' + 'Visible [source]. (Literal) $value? '.repeat(2200) + '\nSOURCE_END';
  it('omits a complete source longer than 56000 characters without constructing a regular expression', () => {
    expect(body.length).toBeGreaterThan(56000);
    expect(omitObservedSourceBlocks('Readback:\n' + body + '\nIndependent answer.', [body])).toBe('Readback:\n\nIndependent answer.');
  });
  it('removes each distinct body at most once, retaining repeated copies and their surrounding statements', () => {
    expect(omitObservedSourceBlocks(body + '\n' + body + '\nTail', [body, body])).toBe('\n' + body + '\nTail');
  });
  it('preserves embedded short words and incomplete source blocks', () => {
    expect(omitObservedSourceBlocks('I saved the file.', ['saved', 'file'])).toBe('I saved the file.');
    expect(omitObservedSourceBlocks(body.slice(1), [body])).toBe(body.slice(1));
  });
  it('retains the existing exact CRLF and line-boundary rules', () => {
    expect(omitObservedSourceBlocks('Prefix\r\nline [one]\r\nSuffix', ['line [one]'])).toBe('Prefix\r\n\r\nSuffix');
    expect(omitObservedSourceBlocks('Prefix line [one]\nSuffix', ['line [one]'])).toBe('Prefix line [one]\nSuffix');
  });
  it('still checks an independent false save after a complete observed source', () => {
    const scope = { requestId: 'large-source-request', taskId: 'large-source-task' };
    const input = { ...scope, task: 'Read D:/fixtures/source.txt and return its full text.',
      response: body + '\nI saved D:/fixtures/other.txt.', toolCalls: [{ ...scope, name: 'read_file',
        arguments: { path: 'D:/fixtures/source.txt' }, result: body,
        terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Synthetic source returned.' } }] };
    expect(guardCompletionClaims(input).blocked).toBe(true);
    expect(omitObservedSourceBlocks(input.response, [body])).toBe('\nI saved D:/fixtures/other.txt.');
  });
});
