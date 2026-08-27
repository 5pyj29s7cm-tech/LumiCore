import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION = 2;
export const FORMAL_STAGE9_BUNDLE_KIND = 'lumi.formal-stage9-evidence-bundle';
export const FORMAL_STAGE9_PRODUCER_KIND = 'lumi.formal-stage9-producer-evidence';
export const FORMAL_STAGE9_DECISION_KIND = 'lumi.formal-stage9-decision';
export const FORMAL_STAGE9_EVIDENCE_MANIFEST_KIND = 'lumi.formal-stage9-evidence-manifest';
export const FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND =
  'lumi.formal-stage9-producer-file-manifest';
export const FORMAL_STAGE9_TRUST_POLICY_KIND = 'lumi.formal-stage9-trust-policy';

export const FORMAL_STAGE9_PRODUCERS = Object.freeze([
  'main',
  'restart',
  'failover',
  'wps',
  'variants',
]);

export const FORMAL_STAGE9_EVIDENCE_CATEGORIES = Object.freeze([
  'screenshots',
  'taskReceipts',
  'taskTimeline',
  'modelRouting',
  'artifacts',
  'userFeedback',
]);

export const FORMAL_STAGE9_SCENARIO_OWNERS = Object.freeze({
  task_correction_three_times: 'main',
  physical_microphone_20_turns: 'main',
  voice_to_text_same_task_continuation: 'main',
  confirmation_waiting: 'main',
  confirmation_rejection: 'main',
  repeated_confirmation_idempotency: 'main',
  production_primary_failure_lmstudio_same_task_continuation: 'failover',
  native_client_restart_formal_profile: 'restart',
  backend_restart_task_recovery: 'restart',
  active_wps_document_workflow: 'wps',
  task_status_query: 'main',
  batch_cleanup: 'wps',
  multi_agent_durable_completion: 'main',
  four_variant_business_loops: 'variants',
  client_window_chat_voice_settings: 'main',
});

export const FORMAL_STAGE9_SCENARIOS = Object.freeze(
  Object.keys(FORMAL_STAGE9_SCENARIO_OWNERS),
);

const BUILD_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/iu;
const BASE64_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/u;
const ACCEPTANCE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const ALLOWED_PRODUCER_STATUS = 'evidence_package_complete';
const MAX_EVIDENCE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const BUNDLE_SIGNATURE_DOMAIN = 'LUMI-FORMAL-STAGE9-BUNDLE-V2\n';
const REFERENCE_SIGNATURE_DOMAIN = 'LUMI-FORMAL-STAGE9-REFERENCE-V2';
// Exit zero is a process-level capability, not a property callers may mint by
// assembling a look-alike JSON object. Only an object returned by the accepted
// branch of this module is registered here.
const FORMALLY_ACCEPTED_DECISIONS = new WeakSet();

export class FormalStage9AdjudicatorError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'FormalStage9AdjudicatorError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new FormalStage9AdjudicatorError(code, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value) {
  return String(value ?? '').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function stableFormalStage9Json(value) {
  return JSON.stringify(stableValue(value));
}

export function formalStage9Digest(value) {
  return crypto.createHash('sha256').update(stableFormalStage9Json(value), 'utf8').digest('hex');
}

function publicKeyObject(value, code) {
  try {
    const key = value?.type === 'public' ? value : crypto.createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') fail(code);
    return key;
  } catch (error) {
    if (error instanceof FormalStage9AdjudicatorError) throw error;
    fail(code, { cause: error?.message });
  }
}

function privateKeyObject(value, code) {
  try {
    const key = value?.type === 'private' ? value : crypto.createPrivateKey(value);
    if (key.asymmetricKeyType !== 'ed25519') fail(code);
    return key;
  } catch (error) {
    if (error instanceof FormalStage9AdjudicatorError) throw error;
    fail(code, { cause: error?.message });
  }
}

function publicKeyFingerprint(key) {
  return crypto.createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function normalizeTrustSigner(raw, codePrefix) {
  if (!isPlainObject(raw)) fail(`${codePrefix}_required`);
  const keyId = requiredText(raw.keyId, `${codePrefix}_key_id_required`);
  const algorithm = requiredText(raw.algorithm, `${codePrefix}_algorithm_required`).toLowerCase();
  if (algorithm !== 'ed25519') fail(`${codePrefix}_algorithm_invalid`);
  const publicKey = publicKeyObject(raw.publicKeyPem, `${codePrefix}_public_key_invalid`);
  return {
    keyId,
    algorithm,
    publicKey,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
  };
}

/**
 * Normalize an operator-provided policy. The policy is never read from the
 * evidence bundle and public keys are omitted from returned decision data.
 */
export function normalizeFormalStage9TrustPolicy(raw) {
  if (!isPlainObject(raw)) fail('formal_trust_policy_required');
  if (raw.schemaVersion !== 1 || raw.kind !== FORMAL_STAGE9_TRUST_POLICY_KIND) {
    fail('formal_trust_policy_invalid');
  }
  const policyId = requiredText(raw.policyId, 'formal_trust_policy_id_required');
  const acceptanceMode = requiredText(
    raw.acceptanceMode || 'integrity_only',
    'formal_trust_acceptance_mode_required',
  );
  if (!['integrity_only', 'dual_attestation'].includes(acceptanceMode)) {
    fail('formal_trust_acceptance_mode_invalid');
  }
  const bundleSigner = normalizeTrustSigner(raw.bundleSigner, 'formal_bundle_signer');
  const serverReceiptSigner = acceptanceMode === 'dual_attestation'
    ? normalizeTrustSigner(raw.serverReceiptSigner, 'formal_server_receipt_signer')
    : null;
  const nativeCaptureSigner = acceptanceMode === 'dual_attestation'
    ? normalizeTrustSigner(raw.nativeCaptureSigner, 'formal_native_capture_signer')
    : null;
  if (serverReceiptSigner && nativeCaptureSigner) {
    const fingerprints = [
      bundleSigner.publicKeyFingerprint,
      serverReceiptSigner.publicKeyFingerprint,
      nativeCaptureSigner.publicKeyFingerprint,
    ];
    if (new Set(fingerprints).size !== fingerprints.length) {
      fail('formal_trust_signers_not_independent');
    }
  }
  return {
    schemaVersion: 1,
    kind: FORMAL_STAGE9_TRUST_POLICY_KIND,
    policyId,
    acceptanceMode,
    bundleSigner,
    serverReceiptSigner,
    nativeCaptureSigner,
  };
}

function signatureObject(keyId, signature) {
  return {
    algorithm: 'ed25519',
    keyId: requiredText(keyId, 'formal_signature_key_id_required'),
    signature: signature.toString('base64'),
  };
}

function referenceSigningBytes(reference, signerRole) {
  const copy = structuredClone(reference);
  delete copy.serverAttestation;
  delete copy.nativeAttestation;
  return Buffer.from(
    `${REFERENCE_SIGNATURE_DOMAIN}:${signerRole}\n${stableFormalStage9Json(copy)}`,
    'utf8',
  );
}

export function signFormalStage9EvidenceReference(reference, {
  signerRole,
  keyId,
  privateKey,
}) {
  if (!isPlainObject(reference)) fail('formal_evidence_reference_required');
  if (!['server', 'native'].includes(signerRole)) fail('formal_reference_signer_role_invalid');
  const key = privateKeyObject(privateKey, 'formal_reference_private_key_invalid');
  const result = structuredClone(reference);
  const attestation = signatureObject(
    keyId,
    crypto.sign(null, referenceSigningBytes(result, signerRole), key),
  );
  if (signerRole === 'server') result.serverAttestation = attestation;
  else result.nativeAttestation = attestation;
  return result;
}

function validIso(value) {
  return text(value) !== '' && Number.isFinite(Date.parse(text(value)));
}

function normalizedIso(value, code) {
  if (!validIso(value)) fail(code);
  return new Date(text(value)).toISOString();
}

function requiredText(value, code) {
  const result = text(value);
  if (!result) fail(code);
  return result;
}

function requiredSha256(value, code) {
  const result = text(value).toLowerCase();
  if (!SHA256_RE.test(result)) fail(code);
  return result;
}

function requiredBuildId(value, code) {
  const result = text(value).toLowerCase();
  if (!BUILD_ID_RE.test(result)) fail(code);
  return result;
}

function normalizeNativeClient(raw, buildId, sourceFingerprint, locations) {
  if (!isPlainObject(raw)) fail('native_client_identity_required');
  const pid = Math.trunc(Number(raw.pid));
  const startedAt = normalizedIso(raw.startedAt || raw.startAt, 'native_client_started_at_invalid');
  const webviewProfileBound = raw.webviewProfileBound === true;
  const identity = {
    clientKind: requiredText(raw.clientKind, 'native_client_kind_required'),
    deviceId: requiredText(raw.deviceId || raw.nativeDeviceId, 'native_client_device_id_required'),
    executionSessionId: requiredText(raw.executionSessionId, 'native_client_execution_session_required'),
    identityFingerprint: requiredSha256(
      raw.identityFingerprint || raw.identitySha256,
      'native_client_identity_fingerprint_invalid',
    ),
    executableSha256: requiredSha256(raw.executableSha256, 'native_client_executable_sha256_invalid'),
    pid,
    startedAt,
    buildId: requiredBuildId(raw.buildId, 'native_client_build_id_invalid'),
    sourceFingerprint: requiredSha256(raw.sourceFingerprint, 'native_client_source_fingerprint_invalid'),
    sourceDirty: raw.sourceDirty === true,
    trustLevel: requiredText(raw.trustLevel, 'native_client_trust_level_required'),
    osAttested: raw.osAttested === true,
    webviewProfileTrustLevel: requiredText(
      raw.webviewProfileTrustLevel,
      'native_client_webview_profile_trust_required',
    ),
    webviewProfileBound,
    webview2ProfileDirSha256: webviewProfileBound
      ? requiredSha256(
        raw.webview2ProfileDirSha256,
        'native_client_webview_profile_binding_invalid',
      )
      : '',
    formalAcceptanceEligible: raw.formalAcceptanceEligible === true,
  };
  if (identity.clientKind !== 'tauri') fail('native_client_must_be_tauri');
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) fail('native_client_pid_invalid');
  if (identity.buildId !== buildId) fail('native_client_build_mismatch');
  if (identity.sourceFingerprint !== sourceFingerprint) fail('native_client_source_mismatch');
  if (identity.sourceDirty) fail('native_client_source_dirty');
  if (!['proof_bound_local_claim', 'os_attested_native_claim'].includes(identity.trustLevel)) {
    fail('native_client_trust_invalid');
  }
  if (!['unbound', 'native_attested'].includes(identity.webviewProfileTrustLevel)) {
    fail('native_client_webview_profile_trust_invalid');
  }
  if (identity.webviewProfileBound
    && identity.webview2ProfileDirSha256 !== locations.webview2ProfileDirSha256) {
    fail('native_client_webview_profile_mismatch');
  }
  return identity;
}

