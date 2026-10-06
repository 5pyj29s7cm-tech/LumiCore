import { runResolvedLumiTurn } from "../../../../cognition/turn_model";
import type { MessageHandler } from "../../../../messaging/types";
import { MessagingAuthorizationRevokedError } from "../../../../messaging/turn_authorization";
import { toolRegistry } from "../../../../tools/registry";
import { setConversationActionExecutionStatus } from "../../../../conversation/manager";
import { formatPendingConfirmationRequest } from "../../../../tools/pending_confirmation";
import { saveStoredOperationMode } from "../../../../cognition/operation_mode_store";
import { persistRemotePostTurnLearning } from "../remote_memory";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../messages/task_execution_messages";
import { setOrganizationWorkItemExecutionStatus } from "../../../../org/work_routing";
import { mergeToolExecutionRecords, toolRecordSucceeded } from "../../../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../../../tools/types";
import type { NormalizedMessage } from "../../../../llm/providers";
import { isRetiredOperationModeRequest } from "../../../../cognition/operation_modes";
import { buildOperationModeMetaResponse } from "../../../../cognition/capability_meta";
import { executeToolCall } from "../../../../tools/execution_engine";
import { formatOperationModeSwitchResponse } from "../../../messages/operation_mode_messages";
import { handleRemoteLegalNoticeIntake } from "../legal_notice_intake";

import type { LLMResult } from "../../../../llm/adapter";
import { recordTokenUsageBatch } from "../../../../llm/token_tracker";
import { finalizeLumiResponse } from "../../../../cognition/result_finalizer";
import { isMessagingReplyDurabilityError, finalizeMessagingResponseForDelivery, withCurrentMessagingDesktopExecutionReceipt, currentMessagingFinalizationRecords, type MessagingFinalization } from "../messaging_finalization";
import { assertMessagingAuthorization, isMessagingAuthorizationCurrent } from "../messaging_ingress_runtime";
import { handleRemoteOrgCommand } from "../remote_org_commands";
import type { MessagingModelContext } from './execution_preparation';

