import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler, Router } from 'express';
import { getDataRoot } from '../config/data_path';
import { requireAdmin, requireAuth, requireLocalRequest } from '../middleware/auth';
import {
  captureTaskTruthSnapshot,
  type CaptureTaskTruthSnapshotInput,
  type TaskTruthSnapshot,
} from './task_truth_snapshot';
import {
  captureControlSequenceTruthSnapshot,
  CONTROL_SEQUENCE_PHASE_IDS,
  CONTROL_STOP_STATUS_REPEAT_SCENARIO,
  type CaptureControlSequenceTruthSnapshotInput,
  type ControlSequenceTruthSnapshot,
} from './control_sequence_truth_snapshot';
import {
  DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO,
  reclassifyManifestBoundStaleReceipt,
  type ReclassifyManifestBoundStaleReceiptInput,
  type TaskRegressionStaleReceiptEvidence,
} from './stale_receipt_reclassification';
import {
  captureVoiceTextContinuationTruth,
  createVoiceTextContinuationTruthAttester,
  type CaptureVoiceTextContinuationTruthInput,
  type VoiceTextContinuationTruth,
  type VoiceTextContinuationTruthAttester,
  type VoiceTextContinuationTruthEnvelope,
  type VoiceTextContinuationTruthSignerDescriptor,
} from './voice_text_continuation_truth';

export const TASK_REGRESSION_SNAPSHOT_PATH = '/acceptance/task-regression/snapshot' as const;
export const TASK_REGRESSION_STALE_RECEIPT_PATH =
  '/acceptance/task-regression/stale-receipt' as const;
export const TASK_REGRESSION_SERVER_TRUTH_SIGNER_PATH =
  '/acceptance/task-regression/server-truth-signer' as const;
export const TASK_REGRESSION_PROOF_HEADER = 'x-lumi-task-regression-proof' as const;
export const TASK_REGRESSION_SIGNER_BOOTSTRAP_HEADER =
  'x-lumi-task-regression-signer-bootstrap' as const;
export const TASK_REGRESSION_ISOLATION_MANIFEST = 'task-regression-evidence.json' as const;
export const DISPLAYED_RESULT_STALE_RECEIPT_PHASE_IDS = ['display', 'continue'] as const;
export const MID_TASK_RESTART_RECOVERY_PHASE_IDS = ['prepare', 'continue'] as const;
export const VOICE_TEXT_CONTINUATION_PHASE_IDS = ['text_continue'] as const;
export const WPS_WRONG_FILE_CORRECTION_PHASE_IDS = [
  'anchor',
  'correction',
  'supply-filename',
] as const;

export const TASK_REGRESSION_EVIDENCE_ENV = Object.freeze({
  mode: 'LUMI_TASK_REGRESSION_EVIDENCE_MODE',
  acceptanceRunId: 'LUMI_TASK_REGRESSION_ACCEPTANCE_RUN_ID',
  sandboxRoot: 'LUMI_TASK_REGRESSION_SANDBOX_ROOT',
  proofSha256: 'LUMI_TASK_REGRESSION_PROOF_SHA256',
  sttAccessSha256: 'LUMI_TASK_REGRESSION_STT_ACCESS_SHA256',
  desktopRelayProofSha256: 'LUMI_TASK_REGRESSION_DESKTOP_RELAY_PROOF_SHA256',
  signerBootstrapSha256: 'LUMI_TASK_REGRESSION_SIGNER_BOOTSTRAP_SHA256',
  runnerPid: 'LUMI_TASK_REGRESSION_RUNNER_PID',
} as const);

const MANIFEST_KIND = 'lumi.task-regression-isolation' as const;
const MANIFEST_SCHEMA_VERSION = 3 as const;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_PROOF_RE = /^[A-Za-z0-9_-]{43,256}$/u;
const SAFE_ID_RE = /^[^\u0000-\u001f\u007f]{1,180}$/u;
const SAFE_SCENARIO_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u;
const MANIFEST_MAX_BYTES = 8 * 1024;
const MANIFEST_STARTUP_MAX_AGE_MS = 5 * 60 * 1000;
const MANIFEST_FUTURE_SKEW_MS = 30 * 1000;
const EVIDENCE_RUN_MAX_LIFETIME_MS = 45 * 60 * 1000;

interface TaskRegressionIsolationManifest {
  kind: typeof MANIFEST_KIND;
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  sandboxId: string;
  acceptanceRunId: string;
  runnerPid: number;
  createdAt: string;
  expiresAt: string;
  sandboxRootSha256: string;
  dataRootSha256: string;
  proofSha256: string;
  sttCredentialSha256: string;
  desktopRelayProofSha256: string;
  signerBootstrapSha256: string;
  desktopRelayArtifactsRootSha256: string;
  buildIdentityDigest: string;
  snapshotBindings: Array<{
    scenarioId: string;
    phases: Array<{
      phaseId: string;
      requestId: string;
    }>;
  }>;
  desktopRelayTargets: Array<{
    scenarioId: string;
    relativePath: string;
    contentSha256: string;
    encoding: 'utf-8' | 'binary';
    overwritePolicy: 'fail_if_exists' | 'read_only';
  }>;
}

export interface TaskRegressionDesktopRelayTarget {
  scenarioId: string;
  relativePath: string;
  absolutePath: string;
  contentSha256: string;
  encoding: 'utf-8' | 'binary';
  overwritePolicy: 'fail_if_exists' | 'read_only';
}

export interface TaskRegressionDesktopRelayConfig {
  proofSha256: string;
  artifactsRoot: string;
  targets: ReadonlyArray<Readonly<TaskRegressionDesktopRelayTarget>>;
}

