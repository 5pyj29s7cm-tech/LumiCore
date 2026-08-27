import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';
import {
  buildSanitizedRegressionEnvironment,
  createIsolatedRegressionSandbox,
  provisionTaskRegressionEvidenceAccess,
  removeIsolatedRegressionSandbox,
  stableTaskRegressionProbeJson,
} from '../scripts/lib/task-regression-black-box-runner.mjs';
import {
  verifyVoiceTextContinuationTruthEnvelope,
} from '../server/evidence/voice_text_continuation_truth';

const endpoint = '/api/acceptance/task-regression/snapshot';
const staleEndpoint = '/api/acceptance/task-regression/stale-receipt';
const signerEndpoint = '/api/acceptance/task-regression/server-truth-signer';
const acceptanceRunId = `task_regression_candidate_${crypto.randomBytes(12).toString('hex')}`;
const scenarioId = 'repeated_confirmation_exactly_once';
const buildIdentityDigest = 'a'.repeat(64);
const selector = {
  acceptanceRunId,
  conversationId: 'conversation-route-security',
  requestId: 'request-route-security',
  taskId: 'task-route-security',
};
const controlRequestIds = {
  long: 'request-control-long',
  status: 'request-control-status',
  stop: 'request-control-stop',
  repeat: 'request-control-repeat',
};
const controlSelector = {
  acceptanceRunId,
  conversationId: 'conversation-control-route-security',
  requestId: controlRequestIds.long,
};
const staleRequestIds = {
  display: 'request-stale-display',
  continue: 'request-stale-continue',
};
const staleSelector = {
  acceptanceRunId,
  conversationId: 'conversation-stale-route-security',
};
const restartRequestIds = {
  prepare: 'request-restart-prepare',
  continue: 'request-restart-continue',
};
const restartSelector = {
  acceptanceRunId,
  conversationId: 'conversation-restart-route-security',
  requestId: restartRequestIds.prepare,
  taskId: 'task-restart-route-security',
};
const wpsRequestIds = {
  anchor: 'request-wps-anchor',
  correction: 'request-wps-correction',
  'supply-filename': 'request-wps-supply-filename',
};
const wpsSelector = {
  acceptanceRunId,
  conversationId: 'conversation-wps-route-security',
  requestId: wpsRequestIds.anchor,
  taskId: 'task-wps-route-security',
};
const voiceContinuationRequestIds = {
  text_continue: 'request-voice-continuation',
};
const voiceContinuationSelector = {
  acceptanceRunId,
  conversationId: 'conversation-voice-continuation-route-security',
  requestId: voiceContinuationRequestIds.text_continue,
  taskId: 'task-voice-continuation-route-security',
};

const adminToken = jwt.sign({
  uid: 'truth-route-admin',
  username: 'admin',
  role: 'admin',
}, JWT_SECRET);
const userToken = jwt.sign({
  uid: 'truth-route-user',
  username: 'user',
  role: 'user',
}, JWT_SECRET);

function headers(token?: string, proof?: string, extra: Record<string, string> = {}) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(proof ? { 'X-Lumi-Task-Regression-Proof': proof } : {}),
    ...extra,
  };
}

function voiceTextContinuationTruthFixture() {
  const truthWithoutDigest = {
    kind: 'lumi.voice-text-continuation-truth',
    schemaVersion: 1,
    scenarioId: 'voice_to_text_continuation',
    acceptanceRunId,
    buildIdentityDigest,
    conversationId: voiceContinuationSelector.conversationId,
    capturedAt: '2026-08-27T12:00:00.000Z',
    task: {
      recordId: voiceContinuationSelector.taskId,
      taskId: voiceContinuationSelector.taskId,
      revision: 2,
      finalStatus: 'completed',
    },
    voiceStart: {
      request: { requestId: 'request-voice-start' },
      receipt: { recordId: 'receipt-voice-start', receiptId: 'receipt-voice-start' },
    },
    textContinue: {
      request: { requestId: voiceContinuationSelector.requestId },
      receipt: { recordId: 'receipt-text-continue', receiptId: 'receipt-text-continue' },
    },
  };
  return {
    ...truthWithoutDigest,
    evidenceDigestSha256: crypto.createHash('sha256')
      .update(stableTaskRegressionProbeJson(truthWithoutDigest), 'utf8')
      .digest('hex'),
  } as any;
}

