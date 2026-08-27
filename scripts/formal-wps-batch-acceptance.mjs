import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFormalStage9FileBackedProducerEvidence,
  formalStage9ProducerEvidenceExitCode,
} from './lib/formal-stage9-producer-evidence.mjs';

export const FORMAL_WPS_BATCH_SCHEMA_VERSION = 1;
export const FORMAL_WPS_BATCH_MANIFEST_KIND = 'lumi.formal-wps-batch-acceptance-manifest';
export const FORMAL_WPS_BATCH_EVIDENCE_KIND = 'lumi.formal-wps-batch-acceptance-evidence';

export const FORMAL_WPS_BATCH_SCENARIO_IDS = Object.freeze([
  'wps-current-document-correction-analysis',
  'runtime-status-batch-cleanup',
]);

const BUILD_ID_RE = /^[a-f0-9]{7,64}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const WPS_PROCESS_RE = /^(?:wps|wpp|et)\.exe$/i;
const WINDOW_HANDLE_RE = /^(?:0x[a-f0-9]+|[1-9][0-9]*)$/i;
const TASK_KIND_SET = new Set(['delegation', 'autonomy', 'takeover']);
const TERMINAL_PHASE_SET = new Set(['completed', 'failed', 'cancelled']);

const WPS_ALLOWED_TOOLS = Object.freeze([
  'desktop_active_window',
  'get_active_window_info',
  'search_files',
  'desktop_list_files',
  'extract_document_text',
  'read_file',
  'read_pdf',
  'read_docx',
  'read_xlsx',
  'work_product_plan',
  'work_product_verify',
]);

const WPS_READ_TOOLS = new Set([
  'extract_document_text',
  'read_file',
  'read_pdf',
  'read_docx',
  'read_xlsx',
]);

const WPS_TIMELINE_EVENTS = Object.freeze([
  'task_started',
  'initial_target_selected',
  'target_correction_received',
  'target_confirmed',
  'document_read_verified',
  'artifact_verified',
  'task_completed',
]);

const BATCH_TIMELINE_EVENTS = Object.freeze([
  'control_task_started',
  'target_status_observed',
  'protected_canary_observed',
  'batch_cancel_requested',
  'batch_cancel_verified',
  'target_status_rechecked',
  'lease_release_verified',
  'protected_canary_rechecked',
  'control_task_completed',
]);

const WPS_SCREENSHOT_STAGES = Object.freeze([
  'active_wps_bound',
  'corrected_target_visible',
  'final_result_visible',
]);

const BATCH_SCREENSHOT_STAGES = Object.freeze([
  'status_before_visible',
  'cleanup_result_visible',
  'status_after_visible',
]);

const WPS_HUMAN_CHECKS = Object.freeze([
  'active-window-document-match',
  'correction-kept-same-task',
  'artifact-and-citations-reviewed',
]);

const BATCH_HUMAN_CHECKS = Object.freeze([
  'exact-target-set-reviewed',
  'protected-canary-unchanged',
  'leases-released',
  'visible-feedback-reviewed',
]);

const EVIDENCE_ROUTE_STAGES = Object.freeze([
  'before_targets',
  'before_protected',
  'cancel_targets',
  'after_targets',
  'after_protected',
]);

export class FormalWpsBatchAcceptanceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'FormalWpsBatchAcceptanceError';
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCondition(condition, code, details = {}) {
  if (!condition) throw new FormalWpsBatchAcceptanceError(code, details);
}

function validIsoDate(value) {
  return Boolean(text(value)) && !Number.isNaN(Date.parse(text(value)));
}

function portablePathFlavor(value) {
  const clean = text(value);
  if (!clean || clean.includes('\0') || /^file:/i.test(clean)) return null;
  if (/^[A-Za-z]:[\\/]/u.test(clean)) return 'win32';
  if (clean.startsWith('/') && !clean.includes('\\')) return 'posix';
  return null;
}

function normalizedPortablePath(value, { allowRoot = false } = {}) {
  const clean = text(value);
  const flavor = portablePathFlavor(clean);
  if (!flavor) return null;
  const segments = clean.split(/[\\/]/u);
  if (segments.includes('..')) return null;
  const api = flavor === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(clean);
  const root = api.parse(normalized).root;
  if (!normalized || (!allowRoot && normalized === root)) return null;
  return {
    flavor,
    normalized,
    identity: (flavor === 'win32' ? normalized.toLowerCase() : normalized).replace(/[\\/]+/gu, '/'),
  };
}

function portableBasename(value) {
  const normalized = normalizedPortablePath(value);
  if (!normalized) return '';
  const api = normalized.flavor === 'win32' ? path.win32 : path.posix;
  return api.basename(normalized.normalized);
}

function portableDirname(value) {
  const normalized = normalizedPortablePath(value);
  if (!normalized) return '';
  const api = normalized.flavor === 'win32' ? path.win32 : path.posix;
  return api.dirname(normalized.normalized);
}

function samePortablePath(left, right) {
  const leftPath = normalizedPortablePath(left);
  const rightPath = normalizedPortablePath(right);
  return Boolean(leftPath && rightPath && leftPath.flavor === rightPath.flavor && leftPath.identity === rightPath.identity);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function stableFormalWpsBatchJson(value) {
  return JSON.stringify(stableValue(value));
}

export function formalWpsBatchDigest(value) {
  const copy = structuredClone(value);
  if (isPlainObject(copy)) delete copy.manifestDigest;
  return crypto.createHash('sha256').update(stableFormalWpsBatchJson(copy), 'utf8').digest('hex');
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableFormalWpsBatchJson(value), 'utf8').digest('hex');
}

function normalizedScope(raw, codePrefix = 'scope') {
  assertCondition(isPlainObject(raw), `${codePrefix}_invalid`);
  const domain = text(raw.domain);
  assertCondition(domain === 'personal' || domain === 'work', `${codePrefix}_domain_invalid`);
  const orgId = text(raw.orgId);
  assertCondition(domain !== 'work' || Boolean(orgId), `${codePrefix}_org_required`);
  assertCondition(domain !== 'personal' || !orgId, `${codePrefix}_personal_org_invalid`);
  return domain === 'work' ? { domain, orgId } : { domain };
}

function sameScope(left, right) {
  try {
    return stableFormalWpsBatchJson(normalizedScope(left)) === stableFormalWpsBatchJson(normalizedScope(right));
  } catch {
    return false;
  }
}

function normalizeRuntimeBinding(raw) {
  assertCondition(isPlainObject(raw), 'runtime_binding_invalid');
  const buildId = text(raw.buildId).toLowerCase();
  const dataRoot = normalizedPortablePath(raw.dataRoot);
  const webviewProfile = normalizedPortablePath(raw.webviewProfile || raw.userDataDir);
  const evidenceRunDirectory = normalizedPortablePath(raw.evidenceRunDirectory || raw.runDirectory);
  assertCondition(BUILD_ID_RE.test(buildId), 'build_id_invalid');
  assertCondition(Boolean(dataRoot), 'formal_data_root_invalid');
  assertCondition(Boolean(webviewProfile), 'formal_webview_profile_invalid');
  assertCondition(Boolean(evidenceRunDirectory), 'evidence_run_directory_invalid');
  assertCondition(dataRoot.identity !== webviewProfile.identity, 'formal_runtime_paths_not_distinct');
  assertCondition(evidenceRunDirectory.identity !== webviewProfile.identity, 'evidence_profile_paths_not_distinct');
  const identity = {
    buildId,
    dataRoot: dataRoot.normalized,
    webviewProfile: webviewProfile.normalized,
    evidenceRunDirectory: evidenceRunDirectory.normalized,
  };
  return {
    ...identity,
    dataRootMode: 'formal_persistent',
    webviewProfileMode: 'formal_persistent',
    evidenceMode: 'retained_immutable_run',
    fingerprint: fingerprint(identity),
  };
}

function normalizeDocument(raw, label) {
  assertCondition(isPlainObject(raw), `${label}_invalid`);
  const documentPath = normalizedPortablePath(raw.path);
  const name = text(raw.name);
  const sha256 = text(raw.sha256).toLowerCase();
  assertCondition(Boolean(documentPath), `${label}_path_invalid`);
  assertCondition(Boolean(name), `${label}_name_required`);
  const basename = portableBasename(documentPath.normalized);
  const sameName = documentPath.flavor === 'win32'
    ? basename.toLowerCase() === name.toLowerCase()
    : basename === name;
  assertCondition(sameName, `${label}_name_path_mismatch`);
  assertCondition(SHA256_RE.test(sha256), `${label}_sha256_invalid`);
  assertCondition(/\.(?:docx?|wps|pptx?|dps|xlsx?|et|pdf)$/i.test(name), `${label}_extension_invalid`);
  const identity = { name, path: documentPath.normalized, sha256 };
  return { ...identity, documentIdentity: fingerprint(identity) };
}

