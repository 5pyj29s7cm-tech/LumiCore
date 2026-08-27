import {
  PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
  normalizePortableEvidenceManifest,
  normalizePortableServerTruthSigner,
  phaseBindingFromManifest,
  portableEvidenceHmacKeyId,
  portableEvidenceSha256,
  stablePortableEvidenceJson,
} from './portable-external-evidence.mjs';
import {
  PORTABLE_BUILD_IDENTITY_KIND,
  createSignedPortableBuildIdentity,
} from './portable-evidence-comparison.mjs';
import {
  TASK_REGRESSION_BUILD_IDENTITY_KIND,
  taskRegressionBuildIdentityDigest,
  validateTaskRegressionBuildIdentity,
} from './task-regression-matrix.mjs';

export const PORTABLE_PAIRED_RUN_PLAN_KIND = 'lumi.portable-paired-run-plan';
export const PORTABLE_PAIRED_RUN_PLAN_SCHEMA_VERSION = 1;
export const PORTABLE_TASK_REGRESSION_BUILD_PROJECTION_KIND =
  'lumi.portable-task-regression-build-projection';

const ROLES = Object.freeze(['baseline', 'candidate']);
const PORTABLE_MARKER_PREFIX = '[[LUMI_PORTABLE_EVIDENCE_V1:';
const PORTABLE_MARKER_RE = /\[\[LUMI_PORTABLE_EVIDENCE_V1:[^\]\r\n]{1,512}\]\]/gu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const MAX_TURN_ORDINAL = 10_000;

export const PORTABLE_PAIRED_RUNNER_HOOK_CONTRACT = deepFreeze({
  kind: 'lumi.portable-paired-runner-hook-contract',
  schemaVersion: 1,
  integrationPoints: [
    {
      id: 'after_exact_bindings_before_first_user_turn',
      input: [
        'role', 'taskRegressionBuildIdentity', 'hmacKey', 'isolatedDataRootIdentity',
        'userId', 'conversationId', 'explicitPhasePlan',
      ],
      output: ['signedPortableBuildIdentity', 'normalizedPortableManifest'],
      sideEffects: 'none_in_library',
    },
    {
      id: 'before_user_turn_emit',
      input: ['role', 'exactPhaseSelector', 'turnOrdinal', 'userText'],
      output: ['userTextWithExactlyOneProviderMarker'],
      sideEffects: 'runner_emits_returned_text_only',
    },
    {
      id: 'at_raw_provider_dispatch_boundary',
      input: ['role', 'rawProviderPayload'],
      output: ['uniqueExactPhaseSelectorOrFailClosed'],
      sideEffects: 'runner_passes_match_to_portable_collector',
    },
    {
      id: 'after_scenarios_before_sandbox_cleanup',
      input: ['role', 'normalizedPortableManifest', 'isolatedDataRoot'],
      output: ['passiveStoreSnapshots', 'signedPortableBundle'],
      sideEffects: 'existing_read_only_probe_and_collector_only',
    },
  ],
});

