import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { io as createSocketClient } from 'socket.io-client';
import {
  DESKTOP_SESSION_HEADER,
  bootstrapDesktopTestSession,
} from './lib/desktop-bootstrap.mjs';
import {
  createFormalAcceptanceEvidenceRun,
} from './lib/formal-acceptance-evidence.mjs';
import { selectFormalNativeClientEvidence } from './lib/formal-native-client-binding.mjs';
import {
  createFormalStage9FileBackedProducerEvidence,
  formalStage9ProducerEvidenceExitCode,
} from './lib/formal-stage9-producer-evidence.mjs';

export { selectFormalNativeClientEvidence };

const INTERNAL_BLOCK_RE = /(?:No (?:successful|verified) current[- ]turn tool execution|这一轮没有记录到成功的真实工具执行|我还不能说正在执行|我需要先真正调用对应工具)/iu;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TERMINAL_BACKGROUND_STATUSES = new Set(['completed', 'blocked', 'failed', 'cancelled']);

export const FORMAL_STAGE9_REQUIREMENTS = Object.freeze([
  'task_correction_three_times',
  'physical_microphone_20_turns',
  'voice_to_text_same_task_continuation',
  'confirmation_waiting',
  'confirmation_rejection',
  'repeated_confirmation_idempotency',
  'production_primary_failure_lmstudio_same_task_continuation',
  'native_client_restart_formal_profile',
  'backend_restart_task_recovery',
  'active_wps_document_workflow',
  'task_status_query',
  'batch_cleanup',
  'multi_agent_durable_completion',
  'four_variant_business_loops',
  'client_window_chat_voice_settings',
  'screenshots_receipts_timeline_routing_artifacts_feedback',
]);

export const FORMAL_SCENARIO_EVIDENCE_CATEGORIES = Object.freeze([
  'screenshots',
  'taskReceipts',
  'taskTimeline',
  'modelRouting',
  'artifacts',
  'userFeedback',
]);

export const FORMAL_STAGE9_SCENARIOS = Object.freeze(
  FORMAL_STAGE9_REQUIREMENTS.filter(id => id !== 'screenshots_receipts_timeline_routing_artifacts_feedback'),
);

export function evaluateFormalStage9Coverage(checks = {}) {
  const passed = Object.fromEntries(FORMAL_STAGE9_REQUIREMENTS.map(id => [id, checks?.[id] === true]));
  const missingChecks = FORMAL_STAGE9_REQUIREMENTS.filter(id => !passed[id]);
  return {
    stage9Complete: missingChecks.length === 0,
    requiredChecks: [...FORMAL_STAGE9_REQUIREMENTS],
    passedChecks: FORMAL_STAGE9_REQUIREMENTS.filter(id => passed[id]),
    missingChecks,
  };
}

function hasBoundScenarioEvidence(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0;
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

/**
 * The composite Stage 9 evidence gate is deliberately per scenario. A global
 * pile containing one screenshot, one receipt and one artifact cannot satisfy
 * unrelated scenarios.
 */
export function evaluateFormalScenarioEvidenceCoverage({ checks = {}, evidence = {} } = {}) {
  const scenarios = {};
  for (const scenarioId of FORMAL_STAGE9_SCENARIOS) {
    const bound = evidence?.[scenarioId] && typeof evidence[scenarioId] === 'object'
      ? evidence[scenarioId]
      : {};
    const categories = Object.fromEntries(FORMAL_SCENARIO_EVIDENCE_CATEGORIES.map(category => (
      [category, hasBoundScenarioEvidence(bound?.[category])]
    )));
    const missingCategories = FORMAL_SCENARIO_EVIDENCE_CATEGORIES.filter(category => !categories[category]);
    const requirementPassed = checks?.[scenarioId] === true;
    scenarios[scenarioId] = {
      requirementPassed,
      categories,
      missingCategories,
      complete: requirementPassed && missingCategories.length === 0,
    };
  }
  const incompleteScenarios = FORMAL_STAGE9_SCENARIOS.filter(id => scenarios[id].complete !== true);
  return {
    complete: incompleteScenarios.length === 0,
    requiredScenarios: [...FORMAL_STAGE9_SCENARIOS],
    requiredCategories: [...FORMAL_SCENARIO_EVIDENCE_CATEGORIES],
    incompleteScenarios,
    scenarios,
  };
}

export function formalGateExitCode(summary) {
  // This script is an evidence producer, never the Stage 9 adjudicator.
  // A complete local protocol is machine-readable as exit 2; any failure,
  // incomplete run, or attempted self-adjudication remains exit 1.
  return formalStage9ProducerEvidenceExitCode(summary);
}

export async function createMainFormalStage9ProducerEvidence(options = {}) {
  return createFormalStage9FileBackedProducerEvidence({
    ...options,
    producer: 'main',
    payload: options.payload || options.summary,
  });
}
const CONFIRMATION_TEXT_RE = /^(?:确认|确定|同意|继续执行|yes|confirm|confirmed|proceed)[。.!！\s]*$/iu;

export class E2EError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E2EError';
    this.code = code;
  }
}

export function selectFormalE2ENativeClientEvidence(devices, expectedValue, expectedBuildId) {
  const selected = selectFormalNativeClientEvidence(
    devices,
    expectedValue,
    { requireCleanSource: true, requireExecutableHash: true },
  );
  if (!selected.ok) return selected;
  if (selected.evidence.buildId !== String(expectedBuildId || '').trim().toLowerCase()) {
    return { ok: false, code: 'native_client_build_mismatch' };
  }
  return selected;
}

export function isLoopbackBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function parseScenarioScreenshotBinding(value) {
  const raw = String(value || '').trim();
  const separator = raw.indexOf('=');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new E2EError('scenario_evidence_screenshot_binding_required');
  }
  const scenarioId = raw.slice(0, separator).trim();
  const sourcePath = raw.slice(separator + 1).trim();
  if (!FORMAL_STAGE9_SCENARIOS.includes(scenarioId)) {
    throw new E2EError('invalid_evidence_screenshot_scenario');
  }
  if (!path.isAbsolute(sourcePath)) throw new E2EError('absolute_evidence_screenshot_required');
  return { scenarioId, sourcePath: path.resolve(sourcePath) };
}

export function containsInternalExecutionBlock(value) {
  return INTERNAL_BLOCK_RE.test(String(value || ''));
}

export function parseWorkerReceiptCount(feedback) {
  const evidence = Array.isArray(feedback?.evidence) ? feedback.evidence : [];
  for (const item of evidence) {
    const match = String(item || '').match(/Worker receipts:\s*(\d+)/i);
    if (match) return Math.max(0, Number.parseInt(match[1], 10) || 0);
  }
  return 0;
}

export function evidenceTextHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parseToolCalls(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageTransport(message) {
  return String(message?.channel || message?.source || message?.mode || '').trim().toLowerCase();
}

export function findRuntimeTaskByMarker(runtime, marker) {
  return (Array.isArray(runtime?.tasks) ? runtime.tasks : []).find(task => (
    String(task?.goal || '').includes(String(marker || ''))
  )) || null;
}

export function runtimeReceiptSignature(task) {
  return (Array.isArray(task?.evidence?.latest) ? task.evidence.latest : [])
    .map(receipt => [
      String(receipt?.receiptId || ''),
      String(receipt?.requestId || ''),
      String(receipt?.toolName || ''),
      String(receipt?.targetIdentity || ''),
      String(receipt?.outcome || ''),
      String(receipt?.verification || ''),
    ].join(':'))
    .sort()
    .join('|');
}

function normalizedEvidenceTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!path.isAbsolute(raw)) return raw.replace(/[\\/]+/gu, '/').toLowerCase();
  const resolved = path.resolve(raw);
  return (process.platform === 'win32' ? resolved.toLowerCase() : resolved).replace(/[\\/]+/gu, '/');
}

export function runtimeTaskStateSignature(task) {
  return evidenceTextHash(JSON.stringify({
    taskId: String(task?.taskId || ''),
    parentTaskId: String(task?.parentTaskId || ''),
    target: normalizedEvidenceTarget(task?.target),
    intentKind: String(task?.intentKind || ''),
    operation: String(task?.operation || ''),
    status: String(task?.status || ''),
    blocker: String(task?.blocker || ''),
    activeRequest: task?.activeRequest === true,
    completionSource: String(task?.completionSource || ''),
    revision: Math.max(0, Number(task?.revision) || 0),
    focus: task?.focus || null,
    plan: task?.plan || null,
    receiptSignature: runtimeReceiptSignature(task),
    receiptTotal: Math.max(0, Number(task?.evidence?.total)
      || (Array.isArray(task?.evidence?.latest) ? task.evidence.latest.length : 0)),
  }));
}

export function buildLifecycleTurnEvidence({ messages, requestId, runtimeTask }) {
  const records = Array.isArray(messages) ? messages : [];
  const user = records.find(message => message?.role === 'user' && message?.requestId === requestId);
  const assistant = records.find(message => message?.role === 'assistant' && message?.requestId === requestId);
  const reply = messageText(assistant);
  const receipts = (Array.isArray(runtimeTask?.evidence?.latest) ? runtimeTask.evidence.latest : [])
    .filter(receipt => receipt?.requestId === requestId);
  return {
    requestId: String(requestId || ''),
    taskId: String(runtimeTask?.taskId || ''),
    taskRevision: Math.max(0, Number(runtimeTask?.revision) || 0),
    taskStatus: String(runtimeTask?.status || ''),
    userMessageId: String(user?.id || ''),
    assistantMessageId: String(assistant?.id || ''),
    receiptIds: receipts.map(receipt => String(receipt?.receiptId || '')).filter(Boolean),
    receiptTools: receipts.map(receipt => String(receipt?.toolName || '')).filter(Boolean),
    taskTarget: String(runtimeTask?.target || ''),
    receiptTargets: receipts.map(receipt => String(receipt?.targetIdentity || '')).filter(Boolean),
    taskStateSignature: runtimeTaskStateSignature(runtimeTask),
    receiptLedger: {
      signature: runtimeReceiptSignature(runtimeTask),
      total: Math.max(0, Number(runtimeTask?.evidence?.total)
        || (Array.isArray(runtimeTask?.evidence?.latest) ? runtimeTask.evidence.latest.length : 0)),
    },
    userFacingReply: {
      persisted: Boolean(assistant && reply),
      sha256: evidenceTextHash(reply),
      characterCount: reply.length,
      internalGuardLeaked: containsInternalExecutionBlock(reply),
    },
  };
}

export function validateCorrectionLifecycleEvidence(items, expectedTargets) {
  const evidence = Array.isArray(items) ? items : [];
  if (evidence.length !== 4) return { ok: false, code: 'task_correction_evidence_count_invalid' };
  const targets = Array.isArray(expectedTargets) ? expectedTargets.map(normalizedEvidenceTarget) : [];
  if (targets.length !== evidence.length || targets.some(target => !target) || new Set(targets).size !== targets.length) {
    return { ok: false, code: 'task_correction_expected_targets_invalid' };
  }
  const taskIds = new Set(evidence.map(item => String(item?.taskId || '')).filter(Boolean));
  if (taskIds.size !== 1) return { ok: false, code: 'task_correction_identity_changed' };
  if (evidence.some(item => !item?.requestId || !item?.userMessageId || !item?.assistantMessageId)) {
    return { ok: false, code: 'task_correction_transcript_evidence_missing' };
  }
  if (evidence.some(item => !item?.userFacingReply?.persisted || item?.userFacingReply?.internalGuardLeaked)) {
    return { ok: false, code: 'task_correction_reply_evidence_invalid' };
  }
  for (let index = 1; index < evidence.length; index += 1) {
    if (Number(evidence[index]?.taskRevision) <= Number(evidence[index - 1]?.taskRevision)) {
      return { ok: false, code: 'task_correction_revision_not_advanced' };
    }
  }
  for (const [index, item] of evidence.entries()) {
    const expected = targets[index];
    const taskTarget = normalizedEvidenceTarget(item?.taskTarget);
    const receiptTargets = (Array.isArray(item?.receiptTargets) ? item.receiptTargets : [])
      .map(normalizedEvidenceTarget)
      .filter(Boolean);
    if (taskTarget !== expected) return { ok: false, code: 'task_correction_target_not_updated' };
    if (receiptTargets.length === 0 || receiptTargets.some(target => target !== expected)) {
      return { ok: false, code: 'task_correction_receipt_target_mismatch' };
    }
    if (targets.slice(0, index).some(rejected => receiptTargets.includes(rejected))) {
      return { ok: false, code: 'task_correction_rejected_target_reused' };
    }
  }
  return { ok: true, code: '', taskId: [...taskIds][0], corrections: 3 };
}

export function validateStatusQueryNoReplay({ beforeTask, afterTask, turnEvidence, toolEventCount }) {
  if (!beforeTask?.taskId || beforeTask.taskId !== afterTask?.taskId) {
    return { ok: false, code: 'status_query_task_identity_changed' };
  }
  if (runtimeReceiptSignature(beforeTask) !== runtimeReceiptSignature(afterTask)) {
    return { ok: false, code: 'status_query_replayed_receipt' };
  }
  if (runtimeTaskStateSignature(beforeTask) !== runtimeTaskStateSignature(afterTask)) {
    return { ok: false, code: 'status_query_mutated_task_state' };
  }
  if (Number(toolEventCount) !== 0 || (turnEvidence?.receiptIds || []).length !== 0) {
    return { ok: false, code: 'status_query_executed_tool' };
  }
  if (!turnEvidence?.userFacingReply?.persisted || turnEvidence?.userFacingReply?.internalGuardLeaked) {
    return { ok: false, code: 'status_query_reply_evidence_invalid' };
  }
  if (turnEvidence?.taskStateSignature !== runtimeTaskStateSignature(afterTask)) {
    return { ok: false, code: 'status_query_snapshot_mismatch' };
  }
  return { ok: true, code: '' };
}

export function validateCancellationLeaseRelease({ beforeTask, afterTask, turnEvidence }) {
  if (!beforeTask?.taskId || beforeTask.taskId !== afterTask?.taskId) {
    return { ok: false, code: 'task_cancel_identity_changed' };
  }
  if (afterTask?.status !== 'cancelled') return { ok: false, code: 'task_cancel_not_terminal' };
  if (afterTask?.activeRequest !== false) return { ok: false, code: 'task_cancel_lease_not_released' };
  if (normalizedEvidenceTarget(beforeTask?.target) !== normalizedEvidenceTarget(afterTask?.target)) {
    return { ok: false, code: 'task_cancel_target_changed' };
  }
  if (Number(afterTask?.revision) <= Number(beforeTask?.revision)) {
    return { ok: false, code: 'task_cancel_revision_not_advanced' };
  }
  if (!turnEvidence?.userFacingReply?.persisted || turnEvidence?.userFacingReply?.internalGuardLeaked) {
    return { ok: false, code: 'task_cancel_reply_evidence_invalid' };
  }
  return { ok: true, code: '' };
}