export interface TaskRegressionEvidenceRouteConfig {
  acceptanceRunId: string;
  proofSha256: string;
  signerBootstrapSha256: string;
  sttAccessSha256: string;
  sandboxId: string;
  expiresAtMs: number;
  buildIdentityDigest: string;
  dataRootIdentitySha256: string;
  serverTruthSigner: Readonly<VoiceTextContinuationTruthSignerDescriptor>;
  snapshotBindings: ReadonlyArray<Readonly<{
    scenarioId: string;
    phases: ReadonlyArray<Readonly<{
      phaseId: string;
      requestId: string;
    }>>;
  }>>;
  desktopRelay: Readonly<TaskRegressionDesktopRelayConfig>;
  assertRuntimeIsolation: () => void;
}

const serverTruthAttesters = new WeakMap<
  TaskRegressionEvidenceRouteConfig,
  VoiceTextContinuationTruthAttester
>();

export interface TaskRegressionSyntheticVoiceBinding {
  acceptanceRunId: string;
  sandboxId: string;
  buildIdentityDigest: string;
  sttAccessSha256: string;
}

let activeSyntheticVoiceBinding: {
  value: Readonly<TaskRegressionSyntheticVoiceBinding>;
  expiresAtMs: number;
  assertRuntimeIsolation: () => void;
} | null = null;

/**
 * Returns a server-owned marker only after the complete isolated manifest was
 * mounted from this process' real environment. Test-injected environments and
 * ordinary production launches can never enable the synthetic Voice lane.
 */
export function getTaskRegressionSyntheticVoiceBinding(): Readonly<
  TaskRegressionSyntheticVoiceBinding
> | null {
  const active = activeSyntheticVoiceBinding;
  if (!active || Date.now() >= active.expiresAtMs) return null;
  if (
    process.env[TASK_REGRESSION_EVIDENCE_ENV.mode] !== '1'
    || process.env[TASK_REGRESSION_EVIDENCE_ENV.sttAccessSha256]
      !== active.value.sttAccessSha256
  ) return null;
  try { active.assertRuntimeIsolation(); } catch { return null; }
  return active.value;
}

interface ResolveConfigOptions {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  currentDataRoot?: string;
  nowMs?: number;
}

interface MountOptions extends ResolveConfigOptions {
  capture?: (
    input: CaptureTaskTruthSnapshotInput | CaptureControlSequenceTruthSnapshotInput,
  ) => Promise<TaskTruthSnapshot | ControlSequenceTruthSnapshot>;
  captureVoiceTextContinuation?: (
    input: CaptureVoiceTextContinuationTruthInput,
  ) => Promise<VoiceTextContinuationTruth>;
  reclassifyStaleReceipt?: (
    input: ReclassifyManifestBoundStaleReceiptInput,
  ) => Promise<TaskRegressionStaleReceiptEvidence>;
}

function routeConfigurationError(code: string): Error {
  const error = new Error(code);
  error.name = 'TaskRegressionEvidenceConfigurationError';
  return error;
}

function normalizedPath(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  );
}

function safeRealDirectory(value: string, code: string): string {
  if (!value || !path.isAbsolute(value)) throw routeConfigurationError(code);
  try {
    const metadata = fs.lstatSync(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw routeConfigurationError(code);
    }
    return fs.realpathSync.native(value);
  } catch (error) {
    if (error instanceof Error && error.name === 'TaskRegressionEvidenceConfigurationError') throw error;
    throw routeConfigurationError(code);
  }
}

function safeRegularFile(value: string, code: string, maximumBytes = MANIFEST_MAX_BYTES): fs.Stats {
  try {
    const metadata = fs.lstatSync(value);
    const canonical = fs.realpathSync.native(value);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || normalizedPath(canonical) !== normalizedPath(value)
      || metadata.size < 0
      || metadata.size > maximumBytes
    ) throw routeConfigurationError(code);
    return metadata;
  } catch (error) {
    if (error instanceof Error && error.name === 'TaskRegressionEvidenceConfigurationError') throw error;
    throw routeConfigurationError(code);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function portableDataRootIdentitySha256(value: string): string {
  return crypto.createHash('sha256')
    .update('lumi-portable-evidence-data-root-v1\0', 'utf8')
    .update(normalizedPath(value), 'utf8')
    .digest('hex');
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw routeConfigurationError(code);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw routeConfigurationError(code);
  }
  return value as Record<string, unknown>;
}

