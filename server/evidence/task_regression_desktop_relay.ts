import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Socket } from 'socket.io';
import { isLoopbackAddress } from '../config/local_identity';
import {
  resolveTaskRegressionEvidenceRouteConfig,
  type TaskRegressionEvidenceRouteConfig,
  type TaskRegressionDesktopRelayTarget,
} from './task_truth_snapshot_route';

const DESKTOP_WRITE_TOOL = 'desktop_write_text_file' as const;
const WPS_SCENARIO = 'wps_wrong_file_correction' as const;
const WPS_SEMANTIC_TOOLS = new Set([
  'desktop_active_window',
  'desktop_list_files',
]);
const PROOF_AUTH_FIELD = 'taskRegressionDesktopRelayProof' as const;
const SAFE_PROOF_RE = /^[A-Za-z0-9_-]{43,256}$/u;
const MAX_TEXT_FILE_BYTES = 500 * 1024;
const EXACT_WRITE_KEYS = Object.freeze([
  'content',
  'encoding',
  'overwritePolicy',
  'path',
]);

interface AuthorizedRelayTarget {
  target: Readonly<TaskRegressionDesktopRelayTarget>;
  identity: {
    dev: number;
    ino: number;
    size: number;
  };
  receipt: TaskRegressionDesktopWriteReceipt;
}

interface AuthorizedRelay {
  config: TaskRegressionEvidenceRouteConfig;
  runState: AuthorizedRelayRunState;
}

interface AuthorizedRelayRunState {
  configIdentity: string;
  expiresAtMs: number;
  ownedTargets: Map<string, AuthorizedRelayTarget>;
}

export interface TaskRegressionSocketIdentity {
  uid: string;
  role: string;
}

export interface AuthorizeTaskRegressionDesktopRelayOptions {
  config?: TaskRegressionEvidenceRouteConfig | null;
  nowMs?: number;
}

export interface TaskRegressionDesktopWriteReceipt {
  success: true;
  path: string;
  bytesWritten: number;
  encoding: 'utf-8';
  overwritePolicy: 'fail_if_exists';
  overwritten: false;
  readBackMatched: true;
}

interface ManifestRequestBinding {
  scenarioId: string;
  phaseId: string;
}

const authorizedSockets = new WeakMap<object, AuthorizedRelay>();
const authorizedRuns = new Map<string, AuthorizedRelayRunState>();

function relayError(code: string): Error {
  const error = new Error(code);
  error.name = 'TaskRegressionDesktopRelayError';
  return error;
}

