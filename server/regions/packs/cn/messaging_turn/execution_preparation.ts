import { hasExplicitNoToolInstruction, explicitNoMutationScope, isInformationOnlyQuestion } from '../../../../cognition/tool_intent';
import { createConversationReceiptObserver } from '../../../../conversation/execution_receipt_archive';
import { resolveCapabilitySideEffectClass } from "../../../../cognition/capability_execution_plan";
import { extendTurnBindings } from "../../../../cognition/turn_bindings";
import { toolRegistry } from "../../../../tools/registry";
import { getConversationActionStatus, settleConversationActionExecutionRequest, setConversationActionExecutionStatus } from "../../../../conversation/manager";
import { formatPendingConfirmationRequest, type recordPendingConfirmationDurably } from "../../../../tools/pending_confirmation";
import { bindOrganizationWorkItemTask, registerOrganizationWorkExecution, routeOrganizationWork, isStrongerOrganizationWorkSideEffect, setOrganizationWorkItemExecutionStatus, type RouteOrganizationWorkResult } from "../../../../org/work_routing";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../../../../conversation/execution_facts";
import { coalesceToolExecutionRecords, mergeToolExecutionRecords, taskReceiptsToRecords } from "../../../../cognition/task_execution_ledger";
import type { ToolContext, ToolExecutionRecord } from "../../../../tools/types";
import { buildDesktopExecutionStabilityPolicy } from "../../../../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker } from "../../../../desktop/execution_runtime";
import { buildInteractionModeOverlay } from "../../../../cognition/turn_flow";
import { buildLumiRuntimeCapabilityContext } from "../../../../cognition/capability_context";
import { formatClientSelfPromptForTurn } from "../../../../client/self_model";
import { buildLumiOperatingKernelPrompt } from "../../../../cognition/operating_kernel";
import { buildResponseLanguageInstruction } from "../../../../utils/language";
import { getUserPreferredLLMConfig } from "../../../../llm/user_preferences";
import { resolveModelRequestInputBudget } from "../../../../llm/request_context_budget";
import type { NormalizedMessage } from "../../../../llm/providers";
import { createTurnConfirmation } from "../../../../tools/turn_confirmation";
import type { MessagingDesktopLifecycle } from "../messaging_finalization";
import { assertMessagingAuthorization, isMessagingAuthorizationCurrent } from "../messaging_ingress_runtime";
import { removeSupersededAssistantMessage, persistBoundMessagingMessage } from "../messaging_persistence";
import type { MessagingTurnContext } from './admission';
import { resolveMentionedOrganizationMembers } from './remote_plan';

