import { TurnAnalysis } from './turn_analysis';
import { resolveUserTurn, type TurnResolution } from './turn_resolution';
import { restrictToolPolicyForExecutionBoundary, restrictVisibleToolRouteForExecutionBoundary } from '../tools/remote_policy';
import type { ToolPolicy } from '../personality/types';
import { localBusinessAnalysisBoundary } from "../regions/routing/business_routing";
import { normalizeStructuredMediaRequest, structuredMediaRoutingEnvelope, structuredMediaToolCall, type StructuredMediaRequest } from '../../shared/media_generation';
import type { ToolRegistry } from '../tools/registry';
import { isCurrentContinuationTask, isTaskPreparationContinuation, type ConversationActionContinuationState, type RecentActionFollowupIntent } from './action_continuation';
import { revalidateAcceptedTaskRelation, resolveActiveTaskMessageRelation, taskRelationFollowupIntent, formatActiveTaskRelationContext, type ActiveTaskMessageResolution } from './task_concurrency';
import {
  isExplicitArtifactCreationText,
  isExternalCommitConfirmationOnlyRequest,
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
  restrictLumiExecutionTools,
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
  applyExternalCapabilityBoundary,
  validateExternalCapabilityBoundary,
  type LumiExternalCapabilityBoundary,
} from './external_capability_boundary';
import {
  buildCapabilityExecutionPlan,
  formatCapabilityExecutionPlanPrompt,
  type CapabilityExecutionPlan,
} from './capability_execution_plan';
import { recordExternalCapabilityValidation } from '../runtime/capability_metrics';
import { observeLayaDecision } from '../runtime/laya_shadow';
import { hasExplicitNoMutationInstruction } from './tool_intent';
import { avatarAuthoringMutationInstruction } from './media_creation_intent';
import { executionBeforeWorkflowSave } from '../skills/authoring_intent';
import type { PendingAssistantOfferContext } from './pending_assistant_offer';
import type { ToolContext } from '../tools/types';
import { resolveAcceptedTaskTarget } from '../conversation/task_target_anchor';
import { resolveAcceptedFilePlan } from '../conversation/task_plan_reference';
import { isPreservedSourceOutputTool, preservedSourceOutputScope, preservedSourceOutputTools, requestedSingleArtifact } from './artifact_write_scope';

export interface LumiCapabilityPlan extends LumiCapabilitySelection {
  schemaVersion: 1;
  capabilityIds: string[];
  taskLedgerRequired: boolean;
}

export interface LumiExecutionPipeline {
  resolution: TurnResolution;
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
  actionFollowupIntent: RecentActionFollowupIntent;
  taskRelation: ActiveTaskMessageResolution;
  intentTrace: LumiIntentTrace;
  externalCapabilityBoundary: LumiExternalCapabilityBoundary;
}

export interface BuildLumiExecutionPipelineInput {
  requestId?: string;
  /** Server-owned semantic snapshot captured at admission, never accepted from a client. */
  acceptedResolution?: TurnResolution;
  /** Original visible user wording, before channel envelopes or model hints. */
  userText?: string;
  /** Explicit creation operation; still subject to ordinary authorization and current-turn vetoes. */
  structuredMediaRequest?: StructuredMediaRequest | null;
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
  /** Already resolved by the accepted-turn/queue boundary, never client input. */
  taskRelation?: ActiveTaskMessageResolution;
  isSanctuary?: boolean;
  executionBoundary?: ToolContext['executionBoundary'];
  /** Additional channel/role denies, applied after all semantic adapters. */
  additionalForbiddenTools?: string[];
  decisionText?: string;
  traceText?: string;
  source?: string;
  /** Durable task identity supplied by non-conversation entrances such as scheduler/autonomy execution. */
  taskId?: string;
  pendingAssistantOfferContext?: PendingAssistantOfferContext;
  /** Only persistence-loaded messages from the authorized conversation. */
  persistedConversationHistory?: Parameters<typeof resolveAcceptedTaskTarget>[0]['persistedHistory'];
}

