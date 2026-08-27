import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
  REQUIRED_FORMAL_DATA_ROOT_DENYLIST,
  PortableExternalEvidenceCollector,
  assertPortableEvidenceRuntime,
  assertPortableEvidenceDataRoot,
  buildRequiredFormalDataRootDenylist,
  normalizePortableEvidenceManifest,
  portableEvidenceDataRootIdentity,
  portableEvidenceHmacKeyId,
  portablePhaseNonceRequestTag,
  readPortableEvidenceJsonFile,
  readPortableEvidenceKeyFile,
  signPortableEvidenceRecord,
  validatePortableEvidenceDocument,
  verifyPortableEvidenceRecord,
} from '../scripts/lib/portable-external-evidence.mjs';
import { probePortablePassiveStore } from '../scripts/lib/portable-passive-store-probe.mjs';
import {
  parsePortableExternalEvidenceCliArgs,
  portableExternalCollectorBundleSha256,
  runPortableExternalEvidenceCli,
} from '../scripts/portable-external-evidence.mjs';

const roots: string[] = [];
const HMAC_KEY = Buffer.alloc(32, 0x42);
const BUILD_DIGEST = 'a'.repeat(64);

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-portable-evidence-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'));
  return root;
}

function sqliteOpen(filename: string) {
  return new Promise<sqlite3.Database>((resolve, reject) => {
    const database = new sqlite3.Database(filename, error => {
      if (error) reject(error);
      else resolve(database);
    });
  });
}

function sqliteExec(database: sqlite3.Database, sql: string) {
  return new Promise<void>((resolve, reject) => {
    database.exec(sql, error => error ? reject(error) : resolve());
  });
}

function sqliteRun(database: sqlite3.Database, sql: string, params: unknown[] = []) {
  return new Promise<void>((resolve, reject) => {
    database.run(sql, params, error => error ? reject(error) : resolve());
  });
}

function sqliteClose(database: sqlite3.Database) {
  return new Promise<void>((resolve, reject) => {
    database.close(error => error ? reject(error) : resolve());
  });
}