function readIsolationManifest(manifestPath: string): TaskRegressionIsolationManifest {
  safeRegularFile(manifestPath, 'task_regression_evidence_manifest_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw routeConfigurationError('task_regression_evidence_manifest_invalid');
  }
  const row = exactObject(parsed, [
    'kind',
    'schemaVersion',
    'sandboxId',
    'acceptanceRunId',
    'runnerPid',
    'createdAt',
    'expiresAt',
    'sandboxRootSha256',
    'dataRootSha256',
    'proofSha256',
    'sttCredentialSha256',
    'desktopRelayProofSha256',
    'signerBootstrapSha256',
    'desktopRelayArtifactsRootSha256',
    'buildIdentityDigest',
    'snapshotBindings',
    'desktopRelayTargets',
  ], 'task_regression_evidence_manifest_invalid');
  const manifest = row as unknown as TaskRegressionIsolationManifest;
  if (
    manifest.kind !== MANIFEST_KIND
    || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || !/^[a-f0-9]{32}$/u.test(String(manifest.sandboxId || ''))
    || !SAFE_ID_RE.test(String(manifest.acceptanceRunId || ''))
    || !Number.isSafeInteger(manifest.runnerPid)
    || manifest.runnerPid < 1
    || !Number.isFinite(Date.parse(String(manifest.createdAt || '')))
    || !Number.isFinite(Date.parse(String(manifest.expiresAt || '')))
    || !SHA256_RE.test(String(manifest.sandboxRootSha256 || ''))
    || !SHA256_RE.test(String(manifest.dataRootSha256 || ''))
    || !SHA256_RE.test(String(manifest.proofSha256 || ''))
    || !SHA256_RE.test(String(manifest.sttCredentialSha256 || ''))
    || !SHA256_RE.test(String(manifest.desktopRelayProofSha256 || ''))
    || !SHA256_RE.test(String(manifest.signerBootstrapSha256 || ''))
    || manifest.desktopRelayProofSha256 === manifest.proofSha256
    || manifest.sttCredentialSha256 === manifest.proofSha256
    || manifest.sttCredentialSha256 === manifest.desktopRelayProofSha256
    || [
      manifest.proofSha256,
      manifest.sttCredentialSha256,
      manifest.desktopRelayProofSha256,
    ].includes(manifest.signerBootstrapSha256)
    || !SHA256_RE.test(String(manifest.desktopRelayArtifactsRootSha256 || ''))
    || !SHA256_RE.test(String(manifest.buildIdentityDigest || ''))
    || !Array.isArray(manifest.snapshotBindings)
    || manifest.snapshotBindings.length < 1
    || manifest.snapshotBindings.length > 16
    || !Array.isArray(manifest.desktopRelayTargets)
    || manifest.desktopRelayTargets.length > 6
  ) throw routeConfigurationError('task_regression_evidence_manifest_invalid');
  const seenScenarios = new Set<string>();
  const seenRequestIds = new Set<string>();
  const snapshotBindings = manifest.snapshotBindings.map(value => {
    const binding = exactObject(
      value,
      ['scenarioId', 'phases'],
      'task_regression_evidence_manifest_invalid',
    );
    const scenarioId = String(binding.scenarioId || '');
    if (
      !SAFE_SCENARIO_RE.test(scenarioId)
      || seenScenarios.has(scenarioId)
      || !Array.isArray(binding.phases)
      || binding.phases.length < 1
      || binding.phases.length > 16
    ) throw routeConfigurationError('task_regression_evidence_manifest_invalid');
    seenScenarios.add(scenarioId);
    const seenPhaseIds = new Set<string>();
    const phases = binding.phases.map(value => {
      const phase = exactObject(
        value,
        ['phaseId', 'requestId'],
        'task_regression_evidence_manifest_invalid',
      );
      const phaseId = String(phase.phaseId || '');
      const requestId = String(phase.requestId || '');
      if (
        !SAFE_SCENARIO_RE.test(phaseId)
        || !SAFE_REQUEST_ID_RE.test(requestId)
        || seenPhaseIds.has(phaseId)
        || seenRequestIds.has(requestId)
      ) throw routeConfigurationError('task_regression_evidence_manifest_invalid');
      seenPhaseIds.add(phaseId);
      seenRequestIds.add(requestId);
      return { phaseId, requestId };
    });
    if (scenarioId === CONTROL_STOP_STATUS_REPEAT_SCENARIO) {
      const actual = [...seenPhaseIds].sort();
      const expected = [...CONTROL_SEQUENCE_PHASE_IDS].sort();
      if (
        actual.length !== expected.length
        || actual.some((phaseId, index) => phaseId !== expected[index])
      ) throw routeConfigurationError('task_regression_evidence_control_phases_invalid');
    }
    if (scenarioId === DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO) {
      const actual = [...seenPhaseIds].sort();
      const expected = [...DISPLAYED_RESULT_STALE_RECEIPT_PHASE_IDS].sort();
      if (
        actual.length !== expected.length
        || actual.some((phaseId, index) => phaseId !== expected[index])
      ) throw routeConfigurationError('task_regression_evidence_stale_receipt_phases_invalid');
    }
    if (scenarioId === 'mid_task_restart_recovery') {
      const actual = [...seenPhaseIds].sort();
      const expected = [...MID_TASK_RESTART_RECOVERY_PHASE_IDS].sort();
      if (
        actual.length !== expected.length
        || actual.some((phaseId, index) => phaseId !== expected[index])
      ) throw routeConfigurationError('task_regression_evidence_restart_phases_invalid');
    }
    if (scenarioId === 'wps_wrong_file_correction') {
      const actual = [...seenPhaseIds].sort();
      const expected = [...WPS_WRONG_FILE_CORRECTION_PHASE_IDS].sort();
      if (
        actual.length !== expected.length
        || actual.some((phaseId, index) => phaseId !== expected[index])
      ) throw routeConfigurationError('task_regression_evidence_wps_phases_invalid');
    }
    if (scenarioId === 'voice_to_text_continuation') {
      const actual = [...seenPhaseIds].sort();
      const expected = [...VOICE_TEXT_CONTINUATION_PHASE_IDS].sort();
      if (
        actual.length !== expected.length
        || actual.some((phaseId, index) => phaseId !== expected[index])
      ) throw routeConfigurationError('task_regression_evidence_voice_text_phases_invalid');
    }
    return { scenarioId, phases };
  });
  const seenRelayRelativePaths = new Set<string>();
  const desktopRelayTargets = manifest.desktopRelayTargets.map(value => {
    const target = exactObject(
      value,
      ['scenarioId', 'relativePath', 'contentSha256', 'encoding', 'overwritePolicy'],
      'task_regression_evidence_manifest_invalid',
    );
    const scenarioId = String(target.scenarioId || '');
    const relativePath = String(target.relativePath || '');
    const overwritePolicy = String(target.overwritePolicy || '');
    const readOnlyFixture = overwritePolicy === 'read_only';
    if (
      !seenScenarios.has(scenarioId)
      || seenRelayRelativePaths.has(relativePath.toLowerCase())
      || !(readOnlyFixture
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:pptx?|docx?|xlsx?|pdf|txt|md|csv)$/u.test(relativePath)
        : /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.txt$/u.test(relativePath))
      || relativePath === '.'
      || relativePath === '..'
      || path.basename(relativePath) !== relativePath
      || !SHA256_RE.test(String(target.contentSha256 || ''))
      || !(
        target.encoding === 'utf-8'
        || (readOnlyFixture && target.encoding === 'binary')
      )
      || !['fail_if_exists', 'read_only'].includes(overwritePolicy)
    ) throw routeConfigurationError('task_regression_evidence_manifest_invalid');
    seenRelayRelativePaths.add(relativePath.toLowerCase());
    return Object.freeze({
      scenarioId,
      relativePath,
      contentSha256: String(target.contentSha256),
      encoding: target.encoding as 'utf-8' | 'binary',
      overwritePolicy: overwritePolicy as 'fail_if_exists' | 'read_only',
    });
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
  ) throw routeConfigurationError('task_regression_evidence_wps_semantic_targets_invalid');
  return {
    ...manifest,
    snapshotBindings,
    desktopRelayTargets,
  };
}

