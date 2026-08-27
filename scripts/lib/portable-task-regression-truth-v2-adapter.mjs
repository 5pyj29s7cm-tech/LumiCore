import crypto from 'node:crypto';
import path from 'node:path';
import {
  normalizePortableEvidenceManifest,
  normalizePortableServerTruthSigner,
  phaseBindingFromManifest,
  portableEvidenceHmacKeyId,
  portableEvidenceSha256,
  signPortableEvidenceRecord,
  stablePortableEvidenceJson,
  verifyPortableEvidenceRecord,
} from './portable-external-evidence.mjs';
import {
  PORTABLE_BUILD_IDENTITY_KIND,
  PORTABLE_SIGNED_MANIFEST_KIND,
} from './portable-evidence-comparison.mjs';
import { createPortablePairedRunnerHooks } from './portable-paired-runner.mjs';
import {
  TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND,
  TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND,
  TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
  TASK_REGRESSION_V2_SCENARIO_IDS,
  TASK_REGRESSION_V2_SCENARIO_PROFILES,
  validateTaskRegressionScenarioBundleV2,
} from './task-regression-truth-v2.mjs';

export const PORTABLE_TRUTH_V2_CHANNEL_RECORD_KIND =
  'lumi.portable-task-regression-truth-v2-channel-record';
export const PORTABLE_TRUTH_V2_PAIRED_RUN_KIND =
  'lumi.portable-task-regression-truth-v2-paired-run';
export const PORTABLE_TRUTH_V2_ADAPTER_SCHEMA_VERSION = 1;

export const PORTABLE_TRUTH_V2_CHANNELS = Object.freeze([
  'runner_socket',
  'passive_store_probe',
  'provider_witness',
  'filesystem_witness',
]);

export const PORTABLE_TRUTH_V2_EXECUTOR_WIRING_CONTRACT = Object.freeze({
  status: 'adapter_ready_executor_not_wired',
  integrationPoints: Object.freeze([
    'retain_paired_barrier_signed_manifests_build_identities_and_digest_contract',
    'emit_runner_socket_records_at_exact_request_and_system_phase_boundaries',
    'emit_passive_store_records_from_exact_manifest_selectors_without_latest_wins',
    'emit_provider_records_at_raw_dispatch_boundary_with_exact_phase_marker',
    'emit_filesystem_records_from_sealed_fixture_witnesses',
    'emit_s6_handoff_and_correction_from_server_voice_text_continuation_truth',
    'retain_s6_voice_start_and_text_continue_passive_store_snapshots',
    'invoke_adapter_after_all_eight_scenarios_before_sandbox_cleanup',
  ]),
  forbiddenDependencies: Object.freeze([
    'candidate_specific_truth_endpoint',
    'user_visible_text_task_inference',
    'user_visible_text_receipt_inference',
    'user_visible_text_target_inference',
    'caller_asserted_physical_microphone_provenance',
  ]),
});

const SHA256_RE = /^[a-f0-9]{64}$/u;
const REVISION_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROLES = Object.freeze(['baseline', 'candidate']);
const S6_SERVER_TRUTH_ENVELOPE_KIND = 'lumi.voice-text-continuation-truth-envelope';
const S6_SERVER_TRUTH_ATTESTATION_KIND = 'lumi.voice-text-continuation-truth-attestation';
const S6_SERVER_TRUTH_SIGNATURE_DOMAIN =
  'lumi-voice-text-continuation-truth-attestation-v1\0';

const CHANNEL_OBSERVATION_KINDS = Object.freeze({
  runner_socket: Object.freeze([
    'turn', 'action_set', 'model_route', 'model_noninvocation', 'channel_handoff',
  ]),
  passive_store_probe: Object.freeze([
    'conversation_state', 'target_correction', 'stale_reclassification', 'runtime_transition',
  ]),
  provider_witness: Object.freeze(['provider_attempt']),
  filesystem_witness: Object.freeze(['native_target', 'artifact_state', 'absence_window']),
});

const OBSERVATION_CHANNEL = Object.freeze(Object.fromEntries(
  Object.entries(CHANNEL_OBSERVATION_KINDS)
    .flatMap(([channel, kinds]) => kinds.map(kind => [kind, channel])),
));

const SYSTEM_PHASE_BINDINGS = Object.freeze({
  'displayed_result_stale_receipt/inject_stale': {
    eventKind: 'stale_reclassification',
    sourcePhaseId: 'display',
  },
  'mid_task_restart_recovery/restart': {
    eventKind: 'backend_restart',
    sourcePhaseId: 'prepare',
  },
  'mid_task_restart_recovery/recovered': {
    eventKind: 'post_restart_recovery',
    sourcePhaseId: 'restart',
  },
  'primary_model_failover_lmstudio/primary_attempt_failed': {
    eventKind: 'primary_model_attempt',
    sourcePhaseId: 'start',
  },
  'primary_model_failover_lmstudio/lmstudio_attempt_succeeded': {
    eventKind: 'fallback_model_attempt',
    sourcePhaseId: 'primary_attempt_failed',
  },
});

const ABSENCE_SOURCE_CHANNELS = Object.freeze([
  'runner_socket',
  'passive_store_probe',
  'filesystem_witness',
]);

export class PortableTruthV2AdapterError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'PortableTruthV2AdapterError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new PortableTruthV2AdapterError(code, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required, code) {
  if (!isPlainObject(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    fail(code);
  }
  return value;
}

function exactSha256(value, code) {
  const digest = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(digest)) fail(code);
  return digest;
}

function exactText(value, code, limit = 2_000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > limit) fail(code);
  return text;
}

function canonicalAbsoluteFilesystemPath(value, code) {
  const supplied = exactText(value, code, 2_000);
  if (/^[a-z]:[\\/]/iu.test(supplied) || /^\\\\/u.test(supplied)) {
    if (!path.win32.isAbsolute(supplied)) fail(code);
    const withNativeSeparators = supplied.replaceAll('/', '\\');
    const normalized = path.win32.normalize(withNativeSeparators);
    if (normalized !== withNativeSeparators || !path.win32.basename(normalized)) fail(code);
    return {
      flavor: 'windows',
      normalized,
      identity: normalized.toLocaleLowerCase('en-US'),
      displayName: path.win32.basename(normalized),
    };
  }
  if (supplied.startsWith('/')) {
    if (!path.posix.isAbsolute(supplied)) fail(code);
    const normalized = path.posix.normalize(supplied);
    if (normalized !== supplied || normalized === '/' || !path.posix.basename(normalized)) fail(code);
    return {
      flavor: 'posix',
      normalized,
      identity: normalized,
      displayName: path.posix.basename(normalized),
    };
  }
  fail(code);
}

export function portableTaskRegressionCanonicalPathHmac(value, key) {
  const canonical = canonicalAbsoluteFilesystemPath(
    value,
    'portable_truth_v2_s6_target_path_invalid',
  );
  // Reuse the installation key validation contract before deriving a
  // domain-separated, non-reversible portable path identity.
  portableEvidenceHmacKeyId(key);
  const bytes = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key || ''), 'utf8');
  return crypto.createHmac('sha256', bytes)
    .update('lumi-portable-task-regression-canonical-path-v1\0', 'utf8')
    .update(canonical.flavor, 'utf8')
    .update('\0', 'utf8')
    .update(canonical.identity, 'utf8')
    .digest('hex');
}

function canonicalInstant(value, code) {
  const text = String(value || '').trim();
  if (!ISO_INSTANT_RE.test(text) || !Number.isFinite(Date.parse(text))) fail(code);
  if (new Date(text).toISOString() !== text) fail(code);
  return text;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function cloneJson(value, code) {
  try {
    return JSON.parse(stablePortableEvidenceJson(value));
  } catch {
    fail(code);
  }
}

function stableS6ServerValue(value) {
  if (Array.isArray(value)) return value.map(stableS6ServerValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [
    key,
    stableS6ServerValue(value[key]),
  ]));
}

function stableS6ServerJson(value) {
  return JSON.stringify(stableS6ServerValue(value));
}

function exactJson(left, right) {
  return stablePortableEvidenceJson(left) === stablePortableEvidenceJson(right);
}

function unsignedRecord(record) {
  const result = { ...record };
  delete result.attestation;
  return result;
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  if (!ROLES.includes(role)) fail('portable_truth_v2_role_invalid');
  return role;
}

function normalizeChannel(value) {
  const channel = String(value || '').trim();
  if (!PORTABLE_TRUTH_V2_CHANNELS.includes(channel)) {
    fail('portable_truth_v2_channel_invalid');
  }
  return channel;
}

