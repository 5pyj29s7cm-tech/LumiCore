import { artifactPathFromRecord, artifactRecordMatchesTurn, isArtifactProducerRecord, sameArtifactPath } from '../tools/artifact_evidence';
import { actualDocumentReadContent, documentReadMatchesRequestedTarget } from '../cognition/action_desktop_evidence';
import { ToolExecutionRecord, type ToolContext } from '../tools/types';
import { buildActionEvidenceContract, claimsCurrentAppSaveCompletion, hasCoreActionEvidence, hasCurrentAppSaveEvidence, hasCurrentAppUiMutationEvidence, hasRequestedDesktopOpenEvidence, isSuccessfulExactDocumentRead, requiresCurrentAppUiMutation, type LumiActionContract } from '../cognition/action_contract';
import { affirmativeActionClauses } from '../cognition/action_instruction_clauses';
import { responseClaimFileTargets, responseExecutionClaims } from './response_execution_claims';
import { hasPublicSourceObservationEvidence } from '../cognition/contracts/receipt_evidence';
import { CN_COMPLETION_GUARD_MESSAGES } from "../regions/messages/completion_guard_messages";
import { normalizeActionIntent, isStoredMemoryRecallQuestion } from '../cognition/normalized_action_intent';

import { classifyToolRecordTaskDurability } from '../cognition/continuation/tool_receipts';
import { formatGroundedKnowledgeObservation, isKnowledgeInventoryRequest } from '../cognition/knowledge_result';

export interface CompletionGuardResult {
  text: string;
  blocked: boolean;
  reason?: string;
  reasonCode?: 'successful_irrelevant_evidence';
}

interface CompletionGuardInput {
  task: string;
  response: string;
  toolCalls?: ToolExecutionRecord[];
  source?: string;
  requestId?: string;
  taskId?: string;
  acceptedTaskTarget?: ToolContext['acceptedTaskTarget'];
  acceptedActionContract?: ToolContext['acceptedActionContract'];
}

const DESKTOP_ACTION_TASK_RE =
  /\b(?:desktop|screen|app|application|program|software|wechat|weixin|browser|open|launch|start|run)\b|(?:\u684c\u9762|\u5c4f\u5e55|\u5fae\u4fe1|\u5feb\u6377\u65b9\u5f0f|\u5e94\u7528|\u7a0b\u5e8f|\u8f6f\u4ef6|\u6253\u5f00|\u6253\u4e0d\u5f00|\u542f\u52a8|\u8fd0\u884c|\u5f00\u542f)/iu;

const CONTENT_WORK_TASK_RE =
  /\b(?:file|document|docx|pdf|contract|agreement|attachment|read|review|inspect|analy[sz]e|transcribe|audio|note)\b|(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u9644\u4ef6|\u5408\u540c|\u534f\u8bae|\u5ba1\u67e5|\u5ba1\u9605|\u5206\u6790|\u8f6c\u5199|\u8bed\u97f3|\u97f3\u9891|\u7b14\u5f55)/iu;

const CLIENT_SURFACE_TASK_RE =
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  /客户端|自己的客户端|中枢世界|中枢|世界视图|云端画布|技能大厅|知识库|运行日志|主屏幕|主页|桌面小组件|小组件|client_get_state|client_action|\b(?:client|nexus|nexus\s+view|cloud\s+canvas|world\s+view|desktop\s+widget|widget\s+mode)\b/iu;

function isClientSurfaceTask(task: string): boolean {
  if (isKnowledgeInventoryRequest(task)) return false;
  const intent = normalizeActionIntent(task || '');
  if (
    intent.kind === 'desktop_operation'
    && intent.operation === 'create'
    && intent.sideEffectClass === 'local_write'
    && intent.relation === 'new'
  ) return false;
  return CLIENT_SURFACE_TASK_RE.test(task || '');
}

function isDesktopActionTask(task: string): boolean {
  const text = task || '';
  if (requiresCurrentAppUiMutation(text)) return true;
  return DESKTOP_ACTION_TASK_RE.test(text) && !CONTENT_WORK_TASK_RE.test(text);
}

interface ParsedJsonToolResult {
  parsed: boolean;
  payload: Record<string, unknown> | null;
}

function parseStructuredToolResult(value: string): ParsedJsonToolResult {
  let parsed: unknown = String(value || '').trim();
  let parsedAtLeastOnce = false;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
      parsedAtLeastOnce = true;
    } catch {
      break;
    }
  }
  return {
    parsed: parsedAtLeastOnce,
    payload: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null,
  };
}