async function createStore(
  root: string,
  duplicateTurn = false,
  providerMarker = '',
  secondProviderMarker = '',
  requestIds = { first: 'req-phase-one', second: 'req-phase-two' },
) {
  const database = await sqliteOpen(path.join(root, 'data', 'lumi.db'));
  await sqliteExec(database, `
    CREATE TABLE interactions (
      id TEXT PRIMARY KEY, userId TEXT, conversationId TEXT, requestId TEXT,
      role TEXT, message TEXT, response TEXT, toolCalls TEXT, timestamp TEXT,
      llmWasCalled INTEGER, cognitiveIntent TEXT, routeSequence INTEGER
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, userId TEXT, status TEXT, actionContinuationState TEXT
    );
    CREATE TABLE conversation_action_turns (
      id TEXT PRIMARY KEY, conversationId TEXT, userId TEXT, requestId TEXT,
      userMessageId TEXT, taskId TEXT, status TEXT, terminalMessageId TEXT,
      terminalReason TEXT, leaseOwnerId TEXT, leaseEpoch TEXT, leaseExpiresAt TEXT,
      revision INTEGER, createdAt TEXT, updatedAt TEXT, terminalAt TEXT
    );
    CREATE TABLE conversation_action_tasks (
      id TEXT PRIMARY KEY, conversationId TEXT, userId TEXT, rootUserMessageId TEXT,
      intentKind TEXT, operation TEXT, status TEXT, activeRequestId TEXT,
      completionSource TEXT, goal TEXT, target TEXT, context TEXT, revision INTEGER,
      createdAt TEXT, updatedAt TEXT, completedAt TEXT
    );
    CREATE TABLE conversation_action_receipts (
      id TEXT PRIMARY KEY, taskId TEXT, conversationId TEXT, turnId TEXT,
      requestId TEXT, idempotencyKey TEXT, toolName TEXT, targetIdentity TEXT,
      inputDigest TEXT, envelope TEXT, outcome TEXT, createdAt TEXT
    );
    CREATE TABLE model_routing_receipts (
      id TEXT PRIMARY KEY, conversationId TEXT, requestId TEXT, status TEXT,
      requestedProvider TEXT, requestedModel TEXT, selectedProvider TEXT,
      selectedModel TEXT, selectionMode TEXT, fallbackReason TEXT, attempts TEXT,
      startedAt TEXT, completedAt TEXT, durationMs INTEGER
    );
    CREATE TABLE pending_tool_confirmations (
      id TEXT PRIMARY KEY, revision INTEGER, status TEXT, userId TEXT,
      channelId TEXT, taskId TEXT, originRequestId TEXT, toolName TEXT,
      argsHash TEXT, target TEXT, payloadDigest TEXT, safeArgs TEXT,
      actionIntent TEXT, createdAt TEXT, updatedAt TEXT, expiresAt INTEGER
    );
  `);
  await sqliteRun(database,
    'INSERT INTO conversations VALUES (?, ?, ?, ?)',
    ['conv-portable', 'uid-portable', 'active', '{}'],
  );
  await sqliteRun(database,
    'INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['msg-user', 'uid-portable', 'conv-portable', requestIds.first, 'user',
      `portable marker prompt ${providerMarker}`, '', '[]', '2026-08-27T08:00:00.000Z', 1, 'continue', 1],
  );
  await sqliteRun(database,
    'INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['msg-user-two', 'uid-portable', 'conv-portable', requestIds.second, 'user',
      `portable second phase ${secondProviderMarker}`, '', '[]',
      '2026-08-27T08:00:02.000Z', 1, 'continue', 3],
  );
  await sqliteRun(database,
    'INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['msg-assistant', 'uid-portable', 'conv-portable', requestIds.first, 'assistant',
      'done', '', '[]', '2026-08-27T08:00:01.000Z', 1, 'continue', 2],
  );
  await sqliteRun(database,
    'INSERT INTO conversation_action_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['turn-one', 'conv-portable', 'uid-portable', requestIds.first, 'msg-user', '',
      'succeeded', 'msg-assistant', 'completed', '', '', '', 2,
      '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:01.000Z', '2026-08-27T08:00:01.000Z'],
  );
  if (duplicateTurn) {
    await sqliteRun(database,
      'INSERT INTO conversation_action_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['turn-two', 'conv-portable', 'uid-portable', requestIds.first, 'msg-user', 'task-wrong',
        'running', '', '', 'owner', 'epoch', '2026-08-27T08:10:00.000Z', 1,
        '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:02.000Z', ''],
    );
  }
  await sqliteRun(database,
    'INSERT INTO conversation_action_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['receipt-one', requestIds.first, 'conv-portable', 'turn-one', requestIds.first,
      'idempotency-one', 'runtime_work_cancel', 'runtime:all', 'input-digest',
      '{"verification":"verified"}', 'succeeded', '2026-08-27T08:00:01.000Z'],
  );
  await sqliteRun(database,
    'INSERT INTO model_routing_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['route-one', 'conv-portable', requestIds.first, 'succeeded', 'openai', 'stub',
      'openai', 'stub', 'fixed', '', '[{"status":"succeeded"}]',
      '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:01.000Z', 1000],
  );
  await sqliteRun(database,
    'INSERT INTO pending_tool_confirmations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['pending-one', 2, 'confirmed', 'uid-portable', 'conv-portable', requestIds.first,
      requestIds.first, 'runtime_work_cancel', 'args-digest', 'runtime:all', 'payload-digest',
      '{}', 'cancel', '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:01.000Z', 9999999999999],
  );
  await sqliteClose(database);
}

