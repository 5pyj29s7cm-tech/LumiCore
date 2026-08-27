import {
  PortableExternalEvidenceCollector,
  portableEvidenceSha256,
  stablePortableEvidenceJson,
} from './portable-external-evidence.mjs';
import { createSignedPortableManifest } from './portable-evidence-comparison.mjs';
import {
  createPortablePairedManifestCores,
  createPortablePairedRunnerHooks,
  portablePairedHmacKeyId,
  projectSignedPortableTaskRegressionBuildIdentity,
} from './portable-paired-runner.mjs';
import {
  taskRegressionBuildIdentityDigest,
  validateTaskRegressionBuildIdentity,
} from './task-regression-matrix.mjs';

export const PORTABLE_PAIRED_PREPARED_BARRIER_KIND = 'lumi.portable-paired-prepared-barrier';
export const PORTABLE_PAIRED_PREPARED_BARRIER_SCHEMA_VERSION = 1;
export const PORTABLE_PAIRED_MEMORY_KIT_KIND = 'lumi.portable-paired-memory-kit';

const ROLES = Object.freeze(['baseline', 'candidate']);
const TERMINAL_STATES = new Set(['released', 'failed', 'timed_out', 'cancelled']);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SAFE_NONCE_RE = /^[A-Za-z0-9_-]{16,192}$/u;
const MAX_TURN_ORDINAL = 10_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 600_000;

export class PortablePairedBarrierError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'PortablePairedBarrierError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new PortablePairedBarrierError(code, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required, code) {
  if (!isPlainObject(value)) fail(code);
  const keys = Object.keys(value).sort();
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    fail(code);
  }
  return value;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value, code) {
  try {
    return JSON.parse(stablePortableEvidenceJson(value));
  } catch {
    fail(code);
  }
}

function requiredText(value, code, pattern = SAFE_ID_RE) {
  const text = String(value || '').trim();
  if (!text || (pattern && !pattern.test(text))) fail(code);
  return text;
}

function exactSha256(value, code) {
  const digest = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(digest)) fail(code);
  return digest;
}

function boundedInteger(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  if (!ROLES.includes(role)) fail('portable_paired_barrier_role_invalid');
  return role;
}

function normalizeRequirements(input) {
  const value = exactKeys(
    input,
    ['passiveStore', 'providerWitness'],
    ['passiveStore', 'providerWitness'],
    'portable_paired_barrier_fixture_invalid',
  );
  if (typeof value.passiveStore !== 'boolean' || typeof value.providerWitness !== 'boolean') {
    fail('portable_paired_barrier_fixture_invalid');
  }
  return {
    passiveStore: value.passiveStore,
    providerWitness: value.providerWitness,
  };
}

function normalizeFixture(input) {
  const value = exactKeys(
    input,
    ['phases'],
    ['phases'],
    'portable_paired_barrier_fixture_invalid',
  );
  if (!Array.isArray(value.phases) || value.phases.length === 0) {
    fail('portable_paired_barrier_fixture_invalid');
  }
  const phaseKeys = new Set();
  const scenarioTurns = new Set();
  const phases = value.phases.map(item => {
    const phase = exactKeys(
      item,
      [
        'scenarioId', 'phaseId', 'turnOrdinal', 'unmarkedUserTextSha256',
        'expectedToolName', 'requirements',
      ],
      ['scenarioId', 'phaseId', 'turnOrdinal', 'unmarkedUserTextSha256', 'requirements'],
      'portable_paired_barrier_fixture_invalid',
    );
    const normalized = {
      scenarioId: requiredText(phase.scenarioId, 'portable_paired_barrier_fixture_invalid'),
      phaseId: requiredText(phase.phaseId, 'portable_paired_barrier_fixture_invalid'),
      turnOrdinal: boundedInteger(
        phase.turnOrdinal,
        'portable_paired_barrier_fixture_invalid',
        1,
        MAX_TURN_ORDINAL,
      ),
      unmarkedUserTextSha256: exactSha256(
        phase.unmarkedUserTextSha256,
        'portable_paired_barrier_fixture_invalid',
      ),
      expectedToolName: String(phase.expectedToolName || '').trim(),
      requirements: normalizeRequirements(phase.requirements),
    };
    if (normalized.expectedToolName && !SAFE_ID_RE.test(normalized.expectedToolName)) {
      fail('portable_paired_barrier_fixture_invalid');
    }
    const phaseKey = `${normalized.scenarioId}\0${normalized.phaseId}`;
    const turnKey = `${normalized.scenarioId}\0${normalized.turnOrdinal}`;
    if (phaseKeys.has(phaseKey) || scenarioTurns.has(turnKey)) {
      fail('portable_paired_barrier_fixture_invalid');
    }
    phaseKeys.add(phaseKey);
    scenarioTurns.add(turnKey);
    return normalized;
  });
  return deepFreeze({ phases });
}

