import { runResolvedLumiTurn } from "../cognition/turn_model";
import { reserveAnchoredEntryExecution } from "../conversation/entry_execution";

import { attachAutonomousExecutionPlan, checkpointAutonomousTask, cancelTask, dequeue, markRunning, markCompleted, markCancelled, getRunningTask, heartbeatAutonomousTask, isTaskCancellationRequested, isTaskPauseRequested, markPaused, requestPauseAutonomousTask, recordAutonomousTaskFailure, getAutonomousTaskPriorRecords, persistAutonomousTaskQueue, prepareAutonomousTaskAction, reconcileExpiredAutonomousTasks, registerAutonomousTaskExecutor, releaseAutonomousTaskExecutor, settleAutonomousTaskAction, startAutonomousTaskAction } from "./task_queue";
import { toolExecutionInputDigests } from "../tools/execution_engine";
import { getGateConfig, isAutonomousWorkAllowed, recordAutonomousTokens } from "./safety_gate";
import { toolRegistry } from "../tools/registry";
import type { ToolContext, ToolExecutionRecord } from "../tools/types";
import { attachAutonomousHostAuthority } from "../tools/host_execution_authority";
import { canAutoApproveAction } from "../tools/action_constitution";
import type { Server as SocketIOServer } from "socket.io";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { formatLumiConstitutionForPrompt } from "../personality/constitution";
import { stageAutonomousPlanCompletion } from "./planner";
import { createDesktopRelay } from "../socket/desktop_relay";
import { createRealtimeVoicePrioritySignal, isRealtimeUserActive } from "./foreground_activity";
import { sanitizeCapabilityExecutionPlan } from "../conversation/ledger/plans";
import { snapshotDurableToolRecords } from "../cognition/durable_task_recovery";
import { buildTaskCompletionFeedback, buildTaskTerminalReceipt, validateCompletionTerminalReceipt } from "../cognition/acceptance_evidence";
import { CN_AUTONOMOUS_CUSTOMER_MESSAGES } from "../regions/messages/autonomous_customer_messages";
import { isOrganizationMembershipAuthorizationCurrent, watchOrganizationMembershipAuthorization } from "../org/membership_authorization";
import { canUseQueuedSelfImprovementStageAuthorization, isLocalAdminAuthorizedSelfImprovementTask } from "../self_extension/improvement_program";
import type { LLMGetters } from './executor/contracts';
import { retryAutonomousTaskFinalizations, stageAutonomousTaskFinalization, persistAutonomousTaskFinalizations, hasPendingAutonomousTaskFinalization } from './executor/durable_finalization';
import { inferAutonomousPublicLanguage, projectAutonomousCompletionFeedback, projectAutonomousCustomerMessage } from './executor/customer_projection';
import { markLinkedPlanRunning, planScopeForTask, markLinkedPlanPaused, markLinkedPlanCancelled, publishAutonomousTaskInterruption, markLinkedPlanFailed, clipPlanResult } from './executor/linked_plan';
import { buildAutonomousCapabilityPipeline } from './executor/tool_policy';
import { upsertToolLedger } from './executor/receipts';
import { evaluateAutonomousTaskOutcome, finalizeAutonomousTaskOutcomeForDelivery } from './executor/outcome';
import { finalizeAutonomousTaskFailure } from './executor/failure';

export type { LLMGetters } from './executor/contracts';
export { isLocalBodyLearningTask } from './executor/tool_policy';
export { buildAutonomousToolPolicy } from './executor/tool_policy';
export { buildAutonomousCapabilityPipeline } from './executor/tool_policy';
export { projectAutonomousCustomerMessage } from './executor/customer_projection';
export { projectAutonomousCompletionFeedback } from './executor/customer_projection';
export { isSuccessfulAutonomousToolRecord } from './executor/receipts';
export { hasVerifiedSelfImprovementStageReceipt } from './executor/outcome';
export type { AutonomousTaskOutcome } from './executor/contracts';
export { evaluateAutonomousTaskOutcome } from './executor/outcome';
export { finalizeAutonomousTaskOutcomeForDelivery } from './executor/outcome';
export { persistAutonomousTaskFinalizations } from './executor/durable_finalization';
export { retryAutonomousTaskFinalizations } from './executor/durable_finalization';