function normalizeWpsWindow(raw, document) {
  assertCondition(isPlainObject(raw), 'active_wps_window_invalid');
  const application = text(raw.application);
  const processName = text(raw.processName).toLowerCase();
  const processId = Math.trunc(Number(raw.processId));
  const processStartedAt = text(raw.processStartedAt || raw.startedAt);
  const windowTitle = text(raw.windowTitle || raw.title);
  const nativeWindowHandle = text(raw.nativeWindowHandle || raw.hwnd);
  const capturedAt = text(raw.capturedAt || raw.observedAt);
  assertCondition(/^wps(?: office)?$/i.test(application), 'active_wps_application_invalid');
  assertCondition(WPS_PROCESS_RE.test(processName), 'active_wps_process_invalid');
  assertCondition(Number.isInteger(processId) && processId > 0, 'active_wps_pid_invalid');
  assertCondition(validIsoDate(processStartedAt), 'active_wps_process_start_invalid');
  assertCondition(validIsoDate(capturedAt), 'active_wps_capture_time_invalid');
  assertCondition(Date.parse(capturedAt) >= Date.parse(processStartedAt), 'active_wps_time_order_invalid');
  assertCondition(Boolean(windowTitle), 'active_wps_title_required');
  assertCondition(WINDOW_HANDLE_RE.test(nativeWindowHandle), 'active_wps_window_handle_invalid');
  const documentStem = document.name.replace(/\.[^.]+$/u, '').toLowerCase();
  assertCondition(
    windowTitle.toLowerCase().includes(document.name.toLowerCase())
      || (documentStem.length >= 3 && windowTitle.toLowerCase().includes(documentStem)),
    'active_wps_title_document_mismatch',
  );
  const identity = {
    application: 'WPS',
    processName,
    processId,
    processStartedAt: new Date(processStartedAt).toISOString(),
    windowTitle,
    nativeWindowHandle: nativeWindowHandle.toLowerCase(),
    capturedAt: new Date(capturedAt).toISOString(),
    documentIdentity: document.documentIdentity,
  };
  return { ...identity, windowIdentity: fingerprint(identity) };
}

function normalizeTaskBinding(raw, label) {
  assertCondition(isPlainObject(raw), `${label}_invalid`);
  const taskId = text(raw.taskId || raw.id);
  const kind = text(raw.kind);
  assertCondition(Boolean(taskId), `${label}_task_id_required`);
  assertCondition(TASK_KIND_SET.has(kind), `${label}_kind_invalid`, { taskId });
  return { taskId, kind, scope: normalizedScope(raw.scope, `${label}_scope`) };
}

function normalizeBatchBinding(raw) {
  assertCondition(isPlainObject(raw), 'batch_binding_invalid');
  const scope = normalizedScope(raw.scope, 'batch_scope');
  const targetTasks = Array.isArray(raw.targetTasks)
    ? raw.targetTasks.map(item => normalizeTaskBinding(item, 'target_task'))
    : [];
  const protectedTask = normalizeTaskBinding(raw.protectedTask, 'protected_task');
  assertCondition(targetTasks.length >= 2, 'batch_target_count_invalid');
  assertCondition(targetTasks.every(item => sameScope(item.scope, scope)), 'batch_target_scope_mismatch');
  const taskIds = targetTasks.map(item => item.taskId);
  assertCondition(new Set(taskIds).size === taskIds.length, 'batch_target_task_duplicate');
  assertCondition(!taskIds.includes(protectedTask.taskId), 'batch_protected_task_overlap');
  const selectedKinds = [...new Set(targetTasks.map(item => item.kind))].sort();
  const protectedIsOutsideSelection = !sameScope(protectedTask.scope, scope)
    || !selectedKinds.includes(protectedTask.kind);
  assertCondition(protectedIsOutsideSelection, 'batch_protected_task_not_outside_selection');
  const identity = {
    scope,
    targetTasks: [...targetTasks].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    selectedKinds,
    protectedTask,
  };
  return { ...identity, batchIdentity: fingerprint(identity) };
}

function normalizeWpsScenarioBinding(raw) {
  assertCondition(isPlainObject(raw), 'wps_binding_invalid');
  const runtime = normalizeRuntimeBinding(raw.runtime || raw);
  const document = normalizeDocument(raw.document, 'accepted_document');
  const rejectedDocument = normalizeDocument(raw.rejectedDocument, 'rejected_document');
  assertCondition(document.documentIdentity !== rejectedDocument.documentIdentity, 'wps_documents_not_distinct');
  assertCondition(!samePortablePath(document.path, rejectedDocument.path), 'wps_document_paths_not_distinct');
  const activeWpsWindow = normalizeWpsWindow(raw.activeWpsWindow, document);
  const identity = { runtime, activeWpsWindow, rejectedDocument, document };
  return { ...identity, fingerprint: fingerprint(identity) };
}

function normalizeBatchScenarioBinding(raw) {
  assertCondition(isPlainObject(raw), 'runtime_batch_binding_invalid');
  const runtime = normalizeRuntimeBinding(raw.runtime || raw);
  const batch = normalizeBatchBinding(raw.batch || raw);
  const identity = { runtime, batch };
  return { ...identity, fingerprint: fingerprint(identity) };
}

const SCENARIO_DEFINITIONS = Object.freeze([
  {
    scenarioId: FORMAL_WPS_BATCH_SCENARIO_IDS[0],
    title: 'Current WPS document correction, analysis, citation, and visible result',
    objective: 'Bind the real foreground WPS window, reject the wrong document, preserve one task through user correction, analyze only the exact corrected document, and retain a cited final artifact.',
    userSteps: [
      ['activate-current-wps', 'The human opens the intended WPS document and leaves its exact window in the foreground.'],
      ['bind-window-and-document', 'Record the native WPS process/window identity and the exact document path and content hash.'],
      ['observe-wrong-target', 'Retain the initially selected wrong document as rejected evidence; do not analyze it after correction.'],
      ['correct-target', 'The human corrects the document target and supplies the exact file name while the same task remains active.'],
      ['read-exact-document', 'Resolve and read only the corrected document with persisted tool receipts.'],
      ['verify-cited-artifact', 'Retain the analysis artifact, source citations, screenshots, routing, timeline, and visible feedback.'],
      ['human-review', 'A human verifies the active document, same-task correction, citations, and visible final result.'],
    ],
    allowedTools: WPS_ALLOWED_TOOLS,
    requiredReceiptStages: ['active_window_bound', 'corrected_target_resolved', 'document_read'],
    requiredTimelineEvents: WPS_TIMELINE_EVENTS,
    requiredScreenshotStages: WPS_SCREENSHOT_STAGES,
    requiredHumanChecks: WPS_HUMAN_CHECKS,
  },
  {
    scenarioId: FORMAL_WPS_BATCH_SCENARIO_IDS[1],
    title: 'Exact runtime status query and terminal batch cleanup',
    objective: 'Query the unified runtime ledger, cancel exactly the bound task set once, wait for terminal cancellation and lease release, and prove an out-of-scope canary was untouched.',
    userSteps: [
      ['bind-task-set', 'Bind at least two cancellable target tasks and one out-of-scope protected canary.'],
      ['query-before', 'Persist target and protected-canary runtime_work_status receipts before cancellation.'],
      ['cancel-once', 'Invoke runtime_work_cancel exactly once for the bound scope and kinds.'],
      ['wait-terminal', 'Wait until every target is terminally cancelled; a cancelling result is incomplete.'],
      ['verify-leases', 'Prove every target lease and active request pointer was released.'],
      ['query-after', 'Persist target and protected-canary status receipts after cancellation.'],
      ['human-review', 'A human verifies the exact set, canary, lease state, screenshots, and visible feedback.'],
    ],
    allowedTools: ['runtime_work_status', 'runtime_work_cancel'],
    requiredReceiptStages: EVIDENCE_ROUTE_STAGES,
    requiredTimelineEvents: BATCH_TIMELINE_EVENTS,
    requiredScreenshotStages: BATCH_SCREENSHOT_STAGES,
    requiredHumanChecks: BATCH_HUMAN_CHECKS,
  },
]);

function scenarioFromDefinition(definition, binding) {
  return {
    scenarioId: definition.scenarioId,
    title: definition.title,
    status: 'planned',
    result: null,
    binding,
    objective: definition.objective,
    userSteps: definition.userSteps.map(([id, instruction], index) => ({
      id,
      order: index + 1,
      instruction,
      required: true,
      completionEvidence: ['task_id', 'request_id', 'timeline', 'persisted_receipt_or_manual_record'],
    })),
    allowedTools: [...definition.allowedTools],
    requiredReceiptStages: definition.requiredReceiptStages.map(stage => ({
      stage,
      persisted: true,
      realExecutionOnly: true,
    })),
    requiredTimelineEvents: [...definition.requiredTimelineEvents],
    requiredScreenshotStages: [...definition.requiredScreenshotStages],
    requiredHumanChecks: definition.requiredHumanChecks.map(id => ({
      id,
      reviewerType: 'human',
      required: true,
    })),
    requiredEvidenceClasses: [
      'screenshots',
      'tool_receipts',
      'task_timeline',
      'routing',
      'final_artifact',
      'user_visible_feedback',
      'human_confirmation',
    ],
  };
}