function nativeClientEligibleForFormalAcceptance(identity, locations) {
  return Boolean(
    identity
    && identity.clientKind === 'tauri'
    && identity.trustLevel === 'os_attested_native_claim'
    && identity.osAttested === true
    && identity.webviewProfileTrustLevel === 'native_attested'
    && identity.webviewProfileBound === true
    && identity.webview2ProfileDirSha256 === locations.webview2ProfileDirSha256
    && identity.formalAcceptanceEligible === true
  );
}

/**
 * Canonical identity shared by every Stage 9 producer. Paths are represented
 * only by hashes so the decision file remains private-data safe.
 */
export function normalizeFormalStage9Binding(raw) {
  if (!isPlainObject(raw)) fail('acceptance_binding_required');
  const acceptanceRunId = requiredText(raw.acceptanceRunId, 'acceptance_run_id_required');
  if (!ACCEPTANCE_RUN_ID_RE.test(acceptanceRunId)) fail('acceptance_run_id_invalid');
  const buildId = requiredBuildId(raw.buildId, 'acceptance_build_id_invalid');
  const sourceFingerprint = requiredSha256(raw.sourceFingerprint, 'acceptance_source_fingerprint_invalid');
  if (raw.sourceDirty !== false) fail('acceptance_source_must_be_clean');
  const locations = raw.locations;
  if (!isPlainObject(locations)) fail('acceptance_locations_required');
  const normalizedLocations = {
    dataRootSha256: requiredSha256(locations.dataRootSha256, 'acceptance_data_root_invalid'),
    webview2UserDataDirSha256: requiredSha256(
      locations.webview2UserDataDirSha256,
      'acceptance_webview_user_data_invalid',
    ),
    webview2ProfileDirSha256: requiredSha256(
      locations.webview2ProfileDirSha256,
      'acceptance_webview_profile_invalid',
    ),
  };
  if (normalizedLocations.dataRootSha256 === normalizedLocations.webview2UserDataDirSha256
    || normalizedLocations.dataRootSha256 === normalizedLocations.webview2ProfileDirSha256
    || normalizedLocations.webview2UserDataDirSha256 === normalizedLocations.webview2ProfileDirSha256) {
    fail('acceptance_location_bindings_not_distinct');
  }
  return {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    acceptanceRunId,
    buildId,
    sourceFingerprint,
    sourceDirty: false,
    locations: normalizedLocations,
    nativeClient: normalizeNativeClient(
      raw.nativeClient,
      buildId,
      sourceFingerprint,
      normalizedLocations,
    ),
  };
}

export function formalStage9BindingDigest(binding) {
  return formalStage9Digest(normalizeFormalStage9Binding(binding));
}

function producerEnvelopeDigest(value) {
  const copy = structuredClone(value);
  delete copy.envelopeDigest;
  return formalStage9Digest(copy);
}

function unsignedBundleValue(value) {
  const copy = structuredClone(value);
  delete copy.bundleDigest;
  delete copy.bundleSignature;
  return copy;
}

function bundleDigest(value) {
  const copy = unsignedBundleValue(value);
  return formalStage9Digest(copy);
}

function bundleSigningBytes(value) {
  return Buffer.from(
    `${BUNDLE_SIGNATURE_DOMAIN}${stableFormalStage9Json(unsignedBundleValue(value))}`,
    'utf8',
  );
}

function evidenceManifestEntries(producers) {
  const entries = [];
  if (!isPlainObject(producers)) return entries;
  for (const producer of Object.keys(producers).sort()) {
    const scenarioEvidence = producers[producer]?.scenarioEvidence;
    if (!isPlainObject(scenarioEvidence)) continue;
    for (const scenarioId of Object.keys(scenarioEvidence).sort()) {
      const categories = scenarioEvidence[scenarioId];
      if (!isPlainObject(categories)) continue;
      for (const category of Object.keys(categories).sort()) {
        const references = Array.isArray(categories[category]) ? categories[category] : [];
        for (const reference of references) {
          entries.push({
            producer,
            scenarioId,
            category,
            recordId: text(reference?.recordId),
            relativePath: text(reference?.relativePath),
            size: Number(reference?.size),
            sha256: text(reference?.sha256).toLowerCase(),
            requestId: text(reference?.requestId),
            taskId: text(reference?.taskId),
            recordedAt: text(reference?.recordedAt),
          });
        }
      }
    }
  }
  return entries.sort((left, right) => stableFormalStage9Json(left).localeCompare(stableFormalStage9Json(right)));
}

function producerFileManifestEntries(scenarioEvidence) {
  const entries = [];
  if (!isPlainObject(scenarioEvidence)) return entries;
  for (const scenarioId of Object.keys(scenarioEvidence).sort()) {
    const categories = scenarioEvidence[scenarioId];
    if (!isPlainObject(categories)) continue;
    for (const category of FORMAL_STAGE9_EVIDENCE_CATEGORIES) {
      const references = Array.isArray(categories[category]) ? categories[category] : [];
      for (const reference of references) {
        entries.push({
          scenarioId,
          category,
          recordId: text(reference?.recordId),
          relativePath: text(reference?.relativePath),
          size: Number(reference?.size),
          sha256: text(reference?.sha256).toLowerCase(),
          requestId: text(reference?.requestId),
          taskId: text(reference?.taskId),
          recordedAt: text(reference?.recordedAt),
        });
      }
    }
  }
  return entries;
}

