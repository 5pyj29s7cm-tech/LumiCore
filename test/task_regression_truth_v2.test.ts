import { describe, expect, it } from 'vitest';
import {
  TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND,
  TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND,
  TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
  TASK_REGRESSION_EVIDENCE_RECORD_V2_SCHEMA,
  validateTaskRegressionEvidenceRecordV2,
  validateTaskRegressionScenarioBundleV2,
} from '../scripts/lib/task-regression-truth-v2.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);
const SHA_F = 'f'.repeat(64);
const NOW = '2026-08-27T12:00:00.000Z';

function provenance() {
  return {
    lane: 'portable_external',
    collector: 'adjudication_controller',
    collectorArtifactSha256: SHA_A,
    recordSha256: SHA_B,
    attestation: {
      kind: 'controller_ed25519_v1',
      keyId: SHA_C,
      signature: 'unit-test-signature',
    },
  };
}

function requestBinding(phaseId: string, channel = 'text') {
  return {
    bindingKind: 'request',
    bindingId: `binding_${phaseId}`,
    requestId: `request_${phaseId}`,
    conversationRef: 'conversation_truth_v2',
    turnNonceSha256: SHA_C,
    channel,
  };
}

function evidenceRecord(input: {
  scenarioId: string;
  phaseId: string;
  phaseOrdinal: number;
  monotonicSequence: number;
  observation: Record<string, unknown>;
  binding?: Record<string, unknown>;
}) {
  return {
    kind: TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND,
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    evidenceId: `evidence_${input.monotonicSequence}`,
    runId: 'run_truth_v2',
    scenarioId: input.scenarioId,
    phaseId: input.phaseId,
    phaseOrdinal: input.phaseOrdinal,
    monotonicSequence: input.monotonicSequence,
    capturedAt: NOW,
    binding: input.binding || requestBinding(input.phaseId),
    provenance: provenance(),
    observation: input.observation,
  };
}

function turn(
  phaseId: string,
  relation: string,
  terminalStatus = 'completed',
  targetRequestRef: string | null = null,
  replySha256 = SHA_A,
) {
  return {
    observationKind: 'turn',
    requestRef: `request_${phaseId}`,
    userMessageRef: `user_${phaseId}`,
    assistantMessageRef: `assistant_${phaseId}`,
    channel: 'text',
    relation,
    targetTaskRef: null,
    targetRequestRef,
    terminalStatus,
    userVisibleReply: {
      messageRef: `assistant_${phaseId}`,
      textSha256: replySha256,
      textCharCount: 12,
      recordedAt: NOW,
    },
  };
}

function absenceWindow(startSequence: number, endSequence: number) {
  return {
    observationKind: 'absence_window',
    assertion: 'no_new_task_or_tool_execution',
    startSequence,
    endSequence,
    sources: [
      'socket_tool_events',
      'passive_task_store',
      'passive_receipt_store',
      'filesystem_witness',
    ],
    matcherSha256: SHA_B,
    matchedRecordCount: 0,
  };
}