export function buildFormalWpsBatchAcceptanceManifest(input = {}) {
  const generatedAt = text(input.generatedAt || new Date().toISOString());
  assertCondition(validIsoDate(generatedAt), 'manifest_generated_at_invalid');
  const raw = input.binding;
  assertCondition(isPlainObject(raw), 'manifest_binding_required');
  const runtime = normalizeRuntimeBinding(raw.runtime || raw);
  const wpsBinding = normalizeWpsScenarioBinding({
    runtime,
    activeWpsWindow: raw.activeWpsWindow,
    rejectedDocument: raw.rejectedDocument,
    document: raw.document,
  });
  const batchBinding = normalizeBatchScenarioBinding({ runtime, batch: raw.batch });
  const manifest = {
    schemaVersion: FORMAL_WPS_BATCH_SCHEMA_VERSION,
    kind: FORMAL_WPS_BATCH_MANIFEST_KIND,
    generatedAt: new Date(generatedAt).toISOString(),
    executionPolicy: {
      mode: 'orchestration_and_validation_only',
      launchClient: false,
      operateWps: false,
      synthesizeResults: false,
      retainEvidence: true,
      defaultOutcome: 'incomplete',
      allScenariosRequired: true,
    },
    runtimeBinding: runtime,
    scenarios: [
      scenarioFromDefinition(SCENARIO_DEFINITIONS[0], wpsBinding),
      scenarioFromDefinition(SCENARIO_DEFINITIONS[1], batchBinding),
    ],
  };
  return { ...manifest, manifestDigest: formalWpsBatchDigest(manifest) };
}

function sameOrderedValues(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function manifestStructureErrors(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['manifest_invalid'];
  if (manifest.schemaVersion !== FORMAL_WPS_BATCH_SCHEMA_VERSION) errors.push('manifest_schema_invalid');
  if (manifest.kind !== FORMAL_WPS_BATCH_MANIFEST_KIND) errors.push('manifest_kind_invalid');
  if (!SHA256_RE.test(text(manifest.manifestDigest))) errors.push('manifest_digest_missing');
  else if (manifest.manifestDigest !== formalWpsBatchDigest(manifest)) errors.push('manifest_digest_mismatch');
  const expectedPolicy = {
    mode: 'orchestration_and_validation_only',
    launchClient: false,
    operateWps: false,
    synthesizeResults: false,
    retainEvidence: true,
    defaultOutcome: 'incomplete',
    allScenariosRequired: true,
  };
  if (stableFormalWpsBatchJson(manifest.executionPolicy) !== stableFormalWpsBatchJson(expectedPolicy)) {
    errors.push('manifest_execution_policy_invalid');
  }
  let runtime;
  try {
    runtime = normalizeRuntimeBinding(manifest.runtimeBinding);
    if (stableFormalWpsBatchJson(runtime) !== stableFormalWpsBatchJson(manifest.runtimeBinding)) {
      errors.push('manifest_runtime_binding_changed');
    }
  } catch (error) {
    errors.push(`manifest:${error.code || 'runtime_binding_invalid'}`);
  }
  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  if (scenarios.length !== SCENARIO_DEFINITIONS.length) errors.push('manifest_scenario_count_invalid');
  for (const [index, definition] of SCENARIO_DEFINITIONS.entries()) {
    const scenario = scenarios.find(item => item?.scenarioId === definition.scenarioId);
    if (!scenario) {
      errors.push(`${definition.scenarioId}:scenario_missing`);
      continue;
    }
    try {
      const binding = index === 0
        ? normalizeWpsScenarioBinding(scenario.binding)
        : normalizeBatchScenarioBinding(scenario.binding);
      const expected = scenarioFromDefinition(definition, binding);
      if (stableFormalWpsBatchJson(scenario) !== stableFormalWpsBatchJson(expected)) {
        errors.push(`${definition.scenarioId}:scenario_definition_changed`);
      }
      if (runtime && binding.runtime.fingerprint !== runtime.fingerprint) {
        errors.push(`${definition.scenarioId}:runtime_binding_mismatch`);
      }
    } catch (error) {
      errors.push(`${definition.scenarioId}:${error.code || 'binding_invalid'}`);
    }
    if (scenario.status !== 'planned' || scenario.result !== null) {
      errors.push(`${definition.scenarioId}:scenario_not_planned`);
    }
    if (!sameOrderedValues(scenario.allowedTools, definition.allowedTools)) {
      errors.push(`${definition.scenarioId}:allowed_tools_changed`);
    }
    if (!sameOrderedValues(
      (scenario.requiredReceiptStages || []).map(item => item?.stage),
      definition.requiredReceiptStages,
    )) errors.push(`${definition.scenarioId}:receipt_stages_changed`);
    if (!sameOrderedValues(scenario.requiredTimelineEvents, definition.requiredTimelineEvents)) {
      errors.push(`${definition.scenarioId}:timeline_events_changed`);
    }
    if (!sameOrderedValues(scenario.requiredScreenshotStages, definition.requiredScreenshotStages)) {
      errors.push(`${definition.scenarioId}:screenshot_stages_changed`);
    }
    if (!sameOrderedValues(
      (scenario.requiredHumanChecks || []).map(item => item?.id),
      definition.requiredHumanChecks,
    )) errors.push(`${definition.scenarioId}:human_checks_changed`);
  }
  return [...new Set(errors)];
}

export function validateFormalWpsBatchAcceptanceManifest(manifest) {
  const errors = manifestStructureErrors(manifest);
  return { ok: errors.length === 0, errors };
}

function createValidationState() {
  return {
    missing: [],
    failures: [],
    addMissing(code) {
      if (!this.missing.includes(code)) this.missing.push(code);
    },
    addFailure(code) {
      if (!this.failures.includes(code)) this.failures.push(code);
    },
  };
}

function sortedUnique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function sameStringSet(left, right) {
  return stableFormalWpsBatchJson(sortedUnique(left)) === stableFormalWpsBatchJson(sortedUnique(right));
}

function parsePayload(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function valueContainsPortablePath(value, targetPath) {
  if (!targetPath) return false;
  if (typeof value === 'string') {
    if (samePortablePath(value, targetPath)) return true;
    const target = normalizedPortablePath(targetPath);
    return Boolean(target && value.toLowerCase().includes(target.normalized.toLowerCase()));
  }
  if (Array.isArray(value)) return value.some(item => valueContainsPortablePath(item, targetPath));
  if (isPlainObject(value)) return Object.values(value).some(item => valueContainsPortablePath(item, targetPath));
  return false;
}

function receiptPayloadSucceeded(payload) {
  if (typeof payload === 'string') return Boolean(payload.trim());
  if (!isPlainObject(payload) && !Array.isArray(payload)) return false;
  if (Array.isArray(payload)) return payload.length > 0;
  if (payload.ok === false) return false;
  const status = text(payload.status).toLowerCase();
  return !['failed', 'error', 'blocked', 'target_mismatch', 'not_found'].includes(status);
}

function validateReceiptBase(receipt, prefix, state, expectedTaskId) {
  if (!isPlainObject(receipt)) {
    state.addMissing(`${prefix}:receipt_missing`);
    return false;
  }
  for (const field of ['receiptId', 'toolName', 'taskId', 'requestId', 'idempotencyKey']) {
    if (!text(receipt[field])) state.addMissing(`${prefix}:${field}_missing`);
  }
  if (expectedTaskId && text(receipt.taskId) !== expectedTaskId) state.addFailure(`${prefix}:task_id_mismatch`);
  if (receipt.persisted !== true) state.addFailure(`${prefix}:not_persisted`);
  if (receipt.terminalVerification?.status !== 'verified') state.addFailure(`${prefix}:terminal_verification_missing`);
  if (!validIsoDate(receipt.startedAt) || !validIsoDate(receipt.completedAt)) {
    state.addMissing(`${prefix}:timestamps_missing`);
  } else if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    state.addFailure(`${prefix}:timestamp_order_invalid`);
  }
  if (receipt.result === undefined || receipt.result === null || receipt.result === '') {
    state.addMissing(`${prefix}:result_missing`);
  }
  return true;
}

function validateTimeline(timeline, requiredEvents, expectedTaskId, prefix, state) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    state.addMissing(`${prefix}:timeline_missing`);
    return new Map();
  }
  const byEvent = new Map();
  const ids = new Set();
  let previousAt = -Infinity;
  let previousRevision = -Infinity;
  for (const [index, event] of timeline.entries()) {
    const eventPrefix = `${prefix}:timeline:${index + 1}`;
    if (!isPlainObject(event)) {
      state.addFailure(`${eventPrefix}:invalid`);
      continue;
    }
    const eventId = text(event.eventId);
    const eventName = text(event.event);
    if (!eventId) state.addMissing(`${eventPrefix}:event_id_missing`);
    else if (ids.has(eventId)) state.addFailure(`${eventPrefix}:event_id_duplicate`);
    else ids.add(eventId);
    if (!eventName) state.addMissing(`${eventPrefix}:event_name_missing`);
    else if (byEvent.has(eventName)) state.addFailure(`${eventPrefix}:event_duplicate`);
    else byEvent.set(eventName, event);
    if (text(event.taskId) !== expectedTaskId) state.addFailure(`${eventPrefix}:task_id_mismatch`);
    if (!text(event.requestId)) state.addMissing(`${eventPrefix}:request_id_missing`);
    if (!validIsoDate(event.at)) state.addMissing(`${eventPrefix}:timestamp_missing`);
    else {
      const at = Date.parse(event.at);
      if (at < previousAt) state.addFailure(`${eventPrefix}:timestamp_not_monotonic`);
      previousAt = at;
    }
    const revision = Number(event.revision);
    if (!Number.isInteger(revision) || revision < 0) state.addMissing(`${eventPrefix}:revision_missing`);
    else {
      if (revision < previousRevision) state.addFailure(`${eventPrefix}:revision_regressed`);
      previousRevision = revision;
    }
  }
  for (const required of requiredEvents) {
    if (!byEvent.has(required)) state.addMissing(`${prefix}:timeline_event_missing:${required}`);
  }
  const positions = requiredEvents.map(required => timeline.findIndex(item => item?.event === required));
  if (positions.every(position => position >= 0)) {
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index] <= positions[index - 1]) {
        state.addFailure(`${prefix}:timeline_event_order_invalid`);
        break;
      }
    }
  }
  return byEvent;
}

