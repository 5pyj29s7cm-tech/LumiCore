import { describe, expect, it } from 'vitest';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { responseExecutionClaims } from '../server/work_product/response_execution_claims';

const turn = { requestId: 'claim-current', taskId: 'claim-task' };
const observe = (path: string, body = 'SOURCE') => ({ ...turn, name: 'read_file', arguments: { path }, result: body,
  terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Synthetic read' } });
const produce = (path: string) => ({ ...turn, name: 'write_file', arguments: { path, content: 'DATA' }, result: 'File written: ' + path });

describe('response claim scope without authorizing new actions', () => {
  it.each([
    'You can read the document from the File menu.',
    'Read the file before comparing its values.',
    'Please read the document first, then save your changes.',
    'If you save the document, you can reopen it later.',
    'I have not read the file.',
    'The document was not saved.',
    'The file has not been saved.',
    'Saved files remain available after restart.',
    'Alice saved the document yesterday.',
    'Did I say that I saved the file?',
    'I read books for pleasure.',
    'We read English books every day.',
    'I have read your question.',
    '我已阅读你的问题。',
    'I have verified the calculation: twelve plus eight is twenty.',
    '我已核验题设中的计算，十二加八等于二十。',
    'The source says "I saved the document".',
    '根据已经读出的正文，比较已完成，数量相差3。',
  ])('preserves guidance, negative claims and quoted or third-party prose: %s', response => {
    expect(guardCompletionClaims({ ...turn, task: 'Explain the workflow without running tools.', response, toolCalls: [] }))
      .toMatchObject({ blocked: false, text: response });
  });

  it.each([
    'The receipt was saved and I sent the report to Alice.',
    '回执已保存并且我已发送报告给审阅人。',
    'Please confirm the input. I saved the report.',
    'The source says "not saved". I saved the file.',
  ])('does not let metadata or guidance hide a separate physical claim: %s', response => {
    expect(guardCompletionClaims({ ...turn, task: 'Explain the workflow.', response, toolCalls: [] }).blocked).toBe(true);
  });

  it.each([
    ['read', '本轮已读取 D:/fixtures/b.txt。', observe('D:/fixtures/a.txt')],
    ['write', '报告文件已保存到 D:/fixtures/b.txt。', produce('D:/fixtures/a.txt')],
    ['open', '已打开 Calculator。', observe('D:/fixtures/a.txt')],
    ['completion', 'Task completed.', observe('D:/fixtures/a.txt')],
  ])('does not substitute an unrelated receipt for %s', (_kind, response, record) => {
    expect(guardCompletionClaims({ ...turn, task: '确认', response, toolCalls: [record] }).blocked).toBe(true);
  });

  it.each([
    ['本轮已读取 D:/fixtures/a.txt。', observe('D:/fixtures/a.txt')],
    ['报告文件已保存到 D:/fixtures/a.txt。', produce('D:/fixtures/a.txt')],
  ])('can report the exact current receipt without creating an authorization: %s', (response, record) => {
    expect(guardCompletionClaims({ ...turn, task: '确认', response, toolCalls: [record] }))
      .toMatchObject({ blocked: false, text: response });
    expect(guardCompletionClaims({ ...turn, task: '确认', response, toolCalls: [{ ...record, requestId: 'older' }] }).blocked).toBe(true);
  });

  it('preserves a verified document body containing execution prose while checking the added assistant claim', () => {
    const body = 'I saved the report. 我已发送结果给审阅人。';
    const task = 'Read D:/fixtures/a.txt and show its complete contents.';
    const toolCalls = [observe('D:/fixtures/a.txt', body)];
    expect(guardCompletionClaims({ ...turn, task, response: body, toolCalls })).toMatchObject({ blocked: false, text: body });
    expect(guardCompletionClaims({ ...turn, task, response: body + '\nI saved D:/fixtures/b.txt.', toolCalls }).blocked).toBe(true);
  });

  it('leaves permissions and task contracts outside the pure reply classifier', () => {
    expect(responseExecutionClaims('I saved the file.').claims.map(claim => claim.kind)).toEqual(['artifact']);
  });

  it('does not treat unrelated optional-read text as a verified source quotation', () => {
    const response = 'I saved D:/fixtures/b.txt.';
    expect(guardCompletionClaims({ ...turn, task: 'Explain the workflow.', response,
      toolCalls: [observe('D:/fixtures/a.txt', response)] }).blocked).toBe(true);
  });

  it('does not use an explicitly unverified read as a completed source observation', () => {
    expect(guardCompletionClaims({ ...turn, task: '确认', response: '本轮已读取 D:/fixtures/a.txt。',
      toolCalls: [{ ...observe('D:/fixtures/a.txt'), terminalVerification: {
        status: 'unverified', strategy: 'terminal_receipt', reason: 'No verified receipt',
      } }] }).blocked).toBe(true);
  });

  it('checks a repeated assistant claim after preserving only the source occurrence', () => {
    const response = 'I saved D:/fixtures/b.txt.';
    expect(guardCompletionClaims({ ...turn, task: 'Read D:/fixtures/a.txt and show its complete contents.',
      response: response + '\n' + response, toolCalls: [observe('D:/fixtures/a.txt', response)] }).blocked).toBe(true);
  });

  it('separates retrieving source text from verifying its factual claims', () => {
    const observation = { ...turn, name: 'url_fetch', arguments: { url: 'https://example.org/source' },
      result: 'The source paragraph is available for inspection.', terminalVerification: {
        status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Fetch completed',
      } };
    const input = { ...turn, task: 'Explain the supplied facts.', toolCalls: [observation] };
    expect(guardCompletionClaims({ ...input, response: '本轮已查询并查阅原始来源。' }).blocked).toBe(false);
    for (const response of ['我已核验官方来源。', 'I have searched and verified the original sources.']) {
      expect(guardCompletionClaims({ ...input, response }).blocked).toBe(true);
    }
    expect(guardCompletionClaims({ ...input, response: 'I have searched sources at https://different.example/source' }).blocked).toBe(true);
  });

  it.each([
    ['empty hits', 'web_search', { query: 'stages' }, '{"ok":true,"resultCount":0,"results":[]}'],
    ['metadata only', 'url_fetch', { url: 'https://example.org/source' }, '{"ok":true,"verified":true}'],
    ['no extracted text', 'url_fetch', { url: 'https://example.org/source' }, '(No text content extracted)'],
    ['missing target', 'url_fetch', {}, 'A source paragraph'],
  ])('does not substantiate source observation with %s', (_label, name, args, result) => {
    expect(guardCompletionClaims({ ...turn, task: 'Explain the supplied facts.', response: '本轮已查询并查阅原始来源。',
      toolCalls: [{ ...turn, name, arguments: args, result, terminalVerification: {
        status: 'verified', strategy: 'terminal_receipt', reason: 'Provider claimed success',
      } }] }).blocked).toBe(true);
  });

  it('can report a completed search with returned source URLs without claiming verification', () => {
    const response = 'I have searched sources.';
    const search = { ...turn, name: 'web_search', arguments: { query: 'stages' },
      result: 'Source title\nCandidate snippet\nhttps://example.org/source',
      receipt: { ok: true, status: 'observed', resultCount: 1 }, terminalVerification: {
        status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Search results returned',
      } };
    expect(guardCompletionClaims({ ...turn, task: 'Explain the supplied facts.', response, toolCalls: [search] }))
      .toMatchObject({ blocked: false, text: response });
    expect(guardCompletionClaims({ ...turn, task: 'Explain the supplied facts.', response: 'I have searched and verified.', toolCalls: [search] }).blocked).toBe(true);
  });
});
