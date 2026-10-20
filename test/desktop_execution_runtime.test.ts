import { describe, expect, it } from 'vitest';
import { buildDesktopExecutionPlan } from '../server/desktop/execution_plan';
import {
  DesktopExecutionTracker,
  withDesktopExecutionReceipt,
} from '../server/desktop/execution_runtime';
import { brandCanonicalToolExecutionRecord } from '../server/tools/canonical_execution_record';
import type { ToolExecutionRecord } from '../server/tools/types';

// Pure tracker algorithm fixtures have no execution owner. They cannot prove a
// task ran or produce a usable aggregate; the separate binding suite uses the real engine.
function verifiedRecord(name: string, result: string, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return brandCanonicalToolExecutionRecord({
    id: `record-${name}`,
    name,
    arguments: {},
    result,
    terminalVerification: {
      status: 'verified',
      strategy: 'terminal_receipt',
      reason: 'test evidence',
      evidence: [],
    },
    ...overrides,
  } as ToolExecutionRecord, { argumentsDigest: '', targetDigest: '' });
}

describe('desktop execution runtime', () => {
  it('keeps client state actions outside the external player window lease', () => {
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({
      text: '进入壁纸模式，继续当前优酷的视频播放',
      lane: 'desktop_control',
      taskId: 'wallpaper-with-player',
    }));
    const client = { lane: 'client', operation: 'mutate', sideEffects: [{ type: 'desktop_control' }] } as any;
    expect(tracker.authorize('client_action', client).allowed).toBe(true);
    tracker.record(verifiedRecord('client_action', JSON.stringify({ ok: true, verification: { status: 'verified' } }), {
      arguments: { action: 'set_wallpaper_mode', enabled: true },
      capability: client,
    }));
    expect(tracker.toToolExecutionRecord()).toBeNull();
    expect(tracker.authorize('computer_use').allowed).toBe(false);
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({ title: '优酷', process_name: 'Youku.exe', pid: 4567 })));
    expect(tracker.authorize('computer_use').allowed).toBe(true);
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({ title: 'WPS', process_name: 'wps.exe', pid: 100 })));
    expect(tracker.authorize('computer_use').allowed).toBe(false);
    expect(tracker.authorize('client_action', client).allowed).toBe(true);
  });

  it('binds default content snapshots to the identified window without renewing input authority', () => {
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: 'open Google Chrome', lane: 'desktop_control', taskId: 'browser-read' }));
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({ title: 'DeepSeek - Google Chrome', process_name: 'chrome.exe', pid: 42, window_id: 123 })));
    expect(tracker.bindSnapshotArguments({ maxDepth: 4 })).toEqual({ maxDepth: 4, root: 'desktop', processId: 42, nativeWindowHandle: 123 });
    for (const explicit of [{ root: 'focused' }, { root: 'desktop' }, { processId: 90 }, { nameContains: 'Other' }]) {
      expect(tracker.bindSnapshotArguments(explicit)).toBe(explicit);
    }
    const before = tracker.receipt();
    tracker.record(verifiedRecord('desktop_capture_screen', JSON.stringify({ imageBase64: 'content-only' })));
    tracker.record(verifiedRecord('desktop_ui_snapshot', JSON.stringify({ status: 'ok', tree: { name: 'DeepSeek', processId: 42, nativeWindowHandle: 123 } })));
    expect(tracker.receipt()).toEqual(before);
    tracker.record(verifiedRecord('desktop_keyboard_type', JSON.stringify({ status: 'verified' })));
    tracker.record(verifiedRecord('desktop_ui_snapshot', JSON.stringify({ status: 'ok', tree: { name: 'DeepSeek' } })));
    expect(tracker.authorize('desktop_keyboard_type').allowed).toBe(false);
  });
  it('does not apply a foreground lease to background Office file creation', () => {
    const plan = buildDesktopExecutionPlan({ text: '用 WPS 制作一份文档', lane: 'desktop_control', taskId: 'background-office' });
    const tracker = new DesktopExecutionTracker(plan);
    for (const name of ['create_docx', 'create_xlsx']) {
      expect(tracker.authorize(name, { lane: 'office', operation: 'mutate', sideEffects: [{ type: 'local_write' }] } as any).allowed).toBe(true);
    }
    expect(tracker.authorize('desktop_keyboard_type').allowed).toBe(false);
  });
  function externalWechatPlan(taskId: string) {
    return buildDesktopExecutionPlan({
      text: '微信发送消息给 Alice',
      lane: 'messaging',
      taskId,
      actionIntent: { kind: 'messaging_send', operation: 'mutate', subject: 'user', target: 'Alice', payload: 'hello', sideEffectClass: 'external_commit', relation: 'new', confidence: 1, rule: 'test' },
    });
  }

  it('requires a fresh matching foreground observation before every actuation', () => {
    const plan = buildDesktopExecutionPlan({
      text: '在 AutoCAD 中绘图',
      lane: 'design_cad',
      taskId: 'cad-runtime-task',
    });
    const tracker = new DesktopExecutionTracker(plan);

    expect(tracker.authorize('cad_prepare_autocad_operations').allowed).toBe(false);
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'Drawing1.dwg',
      process_name: 'acad.exe',
      pid: 42,
    })));
    expect(tracker.authorize('cad_prepare_autocad_operations').allowed).toBe(true);
    tracker.record(verifiedRecord('cad_prepare_autocad_operations', JSON.stringify({ status: 'verified' })));
    expect(tracker.authorize('cad_draw_floorplan_in_autocad').allowed).toBe(false);

    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'Drawing1.dwg',
      process_name: 'acad.exe',
      pid: 42,
    })));
    expect(tracker.receipt()).toMatchObject({
      applicationMatched: true,
      finalState: 'verified_success',
      completionVerified: true,
    });
  });

  it('stops with target_mismatch when focus moves to a substitute application', () => {
    const plan = buildDesktopExecutionPlan({
      text: '打开 AutoCAD',
      lane: 'design_cad',
      taskId: 'cad-mismatch-task',
    });
    const tracker = new DesktopExecutionTracker(plan);
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'Drawing1.dwg', process_name: 'acad.exe', pid: 42,
    })));
    tracker.record(verifiedRecord('desktop_open', JSON.stringify({ status: 'verified' })));
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'AutoCAD help', process_name: 'chrome.exe', pid: 51,
    })));

    expect(tracker.receipt()).toMatchObject({
      applicationMatched: false,
      finalState: 'target_mismatch',
      completionVerified: false,
    });
  });

  it('can open an exact target that was not already in the foreground', () => {
    const plan = buildDesktopExecutionPlan({
      text: 'open WPS',
      lane: 'desktop_control',
      taskId: 'wps-open-from-lumi',
    });
    const tracker = new DesktopExecutionTracker(plan);
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'LumiCore', process_name: 'lumi-core.exe', pid: 10,
    })));
    expect(tracker.authorize('desktop_open')).toMatchObject({ allowed: true });
    tracker.record(verifiedRecord('desktop_open', JSON.stringify({
      ok: true,
      status: 'verified',
      target: 'WPS',
      targetMatched: true,
      actualTarget: { title: 'WPS Writer', processName: 'wps.exe' },
    })));
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'Document1 - WPS Writer', process_name: 'wps.exe', pid: 20,
    })));

    expect(tracker.receipt()).toMatchObject({
      applicationMatched: true,
      finalState: 'verified_success',
      completionVerified: true,
    });
  });

  it('does not promote unbound diagnostic tracker snapshots into execution receipts', () => {
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: 'open WPS', lane: 'desktop_control', taskId: 'unbound-diagnostic-plan' }));
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({ title: 'WPS Writer', process_name: 'wps.exe', pid: 20 })));
    tracker.record(verifiedRecord('desktop_open', JSON.stringify({ ok: true, status: 'verified', targetMatched: true, verificationBasis: 'post_open_foreground', actualTarget: { title: 'WPS Writer', processName: 'wps.exe', pid: 20 } })));
    expect(tracker.receipt()).toMatchObject({ completionVerified: true, finalState: 'verified_success' });
    expect(withDesktopExecutionReceipt([], tracker)).toEqual([]);
    expect(tracker.toToolExecutionRecord()).toBeNull();
  });

  it('treats heuristic plan membership as advisory while retaining identity and freshness gates', () => {
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({
      text: '打开 AutoCAD', lane: 'design_cad', taskId: 'cad-scope-task',
    }));
    expect(tracker.authorize('wechat_send_message')).toMatchObject({
      allowed: false,
    });
    expect(tracker.authorize('desktop_run_command')).toMatchObject({ allowed: false });
    expect(tracker.authorize('run_command')).toMatchObject({ allowed: false });
    expect(tracker.authorize('read_file')).toMatchObject({ allowed: true });

    const futureAdapter = {
      lane: 'desktop' as const,
      operation: 'mutate' as const,
      sideEffects: [{
        type: 'desktop_control' as const,
        scope: 'foreground_application',
        reversible: true,
      }],
    };
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'Drawing1.dwg', process_name: 'acad.exe', pid: 42,
    })));
    expect(tracker.authorize('future_desktop_adapter', futureAdapter)).toMatchObject({
      allowed: true,
      reason: 'desktop_plan_membership_advisory',
    });
    tracker.record(verifiedRecord('future_desktop_adapter', JSON.stringify({ status: 'verified' }), {
      capability: {
        capabilityId: 'desktop.future_adapter',
        ...futureAdapter,
        risk: 'medium',
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: [],
          successSignals: [],
          limitations: [],
        },
      },
    }));
    const afterActuation = tracker.authorize('future_desktop_adapter', futureAdapter);
    expect(afterActuation.allowed).toBe(false);
    expect(afterActuation.reason.toLocaleLowerCase()).toContain('fresh, unused');
  });

  it('invalidates the plan after a popup, application restart, DPI or display geometry change', () => {
    const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({
      text: 'Draw in AutoCAD', lane: 'design_cad', taskId: 'cad-window-change-task',
    }));
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'Drawing1.dwg', process_name: 'acad.exe', pid: 42, hwnd: 100,
      bounds: { x: 0, y: 0, width: 1200, height: 800 }, dpiScale: 1, displayId: 'display-1',
    })));
    tracker.record(verifiedRecord('cad_prepare_autocad_operations', JSON.stringify({ status: 'verified' })));
    tracker.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: 'AutoCAD warning', process_name: 'acad.exe', pid: 42, hwnd: 101,
      bounds: { x: 10, y: 10, width: 800, height: 500 }, dpiScale: 1.25, displayId: 'display-2',
    })));

    expect(tracker.receipt()).toMatchObject({ completionVerified: false, finalState: 'blocked' });
    expect(tracker.authorize('cad_draw_floorplan_in_autocad')).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/must be rebuilt/i),
    });
  });

  it('blocks external commits until the foreground binary is fully certified', () => {
    const conditional = new DesktopExecutionTracker(externalWechatPlan('wechat-conditional'));
    conditional.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: '微信', process_name: 'Weixin.exe', pid: 75,
    })));
    expect(conditional.authorize('wechat_send_message')).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/fully certified/i),
    });

    const certified = new DesktopExecutionTracker(externalWechatPlan('wechat-certified'));
    certified.record(verifiedRecord('desktop_active_window', JSON.stringify({
      title: '微信',
      process_name: 'Weixin.exe',
      pid: 76,
      executable_path: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
      publisher: 'CN=Tencent Technology (Shenzhen) Company Limited',
      product_name: 'Weixin',
      product_version: '4.0.6.23',
      signature_status: 'Valid',
    })));
    expect(certified.authorize('wechat_send_message')).toMatchObject({ allowed: true });
  });
});