export function buildFormalStage9EvidenceManifest(producers) {
  const entries = evidenceManifestEntries(producers);
  return {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_EVIDENCE_MANIFEST_KIND,
    entryCount: entries.length,
    entries,
  };
}

export function sealFormalStage9ProducerEvidence({
  producer,
  binding,
  payload,
  scenarioEvidence,
  recordedAt = new Date().toISOString(),
}) {
  if (!FORMAL_STAGE9_PRODUCERS.includes(producer)) fail('formal_producer_invalid');
  if (!isPlainObject(payload)) fail('formal_producer_payload_required');
  if (!isPlainObject(scenarioEvidence)) fail('formal_producer_scenario_evidence_required');
  const normalizedBinding = normalizeFormalStage9Binding(binding);
  const result = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_PRODUCER_KIND,
    producer,
    acceptanceRunId: normalizedBinding.acceptanceRunId,
    binding: normalizedBinding,
    bindingDigest: formalStage9Digest(normalizedBinding),
    recordedAt: normalizedIso(recordedAt, 'formal_producer_recorded_at_invalid'),
    status: ALLOWED_PRODUCER_STATUS,
    packageComplete: true,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    payload,
    payloadDigest: formalStage9Digest(payload),
    scenarioEvidence,
  };
  return { ...result, envelopeDigest: producerEnvelopeDigest(result) };
}

export function sealFormalStage9EvidenceBundle({
  binding,
  producers,
  createdAt = new Date().toISOString(),
  completedAt = new Date().toISOString(),
}) {
  const normalizedBinding = normalizeFormalStage9Binding(binding);
  if (!isPlainObject(producers)) fail('formal_producers_required');
  const evidenceManifest = buildFormalStage9EvidenceManifest(producers);
  const result = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_BUNDLE_KIND,
    acceptanceRunId: normalizedBinding.acceptanceRunId,
    binding: normalizedBinding,
    bindingDigest: formalStage9Digest(normalizedBinding),
    createdAt: normalizedIso(createdAt, 'formal_bundle_created_at_invalid'),
    completedAt: normalizedIso(completedAt, 'formal_bundle_completed_at_invalid'),
    producers,
    evidenceManifest,
    evidenceManifestDigest: formalStage9Digest(evidenceManifest),
  };
  return { ...result, bundleDigest: bundleDigest(result) };
}

export function signFormalStage9EvidenceBundle(bundle, { keyId, privateKey }) {
  if (!isPlainObject(bundle)
    || bundle.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    || bundle.kind !== FORMAL_STAGE9_BUNDLE_KIND
    || bundleDigest(bundle) !== text(bundle.bundleDigest).toLowerCase()) {
    fail('formal_bundle_not_sealed_for_signing');
  }
  const key = privateKeyObject(privateKey, 'formal_bundle_private_key_invalid');
  return {
    ...structuredClone(bundle),
    bundleSignature: signatureObject(keyId, crypto.sign(null, bundleSigningBytes(bundle), key)),
  };
}

function addError(errors, code) {
  if (!errors.includes(code)) errors.push(code);
}

function objectDigestMatches(value, expected) {
  return SHA256_RE.test(text(expected)) && formalStage9Digest(value) === text(expected).toLowerCase();
}

function sameStableValue(left, right) {
  return stableFormalStage9Json(left) === stableFormalStage9Json(right);
}

function readLocationBindings(payload) {
  return payload?.locationBindings
    || payload?.locations
    || payload?.evidence?.locationBindings
    || payload?.evidence?.locations
    || null;
}

function locationBindingsMatch(value, binding) {
  if (!isPlainObject(value)) return false;
  return ['dataRootSha256', 'webview2UserDataDirSha256', 'webview2ProfileDirSha256']
    .every(key => text(value[key]).toLowerCase() === binding.locations[key]);
}

function nativeIdentityMatches(value, binding) {
  if (!isPlainObject(value)) return false;
  const expected = binding.nativeClient;
  const startedAt = validIso(value.startedAt || value.startAt)
    ? new Date(value.startedAt || value.startAt).toISOString()
    : '';
  return text(value.clientKind) === expected.clientKind
    && text(value.deviceId || value.nativeDeviceId) === expected.deviceId
    && text(value.executionSessionId) === expected.executionSessionId
    && text(value.identityFingerprint || value.identitySha256).toLowerCase() === expected.identityFingerprint
    && text(value.executableSha256).toLowerCase() === expected.executableSha256
    && (!value.pid || Number(value.pid) === expected.pid)
    && (!startedAt || startedAt === expected.startedAt)
    && text(value.buildId).toLowerCase() === expected.buildId
    && text(value.sourceFingerprint).toLowerCase() === expected.sourceFingerprint
    && value.sourceDirty === false;
}

function producerPayloadIsUnadjudicated(value) {
  return isPlainObject(value)
    && value.acceptanceDecision === 'not_adjudicated'
    && value.acceptancePassed === false;
}

function validateMainPayload(payload, binding, errors) {
  if (payload?.ok !== true) addError(errors, 'main:producer_failed');
  if (!producerPayloadIsUnadjudicated(payload)) addError(errors, 'main:self_adjudication_forbidden');
  if (payload?.identityVerified !== true) addError(errors, 'main:identity_not_verified');
  if (payload?.runtime?.healthy !== true
    || payload?.runtime?.buildMatches !== true
    || payload?.runtime?.sourceClean !== true) {
    addError(errors, 'main:runtime_identity_invalid');
  }
  const native = payload?.nativeClient;
  if (native?.proofBoundIdentityVerified !== true
    || text(native?.deviceId) !== binding.nativeClient.deviceId
    || text(native?.identityFingerprint).toLowerCase() !== binding.nativeClient.identityFingerprint) {
    addError(errors, 'main:native_identity_mismatch');
  }
  const owned = FORMAL_STAGE9_SCENARIOS.filter(id => FORMAL_STAGE9_SCENARIO_OWNERS[id] === 'main');
  for (const scenarioId of owned) {
    if (payload?.stage9Checks?.[scenarioId] !== true) {
      addError(errors, `main:${scenarioId}:requirement_not_passed`);
    }
  }
}

function phaseRecord(payload, phase) {
  const direct = payload?.[phase];
  if (isPlainObject(direct)) return direct;
  if (payload?.phase === phase) return payload;
  return null;
}

function phaseMarker(value) {
  return text(value?.marker || value?.runMarker || value?.evidence?.marker);
}

function phaseCheckpoint(value) {
  return text(value?.checkpointSha256 || value?.checkpointDigest || value?.evidence?.checkpointSha256).toLowerCase();
}

function requirePhaseUnadjudicated(prefix, value, errors) {
  if (!producerPayloadIsUnadjudicated(value)) addError(errors, `${prefix}:self_adjudication_forbidden`);
}

function validateRestartPayload(payload, binding, errors) {
  const prepare = phaseRecord(payload, 'prepare');
  const verify = phaseRecord(payload, 'verify');
  if (prepare?.ok !== true) addError(errors, 'restart:prepare_missing_or_failed');
  if (verify?.ok !== true) addError(errors, 'restart:verify_missing_or_failed');
  if (!prepare || !verify) return;
  requirePhaseUnadjudicated('restart:prepare', prepare, errors);
  requirePhaseUnadjudicated('restart:verify', verify, errors);
  if (!phaseMarker(prepare) || phaseMarker(prepare) !== phaseMarker(verify)) {
    addError(errors, 'restart:phase_marker_mismatch');
  }
  const expected = text(verify?.expectedRestart || verify?.restart?.expected || prepare?.expectedRestart);
  const observed = text(verify?.restart?.observed || verify?.evidence?.restartScope);
  if (expected !== 'both' || observed !== 'both') addError(errors, 'restart:both_restarts_not_proven');
  if (verify?.restartPerformedByScript !== false) addError(errors, 'restart:script_operation_boundary_invalid');
  const locations = readLocationBindings(verify) || readLocationBindings(prepare);
  if (!locationBindingsMatch(locations, binding)) addError(errors, 'restart:location_binding_mismatch');
  const native = verify?.identities?.recoveredNativeClient
    || verify?.evidence?.recoveredNativeClient
    || verify?.nativeClient;
  if (!nativeIdentityMatches(native, binding)) addError(errors, 'restart:native_identity_mismatch');
  const finalStatus = text(verify?.lifecycle?.finalStatus || verify?.evidence?.finalStatus);
  const activeLease = verify?.lifecycle?.activeLease ?? verify?.evidence?.activeLease;
  if (finalStatus !== 'completed' || activeLease !== false) {
    addError(errors, 'restart:task_not_completed_or_lease_active');
  }
}

