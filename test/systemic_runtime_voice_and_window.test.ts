import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildActionContract,
  hasCoreActionEvidence,
  requestedDesktopWindowAction,
  summarizeActionContractBlocker,
} from '../server/cognition/action_contract';
import {
  buildRecentActionContinuationBridge,
  getRecoveredApplicationContinuationTarget,
  type ConversationActionContinuationState,
} from '../server/cognition/action_continuation';
import { guardCurrentAppToolCall, isRecoveredWpsCreateTask } from '../server/cognition/current_app_execution';
import { matchQuickCommand } from '../server/cognition/quick_commands';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { registerBackgroundTask, resetBackgroundTasksForTest } from '../server/agents/background_tasks';
import { cancelRuntimeWork, getRuntimeWorkSnapshot } from '../server/runtime/work_control';
import type { ToolExecutionRecord } from '../server/tools/types';

function declaration(name: string, description = name) {
  return { type: 'function' as const, function: { name, description, parameters: { type: 'object', properties: {} } } };
}

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

const persistedWps: ConversationActionContinuationState = {
  version: 1,
  goal: '\u6253\u5f00 WPS\u3002',
  latestInstruction: '\u6253\u5f00 WPS\u3002',
  appTarget: 'WPS',
  sourcePaths: [],
  latestBlocker: '',
  unfinished: false,
  evidenceTools: ['desktop_open'],
  assistantState: '\u5df2\u6253\u5f00 WPS\u3002',
  toolSummaries: ['desktop_open | status=opened'],
  updatedAt: new Date().toISOString(),
};

describe('systemic runtime work control', () => {
  it('routes status and cancellation to the unified ledger', () => {
    const tools = [declaration('runtime_work_status'), declaration('runtime_work_cancel'), declaration('desktop_running_processes')];
    expect(buildActionContract('\u540e\u53f0\u4efb\u52a1\u8fdb\u5ea6\u600e\u4e48\u6837').kind).toBe('task_control');
    expect(routeToolsForTurn('\u540e\u53f0\u4efb\u52a1\u8fdb\u5ea6\u600e\u4e48\u6837', tools).toolNames).toContain('runtime_work_status');
    expect(routeToolsForTurn('\u505c\u6b62\u540e\u53f0\u4efb\u52a1', tools).toolNames).toContain('runtime_work_cancel');
  });

  it('only accepts an exact runtime receipt as cancellation evidence', () => {
    const contract = buildActionContract('\u505c\u6b62\u540e\u53f0\u4efb\u52a1');
    const processRecord: ToolExecutionRecord = {
      name: 'desktop_running_processes', arguments: {}, result: '[]',
    };
    const cancelRecord: ToolExecutionRecord = {
      name: 'runtime_work_cancel',
      arguments: {},
      result: JSON.stringify({ ok: true, status: 'cancelled', matchedCount: 1, cancelledCount: 1 }),
    };
    expect(hasCoreActionEvidence(contract, [processRecord], '\u505c\u6b62\u540e\u53f0\u4efb\u52a1')).toBe(false);
    expect(hasCoreActionEvidence(contract, [cancelRecord], '\u505c\u6b62\u540e\u53f0\u4efb\u52a1')).toBe(true);
  });

  it('cancels a real queued delegation and returns an exact receipt', () => {
    resetBackgroundTasksForTest();
    const userId = 'runtime-work-test';
    registerBackgroundTask({ userId, title: 'test work', prompt: 'test' });
    expect(getRuntimeWorkSnapshot(userId).activeCount).toBe(1);
    const result = cancelRuntimeWork({ userId, kinds: ['delegation'] });
    expect(result).toMatchObject({ ok: true, status: 'cancelled', matchedCount: 1, cancelledCount: 1 });
    expect(getRuntimeWorkSnapshot(userId).activeCount).toBe(0);
    resetBackgroundTasksForTest();
  });

  it('keeps internal routing and evidence vocabulary out of user-visible failures', () => {
    const blocker = summarizeActionContractBlocker(
      buildActionContract('\u628a\u5f53\u524d\u7a97\u53e3\u6700\u5927\u5316'),
      '',
    );
    expect(blocker).not.toMatch(/(?:\u4efb\u52a1\u7c7b\u578b|\u8fd8\u7f3a\u7684\u8bc1\u636e|appTarget|UI evidence|action contract)/i);

    const finalized = finalizeLumiResponse({
      taskText: '\u628a\u5f53\u524d\u7a97\u53e3\u6700\u5927\u5316',
      responseText: 'appTarget=WPS; Required completion evidence: UI evidence; allowedTools missing.',
      toolRecords: [],
      source: 'voice',
    });
    expect(finalized.text).not.toMatch(/(?:appTarget|UI evidence|allowedTools|Required completion evidence)/i);
  });
});

