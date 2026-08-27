import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION = 1;
export const PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND = 'lumi.portable-external-evidence-manifest';
export const PORTABLE_PROVIDER_CAPTURE_KIND = 'lumi.portable-provider-capture';
export const PORTABLE_STORE_SNAPSHOT_KIND = 'lumi.portable-passive-store-snapshot';
export const PORTABLE_EVIDENCE_BUNDLE_KIND = 'lumi.portable-external-evidence-bundle';
export const PORTABLE_EVIDENCE_ATTESTATION_ALGORITHM = 'hmac-sha256';
export const PORTABLE_SERVER_TRUTH_SIGNER_KIND =
  'lumi.voice-text-continuation-truth-signer';
export const PORTABLE_SERVER_TRUTH_SIGNER_SCHEMA_VERSION = 1;

/**
 * Build the immutable production denylist from this OS account instead of
 * publishing one developer's profile path.  The optional arguments exist only
 * to make the pure resolver testable; production checks always use the frozen
 * module-level value below and callers cannot replace it.
 */
export function buildRequiredFormalDataRootDenylist(
  homeDirectory = os.homedir(),
  explicitDataRoot = process.env.LUMI_DATA_DIR,
) {
  const home = String(homeDirectory || '').trim();
  if (!home || !path.isAbsolute(home)) {
    throw new Error('portable_evidence_home_directory_invalid');
  }
  const roots = [
    path.resolve(home, 'LumiOS'),
    // LumiCore is the renamed product root. Keeping both names denied prevents
    // a portable baseline probe from becoming a back door into either formal
    // profile while the migration is in progress.
    path.resolve(home, 'LumiCore'),
  ];
  const configured = String(explicitDataRoot || '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('portable_evidence_explicit_data_root_invalid');
    }
    roots.push(path.resolve(configured));
  }
  const key = value => process.platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
  return [...new Map(roots.map(root => [key(root), root])).values()];
}

export const REQUIRED_FORMAL_DATA_ROOT_DENYLIST = Object.freeze(
  buildRequiredFormalDataRootDenylist(),
);

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SAFE_NONCE_RE = /^[A-Za-z0-9_-]{16,192}$/u;
const BUNDLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const PORTABLE_PROVIDER_MARKER_PREFIX = '[[LUMI_PORTABLE_EVIDENCE_V1:';
const MINIMUM_HMAC_KEY_BYTES = 32;
const PORTABLE_SERVER_TRUTH_KEY_ID_DOMAIN =
  'lumi-voice-text-continuation-truth-ed25519-key-v1\0';

export class PortableExternalEvidenceError extends Error {
  constructor(code, details, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'PortableExternalEvidenceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details, cause) {
  throw new PortableExternalEvidenceError(code, details, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, code, pattern = SAFE_ID_RE) {
  const result = String(value || '').trim();
  if (!result || (pattern && !pattern.test(result))) fail(code);
  return result;
}

function optionalText(value, code, pattern = SAFE_ID_RE) {
  const result = String(value || '').trim();
  if (!result) return '';
  if (pattern && !pattern.test(result)) fail(code);
  return result;
}

function exactSha256(value, code) {
  const result = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(result)) fail(code);
  return result;
}

function normalizeIsoTimestamp(value, code) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(code);
  return date.toISOString();
}

function boundedInteger(value, code, minimum, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(code);
  return result;
}

function normalizeTimeoutPolicy(value) {
  if (!isPlainObject(value)) fail('portable_evidence_timeout_policy_required');
  return {
    turnMs: boundedInteger(value.turnMs, 'portable_evidence_turn_timeout_invalid', 100, 600_000),
    providerMs: boundedInteger(
      value.providerMs,
      'portable_evidence_provider_timeout_invalid',
      100,
      600_000,
    ),
    passiveStoreMs: boundedInteger(
      value.passiveStoreMs,
      'portable_evidence_store_timeout_invalid',
      100,
      600_000,
    ),
    settleMs: boundedInteger(value.settleMs, 'portable_evidence_settle_timeout_invalid', 0, 60_000),
  };
}

/**
 * A deliberately small JSON canonicalizer used by both revisions. It accepts
 * JSON values only, rejects lossy values, sorts object keys and never consults
 * product code.
 */