function validateFailoverPayload(payload, binding, errors) {
  const prepare = phaseRecord(payload, 'prepare');
  const verify = phaseRecord(payload, 'verify');
  if (prepare?.ok !== true) addError(errors, 'failover:prepare_missing_or_failed');
  if (verify?.ok !== true) addError(errors, 'failover:verify_missing_or_failed');
  if (!prepare || !verify) return;
  requirePhaseUnadjudicated('failover:prepare', prepare, errors);
  requirePhaseUnadjudicated('failover:verify', verify, errors);
  if (!phaseMarker(prepare) || phaseMarker(prepare) !== phaseMarker(verify)) {
    addError(errors, 'failover:phase_marker_mismatch');
  }
  if (!SHA256_RE.test(phaseCheckpoint(prepare))
    || phaseCheckpoint(prepare) !== phaseCheckpoint(verify)) {
    addError(errors, 'failover:checkpoint_mismatch');
  }
  if (verify?.sameTaskRecovered !== true) addError(errors, 'failover:same_task_not_recovered');
  if (verify?.failureInducedByScript !== false) addError(errors, 'failover:failure_boundary_invalid');
  const routing = verify?.routing || verify?.evidence?.routing;
  if (text(routing?.selectedProvider).toLowerCase() !== 'lmstudio'
    || !text(routing?.primaryFailureReason)
    || !SHA256_RE.test(text(routing?.primaryFailureDigest))) {
    addError(errors, 'failover:real_primary_failure_to_lmstudio_not_proven');
  }
  if (!locationBindingsMatch(readLocationBindings(verify), binding)) {
    addError(errors, 'failover:location_binding_mismatch');
  }
  const native = verify?.nativeClient || verify?.evidence?.nativeClient;
  if (!nativeIdentityMatches(native, binding)) addError(errors, 'failover:native_identity_mismatch');
}

function validateWpsPayload(payload, binding, errors) {
  if (!producerPayloadIsUnadjudicated(payload)) addError(errors, 'wps:self_adjudication_forbidden');
  const validation = payload?.validation;
  if (validation?.ok !== true || validation?.packageComplete !== true
    || validation?.filesystemVerified !== true) {
    addError(errors, 'wps:package_not_complete');
  }
  if (payload?.runtimeProvenanceVerified !== true) addError(errors, 'wps:runtime_provenance_not_verified');
  if (!SHA256_RE.test(text(payload?.manifestDigest))
    || !SHA256_RE.test(text(payload?.evidenceDigest))) {
    addError(errors, 'wps:manifest_or_evidence_digest_invalid');
  }
  if (!locationBindingsMatch(payload?.locationBindings, binding)) {
    addError(errors, 'wps:location_binding_mismatch');
  }
  if (!nativeIdentityMatches(payload?.nativeClient, binding)) addError(errors, 'wps:native_identity_mismatch');
  if (payload?.activeWpsDocumentWorkflowPassed !== true) {
    addError(errors, 'wps:active_document_workflow_not_passed');
  }
  if (payload?.batchCleanupPassed !== true) addError(errors, 'wps:batch_cleanup_not_passed');
}

function validateVariantsPayload(payload, binding, errors) {
  if (!producerPayloadIsUnadjudicated(payload)) addError(errors, 'variants:self_adjudication_forbidden');
  const validation = payload?.validation;
  if (validation?.ok !== true || validation?.packageComplete !== true
    || validation?.filesystemVerified !== true) {
    addError(errors, 'variants:package_not_complete');
  }
  if (payload?.runtimeProvenanceVerified !== true) {
    addError(errors, 'variants:runtime_provenance_not_verified');
  }
  if (!SHA256_RE.test(text(payload?.manifestDigest))
    || !SHA256_RE.test(text(payload?.evidenceDigest))) {
    addError(errors, 'variants:manifest_or_evidence_digest_invalid');
  }
  if (!locationBindingsMatch(payload?.locationBindings, binding)) {
    addError(errors, 'variants:location_binding_mismatch');
  }
  if (!nativeIdentityMatches(payload?.nativeClient, binding)) {
    addError(errors, 'variants:native_identity_mismatch');
  }
  const variants = Array.isArray(payload?.completedVariants) ? payload.completedVariants.map(text) : [];
  const required = ['designer-client', 'ecommerce-client', 'finance-client', 'legal-client'];
  if (variants.length !== required.length || required.some(id => !variants.includes(id))) {
    addError(errors, 'variants:four_business_loops_not_proven');
  }
}

const PAYLOAD_VALIDATORS = Object.freeze({
  main: validateMainPayload,
  restart: validateRestartPayload,
  failover: validateFailoverPayload,
  wps: validateWpsPayload,
  variants: validateVariantsPayload,
});

function pathIdentity(value) {
  let normalized = path.resolve(value).replace(/^\\\\\?\\/u, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/u, '');
}

function assertPathComponentsNotLinked(value, code) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  try {
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail(code);
    }
  } catch (error) {
    if (error instanceof FormalStage9AdjudicatorError) throw error;
    fail(code, { cause: error?.message });
  }
}

function normalizeEvidenceRoot(value) {
  const requested = requiredText(value, 'formal_evidence_root_required');
  if (!path.isAbsolute(requested)) fail('formal_evidence_root_absolute_required');
  const resolved = path.resolve(requested);
  let metadata;
  let real;
  try {
    metadata = fs.lstatSync(resolved);
    real = fs.realpathSync.native(resolved);
  } catch (error) {
    fail('formal_evidence_root_invalid', { cause: error?.message });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('formal_evidence_root_invalid');
  // A Windows 8.3 path can canonicalize to its long spelling without being a
  // reparse point, so compare-by-string would reject an ordinary directory.
  // Walking lstat catches symlinks and directory junctions without that false
  // positive; evidence descendants are subsequently checked component-wise
  // against this canonical real root.
  assertPathComponentsNotLinked(resolved, 'formal_evidence_root_reparse_forbidden');
  return {
    path: real,
    totalBytes: 0,
    verifiedFiles: new Map(),
  };
}

function normalizeEvidenceRelativePath(value) {
  const raw = requiredText(value, 'formal_evidence_relative_path_required');
  if (raw.length > 1024
    || raw.includes('\\')
    || raw.includes('\0')
    || raw.includes(':')
    || raw.startsWith('/')
    || path.posix.isAbsolute(raw)) {
    fail('formal_evidence_relative_path_invalid');
  }
  const segments = raw.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')
    || path.posix.normalize(raw) !== raw) {
    fail('formal_evidence_relative_path_invalid');
  }
  return { raw, segments };
}

function pathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function verifyEvidenceFile(reference, context, prefix, errors, { returnBytes = false } = {}) {
  let normalized;
  try {
    normalized = normalizeEvidenceRelativePath(reference?.relativePath);
  } catch (error) {
    addError(errors, `${prefix}:${error?.code || 'relative_path_invalid'}`);
    return false;
  }
  const declaredSize = Number(reference?.size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_EVIDENCE_FILE_BYTES) {
    addError(errors, `${prefix}:evidence_size_invalid`);
    return false;
  }
  const expectedSha256 = text(reference?.sha256).toLowerCase();
  if (!SHA256_RE.test(expectedSha256)) {
    addError(errors, `${prefix}:sha256_invalid`);
    return false;
  }
  const cacheKey = `${normalized.raw}:${declaredSize}:${expectedSha256}`;
  const alreadyVerified = context.verifiedFiles.has(cacheKey);
  if (alreadyVerified && !returnBytes) return true;

  let cursor = context.path;
  try {
    for (const [index, segment] of normalized.segments.entries()) {
      cursor = path.join(cursor, segment);
      const metadata = fs.lstatSync(cursor);
      if (metadata.isSymbolicLink()) throw new FormalStage9AdjudicatorError('evidence_path_link_forbidden');
      const realComponent = fs.realpathSync.native(cursor);
      if (pathIdentity(realComponent) !== pathIdentity(cursor)) {
        throw new FormalStage9AdjudicatorError('evidence_path_reparse_forbidden');
      }
      if (index < normalized.segments.length - 1 && !metadata.isDirectory()) {
        throw new FormalStage9AdjudicatorError('evidence_parent_not_directory');
      }
      if (index === normalized.segments.length - 1 && !metadata.isFile()) {
        throw new FormalStage9AdjudicatorError('evidence_not_regular_file');
      }
    }
    const realCandidate = fs.realpathSync.native(cursor);
    if (!pathInside(context.path, realCandidate)) {
      throw new FormalStage9AdjudicatorError('evidence_path_outside_root');
    }
    const descriptor = fs.openSync(realCandidate, fs.constants.O_RDONLY);
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.size !== declaredSize) {
        throw new FormalStage9AdjudicatorError('evidence_size_mismatch');
      }
      if (context.totalBytes + before.size > MAX_EVIDENCE_TOTAL_BYTES) {
        throw new FormalStage9AdjudicatorError('evidence_total_size_exceeded');
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new FormalStage9AdjudicatorError('evidence_changed_during_read');
      }
      const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== expectedSha256) {
        throw new FormalStage9AdjudicatorError('evidence_sha256_mismatch');
      }
      if (!alreadyVerified) {
        context.totalBytes += before.size;
        context.verifiedFiles.set(cacheKey, {
          relativePath: normalized.raw,
          size: before.size,
          sha256: actualSha256,
        });
      }
      return returnBytes ? bytes : true;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    addError(errors, `${prefix}:${error?.code || 'evidence_file_unreadable'}`);
    return false;
  }
}

function validateProducerFileManifest({
  producer,
  envelope,
  binding,
  bindingDigest,
  evidenceContext,
  errors,
}) {
  const prefix = `producer:${producer}:file_manifest`;
  const metadata = envelope?.payload?.stage9ProducerEvidence;
  if (!isPlainObject(metadata)) {
    addError(errors, `${prefix}:required`);
    return;
  }
  if (metadata.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    || metadata.acceptanceRunId !== binding.acceptanceRunId
    || text(metadata.bindingDigest).toLowerCase() !== bindingDigest
    || text(metadata.buildId).toLowerCase() !== binding.buildId
    || text(metadata.sourceFingerprint).toLowerCase() !== binding.sourceFingerprint
    || metadata.acceptanceDecision !== 'not_adjudicated'
    || metadata.acceptancePassed !== false) {
    addError(errors, `${prefix}:binding_invalid`);
  }
  const manifestReference = {
    relativePath: metadata.manifestRelativePath,
    size: metadata.manifestSize,
    sha256: metadata.manifestSha256,
  };
  const scenarioPaths = producerFileManifestEntries(envelope?.scenarioEvidence)
    .map(entry => entry.relativePath)
    .filter(Boolean);
  if (scenarioPaths.includes(text(metadata.manifestRelativePath))) {
    addError(errors, `${prefix}:path_reused_as_scenario_evidence`);
  }
  const bytes = verifyEvidenceFile(
    manifestReference,
    evidenceContext,
    prefix,
    errors,
    { returnBytes: true },
  );
  if (!Buffer.isBuffer(bytes)) return;
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    addError(errors, `${prefix}:json_invalid`);
    return;
  }
  const expectedEntries = producerFileManifestEntries(envelope?.scenarioEvidence);
  const manifestRecordedAt = validIso(manifest?.recordedAt)
    ? new Date(manifest.recordedAt).toISOString()
    : '';
  const envelopeRecordedAt = validIso(envelope?.recordedAt)
    ? new Date(envelope.recordedAt).toISOString()
    : '';
  if (!isPlainObject(manifest)
    || manifest.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    || manifest.kind !== FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND
    || manifest.producer !== producer
    || manifest.acceptanceRunId !== binding.acceptanceRunId
    || text(manifest.bindingDigest).toLowerCase() !== bindingDigest
    || text(manifest.buildId).toLowerCase() !== binding.buildId
    || text(manifest.sourceFingerprint).toLowerCase() !== binding.sourceFingerprint
    || !manifestRecordedAt
    || manifestRecordedAt !== envelopeRecordedAt
    || manifest.acceptanceDecision !== 'not_adjudicated'
    || manifest.acceptancePassed !== false
    || !sameStableValue(manifest.entries, expectedEntries)) {
    addError(errors, `${prefix}:content_mismatch`);
  }
}

