import type { ExecutedLumiTurn, AssembledLumiTurnData } from "../../../../cognition/turn_execution";
import type { MessageHandler } from "../../../../messaging/types";
import { MessagingAuthorizationRevokedError } from "../../../../messaging/turn_authorization";
import { toolRegistry } from "../../../../tools/registry";
import { decodeToolResult } from "../../../../tools/result_envelope";
import { sanitizePublicExecutionText } from "../../../../../shared/public_execution_language";
import { setConversationActionExecutionStatus } from "../../../../conversation/manager";
import { formatPendingConfirmationRequest } from "../../../../tools/pending_confirmation";
import { saveStoredOperationMode } from "../../../../cognition/operation_mode_store";
import { persistRemotePostTurnLearning } from "../remote_memory";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../messages/task_execution_messages";
import { CN_MESSAGING_MESSAGES } from '../../../messages/messaging_messages';
import { setOrganizationWorkItemExecutionStatus } from "../../../../org/work_routing";
import { mergeToolExecutionRecords, toolRecordSucceeded } from "../../../../cognition/task_execution_ledger";
import { isRetiredOperationModeRequest } from "../../../../cognition/operation_modes";
import { buildOperationModeMetaResponse } from "../../../../cognition/capability_meta";
import { executeToolCall } from "../../../../tools/execution_engine";
import { formatOperationModeSwitchResponse } from "../../../messages/operation_mode_messages";
import { handleRemoteLegalNoticeIntake, REMOTE_LEGAL_INTAKE_TOOL, type RemoteLegalNoticeStageReceipt } from "../legal_notice_intake";
import { promptBlockMessage } from "../../../../llm/prompt_blocks";
import { restrictLumiExecutionTools } from "../../../../cognition/execution_decision";

import { recordTokenUsageBatch } from "../../../../llm/token_tracker";
import { createTurnResponseFinalizer } from "../../../../cognition/turn_response_finalizer";
import { isMessagingReplyDurabilityError, finalizeMessagingResponseForDelivery, withCurrentMessagingDesktopExecutionReceipt, currentMessagingFinalizationRecords, type MessagingFinalization } from "../messaging_finalization";
import { assertMessagingAuthorization, isMessagingAuthorizationCurrent } from "../messaging_ingress_runtime";
import { handleRemoteOrgCommand } from "../remote_org_commands";
import type { MessagingModelContext } from './execution_preparation';