const INCOMPLETE_TOOL_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'confirmation_required',
  'error',
  'failed',
  'in_progress',
  'needs_confirmation',
  'not_ready',
  'partial',
  'pending',
  'queued',
  'requires_confirmation',
  'requires_setup',
  'submitted_unverified',
  'timeout',
  'timed_out',
  'unverified',
]);

function normalizedFailureText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string'
    ? value.trim()
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })().trim();
  if (!text || /^(?:undefined|null)$/i.test(text)) return '';
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function structuredToolFailureDetail(payload: Record<string, unknown>): string {
  const status = typeof payload.status === 'string'
    ? payload.status.trim().toLowerCase()
    : '';
  const verification = payload.verification && typeof payload.verification === 'object' && !Array.isArray(payload.verification)
    ? payload.verification as Record<string, unknown>
    : null;
  const verificationStatus = typeof verification?.status === 'string'
    ? verification.status.trim().toLowerCase()
    : '';
  const explicitFailure =
    payload.ok === false
    || payload.success === false
    || payload.failed === true
    || payload.completionMarkerExists === false
    || payload.requiresConfirmation === true
    || payload.confirmationRequired === true
    || INCOMPLETE_TOOL_STATUSES.has(status)
    || INCOMPLETE_TOOL_STATUSES.has(verificationStatus)
    || Boolean(normalizedFailureText(payload.error))
    || Boolean(normalizedFailureText(verification?.error));
  if (!explicitFailure) return '';

  const detail = [
    payload.error,
    payload.reason,
    payload.blocker,
    verification?.error,
    verification?.reason,
    verification?.message,
    payload.message,
  ].map(normalizedFailureText).find(Boolean);
  if (detail) return detail;
  if (status && INCOMPLETE_TOOL_STATUSES.has(status)) return `status=${status}`;
  if (verificationStatus && INCOMPLETE_TOOL_STATUSES.has(verificationStatus)) {
    return `verification.status=${verificationStatus}`;
  }
  if (payload.completionMarkerExists === false) return 'completion marker was not found';
  if (payload.requiresConfirmation === true || payload.confirmationRequired === true) {
    return 'user confirmation is required';
  }
  if (payload.success === false) return 'tool reported success=false';
  if (payload.ok === false) return 'tool reported ok=false';
  if (payload.failed === true) return 'tool reported failed=true';
  return 'tool returned an incomplete result without an explicit error';
}

function toolFailureDetail(call: ToolExecutionRecord): string {
  const directError = normalizedFailureText(call.error);
  if (directError) return directError;

  const result = String(call.result || '').trim();
  if (!result) return '';
  const parsed = parseStructuredToolResult(result);
  if (parsed.payload) return structuredToolFailureDetail(parsed.payload);
  if (parsed.parsed) return '';
  if (/requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(result)) {
    return normalizedFailureText(result);
  }
  return '';
}

function isSuccessfulToolCall(call: ToolExecutionRecord): boolean {
  if (call.capability && !Array.isArray(call.capability.sideEffects)) return false;
  if (call.terminalVerification?.status === 'failed') return false;
  if (call.error || !String(call.result || '').trim()) return false;
  const parsed = parseStructuredToolResult(call.result || '');
  if (parsed.payload) return !structuredToolFailureDetail(parsed.payload);
  if (parsed.parsed) return true;
  return !/requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(String(call.result || ''));
}

export function needsCompletionEvidence(task: string): boolean {
  if (isStoredMemoryRecallQuestion(task)) return false;
  return buildActionEvidenceContract(task).applies
    || normalizeActionIntent(task).sideEffectClass !== 'none';
}