function decodeEd25519Signature(value) {
  const raw = text(value);
  if (!BASE64_SIGNATURE_RE.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === raw ? decoded : null;
}

function verifyDetachedAttestation(attestation, signer, bytes) {
  if (!isPlainObject(attestation)
    || Object.hasOwn(attestation, 'publicKey')
    || Object.hasOwn(attestation, 'publicKeyPem')
    || text(attestation.algorithm).toLowerCase() !== 'ed25519'
    || text(attestation.keyId) !== signer?.keyId) {
    return false;
  }
  const signature = decodeEd25519Signature(attestation.signature);
  return Boolean(signature && crypto.verify(null, bytes, signer.publicKey, signature));
}

function verifyReferenceAttestation(reference, category, trustPolicy, prefix, errors) {
  if (trustPolicy.acceptanceMode !== 'dual_attestation') return;
  const native = category === 'screenshots';
  const role = native ? 'native' : 'server';
  const signer = native ? trustPolicy.nativeCaptureSigner : trustPolicy.serverReceiptSigner;
  const attestation = native ? reference?.nativeAttestation : reference?.serverAttestation;
  if (!verifyDetachedAttestation(attestation, signer, referenceSigningBytes(reference, role))) {
    addError(errors, `${prefix}:${role}_attestation_invalid`);
  }
}

function verifyBundleSignature(bundle, trustPolicy, errors) {
  if (Object.hasOwn(bundle, 'trustPolicy')
    || Object.hasOwn(bundle, 'publicKey')
    || Object.hasOwn(bundle, 'publicKeyPem')
    || Object.hasOwn(bundle, 'trustedKeys')) {
    addError(errors, 'formal_bundle_embedded_trust_material_forbidden');
  }
  if (!verifyDetachedAttestation(bundle?.bundleSignature, trustPolicy.bundleSigner, bundleSigningBytes(bundle))) {
    addError(errors, 'formal_bundle_signature_invalid');
  }
}

function validateEvidenceManifest(bundle, errors) {
  const expected = buildFormalStage9EvidenceManifest(bundle?.producers);
  const manifest = bundle?.evidenceManifest;
  if (!isPlainObject(manifest)
    || manifest.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    || manifest.kind !== FORMAL_STAGE9_EVIDENCE_MANIFEST_KIND
    || manifest.entryCount !== expected.entryCount
    || !sameStableValue(manifest, expected)) {
    addError(errors, 'formal_evidence_manifest_mismatch');
  }
  if (!isPlainObject(manifest)
    || !objectDigestMatches(manifest, bundle?.evidenceManifestDigest)) {
    addError(errors, 'formal_evidence_manifest_digest_mismatch');
  }
  const paths = expected.entries.map(entry => entry.relativePath).filter(Boolean);
  if (new Set(paths).size !== paths.length) addError(errors, 'formal_evidence_manifest_path_reused');
  const identities = expected.entries.map(entry => `${entry.producer}:${entry.scenarioId}:${entry.category}:${entry.recordId}`);
  if (new Set(identities).size !== identities.length) addError(errors, 'formal_evidence_manifest_identity_reused');
  if (expected.entries.length === 0) addError(errors, 'formal_evidence_manifest_empty');
}

function validateCommonEvidenceReference({
  reference,
  scenarioId,
  category,
  binding,
  bindingDigest,
  evidenceContext,
  trustPolicy,
  createdAtMs,
  completedAtMs,
  errors,
}) {
  const prefix = `${scenarioId}:${category}`;
  if (!isPlainObject(reference)) {
    addError(errors, `${prefix}:reference_invalid`);
    return null;
  }
  const recordedAtMs = Date.parse(text(reference.recordedAt));
  if (!Number.isFinite(recordedAtMs)
    || recordedAtMs < createdAtMs
    || recordedAtMs > completedAtMs) {
    addError(errors, `${prefix}:timestamp_outside_acceptance_run`);
  }
  const normalized = {
    recordId: text(reference.recordId),
    scenarioId: text(reference.scenarioId),
    acceptanceRunId: text(reference.acceptanceRunId),
    bindingDigest: text(reference.bindingDigest).toLowerCase(),
    sha256: text(reference.sha256).toLowerCase(),
    relativePath: text(reference.relativePath),
    size: Number(reference.size),
    recordedAt: text(reference.recordedAt),
    requestId: text(reference.requestId),
    taskId: text(reference.taskId),
  };
  if (!normalized.recordId) addError(errors, `${prefix}:record_id_missing`);
  if (normalized.scenarioId !== scenarioId) addError(errors, `${prefix}:scenario_binding_mismatch`);
  if (normalized.acceptanceRunId !== binding.acceptanceRunId) {
    addError(errors, `${prefix}:acceptance_run_mismatch`);
  }
  if (normalized.bindingDigest !== bindingDigest) addError(errors, `${prefix}:binding_digest_mismatch`);
  if (!SHA256_RE.test(normalized.sha256)) addError(errors, `${prefix}:sha256_invalid`);
  if (!normalized.requestId) addError(errors, `${prefix}:request_id_missing`);
  if (!normalized.taskId) addError(errors, `${prefix}:task_id_missing`);
  const sourceSecurity = reference?.sourceSecurity;
  const sourceSecurityValid = isPlainObject(sourceSecurity)
    && sourceSecurity.evidenceClassification === 'restricted_private_local'
    && sourceSecurity.publishable === false
    && ((sourceSecurity.secretScanStatus === 'passed_text_scan'
        && sourceSecurity.manualRedactionReviewCompleted === false)
      || (sourceSecurity.secretScanStatus === 'manual_review_completed_binary'
        && sourceSecurity.manualRedactionReviewCompleted === true));
  if (!sourceSecurityValid) addError(errors, `${prefix}:source_security_invalid`);
  verifyEvidenceFile(reference, evidenceContext, prefix, errors);
  verifyReferenceAttestation(reference, category, trustPolicy, prefix, errors);

  if (category === 'screenshots') {
    if (reference.trustedNativeCapture !== true
      || reference.manualReviewCompleted !== true
      || text(reference.nativeDeviceId) !== binding.nativeClient.deviceId
      || text(reference.executionSessionId) !== binding.nativeClient.executionSessionId
      || !text(reference.windowId)) {
      addError(errors, `${prefix}:trusted_native_screenshot_required`);
    }
  } else if (category === 'taskReceipts') {
    if (!text(reference.receiptId) || !text(reference.toolName)
      || !['verified', 'succeeded', 'completed'].includes(text(reference.verification))) {
      addError(errors, `${prefix}:verified_receipt_required`);
    }
  } else if (category === 'taskTimeline') {
    if (!text(reference.status) || !text(reference.source)) {
      addError(errors, `${prefix}:timeline_record_invalid`);
    }
  } else if (category === 'modelRouting') {
    if (!text(reference.routingReceiptId)
      || !text(reference.selectedProvider)
      || !text(reference.selectedModel)
      || reference.status !== 'succeeded') {
      addError(errors, `${prefix}:successful_model_route_required`);
    }
  } else if (category === 'artifacts') {
    if (!text(reference.artifactId) || reference.verified !== true) {
      addError(errors, `${prefix}:verified_artifact_required`);
    }
  } else if (category === 'userFeedback') {
    if (!text(reference.messageId)
      || !SHA256_RE.test(text(reference.replySha256))
      || reference.internalGuardLeaked !== false) {
      addError(errors, `${prefix}:user_feedback_invalid`);
    }
  }
  return normalized;
}

function intersection(values) {
  if (values.length === 0) return new Set();
  const [first, ...rest] = values;
  return new Set([...first].filter(value => rest.every(set => set.has(value))));
}

function validateScenarioEvidence({
  producer,
  scenarioEvidence,
  binding,
  bindingDigest,
  evidenceContext,
  trustPolicy,
  createdAtMs,
  completedAtMs,
  errors,
  seenReferences,
}) {
  const expectedScenarios = FORMAL_STAGE9_SCENARIOS.filter(
    scenarioId => FORMAL_STAGE9_SCENARIO_OWNERS[scenarioId] === producer,
  );
  const actualScenarios = isPlainObject(scenarioEvidence) ? Object.keys(scenarioEvidence) : [];
  for (const scenarioId of actualScenarios) {
    if (!expectedScenarios.includes(scenarioId)) addError(errors, `${producer}:${scenarioId}:scenario_not_owned`);
  }
  for (const scenarioId of expectedScenarios) {
    const categories = scenarioEvidence?.[scenarioId];
    if (!isPlainObject(categories)) {
      addError(errors, `${producer}:${scenarioId}:evidence_missing`);
      continue;
    }
    for (const category of Object.keys(categories)) {
      if (!FORMAL_STAGE9_EVIDENCE_CATEGORIES.includes(category)) {
        addError(errors, `${producer}:${scenarioId}:${category}:unexpected_category`);
      }
    }
    const requestSets = [];
    const taskSets = [];
    for (const category of FORMAL_STAGE9_EVIDENCE_CATEGORIES) {
      const references = categories[category];
      if (!Array.isArray(references) || references.length === 0) {
        addError(errors, `${producer}:${scenarioId}:${category}:missing`);
        continue;
      }
      const normalized = [];
      for (const reference of references) {
        const item = validateCommonEvidenceReference({
          reference,
          scenarioId,
          category,
          binding,
          bindingDigest,
          evidenceContext,
          trustPolicy,
          createdAtMs,
          completedAtMs,
          errors,
        });
        if (!item) continue;
        const uniquenessKey = `${category}:${item.recordId}:${item.sha256}`;
        if (seenReferences.has(uniquenessKey)) {
          addError(errors, `${producer}:${scenarioId}:${category}:evidence_reused_across_scenarios`);
        }
        seenReferences.add(uniquenessKey);
        normalized.push(item);
      }
      requestSets.push(new Set(normalized.map(item => item.requestId).filter(Boolean)));
      taskSets.push(new Set(normalized.map(item => item.taskId).filter(Boolean)));
    }
    if (intersection(requestSets).size === 0) {
      addError(errors, `${producer}:${scenarioId}:request_chain_not_cross_linked`);
    }
    if (intersection(taskSets).size === 0) {
      addError(errors, `${producer}:${scenarioId}:task_chain_not_cross_linked`);
    }
  }
}

function validateProducerEnvelope({
  producer,
  envelope,
  binding,
  bindingDigest,
  evidenceContext,
  trustPolicy,
  createdAtMs,
  completedAtMs,
  errors,
  seenReferences,
}) {
  const prefix = `producer:${producer}`;
  if (!isPlainObject(envelope)) {
    addError(errors, `${prefix}:missing`);
    return;
  }
  if (envelope.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    || envelope.kind !== FORMAL_STAGE9_PRODUCER_KIND
    || envelope.producer !== producer) {
    addError(errors, `${prefix}:envelope_invalid`);
  }
  if (!SHA256_RE.test(text(envelope.envelopeDigest))
    || producerEnvelopeDigest(envelope) !== text(envelope.envelopeDigest).toLowerCase()) {
    addError(errors, `${prefix}:envelope_digest_mismatch`);
  }
  if (envelope.acceptanceRunId !== binding.acceptanceRunId) addError(errors, `${prefix}:acceptance_run_mismatch`);
  if (text(envelope.bindingDigest).toLowerCase() !== bindingDigest
    || !sameStableValue(envelope.binding, binding)) {
    addError(errors, `${prefix}:binding_mismatch`);
  }
  const recordedAtMs = Date.parse(text(envelope.recordedAt));
  if (!Number.isFinite(recordedAtMs) || recordedAtMs < createdAtMs || recordedAtMs > completedAtMs) {
    addError(errors, `${prefix}:timestamp_outside_acceptance_run`);
  }
  if (envelope.status !== ALLOWED_PRODUCER_STATUS || envelope.packageComplete !== true) {
    addError(errors, `${prefix}:package_incomplete`);
  }
  if (envelope.acceptanceDecision !== 'not_adjudicated' || envelope.acceptancePassed !== false) {
    addError(errors, `${prefix}:self_adjudication_forbidden`);
  }
  if (!isPlainObject(envelope.payload)
    || !objectDigestMatches(envelope.payload, envelope.payloadDigest)) {
    addError(errors, `${prefix}:payload_digest_mismatch`);
  } else {
    PAYLOAD_VALIDATORS[producer](envelope.payload, binding, errors);
    validateProducerFileManifest({
      producer,
      envelope,
      binding,
      bindingDigest,
      evidenceContext,
      errors,
    });
  }
  validateScenarioEvidence({
    producer,
    scenarioEvidence: envelope.scenarioEvidence,
    binding,
    bindingDigest,
    evidenceContext,
    trustPolicy,
    createdAtMs,
    completedAtMs,
    errors,
    seenReferences,
  });
}

function trustDecisionSummary(trustPolicy, evidenceContext, integrityVerified = false) {
  if (!trustPolicy) return { integrityVerified: false, policyId: '', acceptanceMode: 'untrusted' };
  return {
    integrityVerified,
    policyId: trustPolicy.policyId,
    acceptanceMode: trustPolicy.acceptanceMode,
    bundleSigner: {
      keyId: trustPolicy.bundleSigner.keyId,
      publicKeyFingerprint: trustPolicy.bundleSigner.publicKeyFingerprint,
    },
    ...(trustPolicy.serverReceiptSigner ? {
      serverReceiptSigner: {
        keyId: trustPolicy.serverReceiptSigner.keyId,
        publicKeyFingerprint: trustPolicy.serverReceiptSigner.publicKeyFingerprint,
      },
    } : {}),
    ...(trustPolicy.nativeCaptureSigner ? {
      nativeCaptureSigner: {
        keyId: trustPolicy.nativeCaptureSigner.keyId,
        publicKeyFingerprint: trustPolicy.nativeCaptureSigner.publicKeyFingerprint,
      },
    } : {}),
    evidenceFilesVerified: evidenceContext?.verifiedFiles?.size || 0,
    evidenceBytesVerified: evidenceContext?.totalBytes || 0,
  };
}

function rejectedDecision({
  acceptanceRunId = '',
  bindingDigest = '',
  errors = [],
  producerChecks = {},
  trust,
}) {
  const decision = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_DECISION_KIND,
    acceptanceRunId,
    bindingDigest,
    adjudicatedAt: new Date().toISOString(),
    status: 'rejected',
    acceptanceDecision: 'rejected',
    acceptancePassed: false,
    fullAcceptance: false,
    trust: trust || { integrityVerified: false, policyId: '', acceptanceMode: 'untrusted' },
    producerChecks,
    scenarioCoverage: {
      complete: false,
      requiredScenarios: [...FORMAL_STAGE9_SCENARIOS],
      requiredCategories: [...FORMAL_STAGE9_EVIDENCE_CATEGORIES],
    },
    errors: [...new Set(errors.length > 0 ? errors : ['formal_bundle_invalid'])],
  };
  return { ...decision, decisionDigest: formalStage9Digest(decision) };
}

