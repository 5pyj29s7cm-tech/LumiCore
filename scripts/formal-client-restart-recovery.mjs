import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { io as createSocketClient } from 'socket.io-client';
import {
  DESKTOP_SESSION_HEADER,
  bootstrapDesktopTestSession,
} from './lib/desktop-bootstrap.mjs';
import {
  formalNativeClientIdentityFingerprint,
  selectFormalNativeClientEvidence,
} from './lib/formal-native-client-binding.mjs';
import {
  createFormalStage9FileBackedProducerEvidence,
  formalStage9ProducerEvidenceExitCode,
} from './lib/formal-stage9-producer-evidence.mjs';
import {
  E2EError,
  buildLifecycleTurnEvidence,
  buildOwnedArtifactLayout,
  cleanOwnedArtifactLayout,
  currentGitHead,
  evidenceTextHash,
  fetchJson,
  isLoopbackBaseUrl,
  isPathInside,
  openOwnedArtifactLayout,
  persistedMessages,
  pollRuntimeTaskByMarker,
  prepareOwnedArtifactLayout,
  requireCondition,
  runTurn,
  runtimeReceiptSignature,
  runtimeStatus,
  validateStatusQueryNoReplay,
  waitForSocketReady,
} from './formal-client-e2e.mjs';

const CHECKPOINT_SCHEMA_VERSION = 4;
const EVIDENCE_SCHEMA_VERSION = 2;
const RESTART_SCOPES = new Set(['backend-only', 'client-only', 'both']);
const BUILD_ID_RE = /^[a-f0-9]{7,64}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function usage() {
  return [
    'Formal Lumi restart-recovery E2E (safe two-stage protocol).',
    '',
    'Prepare:',
    '  node scripts/formal-client-restart-recovery.mjs prepare --confirm-live-e2e --data-root <absolute-path> \\',
    '    --restart-scope <backend-only|client-only|both> \\',
    '    --client-pid <pid> --client-start-at <iso> --client-build-id <sha> \\',
    '    --webview2-user-data-dir <absolute-path> --webview2-profile-dir <absolute-path>',
    '',
    'Then restart the Lumi service/client yourself. This script never restarts it.',
    '',
    'Verify:',
    '  node scripts/formal-client-restart-recovery.mjs verify --confirm-live-e2e --data-root <absolute-path> \\',
    '    --restart-scope <backend-only|client-only|both> \\',
    '    --client-pid <pid> --client-start-at <iso> --client-build-id <sha> \\',
    '    --webview2-user-data-dir <absolute-path> --webview2-profile-dir <absolute-path>',
    '',
    'Options:',
    '  --base-url <url>           default http://127.0.0.1:3000/api',
    '  --expected-build-id <sha>  default current git HEAD (prepare) or checkpoint build (verify)',
    '  --timeout-ms <ms>          default 180000',
    '  --checkpoint <abs-path>    default <evidence-root or data-root>/formal-client-e2e-restart-checkpoint.json',
    '  --evidence-root <abs-path> write a sanitized prepare/verify JSON record below this root',
    '  --cleanup-owned-after-verify  delete only the checkpoint-owned conversation, artifact directory, and checkpoint',
    '  --help',
    '',
    'Native-client CLI values are exact selection expectations only. Evidence comes from the',
    'authenticated /devices registry and must identify one clean, hashed, proof-bound Tauri client.',
    'The checkpoint and evidence contain no token, cookie, desktop proof, file payload, or tool result.',
  ].join('\n');
}

export function parseRestartRecoveryArgs(argv) {
  const mode = argv[0];
  const args = {
    mode,
    baseUrl: 'http://127.0.0.1:3000/api',
    dataRoot: '',
    checkpoint: '',
    evidenceRoot: '',
    expectedBuildId: '',
    restartScope: '',
    clientPid: 0,
    clientStartAt: '',
    clientBuildId: '',
    webview2UserDataDir: '',
    webview2ProfileDir: '',
    timeoutMs: 180_000,
    confirmed: false,
    cleanupOwnedAfterVerify: false,
    help: argv.includes('--help') || argv.includes('-h'),
  };
  if (args.help) return args;
  if (!['prepare', 'verify'].includes(mode)) throw new E2EError('restart_mode_required');
  const valueFlags = new Set([
    '--base-url',
    '--data-root',
    '--checkpoint',
    '--evidence-root',
    '--expected-build-id',
    '--restart-scope',
    '--client-pid',
    '--client-start-at',
    '--client-build-id',
    '--webview2-user-data-dir',
    '--webview2-profile-dir',
    '--timeout-ms',
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new E2EError('invalid_arguments');
      index += 1;
      if (flag === '--base-url') args.baseUrl = value;
      if (flag === '--data-root') args.dataRoot = value;
      if (flag === '--checkpoint') args.checkpoint = value;
      if (flag === '--evidence-root') args.evidenceRoot = value;
      if (flag === '--expected-build-id') args.expectedBuildId = value;
      if (flag === '--restart-scope') args.restartScope = value;
      if (flag === '--client-pid') args.clientPid = Number.parseInt(value, 10);
      if (flag === '--client-start-at') args.clientStartAt = value;
      if (flag === '--client-build-id') args.clientBuildId = value;
      if (flag === '--webview2-user-data-dir') args.webview2UserDataDir = value;
      if (flag === '--webview2-profile-dir') args.webview2ProfileDir = value;
      if (flag === '--timeout-ms') args.timeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (flag === '--confirm-live-e2e') args.confirmed = true;
    else if (flag === '--cleanup-owned-after-verify') args.cleanupOwnedAfterVerify = true;
    else throw new E2EError('invalid_arguments');
  }
  if (!args.confirmed) throw new E2EError('live_confirmation_required');
  if (!args.dataRoot || !path.isAbsolute(args.dataRoot)) throw new E2EError('absolute_data_root_required');
  if (!args.webview2UserDataDir || !path.isAbsolute(args.webview2UserDataDir)) {
    throw new E2EError('absolute_webview2_user_data_dir_required');
  }
  if (!args.webview2ProfileDir || !path.isAbsolute(args.webview2ProfileDir)) {
    throw new E2EError('absolute_webview2_profile_dir_required');
  }
  if (args.evidenceRoot && !path.isAbsolute(args.evidenceRoot)) {
    throw new E2EError('absolute_evidence_root_required');
  }
  if (args.checkpoint && !path.isAbsolute(args.checkpoint)) {
    throw new E2EError('absolute_checkpoint_required');
  }
  if (!isLoopbackBaseUrl(args.baseUrl)) throw new E2EError('loopback_api_required');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000 || args.timeoutMs > 900_000) {
    throw new E2EError('invalid_timeout');
  }
  args.baseUrl = String(args.baseUrl).replace(/\/$/, '');
  args.dataRoot = path.resolve(args.dataRoot);
  args.webview2UserDataDir = path.resolve(args.webview2UserDataDir);
  args.webview2ProfileDir = path.resolve(args.webview2ProfileDir);
  args.evidenceRoot = args.evidenceRoot ? path.resolve(args.evidenceRoot) : '';
  const checkpointRoot = args.evidenceRoot || args.dataRoot;
  args.checkpoint = path.resolve(args.checkpoint || path.join(checkpointRoot, 'formal-client-e2e-restart-checkpoint.json'));
  if (!isPathInside(checkpointRoot, args.checkpoint)) throw new E2EError('restart_checkpoint_outside_evidence_root');
  if (!isPathInside(args.webview2UserDataDir, args.webview2ProfileDir)) {
    throw new E2EError('webview2_profile_outside_user_data_dir');
  }
  if (!RESTART_SCOPES.has(args.restartScope)) throw new E2EError('restart_scope_required');
  if (args.cleanupOwnedAfterVerify && mode !== 'verify') {
    throw new E2EError('restart_cleanup_requires_verify');
  }
  const clientExpectation = normalizeProcessIdentity({
    pid: args.clientPid,
    startAt: args.clientStartAt,
    buildId: args.clientBuildId,
  });
  if (!isValidProcessIdentity(clientExpectation)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(clientExpectation.buildId)) {
    throw new E2EError('native_client_identity_required');
  }
  args.nativeClientExpectation = clientExpectation;
  args.locationBindings = buildFormalLocationBindings(args);
  return args;
}

