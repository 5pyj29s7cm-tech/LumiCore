import type { ToolExecutionRecord } from '../tools/types';
import { coalesceToolExecutionRecords, toolRecordSucceeded } from './task_execution_ledger';
import { parseReceiptObject, toolRecordTerminalPayload, toolRecordTerminalText } from '../tools/receipt_payload';
import { formatRuntimeCleanupReceipt } from '../i18n/runtime_cleanup_messages';
import { CN_VOICE_FAST_PATH_MESSAGES, CN_VOICE_QUICK_WORK_MESSAGES, formatCnMediaGenerationFailure } from '../regions/packs/cn/voice_fast_path_messages';
import { isExplicitRuntimeCleanupProposal } from './pending_assistant_offer';
import { buildActionContract, claimsCurrentAppSaveCompletion, documentReadMatchesRequestedTarget, extractExplicitArtifactTextRequirements, extractSimpleDesktopOpenTarget, hasAuthenticatedWebResultEvidence, browserSessionObservation, hasCoreActionEvidence, hasCurrentAppSaveEvidence, hasCurrentAppUiMutationEvidence, hasMediaPlaybackEvidence, hasMediaPauseEvidence, hasRequestedDesktopOpenEvidence, hasVisibleAutoCadExecutionEvidence, requiresArtifactPostWriteReadback, requiresCurrentAppUiMutation, requiresAuthenticatedWebResult, requiresVisibleAutoCadExecution, summarizeActionContractBlocker } from './action_contract';
import { formatCnMessagingContractBlocker } from '../regions/packs/cn/messaging_messages';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from '../regions/packs/cn/execution_evidence_messages';
import type { LumiClientMode } from '../../shared/operation_modes';
import { formatVerifiedTaskResultForReadability } from './reply_style';
import { hasExplicitNoMutationInstruction } from './tool_intent';
import { hasVisionIntent } from './vision_routing';
import { isModelConfigurationReadRequest } from './model_configuration_intent';
import type { LumiTurnFlow } from './turn_flow';
import { verifiedExternalCliStatus, formatExternalCliStatus } from './external_cli_status';
import { findDesktopCompletionReview, desktopCompletionReviewText, DESKTOP_COMPLETION_REVIEW_REASON } from './desktop_completion_review';
import { artifactPathFromRecord, resolveArtifactDelivery } from '../tools/artifact_evidence';
import { withoutLocationLiterals } from './location_literals';
import { buildTaskTargetAnchorProjection, isVerifiedProducedDocumentTarget } from '../conversation/task_target_anchor';
import { missingTaskInputResult } from './missing_task_input';
import { getArtifactTaskProgress } from './action_contract';
import { formatArtifactProgress } from './artifact_progress';
import { missingSpreadsheetRequirements } from './spreadsheet_requirements';
import { isMediaPauseRequest } from './media_intent';
import { CN_EXTERNAL_CLI_MESSAGES } from '../regions/packs/cn/external_cli_messages';
import { buildOperationModeMetaResponse } from './capability_meta';
import { formatGroundedKnowledgeObservation } from './knowledge_result';
import { normalizeActionIntent } from './normalized_action_intent';
import { buildMediaArtifactReceipt } from '../socket/media_artifact_receipt';
import { sanitizeUserFacingExecutionOutput } from './user_output_protection';
import { guardCompletionClaims } from '../work_product/completion_guard';
import { hasImmediateExecutionPromise } from './execution_claims';
import { formatClientDiagnosticResult, hasCompleteClientDiagnosticReceipts } from './client_diagnostic_result';
import { evaluateDesktopObservationEvidence } from './desktop_observation';
import { hasContinuousStockWatchIntent, hasContinuousStockWatchEvidence, requiresLegalCurrentLawGate, claimsLegalDocumentCompletion, hasLegalDocumentProductionEvidence, hasLegalCurrentLawGateEvidence, hasLegalReasoningChainEvidence, hasLegalExternalPlatformSignal, describesAuthorizedLegalExternalHandoff, claimsExternalLegalPlatformFinalAction, claimsExternalLegalPlatformResult, hasLegalExternalPlatformResultEvidence } from './result_policy_evidence';
import { type LumiResultFinalizerInput, type LumiResultFinalizerResult } from "./result_finalizer_types";
import { taskActionContract, isInternalRuntimeWorkNarration, resultTaskText, isChineseText, summarizeToolFailure, hasResultCoreActionEvidence, isVerifiedCurrentTurnRecord, recordMatchesCurrentTurnIdentity, requiresSourceGroundedArtifactContent, sanitizeInternalExecutionText } from "./result_finalizer_support";
import { formatGroundedDesktopEvidence, formatGroundedSimpleDesktopOpenResult, formatGroundedClientActionResult, formatGroundedCurrentAuthoringDocumentResult, formatGoalSpecificDesktopResult, formatObservedDesktopOpenResult, formatGroundedPartialActionResult, formatCurrentAuthoringDocumentClarification, formatCreatedArtifactWithoutInAppCompletion } from "./result_desktop_presenter";
import { unsupportedOngoingExecutionClaim, leakedLegacyToolProtocol, unsupportedClientStateVerificationClaim, unsupportedLedgerOnlyWorkTaskCompletion, unsupportedToolModeClaim, unsupportedToolAvailabilityExcuse, groundedVerifiedDocumentObservation, VERIFIED_DOCUMENT_OBSERVATION_TOOL_RE, unsupportedPriorDiagnosticClaim, unsupportedToolExecutionClaim, realWorldClaimKind, isExecutionClaimGuardTurn, isFirstPersonConcreteRealWorldClaim, hasVerifiedEvidenceForRealWorldClaim, unsupportedRealWorldClaim } from "./result_claim_guards";
import { groundedMediaGeneration, formatGroundedWorkflowProgress, formatGroundedSkillDraft, formatGroundedArtifactResult, formatGroundedCadRunResult, formatGroundedBlankAutoCadDocumentResult, formatGroundedWpsMutationResult, formatGroundedCadGeometryExtractionResult, formatExternalAiHistoryResult } from "./result_artifact_presenter";

const TOOL_ITERATION_LIMIT_RESPONSE_RE =
  /The tool loop reached its limit|Maximum tool call iterations reached|before Lumi could write the final answer|\u8fd9\u8f6e\u5de5\u5177(?:\u5904\u7406|\u8c03\u7528)\u6b21\u6570(?:\u5df2)?(?:\u5230\u8fbe|\u8fbe\u5230|\u5230)\u4e0a\u9650/iu;

function parseRuntimeWorkReceipt(record: ToolExecutionRecord): Record<string, any> | null {
  if (!toolRecordSucceeded(record)) return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (!payload || payload.ok !== true) return null;
  return payload;
}

/**
 * Runtime-work status is a read-only control lane, but it is also the source
 * of truth for the adjacent cleanup offer. If the model returns an empty
 * body (or an internal planning sentence), do not persist a blank assistant
 * turn: render the verified snapshot and, when cancellable work exists, make
 * the offer explicit so the next short user confirmation can be bound to the
 * exact frozen task ids.
 */