function normalizedPath(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function relayConfigIdentity(config: TaskRegressionEvidenceRouteConfig): string {
  return sha256(JSON.stringify({
    acceptanceRunId: config.acceptanceRunId,
    buildIdentityDigest: config.buildIdentityDigest,
    desktopRelay: {
      artifactsRoot: normalizedPath(config.desktopRelay.artifactsRoot),
      proofSha256: config.desktopRelay.proofSha256,
      targets: config.desktopRelay.targets.map(target => ({
        absolutePath: normalizedPath(target.absolutePath),
        contentSha256: target.contentSha256,
        encoding: target.encoding,
        overwritePolicy: target.overwritePolicy,
        relativePath: target.relativePath,
        scenarioId: target.scenarioId,
      })),
    },
    expiresAtMs: config.expiresAtMs,
    sandboxId: config.sandboxId,
    snapshotBindings: config.snapshotBindings.map(binding => ({
      scenarioId: binding.scenarioId,
      phases: binding.phases.map(phase => ({
        phaseId: phase.phaseId,
        requestId: phase.requestId,
      })),
    })),
  }));
}

function getOrCreateRunState(config: TaskRegressionEvidenceRouteConfig, nowMs: number): AuthorizedRelayRunState {
  for (const [sandboxId, state] of authorizedRuns) {
    if (nowMs >= state.expiresAtMs) authorizedRuns.delete(sandboxId);
  }
  const configIdentity = relayConfigIdentity(config);
  const existing = authorizedRuns.get(config.sandboxId);
  if (existing) {
    if (existing.configIdentity !== configIdentity || existing.expiresAtMs !== config.expiresAtMs) {
      throw relayError('task_regression_desktop_relay_authorization_failed');
    }
    return existing;
  }
  const created: AuthorizedRelayRunState = {
    configIdentity,
    expiresAtMs: config.expiresAtMs,
    ownedTargets: new Map(),
  };
  authorizedRuns.set(config.sandboxId, created);
  return created;
}

function proofMatches(value: unknown, expectedSha256: string): boolean {
  const supplied = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_PROOF_RE.test(supplied) || !/^[a-f0-9]{64}$/u.test(expectedSha256)) return false;
  const actual = Buffer.from(sha256(supplied), 'hex');
  const expected = Buffer.from(expectedSha256, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function realSocketAddress(socket: Socket | any): string {
  // Do not consult Forwarded/X-Forwarded-For or caller-owned handshake fields.
  return String(socket?.request?.socket?.remoteAddress || '');
}

function exactWriteArguments(value: unknown): {
  path: string;
  content: string;
  encoding: 'utf-8';
  overwritePolicy: 'fail_if_exists';
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw relayError('task_regression_desktop_relay_arguments_invalid');
  }
  const row = value as Record<string, unknown>;
  const actualKeys = Object.keys(row).sort();
  if (
    actualKeys.length !== EXACT_WRITE_KEYS.length
    || actualKeys.some((key, index) => key !== [...EXACT_WRITE_KEYS].sort()[index])
    || typeof row.path !== 'string'
    || !row.path
    || row.path !== row.path.trim()
    || row.path.length > 2_048
    || /[\u0000-\u001f\u007f]/u.test(row.path)
    || !path.isAbsolute(row.path)
    || typeof row.content !== 'string'
    || Buffer.byteLength(row.content, 'utf8') > MAX_TEXT_FILE_BYTES
    || row.encoding !== 'utf-8'
    || row.overwritePolicy !== 'fail_if_exists'
  ) throw relayError('task_regression_desktop_relay_arguments_invalid');
  return {
    path: row.path,
    content: row.content,
    encoding: 'utf-8',
    overwritePolicy: 'fail_if_exists',
  };
}

function exactSemanticObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw relayError('task_regression_desktop_relay_arguments_invalid');
  }
  const row = value as Record<string, unknown>;
  const actualKeys = Object.keys(row).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length
    || actualKeys.some((key, index) => key !== sortedExpected[index])
  ) throw relayError('task_regression_desktop_relay_arguments_invalid');
  return row;
}

function manifestBindingForRequest(
  authorization: AuthorizedRelay,
  requestId: string,
): ManifestRequestBinding {
  const matches = authorization.config.snapshotBindings.flatMap(binding => (
    binding.phases
      .filter(phase => phase.requestId === requestId)
      .map(phase => ({ scenarioId: binding.scenarioId, phaseId: phase.phaseId }))
  ));
  if (matches.length !== 1) {
    throw relayError('task_regression_desktop_relay_request_binding_invalid');
  }
  return matches[0];
}

function wpsReadOnlyTargets(
  authorization: AuthorizedRelay,
): ReadonlyArray<Readonly<TaskRegressionDesktopRelayTarget>> {
  const targets = authorization.config.desktopRelay.targets.filter(target => (
    target.scenarioId === WPS_SCENARIO
    && target.overwritePolicy === 'read_only'
  ));
  if (targets.length !== 2) {
    throw relayError('task_regression_desktop_relay_wps_fixture_invalid');
  }
  return targets;
}

function verifiedReadOnlyFixture(
  target: Readonly<TaskRegressionDesktopRelayTarget>,
): { stats: fs.Stats; bytes: Buffer } {
  const observed = verifySafeTargetFile(target.absolutePath);
  if (
    observed.bytes.length > 100 * 1024
    || sha256(observed.bytes) !== target.contentSha256
  ) throw relayError('task_regression_desktop_relay_wps_fixture_invalid');
  return observed;
}