function validateHumanChecks(checks, requiredIds, prefix, state) {
  if (!Array.isArray(checks) || checks.length === 0) {
    state.addMissing(`${prefix}:human_confirmation_missing`);
    return;
  }
  for (const id of requiredIds) {
    const check = checks.find(item => item?.id === id);
    if (!check) {
      state.addMissing(`${prefix}:human_check_missing:${id}`);
      continue;
    }
    if (check.status !== 'passed' || check.reviewerType !== 'human') {
      state.addFailure(`${prefix}:human_check_not_passed:${id}`);
    }
    if (!text(check.reviewer) || !validIsoDate(check.checkedAt)) {
      state.addMissing(`${prefix}:human_check_identity_missing:${id}`);
    }
  }
}

function resolveStoredEvidenceFile(runDirectory, storedPath, bucket, prefix, state) {
  const clean = text(storedPath).replace(/\\/gu, '/');
  if (!clean) {
    state.addMissing(`${prefix}:stored_path_missing`);
    return null;
  }
  if (path.posix.isAbsolute(clean) || path.win32.isAbsolute(clean) || clean.split('/').includes('..')) {
    state.addFailure(`${prefix}:stored_path_invalid`);
    return null;
  }
  if (!clean.startsWith(`${bucket}/`)) {
    state.addFailure(`${prefix}:stored_path_wrong_bucket`);
    return null;
  }
  const candidate = path.resolve(runDirectory, ...clean.split('/'));
  const relative = path.relative(path.resolve(runDirectory), candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    state.addFailure(`${prefix}:stored_path_escape`);
    return null;
  }
  let metadata;
  try {
    metadata = fs.lstatSync(candidate);
  } catch {
    state.addMissing(`${prefix}:file_missing`);
    return null;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    state.addFailure(`${prefix}:file_invalid`);
    return null;
  }
  let realRun;
  let realCandidate;
  try {
    realRun = fs.realpathSync.native(path.resolve(runDirectory));
    realCandidate = fs.realpathSync.native(candidate);
  } catch {
    state.addFailure(`${prefix}:realpath_invalid`);
    return null;
  }
  const realRelative = path.relative(realRun, realCandidate);
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    state.addFailure(`${prefix}:realpath_escape`);
    return null;
  }
  return { candidate: realCandidate, metadata };
}

