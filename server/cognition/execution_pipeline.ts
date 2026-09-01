import type { ToolPolicy } from '../personality/types';
import type { ToolRegistry } from '../tools/registry';
import type { ConversationActionContinuationState } from './action_continuation';
import {
  isExplicitArtifactCreationText,
  isExternalCommitConfirmationOnlyRequest,
  normalizeActionIntent,
  type NormalizedActionIntent,
} from './normalized_action_intent';
import {
  buildLumiCapabilitySelection,
  buildModelCapabilityPolicy,
  buildModelToolProjection,
  type LumiCapabilitySelection,
} from './capability_selection';
import { trustedContinuationEvidenceTools } from './tool_router';
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
import { hasExplicitNoMutationInstruction } from './tool_intent';
import type { PendingAssistantOfferContext } from './pending_assistant_offer';
import { buildActionContract } from './action_contract';
import type { ToolContext } from '../tools/types';

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
  authorizationPolicy: ToolPolicy;
  modelToolProjection: ReturnType<typeof buildModelToolProjection>;
  /** True only when this turn has a concrete, authorized capability to run. */
  executionRequested: boolean;
  /**
   * True only when the current request is an exact server-bound continuation
   * of the unfinished durable task.  Manifest visibility alone can never set
   * this bit.
   */
  trustedActionContinuation: boolean;
  intentTrace: LumiIntentTrace;
  shadowComparison: LumiRoutingShadowComparison;
}

export interface BuildLumiExecutionPipelineInput {
  dispatch: LumiTurnDispatchInput;
  /**
   * A caller may precompute the dispatch when it needs to apply a channel
   * identity boundary before the rest of the shared pipeline runs. The
   * normalized intent, capability plan, policy and execution plan are still
   * produced here; callers must not rebuild those pieces independently.
   */
  prebuiltDispatch?: LumiTurnDispatch;
  registry: ToolRegistry;
  personalityToolPolicy?: ToolPolicy;
  actionTaskState?: ConversationActionContinuationState | null;
  isSanctuary?: boolean;
  /** Additional channel/role denies, applied after all semantic adapters. */
  additionalForbiddenTools?: string[];
  decisionText?: string;
  traceText?: string;
  source?: string;
  /** Durable task identity supplied by non-conversation entrances such as scheduler/autonomy execution. */
  taskId?: string;
  pendingAssistantOfferContext?: PendingAssistantOfferContext;
}

function applyAdditionalForbiddenTools(
  execution: LumiExecutionDecision,
  forbiddenTools: string[] | undefined,
): LumiExecutionDecision {
  const additions = Array.from(new Set((forbiddenTools || []).filter(Boolean)));
  if (additions.length === 0) return execution;
  const forbidden = new Set([...(execution.toolPolicy.forbiddenTools || []), ...additions]);
  const blockAll = forbidden.has('*');
  const restrictPolicy = (policy: ToolPolicy | null): ToolPolicy | null => policy && ({
    ...policy,
    allowedTools: blockAll
      ? []
      : (policy.allowedTools || []).filter(name => !forbidden.has(name)),
    requireConfirmation: (policy.requireConfirmation || []).filter(name => !forbidden.has(name)),
    forbiddenTools: Array.from(forbidden),
    maxIterations: blockAll ? 0 : policy.maxIterations,
  });
  const toolPolicy = restrictPolicy(execution.toolPolicy)!;
  const toolRoute = execution.toolRoute
    ? {
        ...execution.toolRoute,
        toolNames: blockAll
          ? []
          : execution.toolRoute.toolNames.filter(name => !forbidden.has(name)),
        reasons: Array.from(new Set([
          ...execution.toolRoute.reasons,
          'the entry identity/role boundary removed forbidden tools',
        ])),
      }
    : null;
  return {
    ...execution,
    allowToolUse: blockAll ? false : execution.allowToolUse,
    baseToolPolicy: restrictPolicy(execution.baseToolPolicy)!,
    selfRepairToolPolicy: restrictPolicy(execution.selfRepairToolPolicy),
    clientActionToolPolicy: restrictPolicy(execution.clientActionToolPolicy),
    toolRoute,
    toolPolicy,
    maxIterations: blockAll ? 0 : execution.maxIterations,
    promptOverlay: [
      execution.promptOverlay,
      additions.length
        ? `Entry authorization boundary forbids: ${additions.join(', ')}.`
        : '',
    ].filter(Boolean).join('\n'),
  };
}

