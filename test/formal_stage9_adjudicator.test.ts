import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
  FORMAL_STAGE9_DECISION_KIND,
  FORMAL_STAGE9_EVIDENCE_CATEGORIES,
  FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND,
  FORMAL_STAGE9_PRODUCERS,
  FORMAL_STAGE9_SCENARIO_OWNERS,
  FORMAL_STAGE9_SCENARIOS,
  FORMAL_STAGE9_TRUST_POLICY_KIND,
  adjudicateFormalStage9Evidence,
  formalStage9AdjudicatorExitCode,
  formalStage9BindingDigest,
  formalStage9Digest,
  sealFormalStage9EvidenceBundle,
  sealFormalStage9ProducerEvidence,
  signFormalStage9EvidenceBundle,
  signFormalStage9EvidenceReference,
} from '../scripts/formal-stage9-adjudicator.mjs';
import { formalGateExitCode } from '../scripts/formal-client-e2e.mjs';
import { restartEvidenceCliExitCode } from '../scripts/formal-client-restart-recovery.mjs';
import { failoverEvidenceCliExitCode } from '../scripts/formal-model-failover-recovery.mjs';
import { formalWpsBatchEvidenceCliExitCode } from '../scripts/formal-wps-batch-acceptance.mjs';
import { formalVariantEvidenceCliExitCode } from '../scripts/formal-variant-acceptance.mjs';

const CREATED_AT = '2026-08-27T08:00:00.000Z';
const RECORDED_AT = '2026-08-27T09:00:00.000Z';
const COMPLETED_AT = '2026-08-27T10:00:00.000Z';
const BUILD_ID = 'a'.repeat(40);
const SOURCE_FINGERPRINT = 'b'.repeat(64);

function hash(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function binding(overrides: Record<string, any> = {}) {
  const base = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    acceptanceRunId: 'LUMI-STAGE9-20260827-0011223344556677',
    buildId: BUILD_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    sourceDirty: false,
    locations: {
      dataRootSha256: hash('D:\\formal-data-root'),
      webview2UserDataDirSha256: hash('D:\\formal-webview-root'),
      webview2ProfileDirSha256: hash('D:\\formal-webview-root\\Default'),
    },
    nativeClient: {
      clientKind: 'tauri',
      deviceId: 'formal-tauri-device',
      executionSessionId: 'formal-native-execution-session-001',
      identityFingerprint: hash('formal-native-identity'),
      executableSha256: hash('formal-native-executable'),
      pid: 8042,
      startedAt: '2026-08-27T07:55:00.000Z',
      buildId: BUILD_ID,
      sourceFingerprint: SOURCE_FINGERPRINT,
      sourceDirty: false,
      trustLevel: 'os_attested_native_claim',
      osAttested: true,
      webviewProfileTrustLevel: 'native_attested',
      webviewProfileBound: true,
      webview2ProfileDirSha256: hash('D:\\formal-webview-root\\Default'),
      formalAcceptanceEligible: true,
    },
  };
  return {
    ...base,
    ...overrides,
    locations: { ...base.locations, ...(overrides.locations || {}) },
    nativeClient: { ...base.nativeClient, ...(overrides.nativeClient || {}) },
  };
}

function unadjudicated() {
  return { acceptanceDecision: 'not_adjudicated', acceptancePassed: false } as const;
}

function mainPayload(commonBinding = binding()) {
  return {
    ok: true,
    identityVerified: true,
    runtime: { healthy: true, buildMatches: true, sourceClean: true },
    nativeClient: {
      proofBoundIdentityVerified: true,
      deviceId: commonBinding.nativeClient.deviceId,
      identityFingerprint: commonBinding.nativeClient.identityFingerprint,
    },
    stage9Checks: Object.fromEntries(
      FORMAL_STAGE9_SCENARIOS
        .filter(scenarioId => FORMAL_STAGE9_SCENARIO_OWNERS[scenarioId] === 'main')
        .map(scenarioId => [scenarioId, true]),
    ),
    ...unadjudicated(),
  };
}

function restartPayload(commonBinding = binding()) {
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
      locationBindings: commonBinding.locations,
      identities: { recoveredNativeClient: commonBinding.nativeClient },
      lifecycle: { finalStatus: 'completed', activeLease: false },
      ...unadjudicated(),
    },
  };
}