function formatGroundedRuntimeWorkResult(
  input: LumiResultFinalizerInput,
  contract: ReturnType<typeof taskActionContract>,
): LumiResultFinalizerResult | null {
  if (contract.label === 'Current Lumi runtime diagnostic') return null;
  const runtimeRecord = [...(input.toolRecords || [])].reverse().find(item => (
    item.name === 'runtime_work_cancel' || item.name === 'runtime_work_status'
  ));
  // A short natural-language command such as “清理这些后台任务” may not
  // satisfy the generic intent classifier, but a verified runtime receipt is
  // still authoritative and must never be rendered as an empty turn.
  if (contract.kind !== 'task_control' && !runtimeRecord) return null;
  const cancelling = runtimeRecord?.name === 'runtime_work_cancel'
    || contract.preferredTools.includes('runtime_work_cancel');
  const record = runtimeRecord && (
    runtimeRecord.name === (cancelling ? 'runtime_work_cancel' : 'runtime_work_status')
  ) ? runtimeRecord : null;
  if (!record) return null;
  const payload = parseRuntimeWorkReceipt(record);
  if (!payload) return null;
  const modelText = String(input.responseText || '').trim();

  if (cancelling) {
    // A truthful non-empty model sentence is acceptable. Empty/internal
    // transport output is replaced with the canonical receipt projection.
    if (!isInternalRuntimeWorkNarration(modelText)) return null;
    const text = formatRuntimeCleanupReceipt(resultTaskText(input), payload);
    return {
      text: text || (isChineseText(resultTaskText(input))
        ? CN_VOICE_QUICK_WORK_MESSAGES.runtimeCancellationResultMissing
        : 'No runtime cancellation result was returned.'),
      blocked: false,
      reason: 'Grounded runtime work cancellation receipt.',
    };
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const cancellableItems = items.filter((item: any) => item?.controls?.canCancel === true);
  const activeCount = Number(payload.activeCount);
  const count = Number.isFinite(activeCount) ? Math.max(0, activeCount) : items.length;
  const chinese = isChineseText(resultTaskText(input));
  const noWork = String(payload.status || '') === 'idle' || count === 0;
  if (noWork) {
    if (!isInternalRuntimeWorkNarration(modelText)) return null;
    return {
      text: chinese ? CN_VOICE_QUICK_WORK_MESSAGES.noActiveWork : 'There is no active Lumi work right now.',
      blocked: false,
      reason: 'Grounded runtime work status receipt.',
    };
  }

  const titles = items.slice(0, 3)
    .map((item: any) => String(item?.title || item?.id || '').trim())
    .filter(Boolean);
  const summary = chinese
    ? CN_VOICE_QUICK_WORK_MESSAGES.activeWork(count, titles)
    : `There are ${count} active Lumi work item${count === 1 ? '' : 's'}${titles.length ? `: ${titles.join(', ')}` : '.'}`;
  // The offer must be adjacent to this assistant turn. Append it even when a
  // model supplied a factual status sentence without a question; otherwise a
  // following “清理一下” has no safe immutable target set to adopt.
  if (cancellableItems.length > 0) {
    if (isExplicitRuntimeCleanupProposal(modelText)) return null;
    if (!isInternalRuntimeWorkNarration(modelText)) {
      return {
        text: chinese
          ? CN_VOICE_QUICK_WORK_MESSAGES.runtimeStatusWithOffer(modelText)
          : `${modelText}\nWould you like me to clear those background tasks?`,
        blocked: false,
        reason: 'Grounded runtime work status receipt with cleanup offer.',
      };
    }
    return {
      text: chinese
        ? CN_VOICE_QUICK_WORK_MESSAGES.runtimeCleanupOffer(cancellableItems.length)
        : `There are ${cancellableItems.length} cancellable background task${cancellableItems.length === 1 ? '' : 's'}. Would you like me to clear them?`,
      blocked: false,
      reason: 'Grounded runtime work status receipt with cleanup offer.',
    };
  }
  if (!isInternalRuntimeWorkNarration(modelText)) return null;
  return {
    text: summary,
    blocked: false,
    reason: 'Grounded runtime work status receipt.',
  };
}

function shouldUseCompactActionBlockedResponse(input: LumiResultFinalizerInput): boolean {
  const records = input.toolRecords || [];
  const actionText = resultTaskText(input);
  const contract = taskActionContract(input);
  if (shouldEnforceCoreActionContract(contract, actionText)) return true;
  const hasDesktopOrMessagingTool = records.some(record =>
    /^(desktop_|wechat_(?:send_message|send_file|read_recent_chat)|computer_use|keyboard_|mouse_|cursor_|get_active_window_info|capture_screen|ocr_screen)/i.test(String(record.name || ''))
  );
  if (!hasDesktopOrMessagingTool) return false;
  const text = `${actionText}\n${input.responseText}`;
  return /wechat|weixin|\u5fae\u4fe1|\u53d1\u9001|\u53d1\u7ed9|\u665a\u5b89|\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u6700\u540e\u4e00\u6b65/i.test(text);
}

function shouldEnforceCoreActionContract(contract: ReturnType<typeof buildActionContract>, text: string): boolean {
  if (!contract.applies) return false;
  if (['messaging_read', 'messaging_send', 'browser_account', 'public_post', 'cad_drafting', 'customer_operations', 'ecommerce_operations', 'design_delivery', 'stock_monitor', 'task_control', 'desktop_operation', 'artifact_work'].includes(contract.kind)) {
    return true;
  }
  if (contract.kind === 'legal_document') {
    return /\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|pleading/i.test(text);
  }
  return false;
}

function formatCompactBlockedResponse(input: LumiResultFinalizerInput, reason?: string): string {
  const zh = isChineseText(resultTaskText(input)) || isChineseText(input.responseText);
  const failure = summarizeToolFailure(input.toolRecords || []);
  const contract = taskActionContract(input);
  const contractBlocker = zh && contract.kind === 'messaging_send'
    ? formatCnMessagingContractBlocker(failure)
    : summarizeActionContractBlocker(contract, failure);
  if (/External legal platform final action/i.test(reason || '')) {
    return zh
      ? [
          '\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5168\u81ea\u52a8\u5b8c\u6210\u3002',
          '\u6cd5\u9662\u7acb\u6848\u7f51\u3001\u6cd5\u8749\u3001Alpha\u3001\u88c1\u5224\u6587\u4e66\u7f51\u3001\u4f01\u67e5\u67e5\u7b49\u53d7\u8d26\u53f7\u3001\u9a8c\u8bc1\u7801\u3001\u4ed8\u8d39\u548c\u98ce\u63a7\u5f71\u54cd\uff1bLumi \u53ea\u80fd\u505a\u6388\u6743\u534f\u4f5c\u3001\u7ed3\u679c\u5f52\u6863\u548c\u4ea4\u4ed8\u524d\u6838\u9a8c\u3002',
          '\u63d0\u4ea4\u3001\u7b7e\u540d\u3001\u7f34\u8d39\u3001\u786e\u8ba4\u9001\u8fbe\u3001\u64a4\u56de\u6216\u548c\u89e3\u627f\u8bfa\u5fc5\u987b\u7531\u5f8b\u5e08\u6216\u5f53\u4e8b\u4eba\u786e\u8ba4\u3002',
        ].join('\n')
      : [
          'External legal platforms cannot be marked as fully automated completion.',
          'Court filing portals, Fachan, Alpha, China Judgments Online, Qichacha, and similar systems depend on accounts, captcha/2FA, payment, and platform risk controls. Lumi can do authorized collaboration, result archiving, and pre-delivery verification.',
          'Submission, signature, payment, service confirmation, withdrawal, or settlement commitment requires lawyer or party confirmation.',
        ].join('\n');
  }
  if (/Missing external legal platform result evidence/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd8\u4e0d\u80fd\u8bf4\u5df2\u7ecf\u5b8c\u6210\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u67e5\u8be2\u6216\u68c0\u7d22\u7ed3\u679c\u3002',
          '\u9700\u8981\u6709\u6388\u6743\u767b\u5f55\u4f1a\u8bdd\u3001\u5b98\u65b9 API \u8fd4\u56de\u3001\u7f51\u9875\u53ef\u89c1\u7ed3\u679c\u3001\u6765\u6e90\u767b\u8bb0\u6216\u5165\u6848\u5f52\u6863\u8bb0\u5f55\u3002',
          '\u76ee\u524d\u53ea\u80fd\u8bf4\u662f\u6388\u6743\u534f\u4f5c\u6216\u68c0\u7d22\u4ea4\u63a5\uff0c\u4e0d\u80fd\u5047\u88c5\u5df2\u7ecf\u67e5\u5230\u771f\u5b9e\u5e73\u53f0\u7ed3\u679c\u3002',
        ].join('\n')
      : [
          'I cannot say the external legal-platform search is complete yet.',
          'I need authorized session/API output, visible webpage results, source registration, or case-archive evidence.',
          'Until then, this is an authorized handoff, not a verified platform result.',
        ].join('\n');
  }
  if (contract.kind === 'legal_document' && /reasoning chain|triad|\u4e09\u6bb5\u8bba/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd9\u4efd\u6cd5\u5f8b\u6210\u679c\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u6216\u6b63\u5f0f\u53ef\u7528\u3002',
          '\u7f3a\u5c11\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe\uff1a\u9700\u8981 legal_case_reasoning_matrix\uff0c\u6216\u6587\u4e66/\u4ea4\u4ed8\u5305\u4e2d\u80fd\u770b\u5230\u6cd5\u5f8b\u4f9d\u636e\u3001\u4e8b\u5b9e\u8bc1\u636e\u3001\u6db5\u6444/\u9002\u7528\u7ed3\u8bba\u7684\u53ef\u9a8c\u6536\u8bb0\u5f55\u3002',
          '\u6b63\u5f0f\u6587\u4e66\u5fc5\u987b\u80fd\u4ece\u5927\u524d\u63d0\u3001\u5c0f\u524d\u63d0\u5230\u7ed3\u8bba\u9010\u6b65\u590d\u6838\u3002',
        ].join('\n')
      : [
          'This legal work product cannot be marked complete or formally usable yet.',
          'Missing legal reasoning chain: run legal_case_reasoning_matrix, or provide product evidence showing legal authority, facts/evidence, and application/conclusion.',
          'Formal legal documents must be reviewable from rule, to facts, to conclusion.',
        ].join('\n');
  }
  if (contract.kind === 'legal_document' && /current-law|current law|\u73b0\u884c\u6709\u6548/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd9\u4efd\u6cd5\u5f8b\u6587\u4e66\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u6216\u6b63\u5f0f\u53ef\u7528\u3002',
          '\u7f3a\u5c11\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\uff1a\u9700\u8981\u8fd0\u884c legal_generate_citation_verification_report \u6216 legal_finalize_delivery_package\uff0c\u5e76\u786e\u8ba4\u6ca1\u6709\u5df2\u5e9f\u6b62\u3001\u5931\u6548\u6216\u672a\u786e\u8ba4\u7684\u6cd5\u6761\u5f15\u7528\u3002',
          '\u6211\u4e0d\u4f1a\u628a\u672a\u6838\u9a8c\u7684\u6cd5\u5f8b\u6587\u4e66\u8bf4\u6210\u6b63\u5f0f\u6210\u679c\u3002',
        ].join('\n')
      : [
          'This legal document cannot be marked complete or formally usable yet.',
          'Missing current-law verification: run legal_generate_citation_verification_report or legal_finalize_delivery_package and confirm there are no repealed, invalid, or unverified statute citations.',
          'I will not present an unverified legal document as a formal result.',
        ].join('\n');
  }
  if (contract.kind === 'legal_document' && /production evidence|document production/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd9\u4efd\u6cd5\u5f8b\u6587\u4e66\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
          '\u7f3a\u5c11\u5b9e\u9645\u6587\u4e66\u4ea7\u7269\u8bc1\u636e\uff1a\u9700\u8981\u5148\u751f\u6210\u6216\u5199\u5165\u8d77\u8bc9\u72b6\u3001\u7b54\u8fa9\u72b6\u3001\u4ee3\u7406\u8bcd\u3001\u6cd5\u5f8b\u610f\u89c1\u4e66\u3001\u5408\u540c\u6216\u6807\u4e66\u7b49\u5b9e\u9645\u8349\u7a3f\uff0c\u518d\u8fdb\u884c\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\u3002',
        ].join('\n')
      : [
          'This legal document cannot be marked complete yet.',
          'Missing legal document production evidence: generate or write the actual draft first, then run the current-law verification gate.',
        ].join('\n');
  }
  if (shouldUseCompactActionBlockedResponse(input)) {
    const safeFailure = failure && !/(?:[A-Za-z]:[\\/]|\b(?:sha(?:1|256)?|hash|taskId|requestId|receipt|tool)\b|[_-](?:receipt|task|request)|\{[\s\S]*\})/iu.test(failure)
      ? failure.replace(/[\u3002.!?]+$/u, '')
      : '';
    if (zh) {
      if (contract.kind === 'messaging_read') {
        return CN_EXECUTION_EVIDENCE_MESSAGES.compactMessagingReadNotCompleted;
      }
      const detail = contractBlocker || (safeFailure ? `${safeFailure}\u3002` : CN_EXECUTION_EVIDENCE_MESSAGES.compactUnconfirmedFinalResult);
      return CN_EXECUTION_EVIDENCE_MESSAGES.compactNotCompleted(detail);
    }
    const hasSuccessfulEvidence = (input.toolRecords || []).some(record => (
      !record.error && String(record.result || '').trim().length > 0
    ));
    if (safeFailure) return `This did not finish. ${safeFailure}.`;
    return hasSuccessfulEvidence
      ? 'I could not complete the requested action because the available result does not confirm it.'
      : 'I could not complete the requested action because it never reached a successful execution.';
  }

  return zh
    ? CN_EXECUTION_EVIDENCE_MESSAGES.compactNotCompleted(
        contractBlocker || CN_EXECUTION_EVIDENCE_MESSAGES.compactUnconfirmedFinalResult,
      )
    : 'This did not finish, and the final result is not confirmed yet.';
}