function fixtureDigest(fixture) {
  return portableEvidenceSha256({
    kind: 'lumi.portable-paired-fixture-plan',
    schemaVersion: 1,
    phases: fixture.phases,
  });
}

export function portablePairedFixturePlanSha256(input) {
  return fixtureDigest(normalizeFixture(input));
}

function normalizeTimeoutPolicy(input) {
  const value = exactKeys(
    input,
    ['turnMs', 'providerMs', 'passiveStoreMs', 'settleMs'],
    ['turnMs', 'providerMs', 'passiveStoreMs', 'settleMs'],
    'portable_paired_barrier_parity_invalid',
  );
  return {
    turnMs: boundedInteger(value.turnMs, 'portable_paired_barrier_parity_invalid', 100, 600_000),
    providerMs: boundedInteger(
      value.providerMs,
      'portable_paired_barrier_parity_invalid',
      100,
      600_000,
    ),
    passiveStoreMs: boundedInteger(
      value.passiveStoreMs,
      'portable_paired_barrier_parity_invalid',
      100,
      600_000,
    ),
    settleMs: boundedInteger(value.settleMs, 'portable_paired_barrier_parity_invalid', 0, 60_000),
  };
}

function normalizeParity(input, fixturePlanSha256) {
  const value = exactKeys(
    input,
    ['profileSha256', 'collectorBundleSha256', 'timeoutPolicy', 'platform', 'nodeMajor'],
    ['profileSha256', 'collectorBundleSha256', 'timeoutPolicy', 'platform', 'nodeMajor'],
    'portable_paired_barrier_parity_invalid',
  );
  const platform = requiredText(value.platform, 'portable_paired_barrier_parity_invalid');
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    fail('portable_paired_barrier_parity_invalid');
  }
  return deepFreeze({
    profileSha256: exactSha256(value.profileSha256, 'portable_paired_barrier_parity_invalid'),
    collectorBundleSha256: exactSha256(
      value.collectorBundleSha256,
      'portable_paired_barrier_parity_invalid',
    ),
    fixturePlanSha256,
    timeoutPolicy: normalizeTimeoutPolicy(value.timeoutPolicy),
    platform,
    nodeMajor: boundedInteger(value.nodeMajor, 'portable_paired_barrier_parity_invalid', 18, 99),
  });
}

function normalizeHmacKey(value, role) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    fail('portable_paired_barrier_hmac_key_invalid', { role });
  }
  const bytes = Buffer.from(value);
  if (bytes.length < 32 || bytes.length > 4096) {
    fail('portable_paired_barrier_hmac_key_invalid', { role });
  }
  return bytes;
}

