import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  FORMAL_STAGE9_EVIDENCE_CATEGORIES,
  FORMAL_STAGE9_PRODUCERS,
  FORMAL_STAGE9_SCENARIO_OWNERS,
  FORMAL_STAGE9_SCENARIOS,
  FORMAL_STAGE9_TRUST_POLICY_KIND,
  adjudicateFormalStage9Evidence,
  formalStage9AdjudicatorExitCode,
  formalStage9BindingDigest,
  normalizeFormalStage9Binding,
  signFormalStage9EvidenceBundle,
} from '../scripts/formal-stage9-adjudicator.mjs';
import {
  FORMAL_STAGE9_FILE_PRODUCER_PACKAGE_KIND,
  assembleFormalStage9UnadjudicatedBundle,
  formalStage9ProducerEvidenceExitCode,
  verifyFormalStage9FileBackedProducerEvidence,
} from '../scripts/lib/formal-stage9-producer-evidence.mjs';
import {
  createMainFormalStage9ProducerEvidence,
  formalGateExitCode,
} from '../scripts/formal-client-e2e.mjs';
import {
  createRestartFormalStage9ProducerEvidence,
  restartEvidenceCliExitCode,
} from '../scripts/formal-client-restart-recovery.mjs';
import {
  createFailoverFormalStage9ProducerEvidence,
  failoverEvidenceCliExitCode,
} from '../scripts/formal-model-failover-recovery.mjs';
import {
  createWpsFormalStage9ProducerEvidence,
  formalWpsBatchEvidenceCliExitCode,
} from '../scripts/formal-wps-batch-acceptance.mjs';
import {
  createVariantFormalStage9ProducerEvidence,
  formalVariantEvidenceCliExitCode,
} from '../scripts/formal-variant-acceptance.mjs';

const RECORDED_AT = '2026-08-27T12:00:00.000Z';
const BUILD_ID = 'a'.repeat(40);
const SOURCE_FINGERPRINT = 'b'.repeat(64);

