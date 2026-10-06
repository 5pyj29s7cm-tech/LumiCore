import type { IncomingMessage } from "../../../../messaging/types";
import { getMember } from "../../../../org/db";
import { captureMessagingOrganization, isMessagingAuthorizationCurrent as isAcceptedMessagingAuthorizationCurrent } from "../../../../messaging/turn_authorization";
import { requestsOrganizationScope } from "../../../../messaging/personal_org_scope";
import { isRemoteConversationDismissalRequest } from "../../../../messaging/attachment_context";
import { resolveUserTurn, type TurnResolution } from "../../../../cognition/turn_resolution";
import { isPureOperationModeSwitchRequest, type OperationMode } from "../../../../cognition/operation_modes";
import type { PersonalityConfig } from "../../../../personality/types";
import type { PendingAssistantOfferContext } from "../../../../cognition/pending_assistant_offer";
import { cancelConversationActionExecution, getMessagesByTokenBudget, getMessagesThroughExternalMessage, prepareConversationActionExecution, startConversationActionExecutionHeartbeat } from "../../../../conversation/manager";
import { resolveAcceptedTurnConfirmation, type AcceptedUserTurnAdmission } from "../../../../socket/action_turn_durability";
import { flushDBOrThrow } from "../../../../../db_layer";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably } from "../../../../tools/pending_confirmation";
import { clearPendingLegalNotice } from "../../../../messaging/legal_notice_pending";
import { revalidateAcceptedTaskRelation, taskRelationFollowupIntent } from "../../../../cognition/task_concurrency";
import { getStoredOperationMode } from "../../../../cognition/operation_mode_store";
import { persistExplicitRemoteRelationshipMemories } from "../remote_memory";
import { generateSystemPrompt } from "../../../../personality/engine";
import { buildUnifiedLegalEntryPrompt } from "../../../../cognition/legal_entry";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../messages/task_execution_messages";
import { createConversationReceiptObserver } from "../../../../conversation/execution_receipt_archive";
import type { OrganizationWorkExecution } from "../../../../org/work_routing";
import { type MessagingRouteOptions, flushMessagingStateOrThrow, buildRemoteRuntimeEvidenceContext, type MessagingDesktopRelay } from "../messaging_finalization";
import { remotePlatformLabel, getRequestText, buildRemoteTurnIntentText } from "../remote_materials";
import { assertMessagingAuthorization, isMessagingAuthorizationCurrent, newerMessageSupersedesThisTurn, registerActiveMessageRouteController } from "../messaging_ingress_runtime";
import { createMessagingReplyCommitter, conversationForMessagingTurn } from "../messaging_persistence";
import { messagingPendingOffer, buildRemoteConversationHistory } from './history';
import { buildRemoteLumiExecutionPlan } from './remote_plan';

