import { evaluateMediaGenerationEvidence } from './media_contract';
import type { ToolExecutionRecord } from "../../tools/types";
import { normalizeActionIntent } from "../normalized_action_intent";
import type { ActionIntentAnalysis } from "../normalized_action_intent";
import { artifactRecordMatchesTurn } from "../../tools/artifact_evidence";
import { isExternalCliDelegation, requestedCliProviders } from "../external_cli_intent";
import { classifyRuntimeWorkIntent } from "../runtime_work_intent";
import { evaluateDesktopObservationEvidence, requiresActiveWindowObservation, requiresDesktopFileListingObservation } from "../desktop_observation";
import type { TaskCapsuleV1 } from "../../conversation/task_capsule";
import type { AcceptedTaskTarget } from "../../conversation/task_target_anchor";
import { verifiedSkillAuthoringReceipt } from "../../skills/authoring_receipt";
import { verifiedExternalCliStatus } from "../external_cli_status";
import { compact, parseRecordJson, expandSuccessfulRecords, hasVisualModelAvailabilityEvidence } from "../action_contract_support";
import { requiresCurrentAppUiMutation, requiresVisualModelAvailabilityCheck, requiresCurrentAuthoringDocumentInspection, requiresDesktopAiAnswerReadback, isSimpleDesktopOpenRequest, requiresCadGeometryExtractionOnly, requiresVisibleAutoCadExecution, requiresAutoCadMcpPlayback, requestedDesktopWindowAction, requiresSourceGrounding, extractDesktopLaunchTarget, extractSimpleDesktopOpenTarget, isDesktopAppInventoryRequest, isRunningSoftwareInspectionRequest } from "../action_request";
import { hasRequestedDesktopOpenEvidence, requestsExactReadOnlyArtifactInspection, hasVisibleAutoCadExecutionEvidence, hasBlankAutoCadDocumentEvidence, hasVerifiedExactReadOnlyArtifactEvidence, hasCurrentAppUiMutationEvidence, resolveVerifiedCurrentAuthoringDocumentEvidence, hasMatchingDesktopObservationEvidence } from "../action_desktop_evidence";
import { hasMediaPauseEvidence, hasMediaPlaybackEvidence } from "../action_media_evidence";
import type { LumiActionContract } from './contracts';
import { hasVerifiedManifestCapabilityEvidence, hasVerifiedGenericDesktopMutation } from './receipt_evidence';
import { hasRequestedMessagingFileEvidence, hasPublicPostEvidence } from './messaging_evidence';
import { browserSessionObservation, hasAuthenticatedWebResultEvidence } from './browser_evidence';
import { hasVerifiedCadGeometryExtractionEvidence, hasGroundedCadGeometryEvidence } from './cad_evidence';
import { resolveVerifiedArtifactRetrieval, hasSourceInspectionEvidence, hasCreatedArtifact, hasArtifactVerification, getArtifactTaskProgress } from './artifact_evidence';
import { hasCustomerOperationsEvidence, hasEcommerceOperationsEvidence, hasDesignDeliveryEvidence } from './business_evidence';