function normalizePathForBinding(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function pathBinding(value) {
  return evidenceTextHash(normalizePathForBinding(value));
}

export function buildFormalLocationBindings({ dataRoot, webview2UserDataDir, webview2ProfileDir }) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) throw new E2EError('absolute_data_root_required');
  if (!webview2UserDataDir || !path.isAbsolute(webview2UserDataDir)) {
    throw new E2EError('absolute_webview2_user_data_dir_required');
  }
  if (!webview2ProfileDir || !path.isAbsolute(webview2ProfileDir)) {
    throw new E2EError('absolute_webview2_profile_dir_required');
  }
  const userDataDir = path.resolve(webview2UserDataDir);
  const profileDir = path.resolve(webview2ProfileDir);
  if (!isPathInside(userDataDir, profileDir)) throw new E2EError('webview2_profile_outside_user_data_dir');
  return {
    dataRootSha256: pathBinding(dataRoot),
    webview2UserDataDirSha256: pathBinding(userDataDir),
    webview2ProfileDirSha256: pathBinding(profileDir),
  };
}

export function normalizeProcessIdentity(value) {
  const parsedStartAt = new Date(String(value?.startAt || value?.startedAt || ''));
  return {
    pid: Math.max(0, Math.trunc(Number(value?.pid) || 0)),
    startAt: Number.isFinite(parsedStartAt.getTime()) ? parsedStartAt.toISOString() : '',
    buildId: String(value?.buildId || '').trim().toLowerCase(),
  };
}

export function normalizeFormalNativeClientEvidence(value) {
  const startedAtUnixMs = Math.max(0, Math.trunc(Number(value?.startedAtUnixMs) || 0));
  const parsedStartAt = new Date(String(value?.startedAt || value?.startAt || (
    startedAtUnixMs ? new Date(startedAtUnixMs).toISOString() : ''
  )));
  return {
    schemaVersion: Number(value?.schemaVersion || 0),
    clientKind: String(value?.clientKind || ''),
    deviceId: String(value?.deviceId || ''),
    pid: Math.max(0, Math.trunc(Number(value?.pid) || 0)),
    startedAtUnixMs,
    startAt: Number.isFinite(parsedStartAt.getTime()) ? parsedStartAt.toISOString() : '',
    executablePath: String(value?.executablePath || ''),
    executableSha256: String(value?.executableSha256 || '').trim().toLowerCase(),
    binaryHashUnavailable: value?.binaryHashUnavailable === true,
    buildId: String(value?.buildId || '').trim().toLowerCase(),
    buildIdSemantics: String(value?.buildIdSemantics || ''),
    sourceFingerprint: String(value?.sourceFingerprint || '').trim().toLowerCase(),
    sourceDirty: value?.sourceDirty === true,
    appVersion: String(value?.appVersion || ''),
    identityFingerprint: String(value?.identityFingerprint || '').trim().toLowerCase(),
    identitySource: String(value?.identitySource || ''),
    identityVerified: value?.identityVerified === true,
    registryStatus: String(value?.registryStatus || ''),
    trustLevel: String(value?.trustLevel || ''),
    osAttested: value?.osAttested === true,
    webviewProfileTrustLevel: String(value?.webviewProfileTrustLevel || ''),
    webviewProfileBound: value?.webviewProfileBound === true,
    formalAcceptanceEligible: value?.formalAcceptanceEligible === true,
  };
}

export function isValidFormalNativeClientEvidence(value) {
  const identity = normalizeFormalNativeClientEvidence(value);
  const executablePathValid = path.isAbsolute(identity.executablePath)
    || path.win32.isAbsolute(identity.executablePath);
  return identity.schemaVersion === 1
    && identity.clientKind === 'tauri'
    && Boolean(identity.deviceId)
    && Number.isInteger(identity.pid) && identity.pid > 0
    && Number.isSafeInteger(identity.startedAtUnixMs) && identity.startedAtUnixMs > 0
    && Number.isFinite(Date.parse(identity.startAt))
    && Date.parse(identity.startAt) === identity.startedAtUnixMs
    && executablePathValid
    && SHA256_RE.test(identity.executableSha256)
    && identity.binaryHashUnavailable === false
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(identity.buildId)
    && identity.buildIdSemantics === 'baseline_commit'
    && SHA256_RE.test(identity.sourceFingerprint)
    && identity.sourceDirty === false
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(identity.appVersion)
    && SHA256_RE.test(identity.identityFingerprint)
    && identity.identityFingerprint === formalNativeClientIdentityFingerprint({
      ...identity,
      startedAt: identity.startAt,
    })
    && identity.identitySource === 'authenticated_devices_registry_proof_bound_tauri'
    && identity.identityVerified === true
    && identity.registryStatus === 'online'
    && identity.trustLevel === 'proof_bound_local_claim'
    && identity.osAttested === false
    && identity.webviewProfileTrustLevel === 'unbound'
    && identity.webviewProfileBound === false
    && identity.formalAcceptanceEligible === false;
}

