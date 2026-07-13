import { describe, expect, it } from 'vitest';
import {
  buildRecentActionContinuationBridge,
  needsRecentActionContinuationContext,
} from '../server/cognition/action_continuation';

describe('recent action continuation', () => {
  it('recognizes terse and referential continuations without capturing complete new tasks', () => {
    expect(needsRecentActionContinuationContext('执行绘图')).toBe(true);
    expect(needsRecentActionContinuationContext('按照里面的要求继续')).toBe(true);
    expect(needsRecentActionContinuationContext('后台继续这个任务')).toBe(true);
    expect(needsRecentActionContinuationContext('draw it')).toBe(true);
    expect(needsRecentActionContinuationContext('画一只戴帽子的猫')).toBe(false);
  });

  it('restores the recent target, application, path, blocker, and tool evidence', () => {
    const bridge = buildRecentActionContinuationBridge('执行绘图', [
      {
        role: 'user',
        message: '读取桌面阿陆文件夹里的户型图，并在 AutoCAD 中实际画出来。',
      },
      {
        role: 'assistant',
        message: '绘图文件已准备，但真实 AutoCAD 回放还没有完成。',
        toolCalls: JSON.stringify([{
          name: 'mcp_cad-drafting_autocad_playback_file',
          arguments: { operationsPath: 'C:\\Users\\me\\Desktop\\阿陆\\LumiCAD\\plan_operations.json' },
          result: JSON.stringify({
            status: 'blocked',
            completionMarkerExists: false,
            completionMarkerPath: 'C:\\Users\\me\\Desktop\\阿陆\\LumiCAD\\plan.done',
          }),
        }]),
      },
    ]);

    expect(bridge).toContain('Recent action continuation context');
    expect(bridge).toContain('阿陆');
    expect(bridge).toContain('AutoCAD');
    expect(bridge).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(bridge).toContain('status=blocked');
    expect(bridge).toContain('plan_operations.json');
    expect(bridge).toContain('Do not reinterpret');
  });

  it('does not invent continuation context when there is no usable history', () => {
    expect(buildRecentActionContinuationBridge('继续', [])).toBe('');
  });

  it('drops a superseded execution branch after the user corrects the task', () => {
    const bridge = buildRecentActionContinuationBridge('继续', [
      { role: 'user', message: '在 AutoCAD 里画户型图。' },
      {
        role: 'assistant',
        message: '生成了六张业务图表。',
        toolCalls: JSON.stringify([{ name: 'python_exec', result: 'sales_dashboard.png' }]),
      },
      { role: 'user', message: '不是数据图，读取阿陆文件夹并在 AutoCAD 里画出来。' },
      {
        role: 'assistant',
        message: 'AutoCAD 实际绘图仍被完成标记阻塞。',
        toolCalls: JSON.stringify([{
          name: 'mcp_cad-drafting_autocad_playback_file',
          result: JSON.stringify({ status: 'blocked', completionMarkerExists: false }),
        }]),
      },
    ]);

    expect(bridge).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(bridge).toContain('status=blocked');
    expect(bridge).not.toContain('python_exec');
    expect(bridge).not.toContain('六张业务图表');
  });
});