function sha256FileSync(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateIndexedFile(record, options, state) {
  const { runDirectory, bucket, prefix, png = false } = options;
  if (!isPlainObject(record)) {
    state.addMissing(`${prefix}:record_missing`);
    return false;
  }
  if (!SHA256_RE.test(text(record.sha256))) state.addMissing(`${prefix}:sha256_missing`);
  const resolved = resolveStoredEvidenceFile(runDirectory, record.storedPath, bucket, prefix, state);
  if (!resolved) return false;
  if (!Number.isInteger(Number(record.bytes)) || Number(record.bytes) <= 0) {
    state.addMissing(`${prefix}:bytes_missing`);
  } else if (Number(record.bytes) !== resolved.metadata.size) {
    state.addFailure(`${prefix}:size_mismatch`);
  }
  const actualHash = sha256FileSync(resolved.candidate);
  if (actualHash !== text(record.sha256).toLowerCase()) state.addFailure(`${prefix}:sha256_mismatch`);
  if (png) {
    const signature = fs.readFileSync(resolved.candidate).subarray(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (signature.length !== expected.length || !signature.equals(expected)) {
      state.addFailure(`${prefix}:png_signature_invalid`);
    }
  }
  return true;
}

function validateScreenshots(screenshots, requiredStages, runDirectory, taskId, prefix, state) {
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    state.addMissing(`${prefix}:screenshots_missing`);
    return;
  }
  const ids = new Set();
  for (const stage of requiredStages) {
    const screenshot = screenshots.find(item => item?.stage === stage);
    if (!screenshot) {
      state.addMissing(`${prefix}:screenshot_missing:${stage}`);
      continue;
    }
    const id = text(screenshot.id);
    if (!id) state.addMissing(`${prefix}:screenshot_id_missing:${stage}`);
    else if (ids.has(id)) state.addFailure(`${prefix}:screenshot_id_duplicate`);
    else ids.add(id);
    if (text(screenshot.taskId) !== taskId) state.addFailure(`${prefix}:screenshot_task_mismatch:${stage}`);
    if (!validIsoDate(screenshot.capturedAt)) state.addMissing(`${prefix}:screenshot_time_missing:${stage}`);
    validateIndexedFile(screenshot, {
      runDirectory,
      bucket: 'screenshots',
      prefix: `${prefix}:screenshot:${stage}`,
      png: true,
    }, state);
  }
}

function validateRuntimeEvidenceBinding(manifest, evidence, state) {
  if (!isPlainObject(evidence.runtimeBinding)) {
    state.addMissing('evidence:runtime_binding_missing');
    return;
  }
  let normalized;
  try {
    normalized = normalizeRuntimeBinding(evidence.runtimeBinding);
  } catch (error) {
    state.addFailure(`evidence:${error.code || 'runtime_binding_invalid'}`);
    return;
  }
  if (stableFormalWpsBatchJson(normalized) !== stableFormalWpsBatchJson(manifest.runtimeBinding)) {
    state.addFailure('evidence:runtime_binding_mismatch');
  }
}

function validateModelRouting(records, taskId, requestIds, prefix, state) {
  if (!Array.isArray(records) || records.length === 0) {
    state.addMissing(`${prefix}:routing_missing`);
    return;
  }
  const matching = records.filter(item => item?.mode === 'model' && item?.taskId === taskId);
  if (matching.length === 0) {
    state.addMissing(`${prefix}:model_route_missing`);
    return;
  }
  if (!matching.some(item => (
    requestIds.has(text(item.requestId))
    && item.persisted === true
    && item.status === 'succeeded'
    && text(item.selectedProvider)
    && text(item.selectedModel)
    && Array.isArray(item.attempts)
    && item.attempts.some(attempt => attempt?.status === 'succeeded')
    && validIsoDate(item.completedAt)
  ))) state.addFailure(`${prefix}:model_route_not_verified`);
}

function validateDeterministicRouting(records, receipts, taskId, prefix, state) {
  if (!Array.isArray(records) || records.length === 0) {
    state.addMissing(`${prefix}:routing_missing`);
    return;
  }
  for (const receipt of receipts) {
    const route = records.find(item => (
      item?.requestId === receipt.requestId
      && item?.taskId === taskId
      && item?.routeTool === receipt.toolName
    ));
    if (!route) {
      state.addMissing(`${prefix}:deterministic_route_missing:${receipt.stage}`);
      continue;
    }
    if (route.mode !== 'deterministic' || route.modelInvoked !== false || route.persisted !== true || !validIsoDate(route.observedAt)) {
      state.addFailure(`${prefix}:deterministic_route_invalid:${receipt.stage}`);
    }
  }
}

function validateVisibleFeedback(feedback, requirements, prefix, state) {
  const items = Array.isArray(feedback) ? feedback : feedback ? [feedback] : [];
  if (items.length === 0) {
    state.addMissing(`${prefix}:user_visible_feedback_missing`);
    return;
  }
  for (const requirement of requirements) {
    const item = items.find(candidate => candidate?.stage === requirement.stage);
    if (!item) {
      state.addMissing(`${prefix}:feedback_missing:${requirement.stage}`);
      continue;
    }
    if (text(item.taskId) !== requirement.taskId) state.addFailure(`${prefix}:feedback_task_mismatch:${requirement.stage}`);
    if (item.visible !== true || !text(item.messageId) || !text(item.requestId) || !SHA256_RE.test(text(item.contentHash))) {
      state.addMissing(`${prefix}:feedback_evidence_missing:${requirement.stage}`);
    }
    if (item.internalExecutionLeak !== false) state.addFailure(`${prefix}:feedback_internal_leak:${requirement.stage}`);
    if (requirement.statuses && !requirement.statuses.includes(item.status)) {
      state.addFailure(`${prefix}:feedback_status_invalid:${requirement.stage}`);
    }
    if (!validIsoDate(item.at)) state.addMissing(`${prefix}:feedback_time_missing:${requirement.stage}`);
  }
}

function findReceiptByStage(receipts, stage) {
  return receipts.find(item => item?.stage === stage);
}

function validateWpsEvidence(scenario, evidence, state) {
  const prefix = 'wps';
  if (!isPlainObject(evidence)) {
    state.addMissing(`${prefix}:scenario_evidence_missing`);
    return;
  }
  if (text(evidence.bindingFingerprint) !== scenario.binding.fingerprint) {
    state.addFailure(`${prefix}:binding_fingerprint_mismatch`);
  }
  const taskId = text(evidence.taskId);
  if (!taskId) state.addMissing(`${prefix}:task_id_missing`);
  if (!validIsoDate(evidence.startedAt) || !validIsoDate(evidence.completedAt)) {
    state.addMissing(`${prefix}:scenario_timestamps_missing`);
  } else if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
    state.addFailure(`${prefix}:scenario_timestamp_order_invalid`);
  }

  const timeline = validateTimeline(
    evidence.timeline,
    WPS_TIMELINE_EVENTS,
    taskId,
    prefix,
    state,
  );
  const initial = timeline.get('initial_target_selected');
  const correction = timeline.get('target_correction_received');
  const confirmed = timeline.get('target_confirmed');
  const readVerified = timeline.get('document_read_verified');
  if (initial && text(initial.documentIdentity) !== scenario.binding.rejectedDocument.documentIdentity) {
    state.addFailure(`${prefix}:initial_rejected_document_mismatch`);
  }
  if (correction) {
    if (!text(correction.userMessageId)) state.addMissing(`${prefix}:correction_user_message_missing`);
    if (text(correction.fromDocumentIdentity) !== scenario.binding.rejectedDocument.documentIdentity
      || text(correction.toDocumentIdentity) !== scenario.binding.document.documentIdentity) {
      state.addFailure(`${prefix}:correction_document_identity_mismatch`);
    }
    if (initial && Number(correction.revision) <= Number(initial.revision)) {
      state.addFailure(`${prefix}:correction_revision_not_advanced`);
    }
  }
  for (const [name, event] of [['target_confirmed', confirmed], ['document_read_verified', readVerified]]) {
    if (event && text(event.documentIdentity) !== scenario.binding.document.documentIdentity) {
      state.addFailure(`${prefix}:${name}_document_mismatch`);
    }
  }

  if (!isPlainObject(evidence.activeWindowObservation)) {
    state.addMissing(`${prefix}:active_window_observation_missing`);
  } else {
    const observed = evidence.activeWindowObservation;
    if (text(observed.taskId) !== taskId) state.addFailure(`${prefix}:active_window_task_mismatch`);
    if (text(observed.documentIdentity) !== scenario.binding.document.documentIdentity) {
      state.addFailure(`${prefix}:active_window_document_mismatch`);
    }
    const expectedWindow = scenario.binding.activeWpsWindow;
    for (const field of ['application', 'processName', 'processId', 'processStartedAt', 'windowTitle', 'nativeWindowHandle', 'windowIdentity']) {
      if (text(observed[field]).toLowerCase() !== text(expectedWindow[field]).toLowerCase()) {
        state.addFailure(`${prefix}:active_window_${field}_mismatch`);
      }
    }
    if (!validIsoDate(observed.observedAt)) state.addMissing(`${prefix}:active_window_time_missing`);
    if (!text(observed.receiptId) || !text(observed.screenshotId)) {
      state.addMissing(`${prefix}:active_window_evidence_link_missing`);
    }
  }

  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  if (receipts.length === 0) state.addMissing(`${prefix}:tool_receipts_missing`);
  const receiptIds = new Set();
  const idempotencyKeys = new Set();
  for (const [index, receipt] of receipts.entries()) {
    const receiptPrefix = `${prefix}:receipt:${index + 1}`;
    validateReceiptBase(receipt, receiptPrefix, state, taskId);
    const receiptId = text(receipt?.receiptId);
    const key = text(receipt?.idempotencyKey);
    if (receiptId) {
      if (receiptIds.has(receiptId)) state.addFailure(`${prefix}:receipt_id_duplicate`);
      receiptIds.add(receiptId);
    }
    if (key) {
      if (idempotencyKeys.has(key)) state.addFailure(`${prefix}:idempotency_key_duplicate`);
      idempotencyKeys.add(key);
    }
    if (!WPS_ALLOWED_TOOLS.includes(receipt?.toolName)) state.addFailure(`${receiptPrefix}:tool_not_allowed`);
  }
  for (const stage of SCENARIO_DEFINITIONS[0].requiredReceiptStages) {
    if (!findReceiptByStage(receipts, stage)) state.addMissing(`${prefix}:receipt_stage_missing:${stage}`);
  }
  const activeReceipt = findReceiptByStage(receipts, 'active_window_bound');
  if (activeReceipt) {
    if (!['desktop_active_window', 'get_active_window_info'].includes(activeReceipt.toolName)) {
      state.addFailure(`${prefix}:active_window_tool_invalid`);
    }
    const payload = parsePayload(activeReceipt.result);
    if (!isPlainObject(payload) || !receiptPayloadSucceeded(payload)) {
      state.addFailure(`${prefix}:active_window_result_invalid`);
    } else {
      const processName = text(payload.processName || payload.process || payload.executable).toLowerCase();
      const title = text(payload.windowTitle || payload.title || payload.name);
      if (processName !== scenario.binding.activeWpsWindow.processName) state.addFailure(`${prefix}:active_receipt_process_mismatch`);
      if (title !== scenario.binding.activeWpsWindow.windowTitle) state.addFailure(`${prefix}:active_receipt_title_mismatch`);
      const payloadPid = Number(payload.processId || payload.pid || 0);
      if (payloadPid && payloadPid !== scenario.binding.activeWpsWindow.processId) {
        state.addFailure(`${prefix}:active_receipt_pid_mismatch`);
      }
    }
    if (evidence.activeWindowObservation?.receiptId !== activeReceipt.receiptId) {
      state.addFailure(`${prefix}:active_window_receipt_link_mismatch`);
    }
  }
  const resolvedReceipt = findReceiptByStage(receipts, 'corrected_target_resolved');
  if (resolvedReceipt) {
    if (!['search_files', 'desktop_list_files'].includes(resolvedReceipt.toolName)) {
      state.addFailure(`${prefix}:target_resolution_tool_invalid`);
    }
    const expectedDirectory = portableDirname(scenario.binding.document.path);
    const directory = resolvedReceipt.arguments?.directory || resolvedReceipt.arguments?.path;
    if (!samePortablePath(directory, expectedDirectory)) state.addFailure(`${prefix}:target_resolution_directory_mismatch`);
    const payload = parsePayload(resolvedReceipt.result);
    if (!receiptPayloadSucceeded(payload) || !valueContainsPortablePath(payload, scenario.binding.document.path)) {
      state.addFailure(`${prefix}:corrected_target_not_resolved`);
    }
  }
  const readReceipt = findReceiptByStage(receipts, 'document_read');
  if (readReceipt) {
    if (!WPS_READ_TOOLS.has(readReceipt.toolName)) state.addFailure(`${prefix}:document_read_tool_invalid`);
    if (!valueContainsPortablePath(readReceipt.arguments, scenario.binding.document.path)) {
      state.addFailure(`${prefix}:document_read_target_mismatch`);
    }
    if (text(readReceipt.targetDocumentIdentity) !== scenario.binding.document.documentIdentity) {
      state.addFailure(`${prefix}:document_read_identity_mismatch`);
    }
    if (!receiptPayloadSucceeded(parsePayload(readReceipt.result))) state.addFailure(`${prefix}:document_read_result_invalid`);
  }
  if (resolvedReceipt && confirmed && text(confirmed.requestId) !== text(resolvedReceipt.requestId)) {
    state.addFailure(`${prefix}:target_confirmation_receipt_not_linked`);
  }
  if (readReceipt && readVerified && text(readVerified.requestId) !== text(readReceipt.requestId)) {
    state.addFailure(`${prefix}:document_read_timeline_not_linked`);
  }
  if (correction) {
    const correctionTime = Date.parse(correction.at);
    for (const receipt of receipts) {
      if (validIsoDate(receipt?.startedAt)
        && Date.parse(receipt.startedAt) >= correctionTime
        && (valueContainsPortablePath(receipt.arguments, scenario.binding.rejectedDocument.path)
          || text(receipt.targetDocumentIdentity) === scenario.binding.rejectedDocument.documentIdentity)) {
        state.addFailure(`${prefix}:rejected_target_reused_after_correction`);
      }
    }
  }

  const runDirectory = scenario.binding.runtime.evidenceRunDirectory;
  validateScreenshots(evidence.screenshots, WPS_SCREENSHOT_STAGES, runDirectory, taskId, prefix, state);
  const windowScreenshot = evidence.screenshots?.find(item => item?.stage === 'active_wps_bound');
  if (windowScreenshot && evidence.activeWindowObservation?.screenshotId !== windowScreenshot.id) {
    state.addFailure(`${prefix}:active_window_screenshot_link_mismatch`);
  }

  const artifact = evidence.artifact;
  if (!isPlainObject(artifact)) {
    state.addMissing(`${prefix}:final_artifact_missing`);
  } else {
    if (!text(artifact.id) || artifact.kind !== 'analysis_report') state.addFailure(`${prefix}:artifact_identity_invalid`);
    if (text(artifact.taskId) !== taskId) state.addFailure(`${prefix}:artifact_task_mismatch`);
    if (text(artifact.sourceDocumentIdentity) !== scenario.binding.document.documentIdentity) {
      state.addFailure(`${prefix}:artifact_source_mismatch`);
    }
    validateIndexedFile(artifact, {
      runDirectory,
      bucket: 'artifacts',
      prefix: `${prefix}:artifact`,
    }, state);
    const artifactReceiptIds = Array.isArray(artifact.receiptIds) ? artifact.receiptIds : [];
    if (!readReceipt || !artifactReceiptIds.includes(readReceipt.receiptId)) {
      state.addFailure(`${prefix}:artifact_read_receipt_missing`);
    }
  }

  const references = Array.isArray(evidence.references) ? evidence.references : [];
  if (references.length === 0) state.addMissing(`${prefix}:citations_missing`);
  const referenceIds = new Set();
  for (const [index, reference] of references.entries()) {
    const referencePrefix = `${prefix}:reference:${index + 1}`;
    const id = text(reference?.id);
    if (!id) state.addMissing(`${referencePrefix}:id_missing`);
    else if (referenceIds.has(id)) state.addFailure(`${referencePrefix}:id_duplicate`);
    else referenceIds.add(id);
    if (text(reference?.documentIdentity) !== scenario.binding.document.documentIdentity) {
      state.addFailure(`${referencePrefix}:document_mismatch`);
    }
    if (!text(reference?.locator) || !SHA256_RE.test(text(reference?.contentHash))) {
      state.addMissing(`${referencePrefix}:locator_or_hash_missing`);
    }
    if (!readReceipt || text(reference?.receiptId) !== readReceipt.receiptId) {
      state.addFailure(`${referencePrefix}:read_receipt_mismatch`);
    }
  }
  if (artifact && !sameStringSet(artifact.referenceIds || [], [...referenceIds])) {
    state.addFailure(`${prefix}:artifact_reference_set_mismatch`);
  }
  const requestIds = new Set(receipts.map(receipt => text(receipt.requestId)).filter(Boolean));
  validateModelRouting(evidence.routing, taskId, requestIds, prefix, state);
  validateVisibleFeedback(evidence.userFeedback, [{
    stage: 'final_result',
    taskId,
    statuses: ['completed'],
  }], prefix, state);
  const finalFeedback = Array.isArray(evidence.userFeedback)
    ? evidence.userFeedback.find(item => item?.stage === 'final_result')
    : evidence.userFeedback;
  if (finalFeedback) {
    if (text(finalFeedback.artifactId) !== text(artifact?.id)) state.addFailure(`${prefix}:feedback_artifact_mismatch`);
    if (!sameStringSet(finalFeedback.referenceIds || [], [...referenceIds])) {
      state.addFailure(`${prefix}:feedback_reference_set_mismatch`);
    }
  }
  validateHumanChecks(evidence.manualChecks, WPS_HUMAN_CHECKS, prefix, state);
}

