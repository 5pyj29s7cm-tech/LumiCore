import { describe, expect, it } from 'vitest';
import {
  buildDesktopExecutionPlan,
  resolveDesktopApplicationIdentity,
  verifyDesktopExecutionReceipt,
  desktopFingerprintMatchesApplication,
} from '../server/desktop/execution_plan';

describe('desktop execution plan', () => {
  it('resolves certified core applications by semantic identity', () => {
    expect(resolveDesktopApplicationIdentity('在 WPS 里新建文档').id).toBe('office-suite');
    expect(resolveDesktopApplicationIdentity('打开 AutoCAD 图纸').id).toBe('autocad-desktop');
    expect(resolveDesktopApplicationIdentity('check the page in Chrome').id).toBe('desktop-browser');
    expect(resolveDesktopApplicationIdentity('查看微信消息').id).toBe('wechat-desktop');
  });

  it('matches application identity using process or window evidence', () => {
    const browser = resolveDesktopApplicationIdentity('Chrome');
    expect(desktopFingerprintMatchesApplication({ processName: 'chrome.exe', title: 'Lumi - Google Chrome' }, browser)).toBe(true);
    expect(desktopFingerprintMatchesApplication({ processName: 'notepad.exe', title: 'Notes' }, browser)).toBe(false);
  });

  it('uses adapter then UIA then vision for certified CAD work', () => {
    const plan = buildDesktopExecutionPlan({ text: '在 AutoCAD 中绘图', lane: 'design_cad', taskId: 'cad-task' });
    expect(plan.application.id).toBe('autocad-desktop');
    expect(plan.application.controlLayers).toEqual(['dedicated_adapter', 'windows_uia', 'vision']);
    expect(plan.recovery).toMatchObject({
      replanOnWindowChange: true,
      stopOnTargetMismatch: true,
      allowLegacyRoute: false,
      allowVisionCommit: false,
    });
  });

  it('removes vision from external commit steps and requires confirmation', () => {
    const plan = buildDesktopExecutionPlan({
      text: '微信发送消息给 Alice',
      lane: 'messaging',
      capabilityExecutionPlan: {
        schemaVersion: 1,
        planId: 'cap-plan',
        taskId: 'send-task',
        intent: { kind: 'messaging_send', operation: 'mutate', subject: 'user', target: 'Alice', payload: 'hello', sideEffectClass: 'external_commit', relation: 'new', confidence: 1, rule: 'test' },
        nodes: [], edges: [], expectedEvidence: [], contextRefs: [],
        risk: { sideEffectClass: 'external_commit', requiresConfirmation: true, failClosed: true, reasons: [] },
        fallbackPolicy: { retryClass: 'none', maxRetries: 0, jitter: false, reconcileUnknownOutcome: true, allowLegacyRoute: false, onTargetMismatch: 'stop', onUnknownOutcome: 'reconcile_then_stop' },
        decisionAuthority: 'semantic_planner', scriptAuthority: 'adapter_only',
      },
    });
    const actionSteps = plan.steps.filter(step => step.operation === 'commit');
    expect(actionSteps.length).toBeGreaterThan(0);
    expect(actionSteps.every(step => step.layer !== 'vision')).toBe(true);
    expect(actionSteps.every(step => step.requiresConfirmation)).toBe(true);
    expect(plan.recovery.maxObservationRetries).toBe(0);
  });

  it('does not verify completion when any step or application identity is unverified', () => {
    const plan = buildDesktopExecutionPlan({ text: '打开 AutoCAD', lane: 'design_cad', taskId: 'cad-task' });
    const receipt = verifyDesktopExecutionReceipt(plan, {
      planId: plan.planId,
      taskId: plan.taskId,
      applicationMatched: true,
      evidence: [],
      steps: plan.steps.map((step, index) => ({
        stepId: step.stepId,
        status: index === plan.steps.length - 1 ? 'failed' : 'verified',
        layer: step.layer,
        applicationMatched: true,
        evidence: [],
      })),
    });
    expect(receipt.completionVerified).toBe(false);
    expect(receipt.finalState).toBe('failed');
  });
});