function exactEnvironmentPath(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  expected: string,
): void {
  const supplied = String(environment[key] || '');
  if (!supplied || normalizedPath(supplied) !== normalizedPath(expected)) {
    throw routeConfigurationError('task_regression_evidence_runtime_isolation_invalid');
  }
}

/**
 * Resolves the evidence gate once, while the isolated backend starts. No route
 * is mounted when the feature is absent. A partially configured gate aborts
 * startup instead of degrading to an admin-only diagnostic endpoint.
 */
export function resolveTaskRegressionEvidenceRouteConfig(
  options: ResolveConfigOptions = {},
): TaskRegressionEvidenceRouteConfig | null {
  const environment = options.environment || process.env;
  const gateKeys = Object.values(TASK_REGRESSION_EVIDENCE_ENV);
  const configuredKeys = gateKeys.filter(key => String(environment[key] || '').trim());
  if (configuredKeys.length === 0) return null;
  if (
    configuredKeys.length !== gateKeys.length
    || environment[TASK_REGRESSION_EVIDENCE_ENV.mode] !== '1'
  ) throw routeConfigurationError('task_regression_evidence_configuration_incomplete');

  if (
    environment.LUMI_DESKTOP !== '0'
    || environment.LUMI_ENFORCE_DATA_ROOT_LEASE !== '1'
    || environment.HOST !== '127.0.0.1'
  ) throw routeConfigurationError('task_regression_evidence_runtime_mode_invalid');

  const acceptanceRunId = String(environment[TASK_REGRESSION_EVIDENCE_ENV.acceptanceRunId] || '');
  const expectedProofSha256 = String(environment[TASK_REGRESSION_EVIDENCE_ENV.proofSha256] || '').toLowerCase();
  const expectedSttAccessSha256 = String(
    environment[TASK_REGRESSION_EVIDENCE_ENV.sttAccessSha256] || '',
  ).toLowerCase();
  const expectedDesktopRelayProofSha256 = String(
    environment[TASK_REGRESSION_EVIDENCE_ENV.desktopRelayProofSha256] || '',
  ).toLowerCase();
  const expectedSignerBootstrapSha256 = String(
    environment[TASK_REGRESSION_EVIDENCE_ENV.signerBootstrapSha256] || '',
  ).toLowerCase();
  const configuredRunnerPid = Number(environment[TASK_REGRESSION_EVIDENCE_ENV.runnerPid]);
  if (
    !SAFE_ID_RE.test(acceptanceRunId)
    || !SHA256_RE.test(expectedProofSha256)
    || !SHA256_RE.test(expectedSttAccessSha256)
    || !SHA256_RE.test(expectedDesktopRelayProofSha256)
    || !SHA256_RE.test(expectedSignerBootstrapSha256)
    || expectedDesktopRelayProofSha256 === expectedProofSha256
    || expectedSttAccessSha256 === expectedProofSha256
    || expectedSttAccessSha256 === expectedDesktopRelayProofSha256
    || [
      expectedProofSha256,
      expectedSttAccessSha256,
      expectedDesktopRelayProofSha256,
    ].includes(expectedSignerBootstrapSha256)
    || !Number.isSafeInteger(configuredRunnerPid)
    || configuredRunnerPid < 1
  ) {
    throw routeConfigurationError('task_regression_evidence_configuration_invalid');
  }

  const sandboxRoot = safeRealDirectory(
    String(environment[TASK_REGRESSION_EVIDENCE_ENV.sandboxRoot] || ''),
    'task_regression_evidence_sandbox_invalid',
  );
  if (!path.basename(sandboxRoot).startsWith('lumi-task-regression-')) {
    throw routeConfigurationError('task_regression_evidence_sandbox_invalid');
  }
  const currentDataRoot = safeRealDirectory(
    options.currentDataRoot || getDataRoot(),
    'task_regression_evidence_data_root_invalid',
  );
  const expectedDataRoot = path.join(sandboxRoot, 'data-root');
  if (
    normalizedPath(currentDataRoot) !== normalizedPath(expectedDataRoot)
    || !pathInside(sandboxRoot, currentDataRoot)
  ) throw routeConfigurationError('task_regression_evidence_data_root_invalid');

  exactEnvironmentPath(environment, 'LUMI_DATA_DIR', currentDataRoot);
  exactEnvironmentPath(environment, 'HOME', path.join(sandboxRoot, 'home'));
  exactEnvironmentPath(environment, 'USERPROFILE', path.join(sandboxRoot, 'home'));
  exactEnvironmentPath(environment, 'APPDATA', path.join(sandboxRoot, 'appdata'));
  exactEnvironmentPath(environment, 'LOCALAPPDATA', path.join(sandboxRoot, 'localappdata'));
  exactEnvironmentPath(environment, 'TEMP', path.join(sandboxRoot, 'tmp'));
  exactEnvironmentPath(environment, 'TMP', path.join(sandboxRoot, 'tmp'));
  exactEnvironmentPath(environment, 'DOTENV_CONFIG_PATH', path.join(sandboxRoot, 'empty.env'));
  exactEnvironmentPath(environment, 'LUMI_LOG_FILE', path.join(sandboxRoot, 'logs', 'backend.log'));
  exactEnvironmentPath(environment, 'LUMI_RUNTIME_META_FILE', path.join(sandboxRoot, 'logs', 'runtime-meta.json'));

  for (const directory of ['home', 'appdata', 'localappdata', 'tmp', 'logs']) {
    const resolved = safeRealDirectory(
      path.join(sandboxRoot, directory),
      'task_regression_evidence_runtime_isolation_invalid',
    );
    if (!pathInside(sandboxRoot, resolved)) {
      throw routeConfigurationError('task_regression_evidence_runtime_isolation_invalid');
    }
  }
  const dotenvPath = path.join(sandboxRoot, 'empty.env');
  const dotenvMetadata = safeRegularFile(
    dotenvPath,
    'task_regression_evidence_runtime_isolation_invalid',
    0,
  );
  if (dotenvMetadata.size !== 0) {
    throw routeConfigurationError('task_regression_evidence_runtime_isolation_invalid');
  }
  const migrationMarker = path.join(currentDataRoot, 'data', '.migration_skip');
  const migrationMetadata = safeRegularFile(
    migrationMarker,
    'task_regression_evidence_data_root_invalid',
    0,
  );
  if (migrationMetadata.size !== 0) {
    throw routeConfigurationError('task_regression_evidence_data_root_invalid');
  }

  const manifest = readIsolationManifest(path.join(sandboxRoot, TASK_REGRESSION_ISOLATION_MANIFEST));
  const nowMs = options.nowMs ?? Date.now();
  const createdAtMs = Date.parse(manifest.createdAt);
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (manifest.acceptanceRunId !== acceptanceRunId) {
    throw routeConfigurationError('task_regression_evidence_manifest_run_binding_invalid');
  }
  // tsx may insert a short-lived launcher between the runner and the server,
  // so direct PPID equality is not portable. The runner PID is instead bound
  // into both the exclusive manifest and the child-only sanitized environment;
  // the plaintext HTTP proof is deliberately absent from that environment.
  if (manifest.runnerPid !== configuredRunnerPid) {
    throw routeConfigurationError('task_regression_evidence_manifest_process_binding_invalid');
  }
  if (manifest.proofSha256 !== expectedProofSha256) {
    throw routeConfigurationError('task_regression_evidence_manifest_proof_binding_invalid');
  }
  if (manifest.sttCredentialSha256 !== expectedSttAccessSha256) {
    throw routeConfigurationError('task_regression_evidence_manifest_stt_binding_invalid');
  }
  if (manifest.desktopRelayProofSha256 !== expectedDesktopRelayProofSha256) {
    throw routeConfigurationError('task_regression_evidence_manifest_desktop_relay_proof_binding_invalid');
  }
  if (manifest.signerBootstrapSha256 !== expectedSignerBootstrapSha256) {
    throw routeConfigurationError('task_regression_evidence_manifest_signer_bootstrap_binding_invalid');
  }
  if (manifest.sandboxRootSha256 !== sha256(normalizedPath(sandboxRoot))) {
    throw routeConfigurationError('task_regression_evidence_manifest_sandbox_binding_invalid');
  }
  if (manifest.dataRootSha256 !== sha256(normalizedPath(currentDataRoot))) {
    throw routeConfigurationError('task_regression_evidence_manifest_data_binding_invalid');
  }
  const artifactsRoot = safeRealDirectory(
    path.join(sandboxRoot, 'home', 'Desktop'),
    'task_regression_evidence_desktop_relay_artifacts_invalid',
  );
  if (
    !pathInside(sandboxRoot, artifactsRoot)
    || normalizedPath(artifactsRoot) !== normalizedPath(path.join(sandboxRoot, 'home', 'Desktop'))
    || manifest.desktopRelayArtifactsRootSha256 !== sha256(normalizedPath(artifactsRoot))
  ) throw routeConfigurationError('task_regression_evidence_desktop_relay_artifacts_invalid');
  if (
    createdAtMs > nowMs + MANIFEST_FUTURE_SKEW_MS
    || nowMs - createdAtMs > MANIFEST_STARTUP_MAX_AGE_MS
    || expiresAtMs <= nowMs
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > EVIDENCE_RUN_MAX_LIFETIME_MS
  ) throw routeConfigurationError('task_regression_evidence_manifest_time_binding_invalid');

  const guardedDirectories = [
    sandboxRoot,
    currentDataRoot,
    ...['home', 'appdata', 'localappdata', 'tmp', 'logs'].map(directory => (
      path.join(sandboxRoot, directory)
    )),
    artifactsRoot,
  ].map(directory => {
    const metadata = fs.lstatSync(directory);
    return {
      directory,
      canonical: normalizedPath(fs.realpathSync.native(directory)),
      dev: metadata.dev,
      ino: metadata.ino,
    };
  });
  const guardedFiles = [
    { filename: path.join(sandboxRoot, TASK_REGRESSION_ISOLATION_MANIFEST), diagnosticKind: 'manifest' },
    { filename: dotenvPath, diagnosticKind: 'dotenv' },
    { filename: migrationMarker, diagnosticKind: 'migration_marker' },
    ...manifest.desktopRelayTargets
      .filter(target => target.overwritePolicy === 'read_only')
      .map(target => ({
        filename: path.join(artifactsRoot, target.relativePath),
        diagnosticKind: 'read_only_fixture',
      })),
  ].map(({ filename, diagnosticKind }) => {
    const metadata = safeRegularFile(
      filename,
      'task_regression_evidence_runtime_identity_changed',
      100 * 1024,
    );
    const digest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    const fixture = manifest.desktopRelayTargets.find(target => (
      target.overwritePolicy === 'read_only'
      && normalizedPath(path.join(artifactsRoot, target.relativePath)) === normalizedPath(filename)
    ));
    if (fixture && digest !== fixture.contentSha256) {
      throw routeConfigurationError('task_regression_evidence_runtime_identity_changed');
    }
    return {
      filename,
      canonical: normalizedPath(fs.realpathSync.native(filename)),
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      sha256: digest,
      diagnosticKind,
    };
  });

  const assertRuntimeIsolation = (): void => {
    for (const expected of guardedDirectories) {
      const canonical = safeRealDirectory(
        expected.directory,
        'task_regression_evidence_runtime_directory_identity_changed',
      );
      const metadata = fs.lstatSync(expected.directory);
      if (
        normalizedPath(canonical) !== expected.canonical
        || metadata.dev !== expected.dev
        || metadata.ino !== expected.ino
      ) throw routeConfigurationError('task_regression_evidence_runtime_directory_identity_changed');
    }
    for (const expected of guardedFiles) {
      const metadata = safeRegularFile(
        expected.filename,
        `task_regression_evidence_runtime_${expected.diagnosticKind}_identity_changed`,
        expected.diagnosticKind === 'read_only_fixture'
          ? 100 * 1024
          : MANIFEST_MAX_BYTES,
      );
      const digest = crypto.createHash('sha256').update(fs.readFileSync(expected.filename)).digest('hex');
      if (
        normalizedPath(fs.realpathSync.native(expected.filename)) !== expected.canonical
        || metadata.dev !== expected.dev
        || metadata.ino !== expected.ino
        || metadata.size !== expected.size
        || digest !== expected.sha256
      ) throw routeConfigurationError(
        `task_regression_evidence_runtime_${expected.diagnosticKind}_identity_changed`,
      );
    }
  };

  const dataRootIdentitySha256 = portableDataRootIdentitySha256(currentDataRoot);
  const attester = createVoiceTextContinuationTruthAttester({
    acceptanceRunId,
    buildIdentityDigest: manifest.buildIdentityDigest,
    dataRootIdentitySha256,
  });
  const config: TaskRegressionEvidenceRouteConfig = {
    acceptanceRunId,
    proofSha256: expectedProofSha256,
    signerBootstrapSha256: expectedSignerBootstrapSha256,
    sttAccessSha256: expectedSttAccessSha256,
    sandboxId: manifest.sandboxId,
    expiresAtMs,
    buildIdentityDigest: manifest.buildIdentityDigest,
    dataRootIdentitySha256,
    serverTruthSigner: attester.descriptor,
    snapshotBindings: Object.freeze([...manifest.snapshotBindings]),
    desktopRelay: Object.freeze({
      proofSha256: manifest.desktopRelayProofSha256,
      artifactsRoot,
      targets: Object.freeze(manifest.desktopRelayTargets.map(target => Object.freeze({
        ...target,
        absolutePath: path.join(artifactsRoot, target.relativePath),
      }))),
    }),
    assertRuntimeIsolation,
  };
  serverTruthAttesters.set(config, attester);
  return config;
}

