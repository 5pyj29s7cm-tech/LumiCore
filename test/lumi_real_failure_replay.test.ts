import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildActionContract,
  hasCoreActionEvidence,
} from '../server/cognition/action_contract';
import {
  buildRecentActionContinuationBridge,
  extractRecentActionContinuationState,
} from '../server/cognition/action_continuation';
import { formatClientDiagnosticResult } from '../server/cognition/client_diagnostic_result';
import { buildLumiCapabilitySelection } from '../server/cognition/capability_selection';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { isQuickCommand, matchQuickCommand } from '../server/cognition/quick_commands';
import { shouldDeferModelOutputUntilFinalized } from '../server/cognition/response_delivery';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';

const TOOL_NAMES = [
  'client_get_state',
  'client_action',
  'work_product_plan',
  'work_product_verify',
  'work_takeover_task_get',
  'work_takeover_task_continue',
  'work_takeover_task_advance',
  'work_takeover_task_autorun',
  'work_takeover_task_verify_result',
  'work_takeover_task_export_packet',
  'desktop_list_apps',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_open',
  'desktop_active_window',
  'desktop_running_processes',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
  'desktop_capture_screen',
  'desktop_mouse_click_at',
  'desktop_keyboard_press',
  'keyboard_type',
  'keyboard_press',
  'computer_use',
  'ocr_image_file',
  'ocr_screen',
  'floorplan_extract_geometry',
  'cad_prepare_autocad_operations',
  'mcp_cad-drafting_autocad_playback_file',
  'cad_generate_dxf',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'mcp_filesystem_read_media_file',
  'mcp_filesystem_read_file',
  'read_file',
  'read_files_batch',
  'list_directory',
  'search_files',
  'grep_files',
  'extract_document_text',
  'read_docx',
  'read_pdf',
  'run_command',
  'desktop_run_command',
  'code_execution',
  'python_exec',
  'certutil',
  'powershell',
  'shell_exec',
  'terminal_exec',
  'wechat_send_message',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object' as const, properties: {} },
  },
}));

const CAD_TASK = '\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\uff0c\u628a\u5b83\u753b\u5230 AutoCAD \u91cc\u3002';

const FAILED_CAD_HISTORY = [
  { role: 'user', message: CAD_TASK },
  {
    role: 'assistant',
    message: '\u56fe\u7247\u8bfb\u53d6\u5931\u8d25\uff0c\u5b9e\u9645\u7ed8\u56fe\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
    toolCalls: JSON.stringify([{
      name: 'ocr_image_file',
      arguments: { path: 'C:\\Users\\tester\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg' },
      error: 'image decoder failed',
    }]),
  },
];

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function decideFromContinuation(
  userId: string,
  text: string,
  continuationContext: string,
  channel: 'chat' | 'voice' = 'voice',
) {
  const dispatch = buildLumiTurnDispatch({
    userId,
    text,
    continuationContext,
    channel,
    source: channel,
    operationMode: 'assistant',
    targetIsLumi: true,
  });
  const decision = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text: dispatch.flow.routeText,
    toolDeclarations: TOOL_NAMES,
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution: decision,
    text: dispatch.flow.routeText,
  });
  return { dispatch, decision, selection };
}