function operationModeFromLabel(label: string): LumiClientMode | null {
  const normalized = String(label || '').trim().toLowerCase();
  if (/^(?:\u804a\u5929|\u5bf9\u8bdd|chat|conversation)$/.test(normalized)) return 'chat';
  if (/^(?:\u52a9\u624b|\u52a9\u7406|assistant)$/.test(normalized)) return 'assistant';
  if (/^(?:\u81ea\u4e3b|autonomous)$/.test(normalized)) return 'autonomous';
  if (/^(?:\u4f1a\u8bae|meeting)$/.test(normalized)) return 'meeting';
  return null;
}

function sanitizeContradictoryOperationModeText(input: LumiResultFinalizerInput): string {
  // When this turn requests a mode change, the client_action receipt remains
  // authoritative. Otherwise effectiveOperationMode is the actual persisted
  // mode supplied by the client and can safely reject a contradictory claim.
  const knownMode = input.flow?.requestedMode ? null : input.flow?.effectiveOperationMode;
  const raw = String(input.responseText || '').trim();
  if (!knownMode || !raw) return raw;
  const currentModeClaim = /(?:\u6211|Lumi)?(?:\u5f53\u524d|\u73b0\u5728|\u76ee\u524d|\u6b63\u5904\u4e8e|\u5904\u4e8e|\u662f)\s*(\u804a\u5929|\u5bf9\u8bdd|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae|chat|conversation|assistant|autonomous|meeting)(?:\u6a21\u5f0f)?/iu;
  const switchPrerequisite = /(?:\u9700\u8981|\u5fc5\u987b|\u5f97|need\s+to|must)\s*(?:\u5148)?(?:\u5207\u6362|\u5207\u5230|\u8fdb\u5165|switch)\s*(?:\u5230|to)?\s*(\u804a\u5929|\u5bf9\u8bdd|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae|chat|conversation|assistant|autonomous|meeting)(?:\u6a21\u5f0f)?/iu;
  // Keep every separator: this filter removes contradictory claims, not
  // Markdown structure. Omitting newline matches flattened even answers that
  // contained no mode claim into one paragraph (including table rows).
  const segments = raw.match(/[^\u3002\uff01\uff1f.!?\r\n]+[\u3002\uff01\uff1f.!?]*|[\u3002\uff01\uff1f.!?\r\n]+/gu) || [raw];
  const kept = segments.filter(segment => {
    const current = segment.match(currentModeClaim);
    if (current && operationModeFromLabel(current[1]) !== knownMode) return false;
    const prerequisite = segment.match(switchPrerequisite);
    if (prerequisite && operationModeFromLabel(prerequisite[1]) === knownMode) return false;
    return true;
  });
  if (kept.length === segments.length) return raw;
  const cleaned = kept.join('').trim();
  if (cleaned) return cleaned;
  return isChineseText(raw)
    ? CN_VOICE_FAST_PATH_MESSAGES.operationModeStatus(knownMode)
    : `The current mode is ${knownMode}.`;
}

function correctCurrentTurnContractDrift(
  input: LumiResultFinalizerInput,
  taskContract: ReturnType<typeof buildActionContract>,
): string | null {
  const actionText = resultTaskText(input);
  if (!taskContract.applies || taskContract.kind !== 'desktop_operation') return null;
  const responseContract = buildActionContract(input.responseText);
  if (!responseContract.applies || responseContract.kind === taskContract.kind) return null;
  if (hasResultCoreActionEvidence(input, responseContract, input.toolRecords || [], input.responseText)) return null;
  if (!hasResultCoreActionEvidence(input, taskContract, input.toolRecords || [], actionText)) return null;

  const requestedTarget = extractSimpleDesktopOpenTarget(actionText);
  const successfulOpen = [...(input.toolRecords || [])].reverse().find(record => (
    /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || ''))
    && !record.error
    && String(record.result || '').trim()
  ));
  if (requestedTarget && successfulOpen) {
    return isChineseText(actionText)
      ? CN_VOICE_FAST_PATH_MESSAGES.opened(requestedTarget)
      : `Opened ${requestedTarget}.`;
  }

  const grounded = formatGroundedDesktopEvidence(input);
  if (grounded) {
    console.warn(`[ResultFinalizer] Corrected current-turn contract drift: task=${taskContract.kind}, response=${responseContract.kind}`);
  }
  return grounded;
}

function sanitizeUnsupportedRestatementAdditions(taskText: string, responseText: string, toolRecords: ToolExecutionRecord[]): string {
  if (toolRecords.length > 0) return responseText;
  if (!/(?:只|仅)?(?:复述|重复|完整说出|原样说出)|其他不变|只(?:说|保留|复述)事实/u.test(taskText)) return responseText;
  const unsupportedClaim = /(?:写|放|记)(?:进|到|在).{0,8}(?:日程|计划|任务)|(?:已经|已|我)?\s*(?:记下|记录|保存)(?:了|好)?|(?:到时|到时候|出发前|之后).{0,16}(?:提醒|通知)|(?:创建|新建|安排).{0,8}(?:任务|提醒|日程)/u;
  const explicitInTask = unsupportedClaim.test(taskText);
  if (explicitInTask || !unsupportedClaim.test(responseText)) return responseText;
  const clauses = String(responseText || '').match(/[^。！？!?\r\n]+[。！？!?]?|[\r\n]+/gu) || [];
  const retained = clauses.filter(clause => !unsupportedClaim.test(clause)).join('').trim();
  return retained || responseText;
}

/**
 * Receipt formatters validate execution truth; they do not author ordinary
 * main-chat prose. Keep a non-empty model answer after a grounded successful
 * check, while retaining formatter text for empty transport output and for
 * blocked safety/evidence outcomes.
 */
function normalizeEvidenceWording(value: string): string {
  const compact: string[] = [];
  for (const character of String(value || '').normalize('NFKC')) {
    const codePoint = character.codePointAt(0) || 0;
    const asciiAlphaNumeric = (
      (codePoint >= 48 && codePoint <= 57)
      || (codePoint >= 65 && codePoint <= 90)
      || (codePoint >= 97 && codePoint <= 122)
    );
    const unicodeWord = (
      (codePoint >= 0x3400 && codePoint <= 0x9fff)
      || (codePoint >= 0x3040 && codePoint <= 0x30ff)
      || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    );
    if (asciiAlphaNumeric || unicodeWord) compact.push(character.toLocaleLowerCase());
  }
  return compact.join('');
}

function evidenceBigrams(value: string): Set<string> {
  const normalized = normalizeEvidenceWording(value);
  if (!normalized) return new Set();
  if (normalized.length === 1) return new Set([normalized]);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => (
    normalized.slice(index, index + 2)
  )));
}

