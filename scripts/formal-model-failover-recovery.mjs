import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { bootstrapDesktopTestSession } from './lib/desktop-bootstrap.mjs';
import {
  createFormalStage9FileBackedProducerEvidence,
  formalStage9ProducerEvidenceExitCode,
} from './lib/formal-stage9-producer-evidence.mjs';

const CHECKPOINT_SCHEMA_VERSION = 3;
const EVIDENCE_SCHEMA_VERSION = 3;
const BUILD_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,240}$/;
const MARKER_RE = /^LUMI-E2E-FAILOVER-[a-f0-9]{16}$/i;
const SYNTHETIC_PROVIDER_RE = /(?:^__|synthetic|forced[_-]?(?:failure|unavailable)|mock|fake|test[_-]?provider|failover[_-]?probe)/i;
const INTERNAL_GUARD_RE = /(?:No (?:successful|verified) current[- ]turn tool execution|No successful current-turn tool execution was recorded|这一轮没有记录到成功的真实工具执行|我还不能说正在执行|我需要先真正调用对应工具)/iu;
const ACTUAL_FAILURE_REASONS = new Set([
  'quota_or_billing',
  'provider_auth_failed',
  'timeout',
  'provider_unreachable',
  'model_unavailable',
  'provider_call_failed',
  'empty_response',
  'unknown_error',
]);
const PREPARE_TASK_STATUSES = new Set(['waiting_confirmation']);
const RECOVERED_TASK_STATUSES = new Set(['created', 'planning', 'executing', 'verifying', 'waiting_confirmation', 'completed']);
const PENDING_VERIFY_CODES = new Set([
  'failover_continuation_task_missing',
  'failover_continuation_task_revision_not_advanced',
  'failover_continuation_task_receipt_missing',
  'failover_continuation_user_message_missing',
  'failover_continuation_assistant_message_missing',
  'failover_routing_receipt_missing',
]);

export class FailoverProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FailoverProtocolError';
    this.code = code;
  }
}

function usage() {
  return [
    'Formal production-primary to LM Studio recovery acceptance (observation only).',
    '',
    'Prepare, after a real task is waiting for confirmation and the primary route is healthy:',
    '  node scripts/formal-model-failover-recovery.mjs prepare --confirm-live-e2e \\',
    '    --data-root <absolute-path> --evidence-root <absolute-path> \\',
    '    --webview2-user-data-dir <absolute-path> --webview2-profile-dir <absolute-path> \\',
    '    --conversation-id <id> --task-id <id> --baseline-request-id <id>',
    '',
    'Then create or wait for a real primary-provider failure outside this script. In the native',
    'client, continue the same task with the marker printed by prepare and make the continuation',
    'produce a durable task receipt. Do not change Lumi model preferences.',
    '',
    'Verify:',
    '  node scripts/formal-model-failover-recovery.mjs verify --confirm-live-e2e \\',
    '    --data-root <absolute-path> --evidence-root <absolute-path> \\',
    '    --webview2-user-data-dir <absolute-path> --webview2-profile-dir <absolute-path> \\',
    '    --continuation-request-id <id>',
    '',
    'Options:',
    '  --base-url <url>           default http://127.0.0.1:3000/api; loopback only',
    '  --checkpoint <abs-path>    default <evidence-root>/formal-model-failover-checkpoint.json',
    '  --expected-build-id <sha>  default git HEAD during prepare; checkpoint build during verify',
    '  --timeout-ms <ms>          verify polling timeout, default 180000',
    '  --help',
    '',
    'The script never sends a chat turn, changes preferences, credentials or network state,',
    'starts/stops a process, or induces a provider failure. It only authenticates locally, reads',
    'persisted evidence, and writes an immutable checkpoint plus sanitized acceptance records.',
  ].join('\n');
}

export function isLoopbackBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol)
      && new Set(['127.0.0.1', 'localhost', '[::1]']).has(parsed.hostname);
  } catch {
    return false;
  }
}