export function selectRestartNativeClientEvidence(devices, expectedValue) {
  const selected = selectFormalNativeClientEvidence(
    devices,
    expectedValue,
    { requireCleanSource: true, requireExecutableHash: true },
  );
  if (!selected.ok) return selected;
  const evidence = normalizeFormalNativeClientEvidence(selected.evidence);
  if (!isValidFormalNativeClientEvidence(evidence)) {
    return { ok: false, code: 'restart_native_client_identity_invalid' };
  }
  return { ...selected, evidence };
}

function isValidProcessIdentity(identity) {
  return Number.isInteger(identity?.pid)
    && identity.pid > 0
    && Number.isFinite(new Date(identity.startAt).getTime())
    && BUILD_ID_RE.test(String(identity.buildId || ''));
}

function sameProcessInstance(left, right) {
  return Number(left?.pid) === Number(right?.pid)
    && String(left?.startAt || '') === String(right?.startAt || '');
}

function sameFormalNativeBinary(left, right) {
  const previous = normalizeFormalNativeClientEvidence(left);
  const current = normalizeFormalNativeClientEvidence(right);
  return previous.executablePath === current.executablePath
    && previous.executableSha256 === current.executableSha256
    && previous.buildId === current.buildId
    && previous.buildIdSemantics === current.buildIdSemantics
    && previous.sourceFingerprint === current.sourceFingerprint
    && previous.sourceDirty === current.sourceDirty
    && previous.appVersion === current.appVersion
    && previous.trustLevel === current.trustLevel
    && previous.osAttested === current.osAttested
    && previous.webviewProfileTrustLevel === current.webviewProfileTrustLevel
    && previous.webviewProfileBound === current.webviewProfileBound;
}

export function classifyRestartScope({ previousBackend, currentBackend, previousClient, currentClient }) {
  const backendRestarted = !sameProcessInstance(previousBackend, currentBackend);
  const clientRestarted = !sameProcessInstance(previousClient, currentClient);
  if (backendRestarted && clientRestarted) return 'both';
  if (backendRestarted) return 'backend-only';
  if (clientRestarted) return 'client-only';
  return 'none';
}

function stableCheckpoint(value) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    marker: String(value.marker || ''),
    conversationId: String(value.conversationId || ''),
    taskId: String(value.taskId || ''),
    requestId: String(value.requestId || ''),
    targetRelativePath: String(value.targetRelativePath || '').replace(/\\/g, '/'),
    contentSha256: String(value.contentSha256 || ''),
    expectedRestart: RESTART_SCOPES.has(value.expectedRestart) ? value.expectedRestart : '',
    backend: normalizeProcessIdentity(value.backend),
    nativeClient: normalizeFormalNativeClientEvidence(value.nativeClient),
    locations: {
      dataRootSha256: String(value.locations?.dataRootSha256 || '').toLowerCase(),
      webview2UserDataDirSha256: String(value.locations?.webview2UserDataDirSha256 || '').toLowerCase(),
      webview2ProfileDirSha256: String(value.locations?.webview2ProfileDirSha256 || '').toLowerCase(),
    },
    receiptSignature: String(value.receiptSignature || ''),
    taskRevision: Math.max(0, Math.trunc(Number(value.taskRevision) || 0)),
    taskTargetSha256: String(value.taskTargetSha256 || '').toLowerCase(),
    preparedAt: String(value.preparedAt || ''),
    checkpointDigest: String(value.checkpointDigest || '').toLowerCase(),
  };
}

function restartCheckpointDigest(value) {
  const payload = stableCheckpoint(value);
  payload.checkpointDigest = '';
  return evidenceTextHash(JSON.stringify(payload));
}

export function sealRestartCheckpoint(value) {
  const checkpoint = stableCheckpoint(value);
  return {
    ...checkpoint,
    checkpointDigest: restartCheckpointDigest(checkpoint),
  };
}

function sameLocationBindings(left, right) {
  return String(left?.dataRootSha256 || '') === String(right?.dataRootSha256 || '')
    && String(left?.webview2UserDataDirSha256 || '') === String(right?.webview2UserDataDirSha256 || '')
    && String(left?.webview2ProfileDirSha256 || '') === String(right?.webview2ProfileDirSha256 || '');
}