export function guardCompletionClaims(input: CompletionGuardInput): CompletionGuardResult {
  const task = input.task || '';
  const response = input.response || '';
  if (!response.trim()) return { text: response, blocked: false };
  const toolCalls = input.toolCalls || [];
  const knowledgeObservation = formatGroundedKnowledgeObservation({ taskText: task, toolRecords: toolCalls });
  if (knowledgeObservation) return { text: knowledgeObservation, blocked: false };
  const toolOutcomes = toolCalls.map(call => ({ call, successful: isSuccessfulToolCall(call) }));
  const successful = toolOutcomes.filter(outcome => outcome.successful).map(outcome => outcome.call);
  const failed = toolOutcomes
    .filter(outcome => !outcome.successful && Boolean(outcome.call.error || String(outcome.call.result || '').trim()))
    .map(outcome => outcome.call);
  const actionContract = buildActionEvidenceContract(task, undefined, input.acceptedActionContract);
  const hasDomainCompletionEvidence = actionContract.applies
    && hasCoreActionEvidence(actionContract, successful.filter(call => artifactRecordMatchesTurn(call, input)), task, undefined,
      { requestId: input.requestId, taskId: input.taskId }, input.acceptedTaskTarget);
  const durableCalls = toolCalls.filter(call => artifactRecordMatchesTurn(call, input)
    && classifyToolRecordTaskDurability(call) === 'durable');
  const currentSuccessful = successful.filter(call => artifactRecordMatchesTurn(call, input)
    && call.terminalVerification?.status !== 'unverified');
  const claimText = currentSuccessful.filter(call => isSuccessfulExactDocumentRead(call)
    && documentReadMatchesRequestedTarget(call, task, input.acceptedTaskTarget)
    && !currentSuccessful.some(producer => isArtifactProducerRecord(producer)
      && sameArtifactPath(artifactPathFromRecord(producer), artifactPathFromRecord(call)))).reduce((text, call) => {
    const body = actualDocumentReadContent(call);
    return body ? text.replace(body, '\n') : text;
  }, response);
  const replyClaims = responseExecutionClaims(claimText);
  const { claims } = replyClaims;
  const needsEvidence = actionContract.applies || normalizeActionIntent(task).sideEffectClass !== 'none'
    || durableCalls.length > 0 || claims.length > 0;
  if (!needsEvidence) return { text: response, blocked: false };

  if (toolCalls.some(call => call.envelope?.status === 'unknown_outcome' && artifactRecordMatchesTurn(call, input))) {
    return { text: /[\u3400-\u9fff]/.test(task)
      ? CN_COMPLETION_GUARD_MESSAGES.unknownOutcome()
      : 'The result of this action is not confirmed. Check its receipt before deciding what to do next.',
    blocked: true, reason: 'Current-turn canonical execution outcome is unknown.' };
  }

  // This guard checks what the answer claims. A pending-input explanation is
  // preserved; the finalizer still owns whether the requested task is complete.
  if (claims.length === 0 && replyClaims.deferred) return { text: response, blocked: false };
  const containsKind = (contract: LumiActionContract, kind: LumiActionContract['kind']): boolean => contract.kind === kind
    || Boolean(contract.components?.some(component => containsKind(component.contract, kind)));
  const matchesFileClaim = (text: string, records: ToolExecutionRecord[]) => {
    const targets = responseClaimFileTargets(text);
    return targets.length ? targets.every(target => records.some(record => {
      const actual = artifactPathFromRecord(record);
      return /[\\/]/u.test(target) ? sameArtifactPath(target, actual)
        : Boolean(actual) && actual.split(/[\\/]/u).pop()?.toLocaleLowerCase() === target.toLocaleLowerCase();
    })) : records.length > 0;
  };
  const unsupportedClaim = claims.find(claim => {
    // A successful search/fetch only proves observation. No current generic
    // receipt binds a factual/authority-verification claim to a verified result.
    if (claim.kind === 'source_verification') return true;
    if (claim.kind === 'source') return !hasPublicSourceObservationEvidence(currentSuccessful, claim.text);
    if (claim.kind === 'artifact') {
      if (hasDomainCompletionEvidence && actionContract.kind === 'work_task'
        && responseClaimFileTargets(claim.text).length === 0
        // i18n-allow: A task-creation receipt does not substantiate a saved file.
        && !/(?:保存|写入|写好|文件|文档|报告)|\b(?:save|saved|write|written|file|document|report)\b/iu.test(claim.text)) return false;
      if (actionContract.kind === 'desktop_operation' && requiresCurrentAppUiMutation(task)) return false;
      return !matchesFileClaim(claim.text, currentSuccessful.filter(isArtifactProducerRecord));
    }
    if (claim.kind === 'read') return !matchesFileClaim(claim.text, currentSuccessful.filter(isSuccessfulExactDocumentRead));
    if (claim.kind === 'send') return !(hasDomainCompletionEvidence && containsKind(actionContract, 'messaging_send'));
    if (claim.kind === 'open') return !hasRequestedDesktopOpenEvidence(currentSuccessful, claim.text);
    return !hasDomainCompletionEvidence && !currentSuccessful.some(call => isArtifactProducerRecord(call)
      || classifyToolRecordTaskDurability(call) === 'durable'
      || claim.immediate && call.name === 'desktop_open');
  });
  if (unsupportedClaim) {
    const reason = `Missing current-turn evidence for reported ${unsupportedClaim.kind} ${unsupportedClaim.immediate ? 'execution promise' : 'completion'}.`;
    return { text: buildGuardedResponse(task, reason, successful, failed), blocked: true, reason };
  }

  // The accepted contract owns required effects. Historical saves and excluded
  // edits in an artifact handoff do not create a separate current-app mutation.
  // Composite contracts still verify every child through core evidence above.
  const currentAppMutationTask = actionContract.kind === 'desktop_operation' && requiresCurrentAppUiMutation(task);
  if (currentAppMutationTask && !hasCurrentAppUiMutationEvidence(toolCalls, task)) {
    const reason = 'Missing verified in-app UI mutation evidence.';
    return { text: buildGuardedResponse(task, reason, successful, failed), blocked: true, reason };
  }

  // A verified edit does not substantiate an additional claim that it was saved.
  // Project quoted/conditional/negated prose before checking the claim, and bind
  // its save receipt to this turn just like the accepted action contract above.
  if (currentAppMutationTask
    && affirmativeActionClauses(response).some(claimsCurrentAppSaveCompletion)
    && !hasCurrentAppSaveEvidence(toolCalls.filter(call => artifactRecordMatchesTurn(call, input)), task)) {
    const reason = 'Missing verified in-app save evidence.';
    return { text: buildGuardedResponse(task, reason, successful, failed), blocked: true, reason };
  }

  const unverifiedReceipts = hasDomainCompletionEvidence ? []
    : durableCalls.filter(call => call.terminalVerification?.status === 'unverified');
  if (unverifiedReceipts.length > 0) {
    const reason = unverifiedReceipts.map(call => call.terminalVerification?.reason).filter(Boolean).join('; ')
      || 'The tool returned, but the capability verification contract was not satisfied.';
    return { text: buildGuardedResponse(task, reason, successful, failed), blocked: true, reason };
  }

  const missingContractEvidence = actionContract.applies && !hasDomainCompletionEvidence;
  const failedDurableOutcome = durableCalls.some(call => !isSuccessfulToolCall(call));
  if (!missingContractEvidence && !failedDurableOutcome) return { text: response, blocked: false };
  const reason = missingContractEvidence
    ? `Missing core evidence for ${actionContract.kind}.`
    : 'Current-turn durable execution did not produce a successful verified result.';
  return { text: buildGuardedResponse(task, reason, successful, failed), blocked: true, reason };
}