function manifestForRoot(
  root: string,
  options: { provider?: boolean; passive?: boolean; nonceBoundRequests?: boolean } = {},
) {
  const identity = portableEvidenceDataRootIdentity(root);
  const firstNonce = 'phase-nonce-00000001';
  const secondNonce = 'phase-nonce-00000002';
  const requestIds = options.nonceBoundRequests ? {
    first: `req-phase-one_${portablePhaseNonceRequestTag(firstNonce)}`,
    second: `req-phase-two_${portablePhaseNonceRequestTag(secondNonce)}`,
  } : { first: 'req-phase-one', second: 'req-phase-two' };
  return normalizePortableEvidenceManifest({
    kind: PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
    schemaVersion: 1,
    runId: 'portable-run-001',
    role: 'candidate',
    buildIdentityDigest: BUILD_DIGEST,
    profileSha256: 'b'.repeat(64),
    collectorBundleSha256: portableExternalCollectorBundleSha256(),
    fixturePlanSha256: 'c'.repeat(64),
    timeoutPolicy: {
      turnMs: 30_000,
      providerMs: 20_000,
      passiveStoreMs: 10_000,
      settleMs: 100,
    },
    platform: process.platform,
    nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
    dataRootIdentitySha256: identity.sha256,
    hmacKeyId: portableEvidenceHmacKeyId(HMAC_KEY),
    phases: [
      {
        scenarioId: 'cleanup_offer_then_cleanup',
        phaseId: 'cleanup',
        requestId: requestIds.first,
        phaseNonce: firstNonce,
        conversationId: 'conv-portable',
        userId: 'uid-portable',
        expectedToolName: 'runtime_work_cancel',
        requirements: {
          providerWitness: options.provider !== false,
          passiveStore: options.passive !== false,
        },
      },
      {
        scenarioId: 'cleanup_offer_then_cleanup',
        phaseId: 'after-cleanup',
        requestId: requestIds.second,
        phaseNonce: secondNonce,
        conversationId: 'conv-portable',
        userId: 'uid-portable',
        requirements: {
          providerWitness: options.provider !== false,
          passiveStore: options.passive !== false,
        },
      },
    ],
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('portable external evidence protocol', () => {
  it('binds every phase to an exact request and unique nonce', () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root);
    expect(manifest.phases[0].bindingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.phases[0].providerMarker).toContain(manifest.phases[0].bindingDigest);
    expect(manifest.phases[0].providerMarker).toContain('phase-nonce-00000001');
    expect(manifest.profileSha256).toBe('b'.repeat(64));
    expect(manifest.fixturePlanSha256).toBe('c'.repeat(64));
    expect(manifest.timeoutPolicy).toEqual({
      turnMs: 30_000,
      providerMs: 20_000,
      passiveStoreMs: 10_000,
      settleMs: 100,
    });
    expect(() => assertPortableEvidenceRuntime({
      ...manifest,
      manifestDigest: undefined,
      collectorBundleSha256: 'd'.repeat(64),
    }, portableExternalCollectorBundleSha256())).toThrowError(
      'portable_evidence_runtime_collector_bundle_mismatch',
    );

    expect(() => normalizePortableEvidenceManifest({
      ...manifest,
      phases: [manifest.phases[0], { ...manifest.phases[1], requestId: 'req-phase-one' }],
    })).toThrowError('portable_evidence_duplicate_request_id');
    expect(() => normalizePortableEvidenceManifest({
      ...manifest,
      phases: [manifest.phases[0], { ...manifest.phases[1], phaseNonce: 'phase-nonce-00000001' }],
    })).toThrowError('portable_evidence_duplicate_phase_nonce');
  });

  it('rejects the formal LumiOS root and descendants before filesystem access', () => {
    const [legacyRoot, currentRoot] = REQUIRED_FORMAL_DATA_ROOT_DENYLIST;
    expect(() => assertPortableEvidenceDataRoot(
      legacyRoot,
      { mustExist: false },
    )).toThrowError('portable_evidence_formal_data_root_forbidden');
    expect(() => assertPortableEvidenceDataRoot(
      path.join(legacyRoot, 'data'),
      { mustExist: false },
    )).toThrowError('portable_evidence_formal_data_root_forbidden');
    expect(() => assertPortableEvidenceDataRoot(
      path.join(currentRoot, 'data'),
      { mustExist: false },
    )).toThrowError('portable_evidence_formal_data_root_forbidden');
  });

  it('derives portable formal-root protection without embedding a developer profile', () => {
    const exampleHome = process.platform === 'win32'
      ? 'C:\\Users\\ExampleUser'
      : '/home/example-user';
    const explicitRoot = path.resolve(exampleHome, 'CustomLumiData');
    expect(buildRequiredFormalDataRootDenylist(exampleHome, explicitRoot)).toEqual([
      path.resolve(exampleHome, 'LumiOS'),
      path.resolve(exampleHome, 'LumiCore'),
      explicitRoot,
    ]);
    expect(() => buildRequiredFormalDataRootDenylist(exampleHome, 'relative-data'))
      .toThrowError('portable_evidence_explicit_data_root_invalid');
  });

  it('HMAC-attests canonical records and fails closed after tampering', () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root);
    const signed = signPortableEvidenceRecord({
      kind: 'fixture',
      manifestDigest: manifest.manifestDigest,
      value: { b: 2, a: 1 },
    }, HMAC_KEY);
    expect(verifyPortableEvidenceRecord(signed, HMAC_KEY)).toBe(true);
    expect(verifyPortableEvidenceRecord({ ...signed, value: { a: 9, b: 2 } }, HMAC_KEY)).toBe(false);
    expect(verifyPortableEvidenceRecord(signed, Buffer.alloc(32, 0x43))).toBe(false);
  });

  it('rejects hard-linked key and manifest inputs', () => {
    const root = makeRoot();
    const keySource = path.join(root, 'key-source.bin');
    const keyLink = path.join(root, 'key-link.bin');
    fs.writeFileSync(keySource, HMAC_KEY);
    fs.linkSync(keySource, keyLink);
    expect(() => readPortableEvidenceKeyFile(keyLink)).toThrowError(
      'portable_evidence_key_file_invalid',
    );

    const manifestSource = path.join(root, 'manifest-source.json');
    const manifestLink = path.join(root, 'manifest-link.json');
    fs.writeFileSync(manifestSource, '{"kind":"fixture"}\n', 'utf8');
    fs.linkSync(manifestSource, manifestLink);
    expect(() => readPortableEvidenceJsonFile(manifestLink)).toThrowError(
      'portable_evidence_json_file_invalid',
    );
  });

  it('retains every provider call and requires an exact provider request nonce', () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { passive: false });
    const phase = manifest.phases[0];
    const historical = manifest.phases[1].providerMarker;
    const payload = {
      model: 'portable-stub',
      stream: true,
      messages: [
        { role: 'user', content: 'earlier unmarked request' },
        { role: 'assistant', content: 'earlier response' },
        { role: 'user', content: `run ${phase.providerMarker}` },
      ],
      tools: [{ type: 'function', function: { name: 'runtime_work_cancel' } }],
    };
    const collector = new PortableExternalEvidenceCollector({
      manifest,
      hmacKey: HMAC_KEY,
      now: () => new Date('2026-08-27T08:00:00.000Z'),
    });
    const selector = {
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: phase.requestId,
      phaseNonce: phase.phaseNonce,
    };
    const first = collector.captureProviderRequest(selector, payload, {
      providerRequestNonce: 'provider-nonce-00000001',
    });
    const second = collector.captureProviderRequest(selector, payload, {
      providerRequestNonce: 'provider-nonce-00000002',
    });
    expect(first.captureOrdinal).toBe(1);
    expect(second.captureOrdinal).toBe(2);
    expect(first.observedPhaseBindingDigests).toEqual([manifest.phases[0].bindingDigest]);
    expect(first.matchedUserMessageIndex).toBe(2);
    expect(first.latestUserMessageIndex).toBe(2);
    expect(first.markerCardinality).toEqual({
      portablePayload: 1,
      selectedPhasePayload: 1,
      latestUserMessage: 1,
    });
    expect(verifyPortableEvidenceRecord(first, HMAC_KEY)).toBe(true);
    expect(() => collector.getProviderCapture(selector, '')).toThrowError(
      'portable_evidence_provider_request_nonce_required',
    );
    expect(collector.getProviderCapture(selector, 'provider-nonce-00000001')).toEqual(first);
    expect(() => collector.captureProviderRequest(selector, payload, {
      providerRequestNonce: 'provider-nonce-00000001',
    })).toThrowError('portable_evidence_duplicate_provider_request_nonce');
    expect(() => collector.captureProviderRequest(selector, {
      ...payload,
      messages: [{ role: 'user', content: 'marker removed' }],
    }, { providerRequestNonce: 'provider-nonce-00000003' })).toThrowError(
      'portable_evidence_provider_phase_marker_missing',
    );
    expect(() => collector.captureProviderRequest(selector, {
      ...payload,
      messages: [
        { role: 'user', content: phase.providerMarker },
        { role: 'user', content: 'newer unmarked request' },
      ],
    }, { providerRequestNonce: 'provider-nonce-00000004' })).toThrowError(
      'portable_evidence_provider_phase_marker_not_latest_user_message',
    );
    expect(() => collector.captureProviderRequest(selector, {
      ...payload,
      messages: [
        { role: 'user', content: historical },
        { role: 'user', content: phase.providerMarker },
      ],
    }, { providerRequestNonce: 'provider-nonce-00000005' })).toThrowError(
      'portable_evidence_provider_marker_cardinality_invalid',
    );
    expect(() => collector.captureProviderRequest(selector, {
      ...payload,
      messages: [{ role: 'user', content: `${phase.providerMarker} ${phase.providerMarker}` }],
    }, { providerRequestNonce: 'provider-nonce-00000006' })).toThrowError(
      'portable_evidence_provider_phase_marker_ambiguous',
    );
  });

  it('sanitizes malformed provider JSON errors without retaining raw body fragments', () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { passive: false });
    const phase = manifest.phases[0];
    const collector = new PortableExternalEvidenceCollector({ manifest, hmacKey: HMAC_KEY });
    let thrown: any = null;
    try {
      collector.captureProviderRequest({
        scenarioId: phase.scenarioId,
        phaseId: phase.phaseId,
        requestId: phase.requestId,
        phaseNonce: phase.phaseNonce,
      }, Buffer.from('example-secret-provider-body', 'utf8'), {
        providerRequestNonce: 'provider-nonce-malformed-0001',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('portable_evidence_provider_payload_invalid_json');
    expect(thrown?.cause).toBeUndefined();
    expect(String(thrown?.message || '')).not.toContain('example-secret-provider-body');
    expect(JSON.stringify(thrown?.details || {})).not.toContain('example-secret-provider-body');
  });

  it('joins the accepted user row to provider witness evidence through the exact marker', async () => {
    const root = makeRoot();
    const base = manifestForRoot(root);
    const manifest = normalizePortableEvidenceManifest({
      ...base,
      manifestDigest: undefined,
      phases: [base.phases[0]],
    });
    const phase = manifest.phases[0];
    await createStore(root, false, phase.providerMarker);
    const probe = await probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
      capturedAt: '2026-08-27T08:05:00.000Z',
    });
    const collector = new PortableExternalEvidenceCollector({ manifest, hmacKey: HMAC_KEY });
    collector.addStoreSnapshot(probe.snapshots[0]);
    collector.captureProviderRequest({
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: phase.requestId,
      phaseNonce: phase.phaseNonce,
    }, {
      model: 'portable-stub',
      messages: [{ role: 'user', content: phase.providerMarker }],
    }, { providerRequestNonce: 'provider-nonce-join-0001' });
    const bundle = collector.buildBundle();
    expect(bundle.dataRootIdentitySha256).toBe(manifest.dataRootIdentitySha256);
    expect(bundle.complete).toBe(true);
    expect(bundle.phaseEvidence[0].acceptedUserProviderJoin).toMatchObject({
      required: true,
      complete: true,
      bindingDigest: phase.bindingDigest,
      providerRequestNonces: ['provider-nonce-join-0001'],
    });
    expect(verifyPortableEvidenceRecord(bundle, HMAC_KEY)).toBe(true);
  });

  it('rejects a signed store snapshot whose source is not the manifest data root', async () => {
    const root = makeRoot();
    const base = manifestForRoot(root, { provider: false });
    const manifest = normalizePortableEvidenceManifest({
      ...base,
      manifestDigest: undefined,
      phases: [base.phases[0]],
    });
    await createStore(root, false, manifest.phases[0].providerMarker);
    const probe = await probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
      capturedAt: '2026-08-27T08:05:00.000Z',
    });
    const { attestation: _attestation, ...unsigned } = probe.snapshots[0];
    const wrongRootSnapshot = signPortableEvidenceRecord({
      ...unsigned,
      source: {
        ...unsigned.source,
        dataRootIdentitySha256: 'f'.repeat(64),
      },
    }, HMAC_KEY);
    const collector = new PortableExternalEvidenceCollector({ manifest, hmacKey: HMAC_KEY });
    expect(() => collector.addStoreSnapshot(wrongRootSnapshot)).toThrowError(
      'portable_evidence_store_snapshot_data_root_mismatch',
    );
    expect(validatePortableEvidenceDocument(wrongRootSnapshot, HMAC_KEY, manifest)).toEqual({
      ok: false,
      issues: ['store_data_root_identity_mismatch'],
    });
  });
});

