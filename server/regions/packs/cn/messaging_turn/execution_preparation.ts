import { extendTurnBindings } from "../../../../cognition/turn_bindings";
import { requestsOrganizationScope } from "../../../../messaging/personal_org_scope";
import { toolRegistry } from "../../../../tools/registry";
import { getConversationActionStatus, persistConversationExecutionPlan, settleConversationActionExecutionRequest, setConversationActionExecutionStatus } from "../../../../conversation/manager";
import { formatPendingConfirmationRequest, type recordPendingConfirmationDurably } from "../../../../tools/pending_confirmation";
import { bindOrganizationWorkItemTask, registerOrganizationWorkExecution, routeOrganizationWork, setOrganizationWorkItemExecutionStatus, type RouteOrganizationWorkResult } from "../../../../org/work_routing";
import { bindCapabilityExecutionPlanTask } from "../../../../cognition/capability_execution_plan";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../../../../conversation/execution_facts";
import { coalesceToolExecutionRecords, mergeToolExecutionRecords, taskReceiptsToRecords } from "../../../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../../../tools/types";
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
import { assertMessagingAuthorization } from "../messaging_ingress_runtime";
import { removeSupersededAssistantMessage, persistBoundMessagingMessage } from "../messaging_persistence";
import type { MessagingTurnContext } from './admission';
import { resolveMentionedOrganizationMembers } from './remote_plan';