function normalizeRuntimeItemProjection(item) {
  if (!isPlainObject(item)) return null;
  return {
    id: text(item.id),
    kind: text(item.kind),
    status: text(item.status),
    phase: text(item.phase),
    updatedAt: text(item.updatedAt),
    cancellationRequested: item.cancellationRequested === true,
    pauseRequested: item.pauseRequested === true,
    scope: item.scope,
    progress: item.progress,
    controls: item.controls,
    evidence: item.evidence,
  };
}

function statusReceiptPayload(receipt, stage, expectedScope, state) {
  const prefix = `batch:${stage}`;
  if (!receipt) return null;
  if (receipt.toolName !== 'runtime_work_status') state.addFailure(`${prefix}:tool_invalid`);
  const payload = parsePayload(receipt.result);
  if (!isPlainObject(payload) || payload.ok !== true || payload.degraded === true || !Array.isArray(payload.items)) {
    state.addFailure(`${prefix}:status_payload_invalid`);
    return null;
  }
  if (!sameScope(payload.scope, expectedScope)) state.addFailure(`${prefix}:scope_mismatch`);
  if (Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0) state.addFailure(`${prefix}:diagnostics_present`);
  if (payload.items.length >= 50) state.addFailure(`${prefix}:snapshot_not_exhaustive`);
  if (!validIsoDate(payload.observedAt)) state.addMissing(`${prefix}:observed_at_missing`);
  return payload;
}

function validateBatchReceiptArgs(receipt, scenario, stage, state) {
  const expectedKinds = stage.includes('protected')
    ? [scenario.binding.batch.protectedTask.kind]
    : scenario.binding.batch.selectedKinds;
  const actualKinds = Array.isArray(receipt?.arguments?.kinds) ? receipt.arguments.kinds : [];
  if (!sameStringSet(actualKinds, expectedKinds)) state.addFailure(`batch:${stage}:kinds_mismatch`);
  if (receipt?.arguments?.taskId) state.addFailure(`batch:${stage}:unexpected_task_id_filter`);
}

function findRuntimeItem(payload, taskId) {
  return payload?.items?.find(item => text(item?.id) === taskId);
}

function validateLeaseSnapshots(snapshots, targetTaskIds, cancelCompletedAt, state) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    state.addMissing('batch:lease_snapshots_missing');
    return;
  }
  for (const taskId of targetTaskIds) {
    const snapshot = snapshots.find(item => item?.taskId === taskId);
    if (!snapshot) {
      state.addMissing(`batch:lease_snapshot_missing:${taskId}`);
      continue;
    }
    if (!isPlainObject(snapshot.before) || !isPlainObject(snapshot.after)) {
      state.addMissing(`batch:lease_state_missing:${taskId}`);
      continue;
    }
    if (!['runtime_task', 'conversation_action_turn', 'background_worker'].includes(text(snapshot.leaseType))) {
      state.addFailure(`batch:lease_type_invalid:${taskId}`);
    }
    if (!validIsoDate(snapshot.before.observedAt) || !validIsoDate(snapshot.after.observedAt)) {
      state.addMissing(`batch:lease_timestamp_missing:${taskId}`);
    } else {
      if (Date.parse(snapshot.after.observedAt) < Date.parse(snapshot.before.observedAt)) {
        state.addFailure(`batch:lease_timestamp_order_invalid:${taskId}`);
      }
      if (cancelCompletedAt && Date.parse(snapshot.after.observedAt) < Date.parse(cancelCompletedAt)) {
        state.addFailure(`batch:lease_observed_before_cancel_finished:${taskId}`);
      }
    }
    const after = snapshot.after;
    if (after.released !== true
      || text(after.leaseOwnerId)
      || text(after.leaseEpoch)
      || text(after.activeRequestId)
      || text(after.status) !== 'cancelled') {
      state.addFailure(`batch:lease_not_released:${taskId}`);
    }
    if (!validIsoDate(after.releasedAt)) state.addMissing(`batch:lease_release_time_missing:${taskId}`);
  }
  const observedIds = snapshots.map(item => text(item?.taskId)).filter(Boolean);
  if (!sameStringSet(observedIds, targetTaskIds)) state.addFailure('batch:lease_snapshot_set_mismatch');
}

