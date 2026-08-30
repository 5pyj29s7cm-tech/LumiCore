import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { io as createSocketClient } from 'socket.io-client';
import { WebSocketServer } from 'ws';

import { bootstrapDesktopTestSession } from './desktop-bootstrap.mjs';
import {
  computeTaskRegressionBuildIdentity,
  projectTaskRegressionMatrixBuildIdentity,
} from './task-regression-build-identity.mjs';
import {
  TASK_REGRESSION_RUN_KIND,
  TASK_REGRESSION_RUN_SCHEMA_VERSION,
  TASK_REGRESSION_SCENARIOS,
  taskRegressionBuildIdentityDigest,
  taskRegressionDigest,
  summarizeTaskRegressionRun,
  validateTaskRegressionRun,
  validateTaskTruthSnapshot,
} from './task-regression-matrix.mjs';

export const TASK_REGRESSION_PROBE_KIND = 'lumi.task-regression-black-box-probe';
export const TASK_REGRESSION_PROBE_SCHEMA_VERSION = 1;
export const DEFAULT_TRUTH_SNAPSHOT_ENDPOINT = '/acceptance/task-regression/snapshot';
export const DEFAULT_STALE_RECEIPT_ENDPOINT = '/acceptance/task-regression/stale-receipt';
export const DEFAULT_SERVER_TRUTH_SIGNER_ENDPOINT =
  '/acceptance/task-regression/server-truth-signer';
export const TASK_REGRESSION_PROOF_HEADER = 'X-Lumi-Task-Regression-Proof';
export const TASK_REGRESSION_SIGNER_BOOTSTRAP_HEADER =
  'X-Lumi-Task-Regression-Signer-Bootstrap';
export const TASK_REGRESSION_ISOLATION_MANIFEST = 'task-regression-evidence.json';
export const IMPLEMENTED_BLACK_BOX_SCENARIOS = Object.freeze([
  'cleanup_offer_then_cleanup',
  'repeated_confirmation_exactly_once',
  'wps_wrong_file_correction',
  'displayed_result_stale_receipt',
  'control_stop_status_repeat',
  'voice_to_text_continuation',
  'mid_task_restart_recovery',
  'primary_model_failover_lmstudio',
]);

const MATRIX_TRUTH_LAYOUT = Object.freeze({
  cleanup_offer_then_cleanup: Object.freeze({ single: 'truthSnapshot' }),
  repeated_confirmation_exactly_once: Object.freeze({ single: 'truthSnapshot' }),
  wps_wrong_file_correction: Object.freeze({
    multiple: Object.freeze(['anchor', 'supplyFilename']),
  }),
  displayed_result_stale_receipt: Object.freeze({ single: 'truthSnapshot' }),
  control_stop_status_repeat: Object.freeze({ single: 'truthSnapshot' }),
  voice_to_text_continuation: Object.freeze({ single: 'truthSnapshot' }),
  mid_task_restart_recovery: Object.freeze({
    multiple: Object.freeze([
      'prepareBeforeRestart',
      'prepareAfterRestart',
      'continueAfterRestart',
    ]),
  }),
  primary_model_failover_lmstudio: Object.freeze({ single: 'truthSnapshot' }),
});

// The restart probe intentionally has two stricter harness-only gates beyond
// the public v1 matrix contract. They must pass before the three public checks
// may be assembled; omitting them would silently weaken the live recovery
// boundary while still yielding a schema-valid artifact.
const MATRIX_HARNESS_ONLY_CHECKS = Object.freeze({
  mid_task_restart_recovery: Object.freeze([
    'confirmation_consumed_exactly_once',
    'restart_feedback_and_model_input_bound',
  ]),
});

// The request that owns each scenario's truth snapshot is fixed before the
// backend starts and sealed into its isolation manifest. This prevents a
// loopback caller from relabelling one persisted request as another scenario.
const TRUTH_SNAPSHOT_REQUEST_PHASE = Object.freeze({
  cleanup_offer_then_cleanup: 'cleanup',
  repeated_confirmation_exactly_once: 'confirm-first',
  displayed_result_stale_receipt: 'display',
  control_stop_status_repeat: 'long',
  voice_to_text_continuation: 'text_continue',
  primary_model_failover_lmstudio: 'failover',
});
const DISPLAYED_STALE_RECEIPT_PHASES = Object.freeze(['display', 'continue']);
const MID_TASK_RESTART_PHASES = Object.freeze(['prepare', 'continue']);
const WPS_WRONG_FILE_CORRECTION_PHASES = Object.freeze([
  'anchor',
  'correction',
  'supply-filename',
]);

const LOOPBACK_HOST = '127.0.0.1';
const MAX_LOG_BYTES = 256 * 1024;
const SERVER_TRUTH_SIGNATURE_DOMAIN =
  'lumi-voice-text-continuation-truth-attestation-v1\0';
const SERVER_TRUTH_KEY_ID_DOMAIN =
  'lumi-voice-text-continuation-truth-ed25519-key-v1\0';
const PORTABLE_DATA_ROOT_IDENTITY_DOMAIN =
  'lumi-portable-evidence-data-root-v1\0';
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SECRET_ENV_RE = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSKEY|CREDENTIAL|AUTH|COOKIE|WEBHOOK|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/iu;
const SAFE_PARENT_ENV = Object.freeze([
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
]);

export class TaskRegressionBlackBoxError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'TaskRegressionBlackBoxError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new TaskRegressionBlackBoxError(code, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeIsolatedPptxFixture(filePath, text) {
  const imported = await import('pptxgenjs');
  const PptxGenJS = imported.default || imported;
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'Lumi isolated task regression';
  presentation.subject = 'WPS current-document black-box fixture';
  presentation.title = path.basename(filePath);
  presentation.company = 'LumiCore';
  presentation.lang = 'zh-CN';
  const slide = presentation.addSlide();
  slide.addText(text, {
    x: 0.75,
    y: 0.75,
    w: 11.8,
    h: 5.8,
    fontFace: 'Arial',
    fontSize: 22,
    breakLine: false,
  });
  const generated = await presentation.write({
    outputType: 'nodebuffer',
    compression: true,
  });
  const bytes = Buffer.isBuffer(generated)
    ? generated
    : Buffer.from(generated);
  if (bytes.length < 1 || bytes.length > 100 * 1024) {
    fail('regression_wps_pptx_fixture_size_invalid', { bytes: bytes.length });
  }
  await fsp.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
  return bytes;
}

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('probe_canonical_json_cycle');
    seen.add(value);
    const output = value.map(item => stableValue(item, seen));
    seen.delete(value);
    return output;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) fail('probe_canonical_json_invalid');
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('probe_canonical_json_undefined');
    output[key] = stableValue(value[key], seen);
  }
  seen.delete(value);
  return output;
}

export function stableTaskRegressionProbeJson(value, pretty = false) {
  return JSON.stringify(stableValue(value), null, pretty ? 2 : 0);
}

function exactRecord(value, expectedKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) fail(code);
  return value;
}

function portableDataRootIdentitySha256(value) {
  return crypto.createHash('sha256')
    .update(PORTABLE_DATA_ROOT_IDENTITY_DOMAIN, 'utf8')
    .update(normalizedPath(value), 'utf8')
    .digest('hex');
}

function serverTruthSignerKeyId(publicKeySpki) {
  return crypto.createHash('sha256')
    .update(SERVER_TRUTH_KEY_ID_DOMAIN, 'utf8')
    .update(publicKeySpki)
    .digest('hex');
}

export function normalizeTaskRegressionServerTruthSigner(value, expected) {
  const descriptor = exactRecord(value, [
    'kind', 'schemaVersion', 'algorithm', 'keyId', 'publicKeySpkiBase64',
    'serverInstanceNonce', 'acceptanceRunId', 'buildIdentityDigest',
    'dataRootIdentitySha256',
  ], 'regression_server_truth_signer_invalid');
  let publicKeySpki;
  let publicKey;
  try {
    publicKeySpki = Buffer.from(String(descriptor.publicKeySpkiBase64 || ''), 'base64');
    if (publicKeySpki.length === 0
      || publicKeySpki.toString('base64') !== descriptor.publicKeySpkiBase64) {
      fail('regression_server_truth_signer_invalid');
    }
    publicKey = crypto.createPublicKey({ key: publicKeySpki, format: 'der', type: 'spki' });
  } catch (error) {
    if (error instanceof TaskRegressionBlackBoxError) throw error;
    fail('regression_server_truth_signer_invalid');
  }
  if (descriptor.kind !== 'lumi.voice-text-continuation-truth-signer'
    || descriptor.schemaVersion !== 1
    || descriptor.algorithm !== 'ed25519'
    || publicKey.asymmetricKeyType !== 'ed25519'
    || descriptor.keyId !== serverTruthSignerKeyId(publicKeySpki)
    || !SHA256_RE.test(String(descriptor.keyId || ''))
    || !/^[A-Za-z0-9_-]{22,192}$/u.test(String(descriptor.serverInstanceNonce || ''))
    || descriptor.acceptanceRunId !== expected.acceptanceRunId
    || descriptor.buildIdentityDigest !== expected.buildIdentityDigest
    || descriptor.dataRootIdentitySha256 !== expected.dataRootIdentitySha256) {
    fail('regression_server_truth_signer_binding_invalid');
  }
  return Object.freeze({
    kind: descriptor.kind,
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId: descriptor.keyId,
    publicKeySpkiBase64: descriptor.publicKeySpkiBase64,
    serverInstanceNonce: descriptor.serverInstanceNonce,
    acceptanceRunId: descriptor.acceptanceRunId,
    buildIdentityDigest: descriptor.buildIdentityDigest,
    dataRootIdentitySha256: descriptor.dataRootIdentitySha256,
  });
}

/**
 * Consumes the isolated backend's one-time signer bootstrap before any S6
 * phase. The returned contract is the public descriptor that an outer signed
 * evidence manifest must pin; the backend private key never crosses this API.
 */
export async function pinTaskRegressionServerTruthSigner(input) {
  const acceptanceRunId = String(input?.acceptanceRunId || '');
  const buildIdentityDigest = String(input?.buildIdentityDigest || '').toLowerCase();
  const token = String(input?.token || '');
  const signerBootstrap = String(input?.evidenceAccess?.signerBootstrap || '');
  const signerBootstrapSha256 = String(
    input?.evidenceAccess?.signerBootstrapSha256 || '',
  ).toLowerCase();
  const dataRoot = String(input?.dataRoot || '');
  const expectedDataRoot = String(input?.evidenceAccess?.dataRoot || '');
  const dataRootIdentitySha256 = portableDataRootIdentitySha256(dataRoot);
  if (!acceptanceRunId
    || input?.evidenceAccess?.acceptanceRunId !== acceptanceRunId
    || !path.isAbsolute(dataRoot)
    || normalizedPath(dataRoot) !== normalizedPath(expectedDataRoot)
    || !token
    || !SHA256_RE.test(buildIdentityDigest)
    || !/^[A-Za-z0-9_-]{43,256}$/u.test(signerBootstrap)
    || !SHA256_RE.test(signerBootstrapSha256)
    || sha256(signerBootstrap) !== signerBootstrapSha256) {
    fail('regression_server_truth_signer_bootstrap_invalid');
  }
  const response = await fetchJson(
    input.baseUrl,
    DEFAULT_SERVER_TRUTH_SIGNER_ENDPOINT,
    {
      token,
      signerBootstrap,
      method: 'POST',
      body: { acceptanceRunId },
    },
  );
  const signerInfo = exactRecord(response, [
    'kind', 'schemaVersion', 'signer',
  ], 'regression_server_truth_signer_response_invalid');
  if (signerInfo.kind !== 'lumi.task-regression-server-truth-signer-info'
    || signerInfo.schemaVersion !== 1) {
    fail('regression_server_truth_signer_response_invalid');
  }
  const signer = normalizeTaskRegressionServerTruthSigner(signerInfo.signer, {
    acceptanceRunId,
    buildIdentityDigest,
    dataRootIdentitySha256,
  });
  const core = {
    kind: 'lumi.task-regression-server-truth-contract',
    schemaVersion: 1,
    pinScope: 'before_voice_to_text_continuation_phase',
    acceptanceRunId,
    buildIdentityDigest,
    dataRootIdentitySha256,
    signer,
  };
  return Object.freeze({
    ...core,
    contractSha256: sha256(stableTaskRegressionProbeJson(core)),
  });
}