export async function prepareMessagingExecution(context: MessagingTurnContext) {

  if (context.isIdentityBound) {
    const lifecycle: MessagingDesktopLifecycle = {
      taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      signal: context.actionAbortController.signal, onLateResult: context.receiptObserver?.onDesktopLateResult,
    };
    context.desktopRelay = context.options?.createScopedDesktopRelay?.(context.effectiveUserId, context.source, context.domain, context.orgId, lifecycle);
    context.personalDesktopRelay = context.options?.createPersonalDesktopRelay?.(context.effectiveUserId, context.source, lifecycle);
  }
  if (context.conversation && context.actionTaskExecution.state?.taskId) {
    context.executionPlan.executionPlan = bindCapabilityExecutionPlanTask(
      context.executionPlan.executionPlan,
      context.actionTaskExecution.state.taskId,
    );
    persistConversationExecutionPlan({
      conversationId: context.conversation.id,
      userId: context.effectiveUserId,
      plan: context.executionPlan.executionPlan,
    });
  }
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
  const shouldRouteOrganizationWork = Boolean(
    context.isOrganizationBound
    && context.conversation
    && context.actionTaskExecution.state?.taskId
    && (
      context.executionPlan.capabilityPlan.taskLedgerRequired
      || requestsOrganizationScope(context.requestText)
      || context.actionTaskExecution.kind === 'resume'
      || Boolean(context.options?.onMessage)
    )
    && !context.directlyAppliedMode
    && context.executionPlan.normalizedIntent.operation !== 'status'
    && context.executionPlan.normalizedIntent.operation !== 'explain',
  );
  if (shouldRouteOrganizationWork) {
    try {
      const mentionedMemberIds = resolveMentionedOrganizationMembers(context.msg, context.orgId);
      organizationWorkRoute = routeOrganizationWork({
        orgId: context.orgId,
        requesterUserId: context.effectiveUserId,
        source: context.source,
        requestId: context.requestId,
        idempotencyKey: `organization-work:${context.requestId}`,
        text: context.routingText,
        intentKind: context.executionPlan.normalizedIntent.kind,
        operation: context.executionPlan.normalizedIntent.operation,
        sideEffectClass: context.executionPlan.normalizedIntent.sideEffectClass,
        conversationId: context.conversation!.id,
        taskId: context.actionTaskExecution.state!.taskId,
        platform: context.msg.platform,
        targetMemberId: mentionedMemberIds[0],
        targetMemberIds: mentionedMemberIds,
      });
      bindOrganizationWorkItemTask({
        orgId: context.orgId,
        workItemId: organizationWorkRoute.workItem.id,
        conversationId: context.conversation!.id,
        taskId: context.actionTaskExecution.state!.taskId,
      });
      const route = organizationWorkRoute.workItem;
      if (!['waiting_approval', 'waiting_human'].includes(route.status)) {
        context.organizationWorkExecution = registerOrganizationWorkExecution({
          orgId: context.orgId,
          workItemId: route.id,
          actorUserId: context.effectiveUserId,
          abortController: context.actionAbortController,
        });
      }
      context.systemPrompt += [
        '',
        '## Organization Business Route',
        `Work item: ${route.id}. Status: ${route.status}.`,
        `Department: ${route.departmentId || 'organization-default'}. Position: ${route.positionId || 'none'}.`,
        `Primary member: ${route.assignedMemberId || 'none'}. Collaborators: ${(route.collaboratorMemberIds || []).join(', ') || 'none'}.`,
        `Required skill tags: ${route.skillTags.join(', ') || 'none'}.`,
        'Do not claim another department, member, position, or skill handled the task unless this durable route or a later handoff receipt says so.',
      ].join('\n');
    } catch (error: any) {
      const blocker = `Organization work routing failed: ${error?.message || error}`;
      setConversationActionExecutionStatus(context.conversation!.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
      settleConversationActionExecutionRequest(context.conversation!.id, context.effectiveUserId, context.requestId, blocker);
      const response = `组织任务没有开始执行：${error?.message || '业务路由校验失败'}。请由组织管理员检查部门、岗位、成员或技能配置。`;
      return { terminal: await ( await context.commitReply(response)), context: undefined };
    }
  }
  if (organizationWorkRoute?.workItem.status === 'waiting_approval') {
    const approvalId = organizationWorkRoute.approval?.id || organizationWorkRoute.workItem.approvalId || '';
    const blocker = `Organization approval ${approvalId} is required before execution.`;
    setConversationActionExecutionStatus(context.conversation!.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
    settleConversationActionExecutionRequest(context.conversation!.id, context.effectiveUserId, context.requestId, blocker);
    const response = `任务已完成组织路由，但尚未执行。工作项 ${organizationWorkRoute.workItem.id} 正在等待组织管理员审批（审批单 ${approvalId}）。审批通过后，在当前会话说“继续”即可恢复原任务。`;
    return { terminal: await ( await context.commitReply(response)), context: undefined };
  }
  if (organizationWorkRoute?.workItem.status === 'waiting_human') {
    const owner = organizationWorkRoute.workItem.humanOwnerUserId || organizationWorkRoute.workItem.assignedMemberId || '指定成员';
    const blocker = `Organization work item is owned by human member ${owner}.`;
    setConversationActionExecutionStatus(context.conversation!.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
    settleConversationActionExecutionRequest(context.conversation!.id, context.effectiveUserId, context.requestId, blocker);
    const response = `任务已转交给组织成员 ${owner}，LumiCore 已停止自动执行。工作项：${organizationWorkRoute.workItem.id}。后续只有收到新的持久转派回执后才会恢复。`;
    return { terminal: await ( await context.commitReply(response)), context: undefined };
  }
  if (
    context.conversation
    && (context.toolSessionActive || Boolean(context.directlyAppliedMode))
    && (context.actionTaskExecution.kind === 'new' || context.actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'executing', { requestId: context.requestId });
    if (organizationWorkRoute) {
      setOrganizationWorkItemExecutionStatus({
        orgId: context.orgId,
        workItemId: organizationWorkRoute.workItem.id,
        status: 'executing',
        actorUserId: context.effectiveUserId,
        execution: context.organizationWorkExecution,
      });
    }
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
    capabilityExecutionPlan: context.executionPlan.executionPlan,
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
    llmGetters: context.llm as any,
    desktopRelay: context.desktopRelay,
    personalDesktopRelay: context.personalDesktopRelay,
    desktopExecutionTracker,
    isCancelled: context.actionWasCancelled,
    executionSignal: context.actionAbortController.signal,
    onToolRecord: observeToolRecord,
    requestConfirmation: requestToolConfirmation,
  };
  return { terminal: undefined, context: extendTurnBindings(context, {
    get organizationWorkRoute(): typeof organizationWorkRoute { return organizationWorkRoute; },
    set organizationWorkRoute(value: typeof organizationWorkRoute) { organizationWorkRoute = value; },
    remoteToolContext: remoteToolContext as typeof remoteToolContext,
    collectToolRecord: collectToolRecord as typeof collectToolRecord,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    taskAwareRecords: taskAwareRecords as typeof taskAwareRecords,
    get toolRecords(): typeof toolRecords { return toolRecords; },
    set toolRecords(value: typeof toolRecords) { toolRecords = value; },
    desktopExecutionTracker: desktopExecutionTracker as typeof desktopExecutionTracker,
    settleRemoteTask: settleRemoteTask as typeof settleRemoteTask,
    userLLMPrefs: userLLMPrefs as typeof userLLMPrefs,
    messages: messages as typeof messages,
    settleTransferredExecution: settleTransferredExecution as typeof settleTransferredExecution,
    settleSupersededRemoteTurn: settleSupersededRemoteTurn as typeof settleSupersededRemoteTurn,
  }) };
}

export type MessagingModelContext = NonNullable<Awaited<ReturnType<typeof prepareMessagingExecution>>["context"]>;