function executeWpsSemanticRelay(
  authorization: AuthorizedRelay,
  toolName: string,
  rawArguments: unknown,
  binding: ManifestRequestBinding,
): string {
  if (binding.scenarioId !== WPS_SCENARIO) {
    throw relayError('task_regression_desktop_relay_request_binding_invalid');
  }
  const targets = wpsReadOnlyTargets(authorization);
  const wrongTarget = targets[0];

  if (toolName === 'desktop_active_window') {
    exactSemanticObject(rawArguments, []);
    if (!['anchor', 'supply-filename'].includes(binding.phaseId)) {
      throw relayError('task_regression_desktop_relay_request_binding_invalid');
    }
    verifiedReadOnlyFixture(wrongTarget);
    return JSON.stringify({
      ok: true,
      status: 'observed',
      title: `${wrongTarget.relativePath} - WPS Office`,
      processName: 'wps.exe',
      processId: 4242,
      documentName: wrongTarget.relativePath,
      path: '',
      currentDocument: {
        name: wrongTarget.relativePath,
        path: null,
        pathStatus: 'unknown',
        source: 'active_window_title',
      },
      evidenceSource: 'isolated_manifest_bound_semantic_relay',
    });
  }

  if (toolName === 'desktop_list_files') {
    const args = exactSemanticObject(rawArguments, ['limit', 'path']);
    if (
      binding.phaseId !== 'supply-filename'
      || args.path !== '~/Desktop'
      || args.limit !== 100
    ) throw relayError('task_regression_desktop_relay_arguments_invalid');
    return JSON.stringify({
      success: true,
      path: '~/Desktop',
      entries: targets.map(target => {
        const observed = verifiedReadOnlyFixture(target);
        return {
          name: target.relativePath,
          path: target.absolutePath,
          type: 'file',
          size: observed.stats.size,
          modifiedAt: observed.stats.mtime.toISOString(),
        };
      }),
      evidenceSource: 'isolated_manifest_bound_semantic_relay',
    });
  }

  throw relayError('task_regression_desktop_relay_unavailable');
}

function verifySafeTargetFile(
  targetPath: string,
  expectedIdentity?: AuthorizedRelayTarget['identity'],
): { stats: fs.Stats; bytes: Buffer } {
  let stats: fs.Stats;
  let canonical: string;
  try {
    stats = fs.lstatSync(targetPath);
    canonical = fs.realpathSync.native(targetPath);
  } catch {
    throw relayError('task_regression_desktop_relay_target_identity_invalid');
  }
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || normalizedPath(canonical) !== normalizedPath(targetPath)
    || (expectedIdentity && (
      stats.dev !== expectedIdentity.dev
      || stats.ino !== expectedIdentity.ino
      || stats.size !== expectedIdentity.size
    ))
  ) throw relayError('task_regression_desktop_relay_target_identity_invalid');
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(targetPath);
  } catch {
    throw relayError('task_regression_desktop_relay_read_back_failed');
  }
  return { stats, bytes };
}

function assertArtifactsDirectory(config: TaskRegressionEvidenceRouteConfig): void {
  try {
    config.assertRuntimeIsolation();
  } catch (error) {
    const evidenceCode = error instanceof Error ? error.message : '';
    const match = evidenceCode.match(
      /^task_regression_evidence_runtime_(directory|manifest|dotenv|migration_marker|read_only_fixture)_identity_changed$/u,
    );
    throw relayError(match
      ? `task_regression_desktop_relay_${match[1]}_identity_changed`
      : 'task_regression_desktop_relay_manifest_identity_changed');
  }
  const artifactsRoot = config.desktopRelay.artifactsRoot;
  let stats: fs.Stats;
  let canonical: string;
  try {
    stats = fs.lstatSync(artifactsRoot);
    canonical = fs.realpathSync.native(artifactsRoot);
  } catch {
    throw relayError('task_regression_desktop_relay_artifacts_invalid');
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || normalizedPath(canonical) !== normalizedPath(artifactsRoot)
  ) throw relayError('task_regression_desktop_relay_artifacts_invalid');
}

/**
 * Binds an ephemeral semantic relay to one authenticated Socket.IO connection.
 * No native device is registered and no plaintext proof is stored in the child
 * environment or isolation manifest.
 */
