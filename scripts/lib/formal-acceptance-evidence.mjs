import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FORMAL_ACCEPTANCE_EVIDENCE_SCHEMA_VERSION = 2;
export const REDACTED_VALUE = '[REDACTED]';

export const FORMAL_ACCEPTANCE_FILES = Object.freeze({
  manifest: 'manifest.json',
  taskReceipts: 'task-receipts.jsonl',
  taskTimeline: 'task-timeline.jsonl',
  modelRouting: 'model-routing.jsonl',
  userFeedback: 'user-feedback.jsonl',
  logIndex: 'log-index.jsonl',
  artifactIndex: 'artifact-index.jsonl',
  screenshotIndex: 'screenshot-index.jsonl',
  logs: 'logs',
  finalSummary: 'final-summary.json',
});

const JSONL_KINDS = Object.freeze([
  'taskReceipts',
  'taskTimeline',
  'modelRouting',
  'userFeedback',
  'logIndex',
  'artifactIndex',
  'screenshotIndex',
]);

const DEFAULT_REQUIRED_EVIDENCE = Object.freeze([
  'taskReceipts',
  'taskTimeline',
  'modelRouting',
  'userFeedback',
  'logIndex',
  'logs',
  'artifacts',
  'screenshots',
]);

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const HEX_SHA256_RE = /^[a-f0-9]{64}$/iu;

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const HEADER_SECRET_RE = /\b(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|private[_-]?key|client[_-]?secret(?:[_-]?key)?|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?(?:access[_-]?)?key|session[_-]?key|signing[_-]?key|encryption[_-]?key|x-lumi-desktop-(?:session|bootstrap))\s*["']?\s*[:=]\s*["']?[^\r\n,;}]+/giu;
const COMMON_API_KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const URI_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_ARTIFACT_EXTENSIONS = new Set([
  '.csv', '.htm', '.html', '.ini', '.json', '.jsonl', '.log', '.md', '.ps1',
  '.sql', '.svg', '.toml', '.tsv', '.txt', '.xml', '.yaml', '.yml',
]);
const BINARY_ARTIFACT_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.doc', '.docx', '.gif', '.gz', '.jpeg', '.jpg', '.mov',
  '.mp3', '.mp4', '.pdf', '.png', '.ppt', '.pptx', '.wav', '.webp', '.xls', '.xlsx', '.zip',
]);
const MAX_TEXT_ARTIFACT_SCAN_BYTES = 8 * 1024 * 1024;

export class FormalAcceptanceEvidenceError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'FormalAcceptanceEvidenceError';
    this.code = code;
  }
}

