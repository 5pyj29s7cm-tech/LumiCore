import type { ToolPolicy } from '../personality/types';
import type { ToolRegistry } from '../tools/registry';
import type { ConversationActionContinuationState } from './action_continuation';
import { normalizeActionIntent, type NormalizedActionIntent } from './normalized_action_intent';
import {
  buildLumiCapabilitySelection,
  type LumiCapabilitySelection,
} from './capability_selection';
import {
  buildLumiExecutionDecision,
  type LumiExecutionDecision,
} from './execution_decision';
import {
  buildLumiIntentTrace,
  type LumiIntentTrace,
} from './intent_trace';
import {
  buildLumiTurnDispatch,
  type LumiTurnDispatch,
  type LumiTurnDispatchInput,
} from './turn_dispatch';
import {
  applyLumiRoutingShadowGuard,
  compareLumiRoutingShadow,
  type LumiRoutingShadowComparison,
} from './routing_shadow_guard';
import {
  buildCapabilityExecutionPlan,
  formatCapabilityExecutionPlanPrompt,
  type CapabilityExecutionPlan,
} from './capability_execution_plan';
import { recordRoutingShadowComparison } from '../runtime/capability_metrics';

export interface LumiCapabilityPlan extends LumiCapabilitySelection {
  schemaVersion: 1;
  capabilityIds: string[];
  taskLedgerRequired: boolean;
}

export interface LumiExecutionPipeline {
  normalizedIntent: NormalizedActionIntent;
  turnIntent: LumiTurnDispatch;
  capabilityPlan: LumiCapabilityPlan;
  executionPlan: CapabilityExecutionPlan;
  execution: LumiExecutionDecision;
  intentTrace: LumiIntentTrace;
  shadowComparison: LumiRoutingShadowComparison;
}

export interface BuildLumiExecutionPipelineInput {
  dispatch: LumiTurnDispatchInput;
  registry: ToolRegistry;
  personalityToolPolicy?: ToolPolicy;
  actionTaskState?: ConversationActionContinuationState | null;
  isSanctuary?: boolean;
  decisionText?: string;
  traceText?: string;
  source?: string;
  /** Durable task identity supplied by non-conversation entrances such as scheduler/agent execution. */
  taskId?: string;
}

function applySelectedWorkflowAdapterPolicy(
  execution: LumiExecutionDecision,
  turnIntent: LumiTurnDispatch,
  registry: ToolRegistry,
  personalityToolPolicy?: ToolPolicy,
  isSanctuary?: boolean,
): LumiExecutionDecision {
  const workflow = turnIntent.flow.specialWorkflow;
  if (!workflow || isSanctuary) return execution;
  const configuredAllowed = new Set(personalityToolPolicy?.allowedTools || []);
  const configuredForbidden = new Set(personalityToolPolicy?.forbiddenTools || []);
  const configuredWildcard = configuredAllowed.has('*');
  const hasConfiguredBoundary = Boolean(personalityToolPolicy);
  const executable = new Map(registry
    .getCapabilityManifest(undefined, { executableOnly: true })
    .map(entry => [entry.toolName, entry]));
  const requiredTools = workflow.requiredTools.filter(toolName => (
    executable.has(toolName)
    && (!hasConfiguredBoundary || configuredWildcard || configuredAllowed.has(toolName))
    && !configuredForbidden.has('*')
    && !configuredForbidden.has(toolName)
  ));
  if (requiredTools.length === 0) return execution;
  const route = execution.toolRoute || {
    toolNames: [],
    categories: [],
    reasons: [],
    totalAvailable: registry.getToolDeclarations().length,
    maxTools: requiredTools.length,
    truncated: false,
  };
  return {
    ...execution,
    allowToolUse: true,
    toolRoute: {
      ...route,
      toolNames: Array.from(new Set([...route.toolNames, ...requiredTools])),
      categories: Array.from(new Set([...route.categories, 'skill_workflow_adapter'])),
      reasons: Array.from(new Set([
        ...route.reasons,
        `semantic plan selected workflow adapter ${workflow.skillId}/${workflow.id}`,
      ])),
      maxTools: Math.max(route.maxTools, route.toolNames.length + requiredTools.length),
    },
    toolPolicy: {
      ...execution.toolPolicy,
      allowedTools: Array.from(new Set([
        ...(execution.toolPolicy.allowedTools || []).filter(name => name !== '*'),
        ...requiredTools,
      ])),
      requireConfirmation: Array.from(new Set([
        ...(execution.toolPolicy.requireConfirmation || []),
        ...requiredTools.filter(name => executable.get(name)?.requiresConfirmation),
      ])),
      forbiddenTools: (execution.toolPolicy.forbiddenTools || [])
        .filter(name => name !== '*' && !requiredTools.includes(name)),
      maxIterations: Math.max(execution.toolPolicy.maxIterations || 0, requiredTools.length + 2),
    },
    maxIterations: Math.max(execution.maxIterations, requiredTools.length + 2),
    promptOverlay: [
      execution.promptOverlay,
      `Selected workflow adapter is restricted to: ${requiredTools.join(', ')}.`,
    ].filter(Boolean).join('\n'),
  };
}