function s5Bundle() {
  const scenarioId = 'control_stop_status_repeat';
  return {
    kind: TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND,
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    bundleId: 'bundle_s5_truth_v2',
    runId: 'run_truth_v2',
    scenarioId,
    coverageMode: 'isolated_backend',
    evidence: [
      evidenceRecord({
        scenarioId, phaseId: 'long_start', phaseOrdinal: 1, monotonicSequence: 1,
        observation: turn('long_start', 'new', 'cancelled'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'long_start', phaseOrdinal: 1, monotonicSequence: 2,
        observation: cancelledModelRoute('long_start'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'long_start', phaseOrdinal: 1, monotonicSequence: 3,
        observation: cancelledProviderAttempt('long_start'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'stop', phaseOrdinal: 2, monotonicSequence: 4,
        observation: turn('stop', 'cancel', 'completed', 'request_long_start'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'stop', phaseOrdinal: 2, monotonicSequence: 5,
        observation: modelNoninvocation('stop', 'request_only_control'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'status_after_cancel', phaseOrdinal: 3, monotonicSequence: 6,
        observation: turn(
          'status_after_cancel', 'status', 'completed', 'request_long_start', SHA_B,
        ),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'status_after_cancel', phaseOrdinal: 3, monotonicSequence: 7,
        observation: modelNoninvocation('status_after_cancel', 'request_only_control'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'repeat_status', phaseOrdinal: 4, monotonicSequence: 8,
        observation: turn(
          'repeat_status', 'repeat', 'completed', 'request_status_after_cancel', SHA_B,
        ),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'repeat_status', phaseOrdinal: 4, monotonicSequence: 9,
        observation: modelNoninvocation('repeat_status', 'request_only_control'),
      }),
      evidenceRecord({
        scenarioId, phaseId: 'repeat_status', phaseOrdinal: 4, monotonicSequence: 10,
        observation: absenceWindow(7, 10),
      }),
    ],
  };
}

function cancelledModelRoute(phaseId: string) {
  return {
    observationKind: 'model_route',
    requestRef: `request_${phaseId}`,
    routingReceiptRef: `routing_${phaseId}`,
    selectionMode: 'pinned',
    selectedProvider: 'openai',
    selectedModel: 'slow-cancellable-model',
    fallbackReason: null,
    attempts: [{
      attemptOrdinal: 1,
      provider: 'openai',
      model: 'slow-cancellable-model',
      status: 'failed',
      errorCategory: 'cancelled',
      visibleOutputCommitted: false,
      outboundEvidenceSha256: SHA_A,
      providerWitnessRef: `provider_witness_${phaseId}`,
    }],
  };
}

function cancelledProviderAttempt(phaseId: string) {
  return {
    observationKind: 'provider_attempt',
    requestRef: `request_${phaseId}`,
    attemptOrdinal: 1,
    endpointWitnessRef: `provider_witness_${phaseId}`,
    provider: 'openai',
    model: 'slow-cancellable-model',
    status: 'failed',
    httpStatus: 499,
    errorCategory: 'cancelled',
    requestSha256: SHA_A,
    turnNonceSha256: SHA_C,
    responseSha256: SHA_B,
    visibleOutputCommitted: false,
  };
}

function pointer(state: 'set' | 'cleared', taskRef: string | null, requestRef: string | null, revision: number) {
  return { state, taskRef, requestRef, revision };
}

function conversationState(status: string, requestRef: string | null, revision: number) {
  const active = requestRef !== null;
  return {
    observationKind: 'conversation_state',
    tasks: [{
      taskRef: 'task_s2',
      status,
      revision,
      activeRequestRef: requestRef,
      goalSha256: SHA_A,
      targetSha256: SHA_B,
      capsuleRevision: revision,
    }],
    pendingPointer: pointer(active ? 'set' : 'cleared', active ? 'task_s2' : null, requestRef, revision),
    livePointer: pointer(active ? 'set' : 'cleared', active ? 'task_s2' : null, requestRef, revision),
    pendingConfirmationCount: active ? 1 : 0,
  };
}

function writeReceipt(phaseId: string, receiptRef: string, outcome: string) {
  return {
    receiptRef,
    taskRef: 'task_s2',
    requestRef: `request_${phaseId}`,
    toolName: 'desktop_write_text_file',
    outcome,
    idempotencyKeySha256: SHA_A,
    inputSha256: SHA_B,
    executionOrigin: outcome === 'waiting_confirmation' ? 'model_tool_call' : 'confirmed_action_resume',
    target: {
      targetKind: 'filesystem',
      canonicalPathHmac: SHA_C,
      displayName: 'confirm-exactly-once.txt',
      source: 'sealed_fixture',
    },
  };
}

function actionSet(phaseId: string, receipts: Array<Record<string, unknown>>) {
  return {
    observationKind: 'action_set',
    requestRef: `request_${phaseId}`,
    receipts,
  };
}

function modelNoninvocation(phaseId: string, origin = 'confirmed_action_resume') {
  return {
    observationKind: 'model_noninvocation',
    requestRef: `request_${phaseId}`,
    executionOrigin: origin,
    reasonCode: 'exact_persisted_action_resumed',
  };
}

function artifactState() {
  return {
    observationKind: 'artifact_state',
    artifactRef: 'artifact_s2',
    exists: true,
    contentSha256: SHA_A,
    byteLength: 32,
    mtimeMs: 1_777_777,
    identitySha256: SHA_B,
  };
}

function s2Bundle({ ambiguous = false } = {}) {
  const scenarioId = 'repeated_confirmation_exactly_once';
  let sequence = 0;
  const make = (phaseId: string, phaseOrdinal: number, observation: Record<string, unknown>) => (
    evidenceRecord({
      scenarioId,
      phaseId,
      phaseOrdinal,
      monotonicSequence: ++sequence,
      observation,
    })
  );
  const firstReceipts = [writeReceipt('confirm_first', 'receipt_first', 'verified_success')];
  if (ambiguous) firstReceipts.push(writeReceipt('confirm_first', 'receipt_second', 'verified_success'));
  return {
    kind: TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND,
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    bundleId: 'bundle_s2_truth_v2',
    runId: 'run_truth_v2',
    scenarioId,
    coverageMode: 'isolated_backend',
    evidence: [
      make('pending', 1, turn('pending', 'new', 'waiting_confirmation')),
      make('pending', 1, conversationState('waiting_confirmation', 'request_pending', 1)),
      make('pending', 1, actionSet('pending', [writeReceipt('pending', 'receipt_pending', 'waiting_confirmation')])),
      make('pending', 1, modelNoninvocation('pending', 'deterministic_route')),

      make('confirm_first', 2, turn('confirm_first', 'confirm')),
      make('confirm_first', 2, conversationState('completed', null, 2)),
      make('confirm_first', 2, actionSet('confirm_first', firstReceipts)),
      make('confirm_first', 2, artifactState()),
      make('confirm_first', 2, modelNoninvocation('confirm_first')),

      make('confirm_repeat', 3, turn('confirm_repeat', 'confirm')),
      make('confirm_repeat', 3, artifactState()),
      make('confirm_repeat', 3, modelNoninvocation('confirm_repeat', 'request_only_control')),
      make('confirm_repeat', 3, absenceWindow(9, 13)),
    ],
  };
}

function systemBinding(
  phaseId: string,
  eventKind: string,
  sourceBindingId: string | null,
) {
  return {
    bindingKind: 'system_event',
    bindingId: `binding_${phaseId}`,
    eventKind,
    eventNonceSha256: SHA_D,
    sourceBindingId,
  };
}

function scenarioTurn(input: {
  phaseId: string;
  relation: string;
  taskRef: string | null;
  targetRequestRef?: string | null;
  terminalStatus?: string;
  channel?: string;
  replySha256?: string;
}) {
  const channel = input.channel || 'text';
  return {
    observationKind: 'turn',
    requestRef: `request_${input.phaseId}`,
    userMessageRef: `user_${input.phaseId}`,
    assistantMessageRef: `assistant_${input.phaseId}`,
    channel,
    relation: input.relation,
    targetTaskRef: input.taskRef,
    targetRequestRef: input.targetRequestRef ?? null,
    terminalStatus: input.terminalStatus || 'completed',
    userVisibleReply: {
      messageRef: `assistant_${input.phaseId}`,
      textSha256: input.replySha256 || SHA_A,
      textCharCount: 24,
      recordedAt: NOW,
    },
  };
}

function scenarioReceipt(input: {
  phaseId: string;
  receiptRef: string;
  taskRef: string;
  toolName: string;
  outcome: string;
  origin: string;
  target: Record<string, unknown>;
  idempotency?: string;
  inputSha256?: string;
}) {
  return {
    receiptRef: input.receiptRef,
    taskRef: input.taskRef,
    requestRef: `request_${input.phaseId}`,
    toolName: input.toolName,
    outcome: input.outcome,
    idempotencyKeySha256: input.idempotency || SHA_A,
    inputSha256: input.inputSha256 || SHA_B,
    executionOrigin: input.origin,
    target: input.target,
  };
}

function runtimeTarget(workSetSha256 = SHA_D, workCount = 2) {
  return {
    targetKind: 'runtime_work_set',
    workSetSha256,
    workCount,
    source: 'verified_runtime_work_status_receipt',
  };
}

function filesystemTarget(identitySha256: string, displayName: string) {
  return {
    targetKind: 'filesystem',
    canonicalPathHmac: identitySha256,
    displayName,
    source: 'sealed_fixture',
  };
}

function documentTarget(identitySha256: string, documentTitle: string) {
  return {
    targetKind: 'application_document',
    applicationId: 'wps.presentation',
    processName: 'wpp.exe',
    windowTitleSha256: SHA_E,
    documentTitle,
    canonicalPathHmac: identitySha256,
    source: 'verified_active_window',
  };
}

function nativeDocument(identitySha256: string, documentTitle: string) {
  return {
    observationKind: 'native_target',
    coverageKind: 'synthetic_adapter',
    applicationId: 'wps.presentation',
    processName: 'wpp.exe',
    windowTitleSha256: SHA_E,
    documentTitle,
    documentIdentitySha256: identitySha256,
    source: 'sealed_native_adapter',
  };
}

function scenarioArtifact(input: {
  artifactRef: string;
  exists: boolean;
  identitySha256?: string | null;
  contentSha256?: string | null;
  byteLength?: number;
  mtimeMs?: number | null;
}) {
  return {
    observationKind: 'artifact_state',
    artifactRef: input.artifactRef,
    exists: input.exists,
    contentSha256: input.exists ? (input.contentSha256 || SHA_F) : null,
    byteLength: input.exists ? (input.byteLength || 64) : 0,
    mtimeMs: input.exists ? (input.mtimeMs || 1_234_567) : null,
    identitySha256: input.exists ? (input.identitySha256 || SHA_D) : null,
  };
}

function scenarioState(input: {
  taskRef: string;
  status: string;
  revision: number;
  activeRequestRef: string | null;
  pending?: { state: 'set' | 'cleared'; requestRef: string | null };
  live?: { state: 'set' | 'cleared'; requestRef: string | null };
  pendingConfirmationCount?: number;
  goalSha256?: string;
  targetSha256?: string;
  capsuleRevision?: number;
}) {
  const pending = input.pending || { state: 'cleared' as const, requestRef: null };
  const live = input.live || { state: 'cleared' as const, requestRef: null };
  return {
    observationKind: 'conversation_state',
    tasks: [{
      taskRef: input.taskRef,
      status: input.status,
      revision: input.revision,
      activeRequestRef: input.activeRequestRef,
      goalSha256: input.goalSha256 || SHA_A,
      targetSha256: input.targetSha256 || SHA_B,
      capsuleRevision: input.capsuleRevision ?? input.revision,
    }],
    pendingPointer: pointer(
      pending.state,
      pending.state === 'set' ? input.taskRef : null,
      pending.requestRef,
      input.revision,
    ),
    livePointer: pointer(
      live.state,
      live.state === 'set' ? input.taskRef : null,
      live.requestRef,
      input.revision,
    ),
    pendingConfirmationCount: input.pendingConfirmationCount || 0,
  };
}

function modelEvidence(input: {
  phaseId: string;
  provider?: string;
  model?: string;
  selectionMode?: string;
  fallbackReason?: string | null;
  attemptOrdinal?: number;
  status?: 'succeeded' | 'failed';
  errorCategory?: string | null;
  visibleOutputCommitted?: boolean;
  requestSha256?: string;
  requestRef?: string;
  turnNonceSha256?: string;
}) {
  const provider = input.provider || 'openai';
  const model = input.model || 'portable-model';
  const ordinal = input.attemptOrdinal || 1;
  const status = input.status || 'succeeded';
  const requestRef = input.requestRef || `request_${input.phaseId}`;
  const witness = `provider_${input.phaseId}_${ordinal}`;
  const requestSha256 = input.requestSha256 || SHA_A;
  const visibleOutputCommitted = input.visibleOutputCommitted ?? status === 'succeeded';
  return {
    routeAttempt: {
      attemptOrdinal: ordinal,
      provider,
      model,
      status,
      errorCategory: input.errorCategory ?? (status === 'failed' ? 'connection_error' : null),
      visibleOutputCommitted,
      outboundEvidenceSha256: requestSha256,
      providerWitnessRef: witness,
    },
    provider: {
      observationKind: 'provider_attempt',
      requestRef,
      attemptOrdinal: ordinal,
      endpointWitnessRef: witness,
      provider,
      model,
      status,
      httpStatus: status === 'succeeded' ? 200 : 503,
      errorCategory: input.errorCategory ?? (status === 'failed' ? 'connection_error' : null),
      requestSha256,
      turnNonceSha256: input.turnNonceSha256 || SHA_C,
      responseSha256: SHA_B,
      visibleOutputCommitted,
    },
    route(inputAttempts?: Array<Record<string, unknown>>) {
      return {
        observationKind: 'model_route',
        requestRef,
        routingReceiptRef: `route_${input.phaseId}`,
        selectionMode: input.selectionMode || 'pinned',
        selectedProvider: provider,
        selectedModel: model,
        fallbackReason: input.fallbackReason ?? null,
        attempts: inputAttempts || [this.routeAttempt],
      };
    },
  };
}

function makeScenarioBundle(
  scenarioId: string,
  entries: Array<{
    phaseId: string;
    phaseOrdinal: number;
    observation: Record<string, unknown>;
    binding?: Record<string, unknown>;
  }>,
) {
  return {
    kind: TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND,
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    bundleId: `bundle_${scenarioId}`,
    runId: 'run_truth_v2',
    scenarioId,
    coverageMode: 'isolated_backend',
    evidence: entries.map((entry, index) => evidenceRecord({
      scenarioId,
      phaseId: entry.phaseId,
      phaseOrdinal: entry.phaseOrdinal,
      monotonicSequence: index + 1,
      observation: entry.observation,
      binding: entry.binding,
    })),
  };
}

function s1Bundle() {
  const scenarioId = 'cleanup_offer_then_cleanup';
  const offerModel = modelEvidence({ phaseId: 'offer' });
  const frozenTarget = runtimeTarget();
  return makeScenarioBundle(scenarioId, [
    {
      phaseId: 'offer', phaseOrdinal: 1,
      observation: scenarioTurn({ phaseId: 'offer', relation: 'status', taskRef: 'task_s1_offer' }),
    },
    {
      phaseId: 'offer', phaseOrdinal: 1,
      observation: actionSet('offer', [scenarioReceipt({
        phaseId: 'offer', receiptRef: 'receipt_s1_status', taskRef: 'task_s1_offer',
        toolName: 'runtime_work_status', outcome: 'verified_success', origin: 'model_tool_call',
        target: frozenTarget,
      })]),
    },
    { phaseId: 'offer', phaseOrdinal: 1, observation: offerModel.route() },
    { phaseId: 'offer', phaseOrdinal: 1, observation: offerModel.provider },
    {
      phaseId: 'cleanup', phaseOrdinal: 2,
      observation: scenarioTurn({
        phaseId: 'cleanup', relation: 'confirm', taskRef: 'task_s1_cleanup',
        targetRequestRef: 'request_offer',
      }),
    },
    {
      phaseId: 'cleanup', phaseOrdinal: 2,
      observation: scenarioState({
        taskRef: 'task_s1_cleanup', status: 'completed', revision: 2, activeRequestRef: null,
      }),
    },
    {
      phaseId: 'cleanup', phaseOrdinal: 2,
      observation: actionSet('cleanup', [scenarioReceipt({
        phaseId: 'cleanup', receiptRef: 'receipt_s1_cancel', taskRef: 'task_s1_cleanup',
        toolName: 'runtime_work_cancel', outcome: 'verified_success', origin: 'deterministic_route',
        target: frozenTarget,
      })]),
    },
    {
      phaseId: 'cleanup', phaseOrdinal: 2,
      observation: modelNoninvocation('cleanup', 'deterministic_route'),
    },
  ]);
}

function s3Bundle() {
  const scenarioId = 'wps_wrong_file_correction';
  const taskRef = 'task_s3';
  const anchorModel = modelEvidence({ phaseId: 'anchor' });
  const correctionModel = modelEvidence({ phaseId: 'correction' });
  const supplyModel = modelEvidence({ phaseId: 'supply-filename' });
  const wrongArtifact = scenarioArtifact({
    artifactRef: 'artifact_wrong_wps_file', exists: true, identitySha256: SHA_D,
    contentSha256: SHA_A, byteLength: 101, mtimeMs: 2_000,
  });
  return makeScenarioBundle(scenarioId, [
    {
      phaseId: 'anchor', phaseOrdinal: 1,
      observation: scenarioTurn({ phaseId: 'anchor', relation: 'new', taskRef }),
    },
    {
      phaseId: 'anchor', phaseOrdinal: 1,
      observation: actionSet('anchor', [scenarioReceipt({
        phaseId: 'anchor', receiptRef: 'receipt_s3_anchor', taskRef,
        toolName: 'desktop_active_window', outcome: 'verified_success', origin: 'model_tool_call',
        target: documentTarget(SHA_D, '错误演示文稿.pptx'),
      })]),
    },
    { phaseId: 'anchor', phaseOrdinal: 1, observation: nativeDocument(SHA_D, '错误演示文稿.pptx') },
    { phaseId: 'anchor', phaseOrdinal: 1, observation: wrongArtifact },
    { phaseId: 'anchor', phaseOrdinal: 1, observation: anchorModel.route() },
    { phaseId: 'anchor', phaseOrdinal: 1, observation: anchorModel.provider },
    {
      phaseId: 'correction', phaseOrdinal: 2,
      observation: scenarioTurn({
        phaseId: 'correction', relation: 'correct', taskRef,
        targetRequestRef: 'request_anchor', terminalStatus: 'blocked',
      }),
    },
    {
      phaseId: 'correction', phaseOrdinal: 2,
      observation: scenarioState({
        taskRef, status: 'executing', revision: 2,
        activeRequestRef: 'request_correction',
        live: { state: 'set', requestRef: 'request_correction' },
      }),
    },
    { phaseId: 'correction', phaseOrdinal: 2, observation: correctionModel.route() },
    { phaseId: 'correction', phaseOrdinal: 2, observation: correctionModel.provider },
    {
      phaseId: 'supply-filename', phaseOrdinal: 3,
      observation: scenarioTurn({
        phaseId: 'supply-filename', relation: 'correct', taskRef,
        targetRequestRef: 'request_correction',
      }),
    },
    {
      phaseId: 'supply-filename', phaseOrdinal: 3,
      observation: scenarioState({
        taskRef, status: 'completed', revision: 3, activeRequestRef: null,
      }),
    },
    {
      phaseId: 'supply-filename', phaseOrdinal: 3,
      observation: actionSet('supply-filename', [scenarioReceipt({
        phaseId: 'supply-filename', receiptRef: 'receipt_s3_read', taskRef,
        toolName: 'extract_document_text', outcome: 'verified_success', origin: 'model_tool_call',
        target: filesystemTarget(SHA_F, '正确演示文稿.pptx'),
      })]),
    },
    {
      phaseId: 'supply-filename', phaseOrdinal: 3,
      observation: nativeDocument(SHA_F, '正确演示文稿.pptx'),
    },
    { phaseId: 'supply-filename', phaseOrdinal: 3, observation: { ...wrongArtifact } },
    { phaseId: 'supply-filename', phaseOrdinal: 3, observation: supplyModel.route() },
    { phaseId: 'supply-filename', phaseOrdinal: 3, observation: supplyModel.provider },
  ]);
}

function s4Bundle() {
  const scenarioId = 'displayed_result_stale_receipt';
  const displayModel = modelEvidence({ phaseId: 'display' });
  const continueModel = modelEvidence({ phaseId: 'continue' });
  return makeScenarioBundle(scenarioId, [
    {
      phaseId: 'display', phaseOrdinal: 1,
      observation: scenarioTurn({ phaseId: 'display', relation: 'new', taskRef: 'task_s4_display' }),
    },
    {
      phaseId: 'display', phaseOrdinal: 1,
      observation: actionSet('display', [scenarioReceipt({
        phaseId: 'display', receiptRef: 'receipt_s4_display', taskRef: 'task_s4_display',
        toolName: 'read_file', outcome: 'verified_success', origin: 'model_tool_call',
        target: filesystemTarget(SHA_D, 'visible-result.txt'),
      })]),
    },
    { phaseId: 'display', phaseOrdinal: 1, observation: displayModel.route() },
    { phaseId: 'display', phaseOrdinal: 1, observation: displayModel.provider },
    {
      phaseId: 'inject_stale', phaseOrdinal: 2,
      binding: systemBinding('inject_stale', 'stale_reclassification', 'binding_display'),
      observation: {
        observationKind: 'stale_reclassification',
        sourceReceiptRef: 'receipt_s4_display',
        classifierInputSha256: SHA_E,
        mismatchDimension: 'request_id',
        classification: 'stale',
        archiveRef: 'archive_s4_stale',
        sourceReceiptUnchanged: true,
        leaseReleased: true,
      },
    },
    {
      phaseId: 'continue', phaseOrdinal: 3,
      observation: scenarioTurn({
        phaseId: 'continue', relation: 'new', taskRef: 'task_s4_next',
        terminalStatus: 'waiting_confirmation',
      }),
    },
    {
      phaseId: 'continue', phaseOrdinal: 3,
      observation: scenarioState({
        taskRef: 'task_s4_next', status: 'waiting_confirmation', revision: 1,
        activeRequestRef: 'request_continue',
        pending: { state: 'set', requestRef: 'request_continue' },
        live: { state: 'set', requestRef: 'request_continue' },
        pendingConfirmationCount: 1,
      }),
    },
    { phaseId: 'continue', phaseOrdinal: 3, observation: continueModel.route() },
    { phaseId: 'continue', phaseOrdinal: 3, observation: continueModel.provider },
  ]);
}

function s6Bundle() {
  const scenarioId = 'voice_to_text_continuation';
  const taskRef = 'task_s6';
  const voiceModel = modelEvidence({ phaseId: 'voice_start' });
  const textModel = modelEvidence({ phaseId: 'text_continue', provider: 'lmstudio', model: 'qwen-local' });
  const rejectedTarget = filesystemTarget(SHA_D, 'missing-voice-target.txt');
  const correctedTarget = filesystemTarget(SHA_F, 'voice-continuation.txt');
  const voiceBinding = requestBinding('voice_start', 'voice');
  return makeScenarioBundle(scenarioId, [
    {
      phaseId: 'voice_start', phaseOrdinal: 1, binding: voiceBinding,
      observation: scenarioTurn({
        phaseId: 'voice_start', relation: 'new', taskRef, channel: 'voice',
        terminalStatus: 'blocked',
      }),
    },
    {
      phaseId: 'voice_start', phaseOrdinal: 1, binding: voiceBinding,
      observation: scenarioState({
        taskRef, status: 'blocked', revision: 1, activeRequestRef: null,
        live: { state: 'set', requestRef: null },
        targetSha256: SHA_D,
      }),
    },
    {
      phaseId: 'voice_start', phaseOrdinal: 1, binding: voiceBinding,
      observation: actionSet('voice_start', [scenarioReceipt({
        phaseId: 'voice_start', receiptRef: 'receipt_s6_voice_failed', taskRef,
        toolName: 'read_file', outcome: 'failed', origin: 'model_tool_call', target: rejectedTarget,
        inputSha256: SHA_E,
      })]),
    },
    { phaseId: 'voice_start', phaseOrdinal: 1, binding: voiceBinding, observation: voiceModel.route() },
    { phaseId: 'voice_start', phaseOrdinal: 1, binding: voiceBinding, observation: voiceModel.provider },
    {
      phaseId: 'text_continue', phaseOrdinal: 2,
      observation: scenarioTurn({
        phaseId: 'text_continue', relation: 'continue', taskRef,
        targetRequestRef: 'request_voice_start',
      }),
    },
    {
      phaseId: 'text_continue', phaseOrdinal: 2,
      observation: scenarioState({
        taskRef, status: 'completed', revision: 2, activeRequestRef: null,
        targetSha256: SHA_F,
      }),
    },
    {
      phaseId: 'text_continue', phaseOrdinal: 2,
      observation: actionSet('text_continue', [scenarioReceipt({
        phaseId: 'text_continue', receiptRef: 'receipt_s6_text_success', taskRef,
        toolName: 'read_file', outcome: 'verified_success', origin: 'model_tool_call',
        target: correctedTarget,
        inputSha256: SHA_F,
      })]),
    },
    {
      phaseId: 'text_continue', phaseOrdinal: 2,
      observation: {
        observationKind: 'target_correction',
        sourceRequestRef: 'request_voice_start',
        targetRequestRef: 'request_text_continue',
        taskRef,
        correctionMessageRef: 'user_text_continue',
        previousTarget: rejectedTarget,
        replacementTarget: correctedTarget,
        previousTaskTargetSha256: SHA_D,
        replacementTaskTargetSha256: SHA_F,
        rejectedTargetSha256: SHA_D,
        source: 'user_correction',
      },
    },
    {
      phaseId: 'text_continue', phaseOrdinal: 2,
      observation: {
        observationKind: 'channel_handoff',
        sourceRequestRef: 'request_voice_start',
        targetRequestRef: 'request_text_continue',
        sourceChannel: 'voice',
        targetChannel: 'text',
        captureMode: 'synthetic_accepted_transcript',
        contextChainRef: null,
        sourceTaskRef: taskRef,
        targetTaskRef: taskRef,
        sourceMessageRefs: ['user_voice_start', 'assistant_voice_start'],
        targetMessageRef: 'user_text_continue',
      },
    },
    { phaseId: 'text_continue', phaseOrdinal: 2, observation: textModel.route() },
    { phaseId: 'text_continue', phaseOrdinal: 2, observation: textModel.provider },
  ]);
}

function runtimeTransition() {
  return {
    observationKind: 'runtime_transition',
    restartScope: 'backend-only',
    beforeEpochRef: 'epoch_before_s7',
    afterEpochRef: 'epoch_after_s7',
    buildIdentitySha256: SHA_A,
    dataRootSha256: SHA_B,
    checkpointSha256: SHA_C,
  };
}

function s7Bundle() {
  const scenarioId = 'mid_task_restart_recovery';
  const taskRef = 'task_s7';
  const prepareModel = modelEvidence({ phaseId: 'prepare' });
  const target = filesystemTarget(SHA_D, 'restart-result.txt');
  return makeScenarioBundle(scenarioId, [
    {
      phaseId: 'prepare', phaseOrdinal: 1,
      observation: scenarioTurn({
        phaseId: 'prepare', relation: 'new', taskRef,
        terminalStatus: 'waiting_confirmation',
      }),
    },
    {
      phaseId: 'prepare', phaseOrdinal: 1,
      observation: scenarioState({
        taskRef, status: 'waiting_confirmation', revision: 1,
        activeRequestRef: 'request_prepare',
        pending: { state: 'set', requestRef: 'request_prepare' },
        live: { state: 'set', requestRef: 'request_prepare' },
        pendingConfirmationCount: 1,
      }),
    },
    {
      phaseId: 'prepare', phaseOrdinal: 1,
      observation: actionSet('prepare', [scenarioReceipt({
        phaseId: 'prepare', receiptRef: 'receipt_s7_pending', taskRef,
        toolName: 'desktop_write_text_file', outcome: 'waiting_confirmation',
        origin: 'model_tool_call', target, idempotency: SHA_E, inputSha256: SHA_F,
      })]),
    },
    {
      phaseId: 'prepare', phaseOrdinal: 1,
      observation: scenarioArtifact({ artifactRef: 'artifact_s7', exists: false }),
    },
    { phaseId: 'prepare', phaseOrdinal: 1, observation: prepareModel.route() },
    { phaseId: 'prepare', phaseOrdinal: 1, observation: prepareModel.provider },
    {
      phaseId: 'restart', phaseOrdinal: 2,
      binding: systemBinding('restart', 'backend_restart', 'binding_prepare'),
      observation: runtimeTransition(),
    },
    {
      phaseId: 'recovered', phaseOrdinal: 3,
      binding: systemBinding('recovered', 'post_restart_recovery', 'binding_restart'),
      observation: scenarioState({
        taskRef, status: 'waiting_confirmation', revision: 2, activeRequestRef: null,
        pending: { state: 'set', requestRef: null },
        live: { state: 'set', requestRef: null },
        pendingConfirmationCount: 1,
      }),
    },
    {
      phaseId: 'recovered', phaseOrdinal: 3,
      binding: systemBinding('recovered', 'post_restart_recovery', 'binding_restart'),
      observation: runtimeTransition(),
    },
    {
      phaseId: 'continue', phaseOrdinal: 4,
      observation: scenarioTurn({
        phaseId: 'continue', relation: 'confirm', taskRef,
        targetRequestRef: 'request_prepare',
      }),
    },
    {
      phaseId: 'continue', phaseOrdinal: 4,
      observation: scenarioState({
        taskRef, status: 'completed', revision: 3, activeRequestRef: null,
      }),
    },
    {
      phaseId: 'continue', phaseOrdinal: 4,
      observation: actionSet('continue', [scenarioReceipt({
        phaseId: 'continue', receiptRef: 'receipt_s7_complete', taskRef,
        toolName: 'desktop_write_text_file', outcome: 'verified_success',
        origin: 'confirmed_action_resume', target, idempotency: SHA_E, inputSha256: SHA_F,
      })]),
    },
    {
      phaseId: 'continue', phaseOrdinal: 4,
      observation: scenarioArtifact({
        artifactRef: 'artifact_s7', exists: true, identitySha256: SHA_D,
      }),
    },
    {
      phaseId: 'continue', phaseOrdinal: 4,
      observation: modelNoninvocation('continue', 'confirmed_action_resume'),
    },
  ]);
}

function s8Bundle() {
  const scenarioId = 'primary_model_failover_lmstudio';
  const taskRef = 'task_s8';
  const primaryModel = modelEvidence({
    phaseId: 'primary_attempt_failed', provider: 'deepseek', model: 'deepseek-v4-flash',
    requestRef: 'request_start', attemptOrdinal: 1, status: 'failed',
    errorCategory: 'connection_error', visibleOutputCommitted: false, requestSha256: SHA_D,
  });
  const fallbackModel = modelEvidence({
    phaseId: 'lmstudio_attempt_succeeded', provider: 'lmstudio', model: 'qwen-local',
    requestRef: 'request_start', attemptOrdinal: 2, status: 'succeeded',
    selectionMode: 'ordered_fallback', fallbackReason: 'primary_connection_error',
    visibleOutputCommitted: false, requestSha256: SHA_E,
  });
  const continueModel = modelEvidence({
    phaseId: 'text_continue', provider: 'lmstudio', model: 'qwen-local',
  });
  return makeScenarioBundle(scenarioId, [
    {
      phaseId: 'start', phaseOrdinal: 1,
      observation: scenarioTurn({
        phaseId: 'start', relation: 'new', taskRef, terminalStatus: 'blocked',
      }),
    },
    {
      phaseId: 'start', phaseOrdinal: 1,
      observation: scenarioState({
        taskRef, status: 'blocked', revision: 1, activeRequestRef: null,
        live: { state: 'set', requestRef: null },
      }),
    },
    {
      phaseId: 'primary_attempt_failed', phaseOrdinal: 2,
      binding: systemBinding('primary_attempt_failed', 'primary_model_attempt', 'binding_start'),
      observation: primaryModel.provider,
    },
    {
      phaseId: 'lmstudio_attempt_succeeded', phaseOrdinal: 3,
      binding: systemBinding(
        'lmstudio_attempt_succeeded', 'fallback_model_attempt', 'binding_primary_attempt_failed',
      ),
      observation: fallbackModel.provider,
    },
    {
      phaseId: 'lmstudio_attempt_succeeded', phaseOrdinal: 3,
      binding: systemBinding(
        'lmstudio_attempt_succeeded', 'fallback_model_attempt', 'binding_primary_attempt_failed',
      ),
      observation: fallbackModel.route([primaryModel.routeAttempt, fallbackModel.routeAttempt]),
    },
    {
      phaseId: 'text_continue', phaseOrdinal: 4,
      observation: scenarioTurn({
        phaseId: 'text_continue', relation: 'continue', taskRef,
        targetRequestRef: 'request_start',
      }),
    },
    {
      phaseId: 'text_continue', phaseOrdinal: 4,
      observation: scenarioState({
        taskRef, status: 'completed', revision: 2, activeRequestRef: null,
      }),
    },
    { phaseId: 'text_continue', phaseOrdinal: 4, observation: continueModel.route() },
    { phaseId: 'text_continue', phaseOrdinal: 4, observation: continueModel.provider },
  ]);
}

function findScenarioEvidence(
  bundle: ReturnType<typeof makeScenarioBundle>,
  phaseId: string,
  observationKind: string,
) {
  return bundle.evidence.find(item => (
    item.phaseId === phaseId && item.observation.observationKind === observationKind
  ));
}

function issueCodes(result: ReturnType<typeof validateTaskRegressionScenarioBundleV2>) {
  return result.issues.map((issue: { code: string }) => issue.code);
}

describe('task regression truth v2 schema and adjudicator', () => {
  it('exposes strict discriminated unions for bindings and observations', () => {
    expect(TASK_REGRESSION_EVIDENCE_RECORD_V2_SCHEMA.additionalProperties).toBe(false);
    expect(TASK_REGRESSION_EVIDENCE_RECORD_V2_SCHEMA.properties.binding.oneOf).toHaveLength(3);
    expect(TASK_REGRESSION_EVIDENCE_RECORD_V2_SCHEMA.properties.observation.oneOf.length).toBeGreaterThan(10);
  });

  it('accepts S1 only when a verified status work-set is frozen into one deterministic cleanup', () => {
    const result = validateTaskRegressionScenarioBundleV2(s1Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'verified_cleanup_offer_frozen_set_once', passed: true }),
    ]));
  });

  it('rejects S1 when cleanup substitutes a different runtime work-set', () => {
    const bundle = s1Bundle();
    const action = findScenarioEvidence(bundle, 'cleanup', 'action_set')!;
    const receipt = (action.observation.receipts as Array<Record<string, any>>)[0];
    receipt.target = runtimeTarget(SHA_E, 2);
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('cleanup_frozen_work_set_join_invalid');
  });

  it('accepts S3 only when correction retains one task, reads the corrected WPS target, and leaves the wrong file unchanged', () => {
    const result = validateTaskRegressionScenarioBundleV2(s3Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'wps_wrong_target_corrected_same_task', passed: true }),
    ]));
  });

  it('fails S3 closed when the corrected model provider witness is missing', () => {
    const bundle = s3Bundle();
    bundle.evidence = bundle.evidence.filter(item => !(
      item.phaseId === 'supply-filename'
        && item.observation.observationKind === 'provider_attempt'
    ));
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'required_phase_evidence_missing',
      'model_provider_request_marker_join_invalid',
    ]));
  });

  it('accepts S4 only when the stale event names the displayed receipt and the next request owns live state', () => {
    const result = validateTaskRegressionScenarioBundleV2(s4Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'displayed_result_stale_receipt_released', passed: true }),
    ]));
  });

  it('rejects S4 when stale reclassification points at another receipt', () => {
    const bundle = s4Bundle();
    findScenarioEvidence(bundle, 'inject_stale', 'stale_reclassification')!
      .observation.sourceReceiptRef = 'receipt_cross_request';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('stale_receipt_source_binding_invalid');
  });

  it('accepts S6 only when text keeps the task but replaces the rejected voice target with the user-corrected target', () => {
    const result = validateTaskRegressionScenarioBundleV2(s6Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'voice_failure_text_same_task_recovery', passed: true }),
    ]));
  });

  it('rejects S6 when the channel handoff claims a different target task', () => {
    const bundle = s6Bundle();
    findScenarioEvidence(bundle, 'text_continue', 'channel_handoff')!
      .observation.targetTaskRef = 'task_cross_handoff';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('voice_text_handoff_join_invalid');
  });

  it('fails S6 closed when a caller self-reports an unverified physical microphone capture', () => {
    const bundle = s6Bundle();
    findScenarioEvidence(bundle, 'text_continue', 'channel_handoff')!
      .observation.captureMode = 'physical_microphone';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('enum_value_required');
  });

  it('fails S6 closed when the handoff omits its capture provenance', () => {
    const bundle = s6Bundle();
    delete findScenarioEvidence(bundle, 'text_continue', 'channel_handoff')!
      .observation.captureMode;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('required');
  });

  it('rejects S6 when the handoff targets a message other than the correcting text turn', () => {
    const bundle = s6Bundle();
    findScenarioEvidence(bundle, 'text_continue', 'channel_handoff')!
      .observation.targetMessageRef = 'user_cross_request';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('voice_text_handoff_join_invalid');
  });

  it('rejects S6 when a corrected text turn silently reuses the failed voice target', () => {
    const bundle = s6Bundle();
    const voiceAction = findScenarioEvidence(bundle, 'voice_start', 'action_set')!;
    const textAction = findScenarioEvidence(bundle, 'text_continue', 'action_set')!;
    const correction = findScenarioEvidence(bundle, 'text_continue', 'target_correction')!;
    const voiceReceipt = (voiceAction.observation.receipts as Array<Record<string, any>>)[0];
    const textReceipt = (textAction.observation.receipts as Array<Record<string, any>>)[0];
    textReceipt.target = voiceReceipt.target;
    textReceipt.inputSha256 = voiceReceipt.inputSha256;
    correction.observation.replacementTarget = voiceReceipt.target;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('voice_text_corrected_target_transition_invalid');
  });

  it('rejects S6 when correction evidence does not bind the rejected target to its replacement', () => {
    const bundle = s6Bundle();
    findScenarioEvidence(bundle, 'text_continue', 'target_correction')!
      .observation.rejectedTargetSha256 = SHA_E;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('voice_text_target_correction_join_invalid');
  });

  it('fails S6 closed when the structured target-correction evidence is absent', () => {
    const bundle = s6Bundle();
    bundle.evidence = bundle.evidence.filter(item => !(
      item.phaseId === 'text_continue'
        && item.observation.observationKind === 'target_correction'
    ));
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'required_phase_evidence_missing',
      'voice_text_target_correction_cardinality_invalid',
    ]));
  });

  it('accepts S7 only when restart recovery restores the exact pending task/action/checkpoint once', () => {
    const result = validateTaskRegressionScenarioBundleV2(s7Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'restart_same_task_exact_action_recovered', passed: true }),
    ]));
  });

  it('rejects S7 when recovered evidence is joined to another restart checkpoint', () => {
    const bundle = s7Bundle();
    findScenarioEvidence(bundle, 'recovered', 'runtime_transition')!
      .observation.checkpointSha256 = SHA_F;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('restart_recovery_checkpoint_join_invalid');
  });

  it('accepts S8 only when failed primary and LM Studio witnesses join one request before same-task continuation', () => {
    const result = validateTaskRegressionScenarioBundleV2(s8Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'primary_failure_lmstudio_same_task_continuation', passed: true,
      }),
    ]));
  });

  it('rejects S8 when the LM Studio provider witness belongs to another request', () => {
    const bundle = s8Bundle();
    findScenarioEvidence(bundle, 'lmstudio_attempt_succeeded', 'provider_attempt')!
      .observation.requestRef = 'request_cross_failover';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toEqual(expect.arrayContaining([
      'primary_failure_lmstudio_selection_invalid',
      'model_provider_request_marker_join_invalid',
    ]));
  });

  it('accepts a request-only S5 sequence without task rows or action receipts', () => {
    const result = validateTaskRegressionScenarioBundleV2(s5Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'request_only_control_sequence', passed: true }),
    ]));
    expect(s5Bundle().evidence.some(item => item.observation.observationKind === 'action_set')).toBe(false);
    expect(s5Bundle().evidence.some(item => item.observation.observationKind === 'conversation_state')).toBe(false);
  });

  it('binds S5 stop/status to the long request and repeat to the status request', () => {
    const bundle = s5Bundle();
    const stop = bundle.evidence.find(item => (
      item.phaseId === 'stop' && item.observation.observationKind === 'turn'
    ));
    stop!.observation.targetRequestRef = 'request_unrelated';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('control_target_request_mismatch');
  });

  it('requires S5 repeat to preserve the exact status reply digest', () => {
    const bundle = s5Bundle();
    const repeat = bundle.evidence.find(item => (
      item.phaseId === 'repeat_status' && item.observation.observationKind === 'turn'
    ));
    repeat!.observation.userVisibleReply = {
      ...(repeat!.observation.userVisibleReply as Record<string, unknown>),
      textSha256: SHA_C,
    };
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('control_repeat_reply_mismatch');
  });

  it('requires S5 control sidecars to complete while the long model turn is cancelled', () => {
    const bundle = s5Bundle();
    const stop = bundle.evidence.find(item => (
      item.phaseId === 'stop' && item.observation.observationKind === 'turn'
    ));
    stop!.observation.terminalStatus = 'cancelled';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('control_sidecar_terminal_must_complete');
  });

  it('requires complete cancelled model and provider evidence for the S5 long turn', () => {
    const bundle = s5Bundle();
    const provider = bundle.evidence.find(item => (
      item.phaseId === 'long_start' && item.observation.observationKind === 'provider_attempt'
    ));
    provider!.observation.visibleOutputCommitted = true;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('cancelled_model_provider_evidence_incomplete');
  });

  it('rejects duplicate evidence ids instead of allowing one record to prove two facts', () => {
    const bundle = s5Bundle();
    bundle.evidence[1].evidenceId = bundle.evidence[0].evidenceId;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('duplicate_evidence_id');
  });

  it('rejects an evidence record assigned to a phase outside its scenario profile', () => {
    const bundle = s5Bundle();
    bundle.evidence[3].phaseId = 'repeat_previous_random_answer';
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('unknown_scenario_phase');
    expect(issueCodes(result)).toContain('required_phase_evidence_missing');
  });

  it('rejects additional fields on a discriminated observation branch', () => {
    const bundle = s5Bundle();
    Object.assign(bundle.evidence[0].observation, { unexpectedToolTarget: SHA_A });
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('unknown_property');
  });

  it('rejects a collector-authored passed flag and computes pass state itself', () => {
    const forged = { ...s5Bundle(), passed: true };
    const result = validateTaskRegressionScenarioBundleV2(forged);
    expect(result.ok).toBe(false);
    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('unknown_property');
    expect(result.adjudicationSource).toBe('task_regression_truth_v2_validator');
  });

  it('accepts exactly one receipt at each S2 action boundary', () => {
    const result = validateTaskRegressionScenarioBundleV2(s2Bundle());
    expect(result).toMatchObject({ ok: true, valid: true, passed: true });
    expect(issueCodes(result)).toEqual([]);
  });

  it('requires S2 pending and first confirmation to join the same exact action', () => {
    const bundle = s2Bundle();
    const firstAction = bundle.evidence.find(item => (
      item.phaseId === 'confirm_first' && item.observation.observationKind === 'action_set'
    ));
    const receipts = firstAction!.observation.receipts as Array<Record<string, unknown>>;
    receipts[0].inputSha256 = SHA_C;
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('confirmation_action_join_mismatch');
  });

  it('requires S2 repeat absence to cover task, receipt, tool, and artifact sources', () => {
    const bundle = s2Bundle();
    const absence = bundle.evidence.find(item => (
      item.phaseId === 'confirm_repeat' && item.observation.observationKind === 'absence_window'
    ));
    absence!.observation.sources = ['socket_tool_events', 'passive_receipt_store'];
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('duplicate_confirmation_absence_proof_invalid');
  });

  it('adjudicates two equally matching confirmation receipts as ambiguous', () => {
    const result = validateTaskRegressionScenarioBundleV2(s2Bundle({ ambiguous: true }));
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(issueCodes(result)).toContain('ambiguous_receipt_binding');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'phase:confirm_first:evidence_contract',
        passed: false,
        failureCodes: expect.arrayContaining(['ambiguous_receipt_binding']),
      }),
    ]));
  });

  it('rejects duplicate receipt ids inside one action set at schema-validation time', () => {
    const bundle = s2Bundle();
    const action = bundle.evidence.find(item => (
      item.phaseId === 'confirm_first' && item.observation.observationKind === 'action_set'
    ));
    const receipts = action!.observation.receipts as Array<Record<string, unknown>>;
    const receipt = receipts[0];
    receipts.push({ ...receipt });
    const result = validateTaskRegressionScenarioBundleV2(bundle);
    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('duplicate_receipt_ref');
  });

  it('rejects a union branch that mixes request and system-event fields', () => {
    const record = s5Bundle().evidence[0];
    Object.assign(record.binding, { eventKind: 'backend_restart' });
    const result = validateTaskRegressionEvidenceRecordV2(record);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('unknown_property');
  });
});