describe('receipt-backed current application control', () => {
  it('uses one bounded process snapshot for a running-software question', async () => {
    const quick = await matchQuickCommand('\u540e\u53f0\u6709\u591a\u5c11\u8f6f\u4ef6\u5728\u8fd0\u884c', 'process-test');
    expect(quick?.toolCall).toEqual({ name: 'desktop_running_processes', arguments: { top: 50 } });
    const reply = quick?.formatToolResult?.(JSON.stringify([
      { name: 'chrome.exe' },
      { name: 'chrome.exe' },
      { name: 'WeChat.exe' },
    ]));
    expect(reply).toContain('3 \u4e2a\u8fdb\u7a0b\u6761\u76ee');
    expect(reply).toContain('2 \u4e2a\u4e0d\u540c\u8fdb\u7a0b\u540d');
    expect(reply).toContain('\u4e0d\u7b49\u540c\u4e8e\u6253\u5f00\u7684\u8f6f\u4ef6\u6570');
  });

  it('recovers a verified app target for a terse window command', async () => {
    const bridge = buildRecentActionContinuationBridge('\u6700\u5927\u5316', [], persistedWps);
    expect(getRecoveredApplicationContinuationTarget(bridge)).toBe('WPS');
    expect(requestedDesktopWindowAction('\u6700\u5927\u5316')).toBe('maximize');
    const quick = await matchQuickCommand('\u6700\u5927\u5316', 'window-test', { currentAppTarget: 'WPS' });
    expect(quick?.toolCall).toEqual({
      name: 'desktop_window_control',
      arguments: { action: 'maximize', expectedTarget: 'WPS' },
    });
  });

  it('requires the native verified window receipt', () => {
    const contract = buildActionContract('\u628a\u5f53\u524d\u7a97\u53e3\u6700\u5927\u5316');
    expect(contract.preferredTools).toContain('desktop_window_control');
    const receipt: ToolExecutionRecord = {
      name: 'desktop_window_control',
      arguments: { action: 'maximize', expectedTarget: 'WPS' },
      result: JSON.stringify({ ok: true, status: 'verified', action: 'maximize', targetMatched: true }),
    };
    expect(hasCoreActionEvidence(contract, [receipt], '\u628a\u5f53\u524d\u7a97\u53e3\u6700\u5927\u5316')).toBe(true);
  });

  it('uses the deterministic WPS path for a real blank document too', () => {
    const instruction = '\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767dWord\u6587\u6863';
    const bridge = buildRecentActionContinuationBridge(instruction, [], persistedWps);
    const taskText = `${instruction}\n\n${bridge}`;
    expect(isRecoveredWpsCreateTask(taskText)).toBe(true);
    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'wps_create_document_with_text',
      arguments: { text: 'model invented text' },
      toolRecords: [],
    })).toMatchObject({ allowed: true, normalizedArguments: { text: '' } });
  });

  it('routes a direct open-and-create WPS request to the visible WPS path', () => {
    const instruction = '\u6253\u5f00WPS\u65b0\u5efaWord\u6587\u6863';
    const tools = [
      declaration('wps_create_document_with_text'),
      declaration('desktop_active_window'),
      declaration('desktop_ui_snapshot'),
      declaration('desktop_open'),
      declaration('create_docx'),
    ];
    const route = routeToolsForTurn(instruction, tools);

    expect(buildActionContract(instruction).kind).toBe('desktop_operation');
    expect(isRecoveredWpsCreateTask(instruction)).toBe(true);
    expect(route.toolNames).toContain('wps_create_document_with_text');
    expect(route.toolNames).not.toContain('create_docx');
    expect(guardCurrentAppToolCall({
      taskText: instruction,
      toolName: 'wps_create_document_with_text',
      arguments: { text: 'invented' },
      toolRecords: [],
    })).toMatchObject({ allowed: true, normalizedArguments: { text: '' } });
  });

  it('recognizes a possessive short document request as a WPS continuation', () => {
    const instruction = '\u65b0\u5efa\u6211\u7684\u6587\u6863';
    const bridge = buildRecentActionContinuationBridge(instruction, [], persistedWps);
    expect(bridge).toContain('Recent action continuation context');
    expect(isRecoveredWpsCreateTask(`${instruction}\n\n${bridge}`)).toBe(true);
  });

  it('reports verified partial progress instead of erasing a successful open', () => {
    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u7f51\u6613\u4e91\u97f3\u4e50\uff0c\u7ee7\u7eed\u64ad\u653e',
      responseText: '\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u7f51\u6613\u4e91\u97f3\u4e50' },
        result: JSON.stringify({ ok: true, status: 'opened', target: '\u7f51\u6613\u4e91\u97f3\u4e50' }),
      }],
      source: 'voice',
    });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u5df2\u6253\u5f00\u7f51\u6613\u4e91\u97f3\u4e50');
    expect(result.text).toContain('\u540e\u7eed\u64cd\u4f5c');
  });

  it('blocks bracketed internal tool protocol and removes false current-mode claims', async () => {
    const leaked = finalizeLumiResponse({
      taskText: '\u5438\u6536\u672c\u5730\u77e5\u8bc6\u5e93',
      responseText: '[\u5207\u6362\u52a9\u624b\u6a21\u5f0f] set_client_mode(assistant)',
      toolRecords: [],
      source: 'voice',
    });
    expect(leaked.blocked).toBe(true);
    expect(leaked.text).not.toContain('set_client_mode');

    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const flow = buildLumiTurnFlow({
      userId: 'mode-grounding-user',
      text: '\u8c01\u5728\u8bf4\u8bdd',
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });
    const grounded = finalizeLumiResponse({
      taskText: '\u8c01\u5728\u8bf4\u8bdd',
      responseText: '\u521a\u624d\u662f\u6211\u5728\u8bf4\u8bdd\u3002\u4e0d\u8fc7\u6211\u73b0\u5728\u662f\u5bf9\u8bdd\u6a21\u5f0f\u3002\u8981\u6267\u884c\u9700\u8981\u5148\u5207\u6362\u5230\u52a9\u624b\u6a21\u5f0f\u3002',
      toolRecords: [],
      source: 'voice',
      flow,
    });
    expect(grounded.text).toContain('\u521a\u624d\u662f\u6211\u5728\u8bf4\u8bdd');
    expect(grounded.text).not.toContain('\u5bf9\u8bdd\u6a21\u5f0f');
    expect(grounded.text).not.toContain('\u5207\u6362\u5230\u52a9\u624b');
  });
});