function normalizedPath(value) {
  const resolved = path.normalize(path.resolve(String(value || '')));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function overlaps(left, right) {
  return pathInside(left, right) || pathInside(right, left);
}

export function defaultProtectedProductRoots(homeDirectory = os.homedir(), environment = process.env) {
  const roots = [
    path.resolve(homeDirectory, 'LumiOS'),
    path.resolve(homeDirectory, 'LumiCore'),
  ];
  const configuredDataRoot = String(environment?.LUMI_DATA_DIR || '').trim();
  // Protect a custom product data root lexically. Deliberately do not stat or
  // realpath it: the isolated runner must not read the formal product root.
  if (configuredDataRoot && path.isAbsolute(configuredDataRoot)) {
    roots.push(path.resolve(configuredDataRoot));
  }
  const seen = new Set();
  return roots.filter(root => {
    const key = normalizedPath(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeRealDirectoryIdentity(directory, code) {
  const absolute = path.resolve(directory);
  let stat;
  let canonical;
  try {
    stat = fs.lstatSync(absolute);
    canonical = fs.realpathSync.native(absolute);
  } catch {
    fail(code);
  }
  // Windows may lexicalize %TEMP% through an 8.3 alias while realpath returns
  // the long spelling. Identity is pinned to the returned canonical path; the
  // directory entry itself still must not be a symlink/junction.
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code);
  }
  return Object.freeze({
    canonical,
    dev: stat.dev,
    ino: stat.ino,
  });
}

function assertSafeRealDirectory(directory, code) {
  return safeRealDirectoryIdentity(directory, code).canonical;
}

function assertExactDirectoryIdentity(observed, expected, code) {
  if (
    !expected
    || typeof expected !== 'object'
    || normalizedPath(observed.canonical) !== normalizedPath(expected.canonical)
    || observed.dev !== expected.dev
    || observed.ino !== expected.ino
  ) fail(code);
}

function assertSafeOwnedRegularFile(filename, code, options = {}) {
  const absolute = path.resolve(filename);
  let stat;
  let canonical;
  try {
    stat = fs.lstatSync(absolute);
    canonical = fs.realpathSync.native(absolute);
  } catch {
    fail(code);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || normalizedPath(canonical) !== normalizedPath(absolute)
    || (Number.isSafeInteger(options.exactBytes) && stat.size !== options.exactBytes)
    || (Number.isSafeInteger(options.maximumBytes) && stat.size > options.maximumBytes)
  ) fail(code);
  return stat;
}

export function assertIsolatedRegressionDataRoot(dataRoot, options = {}) {
  if (!path.isAbsolute(String(dataRoot || ''))) fail('regression_data_root_absolute_required');
  const requestedRoot = path.resolve(dataRoot);
  const canonical = assertSafeRealDirectory(dataRoot, 'regression_data_root_not_safe');
  const sandboxRoot = options.sandboxRoot
    ? assertSafeRealDirectory(options.sandboxRoot, 'regression_sandbox_root_not_safe')
    : null;
  if (sandboxRoot && !pathInside(sandboxRoot, canonical)) fail('regression_data_root_outside_sandbox');
  for (const protectedRoot of options.protectedRoots || defaultProtectedProductRoots()) {
    // Deliberately compare lexically. The runner must not stat or resolve the
    // real product roots merely to prove that its owned temporary path differs.
    if (
      overlaps(normalizedPath(protectedRoot), normalizedPath(requestedRoot))
      || overlaps(normalizedPath(protectedRoot), normalizedPath(canonical))
    ) {
      fail('regression_data_root_overlaps_product_data');
    }
  }
  return canonical;
}

async function mkdirOwned(directory) {
  await fsp.mkdir(directory, { recursive: false, mode: 0o700 });
  return assertSafeRealDirectory(directory, 'regression_owned_directory_not_safe');
}

export async function createIsolatedRegressionSandbox(options = {}) {
  const requestedTempBase = path.resolve(options.tempBase || os.tmpdir());
  const tempBaseIdentity = safeRealDirectoryIdentity(
    requestedTempBase,
    'regression_temp_base_not_safe',
  );
  const tempBase = tempBaseIdentity.canonical;
  for (const protectedRoot of options.protectedRoots || defaultProtectedProductRoots()) {
    if (
      overlaps(normalizedPath(protectedRoot), normalizedPath(requestedTempBase))
      || overlaps(normalizedPath(protectedRoot), normalizedPath(tempBase))
    ) {
      fail('regression_temp_base_overlaps_product_data');
    }
  }
  const root = await fsp.mkdtemp(path.join(tempBase, 'lumi-task-regression-'));
  const rootIdentity = safeRealDirectoryIdentity(root, 'regression_sandbox_create_failed');
  const canonicalRoot = rootIdentity.canonical;
  const home = await mkdirOwned(path.join(canonicalRoot, 'home'));
  const appData = await mkdirOwned(path.join(canonicalRoot, 'appdata'));
  const localAppData = await mkdirOwned(path.join(canonicalRoot, 'localappdata'));
  const temporary = await mkdirOwned(path.join(canonicalRoot, 'tmp'));
  // The semantic desktop relay resolves `~/Desktop` against this owned HOME.
  // Keeping every generated fixture in that exact isolated directory makes
  // the black-box document path identical to a real desktop-listing result.
  const artifacts = await mkdirOwned(path.join(home, 'Desktop'));
  const logs = await mkdirOwned(path.join(canonicalRoot, 'logs'));
  const dataRoot = await mkdirOwned(path.join(canonicalRoot, 'data-root'));
  const dataDirectory = await mkdirOwned(path.join(dataRoot, 'data'));
  const dotenvPath = path.join(canonicalRoot, 'empty.env');
  await fsp.writeFile(dotenvPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  // Historical revisions copied <worktree>/data into a new explicit data root
  // unless the destination was non-empty. This owned marker closes that path.
  await fsp.writeFile(path.join(dataDirectory, '.migration_skip'), '', {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  assertSafeOwnedRegularFile(dotenvPath, 'regression_dotenv_marker_not_safe', { exactBytes: 0 });
  assertSafeOwnedRegularFile(
    path.join(dataDirectory, '.migration_skip'),
    'regression_migration_marker_not_safe',
    { exactBytes: 0 },
  );
  assertIsolatedRegressionDataRoot(dataRoot, {
    sandboxRoot: canonicalRoot,
    protectedRoots: options.protectedRoots,
  });
  return {
    root: canonicalRoot,
    canonicalRoot,
    rootIdentity,
    tempBase,
    tempBaseIdentity,
    home,
    appData,
    localAppData,
    temporary,
    artifacts,
    logs,
    dataRoot,
    dotenvPath,
    protectedRoots: options.protectedRoots || defaultProtectedProductRoots(),
  };
}

/**
 * Provisions independent ephemeral proofs for truth capture and the bounded
 * semantic desktop relay. The backend environment and manifest see only their
 * SHA-256 digests; plaintext remains in this runner process and is presented
 * solely over loopback alongside the isolated admin session.
 */
export async function provisionTaskRegressionEvidenceAccess(
  sandbox,
  acceptanceRunId,
  provenance,
) {
  const root = assertSafeRealDirectory(sandbox?.root, 'regression_evidence_sandbox_not_safe');
  const dataRoot = assertIsolatedRegressionDataRoot(sandbox?.dataRoot, {
    sandboxRoot: root,
    protectedRoots: sandbox?.protectedRoots || defaultProtectedProductRoots(),
  });
  assertSafeOwnedRegularFile(
    sandbox?.dotenvPath,
    'regression_dotenv_marker_not_safe',
    { exactBytes: 0 },
  );
  assertSafeOwnedRegularFile(
    path.join(dataRoot, 'data', '.migration_skip'),
    'regression_migration_marker_not_safe',
    { exactBytes: 0 },
  );
  const normalizedRunId = String(acceptanceRunId || '').trim();
  if (!normalizedRunId || normalizedRunId.length > 180 || /[\u0000-\u001f\u007f]/u.test(normalizedRunId)) {
    fail('regression_evidence_run_id_invalid');
  }
  const buildIdentityDigest = String(provenance?.buildIdentityDigest || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(buildIdentityDigest)) {
    fail('regression_evidence_build_identity_invalid');
  }
  if (!Array.isArray(provenance?.snapshotBindings) || provenance.snapshotBindings.length < 1) {
    fail('regression_evidence_snapshot_bindings_invalid');
  }
  const knownScenarios = new Set(TASK_REGRESSION_SCENARIOS.map(item => item.id));
  const seenScenarios = new Set();
  const seenRequestIds = new Set();
  const snapshotBindings = provenance.snapshotBindings.map(binding => {
    if (
      !binding
      || typeof binding !== 'object'
      || Array.isArray(binding)
      || !['phases,scenarioId', 'requestId,scenarioId']
        .includes(Object.keys(binding).sort().join(','))
    ) fail('regression_evidence_snapshot_bindings_invalid');
    const scenarioId = String(binding.scenarioId || '');
    if (
      !knownScenarios.has(scenarioId)
      || !/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(scenarioId)
      || seenScenarios.has(scenarioId)
    ) fail('regression_evidence_snapshot_bindings_invalid');
    seenScenarios.add(scenarioId);
    if (scenarioId === 'control_stop_status_repeat' && !Array.isArray(binding.phases)) {
      fail('regression_evidence_control_phases_invalid');
    }
    if (scenarioId === 'displayed_result_stale_receipt' && !Array.isArray(binding.phases)) {
      fail('regression_evidence_stale_receipt_phases_invalid');
    }
    const rawPhases = Array.isArray(binding.phases)
      ? binding.phases
      : [{ phaseId: 'truth', requestId: binding.requestId }];
    if (rawPhases.length < 1 || rawPhases.length > 16) {
      fail('regression_evidence_snapshot_bindings_invalid');
    }
    const seenPhaseIds = new Set();
    const phases = rawPhases.map(phase => {
      if (
        !phase
        || typeof phase !== 'object'
        || Array.isArray(phase)
        || Object.keys(phase).sort().join(',') !== 'phaseId,requestId'
      ) fail('regression_evidence_snapshot_bindings_invalid');
      const phaseId = String(phase.phaseId || '');
      const boundRequestId = String(phase.requestId || '');
      if (
        !/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(phaseId)
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u.test(boundRequestId)
        || seenPhaseIds.has(phaseId)
        || seenRequestIds.has(boundRequestId)
      ) fail('regression_evidence_snapshot_bindings_invalid');
      seenPhaseIds.add(phaseId);
      seenRequestIds.add(boundRequestId);
      return { phaseId, requestId: boundRequestId };
    });
    if (scenarioId === 'control_stop_status_repeat') {
      const actual = [...seenPhaseIds].sort().join(',');
      const expected = ['long', 'repeat', 'status', 'stop'].sort().join(',');
      if (actual !== expected) fail('regression_evidence_control_phases_invalid');
    }
    if (scenarioId === 'displayed_result_stale_receipt') {
      const actual = [...seenPhaseIds].sort().join(',');
      const expected = [...DISPLAYED_STALE_RECEIPT_PHASES].sort().join(',');
      if (actual !== expected) fail('regression_evidence_stale_receipt_phases_invalid');
    }
    if (scenarioId === 'mid_task_restart_recovery') {
      const actual = [...seenPhaseIds].sort().join(',');
      const expected = [...MID_TASK_RESTART_PHASES].sort().join(',');
      if (actual !== expected) fail('regression_evidence_restart_phases_invalid');
    }
    if (scenarioId === 'wps_wrong_file_correction') {
      const actual = [...seenPhaseIds].sort().join(',');
      const expected = [...WPS_WRONG_FILE_CORRECTION_PHASES].sort().join(',');
      if (actual !== expected) fail('regression_evidence_wps_phases_invalid');
    }
    if (scenarioId === 'voice_to_text_continuation') {
      const actual = [...seenPhaseIds].sort().join(',');
      if (actual !== 'text_continue') fail('regression_evidence_voice_text_phases_invalid');
    }
    return { scenarioId, phases };
  });
  const artifactsRoot = assertSafeRealDirectory(
    sandbox?.artifacts,
    'regression_evidence_desktop_relay_artifacts_not_safe',
  );
  if (
    normalizedPath(artifactsRoot) !== normalizedPath(path.join(root, 'home', 'Desktop'))
    || !pathInside(root, artifactsRoot)
  ) fail('regression_evidence_desktop_relay_artifacts_not_safe');
  if (!Array.isArray(provenance?.desktopRelayTargets) || provenance.desktopRelayTargets.length > 6) {
    fail('regression_evidence_desktop_relay_targets_invalid');
  }
  const seenDesktopRelayRelativePaths = new Set();
  const desktopRelayTargets = provenance.desktopRelayTargets.map(target => {
    if (
      !target
      || typeof target !== 'object'
      || Array.isArray(target)
      || Object.keys(target).sort().join(',') !== 'contentSha256,encoding,overwritePolicy,relativePath,scenarioId'
    ) fail('regression_evidence_desktop_relay_targets_invalid');
    const scenarioId = String(target.scenarioId || '');
    const relativePath = String(target.relativePath || '');
    const contentSha256 = String(target.contentSha256 || '').toLowerCase();
    const overwritePolicy = String(target.overwritePolicy || '');
    const readOnlyFixture = overwritePolicy === 'read_only';
    if (
      !seenScenarios.has(scenarioId)
      || seenDesktopRelayRelativePaths.has(relativePath.toLowerCase())
      || !(readOnlyFixture
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:pptx?|docx?|xlsx?|pdf|txt|md|csv)$/u.test(relativePath)
        : /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.txt$/u.test(relativePath))
      || relativePath === '.'
      || relativePath === '..'
      || path.basename(relativePath) !== relativePath
      || !/^[a-f0-9]{64}$/u.test(contentSha256)
      || !(
        target.encoding === 'utf-8'
        || (readOnlyFixture && target.encoding === 'binary')
      )
      || !['fail_if_exists', 'read_only'].includes(overwritePolicy)
    ) fail('regression_evidence_desktop_relay_targets_invalid');
    const absoluteTarget = path.join(artifactsRoot, relativePath);
    if (!pathInside(artifactsRoot, absoluteTarget)) {
      fail('regression_evidence_desktop_relay_target_not_owned');
    }
    if (readOnlyFixture) {
      assertSafeOwnedRegularFile(
        absoluteTarget,
        'regression_evidence_desktop_relay_fixture_not_safe',
        { maximumBytes: 100 * 1024 },
      );
      if (sha256(fs.readFileSync(absoluteTarget)) !== contentSha256) {
        fail('regression_evidence_desktop_relay_fixture_digest_mismatch');
      }
    } else if (fs.existsSync(absoluteTarget)) {
      fail('regression_evidence_desktop_relay_target_not_owned');
    }
    seenDesktopRelayRelativePaths.add(relativePath.toLowerCase());
    return {
      scenarioId,
      relativePath,
      contentSha256,
      encoding: target.encoding,
      overwritePolicy,
    };
  });
  const wpsReadOnlyTargets = desktopRelayTargets.filter(target => (
    target.scenarioId === 'wps_wrong_file_correction'
    && target.overwritePolicy === 'read_only'
  ));
  if (
    seenScenarios.has('wps_wrong_file_correction')
    && (wpsReadOnlyTargets.length !== 2
      || desktopRelayTargets.some(target => (
        target.scenarioId === 'wps_wrong_file_correction'
        && target.overwritePolicy !== 'read_only'
      )))
  ) fail('regression_evidence_wps_semantic_targets_invalid');
  const proof = crypto.randomBytes(48).toString('base64url');
  const proofSha256 = sha256(proof);
  const sttCredential = crypto.randomBytes(48).toString('base64url');
  const sttCredentialSha256 = sha256(sttCredential);
  let desktopRelayProof;
  do {
    desktopRelayProof = crypto.randomBytes(48).toString('base64url');
  } while (desktopRelayProof === proof);
  const desktopRelayProofSha256 = sha256(desktopRelayProof);
  let signerBootstrap;
  do {
    signerBootstrap = crypto.randomBytes(48).toString('base64url');
  } while ([proof, sttCredential, desktopRelayProof].includes(signerBootstrap));
  const signerBootstrapSha256 = sha256(signerBootstrap);
  const manifestPath = path.join(root, TASK_REGRESSION_ISOLATION_MANIFEST);
  const createdAtMs = Date.now();
  const manifest = {
    kind: 'lumi.task-regression-isolation',
    schemaVersion: 3,
    sandboxId: crypto.randomBytes(16).toString('hex'),
    acceptanceRunId: normalizedRunId,
    runnerPid: process.pid,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + 45 * 60 * 1000).toISOString(),
    sandboxRootSha256: sha256(normalizedPath(root)),
    dataRootSha256: sha256(normalizedPath(dataRoot)),
    proofSha256,
    sttCredentialSha256,
    desktopRelayProofSha256,
    signerBootstrapSha256,
    desktopRelayArtifactsRootSha256: sha256(normalizedPath(artifactsRoot)),
    buildIdentityDigest,
    snapshotBindings,
    desktopRelayTargets,
  };
  await fsp.writeFile(manifestPath, `${stableTaskRegressionProbeJson(manifest)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  assertSafeOwnedRegularFile(
    manifestPath,
    'regression_evidence_manifest_not_safe',
    { maximumBytes: 8 * 1024 },
  );
  return {
    acceptanceRunId: normalizedRunId,
    proof,
    proofSha256,
    sttCredential,
    sttCredentialSha256,
    desktopRelayProof,
    desktopRelayProofSha256,
    signerBootstrap,
    signerBootstrapSha256,
    artifactsRoot,
    desktopRelayTargets,
    sandboxRoot: root,
    dataRoot,
    manifestPath,
    buildIdentityDigest,
    snapshotBindings,
  };
}

function assertOwnedSandboxForRemoval(sandbox) {
  const rootIdentity = safeRealDirectoryIdentity(sandbox?.root, 'regression_cleanup_root_not_safe');
  assertExactDirectoryIdentity(
    rootIdentity,
    sandbox?.rootIdentity,
    'regression_cleanup_root_identity_changed',
  );
  const root = rootIdentity.canonical;
  if (normalizedPath(root) !== normalizedPath(sandbox?.canonicalRoot)) {
    fail('regression_cleanup_root_identity_changed');
  }
  const tempBaseIdentity = safeRealDirectoryIdentity(
    sandbox?.tempBase,
    'regression_cleanup_temp_base_not_safe',
  );
  assertExactDirectoryIdentity(
    tempBaseIdentity,
    sandbox?.tempBaseIdentity,
    'regression_cleanup_temp_base_identity_changed',
  );
  const tempBase = tempBaseIdentity.canonical;
  if (!pathInside(tempBase, root) || path.basename(root).startsWith('lumi-task-regression-') !== true) {
    fail('regression_cleanup_scope_invalid');
  }
  for (const protectedRoot of sandbox?.protectedRoots || defaultProtectedProductRoots()) {
    if (overlaps(normalizedPath(protectedRoot), normalizedPath(root))) {
      fail('regression_cleanup_overlaps_product_data');
    }
  }
  return root;
}

export async function removeIsolatedRegressionSandbox(sandbox) {
  const root = assertOwnedSandboxForRemoval(sandbox);
  await fsp.rm(root, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
  if (fs.existsSync(root)) fail('regression_cleanup_incomplete');
  return true;
}

/** Read only the runner-owned backend lease and project away its owner token. */
export function inspectIsolatedRegressionBackendLease(sandbox) {
  const root = assertSafeRealDirectory(sandbox?.root, 'regression_lease_sandbox_not_safe');
  const dataRoot = assertIsolatedRegressionDataRoot(sandbox?.dataRoot, {
    sandboxRoot: root,
    protectedRoots: sandbox?.protectedRoots || defaultProtectedProductRoots(),
  });
  const leasePath = path.join(dataRoot, 'runtime', 'backend-instance.lock');
  if (!fs.existsSync(leasePath)) return Object.freeze({ state: 'absent' });
  assertSafeOwnedRegularFile(leasePath, 'regression_backend_lease_not_safe', {
    maximumBytes: 16 * 1024,
  });
  let row;
  try { row = JSON.parse(fs.readFileSync(leasePath, 'utf8')); } catch {
    fail('regression_backend_lease_invalid');
  }
  const pid = Number(row?.pid || 0);
  const acquiredAt = String(row?.acquiredAt || '');
  const processStartIdentity = String(row?.processStartIdentity || '');
  const dataRootDigest = String(row?.dataRootDigest || '').toLowerCase();
  const ownerToken = String(row?.ownerToken || '');
  if (
    row?.version !== 1
    || row?.leasePurpose !== 'backend'
    || !Number.isSafeInteger(pid)
    || pid < 1
    || !Number.isFinite(Date.parse(acquiredAt))
    || processStartIdentity.length < 8
    || processStartIdentity.length > 512
    || !/^[A-Za-z0-9_-]{43}$/u.test(ownerToken)
    || normalizedPath(row?.dataRoot) !== normalizedPath(dataRoot)
    || dataRootDigest !== sha256(normalizedPath(dataRoot))
  ) fail('regression_backend_lease_invalid');
  return Object.freeze({
    state: 'present',
    pid,
    acquiredAt,
    processStartIdentitySha256: sha256(processStartIdentity),
    ownerTokenSha256: sha256(ownerToken),
    dataRootDigest,
  });
}

export async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  if (!Number.isSafeInteger(port) || port < 1) fail('regression_port_reservation_failed');
  return port;
}

export async function verifyLoopbackConnectionRefused(port, timeoutMs = 1_500) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail('regression_primary_failure_port_invalid');
  }
  const observedAt = new Date().toISOString();
  const code = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: LOOPBACK_HOST, port });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new TaskRegressionBlackBoxError('regression_primary_failure_probe_timeout')),
      timeoutMs,
    );
    socket.once('connect', () => finish(
      new TaskRegressionBlackBoxError('regression_primary_failure_endpoint_listening'),
    ));
    socket.once('error', error => finish(null, String(error?.code || '')));
  });
  if (code !== 'ECONNREFUSED') {
    fail('regression_primary_failure_not_connection_refused', { observedCode: code || 'unknown' });
  }
  return Object.freeze({
    host: LOOPBACK_HOST,
    port,
    code,
    observedAt,
  });
}

function compactLog(buffer, chunk) {
  const next = `${buffer}${String(chunk || '')}`;
  return next.length <= MAX_LOG_BYTES ? next : next.slice(-MAX_LOG_BYTES);
}

function resolveTargetRuntime(worktree) {
  const root = assertSafeRealDirectory(worktree, 'regression_worktree_not_safe');
  const packagePath = path.join(root, 'package.json');
  const packageStat = fs.lstatSync(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink()) fail('regression_package_manifest_not_safe');
  const entryCandidates = [
    path.join(root, 'server', 'runtime', 'server_entry.ts'),
    path.join(root, 'server.ts'),
  ];
  const entry = entryCandidates.find(candidate => {
    try {
      const stat = fs.lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!entry) fail('regression_server_entry_missing');

  const targetRequire = createRequire(packagePath);
  let tsxLoader;
  try {
    // Load TS in the exact child process. The tsx CLI may supervise a second
    // Node process, which would make the runner's PID/exit boundary ambiguous.
    tsxLoader = targetRequire.resolve('tsx');
    for (const dependency of ['sqlite3', 'express', 'socket.io', 'openai']) {
      targetRequire.resolve(dependency);
    }
  } catch {
    fail('regression_target_dependencies_missing', {
      remedy: 'Install the target worktree dependencies or place a temporary worktree below a parent that owns compatible node_modules.',
    });
  }
  return { root, packagePath, entry, tsxLoader };
}

export function buildSanitizedRegressionEnvironment(input) {
  const sandbox = input.sandbox;
  const env = {};
  for (const key of SAFE_PARENT_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = process.env.PATH || '';
  env.Path = process.env.Path || env.PATH;
  env.HOME = sandbox.home;
  env.USERPROFILE = sandbox.home;
  env.APPDATA = sandbox.appData;
  env.LOCALAPPDATA = sandbox.localAppData;
  env.TEMP = sandbox.temporary;
  env.TMP = sandbox.temporary;
  env.NODE_ENV = 'production';
  env.HOST = LOOPBACK_HOST;
  env.PORT = String(input.port);
  env.LUMI_DATA_DIR = sandbox.dataRoot;
  env.LUMI_LOG_FILE = path.join(sandbox.logs, 'backend.log');
  env.LUMI_RUNTIME_META_FILE = path.join(sandbox.logs, 'runtime-meta.json');
  env.LUMI_FRONTEND_DIST = path.join(sandbox.root, 'empty-dist');
  env.LUMI_DESKTOP = '0';
  env.LUMI_AUTO_KILL_OLD_PROCESS = '0';
  env.LUMI_ENFORCE_DATA_ROOT_LEASE = '1';
  env.DISABLE_HMR = 'true';
  env.DOTENV_CONFIG_PATH = sandbox.dotenvPath;
  env.DOTENV_CONFIG_QUIET = 'true';
  env.OPENAI_API_KEY = 'lumi-regression-local-only';
  env.OPENAI_BASE_URL = `${input.modelStubBaseUrl}/v1`;
  env.OPENAI_MODEL = 'lumi-regression-stub-v1';
  env.OLLAMA_BASE_URL = input.modelStubBaseUrl;
  env.LMSTUDIO_BASE_URL = `${input.modelStubBaseUrl}/v1`;
  if (input.primaryFailureBaseUrl) {
    let primaryFailureUrl;
    try { primaryFailureUrl = new URL(String(input.primaryFailureBaseUrl)); } catch {
      fail('regression_primary_failure_url_invalid');
    }
    if (
      primaryFailureUrl.protocol !== 'http:'
      || primaryFailureUrl.hostname !== LOOPBACK_HOST
      || primaryFailureUrl.pathname.replace(/\/+$/u, '') !== '/v1'
      || !primaryFailureUrl.port
      || primaryFailureUrl.search
      || primaryFailureUrl.hash
      || primaryFailureUrl.username
      || primaryFailureUrl.password
    ) fail('regression_primary_failure_url_invalid');
    env.DEEPSEEK_API_KEY = 'lumi-regression-local-primary-only';
    env.DEEPSEEK_BASE_URL = primaryFailureUrl.href.replace(/\/$/u, '');
  }
  env.LUMI_DISABLE_QWEN_FILE_STT = '1';
  if (input.sttStubUrl) {
    let sttStubUrl;
    let modelStubUrl;
    try {
      sttStubUrl = new URL(String(input.sttStubUrl));
      modelStubUrl = new URL(String(input.modelStubBaseUrl));
    } catch {
      fail('regression_stt_stub_url_invalid');
    }
    if (
      sttStubUrl.protocol !== 'ws:'
      || sttStubUrl.hostname !== LOOPBACK_HOST
      || sttStubUrl.pathname !== '/asr'
      || sttStubUrl.search
      || sttStubUrl.hash
      || sttStubUrl.username
      || sttStubUrl.password
      || modelStubUrl.protocol !== 'http:'
      || modelStubUrl.hostname !== LOOPBACK_HOST
      || sttStubUrl.port !== modelStubUrl.port
    ) fail('regression_stt_stub_url_invalid');
    const sttCredential = String(input.evidenceAccess?.sttCredential || '');
    const sttCredentialSha256 = String(input.evidenceAccess?.sttCredentialSha256 || '')
      .toLowerCase();
    if (
      !/^[A-Za-z0-9_-]{43,256}$/u.test(sttCredential)
      || !/^[a-f0-9]{64}$/u.test(sttCredentialSha256)
      || sha256(sttCredential) !== sttCredentialSha256
    ) fail('regression_stt_access_invalid');
    env.DOUBAO_SPEECH_KEY = sttCredential;
    env.DOUBAO_ASR_WS_URL = sttStubUrl.href;
    // A Voice regression must never be able to fall through to cloud TTS.
    // The scenario also requests an inaccessible voice profile so synthesis
    // is skipped; this loopback URL is the final network boundary if that
    // product behavior changes later.
    env.DOUBAO_TTS_V3_URL = `${input.modelStubBaseUrl}/disabled-tts`;
  }
  if (input.evidenceAccess) {
    const access = input.evidenceAccess;
    if (
      normalizedPath(access.sandboxRoot) !== normalizedPath(sandbox.root)
      || normalizedPath(access.dataRoot) !== normalizedPath(sandbox.dataRoot)
      || !/^[a-f0-9]{64}$/u.test(String(access.proofSha256 || ''))
      || !/^[a-f0-9]{64}$/u.test(String(access.desktopRelayProofSha256 || ''))
      || !/^[a-f0-9]{64}$/u.test(String(access.sttCredentialSha256 || ''))
      || !/^[a-f0-9]{64}$/u.test(String(access.signerBootstrapSha256 || ''))
      || access.desktopRelayProofSha256 === access.proofSha256
      || access.sttCredentialSha256 === access.proofSha256
      || access.sttCredentialSha256 === access.desktopRelayProofSha256
      || [
        access.proofSha256,
        access.sttCredentialSha256,
        access.desktopRelayProofSha256,
      ].includes(access.signerBootstrapSha256)
      || !/^[a-f0-9]{64}$/u.test(String(access.buildIdentityDigest || ''))
      || !Array.isArray(access.snapshotBindings)
      || access.snapshotBindings.length < 1
      || !String(access.acceptanceRunId || '').trim()
    ) fail('regression_evidence_access_invalid');
    env.LUMI_TASK_REGRESSION_EVIDENCE_MODE = '1';
    env.LUMI_TASK_REGRESSION_ACCEPTANCE_RUN_ID = access.acceptanceRunId;
    env.LUMI_TASK_REGRESSION_SANDBOX_ROOT = access.sandboxRoot;
    env.LUMI_TASK_REGRESSION_PROOF_SHA256 = access.proofSha256;
    env.LUMI_TASK_REGRESSION_STT_ACCESS_SHA256 = access.sttCredentialSha256;
    env.LUMI_TASK_REGRESSION_DESKTOP_RELAY_PROOF_SHA256 = access.desktopRelayProofSha256;
    env.LUMI_TASK_REGRESSION_SIGNER_BOOTSTRAP_SHA256 = access.signerBootstrapSha256;
    env.LUMI_TASK_REGRESSION_RUNNER_PID = String(process.pid);
  }
  const ownedSyntheticSecretKeys = new Set([
    'OPENAI_API_KEY',
    ...(input.primaryFailureBaseUrl ? ['DEEPSEEK_API_KEY'] : []),
    ...(input.sttStubUrl ? ['DOUBAO_SPEECH_KEY'] : []),
  ]);
  if (Object.keys(env).some(key => SECRET_ENV_RE.test(key) && !ownedSyntheticSecretKeys.has(key))) {
    fail('regression_environment_secret_allowlist_invalid');
  }
  return env;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = value => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
  });
}

export async function stopIsolatedRegressionBackend(runtime, timeoutMs = 8_000) {
  const child = runtime?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  try { child.kill('SIGTERM'); } catch {}
  if (await waitForExit(child, timeoutMs)) return true;
  try { child.kill('SIGKILL'); } catch {}
  if (!(await waitForExit(child, 3_000))) fail('regression_backend_stop_timeout');
  return true;
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const url = new URL(`${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.regressionProof ? { [TASK_REGRESSION_PROOF_HEADER]: options.regressionProof } : {}),
        ...(options.signerBootstrap
          ? { [TASK_REGRESSION_SIGNER_BOOTSTRAP_HEADER]: options.signerBootstrap }
          : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs || 15_000),
    });
  } catch (error) {
    fail('regression_local_api_unreachable', { cause: error?.message });
  }
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { rawTextSha256: sha256(text), rawTextLength: text.length }; }
  if (options.allowStatuses?.includes(response.status)) return { status: response.status, body };
  if (!response.ok) fail(`regression_local_api_http_${response.status}`, { pathname });
  return body;
}

async function waitForBackendHealth(runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'health_not_ready';
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      fail('regression_backend_exited_early', {
        exitCode: runtime.child.exitCode,
        signal: runtime.child.signalCode,
        stderrSha256: sha256(runtime.stderr),
      });
    }
    try {
      const response = await fetch(`${runtime.baseUrl}/health`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(1_500),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.status === 'ok') return body;
      lastFailure = `health_http_${response.status}`;
    } catch (error) {
      lastFailure = String(error?.name || 'health_unreachable');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  fail('regression_backend_start_timeout', {
    lastFailure,
    stdoutSha256: sha256(runtime.stdout),
    stderrSha256: sha256(runtime.stderr),
  });
}

async function readIsolatedRuntimeProcessIdentity(runtime) {
  const version = await fetchJson(runtime.baseUrl, '/version', { timeoutMs: 5_000 });
  const pid = Number(version?.pid || 0);
  const startedAt = String(version?.startedAt || '');
  if (
    !Number.isSafeInteger(pid)
    || pid < 1
    || pid !== runtime.child.pid
    || !Number.isFinite(Date.parse(startedAt))
  ) fail('regression_backend_process_identity_invalid', {
    observedPid: Number.isSafeInteger(pid) ? pid : null,
    childPid: runtime.child?.pid || null,
    startedAtValid: Number.isFinite(Date.parse(startedAt)),
    responseKeys: version && typeof version === 'object' ? Object.keys(version).sort() : [],
  });
  return Object.freeze({
    pid,
    startedAt,
    identitySha256: sha256(stableTaskRegressionProbeJson([pid, startedAt])),
    buildId: String(version?.buildId || ''),
    sourceFingerprint: String(version?.sourceFingerprint || ''),
  });
}

export async function startIsolatedRegressionBackend(options) {
  const target = resolveTargetRuntime(options.worktree);
  const port = options.port || await reserveLoopbackPort();
  const baseUrl = `http://${LOOPBACK_HOST}:${port}/api`;
  const env = buildSanitizedRegressionEnvironment({
    sandbox: options.sandbox,
    port,
    modelStubBaseUrl: options.modelStubBaseUrl,
    primaryFailureBaseUrl: options.primaryFailureBaseUrl,
    sttStubUrl: options.sttStubUrl,
    evidenceAccess: options.evidenceAccess,
  });
  if (!options.evidenceAccess) fail('regression_evidence_access_required');
  const child = spawn(process.execPath, [
    '--import',
    pathToFileURL(target.tsxLoader).href,
    target.entry,
  ], {
    cwd: target.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const runtime = {
    child,
    target,
    port,
    baseUrl,
    stdout: '',
    stderr: '',
    startedAt: new Date().toISOString(),
  };
  child.stdout?.on('data', chunk => { runtime.stdout = compactLog(runtime.stdout, chunk); });
  child.stderr?.on('data', chunk => { runtime.stderr = compactLog(runtime.stderr, chunk); });
  child.on('error', error => { runtime.stderr = compactLog(runtime.stderr, error?.stack || error?.message); });
  try {
    runtime.health = await waitForBackendHealth(runtime, options.startupTimeoutMs || 90_000);
    runtime.processIdentity = await readIsolatedRuntimeProcessIdentity(runtime);
    return runtime;
  } catch (error) {
    await stopIsolatedRegressionBackend(runtime).catch(() => {});
    throw error;
  }
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map(item => (
    typeof item === 'string' ? item : String(item?.text || item?.content || '')
  )).join('\n');
}

function declaredToolNames(body) {
  return new Set((Array.isArray(body?.tools) ? body.tools : [])
    .map(item => String(item?.function?.name || item?.name || ''))
    .filter(Boolean));
}

function allMessageText(body) {
  return (Array.isArray(body?.messages) ? body.messages : [])
    .map(message => messageContentText(message?.content))
    .join('\n');
}

function latestMessage(body, role) {
  return [...(Array.isArray(body?.messages) ? body.messages : [])]
    .reverse()
    .find(message => !role || message?.role === role) || null;
}

function toolDecision(body, name, args, fallbackText) {
  if (!declaredToolNames(body).has(name)) {
    return { type: 'text', text: fallbackText, missingDeclaredTool: name };
  }
  return {
    type: 'tool',
    callId: `call_${crypto.randomBytes(8).toString('hex')}`,
    name,
    arguments: args,
  };
}

function verifiedToolContinuation(body, expected) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const matchingAssistants = messages.filter(message => (
    message?.role === 'assistant'
    && Array.isArray(message?.tool_calls)
    && message.tool_calls.some(call => (
      String(call?.id || '') === expected.callId
      && String(call?.function?.name || '') === expected.toolName
    ))
  ));
  const matchingReceipts = messages.filter(message => (
    message?.role === 'tool'
    && String(message?.tool_call_id || '') === expected.callId
    && (!String(message?.name || '').trim() || String(message.name) === expected.toolName)
    && messageContentText(message.content).includes(expected.sentinel)
  ));
  const assistantIndex = matchingAssistants.length === 1
    ? messages.indexOf(matchingAssistants[0])
    : -1;
  const receiptIndex = matchingReceipts.length === 1
    ? messages.indexOf(matchingReceipts[0])
    : -1;
  return {
    ok: matchingAssistants.length === 1
      && matchingReceipts.length === 1
      && assistantIndex >= 0
      && receiptIndex === assistantIndex + 1,
    assistantCount: matchingAssistants.length,
    receiptCount: matchingReceipts.length,
    assistantIndex,
    receiptIndex,
  };
}

function decideModelResponse(body, state) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const latest = messages.at(-1) || {};
  const latestUser = latestMessage(body, 'user');
  const latestUserText = messageContentText(latestUser?.content);
  const currentScenarioId = currentProviderScenario(body, state);

  if (currentScenarioId === 'primary_model_failover_lmstudio') {
    if (latest?.role === 'tool') {
      const continuation = verifiedToolContinuation(body, {
        callId: state.s8ToolCallId,
        toolName: 'read_file',
        sentinel: state.s8FixtureContent,
      });
      if (!continuation.ok) {
        return {
          type: 'text',
          text: 'S8 fail-closed：没有看到配对的 read_file 工具调用与已验证回执，不能报告任务完成。',
          verifiedFixtureContent: false,
          verifiedToolContinuation: false,
        };
      }
      return {
        type: 'text',
        text: state.s8FinalText,
        verifiedFixtureContent: true,
        verifiedToolContinuation: true,
      };
    }
    const decision = toolDecision(
      body,
      'read_file',
      { path: state.s8FixturePath },
      '当前 LM Studio 请求没有声明 read_file，S8 不能形成真实文件回执。',
    );
    if (decision.type === 'tool') decision.callId = state.s8ToolCallId;
    return decision;
  }

  if (latest?.role === 'tool') {
    const toolText = messageContentText(latest.content);
    const latestToolName = String(latest?.name || latest?.tool_name || '').trim();
    if (/\[LUMI_REGRESSION:S1:SEED:[ABC]\]/u.test(latestUserText)) {
      return {
        type: 'text',
        text: latestToolName === 'work_takeover_task_create'
          ? '隔离运行任务种子已持久化。'
          : '隔离运行任务种子没有通过指定工具持久化。',
      };
    }
    if (currentScenarioId === 'cleanup_offer_then_cleanup') {
      if (latestToolName === 'runtime_work_status') {
        return {
          type: 'text',
          text: '我看到这些后台任务仍可取消，要不要我帮你清理这些后台任务？',
        };
      }
      return { type: 'text', text: '真实后台任务状态没有通过 runtime_work_status 返回。' };
    }
    if (currentScenarioId === 'repeated_confirmation_exactly_once') {
      return { type: 'text', text: `隔离文件动作返回：${toolText.slice(0, 240)}` };
    }
    if (latestUserText.includes('[LUMI_REGRESSION:S4]')) {
      return {
        type: 'text',
        text: `已显示真实读取结果：${state.staleFixtureContent}`,
      };
    }
    if (currentScenarioId === 'mid_task_restart_recovery') {
      return {
        type: 'text',
        text: `后端重启后已继续同一任务并写入隔离产物：${state.restartArtifactContent}`,
      };
    }
    if (currentScenarioId === 'voice_to_text_continuation') {
      if (latestToolName === 'search_files') {
        const continuingFromText = latestUserText.includes('[LUMI_REGRESSION:S6:TEXT]');
        return toolDecision(body, 'read_file', {
          path: continuingFromText ? state.s6CorrectPath : state.s6MissingPath,
        }, '当前模型请求没有声明 read_file，无法完成 S6 的真实搜索后读取。');
      }
      const correctContentObserved = Boolean(
        state.s6CorrectContent && toolText.includes(state.s6CorrectContent),
      );
      return correctContentObserved
        ? {
            type: 'text',
            text: `已按你的文字纠正继续同一任务，并读取正确文件：${state.s6CorrectContent}`,
            verifiedFixtureContent: true,
          }
        : {
            type: 'text',
            text: '没有找到语音中指定的文件。请给出正确路径，我会继续刚才的同一个任务。',
            verifiedFixtureContent: false,
          };
    }
    if (currentScenarioId === 'wps_wrong_file_correction') {
      if (latestToolName === 'desktop_active_window') {
        const suppliedCorrectName = latestUserText.includes(state.wpsCorrectName);
        if (suppliedCorrectName) {
          return toolDecision(body, 'desktop_list_files', {
            path: '~/Desktop',
            limit: 100,
          }, '当前模型请求没有声明 desktop_list_files，无法在限定桌面目录中核对候选文件。');
        }
        return {
          type: 'text',
          text: `我从 WPS 活动窗口标题初步锁定的是 ${state.wpsWrongName}；路径仍未知，我不会读取它。若不是这份，请纠正并补充准确文件名。`,
        };
      }
      if (latestToolName === 'desktop_list_files') {
        return toolDecision(body, 'extract_document_text', {
          filePath: state.wpsCorrectPath,
        }, '当前模型请求没有声明 extract_document_text，无法提取已经精确锁定的 PPTX 内容。');
      }
      if (latestToolName === 'extract_document_text') {
        const exactFixtureObserved = Boolean(
          state.wpsCorrectContent
          && toolText.includes(state.wpsCorrectContent),
        );
        if (!exactFixtureObserved) {
          return {
            type: 'text',
            text: `正确文件 ${state.wpsCorrectName} 的内容提取没有成功，我不能声称已经分析。`,
            verifiedFixtureContent: false,
          };
        }
        return {
          type: 'text',
          text: `已按你补充的文件名分析 ${state.wpsCorrectName}：${state.wpsCorrectSummary}。错误候选 ${state.wpsWrongName} 未被读取或修改。`,
          verifiedFixtureContent: true,
        };
      }
    }
    return { type: 'text', text: `工具结果已收到：${toolText.slice(0, 240)}` };
  }

  const s1SeedMatch = latestUserText.match(/\[LUMI_REGRESSION:S1:SEED:([ABC])\]/u);
  if (s1SeedMatch) {
    const seedKey = s1SeedMatch[1];
    const title = String(state.s1SeedTitles?.[seedKey] || '').trim();
    return toolDecision(body, 'work_takeover_task_create', {
      title,
      category: 'general_work',
      source: 'task-regression-black-box',
      sourceMessage: `isolated exact-cleanup seed ${seedKey}: ${title}`,
      summary: `Keep isolated runtime work ${seedKey} cancellable until the exact cleanup acceptance turn.`,
      nextActions: ['wait_for_exact_cleanup_acceptance'],
      allowedNow: ['remain_queued'],
      confirmationRequired: [],
      blockedBy: [],
      risks: [],
    }, '当前模型请求没有声明 work_takeover_task_create，无法建立真实可取消运行任务。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S1]')) {
    return toolDecision(
      body,
      'runtime_work_status',
      {},
      '当前模型请求没有声明 runtime_work_status，无法形成已验证的冻结清理提议。',
    );
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S2]')) {
    return toolDecision(body, 'desktop_write_text_file', {
      path: state.confirmationArtifact,
      content: state.confirmationContent,
      encoding: 'utf-8',
      overwritePolicy: 'fail_if_exists',
    }, '当前模型请求没有声明 desktop_write_text_file，无法形成真实确认动作。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S3]')) {
    return toolDecision(body, 'desktop_active_window', {}, '当前模型请求没有声明 desktop_active_window，无法从 WPS 活动窗口建立目标锚点。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S4:LIVE]')) {
    return toolDecision(body, 'desktop_write_text_file', {
      path: state.stalePendingFixture,
      content: 'stale receipt live-owner sentinel',
      encoding: 'utf-8',
      overwritePolicy: 'fail_if_exists',
    }, 'The current model request did not declare desktop_write_text_file, so the isolated live-owner boundary cannot be created.');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S4]')) {
    return toolDecision(body, 'read_file', {
      path: state.staleFixture,
    }, '当前模型请求没有声明 read_file，无法形成真实工具结果。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S7]')) {
    return toolDecision(body, 'desktop_write_text_file', {
      path: state.restartArtifact,
      content: state.restartArtifactContent,
      encoding: 'utf-8',
      overwritePolicy: 'fail_if_exists',
    }, '当前模型请求没有声明 desktop_write_text_file，无法建立可持久化的重启恢复边界。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S6:VOICE]')) {
    return toolDecision(body, 'search_files', {
      directory: state.s6SearchDirectory,
      pattern: state.s6MissingPath,
    }, '当前模型请求没有声明 search_files，无法建立真实的语音搜索回执。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S6:TEXT]')) {
    return toolDecision(body, 'search_files', {
      directory: state.s6SearchDirectory,
      pattern: path.basename(state.s6CorrectPath),
    }, '当前模型请求没有声明 search_files，无法按文字纠正定位正确文件。');
  }
  if (latestUserText.includes('[LUMI_REGRESSION:S5:LONG]')) {
    return {
      type: 'text',
      text: '长任务自然完成；如果你看见这句，说明它没有在停止请求时中断。',
      delayMs: state.longDelayMs,
    };
  }
  if (/^怎么说[？?。.!\s]*$/u.test(latestUserText.trim())) {
    const priorAssistant = [...messages].reverse().find(message => message?.role === 'assistant');
    const priorText = messageContentText(priorAssistant?.content).trim();
    return { type: 'text', text: priorText || '没有可复述的上一条回答。' };
  }
  if (/清理一下/u.test(latestUserText)) {
    return {
      type: 'text',
      text: '模型不得重新快照或重建这次清理目标；只能由运行时采用相邻已验证提议中的精确任务集合。',
    };
  }
  if (/不是这份文件/u.test(latestUserText)) {
    return {
      type: 'text',
      text: `已把 ${state.wpsWrongName} 标记为错误目标，不会读取或修改它。请补充准确文件名。`,
    };
  }
  if (state.wpsCorrectName && latestUserText.includes(state.wpsCorrectName)) {
    return toolDecision(body, 'desktop_list_files', {
      path: '~/Desktop',
      limit: 100,
    }, '当前模型请求没有声明 desktop_list_files，无法在限定桌面目录中核对补充的文件名。');
  }
  if (/刚才结果已经显示/u.test(latestUserText)) {
    return { type: 'text', text: '继续使用刚才已经显示的结果，不重新执行读取动作。' };
  }
  if (/^(?:确认|确认了)[。.!\s]*$/u.test(latestUserText.trim())) {
    return { type: 'text', text: '没有新的待确认动作；不会重复执行。' };
  }
  return { type: 'text', text: '隔离回归模型已收到。' };
}

function currentProviderScenario(body, state = {}) {
  const latestUserText = messageContentText(latestMessage(body, 'user')?.content);
  const markerBindings = [
    ['[LUMI_REGRESSION:S8]', 'primary_model_failover_lmstudio'],
    ['[LUMI_REGRESSION:S5:LONG]', 'control_stop_status_repeat'],
    ['[LUMI_REGRESSION:S7]', 'mid_task_restart_recovery'],
    ['[LUMI_REGRESSION:S6]', 'voice_to_text_continuation'],
    ['[LUMI_REGRESSION:S6:VOICE]', 'voice_to_text_continuation'],
    ['[LUMI_REGRESSION:S6:TEXT]', 'voice_to_text_continuation'],
    ['[LUMI_REGRESSION:S4]', 'displayed_result_stale_receipt'],
    ['[LUMI_REGRESSION:S4:LIVE]', 'displayed_result_stale_receipt'],
    ['[LUMI_REGRESSION:S3]', 'wps_wrong_file_correction'],
    ['[LUMI_REGRESSION:S2]', 'repeated_confirmation_exactly_once'],
    ['[LUMI_REGRESSION:S1]', 'cleanup_offer_then_cleanup'],
    ['[LUMI_REGRESSION:S1:SEED:A]', 'cleanup_offer_then_cleanup'],
    ['[LUMI_REGRESSION:S1:SEED:B]', 'cleanup_offer_then_cleanup'],
    ['[LUMI_REGRESSION:S1:SEED:C]', 'cleanup_offer_then_cleanup'],
  ].filter(([marker]) => latestUserText.includes(marker));
  const boundScenarios = [...new Set(markerBindings.map(([, scenarioId]) => scenarioId))];
  if (boundScenarios.length === 1) return boundScenarios[0];
  // Multiple current-turn markers are ambiguous. Never choose one by global
  // precedence, because that would turn an injected or stale marker into the
  // evidence identity for this provider request.
  if (boundScenarios.length > 1) return '';

  // A few regression turns intentionally use natural-language follow-ups
  // without repeating their marker. Bind only deterministic current-user
  // wording/fixtures owned by that scenario; do not scan arbitrary history,
  // assistant prose, system prompts, or prior task markers.
  if (
    latestUserText === '不是这份文件'
    || (state.wpsCorrectName && latestUserText.includes(state.wpsCorrectName))
  ) return 'wps_wrong_file_correction';
  if (/刚才结果已经显示/u.test(latestUserText)) return 'displayed_result_stale_receipt';
  if (/清理一下/u.test(latestUserText)) return 'cleanup_offer_then_cleanup';
  if (/^怎么说[？?。.! \s]*$/u.test(latestUserText.trim())) {
    return 'control_stop_status_repeat';
  }
  return '';
}

function summarizeProviderRequest(body, raw, receivedAt, state) {
  const latestUserText = messageContentText(latestMessage(body, 'user')?.content);
  const scenarioId = currentProviderScenario(body, state);
  const messages = (Array.isArray(body?.messages) ? body.messages : []).map((message, index) => {
    const text = messageContentText(message?.content);
    return {
      index,
      role: String(message?.role || ''),
      name: String(message?.name || message?.tool_name || ''),
      contentSha256: sha256(text),
      textCharCount: text.length,
    };
  });
  return {
    captureOrigin: 'provider_dispatch_boundary',
    modelInvoked: true,
    receivedAt,
    scenarioId,
    latestUserTextSha256: sha256(latestUserText),
    latestUserTextCharCount: latestUserText.length,
    payloadSha256: sha256(raw),
    model: String(body?.model || ''),
    providerBoundary: scenarioId === 'primary_model_failover_lmstudio'
      ? 'lmstudio'
      : 'openai_compatible_stub',
    stream: body?.stream === true,
    messageCount: messages.length,
    messagesSha256: sha256(stableTaskRegressionProbeJson(messages)),
    messages,
    declaredTools: [...declaredToolNames(body)].sort(),
  };
}