function proofMatches(value: unknown, expectedSha256: string): boolean {
  const supplied = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_PROOF_RE.test(supplied)) return false;
  const actual = Buffer.from(sha256(supplied), 'hex');
  const expected = Buffer.from(expectedSha256, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requestString(
  body: Record<string, unknown>,
  key: string,
  pattern: RegExp = SAFE_ID_RE,
): string | null {
  const value = body[key];
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) return null;
  return value;
}

function safeCaptureErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^(?:task_truth_snapshot|voice_text_truth)_[a-z0-9_]+$/u.test(value)
    ? value
    : 'task_truth_snapshot_capture_failed';
}

function safeStaleReceiptErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^task_regression_stale_[a-z0-9_]+$/u.test(value)
    ? value
    : 'task_regression_stale_reclassification_failed';
}

function manifestRepresentativeReceiptTool(
  scenarioId: string,
  phaseId: string,
): string | undefined {
  if (scenarioId === 'voice_to_text_continuation' && phaseId === 'text_continue') {
    return 'read_file';
  }
  if (scenarioId !== 'wps_wrong_file_correction') return undefined;
  if (phaseId === 'anchor') return 'desktop_active_window';
  if (phaseId === 'supply-filename') return 'extract_document_text';
  return undefined;
}

interface ServerTruthSignerBootstrapState {
  consumed: boolean;
}

