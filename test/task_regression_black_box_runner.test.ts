import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  IMPLEMENTED_BLACK_BOX_SCENARIOS,
  DEFAULT_SERVER_TRUTH_SIGNER_ENDPOINT,
  DEFAULT_TRUTH_SNAPSHOT_ENDPOINT,
  assembleTaskRegressionRunFromProbe,
  assertIsolatedRegressionDataRoot,
  buildSanitizedRegressionEnvironment,
  createIsolatedRegressionSandbox,
  defaultProtectedProductRoots,
  evaluateControlProviderWitness,
  evaluateDisplayedResultEvidence,
  inspectIsolatedRegressionBackendLease,
  pinTaskRegressionServerTruthSigner,
  provisionTaskRegressionEvidenceAccess,
  removeIsolatedRegressionSandbox,
  reserveLoopbackPort,
  runTaskRegressionBlackBoxProbe,
  startDeterministicRegressionModelStub,
  taskRegressionProbeExitCode,
  truthSnapshotBindings,
  verifyLoopbackConnectionRefused,
} from '../scripts/lib/task-regression-black-box-runner.mjs';

const ownedRoots: string[] = [];

function makeTempBase(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  ownedRoots.push(root);
  return root;
}

function postJson(url: string, value: unknown): Promise<{ status: number; body: any }> {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode || 0, body: raw ? JSON.parse(raw) : {} });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

