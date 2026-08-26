import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrchestrationWorkerToolPolicy } from '../server/agents/orchestrator';
import {
  buildActionContract,
  hasCoreActionEvidence,
} from '../server/cognition/action_contract';
import {
  buildRecentActionContinuationBridge,
  extractRecentActionContinuationState,
} from '../server/cognition/action_continuation';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import {
  guardCurrentAppToolCall,
  hasConfirmedCurrentAppEditor,
} from '../server/cognition/current_app_execution';
import { WPS_CREATE_DOCUMENT_TOOL } from '../server/external_control/wps_automation';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';

const OPEN_WPS = '\u6253\u5f00 WPS\u3002';
const OPENED_WPS = '\u5df2\u6253\u5f00 WPS\u3002';
const CURRENT_APP_TASK =
  '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002';
const CONTENT = 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002';

const TOOL_NAMES = [
  WPS_CREATE_DOCUMENT_TOOL,
  'work_product_plan',
  'work_product_verify',
  'desktop_list_apps',
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
  'write_file',
  'create_docx',
  'create_ppt',
  'create_pdf',
  'desktop_path_info',
  'capability_learning_list',
  'self_extension_plan',
  'capability_gap_autofix',
  'list_skills',
  'adapter_registry_list',
  'external_app_list_adapters',
  'external_control_candidates',
  'mcp_code-sandbox_run_code',
  'mcp_deployment-config-generator_generate',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object' as const, properties: {} },
  },
}));

const WPS_HISTORY = [
  { role: 'user', message: OPEN_WPS },
  {
    role: 'assistant',
    message: OPENED_WPS,
    toolCalls: JSON.stringify([{
      name: 'desktop_open',
      arguments: { target: 'WPS' },
      result: JSON.stringify({
        ok: true,
        status: 'opened',
        processName: 'wps.exe',
        windowTitle: 'WPS Writer',
        target: 'WPS',
      }),
    }]),
  },
];

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function buildScenario(
  taskText = CURRENT_APP_TASK,
  history = WPS_HISTORY,
) {
  const continuationContext = buildRecentActionContinuationBridge(
    taskText,
    history,
  );
  const dispatch = buildLumiTurnDispatch({
    userId: 'wps_current_app_e2e_regression',
    text: taskText,
    continuationContext,
    channel: 'chat',
    source: 'chat',
    operationMode: 'assistant',
    targetIsLumi: true,
  });
  const decision = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text: taskText,
    toolDeclarations: TOOL_NAMES,
  });
  return {
    continuationContext,
    executionTaskText: [taskText, continuationContext].filter(Boolean).join('\n\n'),
    dispatch,
    decision,
  };
}

function verifiedWpsTypingRecords() {
  return [
    {
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        processName: 'wps.exe',
        windowTitle: 'WPS Writer - Document 1',
      }),
    },
    {
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+n' },
      result: 'Pressed: ctrl+n',
    },
    {
      name: 'desktop_ui_snapshot',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        processName: 'wps.exe',
        windowTitle: 'WPS Writer - Document 1',
        controls: [{ role: 'Document', name: 'Document 1' }],
      }),
    },
    {
      name: 'desktop_ui_focus',
      arguments: { controlType: 'Document', name: 'Document 1' },
      result: '{"status":"ok","selectedAfter":{"name":"Document 1","controlType":"Document"}}',
    },
    {
      name: 'desktop_ui_type',
      arguments: { text: CONTENT },
      result: JSON.stringify({
        ok: true,
        status: 'typed',
        processName: 'wps.exe',
        characters: CONTENT.length,
      }),
    },
    {
      name: 'desktop_ui_snapshot',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        processName: 'wps.exe',
        windowTitle: 'WPS Writer - Document 1',
        visibleText: CONTENT,
      }),
    },
  ];
}

function verifiedWpsComRecord(overrides: Record<string, unknown> = {}) {
  return {
    name: WPS_CREATE_DOCUMENT_TOOL,
    arguments: { text: CONTENT },
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      automation: 'KWPS.Application',
      attachmentMode: 'newVisibleInstance',
      attachedExisting: false,
      newVisibleInstance: true,
      visible: true,
      application: 'WPS Writer',
      processName: 'wps.exe',
      processId: 43210,
      documentCreated: true,
      documentName: '\u6587\u5b57\u6587\u7a3f1',
      windowTitle: '\u6587\u5b57\u6587\u7a3f1 - WPS Office',
      bodyText: `${CONTENT}\r`,
      bodyTextWithoutTerminalParagraph: CONTENT,
      exactTextMatch: true,
      charactersRequested: CONTENT.length,
      charactersReadBack: CONTENT.length,
      saved: false,
      savePath: '',
      ...overrides,
    }),
  };
}

