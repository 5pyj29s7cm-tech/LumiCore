import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSanitizedRegressionEnvironment,
  createIsolatedRegressionSandbox,
  provisionTaskRegressionEvidenceAccess,
  removeIsolatedRegressionSandbox,
} from '../scripts/lib/task-regression-black-box-runner.mjs';
import {
  resolveTaskRegressionEvidenceRouteConfig,
  type TaskRegressionEvidenceRouteConfig,
} from '../server/evidence/task_truth_snapshot_route';
import {
  authorizeTaskRegressionDesktopRelaySocket,
  clearTaskRegressionDesktopRelayAuthorizationForTests,
  executeTaskRegressionDesktopRelay as executeTaskRegressionDesktopRelayRaw,
  hasTaskRegressionDesktopRelayAuthorization,
} from '../server/evidence/task_regression_desktop_relay';

const scenarioId = 'repeated_confirmation_exactly_once';
const acceptanceRunId = 'task_regression_candidate_desktop_relay_security';
const userId = 'task-regression-relay-admin';
const boundRequestId = 'reg_desktop_relay_security_request';

function executeTaskRegressionDesktopRelay(
  socket: any,
  toolName: string,
  rawArguments: unknown,
  requestId = boundRequestId,
): string {
  return executeTaskRegressionDesktopRelayRaw(socket, toolName, rawArguments, requestId);
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fakeSocket(proof: string, remoteAddress = '127.0.0.1', uid = userId): any {
  const disconnectHandlers: Array<() => void> = [];
  return {
    handshake: {
      auth: { taskRegressionDesktopRelayProof: proof },
      headers: { 'x-forwarded-for': '127.0.0.1' },
    },
    request: { socket: { remoteAddress } },
    data: { authenticatedUserId: uid, trustedLocalExecution: true },
    once(event: string, callback: () => void) {
      if (event === 'disconnect') disconnectHandlers.push(callback);
    },
    disconnectForTest() {
      for (const callback of disconnectHandlers) callback();
    },
  };
}

describe('isolated task-regression desktop text relay', () => {
  let tempBase = '';
  let sandbox: any;
  let access: any;
  let config: TaskRegressionEvidenceRouteConfig;
  let targetPath = '';
  let content = '';
  const sockets: object[] = [];

  beforeEach(async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-task-relay-security-'));
    sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    targetPath = path.join(sandbox.artifacts, 'confirm-exactly-once.txt');
    content = 'isolated relay exact bytes 你好';
    access = await provisionTaskRegressionEvidenceAccess(sandbox, acceptanceRunId, {
      buildIdentityDigest: 'a'.repeat(64),
      snapshotBindings: [{ scenarioId, requestId: boundRequestId }],
      desktopRelayTargets: [{
        scenarioId,
        relativePath: path.basename(targetPath),
        contentSha256: digest(content),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }],
    });
    const environment = buildSanitizedRegressionEnvironment({
      sandbox,
      port: 32123,
      modelStubBaseUrl: 'http://127.0.0.1:32124',
      evidenceAccess: access,
    });
    config = resolveTaskRegressionEvidenceRouteConfig({
      environment: environment as unknown as Record<string, string>,
      currentDataRoot: sandbox.dataRoot,
    })!;
  });

  afterEach(async () => {
    for (const socket of sockets) clearTaskRegressionDesktopRelayAuthorizationForTests(socket);
    sockets.length = 0;
    if (sandbox && fs.existsSync(sandbox.root)) await removeIsolatedRegressionSandbox(sandbox);
    if (tempBase && fs.existsSync(tempBase)) fs.rmSync(tempBase, { recursive: true, force: true });
  });

  function authorize(options: {
    proof?: string;
    remoteAddress?: string;
    role?: string;
    uid?: string;
    config?: TaskRegressionEvidenceRouteConfig | null;
  } = {}): any {
    const socket = fakeSocket(
      options.proof ?? access.desktopRelayProof,
      options.remoteAddress ?? '127.0.0.1',
      options.uid ?? userId,
    );
    sockets.push(socket);
    authorizeTaskRegressionDesktopRelaySocket(socket, {
      uid: options.uid ?? userId,
      role: options.role ?? 'admin',
    }, {
      config: options.config === undefined ? config : options.config,
    });
    return socket;
  }

  function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      path: targetPath,
      content,
      encoding: 'utf-8',
      overwritePolicy: 'fail_if_exists',
      ...overrides,
    };
  }

  it('is disabled without the complete gate and binds an independent proof to admin plus real loopback', () => {
    const noProof = fakeSocket('');
    sockets.push(noProof);
    expect(authorizeTaskRegressionDesktopRelaySocket(noProof, {
      uid: userId,
      role: 'admin',
    }, { config: null })).toBe(false);
    expect(hasTaskRegressionDesktopRelayAuthorization(noProof)).toBe(false);

    expect(() => authorize({ config: null })).toThrow('task_regression_desktop_relay_authorization_failed');
    expect(() => authorize({ role: 'user' })).toThrow('task_regression_desktop_relay_authorization_failed');
    expect(() => authorize({ remoteAddress: '192.0.2.25' }))
      .toThrow('task_regression_desktop_relay_authorization_failed');
    expect(() => authorize({ proof: crypto.randomBytes(48).toString('base64url') }))
      .toThrow('task_regression_desktop_relay_authorization_failed');

    const socket = authorize();
    expect(hasTaskRegressionDesktopRelayAuthorization(socket)).toBe(true);
    expect(socket.handshake.auth).not.toHaveProperty('taskRegressionDesktopRelayProof');
    socket.disconnectForTest();
    expect(hasTaskRegressionDesktopRelayAuthorization(socket)).toBe(false);
  });

  it('accepts only the four exact semantic fields and the one manifest-bound payload', () => {
    const socket = authorize();
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', {
      ...args(),
      extra: true,
    })).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args({
      path: 'confirm-exactly-once.txt',
    }))).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args({
      path: `${targetPath}\u0000escape`,
    }))).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args({
      content: 'x'.repeat(500 * 1024 + 1),
    }))).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', {
      path: targetPath,
      content,
      encoding: 'utf8',
      overwritePolicy: 'fail_if_exists',
    })).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args({
      content: `${content}-changed`,
    }))).toThrow('task_regression_desktop_relay_payload_not_allowlisted');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args({
      overwritePolicy: 'replace',
    }))).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_open', args()))
      .toThrow('task_regression_desktop_relay_unavailable');
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('rejects an exact allowlisted target when the current request is not the scenario binding', () => {
    const socket = authorize();
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_write_text_file',
      args(),
      'reg_wrong_request',
    )).toThrow('task_regression_desktop_relay_request_binding_invalid');
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('rejects path escape and never changes a non-owned target', () => {
    const socket = authorize();
    const outside = path.join(tempBase, 'outside-sentinel.txt');
    fs.writeFileSync(outside, 'preserve', { encoding: 'utf8', flag: 'wx' });
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args({
      path: path.join(sandbox.artifacts, '..', '..', 'outside-sentinel.txt'),
    }))).toThrow('task_regression_desktop_relay_target_not_allowlisted');
    expect(fs.readFileSync(outside, 'utf8')).toBe('preserve');

    fs.writeFileSync(targetPath, 'pre-existing-non-owned', { encoding: 'utf8', flag: 'wx' });
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args()))
      .toThrow('task_regression_desktop_relay_target_not_owned');
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('pre-existing-non-owned');
  });

  it('rejects symlink and hardlink targets without writing through them', () => {
    const socket = authorize();
    const outside = path.join(tempBase, 'outside-link-target.txt');
    fs.writeFileSync(outside, 'outside-preserve', { encoding: 'utf8', flag: 'wx' });
    fs.symlinkSync(outside, targetPath, 'file');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args()))
      .toThrow('task_regression_desktop_relay_target_identity_invalid');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-preserve');
    fs.unlinkSync(targetPath);

    fs.linkSync(outside, targetPath);
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args()))
      .toThrow('task_regression_desktop_relay_target_identity_invalid');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-preserve');
  });

  it('rejects an artifacts-directory junction or symlink after startup identity pinning', () => {
    const socket = authorize();
    const original = `${sandbox.artifacts}-owned-original`;
    const outsideDirectory = path.join(tempBase, 'outside-junction-directory');
    fs.mkdirSync(outsideDirectory);
    fs.renameSync(sandbox.artifacts, original);
    fs.symlinkSync(outsideDirectory, sandbox.artifacts, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => executeTaskRegressionDesktopRelay(socket, 'desktop_write_text_file', args()))
      .toThrow(/task_regression_desktop_relay_directory_identity_changed|task_regression_desktop_relay_artifacts_invalid/u);
    expect(fs.readdirSync(outsideDirectory)).toEqual([]);
  });

  it('writes exact UTF-8 bytes once and returns the same read-back receipt without rewriting', () => {
    const socket = authorize();
    const first = JSON.parse(executeTaskRegressionDesktopRelay(
      socket,
      'desktop_write_text_file',
      args(),
    ));
    const firstStat = fs.statSync(targetPath);
    const firstBytes = fs.readFileSync(targetPath);
    const second = JSON.parse(executeTaskRegressionDesktopRelay(
      socket,
      'desktop_write_text_file',
      args(),
    ));
    const secondStat = fs.statSync(targetPath);

    expect(first).toEqual({
      success: true,
      path: targetPath,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      encoding: 'utf-8',
      overwritePolicy: 'fail_if_exists',
      overwritten: false,
      readBackMatched: true,
    });
    expect(second).toEqual(first);
    expect(firstBytes.equals(Buffer.from(content, 'utf8'))).toBe(true);
    expect(secondStat.size).toBe(firstStat.size);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(secondStat.nlink).toBe(1);
  });

  it('recovers the same receipt after socket disconnect and does not rewrite the owned target', () => {
    const firstSocket = authorize();
    const first = JSON.parse(executeTaskRegressionDesktopRelay(
      firstSocket,
      'desktop_write_text_file',
      args(),
    ));
    const firstStat = fs.statSync(targetPath);
    firstSocket.disconnectForTest();

    const replacementSocket = authorize();
    const replay = JSON.parse(executeTaskRegressionDesktopRelay(
      replacementSocket,
      'desktop_write_text_file',
      args(),
    ));
    const replayStat = fs.statSync(targetPath);

    expect(replay).toEqual(first);
    expect(replayStat.dev).toBe(firstStat.dev);
    expect(replayStat.ino).toBe(firstStat.ino);
    expect(replayStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(fs.readFileSync(targetPath).equals(Buffer.from(content, 'utf8'))).toBe(true);
  });
});
