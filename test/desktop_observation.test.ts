import { describe, expect, it } from 'vitest';
import {
  buildDesktopObservationPlan,
  formatDesktopObservationResult,
} from '../server/cognition/desktop_observation';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';

describe('desktop observation routing', () => {
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
});