function evidenceIdentifiers(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length >= 2) tokens.push(current.slice(0, 128));
    current = '';
  };
  for (const character of String(value || '')) {
    const codePoint = character.codePointAt(0) || 0;
    const asciiLetter = (
      (codePoint >= 65 && codePoint <= 90)
      || (codePoint >= 97 && codePoint <= 122)
    );
    const asciiDigit = codePoint >= 48 && codePoint <= 57;
    const separator = '_.:/\\=-'.includes(character);
    if (!current && asciiLetter) {
      current = character;
    } else if (current && (asciiLetter || asciiDigit || separator)) {
      current += character;
    } else {
      flush();
    }
  }
  flush();

  const stableTokens = tokens.filter(token => {
    let hasStructure = false;
    let hasLetter = false;
    let allLettersUppercase = true;
    let previousWasLowercase = false;
    for (const character of token) {
      const codePoint = character.codePointAt(0) || 0;
      const uppercase = codePoint >= 65 && codePoint <= 90;
      const lowercase = codePoint >= 97 && codePoint <= 122;
      const digit = codePoint >= 48 && codePoint <= 57;
      if (uppercase || lowercase) hasLetter = true;
      if (lowercase) allLettersUppercase = false;
      if (digit || '_.:/\\=-'.includes(character)) hasStructure = true;
      if (previousWasLowercase && uppercase) hasStructure = true;
      previousWasLowercase = lowercase;
    }
    return hasStructure || (token.length >= 3 && hasLetter && allLettersUppercase);
  });
  return Array.from(new Set(stableTokens.map(token => token.toLocaleLowerCase())));
}

function modelWordingMatchesGroundedEvidence(
  input: LumiResultFinalizerInput,
  modelText: string,
  groundedText: string,
): boolean {
  const normalizedModel = normalizeEvidenceWording(modelText);
  if (!normalizedModel) return false;
  const groundedIdentifiers = new Set(evidenceIdentifiers(groundedText));
  const taskIdentifiers = new Set(evidenceIdentifiers(resultTaskText(input)));
  const supportedIdentifiers = new Set([...groundedIdentifiers, ...taskIdentifiers]);
  const missingRequestedIdentifier = Array.from(taskIdentifiers).some(identifier => (
    groundedIdentifiers.has(identifier)
    && !normalizedModel.includes(normalizeEvidenceWording(identifier))
  ));
  if (missingRequestedIdentifier) return false;
  const unsupportedIdentifier = evidenceIdentifiers(modelText).some(identifier => (
    !supportedIdentifiers.has(identifier)
  ));
  if (unsupportedIdentifier) return false;
  const modelBigrams = evidenceBigrams(modelText);
  const groundedBigrams = evidenceBigrams(groundedText);
  if (!modelBigrams.size || !groundedBigrams.size) return false;
  let overlap = 0;
  for (const token of modelBigrams) {
    if (groundedBigrams.has(token)) overlap += 1;
  }
  return overlap / Math.min(modelBigrams.size, groundedBigrams.size) >= 0.2;
}

function formatStructuredEvidenceCorrection(
  input: LumiResultFinalizerInput,
  grounded: LumiResultFinalizerResult,
): LumiResultFinalizerResult {
  const receiptStates = (input.toolRecords || []).map(record => (
    record.envelope?.status
    || record.terminalVerification?.status
    || (record.error ? 'failed' : 'recorded')
  ));
  return {
    ...grounded,
    reason: [
      grounded.reason || '',
      `Structured evidence correction (${receiptStates.join(',') || 'grounder'}).`,
    ].filter(Boolean).join(' '),
  };
}