function openAiCompletion(decision, model) {
  const message = decision.type === 'tool'
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: decision.callId,
          type: 'function',
          function: { name: decision.name, arguments: JSON.stringify(decision.arguments) },
        }],
      }
    : { role: 'assistant', content: decision.text };
  return {
    id: `chatcmpl_${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: decision.type === 'tool' ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function writeSse(res, decision, model) {
  const id = `chatcmpl_${crypto.randomBytes(8).toString('hex')}`;
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (decision.type === 'tool') {
    send({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: decision.callId,
            type: 'function',
            function: { name: decision.name, arguments: JSON.stringify(decision.arguments) },
          }],
        },
        finish_reason: null,
      }],
    });
    send({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  } else {
    send({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: { role: 'assistant', content: decision.text }, finish_reason: null }],
    });
    send({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function doubaoRegressionAckPacket() {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(0, 0);
  return Buffer.concat([Buffer.from([0x11, 0xb0, 0x10, 0x00]), size]);
}

function doubaoRegressionFinalPacket(text) {
  const body = Buffer.from(JSON.stringify({
    result: [{
      text,
      definite: true,
      utterances: [{ text, definite: true }],
    }],
  }), 'utf8');
  const sequence = Buffer.alloc(4);
  sequence.writeInt32BE(-1, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    Buffer.from([0x11, 0x93, 0x10, 0x00]),
    sequence,
    size,
    body,
  ]);
}

function validateIsolatedSttAccess(access) {
  if (!access || typeof access !== 'object' || Array.isArray(access)) {
    fail('regression_stt_access_required');
  }
  const sandboxRoot = assertSafeRealDirectory(
    access.sandboxRoot,
    'regression_stt_access_sandbox_invalid',
  );
  const dataRoot = assertIsolatedRegressionDataRoot(access.dataRoot, {
    sandboxRoot,
    protectedRoots: [],
  });
  const manifestPath = path.resolve(String(access.manifestPath || ''));
  if (
    normalizedPath(manifestPath) !== normalizedPath(path.join(
      sandboxRoot,
      TASK_REGRESSION_ISOLATION_MANIFEST,
    ))
    || !pathInside(sandboxRoot, manifestPath)
  ) fail('regression_stt_access_manifest_invalid');
  assertSafeOwnedRegularFile(
    manifestPath,
    'regression_stt_access_manifest_invalid',
    { maximumBytes: 8 * 1024 },
  );
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {
    fail('regression_stt_access_manifest_invalid');
  }
  const expectedManifestKeys = [
    'acceptanceRunId', 'buildIdentityDigest', 'createdAt', 'dataRootSha256',
    'desktopRelayArtifactsRootSha256', 'desktopRelayProofSha256',
    'desktopRelayTargets', 'expiresAt', 'kind', 'proofSha256', 'runnerPid',
    'sandboxId', 'sandboxRootSha256', 'schemaVersion', 'snapshotBindings',
    'signerBootstrapSha256', 'sttCredentialSha256',
  ].sort();
  const actualManifestKeys = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? Object.keys(manifest).sort()
    : [];
  const credential = String(access.sttCredential || '');
  const credentialSha256 = String(access.sttCredentialSha256 || '').toLowerCase();
  const proof = String(access.proof || '');
  const proofSha256 = String(access.proofSha256 || '').toLowerCase();
  const desktopRelayProof = String(access.desktopRelayProof || '');
  const desktopRelayProofSha256 = String(access.desktopRelayProofSha256 || '').toLowerCase();
  const signerBootstrap = String(access.signerBootstrap || '');
  const signerBootstrapSha256 = String(access.signerBootstrapSha256 || '').toLowerCase();
  const createdAtMs = Date.parse(String(manifest?.createdAt || ''));
  const expiresAtMs = Date.parse(String(manifest?.expiresAt || ''));
  const nowMs = Date.now();
  const snapshotBindingsMatch = Array.isArray(access.snapshotBindings)
    && Array.isArray(manifest?.snapshotBindings)
    && stableTaskRegressionProbeJson(manifest?.snapshotBindings)
      === stableTaskRegressionProbeJson(access.snapshotBindings);
  const hasS6Binding = Array.isArray(manifest?.snapshotBindings)
    && manifest.snapshotBindings.some(binding => (
      binding?.scenarioId === 'voice_to_text_continuation'
      && Array.isArray(binding.phases)
      && binding.phases.length === 1
      && binding.phases[0]?.phaseId === 'text_continue'
    ));
  if (
    actualManifestKeys.length !== expectedManifestKeys.length
    || actualManifestKeys.some((key, index) => key !== expectedManifestKeys[index])
    || manifest?.kind !== 'lumi.task-regression-isolation'
    || manifest?.schemaVersion !== 3
    || manifest?.acceptanceRunId !== access.acceptanceRunId
    || manifest?.runnerPid !== process.pid
    || manifest?.sandboxRootSha256 !== sha256(normalizedPath(sandboxRoot))
    || manifest?.dataRootSha256 !== sha256(normalizedPath(dataRoot))
    || manifest?.buildIdentityDigest !== access.buildIdentityDigest
    || manifest?.proofSha256 !== proofSha256
    || manifest?.sttCredentialSha256 !== credentialSha256
    || manifest?.desktopRelayProofSha256 !== desktopRelayProofSha256
    || manifest?.signerBootstrapSha256 !== signerBootstrapSha256
    || !snapshotBindingsMatch
    || !/^[A-Za-z0-9_-]{43,256}$/u.test(credential)
    || !/^[A-Za-z0-9_-]{43,256}$/u.test(proof)
    || !/^[A-Za-z0-9_-]{43,256}$/u.test(desktopRelayProof)
    || !/^[A-Za-z0-9_-]{43,256}$/u.test(signerBootstrap)
    || !/^[a-f0-9]{64}$/u.test(credentialSha256)
    || !/^[a-f0-9]{64}$/u.test(proofSha256)
    || !/^[a-f0-9]{64}$/u.test(desktopRelayProofSha256)
    || !/^[a-f0-9]{64}$/u.test(signerBootstrapSha256)
    || !/^[a-f0-9]{64}$/u.test(String(access.buildIdentityDigest || ''))
    || sha256(credential) !== credentialSha256
    || sha256(proof) !== proofSha256
    || sha256(desktopRelayProof) !== desktopRelayProofSha256
    || sha256(signerBootstrap) !== signerBootstrapSha256
    || credentialSha256 === proofSha256
    || credentialSha256 === desktopRelayProofSha256
    || proofSha256 === desktopRelayProofSha256
    || [credentialSha256, proofSha256, desktopRelayProofSha256]
      .includes(signerBootstrapSha256)
    || !Number.isFinite(createdAtMs)
    || !Number.isFinite(expiresAtMs)
    || createdAtMs > nowMs + 30_000
    || nowMs - createdAtMs > 5 * 60_000
    || expiresAtMs <= nowMs
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > 45 * 60_000
    || !hasS6Binding
  ) fail('regression_stt_access_manifest_binding_invalid');
  return Object.freeze({ credential, credentialSha256 });
}

export async function startDeterministicRegressionModelStub(options) {
  const requests = [];
  const decisions = [];
  const sttCaptures = [];
  const isolatedSttAccess = options.s6SttTranscript
    ? validateIsolatedSttAccess(options.evidenceAccess)
    : null;
  const state = {
    confirmationArtifact: options.confirmationArtifact,
    confirmationContent: options.confirmationContent,
    staleFixture: options.staleFixture,
    staleFixtureContent: String(options.staleFixtureContent || ''),
    stalePendingFixture: options.stalePendingFixture || `${options.staleFixture}.pending.txt`,
    restartArtifact: String(options.restartArtifact || ''),
    restartArtifactContent: String(options.restartArtifactContent || ''),
    wpsWrongName: String(options.wpsWrongName || ''),
    wpsWrongContent: String(options.wpsWrongContent || ''),
    wpsCorrectName: String(options.wpsCorrectName || ''),
    wpsCorrectContent: String(options.wpsCorrectContent || ''),
    wpsCorrectSummary: String(options.wpsCorrectSummary || ''),
    wpsCorrectPath: String(options.wpsCorrectPath || ''),
    s6MissingPath: String(options.s6MissingPath || ''),
    s6SearchDirectory: String(options.s6SearchDirectory || ''),
    s6CorrectPath: String(options.s6CorrectPath || ''),
    s6CorrectContent: String(options.s6CorrectContent || ''),
    s6SttTranscript: String(options.s6SttTranscript || ''),
    s6SttCredential: isolatedSttAccess?.credential || '',
    s8FixturePath: String(options.s8FixturePath || ''),
    s8FixtureContent: String(options.s8FixtureContent || ''),
    s8FinalText: String(options.s8FinalText || ''),
    s8ToolCallId: `call_s8_${sha256(String(options.s8FixturePath || 'missing')).slice(0, 24)}`,
    s1SeedTitles: Object.fromEntries(['A', 'B', 'C'].map(key => [
      key,
      String(options.s1SeedTitles?.[key] || '').trim().slice(0, 140),
    ])),
    longDelayMs: Number.isSafeInteger(options.longDelayMs) && options.longDelayMs >= 1
      ? options.longDelayMs
      : 15_000,
  };
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${LOOPBACK_HOST}`);
    if (req.method === 'GET' && (requestUrl.pathname === '/v1/models' || requestUrl.pathname === '/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(requestUrl.pathname === '/api/tags'
        ? { models: [] }
        : { object: 'list', data: [{ id: 'lumi-regression-stub-v1', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/disabled-tts') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'TTS disabled in isolated S6 regression' } }));
      return;
    }
    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > 4 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'request too large' } }));
        return;
      }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      const receivedAt = new Date().toISOString();
      const capture = summarizeProviderRequest(body, raw, receivedAt, state);
      const rawText = raw.toString('utf8');
      if (capture.scenarioId === 'wps_wrong_file_correction') {
        capture.containsWrongFixtureContent = Boolean(
          state.wpsWrongContent && rawText.includes(state.wpsWrongContent),
        );
        capture.containsCorrectFixtureContent = Boolean(
          state.wpsCorrectContent && rawText.includes(state.wpsCorrectContent),
        );
      }
      if (capture.scenarioId === 'voice_to_text_continuation') {
        const decodedMessageText = allMessageText(body);
        capture.containsVoiceMissingTarget = Boolean(
          state.s6MissingPath && decodedMessageText.includes(state.s6MissingPath),
        );
        capture.containsCorrectTarget = Boolean(
          state.s6CorrectPath
          && decodedMessageText.includes(path.basename(state.s6CorrectPath)),
        );
        capture.containsCorrectFixtureContent = Boolean(
          state.s6CorrectContent && decodedMessageText.includes(state.s6CorrectContent),
        );
      }
      if (capture.scenarioId === 'primary_model_failover_lmstudio') {
        const continuation = verifiedToolContinuation(body, {
          callId: state.s8ToolCallId,
          toolName: 'read_file',
          sentinel: state.s8FixtureContent,
        });
        capture.containsS8FixtureContent = rawText.includes(state.s8FixtureContent);
        capture.pairedAssistantToolCallAndReceipt = continuation.ok;
        capture.pairedAssistantToolCallCount = continuation.assistantCount;
        capture.pairedToolReceiptCount = continuation.receiptCount;
        capture.s8ToolCallIdSha256 = sha256(state.s8ToolCallId);
      }
      requests.push(capture);
      const decision = decideModelResponse(body, state);
      capture.scheduledDelayMs = Number(decision.delayMs || 0);
      decisions.push({
        captureIndex: requests.length - 1,
        scenarioId: capture.scenarioId,
        receivedAt,
        type: decision.type,
        ...(decision.type === 'tool' ? { toolName: decision.name } : {}),
        ...(decision.type === 'tool' ? {
          logicalTool: decision.name,
          argumentsSha256: sha256(stableTaskRegressionProbeJson(decision.arguments || {})),
          targetSha256: sha256(String(
            decision.arguments?.path
              || decision.arguments?.filePath
              || decision.arguments?.target
              || '',
          )),
        } : {}),
        ...(decision.type === 'text' ? {
          responseTextSha256: sha256(String(decision.text || '')),
          responseTextCharCount: String(decision.text || '').length,
          ...(typeof decision.verifiedFixtureContent === 'boolean'
            ? { verifiedFixtureContent: decision.verifiedFixtureContent }
            : {}),
          ...(typeof decision.verifiedToolContinuation === 'boolean'
            ? { verifiedToolContinuation: decision.verifiedToolContinuation }
            : {}),
        } : {}),
        ...(decision.missingDeclaredTool ? { missingDeclaredTool: decision.missingDeclaredTool } : {}),
      });
      const deliver = () => {
        if (res.destroyed || res.writableEnded) return;
        capture.deliveredAt = new Date().toISOString();
        if (body.stream === true) writeSse(res, decision, String(body.model || 'lumi-regression-stub-v1'));
        else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(openAiCompletion(decision, String(body.model || 'lumi-regression-stub-v1'))));
        }
      };
      if (decision.delayMs) {
        const timer = setTimeout(deliver, decision.delayMs);
        const cancelDelayedDelivery = () => {
          if (res.writableEnded) return;
          clearTimeout(timer);
          capture.abortedAt = new Date().toISOString();
        };
        req.once('aborted', cancelDelayedDelivery);
        res.once('close', cancelDelayedDelivery);
      } else deliver();
    });
  });
  const sttServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try { requestUrl = new URL(request.url || '/', `http://${LOOPBACK_HOST}`); } catch {
      socket.destroy();
      return;
    }
    if (
      !state.s6SttTranscript
      || requestUrl.pathname !== '/asr'
      || requestUrl.search
      || requestUrl.hash
    ) {
      socket.destroy();
      return;
    }
    if (request.headers['x-api-key'] !== state.s6SttCredential) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    sttServer.handleUpgrade(request, socket, head, ws => {
      sttServer.emit('connection', ws, request);
    });
  });
  sttServer.on('connection', (ws, request) => {
    const capture = {
      connectedAt: new Date().toISOString(),
      authorizedWithIsolatedCredential: request.headers['x-api-key'] === state.s6SttCredential,
      resourceIdPresent: Boolean(String(request.headers['x-api-resource-id'] || '').trim()),
      connectIdPresent: Boolean(String(request.headers['x-api-connect-id'] || '').trim()),
      handshakeReceived: false,
      audioFrameCount: 0,
      audioByteCount: 0,
      finalTranscriptSha256: sha256(state.s6SttTranscript),
      finalTranscriptCharCount: state.s6SttTranscript.length,
      finalDeliveredAt: '',
      closedAt: '',
    };
    sttCaptures.push(capture);
    let delivered = false;
    ws.on('message', raw => {
      const packet = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (packet.length < 4) return;
      const messageType = packet[1] >> 4;
      if (messageType === 0x1) {
        capture.handshakeReceived = true;
        ws.send(doubaoRegressionAckPacket());
        return;
      }
      if (messageType !== 0x2) return;
      capture.audioFrameCount += 1;
      capture.audioByteCount += packet.length;
      if (delivered) return;
      delivered = true;
      capture.finalDeliveredAt = new Date().toISOString();
      ws.send(doubaoRegressionFinalPacket(state.s6SttTranscript));
    });
    ws.on('close', () => { capture.closedAt = new Date().toISOString(); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) fail('regression_model_stub_start_failed');
  return {
    server,
    port,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    sttWsUrl: state.s6SttTranscript ? `ws://${LOOPBACK_HOST}:${port}/asr` : '',
    requests,
    decisions,
    sttCaptures,
    async close() {
      for (const client of sttServer.clients) client.terminate();
      await new Promise(resolve => sttServer.close(() => resolve()));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function waitForSocketReady(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let boundary = null;
    const timer = setTimeout(() => finish(new TaskRegressionBlackBoxError('regression_socket_ready_timeout')), timeoutMs);
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
    const maybeFinish = () => { if (connected && boundary) finish(); };
    const onConnect = () => { connected = true; maybeFinish(); };
    const onError = error => {
      const code = String(error?.data?.code || '').trim();
      const diagnosticCode = String(error?.data?.diagnosticCode || '').trim();
      finish(new TaskRegressionBlackBoxError('regression_socket_auth_failed', {
        connectErrorCode: /^[A-Z][A-Z0-9_]{2,119}$/u.test(code) ? code : 'UNCLASSIFIED',
        diagnosticCode: /^task_regression_desktop_relay_[a-z0-9_]{2,119}$/u.test(diagnosticCode)
          ? diagnosticCode
          : 'task_regression_desktop_relay_diagnostic_unavailable',
      }));
    };
    const onBoundary = payload => { boundary = payload; maybeFinish(); };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
    socket.on('runtime:execution_boundary', onBoundary);
    socket.connect();
  });
}

function pidAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (process.platform === 'win32' && error?.code === 'EINVAL') return false;
    return true;
  }
}

async function waitForPidDeath(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAppearsAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !pidAppearsAlive(pid);
}

export async function openIsolatedRegressionBackendSession(input) {
  const runtime = input?.runtime;
  if (!runtime?.processIdentity || runtime.child?.exitCode !== null || runtime.child?.signalCode !== null) {
    fail('regression_backend_session_runtime_invalid');
  }
  const session = await bootstrapDesktopTestSession(runtime.baseUrl, input.sandbox.dataRoot, {
    timeoutMs: 15_000,
    sourceRoot: runtime.target.root,
  });
  const token = String(session?.token || '');
  const desktopSessionProof = String(session?.desktopSessionProof || '');
  if (!token || !desktopSessionProof) fail('regression_desktop_bootstrap_invalid');
  await fetchJson(runtime.baseUrl, '/preferences/llm', {
    token,
    method: 'PUT',
    body: {
      provider: 'openai',
      model: 'lumi-regression-stub-v1',
      models: { openai: 'lumi-regression-stub-v1' },
      selectionMode: 'pinned',
      fallbackCandidates: [],
      allowCloudFallback: false,
    },
  });
  const socket = createSocketClient(new URL(runtime.baseUrl).origin, {
    autoConnect: false,
    transports: ['websocket'],
    auth: {
      token,
      desktopSessionProof,
      taskRegressionDesktopRelayProof: input.evidenceAccess.desktopRelayProof,
    },
  });
  try {
    const boundary = await waitForSocketReady(socket, input.socketTimeoutMs || 15_000);
    if (boundary?.trustedLocalExecution !== true) fail('regression_trusted_local_boundary_required');
    return { token, socket, boundary };
  } catch (error) {
    try { socket.disconnect(); } catch {}
    throw error;
  }
}

/**
 * Stop one real isolated backend and reopen the same runner-owned data root.
 * The returned projection binds both native process generations without
 * exposing the data-root lease owner token or desktop bootstrap proof.
 */
export async function restartIsolatedRegressionBackendSession(input) {
  const oldRuntime = input?.runtime;
  const oldIdentity = oldRuntime?.processIdentity;
  if (!oldIdentity) fail('regression_restart_old_identity_missing');
  const beforeLease = inspectIsolatedRegressionBackendLease(input.sandbox);
  if (beforeLease.state !== 'present' || beforeLease.pid !== oldIdentity.pid) {
    fail('regression_restart_old_lease_mismatch');
  }
  try { input.socket?.disconnect(); } catch {}
  await stopIsolatedRegressionBackend(oldRuntime, input.stopTimeoutMs || 8_000);
  if (
    oldRuntime.child.exitCode === null
    && oldRuntime.child.signalCode === null
  ) fail('regression_restart_old_process_exit_unobserved');
  if (!(await waitForPidDeath(oldIdentity.pid))) fail('regression_restart_old_pid_still_alive');
  const afterStopLease = inspectIsolatedRegressionBackendLease(input.sandbox);

  let nextRuntime = null;
  try {
    nextRuntime = await startIsolatedRegressionBackend({
      worktree: input.worktree,
      sandbox: input.sandbox,
      modelStubBaseUrl: input.modelStubBaseUrl,
      primaryFailureBaseUrl: input.primaryFailureBaseUrl,
      sttStubUrl: input.sttStubUrl,
      startupTimeoutMs: input.startupTimeoutMs,
      evidenceAccess: input.evidenceAccess,
    });
    const nextIdentity = nextRuntime.processIdentity;
    if (
      nextIdentity.pid === oldIdentity.pid
      || nextIdentity.startedAt === oldIdentity.startedAt
      || nextIdentity.identitySha256 === oldIdentity.identitySha256
      || nextIdentity.buildId !== oldIdentity.buildId
      || nextIdentity.sourceFingerprint !== oldIdentity.sourceFingerprint
      || normalizedPath(nextRuntime.target.root) !== normalizedPath(oldRuntime.target.root)
      || normalizedPath(input.sandbox.dataRoot) !== normalizedPath(input.evidenceAccess.dataRoot)
    ) fail('regression_restart_process_transition_invalid');
    const afterRestartLease = inspectIsolatedRegressionBackendLease(input.sandbox);
    if (
      afterRestartLease.state !== 'present'
      || afterRestartLease.pid !== nextIdentity.pid
      || afterRestartLease.ownerTokenSha256 === beforeLease.ownerTokenSha256
      || afterRestartLease.processStartIdentitySha256 === beforeLease.processStartIdentitySha256
    ) fail('regression_restart_new_lease_mismatch');
    const reopened = await openIsolatedRegressionBackendSession({
      runtime: nextRuntime,
      sandbox: input.sandbox,
      evidenceAccess: input.evidenceAccess,
      socketTimeoutMs: input.socketTimeoutMs,
    });
    return {
      runtime: nextRuntime,
      ...reopened,
      transition: {
        restartScope: 'backend-only',
        sameBuild: true,
        sameDataRoot: true,
        oldProcess: oldIdentity,
        newProcess: nextIdentity,
        oldProcessExit: {
          observed: true,
          exitCode: oldRuntime.child.exitCode ?? null,
          signal: oldRuntime.child.signalCode || null,
          pidNoLongerAlive: true,
          observedAt: new Date().toISOString(),
        },
        dataRootDigest: sha256(normalizedPath(input.sandbox.dataRoot)),
        lease: {
          before: beforeLease,
          afterStop: afterStopLease,
          afterRestart: afterRestartLease,
          oldGenerationReleasedOrReclaimed: afterStopLease.state === 'absent'
            || afterRestartLease.ownerTokenSha256 !== beforeLease.ownerTokenSha256,
        },
      },
    };
  } catch (error) {
    if (nextRuntime) await stopIsolatedRegressionBackend(nextRuntime).catch(() => {});
    throw error;
  }
}

function parsedRecord(value) {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try { current = JSON.parse(current); } catch { return null; }
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? current : null;
}

function parsedToolCalls(value) {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try { current = JSON.parse(current); } catch { return []; }
  }
  return Array.isArray(current) ? current : [];
}

function normalizedRuntimeTaskIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => String(item || '').trim().slice(0, 180))
    .filter(Boolean)))
    .slice(0, 64);
}

