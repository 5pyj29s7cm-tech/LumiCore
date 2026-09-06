import { describe, expect, it } from 'vitest';
import { buildDesktopExecutionPlan, resolveDesktopApplicationIdentity } from '../server/desktop/execution_plan';
import { createDesktopExecutionTracker } from '../server/desktop/execution_runtime';
import { buildDeterministicLocalDesktopNavigationCommand, isQuickCommand, matchQuickCommand } from '../server/cognition/quick_commands';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';

describe('natural playback reaches the actual player and the full execution loop', () => {
  it.each([
    '用爱奇艺播放蜡笔小新第一集',
    '打开爱奇艺并播放蜡笔小新第一集',
    '打开爱奇艺，然后播放《蜡笔小新》第八季第一集。',
  ])('uses the player name with a real-shaped foreground rather than the command sentence: %s', text => {
    const plan = buildDesktopExecutionPlan({ text, lane: 'desktop_control', taskId: 'synthetic-playback-entry' });
    expect(plan.expectedWindow.requestedTarget).toBe('爱奇艺');
    // This player is not newly certified by changing a natural-language parser.
    expect(plan.application.family).toBe('unknown');
    const tracker = createDesktopExecutionTracker(plan);
    expect(tracker.authorize('computer_use').allowed).toBe(false);
    tracker.record({ name: 'desktop_active_window', arguments: {}, result: JSON.stringify({
      title: '爱奇艺 - 蜡笔小新第一集', process_name: 'QyClient.exe', pid: 3456,
    }), terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic native foreground' } });
    expect(tracker.authorize('computer_use').allowed).toBe(true);
    tracker.record({ name: 'desktop_active_window', arguments: {}, result: JSON.stringify({
      title: '优酷 - 蜡笔小新第一集', process_name: 'Youku.exe', pid: 4567,
    }), terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic different foreground' } });
    expect(tracker.authorize('computer_use').allowed).toBe(false);
  });
  it('does not mistake the requested programme title for an application', () => {
    expect(resolveDesktopApplicationIdentity('用爱奇艺播放《WPS》第一集').family).toBe('unknown');
    const ordinary = buildDesktopExecutionPlan({ text: '打开 WPS', lane: 'desktop_control' });
    expect(ordinary.application.id).toBe('wps-writer');
    expect(ordinary.expectedWindow.requestedTarget).toBe('打开 WPS');
  });
  it.each([
    '打开爱奇艺并播放蜡笔小新第一集',
    '打开爱奇艺，然后播放蜡笔小新第一集。',
    'Open YouTube and play Shin Chan episode one',
    '打开网易云并播放秋天不回来',
  ])('does not let an open-only shortcut consume the complete playback goal: %s', async task => {
    expect(buildDeterministicLocalDesktopNavigationCommand(normalizeActionIntent(task), task)).toBeNull();
    expect(isQuickCommand(task)).toBe(false);
    expect(await matchQuickCommand(task, 'synthetic-playback-user')).toBeNull();
  });
  it('retains the existing quick command for an actual open-only request', async () => {
    const task = '打开爱奇艺';
    expect(buildDeterministicLocalDesktopNavigationCommand(normalizeActionIntent(task), task)?.toolCall)
      .toMatchObject({ name: 'desktop_open', arguments: { target: '爱奇艺' } });
    expect(await matchQuickCommand(task, 'synthetic-playback-user')).toMatchObject({ toolCall: { name: 'desktop_open', arguments: { target: '爱奇艺' } } });
  });
});