function applyCurrentTurnNoMutationConstraint(
  execution: LumiExecutionDecision,
  registry: ToolRegistry,
  text: string,
  visibilityContext?: Pick<ToolContext, 'userId' | 'domain' | 'orgId' | 'autonomous' | 'source'>,
): LumiExecutionDecision {
  // A confirmation-only external-commit request deliberately says both
  // "prepare to send" and "do not send now". It must expose the exact
  // external tool so the executor can create a bound pending confirmation;
  // the confirmation gate, not the generic read-only filter, prevents the
  // side effect. Ordinary negative commands remain fully read-only.
  if (isExternalCommitConfirmationOnlyRequest(text)) return execution;
  // "Create this exact file, but do not modify other files / send / publish"
  // is a scoped artifact boundary, not a veto of the requested local write.
  // The artifact route already removes messaging, client-surface and desktop
  // launch tools, while the executor still binds the write to the explicit
  // path supplied in this turn.
  if (isExplicitArtifactCreationText(text)) return execution;
  const normalizedIntent = normalizeActionIntent(text);
  // A bounded Lumi client navigation request may explicitly prohibit opening
  // other applications or changing content. That wording is a scope fence,
  // not a veto of the requested in-client navigation itself. The hardened
  // client-action policy already limits the turn to client_get_state and the
  // exact client_action route, so keep it intact while every unrelated
  // mutation remains unavailable.
  if (
    normalizedIntent.kind === 'client_navigation'
    && normalizedIntent.operation === 'navigate'
    && normalizedIntent.sideEffectClass === 'none'
    && normalizedIntent.target
  ) return execution;
  if (
    normalizedIntent.kind === 'desktop_operation'
    && normalizedIntent.operation === 'navigate'
    && normalizedIntent.sideEffectClass === 'none'
    && normalizedIntent.target
  ) return execution;
  // An explicitly requested persistent Lumi task is an internal ledger write.
  // A clause such as "do not send any messages" fences the later external
  // step; it must not veto creation of the requested local task record.
  if (
    normalizedIntent.kind === 'work_task'
    && normalizedIntent.operation === 'create'
    && normalizedIntent.sideEffectClass === 'local_write'
  ) return execution;
  if (!hasExplicitNoMutationInstruction(text)) return execution;
  const mutationTools = registry.getCapabilityManifest(undefined, { context: visibilityContext })
    .filter(entry => (
      entry.operation === 'create'
      || entry.operation === 'mutate'
      || entry.sideEffects.some(effect => effect.type !== 'local_read')
    ))
    .map(entry => entry.toolName);
  const restricted = applyAdditionalForbiddenTools(execution, mutationTools);
  return {
    ...restricted,
    promptOverlay: [
      execution.promptOverlay,
      'Current-turn read-only boundary: the user explicitly prohibited modification. Read/inspect/answer only; do not create, edit, save, send, submit, control, or mutate any state.',
    ].join('\n'),
  };
}

