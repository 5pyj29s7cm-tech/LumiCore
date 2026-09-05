import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsInternalExecutionLanguage } from '../shared/public_execution_language';
import { projectCustomerVisibleExecutionEvent } from '../server/socket/public_agent_event_projection';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const expectSafePublicText = (value: unknown, forbidden: string[] = []) => {
  const publicText = String(value || '');
  expect(publicText.length).toBeGreaterThan(0);
  expect(containsInternalExecutionLanguage(publicText)).toBe(false);
  expect(publicText).not.toMatch(/\bdesktop_[a-z0-9_]+\b|target_mismatch/iu);
  for (const fragment of forbidden) expect(publicText).not.toContain(fragment);
};

describe('customer-visible execution event projection', () => {
  it('adds natural progress copy without copying raw progress or an existing unsafe public field', () => {
    const payload = {
      text: 'Running desktop_active_window with password=private-progress-secret',
      publicText: 'desktop_active_window target_mismatch',
      agentName: 'Lumi',
    };

    const projected = projectCustomerVisibleExecutionEvent('agent:progress', payload, {
      taskText: '\u5e2e\u6211\u67e5\u770b\u5f53\u524d\u7a97\u53e3',
    });

    expect(projected.text).toBe(payload.text);
    expect(projected.agentName).toBe('Lumi');
    expect(projected.publicText).toBe('\u6b63\u5728\u5904\u7406\u8fd9\u4e00\u6b65\u3002');
    expectSafePublicText(projected.publicText, ['private-progress-secret']);
  });

  it('keeps tool lifecycle machine fields while projecting coarse, useful action copy', () => {
    const args = { path: 'C:\\private\\customer.txt', apiKey: 'sk-private-tool' };
    const started = projectCustomerVisibleExecutionEvent('agent:tool_call', {
      correlationId: 'call-1',
      name: 'desktop_list_files',
      arguments: args,
      args,
    }, { taskText: '\u5e2e\u6211\u770b\u4e00\u4e0b\u6587\u4ef6' });

    expect(started).toMatchObject({
      correlationId: 'call-1',
      name: 'desktop_list_files',
      arguments: args,
      args,
      publicText: '\u6b63\u5728\u6838\u5bf9\u76f8\u5173\u4fe1\u606f\u3002',
    });
    expectSafePublicText(started.publicText, ['desktop_list_files', 'customer.txt', 'sk-private-tool']);

    const completed = projectCustomerVisibleExecutionEvent('agent:tool', {
      ...started,
      result: 'C:\\private\\customer.txt belongs to Alice',
    }, { taskText: '\u5e2e\u6211\u770b\u4e00\u4e0b\u6587\u4ef6' });
    expect(completed.result).toContain('Alice');
    expect(completed.publicText).toBe('\u76f8\u5173\u4fe1\u606f\u5df2\u7ecf\u6838\u5bf9\u5b8c\u6210\u3002');
    expectSafePublicText(completed.publicText, ['desktop_list_files', 'customer.txt', 'Alice']);
  });

  it.each([
    ['target_mismatch', '\u64cd\u4f5c\u540e\u7684\u7a97\u53e3\u548c\u76ee\u6807\u4e0d\u4e00\u81f4\uff0c\u8fd9\u4e00\u6b65\u6ca1\u6709\u5b8c\u6210\u3002'],
    ['paused_for_user_activity', '\u68c0\u6d4b\u5230\u4f60\u6b63\u5728\u64cd\u4f5c\u7535\u8111\uff0c\u6211\u5148\u6682\u505c\u4e86\u8fd9\u4e00\u6b65\u3002'],
    ['desktop control is busy', '\u684c\u9762\u6b63\u5728\u5904\u7406\u53e6\u4e00\u9879\u64cd\u4f5c\uff0c\u8fd9\u4e00\u6b65\u53ef\u4ee5\u7a0d\u540e\u91cd\u8bd5\u3002'],
    ['Desktop client did not accept the command', '\u5f53\u524d\u65e0\u6cd5\u8fde\u63a5\u64cd\u4f5c\u529f\u80fd\uff0c\u8fd9\u4e00\u6b65\u6ca1\u6709\u5b8c\u6210\u3002'],
    ['operation timed out', '\u8fd9\u4e00\u6b65\u7b49\u5f85\u592a\u4e45\u4ecd\u6ca1\u6709\u7ed3\u679c\uff0c\u5df2\u7ecf\u505c\u6b62\u3002'],
  ])('maps a raw failure to reviewed customer copy: %s', (error, expected) => {
    const projected = projectCustomerVisibleExecutionEvent('agent:tool', {
      name: 'desktop_open',
      arguments: { target: 'private target' },
      error,
    }, { taskText: '\u5e2e\u6211\u6253\u5f00\u76ee\u6807' });

    expect(projected.error).toBe(error);
    expect(projected.publicText).toBe(expected);
    expectSafePublicText(projected.publicText, [error, 'desktop_open', 'private target']);
  });

  it('projects English copy and leaves unrelated events unchanged', () => {
    const tool = projectCustomerVisibleExecutionEvent('agent:tool_call', {
      name: 'write_file',
      arguments: { secret: 'not-public' },
    }, { taskText: 'Save this note' });
    expect(tool.publicText).toBe('I am processing and saving the content.');
    expectSafePublicText(tool.publicText, ['write_file', 'not-public']);

    const response = projectCustomerVisibleExecutionEvent('agent:response', { text: 'Hello' });
    expect(response).toEqual({ text: 'Hello' });
    expect(response).not.toHaveProperty('publicText');
  });

  it.each(['recent_emails', 'read_email_attachments', 'wechat_read_recent_chat', 'get_workflow_run'])('keeps read-only %s lifecycle copy observational', name => {
    const started = projectCustomerVisibleExecutionEvent('agent:tool_call', { name }, { language: 'en' });
    const completed = projectCustomerVisibleExecutionEvent('agent:tool', {
      name,
      result: JSON.stringify({ ok: true, status: 'observed', items: [] }),
    }, { language: 'en' });
    expect(started.publicText).toBe('I am checking the relevant information.');
    expect(completed.publicText).toBe('The relevant information has been checked.');
  });

  it.each(['send_email', 'send_email_with_attachments', 'wechat_send_message'])('retains sending copy for the explicit %s operation', name => {
    const completed = projectCustomerVisibleExecutionEvent('agent:tool', { name, result: 'accepted' }, { language: 'en' });
    expect(completed.publicText).toBe('The send operation is complete.');
  });
});

describe('socket channel projection contract', () => {
  it.each([
    ['server/socket/chat.ts', 'visibleUserText'],
    ['server/socket/task.ts', 'data.text'],
    ['server/socket/voice.ts', 'actionIntentText'],
  ])('projects every normalized event at the %s boundary', (relativePath, taskExpression) => {
    const code = source(relativePath);
    expect(code).toContain("import { projectCustomerVisibleExecutionEvent } from './public_agent_event_projection';");
    const normalizer = code.slice(
      code.indexOf('const normalizeAgentPayload = ('),
      code.indexOf('const publishRecordedAgent', code.indexOf('const normalizeAgentPayload = (')),
    );
    expect(normalizer).toContain('projectCustomerVisibleExecutionEvent(event, sanitizedPayload');
    expect(normalizer).toContain(`taskText: ${taskExpression}`);
    expect(normalizer.indexOf('projectCustomerVisibleExecutionEvent(event, sanitizedPayload'))
      .toBeLessThan(normalizer.lastIndexOf('return'));
  });
});