/**
 * One channel-independent planning path:
 * TurnIntent -> CapabilityPlan -> TaskLedger (owned by conversation manager)
 * -> canonical tool execution -> verification/finalization.
 *
 * Chat, voice, and task-center handlers consume this exact envelope instead
 * of assembling subtly different routing and permission snapshots.
 */
export function buildLumiExecutionPipeline(
  input: BuildLumiExecutionPipelineInput,
): LumiExecutionPipeline {
  const turnIntent = buildLumiTurnDispatch(input.dispatch);
  const decisionText = input.decisionText || turnIntent.flow.routeText;
  const normalizedIntent = normalizeActionIntent(decisionText);
  const legacyExecution = buildLumiExecutionDecision({
    flow: turnIntent.flow,
    text: decisionText,
    toolDeclarations: input.registry.getToolDeclarations(),
    toolRegistry: input.registry,
    personalityToolPolicy: input.personalityToolPolicy,
    actionTaskState: input.actionTaskState,
    isSanctuary: input.isSanctuary,
  });
  const unrestrictedManifest = input.registry.getCapabilityManifest(legacyExecution.toolPolicy);
  const shadowComparison = compareLumiRoutingShadow({
    normalizedIntent,
    execution: legacyExecution,
    manifest: unrestrictedManifest,
  });
  const execution = applySelectedWorkflowAdapterPolicy(
    applyLumiRoutingShadowGuard(legacyExecution, shadowComparison),
    turnIntent,
    input.registry,
    input.personalityToolPolicy,
    input.isSanctuary,
  );
  const selection = buildLumiCapabilitySelection({
    dispatch: turnIntent,
    execution,
    text: decisionText,
  });
  const manifest = input.registry.getCapabilityManifest(execution.toolPolicy);
  const capabilityIds = Array.from(new Set(
    (execution.toolRoute?.toolNames || [])
      .map(toolName => manifest.find(entry => entry.toolName === toolName)?.capabilityId)
      .filter(Boolean) as string[],
  ));
  const capabilityPlan: LumiCapabilityPlan = {
    ...selection,
    schemaVersion: 1,
    capabilityIds,
    taskLedgerRequired: Boolean(
      turnIntent.flow.completionEvidenceNeeded
      || turnIntent.flow.allowToolUseForTurn
      || turnIntent.boundary === 'task_center'
      || turnIntent.boundary === 'work_takeover',
    ),
  };
  const executionPlan = buildCapabilityExecutionPlan({
    intent: normalizedIntent,
    capabilityPlan,
    execution,
    manifest,
    taskId: input.taskId || input.actionTaskState?.taskId,
    sourcePaths: input.actionTaskState?.sourcePaths,
  });
  capabilityPlan.promptOverlay = [
    capabilityPlan.promptOverlay,
    formatCapabilityExecutionPlanPrompt(executionPlan),
  ].filter(Boolean).join('\n\n');
  const intentTrace = buildLumiIntentTrace({
    dispatch: turnIntent,
    execution,
    text: input.traceText || decisionText,
    source: input.source || input.dispatch.source || input.dispatch.channel,
  });
  recordRoutingShadowComparison(shadowComparison.aligned, shadowComparison.externalCommitBlocked);
  if (!shadowComparison.aligned) {
    intentTrace.matchedRules.push({ layer: 'shadow_route', name: 'normalized-legacy-divergence' });
    intentTrace.reasons.push(`shadow route:${shadowComparison.reason}`);
    if (shadowComparison.externalCommitBlocked) {
      intentTrace.blockedBy.push('external_commit_route_divergence');
    }
  }
  return {
    normalizedIntent,
    turnIntent,
    capabilityPlan,
    executionPlan,
    execution,
    intentTrace,
    shadowComparison,
  };
}