export async function executeMessagingModelTurn(context: MessagingModelContext): Promise<string> {


  try {
    const usageInteractionId = `messaging_${context.msg.platform}_${Date.now()}`;
    let responseText = '';
    let callbackReply: Awaited<ReturnType<MessageHandler>> | null = null;
    const callbackBlockedForExternalCommit = Boolean(
      context.options?.onMessage && context.organizationWorkRoute?.workItem.sideEffectClass === 'external_commit',
    );
    // The legacy handler returns only prose and cannot produce a canonical tool
    // envelope. Never let it execute an external commit; those actions must go
    // through the receipt-producing tool route and its exact confirmation gate.
    if (context.options?.onMessage && !callbackBlockedForExternalCommit) {
      assertMessagingAuthorization(context.msg);
      context.organizationWorkExecution?.assertCurrent();
      callbackReply = await context.options.onMessage(context.msg);
      context.throwIfActionLeaseWasLost();
    }
    let deterministicEntryReply: string | null = callbackReply?.text
      || (isRetiredOperationModeRequest(context.requestText) ? buildOperationModeMetaResponse({ text: context.requestText, operationMode: context.operationMode }) : null)
      || (callbackBlockedForExternalCommit
        ? (/[㐀-鿿]/u.test(context.routingText)
          ? '外部提交已停止：旧消息回调不能生成统一工具回执，请改由受确认和回执约束的工具执行。'
          : 'The external commit was stopped because the legacy message callback cannot produce a canonical tool receipt. Use the confirmed tool route instead.')
        : null);
    if (deterministicEntryReply) responseText = deterministicEntryReply;

    if (context.isIdentityBound && context.directlyAppliedMode && !deterministicEntryReply) {
      const modeRecord = await executeToolCall({
        registry: toolRegistry,
        id: `${context.requestId}:client-mode`,
        name: 'client_action',
        arguments: {
          action: 'start_meeting_mode',
          mode: context.directlyAppliedMode,
          // Confirmation authority comes from ToolContext/requestConfirmation,
          // never from a model- or route-authored boolean argument.
          confirmed: false,
        },
        context: context.remoteToolContext,
      });
      context.throwIfActionLeaseWasLost();
      context.collectToolRecord(modeRecord);
      const modeSynced = toolRecordSucceeded(modeRecord);
      if (modeSynced) saveStoredOperationMode(context.effectiveUserId, context.directlyAppliedMode);

      const candidate = context.pendingConfirmationCreatedThisTurn
        ? formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn)
        : formatOperationModeSwitchResponse(context.directlyAppliedMode, modeSynced, context.requestText);
      const modeOutbound = await finalizeMessagingResponseForDelivery({
        taskText: context.routingText,
        responseText: candidate,
        toolRecords: context.taskAwareRecords(context.toolRecords),
        source: context.source,
        flow: context.turnFlow,
        taskId: context.actionTaskExecution.state?.taskId,
        requestId: context.requestId,
        pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
        isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
      });
      const finalizedMode = modeOutbound.finalization;
      context.toolRecords = withCurrentMessagingDesktopExecutionReceipt(
        modeOutbound.toolRecords,
        context.desktopExecutionTracker,
        context.actionTaskExecution.state?.taskId,
        context.requestId,
      );
      return await context.commitReply(finalizedMode.text, {
        toolCalls: context.toolRecords,
        beforeFlush: superseded => {
          if (superseded) {
            context.settleRemoteTask('The remote turn was superseded by a newer user message.');
            return;
          }
          if (context.pendingConfirmationCreatedThisTurn && context.conversation) {
            setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'waiting_confirmation', {
              assistantState: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn), requestId: context.requestId,
            });
          }
          context.settleRemoteTask();
        },
      });
    }

    if (!deterministicEntryReply && context.isOrganizationBound) {
      assertMessagingAuthorization(context.msg);
      deterministicEntryReply = await handleRemoteLegalNoticeIntake(context.msg, {
        isCancelled: context.actionWasCancelled,
        executionSignal: context.actionAbortController.signal,
      });
      assertMessagingAuthorization(context.msg);
      if (!deterministicEntryReply) {
        context.organizationWorkExecution?.assertCurrent();
        deterministicEntryReply = await handleRemoteOrgCommand(context.msg, () => context.organizationWorkExecution?.assertCurrent());
      }
      if (deterministicEntryReply) {
        responseText = deterministicEntryReply;
        context.toolRecords.push({
          id: `${context.requestId}:organization-command`,
          taskId: context.actionTaskExecution.state?.taskId,
          turnId: context.msg.messageId,
          turnRowId: context.actionTaskExecution.turnRowId,
          externalMessageId: context.msg.messageId,
          resolutionId: context.executionPlan.resolution.id,
          requestId: context.requestId,
          idempotencyKey: `${context.organizationWorkRoute?.workItem.id || context.requestId}:organization-command`,
          name: 'organization_business_command',
          arguments: {
            source: context.source,
            requestId: context.requestId,
            workItemId: context.organizationWorkRoute?.workItem.id || '',
          },
          result: JSON.stringify({
            ok: true,
            verified: true,
            status: 'completed',
            verificationMethod: 'organization-server-transaction',
            workItemId: context.organizationWorkRoute?.workItem.id || '',
          }),
          terminalVerification: {
            status: 'verified',
            strategy: 'terminal_receipt',
            reason: 'The organization server transaction returned a verified local receipt.',
          },
          envelope: {
            version: 1,
            status: 'verified_success',
            toolName: 'organization_business_command',
            resolutionId: context.executionPlan.resolution.id,
            taskId: context.actionTaskExecution.state?.taskId || '',
            turnId: context.msg.messageId,
            turnRowId: context.actionTaskExecution.turnRowId,
            externalMessageId: context.msg.messageId,
            requestId: context.requestId,
            idempotencyKey: `${context.organizationWorkRoute?.workItem.id || context.requestId}:organization-command`,
            targetIdentity: context.orgId,
            completedAt: new Date().toISOString(),
            result: {
              workItemId: context.organizationWorkRoute?.workItem.id || '',
              verificationMethod: 'organization-server-transaction',
            },
            verification: {
              status: 'verified',
              reason: 'The organization server transaction returned a verified local receipt.',
            },
          },
        });
      }
    }
    if (deterministicEntryReply && !responseText) responseText = deterministicEntryReply;

    let completionGuard: LLMResult['completionGuard'];
    const entryHandled = Boolean(deterministicEntryReply);
    const runMessagingToolTurn = (
      turnMessages: NormalizedMessage[],
      onToolRecord?: (record: ToolExecutionRecord) => void,
      executionSource = context.source,
    ) => runResolvedLumiTurn({
      execution: context.executionPlan,
      assertCurrent: () => assertMessagingAuthorization(context.msg),
      isCancelled: context.actionWasCancelled,
      taskText: context.routingText, streaming: false,
      messages: turnMessages,
      registry: toolRegistry,
      config: context.userLLMPrefs,
      onToolCall: record => { context.collectToolRecord(record); onToolRecord?.(record); },
      maxIterations: context.modelToolPolicy.maxIterations || context.executionDecision.maxIterations,
      context: { ...context.remoteToolContext, source: executionSource, modelToolProjection: context.modelToolProjection },
      getters: context.llm,
    });

    if (!entryHandled) {
      assertMessagingAuthorization(context.msg);
      const result = await runMessagingToolTurn(context.messages);
      responseText = result.text || '';
      completionGuard = result.completionGuard;
      context.toolRecords = mergeToolExecutionRecords(context.toolRecords, result.toolCalls || []);
      recordTokenUsageBatch(context.effectiveUserId, result.usageRecords || [], usageInteractionId, 'chat');
    }

    context.toolRecords = withCurrentMessagingDesktopExecutionReceipt(
      context.toolRecords,
      context.desktopExecutionTracker,
      context.actionTaskExecution.state?.taskId,
      context.requestId,
    );
    if (context.pendingConfirmationCreatedThisTurn) {
      responseText = formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn);
    }
    const deliveryText = responseText || '这次没有生成可用回复，请稍后重试。';
    const preDeliveryRecords = currentMessagingFinalizationRecords({
      toolRecords: context.taskAwareRecords(context.toolRecords),
      taskId: context.actionTaskExecution.state?.taskId,
      requestId: context.requestId,
    });
    const organizationVerifiedTerminalReceipt = preDeliveryRecords.some(record => {
      const verified = record.envelope?.status === 'verified_success'
        || record.terminalVerification?.status === 'verified';
      if (!verified) return false;
      if (context.organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit') return true;
      return Boolean(record.capability?.sideEffects?.some(effect => (
        effect.type === 'external_communication' || effect.type === 'external_state_change'
      ))) || /(?:send|submit|publish|post|comment|reply|payment|purchase|sign)/i.test(record.name);
    });
    const missingOrganizationExternalCommitReceipt = context.organizationWorkRoute?.workItem.sideEffectClass === 'external_commit'
      && !context.pendingConfirmationCreatedThisTurn
      && !organizationVerifiedTerminalReceipt;
    const initialFinalization: MessagingFinalization = callbackReply
      && context.organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit'
      ? { text: responseText || callbackReply.text, blocked: false }
      : missingOrganizationExternalCommitReceipt
        ? {
        text: /[\u3400-\u9fff]/u.test(context.routingText)
          ? '这次外部提交还没有完成：没有收到可验证的终态回执，Lumi 已停止，且不会盲目重试。'
          : 'The external commit is not complete: no verified terminal receipt was received, so Lumi stopped and will not retry blindly.',
        blocked: true,
        reason: 'The external commit has no verified terminal receipt.',
          }
        : finalizeLumiResponse({
            taskText: context.routingText,
            responseText: deliveryText,
            completionGuard,
            toolRecords: preDeliveryRecords,
            source: context.source,
            flow: context.turnFlow,
            taskId: context.actionTaskExecution.state?.taskId,
            requestId: context.requestId,
          });
    const outbound = await finalizeMessagingResponseForDelivery({
      taskText: context.routingText,
      responseText: deliveryText,
      toolRecords: preDeliveryRecords,
      source: context.source,
      flow: context.turnFlow,
      taskId: context.actionTaskExecution.state?.taskId,
      requestId: context.requestId,
      initialFinalization,
      allowToolUse: context.toolSessionActive
        && !callbackReply
        && !entryHandled
        && !missingOrganizationExternalCommitReceipt,
      pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
      aborted: context.actionWasCancelled(),
      isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
      isAborted: context.actionWasCancelled,
      attempt: async ({ instruction, recordTool }) => {
        const recovery = await runMessagingToolTurn(
          [
            ...context.messages,
            ...(deliveryText.trim()
              ? [{ role: 'assistant' as const, content: deliveryText }]
              : []),
            { role: 'user', content: instruction },
          ],
          recordTool,
          `${context.source}_guard_recovery`,
        );
        recordTokenUsageBatch(context.effectiveUserId, recovery.usageRecords || [], usageInteractionId, 'chat');
        return {
          text: recovery.text,
          toolRecords: withCurrentMessagingDesktopExecutionReceipt(
            recovery.toolCalls || [],
            context.desktopExecutionTracker,
            context.actionTaskExecution.state?.taskId,
            context.requestId,
          ),
        };
      },
      refinalize: (candidateText, records) => context.pendingConfirmationCreatedThisTurn
        ? {
            text: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn),
            blocked: false,
            reason: 'waiting_confirmation',
          }
        : finalizeLumiResponse({
            taskText: context.routingText,
            responseText: candidateText,
            toolRecords: currentMessagingFinalizationRecords({
              toolRecords: withCurrentMessagingDesktopExecutionReceipt(
                records,
                context.desktopExecutionTracker,
                context.actionTaskExecution.state?.taskId,
                context.requestId,
              ),
              taskId: context.actionTaskExecution.state?.taskId,
              requestId: context.requestId,
            }),
            source: `${context.source}_guard_recovery`,
            flow: context.turnFlow,
            taskId: context.actionTaskExecution.state?.taskId,
            requestId: context.requestId,
          }),
    });
    context.toolRecords = withCurrentMessagingDesktopExecutionReceipt(
      outbound.toolRecords,
      context.desktopExecutionTracker,
      context.actionTaskExecution.state?.taskId,
      context.requestId,
    );
    const finalized = outbound.finalization;
    if (context.actionLeaseWasLost()) {
      await context.actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    if (await context.settleTransferredExecution(context.toolRecords)) return '';
    context.organizationWorkExecution?.assertCurrent();
    const committedText = await context.commitReply(finalized.text, {
      toolCalls: context.toolRecords,
      beforeFlush: superseded => {
        if (superseded) {
          context.settleSupersededRemoteTurn('The remote turn was superseded by a newer user message.');
          return;
        }
        if (context.pendingConfirmationCreatedThisTurn && context.conversation) {
          setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'waiting_confirmation', {
            assistantState: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn),
            requestId: context.requestId,
          });
        }
        if (context.organizationWorkRoute) {
          const organizationStatus = context.pendingConfirmationCreatedThisTurn || finalized.blocked || missingOrganizationExternalCommitReceipt
            ? 'blocked'
            : 'completed';
          const organizationBlocker = context.pendingConfirmationCreatedThisTurn
            ? 'The user action confirmation is still pending.'
            : missingOrganizationExternalCommitReceipt
              ? 'The external commit has no verified terminal receipt.'
              : finalized.reason;
          setOrganizationWorkItemExecutionStatus({
            orgId: context.orgId,
            workItemId: context.organizationWorkRoute.workItem.id,
            status: organizationStatus,
            actorUserId: context.effectiveUserId,
            execution: context.organizationWorkExecution,
            blocker: organizationBlocker,
          });
          if (organizationStatus === 'blocked' && context.conversation) {
            setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'blocked', {
              blocker: organizationBlocker,
              requestId: context.requestId,
            });
          }
        }
        context.settleRemoteTask();
      },
    });
    if (!committedText) return '';
    // Native organization commands already have a deterministic server
    // transaction and a task-bound terminal receipt. Running the generic
    // post-turn extractor here would invoke a model after the command has
    // completed, making a model outage look like part of the task and
    // needlessly competing with receipt persistence. Learned state for these
    // commands comes from the authoritative organization transaction instead.
    if (!entryHandled) {
      try {
        void persistRemotePostTurnLearning({
          message: context.msg,
          responseText: committedText,
          isCancelled: context.actionWasCancelled,
          llmGetters: context.llm,
          modelConfig: {
            provider: context.userLLMPrefs.provider,
            model: context.userLLMPrefs.model,
          },
        });
      } catch (learningError: any) {
        console.warn('[Messaging] Remote post-turn memory extraction could not be scheduled:', learningError?.message || learningError);
      }
    }
    return committedText;
  } catch (err: any) {
    if (!isMessagingAuthorizationCurrent(context.msg)) {
      context.settleRemoteTask('The remote message authorization was revoked or replaced.');
      await context.flushTerminalReply();
      throw new MessagingAuthorizationRevokedError();
    }
    if (context.actionLeaseWasLost()) {
      await context.actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    if (isMessagingReplyDurabilityError(err)) throw err;
    if (await context.settleTransferredExecution(context.toolRecords)) return '';
    console.warn(`[Messaging] ${context.msg.platform} model pipeline failed:`, err?.message || err);
    const fallback = context.toolRecords.length
      ? '当前语言模型暂时不可用，后续处理没有完成。本次已有的执行记录已保留，请稍后继续。'
      : '当前语言模型暂时不可用，这次处理没有完成，请稍后再试。';
    // The assistant write closes this request with an explicit blocked outcome;
    // never recompute completion from an earlier successful substep afterward.
    return await context.commitReply(fallback, {
      toolCalls: context.toolRecords,
      terminalTaskDisposition: context.actionTaskExecution.state?.taskId ? {
        outcome: 'blocked', taskId: context.actionTaskExecution.state.taskId, requestId: context.requestId, reason: fallback,
      } : undefined,
      beforeFlush: superseded => {
        if (superseded) {
          context.settleSupersededRemoteTurn('The remote turn failed after it was superseded by a newer user message.');
          return;
        }
        if (context.organizationWorkRoute) setOrganizationWorkItemExecutionStatus({
          orgId: context.orgId, workItemId: context.organizationWorkRoute.workItem.id, status: 'blocked',
          actorUserId: context.effectiveUserId, execution: context.organizationWorkExecution,
          blocker: err?.message || 'The remote model/tool pipeline failed before a terminal receipt was recorded.',
        });
      },
    });
  }
}
