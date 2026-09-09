import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(),
  makeLLMCall: mocks.model,
}));

import { initDatabase } from '../db_layer';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { buildDesktopExecutionPlan, desktopFingerprintMatchesRequestedTarget } from '../server/desktop/execution_plan';
import { DesktopExecutionTracker, withDesktopExecutionReceipt } from '../server/desktop/execution_runtime';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolContext } from '../server/tools/types';

const getters = [() => null, () => null, () => null, () => null, () => null] as const;
// Exact native result grammar and window shape observed in the real acceptance
// request. These tests simulate the relay; they never open an application.
const focused = 'Focused running app Calculator (pid 72308, window "计算器")';
const calculator = {
  window_id: '10689404', title: '计算器', process_name: 'CalculatorApp.exe', pid: 72308,
  executable_path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2607.0.0_x64__8wekyb3d8bbwe\\CalculatorApp.exe',
  publisher: 'Microsoft Corporation', product_name: 'Microsoft Calculator', product_version: '11.2607.0.0',
  window_class: 'Windows.UI.Core.CoreWindow', signature_status: 'NotSigned',
  x: 0, y: 1, width: 320, height: 532,
};
let serial = 0;
beforeAll(() => initDatabase());
beforeEach(() => mocks.model.mockReset());

function fixture(window = calculator, openResult = focused, goal = '打开计算器。') {
  const registry = new ToolRegistry();
  registerDesktopTools(registry);
  const taskId = `native-open-task-${++serial}`, requestId = `native-open-request-${serial}`;
  const tracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: goal, lane: 'desktop_control', taskId }));
  const desktopRelay = vi.fn(async (name: string) => {
    if (name === 'desktop_open') return openResult;
    if (name === 'desktop_active_window') return JSON.stringify(window);
    throw new Error(`Unexpected extra desktop operation: ${name}`);
  });
  const context: ToolContext = { userId: 'native-open-user', authRole: 'admin', domain: 'personal',
    taskId, requestId, userConfirmed: true, localExecution: true, source: 'command-center-chat',
    actionIntent: goal, desktopRelay, desktopExecutionTracker: tracker };
  return { registry, context, tracker, desktopRelay, goal };
}

describe('native app focus receipts complete the existing shared loop', () => {
  it('finishes after one real-format focus receipt and its one matching post-open observation', async () => {
    const value = fixture();
    mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'open-calculator', name: 'desktop_open', arguments: { target: 'calc.exe' } },
      { id: 'redundant-process-list', name: 'desktop_running_processes', arguments: {} },
    ] });
    const result = await runWithTools([{ role: 'user', content: value.goal }], value.registry,
      { provider: 'relay', model: 'test-model' }, undefined, 4, ...getters, undefined, value.context);
    expect(result.toolCalls.map(record => record.name)).toEqual(['desktop_open']);
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(value.desktopRelay.mock.calls.map(call => call[0])).toEqual(['desktop_open', 'desktop_active_window']);
    const record = result.toolCalls[0];
    expect(record.envelope?.status).toBe('verified_success');
    expect(JSON.parse(record.result)).toMatchObject({ targetMatched: true, verificationBasis: 'post_open_foreground',
      actualTarget: { processId: 72308, processName: 'CalculatorApp.exe', executablePath: calculator.executable_path, nativeWindowHandle: 10689404 } });
    expect(value.tracker.receipt()).toMatchObject({ completionVerified: true, applicationMatched: true, finalState: 'verified_success' });
    const final = finalizeLumiResponse({ taskText: value.goal, responseText: result.text, source: 'chat',
      taskId: value.context.taskId, requestId: value.context.requestId,
      toolRecords: withDesktopExecutionReceipt(result.toolCalls, value.tracker) });
    expect(final.blocked).toBe(false);
    expect(final.text).toContain('计算器');
  });

  it('uses the same PID binding and embedded observation for another catalog application', async () => {
    const value = fixture({ ...calculator, process_name: 'chrome.exe', title: 'New tab - Google Chrome',
      executable_path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      publisher: 'Google LLC', product_name: 'Google Chrome', window_class: 'Chrome_WidgetWin_1', signature_status: 'Valid',
    }, 'Focused running app Google Chrome (pid 72308, window "New tab - Google Chrome")', 'Open Google Chrome.');
    const record = await executeToolCall({ registry: value.registry, name: 'desktop_open',
      arguments: { target: 'Google Chrome' }, context: value.context });
    expect(record.envelope?.status).toBe('verified_success');
    expect(value.tracker.receipt()).toMatchObject({ completionVerified: true, applicationMatched: true });
    expect(value.desktopRelay).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['different PID for the same application', { ...calculator, pid: 72309 }],
    ['another process with the same PID and a calculator title', { ...calculator, process_name: 'notepad.exe', executable_path: 'C:\\Windows\\System32\\notepad.exe' }],
    ['an executable path that contradicts the reported process', { ...calculator, executable_path: 'C:\\Windows\\System32\\notepad.exe' }],
  ])('rejects %s instead of ending the task successfully', async (_label, window) => {
    const value = fixture(window);
    const record = await executeToolCall({ registry: value.registry, name: 'desktop_open',
      arguments: { target: 'calc.exe' }, context: value.context });
    expect(record.envelope?.status).toBe('target_mismatch');
    expect(record.terminalVerification?.status).toBe('failed');
    expect(value.tracker.receipt().completionVerified).toBe(false);
    expect(value.desktopRelay.mock.calls.filter(call => call[0] === 'desktop_open')).toHaveLength(1);
  }, 10_000);

  it('resolves the catalog launcher alias without accepting prefix lookalikes or other applications', () => {
    const fingerprint = { processName: 'CalculatorApp.exe', executablePath: calculator.executable_path, title: calculator.title };
    expect(desktopFingerprintMatchesRequestedTarget(fingerprint, 'calc.exe')).toBe(true);
    expect(desktopFingerprintMatchesRequestedTarget(fingerprint, 'C:\\Windows\\System32\\calc.exe')).toBe(true);
    expect(desktopFingerprintMatchesRequestedTarget(fingerprint, 'calc-helper.exe')).toBe(false);
    expect(desktopFingerprintMatchesRequestedTarget({ ...fingerprint, processName: 'notepad.exe' }, 'calc.exe')).toBe(false);
  });
});
