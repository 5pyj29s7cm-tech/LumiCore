import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildActionContract,
  hasCoreActionEvidence,
  requestedDesktopWindowAction,
} from '../server/cognition/action_contract';
import {
  buildRecentActionContinuationBridge,
  type ConversationActionContinuationState,
} from '../server/cognition/action_continuation';
import { guardCurrentAppToolCall, isWpsCreateTask } from '../server/cognition/current_app_execution';
import { buildDesktopObservationPlan, formatDesktopObservationResult } from '../server/cognition/desktop_observation';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
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

describe('receipt-backed current application control', () => {

  it('uses one bounded process snapshot for a running-software question', () => {
    const text = '后台有多少软件在运行';
    expect(buildDesktopObservationPlan(text)).toEqual([{ name: 'desktop_running_processes', arguments: { top: 20 } }]);
    const reply = formatDesktopObservationResult([{
      name: 'desktop_running_processes', arguments: { top: 20 },
      result: JSON.stringify([{ name: 'chrome.exe' }, { name: 'chrome.exe' }, { name: 'WeChat.exe' }]),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic process snapshot' },
    }], text);
    expect(reply).toContain('3 个活跃进程条目');
    expect(reply).toContain('2 个进程名称');
    expect(reply).toContain('当前采样');
  });

  it('recovers a verified app target for a terse window command', async () => {
    const bridge = buildRecentActionContinuationBridge('\u6700\u5927\u5316', [], persistedWps);
    expect(bridge).toContain('- appTarget: WPS');
    expect(requestedDesktopWindowAction('\u6700\u5927\u5316')).toBe('maximize');

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
    expect(isWpsCreateTask(taskText, persistedWps.appTarget)).toBe(true);
    expect(guardCurrentAppToolCall({
      taskText,
      currentAppTarget: persistedWps.appTarget,
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
    expect(isWpsCreateTask(instruction)).toBe(true);
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
    expect(isWpsCreateTask(`${instruction}\n\n${bridge}`, persistedWps.appTarget)).toBe(true);
  });

  it('reports verified partial progress instead of erasing a successful open', () => {
    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u7f51\u6613\u4e91\u97f3\u4e50\uff0c\u7ee7\u7eed\u64ad\u653e',
      responseText: '\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u7f51\u6613\u4e91\u97f3\u4e50' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: '\u7f51\u6613\u4e91\u97f3\u4e50',
          targetMatched: true,
          actualTarget: { title: '\u6708\u7259\u513f - Ice Paper', processName: 'cloudmusic.exe' },
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'The observed foreground process matched the requested player.',
        },
      }],
      source: 'voice',
    });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u5df2\u6253\u5f00\u7f51\u6613\u4e91\u97f3\u4e50');
    expect(result.text).toContain('没有确认你要的内容已经开始播放');
    expect(result.text).not.toMatch(/desktop_|target_mismatch|\u8bc1\u636e|\u56de\u6267/iu);
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