function integrityVerifiedDecision({ binding, bindingDigest, producerChecks, trust }) {
  const decision = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_DECISION_KIND,
    acceptanceRunId: binding.acceptanceRunId,
    bindingDigest,
    adjudicatedAt: new Date().toISOString(),
    status: 'integrity_verified',
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    fullAcceptance: false,
    producerChecks,
    trust,
    scenarioCoverage: {
      complete: true,
      requiredScenarios: [...FORMAL_STAGE9_SCENARIOS],
      requiredCategories: [...FORMAL_STAGE9_EVIDENCE_CATEGORIES],
    },
    blockers: ['dual_attestation_required_for_acceptance'],
    errors: [],
  };
  return { ...decision, decisionDigest: formalStage9Digest(decision) };
}

/** The only function in the formal protocol allowed to produce acceptance. */
export function adjudicateFormalStage9Evidence(bundle, options = {}) {
  const errors = [];
  let binding;
  let bindingDigest = '';
  let trustPolicy;
  let evidenceContext;
  if (!isPlainObject(bundle)
    || bundle.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    || bundle.kind !== FORMAL_STAGE9_BUNDLE_KIND) {
    return rejectedDecision({ errors: ['formal_bundle_envelope_invalid'] });
  }
  try {
    trustPolicy = normalizeFormalStage9TrustPolicy(options.trustPolicy);
    evidenceContext = normalizeEvidenceRoot(options.evidenceRoot);
  } catch (error) {
    return rejectedDecision({
      acceptanceRunId: text(bundle.acceptanceRunId),
      errors: [error?.code || 'formal_external_trust_context_invalid'],
    });
  }
  if (!SHA256_RE.test(text(bundle.bundleDigest))
    || bundleDigest(bundle) !== text(bundle.bundleDigest).toLowerCase()) {
    addError(errors, 'formal_bundle_digest_mismatch');
  }
  verifyBundleSignature(bundle, trustPolicy, errors);
  validateEvidenceManifest(bundle, errors);
  try {
    binding = normalizeFormalStage9Binding(bundle.binding);
    bindingDigest = formalStage9Digest(binding);
  } catch (error) {
    addError(errors, `formal_binding:${error?.code || 'invalid'}`);
    return rejectedDecision({
      acceptanceRunId: text(bundle.acceptanceRunId),
      errors,
      trust: trustDecisionSummary(trustPolicy, evidenceContext, false),
    });
  }
  if (bundle.acceptanceRunId !== binding.acceptanceRunId) addError(errors, 'formal_bundle_acceptance_run_mismatch');
  if (text(bundle.bindingDigest).toLowerCase() !== bindingDigest) addError(errors, 'formal_bundle_binding_digest_mismatch');
  const createdAtMs = Date.parse(text(bundle.createdAt));
  const completedAtMs = Date.parse(text(bundle.completedAt));
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(completedAtMs)
    || completedAtMs < createdAtMs
    || completedAtMs - createdAtMs > 72 * 60 * 60 * 1000) {
    addError(errors, 'formal_bundle_time_window_invalid');
  }
  if (!isPlainObject(bundle.producers)) addError(errors, 'formal_bundle_producers_invalid');
  const actualProducers = isPlainObject(bundle.producers) ? Object.keys(bundle.producers) : [];
  for (const producer of actualProducers) {
    if (!FORMAL_STAGE9_PRODUCERS.includes(producer)) addError(errors, `producer:${producer}:unexpected`);
  }
  const seenReferences = new Set();
  const producerChecks = {};
  for (const producer of FORMAL_STAGE9_PRODUCERS) {
    const before = errors.length;
    validateProducerEnvelope({
      producer,
      envelope: bundle.producers?.[producer],
      binding,
      bindingDigest,
      evidenceContext,
      trustPolicy,
      createdAtMs,
      completedAtMs,
      errors,
      seenReferences,
    });
    producerChecks[producer] = { passed: errors.length === before };
  }
  if (errors.length > 0) {
    return rejectedDecision({
      acceptanceRunId: binding.acceptanceRunId,
      bindingDigest,
      errors,
      producerChecks,
      trust: trustDecisionSummary(trustPolicy, evidenceContext, false),
    });
  }
  const verifiedTrust = trustDecisionSummary(trustPolicy, evidenceContext, true);
  if (trustPolicy.acceptanceMode !== 'dual_attestation') {
    return integrityVerifiedDecision({
      binding,
      bindingDigest,
      producerChecks,
      trust: verifiedTrust,
    });
  }
  if (!nativeClientEligibleForFormalAcceptance(binding.nativeClient, binding.locations)) {
    return rejectedDecision({
      acceptanceRunId: binding.acceptanceRunId,
      bindingDigest,
      errors: ['formal_native_client_os_and_webview_attestation_required'],
      producerChecks,
      trust: verifiedTrust,
    });
  }
  const decision = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_DECISION_KIND,
    acceptanceRunId: binding.acceptanceRunId,
    bindingDigest,
    adjudicatedAt: new Date().toISOString(),
    status: 'accepted',
    acceptanceDecision: 'accepted',
    acceptancePassed: true,
    fullAcceptance: true,
    producerChecks,
    trust: verifiedTrust,
    scenarioCoverage: {
      complete: true,
      requiredScenarios: [...FORMAL_STAGE9_SCENARIOS],
      requiredCategories: [...FORMAL_STAGE9_EVIDENCE_CATEGORIES],
    },
    errors: [],
  };
  const acceptedDecision = { ...decision, decisionDigest: formalStage9Digest(decision) };
  FORMALLY_ACCEPTED_DECISIONS.add(acceptedDecision);
  return acceptedDecision;
}

