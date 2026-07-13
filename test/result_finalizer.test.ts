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
    expect(result.text).toContain('desktop_open');
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
    expect(result.text).toContain('cad_run_autocad_draw_script');
  });

  it('allows visible AutoCAD completion after the draw script run is completed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      responseText: 'AutoCAD drawing completed.',
      toolRecords: [{
        name: 'cad_generate_autocad_draw_script',
        arguments: { width: 7800, height: 6200 },
        result: '{"scriptPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan.scr","completionMarkerPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan.done","operationCount":12}',
      }, {
        name: 'cad_run_autocad_draw_script',
        arguments: { scriptPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\plan.scr' },
        result: '{"status":"completed","completionMarkerExists":true,"completionMarkerPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan_completed.txt","autocadExecutable":"D:\\\\AutoCAD\\\\acad.exe","autocadExecutableSource":"desktop_app_index"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('CAD completion marker');
    expect(result.text).toContain('已在真实 AutoCAD 中完成');
    expect(result.text).toContain('plan_completed.txt');
  });

  it('grounds visible AutoCAD MCP playback in its operation file and marker', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Draw this visibly in AutoCAD stroke by stroke.',
      responseText: 'Done.',
      toolRecords: [{
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: { operationsPath: 'C:\\CAD\\plan_operations.json' },
        result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"completionMarkerPath":"C:\\\\CAD\\\\plan_completed.txt","operationsPath":"C:\\\\CAD\\\\plan_operations.json","operationCount":46,"strokeDelayMs":450}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('MCP visible-playback');
    expect(result.text).toContain('stroke-by-stroke playback');
    expect(result.text).toContain('plan_operations.json');
    expect(result.text).toContain('450 ms');
  });

  it('does not accept a completed LISP fallback for an explicit AutoCAD MCP-only task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Draw visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only; do not use LISP, scripts, or fallback.',
      responseText: 'The AutoCAD drawing is complete.',
      toolRecords: [{
        name: 'cad_run_autocad_draw_script',
        arguments: {},
        result: '{"status":"completed","completionMarkerExists":true,"completionMarkerPath":"C:\\\\CAD\\\\fallback.txt"}',
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
    expect(chatSource).toContain('finalText = finalizedBackground.text;');
    expect(voiceSource).toContain('responseText = finalResponse.text;');
    expect(taskSource).toContain('orchestratedText = finalOrchestrated.text;');
    expect(taskSource).toContain('finalTaskText = finalTaskResponse.text;');
  });
});
