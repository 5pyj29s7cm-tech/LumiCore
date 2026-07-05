import type { ToolPolicy } from '../personality/types';
import type { ToolRegistry } from '../tools/registry';
import { getOperationModeConfig } from './operation_modes';
import {
  formatToolRouteForPrompt,
  mergeToolPolicyWithRoute,
  routeToolsForTurn,
  type ToolRoute,
} from './tool_router';
import type { LumiTurnFlow } from './turn_flow';

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
  const available = new Set(declarations.map(declaration => declaration.function.name));
  const additions = new Set<string>();
  const categories = [...route.categories];
  const reasons = [...route.reasons];

  if (flow.channel === 'task' || flow.workTakeover.shouldResumeTask) {
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

  if (flow.executionGovernance.capabilityLearningIntent !== 'none') {
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
    addAvailable(additions, available, [
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_click',
      'desktop_ui_type',
      'desktop_ui_invoke',
      'computer_use',
    ]);
    categories.push('desktop_control');
    reasons.push('direct desktop/software turns need visible UI control tools');
  }

  if (flow.workSurfaceRoute.artifactFirst) {
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

  const merged = unique([...Array.from(additions), ...route.toolNames]);
  if (merged.length === route.toolNames.length && route.categories.length === categories.length) return route;

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
  const allowToolUse = input.flow.allowToolUseForTurn && !input.isSanctuary;
  const selfRepairToolPolicy = input.flow.selfRepairTurn ? SELF_REPAIR_TOOL_POLICY : null;
  const clientActionToolPolicy = input.flow.clientActionOnlyTurn ? CLIENT_ACTION_TOOL_POLICY : null;
  const baseToolPolicy = input.isSanctuary
    ? NO_TOOLS_POLICY
    : selfRepairToolPolicy
      ? selfRepairToolPolicy
      : clientActionToolPolicy
        ? clientActionToolPolicy
        : allowToolUse
          ? fallbackPolicy(input.flow, input.personalityToolPolicy)
          : NO_TOOLS_POLICY;
  const rawToolRoute = shouldRouteTools(input.flow, input.isSanctuary)
    ? routeToolsForTurn(input.flow.routeText || input.text, input.toolDeclarations)
    : null;
  const toolRoute = rawToolRoute
    ? enhanceToolRouteForFlow(rawToolRoute, input.flow, input.toolDeclarations)
    : null;
  const toolPolicy = toolRoute
    ? mergeToolPolicyWithRoute(baseToolPolicy, toolRoute)
    : baseToolPolicy;
  const promptParts = [
    '## Lumi Execution Decision',
    `Boundary: ${input.flow.channel}/${input.flow.surface}; tools=${allowToolUse ? 'available' : 'off'}; policyMaxIterations=${toolPolicy.maxIterations || 0}.`,
    input.flow.clientActionOnlyTurn ? 'Use only Lumi client state/action tools for this turn.' : '',
    input.flow.selfRepairTurn ? 'Inspect and repair Lumi/client state first; verify after one safe recovery.' : '',
    input.isSanctuary ? 'This agent is in sanctuary territory; tools are disabled.' : '',
    toolRoute ? formatToolRouteForPrompt(toolRoute) : '',
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
    maxIterations: toolPolicy.maxIterations || input.personalityToolPolicy?.maxIterations || 5,
    promptOverlay: promptParts,
  };
}
