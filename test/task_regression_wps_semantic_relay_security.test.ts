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
  executeTaskRegressionDesktopRelay,
} from '../server/evidence/task_regression_desktop_relay';

const scenarioId = 'wps_wrong_file_correction';
const acceptanceRunId = 'task_regression_candidate_wps_semantic_relay_security';
const userId = 'task-regression-wps-relay-admin';
const phaseRequestIds = {
  anchor: 'reg_wps_semantic_anchor',
  correction: 'reg_wps_semantic_correction',
  'supply-filename': 'reg_wps_semantic_supply_filename',
};
const wrongName = 'WPS-Quarterly-Review-Draft.pptx';
const correctName = 'WPS-Quarterly-Review-Final.pptx';
const wrongContent = 'WRONG-WPS-CONTENT:obsolete revenue 17';
const correctContent = 'CORRECT-WPS-CONTENT:verified revenue 42';

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fakeSocket(proof: string): any {
  const disconnectHandlers: Array<() => void> = [];
  return {
    handshake: { auth: { taskRegressionDesktopRelayProof: proof } },
    request: { socket: { remoteAddress: '127.0.0.1' } },
    data: { authenticatedUserId: userId, trustedLocalExecution: true },
    once(event: string, callback: () => void) {
      if (event === 'disconnect') disconnectHandlers.push(callback);
    },
    disconnectForTest() {
      for (const callback of disconnectHandlers) callback();
    },
  };
}

describe('isolated WPS wrong-file semantic desktop relay', () => {
  let tempBase = '';
  let sandbox: any;
  let access: any;
  let config: TaskRegressionEvidenceRouteConfig;
  let socket: any;
  let wrongFixture = '';
  let correctFixture = '';

  beforeEach(async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-wps-semantic-relay-'));
    sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    wrongFixture = path.join(sandbox.artifacts, wrongName);
    correctFixture = path.join(sandbox.artifacts, correctName);
    fs.writeFileSync(wrongFixture, wrongContent, { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(correctFixture, correctContent, { encoding: 'utf8', flag: 'wx' });
    access = await provisionTaskRegressionEvidenceAccess(sandbox, acceptanceRunId, {
      buildIdentityDigest: 'a'.repeat(64),
      snapshotBindings: [{
        scenarioId,
        phases: Object.entries(phaseRequestIds).map(([phaseId, requestId]) => ({
          phaseId,
          requestId,
        })),
      }],
      desktopRelayTargets: [{
        scenarioId,
        relativePath: wrongName,
        contentSha256: digest(wrongContent),
        encoding: 'utf-8',
        overwritePolicy: 'read_only',
      }, {
        scenarioId,
        relativePath: correctName,
        contentSha256: digest(correctContent),
        encoding: 'utf-8',
        overwritePolicy: 'read_only',
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
    socket = fakeSocket(access.desktopRelayProof);
    authorizeTaskRegressionDesktopRelaySocket(socket, { uid: userId, role: 'admin' }, { config });
  });

  afterEach(async () => {
    if (socket) clearTaskRegressionDesktopRelayAuthorizationForTests(socket);
    if (sandbox && fs.existsSync(sandbox.root)) await removeIsolatedRegressionSandbox(sandbox);
    if (tempBase && fs.existsSync(tempBase)) fs.rmSync(tempBase, { recursive: true, force: true });
  });

  it('binds an unknown-path WPS foreground anchor and a bounded two-candidate Desktop listing', () => {
    const active = JSON.parse(executeTaskRegressionDesktopRelay(
      socket,
      'desktop_active_window',
      {},
      phaseRequestIds.anchor,
    ));
    expect(active).toMatchObject({
      ok: true,
      status: 'observed',
      processName: 'wps.exe',
      documentName: wrongName,
      path: '',
      currentDocument: {
        name: wrongName,
        path: null,
        pathStatus: 'unknown',
        source: 'active_window_title',
      },
      evidenceSource: 'isolated_manifest_bound_semantic_relay',
    });

    const listed = JSON.parse(executeTaskRegressionDesktopRelay(
      socket,
      'desktop_list_files',
      { path: '~/Desktop', limit: 100 },
      phaseRequestIds['supply-filename'],
    ));
    expect(listed.path).toBe('~/Desktop');
    expect(listed.entries.map((entry: any) => ({ name: entry.name, path: entry.path }))).toEqual([
      { name: wrongName, path: wrongFixture },
      { name: correctName, path: correctFixture },
    ]);
    expect(listed.entries.every((entry: any) => !('content' in entry))).toBe(true);
  });

  it('never exposes PPTX bytes through the plain-text relay and preserves both fixtures', () => {
    const wrongBefore = fs.statSync(wrongFixture);
    const correctBefore = fs.statSync(correctFixture);
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_read_text_file',
      { path: correctFixture },
      phaseRequestIds['supply-filename'],
    )).toThrow('task_regression_desktop_relay_unavailable');
    const wrongAfter = fs.statSync(wrongFixture);
    const correctAfter = fs.statSync(correctFixture);

    expect(fs.readFileSync(wrongFixture, 'utf8')).toBe(wrongContent);
    expect(fs.readFileSync(correctFixture, 'utf8')).toBe(correctContent);
    expect([wrongAfter.size, wrongAfter.mtimeMs, wrongAfter.ino]).toEqual([
      wrongBefore.size,
      wrongBefore.mtimeMs,
      wrongBefore.ino,
    ]);
    expect([correctAfter.size, correctAfter.mtimeMs, correctAfter.ino]).toEqual([
      correctBefore.size,
      correctBefore.mtimeMs,
      correctBefore.ino,
    ]);
  });

  it('rejects phase substitution, unbounded arguments, unknown requests, and paths outside the virtual Desktop', () => {
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_active_window',
      { title: 'caller-authored' },
      phaseRequestIds.anchor,
    )).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_list_files',
      { path: '~', limit: 100 },
      phaseRequestIds['supply-filename'],
    )).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_list_files',
      { path: '~/Desktop', limit: 1000 },
      phaseRequestIds['supply-filename'],
    )).toThrow('task_regression_desktop_relay_arguments_invalid');
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_read_text_file',
      { path: '~/Documents/private.txt' },
      phaseRequestIds['supply-filename'],
    )).toThrow('task_regression_desktop_relay_unavailable');
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_read_text_file',
      { path: correctFixture },
      phaseRequestIds.correction,
    )).toThrow('task_regression_desktop_relay_unavailable');
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_active_window',
      {},
      'reg_wps_unknown_request',
    )).toThrow('task_regression_desktop_relay_request_binding_invalid');
  });

  it('fails closed if either manifest-pinned read-only fixture changes after authorization', () => {
    fs.writeFileSync(correctFixture, `${correctContent}-tampered`, 'utf8');
    expect(() => executeTaskRegressionDesktopRelay(
      socket,
      'desktop_list_files',
      { path: '~/Desktop', limit: 100 },
      phaseRequestIds['supply-filename'],
    )).toThrow(/task_regression_desktop_relay_read_only_fixture_identity_changed|task_regression_desktop_relay_wps_fixture_invalid/u);
    expect(fs.readFileSync(wrongFixture, 'utf8')).toBe(wrongContent);
  });
});