export function formalStage9AdjudicatorExitCode(decision) {
  const unsignedDecision = isPlainObject(decision) ? structuredClone(decision) : null;
  if (unsignedDecision) delete unsignedDecision.decisionDigest;
  const requiredScenarios = decision?.scenarioCoverage?.requiredScenarios;
  const requiredCategories = decision?.scenarioCoverage?.requiredCategories;
  const producerKeys = isPlainObject(decision?.producerChecks)
    ? Object.keys(decision.producerChecks)
    : [];
  return isPlainObject(decision)
    && FORMALLY_ACCEPTED_DECISIONS.has(decision)
    && decision.schemaVersion === FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
    && decision.kind === FORMAL_STAGE9_DECISION_KIND
    && ACCEPTANCE_RUN_ID_RE.test(text(decision.acceptanceRunId))
    && SHA256_RE.test(text(decision.bindingDigest))
    && validIso(decision.adjudicatedAt)
    && decision?.status === 'accepted'
    && decision?.acceptanceDecision === 'accepted'
    && decision?.acceptancePassed === true
    && decision?.fullAcceptance === true
    && decision?.trust?.integrityVerified === true
    && decision?.trust?.acceptanceMode === 'dual_attestation'
    && decision?.scenarioCoverage?.complete === true
    && Array.isArray(requiredScenarios)
    && requiredScenarios.length === FORMAL_STAGE9_SCENARIOS.length
    && FORMAL_STAGE9_SCENARIOS.every(scenario => requiredScenarios.includes(scenario))
    && Array.isArray(requiredCategories)
    && requiredCategories.length === FORMAL_STAGE9_EVIDENCE_CATEGORIES.length
    && FORMAL_STAGE9_EVIDENCE_CATEGORIES.every(category => requiredCategories.includes(category))
    && producerKeys.length === FORMAL_STAGE9_PRODUCERS.length
    && FORMAL_STAGE9_PRODUCERS.every(producer => decision?.producerChecks?.[producer]?.passed === true)
    && Array.isArray(decision?.errors)
    && decision.errors.length === 0
    && SHA256_RE.test(text(decision.decisionDigest))
    && formalStage9Digest(unsignedDecision) === text(decision.decisionDigest).toLowerCase()
    ? 0
    : 1;
}

function parseArgs(argv) {
  const args = {
    bundle: '',
    trustPolicy: '',
    trustPolicySha256: text(process.env.LUMI_FORMAL_TRUST_POLICY_SHA256).toLowerCase(),
    evidenceRoot: '',
    output: '',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      args.help = true;
      continue;
    }
    if (![
      '--bundle',
      '--trust-policy',
      '--trust-policy-sha256',
      '--evidence-root',
      '--output',
    ].includes(flag)) {
      fail('cli_arguments_invalid');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('cli_arguments_invalid');
    index += 1;
    const key = flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    args[key] = value;
  }
  if (args.help) return args;
  if (!path.isAbsolute(args.bundle)) fail('absolute_bundle_path_required');
  if (!path.isAbsolute(args.trustPolicy)) fail('absolute_trust_policy_path_required');
  if (!SHA256_RE.test(args.trustPolicySha256)) fail('formal_trust_policy_sha256_required');
  if (!path.isAbsolute(args.evidenceRoot)) fail('absolute_evidence_root_path_required');
  if (args.output && !path.isAbsolute(args.output)) fail('absolute_output_path_required');
  args.bundle = path.resolve(args.bundle);
  args.trustPolicy = path.resolve(args.trustPolicy);
  args.evidenceRoot = path.resolve(args.evidenceRoot);
  if (args.output) args.output = path.resolve(args.output);
  return args;
}

function readJsonFile(filePath, {
  fileCode = 'formal_bundle_file_invalid',
  jsonCode = 'formal_bundle_json_invalid',
  maxBytes = 32 * 1024 * 1024,
  expectedSha256 = '',
} = {}) {
  let metadata;
  let real;
  let descriptor;
  try {
    metadata = fs.lstatSync(filePath);
    real = fs.realpathSync.native(filePath);
  } catch (error) {
    fail(fileCode, { cause: error?.message });
  }
  assertPathComponentsNotLinked(filePath, fileCode);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size <= 0
    || metadata.size > maxBytes) {
    fail(fileCode);
  }
  try {
    descriptor = fs.openSync(real, fs.constants.O_RDONLY);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
      || before.size !== metadata.size
      || before.size <= 0
      || before.size > maxBytes
      || (metadata.dev && before.dev !== metadata.dev)
      || (metadata.ino && before.ino !== metadata.ino)) {
      fail(fileCode);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || (before.dev && after.dev !== before.dev)
      || (before.ino && after.ino !== before.ino)) {
      fail(fileCode);
    }
    if (expectedSha256
      && crypto.createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      fail('formal_trust_policy_sha256_mismatch');
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof FormalStage9AdjudicatorError) throw error;
    fail(jsonCode, { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function writeDecision(outputPath, decision) {
  const serialized = `${JSON.stringify(decision, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  if (fs.existsSync(outputPath)) fail('formal_decision_output_exists');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(serialized);
}

function usage() {
  return [
    'Formal Lumi Stage 9 adjudicator (read-only, fail closed).',
    '',
    'Usage:',
    '  node scripts/formal-stage9-adjudicator.mjs --bundle <absolute-json> \\',
    '    --trust-policy <absolute-json> --trust-policy-sha256 <sha256> \\',
    '    --evidence-root <absolute-dir> \\',
    '    [--output <new-absolute-json>]',
    '',
    'The trust policy is external to the evidence bundle, must contain the',
    'operator-trusted Ed25519 public key(s), and must match a separately pinned',
    'SHA-256 supplied by the release job or LUMI_FORMAL_TRUST_POLICY_SHA256.',
    'integrity_only verifies files and',
    'the signed bundle but remains not_adjudicated and returns exit 1.',
    '',
    'Only this adjudicator may return exit 0. Evidence producers return 2 for a',
    'complete but unadjudicated package and 1 for failure or incomplete evidence.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let decision;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      // Exit zero is reserved exclusively for a real accepted adjudication.
      process.exitCode = 1;
      return;
    }
    decision = adjudicateFormalStage9Evidence(readJsonFile(args.bundle), {
      trustPolicy: readJsonFile(args.trustPolicy, {
        fileCode: 'formal_trust_policy_file_invalid',
        jsonCode: 'formal_trust_policy_json_invalid',
        maxBytes: 1024 * 1024,
        expectedSha256: args.trustPolicySha256,
      }),
      evidenceRoot: args.evidenceRoot,
    });
    writeDecision(args.output, decision);
  } catch (error) {
    decision = rejectedDecision({ errors: [error?.code || 'formal_adjudicator_unexpected_failure'] });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  }
  process.exitCode = formalStage9AdjudicatorExitCode(decision);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