describe('portable passive SQLite store probe', () => {
  it('uses exact selectors and preserves missing versus cleared without modifying the DB', async () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { provider: false });
    await createStore(
      root,
      false,
      manifest.phases[0].providerMarker,
      manifest.phases[1].providerMarker,
    );
    const databasePath = path.join(root, 'data', 'lumi.db');
    const before = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
    const result = await probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
      capturedAt: '2026-08-27T08:05:00.000Z',
    });
    const after = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');

    expect(after).toBe(before);
    expect(verifyPortableEvidenceRecord(result, HMAC_KEY)).toBe(true);
    expect(result.selectionPolicy).toContain('no_latest_wins');
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots.every((item: any) => verifyPortableEvidenceRecord(item, HMAC_KEY))).toBe(true);

    const first = result.snapshots[0];
    expect(first.binding.requestId).toBe('req-phase-one');
    expect(first.observations.livePointer.state).toBe('cleared');
    expect(first.observations.acceptedUserRow.state).toBe('present');
    expect(first.observations.acceptedUserRow.providerMarkerCount).toBe(1);
    expect(first.observations.turn.state).toBe('present');
    expect(first.observations.task.state).toBe('cleared');
    expect(first.observations.pending.state).toBe('cleared');
    expect(first.observations.receipts.state).toBe('present');
    expect(first.expectedToolReceiptCount).toBe(1);
    expect(first.observations.assistantReplies.state).toBe('present');
    expect(first.structurallyComplete).toBe(true);

    const second = result.snapshots[1];
    expect(second.binding.requestId).toBe('req-phase-two');
    expect(second.observations.livePointer.state).toBe('cleared');
    expect(second.observations.turn.state).toBe('missing');
    expect(second.observations.task.state).toBe('missing');
    expect(second.observations.pending.state).toBe('missing');
    expect(second.observations.receipts.state).toBe('missing');
    expect(second.structurallyComplete).toBe(true);
  });

  it('fails the accepted-user-row join when the exact phase marker is absent', async () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { provider: false });
    await createStore(root);
    const result = await probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
      capturedAt: '2026-08-27T08:05:00.000Z',
    });
    const first = result.snapshots[0];
    expect(first.observations.acceptedUserRow.state).toBe('invalid');
    expect(first.observations.acceptedUserRow.reason).toBe(
      'provider_marker_missing_from_accepted_user_row',
    );
    expect(first.structurallyComplete).toBe(false);
    expect(first.structuralIssues).toContain('acceptedUserRow:invalid');
  });

  it('binds marker-free control turns through exact request ids derived from signed phase nonces', async () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { provider: false, nonceBoundRequests: true });
    const requestIds = {
      first: manifest.phases[0].requestId,
      second: manifest.phases[1].requestId,
    };
    await createStore(root, false, '', '', requestIds);
    const result = await probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
      capturedAt: '2026-08-27T08:05:00.000Z',
    });

    for (const snapshot of result.snapshots) {
      expect(snapshot.observations.acceptedUserRow).toMatchObject({
        state: 'present',
        bindingMode: 'exact_request_id_with_manifest_nonce_tag',
        providerMarkerCount: 0,
      });
      expect(snapshot.structuralIssues).not.toContain('acceptedUserRow:invalid');
    }
  });

  it('rejects a hard-linked SQLite database before OPEN_READONLY', async () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { provider: false });
    await createStore(
      root,
      false,
      manifest.phases[0].providerMarker,
      manifest.phases[1].providerMarker,
    );
    const databasePath = path.join(root, 'data', 'lumi.db');
    const sourcePath = path.join(root, 'linked-database-source.db');
    fs.renameSync(databasePath, sourcePath);
    fs.linkSync(sourcePath, databasePath);
    await expect(probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
    })).rejects.toThrowError('portable_store_database_invalid');
  });

  it('rejects hard-linked WAL, SHM, and journal sidecars before OPEN_READONLY', async () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const root = makeRoot();
      const manifest = manifestForRoot(root, { provider: false });
      await createStore(
        root,
        false,
        manifest.phases[0].providerMarker,
        manifest.phases[1].providerMarker,
      );
      const databasePath = path.join(root, 'data', 'lumi.db');
      const sourcePath = path.join(root, `linked-sidecar${suffix}`);
      fs.writeFileSync(sourcePath, Buffer.alloc(64, 0x31));
      fs.linkSync(sourcePath, `${databasePath}${suffix}`);
      await expect(probePortablePassiveStore({
        manifest,
        dataRoot: root,
        hmacKey: HMAC_KEY,
      })).rejects.toThrowError('portable_store_sqlite_sidecar_invalid');
    }
  });

  it('reports an ambiguous exact selector instead of choosing the newest row', async () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { provider: false });
    await createStore(
      root,
      true,
      manifest.phases[0].providerMarker,
      manifest.phases[1].providerMarker,
    );
    const result = await probePortablePassiveStore({
      manifest,
      dataRoot: root,
      hmacKey: HMAC_KEY,
      capturedAt: '2026-08-27T08:05:00.000Z',
    });
    const first = result.snapshots[0];
    expect(first.observations.turn.state).toBe('ambiguous');
    expect(first.observations.turn.rowCount).toBe(2);
    expect(first.observations.turn.rows.map((row: any) => row.id)).toEqual(['turn-one', 'turn-two']);
    expect(first.observations.task.state).toBe('ambiguous');
    expect(first.structurallyComplete).toBe(false);
    expect(first.structuralIssues).toContain('turn:ambiguous');
  });
});

