import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
  FORMAL_STAGE9_EVIDENCE_CATEGORIES,
  FORMAL_STAGE9_PRODUCERS,
  FORMAL_STAGE9_SCENARIO_OWNERS,
  FORMAL_STAGE9_SCENARIOS,
  formalStage9BindingDigest,
  formalStage9Digest,
  normalizeFormalStage9Binding,
  sealFormalStage9EvidenceBundle,
  sealFormalStage9ProducerEvidence,
  stableFormalStage9Json,
} from '../formal-stage9-adjudicator.mjs';
import { redactAcceptanceEvidence } from './formal-acceptance-evidence.mjs';

export const FORMAL_STAGE9_FILE_PRODUCER_PACKAGE_KIND =
  'lumi.formal-stage9-file-backed-producer-package';
export const FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND =
  'lumi.formal-stage9-producer-file-manifest';
export const FORMAL_STAGE9_UNADJUDICATED_BUNDLE_PACKAGE_KIND =
  'lumi.formal-stage9-unadjudicated-bundle-package';

const SHA256_RE = /^[a-f0-9]{64}$/iu;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const BINARY_EVIDENCE_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.doc', '.docx', '.gif', '.gz', '.jpeg', '.jpg', '.mov',
  '.mp3', '.mp4', '.pdf', '.png', '.ppt', '.pptx', '.wav', '.webp', '.xls', '.xlsx', '.zip',
]);

export class FormalStage9ProducerEvidenceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'FormalStage9ProducerEvidenceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new FormalStage9ProducerEvidenceError(code, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value) {
  return String(value ?? '').trim();
}

function requiredText(value, code) {
  const result = text(value);
  if (!result) fail(code);
  return result;
}

function normalizedIso(value, code) {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp)) fail(code);
  return new Date(timestamp).toISOString();
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function pathIdentity(value) {
  let normalized = path.resolve(value).replace(/^\\\\\?\\/u, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/u, '');
}

function pathInside(root, candidate, { allowEqual = false } = {}) {
  const relative = path.relative(root, candidate);
  if (!relative) return allowEqual;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoLinkedComponents(value, code) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  try {
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail(code);
    }
  } catch (error) {
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail(code, { cause: error?.message });
  }
}

function normalizeEvidenceRoot(value) {
  const requested = requiredText(value, 'formal_stage9_evidence_root_required');
  if (!path.isAbsolute(requested)) fail('formal_stage9_evidence_root_absolute_required');
  const resolved = path.resolve(requested);
  let metadata;
  let real;
  try {
    metadata = fs.lstatSync(resolved);
    real = fs.realpathSync.native(resolved);
  } catch (error) {
    fail('formal_stage9_evidence_root_invalid', { cause: error?.message });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('formal_stage9_evidence_root_invalid');
  }
  assertNoLinkedComponents(resolved, 'formal_stage9_evidence_root_link_forbidden');
  return real;
}

function ensureSafeDirectories(root, segments) {
  let cursor = root;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]{1,160}$/u.test(segment) || segment === '.' || segment === '..') {
      fail('formal_stage9_generated_directory_invalid');
    }
    const candidate = path.join(cursor, segment);
    if (!fs.existsSync(candidate)) {
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        fail('formal_stage9_evidence_directory_create_failed', { cause: error?.message });
      }
    }
    const metadata = fs.lstatSync(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail('formal_stage9_evidence_directory_link_forbidden');
    }
    const real = fs.realpathSync.native(candidate);
    if (!pathInside(root, real)) fail('formal_stage9_evidence_directory_outside_root');
    cursor = real;
  }
  return cursor;
}

function canonicalRelativePath(value) {
  const raw = requiredText(value, 'formal_stage9_relative_path_required');
  if (raw.includes('\\')
    || raw.includes('\0')
    || raw.includes(':')
    || raw.startsWith('/')
    || path.posix.isAbsolute(raw)
    || path.posix.normalize(raw) !== raw
    || raw.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    fail('formal_stage9_relative_path_invalid');
  }
  return raw;
}

