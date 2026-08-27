import { describe, expect, it } from 'vitest';
import {
  buildDesktopObservationPlan,
  formatDesktopObservationResult,
} from '../server/cognition/desktop_observation';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';

const verifiedTerminalReceipt = {
  terminalVerification: {
    status: 'verified' as const,
    strategy: 'terminal_receipt' as const,
    reason: 'Fresh desktop snapshot returned by the connected desktop client.',
  },
};

describe('desktop observation routing', () => {
  it('targets a named installed application without turning the check into app control', () => {
    expect(buildDesktopObservationPlan(
      'Inspect the installed AutoCAD launch target and do not open anything.',
    )).toEqual([{
      name: 'desktop_list_apps',
      arguments: { query: 'AutoCAD', limit: 30 },
    }]);
  });

  it('routes a read-only desktop state request directly to observation tools', () => {
    const plan = buildDesktopObservationPlan(
      '\u8fd9\u662f\u684c\u9762 relay \u538b\u6d4b\u3002\u8bf7\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u7684\u6807\u9898\u548c\u5f53\u524d\u684c\u9762\u8fd0\u884c\u72b6\u6001\u3002\u7981\u6b62\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u5185\u5bb9\u3002',
    );

    expect(plan.map(call => call.name)).toEqual([
      'desktop_active_window',
      'desktop_running_processes',
      'desktop_idle_time',
    ]);
  });

  it.each([
    '做个桌面程序检查',
    '看一下后台程序运行情况',
    '检查一下后台进程状态',
    '列出当前正在运行的进程和应用',
  ])('routes a natural program-status request to one process snapshot: %s', (text) => {
    expect(buildDesktopObservationPlan(text)).toEqual([{
      name: 'desktop_running_processes',
      arguments: { top: 20 },
    }]);
  });

  it.each([
    '[LUMI_REGRESSION:S1] 后台任务状态请只用 runtime_work_status 核对，不能用进程列表、数据库或文字猜测代替。',
    '请核对哪些后台任务仍可撤回；不要用进程列表、数据库或文字猜测代替真实任务回执。',
  ])('does not create a positive process observation from a negated fallback: %s', (text) => {
    expect(buildDesktopObservationPlan(text)).toEqual([]);
  });

  it('keeps a later genuine process query after a negated fallback clause', () => {
    expect(buildDesktopObservationPlan(
      '不要用进程列表代替任务回执，但请另外列出当前正在运行的进程和应用。',
    )).toEqual([{
      name: 'desktop_running_processes',
      arguments: { top: 20 },
    }]);
  });

  it('preserves other positive desktop observations beside a negated process fallback', () => {
    expect(buildDesktopObservationPlan(
      '后台任务状态不能用进程列表代替；请另外查看当前活动窗口并列出桌面文件。',
    )).toEqual([{
      name: 'desktop_active_window',
      arguments: {},
    }, {
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop', limit: 1000 },
    }]);
  });

  it('does not block a verified runtime-work status receipt on a negated process fallback', () => {
    const taskText = '[LUMI_REGRESSION:S1] 后台任务状态请只用 runtime_work_status 核对，不能用进程列表、数据库或文字猜测代替。';
    const finalized = finalizeLumiResponse({
      taskText,
      responseText: '当前有 2 个可撤回的后台任务。',
      toolRecords: [{
        name: 'runtime_work_status',
        arguments: {},
        result: JSON.stringify({ ok: true, status: 'active', activeCount: 2, items: [] }),
        terminalVerification: {
          status: 'verified' as const,
          strategy: 'terminal_receipt' as const,
          reason: 'Unified runtime ledger returned the current active count.',
        },
      }],
      source: 'chat',
    });

    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toContain('2');
  });

  it('still enforces a verified process receipt for a genuine live process query', () => {
    const taskText = '列出当前正在运行的进程和应用。';
    const missing = finalizeLumiResponse({
      taskText,
      responseText: '当前进程已列出。',
      toolRecords: [],
      source: 'chat',
    });
    const verified = finalizeLumiResponse({
      taskText,
      responseText: '当前正在运行 LumiCore 和 WPS。',
      toolRecords: [{
        name: 'desktop_running_processes',
        arguments: { top: 20 },
        result: JSON.stringify({ processes: [{ name: 'lumi-core.exe' }, { name: 'wps.exe' }] }),
        ...verifiedTerminalReceipt,
      }],
      source: 'chat',
    });

    expect(missing.blocked).toBe(true);
    expect(missing.reason).toContain('desktop_running_processes');
    expect(verified.blocked).toBe(false);
    expect(verified.text).toContain('lumi-core.exe');
    expect(verified.text).toContain('wps.exe');
  });

  it('does not replace a requested desktop mutation with observation-only work', () => {
    expect(buildDesktopObservationPlan(
      '\u6253\u5f00\u5fae\u4fe1\uff0c\u7136\u540e\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3',
    )).toEqual([]);
  });

  it('routes read-only desktop AI inventory checks to process and app evidence', () => {
    const plan = buildDesktopObservationPlan(
      'Inspect currently running desktop AI applications and locally launchable AI applications. Do not open apps, click, type, or send messages.',
    );

    expect(plan.map(call => call.name)).toEqual([
      'desktop_running_processes',
      'desktop_list_apps',
    ]);
  });

  it('routes the real team desktop request to both required observation tools', () => {
    const plan = buildDesktopObservationPlan(
      '\u7ec4\u5efa\u56e2\u961f\uff0c\u5206\u4e24\u6b65\u6267\u884c\uff1a\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u6839\u636e\u771f\u5b9e\u5de5\u5177\u7ed3\u679c\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002',
    );

    expect(plan).toEqual([{
      name: 'desktop_active_window',
      arguments: {},
    }, {
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop', limit: 1000 },
    }]);
  });

  it.each([
    'Explain the Java memory model.',
    'Summarize this disk scheduling algorithm.',
    'Compare CPU architectures.',
    'Explain process state in operating systems.',
    '\u89e3\u91ca\u8fdb\u7a0b\u72b6\u6001\u8f6c\u6362\u539f\u7406\u3002',
    'How does the CPU scheduler currently work?',
    '\u73b0\u5728\u89e3\u91ca\u4e00\u4e0b\u5185\u5b58\u7ba1\u7406\u7b97\u6cd5\u3002',
  ])('does not turn a conceptual system question into a live desktop probe: %s', (text) => {
    expect(buildDesktopObservationPlan(text)).toEqual([]);
  });

  it('still routes an explicitly live local resource check to system observation', () => {
    expect(buildDesktopObservationPlan(
      'Check this computer\'s current CPU, memory, and disk usage.',
    )).toEqual([{
      name: 'desktop_system_info',
      arguments: {},
    }]);
  });

  it('formats an active window and desktop file count from fresh receipts', () => {
    const taskText = '\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002';
    const records = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"WPS Writer","process_name":"wps.exe","pid":9988}',
      ...verifiedTerminalReceipt,
    }, {
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop', limit: 100 },
      result: JSON.stringify([
        { name: 'a.txt', path: 'C:\\Users\\tester\\Desktop\\a.txt', type: 'file' },
        { name: 'b.lnk', path: 'C:\\Users\\tester\\Desktop\\b.lnk', type: 'file' },
        { name: 'folder', path: 'C:\\Users\\tester\\Desktop\\folder', type: 'directory' },
      ]),
      ...verifiedTerminalReceipt,
    }];

    const text = formatDesktopObservationResult(records, taskText);
    expect(text).toContain('\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aWPS Writer');
    expect(text).toContain('\u672c\u6b21\u8bfb\u53d6\u5230 3 \u4e2a');
    expect(text).toContain('\u6587\u4ef6 2 \u4e2a');
    expect(text).toContain('\u6587\u4ef6\u5939 1 \u4e2a');

    const finalized = finalizeLumiResponse({
      taskText,
      responseText: text || '',
      toolRecords: records,
      source: 'voice',
    });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toBe(text);
  });

  it('preserves successful facts but blocks a partial multi-probe observation', () => {
    const taskText = 'Show the current active window and list desktop files.';
    const records = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"LumiCore Settings","process_name":"lumi-core.exe","pid":7788}',
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'Active-window snapshot returned by the connected client.',
      },
    }];

    const text = formatDesktopObservationResult(records, taskText);
    expect(text).toContain('partial fresh evidence');
    expect(text).toContain('Active window: LumiCore Settings');
    expect(text).toContain('desktop_list_files');
    expect(text).not.toContain('check completed');

    const finalized = finalizeLumiResponse({
      taskText,
      responseText: 'Both checks are complete.',
      toolRecords: records,
      source: 'chat',
    });
    expect(finalized.blocked).toBe(true);
    expect(finalized.reason).toContain('Missing desktop evidence for the requested live observation');
    expect(finalized.reason).toContain('desktop_list_files');
    expect(finalized.text).toContain('Active window: LumiCore Settings');
    expect(finalized.text).toContain('partial fresh evidence');
  });

  it.each(['unverified', 'failed'] as const)(
    'does not accept an explicitly %s desktop receipt as fresh evidence',
    status => {
      const taskText = 'Show the current active window.';
      const records = [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"Fabricated Window","process_name":"fake.exe"}',
        terminalVerification: {
          status,
          strategy: 'terminal_receipt' as const,
          reason: 'The observation could not be verified.',
        },
      }];

      expect(formatDesktopObservationResult(records, taskText)).toBeNull();
      const finalized = finalizeLumiResponse({
        taskText,
        responseText: 'The active window is Fabricated Window.',
        toolRecords: records,
        source: 'chat',
      });
      expect(finalized.blocked).toBe(true);
      expect(finalized.reason).toContain('Missing desktop evidence for the requested live observation');
      expect(finalized.text).not.toContain('Fabricated Window');
    },
  );

  it('accepts canonical envelope verification when the legacy terminal projection is absent', () => {
    const verifiedRecord = {
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"LumiCore","process_name":"lumi-core.exe","pid":7788}',
      ...verifiedTerminalReceipt,
    };
    const records = [{
      name: verifiedRecord.name,
      arguments: verifiedRecord.arguments,
      result: verifiedRecord.result,
      envelope: buildToolExecutionEnvelope(verifiedRecord),
    }];

    const text = formatDesktopObservationResult(records, 'Show the current active window.');
    expect(text).toContain('Active window: LumiCore');
  });

  it('does not treat compatibility-inferred success as fresh desktop evidence', () => {
    const legacyRecord = {
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"Unverified Window","process_name":"legacy.exe","pid":7788}',
    };
    const records = [{
      ...legacyRecord,
      envelope: buildToolExecutionEnvelope(legacyRecord),
    }];

    expect(formatDesktopObservationResult(records, 'Show the current active window.')).toBeNull();
  });

  it('labels a process report as a point-in-time sample without diagnosing a leak or hang', () => {
    const text = formatDesktopObservationResult([{
      name: 'desktop_running_processes',
      arguments: { top: 20 },
      result: JSON.stringify({
        processes: [
          { pid: 11, name: 'msedgewebview2.exe', memory_mb: 4300 },
          { pid: 12, name: 'wps.exe', memory_mb: 800 },
        ],
      }),
      ...verifiedTerminalReceipt,
    }], '做个桌面程序检查');

    expect(text).toContain('运行快照');
    expect(text).toContain('msedgewebview2.exe');
    expect(text).toContain('瞬时采样');
    expect(text).toContain('不能判定内存泄漏');
    expect(text).not.toContain('一切正常');
    expect(text).not.toContain('没卡死');
  });

  it('maps an omitted path to the user Desktop only when the routed task asks for it', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerDesktopTools } = await import('../server/tools/definitions/desktop_tools');
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const relayed: Array<{ name: string; args: Record<string, any> }> = [];
    const desktopRelay = async (name: string, args: Record<string, any>) => {
      relayed.push({ name, args });
      return '[]';
    };

    await registry.execute('desktop_list_files', {}, {
      userId: 'desktop-path-test',
      authenticated: true,
      localExecution: true,
      executionBoundary: 'trusted_local',
      source: 'voice',
      routedTaskText: '\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u5e76\u544a\u8bc9\u6211\u6587\u4ef6\u6570\u91cf',
      desktopRelay,
    } as any);
    await registry.execute('desktop_list_files', {}, {
      userId: 'desktop-list-test',
      authenticated: true,
      localExecution: true,
      executionBoundary: 'trusted_local',
      source: 'voice',
      routedTaskText: '\u5217\u51fa\u684c\u9762\u6587\u4ef6',
      desktopRelay,
    } as any);
    await registry.execute('desktop_list_files', {}, {
      userId: 'home-path-test',
      authenticated: true,
      localExecution: true,
      executionBoundary: 'trusted_local',
      source: 'chat',
      routedTaskText: '\u5217\u51fa\u7528\u6237\u4e3b\u76ee\u5f55',
      desktopRelay,
    } as any);

    expect(relayed).toEqual([{
      name: 'desktop_list_files',
      args: { path: '~/Desktop', limit: 1000 },
    }, {
      name: 'desktop_list_files',
      args: { path: '~/Desktop', limit: 100 },
    }, {
      name: 'desktop_list_files',
      args: { path: '', limit: 100 },
    }]);
  });

  it('formats only fresh desktop evidence into the answer', () => {
    const records = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"LumiCore","process_name":"lumi-core.exe","pid":3928,"width":1920,"height":1080}',
      ...verifiedTerminalReceipt,
    }, {
      name: 'desktop_running_processes',
      arguments: { top: 20 },
      result: '[{"name":"lumi-core.exe"},{"name":"msedge.exe"}]',
      ...verifiedTerminalReceipt,
    }, {
      name: 'desktop_idle_time',
      arguments: {},
      result: '{"idle_seconds":160}',
      ...verifiedTerminalReceipt,
    }];
    const taskText = '\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001';
    const text = formatDesktopObservationResult(records, taskText);

    expect(text).toContain('\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aLumiCore');
    expect(text).toContain('lumi-core.exe');
    expect(text).toContain('\u5df2\u8bfb\u53d6 2 \u6761\u6d3b\u8dc3\u8fdb\u7a0b\u8bb0\u5f55');
    expect(text).toContain('\u7ea6 160 \u79d2');
    expect(text).toContain('\u6ca1\u6709\u6267\u884c\u70b9\u51fb');

    const finalized = finalizeLumiResponse({
      taskText,
      responseText: text || '',
      toolRecords: records,
      source: 'chat',
    });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toBe(text);
  });

  it('formats desktop AI evidence without unrelated process or app noise', () => {
    const records = [{
      name: 'desktop_running_processes',
      arguments: { top: 240 },
      result: '[{"name":"explorer.exe"},{"name":"ChatGPT.exe"},{"name":"claude.exe"}]',
      ...verifiedTerminalReceipt,
    }, {
      name: 'desktop_list_apps',
      arguments: { limit: 200 },
      result: '[{"app_id":"codex","label":"Codex","path":"C:\\\\Users\\\\tester\\\\Desktop\\\\Codex.lnk"},{"app_id":"autocad","label":"AutoCAD"}]',
      ...verifiedTerminalReceipt,
    }];

    const text = formatDesktopObservationResult(
      records,
      'Inspect running desktop AI applications and launchable AI apps.',
    );

    expect(text).toContain('ChatGPT.exe');
    expect(text).toContain('claude.exe');
    expect(text).toContain('Codex');
    expect(text).not.toContain('explorer.exe');
    expect(text).not.toContain('AutoCAD');
  });

  it('deduplicates desktop AI evidence and trusts normalized app ids over noisy paths', () => {
    const records = [{
      name: 'desktop_running_processes',
      arguments: {},
      result: '[{"name":"claude.exe"},{"name":"Claude.exe"},{"name":"codex.exe"}]',
      ...verifiedTerminalReceipt,
    }, {
      name: 'desktop_list_apps',
      arguments: {},
      result: '[{"app_id":"claude","label":"Claude","path":"C:\\\\Claude.exe"},{"app_id":"claude","label":"Claude","path":"C:\\\\Claude.lnk"},{"app_id":"vscode","label":"Visual Studio Code","path":"C:\\\\.codex\\\\Code.exe"},{"app_id":"lmstudio","label":"LM Studio","path":"C:\\\\LM Studio.exe"}]',
      ...verifiedTerminalReceipt,
    }];

    const text = formatDesktopObservationResult(
      records,
      'Inspect running desktop AI applications and locally launchable AI applications.',
    );

    expect(text).toContain('Running desktop AI evidence: claude.exe, codex.exe.');
    expect(text).toContain('Launchable desktop AI evidence: Claude, LM Studio.');
    expect(text).not.toContain('Visual Studio Code');
  });

  it('answers a desktop software-count question from shortcut evidence directly', () => {
    const records = [{
      name: 'desktop_list_files',
      arguments: { path: 'C:\\Users\\tester\\Desktop', limit: 200 },
      result: JSON.stringify([
        { name: 'AutoCAD.lnk', path: 'C:\\Users\\tester\\Desktop\\AutoCAD.lnk', type: 'file' },
        { name: '微信.lnk', path: 'C:\\Users\\tester\\Desktop\\微信.lnk', type: 'file' },
        { name: '说明.txt', path: 'C:\\Users\\tester\\Desktop\\说明.txt', type: 'file' },
        { name: '项目', path: 'C:\\Users\\tester\\Desktop\\项目', type: 'directory' },
      ]),
      ...verifiedTerminalReceipt,
    }];

    const text = formatDesktopObservationResult(records, '你看一下，我现在桌面上有多少个软件。');
    expect(text).toBe('桌面上有 2 个软件快捷方式。');

    const finalized = finalizeLumiResponse({
      taskText: '你看一下，我现在桌面上有多少个软件。',
      responseText: '本轮桌面状态读取已完成。',
      toolRecords: records,
      source: 'voice',
    });
    expect(finalized.text).toBe('桌面上有 2 个软件快捷方式。');
    expect(finalized.blocked).toBe(false);
  });
});
