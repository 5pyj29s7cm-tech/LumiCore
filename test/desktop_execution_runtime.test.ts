import { describe, expect, it } from 'vitest';
import { buildDesktopExecutionPlan } from '../server/desktop/execution_plan';
import { DesktopExecutionTracker } from '../server/desktop/execution_runtime';
import type { ToolExecutionRecord } from '../server/tools/types';

function verifiedRecord(name: string, result: string): ToolExecutionRecord {
  return {
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
  } as ToolExecutionRecord;
}

describe('desktop execution runtime', () => {
  function externalWechatPlan(taskId: string) {
    return buildDesktopExecutionPlan({
      text: '微信发送消息给 Alice',
      lane: 'messaging',
      taskId,
      capabilityExecutionPlan: {
        schemaVersion: 1,
        planId: `cap-${taskId}`,
        taskId,
        intent: { kind: 'messaging_send', operation: 'mutate', subject: 'user', target: 'Alice', payload: 'hello', sideEffectClass: 'external_commit', relation: 'new', confidence: 1, rule: 'test' },
        nodes: [], edges: [], expectedEvidence: [], contextRefs: [],
        risk: { sideEffectClass: 'external_commit', requiresConfirmation: true, failClosed: true, reasons: [] },
        fallbackPolicy: { retryClass: 'none', maxRetries: 0, jitter: false, reconcileUnknownOutcome: true, allowLegacyRoute: false, onTargetMismatch: 'stop', onUnknownOutcome: 'reconcile_then_stop' },
        decisionAuthority: 'semantic_planner', scriptAuthority: 'adapter_only',
      },
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
    tracker.record({
      ...verifiedRecord('future_desktop_adapter', JSON.stringify({ status: 'verified' })),
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
    });
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
