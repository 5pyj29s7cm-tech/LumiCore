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
  const toolRoute = shouldRouteTools(input.flow, input.isSanctuary)
    ? routeToolsForTurn(input.flow.routeText || input.text, input.toolDeclarations)
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