function canonicalExistingDirectory(value, code) {
  const absolute = path.resolve(String(value || ''));
  let metadata;
  try {
    metadata = fs.lstatSync(absolute);
  } catch {
    throw new E2EError(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new E2EError(code);
  return fs.realpathSync.native(absolute);
}

function canonicalDirectChild(filePath, code) {
  if (!filePath || !path.isAbsolute(String(filePath))) throw new E2EError(code);
  const absolute = path.resolve(String(filePath));
  const parent = canonicalExistingDirectory(path.dirname(absolute), code);
  const destination = path.resolve(parent, path.basename(absolute));
  if (!isPathInside(parent, destination)) {
    throw new E2EError(code);
  }
  return destination;
}

export function validateRestartCheckpoint(value, locationContext) {
  const checkpoint = stableCheckpoint(value || {});
  let bindings;
  try {
    bindings = buildFormalLocationBindings(locationContext || {});
  } catch {
    return { ok: false, checkpoint, layout: null, targetPath: '' };
  }
  const dataRoot = path.resolve(locationContext.dataRoot);
  const layout = checkpoint.marker
    ? buildOwnedArtifactLayout(dataRoot, checkpoint.marker)
    : null;
  const targetPath = checkpoint.targetRelativePath
    ? path.resolve(dataRoot, checkpoint.targetRelativePath)
    : '';
  const valid = Number(value?.schemaVersion) === CHECKPOINT_SCHEMA_VERSION
    && /^LUMI-E2E-RESTART-[a-f0-9]{16}$/i.test(checkpoint.marker)
    && Boolean(checkpoint.conversationId && checkpoint.taskId && checkpoint.requestId)
    && RESTART_SCOPES.has(checkpoint.expectedRestart)
    && isValidProcessIdentity(checkpoint.backend)
    && isValidFormalNativeClientEvidence(checkpoint.nativeClient)
    && checkpoint.backend.buildId === checkpoint.nativeClient.buildId
    && Object.values(checkpoint.locations).every(hash => SHA256_RE.test(hash))
    && sameLocationBindings(checkpoint.locations, bindings)
    && Number.isFinite(new Date(checkpoint.preparedAt).getTime())
    && SHA256_RE.test(checkpoint.contentSha256)
    && Boolean(checkpoint.receiptSignature)
    && checkpoint.taskRevision > 0
    && SHA256_RE.test(checkpoint.taskTargetSha256)
    && SHA256_RE.test(checkpoint.checkpointDigest)
    && checkpoint.checkpointDigest === restartCheckpointDigest(checkpoint)
    && Boolean(layout && layout.files.includes(targetPath));
  return valid
    ? { ok: true, checkpoint, layout, targetPath }
    : { ok: false, checkpoint, layout: null, targetPath: '' };
}

export function validateRestartRecoveryEvidence({
  checkpoint,
  health,
  nativeClient,
  locationBindings,
  task,
  messages,
  targetPath,
}) {
  const currentBackend = normalizeProcessIdentity(health?.runtime);
  const previousClient = normalizeFormalNativeClientEvidence(checkpoint?.nativeClient);
  const currentClient = normalizeFormalNativeClientEvidence(nativeClient);
  if (!isValidProcessIdentity(currentBackend)) return { ok: false, code: 'restart_backend_identity_invalid' };
  if (!isValidFormalNativeClientEvidence(previousClient)
    || !isValidFormalNativeClientEvidence(currentClient)) {
    return { ok: false, code: 'restart_native_client_identity_invalid' };
  }
  if (currentBackend.buildId !== checkpoint?.backend?.buildId) {
    return { ok: false, code: 'restart_backend_build_mismatch' };
  }
  if (currentClient.buildId !== previousClient.buildId) {
    return { ok: false, code: 'restart_native_client_build_mismatch' };
  }
  if (!sameFormalNativeBinary(previousClient, currentClient)) {
    return { ok: false, code: 'restart_native_client_binary_identity_changed' };
  }
  if (!sameLocationBindings(checkpoint?.locations, locationBindings)) {
    return { ok: false, code: 'restart_formal_location_mismatch' };
  }
  const restartScope = classifyRestartScope({
    previousBackend: checkpoint?.backend,
    currentBackend,
    previousClient,
    currentClient,
  });
  if (restartScope !== checkpoint?.expectedRestart) {
    return {
      ok: false,
      code: restartScope === 'none' ? 'restart_not_observed' : 'restart_scope_mismatch',
      expectedRestart: checkpoint?.expectedRestart || '',
      observedRestart: restartScope,
    };
  }
  if (!task || task.taskId !== checkpoint?.taskId) return { ok: false, code: 'restart_task_identity_lost' };
  if (task?.conversationId && String(task.conversationId) !== String(checkpoint?.conversationId || '')) {
    return { ok: false, code: 'restart_task_conversation_changed' };
  }
  if (!targetPath || !path.isAbsolute(String(targetPath))) {
    return { ok: false, code: 'restart_task_owner_binding_invalid' };
  }
  const expectedTarget = path.resolve(String(targetPath));
  if (pathBinding(expectedTarget) !== String(checkpoint?.taskTargetSha256 || '')
    || normalizePathForBinding(task?.target) !== normalizePathForBinding(expectedTarget)
    || !String(task?.goal || '').includes(String(checkpoint?.marker || ''))) {
    return { ok: false, code: 'restart_task_owner_binding_invalid' };
  }
  if (task.status !== 'waiting_confirmation' || task.activeRequest !== false) {
    return { ok: false, code: 'restart_task_not_recovered' };
  }
  if (runtimeReceiptSignature(task) !== checkpoint?.receiptSignature) {
    return { ok: false, code: 'restart_receipt_identity_changed' };
  }
  if (Number(task?.revision) !== Number(checkpoint?.taskRevision)) {
    return { ok: false, code: 'restart_task_revision_changed' };
  }
  const expectedContent = `${checkpoint.marker}:pending-across-restart`;
  if (evidenceTextHash(expectedContent) !== checkpoint.contentSha256) {
    return { ok: false, code: 'restart_content_binding_invalid' };
  }
  const prepareUser = (Array.isArray(messages) ? messages : []).find(message => (
    message?.role === 'user' && String(message?.requestId || '') === String(checkpoint?.requestId || '')
  ));
  const prepareText = String(prepareUser?.message || prepareUser?.content || '');
  if (!prepareText.includes(checkpoint.marker)
    || !prepareText.includes(expectedTarget)
    || !prepareText.includes(expectedContent)) {
    return { ok: false, code: 'restart_prepare_owner_transcript_invalid' };
  }
  const pendingReceipt = (Array.isArray(task?.evidence?.latest) ? task.evidence.latest : []).find(receipt => (
    String(receipt?.requestId || '') === String(checkpoint?.requestId || '')
    && String(receipt?.toolName || '') === 'write_file'
    && normalizePathForBinding(receipt?.targetIdentity) === normalizePathForBinding(expectedTarget)
    && String(receipt?.outcome || '') === 'waiting_confirmation'
  ));
  if (!pendingReceipt) return { ok: false, code: 'restart_pending_receipt_binding_invalid' };
  const turnEvidence = buildLifecycleTurnEvidence({
    messages,
    requestId: checkpoint?.requestId,
    runtimeTask: task,
  });
  if (!turnEvidence.userMessageId || !turnEvidence.assistantMessageId || turnEvidence.receiptIds.length === 0) {
    return { ok: false, code: 'restart_transcript_evidence_missing' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      restartScope,
      previousBackend: checkpoint.backend,
      recoveredBackend: currentBackend,
      previousNativeClient: previousClient,
      recoveredNativeClient: currentClient,
      locationBindings: checkpoint.locations,
      turn: turnEvidence,
      targetSha256: checkpoint.taskTargetSha256,
    },
  };
}

export function validateRestartContinuationEvidence({
  checkpoint,
  beforeTask,
  afterTask,
  messages,
  confirmationRequestId,
  targetPath,
  artifactContent,
}) {
  if (!beforeTask?.taskId || beforeTask.taskId !== checkpoint?.taskId
    || afterTask?.taskId !== checkpoint?.taskId) {
    return { ok: false, code: 'restart_continuation_task_identity_changed' };
  }
  if (beforeTask.status !== 'waiting_confirmation' || beforeTask.activeRequest !== false) {
    return { ok: false, code: 'restart_continuation_source_not_waiting' };
  }
  if (afterTask.status !== 'completed' || afterTask.activeRequest !== false) {
    return { ok: false, code: 'restart_continuation_not_completed' };
  }
  if (Number(afterTask.revision) <= Number(beforeTask.revision)) {
    return { ok: false, code: 'restart_continuation_revision_not_advanced' };
  }
  if (!targetPath || !path.isAbsolute(String(targetPath))) {
    return { ok: false, code: 'restart_continuation_target_changed' };
  }
  const expectedTarget = path.resolve(String(targetPath));
  if (normalizePathForBinding(beforeTask.target) !== normalizePathForBinding(expectedTarget)
    || normalizePathForBinding(afterTask.target) !== normalizePathForBinding(expectedTarget)
    || pathBinding(expectedTarget) !== checkpoint?.taskTargetSha256) {
    return { ok: false, code: 'restart_continuation_target_changed' };
  }
  if (evidenceTextHash(String(artifactContent ?? '')) !== checkpoint?.contentSha256) {
    return { ok: false, code: 'restart_continuation_artifact_mismatch' };
  }
  const requestId = String(confirmationRequestId || '');
  const receipts = (Array.isArray(afterTask?.evidence?.latest) ? afterTask.evidence.latest : []).filter(receipt => (
    String(receipt?.requestId || '') === requestId
    && String(receipt?.toolName || '') === 'write_file'
    && normalizePathForBinding(receipt?.targetIdentity) === normalizePathForBinding(expectedTarget)
    && String(receipt?.outcome || '') === 'verified_success'
    && String(receipt?.verification || '') === 'verified'
  ));
  if (receipts.length !== 1) return { ok: false, code: 'restart_continuation_verified_receipt_invalid' };
  const turn = buildLifecycleTurnEvidence({ messages, requestId, runtimeTask: afterTask });
  if (!turn.userMessageId
    || !turn.assistantMessageId
    || !turn.userFacingReply?.persisted
    || turn.userFacingReply?.internalGuardLeaked
    || !turn.receiptIds.includes(String(receipts[0].receiptId || ''))) {
    return { ok: false, code: 'restart_continuation_transcript_invalid' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      taskId: checkpoint.taskId,
      confirmationRequestId: requestId,
      revisionBefore: Number(beforeTask.revision),
      revisionAfter: Number(afterTask.revision),
      receiptId: String(receipts[0].receiptId || ''),
      targetSha256: checkpoint.taskTargetSha256,
      artifactSha256: checkpoint.contentSha256,
      turn,
    },
  };
}

export function writeCheckpointExclusive(checkpointPath, checkpoint) {
  const destination = canonicalDirectChild(checkpointPath, 'restart_checkpoint_parent_not_safe');
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let temporaryDescriptor;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(stableCheckpoint(checkpoint), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    temporaryDescriptor = fs.openSync(temporary, fs.constants.O_RDWR);
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    // A rename can replace a checkpoint created between existsSync() and the
    // rename on POSIX/macOS. A same-directory hard link is atomic and
    // exclusive: it either creates this exact sealed inode or fails with
    // EEXIST without touching the other invocation's checkpoint.
    fs.linkSync(temporary, destination);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new E2EError('restart_checkpoint_exists');
    throw error;
  } finally {
    if (temporaryDescriptor !== undefined) {
      try { fs.closeSync(temporaryDescriptor); } catch {}
    }
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}

export function removeOwnedRestartCheckpoint(checkpointPath, writtenPath, checkpoint) {
  try {
    if (!writtenPath || !checkpoint) return false;
    const destination = canonicalDirectChild(checkpointPath, 'restart_checkpoint_cleanup_not_safe');
    if (normalizePathForBinding(destination) !== normalizePathForBinding(writtenPath)) return false;
    const metadata = fs.lstatSync(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const persisted = stableCheckpoint(JSON.parse(fs.readFileSync(destination, 'utf8')));
    if (JSON.stringify(persisted) !== JSON.stringify(stableCheckpoint(checkpoint))) return false;
    fs.unlinkSync(destination);
    return !fs.existsSync(destination);
  } catch {
    return false;
  }
}

function readCheckpoint(checkpointPath, locationContext) {
  let parsed;
  try {
    const source = canonicalDirectChild(checkpointPath, 'restart_checkpoint_unreadable');
    const metadata = fs.lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('checkpoint_not_regular');
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch {
    throw new E2EError('restart_checkpoint_unreadable');
  }
  const validated = validateRestartCheckpoint(parsed, locationContext);
  if (!validated.ok) throw new E2EError('restart_checkpoint_invalid');
  return validated;
}

function sanitizedTurnEvidence(value) {
  return {
    requestId: String(value?.requestId || ''),
    taskId: String(value?.taskId || ''),
    taskRevision: Math.max(0, Number(value?.taskRevision) || 0),
    taskStatus: String(value?.taskStatus || ''),
    userMessageId: String(value?.userMessageId || ''),
    assistantMessageId: String(value?.assistantMessageId || ''),
    receiptIds: (Array.isArray(value?.receiptIds) ? value.receiptIds : []).map(String).slice(0, 64),
    receiptTools: (Array.isArray(value?.receiptTools) ? value.receiptTools : []).map(String).slice(0, 64),
    receiptSignature: String(value?.receiptLedger?.signature || ''),
    receiptTotal: Math.max(0, Number(value?.receiptLedger?.total) || 0),
    replySha256: String(value?.userFacingReply?.sha256 || ''),
    replyCharacterCount: Math.max(0, Number(value?.userFacingReply?.characterCount) || 0),
    internalGuardLeaked: value?.userFacingReply?.internalGuardLeaked === true,
  };
}

export function buildSanitizedRestartEvidence(result) {
  const evidence = result?.evidence || {};
  const phase = result?.phase === 'verify' ? 'verify' : 'prepare';
  const record = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: 'formal-client-restart-recovery',
    ok: result?.ok === true,
    phase,
    marker: String(result?.runMarker || ''),
    restartPerformedByScript: false,
    recordedAt: new Date().toISOString(),
    restart: {
      expected: String(result?.expectedRestart || evidence?.restartScope || ''),
      observed: phase === 'verify' ? String(evidence?.restartScope || '') : '',
    },
    identities: phase === 'prepare'
      ? {
          backend: normalizeProcessIdentity(evidence?.backend),
          nativeClient: normalizeFormalNativeClientEvidence(evidence?.nativeClient),
        }
      : {
          previousBackend: normalizeProcessIdentity(evidence?.previousBackend),
          recoveredBackend: normalizeProcessIdentity(evidence?.recoveredBackend),
          previousNativeClient: normalizeFormalNativeClientEvidence(evidence?.previousNativeClient),
          recoveredNativeClient: normalizeFormalNativeClientEvidence(evidence?.recoveredNativeClient),
        },
    locationBindings: {
      dataRootSha256: String(evidence?.locationBindings?.dataRootSha256 || ''),
      webview2UserDataDirSha256: String(evidence?.locationBindings?.webview2UserDataDirSha256 || ''),
      webview2ProfileDirSha256: String(evidence?.locationBindings?.webview2ProfileDirSha256 || ''),
    },
    profileBinding: {
      pathHashBound: true,
      identitySource: 'operator_path_binding_unverified',
      identityVerified: false,
      webviewProfileTrustLevel: 'unbound',
      webviewProfileBound: false,
    },
    lifecycle: phase === 'prepare'
      ? {
          taskId: String(evidence?.taskId || ''),
          requestId: String(evidence?.requestId || ''),
          receiptIds: (Array.isArray(evidence?.receiptIds) ? evidence.receiptIds : []).map(String).slice(0, 64),
          userMessageId: String(evidence?.userMessageId || ''),
          assistantMessageId: String(evidence?.assistantMessageId || ''),
          replySha256: String(evidence?.replyHash || ''),
          contentSha256: String(evidence?.contentSha256 || ''),
        }
      : {
          recoveredTurn: sanitizedTurnEvidence(evidence?.turn),
          statusQuery: sanitizedTurnEvidence(evidence?.statusQuery),
          continuation: sanitizedTurnEvidence(evidence?.continuation?.turn),
          confirmationRequestId: String(evidence?.continuation?.confirmationRequestId || ''),
          artifactSha256: String(evidence?.continuation?.artifactSha256 || ''),
          finalStatus: String(evidence?.finalStatus || ''),
          activeLease: evidence?.activeLease === true,
        },
    retention: phase === 'verify' ? {
      conversationRetained: result?.retention?.conversationRetained === true,
      checkpointRetained: result?.retention?.checkpointRetained === true,
      ownedArtifactRetained: result?.retention?.ownedArtifactRetained === true,
      reason: String(result?.retention?.reason || ''),
    } : undefined,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    evidenceClassification: 'restricted_private_local',
    publishable: false,
  };
  return JSON.parse(JSON.stringify(record));
}

export function restartEvidencePath(evidenceRoot, marker, phase) {
  if (!evidenceRoot || !path.isAbsolute(evidenceRoot)) throw new E2EError('absolute_evidence_root_required');
  if (!/^LUMI-E2E-RESTART-[a-f0-9]{16}$/i.test(String(marker || ''))) {
    throw new E2EError('restart_evidence_marker_invalid');
  }
  if (!['prepare', 'verify'].includes(phase)) throw new E2EError('restart_evidence_phase_invalid');
  const root = path.resolve(evidenceRoot);
  const outputPath = path.resolve(root, `formal-client-restart-recovery-${marker}-${phase}.json`);
  if (!isPathInside(root, outputPath)) throw new E2EError('restart_evidence_path_escape');
  return outputPath;
}

export function writeRestartEvidenceExclusive(evidenceRoot, result) {
  const canonicalRoot = canonicalExistingDirectory(evidenceRoot, 'restart_evidence_root_not_safe');
  const outputPath = restartEvidencePath(canonicalRoot, result?.runMarker, result?.phase);
  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(buildSanitizedRestartEvidence(result), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    throw new E2EError('restart_evidence_write_failed');
  }
  return outputPath;
}

async function connect(baseUrl, token, desktopSessionProof) {
  const socket = createSocketClient(new URL(baseUrl).origin, {
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    transports: ['websocket'],
    auth: { token, desktopSessionProof },
  });
  const boundary = await waitForSocketReady(socket, 15_000);
  requireCondition(boundary?.trustedLocalExecution === true, 'trusted_local_boundary_required');
  return socket;
}

async function bootstrap(args) {
  const session = await bootstrapDesktopTestSession(args.baseUrl, args.dataRoot, { timeoutMs: 15_000 });
  const token = String(session?.token || '');
  const desktopSessionProof = String(session?.desktopSessionProof || '');
  requireCondition(token && desktopSessionProof, 'desktop_bootstrap_invalid');
  const [health, devices] = await Promise.all([
    fetchJson(args.baseUrl, '/health', { token, query: { details: 1 } }),
    fetchJson(args.baseUrl, '/devices/native-client-evidence', {
      token,
      headers: { [DESKTOP_SESSION_HEADER]: desktopSessionProof },
    }),
  ]);
  requireCondition(health?.status === 'ok', 'runtime_health_failed');
  const selectedNativeClient = selectRestartNativeClientEvidence(
    Array.isArray(devices?.devices) ? devices.devices : [],
    args.nativeClientExpectation,
  );
  requireCondition(selectedNativeClient.ok, selectedNativeClient.code);
  return {
    token,
    desktopSessionProof,
    health,
    nativeClient: normalizeFormalNativeClientEvidence(selectedNativeClient.evidence),
  };
}

async function prepare(args) {
  if (fs.existsSync(args.checkpoint)) throw new E2EError('restart_checkpoint_exists');
  const marker = `LUMI-E2E-RESTART-${crypto.randomBytes(8).toString('hex')}`;
  const layout = prepareOwnedArtifactLayout(buildOwnedArtifactLayout(args.dataRoot, marker));
  const targetPath = layout.files[0];
  const content = `${marker}:pending-across-restart`;
  let token = '';
  let socket = null;
  let conversationId = '';
  let prepared = false;
  let writtenCheckpointPath = '';
  let ownedCheckpoint = null;
  try {
    const boot = await bootstrap(args);
    token = boot.token;
    const expectedBuildId = String(args.expectedBuildId || currentGitHead()).trim().toLowerCase();
    const backend = normalizeProcessIdentity(boot.health?.runtime);
    requireCondition(BUILD_ID_RE.test(expectedBuildId), 'expected_build_id_required');
    requireCondition(isValidProcessIdentity(backend), 'runtime_identity_invalid');
    requireCondition(backend.buildId === expectedBuildId, 'runtime_build_mismatch');
    requireCondition(boot.nativeClient.buildId === expectedBuildId, 'native_client_build_mismatch');
    socket = await connect(args.baseUrl, token, boot.desktopSessionProof);
    const created = await fetchJson(args.baseUrl, '/conversations/new', {
      token,
      method: 'POST',
      body: { agentId: 'lumi', domain: 'personal', activation: 'isolated' },
      query: { domain: 'personal' },
    });
    conversationId = String(created?.conversation?.id || '');
    requireCondition(conversationId, 'conversation_create_failed');
    const requestId = `e2e-${marker.toLowerCase()}-prepare`;
    await runTurn(socket, {
      requestId,
      conversationId,
      timeoutMs: args.timeoutMs,
      text: `[${marker}] 创建确认门控文件 ${targetPath}，内容严格写成 ${content}。必须调用 write_file 并等待确认，不得自行确认。`,
    });
    const [{ task }, messages] = await Promise.all([
      pollRuntimeTaskByMarker(args.baseUrl, token, marker, args.timeoutMs),
      persistedMessages(args.baseUrl, token, conversationId),
    ]);
    const turnEvidence = buildLifecycleTurnEvidence({ messages, requestId, runtimeTask: task });
    requireCondition(task.status === 'waiting_confirmation', 'restart_prepare_not_waiting_confirmation');
    requireCondition(task.activeRequest === false, 'restart_prepare_lease_not_yielded');
    requireCondition(turnEvidence.userMessageId && turnEvidence.assistantMessageId, 'restart_prepare_transcript_missing');
    requireCondition(turnEvidence.receiptIds.length > 0, 'restart_prepare_receipt_missing');
    requireCondition(!fs.existsSync(targetPath), 'restart_prepare_artifact_created');
    const checkpoint = sealRestartCheckpoint({
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      marker,
      conversationId,
      taskId: task.taskId,
      requestId,
      targetRelativePath: path.relative(args.dataRoot, targetPath),
      contentSha256: evidenceTextHash(content),
      expectedRestart: args.restartScope,
      backend,
      nativeClient: boot.nativeClient,
      locations: args.locationBindings,
      receiptSignature: runtimeReceiptSignature(task),
      taskRevision: task.revision,
      taskTargetSha256: pathBinding(targetPath),
      preparedAt: new Date().toISOString(),
    });
    requireCondition(
      validateRestartCheckpoint(checkpoint, args).ok,
      'restart_checkpoint_evidence_invalid',
    );
    writtenCheckpointPath = writeCheckpointExclusive(args.checkpoint, checkpoint);
    ownedCheckpoint = checkpoint;
    prepared = true;
    return {
      ok: true,
      phaseComplete: true,
      packageComplete: false,
      phase: 'prepare',
      runMarker: marker,
      expectedRestart: args.restartScope,
      restartRequired: true,
      restartPerformedByScript: false,
      checkpointPath: writtenCheckpointPath,
      evidence: {
        taskId: task.taskId,
        requestId,
        receiptIds: turnEvidence.receiptIds,
        userMessageId: turnEvidence.userMessageId,
        assistantMessageId: turnEvidence.assistantMessageId,
        replyHash: turnEvidence.userFacingReply.sha256,
        contentSha256: checkpoint.contentSha256,
        backend: checkpoint.backend,
        nativeClient: checkpoint.nativeClient,
        locationBindings: checkpoint.locations,
      },
      nextStep: `Perform the ${args.restartScope} restart yourself, then run the verify command.`,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    };
  } finally {
    try { socket?.disconnect(); } catch {}
    if (!prepared) {
      let cleanupFailed = false;
      if (conversationId && token) {
        try {
          const deleted = await fetchJson(args.baseUrl, `/conversations/${encodeURIComponent(conversationId)}`, {
            token,
            method: 'DELETE',
            query: { domain: 'personal' },
          });
          if (deleted?.success === false) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      if (writtenCheckpointPath
        && !removeOwnedRestartCheckpoint(args.checkpoint, writtenCheckpointPath, ownedCheckpoint)) {
        cleanupFailed = true;
      }
      if (!cleanOwnedArtifactLayout(layout).ok) cleanupFailed = true;
      if (cleanupFailed) throw new E2EError('restart_prepare_cleanup_failed');
    }
  }
}

async function verify(args) {
  const validated = readCheckpoint(args.checkpoint, args);
  const checkpoint = validated.checkpoint;
  const layout = openOwnedArtifactLayout(validated.layout);
  const targetPath = layout.files[0];
  requireCondition(args.restartScope === checkpoint.expectedRestart, 'restart_scope_argument_mismatch');
  let token = '';
  let socket = null;
  try {
    const boot = await bootstrap(args);
    token = boot.token;
    if (args.expectedBuildId) {
      const expectedBuildId = String(args.expectedBuildId).trim().toLowerCase();
      requireCondition(boot.health.runtime.buildId === expectedBuildId, 'runtime_build_mismatch');
      requireCondition(boot.nativeClient.buildId === expectedBuildId, 'native_client_build_mismatch');
    }
    socket = await connect(args.baseUrl, token, boot.desktopSessionProof);
    const [runtime, messages] = await Promise.all([
      runtimeStatus(args.baseUrl, token),
      persistedMessages(args.baseUrl, token, checkpoint.conversationId),
    ]);
    const recoveredTask = runtime?.tasks?.find(task => task?.taskId === checkpoint.taskId) || null;
    const recovered = validateRestartRecoveryEvidence({
      checkpoint,
      health: boot.health,
      nativeClient: boot.nativeClient,
      locationBindings: args.locationBindings,
      task: recoveredTask,
      messages,
      targetPath,
    });
    requireCondition(recovered.ok, recovered.code);
    requireCondition(!fs.existsSync(targetPath), 'restart_recovery_artifact_created');

    const statusRequestId = `e2e-${checkpoint.marker.toLowerCase()}-verify-status`;
    const statusTurn = await runTurn(socket, {
      requestId: statusRequestId,
      conversationId: checkpoint.conversationId,
      timeoutMs: args.timeoutMs,
      text: '这个任务完成了吗？只报告恢复后的持久状态，不要执行、确认或重放任何动作。',
    });
    const statusSnapshot = await pollRuntimeTaskByMarker(args.baseUrl, token, checkpoint.marker, args.timeoutMs);
    const statusMessages = await persistedMessages(args.baseUrl, token, checkpoint.conversationId);
    const statusEvidence = buildLifecycleTurnEvidence({
      messages: statusMessages,
      requestId: statusRequestId,
      runtimeTask: statusSnapshot.task,
    });
    const statusValidation = validateStatusQueryNoReplay({
      beforeTask: recoveredTask,
      afterTask: statusSnapshot.task,
      turnEvidence: statusEvidence,
      toolEventCount: statusTurn.toolEvents.length,
    });
    requireCondition(statusValidation.ok, statusValidation.code);

    const confirmationRequestId = `e2e-${checkpoint.marker.toLowerCase()}-verify-confirm`;
    await runTurn(socket, {
      requestId: confirmationRequestId,
      conversationId: checkpoint.conversationId,
      timeoutMs: args.timeoutMs,
      text: '确认',
    });
    const completed = await pollRuntimeTaskByMarker(
      args.baseUrl,
      token,
      checkpoint.marker,
      args.timeoutMs,
      task => task.taskId === checkpoint.taskId
        && task.status === 'completed'
        && task.activeRequest === false,
    );
    requireCondition(fs.existsSync(targetPath), 'restart_continuation_artifact_missing');
    const artifactMetadata = fs.lstatSync(targetPath);
    requireCondition(
      artifactMetadata.isFile() && !artifactMetadata.isSymbolicLink(),
      'restart_continuation_artifact_not_regular',
    );
    requireCondition(
      fs.realpathSync.native(path.dirname(targetPath)) === layout.root,
      'restart_continuation_artifact_parent_changed',
    );
    const artifactContent = fs.readFileSync(targetPath, 'utf8');
    const completionMessages = await persistedMessages(args.baseUrl, token, checkpoint.conversationId);
    const continuation = validateRestartContinuationEvidence({
      checkpoint,
      beforeTask: statusSnapshot.task,
      afterTask: completed.task,
      messages: completionMessages,
      confirmationRequestId,
      targetPath,
      artifactContent,
    });
    requireCondition(continuation.ok, continuation.code);

    const result = {
      ok: true,
      phaseComplete: true,
      packageComplete: false,
      phase: 'verify',
      runMarker: checkpoint.marker,
      expectedRestart: checkpoint.expectedRestart,
      restartObserved: true,
      restartPerformedByScript: false,
      evidence: {
        ...recovered.evidence,
        statusQuery: statusEvidence,
        continuation: continuation.evidence,
        finalStatus: completed.task.status,
        activeLease: completed.task.activeRequest,
      },
      retention: {
        conversationRetained: true,
        checkpointRetained: true,
        ownedArtifactRetained: true,
        reason: 'formal_stage9_evidence_pending_unified_adjudication',
      },
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    };
    if (args.cleanupOwnedAfterVerify) {
      const deleted = await fetchJson(
        args.baseUrl,
        `/conversations/${encodeURIComponent(checkpoint.conversationId)}`,
        { token, method: 'DELETE', query: { domain: 'personal' } },
      );
      requireCondition(
        deleted?.success === true
          && deleted?.deleted?.conversationId === checkpoint.conversationId,
        'restart_owned_conversation_cleanup_failed',
      );
      const artifactCleanup = cleanOwnedArtifactLayout(layout);
      requireCondition(artifactCleanup.ok, 'restart_owned_artifact_cleanup_failed');
      const checkpointCanonicalPath = fs.realpathSync.native(args.checkpoint);
      requireCondition(
        removeOwnedRestartCheckpoint(args.checkpoint, checkpointCanonicalPath, checkpoint),
        'restart_owned_checkpoint_cleanup_failed',
      );
      result.retention = {
        conversationRetained: false,
        checkpointRetained: false,
        ownedArtifactRetained: false,
        reason: 'explicit_exact_owned_cleanup_completed',
      };
      result.cleanup = {
        conversationId: checkpoint.conversationId,
        conversationDeleted: true,
        ownedArtifactRemoved: true,
        checkpointRemoved: true,
      };
    }
    return result;
  } finally {
    try { socket?.disconnect(); } catch {}
  }
}

export function restartEvidenceCliExitCode(result) {
  return formalStage9ProducerEvidenceExitCode(result);
}

export async function createRestartFormalStage9ProducerEvidence(options = {}) {
  return createFormalStage9FileBackedProducerEvidence({
    ...options,
    producer: 'restart',
    payload: options.payload || {
      prepare: options.prepare,
      verify: options.verify,
    },
  });
}

async function main() {
  let result;
  let args;
  try {
    args = parseRestartRecoveryArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      // Exit zero is reserved for adjudicated acceptance, never for help.
      process.exitCode = 1;
      return;
    }
    result = args.mode === 'prepare' ? await prepare(args) : await verify(args);
    if (args.evidenceRoot) {
      result.evidencePath = writeRestartEvidenceExclusive(args.evidenceRoot, result);
    }
  } catch (error) {
    result = {
      ok: false,
      phaseComplete: false,
      packageComplete: false,
      phase: process.argv[2] || 'unknown',
      failedCheck: error instanceof E2EError ? error.code : 'unexpected_restart_e2e_failure',
      restartPerformedByScript: false,
    };
  }
  process.exitCode = restartEvidenceCliExitCode(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