function createServerTruthSignerHandler(
  config: TaskRegressionEvidenceRouteConfig,
  bootstrapState: ServerTruthSignerBootstrapState,
): RequestHandler {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (Date.now() >= config.expiresAtMs) {
      res.status(403).json({ error: 'Isolated regression signer bootstrap expired' });
      return;
    }
    try {
      config.assertRuntimeIsolation();
    } catch {
      res.status(503).json({ error: 'Isolated regression boundary unavailable' });
      return;
    }
    if (bootstrapState.consumed) {
      res.status(409).json({ error: 'Isolated regression signer already bootstrapped' });
      return;
    }
    if (!proofMatches(
      req.headers[TASK_REGRESSION_SIGNER_BOOTSTRAP_HEADER],
      config.signerBootstrapSha256,
    )) {
      res.status(403).json({ error: 'Isolated regression signer bootstrap required' });
      return;
    }
    const body = req.body;
    const actualKeys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];
    const acceptanceRunId = body && typeof body === 'object' && !Array.isArray(body)
      ? requestString(body as Record<string, unknown>, 'acceptanceRunId')
      : null;
    if (
      actualKeys.length !== 1
      || actualKeys[0] !== 'acceptanceRunId'
      || acceptanceRunId !== config.acceptanceRunId
    ) {
      res.status(400).json({ error: 'Invalid isolated regression signer selector' });
      return;
    }
    bootstrapState.consumed = true;
    res.json({
      kind: 'lumi.task-regression-server-truth-signer-info',
      schemaVersion: 1,
      signer: config.serverTruthSigner,
    });
  };
}

