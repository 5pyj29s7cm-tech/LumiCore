import { describe, expect, it } from 'vitest';
import {
  buildDesktopExecutionPlan,
  resolveDesktopApplicationIdentity,
  verifyDesktopExecutionReceipt,
  desktopFingerprintMatchesApplication,
  desktopFingerprintMatchesRequestedTarget,
  assessDesktopApplicationIdentity,
} from '../server/desktop/execution_plan';

describe('desktop execution plan', () => {
  it('resolves certified core applications by semantic identity', () => {
    expect(resolveDesktopApplicationIdentity('在 WPS 里新建文档').id).toBe('wps-writer');
    expect(resolveDesktopApplicationIdentity('打开 AutoCAD 图纸').id).toBe('autocad-desktop');
    expect(resolveDesktopApplicationIdentity('check the page in Chrome').id).toBe('chrome-browser');
    const wpsWorkflow = '\u4e3b\u7a0b\u5e8f\u5b9e\u673a\u9a8c\u6536\u00b7WPS\u591a\u6b65\u95ed\u73af\uff1a\u8bf7\u6253\u5f00 WPS\uff0c\u7136\u540e\u65b0\u5efa\u4e00\u4e2a Word \u6587\u6863\u5e76\u5199\u5165\u6b63\u6587\u3002';
    expect(resolveDesktopApplicationIdentity(wpsWorkflow).id).toBe('wps-writer');
    expect(buildDesktopExecutionPlan({
      text: wpsWorkflow,
      lane: 'desktop_control',
      taskId: 'wps-multi-step',
    }).application.id).toBe('wps-writer');
    expect(resolveDesktopApplicationIdentity('查看微信消息').id).toBe('wechat-desktop');
  });

  it('does not confuse a Lumi-named document or directory with the Lumi client', () => {
    const request = '\u6253\u5f00\u684c\u9762\u4e0a\u7684Lumi\u9879\u76ee\u4ecb\u7ecd\u8d44\u6599\u6587\u4ef6\u5939\u91cc\u7684Lumi\u4ea7\u54c1\u4ecb\u7ecd\u3002';
    expect(resolveDesktopApplicationIdentity(request).id).toBe('unverified-desktop-application');
    expect(resolveDesktopApplicationIdentity('\u6253\u5f00Lumi\u804a\u5929\u754c\u9762').id).toBe('lumi-client');

    const plan = buildDesktopExecutionPlan({
      text: request,
      lane: 'desktop_control',
      taskId: 'lumi-document-open',
    });
    expect(plan.steps.some(step => step.allowedTools.includes('desktop_open'))).toBe(true);
    expect(plan.steps.some(step => step.allowedTools.includes('desktop_active_window'))).toBe(true);
    expect(desktopFingerprintMatchesRequestedTarget({
      processName: 'wpp.exe',
      title: 'Lumi\u4ea7\u54c1\u4ecb\u7ecd - WPS Presentation',
    }, request)).toBe(true);
  });

  it('uses exact process identity and never accepts an alternative app or spoofed title', () => {
    const browser = resolveDesktopApplicationIdentity('Chrome');
    expect(desktopFingerprintMatchesApplication({ processName: 'chrome.exe', title: 'Lumi - Google Chrome' }, browser)).toBe(true);
    expect(desktopFingerprintMatchesApplication({ processName: 'msedge.exe', title: 'Google Chrome download' }, browser)).toBe(false);
    expect(desktopFingerprintMatchesApplication({ processName: 'notepad.exe', title: 'Notes' }, browser)).toBe(false);
    const cad = resolveDesktopApplicationIdentity('AutoCAD');
    expect(desktopFingerprintMatchesApplication({ processName: 'chrome.exe', title: 'AutoCAD web page' }, cad)).toBe(false);
    expect(desktopFingerprintMatchesApplication({ processName: 'acad.exe', title: 'Drawing1.dwg' }, cad)).toBe(true);
    const wps = resolveDesktopApplicationIdentity('WPS');
    expect(desktopFingerprintMatchesApplication({ processName: 'WINWORD.EXE', title: 'WPS migration.docx' }, wps)).toBe(false);
  });

  it('accepts a UWP-hosted calculator only when the host window title matches', () => {
    const calculator = resolveDesktopApplicationIdentity('Windows 计算器');
    expect(calculator.id).toBe('windows-calculator');
    expect(desktopFingerprintMatchesRequestedTarget({
      processName: 'ApplicationFrameHost.exe',
      title: '计算器',
    }, 'Windows 计算器')).toBe(true);
    expect(desktopFingerprintMatchesRequestedTarget({
      processName: 'ApplicationFrameHost.exe',
      title: '照片',
    }, 'Windows 计算器')).toBe(false);
    expect(desktopFingerprintMatchesRequestedTarget({
      processName: 'ApplicationFrameHost.exe',
      title: '',
    }, 'Windows 计算器')).toBe(false);
  });

  it('certifies an application only from complete runtime binary and window evidence', () => {
    const chrome = resolveDesktopApplicationIdentity('Chrome');
    const complete = {
      processName: 'chrome.exe',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      publisher: 'CN=Google LLC, O=Google LLC, L=Mountain View',
      productName: 'Google Chrome',
      productVersion: '138.0.7204.169',
      windowClass: 'Chrome_WidgetWin_1',
      signatureStatus: 'Valid',
      title: 'Lumi - Google Chrome',
    };
    expect(assessDesktopApplicationIdentity(complete, chrome)).toMatchObject({
      matched: true,
      certification: 'certified',
      missingSignals: [],
      conflictingSignals: [],
      observedVersion: '138.0.7204.169',
    });
    expect(assessDesktopApplicationIdentity({ processName: 'chrome.exe' }, chrome)).toMatchObject({
      matched: true,
      certification: 'conditional',
    });
    const spoofedPublisher = { ...complete, publisher: 'Unknown Publisher' };
    expect(assessDesktopApplicationIdentity(spoofedPublisher, chrome)).toMatchObject({
      matched: false,
      certification: 'mismatch',
      conflictingSignals: ['publisher'],
    });
    expect(desktopFingerprintMatchesApplication(spoofedPublisher, chrome)).toBe(false);
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
    expect(plan.verification).toMatchObject({
      profile: 'send',
      requiredSignals: expect.arrayContaining([
        'certified target application identity',
        'idempotency-bound delivery or submission receipt',
      ]),
    });
  });

  it('uses independent verification profiles for opening, reading, editing and saving', () => {
    const planFor = (text: string, operation: 'read' | 'create' | 'mutate' | 'navigate') => buildDesktopExecutionPlan({
      text,
      lane: 'desktop_control',
      taskId: `task-${operation}-${text}`,
      capabilityExecutionPlan: {
        schemaVersion: 1,
        planId: `cap-${operation}-${text}`,
        taskId: `task-${operation}-${text}`,
        intent: { kind: 'desktop_operation', operation, subject: 'user', target: 'WPS', payload: '', sideEffectClass: operation === 'read' || operation === 'navigate' ? 'none' : 'local_write', relation: 'new', confidence: 1, rule: 'test' },
        nodes: [], edges: [], expectedEvidence: [], contextRefs: [],
        risk: { sideEffectClass: operation === 'read' || operation === 'navigate' ? 'none' : 'local_write', requiresConfirmation: false, failClosed: false, reasons: [] },
        fallbackPolicy: { retryClass: 'none', maxRetries: 0, jitter: false, reconcileUnknownOutcome: false, allowLegacyRoute: false, onTargetMismatch: 'stop', onUnknownOutcome: 'stop_and_report' },
        decisionAuthority: 'semantic_planner', scriptAuthority: 'adapter_only',
      },
    });
    expect(planFor('打开 WPS', 'navigate').verification.profile).toBe('open');
    expect(planFor('读取 WPS 当前文档', 'read').verification.profile).toBe('read');
    expect(planFor('编辑 WPS 当前文档', 'mutate').verification.profile).toBe('edit');
    expect(planFor('保存 WPS 当前文档', 'mutate').verification.profile).toBe('save');
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