export function authorizeTaskRegressionDesktopRelaySocket(
  socket: Socket | any,
  identity: TaskRegressionSocketIdentity,
  options: AuthorizeTaskRegressionDesktopRelayOptions = {},
): boolean {
  const presentedProof = String(socket?.handshake?.auth?.[PROOF_AUTH_FIELD] || '').trim();
  if (!presentedProof) return false;
  const config = options.config === undefined
    ? resolveTaskRegressionEvidenceRouteConfig()
    : options.config;
  const nowMs = options.nowMs ?? Date.now();
  if (
    !config
    || identity?.role !== 'admin'
    || !identity?.uid
    || socket?.data?.authenticatedUserId !== identity.uid
    || !isLoopbackAddress(realSocketAddress(socket))
    || nowMs >= config.expiresAtMs
    || !proofMatches(presentedProof, config.desktopRelay.proofSha256)
  ) throw relayError('task_regression_desktop_relay_authorization_failed');
  try {
    assertArtifactsDirectory(config);
  } catch (error) {
    if (error instanceof Error && error.name === 'TaskRegressionDesktopRelayError') throw error;
    throw relayError('task_regression_desktop_relay_runtime_identity_invalid');
  }
  // Retain only the manifest-bound authorization object; the plaintext proof
  // is one-use handshake material and is not needed by later tool calls.
  try { delete socket.handshake.auth[PROOF_AUTH_FIELD]; } catch {}
  const runState = getOrCreateRunState(config, nowMs);
  authorizedSockets.set(socket, { config, runState });
  if (typeof socket.once === 'function') {
    socket.once('disconnect', () => authorizedSockets.delete(socket));
  }
  return true;
}

export function hasTaskRegressionDesktopRelayAuthorization(socket?: Socket | null): boolean {
  return Boolean(socket && authorizedSockets.has(socket));
}

function validateIdempotentReplay(
  owned: AuthorizedRelayTarget,
  requestedBytes: Buffer,
): TaskRegressionDesktopWriteReceipt {
  const observed = verifySafeTargetFile(owned.target.absolutePath, owned.identity);
  if (
    observed.bytes.length !== requestedBytes.length
    || !crypto.timingSafeEqual(observed.bytes, requestedBytes)
  ) throw relayError('task_regression_desktop_relay_owned_target_changed');
  return owned.receipt;
}

function createOwnedTarget(
  authorization: AuthorizedRelay,
  target: Readonly<TaskRegressionDesktopRelayTarget>,
  bytes: Buffer,
): TaskRegressionDesktopWriteReceipt {
  let fd: number | null = null;
  let createdIdentity: { dev: number; ino: number; size: number } | null = null;
  try {
    let flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR;
    if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW;
    fd = fs.openSync(target.absolutePath, flags, 0o600);
    const created = fs.fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1 || created.size !== 0) {
      throw relayError('task_regression_desktop_relay_created_target_invalid');
    }
    createdIdentity = { dev: created.dev, ino: created.ino, size: 0 };
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written < 1) throw relayError('task_regression_desktop_relay_write_failed');
      offset += written;
    }
    fs.fsyncSync(fd);
    const afterWrite = fs.fstatSync(fd);
    if (
      !afterWrite.isFile()
      || afterWrite.nlink !== 1
      || afterWrite.dev !== created.dev
      || afterWrite.ino !== created.ino
      || afterWrite.size !== bytes.length
    ) throw relayError('task_regression_desktop_relay_created_target_invalid');
    const readBack = Buffer.alloc(bytes.length);
    let readOffset = 0;
    while (readOffset < readBack.length) {
      const count = fs.readSync(fd, readBack, readOffset, readBack.length - readOffset, readOffset);
      if (count < 1) throw relayError('task_regression_desktop_relay_read_back_failed');
      readOffset += count;
    }
    if (readBack.length !== bytes.length || !crypto.timingSafeEqual(readBack, bytes)) {
      throw relayError('task_regression_desktop_relay_read_back_mismatch');
    }
    fs.closeSync(fd);
    fd = null;

    const pathObservation = verifySafeTargetFile(target.absolutePath, {
      dev: afterWrite.dev,
      ino: afterWrite.ino,
      size: bytes.length,
    });
    if (
      pathObservation.bytes.length !== bytes.length
      || !crypto.timingSafeEqual(pathObservation.bytes, bytes)
    ) throw relayError('task_regression_desktop_relay_read_back_mismatch');
    const receipt: TaskRegressionDesktopWriteReceipt = Object.freeze({
      success: true,
      path: target.absolutePath,
      bytesWritten: bytes.length,
      encoding: 'utf-8',
      overwritePolicy: 'fail_if_exists',
      overwritten: false,
      readBackMatched: true,
    });
    authorization.runState.ownedTargets.set(normalizedPath(target.absolutePath), {
      target,
      identity: {
        dev: pathObservation.stats.dev,
        ino: pathObservation.stats.ino,
        size: pathObservation.stats.size,
      },
      receipt,
    });
    return receipt;
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (createdIdentity) {
      try {
        const current = fs.lstatSync(target.absolutePath);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.nlink === 1
          && current.dev === createdIdentity.dev
          && current.ino === createdIdentity.ino
        ) fs.unlinkSync(target.absolutePath);
      } catch {}
    }
    if (error instanceof Error && error.name === 'TaskRegressionDesktopRelayError') throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      throw relayError('task_regression_desktop_relay_target_not_owned');
    }
    throw relayError('task_regression_desktop_relay_write_failed');
  }
}

