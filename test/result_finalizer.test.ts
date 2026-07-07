import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Lumi result finalizer', () => {
  it('blocks unverified completion claims for concrete work', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Create a PPT file for the customer.',
      responseText: 'Created the PPT successfully.',
      toolRecords: [],
      source: 'task',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('cannot honestly mark this complete yet');
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('allows completion claims when producing tools provide evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Create a PPT file for the customer.',
      responseText: 'Created the PPT successfully.',
      toolRecords: [{
        name: 'create_ppt',
        arguments: { title: 'Customer deck' },
        result: 'created: D:\\\\tmp\\\\customer.pptx',
      }],
      source: 'task',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('Created the PPT successfully.');
  });

  it('blocks action promises when no tool evidence exists', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Please open and review this contract file from the buyer side.',
      responseText: 'Let me first read the file content, then I will review it from the buyer side.',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('not actually started');
    expect(result.text).toContain('no successful tool evidence');
  });

  it('blocks Chinese read/review promises when no tool evidence exists', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u9700\u8981\u4f60\u6253\u5f00\u5ba1\u67e5\u4e00\u4e0b\u8fd9\u4efd\u5408\u540c\u534f\u8bae\uff0c\u7ad9\u5728\u4e59\u65b9\u89d2\u5ea6\u7ed9\u51fa\u4fee\u6539\u610f\u89c1',
      responseText: '\u597d\u7684\uff0c\u6211\u5148\u8bfb\u53d6\u8fd9\u4efd\u534f\u8bae\u7684\u5185\u5bb9\uff0c\u7136\u540e\u4ece\u4e59\u65b9\u89d2\u5ea6\u9010\u6761\u5ba1\u67e5\u3002\u8ba9\u6211\u5148\u770b\u770b\u6587\u4ef6\u5185\u5bb9\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u6ca1\u6709\u771f\u6b63\u5f00\u59cb\u8bfb\u53d6');
    expect(result.text).toContain('\u6ca1\u6709\u5b9e\u9645\u8bfb\u5230\u6587\u4ef6\u5185\u5bb9');
  });

  it('does not treat a directory listing as read/review evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Please open and review this contract file from the buyer side.',
      responseText: 'Let me first read the file content, then I will review it from the buyer side.',
      toolRecords: [{
        name: 'desktop_list_files',
        arguments: { path: 'C:\\Users\\me\\Desktop' },
        result: '[{"name":"contract.docx","path":"C:\\\\Users\\\\me\\\\Desktop\\\\contract.docx","type":"file"}]',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('not actually started');
    expect(result.reason).toContain('content-read/open/review');
  });

  it('keeps socket entrypoints on the shared finalizer path', () => {
    const root = process.cwd();
    const socketSources = [
      readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8'),
    ];

    for (const source of socketSources) {
      expect(source).toContain('finalizeLumiResponse');
      expect(source).not.toContain('guardCompletionClaims');
    }
  });
});