function normalizeConfig(input) {
  const value = exactKeys(
    input,
    ['parity', 'fixture', 'hmacKeys', 'timeoutMs'],
    ['parity', 'fixture', 'hmacKeys', 'timeoutMs'],
    'portable_paired_barrier_config_invalid',
  );
  const fixture = normalizeFixture(value.fixture);
  const fixturePlanSha256 = fixtureDigest(fixture);
  const parity = normalizeParity(value.parity, fixturePlanSha256);
  const coverageSha256 = portableEvidenceSha256(fixture.phases);
  const paritySha256 = portableEvidenceSha256({ ...parity, coverageSha256 });
  const keyInput = exactKeys(
    value.hmacKeys,
    ['baseline', 'candidate'],
    ['baseline', 'candidate'],
    'portable_paired_barrier_config_invalid',
  );
  const keys = {
    baseline: normalizeHmacKey(keyInput.baseline, 'baseline'),
    candidate: normalizeHmacKey(keyInput.candidate, 'candidate'),
  };
  const hmacKeyIds = {
    baseline: portablePairedHmacKeyId(keys.baseline),
    candidate: portablePairedHmacKeyId(keys.candidate),
  };
  if (hmacKeyIds.baseline === hmacKeyIds.candidate) {
    fail('portable_paired_barrier_distinct_hmac_keys_required');
  }
  const timeoutMs = boundedInteger(
    value.timeoutMs,
    'portable_paired_barrier_timeout_invalid',
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  return {
    publicConfig: deepFreeze({
      parity,
      fixture,
      hmacKeyIds,
      timeoutMs,
      coverageSha256,
      paritySha256,
    }),
    keys,
  };
}

function normalizePreparedPhase(input, expected) {
  const value = exactKeys(
    input,
    [
      'scenarioId', 'phaseId', 'requestId', 'phaseNonce',
      'turnOrdinal', 'unmarkedUserTextSha256',
    ],
    [
      'scenarioId', 'phaseId', 'requestId', 'phaseNonce',
      'turnOrdinal', 'unmarkedUserTextSha256',
    ],
    'portable_paired_barrier_prepared_invalid',
  );
  const normalized = {
    scenarioId: requiredText(value.scenarioId, 'portable_paired_barrier_prepared_invalid'),
    phaseId: requiredText(value.phaseId, 'portable_paired_barrier_prepared_invalid'),
    requestId: requiredText(value.requestId, 'portable_paired_barrier_prepared_invalid'),
    phaseNonce: requiredText(
      value.phaseNonce,
      'portable_paired_barrier_prepared_invalid',
      SAFE_NONCE_RE,
    ),
    turnOrdinal: boundedInteger(
      value.turnOrdinal,
      'portable_paired_barrier_prepared_invalid',
      1,
      MAX_TURN_ORDINAL,
    ),
    unmarkedUserTextSha256: exactSha256(
      value.unmarkedUserTextSha256,
      'portable_paired_barrier_prepared_invalid',
    ),
  };
  if (normalized.scenarioId !== expected.scenarioId
    || normalized.phaseId !== expected.phaseId
    || normalized.turnOrdinal !== expected.turnOrdinal
    || normalized.unmarkedUserTextSha256 !== expected.unmarkedUserTextSha256) {
    fail('portable_paired_barrier_identity_mismatch');
  }
  return normalized;
}

function normalizePrepared(input, fixture) {
  const value = exactKeys(
    input,
    [
      'role', 'runId', 'taskRegressionBuildIdentity', 'dataRootIdentitySha256',
      'userId', 'conversationId', 'phases',
    ],
    [
      'role', 'runId', 'taskRegressionBuildIdentity', 'dataRootIdentitySha256',
      'userId', 'conversationId', 'phases',
    ],
    'portable_paired_barrier_prepared_invalid',
  );
  const role = normalizeRole(value.role);
  const validation = validateTaskRegressionBuildIdentity(value.taskRegressionBuildIdentity);
  if (!validation.ok || (role === 'baseline' && value.taskRegressionBuildIdentity?.sourceDirty !== false)) {
    fail('portable_paired_barrier_build_identity_invalid', { role });
  }
  let buildIdentityDigest;
  try {
    buildIdentityDigest = taskRegressionBuildIdentityDigest(value.taskRegressionBuildIdentity);
  } catch {
    fail('portable_paired_barrier_build_identity_invalid', { role });
  }
  if (!Array.isArray(value.phases) || value.phases.length !== fixture.phases.length) {
    fail('portable_paired_barrier_identity_mismatch', { role });
  }
  const phases = value.phases.map((phase, index) => normalizePreparedPhase(
    phase,
    fixture.phases[index],
  ));
  const requestIds = phases.map(phase => phase.requestId);
  const phaseNonces = phases.map(phase => phase.phaseNonce);
  if (new Set(requestIds).size !== requestIds.length
    || new Set(phaseNonces).size !== phaseNonces.length) {
    fail('portable_paired_barrier_identity_mismatch', { role });
  }
  return deepFreeze({
    role,
    runId: requiredText(value.runId, 'portable_paired_barrier_prepared_invalid'),
    taskRegressionBuildIdentity: cloneJson(
      value.taskRegressionBuildIdentity,
      'portable_paired_barrier_build_identity_invalid',
    ),
    taskRegressionBuildIdentityDigest: buildIdentityDigest,
    dataRootIdentitySha256: exactSha256(
      value.dataRootIdentitySha256,
      'portable_paired_barrier_prepared_invalid',
    ),
    userId: requiredText(value.userId, 'portable_paired_barrier_prepared_invalid'),
    conversationId: requiredText(value.conversationId, 'portable_paired_barrier_prepared_invalid'),
    phases,
  });
}

function preparedSummary(prepared) {
  if (!prepared) return { prepared: false };
  return {
    prepared: true,
    runId: prepared.runId,
    taskRegressionBuildIdentityDigest: prepared.taskRegressionBuildIdentityDigest,
    dataRootIdentitySha256: prepared.dataRootIdentitySha256,
    userIdSha256: portableEvidenceSha256(prepared.userId),
    conversationIdSha256: portableEvidenceSha256(prepared.conversationId),
    phaseCount: prepared.phases.length,
    preparedDigest: portableEvidenceSha256({
      role: prepared.role,
      runId: prepared.runId,
      taskRegressionBuildIdentityDigest: prepared.taskRegressionBuildIdentityDigest,
      dataRootIdentitySha256: prepared.dataRootIdentitySha256,
      userIdSha256: portableEvidenceSha256(prepared.userId),
      conversationIdSha256: portableEvidenceSha256(prepared.conversationId),
      phases: prepared.phases,
    }),
  };
}

function assertPairIdentity(baseline, candidate) {
  if (baseline.runId === candidate.runId
    || baseline.taskRegressionBuildIdentityDigest === candidate.taskRegressionBuildIdentityDigest
    || baseline.dataRootIdentitySha256 === candidate.dataRootIdentitySha256) {
    fail('portable_paired_barrier_identity_mismatch');
  }
  const baselineBuild = baseline.taskRegressionBuildIdentity;
  const candidateBuild = candidate.taskRegressionBuildIdentity;
  if (baselineBuild.sourceFingerprintSha256 === candidateBuild.sourceFingerprintSha256
    && baselineBuild.runtimeFingerprintSha256 === candidateBuild.runtimeFingerprintSha256) {
    fail('portable_paired_barrier_identity_mismatch');
  }
  const baselineRequests = new Set(baseline.phases.map(phase => phase.requestId));
  const baselineNonces = new Set(baseline.phases.map(phase => phase.phaseNonce));
  if (candidate.phases.some(phase => baselineRequests.has(phase.requestId)
    || baselineNonces.has(phase.phaseNonce))) {
    fail('portable_paired_barrier_identity_mismatch');
  }
}

function roleBindings(prepared) {
  return prepared.phases.map(phase => ({
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
    conversationId: prepared.conversationId,
    userId: prepared.userId,
  }));
}

function createMemoryKit(role, values) {
  const summary = deepFreeze({
    kind: PORTABLE_PAIRED_MEMORY_KIT_KIND,
    schemaVersion: 1,
    role,
    runId: values.prepared.runId,
    sourceBuildIdentityDigest: values.projection.sourceBuildIdentityDigest,
    portableBuildIdentityDigest: values.projection.portableBuildIdentity.buildIdentityDigest,
    manifestDigest: values.manifest.manifestDigest,
    dataRootIdentitySha256: values.manifest.dataRootIdentitySha256,
    paritySha256: values.plan.paritySha256,
    coverageSha256: values.plan.coverageSha256,
    phaseCount: values.manifest.phases.length,
  });
  const kit = {
    kind: PORTABLE_PAIRED_MEMORY_KIT_KIND,
    schemaVersion: 1,
    role,
    summary,
  };
  Object.defineProperties(kit, {
    buildProjection: { value: values.projection, enumerable: false },
    portableBuildIdentity: {
      value: values.projection.portableBuildIdentity,
      enumerable: false,
    },
    manifest: { value: values.manifest, enumerable: false },
    signedManifest: { value: values.signedManifest, enumerable: false },
    pairedPlan: { value: values.plan, enumerable: false },
    hooks: { value: values.hooks, enumerable: false },
    collector: { value: values.collector, enumerable: false },
    toJSON: { value: () => summary, enumerable: false },
  });
  return Object.freeze(kit);
}

export class PortablePairedPreparedBarrier {
  #config;
  #keys;
  #state = 'open';
  #prepared = new Map();
  #waiters = new Map();
  #kits = null;
  #timer = null;
  #deadlineAt = null;
  #terminalCode = '';

  constructor(input) {
    const normalized = normalizeConfig(input);
    this.#config = normalized.publicConfig;
    this.#keys = normalized.keys;
  }

  get state() {
    return this.#state;
  }

  summary() {
    return deepFreeze({
      kind: PORTABLE_PAIRED_PREPARED_BARRIER_KIND,
      schemaVersion: PORTABLE_PAIRED_PREPARED_BARRIER_SCHEMA_VERSION,
      state: this.#state,
      timeoutMs: this.#config.timeoutMs,
      deadlineAt: this.#deadlineAt,
      paritySha256: this.#config.paritySha256,
      coverageSha256: this.#config.coverageSha256,
      fixturePlanSha256: this.#config.parity.fixturePlanSha256,
      roles: {
        baseline: preparedSummary(this.#prepared.get('baseline')),
        candidate: preparedSummary(this.#prepared.get('candidate')),
      },
      terminalCode: this.#terminalCode,
    });
  }

  toJSON() {
    return this.summary();
  }

  prepare(input) {
    if (TERMINAL_STATES.has(this.#state)) {
      return Promise.reject(new PortablePairedBarrierError(
        'portable_paired_barrier_late_arrival',
        { state: this.#state },
      ));
    }
    let prepared;
    try {
      prepared = normalizePrepared(input, this.#config.fixture);
    } catch (error) {
      const safeError = error instanceof PortablePairedBarrierError
        ? error
        : new PortablePairedBarrierError('portable_paired_barrier_prepared_invalid');
      this.#terminate('failed', safeError);
      return Promise.reject(safeError);
    }
    if (this.#prepared.has(prepared.role)) {
      const error = new PortablePairedBarrierError(
        'portable_paired_barrier_duplicate_role',
        { role: prepared.role },
      );
      this.#terminate('failed', error);
      return Promise.reject(error);
    }
    this.#prepared.set(prepared.role, prepared);
    if (this.#state === 'open') {
      this.#state = 'waiting';
      this.#deadlineAt = new Date(Date.now() + this.#config.timeoutMs).toISOString();
      this.#timer = setTimeout(() => {
        this.#terminate(
          'timed_out',
          new PortablePairedBarrierError('portable_paired_barrier_timeout'),
        );
      }, this.#config.timeoutMs);
    }
    const promise = new Promise((resolve, reject) => {
      this.#waiters.set(prepared.role, { resolve, reject });
    });
    if (this.#prepared.size === ROLES.length) this.#release();
    return promise;
  }

  cancel() {
    if (TERMINAL_STATES.has(this.#state)) return false;
    this.#terminate(
      'cancelled',
      new PortablePairedBarrierError('portable_paired_barrier_cancelled'),
    );
    return true;
  }

  kitFor(roleInput) {
    const role = normalizeRole(roleInput);
    if (this.#state !== 'released' || !this.#kits) {
      fail('portable_paired_barrier_kit_not_ready', { state: this.#state, role });
    }
    return this.#kits[role];
  }

  #release() {
    try {
      const baseline = this.#prepared.get('baseline');
      const candidate = this.#prepared.get('candidate');
      assertPairIdentity(baseline, candidate);
      const projections = {
        baseline: projectSignedPortableTaskRegressionBuildIdentity(
          baseline.taskRegressionBuildIdentity,
          {
            role: 'baseline',
            hmacKey: this.#keys.baseline,
            expectedTaskRegressionBuildIdentityDigest: baseline.taskRegressionBuildIdentityDigest,
          },
        ),
        candidate: projectSignedPortableTaskRegressionBuildIdentity(
          candidate.taskRegressionBuildIdentity,
          {
            role: 'candidate',
            hmacKey: this.#keys.candidate,
            expectedTaskRegressionBuildIdentityDigest: candidate.taskRegressionBuildIdentityDigest,
          },
        ),
      };
      const bindings = {
        baseline: roleBindings(baseline),
        candidate: roleBindings(candidate),
      };
      const plan = createPortablePairedManifestCores({
        parity: this.#config.parity,
        baseline: {
          runId: baseline.runId,
          buildIdentityDigest: projections.baseline.portableBuildIdentity.buildIdentityDigest,
          dataRootIdentitySha256: baseline.dataRootIdentitySha256,
          hmacKeyId: this.#config.hmacKeyIds.baseline,
        },
        candidate: {
          runId: candidate.runId,
          buildIdentityDigest: projections.candidate.portableBuildIdentity.buildIdentityDigest,
          dataRootIdentitySha256: candidate.dataRootIdentitySha256,
          hmacKeyId: this.#config.hmacKeyIds.candidate,
        },
        phases: this.#config.fixture.phases.map((fixturePhase, index) => ({
          ...fixturePhase,
          baseline: bindings.baseline[index],
          candidate: bindings.candidate[index],
        })),
      });
      if (plan.coverageSha256 !== this.#config.coverageSha256
        || plan.paritySha256 !== this.#config.paritySha256) {
        fail('portable_paired_barrier_plan_projection_mismatch');
      }
      const hooks = createPortablePairedRunnerHooks(plan);
      const manifests = {
        baseline: plan.baselineManifest,
        candidate: plan.candidateManifest,
      };
      const signedManifests = {
        baseline: createSignedPortableManifest(manifests.baseline, this.#keys.baseline),
        candidate: createSignedPortableManifest(manifests.candidate, this.#keys.candidate),
      };
      const collectors = {
        baseline: new PortableExternalEvidenceCollector({
          manifest: manifests.baseline,
          hmacKey: this.#keys.baseline,
        }),
        candidate: new PortableExternalEvidenceCollector({
          manifest: manifests.candidate,
          hmacKey: this.#keys.candidate,
        }),
      };
      this.#kits = Object.freeze({
        baseline: createMemoryKit('baseline', {
          prepared: baseline,
          projection: projections.baseline,
          manifest: manifests.baseline,
          signedManifest: signedManifests.baseline,
          plan,
          hooks,
          collector: collectors.baseline,
        }),
        candidate: createMemoryKit('candidate', {
          prepared: candidate,
          projection: projections.candidate,
          manifest: manifests.candidate,
          signedManifest: signedManifests.candidate,
          plan,
          hooks,
          collector: collectors.candidate,
        }),
      });
      this.#clearTimer();
      this.#state = 'released';
      this.#terminalCode = '';
      for (const role of ROLES) this.#waiters.get(role)?.resolve(this.#kits[role]);
      this.#waiters.clear();
    } catch (error) {
      const safeError = error instanceof PortablePairedBarrierError
        ? error
        : new PortablePairedBarrierError('portable_paired_barrier_finalization_failed', {
            stageCode: typeof error?.code === 'string' ? error.code : 'unknown',
          });
      this.#terminate('failed', safeError);
    }
  }

  #clearTimer() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #terminate(state, error) {
    if (TERMINAL_STATES.has(this.#state)) return;
    this.#clearTimer();
    this.#state = state;
    this.#terminalCode = error.code;
    for (const waiter of this.#waiters.values()) waiter.reject(error);
    this.#waiters.clear();
  }
}

export function createPortablePairedPreparedBarrier(input) {
  return new PortablePairedPreparedBarrier(input);
}
