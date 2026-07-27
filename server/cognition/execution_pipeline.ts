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

export interface LumiCapabilityPlan extends LumiCapabilitySelection {
  schemaVersion: 1;
  capabilityIds: string[];
  taskLedgerRequired: boolean;
}

export interface LumiExecutionPipeline {
  normalizedIntent: NormalizedActionIntent;
  turnIntent: LumiTurnDispatch;
  capabilityPlan: LumiCapabilityPlan;
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
  const execution = applyLumiRoutingShadowGuard(legacyExecution, shadowComparison);
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
  const intentTrace = buildLumiIntentTrace({
    dispatch: turnIntent,
    execution,
    text: input.traceText || decisionText,
    source: input.source || input.dispatch.source || input.dispatch.channel,
  });
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
    execution,
    intentTrace,
    shadowComparison,
  };
}
