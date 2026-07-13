import { describe, expect, it } from 'vitest';
import {
  buildDesktopObservationPlan,
  formatDesktopObservationResult,
} from '../server/cognition/desktop_observation';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';

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

  it('formats only fresh desktop evidence into the answer', () => {
    const records = [{
      name: 'desktop_active_window',
      arguments: {},
      result: '{"title":"Lumi OS","process_name":"lumi-os.exe","pid":3928,"width":1920,"height":1080}',
    }, {
      name: 'desktop_running_processes',
      arguments: { top: 20 },
      result: '[{"name":"lumi-os.exe"},{"name":"msedge.exe"}]',
    }, {
      name: 'desktop_idle_time',
      arguments: {},
      result: '{"idle_seconds":160}',
    }];
    const taskText = '\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001';
    const text = formatDesktopObservationResult(records, taskText);

    expect(text).toContain('\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aLumi OS');
    expect(text).toContain('lumi-os.exe');
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
    }, {
      name: 'desktop_list_apps',
      arguments: { limit: 200 },
      result: '[{"app_id":"codex","label":"Codex","path":"C:\\\\Users\\\\tester\\\\Desktop\\\\Codex.lnk"},{"app_id":"autocad","label":"AutoCAD"}]',
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
    }, {
      name: 'desktop_list_apps',
      arguments: {},
      result: '[{"app_id":"claude","label":"Claude","path":"C:\\\\Claude.exe"},{"app_id":"claude","label":"Claude","path":"C:\\\\Claude.lnk"},{"app_id":"vscode","label":"Visual Studio Code","path":"C:\\\\.codex\\\\Code.exe"},{"app_id":"lmstudio","label":"LM Studio","path":"C:\\\\LM Studio.exe"}]',
    }];

    const text = formatDesktopObservationResult(
      records,
      'Inspect running desktop AI applications and locally launchable AI applications.',
    );

    expect(text).toContain('Running desktop AI evidence: claude.exe, codex.exe.');
    expect(text).toContain('Launchable desktop AI evidence: Claude, LM Studio.');
    expect(text).not.toContain('Visual Studio Code');
  });
});