function hasTrustedActionContinuation(input: BuildLumiExecutionPipelineInput): boolean {
  const state = input.actionTaskState;
  const context = String(input.dispatch.continuationContext || '');
  if (!state?.unfinished || !state.taskId || !context) return false;
  const followup = context.match(/(?:^|\n)-\s*followupIntent:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase();
  const taskId = context.match(/(?:^|\n)-\s*taskId:\s*([^\r\n]+)/i)?.[1]?.trim();
  // Corrections and retries are continuations of the same server-owned task,
  // not new authorization requests.  Requiring the exact durable task id
  // keeps this boundary fail-closed while allowing a voice-to-text handoff
  // (whose classifier labels the turn `correction`) to retain the original
  // capability envelope.  `status` remains observational and must never
  // reacquire an execution lease.
  const executionFollowups = new Set(['execute', 'correction', 'retry', 'accept', 'confirm']);
  return executionFollowups.has(followup || '') && taskId === state.taskId;
}

function applySelectedWorkflowAdapterPolicy(
  execution: LumiExecutionDecision,
  turnIntent: LumiTurnDispatch,
  registry: ToolRegistry,
  personalityToolPolicy?: ToolPolicy,
  isSanctuary?: boolean,
  visibilityContext?: Pick<ToolContext, 'userId' | 'domain' | 'orgId' | 'autonomous' | 'source'>,
): LumiExecutionDecision {
  const workflow = turnIntent.flow.specialWorkflow;
  if (!workflow || isSanctuary) return execution;
  const configuredAllowed = new Set(personalityToolPolicy?.allowedTools || []);
  const configuredForbidden = new Set(personalityToolPolicy?.forbiddenTools || []);
  const configuredWildcard = configuredAllowed.has('*');
  const hasConfiguredBoundary = Boolean(personalityToolPolicy);
  const executable = new Map(registry
    .getCapabilityManifest(undefined, { executableOnly: true, context: visibilityContext })
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
    totalAvailable: registry.getToolDeclarations({ context: visibilityContext }).length,
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
  const turnIntent = input.prebuiltDispatch || buildLumiTurnDispatch(input.dispatch);
  const decisionText = input.decisionText || turnIntent.flow.routeText;
  const normalizedIntent = normalizeActionIntent(decisionText);
  const visibilityContext = {
    userId: input.dispatch.userId,
    domain: input.dispatch.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: input.dispatch.orgId,
    autonomous: turnIntent.flow.effectiveOperationMode === 'autonomous'
      || ['autonomy', 'scheduler'].includes(input.dispatch.channel),
    source: input.dispatch.source || input.dispatch.channel,
  };
  const trustedActionContinuation = hasTrustedActionContinuation(input);
  const legacyExecution = buildLumiExecutionDecision({
    flow: turnIntent.flow,
    text: decisionText,
    toolDeclarations: input.registry.getToolDeclarations({ context: visibilityContext }),
    toolRegistry: input.registry,
    personalityToolPolicy: input.personalityToolPolicy,
    actionTaskState: input.actionTaskState,
    trustedActionContinuation,
    pendingAssistantOfferContext: input.pendingAssistantOfferContext,
    isSanctuary: input.isSanctuary,
    visibilityContext,
  });
  const unrestrictedManifest = input.registry.getCapabilityManifest(legacyExecution.toolPolicy, { context: visibilityContext });
  const shadowComparison = compareLumiRoutingShadow({
    normalizedIntent,
    execution: legacyExecution,
    manifest: unrestrictedManifest,
  });
  const execution = applyAdditionalForbiddenTools(
    applyCurrentTurnNoMutationConstraint(
      applySelectedWorkflowAdapterPolicy(
        applyLumiRoutingShadowGuard(legacyExecution, shadowComparison),
        turnIntent,
        input.registry,
        input.personalityToolPolicy,
        input.isSanctuary,
        visibilityContext,
      ),
      input.registry,
      input.dispatch.text,
      visibilityContext,
    ),
    input.additionalForbiddenTools,
  );
  const selection = buildLumiCapabilitySelection({
    dispatch: turnIntent,
    execution,
    text: decisionText,
    userId: input.dispatch.userId,
    domain: input.dispatch.domain,
    orgId: input.dispatch.orgId,
    normalizedIntent,
    registry: input.registry,
  });
  const manifest = input.registry.getCapabilityManifest(execution.toolPolicy, { context: visibilityContext });
  const capabilityIds = Array.from(new Set(
    (execution.toolRoute?.toolNames || [])
      .map(toolName => manifest.find(entry => entry.toolName === toolName)?.capabilityId)
      .filter(Boolean) as string[],
  ));
  const authorizationPolicy = buildModelCapabilityPolicy(execution);
  const pinnedContinuationTools = trustedContinuationEvidenceTools({
    actionTaskState: input.actionTaskState,
    trustedActionContinuation,
  }, new Set(input.registry.getToolDeclarations({ context: visibilityContext }).map(declaration => declaration.function.name)));
  const workflowRequiredTools = (
    turnIntent.flow.workflowHint || turnIntent.flow.specialWorkflow
  )?.requiredTools || [];
  const actionVerificationTools = buildActionContract(decisionText).verificationTools || [];
  const modelToolProjection = buildModelToolProjection(execution, {
    lane: selection.lane,
    preferredTools: selection.preferredTools,
    pinnedTools: pinnedContinuationTools,
    requiredTools: [
      ...workflowRequiredTools,
      ...actionVerificationTools,
    ],
  });
  // Operation modes and manifest visibility define the authorization ceiling;
  // neither is current-turn execution authority. Main Chat deliberately lets
  // the model know which capabilities exist, but a greeting, correction about
  // Lumi's behaviour, or ordinary conversation must not become executable
  // merely because that manifest is visible. Only the current semantic turn,
  // an exact server-bound continuation, or a task-owned entry may open the
  // canonical tool loop.
  const turnOwnsExecution = Boolean(
    turnIntent.flow.allowToolUseForTurn
    || trustedActionContinuation
    || turnIntent.boundary === 'task_center'
    || turnIntent.boundary === 'work_takeover',
  );
  const executionRequested = Boolean(
    turnOwnsExecution
    && execution.allowToolUse
    && modelToolProjection.toolNames.length > 0,
  );
  const capabilityPlan: LumiCapabilityPlan = {
    ...selection,
    schemaVersion: 1,
    capabilityIds,
    taskLedgerRequired: Boolean(
      turnIntent.flow.completionEvidenceNeeded
      || executionRequested
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
    authorizationPolicy,
    modelToolProjection,
    executionRequested,
    trustedActionContinuation,
    intentTrace,
    shadowComparison,
  };
}