function applyCurrentTurnNoMutationConstraint(
  execution: LumiExecutionDecision,
  registry: ToolRegistry,
  text: string,
  visibilityContext?: Pick<ToolContext, 'userId' | 'domain' | 'orgId' | 'autonomous' | 'source'>,
  acceptedIntent?: Readonly<NormalizedActionIntent>,
  analysis = new TurnAnalysis(),
): LumiExecutionDecision {
  const originalText = text;
  // A confirmation-only external-commit request deliberately says both
  // "prepare to send" and "do not send now". It must expose the exact
  // external tool so the executor can create a bound pending confirmation;
  // the confirmation gate, not the generic read-only filter, prevents the
  // side effect. Ordinary negative commands remain fully read-only.
  if (isExternalCommitConfirmationOnlyRequest(text)) return execution;
  if (analysis.authoring(text) === 'use') {
    // A prohibition on creating another run must still forbid run_workflow,
    // but does not revoke approval of one step in the existing run.
    // i18n-allow: narrowly scoped workflow run creation prohibition.
    const withoutNewRunFence = text.replace(/(?:不要|不|别|禁止)\s*(?:再)?(?:创建|新建)\s*(?:新(?:的)?|另一个|另外的)运行/gu, ' ');
    if (withoutNewRunFence !== text) {
      execution = restrictLumiExecutionTools(execution, ['run_workflow']);
      text = withoutNewRunFence;
    }
  }
  const preservedOutput = preservedSourceOutputScope(text);
  // "Create this exact file, but do not modify other files / send / publish"
  // is a scoped artifact boundary, not a veto of the requested local write.
  // The artifact route already removes messaging, client-surface and desktop
  // launch tools, while the executor still binds the write to the explicit
  // path supplied in this turn.
  if (isExplicitArtifactCreationText(text) && !preservedOutput) return execution;
  const normalizedIntent = acceptedIntent && text === originalText ? acceptedIntent : analysis.intent(text);
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
  const avatarInstruction = avatarAuthoringMutationInstruction(text);
  const scopedAvatarAuthoring = avatarInstruction !== null && !hasExplicitNoMutationInstruction(avatarInstruction);
  const businessBoundary = localBusinessAnalysisBoundary(text);
  const scopedBusinessTools = businessBoundary && !hasExplicitNoMutationInstruction(businessBoundary.instruction) ? businessBoundary.tools : [];
  const requestedWorkflowCapture = preservedOutput && executionBeforeWorkflowSave(text);
  const scopedTools = new Set([
    ...scopedBusinessTools,
    ...(scopedAvatarAuthoring ? ['memory_avatar_create', 'memory_avatar_import_image', 'memory_avatar_configure_animation', 'generate_image', 'ai_edit_image', 'get_image_generation_status'] : []),
    ...(preservedOutput ? ['code_execution'] : []),
    ...(requestedWorkflowCapture ? ['capture_recent_workflow', 'save_workflow'] : []),
  ]);
  const mutationTools = registry.getCapabilityManifest(undefined, { context: visibilityContext })
    .filter(entry => !scopedTools.has(entry.toolName) && (!preservedOutput || !isPreservedSourceOutputTool(entry.toolName)) && (
      entry.operation === 'create'
      || entry.operation === 'mutate'
      || entry.sideEffects.some(effect => effect.type !== 'local_read')
    ))
    .map(entry => entry.toolName);
  const restricted = restrictLumiExecutionTools(execution, mutationTools);
  return {
    ...restricted,
    promptOverlay: [
      execution.promptOverlay,
      scopedBusinessTools.length
        ? 'Only source-bound local business analysis and its task receipts may persist. Do not write personal memory, access store accounts, mutate external state, or perform unrelated local writes.'
        : scopedAvatarAuthoring
        ? 'Only the requested memory-person authoring and image operations may mutate state. Preserve existing people and all implementation files. Do not edit code/databases, send messages, or start a livestream.'
        : preservedOutput
        ? 'Preserve the original input file. Read and calculate, then save only the separately requested local output. Do not modify the source or send, submit, launch, or mutate unrelated state.'
        : 'Current-turn read-only boundary: the user explicitly prohibited modification. Read/inspect/answer only; do not create, edit, save, send, submit, control, or mutate any state.',
    ].join('\n'),
  };
}

