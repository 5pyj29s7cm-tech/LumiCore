import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORMAL_ACCEPTANCE_FILES,
  REDACTED_VALUE,
  atomicWriteJsonExclusive,
  createFormalAcceptanceEvidenceRun,
  pathIsInside,
  redactAcceptanceEvidence,
  sha256File,
} from '../scripts/lib/formal-acceptance-evidence.mjs';

const BUILD_ID = 'a'.repeat(40);
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const temporaryRoots: string[] = [];

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-formal-evidence-'));
  temporaryRoots.push(base);
  const evidenceRoot = path.join(base, 'evidence');
  const dataRoot = path.join(base, 'data');
  const profileRoot = path.join(base, 'webview-profile');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(profileRoot);
  return { base, evidenceRoot, dataRoot, profileRoot };
}

function createRun(overrides: Record<string, unknown> = {}) {
  const paths = fixture();
  const run = createFormalAcceptanceEvidenceRun({
    evidenceRoot: paths.evidenceRoot,
    buildId: BUILD_ID,
    dataRoot: paths.dataRoot,
    profile: { userDataDir: paths.profileRoot, channel: 'formal' },
    runtime: { buildId: BUILD_ID, pid: 100, startedAt: '2026-08-27T00:00:00.000Z' },
    client: { buildId: BUILD_ID, pid: 200, startedAt: '2026-08-27T00:00:01.000Z' },
    timestamp: '2026-08-27T01:02:03.004Z',
    randomMarker: '0123456789abcdef',
    ...overrides,
  });
  return { ...paths, run };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('formal acceptance evidence store', () => {
  it('requires absolute roots and creates one exclusive, path-contained run', () => {
    const paths = fixture();
    expect(() => createFormalAcceptanceEvidenceRun({
      evidenceRoot: 'relative-evidence',
      buildId: BUILD_ID,
      dataRoot: paths.dataRoot,
      profile: { userDataDir: paths.profileRoot },
      runtime: { buildId: BUILD_ID, pid: 1, startedAt: '2026-08-27T00:00:00.000Z' },
      client: { buildId: BUILD_ID, pid: 2, startedAt: '2026-08-27T00:00:01.000Z' },
    })).toThrow('absolute_evidence_root_required');

    const options = {
      evidenceRoot: paths.evidenceRoot,
      buildId: BUILD_ID,
      dataRoot: paths.dataRoot,
      profile: { userDataDir: paths.profileRoot },
      runtime: { buildId: BUILD_ID, pid: 1, startedAt: '2026-08-27T00:00:00.000Z' },
      client: { buildId: BUILD_ID, pid: 2, startedAt: '2026-08-27T00:00:01.000Z' },
      timestamp: '2026-08-27T01:02:03.004Z',
      randomMarker: 'fedcba9876543210',
    };
    const run = createFormalAcceptanceEvidenceRun(options);
    expect(pathIsInside(fs.realpathSync.native(paths.evidenceRoot), run.runDirectory)).toBe(true);
    expect(path.basename(run.runDirectory)).toBe(`${BUILD_ID}-20260827T010203004Z-fedcba9876543210`);
    expect(() => createFormalAcceptanceEvidenceRun(options)).toThrow('evidence_run_exists');
    expect(() => createFormalAcceptanceEvidenceRun({ ...options, buildId: '../escape' }))
      .toThrow('invalid_build_id');
  });

  it('atomically binds the build, formal roots, runtime and client while recursively redacting secrets', () => {
    const { run, dataRoot, profileRoot } = createRun({
      runtime: {
        buildId: BUILD_ID,
        pid: 100,
        startedAt: '2026-08-27T00:00:00.000Z',
        nested: { authorization: 'Bearer runtime-secret', apiKey: 'sk-runtime-secret-value' },
      },
      client: {
        buildId: BUILD_ID,
        pid: 200,
        startedAt: '2026-08-27T00:00:01.000Z',
        cookie: 'session=client-secret',
        private_key: 'private-secret',
      },
    });
    const manifest = JSON.parse(fs.readFileSync(run.paths.manifest, 'utf8'));
    const serialized = JSON.stringify(manifest);
    expect(manifest).toMatchObject({
      buildId: BUILD_ID,
      dataRoot: fs.realpathSync.native(dataRoot),
      profile: { userDataDir: fs.realpathSync.native(profileRoot) },
      runtime: { pid: 100, nested: { authorization: REDACTED_VALUE, apiKey: REDACTED_VALUE } },
      client: { pid: 200, cookie: REDACTED_VALUE, private_key: REDACTED_VALUE },
    });
    expect(serialized).not.toContain('runtime-secret');
    expect(serialized).not.toContain('client-secret');
    expect(fs.readdirSync(run.runDirectory).some(name => name.endsWith('.tmp'))).toBe(false);

    expect(() => createRun({
      runtime: { buildId: BUILD_ID, pid: 0, startedAt: '2026-08-27T00:00:00.000Z' },
    })).toThrow('runtime_identity_invalid');
    expect(() => createRun({
      client: { buildId: BUILD_ID, pid: 200, startedAt: 'not-a-time' },
    })).toThrow('client_identity_invalid');
  });

  it('publishes JSON exclusively without replacing another run output', () => {
    const { base } = fixture();
    const output = path.join(base, 'owned.json');
    const foreign = '{"owner":"another-run"}\n';
    fs.writeFileSync(output, foreign, { encoding: 'utf8', flag: 'wx' });

    expect(() => atomicWriteJsonExclusive(output, { owner: 'this-run' }))
      .toThrow('evidence_file_exists');
    expect(fs.readFileSync(output, 'utf8')).toBe(foreign);
    expect(fs.readdirSync(base).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const source = fs.readFileSync(
      path.resolve('scripts/lib/formal-acceptance-evidence.mjs'),
      'utf8',
    );
    const writer = source.slice(
      source.indexOf('export function atomicWriteJsonExclusive'),
      source.indexOf('function createEmptyFileExclusive'),
    );
    expect(writer).toContain('fs.linkSync(temporary, filePath)');
    expect(writer).not.toContain('fs.renameSync(temporary, filePath)');
  });

  it('redacts sensitive keys and credentials embedded in arbitrary nested log text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsdW1pIn0.signature-secret';
    const awsKey = 'AKIA1234567890ABCDEF';
    const redacted = redactAcceptanceEvidence({
      token: 'top-secret-token',
      nested: [{ cookie: 'sid=secret-cookie' }, { note: 'Authorization: Bearer embedded-secret' }],
      api_key: 'sk-test-secret-value',
      privateKey: '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----',
      secret: 'generic-secret-value',
      auth: 'embedded-auth-value',
      desktopSession: 'desktop-session-value',
      desktopBootstrap: 'desktop-bootstrap-value',
      clientSecretKey: 'client-secret-key-value',
      awsSecretAccessKey: 'aws-secret-access-value',
      signingKey: 'signing-key-value',
      sessionKey: 'session-key-value',
      diagnostic: [
        'x-lumi-desktop-session: header-session-value',
        'x-lumi-desktop-bootstrap=header-bootstrap-value',
        `jwt=${jwt}`,
        `aws=${awsKey}`,
        'endpoint=https://alice:plain-password@example.test/private',
        'AWS_SECRET_ACCESS_KEY=aws-secret-in-free-text',
      ].join('\n'),
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toMatch(/top-secret|secret-cookie|embedded-secret|secret-material|sk-test-secret|generic-secret|embedded-auth|desktop-session-value|desktop-bootstrap-value|client-secret-key-value|aws-secret-access-value|signing-key-value|session-key-value|aws-secret-in-free-text|header-session-value|header-bootstrap-value|signature-secret|AKIA1234567890ABCDEF|alice|plain-password/u);
    expect(serialized.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(17);
  });

  it('appends sanitized JSONL, copies and hashes artifacts, and registers only an existing PNG', async () => {
    const { base, run } = createRun();
    run.appendTaskReceipt({
      taskId: 'task-1',
      receiptId: 'receipt-1',
      requestId: 'request-1',
      toolName: 'write_file',
      outcome: 'succeeded',
      verification: 'verified',
      token: 'receipt-secret',
    });
    run.appendTaskTimeline({
      taskId: 'task-1',
      requestId: 'request-1',
      status: 'completed',
      source: 'runtime-final-snapshot',
    });
    run.appendModelRouting({
      id: 'route-1',
      requestId: 'request-1',
      status: 'succeeded',
      selectedProvider: 'lm-studio',
      selectedModel: 'local-model',
      attempts: [{ provider: 'lm-studio', model: 'local-model', status: 'succeeded' }],
      authorization: 'secret',
    });
    run.appendUserFeedback({
      messageId: 'assistant-1',
      requestId: 'request-1',
      replySha256: 'b'.repeat(64),
      replyCharacters: 6,
      internalGuardLeaked: false,
    });

    const logSource = path.join(base, 'backend.log');
    fs.writeFileSync(logSource, 'formal backend evidence\nAuthorization: Bearer raw-log-secret\n', 'utf8');
    const log = await run.copyRedactedLog(logSource, {
      relativePath: 'runtime/backend.redacted.log',
      metadata: { cookie: 'secret' },
    });
    expect(fs.readFileSync(path.join(run.runDirectory, log.storedPath), 'utf8'))
      .not.toContain('raw-log-secret');
    expect(log).toMatchObject({
      redacted: true,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    });

    const artifactSource = path.join(base, 'report.txt');
    fs.writeFileSync(artifactSource, 'verified formal artifact', 'utf8');
    const artifact = await run.copyArtifact(artifactSource, {
      relativePath: 'finance/report.txt',
      metadata: { kind: 'report', apiKey: 'artifact-secret' },
    });
    expect(artifact.sha256).toBe(await sha256File(artifactSource));
    expect(artifact).toMatchObject({
      secretScanStatus: 'passed_text_scan',
      manualRedactionReviewRequired: false,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    });
    expect(fs.existsSync(path.join(run.runDirectory, artifact.storedPath))).toBe(true);
    await expect(run.copyArtifact(artifactSource, { relativePath: '../escape.txt' }))
      .rejects.toThrow('evidence_destination_escape');

    const secretArtifactSource = path.join(base, 'secret-report.txt');
    fs.writeFileSync(secretArtifactSource, 'clientSecretKey=must-not-enter-evidence', 'utf8');
    await expect(run.copyArtifact(secretArtifactSource, { relativePath: 'finance/secret-report.txt' }))
      .rejects.toThrow('evidence_source_contains_sensitive_text');

    const screenshotSource = path.join(base, 'screen.png');
    fs.writeFileSync(screenshotSource, PNG_1X1);
    const screenshot = await run.registerScreenshot(screenshotSource, {
      relativePath: 'voice/turn-01.png',
      metadata: { scenario: 'voice-turn-01' },
    });
    expect(screenshot.sha256).toBe(await sha256File(screenshotSource));
    expect(screenshot).toMatchObject({
      secretScanStatus: 'manual_review_required_screenshot',
      manualRedactionReviewRequired: true,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    });

    const fakePng = path.join(base, 'fake.png');
    fs.writeFileSync(fakePng, 'not a png', 'utf8');
    await expect(run.registerScreenshot(fakePng)).rejects.toThrow('invalid_png_signature');
    await expect(run.registerScreenshot(path.join(base, 'missing.png')))
      .rejects.toThrow('existing_png_required');

    const summary = await run.finalize({ checks: { packageScenario: true } });
    expect(summary.status).toBe('evidence_package_complete');
    expect(summary).toMatchObject({
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    });
    expect(summary.evidenceCounts).toMatchObject({
      taskReceipts: 1,
      taskTimeline: 1,
      modelRouting: 1,
      userFeedback: 1,
      logIndex: 1,
      logs: 1,
      artifacts: 1,
      screenshots: 1,
    });
    expect(summary.inventory.some(entry => entry.path === 'artifacts/finance/report.txt')).toBe(true);
    expect(summary.inventory.some(entry => entry.path === 'screenshots/voice/turn-01.png')).toBe(true);
    expect(fs.existsSync(run.paths.finalSummary)).toBe(true);
    expect(fs.existsSync(path.join(run.runDirectory, artifact.storedPath))).toBe(true);
    expect(fs.readFileSync(run.paths.taskReceipts, 'utf8')).not.toContain('receipt-secret');
    await expect(run.finalize({ checks: { packageScenario: true } })).rejects.toThrow('evidence_run_finalized');
  });

  it('cannot shrink the fixed evidence set or turn meaningless records into an acceptance pass', async () => {
    const first = createRun().run;
    await expect(first.finalize({ requiredEvidence: [] }))
      .rejects.toThrow('required_evidence_is_fixed');

    const { run } = createRun();
    run.appendTaskReceipt({ receiptId: 'anything' });
    run.appendTaskTimeline({ status: 'completed' });
    run.appendModelRouting({ status: 'succeeded' });
    run.appendUserFeedback({ replySha256: 'a'.repeat(64) });
    run.appendLogIndex({ path: 'not-absolute' });
    const summary = await run.finalize({ checks: { stage9: true } });
    expect(summary.status).toBe('incomplete');
    expect(summary.acceptancePassed).toBe(false);
    expect(summary.integrityFailures).toEqual(expect.arrayContaining([
      'taskReceipts:1:invalid_schema',
      'taskTimeline:1:invalid_schema',
      'modelRouting:1:invalid_schema',
      'userFeedback:1:invalid_schema',
      'logIndex:1:invalid_schema',
    ]));
  });

  it('finalizes incomplete without deleting sparse evidence or claiming success without checks', async () => {
    const { run } = createRun();
    const summary = await run.finalize();
    expect(summary.status).toBe('incomplete');
    expect(summary.missing).toEqual(expect.arrayContaining([
      'taskReceipts',
      'taskTimeline',
      'modelRouting',
      'userFeedback',
      'logIndex',
      'logs',
      'artifacts',
      'screenshots',
      'acceptanceChecks',
    ]));
    expect(summary.evidenceRetained).toBe(true);
    expect(fs.existsSync(run.paths.manifest)).toBe(true);
    expect(fs.existsSync(run.paths.finalSummary)).toBe(true);
    expect(fs.readdirSync(run.runDirectory)).toEqual(expect.arrayContaining([
      FORMAL_ACCEPTANCE_FILES.manifest,
      FORMAL_ACCEPTANCE_FILES.finalSummary,
    ]));
  });

  it('detects copied artifact tampering instead of finalizing a false pass', async () => {
    const { base, run } = createRun();
    run.appendTaskReceipt({
      receiptId: 'receipt-1', taskId: 'task-1', requestId: 'request-1',
      toolName: 'write_file', outcome: 'succeeded', verification: 'verified',
    });
    run.appendTaskTimeline({
      taskId: 'task-1', requestId: 'request-1', status: 'completed', source: 'runtime-final-snapshot',
    });
    run.appendModelRouting({
      id: 'route-1', requestId: 'request-1', status: 'succeeded',
      selectedProvider: 'lm-studio', selectedModel: 'local-model',
      attempts: [{ provider: 'lm-studio', model: 'local-model', status: 'succeeded' }],
    });
    run.appendUserFeedback({
      messageId: 'assistant-1', requestId: 'request-1', replySha256: 'c'.repeat(64),
      replyCharacters: 3, internalGuardLeaked: false,
    });
    const logSource = path.join(base, 'backend.log');
    fs.writeFileSync(logSource, 'runtime evidence', 'utf8');
    await run.copyRedactedLog(logSource);
    const artifactSource = path.join(base, 'artifact.txt');
    fs.writeFileSync(artifactSource, 'original', 'utf8');
    const artifact = await run.copyArtifact(artifactSource);
    fs.appendFileSync(path.join(run.runDirectory, artifact.storedPath), 'tampered', 'utf8');
    const screenshotSource = path.join(base, 'screen.png');
    fs.writeFileSync(screenshotSource, PNG_1X1);
    await run.registerScreenshot(screenshotSource);

    const summary = await run.finalize({ checks: { packageScenario: true } });
    expect(summary.status).toBe('incomplete');
    expect(summary.integrityFailures).toEqual(expect.arrayContaining([
      'artifactIndex:1:size_mismatch',
      'artifactIndex:1:sha256_mismatch',
    ]));
  });
});
