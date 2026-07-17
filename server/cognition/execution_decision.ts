import type { ToolPolicy } from '../personality/types';
import type { ToolRegistry } from '../tools/registry';
import { getOperationModeConfig } from './operation_modes';
import { buildUnifiedLegalEntryPrompt } from './legal_entry';
import {
  formatToolRouteForPrompt,
  mergeToolPolicyWithRoute,
  routeToolsForTurn,
  type ToolRoute,
} from './tool_router';
import type { LumiTurnFlow } from './turn_flow';
import {
  getRecoveredApplicationContinuationTarget,
  isRecoveredCurrentAppEditingContinuation,
} from './action_continuation';
import {
  buildCurrentAppUiStateMachinePrompt,
  CURRENT_APP_MAX_ITERATIONS,
  isRecoveredWpsCreateAndTypeTask,
  WPS_CURRENT_APP_MAX_ITERATIONS,
} from './current_app_execution';
import { WPS_CREATE_DOCUMENT_TOOL } from '../external_control/wps_automation';

type ToolDeclaration = ReturnType<ToolRegistry['getToolDeclarations']>[number];

export interface LumiExecutionDecisionInput {
  flow: LumiTurnFlow;
  text: string;
  toolDeclarations: ToolDeclaration[];
  personalityToolPolicy?: ToolPolicy;
  isSanctuary?: boolean;
}

export interface LumiExecutionDecision {
  allowToolUse: boolean;
  selfRepairToolPolicy: ToolPolicy | null;
  clientActionToolPolicy: ToolPolicy | null;
  baseToolPolicy: ToolPolicy;
  toolRoute: ToolRoute | null;
  toolPolicy: ToolPolicy;
  maxIterations: number;
  promptOverlay: string;
}

const NO_TOOLS_POLICY: ToolPolicy = {
  allowedTools: [],
  requireConfirmation: [],
  forbiddenTools: ['*'],
  maxIterations: 0,
};