function hash(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rawBinding(overrides: Record<string, any> = {}) {
  const locations = {
    dataRootSha256: hash('formal-data-root'),
    webview2UserDataDirSha256: hash('formal-webview-user-data'),
    webview2ProfileDirSha256: hash('formal-webview-profile'),
    ...(overrides.locations || {}),
  };
  const nativeClient = {
    clientKind: 'tauri',
    deviceId: 'formal-native-device',
    executionSessionId: 'formal-execution-session',
    identityFingerprint: hash('formal-native-identity'),
    executableSha256: hash('formal-native-executable'),
    pid: 9912,
    startedAt: '2026-08-27T11:55:00.000Z',
    buildId: overrides.buildId || BUILD_ID,
    sourceFingerprint: overrides.sourceFingerprint || SOURCE_FINGERPRINT,
    sourceDirty: false,
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
    webviewProfileBound: false,
    formalAcceptanceEligible: false,
    ...(overrides.nativeClient || {}),
  };
  return {
    schemaVersion: 2,
    acceptanceRunId: 'LUMI-STAGE9-PRODUCERS-20260827-001122334455',
    buildId: BUILD_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    sourceDirty: false,
    ...overrides,
    locations,
    nativeClient,
  };
}

function unadjudicated() {
  return { acceptanceDecision: 'not_adjudicated', acceptancePassed: false } as const;
}

function payloadFor(producer: string, binding: any) {
  if (producer === 'main') {
    return {
      ok: true,
      packageComplete: true,
      identityVerified: true,
      runtime: { healthy: true, buildMatches: true, sourceClean: true },
      nativeClient: {
        proofBoundIdentityVerified: true,
        deviceId: binding.nativeClient.deviceId,
        identityFingerprint: binding.nativeClient.identityFingerprint,
      },
      stage9Checks: Object.fromEntries(
        FORMAL_STAGE9_SCENARIOS
          .filter(id => FORMAL_STAGE9_SCENARIO_OWNERS[id] === 'main')
          .map(id => [id, true]),
      ),
      fullAcceptance: false,
      diagnostics: {
        checkpointPath: 'D:\\private\\formal-checkpoint.json',
        optionalPath: '',
        windowsLocationInMessage: 'C:\\Users\\PrivateUser\\Desktop\\proof.json',
        posixLocationInMessage: '/Users/private-user/Desktop/proof.json',
        apiKey: 'sk-formal-secret-value-123456',
      },
      ...unadjudicated(),
    };
  }
  if (producer === 'restart') {
    const marker = 'LUMI-E2E-RESTART-0011223344556677';
    return {
      prepare: {
        ok: true,
        phase: 'prepare',
        runMarker: marker,
        expectedRestart: 'both',
        restartPerformedByScript: false,
        ...unadjudicated(),
      },
      verify: {
        ok: true,
        phase: 'verify',
        runMarker: marker,
        expectedRestart: 'both',
        restartPerformedByScript: false,
        restart: { expected: 'both', observed: 'both' },
        locationBindings: binding.locations,
        identities: { recoveredNativeClient: binding.nativeClient },
        lifecycle: { finalStatus: 'completed', activeLease: false },
        ...unadjudicated(),
      },
    };
  }
  if (producer === 'failover') {
    const marker = 'LUMI-E2E-FAILOVER-0011223344556677';
    const checkpointSha256 = hash('failover-checkpoint');
    return {
      prepare: {
        ok: true,
        phase: 'prepare',
        marker,
        checkpointSha256,
        failureInducedByScript: false,
        ...unadjudicated(),
      },
      verify: {
        ok: true,
        phase: 'verify',
        marker,
        checkpointSha256,
        sameTaskRecovered: true,
        failureInducedByScript: false,
        locationBindings: binding.locations,
        nativeClient: binding.nativeClient,
        routing: {
          selectedProvider: 'lmstudio',
          primaryFailureReason: 'provider_unavailable',
          primaryFailureDigest: hash('provider_unavailable'),
        },
        ...unadjudicated(),
      },
    };
  }
  if (producer === 'wps') {
    return {
      validation: { ok: true, packageComplete: true, filesystemVerified: true },
      runtimeProvenanceVerified: true,
      manifestDigest: hash('wps-manifest'),
      evidenceDigest: hash('wps-evidence'),
      locationBindings: binding.locations,
      nativeClient: binding.nativeClient,
      activeWpsDocumentWorkflowPassed: true,
      batchCleanupPassed: true,
      ...unadjudicated(),
    };
  }
  return {
    validation: { ok: true, packageComplete: true, filesystemVerified: true },
    runtimeProvenanceVerified: true,
    manifestDigest: hash('variant-manifest'),
    evidenceDigest: hash('variant-evidence'),
    locationBindings: binding.locations,
    nativeClient: binding.nativeClient,
    completedVariants: ['designer-client', 'ecommerce-client', 'finance-client', 'legal-client'],
    ...unadjudicated(),
  };
}

function sourceEvidence(producer: string, binding: any, sourceRoot: string) {
  const bindingDigest = formalStage9BindingDigest(binding);
  return Object.fromEntries(
    FORMAL_STAGE9_SCENARIOS
      .filter(scenarioId => FORMAL_STAGE9_SCENARIO_OWNERS[scenarioId] === producer)
      .map(scenarioId => [scenarioId, Object.fromEntries(
        FORMAL_STAGE9_EVIDENCE_CATEGORIES.map(category => {
          const recordId = `${producer}-${scenarioId}-${category}`;
          const sourcePath = path.join(sourceRoot, `${hash(recordId).slice(0, 24)}.json`);
          fs.writeFileSync(sourcePath, JSON.stringify({ producer, scenarioId, category, recordId }), 'utf8');
          const base: Record<string, any> = {
            sourcePath,
            recordId,
            acceptanceRunId: binding.acceptanceRunId,
            bindingDigest,
            buildId: binding.buildId,
            sourceFingerprint: binding.sourceFingerprint,
            recordedAt: RECORDED_AT,
            requestId: `request-${scenarioId}`,
            taskId: `task-${scenarioId}`,
          };
          if (category === 'screenshots') {
            Object.assign(base, {
              trustedNativeCapture: true,
              manualReviewCompleted: true,
              nativeDeviceId: binding.nativeClient.deviceId,
              executionSessionId: binding.nativeClient.executionSessionId,
              windowId: `window-${scenarioId}`,
            });
          } else if (category === 'taskReceipts') {
            Object.assign(base, {
              receiptId: `receipt-${scenarioId}`,
              toolName: 'formal_tool',
              verification: 'verified',
            });
          } else if (category === 'taskTimeline') {
            Object.assign(base, { status: 'completed', source: 'formal-runtime-ledger' });
          } else if (category === 'modelRouting') {
            Object.assign(base, {
              routingReceiptId: `routing-${scenarioId}`,
              selectedProvider: 'lmstudio',
              selectedModel: 'formal-model',
              status: 'succeeded',
            });
          } else if (category === 'artifacts') {
            Object.assign(base, { artifactId: `artifact-${scenarioId}`, verified: true });
          } else {
            Object.assign(base, {
              messageId: `message-${scenarioId}`,
              replySha256: hash(`reply-${scenarioId}`),
              internalGuardLeaked: false,
            });
          }
          return [category, [base]];
        }),
      )]),
  );
}

const CREATORS = {
  main: createMainFormalStage9ProducerEvidence,
  restart: createRestartFormalStage9ProducerEvidence,
  failover: createFailoverFormalStage9ProducerEvidence,
  wps: createWpsFormalStage9ProducerEvidence,
  variants: createVariantFormalStage9ProducerEvidence,
};

function temporaryLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-stage9-producers-'));
  const evidenceRoot = path.join(root, 'evidence');
  const sourceRoot = path.join(root, 'sources');
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(sourceRoot);
  return { root, evidenceRoot, sourceRoot };
}

