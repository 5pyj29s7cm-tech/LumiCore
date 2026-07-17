import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Lumi result finalizer', () => {
  it('blocks raw legacy function-call markup from reaching the user', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '为我介绍客户端里的每个页面。',
      responseText: '<function_calls>\n<invoke name="client_get_state">\n</invoke>\n</function_calls>',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('<function_calls>');
    expect(result.text).toContain('没有读取到当前客户端状态');
  });

  it('blocks a fabricated prior self-check explanation without diagnostic receipts', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '你怎么运行了这么久才回我？',
      responseText: '刚才在跑自检，扫描 MCP 连接、组织工作区和技能链路。',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('prior diagnostic run');
    expect(result.text).toContain('没有可核实的客户端自检工具回执');
  });

  it('blocks a claimed diagnostic tool run when the current turn has no matching records', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u786e\u8ba4',
      responseText: '\u597d\u7684\uff0c\u6211\u5df2\u7ecf\u8fd0\u884c\u4e86 `client_health_check` \u548c `client_get_state`\uff0c\u72b6\u6001\u6b63\u5e38\u3002',
      toolRecords: [],
      source: 'wechat_bot',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('without matching tool records');
    expect(result.text).toContain('client_health_check');
    expect(result.text).toContain('client_get_state');
  });

  it('replaces a diagnostic narrative with a summary grounded in real records', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '\u6211\u5df2\u7ecf\u8fd0\u884c\u4e86 `client_health_check` \u548c `client_get_state`\u3002';

    const result = finalizeLumiResponse({
      taskText: '\u786e\u8ba4',
      responseText,
      toolRecords: [
        { name: 'client_health_check', arguments: {}, result: '{"level":"ready"}' },
        { name: 'client_get_state', arguments: {}, result: '{"state":"ready"}' },
      ],
      source: 'wechat_bot',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u81ea\u68c0\u5b8c\u6210');
    expect(result.text).toContain('\u5065\u5eb7\u7b49\u7ea7\uff1aready');
    expect(result.text).toContain('client_health_check');
    expect(result.text).toContain('client_get_state');
    expect(result.text).not.toBe(responseText);
  });

  it('reports a successful but irrelevant client_get_state receipt instead of claiming zero tool execution', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002',
      responseText: '\u5df2\u5b8c\u6210\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u5e76\u5217\u51fa\u684c\u9762\u6587\u4ef6\u3002',
      toolRecords: [{
        name: 'client_get_state',
        arguments: {},
        result: JSON.stringify({
          selfAwareness: {
            habits: [
              'Some external actions require user confirmation.',
              '\u9700\u8981\u786e\u8ba4\u7684\u662f\u5176\u4ed6\u52a8\u4f5c\uff0c\u4e0d\u662f\u8fd9\u6b21\u72b6\u6001\u8bfb\u53d6\u3002',
            ],
          },
          capabilities: [{
            id: 'external.action',
            requiresConfirmation: true,
            notes: 'This nested capability note is descriptive metadata.',
          }],
          state: { mode: 'assistant', activeTab: 'home', runtimeStatus: 'ready' },
          health: { level: 'attention' },
        }),
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u6210\u529f\u6267\u884c\u4e86\u67e5\u8be2\u6216\u68c0\u67e5\u5de5\u5177');
    expect(result.text).toContain('\u5df2\u6210\u529f\u6267\u884c\uff1aclient_get_state');
    expect(result.text).toContain('\u4e0d\u662f\u5b8c\u6210\u5f53\u524d\u8bf7\u6c42\u6240\u9700\u7684\u6267\u884c\u8bc1\u636e');
    expect(result.text).not.toContain('\u8fd9\u4e00\u8f6e\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
    expect(result.text).not.toContain('client_get_state: undefined');
  });

  it('does not invent a WeChat desktop limitation from a work-scope routing miss', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u4f60\u81ea\u5df1\u80fd\u591f\u4fee\u590d\u5417',
      responseText: '\u56e0\u4e3a\u6211\u4eec\u73b0\u5728\u8d70\u7684\u662f\u5fae\u4fe1\u6e20\u9053\uff0c\u6240\u4ee5\u5fae\u4fe1\u8fd9\u8fb9\u770b\u4e0d\u5230\u684c\u9762\u3002',
      toolRecords: [{
        name: 'client_health_check',
        arguments: {},
        result: JSON.stringify({
          report: {
            level: 'unknown',
            stateAgeSeconds: null,
            findings: [{ id: 'client_state_missing', message: 'No live scoped client state' }],
          },
          scope: { domain: 'work', orgId: 'org-1' },
          skillRuntimeFindings: [
            { name: 'minimax', connected: false },
            { name: 'code-sandbox', connected: false },
          ],
        }),
      }, {
        name: 'get_active_window_info',
        arguments: {},
        result: '',
        error: 'No desktop client connected for this user.',
      }, {
        name: 'desktop_running_processes',
        arguments: {},
        result: '',
        error: 'No desktop client connected for this user.',
      }, {
        name: 'client_self_repair',
        arguments: { action: 'refresh_client_state' },
        result: '',
        error: 'No desktop client connected for this user.',
      }],
      source: 'wechat_bot',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u7ec4\u7ec7\u5de5\u4f5c\u57df');
    expect(result.text).toContain('\u4e0d\u80fd\u636e\u6b64\u65ad\u8a00');
    expect(result.text).toContain('get_active_window_info: No desktop client connected for this user.');
    expect(result.text).toContain('\u53ef\u9009\u6280\u80fd\u5f53\u524d\u672a\u8fde\u63a5\uff1aminimax\u3001code-sandbox');
    expect(result.text).not.toContain('\u56e0\u4e3a\u6211\u4eec\u73b0\u5728\u8d70\u7684\u662f\u5fae\u4fe1\u6e20\u9053');
  });

  it('reports missing diagnostic receipts instead of fabricating a self-check', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u4f60\u81ea\u68c0\u4e00\u4e0b\uff0c\u770b\u770b\u6709\u6ca1\u6709\u4ec0\u4e48\u5730\u65b9\u4e0d\u591f\u81ea\u7136\u4e0e\u901a\u7545',
      responseText: '\u5df2\u8fd0\u884c client_health_check\uff0c45/47 \u4e2a MCP \u5df2\u8fde\u63a5\u3002',
      toolRecords: [],
      source: 'wechat_bot',
    });

    expect(result.text).toContain('\u672c\u8f6e\u6ca1\u6709\u53d6\u5f97\u4efb\u4f55\u5ba2\u6237\u7aef\u81ea\u68c0\u5de5\u5177\u56de\u6267');
    expect(result.text).not.toContain('45/47');
  });

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

  it('does not bypass the generic guard when no task contract is recognized', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u786e\u8ba4',
      responseText: '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u8fd9\u4e00\u8f6e\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('blocks an ungrounded voice execution-status claim without a recognized contract', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u597d',
      responseText: '\u6b63\u5728\u6267\u884c\u3002',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('current-turn tool execution');
    expect(result.text).toContain('\u8fd8\u4e0d\u80fd\u8bf4\u6b63\u5728\u6267\u884c');
  });

  it('keeps ordinary knowledge answers outside the execution guard', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '\u201c\u5df2\u5b8c\u6210\u201d\u8868\u793a\u52a8\u4f5c\u7ed3\u675f\uff1b\u201c\u6b63\u5728\u6267\u884c\u201d\u8868\u793a\u52a8\u4f5c\u4ecd\u5728\u8fdb\u884c\u3002';

    const result = finalizeLumiResponse({
      taskText: '\u201c\u5df2\u5b8c\u6210\u201d\u548c\u201c\u6b63\u5728\u6267\u884c\u201d\u6709\u4ec0\u4e48\u533a\u522b\uff1f',
      responseText,
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not correct a mismatched desktop-open receipt into success', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00 AutoCAD\u3002',
      responseText: '\u5df2\u6253\u5f00 AutoCAD\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'mspaint.exe' },
        result: JSON.stringify({ ok: true, status: 'opened', target: 'mspaint.exe' }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for desktop_operation.');
    expect(result.text).not.toBe('\u5df2\u6253\u5f00 AutoCAD\u3002');
  });

  it('keeps an exact desktop-open receipt successful even if the model hits its tool limit', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00 AutoCAD\u3002',
      responseText: '\u8fd9\u8f6e\u5de5\u5177\u5904\u7406\u6b21\u6570\u5230\u4e0a\u9650\u4e86\uff0c\u6211\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'AutoCAD' },
        result: JSON.stringify({
          ok: true,
          status: 'opened',
          target: 'AutoCAD',
          processName: 'acad.exe',
          windowTitle: 'Autodesk AutoCAD',
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('AutoCAD');
    expect(result.text).toContain('\u5df2\u6253\u5f00');
    expect(result.reason).toContain('exact desktop-open success');
  });

  it('blocks the real WPS false-success ledger instead of accepting write_file as in-app editing', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
      '- unfinished: yes',
    ].join('\n');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u5728 WPS \u65b0\u5efa\u7a7a\u767d\u6587\u6863\uff0c\u8f93\u5165\u5185\u5bb9\u5e76\u4fdd\u5b58\u6210\u529f\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: 'Opened app WPS Office',
      }, {
        name: 'desktop_ui_focus',
        arguments: { nameContains: 'WPS Office' },
        result: '{"status":"ok","action":"focus","selectedAfter":{"name":"WPS Office"}}',
      }, {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: '{"root":{"name":"WPS Office","controls":[{"name":"Home"}]}}',
      }, {
        name: 'ocr_screen',
        arguments: {},
        result: 'WPS Office \u9996\u9875\uff1a\u7a7a\u767d\u6587\u6863\u672a\u6253\u5f00\u3002',
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'ctrl+n' },
        result: 'Pressed: ctrl+n',
      }, {
        name: 'write_file',
        arguments: { path: 'D:\\lumiOS\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt' },
        result: 'File written: D:\\lumiOS\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app UI mutation evidence.');
    expect(result.text).not.toContain('\u4fdd\u5b58\u6210\u529f');
  });

  it.each([
    { source: 'voice', taskText: '\u7ee7\u7eed' },
    { source: 'task', taskText: '\u786e\u8ba4' },
  ])('uses recovered WPS route context for a $source finalizer mismatch', async ({ source, taskText }) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const routeText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi \u8fde\u7eed\u4efb\u52a1\u56de\u5f52\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
      '- unfinished: yes',
    ].join('\n');

    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u3002',
      toolRecords: [{
        name: 'write_file',
        arguments: { path: 'D:\\lumiOS\\Lumi-continuation.txt' },
        result: 'File written: D:\\lumiOS\\Lumi-continuation.txt',
      }],
      source,
      flow: { routeText } as any,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app UI mutation evidence.');
    expect(result.text).not.toBe('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u3002');
  });

  it('blocks an extra WPS save claim when create/type passed but save was not verified', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      '- appTarget: WPS Office',
    ].join('\n');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u5728 WPS \u65b0\u5efa\u3001\u5199\u5165\u5e76\u4fdd\u5b58\u6210\u529f\u3002',
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"WPS Office","process_name":"wps.exe"}',
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'ctrl+n' },
        result: 'Pressed: ctrl+n',
      }, {
        name: 'desktop_ui_type',
        arguments: { name: '\u6b63\u6587', text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
        result: '{"status":"ok","action":"type","typedLength":10}',
      }, {
        name: 'ocr_screen',
        arguments: {},
        result: 'WPS Office \u6587\u6863\u6b63\u6587\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app save evidence.');
    expect(result.text).not.toContain('\u4fdd\u5b58\u6210\u529f');
  });

  it.each([
    {
      responseText: '\u8fd9\u8f6e\u5de5\u5177\u5904\u7406\u6b21\u6570\u5230\u4e0a\u9650\u4e86\uff0c\u6211\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      expectedReason: 'Tool iteration limit reached',
    },
    {
      responseText: 'WPS \u6587\u6863\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      expectedReason: 'Execution remained incomplete',
    },
  ])('marks an unresolved WPS execution as blocked: $responseText', async ({
    responseText,
    expectedReason,
  }) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const routeText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- appTarget: WPS',
      '- unfinished: yes',
    ].join('\n');
    const result = finalizeLumiResponse({
      taskText: routeText,
      responseText,
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          processName: 'wps.exe',
          windowTitle: 'WPS Writer',
        }),
      }, {
        name: 'wps_create_document_with_text',
        arguments: { text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
        result: '',
        error: 'WPS execution did not produce a verified receipt.',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(expectedReason);
    expect(result.text).toBe(responseText);
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('allows a WPS create/type/save claim only after post-save document evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      '- appTarget: WPS Office',
    ].join('\n');
    const responseText = '\u5df2\u5728 WPS \u65b0\u5efa\u3001\u5199\u5165\u5e76\u4fdd\u5b58\u6210\u529f\u3002';
    const result = finalizeLumiResponse({
      taskText,
      responseText,
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"WPS Office","process_name":"wps.exe"}',
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'ctrl+n' },
        result: 'Pressed: ctrl+n',
      }, {
        name: 'desktop_ui_type',
        arguments: { name: '\u6b63\u6587', text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
        result: '{"status":"ok","action":"type","typedLength":10}',
      }, {
        name: 'ocr_screen',
        arguments: {},
        result: 'WPS Office \u6587\u6863\u6b63\u6587\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5',
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'ctrl+s' },
        result: 'Pressed: ctrl+s',
      }, {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: '{"root":{"name":"Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.docx - WPS Office"}}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
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

  it('keeps blocked background delegation results compact', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89',
      responseText: 'Completed successfully.',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u5fae\u4fe1' },
        result: '',
        error: 'Desktop tool "desktop_open" timed out (30s)',
      }],
      source: 'background_delegation',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210');
    expect(result.text).toContain('\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\u7a97\u53e3');
    expect(result.text).toContain('\u7cfb\u7edf\u8fd4\u56de\u6267\u884c\u5931\u8d25');
    expect(result.text).not.toContain('timed out');
    expect(result.text).not.toContain('\u56de\u590d\u58f0\u79f0');
    expect(result.text).not.toContain('\u76ee\u524d\u80fd\u786e\u8ba4\u7684\u6210\u529f\u6b65\u9aa4');
  });

  it('keeps blocked foreground WeChat desktop results in messaging context', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89',
      responseText: 'Completed successfully.',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u5fae\u4fe1' },
        result: '',
        error: 'Desktop tool "desktop_open" timed out (30s)',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210');
    expect(result.text).toContain('\u5fae\u4fe1\u53d1\u9001');
    expect(result.text).not.toContain('\u8bfb\u53d6\u6216\u5ba1\u67e5');
    expect(result.text).not.toContain('\u53ef\u8bfb\u53d6\u7684\u6587\u4ef6');
  });

  it('keeps blocked foreground WeChat chat reads out of send wording', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
      responseText: '\u6211\u5df2\u7ecf\u770b\u5230\u4e86\u6700\u8fd1\u804a\u5929\u5185\u5bb9\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u5fae\u4fe1' },
        result: 'Focused WeChat',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u6d88\u606f\u8bfb\u53d6');
    expect(result.text).toContain('wechat_read_recent_chat');
    expect(result.text).toContain('\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9');
    expect(result.text).not.toContain('\u5fae\u4fe1\u53d1\u9001\u8bf4\u6210\u5df2\u53d1\u9001');
  });

  it('keeps the current desktop task isolated from a stale messaging response', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u8bf7\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u6807\u9898\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001\uff0c\u4e0d\u8981\u70b9\u51fb\u6216\u8f93\u5165',
      responseText: '\u8fd8\u6ca1\u5b8c\u6210\u5fae\u4fe1\u804a\u5929\u8bfb\u53d6\uff0c\u9700\u8981 wechat_read_recent_chat \u8bc1\u636e\u3002',
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"Lumi OS","process_name":"lumi-os.exe","pid":3928,"width":1920,"height":1080}',
      }, {
        name: 'desktop_running_processes',
        arguments: { top: 20 },
        result: '[{"pid":3928,"name":"lumi-os.exe"},{"pid":22920,"name":"msedge.exe"}]',
      }, {
        name: 'desktop_idle_time',
        arguments: {},
        result: '{"idle_seconds":160}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('action-contract drift');
    expect(result.text).toContain('\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aLumi OS');
    expect(result.text).toContain('lumi-os.exe');
    expect(result.text).toContain('\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb');
    expect(result.text).not.toContain('\u5fae\u4fe1');
    expect(result.text).not.toContain('wechat_read_recent_chat');
  });

  it('grounds desktop AI roundtable summaries in submission and answer status', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const toolResult = {
      ok: false,
      targets: [{ id: 'chatgpt', label: 'ChatGPT' }, { id: 'claude', label: 'Claude' }],
      targetSelection: {
        mode: 'explicit',
        runningTargetIds: [],
        installedTargetIds: [],
        note: 'Targets were explicitly selected by the caller.',
      },
      ask: {
        submittedCount: 2,
        results: [
          { target: 'chatgpt', label: 'ChatGPT', status: 'submitted_unverified' },
          { target: 'claude', label: 'Claude', status: 'submitted_unverified' },
        ],
      },
      answers: [
        { target: 'chatgpt', label: 'ChatGPT', status: 'pending', answerText: null },
        { target: 'claude', label: 'Claude', status: 'pending', answerText: null },
      ],
    };

    const result = finalizeLumiResponse({
      taskText: 'Use desktop_ai_roundtable with ChatGPT and Claude, collect their visible answers, then summarize them.',
      responseText: 'ChatGPT and Claude are not installed or running.',
      toolRecords: [{
        name: 'desktop_ai_roundtable',
        arguments: { targets: ['chatgpt', 'claude'] },
        result: JSON.stringify(toolResult),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('structured tool evidence');
    expect(result.text).toContain('ChatGPT: question pasted and submitted');
    expect(result.text).toContain('Claude: question pasted and submitted');
    expect(result.text).toContain('2 target(s) are submitted and pending');
    expect(result.text).toContain('This is not app unavailable');
    expect(result.text).not.toContain('not installed or running');
  });

  it('does not treat a CAD folder workflow as visible AutoCAD completion evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      responseText: '\u6211\u5df2\u7ecf\u751f\u6210\u4e86 DXF\uff0c\u5e76\u5728 AutoCAD \u91cc\u753b\u5b8c\u4e86\u3002',
      toolRecords: [{
        name: 'mcp_cad-drafting_cad_renovation_folder_workflow',
        arguments: { folderPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\\u963f\u9646' },
        result: '{"ok":true,"cadFiles":[{"path":"C:\\\\Users\\\\me\\\\Desktop\\\\\u963f\u9646\\\\LumiCAD\\\\plan.dxf"}]}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
    expect(result.text).toContain('\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210');
    expect(result.text).toContain('mcp_cad-drafting_autocad_playback_file');
  });

  it('calls geometry extraction successful only for a verified server receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = '\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\uff0c\u63d0\u53d6\u51e0\u4f55\u4fe1\u606f\uff0c\u5148\u4e0d\u8981\u7ed8\u5236\uff0c\u53ea\u544a\u8bc9\u6211\u63d0\u53d6\u662f\u5426\u6210\u529f\u3002';
    const toolRecord = {
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\Users\\Administrator\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg' },
      result: JSON.stringify({
        path: 'C:\\Users\\Administrator\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg',
        parsed: true,
        geometryReady: true,
        geometryVerified: true,
        executableGeometryAvailable: true,
        geometryReceiptPath: 'C:\\Users\\Administrator\\LumiOS\\data\\cad\\geometry_receipts\\verified.json',
        geometryReview: {
          width: 9000,
          height: 7600,
          counts: { outerBoundary: 6, polylines: 8 },
        },
      }),
    };

    const verified = finalizeLumiResponse({
      taskText,
      responseText: '\u63d0\u53d6\u597d\u50cf\u5931\u8d25\u4e86\u3002',
      toolRecords: [toolRecord],
      source: 'chat',
    });
    const unverified = finalizeLumiResponse({
      taskText,
      responseText: '\u51e0\u4f55\u63d0\u53d6\u5df2\u6210\u529f\u3002',
      toolRecords: [{
        ...toolRecord,
        result: JSON.stringify({
          parsed: true,
          geometryReady: true,
          geometryVerified: false,
          executableGeometryAvailable: false,
          geometryReceiptPath: 'C:\\Users\\Administrator\\LumiOS\\data\\cad\\geometry_receipts\\unverified.json',
        }),
      }],
      source: 'chat',
    });

    expect(verified.blocked).toBe(false);
    expect(verified.text).toContain('\u51e0\u4f55\u63d0\u53d6\u6210\u529f');
    expect(verified.text).toContain('geometryReady=true');
    expect(verified.text).toContain('geometryVerified=true');
    expect(verified.text).toContain('verified.json');
    expect(verified.text).toContain('\u672a\u6267\u884c\u7ed8\u5236');
    expect(unverified.blocked).toBe(true);
    expect(unverified.text).toContain('\u51e0\u4f55\u63d0\u53d6\u672a\u6210\u529f');
    expect(unverified.text).toContain('geometryVerified=false');
  });

  it('rejects unrelated generated charts when a terse continuation belongs to an AutoCAD task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: [
        '执行绘图',
        '## Recent action continuation context',
        'Recent user task context:',
        '- 读取桌面阿陆文件夹里的户型图，并在 AutoCAD 中实际画出来。',
        'Recent Lumi execution state:',
        '- AutoCAD 回放仍被阻塞，尚未获得完成标记。',
      ].join('\n'),
      responseText: '已完成绘图，生成了六张业务数据可视化 PNG 图表。',
      toolRecords: [{
        name: 'write_file',
        arguments: { path: 'C:\\tmp\\charts.py' },
        result: 'C:\\tmp\\charts.py',
      }, {
        name: 'python_exec',
        arguments: { path: 'C:\\tmp\\charts.py' },
        result: 'Generated C:\\tmp\\sales_dashboard.png',
      }],
      source: 'background_delegation',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
    expect(result.text).toContain('还没完成');
  });

  it('rejects a legacy batch marker even when the task did not explicitly say MCP-only', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      responseText: 'AutoCAD drawing completed.',
      toolRecords: [{
        name: 'cad_prepare_autocad_operations',
        arguments: { width: 7800, height: 6200 },
        result: '{"operationsPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan_operations.json","completionMarkerPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan.done","operationCount":12}',
      }, {
        name: 'legacy_autocad_batch',
        arguments: { operationsPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\plan_operations.json' },
        result: '{"status":"completed","completionMarkerExists":true,"completionMarkerPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan_completed.txt","autocadExecutable":"D:\\\\AutoCAD\\\\acad.exe","autocadExecutableSource":"desktop_app_index"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
  });

  it('grounds visible AutoCAD MCP playback in its operation file and marker', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Draw this visibly in AutoCAD stroke by stroke.',
      responseText: 'Done.',
      toolRecords: [{
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: { operationsPath: 'C:\\CAD\\plan_operations.json' },
        result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"completionMarkerPath":"C:\\\\CAD\\\\plan_completed.txt","operationsPath":"C:\\\\CAD\\\\plan_operations.json","geometryVerified":true,"entityCountMatches":true,"operationCount":46,"expectedEntityCount":46,"entitiesAdded":46,"operationSetId":"verified-operation-set","strokeDelayMs":450}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('MCP/COM visible-playback');
    expect(result.text).toContain('stroke-by-stroke playback');
    expect(result.text).toContain('plan_operations.json');
    expect(result.text).toContain('450 ms');
  });

  it('uses a successful AutoCAD MCP retry after an earlier timeout on an attached CAD task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '把这幅图画成cad图',
      '## Current Turn Attachments',
      'The user attached these files to the current message. Treat them as part of the user request.',
      'Local path: C:\\Users\\me\\LumiOS\\data\\knowledge\\plan.jpg',
    ].join('\n\n');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '这次还没完成。任务类型：前台消息发送。',
      source: 'chat',
      toolRecords: [{
        id: 'first-attempt',
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: {
          operationsPath: 'C:\\CAD\\plan_operations.json',
          completionMarkerPath: 'C:\\CAD\\plan_completed.txt',
          strokeDelayMs: 450,
        },
        result: '',
        error: 'MCP error -32001: Request timed out',
      }, {
        id: 'retry',
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: {
          operationsPath: 'C:\\CAD\\plan_operations.json',
          completionMarkerPath: 'C:\\CAD\\plan_completed.txt',
          strokeDelayMs: 200,
        },
        result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"completionMarkerPath":"C:\\\\CAD\\\\plan_completed.txt","operationsPath":"C:\\\\CAD\\\\plan_operations.json","geometryVerified":true,"entityCountMatches":true,"operationCount":185,"expectedEntityCount":185,"entitiesAdded":185,"operationSetId":"verified-operation-set","strokeDelayMs":200}',
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('185');
    expect(result.text).toContain('AutoCAD');
    expect(result.text).not.toContain('微信');
    expect(result.text).not.toContain('timed out');
  });

  it('does not accept a generated drawing file for an explicit AutoCAD MCP-only task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Draw visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only; do not use LISP, scripts, or fallback.',
      responseText: 'The AutoCAD drawing is complete.',
      toolRecords: [{
        name: 'cad_generate_dxf',
        arguments: {},
        result: '{"status":"completed","path":"C:\\\\CAD\\\\fallback.dxf"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
  });

  it('blocks login-then-search claims without authenticated result evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\uff0c\u81ea\u52a8\u767b\u5f55\u8d26\u53f7\u627e\u4e00\u4e0b\u6d59\u6c5f\u7701\u7684\u6848\u4ef6',
      responseText: '\u5df2\u7ecf\u767b\u5f55\u5e76\u627e\u5230\u4e86\u6d59\u6c5f\u7701\u7684\u6848\u4ef6\u3002',
      toolRecords: [{
        name: 'web_login_profile_list',
        arguments: {},
        result: '{"profiles":[]}',
      }, {
        name: 'mcp_playwright_browser_snapshot',
        arguments: {},
        result: 'Page URL: https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login\\n登录/注册',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing authenticated browser result evidence.');
    expect(result.text).toContain('\u6ca1\u6709\u627e\u5230\u5df2\u4fdd\u5b58\u7684\u7f51\u9875\u767b\u5f55 profile');
  });

  it('blocks legal document completion claims without current-law verification', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6839\u636e\u6750\u6599\u751f\u6210\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6',
      responseText: '\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6\u5df2\u7ecf\u751f\u6210\u5b8c\u6210\uff0c\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u3002',
      toolRecords: [{
        name: 'legal_generate_litigation_packet',
        arguments: { caseName: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7' },
        result: '# \u8d77\u8bc9\u72b6\u8349\u7a3f\n\u672a\u8fd0\u884c\u5f15\u7528\u6838\u9a8c\u62a5\u544a',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing current-law verification gate for legal document.');
    expect(result.text).toContain('\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u6216\u6b63\u5f0f\u53ef\u7528');
    expect(result.text).toContain('legal_generate_citation_verification_report');
  });

  it('allows legal document completion after current-law verification passes', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const responseText = '\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6\u5df2\u7ecf\u751f\u6210\u5b8c\u6210\uff0c\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\u5df2\u901a\u8fc7\u3002';
    const result = finalizeLumiResponse({
      taskText: '\u6839\u636e\u6750\u6599\u751f\u6210\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6',
      responseText,
      toolRecords: [
        {
          name: 'legal_generate_litigation_packet',
          arguments: { caseName: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7' },
          result: '# \u8d77\u8bc9\u72b6\n## \u6cd5\u5f8b\u4f9d\u636e\n\u4ee5\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u4e3a\u51c6\u3002\n## \u4e8b\u5b9e\u4e0e\u8bc1\u636e\n\u8bc1\u636e\u76ee\u5f55\u3001\u8bc1\u660e\u76ee\u7684\u5df2\u7ed1\u5b9a\u3002\n## \u4e8b\u5b9e\u9002\u7528\u5206\u6790\n\u56f4\u7ed5\u4e89\u8bae\u7126\u70b9\u5f62\u6210\u7ed3\u8bba\u8bf7\u6c42\u3002\n# \u8981\u7d20\u5f0f\u8bc9\u72b6\noutput: D:\\\\tmp\\\\complaint.docx',
        },
        {
          name: 'legal_generate_citation_verification_report',
          arguments: { caseName: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7' },
          result: '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u786c\u95e8\u69db\uff1a\u901a\u8fc7\n\u5df2\u5e9f\u6b62/\u5931\u6548\u98ce\u9669\uff1a0',
        },
      ],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('blocks legal document completion claims without triad reasoning chain evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u751f\u6210\u6b63\u5f0f\u6cd5\u5f8b\u610f\u89c1\u4e66',
      responseText: '\u6b63\u5f0f\u6cd5\u5f8b\u610f\u89c1\u4e66\u5df2\u7ecf\u751f\u6210\u5b8c\u6210\uff0c\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\u5df2\u901a\u8fc7\uff0c\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u3002',
      toolRecords: [
        {
          name: 'legal_generate_litigation_packet',
          arguments: { caseName: '\u63a8\u7406\u94fe\u7f3a\u5931\u6d4b\u8bd5\u6848' },
          result: '# \u6cd5\u5f8b\u610f\u89c1\u4e66\noutput: D:\\\\tmp\\\\opinion.docx',
        },
        {
          name: 'legal_generate_citation_verification_report',
          arguments: { caseName: '\u63a8\u7406\u94fe\u7f3a\u5931\u6d4b\u8bd5\u6848' },
          result: '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u786c\u95e8\u69db\uff1a\u901a\u8fc7\n\u5df2\u5e9f\u6b62/\u5931\u6548\u98ce\u9669\uff1a0',
        },
      ],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing legal reasoning chain evidence.');
    expect(result.text).toContain('\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe');
    expect(result.text).toContain('legal_case_reasoning_matrix');
  });

  it('blocks legal delivery claims when the current-law gate failed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u751f\u6210\u6b63\u5f0f\u4ee3\u7406\u8bcd\u548c\u6cd5\u5f8b\u610f\u89c1\u4e66\u4ea4\u4ed8\u5305',
      responseText: '\u6b63\u5f0f\u4ee3\u7406\u8bcd\u548c\u6cd5\u5f8b\u610f\u89c1\u4e66\u4ea4\u4ed8\u5305\u5df2\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'legal_finalize_delivery_package',
        arguments: { caseName: '\u5e9f\u6b62\u6cd5\u963b\u65ad\u6d4b\u8bd5\u6848' },
        result: '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u786c\u95e8\u69db\u672a\u901a\u8fc7\n\u300a\u5408\u540c\u6cd5\u300b\u5df2\u5e9f\u6b62',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing current-law verification gate for legal document.');
    expect(result.text).toContain('\u672a\u6838\u9a8c\u7684\u6cd5\u5f8b\u6587\u4e66');
  });

  it('blocks court filing portal claims that pretend final external submission is automatic', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u5e2e\u6211\u5728\u6cd5\u9662\u7acb\u6848\u7f51\u81ea\u52a8\u7acb\u6848\u5e76\u63d0\u4ea4',
      responseText: '\u5df2\u7ecf\u5728\u6cd5\u9662\u7acb\u6848\u7f51\u5b8c\u6210\u81ea\u52a8\u7acb\u6848\u63d0\u4ea4\u3001\u7b7e\u540d\u548c\u7f34\u8d39\u3002',
      toolRecords: [{
        name: 'legal_prepare_filing_handoff',
        arguments: { caseName: '\u7acb\u6848\u6d4b\u8bd5\u6848' },
        result: '\u534a\u81ea\u52a8\u7acb\u6848\u4ea4\u63a5\u5355\nLumi \u672a\u81ea\u52a8\u63d0\u4ea4\u3001\u672a\u7b7e\u540d\u3001\u672a\u7f34\u8d39\u3002',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('External legal platform final action requires authorized collaboration.');
    expect(result.text).toContain('\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5168\u81ea\u52a8\u5b8c\u6210');
    expect(result.text).toContain('\u6388\u6743\u534f\u4f5c');
  });

  it('blocks external legal research result claims without source or session evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u8fde\u63a5\u6cd5\u8749\u3001Alpha \u548c\u4f01\u67e5\u67e5\u67e5\u516c\u53f8\u548c\u88ab\u6267\u884c\u4eba\u60c5\u51b5',
      responseText: '\u5df2\u7ecf\u5728\u6cd5\u8749\u3001Alpha \u548c\u4f01\u67e5\u67e5\u67e5\u5230\u516c\u53f8\u6d89\u8bc9\u548c\u88ab\u6267\u884c\u60c5\u51b5\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing external legal platform result evidence.');
    expect(result.text).toContain('\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u67e5\u8be2');
    expect(result.text).toContain('\u6765\u6e90\u767b\u8bb0');
  });

  it('allows authorized external legal research handoffs without pretending results are fetched', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const responseText = '\u5df2\u751f\u6210\u6388\u6743\u534f\u4f5c\u68c0\u7d22\u884c\u52a8\u5355\uff0c\u5f85\u5f8b\u5e08\u767b\u5f55\u6cd5\u8749\u3001Alpha \u548c\u88c1\u5224\u6587\u4e66\u7f51\u6838\u9a8c\u5e76\u5f52\u6863\u6765\u6e90\u3002';
    const result = finalizeLumiResponse({
      taskText: '\u751f\u6210\u6cd5\u8749\u3001Alpha \u548c\u88c1\u5224\u6587\u4e66\u7f51\u68c0\u7d22\u8ba1\u5212',
      responseText,
      toolRecords: [{
        name: 'legal_external_research_plan',
        arguments: { caseName: '\u5916\u90e8\u68c0\u7d22\u6d4b\u8bd5\u6848' },
        result: '\u5916\u90e8\u68c0\u7d22\u884c\u52a8\u5355\n\u6388\u6743\u7f51\u9875\u767b\u5f55\u534f\u4f5c\n\u6765\u6e90\u767b\u8bb0\u8868',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('blocks legacy customer packages from claiming customer work completed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Analyze this customer lead and advance the sales follow-up.',
      responseText: 'The customer takeover and follow-up are completed.',
      toolRecords: [{
        name: 'legacy_scripted_customer_package',
        arguments: { customerName: 'Example customer' },
        result: '{"quoteReady":true,"contractReady":true,"completionEligible":false}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for customer_operations.');
  });

  it('blocks legacy ecommerce packages from claiming platform work completed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Analyze this ecommerce campaign and optimize the store listing.',
      responseText: 'The ecommerce operation and store optimization are completed.',
      toolRecords: [{
        name: 'legacy_scripted_ecommerce_package',
        arguments: { productName: 'Example product' },
        result: '{"contentMatrixReady":true,"publishDraftReady":true,"completionEligible":false}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for ecommerce_operations.');
  });

  it('blocks legacy design packages from claiming composite design delivery', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Based on the attached plan, create a design PPT, finished render, and budget schedule.',
      responseText: 'The full design package has been generated and completed.',
      toolRecords: [{
        name: 'legacy_scripted_design_package',
        arguments: { area: 120 },
        result: '{"pptReady":true,"renderPreviewReady":true,"budgetReady":true,"completionEligible":false}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for design_delivery.');
  });

  it('allows grounded customer analysis from the real sales capability', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = 'Customer lead analysis completed with a concrete next action.';

    const result = finalizeLumiResponse({
      taskText: 'Analyze this customer lead and score the sales opportunity.',
      responseText,
      toolRecords: [{
        name: 'mcp_sales-customer-ops_lead_score',
        arguments: { leadText: 'The buyer needs 30 seats this month and requested a formal quote.' },
        result: '{"score":80,"grade":"hot","signals":{"budget":true,"timing":true},"nextBestAction":"Confirm authority and prepare a scoped quotation."}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('blocks ordinary chat formal legal documents without production and citation gates', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u76f4\u63a5\u7ed9\u6211\u4e00\u4efd\u6b63\u5f0f\u7248\u8d77\u8bc9\u72b6',
      responseText: '\u6b63\u5f0f\u7248\u8d77\u8bc9\u72b6\u5df2\u751f\u6210\uff0c\u53ef\u4ee5\u76f4\u63a5\u63d0\u4ea4\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing legal document production evidence.');
    expect(result.text).toContain('\u6cd5\u5f8b\u6587\u4e66\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210');
  });

  it('keeps socket entrypoints on the shared finalizer path', () => {
    const root = process.cwd();
    const chatSource = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voiceSource = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const taskSource = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');
    const socketSources = [chatSource, voiceSource, taskSource];

    for (const source of socketSources) {
      expect(source).toContain('finalizeLumiResponse');
      expect(source).not.toContain('guardCompletionClaims');
    }
    expect(chatSource).toContain('responseText = finalResponse.text;');
    expect(chatSource).toContain('responseText: completionCandidate');
    expect(chatSource).toContain('const completionText = finalizedBackground.text;');
    expect(voiceSource).toContain('responseText = finalResponse.text;');
    expect(taskSource).toContain('orchestratedText = finalOrchestrated.text;');
    expect(taskSource).toContain('finalTaskText = finalTaskResponse.text;');
  });
});