export class PortablePairedRunnerError extends Error {
  constructor(code, details = {}, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'PortablePairedRunnerError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details, cause) {
  throw new PortablePairedRunnerError(code, details, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exactKeys(value, allowed, required, code) {
  if (!isPlainObject(value)) fail(code);
  const keys = Object.keys(value).sort();
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    fail(code, { keys });
  }
  return value;
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  if (!ROLES.includes(role)) fail('portable_paired_role_invalid');
  return role;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function phaseSelector(phase) {
  return {
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  };
}

function coverageProjection(manifest, phasePlan) {
  return manifest.phases.map((phase, index) => ({
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    turnOrdinal: phasePlan[index].turnOrdinal,
    unmarkedUserTextSha256: phasePlan[index].unmarkedUserTextSha256,
    expectedToolName: phase.expectedToolName,
    requirements: phase.requirements,
  }));
}

function normalizeTurnOrdinal(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TURN_ORDINAL) fail(code);
  return value;
}

function normalizeUnmarkedUserTextSha256(value, code) {
  const digest = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(digest)) fail(code);
  return digest;
}

function normalizeParityInput(input) {
  const value = exactKeys(
    input,
    [
      'profileSha256', 'collectorBundleSha256', 'fixturePlanSha256',
      'timeoutPolicy', 'platform', 'nodeMajor',
    ],
    [
      'profileSha256', 'collectorBundleSha256', 'fixturePlanSha256',
      'timeoutPolicy', 'platform', 'nodeMajor',
    ],
    'portable_paired_parity_invalid',
  );
  return {
    profileSha256: value.profileSha256,
    collectorBundleSha256: value.collectorBundleSha256,
    fixturePlanSha256: value.fixturePlanSha256,
    timeoutPolicy: value.timeoutPolicy,
    platform: value.platform,
    nodeMajor: value.nodeMajor,
  };
}

function normalizeSideHeader(input, role) {
  const value = exactKeys(
    input,
    [
      'runId', 'buildIdentityDigest', 'dataRootIdentitySha256', 'hmacKeyId',
      'serverTruthSigner',
    ],
    ['runId', 'buildIdentityDigest', 'dataRootIdentitySha256', 'hmacKeyId'],
    `portable_paired_${role}_header_invalid`,
  );
  if (!SHA256_RE.test(String(value.hmacKeyId || ''))) {
    fail(`portable_paired_${role}_hmac_key_id_invalid`);
  }
  const serverTruthSigner = value.serverTruthSigner === undefined
    ? null
    : normalizePortableServerTruthSigner(value.serverTruthSigner);
  if (serverTruthSigner && (
    serverTruthSigner.acceptanceRunId !== value.runId
    || serverTruthSigner.buildIdentityDigest !== value.buildIdentityDigest
    || serverTruthSigner.dataRootIdentitySha256 !== value.dataRootIdentitySha256
  )) fail(`portable_paired_${role}_server_truth_signer_binding_invalid`);
  return {
    ...value,
    ...(serverTruthSigner ? { serverTruthSigner } : {}),
  };
}

function normalizePhasePlanItem(input, index) {
  const value = exactKeys(
    input,
    [
      'scenarioId', 'phaseId', 'turnOrdinal', 'unmarkedUserTextSha256',
      'expectedToolName', 'requirements',
      'baseline', 'candidate',
    ],
    [
      'scenarioId', 'phaseId', 'turnOrdinal', 'unmarkedUserTextSha256',
      'requirements', 'baseline', 'candidate',
    ],
    'portable_paired_phase_plan_invalid',
  );
  const requirements = exactKeys(
    value.requirements,
    ['passiveStore', 'providerWitness'],
    ['passiveStore', 'providerWitness'],
    'portable_paired_phase_requirements_invalid',
  );
  if (typeof requirements.passiveStore !== 'boolean'
    || typeof requirements.providerWitness !== 'boolean') {
    fail('portable_paired_phase_requirements_invalid', { index });
  }
  const bindings = {};
  for (const role of ROLES) {
    bindings[role] = exactKeys(
      value[role],
      ['requestId', 'phaseNonce', 'conversationId', 'userId', 'channelId'],
      ['requestId', 'phaseNonce', 'conversationId', 'userId'],
      `portable_paired_${role}_phase_binding_invalid`,
    );
  }
  return {
    scenarioId: value.scenarioId,
    phaseId: value.phaseId,
    turnOrdinal: normalizeTurnOrdinal(
      value.turnOrdinal,
      'portable_paired_phase_turn_ordinal_invalid',
    ),
    unmarkedUserTextSha256: normalizeUnmarkedUserTextSha256(
      value.unmarkedUserTextSha256,
      'portable_paired_phase_user_text_digest_invalid',
    ),
    expectedToolName: value.expectedToolName,
    requirements: {
      passiveStore: requirements.passiveStore,
      providerWitness: requirements.providerWitness,
    },
    baseline: { ...bindings.baseline },
    candidate: { ...bindings.candidate },
  };
}

function manifestInputForRole(parity, header, phasePlan, role) {
  return {
    kind: PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
    schemaVersion: 1,
    runId: header.runId,
    role,
    buildIdentityDigest: header.buildIdentityDigest,
    profileSha256: parity.profileSha256,
    collectorBundleSha256: parity.collectorBundleSha256,
    fixturePlanSha256: parity.fixturePlanSha256,
    timeoutPolicy: parity.timeoutPolicy,
    platform: parity.platform,
    nodeMajor: parity.nodeMajor,
    dataRootIdentitySha256: header.dataRootIdentitySha256,
    hmacKeyId: header.hmacKeyId,
    ...(header.serverTruthSigner ? { serverTruthSigner: header.serverTruthSigner } : {}),
    phases: phasePlan.map(item => ({
      scenarioId: item.scenarioId,
      phaseId: item.phaseId,
      expectedToolName: item.expectedToolName,
      requirements: item.requirements,
      ...item[role],
    })),
  };
}

/**
 * Build both normalized manifest cores from one explicit plan. No identifier,
 * nonce, marker, or phase is selected implicitly or generated at runtime.
 */
export function createPortablePairedManifestCores(input) {
  const value = exactKeys(
    input,
    ['parity', 'baseline', 'candidate', 'phases'],
    ['parity', 'baseline', 'candidate', 'phases'],
    'portable_paired_plan_invalid',
  );
  if (!Array.isArray(value.phases) || value.phases.length === 0) {
    fail('portable_paired_phase_plan_required');
  }
  const parity = normalizeParityInput(value.parity);
  const headers = {
    baseline: normalizeSideHeader(value.baseline, 'baseline'),
    candidate: normalizeSideHeader(value.candidate, 'candidate'),
  };
  if (String(headers.baseline.runId) === String(headers.candidate.runId)) {
    fail('portable_paired_distinct_run_ids_required');
  }
  if (String(headers.baseline.buildIdentityDigest)
    === String(headers.candidate.buildIdentityDigest)) {
    fail('portable_paired_distinct_build_identities_required');
  }
  if (String(headers.baseline.dataRootIdentitySha256)
    === String(headers.candidate.dataRootIdentitySha256)) {
    fail('portable_paired_distinct_data_roots_required');
  }
  const phasePlan = value.phases.map(normalizePhasePlanItem);
  const fixtureTurns = new Set();
  for (const phase of phasePlan) {
    const fixtureTurnKey = `${phase.scenarioId}\0${phase.turnOrdinal}`;
    if (fixtureTurns.has(fixtureTurnKey)) {
      fail('portable_paired_duplicate_scenario_turn_ordinal', {
        scenarioId: phase.scenarioId,
        turnOrdinal: phase.turnOrdinal,
      });
    }
    fixtureTurns.add(fixtureTurnKey);
  }
  let baselineManifest;
  let candidateManifest;
  try {
    baselineManifest = normalizePortableEvidenceManifest(
      manifestInputForRole(parity, headers.baseline, phasePlan, 'baseline'),
    );
    candidateManifest = normalizePortableEvidenceManifest(
      manifestInputForRole(parity, headers.candidate, phasePlan, 'candidate'),
    );
  } catch (cause) {
    fail('portable_paired_manifest_normalization_failed', undefined, cause);
  }
  const baselineCoverage = coverageProjection(baselineManifest, phasePlan);
  const candidateCoverage = coverageProjection(candidateManifest, phasePlan);
  if (stablePortableEvidenceJson(baselineCoverage)
    !== stablePortableEvidenceJson(candidateCoverage)) {
    fail('portable_paired_coverage_parity_failed');
  }
  const markerSet = new Set();
  const phasePairs = baselineManifest.phases.map((baselinePhase, index) => {
    const candidatePhase = candidateManifest.phases[index];
    if (baselinePhase.requestId === candidatePhase.requestId) {
      fail('portable_paired_cross_role_request_id_reuse');
    }
    if (baselinePhase.phaseNonce === candidatePhase.phaseNonce) {
      fail('portable_paired_cross_role_phase_nonce_reuse');
    }
    for (const marker of [baselinePhase.providerMarker, candidatePhase.providerMarker]) {
      if (markerSet.has(marker)) fail('portable_paired_provider_marker_collision');
      markerSet.add(marker);
    }
    return {
      key: `${baselinePhase.scenarioId}/${baselinePhase.phaseId}`,
      scenarioId: baselinePhase.scenarioId,
      phaseId: baselinePhase.phaseId,
      turnOrdinal: phasePlan[index].turnOrdinal,
      unmarkedUserTextSha256: phasePlan[index].unmarkedUserTextSha256,
      expectedToolName: baselinePhase.expectedToolName,
      requirements: baselinePhase.requirements,
      baseline: {
        selector: phaseSelector(baselinePhase),
        bindingDigest: baselinePhase.bindingDigest,
        providerMarker: baselinePhase.providerMarker,
      },
      candidate: {
        selector: phaseSelector(candidatePhase),
        bindingDigest: candidatePhase.bindingDigest,
        providerMarker: candidatePhase.providerMarker,
      },
    };
  });
  const coverageSha256 = portableEvidenceSha256(baselineCoverage);
  const paritySha256 = portableEvidenceSha256({ ...parity, coverageSha256 });
  return deepFreeze({
    kind: PORTABLE_PAIRED_RUN_PLAN_KIND,
    schemaVersion: PORTABLE_PAIRED_RUN_PLAN_SCHEMA_VERSION,
    paritySha256,
    coverageSha256,
    baselineManifest,
    candidateManifest,
    phasePairs,
  });
}

/**
 * Append the exact phase marker once after verifying the immutable fixture text.
 * The runner-facing hook separately verifies that the observed turn ordinal is
 * the one sealed into the canonical paired plan.
 */
export function appendPortablePhaseMarkerToUserText(
  manifestInput,
  selector,
  userText,
  fixtureBinding,
) {
  let resolved;
  try {
    resolved = phaseBindingFromManifest(manifestInput, selector);
  } catch (cause) {
    fail('portable_paired_phase_selector_unknown', undefined, cause);
  }
  if (typeof userText !== 'string' || !userText.trim()) {
    fail('portable_paired_user_text_required');
  }
  if (userText.includes(PORTABLE_MARKER_PREFIX)
    || resolved.manifest.phases.some(phase => userText.includes(phase.providerMarker))) {
    fail('portable_paired_user_text_already_marked');
  }
  const fixture = exactKeys(
    fixtureBinding,
    ['turnOrdinal', 'unmarkedUserTextSha256'],
    ['turnOrdinal', 'unmarkedUserTextSha256'],
    'portable_paired_user_turn_fixture_required',
  );
  const turnOrdinal = normalizeTurnOrdinal(
    fixture.turnOrdinal,
    'portable_paired_user_turn_ordinal_invalid',
  );
  const unmarkedUserTextSha256 = normalizeUnmarkedUserTextSha256(
    fixture.unmarkedUserTextSha256,
    'portable_paired_user_turn_text_digest_invalid',
  );
  const observedUserTextSha256 = portableEvidenceSha256(userText);
  if (observedUserTextSha256 !== unmarkedUserTextSha256) {
    fail('portable_paired_user_turn_text_digest_mismatch', {
      expected: unmarkedUserTextSha256,
      observed: observedUserTextSha256,
    });
  }
  const separator = userText.endsWith('\n') ? '\n' : '\n\n';
  const text = `${userText}${separator}${resolved.phase.providerMarker}`;
  const markerCounts = resolved.manifest.phases.map(phase => ({
    bindingDigest: phase.bindingDigest,
    count: countOccurrences(text, phase.providerMarker),
  }));
  if (markerCounts.find(item => item.bindingDigest === resolved.phase.bindingDigest)?.count !== 1
    || markerCounts.some(item => (
      item.bindingDigest !== resolved.phase.bindingDigest && item.count !== 0
    ))) {
    fail('portable_paired_user_text_marker_cardinality_invalid');
  }
  return deepFreeze({
    selector: phaseSelector(resolved.phase),
    bindingDigest: resolved.phase.bindingDigest,
    turnOrdinal,
    unmarkedUserTextSha256,
    providerMarkerSha256: portableEvidenceSha256(resolved.phase.providerMarker),
    phaseNonceSha256: portableEvidenceSha256(resolved.phase.phaseNonce),
    text,
  });
}

function providerPayload(input) {
  let bytes;
  let parsed;
  try {
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      bytes = Buffer.from(input);
      parsed = JSON.parse(bytes.toString('utf8'));
    } else if (typeof input === 'string') {
      bytes = Buffer.from(input, 'utf8');
      parsed = JSON.parse(input);
    } else if (isPlainObject(input)) {
      parsed = input;
      bytes = Buffer.from(stablePortableEvidenceJson(input), 'utf8');
    } else {
      fail('portable_paired_provider_payload_invalid');
    }
  } catch (cause) {
    if (cause instanceof PortablePairedRunnerError) throw cause;
    // JSON parser errors may embed a slice of the raw provider body. The
    // portable boundary records hashes only, so never retain that parser cause.
    fail('portable_paired_provider_payload_invalid');
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    fail('portable_paired_provider_messages_required');
  }
  return { bytes, parsed };
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return stablePortableEvidenceJson(content);
}