function isLexicallyInside(basePath, candidatePath) {
  const base = path.resolve(String(basePath || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function stripWindowsExtendedPrefix(value) {
  const candidate = String(value || '');
  if (/^\\\\\?\\UNC\\/iu.test(candidate)) return `\\\\${candidate.slice(8)}`;
  if (/^\\\\\?\\/u.test(candidate)) return candidate.slice(4);
  return candidate;
}

function normalizedPath(value) {
  const resolved = path.resolve(stripWindowsExtendedPrefix(value));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function canonicalRealPath(value, code) {
  try {
    const lexical = path.resolve(String(value || ''));
    const real = path.resolve(stripWindowsExtendedPrefix(
      typeof fs.realpathSync.native === 'function'
        ? fs.realpathSync.native(lexical)
        : fs.realpathSync(lexical),
    ));
    if (normalizedPath(lexical) !== normalizedPath(real)) {
      throw new FailoverProtocolError(code);
    }
    return real;
  } catch (error) {
    if (error instanceof FailoverProtocolError) throw error;
    throw new FailoverProtocolError(code);
  }
}

function canonicalExistingDirectory(value, code) {
  const lexical = path.resolve(String(value || ''));
  let metadata;
  try {
    metadata = fs.lstatSync(lexical);
  } catch {
    throw new FailoverProtocolError(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FailoverProtocolError(code);
  }
  return canonicalRealPath(lexical, code);
}

function isCanonicalPathInside(basePath, candidatePath) {
  const base = normalizedPath(basePath);
  const candidate = normalizedPath(candidatePath);
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalContainedFile(baseRoot, candidatePath, {
  mustExist,
  outsideCode,
  unsafeCode,
}) {
  const canonicalBase = canonicalExistingDirectory(baseRoot, unsafeCode);
  const lexicalCandidate = path.resolve(String(candidatePath || ''));
  const canonicalParent = canonicalExistingDirectory(path.dirname(lexicalCandidate), unsafeCode);
  if (!isCanonicalPathInside(canonicalBase, canonicalParent)
    && normalizedPath(canonicalBase) !== normalizedPath(canonicalParent)) {
    throw new FailoverProtocolError(outsideCode);
  }
  const canonicalCandidate = path.join(canonicalParent, path.basename(lexicalCandidate));
  if (normalizedPath(canonicalCandidate) !== normalizedPath(lexicalCandidate)) {
    throw new FailoverProtocolError(unsafeCode);
  }
  const exists = fs.existsSync(lexicalCandidate);
  if (mustExist && !exists) throw new FailoverProtocolError(unsafeCode);
  if (exists) {
    let metadata;
    try {
      metadata = fs.lstatSync(lexicalCandidate);
    } catch {
      throw new FailoverProtocolError(unsafeCode);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new FailoverProtocolError(unsafeCode);
    }
    canonicalRealPath(lexicalCandidate, unsafeCode);
  }
  return canonicalCandidate;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stableDigest(value) {
  return sha256(JSON.stringify(stableValue(value)));
}

function validBindingId(value, limit = 512) {
  const candidate = String(value || '');
  return Boolean(candidate && candidate.length <= limit && !/[\u0000-\u001f\u007f]/u.test(candidate));
}

function normalizeObservedClientIdentity(value) {
  const startedAtUnixMs = Number(value?.startedAtUnixMs);
  const executablePath = String(value?.executablePath || '');
  const executableSha256 = String(value?.executableSha256 || '').toLowerCase();
  const buildId = String(value?.buildId || '').toLowerCase();
  const sourceFingerprint = String(value?.sourceFingerprint || '').toLowerCase();
  const appVersion = String(value?.appVersion || '');
  if (Number(value?.schemaVersion) !== 1
    || !['tauri', 'local_acceptance_harness'].includes(String(value?.clientKind || ''))
    || !Number.isSafeInteger(Number(value?.pid)) || Number(value.pid) <= 0
    || !Number.isSafeInteger(startedAtUnixMs) || startedAtUnixMs < Date.UTC(2000, 0, 1)
    || !path.isAbsolute(executablePath) && !path.win32.isAbsolute(executablePath)
    || value?.binaryHashUnavailable !== false || !SHA256_RE.test(executableSha256)
    || !BUILD_ID_RE.test(buildId) || value?.buildIdSemantics !== 'baseline_commit'
    || !SHA256_RE.test(sourceFingerprint) || typeof value?.sourceDirty !== 'boolean'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(appVersion)
    || value?.trustLevel !== 'proof_bound_local_claim'
    || value?.osAttested !== false
    || value?.webviewProfileTrustLevel !== 'unbound') {
    return null;
  }
  const startedAt = String(value?.startedAt || '');
  if (!validIso(startedAt) || timestamp(startedAt) !== startedAtUnixMs) return null;
  return {
    schemaVersion: 1,
    clientKind: String(value.clientKind),
    pid: Number(value.pid),
    startedAtUnixMs,
    startedAt: new Date(startedAtUnixMs).toISOString(),
    executablePath,
    executableSha256,
    binaryHashUnavailable: false,
    buildId,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint,
    sourceDirty: value.sourceDirty === true,
    appVersion,
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
  };
}

function sanitizedIdentityEvidence(identity) {
  return {
    clientKind: identity.clientKind,
    pid: identity.pid,
    startedAt: identity.startedAt,
    executablePathSha256: sha256(normalizedPath(identity.executablePath)),
    executableSha256: identity.executableSha256,
    buildId: identity.buildId,
    buildIdSemantics: identity.buildIdSemantics,
    sourceFingerprint: identity.sourceFingerprint,
    sourceDirty: identity.sourceDirty,
    appVersion: identity.appVersion,
    trustLevel: identity.trustLevel,
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
    identitySha256: stableDigest(identity),
  };
}

/** The bootstrap caller is only a read-only API observer, never product-client proof. */
export function validateAcceptanceHarnessIdentity(value, expectedBuildId) {
  const identity = normalizeObservedClientIdentity(value);
  if (!identity || identity.clientKind !== 'local_acceptance_harness') {
    return { ok: false, code: 'failover_observer_must_be_acceptance_harness' };
  }
  if (identity.buildId !== String(expectedBuildId || '').toLowerCase() || identity.sourceDirty) {
    return { ok: false, code: 'failover_observer_source_identity_mismatch' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      ...sanitizedIdentityEvidence(identity),
      role: 'read_only_authenticated_observer',
      eligibleAsNativeClientEvidence: false,
    },
  };
}

export function validateNativeTauriDeviceEvidence(devices, {
  nativeDeviceId,
  nativeClientIdentitySha256,
  expectedBuildId,
}) {
  if (!validBindingId(nativeDeviceId) || !SHA256_RE.test(String(nativeClientIdentitySha256 || ''))) {
    return { ok: false, code: 'failover_native_request_binding_invalid' };
  }
  const matches = (Array.isArray(devices) ? devices : [])
    .filter(device => String(device?.id || '') === String(nativeDeviceId));
  if (matches.length !== 1) {
    return { ok: false, code: matches.length ? 'failover_native_device_ambiguous' : 'failover_native_device_missing' };
  }
  const device = matches[0];
  if (device?.type !== 'desktop' || device?.status !== 'online' || !validBindingId(device?.socketId)) {
    return { ok: false, code: 'failover_native_device_not_online_desktop' };
  }
  const identity = normalizeObservedClientIdentity(device?.nativeClientIdentity);
  if (!identity || identity.clientKind !== 'tauri') {
    return { ok: false, code: 'failover_native_device_not_tauri' };
  }
  if (identity.buildId !== String(expectedBuildId || '').toLowerCase() || identity.sourceDirty) {
    return { ok: false, code: 'failover_native_client_source_identity_mismatch' };
  }
  const evidence = sanitizedIdentityEvidence(identity);
  if (evidence.identitySha256 !== String(nativeClientIdentitySha256).toLowerCase()) {
    return { ok: false, code: 'failover_native_client_identity_binding_mismatch' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      ...evidence,
      nativeDeviceId: String(device.id),
      registryStatus: 'online',
      registrySocketPresent: true,
      evidenceRole: 'request_bound_product_client',
      webviewProfileBound: false,
    },
  };
}

export function buildLocationBindings({ dataRoot, webview2UserDataDir, webview2ProfileDir }) {
  for (const [code, value] of [
    ['absolute_data_root_required', dataRoot],
    ['absolute_webview2_user_data_dir_required', webview2UserDataDir],
    ['absolute_webview2_profile_dir_required', webview2ProfileDir],
  ]) {
    if (!value || !path.isAbsolute(value)) throw new FailoverProtocolError(code);
  }
  if (!isLexicallyInside(webview2UserDataDir, webview2ProfileDir)) {
    throw new FailoverProtocolError('webview2_profile_outside_user_data_dir');
  }
  return {
    dataRootSha256: sha256(normalizedPath(dataRoot)),
    webview2UserDataDirSha256: sha256(normalizedPath(webview2UserDataDir)),
    webview2ProfileDirSha256: sha256(normalizedPath(webview2ProfileDir)),
  };
}

/**
 * Resolve the operator-supplied formal locations without trusting lexical
 * containment. A junction, mount/reparse redirect, or symlink in any resolved
 * directory makes the run ineligible instead of silently hashing the target.
 */
export function resolveFormalFilesystemLayout(args) {
  const dataRoot = canonicalExistingDirectory(
    args?.dataRoot,
    'formal_data_root_not_canonical_directory',
  );
  const evidenceRoot = canonicalExistingDirectory(
    args?.evidenceRoot,
    'formal_evidence_root_not_canonical_directory',
  );
  const webview2UserDataDir = canonicalExistingDirectory(
    args?.webview2UserDataDir,
    'formal_webview2_user_data_dir_not_canonical_directory',
  );
  const webview2ProfileDir = canonicalExistingDirectory(
    args?.webview2ProfileDir,
    'formal_webview2_profile_dir_not_canonical_directory',
  );
  if (!isCanonicalPathInside(webview2UserDataDir, webview2ProfileDir)) {
    throw new FailoverProtocolError('webview2_profile_outside_user_data_dir');
  }
  const checkpoint = canonicalContainedFile(evidenceRoot, args?.checkpoint, {
    mustExist: args?.mode === 'verify',
    outsideCode: 'failover_checkpoint_outside_evidence_root',
    unsafeCode: 'failover_checkpoint_path_not_canonical_regular_file',
  });
  return {
    dataRoot,
    evidenceRoot,
    webview2UserDataDir,
    webview2ProfileDir,
    checkpoint,
    locationBindings: buildLocationBindings({ dataRoot, webview2UserDataDir, webview2ProfileDir }),
  };
}

function applyFormalFilesystemLayout(args) {
  Object.assign(args, resolveFormalFilesystemLayout(args));
}

export function parseFailoverArgs(argv) {
  const mode = argv[0];
  const args = {
    mode,
    baseUrl: 'http://127.0.0.1:3000/api',
    dataRoot: '',
    evidenceRoot: '',
    checkpoint: '',
    webview2UserDataDir: '',
    webview2ProfileDir: '',
    expectedBuildId: '',
    conversationId: '',
    taskId: '',
    baselineRequestId: '',
    continuationRequestId: '',
    timeoutMs: 180_000,
    confirmed: false,
    help: argv.includes('--help') || argv.includes('-h'),
  };
  if (args.help) return args;
  if (!['prepare', 'verify'].includes(mode)) throw new FailoverProtocolError('failover_mode_required');
  const valueFlags = new Set([
    '--base-url', '--data-root', '--evidence-root', '--checkpoint',
    '--webview2-user-data-dir', '--webview2-profile-dir', '--expected-build-id',
    '--conversation-id', '--task-id', '--baseline-request-id', '--continuation-request-id',
    '--timeout-ms',
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new FailoverProtocolError('invalid_arguments');
      index += 1;
      if (flag === '--base-url') args.baseUrl = value;
      if (flag === '--data-root') args.dataRoot = value;
      if (flag === '--evidence-root') args.evidenceRoot = value;
      if (flag === '--checkpoint') args.checkpoint = value;
      if (flag === '--webview2-user-data-dir') args.webview2UserDataDir = value;
      if (flag === '--webview2-profile-dir') args.webview2ProfileDir = value;
      if (flag === '--expected-build-id') args.expectedBuildId = value;
      if (flag === '--conversation-id') args.conversationId = value;
      if (flag === '--task-id') args.taskId = value;
      if (flag === '--baseline-request-id') args.baselineRequestId = value;
      if (flag === '--continuation-request-id') args.continuationRequestId = value;
      if (flag === '--timeout-ms') args.timeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (flag === '--confirm-live-e2e') args.confirmed = true;
    else throw new FailoverProtocolError('invalid_arguments');
  }
  if (!args.confirmed) throw new FailoverProtocolError('live_confirmation_required');
  if (!args.dataRoot || !path.isAbsolute(args.dataRoot)) throw new FailoverProtocolError('absolute_data_root_required');
  if (!args.evidenceRoot || !path.isAbsolute(args.evidenceRoot)) throw new FailoverProtocolError('absolute_evidence_root_required');
  if (!args.webview2UserDataDir || !path.isAbsolute(args.webview2UserDataDir)) {
    throw new FailoverProtocolError('absolute_webview2_user_data_dir_required');
  }
  if (!args.webview2ProfileDir || !path.isAbsolute(args.webview2ProfileDir)) {
    throw new FailoverProtocolError('absolute_webview2_profile_dir_required');
  }
  if (!isLoopbackBaseUrl(args.baseUrl)) throw new FailoverProtocolError('loopback_api_required');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000 || args.timeoutMs > 900_000) {
    throw new FailoverProtocolError('invalid_timeout');
  }
  args.baseUrl = args.baseUrl.replace(/\/$/, '');
  args.dataRoot = path.resolve(args.dataRoot);
  args.evidenceRoot = path.resolve(args.evidenceRoot);
  args.webview2UserDataDir = path.resolve(args.webview2UserDataDir);
  args.webview2ProfileDir = path.resolve(args.webview2ProfileDir);
  args.checkpoint = path.resolve(args.checkpoint || path.join(args.evidenceRoot, 'formal-model-failover-checkpoint.json'));
  if (!isLexicallyInside(args.evidenceRoot, args.checkpoint)) {
    throw new FailoverProtocolError('failover_checkpoint_outside_evidence_root');
  }
  if (!isLexicallyInside(args.webview2UserDataDir, args.webview2ProfileDir)) {
    throw new FailoverProtocolError('webview2_profile_outside_user_data_dir');
  }
  if (args.expectedBuildId && !BUILD_ID_RE.test(args.expectedBuildId)) {
    throw new FailoverProtocolError('expected_build_id_invalid');
  }
  if (mode === 'prepare') {
    if (![args.conversationId, args.taskId, args.baselineRequestId].every(value => SAFE_ID_RE.test(value))) {
      throw new FailoverProtocolError('prepare_lifecycle_identity_required');
    }
    if (args.continuationRequestId) throw new FailoverProtocolError('continuation_request_only_allowed_during_verify');
  } else {
    if (!SAFE_ID_RE.test(args.continuationRequestId)) {
      throw new FailoverProtocolError('continuation_request_id_required');
    }
    if (args.conversationId || args.taskId || args.baselineRequestId) {
      throw new FailoverProtocolError('verify_lifecycle_identity_comes_from_checkpoint');
    }
  }
  args.expectedBuildId = args.expectedBuildId.toLowerCase();
  args.locationBindings = buildLocationBindings(args);
  return args;
}

function compact(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeFallbackCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(candidate => ({
    provider: compact(candidate?.provider, 120).toLowerCase(),
    model: compact(candidate?.model, 200),
  })).filter(candidate => candidate.provider && candidate.model);
}

export function normalizeRoutingPolicy(value) {
  return {
    schemaVersion: Number(value?.schemaVersion || 0),
    provider: compact(value?.provider, 120).toLowerCase(),
    model: compact(value?.model, 200),
    selectionMode: compact(value?.selectionMode, 40),
    fallbackCandidates: normalizeFallbackCandidates(value?.fallbackCandidates),
    allowCloudFallback: value?.allowCloudFallback === true,
  };
}

export function validateFormalRoutingPolicy(value) {
  const policy = normalizeRoutingPolicy(value);
  if (policy.schemaVersion !== 2) return { ok: false, code: 'failover_policy_schema_invalid', policy };
  if (!policy.provider || !policy.model || ['auto', 'ollama', 'lmstudio'].includes(policy.provider)) {
    return { ok: false, code: 'failover_primary_provider_invalid', policy };
  }
  if (SYNTHETIC_PROVIDER_RE.test(policy.provider)) {
    return { ok: false, code: 'failover_synthetic_primary_rejected', policy };
  }
  if (policy.selectionMode !== 'ordered_fallback') {
    return { ok: false, code: 'failover_ordered_policy_required', policy };
  }
  const lmstudioCandidates = policy.fallbackCandidates.filter(candidate => candidate.provider === 'lmstudio');
  if (lmstudioCandidates.length !== 1 || policy.fallbackCandidates[0]?.provider !== 'lmstudio') {
    return { ok: false, code: 'failover_lmstudio_must_be_first_unique_fallback', policy };
  }
  return {
    ok: true,
    code: '',
    policy,
    policySha256: stableDigest(policy),
    lmstudioModel: lmstudioCandidates[0].model,
  };
}

function messageText(message) {
  return String(message?.message || message?.content || message?.response || '').trim();
}

export function containsInternalGuardText(value) {
  return INTERNAL_GUARD_RE.test(String(value || ''));
}

function validIso(value) {
  return Number.isFinite(new Date(String(value || '')).getTime());
}

function timestamp(value) {
  return new Date(String(value || '')).getTime();
}

function nativeRequestBinding(record) {
  return {
    nativeDeviceId: String(record?.nativeDeviceId || ''),
    executionSessionId: String(record?.executionSessionId || ''),
    nativeClientIdentitySha256: String(record?.nativeClientIdentitySha256 || '').toLowerCase(),
  };
}

function validNativeRequestBinding(binding) {
  return validBindingId(binding?.nativeDeviceId)
    && validBindingId(binding?.executionSessionId)
    && SHA256_RE.test(String(binding?.nativeClientIdentitySha256 || ''));
}

function sameNativeRequestBinding(left, right) {
  return validNativeRequestBinding(left)
    && validNativeRequestBinding(right)
    && left.nativeDeviceId === right.nativeDeviceId
    && left.executionSessionId === right.executionSessionId
    && left.nativeClientIdentitySha256 === right.nativeClientIdentitySha256;
}

export function validatePersistedTurn({
  messages,
  conversationId,
  requestId,
  requiredMarker = '',
  requireLlm = true,
  expectedNativeBinding = null,
}) {
  const records = Array.isArray(messages) ? messages : [];
  const users = records.filter(message => message?.role === 'user' && message?.requestId === requestId);
  const assistants = records.filter(message => message?.role === 'assistant' && message?.requestId === requestId);
  if (users.length === 0) return { ok: false, code: 'failover_continuation_user_message_missing' };
  if (assistants.length === 0) return { ok: false, code: 'failover_continuation_assistant_message_missing' };
  if (users.length !== 1 || assistants.length !== 1) return { ok: false, code: 'failover_transcript_request_ambiguous' };
  const user = users[0];
  const assistant = assistants[0];
  if (String(user?.conversationId || '') !== conversationId || String(assistant?.conversationId || '') !== conversationId) {
    return { ok: false, code: 'failover_transcript_conversation_mismatch' };
  }
  if (compact(user?.channel, 40).toLowerCase() !== 'chat' || compact(assistant?.channel, 40).toLowerCase() !== 'chat') {
    return { ok: false, code: 'failover_transcript_not_native_chat' };
  }
  const userText = messageText(user);
  const assistantText = messageText(assistant);
  if (!userText || !assistantText) return { ok: false, code: 'failover_transcript_text_missing' };
  if (requiredMarker && !userText.includes(requiredMarker)) {
    return { ok: false, code: 'failover_continuation_marker_missing' };
  }
  if (!validIso(user?.timestamp) || !validIso(assistant?.timestamp) || timestamp(assistant.timestamp) < timestamp(user.timestamp)) {
    return { ok: false, code: 'failover_transcript_chronology_invalid' };
  }
  if (requireLlm && assistant?.llmWasCalled !== true) {
    return { ok: false, code: 'failover_assistant_not_model_generated' };
  }
  if (containsInternalGuardText(assistantText)) {
    return { ok: false, code: 'failover_internal_guard_leaked' };
  }
  if (['persistence_unknown', 'cancelled', 'stale_task_control'].includes(String(assistant?.cognitiveIntent || ''))) {
    return { ok: false, code: 'failover_assistant_terminal_state_invalid' };
  }
  const userNativeBinding = nativeRequestBinding(user);
  const assistantNativeBinding = nativeRequestBinding(assistant);
  if (!sameNativeRequestBinding(userNativeBinding, assistantNativeBinding)) {
    return { ok: false, code: 'failover_transcript_native_client_binding_missing' };
  }
  if (expectedNativeBinding && !sameNativeRequestBinding(userNativeBinding, expectedNativeBinding)) {
    return { ok: false, code: 'failover_transcript_native_client_binding_mismatch' };
  }
  return {
    ok: true,
    code: '',
    user,
    assistant,
    evidence: {
      userMessageId: String(user.id || ''),
      assistantMessageId: String(assistant.id || ''),
      userTextSha256: sha256(userText),
      assistantTextSha256: sha256(assistantText),
      userCharacterCount: userText.length,
      assistantCharacterCount: assistantText.length,
      userTimestamp: new Date(user.timestamp).toISOString(),
      assistantTimestamp: new Date(assistant.timestamp).toISOString(),
      ...userNativeBinding,
    },
  };
}

function routeTimestampValid(receipt) {
  return validIso(receipt?.startedAt)
    && validIso(receipt?.completedAt)
    && timestamp(receipt.completedAt) >= timestamp(receipt.startedAt)
    && Number.isFinite(Number(receipt?.durationMs))
    && Number(receipt.durationMs) >= 0;
}

export function validateHealthyPrimaryReceipt(receipt, policy, expectedNativeBinding = null) {
  const normalizedPolicy = normalizeRoutingPolicy(policy);
  const attempts = Array.isArray(receipt?.attempts) ? receipt.attempts : [];
  const attempt = attempts[0];
  const nativeBinding = nativeRequestBinding(receipt);
  const valid = Boolean(
    receipt?.id
    && receipt?.interactionId
    && receipt?.source === 'chat'
    && receipt?.status === 'succeeded'
    && receipt?.requestedProvider === normalizedPolicy.provider
    && receipt?.requestedModel === normalizedPolicy.model
    && receipt?.selectionMode === 'ordered_fallback'
    && receipt?.selectedProvider === normalizedPolicy.provider
    && receipt?.selectedModel === normalizedPolicy.model
    && !String(receipt?.fallbackReason || '')
    && attempts.length === 1
    && attempt?.provider === normalizedPolicy.provider
    && attempt?.model === normalizedPolicy.model
    && attempt?.status === 'succeeded'
    && routeTimestampValid(receipt)
    && validIso(attempt?.startedAt)
    && validIso(attempt?.completedAt)
    && validNativeRequestBinding(nativeBinding)
    && (!expectedNativeBinding || sameNativeRequestBinding(nativeBinding, expectedNativeBinding))
  );
  return valid
    ? { ok: true, code: '', receiptSha256: stableDigest(receipt) }
    : { ok: false, code: 'failover_baseline_primary_receipt_invalid' };
}

export function validateRealFailoverRoutingReceipt(receipt, checkpoint) {
  if (!receipt) return { ok: false, code: 'failover_routing_receipt_missing' };
  const attempts = Array.isArray(receipt.attempts) ? receipt.attempts : [];
  const first = attempts[0];
  const last = attempts[1];
  const primaryProvider = String(checkpoint?.routing?.primaryProvider || '');
  const primaryModel = String(checkpoint?.routing?.primaryModel || '');
  const lmstudioModel = String(checkpoint?.routing?.lmstudioModel || '');
  const expectedNativeBinding = {
    nativeDeviceId: String(checkpoint?.nativeClient?.nativeDeviceId || ''),
    executionSessionId: String(checkpoint?.nativeClient?.executionSessionId || ''),
    nativeClientIdentitySha256: String(checkpoint?.nativeClient?.identitySha256 || ''),
  };
  if (SYNTHETIC_PROVIDER_RE.test(primaryProvider) || SYNTHETIC_PROVIDER_RE.test(String(first?.provider || ''))) {
    return { ok: false, code: 'failover_synthetic_primary_rejected' };
  }
  if (
    receipt?.conversationId !== checkpoint?.lifecycle?.conversationId
    || receipt?.source !== 'chat'
    || receipt?.status !== 'succeeded'
    || receipt?.requestedProvider !== primaryProvider
    || receipt?.requestedModel !== primaryModel
    || receipt?.selectionMode !== 'ordered_fallback'
  ) return { ok: false, code: 'failover_routing_identity_mismatch' };
  if (!sameNativeRequestBinding(nativeRequestBinding(receipt), expectedNativeBinding)) {
    return { ok: false, code: 'failover_routing_native_client_binding_mismatch' };
  }
  if (receipt?.selectedProvider !== 'lmstudio' || receipt?.selectedModel !== lmstudioModel) {
    return { ok: false, code: 'failover_lmstudio_not_selected' };
  }
  if (attempts.length !== 2) return { ok: false, code: 'failover_route_not_direct_primary_to_lmstudio' };
  if (first?.provider !== primaryProvider || first?.model !== primaryModel || first?.status !== 'failed') {
    return { ok: false, code: 'failover_primary_actual_failure_missing' };
  }
  if (!ACTUAL_FAILURE_REASONS.has(String(first?.reason || '')) || !SHA256_RE.test(String(first?.errorDigest || ''))) {
    return { ok: false, code: 'failover_primary_failure_not_real_call_evidence' };
  }
  if (!String(first?.errorCategory || '').trim() || first?.visibleOutputCommitted === true) {
    return { ok: false, code: 'failover_primary_failure_safety_evidence_invalid' };
  }
  if (last?.provider !== 'lmstudio' || last?.model !== lmstudioModel || last?.status !== 'succeeded') {
    return { ok: false, code: 'failover_lmstudio_success_attempt_missing' };
  }
  if (!String(receipt?.fallbackReason || '').trim() || receipt.fallbackReason !== first.reason) {
    return { ok: false, code: 'failover_reason_missing_or_inconsistent' };
  }
  if (!routeTimestampValid(receipt)
    || !validIso(first?.startedAt) || !validIso(first?.completedAt)
    || !validIso(last?.startedAt) || !validIso(last?.completedAt)
    || timestamp(first.completedAt) > timestamp(last.startedAt)) {
    return { ok: false, code: 'failover_routing_chronology_invalid' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      receiptId: String(receipt.id || ''),
      interactionId: String(receipt.interactionId || ''),
      requestId: String(receipt.requestId || ''),
      requestedProvider: primaryProvider,
      requestedModel: primaryModel,
      selectedProvider: 'lmstudio',
      selectedModel: lmstudioModel,
      fallbackReason: String(receipt.fallbackReason),
      primaryFailureReason: String(first.reason),
      primaryFailureCategory: String(first.errorCategory),
      primaryFailureDigest: String(first.errorDigest),
      primaryDurationMs: Math.max(0, Number(first.durationMs) || 0),
      lmstudioDurationMs: Math.max(0, Number(last.durationMs) || 0),
      startedAt: new Date(receipt.startedAt).toISOString(),
      completedAt: new Date(receipt.completedAt).toISOString(),
      receiptSha256: stableDigest(receipt),
    },
  };
}

function validateHealth(health, expectedBuildId) {
  if (health?.status !== 'ok' || health?.database?.persistence?.degraded === true) {
    return { ok: false, code: 'failover_runtime_health_invalid' };
  }
  const buildId = String(health?.runtime?.buildId || '').trim().toLowerCase();
  if (!BUILD_ID_RE.test(buildId) || buildId !== String(expectedBuildId || '').toLowerCase()) {
    return { ok: false, code: 'failover_runtime_build_mismatch' };
  }
  if (health?.runtime?.sourceDirty !== false) {
    return { ok: false, code: 'failover_runtime_source_not_clean' };
  }
  const lmstudio = health?.functionalProbes?.localModels?.lmstudio;
  if (lmstudio?.reachable !== true || lmstudio?.inferenceHealthy !== true || Number(lmstudio?.modelCount || 0) < 1) {
    return { ok: false, code: 'failover_lmstudio_not_healthy' };
  }
  return { ok: true, code: '', buildId };
}

function receiptsForRequest(receipts, conversationId, requestId) {
  return (Array.isArray(receipts) ? receipts : []).filter(receipt => (
    receipt?.conversationId === conversationId
    && receipt?.requestId === requestId
    && receipt?.source === 'chat'
  ));
}

function findTask(runtime, taskId) {
  return (Array.isArray(runtime?.tasks) ? runtime.tasks : [])
    .find(task => String(task?.taskId || '') === String(taskId || '')) || null;
}

function taskReceiptForRequest(task, requestId) {
  return (Array.isArray(task?.evidence?.latest) ? task.evidence.latest : [])
    .find(receipt => receipt?.taskId === task?.taskId && receipt?.requestId === requestId) || null;
}

export function validatePreparedBaselineEvidence({
  health,
  policy,
  runtime,
  messages,
  routingReceipts,
  devices,
  observerIdentity,
  expectedBuildId,
  conversationId,
  taskId,
  baselineRequestId,
}) {
  const healthCheck = validateHealth(health, expectedBuildId);
  if (!healthCheck.ok) return healthCheck;
  const observerCheck = validateAcceptanceHarnessIdentity(observerIdentity, expectedBuildId);
  if (!observerCheck.ok) return observerCheck;
  const policyCheck = validateFormalRoutingPolicy(policy);
  if (!policyCheck.ok) return policyCheck;
  const task = findTask(runtime, taskId);
  if (!task) return { ok: false, code: 'failover_baseline_task_missing' };
  if (!PREPARE_TASK_STATUSES.has(String(task.status || '')) || task.activeRequest !== false) {
    return { ok: false, code: 'failover_baseline_task_not_waiting_safely' };
  }
  if (!Number.isInteger(Number(task.revision)) || Number(task.revision) < 1) {
    return { ok: false, code: 'failover_baseline_task_revision_invalid' };
  }
  const taskReceipt = taskReceiptForRequest(task, baselineRequestId);
  if (!taskReceipt) return { ok: false, code: 'failover_baseline_task_request_unbound' };
  const turn = validatePersistedTurn({ messages, conversationId, requestId: baselineRequestId });
  if (!turn.ok) return { ok: false, code: `baseline_${turn.code}` };
  const nativeBinding = {
    nativeDeviceId: turn.evidence.nativeDeviceId,
    executionSessionId: turn.evidence.executionSessionId,
    nativeClientIdentitySha256: turn.evidence.nativeClientIdentitySha256,
  };
  // The durable task receipt is bound to the exact task/request pair. Native
  // provenance is independently required on both transcript rows and the
  // model-routing receipt, which are produced directly by the Tauri request.
  const nativeClientCheck = validateNativeTauriDeviceEvidence(devices, {
    ...nativeBinding,
    expectedBuildId,
  });
  if (!nativeClientCheck.ok) return nativeClientCheck;
  const candidates = receiptsForRequest(routingReceipts, conversationId, baselineRequestId);
  if (candidates.length !== 1) {
    return { ok: false, code: candidates.length ? 'failover_baseline_routing_ambiguous' : 'failover_baseline_routing_missing' };
  }
  const route = validateHealthyPrimaryReceipt(candidates[0], policyCheck.policy, nativeBinding);
  if (!route.ok) return route;
  if (timestamp(candidates[0].completedAt) > timestamp(turn.assistant.timestamp)) {
    return { ok: false, code: 'failover_baseline_chronology_invalid' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      buildId: healthCheck.buildId,
      observer: observerCheck.evidence,
      nativeClient: {
        ...nativeClientCheck.evidence,
        executionSessionId: nativeBinding.executionSessionId,
      },
      task,
      taskReceipt,
      turn: turn.evidence,
      policy: policyCheck.policy,
      policySha256: policyCheck.policySha256,
      lmstudioModel: policyCheck.lmstudioModel,
      routingReceipt: candidates[0],
      routingReceiptSha256: route.receiptSha256,
    },
  };
}

function checkpointWithoutDigest(value) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    kind: 'formal-model-failover-recovery',
    marker: String(value?.marker || ''),
    preparedAt: String(value?.preparedAt || ''),
    buildId: String(value?.buildId || '').toLowerCase(),
    locations: {
      dataRootSha256: String(value?.locations?.dataRootSha256 || '').toLowerCase(),
      webview2UserDataDirSha256: String(value?.locations?.webview2UserDataDirSha256 || '').toLowerCase(),
      webview2ProfileDirSha256: String(value?.locations?.webview2ProfileDirSha256 || '').toLowerCase(),
    },
    observer: {
      clientKind: String(value?.observer?.clientKind || ''),
      role: String(value?.observer?.role || ''),
      eligibleAsNativeClientEvidence: value?.observer?.eligibleAsNativeClientEvidence === true,
      identitySha256: String(value?.observer?.identitySha256 || '').toLowerCase(),
    },
    nativeClient: {
      clientKind: String(value?.nativeClient?.clientKind || ''),
      nativeDeviceId: String(value?.nativeClient?.nativeDeviceId || ''),
      executionSessionId: String(value?.nativeClient?.executionSessionId || ''),
      identitySha256: String(value?.nativeClient?.identitySha256 || '').toLowerCase(),
      executableSha256: String(value?.nativeClient?.executableSha256 || '').toLowerCase(),
      buildId: String(value?.nativeClient?.buildId || '').toLowerCase(),
      sourceFingerprint: String(value?.nativeClient?.sourceFingerprint || '').toLowerCase(),
      sourceDirty: value?.nativeClient?.sourceDirty === true,
      trustLevel: String(value?.nativeClient?.trustLevel || ''),
      osAttested: value?.nativeClient?.osAttested === true,
      webviewProfileTrustLevel: String(value?.nativeClient?.webviewProfileTrustLevel || ''),
      webviewProfileBound: value?.nativeClient?.webviewProfileBound === true,
    },
    lifecycle: {
      conversationId: String(value?.lifecycle?.conversationId || ''),
      taskId: String(value?.lifecycle?.taskId || ''),
      baselineRequestId: String(value?.lifecycle?.baselineRequestId || ''),
      baselineRevision: Math.max(0, Math.trunc(Number(value?.lifecycle?.baselineRevision) || 0)),
      baselineStatus: String(value?.lifecycle?.baselineStatus || ''),
      baselineTaskUpdatedAt: String(value?.lifecycle?.baselineTaskUpdatedAt || ''),
      baselineTaskReceiptId: String(value?.lifecycle?.baselineTaskReceiptId || ''),
      baselineUserMessageId: String(value?.lifecycle?.baselineUserMessageId || ''),
      baselineAssistantMessageId: String(value?.lifecycle?.baselineAssistantMessageId || ''),
      baselineUserTextSha256: String(value?.lifecycle?.baselineUserTextSha256 || '').toLowerCase(),
      baselineAssistantTextSha256: String(value?.lifecycle?.baselineAssistantTextSha256 || '').toLowerCase(),
    },
    routing: {
      policySha256: String(value?.routing?.policySha256 || '').toLowerCase(),
      primaryProvider: String(value?.routing?.primaryProvider || '').toLowerCase(),
      primaryModel: String(value?.routing?.primaryModel || ''),
      selectionMode: String(value?.routing?.selectionMode || ''),
      lmstudioModel: String(value?.routing?.lmstudioModel || ''),
      baselineReceiptId: String(value?.routing?.baselineReceiptId || ''),
      baselineReceiptSha256: String(value?.routing?.baselineReceiptSha256 || '').toLowerCase(),
    },
  };
}

export function buildFailoverCheckpoint({ marker, preparedAt, locationBindings, baseline, identities }) {
  const checkpoint = checkpointWithoutDigest({
    marker,
    preparedAt,
    buildId: baseline?.buildId,
    locations: locationBindings,
    observer: baseline?.observer,
    nativeClient: baseline?.nativeClient,
    lifecycle: {
      conversationId: identities?.conversationId,
      taskId: identities?.taskId,
      baselineRequestId: identities?.baselineRequestId,
      baselineRevision: baseline?.task?.revision,
      baselineStatus: baseline?.task?.status,
      baselineTaskUpdatedAt: baseline?.task?.updatedAt,
      baselineTaskReceiptId: baseline?.taskReceipt?.receiptId,
      baselineUserMessageId: baseline?.turn?.userMessageId,
      baselineAssistantMessageId: baseline?.turn?.assistantMessageId,
      baselineUserTextSha256: baseline?.turn?.userTextSha256,
      baselineAssistantTextSha256: baseline?.turn?.assistantTextSha256,
    },
    routing: {
      policySha256: baseline?.policySha256,
      primaryProvider: baseline?.policy?.provider,
      primaryModel: baseline?.policy?.model,
      selectionMode: baseline?.policy?.selectionMode,
      lmstudioModel: baseline?.lmstudioModel,
      baselineReceiptId: baseline?.routingReceipt?.id,
      baselineReceiptSha256: baseline?.routingReceiptSha256,
    },
  });
  return { ...checkpoint, checkpointSha256: stableDigest(checkpoint) };
}

function sameBindings(left, right) {
  return ['dataRootSha256', 'webview2UserDataDirSha256', 'webview2ProfileDirSha256']
    .every(key => String(left?.[key] || '') === String(right?.[key] || ''));
}

export function validateFailoverCheckpoint(value, locationBindings) {
  const checkpoint = checkpointWithoutDigest(value);
  if (Number(value?.schemaVersion) !== CHECKPOINT_SCHEMA_VERSION || value?.kind !== 'formal-model-failover-recovery') {
    return { ok: false, code: 'failover_checkpoint_schema_invalid', checkpoint };
  }
  if (!MARKER_RE.test(checkpoint.marker) || !validIso(checkpoint.preparedAt) || !BUILD_ID_RE.test(checkpoint.buildId)) {
    return { ok: false, code: 'failover_checkpoint_identity_invalid', checkpoint };
  }
  if (!Object.values(checkpoint.locations).every(hash => SHA256_RE.test(hash))
    || !sameBindings(checkpoint.locations, locationBindings)) {
    return { ok: false, code: 'failover_checkpoint_location_mismatch', checkpoint };
  }
  if (checkpoint.observer.clientKind !== 'local_acceptance_harness'
    || checkpoint.observer.role !== 'read_only_authenticated_observer'
    || checkpoint.observer.eligibleAsNativeClientEvidence !== false
    || !SHA256_RE.test(checkpoint.observer.identitySha256)) {
    return { ok: false, code: 'failover_checkpoint_observer_identity_invalid', checkpoint };
  }
  const nativeClient = checkpoint.nativeClient;
  if (nativeClient.clientKind !== 'tauri'
    || !validBindingId(nativeClient.nativeDeviceId)
    || !validBindingId(nativeClient.executionSessionId)
    || !SHA256_RE.test(nativeClient.identitySha256)
    || !SHA256_RE.test(nativeClient.executableSha256)
    || nativeClient.buildId !== checkpoint.buildId
    || !SHA256_RE.test(nativeClient.sourceFingerprint)
    || nativeClient.sourceDirty !== false
    || nativeClient.trustLevel !== 'proof_bound_local_claim'
    || nativeClient.osAttested !== false
    || nativeClient.webviewProfileTrustLevel !== 'unbound'
    || nativeClient.webviewProfileBound !== false) {
    return { ok: false, code: 'failover_checkpoint_native_client_identity_invalid', checkpoint };
  }
  const lifecycle = checkpoint.lifecycle;
  if (![lifecycle.conversationId, lifecycle.taskId, lifecycle.baselineRequestId,
    lifecycle.baselineTaskReceiptId, lifecycle.baselineUserMessageId, lifecycle.baselineAssistantMessageId]
    .every(candidate => SAFE_ID_RE.test(candidate))
    || lifecycle.baselineRevision < 1
    || lifecycle.baselineStatus !== 'waiting_confirmation'
    || !validIso(lifecycle.baselineTaskUpdatedAt)
    || !SHA256_RE.test(lifecycle.baselineUserTextSha256)
    || !SHA256_RE.test(lifecycle.baselineAssistantTextSha256)) {
    return { ok: false, code: 'failover_checkpoint_lifecycle_invalid', checkpoint };
  }
  const routing = checkpoint.routing;
  if (!SHA256_RE.test(routing.policySha256)
    || !routing.primaryProvider || ['auto', 'ollama', 'lmstudio'].includes(routing.primaryProvider)
    || SYNTHETIC_PROVIDER_RE.test(routing.primaryProvider)
    || !routing.primaryModel || routing.selectionMode !== 'ordered_fallback'
    || !routing.lmstudioModel || !SAFE_ID_RE.test(routing.baselineReceiptId)
    || !SHA256_RE.test(routing.baselineReceiptSha256)) {
    return { ok: false, code: 'failover_checkpoint_routing_invalid', checkpoint };
  }
  if (!SHA256_RE.test(String(value?.checkpointSha256 || ''))
    || stableDigest(checkpoint) !== String(value.checkpointSha256).toLowerCase()) {
    return { ok: false, code: 'failover_checkpoint_digest_invalid', checkpoint };
  }
  return { ok: true, code: '', checkpoint: { ...checkpoint, checkpointSha256: value.checkpointSha256 } };
}

export function validateFailoverRecoveryEvidence({
  checkpoint: rawCheckpoint,
  locationBindings,
  health,
  policy,
  runtime,
  messages,
  routingReceipts,
  devices,
  observerIdentity,
  continuationRequestId,
}) {
  const checked = validateFailoverCheckpoint(rawCheckpoint, locationBindings);
  if (!checked.ok) return checked;
  const checkpoint = checked.checkpoint;
  if (!SAFE_ID_RE.test(continuationRequestId) || continuationRequestId === checkpoint.lifecycle.baselineRequestId) {
    return { ok: false, code: 'failover_continuation_request_identity_invalid' };
  }
  const healthCheck = validateHealth(health, checkpoint.buildId);
  if (!healthCheck.ok) return healthCheck;
  const observerCheck = validateAcceptanceHarnessIdentity(observerIdentity, checkpoint.buildId);
  if (!observerCheck.ok) return observerCheck;
  const policyCheck = validateFormalRoutingPolicy(policy);
  if (!policyCheck.ok) return policyCheck;
  if (policyCheck.policySha256 !== checkpoint.routing.policySha256
    || policyCheck.policy.provider !== checkpoint.routing.primaryProvider
    || policyCheck.policy.model !== checkpoint.routing.primaryModel
    || policyCheck.lmstudioModel !== checkpoint.routing.lmstudioModel) {
    return { ok: false, code: 'failover_policy_changed_after_prepare' };
  }
  const task = findTask(runtime, checkpoint.lifecycle.taskId);
  if (!task) return { ok: false, code: 'failover_continuation_task_missing' };
  if (Number(task.revision) <= checkpoint.lifecycle.baselineRevision) {
    return { ok: false, code: 'failover_continuation_task_revision_not_advanced' };
  }
  if (!RECOVERED_TASK_STATUSES.has(String(task.status || '')) || task.activeRequest !== false) {
    return { ok: false, code: 'failover_continuation_task_not_recovered' };
  }
  const taskReceipt = taskReceiptForRequest(task, continuationRequestId);
  if (!taskReceipt) return { ok: false, code: 'failover_continuation_task_receipt_missing' };
  const expectedNativeBinding = {
    nativeDeviceId: checkpoint.nativeClient.nativeDeviceId,
    executionSessionId: checkpoint.nativeClient.executionSessionId,
    nativeClientIdentitySha256: checkpoint.nativeClient.identitySha256,
  };
  const turn = validatePersistedTurn({
    messages,
    conversationId: checkpoint.lifecycle.conversationId,
    requestId: continuationRequestId,
    requiredMarker: checkpoint.marker,
    expectedNativeBinding,
  });
  if (!turn.ok) return turn;
  const nativeClientCheck = validateNativeTauriDeviceEvidence(devices, {
    nativeDeviceId: checkpoint.nativeClient.nativeDeviceId,
    nativeClientIdentitySha256: checkpoint.nativeClient.identitySha256,
    expectedBuildId: checkpoint.buildId,
  });
  if (!nativeClientCheck.ok) return nativeClientCheck;
  const candidates = receiptsForRequest(
    routingReceipts,
    checkpoint.lifecycle.conversationId,
    continuationRequestId,
  );
  if (candidates.length === 0) return { ok: false, code: 'failover_routing_receipt_missing' };
  if (candidates.length !== 1) return { ok: false, code: 'failover_routing_receipt_ambiguous' };
  if (candidates[0]?.requestId !== continuationRequestId || candidates[0]?.id === checkpoint.routing.baselineReceiptId) {
    return { ok: false, code: 'failover_routing_request_identity_invalid' };
  }
  const route = validateRealFailoverRoutingReceipt(candidates[0], checkpoint);
  if (!route.ok) return route;
  const preparedAt = timestamp(checkpoint.preparedAt);
  const userAt = timestamp(turn.user.timestamp);
  const assistantAt = timestamp(turn.assistant.timestamp);
  const routeStartedAt = timestamp(candidates[0].startedAt);
  const routeCompletedAt = timestamp(candidates[0].completedAt);
  if (userAt < preparedAt || routeStartedAt < userAt || routeCompletedAt > assistantAt
    || !validIso(task.updatedAt) || timestamp(task.updatedAt) < userAt) {
    return { ok: false, code: 'failover_recovery_chronology_invalid' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      buildId: checkpoint.buildId,
      marker: checkpoint.marker,
      locationBindings: checkpoint.locations,
      observer: observerCheck.evidence,
      nativeClient: {
        ...nativeClientCheck.evidence,
        executionSessionId: checkpoint.nativeClient.executionSessionId,
      },
      lifecycle: {
        conversationId: checkpoint.lifecycle.conversationId,
        taskId: checkpoint.lifecycle.taskId,
        baselineRequestId: checkpoint.lifecycle.baselineRequestId,
        continuationRequestId,
        baselineRevision: checkpoint.lifecycle.baselineRevision,
        recoveredRevision: Number(task.revision),
        recoveredStatus: String(task.status),
        activeRequest: task.activeRequest === true,
        taskReceiptId: String(taskReceipt.receiptId || ''),
        transcript: turn.evidence,
      },
      routing: route.evidence,
    },
  };
}

export function buildSanitizedFailoverEvidence(result) {
  const phase = result?.phase === 'verify' ? 'verify' : 'prepare';
  const evidence = result?.evidence || {};
  const lifecycle = evidence.lifecycle || {};
  const routing = evidence.routing || {};
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: 'formal-model-failover-recovery',
    phase,
    ok: result?.ok === true,
    recordedAt: new Date().toISOString(),
    marker: String(result?.marker || evidence?.marker || ''),
    observationBoundary: {
      failureInducedByScript: false,
      chatTurnSentByScript: false,
      clientOperatedByScript: false,
      processOperatedByScript: false,
      modelPreferencesChangedByScript: false,
      networkChangedByScript: false,
      credentialsChangedByScript: false,
    },
    buildId: String(evidence?.buildId || ''),
    observer: evidence?.observer ? {
      clientKind: String(evidence.observer.clientKind || ''),
      identitySha256: String(evidence.observer.identitySha256 || ''),
      role: String(evidence.observer.role || ''),
      eligibleAsNativeClientEvidence: evidence.observer.eligibleAsNativeClientEvidence === true,
    } : undefined,
    nativeClient: evidence?.nativeClient ? {
      clientKind: String(evidence.nativeClient.clientKind || ''),
      nativeDeviceId: String(evidence.nativeClient.nativeDeviceId || ''),
      executionSessionId: String(evidence.nativeClient.executionSessionId || ''),
      identitySha256: String(evidence.nativeClient.identitySha256 || ''),
      executableSha256: String(evidence.nativeClient.executableSha256 || ''),
      buildId: String(evidence.nativeClient.buildId || ''),
      sourceFingerprint: String(evidence.nativeClient.sourceFingerprint || ''),
      sourceDirty: evidence.nativeClient.sourceDirty === true,
      trustLevel: String(evidence.nativeClient.trustLevel || ''),
      osAttested: evidence.nativeClient.osAttested === true,
      webviewProfileTrustLevel: String(evidence.nativeClient.webviewProfileTrustLevel || ''),
      webviewProfileBound: evidence.nativeClient.webviewProfileBound === true,
    } : undefined,
    locationBindings: {
      dataRootSha256: String(evidence?.locationBindings?.dataRootSha256 || ''),
      webview2UserDataDirSha256: String(evidence?.locationBindings?.webview2UserDataDirSha256 || ''),
      webview2ProfileDirSha256: String(evidence?.locationBindings?.webview2ProfileDirSha256 || ''),
    },
    lifecycle: {
      conversationId: String(lifecycle?.conversationId || ''),
      taskId: String(lifecycle?.taskId || ''),
      baselineRequestId: String(lifecycle?.baselineRequestId || ''),
      continuationRequestId: String(lifecycle?.continuationRequestId || ''),
      baselineRevision: Math.max(0, Number(lifecycle?.baselineRevision) || 0),
      recoveredRevision: Math.max(0, Number(lifecycle?.recoveredRevision) || 0),
      recoveredStatus: String(lifecycle?.recoveredStatus || ''),
      activeRequest: lifecycle?.activeRequest === true,
      taskReceiptId: String(lifecycle?.taskReceiptId || ''),
      transcript: lifecycle?.transcript ? {
        userMessageId: String(lifecycle.transcript.userMessageId || ''),
        assistantMessageId: String(lifecycle.transcript.assistantMessageId || ''),
        userTextSha256: String(lifecycle.transcript.userTextSha256 || ''),
        assistantTextSha256: String(lifecycle.transcript.assistantTextSha256 || ''),
        userCharacterCount: Math.max(0, Number(lifecycle.transcript.userCharacterCount) || 0),
        assistantCharacterCount: Math.max(0, Number(lifecycle.transcript.assistantCharacterCount) || 0),
        userTimestamp: String(lifecycle.transcript.userTimestamp || ''),
        assistantTimestamp: String(lifecycle.transcript.assistantTimestamp || ''),
      } : undefined,
    },
    routing: {
      receiptId: String(routing?.receiptId || ''),
      interactionId: String(routing?.interactionId || ''),
      requestId: String(routing?.requestId || ''),
      requestedProvider: String(routing?.requestedProvider || ''),
      requestedModel: String(routing?.requestedModel || ''),
      selectedProvider: String(routing?.selectedProvider || ''),
      selectedModel: String(routing?.selectedModel || ''),
      fallbackReason: String(routing?.fallbackReason || ''),
      primaryFailureReason: String(routing?.primaryFailureReason || ''),
      primaryFailureCategory: String(routing?.primaryFailureCategory || ''),
      primaryFailureDigest: String(routing?.primaryFailureDigest || ''),
      primaryDurationMs: Math.max(0, Number(routing?.primaryDurationMs) || 0),
      lmstudioDurationMs: Math.max(0, Number(routing?.lmstudioDurationMs) || 0),
      startedAt: String(routing?.startedAt || ''),
      completedAt: String(routing?.completedAt || ''),
      receiptSha256: String(routing?.receiptSha256 || ''),
    },
    checkpointSha256: String(result?.checkpointSha256 || ''),
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    evidenceClassification: 'restricted_private_local',
    publishable: false,
  };
}

function evidencePath(evidenceRoot, marker, phase) {
  if (!path.isAbsolute(evidenceRoot) || !MARKER_RE.test(marker) || !['prepare', 'verify'].includes(phase)) {
    throw new FailoverProtocolError('failover_evidence_path_invalid');
  }
  const output = path.resolve(evidenceRoot, `formal-model-failover-recovery-${marker}-${phase}.json`);
  if (!isLexicallyInside(evidenceRoot, output)) throw new FailoverProtocolError('failover_evidence_path_escape');
  return output;
}

function writeJsonExclusive(outputPath, value, failureCode) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch {
    throw new FailoverProtocolError(failureCode);
  }
}

export function writeFailoverEvidenceExclusive(evidenceRoot, result) {
  const output = evidencePath(evidenceRoot, result.marker, result.phase);
  writeJsonExclusive(output, buildSanitizedFailoverEvidence(result), 'failover_evidence_write_failed');
  return output;
}

function writeCheckpointExclusive(checkpointPath, checkpoint) {
  writeJsonExclusive(checkpointPath, checkpoint, 'failover_checkpoint_write_failed');
}

function readCheckpoint(checkpointPath, locationBindings) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch {
    throw new FailoverProtocolError('failover_checkpoint_unreadable');
  }
  const checked = validateFailoverCheckpoint(parsed, locationBindings);
  if (!checked.ok) throw new FailoverProtocolError(checked.code);
  return checked.checkpoint;
}

function currentGitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
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

async function getJson(baseUrl, pathname, token, query = {}, timeoutMs = 30_000) {
  let response;
  try {
    response = await fetch(apiUrl(baseUrl, pathname, query), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FailoverProtocolError('local_api_unreachable');
  }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new FailoverProtocolError(`local_api_http_${response.status}`);
  return body;
}

async function authenticate(args) {
  try {
    const session = await bootstrapDesktopTestSession(args.baseUrl, args.dataRoot, { timeoutMs: 15_000 });
    const token = String(session?.token || '');
    const observerIdentity = session?.nativeClientIdentity;
    if (!token || !observerIdentity) throw new Error('missing observer identity');
    return { token, observerIdentity };
  } catch {
    throw new FailoverProtocolError('desktop_bootstrap_failed');
  }
}

async function observe(args, token, requestId, observerIdentity) {
  const [health, policy, runtime, transcriptBody, routingBody, devicesBody] = await Promise.all([
    getJson(args.baseUrl, '/health', token, { details: 1 }),
    getJson(args.baseUrl, '/preferences/llm', token),
    getJson(args.baseUrl, '/runtime/status', token, { domain: 'personal' }),
    getJson(args.baseUrl, `/conversations/${encodeURIComponent(args.conversationId)}/messages`, token, {
      domain: 'personal', limit: 1000,
    }),
    getJson(args.baseUrl, '/preferences/llm/routing-receipts', token, {
      conversationId: args.conversationId, requestId, limit: 100,
    }),
    getJson(args.baseUrl, '/devices', token),
  ]);
  return {
    health,
    policy,
    runtime,
    messages: Array.isArray(transcriptBody?.messages) ? transcriptBody.messages : [],
    routingReceipts: Array.isArray(routingBody?.receipts) ? routingBody.receipts : [],
    devices: Array.isArray(devicesBody?.devices) ? devicesBody.devices : [],
    observerIdentity,
  };
}

async function prepare(args) {
  applyFormalFilesystemLayout(args);
  if (fs.existsSync(args.checkpoint)) throw new FailoverProtocolError('failover_checkpoint_exists');
  const expectedBuildId = String(args.expectedBuildId || currentGitHead()).toLowerCase();
  if (!BUILD_ID_RE.test(expectedBuildId)) throw new FailoverProtocolError('expected_build_id_required');
  const authenticated = await authenticate(args);
  const observed = await observe(
    args,
    authenticated.token,
    args.baselineRequestId,
    authenticated.observerIdentity,
  );
  const baseline = validatePreparedBaselineEvidence({
    ...observed,
    expectedBuildId,
    conversationId: args.conversationId,
    taskId: args.taskId,
    baselineRequestId: args.baselineRequestId,
  });
  if (!baseline.ok) throw new FailoverProtocolError(baseline.code);
  const marker = `LUMI-E2E-FAILOVER-${crypto.randomBytes(8).toString('hex')}`;
  const preparedAt = new Date().toISOString();
  const checkpoint = buildFailoverCheckpoint({
    marker,
    preparedAt,
    locationBindings: args.locationBindings,
    baseline: baseline.evidence,
    identities: {
      conversationId: args.conversationId,
      taskId: args.taskId,
      baselineRequestId: args.baselineRequestId,
    },
  });
  const checked = validateFailoverCheckpoint(checkpoint, args.locationBindings);
  if (!checked.ok) throw new FailoverProtocolError(checked.code);
  writeCheckpointExclusive(args.checkpoint, checkpoint);
  const result = {
    ok: true,
    phaseComplete: true,
    packageComplete: false,
    phase: 'prepare',
    marker,
    checkpointPath: args.checkpoint,
    checkpointSha256: checkpoint.checkpointSha256,
    failureRequiredOutsideScript: true,
    failureInducedByScript: false,
    evidence: {
      buildId: checkpoint.buildId,
      marker,
      locationBindings: checkpoint.locations,
      observer: checkpoint.observer,
      nativeClient: checkpoint.nativeClient,
      lifecycle: {
        conversationId: checkpoint.lifecycle.conversationId,
        taskId: checkpoint.lifecycle.taskId,
        baselineRequestId: checkpoint.lifecycle.baselineRequestId,
        baselineRevision: checkpoint.lifecycle.baselineRevision,
        recoveredStatus: checkpoint.lifecycle.baselineStatus,
        activeRequest: false,
        taskReceiptId: checkpoint.lifecycle.baselineTaskReceiptId,
        transcript: baseline.evidence.turn,
      },
      routing: {
        receiptId: checkpoint.routing.baselineReceiptId,
        requestId: checkpoint.lifecycle.baselineRequestId,
        requestedProvider: checkpoint.routing.primaryProvider,
        requestedModel: checkpoint.routing.primaryModel,
        selectedProvider: checkpoint.routing.primaryProvider,
        selectedModel: checkpoint.routing.primaryModel,
        receiptSha256: checkpoint.routing.baselineReceiptSha256,
      },
    },
    nextStep: [
      'Create or wait for a real primary-provider failure outside this script.',
      `Continue the same task in the native client and include this exact marker: ${marker}`,
      'Ensure that continuation produces a durable task receipt, record its requestId, then run verify.',
      'Do not change Lumi model preferences; verify rejects any policy change.',
    ],
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
  };
  result.evidencePath = writeFailoverEvidenceExclusive(args.evidenceRoot, result);
  return result;
}

async function verify(args) {
  applyFormalFilesystemLayout(args);
  const checkpoint = readCheckpoint(args.checkpoint, args.locationBindings);
  if (args.expectedBuildId && args.expectedBuildId !== checkpoint.buildId) {
    throw new FailoverProtocolError('expected_build_id_checkpoint_mismatch');
  }
  if (args.continuationRequestId === checkpoint.lifecycle.baselineRequestId) {
    throw new FailoverProtocolError('failover_continuation_request_identity_invalid');
  }
  args.conversationId = checkpoint.lifecycle.conversationId;
  const authenticated = await authenticate(args);
  const deadline = Date.now() + args.timeoutMs;
  let latest = { ok: false, code: 'failover_evidence_not_observed' };
  while (Date.now() < deadline) {
    const observed = await observe(
      args,
      authenticated.token,
      args.continuationRequestId,
      authenticated.observerIdentity,
    );
    latest = validateFailoverRecoveryEvidence({
      checkpoint,
      locationBindings: args.locationBindings,
      ...observed,
      continuationRequestId: args.continuationRequestId,
    });
    if (latest.ok) break;
    if (!PENDING_VERIFY_CODES.has(latest.code)) throw new FailoverProtocolError(latest.code);
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  if (!latest.ok) throw new FailoverProtocolError(latest.code || 'failover_verify_timeout');
  const result = {
    ok: true,
    phaseComplete: true,
    packageComplete: false,
    phase: 'verify',
    marker: checkpoint.marker,
    checkpointPath: args.checkpoint,
    checkpointSha256: checkpoint.checkpointSha256,
    failureInducedByScript: false,
    sameTaskRecovered: true,
    evidence: latest.evidence,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
  };
  result.evidencePath = writeFailoverEvidenceExclusive(args.evidenceRoot, result);
  return result;
}

/**
 * A specialized evidence producer can report that its own protocol checks
 * succeeded, but it is never the Stage 9 acceptance adjudicator. Exit 2 keeps
 * that distinction machine-readable for every successful prepare/verify run.
 */
export function failoverEvidenceCliExitCode(result) {
  return formalStage9ProducerEvidenceExitCode(result);
}

export async function createFailoverFormalStage9ProducerEvidence(options = {}) {
  return createFormalStage9FileBackedProducerEvidence({
    ...options,
    producer: 'failover',
    payload: options.payload || {
      prepare: options.prepare,
      verify: options.verify,
    },
  });
}

async function main() {
  let result;
  try {
    const args = parseFailoverArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      // Exit zero is reserved for adjudicated acceptance, never for help.
      process.exitCode = 1;
      return;
    }
    result = args.mode === 'prepare' ? await prepare(args) : await verify(args);
  } catch (error) {
    result = {
      ok: false,
      phaseComplete: false,
      packageComplete: false,
      phase: process.argv[2] || 'unknown',
      failedCheck: error instanceof FailoverProtocolError ? error.code : 'unexpected_failover_protocol_failure',
      failureInducedByScript: false,
      chatTurnSentByScript: false,
      clientOperatedByScript: false,
    };
  }
  process.exitCode = failoverEvidenceCliExitCode(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