function failoverPayload(commonBinding = binding()) {
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
      locationBindings: commonBinding.locations,
      nativeClient: commonBinding.nativeClient,
      routing: {
        selectedProvider: 'lmstudio',
        primaryFailureReason: 'provider_unavailable',
        primaryFailureDigest: hash('provider_unavailable'),
      },
      ...unadjudicated(),
    },
  };
}

function wpsPayload(commonBinding = binding()) {
  return {
    validation: { ok: true, packageComplete: true, filesystemVerified: true },
    runtimeProvenanceVerified: true,
    manifestDigest: hash('wps-manifest'),
    evidenceDigest: hash('wps-evidence'),
    locationBindings: commonBinding.locations,
    nativeClient: commonBinding.nativeClient,
    activeWpsDocumentWorkflowPassed: true,
    batchCleanupPassed: true,
    ...unadjudicated(),
  };
}

function variantsPayload(commonBinding = binding()) {
  return {
    validation: { ok: true, packageComplete: true, filesystemVerified: true },
    runtimeProvenanceVerified: true,
    manifestDigest: hash('variants-manifest'),
    evidenceDigest: hash('variants-evidence'),
    locationBindings: commonBinding.locations,
    nativeClient: commonBinding.nativeClient,
    completedVariants: ['designer-client', 'ecommerce-client', 'finance-client', 'legal-client'],
    ...unadjudicated(),
  };
}

const PAYLOADS = {
  main: mainPayload,
  restart: restartPayload,
  failover: failoverPayload,
  wps: wpsPayload,
  variants: variantsPayload,
};