async function createPackage(producer: keyof typeof CREATORS, layout: ReturnType<typeof temporaryLayout>, binding: any) {
  return CREATORS[producer]({
    binding,
    payload: payloadFor(producer, binding),
    scenarioEvidence: sourceEvidence(producer, binding, layout.sourceRoot),
    evidenceRoot: layout.evidenceRoot,
    recordedAt: RECORDED_AT,
  });
}

describe('formal Stage 9 file-backed producer bridge', () => {
  it('builds and aggregates all five schema-v2 producer envelopes without self-adjudicating', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const packages = [];
      for (const producer of FORMAL_STAGE9_PRODUCERS as Array<keyof typeof CREATORS>) {
        const packageValue = await createPackage(producer, layout, binding);
        packages.push(packageValue);
        expect(packageValue).toMatchObject({
          kind: FORMAL_STAGE9_FILE_PRODUCER_PACKAGE_KIND,
          producer,
          acceptanceRunId: binding.acceptanceRunId,
          bindingDigest: formalStage9BindingDigest(binding),
          buildId: binding.buildId,
          sourceFingerprint: binding.sourceFingerprint,
          packageComplete: true,
          acceptanceDecision: 'not_adjudicated',
          acceptancePassed: false,
          fullAcceptance: false,
        });
        expect(formalStage9ProducerEvidenceExitCode(packageValue)).toBe(2);
        expect(JSON.stringify(packageValue.envelope)).not.toContain('D:\\\\private');
        expect(JSON.stringify(packageValue.envelope)).not.toContain('PrivateUser');
        expect(JSON.stringify(packageValue.envelope)).not.toContain('/Users/private-user');
        expect(JSON.stringify(packageValue.envelope)).not.toContain('sk-formal-secret');
        if (producer === 'main') {
          expect(packageValue.envelope.payload.diagnostics.optionalPath).toBe('');
        }
        expect(verifyFormalStage9FileBackedProducerEvidence({
          package: packageValue,
          binding,
          evidenceRoot: layout.evidenceRoot,
        })).toMatchObject({ ok: true, packageComplete: true, errors: [] });
        for (const categories of Object.values(packageValue.envelope.scenarioEvidence) as any[]) {
          for (const references of Object.values(categories) as any[]) {
            expect(references[0]).not.toHaveProperty('serverAttestation');
            expect(references[0]).not.toHaveProperty('nativeAttestation');
          }
        }
      }

      const assembled = assembleFormalStage9UnadjudicatedBundle({
        binding,
        producerPackages: packages,
        evidenceRoot: layout.evidenceRoot,
      });
      expect(assembled).toMatchObject({
        ok: true,
        packageComplete: true,
        acceptanceDecision: 'not_adjudicated',
        acceptancePassed: false,
        fullAcceptance: false,
      });
      expect(Object.keys(assembled.bundle.producers).sort()).toEqual([...FORMAL_STAGE9_PRODUCERS].sort());
      expect(assembled.bundle.evidenceManifest.entryCount).toBe(
        FORMAL_STAGE9_SCENARIOS.length * FORMAL_STAGE9_EVIDENCE_CATEGORIES.length,
      );
      expect(assembled.bundle).not.toHaveProperty('bundleSignature');
      expect(formalStage9ProducerEvidenceExitCode(assembled)).toBe(2);

      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const signedBundle = signFormalStage9EvidenceBundle(assembled.bundle, {
        keyId: 'operator-integrity-key',
        privateKey,
      });
      const integrityDecision = adjudicateFormalStage9Evidence(signedBundle, {
        evidenceRoot: layout.evidenceRoot,
        trustPolicy: {
          schemaVersion: 1,
          kind: FORMAL_STAGE9_TRUST_POLICY_KIND,
          policyId: 'producer-integration-integrity-only',
          acceptanceMode: 'integrity_only',
          bundleSigner: {
            keyId: 'operator-integrity-key',
            algorithm: 'ed25519',
            publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        },
      });
      expect(integrityDecision).toMatchObject({
        status: 'integrity_verified',
        acceptanceDecision: 'not_adjudicated',
        acceptancePassed: false,
      });
      expect(formalStage9AdjudicatorExitCode(integrityDecision)).toBe(1);
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('rejects cross-run and cross-fingerprint source records before packaging', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const evidence = sourceEvidence('main', binding, layout.sourceRoot);
      const first = evidence.task_correction_three_times.screenshots[0];
      first.acceptanceRunId = 'LUMI-STAGE9-OTHER-RUN-20260827-998877665544';
      await expect(createMainFormalStage9ProducerEvidence({
        binding,
        payload: payloadFor('main', binding),
        scenarioEvidence: evidence,
        evidenceRoot: layout.evidenceRoot,
        recordedAt: RECORDED_AT,
      })).rejects.toMatchObject({ code: 'formal_stage9_source_acceptance_run_mismatch' });

      first.acceptanceRunId = binding.acceptanceRunId;
      first.sourceFingerprint = 'c'.repeat(64);
      await expect(createMainFormalStage9ProducerEvidence({
        binding,
        payload: payloadFor('main', binding),
        scenarioEvidence: evidence,
        evidenceRoot: layout.evidenceRoot,
        recordedAt: RECORDED_AT,
      })).rejects.toMatchObject({ code: 'formal_stage9_source_fingerprint_mismatch' });
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('allows a corrected retry after an earlier attempt left incomplete snapshots', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const evidence = sourceEvidence('main', binding, layout.sourceRoot);
      const scenarios = Object.keys(evidence);
      const firstRecord = evidence[scenarios[0]].screenshots[0].recordId;
      const lastScenario = scenarios.at(-1)!;
      const originalRecord = evidence[lastScenario].userFeedback[0].recordId;
      evidence[lastScenario].userFeedback[0].recordId = firstRecord;

      await expect(createMainFormalStage9ProducerEvidence({
        binding,
        payload: payloadFor('main', binding),
        scenarioEvidence: evidence,
        evidenceRoot: layout.evidenceRoot,
        recordedAt: RECORDED_AT,
      })).rejects.toMatchObject({ code: 'formal_stage9_record_id_reused' });

      evidence[lastScenario].userFeedback[0].recordId = originalRecord;
      await expect(createMainFormalStage9ProducerEvidence({
        binding,
        payload: payloadFor('main', binding),
        scenarioEvidence: evidence,
        evidenceRoot: layout.evidenceRoot,
        recordedAt: RECORDED_AT,
      })).resolves.toMatchObject({ ok: true, packageComplete: true });
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('fails closed when a source file is missing', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const evidence = sourceEvidence('failover', binding, layout.sourceRoot);
      evidence.production_primary_failure_lmstudio_same_task_continuation.artifacts[0].sourcePath =
        path.join(layout.sourceRoot, 'missing.json');
      await expect(createFailoverFormalStage9ProducerEvidence({
        binding,
        payload: payloadFor('failover', binding),
        scenarioEvidence: evidence,
        evidenceRoot: layout.evidenceRoot,
        recordedAt: RECORDED_AT,
      })).rejects.toMatchObject({ code: 'formal_stage9_source_file_missing' });
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('rejects a text evidence source containing a credential before snapshotting it', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const evidence = sourceEvidence('failover', binding, layout.sourceRoot);
      const sourcePath = evidence.production_primary_failure_lmstudio_same_task_continuation
        .taskReceipts[0].sourcePath;
      fs.writeFileSync(sourcePath, '{"apiKey":"sk-sensitive-evidence-value-123456"}', 'utf8');
      await expect(createFailoverFormalStage9ProducerEvidence({
        binding,
        payload: payloadFor('failover', binding),
        scenarioEvidence: evidence,
        evidenceRoot: layout.evidenceRoot,
        recordedAt: RECORDED_AT,
      })).rejects.toMatchObject({ code: 'formal_stage9_source_contains_sensitive_text' });
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('detects a retained evidence file changed after producer finalization', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const packageValue = await createPackage('main', layout, binding);
      const reference = packageValue.envelope.scenarioEvidence
        .task_correction_three_times.taskReceipts[0];
      const evidencePath = path.join(layout.evidenceRoot, ...reference.relativePath.split('/'));
      fs.chmodSync(evidencePath, 0o600);
      const bytes = fs.readFileSync(evidencePath);
      bytes[0] ^= 0xff;
      fs.writeFileSync(evidencePath, bytes);
      const verification = verifyFormalStage9FileBackedProducerEvidence({
        package: packageValue,
        binding,
        evidenceRoot: layout.evidenceRoot,
      });
      expect(verification.ok).toBe(false);
      expect(verification.packageComplete).toBe(false);
      expect(verification.errors.some((code: string) => code.endsWith(':sha256_mismatch'))).toBe(true);
      expect(formalStage9ProducerEvidenceExitCode(verification)).toBe(1);
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('rejects a package that drops its private-local non-publishable source policy', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const packageValue = await createPackage('main', layout, binding);
      packageValue.envelope.scenarioEvidence.task_correction_three_times
        .taskReceipts[0].sourceSecurity.publishable = true;
      const verification = verifyFormalStage9FileBackedProducerEvidence({
        package: packageValue,
        binding,
        evidenceRoot: layout.evidenceRoot,
      });
      expect(verification.ok).toBe(false);
      expect(verification.errors).toContain(
        'task_correction_three_times:taskReceipts:source_security_invalid',
      );
      expect(formalStage9ProducerEvidenceExitCode(verification)).toBe(1);
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('rejects an envelope whose file-backed outer package or manifest binding is missing', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const packageValue = await createPackage('main', layout, binding);
      const envelopeOnly = packageValue.envelope;
      const forgedOuter = { ...packageValue, kind: 'forged-stage9-package-kind' };

      for (const candidate of [envelopeOnly, forgedOuter]) {
        const verification = verifyFormalStage9FileBackedProducerEvidence({
          package: candidate,
          binding,
          evidenceRoot: layout.evidenceRoot,
        });
        expect(verification.ok).toBe(false);
        expect(verification.packageComplete).toBe(false);
        expect(verification.errors).toContain('file_backed_package_required');
        expect(formalStage9ProducerEvidenceExitCode(verification)).toBe(1);
      }
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('keeps all five existing producer CLI contracts at exit 2 or 1, never 0', () => {
    const complete = {
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      fullAcceptance: false,
    };
    const forged = {
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'accepted',
      acceptancePassed: true,
      fullAcceptance: true,
    };
    const incomplete = { ...complete, packageComplete: false };
    const exitFunctions = [
      formalGateExitCode,
      restartEvidenceCliExitCode,
      failoverEvidenceCliExitCode,
      formalWpsBatchEvidenceCliExitCode,
      formalVariantEvidenceCliExitCode,
    ];
    for (const exitCode of exitFunctions) {
      expect(exitCode(complete)).toBe(2);
      expect(exitCode(incomplete)).toBe(1);
      expect(exitCode(forged)).toBe(1);
    }
  });

  it('provides real fail-closed produce and assemble CLI paths that exit 2', async () => {
    const layout = temporaryLayout();
    try {
      const binding = normalizeFormalStage9Binding(rawBinding());
      const script = path.join(process.cwd(), 'scripts', 'formal-stage9-producer-package.mjs');
      const bindingPath = path.join(layout.root, 'binding.json');
      const mainPayloadPath = path.join(layout.root, 'main-payload.json');
      const mainSourcesPath = path.join(layout.root, 'main-sources.json');
      const mainOutputPath = path.join(layout.root, 'main-package.json');
      fs.writeFileSync(bindingPath, JSON.stringify(binding), 'utf8');
      fs.writeFileSync(mainPayloadPath, JSON.stringify(payloadFor('main', binding)), 'utf8');
      fs.writeFileSync(
        mainSourcesPath,
        JSON.stringify(sourceEvidence('main', binding, layout.sourceRoot)),
        'utf8',
      );
      const produced = spawnSync(process.execPath, [
        script,
        'produce',
        '--producer', 'main',
        '--binding', bindingPath,
        '--payload', mainPayloadPath,
        '--scenario-sources', mainSourcesPath,
        '--evidence-root', layout.evidenceRoot,
        '--recorded-at', RECORDED_AT,
        '--output', mainOutputPath,
      ], { encoding: 'utf8' });
      expect(produced.status).toBe(2);
      const mainPackage = JSON.parse(fs.readFileSync(mainOutputPath, 'utf8'));
      expect(mainPackage).toMatchObject({
        producer: 'main',
        packageComplete: true,
        acceptanceDecision: 'not_adjudicated',
        acceptancePassed: false,
      });
      expect(JSON.stringify(mainPackage)).not.toContain('D:\\\\private');
      expect(JSON.stringify(mainPackage)).not.toContain('sk-formal-secret');

      const packages = [mainPackage];
      for (const producer of ['restart', 'failover', 'wps', 'variants'] as const) {
        packages.push(await createPackage(producer, layout, binding));
      }
      const packagesPath = path.join(layout.root, 'packages.json');
      const assembledOutputPath = path.join(layout.root, 'assembled-package.json');
      fs.writeFileSync(packagesPath, JSON.stringify(packages), 'utf8');
      const assembled = spawnSync(process.execPath, [
        script,
        'assemble',
        '--binding', bindingPath,
        '--packages', packagesPath,
        '--evidence-root', layout.evidenceRoot,
        '--output', assembledOutputPath,
      ], { encoding: 'utf8' });
      expect(assembled.status).toBe(2);
      const assembledPackage = JSON.parse(fs.readFileSync(assembledOutputPath, 'utf8'));
      expect(assembledPackage).toMatchObject({
        packageComplete: true,
        acceptanceDecision: 'not_adjudicated',
        acceptancePassed: false,
        fullAcceptance: false,
      });
      expect(assembledPackage.bundle.evidenceManifest.entryCount).toBe(84);
      expect(assembledPackage.bundle).not.toHaveProperty('bundleSignature');
      expect(assembledPackage).not.toHaveProperty('evidenceRoot');
    } finally {
      fs.rmSync(layout.root, { recursive: true, force: true });
    }
  });
});