export function taskRegressionTruthV2ProfileSha256() {
  return portableEvidenceSha256({
    kind: 'lumi.task-regression-truth-v2-profile',
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    scenarioIds: TASK_REGRESSION_V2_SCENARIO_IDS,
    profiles: TASK_REGRESSION_V2_SCENARIO_PROFILES,
  });
}

function normalizeCollectorArtifacts(input) {
  const value = exactKeys(
    input,
    PORTABLE_TRUTH_V2_CHANNELS,
    PORTABLE_TRUTH_V2_CHANNELS,
    'portable_truth_v2_collector_artifacts_invalid',
  );
  return Object.fromEntries(PORTABLE_TRUTH_V2_CHANNELS.map(channel => [
    channel,
    exactSha256(value[channel], 'portable_truth_v2_collector_artifact_invalid'),
  ]));
}

function normalizeServerTruthSigners(input) {
  const value = exactKeys(
    input,
    ROLES,
    ROLES,
    'portable_truth_v2_server_truth_signers_invalid',
  );
  const signers = Object.fromEntries(ROLES.map(role => [
    role,
    normalizePortableServerTruthSigner(value[role]),
  ]));
  if (signers.baseline.keyId === signers.candidate.keyId
    || signers.baseline.serverInstanceNonce === signers.candidate.serverInstanceNonce) {
    fail('portable_truth_v2_distinct_server_truth_signers_required');
  }
  return signers;
}

function normalizeContract(input) {
  const value = exactKeys(
    input,
    [
      'controllerArtifactSha256', 'collectorArtifacts', 'profileSha256',
      'collectorBundleSha256', 'fixturePlanSha256', 'timeoutPolicySha256',
      'coverageSha256', 'paritySha256', 'serverTruthSigners',
    ],
    [
      'controllerArtifactSha256', 'collectorArtifacts', 'profileSha256',
      'collectorBundleSha256', 'fixturePlanSha256', 'timeoutPolicySha256',
      'coverageSha256', 'paritySha256', 'serverTruthSigners',
    ],
    'portable_truth_v2_contract_invalid',
  );
  const contract = {
    controllerArtifactSha256: exactSha256(
      value.controllerArtifactSha256,
      'portable_truth_v2_controller_digest_invalid',
    ),
    collectorArtifacts: normalizeCollectorArtifacts(value.collectorArtifacts),
    profileSha256: exactSha256(value.profileSha256, 'portable_truth_v2_profile_digest_invalid'),
    collectorBundleSha256: exactSha256(
      value.collectorBundleSha256,
      'portable_truth_v2_collector_bundle_digest_invalid',
    ),
    fixturePlanSha256: exactSha256(
      value.fixturePlanSha256,
      'portable_truth_v2_fixture_digest_invalid',
    ),
    timeoutPolicySha256: exactSha256(
      value.timeoutPolicySha256,
      'portable_truth_v2_timeout_digest_invalid',
    ),
    coverageSha256: exactSha256(
      value.coverageSha256,
      'portable_truth_v2_coverage_digest_invalid',
    ),
    paritySha256: exactSha256(value.paritySha256, 'portable_truth_v2_parity_digest_invalid'),
    serverTruthSigners: normalizeServerTruthSigners(value.serverTruthSigners),
  };
  if (contract.profileSha256 !== taskRegressionTruthV2ProfileSha256()) {
    fail('portable_truth_v2_profile_contract_mismatch');
  }
  return contract;
}

export function createPortableTruthV2AdapterContract(input) {
  return normalizeContract(input);
}

function expectedPhaseContracts() {
  return TASK_REGRESSION_V2_SCENARIO_IDS.flatMap(scenarioId => (
    TASK_REGRESSION_V2_SCENARIO_PROFILES[scenarioId].phases.map((phase, index) => ({
      scenarioId,
      phaseId: phase.phaseId,
      phaseOrdinal: index + 1,
      bindingKind: phase.bindingKind,
      expectedToolName: phase.action?.toolName || '',
      profile: phase,
    }))
  ));
}

function phaseKey(scenarioId, phaseId) {
  return `${scenarioId}/${phaseId}`;
}

function assertManifestCoverage(manifest) {
  const expected = expectedPhaseContracts();
  if (manifest.phases.length !== expected.length) {
    fail('portable_truth_v2_exact_eight_scenario_coverage_required');
  }
  manifest.phases.forEach((phase, index) => {
    const contract = expected[index];
    if (phase.scenarioId !== contract.scenarioId
      || phase.phaseId !== contract.phaseId
      || phase.expectedToolName !== contract.expectedToolName) {
      fail('portable_truth_v2_manifest_profile_coverage_mismatch', {
        index,
        expected: phaseKey(contract.scenarioId, contract.phaseId),
        actual: phaseKey(phase.scenarioId, phase.phaseId),
      });
    }
    const required = contract.profile.required || [];
    if (required.includes('provider_attempt') && phase.requirements.providerWitness !== true) {
      fail('portable_truth_v2_manifest_provider_requirement_missing');
    }
    if (required.some(kind => OBSERVATION_CHANNEL[kind] === 'passive_store_probe')
      && phase.requirements.passiveStore !== true) {
      fail('portable_truth_v2_manifest_store_requirement_missing');
    }
  });
}

function normalizeSignedManifest(envelope, key, expectedRole) {
  if (!verifyPortableEvidenceRecord(envelope, key)) {
    fail('portable_truth_v2_manifest_attestation_invalid', { role: expectedRole });
  }
  exactKeys(
    envelope,
    ['kind', 'schemaVersion', 'manifestDigest', 'manifest', 'attestation'],
    ['kind', 'schemaVersion', 'manifestDigest', 'manifest', 'attestation'],
    'portable_truth_v2_manifest_envelope_invalid',
  );
  if (envelope.kind !== PORTABLE_SIGNED_MANIFEST_KIND || envelope.schemaVersion !== 1) {
    fail('portable_truth_v2_manifest_envelope_invalid');
  }
  const manifest = normalizePortableEvidenceManifest(envelope.manifest);
  if (manifest.role !== expectedRole
    || envelope.manifestDigest !== manifest.manifestDigest
    || (manifest.hmacKeyId && manifest.hmacKeyId !== portableEvidenceHmacKeyId(key))) {
    fail('portable_truth_v2_manifest_role_or_digest_mismatch', { role: expectedRole });
  }
  assertManifestCoverage(manifest);
  return manifest;
}

function normalizeSignedBuildIdentity(record, key, role, manifest) {
  if (!verifyPortableEvidenceRecord(record, key)) {
    fail('portable_truth_v2_build_attestation_invalid', { role });
  }
  exactKeys(
    record,
    [
      'kind', 'schemaVersion', 'role', 'revision', 'sourceDirty',
      'sourceFingerprintSha256', 'runtimeFingerprintSha256', 'collectedAt',
      'buildIdentityDigest', 'attestation',
    ],
    [
      'kind', 'schemaVersion', 'role', 'revision', 'sourceDirty',
      'sourceFingerprintSha256', 'runtimeFingerprintSha256', 'collectedAt',
      'buildIdentityDigest', 'attestation',
    ],
    'portable_truth_v2_build_identity_invalid',
  );
  if (record.kind !== PORTABLE_BUILD_IDENTITY_KIND
    || record.schemaVersion !== 1
    || record.role !== role
    || typeof record.sourceDirty !== 'boolean') {
    fail('portable_truth_v2_build_identity_invalid', { role });
  }
  const core = {
    kind: record.kind,
    schemaVersion: record.schemaVersion,
    role,
    revision: (() => {
      const revision = String(record.revision || '').trim().toLowerCase();
      if (!REVISION_RE.test(revision)) fail('portable_truth_v2_build_revision_invalid');
      return revision;
    })(),
    sourceDirty: record.sourceDirty,
    sourceFingerprintSha256: exactSha256(
      record.sourceFingerprintSha256,
      'portable_truth_v2_build_source_digest_invalid',
    ),
    runtimeFingerprintSha256: exactSha256(
      record.runtimeFingerprintSha256,
      'portable_truth_v2_build_runtime_digest_invalid',
    ),
    collectedAt: canonicalInstant(record.collectedAt, 'portable_truth_v2_build_time_invalid'),
  };
  const buildIdentityDigest = portableEvidenceSha256(core);
  if (record.buildIdentityDigest !== buildIdentityDigest
    || manifest.buildIdentityDigest !== buildIdentityDigest
    || (role === 'baseline' && record.sourceDirty !== false)) {
    fail('portable_truth_v2_build_manifest_binding_invalid', { role });
  }
  return { ...core, buildIdentityDigest };
}