export function validateManualVoiceConfirmationEvidence({
  messages,
  task,
  taskId,
  toolName,
  expectedPath,
  since,
}) {
  const sinceMs = Date.parse(String(since || ''));
  if (!Number.isFinite(sinceMs)) return { ok: false, code: 'manual_voice_confirmation_since_invalid' };
  const records = (Array.isArray(messages) ? messages : []).filter(message => {
    const timestamp = persistedMessageTimestamp(message);
    return Number.isFinite(timestamp) && timestamp >= sinceMs;
  });
  const voiceUser = records.find(message => (
    message?.role === 'user'
    && isDirectVoiceMessage(message)
    && Boolean(String(message?.requestId || '').trim())
    && CONFIRMATION_TEXT_RE.test(messageText(message))
  ));
  const requestId = String(voiceUser?.requestId || '').trim();
  const userAt = persistedMessageTimestamp(voiceUser);
  const voiceAssistant = records.find(message => (
    message?.role === 'assistant'
    && isDirectVoiceMessage(message)
    && String(message?.requestId || '').trim() === requestId
    && persistedMessageTimestamp(message) >= userAt
    && parseToolCalls(message?.toolCalls).some(call => (
      call?.name === toolName
      && String(call?.taskId || '') === String(taskId || '')
      && !call?.error
      && call?.terminalVerification?.status === 'verified'
      && String(call?.arguments?.path || call?.arguments?.filePath || '') === String(expectedPath || '')
    ))
  ));
  const receipt = (Array.isArray(task?.evidence?.latest) ? task.evidence.latest : []).find(item => (
    item?.taskId === taskId
    && item?.toolName === toolName
    && item?.verification === 'verified'
    && requestId
    && String(item?.requestId || '') === requestId
    && persistedReceiptTimestamp(item) >= persistedMessageTimestamp(voiceAssistant)
  ));
  if (!voiceUser) return { ok: false, code: 'manual_voice_confirmation_user_evidence_missing' };
  if (!voiceAssistant) return { ok: false, code: 'manual_voice_confirmation_assistant_evidence_missing' };
  if (!receipt) return { ok: false, code: 'manual_voice_confirmation_receipt_missing' };
  if (!['completed', 'verifying'].includes(String(task?.status || '')) || task?.activeRequest !== false) {
    return { ok: false, code: 'manual_voice_confirmation_task_not_settled' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      taskId,
      voiceUserMessageId: String(voiceUser.id || ''),
      voiceAssistantMessageId: String(voiceAssistant.id || ''),
      requestId,
      receiptId: String(receipt.receiptId || ''),
      userFacingReplyHash: evidenceTextHash(messageText(voiceAssistant)),
    },
  };
}