function fail(code, cause) {
  throw new FormalAcceptanceEvidenceError(code, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeFreeText(value) {
  return String(value)
    .replace(PRIVATE_KEY_BLOCK_RE, REDACTED_VALUE)
    .replace(BEARER_RE, `Bearer ${REDACTED_VALUE}`)
    .replace(HEADER_SECRET_RE, match => `${match.split(/[:=]/u, 1)[0]}: ${REDACTED_VALUE}`)
    .replace(COMMON_API_KEY_RE, REDACTED_VALUE)
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(URI_USERINFO_RE, `$1${REDACTED_VALUE}@`);
}

function isSensitiveKey(value) {
  const compact = String(value || '').toLowerCase().replace(/[^a-z0-9]/gu, '');
  return /(?:token|cookie|authorization|auth|apikey|privatekey|clientsecret(?:key)?|secret(?:access)?key|sessionkey|signingkey|encryptionkey|secret|credential|password|passphrase|connectionstring|desktopsession(?:proof)?|desktopbootstrap(?:proof)?)$/u.test(compact);
}

function inspectArtifactSecretSafety(source) {
  const extension = path.extname(source.absolute).toLowerCase();
  if (BINARY_ARTIFACT_EXTENSIONS.has(extension)) {
    return {
      secretScanStatus: 'manual_review_required_binary',
      secretScanBytes: 0,
      manualRedactionReviewRequired: true,
    };
  }
  if (source.metadata.size > MAX_TEXT_ARTIFACT_SCAN_BYTES) {
    fail(TEXT_ARTIFACT_EXTENSIONS.has(extension)
      ? 'text_evidence_too_large_for_secret_scan'
      : 'unknown_evidence_too_large_for_secret_scan');
  }
  const content = fs.readFileSync(source.absolute);
  const looksBinary = !TEXT_ARTIFACT_EXTENSIONS.has(extension) && content.includes(0);
  if (looksBinary) {
    return {
      secretScanStatus: 'manual_review_required_binary',
      secretScanBytes: 0,
      manualRedactionReviewRequired: true,
    };
  }
  const text = content.toString('utf8');
  if (sanitizeFreeText(text) !== text) fail('evidence_source_contains_sensitive_text');
  return {
    secretScanStatus: 'passed_text_scan',
    secretScanBytes: content.length,
    manualRedactionReviewRequired: false,
  };
}

/** Recursively remove credentials before an evidence object can reach disk. */
export function redactAcceptanceEvidence(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeFreeText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      bytes: value.length,
      sha256: crypto.createHash('sha256').update(value).digest('hex'),
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => redactAcceptanceEvidence(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED_VALUE
      : redactAcceptanceEvidence(item, seen);
  }
  seen.delete(value);
  return result;
}

function normalizedAbsolutePath(value, code) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) fail(code);
  return path.resolve(text);
}

function ensureDirectory(value, code, { create = false } = {}) {
  const absolute = normalizedAbsolutePath(value, code);
  if (create) fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = fs.lstatSync(absolute);
  } catch (error) {
    fail(code, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  return fs.realpathSync.native(absolute);
}

export function pathIsInside(basePath, candidatePath, { allowEqual = false } = {}) {
  const base = path.resolve(String(basePath || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(base, candidate);
  if (!relative) return allowEqual;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeRelativeDestination(basePath, relativePath, code) {
  const raw = String(relativePath || '').trim();
  if (!raw || path.isAbsolute(raw) || raw.includes('\0')) fail(code);
  const destination = path.resolve(basePath, raw);
  if (!pathIsInside(basePath, destination)) fail(code);
  return destination;
}

function validateBuildId(buildId) {
  const value = String(buildId || '').trim();
  if (!/^[a-f0-9]{7,64}$/iu.test(value)) fail('invalid_build_id');
  return value.toLowerCase();
}

function validateIdentity(label, value, buildId) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) fail(`${label}_identity_required`);
  const identityBuildId = String(value.buildId || '').trim().toLowerCase();
  if (!identityBuildId || identityBuildId !== buildId) {
    fail(`${label}_build_mismatch`);
  }
  const pid = Math.trunc(Number(value.pid));
  const startAt = new Date(String(value.startedAt || value.startAt || ''));
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startAt.getTime())) {
    fail(`${label}_identity_invalid`);
  }
  return {
    ...redactAcceptanceEvidence(value),
    pid,
    buildId: identityBuildId,
    startedAt: startAt.toISOString(),
  };
}

function normalizeProfile(profile) {
  const input = typeof profile === 'string' ? { userDataDir: profile } : profile;
  if (!isPlainObject(input)) fail('profile_identity_required');
  const userDataDir = input.userDataDir || input.path;
  const canonical = ensureDirectory(userDataDir, 'absolute_existing_profile_required');
  return {
    ...redactAcceptanceEvidence(input),
    userDataDir: canonical,
  };
}

function normalizeTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_run_timestamp');
  return {
    iso: date.toISOString(),
    pathPart: date.toISOString().replace(/[-:.]/gu, ''),
  };
}

function normalizeRandomMarker(value) {
  const marker = value === undefined ? crypto.randomBytes(8).toString('hex') : String(value);
  if (!/^[a-f0-9]{16,64}$/iu.test(marker)) fail('invalid_run_marker');
  return marker.toLowerCase();
}