/** Executes only manifest-bound semantics owned by the isolated regression runner. */
export function executeTaskRegressionDesktopRelay(
  socket: Socket | any,
  toolName: string,
  rawArguments: unknown,
  requestId: string,
): string {
  const authorization = authorizedSockets.get(socket);
  if (!authorization || (toolName !== DESKTOP_WRITE_TOOL && !WPS_SEMANTIC_TOOLS.has(toolName))) {
    throw relayError('task_regression_desktop_relay_unavailable');
  }
  if (Date.now() >= authorization.config.expiresAtMs) {
    throw relayError('task_regression_desktop_relay_expired');
  }
  assertArtifactsDirectory(authorization.config);
  const requestBinding = manifestBindingForRequest(authorization, requestId);
  if (WPS_SEMANTIC_TOOLS.has(toolName)) {
    return executeWpsSemanticRelay(
      authorization,
      toolName,
      rawArguments,
      requestBinding,
    );
  }
  const args = exactWriteArguments(rawArguments);
  const target = authorization.config.desktopRelay.targets.find(candidate => (
    normalizedPath(candidate.absolutePath) === normalizedPath(args.path)
  ));
  if (!target) throw relayError('task_regression_desktop_relay_target_not_allowlisted');
  if (requestBinding.scenarioId !== target.scenarioId) {
    throw relayError('task_regression_desktop_relay_request_binding_invalid');
  }
  const bytes = Buffer.from(args.content, 'utf8');
  if (
    bytes.length > MAX_TEXT_FILE_BYTES
    || sha256(bytes) !== target.contentSha256
    || args.encoding !== target.encoding
    || args.overwritePolicy !== target.overwritePolicy
  ) throw relayError('task_regression_desktop_relay_payload_not_allowlisted');

  const key = normalizedPath(target.absolutePath);
  const owned = authorization.runState.ownedTargets.get(key);
  if (owned) return JSON.stringify(validateIdempotentReplay(owned, bytes));

  try {
    const existing = fs.lstatSync(target.absolutePath);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      throw relayError('task_regression_desktop_relay_target_identity_invalid');
    }
    throw relayError('task_regression_desktop_relay_target_not_owned');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  return JSON.stringify(createOwnedTarget(authorization, target, bytes));
}

export function clearTaskRegressionDesktopRelayAuthorizationForTests(socket: object): void {
  const authorization = authorizedSockets.get(socket);
  if (authorization) authorizedRuns.delete(authorization.config.sandboxId);
  authorizedSockets.delete(socket);
}