export function stablePortableEvidenceValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('portable_evidence_non_finite_number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return normalizeIsoTimestamp(value, 'portable_evidence_invalid_date');
  if (Buffer.isBuffer(value)) {
    return {
      byteLength: value.length,
      sha256: crypto.createHash('sha256').update(value).digest('hex'),
      type: 'BufferDigest',
    };
  }
  if (typeof value !== 'object' || value === undefined) {
    fail('portable_evidence_non_json_value');
  }
  if (seen.has(value)) fail('portable_evidence_cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => stablePortableEvidenceValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) fail('portable_evidence_non_plain_object');
  const result = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    if (value[key] === undefined) fail('portable_evidence_undefined_property', { key });
    result[key] = stablePortableEvidenceValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function stablePortableEvidenceJson(value) {
  return JSON.stringify(stablePortableEvidenceValue(value));
}

export function portableEvidenceSha256(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : stablePortableEvidenceJson(value), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function portableServerTruthSignerKeyId(publicKeySpkiBase64) {
  const encoded = String(publicKeySpkiBase64 || '');
  let der;
  try {
    der = Buffer.from(encoded, 'base64');
  } catch (cause) {
    fail('portable_evidence_server_truth_signer_key_invalid', undefined, cause);
  }
  if (!der.length || der.toString('base64') !== encoded) {
    fail('portable_evidence_server_truth_signer_key_invalid');
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    fail('portable_evidence_server_truth_signer_key_invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || !publicKey.export({ format: 'der', type: 'spki' }).equals(der)) {
    fail('portable_evidence_server_truth_signer_key_invalid');
  }
  return crypto.createHash('sha256')
    .update(PORTABLE_SERVER_TRUTH_KEY_ID_DOMAIN, 'utf8')
    .update(der)
    .digest('hex');
}

export function normalizePortableServerTruthSigner(input) {
  if (!isPlainObject(input)) fail('portable_evidence_server_truth_signer_invalid');
  const expectedKeys = [
    'kind', 'schemaVersion', 'algorithm', 'keyId', 'publicKeySpkiBase64',
    'serverInstanceNonce', 'acceptanceRunId', 'buildIdentityDigest',
    'dataRootIdentitySha256',
  ].sort();
  const actualKeys = Object.keys(input).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('portable_evidence_server_truth_signer_invalid');
  }
  const publicKeySpkiBase64 = String(input.publicKeySpkiBase64 || '');
  const keyId = portableServerTruthSignerKeyId(publicKeySpkiBase64);
  const descriptor = {
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    algorithm: input.algorithm,
    keyId: exactSha256(input.keyId, 'portable_evidence_server_truth_signer_key_id_invalid'),
    publicKeySpkiBase64,
    serverInstanceNonce: requiredText(
      input.serverInstanceNonce,
      'portable_evidence_server_truth_signer_nonce_invalid',
      SAFE_NONCE_RE,
    ),
    acceptanceRunId: requiredText(
      input.acceptanceRunId,
      'portable_evidence_server_truth_signer_run_invalid',
    ),
    buildIdentityDigest: exactSha256(
      input.buildIdentityDigest,
      'portable_evidence_server_truth_signer_build_invalid',
    ),
    dataRootIdentitySha256: exactSha256(
      input.dataRootIdentitySha256,
      'portable_evidence_server_truth_signer_data_root_invalid',
    ),
  };
  if (descriptor.kind !== PORTABLE_SERVER_TRUTH_SIGNER_KIND
    || descriptor.schemaVersion !== PORTABLE_SERVER_TRUTH_SIGNER_SCHEMA_VERSION
    || descriptor.algorithm !== 'ed25519'
    || descriptor.keyId !== keyId) {
    fail('portable_evidence_server_truth_signer_invalid');
  }
  return Object.freeze(descriptor);
}

function normalizeHmacKey(key) {
  const bytes = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key || ''), 'utf8');
  if (bytes.length < MINIMUM_HMAC_KEY_BYTES) fail('portable_evidence_hmac_key_too_short');
  return bytes;
}

export function portableEvidenceHmacKeyId(key) {
  const bytes = normalizeHmacKey(key);
  return crypto.createHash('sha256')
    .update('lumi-portable-evidence-key-v1\0', 'utf8')
    .update(bytes)
    .digest('hex');
}

function unsignedEvidenceRecord(record) {
  if (!isPlainObject(record)) fail('portable_evidence_record_required');
  const result = { ...record };
  delete result.attestation;
  return result;
}

export function signPortableEvidenceRecord(record, key) {
  const bytes = normalizeHmacKey(key);
  const unsigned = unsignedEvidenceRecord(record);
  const keyId = portableEvidenceHmacKeyId(bytes);
  const digest = crypto.createHmac('sha256', bytes)
    .update(stablePortableEvidenceJson(unsigned), 'utf8')
    .digest('hex');
  return {
    ...stablePortableEvidenceValue(unsigned),
    attestation: {
      algorithm: PORTABLE_EVIDENCE_ATTESTATION_ALGORITHM,
      digest,
      keyId,
    },
  };
}

export function verifyPortableEvidenceRecord(record, key) {
  try {
    const bytes = normalizeHmacKey(key);
    if (!isPlainObject(record?.attestation)) return false;
    if (record.attestation.algorithm !== PORTABLE_EVIDENCE_ATTESTATION_ALGORITHM) return false;
    if (record.attestation.keyId !== portableEvidenceHmacKeyId(bytes)) return false;
    if (!SHA256_RE.test(String(record.attestation.digest || ''))) return false;
    const expected = crypto.createHmac('sha256', bytes)
      .update(stablePortableEvidenceJson(unsignedEvidenceRecord(record)), 'utf8')
      .digest();
    const actual = Buffer.from(record.attestation.digest, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function normalizeWindowsPathForComparison(value) {
  const text = String(value || '').trim().replaceAll('/', '\\');
  if (!text) return '';
  return path.win32.resolve(text).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US');
}

function windowsPathInside(basePath, candidatePath) {
  const base = normalizeWindowsPathForComparison(basePath);
  const candidate = normalizeWindowsPathForComparison(candidatePath);
  return candidate === base || candidate.startsWith(`${base}\\`);
}

function assertNotForbiddenFormalRoot(candidatePath) {
  for (const forbidden of REQUIRED_FORMAL_DATA_ROOT_DENYLIST) {
    if (windowsPathInside(forbidden, candidatePath)) {
      fail('portable_evidence_formal_data_root_forbidden', {
        forbiddenRoot: forbidden,
      });
    }
  }
}

/**
 * Resolve a data root without importing product configuration. The explicit
 * formal-root check happens before any lstat/read so even a denied missing
 * descendant is rejected without touching the product profile.
 */
export function assertPortableEvidenceDataRoot(value, options = {}) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) fail('portable_evidence_absolute_data_root_required');
  assertNotForbiddenFormalRoot(text);
  const resolved = path.resolve(text);
  assertNotForbiddenFormalRoot(resolved);
  if (options.mustExist === false) return resolved;

  let metadata;
  try {
    metadata = fs.lstatSync(resolved);
  } catch (error) {
    fail('portable_evidence_data_root_missing', undefined, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('portable_evidence_data_root_not_real_directory');
  }
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (error) {
    fail('portable_evidence_data_root_realpath_failed', undefined, error);
  }
  assertNotForbiddenFormalRoot(canonical);
  return canonical;
}

export function portableEvidenceDataRootIdentity(value, options = {}) {
  const canonical = assertPortableEvidenceDataRoot(value, options);
  const normalized = process.platform === 'win32'
    ? canonical.toLocaleLowerCase('en-US')
    : canonical;
  return {
    canonical,
    sha256: crypto.createHash('sha256')
      .update('lumi-portable-evidence-data-root-v1\0', 'utf8')
      .update(normalized, 'utf8')
      .digest('hex'),
  };
}

function normalizePhaseBase(input) {
  if (!isPlainObject(input)) fail('portable_evidence_phase_required');
  return {
    scenarioId: requiredText(input.scenarioId, 'portable_evidence_scenario_id_invalid'),
    phaseId: requiredText(input.phaseId, 'portable_evidence_phase_id_invalid'),
    requestId: requiredText(input.requestId, 'portable_evidence_request_id_invalid'),
    phaseNonce: requiredText(input.phaseNonce, 'portable_evidence_phase_nonce_invalid', SAFE_NONCE_RE),
    conversationId: requiredText(input.conversationId, 'portable_evidence_conversation_id_invalid'),
    userId: requiredText(input.userId, 'portable_evidence_user_id_invalid'),
    channelId: optionalText(input.channelId, 'portable_evidence_channel_id_invalid')
      || requiredText(input.conversationId, 'portable_evidence_conversation_id_invalid'),
    expectedToolName: optionalText(input.expectedToolName, 'portable_evidence_tool_name_invalid'),
    requirements: {
      passiveStore: input.requirements?.passiveStore !== false,
      providerWitness: input.requirements?.providerWitness !== false,
    },
  };
}

export function portablePhaseBindingDigest(manifestIdentity, phase) {
  const serverTruthSigner = manifestIdentity.serverTruthSigner === undefined
    ? null
    : normalizePortableServerTruthSigner(manifestIdentity.serverTruthSigner);
  const binding = {
    runId: requiredText(manifestIdentity.runId, 'portable_evidence_run_id_invalid'),
    role: requiredText(manifestIdentity.role, 'portable_evidence_role_invalid'),
    buildIdentityDigest: exactSha256(
      manifestIdentity.buildIdentityDigest,
      'portable_evidence_build_digest_invalid',
    ),
    profileSha256: exactSha256(manifestIdentity.profileSha256, 'portable_evidence_profile_digest_invalid'),
    collectorBundleSha256: exactSha256(
      manifestIdentity.collectorBundleSha256,
      'portable_evidence_collector_bundle_digest_invalid',
    ),
    fixturePlanSha256: exactSha256(
      manifestIdentity.fixturePlanSha256,
      'portable_evidence_fixture_plan_digest_invalid',
    ),
    timeoutPolicy: normalizeTimeoutPolicy(manifestIdentity.timeoutPolicy),
    platform: requiredText(manifestIdentity.platform, 'portable_evidence_platform_invalid'),
    nodeMajor: boundedInteger(
      manifestIdentity.nodeMajor,
      'portable_evidence_node_major_invalid',
      18,
      99,
    ),
    ...(serverTruthSigner ? {
      serverTruthSignerKeyId: serverTruthSigner.keyId,
      serverInstanceNonce: serverTruthSigner.serverInstanceNonce,
    } : {}),
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
    conversationId: phase.conversationId,
    userId: phase.userId,
  };
  return portableEvidenceSha256({ kind: 'lumi.portable-phase-binding', schemaVersion: 1, ...binding });
}

export function portableProviderMarker(bindingDigest, phaseNonce) {
  const digest = exactSha256(bindingDigest, 'portable_evidence_binding_digest_invalid');
  const nonce = requiredText(phaseNonce, 'portable_evidence_phase_nonce_invalid', SAFE_NONCE_RE);
  return `[[LUMI_PORTABLE_EVIDENCE_V1:${digest}:${nonce}]]`;
}

export function portablePhaseNonceRequestTag(phaseNonce) {
  const nonce = requiredText(phaseNonce, 'portable_evidence_phase_nonce_invalid', SAFE_NONCE_RE);
  return crypto.createHash('sha256')
    .update('lumi-portable-phase-request-v1\0', 'utf8')
    .update(nonce, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

export function normalizePortableEvidenceManifest(input) {
  if (!isPlainObject(input)) fail('portable_evidence_manifest_required');
  if (input.kind !== PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND) {
    fail('portable_evidence_manifest_kind_invalid');
  }
  if (input.schemaVersion !== PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION) {
    fail('portable_evidence_manifest_schema_invalid');
  }
  const identityWithoutSigner = {
    kind: PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
    schemaVersion: PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
    runId: requiredText(input.runId, 'portable_evidence_run_id_invalid'),
    role: requiredText(input.role, 'portable_evidence_role_invalid'),
    buildIdentityDigest: exactSha256(input.buildIdentityDigest, 'portable_evidence_build_digest_invalid'),
    profileSha256: exactSha256(input.profileSha256, 'portable_evidence_profile_digest_invalid'),
    collectorBundleSha256: exactSha256(
      input.collectorBundleSha256,
      'portable_evidence_collector_bundle_digest_invalid',
    ),
    fixturePlanSha256: exactSha256(
      input.fixturePlanSha256,
      'portable_evidence_fixture_plan_digest_invalid',
    ),
    timeoutPolicy: normalizeTimeoutPolicy(input.timeoutPolicy),
    platform: requiredText(input.platform, 'portable_evidence_platform_invalid'),
    nodeMajor: boundedInteger(input.nodeMajor, 'portable_evidence_node_major_invalid', 18, 99),
    dataRootIdentitySha256: exactSha256(
      input.dataRootIdentitySha256,
      'portable_evidence_data_root_digest_invalid',
    ),
    hmacKeyId: optionalText(input.hmacKeyId, 'portable_evidence_hmac_key_id_invalid', SHA256_RE),
  };
  const serverTruthSigner = input.serverTruthSigner === undefined
    ? null
    : normalizePortableServerTruthSigner(input.serverTruthSigner);
  if (serverTruthSigner && (
    serverTruthSigner.acceptanceRunId !== identityWithoutSigner.runId
    || serverTruthSigner.buildIdentityDigest !== identityWithoutSigner.buildIdentityDigest
    || serverTruthSigner.dataRootIdentitySha256 !== identityWithoutSigner.dataRootIdentitySha256
  )) fail('portable_evidence_server_truth_signer_manifest_binding_invalid');
  const identity = {
    ...identityWithoutSigner,
    ...(serverTruthSigner ? { serverTruthSigner } : {}),
  };
  if (!['baseline', 'candidate'].includes(identity.role)) fail('portable_evidence_role_invalid');
  if (!['win32', 'darwin', 'linux'].includes(identity.platform)) {
    fail('portable_evidence_platform_invalid');
  }
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    fail('portable_evidence_manifest_phases_required');
  }
  const seenPhaseKeys = new Set();
  const seenRequestIds = new Set();
  const seenNonces = new Set();
  const phases = input.phases.map(item => {
    const base = normalizePhaseBase(item);
    const phaseKey = `${base.scenarioId}\0${base.phaseId}`;
    if (seenPhaseKeys.has(phaseKey)) fail('portable_evidence_duplicate_phase', { phaseKey });
    if (seenRequestIds.has(base.requestId)) {
      fail('portable_evidence_duplicate_request_id', { requestId: base.requestId });
    }
    if (seenNonces.has(base.phaseNonce)) {
      fail('portable_evidence_duplicate_phase_nonce', { phaseNonce: base.phaseNonce });
    }
    seenPhaseKeys.add(phaseKey);
    seenRequestIds.add(base.requestId);
    seenNonces.add(base.phaseNonce);
    const bindingDigest = portablePhaseBindingDigest(identity, base);
    return {
      ...base,
      bindingDigest,
      providerMarker: portableProviderMarker(bindingDigest, base.phaseNonce),
    };
  });
  const manifestCore = {
    ...identity,
    phases: phases.map(({ bindingDigest: _bindingDigest, providerMarker: _providerMarker, ...phase }) => phase),
  };
  const manifestDigest = portableEvidenceSha256(manifestCore);
  if (input.manifestDigest && String(input.manifestDigest).toLowerCase() !== manifestDigest) {
    fail('portable_evidence_manifest_digest_mismatch');
  }
  return Object.freeze({
    ...manifestCore,
    manifestDigest,
    phases: Object.freeze(phases.map(phase => Object.freeze(phase))),
  });
}

export function phaseBindingFromManifest(manifestInput, selector) {
  const manifest = normalizePortableEvidenceManifest(manifestInput);
  if (!isPlainObject(selector)) fail('portable_evidence_phase_selector_required');
  const scenarioId = requiredText(selector.scenarioId, 'portable_evidence_scenario_id_invalid');
  const phaseId = requiredText(selector.phaseId, 'portable_evidence_phase_id_invalid');
  const requestId = requiredText(selector.requestId, 'portable_evidence_request_id_invalid');
  const phaseNonce = requiredText(
    selector.phaseNonce,
    'portable_evidence_phase_nonce_invalid',
    SAFE_NONCE_RE,
  );
  const phase = manifest.phases.find(item => (
    item.scenarioId === scenarioId
    && item.phaseId === phaseId
    && item.requestId === requestId
    && item.phaseNonce === phaseNonce
  ));
  if (!phase) fail('portable_evidence_phase_binding_not_found');
  return {
    manifest,
    phase,
    binding: {
      runId: manifest.runId,
      role: manifest.role,
      buildIdentityDigest: manifest.buildIdentityDigest,
      profileSha256: manifest.profileSha256,
      collectorBundleSha256: manifest.collectorBundleSha256,
      fixturePlanSha256: manifest.fixturePlanSha256,
      timeoutPolicy: manifest.timeoutPolicy,
      platform: manifest.platform,
      nodeMajor: manifest.nodeMajor,
      ...(manifest.serverTruthSigner ? {
        serverTruthSignerKeyId: manifest.serverTruthSigner.keyId,
        serverInstanceNonce: manifest.serverTruthSigner.serverInstanceNonce,
      } : {}),
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: phase.requestId,
      phaseNonce: phase.phaseNonce,
      conversationId: phase.conversationId,
      userId: phase.userId,
      bindingDigest: phase.bindingDigest,
    },
  };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function normalizeProviderPayload(rawPayload) {
  let bytes;
  let parsed;
  if (Buffer.isBuffer(rawPayload)) {
    bytes = Buffer.from(rawPayload);
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
      // JSON parser messages can quote raw request fragments. Provider payloads
      // may contain prompts or credentials, so this boundary deliberately
      // exposes only the stable protocol error code and never chains the cause.
      fail('portable_evidence_provider_payload_invalid_json');
    }
  } else if (typeof rawPayload === 'string') {
    bytes = Buffer.from(rawPayload, 'utf8');
    try { parsed = JSON.parse(rawPayload); } catch {
      fail('portable_evidence_provider_payload_invalid_json');
    }
  } else if (isPlainObject(rawPayload)) {
    parsed = rawPayload;
    bytes = Buffer.from(stablePortableEvidenceJson(rawPayload), 'utf8');
  } else {
    fail('portable_evidence_provider_payload_required');
  }
  if (!isPlainObject(parsed)) fail('portable_evidence_provider_payload_object_required');
  return { bytes, parsed };
}

function providerMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return stablePortableEvidenceJson(content);
}

function providerToolNames(payload) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  return [...new Set(tools.map(tool => String(tool?.function?.name || tool?.name || '').trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function phaseSelectorFromPhase(phase) {
  return {
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  };
}

export class PortableExternalEvidenceCollector {
  constructor(options) {
    if (!isPlainObject(options)) fail('portable_evidence_collector_options_required');
    this.manifest = normalizePortableEvidenceManifest(options.manifest);
    this.hmacKey = normalizeHmacKey(options.hmacKey);
    const actualKeyId = portableEvidenceHmacKeyId(this.hmacKey);
    if (this.manifest.hmacKeyId && this.manifest.hmacKeyId !== actualKeyId) {
      fail('portable_evidence_manifest_hmac_key_mismatch');
    }
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.nonceFactory = typeof options.nonceFactory === 'function'
      ? options.nonceFactory
      : () => crypto.randomBytes(24).toString('base64url');
    this.providerCaptures = new Map();
    this.storeSnapshots = new Map();
    this.captureOrdinal = 0;
  }

  captureProviderRequest(selector, rawPayload, options = {}) {
    const { phase, binding } = phaseBindingFromManifest(this.manifest, selector);
    const { bytes, parsed } = normalizeProviderPayload(rawPayload);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    if (messages.length === 0) fail('portable_evidence_provider_messages_required');
    const messagesJson = stablePortableEvidenceJson(messages);
    const payloadJson = stablePortableEvidenceJson(parsed);
    const currentMarkerCount = countOccurrences(payloadJson, phase.providerMarker);
    if (currentMarkerCount === 0) fail('portable_evidence_provider_phase_marker_missing');
    if (currentMarkerCount !== 1) {
      fail('portable_evidence_provider_phase_marker_ambiguous', { currentMarkerCount });
    }
    const portableMarkerCount = countOccurrences(payloadJson, PORTABLE_PROVIDER_MARKER_PREFIX);
    if (portableMarkerCount !== 1) {
      fail('portable_evidence_provider_marker_cardinality_invalid', { portableMarkerCount });
    }
    const observedBindings = this.manifest.phases
      .filter(item => countOccurrences(payloadJson, item.providerMarker) > 0)
      .map(item => item.bindingDigest)
      .sort((left, right) => left.localeCompare(right));
    if (stablePortableEvidenceJson(observedBindings)
      !== stablePortableEvidenceJson([phase.bindingDigest])) {
      fail('portable_evidence_provider_phase_marker_cross_binding');
    }
    const userMessageIndexes = messages
      .map((message, index) => String(message?.role || '') === 'user' ? index : -1)
      .filter(index => index >= 0);
    if (userMessageIndexes.length === 0) {
      fail('portable_evidence_provider_latest_user_message_missing');
    }
    const latestUserMessageIndex = userMessageIndexes.at(-1);
    const matchedUserMessages = messages.map((message, index) => ({
      index,
      role: String(message?.role || ''),
      markerCount: countOccurrences(
        providerMessageContentText(message?.content),
        phase.providerMarker,
      ),
    })).filter(item => item.markerCount > 0);
    if (matchedUserMessages.length !== 1
      || matchedUserMessages[0].role !== 'user'
      || matchedUserMessages[0].markerCount !== 1
      || matchedUserMessages[0].index !== latestUserMessageIndex) {
      fail('portable_evidence_provider_phase_marker_not_latest_user_message');
    }
    const matchedUserMessageIndex = matchedUserMessages[0].index;
    const providerRequestNonce = requiredText(
      options.providerRequestNonce || this.nonceFactory(),
      'portable_evidence_provider_request_nonce_invalid',
      SAFE_NONCE_RE,
    );
    if (this.providerCaptures.has(providerRequestNonce)) {
      fail('portable_evidence_duplicate_provider_request_nonce', { providerRequestNonce });
    }
    this.captureOrdinal += 1;
    const record = signPortableEvidenceRecord({
      kind: PORTABLE_PROVIDER_CAPTURE_KIND,
      schemaVersion: PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
      manifestDigest: this.manifest.manifestDigest,
      binding,
      providerRequestNonce,
      captureOrdinal: this.captureOrdinal,
      capturedAt: normalizeIsoTimestamp(this.now(), 'portable_evidence_capture_time_invalid'),
      captureOrigin: 'portable_external_provider_boundary',
      modelInvoked: true,
      bodyBytes: bytes.length,
      bodySha256: portableEvidenceSha256(bytes),
      model: String(parsed.model || ''),
      stream: parsed.stream === true,
      messageCount: messages.length,
      messagesSha256: portableEvidenceSha256(messages),
      matchedUserMessageIndex,
      latestUserMessageIndex,
      markerCardinality: {
        portablePayload: portableMarkerCount,
        selectedPhasePayload: currentMarkerCount,
        latestUserMessage: matchedUserMessages[0].markerCount,
      },
      providerMarkerSha256: portableEvidenceSha256(phase.providerMarker),
      phaseNonceSha256: portableEvidenceSha256(phase.phaseNonce),
      declaredTools: providerToolNames(parsed),
      observedPhaseBindingDigests: observedBindings,
    }, this.hmacKey);
    this.providerCaptures.set(providerRequestNonce, record);
    return record;
  }

  getProviderCapture(selector, providerRequestNonce) {
    const { phase } = phaseBindingFromManifest(this.manifest, selector);
    const nonce = requiredText(
      providerRequestNonce,
      'portable_evidence_provider_request_nonce_required',
      SAFE_NONCE_RE,
    );
    const record = this.providerCaptures.get(nonce);
    if (!record || record.binding.bindingDigest !== phase.bindingDigest) {
      fail('portable_evidence_provider_capture_not_found');
    }
    return record;
  }

  addStoreSnapshot(record) {
    if (record?.kind !== PORTABLE_STORE_SNAPSHOT_KIND
      || record?.manifestDigest !== this.manifest.manifestDigest) {
      fail('portable_evidence_store_snapshot_manifest_mismatch');
    }
    if (record?.source?.dataRootIdentitySha256 !== this.manifest.dataRootIdentitySha256) {
      fail('portable_evidence_store_snapshot_data_root_mismatch');
    }
    const validation = validatePortableEvidenceDocument(record, this.hmacKey, this.manifest);
    if (!validation.ok) {
      fail('portable_evidence_store_snapshot_attestation_invalid');
    }
    const phase = this.manifest.phases.find(item => item.bindingDigest === record.binding?.bindingDigest);
    if (!phase) fail('portable_evidence_store_snapshot_binding_unknown');
    if (this.storeSnapshots.has(phase.bindingDigest)) {
      fail('portable_evidence_duplicate_store_snapshot', { bindingDigest: phase.bindingDigest });
    }
    this.storeSnapshots.set(phase.bindingDigest, record);
    return record;
  }

  buildBundle() {
    const phaseEvidence = this.manifest.phases.map(phase => {
      const providerCaptures = [...this.providerCaptures.values()]
        .filter(record => record.binding.bindingDigest === phase.bindingDigest)
        .sort((left, right) => left.captureOrdinal - right.captureOrdinal);
      const storeSnapshot = this.storeSnapshots.get(phase.bindingDigest) || null;
      const issues = [];
      if (phase.requirements.providerWitness && providerCaptures.length === 0) {
        issues.push('provider_capture_missing');
      }
      if (phase.requirements.passiveStore && !storeSnapshot) issues.push('store_snapshot_missing');
      const acceptedUserRow = storeSnapshot?.observations?.acceptedUserRow;
      const expectedMarkerSha256 = portableEvidenceSha256(phase.providerMarker);
      const acceptedUserMarkerBound = acceptedUserRow?.state === 'present'
        && acceptedUserRow.providerMarkerCount === 1
        && acceptedUserRow.providerMarkerSha256 === expectedMarkerSha256;
      const providerMarkersBound = providerCaptures.length > 0 && providerCaptures.every(record => (
        record.providerMarkerSha256 === expectedMarkerSha256
        && record.phaseNonceSha256 === portableEvidenceSha256(phase.phaseNonce)
        && Array.isArray(record.observedPhaseBindingDigests)
        && stablePortableEvidenceJson(record.observedPhaseBindingDigests)
          === stablePortableEvidenceJson([phase.bindingDigest])
        && record.matchedUserMessageIndex === record.latestUserMessageIndex
        && record.markerCardinality?.portablePayload === 1
        && record.markerCardinality?.selectedPhasePayload === 1
        && record.markerCardinality?.latestUserMessage === 1
      ));
      const joinRequired = phase.requirements.passiveStore && phase.requirements.providerWitness;
      const joinComplete = joinRequired ? acceptedUserMarkerBound && providerMarkersBound : true;
      if (!joinComplete) issues.push('accepted_user_row_provider_witness_join_missing');
      return {
        bindingDigest: phase.bindingDigest,
        selector: phaseSelectorFromPhase(phase),
        providerCaptures,
        storeSnapshot,
        acceptedUserProviderJoin: {
          required: joinRequired,
          complete: joinComplete,
          bindingDigest: phase.bindingDigest,
          providerMarkerSha256: expectedMarkerSha256,
          providerRequestNonces: providerCaptures.map(record => record.providerRequestNonce),
        },
        complete: issues.length === 0,
        issues,
      };
    });
    return signPortableEvidenceRecord({
      kind: PORTABLE_EVIDENCE_BUNDLE_KIND,
      schemaVersion: PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
      manifestDigest: this.manifest.manifestDigest,
      runId: this.manifest.runId,
      role: this.manifest.role,
      buildIdentityDigest: this.manifest.buildIdentityDigest,
      profileSha256: this.manifest.profileSha256,
      collectorBundleSha256: this.manifest.collectorBundleSha256,
      fixturePlanSha256: this.manifest.fixturePlanSha256,
      dataRootIdentitySha256: this.manifest.dataRootIdentitySha256,
      timeoutPolicy: this.manifest.timeoutPolicy,
      platform: this.manifest.platform,
      nodeMajor: this.manifest.nodeMajor,
      createdAt: normalizeIsoTimestamp(this.now(), 'portable_evidence_bundle_time_invalid'),
      selectionPolicy: 'exact_phase_request_nonce_only_no_latest_wins',
      phaseEvidence,
      complete: phaseEvidence.every(item => item.complete),
    }, this.hmacKey);
  }
}

export function validatePortableEvidenceDocument(record, key, manifestInput) {
  const issues = [];
  if (!verifyPortableEvidenceRecord(record, key)) issues.push('attestation_invalid');
  let manifest;
  try {
    manifest = normalizePortableEvidenceManifest(manifestInput);
  } catch {
    issues.push('manifest_invalid');
  }
  if (manifest && record?.manifestDigest !== manifest.manifestDigest) {
    issues.push('manifest_digest_mismatch');
  }
  if (manifest && record?.kind === PORTABLE_STORE_SNAPSHOT_KIND
    && record?.source?.dataRootIdentitySha256 !== manifest.dataRootIdentitySha256) {
    issues.push('store_data_root_identity_mismatch');
  }
  if (manifest && record?.kind === PORTABLE_EVIDENCE_BUNDLE_KIND
    && record?.dataRootIdentitySha256 !== manifest.dataRootIdentitySha256) {
    issues.push('bundle_data_root_identity_mismatch');
  }
  if (manifest && record?.binding) {
    const phase = manifest.phases.find(item => item.bindingDigest === record.binding.bindingDigest);
    if (!phase) issues.push('binding_unknown');
    else {
      const expected = {
        runId: manifest.runId,
        role: manifest.role,
        buildIdentityDigest: manifest.buildIdentityDigest,
        profileSha256: manifest.profileSha256,
        collectorBundleSha256: manifest.collectorBundleSha256,
        fixturePlanSha256: manifest.fixturePlanSha256,
        timeoutPolicy: manifest.timeoutPolicy,
        platform: manifest.platform,
        nodeMajor: manifest.nodeMajor,
        scenarioId: phase.scenarioId,
        phaseId: phase.phaseId,
        requestId: phase.requestId,
        phaseNonce: phase.phaseNonce,
        conversationId: phase.conversationId,
        userId: phase.userId,
        bindingDigest: phase.bindingDigest,
      };
      if (stablePortableEvidenceJson(record.binding) !== stablePortableEvidenceJson(expected)) {
        issues.push('binding_fields_mismatch');
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === 1
    && right.nlink === 1;
}

function readStableSingleLinkFile(filename, options) {
  const absolute = path.resolve(String(filename || ''));
  let before;
  try { before = fs.lstatSync(absolute); } catch (error) {
    fail(options.missingCode, undefined, error);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < options.minimumBytes || before.size > options.maximumBytes) {
    fail(options.invalidCode);
  }
  const canonicalBefore = fs.realpathSync.native(absolute);
  let descriptor;
  try {
    descriptor = fs.openSync(canonicalBefore, 'r');
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) fail(options.changedCode);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(absolute);
    const canonicalAfter = fs.realpathSync.native(absolute);
    if (canonicalAfter !== canonicalBefore || !sameFileIdentity(opened, after)) {
      fail(options.changedCode);
    }
    return { absolute, canonical: canonicalBefore, bytes, metadata: opened };
  } catch (error) {
    if (error instanceof PortableExternalEvidenceError) throw error;
    fail(options.changedCode, undefined, error);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

export function computePortableCollectorBundleSha256(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('portable_evidence_collector_bundle_files_required');
  }
  const seen = new Set();
  const files = entries.map(entry => {
    if (!isPlainObject(entry)) fail('portable_evidence_collector_bundle_file_invalid');
    const name = requiredText(
      entry.name,
      'portable_evidence_collector_bundle_name_invalid',
      BUNDLE_NAME_RE,
    );
    if (seen.has(name)) fail('portable_evidence_collector_bundle_name_duplicate');
    seen.add(name);
    const source = readStableSingleLinkFile(entry.path, {
      missingCode: 'portable_evidence_collector_bundle_file_missing',
      invalidCode: 'portable_evidence_collector_bundle_file_invalid',
      changedCode: 'portable_evidence_collector_bundle_file_changed',
      minimumBytes: 1,
      maximumBytes: 4 * 1024 * 1024,
    });
    return { name, bytes: source.bytes.length, sha256: portableEvidenceSha256(source.bytes) };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return portableEvidenceSha256({
    kind: 'lumi.portable-collector-bundle',
    schemaVersion: 1,
    files,
  });
}

export function assertPortableEvidenceRuntime(manifestInput, expectedCollectorBundleSha256) {
  const manifest = normalizePortableEvidenceManifest(manifestInput);
  if (manifest.platform !== process.platform) fail('portable_evidence_runtime_platform_mismatch');
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '', 10);
  if (manifest.nodeMajor !== nodeMajor) fail('portable_evidence_runtime_node_major_mismatch');
  const collectorDigest = exactSha256(
    expectedCollectorBundleSha256,
    'portable_evidence_collector_bundle_digest_invalid',
  );
  if (manifest.collectorBundleSha256 !== collectorDigest) {
    fail('portable_evidence_runtime_collector_bundle_mismatch');
  }
  return manifest;
}

export function readPortableEvidenceKeyFile(filename) {
  const source = readStableSingleLinkFile(filename, {
    missingCode: 'portable_evidence_key_file_missing',
    invalidCode: 'portable_evidence_key_file_invalid',
    changedCode: 'portable_evidence_key_file_changed',
    minimumBytes: MINIMUM_HMAC_KEY_BYTES,
    maximumBytes: 4096,
  });
  return normalizeHmacKey(source.bytes);
}

export function readPortableEvidenceJsonFile(filename, maximumBytes = 2 * 1024 * 1024) {
  const source = readStableSingleLinkFile(filename, {
    missingCode: 'portable_evidence_json_file_missing',
    invalidCode: 'portable_evidence_json_file_invalid',
    changedCode: 'portable_evidence_json_file_changed',
    minimumBytes: 1,
    maximumBytes,
  });
  try { return JSON.parse(source.bytes.toString('utf8')); } catch (error) {
    fail('portable_evidence_json_file_parse_failed', undefined, error);
  }
}