function assertContractManifestBinding(contract, manifest, pairedPlan) {
  if (manifest.profileSha256 !== contract.profileSha256
    || manifest.collectorBundleSha256 !== contract.collectorBundleSha256
    || manifest.fixturePlanSha256 !== contract.fixturePlanSha256
    || portableEvidenceSha256(manifest.timeoutPolicy) !== contract.timeoutPolicySha256
    || pairedPlan.coverageSha256 !== contract.coverageSha256
    || pairedPlan.paritySha256 !== contract.paritySha256
    || !manifest.serverTruthSigner
    || !exactJson(manifest.serverTruthSigner, contract.serverTruthSigners[manifest.role])) {
    fail('portable_truth_v2_manifest_contract_binding_invalid', { role: manifest.role });
  }
}

function exactPortableBinding(manifest, binding) {
  if (!isPlainObject(binding)) fail('portable_truth_v2_phase_binding_required');
  const phase = manifest.phases.find(item => item.bindingDigest === binding.bindingDigest);
  if (!phase) fail('portable_truth_v2_phase_binding_unknown');
  const resolved = phaseBindingFromManifest(manifest, {
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  });
  if (!exactJson(resolved.binding, binding)) fail('portable_truth_v2_phase_binding_mismatch');
  return { phase, binding: resolved.binding };
}

function systemBindingContract(phase) {
  return SYSTEM_PHASE_BINDINGS[phaseKey(phase.scenarioId, phase.phaseId)] || null;
}

function sourcePhaseForSystemEvent(manifest, phase) {
  const system = systemBindingContract(phase);
  if (!system) return null;
  const source = manifest.phases.find(item => (
    item.scenarioId === phase.scenarioId && item.phaseId === system.sourcePhaseId
  ));
  if (!source) fail('portable_truth_v2_system_source_binding_missing');
  return source;
}

function sourceRequestPhase(manifest, phase) {
  let current = phase;
  const seen = new Set();
  while (systemBindingContract(current)) {
    if (seen.has(current.bindingDigest)) fail('portable_truth_v2_system_binding_cycle');
    seen.add(current.bindingDigest);
    current = sourcePhaseForSystemEvent(manifest, current);
  }
  return current;
}

function normalProofFor(channel, manifest, phase, observations) {
  const bindingDigest = phase.bindingDigest;
  const system = systemBindingContract(phase);
  const requestPhase = sourceRequestPhase(manifest, phase);
  if (channel === 'runner_socket') {
    return {
      kind: 'exact_socket_request_v1',
      requestId: requestPhase.requestId,
      conversationId: requestPhase.conversationId,
      bindingDigest: requestPhase.bindingDigest,
      projectedSystemBindingDigest: system ? bindingDigest : null,
      phaseNonceSha256: portableEvidenceSha256(requestPhase.phaseNonce),
    };
  }
  if (channel === 'passive_store_probe') {
    if (system) {
      const source = sourcePhaseForSystemEvent(manifest, phase);
      return {
        kind: 'exact_system_event_store_v1',
        eventKind: system.eventKind,
        sourceBindingDigest: source.bindingDigest,
        sourceRequestBindingDigest: requestPhase.bindingDigest,
        projectedSystemBindingDigest: bindingDigest,
        conversationId: requestPhase.conversationId,
        eventNonceSha256: portableEvidenceSha256(phase.phaseNonce),
      };
    }
    return {
      kind: 'exact_passive_store_selector_v1',
      selectionPolicy: 'exact_conversation_user_request_only_no_latest_wins',
      requestId: phase.requestId,
      conversationId: phase.conversationId,
      userId: phase.userId,
      bindingDigest,
    };
  }
  if (channel === 'provider_witness') {
    const attempts = observations.filter(item => item?.observationKind === 'provider_attempt');
    if (attempts.length !== 1) fail('portable_truth_v2_provider_attempt_cardinality_invalid');
    return {
      kind: 'raw_provider_marker_v1',
      requestSha256: exactSha256(
        attempts[0].requestSha256,
        'portable_truth_v2_provider_request_digest_invalid',
      ),
      providerMarkerSha256: portableEvidenceSha256(requestPhase.providerMarker),
      phaseNonceSha256: portableEvidenceSha256(requestPhase.phaseNonce),
      observedPhaseBindingDigests: [requestPhase.bindingDigest],
      projectedSystemBindingDigest: system ? bindingDigest : null,
    };
  }
  return {
    kind: 'sealed_fixture_filesystem_v1',
    fixturePlanSha256: manifest.fixturePlanSha256,
    bindingDigest,
  };
}

function normalizeAbsenceProof(proof, phase) {
  const value = exactKeys(
    proof,
    [
      'kind', 'bindingDigest', 'requestId', 'conversationId',
      'matcherSha256', 'matchedRecordCount',
    ],
    [
      'kind', 'bindingDigest', 'requestId', 'conversationId',
      'matcherSha256', 'matchedRecordCount',
    ],
    'portable_truth_v2_absence_proof_invalid',
  );
  if (value.kind !== 'exact_channel_absence_v1'
    || value.bindingDigest !== phase.bindingDigest
    || value.requestId !== phase.requestId
    || value.conversationId !== phase.conversationId
    || value.matchedRecordCount !== 0) {
    fail('portable_truth_v2_absence_proof_invalid');
  }
  return {
    kind: value.kind,
    bindingDigest: value.bindingDigest,
    requestId: value.requestId,
    conversationId: value.conversationId,
    matcherSha256: exactSha256(
      value.matcherSha256,
      'portable_truth_v2_absence_matcher_invalid',
    ),
    matchedRecordCount: 0,
  };
}

function normalizeNormalProof(channel, proof, manifest, phase, observations) {
  const expected = normalProofFor(channel, manifest, phase, observations);
  if (!exactJson(proof, expected)) {
    const code = channel === 'passive_store_probe'
      ? 'portable_truth_v2_store_selector_binding_invalid'
      : channel === 'provider_witness'
        ? 'portable_truth_v2_provider_marker_binding_invalid'
        : 'portable_truth_v2_channel_proof_binding_invalid';
    fail(code, { channel, phase: phaseKey(phase.scenarioId, phase.phaseId) });
  }
  return expected;
}

function normalizeChannelProof(channel, proof, manifest, phase, observations) {
  if (proof?.kind === 'exact_channel_absence_v1') return normalizeAbsenceProof(proof, phase);
  return normalizeNormalProof(channel, proof, manifest, phase, observations);
}

function exactS6Phase(manifest, phaseId) {
  const matches = manifest.phases.filter(phase => (
    phase.scenarioId === 'voice_to_text_continuation' && phase.phaseId === phaseId
  ));
  if (matches.length !== 1) fail('portable_truth_v2_s6_phase_binding_invalid', { phaseId });
  return matches[0];
}

function normalizeS6Request(value, expected, code) {
  const request = exactKeys(
    value,
    [
      'recordId', 'requestId', 'taskId', 'channel', 'source', 'terminalStatus',
      'userMessageId', 'assistantMessageId', 'recordedAt',
    ],
    [
      'recordId', 'requestId', 'taskId', 'channel', 'source', 'terminalStatus',
      'userMessageId', 'assistantMessageId', 'recordedAt',
    ],
    code,
  );
  const normalized = {
    recordId: exactText(request.recordId, code, 180),
    requestId: exactText(request.requestId, code, 180),
    taskId: exactText(request.taskId, code, 180),
    channel: request.channel,
    source: exactText(request.source, code, 120),
    terminalStatus: request.terminalStatus,
    userMessageId: exactText(request.userMessageId, code, 180),
    assistantMessageId: exactText(request.assistantMessageId, code, 180),
    recordedAt: canonicalInstant(request.recordedAt, code),
  };
  if (normalized.requestId !== expected.requestId
    || normalized.channel !== expected.channel
    || normalized.terminalStatus !== expected.terminalStatus) {
    fail(code);
  }
  return normalized;
}

function normalizeS6ReadReceipt(value, expected, code) {
  const receipt = exactKeys(
    value,
    [
      'recordId', 'receiptId', 'requestId', 'taskId', 'toolName', 'outcome',
      'inputSha256', 'target', 'recordedAt',
    ],
    [
      'recordId', 'receiptId', 'requestId', 'taskId', 'toolName', 'outcome',
      'inputSha256', 'target', 'recordedAt',
    ],
    code,
  );
  const target = exactKeys(
    receipt.target,
    ['targetKind', 'targetId', 'targetSha256'],
    ['targetKind', 'targetId', 'targetSha256'],
    code,
  );
  const canonicalTarget = canonicalAbsoluteFilesystemPath(target.targetId, code);
  const targetSha256 = exactSha256(target.targetSha256, code);
  if (target.targetKind !== 'filesystem'
    || targetSha256 !== portableEvidenceSha256(canonicalTarget.normalized)
    || receipt.requestId !== expected.requestId
    || receipt.toolName !== 'read_file'
    || receipt.outcome !== expected.outcome) {
    fail(code);
  }
  const normalized = {
    recordId: exactText(receipt.recordId, code, 180),
    receiptId: exactText(receipt.receiptId, code, 180),
    requestId: exactText(receipt.requestId, code, 180),
    taskId: exactText(receipt.taskId, code, 180),
    toolName: 'read_file',
    outcome: expected.outcome,
    inputSha256: exactSha256(receipt.inputSha256, code),
    target: {
      targetKind: 'filesystem',
      targetId: canonicalTarget.normalized,
      targetSha256,
    },
    canonicalTarget,
    recordedAt: canonicalInstant(receipt.recordedAt, code),
  };
  if (normalized.recordId !== normalized.receiptId) fail(code);
  return normalized;
}