function persistedMessageTimestamp(message) {
  for (const value of [message?.timestamp, message?.receivedAt, message?.createdAt]) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function persistedReceiptTimestamp(receipt) {
  for (const value of [receipt?.createdAt, receipt?.recordedAt, receipt?.completedAt, receipt?.timestamp]) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function isDirectVoiceMessage(message) {
  const source = String(message?.source || '').trim().toLowerCase();
  return /^voice(?:_|$)/u.test(source) && /voice/u.test(messageTransport(message));
}

function isTypedChatMessage(message) {
  const channel = String(message?.channel || message?.mode || '').trim().toLowerCase();
  return channel === 'chat' && !/voice/.test(String(message?.source || '').trim().toLowerCase());
}

/**
 * Validate real, persisted physical-microphone turns. This helper deliberately
 * refuses synthetic STT, voice sidecars, missing model receipts, and transcript
 * pairs that cannot be tied together by one request id.
 */
export function validateManualVoiceConversationEvidence({
  messages,
  routingReceipts,
  since,
  expectedTurns = 20,
}) {
  const required = Math.trunc(Number(expectedTurns));
  if (!Number.isFinite(required) || required < 20) {
    return { ok: false, code: 'manual_voice_turn_requirement_below_formal_minimum' };
  }
  const sinceMs = Date.parse(String(since || ''));
  if (!Number.isFinite(sinceMs)) return { ok: false, code: 'manual_voice_since_invalid' };

  const records = (Array.isArray(messages) ? messages : [])
    .filter(message => persistedMessageTimestamp(message) >= sinceMs);
  const voiceUsers = records
    .filter(message => (
      message?.role === 'user'
      && isDirectVoiceMessage(message)
      && Boolean(String(message?.id || '').trim())
      && Boolean(String(message?.requestId || '').trim())
      && Boolean(messageText(message).trim())
      && String(message?.audioInputKind || '') === 'physical_microphone'
      && message?.syntheticAudio === false
      && Boolean(String(message?.captureSessionId || '').trim())
      && Boolean(String(message?.nativeDeviceId || '').trim())
      && Boolean(String(message?.sttReceiptId || '').trim())
      && Boolean(String(message?.contextChainId || '').trim())
    ))
    .sort((left, right) => persistedMessageTimestamp(left) - persistedMessageTimestamp(right));

  if (voiceUsers.length < required) {
    return {
      ok: false,
      code: 'manual_voice_turn_count_incomplete',
      requiredTurns: required,
      observedTurns: voiceUsers.length,
    };
  }

  const selectedUsers = voiceUsers.slice(0, required);
  const requestIds = selectedUsers.map(message => String(message.requestId));
  if (new Set(requestIds).size !== requestIds.length) {
    return { ok: false, code: 'manual_voice_request_identity_reused' };
  }
  const captureSessionId = String(selectedUsers[0]?.captureSessionId || '');
  const nativeDeviceId = String(selectedUsers[0]?.nativeDeviceId || '');
  const contextChainId = String(selectedUsers[0]?.contextChainId || '');
  if (selectedUsers.some((message, index) => (
    String(message?.captureSessionId || '') !== captureSessionId
    || String(message?.nativeDeviceId || '') !== nativeDeviceId
    || String(message?.contextChainId || '') !== contextChainId
    || (index > 0 && String(message?.previousRequestId || '') !== requestIds[index - 1])
  ))) {
    return { ok: false, code: 'manual_voice_native_capture_chain_invalid' };
  }

  const receipts = Array.isArray(routingReceipts) ? routingReceipts : [];
  const turns = [];
  const assistantIds = new Set();
  for (const [index, user] of selectedUsers.entries()) {
    const requestId = String(user.requestId);
    const assistant = records.find(message => (
      message?.role === 'assistant'
      && String(message?.requestId || '') === requestId
      && isDirectVoiceMessage(message)
      && String(message?.captureSessionId || '') === captureSessionId
      && String(message?.nativeDeviceId || '') === nativeDeviceId
      && String(message?.contextChainId || '') === contextChainId
    ));
    if (!assistant || !String(assistant.id || '').trim() || !messageText(assistant).trim()) {
      return { ok: false, code: 'manual_voice_assistant_pair_missing', failedTurn: index + 1 };
    }
    if (assistantIds.has(String(assistant.id))) {
      return { ok: false, code: 'manual_voice_assistant_identity_reused', failedTurn: index + 1 };
    }
    assistantIds.add(String(assistant.id));

    const userAt = persistedMessageTimestamp(user);
    const assistantAt = persistedMessageTimestamp(assistant);
    if (!Number.isFinite(userAt) || !Number.isFinite(assistantAt) || assistantAt < userAt) {
      return { ok: false, code: 'manual_voice_turn_timestamp_invalid', failedTurn: index + 1 };
    }
    const nextUserAt = index + 1 < selectedUsers.length
      ? persistedMessageTimestamp(selectedUsers[index + 1])
      : Number.POSITIVE_INFINITY;
    if (assistantAt > nextUserAt) {
      return { ok: false, code: 'manual_voice_turns_overlap', failedTurn: index + 1 };
    }
    if (containsInternalExecutionBlock(messageText(assistant))) {
      return { ok: false, code: 'manual_voice_internal_guard_leaked', failedTurn: index + 1 };
    }

    const receipt = receipts.find(candidate => (
      String(candidate?.requestId || '') === requestId
      && String(candidate?.source || '').toLowerCase() === 'voice'
      && candidate?.status === 'succeeded'
      && String(candidate?.captureSessionId || '') === captureSessionId
      && String(candidate?.nativeDeviceId || '') === nativeDeviceId
      && String(candidate?.sttReceiptId || '') === String(user?.sttReceiptId || '')
      && String(candidate?.contextChainId || '') === contextChainId
    ));
    const route = receipt ? validateRoutingTrace({ ...receipt, ok: true }) : null;
    if (!receipt || !route?.ok || !String(receipt.id || '').trim()) {
      return { ok: false, code: 'manual_voice_routing_receipt_invalid', failedTurn: index + 1 };
    }

    turns.push({
      turn: index + 1,
      requestId,
      userMessageId: String(user.id),
      assistantMessageId: String(assistant.id),
      userTranscriptSha256: evidenceTextHash(messageText(user)),
      userTranscriptCharacters: messageText(user).length,
      assistantReplySha256: evidenceTextHash(messageText(assistant)),
      assistantReplyCharacters: messageText(assistant).length,
      latencyMs: assistantAt - userAt,
      routingReceiptId: String(receipt.id),
      selectedProvider: String(receipt.selectedProvider || ''),
      selectedModel: String(receipt.selectedModel || ''),
      routeAttemptCount: route.attemptCount,
      fallbackObserved: route.fallbackObserved,
      captureSessionId,
      nativeDeviceId,
      sttReceiptId: String(user.sttReceiptId),
      contextChainId,
    });
  }

  return {
    ok: true,
    code: '',
    evidence: {
      requiredTurns: required,
      observedTurns: turns.length,
      syntheticSttEmitted: false,
      physicalMicrophoneProvenanceVerified: true,
      captureSessionId,
      nativeDeviceId,
      contextChainId,
      turns,
    },
  };
}

export function validateVoiceToTextContinuationEvidence({
  messages,
  voiceRequestId,
  textRequestId,
  beforeTask,
  afterTask,
}) {
  const records = Array.isArray(messages) ? messages : [];
  const find = (role, requestId) => records.find(message => (
    message?.role === role && String(message?.requestId || '') === String(requestId || '')
  ));
  const voiceUser = find('user', voiceRequestId);
  const voiceAssistant = find('assistant', voiceRequestId);
  const textUser = find('user', textRequestId);
  const textAssistant = find('assistant', textRequestId);
  if (!voiceUser || !voiceAssistant || !isDirectVoiceMessage(voiceUser) || !isDirectVoiceMessage(voiceAssistant)) {
    return { ok: false, code: 'cross_channel_voice_pair_missing' };
  }
  if (!textUser || !textAssistant || !isTypedChatMessage(textUser) || !isTypedChatMessage(textAssistant)) {
    return { ok: false, code: 'cross_channel_text_pair_missing' };
  }
  if ([voiceUser, voiceAssistant, textUser, textAssistant].some(message => (
    !String(message?.id || '').trim() || !messageText(message).trim()
  ))) {
    return { ok: false, code: 'cross_channel_transcript_evidence_missing' };
  }
  if (containsInternalExecutionBlock(messageText(voiceAssistant))
    || containsInternalExecutionBlock(messageText(textAssistant))) {
    return { ok: false, code: 'cross_channel_internal_guard_leaked' };
  }

  const timestamps = [voiceUser, voiceAssistant, textUser, textAssistant]
    .map(persistedMessageTimestamp);
  if (timestamps.some(value => !Number.isFinite(value))
    || timestamps[1] < timestamps[0]
    || timestamps[2] < timestamps[1]
    || timestamps[3] < timestamps[2]) {
    return { ok: false, code: 'cross_channel_turn_order_invalid' };
  }

  const taskId = String(beforeTask?.taskId || '');
  if (!taskId || taskId !== String(afterTask?.taskId || '')) {
    return { ok: false, code: 'cross_channel_task_identity_changed' };
  }
  if (TERMINAL_BACKGROUND_STATUSES.has(String(beforeTask?.status || ''))) {
    return { ok: false, code: 'cross_channel_source_task_already_terminal' };
  }
  if (Number(afterTask?.revision) <= Number(beforeTask?.revision)) {
    return { ok: false, code: 'cross_channel_task_revision_not_advanced' };
  }
  if (beforeTask?.conversationId && afterTask?.conversationId
    && String(beforeTask.conversationId) !== String(afterTask.conversationId)) {
    return { ok: false, code: 'cross_channel_conversation_identity_changed' };
  }
  const beforeReceipts = Array.isArray(beforeTask?.evidence?.latest) ? beforeTask.evidence.latest : [];
  const afterReceipts = Array.isArray(afterTask?.evidence?.latest) ? afterTask.evidence.latest : [];
  if (!beforeReceipts.some(receipt => String(receipt?.requestId || '') === String(voiceRequestId || ''))) {
    return { ok: false, code: 'cross_channel_voice_task_receipt_missing' };
  }
  if (!afterReceipts.some(receipt => String(receipt?.requestId || '') === String(textRequestId || ''))) {
    return { ok: false, code: 'cross_channel_text_task_receipt_missing' };
  }

  return {
    ok: true,
    code: '',
    evidence: {
      taskId,
      revisionBefore: Number(beforeTask.revision),
      revisionAfter: Number(afterTask.revision),
      voiceRequestId: String(voiceRequestId || ''),
      voiceUserMessageId: String(voiceUser.id),
      voiceAssistantMessageId: String(voiceAssistant.id),
      textRequestId: String(textRequestId || ''),
      textUserMessageId: String(textUser.id),
      textAssistantMessageId: String(textAssistant.id),
      voiceTranscriptSha256: evidenceTextHash(messageText(voiceUser)),
      textContinuationSha256: evidenceTextHash(messageText(textUser)),
    },
  };
}

export function validateConfirmationRejectionEvidence({
  messages,
  beforeTask,
  afterTask,
  rejectionRequestId,
  toolName,
  artifactExists,
}) {
  if (!beforeTask?.taskId || beforeTask.taskId !== afterTask?.taskId) {
    return { ok: false, code: 'confirmation_rejection_task_identity_changed' };
  }
  if (beforeTask?.status !== 'waiting_confirmation' || beforeTask?.activeRequest !== false) {
    return { ok: false, code: 'confirmation_rejection_not_waiting' };
  }
  if (afterTask?.status !== 'cancelled' || afterTask?.activeRequest !== false) {
    return { ok: false, code: 'confirmation_rejection_not_settled' };
  }
  if (artifactExists === true) return { ok: false, code: 'confirmation_rejection_side_effect_observed' };
  const executed = (Array.isArray(afterTask?.evidence?.latest) ? afterTask.evidence.latest : [])
    .some(receipt => (
      String(receipt?.requestId || '') === String(rejectionRequestId || '')
      && String(receipt?.toolName || '') === String(toolName || '')
      && (
        ['verified', 'succeeded'].includes(String(receipt?.verification || ''))
        || ['verified_success', 'succeeded', 'completed'].includes(String(receipt?.outcome || ''))
      )
    ));
  if (executed) return { ok: false, code: 'confirmation_rejection_executed_tool' };
  const assistant = (Array.isArray(messages) ? messages : []).find(message => (
    message?.role === 'assistant'
    && String(message?.requestId || '') === String(rejectionRequestId || '')
  ));
  if (!assistant || !messageText(assistant).trim() || containsInternalExecutionBlock(messageText(assistant))) {
    return { ok: false, code: 'confirmation_rejection_reply_invalid' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      taskId: String(afterTask.taskId),
      rejectionRequestId: String(rejectionRequestId || ''),
      assistantMessageId: String(assistant.id || ''),
      replySha256: evidenceTextHash(messageText(assistant)),
      sideEffectObserved: false,
    },
  };
}

export function validateRepeatedConfirmationIdempotencyEvidence({
  messages,
  afterFirstTask,
  afterRepeatedTask,
  firstRequestId,
  repeatedRequestId,
  toolName,
  artifactSha256Before,
  artifactSha256After,
  artifactMtimeMsBefore,
  artifactMtimeMsAfter,
  artifactSizeBefore,
  artifactSizeAfter,
}) {
  if (!afterFirstTask?.taskId || afterFirstTask.taskId !== afterRepeatedTask?.taskId) {
    return { ok: false, code: 'confirmation_repeat_task_identity_changed' };
  }
  if (!['completed', 'verifying'].includes(String(afterFirstTask?.status || ''))
    || afterFirstTask?.activeRequest !== false
    || afterRepeatedTask?.activeRequest !== false) {
    return { ok: false, code: 'confirmation_repeat_task_not_settled' };
  }
  const firstReceipts = (Array.isArray(afterFirstTask?.evidence?.latest) ? afterFirstTask.evidence.latest : [])
    .filter(receipt => (
      String(receipt?.requestId || '') === String(firstRequestId || '')
      && String(receipt?.toolName || '') === String(toolName || '')
      && receipt?.verification === 'verified'
    ));
  if (firstReceipts.length !== 1) return { ok: false, code: 'confirmation_repeat_primary_execution_count_invalid' };
  const repeatedReceipts = (Array.isArray(afterRepeatedTask?.evidence?.latest) ? afterRepeatedTask.evidence.latest : [])
    .filter(receipt => (
      String(receipt?.requestId || '') === String(repeatedRequestId || '')
      && String(receipt?.toolName || '') === String(toolName || '')
      && receipt?.verification === 'verified'
    ));
  if (repeatedReceipts.length !== 0) return { ok: false, code: 'confirmation_repeat_executed_twice' };
  if (runtimeReceiptSignature(afterFirstTask) !== runtimeReceiptSignature(afterRepeatedTask)) {
    return { ok: false, code: 'confirmation_repeat_receipt_ledger_changed' };
  }
  const receiptTotal = task => Math.max(
    0,
    Number(task?.evidence?.total)
      || (Array.isArray(task?.evidence?.latest) ? task.evidence.latest.length : 0),
  );
  if (receiptTotal(afterFirstTask) !== receiptTotal(afterRepeatedTask)) {
    return { ok: false, code: 'confirmation_repeat_receipt_total_changed' };
  }
  if (!artifactSha256Before || artifactSha256Before !== artifactSha256After) {
    return { ok: false, code: 'confirmation_repeat_artifact_changed' };
  }
  if (!Number.isFinite(Number(artifactMtimeMsBefore))
    || Number(artifactMtimeMsBefore) !== Number(artifactMtimeMsAfter)
    || !Number.isFinite(Number(artifactSizeBefore))
    || Number(artifactSizeBefore) !== Number(artifactSizeAfter)) {
    return { ok: false, code: 'confirmation_repeat_artifact_metadata_changed' };
  }
  const assistant = (Array.isArray(messages) ? messages : []).find(message => (
    message?.role === 'assistant'
    && String(message?.requestId || '') === String(repeatedRequestId || '')
  ));
  if (!assistant || !messageText(assistant).trim() || containsInternalExecutionBlock(messageText(assistant))) {
    return { ok: false, code: 'confirmation_repeat_reply_invalid' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      taskId: String(afterRepeatedTask.taskId),
      firstRequestId: String(firstRequestId || ''),
      repeatedRequestId: String(repeatedRequestId || ''),
      verifiedExecutions: 1,
      artifactSha256: String(artifactSha256After),
      artifactMtimeMs: Number(artifactMtimeMsAfter),
      artifactSize: Number(artifactSizeAfter),
      repeatedAssistantMessageId: String(assistant.id || ''),
    },
  };
}

export function validatePersistedConversationScope({ conversationId, activated, active }) {
  const expected = String(conversationId || '');
  const activatedId = String(activated?.conversation?.id || '');
  const activeId = String(active?.activeConversation?.id || '');
  if (!expected || activatedId !== expected || activeId !== expected) {
    return { ok: false, code: 'manual_voice_conversation_scope_not_active' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      domain: 'personal',
      conversationId: expected,
      activatedConversationId: activatedId,
      activeApiConversationId: activeId,
    },
  };
}

export function validateRoutingTrace(value, { allowProviderProbe = false } = {}) {
  if (!value || value.ok !== true) return { ok: false, fallbackObserved: false, attemptCount: 0 };
  // Live provider probes expose latencyMs; persisted routing receipts expose
  // durationMs. Both are server-produced elapsed-time fields for the same
  // trace, so the formal validator must accept either without caller remapping.
  const latencyMs = Number(value.latencyMs ?? value.durationMs);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return { ok: false, fallbackObserved: false, attemptCount: Array.isArray(value.attempts) ? value.attempts.length : 0 };
  }
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  if (attempts.length === 0) {
    const allowedVerification = new Set(['live_model_call', 'live_routed_model_call']);
    return {
      ok: allowProviderProbe
        && allowedVerification.has(String(value.verification || ''))
        && Boolean(String(value.provider || '').trim())
        && Boolean(String(value.model || '').trim()),
      fallbackObserved: false,
      attemptCount: 0,
    };
  }
  const validStatuses = new Set(['succeeded', 'failed', 'skipped']);
  if (attempts.some(attempt => (
    !validStatuses.has(String(attempt?.status || ''))
    || !String(attempt?.provider || '').trim()
    || !String(attempt?.model || '').trim()
  ))) {
    return { ok: false, fallbackObserved: false, attemptCount: attempts.length };
  }
  const selectedProvider = String(value.selectedProvider || value.provider || '').trim();
  const selectedModel = String(value.selectedModel || value.model || '').trim();
  const succeededAttempts = attempts.filter(attempt => attempt?.status === 'succeeded');
  if (!selectedProvider || !selectedModel || succeededAttempts.length !== 1) {
    return { ok: false, fallbackObserved: false, attemptCount: attempts.length };
  }
  const selectedIndex = attempts.findIndex(attempt => (
    attempt?.status === 'succeeded'
    && String(attempt.provider || '') === selectedProvider
    && String(attempt.model || '') === selectedModel
  ));
  const succeeded = selectedIndex === attempts.length - 1;
  const ordered = succeeded && attempts.slice(0, selectedIndex)
    .every(attempt => ['failed', 'skipped'].includes(String(attempt.status || '')));
  const fallbackObserved = succeeded && (
    selectedIndex > 0
    || attempts.slice(0, selectedIndex).some(attempt => ['failed', 'skipped'].includes(attempt.status))
  );
  const fallbackConsistent = !fallbackObserved || Boolean(String(value.fallbackReason || '').trim());
  return { ok: succeeded && ordered && fallbackConsistent, fallbackObserved, attemptCount: attempts.length };
}

export function isVerifiedForcedFailoverProbe(value) {
  const trace = validateRoutingTrace(value);
  const attempts = Array.isArray(value?.attempts) ? value.attempts : [];
  const first = attempts[0];
  return Boolean(
    value?.verification === 'live_forced_primary_failure_failover'
    && trace.ok
    && trace.fallbackObserved
    && first?.provider === '__lumi_forced_unavailable_primary__'
    && first?.status === 'failed'
    && first?.reason === 'unsupported_provider_or_model'
    && value?.fallbackReason === 'unsupported_provider_or_model'
    && attempts.some(attempt => (
      attempt?.status === 'succeeded'
      && attempt?.provider !== '__lumi_forced_unavailable_primary__'
    ))
  );
}

function usage() {
  return [
    'Formal Lumi native-client E2E (safe, local-only).',
    '',
    'Usage:',
    '  node scripts/formal-client-e2e.mjs --confirm-live-e2e --data-root <absolute-path> [options]',
    '',
    'Options:',
    '  --base-url <url>              API base; default http://127.0.0.1:3000/api',
    '  --expected-build-id <sha>     Exact runtime build; default current git HEAD',
    '  --timeout-ms <ms>             Foreground turn timeout; default 180000',
    '  --background-timeout-ms <ms>  Background terminal timeout; default 600000',
    '  --manual-gate-timeout-ms <ms>  Human microphone gate timeout; default 1200000',
    '  --skip-desktop                Skip native desktop observation',
    '  --skip-multi-agent            Skip durable multi-Agent acceptance',
    '  --manual-voice-turns <count>  Wait for at least 20 real microphone conversation turns',
    '  --manual-voice-to-text        Start a task by microphone and continue it by typed confirmation',
    '  --manual-voice-confirmation   Wait for a human to say the confirmation in the real client',
    '  --evidence-root <abs-path>    Retain a bound, redacted formal evidence run',
    '  --client-pid <pid>            Expected Tauri PID used only to select authenticated /devices evidence',
    '  --client-start-at <iso>       Expected Tauri start time used only for exact selection',
    '  --client-build-id <sha>       Expected full Tauri build SHA used only for exact selection',
    '  --webview2-user-data-dir <p>  Formal WebView2 user-data directory',
    '  --webview2-profile-dir <p>    Exact formal WebView2 profile directory',
    '  --evidence-screenshot <scenario-id>=<png>  Scenario-bound screenshot; may be repeated',
    '  --evidence-log <file>         Existing log file to hash/index; may be repeated',
    '  --keep-conversation           Keep the E2E-owned conversation',
    '  --help                        Show this help without touching the runtime',
    '',
    'The script refuses non-loopback URLs. It never emits synthetic voice/STT events.',
    'Voice, cross-channel, restart, WPS, and variant checks remain incomplete unless separately evidenced.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1:3000/api',
    timeoutMs: 180_000,
    backgroundTimeoutMs: 600_000,
    manualGateTimeoutMs: 1_200_000,
    skipDesktop: false,
    skipMultiAgent: false,
    keepConversation: false,
    manualVoiceTurns: 0,
    manualVoiceToText: false,
    manualVoiceConfirmation: false,
    confirmed: false,
    help: false,
    dataRoot: '',
    expectedBuildId: '',
    evidenceRoot: '',
    clientPid: 0,
    clientStartAt: '',
    clientBuildId: '',
    webview2UserDataDir: '',
    webview2ProfileDir: '',
    evidenceScreenshots: [],
    evidenceLogs: [],
  };
  const valueFlags = new Set([
    '--base-url',
    '--data-root',
    '--expected-build-id',
    '--timeout-ms',
    '--background-timeout-ms',
    '--manual-gate-timeout-ms',
    '--manual-voice-turns',
    '--evidence-root',
    '--client-pid',
    '--client-start-at',
    '--client-build-id',
    '--webview2-user-data-dir',
    '--webview2-profile-dir',
    '--evidence-screenshot',
    '--evidence-log',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new E2EError('invalid_arguments');
      index += 1;
      if (flag === '--base-url') args.baseUrl = value;
      if (flag === '--data-root') args.dataRoot = value;
      if (flag === '--expected-build-id') args.expectedBuildId = value;
      if (flag === '--timeout-ms') args.timeoutMs = Number.parseInt(value, 10);
      if (flag === '--background-timeout-ms') args.backgroundTimeoutMs = Number.parseInt(value, 10);
      if (flag === '--manual-gate-timeout-ms') args.manualGateTimeoutMs = Number.parseInt(value, 10);
      if (flag === '--manual-voice-turns') args.manualVoiceTurns = Number.parseInt(value, 10);
      if (flag === '--evidence-root') args.evidenceRoot = value;
      if (flag === '--client-pid') args.clientPid = Number.parseInt(value, 10);
      if (flag === '--client-start-at') args.clientStartAt = value;
      if (flag === '--client-build-id') args.clientBuildId = value;
      if (flag === '--webview2-user-data-dir') args.webview2UserDataDir = value;
      if (flag === '--webview2-profile-dir') args.webview2ProfileDir = value;
      if (flag === '--evidence-screenshot') args.evidenceScreenshots.push(value);
      if (flag === '--evidence-log') args.evidenceLogs.push(value);
      continue;
    }
    if (flag === '--confirm-live-e2e') args.confirmed = true;
    else if (flag === '--skip-desktop') args.skipDesktop = true;
    else if (flag === '--skip-multi-agent') args.skipMultiAgent = true;
    else if (flag === '--manual-voice-to-text') args.manualVoiceToText = true;
    else if (flag === '--manual-voice-confirmation') args.manualVoiceConfirmation = true;
    else if (flag === '--keep-conversation') args.keepConversation = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new E2EError('invalid_arguments');
  }
  if (args.help) return args;
  if (!args.confirmed) throw new E2EError('live_confirmation_required');
  if (!args.dataRoot || !path.isAbsolute(args.dataRoot)) throw new E2EError('absolute_data_root_required');
  if (!isLoopbackBaseUrl(args.baseUrl)) throw new E2EError('loopback_api_required');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000 || args.timeoutMs > 900_000) throw new E2EError('invalid_timeout');
  if (!Number.isFinite(args.backgroundTimeoutMs) || args.backgroundTimeoutMs < 30_000 || args.backgroundTimeoutMs > 1_800_000) throw new E2EError('invalid_background_timeout');
  if (!Number.isFinite(args.manualGateTimeoutMs) || args.manualGateTimeoutMs < 30_000 || args.manualGateTimeoutMs > 1_800_000) throw new E2EError('invalid_manual_gate_timeout');
  if (!Number.isFinite(args.manualVoiceTurns) || args.manualVoiceTurns < 0 || args.manualVoiceTurns > 100
    || (args.manualVoiceTurns > 0 && args.manualVoiceTurns < 20)) {
    throw new E2EError('invalid_manual_voice_turn_count');
  }
  const nativeExpectationRequested = Boolean(
    args.clientPid || args.clientStartAt || args.clientBuildId
  );
  const retainedEvidenceRequested = Boolean(
    args.evidenceRoot
    || args.webview2UserDataDir
    || args.webview2ProfileDir
    || args.evidenceScreenshots.length
    || args.evidenceLogs.length,
  );
  if (!args.skipDesktop || retainedEvidenceRequested || nativeExpectationRequested) {
    if (!Number.isInteger(args.clientPid) || args.clientPid <= 0) throw new E2EError('native_client_identity_required');
    if (!Number.isFinite(Date.parse(String(args.clientStartAt || '')))) throw new E2EError('native_client_identity_required');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(String(args.clientBuildId || ''))) {
      throw new E2EError('native_client_identity_required');
    }
  }
  if (retainedEvidenceRequested) {
    if (args.skipDesktop) throw new E2EError('formal_evidence_requires_native_client');
    if (!args.evidenceRoot || !path.isAbsolute(args.evidenceRoot)) throw new E2EError('absolute_evidence_root_required');
    if (!args.webview2UserDataDir || !path.isAbsolute(args.webview2UserDataDir)) {
      throw new E2EError('absolute_webview2_user_data_dir_required');
    }
    if (!args.webview2ProfileDir || !path.isAbsolute(args.webview2ProfileDir)) {
      throw new E2EError('absolute_webview2_profile_dir_required');
    }
    if (!isPathInside(args.webview2UserDataDir, args.webview2ProfileDir)) {
      throw new E2EError('webview2_profile_outside_user_data_dir');
    }
    if (args.evidenceLogs.some(file => !path.isAbsolute(file))) {
      throw new E2EError('absolute_evidence_log_required');
    }
    args.evidenceRoot = path.resolve(args.evidenceRoot);
    args.webview2UserDataDir = path.resolve(args.webview2UserDataDir);
    args.webview2ProfileDir = path.resolve(args.webview2ProfileDir);
    args.evidenceScreenshots = args.evidenceScreenshots.map(parseScenarioScreenshotBinding);
    args.evidenceLogs = args.evidenceLogs.map(file => path.resolve(file));
  }
  args.baseUrl = String(args.baseUrl).replace(/\/$/, '');
  return args;
}