export async function prepareMessagingModelTurn(context: MessagingModelContext) {


  try {
    const usageInteractionId = `messaging_${context.msg.platform}_${Date.now()}`;
    let responseText = '';
    let nativeStage = context.nativeLegalStage?.receipt;
    let nativeStageText = context.nativeLegalStage?.content || '';
    if (context.remoteLegalNoticeSelection) context.messages.splice(context.messages.length - 1, 0, promptBlockMessage({
      id: 'remote-legal-notice-source', kind: 'background', authority: 'server',
      content: 'This server-bound pending notice is prior source context, not the current user instruction, a completion root, or an execution grant. Keep its original request and supplied material separate from the current selection. No stage receipt proves all obligations of either request.',
      fields: { selection: context.remoteLegalNoticeSelection },
    }));
    let callbackReply: Awaited<ReturnType<MessageHandler>> | null = null;
    // Organization effects use canonical tools or the same native admission fence.
    if (context.options?.onMessage && !context.isOrganizationBound) {
      assertMessagingAuthorization(context.msg);
      callbackReply = await context.options.onMessage(context.msg);
      context.throwIfActionLeaseWasLost();
    }
    let deterministicEntryReply: string | null = callbackReply?.text
      || (isRetiredOperationModeRequest(context.requestText) ? buildOperationModeMetaResponse({ text: context.requestText, operationMode: context.operationMode }) : null);
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
      return { terminal: await context.commitReply(finalizedMode.text, {
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
      }), data: undefined, deliver: undefined };
    }

    if (!deterministicEntryReply) {
      assertMessagingAuthorization(context.msg);
      const nativeReply = nativeStage ? null : await handleRemoteLegalNoticeIntake(context.msg, context.remoteToolContext);
      assertMessagingAuthorization(context.msg);
      if (nativeReply) {
        const decoded = decodeToolResult(nativeReply);
        const stage = decoded.receipt as RemoteLegalNoticeStageReceipt | undefined;
        if (stage?.kind !== 'legal_notice_intake_stage' || stage.version !== 1
          || stage.requestId !== context.requestId || stage.taskId !== context.actionTaskExecution.state?.taskId
          || (stage.orgId || '') !== context.orgId) throw new Error('The native intake stage does not belong to this accepted request.');
        nativeStage = stage; nativeStageText = decoded.content;
        await context.retainNativeLegalStage({ receipt: stage, content: decoded.content }, context.toolRecords);
      }
      if (nativeStage) {
        context.remoteToolContext.priorToolRecords = context.taskAwareRecords(context.toolRecords);
        // The stage consumes this one native action; remaining prose cannot change its arguments and write again.
        const narrowed = restrictLumiExecutionTools(context.executionPlan.execution, [REMOTE_LEGAL_INTAKE_TOOL]);
        context.executionPlan.execution = narrowed;
        context.executionPlan.authorizationPolicy = narrowed.toolPolicy;
        context.remoteToolContext.toolPolicy = narrowed.toolPolicy;
        context.executionPlan.modelToolProjection = { ...context.executionPlan.modelToolProjection,
          toolNames: context.executionPlan.modelToolProjection.toolNames.filter(name => name !== REMOTE_LEGAL_INTAKE_TOOL) };
        context.executionPlan.executionRequested = context.executionPlan.executionRequested
          && narrowed.allowToolUse && context.executionPlan.modelToolProjection.toolNames.length > 0;
        context.messages.splice(context.messages.length - 1, 0, promptBlockMessage({
          id: 'remote-legal-notice-stage', kind: 'receipt', authority: 'server', required: true,
          content: 'Only the case-material archive stage has been evaluated below. Continue the current full request through the same existing tool loop if work remains. A stage report is not a generated legal document or proof that any original or current extra obligation has completed; do not repeat the archived action.',
          fields: { stage: nativeStage, report: nativeStageText }, requiredFields: ['stage', 'report'],
        }));
      }
      if (!nativeStage && !deterministicEntryReply && context.isOrganizationBound) {
        context.organizationWorkExecution?.assertCurrent();
        const command = await handleRemoteOrgCommand(context.msg, context.remoteToolContext);
        if (command) {
          const decoded = decodeToolResult(command);
          deterministicEntryReply = decoded.content;
          const receipt = decoded.receipt as { ok?: unknown; verified?: unknown; status?: unknown; persisted?: unknown; changedCaseIds?: unknown; articleIds?: unknown } | undefined;
          const commandSucceeded = receipt?.ok === true && receipt.verified === true && receipt.status === 'completed';
          const archive = {
            persisted: commandSucceeded && receipt?.persisted === true,
            changedCaseIds: commandSucceeded && Array.isArray(receipt?.changedCaseIds) ? receipt.changedCaseIds.filter(id => typeof id === 'string' && id.trim()) : [],
            articleIds: commandSucceeded && Array.isArray(receipt?.articleIds) ? receipt.articleIds.filter(id => typeof id === 'string' && id.trim()) : [],
          };
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
              ok: commandSucceeded,
              verified: commandSucceeded,
              status: commandSucceeded ? 'completed' : 'blocked',
              verificationMethod: 'organization-server-transaction',
              ...archive,
              workItemId: context.organizationWorkRoute?.workItem.id || '',
            }),
            terminalVerification: {
              status: commandSucceeded ? 'verified' : 'failed',
              strategy: 'terminal_receipt',
              reason: commandSucceeded ? 'The organization server transaction returned a verified local receipt.' : 'The organization command did not confirm completion.',
            },
            envelope: {
              version: 1,
              status: commandSucceeded ? 'verified_success' : 'failed',
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
                ...archive,
              },
              verification: {
                status: commandSucceeded ? 'verified' : 'failed',
                reason: commandSucceeded ? 'The organization server transaction returned a verified local receipt.' : 'The organization command did not confirm completion.',
              },
            },
          });
          }
      }
    }
    if (deterministicEntryReply && !responseText) responseText = deterministicEntryReply;

    const entryHandled = Boolean(deterministicEntryReply);
    const responseFinalizer = createTurnResponseFinalizer({
      taskText: context.routingText, flow: context.turnFlow, taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      pendingConfirmation: () => context.pendingConfirmationCreatedThisTurn,
      controlPauseReason: () => context.desktopRelay?.getControlPauseReason?.() || null,
    });
    let missingOrganizationExternalCommitReceipt = false;
    return { terminal: undefined, data: {
      systemPrompt: context.systemPrompt, messages: context.messages, taskText: context.routingText,
      task: { taskId: context.actionTaskExecution.state?.taskId, turnRowId: context.actionTaskExecution.turnRowId },
      model: {
        assertCurrent: () => { assertMessagingAuthorization(context.msg); context.organizationWorkExecution?.assertCurrent(); },
        isCancelled: context.actionWasCancelled,
        taskText: context.routingText, streaming: false,
        registry: toolRegistry, config: context.userLLMPrefs,
        onToolCall: context.collectToolRecord,
        maxIterations: context.modelToolPolicy.maxIterations || context.executionDecision.maxIterations,
        context: context.remoteToolContext, getters: context.llm,
      }, prepared: { skipModel: entryHandled,
      onResult: result => {
        if (entryHandled) return;
        context.toolRecords = mergeToolExecutionRecords(context.toolRecords, result.toolCalls || []);
        recordTokenUsageBatch(context.effectiveUserId, result.usageRecords || [], usageInteractionId, 'chat');
      },
      onRecoveryUsage: records => recordTokenUsageBatch(context.effectiveUserId, records || [], usageInteractionId, 'chat'),
      projectRecords: records => currentMessagingFinalizationRecords({
        toolRecords: withCurrentMessagingDesktopExecutionReceipt(
          context.taskAwareRecords(mergeToolExecutionRecords(context.toolRecords, records)),
          context.desktopExecutionTracker, context.actionTaskExecution.state?.taskId, context.requestId,
        ),
        taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      }),
      finalization: ({ result, responseText: modelText, toolRecords }) => {
        responseText = entryHandled ? responseText : modelText;
        const deliveryText = responseText || '这次没有生成可用回复，请稍后重试。';
        const organizationVerifiedTerminalReceipt = toolRecords.some(record => {
          const verified = record.envelope?.status === 'verified_success' || record.terminalVerification?.status === 'verified';
          if (!verified) return false;
          if (context.organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit') return true;
          return Boolean(record.capability?.sideEffects?.some(effect => (
            effect.type === 'external_communication' || effect.type === 'external_state_change'
          ))) || /(?:send|submit|publish|post|comment|reply|payment|purchase|sign)/i.test(record.name);
        });
        missingOrganizationExternalCommitReceipt = context.organizationWorkRoute?.workItem.sideEffectClass === 'external_commit'
          && !context.pendingConfirmationCreatedThisTurn && !organizationVerifiedTerminalReceipt;
        const initialFinalization: MessagingFinalization = context.organizationAdmissionBlocker
          ? { text: context.organizationAdmissionBlocker, blocked: true, reason: 'organization_action_admission_blocked' }
          : callbackReply
          && context.organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit'
          ? { text: responseText || callbackReply.text, blocked: false }
          : missingOrganizationExternalCommitReceipt
            ? { text: /[\u3400-\u9fff]/u.test(context.routingText)
              ? '这次外部提交还没有完成：没有收到可验证的终态回执，Lumi 已停止，且不会盲目重试。'
              : 'The external commit is not complete: no verified terminal receipt was received, so Lumi stopped and will not retry blindly.',
              blocked: true, reason: 'The external commit has no verified terminal receipt.' }
            : responseFinalizer.finalize({ responseText: deliveryText,
              completionGuard: result.completionGuard, toolRecords, source: context.source });
        return {
          initialFinalization,
          allowToolUse: context.toolSessionActive && !callbackReply && !entryHandled && !nativeStage && !missingOrganizationExternalCommitReceipt && !context.organizationAdmissionBlocker,
          pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn), requiresFreshConfirmation: context.correctionRequiresFreshConfirmation, aborted: context.actionWasCancelled(),
          isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn), isAborted: context.actionWasCancelled,
          trustedConfirmationRequestText: responseFinalizer.confirmationRequestText,
          refinalize: (candidateText, records, completionGuard) => responseFinalizer.finalize({ responseText: candidateText, completionGuard,
              toolRecords: currentMessagingFinalizationRecords({
                toolRecords: withCurrentMessagingDesktopExecutionReceipt(records, context.desktopExecutionTracker, context.actionTaskExecution.state?.taskId, context.requestId),
                taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
              }), source: context.source + '_guard_recovery' }),
        };
      },
      },
    } satisfies AssembledLumiTurnData, deliver: async (completed: ExecutedLumiTurn) => {
    context.toolRecords = completed.toolRecords;
    const finalized = nativeStage && !context.pendingConfirmationCreatedThisTurn
      ? { ...completed.finalized, blocked: true, reason: 'native_stage_whole_request_unverified',
          text: [nativeStageText, '当前仅核验入案阶段；本次请求的完整完成状态仍待核验。',
            completed.finalized.blocked ? completed.finalized.text : ''].filter(Boolean).join('\n\n') }
      : completed.finalized;
    if (context.actionLeaseWasLost()) {
      await context.actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    if (await context.settleTransferredExecution(context.toolRecords)) return '';
    context.organizationWorkExecution?.assertCurrent();
    const committedText = await context.commitReply(sanitizePublicExecutionText(finalized.text), {
      toolCalls: context.toolRecords,
      ...(finalized.blocked && context.actionTaskExecution.state?.taskId ? { terminalTaskDisposition: {
        outcome: 'blocked' as const, taskId: context.actionTaskExecution.state.taskId, requestId: context.requestId,
        reason: finalized.reason || 'The remote response did not pass final verification.',
      } } : {}),
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
    if (!entryHandled && !finalized.blocked) {
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
    } };
  } catch (err) {
    return { terminal: await finalizeMessagingModelFailure(err, context), data: undefined, deliver: undefined };
  }
}

export async function finalizeMessagingModelFailure(err: any, context: MessagingModelContext): Promise<string> {
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
    const modelBlocker = context.organizationAdmissionBlocker || (err instanceof MessagingAuthorizationRevokedError
      ? CN_MESSAGING_MESSAGES.executionCheckRejected
      : context.toolRecords.length
        ? '后续处理没有完成。本次已有的执行记录已保留，请稍后继续。'
        : '这次处理没有完成，请稍后再试。');
    const fallback = sanitizePublicExecutionText([context.nativeLegalStage?.content,
      context.nativeLegalStage ? '当前仅核验入案阶段；本次请求的完整完成状态仍待核验。' : '',
      modelBlocker].filter(Boolean).join('\n\n'));
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