function normalizeS6InnerEnvelope(value, manifest, expectedSigner) {
  const envelope = exactKeys(
    value,
    ['kind', 'schemaVersion', 'binding', 'truth', 'attestation'],
    ['kind', 'schemaVersion', 'binding', 'truth', 'attestation'],
    'portable_truth_v2_s6_inner_attestation_required',
  );
  const binding = exactKeys(
    envelope.binding,
    [
      'acceptanceRunId', 'buildIdentityDigest', 'dataRootIdentitySha256',
      'serverInstanceNonce', 'scenarioId', 'conversationId', 'voiceRequestId',
      'textRequestId', 'taskId', 'capturedAt', 'evidenceDigestSha256',
    ],
    [
      'acceptanceRunId', 'buildIdentityDigest', 'dataRootIdentitySha256',
      'serverInstanceNonce', 'scenarioId', 'conversationId', 'voiceRequestId',
      'textRequestId', 'taskId', 'capturedAt', 'evidenceDigestSha256',
    ],
    'portable_truth_v2_s6_inner_attestation_invalid',
  );
  const attestation = exactKeys(
    envelope.attestation,
    ['kind', 'schemaVersion', 'algorithm', 'keyId', 'signatureBase64'],
    ['kind', 'schemaVersion', 'algorithm', 'keyId', 'signatureBase64'],
    'portable_truth_v2_s6_inner_attestation_invalid',
  );
  if (envelope.kind !== S6_SERVER_TRUTH_ENVELOPE_KIND
    || envelope.schemaVersion !== 1
    || attestation.kind !== S6_SERVER_TRUTH_ATTESTATION_KIND
    || attestation.schemaVersion !== 1
    || attestation.algorithm !== 'ed25519'
    || attestation.keyId !== expectedSigner.keyId
    || binding.acceptanceRunId !== manifest.runId
    || binding.buildIdentityDigest !== manifest.buildIdentityDigest
    || binding.dataRootIdentitySha256 !== manifest.dataRootIdentitySha256
    || binding.serverInstanceNonce !== expectedSigner.serverInstanceNonce
    || binding.scenarioId !== 'voice_to_text_continuation') {
    fail('portable_truth_v2_s6_inner_attestation_invalid');
  }
  let signature;
  let publicKey;
  try {
    signature = Buffer.from(String(attestation.signatureBase64 || ''), 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== attestation.signatureBase64) {
      fail('portable_truth_v2_s6_inner_attestation_invalid');
    }
    publicKey = crypto.createPublicKey({
      key: Buffer.from(expectedSigner.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    if (error instanceof PortableTruthV2AdapterError) throw error;
    fail('portable_truth_v2_s6_inner_attestation_invalid');
  }
  const core = {
    kind: envelope.kind,
    schemaVersion: envelope.schemaVersion,
    binding: cloneJson(binding, 'portable_truth_v2_s6_inner_attestation_invalid'),
    truth: cloneJson(envelope.truth, 'portable_truth_v2_s6_inner_attestation_invalid'),
  };
  const payload = Buffer.concat([
    Buffer.from(S6_SERVER_TRUTH_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(stableS6ServerJson(core), 'utf8'),
  ]);
  if (!crypto.verify(null, payload, publicKey, signature)) {
    fail('portable_truth_v2_s6_inner_attestation_invalid');
  }
  return { envelope, binding, truth: core.truth };
}

function normalizeS6ServerTruth(value, manifest, contract, key) {
  const signed = normalizeS6InnerEnvelope(
    value,
    manifest,
    contract.serverTruthSigners[manifest.role],
  );
  if (!isPlainObject(signed.truth) || typeof signed.truth.conversationId !== 'string'
    || !signed.truth.conversationId.trim()) {
    fail('portable_truth_v2_s6_conversation_binding_invalid');
  }
  const truth = exactKeys(
    signed.truth,
    [
      'kind', 'schemaVersion', 'scenarioId', 'acceptanceRunId', 'buildIdentityDigest',
      'conversationId', 'capturedAt', 'task', 'voiceStart', 'textContinue',
      'channelHandoff', 'targetCorrection', 'evidenceDigestSha256',
    ],
    [
      'kind', 'schemaVersion', 'scenarioId', 'acceptanceRunId', 'buildIdentityDigest',
      'conversationId', 'capturedAt', 'task', 'voiceStart', 'textContinue',
      'channelHandoff', 'targetCorrection', 'evidenceDigestSha256',
    ],
    'portable_truth_v2_s6_server_truth_invalid',
  );
  const voicePhase = exactS6Phase(manifest, 'voice_start');
  const textPhase = exactS6Phase(manifest, 'text_continue');
  const voiceBinding = truthBinding(manifest, voicePhase);
  const textBinding = truthBinding(manifest, textPhase);
  const conversationId = exactText(
    truth.conversationId,
    'portable_truth_v2_s6_conversation_binding_invalid',
    180,
  );
  const capturedAt = canonicalInstant(
    truth.capturedAt,
    'portable_truth_v2_s6_server_truth_capture_time_invalid',
  );
  if (truth.kind !== 'lumi.voice-text-continuation-truth'
    || truth.schemaVersion !== 1
    || truth.scenarioId !== 'voice_to_text_continuation'
    || truth.acceptanceRunId !== manifest.runId
    || truth.buildIdentityDigest !== manifest.buildIdentityDigest
    || conversationId !== voiceBinding.conversationRef
    || conversationId !== textBinding.conversationRef) {
    fail('portable_truth_v2_s6_conversation_binding_invalid');
  }
  const truthWithoutDigest = cloneJson(truth, 'portable_truth_v2_s6_server_truth_invalid');
  delete truthWithoutDigest.evidenceDigestSha256;
  const evidenceDigestSha256 = exactSha256(
    truth.evidenceDigestSha256,
    'portable_truth_v2_s6_server_truth_digest_invalid',
  );
  if (evidenceDigestSha256 !== portableEvidenceSha256(stableS6ServerJson(truthWithoutDigest))) {
    fail('portable_truth_v2_s6_server_truth_digest_invalid');
  }

  const task = exactKeys(
    truth.task,
    ['recordId', 'taskId', 'revision', 'finalStatus'],
    ['recordId', 'taskId', 'revision', 'finalStatus'],
    'portable_truth_v2_s6_task_binding_invalid',
  );
  const taskId = exactText(task.taskId, 'portable_truth_v2_s6_task_binding_invalid', 180);
  if (!Number.isSafeInteger(task.revision) || task.revision < 2 || task.finalStatus !== 'completed') {
    fail('portable_truth_v2_s6_task_binding_invalid');
  }
  if (exactText(task.recordId, 'portable_truth_v2_s6_task_binding_invalid', 180) !== taskId) {
    fail('portable_truth_v2_s6_task_binding_invalid');
  }

  const voiceStart = exactKeys(
    truth.voiceStart,
    ['request', 'userMessage', 'capture', 'receipt'],
    ['request', 'userMessage', 'capture', 'receipt'],
    'portable_truth_v2_s6_voice_binding_invalid',
  );
  const textContinue = exactKeys(
    truth.textContinue,
    ['request', 'userMessage', 'receipt'],
    ['request', 'userMessage', 'receipt'],
    'portable_truth_v2_s6_text_binding_invalid',
  );
  const voiceRequest = normalizeS6Request(voiceStart.request, {
    requestId: voicePhase.requestId,
    channel: 'voice',
    terminalStatus: 'blocked',
  }, 'portable_truth_v2_s6_voice_binding_invalid');
  const textRequest = normalizeS6Request(textContinue.request, {
    requestId: textPhase.requestId,
    channel: 'text',
    terminalStatus: 'completed',
  }, 'portable_truth_v2_s6_text_binding_invalid');
  if (voiceRequest.taskId !== taskId || textRequest.taskId !== taskId) {
    fail('portable_truth_v2_s6_task_binding_invalid');
  }

  const voiceUser = exactKeys(
    voiceStart.userMessage,
    ['recordId', 'source', 'channel', 'mode', 'textSha256', 'recordedAt'],
    ['recordId', 'source', 'channel', 'mode', 'textSha256', 'recordedAt'],
    'portable_truth_v2_s6_voice_binding_invalid',
  );
  if (voiceUser.recordId !== voiceRequest.userMessageId
    || voiceUser.source !== 'voice'
    || voiceUser.channel !== 'voice'
    || voiceUser.mode !== 'voice') {
    fail('portable_truth_v2_s6_voice_binding_invalid');
  }
  exactSha256(voiceUser.textSha256, 'portable_truth_v2_s6_voice_binding_invalid');
  canonicalInstant(voiceUser.recordedAt, 'portable_truth_v2_s6_voice_binding_invalid');
  const capture = exactKeys(
    voiceStart.capture,
    [
      'captureMode', 'audioInputKind', 'syntheticAudio', 'captureSessionId',
      'sttReceiptId', 'contextChainId', 'previousRequestId', 'nativeDeviceId',
      'executionSessionId', 'nativeClientIdentitySha256',
    ],
    [
      'captureMode', 'audioInputKind', 'syntheticAudio', 'captureSessionId',
      'sttReceiptId', 'contextChainId', 'previousRequestId', 'nativeDeviceId',
      'executionSessionId', 'nativeClientIdentitySha256',
    ],
    'portable_truth_v2_s6_voice_provenance_invalid',
  );
  if (capture.captureMode !== 'synthetic_accepted_transcript'
    || capture.audioInputKind !== 'synthetic_accepted_transcript'
    || capture.syntheticAudio !== true
    || [
      capture.captureSessionId, capture.sttReceiptId, capture.contextChainId,
      capture.previousRequestId, capture.nativeDeviceId, capture.executionSessionId,
      capture.nativeClientIdentitySha256,
    ].some(item => item !== null)) {
    fail('portable_truth_v2_s6_voice_provenance_invalid');
  }

  const textUser = exactKeys(
    textContinue.userMessage,
    ['recordId', 'source', 'channel', 'cognitiveIntent', 'textSha256', 'recordedAt'],
    ['recordId', 'source', 'channel', 'cognitiveIntent', 'textSha256', 'recordedAt'],
    'portable_truth_v2_s6_text_binding_invalid',
  );
  if (textUser.recordId !== textRequest.userMessageId
    || textUser.channel !== 'text'
    || textUser.cognitiveIntent !== 'task_correction') {
    fail('portable_truth_v2_s6_text_binding_invalid');
  }
  exactText(textUser.source, 'portable_truth_v2_s6_text_binding_invalid', 120);
  exactSha256(textUser.textSha256, 'portable_truth_v2_s6_text_binding_invalid');
  canonicalInstant(textUser.recordedAt, 'portable_truth_v2_s6_text_binding_invalid');

  const voiceReceipt = normalizeS6ReadReceipt(voiceStart.receipt, {
    requestId: voicePhase.requestId,
    outcome: 'failed',
  }, 'portable_truth_v2_s6_voice_receipt_binding_invalid');
  const textReceipt = normalizeS6ReadReceipt(textContinue.receipt, {
    requestId: textPhase.requestId,
    outcome: 'verified_success',
  }, 'portable_truth_v2_s6_text_receipt_binding_invalid');
  if (voiceReceipt.taskId !== taskId || textReceipt.taskId !== taskId
    || voiceReceipt.canonicalTarget.identity === textReceipt.canonicalTarget.identity) {
    fail('portable_truth_v2_s6_target_binding_invalid');
  }
  if (signed.binding.conversationId !== conversationId
    || signed.binding.voiceRequestId !== voiceRequest.requestId
    || signed.binding.textRequestId !== textRequest.requestId
    || signed.binding.taskId !== taskId
    || signed.binding.capturedAt !== capturedAt
    || signed.binding.evidenceDigestSha256 !== evidenceDigestSha256) {
    fail('portable_truth_v2_s6_inner_truth_binding_invalid');
  }

  const handoff = exactKeys(
    truth.channelHandoff,
    [
      'sourceRequestId', 'targetRequestId', 'sourceTaskId', 'targetTaskId',
      'sourceChannel', 'targetChannel', 'sourceMessageIds', 'targetMessageId', 'recordedAt',
    ],
    [
      'sourceRequestId', 'targetRequestId', 'sourceTaskId', 'targetTaskId',
      'sourceChannel', 'targetChannel', 'sourceMessageIds', 'targetMessageId', 'recordedAt',
    ],
    'portable_truth_v2_s6_handoff_binding_invalid',
  );
  if (handoff.sourceRequestId !== voicePhase.requestId
    || handoff.targetRequestId !== textPhase.requestId
    || handoff.sourceTaskId !== taskId
    || handoff.targetTaskId !== taskId
    || handoff.sourceChannel !== 'voice'
    || handoff.targetChannel !== 'text'
    || !exactJson(handoff.sourceMessageIds, [
      voiceRequest.userMessageId,
      voiceRequest.assistantMessageId,
    ])
    || handoff.targetMessageId !== textRequest.userMessageId) {
    fail('portable_truth_v2_s6_handoff_binding_invalid');
  }
  canonicalInstant(handoff.recordedAt, 'portable_truth_v2_s6_handoff_binding_invalid');

  const correction = exactKeys(
    truth.targetCorrection,
    [
      'recordId', 'source', 'sourceRequestId', 'targetRequestId', 'taskId',
      'correctionMessageId', 'previousTarget', 'replacementTarget',
      'previousTaskTargetSha256', 'replacementTaskTargetSha256',
      'rejectedTargetSha256', 'recordedAt',
    ],
    [
      'recordId', 'source', 'sourceRequestId', 'targetRequestId', 'taskId',
      'correctionMessageId', 'previousTarget', 'replacementTarget',
      'previousTaskTargetSha256', 'replacementTaskTargetSha256',
      'rejectedTargetSha256', 'recordedAt',
    ],
    'portable_truth_v2_s6_correction_binding_invalid',
  );
  const previousTarget = canonicalAbsoluteFilesystemPath(
    correction.previousTarget,
    'portable_truth_v2_s6_target_path_invalid',
  );
  const replacementTarget = canonicalAbsoluteFilesystemPath(
    correction.replacementTarget,
    'portable_truth_v2_s6_target_path_invalid',
  );
  if (correction.recordId !== textRequest.userMessageId
    || correction.source !== 'user_correction'
    || correction.sourceRequestId !== voicePhase.requestId
    || correction.targetRequestId !== textPhase.requestId
    || correction.taskId !== taskId
    || correction.correctionMessageId !== textRequest.userMessageId
    || previousTarget.identity !== voiceReceipt.canonicalTarget.identity
    || replacementTarget.identity !== textReceipt.canonicalTarget.identity) {
    fail('portable_truth_v2_s6_correction_binding_invalid');
  }
  const previousTaskTargetSha256 = exactSha256(
    correction.previousTaskTargetSha256,
    'portable_truth_v2_s6_correction_binding_invalid',
  );
  const replacementTaskTargetSha256 = exactSha256(
    correction.replacementTaskTargetSha256,
    'portable_truth_v2_s6_correction_binding_invalid',
  );
  const rejectedTargetSha256 = exactSha256(
    correction.rejectedTargetSha256,
    'portable_truth_v2_s6_correction_binding_invalid',
  );
  if (previousTaskTargetSha256 !== portableEvidenceSha256(previousTarget.normalized)
    || replacementTaskTargetSha256 !== portableEvidenceSha256(replacementTarget.normalized)
    || rejectedTargetSha256 !== previousTaskTargetSha256) {
    fail('portable_truth_v2_s6_correction_binding_invalid');
  }
  canonicalInstant(correction.recordedAt, 'portable_truth_v2_s6_correction_binding_invalid');

  return {
    value: cloneJson(signed.envelope, 'portable_truth_v2_s6_server_truth_invalid'),
    conversationId,
    taskId,
    voicePhase,
    textPhase,
    voiceRequest,
    textRequest,
    voiceReceipt,
    textReceipt,
    handoff,
    correction,
    previousTarget,
    replacementTarget,
    previousPathHmac: portableTaskRegressionCanonicalPathHmac(previousTarget.normalized, key),
    replacementPathHmac: portableTaskRegressionCanonicalPathHmac(replacementTarget.normalized, key),
  };
}

function normalizeChannelRecord(record, key, manifest, contract) {
  // The backend-owned detached signature is the provenance boundary. Verify it
  // before consulting the caller/controller channel HMAC so possession of the
  // outer key can never upgrade caller-authored S6 truth into server truth.
  const serverTruth = record?.serverTruth === undefined
    ? null
    : normalizeS6ServerTruth(record.serverTruth, manifest, contract, key);
  if (!verifyPortableEvidenceRecord(record, key)) {
    fail('portable_truth_v2_channel_attestation_invalid');
  }
  exactKeys(
    record,
    [
      'kind', 'schemaVersion', 'manifestDigest', 'role', 'runId', 'buildIdentityDigest',
      'profileSha256', 'collectorBundleSha256', 'fixturePlanSha256',
      'timeoutPolicySha256', 'coverageSha256', 'paritySha256',
      'controllerArtifactSha256', 'collectorArtifactSha256', 'binding', 'channel',
      'sourceSequence', 'capturedAt', 'proof', 'observations', 'serverTruth', 'attestation',
    ],
    [
      'kind', 'schemaVersion', 'manifestDigest', 'role', 'runId', 'buildIdentityDigest',
      'profileSha256', 'collectorBundleSha256', 'fixturePlanSha256',
      'timeoutPolicySha256', 'coverageSha256', 'paritySha256',
      'controllerArtifactSha256', 'collectorArtifactSha256', 'binding', 'channel',
      'sourceSequence', 'capturedAt', 'proof', 'observations', 'attestation',
    ],
    'portable_truth_v2_channel_record_invalid',
  );
  if (record.kind !== PORTABLE_TRUTH_V2_CHANNEL_RECORD_KIND
    || record.schemaVersion !== PORTABLE_TRUTH_V2_ADAPTER_SCHEMA_VERSION) {
    fail('portable_truth_v2_channel_record_invalid');
  }
  const channel = normalizeChannel(record.channel);
  if (record.manifestDigest !== manifest.manifestDigest
    || record.role !== manifest.role
    || record.runId !== manifest.runId
    || record.buildIdentityDigest !== manifest.buildIdentityDigest
    || record.profileSha256 !== contract.profileSha256
    || record.collectorBundleSha256 !== contract.collectorBundleSha256
    || record.fixturePlanSha256 !== contract.fixturePlanSha256
    || record.timeoutPolicySha256 !== contract.timeoutPolicySha256
    || record.coverageSha256 !== contract.coverageSha256
    || record.paritySha256 !== contract.paritySha256
    || record.controllerArtifactSha256 !== contract.controllerArtifactSha256
    || record.collectorArtifactSha256 !== contract.collectorArtifacts[channel]) {
    fail('portable_truth_v2_channel_contract_binding_invalid', { channel });
  }
  const resolved = exactPortableBinding(manifest, record.binding);
  const observations = Array.isArray(record.observations)
    ? cloneJson(record.observations, 'portable_truth_v2_observations_invalid')
    : fail('portable_truth_v2_observations_invalid');
  for (const observation of observations) {
    const kind = String(observation?.observationKind || '');
    if (!CHANNEL_OBSERVATION_KINDS[channel].includes(kind)) {
      fail('portable_truth_v2_observation_channel_mismatch', { channel, observationKind: kind });
    }
  }
  const proof = normalizeChannelProof(
    channel,
    record.proof,
    manifest,
    resolved.phase,
    observations,
  );
  if (proof.kind === 'exact_channel_absence_v1') {
    const absence = observations.filter(item => item?.observationKind === 'absence_window');
    if (absence.some(item => item.matcherSha256 !== proof.matcherSha256
      || item.matchedRecordCount !== 0)) {
      fail('portable_truth_v2_absence_observation_join_invalid');
    }
  }
  if (serverTruth && (
    channel !== 'passive_store_probe'
    || resolved.phase.scenarioId !== 'voice_to_text_continuation'
    || resolved.phase.phaseId !== 'text_continue'
    || observations.filter(item => item?.observationKind === 'target_correction').length !== 1
  )) {
    fail('portable_truth_v2_s6_server_truth_placement_invalid');
  }
  return {
    ...record,
    channel,
    sourceSequence: positiveInteger(
      record.sourceSequence,
      'portable_truth_v2_source_sequence_invalid',
    ),
    capturedAt: canonicalInstant(record.capturedAt, 'portable_truth_v2_capture_time_invalid'),
    observations,
    proof,
    serverTruth,
    phase: resolved.phase,
    sourceRecordSha256: portableEvidenceSha256(unsignedRecord(record)),
  };
}

export function createSignedPortableTruthV2ChannelRecord(input, key) {
  const value = exactKeys(
    input,
    [
      'manifest', 'contract', 'selector', 'channel', 'sourceSequence',
      'capturedAt', 'observations', 'proof', 'serverTruth',
    ],
    [
      'manifest', 'contract', 'selector', 'channel', 'sourceSequence',
      'capturedAt', 'observations',
    ],
    'portable_truth_v2_channel_input_invalid',
  );
  const manifest = normalizePortableEvidenceManifest(value.manifest);
  if (manifest.hmacKeyId && manifest.hmacKeyId !== portableEvidenceHmacKeyId(key)) {
    fail('portable_truth_v2_manifest_hmac_key_mismatch', { role: manifest.role });
  }
  const contract = normalizeContract(value.contract);
  assertContractManifestBinding(contract, manifest, {
    coverageSha256: contract.coverageSha256,
    paritySha256: contract.paritySha256,
  });
  const channel = normalizeChannel(value.channel);
  const resolved = phaseBindingFromManifest(manifest, value.selector);
  const observations = Array.isArray(value.observations)
    ? cloneJson(value.observations, 'portable_truth_v2_observations_invalid')
    : fail('portable_truth_v2_observations_invalid');
  const proof = value.proof || normalProofFor(channel, manifest, resolved.phase, observations);
  const normalizedProof = normalizeChannelProof(
    channel,
    proof,
    manifest,
    resolved.phase,
    observations,
  );
  const serverTruth = value.serverTruth === undefined
    ? null
    : normalizeS6ServerTruth(value.serverTruth, manifest, contract, key);
  if (serverTruth && (
    channel !== 'passive_store_probe'
    || resolved.phase.scenarioId !== 'voice_to_text_continuation'
    || resolved.phase.phaseId !== 'text_continue'
    || observations.filter(item => item?.observationKind === 'target_correction').length !== 1
  )) {
    fail('portable_truth_v2_s6_server_truth_placement_invalid');
  }
  return signPortableEvidenceRecord({
    kind: PORTABLE_TRUTH_V2_CHANNEL_RECORD_KIND,
    schemaVersion: PORTABLE_TRUTH_V2_ADAPTER_SCHEMA_VERSION,
    manifestDigest: manifest.manifestDigest,
    role: manifest.role,
    runId: manifest.runId,
    buildIdentityDigest: manifest.buildIdentityDigest,
    profileSha256: contract.profileSha256,
    collectorBundleSha256: contract.collectorBundleSha256,
    fixturePlanSha256: contract.fixturePlanSha256,
    timeoutPolicySha256: contract.timeoutPolicySha256,
    coverageSha256: contract.coverageSha256,
    paritySha256: contract.paritySha256,
    controllerArtifactSha256: contract.controllerArtifactSha256,
    collectorArtifactSha256: contract.collectorArtifacts[channel],
    binding: resolved.binding,
    channel,
    sourceSequence: positiveInteger(
      value.sourceSequence,
      'portable_truth_v2_source_sequence_invalid',
    ),
    capturedAt: canonicalInstant(value.capturedAt, 'portable_truth_v2_capture_time_invalid'),
    proof: normalizedProof,
    observations,
    ...(serverTruth ? { serverTruth: serverTruth.value } : {}),
  }, key);
}

function truthBindingId(phase) {
  return `binding:${phase.bindingDigest}`;
}

function truthBinding(manifest, phase) {
  const system = systemBindingContract(phase);
  if (system) {
    const source = sourcePhaseForSystemEvent(manifest, phase);
    return {
      bindingKind: 'system_event',
      bindingId: truthBindingId(phase),
      eventKind: system.eventKind,
      eventNonceSha256: portableEvidenceSha256(phase.phaseNonce),
      sourceBindingId: truthBindingId(source),
    };
  }
  return {
    bindingKind: 'request',
    bindingId: truthBindingId(phase),
    requestId: phase.requestId,
    conversationRef: phase.conversationId,
    turnNonceSha256: portableEvidenceSha256(phase.phaseNonce),
    channel: phase.scenarioId === 'voice_to_text_continuation' && phase.phaseId === 'voice_start'
      ? 'voice'
      : 'text',
  };
}

function requiredChannelsForPhase(profile, manifestPhase, observations) {
  const required = new Set();
  for (const kind of profile.required || []) {
    const channel = OBSERVATION_CHANNEL[kind];
    if (channel) required.add(channel);
  }
  for (const alternatives of profile.exactlyOneOf || []) {
    const selected = alternatives.filter(kind => observations.some(item => item.observationKind === kind));
    if (selected.length !== 1) fail('portable_truth_v2_exactly_one_evidence_required');
    required.add(OBSERVATION_CHANNEL[selected[0]]);
  }
  if (manifestPhase.requirements.passiveStore) required.add('passive_store_probe');
  if (manifestPhase.requirements.providerWitness) required.add('provider_witness');
  if ((profile.required || []).includes('absence_window')) {
    ABSENCE_SOURCE_CHANNELS.forEach(channel => required.add(channel));
  }
  return required;
}

function assertPhaseEvidenceContract(profile, records, phase) {
  const observations = records.flatMap(record => record.observations);
  const kinds = observations.map(item => item.observationKind);
  for (const kind of profile.required || []) {
    if (!kinds.includes(kind)) {
      fail('portable_truth_v2_required_observation_missing', {
        phase: phaseKey(phase.scenarioId, phase.phaseId),
        observationKind: kind,
      });
    }
  }
  for (const kind of profile.forbidden || []) {
    if (kinds.includes(kind)) fail('portable_truth_v2_forbidden_observation_present');
  }
  for (const alternatives of profile.exactlyOneOf || []) {
    if (alternatives.filter(kind => kinds.includes(kind)).length !== 1) {
      fail('portable_truth_v2_exactly_one_evidence_required');
    }
  }
  const channels = new Set(records.map(record => record.channel));
  for (const channel of requiredChannelsForPhase(profile, phase, observations)) {
    if (!channels.has(channel)) {
      fail('portable_truth_v2_required_channel_missing', {
        phase: phaseKey(phase.scenarioId, phase.phaseId),
        channel,
      });
    }
  }
  const absence = observations.filter(item => item.observationKind === 'absence_window');
  if (absence.length > 0) {
    if (absence.length !== 1) fail('portable_truth_v2_absence_observation_cardinality_invalid');
    for (const channel of ABSENCE_SOURCE_CHANNELS) {
      const proofs = records.filter(record => (
        record.channel === channel
        && record.proof.kind === 'exact_channel_absence_v1'
        && record.proof.matcherSha256 === absence[0].matcherSha256
        && record.proof.matchedRecordCount === 0
      ));
      if (proofs.length !== 1) {
        fail('portable_truth_v2_absence_channel_proof_missing', { channel });
      }
    }
  }
}

function projectEvidenceRecord(role, manifest, phaseContract, source, observation, index, sequence) {
  const evidenceDigest = portableEvidenceSha256({
    role,
    bindingDigest: source.phase.bindingDigest,
    channel: source.channel,
    sourceSequence: source.sourceSequence,
    observationIndex: index,
    observation,
  });
  return {
    kind: TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND,
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    evidenceId: `evidence:${evidenceDigest.slice(0, 48)}`,
    runId: manifest.runId,
    scenarioId: source.phase.scenarioId,
    phaseId: source.phase.phaseId,
    phaseOrdinal: phaseContract.phaseOrdinal,
    monotonicSequence: sequence,
    capturedAt: source.capturedAt,
    binding: truthBinding(manifest, source.phase),
    provenance: {
      lane: 'portable_external',
      collector: source.channel,
      collectorArtifactSha256: source.collectorArtifactSha256,
      recordSha256: source.sourceRecordSha256,
      attestation: {
        kind: 'installation_hmac_sha256_v1',
        keyId: source.attestation.keyId,
        mac: source.attestation.digest,
      },
    },
    observation,
  };
}

function exactS6Observation(records, phaseId, observationKind, code) {
  const matches = records.flatMap(record => (
    record.phase.scenarioId === 'voice_to_text_continuation'
      && record.phase.phaseId === phaseId
      ? record.observations.filter(item => item?.observationKind === observationKind)
      : []
  ));
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function assertS6FormalTarget(target, expected, code) {
  if (!isPlainObject(target)
    || target.targetKind !== 'filesystem'
    || target.canonicalPathHmac !== expected.pathHmac
    || target.displayName !== expected.displayName) {
    fail(code);
  }
}

function assertS6ServerTruthContract(records) {
  const s6Records = records.filter(record => (
    record.phase.scenarioId === 'voice_to_text_continuation'
  ));
  const truthRecords = s6Records.filter(record => record.serverTruth);
  if (truthRecords.length !== 1) {
    fail(truthRecords.length
      ? 'portable_truth_v2_s6_server_truth_cardinality_invalid'
      : 'portable_truth_v2_s6_server_truth_missing');
  }
  const truth = truthRecords[0].serverTruth;
  const voiceTurn = exactS6Observation(
    s6Records,
    'voice_start',
    'turn',
    'portable_truth_v2_s6_voice_turn_binding_invalid',
  );
  const textTurn = exactS6Observation(
    s6Records,
    'text_continue',
    'turn',
    'portable_truth_v2_s6_text_turn_binding_invalid',
  );
  if (voiceTurn.requestRef !== truth.voiceRequest.requestId
    || voiceTurn.targetTaskRef !== truth.taskId
    || voiceTurn.userMessageRef !== truth.voiceRequest.userMessageId
    || voiceTurn.assistantMessageRef !== truth.voiceRequest.assistantMessageId
    || textTurn.requestRef !== truth.textRequest.requestId
    || textTurn.targetTaskRef !== truth.taskId
    || textTurn.userMessageRef !== truth.textRequest.userMessageId
    || textTurn.assistantMessageRef !== truth.textRequest.assistantMessageId) {
    fail('portable_truth_v2_s6_turn_server_truth_join_invalid');
  }

  const correction = exactS6Observation(
    s6Records,
    'text_continue',
    'target_correction',
    'portable_truth_v2_s6_correction_binding_invalid',
  );
  if (correction.sourceRequestRef !== truth.correction.sourceRequestId
    || correction.targetRequestRef !== truth.correction.targetRequestId
    || correction.taskRef !== truth.taskId
    || correction.correctionMessageRef !== truth.correction.correctionMessageId
    || correction.source !== 'user_correction'
    || correction.previousTaskTargetSha256 !== truth.correction.previousTaskTargetSha256
    || correction.replacementTaskTargetSha256 !== truth.correction.replacementTaskTargetSha256
    || correction.rejectedTargetSha256 !== truth.correction.rejectedTargetSha256) {
    fail('portable_truth_v2_s6_correction_binding_invalid');
  }
  assertS6FormalTarget(correction.previousTarget, {
    pathHmac: truth.previousPathHmac,
    displayName: truth.previousTarget.displayName,
  }, 'portable_truth_v2_s6_correction_previous_target_invalid');
  assertS6FormalTarget(correction.replacementTarget, {
    pathHmac: truth.replacementPathHmac,
    displayName: truth.replacementTarget.displayName,
  }, 'portable_truth_v2_s6_correction_replacement_target_invalid');

  const handoff = exactS6Observation(
    s6Records,
    'text_continue',
    'channel_handoff',
    'portable_truth_v2_s6_handoff_binding_invalid',
  );
  if (handoff.sourceRequestRef !== truth.handoff.sourceRequestId
    || handoff.targetRequestRef !== truth.handoff.targetRequestId
    || handoff.sourceTaskRef !== truth.taskId
    || handoff.targetTaskRef !== truth.taskId
    || handoff.sourceChannel !== 'voice'
    || handoff.targetChannel !== 'text'
    || handoff.captureMode !== 'synthetic_accepted_transcript'
    || !exactJson(handoff.sourceMessageRefs, truth.handoff.sourceMessageIds)
    || handoff.targetMessageRef !== truth.handoff.targetMessageId
    || handoff.targetMessageRef !== textTurn.userMessageRef) {
    fail('portable_truth_v2_s6_handoff_binding_invalid');
  }

  const voiceAction = exactS6Observation(
    s6Records,
    'voice_start',
    'action_set',
    'portable_truth_v2_s6_voice_receipt_binding_invalid',
  );
  const textAction = exactS6Observation(
    s6Records,
    'text_continue',
    'action_set',
    'portable_truth_v2_s6_text_receipt_binding_invalid',
  );
  const voiceReceipts = Array.isArray(voiceAction.receipts)
    ? voiceAction.receipts.filter(item => item?.toolName === 'read_file')
    : [];
  const textReceipts = Array.isArray(textAction.receipts)
    ? textAction.receipts.filter(item => item?.toolName === 'read_file')
    : [];
  if (voiceReceipts.length !== 1 || textReceipts.length !== 1) {
    fail('portable_truth_v2_s6_receipt_cardinality_invalid');
  }
  const voiceReceipt = voiceReceipts[0];
  const textReceipt = textReceipts[0];
  if (voiceReceipt.receiptRef !== truth.voiceReceipt.receiptId
    || voiceReceipt.requestRef !== truth.voiceRequest.requestId
    || voiceReceipt.taskRef !== truth.taskId
    || voiceReceipt.outcome !== 'failed'
    || voiceReceipt.inputSha256 !== truth.voiceReceipt.inputSha256
    || textReceipt.receiptRef !== truth.textReceipt.receiptId
    || textReceipt.requestRef !== truth.textRequest.requestId
    || textReceipt.taskRef !== truth.taskId
    || textReceipt.outcome !== 'verified_success'
    || textReceipt.inputSha256 !== truth.textReceipt.inputSha256) {
    fail('portable_truth_v2_s6_receipt_server_truth_join_invalid');
  }
  assertS6FormalTarget(voiceReceipt.target, {
    pathHmac: truth.previousPathHmac,
    displayName: truth.previousTarget.displayName,
  }, 'portable_truth_v2_s6_voice_receipt_target_invalid');
  assertS6FormalTarget(textReceipt.target, {
    pathHmac: truth.replacementPathHmac,
    displayName: truth.replacementTarget.displayName,
  }, 'portable_truth_v2_s6_text_receipt_target_invalid');
}

function projectRoleRun(role, side, manifest, contract) {
  if (!Array.isArray(side.channels) || side.channels.length === 0) {
    fail('portable_truth_v2_channels_required', { role });
  }
  const normalized = side.channels.map(record => normalizeChannelRecord(
    record,
    side.hmacKey,
    manifest,
    contract,
  ));
  assertS6ServerTruthContract(normalized);
  const sourceSequences = normalized.map(record => record.sourceSequence);
  if (new Set(sourceSequences).size !== sourceSequences.length) {
    fail('portable_truth_v2_duplicate_source_sequence', { role });
  }
  const byBinding = new Map();
  for (const record of normalized) {
    const list = byBinding.get(record.phase.bindingDigest) || [];
    list.push(record);
    byBinding.set(record.phase.bindingDigest, list);
  }
  const phaseContracts = expectedPhaseContracts();
  const scenarioBundles = TASK_REGRESSION_V2_SCENARIO_IDS.map(scenarioId => {
    const evidence = [];
    let sequence = 0;
    const contracts = phaseContracts.filter(item => item.scenarioId === scenarioId);
    for (const phaseContract of contracts) {
      const phase = manifest.phases.find(item => (
        item.scenarioId === scenarioId && item.phaseId === phaseContract.phaseId
      ));
      const records = (byBinding.get(phase.bindingDigest) || [])
        .sort((left, right) => left.sourceSequence - right.sourceSequence);
      if (records.length === 0) fail('portable_truth_v2_phase_evidence_missing');
      assertPhaseEvidenceContract(phaseContract.profile, records, phase);
      for (const source of records) {
        source.observations.forEach((observation, index) => {
          sequence += 1;
          evidence.push(projectEvidenceRecord(
            role,
            manifest,
            phaseContract,
            source,
            observation,
            index,
            sequence,
          ));
        });
      }
    }
    const bundle = {
      kind: TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND,
      schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
      bundleId: `bundle:${role}:${portableEvidenceSha256(`${manifest.runId}:${scenarioId}`).slice(0, 40)}`,
      runId: manifest.runId,
      scenarioId,
      coverageMode: 'portable_external',
      evidence,
    };
    const adjudication = validateTaskRegressionScenarioBundleV2(bundle);
    if (!adjudication.valid) {
      fail('portable_truth_v2_projected_bundle_schema_invalid', {
        role,
        scenarioId,
        issueCodes: adjudication.issues.map(issue => issue.code),
      });
    }
    return { bundle, adjudication };
  });
  const unconsumed = normalized.filter(record => !manifest.phases.some(
    phase => phase.bindingDigest === record.phase.bindingDigest,
  ));
  if (unconsumed.length > 0) fail('portable_truth_v2_unconsumed_channel_record');
  return {
    role,
    runId: manifest.runId,
    manifestDigest: manifest.manifestDigest,
    buildIdentityDigest: manifest.buildIdentityDigest,
    scenarioBundles,
    evidenceValid: scenarioBundles.every(item => item.adjudication.valid),
    behaviorPassed: scenarioBundles.every(item => item.adjudication.passed),
  };
}

export function adaptPortablePairedEvidenceToTruthV2(input) {
  const value = exactKeys(
    input,
    ['pairedPlan', 'contract', 'baseline', 'candidate'],
    ['pairedPlan', 'contract', 'baseline', 'candidate'],
    'portable_truth_v2_adapter_input_invalid',
  );
  const contract = normalizeContract(value.contract);
  let hooks;
  try {
    hooks = createPortablePairedRunnerHooks(value.pairedPlan);
  } catch (error) {
    fail('portable_truth_v2_paired_plan_invalid', {
      stageCode: typeof error?.code === 'string' ? error.code : 'unknown',
    });
  }
  const sides = {};
  const manifests = {};
  const builds = {};
  for (const role of ROLES) {
    const side = exactKeys(
      value[role],
      ['hmacKey', 'signedManifest', 'buildIdentity', 'channels'],
      ['hmacKey', 'signedManifest', 'buildIdentity', 'channels'],
      'portable_truth_v2_side_input_invalid',
    );
    const manifest = normalizeSignedManifest(side.signedManifest, side.hmacKey, role);
    const planManifest = hooks.manifestFor(role);
    if (!exactJson(manifest, planManifest)) {
      fail('portable_truth_v2_signed_manifest_plan_binding_invalid', { role });
    }
    assertContractManifestBinding(contract, manifest, value.pairedPlan);
    manifests[role] = manifest;
    builds[role] = normalizeSignedBuildIdentity(
      side.buildIdentity,
      side.hmacKey,
      role,
      manifest,
    );
    sides[role] = side;
  }
  if (manifests.baseline.profileSha256 !== manifests.candidate.profileSha256
    || manifests.baseline.collectorBundleSha256 !== manifests.candidate.collectorBundleSha256
    || manifests.baseline.fixturePlanSha256 !== manifests.candidate.fixturePlanSha256
    || !exactJson(manifests.baseline.timeoutPolicy, manifests.candidate.timeoutPolicy)
    || builds.baseline.buildIdentityDigest === builds.candidate.buildIdentityDigest
    || (builds.baseline.sourceFingerprintSha256 === builds.candidate.sourceFingerprintSha256
      && builds.baseline.runtimeFingerprintSha256 === builds.candidate.runtimeFingerprintSha256)
    || manifests.baseline.runId === manifests.candidate.runId) {
    fail('portable_truth_v2_baseline_candidate_parity_invalid');
  }
  const runs = {
    baseline: projectRoleRun('baseline', sides.baseline, manifests.baseline, contract),
    candidate: projectRoleRun('candidate', sides.candidate, manifests.candidate, contract),
  };
  const resultCore = {
    kind: PORTABLE_TRUTH_V2_PAIRED_RUN_KIND,
    schemaVersion: PORTABLE_TRUTH_V2_ADAPTER_SCHEMA_VERSION,
    decisionSource: 'portable_signed_channels_projected_into_task_regression_truth_v2',
    controllerArtifactSha256: contract.controllerArtifactSha256,
    profileSha256: contract.profileSha256,
    collectorBundleSha256: contract.collectorBundleSha256,
    fixturePlanSha256: contract.fixturePlanSha256,
    timeoutPolicySha256: contract.timeoutPolicySha256,
    coverageSha256: contract.coverageSha256,
    paritySha256: contract.paritySha256,
    serverTruthSignerKeyIds: Object.fromEntries(ROLES.map(role => [
      role,
      contract.serverTruthSigners[role].keyId,
    ])),
    runs,
    evidenceValid: runs.baseline.evidenceValid && runs.candidate.evidenceValid,
    baselineBehaviorPassed: runs.baseline.behaviorPassed,
    candidateBehaviorPassed: runs.candidate.behaviorPassed,
  };
  return {
    ...resultCore,
    adapterDigest: portableEvidenceSha256(resultCore),
  };
}

export function validatePortablePairedEvidenceForTruthV2(input) {
  try {
    return { ok: true, value: adaptPortablePairedEvidenceToTruthV2(input), issues: [] };
  } catch (error) {
    if (error instanceof PortableTruthV2AdapterError) {
      return {
        ok: false,
        issues: [{ code: error.code, details: error.details }],
      };
    }
    return {
      ok: false,
      issues: [{ code: 'portable_truth_v2_adapter_unexpected_failure', details: {} }],
    };
  }
}