function validateBatchEvidence(scenario, evidence, state) {
  const prefix = 'batch';
  if (!isPlainObject(evidence)) {
    state.addMissing(`${prefix}:scenario_evidence_missing`);
    return;
  }
  if (text(evidence.bindingFingerprint) !== scenario.binding.fingerprint) {
    state.addFailure(`${prefix}:binding_fingerprint_mismatch`);
  }
  const taskId = text(evidence.controlTaskId);
  if (!taskId) state.addMissing(`${prefix}:control_task_id_missing`);
  if (!validIsoDate(evidence.startedAt) || !validIsoDate(evidence.completedAt)) {
    state.addMissing(`${prefix}:scenario_timestamps_missing`);
  } else if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
    state.addFailure(`${prefix}:scenario_timestamp_order_invalid`);
  }
  const timeline = validateTimeline(evidence.timeline, BATCH_TIMELINE_EVENTS, taskId, prefix, state);

  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  if (receipts.length === 0) state.addMissing(`${prefix}:tool_receipts_missing`);
  const receiptIds = new Set();
  const idempotencyKeys = new Set();
  const executionFingerprints = new Set();
  for (const [index, receipt] of receipts.entries()) {
    const receiptPrefix = `${prefix}:receipt:${index + 1}`;
    validateReceiptBase(receipt, receiptPrefix, state, taskId);
    if (!SCENARIO_DEFINITIONS[1].allowedTools.includes(receipt?.toolName)) state.addFailure(`${receiptPrefix}:tool_not_allowed`);
    const receiptId = text(receipt?.receiptId);
    const key = text(receipt?.idempotencyKey);
    if (receiptId) {
      if (receiptIds.has(receiptId)) state.addFailure(`${prefix}:receipt_id_duplicate`);
      receiptIds.add(receiptId);
    }
    if (key) {
      if (idempotencyKeys.has(key)) state.addFailure(`${prefix}:idempotency_key_duplicate`);
      idempotencyKeys.add(key);
    }
    const executionFingerprint = fingerprint({
      toolName: receipt?.toolName,
      requestId: receipt?.requestId,
      arguments: receipt?.arguments,
    });
    if (executionFingerprints.has(executionFingerprint)) state.addFailure(`${prefix}:duplicate_tool_execution`);
    executionFingerprints.add(executionFingerprint);
  }
  for (const stage of EVIDENCE_ROUTE_STAGES) {
    if (!findReceiptByStage(receipts, stage)) state.addMissing(`${prefix}:receipt_stage_missing:${stage}`);
  }
  if (receipts.length !== EVIDENCE_ROUTE_STAGES.length
    || !sameStringSet(receipts.map(item => item?.stage), EVIDENCE_ROUTE_STAGES)) {
    state.addFailure(`${prefix}:receipt_stage_set_not_exact`);
  }
  const cancelReceipts = receipts.filter(item => item?.toolName === 'runtime_work_cancel');
  if (cancelReceipts.length === 0) state.addMissing(`${prefix}:cancel_receipt_missing`);
  else if (cancelReceipts.length !== 1) state.addFailure(`${prefix}:cancel_tool_not_exactly_once`);

  const beforeTargetsReceipt = findReceiptByStage(receipts, 'before_targets');
  const beforeProtectedReceipt = findReceiptByStage(receipts, 'before_protected');
  const cancelReceipt = findReceiptByStage(receipts, 'cancel_targets');
  const afterTargetsReceipt = findReceiptByStage(receipts, 'after_targets');
  const afterProtectedReceipt = findReceiptByStage(receipts, 'after_protected');
  const timelineReceiptLinks = [
    ['target_status_observed', beforeTargetsReceipt],
    ['protected_canary_observed', beforeProtectedReceipt],
    ['batch_cancel_requested', cancelReceipt],
    ['batch_cancel_verified', cancelReceipt],
    ['target_status_rechecked', afterTargetsReceipt],
    ['protected_canary_rechecked', afterProtectedReceipt],
  ];
  for (const [eventName, receiptRecord] of timelineReceiptLinks) {
    const event = timeline.get(eventName);
    if (event && receiptRecord && text(event.requestId) !== text(receiptRecord.requestId)) {
      state.addFailure(`${prefix}:timeline_receipt_not_linked:${eventName}`);
    }
  }
  for (const [stage, receipt] of [
    ['before_targets', beforeTargetsReceipt],
    ['before_protected', beforeProtectedReceipt],
    ['cancel_targets', cancelReceipt],
    ['after_targets', afterTargetsReceipt],
    ['after_protected', afterProtectedReceipt],
  ]) {
    if (receipt) validateBatchReceiptArgs(receipt, scenario, stage, state);
  }
  const targetScope = scenario.binding.batch.scope;
  const protectedScope = scenario.binding.batch.protectedTask.scope;
  const beforeTargets = statusReceiptPayload(beforeTargetsReceipt, 'before_targets', targetScope, state);
  const beforeProtected = statusReceiptPayload(beforeProtectedReceipt, 'before_protected', protectedScope, state);
  const afterTargets = statusReceiptPayload(afterTargetsReceipt, 'after_targets', targetScope, state);
  const afterProtected = statusReceiptPayload(afterProtectedReceipt, 'after_protected', protectedScope, state);
  const targetTaskIds = scenario.binding.batch.targetTasks.map(item => item.taskId);
  if (beforeTargets) {
    const cancelableIds = beforeTargets.items
      .filter(item => item?.controls?.canCancel === true && scenario.binding.batch.selectedKinds.includes(text(item?.kind)))
      .map(item => text(item.id));
    if (!sameStringSet(cancelableIds, targetTaskIds)) state.addFailure(`${prefix}:before_target_set_not_exact`);
    for (const expected of scenario.binding.batch.targetTasks) {
      const item = findRuntimeItem(beforeTargets, expected.taskId);
      if (!item) state.addMissing(`${prefix}:before_target_missing:${expected.taskId}`);
      else if (text(item.kind) !== expected.kind || !sameScope(item.scope, expected.scope) || item.controls?.canCancel !== true) {
        state.addFailure(`${prefix}:before_target_invalid:${expected.taskId}`);
      }
    }
  }
  const protectedTaskId = scenario.binding.batch.protectedTask.taskId;
  const protectedBeforeItem = beforeProtected ? findRuntimeItem(beforeProtected, protectedTaskId) : null;
  if (beforeProtected && !protectedBeforeItem) state.addMissing(`${prefix}:protected_before_missing`);
  if (protectedBeforeItem) {
    if (text(protectedBeforeItem.kind) !== scenario.binding.batch.protectedTask.kind
      || !sameScope(protectedBeforeItem.scope, protectedScope)) {
      state.addFailure(`${prefix}:protected_before_identity_mismatch`);
    }
  }

  if (cancelReceipt) {
    if (cancelReceipt.toolName !== 'runtime_work_cancel') state.addFailure(`${prefix}:cancel_stage_tool_invalid`);
    const payload = parsePayload(cancelReceipt.result);
    if (!isPlainObject(payload)
      || payload.ok !== true
      || payload.status !== 'cancelled'
      || Number(payload.matchedCount) !== targetTaskIds.length
      || Number(payload.cancelledCount) !== targetTaskIds.length
      || Number(payload.cancellingCount) !== 0
      || Number(payload.failedCount) !== 0
      || !Array.isArray(payload.items)) {
      state.addFailure(`${prefix}:cancel_not_terminally_verified`);
    } else {
      const cancelledIds = payload.items.map(item => text(item?.id));
      if (!sameStringSet(cancelledIds, targetTaskIds)) state.addFailure(`${prefix}:cancelled_task_set_mismatch`);
      if (cancelledIds.includes(protectedTaskId)) state.addFailure(`${prefix}:protected_task_cancelled`);
      for (const item of payload.items) {
        if (item?.phase !== 'cancelled' || item?.cancellationRequested !== true) {
          state.addFailure(`${prefix}:cancel_result_not_terminal:${text(item?.id)}`);
        }
      }
    }
    if (valueContainsPortablePath(cancelReceipt.arguments, protectedTaskId)
      || JSON.stringify(cancelReceipt.arguments || {}).includes(protectedTaskId)) {
      state.addFailure(`${prefix}:protected_task_in_cancel_arguments`);
    }
  }
  if (afterTargets) {
    for (const targetTaskId of targetTaskIds) {
      const item = findRuntimeItem(afterTargets, targetTaskId);
      if (!item) state.addMissing(`${prefix}:after_target_missing:${targetTaskId}`);
      else if (item.phase !== 'cancelled'
        || item.cancellationRequested !== true
        || item.controls?.canCancel !== false
        || item.controls?.canPause !== false
        || item.controls?.canResume !== false) {
        state.addFailure(`${prefix}:after_target_not_cancelled:${targetTaskId}`);
      }
    }
    const stillActive = afterTargets.items.filter(item => (
      targetTaskIds.includes(text(item?.id)) && !TERMINAL_PHASE_SET.has(text(item?.phase))
    ));
    if (stillActive.length > 0) state.addFailure(`${prefix}:target_still_active_after_cleanup`);
  }
  const protectedAfterItem = afterProtected ? findRuntimeItem(afterProtected, protectedTaskId) : null;
  if (afterProtected && !protectedAfterItem) state.addMissing(`${prefix}:protected_after_missing`);
  if (protectedBeforeItem && protectedAfterItem) {
    const beforeProjection = normalizeRuntimeItemProjection(protectedBeforeItem);
    const afterProjection = normalizeRuntimeItemProjection(protectedAfterItem);
    if (stableFormalWpsBatchJson(beforeProjection) !== stableFormalWpsBatchJson(afterProjection)) {
      state.addFailure(`${prefix}:protected_task_changed`);
    }
  }

  validateLeaseSnapshots(evidence.leaseSnapshots, targetTaskIds, cancelReceipt?.completedAt, state);
  const runDirectory = scenario.binding.runtime.evidenceRunDirectory;
  validateScreenshots(evidence.screenshots, BATCH_SCREENSHOT_STAGES, runDirectory, taskId, prefix, state);
  validateDeterministicRouting(evidence.routing, receipts, taskId, prefix, state);
  validateVisibleFeedback(evidence.userFeedback, [
    { stage: 'status_before', taskId, statuses: ['active'] },
    { stage: 'cleanup_result', taskId, statuses: ['cancelled'] },
    { stage: 'status_after', taskId, statuses: ['idle', 'attention', 'paused'] },
  ], prefix, state);
  validateHumanChecks(evidence.manualChecks, BATCH_HUMAN_CHECKS, prefix, state);
  if (!isPlainObject(evidence.artifact)) {
    state.addMissing(`${prefix}:final_artifact_missing`);
  } else {
    const artifact = evidence.artifact;
    if (artifact.kind !== 'runtime_cleanup_report' || text(artifact.taskId) !== taskId) {
      state.addFailure(`${prefix}:artifact_identity_invalid`);
    }
    if (!sameStringSet(artifact.cancelledTaskIds || [], targetTaskIds)
      || text(artifact.protectedTaskId) !== protectedTaskId
      || artifact.protectedTaskUnchanged !== true
      || artifact.leasesReleased !== true) {
      state.addFailure(`${prefix}:artifact_result_mismatch`);
    }
    validateIndexedFile(artifact, {
      runDirectory,
      bucket: 'artifacts',
      prefix: `${prefix}:artifact`,
    }, state);
    const artifactReceiptIds = Array.isArray(artifact.receiptIds) ? artifact.receiptIds : [];
    if (!sameStringSet(artifactReceiptIds, receipts.map(item => item.receiptId))) {
      state.addFailure(`${prefix}:artifact_receipt_set_mismatch`);
    }
  }
}