function buildGuardedResponse(
  task: string,
  _reason: string,
  successful: ToolExecutionRecord[],
  failed: ToolExecutionRecord[],
): string {
  const isZh = /[\u3400-\u9fff]/.test(task);
  const clientSurfaceTask = isClientSurfaceTask(task);
  const desktopActionTask = isDesktopActionTask(task);
  const hasVerifiedProgress = successful.length > 0;
  const confirmationBlocked = failed.some(call =>
    /requires user confirmation|requires confirmation|user confirmation|\u7528\u6237\u786e\u8ba4|\u9700\u8981\u786e\u8ba4/i.test(toolFailureDetail(call))
  );

  if (isZh && desktopActionTask && !clientSurfaceTask) {
    return CN_COMPLETION_GUARD_MESSAGES.blockedDesktop(hasVerifiedProgress);
  }

  if (!isZh) {
    if (clientSurfaceTask) {
      return `That client action is not complete. ${hasVerifiedProgress ? 'Completed work is preserved, and the request ' : 'The request '}can be retried from this step.`;
    }
    if (desktopActionTask) {
      return `That desktop action is not complete. ${hasVerifiedProgress ? 'Completed work is preserved; ' : ''}the target can be checked again before retrying.`;
    }
    if (confirmationBlocked) {
      return `This action still needs your confirmation. Confirm it in the client to continue.`;
    }
    return `That action is not complete. ${hasVerifiedProgress ? 'Completed work is preserved, and it ' : 'It '}can be retried from this step.`;
  }

  if (clientSurfaceTask) {
    return CN_COMPLETION_GUARD_MESSAGES.blockedClient(hasVerifiedProgress);
  }

  if (confirmationBlocked) {
    return CN_COMPLETION_GUARD_MESSAGES.confirmation();
  }

  return CN_COMPLETION_GUARD_MESSAGES.blockedGeneric(hasVerifiedProgress);
}