function sameExactTaskIdSet(left, right) {
  const a = normalizedRuntimeTaskIds(left).sort();
  const b = normalizedRuntimeTaskIds(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeToolEvent(payload) {
  const args = parsedRecord(payload?.arguments ?? payload?.args) || {};
  const toolName = String(payload?.name || payload?.toolName || '');
  const rawError = payload?.error && typeof payload.error === 'object'
    ? String(payload.error.message || payload.error.code || '')
    : String(payload?.error || '');
  const explicitCode = String(
    payload?.code
      || (payload?.error && typeof payload.error === 'object' ? payload.error.code : '')
      || '',
  ).trim();
  const codeLikeMessage = /^[a-z][a-z0-9_]{2,119}$/u.test(rawError.trim())
    ? rawError.trim()
    : '';
  const errorCode = /^[A-Za-z][A-Za-z0-9_.:-]{1,119}$/u.test(explicitCode)
    ? explicitCode
    : codeLikeMessage;
  return {
    correlationId: String(payload?.correlationId || ''),
    requestId: String(payload?.requestId || ''),
    taskId: String(payload?.taskId || payload?.taskRelation?.taskId || ''),
    name: toolName,
    phase: payload?.error !== undefined ? 'error' : payload?.result !== undefined ? 'result' : 'start',
    argumentsSha256: sha256(stableTaskRegressionProbeJson(args && typeof args === 'object' ? args : {})),
    targetSha256: sha256(String(args?.path || args?.filePath || args?.target || args?.to || '')),
    hasResult: Boolean(String(payload?.result || '').trim()),
    resultSha256: sha256(String(payload?.result || '')),
    hasError: Boolean(payload?.error),
    errorCode,
    errorMessageCharCount: rawError.length,
    errorMessageSha256: sha256(rawError),
    ...(toolName === 'runtime_work_cancel'
      ? { exactTaskIds: normalizedRuntimeTaskIds(args.taskIds) }
      : {}),
  };
}

function normalizeTaskRelationEvent(payload) {
  const relation = payload?.taskRelation || payload?.relation || {};
  return {
    phase: String(payload?.phase || ''),
    taskRelation: String(relation?.taskRelation || ''),
    feedback: String(relation?.feedback || ''),
    binding: String(relation?.binding || ''),
    operation: String(relation?.operation || ''),
    taskId: String(relation?.taskId || ''),
    targetRequestId: String(relation?.targetRequestId || ''),
    revision: Math.max(0, Number(relation?.revision) || 0),
  };
}

function startTurn(socket, input) {
  const toolEvents = [];
  const statusEvents = [];
  const taskRelationEvents = [];
  let settled = false;
  let finishResponse;
  const responsePromise = new Promise(resolve => { finishResponse = resolve; });
  const cleanup = () => {
    clearTimeout(timer);
    socket.off('agent:response', onResponse);
    socket.off('agent:error', onError);
    socket.off('agent:tool_call', onTool);
    socket.off('agent:tool', onTool);
    socket.off('agent:status', onStatus);
    socket.off('agent:task_relation', onTaskRelation);
  };
  const finish = terminal => {
    if (settled) return;
    settled = true;
    cleanup();
    finishResponse({ ...terminal, observedAt: new Date().toISOString() });
  };
  const matches = payload => payload?.requestId === input.requestId;
  const onTool = payload => { if (matches(payload)) toolEvents.push(normalizeToolEvent(payload)); };
  const onStatus = payload => { if (matches(payload)) statusEvents.push(String(payload?.status || '')); };
  const onTaskRelation = payload => {
    if (matches(payload)) taskRelationEvents.push(normalizeTaskRelationEvent(payload));
  };
  const onError = payload => {
    if (matches(payload)) finish({ event: 'agent:error', payload, timedOut: false });
  };
  const onResponse = payload => {
    if (matches(payload) && payload?.finalized === true) finish({ event: 'agent:response', payload, timedOut: false });
  };
  const timer = setTimeout(() => finish({ event: 'timeout', payload: null, timedOut: true }), input.timeoutMs);
  socket.on('agent:response', onResponse);
  socket.on('agent:error', onError);
  socket.on('agent:tool_call', onTool);
  socket.on('agent:tool', onTool);
  socket.on('agent:status', onStatus);
  socket.on('agent:task_relation', onTaskRelation);
  const ackPromise = new Promise(resolve => {
    socket.timeout(Math.min(input.timeoutMs, 30_000)).emit('agent:chat', {
      text: input.text,
      history: [],
      agentId: input.agentId || 'lumi',
      personalityId: 'lumi',
      domain: 'personal',
      source: 'task-regression-black-box',
      requestId: input.requestId,
      conversationId: input.conversationId,
      ...(input.controlTargetRequestId ? { controlTargetRequestId: input.controlTargetRequestId } : {}),
    }, (error, ack) => resolve({
      ok: !error && ack?.ok === true && ack?.requestId === input.requestId,
      requestId: String(ack?.requestId || ''),
      error: error ? 'socket_ack_timeout' : String(ack?.error || ''),
    }));
  });
  return {
    requestId: input.requestId,
    ackPromise,
    responsePromise,
    toolEvents,
    statusEvents,
    async done() {
      const [ack, terminal] = await Promise.all([ackPromise, responsePromise]);
      const text = String(terminal?.payload?.text || terminal?.payload?.message || '');
      const completionFeedback = terminal?.payload?.completionFeedback;
      return {
        requestId: input.requestId,
        ack,
        terminal: {
          event: terminal?.event || 'unknown',
          finalized: terminal?.payload?.finalized === true,
          blocked: terminal?.payload?.blocked === true,
          reason: String(terminal?.payload?.reason || terminal?.payload?.code || ''),
          controlIntent: String(terminal?.payload?.controlIntent || ''),
          targetRequestId: String(terminal?.payload?.targetRequestId || ''),
          taskId: String(terminal?.payload?.taskRelation?.taskId || ''),
          completionFeedback: completionFeedback && typeof completionFeedback === 'object'
            ? {
                status: String(completionFeedback.status || ''),
                evidence: (Array.isArray(completionFeedback.evidence)
                  ? completionFeedback.evidence
                  : []).map(item => String(item || '')).slice(0, 20),
                blockers: (Array.isArray(completionFeedback.blockers)
                  ? completionFeedback.blockers
                  : []).map(item => String(item || '')).slice(0, 20),
                incomplete: (Array.isArray(completionFeedback.incomplete)
                  ? completionFeedback.incomplete
                  : []).map(item => String(item || '')).slice(0, 20),
              }
            : null,
          text,
          textSha256: sha256(text),
          textCharCount: text.length,
          timedOut: terminal?.timedOut === true,
          observedAt: String(terminal?.observedAt || ''),
        },
        toolEvents: [...toolEvents],
        statusEvents: [...statusEvents],
        taskRelationEvents: [...taskRelationEvents],
      };
    },
  };
}

async function runTurn(socket, input) {
  return startTurn(socket, input).done();
}

async function runAcceptedVoiceTurn(socket, input) {
  const toolPayloads = [];
  const taskRelationPayloads = [];
  const statusEvents = [];
  const confirmations = [];
  let utteranceEpoch = 0;
  let settled = false;
  let finish;
  const terminalPromise = new Promise(resolve => { finish = resolve; });
  const cleanup = () => {
    clearTimeout(timer);
    socket.off('agent:response', onResponse);
    socket.off('agent:error', onAgentError);
    socket.off('agent:tool_call', onTool);
    socket.off('agent:tool', onTool);
    socket.off('agent:task_relation', onTaskRelation);
    socket.off('audio:status', onStatus);
    socket.off('audio:confirm', onConfirm);
    socket.off('audio:error', onAudioError);
    socket.off('audio:voice_rejected', onVoiceRejected);
    socket.off('voiceprint:utterance_reset', onReset);
  };
  const settle = terminal => {
    if (settled) return;
    settled = true;
    cleanup();
    finish({ ...terminal, observedAt: new Date().toISOString() });
  };
  const onResponse = payload => {
    if (payload?.channel === 'voice' && payload?.finalized === true) {
      settle({ event: 'agent:response', payload, timedOut: false });
    }
  };
  const onAgentError = payload => {
    if (String(payload?.requestId || '').startsWith('voice_')) {
      settle({ event: 'agent:error', payload, timedOut: false });
    }
  };
  const onTool = payload => { toolPayloads.push(payload); };
  const onTaskRelation = payload => { taskRelationPayloads.push(payload); };
  const onStatus = payload => { statusEvents.push(String(payload?.status || '')); };
  const onConfirm = payload => { confirmations.push(String(payload?.text || '')); };
  const onAudioError = payload => settle({ event: 'audio:error', payload, timedOut: false });
  const onVoiceRejected = payload => settle({ event: 'audio:voice_rejected', payload, timedOut: false });
  const onReset = payload => { utteranceEpoch = Math.max(utteranceEpoch, Number(payload?.epoch) || 0); };
  const timer = setTimeout(
    () => settle({ event: 'timeout', payload: null, timedOut: true }),
    input.timeoutMs,
  );
  socket.on('agent:response', onResponse);
  socket.on('agent:error', onAgentError);
  socket.on('agent:tool_call', onTool);
  socket.on('agent:tool', onTool);
  socket.on('agent:task_relation', onTaskRelation);
  socket.on('audio:status', onStatus);
  socket.on('audio:confirm', onConfirm);
  socket.on('audio:error', onAudioError);
  socket.on('audio:voice_rejected', onVoiceRejected);
  socket.on('voiceprint:utterance_reset', onReset);

  socket.emit('audio:start', {
    agentId: 'lumi',
    personalityId: 'lumi',
    domain: 'personal',
    sessionId: input.captureSessionId,
    captureSessionId: input.captureSessionId,
    audioInputKind: 'synthetic_accepted_transcript',
    // This deliberately inaccessible profile keeps TTS out of a speech-input
    // continuity test; the STT lane remains fully real through its adapter.
    voiceId: '__lumi_regression_no_tts__',
  });
  const readinessDeadline = Date.now() + Math.min(input.timeoutMs, 10_000);
  while (
    !settled
    && Date.now() < readinessDeadline
    && (!statusEvents.includes('listening') || utteranceEpoch < 1)
  ) await new Promise(resolve => setTimeout(resolve, 15));
  if (!settled && (!statusEvents.includes('listening') || utteranceEpoch < 1)) {
    settle({ event: 'voice_start_timeout', payload: null, timedOut: true });
  }
  if (!settled) {
    socket.emit('voiceprint:result', {
      isOwnerSpeaking: true,
      confidence: 0.99,
      quality: 0.96,
      frameCount: 16,
      source: 'task-regression-local-mfcc',
      speakerLabel: 'S6 isolated owner',
      utteranceEpoch,
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    socket.emit('audio:chunk', Buffer.alloc(640, 7));
  }
  const terminal = await terminalPromise;
  const requestIdValue = String(terminal?.payload?.requestId || '');
  const text = String(terminal?.payload?.text || terminal?.payload?.message || '');
  return {
    requestId: requestIdValue,
    conversationId: String(terminal?.payload?.conversationId || ''),
    terminal: {
      event: terminal?.event || 'unknown',
      finalized: terminal?.payload?.finalized === true,
      blocked: terminal?.payload?.blocked === true,
      reason: String(terminal?.payload?.reason || terminal?.payload?.code || ''),
      text,
      textSha256: sha256(text),
      textCharCount: text.length,
      timedOut: terminal?.timedOut === true,
      observedAt: String(terminal?.observedAt || ''),
    },
    harnessAdmission: {
      captureSessionId: input.captureSessionId,
      captureMode: 'synthetic_accepted_transcript',
      utteranceEpoch,
      voiceprintResultInjected: true,
      confirmedTranscriptSha256: confirmations.length === 1 ? sha256(confirmations[0]) : '',
      confirmedTranscriptCharCount: confirmations.length === 1 ? confirmations[0].length : 0,
      confirmationCount: confirmations.length,
    },
    toolEvents: toolPayloads
      .filter(payload => String(payload?.requestId || '') === requestIdValue)
      .map(normalizeToolEvent),
    statusEvents,
    taskRelationEvents: taskRelationPayloads
      .filter(payload => String(payload?.requestId || '') === requestIdValue)
      .map(normalizeTaskRelationEvent),
  };
}

function requestId(runId, scenario, phase) {
  return `reg_${sha256(`${runId}:${scenario}:${phase}`).slice(0, 28)}`;
}

export function truthSnapshotBindings(runId, scenarios) {
  return scenarios.map(scenarioId => {
    if (scenarioId === 'control_stop_status_repeat') {
      return {
        scenarioId,
        phases: ['long', 'stop', 'status', 'repeat'].map(phaseId => ({
          phaseId,
          requestId: requestId(runId, scenarioId, phaseId),
        })),
      };
    }
    if (scenarioId === 'displayed_result_stale_receipt') {
      return {
        scenarioId,
        phases: DISPLAYED_STALE_RECEIPT_PHASES.map(phaseId => ({
          phaseId,
          requestId: requestId(runId, scenarioId, phaseId),
        })),
      };
    }
    if (scenarioId === 'mid_task_restart_recovery') {
      return {
        scenarioId,
        phases: MID_TASK_RESTART_PHASES.map(phaseId => ({
          phaseId,
          requestId: requestId(runId, scenarioId, phaseId),
        })),
      };
    }
    if (scenarioId === 'wps_wrong_file_correction') {
      return {
        scenarioId,
        phases: WPS_WRONG_FILE_CORRECTION_PHASES.map(phaseId => ({
          phaseId,
          requestId: requestId(runId, scenarioId, phaseId),
        })),
      };
    }
    const phase = TRUTH_SNAPSHOT_REQUEST_PHASE[scenarioId];
    if (!phase) fail('regression_truth_snapshot_binding_missing', { scenarioId });
    return {
      scenarioId,
      phases: [{ phaseId: phase, requestId: requestId(runId, scenarioId, phase) }],
    };
  });
}

async function createConversation(baseUrl, token, agentId = 'lumi') {
  const created = await fetchJson(baseUrl, '/conversations/new', {
    token,
    method: 'POST',
    body: { agentId, domain: 'personal' },
    query: { domain: 'personal' },
  });
  const conversationId = String(created?.conversation?.id || '');
  if (!conversationId) fail('regression_conversation_create_failed');
  return conversationId;
}

async function persistedMessages(baseUrl, token, conversationId) {
  const body = await fetchJson(baseUrl, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
    token,
  });
  return Array.isArray(body?.messages) ? body.messages : Array.isArray(body) ? body : [];
}

async function persistedConversation(baseUrl, token, conversationId) {
  const body = await fetchJson(baseUrl, '/conversations', {
    token,
    query: { domain: 'personal', limit: 100, offset: 0 },
  });
  return (Array.isArray(body?.conversations) ? body.conversations : [])
    .find(conversation => String(conversation?.id || '') === conversationId) || null;
}

async function runtimeStatus(baseUrl, token) {
  return fetchJson(baseUrl, '/runtime/status', { token, query: { domain: 'personal' } });
}

async function runtimeWorkSnapshot(baseUrl, token) {
  return fetchJson(baseUrl, '/autonomy/work', {
    token,
    query: { domain: 'personal' },
  });
}

async function routingReceipts(baseUrl, token, requestIdValue) {
  const body = await fetchJson(baseUrl, '/preferences/llm/routing-receipts', {
    token,
    query: { requestId: requestIdValue, limit: 20 },
  });
  return Array.isArray(body?.receipts) ? body.receipts : [];
}

async function setRegressionModelPreference(baseUrl, token, preference) {
  const body = await fetchJson(baseUrl, '/preferences/llm', {
    token,
    method: 'PUT',
    body: preference,
  });
  if (body?.success !== true) fail('regression_model_preference_update_failed');
  return body;
}

function routingReceiptEvidenceProjection(receipt) {
  return {
    id: String(receipt?.id || ''),
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
    startedAt: String(receipt?.startedAt || ''),
    completedAt: String(receipt?.completedAt || ''),
    attempts: (Array.isArray(receipt?.attempts) ? receipt.attempts : []).map(attempt => {
      const outbound = attempt?.outboundMessagesEvidence;
      return {
        provider: String(attempt?.provider || ''),
        model: String(attempt?.model || ''),
        status: String(attempt?.status || ''),
        reason: String(attempt?.reason || ''),
        errorCategory: String(attempt?.errorCategory || ''),
        errorDigest: String(attempt?.errorDigest || ''),
        visibleOutputCommitted: attempt?.visibleOutputCommitted === true,
        startedAt: String(attempt?.startedAt || ''),
        completedAt: String(attempt?.completedAt || ''),
        outboundActualInput: outbound ? {
          provider: String(outbound.provider || ''),
          model: String(outbound.model || ''),
          providerRequestShapeSha256: String(outbound.providerRequestShapeSha256 || ''),
          messagesSha256: String(outbound.messagesSha256 || ''),
          messageCount: Math.max(0, Number(outbound.messageCount) || 0),
          toolDeclarationsSha256: String(outbound.toolDeclarationsSha256 || ''),
          toolDeclarationCount: Math.max(0, Number(outbound.toolDeclarationCount) || 0),
          totalToolResultCount: Math.max(0, Number(outbound.totalToolResultCount) || 0),
          digestProtection: String(outbound.digestProtection || ''),
          digestKeyId: String(outbound.digestKeyId || ''),
          attestationSha256: String(outbound.attestationSha256 || ''),
        } : null,
      };
    }),
  };
}

function runtimeWorkItemByTitle(snapshot, title) {
  return (Array.isArray(snapshot?.items) ? snapshot.items : []).find(item => (
    String(item?.title || '') === String(title || '')
  )) || null;
}

function runtimeWorkEvidence(snapshot, taskIds) {
  const byId = new Map((Array.isArray(snapshot?.items) ? snapshot.items : [])
    .map(item => [String(item?.id || ''), item]));
  return normalizedRuntimeTaskIds(taskIds).map(taskId => {
    const item = byId.get(taskId);
    return {
      taskId,
      found: Boolean(item),
      kind: String(item?.kind || ''),
      phase: String(item?.phase || ''),
      canCancel: item?.controls?.canCancel === true,
      cancellationRequested: item?.cancellationRequested === true,
    };
  });
}

function exactAssistantToolCall(messages, requestIdValue, toolName) {
  const requestIdText = String(requestIdValue || '');
  const assistant = (Array.isArray(messages) ? messages : []).find(message => (
    String(message?.role || '') === 'assistant'
    && String(message?.requestId || '') === requestIdText
  ));
  const calls = parsedToolCalls(assistant?.toolCalls)
    .filter(call => String(call?.name || '') === toolName);
  return {
    assistant: assistant || null,
    calls,
    call: calls.length === 1 ? calls[0] : null,
  };
}

function findTaskByMarker(runtime, marker) {
  return (Array.isArray(runtime?.tasks) ? runtime.tasks : []).find(task => (
    String(task?.goal || '').includes(marker)
  )) || null;
}

function findTaskById(runtime, taskId) {
  const expected = String(taskId || '');
  if (!expected) return null;
  return (Array.isArray(runtime?.tasks) ? runtime.tasks : []).find(task => (
    String(task?.taskId || '') === expected
  )) || null;
}

function safeTaskProjection(task) {
  if (!task) return null;
  const receipts = Array.isArray(task?.evidence?.latest) ? task.evidence.latest : [];
  return {
    taskId: String(task.taskId || ''),
    status: String(task.status || ''),
    activeRequest: task.activeRequest === true,
    revision: Math.max(0, Number(task.revision) || 0),
    targetSha256: sha256(String(task.target || '')),
    receiptCount: Math.max(0, Number(task?.evidence?.total) || receipts.length),
    receipts: receipts.map(receipt => ({
      receiptId: String(receipt?.receiptId || ''),
      requestId: String(receipt?.requestId || ''),
      toolName: String(receipt?.toolName || ''),
      targetSha256: sha256(String(receipt?.targetIdentity || '')),
      outcome: String(receipt?.outcome || ''),
      verification: String(receipt?.verification || ''),
    })),
  };
}

function safeConversationPointerProjection(conversation) {
  const state = conversation?.actionContinuationState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {
      state: 'cleared',
      taskId: '',
      requestId: '',
      status: '',
      unfinished: false,
      revision: 0,
      assistantStateSha256: sha256(''),
      assistantStateCharCount: 0,
      taskCapsule: null,
    };
  }
  const assistantState = String(state.assistantState || '');
  const capsule = state.taskCapsule && typeof state.taskCapsule === 'object' && !Array.isArray(state.taskCapsule)
    ? state.taskCapsule
    : null;
  const capsuleTarget = capsule?.target && typeof capsule.target === 'object' && !Array.isArray(capsule.target)
    ? capsule.target
    : null;
  const capsuleCorrection = capsule?.latestCorrection
    && typeof capsule.latestCorrection === 'object'
    && !Array.isArray(capsule.latestCorrection)
    ? capsule.latestCorrection
    : null;
  return {
    state: String(state.taskId || '').trim() ? 'set' : 'cleared',
    taskId: String(state.taskId || ''),
    requestId: String(state.activeRequestId || ''),
    status: String(state.status || ''),
    unfinished: state.unfinished === true,
    revision: Math.max(0, Number(state.revision) || 0),
    assistantStateSha256: sha256(assistantState),
    assistantStateCharCount: assistantState.length,
    taskCapsule: capsule ? {
      taskId: String(capsule.taskId || ''),
      revision: Math.max(0, Number(capsule.revision) || 0),
      status: String(capsule.status || ''),
      unfinished: capsule.unfinished === true,
      target: capsuleTarget ? {
        labelSha256: sha256(String(capsuleTarget.label || '')),
        application: String(capsuleTarget.application || ''),
        windowSha256: sha256(String(capsuleTarget.window || '')),
        objectSha256: sha256(String(capsuleTarget.object || '')),
        pathSha256: sha256(String(capsuleTarget.path || '')),
        status: String(capsuleTarget.status || ''),
        source: String(capsuleTarget.source || ''),
      } : null,
      analysisReady: capsule.analysisReady === true,
      nextAction: String(capsule.nextAction || ''),
      latestCorrection: capsuleCorrection ? {
        textSha256: sha256(String(capsuleCorrection.text || '')),
        previousTargetSha256: sha256(String(capsuleCorrection.previousTarget || '')),
        replacementTargetSha256: sha256(String(capsuleCorrection.replacementTarget || '')),
      } : null,
      rejectedTargetSha256: (Array.isArray(capsule.rejectedTargets) ? capsule.rejectedTargets : [])
        .map(item => sha256(String(item?.identity || ''))),
    } : null,
  };
}

function transcriptProjection(messages, requestIds) {
  const selected = (Array.isArray(messages) ? messages : []).filter(message => requestIds.includes(String(message?.requestId || '')));
  return selected.map(message => {
    const text = String(message?.message || message?.content || message?.response || '');
    const toolCalls = Array.isArray(message?.toolCalls)
      ? message.toolCalls
      : typeof message?.toolCalls === 'string'
        ? (() => { try { return JSON.parse(message.toolCalls); } catch { return []; } })()
        : [];
    return {
      messageId: String(message?.id || ''),
      requestId: String(message?.requestId || ''),
      role: String(message?.role || ''),
      source: String(message?.source || ''),
      channel: String(message?.channel || ''),
      mode: String(message?.mode || ''),
      previousRequestId: String(message?.previousRequestId || ''),
      contextChainId: String(message?.contextChainId || ''),
      sttReceiptId: String(message?.sttReceiptId || ''),
      captureSessionId: String(message?.captureSessionId || ''),
      audioInputKind: String(message?.audioInputKind || ''),
      syntheticAudio: message?.syntheticAudio === true
        ? true
        : message?.syntheticAudio === false ? false : null,
      nativeClientIdentitySha256: String(message?.nativeClientIdentitySha256 || ''),
      cognitiveIntent: String(message?.cognitiveIntent || ''),
      textSha256: sha256(text),
      textCharCount: text.length,
      toolCalls: (Array.isArray(toolCalls) ? toolCalls : []).map(call => {
        const args = parsedRecord(call?.arguments) || {};
        const name = String(call?.name || '');
        return {
          name,
          executionOrigin: String(call?.executionOrigin || ''),
          capabilityOperation: String(call?.capability?.operation || ''),
          terminalVerificationStatus: String(call?.terminalVerification?.status || ''),
          envelopeStatus: String(call?.envelope?.status || ''),
          taskId: String(call?.taskId || ''),
          requestId: String(call?.requestId || ''),
          targetSha256: sha256(String(
            args.path
              || args.filePath
              || args.target
              || '',
          )),
          hasResult: Boolean(String(call?.result || '').trim()),
          hasError: Boolean(call?.error),
          errorMessageCharCount: String(call?.error || '').length,
          errorMessageSha256: sha256(String(call?.error || '')),
          ...(name === 'runtime_work_cancel'
            ? { exactTaskIds: normalizedRuntimeTaskIds(args.taskIds) }
            : {}),
        };
      }),
    };
  });
}

async function observeScenarioState(context, input) {
  const [messages, conversation, runtime, ...receiptLists] = await Promise.all([
    persistedMessages(context.baseUrl, context.token, input.conversationId),
    persistedConversation(context.baseUrl, context.token, input.conversationId),
    runtimeStatus(context.baseUrl, context.token),
    ...input.requestIds.map(id => routingReceipts(context.baseUrl, context.token, id)),
  ]);
  return {
    transcript: transcriptProjection(messages, input.requestIds),
    livePointer: safeConversationPointerProjection(conversation),
    task: safeTaskProjection(
      findTaskById(runtime, input.taskId)
      || findTaskByMarker(runtime, input.marker),
    ),
    routing: receiptLists.flat().map(receipt => ({
      id: String(receipt?.id || ''),
      requestId: String(receipt?.requestId || ''),
      status: String(receipt?.status || ''),
      provider: String(receipt?.selectedProvider || ''),
      model: String(receipt?.selectedModel || ''),
      attempts: Array.isArray(receipt?.attempts) ? receipt.attempts.length : 0,
      outboundEvidence: (Array.isArray(receipt?.attempts) ? receipt.attempts : [])
        .some(attempt => Boolean(attempt?.outboundMessagesEvidence)),
    })),
  };
}

async function waitForScenarioState(context, input, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await observeScenarioState(context, input);
    if (predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return latest || observeScenarioState(context, input);
}

function canonicalComparableFilesystemPath(value) {
  const supplied = String(value || '').trim();
  if (!supplied) return null;
  if (/^[a-z]:[\\/]/iu.test(supplied) || /^\\\\/u.test(supplied)) {
    if (!path.win32.isAbsolute(supplied)) return null;
    return path.win32.normalize(supplied.replace(/\//gu, '\\')).toLowerCase();
  }
  if (supplied.startsWith('/')) {
    if (!path.posix.isAbsolute(supplied)) return null;
    return path.posix.normalize(supplied);
  }
  return null;
}

function sameCanonicalFilesystemPath(left, right) {
  const leftPath = canonicalComparableFilesystemPath(left);
  const rightPath = canonicalComparableFilesystemPath(right);
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

/**
 * Validates the server-derived S6 join before the runner may use it as matrix
 * evidence. Harness transcript admission and provider observations are not
 * substitutes for this persisted request/task/receipt/correction chain.
 */
export function validateVoiceTextContinuationTruth(value, expected) {
  const issues = [];
  const object = candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {};
  const requireText = (candidate, field) => {
    if (!String(candidate || '').trim()) issues.push(`${field}:required`);
  };
  const requireSha = (candidate, field) => {
    if (!/^[a-f0-9]{64}$/u.test(String(candidate || ''))) issues.push(`${field}:sha256_required`);
  };
  const requireInstant = (candidate, field) => {
    if (!Number.isFinite(Date.parse(String(candidate || '')))) issues.push(`${field}:instant_required`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'voice_text_continuation_truth_invalid', issues: ['object_required'] };
  }
  for (const [field, expectedValue] of Object.entries({
    kind: 'lumi.voice-text-continuation-truth',
    schemaVersion: 1,
    scenarioId: 'voice_to_text_continuation',
    acceptanceRunId: expected.acceptanceRunId,
    buildIdentityDigest: expected.buildIdentityDigest,
    conversationId: expected.conversationId,
  })) {
    if (value[field] !== expectedValue) issues.push(`${field}:binding_mismatch`);
  }
  requireSha(value.buildIdentityDigest, 'buildIdentityDigest');
  requireInstant(value.capturedAt, 'capturedAt');

  const task = object(value.task);
  if (
    task.taskId !== expected.taskId
    || task.finalStatus !== 'completed'
    || !Number.isSafeInteger(task.revision)
    || task.revision < 2
  ) issues.push('task:binding_invalid');
  requireText(task.recordId, 'task.recordId');

  const voice = object(value.voiceStart);
  const voiceRequest = object(voice.request);
  const voiceUser = object(voice.userMessage);
  const voiceCapture = object(voice.capture);
  const voiceReceipt = object(voice.receipt);
  const voiceTarget = object(voiceReceipt.target);
  if (
    voiceRequest.requestId !== expected.voiceRequestId
    || voiceRequest.taskId !== expected.taskId
    || voiceRequest.channel !== 'voice'
    || voiceRequest.terminalStatus !== 'blocked'
    || voiceRequest.userMessageId !== voiceUser.recordId
  ) issues.push('voiceStart.request:binding_invalid');
  for (const field of ['recordId', 'userMessageId', 'assistantMessageId']) {
    requireText(voiceRequest[field], `voiceStart.request.${field}`);
  }
  requireInstant(voiceRequest.recordedAt, 'voiceStart.request.recordedAt');
  if (
    voiceUser.source !== 'voice'
    || voiceUser.channel !== 'voice'
    || voiceUser.mode !== 'voice'
  ) issues.push('voiceStart.userMessage:binding_invalid');
  requireSha(voiceUser.textSha256, 'voiceStart.userMessage.textSha256');
  requireInstant(voiceUser.recordedAt, 'voiceStart.userMessage.recordedAt');
  const expectedCaptureKeys = [
    'audioInputKind', 'captureMode', 'captureSessionId', 'contextChainId',
    'executionSessionId', 'nativeClientIdentitySha256', 'nativeDeviceId',
    'previousRequestId', 'sttReceiptId', 'syntheticAudio',
  ].sort();
  const actualCaptureKeys = Object.keys(voiceCapture).sort();
  if (
    actualCaptureKeys.length !== expectedCaptureKeys.length
    || actualCaptureKeys.some((key, index) => key !== expectedCaptureKeys[index])
    || voiceCapture.captureMode !== 'synthetic_accepted_transcript'
    || voiceCapture.audioInputKind !== 'synthetic_accepted_transcript'
    || voiceCapture.syntheticAudio !== true
    || [
      voiceCapture.captureSessionId,
      voiceCapture.contextChainId,
      voiceCapture.executionSessionId,
      voiceCapture.nativeClientIdentitySha256,
      voiceCapture.nativeDeviceId,
      voiceCapture.previousRequestId,
      voiceCapture.sttReceiptId,
    ].some(candidate => candidate !== null)
  ) issues.push('voiceStart.capture:synthetic_tuple_invalid');
  if (
    voiceReceipt.recordId !== voiceReceipt.receiptId
    || voiceReceipt.requestId !== expected.voiceRequestId
    || voiceReceipt.taskId !== expected.taskId
    || voiceReceipt.toolName !== 'read_file'
    || voiceReceipt.outcome !== 'failed'
    || voiceTarget.targetKind !== 'filesystem'
    || !sameCanonicalFilesystemPath(voiceTarget.targetId, expected.previousTarget)
  ) issues.push('voiceStart.receipt:binding_invalid');
  requireText(voiceReceipt.recordId, 'voiceStart.receipt.recordId');
  requireSha(voiceReceipt.inputSha256, 'voiceStart.receipt.inputSha256');
  requireSha(voiceTarget.targetSha256, 'voiceStart.receipt.target.targetSha256');
  if (voiceTarget.targetSha256 !== sha256(String(voiceTarget.targetId || ''))) {
    issues.push('voiceStart.receipt.target:digest_mismatch');
  }
  requireInstant(voiceReceipt.recordedAt, 'voiceStart.receipt.recordedAt');

  const text = object(value.textContinue);
  const textRequest = object(text.request);
  const textUser = object(text.userMessage);
  const textReceipt = object(text.receipt);
  const textTarget = object(textReceipt.target);
  if (
    textRequest.requestId !== expected.textRequestId
    || textRequest.taskId !== expected.taskId
    || textRequest.channel !== 'text'
    || textRequest.terminalStatus !== 'completed'
    || textRequest.userMessageId !== textUser.recordId
  ) issues.push('textContinue.request:binding_invalid');
  for (const field of ['recordId', 'userMessageId', 'assistantMessageId']) {
    requireText(textRequest[field], `textContinue.request.${field}`);
  }
  requireInstant(textRequest.recordedAt, 'textContinue.request.recordedAt');
  if (textUser.channel !== 'text' || textUser.cognitiveIntent !== 'task_correction') {
    issues.push('textContinue.userMessage:binding_invalid');
  }
  requireSha(textUser.textSha256, 'textContinue.userMessage.textSha256');
  requireInstant(textUser.recordedAt, 'textContinue.userMessage.recordedAt');
  if (
    textReceipt.recordId !== textReceipt.receiptId
    || textReceipt.requestId !== expected.textRequestId
    || textReceipt.taskId !== expected.taskId
    || textReceipt.toolName !== 'read_file'
    || textReceipt.outcome !== 'verified_success'
    || textTarget.targetKind !== 'filesystem'
    || !sameCanonicalFilesystemPath(textTarget.targetId, expected.replacementTarget)
  ) issues.push('textContinue.receipt:binding_invalid');
  requireText(textReceipt.recordId, 'textContinue.receipt.recordId');
  requireSha(textReceipt.inputSha256, 'textContinue.receipt.inputSha256');
  requireSha(textTarget.targetSha256, 'textContinue.receipt.target.targetSha256');
  if (textTarget.targetSha256 !== sha256(String(textTarget.targetId || ''))) {
    issues.push('textContinue.receipt.target:digest_mismatch');
  }
  requireInstant(textReceipt.recordedAt, 'textContinue.receipt.recordedAt');
  if (
    voiceReceipt.inputSha256 === textReceipt.inputSha256
    || sameCanonicalFilesystemPath(voiceTarget.targetId, textTarget.targetId)
  ) issues.push('receipt:correction_not_observed');

  const handoff = object(value.channelHandoff);
  if (
    handoff.sourceRequestId !== expected.voiceRequestId
    || handoff.targetRequestId !== expected.textRequestId
    || handoff.sourceTaskId !== expected.taskId
    || handoff.targetTaskId !== expected.taskId
    || handoff.sourceChannel !== 'voice'
    || handoff.targetChannel !== 'text'
    || !Array.isArray(handoff.sourceMessageIds)
    || handoff.sourceMessageIds.length !== 2
    || handoff.sourceMessageIds[0] !== voiceRequest.userMessageId
    || handoff.sourceMessageIds[1] !== voiceRequest.assistantMessageId
    || handoff.targetMessageId !== textRequest.userMessageId
  ) issues.push('channelHandoff:binding_invalid');
  requireInstant(handoff.recordedAt, 'channelHandoff.recordedAt');

  const correction = object(value.targetCorrection);
  if (
    correction.recordId !== textRequest.userMessageId
    || correction.correctionMessageId !== textRequest.userMessageId
    || correction.source !== 'user_correction'
    || correction.sourceRequestId !== expected.voiceRequestId
    || correction.targetRequestId !== expected.textRequestId
    || correction.taskId !== expected.taskId
    || !sameCanonicalFilesystemPath(correction.previousTarget, voiceTarget.targetId)
    || !sameCanonicalFilesystemPath(correction.replacementTarget, textTarget.targetId)
  ) issues.push('targetCorrection:binding_invalid');
  for (const field of [
    'previousTaskTargetSha256', 'replacementTaskTargetSha256', 'rejectedTargetSha256',
  ]) requireSha(correction[field], `targetCorrection.${field}`);
  if (
    correction.previousTaskTargetSha256 === correction.replacementTaskTargetSha256
    || correction.rejectedTargetSha256 !== correction.previousTaskTargetSha256
  ) issues.push('targetCorrection:task_target_binding_invalid');
  requireInstant(correction.recordedAt, 'targetCorrection.recordedAt');

  requireSha(value.evidenceDigestSha256, 'evidenceDigestSha256');
  const { evidenceDigestSha256: suppliedDigest, ...withoutDigest } = value;
  if (suppliedDigest !== sha256(stableTaskRegressionProbeJson(withoutDigest))) {
    issues.push('evidenceDigestSha256:mismatch');
  }
  return issues.length
    ? { ok: false, code: 'voice_text_continuation_truth_invalid', issues }
    : { ok: true, truth: value };
}

export function validateVoiceTextContinuationTruthEnvelope(value, expected) {
  try {
    const contract = exactRecord(expected?.serverTruthContract, [
      'kind', 'schemaVersion', 'pinScope', 'acceptanceRunId',
      'buildIdentityDigest', 'dataRootIdentitySha256', 'signer', 'contractSha256',
    ], 'regression_server_truth_contract_invalid');
    const { contractSha256, ...contractCore } = contract;
    if (contract.kind !== 'lumi.task-regression-server-truth-contract'
      || contract.schemaVersion !== 1
      || contract.pinScope !== 'before_voice_to_text_continuation_phase'
      || contract.acceptanceRunId !== expected.acceptanceRunId
      || contract.buildIdentityDigest !== expected.buildIdentityDigest
      || contract.dataRootIdentitySha256 !== expected.dataRootIdentitySha256
      || contractSha256 !== sha256(stableTaskRegressionProbeJson(contractCore))) {
      fail('regression_server_truth_contract_invalid');
    }
    const signer = normalizeTaskRegressionServerTruthSigner(contract.signer, {
      acceptanceRunId: contract.acceptanceRunId,
      buildIdentityDigest: contract.buildIdentityDigest,
      dataRootIdentitySha256: contract.dataRootIdentitySha256,
    });
    const envelope = exactRecord(value, [
      'kind', 'schemaVersion', 'binding', 'truth', 'attestation',
    ], 'regression_voice_text_truth_envelope_invalid');
    const binding = exactRecord(envelope.binding, [
      'acceptanceRunId', 'buildIdentityDigest', 'dataRootIdentitySha256',
      'serverInstanceNonce', 'scenarioId', 'conversationId', 'voiceRequestId',
      'textRequestId', 'taskId', 'capturedAt', 'evidenceDigestSha256',
    ], 'regression_voice_text_truth_envelope_invalid');
    const attestation = exactRecord(envelope.attestation, [
      'kind', 'schemaVersion', 'algorithm', 'keyId', 'signatureBase64',
    ], 'regression_voice_text_truth_envelope_invalid');
    if (envelope.kind !== 'lumi.voice-text-continuation-truth-envelope'
      || envelope.schemaVersion !== 1
      || attestation.kind !== 'lumi.voice-text-continuation-truth-attestation'
      || attestation.schemaVersion !== 1
      || attestation.algorithm !== 'ed25519'
      || attestation.keyId !== signer.keyId) {
      fail('regression_voice_text_truth_envelope_invalid');
    }
    let signature;
    let publicKey;
    try {
      signature = Buffer.from(String(attestation.signatureBase64 || ''), 'base64');
      if (signature.length !== 64
        || signature.toString('base64') !== attestation.signatureBase64) {
        fail('regression_voice_text_truth_envelope_invalid');
      }
      publicKey = crypto.createPublicKey({
        key: Buffer.from(signer.publicKeySpkiBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch (error) {
      if (error instanceof TaskRegressionBlackBoxError) throw error;
      fail('regression_voice_text_truth_envelope_invalid');
    }
    const signedCore = {
      kind: envelope.kind,
      schemaVersion: envelope.schemaVersion,
      binding,
      truth: envelope.truth,
    };
    const signedPayload = Buffer.concat([
      Buffer.from(SERVER_TRUTH_SIGNATURE_DOMAIN, 'utf8'),
      Buffer.from(stableTaskRegressionProbeJson(signedCore), 'utf8'),
    ]);
    if (!crypto.verify(null, signedPayload, publicKey, signature)) {
      fail('regression_voice_text_truth_envelope_signature_invalid');
    }
    const truth = validateVoiceTextContinuationTruth(envelope.truth, expected);
    if (!truth.ok) return truth;
    const expectedBinding = {
      acceptanceRunId: expected.acceptanceRunId,
      buildIdentityDigest: expected.buildIdentityDigest,
      dataRootIdentitySha256: expected.dataRootIdentitySha256,
      serverInstanceNonce: signer.serverInstanceNonce,
      scenarioId: 'voice_to_text_continuation',
      conversationId: expected.conversationId,
      voiceRequestId: expected.voiceRequestId,
      textRequestId: expected.textRequestId,
      taskId: expected.taskId,
      capturedAt: truth.truth.capturedAt,
      evidenceDigestSha256: truth.truth.evidenceDigestSha256,
    };
    if (stableTaskRegressionProbeJson(binding)
      !== stableTaskRegressionProbeJson(expectedBinding)) {
      fail('regression_voice_text_truth_envelope_binding_invalid');
    }
    return { ok: true, envelope, truth: truth.truth };
  } catch (error) {
    return {
      ok: false,
      code: 'voice_text_continuation_truth_envelope_invalid',
      issues: [String(error?.code || error?.message || 'invalid')],
    };
  }
}

async function attemptTruthSnapshot(context, selector) {
  const requestOnlyControl = selector.scenarioId === 'control_stop_status_repeat';
  if (!selector.requestId || (!requestOnlyControl && !selector.taskId)) {
    return { ok: false, code: 'truth_snapshot_selector_incomplete' };
  }
  const response = await fetchJson(context.baseUrl, DEFAULT_TRUTH_SNAPSHOT_ENDPOINT, {
    token: context.token,
    regressionProof: context.truthSnapshotProof,
    method: 'POST',
    body: {
      acceptanceRunId: context.runId,
      conversationId: selector.conversationId,
      requestId: selector.requestId,
      ...(requestOnlyControl ? {} : { taskId: selector.taskId }),
    },
    allowStatuses: [404, 405, 409, 422, 501],
  });
  if (response?.status) {
    if (response.status === 409 || response.status === 422) {
      return {
        ok: false,
        code: 'truth_snapshot_capture_rejected',
        serverCode: String(response?.body?.code || ''),
      };
    }
    return {
      ok: false,
      code: 'truth_snapshot_endpoint_unavailable',
      requiredEndpoint: `POST /api${DEFAULT_TRUTH_SNAPSHOT_ENDPOINT}`,
    };
  }
  const snapshot = response?.snapshot || response;
  const validation = validateTaskTruthSnapshot(snapshot, {
    expectedScenarioId: selector.scenarioId,
    expectedAcceptanceRunId: context.runId,
    expectedBuildIdentityDigest: context.buildIdentityDigest,
  });
  if (!validation.ok) {
    return { ok: false, code: 'truth_snapshot_invalid', issues: validation.issues };
  }
  if (selector.scenarioId === 'voice_to_text_continuation') {
    const continuation = validateVoiceTextContinuationTruthEnvelope(
      response?.voiceTextContinuationEnvelope,
      {
      acceptanceRunId: context.runId,
      buildIdentityDigest: context.buildIdentityDigest,
      dataRootIdentitySha256: context.serverTruthContract?.dataRootIdentitySha256,
      serverTruthContract: context.serverTruthContract,
      conversationId: selector.conversationId,
      taskId: selector.taskId,
      voiceRequestId: selector.voiceRequestId,
      textRequestId: selector.requestId,
      previousTarget: selector.previousTarget,
      replacementTarget: selector.replacementTarget,
      },
    );
    if (continuation.ok && (
      !response?.voiceTextContinuation
      || typeof response.voiceTextContinuation !== 'object'
      || Array.isArray(response.voiceTextContinuation)
      || stableTaskRegressionProbeJson(response.voiceTextContinuation)
        !== stableTaskRegressionProbeJson(continuation.truth)
    )) {
      return {
        ok: false,
        code: 'voice_text_continuation_raw_truth_mismatch',
        issues: ['raw_truth_does_not_match_signed_envelope'],
      };
    }
    return continuation.ok
      ? {
          ok: true,
          snapshot,
          voiceTextContinuation: continuation.truth,
          voiceTextContinuationEnvelope: continuation.envelope,
          serverTruthContractSha256: context.serverTruthContract.contractSha256,
        }
      : { ok: false, code: continuation.code, issues: continuation.issues };
  }
  return { ok: true, snapshot };
}

function validateStaleReceiptEvidence(value, expected) {
  const issues = [];
  const requireSha256 = (candidate, field) => {
    if (!/^[a-f0-9]{64}$/u.test(String(candidate || ''))) issues.push(`${field}:sha256_required`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'stale_receipt_evidence_invalid', issues: ['object_required'] };
  }
  if (value.kind !== 'lumi.task-regression-stale-receipt-evidence') issues.push('kind:mismatch');
  if (value.schemaVersion !== 1) issues.push('schemaVersion:mismatch');
  for (const [field, expectedValue] of Object.entries({
    scenarioId: 'displayed_result_stale_receipt',
    acceptanceRunId: expected.acceptanceRunId,
    buildIdentityDigest: expected.buildIdentityDigest,
    conversationId: expected.conversationId,
  })) {
    if (value[field] !== expectedValue) issues.push(`${field}:binding_mismatch`);
  }
  if (!String(value.evidenceId || '').trim()) issues.push('evidenceId:required');
  if (!Number.isFinite(Date.parse(String(value.capturedAt || '')))) issues.push('capturedAt:invalid');
  requireSha256(value.buildIdentityDigest, 'buildIdentityDigest');

  const source = value.sourceReceipt || {};
  const archive = value.archive || {};
  const oldOwner = value.oldOwner || {};
  const liveBefore = value.liveOwnerBefore || {};
  const liveAfter = value.liveOwnerAfter || {};
  const liveTaskAudit = value.liveTaskAudit || {};
  const stale = value.staleReclassification || {};
  const invariants = value.invariants || {};
  if (source.requestId !== expected.displayRequestId) issues.push('sourceReceipt.requestId:mismatch');
  if (source.toolName !== 'read_file') issues.push('sourceReceipt.toolName:mismatch');
  if (!source.recordId || !source.taskId) issues.push('sourceReceipt:identity_required');
  for (const field of [
    'recordSha256Before', 'recordSha256After', 'inputSha256', 'idempotencyKeySha256',
  ]) requireSha256(source[field], `sourceReceipt.${field}`);
  if (source.recordSha256Before !== source.recordSha256After) {
    issues.push('sourceReceipt:mutated');
  }
  if (
    archive.recordId === source.recordId
    || archive.taskId !== source.taskId
    || archive.requestId !== source.requestId
    || archive.toolName !== source.toolName
  ) issues.push('archive:source_binding_mismatch');
  if (!Number.isFinite(Date.parse(String(archive.createdAt || '')))) issues.push('archive.createdAt:invalid');
  requireSha256(archive.recordSha256, 'archive.recordSha256');
  requireSha256(archive.idempotencyKeySha256, 'archive.idempotencyKeySha256');

  if (
    oldOwner.taskId !== source.taskId
    || oldOwner.requestId !== expected.displayRequestId
    || oldOwner.turnStatus !== 'terminal'
    || oldOwner.leaseReleased !== true
  ) issues.push('oldOwner:lease_not_released');
  if (
    liveBefore.requestId !== expected.continueRequestId
    || liveBefore.taskId === source.taskId
    || !liveBefore.taskId
  ) issues.push('liveOwnerBefore:binding_mismatch');
  if (stableTaskRegressionProbeJson(liveAfter) !== stableTaskRegressionProbeJson(liveBefore)) {
    issues.push('liveOwnerAfter:mutated');
  }
  for (const ownerName of ['liveOwnerBefore', 'liveOwnerAfter']) {
    const owner = value[ownerName] || {};
    for (const field of ['taskSha256', 'pointerSha256', 'pendingSha256']) {
      requireSha256(owner[field], `${ownerName}.${field}`);
    }
  }
  for (const field of [
    'recordSha256Before', 'recordSha256After', 'semanticSha256Before', 'semanticSha256After',
  ]) requireSha256(liveTaskAudit[field], `liveTaskAudit.${field}`);
  const auditFields = Array.isArray(liveTaskAudit.changedFields)
    ? liveTaskAudit.changedFields
    : [];
  if (
    auditFields.length !== new Set(auditFields).size
    || auditFields.some(field => !['context.focusThread.updatedAt', 'updatedAt'].includes(field))
    || liveTaskAudit.semanticSha256Before !== liveBefore.taskSha256
    || liveTaskAudit.semanticSha256After !== liveAfter.taskSha256
    || liveTaskAudit.semanticSha256Before !== liveTaskAudit.semanticSha256After
    || ((liveTaskAudit.recordSha256Before === liveTaskAudit.recordSha256After) !== (auditFields.length === 0))
  ) issues.push('liveTaskAudit:invalid_audit_only_change');
  if (
    stale.observationKind !== 'stale_reclassification'
    || stale.sourceReceiptRef !== source.recordId
    || stale.mismatchDimension !== 'task_id'
    || stale.classification !== 'stale'
    || stale.archiveRef !== archive.recordId
    || stale.sourceReceiptUnchanged !== true
    || stale.leaseReleased !== true
  ) issues.push('staleReclassification:binding_mismatch');
  requireSha256(stale.classifierInputSha256, 'staleReclassification.classifierInputSha256');
  for (const field of [
    'sourceReceiptUnchanged',
    'newLiveTaskUnchanged',
    'newLivePointerUnchanged',
    'newPendingPointerUnchanged',
    'archiveBoundToSourceTask',
  ]) {
    if (invariants[field] !== true) issues.push(`invariants.${field}:required_true`);
  }
  return issues.length > 0
    ? { ok: false, code: 'stale_receipt_evidence_invalid', issues }
    : { ok: true, evidence: value };
}

async function attemptStaleReceiptReclassification(context, selector) {
  const response = await fetchJson(context.baseUrl, DEFAULT_STALE_RECEIPT_ENDPOINT, {
    token: context.token,
    regressionProof: context.truthSnapshotProof,
    method: 'POST',
    body: {
      acceptanceRunId: context.runId,
      conversationId: selector.conversationId,
    },
    allowStatuses: [404, 405, 409, 422, 501],
  });
  if (response?.status) {
    return response.status === 409 || response.status === 422
      ? {
        ok: false,
        code: 'stale_receipt_evidence_capture_rejected',
        serverCode: String(response?.body?.code || ''),
      }
      : {
        ok: false,
        code: 'stale_receipt_evidence_endpoint_unavailable',
        requiredEndpoint: `POST /api${DEFAULT_STALE_RECEIPT_ENDPOINT}`,
      };
  }
  return validateStaleReceiptEvidence(response?.evidence || response, {
    acceptanceRunId: context.runId,
    buildIdentityDigest: context.buildIdentityDigest,
    conversationId: selector.conversationId,
    displayRequestId: selector.displayRequestId,
    continueRequestId: selector.continueRequestId,
  });
}

function check(checkId, observed, evidence) {
  return { checkId, observed: observed === true, evidence };
}

async function runCleanupScenario(context) {
  const scenarioId = 'cleanup_offer_then_cleanup';
  const marker = '[LUMI_REGRESSION:S1]';
  // LumiCore is intentionally single-core: regression seed conversations must
  // use the canonical Lumi owner instead of an invented agent id. The chat
  // boundary rejects arbitrary agent ids so a harness-only seeder would never
  // reach the execution path it is meant to verify.
  const seederAgentId = 'lumi';
  const seederConversationId = await createConversation(
    context.baseUrl,
    context.token,
    seederAgentId,
  );
  const seedRequests = {
    A: requestId(context.runId, scenarioId, 'seed-a'),
    B: requestId(context.runId, scenarioId, 'seed-b'),
    C: requestId(context.runId, scenarioId, 'seed-c'),
  };
  const runSeed = key => runTurn(context.socket, {
    requestId: seedRequests[key],
    conversationId: seederConversationId,
    agentId: seederAgentId,
    timeoutMs: context.turnTimeoutMs,
    text: `[LUMI_REGRESSION:S1:SEED:${key}] 这是隔离运行任务种子。请新建一个客户工作接管任务并保持它可取消；不要执行或完成它。`,
  });
  const seedA = await runSeed('A');
  const seedB = await runSeed('B');
  const beforeOfferWork = await runtimeWorkSnapshot(context.baseUrl, context.token);
  const offeredItems = ['A', 'B'].map(key => (
    runtimeWorkItemByTitle(beforeOfferWork, context.s1SeedTitles[key])
  ));
  const offeredTaskIds = offeredItems.map(item => String(item?.id || '')).filter(Boolean);
  if (
    offeredTaskIds.length !== 2
    || new Set(offeredTaskIds).size !== 2
    || offeredItems.some(item => item?.controls?.canCancel !== true)
  ) fail('regression_s1_offered_runtime_work_seed_invalid');

  const conversationId = await createConversation(context.baseUrl, context.token);
  const offerId = requestId(context.runId, scenarioId, 'offer');
  const cleanupId = requestId(context.runId, scenarioId, 'cleanup');
  const offer = await runTurn(context.socket, {
    requestId: offerId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: `${marker} 这是隔离回归。后台工作现在怎么样？请用 runtime_work_status 核对哪些对象仍可由用户撤回；若有，请根据这次清单明确问我是否需要进一步处理。这一轮只核对，不做任何变更，也不从其他数据源猜测。`,
  });
  const offerMessages = await persistedMessages(context.baseUrl, context.token, conversationId);
  const offerRecord = exactAssistantToolCall(offerMessages, offerId, 'runtime_work_status');
  const frozenStatusResult = parsedRecord(offerRecord.call?.result);
  const frozenTaskIds = normalizedRuntimeTaskIds((Array.isArray(frozenStatusResult?.items)
    ? frozenStatusResult.items
    : [])
    .filter(item => item?.controls?.canCancel === true)
    .map(item => item?.id));
  const offerWasAdjacent = String(offerMessages.at(-1)?.id || '')
    === String(offerRecord.assistant?.id || '');
  const offerReceiptVerified = Boolean(
    offerRecord.call
    && !String(offerRecord.call.error || '').trim()
    && (
      offerRecord.call.terminalVerification?.status === 'verified'
      || offerRecord.call.envelope?.status === 'verified_success'
    )
    && frozenStatusResult?.ok === true
    && sameExactTaskIdSet(frozenTaskIds, offeredTaskIds)
  );

  // C starts only after the adjacent assistant offer has frozen A/B. It is
  // created in another active agent conversation so the target transcript's
  // immediate assistant/user adjacency remains intact.
  const seedC = await runSeed('C');
  const beforeCleanupWork = await runtimeWorkSnapshot(context.baseUrl, context.token);
  const laterItem = runtimeWorkItemByTitle(beforeCleanupWork, context.s1SeedTitles.C);
  const laterTaskId = String(laterItem?.id || '');
  if (!laterTaskId || laterItem?.controls?.canCancel !== true) {
    fail('regression_s1_later_runtime_work_seed_invalid');
  }
  const cleanupProviderRequestCountBefore = context.modelStub.requests.length;
  const cleanup = await runTurn(context.socket, {
    requestId: cleanupId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: '清理一下',
  });
  const cleanupProviderRequests = context.modelStub.requests.slice(cleanupProviderRequestCountBefore);
  const cleanupMessages = await persistedMessages(context.baseUrl, context.token, conversationId);
  const cleanupRecord = exactAssistantToolCall(cleanupMessages, cleanupId, 'runtime_work_cancel');
  const cleanupTaskId = String(cleanupRecord.call?.taskId || '');
  const state = await observeScenarioState(context, {
    marker, conversationId, requestIds: [offerId, cleanupId], taskId: cleanupTaskId,
  });
  const cleanupArgs = parsedRecord(cleanupRecord.call?.arguments) || {};
  const cleanupTaskIds = normalizedRuntimeTaskIds(cleanupArgs.taskIds);
  const cleanupEvents = cleanup.toolEvents.filter(item => item.name === 'runtime_work_cancel');
  const cleanupCorrelations = new Set(cleanupEvents
    .map(item => String(item.correlationId || ''))
    .filter(Boolean));
  const cleanupReceipts = (state.task?.receipts || []).filter(receipt => (
    receipt.requestId === cleanupId && receipt.toolName === 'runtime_work_cancel'
  ));
  const afterCleanupWork = await runtimeWorkSnapshot(context.baseUrl, context.token);
  const offeredAfter = runtimeWorkEvidence(afterCleanupWork, offeredTaskIds);
  const laterAfter = runtimeWorkEvidence(afterCleanupWork, [laterTaskId])[0];
  const exactCleanupObserved = Boolean(
    cleanupRecord.calls.length === 1
    && cleanupRecord.call
    && cleanupTaskId
    && cleanupRecord.call.requestId === cleanupId
    && cleanupRecord.call.executionOrigin === 'deterministic_route'
    && !String(cleanupRecord.call.error || '').trim()
    && (
      cleanupRecord.call.terminalVerification?.status === 'verified'
      || cleanupRecord.call.envelope?.status === 'verified_success'
    )
    && sameExactTaskIdSet(cleanupTaskIds, frozenTaskIds)
    && !cleanupTaskIds.includes(laterTaskId)
    && cleanupTaskIds.length > 0
    && cleanupCorrelations.size === 1
    && cleanupReceipts.length === 1
    && cleanupReceipts[0].verification === 'verified'
    && offeredAfter.every(item => item.found && item.phase === 'cancelled' && item.canCancel === false)
    && laterAfter?.found === true
    && laterAfter.phase === 'queued'
    && laterAfter.canCancel === true
    && cleanupProviderRequests.length === 0
  );
  const truth = await attemptTruthSnapshot(context, {
    scenarioId, conversationId, requestId: cleanupId, taskId: cleanupTaskId,
  });
  return {
    scenarioId,
    executionStatus: 'observed',
    turns: [offer, cleanup],
    seedTurns: [seedA, seedB, seedC],
    state,
    exactCleanupEvidence: {
      seederConversationId,
      offeredTaskIds,
      frozenTaskIds,
      laterTaskId,
      offerWasAdjacent,
      offerReceiptVerified,
      offerStatusToolCallCount: offerRecord.calls.length,
      cleanupToolCallCount: cleanupRecord.calls.length,
      cleanupTaskId,
      cleanupCorrelationCount: cleanupCorrelations.size,
      cleanupReceiptCount: cleanupReceipts.length,
      cleanupTaskIds,
      cleanupProviderRequestCount: cleanupProviderRequests.length,
      beforeCleanup: runtimeWorkEvidence(beforeCleanupWork, [...offeredTaskIds, laterTaskId]),
      afterCleanup: [...offeredAfter, laterAfter],
    },
    behaviorChecks: [
      check(
        'proposal_bound_to_cleanup',
        seedA.ack.ok
          && seedB.ack.ok
          && seedC.ack.ok
          && offer.ack.ok
          && offerWasAdjacent
          && offerReceiptVerified
          && /清理|取消|停止/u.test(offer.terminal.text),
        [offerId, ...frozenTaskIds],
      ),
      check(
        'cleanup_tool_executed',
        exactCleanupObserved,
        [...cleanupTaskIds, laterTaskId],
      ),
      check(
        'terminal_feedback_truthful',
        cleanup.ack.ok
          && cleanup.terminal.finalized
          && cleanup.terminal.blocked === false
          && cleanup.terminal.reason === 'runtime_cleanup_offer_completed'
          && !cleanup.terminal.timedOut
          && offeredTaskIds.every(taskId => cleanup.terminal.text.includes(taskId))
          && !cleanup.terminal.text.includes(laterTaskId),
        [cleanupId, ...offeredTaskIds],
      ),
    ],
    truthSnapshot: truth,
    matrixEligible: truth.ok,
  };
}

async function runRepeatedConfirmationScenario(context) {
  const scenarioId = 'repeated_confirmation_exactly_once';
  const marker = '[LUMI_REGRESSION:S2]';
  const conversationId = await createConversation(context.baseUrl, context.token);
  const pendingId = requestId(context.runId, scenarioId, 'pending');
  const firstId = requestId(context.runId, scenarioId, 'confirm-first');
  const secondId = requestId(context.runId, scenarioId, 'confirm-second');
  const pending = await runTurn(context.socket, {
    requestId: pendingId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: `${marker} 创建隔离确认门控文件 ${context.confirmationArtifact}；内容由验收模型固定。必须调用 desktop_write_text_file，并严格停在一次性确认边界。`,
  });
  const beforeExists = fs.existsSync(context.confirmationArtifact);
  const pendingState = await observeScenarioState(context, {
    marker, conversationId, requestIds: [pendingId],
  });
  const pendingAssistant = pendingState.transcript.find(message => (
    message.role === 'assistant' && message.requestId === pendingId
  ));
  const pendingTerminalIsCanonical = Boolean(
    pending.terminal.finalized
    && !pending.terminal.blocked
    && pending.terminal.reason === 'waiting_confirmation'
    && pendingAssistant
    && pending.terminal.textSha256 === pendingAssistant.textSha256
    && pending.terminal.textCharCount === pendingAssistant.textCharCount
    && pending.terminal.textSha256 === pendingState.livePointer.assistantStateSha256
    && pending.terminal.textCharCount === pendingState.livePointer.assistantStateCharCount,
  );
  const first = await runTurn(context.socket, {
    requestId: firstId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: '确认',
  });
  const afterFirstExists = fs.existsSync(context.confirmationArtifact);
  const afterFirstBytes = afterFirstExists ? fs.readFileSync(context.confirmationArtifact) : Buffer.alloc(0);
  const afterFirstStat = afterFirstExists ? fs.statSync(context.confirmationArtifact) : null;
  const firstConfirmationState = await observeScenarioState(context, {
    marker, conversationId, requestIds: [pendingId, firstId],
  });
  const firstConfirmationWriteReceipts = (firstConfirmationState.task?.receipts || [])
    .filter(receipt => receipt.toolName === 'desktop_write_text_file');
  const pendingWriteReceipts = firstConfirmationWriteReceipts.filter(receipt => (
    receipt.requestId === pendingId && receipt.outcome === 'waiting_confirmation'
  ));
  const confirmedWriteReceipts = firstConfirmationWriteReceipts.filter(receipt => (
    receipt.requestId === firstId && receipt.outcome === 'verified_success'
  ));
  const firstConfirmationSettledExactTask = Boolean(
    pendingState.task?.taskId
    && firstConfirmationState.task?.taskId === pendingState.task.taskId
    && firstConfirmationState.task?.status === 'completed'
    && firstConfirmationState.task?.activeRequest === false
    && firstConfirmationState.livePointer?.state === 'cleared'
    && pendingWriteReceipts.length === 1
    && confirmedWriteReceipts.length === 1
    && pendingWriteReceipts[0].targetSha256
      === confirmedWriteReceipts[0].targetSha256
  );
  const second = await runTurn(context.socket, {
    requestId: secondId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: '确认了',
  });
  const afterSecondExists = fs.existsSync(context.confirmationArtifact);
  const afterSecondBytes = afterSecondExists ? fs.readFileSync(context.confirmationArtifact) : Buffer.alloc(0);
  const afterSecondStat = afterSecondExists ? fs.statSync(context.confirmationArtifact) : null;
  const state = await observeScenarioState(context, {
    marker, conversationId, requestIds: [pendingId, firstId, secondId],
  });
  const writeReceipts = (state.task?.receipts || []).filter(receipt => receipt.toolName === 'desktop_write_text_file');
  const identicalArtifact = afterFirstExists && afterSecondExists
    && sha256(afterFirstBytes) === sha256(afterSecondBytes)
    && afterFirstBytes.toString('utf8') === context.confirmationContent
    && afterFirstStat?.size === afterSecondStat?.size
    && afterFirstStat?.mtimeMs === afterSecondStat?.mtimeMs;
  const truth = await attemptTruthSnapshot(context, {
    scenarioId, conversationId, requestId: firstId, taskId: state.task?.taskId,
  });
  return {
    scenarioId,
    executionStatus: 'observed',
    turns: [pending, first, second],
    stateTimeline: {
      afterPending: pendingState,
      afterFirstConfirmation: firstConfirmationState,
      afterRepeatedConfirmation: state,
    },
    state,
    artifact: {
      existedBeforeConfirmation: beforeExists,
      existedAfterFirstConfirmation: afterFirstExists,
      existedAfterRepeatedConfirmation: afterSecondExists,
      contentSha256: afterSecondExists ? sha256(afterSecondBytes) : null,
      byteLength: afterSecondExists ? afterSecondBytes.length : 0,
      mtimeUnchangedAfterRepeat: Boolean(afterFirstStat && afterSecondStat && afterFirstStat.mtimeMs === afterSecondStat.mtimeMs),
    },
    behaviorChecks: [
      check(
        'pending_action_preserved',
        !beforeExists
          && pendingState.task?.status === 'waiting_confirmation'
          && pendingTerminalIsCanonical,
        [
          pendingId,
          pendingState.task?.taskId,
          pending.terminal.textSha256,
          pendingAssistant?.textSha256,
          pendingState.livePointer.assistantStateSha256,
        ].filter(Boolean),
      ),
      check(
        'confirmation_resumed_exact_action',
        afterFirstBytes.toString('utf8') === context.confirmationContent
          && firstConfirmationSettledExactTask,
        [
          firstId,
          firstConfirmationState.task?.taskId,
          ...confirmedWriteReceipts.map(item => item.receiptId),
        ].filter(Boolean),
      ),
      check(
        'action_executed_exactly_once',
        identicalArtifact && second.toolEvents.every(event => event.name !== 'desktop_write_text_file'),
        writeReceipts.map(item => item.receiptId),
      ),
      check('duplicate_confirmation_idempotent', identicalArtifact && second.toolEvents.length === 0, [secondId]),
    ],
    truthSnapshot: truth,
    matrixEligible: truth.ok,
  };
}

async function runWpsWrongFileCorrectionScenario(context) {
  const scenarioId = 'wps_wrong_file_correction';
  const marker = '[LUMI_REGRESSION:S3]';
  const conversationId = await createConversation(context.baseUrl, context.token);
  const anchorId = requestId(context.runId, scenarioId, 'anchor');
  const correctionId = requestId(context.runId, scenarioId, 'correction');
  const supplyId = requestId(context.runId, scenarioId, 'supply-filename');
  const initialText = `${marker} 请分析当前 WPS 活动窗口里的演示文稿。先通过活动窗口建立目标锚点；当前文档路径未知，未确认文件名前不要读取。`;
  const correctionText = '不是这份文件';
  const supplyText = `准确文件名是 ${context.wpsCorrectName}，在桌面。请继续分析。`;
  const wrongTargetSha256 = sha256(context.wpsWrongFixture);
  const correctTargetSha256 = sha256(context.wpsCorrectFixture);
  const initialFixtureState = {
    wrong: {
      sha256: sha256(fs.readFileSync(context.wpsWrongFixture)),
      size: fs.statSync(context.wpsWrongFixture).size,
      mtimeMs: fs.statSync(context.wpsWrongFixture).mtimeMs,
    },
    correct: {
      sha256: sha256(fs.readFileSync(context.wpsCorrectFixture)),
      size: fs.statSync(context.wpsCorrectFixture).size,
      mtimeMs: fs.statSync(context.wpsCorrectFixture).mtimeMs,
    },
  };

  const anchor = await runTurn(context.socket, {
    requestId: anchorId,
    conversationId,
    timeoutMs: context.turnTimeoutMs,
    text: initialText,
  });
  const afterAnchor = await observeScenarioState(context, {
    marker,
    conversationId,
    requestIds: [anchorId],
  });
  const taskId = String(
    afterAnchor.livePointer?.taskId
      || afterAnchor.task?.taskId
      || anchor.taskRelationEvents.find(event => event.taskId)?.taskId
      || '',
  );

  const correction = await runTurn(context.socket, {
    requestId: correctionId,
    conversationId,
    timeoutMs: context.turnTimeoutMs,
    text: correctionText,
  });
  const afterCorrection = await observeScenarioState(context, {
    marker,
    conversationId,
    requestIds: [anchorId, correctionId],
    taskId,
  });

  const supply = await runTurn(context.socket, {
    requestId: supplyId,
    conversationId,
    timeoutMs: context.turnTimeoutMs,
    text: supplyText,
  });
  const finalState = await observeScenarioState(context, {
    marker,
    conversationId,
    requestIds: [anchorId, correctionId, supplyId],
    taskId,
  });
  const finalFixtureState = {
    wrong: {
      sha256: sha256(fs.readFileSync(context.wpsWrongFixture)),
      size: fs.statSync(context.wpsWrongFixture).size,
      mtimeMs: fs.statSync(context.wpsWrongFixture).mtimeMs,
    },
    correct: {
      sha256: sha256(fs.readFileSync(context.wpsCorrectFixture)),
      size: fs.statSync(context.wpsCorrectFixture).size,
      mtimeMs: fs.statSync(context.wpsCorrectFixture).mtimeMs,
    },
  };

  const allToolEvents = [anchor, correction, supply].flatMap(turn => turn.toolEvents || []);
  const allReceipts = finalState.task?.receipts || [];
  const wrongPathReads = [
    ...allToolEvents.filter(event => (
      /^(?:read_file|desktop_read_text_file|extract_document_text)$/u.test(event.name)
      && event.targetSha256 === wrongTargetSha256
    )),
    ...allReceipts.filter(receipt => (
      /^(?:read_file|desktop_read_text_file|extract_document_text)$/u.test(receipt.toolName)
      && receipt.targetSha256 === wrongTargetSha256
    )),
  ];
  const wrongPathMutations = [
    ...allToolEvents.filter(event => (
      /(?:write|delete|remove|modify|move|rename)/iu.test(event.name)
      && event.targetSha256 === wrongTargetSha256
    )),
    ...allReceipts.filter(receipt => (
      /(?:write|delete|remove|modify|move|rename)/iu.test(receipt.toolName)
      && receipt.targetSha256 === wrongTargetSha256
    )),
  ];
  const correctReadEvents = allToolEvents.filter(event => (
    event.name === 'extract_document_text'
    && event.targetSha256 === correctTargetSha256
  ));
  const correctReadReceipts = allReceipts.filter(receipt => (
    receipt.toolName === 'extract_document_text'
    && receipt.targetSha256 === correctTargetSha256
    && receipt.outcome === 'verified_success'
  ));
  const correctionRelations = correction.taskRelationEvents.filter(event => (
    event.taskRelation === 'correct'
    && event.feedback === 'correction'
    && event.taskId === taskId
  ));
  const observedTaskIds = [
    taskId,
    afterAnchor.livePointer?.taskId,
    afterAnchor.task?.taskId,
    afterCorrection.livePointer?.taskId,
    afterCorrection.task?.taskId,
    finalState.task?.taskId,
    ...correction.taskRelationEvents.map(event => event.taskId),
    ...supply.taskRelationEvents.map(event => event.taskId),
  ].map(value => String(value || '')).filter(Boolean);
  const sameTask = Boolean(taskId) && observedTaskIds.every(value => value === taskId);
  const scenarioProviderCaptures = context.modelStub.requests.filter(capture => (
    capture.scenarioId === scenarioId
  ));
  const scenarioProviderDecisions = context.modelStub.decisions.filter(decision => (
    decision.scenarioId === scenarioId
  ));
  const providerCorrectReadDecision = scenarioProviderDecisions.find(decision => (
    decision.logicalTool === 'extract_document_text'
    && decision.targetSha256 === correctTargetSha256
  ));
  const providerSawCorrectContent = scenarioProviderCaptures.some(capture => (
    capture.containsCorrectFixtureContent === true
  ));
  const providerSawWrongContent = scenarioProviderCaptures.some(capture => (
    capture.containsWrongFixtureContent === true
  ));
  const fixtureUnchanged = stableTaskRegressionProbeJson(initialFixtureState)
    === stableTaskRegressionProbeJson(finalFixtureState);
  const anchorCapsule = afterAnchor.livePointer?.taskCapsule;
  const correctedCapsule = afterCorrection.livePointer?.taskCapsule;
  const initialReplySelectedWrong = anchor.terminal.text.includes(context.wpsWrongName)
    && /不会读取|未读取/u.test(anchor.terminal.text);
  const finalReplyMatchesActualInput = supply.terminal.text.includes(context.wpsCorrectName)
    && supply.terminal.text.includes(context.wpsCorrectSummary)
    && providerSawCorrectContent
    && !providerSawWrongContent;

  const anchorTruth = await attemptTruthSnapshot(context, {
    scenarioId,
    conversationId,
    requestId: anchorId,
    taskId,
  });
  const finalTruth = await attemptTruthSnapshot(context, {
    scenarioId,
    conversationId,
    requestId: supplyId,
    taskId,
  });
  const behaviorChecks = [
    check(
      'current_wps_document_anchored',
      anchor.toolEvents.some(event => event.name === 'desktop_active_window' && event.hasResult)
        && initialReplySelectedWrong
        && anchorCapsule?.target?.application === 'WPS'
        && anchorCapsule?.target?.source === 'active_window'
        && anchorCapsule?.target?.pathSha256 === sha256('')
        && anchorCapsule?.target?.objectSha256 === sha256(context.wpsWrongName),
      [anchorId, taskId, sha256(context.wpsWrongName)].filter(Boolean),
    ),
    check(
      'wrong_target_rejected',
      wrongPathReads.length === 0
        && wrongPathMutations.length === 0
        && fixtureUnchanged
        && !providerSawWrongContent
        && correctedCapsule?.latestCorrection?.previousTargetSha256 === sha256(context.wpsWrongName)
        && correctedCapsule?.rejectedTargetSha256?.includes(sha256(context.wpsWrongName)),
      [correctionId, wrongTargetSha256, initialFixtureState.wrong.sha256],
    ),
    check(
      'correction_preserved',
      sameTask
        && correctionRelations.length > 0
        && correctedCapsule?.latestCorrection?.textSha256 === sha256(correctionText)
        && correctedCapsule?.target?.status === 'rejected',
      [taskId, correctionId, ...correctionRelations.map(event => event.phase)].filter(Boolean),
    ),
    check(
      'supplemental_filename_bound',
      sameTask
        && correctReadEvents.some(event => event.phase === 'result')
        && correctReadReceipts.length === 1
        && Boolean(providerCorrectReadDecision)
        && finalReplyMatchesActualInput,
      [supplyId, correctTargetSha256, correctReadReceipts[0]?.receiptId].filter(Boolean),
    ),
  ];

  return {
    scenarioId,
    executionStatus: 'observed',
    conversationId,
    taskId,
    requestIds: [anchorId, correctionId, supplyId],
    turns: [anchor, correction, supply],
    stateTimeline: { afterAnchor, afterCorrection, final: finalState },
    semanticDesktopRelay: {
      application: 'WPS',
      activeWindowCurrentDocumentPathKnown: false,
      candidateDirectory: '~/Desktop',
      candidates: [
        { name: context.wpsWrongName, pathSha256: wrongTargetSha256, contentSha256: initialFixtureState.wrong.sha256 },
        { name: context.wpsCorrectName, pathSha256: correctTargetSha256, contentSha256: initialFixtureState.correct.sha256 },
      ],
      finalReadBinding: {
        logicalTool: 'extract_document_text',
        transportTool: 'extract_document_text',
        transportBoundary: 'isolated_backend_filesystem',
        targetSha256: correctTargetSha256,
        manifestBound: true,
      },
    },
    wrongTargetExclusion: {
      readReceiptOrEventCount: wrongPathReads.length,
      mutationReceiptOrEventCount: wrongPathMutations.length,
      providerPayloadContainedWrongContent: providerSawWrongContent,
      fixtureUnchanged,
      before: initialFixtureState.wrong,
      after: finalFixtureState.wrong,
    },
    providerActualInput: {
      captureCount: scenarioProviderCaptures.length,
      captures: scenarioProviderCaptures,
      decisions: scenarioProviderDecisions,
      correctContentObserved: providerSawCorrectContent,
      wrongContentObserved: providerSawWrongContent,
      finalVisibleReplyConsistent: finalReplyMatchesActualInput,
    },
    truthSnapshots: { anchor: anchorTruth, supplyFilename: finalTruth },
    behaviorChecks,
    matrixEligible: anchorTruth.ok
      && finalTruth.ok
      && behaviorChecks.every(item => item.observed === true),
  };
}

export function evaluateDisplayedResultEvidence(input) {
  const requestId = String(input?.requestId || '');
  const expectedContent = String(input?.expectedContent || '');
  const display = input?.display || {};
  const displayState = input?.displayState || {};
  const taskId = String(displayState?.task?.taskId || '');
  const assistants = (Array.isArray(displayState?.transcript) ? displayState.transcript : [])
    .filter(item => item?.role === 'assistant' && item?.requestId === requestId);
  const displayedAssistant = assistants.length === 1 ? assistants[0] : null;
  const readReceipts = (Array.isArray(displayState?.task?.receipts)
    ? displayState.task.receipts
    : []).filter(receipt => receipt?.toolName === 'read_file');
  const readToolRecords = (Array.isArray(displayState?.transcript)
    ? displayState.transcript
    : []).flatMap(item => Array.isArray(item?.toolCalls) ? item.toolCalls : [])
    .filter(call => call?.name === 'read_file');
  const receipt = readReceipts.length === 1 ? readReceipts[0] : null;
  const toolRecord = readToolRecords.length === 1 ? readToolRecords[0] : null;
  const visibleText = String(display?.terminal?.text || '');
  const expectedContentSha256 = sha256(expectedContent);
  const exactContentVisible = Boolean(expectedContent && visibleText.includes(expectedContent));
  const terminalMatchesPersistedAssistant = Boolean(
    displayedAssistant
    && display?.terminal?.finalized === true
    && display?.terminal?.timedOut !== true
    && display?.terminal?.blocked !== true
    && display.terminal.textSha256 === displayedAssistant.textSha256
    && display.terminal.textCharCount === displayedAssistant.textCharCount
    && display.terminal.textSha256 === sha256(visibleText)
    && display.terminal.textCharCount === visibleText.length,
  );
  const uniquelyVerifiedReceipt = Boolean(
    receipt
    && receipt.requestId === requestId
    && receipt.verification === 'verified'
    && receipt.outcome === 'verified_success'
    && String(receipt.receiptId || '')
    && String(receipt.targetSha256 || ''),
  );
  const uniquelyBoundToolRecord = Boolean(
    toolRecord
    && toolRecord.requestId === requestId
    && toolRecord.taskId === taskId
    && toolRecord.terminalVerificationStatus === 'verified'
    && String(toolRecord.targetSha256 || '') === String(receipt?.targetSha256 || ''),
  );
  return {
    observed: Boolean(
      exactContentVisible
      && terminalMatchesPersistedAssistant
      && uniquelyVerifiedReceipt
      && uniquelyBoundToolRecord,
    ),
    expectedContentSha256,
    receiptIds: uniquelyVerifiedReceipt ? [String(receipt.receiptId)] : [],
  };
}

async function runDisplayedStaleReceiptScenario(context) {
  const scenarioId = 'displayed_result_stale_receipt';
  const marker = '[LUMI_REGRESSION:S4]';
  const liveMarker = '[LUMI_REGRESSION:S4:LIVE]';
  const conversationId = await createConversation(context.baseUrl, context.token);
  const displayId = requestId(context.runId, scenarioId, 'display');
  const continueId = requestId(context.runId, scenarioId, 'continue');
  const display = await runTurn(context.socket, {
    requestId: displayId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: `${marker} 读取隔离文件 ${context.staleFixture} 并把真实结果显示给我。必须调用 read_file。`,
  });
  const displayState = await observeScenarioState(context, {
    marker, conversationId, requestIds: [displayId],
  });
  const truth = await attemptTruthSnapshot(context, {
    scenarioId, conversationId, requestId: displayId, taskId: displayState.task?.taskId,
  });
  const continuation = await runTurn(context.socket, {
    requestId: continueId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: `${liveMarker} Use desktop_write_text_file exactly once to write the exact text `
      + `"stale receipt live-owner sentinel" to ${context.stalePendingFixture}.`,
  });
  const liveStateBefore = await observeScenarioState(context, {
    marker: liveMarker, conversationId, requestIds: [displayId, continueId],
  });
  const staleEvidence = await attemptStaleReceiptReclassification(context, {
    conversationId,
    displayRequestId: displayId,
    continueRequestId: continueId,
  });
  const liveStateAfter = await observeScenarioState(context, {
    marker: liveMarker, conversationId, requestIds: [displayId, continueId],
  });
  const readReceipts = (displayState.task?.receipts || [])
    .filter(receipt => receipt.toolName === 'read_file');
  const displayedResultEvidence = evaluateDisplayedResultEvidence({
    requestId: displayId,
    expectedContent: context.staleFixtureContent,
    display,
    displayState,
  });
  const staleReceiptArchived = staleEvidence.ok === true
    && staleEvidence.evidence?.archive?.taskId === displayState.task?.taskId
    && staleEvidence.evidence?.sourceReceipt?.recordId === readReceipts[0]?.receiptId;
  const staleDidNotBlockCleanup = staleEvidence.ok === true
    && continuation.ack.ok
    && continuation.terminal.finalized
    && !continuation.terminal.timedOut
    && continuation.terminal.reason === 'waiting_confirmation'
    && liveStateBefore.task?.taskId === staleEvidence.evidence?.liveOwnerBefore?.taskId
    && liveStateAfter.task?.taskId === staleEvidence.evidence?.liveOwnerAfter?.taskId
    && liveStateAfter.livePointer.taskId === liveStateBefore.livePointer.taskId
    && liveStateAfter.livePointer.status === liveStateBefore.livePointer.status;
  const behaviorChecks = [
    check(
      'displayed_result_receipt_bound',
      displayedResultEvidence.observed,
      [
        ...displayedResultEvidence.receiptIds,
        displayedResultEvidence.expectedContentSha256,
      ],
    ),
    check(
      'stale_receipt_archived',
      staleReceiptArchived,
      staleEvidence.ok
        ? [
          staleEvidence.evidence.archive.recordId,
          staleEvidence.evidence.staleReclassification.classifierInputSha256,
        ]
        : [staleEvidence.code, staleEvidence.serverCode].filter(Boolean),
    ),
    check(
      'stale_receipt_did_not_block_cleanup',
      staleDidNotBlockCleanup,
      staleEvidence.ok
        ? [
          continueId,
          staleEvidence.evidence.liveOwnerBefore.taskSha256,
          staleEvidence.evidence.liveOwnerAfter.taskSha256,
        ]
        : [continueId],
    ),
  ];
  return {
    scenarioId,
    executionStatus: staleEvidence.ok ? 'observed' : 'observed_but_stale_evidence_rejected',
    turns: [display, continuation],
    stateTimeline: { afterDisplay: displayState, beforeStale: liveStateBefore, afterStale: liveStateAfter },
    state: liveStateAfter,
    staleReceiptEvidence: staleEvidence,
    staleReclassification: staleEvidence.ok
      ? staleEvidence.evidence.staleReclassification
      : null,
    behaviorChecks,
    truthSnapshot: truth,
    matrixEligible: truth.ok
      && staleEvidence.ok
      && behaviorChecks.every(item => item.observed === true),
  };
}

async function runControlScenario(context) {
  const scenarioId = 'control_stop_status_repeat';
  const marker = '[LUMI_REGRESSION:S5:LONG]';
  const conversationId = await createConversation(context.baseUrl, context.token);
  const longId = requestId(context.runId, scenarioId, 'long');
  const statusId = requestId(context.runId, scenarioId, 'status');
  const stopId = requestId(context.runId, scenarioId, 'stop');
  const repeatId = requestId(context.runId, scenarioId, 'repeat');
  const providerRequestBaseline = Array.isArray(context.modelStub?.requests)
    ? context.modelStub.requests.length
    : 0;
  const long = startTurn(context.socket, {
    requestId: longId, conversationId, timeoutMs: Math.max(context.turnTimeoutMs, 25_000),
    text: `${marker} 这是可取消的隔离长任务。等待后给出一句结果，不调用任何工具。`,
  });
  const longAck = await long.ackPromise;
  if (!longAck.ok) fail('regression_control_precursor_not_accepted');
  const providerDeadline = Date.now() + Math.min(context.turnTimeoutMs, 10_000);
  while (
    Date.now() < providerDeadline
    && !(context.modelStub?.requests || []).some(capture => capture?.scenarioId === scenarioId)
  ) await new Promise(resolve => setTimeout(resolve, 10));
  if (!(context.modelStub?.requests || []).some(capture => capture?.scenarioId === scenarioId)) {
    fail('regression_control_provider_precursor_not_observed');
  }
  const stop = await runTurn(context.socket, {
    requestId: stopId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: '停止',
  });
  const longTerminal = await long.done();
  const status = await runTurn(context.socket, {
    requestId: statusId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: '你在干嘛',
  });
  const repeat = await runTurn(context.socket, {
    requestId: repeatId, conversationId, timeoutMs: context.turnTimeoutMs,
    text: '怎么说',
  });
  const state = await observeScenarioState(context, {
    marker, conversationId, requestIds: [longId, statusId, stopId, repeatId],
  });
  const repeatPrior = status.terminal.text;
  const normalizedRepeat = repeat.terminal.text.replace(/\s+/gu, ' ').trim();
  const normalizedPrior = repeatPrior.replace(/\s+/gu, ' ').trim();
  const taskCancelled = state.task?.status === 'cancelled' || /停止|取消/u.test(stop.terminal.text);
  const truth = await attemptTruthSnapshot(context, {
    scenarioId, conversationId, requestId: longId, taskId: state.task?.taskId,
  });
  const scenarioCompletedAt = new Date().toISOString();
  const providerCaptures = Array.isArray(context.modelStub?.requests)
    ? context.modelStub.requests
    : [];
  const providerWitness = evaluateControlProviderWitness({
    providerCaptures,
    providerRequestBaseline,
    scenarioCompletedAt,
  });
  return {
    scenarioId,
    executionStatus: 'observed',
    turns: [longTerminal, stop, status, repeat],
    state,
    behaviorChecks: [
      check('cancel_bypassed_busy_gate', stop.ack.ok && stop.terminal.finalized && taskCancelled, [stopId]),
      check('status_reflected_target_task_terminal', status.ack.ok
        && status.terminal.finalized
        && status.terminal.reason === 'target_execution_status'
        && status.terminal.controlIntent === 'status'
        && status.terminal.targetRequestId === longId
        && status.terminal.textCharCount > 0, [statusId, longId]),
      check('repeat_used_last_assistant_answer', Boolean(
        repeatPrior
        && repeat.terminal.text === repeatPrior
        && normalizedRepeat === normalizedPrior,
      ), [repeatId]),
    ],
    providerWitness,
    truthSnapshot: truth,
    matrixEligible: truth.ok && providerWitness.bounded,
  };
}

export function evaluateControlProviderWitness(input = {}) {
  const scenarioId = 'control_stop_status_repeat';
  const providerCaptures = Array.isArray(input.providerCaptures)
    ? input.providerCaptures
    : [];
  const providerRequestBaseline = Number(input.providerRequestBaseline);
  const baselineValid = Number.isSafeInteger(providerRequestBaseline)
    && providerRequestBaseline >= 0
    && providerRequestBaseline <= providerCaptures.length;
  const scenarioCaptures = baselineValid
    ? providerCaptures.slice(providerRequestBaseline)
    : [];
  const matchingScenarioCaptureIndexes = scenarioCaptures
    .map((capture, index) => capture?.scenarioId === scenarioId ? index : -1)
    .filter(index => index >= 0);
  const scenarioCaptureIndex = matchingScenarioCaptureIndexes.length === 1
    ? matchingScenarioCaptureIndexes[0]
    : -1;
  const providerCaptureIndex = scenarioCaptureIndex >= 0
    ? providerRequestBaseline + scenarioCaptureIndex
    : -1;
  const providerCapture = providerCaptureIndex >= 0
    ? providerCaptures[providerCaptureIndex]
    : null;
  const scenarioCompletedAt = String(input.scenarioCompletedAt || '');
  const providerCaptureToCompletionMs = providerCapture
    ? Date.parse(scenarioCompletedAt) - Date.parse(String(providerCapture.receivedAt || ''))
    : -1;
  return {
    captureIndex: providerCaptureIndex,
    expectedCaptureIndex: baselineValid ? providerRequestBaseline : -1,
    scenarioCaptureIndex,
    expectedScenarioCaptureIndex: 0,
    providerRequestBaseline: baselineValid ? providerRequestBaseline : -1,
    providerRequestCount: providerCaptures.length,
    scenarioProviderRequestCount: scenarioCaptures.length,
    receivedAt: String(providerCapture?.receivedAt || ''),
    scheduledDelayMs: Number(providerCapture?.scheduledDelayMs || 0),
    abortedAt: String(providerCapture?.abortedAt || ''),
    deliveredAt: String(providerCapture?.deliveredAt || ''),
    scenarioCompletedAt,
    providerCaptureToCompletionMs,
    maximumProviderCaptureToCompletionMs: 5_000,
    bounded: baselineValid
      && scenarioCaptureIndex === 0
      && scenarioCaptures.length === 1
      && providerCapture?.scheduledDelayMs === 15_000
      && Boolean(providerCapture?.abortedAt)
      && !providerCapture?.deliveredAt
      && Number.isFinite(providerCaptureToCompletionMs)
      && providerCaptureToCompletionMs >= 0
      && providerCaptureToCompletionMs <= 5_000,
  };
}

async function runVoiceToTextContinuationScenario(context) {
  const scenarioId = 'voice_to_text_continuation';
  const marker = '[LUMI_REGRESSION:S6]';
  const continueId = requestId(context.runId, scenarioId, 'text_continue');
  const captureSessionId = `capture_${sha256(`${context.runId}:s6`).slice(0, 32)}`;
  const enrolled = await fetchJson(context.baseUrl, '/auth/biometric/voiceprint/enroll', {
    token: context.token,
    method: 'PUT',
    body: {
      label: 'S6 isolated owner',
      mfccFeatures: Array.from({ length: 4 }, (_, frameIndex) => (
        Array.from({ length: 13 }, (_, coefficientIndex) => (
          (frameIndex + 1) * (coefficientIndex + 1) / 100
        ))
      )),
      sampleCount: 4,
      replaceExisting: true,
    },
  });
  const enrollmentId = String(enrolled?.voiceprint?.id || '');

  const voice = await runAcceptedVoiceTurn(context.socket, {
    captureSessionId,
    timeoutMs: context.turnTimeoutMs,
  });
  if (!voice.requestId || !voice.conversationId) {
    fail('regression_voice_turn_identity_missing', { terminalEvent: voice.terminal.event });
  }
  const voiceState = await waitForScenarioState(context, {
    marker,
    conversationId: voice.conversationId,
    requestIds: [voice.requestId],
  }, state => Boolean(
    state?.task?.taskId
    && state.task.status === 'blocked'
    && state.task.activeRequest === false
    && state.livePointer?.taskId === state.task.taskId
    && state.livePointer?.status === 'blocked'
    && state.livePointer?.requestId === '',
  ));
  const taskId = String(voiceState?.task?.taskId || '');
  if (!taskId) fail('regression_voice_task_missing');

  const chat = await runTurn(context.socket, {
    requestId: continueId,
    conversationId: voice.conversationId,
    timeoutMs: context.turnTimeoutMs,
    text: `纠正一下：不是 ${context.s6MissingPath}，而是 ${context.s6CorrectPath}。请继续刚才的同一个任务。[LUMI_REGRESSION:S6:TEXT]`,
  });
  const finalState = await waitForScenarioState(context, {
    marker,
    conversationId: voice.conversationId,
    requestIds: [voice.requestId, continueId],
    taskId,
  }, state => Boolean(
    state?.task?.taskId === taskId
    && state.task.status === 'completed'
    && state.task.activeRequest === false
    && state.livePointer?.state === 'cleared',
  ));
  const truth = await attemptTruthSnapshot(context, {
    scenarioId,
    conversationId: voice.conversationId,
    requestId: continueId,
    taskId,
    voiceRequestId: voice.requestId,
    previousTarget: context.s6MissingPath,
    replacementTarget: context.s6CorrectPath,
  });

  const voiceUser = voiceState.transcript.find(message => (
    message.role === 'user' && message.requestId === voice.requestId
  ));
  const voiceAssistant = voiceState.transcript.find(message => (
    message.role === 'assistant' && message.requestId === voice.requestId
  ));
  const chatUser = finalState.transcript.find(message => (
    message.role === 'user' && message.requestId === continueId
  ));
  const chatAssistant = finalState.transcript.find(message => (
    message.role === 'assistant' && message.requestId === continueId
  ));
  const voiceReadEvents = voice.toolEvents.filter(event => event.name === 'read_file');
  const chatReadEvents = chat.toolEvents.filter(event => event.name === 'read_file');
  const voiceReadReceipts = (finalState.task?.receipts || []).filter(receipt => (
    receipt.requestId === voice.requestId && receipt.toolName === 'read_file'
  ));
  const chatReadReceipts = (finalState.task?.receipts || []).filter(receipt => (
    receipt.requestId === continueId && receipt.toolName === 'read_file'
  ));
  const providerCaptures = (context.modelStub.requests || []).filter(capture => (
    capture.scenarioId === scenarioId
  ));
  const providerDecisions = (context.modelStub.decisions || []).filter(decision => (
    decision.scenarioId === scenarioId
  ));
  const sttCaptures = Array.isArray(context.modelStub.sttCaptures)
    ? context.modelStub.sttCaptures
    : [];
  const finalProviderSawBothTargets = providerCaptures.some(capture => (
    capture.containsVoiceMissingTarget === true
    && capture.containsCorrectTarget === true
    && capture.containsCorrectFixtureContent === true
  ));
  const voiceTerminalBound = Boolean(
    voice.terminal.finalized
    && !voice.terminal.timedOut
    && voice.terminal.textSha256 === voiceAssistant?.textSha256
    && voice.terminal.textCharCount === voiceAssistant?.textCharCount
    && !/No successful current-turn|persistence_unknown/iu.test(voice.terminal.text),
  );
  const chatTerminalBound = Boolean(
    chat.ack.ok
    && chat.terminal.finalized
    && !chat.terminal.timedOut
    && chat.terminal.textSha256 === chatAssistant?.textSha256
    && chat.terminal.textCharCount === chatAssistant?.textCharCount
    && chat.terminal.text.includes(context.s6CorrectContent)
    && !/No successful current-turn|persistence_unknown/iu.test(chat.terminal.text),
  );
  const behaviorChecks = [
    check('voice_turn_bound_to_task', Boolean(
      enrollmentId
      && voice.requestId.startsWith('voice_')
      && voiceUser?.source === 'voice'
      && voiceUser?.channel === 'voice'
      && voiceUser?.mode === 'voice'
      && voiceAssistant?.source === 'voice'
      && voiceAssistant?.channel === 'voice'
      && voiceState.task?.status === 'blocked'
      && voiceState.livePointer?.taskId === taskId
      && voiceReadEvents.some(event => event.phase === 'error')
      && voiceReadReceipts.some(receipt => receipt.outcome !== 'verified_success')
      && voiceTerminalBound
      && voice.harnessAdmission.confirmationCount === 1
      && voice.harnessAdmission.captureMode === 'synthetic_accepted_transcript'
      && voice.harnessAdmission.confirmedTranscriptSha256 === voiceUser?.textSha256
      && voice.harnessAdmission.confirmedTranscriptCharCount === voiceUser?.textCharCount
      && sttCaptures.length === 1
      && sttCaptures[0].authorizedWithIsolatedCredential === true
      && sttCaptures[0].handshakeReceived === true
      && sttCaptures[0].audioFrameCount >= 1
      && sttCaptures[0].finalDeliveredAt
    ), [voice.requestId, taskId, sha256(enrollmentId), sttCaptures[0]?.finalTranscriptSha256].filter(Boolean)),
    check('text_turn_continued_same_task', Boolean(
      chatTerminalBound
      && finalState.task?.taskId === taskId
      && finalState.task?.status === 'completed'
      && finalState.task?.activeRequest === false
      && finalState.livePointer?.state === 'cleared'
      && chat.taskRelationEvents.some(event => event.taskId === taskId)
      && chatReadEvents.some(event => event.phase === 'result')
      && chatReadReceipts.length === 1
      && chatReadReceipts[0].outcome === 'verified_success'
      && truth.ok
      && truth.snapshot?.task?.taskId === taskId
      && truth.snapshot?.request?.requestId === continueId
      && truth.snapshot?.receipt?.requestId === continueId
      && truth.snapshot?.receipt?.taskId === taskId
      && truth.snapshot?.receipt?.toolName === 'read_file'
      && truth.snapshot?.pointers?.live?.state === 'cleared'
      && truth.snapshot?.pointers?.pending?.state === 'cleared'
      && truth.voiceTextContinuation?.task?.taskId === taskId
      && truth.voiceTextContinuation?.voiceStart?.request?.requestId === voice.requestId
      && truth.voiceTextContinuation?.textContinue?.request?.requestId === continueId
    ), [continueId, taskId, chatReadReceipts[0]?.receiptId, truth.snapshot?.snapshotId].filter(Boolean)),
    check('context_continuity_preserved', Boolean(
      chatUser
      && chatAssistant
      && chatUser.source === 'task-regression-black-box'
      && chatUser.channel === 'chat'
      && chat.taskRelationEvents.some(event => (
        event.taskId === taskId
        && event.taskRelation === 'correct'
        && event.operation === 'replan'
      ))
      && providerDecisions.some(decision => (
        decision.logicalTool === 'read_file'
        && decision.targetSha256 === sha256(context.s6CorrectPath)
      ))
      && finalProviderSawBothTargets
      && truth.ok
      && truth.snapshot?.modelActualInput?.modelInvoked === true
      && truth.snapshot?.modelActualInput?.requestId === continueId
      && truth.snapshot?.modelActualInput?.taskId === taskId
      && truth.snapshot?.modelActualInput?.messageCount >= 2
      && truth.voiceTextContinuation?.channelHandoff?.sourceRequestId === voice.requestId
      && truth.voiceTextContinuation?.channelHandoff?.targetRequestId === continueId
      && truth.voiceTextContinuation?.targetCorrection?.sourceRequestId === voice.requestId
      && truth.voiceTextContinuation?.targetCorrection?.targetRequestId === continueId
    ), [
      voice.requestId,
      continueId,
      truth.snapshot?.modelActualInput?.recordId,
      truth.voiceTextContinuation?.evidenceDigestSha256,
    ].filter(Boolean)),
  ];

  let voiceStopped = false;
  const idle = new Promise(resolve => {
    const timer = setTimeout(() => {
      context.socket.off('audio:status', onIdle);
      resolve(false);
    }, 3_000);
    const onIdle = payload => {
      if (payload?.status !== 'idle') return;
      clearTimeout(timer);
      context.socket.off('audio:status', onIdle);
      resolve(true);
    };
    context.socket.on('audio:status', onIdle);
  });
  context.socket.emit('audio:stop');
  voiceStopped = await idle;

  return {
    scenarioId,
    executionStatus: 'observed',
    conversationId: voice.conversationId,
    taskId,
    requestIds: [voice.requestId, continueId],
    turns: [voice, chat],
    stateTimeline: { afterVoice: voiceState, afterText: finalState },
    state: finalState,
    voiceBoundary: {
      enrollmentIdSha256: sha256(enrollmentId),
      captureSessionIdSha256: sha256(captureSessionId),
      voiceStopped,
      sttCaptures,
    },
    providerActualInput: {
      captureCount: providerCaptures.length,
      captures: providerCaptures,
      decisions: providerDecisions,
      finalCaptureContainedVoiceAndTextTargets: finalProviderSawBothTargets,
    },
    truthSnapshot: truth,
    behaviorChecks,
    matrixEligible: truth.ok
      && voiceStopped
      && behaviorChecks.every(item => item.observed === true),
  };
}

async function runMidTaskRestartRecoveryScenario(context) {
  const scenarioId = 'mid_task_restart_recovery';
  const marker = '[LUMI_REGRESSION:S7]';
  const conversationId = await createConversation(context.baseUrl, context.token);
  const prepareId = requestId(context.runId, scenarioId, 'prepare');
  const continueId = requestId(context.runId, scenarioId, 'continue');

  const prepare = await runTurn(context.socket, {
    requestId: prepareId,
    conversationId,
    timeoutMs: context.turnTimeoutMs,
    text: `${marker} 建立后端重启恢复测试。必须调用 desktop_write_text_file，将固定内容写入 `
      + `${context.restartArtifact}，并严格停在一次性确认边界。`,
  });
  const artifactBeforeRestart = fs.existsSync(context.restartArtifact);
  const beforeRestart = await observeScenarioState(context, {
    marker,
    conversationId,
    requestIds: [prepareId],
  });
  const taskId = String(beforeRestart.task?.taskId || '');
  if (!taskId) fail('regression_restart_prepare_task_missing');
  const prepareTruthBeforeRestart = await attemptTruthSnapshot(context, {
    scenarioId,
    conversationId,
    requestId: prepareId,
    taskId,
  });

  const restarted = await context.restartBackend();
  const afterRestart = await observeScenarioState(context, {
    marker,
    conversationId,
    requestIds: [prepareId],
  });
  const prepareTruthAfterRestart = await attemptTruthSnapshot(context, {
    scenarioId,
    conversationId,
    requestId: prepareId,
    taskId,
  });

  const continuation = await runTurn(context.socket, {
    requestId: continueId,
    conversationId,
    timeoutMs: context.turnTimeoutMs,
    text: '确认',
  });
  const artifactAfterContinue = fs.existsSync(context.restartArtifact);
  const artifactBytes = artifactAfterContinue
    ? fs.readFileSync(context.restartArtifact)
    : Buffer.alloc(0);
  const finalState = await observeScenarioState(context, {
    marker,
    conversationId,
    requestIds: [prepareId, continueId],
  });
  const continueTruth = await attemptTruthSnapshot(context, {
    scenarioId,
    conversationId,
    requestId: continueId,
    taskId,
  });

  const successfulWriteReceipts = (finalState.task?.receipts || []).filter(receipt => (
    receipt.toolName === 'desktop_write_text_file'
    && receipt.requestId === continueId
    && receipt.outcome !== 'waiting_confirmation'
  ));
  const writeCorrelations = [...new Set(continuation.toolEvents
    .filter(event => event.name === 'desktop_write_text_file')
    .map(event => event.correlationId)
    .filter(Boolean))];
  const providerCaptures = (context.modelStub?.requests || [])
    .filter(capture => capture?.scenarioId === scenarioId);
  const toolPlanningProviderCaptures = providerCaptures.filter(capture => (
    Array.isArray(capture?.declaredTools)
    && capture.declaredTools.includes('desktop_write_text_file')
  ));
  const prepareSnapshot = prepareTruthBeforeRestart.ok
    ? prepareTruthBeforeRestart.snapshot
    : null;
  const recoveredPrepareSnapshot = prepareTruthAfterRestart.ok
    ? prepareTruthAfterRestart.snapshot
    : null;
  const continueSnapshot = continueTruth.ok ? continueTruth.snapshot : null;

  const behaviorChecks = [
    check('restart_recovered_same_task', Boolean(
      prepare.ack.ok
      && prepare.terminal.finalized
      && prepare.terminal.reason === 'waiting_confirmation'
      && !artifactBeforeRestart
      && beforeRestart.task?.taskId === taskId
      && afterRestart.task?.taskId === taskId
      && finalState.task?.taskId === taskId
      && prepareSnapshot?.task?.taskId === taskId
      && recoveredPrepareSnapshot?.task?.taskId === taskId
      && continueSnapshot?.task?.taskId === taskId
    ), [prepareId, continueId, taskId]),
    check('lease_released_or_recovered', Boolean(
      restarted.transition?.oldProcessExit?.observed
      && restarted.transition?.oldProcessExit?.pidNoLongerAlive
      && restarted.transition?.lease?.oldGenerationReleasedOrReclaimed
      && restarted.transition?.oldProcess?.pid !== restarted.transition?.newProcess?.pid
      && restarted.transition?.oldProcess?.startedAt !== restarted.transition?.newProcess?.startedAt
      && beforeRestart.livePointer.requestId === ''
      && afterRestart.livePointer.requestId === ''
      && beforeRestart.task?.activeRequest === false
      && afterRestart.task?.activeRequest === false
      && finalState.task?.activeRequest === false
    ), [
      restarted.transition?.oldProcess?.identitySha256,
      restarted.transition?.newProcess?.identitySha256,
      restarted.transition?.lease?.before?.ownerTokenSha256,
      restarted.transition?.lease?.afterRestart?.ownerTokenSha256,
    ].filter(Boolean)),
    check('live_pointer_rebound', Boolean(
      beforeRestart.livePointer.state === 'set'
      && beforeRestart.livePointer.taskId === taskId
      && beforeRestart.livePointer.status === 'waiting_confirmation'
      && afterRestart.livePointer.state === 'set'
      && afterRestart.livePointer.taskId === taskId
      && afterRestart.livePointer.requestId === ''
      && afterRestart.livePointer.status === 'waiting_confirmation'
      && recoveredPrepareSnapshot?.pointers?.pending?.state === 'set'
      && recoveredPrepareSnapshot?.pointers?.pending?.taskId === taskId
      && recoveredPrepareSnapshot?.pointers?.pending?.requestId === prepareId
      && recoveredPrepareSnapshot?.pointers?.live?.state === 'set'
      && recoveredPrepareSnapshot?.pointers?.live?.taskId === taskId
      && recoveredPrepareSnapshot?.pointers?.live?.requestId === null
      && finalState.livePointer.state === 'cleared'
      && continueSnapshot?.pointers?.pending?.state === 'cleared'
      && continueSnapshot?.pointers?.live?.state === 'cleared'
    ), [taskId, prepareId]),
    check('confirmation_consumed_exactly_once', Boolean(
      continuation.ack.ok
      && continuation.terminal.finalized
      && !continuation.terminal.timedOut
      && artifactAfterContinue
      && artifactBytes.toString('utf8') === context.restartArtifactContent
      && successfulWriteReceipts.length === 1
      && writeCorrelations.length === 1
    ), [
      ...successfulWriteReceipts.map(receipt => receipt.receiptId),
      ...writeCorrelations,
      sha256(artifactBytes),
    ]),
    check('restart_feedback_and_model_input_bound', Boolean(
      prepareSnapshot?.modelActualInput?.modelInvoked === true
      && prepareSnapshot?.modelActualInput?.requestId === prepareId
      && prepareSnapshot?.modelActualInput?.taskId === taskId
      && recoveredPrepareSnapshot?.modelActualInput?.payloadSha256
        === prepareSnapshot?.modelActualInput?.payloadSha256
      && continueSnapshot?.modelActualInput?.modelInvoked === false
      && continueSnapshot?.modelActualInput?.executionOrigin === 'confirmed_action_resume'
      && continueSnapshot?.modelActualInput?.requestId === continueId
      && continueSnapshot?.receipt?.requestId === continueId
      && continueSnapshot?.receipt?.taskId === taskId
      && continueSnapshot?.receipt?.toolName === 'desktop_write_text_file'
      && sha256(String(continueSnapshot?.userVisibleReply?.text || ''))
        === continuation.terminal.textSha256
      && toolPlanningProviderCaptures.length === 1
    ), [
      prepareSnapshot?.modelActualInput?.recordId,
      continueSnapshot?.modelActualInput?.recordId,
      continueSnapshot?.receipt?.receiptId,
    ].filter(Boolean)),
  ];

  return {
    scenarioId,
    executionStatus: 'observed',
    turns: [prepare, continuation],
    processTransition: restarted.transition,
    stateTimeline: {
      beforeRestart,
      afterRestart,
      afterContinue: finalState,
    },
    state: finalState,
    artifact: {
      existedBeforeRestart: artifactBeforeRestart,
      existedAfterContinue: artifactAfterContinue,
      contentSha256: sha256(artifactBytes),
      expectedContentSha256: sha256(context.restartArtifactContent),
      byteLength: artifactBytes.length,
    },
    providerWitness: {
      captureCount: providerCaptures.length,
      toolPlanningCaptureCount: toolPlanningProviderCaptures.length,
      captures: providerCaptures.map(capture => ({
        receivedAt: String(capture.receivedAt || ''),
        payloadSha256: String(capture.payloadSha256 || ''),
        messagesSha256: String(capture.messagesSha256 || ''),
        messageCount: Number(capture.messageCount || 0),
        declaredTools: Array.isArray(capture.declaredTools) ? capture.declaredTools : [],
      })),
    },
    truthSnapshots: {
      prepareBeforeRestart: prepareTruthBeforeRestart,
      prepareAfterRestart: prepareTruthAfterRestart,
      continueAfterRestart: continueTruth,
    },
    behaviorChecks,
    matrixEligible: prepareTruthBeforeRestart.ok
      && prepareTruthAfterRestart.ok
      && continueTruth.ok
      && behaviorChecks.every(item => item.observed === true),
  };
}

async function runPrimaryModelFailoverLmStudioScenario(context) {
  const scenarioId = 'primary_model_failover_lmstudio';
  const marker = '[LUMI_REGRESSION:S8]';
  const conversationId = await createConversation(context.baseUrl, context.token);
  const failoverId = requestId(context.runId, scenarioId, 'failover');
  const primaryPreference = {
    provider: 'deepseek',
    model: context.s8PrimaryModel,
    models: {
      deepseek: context.s8PrimaryModel,
      lmstudio: context.s8FallbackModel,
    },
    selectionMode: 'ordered_fallback',
    fallbackCandidates: [{ provider: 'lmstudio', model: context.s8FallbackModel }],
    allowCloudFallback: true,
  };
  const defaultPreference = {
    provider: 'openai',
    model: 'lumi-regression-stub-v1',
    models: { openai: 'lumi-regression-stub-v1' },
    selectionMode: 'pinned',
    fallbackCandidates: [],
    allowCloudFallback: false,
  };
  const beforeConnectionRefusal = await verifyLoopbackConnectionRefused(
    context.s8PrimaryFailurePort,
  );
  let preferenceRestored = false;
  let result;
  try {
    await setRegressionModelPreference(context.baseUrl, context.token, primaryPreference);
    const turn = await runTurn(context.socket, {
      requestId: failoverId,
      conversationId,
      timeoutMs: context.turnTimeoutMs,
      text: `${marker} What exact marker is inside ${context.s8FixturePath}? `
        + 'Inspect the actual file with read_file before answering. Keep one durable task and '
        + 'continue that same task when the primary model is unreachable.',
    });
    const eventTaskId = String(
      turn.terminal.taskId
      || turn.taskRelationEvents.find(event => String(event?.taskId || '').trim())?.taskId
      || '',
    );
    const finalState = await waitForScenarioState(context, {
      marker,
      conversationId,
      requestIds: [failoverId],
      ...(eventTaskId ? { taskId: eventTaskId } : {}),
    }, state => Boolean(
      state.task?.taskId
      && state.task.status === 'completed'
      && state.task.activeRequest === false
      && state.livePointer?.state === 'cleared'
      && state.routing.length >= 2
    ), 10_000);
    const taskId = String(finalState.task?.taskId || eventTaskId || '');
    const truth = await attemptTruthSnapshot(context, {
      scenarioId,
      conversationId,
      requestId: failoverId,
      taskId,
    });
    const afterConnectionRefusal = await verifyLoopbackConnectionRefused(
      context.s8PrimaryFailurePort,
    );
    const rawRoutingReceipts = await routingReceipts(
      context.baseUrl,
      context.token,
      failoverId,
    );
    const routingWitness = rawRoutingReceipts.map(routingReceiptEvidenceProjection);
    const providerCaptures = (context.modelStub.requests || []).filter(capture => (
      capture.scenarioId === scenarioId
    ));
    const providerDecisions = (context.modelStub.decisions || []).filter(decision => (
      decision.scenarioId === scenarioId
    ));
    const readEvents = turn.toolEvents.filter(event => event.name === 'read_file');
    const readResultEvents = readEvents.filter(event => event.phase === 'result');
    const uniqueReadResultEvents = [];
    const seenReadResultKeys = new Set();
    for (const [index, event] of readResultEvents.entries()) {
      const identityComplete = Boolean(
        event.correlationId
        && event.requestId
        && event.taskId
        && event.name
        && event.targetSha256,
      );
      const key = identityComplete
        ? stableTaskRegressionProbeJson([
            event.correlationId,
            event.requestId,
            event.taskId,
            event.name,
            event.targetSha256,
          ])
        : `incomplete:${index}`;
      if (seenReadResultKeys.has(key)) continue;
      seenReadResultKeys.add(key);
      uniqueReadResultEvents.push(event);
    }
    const verifiedReadReceipts = (finalState.task?.receipts || []).filter(receipt => (
      receipt.requestId === failoverId
      && receipt.toolName === 'read_file'
      && receipt.outcome === 'verified_success'
      && receipt.verification === 'verified'
    ));
    const persistedAssistant = finalState.transcript.find(message => (
      message.role === 'assistant' && message.requestId === failoverId
    ));
    const persistedReadCalls = (persistedAssistant?.toolCalls || []).filter(call => (
      call.name === 'read_file'
    ));
    const everyRouteHasRealPrimaryFailure = routingWitness.length === 2
      && routingWitness.every(receipt => {
        const [primary, fallback] = receipt.attempts;
        return receipt.requestId === failoverId
          && receipt.source === 'chat'
          && receipt.status === 'succeeded'
          && receipt.requestedProvider === 'deepseek'
          && receipt.requestedModel === context.s8PrimaryModel
          && receipt.selectionMode === 'ordered_fallback'
          && receipt.selectedProvider === 'lmstudio'
          && receipt.selectedModel === context.s8FallbackModel
          && receipt.fallbackReason === 'provider_unreachable'
          && receipt.attempts.length === 2
          && primary?.provider === 'deepseek'
          && primary?.model === context.s8PrimaryModel
          && primary?.status === 'failed'
          && primary?.reason === 'provider_unreachable'
          && primary?.visibleOutputCommitted === false
          && /^[a-f0-9]{64}$/u.test(primary?.errorDigest || '')
          && Boolean(primary?.startedAt && primary?.completedAt)
          && primary?.outboundActualInput?.provider === 'deepseek'
          && primary?.outboundActualInput?.model === context.s8PrimaryModel
          && /^[a-f0-9]{64}$/u.test(primary?.outboundActualInput?.messagesSha256 || '')
          && fallback?.provider === 'lmstudio'
          && fallback?.model === context.s8FallbackModel
          && fallback?.status === 'succeeded'
          && fallback?.outboundActualInput?.provider === 'lmstudio'
          && fallback?.outboundActualInput?.model === context.s8FallbackModel
          && /^[a-f0-9]{64}$/u.test(fallback?.outboundActualInput?.messagesSha256 || '');
      });
    const exactLmStudioTwoRoundContinuation = providerCaptures.length === 2
      && providerDecisions.length === 2
      && providerCaptures.every(capture => (
        capture.providerBoundary === 'lmstudio'
        && capture.model === context.s8FallbackModel
      ))
      && providerDecisions[0]?.type === 'tool'
      && providerDecisions[0]?.toolName === 'read_file'
      && providerDecisions[1]?.type === 'text'
      && providerDecisions[1]?.verifiedFixtureContent === true
      && providerDecisions[1]?.verifiedToolContinuation === true
      && providerCaptures[0]?.containsS8FixtureContent === false
      && providerCaptures[0]?.pairedAssistantToolCallAndReceipt === false
      && providerCaptures[1]?.containsS8FixtureContent === true
      && providerCaptures[1]?.pairedAssistantToolCallAndReceipt === true
      && providerCaptures[1]?.pairedAssistantToolCallCount === 1
      && providerCaptures[1]?.pairedToolReceiptCount === 1;
    // Public completion feedback deliberately redacts internal tool names
    // (the product security contract forbids leaking `read_file` and other
    // protocol identifiers).  The independently derived truth snapshot and
    // same-task checks below already prove that the read receipt happened; a
    // generic safe evidence line is therefore truthful even when the public
    // payload no longer contains the tool name.
    const publicFeedbackEvidence = Array.isArray(turn.terminal.completionFeedback?.evidence)
      ? turn.terminal.completionFeedback.evidence
      : [];
    const safeRedactedCompletionEvidence = publicFeedbackEvidence.some(item => (
      /^(?:The current execution result was recorded\.|已记录当前执行结果。)$/u.test(String(item || '').trim())
    ));
    const terminalFeedbackTruthful = Boolean(
      turn.ack.ok
      && turn.terminal.finalized
      && !turn.terminal.blocked
      && !turn.terminal.timedOut
      && turn.terminal.text === context.s8FinalText
      && !/No successful current-turn|这一轮没有记录到成功|model routes unavailable|processing failed/iu
        .test(turn.terminal.text)
      && turn.terminal.completionFeedback?.status === 'completed'
      && (publicFeedbackEvidence.some(item => String(item || '').includes('read_file'))
        || safeRedactedCompletionEvidence)
      && turn.terminal.completionFeedback.blockers.length === 0
      && turn.terminal.completionFeedback.incomplete.length === 0
      && persistedAssistant?.textSha256 === turn.terminal.textSha256
      && persistedAssistant?.textCharCount === turn.terminal.textCharCount
    );
    const sameTaskRequestAndTerminal = Boolean(
      taskId
      && finalState.task?.taskId === taskId
      && finalState.task.status === 'completed'
      && finalState.task.activeRequest === false
      && finalState.livePointer.state === 'cleared'
      && finalState.livePointer.taskId === ''
      && finalState.livePointer.requestId === ''
      && verifiedReadReceipts.length === 1
      && uniqueReadResultEvents.length === 1
      && uniqueReadResultEvents[0].targetSha256 === sha256(context.s8FixturePath)
      && persistedReadCalls.length === 1
      && persistedReadCalls[0].requestId === failoverId
      && persistedReadCalls[0].taskId === taskId
      && persistedReadCalls[0].targetSha256 === sha256(context.s8FixturePath)
      && persistedReadCalls[0].terminalVerificationStatus === 'verified'
      && routingWitness.every(receipt => receipt.requestId === failoverId)
      && truth.ok
      && truth.snapshot?.task?.taskId === taskId
      && truth.snapshot?.task?.status === 'completed'
      && truth.snapshot?.request?.requestId === failoverId
      && truth.snapshot?.request?.taskId === taskId
      && truth.snapshot?.request?.status === 'succeeded'
      && truth.snapshot?.receipt?.requestId === failoverId
      && truth.snapshot?.receipt?.taskId === taskId
      && truth.snapshot?.receipt?.toolName === 'read_file'
      && truth.snapshot?.receipt?.status === 'succeeded'
      && truth.snapshot?.pointers?.pending?.state === 'cleared'
      && truth.snapshot?.pointers?.live?.state === 'cleared'
      && truth.snapshot?.modelActualInput?.modelInvoked === true
      && truth.snapshot?.modelActualInput?.requestId === failoverId
      && truth.snapshot?.modelActualInput?.taskId === taskId
      && truth.snapshot?.modelActualInput?.provider === 'lmstudio'
      && truth.snapshot?.modelActualInput?.model === context.s8FallbackModel
      && truth.snapshot?.modelActualInput?.messages?.some(message => message.role === 'user')
    );
    const behaviorChecks = [
      check('primary_failure_recorded', Boolean(
        beforeConnectionRefusal.code === 'ECONNREFUSED'
        && afterConnectionRefusal.code === 'ECONNREFUSED'
        && context.s8PrimaryFailurePort !== context.modelStub.port
        && everyRouteHasRealPrimaryFailure
      ), [
        ...routingWitness.map(receipt => receipt.id),
        ...routingWitness.map(receipt => receipt.attempts[0]?.errorDigest).filter(Boolean),
      ]),
      check('lmstudio_selected', Boolean(
        everyRouteHasRealPrimaryFailure && exactLmStudioTwoRoundContinuation
      ), [
        ...routingWitness.map(receipt => receipt.id),
        ...providerCaptures.map(capture => capture.payloadSha256),
      ]),
      check('same_task_continued', sameTaskRequestAndTerminal, [
        failoverId,
        taskId,
        verifiedReadReceipts[0]?.receiptId,
        truth.snapshot?.modelActualInput?.recordId,
      ].filter(Boolean)),
      check('final_feedback_truthful', Boolean(
        terminalFeedbackTruthful
        && sameTaskRequestAndTerminal
        && exactLmStudioTwoRoundContinuation
      ), [
        turn.terminal.textSha256,
        persistedAssistant?.messageId,
        truth.snapshot?.snapshotId,
      ].filter(Boolean)),
    ];
    const criticalBoundaryProven = everyRouteHasRealPrimaryFailure
      && exactLmStudioTwoRoundContinuation;
    result = {
      scenarioId,
      executionStatus: criticalBoundaryProven ? 'observed' : 'failed_closed',
      conversationId,
      taskId,
      requestIds: [failoverId],
      turns: [turn],
      state: finalState,
      primaryFailureBoundary: {
        provider: 'deepseek',
        model: context.s8PrimaryModel,
        endpointKind: 'runner_reserved_unbound_loopback',
        endpointSha256: sha256(context.s8PrimaryFailureBaseUrl),
        before: beforeConnectionRefusal,
        after: afterConnectionRefusal,
        sameAsLmStudioStub: context.s8PrimaryFailurePort === context.modelStub.port,
      },
      lmStudioBoundary: {
        model: context.s8FallbackModel,
        exactCallCount: providerCaptures.length,
        captures: providerCaptures,
        decisions: providerDecisions,
      },
      routingWitness,
      verifiedRead: {
        fixturePathSha256: sha256(context.s8FixturePath),
        fixtureContentSha256: sha256(context.s8FixtureContent),
        receiptIds: verifiedReadReceipts.map(receipt => receipt.receiptId),
        resultEventCount: uniqueReadResultEvents.length,
        rawDuplicateResultEventCount: readResultEvents.length,
      },
      truthSnapshot: truth,
      foregroundRelease: {
        taskTerminal: finalState.task?.status === 'completed',
        activeRequestCleared: finalState.task?.activeRequest === false,
        livePointerCleared: finalState.livePointer?.state === 'cleared',
        pendingPointerCleared: truth.snapshot?.pointers?.pending?.state === 'cleared',
        requestLeaseTerminal: truth.snapshot?.request?.status === 'succeeded',
      },
      behaviorChecks,
      matrixEligible: criticalBoundaryProven
        && truth.ok
        && behaviorChecks.every(item => item.observed === true),
    };
  } finally {
    await setRegressionModelPreference(context.baseUrl, context.token, defaultPreference);
    preferenceRestored = true;
  }
  result.preferenceRestored = preferenceRestored;
  return result;
}

const SCENARIO_RUNNERS = new Map([
  ['cleanup_offer_then_cleanup', runCleanupScenario],
  ['repeated_confirmation_exactly_once', runRepeatedConfirmationScenario],
  ['wps_wrong_file_correction', runWpsWrongFileCorrectionScenario],
  ['displayed_result_stale_receipt', runDisplayedStaleReceiptScenario],
  ['control_stop_status_repeat', runControlScenario],
  ['voice_to_text_continuation', runVoiceToTextContinuationScenario],
  ['mid_task_restart_recovery', runMidTaskRestartRecoveryScenario],
  ['primary_model_failover_lmstudio', runPrimaryModelFailoverLmStudioScenario],
]);

function sanitizeScenarioResult(result) {
  return stableValue(result);
}

function machineEvidenceSummary(report, cleanup) {
  const scenario = (Array.isArray(report?.scenarioResults) ? report.scenarioResults : [])
    .find(item => item?.scenarioId === 'repeated_confirmation_exactly_once');
  const timelineStates = scenario?.stateTimeline
    ? [
        scenario.stateTimeline.afterPending,
        scenario.stateTimeline.afterFirstConfirmation,
        scenario.stateTimeline.afterRepeatedConfirmation,
      ]
    : [scenario?.state].filter(Boolean);
  const runtimeTaskIds = [...new Set(timelineStates
    .map(state => String(state?.task?.taskId || ''))
    .filter(Boolean))];
  const transcriptToolCalls = [];
  const seenToolCalls = new Set();
  for (const state of timelineStates) {
    for (const message of Array.isArray(state?.transcript) ? state.transcript : []) {
      for (const call of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
        const projection = {
          messageRequestId: String(message?.requestId || ''),
          name: String(call?.name || ''),
          requestId: String(call?.requestId || ''),
          taskId: String(call?.taskId || ''),
          targetSha256: String(call?.targetSha256 || ''),
        };
        const key = stableTaskRegressionProbeJson(projection);
        if (seenToolCalls.has(key)) continue;
        seenToolCalls.add(key);
        transcriptToolCalls.push(projection);
      }
    }
  }
  const taskIdMismatchObserved = runtimeTaskIds.length > 0 && transcriptToolCalls.some(call => (
    Boolean(call.taskId) && !runtimeTaskIds.includes(call.taskId)
  ));
  const requestIds = Array.isArray(scenario?.turns)
    ? scenario.turns.map(turn => String(turn?.requestId || '')).filter(Boolean)
    : [];
  const confirmationToolCorrelations = [...new Set((scenario?.turns?.[1]?.toolEvents || [])
    .filter(event => event?.name === 'desktop_write_text_file')
    .map(event => String(event?.correlationId || ''))
    .filter(Boolean))];
  const repeatedConfirmationToolCorrelations = [...new Set((scenario?.turns?.[2]?.toolEvents || [])
    .filter(event => event?.name === 'desktop_write_text_file')
    .map(event => String(event?.correlationId || ''))
    .filter(Boolean))];
  return stableValue({
    schemaVersion: 1,
    failClosed: report?.failClosed?.active === true || report?.summary?.overallPassed !== true,
    matrixRunProduced: report?.summary?.matrixRunProduced === true,
    overallPassed: report?.summary?.overallPassed === true,
    scenario2: scenario ? {
      requestIds,
      artifactExistenceTimeline: {
        afterPending: scenario?.artifact?.existedBeforeConfirmation === true,
        afterFirstConfirmation: scenario?.artifact?.existedAfterFirstConfirmation === true,
        afterRepeatedConfirmation: scenario?.artifact?.existedAfterRepeatedConfirmation === true,
      },
      taskStatusTimeline: {
        afterPending: String(scenario?.stateTimeline?.afterPending?.task?.status || ''),
        afterFirstConfirmation: String(scenario?.stateTimeline?.afterFirstConfirmation?.task?.status || ''),
        afterRepeatedConfirmation: String(scenario?.stateTimeline?.afterRepeatedConfirmation?.task?.status || ''),
      },
      confirmationToolCorrelations,
      repeatedConfirmationToolCorrelations,
      runtimeTaskIds,
      transcriptToolCalls,
      taskIdMismatchObserved,
      truthSnapshotOk: scenario?.truthSnapshot?.ok === true,
      truthSnapshotCode: String(scenario?.truthSnapshot?.code || ''),
      matrixEligible: scenario?.matrixEligible === true,
    } : null,
    cleanup: {
      backendStopped: cleanup.backendStopped === true,
      modelStubStopped: cleanup.modelStubStopped === true,
      sandboxRemoved: cleanup.sandboxRemoved === true,
    },
  });
}

function selectedScenarios(values) {
  const requested = values?.length ? values : IMPLEMENTED_BLACK_BOX_SCENARIOS;
  const valid = new Set(TASK_REGRESSION_SCENARIOS.map(item => item.id));
  const output = [];
  for (const value of requested) {
    const scenario = TASK_REGRESSION_SCENARIOS.find(item => item.id === value || String(item.ordinal) === String(value));
    if (!scenario || !valid.has(scenario.id)) fail('regression_scenario_invalid', { value });
    if (!SCENARIO_RUNNERS.has(scenario.id)) fail('regression_scenario_not_implemented', { scenarioId: scenario.id });
    if (!output.includes(scenario.id)) output.push(scenario.id);
  }
  return output;
}

function backendDiagnostics(runtime) {
  return {
    pid: runtime?.child?.pid || null,
    exitCode: runtime?.child?.exitCode ?? null,
    signal: runtime?.child?.signalCode || null,
    stdoutSha256: sha256(runtime?.stdout || ''),
    stdoutCharacters: String(runtime?.stdout || '').length,
    stderrSha256: sha256(runtime?.stderr || ''),
    stderrCharacters: String(runtime?.stderr || '').length,
  };
}

function addAssemblyIssue(issues, code) {
  if (!issues.includes(code)) issues.push(code);
}

function exactStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  if (actual.some(value => typeof value !== 'string' || !value.trim())) return false;
  const observed = new Set(actual);
  return observed.size === expected.length && expected.every(value => observed.has(value));
}

function taskRegressionProbeEvidenceProjection(report) {
  return {
    kind: report?.kind,
    schemaVersion: report?.schemaVersion,
    runId: report?.runId,
    role: report?.role,
    startedAt: report?.startedAt,
    completedAt: report?.completedAt,
    buildIdentity: report?.buildIdentity,
    isolation: report?.isolation,
    runtime: report?.runtime,
    providerBoundary: report?.providerBoundary,
    serverTruthAttestationBoundary: report?.serverTruthAttestationBoundary,
    speechRecognitionBoundary: report?.speechRecognitionBoundary,
    requestedScenarioIds: report?.requestedScenarioIds,
    scenarioResults: report?.scenarioResults,
    cleanup: report?.cleanup,
  };
}

function scenarioTruthWrappers(result, scenarioId, issues) {
  const layout = MATRIX_TRUTH_LAYOUT[scenarioId];
  if (!layout) {
    addAssemblyIssue(issues, `${scenarioId}:truth_layout_missing`);
    return [];
  }
  let wrappers = [];
  if (layout.single) {
    if (result?.truthSnapshots !== undefined) {
      addAssemblyIssue(issues, `${scenarioId}:unexpected_multiple_truth_container`);
    }
    wrappers = [result?.[layout.single]];
  } else {
    if (result?.truthSnapshot !== undefined) {
      addAssemblyIssue(issues, `${scenarioId}:unexpected_single_truth_container`);
    }
    const container = result?.truthSnapshots;
    const actualKeys = container && typeof container === 'object' && !Array.isArray(container)
      ? Object.keys(container)
      : [];
    if (!exactStringSet(actualKeys, layout.multiple)) {
      addAssemblyIssue(issues, `${scenarioId}:truth_phase_set_mismatch`);
    }
    wrappers = layout.multiple.map(key => container?.[key]);
  }
  const snapshots = [];
  for (const [index, wrapper] of wrappers.entries()) {
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper) || wrapper.ok !== true) {
      addAssemblyIssue(issues, `${scenarioId}:truth_phase_${index}_not_adjudicated`);
      continue;
    }
    if (!wrapper.snapshot || typeof wrapper.snapshot !== 'object' || Array.isArray(wrapper.snapshot)) {
      addAssemblyIssue(issues, `${scenarioId}:truth_phase_${index}_snapshot_missing`);
      continue;
    }
    snapshots.push(wrapper.snapshot);
  }
  return snapshots;
}

function validateScenarioSpecificMatrixBoundary(report, result, scenarioId, buildIdentityDigest, issues) {
  if (scenarioId === 'displayed_result_stale_receipt') {
    const evidence = result?.staleReceiptEvidence?.evidence;
    const turns = Array.isArray(result?.turns) ? result.turns : [];
    const validation = validateStaleReceiptEvidence(evidence, {
      acceptanceRunId: report.runId,
      buildIdentityDigest,
      conversationId: evidence?.conversationId,
      displayRequestId: turns[0]?.requestId,
      continueRequestId: turns[1]?.requestId,
    });
    if (result?.staleReceiptEvidence?.ok !== true || !validation.ok) {
      addAssemblyIssue(issues, `${scenarioId}:stale_receipt_evidence_invalid`);
    }
  }

  if (scenarioId === 'control_stop_status_repeat') {
    const witness = result?.providerWitness || {};
    const bounded = witness.bounded === true
      && witness.captureIndex === witness.expectedCaptureIndex
      && witness.scenarioCaptureIndex === witness.expectedScenarioCaptureIndex
      && witness.scenarioCaptureIndex === 0
      && witness.scenarioProviderRequestCount === 1
      && witness.scheduledDelayMs === 15_000
      && typeof witness.abortedAt === 'string'
      && Boolean(witness.abortedAt)
      && !witness.deliveredAt
      && Number.isFinite(witness.providerCaptureToCompletionMs)
      && witness.providerCaptureToCompletionMs >= 0
      && witness.providerCaptureToCompletionMs <= witness.maximumProviderCaptureToCompletionMs
      && witness.maximumProviderCaptureToCompletionMs === 5_000;
    if (!bounded) addAssemblyIssue(issues, `${scenarioId}:provider_cancellation_witness_invalid`);
  }

  if (scenarioId === 'voice_to_text_continuation') {
    const wrapper = result?.truthSnapshot || {};
    const truth = wrapper.voiceTextContinuation || {};
    const contract = report?.serverTruthAttestationBoundary?.contract;
    const requestIds = Array.isArray(result?.requestIds) ? result.requestIds : [];
    const signed = validateVoiceTextContinuationTruthEnvelope(
      wrapper.voiceTextContinuationEnvelope,
      {
        acceptanceRunId: report.runId,
        buildIdentityDigest,
        dataRootIdentitySha256: contract?.dataRootIdentitySha256,
        serverTruthContract: contract,
        conversationId: result?.conversationId,
        taskId: result?.taskId,
        voiceRequestId: requestIds[0],
        textRequestId: requestIds[1],
        previousTarget: truth?.targetCorrection?.previousTarget,
        replacementTarget: truth?.targetCorrection?.replacementTarget,
      },
    );
    if (
      report?.serverTruthAttestationBoundary?.enabled !== true
      || report?.serverTruthAttestationBoundary?.pinnedBeforeS6Phase !== true
      || wrapper.serverTruthContractSha256 !== contract?.contractSha256
      || !signed.ok
      || stableTaskRegressionProbeJson(signed.truth) !== stableTaskRegressionProbeJson(truth)
      || result?.voiceBoundary?.voiceStopped !== true
    ) {
      addAssemblyIssue(issues, `${scenarioId}:signed_continuation_boundary_invalid`);
    }
  }

  if (scenarioId === 'primary_model_failover_lmstudio') {
    const primary = result?.primaryFailureBoundary || {};
    const fallback = result?.lmStudioBoundary || {};
    if (
      result?.preferenceRestored !== true
      || result?.executionStatus !== 'observed'
      || primary.before?.code !== 'ECONNREFUSED'
      || primary.after?.code !== 'ECONNREFUSED'
      || primary.sameAsLmStudioStub !== false
      || fallback.exactCallCount !== 2
      || !Array.isArray(fallback.captures)
      || fallback.captures.length !== 2
      || !Array.isArray(fallback.decisions)
      || fallback.decisions.length !== 2
    ) {
      addAssemblyIssue(issues, `${scenarioId}:failover_boundary_invalid`);
    }
  }
}

/**
 * Converts one live, isolated eight-scenario probe into the existing formal
 * task-regression-run.v1 artifact. This is deliberately an adjudicator, not a
 * boolean adapter: every raw harness gate, truth snapshot, source/runtime
 * identity and owned cleanup boundary is rechecked before assembly.
 *
 * The accepted scope is the isolated backend black-box matrix only. It never
 * claims that a native GUI, microphone, WPS installation, or OS session ran.
 */
export function assembleTaskRegressionRunFromProbe(report) {
  const issues = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, code: 'task_regression_matrix_assembly_rejected', issues: ['probe_object_required'] };
  }
  if (report.kind !== TASK_REGRESSION_PROBE_KIND
    || report.schemaVersion !== TASK_REGRESSION_PROBE_SCHEMA_VERSION) {
    addAssemblyIssue(issues, 'probe_contract_mismatch');
  }
  if (report.fatal) addAssemblyIssue(issues, 'probe_fatal');
  if (!['baseline', 'candidate'].includes(report.role)) addAssemblyIssue(issues, 'probe_role_invalid');
  if (!exactStringSet(report.requestedScenarioIds, IMPLEMENTED_BLACK_BOX_SCENARIOS)) {
    addAssemblyIssue(issues, 'exact_eight_scenarios_required');
  }
  if (!Array.isArray(report.scenarioResults)
    || report.scenarioResults.length !== TASK_REGRESSION_SCENARIOS.length) {
    addAssemblyIssue(issues, 'exact_eight_scenario_results_required');
  }

  const isolation = report.isolation || {};
  const relay = isolation.isolatedDesktopSemanticRelay || {};
  if (
    isolation.temporaryDataRoot !== true
    || isolation.productDataRootReadAllowed !== false
    || isolation.productDataRootOverlap !== false
    || isolation.dotenvSource !== 'owned_empty_file'
    || isolation.inheritedSecretEnvironmentVariables !== 0
    || isolation.localDeterministicModelOnly !== true
    || isolation.nativeClientStartedOrTouched !== false
    || relay.mutationsOutsideOwnedSandboxAllowed !== false
    || relay.nativeDeviceRegistered !== false
  ) addAssemblyIssue(issues, 'isolated_non_native_boundary_invalid');

  const runtime = report.runtime || {};
  if (
    runtime.healthStatus !== 'ok'
    || runtime.sourceIdentityStable !== true
    || runtime.endingSourceFingerprintSha256 !== report.buildIdentity?.sourceFingerprintSha256
    || runtime.serverEntrySha256 !== runtime.endingRuntimeArtifactSha256
  ) addAssemblyIssue(issues, 'runtime_source_identity_unstable');

  const provider = report.providerBoundary || {};
  if (
    provider.kind !== 'local_deterministic_openai_compatible_stub'
    || !Array.isArray(provider.captures)
    || provider.requestCount !== provider.captures.length
    || !Array.isArray(provider.decisions)
  ) addAssemblyIssue(issues, 'provider_boundary_invalid');

  const speech = report.speechRecognitionBoundary || {};
  if (
    speech.enabled !== true
    || speech.kind !== 'loopback_doubao_streaming_protocol_stub'
    || speech.nativeMicrophoneClientStartedOrTouched !== false
    || !Array.isArray(speech.captures)
    || speech.captureCount !== speech.captures.length
    || speech.captureCount < 1
  ) addAssemblyIssue(issues, 'speech_recognition_boundary_invalid');

  if (
    report.cleanup?.backendStopped !== true
    || report.cleanup?.modelStubStopped !== true
    || report.cleanup?.sandboxRemoved !== true
    || report.cleanupFailure
  ) addAssemblyIssue(issues, 'owned_temporary_resource_cleanup_incomplete');

  let buildIdentityDigest = '';
  try {
    buildIdentityDigest = taskRegressionBuildIdentityDigest(report.buildIdentity);
  } catch {
    addAssemblyIssue(issues, 'build_identity_invalid');
  }

  const scenarioResults = [];
  const seenScenarioIds = new Set();
  for (const scenario of TASK_REGRESSION_SCENARIOS) {
    const matching = (Array.isArray(report.scenarioResults) ? report.scenarioResults : [])
      .filter(result => result?.scenarioId === scenario.id);
    if (matching.length !== 1) {
      addAssemblyIssue(issues, `${scenario.id}:unique_result_required`);
      continue;
    }
    const result = matching[0];
    seenScenarioIds.add(scenario.id);
    if (result.executionStatus !== 'observed') {
      addAssemblyIssue(issues, `${scenario.id}:execution_not_observed`);
    }
    if (result.sourceIdentityStable !== true) {
      addAssemblyIssue(issues, `${scenario.id}:source_identity_unstable`);
    }
    if (result.matrixEligible !== true) {
      addAssemblyIssue(issues, `${scenario.id}:matrix_ineligible`);
    }

    const expectedHarnessChecks = [
      ...scenario.checks,
      ...(MATRIX_HARNESS_ONLY_CHECKS[scenario.id] || []),
    ];
    const behaviorChecks = Array.isArray(result.behaviorChecks) ? result.behaviorChecks : [];
    const observedCheckIds = behaviorChecks.map(checkValue => checkValue?.checkId);
    if (!exactStringSet(observedCheckIds, expectedHarnessChecks)) {
      addAssemblyIssue(issues, `${scenario.id}:behavior_check_set_mismatch`);
    }
    for (const checkId of expectedHarnessChecks) {
      const matchingChecks = behaviorChecks.filter(checkValue => checkValue?.checkId === checkId);
      const checkValue = matchingChecks[0];
      if (matchingChecks.length !== 1
        || checkValue?.observed !== true
        || !Array.isArray(checkValue?.evidence)
        || checkValue.evidence.length === 0
        || checkValue.evidence.some(value => typeof value !== 'string' || !value.trim())) {
        addAssemblyIssue(issues, `${scenario.id}:${checkId}:not_proven`);
      }
    }

    const snapshots = scenarioTruthWrappers(result, scenario.id, issues);
    for (const [index, snapshot] of snapshots.entries()) {
      const validation = validateTaskTruthSnapshot(snapshot, {
        expectedScenarioId: scenario.id,
        expectedAcceptanceRunId: report.runId,
        expectedBuildIdentityDigest: buildIdentityDigest,
      });
      if (!validation.ok) {
        addAssemblyIssue(issues, `${scenario.id}:truth_snapshot_${index}_invalid`);
      }
    }
    validateScenarioSpecificMatrixBoundary(
      report,
      result,
      scenario.id,
      buildIdentityDigest,
      issues,
    );
    scenarioResults.push({
      scenarioId: scenario.id,
      snapshots,
      checks: scenario.checks.map(checkId => ({
        checkId,
        passed: behaviorChecks.some(checkValue => (
          checkValue?.checkId === checkId && checkValue.observed === true
        )),
        evidenceSnapshotIds: snapshots.map(snapshot => snapshot.snapshotId),
      })),
    });
  }
  if (seenScenarioIds.size !== TASK_REGRESSION_SCENARIOS.length) {
    addAssemblyIssue(issues, 'scenario_coverage_incomplete');
  }

  const run = {
    kind: TASK_REGRESSION_RUN_KIND,
    schemaVersion: TASK_REGRESSION_RUN_SCHEMA_VERSION,
    runId: report.runId,
    role: report.role,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    buildIdentity: report.buildIdentity,
    scenarioResults,
  };
  const validation = validateTaskRegressionRun(run);
  if (!validation.ok) {
    for (const issue of validation.issues) {
      addAssemblyIssue(issues, `run_schema:${issue.path}:${issue.code}`);
    }
  }
  const summary = summarizeTaskRegressionRun(run);
  if (!summary.artifactValid || !summary.overallPassed) {
    addAssemblyIssue(issues, 'assembled_run_not_passing');
  }
  if (issues.length > 0) {
    return {
      ok: false,
      code: 'task_regression_matrix_assembly_rejected',
      issues,
      summary,
    };
  }
  return {
    ok: true,
    run,
    summary,
    runSha256: taskRegressionDigest(run),
    probeEvidenceSha256: taskRegressionDigest(taskRegressionProbeEvidenceProjection(report)),
    acceptanceScope: 'isolated_backend_black_box_non_native',
  };
}

function applyTaskRegressionRunAssembly(report) {
  const assembly = assembleTaskRegressionRunFromProbe(report);
  report.matrixRun = assembly.ok ? assembly.run : null;
  report.matrixAssembly = {
    kind: 'lumi.task-regression-run-assembly',
    schemaVersion: 1,
    status: assembly.ok ? 'accepted' : 'rejected',
    acceptanceScope: 'isolated_backend_black_box_non_native',
    nativeClientEvidenceProduced: false,
    formalStage9AcceptanceProduced: false,
    probeEvidenceSha256: assembly.ok ? assembly.probeEvidenceSha256 : null,
    runSha256: assembly.ok ? assembly.runSha256 : null,
    issues: assembly.ok ? [] : assembly.issues,
  };
  report.summary.matrixRunProduced = assembly.ok;
  report.summary.overallPassed = assembly.ok;
  report.failClosed = {
    ...(report.failClosed || {}),
    active: !assembly.ok,
    reason: assembly.ok
      ? 'validated_task_regression_run_non_native_boundary'
      : (assembly.issues[0] || assembly.code),
  };
  return assembly;
}

export async function runTaskRegressionBlackBoxProbe(options) {
  const role = options?.role;
  if (!['baseline', 'candidate'].includes(role)) fail('regression_role_invalid');
  const scenarios = selectedScenarios(options.scenarios);
  const startedAt = new Date().toISOString();
  const runId = `task_regression_${role}_${crypto.randomBytes(12).toString('hex')}`;
  const protectedRoots = options.protectedRoots || defaultProtectedProductRoots();
  let sandbox = null;
  let modelStub = null;
  let runtime = null;
  let socket = null;
  let cleanup = { backendStopped: false, modelStubStopped: false, sandboxRemoved: false };
  let report;
  try {
    const fullIdentity = computeTaskRegressionBuildIdentity(options.worktree);
    sandbox = await createIsolatedRegressionSandbox({
      tempBase: options.tempBase,
      protectedRoots,
    });
    const target = resolveTargetRuntime(options.worktree);
    const runtimeArtifactSha256 = sha256(fs.readFileSync(target.entry));
    const buildIdentity = projectTaskRegressionMatrixBuildIdentity(fullIdentity, {
      runtimeArtifactPath: target.entry,
      runtimeArtifactSha256,
      collectedAt: new Date().toISOString(),
    });
    const buildIdentityDigest = taskRegressionBuildIdentityDigest(buildIdentity);
    const confirmationArtifact = path.join(sandbox.artifacts, 'confirm-exactly-once.txt');
    const confirmationContent = `lumi-task-regression:${runId}:exactly-once`;
    const s1SeedSuffix = sha256(runId).slice(0, 12);
    const s1SeedTitles = {
      A: `S1 exact cleanup A ${s1SeedSuffix}`,
      B: `S1 exact cleanup B ${s1SeedSuffix}`,
      C: `S1 later work C ${s1SeedSuffix}`,
    };
    const staleFixture = path.join(sandbox.artifacts, 'displayed-result-source.txt');
    const stalePendingFixture = path.join(sandbox.artifacts, 'displayed-result-next-step.txt');
    const staleFixtureContent = `visible-result:${runId}`;
    const stalePendingContent = 'stale receipt live-owner sentinel';
    const restartArtifact = path.join(sandbox.artifacts, 'restart-recovery-result.txt');
    const restartArtifactContent = `restart-recovered:${runId}`;
    const s6MissingPath = path.join(
      sandbox.artifacts,
      `s6-missing-${sha256(runId).slice(0, 12)}.txt`,
    );
    const s6CorrectPath = path.join(sandbox.artifacts, `s6-correct-${sha256(runId).slice(0, 12)}.txt`);
    const s6CorrectContent = `S6 accepted STT continuity fixture ${sha256(runId).slice(0, 16)}`;
    const s6SttTranscript = `[LUMI_REGRESSION:S6] [LUMI_REGRESSION:S6:VOICE] 请在桌面查找并读取文件 ${s6MissingPath}，如果找不到就明确告诉我，等我纠正后继续这个任务。`;
    const s8PrimaryModel = 'deepseek-chat';
    const s8FallbackModel = 'lumi-regression-stub-v1';
    const s8FixturePath = path.join(sandbox.artifacts, `s8-failover-${sha256(runId).slice(0, 12)}.txt`);
    const s8FixtureContent = `S8_CHAT_TASK_VERIFIED_${sha256(runId).slice(0, 20)}`;
    const s8FinalText = `The exact verified marker is ${s8FixtureContent}.`;
    const wpsWrongName = 'WPS-Quarterly-Review-Draft.pptx';
    const wpsCorrectName = 'WPS-Quarterly-Review-Final.pptx';
    const wpsWrongContent = `WRONG-WPS-CONTENT:${runId}:obsolete revenue 17`;
    const wpsCorrectContent = `CORRECT-WPS-CONTENT:${runId}:verified revenue 42`;
    const wpsCorrectSummary = '已核对的营收数字是 42';
    const wpsWrongFixture = path.join(sandbox.artifacts, wpsWrongName);
    const wpsCorrectFixture = path.join(sandbox.artifacts, wpsCorrectName);
    let wpsWrongFixtureBytes = Buffer.alloc(0);
    let wpsCorrectFixtureBytes = Buffer.alloc(0);
    if (scenarios.includes('wps_wrong_file_correction')) {
      [wpsWrongFixtureBytes, wpsCorrectFixtureBytes] = await Promise.all([
        writeIsolatedPptxFixture(wpsWrongFixture, wpsWrongContent),
        writeIsolatedPptxFixture(wpsCorrectFixture, wpsCorrectContent),
      ]);
    }
    const usesDesktopSemanticRelay = scenarios.includes('repeated_confirmation_exactly_once')
      || scenarios.includes('wps_wrong_file_correction')
      || scenarios.includes('displayed_result_stale_receipt')
      || scenarios.includes('mid_task_restart_recovery');
    const desktopRelayTargets = [
      ...(scenarios.includes('repeated_confirmation_exactly_once') ? [{
        scenarioId: 'repeated_confirmation_exactly_once',
        relativePath: path.basename(confirmationArtifact),
        contentSha256: sha256(confirmationContent),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }] : []),
      ...(scenarios.includes('displayed_result_stale_receipt') ? [{
        scenarioId: 'displayed_result_stale_receipt',
        relativePath: path.basename(stalePendingFixture),
        contentSha256: sha256(stalePendingContent),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }] : []),
      ...(scenarios.includes('mid_task_restart_recovery') ? [{
        scenarioId: 'mid_task_restart_recovery',
        relativePath: path.basename(restartArtifact),
        contentSha256: sha256(restartArtifactContent),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }] : []),
      ...(scenarios.includes('wps_wrong_file_correction') ? [{
        scenarioId: 'wps_wrong_file_correction',
        relativePath: wpsWrongName,
        contentSha256: sha256(wpsWrongFixtureBytes),
        encoding: 'binary',
        overwritePolicy: 'read_only',
      }, {
        scenarioId: 'wps_wrong_file_correction',
        relativePath: wpsCorrectName,
        contentSha256: sha256(wpsCorrectFixtureBytes),
        encoding: 'binary',
        overwritePolicy: 'read_only',
      }] : []),
    ];
    const evidenceAccess = await provisionTaskRegressionEvidenceAccess(sandbox, runId, {
      buildIdentityDigest,
      snapshotBindings: truthSnapshotBindings(runId, scenarios),
      desktopRelayTargets,
    });
    await fsp.writeFile(staleFixture, staleFixtureContent, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    if (scenarios.includes('voice_to_text_continuation')) {
      await fsp.writeFile(s6CorrectPath, s6CorrectContent, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
    }
    if (scenarios.includes('primary_model_failover_lmstudio')) {
      await fsp.writeFile(s8FixturePath, s8FixtureContent, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
    }
    modelStub = await startDeterministicRegressionModelStub({
      evidenceAccess,
      confirmationArtifact,
      confirmationContent,
      staleFixture,
      staleFixtureContent,
      stalePendingFixture,
      restartArtifact,
      restartArtifactContent,
      wpsWrongName,
      wpsWrongContent,
      wpsCorrectName,
      wpsCorrectContent,
      wpsCorrectSummary,
      wpsCorrectPath: wpsCorrectFixture,
      s1SeedTitles,
      s6MissingPath,
      s6SearchDirectory: '~/Desktop',
      s6CorrectPath,
      s6CorrectContent,
      s6SttTranscript: scenarios.includes('voice_to_text_continuation') ? s6SttTranscript : '',
      s8FixturePath,
      s8FixtureContent,
      s8FinalText,
    });
    const s8PrimaryFailurePort = scenarios.includes('primary_model_failover_lmstudio')
      ? await reserveLoopbackPort()
      : 0;
    const s8PrimaryFailureBaseUrl = s8PrimaryFailurePort
      ? `http://${LOOPBACK_HOST}:${s8PrimaryFailurePort}/v1`
      : '';
    if (s8PrimaryFailurePort && s8PrimaryFailurePort === modelStub.port) {
      fail('regression_primary_failure_endpoint_collides_with_lmstudio_stub');
    }
    runtime = await startIsolatedRegressionBackend({
      worktree: options.worktree,
      sandbox,
      modelStubBaseUrl: modelStub.baseUrl,
      primaryFailureBaseUrl: s8PrimaryFailureBaseUrl,
      sttStubUrl: modelStub.sttWsUrl,
      startupTimeoutMs: options.startupTimeoutMs,
      evidenceAccess,
    });
    if (
      normalizedPath(runtime.target.entry) !== normalizedPath(target.entry)
      || sha256(fs.readFileSync(runtime.target.entry)) !== runtimeArtifactSha256
    ) fail('regression_runtime_identity_changed_after_manifest');
    const initialSession = await openIsolatedRegressionBackendSession({
      runtime,
      sandbox,
      evidenceAccess,
      socketTimeoutMs: 15_000,
    });
    let token = initialSession.token;
    socket = initialSession.socket;
    let serverTruthContract = null;
    const context = {
      runId,
      role,
      baseUrl: runtime.baseUrl,
      token,
      socket,
      turnTimeoutMs: options.turnTimeoutMs || 45_000,
      confirmationArtifact,
      confirmationContent,
      s1SeedTitles,
      staleFixture,
      staleFixtureContent,
      stalePendingFixture,
      restartArtifact,
      restartArtifactContent,
      s6MissingPath,
      s6CorrectPath,
      s6CorrectContent,
      s6SttTranscript,
      s8PrimaryModel,
      s8FallbackModel,
      s8FixturePath,
      s8FixtureContent,
      s8FinalText,
      s8PrimaryFailurePort,
      s8PrimaryFailureBaseUrl,
      wpsWrongFixture,
      wpsWrongName,
      wpsWrongContent,
      wpsCorrectFixture,
      wpsCorrectName,
      wpsCorrectContent,
      wpsCorrectSummary,
      buildIdentity,
      buildIdentityDigest,
      truthSnapshotProof: evidenceAccess.proof,
      serverTruthContract,
      modelStub,
    };
    context.restartBackend = async () => {
      const restarted = await restartIsolatedRegressionBackendSession({
        runtime,
        socket,
        worktree: options.worktree,
        sandbox,
        modelStubBaseUrl: modelStub.baseUrl,
        primaryFailureBaseUrl: s8PrimaryFailureBaseUrl,
        sttStubUrl: modelStub.sttWsUrl,
        evidenceAccess,
        startupTimeoutMs: options.startupTimeoutMs,
        socketTimeoutMs: 15_000,
      });
      if (
        normalizedPath(restarted.runtime.target.entry) !== normalizedPath(target.entry)
        || sha256(fs.readFileSync(restarted.runtime.target.entry)) !== runtimeArtifactSha256
      ) {
        await stopIsolatedRegressionBackend(restarted.runtime).catch(() => {});
        fail('regression_runtime_identity_changed_after_restart');
      }
      runtime = restarted.runtime;
      socket = restarted.socket;
      token = restarted.token;
      context.baseUrl = runtime.baseUrl;
      context.token = token;
      context.socket = socket;
      return restarted;
    };
    const scenarioResults = [];
    for (const scenarioId of scenarios) {
      try {
        if (scenarioId === 'voice_to_text_continuation') {
          serverTruthContract = await pinTaskRegressionServerTruthSigner({
            baseUrl: context.baseUrl,
            token: context.token,
            acceptanceRunId: runId,
            buildIdentityDigest,
            dataRoot: sandbox.dataRoot,
            evidenceAccess,
          });
          context.serverTruthContract = serverTruthContract;
        }
        scenarioResults.push(sanitizeScenarioResult(await SCENARIO_RUNNERS.get(scenarioId)(context)));
      } catch (error) {
        scenarioResults.push({
          scenarioId,
          executionStatus: 'failed_closed',
          matrixEligible: false,
          error: {
            code: error?.code || 'regression_scenario_execution_failed',
            messageSha256: sha256(String(error?.message || error)),
          },
        });
      }
    }
    const endingIdentity = computeTaskRegressionBuildIdentity(options.worktree);
    const endingRuntimeArtifactSha256 = sha256(fs.readFileSync(target.entry));
    const sourceIdentityStable = endingIdentity.revision === fullIdentity.revision
      && endingIdentity.sourceDirty === fullIdentity.sourceDirty
      && endingIdentity.sourceFingerprint === fullIdentity.sourceFingerprint
      && endingRuntimeArtifactSha256 === runtimeArtifactSha256;
    if (!sourceIdentityStable) {
      for (const scenarioResult of scenarioResults) {
        scenarioResult.executionStatus = 'failed_closed';
        scenarioResult.matrixEligible = false;
        scenarioResult.sourceIdentityStable = false;
      }
    } else {
      for (const scenarioResult of scenarioResults) scenarioResult.sourceIdentityStable = true;
    }
    const completedAt = new Date().toISOString();
    const matrixEligibleScenarioCount = scenarioResults.filter(item => item.matrixEligible === true).length;
    const observedBehaviorChecks = scenarioResults.flatMap(item => item.behaviorChecks || []);
    const passedBehaviorCheckCount = observedBehaviorChecks.filter(item => item.observed === true).length;
    report = {
      kind: TASK_REGRESSION_PROBE_KIND,
      schemaVersion: TASK_REGRESSION_PROBE_SCHEMA_VERSION,
      runId,
      role,
      startedAt,
      completedAt,
      buildIdentity,
      isolation: {
        temporaryDataRoot: true,
        productDataRootReadAllowed: false,
        productDataRootOverlap: false,
        dotenvSource: 'owned_empty_file',
        inheritedSecretEnvironmentVariables: 0,
        localDeterministicModelOnly: true,
        nativeClientStartedOrTouched: false,
        isolatedDesktopSemanticRelay: {
          enabled: usesDesktopSemanticRelay,
          nativeDeviceRegistered: false,
          proofSeparatedFromTruthSnapshot: evidenceAccess.desktopRelayProofSha256 !== evidenceAccess.proofSha256,
          allowedTools: scenarios.includes('wps_wrong_file_correction')
            ? [
                'desktop_active_window',
                'desktop_list_files',
                ...(scenarios.some(value => value !== 'wps_wrong_file_correction')
                  ? ['desktop_write_text_file']
                  : []),
              ]
            : ['desktop_write_text_file'],
          allowlistedTargetCount: evidenceAccess.desktopRelayTargets.length,
          allowedPathScope: 'owned regression sandbox artifacts directory only',
          mutationsOutsideOwnedSandboxAllowed: false,
        },
        dataRootDigest: sha256(normalizedPath(sandbox.dataRoot)),
        sandboxDigest: sha256(normalizedPath(sandbox.root)),
      },
      runtime: {
        healthStatus: String(runtime.health?.status || ''),
        apiPort: runtime.port,
        serverEntry: path.relative(runtime.target.root, runtime.target.entry).replaceAll('\\', '/'),
        serverEntrySha256: runtimeArtifactSha256,
        sourceIdentityStable,
        endingSourceFingerprintSha256: endingIdentity.sourceFingerprint,
        endingRuntimeArtifactSha256,
        diagnostics: backendDiagnostics(runtime),
      },
      providerBoundary: {
        kind: 'local_deterministic_openai_compatible_stub',
        requestCount: modelStub.requests.length,
        captures: modelStub.requests,
        decisions: modelStub.decisions,
      },
      serverTruthAttestationBoundary: serverTruthContract
        ? {
            enabled: true,
            pinnedBeforeS6Phase: true,
            contract: serverTruthContract,
          }
        : {
            enabled: false,
            pinnedBeforeS6Phase: false,
          },
      speechRecognitionBoundary: {
        enabled: scenarios.includes('voice_to_text_continuation'),
        kind: 'loopback_doubao_streaming_protocol_stub',
        nativeMicrophoneClientStartedOrTouched: false,
        captureCount: modelStub.sttCaptures.length,
        captures: modelStub.sttCaptures,
      },
      requestedScenarioIds: scenarios,
      scenarioResults,
      summary: {
        requestedScenarioCount: scenarios.length,
        executedScenarioCount: scenarioResults.filter(item => item.executionStatus !== 'failed_closed').length,
        matrixEligibleScenarioCount,
        behaviorCheckCount: observedBehaviorChecks.length,
        passedBehaviorCheckCount,
        matrixRunProduced: false,
        overallPassed: false,
      },
      failClosed: {
        active: true,
        reason: matrixEligibleScenarioCount === scenarios.length && scenarios.length === TASK_REGRESSION_SCENARIOS.length
          ? 'matrix_run_assembly_not_implemented'
          : 'full_bound_truth_evidence_missing_or_only_subset_executed',
        requiredEvidenceEndpoint: `POST /api${DEFAULT_TRUTH_SNAPSHOT_ENDPOINT}`,
        requiredEndpointContract: {
          authorization: 'feature-disabled-by-default + isolated-manifest + requireAuth + requireAdmin + requireLocalRequest + acceptance-run proof',
          callerMaySupply: ['acceptanceRunId', 'conversationId', 'requestId', 'taskId'],
          serverMustDerive: [
            'scenarioId from the startup-manifest request binding',
            'buildIdentityDigest from the startup manifest',
            'userId', 'user-visible assistant record', 'task row', 'pending/live pointers',
            'request turn', 'tool receipt and target', 'provider-dispatch outbound model input',
            'modelActualInput.digestProtection=installation_hmac_sha256_v1',
            'modelActualInput.digestKeyId from the installation evidence key',
            'modelActualInput.evidenceAttestationSha256 over the protected evidence record',
          ],
          mutationsAllowed: false,
        },
        staleReceiptEvidenceEndpoint: `POST /api${DEFAULT_STALE_RECEIPT_ENDPOINT}`,
        staleReceiptEndpointContract: {
          authorization: 'feature-disabled-by-default + complete S4 manifest binding + requireAuth + requireAdmin + requireLocalRequest + acceptance-run proof',
          callerMaySupply: ['acceptanceRunId', 'conversationId'],
          callerMayNotSupply: ['scenarioId', 'requestId', 'taskId', 'receiptId', 'toolCalls', 'tool arguments', 'tool result'],
          serverMustDerive: [
            'S4 display/continue request ids from the startup manifest',
            'source receipt/task/tool record from the isolated database',
            'current live task and pending owner from the isolated database',
            'a single server-owned late-delivery identity',
            'archive evidence plus unchanged source receipt and live-owner digests',
          ],
          mutationsAllowed: 'one production-path stale archive inside the owned isolated data root',
        },
      },
    };
  } catch (error) {
    report = {
      kind: TASK_REGRESSION_PROBE_KIND,
      schemaVersion: TASK_REGRESSION_PROBE_SCHEMA_VERSION,
      runId,
      role,
      startedAt,
      completedAt: new Date().toISOString(),
      fatal: {
        code: error?.code || 'regression_probe_failed',
        messageSha256: sha256(String(error?.message || error)),
        details: error?.details && typeof error.details === 'object' ? error.details : {},
      },
      runtime: runtime ? {
        healthStatus: String(runtime.health?.status || ''),
        diagnostics: backendDiagnostics(runtime),
      } : null,
      isolation: {
        productDataRootReadAllowed: false,
        nativeClientStartedOrTouched: false,
      },
      summary: { matrixRunProduced: false, overallPassed: false },
    };
  } finally {
    try { socket?.disconnect(); } catch {}
    if (runtime) {
      try { await stopIsolatedRegressionBackend(runtime); cleanup.backendStopped = true; } catch {}
    } else cleanup.backendStopped = true;
    if (modelStub) {
      try { await modelStub.close(); cleanup.modelStubStopped = true; } catch {}
    } else cleanup.modelStubStopped = true;
    if (sandbox) {
      try { await removeIsolatedRegressionSandbox(sandbox); cleanup.sandboxRemoved = true; } catch {}
    } else cleanup.sandboxRemoved = true;
  }
  report.cleanup = cleanup;
  if (!cleanup.backendStopped || !cleanup.modelStubStopped || !cleanup.sandboxRemoved) {
    report.summary.overallPassed = false;
    report.cleanupFailure = 'owned_temporary_resource_cleanup_incomplete';
  }
  applyTaskRegressionRunAssembly(report);
  report.machineEvidence = machineEvidenceSummary(report, cleanup);
  return report;
}

export function taskRegressionProbeExitCode(report) {
  if (!report || report.kind !== TASK_REGRESSION_PROBE_KIND || report.fatal) return 1;
  const assembly = assembleTaskRegressionRunFromProbe(report);
  if (
    assembly.ok
    && report.summary?.matrixRunProduced === true
    && report.summary?.overallPassed === true
    && report.failClosed?.active === false
    && report.matrixAssembly?.status === 'accepted'
    && report.matrixAssembly?.acceptanceScope === 'isolated_backend_black_box_non_native'
    && report.matrixAssembly?.nativeClientEvidenceProduced === false
    && report.matrixAssembly?.formalStage9AcceptanceProduced === false
    && report.matrixAssembly?.runSha256 === assembly.runSha256
    && report.matrixAssembly?.probeEvidenceSha256 === assembly.probeEvidenceSha256
    && stableTaskRegressionProbeJson(report.matrixRun)
      === stableTaskRegressionProbeJson(assembly.run)
  ) return 0;
  return 2;
}