export function hasCoreActionEvidence(
  contract: LumiActionContract,
  records: ToolExecutionRecord[] = [],
  taskText = '',
  taskCapsule?: TaskCapsuleV1 | null,
  currentTurn?: { requestId?: string; taskId?: string },
  acceptedTaskTarget?: AcceptedTaskTarget, analysis?: ActionIntentAnalysis
): boolean {
  if (!contract.applies) return true;
  if (contract.kind === 'media_generation') return evaluateMediaGenerationEvidence(contract, records, currentTurn).complete;
  if (contract.components?.length) return contract.components.every(item => hasCoreActionEvidence(item.contract, records, item.text, taskCapsule, currentTurn, acceptedTaskTarget, analysis));
  if (contract.kind === 'skill_authoring') return Boolean(verifiedSkillAuthoringReceipt(taskText, records, currentTurn));
  const successful = expandSuccessfulRecords(records);
  const recoverableObservedOpen = contract.kind === 'desktop_operation'
    ? (() => {
        const target = extractDesktopLaunchTarget(taskText, analysis) || extractSimpleDesktopOpenTarget(taskText, analysis);
        return Boolean(target) && records.some(record => (
          /^(?:desktop_open|browser_open_task)$/iu.test(String(record.name || ''))
          && hasRequestedDesktopOpenEvidence([record], taskText, target, analysis)
        ));
      })()
    : false;
  if (successful.length === 0 && !recoverableObservedOpen) return false;
  if (contract.kind === 'avatar_authoring') return successful.some(record => {
    if (!['memory_avatar_read','memory_avatar_configure_animation','memory_avatar_create','memory_avatar_import_image'].includes(record.name)) return false;
    const p = parseRecordJson(record);
    if (p?.verified !== true || p.saved !== true || !p.avatarId) return false;
    // i18n-allow: requested animation features must have corresponding saved evidence.
    if (/动画|animation/iu.test(taskText) && !p.animation?.configured) return false;
    if (/眨眼|闭眼|blink/iu.test(taskText) && !p.animation?.blink) return false;
    // i18n-allow: feature names parsed from the user's request, not UI text.
    if (/口型|说话|lip|speech/iu.test(taskText) && !p.animation?.speech) return false;
    // i18n-allow: requested animation feature.
    if (/呼吸|breath/iu.test(taskText) && !p.animation?.breathing) return false;
    // i18n-allow: requested environment animation feature.
    if (/背景动画|环境微动|背景微动|background\s*(?:motion|animation)/iu.test(taskText) && !p.animation?.backgroundMotion) return false;
    const samePersonReceipt = (name: string) => successful.some(item => item.name === name && parseRecordJson(item)?.avatarId === p.avatarId);
    // i18n-allow: requested person creation requires creation evidence.
    if (/新建|创建|create/iu.test(taskText) && !samePersonReceipt('memory_avatar_create')) return false;
    // i18n-allow: requested media import requires import evidence.
    if (/导入|import/iu.test(taskText) && (!p.media?.length || !samePersonReceipt('memory_avatar_import_image'))) return false;
    return true;
  });
  if (contract.kind === 'task_control') {
    const intent = classifyRuntimeWorkIntent(taskText);
    const expectedTool = contract.preferredTools.includes('runtime_work_cancel')
      ? 'runtime_work_cancel'
      : intent === 'cancel'
        ? 'runtime_work_cancel'
        : 'runtime_work_status';
    return successful.some(record => {
      if (record.name !== expectedTool) return false;
      const payload = parseRecordJson(record);
      if (payload?.ok !== true) return false;
      if (expectedTool === 'runtime_work_cancel') {
        return ['idle', 'cancelled'].includes(String(payload.status || ''))
          && Number.isFinite(Number(payload.matchedCount))
          && Number.isFinite(Number(payload.cancelledCount))
          && Number.isFinite(Number(payload.cancellingCount))
          && Number(payload.failedCount || 0) === 0;
      }
      return ['idle', 'active', 'paused', 'attention'].includes(String(payload.status || ''))
        && Number.isFinite(Number(payload.activeCount));
    });
  }
  if (contract.kind === 'messaging_read') {
    return successful.some(record =>
      record.name === 'wechat_read_recent_chat' && /"read"\s*:\s*true|read:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => /^(ocr_screen|desktop_capture_screen|desktop_ui_snapshot)$/i.test(record.name))
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'messaging_send') {
    return successful.some(record =>
      record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => hasRequestedMessagingFileEvidence(record, taskText))
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'public_post') {
    return hasPublicPostEvidence(successful) || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'browser_account') {
    return Boolean(browserSessionObservation(successful, taskText)) || hasAuthenticatedWebResultEvidence(successful, taskText)
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'cad_document') {
    return hasBlankAutoCadDocumentEvidence(successful);
  }
  if (contract.kind === 'cad_drafting') {
    if (requiresCadGeometryExtractionOnly(taskText)) {
      return hasVerifiedCadGeometryExtractionEvidence(successful);
    }
    if (requiresVisibleAutoCadExecution(taskText) || requiresAutoCadMcpPlayback(taskText)) {
      return hasVisibleAutoCadExecutionEvidence(successful, taskText);
    }
    if (requiresSourceGrounding(taskText) && (
      !hasSourceInspectionEvidence(successful)
      || !hasGroundedCadGeometryEvidence(successful)
    )) return false;
    return hasCreatedArtifact(successful, /^(?:cad_generate_dxf|mcp_cad-drafting_.+)$/i)
      && hasArtifactVerification(successful);
  }
  if (contract.kind === 'customer_operations') {
    return hasCustomerOperationsEvidence(successful, taskText);
  }
  if (contract.kind === 'ecommerce_operations') {
    return hasEcommerceOperationsEvidence(successful, taskText);
  }
  if (contract.kind === 'design_delivery') {
    return hasDesignDeliveryEvidence(successful, taskText);
  }
  if (contract.kind === 'stock_monitor') {
    return successful.some(record =>
      /stock_|market_index|reminder_|alert|watchlist|autonomy_(?:register|list|set)_workflow|work_takeover_task/i.test(record.name) ||
      /(?:alert|watchlist|reminder|scheduled|monitoring|workflow|price\s*alert|market\s*alert|\u9884\u8b66|\u63d0\u9192|\u76ef\u76d8\u4efb\u52a1|\u76d1\u63a7\u4efb\u52a1)/iu.test(String(record.result || ''))
    );
  }
  if (contract.kind === 'legal_document') {
    return successful.some(record => /legal_|read_|create_docx|write_file|desktop_path_info|work_product_verify/i.test(record.name))
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  if (contract.kind === 'artifact_work') {
    if (contract.artifactMode === 'retrieve') return Boolean(resolveVerifiedArtifactRetrieval(taskText, contract, records, currentTurn));
    const resolvedTarget = acceptedTaskTarget || (taskCapsule?.target.path && taskCapsule.target.status !== 'rejected'
      && (!currentTurn?.taskId || taskCapsule.taskId === currentTurn.taskId)
      ? { target: taskCapsule.target, source: 'task' as const, sourceId: taskCapsule.taskId } : undefined);
    if (requestsExactReadOnlyArtifactInspection(taskText)) {
      return hasVerifiedExactReadOnlyArtifactEvidence(successful, taskText, resolvedTarget);
    }
    const current = successful.filter(record => artifactRecordMatchesTurn(record, currentTurn || {}));
    return getArtifactTaskProgress(taskText, current, undefined, analysis)?.complete === true;
  }
  if (contract.kind === 'external_cli_status') return verifiedExternalCliStatus(taskText, records, currentTurn) !== null;
  if (contract.kind === 'external_ai_request') {
    if (isExternalCliDelegation(taskText)) {
      const requested = requestedCliProviders(taskText);
      const providers = requested.length ? requested : ['codex', 'claude'];
      const completed = (provider: string) =>
        successful.some(record => {
          const payload = parseRecordJson(record);
          return record.name === 'external_cli_run' && record.terminalVerification?.status === 'verified'
            && artifactRecordMatchesTurn(record, currentTurn || {}) && payload?.ok === true
            && payload.status === 'completed' && payload.exitCode === 0 && Boolean(compact(payload.response))
            && Boolean(payload.runId) && payload.provider === provider;
        });
      return requested.length ? providers.every(completed) : providers.some(completed);
    }
    const hasSubmission = successful.some(record => {
      const payload = parseRecordJson(record);
      return record.name === 'desktop_ai_ask'
        && payload?.ok === true
        && ['prepared', 'submitted_unverified'].includes(String(payload?.status || ''))
        && Array.isArray(payload?.results)
        && payload.results.length === 1;
    });
    const hasAnswer = successful.some(record => {
      const payload = parseRecordJson(record);
      return record.name === 'desktop_ai_collect_answer'
        && payload?.status === 'collected'
        && Boolean(compact(payload?.answerText));
    });
    if (requiresDesktopAiAnswerReadback(taskText)) return hasAnswer;
    return hasSubmission || hasAnswer;
  }
  if (contract.kind === 'external_ai_history') {
    return successful.some(record => {
      const payload = parseRecordJson(record);
      if (record.name === 'external_ai_history_source_register') {
        return payload?.ok === true
          && ['registered', 'already_registered'].includes(String(payload?.status || ''))
          && Boolean(compact(payload?.authorizationDigest));
      }
      if (record.name === 'external_ai_history_source_revoke') {
        return payload?.ok === true && payload?.status === 'revoked';
      }
      if (record.name === 'external_ai_history_sync') {
        return payload?.verified === true
          && ['completed', 'partial'].includes(String(payload?.status || ''))
          && Boolean(compact(payload?.jobId));
      }
      if (record.name === 'external_ai_history_query') {
        return payload?.ok === true && payload?.status === 'queried' && Array.isArray(payload?.messages);
      }
      if (record.name === 'external_ai_history_status') {
        return payload?.ok === true && Boolean(payload?.source);
      }
      if (record.name === 'external_ai_history_source_list') {
        return payload?.ok === true && payload?.status === 'listed' && Array.isArray(payload?.sources);
      }
      return false;
    });
  }
  if (contract.kind === 'desktop_operation') {
    if (contract.label === 'Current Lumi runtime diagnostic') {
      return contract.verificationTools.every(name => successful.some(record => {
        if (record.name !== name) return false;
        const payload = parseRecordJson(record);
        return Boolean(payload) && payload?.ok !== false && payload?.success !== false
          && !/^(?:failed|error|blocked|denied|timeout|unavailable)$/.test(String(payload?.status || ''));
      }));
    }
    const clientIntent = normalizeActionIntent(taskText, analysis);
    if (clientIntent.kind === 'client_navigation' && clientIntent.clientAction) {
      return successful.some(record => {
        if (record.name !== 'client_action') return false;
        const payload = parseRecordJson(record);
        const status = String(payload?.verification?.status || payload?.status || '').toLowerCase();
        const action = String(payload?.action || record.arguments?.action || '');
        return action === clientIntent.clientAction
          && payload?.ok !== false
          && /^(?:verified|not_applicable)$/.test(status);
      });
    }
    if (clientIntent.kind === 'client_state') {
      return successful.some(record => (
        record.name === 'client_get_state'
        && Boolean(parseRecordJson(record))
      ));
    }
    if (requiresVisualModelAvailabilityCheck(taskText)) {
      return hasVisualModelAvailabilityEvidence(records);
    }
    if (contract.mediaPlayback === 'pause') return hasMediaPauseEvidence(records, taskText, currentTurn, analysis);
    if (contract.mediaPlayback === 'play') {
      return hasMediaPlaybackEvidence(records, taskText, currentTurn, analysis);
    }
    const windowAction = requestedDesktopWindowAction(taskText);
    if (windowAction) {
      return successful.some(record => {
        if (record.name !== 'desktop_window_control') return false;
        const payload = parseRecordJson(record);
        return payload?.ok === true
          && payload?.status === 'verified'
          && payload?.action === windowAction
          && payload?.targetMatched === true;
      });
    }
    // A named application can be both the launch target and the surface for a
    // follow-on mutation (for example, "Open WPS and create a Word
    // document").  In that composite case an exact desktop_open receipt only
    // proves the first boundary.  Evaluate the mutation contract before the
    // simpler launch contract so a confirmed open cannot prematurely complete
    // the whole durable task.
    if (requiresCurrentAppUiMutation(taskText)) {
      return hasCurrentAppUiMutationEvidence(records, taskText);
    }
    if (requiresCurrentAuthoringDocumentInspection(taskText)) {
      return Boolean(resolveVerifiedCurrentAuthoringDocumentEvidence(
        records,
        taskText,
        taskCapsule,
      ));
    }
    const desktopObservation = evaluateDesktopObservationEvidence(records, taskText);
    if (desktopObservation.requested) return desktopObservation.complete;
    const desktopLaunchTarget = extractDesktopLaunchTarget(taskText, analysis);
    const needsActiveWindow = requiresActiveWindowObservation(taskText);
    const needsDesktopFiles = requiresDesktopFileListingObservation(taskText);
    if (desktopLaunchTarget) {
      const openedExactTarget = hasRequestedDesktopOpenEvidence(records, taskText, desktopLaunchTarget, analysis);
      if (!openedExactTarget) return false;
      const hasBoundOpenAction = records.some(record => (
        /^(?:desktop_open|browser_open_task)$/iu.test(String(record.name || ''))
        && hasRequestedDesktopOpenEvidence([record], taskText, desktopLaunchTarget, analysis)
      ));
      if (!hasBoundOpenAction) return false;
      if (needsActiveWindow && !successful.some(record => hasMatchingDesktopObservationEvidence(record, desktopLaunchTarget))) {
        return false;
      }
      return !needsDesktopFiles || successful.some(record => /^desktop_list_files$/i.test(record.name));
    }
    if (needsActiveWindow || needsDesktopFiles) {
      const hasActiveWindow = successful.some(record =>
        /^(?:desktop_active_window|get_active_window_info)$/i.test(record.name)
      );
      const hasDesktopFiles = successful.some(record =>
        /^desktop_list_files$/i.test(record.name)
      );
      return (!needsActiveWindow || hasActiveWindow)
        && (!needsDesktopFiles || hasDesktopFiles);
    }
    if (isDesktopAppInventoryRequest(taskText)) {
      return successful.some(record => record.name === 'desktop_list_apps');
    }
    if (isRunningSoftwareInspectionRequest(taskText)) {
      return successful.some(record => /^(?:desktop_running_processes|get_running_processes)$/i.test(record.name));
    }
    if (isSimpleDesktopOpenRequest(taskText, analysis)) {
      const target = extractSimpleDesktopOpenTarget(taskText, analysis);
      return successful.some(record => (
        /^(?:desktop_open|browser_open_task)$/iu.test(String(record.name || ''))
        && hasRequestedDesktopOpenEvidence([record], taskText, target, analysis)
      ));
    }
    return hasVerifiedGenericDesktopMutation(successful)
      || hasVerifiedManifestCapabilityEvidence(contract, successful);
  }
  return successful.length > 0;
}
