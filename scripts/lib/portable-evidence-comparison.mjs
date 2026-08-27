import {
  PORTABLE_EVIDENCE_BUNDLE_KIND,
  PORTABLE_PROVIDER_CAPTURE_KIND,
  PORTABLE_STORE_SNAPSHOT_KIND,
  PortableExternalEvidenceError,
  normalizePortableEvidenceManifest,
  portableEvidenceHmacKeyId,
  portableEvidenceSha256,
  signPortableEvidenceRecord,
  stablePortableEvidenceJson,
  validatePortableEvidenceDocument,
  verifyPortableEvidenceRecord,
} from './portable-external-evidence.mjs';

export const PORTABLE_SIGNED_MANIFEST_KIND = 'lumi.portable-signed-manifest';
export const PORTABLE_BUILD_IDENTITY_KIND = 'lumi.portable-build-identity';
export const PORTABLE_FORMAL_NATIVE_EVIDENCE_KIND = 'lumi.portable-formal-native-evidence';
export const PORTABLE_EVIDENCE_COMPARISON_KIND = 'lumi.portable-evidence-comparison';
export const PORTABLE_EVIDENCE_COMPARISON_SCHEMA_VERSION = 1;

export const REQUIRED_FORMAL_NATIVE_CHECKS = Object.freeze([
  'native_client_bound',
  'formal_data_root_bound',
  'formal_webview_profile_bound',
  'window_visible_responsive',
  'formal_scenario_evidence_retained',
]);

const SHA256_RE = /^[a-f0-9]{64}$/u;
const REVISION_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SAFE_NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{11,191}$/u;

function fail(code, details, cause) {
  throw new PortableExternalEvidenceError(code, details, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, code, pattern = SAFE_ID_RE) {
  const result = String(value || '').trim();
  if (!result || (pattern && !pattern.test(result))) fail(code);
  return result;
}

function exactSha256(value, code) {
  const result = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(result)) fail(code);
  return result;
}