function createSnapshotHandler(
  config: TaskRegressionEvidenceRouteConfig,
  attester: VoiceTextContinuationTruthAttester,
  bootstrapState: ServerTruthSignerBootstrapState,
  capture: (
    input: CaptureTaskTruthSnapshotInput | CaptureControlSequenceTruthSnapshotInput,
  ) => Promise<TaskTruthSnapshot | ControlSequenceTruthSnapshot>,
  captureVoiceTextContinuation: (
    input: CaptureVoiceTextContinuationTruthInput,
  ) => Promise<VoiceTextContinuationTruth>,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (Date.now() >= config.expiresAtMs) {
      res.status(403).json({ error: 'Isolated regression proof expired' });
      return;
    }
    try {
      config.assertRuntimeIsolation();
    } catch {
      res.status(503).json({ error: 'Isolated regression boundary unavailable' });
      return;
    }
    if (!proofMatches(req.headers[TASK_REGRESSION_PROOF_HEADER], config.proofSha256)) {
      res.status(403).json({ error: 'Isolated regression proof required' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid task regression snapshot selector' });
      return;
    }
    const commonKeys = [
      'acceptanceRunId',
      'conversationId',
      'requestId',
    ];
    const actualKeys = Object.keys(body).sort();
    const requestId = requestString(body, 'requestId', SAFE_REQUEST_ID_RE);
    const snapshotBinding = requestId
      ? config.snapshotBindings.find(binding => binding.phases.some(phase => phase.requestId === requestId)) || null
      : null;
    const snapshotPhase = requestId
      ? snapshotBinding?.phases.find(phase => phase.requestId === requestId) || null
      : null;
    const isControlSequence = snapshotBinding?.scenarioId === CONTROL_STOP_STATUS_REPEAT_SCENARIO;
    const allowedKeys = isControlSequence ? commonKeys : [...commonKeys, 'taskId'];
    if (
      actualKeys.length !== allowedKeys.length
      || actualKeys.some((key, index) => key !== [...allowedKeys].sort()[index])
    ) {
      res.status(400).json({ error: 'Invalid task regression snapshot selector' });
      return;
    }
    const acceptanceRunId = requestString(body, 'acceptanceRunId');
    const conversationId = requestString(body, 'conversationId');
    const taskId = isControlSequence ? null : requestString(body, 'taskId');
    const scenarioId = snapshotBinding?.scenarioId || null;
    const representativeReceiptTool = scenarioId && snapshotPhase
      ? manifestRepresentativeReceiptTool(scenarioId, snapshotPhase.phaseId)
      : undefined;
    const longRequestId = snapshotBinding?.phases.find(phase => phase.phaseId === 'long')?.requestId || null;
    if (
      !scenarioId
      || !acceptanceRunId
      || acceptanceRunId !== config.acceptanceRunId
      || !conversationId
      || !requestId
      || (isControlSequence ? requestId !== longRequestId : !taskId)
    ) {
      res.status(400).json({ error: 'Invalid task regression snapshot selector' });
      return;
    }
    if (scenarioId === 'voice_to_text_continuation' && !bootstrapState.consumed) {
      res.status(409).json({ error: 'Server truth signer must be pinned before S6 capture' });
      return;
    }
    try {
      const common = {
        scenarioId,
        acceptanceRunId,
        buildIdentityDigest: config.buildIdentityDigest,
        userId: req.user!.uid,
        conversationId,
        requestId,
      };
      const snapshot = isControlSequence
        ? await capture({
          ...common,
          phaseRequestIds: Object.fromEntries(
            snapshotBinding!.phases.map(phase => [phase.phaseId, phase.requestId]),
          ) as CaptureControlSequenceTruthSnapshotInput['phaseRequestIds'],
        })
        : await capture({
          ...common,
          taskId: taskId!,
          ...(representativeReceiptTool ? { receiptToolName: representativeReceiptTool } : {}),
        });
      const voiceTextContinuation = scenarioId === 'voice_to_text_continuation'
        ? await captureVoiceTextContinuation({
          scenarioId,
          acceptanceRunId,
          buildIdentityDigest: config.buildIdentityDigest,
          userId: req.user!.uid,
          conversationId,
          textRequestId: requestId,
          taskId: taskId!,
        })
        : undefined;
      const voiceTextContinuationEnvelope: VoiceTextContinuationTruthEnvelope | undefined =
        voiceTextContinuation
          ? attester.attest(voiceTextContinuation)
          : undefined;
      res.json({
        snapshot,
        ...(voiceTextContinuation ? { voiceTextContinuation } : {}),
        ...(voiceTextContinuationEnvelope ? { voiceTextContinuationEnvelope } : {}),
      });
    } catch (error) {
      res.status(409).json({
        error: 'Task truth snapshot could not be derived from runtime evidence',
        code: safeCaptureErrorCode(error),
      });
    }
  };
}

function createStaleReceiptHandler(
  config: TaskRegressionEvidenceRouteConfig,
  reclassify: (
    input: ReclassifyManifestBoundStaleReceiptInput,
  ) => Promise<TaskRegressionStaleReceiptEvidence>,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (Date.now() >= config.expiresAtMs) {
      res.status(403).json({ error: 'Isolated regression proof expired' });
      return;
    }
    try {
      config.assertRuntimeIsolation();
    } catch {
      res.status(503).json({ error: 'Isolated regression boundary unavailable' });
      return;
    }
    if (!proofMatches(req.headers[TASK_REGRESSION_PROOF_HEADER], config.proofSha256)) {
      res.status(403).json({ error: 'Isolated regression proof required' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid stale receipt reclassification selector' });
      return;
    }
    const allowedKeys = ['acceptanceRunId', 'conversationId'];
    const actualKeys = Object.keys(body).sort();
    const acceptanceRunId = requestString(body, 'acceptanceRunId');
    const conversationId = requestString(body, 'conversationId');
    const binding = config.snapshotBindings.find(candidate => (
      candidate.scenarioId === DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO
    )) || null;
    const displayRequestId = binding?.phases.find(phase => phase.phaseId === 'display')?.requestId || '';
    const continueRequestId = binding?.phases.find(phase => phase.phaseId === 'continue')?.requestId || '';
    if (
      actualKeys.length !== allowedKeys.length
      || actualKeys.some((key, index) => key !== [...allowedKeys].sort()[index])
      || !acceptanceRunId
      || acceptanceRunId !== config.acceptanceRunId
      || !conversationId
      || !displayRequestId
      || !continueRequestId
      || displayRequestId === continueRequestId
    ) {
      res.status(400).json({ error: 'Invalid stale receipt reclassification selector' });
      return;
    }
    try {
      const evidence = await reclassify({
        acceptanceRunId,
        buildIdentityDigest: config.buildIdentityDigest,
        scenarioId: DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO,
        userId: req.user!.uid,
        conversationId,
        displayRequestId,
        continueRequestId,
      });
      res.json({ evidence });
    } catch (error) {
      res.status(409).json({
        error: 'Stale receipt evidence could not be derived from runtime records',
        code: safeStaleReceiptErrorCode(error),
      });
    }
  };
}

/** Mounts no public surface unless the complete isolated-runner proof exists. */
export function mountTaskRegressionEvidenceRoutes(
  router: Router,
  options: MountOptions = {},
): boolean {
  const config = resolveTaskRegressionEvidenceRouteConfig(options);
  if (!config) {
    if (!options.environment) activeSyntheticVoiceBinding = null;
    return false;
  }
  const attester = serverTruthAttesters.get(config);
  if (!attester) throw routeConfigurationError('task_regression_evidence_signer_unavailable');
  const signerBootstrapState: ServerTruthSignerBootstrapState = { consumed: false };
  if (!options.environment) {
    activeSyntheticVoiceBinding = {
      value: Object.freeze({
        acceptanceRunId: config.acceptanceRunId,
        sandboxId: config.sandboxId,
        buildIdentityDigest: config.buildIdentityDigest,
        sttAccessSha256: config.sttAccessSha256,
      }),
      expiresAtMs: config.expiresAtMs,
      assertRuntimeIsolation: config.assertRuntimeIsolation,
    };
  }
  router.post(
    TASK_REGRESSION_SERVER_TRUTH_SIGNER_PATH,
    requireAuth,
    requireAdmin,
    requireLocalRequest,
    createServerTruthSignerHandler(config, signerBootstrapState),
  );
  router.post(
    TASK_REGRESSION_SNAPSHOT_PATH,
    requireAuth,
    requireAdmin,
    requireLocalRequest,
    createSnapshotHandler(config, attester, signerBootstrapState, options.capture || (input => (
      input.scenarioId === CONTROL_STOP_STATUS_REPEAT_SCENARIO
        ? captureControlSequenceTruthSnapshot(input as CaptureControlSequenceTruthSnapshotInput)
        : captureTaskTruthSnapshot(input as CaptureTaskTruthSnapshotInput)
    )), options.captureVoiceTextContinuation || captureVoiceTextContinuationTruth),
  );
  router.post(
    TASK_REGRESSION_STALE_RECEIPT_PATH,
    requireAuth,
    requireAdmin,
    requireLocalRequest,
    createStaleReceiptHandler(
      config,
      options.reclassifyStaleReceipt || reclassifyManifestBoundStaleReceipt,
    ),
  );
  return true;
}