describe('isolated task truth snapshot route', () => {
  let testUrl = '';
  let cleanupApp = () => {};
  let tempBase = '';
  let sandbox: any;
  let evidenceAccess: any;
  let isolatedEnvironment: any;
  let routeModule: typeof import('../server/evidence/task_truth_snapshot_route');
  let serverTruthSigner: any;
  const capture = vi.fn(async () => ({
    kind: 'collector-owned-snapshot',
    snapshotId: 'truth-route-result',
  } as any));
  const reclassifyStaleReceipt = vi.fn(async () => ({
    kind: 'collector-owned-stale-receipt-evidence',
    evidenceId: 'stale-route-result',
  } as any));
  const captureVoiceTextContinuation = vi.fn(async () => voiceTextContinuationTruthFixture());

  beforeAll(async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-truth-route-security-'));
    sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const relayContent = 'truth-route-relay-fixture';
    const wrongWpsContent = 'WRONG-WPS-CONTENT:route-security';
    const correctWpsContent = 'CORRECT-WPS-CONTENT:route-security';
    fs.writeFileSync(path.join(sandbox.artifacts, 'WPS-Route-Draft.pptx'), wrongWpsContent, {
      encoding: 'utf8', flag: 'wx',
    });
    fs.writeFileSync(path.join(sandbox.artifacts, 'WPS-Route-Final.pptx'), correctWpsContent, {
      encoding: 'utf8', flag: 'wx',
    });
    evidenceAccess = await provisionTaskRegressionEvidenceAccess(sandbox, acceptanceRunId, {
      buildIdentityDigest,
      snapshotBindings: [{ scenarioId, requestId: selector.requestId }, {
        scenarioId: 'control_stop_status_repeat',
        phases: Object.entries(controlRequestIds).map(([phaseId, requestId]) => ({
          phaseId,
          requestId,
        })),
      }, {
        scenarioId: 'displayed_result_stale_receipt',
        phases: Object.entries(staleRequestIds).map(([phaseId, requestId]) => ({
          phaseId,
          requestId,
        })),
      }, {
        scenarioId: 'mid_task_restart_recovery',
        phases: Object.entries(restartRequestIds).map(([phaseId, requestId]) => ({
          phaseId,
          requestId,
        })),
      }, {
        scenarioId: 'wps_wrong_file_correction',
        phases: Object.entries(wpsRequestIds).map(([phaseId, requestId]) => ({
          phaseId,
          requestId,
        })),
      }, {
        scenarioId: 'voice_to_text_continuation',
        phases: Object.entries(voiceContinuationRequestIds).map(([phaseId, requestId]) => ({
          phaseId,
          requestId,
        })),
      }],
      desktopRelayTargets: [{
        scenarioId,
        relativePath: 'confirm-exactly-once.txt',
        contentSha256: crypto.createHash('sha256').update(relayContent).digest('hex'),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }, {
        scenarioId: 'displayed_result_stale_receipt',
        relativePath: 'displayed-result-next-step.txt',
        contentSha256: crypto.createHash('sha256')
          .update('stale receipt live-owner sentinel')
          .digest('hex'),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }, {
        scenarioId: 'mid_task_restart_recovery',
        relativePath: 'restart-recovery-result.txt',
        contentSha256: crypto.createHash('sha256')
          .update('restart-recovery-fixture')
          .digest('hex'),
        encoding: 'utf-8',
        overwritePolicy: 'fail_if_exists',
      }, {
        scenarioId: 'wps_wrong_file_correction',
        relativePath: 'WPS-Route-Draft.pptx',
        contentSha256: crypto.createHash('sha256').update(wrongWpsContent).digest('hex'),
        encoding: 'utf-8',
        overwritePolicy: 'read_only',
      }, {
        scenarioId: 'wps_wrong_file_correction',
        relativePath: 'WPS-Route-Final.pptx',
        contentSha256: crypto.createHash('sha256').update(correctWpsContent).digest('hex'),
        encoding: 'utf-8',
        overwritePolicy: 'read_only',
      }],
    });
    isolatedEnvironment = buildSanitizedRegressionEnvironment({
      sandbox,
      port: 32123,
      modelStubBaseUrl: 'http://127.0.0.1:32124',
      evidenceAccess,
    });
    routeModule = await import('../server/evidence/task_truth_snapshot_route');

    const app = await makeApp();
    testUrl = app.url;
    cleanupApp = app.cleanup;

    // With no complete feature configuration the route is not registered at
    // all, which is the production/default behavior.
    expect(routeModule.mountTaskRegressionEvidenceRoutes(app.apiRouter, {
      environment: {},
      currentDataRoot: sandbox.dataRoot,
      capture,
      captureVoiceTextContinuation,
      reclassifyStaleReceipt,
    })).toBe(false);
    const absent = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(selector),
    });
    expect(absent.status).toBe(404);
    const absentStale = await fetch(`${testUrl}${staleEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(staleSelector),
    });
    expect(absentStale.status).toBe(404);

    app.apiRouter.use((req, res, next) => {
      if (req.header('x-test-non-loopback') === '1') {
        Object.defineProperty(req.socket, 'remoteAddress', {
          configurable: true,
          value: '192.0.2.25',
        });
        res.once('finish', () => {
          delete (req.socket as any).remoteAddress;
        });
      }
      next();
    });
    expect(routeModule.mountTaskRegressionEvidenceRoutes(app.apiRouter, {
      environment: isolatedEnvironment,
      currentDataRoot: sandbox.dataRoot,
      capture,
      captureVoiceTextContinuation,
      reclassifyStaleReceipt,
    })).toBe(true);
  });

  afterAll(async () => {
    cleanupApp();
    if (sandbox && fs.existsSync(sandbox.root)) await removeIsolatedRegressionSandbox(sandbox);
    if (tempBase && fs.existsSync(tempBase)) fs.rmSync(tempBase, { recursive: true, force: true });
  });

  it('fails startup on partial gates or a data root outside the exact owned sandbox slot', () => {
    expect(() => routeModule.resolveTaskRegressionEvidenceRouteConfig({
      environment: { LUMI_TASK_REGRESSION_EVIDENCE_MODE: '1' },
      currentDataRoot: sandbox.dataRoot,
    })).toThrow('task_regression_evidence_configuration_incomplete');

    expect(() => routeModule.resolveTaskRegressionEvidenceRouteConfig({
      environment: {
        ...isolatedEnvironment,
        LUMI_DATA_DIR: sandbox.root,
      },
      currentDataRoot: sandbox.root,
    })).toThrow('task_regression_evidence_data_root_invalid');

    expect(() => routeModule.resolveTaskRegressionEvidenceRouteConfig({
      environment: {
        ...isolatedEnvironment,
        LUMI_TASK_REGRESSION_PROOF_SHA256: 'b'.repeat(64),
      },
      currentDataRoot: sandbox.dataRoot,
    })).toThrow('task_regression_evidence_manifest_proof_binding_invalid');

    expect(() => routeModule.resolveTaskRegressionEvidenceRouteConfig({
      environment: {
        ...isolatedEnvironment,
        LUMI_TASK_REGRESSION_STT_ACCESS_SHA256: 'c'.repeat(64),
      },
      currentDataRoot: sandbox.dataRoot,
    })).toThrow('task_regression_evidence_manifest_stt_binding_invalid');

    expect(() => routeModule.resolveTaskRegressionEvidenceRouteConfig({
      environment: isolatedEnvironment,
      currentDataRoot: sandbox.dataRoot,
      nowMs: Date.now() + 6 * 60 * 1000,
    })).toThrow('task_regression_evidence_manifest_time_binding_invalid');

    const manifestHardlink = path.join(tempBase, 'manifest-hardlink');
    fs.linkSync(evidenceAccess.manifestPath, manifestHardlink);
    try {
      expect(() => routeModule.resolveTaskRegressionEvidenceRouteConfig({
        environment: isolatedEnvironment,
        currentDataRoot: sandbox.dataRoot,
      })).toThrow('task_regression_evidence_manifest_invalid');
    } finally {
      fs.unlinkSync(manifestHardlink);
    }
  });

  it('requires authentication, administrator role, loopback, and the independent proof', async () => {
    const anonymous = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(undefined, evidenceAccess.proof),
      body: JSON.stringify(selector),
    });
    expect(anonymous.status).toBe(401);

    const user = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(userToken, evidenceAccess.proof),
      body: JSON.stringify(selector),
    });
    expect(user.status).toBe(403);

    const missingProof = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken),
      body: JSON.stringify(selector),
    });
    expect(missingProof.status).toBe(403);

    const wrongProof = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, crypto.randomBytes(48).toString('base64url')),
      body: JSON.stringify(selector),
    });
    expect(wrongProof.status).toBe(403);

    const remote = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof, {
        'X-Test-Non-Loopback': '1',
        'X-Forwarded-For': '127.0.0.1',
        Connection: 'close',
      }),
      body: JSON.stringify(selector),
    });
    expect(remote.status).toBe(403);
    expect(capture).not.toHaveBeenCalled();
  });

  it('accepts only runtime record selectors and derives provenance plus userId server-side', async () => {
    const injected = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...selector, userId: 'caller-controlled', receiptId: 'forged' }),
    });
    expect(injected.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();

    const relabelledScenario = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...selector, scenarioId: 'cleanup_offer_then_cleanup' }),
    });
    expect(relabelledScenario.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();

    const relabelledBuild = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...selector, buildIdentityDigest: 'b'.repeat(64) }),
    });
    expect(relabelledBuild.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();

    const unboundRequest = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...selector, requestId: 'request-not-in-startup-manifest' }),
    });
    expect(unboundRequest.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();

    const crossRun = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...selector, acceptanceRunId: 'task_regression_other_run' }),
    });
    expect(crossRun.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();

    const accepted = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(selector),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.json()).toEqual({
      snapshot: {
        kind: 'collector-owned-snapshot',
        snapshotId: 'truth-route-result',
      },
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      scenarioId,
      ...selector,
      buildIdentityDigest,
      userId: 'truth-route-admin',
    });
  });

  it('fails closed with a bounded code when runtime evidence cannot form a snapshot', async () => {
    capture.mockRejectedValueOnce(new Error('task_truth_snapshot_receipt_missing'));
    const rejected = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(selector),
    });
    expect(rejected.status).toBe(409);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(await rejected.json()).toEqual({
      error: 'Task truth snapshot could not be derived from runtime evidence',
      code: 'task_truth_snapshot_receipt_missing',
    });
  });

  it('binds both S7 request phases at startup while deriving scenario and build server-side', async () => {
    for (const requestId of Object.values(restartRequestIds)) {
      const selected = { ...restartSelector, requestId };
      const response = await fetch(`${testUrl}${endpoint}`, {
        method: 'POST',
        headers: headers(adminToken, evidenceAccess.proof),
        body: JSON.stringify(selected),
      });
      expect(response.status).toBe(200);
      expect(capture).toHaveBeenLastCalledWith({
        scenarioId: 'mid_task_restart_recovery',
        ...selected,
        buildIdentityDigest,
        userId: 'truth-route-admin',
      });
    }
  });

  it('derives the S3 representative receipt tool from the sealed phase and rejects caller selection', async () => {
    const injected = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...wpsSelector, receiptToolName: 'desktop_list_files' }),
    });
    expect(injected.status).toBe(400);

    for (const [phaseId, receiptToolName] of [
      ['anchor', 'desktop_active_window'],
      ['supply-filename', 'extract_document_text'],
    ] as const) {
      const selected = { ...wpsSelector, requestId: wpsRequestIds[phaseId] };
      const response = await fetch(`${testUrl}${endpoint}`, {
        method: 'POST',
        headers: headers(adminToken, evidenceAccess.proof),
        body: JSON.stringify(selected),
      });
      expect(response.status).toBe(200);
      expect(capture).toHaveBeenLastCalledWith({
        scenarioId: 'wps_wrong_file_correction',
        ...selected,
        buildIdentityDigest,
        userId: 'truth-route-admin',
        receiptToolName,
      });
    }
  });

  it('derives the S6 read receipt from its sealed continuation phase', async () => {
    for (const injectedField of [{
      receiptToolName: 'search_files',
    }, {
      voiceRequestId: 'caller-forged-voice-request',
    }, {
      sourceChannel: 'voice',
    }, {
      capture: { audioInputKind: 'physical_microphone' },
    }, {
      targetCorrection: { previousTarget: 'caller-forged' },
    }, {
      buildIdentityDigest: 'b'.repeat(64),
    }]) {
      const injected = await fetch(`${testUrl}${endpoint}`, {
        method: 'POST',
        headers: headers(adminToken, evidenceAccess.proof),
        body: JSON.stringify({ ...voiceContinuationSelector, ...injectedField }),
      });
      expect(injected.status).toBe(400);
    }

    const beforeSignerPin = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(voiceContinuationSelector),
    });
    expect(beforeSignerPin.status).toBe(409);
    expect(captureVoiceTextContinuation).not.toHaveBeenCalled();

    const wrongBootstrap = await fetch(`${testUrl}${signerEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, undefined, {
        'X-Lumi-Task-Regression-Signer-Bootstrap': crypto.randomBytes(48).toString('base64url'),
      }),
      body: JSON.stringify({ acceptanceRunId }),
    });
    expect(wrongBootstrap.status).toBe(403);
    const remoteBootstrap = await fetch(`${testUrl}${signerEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, undefined, {
        'X-Lumi-Task-Regression-Signer-Bootstrap': evidenceAccess.signerBootstrap,
        'X-Test-Non-Loopback': '1',
        Connection: 'close',
      }),
      body: JSON.stringify({ acceptanceRunId }),
    });
    expect(remoteBootstrap.status).toBe(403);
    const signerResponse = await fetch(`${testUrl}${signerEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, undefined, {
        'X-Lumi-Task-Regression-Signer-Bootstrap': evidenceAccess.signerBootstrap,
      }),
      body: JSON.stringify({ acceptanceRunId }),
    });
    expect(signerResponse.status).toBe(200);
    const signerInfo = await signerResponse.json() as any;
    expect(signerInfo).toMatchObject({
      kind: 'lumi.task-regression-server-truth-signer-info',
      schemaVersion: 1,
      signer: {
        kind: 'lumi.voice-text-continuation-truth-signer',
        algorithm: 'ed25519',
        acceptanceRunId,
        buildIdentityDigest,
      },
    });
    expect(signerInfo.signer.serverInstanceNonce).toMatch(/^[A-Za-z0-9_-]{22,192}$/u);
    serverTruthSigner = signerInfo.signer;
    const replayedBootstrap = await fetch(`${testUrl}${signerEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, undefined, {
        'X-Lumi-Task-Regression-Signer-Bootstrap': evidenceAccess.signerBootstrap,
      }),
      body: JSON.stringify({ acceptanceRunId }),
    });
    expect(replayedBootstrap.status).toBe(409);

    const accepted = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(voiceContinuationSelector),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as any;
    expect(acceptedBody).toMatchObject({
      snapshot: {
        kind: 'collector-owned-snapshot',
        snapshotId: 'truth-route-result',
      },
      voiceTextContinuation: {
        kind: 'lumi.voice-text-continuation-truth',
        acceptanceRunId,
        buildIdentityDigest,
      },
      voiceTextContinuationEnvelope: {
        kind: 'lumi.voice-text-continuation-truth-envelope',
        binding: {
          acceptanceRunId,
          buildIdentityDigest,
          serverInstanceNonce: serverTruthSigner.serverInstanceNonce,
        },
      },
    });
    expect(verifyVoiceTextContinuationTruthEnvelope(
      acceptedBody.voiceTextContinuationEnvelope,
      serverTruthSigner,
    )).toBe(true);
    expect(capture).toHaveBeenLastCalledWith({
      scenarioId: 'voice_to_text_continuation',
      ...voiceContinuationSelector,
      buildIdentityDigest,
      userId: 'truth-route-admin',
      receiptToolName: 'read_file',
    });
    expect(captureVoiceTextContinuation).toHaveBeenLastCalledWith({
      scenarioId: 'voice_to_text_continuation',
      acceptanceRunId,
      buildIdentityDigest,
      userId: 'truth-route-admin',
      conversationId: voiceContinuationSelector.conversationId,
      textRequestId: voiceContinuationSelector.requestId,
      taskId: voiceContinuationSelector.taskId,
    });
  });

  it('allows a request-only selector only for the manifest-bound four-phase control sequence', async () => {
    const injectedTask = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...controlSelector, taskId: 'caller-invented-task' }),
    });
    expect(injectedTask.status).toBe(400);

    const nonControlWithoutTask = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({
        acceptanceRunId,
        conversationId: selector.conversationId,
        requestId: selector.requestId,
      }),
    });
    expect(nonControlWithoutTask.status).toBe(400);

    const phaseSubstitution = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify({ ...controlSelector, requestId: controlRequestIds.stop }),
    });
    expect(phaseSubstitution.status).toBe(400);

    const accepted = await fetch(`${testUrl}${endpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(controlSelector),
    });
    expect(accepted.status).toBe(200);
    expect(capture).toHaveBeenLastCalledWith({
      scenarioId: 'control_stop_status_repeat',
      ...controlSelector,
      buildIdentityDigest,
      userId: 'truth-route-admin',
      phaseRequestIds: controlRequestIds,
    });
  });

  it('derives the S4 requests server-side and rejects caller-authored task or receipt fields', async () => {
    const anonymous = await fetch(`${testUrl}${staleEndpoint}`, {
      method: 'POST',
      headers: headers(undefined, evidenceAccess.proof),
      body: JSON.stringify(staleSelector),
    });
    expect(anonymous.status).toBe(401);

    const ordinaryUser = await fetch(`${testUrl}${staleEndpoint}`, {
      method: 'POST',
      headers: headers(userToken, evidenceAccess.proof),
      body: JSON.stringify(staleSelector),
    });
    expect(ordinaryUser.status).toBe(403);

    const missingProof = await fetch(`${testUrl}${staleEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken),
      body: JSON.stringify(staleSelector),
    });
    expect(missingProof.status).toBe(403);

    const remote = await fetch(`${testUrl}${staleEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof, {
        'X-Test-Non-Loopback': '1',
        Connection: 'close',
      }),
      body: JSON.stringify(staleSelector),
    });
    expect(remote.status).toBe(403);

    for (const injected of [{
      ...staleSelector,
      requestId: staleRequestIds.display,
    }, {
      ...staleSelector,
      taskId: 'caller-selected-task',
    }, {
      ...staleSelector,
      receiptId: 'caller-selected-receipt',
    }, {
      ...staleSelector,
      toolCalls: [{ name: 'read_file', result: 'forged' }],
    }]) {
      const rejected = await fetch(`${testUrl}${staleEndpoint}`, {
        method: 'POST',
        headers: headers(adminToken, evidenceAccess.proof),
        body: JSON.stringify(injected),
      });
      expect(rejected.status).toBe(400);
    }
    expect(reclassifyStaleReceipt).not.toHaveBeenCalled();

    const accepted = await fetch(`${testUrl}${staleEndpoint}`, {
      method: 'POST',
      headers: headers(adminToken, evidenceAccess.proof),
      body: JSON.stringify(staleSelector),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.json()).toEqual({
      evidence: {
        kind: 'collector-owned-stale-receipt-evidence',
        evidenceId: 'stale-route-result',
      },
    });
    expect(reclassifyStaleReceipt).toHaveBeenCalledTimes(1);
    expect(reclassifyStaleReceipt).toHaveBeenCalledWith({
      acceptanceRunId,
      buildIdentityDigest,
      scenarioId: 'displayed_result_stale_receipt',
      userId: 'truth-route-admin',
      conversationId: staleSelector.conversationId,
      displayRequestId: staleRequestIds.display,
      continueRequestId: staleRequestIds.continue,
    });
  });
});