/**
 * Identify one exact phase from the raw provider boundary payload. A missing,
 * repeated, cross-phase, unknown, or non-user marker fails closed.
 */
export function matchPortableProviderPayloadPhase(manifestInput, rawPayload) {
  const manifest = normalizePortableEvidenceManifest(manifestInput);
  const { bytes, parsed } = providerPayload(rawPayload);
  const messagesJson = stablePortableEvidenceJson(parsed.messages);
  const candidates = manifest.phases.map(phase => ({
    phase,
    count: countOccurrences(messagesJson, phase.providerMarker),
  })).filter(item => item.count > 0);
  if (candidates.length === 0) fail('portable_paired_provider_phase_marker_missing');
  if (candidates.length !== 1) {
    fail('portable_paired_provider_phase_marker_ambiguous', {
      bindingDigests: candidates.map(item => item.phase.bindingDigest),
    });
  }
  const selected = candidates[0];
  if (selected.count !== 1) {
    fail('portable_paired_provider_phase_marker_repeated', { count: selected.count });
  }
  const markerTokens = messagesJson.match(PORTABLE_MARKER_RE) || [];
  if (markerTokens.length !== 1 || markerTokens[0] !== selected.phase.providerMarker) {
    fail('portable_paired_provider_unknown_or_extra_marker');
  }
  const userMatches = parsed.messages.map((message, index) => ({
    index,
    role: String(message?.role || ''),
    count: countOccurrences(messageContentText(message?.content), selected.phase.providerMarker),
  })).filter(item => item.count > 0);
  const markedInteractions = parsed.messages.map((message, index) => ({
    index,
    role: String(message?.role || ''),
    markerCount: (messageContentText(message?.content).match(PORTABLE_MARKER_RE) || []).length,
  })).filter(item => item.markerCount > 0);
  if (userMatches.length !== 1
    || userMatches[0].role !== 'user'
    || userMatches[0].count !== 1
    || markedInteractions.length !== 1
    || markedInteractions[0].index !== userMatches[0].index
    || markedInteractions[0].role !== 'user'
    || markedInteractions[0].markerCount !== 1) {
    fail('portable_paired_provider_marker_not_exact_user_interaction');
  }
  const latestUserMessageIndex = parsed.messages.reduce((latest, message, index) => (
    String(message?.role || '') === 'user' ? index : latest
  ), -1);
  if (userMatches[0].index !== latestUserMessageIndex) {
    fail('portable_paired_provider_marker_not_latest_user_message', {
      markedUserMessageIndex: userMatches[0].index,
      latestUserMessageIndex,
    });
  }
  const declaredTools = (Array.isArray(parsed.tools) ? parsed.tools : [])
    .map(tool => String(tool?.function?.name || tool?.name || '').trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return deepFreeze({
    selector: phaseSelector(selected.phase),
    bindingDigest: selected.phase.bindingDigest,
    providerMarkerSha256: portableEvidenceSha256(selected.phase.providerMarker),
    phaseNonceSha256: portableEvidenceSha256(selected.phase.phaseNonce),
    rawPayloadSha256: portableEvidenceSha256(bytes),
    messageCount: parsed.messages.length,
    matchedUserMessageIndex: userMatches[0].index,
    latestUserMessageIndex,
    model: String(parsed.model || ''),
    declaredTools: [...new Set(declaredTools)],
  });
}

/** Project an already-collected task-regression identity; never reads Git or a worktree. */
export function projectSignedPortableTaskRegressionBuildIdentity(
  taskRegressionIdentity,
  options = {},
) {
  const role = normalizeRole(options.role);
  const validation = validateTaskRegressionBuildIdentity(taskRegressionIdentity);
  if (!validation.ok) {
    fail('portable_paired_task_regression_build_identity_invalid', {
      issues: validation.issues,
    });
  }
  if (taskRegressionIdentity.kind !== TASK_REGRESSION_BUILD_IDENTITY_KIND) {
    fail('portable_paired_task_regression_build_identity_invalid');
  }
  if (role === 'baseline' && taskRegressionIdentity.sourceDirty !== false) {
    fail('portable_paired_clean_baseline_required');
  }
  const sourceBuildIdentityDigest = taskRegressionBuildIdentityDigest(taskRegressionIdentity);
  if (options.expectedTaskRegressionBuildIdentityDigest
    && String(options.expectedTaskRegressionBuildIdentityDigest).toLowerCase()
      !== sourceBuildIdentityDigest) {
    fail('portable_paired_task_regression_build_digest_mismatch');
  }
  const portableBuildIdentity = createSignedPortableBuildIdentity({
    kind: PORTABLE_BUILD_IDENTITY_KIND,
    schemaVersion: 1,
    role,
    revision: taskRegressionIdentity.revision,
    sourceDirty: taskRegressionIdentity.sourceDirty,
    sourceFingerprintSha256: taskRegressionIdentity.sourceFingerprintSha256,
    runtimeFingerprintSha256: taskRegressionIdentity.runtimeFingerprintSha256,
    collectedAt: taskRegressionIdentity.collectedAt,
  }, options.hmacKey);
  return deepFreeze({
    kind: PORTABLE_TASK_REGRESSION_BUILD_PROJECTION_KIND,
    schemaVersion: 1,
    role,
    sourceBuildIdentityDigest,
    portableBuildIdentity,
  });
}

function manifestRoleBinding(phase) {
  return {
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
    conversationId: phase.conversationId,
    userId: phase.userId,
    channelId: phase.channelId,
  };
}

function canonicalPortablePairedRunPlan(pairedPlan) {
  const value = exactKeys(
    pairedPlan,
    [
      'kind', 'schemaVersion', 'paritySha256', 'coverageSha256',
      'baselineManifest', 'candidateManifest', 'phasePairs',
    ],
    [
      'kind', 'schemaVersion', 'paritySha256', 'coverageSha256',
      'baselineManifest', 'candidateManifest', 'phasePairs',
    ],
    'portable_paired_run_plan_integrity_invalid',
  );
  if (value.kind !== PORTABLE_PAIRED_RUN_PLAN_KIND
    || value.schemaVersion !== PORTABLE_PAIRED_RUN_PLAN_SCHEMA_VERSION
    || !SHA256_RE.test(String(value.paritySha256 || ''))
    || !SHA256_RE.test(String(value.coverageSha256 || ''))
    || !Array.isArray(value.phasePairs)
    || value.phasePairs.length === 0) {
    fail('portable_paired_run_plan_integrity_invalid');
  }
  let baselineManifest;
  let candidateManifest;
  try {
    baselineManifest = normalizePortableEvidenceManifest(value.baselineManifest);
    candidateManifest = normalizePortableEvidenceManifest(value.candidateManifest);
  } catch (cause) {
    fail('portable_paired_run_plan_integrity_invalid', undefined, cause);
  }
  if (baselineManifest.phases.length !== value.phasePairs.length
    || candidateManifest.phases.length !== value.phasePairs.length) {
    fail('portable_paired_run_plan_integrity_invalid');
  }
  const phases = baselineManifest.phases.map((baselinePhase, index) => {
    const candidatePhase = candidateManifest.phases[index];
    const pair = exactKeys(
      value.phasePairs[index],
      [
        'key', 'scenarioId', 'phaseId', 'turnOrdinal', 'unmarkedUserTextSha256',
        'expectedToolName', 'requirements', 'baseline', 'candidate',
      ],
      [
        'key', 'scenarioId', 'phaseId', 'turnOrdinal', 'unmarkedUserTextSha256',
        'expectedToolName', 'requirements', 'baseline', 'candidate',
      ],
      'portable_paired_run_plan_integrity_invalid',
    );
    if (pair.key !== `${baselinePhase.scenarioId}/${baselinePhase.phaseId}`
      || pair.scenarioId !== baselinePhase.scenarioId
      || pair.phaseId !== baselinePhase.phaseId
      || candidatePhase.scenarioId !== baselinePhase.scenarioId
      || candidatePhase.phaseId !== baselinePhase.phaseId) {
      fail('portable_paired_run_plan_integrity_invalid');
    }
    return {
      scenarioId: baselinePhase.scenarioId,
      phaseId: baselinePhase.phaseId,
      turnOrdinal: normalizeTurnOrdinal(
        pair.turnOrdinal,
        'portable_paired_run_plan_integrity_invalid',
      ),
      unmarkedUserTextSha256: normalizeUnmarkedUserTextSha256(
        pair.unmarkedUserTextSha256,
        'portable_paired_run_plan_integrity_invalid',
      ),
      expectedToolName: baselinePhase.expectedToolName,
      requirements: baselinePhase.requirements,
      baseline: manifestRoleBinding(baselinePhase),
      candidate: manifestRoleBinding(candidatePhase),
    };
  });
  let canonical;
  try {
    canonical = createPortablePairedManifestCores({
      parity: {
        profileSha256: baselineManifest.profileSha256,
        collectorBundleSha256: baselineManifest.collectorBundleSha256,
        fixturePlanSha256: baselineManifest.fixturePlanSha256,
        timeoutPolicy: baselineManifest.timeoutPolicy,
        platform: baselineManifest.platform,
        nodeMajor: baselineManifest.nodeMajor,
      },
      baseline: {
        runId: baselineManifest.runId,
        buildIdentityDigest: baselineManifest.buildIdentityDigest,
        dataRootIdentitySha256: baselineManifest.dataRootIdentitySha256,
        hmacKeyId: baselineManifest.hmacKeyId,
        ...(baselineManifest.serverTruthSigner ? {
          serverTruthSigner: baselineManifest.serverTruthSigner,
        } : {}),
      },
      candidate: {
        runId: candidateManifest.runId,
        buildIdentityDigest: candidateManifest.buildIdentityDigest,
        dataRootIdentitySha256: candidateManifest.dataRootIdentitySha256,
        hmacKeyId: candidateManifest.hmacKeyId,
        ...(candidateManifest.serverTruthSigner ? {
          serverTruthSigner: candidateManifest.serverTruthSigner,
        } : {}),
      },
      phases,
    });
  } catch (cause) {
    if (cause instanceof PortablePairedRunnerError
      && cause.code === 'portable_paired_run_plan_integrity_invalid') throw cause;
    fail('portable_paired_run_plan_integrity_invalid', undefined, cause);
  }
  let suppliedJson;
  let canonicalJson;
  try {
    suppliedJson = stablePortableEvidenceJson(value);
    canonicalJson = stablePortableEvidenceJson(canonical);
  } catch (cause) {
    fail('portable_paired_run_plan_integrity_invalid', undefined, cause);
  }
  if (suppliedJson !== canonicalJson) {
    fail('portable_paired_run_plan_integrity_invalid', {
      suppliedSha256: portableEvidenceSha256(suppliedJson),
      canonicalSha256: portableEvidenceSha256(canonicalJson),
    });
  }
  return canonical;
}

function pairedFixtureForSelector(plan, role, selector) {
  let resolved;
  try {
    resolved = phaseBindingFromManifest(
      role === 'baseline' ? plan.baselineManifest : plan.candidateManifest,
      selector,
    );
  } catch (cause) {
    fail('portable_paired_phase_selector_unknown', undefined, cause);
  }
  const pair = plan.phasePairs.find(item => (
    item[role].bindingDigest === resolved.phase.bindingDigest
  ));
  if (!pair) fail('portable_paired_run_plan_integrity_invalid');
  return { pair, resolved };
}

/** A no-I/O adapter created only after every exact phase binding is known. */
export function createPortablePairedRunnerHooks(pairedPlan) {
  if (!isPlainObject(pairedPlan)
    || pairedPlan.kind !== PORTABLE_PAIRED_RUN_PLAN_KIND
    || pairedPlan.schemaVersion !== PORTABLE_PAIRED_RUN_PLAN_SCHEMA_VERSION) {
    fail('portable_paired_run_plan_invalid');
  }
  const canonicalPlan = canonicalPortablePairedRunPlan(pairedPlan);
  const manifests = {
    baseline: canonicalPlan.baselineManifest,
    candidate: canonicalPlan.candidateManifest,
  };
  return Object.freeze({
    contract: PORTABLE_PAIRED_RUNNER_HOOK_CONTRACT,
    manifestFor(roleInput) {
      return manifests[normalizeRole(roleInput)];
    },
    prepareUserTurn(input) {
      const role = normalizeRole(input?.role);
      const { pair } = pairedFixtureForSelector(canonicalPlan, role, input?.selector);
      if (input?.turnOrdinal !== pair.turnOrdinal) {
        fail('portable_paired_user_turn_ordinal_mismatch', {
          expected: pair.turnOrdinal,
          observed: input?.turnOrdinal,
        });
      }
      return appendPortablePhaseMarkerToUserText(
        manifests[role],
        input?.selector,
        input?.text,
        {
          turnOrdinal: pair.turnOrdinal,
          unmarkedUserTextSha256: pair.unmarkedUserTextSha256,
        },
      );
    },
    observeProviderPayload(input) {
      const role = normalizeRole(input?.role);
      return matchPortableProviderPayloadPhase(manifests[role], input?.payload);
    },
  });
}

/** Useful for callers sealing the manifest key id without exposing key bytes. */
export function portablePairedHmacKeyId(key) {
  return portableEvidenceHmacKeyId(key);
}