function isoTimestamp(value, code) {
  const result = String(value || '').trim();
  if (!result || !Number.isFinite(Date.parse(result))) fail(code);
  return new Date(result).toISOString();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function normalizeBuildIdentityCore(input, expectedRole) {
  if (!isPlainObject(input)) fail('portable_comparison_build_identity_required');
  if (input.kind !== PORTABLE_BUILD_IDENTITY_KIND || input.schemaVersion !== 1) {
    fail('portable_comparison_build_identity_schema_invalid');
  }
  const role = requiredText(input.role, 'portable_comparison_build_role_invalid');
  if (!['baseline', 'candidate'].includes(role) || (expectedRole && role !== expectedRole)) {
    fail('portable_comparison_build_role_invalid');
  }
  const sourceDirty = input.sourceDirty;
  if (typeof sourceDirty !== 'boolean') fail('portable_comparison_source_dirty_invalid');
  const core = {
    kind: PORTABLE_BUILD_IDENTITY_KIND,
    schemaVersion: 1,
    role,
    revision: requiredText(input.revision, 'portable_comparison_revision_invalid', REVISION_RE)
      .toLowerCase(),
    sourceDirty,
    sourceFingerprintSha256: exactSha256(
      input.sourceFingerprintSha256,
      'portable_comparison_source_fingerprint_invalid',
    ),
    runtimeFingerprintSha256: exactSha256(
      input.runtimeFingerprintSha256,
      'portable_comparison_runtime_fingerprint_invalid',
    ),
    collectedAt: isoTimestamp(input.collectedAt, 'portable_comparison_build_timestamp_invalid'),
  };
  const buildIdentityDigest = portableEvidenceSha256(core);
  if (input.buildIdentityDigest && String(input.buildIdentityDigest).toLowerCase() !== buildIdentityDigest) {
    fail('portable_comparison_build_identity_digest_mismatch');
  }
  return { ...core, buildIdentityDigest };
}

export function createSignedPortableBuildIdentity(input, key) {
  return signPortableEvidenceRecord(normalizeBuildIdentityCore(input, input?.role), key);
}

export function createSignedPortableManifest(manifestInput, key) {
  const manifest = normalizePortableEvidenceManifest(manifestInput);
  return signPortableEvidenceRecord({
    kind: PORTABLE_SIGNED_MANIFEST_KIND,
    schemaVersion: 1,
    manifestDigest: manifest.manifestDigest,
    manifest,
  }, key);
}

function normalizeFormalNativeCore(input) {
  if (!isPlainObject(input)) fail('portable_formal_native_evidence_required');
  if (input.kind !== PORTABLE_FORMAL_NATIVE_EVIDENCE_KIND || input.schemaVersion !== 1) {
    fail('portable_formal_native_schema_invalid');
  }
  const executionStatus = requiredText(
    input.executionStatus,
    'portable_formal_native_execution_status_invalid',
  );
  if (!['completed', 'not_run'].includes(executionStatus)) {
    fail('portable_formal_native_execution_status_invalid');
  }
  const checks = Array.isArray(input.checks) ? input.checks.map(check => {
    if (!isPlainObject(check)) fail('portable_formal_native_check_invalid');
    const status = requiredText(check.status, 'portable_formal_native_check_status_invalid');
    if (!['passed', 'failed', 'not_run'].includes(status)) {
      fail('portable_formal_native_check_status_invalid');
    }
    return {
      id: requiredText(check.id, 'portable_formal_native_check_id_invalid'),
      status,
      observed: check.observed === true,
      evidenceSha256: exactSha256(
        check.evidenceSha256,
        'portable_formal_native_check_evidence_invalid',
      ),
    };
  }) : [];
  const ids = checks.map(check => check.id);
  if (new Set(ids).size !== ids.length) fail('portable_formal_native_duplicate_check');
  const startedAt = executionStatus === 'completed'
    ? isoTimestamp(input.startedAt, 'portable_formal_native_started_at_invalid')
    : '';
  const completedAt = executionStatus === 'completed'
    ? isoTimestamp(input.completedAt, 'portable_formal_native_completed_at_invalid')
    : '';
  if (executionStatus === 'completed' && Date.parse(completedAt) < Date.parse(startedAt)) {
    fail('portable_formal_native_time_order_invalid');
  }
  if (executionStatus === 'not_run'
    && checks.some(check => check.status !== 'not_run' || check.observed)) {
    fail('portable_formal_native_not_run_check_invalid');
  }
  return {
    kind: PORTABLE_FORMAL_NATIVE_EVIDENCE_KIND,
    schemaVersion: 1,
    runId: requiredText(input.runId, 'portable_formal_native_run_id_invalid'),
    buildIdentityDigest: exactSha256(
      input.buildIdentityDigest,
      'portable_formal_native_build_digest_invalid',
    ),
    profileSha256: exactSha256(input.profileSha256, 'portable_formal_native_profile_invalid'),
    executionStatus,
    startedAt,
    completedAt,
    checks: checks.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function createSignedPortableFormalNativeEvidence(input, key) {
  return signPortableEvidenceRecord(normalizeFormalNativeCore(input), key);
}

function validateSignedManifest(envelope, key, role) {
  const issues = [];
  if (!verifyPortableEvidenceRecord(envelope, key)) issues.push(`${role}_manifest_attestation_invalid`);
  if (envelope?.kind !== PORTABLE_SIGNED_MANIFEST_KIND || envelope?.schemaVersion !== 1) {
    issues.push(`${role}_manifest_envelope_invalid`);
  }
  let manifest = null;
  try {
    manifest = normalizePortableEvidenceManifest(envelope?.manifest);
    if (envelope?.manifestDigest !== manifest.manifestDigest) {
      issues.push(`${role}_manifest_digest_mismatch`);
    }
    if (manifest.role !== role) issues.push(`${role}_manifest_role_mismatch`);
    if (manifest.hmacKeyId && manifest.hmacKeyId !== portableEvidenceHmacKeyId(key)) {
      issues.push(`${role}_manifest_hmac_key_mismatch`);
    }
  } catch {
    issues.push(`${role}_manifest_invalid`);
  }
  return { valid: issues.length === 0, manifest, issues };
}

function validateSignedBuildIdentity(record, key, role, manifest) {
  const issues = [];
  if (!verifyPortableEvidenceRecord(record, key)) issues.push(`${role}_build_attestation_invalid`);
  let identity = null;
  try {
    identity = normalizeBuildIdentityCore(record, role);
    if (manifest && identity.buildIdentityDigest !== manifest.buildIdentityDigest) {
      issues.push(`${role}_build_manifest_mismatch`);
    }
  } catch {
    issues.push(`${role}_build_identity_invalid`);
  }
  return { valid: issues.length === 0, identity, issues };
}

function coverageContract(manifest) {
  return manifest.phases.map(phase => ({
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    expectedToolName: phase.expectedToolName,
    requirements: phase.requirements,
  })).sort((left, right) => (
    `${left.scenarioId}\0${left.phaseId}`.localeCompare(`${right.scenarioId}\0${right.phaseId}`)
  ));
}

function phaseKey(phase) {
  return `${phase.scenarioId}/${phase.phaseId}`;
}

function collectObservationStateIssues(value, prefix = '') {
  const issues = [];
  if (!value || typeof value !== 'object') return issues;
  if (['ambiguous', 'invalid', 'unsupported'].includes(value.state)) {
    issues.push(`${prefix || 'observation'}:${value.state}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'rows' || key === 'state' || !child || typeof child !== 'object' || Array.isArray(child)) {
      continue;
    }
    issues.push(...collectObservationStateIssues(child, prefix ? `${prefix}.${key}` : key));
  }
  return issues;
}

function rowIdentityIssues(rows, binding, prefix) {
  const issues = [];
  for (const [index, row] of rows.entries()) {
    if (row.requestId !== undefined && row.requestId !== binding.requestId) {
      issues.push(`${prefix}[${index}]:request_mismatch`);
    }
    if (row.conversationId !== undefined && row.conversationId !== binding.conversationId) {
      issues.push(`${prefix}[${index}]:conversation_mismatch`);
    }
    if (row.userId !== undefined && row.userId !== binding.userId) {
      issues.push(`${prefix}[${index}]:user_mismatch`);
    }
  }
  return issues;
}

function recomputeStorePhase(store, phase, manifest, key) {
  const evidenceIssues = [];
  const behaviorIssues = [];
  const internalIssues = [];
  if (!store) {
    if (phase.requirements.passiveStore) evidenceIssues.push('store_snapshot_missing');
    if (phase.expectedToolName) behaviorIssues.push('expected_tool_receipt_missing');
    return {
      evidenceIssues,
      behaviorIssues,
      internalIssues,
      expectedToolObserved: false,
      routingModels: [],
    };
  }
  const validation = validatePortableEvidenceDocument(store, key, manifest);
  if (!validation.ok) evidenceIssues.push(...validation.issues.map(issue => `store:${issue}`));
  if (store.kind !== PORTABLE_STORE_SNAPSHOT_KIND || store.schemaVersion !== 1) {
    evidenceIssues.push('store_schema_invalid');
  }
  if (store?.source?.dataRootIdentitySha256 !== manifest.dataRootIdentitySha256) {
    evidenceIssues.push('store_data_root_identity_mismatch');
  }
  if (store.selectionPolicy !== 'exact_conversation_user_request_only_no_latest_wins') {
    evidenceIssues.push('store_selection_policy_invalid');
  }
  if (!validIsoTimestamp(store.capturedAt)) evidenceIssues.push('store_capture_time_invalid');
  if (String(store.expectedToolName || '') !== phase.expectedToolName) {
    evidenceIssues.push('store_expected_tool_binding_invalid');
  }
  if (!isPlainObject(store.observations)) evidenceIssues.push('store_observations_invalid');
  if (!Array.isArray(store.structuralIssues)) evidenceIssues.push('store_structural_issues_invalid');
  const observations = isPlainObject(store.observations) ? store.observations : {};
  const binding = store.binding || {};
  const accepted = observations.acceptedUserRow;
  const acceptedRow = Array.isArray(accepted?.rows) ? accepted.rows[0] : null;
  const expectedMarkerSha256 = portableEvidenceSha256(phase.providerMarker);
  const expectedPhaseNonceSha256 = portableEvidenceSha256(phase.phaseNonce);
  if (accepted?.state !== 'present'
    || accepted?.rowCount !== 1
    || !Array.isArray(accepted?.rows)
    || accepted.rows.length !== 1
    || accepted?.providerMarkerCount !== 1
    || accepted?.providerMarkerSha256 !== expectedMarkerSha256
    || accepted?.phaseNonceSha256 !== expectedPhaseNonceSha256
    || acceptedRow?.role !== 'user'
    || acceptedRow?.providerMarkerCount !== 1) {
    behaviorIssues.push('accepted_user_row_marker_join_failed');
  }
  const assistantRow = Array.isArray(observations.assistantReplies?.rows)
    ? observations.assistantReplies.rows[0]
    : null;
  if (observations.assistantReplies?.state !== 'present'
    || observations.assistantReplies?.rowCount !== 1
    || !Array.isArray(observations.assistantReplies?.rows)
    || observations.assistantReplies.rows.length !== 1) {
    behaviorIssues.push('exact_assistant_reply_missing_or_ambiguous');
  } else if (assistantRow?.role !== 'assistant'
    || !Number.isSafeInteger(assistantRow?.displayedText?.characters)
    || assistantRow.displayedText.characters <= 0
    || !SHA256_RE.test(String(assistantRow?.displayedText?.sha256 || ''))) {
    behaviorIssues.push('assistant_reply_not_visibly_observed');
  }
  if (observations.turn?.state !== 'present' || observations.turn?.rowCount !== 1) {
    internalIssues.push('exact_action_turn_missing_or_ambiguous');
  }
  if (observations.conversation?.state !== 'present' || observations.conversation?.rowCount !== 1) {
    internalIssues.push('exact_conversation_missing_or_ambiguous');
  }
  internalIssues.push(...collectObservationStateIssues(observations));
  if (Array.isArray(store.structuralIssues) && store.structuralIssues.length > 0) {
    internalIssues.push(...store.structuralIssues.map(issue => `collector:${String(issue)}`));
  }
  for (const [name, observation] of Object.entries(observations)) {
    if (!Array.isArray(observation?.rows)) continue;
    internalIssues.push(...rowIdentityIssues(observation.rows, binding, name));
  }

  const turn = observations.turn?.state === 'present' ? observations.turn.rows?.[0] : null;
  const task = observations.task;
  if (turn && String(turn.taskId || '')) {
    if (task?.state !== 'present' || task?.rowCount !== 1
      || task.rows?.[0]?.taskId !== turn.taskId) {
      internalIssues.push('turn_task_reference_unresolved');
    }
  } else if (turn && task?.state !== 'cleared') {
    internalIssues.push('cleared_turn_task_state_mismatch');
  }
  const taskId = task?.state === 'present' ? String(task.rows?.[0]?.taskId || '') : '';
  if (observations.livePointer?.state === 'present') {
    if (!taskId) internalIssues.push('live_pointer_without_task');
    else if (observations.livePointer.taskId !== taskId) {
      internalIssues.push('live_pointer_task_mismatch');
    }
    if (observations.livePointer.requestId
      && observations.livePointer.requestId !== binding.requestId) {
      internalIssues.push('live_pointer_request_mismatch');
    }
  }
  if (observations.pending?.state === 'present') {
    const mismatched = (observations.pending.rows || []).some(row => row.status === 'pending'
      && ((!taskId || !row.taskId || row.taskId !== taskId)
        || (row.originRequestId && row.originRequestId !== binding.requestId)));
    if (mismatched) internalIssues.push('pending_task_mismatch');
  }
  if (observations.routing?.state !== 'present' && phase.requirements.providerWitness) {
    internalIssues.push('routing_receipt_missing');
  } else if (observations.routing?.state === 'present') {
    const badRouting = (observations.routing.rows || []).some(row => (
      row.status !== 'succeeded'
      || (row.requestId && row.requestId !== binding.requestId)
      || (row.conversationId && row.conversationId !== binding.conversationId)
    ));
    if (badRouting) internalIssues.push('routing_receipt_unsuccessful_or_mismatched');
  }
  const routingModels = observations.routing?.state === 'present'
    ? uniqueSorted((observations.routing.rows || [])
        .map(row => String(row.selectedModel || '').trim())
        .filter(Boolean))
    : [];
  if (phase.requirements.providerWitness && routingModels.length === 0) {
    internalIssues.push('routing_selected_model_missing');
  }

  const receiptRows = observations.receipts?.state === 'present'
    ? observations.receipts.rows || []
    : [];
  const matchingTools = phase.expectedToolName
    ? receiptRows.filter(row => row.toolName === phase.expectedToolName
      && row.requestId === binding.requestId
      && row.conversationId === binding.conversationId
      && !['failed', 'blocked'].includes(String(row.outcome || '')))
    : [];
  const expectedToolObserved = !phase.expectedToolName || matchingTools.length > 0;
  if (!expectedToolObserved) behaviorIssues.push('expected_tool_receipt_missing');

  return {
    evidenceIssues: uniqueSorted(evidenceIssues),
    behaviorIssues: uniqueSorted(behaviorIssues),
    internalIssues: uniqueSorted(internalIssues),
    expectedToolObserved,
    routingModels,
  };
}

function recomputeProviderPhase(records, phase, manifest, key, seenNonces, seenOrdinals) {
  const evidenceIssues = [];
  const behaviorIssues = [];
  const models = [];
  const expectedMarkerSha256 = portableEvidenceSha256(phase.providerMarker);
  const expectedPhaseNonceSha256 = portableEvidenceSha256(phase.phaseNonce);
  if (phase.requirements.providerWitness && records.length === 0) {
    evidenceIssues.push('provider_capture_missing');
  }
  for (const [index, record] of records.entries()) {
    const validation = validatePortableEvidenceDocument(record, key, manifest);
    if (!validation.ok) {
      evidenceIssues.push(...validation.issues.map(issue => `provider[${index}]:${issue}`));
    }
    if (record?.kind !== PORTABLE_PROVIDER_CAPTURE_KIND || record?.schemaVersion !== 1) {
      evidenceIssues.push(`provider[${index}]:schema_invalid`);
    }
    if (record?.captureOrigin !== 'portable_external_provider_boundary'
      || !validIsoTimestamp(record?.capturedAt)
      || !Number.isSafeInteger(record?.bodyBytes)
      || record.bodyBytes <= 0
      || !SHA256_RE.test(String(record?.bodySha256 || ''))
      || !Number.isSafeInteger(record?.messageCount)
      || record.messageCount <= 0
      || !SHA256_RE.test(String(record?.messagesSha256 || ''))
      || !Number.isSafeInteger(record?.matchedUserMessageIndex)
      || record.matchedUserMessageIndex < 0
      || !Number.isSafeInteger(record?.latestUserMessageIndex)
      || record.latestUserMessageIndex < 0
      || record.matchedUserMessageIndex >= record.messageCount
      || record.latestUserMessageIndex >= record.messageCount) {
      evidenceIssues.push(`provider[${index}]:capture_metadata_invalid`);
    }
    const markerCardinalityKeys = isPlainObject(record?.markerCardinality)
      ? Object.keys(record.markerCardinality).sort()
      : [];
    if (record?.matchedUserMessageIndex !== record?.latestUserMessageIndex
      || markerCardinalityKeys.join('\0')
        !== ['latestUserMessage', 'portablePayload', 'selectedPhasePayload'].join('\0')
      || record?.markerCardinality?.portablePayload !== 1
      || record?.markerCardinality?.selectedPhasePayload !== 1
      || record?.markerCardinality?.latestUserMessage !== 1) {
      evidenceIssues.push(`provider[${index}]:marker_cardinality_or_latest_user_invalid`);
    }
    if (record?.modelInvoked !== true) behaviorIssues.push(`provider[${index}]:model_not_invoked`);
    const nonce = String(record?.providerRequestNonce || '');
    if (!SAFE_NONCE_RE.test(nonce) || seenNonces.has(nonce)) {
      evidenceIssues.push(`provider[${index}]:nonce_duplicate_or_invalid`);
    }
    else seenNonces.add(nonce);
    const ordinal = Number(record?.captureOrdinal);
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0 || seenOrdinals.has(ordinal)) {
      evidenceIssues.push(`provider[${index}]:ordinal_duplicate_or_invalid`);
    } else seenOrdinals.add(ordinal);
    if (record?.providerMarkerSha256 !== expectedMarkerSha256
      || record?.phaseNonceSha256 !== expectedPhaseNonceSha256
      || !Array.isArray(record?.observedPhaseBindingDigests)
      || stablePortableEvidenceJson(record.observedPhaseBindingDigests)
        !== stablePortableEvidenceJson([phase.bindingDigest])) {
      evidenceIssues.push(`provider[${index}]:phase_marker_binding_failed`);
    }
    if (phase.expectedToolName
      && (!Array.isArray(record?.declaredTools)
        || !record.declaredTools.includes(phase.expectedToolName))) {
      behaviorIssues.push(`provider[${index}]:expected_tool_not_declared`);
    }
    const model = String(record?.model || '').trim();
    if (!model) behaviorIssues.push(`provider[${index}]:model_missing`);
    else models.push(model);
  }
  return {
    evidenceIssues: uniqueSorted(evidenceIssues),
    behaviorIssues: uniqueSorted(behaviorIssues),
    models: uniqueSorted(models),
  };
}

function validateAndRecomputeBundle(bundle, manifest, key, role) {
  const documentIssues = [];
  if (!verifyPortableEvidenceRecord(bundle, key)) documentIssues.push(`${role}_bundle_attestation_invalid`);
  if (bundle?.kind !== PORTABLE_EVIDENCE_BUNDLE_KIND || bundle?.schemaVersion !== 1) {
    documentIssues.push(`${role}_bundle_schema_invalid`);
  }
  if (bundle?.manifestDigest !== manifest.manifestDigest
    || bundle?.runId !== manifest.runId
    || bundle?.role !== role
    || bundle?.buildIdentityDigest !== manifest.buildIdentityDigest
    || bundle?.profileSha256 !== manifest.profileSha256
    || bundle?.collectorBundleSha256 !== manifest.collectorBundleSha256
    || bundle?.fixturePlanSha256 !== manifest.fixturePlanSha256
    || bundle?.dataRootIdentitySha256 !== manifest.dataRootIdentitySha256
    || stablePortableEvidenceJson(bundle?.timeoutPolicy) !== stablePortableEvidenceJson(manifest.timeoutPolicy)
    || bundle?.platform !== manifest.platform
    || bundle?.nodeMajor !== manifest.nodeMajor) {
    documentIssues.push(`${role}_bundle_manifest_binding_invalid`);
  }
  if (bundle?.selectionPolicy !== 'exact_phase_request_nonce_only_no_latest_wins') {
    documentIssues.push(`${role}_bundle_selection_policy_invalid`);
  }
  if (!validIsoTimestamp(bundle?.createdAt)) {
    documentIssues.push(`${role}_bundle_created_at_invalid`);
  }
  const inputPhases = Array.isArray(bundle?.phaseEvidence) ? bundle.phaseEvidence : [];
  const byDigest = new Map();
  for (const item of inputPhases) {
    const digest = String(item?.bindingDigest || '');
    if (!digest || byDigest.has(digest)) documentIssues.push(`${role}_bundle_phase_duplicate_or_invalid`);
    else byDigest.set(digest, item);
  }
  const expectedDigests = new Set(manifest.phases.map(phase => phase.bindingDigest));
  if ([...byDigest.keys()].some(digest => !expectedDigests.has(digest))) {
    documentIssues.push(`${role}_bundle_unknown_phase`);
  }
  const seenNonces = new Set();
  const seenOrdinals = new Set();
  const phases = manifest.phases.map(phase => {
    const input = byDigest.get(phase.bindingDigest);
    if (!input) {
      return {
        key: phaseKey(phase),
        scenarioId: phase.scenarioId,
        phaseId: phase.phaseId,
        evidenceValid: false,
        behaviorPassed: false,
        internalIntegrityPassed: false,
        evidenceIssues: ['phase_evidence_missing'],
        behaviorIssues: [],
        internalIssues: [],
        models: [],
      };
    }
    const expectedSelector = {
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: phase.requestId,
      phaseNonce: phase.phaseNonce,
    };
    const selectorIssue = stablePortableEvidenceJson(input.selector)
      === stablePortableEvidenceJson(expectedSelector)
      ? []
      : ['phase_selector_binding_invalid'];
    const providerCapturesValid = Array.isArray(input.providerCaptures);
    const store = recomputeStorePhase(input.storeSnapshot, phase, manifest, key);
    const provider = recomputeProviderPhase(
      providerCapturesValid ? input.providerCaptures : [],
      phase,
      manifest,
      key,
      seenNonces,
      seenOrdinals,
    );
    const declaredIssues = Array.isArray(input.issues)
      ? input.issues.map(issue => `phase_declared:${String(issue)}`)
      : ['phase_declared:issues_invalid'];
    const evidenceIssues = uniqueSorted([
      ...store.evidenceIssues,
      ...provider.evidenceIssues,
      ...(providerCapturesValid ? [] : ['provider_captures_invalid']),
      ...selectorIssue,
      ...declaredIssues,
    ]);
    const behaviorIssues = uniqueSorted([...store.behaviorIssues, ...provider.behaviorIssues]);
    const internalIssues = uniqueSorted([
      ...store.internalIssues,
      ...(phase.requirements.passiveStore
        && phase.requirements.providerWitness
        && store.routingModels.some(model => !provider.models.includes(model))
        ? ['provider_routing_model_mismatch']
        : []),
    ]);
    return {
      key: phaseKey(phase),
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      evidenceValid: evidenceIssues.length === 0,
      behaviorPassed: evidenceIssues.length === 0 && behaviorIssues.length === 0,
      internalIntegrityPassed: evidenceIssues.length === 0 && internalIssues.length === 0,
      evidenceIssues,
      behaviorIssues,
      internalIssues,
      models: provider.models,
      routingModels: store.routingModels,
    };
  });
  if (inputPhases.length !== manifest.phases.length) {
    documentIssues.push(`${role}_bundle_phase_coverage_count_mismatch`);
  }
  if (phases.some(phase => !phase.evidenceValid)) {
    documentIssues.push(`${role}_bundle_phase_evidence_invalid`);
  }
  return {
    documentValid: documentIssues.length === 0 && phases.every(phase => phase.evidenceValid),
    documentIssues: uniqueSorted(documentIssues),
    phases,
    modelStubSet: uniqueSorted(phases.flatMap(phase => phase.models)),
  };
}

function parityComparison(baselineManifest, candidateManifest, baselineModels, candidateModels) {
  const issues = [];
  const exactFields = [
    'profileSha256',
    'collectorBundleSha256',
    'fixturePlanSha256',
    'platform',
    'nodeMajor',
  ];
  for (const field of exactFields) {
    if (baselineManifest[field] !== candidateManifest[field]) issues.push(`${field}_parity_mismatch`);
  }
  if (stablePortableEvidenceJson(baselineManifest.timeoutPolicy)
    !== stablePortableEvidenceJson(candidateManifest.timeoutPolicy)) {
    issues.push('timeout_policy_parity_mismatch');
  }
  const baselineCoverage = coverageContract(baselineManifest);
  const candidateCoverage = coverageContract(candidateManifest);
  if (stablePortableEvidenceJson(baselineCoverage) !== stablePortableEvidenceJson(candidateCoverage)) {
    issues.push('coverage_parity_mismatch');
  }
  if (stablePortableEvidenceJson(baselineModels) !== stablePortableEvidenceJson(candidateModels)) {
    issues.push('model_stub_set_parity_mismatch');
  }
  if (baselineManifest.phases.some(phase => phase.requirements.providerWitness)
    && (baselineModels.length === 0 || candidateModels.length === 0)) {
    issues.push('model_stub_set_missing');
  }
  return {
    passed: issues.length === 0,
    issues,
    profileSha256: baselineManifest.profileSha256,
    collectorBundleSha256: baselineManifest.collectorBundleSha256,
    fixturePlanSha256: baselineManifest.fixturePlanSha256,
    coverageSha256: portableEvidenceSha256(baselineCoverage),
    timeoutPolicySha256: portableEvidenceSha256(baselineManifest.timeoutPolicy),
    platform: baselineManifest.platform,
    nodeMajor: baselineManifest.nodeMajor,
    baselineModelStubSet: baselineModels,
    candidateModelStubSet: candidateModels,
  };
}

function adjudicateFormalNative(record, key, candidateManifest, candidateBuild) {
  if (record === undefined || record === null) {
    return { passed: 'not_run', issues: ['formal_native_evidence_missing'], checks: [] };
  }
  const issues = [];
  if (!verifyPortableEvidenceRecord(record, key)) issues.push('formal_native_attestation_invalid');
  let normalized = null;
  try {
    normalized = normalizeFormalNativeCore(record);
  } catch {
    issues.push('formal_native_evidence_invalid');
  }
  if (!normalized) return { passed: false, issues, checks: [] };
  if (normalized.buildIdentityDigest !== candidateBuild.buildIdentityDigest
    || normalized.profileSha256 !== candidateManifest.profileSha256) {
    issues.push('formal_native_candidate_binding_invalid');
  }
  if (issues.length > 0) {
    return { passed: false, issues: uniqueSorted(issues), checks: normalized.checks };
  }
  if (normalized.executionStatus === 'not_run') {
    return { passed: 'not_run', issues: [], checks: normalized.checks };
  }
  const checksById = new Map(normalized.checks.map(check => [check.id, check]));
  const recomputedChecks = uniqueSorted([
    ...REQUIRED_FORMAL_NATIVE_CHECKS,
    ...normalized.checks.map(check => check.id),
  ]).map(id => {
    const check = checksById.get(id);
    return {
      id,
      passed: Boolean(check && check.status === 'passed' && check.observed === true
        && SHA256_RE.test(check.evidenceSha256)),
      status: check?.status || 'missing',
    };
  });
  if (recomputedChecks.some(check => !check.passed)) issues.push('formal_native_required_check_failed');
  return {
    passed: issues.length === 0 && recomputedChecks.every(check => check.passed),
    issues: uniqueSorted(issues),
    checks: recomputedChecks,
  };
}

export function comparePortableEvidencePairs(input, options = {}) {
  const baselineManifestResult = validateSignedManifest(
    input?.baseline?.manifest,
    input?.baseline?.hmacKey,
    'baseline',
  );
  const candidateManifestResult = validateSignedManifest(
    input?.candidate?.manifest,
    input?.candidate?.hmacKey,
    'candidate',
  );
  const comparisonIssues = [
    ...baselineManifestResult.issues,
    ...candidateManifestResult.issues,
  ];
  if (!baselineManifestResult.manifest || !candidateManifestResult.manifest) {
    return {
      kind: PORTABLE_EVIDENCE_COMPARISON_KIND,
      schemaVersion: PORTABLE_EVIDENCE_COMPARISON_SCHEMA_VERSION,
      comparedAt: new Date(options.comparedAt || Date.now()).toISOString(),
      comparisonValid: false,
      comparisonIssues: uniqueSorted(comparisonIssues),
      portableBehaviorPassed: false,
      candidateInternalIntegrityPassed: false,
      formalNativePassed: 'not_run',
      releaseEligible: false,
    };
  }
  const baselineManifest = baselineManifestResult.manifest;
  const candidateManifest = candidateManifestResult.manifest;
  const baselineBuildResult = validateSignedBuildIdentity(
    input?.baseline?.buildIdentity,
    input?.baseline?.hmacKey,
    'baseline',
    baselineManifest,
  );
  const candidateBuildResult = validateSignedBuildIdentity(
    input?.candidate?.buildIdentity,
    input?.candidate?.hmacKey,
    'candidate',
    candidateManifest,
  );
  comparisonIssues.push(...baselineBuildResult.issues, ...candidateBuildResult.issues);
  const baselineBuild = baselineBuildResult.identity;
  const candidateBuild = candidateBuildResult.identity;
  if (baselineBuild?.sourceDirty !== false) comparisonIssues.push('clean_baseline_required');
  if (baselineBuild && candidateBuild) {
    if (baselineBuild.buildIdentityDigest === candidateBuild.buildIdentityDigest
      || (baselineBuild.sourceFingerprintSha256 === candidateBuild.sourceFingerprintSha256
        && baselineBuild.runtimeFingerprintSha256 === candidateBuild.runtimeFingerprintSha256)) {
      comparisonIssues.push('distinct_build_identities_required');
    }
  }

  const baselineBundle = validateAndRecomputeBundle(
    input?.baseline?.bundle,
    baselineManifest,
    input?.baseline?.hmacKey,
    'baseline',
  );
  const candidateBundle = validateAndRecomputeBundle(
    input?.candidate?.bundle,
    candidateManifest,
    input?.candidate?.hmacKey,
    'candidate',
  );
  comparisonIssues.push(...baselineBundle.documentIssues, ...candidateBundle.documentIssues);
  const parity = parityComparison(
    baselineManifest,
    candidateManifest,
    baselineBundle.modelStubSet,
    candidateBundle.modelStubSet,
  );
  comparisonIssues.push(...parity.issues);

  const phaseComparisons = coverageContract(candidateManifest).map(contract => {
    const key = `${contract.scenarioId}/${contract.phaseId}`;
    const baseline = baselineBundle.phases.find(phase => phase.key === key);
    const candidate = candidateBundle.phases.find(phase => phase.key === key);
    const baselinePassed = baseline?.behaviorPassed === true;
    const candidatePassed = candidate?.behaviorPassed === true;
    let delta = 'unchanged_fail';
    if (baselinePassed && candidatePassed) delta = 'unchanged_pass';
    else if (!baselinePassed && candidatePassed) delta = 'improved';
    else if (baselinePassed && !candidatePassed) delta = 'regressed';
    return { key, baselinePassed, candidatePassed, delta, baseline, candidate };
  });
  const comparisonValid = comparisonIssues.length === 0
    && baselineManifestResult.valid
    && candidateManifestResult.valid
    && baselineBuildResult.valid
    && candidateBuildResult.valid
    && baselineBundle.documentValid
    && candidateBundle.documentValid
    && parity.passed;
  const portableBehaviorPassed = comparisonValid
    && phaseComparisons.length > 0
    && phaseComparisons.every(phase => phase.candidatePassed);
  const candidateInternalIntegrityPassed = candidateBuildResult.valid
    && candidateBundle.documentValid
    && candidateBundle.phases.length > 0
    && candidateBundle.phases.every(phase => phase.internalIntegrityPassed);
  const formalNative = candidateBuild
    ? adjudicateFormalNative(
        input?.candidate?.formalNativeEvidence,
        input?.candidate?.hmacKey,
        candidateManifest,
        candidateBuild,
      )
    : { passed: 'not_run', issues: ['candidate_build_identity_invalid'], checks: [] };

  const releaseBlockers = [];
  if (!portableBehaviorPassed) releaseBlockers.push('portable_behavior_not_passed');
  if (!candidateInternalIntegrityPassed) releaseBlockers.push('candidate_internal_integrity_not_passed');
  if (formalNative.passed === 'not_run') releaseBlockers.push('formal_native_not_run');
  else if (formalNative.passed !== true) releaseBlockers.push('formal_native_not_passed');
  if (candidateBuild?.sourceDirty !== false) releaseBlockers.push('candidate_clean_build_required_for_release');
  if (!comparisonValid) releaseBlockers.push('portable_comparison_invalid');
  const releaseEligible = releaseBlockers.length === 0;

  return {
    kind: PORTABLE_EVIDENCE_COMPARISON_KIND,
    schemaVersion: PORTABLE_EVIDENCE_COMPARISON_SCHEMA_VERSION,
    comparedAt: new Date(options.comparedAt || Date.now()).toISOString(),
    decisionSource: 'recomputed_from_signed_phase_evidence_not_input_passed_flags',
    comparisonValid,
    comparisonIssues: uniqueSorted(comparisonIssues),
    parity,
    baseline: {
      manifestDigest: baselineManifest.manifestDigest,
      buildIdentity: baselineBuild,
      documentValid: baselineBundle.documentValid,
      modelStubSet: baselineBundle.modelStubSet,
    },
    candidate: {
      manifestDigest: candidateManifest.manifestDigest,
      buildIdentity: candidateBuild,
      documentValid: candidateBundle.documentValid,
      modelStubSet: candidateBundle.modelStubSet,
    },
    phaseComparisons,
    portableBehaviorPassed,
    candidateInternalIntegrityPassed,
    formalNativePassed: formalNative.passed,
    formalNative,
    releaseEligible,
    releaseBlockers: uniqueSorted(releaseBlockers),
  };
}