export function currentGitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function apiUrl(baseUrl, pathname, query = {}) {
  const url = new URL(`${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

export async function fetchJson(baseUrl, pathname, {
  token = '', method = 'GET', body, timeoutMs = 30_000, query, headers = {},
} = {}) {
  let response;
  try {
    response = await fetch(apiUrl(baseUrl, pathname, query), {
      method,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new E2EError('local_api_unreachable');
  }
  let parsed = {};
  try { parsed = await response.json(); } catch {}
  if (!response.ok) throw new E2EError(`local_api_http_${response.status}`);
  return parsed;
}

export function waitForSocketReady(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let boundary = null;
    const timer = setTimeout(() => finish(new E2EError('socket_ready_timeout')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      socket.off('runtime:execution_boundary', onBoundary);
    };
    const finish = error => {
      cleanup();
      if (error) reject(error);
      else resolve(boundary);
    };
    const maybeFinish = () => {
      if (connected && boundary) finish();
    };
    const onConnect = () => { connected = true; maybeFinish(); };
    const onError = () => finish(new E2EError('socket_auth_failed'));
    const onBoundary = payload => { boundary = payload; maybeFinish(); };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
    socket.on('runtime:execution_boundary', onBoundary);
    socket.connect();
  });
}

function emitChatAck(socket, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    socket.timeout(Math.min(timeoutMs, 30_000)).emit('agent:chat', payload, (error, ack) => {
      if (error || ack?.ok !== true || ack?.requestId !== payload.requestId) {
        reject(new E2EError('chat_ack_failed'));
        return;
      }
      resolve(ack);
    });
  });
}

export async function runTurn(socket, input) {
  const toolEvents = [];
  const delegations = [];
  let settled = false;
  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new E2EError('chat_terminal_timeout')), input.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('agent:response', onResponse);
      socket.off('agent:error', onError);
      socket.off('agent:tool_call', onTool);
      socket.off('agent:tool', onTool);
      socket.off('agent:delegation', onDelegation);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const matches = payload => payload?.requestId === input.requestId;
    const onTool = payload => {
      if (!matches(payload)) return;
      toolEvents.push({
        name: String(payload?.name || payload?.toolName || ''),
        hasResult: Boolean(String(payload?.result || '').trim()),
        hasError: Boolean(payload?.error),
      });
    };
    const onDelegation = payload => {
      if (!matches(payload)) return;
      delegations.push({
        taskId: String(payload?.taskId || payload?.task?.id || ''),
        workerCount: Array.isArray(payload?.workers) ? payload.workers.length : 0,
      });
    };
    const onError = payload => {
      if (matches(payload)) finish(new E2EError('chat_agent_error'));
    };
    const onResponse = payload => {
      if (matches(payload) && payload?.finalized === true) finish(null, payload);
    };
    socket.on('agent:response', onResponse);
    socket.on('agent:error', onError);
    socket.on('agent:tool_call', onTool);
    socket.on('agent:tool', onTool);
    socket.on('agent:delegation', onDelegation);
  });
  const ackPromise = emitChatAck(socket, {
    text: input.text,
    history: [],
    agentId: 'lumi',
    personalityId: 'lumi',
    domain: 'personal',
    source: 'e2e-formal-client',
    requestId: input.requestId,
    conversationId: input.conversationId,
  }, input.timeoutMs);
  try {
    const [response] = await Promise.all([responsePromise, ackPromise]);
    return { response, toolEvents, delegations };
  } catch (error) {
    if (!settled) settled = true;
    throw error;
  }
}

function messageText(message) {
  return String(message?.message || message?.content || message?.response || '');
}

function findAssistant(messages, requestId) {
  return (Array.isArray(messages) ? messages : []).find(message => (
    message?.role === 'assistant' && message?.requestId === requestId
  ));
}

export async function persistedMessages(baseUrl, token, conversationId) {
  const body = await fetchJson(baseUrl, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
    token,
    query: { domain: 'personal', limit: 200 },
  });
  return Array.isArray(body?.messages) ? body.messages : [];
}

export function isPathInside(basePath, candidatePath) {
  const base = path.resolve(String(basePath || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function buildOwnedArtifactLayout(dataRoot, runMarker) {
  const rawBase = String(dataRoot || '').trim();
  const marker = String(runMarker || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  if (!rawBase || !path.isAbsolute(rawBase) || !marker) throw new E2EError('e2e_artifact_root_invalid');
  const base = path.resolve(rawBase);
  const parent = path.resolve(base, 'formal-client-e2e-artifacts');
  const root = path.resolve(parent, marker);
  if (!isPathInside(base, parent) || !isPathInside(parent, root)) {
    throw new E2EError('e2e_artifact_scope_invalid');
  }
  const files = [
    'target-0.txt',
    'target-1.txt',
    'target-2.txt',
    'target-final.txt',
    'manual-voice-confirmation.txt',
  ].map(name => path.resolve(root, name));
  if (files.some(file => !isPathInside(root, file))) throw new E2EError('e2e_artifact_scope_invalid');
  return {
    marker,
    base,
    parent,
    root,
    ownerManifest: path.resolve(root, '.lumi-formal-owner.json'),
    files,
    prepared: false,
  };
}

function safeCanonicalDirectory(directory, code) {
  let metadata;
  try {
    metadata = fs.lstatSync(directory);
  } catch {
    throw new E2EError(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new E2EError(code);
  return fs.realpathSync.native(directory);
}

export function prepareOwnedArtifactLayout(layout) {
  if (!layout?.marker || !path.isAbsolute(layout?.base || '') || !path.isAbsolute(layout?.root || '')) {
    throw new E2EError('e2e_artifact_layout_invalid');
  }
  const canonicalBase = safeCanonicalDirectory(layout.base, 'e2e_data_root_not_safe');
  if (fs.existsSync(layout.parent)) {
    const canonicalParent = safeCanonicalDirectory(layout.parent, 'e2e_artifact_parent_not_safe');
    if (!isPathInside(canonicalBase, canonicalParent)) throw new E2EError('e2e_artifact_parent_not_safe');
  } else {
    fs.mkdirSync(layout.parent, { recursive: false, mode: 0o700 });
  }
  const canonicalParent = safeCanonicalDirectory(layout.parent, 'e2e_artifact_parent_not_safe');
  if (!isPathInside(canonicalBase, canonicalParent)) throw new E2EError('e2e_artifact_parent_not_safe');
  if (fs.existsSync(layout.root)) throw new E2EError('e2e_artifact_run_exists');
  fs.mkdirSync(layout.root, { recursive: false, mode: 0o700 });
  const canonicalRoot = safeCanonicalDirectory(layout.root, 'e2e_artifact_run_not_safe');
  if (!isPathInside(canonicalParent, canonicalRoot)) throw new E2EError('e2e_artifact_run_not_safe');
  const ownerManifest = path.resolve(canonicalRoot, '.lumi-formal-owner.json');
  fs.writeFileSync(ownerManifest, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'lumi-formal-owned-artifact-directory',
    marker: layout.marker,
    canonicalBase,
    canonicalRoot,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return {
    ...layout,
    base: canonicalBase,
    parent: canonicalParent,
    root: canonicalRoot,
    ownerManifest,
    files: layout.files.map(file => path.resolve(canonicalRoot, path.basename(file))),
    prepared: true,
  };
}

export function openOwnedArtifactLayout(layout) {
  if (!layout?.marker || !path.isAbsolute(layout?.base || '') || !path.isAbsolute(layout?.root || '')) {
    throw new E2EError('e2e_artifact_layout_invalid');
  }
  const canonicalBase = safeCanonicalDirectory(layout.base, 'e2e_data_root_not_safe');
  const canonicalParent = safeCanonicalDirectory(layout.parent, 'e2e_artifact_parent_not_safe');
  const canonicalRoot = safeCanonicalDirectory(layout.root, 'e2e_artifact_run_not_safe');
  if (!isPathInside(canonicalBase, canonicalParent) || !isPathInside(canonicalParent, canonicalRoot)) {
    throw new E2EError('e2e_artifact_run_not_safe');
  }
  const ownerManifest = path.resolve(canonicalRoot, '.lumi-formal-owner.json');
  let owner;
  try {
    const metadata = fs.lstatSync(ownerManifest);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('invalid');
    owner = JSON.parse(fs.readFileSync(ownerManifest, 'utf8'));
  } catch {
    throw new E2EError('e2e_artifact_owner_invalid');
  }
  if (owner?.schemaVersion !== 1
    || owner?.kind !== 'lumi-formal-owned-artifact-directory'
    || owner?.marker !== layout.marker
    || owner?.canonicalBase !== canonicalBase
    || owner?.canonicalRoot !== canonicalRoot) {
    throw new E2EError('e2e_artifact_owner_invalid');
  }
  return {
    ...layout,
    base: canonicalBase,
    parent: canonicalParent,
    root: canonicalRoot,
    ownerManifest,
    files: layout.files.map(file => path.resolve(canonicalRoot, path.basename(file))),
    prepared: true,
  };
}

export function cleanOwnedArtifactLayout(layout) {
  if (layout?.prepared !== true) return { ok: true, failedCount: 0 };
  const failed = [];
  let canonicalBase = '';
  let canonicalParent = '';
  let canonicalRoot = '';
  try {
    canonicalBase = safeCanonicalDirectory(layout.base, 'e2e_cleanup_base_not_safe');
    canonicalParent = safeCanonicalDirectory(layout.parent, 'e2e_cleanup_parent_not_safe');
    canonicalRoot = safeCanonicalDirectory(layout.root, 'e2e_cleanup_root_not_safe');
    if (canonicalBase !== layout.base
      || canonicalParent !== layout.parent
      || canonicalRoot !== layout.root
      || !isPathInside(canonicalBase, canonicalParent)
      || !isPathInside(canonicalParent, canonicalRoot)) {
      throw new Error('canonical-layout-changed');
    }
    const manifestMetadata = fs.lstatSync(layout.ownerManifest);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error('owner-manifest-invalid');
    const owner = JSON.parse(fs.readFileSync(layout.ownerManifest, 'utf8'));
    if (owner?.schemaVersion !== 1
      || owner?.kind !== 'lumi-formal-owned-artifact-directory'
      || owner?.marker !== layout.marker
      || owner?.canonicalBase !== canonicalBase
      || owner?.canonicalRoot !== canonicalRoot) {
      throw new Error('owner-manifest-mismatch');
    }
  } catch {
    return { ok: false, failedCount: 1 };
  }
  for (const file of layout?.files || []) {
    try {
      if (!isPathInside(canonicalRoot, file)) throw new Error('outside-owned-root');
      if (fs.existsSync(file)) {
        const metadata = fs.lstatSync(file);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('owned-file-not-regular');
        const canonicalFileParent = fs.realpathSync.native(path.dirname(file));
        if (canonicalFileParent !== canonicalRoot) throw new Error('owned-file-parent-changed');
        fs.unlinkSync(file);
      }
    } catch {
      failed.push(file);
    }
  }
  try {
    fs.unlinkSync(layout.ownerManifest);
  } catch {
    failed.push(layout.ownerManifest);
  }
  for (const directory of [canonicalRoot, canonicalParent]) {
    if (!directory) continue;
    try {
      const metadata = fs.lstatSync(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('cleanup-directory-not-safe');
      if (fs.realpathSync.native(directory) !== directory) throw new Error('cleanup-directory-changed');
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      failed.push(directory);
    }
  }
  return { ok: failed.length === 0, failedCount: failed.length };
}

export async function runtimeStatus(baseUrl, token) {
  return fetchJson(baseUrl, '/runtime/status', { token, query: { domain: 'personal' } });
}

export async function pollRuntimeTaskByMarker(baseUrl, token, marker, timeoutMs, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const runtime = await runtimeStatus(baseUrl, token);
    latest = findRuntimeTaskByMarker(runtime, marker);
    if (latest && predicate(latest)) return { runtime, task: latest };
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new E2EError(latest ? 'task_lifecycle_state_timeout' : 'task_lifecycle_not_persisted');
}

async function pollRuntimeTaskById(baseUrl, token, taskId, timeoutMs, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const runtime = await runtimeStatus(baseUrl, token);
    latest = (Array.isArray(runtime?.tasks) ? runtime.tasks : [])
      .find(task => String(task?.taskId || '') === String(taskId || '')) || null;
    if (latest && predicate(latest)) return { runtime, task: latest };
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new E2EError(latest ? 'task_identity_state_timeout' : 'task_identity_not_persisted');
}

async function captureLifecycleTurn(baseUrl, token, conversationId, marker, requestId, timeoutMs) {
  const [{ task }, messages] = await Promise.all([
    pollRuntimeTaskByMarker(baseUrl, token, marker, timeoutMs),
    persistedMessages(baseUrl, token, conversationId),
  ]);
  const evidence = buildLifecycleTurnEvidence({ messages, requestId, runtimeTask: task });
  requireCondition(evidence.userMessageId, 'task_lifecycle_user_message_missing');
  requireCondition(evidence.assistantMessageId, 'task_lifecycle_assistant_message_missing');
  requireCondition(evidence.userFacingReply.persisted, 'task_lifecycle_reply_missing');
  requireCondition(!evidence.userFacingReply.internalGuardLeaked, 'task_lifecycle_internal_guard_leaked');
  return { task, evidence };
}

async function routingReceiptCheck(baseUrl, token, requestId) {
  const body = await fetchJson(baseUrl, '/preferences/llm/routing-receipts', {
    token,
    query: { requestId, limit: 20 },
  });
  const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
  const succeeded = receipts.filter(receipt => receipt?.status === 'succeeded');
  const checks = succeeded.map(receipt => validateRoutingTrace({ ...receipt, ok: true }));
  if (checks.length === 0 || checks.some(check => !check.ok)) throw new E2EError('routing_receipt_invalid');
  return {
    receiptCount: succeeded.length,
    fallbackObserved: checks.some(check => check.fallbackObserved),
  };
}

async function routingReceiptsForConversation(baseUrl, token, conversationId) {
  const body = await fetchJson(baseUrl, '/preferences/llm/routing-receipts', {
    token,
    query: { conversationId, limit: 500 },
  });
  return Array.isArray(body?.receipts) ? body.receipts : [];
}

async function pollBackground(baseUrl, token, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fetchJson(baseUrl, '/autonomy/background-tasks', {
      token,
      query: { domain: 'personal', limit: 200 },
    });
    const task = (Array.isArray(body?.tasks) ? body.tasks : []).find(candidate => candidate?.id === taskId);
    if (task && TERMINAL_BACKGROUND_STATUSES.has(String(task.status || ''))) return task;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new E2EError('background_terminal_timeout');
}

export function requireCondition(condition, code) {
  if (!condition) throw new E2EError(code);
}

async function runTaskLifecycleAcceptance({
  baseUrl,
  token,
  socket,
  conversationId,
  runMarker,
  requestId,
  timeoutMs,
  artifactLayout,
}) {
  const content = `${runMarker}:task-lifecycle-confirmation-gate`;
  const turns = [
    {
      phase: 'task-create',
      text: `[${runMarker}] 创建一个仅用于正式 E2E 的确认门控文件 ${artifactLayout.files[0]}，内容严格写成 ${content}。必须调用 write_file，但不要代替用户确认；到确认边界立即停止。`,
    },
    {
      phase: 'task-correction-1',
      text: `不是 ${artifactLayout.files[0]}，把同一个任务的目标改成 ${artifactLayout.files[1]}，内容保持不变；不要沿用或重试旧目标。`,
    },
    {
      phase: 'task-correction-2',
      text: `再纠正一次：不要 ${artifactLayout.files[1]}，改成 ${artifactLayout.files[2]}，仍是同一个任务且内容不变。`,
    },
    {
      phase: 'task-correction-3',
      text: `最后一次纠正：拒绝 ${artifactLayout.files[2]}，最终目标是 ${artifactLayout.files[3]}，内容不变；等待我的确认。`,
    },
  ];
  const correctionEvidence = [];
  let taskId = '';
  for (const turn of turns) {
    const id = requestId(turn.phase);
    await runTurn(socket, {
      requestId: id,
      conversationId,
      timeoutMs,
      text: turn.text,
    });
    const captured = await captureLifecycleTurn(baseUrl, token, conversationId, runMarker, id, timeoutMs);
    requireCondition(captured.task.status === 'waiting_confirmation', `${turn.phase}_not_waiting_confirmation`);
    requireCondition(captured.task.activeRequest === false, `${turn.phase}_lease_not_yielded`);
    requireCondition(captured.evidence.receiptIds.length > 0, `${turn.phase}_receipt_missing`);
    if (taskId) requireCondition(captured.task.taskId === taskId, 'task_correction_identity_changed');
    taskId = captured.task.taskId;
    correctionEvidence.push(captured.evidence);
  }
  const correctionValidation = validateCorrectionLifecycleEvidence(
    correctionEvidence,
    artifactLayout.files.slice(0, 4),
  );
  requireCondition(correctionValidation.ok, correctionValidation.code);
  requireCondition(artifactLayout.files.every(file => !fs.existsSync(file)), 'unconfirmed_artifact_created');

  const beforeStatus = (await pollRuntimeTaskByMarker(baseUrl, token, runMarker, timeoutMs)).task;
  const statusId = requestId('task-status');
  const statusTurn = await runTurn(socket, {
    requestId: statusId,
    conversationId,
    timeoutMs,
    text: '这个任务完成了吗？只报告当前持久状态，不要执行、确认或重放任何动作。',
  });
  const statusCaptured = await captureLifecycleTurn(baseUrl, token, conversationId, runMarker, statusId, timeoutMs);
  const statusValidation = validateStatusQueryNoReplay({
    beforeTask: beforeStatus,
    afterTask: statusCaptured.task,
    turnEvidence: statusCaptured.evidence,
    toolEventCount: statusTurn.toolEvents.length,
  });
  requireCondition(statusValidation.ok, statusValidation.code);
  requireCondition(artifactLayout.files.every(file => !fs.existsSync(file)), 'status_query_created_artifact');

  const cancelId = requestId('task-cancel');
  await runTurn(socket, {
    requestId: cancelId,
    conversationId,
    timeoutMs,
    text: '取消这个任务。',
  });
  const cancelled = await pollRuntimeTaskByMarker(
    baseUrl,
    token,
    runMarker,
    timeoutMs,
    task => task.status === 'cancelled' && task.activeRequest === false,
  );
  const cancelMessages = await persistedMessages(baseUrl, token, conversationId);
  const cancelEvidence = buildLifecycleTurnEvidence({
    messages: cancelMessages,
    requestId: cancelId,
    runtimeTask: cancelled.task,
  });
  const cancelValidation = validateCancellationLeaseRelease({
    beforeTask: statusCaptured.task,
    afterTask: cancelled.task,
    turnEvidence: cancelEvidence,
  });
  requireCondition(cancelValidation.ok, cancelValidation.code);
  requireCondition(artifactLayout.files.every(file => !fs.existsSync(file)), 'cancelled_task_created_artifact');

  return {
    passed: true,
    taskId,
    correctionCount: 3,
    turns: correctionEvidence,
    statusQuery: {
      ...statusCaptured.evidence,
      receiptSignatureBefore: runtimeReceiptSignature(beforeStatus),
      receiptSignatureAfter: runtimeReceiptSignature(statusCaptured.task),
    },
    cancellation: {
      ...cancelEvidence,
      receiptSignatureBefore: runtimeReceiptSignature(statusCaptured.task),
      receiptSignatureAfter: runtimeReceiptSignature(cancelled.task),
    },
    finalStatus: cancelled.task.status,
    activeLease: cancelled.task.activeRequest,
    artifactContentSha256: evidenceTextHash(content),
  };
}

function requireNativeIsolatedConversationBinding() {
  throw new E2EError('native_isolated_conversation_binding_unavailable');
}

async function runManualVoiceConfirmationGate({
  baseUrl,
  token,
  socket,
  conversationId,
  runMarker,
  requestId,
  timeoutMs,
  manualGateTimeoutMs,
  artifactLayout,
}) {
  const scopeValidation = requireNativeIsolatedConversationBinding();
  const marker = `${runMarker}-VOICE-GATE`;
  const targetPath = artifactLayout.files[4];
  const content = `${marker}:human-microphone-confirmation`;
  const pendingRequestId = requestId('manual-voice-pending');
  await runTurn(socket, {
    requestId: pendingRequestId,
    conversationId,
    timeoutMs,
    text: `[${marker}] 创建确认门控文件 ${targetPath}，内容严格写成 ${content}。必须调用 write_file 并等待确认，不得自行确认。`,
  });
  const pending = await captureLifecycleTurn(
    baseUrl,
    token,
    conversationId,
    marker,
    pendingRequestId,
    timeoutMs,
  );
  requireCondition(pending.task.status === 'waiting_confirmation', 'manual_voice_pending_not_persisted');
  requireCondition(pending.task.activeRequest === false, 'manual_voice_pending_lease_not_yielded');
  requireCondition(pending.evidence.receiptIds.length > 0, 'manual_voice_pending_receipt_missing');
  requireCondition(!fs.existsSync(targetPath), 'manual_voice_artifact_created_before_confirmation');

  const since = new Date().toISOString();
  process.stderr.write([
    '',
    'MANUAL GATE REQUIRED — no synthetic voice/STT event will be emitted.',
    'In the real Lumi client, use the physical microphone and say “确认” once.',
    `The script will wait up to ${manualGateTimeoutMs} ms for persisted voice-channel evidence.`,
    '',
  ].join('\n'));

  const deadline = Date.now() + manualGateTimeoutMs;
  let lastCode = 'manual_voice_confirmation_timeout';
  while (Date.now() < deadline) {
    const [messages, runtime] = await Promise.all([
      persistedMessages(baseUrl, token, conversationId),
      runtimeStatus(baseUrl, token),
    ]);
    const task = findRuntimeTaskByMarker(runtime, marker);
    const validation = validateManualVoiceConfirmationEvidence({
      messages,
      task,
      taskId: pending.task.taskId,
      toolName: 'write_file',
      expectedPath: targetPath,
      since,
    });
    if (validation.ok) {
      requireCondition(fs.existsSync(targetPath), 'manual_voice_artifact_missing');
      const actual = fs.readFileSync(targetPath, 'utf8');
      requireCondition(actual === content, 'manual_voice_artifact_content_mismatch');
      return {
        passed: true,
        humanMicrophoneRequired: true,
        syntheticSttEmitted: false,
        pending: pending.evidence,
        confirmation: validation.evidence,
        persistedScope: scopeValidation.evidence,
        artifactContentSha256: evidenceTextHash(actual),
      };
    }
    lastCode = validation.code;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new E2EError(lastCode || 'manual_voice_confirmation_timeout');
}

async function runConfirmationSafetyAcceptance({
  baseUrl,
  token,
  socket,
  conversationId,
  runMarker,
  requestId,
  timeoutMs,
  artifactLayout,
}) {
  const rejectionMarker = `${runMarker}-REJECTION-GATE`;
  const rejectionPath = artifactLayout.files[0];
  const rejectionContent = `${rejectionMarker}:must-never-be-written`;
  const rejectionPendingId = requestId('confirmation-rejection-pending');
  await runTurn(socket, {
    requestId: rejectionPendingId,
    conversationId,
    timeoutMs,
    text: `[${rejectionMarker}] Create the formal E2E confirmation-gated file ${rejectionPath} with exact content ${rejectionContent}. Call write_file, but stop at the confirmation boundary and do not self-confirm.`,
  });
  const rejectionPending = await captureLifecycleTurn(
    baseUrl,
    token,
    conversationId,
    rejectionMarker,
    rejectionPendingId,
    timeoutMs,
  );
  requireCondition(rejectionPending.task.status === 'waiting_confirmation', 'confirmation_rejection_pending_not_waiting');
  requireCondition(rejectionPending.task.activeRequest === false, 'confirmation_rejection_pending_lease_not_yielded');
  requireCondition(!fs.existsSync(rejectionPath), 'confirmation_rejection_artifact_created_early');

  const rejectionId = requestId('confirmation-rejection');
  const rejectionTurn = await runTurn(socket, {
    requestId: rejectionId,
    conversationId,
    timeoutMs,
    text: '\u62d2\u7edd',
  });
  requireCondition(rejectionTurn.toolEvents.length === 0, 'confirmation_rejection_tool_event_observed');
  const rejectionSettled = await pollRuntimeTaskByMarker(
    baseUrl,
    token,
    rejectionMarker,
    timeoutMs,
    task => task.status === 'cancelled' && task.activeRequest === false,
  );
  const rejectionMessages = await persistedMessages(baseUrl, token, conversationId);
  const rejection = validateConfirmationRejectionEvidence({
    messages: rejectionMessages,
    beforeTask: rejectionPending.task,
    afterTask: rejectionSettled.task,
    rejectionRequestId: rejectionId,
    toolName: 'write_file',
    artifactExists: fs.existsSync(rejectionPath),
  });
  requireCondition(rejection.ok, rejection.code);

  const repeatMarker = `${runMarker}-REPEAT-GATE`;
  const repeatPath = artifactLayout.files[1];
  const repeatContent = `${repeatMarker}:write-exactly-once`;
  const repeatPendingId = requestId('confirmation-repeat-pending');
  await runTurn(socket, {
    requestId: repeatPendingId,
    conversationId,
    timeoutMs,
    text: `[${repeatMarker}] Create the formal E2E confirmation-gated file ${repeatPath} with exact content ${repeatContent}. Call write_file, but stop at the confirmation boundary and do not self-confirm.`,
  });
  const repeatPending = await captureLifecycleTurn(
    baseUrl,
    token,
    conversationId,
    repeatMarker,
    repeatPendingId,
    timeoutMs,
  );
  requireCondition(repeatPending.task.status === 'waiting_confirmation', 'confirmation_repeat_pending_not_waiting');
  requireCondition(!fs.existsSync(repeatPath), 'confirmation_repeat_artifact_created_early');

  const firstConfirmationId = requestId('confirmation-repeat-first');
  await runTurn(socket, {
    requestId: firstConfirmationId,
    conversationId,
    timeoutMs,
    text: '\u786e\u8ba4',
  });
  const afterFirst = await pollRuntimeTaskByMarker(
    baseUrl,
    token,
    repeatMarker,
    timeoutMs,
    task => ['completed', 'verifying'].includes(task.status) && task.activeRequest === false,
  );
  requireCondition(fs.existsSync(repeatPath), 'confirmation_repeat_artifact_missing');
  const firstArtifact = fs.readFileSync(repeatPath, 'utf8');
  requireCondition(firstArtifact === repeatContent, 'confirmation_repeat_artifact_content_mismatch');
  const artifactSha256Before = evidenceTextHash(firstArtifact);
  const artifactMetadataBefore = fs.statSync(repeatPath);

  const repeatedConfirmationId = requestId('confirmation-repeat-second');
  const repeatedTurn = await runTurn(socket, {
    requestId: repeatedConfirmationId,
    conversationId,
    timeoutMs,
    text: '\u786e\u8ba4',
  });
  requireCondition(repeatedTurn.toolEvents.length === 0, 'confirmation_repeat_tool_event_observed');
  const [afterRepeatedRuntime, repeatedMessages] = await Promise.all([
    runtimeStatus(baseUrl, token),
    persistedMessages(baseUrl, token, conversationId),
  ]);
  const afterRepeatedTask = findRuntimeTaskByMarker(afterRepeatedRuntime, repeatMarker);
  requireCondition(afterRepeatedTask, 'confirmation_repeat_task_lost');
  requireCondition(fs.existsSync(repeatPath), 'confirmation_repeat_artifact_removed');
  const repeatedArtifact = fs.readFileSync(repeatPath, 'utf8');
  const artifactMetadataAfter = fs.statSync(repeatPath);
  const idempotency = validateRepeatedConfirmationIdempotencyEvidence({
    messages: repeatedMessages,
    afterFirstTask: afterFirst.task,
    afterRepeatedTask,
    firstRequestId: firstConfirmationId,
    repeatedRequestId: repeatedConfirmationId,
    toolName: 'write_file',
    artifactSha256Before,
    artifactSha256After: evidenceTextHash(repeatedArtifact),
    artifactMtimeMsBefore: artifactMetadataBefore.mtimeMs,
    artifactMtimeMsAfter: artifactMetadataAfter.mtimeMs,
    artifactSizeBefore: artifactMetadataBefore.size,
    artifactSizeAfter: artifactMetadataAfter.size,
  });
  requireCondition(idempotency.ok, idempotency.code);

  return {
    passed: true,
    rejection: {
      ...rejection.evidence,
      pendingRequestId: rejectionPendingId,
    },
    repeatedConfirmation: {
      ...idempotency.evidence,
      pendingRequestId: repeatPendingId,
    },
  };
}

async function runManualVoiceToTextContinuationGate({
  baseUrl,
  token,
  socket,
  conversationId,
  runMarker,
  requestId,
  timeoutMs,
  manualGateTimeoutMs,
  artifactLayout,
}) {
  const scopeValidation = requireNativeIsolatedConversationBinding();
  const marker = `${runMarker}-VOICE-TO-TEXT`;
  const targetPath = artifactLayout.files[2];
  const content = `${marker}:same-task-cross-channel`;
  const contextRequestId = requestId('voice-to-text-context');
  const contextTurn = await runTurn(socket, {
    requestId: contextRequestId,
    conversationId,
    timeoutMs,
    text: `[${marker}] Remember these two inert E2E values for the next turn: targetPath=${targetPath}; exactContent=${content}. This turn is context only. Do not call any tool and do not create a task yet.`,
  });
  requireCondition(contextTurn.toolEvents.length === 0, 'cross_channel_context_used_tool');
  requireCondition(!contextTurn.response?.blocked && !containsInternalExecutionBlock(contextTurn.response?.text), 'cross_channel_context_blocked');

  const beforeRuntime = await runtimeStatus(baseUrl, token);
  const existingTaskIds = new Set((Array.isArray(beforeRuntime?.tasks) ? beforeRuntime.tasks : [])
    .map(task => String(task?.taskId || '')).filter(Boolean));
  const since = new Date().toISOString();
  process.stderr.write([
    '',
    'MANUAL VOICE-TO-TEXT CONTINUATION GATE REQUIRED - no synthetic voice/STT event will be emitted.',
    'In the real Lumi client, use the physical microphone and say:',
    '  "\u73b0\u5728\u6309\u521a\u624d\u7ea6\u5b9a\u7684\u8def\u5f84\u548c\u5185\u5bb9\u521b\u5efa\u6587\u4ef6\uff0c\u5230\u786e\u8ba4\u8fb9\u754c\u5c31\u505c\u4e0b\u3002"',
    'The harness will type the confirmation only after it observes a persisted voice task waiting for confirmation.',
    '',
  ].join('\n'));

  const deadline = Date.now() + manualGateTimeoutMs;
  let voiceUser = null;
  let beforeTask = null;
  while (Date.now() < deadline && (!voiceUser || !beforeTask)) {
    const [messages, runtime] = await Promise.all([
      persistedMessages(baseUrl, token, conversationId),
      runtimeStatus(baseUrl, token),
    ]);
    const voiceUsers = messages.filter(message => (
      message?.role === 'user'
      && isDirectVoiceMessage(message)
      && persistedMessageTimestamp(message) >= Date.parse(since)
    ));
    const candidates = (Array.isArray(runtime?.tasks) ? runtime.tasks : []).filter(task => (
      !existingTaskIds.has(String(task?.taskId || ''))
      && task?.status === 'waiting_confirmation'
      && task?.activeRequest === false
      && (!task?.conversationId || String(task.conversationId) === conversationId)
    ));
    for (const candidate of candidates) {
      const receipts = Array.isArray(candidate?.evidence?.latest) ? candidate.evidence.latest : [];
      const matchedUser = voiceUsers.find(message => receipts.some(receipt => (
        String(receipt?.requestId || '') === String(message?.requestId || '')
      )));
      if (matchedUser) {
        voiceUser = matchedUser;
        beforeTask = candidate;
        break;
      }
    }
    if (!voiceUser || !beforeTask) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  requireCondition(voiceUser && beforeTask, 'cross_channel_voice_task_timeout');
  requireCondition(!fs.existsSync(targetPath), 'cross_channel_artifact_created_before_text_confirmation');
  const voiceRequestId = String(voiceUser.requestId || '');
  const voiceRouting = await routingReceiptCheck(baseUrl, token, voiceRequestId);

  const textRequestId = requestId('voice-to-text-confirmation');
  await runTurn(socket, {
    requestId: textRequestId,
    conversationId,
    timeoutMs,
    text: '\u786e\u8ba4',
  });
  const after = await pollRuntimeTaskById(
    baseUrl,
    token,
    beforeTask.taskId,
    timeoutMs,
    task => ['completed', 'verifying'].includes(task.status) && task.activeRequest === false,
  );
  requireCondition(fs.existsSync(targetPath), 'cross_channel_artifact_missing');
  const actual = fs.readFileSync(targetPath, 'utf8');
  requireCondition(actual === content, 'cross_channel_artifact_content_mismatch');
  const messages = await persistedMessages(baseUrl, token, conversationId);
  const validation = validateVoiceToTextContinuationEvidence({
    messages,
    voiceRequestId,
    textRequestId,
    beforeTask,
    afterTask: after.task,
  });
  requireCondition(validation.ok, validation.code);
  return {
    passed: true,
    humanMicrophoneRequired: true,
    syntheticSttEmitted: false,
    persistedScope: scopeValidation.evidence,
    continuation: validation.evidence,
    voiceRoutingReceiptCount: voiceRouting.receiptCount,
    artifactSha256: evidenceTextHash(actual),
  };
}

async function runManualVoiceConversationGate({
  baseUrl,
  token,
  conversationId,
  expectedTurns,
  manualGateTimeoutMs,
}) {
  const scopeValidation = requireNativeIsolatedConversationBinding();

  const since = new Date().toISOString();
  process.stderr.write([
    '',
    'MANUAL 20-TURN MICROPHONE GATE REQUIRED - no synthetic voice/STT event will be emitted.',
    `In the real Lumi client, complete ${expectedTurns} short natural exchanges using only the physical microphone.`,
    'Wait for Lumi to finish each reply. Do not type these turns and do not use a replayed audio file.',
    `The script will wait up to ${manualGateTimeoutMs} ms for persisted transcript and model-routing evidence.`,
    '',
  ].join('\n'));

  const deadline = Date.now() + manualGateTimeoutMs;
  let lastValidation = {
    ok: false,
    code: 'manual_voice_turn_count_incomplete',
    requiredTurns: expectedTurns,
    observedTurns: 0,
  };
  while (Date.now() < deadline) {
    const [messages, routingReceipts] = await Promise.all([
      persistedMessages(baseUrl, token, conversationId),
      routingReceiptsForConversation(baseUrl, token, conversationId),
    ]);
    lastValidation = validateManualVoiceConversationEvidence({
      messages,
      routingReceipts,
      since,
      expectedTurns,
    });
    if (lastValidation.ok) {
      return {
        passed: true,
        humanMicrophoneRequired: true,
        syntheticSttEmitted: false,
        persistedScope: scopeValidation.evidence,
        startedAt: since,
        ...lastValidation.evidence,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const observed = Number(lastValidation?.observedTurns) || 0;
  throw new E2EError(`${lastValidation?.code || 'manual_voice_conversation_timeout'}:${observed}/${expectedTurns}`);
}

async function finalizeFormalAcceptanceEvidence({
  evidenceRun,
  baseUrl,
  token,
  conversationId,
  runMarker,
  summary,
  artifactLayout,
  screenshots,
  logs,
}) {
  const counts = {
    taskReceipts: 0,
    taskTimeline: 0,
    modelRouting: 0,
    userFeedback: 0,
    logIndex: 0,
    logs: 0,
    artifacts: 0,
    screenshots: 0,
  };
  const scenarioEvidence = Object.fromEntries(FORMAL_STAGE9_SCENARIOS.map(id => [id, Object.fromEntries(
    FORMAL_SCENARIO_EVIDENCE_CATEGORIES.map(category => [category, 0]),
  )]));
  const requestScenarios = new Map();
  const taskScenarios = new Map();
  const bindIdentity = (map, identity, scenarioId) => {
    const key = String(identity || '').trim();
    if (!key || !FORMAL_STAGE9_SCENARIOS.includes(scenarioId)) return;
    const current = map.get(key) || new Set();
    current.add(scenarioId);
    map.set(key, current);
  };
  const markScenarios = (scenarioIds, category) => {
    if (!FORMAL_SCENARIO_EVIDENCE_CATEGORIES.includes(category)) return;
    for (const scenarioId of scenarioIds || []) {
      if (scenarioEvidence[scenarioId]) scenarioEvidence[scenarioId][category] += 1;
    }
  };
  const markRequest = (requestId, category) => markScenarios(
    requestScenarios.get(String(requestId || '').trim()),
    category,
  );
  const markTask = (taskId, category) => markScenarios(
    taskScenarios.get(String(taskId || '').trim()),
    category,
  );
  const scenariosForRequest = requestId => [
    ...(requestScenarios.get(String(requestId || '').trim()) || []),
  ].sort();
  const scenariosForTask = taskId => [
    ...(taskScenarios.get(String(taskId || '').trim()) || []),
  ].sort();
  const requestBelongsToRun = requestId => {
    const normalized = String(requestId || '').trim();
    return requestScenarios.has(normalized) || normalized.includes(runMarker.toLowerCase());
  };

  const lifecycle = summary?.checks?.taskLifecycle;
  for (const turn of Array.isArray(lifecycle?.turns) ? lifecycle.turns : []) {
    for (const scenarioId of ['task_correction_three_times', 'confirmation_waiting']) {
      bindIdentity(requestScenarios, turn?.requestId, scenarioId);
      bindIdentity(taskScenarios, turn?.taskId, scenarioId);
    }
  }
  bindIdentity(requestScenarios, lifecycle?.statusQuery?.requestId, 'task_status_query');
  bindIdentity(taskScenarios, lifecycle?.statusQuery?.taskId, 'task_status_query');

  const confirmationSafety = summary?.checks?.confirmationSafety;
  for (const requestId of [
    confirmationSafety?.rejection?.pendingRequestId,
    confirmationSafety?.rejection?.rejectionRequestId,
  ]) bindIdentity(requestScenarios, requestId, 'confirmation_rejection');
  bindIdentity(taskScenarios, confirmationSafety?.rejection?.taskId, 'confirmation_rejection');
  for (const requestId of [
    confirmationSafety?.repeatedConfirmation?.pendingRequestId,
    confirmationSafety?.repeatedConfirmation?.firstRequestId,
    confirmationSafety?.repeatedConfirmation?.repeatedRequestId,
  ]) bindIdentity(requestScenarios, requestId, 'repeated_confirmation_idempotency');
  bindIdentity(
    taskScenarios,
    confirmationSafety?.repeatedConfirmation?.taskId,
    'repeated_confirmation_idempotency',
  );

  const voiceTurns = summary?.manualGates?.microphoneConversation?.evidence?.turns;
  for (const turn of Array.isArray(voiceTurns) ? voiceTurns : []) {
    bindIdentity(requestScenarios, turn?.requestId, 'physical_microphone_20_turns');
  }
  const crossChannel = summary?.manualGates?.voiceToTextContinuation?.evidence?.continuation;
  for (const requestId of [crossChannel?.voiceRequestId, crossChannel?.textRequestId]) {
    bindIdentity(requestScenarios, requestId, 'voice_to_text_same_task_continuation');
  }
  bindIdentity(taskScenarios, crossChannel?.taskId, 'voice_to_text_same_task_continuation');
  bindIdentity(
    requestScenarios,
    summary?.checks?.multiAgent?.requestId,
    'multi_agent_durable_completion',
  );
  bindIdentity(
    taskScenarios,
    summary?.checks?.multiAgent?.taskId,
    'multi_agent_durable_completion',
  );

  if (token && conversationId) {
    const [runtime, messages, routingReceipts] = await Promise.all([
      runtimeStatus(baseUrl, token),
      persistedMessages(baseUrl, token, conversationId),
      routingReceiptsForConversation(baseUrl, token, conversationId),
    ]);
    const ownedTasks = (Array.isArray(runtime?.tasks) ? runtime.tasks : []).filter(task => (
      String(task?.goal || '').includes(runMarker)
    ));
    for (const task of ownedTasks) {
      evidenceRun.appendTaskTimeline({
        scenarioIds: scenariosForTask(task?.taskId),
        taskId: String(task?.taskId || ''),
        conversationId: String(task?.conversationId || conversationId),
        status: String(task?.status || ''),
        revision: Math.max(0, Number(task?.revision) || 0),
        activeRequest: task?.activeRequest === true,
        goalSha256: evidenceTextHash(task?.goal || ''),
        updatedAt: String(task?.updatedAt || ''),
        source: 'runtime-final-snapshot',
      });
      counts.taskTimeline += 1;
      markTask(task?.taskId, 'taskTimeline');
      for (const receipt of Array.isArray(task?.evidence?.latest) ? task.evidence.latest : []) {
        evidenceRun.appendTaskReceipt({
          scenarioIds: scenariosForRequest(receipt?.requestId),
          receiptId: String(receipt?.receiptId || receipt?.id || ''),
          taskId: String(receipt?.taskId || task?.taskId || ''),
          requestId: String(receipt?.requestId || ''),
          toolName: String(receipt?.toolName || ''),
          outcome: String(receipt?.outcome || ''),
          verification: String(receipt?.verification || ''),
          resultSha256: evidenceTextHash(receipt?.result || ''),
        });
        counts.taskReceipts += 1;
        markRequest(receipt?.requestId, 'taskReceipts');
      }
    }

    for (const [phase, turn] of [
      ...(Array.isArray(lifecycle?.turns)
        ? lifecycle.turns.map((item, index) => [`correction-${index}`, item])
        : []),
      ['status-query', lifecycle?.statusQuery],
      ['cancellation', lifecycle?.cancellation],
    ]) {
      if (!turn?.taskId || !turn?.requestId) continue;
      evidenceRun.appendTaskTimeline({
        scenarioIds: scenariosForRequest(turn.requestId),
        phase,
        taskId: String(turn.taskId),
        requestId: String(turn.requestId),
        status: String(turn.taskStatus || ''),
        revision: Math.max(0, Number(turn.taskRevision) || 0),
        receiptIds: Array.isArray(turn.receiptIds) ? turn.receiptIds.map(String) : [],
        assistantReplySha256: String(turn.userFacingReply?.sha256 || ''),
        source: 'lifecycle-turn-snapshot',
      });
      counts.taskTimeline += 1;
      markRequest(turn.requestId, 'taskTimeline');
    }

    for (const receipt of routingReceipts.filter(item => requestBelongsToRun(item?.requestId))) {
      evidenceRun.appendModelRouting({
        scenarioIds: scenariosForRequest(receipt?.requestId),
        id: String(receipt?.id || ''),
        conversationId: String(receipt?.conversationId || ''),
        requestId: String(receipt?.requestId || ''),
        interactionId: String(receipt?.interactionId || ''),
        source: String(receipt?.source || ''),
        status: String(receipt?.status || ''),
        requestedProvider: String(receipt?.requestedProvider || ''),
        requestedModel: String(receipt?.requestedModel || ''),
        selectionMode: String(receipt?.selectionMode || ''),
        selectedProvider: String(receipt?.selectedProvider || ''),
        selectedModel: String(receipt?.selectedModel || ''),
        fallbackReason: String(receipt?.fallbackReason || ''),
        attempts: Array.isArray(receipt?.attempts) ? receipt.attempts : [],
        startedAt: String(receipt?.startedAt || ''),
        completedAt: String(receipt?.completedAt || ''),
        durationMs: Math.max(0, Number(receipt?.durationMs) || 0),
      });
      counts.modelRouting += 1;
      markRequest(receipt?.requestId, 'modelRouting');
    }

    for (const message of (Array.isArray(messages) ? messages : []).filter(item => (
      item?.role === 'assistant' && requestBelongsToRun(item?.requestId)
    ))) {
      const reply = messageText(message);
      evidenceRun.appendUserFeedback({
        scenarioIds: scenariosForRequest(message?.requestId),
        messageId: String(message?.id || ''),
        requestId: String(message?.requestId || ''),
        source: String(message?.source || ''),
        channel: String(message?.channel || ''),
        cognitiveIntent: String(message?.cognitiveIntent || ''),
        completionStatus: String(message?.completionFeedback?.status || ''),
        replySha256: evidenceTextHash(reply),
        replyCharacters: reply.length,
        internalGuardLeaked: containsInternalExecutionBlock(reply),
        timestamp: String(message?.timestamp || message?.receivedAt || ''),
      });
      counts.userFeedback += 1;
      markRequest(message?.requestId, 'userFeedback');
    }
  }

  for (const logPath of logs || []) {
    await evidenceRun.copyRedactedLog(logPath, {
      relativePath: `main-client/${path.basename(logPath)}.redacted.log`,
      metadata: { runMarker, kind: 'formal-runtime-log-snapshot' },
    });
    counts.logIndex += 1;
    counts.logs += 1;
  }
  for (const file of artifactLayout?.files || []) {
    if (!fs.existsSync(file)) continue;
    const artifactScenarioIds = [];
    if (file === artifactLayout?.files?.[1]) artifactScenarioIds.push('repeated_confirmation_idempotency');
    if (file === artifactLayout?.files?.[2]) artifactScenarioIds.push('voice_to_text_same_task_continuation');
    await evidenceRun.copyArtifact(file, {
      relativePath: `main-client/${path.basename(file)}`,
      metadata: { runMarker, scenarioIds: artifactScenarioIds, kind: 'formal-owned-test-artifact' },
    });
    counts.artifacts += 1;
    markScenarios(artifactScenarioIds, 'artifacts');
  }
  for (const [index, screenshot] of (screenshots || []).entries()) {
    const screenshotPath = typeof screenshot === 'string' ? screenshot : screenshot?.sourcePath;
    const scenarioId = typeof screenshot === 'string' ? '' : String(screenshot?.scenarioId || '');
    await evidenceRun.registerScreenshot(screenshotPath, {
      relativePath: `main-client/screenshot-${String(index + 1).padStart(2, '0')}.png`,
      metadata: {
        runMarker,
        scenarioId,
        suppliedBy: 'human-operator',
        provenanceVerified: false,
        excludedFromAcceptanceGate: true,
      },
    });
    counts.screenshots += 1;
  }

  summary.evidenceScenarioCoverage = evaluateFormalScenarioEvidenceCoverage({
    checks: summary.stage9Checks,
    evidence: scenarioEvidence,
  });
  summary.stage9Checks.screenshots_receipts_timeline_routing_artifacts_feedback =
    summary.evidenceScenarioCoverage.complete;
  summary.formalCoverage = evaluateFormalStage9Coverage(summary.stage9Checks);
  summary.coverageComplete = summary.formalCoverage.stage9Complete;
  summary.fullAcceptance = false;
  summary.acceptanceDecision = 'not_adjudicated';
  summary.acceptancePassed = false;
  const finalized = await evidenceRun.finalize({
    checks: Object.fromEntries(FORMAL_STAGE9_REQUIREMENTS.map(id => [id, summary.stage9Checks[id] === true])),
    scenarioCoverage: summary.evidenceScenarioCoverage,
  });
  return {
    runId: finalized.runId,
    runDirectory: evidenceRun.runDirectory,
    status: finalized.status,
    evidenceCounts: finalized.evidenceCounts,
    missing: finalized.missing,
    integrityFailures: finalized.integrityFailures,
    finalSummaryPath: finalized.finalSummaryPath,
    finalSummarySha256: finalized.finalSummarySha256,
    retained: finalized.evidenceRetained,
  };
}

async function runFormalE2E(args) {
  const expectedBuildId = args.expectedBuildId || process.env.LUMI_EXPECT_BUILD_ID || currentGitHead();
  requireCondition(/^[a-f0-9]{7,64}$/i.test(expectedBuildId), 'expected_build_id_required');
  const runMarker = `LUMI-E2E-${crypto.randomBytes(8).toString('hex')}`;
  const requestId = phase => `e2e-${runMarker.toLowerCase()}-${phase}`;
  let artifactLayout = buildOwnedArtifactLayout(args.dataRoot, runMarker);
  const summary = {
    ok: false,
    packageComplete: false,
    coverageComplete: false,
    fullAcceptance: false,
    identityVerified: false,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    runtime: { healthy: false, buildMatches: false, sourceClean: false },
    socket: { trustedLocal: false, registeredByHarness: false },
    nativeClient: {
      status: args.skipDesktop ? 'skipped' : 'pending',
      proofBoundIdentityVerified: false,
      osAttested: false,
      webviewProfileTrustLevel: 'unbound',
      webviewProfileBound: false,
      formalAcceptanceEligible: false,
    },
    checks: {},
    stage9Checks: {},
    formalCoverage: evaluateFormalStage9Coverage(),
    manualGates: {
      microphoneConversation: {
        required: true,
        status: args.manualVoiceTurns >= 20 ? 'pending' : 'not_run',
        syntheticSttEmitted: false,
        requiredVoiceTurns: 20,
        claimedVoiceTurns: 0,
      },
      voiceToTextContinuation: {
        required: true,
        status: args.manualVoiceToText ? 'pending' : 'not_run',
        syntheticSttEmitted: false,
      },
      microphoneVoiceConfirmation: {
        required: true,
        status: args.manualVoiceConfirmation ? 'pending' : 'not_run',
        syntheticSttEmitted: false,
        claimedVoiceTurns: 0,
      },
    },
    cleanup: {
      conversationDeleted: false,
      backgroundAuditRetained: false,
      ownedArtifactFilesRemoved: false,
      ownedArtifactCleanupFailedCount: 0,
    },
    evidence: args.evidenceRoot
      ? { status: 'not_started', retained: false }
      : { status: 'not_requested', retained: false },
  };
  let token = '';
  let desktopSessionProof = '';
  let conversationId = '';
  let socket = null;
  let backgroundCreated = false;
  let evidenceRun = null;
  let evidenceFinalized = false;
  let nativeClientEvidence = null;
  try {
    artifactLayout = prepareOwnedArtifactLayout(artifactLayout);
    const bootstrap = await bootstrapDesktopTestSession(args.baseUrl, args.dataRoot, { timeoutMs: 15_000 });
    token = String(bootstrap?.token || '');
    desktopSessionProof = String(bootstrap?.desktopSessionProof || '');
    requireCondition(token && desktopSessionProof, 'desktop_bootstrap_invalid');

    const health = await fetchJson(args.baseUrl, '/health', { token, query: { details: 1 } });
    summary.runtime.healthy = health?.status === 'ok' && health?.database?.persistence?.degraded !== true;
    summary.runtime.buildMatches = String(health?.runtime?.buildId || '') === expectedBuildId;
    summary.runtime.sourceClean = health?.runtime?.sourceDirty === false;
    requireCondition(summary.runtime.healthy, 'runtime_health_failed');
    requireCondition(summary.runtime.buildMatches, 'runtime_build_mismatch');
    requireCondition(summary.runtime.sourceClean, 'runtime_source_dirty');

    if (!args.skipDesktop || args.evidenceRoot) {
      const devices = await fetchJson(args.baseUrl, '/devices/native-client-evidence', {
        token,
        headers: { [DESKTOP_SESSION_HEADER]: desktopSessionProof },
      });
      const selectedNativeClient = selectFormalE2ENativeClientEvidence(
        Array.isArray(devices?.devices) ? devices.devices : [],
        {
          pid: args.clientPid,
          startedAt: args.clientStartAt,
          buildId: args.clientBuildId,
        },
        expectedBuildId,
      );
      requireCondition(selectedNativeClient.ok, selectedNativeClient.code);
      nativeClientEvidence = selectedNativeClient.evidence;
      summary.nativeClient = {
        status: 'selected_from_authenticated_device_registry',
        deviceId: nativeClientEvidence.deviceId,
        identityFingerprint: nativeClientEvidence.identityFingerprint,
        clientKind: nativeClientEvidence.clientKind,
        proofBoundIdentityVerified: nativeClientEvidence.identityVerified === true,
        sourceClean: nativeClientEvidence.sourceDirty === false,
        executableHashVerified: nativeClientEvidence.binaryHashUnavailable === false
          && /^[a-f0-9]{64}$/i.test(String(nativeClientEvidence.executableSha256 || '')),
        trustLevel: nativeClientEvidence.trustLevel,
        osAttested: false,
        webviewProfileTrustLevel: 'unbound',
        webviewProfileBound: false,
        formalAcceptanceEligible: false,
      };
    }

    if (args.evidenceRoot) {
      requireCondition(nativeClientEvidence, 'formal_native_client_evidence_required');
      evidenceRun = createFormalAcceptanceEvidenceRun({
        evidenceRoot: args.evidenceRoot,
        buildId: expectedBuildId,
        dataRoot: args.dataRoot,
        profile: {
          userDataDir: args.webview2ProfileDir,
          webview2UserDataDir: args.webview2UserDataDir,
          identitySource: 'operator_path_binding_unverified',
          identityVerified: false,
          webviewProfileTrustLevel: 'unbound',
          webviewProfileBound: false,
        },
        runtime: {
          ...health.runtime,
          identitySource: 'authenticated_detailed_health',
          identityVerified: true,
        },
        client: nativeClientEvidence,
      });
      summary.evidence = {
        status: 'collecting',
        runId: evidenceRun.runId,
        runDirectory: evidenceRun.runDirectory,
        retained: true,
        clientIdentityVerified: true,
        clientIdentitySource: nativeClientEvidence.identitySource,
        nativeDeviceId: nativeClientEvidence.deviceId,
        nativeClientIdentityFingerprint: nativeClientEvidence.identityFingerprint,
        osAttested: false,
        webviewProfileTrustLevel: 'unbound',
        webviewProfileBound: false,
        formalAcceptanceEligible: false,
      };
    }

    socket = createSocketClient(new URL(args.baseUrl).origin, {
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      transports: ['websocket'],
      auth: { token, desktopSessionProof },
    });
    const boundary = await waitForSocketReady(socket, 15_000);
    summary.socket.trustedLocal = boundary?.trustedLocalExecution === true;
    requireCondition(summary.socket.trustedLocal, 'trusted_local_boundary_required');

    if (!args.skipDesktop) requireCondition(nativeClientEvidence, 'native_desktop_not_connected');

    const created = await fetchJson(args.baseUrl, '/conversations/new', {
      token,
      method: 'POST',
      body: { agentId: 'lumi', domain: 'personal', activation: 'isolated' },
      query: { domain: 'personal' },
    });
    conversationId = String(created?.conversation?.id || '');
    requireCondition(conversationId, 'conversation_create_failed');

    const cupCode = `cup-${crypto.randomBytes(5).toString('hex')}`;
    const firstId = requestId('natural');
    const first = await runTurn(socket, {
      requestId: firstId,
      conversationId,
      timeoutMs: args.timeoutMs,
      text: `[${runMarker}] 这是虚构的上下文验收，不需要任何工具。请记住杯子代号 ${cupCode}，只简短确认已经记住。`,
    });
    requireCondition(first.toolEvents.length === 0, 'natural_chat_used_tool');
    requireCondition(!first.response?.blocked && !containsInternalExecutionBlock(first.response?.text), 'natural_chat_internal_block');
    requireCondition(first.response?.completionFeedback === undefined, 'natural_chat_fake_task_feedback');
    let messages = await persistedMessages(args.baseUrl, token, conversationId);
    const firstPersisted = findAssistant(messages, firstId);
    requireCondition(firstPersisted && !containsInternalExecutionBlock(messageText(firstPersisted)), 'natural_chat_not_persisted');
    requireCondition(firstPersisted?.completionFeedback === undefined, 'natural_chat_feedback_persisted');
    const firstRouting = await routingReceiptCheck(args.baseUrl, token, firstId);
    summary.checks.naturalChat = { passed: true, toolEvents: 0, feedbackAbsent: true };

    const secondId = requestId('context');
    const second = await runTurn(socket, {
      requestId: secondId,
      conversationId,
      timeoutMs: args.timeoutMs,
      text: '继续保持不调用工具。刚才杯子的代号是什么？只回复代号。',
    });
    requireCondition(!second.response?.blocked && !containsInternalExecutionBlock(second.response?.text), 'context_turn_internal_block');
    requireCondition(String(second.response?.text || '').includes(cupCode), 'history_empty_context_lost');
    messages = await persistedMessages(args.baseUrl, token, conversationId);
    const secondPersisted = findAssistant(messages, secondId);
    requireCondition(secondPersisted && messageText(secondPersisted).includes(cupCode), 'context_turn_not_persisted');
    const secondRouting = await routingReceiptCheck(args.baseUrl, token, secondId);
    summary.checks.contextContinuity = { passed: true, clientHistoryItems: 0, persisted: true };

    const routeTest = await fetchJson(args.baseUrl, '/llm/route/test', { token, method: 'POST', body: {} });
    const routeProbe = validateRoutingTrace(routeTest, { allowProviderProbe: true });
    requireCondition(routeProbe.ok, 'model_route_probe_invalid');
    const forcedFailover = await fetchJson(args.baseUrl, '/llm/route/test', {
      token,
      method: 'POST',
      body: { probe: 'forced_primary_failure' },
    });
    requireCondition(isVerifiedForcedFailoverProbe(forcedFailover), 'model_forced_failover_not_verified');
    summary.checks.modelRouting = {
      passed: true,
      fallbackConfigured: true,
      fallbackObserved: true,
      forcedPrimaryFailureVerified: true,
      syntheticUnavailableProviderProbe: true,
      productionPrimaryFailureSameTaskContinuationVerified: false,
      receiptCount: firstRouting.receiptCount + secondRouting.receiptCount,
    };

    summary.checks.taskLifecycle = await runTaskLifecycleAcceptance({
      baseUrl: args.baseUrl,
      token,
      socket,
      conversationId,
      runMarker,
      requestId,
      timeoutMs: args.timeoutMs,
      artifactLayout,
    });
    summary.stage9Checks.task_correction_three_times = summary.checks.taskLifecycle.correctionCount === 3;
    summary.stage9Checks.confirmation_waiting = summary.checks.taskLifecycle.turns
      .every(turn => turn.taskStatus === 'waiting_confirmation');
    summary.stage9Checks.task_status_query = summary.checks.taskLifecycle.statusQuery?.userFacingReply?.persisted === true;

    summary.checks.confirmationSafety = await runConfirmationSafetyAcceptance({
      baseUrl: args.baseUrl,
      token,
      socket,
      conversationId,
      runMarker,
      requestId,
      timeoutMs: args.timeoutMs,
      artifactLayout,
    });
    summary.stage9Checks.confirmation_rejection = summary.checks.confirmationSafety.rejection?.sideEffectObserved === false;
    summary.stage9Checks.repeated_confirmation_idempotency = summary.checks.confirmationSafety
      .repeatedConfirmation?.verifiedExecutions === 1;

    if (!args.skipDesktop) {
      const desktopId = requestId('desktop');
      const desktop = await runTurn(socket, {
        requestId: desktopId,
        conversationId,
        timeoutMs: args.timeoutMs,
        text: `[${runMarker}] 这是正式客户端只读 E2E 验收。请实际查看当前前台窗口，必须调用 desktop_active_window，然后只说明已完成只读观察；不要点击、输入或修改任何内容。`,
      });
      const desktopEvents = desktop.toolEvents.filter(event => event.name === 'desktop_active_window');
      requireCondition(desktopEvents.some(event => event.hasResult && !event.hasError), 'desktop_observation_receipt_missing');
      requireCondition(!desktop.response?.blocked && !containsInternalExecutionBlock(desktop.response?.text), 'desktop_observation_blocked');
      messages = await persistedMessages(args.baseUrl, token, conversationId);
      const persisted = findAssistant(messages, desktopId);
      const toolCalls = Array.isArray(persisted?.toolCalls) ? persisted.toolCalls : [];
      const verifiedTool = toolCalls.some(call => (
        call?.name === 'desktop_active_window'
        && !call?.error
        && call?.terminalVerification?.status === 'verified'
      ));
      requireCondition(verifiedTool, 'desktop_terminal_verification_not_persisted');
      requireCondition(persisted?.completionFeedback?.status === 'completed', 'desktop_feedback_not_persisted');
      summary.checks.desktopObservation = { passed: true, verifiedReceipt: true };
    }

    if (!args.skipMultiAgent) {
      const multiId = requestId('multi-agent');
      const multi = await runTurn(socket, {
        requestId: multiId,
        conversationId,
        timeoutMs: args.timeoutMs,
        text: `[${runMarker}] 请把下面完全虚构、只读、禁止文件/网络/桌面工具的文本交给至少两个子 Agent 并行处理：甲说蓝色方块在圆形左边；乙说圆形在蓝色方块右边。一个子 Agent 提炼等价关系，另一个检查是否矛盾，最后合并为三条简短结论。只分析这段文本，不修改任何数据。`,
      });
      const delegation = multi.delegations.find(item => item.taskId);
      requireCondition(delegation?.taskId, 'multi_agent_delegation_missing');
      requireCondition(multi.response?.completionFeedback?.status === 'working', 'multi_agent_working_feedback_missing');
      backgroundCreated = true;
      const task = await pollBackground(args.baseUrl, token, delegation.taskId, args.backgroundTimeoutMs);
      requireCondition(task?.status === 'completed', 'multi_agent_not_completed');
      requireCondition(Array.isArray(task?.workerNames) && task.workerNames.length >= 2, 'multi_agent_assignments_missing');
      const verifiedWorkers = parseWorkerReceiptCount(task?.completionFeedback);
      requireCondition(verifiedWorkers >= 2, 'multi_agent_worker_receipts_missing');
      requireCondition(task?.completionFeedback?.status === 'completed', 'multi_agent_feedback_not_persisted');
      requireCondition((task?.completionFeedback?.evidence || []).some(item => /model-graph arbitration/i.test(String(item))), 'multi_agent_graph_receipt_missing');

      const runtime = await fetchJson(args.baseUrl, '/runtime/status', { token, query: { domain: 'personal' } });
      const accepted = (Array.isArray(runtime?.acceptance?.tasks) ? runtime.acceptance.tasks : []).find(item => (
        item?.runtime === 'background' && item?.taskId === delegation.taskId
      ));
      requireCondition(accepted?.accepted === true, 'multi_agent_acceptance_failed');
      requireCondition(accepted?.terminalReceiptPresent === true && accepted?.terminalVerification === 'verified', 'multi_agent_terminal_receipt_invalid');
      requireCondition(Object.values(accepted?.continuity || {}).every(Boolean), 'multi_agent_continuity_incomplete');
      const actionTask = (Array.isArray(runtime?.tasks) ? runtime.tasks : []).find(item => (
        String(item?.goal || '').includes(runMarker)
      ));
      requireCondition(actionTask && actionTask.activeRequest === false, 'terminal_action_lease_not_released');
      const durable = (Array.isArray(runtime?.durableWork) ? runtime.durableWork : []).find(item => (
        item?.runtime === 'background' && item?.taskId === delegation.taskId
      ));
      requireCondition(durable?.status === 'completed', 'terminal_background_not_persisted');
      summary.checks.multiAgent = {
        passed: true,
        requestId: multiId,
        taskId: delegation.taskId,
        assignedWorkers: task.workerNames.length,
        verifiedWorkerReceipts: verifiedWorkers,
        terminalReceipt: true,
        accepted: true,
      };
      summary.checks.terminalPersistence = {
        passed: true,
        activeLease: false,
        completionFeedback: true,
      };
      summary.stage9Checks.multi_agent_durable_completion = true;
      summary.cleanup.backgroundAuditRetained = true;
    }

    if (args.manualVoiceTurns >= 20) {
      const evidence = await runManualVoiceConversationGate({
        baseUrl: args.baseUrl,
        token,
        conversationId,
        expectedTurns: args.manualVoiceTurns,
        manualGateTimeoutMs: args.manualGateTimeoutMs,
      });
      summary.manualGates.microphoneConversation = {
        required: true,
        status: 'passed',
        syntheticSttEmitted: false,
        requiredVoiceTurns: 20,
        claimedVoiceTurns: evidence.observedTurns,
        evidence,
      };
      summary.stage9Checks.physical_microphone_20_turns = evidence.observedTurns >= 20;
    }

    if (args.manualVoiceToText) {
      const evidence = await runManualVoiceToTextContinuationGate({
        baseUrl: args.baseUrl,
        token,
        socket,
        conversationId,
        runMarker,
        requestId,
        timeoutMs: args.timeoutMs,
        manualGateTimeoutMs: args.manualGateTimeoutMs,
        artifactLayout,
      });
      summary.manualGates.voiceToTextContinuation = {
        required: true,
        status: 'passed',
        syntheticSttEmitted: false,
        evidence,
      };
      summary.stage9Checks.voice_to_text_same_task_continuation = evidence.continuation?.taskId !== '';
    }

    if (args.manualVoiceConfirmation) {
      summary.manualGates.microphoneVoiceConfirmation = {
        required: true,
        status: 'passed',
        syntheticSttEmitted: false,
        claimedVoiceTurns: 1,
        evidence: await runManualVoiceConfirmationGate({
          baseUrl: args.baseUrl,
          token,
          socket,
          conversationId,
          runMarker,
          requestId,
          timeoutMs: args.timeoutMs,
          manualGateTimeoutMs: args.manualGateTimeoutMs,
          artifactLayout,
        }),
      };
    }

    summary.ok = true;
    summary.formalCoverage = evaluateFormalStage9Coverage(summary.stage9Checks);
    summary.coverageComplete = summary.formalCoverage.stage9Complete;
    summary.fullAcceptance = false;
    summary.acceptanceDecision = 'not_adjudicated';
    summary.acceptancePassed = false;
    return summary;
  } catch (error) {
    if (error && typeof error === 'object') error.e2eSummary = summary;
    throw error;
  } finally {
    if (evidenceRun && !evidenceFinalized) {
      try {
        const retainedEvidence = await finalizeFormalAcceptanceEvidence({
          evidenceRun,
          baseUrl: args.baseUrl,
          token,
          conversationId,
          runMarker,
          summary,
          artifactLayout,
          screenshots: args.evidenceScreenshots,
          logs: args.evidenceLogs,
        });
        evidenceFinalized = true;
        summary.evidence = {
          ...retainedEvidence,
          clientIdentityVerified: summary.nativeClient?.proofBoundIdentityVerified === true,
          nativeDeviceId: summary.nativeClient?.deviceId || '',
          nativeClientIdentityFingerprint: summary.nativeClient?.identityFingerprint || '',
          osAttested: false,
          webviewProfileTrustLevel: 'unbound',
          webviewProfileBound: false,
          formalAcceptanceEligible: false,
          acceptanceDecision: 'not_adjudicated',
        };
        summary.packageComplete = summary.ok === true
          && summary.coverageComplete === true
          && retainedEvidence.status === 'evidence_package_complete';
        if (retainedEvidence.status !== 'evidence_package_complete') {
          summary.packageComplete = false;
          summary.fullAcceptance = false;
          summary.failedCheck ||= 'formal_evidence_incomplete';
        }
      } catch (evidenceError) {
        summary.ok = false;
        summary.packageComplete = false;
        summary.fullAcceptance = false;
        summary.failedCheck = 'formal_evidence_finalize_failed';
        summary.evidence = {
          ...(summary.evidence || {}),
          status: 'finalize_failed',
          retained: true,
          error: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
        };
      }
    }
    try { socket?.disconnect(); } catch {}
    if (conversationId && !args.keepConversation && token) {
      try {
        const deleted = await fetchJson(args.baseUrl, `/conversations/${encodeURIComponent(conversationId)}`, {
          token,
          method: 'DELETE',
          query: { domain: 'personal' },
        });
        summary.cleanup.conversationDeleted = deleted?.success === true;
      } catch {
        summary.cleanup.conversationDeleted = false;
      }
    }
    if (args.keepConversation) summary.cleanup.conversationDeleted = false;
    if (backgroundCreated) summary.cleanup.backgroundAuditRetained = true;
    const artifactCleanup = cleanOwnedArtifactLayout(artifactLayout);
    summary.cleanup.ownedArtifactFilesRemoved = artifactCleanup.ok;
    summary.cleanup.ownedArtifactCleanupFailedCount = artifactCleanup.failedCount;
    if (!artifactCleanup.ok) {
      summary.ok = false;
      summary.packageComplete = false;
      summary.fullAcceptance = false;
      summary.failedCheck = 'e2e_artifact_cleanup_failed';
    }
    token = '';
    desktopSessionProof = '';
  }
}

async function main() {
  let summary = { ok: false, failedCheck: 'unknown', cleanup: { conversationDeleted: false, backgroundAuditRetained: false } };
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      // Exit zero is reserved for a formally accepted run, never for help.
      process.exitCode = 1;
      return;
    }
    summary = await runFormalE2E(args);
    process.exitCode = formalGateExitCode(summary);
  } catch (error) {
    const retained = error && typeof error === 'object' && error.e2eSummary
      ? error.e2eSummary
      : summary;
    const primaryFailure = error instanceof E2EError ? error.code : 'unexpected_e2e_failure';
    const retainedFailure = [
      'e2e_artifact_cleanup_failed',
      'formal_evidence_finalize_failed',
    ].includes(retained.failedCheck);
    summary = {
      ...retained,
      ok: false,
      fullAcceptance: false,
      failedCheck: retainedFailure ? retained.failedCheck : primaryFailure,
      ...(retainedFailure ? { primaryFailure } : {}),
      cleanup: retained.cleanup || {
        conversationDeleted: false,
        backgroundAuditRetained: false,
        ownedArtifactFilesRemoved: false,
        ownedArtifactCleanupFailedCount: 0,
      },
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
