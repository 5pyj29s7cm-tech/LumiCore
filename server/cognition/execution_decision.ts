import type { ToolPolicy } from '../personality/types';
import type { ToolRegistry } from '../tools/registry';
import { buildOperationModeToolPolicy } from './operation_modes';
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
  isRecoveredWpsCreateTask,
  WPS_CURRENT_APP_MAX_ITERATIONS,
} from './current_app_execution';
import { WPS_CREATE_DOCUMENT_TOOL } from '../external_control/wps_automation';
import type { ConversationActionContinuationState } from './action_continuation';
import { applyTaskPolicySnapshot } from './task_execution_ledger';
import { buildActionContract } from './action_contract';

type ToolDeclaration = ReturnType<ToolRegistry['getToolDeclarations']>[number];

export interface LumiExecutionDecisionInput {
  flow: LumiTurnFlow;
  text: string;
  toolDeclarations: ToolDeclaration[];
  toolRegistry?: ToolRegistry;
  personalityToolPolicy?: ToolPolicy;
  isSanctuary?: boolean;
  actionTaskState?: ConversationActionContinuationState | null;
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

function alignToolRouteWithPolicy(route: ToolRoute, policy: ToolPolicy): ToolRoute {
  const allowed = new Set(policy.allowedTools || []);
  const wildcard = allowed.has('*');
  const forbidden = new Set(policy.forbiddenTools || []);
  const toolNames = route.toolNames.filter(name => (
    (wildcard || allowed.has(name))
    && !forbidden.has('*')
    && !forbidden.has(name)
  ));
  if (toolNames.length === route.toolNames.length) return route;
  return {
    ...route,
    toolNames,
    reasons: unique([
      ...route.reasons,
      'the displayed route was aligned with the executor policy; unavailable tools were removed',
    ]),
  };
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

const SELF_REPAIR_MUTATION_REQUEST_RE =
  /(?:\u4fee\u590d|\u6062\u590d|\u5237\u65b0|\u91cd\u8bd5|\u91cd\u65b0\u8fde\u63a5|\u91cd\u542f|repair|recover|refresh|retry|reconnect|restart)/iu;
const SELF_REPAIR_SKILL_RE =
  /(?:\u6280\u80fd|\u63d2\u4ef6|\b(?:mcp|skill|plugin)\b)/iu;
const SELF_REPAIR_DESKTOP_RE =
  /(?:\u684c\u9762|\u7a97\u53e3|\u753b\u9762|\u9875\u9762|\u754c\u9762|\u767d\u5c4f|\u9ed1\u5c4f|\u5d29\u6e83|\u5361\u4f4f|\u5361\u6b7b|\u6ca1\u53cd\u5e94|\u6253\u4e0d\u5f00|\u542f\u52a8\u5931\u8d25|\b(?:autocad|wps|wechat|weixin|desktop|window|screen|page|ui|blank|crash(?:ed)?|stuck|hang(?:ing)?)\b|white\s+screen|black\s+screen|failed\s+to\s+(?:open|start))/iu;
const SELF_REPAIR_ADAPTER_RE =
  /(?:\u80fd\u529b|\u9002\u914d\u5668|\u63a5\u5165|\u8fde\u63a5|\u8f6f\u4ef6|\u5e94\u7528|\b(?:mcp|skill|plugin|adapter|capability|integration|connection|autocad|wps|wechat|weixin|cad|bim)\b)/iu;
const SELF_REPAIR_LEARNING_INSPECTION_RE =
  // i18n-allow: Reviewed Chinese learning-check input recognition; not user-visible copy.
  /(?:跑|做|进行|执行|查|查看|检查).{0,10}(?:一轮)?(?:学习检查|学习状态检查|学习记录检查|能力学习检查)/u;

/**
 * Self-repair is a privileged diagnostic lane, not a shortcut back to the
 * complete registry. Expose the minimum sub-domain tools named by this turn:
 * generic checks stay read-only, desktop pixels require a desktop symptom,
 * paid model probes require an explicit model symptom, and package repair
 * requires both a skill/MCP target and repair wording.
 */
export function buildSelfRepairToolPolicy(text: string, registry?: ToolRegistry): ToolPolicy {
  const requested = String(text || '');
  const allowedTools = [
    'client_get_state',
    'client_health_check',
  ];
  const explicitRecovery = SELF_REPAIR_MUTATION_REQUEST_RE.test(requested);
  const explicitSkillRepair = explicitRecovery && SELF_REPAIR_SKILL_RE.test(requested);

  if (SELF_REPAIR_ADAPTER_RE.test(requested)) {
    allowedTools.push('adapter_registry_list', 'adapter_health_check');
  }
  if (SELF_REPAIR_LEARNING_INSPECTION_RE.test(requested)) {
    allowedTools.push('capability_learning_list');
  }
  if (explicitRecovery) allowedTools.push('client_self_repair', 'client_action');
  if (explicitSkillRepair) allowedTools.push('client_repair_skill');
  if (SELF_REPAIR_DESKTOP_RE.test(requested)) {
    allowedTools.push(
      'desktop_capability_status',
      'desktop_active_window',
      'desktop_running_processes',
      'desktop_ui_snapshot',
      'desktop_capture_screen',
    );
  }
  if (registry) {
    allowedTools.push(...registry.findRelevant(requested, {
      limit: 8,
      evidenceOperations: ['observe', 'test'],
    }).map(tool => tool.name));
  }

  return {
    allowedTools: unique(allowedTools),
    requireConfirmation: explicitSkillRepair ? ['client_repair_skill'] : [],
    forbiddenTools: [],
    maxIterations: explicitRecovery ? 5 : allowedTools.length > 2 ? 4 : 3,
  };
}

function fallbackPolicy(
  flow: LumiTurnFlow,
  personalityToolPolicy?: ToolPolicy,
  registry?: ToolRegistry,
): ToolPolicy {
  // The visible Chat posture is not a second permission prompt. For an open
  // model-owned chat turn, expose the ordinary foreground Assistant manifest
  // without persisting a UI-mode change. Semantic routing still only ranks
  // candidates, while explicit no-tool/read-only/meeting and sanctuary
  // boundaries keep modelToolAccess hard-off before this point.
  const manifestMode = flow.channel === 'chat'
    && flow.modelToolAccess === 'manifest'
    && flow.operationMode === 'chat'
      ? 'assistant'
      : flow.operationMode;
  const opModePolicy = buildOperationModeToolPolicy(manifestMode, registry);
  if (flow.channel === 'chat' && flow.modelToolAccess === 'manifest') {
    if (!personalityToolPolicy) return opModePolicy;
    const hardAllowed = new Set(opModePolicy.allowedTools || []);
    const personalityAllowed = new Set(personalityToolPolicy.allowedTools || []);
    const hardWildcard = hardAllowed.has('*');
    const personalityWildcard = personalityAllowed.has('*');
    const allowedTools = hardWildcard
      ? [...personalityAllowed]
      : personalityWildcard
        ? [...hardAllowed]
        : [...hardAllowed].filter(name => personalityAllowed.has(name));
    const forbiddenTools = unique([
      ...(opModePolicy.forbiddenTools || []),
      ...(personalityToolPolicy.forbiddenTools || []),
    ]);
    const forbidden = new Set(forbiddenTools);
    const allowed = allowedTools.filter(name => name === '*' || !forbidden.has(name));
    const hardMax = opModePolicy.maxIterations ?? Number.MAX_SAFE_INTEGER;
    const personalityMax = personalityToolPolicy.maxIterations ?? Number.MAX_SAFE_INTEGER;
    return {
      allowedTools: allowed,
      forbiddenTools,
      requireConfirmation: unique([
        ...(opModePolicy.requireConfirmation || []),
        ...(personalityToolPolicy.requireConfirmation || []),
      ]).filter(name => !forbidden.has(name)),
      securityOverrides: {
        ...(opModePolicy.securityOverrides || {}),
        ...(personalityToolPolicy.securityOverrides || {}),
      },
      maxIterations: Math.min(hardMax, personalityMax),
    };
  }
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

function retainSemanticToolsWithinLimit(
  ordered: string[],
  semanticPriority: string[],
  maxTools: number,
): string[] {
  const limited = ordered.slice(0, maxTools);
  const present = new Set(limited);
  const required = unique(semanticPriority).filter(name => ordered.includes(name));
  const protectedNames = new Set(required);

  for (const name of required) {
    if (present.has(name)) continue;
    let replacementIndex = -1;
    for (let index = limited.length - 1; index >= 0; index -= 1) {
      if (!protectedNames.has(limited[index])) {
        replacementIndex = index;
        break;
      }
    }
    if (replacementIndex < 0) break;
    present.delete(limited[replacementIndex]);
    limited.splice(replacementIndex, 1);
    limited.push(name);
    present.add(name);
  }

  return limited;
}

const CAPABILITY_LEARNING_SEMANTIC_TOOLS = [
  'capability_learning_list',
  'self_extension_plan',
  'capability_gap_autofix',
  'list_skills',
  'adapter_registry_list',
  'external_app_list_adapters',
  'external_control_candidates',
];

const TASK_CENTER_SEMANTIC_TOOLS = [
  'work_takeover_task_get',
  'work_takeover_task_continue',
  'work_takeover_task_advance',
  'work_takeover_task_autorun',
  'work_takeover_task_verify_result',
  'work_takeover_task_export_packet',
  'work_takeover_task_run_suggested_tool',
];

// History work must expose the same non-submitting external-AI surface on
// chat, voice, and task entry points. Keeping this small family ahead of
// generic route matches prevents the 24-tool voice envelope from losing the
// actual sync/query tools while the 32-tool chat envelope retains them.
const EXTERNAL_AI_HISTORY_SEMANTIC_TOOLS = [
  'external_ai_history_source_register',
  'external_ai_history_source_list',
  'external_ai_history_source_revoke',
  'external_ai_history_sync',
  'external_ai_history_status',
  'external_ai_history_query',
  'external_ai_route_plan',
  'external_ai_collect_answers',
  'external_ai_session_status',
];

const DESKTOP_CONTROL_SEMANTIC_TOOLS = [
  'desktop_list_apps',
  'desktop_open',
  'desktop_active_window',
  'desktop_ui_snapshot',
  'desktop_capture_screen',
  'mouse_drag',
  'keyboard_press',
  'computer_use',
];

const CURRENT_APP_CONTROL_SEMANTIC_TOOLS = [
  'desktop_active_window',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_invoke',
  'desktop_ui_click',
  'desktop_ui_type',
  'keyboard_press',
  'desktop_keyboard_press',
];

function enhanceToolRouteForFlow(
  route: ToolRoute,
  flow: LumiTurnFlow,
  declarations: ToolDeclaration[],
  registry?: ToolRegistry,
): ToolRoute {
  if (route.hardAllowlist) return route;

  const available = new Set(declarations.map(declaration => declaration.function.name));
  const additions = new Set<string>();
  const semanticPriority = new Set<string>();
  const categories = [...route.categories];
  const reasons = [...route.reasons];
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(flow.routeText);
  const recoveredWpsCreateAndType = isRecoveredWpsCreateTask(flow.routeText);
  const actionContract = buildActionContract(flow.routeText);
  // Keep one compact discovery schema in every non-hard model route. Its
  // receipt can re-project an already-authorized hidden capability on the
  // next iteration without restoring the complete registry to the prompt.
  addAvailable(additions, available, ['client_capability_manifest']);
  addAvailable(semanticPriority, available, ['client_capability_manifest']);
  const discoveredEvidenceTools = registry?.findRelevant(flow.routeText, {
    limit: 8,
    evidenceOperations: ['observe', 'test'],
  }) || [];
  if (discoveredEvidenceTools.length) {
    addAvailable(additions, available, discoveredEvidenceTools.map(tool => tool.name));
    categories.push('capability_discovery');
    reasons.push('evidence-producing tools were matched from their own descriptions and schemas');
  }

  if (!recoveredCurrentAppEdit && (flow.channel === 'task' || flow.workTakeover.shouldResumeTask)) {
    addAvailable(additions, available, TASK_CENTER_SEMANTIC_TOOLS);
    addAvailable(semanticPriority, available, TASK_CENTER_SEMANTIC_TOOLS);
    categories.push(flow.channel === 'task' ? 'task_center' : 'work_takeover');
    reasons.push(flow.channel === 'task' ? 'task center turns need task-state tools' : 'active work takeover turns need continuation tools');
  }

  if (!recoveredCurrentAppEdit && flow.executionGovernance.capabilityLearningIntent !== 'none') {
    addAvailable(additions, available, CAPABILITY_LEARNING_SEMANTIC_TOOLS);
    addAvailable(semanticPriority, available, CAPABILITY_LEARNING_SEMANTIC_TOOLS);
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
    addAvailable(
      semanticPriority,
      available,
      recoveredCurrentAppEdit
        ? CURRENT_APP_CONTROL_SEMANTIC_TOOLS
        : DESKTOP_CONTROL_SEMANTIC_TOOLS,
    );
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
      'desktop_write_text_file',
    ]);
    categories.push('artifact_work');
    reasons.push('artifact-first turns need production and verification tools');
  }

  if (!recoveredCurrentAppEdit && actionContract.kind === 'external_ai_history') {
    addAvailable(semanticPriority, available, EXTERNAL_AI_HISTORY_SEMANTIC_TOOLS);
  }

  const routeNames = route.toolNames.filter(name => (
    name !== WPS_CREATE_DOCUMENT_TOOL || recoveredWpsCreateAndType
  ));
  const priority = recoveredWpsCreateAndType && available.has(WPS_CREATE_DOCUMENT_TOOL)
    ? [WPS_CREATE_DOCUMENT_TOOL]
    : flow.workSurfaceRoute.artifactFirst && actionContract.kind === 'artifact_work'
      ? [
          'write_file',
          'desktop_write_text_file',
          'work_product_verify',
          'desktop_path_info',
          'read_file',
          'read_files_batch',
        ].filter(name => available.has(name))
      : [];
  const merged = unique([
    ...priority,
    ...routeNames,
    ...Array.from(additions),
    ...Array.from(semanticPriority),
  ]);
  if (
    merged.length === route.toolNames.length
    && merged.every((name, index) => name === route.toolNames[index])
    && route.categories.length === categories.length
  ) return route;

  const truncated = route.truncated || merged.length > route.maxTools;
  return {
    ...route,
    toolNames: retainSemanticToolsWithinLimit(
      merged,
      Array.from(semanticPriority),
      route.maxTools,
    ),
    categories: unique(categories),
    reasons: unique(reasons),
    truncated,
  };
}

export function buildLumiExecutionDecision(input: LumiExecutionDecisionInput): LumiExecutionDecision {
  const modelOwnedMainChat = input.flow.channel === 'chat';
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(input.flow.routeText || input.text);
  const statusOnlyContinuation =
    /Recovered structured action state:[\s\S]{0,500}- followupIntent:\s*status\b/i.test(input.flow.routeText || input.text);
  const allowToolUse = (
    input.flow.allowToolUseForTurn
    || input.flow.modelToolAccess === 'manifest'
  ) && !input.isSanctuary && !statusOnlyContinuation;
  const selfRepairToolPolicy = input.flow.selfRepairTurn && !statusOnlyContinuation && !modelOwnedMainChat
    ? buildSelfRepairToolPolicy(input.flow.routeText || input.text, input.toolRegistry)
    : null;
  const clientActionToolPolicy = input.flow.clientActionOnlyTurn && !statusOnlyContinuation && !modelOwnedMainChat
    ? CLIENT_ACTION_TOOL_POLICY
    : null;
  const baseToolPolicy = input.isSanctuary || statusOnlyContinuation
    ? NO_TOOLS_POLICY
    : selfRepairToolPolicy
      ? selfRepairToolPolicy
      : clientActionToolPolicy
        ? clientActionToolPolicy
        : allowToolUse
          ? fallbackPolicy(input.flow, input.personalityToolPolicy, input.toolRegistry)
          : NO_TOOLS_POLICY;
  const rawToolRoute = allowToolUse && shouldRouteTools(input.flow, input.isSanctuary)
    ? routeToolsForTurn(input.flow.routeText || input.text, input.toolDeclarations, {
        // Permission to use the full registry is not a reason to inject the
        // full registry into every model turn. A narrow per-turn manifest
        // keeps context stable while preserving access to every tool through
        // routing on the turn that actually needs it.
        maxTools: input.flow.channel === 'voice' ? 24 : 32,
        capabilityManifest: input.toolRegistry?.getCapabilityManifest(baseToolPolicy),
      })
    : null;
  const toolRoute = rawToolRoute
    ? enhanceToolRouteForFlow(rawToolRoute, input.flow, input.toolDeclarations, input.toolRegistry)
    : null;
  const routedPolicy = toolRoute
    ? mergeToolPolicyWithRoute(baseToolPolicy, toolRoute)
    : baseToolPolicy;
  const taskMarker = input.actionTaskState?.taskId
    ? `- taskId: ${input.actionTaskState.taskId}`
    : '';
  const resumesPinnedTask = Boolean(
    taskMarker
    && (input.flow.routeText || input.text).includes(taskMarker)
    && input.actionTaskState?.policySnapshot
    && !statusOnlyContinuation
    && !clientActionToolPolicy
    && !selfRepairToolPolicy,
  );
  const uncappedToolPolicy = resumesPinnedTask && toolRoute?.hardAllowlist !== true
    ? applyTaskPolicySnapshot(routedPolicy, input.actionTaskState?.policySnapshot)
    : routedPolicy;
  const effectiveToolRoute = toolRoute
    ? alignToolRouteWithPolicy(toolRoute, uncappedToolPolicy)
    : null;
  const requestedMaxIterations = uncappedToolPolicy.maxIterations
    ?? input.personalityToolPolicy?.maxIterations
    ?? 5;
  // Preserve the product's model-planning depth. Actual adapter entries are
  // independently bounded by the hard 8-per-response / 24-per-turn canonical
  // invocation budget, so a large planning limit cannot cause an unbounded
  // number of real tool actions.
  const channelIterationCap = input.flow.channel === 'voice'
    ? 12
    : Number.MAX_SAFE_INTEGER;
  const taskIterationCap = recoveredCurrentAppEdit
    ? isRecoveredWpsCreateTask(input.flow.routeText || input.text)
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
    allowToolUse ? 'The current tool declaration list is authoritative. Never invent a special tool mode or ask the user to switch to a fictional Fetcher/System Diagnostics mode. For an evidence-bearing check, state only conclusions supported by current-turn receipts and preserve each tool\'s stated limitations.' : '',
    clientActionToolPolicy ? 'Use only Lumi client state/action tools for this turn. First read client_get_state when the current state is not already in the tool result, then call client_action. Trust the returned verification.status: verified=done, pending=state not confirmed yet, failed=diagnose or one safe recovery. Do not claim a mode/window/surface changed from intention alone.' : '',
    selfRepairToolPolicy
      ? selfRepairToolPolicy.allowedTools.includes('client_self_repair')
        ? 'Inspect Lumi/client state first. Perform at most one explicitly requested safe recovery, then verify it from a fresh receipt.'
        : 'Inspect only the explicitly exposed diagnostic sub-domain and report current receipts. Do not attempt or claim a repair in this turn.'
      : '',
    statusOnlyContinuation ? 'This is a status/why/recall follow-up about the recovered recent action. Explain the saved goal, actual tool evidence, blocker, and unfinished state. Do not restart execution, create a task-center item, or claim new work in this turn.' : '',
    recoveredCurrentAppEdit
      ? buildCurrentAppUiStateMachinePrompt(
          getRecoveredApplicationContinuationTarget(input.flow.routeText || input.text),
        )
      : '',
    resumesPinnedTask
      ? `Continue task ${input.actionTaskState?.taskId} with its original capability envelope. Short confirmations, corrections, or retry wording must not narrow the tools selected for the original task.`
      : '',
    input.isSanctuary ? 'This agent is in sanctuary territory; tools are disabled.' : '',
    effectiveToolRoute ? formatToolRouteForPrompt(effectiveToolRoute) : '',
    buildUnifiedLegalEntryPrompt({
      text: input.flow.routeText || input.text,
      domain: input.flow.domain,
      orgId: input.flow.orgId,
      channel: input.flow.channel,
      source: input.flow.source,
      routeCategories: effectiveToolRoute?.categories,
      toolNames: effectiveToolRoute?.toolNames,
    }),
    !effectiveToolRoute && allowToolUse && !input.flow.clientActionOnlyTurn && !input.flow.selfRepairTurn
      ? 'No narrow tool route was selected. Use the base policy conservatively and ask one clarification if the work surface is unclear.'
      : '',
  ].filter(Boolean).join('\n');

  return {
    allowToolUse,
    selfRepairToolPolicy,
    clientActionToolPolicy,
    baseToolPolicy,
    toolRoute: effectiveToolRoute,
    toolPolicy,
    maxIterations,
    promptOverlay: promptParts,
  };
}