export async function prepareMessagingTurn(msg: IncomingMessage, options?: MessagingRouteOptions, preacceptedAdmission?: AcceptedUserTurnAdmission<string> | null, acceptedTurn?: { resolution: TurnResolution; pendingAssistantOfferContext?: PendingAssistantOfferContext }) {

  msg = captureMessagingOrganization(msg);
  assertMessagingAuthorization(msg);
  const llm = options?.llmGetters;
  const requestText = getRequestText(msg);
  const registry = options?.personalityRegistry;
  const isIdentityBound = Boolean(msg.boundUserId);
  const isOrganizationBound = Boolean(msg.boundUserId && msg.boundOrgId);
  const effectiveUserId = isIdentityBound ? msg.boundUserId! : 'anonymous';
  const domain = isOrganizationBound ? 'work' as const : 'personal' as const;
  const orgId = isOrganizationBound ? msg.boundOrgId! : '';
  const source = `${msg.platform}_bot`;
  const requestId = `${source}:${msg.messageId}`;
  const flushTerminalReply = async (): Promise<void> => {
    if (isIdentityBound) await flushMessagingStateOrThrow('terminal_reply');
  };
  const conversation = isIdentityBound ? conversationForMessagingTurn(msg) : null;
  // The public entry already persisted and flushed the accepted turn before queue admission.
  const acceptedTurnAdmission = preacceptedAdmission;
  if (isIdentityBound && (!conversation || !acceptedTurnAdmission || acceptedTurnAdmission.persisted !== msg.userMessageId)) {
    throw new Error('The admitted remote turn lost its original conversation or durability token.');
  }
  const actionAbortController = new AbortController();
  let organizationWorkExecution: OrganizationWorkExecution | null = null;
  const actionWasCancelled = () => (
    actionAbortController.signal.aborted || newerMessageSupersedesThisTurn(msg) || !isMessagingAuthorizationCurrent(msg)
    || Boolean(organizationWorkExecution && !organizationWorkExecution.isCurrent())
  );
  const commitReply = createMessagingReplyCommitter(msg, {
    flush: flushTerminalReply, isCancelled: actionWasCancelled, onConversationUpdated: options?.onConversationUpdated,
  });
  const pendingAssistantOfferContext = acceptedTurn
    ? acceptedTurn.pendingAssistantOfferContext : messagingPendingOffer(msg, conversation);
  const confirmationChannelScope = conversation
    ? buildTransportNeutralConfirmationScope({
        domain,
        orgId,
        conversationId: conversation.id,
      })
    : undefined;
  let confirmationScope = conversation
    ? buildTransportNeutralConfirmationScope({
        domain,
        orgId,
        conversationId: conversation.id,
        taskId: conversation.actionContinuationState?.taskId,
      })
    : undefined;
  if (isRemoteConversationDismissalRequest(requestText)) {
    if (isIdentityBound) {
      clearPendingLegalNotice(msg, effectiveUserId);
      if (confirmationScope) {
        await clearPendingConfirmationDurably(effectiveUserId, confirmationScope);
      }
      if (confirmationChannelScope) {
        await clearPendingConfirmationDurably(effectiveUserId, confirmationChannelScope);
      }
      if (conversation?.actionContinuationState?.unfinished) {
        cancelConversationActionExecution(
          conversation.id,
          effectiveUserId,
          'The user ended the current remote foreground exchange.',
        );
      }
    }
    const dismissalReply = /[\u3400-\u9fff]/u.test(requestText)
      ? '好，有需要再叫我。'
      : 'Okay. I\'m here when you need me.';
    return { terminal: await ( await commitReply(dismissalReply)), context: undefined };
  }
  const turnResolution = acceptedTurn?.resolution || resolveUserTurn({
    requestId, userText: requestText, state: conversation?.actionContinuationState,
    options: { pendingAssistantOfferContext },
  });
  const acceptedRelation = revalidateAcceptedTaskRelation(turnResolution.taskRelation, conversation?.actionContinuationState);
  const confirmationResolution = isIdentityBound
    && acceptedTurnAdmission
    && confirmationScope
    && confirmationChannelScope
    ? await resolveAcceptedTurnConfirmation({
        admission: acceptedTurnAdmission,
        userId: effectiveUserId,
        userText: requestText,
        actionState: conversation?.actionContinuationState,
        taskRelation: acceptedRelation,
        taskScope: confirmationScope,
        channelScope: confirmationChannelScope,
      })
    : null;
  if (confirmationResolution) confirmationScope = confirmationResolution.scope;
  const pendingConfirmation = confirmationResolution?.pending || null;
  const pendingConfirmationPrompt = confirmationResolution?.prompt || '';
  const correctionRequiresFreshConfirmation =
    confirmationResolution?.correctionRequiresFreshConfirmation === true;
  assertMessagingAuthorization(msg);
  const organizationMembership = isOrganizationBound ? getMember(orgId, effectiveUserId) : null;
  const canWriteOrganization = organizationMembership?.status === 'active' && organizationMembership.role !== 'viewer';
  // Capability selection is authorized by this user turn, not by words inside
  // an attachment or its cache path. The full attachment remains available in
  // the model's user message for read-only analysis, while planning, task
  // relation, tool projection and confirmation bind only to current wording.
  const routingText = buildRemoteTurnIntentText(msg, pendingConfirmationPrompt);
  const operationMode = isIdentityBound ? getStoredOperationMode(effectiveUserId) : 'chat';
  let personality: PersonalityConfig | null = null;
  if (registry) {
    try {
      personality = registry.getForUser('lumi', isIdentityBound ? effectiveUserId : undefined, domain === 'work' ? orgId : undefined)
        || registry.getDefault();
    } catch (error: any) {
      console.warn('[Messaging] Personality configuration unavailable:', error.message);
    }
  }
  const executionPlan = buildRemoteLumiExecutionPlan({
    requestId,userText:requestText,acceptedResolution:turnResolution,
    actionTaskState:conversation?.actionContinuationState,
    userId: effectiveUserId,
    text: routingText,
    source,
    domain,
    orgId,
    operationMode,
    identityBound: isIdentityBound,
    canWriteOrganization,
    personalityToolPolicy: personality?.toolPolicy,
    pendingAssistantOfferContext,
  });
  const priorMessages = conversation
    ? getMessagesByTokenBudget(conversation.id, 6000, 8, msg.messageId)
    : [];
  const priorRuntimeEvidence = conversation
    ? buildRemoteRuntimeEvidenceContext(getMessagesThroughExternalMessage(conversation.id, msg.messageId, 12))
    : '';
  const conversationHistory = buildRemoteConversationHistory(priorMessages, msg);

  let explicitRemoteMemoryIds: string[] = [];
  if (isIdentityBound) {
    try {
      explicitRemoteMemoryIds = persistExplicitRemoteRelationshipMemories(msg);
    } catch (error: any) {
      console.warn('[Messaging] Explicit remote relationship memory failed:', error?.message || error);
    }
  }
  if (newerMessageSupersedesThisTurn(msg)) return { terminal: await ( ''), context: undefined };

  const requestedMode = executionPlan.turnIntent.flow.requestedMode;
  // A semantic action match is only a planning hint. It must not silently
  // mutate the user's persisted client mode before the model has decided to
  // act. Keep the deterministic native fast path solely for an exact, explicit
  // mode-switch command; compound work remains model-owned.
  const directlyAppliedMode: OperationMode | null = requestedMode
    && isPureOperationModeSwitchRequest(requestText, requestedMode)
    ? requestedMode
    : null;

  // ── Build system prompt from Lumi personality ──
  let systemPrompt = '';

  if (personality) {
    try {
      const memories = isIdentityBound && options?.queryMemories
        ? options.queryMemories({ userId: effectiveUserId, query: requestText, limit: 5, minConfidence: 0.4, domain, orgId })
        : [];
      const emotionalStateKey = domain === 'work' ? `${effectiveUserId}:org:${orgId}` : effectiveUserId;
      const emotionalState = isIdentityBound && options?.loadEmotionalState ? options.loadEmotionalState(emotionalStateKey) : undefined;

      systemPrompt = generateSystemPrompt(
        personality,
        { mode: executionPlan.executionRequested ? 'task' : 'chat', sensory: { audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 } },
        {
          memories: memories.length > 0 ? memories : undefined,
          emotionalState,
          userId: effectiveUserId,
          userText: requestText,
          domain,
          orgId,
        },
      );
    } catch (err: any) {
      console.warn(`[Messaging] ${source} personality build failed, using fallback:`, err.message);
    }
  }

  if (!systemPrompt) {
    systemPrompt = `You are Lumi, speaking with the user through ${remotePlatformLabel(msg.platform)}. Keep the response concise, useful, and natural, and follow the user's language.`;
  }
  if (isOrganizationBound) {
    systemPrompt += `\n\nThis ${remotePlatformLabel(msg.platform)} session is routed from the same personal Lumi into an organization work domain. Organization ID: ${orgId}. Member role: ${organizationMembership?.role || 'unknown'}. Use only this organization's work memory and data for the turn, and do not write organization content into personal memory automatically. You may analyze the current message and supplied attachments. Organization knowledge lookup and case archive actions must run through server tools. Never claim an organization write unless a tool result confirms it. Legal materials require final review by a qualified lawyer.`;
  } else if (isIdentityBound) {
    systemPrompt += `\n\nThis ${remotePlatformLabel(msg.platform)} user is bound to personal Lumi, and this turn remains in the personal domain. Use the user's personal identity, personality, and conversation memory, and synchronize the turn with personal Lumi chat. Personal Lumi may enter an authorized organization only when the user explicitly selects one, the task resolves to one organization, or an existing organization session scope is retained. No organization scope was resolved for this turn, so do not access or claim access to organization data.`;
  } else {
    systemPrompt += `\n\nThis ${remotePlatformLabel(msg.platform)} user has no verified Lumi identity binding. You may analyze text and attachments supplied in this turn, but do not claim access to organization knowledge, organization cases, or private local data. Only the server binding record can confirm identity; never declare a successful binding merely because the user says it is bound or asks for confirmation.`;
  }
  const attachmentContext = msg.raw?.lumiAttachmentContext;
  if (attachmentContext?.cleared) {
    systemPrompt += '\n\nThe user just cleared the material context for this exact remote conversation. Confirm it briefly. Do not use or mention any earlier attachments.';
  } else if (attachmentContext?.totalCount > 0) {
    systemPrompt += `\n\nRemote material continuity: ${attachmentContext.totalCount} verified locally cached attachment(s) are available in this exact member/chat/thread scope, including ${attachmentContext.carriedCount || 0} carried from earlier turns. Use them for follow-up questions without asking the user to upload again. Never carry them into another member, organization, chat, or thread. If this turn added new files, briefly tell the user once that the materials will remain available in this conversation and can be cleared by sending “清除会话材料”.`;
  }

  const legalOverlay = buildUnifiedLegalEntryPrompt({
    text: routingText,
    domain,
    orgId,
    channel: msg.platform,
    source: `${msg.platform}_bot`,
  });
  if (legalOverlay) systemPrompt += `\n\n${legalOverlay}`;

  const turnDispatch = executionPlan.turnIntent;
  const turnFlow = turnDispatch.flow;
  const executionDecision = executionPlan.execution;
  const capabilitySelection = executionPlan.capabilityPlan;
  const modelToolPolicy = executionPlan.authorizationPolicy;
  const modelToolProjection = executionPlan.modelToolProjection;
  const toolSessionActive = executionPlan.executionRequested;
  const actionFollowupIntent = taskRelationFollowupIntent(acceptedRelation);
  const actionTaskExecution = isIdentityBound && conversation
    ? prepareConversationActionExecution({
        conversationId: conversation.id,
        userId: effectiveUserId,
        userText: requestText,
        requestId,
        userMessageId: msg.userMessageId || '',
        toolPolicy: modelToolPolicy,
        forceResume: Boolean(pendingConfirmation || actionFollowupIntent === 'execute'),
        forceTask: executionPlan.capabilityPlan.taskLedgerRequired
          || (isOrganizationBound && requestsOrganizationScope(requestText)),
      })
    : { state: null, kind: 'conversation' as const, turnRowId: undefined };
  if ('bindingFailure' in actionTaskExecution) {
    const staleText = actionTaskExecution.bindingFailure === 'busy'
      ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
      : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
    return { terminal: await ( await commitReply(staleText)), context: undefined };
  }
  const receiptObserver = conversation && actionTaskExecution.state?.taskId
    ? createConversationReceiptObserver({
        userId: effectiveUserId, conversationId: conversation.id,
        taskId: actionTaskExecution.state.taskId, requestId, turnRowId: actionTaskExecution.turnRowId,
        externalMessageId: msg.messageId, domain, orgId,
      // Closing ingress stops new execution, not evidence for work already begun.
      }, () => isAcceptedMessagingAuthorizationCurrent(msg))
    : undefined;
  let desktopRelay: MessagingDesktopRelay | undefined;
  let personalDesktopRelay: MessagingDesktopRelay | undefined;
  const releaseActiveMessageRouteController = registerActiveMessageRouteController(
    msg,
    actionAbortController,
  );
  const actionLeaseHeartbeat = isIdentityBound && conversation
    ? startConversationActionExecutionHeartbeat({
        conversationId: conversation.id,
        userId: effectiveUserId,
        requestId,
        abortController: actionAbortController,
        onPersistenceUnknown: flushDBOrThrow,
      })
    : null;
  const actionLeaseWasLost = () => Boolean(actionLeaseHeartbeat?.isLeaseLost());
  const throwIfActionLeaseWasLost = () => {
    assertMessagingAuthorization(msg);
    organizationWorkExecution?.assertCurrent();
    if (!actionLeaseWasLost()) return;
    const error = new Error('Remote conversation action execution lease was lost');
    error.name = 'AbortError';
    throw error;
  };
  return { terminal: undefined, context: {
    isIdentityBound,
    actionTaskExecution,
    requestId,
    actionAbortController,
    receiptObserver,
    get desktopRelay(): typeof desktopRelay { return desktopRelay; },
    set desktopRelay(value: typeof desktopRelay) { desktopRelay = value; },
    options,
    effectiveUserId,
    source,
    domain,
    orgId,
    get personalDesktopRelay(): typeof personalDesktopRelay { return personalDesktopRelay; },
    set personalDesktopRelay(value: typeof personalDesktopRelay) { personalDesktopRelay = value; },
    conversation,
    executionPlan,
    actionFollowupIntent,
    requestText,
    commitReply,
    isOrganizationBound,
    directlyAppliedMode,
    get msg(): typeof msg { return msg; },
    set msg(value: typeof msg) { msg = value; },
    routingText,
    get organizationWorkExecution(): typeof organizationWorkExecution { return organizationWorkExecution; },
    set organizationWorkExecution(value: typeof organizationWorkExecution) { organizationWorkExecution = value; },
    get systemPrompt(): typeof systemPrompt { return systemPrompt; },
    set systemPrompt(value: typeof systemPrompt) { systemPrompt = value; },
    toolSessionActive,
    turnFlow,
    capabilitySelection,
    turnDispatch,
    executionDecision,
    get explicitRemoteMemoryIds(): typeof explicitRemoteMemoryIds { return explicitRemoteMemoryIds; },
    set explicitRemoteMemoryIds(value: typeof explicitRemoteMemoryIds) { explicitRemoteMemoryIds = value; },
    priorRuntimeEvidence,
    pendingConfirmationPrompt,
    conversationHistory,
    pendingConfirmation,
    get confirmationScope(): typeof confirmationScope { return confirmationScope; },
    set confirmationScope(value: typeof confirmationScope) { confirmationScope = value; },
    confirmationChannelScope,
    correctionRequiresFreshConfirmation,
    actionWasCancelled,
    flushTerminalReply,
    modelToolPolicy,
    llm,
    throwIfActionLeaseWasLost,
    operationMode,
    modelToolProjection,
    actionLeaseWasLost,
    actionLeaseHeartbeat,
    releaseActiveMessageRouteController,
  } };
}

export type MessagingTurnContext = NonNullable<Awaited<ReturnType<typeof prepareMessagingTurn>>["context"]>;