export function atomicWriteJsonExclusive(filePath, value) {
  if (fs.existsSync(filePath)) fail('evidence_file_exists');
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(redactAcceptanceEvidence(value), null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // linkSync is an atomic, no-replace publication step on the same
    // filesystem. renameSync would replace a file another formal run created
    // after the existsSync check on POSIX/macOS.
    fs.linkSync(temporary, filePath);
  } catch (error) {
    if (error instanceof FormalAcceptanceEvidenceError) throw error;
    if (error?.code === 'EEXIST') fail('evidence_file_exists', error);
    fail('evidence_atomic_write_failed', error);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function createEmptyFileExclusive(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
  } catch (error) {
    fail('evidence_file_exists', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertRegularFile(filePath, code) {
  const absolute = normalizedAbsolutePath(filePath, code);
  let metadata;
  try {
    metadata = fs.lstatSync(absolute);
  } catch (error) {
    fail(code, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(code);
  return { absolute: fs.realpathSync.native(absolute), metadata };
}

export async function sha256File(filePath) {
  const { absolute } = assertRegularFile(filePath, 'evidence_source_file_required');
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absolute);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function relativeEvidencePath(runDirectory, target) {
  return path.relative(runDirectory, target).split(path.sep).join('/');
}

function listFilesRecursively(directory) {
  const result = [];
  const visit = current => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail('evidence_symlink_detected');
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) result.push(candidate);
      else fail('unsupported_evidence_entry');
    }
  };
  visit(directory);
  return result;
}

function jsonlRecordCount(filePath) {
  return readJsonlRecords(filePath).length;
}

function readJsonlRecords(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/gu).filter(Boolean).map(line => JSON.parse(line));
}

function appendJsonLine(filePath, value) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'a', 0o600);
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    fail('evidence_jsonl_append_failed', error);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function normalizeChecks(value) {
  if (Array.isArray(value)) {
    return value.map((check, index) => {
      if (!isPlainObject(check)) fail('invalid_acceptance_check');
      return {
        ...redactAcceptanceEvidence(check),
        id: String(check.id || `check-${index + 1}`),
        passed: check.passed === true,
      };
    });
  }
  if (isPlainObject(value)) {
    return Object.entries(value).map(([id, check]) => {
      if (isPlainObject(check)) {
        return { ...redactAcceptanceEvidence(check), id, passed: check.passed === true };
      }
      return { id, passed: check === true };
    });
  }
  if (value === undefined) return [];
  fail('invalid_acceptance_checks');
}

function nonEmpty(value) {
  return Boolean(String(value || '').trim());
}

function validSha256(value) {
  return HEX_SHA256_RE.test(String(value || '').trim());
}

function readEvidenceRecords(filePath, kind, failures) {
  try {
    return readJsonlRecords(filePath);
  } catch {
    failures.push(`${kind}:invalid_jsonl`);
    return [];
  }
}

/**
 * Evidence-package validation intentionally stops short of deciding whether
 * Lumi passed formal acceptance. It proves only that the retained records are
 * structurally meaningful, cross-linked and internally consistent. A separate
 * fixed Stage 9 adjudicator must decide product acceptance.
 */
async function validateEvidenceSemantics(paths) {
  const failures = [];
  const receipts = readEvidenceRecords(paths.taskReceipts, 'taskReceipts', failures);
  const timeline = readEvidenceRecords(paths.taskTimeline, 'taskTimeline', failures);
  const routing = readEvidenceRecords(paths.modelRouting, 'modelRouting', failures);
  const feedback = readEvidenceRecords(paths.userFeedback, 'userFeedback', failures);
  const logs = readEvidenceRecords(paths.logIndex, 'logIndex', failures);
  const artifacts = readEvidenceRecords(paths.artifactIndex, 'artifactIndex', failures);
  const screenshots = readEvidenceRecords(paths.screenshotIndex, 'screenshotIndex', failures);

  receipts.forEach((record, index) => {
    if (![record?.receiptId, record?.taskId, record?.requestId, record?.toolName].every(nonEmpty)
      || (!nonEmpty(record?.outcome) && !nonEmpty(record?.verification))) {
      failures.push(`taskReceipts:${index + 1}:invalid_schema`);
    }
  });
  timeline.forEach((record, index) => {
    if (!nonEmpty(record?.taskId) || !nonEmpty(record?.status) || !nonEmpty(record?.source)) {
      failures.push(`taskTimeline:${index + 1}:invalid_schema`);
    }
  });
  routing.forEach((record, index) => {
    const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
    const succeeded = String(record?.status || '') === 'succeeded';
    const selectedAttempt = attempts.some(attempt => (
      attempt?.status === 'succeeded'
      && String(attempt?.provider || '') === String(record?.selectedProvider || '')
      && String(attempt?.model || '') === String(record?.selectedModel || '')
    ));
    if (![record?.id, record?.requestId, record?.status].every(nonEmpty)
      || (succeeded && (!nonEmpty(record?.selectedProvider)
        || !nonEmpty(record?.selectedModel)
        || !selectedAttempt))) {
      failures.push(`modelRouting:${index + 1}:invalid_schema`);
    }
  });
  feedback.forEach((record, index) => {
    if (![record?.messageId, record?.requestId].every(nonEmpty)
      || !validSha256(record?.replySha256)
      || !Number.isFinite(Number(record?.replyCharacters))
      || Number(record.replyCharacters) <= 0
      || record?.internalGuardLeaked !== false) {
      failures.push(`userFeedback:${index + 1}:invalid_schema`);
    }
  });
  for (const [index, record] of logs.entries()) {
    const prefix = `logIndex:${index + 1}`;
    if (!nonEmpty(record?.storedPath)
      || !validSha256(record?.sha256)
      || !Number.isFinite(Number(record?.bytes))
      || Number(record.bytes) < 0
      || !validSha256(record?.sourcePathSha256)
      || record?.redacted !== true) {
      failures.push(`${prefix}:invalid_schema`);
    }
  }
  artifacts.forEach((record, index) => {
    const scanStatus = String(record?.secretScanStatus || '');
    if (!['passed_text_scan', 'manual_review_required_binary'].includes(scanStatus)
      || record?.publishable !== false
      || (scanStatus === 'manual_review_required_binary'
        && record?.manualRedactionReviewRequired !== true)) {
      failures.push(`artifactIndex:${index + 1}:security_scan_invalid`);
    }
  });
  screenshots.forEach((record, index) => {
    if (record?.secretScanStatus !== 'manual_review_required_screenshot'
      || record?.manualRedactionReviewRequired !== true
      || record?.publishable !== false) {
      failures.push(`screenshotIndex:${index + 1}:security_scan_invalid`);
    }
  });

  const timelineTaskIds = new Set(timeline.map(record => String(record?.taskId || '')).filter(Boolean));
  const timelineRequestIds = new Set(timeline.map(record => String(record?.requestId || '')).filter(Boolean));
  const feedbackRequestIds = new Set(feedback.map(record => String(record?.requestId || '')).filter(Boolean));
  const routingRequestIds = new Set(routing.map(record => String(record?.requestId || '')).filter(Boolean));
  if (receipts.some(record => !timelineTaskIds.has(String(record?.taskId || '')))) {
    failures.push('relations:receipt_task_missing_from_timeline');
  }
  if (receipts.some(record => {
    const requestId = String(record?.requestId || '');
    return requestId && !timelineRequestIds.has(requestId) && !feedbackRequestIds.has(requestId);
  })) {
    failures.push('relations:receipt_request_unlinked');
  }
  if (routing.length > 0 && !routing.some(record => feedbackRequestIds.has(String(record?.requestId || '')))) {
    failures.push('relations:routing_feedback_unlinked');
  }
  if (feedback.length > 0 && !feedback.some(record => routingRequestIds.has(String(record?.requestId || '')))) {
    failures.push('relations:feedback_routing_unlinked');
  }
  if (receipts.length > 0 && !receipts.some(record => (
    record?.verification === 'verified'
    || ['succeeded', 'completed'].includes(String(record?.outcome || ''))
  ))) {
    failures.push('semantics:no_verified_task_receipt');
  }
  if (timeline.length > 0 && !timeline.some(record => TERMINAL_TASK_STATUSES.has(String(record?.status || '')))) {
    failures.push('semantics:no_terminal_task_timeline');
  }
  if (routing.length > 0 && !routing.some(record => record?.status === 'succeeded')) {
    failures.push('semantics:no_successful_model_route');
  }
  return failures;
}

export class FormalAcceptanceEvidenceRun {
  constructor({ runDirectory, manifest }) {
    this.runDirectory = runDirectory;
    this.runId = manifest.runId;
    this.buildId = manifest.buildId;
    this.manifest = manifest;
    this.finalized = false;
    this.paths = Object.freeze({
      manifest: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.manifest),
      taskReceipts: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.taskReceipts),
      taskTimeline: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.taskTimeline),
      modelRouting: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.modelRouting),
      userFeedback: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.userFeedback),
      logIndex: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.logIndex),
      artifactIndex: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.artifactIndex),
      screenshotIndex: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.screenshotIndex),
      logs: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.logs),
      artifacts: path.join(runDirectory, 'artifacts'),
      screenshots: path.join(runDirectory, 'screenshots'),
      finalSummary: path.join(runDirectory, FORMAL_ACCEPTANCE_FILES.finalSummary),
    });
  }

  assertCollecting() {
    if (this.finalized || fs.existsSync(this.paths.finalSummary)) fail('evidence_run_finalized');
  }

  append(kind, record) {
    this.assertCollecting();
    if (!JSONL_KINDS.includes(kind) || !isPlainObject(record)) fail('invalid_evidence_record');
    const target = this.paths[kind];
    if (!pathIsInside(this.runDirectory, target) || !fs.existsSync(target)) fail('evidence_path_invalid');
    const targetMetadata = fs.lstatSync(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) fail('evidence_path_invalid');
    const sanitized = redactAcceptanceEvidence(record);
    appendJsonLine(target, {
      ...sanitized,
      evidenceRecordedAt: new Date().toISOString(),
    });
    return sanitized;
  }

  appendTaskReceipt(record) { return this.append('taskReceipts', record); }
  appendTaskTimeline(record) { return this.append('taskTimeline', record); }
  appendModelRouting(record) { return this.append('modelRouting', record); }
  appendUserFeedback(record) { return this.append('userFeedback', record); }
  appendLogIndex(record) { return this.append('logIndex', record); }

  async copyRedactedLog(sourcePath, options = {}) {
    this.assertCollecting();
    const source = assertRegularFile(sourcePath, 'evidence_source_file_required');
    const maxBytes = Math.min(Math.max(Math.trunc(Number(options.maxBytes)) || 512 * 1024, 1), 2 * 1024 * 1024);
    const start = Math.max(0, source.metadata.size - maxBytes);
    const descriptor = fs.openSync(source.absolute, 'r');
    const buffer = Buffer.alloc(Math.min(source.metadata.size, maxBytes));
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(descriptor);
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstLine = text.indexOf('\n');
      text = firstLine >= 0 ? text.slice(firstLine + 1) : '';
    }
    const redacted = `${sanitizeFreeText(text)}${text.endsWith('\n') || !text ? '' : '\n'}`;
    const relativePath = options.relativePath || `${path.basename(source.absolute)}.redacted.log`;
    const destination = safeRelativeDestination(this.paths.logs, relativePath, 'evidence_destination_escape');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const canonicalParent = fs.realpathSync.native(path.dirname(destination));
    if (!pathIsInside(this.paths.logs, canonicalParent, { allowEqual: true })
      || !pathIsInside(this.paths.logs, destination)
      || fs.existsSync(destination)) {
      fail('evidence_destination_escape');
    }
    try {
      const output = fs.openSync(destination, 'wx', 0o600);
      try {
        fs.writeFileSync(output, redacted, 'utf8');
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      const metadata = fs.lstatSync(destination);
      const record = {
        id: crypto.randomUUID(),
        sourcePathSha256: crypto.createHash('sha256').update(source.absolute, 'utf8').digest('hex'),
        sourceFileName: path.basename(source.absolute),
        sourceBytes: source.metadata.size,
        sourceModifiedAt: source.metadata.mtime.toISOString(),
        storedPath: relativeEvidencePath(this.runDirectory, destination),
        bytes: metadata.size,
        sha256: await sha256File(destination),
        truncated: start > 0,
        redacted: true,
        evidenceClassification: 'restricted_private_local',
        publishable: false,
        metadata: redactAcceptanceEvidence(options.metadata || {}),
      };
      this.appendLogIndex(record);
      return record;
    } catch (error) {
      try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch {}
      if (error instanceof FormalAcceptanceEvidenceError) throw error;
      fail('evidence_log_snapshot_failed', error);
    }
  }

  async copyIndexedFile(sourcePath, bucket, indexKind, options = {}) {
    this.assertCollecting();
    const source = assertRegularFile(sourcePath, 'evidence_source_file_required');
    const security = indexKind === 'artifactIndex'
      ? inspectArtifactSecretSafety(source)
      : {
          secretScanStatus: 'manual_review_required_screenshot',
          secretScanBytes: 0,
          manualRedactionReviewRequired: true,
        };
    const relativePath = options.relativePath || path.basename(source.absolute);
    const destination = safeRelativeDestination(this.paths[bucket], relativePath, 'evidence_destination_escape');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const canonicalParent = fs.realpathSync.native(path.dirname(destination));
    if (!pathIsInside(this.paths[bucket], canonicalParent, { allowEqual: true })) {
      fail('evidence_destination_escape');
    }
    if (!pathIsInside(this.paths[bucket], destination) || fs.existsSync(destination)) {
      fail('evidence_destination_exists');
    }
    try {
      fs.copyFileSync(source.absolute, destination, fs.constants.COPYFILE_EXCL);
      const metadata = fs.lstatSync(destination);
      const sha256 = await sha256File(destination);
      const record = {
        id: crypto.randomUUID(),
        sourcePath: source.absolute,
        storedPath: relativeEvidencePath(this.runDirectory, destination),
        bytes: metadata.size,
        sha256,
        ...security,
        evidenceClassification: 'restricted_private_local',
        publishable: false,
        metadata: redactAcceptanceEvidence(options.metadata || {}),
      };
      this.append(indexKind, record);
      return record;
    } catch (error) {
      try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch {}
      if (error instanceof FormalAcceptanceEvidenceError) throw error;
      fail('evidence_copy_failed', error);
    }
  }

  async copyArtifact(sourcePath, options = {}) {
    return this.copyIndexedFile(sourcePath, 'artifacts', 'artifactIndex', options);
  }

  async registerScreenshot(sourcePath, options = {}) {
    const source = assertRegularFile(sourcePath, 'existing_png_required');
    if (path.extname(source.absolute).toLowerCase() !== '.png') fail('existing_png_required');
    const descriptor = fs.openSync(source.absolute, 'r');
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    try {
      const bytesRead = fs.readSync(descriptor, signature, 0, signature.length, 0);
      if (bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE)) fail('invalid_png_signature');
    } finally {
      fs.closeSync(descriptor);
    }
    return this.copyIndexedFile(source.absolute, 'screenshots', 'screenshotIndex', options);
  }

  async buildInventory() {
    const files = listFilesRecursively(this.runDirectory)
      .filter(file => file !== this.paths.finalSummary);
    const entries = [];
    for (const file of files) {
      const metadata = fs.lstatSync(file);
      entries.push({
        path: relativeEvidencePath(this.runDirectory, file),
        bytes: metadata.size,
        sha256: await sha256File(file),
      });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async validateIndexedEvidence(indexKind, bucket) {
    const failures = [];
    let records;
    try {
      records = readJsonlRecords(this.paths[indexKind]);
    } catch {
      return [`${indexKind}:invalid_jsonl`];
    }
    const seen = new Set();
    for (const [index, record] of records.entries()) {
      const prefix = `${indexKind}:${index + 1}`;
      const storedPath = String(record?.storedPath || '');
      const candidate = path.resolve(this.runDirectory, storedPath);
      if (!storedPath || !pathIsInside(this.paths[bucket], candidate) || seen.has(candidate)) {
        failures.push(`${prefix}:invalid_path`);
        continue;
      }
      seen.add(candidate);
      let metadata;
      try {
        metadata = fs.lstatSync(candidate);
      } catch {
        failures.push(`${prefix}:missing_file`);
        continue;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        failures.push(`${prefix}:invalid_file`);
        continue;
      }
      if (metadata.size !== Number(record?.bytes)) failures.push(`${prefix}:size_mismatch`);
      const actualSha256 = await sha256File(candidate);
      if (actualSha256 !== String(record?.sha256 || '')) failures.push(`${prefix}:sha256_mismatch`);
    }
    return failures;
  }

  async finalize(options = {}) {
    this.assertCollecting();
    const checks = normalizeChecks(options.checks);
    const scenarioCoverage = options.scenarioCoverage === undefined
      ? null
      : redactAcceptanceEvidence(options.scenarioCoverage);
    if (Object.prototype.hasOwnProperty.call(options, 'requiredEvidence')) {
      fail('required_evidence_is_fixed');
    }
    const requiredEvidence = DEFAULT_REQUIRED_EVIDENCE;

    const counts = {};
    const integrityFailures = [];
    for (const kind of JSONL_KINDS) {
      try {
        counts[kind] = jsonlRecordCount(this.paths[kind]);
      } catch {
        counts[kind] = 0;
        integrityFailures.push(`${kind}:invalid_jsonl`);
      }
    }
    counts.artifacts = listFilesRecursively(this.paths.artifacts).length;
    counts.screenshots = listFilesRecursively(this.paths.screenshots).length;
    counts.logs = listFilesRecursively(this.paths.logs).length;

    if (counts.artifacts !== counts.artifactIndex) integrityFailures.push('artifacts:index_count_mismatch');
    if (counts.screenshots !== counts.screenshotIndex) integrityFailures.push('screenshots:index_count_mismatch');
    if (counts.logs !== counts.logIndex) integrityFailures.push('logs:index_count_mismatch');
    integrityFailures.push(...await this.validateIndexedEvidence('artifactIndex', 'artifacts'));
    integrityFailures.push(...await this.validateIndexedEvidence('screenshotIndex', 'screenshots'));
    integrityFailures.push(...await this.validateIndexedEvidence('logIndex', 'logs'));
    integrityFailures.push(...await validateEvidenceSemantics(this.paths));

    const missing = requiredEvidence.filter(kind => !Number(counts[kind] || 0));
    if (checks.length === 0) missing.push('acceptanceChecks');
    for (const check of checks) {
      if (!check.passed) missing.push(`check:${check.id}`);
    }
    const inventory = await this.buildInventory();
    const inventorySha256 = crypto.createHash('sha256')
      .update(JSON.stringify(inventory), 'utf8')
      .digest('hex');
    const status = missing.length === 0 && integrityFailures.length === 0
      ? 'evidence_package_complete'
      : 'incomplete';
    const summary = {
      schemaVersion: FORMAL_ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
      kind: 'lumi-formal-acceptance-summary',
      runId: this.runId,
      buildId: this.buildId,
      createdAt: this.manifest.createdAt,
      finalizedAt: new Date().toISOString(),
      status,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      checks,
      scenarioCoverage,
      evidenceCounts: counts,
      requiredEvidence: [...requiredEvidence],
      missing,
      integrityFailures,
      inventory,
      inventorySha256,
      inventoryScope: `all run files except ${FORMAL_ACCEPTANCE_FILES.finalSummary}`,
      evidenceRetained: true,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    };
    atomicWriteJsonExclusive(this.paths.finalSummary, summary);
    this.finalized = true;
    return {
      ...summary,
      finalSummaryPath: this.paths.finalSummary,
      finalSummarySha256: await sha256File(this.paths.finalSummary),
    };
  }
}

export function createFormalAcceptanceEvidenceRun(options = {}) {
  const evidenceRoot = ensureDirectory(
    options.evidenceRoot,
    'absolute_evidence_root_required',
    { create: true },
  );
  const buildId = validateBuildId(options.buildId);
  const dataRoot = ensureDirectory(options.dataRoot, 'absolute_existing_data_root_required');
  const profile = normalizeProfile(options.profile);
  const runtime = validateIdentity('runtime', options.runtime, buildId);
  const client = validateIdentity('client', options.client, buildId);
  const timestamp = normalizeTimestamp(options.timestamp);
  const randomMarker = normalizeRandomMarker(options.randomMarker);
  const runId = `${buildId}-${timestamp.pathPart}-${randomMarker}`;
  const runDirectory = path.resolve(evidenceRoot, runId);
  if (!pathIsInside(evidenceRoot, runDirectory)) fail('evidence_run_path_escape');
  try {
    fs.mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('evidence_run_exists', error);
    fail('evidence_run_create_failed', error);
  }
  const canonicalRunDirectory = fs.realpathSync.native(runDirectory);
  if (!pathIsInside(evidenceRoot, canonicalRunDirectory)) fail('evidence_run_path_escape');

  fs.mkdirSync(path.join(canonicalRunDirectory, 'artifacts'), { mode: 0o700 });
  fs.mkdirSync(path.join(canonicalRunDirectory, 'screenshots'), { mode: 0o700 });
  fs.mkdirSync(path.join(canonicalRunDirectory, FORMAL_ACCEPTANCE_FILES.logs), { mode: 0o700 });
  for (const kind of JSONL_KINDS) {
    createEmptyFileExclusive(path.join(canonicalRunDirectory, FORMAL_ACCEPTANCE_FILES[kind]));
  }

  const manifest = {
    schemaVersion: FORMAL_ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
    kind: 'lumi-formal-acceptance-run',
    runId,
    createdAt: timestamp.iso,
    status: 'collecting',
    buildId,
    evidenceRoot,
    runDirectory: canonicalRunDirectory,
    dataRoot,
    profile,
    runtime,
    client,
    evidenceClassification: 'restricted_private_local',
    publishable: false,
    files: {
      taskReceipts: FORMAL_ACCEPTANCE_FILES.taskReceipts,
      taskTimeline: FORMAL_ACCEPTANCE_FILES.taskTimeline,
      modelRouting: FORMAL_ACCEPTANCE_FILES.modelRouting,
      userFeedback: FORMAL_ACCEPTANCE_FILES.userFeedback,
      logIndex: FORMAL_ACCEPTANCE_FILES.logIndex,
      artifactIndex: FORMAL_ACCEPTANCE_FILES.artifactIndex,
      screenshotIndex: FORMAL_ACCEPTANCE_FILES.screenshotIndex,
      logs: `${FORMAL_ACCEPTANCE_FILES.logs}/`,
      artifacts: 'artifacts/',
      screenshots: 'screenshots/',
      finalSummary: FORMAL_ACCEPTANCE_FILES.finalSummary,
    },
  };
  atomicWriteJsonExclusive(path.join(canonicalRunDirectory, FORMAL_ACCEPTANCE_FILES.manifest), manifest);
  return new FormalAcceptanceEvidenceRun({ runDirectory: canonicalRunDirectory, manifest });
}