export async function executeNextAutonomousTask(
  io: SocketIOServer,
  getters: LLMGetters,
  userId?: string,
  options: { taskId?: string; signal?: AbortSignal; isAuthorized?: () => boolean } = {},
): Promise<{ executed: boolean; taskId?: string; result?: string }> {
  let conversationExecution: ReturnType<typeof reserveAnchoredEntryExecution>;
  let taskIsAuthorized = () => true;
  const isAuthorized = () => {
    try { return taskIsAuthorized() && options.isAuthorized?.() !== false && (!conversationExecution || conversationExecution.isCurrent()); } catch { return false; }
  };
  const rejectUnauthorizedAdmission = async () => {
    if (options.taskId && cancelTask(options.taskId, userId)) await persistAutonomousTaskQueue();
    return { executed: false, taskId: options.taskId, result: 'Task authorization was revoked' };
  };
  if (!isAuthorized()) return rejectUnauthorizedAdmission();
  if (options.signal?.aborted) return { executed: false, result: 'Parent execution was cancelled' };
  await retryAutonomousTaskFinalizations(io);
  if (!isAuthorized()) return rejectUnauthorizedAdmission();
  if (userId && isRealtimeUserActive(userId)) {
    return { executed: false, result: 'Live user voice session has priority' };
  }
  // Expiry is reclaimable only after the prior local executor has settled.
  if (reconcileExpiredAutonomousTasks()) await persistAutonomousTaskQueue();
  if (!isAuthorized()) return rejectUnauthorizedAdmission();
  if (options.signal?.aborted) return { executed: false, result: 'Parent execution was cancelled' };
  // Don't start a new task if one is already running
  if (getRunningTask(userId)) {
    return { executed: false, result: 'Task already running' };
  }

  const task = dequeue(userId, options.taskId);
  if (!task) return { executed: false };
  // Both scheduled and manual plan runs carry the original membership identity.
  // The built-in cycle must enforce it even without a caller authority callback.
  const organizationPlanTask = task.domain === 'work'
    && Boolean(task.planId && task.idempotencyKey?.startsWith(`command-center-plan:${task.planId}:`));
  if (organizationPlanTask) {
    taskIsAuthorized = () => isOrganizationMembershipAuthorizationCurrent(task.membershipAuthorization, task.orgId || '', task.userId);
    if (!isAuthorized()) {
      cancelTask(task.id, task.userId);
      await persistAutonomousTaskQueue();
      return { executed: false, taskId: task.id, result: 'Task authorization was revoked' };
    }
  }
  const publicLanguage = inferAutonomousPublicLanguage(`${task.title}\n${task.description}`);

  const gate = isAutonomousWorkAllowed(task.userId);
  if (!gate.allowed) {
    return { executed: false, taskId: task.id, result: `Blocked by safety gate: ${gate.reason || 'not allowed'}` };
  }

  const running = markRunning(task.id);
  if (!running) return { executed: false };
  if (!running.leaseId) return { executed: false, taskId: task.id, result: 'Task lease was not created' };
  const executionAbort = new AbortController();
  const abortExecution = (reason: string) => {
    if (!executionAbort.signal.aborted) executionAbort.abort(new Error(reason));
  };
  const authorizationWasRevoked = () => {
    if (isAuthorized()) return false;
    cancelTask(task.id, task.userId);
    abortExecution('Task authorization was revoked');
    return true;
  };
  const assertAuthorized = () => {
    if (authorizationWasRevoked()) throw new Error('Task authorization was revoked');
  };
  if (!registerAutonomousTaskExecutor(task.id, running.leaseId, abortExecution)) return { executed: false };
  const membershipAuthority = organizationPlanTask
    ? watchOrganizationMembershipAuthorization(task.membershipAuthorization, task.orgId || '', task.userId, () => {
        cancelTask(task.id, task.userId);
        abortExecution('Task organization membership was revoked');
      })
    : undefined;
  if (membershipAuthority) taskIsAuthorized = membershipAuthority.isAuthorized;
  const onParentCancelled = () => {
    cancelTask(task.id, task.userId);
    abortExecution('Parent execution was cancelled');
  };
  options.signal?.addEventListener('abort', onParentCancelled, { once: true });
  if (options.signal?.aborted) onParentCancelled();
  const voicePriority = createRealtimeVoicePrioritySignal(task.userId);
  const onVoicePriority = () => abortExecution('Live user voice session has priority');
  voicePriority.signal.addEventListener('abort', onVoicePriority, { once: true });
  if (voicePriority.signal.aborted) onVoicePriority();
  let leaseLost = false;
  const leaseHeartbeat = setInterval(() => {
    const renewed = heartbeatAutonomousTask(task.id, running.leaseId!);
    if (!renewed) {
      leaseLost = true;
      abortExecution('Autonomous task lease expired');
      clearInterval(leaseHeartbeat);
    }
  }, 20_000);
  if (typeof (leaseHeartbeat as any).unref === 'function') (leaseHeartbeat as any).unref();
  markLinkedPlanRunning(running);
  let releaseDesktopControlLease = () => undefined;
  const toolLedger: ToolExecutionRecord[] = getAutonomousTaskPriorRecords(running);
  let sideEffectClass = running.executionPlan?.risk.sideEffectClass;

  const taskScope = planScopeForTask(running);
  const taskRoom = taskScope.domain === 'work' && taskScope.orgId
    ? `user:${task.userId}:org:${taskScope.orgId}`
    : `user:${task.userId}:personal`;
  io.to(taskRoom).emit('autonomous:task_started', {
    taskId: task.id,
    title: task.title,
    mode: task.mode,
    timestamp: new Date().toISOString(),
  });

  try {
    const requestId = 'autonomy:' + running.leaseId;
    conversationExecution = reserveAnchoredEntryExecution({
      userId: task.userId, scope: taskScope, entry: { kind: 'autonomy' },
      conversationId: running.conversationId, requestId, signal: executionAbort.signal,
      abort: reason => { if (!executionAbort.signal.aborted) executionAbort.abort(reason); },
    });
    await conversationExecution?.waitForTurn();
    assertAuthorized();
    executionAbort.signal.throwIfAborted();
    const currentGate = getGateConfig(task.userId);
    const maxIterations = currentGate.autonomyLevel === 'full' ? 50 : 30;
    // Build desktop relay using the user's registered desktop client, not a broad user-room broadcast.
    const desktopRelay = createDesktopRelay({
      io,
      userId: task.userId,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      source: 'autonomous',
      taskId: task.id,
      signal: executionAbort.signal,
      onControlPaused: () => {
        requestPauseAutonomousTask(task.id, task.userId);
      },
    });
    releaseDesktopControlLease = () => desktopRelay.releaseControlLease('autonomous_task_complete');

    const executionPipeline = buildAutonomousCapabilityPipeline(running, maxIterations, toolRegistry, requestId);
    sideEffectClass = executionPipeline.executionPlan.risk.sideEffectClass;
    attachAutonomousExecutionPlan(
      running.id,
      sanitizeCapabilityExecutionPlan(executionPipeline.executionPlan, new Date().toISOString()),
      running.leaseId,
    );
    checkpointAutonomousTask(running.id, {
      phase: 'planned',
      receiptIds: running.checkpoint?.receiptIds,
      receipts: running.checkpoint?.receipts,
      detail: `Capability plan persisted for attempt ${running.attempt || 1}`,
    }, running.leaseId);
    if (executionPipeline.executionPlan.risk.sideEffectClass === 'external_commit') {
      throw new Error('Autonomous external commit blocked: an action-time immutable user confirmation is required.');
    }
    const toolPolicy = executionPipeline.authorizationPolicy;

    const context: ToolContext = attachAutonomousHostAuthority({
      userId: task.userId,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      conversationId: conversationExecution?.conversation.id,
      taskId: running.id, requestId, resolutionId: executionPipeline.resolution.id,
      currentTurnExecutionRequested: executionPipeline.executionRequested,
      desktopRelay: task.mode === 'desktop' ? desktopRelay : undefined,
      requestConfirmation: async (toolName, args) => {
        if (authorizationWasRevoked()) return false;
        if (toolName === 'self_improvement_stage_patch') {
          return canUseQueuedSelfImprovementStageAuthorization(
            taskScope,
            String(args.proposalId || ''),
            running.id,
          );
        }
        return canAutoApproveAction(toolName, args, { actionIntent: task.description });
      },
      actionIntent: task.description,
      routedTaskText: executionPipeline.turnIntent.flow.routeText,
      toolPolicy,
      modelToolProjection: executionPipeline.modelToolProjection,
      isCancelled: () => authorizationWasRevoked()
        || isTaskCancellationRequested(task.id, task.userId)
        || isTaskPauseRequested(task.id, task.userId)
        || isRealtimeUserActive(task.userId)
        || leaseLost
        || Boolean(options.signal?.aborted),
      executionSignal: executionAbort.signal,
      autonomous: true,
      localExecution: isLocalAdminAuthorizedSelfImprovementTask(
        taskScope,
        running.id,
        running.idempotencyKey,
      ),
      source: 'autonomous',
      idempotencyKey: running.idempotencyKey,
      priorToolRecords: getAutonomousTaskPriorRecords(running),
      resolveToolIdempotencyKey: call => {
        assertAuthorized();
        const capability = toolRegistry.getCapabilityManifestEntry(call.name, toolPolicy);
        const mayHaveSideEffects = !capability || !['observe', 'test'].includes(capability.operation)
          || capability.sideEffects.some(effect => !['none', 'local_read', 'network_read'].includes(effect.type));
        return prepareAutonomousTaskAction(running.id, running.leaseId!, {
          callId: call.id, name: call.name,
          argumentsDigest: toolExecutionInputDigests(call.arguments).argumentsDigest,
          mayHaveSideEffects,
        });
      },
      onAdapterStart: async call => {
        assertAuthorized();
        if (!call.idempotencyKey) throw new Error('Autonomous adapter is missing its action identity.');
        await startAutonomousTaskAction(running.id, running.leaseId!, call.idempotencyKey);
        assertAuthorized();
      },
    }, { ownerUserId: task.userId, taskId: running.id });

    const messages = [
      { role: 'system' as const, content: [
        `You are Lumi executing an autonomous background task. You work independently without user interaction. Be efficient and direct. Current task mode: ${task.mode}.`,
        formatLumiConstitutionForPrompt(),
        executionPipeline.capabilityPlan.promptOverlay,
        ...(toolLedger.length ? [`Previously completed action receipts are preserved below. Continue only missing work; do not repeat those actions.\n${JSON.stringify(toolLedger.map(record => ({ id: record.id, name: record.name, result: record.result?.slice(0, 500), error: record.error })))}`] : []),
        ...(running.recovery?.planRevisions?.length
          ? [`This is durable recovery attempt ${running.attempt}. Follow the latest persisted recovery revision: ${running.recovery.planRevisions.at(-1)?.strategy}. Do not repeat any side effect from a prior receipt. If exact prior state cannot be reconciled, stop and report the blocker.`]
          : []),
        'For concrete deliverables, define the work product with work_product_plan, verify it with work_product_verify or domain-specific verification tools, repair failed criteria, and only then mark the task complete. If confirmation or missing input blocks progress, report the blocker.',
        'For autonomous web learning, you may use public web_search, url_fetch, and authority_research. Treat them as observation: cite URLs, retrieval time, confidence, and uncertainty. Choose research topics from the user industry habits in the task context: common platforms, vocabulary, deliverable formats, verification standards, compliance boundaries, and repeated real workflows. Avoid generic trend learning unless it clearly improves that user’s industry workflow. For desktop AI/tool catalog learning, use desktop_ai_list_targets and desktop_ai_discovery_plan, then produce source-grounded candidate JSON for later registration. Do not use login-required, paid, captcha, QR/OTP, private, or account-authorization pages as completed sources. Do not call authority_research_save, desktop_ai_register_target, or other long-term knowledge/configuration writes unless the task itself contains explicit user authorization; otherwise produce source-grounded knowledge or target candidates for later absorption.',
        'For autonomous local machine/body learning, only use observation tools for OS info, top-level file/folder landmarks, launchable apps, active/running processes, idle/activity signals, and adapter inventory. Do not open apps or files, click, type, capture screenshots, run commands, read file contents, move/copy/delete files, or infer private facts from filenames. Produce a local body map with evidence, uncertainty, useful app/file landmarks, industry-relevant tools, and next exploration items that need user confirmation.',
        'Store internal reports and other files created by this background task with write_file. Lumi confines those files to its dedicated autonomy report data directory; never present a source-project path as the saved location.',
      ].join('\n\n') },
      { role: 'user' as const, content: task.description },
    ];

    const result = await runResolvedLumiTurn({
      execution: executionPipeline,
      assertCurrent: assertAuthorized, streaming: false,
      messages: messages,
      registry: toolRegistry,
      config: { ...getUserPreferredLLMConfig(task.userId, { maxTokens: 2000, ...taskScope }), requestId, conversationId: conversationExecution?.conversation.id, signal: executionAbort.signal },
      onToolCall: async (record) => {
        await settleAutonomousTaskAction(running.id, running.leaseId!, record);
        upsertToolLedger(toolLedger, record);
        if (record.result !== undefined || record.error !== undefined) {
          checkpointAutonomousTask(running.id, {
            phase: 'tool_execution',
            iteration: toolLedger.length,
            receiptIds: Array.from(new Set([
              ...(running.checkpoint?.receiptIds || []),
              ...toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
            ])),
            receipts: [
              ...(running.checkpoint?.receipts || []),
              ...snapshotDurableToolRecords(toolLedger),
            ],
            detail: `${toolLedger.length} terminal tool call(s) observed`,
          }, running.leaseId);
        }
      },
      maxIterations: maxIterations,
      context: context,
      getters: { ...getters, getOpenAI: getters.getOpenAI || (() => null), getAnthropic: getters.getAnthropic || (() => null), getQwen: getters.getQwen || (() => null) },
    });

    for (const record of result.toolCalls) upsertToolLedger(toolLedger, record);
    authorizationWasRevoked();
    const toolCallCount = toolLedger.length;
    const tokensUsed = result.usageRecords.reduce((sum, r) => sum + r.totalTokens, 0);
    recordAutonomousTokens(task.userId, tokensUsed);

    if (isTaskPauseRequested(task.id, task.userId) && !isTaskCancellationRequested(task.id, task.userId)) {
      markPaused(task.id);
      markLinkedPlanPaused(task);
      io.to(taskRoom).emit('autonomous:task_paused', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Paused' };
    }
    if (isTaskCancellationRequested(task.id, task.userId) || isRealtimeUserActive(task.userId)) {
      const reason = isRealtimeUserActive(task.userId)
        ? 'Cancelled because a live user voice session took priority'
        : 'Cancelled by user';
      const cancelled = markCancelled(task.id, reason);
      markLinkedPlanCancelled(task);
      const machineFeedback = buildTaskCompletionFeedback(cancelled?.terminalReceipt, task.title, {
        status: cancelled?.status || 'cancelled',
        reason,
      });
      io.to(taskRoom).emit('autonomous:task_cancelled', {
        taskId: task.id,
        title: task.title,
        completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Cancelled by user' };
    }

    const outcome = evaluateAutonomousTaskOutcome(
      `${task.title}\n${task.description}`.trim(),
      result.text,
      toolLedger,
      task,
      { completionGuard: result.completionGuard, taskId: task.id, requestId, flow: executionPipeline.turnIntent.flow },
    );
    const publicOutcome = await finalizeAutonomousTaskOutcomeForDelivery(
      `${task.title}\n${task.description}`.trim(),
      outcome,
      toolLedger,
    );
    // Final response preparation is asynchronous. A stop arriving during it
    // takes priority over verification, including a pausing task whose lease
    // intentionally no longer admits normal completion/failure transitions.
    authorizationWasRevoked();
    const voiceTookPriority = isRealtimeUserActive(task.userId);
    const cancellationRequested = isTaskCancellationRequested(task.id, task.userId) || voiceTookPriority;
    if (cancellationRequested || isTaskPauseRequested(task.id, task.userId)) {
      const settled = cancellationRequested
        ? markCancelled(task.id, voiceTookPriority ? 'Cancelled because a live user voice session took priority' : 'Cancelled by user')
        : markPaused(task.id);
      const interruption = settled && publishAutonomousTaskInterruption(io, taskRoom, task, settled);
      return { executed: true, taskId: task.id, result: interruption || 'Task settlement was superseded.' };
    }
    const terminalReceipt = buildTaskTerminalReceipt({
      taskId: task.id,
      runtime: 'autonomous',
      outcome: 'completed',
      toolRecords: toolLedger,
      reason: outcome.verified
        ? undefined
        : outcome.reason || 'Autonomous completion could not be verified.',
    });
    const terminalAcceptance = outcome.verified
      ? validateCompletionTerminalReceipt(terminalReceipt, {
          taskId: task.id,
          runtime: 'autonomous',
        })
      : null;
    if (!outcome.verified || !terminalAcceptance?.accepted) {
      const failureReason = outcome.verified
        ? terminalAcceptance?.reason || 'Autonomous completion lacked a verified terminal receipt.'
        : outcome.reason || 'Autonomous completion could not be verified.';
      const receiptSnapshots = snapshotDurableToolRecords(toolLedger);
      checkpointAutonomousTask(task.id, {
        phase: 'failed_verification',
        receiptIds: toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
        receipts: receiptSnapshots,
        detail: failureReason,
      }, running.leaseId);
      const settled = recordAutonomousTaskFailure(task.id, {
        error: failureReason,
        verificationFailure: true,
        receiptSnapshots,
        sideEffectClass: executionPipeline.executionPlan.risk.sideEffectClass,
        leaseLost,
      }, running.leaseId);
      if (!settled) {
        return { executed: true, taskId: task.id, result: 'Task lease was lost; stale completion was discarded.' };
      }
      const interruption = publishAutonomousTaskInterruption(io, taskRoom, task, settled);
      if (interruption) return { executed: true, taskId: task.id, result: interruption };
      const willRetry = settled.status === 'pending';
      if (!willRetry) markLinkedPlanFailed(task, failureReason);
      const publicFailureText = projectAutonomousCustomerMessage(publicOutcome.text, {
        language: publicLanguage,
        state: willRetry ? 'retrying' : 'failed',
        preserveCleanText: true,
      });
      const machineFeedback = buildTaskCompletionFeedback(
        settled.terminalReceipt,
        task.title,
        { status: settled.status, reason: failureReason },
      );
      io.to(taskRoom).emit(willRetry ? 'autonomous:task_retry_scheduled' : 'autonomous:task_failed', {
        taskId: task.id,
        title: task.title,
        error: publicFailureText,
        result: publicFailureText,
        toolCallsCount: toolCallCount,
        tokensUsed,
        finalized: !willRetry,
        blocked: !willRetry,
        verified: false,
        status: settled.status,
        nextAttemptAt: settled.nextAttemptAt,
        completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
        timestamp: new Date().toISOString(),
      });
      console.warn(
        `[AutoExecutor] Task "${task.title}" not marked complete: ${outcome.reason} `
        + `(${outcome.successfulToolRecords.length}/${toolCallCount} successful tools)`,
      );
      return {
        executed: true,
        taskId: task.id,
        result: willRetry ? `Retry scheduled: ${settled.nextAttemptAt}` : outcome.text || failureReason,
      };
    }

    const summary = publicOutcome.text;
    const publicSummary = projectAutonomousCustomerMessage(summary, {
      language: publicLanguage,
      state: 'completed',
      preserveCleanText: true,
    });
    checkpointAutonomousTask(task.id, {
      phase: 'verified',
      receiptIds: toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
      receipts: snapshotDurableToolRecords(toolLedger),
      detail: outcome.reason || 'Completion verified',
    }, running.leaseId);
    const completed = markCompleted(task.id, summary, toolCallCount, tokensUsed, {
      finalized: true,
      blocked: false,
      verified: true,
      verificationReason: outcome.reason,
      terminalReceipt,
    }, running.leaseId);
    if (!completed) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale completion was discarded.' };
    }
    if (completed.status !== 'completed') {
      const interruption = publishAutonomousTaskInterruption(io, taskRoom, task, completed);
      return { executed: true, taskId: task.id, result: interruption || completed.status };
    }
    const confirmPlanSaved = task.planId
      ? stageAutonomousPlanCompletion(task.id, task.planId, planScopeForTask(task), clipPlanResult(summary))
      : undefined;

    const returnResult = { executed: true, taskId: task.id, result: summary };
    stageAutonomousTaskFinalization({ room: taskRoom, confirmPlanSaved, task,
      isAuthorized: () => isAuthorized() && !options.signal?.aborted,
      returnResult,
      payload: {
      taskId: task.id,
      title: task.title,
      result: publicSummary,
      toolCallsCount: toolCallCount,
      tokensUsed,
      finalized: true,
      blocked: false,
      verified: true,
      completionFeedback: projectAutonomousCompletionFeedback(buildTaskCompletionFeedback(
        completed.terminalReceipt,
        task.title,
        { status: completed.status, accepted: true },
      )),
      timestamp: new Date().toISOString(),
    } });

    return returnResult;
  } catch (err: any) {
    return finalizeAutonomousTaskFailure(err, { task, running, io, taskRoom, toolLedger, sideEffectClass, leaseLost, publicLanguage, authorizationWasRevoked });
  } finally {
    clearInterval(leaseHeartbeat);
    options.signal?.removeEventListener('abort', onParentCancelled);
    voicePriority.signal.removeEventListener('abort', onVoicePriority);
    voicePriority.dispose();
    releaseDesktopControlLease();
    try {
      await persistAutonomousTaskFinalizations(io);
    } catch (error) {
      if (hasPendingAutonomousTaskFinalization(task.id)) {
        io.to(taskRoom).emit('autonomous:task_failed', {
          taskId: task.id, title: task.title, status: 'blocked', finalized: false, verified: false, blocked: true,
          error: publicLanguage === 'zh'
            ? CN_AUTONOMOUS_CUSTOMER_MESSAGES.finalizationPending
            : 'The work finished, but its final state could not be saved. Saving must succeed before completion can be confirmed.',
          timestamp: new Date().toISOString(),
        });
      }
      throw error;
    } finally {
      // The live owner outlasts both its handler and terminal persistence.
      membershipAuthority?.dispose();
      releaseAutonomousTaskExecutor(task.id, running.leaseId);
      conversationExecution?.release();
    }
  }
}