describe('portable evidence CLI contract', () => {
  it('has only explicit commands and rejects latest/newest selectors', () => {
    expect(parsePortableExternalEvidenceCliArgs(['--help']).command).toBe('help');
    expect(() => parsePortableExternalEvidenceCliArgs([
      'probe-store', '--manifest', 'm.json', '--data-root', 'D:\\isolated',
      '--hmac-key-file', 'key.bin', '--latest',
    ])).toThrowError('portable_evidence_cli_flag_invalid');
    expect(() => parsePortableExternalEvidenceCliArgs([
      'capture-provider', '--manifest', 'm.json', '--payload-file', 'p.json',
      '--hmac-key-file', 'key.bin', '--scenario-id', 's1', '--phase-id', 'p1',
      '--request-id', 'r1', '--phase-nonce', 'phase-nonce-00000001',
    ])).toThrowError('portable_evidence_cli_provider_request_nonce_required');
  });

  it('runs the read-only probe contract and emits verifiable signed JSON', async () => {
    const root = makeRoot();
    const manifest = manifestForRoot(root, { provider: false });
    await createStore(
      root,
      false,
      manifest.phases[0].providerMarker,
      manifest.phases[1].providerMarker,
    );
    const manifestPath = path.join(root, 'manifest.json');
    const keyPath = path.join(root, 'evidence.key');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    fs.writeFileSync(keyPath, HMAC_KEY);
    let output = '';
    const code = await runPortableExternalEvidenceCli([
      'probe-store', '--manifest', manifestPath, '--data-root', root,
      '--hmac-key-file', keyPath, '--captured-at', '2026-08-27T08:05:00.000Z',
    ], { write: (value: string) => { output += value; } });
    const evidence = JSON.parse(output);
    expect(code).toBe(0);
    expect(verifyPortableEvidenceRecord(evidence, HMAC_KEY)).toBe(true);
    expect(validatePortableEvidenceDocument(evidence, HMAC_KEY, manifest)).toEqual({
      ok: true,
      issues: [],
    });
  });
});