afterEach(() => {
  while (ownedRoots.length) {
    const root = ownedRoots.pop()!;
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('task regression black-box runner isolation', () => {
  it('creates a non-overlapping owned data root and removes only that sandbox', async () => {
    const tempBase = makeTempBase('lumi-regression-sandbox');
    const protectedParent = makeTempBase('lumi-regression-protected');
    const protectedRoot = path.join(protectedParent, 'must-not-touch');
    fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, 'sentinel.txt'), 'preserve', 'utf8');

    const sandbox = await createIsolatedRegressionSandbox({
      tempBase,
      protectedRoots: [protectedRoot],
    });
    expect(assertIsolatedRegressionDataRoot(sandbox.dataRoot, {
      sandboxRoot: sandbox.root,
      protectedRoots: [protectedRoot],
    })).toBe(sandbox.dataRoot);
    expect(fs.existsSync(path.join(sandbox.dataRoot, 'data', '.migration_skip'))).toBe(true);
    expect(fs.existsSync(sandbox.dotenvPath)).toBe(true);
    expect(sandbox.rootIdentity).toMatchObject({
      canonical: sandbox.root,
      dev: expect.any(Number),
      ino: expect.any(Number),
    });
    expect(sandbox.tempBaseIdentity).toMatchObject({
      canonical: sandbox.tempBase,
      dev: expect.any(Number),
      ino: expect.any(Number),
    });

    await removeIsolatedRegressionSandbox(sandbox);
    expect(fs.existsSync(sandbox.root)).toBe(false);
    expect(fs.readFileSync(path.join(protectedRoot, 'sentinel.txt'), 'utf8')).toBe('preserve');
  });

  it('refuses to delete a same-path replacement when the owned sandbox was renamed', async () => {
    const tempBase = makeTempBase('lumi-regression-cleanup-identity');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const displacedRoot = `${sandbox.root}-displaced`;
    fs.renameSync(sandbox.root, displacedRoot);
    fs.mkdirSync(sandbox.root);
    const replacementSentinel = path.join(sandbox.root, 'non-owned-sentinel.txt');
    fs.writeFileSync(replacementSentinel, 'preserve', { encoding: 'utf8', flag: 'wx' });

    await expect(removeIsolatedRegressionSandbox(sandbox))
      .rejects.toThrow('regression_cleanup_root_identity_changed');
    expect(fs.readFileSync(replacementSentinel, 'utf8')).toBe('preserve');
    expect(fs.existsSync(displacedRoot)).toBe(true);

    fs.rmSync(sandbox.root, { recursive: true, force: false });
    fs.renameSync(displacedRoot, sandbox.root);
    await removeIsolatedRegressionSandbox(sandbox);
  });

  it('rejects a hard-linked migration marker before provisioning evidence', async () => {
    const tempBase = makeTempBase('lumi-regression-marker-hardlink');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const marker = path.join(sandbox.dataRoot, 'data', '.migration_skip');
    const outsideEmptyFile = path.join(tempBase, 'outside-empty-file');
    fs.writeFileSync(outsideEmptyFile, '', { encoding: 'utf8', flag: 'wx' });
    fs.unlinkSync(marker);
    fs.linkSync(outsideEmptyFile, marker);

    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_marker_hardlink',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'repeated_confirmation_exactly_once',
          requestId: 'reg_marker_hardlink_request',
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_migration_marker_not_safe');
    expect(fs.lstatSync(marker).nlink).toBe(2);
    expect(fs.lstatSync(outsideEmptyFile).nlink).toBe(2);

    await removeIsolatedRegressionSandbox(sandbox);
  });

  it('projects a runner-owned backend lease without exposing its owner identity', async () => {
    const tempBase = makeTempBase('lumi-regression-backend-lease');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const runtimeDirectory = path.join(sandbox.dataRoot, 'runtime');
    fs.mkdirSync(runtimeDirectory);
    const canonicalDataRoot = fs.realpathSync.native(sandbox.dataRoot);
    const normalizedDataRoot = process.platform === 'win32'
      ? path.normalize(canonicalDataRoot).toLocaleLowerCase('en-US')
      : path.normalize(canonicalDataRoot);
    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const processStartIdentity = `test-process-start-${crypto.randomBytes(12).toString('hex')}`;
    const leasePath = path.join(runtimeDirectory, 'backend-instance.lock');
    fs.writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      ownerToken,
      pid: process.pid,
      hostname: 'isolated-test-host',
      dataRoot: canonicalDataRoot,
      dataRootDigest: crypto.createHash('sha256').update(normalizedDataRoot).digest('hex'),
      processStartIdentity,
      acquiredAt: new Date().toISOString(),
      leasePurpose: 'backend',
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

    const projection = inspectIsolatedRegressionBackendLease(sandbox);
    expect(projection).toMatchObject({
      state: 'present',
      pid: process.pid,
      ownerTokenSha256: crypto.createHash('sha256').update(ownerToken).digest('hex'),
      processStartIdentitySha256: crypto.createHash('sha256')
        .update(processStartIdentity)
        .digest('hex'),
    });
    expect(JSON.stringify(projection)).not.toContain(ownerToken);
    expect(JSON.stringify(projection)).not.toContain(processStartIdentity);

    const extraLink = path.join(tempBase, 'lease-hardlink');
    fs.linkSync(leasePath, extraLink);
    expect(() => inspectIsolatedRegressionBackendLease(sandbox))
      .toThrow('regression_backend_lease_not_safe');
    fs.unlinkSync(extraLink);
    await removeIsolatedRegressionSandbox(sandbox);
  });

  it('rejects a data root that is the product root, its child, or its parent', () => {
    const tempBase = makeTempBase('lumi-regression-overlap');
    const product = path.join(tempBase, 'LumiOS');
    const child = path.join(product, 'data');
    fs.mkdirSync(child, { recursive: true });
    expect(() => assertIsolatedRegressionDataRoot(product, { protectedRoots: [product] }))
      .toThrow('regression_data_root_overlaps_product_data');
    expect(() => assertIsolatedRegressionDataRoot(child, { protectedRoots: [product] }))
      .toThrow('regression_data_root_overlaps_product_data');
    expect(() => assertIsolatedRegressionDataRoot(tempBase, { protectedRoots: [product] }))
      .toThrow('regression_data_root_overlaps_product_data');
  });

  it('lexically protects a custom absolute LUMI_DATA_DIR without reading it', async () => {
    const tempBase = makeTempBase('lumi-regression-custom-data-root');
    const customDataRoot = path.join(tempBase, 'custom-formal-data-root-does-not-exist');
    const roots = defaultProtectedProductRoots(path.join(tempBase, 'home'), {
      LUMI_DATA_DIR: customDataRoot,
    });
    expect(roots).toContain(path.resolve(customDataRoot));
    expect(fs.existsSync(customDataRoot)).toBe(false);
    await expect(createIsolatedRegressionSandbox({
      tempBase,
      protectedRoots: roots,
    })).rejects.toThrow('regression_temp_base_overlaps_product_data');
    expect(fs.existsSync(customDataRoot)).toBe(false);
  });

  it('does not inherit provider secrets and redirects all user-writable roots', async () => {
    const tempBase = makeTempBase('lumi-regression-env');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'must-not-leak';
    try {
      const relayContent = 'environment-test-owned-content';
      const access = await provisionTaskRegressionEvidenceAccess(
        sandbox,
        'task_regression_candidate_environment_test',
        {
          buildIdentityDigest: 'a'.repeat(64),
          snapshotBindings: [{
            scenarioId: 'repeated_confirmation_exactly_once',
            requestId: 'reg_environment_test_request',
          }],
          desktopRelayTargets: [{
            scenarioId: 'repeated_confirmation_exactly_once',
            relativePath: 'confirm-exactly-once.txt',
            contentSha256: crypto.createHash('sha256').update(relayContent).digest('hex'),
            encoding: 'utf-8',
            overwritePolicy: 'fail_if_exists',
          }],
        },
      );
      const env = buildSanitizedRegressionEnvironment({
        sandbox,
        port: 32123,
        modelStubBaseUrl: 'http://127.0.0.1:32124',
        evidenceAccess: access,
      });
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBe('lumi-regression-local-only');
      expect(env.LUMI_DATA_DIR).toBe(sandbox.dataRoot);
      expect(env.HOME).toBe(sandbox.home);
      expect(env.USERPROFILE).toBe(sandbox.home);
      expect(env.APPDATA).toBe(sandbox.appData);
      expect(env.LOCALAPPDATA).toBe(sandbox.localAppData);
      expect(env.TEMP).toBe(sandbox.temporary);
      expect(env.DOTENV_CONFIG_PATH).toBe(sandbox.dotenvPath);
      expect(env.LUMI_TASK_REGRESSION_EVIDENCE_MODE).toBe('1');
      expect(env.LUMI_TASK_REGRESSION_ACCEPTANCE_RUN_ID).toBe(access.acceptanceRunId);
      expect(env.LUMI_TASK_REGRESSION_SANDBOX_ROOT).toBe(sandbox.root);
      expect(env.LUMI_TASK_REGRESSION_PROOF_SHA256).toBe(access.proofSha256);
      expect(env.LUMI_TASK_REGRESSION_DESKTOP_RELAY_PROOF_SHA256)
        .toBe(access.desktopRelayProofSha256);
      expect(env.LUMI_TASK_REGRESSION_SIGNER_BOOTSTRAP_SHA256)
        .toBe(access.signerBootstrapSha256);
      expect(env.LUMI_TASK_REGRESSION_RUNNER_PID).toBe(String(process.pid));
      expect(Object.values(env)).not.toContain(access.proof);
      expect(Object.values(env)).not.toContain(access.desktopRelayProof);
      expect(Object.values(env)).not.toContain(access.signerBootstrap);
      expect(fs.readFileSync(access.manifestPath, 'utf8')).not.toContain(access.proof);
      expect(fs.readFileSync(access.manifestPath, 'utf8')).not.toContain(access.desktopRelayProof);
      expect(fs.readFileSync(access.manifestPath, 'utf8')).not.toContain(access.signerBootstrap);
      expect(fs.lstatSync(access.manifestPath).nlink).toBe(1);
      expect(JSON.parse(fs.readFileSync(access.manifestPath, 'utf8'))).toMatchObject({
        kind: 'lumi.task-regression-isolation',
        schemaVersion: 3,
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'repeated_confirmation_exactly_once',
          phases: [{
            phaseId: 'truth',
            requestId: 'reg_environment_test_request',
          }],
        }],
        desktopRelayTargets: [{
          scenarioId: 'repeated_confirmation_exactly_once',
          relativePath: 'confirm-exactly-once.txt',
          contentSha256: crypto.createHash('sha256').update(relayContent).digest('hex'),
          encoding: 'utf-8',
          overwritePolicy: 'fail_if_exists',
        }],
      });
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
      await removeIsolatedRegressionSandbox(sandbox);
    }
  });

  it('registers S6 and seals accepted STT to the co-located loopback stub', async () => {
    expect(IMPLEMENTED_BLACK_BOX_SCENARIOS).toContain('voice_to_text_continuation');
    expect(new Set(IMPLEMENTED_BLACK_BOX_SCENARIOS).size)
      .toBe(IMPLEMENTED_BLACK_BOX_SCENARIOS.length);

    const tempBase = makeTempBase('lumi-regression-s6-stt');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const transcript = '[LUMI_REGRESSION:S6:VOICE] 请在桌面查找 s6-missing.txt';
    const runId = 'task_regression_candidate_s6_stt_boundary';
    const access = await provisionTaskRegressionEvidenceAccess(sandbox, runId, {
      buildIdentityDigest: 'c'.repeat(64),
      snapshotBindings: [{
        scenarioId: 'voice_to_text_continuation',
        phases: [{ phaseId: 'text_continue', requestId: 'reg_s6_text_continue' }],
      }],
      desktopRelayTargets: [],
    });
    const stubOptions = {
      evidenceAccess: access,
      confirmationArtifact: path.join(sandbox.artifacts, 'confirmed.txt'),
      confirmationContent: 'exact',
      staleFixture: path.join(sandbox.artifacts, 'fixture.txt'),
      s6SttTranscript: transcript,
    };
    await expect(startDeterministicRegressionModelStub({
      ...stubOptions,
      evidenceAccess: undefined,
    })).rejects.toThrow('regression_stt_access_required');
    await expect(startDeterministicRegressionModelStub({
      ...stubOptions,
      evidenceAccess: { ...access, proof: crypto.randomBytes(48).toString('base64url') },
    })).rejects.toThrow('regression_stt_access_manifest_binding_invalid');
    await expect(startDeterministicRegressionModelStub({
      ...stubOptions,
      evidenceAccess: { ...access, sttCredential: crypto.randomBytes(48).toString('base64url') },
    })).rejects.toThrow('regression_stt_access_manifest_binding_invalid');
    await expect(startDeterministicRegressionModelStub({
      ...stubOptions,
      evidenceAccess: { ...access, buildIdentityDigest: 'd'.repeat(64) },
    })).rejects.toThrow('regression_stt_access_manifest_binding_invalid');
    await expect(startDeterministicRegressionModelStub({
      ...stubOptions,
      evidenceAccess: { ...access, manifestPath: sandbox.dotenvPath },
    })).rejects.toThrow('regression_stt_access_manifest_invalid');
    const stub = await startDeterministicRegressionModelStub({
      ...stubOptions,
    });
    try {
      const env = buildSanitizedRegressionEnvironment({
        sandbox,
        port: 32123,
        modelStubBaseUrl: stub.baseUrl,
        sttStubUrl: stub.sttWsUrl,
        evidenceAccess: access,
      });
      expect(env.DOUBAO_SPEECH_KEY).toBe(access.sttCredential);
      expect(env.LUMI_TASK_REGRESSION_STT_ACCESS_SHA256).toBe(access.sttCredentialSha256);
      expect(access.sttCredential).toMatch(/^[A-Za-z0-9_-]{64}$/u);
      expect(access.sttCredential).not.toBe(access.proof);
      expect(access.sttCredential).not.toBe(access.desktopRelayProof);
      expect(env.DOUBAO_ASR_WS_URL).toBe(stub.sttWsUrl);
      expect(env.DOUBAO_TTS_V3_URL).toBe(`${stub.baseUrl}/disabled-tts`);
      const manifestText = fs.readFileSync(access.manifestPath, 'utf8');
      expect(manifestText).not.toContain(access.sttCredential);
      expect(manifestText).not.toContain(access.proof);
      expect(manifestText).toContain(access.sttCredentialSha256);
      for (const invalidUrl of [
        'wss://127.0.0.1:443/asr',
        `ws://localhost:${stub.port}/asr`,
        `ws://127.0.0.1:${stub.port}/wrong`,
        `ws://127.0.0.1:${stub.port}/asr?proof=forged`,
        `ws://127.0.0.1:${stub.port + 1}/asr`,
      ]) {
        expect(() => buildSanitizedRegressionEnvironment({
          sandbox,
          port: 32123,
          modelStubBaseUrl: stub.baseUrl,
          sttStubUrl: invalidUrl,
          evidenceAccess: access,
        })).toThrow('regression_stt_stub_url_invalid');
      }
      expect(() => buildSanitizedRegressionEnvironment({
        sandbox,
        port: 32123,
        modelStubBaseUrl: stub.baseUrl,
        sttStubUrl: stub.sttWsUrl,
        evidenceAccess: { ...access, sttCredential: crypto.randomBytes(48).toString('base64url') },
      })).toThrow('regression_stt_access_invalid');

      const rejectedUpgrade = (url: string, suppliedKey?: string): Promise<number> => new Promise((resolve, reject) => {
        const candidate = new WebSocket(url, {
          headers: suppliedKey ? { 'X-Api-Key': suppliedKey } : {},
        });
        const timer = setTimeout(() => {
          candidate.terminate();
          reject(new Error('S6 rejected upgrade timeout'));
        }, 3_000);
        candidate.once('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          const status = response.statusCode || 0;
          response.resume();
          resolve(status);
        });
        candidate.once('error', () => {
          clearTimeout(timer);
          resolve(0);
        });
        candidate.once('open', () => {
          clearTimeout(timer);
          candidate.terminate();
          reject(new Error('S6 invalid STT upgrade unexpectedly opened'));
        });
      });
      await expect(rejectedUpgrade(stub.sttWsUrl)).resolves.toBe(401);
      await expect(rejectedUpgrade(
        stub.sttWsUrl,
        crypto.randomBytes(48).toString('base64url'),
      )).resolves.toBe(401);
      await expect(rejectedUpgrade(
        `ws://127.0.0.1:${stub.port}/wrong`,
        access.sttCredential,
      )).resolves.toBe(0);
      expect(stub.sttCaptures).toEqual([]);

      const socket = new WebSocket(stub.sttWsUrl, {
        headers: {
          'X-Api-Key': access.sttCredential,
          'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
          'X-Api-Connect-Id': crypto.randomUUID(),
        },
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('S6 STT loopback protocol timeout')), 5_000);
        let responseCount = 0;
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.removeAllListeners();
          if (error) reject(error);
          else resolve();
        };
        socket.once('error', finish);
        socket.once('open', () => socket.send(Buffer.from([0x11, 0x10, 0x10, 0x00])));
        socket.on('message', () => {
          responseCount += 1;
          if (responseCount === 1) {
            socket.send(Buffer.from([0x11, 0x20, 0x10, 0x00, 0x01]));
            return;
          }
          socket.close();
          finish();
        });
      });
      expect(stub.sttCaptures).toEqual([expect.objectContaining({
        authorizedWithIsolatedCredential: true,
        resourceIdPresent: true,
        connectIdPresent: true,
        handshakeReceived: true,
        audioFrameCount: 1,
        finalTranscriptSha256: crypto.createHash('sha256').update(transcript).digest('hex'),
        finalDeliveredAt: expect.any(String),
      })]);
    } finally {
      await stub.close();
      await removeIsolatedRegressionSandbox(sandbox);
    }
  });

  it('pins the backend Ed25519 signer once before the real S6 runner can enter its phase', async () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/lib/task-regression-black-box-runner.mjs'),
      'utf8',
    );
    const pinIndex = source.indexOf(
      'serverTruthContract = await pinTaskRegressionServerTruthSigner',
    );
    const phaseIndex = source.indexOf(
      'SCENARIO_RUNNERS.get(scenarioId)(context)',
      pinIndex,
    );
    expect(pinIndex).toBeGreaterThan(0);
    expect(phaseIndex).toBeGreaterThan(pinIndex);

    const tempBase = makeTempBase('lumi-regression-s6-signer-pin');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const acceptanceRunId = 'task_regression_candidate_s6_signer_pin';
    const buildIdentityDigest = 'd'.repeat(64);
    const evidenceAccess = await provisionTaskRegressionEvidenceAccess(
      sandbox,
      acceptanceRunId,
      {
        buildIdentityDigest,
        snapshotBindings: [{
          scenarioId: 'voice_to_text_continuation',
          phases: [{ phaseId: 'text_continue', requestId: 'reg_s6_signer_text' }],
        }],
        desktopRelayTargets: [],
      },
    );
    const normalizedDataRoot = process.platform === 'win32'
      ? path.normalize(path.resolve(sandbox.dataRoot)).toLocaleLowerCase('en-US')
      : path.normalize(path.resolve(sandbox.dataRoot));
    const dataRootIdentitySha256 = crypto.createHash('sha256')
      .update('lumi-portable-evidence-data-root-v1\0', 'utf8')
      .update(normalizedDataRoot, 'utf8')
      .digest('hex');
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' });
    const signer = {
      kind: 'lumi.voice-text-continuation-truth-signer',
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: crypto.createHash('sha256')
        .update('lumi-voice-text-continuation-truth-ed25519-key-v1\0', 'utf8')
        .update(publicKeySpki)
        .digest('hex'),
      publicKeySpkiBase64: publicKeySpki.toString('base64'),
      serverInstanceNonce: crypto.randomBytes(32).toString('base64url'),
      acceptanceRunId,
      buildIdentityDigest,
      dataRootIdentitySha256,
    };
    let signerPinned = false;
    let signerRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url === `/api${DEFAULT_TRUTH_SNAPSHOT_ENDPOINT}`) {
        response.statusCode = signerPinned ? 200 : 409;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(signerPinned ? { ok: true } : {
          error: 'Server truth signer must be pinned before S6 capture',
        }));
        return;
      }
      if (request.url !== `/api${DEFAULT_SERVER_TRUTH_SIGNER_ENDPOINT}`) {
        response.statusCode = 404;
        response.end('{}');
        return;
      }
      signerRequests += 1;
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        if (signerPinned) {
          response.statusCode = 409;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ error: 'already bootstrapped' }));
          return;
        }
        expect(request.headers.authorization).toBe('Bearer isolated-admin-token');
        expect(request.headers['x-lumi-task-regression-signer-bootstrap'])
          .toBe(evidenceAccess.signerBootstrap);
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          .toEqual({ acceptanceRunId });
        signerPinned = true;
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          kind: 'lumi.task-regression-server-truth-signer-info',
          schemaVersion: 1,
          signer,
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    try {
      const before = await fetch(`${baseUrl}${DEFAULT_TRUTH_SNAPSHOT_ENDPOINT}`, {
        method: 'POST',
      });
      expect(before.status).toBe(409);
      const contract = await pinTaskRegressionServerTruthSigner({
        baseUrl,
        token: 'isolated-admin-token',
        acceptanceRunId,
        buildIdentityDigest,
        dataRoot: sandbox.dataRoot,
        evidenceAccess,
      });
      expect(contract).toMatchObject({
        kind: 'lumi.task-regression-server-truth-contract',
        pinScope: 'before_voice_to_text_continuation_phase',
        acceptanceRunId,
        buildIdentityDigest,
        dataRootIdentitySha256,
        signer,
      });
      expect(contract.contractSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(signerRequests).toBe(1);
      const after = await fetch(`${baseUrl}${DEFAULT_TRUTH_SNAPSHOT_ENDPOINT}`, {
        method: 'POST',
      });
      expect(after.status).toBe(200);
      await expect(pinTaskRegressionServerTruthSigner({
        baseUrl,
        token: 'isolated-admin-token',
        acceptanceRunId,
        buildIdentityDigest,
        dataRoot: sandbox.dataRoot,
        evidenceAccess,
      })).rejects.toThrow('regression_local_api_http_409');
      expect(signerRequests).toBe(2);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await removeIsolatedRegressionSandbox(sandbox);
    }
  });

  it('registers S8 with a distinct refused primary and a two-round LM Studio tool continuation', async () => {
    expect(IMPLEMENTED_BLACK_BOX_SCENARIOS).toContain('primary_model_failover_lmstudio');
    const tempBase = makeTempBase('lumi-regression-s8-failover');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    const fixturePath = path.join(sandbox.artifacts, 's8-fixture.txt');
    const sentinel = 'S8_CHAT_TASK_VERIFIED_STUB_TEST';
    const finalText = `The exact verified marker is ${sentinel}.`;
    fs.writeFileSync(fixturePath, sentinel, { encoding: 'utf8', flag: 'wx' });
    const stub = await startDeterministicRegressionModelStub({
      confirmationArtifact: path.join(sandbox.artifacts, 'confirmed.txt'),
      confirmationContent: 'exact',
      staleFixture: path.join(sandbox.artifacts, 'stale.txt'),
      s8FixturePath: fixturePath,
      s8FixtureContent: sentinel,
      s8FinalText: finalText,
    });
    try {
      const primaryPort = await reserveLoopbackPort();
      expect(primaryPort).not.toBe(stub.port);
      await expect(verifyLoopbackConnectionRefused(primaryPort)).resolves.toMatchObject({
        host: '127.0.0.1',
        port: primaryPort,
        code: 'ECONNREFUSED',
      });
      const primaryBaseUrl = `http://127.0.0.1:${primaryPort}/v1`;
      const runId = 'task_regression_candidate_s8_manifest_test';
      const bindings = truthSnapshotBindings(runId, ['primary_model_failover_lmstudio']);
      expect(bindings).toEqual([{
        scenarioId: 'primary_model_failover_lmstudio',
        phases: [{
          phaseId: 'failover',
          requestId: expect.stringMatching(/^reg_[a-f0-9]{28}$/),
        }],
      }]);
      const access = await provisionTaskRegressionEvidenceAccess(sandbox, runId, {
        buildIdentityDigest: 'b'.repeat(64),
        snapshotBindings: bindings,
        desktopRelayTargets: [],
      });
      const env = buildSanitizedRegressionEnvironment({
        sandbox,
        port: 32123,
        modelStubBaseUrl: stub.baseUrl,
        primaryFailureBaseUrl: primaryBaseUrl,
        evidenceAccess: access,
      });
      expect(env.DEEPSEEK_API_KEY).toBe('lumi-regression-local-primary-only');
      expect(env.DEEPSEEK_API_KEY).not.toBe(process.env.DEEPSEEK_API_KEY);
      expect(env.DEEPSEEK_BASE_URL).toBe(primaryBaseUrl);
      expect(env.LMSTUDIO_BASE_URL).toBe(`${stub.baseUrl}/v1`);
      expect(env.DEEPSEEK_BASE_URL).not.toContain(`:${stub.port}/`);
      expect(() => buildSanitizedRegressionEnvironment({
        sandbox,
        port: 32123,
        modelStubBaseUrl: stub.baseUrl,
        primaryFailureBaseUrl: 'https://api.deepseek.com/v1',
      })).toThrow('regression_primary_failure_url_invalid');

      const first = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{
          role: 'user',
          content: `[LUMI_REGRESSION:S8] Inspect ${fixturePath} with read_file.`,
        }],
        tools: [{
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
        }],
      });
      const call = first.body.choices[0].message.tool_calls[0];
      expect(call.function).toEqual({
        name: 'read_file',
        arguments: JSON.stringify({ path: fixturePath }),
      });
      const second = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{
          role: 'user',
          content: `[LUMI_REGRESSION:S8] Inspect ${fixturePath} with read_file.`,
        }, {
          role: 'assistant',
          content: null,
          tool_calls: [call],
        }, {
          role: 'tool',
          name: 'read_file',
          tool_call_id: call.id,
          content: sentinel,
        }],
        tools: [{
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
        }],
      });
      expect(second.body.choices[0].message.content).toBe(finalText);
      expect(stub.requests.filter(item => item.scenarioId === 'primary_model_failover_lmstudio'))
        .toEqual([
          expect.objectContaining({
            providerBoundary: 'lmstudio',
            containsS8FixtureContent: false,
            pairedAssistantToolCallAndReceipt: false,
          }),
          expect.objectContaining({
            providerBoundary: 'lmstudio',
            containsS8FixtureContent: true,
            pairedAssistantToolCallAndReceipt: true,
            pairedAssistantToolCallCount: 1,
            pairedToolReceiptCount: 1,
          }),
        ]);
      expect(stub.decisions.slice(-2)).toEqual([
        expect.objectContaining({ type: 'tool', toolName: 'read_file' }),
        expect.objectContaining({
          type: 'text',
          verifiedFixtureContent: true,
          verifiedToolContinuation: true,
        }),
      ]);
    } finally {
      await stub.close();
      await removeIsolatedRegressionSandbox(sandbox);
    }
  });

  it('fails closed before provisioning an evidence manifest with ambiguous provenance', async () => {
    const tempBase = makeTempBase('lumi-regression-provenance');
    const sandbox = await createIsolatedRegressionSandbox({ tempBase, protectedRoots: [] });
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'not-a-digest',
        snapshotBindings: [{
          scenarioId: 'repeated_confirmation_exactly_once',
          requestId: 'reg_provenance_request',
        }],
      },
    )).rejects.toThrow('regression_evidence_build_identity_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'repeated_confirmation_exactly_once',
          requestId: 'reg_provenance_request',
        }, {
          scenarioId: 'cleanup_offer_then_cleanup',
          requestId: 'reg_provenance_request',
        }],
      },
    )).rejects.toThrow('regression_evidence_snapshot_bindings_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'control_stop_status_repeat',
          phases: ['long', 'stop', 'status'].map(phaseId => ({
            phaseId,
            requestId: `reg_control_${phaseId}`,
          })),
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_evidence_control_phases_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'control_stop_status_repeat',
          phases: ['long', 'stop', 'status', 'repeat'].map(phaseId => ({
            phaseId,
            requestId: 'reg_control_duplicate_request',
          })),
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_evidence_snapshot_bindings_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'displayed_result_stale_receipt',
          phases: [{ phaseId: 'display', requestId: 'reg_stale_display_only' }],
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_evidence_stale_receipt_phases_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'mid_task_restart_recovery',
          phases: [{ phaseId: 'prepare', requestId: 'reg_restart_prepare_only' }],
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_evidence_restart_phases_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'voice_to_text_continuation',
          phases: [{ phaseId: 'continue', requestId: 'reg_voice_legacy_continue' }],
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_evidence_voice_text_phases_invalid');
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'wps_wrong_file_correction',
          phases: ['anchor', 'correction'].map(phaseId => ({
            phaseId,
            requestId: `reg_wps_${phaseId}`,
          })),
        }],
        desktopRelayTargets: [],
      },
    )).rejects.toThrow('regression_evidence_wps_phases_invalid');

    const loneWpsFixture = 'WPS-Provenance-Draft.pptx';
    const loneWpsContent = 'WPS provenance fixture';
    fs.writeFileSync(path.join(sandbox.artifacts, loneWpsFixture), loneWpsContent, {
      encoding: 'utf8', flag: 'wx',
    });
    await expect(provisionTaskRegressionEvidenceAccess(
      sandbox,
      'task_regression_candidate_provenance_test',
      {
        buildIdentityDigest: 'a'.repeat(64),
        snapshotBindings: [{
          scenarioId: 'wps_wrong_file_correction',
          phases: ['anchor', 'correction', 'supply-filename'].map(phaseId => ({
            phaseId,
            requestId: `reg_wps_${phaseId}`,
          })),
        }],
        desktopRelayTargets: [{
          scenarioId: 'wps_wrong_file_correction',
          relativePath: loneWpsFixture,
          contentSha256: crypto.createHash('sha256').update(loneWpsContent).digest('hex'),
          encoding: 'utf-8',
          overwritePolicy: 'read_only',
        }],
      },
    )).rejects.toThrow('regression_evidence_wps_semantic_targets_invalid');
    expect(fs.existsSync(path.join(sandbox.root, 'task-regression-evidence.json'))).toBe(false);
  });

  it('records the real provider-boundary payload and fails closed when a requested tool was not declared', async () => {
    const tempBase = makeTempBase('lumi-regression-stub');
    const confirmationArtifact = path.join(tempBase, 'confirmed.txt');
    const staleFixture = path.join(tempBase, 'fixture.txt');
    const stalePendingFixture = path.join(tempBase, 'stale-next-step.txt');
    const staleFixtureContent = 'visible-result:stub-test';
    const wpsCorrectName = 'WPS-Stub-Final.pptx';
    const wpsCorrectPath = path.join(tempBase, wpsCorrectName);
    const wpsCorrectContent = 'CORRECT-WPS-CONTENT:stub-test:verified revenue 42';
    fs.writeFileSync(staleFixture, staleFixtureContent, 'utf8');
    const stub = await startDeterministicRegressionModelStub({
      confirmationArtifact,
      confirmationContent: 'exact',
      staleFixture,
      staleFixtureContent,
      stalePendingFixture,
      wpsCorrectName,
      wpsCorrectPath,
      wpsCorrectContent,
      wpsCorrectSummary: '已核对的营收数字是 42',
    });
    try {
      const response = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{ role: 'user', content: '[LUMI_REGRESSION:S2] prepare' }],
        tools: [],
      });
      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toContain('没有声明 desktop_write_text_file');
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toMatchObject({
        captureOrigin: 'provider_dispatch_boundary',
        modelInvoked: true,
        model: 'lumi-regression-stub-v1',
        messageCount: 1,
      });
      expect(stub.requests[0].payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(stub.decisions[0]).toMatchObject({ missingDeclaredTool: 'desktop_write_text_file' });

      const liveOwner = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{ role: 'user', content: '[LUMI_REGRESSION:S4:LIVE] next task' }],
        tools: [{
          type: 'function',
          function: {
            name: 'desktop_write_text_file',
            parameters: { type: 'object', properties: {} },
          },
        }],
      });
      expect(liveOwner.status).toBe(200);
      expect(liveOwner.body.choices[0].message.tool_calls[0].function).toMatchObject({
        name: 'desktop_write_text_file',
        arguments: JSON.stringify({
          path: stalePendingFixture,
          content: 'stale receipt live-owner sentinel',
          encoding: 'utf-8',
          overwritePolicy: 'fail_if_exists',
        }),
      });
      expect(stub.decisions[1]).toMatchObject({
        type: 'tool',
        toolName: 'desktop_write_text_file',
      });

      const displayed = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          { role: 'user', content: '[LUMI_REGRESSION:S4] read fixture' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call-read' }] },
          { role: 'tool', content: '[LUMI TERMINAL VERIFICATION] status=verified' },
        ],
        tools: [],
      });
      expect(displayed.status).toBe(200);
      expect(displayed.body.choices[0].message.content).toContain(staleFixtureContent);

      const suppliedWpsFilename = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{
          role: 'user',
          content: '[LUMI_REGRESSION:S3] 请分析当前 WPS 文件。',
        }, {
          role: 'assistant',
          content: '请补充准确文件名。',
        }, {
          role: 'user',
          content: `准确文件名是 ${wpsCorrectName}，在桌面。请继续分析。`,
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'desktop_list_files',
            parameters: { type: 'object', properties: {} },
          },
        }],
      });
      expect(suppliedWpsFilename.status).toBe(200);
      expect(suppliedWpsFilename.body.choices[0].message.tool_calls[0].function).toMatchObject({
        name: 'desktop_list_files',
        arguments: JSON.stringify({ path: '~/Desktop', limit: 100 }),
      });

      const extraction = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          { role: 'user', content: '[LUMI_REGRESSION:S3] 请分析当前 WPS 文件。' },
          { role: 'tool', name: 'desktop_list_files', content: JSON.stringify([{ name: wpsCorrectName, path: wpsCorrectPath }]) },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'extract_document_text',
            parameters: { type: 'object', properties: {} },
          },
        }],
      });
      expect(extraction.body.choices[0].message.tool_calls[0].function).toMatchObject({
        name: 'extract_document_text',
        arguments: JSON.stringify({ filePath: wpsCorrectPath }),
      });

      const failedExtraction = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          { role: 'user', content: '[LUMI_REGRESSION:S3] 请分析当前 WPS 文件。' },
          { role: 'tool', name: 'extract_document_text', content: 'Error: File not found' },
        ],
        tools: [],
      });
      expect(failedExtraction.body.choices[0].message.content).toContain('内容提取没有成功');
      expect(failedExtraction.body.choices[0].message.content).not.toContain('营收数字是 42');
      expect(stub.decisions.at(-1)).toMatchObject({
        type: 'text',
        verifiedFixtureContent: false,
      });

      const verifiedExtraction = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          { role: 'user', content: '[LUMI_REGRESSION:S3] 请分析当前 WPS 文件。' },
          { role: 'tool', name: 'extract_document_text', content: wpsCorrectContent },
        ],
        tools: [],
      });
      expect(verifiedExtraction.body.choices[0].message.content).toContain('营收数字是 42');
      expect(stub.decisions.at(-1)).toMatchObject({
        type: 'text',
        verifiedFixtureContent: true,
      });

      const s1Status = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{
          role: 'user',
          content: '[LUMI_REGRESSION:S1] 后台工作现在怎么样？',
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'runtime_work_status',
            parameters: { type: 'object', properties: {} },
          },
        }],
      });
      expect(s1Status.body.choices[0].message.tool_calls).toHaveLength(1);
      expect(s1Status.body.choices[0].message.tool_calls[0].function).toMatchObject({
        name: 'runtime_work_status',
        arguments: JSON.stringify({}),
      });

      const s1Offer = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          { role: 'user', content: '[LUMI_REGRESSION:S1] 后台工作现在怎么样？' },
          { role: 'tool', name: 'runtime_work_status', content: JSON.stringify({
            ok: true,
            status: 'active',
            activeCount: 2,
            items: [{ id: 'A' }, { id: 'B' }],
          }) },
        ],
        tools: [],
      });
      expect(s1Offer.body.choices[0].message.content).toMatch(/清理.*后台任务/u);

      const s1AcceptanceFallback = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          { role: 'user', content: '[LUMI_REGRESSION:S1] 后台工作现在怎么样？' },
          { role: 'assistant', content: '要不要我帮你清理这些后台任务？' },
          { role: 'user', content: '清理一下' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'runtime_work_cancel',
            parameters: { type: 'object', properties: {} },
          },
        }],
      });
      expect(s1AcceptanceFallback.body.choices[0].message.tool_calls).toBeUndefined();
      expect(s1AcceptanceFallback.body.choices[0].message.content)
        .toContain('模型不得重新快照或重建这次清理目标');
    } finally {
      await stub.close();
    }
  });

  it('rejects verification-only prose as proof that the exact read result was displayed', () => {
    const requestId = 'request-display-result';
    const taskId = 'task-display-result';
    const receiptId = 'receipt-display-result';
    const targetSha256 = 'b'.repeat(64);
    const expectedContent = 'visible-result:expected-run';
    const verificationOnly = '[LUMI TERMINAL VERIFICATION] status=verified';
    const displayState = {
      task: {
        taskId,
        receipts: [{
          receiptId,
          requestId,
          toolName: 'read_file',
          verification: 'verified',
          outcome: 'verified_success',
          targetSha256,
        }],
      },
      transcript: [{
        role: 'assistant',
        requestId,
        textSha256: crypto.createHash('sha256').update(verificationOnly).digest('hex'),
        textCharCount: verificationOnly.length,
        toolCalls: [{
          name: 'read_file',
          requestId,
          taskId,
          targetSha256,
          terminalVerificationStatus: 'verified',
        }],
      }],
    };
    const verificationOnlyEvidence = evaluateDisplayedResultEvidence({
      requestId,
      expectedContent,
      display: {
        terminal: {
          finalized: true,
          blocked: false,
          timedOut: false,
          text: verificationOnly,
          textSha256: crypto.createHash('sha256').update(verificationOnly).digest('hex'),
          textCharCount: verificationOnly.length,
        },
      },
      displayState,
    });
    expect(verificationOnlyEvidence).toMatchObject({
      observed: false,
      expectedContentSha256: crypto.createHash('sha256').update(expectedContent).digest('hex'),
      receiptIds: [receiptId],
    });

    const visibleText = `已显示真实读取结果：${expectedContent}`;
    const visibleState = structuredClone(displayState);
    visibleState.transcript[0].textSha256 = crypto.createHash('sha256')
      .update(visibleText)
      .digest('hex');
    visibleState.transcript[0].textCharCount = visibleText.length;
    expect(evaluateDisplayedResultEvidence({
      requestId,
      expectedContent,
      display: {
        terminal: {
          finalized: true,
          blocked: false,
          timedOut: false,
          text: visibleText,
          textSha256: visibleState.transcript[0].textSha256,
          textCharCount: visibleText.length,
        },
      },
      displayState: visibleState,
    })).toMatchObject({
      observed: true,
      expectedContentSha256: crypto.createHash('sha256').update(expectedContent).digest('hex'),
      receiptIds: [receiptId],
    });
  });

  it('binds S6 provider evidence to the current user turn when history contains S5', async () => {
    const tempBase = makeTempBase('lumi-regression-s6-after-s5');
    const missingPath = path.join(tempBase, 's6-missing.txt');
    const correctPath = path.join(tempBase, 's6-correct.txt');
    const correctContent = 'S6 current-turn binding fixture';
    const stub = await startDeterministicRegressionModelStub({
      confirmationArtifact: path.join(tempBase, 'confirmed.txt'),
      confirmationContent: 'exact',
      staleFixture: path.join(tempBase, 'fixture.txt'),
      s6MissingPath: missingPath,
      s6SearchDirectory: tempBase,
      s6CorrectPath: correctPath,
      s6CorrectContent: correctContent,
    });
    const currentText = `[LUMI_REGRESSION:S6:TEXT] 纠正一下：不是 ${missingPath}，而是 ${correctPath}。`;
    const priorHistory = [
      { role: 'user', content: '[LUMI_REGRESSION:S5:LONG] stale prior task' },
      { role: 'assistant', content: 'stale S5 assistant history' },
      { role: 'user', content: currentText },
    ];
    try {
      const search = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: priorHistory,
        tools: [{
          type: 'function',
          function: { name: 'search_files', parameters: { type: 'object', properties: {} } },
        }],
      });
      expect(search.status).toBe(200);
      expect(search.body.choices[0].message.tool_calls[0].function).toMatchObject({
        name: 'search_files',
      });
      expect(stub.requests[0]).toMatchObject({
        scenarioId: 'voice_to_text_continuation',
        containsVoiceMissingTarget: true,
        containsCorrectTarget: true,
      });
      expect(stub.decisions[0]).toMatchObject({
        scenarioId: 'voice_to_text_continuation',
        logicalTool: 'search_files',
      });

      const read = await postJson(`${stub.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [
          ...priorHistory,
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-s6-search-after-s5',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            }],
          },
          { role: 'tool', name: 'search_files', content: JSON.stringify([correctPath]) },
        ],
        tools: [{
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
        }],
      });
      expect(read.status).toBe(200);
      expect(read.body.choices[0].message.tool_calls[0].function).toMatchObject({
        name: 'read_file',
        arguments: JSON.stringify({ path: correctPath }),
      });
      expect(stub.requests.map(item => item.scenarioId)).toEqual([
        'voice_to_text_continuation',
        'voice_to_text_continuation',
      ]);
      expect(stub.decisions[1]).toMatchObject({
        scenarioId: 'voice_to_text_continuation',
        logicalTool: 'read_file',
      });
      expect(stub.requests.some(item => item.scenarioId === 'control_stop_status_repeat')).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it('keeps delayed provider work alive after request upload and cancels only on response abort', async () => {
    const tempBase = makeTempBase('lumi-regression-stub-delay');
    const options = {
      confirmationArtifact: path.join(tempBase, 'confirmed.txt'),
      confirmationContent: 'exact',
      staleFixture: path.join(tempBase, 'fixture.txt'),
    };
    const completing = await startDeterministicRegressionModelStub({
      ...options,
      longDelayMs: 120,
    });
    try {
      const startedAt = Date.now();
      const response = await postJson(`${completing.baseUrl}/v1/chat/completions`, {
        model: 'lumi-regression-stub-v1',
        stream: false,
        messages: [{ role: 'user', content: '[LUMI_REGRESSION:S5:LONG] wait' }],
        tools: [],
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
      expect(response.status).toBe(200);
      expect(completing.requests[0]).toMatchObject({
        scenarioId: 'control_stop_status_repeat',
        scheduledDelayMs: 120,
        deliveredAt: expect.any(String),
      });
      expect(completing.requests[0].abortedAt).toBeUndefined();
    } finally {
      await completing.close();
    }

    const cancelling = await startDeterministicRegressionModelStub({
      ...options,
      longDelayMs: 1_000,
    });
    try {
      const controller = new AbortController();
      const request = fetch(`${cancelling.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'lumi-regression-stub-v1',
          stream: false,
          messages: [{ role: 'user', content: '[LUMI_REGRESSION:S5:LONG] cancel' }],
          tools: [],
        }),
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 60);
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(cancelling.requests).toHaveLength(1);
      expect(cancelling.requests[0]).toMatchObject({
        scheduledDelayMs: 1_000,
        abortedAt: expect.any(String),
      });
      expect(cancelling.requests[0].deliveredAt).toBeUndefined();
    } finally {
      await cancelling.close();
    }
  });

  it.each([0, 27])(
    'evaluates the S5 provider witness relative to a %i-request scenario baseline',
    providerRequestBaseline => {
      const noise = Array.from({ length: providerRequestBaseline }, (_, index) => ({
        scenarioId: 'earlier_scenario',
        receivedAt: `2026-08-27T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        deliveredAt: `2026-08-27T00:00:${String(index % 60).padStart(2, '0')}.001Z`,
      }));
      const capture = {
        scenarioId: 'control_stop_status_repeat',
        receivedAt: '2026-08-27T00:01:00.000Z',
        scheduledDelayMs: 15_000,
        abortedAt: '2026-08-27T00:01:00.050Z',
      };

      expect(evaluateControlProviderWitness({
        providerCaptures: [...noise, capture],
        providerRequestBaseline,
        scenarioCompletedAt: '2026-08-27T00:01:00.221Z',
      })).toMatchObject({
        bounded: true,
        captureIndex: providerRequestBaseline,
        expectedCaptureIndex: providerRequestBaseline,
        scenarioCaptureIndex: 0,
        expectedScenarioCaptureIndex: 0,
        providerRequestBaseline,
        providerRequestCount: providerRequestBaseline + 1,
        scenarioProviderRequestCount: 1,
        scheduledDelayMs: 15_000,
        abortedAt: capture.abortedAt,
        deliveredAt: '',
        providerCaptureToCompletionMs: 221,
        maximumProviderCaptureToCompletionMs: 5_000,
      });
    },
  );

  it.each([
    ['an extra provider request precedes S5 inside the scenario window', [
      { scenarioId: 'unexpected_scenario', receivedAt: '2026-08-27T00:01:00.000Z' },
      {
        scenarioId: 'control_stop_status_repeat',
        receivedAt: '2026-08-27T00:01:00.010Z',
        scheduledDelayMs: 15_000,
        abortedAt: '2026-08-27T00:01:00.050Z',
      },
    ], '2026-08-27T00:01:00.221Z'],
    ['the S5 capture is duplicated', [
      {
        scenarioId: 'control_stop_status_repeat',
        receivedAt: '2026-08-27T00:01:00.000Z',
        scheduledDelayMs: 15_000,
        abortedAt: '2026-08-27T00:01:00.050Z',
      },
      {
        scenarioId: 'control_stop_status_repeat',
        receivedAt: '2026-08-27T00:01:00.010Z',
        scheduledDelayMs: 15_000,
        abortedAt: '2026-08-27T00:01:00.060Z',
      },
    ], '2026-08-27T00:01:00.221Z'],
    ['the scheduled delay is weakened', [{
      scenarioId: 'control_stop_status_repeat',
      receivedAt: '2026-08-27T00:01:00.000Z',
      scheduledDelayMs: 14_999,
      abortedAt: '2026-08-27T00:01:00.050Z',
    }], '2026-08-27T00:01:00.221Z'],
    ['the provider request was not aborted', [{
      scenarioId: 'control_stop_status_repeat',
      receivedAt: '2026-08-27T00:01:00.000Z',
      scheduledDelayMs: 15_000,
    }], '2026-08-27T00:01:00.221Z'],
    ['the cancelled provider response was delivered', [{
      scenarioId: 'control_stop_status_repeat',
      receivedAt: '2026-08-27T00:01:00.000Z',
      scheduledDelayMs: 15_000,
      abortedAt: '2026-08-27T00:01:00.050Z',
      deliveredAt: '2026-08-27T00:01:00.100Z',
    }], '2026-08-27T00:01:00.221Z'],
    ['completion exceeds the five-second bound', [{
      scenarioId: 'control_stop_status_repeat',
      receivedAt: '2026-08-27T00:01:00.000Z',
      scheduledDelayMs: 15_000,
      abortedAt: '2026-08-27T00:01:00.050Z',
    }], '2026-08-27T00:01:05.001Z'],
  ])('fails closed when %s', (_label, providerCaptures, scenarioCompletedAt) => {
    expect(evaluateControlProviderWitness({
      providerCaptures,
      providerRequestBaseline: 0,
      scenarioCompletedAt,
    }).bounded).toBe(false);
  });

  it('cleans the sandbox after a target-runtime failure and never reports a passing matrix', async () => {
    const tempBase = makeTempBase('lumi-regression-failure-cleanup');
    const repository = path.join(tempBase, 'repo');
    const sandboxParent = path.join(tempBase, 'sandboxes');
    fs.mkdirSync(repository);
    fs.mkdirSync(sandboxParent);
    fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({
      name: 'isolated-regression-fixture', version: '1.0.0', type: 'module',
    }), 'utf8');
    fs.writeFileSync(path.join(repository, 'server.ts'), 'export {};\n', 'utf8');
    execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Regression Test'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'regression@example.invalid'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' });

    const report: any = await runTaskRegressionBlackBoxProbe({
      worktree: repository,
      role: 'baseline',
      tempBase: sandboxParent,
      protectedRoots: [],
      scenarios: ['cleanup_offer_then_cleanup'],
      startupTimeoutMs: 10_000,
      turnTimeoutMs: 5_000,
    });
    expect(report.fatal?.code).toBe('regression_target_dependencies_missing');
    expect(report.summary).toMatchObject({ matrixRunProduced: false, overallPassed: false });
    expect(report.matrixRun).toBeNull();
    expect(report.matrixAssembly).toMatchObject({
      status: 'rejected',
      acceptanceScope: 'isolated_backend_black_box_non_native',
      nativeClientEvidenceProduced: false,
      formalStage9AcceptanceProduced: false,
      issues: expect.arrayContaining(['probe_fatal']),
    });
    expect(assembleTaskRegressionRunFromProbe(report)).toMatchObject({
      ok: false,
      code: 'task_regression_matrix_assembly_rejected',
      issues: expect.arrayContaining([
        'probe_fatal',
        'exact_eight_scenarios_required',
        'exact_eight_scenario_results_required',
      ]),
    });
    expect(report.cleanup).toEqual({
      backendStopped: true,
      modelStubStopped: true,
      sandboxRemoved: true,
    });
    expect(fs.readdirSync(sandboxParent)).toEqual([]);
    expect(taskRegressionProbeExitCode(report)).toBe(1);

    const forgedSummary = structuredClone(report);
    delete forgedSummary.fatal;
    forgedSummary.summary.matrixRunProduced = true;
    forgedSummary.summary.overallPassed = true;
    forgedSummary.failClosed = { active: false };
    forgedSummary.matrixAssembly = {
      status: 'accepted',
      acceptanceScope: 'isolated_backend_black_box_non_native',
      nativeClientEvidenceProduced: false,
      formalStage9AcceptanceProduced: false,
      runSha256: '0'.repeat(64),
      probeEvidenceSha256: '1'.repeat(64),
    };
    forgedSummary.matrixRun = {};
    expect(taskRegressionProbeExitCode(forgedSummary)).toBe(2);
  });
});