function preserveModelWordingOnGroundedSuccess(
  input: LumiResultFinalizerInput,
  grounded: LumiResultFinalizerResult,
): LumiResultFinalizerResult {
  // Specific programme/season/episode claims come only from the target bound
  // to the verified progress samples, never an embellished model tail.
  if (grounded.reason === 'verified_playback_progress') return grounded;
  // The requested contents are part of delivery. A generic acknowledgement
  // or file path cannot replace the actual verified readback body.
  if (grounded.reason === 'Grounded artifact completion with delivered same-path readback content.') return grounded;
  const modelText = String(input.responseText || '').trim();
  // Grounders reach this helper only after their structured receipt contract
  // has accepted the current outcome. Compatibility uses a domain-neutral
  // evidence fingerprint (stable identifiers plus text overlap), never a
  // tool/phrase-specific reply patch. A failed or conflicting outcome stays on
  // the structured correction path.
  if (input.source !== 'chat' || grounded.blocked || !modelText) return grounded;
  // Completion truth comes from the grounded receipt contract. A stray model
  // tail such as "executing now" is a presentation defect, not grounds for
  // turning an actually completed durable task back into a blocked one.
  if (unsupportedOngoingExecutionClaim(input, true)) {
    return formatStructuredEvidenceCorrection(input, grounded);
  }
  if (
    claimsCurrentAppSaveCompletion(modelText)
    && !hasCurrentAppSaveEvidence(input.toolRecords || [], resultTaskText(input))
  ) {
    return formatStructuredEvidenceCorrection(input, grounded);
  }
  // i18n-allow -- Chinese grounded-open contradiction recognition; not user-visible copy.
  const groundedOpenSuccess = /(?:已打开|已启动)|\b(?:opened|launched)\b/iu.test(grounded.text);
  // i18n-allow -- Chinese grounded-open contradiction recognition; not user-visible copy.
  const modelDeniesOpen = /(?:没有|没能|未|并未|无法)[^。！？.!?\n]{0,24}(?:打开|启动|运行)|\b(?:did\s+not|didn't|was\s+not|wasn't|could\s+not|couldn't|failed\s+to)\b[^.!?\n]{0,32}\b(?:open|launch|start|run)/iu.test(modelText);
  if (groundedOpenSuccess && modelDeniesOpen) {
    return formatStructuredEvidenceCorrection(input, grounded);
  }
  if (!modelWordingMatchesGroundedEvidence(input, modelText, grounded.text)) {
    return formatStructuredEvidenceCorrection(input, grounded);
  }
  return {
    ...grounded,
    text: formatVerifiedTaskResultForReadability(input.responseText),
  };
}

/**
 * An exact local text write or simple application launch can finish from its
 * verified receipt. This is deliberately not a generic "one tool succeeded"
 * shortcut: reading source data still needs the requested analysis/answer.
 */
function groundedReadOnlyWindowObservation(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const task = resultTaskText(input);
  if (!hasExplicitNoMutationInstruction(task) || !hasVisionIntent(task) || taskActionContract(input).applies) return null;
  // Only a bounded request to report visible facts can end at OCR. Analysis,
  // calculations and other deliverables still need their own completion.
  // i18n-allow: Explicit observation-only request scope, not output copy.
  if (!/(?:只|仅)(?:需|要)?(?:查看|观察|看|读取)|\b(?:only|just)\s+(?:inspect|observe|read|look)\b/iu.test(task)
    || /(?:计算|汇总|分析|总结|翻译|比较)|\b(?:calculate|summari[sz]e|analy[sz]e|translate|compare)\b/iu.test(task)) return null; // i18n-allow: Additional work beyond visible observation.
  const record = [...(input.toolRecords || [])].reverse().find(record =>
    record.name === 'ocr_screen' && isVerifiedCurrentTurnRecord(input, record));
  if (!record) return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (payload?.status !== 'observed' || !String(payload.description || '').trim()) return null;
  return { text: String(payload.description), blocked: false, reason: 'verified_readonly_window_observation' };
}

function groundedModelIdentity(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  if (!isModelConfigurationReadRequest(resultTaskText(input))) return null;
  const record = (input.toolRecords || []).slice().reverse().find(row => row.name === 'model_configuration_get' && isVerifiedCurrentTurnRecord(input, row));
  if (!record) return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (!payload) return null;
  const active = payload.activeCall?.requestId === input.requestId ? payload.activeCall : null;
  const configuration = payload.role === 'reasoning' ? payload.configuration : payload.roles?.reasoning;
  const selected = active || configuration;
  const model = String(selected?.model || '').trim();
  const provider = String(selected?.provider || '').trim();
  if (!model || !/^[\w./ :+-]{1,200}$/.test(model) || !/^[\w.-]{1,60}$/.test(provider)) return null;
  const zh = isChineseText(resultTaskText(input));
  return { text: zh ? CN_EXECUTION_EVIDENCE_MESSAGES.groundedModelIdentity(model, provider, Boolean(active))
    : `${active ? 'This reply uses' : 'The configured primary chat model is'} ${model} (${provider === 'relay' ? 'Lumi Official API' : provider}).`,
    blocked: false, reason: 'Model identity grounded in the current configuration-read receipt.' };
}

function groundedBusinessAnalysis(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  if (!input.taskId || !input.requestId) return null;
  const task = resultTaskText(input);
  const contract = taskActionContract(input);
  if (contract.kind !== 'ecommerce_operations' || contract.components?.length) return null;
  // Persisted inline analysis is not proof that a requested file was created.
  if (/\.(?:xlsx?|pdf|docx?|csv)\b|\b(?:Excel|PDF|Word)\b|(?:导出|生成|制作).{0,12}(?:文件|表格|报表)/iu.test(task)) return null; // i18n-allow: extra artifact obligations.
  const records = (input.toolRecords || []).filter(record => isVerifiedCurrentTurnRecord(input, record));
  if (!hasCoreActionEvidence(contract, records, task)) return null;
  const record = [...records].reverse().find(record => /^industry_ecommerce_(?:today_snapshot|store_data_snapshot|listing_action_queue|customer_service_drafts)$/u.test(record.name));
  if (!record) return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (payload?.ok !== true || payload.status !== 'verified' || payload.persisted !== true || payload.sourceBound !== true || payload.externalMutation !== false
    || payload.conversationTaskId !== input.taskId || !String(payload.message || '').trim()) return null;
  return { text: String(payload.message), blocked: false, reason: 'verified_source_bound_business_analysis' };
}

export function tryFinalizeVerifiedBoundedAction(
  input: LumiResultFinalizerInput,
  acceptedTaskTarget?: LumiTurnFlow['acceptedTaskTarget'],
): LumiResultFinalizerResult | null {
  if (!input.requestId || !input.taskId) return null;
  const task = resultTaskText(input);
  const records = coalesceToolExecutionRecords(input.toolRecords || [])
    .filter(record => recordMatchesCurrentTurnIdentity(input, record));
  const scopedInput = { ...input, toolRecords: records, responseText: '' };
  const business = groundedBusinessAnalysis(scopedInput);
  if (business) return business;
  const windowObservation = groundedReadOnlyWindowObservation(scopedInput);
  if (windowObservation) return windowObservation;
  const sessionObservation = browserSessionObservation(records, task);
  if (sessionObservation) return { text: sessionObservation, blocked: false, reason: 'verified_browser_session_inspection' };
  const cliStatus = verifiedExternalCliStatus(task, records, input);
  if (cliStatus) return { text: formatExternalCliStatus(task, cliStatus), blocked: false, reason: 'verified_external_cli_status' };
  // The same verified-media projection owns both loop termination and channel
  // delivery. A complete generation needs no second model call; compound
  // publication/delivery tasks and missing artifacts still fail this check.
  const media = groundedMediaGeneration(scopedInput);
  if (media) return media;
  const modelIdentity = groundedModelIdentity(scopedInput);
  if (modelIdentity) return modelIdentity;
  const workflow = formatGroundedWorkflowProgress(scopedInput);
  if (workflow && ['workflow_completed', 'workflow_incomplete'].includes(workflow.reason || '')) return workflow;
  const contract = taskActionContract(scopedInput);
  if (!hasCoreActionEvidence(contract, records, task, undefined, {
    requestId: input.requestId, taskId: input.taskId,
  }, input.flow?.acceptedTaskTarget || acceptedTaskTarget)) return null;
  if (findDesktopCompletionReview(records, { requestId: input.requestId, taskId: input.taskId })) return null;
  if (contract.kind === 'desktop_operation' && extractSimpleDesktopOpenTarget(task)) {
    if (!records.some(record => /^(?:desktop_open|browser_open_task)$/u.test(record.name)
      && isVerifiedCurrentTurnRecord(scopedInput, record))) return null;
    const result = formatGroundedSimpleDesktopOpenResult(scopedInput);
    return result && !result.blocked ? result : null;
  }
  if (contract.kind === 'skill_authoring') return formatGroundedSkillDraft(scopedInput);
  if (contract.kind !== 'artifact_work') return null;
  // Structured spreadsheet writers persist real formulas/charts and return
  // computed cells. Once the shared contract verifies every required step,
  // deliver those facts rather than asking an optional text-file checker to
  // approve spreadsheet semantics it cannot inspect.
  const structuredDelivery = resolveArtifactDelivery(records, record => isVerifiedCurrentTurnRecord(scopedInput, record));
  const computed = structuredDelivery && parseReceiptObject(toolRecordTerminalPayload(structuredDelivery.producer))?.calculatedCells;
  const taskInstruction = withoutLocationLiterals(task);
  const additionalWork = /(?:运行|发送|发布|上传|分析|总结|解释|对比|比较|翻译|删除|移动|复制|重命名|安装|提醒|另外|还要|分别)|\b(?:run|send|publish|upload|analy[sz]\w*|summari[sz]\w*|explain|compare|translate|delete|move|copy|rename|install|remind|another|each)\b/iu.test(taskInstruction); // i18n-allow: additional semantic/action obligations.
  if (structuredDelivery && /\.xlsx$/iu.test(structuredDelivery.outputPath)
    && Array.isArray(computed) && computed.length > 0 && !additionalWork) {
    const result = formatGroundedArtifactResult(scopedInput);
    if (result && !result.blocked) return result;
  }
  // The tool loop and channel delivery consume the same producer/readback
  // projection. An artifact's mere existence is not a second completion rule.
  if (requiresArtifactPostWriteReadback(task)) {
    const delivery = resolveArtifactDelivery(records, record => isVerifiedCurrentTurnRecord(scopedInput, record));
    // Compound tasks and additional analysis still need their own outcome.
    // i18n-allow: outstanding user action recognition, not user-facing copy.
    // Requested opening is already checked by the shared action contract.
    // Merely seeing "open" (including "do not open") cannot create another
    // obligation after the current saved/read version is fully verified.
    const extraAction = additionalWork;
    if (delivery?.readback && !extraAction) {
      const result = formatGroundedArtifactResult(scopedInput);
      if (result && !result.blocked) return result;
    }
    return null;
  }
  if (!extractExplicitArtifactTextRequirements(task).length) return null;
  if (requiresSourceGroundedArtifactContent(task)) return null;
  const instruction = extractExplicitArtifactTextRequirements(task)
    .reduce((text, payload) => text.split(payload).join(''), task);
  // Only exact local text production and its requested readback are bounded.
  // A later open, calculation, delivery, or other mutation still needs its own result.
  // i18n-allow: compound action recognition, not user-facing copy.
  if (/(?:打开|启动|运行|发送|发布|上传|计算|分析|汇总|总结|翻译|删除|移动|复制|重命名|另存|导出|安装|提醒)|\b(?:open|launch|run|send|publish|upload|calculat\w*|analy[sz]\w*|summari[sz]\w*|translate|delete|move|copy|rename|export|install|remind)\b/iu.test(instruction)) return null;
  const writes = records.filter(record => /^(?:write_file|desktop_write_text_file)$/u.test(record.name)
    && isVerifiedCurrentTurnRecord(scopedInput, record));
  if (writes.length !== 1) return null;
  const requestedPath = buildTaskTargetAnchorProjection({
    taskText: task,
    previousTarget: (input.flow?.acceptedTaskTarget || acceptedTaskTarget)?.target,
  }).target.path;
  const normalizePath = (value: string) => /^[a-z]:[\\/]|^\\\\/iu.test(value)
    ? value.replace(/\\/gu, '/').toLowerCase() : value.replace(/\\/gu, '/');
  if (!requestedPath || normalizePath(requestedPath) !== normalizePath(artifactPathFromRecord(writes[0]))) return null;
  const result = formatGroundedArtifactResult(scopedInput);
  return result && !result.blocked ? result : null;
}

export function finalizeLumiResponse(input: LumiResultFinalizerInput): LumiResultFinalizerResult {
  input = {
    ...input,
    // Keep this projection local to finalization. Legacy/MCP adapters may put
    // their only machine result in `receipt`; downstream completion guards and
    // grounded formatters historically read `result`. A verified receipt must
    // not become a failure merely because the display-result string is empty.
    toolRecords: coalesceToolExecutionRecords((input.toolRecords || []).filter(record => recordMatchesCurrentTurnIdentity(input, record))).map(record => (
      String(record.result || '').trim()
        ? record
        : { ...record, result: toolRecordTerminalText(record) }
    )),
  };
  const actionText = resultTaskText(input);
  const missingInput = missingTaskInputResult(actionText,
    (input.toolRecords || []).filter(record => recordMatchesCurrentTurnIdentity(input, record)));
  if (missingInput) return missingInput;
  const business = groundedBusinessAnalysis(input);
  if (business) return business;
  const windowObservation = groundedReadOnlyWindowObservation(input);
  if (windowObservation) return windowObservation;
  const actionContract = taskActionContract(input);
  const artifactProgress = actionContract.kind === 'artifact_work'
    ? getArtifactTaskProgress(actionText, input.toolRecords || [], input) : null;
  if (artifactProgress && !artifactProgress.complete) return {
    text: formatArtifactProgress(artifactProgress, actionText), blocked: true,
    reason: `artifact_step_pending:${artifactProgress.next}`,
  };
  if (!artifactProgress && input.completionGuard?.blocked && ['model_failed_before_tool_execution', 'media_generation_failed'].includes(input.completionGuard.reason || '')) {
    return { text: input.completionGuard.text, blocked: true, reason: input.completionGuard.reason };
  }
  const sessionObservation = browserSessionObservation((input.toolRecords || []).filter(record => isVerifiedCurrentTurnRecord(input, record)), actionText);
  if (sessionObservation) return { text: sessionObservation, blocked: false, reason: 'verified_browser_session_inspection' };
  const missingSpreadsheet = missingSpreadsheetRequirements(actionText,
    (input.toolRecords || []).filter(record => recordMatchesCurrentTurnIdentity(input, record)));
  if (missingSpreadsheet.length) return {
    text: isChineseText(actionText) ? CN_EXECUTION_EVIDENCE_MESSAGES.spreadsheetIncomplete(missingSpreadsheet)
      : `The workbook was saved, but these requested features are not verified: ${missingSpreadsheet.join(', ')}. The task is incomplete.`,
    blocked: true, reason: `spreadsheet_requirements_missing:${missingSpreadsheet.join(',')}`,
  };
  if (isMediaPauseRequest(actionText)) {
    const verified = hasMediaPauseEvidence(input.toolRecords || [], actionText, { requestId: input.requestId, taskId: input.taskId });
    const zh = isChineseText(actionText);
    return { text: verified
      ? zh ? CN_EXECUTION_EVIDENCE_MESSAGES.mediaPaused : 'The requested player is confirmed paused.'
      : zh ? CN_EXECUTION_EVIDENCE_MESSAGES.mediaPauseUnconfirmed : 'The requested player is not yet confirmed paused.',
      blocked: !verified, reason: verified ? 'verified_media_pause' : 'media_pause_unconfirmed' };
  }
  const composite = actionContract;
  if (composite.kind === 'external_cli_status') {
    const status = verifiedExternalCliStatus(actionText, input.toolRecords || [], input);
    return status ? { text: formatExternalCliStatus(actionText, status), blocked: false, reason: 'verified_external_cli_status' }
      : { text: isChineseText(actionText) ? CN_EXTERNAL_CLI_MESSAGES.unverified : 'The local CLI status could not be verified.',
        blocked: true, reason: 'Missing verified current-turn external CLI status.' };
  }
  if (composite.components?.length) {
    const outcomes = composite.components.map(component => {
      const verified = hasResultCoreActionEvidence(input, component.contract, input.toolRecords || [], component.text);
      const result = finalizeLumiResponse({ ...input, taskText: component.text, flow: undefined, completionGuard: undefined, responseText: '' });
      const complete = verified && !result.blocked && Boolean(result.text);
      return { complete, text: complete ? result.text
        : isChineseText(actionText) ? CN_EXECUTION_EVIDENCE_MESSAGES.incompleteComponent(component.text) : `Not completed: ${component.text}` };
    });
    return { text: outcomes.map(outcome => outcome.text).join('\n'), blocked: outcomes.some(outcome => !outcome.complete),
      reason: outcomes.every(outcome => outcome.complete) ? 'All requested operations verified.' : 'Some requested operations remain unverified.' };
  }
  const workflowProgress = formatGroundedWorkflowProgress(input);
  if (workflowProgress) return workflowProgress;
  // Lifecycle completion is a receipt verdict, independent of model wording
  // or output redaction. A successful input read cannot complete a failed save.
  if (composite.kind === 'skill_authoring'
    && !hasResultCoreActionEvidence(input, composite, input.toolRecords || [], actionText)) {
    return { text: formatCompactBlockedResponse(input, 'Missing verified skill/workflow lifecycle receipt.'),
      blocked: true, reason: 'Missing verified skill/workflow lifecycle receipt.' };
  }
  if (composite.kind === 'skill_authoring') {
    // The earlier business read is not the target of a draft-save component.
    // A verified save owns this phase even if capture failed before authoring
    // succeeded. Keep those failures in the audit trail, not in its verdict.
    const draft = formatGroundedSkillDraft(input);
    if (draft) return draft;
  }
  const operationModeFacts = buildOperationModeMetaResponse({
    text: actionText,
    operationMode: input.flow?.operationMode,
    source: input.source,
  });
  if (operationModeFacts) {
    return {
      text: operationModeFacts,
      blocked: false,
      reason: 'canonical_operation_mode_facts',
    };
  }
  const protocolLeak = leakedLegacyToolProtocol(input);
  const knowledgeObservation = formatGroundedKnowledgeObservation({
    taskText: actionText,
    toolRecords: input.toolRecords || [],
    taskId: input.taskId,
    requestId: input.requestId,
  });
  if (knowledgeObservation) return { text: knowledgeObservation, blocked: false, reason: 'Grounded current-turn knowledge observation.' };
  const mediaGeneration = groundedMediaGeneration(input);
  if (mediaGeneration) return mediaGeneration;
  const mediaIntent = normalizeActionIntent(actionText);
  const mediaFailures = mediaIntent.kind === 'media_generation'
    ? (input.toolRecords || []).filter(record => record.name === mediaIntent.target && record.error && recordMatchesCurrentTurnIdentity(input, record))
    : [];
  if (mediaFailures.length && !(input.toolRecords || []).some(record => record.name === mediaIntent.target
    && buildMediaArtifactReceipt(record.name, record.arguments, toolRecordTerminalPayload(record), record.error))) {
    // i18n-allow: Receipt-grounded failed-generation result and bounded retry offer.
    const text = isChineseText(actionText)
      ? formatCnMediaGenerationFailure(mediaFailures.map(record => record.error || ''))
      : 'Generation did not complete. A retry must reconcile any unknown prior provider outcome before resubmitting.';
    return { text, blocked: true, reason: 'media_generation_failed' };
  }
  const desktopReview = findDesktopCompletionReview(input.toolRecords || [], { requestId: input.requestId, taskId: input.taskId });
  if (desktopReview
    && !hasMediaPlaybackEvidence(input.toolRecords || [], actionText, { requestId: input.requestId, taskId: input.taskId })) {
    return { text: desktopCompletionReviewText(actionText, desktopReview), blocked: true, reason: DESKTOP_COMPLETION_REVIEW_REASON };
  }
  if (protocolLeak) return protocolLeak;
  const safeResponseText = sanitizeInternalExecutionText(
    input.responseText,
    isChineseText(actionText) || isChineseText(input.responseText),
  );
  const protectedResponseText = sanitizeUserFacingExecutionOutput(safeResponseText, {
    task: actionText,
    toolRecords: input.toolRecords || [],
  });
  if (protectedResponseText !== input.responseText) {
    input = { ...input, responseText: protectedResponseText };
  }
  const factualResponseText = sanitizeUnsupportedRestatementAdditions(actionText, input.responseText, input.toolRecords || []);
  if (factualResponseText !== input.responseText) {
    input = { ...input, responseText: factualResponseText };
  }
  const unsupportedClientVerification = unsupportedClientStateVerificationClaim(input);
  if (unsupportedClientVerification) {
    return {
      text: unsupportedClientVerification,
      blocked: false,
      reason: 'unsupported_client_state_verification_claim_corrected',
    };
  }
  // A CAD workflow receipt owns both its execution truth and its user-facing
  // terminal state. Do not let model narration or a later generic guard hide
  // a verified completion or a concrete workflow blocker.
  const earlyGroundedCadRun = formatGroundedCadRunResult(input);
  if (earlyGroundedCadRun) return preserveModelWordingOnGroundedSuccess(input, earlyGroundedCadRun);
  const unsupportedWorkTaskCompletion = unsupportedLedgerOnlyWorkTaskCompletion(input);
  if (unsupportedWorkTaskCompletion) return unsupportedWorkTaskCompletion;
  const modeSafeResponseText = sanitizeContradictoryOperationModeText(input);
  if (modeSafeResponseText !== input.responseText) {
    input = { ...input, responseText: modeSafeResponseText };
  }
  const unsupportedMode = unsupportedToolModeClaim(input);
  if (unsupportedMode) {
    return {
      text: unsupportedMode,
      blocked: true,
      reason: 'Response claimed a fictional tool-mode switch without a matching receipt.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed a fictional tool-mode switch without a matching receipt.',
      },
    };
  }
  const unsupportedAvailability = unsupportedToolAvailabilityExcuse(input);
  if (unsupportedAvailability) {
    return {
      text: unsupportedAvailability,
      blocked: true,
      reason: 'Response blamed a fictional user-switchable tool availability state without evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response blamed a fictional user-switchable tool availability state without evidence.',
      },
    };
  }
  const groundedClientAction = formatGroundedClientActionResult(input);
  if (groundedClientAction) {
    return preserveModelWordingOnGroundedSuccess(input, {
      text: groundedClientAction,
      blocked: false,
      reason: 'Grounded Lumi client action from a verified state-diff receipt.',
    });
  }
  const groundedRuntimeWork = formatGroundedRuntimeWorkResult(input, actionContract);
  if (groundedRuntimeWork) return groundedRuntimeWork;
  const modelIdentity = groundedModelIdentity(input);
  if (modelIdentity) return modelIdentity;
  const groundedCurrentAuthoringDocument = formatGroundedCurrentAuthoringDocumentResult(input);
  if (groundedCurrentAuthoringDocument) {
    return preserveModelWordingOnGroundedSuccess(input, groundedCurrentAuthoringDocument);
  }
  const goalSpecificDesktopResult = formatGoalSpecificDesktopResult(input);
  if (goalSpecificDesktopResult) return goalSpecificDesktopResult;
  const verifiedDocumentObservation = groundedVerifiedDocumentObservation(input);
  if (verifiedDocumentObservation) return verifiedDocumentObservation;
  const currentVerifiedRecords = (input.toolRecords || []).filter(record => isVerifiedCurrentTurnRecord(input, record));
  const verifiedInputReads = currentVerifiedRecords.filter(record => (
    VERIFIED_DOCUMENT_OBSERVATION_TOOL_RE.test(String(record.name || ''))
    // A post-write readback of this request's verified output is separate from
    // the input document contract; it cannot excuse reading an unrelated input.
    && !isVerifiedProducedDocumentTarget(artifactPathFromRecord(record), currentVerifiedRecords)
  ));
  const hasMismatchedVerifiedDocumentRead = /(?:附件|文件|文档|PDF|\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv)\b|\b(?:attachment|document|file)\b)/iu.test(actionText) // i18n-allow: reviewed document-target intent.
    && verifiedInputReads.length > 0
    && !verifiedInputReads.some(record => documentReadMatchesRequestedTarget(record, actionText, input.flow?.acceptedTaskTarget, input.flow?.currentAttachmentPaths));
  if (hasMismatchedVerifiedDocumentRead) {
    return {
      text: isChineseText(actionText)
        ? CN_EXECUTION_EVIDENCE_MESSAGES.mismatchedDocumentReadTarget
        : 'The verified read receipt is for a different file, so it cannot complete this analysis.',
      blocked: true,
      reason: 'Verified document read target did not match the requested document.',
    };
  }
  const chatOnlyConversationTurn = Boolean(
    (input.toolRecords || []).length === 0
    && input.flow?.allowToolUseForTurn === false
    && input.flow?.completionEvidenceNeeded !== true
    && input.flow?.clientActionOnlyTurn !== true
    && input.flow?.selfRepairTurn !== true
  );
  const ordinaryConversation = (
    chatOnlyConversationTurn
    || (
      !actionContract.applies
      && (input.toolRecords || []).length === 0
      && hasExplicitNoMutationInstruction(actionText)
    )
  );
  const guard = input.completionGuard?.blocked ? input.completionGuard : ordinaryConversation
    ? { text: input.responseText, blocked: false as const }
    : guardCompletionClaims({
        task: actionText,
        response: input.responseText,
        toolCalls: input.toolRecords || [],
        source: input.source,
        requestId: input.requestId,
        taskId: input.taskId,
        acceptedTaskTarget: input.flow?.acceptedTaskTarget,
      });
  const unsupportedDiagnostic = unsupportedPriorDiagnosticClaim(input);
  if (unsupportedDiagnostic) {
    return {
      text: unsupportedDiagnostic,
      blocked: true,
      reason: 'Response claimed a prior diagnostic run without matching diagnostic receipts.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed a prior diagnostic run without matching diagnostic receipts.',
      },
    };
  }
  const immediatePromiseFailure = hasImmediateExecutionPromise(input.responseText)
    ? unsupportedOngoingExecutionClaim(input, !hasResultCoreActionEvidence(input, actionContract, input.toolRecords || [], actionText))
    : null;
  if (immediatePromiseFailure) return { text: immediatePromiseFailure, blocked: true,
    reason: 'Response promised another action after execution ended.' };
  const diagnosticResult = formatClientDiagnosticResult(input.toolRecords || [], actionText, input.responseText);
  if (diagnosticResult) {
    const diagnosticCompleted = hasCompleteClientDiagnosticReceipts(input.toolRecords || [], actionText);
    return preserveModelWordingOnGroundedSuccess(input, {
      text: diagnosticResult,
      blocked: !diagnosticCompleted,
      reason: diagnosticCompleted
        ? 'Grounded client diagnostic summary from current-turn tool receipts.'
        : 'Client diagnostic did not produce a successful substantive receipt.',
      ...(!diagnosticCompleted ? {
        notification: {
          type: 'work_product_guard' as const,
          level: 'warning' as const,
          message: 'Client diagnostic did not produce a successful substantive receipt.',
        },
      } : {}),
    });
  }
  const unsupportedExecution = unsupportedToolExecutionClaim(input);
  if (unsupportedExecution) {
    return {
      text: unsupportedExecution,
      blocked: true,
      reason: 'Response claimed tool execution without matching tool records.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed tool execution without matching tool records.',
      },
    };
  }
  // Domain contracts below have stronger target-specific verdicts (for
  // example exact desktop windows, legal gates, and in-app saves). This guard
  // closes the dangerous gap left by terse continuation turns whose task text
  // has no standalone contract, such as “嗯，对” followed by a fictional send.
  const responseClaimKind = realWorldClaimKind(input.responseText);
  const claimGuardEligible = responseClaimKind && (
    isExecutionClaimGuardTurn(input, actionContract.applies)
    || isFirstPersonConcreteRealWorldClaim(input.responseText, responseClaimKind)
  );
  const unsupportedWorldClaim = claimGuardEligible && (
    !actionContract.applies
    || ['messaging_send', 'public_post'].includes(actionContract.kind)
    || (actionContract.kind === 'desktop_operation' && responseClaimKind === 'runtime_configuration')
    || (
      actionContract.kind === 'desktop_operation'
      && responseClaimKind === 'open'
      && hasRequestedDesktopOpenEvidence(input.toolRecords || [], actionText)
      && !hasVerifiedEvidenceForRealWorldClaim(input, 'open')
    )
  )
    ? unsupportedRealWorldClaim(input)
    : null;
  if (unsupportedWorldClaim) return unsupportedWorldClaim;
  const hasGroundedCoreAction = actionContract.applies
    && hasResultCoreActionEvidence(input, actionContract, input.toolRecords || [], actionText);
  const unsupportedOngoingExecution = unsupportedOngoingExecutionClaim(
    input,
    !guard.blocked && !hasGroundedCoreAction,
  );
  if (unsupportedOngoingExecution) {
    return {
      text: unsupportedOngoingExecution,
      blocked: true,
      reason: 'Response claimed ongoing execution without a current-turn tool receipt.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed ongoing execution without a current-turn tool receipt.',
      },
    };
  }
  // Ordinary conversation has no execution contract. Keep it natural after
  // the protocol/evidence sanity checks above instead of forcing it through a
  // work-product completion guard.
  if (
    (ordinaryConversation && !guard.blocked)
    || (
      !actionContract.applies
      && (input.toolRecords || []).length === 0
      && input.flow?.completionEvidenceNeeded !== true
      && !guard.blocked
    )
  ) {
    return { text: input.responseText, blocked: false };
  }
  const groundedBlankCadDocument = formatGroundedBlankAutoCadDocumentResult(input);
  if (groundedBlankCadDocument) return preserveModelWordingOnGroundedSuccess(input, groundedBlankCadDocument);
  const groundedWpsMutation = formatGroundedWpsMutationResult(input);
  if (groundedWpsMutation) return preserveModelWordingOnGroundedSuccess(input, groundedWpsMutation);
  const groundedSkillDraft = formatGroundedSkillDraft(input);
  if (groundedSkillDraft) return groundedSkillDraft;
  const groundedArtifact = formatGroundedArtifactResult(input);
  if (groundedArtifact) return preserveModelWordingOnGroundedSuccess(input, groundedArtifact);
  const groundedCadGeometry = formatGroundedCadGeometryExtractionResult(input);
  if (groundedCadGeometry) return preserveModelWordingOnGroundedSuccess(input, groundedCadGeometry);
  const groundedExternalAiHistory = formatExternalAiHistoryResult(input);
  if (groundedExternalAiHistory) return preserveModelWordingOnGroundedSuccess(input, groundedExternalAiHistory);
  const groundedSimpleOpen = formatGroundedSimpleDesktopOpenResult(input);
  if (groundedSimpleOpen) {
    return preserveModelWordingOnGroundedSuccess(input, groundedSimpleOpen);
  }
  const observedDesktopOpen = formatObservedDesktopOpenResult(input);
  if (observedDesktopOpen) return observedDesktopOpen;
  const groundedPartialAction = formatGroundedPartialActionResult(input);
  if (groundedPartialAction) return preserveModelWordingOnGroundedSuccess(input, groundedPartialAction);
  const groundedDriftCorrection = correctCurrentTurnContractDrift(input, actionContract);
  if (groundedDriftCorrection) {
    return {
      text: groundedDriftCorrection,
      blocked: false,
      reason: 'Corrected current-turn action-contract drift using fresh desktop evidence.',
    };
  }
  const currentAuthoringDocumentClarification = !hasResultCoreActionEvidence(
    input,
    actionContract,
    input.toolRecords || [],
    actionText,
  )
    ? formatCurrentAuthoringDocumentClarification(input)
    : null;
  if (currentAuthoringDocumentClarification) {
    const reason = 'The foreground evidence does not identify one exact readable authoring document.';
    return {
      text: currentAuthoringDocumentClarification,
      blocked: true,
      reason,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: reason,
      },
    };
  }
  // A successful read-only desktop receipt is the result for an observation
  // task. Do not let an unrelated auxiliary failure (for example an extra
  // write_file attempt after the process list was already returned)
  // overwrite that evidence with a generic incomplete-work guard.
  const desktopObservation = evaluateDesktopObservationEvidence(input.toolRecords || [], actionText);
  if (desktopObservation.complete && desktopObservation.text) {
    // Observation tasks exist to return the sampled facts. A generic model
    // acknowledgement such as "check complete" is not a useful result and
    // must not hide the structured window/process/app/system evidence that
    // actually completed the contract.
    return {
      text: desktopObservation.text,
      blocked: false,
      reason: 'Grounded desktop observation from current-turn tool receipts.',
    };
  }
  // A live desktop question is itself an execution contract. The model can
  // answer it in factual prose without saying "I checked", so claim-wording
  // heuristics alone are insufficient: accepting that prose would let a
  // fabricated title/process/file count bypass the bounded recovery path.
  // Require one usable current-turn receipt for every deterministic probe.
  // Partial evidence remains visible, but it must not be promoted to complete;
  // the stable reason prefix also enters the bounded same-turn recovery path.
  if (desktopObservation.requested) {
    const missing = desktopObservation.missingToolNames.join(', ');
    const irrelevantEvidenceReason = guard.blocked && guard.reasonCode === 'successful_irrelevant_evidence'
      ? guard.reason
      : '';
    const reason = [
      `Missing desktop evidence for the requested live observation${missing ? `: ${missing}` : ''}.`,
      irrelevantEvidenceReason,
    ].filter(Boolean).join(' ');
    const partialText = desktopObservation.text;
    const blockedText = partialText
      || (irrelevantEvidenceReason
        ? guard.text
        : formatCompactBlockedResponse(input, reason));
    return {
      text: blockedText,
      blocked: true,
      reason,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: reason,
      },
    };
  }
  const responseClaimsIncomplete = /(?:\u8fd8|\u5c1a|\u4ecd)?(?:\u6ca1\u6709|\u6ca1|\u672a|\u5e76\u672a|\u4e0d\u7b97|\u4e0d\u80fd\u8bf4)[^\u3002\uFF01\uFF1F.!?\n]{0,18}(?:\u5b8c\u6210|\u53d1\u9001|\u53d1\u51fa|\u6253\u5f00|\u8bfb\u53d6|\u751f\u6210)|\b(?:not|isn'?t|wasn'?t|didn'?t|incomplete|unfinished)\b[^.!?\n]{0,40}\b(?:complete|completed|sent|opened|read|created|generated)\b/iu
    .test(input.responseText || '');
  const reportsToolIterationLimit = TOOL_ITERATION_LIMIT_RESPONSE_RE.test(input.responseText || '');
  const failedToolRecord = [...(input.toolRecords || [])].reverse().find(record => Boolean(record.error));
  const reportsFailedExecutionIncomplete = Boolean(
    responseClaimsIncomplete
    && failedToolRecord
    && (actionContract.applies || input.flow?.completionEvidenceNeeded),
  );
  const hasActionableVisualProviderBlocker = Boolean(
    failedToolRecord?.error
    && /access denied.{0,160}account is in good standing|account is in good standing.{0,160}access denied/i.test(failedToolRecord.error),
  );
  if (reportsToolIterationLimit || reportsFailedExecutionIncomplete) {
    const reason = reportsToolIterationLimit
      ? 'Tool iteration limit reached before a verified final response.'
      : `Execution remained incomplete after ${String(failedToolRecord?.name || 'a tool')} failed.`;
    return {
      text: hasActionableVisualProviderBlocker
        ? formatCompactBlockedResponse(input, reason)
        : input.responseText,
      blocked: true,
      reason,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: reason,
      },
    };
  }
  return finalizeActionCompletionClaims(input, actionText, actionContract, guard, responseClaimsIncomplete);

}
export { type LumiResultFinalizerInput, type LumiResultFinalizerResult } from "./result_finalizer_types";
export { formatGroundedArtifactResult } from "./result_artifact_presenter";