describe('Lumi real failure-chain replay', () => {
  it('accepts the requested AutoCAD receipt and rejects a Paint substitution', () => {
    const task = '\u6253\u5f00 AutoCAD\u3002';
    const contract = buildActionContract(task);
    const correctReceipt = [{
      name: 'desktop_open',
      arguments: { target: 'AutoCAD' },
      result: JSON.stringify({
        ok: true,
        status: 'opened',
        processName: 'acad.exe',
        windowTitle: 'Autodesk AutoCAD',
      }),
    }];
    const wrongReceipt = [{
      name: 'desktop_open',
      arguments: { target: 'mspaint.exe' },
      result: JSON.stringify({
        ok: true,
        status: 'opened',
        processName: 'mspaint.exe',
        windowTitle: 'Microsoft Paint',
      }),
    }];

    expect(contract.kind).toBe('desktop_operation');
    expect(hasCoreActionEvidence(contract, correctReceipt, task)).toBe(true);
    expect(hasCoreActionEvidence(contract, wrongReceipt, task)).toBe(false);

    const accepted = finalizeLumiResponse({
      taskText: task,
      responseText: '\u5df2\u6253\u5f00 AutoCAD\u3002',
      toolRecords: correctReceipt,
      source: 'voice',
    });
    const rejected = finalizeLumiResponse({
      taskText: task,
      responseText: '\u5df2\u6253\u5f00 AutoCAD\u3002',
      toolRecords: wrongReceipt,
      source: 'voice',
    });

    expect(accepted.blocked).toBe(false);
    expect(accepted.text).toContain('AutoCAD');
    expect(rejected.blocked).toBe(true);
    expect(rejected.reason).toBe('Missing core evidence for desktop_operation.');
  });

  it('replays the real topology failure as a geometry receipt result instead of a desktop-window blocker', () => {
    const task = '\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\uff0c\u63d0\u53d6\u51e0\u4f55\u4fe1\u606f\uff0c\u5148\u4e0d\u8981\u7ed8\u5236\uff0c\u53ea\u544a\u8bc9\u6211\u63d0\u53d6\u662f\u5426\u6210\u529f\u3002';
    const result = finalizeLumiResponse({
      taskText: task,
      responseText: '\u5df2\u7ecf\u8bfb\u53d6\u5e76\u5b8c\u6210\u51e0\u4f55\u63d0\u53d6\u3002',
      source: 'chat',
      toolRecords: [{
        name: 'desktop_list_files',
        arguments: { path: 'C:\\Users\\Lumi\\Desktop' },
        result: '[]',
      }, {
        name: 'desktop_system_info',
        arguments: {},
        result: JSON.stringify({ home_dir: 'C:\\Users\\Administrator' }),
      }, {
        name: 'desktop_list_files',
        arguments: { path: 'C:\\Users\\Administrator\\Desktop' },
        result: JSON.stringify([{
          name: '\u8bbe\u8ba1\u8349\u7a3f.jpg',
          path: 'C:\\Users\\Administrator\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg',
          type: 'file',
          size: 103202,
        }]),
      }, {
        name: 'floorplan_extract_geometry',
        arguments: {
          imagePath: 'C:\\Users\\Administrator\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg',
          projectName: '\u8bbe\u8ba1\u8349\u7a3f',
        },
        result: JSON.stringify({
          path: 'C:\\Users\\Administrator\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg',
          image: {
            width: 1280,
            height: 911,
            sourceCrop: {
              detected: true,
              bounds: { left: 77, top: 42, width: 1203, height: 869 },
            },
          },
          provider: 'qwen',
          model: 'qwen-vl-max',
          parsed: false,
          failedStage: 'topology',
          geometryReady: false,
          geometryVerified: false,
          executableGeometryAvailable: false,
          extractionAttempts: 2,
          parseError: 'The exterior-topology pass did not return complete JSON. No partial geometry is exposed for execution.',
          cadGenerateDxfArgs: null,
          cadPrepareAutocadOperationsArgs: null,
          next: 'Retry extraction with the same source or a clearer crop. Do not reconstruct coordinates from partial model output.',
        }),
      }],
    });

    expect(buildActionContract(task).kind).toBe('cad_drafting');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('topology');
    expect(result.text).toContain('\u51e0\u4f55\u63d0\u53d6\u672a\u6210\u529f');
    expect(result.text).toContain('\u5931\u8d25\u9636\u6bb5\uff1atopology');
    expect(result.text).toContain('parsed=false, geometryReady=false, geometryVerified=false');
    expect(result.text).toContain('The exterior-topology pass did not return complete JSON');
    expect(result.text).toContain('Retry extraction with the same source or a clearer crop');
    expect(result.text).not.toMatch(/active window|process\/screen|foreground|activity window/i);
    expect(result.text).not.toContain('\u524d\u53f0\u7a97\u53e3');
  });

  it('recovers WPS for in-app writing and routes visible UI control without task-center tools', () => {
    const history = [
      { role: 'user', message: '\u6253\u5f00 WPS\u3002' },
      {
        role: 'assistant',
        message: '\u5df2\u6253\u5f00 WPS\u3002',
        toolCalls: JSON.stringify([{
          name: 'desktop_open',
          arguments: { target: 'WPS' },
          result: JSON.stringify({
            ok: true,
            status: 'opened',
            processName: 'wps.exe',
            target: 'WPS',
          }),
        }]),
      },
    ];
    const text = '在这里面新建一个空白文档并写入：Lumi端到端回归测试。';
    const state = extractRecentActionContinuationState(history);
    const bridge = buildRecentActionContinuationBridge(text, history);
    const { dispatch, decision, selection } = decideFromContinuation(
      'real_replay_wps_user',
      text,
      bridge,
      'chat',
    );

    expect(state.appTarget).toBe('WPS');
    expect(bridge).toContain('- appTarget: WPS');
    expect(dispatch.flow.routeText).toContain('- appTarget: WPS');
    expect(dispatch.flow.workSurfaceRoute.directDesktop).toBe(true);
    expect(dispatch.flow.workSurfaceRoute.artifactFirst).toBe(false);
    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('none');
    expect(dispatch.flow.executionGovernance.delegationIntent).toBe('foreground_owned');
    expect(selection.lane).toBe('desktop_control');
    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).toContain('external_control');
    expect(decision.toolRoute?.categories).toContain('desktop_control');
    expect(decision.toolRoute?.categories).not.toContain('code_git');
    expect(decision.toolRoute?.categories).not.toContain('capability_learning');
    expect(decision.toolRoute?.categories).not.toContain('artifact_work');
    expect(decision.toolRoute?.categories).not.toContain('documents');
    expect(decision.toolRoute?.categories).not.toContain('task_center');
    expect(decision.toolRoute?.categories).not.toContain('work_takeover');
    expect(decision.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_type',
    ]));
    for (const forbidden of [
      'work_product_plan',
      'write_file',
      'create_docx',
      'list_skills',
      'capability_learning_list',
      'work_takeover_task_continue',
      'computer_use',
      'mouse_move',
      'mouse_click',
      'mouse_drag',
      'keyboard_type',
    ]) {
      expect(decision.toolPolicy.allowedTools).not.toContain(forbidden);
    }
    expect(decision.maxIterations).toBeLessThanOrEqual(10);
    expect(decision.promptOverlay).toContain('Editor-ready gate');
    expect(decision.promptOverlay).toContain('Never repeat the same New/Blank selector');
    expect(decision.toolPolicy.allowedTools.some(name => name.startsWith('work_takeover_task_'))).toBe(false);
  });

  it('routes the desktop design image through built-in desktop/OCR/CAD tools only', () => {
    const route = routeToolsForTurn(CAD_TASK, TOOL_NAMES, {
      maxTools: 64,
      enableMcpHealthGate: false,
    });

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames.slice(0, 4)).toEqual([
      'desktop_list_files',
      'desktop_path_info',
      'floorplan_extract_geometry',
      'ocr_image_file',
    ]);
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
    expect(route.toolNames).not.toContain('cad_generate_dxf');
    expect(route.toolNames).not.toContain('mcp_cad-drafting_cad_renovation_folder_workflow');
    expect(route.toolNames.some(name => name.startsWith('mcp_filesystem_'))).toBe(false);
    for (const forbidden of [
      'read_file',
      'read_files_batch',
      'list_directory',
      'search_files',
      'grep_files',
      'extract_document_text',
      'run_command',
      'desktop_run_command',
      'code_execution',
      'python_exec',
      'certutil',
      'powershell',
      'shell_exec',
      'terminal_exec',
    ]) {
      expect(route.toolNames).not.toContain(forbidden);
    }
  });

  it.each([
    '\u6709\u6ca1\u6709\u5728\u6267\u884c',
    '\u4e3a\u4ec0\u4e48\u6ca1\u5b8c\u6210',
  ])('answers CAD status from saved evidence without restarting tools: %s', text => {
    const bridge = buildRecentActionContinuationBridge(text, FAILED_CAD_HISTORY);
    const { dispatch, decision } = decideFromContinuation(
      `real_replay_status_${text.length}`,
      text,
      bridge,
    );

    expect(bridge).toContain('- followupIntent: status');
    expect(bridge).toContain('\u8bbe\u8ba1\u8349\u7a3f.jpg');
    expect(bridge).toContain('ocr_image_file');
    expect(bridge).toContain('image decoder failed');
    expect(dispatch.flow.routeText).toContain('image decoder failed');
    expect(decision.allowToolUse).toBe(false);
    expect(decision.toolRoute).toBeNull();
    expect(decision.toolPolicy.forbiddenTools).toContain('*');
  });

  it('answers the latest desktop software-count demand instead of falling back to old WeChat state', () => {
    const history = [
      { role: 'user', message: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u6d88\u606f\u3002' },
      {
        role: 'assistant',
        message: '\u5fae\u4fe1\u53d1\u9001\u8fd8\u6ca1\u5b8c\u6210\u3002',
        toolCalls: JSON.stringify([{
          name: 'wechat_send_message',
          arguments: { recipient: '\u963f\u9646' },
          error: 'recipient not found',
        }]),
      },
      { role: 'user', message: '\u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u6709\u591a\u5c11\u8f6f\u4ef6\u3002' },
      {
        role: 'assistant',
        message: '\u5df2\u67e5\u770b\u684c\u9762\u8f6f\u4ef6\u5217\u8868\u3002',
        toolCalls: JSON.stringify([{
          name: 'desktop_list_apps',
          arguments: {},
          result: JSON.stringify([
            { label: 'AutoCAD', path: 'C:\\Program Files\\AutoCAD\\acad.exe' },
            { label: 'WPS Office', path: 'C:\\Program Files\\WPS\\wps.exe' },
          ]),
        }]),
      },
    ];
    const text = '\u6211\u8ba9\u4f60\u770b\u684c\u9762\u591a\u5c11\u8f6f\u4ef6\u4f60\u5012\u662f\u8bf4\u5440';
    const bridge = buildRecentActionContinuationBridge(text, history);
    const { decision } = decideFromContinuation(
      'real_replay_desktop_count_user',
      text,
      bridge,
    );

    expect(bridge).toContain('- followupIntent: status');
    expect(bridge).toContain('desktop_list_apps');
    expect(bridge).toContain('items=2');
    expect(bridge).toContain('sample=AutoCAD | WPS Office');
    expect(bridge).not.toContain('\u963f\u9646');
    expect(bridge).not.toContain('wechat_send_message');
    expect(decision.allowToolUse).toBe(false);
    expect(decision.toolRoute).toBeNull();
  });

  it.each([
    '\u6162\u4e2a\u5c41',
    '\u522b\u5149\u8bf4\u5feb\u505a',
  ])('resumes the recent unfinished CAD task for direct execution pressure: %s', text => {
    const bridge = buildRecentActionContinuationBridge(text, FAILED_CAD_HISTORY);
    const { dispatch, decision } = decideFromContinuation(
      `real_replay_execute_${text.length}`,
      text,
      bridge,
    );

    expect(bridge).toContain('- followupIntent: execute');
    expect(bridge).toContain('\u8bbe\u8ba1\u8349\u7a3f.jpg');
    expect(bridge).toContain('image decoder failed');
    expect(dispatch.flow.routeText).toContain('AutoCAD');
    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).toContain('cad_design');
    expect(decision.toolRoute?.categories).not.toContain('task_center');
    expect(decision.toolRoute?.categories).not.toContain('work_takeover');
    expect(decision.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_list_files',
      'desktop_path_info',
      'floorplan_extract_geometry',
      'ocr_image_file',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
  });

  it.each([
    ['\u786e\u8ba4', '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002'],
    ['\u597d', '\u73b0\u5728\u5c31\u505a\u3002'],
  ])('blocks a zero-tool execution claim: %s -> %s', (taskText, responseText) => {
    const result = finalizeLumiResponse({
      taskText,
      responseText,
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).not.toBe(responseText);
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('answers the microphone audibility check immediately without self-check routing', async () => {
    const text = '\u4f60\u80fd\u542c\u89c1\u6211\u8bf4\u8bdd\u5417\uff1f';
    const quick = await matchQuickCommand(text, 'real_replay_hearing_user', { surface: 'voice' });
    const dispatch = buildLumiTurnDispatch({
      userId: 'real_replay_hearing_user',
      text,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(isQuickCommand(text)).toBe(true);
    expect(quick).toMatchObject({
      matched: true,
      responseText: '\u80fd\u542c\u89c1\u3002\u4f60\u8bf4\u3002',
    });
    expect(quick?.toolCall).toBeUndefined();
    expect(dispatch.flow.selfRepairTurn).toBe(false);
    expect(dispatch.flow.allowToolUseForTurn).toBe(false);
    expect(shouldDeferModelOutputUntilFinalized({
      taskText: text,
      flow: dispatch.flow,
    })).toBe(false);

    const finalized = finalizeLumiResponse({
      taskText: text,
      responseText: quick!.responseText,
      toolRecords: [],
      source: 'voice',
      flow: dispatch.flow,
    });
    expect(finalized).toEqual({
      text: '\u80fd\u542c\u89c1\u3002\u4f60\u8bf4\u3002',
      blocked: false,
    });
  });

  it('does not let client_get_state relabel a CAD action result as a self-check', () => {
    const responseText = '\u8fd8\u6ca1\u6709\u5b8c\u6210 AutoCAD \u7ed8\u5236\u3002';
    const records = [{
      name: 'client_get_state',
      arguments: {},
      result: JSON.stringify({
        state: { mode: 'assistant', activeTab: 'chat' },
        health: { level: 'healthy' },
      }),
    }];

    expect(formatClientDiagnosticResult(records, CAD_TASK, responseText)).toBeNull();

    const finalized = finalizeLumiResponse({
      taskText: CAD_TASK,
      responseText,
      toolRecords: records,
      source: 'voice',
    });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toBe(responseText);
    expect(finalized.text).not.toContain('\u81ea\u68c0');
  });
});