describe('WPS current-app end-to-end regression', () => {
  it('keeps the recovered WPS application as the action surface', () => {
    const state = extractRecentActionContinuationState(WPS_HISTORY);
    const { continuationContext, dispatch, decision } = buildScenario();
    const contract = buildActionContract(dispatch.flow.routeText);

    expect(state.appTarget).toBe('WPS');
    expect(continuationContext).toContain('- appTarget: WPS');
    expect(contract.kind).toBe('desktop_operation');
    expect(dispatch.flow.workSurfaceRoute.directDesktop).toBe(true);
    expect(dispatch.flow.workSurfaceRoute.artifactFirst).toBe(false);
    expect(dispatch.flow.workSurfaceRoute.forbidComputerUse).toBe(true);
    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('none');
    expect(decision.toolRoute?.categories).toEqual(expect.arrayContaining([
      'external_control',
      'desktop_control',
    ]));
    expect(decision.toolRoute?.categories).not.toEqual(expect.arrayContaining([
      'documents',
      'artifact_work',
      'code_git',
      'capability_learning',
      'skills_agents',
      'system',
    ]));
    expect(decision.maxIterations).toBeLessThanOrEqual(10);
    expect(decision.maxIterations).toBe(4);
    expect(decision.toolRoute?.toolNames[0]).toBe(WPS_CREATE_DOCUMENT_TOOL);
    expect(decision.toolPolicy.allowedTools).toContain(WPS_CREATE_DOCUMENT_TOOL);
    expect(decision.toolPolicy.allowedTools).not.toContain('computer_use');
    expect(decision.toolPolicy.allowedTools).not.toContain('keyboard_type');
    expect(decision.toolPolicy.allowedTools).not.toContain('mouse_click');
    expect(decision.promptOverlay).toContain('Editor-ready gate');
    expect(decision.promptOverlay).toContain('A title such as "New Document" alone is not editor evidence');
    expect(decision.promptOverlay).toContain('WPS deterministic path');
    expect(decision.promptOverlay).toContain('exact body-text readback');
  });

  it('uses the real routeText shape and restores exact WPS payload punctuation', () => {
    const { dispatch } = buildScenario();
    expect(dispatch.flow.routeText.startsWith(CURRENT_APP_TASK)).toBe(true);
    expect(dispatch.flow.routeText).toContain('## Recent action continuation context');
    expect(dispatch.flow.routeText).toContain('- followupIntent: execute');
    expect(dispatch.flow.routeText).toContain('- appTarget: WPS');

    const visibleTextOnly = guardCurrentAppToolCall({
      taskText: CURRENT_APP_TASK,
      toolName: WPS_CREATE_DOCUMENT_TOOL,
      arguments: { text: CONTENT.slice(0, -1) },
      toolRecords: [],
    });
    expect(visibleTextOnly.allowed).toBe(false);
    expect(visibleTextOnly.reason).toContain('recovered WPS continuation');

    const routed = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: WPS_CREATE_DOCUMENT_TOOL,
      arguments: { text: CONTENT.slice(0, -1) },
      toolRecords: [],
    });
    expect(routed.allowed).toBe(true);
    expect(routed.normalizedArguments).toEqual({ text: CONTENT });
  });

  it('does not interpret document content named regression test as coding or capability learning', () => {
    const { dispatch, decision } = buildScenario();

    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('none');
    expect(dispatch.flow.executionGovernance.shouldInspectCapabilitiesFirst).toBe(false);
    expect(decision.toolRoute?.categories).not.toContain('code_git');
    expect(decision.toolRoute?.categories).not.toContain('capability_learning');
    expect(decision.toolPolicy.allowedTools).not.toEqual(expect.arrayContaining([
      'capability_learning_list',
      'self_extension_plan',
      'capability_gap_autofix',
      'mcp_code-sandbox_run_code',
      'mcp_deployment-config-generator_generate',
    ]));
  });

  it('exposes the WPS COM tool for explicit and recovered WPS create requests', () => {
    const saveOnly = buildScenario('\u5728\u8fd9\u91cc\u9762\u4fdd\u5b58\u5f53\u524d\u6587\u6863\u3002');
    expect(saveOnly.decision.toolPolicy.allowedTools).not.toContain(WPS_CREATE_DOCUMENT_TOOL);
    expect(saveOnly.decision.toolRoute?.toolNames).not.toContain(WPS_CREATE_DOCUMENT_TOOL);

    const directDispatch = buildLumiTurnDispatch({
      userId: 'wps_non_recovered_direct_request',
      text: '\u5728 WPS \u91cc\u9762\u65b0\u5efa\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u3002',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const directDecision = buildLumiExecutionDecision({
      flow: directDispatch.flow,
      text: directDispatch.flow.routeText,
      toolDeclarations: TOOL_NAMES,
    });
    expect(directDecision.toolRoute?.toolNames).toContain(WPS_CREATE_DOCUMENT_TOOL);
    expect(directDecision.toolPolicy.allowedTools).toContain(WPS_CREATE_DOCUMENT_TOOL);
  });

  it('keeps both the foreground turn and an orchestrated worker on WPS UI tools', () => {
    const { decision } = buildScenario();
    const workerPolicy = buildOrchestrationWorkerToolPolicy(
      `Use the currently open WPS document and type: ${CONTENT}`,
      decision.toolPolicy,
      TOOL_NAMES,
    );

    expect(decision.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_type',
    ]));
    expect(workerPolicy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_type',
    ]));
    for (const forbiddenSubstitute of [
      'write_file',
      'create_docx',
      'create_ppt',
      'create_pdf',
      'work_product_plan',
      'work_product_verify',
      'capability_learning_list',
      'self_extension_plan',
      'capability_gap_autofix',
      'mcp_code-sandbox_run_code',
      'mcp_deployment-config-generator_generate',
      'computer_use',
      'keyboard_type',
      'mouse_click',
    ]) {
      expect(decision.toolPolicy.allowedTools).not.toContain(forbiddenSubstitute);
      expect(workerPolicy.allowedTools).not.toContain(forbiddenSubstitute);
    }
  });

  it('blocks the real failure ledger until a fresh UIA snapshot proves an editor', () => {
    const { dispatch } = buildScenario();
    const templateLedger = [
      {
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"WPS Office","processName":"wps.exe"}',
      },
      {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: JSON.stringify({
          status: 'ok',
          tree: {
            name: 'WPS Office',
            controlType: 'Window',
            children: [{ name: '\u6587\u5b57', controlType: 'Button' }],
          },
        }),
      },
      {
        name: 'desktop_ui_invoke',
        arguments: { name: '\u6587\u5b57', controlType: 'Button' },
        result: '{"status":"ok","selectedAfter":{"name":"文字","controlType":"Button"}}',
      },
      {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: JSON.stringify({
          status: 'ok',
          tree: {
            name: '\u65b0\u5efa\u6587\u6863 - WPS Office',
            controlType: 'Window',
            children: [{ name: '\u65b0\u5efa\u7a7a\u767d', controlType: 'Button' }],
          },
        }),
      },
    ];

    expect(hasConfirmedCurrentAppEditor(templateLedger, dispatch.flow.routeText)).toBe(false);
    expect(guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: 'computer_use',
      arguments: { task: '\u7ee7\u7eed\u65b0\u5efa' },
      toolRecords: templateLedger,
    }).allowed).toBe(false);
    const prematureType = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: 'desktop_ui_type',
      arguments: { text: CONTENT },
      toolRecords: templateLedger,
    });
    expect(prematureType.allowed).toBe(false);
    expect(prematureType.reason).toContain('Editor-ready gate');

    const blankInvoke = {
      name: 'desktop_ui_invoke',
      arguments: { nameContains: '\u65b0\u5efa\u7a7a\u767d', controlType: 'Button' },
      result: '{"status":"ok","selectedAfter":{"name":"新建空白","controlType":"Button"}}',
    };
    expect(guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: blankInvoke.name,
      arguments: blankInvoke.arguments,
      toolRecords: templateLedger,
    }).allowed).toBe(true);

    const editorLedger = [
      ...templateLedger,
      blankInvoke,
      {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: JSON.stringify({
          status: 'ok',
          tree: {
            name: 'Document 1 - WPS Writer',
            controlType: 'Window',
            children: [{
              name: '\u6b63\u6587',
              automationId: 'writer-editor',
              className: 'RichEditDocumentView',
              controlType: 'Document',
              isEnabled: true,
            }],
          },
        }),
      },
    ];
    expect(hasConfirmedCurrentAppEditor(editorLedger, dispatch.flow.routeText)).toBe(true);
    expect(guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: 'desktop_ui_type',
      arguments: {
        controlType: 'Document',
        automationId: 'writer-editor',
        text: CONTENT,
      },
      toolRecords: editorLedger,
    }).allowed).toBe(true);
    const repeatedBlank = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: blankInvoke.name,
      arguments: blankInvoke.arguments,
      toolRecords: editorLedger,
    });
    expect(repeatedBlank.allowed).toBe(false);
    expect(repeatedBlank.reason).toContain('Do not repeat');
  });

  it('does not dirty navigation state when an inaccessible CEF control returns not_found', () => {
    const { dispatch } = buildScenario();
    const cefLedger = [
      {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: JSON.stringify({
          status: 'ok',
          capturedNodes: 25,
          tree: {
            name: '\u65b0\u5efa\u6587\u6863 - WPS Office',
            className: 'KPromeMainWindow',
            controlType: 'Window',
            children: [{ className: 'QWidget', controlType: 'Group' }],
          },
        }),
      },
      {
        name: 'desktop_ui_click',
        arguments: {
          nameContains: '\u65b0\u5efa\u7a7a\u767d',
          controlType: 'Button',
        },
        result: JSON.stringify({
          status: 'not_found',
          action: 'click',
          matchedCount: 0,
          visitedNodes: 25,
        }),
      },
    ];

    const shortcut = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: 'keyboard_press',
      arguments: { key: 'ctrl+n' },
      toolRecords: cefLedger,
    });
    expect(shortcut.allowed).toBe(true);
  });

  it('derives one exact WPS COM mutation from the user payload and blocks duplicate work', () => {
    const { dispatch } = buildScenario();
    const exact = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: WPS_CREATE_DOCUMENT_TOOL,
      arguments: { text: CONTENT },
      toolRecords: [],
    });
    expect(exact.allowed).toBe(true);
    expect(exact.normalizedArguments).toEqual({ text: CONTENT });

    const reconstructedPayload = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: WPS_CREATE_DOCUMENT_TOOL,
      arguments: { text: 'different text' },
      toolRecords: [],
    });
    expect(reconstructedPayload.allowed).toBe(true);
    expect(reconstructedPayload.normalizedArguments).toEqual({ text: CONTENT });

    const completedLedger = [verifiedWpsComRecord()];
    const duplicate = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: WPS_CREATE_DOCUMENT_TOOL,
      arguments: { text: CONTENT },
      toolRecords: completedLedger,
    });
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reason).toContain('duplicate');

    const postCompletionNavigation = guardCurrentAppToolCall({
      taskText: dispatch.flow.routeText,
      toolName: 'keyboard_press',
      arguments: { key: 'ctrl+n' },
      toolRecords: completedLedger,
    });
    expect(postCompletionNavigation.allowed).toBe(false);
    expect(postCompletionNavigation.reason).toContain('already proves');
  });

  it('rejects a repository text file as evidence that WPS was edited or saved', () => {
    const { executionTaskText } = buildScenario();
    const contract = buildActionContract(executionTaskText);
    const repositoryWrite = [{
      name: 'write_file',
      arguments: {
        path: 'D:\\LumiCore\\Lumi-e2e-regression.txt',
        content: CONTENT,
      },
      result: 'File written: D:\\LumiCore\\Lumi-e2e-regression.txt',
    }];

    expect(contract.kind).toBe('desktop_operation');
    expect(hasCoreActionEvidence(contract, repositoryWrite, executionTaskText)).toBe(false);

    const falseSuccessResponse =
      '\u5df2\u5728 WPS \u4e2d\u65b0\u5efa\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\u5185\u5bb9\uff0c\u5df2\u4fdd\u5b58\u3002';
    const finalized = finalizeLumiResponse({
      taskText: executionTaskText,
      responseText: falseSuccessResponse,
      toolRecords: repositoryWrite,
      source: 'chat',
    });

    expect(finalized.blocked).toBe(true);
    expect(finalized.text).not.toBe(falseSuccessResponse);
    expect(finalized.text.startsWith('\u5df2\u5728 WPS')).toBe(false);
  });

  it('accepts verified WPS typing but does not add a save claim without save evidence', () => {
    const { executionTaskText } = buildScenario();
    const records = verifiedWpsTypingRecords();
    const typedResponse =
      '\u5df2\u5728 WPS \u5f53\u524d\u7a7a\u767d\u6587\u6863\u4e2d\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002';

    const typed = finalizeLumiResponse({
      taskText: executionTaskText,
      responseText: typedResponse,
      toolRecords: records,
      source: 'chat',
    });
    expect(typed.blocked).toBe(false);
    expect(typed.text).toBe(typedResponse);

    const unverifiedSave = finalizeLumiResponse({
      taskText: executionTaskText,
      responseText:
        '\u5df2\u5728 WPS \u5f53\u524d\u7a7a\u767d\u6587\u6863\u4e2d\u5199\u5165\u5185\u5bb9\uff0c\u5e76\u5df2\u4fdd\u5b58\u3002',
      toolRecords: records,
      source: 'chat',
    });
    expect(unverifiedSave.blocked || !unverifiedSave.text.includes('\u5df2\u4fdd\u5b58')).toBe(true);
  });

  it('accepts only a complete real-WPS COM receipt and still rejects an unverified save claim', () => {
    const { executionTaskText } = buildScenario();
    const records = [verifiedWpsComRecord()];
    const contract = buildActionContract(executionTaskText);
    expect(hasCoreActionEvidence(contract, records, executionTaskText)).toBe(true);

    const response =
      '\u5df2\u5728\u53ef\u89c1 WPS \u7a7a\u767d\u6587\u6863\u4e2d\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002';
    const finalized = finalizeLumiResponse({
      taskText: executionTaskText,
      responseText: response,
      toolRecords: records,
      source: 'chat',
    });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toBe(response);

    const savedClaim = finalizeLumiResponse({
      taskText: executionTaskText,
      responseText:
        '\u5df2\u5728 WPS \u4e2d\u5199\u5165\u5185\u5bb9\u5e76\u5df2\u4fdd\u5b58\u3002',
      toolRecords: records,
      source: 'chat',
    });
    expect(savedClaim.blocked).toBe(false);
    expect(savedClaim.text).toContain('\u5f53\u524d\u672a\u4fdd\u5b58');
    expect(savedClaim.text).not.toContain('\u5df2\u4fdd\u5b58');

    const forged = [verifiedWpsComRecord({ exactTextMatch: false })];
    expect(hasCoreActionEvidence(contract, forged, executionTaskText)).toBe(false);

    const inconsistentInstance = [verifiedWpsComRecord({
      attachmentMode: 'newVisibleInstance',
      attachedExisting: true,
      newVisibleInstance: false,
    })];
    expect(hasCoreActionEvidence(contract, inconsistentInstance, executionTaskText)).toBe(false);
  });

  it('uses a verified native WPS receipt for a direct blank Word request without recovered app context', () => {
    const blankRecord = verifiedWpsComRecord({
      bodyText: '\r',
      bodyTextWithoutTerminalParagraph: '',
      charactersRequested: 0,
      charactersReadBack: 0,
    });
    blankRecord.arguments.text = '';

    const finalized = finalizeLumiResponse({
      taskText: '\u65b0\u5efaWord\u6587\u6863\u3002',
      responseText: 'WPS \u6587\u6863\u6ca1\u6709\u521b\u5efa\u6210\u529f\u3002',
      toolRecords: [blankRecord],
      source: 'voice',
    });

    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toContain('\u5df2\u5728 WPS \u4e2d\u65b0\u5efa\u53ef\u89c1\u7a7a\u767d\u6587\u6863');
    expect(finalized.text).toContain('\u5f53\u524d\u672a\u4fdd\u5b58');
    expect(finalized.text).toContain('wps.exe (PID 43210)');
  });
});