const CLIENT_ACTION_TOOL_POLICY: ToolPolicy = {
  allowedTools: ['client_get_state', 'client_action'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

const SELF_REPAIR_TOOL_POLICY: ToolPolicy = {
  allowedTools: ['*'],
  requireConfirmation: [
    'desktop_run_command',
    'run_command',
    'write_file',
    'file_delete',
    'delete_file',
    'rm',
    'unlink',
    'format',
    'rmdir',
    'uninstall',
    'computer_use',
  ],
  forbiddenTools: [],
  maxIterations: 8,
};

function fallbackPolicy(flow: LumiTurnFlow, personalityToolPolicy?: ToolPolicy): ToolPolicy {
  const opModePolicy = getOperationModeConfig(flow.effectiveOperationMode)?.toolPolicy;
  return flow.workSurfaceRoute.toolPolicy || opModePolicy || personalityToolPolicy || NO_TOOLS_POLICY;
}

function shouldRouteTools(flow: LumiTurnFlow, isSanctuary?: boolean): boolean {
  if (isSanctuary) return false;
  if (!flow.allowToolUseForTurn) return false;
  if (flow.clientActionOnlyTurn) return false;
  if (flow.selfRepairTurn) return false;
  return true;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function addAvailable(out: Set<string>, available: Set<string>, names: string[]): void {
  for (const name of names) {
    if (available.has(name)) out.add(name);
  }
}

function enhanceToolRouteForFlow(
  route: ToolRoute,
  flow: LumiTurnFlow,
  declarations: ToolDeclaration[],
): ToolRoute {
  if (route.hardAllowlist) return route;

  const available = new Set(declarations.map(declaration => declaration.function.name));
  const additions = new Set<string>();
  const categories = [...route.categories];
  const reasons = [...route.reasons];
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(flow.routeText);
  const recoveredWpsCreateAndType = isRecoveredWpsCreateAndTypeTask(flow.routeText);

  if (!recoveredCurrentAppEdit && (flow.channel === 'task' || flow.workTakeover.shouldResumeTask)) {
    addAvailable(additions, available, [
      'work_takeover_task_get',
      'work_takeover_task_continue',
      'work_takeover_task_advance',
      'work_takeover_task_autorun',
      'work_takeover_task_verify_result',
      'work_takeover_task_export_packet',
      'work_takeover_task_run_suggested_tool',
    ]);
    categories.push(flow.channel === 'task' ? 'task_center' : 'work_takeover');
    reasons.push(flow.channel === 'task' ? 'task center turns need task-state tools' : 'active work takeover turns need continuation tools');
  }

  if (!recoveredCurrentAppEdit && flow.executionGovernance.capabilityLearningIntent !== 'none') {
    addAvailable(additions, available, [
      'capability_learning_list',
      'self_extension_plan',
      'capability_gap_autofix',
      'list_skills',
      'adapter_registry_list',
      'external_app_list_adapters',
      'external_control_candidates',
    ]);
    categories.push('capability_learning');
    reasons.push('capability learning turns must inspect and reuse existing skills/adapters before adding new code');
  }

  if (flow.workSurfaceRoute.directDesktop) {
    addAvailable(additions, available, recoveredCurrentAppEdit
      ? [
          ...(recoveredWpsCreateAndType ? [WPS_CREATE_DOCUMENT_TOOL] : []),
          'desktop_active_window',
          'desktop_ui_snapshot',
          'desktop_ui_focus',
          'desktop_ui_click',
          'desktop_ui_type',
          'desktop_ui_invoke',
          'desktop_capture_screen',
          'ocr_screen',
          'desktop_open',
          'read_clipboard',
          'write_clipboard',
          'keyboard_press',
          'desktop_keyboard_press',
        ]
      : [
          'desktop_active_window',
          'desktop_running_processes',
          'desktop_idle_time',
          'desktop_poll_activity',
          'desktop_list_apps',
          'desktop_open',
          'desktop_path_info',
          'desktop_ui_snapshot',
          'desktop_ui_focus',
          'desktop_ui_click',
          'desktop_ui_type',
          'desktop_ui_invoke',
          'desktop_capture_screen',
          'desktop_show_lumi_window',
          'desktop_run_command',
          'read_clipboard',
          'write_clipboard',
          'mouse_move',
          'mouse_click',
          'mouse_drag',
          'keyboard_type',
          'keyboard_press',
          'computer_use',
        ]);
    categories.push('desktop_control');
    reasons.push(recoveredCurrentAppEdit
      ? 'recovered current-app editing must stay on active-window and visible UI controls'
      : 'direct desktop/software turns need visible UI control tools');
  }

  if (!recoveredCurrentAppEdit && flow.workSurfaceRoute.artifactFirst) {
    addAvailable(additions, available, [
      'work_product_plan',
      'work_product_verify',
      'create_docx',
      'create_ppt',
      'create_pdf',
      'write_file',
    ]);
    categories.push('artifact_work');
    reasons.push('artifact-first turns need production and verification tools');
  }

  const routeNames = route.toolNames.filter(name => (
    name !== WPS_CREATE_DOCUMENT_TOOL || recoveredWpsCreateAndType
  ));
  const priority = recoveredWpsCreateAndType && available.has(WPS_CREATE_DOCUMENT_TOOL)
    ? [WPS_CREATE_DOCUMENT_TOOL]
    : [];
  const merged = unique([...priority, ...routeNames, ...Array.from(additions)]);
  if (
    merged.length === route.toolNames.length
    && merged.every((name, index) => name === route.toolNames[index])
    && route.categories.length === categories.length
  ) return route;

  const truncated = route.truncated || merged.length > route.maxTools;
  return {
    ...route,
    toolNames: merged.slice(0, route.maxTools),
    categories: unique(categories),
    reasons: unique(reasons),
    truncated,
  };
}

export function buildLumiExecutionDecision(input: LumiExecutionDecisionInput): LumiExecutionDecision {
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(input.flow.routeText || input.text);
  const statusOnlyContinuation =
    /Recovered structured action state:[\s\S]{0,500}- followupIntent:\s*status\b/i.test(input.flow.routeText || input.text);
  const allowToolUse = input.flow.allowToolUseForTurn && !input.isSanctuary && !statusOnlyContinuation;
  const selfRepairToolPolicy = input.flow.selfRepairTurn && !statusOnlyContinuation ? SELF_REPAIR_TOOL_POLICY : null;
  const clientActionToolPolicy = input.flow.clientActionOnlyTurn && !statusOnlyContinuation ? CLIENT_ACTION_TOOL_POLICY : null;
  const baseToolPolicy = input.isSanctuary || statusOnlyContinuation
    ? NO_TOOLS_POLICY
    : selfRepairToolPolicy
      ? selfRepairToolPolicy
      : clientActionToolPolicy
        ? clientActionToolPolicy
        : allowToolUse
          ? fallbackPolicy(input.flow, input.personalityToolPolicy)
          : NO_TOOLS_POLICY;
  const rawToolRoute = allowToolUse && shouldRouteTools(input.flow, input.isSanctuary)
    ? routeToolsForTurn(input.flow.routeText || input.text, input.toolDeclarations, {
        maxTools: input.flow.channel === 'voice' ? 32 : 64,
      })
    : null;
  const toolRoute = rawToolRoute
    ? enhanceToolRouteForFlow(rawToolRoute, input.flow, input.toolDeclarations)
    : null;
  const uncappedToolPolicy = toolRoute
    ? mergeToolPolicyWithRoute(baseToolPolicy, toolRoute)
    : baseToolPolicy;
  const requestedMaxIterations = uncappedToolPolicy.maxIterations
    ?? input.personalityToolPolicy?.maxIterations
    ?? 5;
  const channelIterationCap = input.flow.channel === 'voice'
    ? 12
    : Number.MAX_SAFE_INTEGER;
  const taskIterationCap = recoveredCurrentAppEdit
    ? isRecoveredWpsCreateAndTypeTask(input.flow.routeText || input.text)
      ? WPS_CURRENT_APP_MAX_ITERATIONS
      : CURRENT_APP_MAX_ITERATIONS
    : Number.MAX_SAFE_INTEGER;
  const maxIterations = Math.max(0, Math.min(
    requestedMaxIterations,
    channelIterationCap,
    taskIterationCap,
  ));
  const toolPolicy = {
    ...uncappedToolPolicy,
    maxIterations,
  };
  const promptParts = [
    '## Lumi Execution Decision',
    `Boundary: ${input.flow.channel}/${input.flow.surface}; tools=${allowToolUse ? 'available' : 'off'}; policyMaxIterations=${toolPolicy.maxIterations || 0}.`,
    allowToolUse ? 'For file/screen/document actions, do not answer with a future-tense promise such as "I will read/open/review it now" as the final response. Call the actual read/open/review tool in this turn. If no readable path/content is available, say clearly that no tool has run yet and ask for the file or location.' : '',
    clientActionToolPolicy ? 'Use only Lumi client state/action tools for this turn. First read client_get_state when the current state is not already in the tool result, then call client_action. Trust the returned verification.status: verified=done, pending=state not confirmed yet, failed=diagnose or one safe recovery. Do not claim a mode/window/surface changed from intention alone.' : '',
    selfRepairToolPolicy ? 'Inspect and repair Lumi/client state first; verify after one safe recovery.' : '',
    statusOnlyContinuation ? 'This is a status/why/recall follow-up about the recovered recent action. Explain the saved goal, actual tool evidence, blocker, and unfinished state. Do not restart execution, create a task-center item, or claim new work in this turn.' : '',
    recoveredCurrentAppEdit
      ? buildCurrentAppUiStateMachinePrompt(
          getRecoveredApplicationContinuationTarget(input.flow.routeText || input.text),
        )
      : '',
    input.isSanctuary ? 'This agent is in sanctuary territory; tools are disabled.' : '',
    toolRoute ? formatToolRouteForPrompt(toolRoute) : '',
    buildUnifiedLegalEntryPrompt({
      text: input.flow.routeText || input.text,
      domain: input.flow.domain,
      orgId: input.flow.orgId,
      channel: input.flow.channel,
      source: input.flow.source,
      routeCategories: toolRoute?.categories,
      toolNames: toolRoute?.toolNames,
    }),
    !toolRoute && allowToolUse && !input.flow.clientActionOnlyTurn && !input.flow.selfRepairTurn
      ? 'No narrow tool route was selected. Use the base policy conservatively and ask one clarification if the work surface is unclear.'
      : '',
  ].filter(Boolean).join('\n');

  return {
    allowToolUse,
    selfRepairToolPolicy,
    clientActionToolPolicy,
    baseToolPolicy,
    toolRoute,
    toolPolicy,
    maxIterations,
    promptOverlay: promptParts,
  };
}