export function validateFormalWpsBatchAcceptanceEvidence(manifest, evidence) {
  const manifestErrors = manifestStructureErrors(manifest);
  if (manifestErrors.length > 0) {
    return {
      ok: false,
      status: 'failed',
      packageComplete: false,
      filesystemVerified: false,
      runtimeProvenanceVerified: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      missing: [],
      failures: manifestErrors.map(code => `manifest:${code}`),
      errors: manifestErrors.map(code => `manifest:${code}`),
    };
  }
  const state = createValidationState();
  if (!isPlainObject(evidence)) {
    state.addMissing('evidence:envelope_missing');
  } else {
    if (evidence.schemaVersion !== FORMAL_WPS_BATCH_SCHEMA_VERSION) state.addFailure('evidence:schema_invalid');
    if (evidence.kind !== FORMAL_WPS_BATCH_EVIDENCE_KIND) state.addFailure('evidence:kind_invalid');
    if (text(evidence.manifestDigest) !== manifest.manifestDigest) state.addFailure('evidence:manifest_digest_mismatch');
    if (!validIsoDate(evidence.completedAt)) state.addMissing('evidence:completed_at_missing');
    validateRuntimeEvidenceBinding(manifest, evidence, state);
    const scenarios = Array.isArray(evidence.scenarios) ? evidence.scenarios : [];
    if (scenarios.length === 0) state.addMissing('evidence:scenarios_missing');
    const wps = scenarios.find(item => item?.scenarioId === FORMAL_WPS_BATCH_SCENARIO_IDS[0]);
    const batch = scenarios.find(item => item?.scenarioId === FORMAL_WPS_BATCH_SCENARIO_IDS[1]);
    validateWpsEvidence(manifest.scenarios[0], wps, state);
    validateBatchEvidence(manifest.scenarios[1], batch, state);
    const unknown = scenarios.filter(item => !FORMAL_WPS_BATCH_SCENARIO_IDS.includes(item?.scenarioId));
    if (unknown.length > 0) state.addFailure('evidence:unknown_scenarios_present');
    if (scenarios.length !== FORMAL_WPS_BATCH_SCENARIO_IDS.length) {
      state.addFailure('evidence:scenario_count_invalid');
    }
  }
  const failures = [...state.failures];
  const missing = [...state.missing];
  const ok = failures.length === 0 && missing.length === 0;
  return {
    ok,
    status: ok ? 'evidence_package_complete' : failures.length > 0 ? 'failed' : 'incomplete',
    packageComplete: ok,
    filesystemVerified: ok,
    runtimeProvenanceVerified: false,
    acceptanceDecision: 'not_adjudicated',
    acceptancePassed: false,
    missing,
    failures,
    errors: [...failures, ...missing],
  };
}

function parseArgs(argv) {
  const command = text(argv[0]);
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = text(argv[index]);
    const value = argv[index + 1];
    assertCondition(flag.startsWith('--') && value !== undefined, 'cli_argument_invalid');
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function readJsonFile(filePath, code) {
  const absolute = path.resolve(text(filePath));
  assertCondition(Boolean(filePath) && path.isAbsolute(text(filePath)), code);
  try {
    const metadata = fs.lstatSync(absolute);
    assertCondition(metadata.isFile() && !metadata.isSymbolicLink(), code);
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    if (error instanceof FormalWpsBatchAcceptanceError) throw error;
    throw new FormalWpsBatchAcceptanceError(code, { cause: error?.message });
  }
}

function emitJson(value, outputPath) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  assertCondition(path.isAbsolute(text(outputPath)), 'output_path_must_be_absolute');
  const absolute = path.resolve(text(outputPath));
  assertCondition(!fs.existsSync(absolute), 'output_already_exists');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, serialized, { encoding: 'utf8', flag: 'wx' });
}

export function formalWpsBatchEvidenceCliExitCode(result) {
  return formalStage9ProducerEvidenceExitCode(result);
}

export async function createWpsFormalStage9ProducerEvidence(options = {}) {
  return createFormalStage9FileBackedProducerEvidence({
    ...options,
    producer: 'wps',
    payload: options.payload || options.result,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'manifest') {
    const raw = readJsonFile(options.binding, 'binding_file_invalid');
    const manifest = buildFormalWpsBatchAcceptanceManifest({
      binding: raw.binding || raw,
      generatedAt: raw.generatedAt,
    });
    emitJson(manifest, options.output);
    // A manifest is a complete planning artifact, not an acceptance decision.
    process.exitCode = 2;
    return;
  }
  if (command === 'validate') {
    const manifest = readJsonFile(options.manifest, 'manifest_file_invalid');
    const evidence = readJsonFile(options.evidence, 'evidence_file_invalid');
    const result = validateFormalWpsBatchAcceptanceEvidence(manifest, evidence);
    emitJson(result, options.output);
    // Caller-authored evidence can be structurally complete, but cannot prove
    // a real authenticated WPS/runtime session or adjudicate Stage 9 by itself.
    process.exitCode = formalWpsBatchEvidenceCliExitCode(result);
    return;
  }
  throw new FormalWpsBatchAcceptanceError(
    'usage: manifest --binding <absolute-json> [--output <new-json>] | validate --manifest <absolute-json> --evidence <absolute-json> [--output <new-json>]',
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`[formal-wps-batch-acceptance] ${error.code || error.message}\n`);
    process.exitCode = 1;
  });
}