function readStableSource(sourcePath) {
  const requested = requiredText(sourcePath, 'formal_stage9_source_file_required');
  if (!path.isAbsolute(requested)) fail('formal_stage9_source_file_absolute_required');
  const resolved = path.resolve(requested);
  let initialMetadata;
  try {
    initialMetadata = fs.lstatSync(resolved);
  } catch (error) {
    fail('formal_stage9_source_file_missing', { cause: error?.message });
  }
  if (!initialMetadata.isFile() || initialMetadata.isSymbolicLink()) {
    fail('formal_stage9_source_file_invalid');
  }
  assertNoLinkedComponents(resolved, 'formal_stage9_source_file_link_forbidden');
  let descriptor;
  try {
    descriptor = fs.openSync(fs.realpathSync.native(resolved), fs.constants.O_RDONLY);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_FILE_BYTES) {
      fail('formal_stage9_source_file_size_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail('formal_stage9_source_file_changed_during_read');
    }
    return { bytes, size: before.size, sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail('formal_stage9_source_file_invalid', { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function directoryIdentity(directory, code) {
  try {
    const metadata = fs.lstatSync(directory);
    const real = fs.realpathSync.native(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
    return { real: pathIdentity(real), dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (error instanceof FormalStage9ProducerEvidenceError) throw error;
    fail(code, { cause: error?.message });
  }
}

function assertSameDirectoryIdentity(directory, expected, code) {
  const actual = directoryIdentity(directory, code);
  if (actual.real !== expected.real
    || (expected.dev && actual.dev !== expected.dev)
    || (expected.ino && actual.ino !== expected.ino)) fail(code);
}

function fsyncDirectory(directory, code) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Windows does not consistently allow opening a directory handle through
    // Node. The evidence inode itself was already fsynced; POSIX must also
    // durably publish the directory entry.
    if (process.platform !== 'win32') fail(code, { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function writeImmutableBytes(destination, bytes, code) {
  const parent = path.dirname(destination);
  const parentIdentity = directoryIdentity(parent, `${code}_parent_invalid`);
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o400);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // A same-directory hard link publishes the fully flushed inode without
    // replacing a destination another producer created concurrently.
    fs.linkSync(temporary, destination);
    assertSameDirectoryIdentity(parent, parentIdentity, `${code}_parent_changed`);
    try { fs.chmodSync(destination, 0o400); } catch {}
    fsyncDirectory(parent, `${code}_parent_fsync_failed`);
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`${code}_exists`);
    fail(code, { cause: error?.message });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    // Never unlink destination here. Only the unpredictable temporary name is
    // owned by this invocation, so a failed publish cannot delete external data.
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function writeImmutableJson(destination, value, code) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  writeImmutableBytes(destination, bytes, code);
  return { size: bytes.length, sha256: sha256Bytes(bytes) };
}

function verifySourceSecurity(source, sourcePath, entry) {
  const extension = path.extname(sourcePath).toLowerCase();
  const decoded = source.bytes.toString('utf8');
  const binary = BINARY_EVIDENCE_EXTENSIONS.has(extension)
    || source.bytes.includes(0)
    || !Buffer.from(decoded, 'utf8').equals(source.bytes);
  if (binary) {
    if (entry.secretScanStatus !== 'manual_review_completed_binary'
      || entry.manualRedactionReviewCompleted !== true) {
      fail('formal_stage9_binary_source_redaction_review_required');
    }
    return {
      secretScanStatus: 'manual_review_completed_binary',
      manualRedactionReviewCompleted: true,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    };
  }
  if (redactAcceptanceEvidence(decoded) !== decoded) {
    fail('formal_stage9_source_contains_sensitive_text');
  }
  return {
    secretScanStatus: 'passed_text_scan',
    manualRedactionReviewCompleted: false,
    evidenceClassification: 'restricted_private_local',
    publishable: false,
  };
}

function sourceSecurityIsValid(value) {
  if (!isPlainObject(value)
    || value.evidenceClassification !== 'restricted_private_local'
    || value.publishable !== false) return false;
  return (value.secretScanStatus === 'passed_text_scan'
      && value.manualRedactionReviewCompleted === false)
    || (value.secretScanStatus === 'manual_review_completed_binary'
      && value.manualRedactionReviewCompleted === true);
}

function assertUnadjudicated(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('formal_stage9_producer_payload_circular');
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'acceptanceDecision' && item !== 'not_adjudicated') {
      fail('formal_stage9_producer_self_adjudication_forbidden');
    }
    if (key === 'acceptancePassed' && item !== false) {
      fail('formal_stage9_producer_self_adjudication_forbidden');
    }
    if (key === 'fullAcceptance' && item === true) {
      fail('formal_stage9_producer_self_adjudication_forbidden');
    }
    assertUnadjudicated(item, seen);
  }
  seen.delete(value);
}

function sanitizePayloadValue(value, key = '') {
  if (typeof value === 'string') {
    // Preserve an actually empty field so downstream presence checks cannot
    // mistake redaction for evidence. Non-empty path-labelled values and both
    // Windows/POSIX absolute paths are removed without leaving a reversible
    // dictionary-friendly path hash.
    if (path.win32.isAbsolute(value)
      || path.posix.isAbsolute(value)
      || (value.trim().length > 0 && /(?:path|directory|dir|root)$/iu.test(key))) {
      return '[REDACTED_PATH]';
    }
    if (/(?:public|private).*key|keypem/iu.test(key)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizePayloadValue(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, item]) => [
      childKey,
      sanitizePayloadValue(item, childKey),
    ]),
  );
}

function sanitizeProducerPayload(value) {
  return sanitizePayloadValue(redactAcceptanceEvidence(value));
}

function assertEntryBinding(entry, binding, bindingDigest) {
  if (Object.hasOwn(entry, 'acceptanceRunId')
    && text(entry.acceptanceRunId) !== binding.acceptanceRunId) {
    fail('formal_stage9_source_acceptance_run_mismatch');
  }
  if (Object.hasOwn(entry, 'bindingDigest')
    && text(entry.bindingDigest).toLowerCase() !== bindingDigest) {
    fail('formal_stage9_source_binding_mismatch');
  }
  if (Object.hasOwn(entry, 'buildId')
    && text(entry.buildId).toLowerCase() !== binding.buildId) {
    fail('formal_stage9_source_build_mismatch');
  }
  if (Object.hasOwn(entry, 'sourceFingerprint')
    && text(entry.sourceFingerprint).toLowerCase() !== binding.sourceFingerprint) {
    fail('formal_stage9_source_fingerprint_mismatch');
  }
}

function categoryFields(category, entry, binding) {
  if (category === 'screenshots') {
    const result = {
      trustedNativeCapture: entry.trustedNativeCapture === true,
      manualReviewCompleted: entry.manualReviewCompleted === true,
      nativeDeviceId: requiredText(entry.nativeDeviceId, 'formal_stage9_native_device_id_required'),
      executionSessionId: requiredText(
        entry.executionSessionId,
        'formal_stage9_execution_session_id_required',
      ),
      windowId: requiredText(entry.windowId, 'formal_stage9_window_id_required'),
    };
    if (!result.trustedNativeCapture || !result.manualReviewCompleted
      || result.nativeDeviceId !== binding.nativeClient.deviceId
      || result.executionSessionId !== binding.nativeClient.executionSessionId) {
      fail('formal_stage9_native_screenshot_binding_invalid');
    }
    return result;
  }
  if (category === 'taskReceipts') {
    const verification = requiredText(entry.verification, 'formal_stage9_receipt_verification_required');
    if (!['verified', 'succeeded', 'completed'].includes(verification)) {
      fail('formal_stage9_receipt_verification_invalid');
    }
    return {
      receiptId: requiredText(entry.receiptId, 'formal_stage9_receipt_id_required'),
      toolName: requiredText(entry.toolName, 'formal_stage9_tool_name_required'),
      verification,
    };
  }
  if (category === 'taskTimeline') {
    return {
      status: requiredText(entry.status, 'formal_stage9_timeline_status_required'),
      source: requiredText(entry.source, 'formal_stage9_timeline_source_required'),
    };
  }
  if (category === 'modelRouting') {
    const status = requiredText(entry.status, 'formal_stage9_routing_status_required');
    if (status !== 'succeeded') fail('formal_stage9_routing_status_invalid');
    return {
      routingReceiptId: requiredText(entry.routingReceiptId, 'formal_stage9_routing_receipt_required'),
      selectedProvider: requiredText(entry.selectedProvider, 'formal_stage9_selected_provider_required'),
      selectedModel: requiredText(entry.selectedModel, 'formal_stage9_selected_model_required'),
      status,
    };
  }
  if (category === 'artifacts') {
    if (entry.verified !== true) fail('formal_stage9_artifact_verification_required');
    return {
      artifactId: requiredText(entry.artifactId, 'formal_stage9_artifact_id_required'),
      verified: true,
    };
  }
  if (category === 'userFeedback') {
    const replySha256 = requiredText(entry.replySha256, 'formal_stage9_reply_sha256_required').toLowerCase();
    if (!SHA256_RE.test(replySha256) || entry.internalGuardLeaked !== false) {
      fail('formal_stage9_user_feedback_invalid');
    }
    return {
      messageId: requiredText(entry.messageId, 'formal_stage9_message_id_required'),
      replySha256,
      internalGuardLeaked: false,
    };
  }
  fail('formal_stage9_evidence_category_invalid');
}

function verifyFile(root, reference, prefix, errors) {
  try {
    const relativePath = canonicalRelativePath(reference.relativePath);
    const declaredSize = Number(reference.size);
    const declaredSha256 = text(reference.sha256).toLowerCase();
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_FILE_BYTES) {
      fail('size_invalid');
    }
    if (!SHA256_RE.test(declaredSha256)) fail('sha256_invalid');
    let cursor = root;
    for (const segment of relativePath.split('/')) {
      cursor = path.join(cursor, segment);
      const metadata = fs.lstatSync(cursor);
      if (metadata.isSymbolicLink()) fail('path_link_forbidden');
      const real = fs.realpathSync.native(cursor);
      if (pathIdentity(real) !== pathIdentity(cursor)) fail('path_reparse_forbidden');
      cursor = real;
    }
    if (!pathInside(root, cursor)) fail('path_outside_root');
    const source = readStableSource(cursor);
    if (source.size !== declaredSize) fail('size_mismatch');
    if (source.sha256 !== declaredSha256) fail('sha256_mismatch');
    return source;
  } catch (error) {
    errors.push(`${prefix}:${error?.code || 'file_invalid'}`);
    return null;
  }
}

function referenceManifestEntries(scenarioEvidence) {
  const entries = [];
  for (const scenarioId of Object.keys(scenarioEvidence).sort()) {
    for (const category of FORMAL_STAGE9_EVIDENCE_CATEGORIES) {
      for (const reference of scenarioEvidence[scenarioId][category]) {
        entries.push({
          scenarioId,
          category,
          recordId: reference.recordId,
          relativePath: reference.relativePath,
          size: reference.size,
          sha256: reference.sha256,
          requestId: reference.requestId,
          taskId: reference.taskId,
          recordedAt: reference.recordedAt,
        });
      }
    }
  }
  return entries;
}

export async function createFormalStage9FileBackedProducerEvidence(options = {}) {
  const producer = requiredText(options.producer, 'formal_stage9_producer_required');
  if (!FORMAL_STAGE9_PRODUCERS.includes(producer)) fail('formal_stage9_producer_invalid');
  if (!isPlainObject(options.payload)) fail('formal_stage9_producer_payload_required');
  if (!isPlainObject(options.scenarioEvidence)) fail('formal_stage9_scenario_evidence_required');
  assertUnadjudicated(options.payload);
  if (Object.hasOwn(options.payload, 'stage9ProducerEvidence')) {
    fail('formal_stage9_reserved_payload_field_present');
  }
  const binding = normalizeFormalStage9Binding(options.binding);
  const bindingDigest = formalStage9BindingDigest(binding);
  const recordedAt = normalizedIso(options.recordedAt || new Date(), 'formal_stage9_recorded_at_invalid');
  const evidenceRoot = normalizeEvidenceRoot(options.evidenceRoot);
  const runHash = formalStage9Digest({ acceptanceRunId: binding.acceptanceRunId });
  // A failed attempt must never poison the acceptance run's deterministic
  // directory and make a corrected retry impossible. Only a complete attempt
  // receives its manifest; incomplete attempt directories remain auditable.
  const attemptId = `attempt-${crypto.randomBytes(16).toString('hex')}`;
  const producerDirectory = ensureSafeDirectories(
    evidenceRoot,
    ['stage9-runs', runHash, producer, attemptId],
  );
  const expectedScenarios = FORMAL_STAGE9_SCENARIOS.filter(
    scenarioId => FORMAL_STAGE9_SCENARIO_OWNERS[scenarioId] === producer,
  );
  const suppliedScenarios = Object.keys(options.scenarioEvidence);
  if (suppliedScenarios.length !== expectedScenarios.length
    || suppliedScenarios.some(scenarioId => !expectedScenarios.includes(scenarioId))) {
    fail('formal_stage9_producer_scenario_set_invalid');
  }

  const normalizedEvidence = {};
  const seenRecordIds = new Set();
  for (const scenarioId of expectedScenarios) {
    const categories = options.scenarioEvidence[scenarioId];
    if (!isPlainObject(categories)
      || Object.keys(categories).length !== FORMAL_STAGE9_EVIDENCE_CATEGORIES.length
      || Object.keys(categories).some(category => !FORMAL_STAGE9_EVIDENCE_CATEGORIES.includes(category))) {
      fail('formal_stage9_producer_category_set_invalid', { scenarioId });
    }
    normalizedEvidence[scenarioId] = {};
    for (const category of FORMAL_STAGE9_EVIDENCE_CATEGORIES) {
      const sourceEntries = categories[category];
      if (!Array.isArray(sourceEntries) || sourceEntries.length === 0) {
        fail('formal_stage9_producer_category_empty', { scenarioId, category });
      }
      const categoryDirectory = ensureSafeDirectories(producerDirectory, [scenarioId, category]);
      normalizedEvidence[scenarioId][category] = [];
      for (const entry of sourceEntries) {
        if (!isPlainObject(entry)) fail('formal_stage9_source_entry_invalid');
        assertEntryBinding(entry, binding, bindingDigest);
        if (Object.hasOwn(entry, 'serverAttestation')
          || Object.hasOwn(entry, 'nativeAttestation')
          || Object.hasOwn(entry, 'publicKey')
          || Object.hasOwn(entry, 'publicKeyPem')) {
          fail('formal_stage9_producer_attestation_forbidden');
        }
        const recordId = requiredText(entry.recordId, 'formal_stage9_record_id_required');
        if (seenRecordIds.has(recordId)) fail('formal_stage9_record_id_reused');
        seenRecordIds.add(recordId);
        const source = readStableSource(entry.sourcePath);
        const sourceSecurity = verifySourceSecurity(source, entry.sourcePath, entry);
        const fileName = `${formalStage9Digest({ recordId }).slice(0, 24)}-${source.sha256}.evidence`;
        const destination = path.join(categoryDirectory, fileName);
        writeImmutableBytes(destination, source.bytes, 'formal_stage9_evidence_snapshot_write_failed');
        const relativePath = path.relative(evidenceRoot, destination).split(path.sep).join('/');
        normalizedEvidence[scenarioId][category].push({
          recordId,
          scenarioId,
          acceptanceRunId: binding.acceptanceRunId,
          bindingDigest,
          buildId: binding.buildId,
          sourceFingerprint: binding.sourceFingerprint,
          relativePath,
          size: source.size,
          sha256: source.sha256,
          recordedAt: normalizedIso(entry.recordedAt || recordedAt, 'formal_stage9_entry_recorded_at_invalid'),
          requestId: requiredText(entry.requestId, 'formal_stage9_request_id_required'),
          taskId: requiredText(entry.taskId, 'formal_stage9_task_id_required'),
          sourceSecurity,
          ...categoryFields(category, entry, binding),
        });
      }
    }
  }

  const manifest = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND,
    producer,
    acceptanceRunId: binding.acceptanceRunId,
    bindingDigest,
    buildId: binding.buildId,
    sourceFingerprint: binding.sourceFingerprint,
    recordedAt,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    entries: referenceManifestEntries(normalizedEvidence),
  };
  const manifestPath = path.join(producerDirectory, 'producer-manifest.json');
  const manifestFile = writeImmutableJson(
    manifestPath,
    manifest,
    'formal_stage9_producer_manifest_write_failed',
  );
  const manifestRelativePath = path.relative(evidenceRoot, manifestPath).split(path.sep).join('/');
  const payload = sanitizeProducerPayload(options.payload);
  payload.stage9ProducerEvidence = {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    manifestRelativePath,
    manifestSize: manifestFile.size,
    manifestSha256: manifestFile.sha256,
    acceptanceRunId: binding.acceptanceRunId,
    bindingDigest,
    buildId: binding.buildId,
    sourceFingerprint: binding.sourceFingerprint,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
  };
  const envelope = sealFormalStage9ProducerEvidence({
    producer,
    binding,
    payload,
    scenarioEvidence: normalizedEvidence,
    recordedAt,
  });
  return {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_FILE_PRODUCER_PACKAGE_KIND,
    producer,
    acceptanceRunId: binding.acceptanceRunId,
    bindingDigest,
    buildId: binding.buildId,
    sourceFingerprint: binding.sourceFingerprint,
    status: 'evidence_package_complete',
    ok: true,
    packageComplete: true,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    fullAcceptance: false,
    manifest: {
      relativePath: manifestRelativePath,
      size: manifestFile.size,
      sha256: manifestFile.sha256,
    },
    envelope,
  };
}

export function verifyFormalStage9FileBackedProducerEvidence(options = {}) {
  const errors = [];
  let binding;
  let evidenceRoot;
  try {
    binding = normalizeFormalStage9Binding(options.binding);
    evidenceRoot = normalizeEvidenceRoot(options.evidenceRoot);
  } catch (error) {
    return {
      ok: false,
      packageComplete: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      errors: [error?.code || 'formal_stage9_verification_context_invalid'],
    };
  }
  const bindingDigest = formalStage9BindingDigest(binding);
  const packageValue = options.package;
  const fileBackedPackage = isPlainObject(packageValue)
    && packageValue.kind === FORMAL_STAGE9_FILE_PRODUCER_PACKAGE_KIND;
  if (!fileBackedPackage) errors.push('file_backed_package_required');
  const envelope = isPlainObject(packageValue?.envelope) ? packageValue.envelope : null;
  const producer = text(envelope?.producer);
  if (!FORMAL_STAGE9_PRODUCERS.includes(producer)) errors.push('producer_invalid');
  if (text(envelope?.acceptanceRunId) !== binding.acceptanceRunId
    || text(envelope?.bindingDigest).toLowerCase() !== bindingDigest
    || stableFormalStage9Json(envelope?.binding) !== stableFormalStage9Json(binding)) {
    errors.push('binding_mismatch');
  }
  if (envelope?.status !== 'evidence_package_complete'
    || envelope?.packageComplete !== true
    || envelope?.acceptanceDecision !== 'not_adjudicated'
    || envelope?.acceptancePassed !== false) {
    errors.push('producer_state_invalid');
  }
  try {
    const resealed = sealFormalStage9ProducerEvidence({
      producer,
      binding,
      payload: envelope?.payload,
      scenarioEvidence: envelope?.scenarioEvidence,
      recordedAt: envelope?.recordedAt,
    });
    if (stableFormalStage9Json(resealed) !== stableFormalStage9Json(envelope)) {
      errors.push('producer_envelope_digest_mismatch');
    }
  } catch (error) {
    errors.push(`producer_envelope_invalid:${error?.code || 'unknown'}`);
  }
  if (fileBackedPackage) {
    if (packageValue.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
      || packageValue.producer !== producer) {
      errors.push('package_envelope_identity_mismatch');
    }
    if (packageValue.acceptanceRunId !== binding.acceptanceRunId
      || text(packageValue.bindingDigest).toLowerCase() !== bindingDigest
      || text(packageValue.buildId).toLowerCase() !== binding.buildId
      || text(packageValue.sourceFingerprint).toLowerCase() !== binding.sourceFingerprint) {
      errors.push('package_binding_mismatch');
    }
    if (packageValue.status !== 'evidence_package_complete'
      || packageValue.packageComplete !== true
      || packageValue.acceptanceDecision !== 'not_adjudicated'
      || packageValue.acceptancePassed !== false
      || packageValue.fullAcceptance !== false) {
      errors.push('package_state_invalid');
    }
    const manifestSource = verifyFile(
      evidenceRoot,
      packageValue.manifest || {},
      'producer_manifest',
      errors,
    );
    if (manifestSource) {
      try {
        const manifest = JSON.parse(manifestSource.bytes.toString('utf8'));
        const expectedEntries = referenceManifestEntries(envelope?.scenarioEvidence || {});
        if (manifest?.schemaVersion !== FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION
          || manifest?.kind !== FORMAL_STAGE9_PRODUCER_FILE_MANIFEST_KIND
          || manifest?.producer !== producer
          || manifest?.acceptanceRunId !== binding.acceptanceRunId
          || text(manifest?.bindingDigest).toLowerCase() !== bindingDigest
          || text(manifest?.buildId).toLowerCase() !== binding.buildId
          || text(manifest?.sourceFingerprint).toLowerCase() !== binding.sourceFingerprint
          || manifest?.acceptanceDecision !== 'not_adjudicated'
          || manifest?.acceptancePassed !== false
          || stableFormalStage9Json(manifest?.entries) !== stableFormalStage9Json(expectedEntries)) {
          errors.push('producer_manifest_content_mismatch');
        }
        const payloadManifest = envelope?.payload?.stage9ProducerEvidence;
        if (payloadManifest?.manifestRelativePath !== packageValue.manifest.relativePath
          || Number(payloadManifest?.manifestSize) !== Number(packageValue.manifest.size)
          || text(payloadManifest?.manifestSha256).toLowerCase() !== text(packageValue.manifest.sha256).toLowerCase()
          || payloadManifest?.acceptanceRunId !== binding.acceptanceRunId
          || text(payloadManifest?.bindingDigest).toLowerCase() !== bindingDigest) {
          errors.push('producer_payload_manifest_binding_mismatch');
        }
      } catch {
        errors.push('producer_manifest_json_invalid');
      }
    }
  }
  const expectedScenarios = FORMAL_STAGE9_SCENARIOS.filter(
    scenarioId => FORMAL_STAGE9_SCENARIO_OWNERS[scenarioId] === producer,
  );
  const actualScenarios = Object.keys(envelope?.scenarioEvidence || {});
  if (actualScenarios.length !== expectedScenarios.length
    || actualScenarios.some(scenarioId => !expectedScenarios.includes(scenarioId))) {
    errors.push('producer_scenario_set_invalid');
  }
  for (const scenarioId of expectedScenarios) {
    const actualCategories = Object.keys(envelope?.scenarioEvidence?.[scenarioId] || {});
    if (actualCategories.length !== FORMAL_STAGE9_EVIDENCE_CATEGORIES.length
      || actualCategories.some(category => !FORMAL_STAGE9_EVIDENCE_CATEGORIES.includes(category))) {
      errors.push(`${scenarioId}:category_set_invalid`);
    }
    for (const category of FORMAL_STAGE9_EVIDENCE_CATEGORIES) {
      const references = envelope?.scenarioEvidence?.[scenarioId]?.[category];
      if (!Array.isArray(references) || references.length === 0) {
        errors.push(`${scenarioId}:${category}:missing`);
        continue;
      }
      for (const reference of references) {
        if (reference?.acceptanceRunId !== binding.acceptanceRunId
          || text(reference?.bindingDigest).toLowerCase() !== bindingDigest
          || text(reference?.buildId).toLowerCase() !== binding.buildId
          || text(reference?.sourceFingerprint).toLowerCase() !== binding.sourceFingerprint) {
          errors.push(`${scenarioId}:${category}:binding_mismatch`);
        }
        if (Object.hasOwn(reference || {}, 'serverAttestation')
          || Object.hasOwn(reference || {}, 'nativeAttestation')) {
          errors.push(`${scenarioId}:${category}:producer_attestation_forbidden`);
        }
        if (!sourceSecurityIsValid(reference?.sourceSecurity)) {
          errors.push(`${scenarioId}:${category}:source_security_invalid`);
        }
        verifyFile(evidenceRoot, reference || {}, `${scenarioId}:${category}`, errors);
      }
    }
  }
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    packageComplete: uniqueErrors.length === 0,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    errors: uniqueErrors,
  };
}

export function assembleFormalStage9UnadjudicatedBundle(options = {}) {
  const binding = normalizeFormalStage9Binding(options.binding);
  const bindingDigest = formalStage9BindingDigest(binding);
  const evidenceRoot = normalizeEvidenceRoot(options.evidenceRoot);
  const packages = Array.isArray(options.producerPackages)
    ? options.producerPackages
    : Object.values(options.producerPackages || {});
  const byProducer = new Map();
  for (const packageValue of packages) {
    const verification = verifyFormalStage9FileBackedProducerEvidence({
      package: packageValue,
      binding,
      evidenceRoot,
    });
    if (!verification.ok) {
      fail('formal_stage9_producer_package_invalid', {
        producer: packageValue?.producer || packageValue?.envelope?.producer,
        errors: verification.errors,
      });
    }
    const producer = packageValue.envelope.producer;
    if (byProducer.has(producer)) fail('formal_stage9_producer_package_duplicate');
    byProducer.set(producer, packageValue.envelope);
  }
  if (byProducer.size !== FORMAL_STAGE9_PRODUCERS.length
    || FORMAL_STAGE9_PRODUCERS.some(producer => !byProducer.has(producer))) {
    fail('formal_stage9_five_producer_packages_required');
  }
  const timestamps = [...byProducer.values()].flatMap(envelope => [
    Date.parse(text(envelope.recordedAt)),
    ...Object.values(envelope.scenarioEvidence || {}).flatMap(categories => (
      Object.values(categories || {}).flatMap(references => (
        Array.isArray(references) ? references.map(reference => Date.parse(text(reference?.recordedAt))) : []
      ))
    )),
  ]).filter(Number.isFinite);
  const createdAt = options.createdAt
    ? normalizedIso(options.createdAt, 'formal_stage9_bundle_created_at_invalid')
    : new Date(Math.min(...timestamps)).toISOString();
  const completedAt = options.completedAt
    ? normalizedIso(options.completedAt, 'formal_stage9_bundle_completed_at_invalid')
    : new Date(Math.max(...timestamps)).toISOString();
  const bundle = sealFormalStage9EvidenceBundle({
    binding,
    producers: Object.fromEntries(FORMAL_STAGE9_PRODUCERS.map(producer => [producer, byProducer.get(producer)])),
    createdAt,
    completedAt,
  });
  const runHash = formalStage9Digest({ acceptanceRunId: binding.acceptanceRunId });
  const runDirectory = ensureSafeDirectories(evidenceRoot, ['stage9-runs', runHash]);
  const outputPath = path.join(
    runDirectory,
    `unadjudicated-bundle-${crypto.randomBytes(16).toString('hex')}.json`,
  );
  const output = writeImmutableJson(
    outputPath,
    bundle,
    'formal_stage9_unadjudicated_bundle_write_failed',
  );
  return {
    schemaVersion: FORMAL_STAGE9_ADJUDICATOR_SCHEMA_VERSION,
    kind: FORMAL_STAGE9_UNADJUDICATED_BUNDLE_PACKAGE_KIND,
    acceptanceRunId: binding.acceptanceRunId,
    bindingDigest,
    buildId: binding.buildId,
    sourceFingerprint: binding.sourceFingerprint,
    ok: true,
    packageComplete: true,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    fullAcceptance: false,
    bundle,
    bundleFile: {
      relativePath: path.relative(evidenceRoot, outputPath).split(path.sep).join('/'),
      size: output.size,
      sha256: output.sha256,
    },
  };
}

/** All formal producers stop at exit 2; only the external adjudicator may exit 0. */
export function formalStage9ProducerEvidenceExitCode(result) {
  return result?.ok === true
    && result?.packageComplete === true
    && result?.acceptanceDecision === 'not_adjudicated'
    && result?.acceptancePassed === false
    && result?.fullAcceptance !== true
    ? 2
    : 1;
}