export async function prepareMessagingExecution(context: MessagingTurnContext) {

  const refreshDesktopRelays = () => {
  if (context.isIdentityBound) {
    const lifecycle: MessagingDesktopLifecycle = {
      taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      signal: context.actionAbortController.signal, onLateResult: context.receiptObserver?.onDesktopLateResult,
    };
    context.desktopRelay = context.options?.createScopedDesktopRelay?.(context.effectiveUserId, context.source, context.domain, context.orgId, lifecycle);
    context.personalDesktopRelay = context.options?.createPersonalDesktopRelay?.(context.effectiveUserId, context.source, lifecycle);
  }
  };
  refreshDesktopRelays();
  if (context.isIdentityBound && context.conversation && context.actionFollowupIntent === 'status') {
    const executionFactQuestion = isConversationExecutionFactQuestion(context.requestText);
    const statusText = executionFactQuestion
      ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId: context.conversation.id,
          userId: context.effectiveUserId,
          domain: context.domain,
          orgId: context.orgId,
          currentRequestId: context.requestId,
          taskId: context.conversation.actionContinuationState?.taskId || '',
        }), context.requestText)
      : getConversationActionStatus(
          context.conversation.id,
          context.effectiveUserId,
          context.requestText,
          context.conversation.actionContinuationState,
        );
    return { terminal: await ( await context.commitReply(statusText, { beforeFlush: superseded => {
      settleConversationActionExecutionRequest(context.conversation.id, context.effectiveUserId, context.requestId,
        superseded ? 'The remote status turn was superseded by a newer user message.' : undefined);
    } })), context: undefined };
  }
  let organizationWorkRoute: RouteOrganizationWorkResult | null = null;
  let organizationAdmissionBlocker = '';
  let activeAdapters = 0;
  let admission = Promise.resolve();
  const onAdapterStart: NonNullable<ToolContext['onAdapterStart']> = call => {
    const next = admission.then(async () => {
      if (!context.isOrganizationBound) return;
      assertMessagingAuthorization(context.msg);
      context.throwIfActionLeaseWasLost();
      if (!context.conversation || !context.actionTaskExecution.state?.taskId) {
        throw new Error('The organization action has no accepted conversation task.');
      }
      const sideEffectClass = resolveCapabilitySideEffectClass([call.capability]);
      if (organizationWorkRoute && isStrongerOrganizationWorkSideEffect(sideEffectClass, organizationWorkRoute.workItem.sideEffectClass)) {
        if (activeAdapters) throw new Error('The earlier organization adapter has not settled.');
        context.organizationWorkExecution?.release();
        context.organizationWorkExecution = null;
      }
      const mentionedMemberIds = resolveMentionedOrganizationMembers(context.msg, context.orgId);
      organizationWorkRoute = routeOrganizationWork({
        orgId: context.orgId, requesterUserId: context.effectiveUserId,
        source: context.source, requestId: context.requestId,
        idempotencyKey: `organization-work:${context.requestId}`, text: context.routingText,
        intentKind: 'work_task', operation: call.capability.operation, sideEffectClass,
        conversationId: context.conversation.id, taskId: context.actionTaskExecution.state.taskId,
        platform: context.msg.platform, targetMemberId: mentionedMemberIds[0], targetMemberIds: mentionedMemberIds,
      });
      bindOrganizationWorkItemTask({ orgId: context.orgId, workItemId: organizationWorkRoute.workItem.id,
        conversationId: context.conversation.id, taskId: context.actionTaskExecution.state.taskId });
      const route = organizationWorkRoute.workItem;
      organizationAdmissionBlocker = route.status === 'waiting_approval'
        ? `任务尚未执行，正在等待组织管理员审批（审批单 ${route.approvalId || ''}）。审批通过后，在当前会话说“继续”即可恢复原任务。`
        : route.status === 'waiting_human'
          ? `任务已交给组织成员 ${route.humanOwnerUserId || route.assignedMemberId || '指定成员'}，Lumi 已停止自动执行。` : '';
      if (organizationAdmissionBlocker) {
        setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'blocked', {
          blocker: organizationAdmissionBlocker, requestId: context.requestId,
        });
        await context.flushTerminalReply();
        throw new Error(organizationAdmissionBlocker);
      }
      if (!context.organizationWorkExecution) context.organizationWorkExecution = registerOrganizationWorkExecution({
        orgId: context.orgId, workItemId: route.id, actorUserId: context.effectiveUserId,
        abortController: context.actionAbortController,
      });
      setOrganizationWorkItemExecutionStatus({ orgId: context.orgId, workItemId: route.id,
        actorUserId: context.effectiveUserId, status: 'executing', execution: context.organizationWorkExecution });
      await context.flushTerminalReply();
      assertMessagingAuthorization(context.msg);
      context.organizationWorkExecution.assertCurrent();
      context.throwIfActionLeaseWasLost();
      activeAdapters++;
    });
    admission = next.catch(() => {});
    return next;
  };
  if (
    context.conversation
    && (context.toolSessionActive || Boolean(context.directlyAppliedMode))
    && (context.actionTaskExecution.kind === 'new' || context.actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'executing', { requestId: context.requestId });
  }
  const priorTaskRecords = context.actionTaskExecution.kind === 'resume'
    ? taskReceiptsToRecords(context.actionTaskExecution.state?.receipts || [])
    : [];
  const taskAwareRecords = (records: ToolExecutionRecord[]) => (
    coalesceToolExecutionRecords([...priorTaskRecords, ...records])
  );
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'chat',
    text: context.routingText,
    flow: context.turnFlow,
    capabilitySelection: context.capabilitySelection,
    actionIntent: context.executionPlan.normalizedIntent,
    taskId: context.actionTaskExecution.state?.taskId || context.requestId,
  });
  const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);

  context.systemPrompt += `\n\n${context.turnDispatch.promptOverlay}`;
  context.systemPrompt += `\n\n${context.turnFlow.promptOverlay}`;
  context.systemPrompt += `\n\n${buildInteractionModeOverlay(context.turnFlow)}`;
  context.systemPrompt += `\n\n${context.executionDecision.promptOverlay}`;
  if (context.isIdentityBound) {
    context.systemPrompt += `\n\n${buildLumiRuntimeCapabilityContext({
      userId: context.effectiveUserId,
      text: context.routingText,
      flow: context.turnFlow,
      toolRegistry,
      domain: context.domain,
      orgId: context.orgId,
    })}`;
    context.systemPrompt += `\n\n${context.capabilitySelection.promptOverlay}`;
    if (desktopExecutionPolicy.promptOverlay) {
      context.systemPrompt += `\n\n${desktopExecutionPolicy.promptOverlay}`;
    }
    context.systemPrompt += `\n\n${formatClientSelfPromptForTurn(context.effectiveUserId, context.routingText, { domain: context.domain, orgId: context.orgId })}`;
  }
  context.systemPrompt += `\n\n${buildLumiOperatingKernelPrompt({ channel: 'chat', flow: context.turnFlow })}`;
  context.systemPrompt += '\n\nRemote continuity rule: prior assistant statements about installed tool counts, missing desktop access, or mode availability are conversational history, not runtime evidence. Use the current capability map, client state, scoped relay, and actual tool results as the source of truth.';
  context.systemPrompt += '\nRemote embodiment rule: WeChat, Feishu, and WeCom are transport channels into the same Lumi runtime. Do not claim that a remote channel inherently cannot reach the desktop. A no-client result for one data scope proves only that the scoped device route did not match; report that exact fact and check the personal/work scope before inferring that the desktop client is offline.';
  context.systemPrompt += '\nRemote memory rule: authenticated personal remote chat participates in the same personal memory system. Organization turns remain organization-scoped. Do not ask the user to repeat an explicit relationship or trust statement merely to make it memorable, and do not claim a memory was stored unless the memory pipeline accepted it.';
  context.systemPrompt += '\nExact file identity rule: a filename or path returned by a tool is an immutable identifier. Copy it character-for-character, including underscores, spaces, punctuation, extension, and parent directories. Never invent a size, timestamp, path, copy, upload, or send result; if the exact requested file is not in a receipt, say it was not verified.';
  context.systemPrompt += '\nRemote reply layout rule: make replies easy to scan in mobile chat. Use short paragraphs of 2-4 sentences separated by a blank line. For multiple points, use brief numbered labels or bullet lines. Do not send a dense wall of text.';
  if (context.explicitRemoteMemoryIds.length > 0) {
    context.systemPrompt += '\nCurrent-turn memory receipt: the explicit personal relationship/trust statement was accepted into durable personal memory. You may acknowledge that fact naturally; do not expose internal memory IDs.';
  }
  if (context.priorRuntimeEvidence) context.systemPrompt += `\n\n${context.priorRuntimeEvidence}`;
  if (context.pendingConfirmationPrompt) context.systemPrompt += `\n\n${context.pendingConfirmationPrompt}`;
  context.systemPrompt += `\n\n${buildResponseLanguageInstruction(context.requestText)}`;

  const userLLMPrefs = {
    ...getUserPreferredLLMConfig(context.effectiveUserId, { domain: context.domain, orgId: context.orgId, maxTokens: 4096, source: context.source }),
    inputTokenBudget: resolveModelRequestInputBudget(),
    signal: context.actionAbortController.signal,
  };
  const messages: NormalizedMessage[] = [
    { role: 'system', content: context.systemPrompt },
    ...context.conversationHistory.map(item => ({
      role: item.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: item.content,
    })),
    { role: 'user', content: [context.msg.text, context.pendingConfirmationPrompt].filter(Boolean).join('\n\n') },
  ];
  let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
  const requestToolConfirmation = createTurnConfirmation({
    userId: context.effectiveUserId, source: context.source, requestId: context.requestId, actionIntent: context.requestText,
    pending: context.pendingConfirmation,
    consumeScope: () => context.confirmationScope,
    proposalScope: () => context.confirmationChannelScope
      ? { ...context.confirmationChannelScope, taskId: context.actionTaskExecution.state?.taskId } : undefined,
    correctionRequiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
    assertCurrent: () => assertMessagingAuthorization(context.msg),
    isCancelled: context.actionWasCancelled,
    onPending: pending => {
      pendingConfirmationCreatedThisTurn = pending;
      if (context.conversation) setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'waiting_confirmation', {
        assistantState: formatPendingConfirmationRequest(pending), requestId: context.requestId,
      });
    },
  });
  const settleRemoteTask = (fallbackBlocker?: string) => {
    // Every accepted turn owns a request lease, even without a task id.
    if (context.conversation) settleConversationActionExecutionRequest(context.conversation.id, context.effectiveUserId, context.requestId, fallbackBlocker);
  };
  const settleSupersededRemoteTurn = (reason: string) => {
    if (organizationWorkRoute) setOrganizationWorkItemExecutionStatus({
      orgId: context.orgId, workItemId: organizationWorkRoute.workItem.id, status: 'cancelled',
      actorUserId: context.effectiveUserId, execution: context.organizationWorkExecution, blocker: reason,
    });
    settleRemoteTask(reason);
  };

  const settleTransferredExecution = async (records: ToolExecutionRecord[]): Promise<boolean> => {
    if (!context.organizationWorkExecution || context.organizationWorkExecution.isCurrent()) return false;
    // Keep any terminal action evidence in its original conversation ledger,
    // while suppressing prose and completion claims from the former owner.
    if (records.length) {
      const evidenceMessage = persistBoundMessagingMessage(context.msg, 'assistant', '', undefined, records);
      removeSupersededAssistantMessage(evidenceMessage);
    }
    const blocker = 'Organization work was handed off; the previous execution has stopped.';
    if (context.conversation) setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
    settleRemoteTask(blocker);
    await context.flushTerminalReply();
    return true;
  };
  let toolRecords: ToolExecutionRecord[] = [];
  const collectToolRecord = (record: ToolExecutionRecord) => {
    toolRecords = mergeToolExecutionRecords(toolRecords, [record]);
  };
  const observeToolRecord = (record: ToolExecutionRecord) => {
    context.receiptObserver?.onToolRecord(record);
    collectToolRecord(record);
  };

  const bindSelectedAuditTask = async (bind: () => Promise<void>): ReturnType<NonNullable<ToolContext['prepareSelectedToolCall']>> => {
    assertMessagingAuthorization(context.msg);
    context.throwIfActionLeaseWasLost();
    const needsBinding = !context.actionTaskExecution.state?.taskId;
    if (needsBinding && (activeAdapters || toolRecords.length || remoteToolContext.priorToolRecords.length)) {
      organizationAdmissionBlocker = '当前请求已有执行记录，不能再追补任务身份；本轮组织业务未执行。';
      throw new Error(organizationAdmissionBlocker);
    }
    try { await bind(); }
    catch (error) {
      organizationAdmissionBlocker = '当前受理租约或任务身份已变化，本轮组织业务没有执行。';
      throw error;
    }
    if (!needsBinding) return { taskId: context.actionTaskExecution.state!.taskId, turnRowId: context.actionTaskExecution.turnRowId, desktopRelay: context.desktopRelay, personalDesktopRelay: context.personalDesktopRelay };
    const taskId = context.actionTaskExecution.state!.taskId;
    context.receiptObserver = createConversationReceiptObserver({ userId: context.effectiveUserId,
      conversationId: context.conversation!.id, taskId, requestId: context.requestId,
      turnRowId: context.actionTaskExecution.turnRowId, externalMessageId: context.msg.messageId,
      domain: context.domain, orgId: context.orgId,
    }, () => isMessagingAuthorizationCurrent(context.msg));
    refreshDesktopRelays();
    Object.assign(remoteToolContext, { taskId, turnRowId: context.actionTaskExecution.turnRowId,
      desktopRelay: context.desktopRelay, personalDesktopRelay: context.personalDesktopRelay });
    return { taskId, turnRowId: context.actionTaskExecution.turnRowId, desktopRelay: context.desktopRelay, personalDesktopRelay: context.personalDesktopRelay };
  };
  const prepareSelectedToolCall: NonNullable<ToolContext['prepareSelectedToolCall']> = () => bindSelectedAuditTask(async () => {
    const owner = context.actionTaskExecution.prepareSelectedToolCall;
    if (!owner) throw new Error('The selected tool has no accepted audit owner.');
    await owner(context.actionAbortController.signal);
  });
  const prepareNativeAction: NonNullable<import('../remote_org_commands').RemoteOrganizationAdapterControl['prepareNativeAction']> = async call => {
    assertMessagingAuthorization(context.msg);
    context.throwIfActionLeaseWasLost();
    const effects = resolveCapabilitySideEffectClass([call.capability]);
    const veto = explicitNoMutationScope(context.requestText);
    const policy = context.personalityToolPolicy;
    const blocker = hasExplicitNoToolInstruction(context.requestText) || isInformationOnlyQuestion(context.requestText)
      || veto.local && effects !== 'none' || veto.external && effects === 'external_commit'
      ? '当前指令仅允许说明或禁止该操作，本轮没有执行组织业务。'
      : policy && (!policy.allowedTools.includes('*') || policy.forbiddenTools.length > 0
        || policy.requireConfirmation.length > 0
        || Object.values(policy.securityOverrides || {}).some(level => level === 'forbidden' || level === 'confirm'))
        ? '当前人格工具策略未授权这项原生组织业务，本轮没有执行。' : '';
    if (blocker) { organizationAdmissionBlocker = blocker; throw new Error(blocker); }
    await bindSelectedAuditTask(context.bindPreparedNativeTask);
  };
  const remoteToolContext = {
    userId: context.effectiveUserId,
    taskId: context.actionTaskExecution.state?.taskId,
    conversationId: context.conversation?.id,
    turnId: context.msg.messageId,
    turnRowId: context.actionTaskExecution.turnRowId,
    externalMessageId: context.msg.messageId,
    resolutionId: context.executionPlan.resolution.id,
    requestId: context.requestId,
    domain: context.domain,
    orgId: context.orgId,
    actionIntent: context.requestText,
    routedTaskText: context.routingText,
    supervisedExternalCommits: context.isIdentityBound,
    toolPolicy: context.modelToolPolicy,
    source: context.source,
    priorToolRecords: [] as ToolExecutionRecord[],
    llmGetters: context.llm as any,
    desktopRelay: context.desktopRelay,
    personalDesktopRelay: context.personalDesktopRelay,
    desktopExecutionTracker,
    isCancelled: context.actionWasCancelled,
    executionSignal: context.actionAbortController.signal,
    onToolRecord: observeToolRecord,
    prepareSelectedToolCall,
    requestConfirmation: requestToolConfirmation,
    prepareNativeAction,
    onAdapterStart,
    onAdapterSettlement: () => { activeAdapters = Math.max(0, activeAdapters - 1); },
  };
  return { terminal: undefined, context: extendTurnBindings(context, {
    get organizationWorkRoute(): typeof organizationWorkRoute { return organizationWorkRoute; },
    set organizationWorkRoute(value: typeof organizationWorkRoute) { organizationWorkRoute = value; },
    remoteToolContext,
    get organizationAdmissionBlocker() { return organizationAdmissionBlocker; },
    collectToolRecord,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    taskAwareRecords,
    get toolRecords(): typeof toolRecords { return toolRecords; },
    set toolRecords(value: typeof toolRecords) { toolRecords = value; },
    desktopExecutionTracker,
    settleRemoteTask,
    userLLMPrefs,
    messages,
    settleTransferredExecution,
    settleSupersededRemoteTurn,
  }) };
}

export type MessagingModelContext = NonNullable<Awaited<ReturnType<typeof prepareMessagingExecution>>["context"]>;