function hasTrustedActionContinuation(input: BuildLumiExecutionPipelineInput, relation: ActiveTaskMessageResolution): boolean {
  const state = input.actionTaskState;
  // A formatted prompt is presentation, not authority. Only the server's
  // accepted task binding may restore the existing execution envelope.
  return Boolean(state?.unfinished && state.taskId
    && relation.binding === 'active_task'
    && relation.taskId === state.taskId
    && relation.revision === state.revision
    && taskRelationFollowupIntent(relation) === 'execute'
    && isCurrentContinuationTask(input.dispatch.text, state));
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
  const mediaRequest = normalizeStructuredMediaRequest(input.structuredMediaRequest);
  // The operation is an explicit workbench instruction; its prompt is media
  // content, not a second instruction about Lumi's tools/UI. Keep any separate
  // user veto in the routing text and retain the normal policy/visibility gates.
  // Exact tool arguments still come from the validated, task-bound envelope.
  const mediaDecisionText = mediaRequest ? [
    structuredMediaRoutingEnvelope(mediaRequest),
    input.dispatch.text.split(mediaRequest.prompt).join('[media brief]'),
  ].join('\n\n') : null;
  const acceptedPlan = mediaRequest ? null : resolveAcceptedFilePlan({ text: input.dispatch.text, history: input.persistedConversationHistory });
  const effectiveText = mediaDecisionText || acceptedPlan?.text || input.dispatch.text;
  const resolution = input.acceptedResolution || resolveUserTurn({
    requestId:input.requestId, userText:input.userText ?? input.dispatch.text,
    state:input.actionTaskState, taskRelation:input.taskRelation,
    options:{pendingAssistantOfferContext:input.pendingAssistantOfferContext},
  });
  if (input.acceptedResolution && (resolution.userText !== (input.userText ?? input.dispatch.text)
    || input.requestId && resolution.requestId !== input.requestId)) throw new Error('Accepted turn resolution does not match this request');
  const analysis = new TurnAnalysis(resolution);
  const taskRelation = acceptedPlan || mediaRequest
    ? resolveActiveTaskMessageRelation(effectiveText, null)
    : revalidateAcceptedTaskRelation(input.taskRelation || resolution.taskRelation, input.actionTaskState);
  const boundTaskState = taskRelation.taskId === input.actionTaskState?.taskId
    && (taskRelation.binding === 'active_task' || taskRelation.binding === 'previous_task') ? input.actionTaskState : undefined;
  const actionFollowupIntent = acceptedPlan || mediaRequest ? 'none' : taskRelationFollowupIntent(taskRelation);
  const queryTarget = resolution.queryTarget;
  const observationalFollowup = queryTarget === 'conversation_receipts'
    && (actionFollowupIntent === 'status' || actionFollowupIntent === 'repeat');
  const trustedActionContinuation = !acceptedPlan && !mediaRequest && hasTrustedActionContinuation(input, taskRelation);
  const continuationContext = input.dispatch.continuationContext
    || (trustedActionContinuation ? formatActiveTaskRelationContext(taskRelation, input.actionTaskState) : '');
  const dispatched = input.prebuiltDispatch && !input.actionTaskState && !input.taskRelation && !mediaRequest && !acceptedPlan
    ? input.prebuiltDispatch
    : buildLumiTurnDispatch({ ...input.dispatch, analysis, text: effectiveText, continuationContext, actionFollowupIntent,
      continuationAppTarget: !mediaRequest && !acceptedPlan && taskRelation.binding !== 'stale'
        && input.actionTaskState && isCurrentContinuationTask(input.dispatch.text, input.actionTaskState)
        ? input.actionTaskState.appTarget : undefined });
  const acceptedTaskTarget = resolveAcceptedTaskTarget({
    text: input.dispatch.text,
    persistedHistory: input.persistedConversationHistory,
    previousTask: boundTaskState?.taskCapsule,
  });
  const turnIntent = {
    ...dispatched,
    flow: { ...dispatched.flow, acceptedTaskTarget },
    promptOverlay: [dispatched.promptOverlay, acceptedPlan
      ? 'The current user accepted this immediately preceding user-authored file plan: ' + JSON.stringify(acceptedPlan)
        + '. Execute this goal using current file evidence. Do not merge older task revisions or ask the user to choose an older version. Normal tool authorization and confirmation boundaries still apply.'
      : ''].filter(Boolean).join('\n'),
  };
  let decisionText = mediaDecisionText || (acceptedPlan ? turnIntent.flow.routeText : input.decisionText || turnIntent.flow.routeText);
  if (trustedActionContinuation) turnIntent.flow.rootTaskText = input.actionTaskState?.goal;
  // Bind the planning input as well as the ledger id. Detailed "continue the
  // unfinished task" messages can themselves resemble authoring requests;
  // routing that fragment alone discards the still-pending business actions.
  // Only an exact server-bound resumption may use the durable user's goal.
  // A short confirmation has no standalone capability semantics. Route the
  // exact bound root goal while the tool executor still consumes only the
  // approved call; further side effects retain their ordinary confirmation gate.
  const actionText = trustedActionContinuation
    ? [input.actionTaskState!.goal, effectiveText].join('\n\n')
    : effectiveText;
  if (trustedActionContinuation) {
    decisionText = actionText;
    // Prompt hints include historical errors and advice such as "do not
    // restart/cancel". They describe state; they are not additional user
    // operations or completion requirements. Route and verify only the
    // durable goal plus the user's current instruction.
    turnIntent.flow.routeText = actionText;
  }
  if (trustedActionContinuation && isTaskPreparationContinuation(input.dispatch.text, input.actionTaskState,
    input.dispatch.text === resolution.userText ? resolution.userIntent : undefined, analysis)) {
    turnIntent.flow.preparationRootText = input.actionTaskState?.goal;
  }
  // A bound retry inherits its authorized goal, not the side-effect class of
  // the acknowledgement ("yes"). Keep current-turn denials authoritative below.
  const currentIntent = decisionText === resolution.userText
    ? { ...resolution.userIntent } : { ...analysis.intent(decisionText) };
  const requestedArtifact = requestedSingleArtifact(actionText, analysis);
  // An input/output transformation writes the destination, never the first
  // source path that a generic action recognizer happened to encounter.
  if (requestedArtifact && currentIntent.operation === 'create') {
    currentIntent.target = requestedArtifact.path;
  }
  const priorIntent = trustedActionContinuation && currentIntent.kind === 'none'
    ? analysis.intent(input.actionTaskState?.goal || '') : undefined;
  const resumesMediaGoal = priorIntent?.kind === 'media_generation';
  const normalizedIntent = resumesMediaGoal ? priorIntent! : currentIntent;
  if (resumesMediaGoal && input.actionTaskState?.goal) {
    turnIntent.flow.routeText = [input.actionTaskState.goal, turnIntent.flow.routeText].join('\n\n');
  }
  const visibilityContext = {
    executionBoundary: input.executionBoundary,
    userId: input.dispatch.userId,
    domain: input.dispatch.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: input.dispatch.orgId,
    autonomous: turnIntent.flow.effectiveOperationMode === 'autonomous'
      || ['autonomy', 'scheduler'].includes(input.dispatch.channel),
    source: input.dispatch.source || input.dispatch.channel,
  };
  const routedExecution = buildLumiExecutionDecision({
    flow: turnIntent.flow,
    analysis,
    text: decisionText,
    userText: resolution.userText,
    queryTarget,
    toolDeclarations: input.registry.getToolDeclarations({ context: visibilityContext }),
    toolRegistry: input.registry,
    personalityToolPolicy: input.personalityToolPolicy,
    actionTaskState: input.actionTaskState,
    trustedActionContinuation,
    pendingAssistantOfferContext: input.pendingAssistantOfferContext,
    isSanctuary: input.isSanctuary,
    visibilityContext,
  });
  const unrestrictedManifest = input.registry.getCapabilityManifest(routedExecution.toolPolicy, { context: visibilityContext });
  const externalCapabilityBoundary = validateExternalCapabilityBoundary({
    normalizedIntent,
    execution: routedExecution,
    manifest: unrestrictedManifest,
  });
  const constraintText = trustedActionContinuation && !preservedSourceOutputScope(actionText) ? effectiveText : actionText;
  const execution = restrictLumiExecutionTools(
    applyCurrentTurnNoMutationConstraint(
      applyExternalCapabilityBoundary(routedExecution, externalCapabilityBoundary),
      input.registry,
      constraintText,
      visibilityContext,
      constraintText === resolution.userText ? resolution.userIntent : undefined,
      analysis,
    ),
    observationalFollowup || taskRelation.binding === 'stale'
      ? ['*', ...(input.additionalForbiddenTools || [])] : input.additionalForbiddenTools,
  );
  // Resolve the entry ceiling before publishing any capability, plan or schema.
  // Consumers use this same policy/projection; the registry still enforces it.
  const authorizationPolicy = restrictToolPolicyForExecutionBoundary(buildModelCapabilityPolicy(execution), input.executionBoundary);
  execution.toolRoute = restrictVisibleToolRouteForExecutionBoundary(execution.toolRoute, input.executionBoundary);
  execution.baseToolPolicy = execution.toolPolicy = authorizationPolicy;
  execution.maxIterations = authorizationPolicy.maxIterations;
  const selection = buildLumiCapabilitySelection({
    dispatch: turnIntent,
    execution,
    analysis,
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
  const pinnedContinuationTools = trustedContinuationEvidenceTools({
    actionTaskState: input.actionTaskState,
    trustedActionContinuation,
  }, new Set(input.registry.getToolDeclarations({ context: visibilityContext }).map(declaration => declaration.function.name)));
  const workflowRequiredTools = turnIntent.flow.workflowHint?.requiredTools || [];
  const actionVerificationTools = analysis.contract(decisionText).verificationTools || [];
  const modelToolProjection = buildModelToolProjection(execution, {
    lane: selection.lane,
    preferredTools: selection.preferredTools,
    pinnedTools: pinnedContinuationTools,
    requiredTools: [
      ...(mediaRequest ? [structuredMediaToolCall(mediaRequest).name] : []),
      ...workflowRequiredTools,
      ...actionVerificationTools,
      ...preservedSourceOutputTools(actionText, acceptedTaskTarget),
      ...(requestedArtifact ? [requestedArtifact.producer, requestedArtifact.reader] : []),
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
    || Boolean(turnIntent.flow.workflowHint)
    || queryTarget === 'runtime_work'
    || trustedActionContinuation
    || turnIntent.boundary === 'task_center'
    || turnIntent.boundary === 'work_takeover',
  );
  const executionRequested = Boolean(
    turnOwnsExecution
    && execution.allowToolUse
    && modelToolProjection.toolNames.length > 0,
  );
  // Publish the actual projection state; catalog visibility is not execution.
  execution.promptOverlay = execution.promptOverlay.replace(/tools=(?:available|off)/u,
    'tools=' + (executionRequested ? 'available' : 'off'));
  if (!executionRequested) {
    turnIntent.flow.allowToolUseForTurn = false;
    turnIntent.flow.promptOverlay = turnIntent.flow.promptOverlay.replace(/Tool access: [^.]+\./u, 'Tool access: chat-only.');
  }
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
    taskId: input.taskId || boundTaskState?.taskId,
    sourcePaths: boundTaskState?.sourcePaths,
  });
  capabilityPlan.promptOverlay = [
    capabilityPlan.promptOverlay,
    formatCapabilityExecutionPlanPrompt(executionPlan),
  ].filter(Boolean).join('\n\n');
  const intentTrace = buildLumiIntentTrace({
    normalizedActionIntent: normalizedIntent,
    dispatch: turnIntent,
    execution,
    text: input.traceText || decisionText,
    source: input.source || input.dispatch.source || input.dispatch.channel,
  }, analysis);
  recordExternalCapabilityValidation(externalCapabilityBoundary.aligned, externalCapabilityBoundary.externalCommitBlocked);
  if (!externalCapabilityBoundary.aligned) {
    intentTrace.matchedRules.push({ layer: 'external_capability', name: 'instruction-capability-mismatch' });
    intentTrace.reasons.push(`external capability boundary:${externalCapabilityBoundary.reason}`);
    if (externalCapabilityBoundary.externalCommitBlocked) {
      intentTrace.blockedBy.push('external_commit_route_divergence');
    }
  }
  // Observation is one-way and asynchronous. Laya cannot change this plan,
  // permissions, task ownership, completion receipts or the user's response.
  if (!input.isSanctuary) observeLayaDecision({
    text: input.dispatch.text,
    task: input.actionTaskState ? { goal: input.actionTaskState.goal, status: input.actionTaskState.status,
      unfinished: input.actionTaskState.unfinished, latestBlocker: input.actionTaskState.latestBlocker } : undefined,
    decision: { followup: actionFollowupIntent, skill: analysis.authoring(input.dispatch.text), executionRequested },
  });
  return {
    resolution: Object.freeze({ ...resolution, taskRelation:Object.freeze({ ...taskRelation }) }),
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
    externalCapabilityBoundary,
    actionFollowupIntent,
    taskRelation,
  };
}