function finalizeActionCompletionClaims(
  input: LumiResultFinalizerInput,
  actionText: string,
  actionContract: ReturnType<typeof taskActionContract>,
  guard: NonNullable<LumiResultFinalizerInput["completionGuard"]> | ReturnType<typeof guardCompletionClaims>,
  responseClaimsIncomplete: boolean,
): LumiResultFinalizerResult {

  const claimsActionDone = !responseClaimsIncomplete && /(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u53d1\u9001|\u53d1\u51fa|\u6253\u5f00\u4e86|\u770b\u5230|\u8bfb\u5230|\u8bfb\u53d6|\u603b\u7ed3|\u751f\u6210|done|complete|completed|success|sent|opened|read|viewed|created|generated)/iu
    .test(input.responseText || '');
  const claimsStockWatchStarted = /(?:\u5df2\u7ecf|\u5df2|\u5f00\u59cb|\u6b63\u5728|\u6301\u7eed|\u76ef\u76d8|\u76d1\u63a7|started|watching|monitoring|tracking)/iu
    .test(input.responseText || '');
  const currentAppMutationTask = requiresCurrentAppUiMutation(actionText);
  const legalExternalHandoffOnly =
    hasLegalExternalPlatformSignal(actionText) &&
    describesAuthorizedLegalExternalHandoff(input.responseText || '') &&
    !claimsExternalLegalPlatformFinalAction(input.responseText || '') &&
    !claimsExternalLegalPlatformResult(input.responseText || '');
  if (
    hasLegalExternalPlatformSignal(actionText) &&
    claimsExternalLegalPlatformFinalAction(input.responseText || '')
  ) {
    return blockedCompletionClaim(input, 'External legal platform final action requires authorized collaboration.');
  }
  if (
    hasLegalExternalPlatformSignal(actionText) &&
    claimsExternalLegalPlatformResult(input.responseText || '') &&
    !hasLegalExternalPlatformResultEvidence(input.toolRecords || [])
  ) {
    return blockedCompletionClaim(input, 'Missing external legal platform result evidence.');
  }
  if (
    actionContract.kind === 'desktop_operation'
    && currentAppMutationTask
    && claimsActionDone
    && !hasCurrentAppUiMutationEvidence(input.toolRecords || [], actionText)
  ) {
    return blockedCompletionClaim(input, 'Missing verified in-app UI mutation evidence.', formatCreatedArtifactWithoutInAppCompletion(input)
        || formatCompactBlockedResponse(input, 'Missing verified in-app UI mutation evidence.'));
  }
  if (
    actionContract.kind === 'desktop_operation'
    && currentAppMutationTask
    && claimsCurrentAppSaveCompletion(input.responseText || '')
    && !hasCurrentAppSaveEvidence(input.toolRecords || [], actionText)
  ) {
    return blockedCompletionClaim(input, 'Missing verified in-app save evidence.');
  }
  if (
    actionContract.kind === 'stock_monitor' &&
    (claimsActionDone || claimsStockWatchStarted) &&
    hasContinuousStockWatchIntent(actionText) &&
    !hasContinuousStockWatchEvidence(input.toolRecords || [])
  ) {
    return blockedCompletionClaim(input, 'Missing continuous stock watch evidence.');
  }
  if (
    actionContract.kind === 'cad_drafting' &&
    claimsActionDone &&
    requiresVisibleAutoCadExecution(actionText) &&
    !hasVisibleAutoCadExecutionEvidence(input.toolRecords || [], actionText)
  ) {
    return blockedCompletionClaim(input, 'Missing visible AutoCAD execution evidence.');
  }
  if (
    actionContract.kind === 'browser_account' &&
    claimsActionDone &&
    requiresAuthenticatedWebResult(actionText) &&
    !legalExternalHandoffOnly &&
    !hasAuthenticatedWebResultEvidence(input.toolRecords || [], actionText)
  ) {
    return blockedCompletionClaim(input, 'Missing authenticated browser result evidence.');
  }
  if (
    actionContract.kind === 'legal_document' &&
    claimsLegalDocumentCompletion(input.responseText || '') &&
    requiresLegalCurrentLawGate(actionText) &&
    !hasLegalDocumentProductionEvidence(input.toolRecords || [])
  ) {
    return blockedCompletionClaim(input, 'Missing legal document production evidence.');
  }
  if (
    actionContract.kind === 'legal_document' &&
    claimsLegalDocumentCompletion(input.responseText || '') &&
    requiresLegalCurrentLawGate(actionText) &&
    !hasLegalCurrentLawGateEvidence(input.toolRecords || [])
  ) {
    return blockedCompletionClaim(input, 'Missing current-law verification gate for legal document.');
  }
  if (
    actionContract.kind === 'legal_document' &&
    claimsLegalDocumentCompletion(input.responseText || '') &&
    requiresLegalCurrentLawGate(actionText) &&
    !hasLegalReasoningChainEvidence(input.toolRecords || [])
  ) {
    return blockedCompletionClaim(input, 'Missing legal reasoning chain evidence.');
  }
  if (shouldEnforceCoreActionContract(actionContract, actionText) && claimsActionDone && !legalExternalHandoffOnly && !hasResultCoreActionEvidence(input, actionContract, input.toolRecords || [], actionText)) {
    if (guard.blocked && /content-read\/open\/review/i.test(guard.reason || '')) {
      return {
        text: formatCompactBlockedResponse(input, guard.reason),
        blocked: true,
        reason: guard.reason,
        notification: {
          type: 'work_product_guard',
          level: 'warning',
          message: guard.reason || 'Requested content-read/open/review work was not verified.',
        },
      };
    }
    if (guard.blocked && guard.reasonCode === 'successful_irrelevant_evidence') {
      return {
        text: guard.text,
        blocked: true,
        reason: guard.reason,
        notification: {
          type: 'work_product_guard',
          level: 'warning',
          message: guard.reason || 'Current-turn tool evidence does not prove the requested action.',
        },
      };
    }
    return blockedCompletionClaim(input, `Missing core evidence for ${actionContract.kind}.`);
  }

  if (!guard.blocked) {
    return { text: input.responseText, blocked: false };
  }

  return {
    text: shouldUseCompactActionBlockedResponse(input)
      ? formatCompactBlockedResponse(input, guard.reason)
      : guard.text,
    blocked: true,
    reason: guard.reason,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: guard.reason || 'Completion claim needs verification.',
    },
  };
}

function blockedCompletionClaim(input: LumiResultFinalizerInput, reason: string, text = formatCompactBlockedResponse(input, reason)): LumiResultFinalizerResult {
  return {
    text, blocked: true, reason,
    notification: { type: "work_product_guard", level: "warning", message: reason },
  };
}