function keyMaterial(keyId: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function newKeySet() {
  return {
    bundle: keyMaterial('operator-bundle-2026-08'),
    server: keyMaterial('server-receipts-2026-08'),
    native: keyMaterial('native-capture-2026-08'),
    wrong: keyMaterial('wrong-key-2026-08'),
  };
}

function trustPolicy(keys: ReturnType<typeof newKeySet>, mode: 'integrity_only' | 'dual_attestation') {
  return {
    schemaVersion: 1,
    kind: FORMAL_STAGE9_TRUST_POLICY_KIND,
    policyId: `stage9-policy-${mode}`,
    acceptanceMode: mode,
    bundleSigner: {
      keyId: keys.bundle.keyId,
      algorithm: 'ed25519',
      publicKeyPem: keys.bundle.publicKeyPem,
    },
    ...(mode === 'dual_attestation' ? {
      serverReceiptSigner: {
        keyId: keys.server.keyId,
        algorithm: 'ed25519',
        publicKeyPem: keys.server.publicKeyPem,
      },
      nativeCaptureSigner: {
        keyId: keys.native.keyId,
        algorithm: 'ed25519',
        publicKeyPem: keys.native.publicKeyPem,
      },
    } : {}),
  };
}

function categoryFields(category: string, scenarioId: string, commonBinding: any) {
  if (category === 'screenshots') {
    return {
      trustedNativeCapture: true,
      manualReviewCompleted: true,
      nativeDeviceId: commonBinding.nativeClient.deviceId,
      executionSessionId: commonBinding.nativeClient.executionSessionId,
      windowId: `window-${scenarioId}`,
    };
  }
  if (category === 'taskReceipts') {
    return { receiptId: `receipt-${scenarioId}`, toolName: 'formal_tool', verification: 'verified' };
  }
  if (category === 'taskTimeline') return { status: 'completed', source: 'formal-runtime-ledger' };
  if (category === 'modelRouting') {
    return {
      routingReceiptId: `routing-${scenarioId}`,
      selectedProvider: 'lmstudio',
      selectedModel: 'formal-model',
      status: 'succeeded',
    };
  }
  if (category === 'artifacts') return { artifactId: `artifact-${scenarioId}`, verified: true };
  return {
    messageId: `message-${scenarioId}`,
    replySha256: hash(`reply-${scenarioId}`),
    internalGuardLeaked: false,
  };
}

function makeReference(options: {
  producer: string;
  scenarioId: string;
  category: string;
  commonBinding: any;
  evidenceRoot: string;
  keys: ReturnType<typeof newKeySet>;
  mode: 'integrity_only' | 'dual_attestation';
  fileBacked: boolean;
}) {
  const { producer, scenarioId, category, commonBinding, evidenceRoot, keys, mode } = options;
  const recordId = `${category}-${scenarioId}`;
  let fileIdentity: Record<string, unknown> = { sha256: hash(recordId) };
  if (options.fileBacked) {
    const relativePath = `${producer}/${scenarioId}/${category}.json`;
    const contents = Buffer.from(JSON.stringify({ producer, scenarioId, category, recordId }), 'utf8');
    const absolutePath = path.join(evidenceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
    fileIdentity = { relativePath, size: contents.length, sha256: hash(contents) };
  }
  let reference: any = {
    recordId,
    scenarioId,
    acceptanceRunId: commonBinding.acceptanceRunId,
    bindingDigest: formalStage9BindingDigest(commonBinding),
    ...fileIdentity,
    recordedAt: RECORDED_AT,
    requestId: `request-${scenarioId}`,
    taskId: `task-${scenarioId}`,
    sourceSecurity: {
      secretScanStatus: 'passed_text_scan',
      manualRedactionReviewCompleted: false,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    },
    ...categoryFields(category, scenarioId, commonBinding),
  };
  if (mode === 'dual_attestation') {
    const native = category === 'screenshots';
    const signer = native ? keys.native : keys.server;
    reference = signFormalStage9EvidenceReference(reference, {
      signerRole: native ? 'native' : 'server',
      keyId: signer.keyId,
      privateKey: signer.privateKey,
    });
  }
  return reference;
}

function scenarioEvidence(options: {
  producer: string;
  commonBinding: any;
  evidenceRoot: string;
  keys: ReturnType<typeof newKeySet>;
  mode: 'integrity_only' | 'dual_attestation';
  fileBacked: boolean;
}) {
  return Object.fromEntries(
    FORMAL_STAGE9_SCENARIOS
      .filter(scenarioId => FORMAL_STAGE9_SCENARIO_OWNERS[scenarioId] === options.producer)
      .map(scenarioId => [scenarioId, Object.fromEntries(
        FORMAL_STAGE9_EVIDENCE_CATEGORIES.map(category => [
          category,
          [makeReference({ ...options, scenarioId, category })],
        ]),
      )]),
  );
}

function producerManifestEntries(value: Record<string, any>) {
  const entries: Array<Record<string, unknown>> = [];
  for (const scenarioId of Object.keys(value).sort()) {
    for (const category of FORMAL_STAGE9_EVIDENCE_CATEGORIES) {
      for (const reference of value[scenarioId]?.[category] || []) {
        entries.push({
          scenarioId,
          category,
          recordId: String(reference.recordId || '').trim(),
          relativePath: String(reference.relativePath || '').trim(),
          size: Number(reference.size),
          sha256: String(reference.sha256 || '').trim().toLowerCase(),
          requestId: String(reference.requestId || '').trim(),
          taskId: String(reference.taskId || '').trim(),
          recordedAt: String(reference.recordedAt || '').trim(),
        });
      }
    }
  }
  return entries;
}

function attachProducerFileManifest(options: {
  producer: string;
  payload: Record<string, any>;
  evidence: Record<string, any>;
  commonBinding: any;
  evidenceRoot: string;
}) {
  const bindingDigest = formalStage9BindingDigest(options.commonBinding);
  const manifest = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND,
    producer: options.producer,
    acceptanceRunId: options.commonBinding.acceptanceRunId,
    bindingDigest,
    buildId: options.commonBinding.buildId,
    sourceFingerprint: options.commonBinding.sourceFingerprint,
    recordedAt: RECORDED_AT,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    entries: producerManifestEntries(options.evidence),
  };
  const relativePath = `${options.producer}/producer-manifest.json`;
  const absolutePath = path.join(options.evidenceRoot, ...relativePath.split('/'));
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return {
    ...structuredClone(options.payload),
    stage9ProducerEvidence: {
      schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
      manifestRelativePath: relativePath,
      manifestSize: bytes.length,
      manifestSha256: hash(bytes),
      acceptanceRunId: options.commonBinding.acceptanceRunId,
      bindingDigest,
      buildId: options.commonBinding.buildId,
      sourceFingerprint: options.commonBinding.sourceFingerprint,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    },
  };
}

function makeFixture(
  mode: 'integrity_only' | 'dual_attestation' = 'dual_attestation',
  { fileBacked = true } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-stage9-trust-'));
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(evidenceRoot);
  const commonBinding = binding();
  const keys = newKeySet();
  const producers = Object.fromEntries(FORMAL_STAGE9_PRODUCERS.map(producer => {
    const typedProducer = producer as keyof typeof PAYLOADS;
    const evidence = scenarioEvidence({
      producer,
      commonBinding,
      evidenceRoot,
      keys,
      mode,
      fileBacked,
    });
    return [producer, sealFormalStage9ProducerEvidence({
      producer,
      binding: commonBinding,
      payload: attachProducerFileManifest({
        producer,
        payload: PAYLOADS[typedProducer](commonBinding),
        evidence,
        commonBinding,
        evidenceRoot,
      }),
      scenarioEvidence: evidence,
      recordedAt: RECORDED_AT,
    })];
  }));
  const sealed = sealFormalStage9EvidenceBundle({
    binding: commonBinding,
    producers,
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
  });
  return {
    root,
    evidenceRoot,
    commonBinding,
    keys,
    policy: trustPolicy(keys, mode),
    bundle: signFormalStage9EvidenceBundle(sealed, {
      keyId: keys.bundle.keyId,
      privateKey: keys.bundle.privateKey,
    }),
    mode,
  };
}

type Fixture = ReturnType<typeof makeFixture>;

function resealProducerAndBundle(fixture: Fixture, producer: keyof typeof PAYLOADS = 'main') {
  const current = fixture.bundle.producers[producer];
  const producers = {
    ...fixture.bundle.producers,
    [producer]: sealFormalStage9ProducerEvidence({
      producer,
      binding: fixture.commonBinding,
      payload: current.payload,
      scenarioEvidence: current.scenarioEvidence,
      recordedAt: current.recordedAt,
    }),
  };
  const sealed = sealFormalStage9EvidenceBundle({
    binding: fixture.commonBinding,
    producers,
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
  });
  fixture.bundle = signFormalStage9EvidenceBundle(sealed, {
    keyId: fixture.keys.bundle.keyId,
    privateKey: fixture.keys.bundle.privateKey,
  });
}

function adjudicate(fixture: Fixture) {
  return adjudicateFormalStage9Evidence(fixture.bundle, {
    trustPolicy: fixture.policy,
    evidenceRoot: fixture.evidenceRoot,
  });
}

function cleanup(fixture: Fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

describe('unique formal Stage 9 adjudicator trust boundary', () => {
  it('rejects an old self-declared synthetic bundle even when structurally complete', () => {
    const fixture = makeFixture('dual_attestation', { fileBacked: false });
    try {
      const result = adjudicate(fixture);
      expect(result.status).toBe('rejected');
      expect(result.errors.some((code: string) => code.includes('formal_evidence_relative_path_required'))).toBe(true);
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
      const withoutExternalTrust = adjudicateFormalStage9Evidence(fixture.bundle);
      expect(withoutExternalTrust.errors).toContain('formal_trust_policy_required');
      expect(formalStage9AdjudicatorExitCode(withoutExternalTrust)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('returns integrity_verified/not_adjudicated for a signed, file-backed integrity-only package', () => {
    const fixture = makeFixture('integrity_only');
    try {
      const result = adjudicate(fixture);
      expect(result).toMatchObject({
        status: 'integrity_verified',
        acceptanceDecision: 'not_adjudicated',
        acceptancePassed: false,
        fullAcceptance: false,
        errors: [],
        trust: { integrityVerified: true, acceptanceMode: 'integrity_only' },
      });
      expect(result.trust.evidenceFilesVerified).toBeGreaterThan(0);
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('accepts only independent external bundle, server, and native signatures over real files', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const result = adjudicate(fixture);
      expect(result).toMatchObject({
        status: 'accepted',
        acceptanceDecision: 'accepted',
        acceptancePassed: true,
        fullAcceptance: true,
        errors: [],
        scenarioCoverage: { complete: true },
        trust: { integrityVerified: true, acceptanceMode: 'dual_attestation' },
      });
      expect(result.producerChecks).toEqual(Object.fromEntries(
        FORMAL_STAGE9_PRODUCERS.map(producer => [producer, { passed: true }]),
      ));
      expect(formalStage9AdjudicatorExitCode(result)).toBe(0);
      expect(formalStage9AdjudicatorExitCode(structuredClone(result))).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects a directly sealed and signed bundle that bypasses the producer file manifest', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const current = fixture.bundle.producers.main;
      const payload = structuredClone(current.payload);
      delete payload.stage9ProducerEvidence;
      const producers = {
        ...fixture.bundle.producers,
        main: sealFormalStage9ProducerEvidence({
          producer: 'main',
          binding: fixture.commonBinding,
          payload,
          scenarioEvidence: current.scenarioEvidence,
          recordedAt: current.recordedAt,
        }),
      };
      fixture.bundle = signFormalStage9EvidenceBundle(sealFormalStage9EvidenceBundle({
        binding: fixture.commonBinding,
        producers,
        createdAt: CREATED_AT,
        completedAt: COMPLETED_AT,
      }), {
        keyId: fixture.keys.bundle.keyId,
        privateKey: fixture.keys.bundle.privateKey,
      });

      const result = adjudicate(fixture);
      expect(result.status).toBe('rejected');
      expect(result.errors).toContain('producer:main:file_manifest:required');
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects dual-attestation acceptance while the native client remains an unbound local claim', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      fixture.commonBinding.nativeClient = {
        ...fixture.commonBinding.nativeClient,
        trustLevel: 'proof_bound_local_claim',
        osAttested: false,
        webviewProfileTrustLevel: 'unbound',
        webviewProfileBound: false,
        webview2ProfileDirSha256: undefined,
        formalAcceptanceEligible: false,
      };
      const producers = Object.fromEntries(FORMAL_STAGE9_PRODUCERS.map(producer => {
        const typedProducer = producer as keyof typeof PAYLOADS;
        const evidence = scenarioEvidence({
          producer,
          commonBinding: fixture.commonBinding,
          evidenceRoot: fixture.evidenceRoot,
          keys: fixture.keys,
          mode: fixture.mode,
          fileBacked: true,
        });
        return [producer, sealFormalStage9ProducerEvidence({
          producer,
          binding: fixture.commonBinding,
          payload: attachProducerFileManifest({
            producer,
            payload: PAYLOADS[typedProducer](fixture.commonBinding),
            evidence,
            commonBinding: fixture.commonBinding,
            evidenceRoot: fixture.evidenceRoot,
          }),
          scenarioEvidence: evidence,
          recordedAt: RECORDED_AT,
        })];
      }));
      fixture.bundle = signFormalStage9EvidenceBundle(sealFormalStage9EvidenceBundle({
        binding: fixture.commonBinding,
        producers,
        createdAt: CREATED_AT,
        completedAt: COMPLETED_AT,
      }), {
        keyId: fixture.keys.bundle.keyId,
        privateKey: fixture.keys.bundle.privateKey,
      });
      const result = adjudicate(fixture);
      expect(result.status).toBe('rejected');
      expect(result.errors).toContain('formal_native_client_os_and_webview_attestation_required');
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects changed evidence bytes', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const reference = fixture.bundle.producers.main
        .scenarioEvidence.task_correction_three_times.taskReceipts[0];
      const absolutePath = path.join(fixture.evidenceRoot, ...reference.relativePath.split('/'));
      const bytes = fs.readFileSync(absolutePath);
      bytes[0] ^= 0xff;
      fs.writeFileSync(absolutePath, bytes);
      const result = adjudicate(fixture);
      expect(result.errors.some((code: string) => code.endsWith(':evidence_sha256_mismatch'))).toBe(true);
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects traversal even when the outside file hash and signatures are valid', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const contents = Buffer.from('{"outside":true}', 'utf8');
      fs.writeFileSync(path.join(fixture.root, 'outside.json'), contents);
      const scenario = fixture.bundle.producers.main.scenarioEvidence.task_correction_three_times;
      scenario.artifacts[0] = signFormalStage9EvidenceReference({
        ...scenario.artifacts[0],
        relativePath: '../outside.json',
        size: contents.length,
        sha256: hash(contents),
      }, {
        signerRole: 'server',
        keyId: fixture.keys.server.keyId,
        privateKey: fixture.keys.server.privateKey,
      });
      resealProducerAndBundle(fixture);
      const result = adjudicate(fixture);
      expect(result.errors.some((code: string) => code.includes('formal_evidence_relative_path_invalid'))).toBe(true);
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects a symlink or junction anywhere in an evidence path', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const outsideDirectory = path.join(fixture.root, 'outside-directory');
      fs.mkdirSync(outsideDirectory);
      const contents = Buffer.from('{"linked":true}', 'utf8');
      fs.writeFileSync(path.join(outsideDirectory, 'linked.json'), contents);
      fs.symlinkSync(
        outsideDirectory,
        path.join(fixture.evidenceRoot, 'linked-root'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const scenario = fixture.bundle.producers.main.scenarioEvidence.task_correction_three_times;
      scenario.artifacts[0] = signFormalStage9EvidenceReference({
        ...scenario.artifacts[0],
        relativePath: 'linked-root/linked.json',
        size: contents.length,
        sha256: hash(contents),
      }, {
        signerRole: 'server',
        keyId: fixture.keys.server.keyId,
        privateKey: fixture.keys.server.privateKey,
      });
      resealProducerAndBundle(fixture);
      const result = adjudicate(fixture);
      expect(result.errors.some((code: string) => (
        code.endsWith(':evidence_path_link_forbidden')
        || code.endsWith(':evidence_path_reparse_forbidden')
      ))).toBe(true);
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects the wrong external bundle key', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      fixture.policy = {
        ...fixture.policy,
        bundleSigner: {
          keyId: fixture.keys.bundle.keyId,
          algorithm: 'ed25519',
          publicKeyPem: fixture.keys.wrong.publicKeyPem,
        },
      };
      const result = adjudicate(fixture);
      expect(result.errors).toContain('formal_bundle_signature_invalid');
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects a reference signed by the wrong native key after operator resealing', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const scenario = fixture.bundle.producers.main.scenarioEvidence.task_correction_three_times;
      scenario.screenshots[0] = signFormalStage9EvidenceReference(scenario.screenshots[0], {
        signerRole: 'native',
        keyId: fixture.keys.native.keyId,
        privateKey: fixture.keys.wrong.privateKey,
      });
      resealProducerAndBundle(fixture);
      const result = adjudicate(fixture);
      expect(result.errors).toContain('task_correction_three_times:screenshots:native_attestation_invalid');
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects signed evidence that is marked publishable or lacks private-local classification', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const scenario = fixture.bundle.producers.main.scenarioEvidence.task_correction_three_times;
      scenario.artifacts[0] = signFormalStage9EvidenceReference({
        ...scenario.artifacts[0],
        sourceSecurity: {
          ...scenario.artifacts[0].sourceSecurity,
          publishable: true,
        },
      }, {
        signerRole: 'server',
        keyId: fixture.keys.server.keyId,
        privateKey: fixture.keys.server.privateKey,
      });
      resealProducerAndBundle(fixture);
      const result = adjudicate(fixture);
      expect(result.errors).toContain(
        'task_correction_three_times:artifacts:source_security_invalid',
      );
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects bundle mutation and signed embedded trust material', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      fixture.bundle.producers.main.payload.ok = false;
      let result = adjudicate(fixture);
      expect(result.errors).toEqual(expect.arrayContaining([
        'formal_bundle_digest_mismatch',
        'formal_bundle_signature_invalid',
      ]));

      const embedded = structuredClone(fixture.bundle);
      embedded.producers.main.payload.ok = true;
      embedded.publicKeyPem = fixture.keys.bundle.publicKeyPem;
      delete embedded.bundleSignature;
      delete embedded.bundleDigest;
      embedded.bundleDigest = formalStage9Digest(embedded);
      const signedEmbedded = signFormalStage9EvidenceBundle(embedded, {
        keyId: fixture.keys.bundle.keyId,
        privateKey: fixture.keys.bundle.privateKey,
      });
      result = adjudicateFormalStage9Evidence(signedEmbedded, {
        trustPolicy: fixture.policy,
        evidenceRoot: fixture.evidenceRoot,
      });
      expect(result.errors).toContain('formal_bundle_embedded_trust_material_forbidden');
      expect(formalStage9AdjudicatorExitCode(result)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  it('keeps every evidence producer unable to self-certify exit zero', () => {
    const completeProducer = {
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      fullAcceptance: false,
    };
    const forgedAcceptance = {
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'accepted',
      acceptancePassed: true,
      fullAcceptance: true,
    };
    expect(formalGateExitCode(completeProducer)).toBe(2);
    expect(restartEvidenceCliExitCode(completeProducer)).toBe(2);
    expect(failoverEvidenceCliExitCode(completeProducer)).toBe(2);
    expect(formalWpsBatchEvidenceCliExitCode(completeProducer)).toBe(2);
    expect(formalVariantEvidenceCliExitCode(completeProducer)).toBe(2);
    expect(formalGateExitCode(forgedAcceptance)).toBe(1);
    expect(restartEvidenceCliExitCode(forgedAcceptance)).toBe(1);
    expect(failoverEvidenceCliExitCode(forgedAcceptance)).toBe(1);
    expect(formalWpsBatchEvidenceCliExitCode(forgedAcceptance)).toBe(1);
    expect(formalVariantEvidenceCliExitCode(forgedAcceptance)).toBe(1);

    const forgedAdjudicatorDecision = {
      kind: FORMAL_STAGE9_DECISION_KIND,
      status: 'accepted',
      acceptanceDecision: 'accepted',
      acceptancePassed: true,
      fullAcceptance: true,
      trust: { integrityVerified: false, acceptanceMode: 'dual_attestation' },
      scenarioCoverage: { complete: true },
      producerChecks: Object.fromEntries(
        FORMAL_STAGE9_PRODUCERS.map(producer => [producer, { passed: true }]),
      ),
      errors: [],
    };
    expect(formalStage9AdjudicatorExitCode(forgedAdjudicatorDecision)).toBe(1);
  });

  it('requires external policy and evidence-root CLI inputs', () => {
    const fixture = makeFixture('dual_attestation');
    try {
      const script = path.join(process.cwd(), 'scripts', 'formal-stage9-adjudicator.mjs');
      const bundlePath = path.join(fixture.root, 'bundle.json');
      const policyPath = path.join(fixture.root, 'trust-policy.json');
      fs.writeFileSync(bundlePath, JSON.stringify(fixture.bundle), 'utf8');
      fs.writeFileSync(policyPath, JSON.stringify(fixture.policy), 'utf8');
      const accepted = spawnSync(process.execPath, [
        script,
        '--bundle', bundlePath,
        '--trust-policy', policyPath,
        '--trust-policy-sha256', hash(fs.readFileSync(policyPath)),
        '--evidence-root', fixture.evidenceRoot,
      ], { encoding: 'utf8' });
      expect(accepted.status).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({ status: 'accepted', acceptancePassed: true });

      const unpinned = spawnSync(process.execPath, [
        script,
        '--bundle', bundlePath,
        '--trust-policy', policyPath,
        '--evidence-root', fixture.evidenceRoot,
      ], { encoding: 'utf8', env: { ...process.env, LUMI_FORMAL_TRUST_POLICY_SHA256: '' } });
      expect(unpinned.status).toBe(1);
      expect(JSON.parse(unpinned.stdout).errors).toContain('formal_trust_policy_sha256_required');

      const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
      expect(help.status).toBe(1);
      expect(help.stdout).toContain('Formal Lumi Stage 9 adjudicator');

      for (const producerScript of [
        'formal-client-e2e.mjs',
        'formal-client-restart-recovery.mjs',
        'formal-model-failover-recovery.mjs',
        'formal-wps-batch-acceptance.mjs',
        'formal-variant-acceptance.mjs',
        'formal-stage9-producer-package.mjs',
      ]) {
        const producerHelp = spawnSync(
          process.execPath,
          [path.join(process.cwd(), 'scripts', producerScript), '--help'],
          { encoding: 'utf8' },
        );
        expect(producerHelp.status, producerScript).not.toBe(0);
      }

      const oldInvocation = spawnSync(process.execPath, [script, '--bundle', bundlePath], {
        encoding: 'utf8',
      });
      expect(oldInvocation.status).toBe(1);
      expect(JSON.parse(oldInvocation.stdout).errors).toContain('absolute_trust_policy_path_required');
    } finally {
      cleanup(fixture);
    }
  });
});
