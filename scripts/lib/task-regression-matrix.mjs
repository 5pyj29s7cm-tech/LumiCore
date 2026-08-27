import crypto from 'node:crypto';

export const TASK_TRUTH_SNAPSHOT_KIND = 'lumi.task-truth-snapshot';
export const TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION = 1;
export const CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND = 'lumi.control-sequence-truth-snapshot';
export const CONTROL_SEQUENCE_TRUTH_SNAPSHOT_SCHEMA_VERSION = 1;
export const TASK_REGRESSION_BUILD_IDENTITY_KIND = 'lumi.task-regression-build-identity';
export const TASK_REGRESSION_RUN_KIND = 'lumi.task-regression-run';
export const TASK_REGRESSION_RUN_SCHEMA_VERSION = 1;
export const TASK_REGRESSION_COMPARISON_KIND = 'lumi.task-regression-comparison';
export const TASK_REGRESSION_COMPARISON_SCHEMA_VERSION = 1;

const SHA256_PATTERN = '^[a-f0-9]{64}$';
const REVISION_PATTERN = '^(?:[a-f0-9]{40}|[a-f0-9]{64})$';
const SHA256_RE = new RegExp(SHA256_PATTERN, 'u');
const REVISION_RE = new RegExp(REVISION_PATTERN, 'u');
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const TASK_STATUSES = Object.freeze([
  'created',
  'planning',
  'executing',
  'waiting_confirmation',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'blocked',
]);

export const TASK_TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

// `blocked` settles the current request and must release its execution lease,
// but the durable task remains resumable.  Its live conversation focus may be
// retained so a correction/continue turn can bind to the same task.  Treating
// it as a terminal task here made the acceptance validator reject the exact
// recovery state the runtime is designed to preserve.

export const TASK_REQUEST_STATUSES = Object.freeze([
  'created',
  'running',
  'waiting_confirmation',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);

export const TASK_RECEIPT_STATUSES = Object.freeze([
  'planned',
  'running',
  'waiting_confirmation',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);

const REQUIRED_EVIDENCE = Object.freeze([
  'user_visible_reply',
  'task',
  'pending_pointer',
  'live_pointer',
  'request',
  'receipt',
  'tool_target',
  'model_actual_input',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const TASK_REGRESSION_SCENARIOS = deepFreeze([
  {
    ordinal: 1,
    id: 'cleanup_offer_then_cleanup',
    title: 'Assistant cleanup offer followed by a cleanup request',
    turns: [
      { actor: 'assistant', intent: 'offer_cleanup' },
      { actor: 'user', text: '清理一下', intent: 'continue_cleanup_offer' },
    ],
    checks: [
      'proposal_bound_to_cleanup',
      'cleanup_tool_executed',
      'terminal_feedback_truthful',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 2,
    id: 'repeated_confirmation_exactly_once',
    title: 'Repeated confirmation resumes the exact pending action once',
    turns: [
      { actor: 'assistant', intent: 'request_confirmation' },
      { actor: 'user', text: '确认', intent: 'confirm' },
      { actor: 'user', text: '确认了', intent: 'repeat_confirmation' },
    ],
    checks: [
      'pending_action_preserved',
      'confirmation_resumed_exact_action',
      'action_executed_exactly_once',
      'duplicate_confirmation_idempotent',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 3,
    id: 'wps_wrong_file_correction',
    title: 'WPS current-file analysis survives wrong-target correction and filename supplementation',
    turns: [
      { actor: 'user', intent: 'analyze_current_wps_file' },
      { actor: 'user', intent: 'correct_wrong_file' },
      { actor: 'user', intent: 'supply_filename' },
    ],
    checks: [
      'current_wps_document_anchored',
      'wrong_target_rejected',
      'correction_preserved',
      'supplemental_filename_bound',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 4,
    id: 'displayed_result_stale_receipt',
    title: 'A displayed tool result remains usable when an old receipt becomes stale',
    turns: [
      { actor: 'assistant', intent: 'display_tool_result' },
      { actor: 'system', intent: 'observe_stale_receipt' },
    ],
    checks: [
      'displayed_result_receipt_bound',
      'stale_receipt_archived',
      'stale_receipt_did_not_block_cleanup',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 5,
    id: 'control_stop_status_repeat',
    title: 'Stop, status, and repeat controls target the live task and last answer',
    turns: [
      { actor: 'user', text: '停止', intent: 'cancel' },
      { actor: 'user', text: '你在干嘛', intent: 'status_after_cancel' },
      { actor: 'user', text: '怎么说', intent: 'repeat' },
    ],
    checks: [
      'cancel_bypassed_busy_gate',
      'status_reflected_target_task_terminal',
      'repeat_used_last_assistant_answer',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 6,
    id: 'voice_to_text_continuation',
    title: 'A voice-started task continues through a text turn',
    turns: [
      { actor: 'user', channel: 'voice', intent: 'start_task' },
      { actor: 'user', channel: 'text', intent: 'continue_task' },
    ],
    checks: [
      'voice_turn_bound_to_task',
      'text_turn_continued_same_task',
      'context_continuity_preserved',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 7,
    id: 'mid_task_restart_recovery',
    title: 'A task survives a client or backend restart',
    turns: [
      { actor: 'user', intent: 'start_task' },
      { actor: 'system', intent: 'restart_client_or_backend' },
      { actor: 'user', intent: 'continue_task' },
    ],
    checks: [
      'restart_recovered_same_task',
      'lease_released_or_recovered',
      'live_pointer_rebound',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
  {
    ordinal: 8,
    id: 'primary_model_failover_lmstudio',
    title: 'Primary model failure falls back to LM Studio and continues the same task',
    turns: [
      { actor: 'user', intent: 'start_task' },
      { actor: 'system', intent: 'fail_primary_model' },
      { actor: 'system', intent: 'select_lmstudio' },
      { actor: 'user', intent: 'continue_task' },
    ],
    checks: [
      'primary_failure_recorded',
      'lmstudio_selected',
      'same_task_continued',
      'final_feedback_truthful',
    ],
    requiredEvidence: REQUIRED_EVIDENCE,
  },
]);

const SCENARIO_BY_ID = new Map(TASK_REGRESSION_SCENARIOS.map(scenario => [scenario.id, scenario]));
export const TASK_REGRESSION_SCENARIO_IDS = Object.freeze(TASK_REGRESSION_SCENARIOS.map(({ id }) => id));

const pointerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'taskId', 'requestId', 'recordId', 'observedAt'],
  properties: {
    state: { enum: ['set', 'cleared'] },
    taskId: { type: ['string', 'null'] },
    requestId: { type: ['string', 'null'] },
    recordId: { type: 'string', minLength: 1 },
    observedAt: { type: 'string', format: 'date-time' },
  },
};

export const TASK_TRUTH_SNAPSHOT_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lumicore.local/schemas/task-truth-snapshot.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind', 'schemaVersion', 'snapshotId', 'scenarioId', 'acceptanceRunId', 'capturedAt',
    'buildIdentityDigest', 'userVisibleReply', 'task', 'pointers', 'request', 'receipt',
    'toolTarget', 'modelActualInput',
  ],
  properties: {
    kind: { const: TASK_TRUTH_SNAPSHOT_KIND },
    schemaVersion: { const: TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION },
    snapshotId: { type: 'string', minLength: 1 },
    scenarioId: { enum: TASK_REGRESSION_SCENARIO_IDS },
    acceptanceRunId: { type: 'string', minLength: 1 },
    capturedAt: { type: 'string', format: 'date-time' },
    buildIdentityDigest: { type: 'string', pattern: SHA256_PATTERN },
    userVisibleReply: {
      type: 'object', additionalProperties: false,
      required: ['messageId', 'text', 'recordedAt'],
      properties: {
        messageId: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    },
    task: {
      type: 'object', additionalProperties: false,
      required: ['recordId', 'taskId', 'status', 'goal', 'updatedAt'],
      properties: {
        recordId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        status: { enum: TASK_STATUSES },
        goal: { type: 'string', minLength: 1 },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    pointers: {
      type: 'object', additionalProperties: false,
      required: ['pending', 'live'],
      properties: { pending: pointerSchema, live: pointerSchema },
    },
    request: {
      type: 'object', additionalProperties: false,
      required: ['recordId', 'requestId', 'taskId', 'status', 'recordedAt'],
      properties: {
        recordId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        status: { enum: TASK_REQUEST_STATUSES },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    },
    receipt: {
      type: 'object', additionalProperties: false,
      required: ['recordId', 'receiptId', 'requestId', 'taskId', 'status', 'toolName', 'recordedAt'],
      properties: {
        recordId: { type: 'string', minLength: 1 },
        receiptId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        status: { enum: TASK_RECEIPT_STATUSES },
        toolName: { type: 'string', minLength: 1 },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    },
    toolTarget: {
      type: 'object', additionalProperties: false,
      required: [
        'recordId', 'requestId', 'taskId', 'toolName', 'targetType', 'targetId',
        'displayName', 'source', 'normalizedTargetSha256', 'recordedAt',
      ],
      properties: {
        recordId: { type: 'string', minLength: 1 },
        requestId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        toolName: { type: 'string', minLength: 1 },
        targetType: { type: 'string', minLength: 1 },
        targetId: { type: 'string', minLength: 1 },
        displayName: { type: 'string', minLength: 1 },
        source: { type: 'string', minLength: 1 },
        normalizedTargetSha256: { type: 'string', pattern: SHA256_PATTERN },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    },
    modelActualInput: {
      oneOf: [{
        type: 'object', additionalProperties: false,
        required: [
          'captureId', 'captureOrigin', 'modelInvoked', 'recordId', 'requestId', 'taskId',
          'provider', 'model', 'digestProtection', 'digestKeyId',
          'evidenceAttestationSha256', 'payloadSha256', 'messagesSha256',
          'messageCount', 'messages', 'recordedAt',
        ],
        properties: {
          captureId: { type: 'string', minLength: 1 },
          captureOrigin: { const: 'provider_dispatch_boundary' },
          modelInvoked: { const: true },
          recordId: { type: 'string', minLength: 1 },
          requestId: { type: 'string', minLength: 1 },
          taskId: { type: 'string', minLength: 1 },
          provider: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          digestProtection: { const: 'installation_hmac_sha256_v1' },
          digestKeyId: { type: 'string', pattern: SHA256_PATTERN },
          evidenceAttestationSha256: { type: 'string', pattern: SHA256_PATTERN },
          payloadSha256: { type: 'string', pattern: SHA256_PATTERN },
          messagesSha256: { type: 'string', pattern: SHA256_PATTERN },
          messageCount: { type: 'integer', minimum: 1 },
          messages: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false,
              required: ['index', 'role', 'contentSha256', 'textCharCount', 'sourceMessageId'],
              properties: {
                index: { type: 'integer', minimum: 0 },
                role: { enum: ['system', 'user', 'assistant', 'tool'] },
                contentSha256: { type: 'string', pattern: SHA256_PATTERN },
                textCharCount: { type: 'integer', minimum: 0 },
                sourceMessageId: { type: ['string', 'null'] },
              },
            },
          },
          recordedAt: { type: 'string', format: 'date-time' },
        },
      }, {
        type: 'object', additionalProperties: false,
        required: [
          'captureId', 'captureOrigin', 'modelInvoked', 'recordId', 'requestId', 'taskId',
          'executionOrigin', 'reason', 'recordedAt',
        ],
        properties: {
          captureId: { type: 'string', minLength: 1 },
          captureOrigin: { const: 'deterministic_tool_selection_boundary' },
          modelInvoked: { const: false },
          recordId: { type: 'string', minLength: 1 },
          requestId: { type: 'string', minLength: 1 },
          taskId: { type: 'string', minLength: 1 },
          executionOrigin: { enum: ['confirmed_action_resume', 'deterministic_route'] },
          reason: { type: 'string', minLength: 1 },
          recordedAt: { type: 'string', format: 'date-time' },
        },
      }],
    },
  },
});

export const TASK_REGRESSION_RUN_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lumicore.local/schemas/task-regression-run.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind', 'schemaVersion', 'runId', 'role', 'startedAt', 'completedAt',
    'buildIdentity', 'scenarioResults',
  ],
  properties: {
    kind: { const: TASK_REGRESSION_RUN_KIND },
    schemaVersion: { const: TASK_REGRESSION_RUN_SCHEMA_VERSION },
    runId: { type: 'string', minLength: 1 },
    role: { enum: ['baseline', 'candidate'] },
    startedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
    buildIdentity: {
      type: 'object', additionalProperties: false,
      required: [
        'kind', 'revision', 'sourceFingerprintSha256', 'sourceDirty',
        'runtimeFingerprintSha256', 'collectedAt',
      ],
      properties: {
        kind: { const: TASK_REGRESSION_BUILD_IDENTITY_KIND },
        revision: { type: 'string', pattern: REVISION_PATTERN },
        sourceFingerprintSha256: { type: 'string', pattern: SHA256_PATTERN },
        sourceDirty: { type: 'boolean' },
        runtimeFingerprintSha256: { type: 'string', pattern: SHA256_PATTERN },
        collectedAt: { type: 'string', format: 'date-time' },
      },
    },
    scenarioResults: {
      type: 'array', minItems: TASK_REGRESSION_SCENARIOS.length, maxItems: TASK_REGRESSION_SCENARIOS.length,
      items: {
        type: 'object', additionalProperties: false,
        required: ['scenarioId', 'snapshots', 'checks'],
      },
    },
  },
});

export class TaskRegressionArtifactError extends Error {
  constructor(code, issues = []) {
    super(code);
    this.name = 'TaskRegressionArtifactError';
    this.code = code;
    this.issues = issues;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function collector() {
  const issues = [];
  return {
    issues,
    add(path, code, message = code) {
      issues.push({ path, code, message });
    },
  };
}

function strictObject(value, path, expectedKeys, requiredKeys, out) {
  if (!isPlainObject(value)) {
    out.add(path, 'object_required');
    return false;
  }
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) out.add(`${path}.${key}`, 'unknown_property');
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) out.add(`${path}.${key}`, 'required');
  }
  return true;
}

function requiredString(value, path, out, { maxLength = 16_384 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLength) {
    out.add(path, 'nonempty_trimmed_string_required');
    return false;
  }
  return true;
}

function nullableString(value, path, out) {
  if (value === null) return true;
  return requiredString(value, path, out);
}

function enumValue(value, allowed, path, out) {
  if (!allowed.includes(value)) {
    out.add(path, 'enum_value_required', `expected one of: ${allowed.join(', ')}`);
    return false;
  }
  return true;
}

function integer(value, path, out, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    out.add(path, 'integer_out_of_range');
    return false;
  }
  return true;
}

function sha256(value, path, out) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    out.add(path, 'sha256_required');
    return false;
  }
  return true;
}

function isoInstant(value, path, out) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    out.add(path, 'canonical_iso_instant_required');
    return false;
  }
  try {
    if (new Date(value).toISOString() !== value) {
      out.add(path, 'canonical_iso_instant_required');
      return false;
    }
  } catch {
    out.add(path, 'canonical_iso_instant_required');
    return false;
  }
  return true;
}

function validateTimestampNotAfter(value, ceiling, path, out) {
  if (typeof value !== 'string' || typeof ceiling !== 'string') return;
  const observed = Date.parse(value);
  const maximum = Date.parse(ceiling);
  if (Number.isFinite(observed) && Number.isFinite(maximum) && observed > maximum) {
    out.add(path, 'timestamp_after_snapshot');
  }
}

function validatePointer(value, path, out, capturedAt) {
  const keys = ['state', 'taskId', 'requestId', 'recordId', 'observedAt'];
  if (!strictObject(value, path, keys, keys, out)) return;
  enumValue(value.state, ['set', 'cleared'], `${path}.state`, out);
  nullableString(value.taskId, `${path}.taskId`, out);
  nullableString(value.requestId, `${path}.requestId`, out);
  requiredString(value.recordId, `${path}.recordId`, out);
  isoInstant(value.observedAt, `${path}.observedAt`, out);
  validateTimestampNotAfter(value.observedAt, capturedAt, `${path}.observedAt`, out);
  if (value.state === 'set' && (typeof value.taskId !== 'string' || !value.taskId.trim())) {
    out.add(`${path}.taskId`, 'set_pointer_task_id_required');
  }
  if (value.state === 'cleared' && (value.taskId !== null || value.requestId !== null)) {
    out.add(path, 'cleared_pointer_must_not_have_owner');
  }
}

function validateBuildIdentityInternal(value, path, out) {
  const keys = [
    'kind', 'revision', 'sourceFingerprintSha256', 'sourceDirty',
    'runtimeFingerprintSha256', 'collectedAt',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  if (value.kind !== TASK_REGRESSION_BUILD_IDENTITY_KIND) out.add(`${path}.kind`, 'build_identity_kind_mismatch');
  if (typeof value.revision !== 'string' || !REVISION_RE.test(value.revision)) {
    out.add(`${path}.revision`, 'full_git_revision_required');
  }
  sha256(value.sourceFingerprintSha256, `${path}.sourceFingerprintSha256`, out);
  if (typeof value.sourceDirty !== 'boolean') out.add(`${path}.sourceDirty`, 'boolean_required');
  sha256(value.runtimeFingerprintSha256, `${path}.runtimeFingerprintSha256`, out);
  isoInstant(value.collectedAt, `${path}.collectedAt`, out);
}

export function validateTaskRegressionBuildIdentity(value) {
  const out = collector();
  validateBuildIdentityInternal(value, '$', out);
  return out.issues.length ? { ok: false, issues: out.issues } : { ok: true, value };
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TaskRegressionArtifactError('task_regression_canonical_json_invalid');
    seen.add(value);
    const normalized = value.map(item => canonicalize(item, seen));
    seen.delete(value);
    return normalized;
  }
  if (!isPlainObject(value) || seen.has(value)) {
    throw new TaskRegressionArtifactError('task_regression_canonical_json_invalid');
  }
  seen.add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) {
      throw new TaskRegressionArtifactError('task_regression_canonical_json_invalid');
    }
    normalized[key] = canonicalize(value[key], seen);
  }
  seen.delete(value);
  return normalized;
}

export function stableTaskRegressionJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function taskRegressionDigest(value) {
  return crypto.createHash('sha256').update(stableTaskRegressionJson(value)).digest('hex');
}

export function taskRegressionBuildIdentityDigest(value) {
  const validation = validateTaskRegressionBuildIdentity(value);
  if (!validation.ok) {
    throw new TaskRegressionArtifactError('task_regression_build_identity_invalid', validation.issues);
  }
  return taskRegressionDigest(value);
}

function validateReply(value, path, out, capturedAt) {
  const keys = ['messageId', 'text', 'recordedAt'];
  if (!strictObject(value, path, keys, keys, out)) return;
  requiredString(value.messageId, `${path}.messageId`, out);
  requiredString(value.text, `${path}.text`, out, { maxLength: 1_000_000 });
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
  validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
}

function validateTask(value, path, out, capturedAt) {
  const keys = ['recordId', 'taskId', 'status', 'goal', 'updatedAt'];
  if (!strictObject(value, path, keys, keys, out)) return;
  requiredString(value.recordId, `${path}.recordId`, out);
  requiredString(value.taskId, `${path}.taskId`, out);
  enumValue(value.status, TASK_STATUSES, `${path}.status`, out);
  requiredString(value.goal, `${path}.goal`, out, { maxLength: 1_000_000 });
  isoInstant(value.updatedAt, `${path}.updatedAt`, out);
  validateTimestampNotAfter(value.updatedAt, capturedAt, `${path}.updatedAt`, out);
}

function validateRequest(value, path, out, capturedAt) {
  const keys = ['recordId', 'requestId', 'taskId', 'status', 'recordedAt'];
  if (!strictObject(value, path, keys, keys, out)) return;
  requiredString(value.recordId, `${path}.recordId`, out);
  requiredString(value.requestId, `${path}.requestId`, out);
  requiredString(value.taskId, `${path}.taskId`, out);
  enumValue(value.status, TASK_REQUEST_STATUSES, `${path}.status`, out);
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
  validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
}

function validateReceipt(value, path, out, capturedAt) {
  const keys = ['recordId', 'receiptId', 'requestId', 'taskId', 'status', 'toolName', 'recordedAt'];
  if (!strictObject(value, path, keys, keys, out)) return;
  requiredString(value.recordId, `${path}.recordId`, out);
  requiredString(value.receiptId, `${path}.receiptId`, out);
  requiredString(value.requestId, `${path}.requestId`, out);
  requiredString(value.taskId, `${path}.taskId`, out);
  enumValue(value.status, TASK_RECEIPT_STATUSES, `${path}.status`, out);
  requiredString(value.toolName, `${path}.toolName`, out);
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
  validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
}

function validateToolTarget(value, path, out, capturedAt) {
  const keys = [
    'recordId', 'requestId', 'taskId', 'toolName', 'targetType', 'targetId',
    'displayName', 'source', 'normalizedTargetSha256', 'recordedAt',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  for (const key of ['recordId', 'requestId', 'taskId', 'toolName', 'targetType', 'targetId', 'displayName', 'source']) {
    requiredString(value[key], `${path}.${key}`, out, { maxLength: key === 'displayName' ? 32_768 : 16_384 });
  }
  sha256(value.normalizedTargetSha256, `${path}.normalizedTargetSha256`, out);
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
  validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
}

function validateModelInputMessage(value, path, out, expectedIndex) {
  const keys = ['index', 'role', 'contentSha256', 'textCharCount', 'sourceMessageId'];
  if (!strictObject(value, path, keys, keys, out)) return;
  integer(value.index, `${path}.index`, out);
  if (value.index !== expectedIndex) out.add(`${path}.index`, 'model_message_index_not_contiguous');
  enumValue(value.role, ['system', 'user', 'assistant', 'tool'], `${path}.role`, out);
  sha256(value.contentSha256, `${path}.contentSha256`, out);
  integer(value.textCharCount, `${path}.textCharCount`, out);
  nullableString(value.sourceMessageId, `${path}.sourceMessageId`, out);
}

function validateModelActualInput(value, path, out, capturedAt) {
  if (value?.captureOrigin === 'deterministic_tool_selection_boundary') {
    const keys = [
      'captureId', 'captureOrigin', 'modelInvoked', 'recordId', 'requestId', 'taskId',
      'executionOrigin', 'reason', 'recordedAt',
    ];
    if (!strictObject(value, path, keys, keys, out)) return;
    for (const key of ['captureId', 'recordId', 'requestId', 'taskId', 'reason']) {
      requiredString(value[key], `${path}.${key}`, out);
    }
    if (value.modelInvoked !== false) out.add(`${path}.modelInvoked`, 'model_non_invocation_proof_required');
    enumValue(
      value.executionOrigin,
      ['confirmed_action_resume', 'deterministic_route'],
      `${path}.executionOrigin`,
      out,
    );
    isoInstant(value.recordedAt, `${path}.recordedAt`, out);
    validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
    return;
  }
  const keys = [
    'captureId', 'captureOrigin', 'modelInvoked', 'recordId', 'requestId', 'taskId', 'provider', 'model',
    'digestProtection', 'digestKeyId', 'evidenceAttestationSha256', 'payloadSha256',
    'messagesSha256', 'messageCount', 'messages', 'recordedAt',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  for (const key of ['captureId', 'recordId', 'requestId', 'taskId', 'provider', 'model']) {
    requiredString(value[key], `${path}.${key}`, out);
  }
  if (value.captureOrigin !== 'provider_dispatch_boundary') {
    out.add(`${path}.captureOrigin`, 'provider_dispatch_boundary_required');
  }
  if (value.modelInvoked !== true) out.add(`${path}.modelInvoked`, 'model_invocation_required');
  if (value.digestProtection !== 'installation_hmac_sha256_v1') {
    out.add(`${path}.digestProtection`, 'installation_hmac_sha256_required');
  }
  sha256(value.digestKeyId, `${path}.digestKeyId`, out);
  sha256(value.evidenceAttestationSha256, `${path}.evidenceAttestationSha256`, out);
  sha256(value.payloadSha256, `${path}.payloadSha256`, out);
  sha256(value.messagesSha256, `${path}.messagesSha256`, out);
  integer(value.messageCount, `${path}.messageCount`, out, 1);
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    out.add(`${path}.messages`, 'nonempty_array_required');
  } else {
    value.messages.forEach((message, index) => validateModelInputMessage(message, `${path}.messages[${index}]`, out, index));
    if (value.messageCount !== value.messages.length) {
      out.add(`${path}.messageCount`, 'model_message_count_mismatch');
    }
    const sourceBackedUserMessage = value.messages.some(message => (
      message?.role === 'user'
      && typeof message?.sourceMessageId === 'string'
      && message.sourceMessageId.trim()
    ));
    if (!sourceBackedUserMessage) {
      out.add(`${path}.messages`, 'source_backed_user_message_required');
    }
  }
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
  validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
}

function validateTruthSnapshotInternal(value, path, out, options = {}) {
  const keys = [
    'kind', 'schemaVersion', 'snapshotId', 'scenarioId', 'acceptanceRunId', 'capturedAt',
    'buildIdentityDigest', 'userVisibleReply', 'task', 'pointers', 'request', 'receipt',
    'toolTarget', 'modelActualInput',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  if (value.kind !== TASK_TRUTH_SNAPSHOT_KIND) out.add(`${path}.kind`, 'snapshot_kind_mismatch');
  if (value.schemaVersion !== TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION) out.add(`${path}.schemaVersion`, 'snapshot_schema_version_mismatch');
  requiredString(value.snapshotId, `${path}.snapshotId`, out);
  enumValue(value.scenarioId, TASK_REGRESSION_SCENARIO_IDS, `${path}.scenarioId`, out);
  requiredString(value.acceptanceRunId, `${path}.acceptanceRunId`, out);
  isoInstant(value.capturedAt, `${path}.capturedAt`, out);
  sha256(value.buildIdentityDigest, `${path}.buildIdentityDigest`, out);

  validateReply(value.userVisibleReply, `${path}.userVisibleReply`, out, value.capturedAt);
  validateTask(value.task, `${path}.task`, out, value.capturedAt);
  if (strictObject(value.pointers, `${path}.pointers`, ['pending', 'live'], ['pending', 'live'], out)) {
    validatePointer(value.pointers.pending, `${path}.pointers.pending`, out, value.capturedAt);
    validatePointer(value.pointers.live, `${path}.pointers.live`, out, value.capturedAt);
  }
  validateRequest(value.request, `${path}.request`, out, value.capturedAt);
  validateReceipt(value.receipt, `${path}.receipt`, out, value.capturedAt);
  validateToolTarget(value.toolTarget, `${path}.toolTarget`, out, value.capturedAt);
  validateModelActualInput(value.modelActualInput, `${path}.modelActualInput`, out, value.capturedAt);

  const taskId = value.task?.taskId;
  const requestId = value.request?.requestId;
  for (const [field, record] of [
    ['request', value.request],
    ['receipt', value.receipt],
    ['toolTarget', value.toolTarget],
    ['modelActualInput', value.modelActualInput],
  ]) {
    if (typeof taskId === 'string' && record?.taskId !== taskId) {
      out.add(`${path}.${field}.taskId`, 'task_id_binding_mismatch');
    }
  }
  for (const [field, record] of [
    ['receipt', value.receipt],
    ['toolTarget', value.toolTarget],
    ['modelActualInput', value.modelActualInput],
  ]) {
    if (typeof requestId === 'string' && record?.requestId !== requestId) {
      out.add(`${path}.${field}.requestId`, 'request_id_binding_mismatch');
    }
  }
  if (value.receipt?.toolName !== value.toolTarget?.toolName) {
    out.add(`${path}.toolTarget.toolName`, 'tool_name_binding_mismatch');
  }
  for (const pointerName of ['pending', 'live']) {
    const pointer = value.pointers?.[pointerName];
    if (pointer?.state === 'set' && pointer.taskId !== taskId) {
      out.add(`${path}.pointers.${pointerName}.taskId`, 'pointer_task_id_binding_mismatch');
    }
    if (pointer?.state === 'set' && pointer.requestId !== null && pointer.requestId !== requestId) {
      out.add(`${path}.pointers.${pointerName}.requestId`, 'pointer_request_id_binding_mismatch');
    }
  }

  if (TASK_TERMINAL_STATUSES.includes(value.task?.status)) {
    for (const pointerName of ['pending', 'live']) {
      if (value.pointers?.[pointerName]?.state !== 'cleared') {
        out.add(`${path}.pointers.${pointerName}.state`, 'terminal_task_pointer_must_be_cleared');
      }
    }
  }
  if (value.task?.status === 'waiting_confirmation') {
    for (const pointerName of ['pending', 'live']) {
      if (value.pointers?.[pointerName]?.state !== 'set') {
        out.add(`${path}.pointers.${pointerName}.state`, 'waiting_confirmation_pointer_must_be_set');
      }
    }
  } else if (!TASK_TERMINAL_STATUSES.includes(value.task?.status) && value.pointers?.pending?.state === 'set') {
    out.add(`${path}.pointers.pending.state`, 'pending_pointer_only_valid_while_waiting_confirmation');
  }

  if (options.expectedScenarioId && value.scenarioId !== options.expectedScenarioId) {
    out.add(`${path}.scenarioId`, 'scenario_binding_mismatch');
  }
  if (options.expectedAcceptanceRunId && value.acceptanceRunId !== options.expectedAcceptanceRunId) {
    out.add(`${path}.acceptanceRunId`, 'run_binding_mismatch');
  }
  if (options.expectedBuildIdentityDigest && value.buildIdentityDigest !== options.expectedBuildIdentityDigest) {
    out.add(`${path}.buildIdentityDigest`, 'build_identity_binding_mismatch');
  }
}

function validateControlMessage(value, path, out, capturedAt, expected = {}) {
  const keys = [
    'recordId', 'messageId', 'requestId', 'role', 'cognitiveIntent', 'text',
    'textSha256', 'textCharCount', 'transcriptIndex', 'recordedAt',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  for (const key of ['recordId', 'messageId', 'requestId', 'role', 'text']) {
    requiredString(value[key], `${path}.${key}`, out, { maxLength: key === 'text' ? 100_000 : 16_384 });
  }
  if (typeof value.cognitiveIntent !== 'string' || value.cognitiveIntent.length > 120) {
    out.add(`${path}.cognitiveIntent`, 'bounded_string_required');
  }
  enumValue(value.role, ['user', 'assistant'], `${path}.role`, out);
  sha256(value.textSha256, `${path}.textSha256`, out);
  integer(value.textCharCount, `${path}.textCharCount`, out);
  integer(value.transcriptIndex, `${path}.transcriptIndex`, out);
  if (typeof value.text === 'string') {
    const expectedDigest = crypto.createHash('sha256').update(value.text, 'utf8').digest('hex');
    if (value.textSha256 !== expectedDigest) out.add(`${path}.textSha256`, 'message_text_digest_mismatch');
    if (value.textCharCount !== value.text.length) out.add(`${path}.textCharCount`, 'message_text_length_mismatch');
  }
  if (expected.requestId && value.requestId !== expected.requestId) {
    out.add(`${path}.requestId`, 'control_request_binding_mismatch');
  }
  if (expected.role && value.role !== expected.role) out.add(`${path}.role`, 'control_role_mismatch');
  if (expected.cognitiveIntent && value.cognitiveIntent !== expected.cognitiveIntent) {
    out.add(`${path}.cognitiveIntent`, 'control_intent_mismatch');
  }
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
  validateTimestampNotAfter(value.recordedAt, capturedAt, `${path}.recordedAt`, out);
}

function validateControlTerminal(value, path, out, capturedAt, expected = {}) {
  const keys = [
    'recordId', 'requestId', 'status', 'event', 'sidecar', 'finalized', 'blocked',
    'reason', 'text', 'textSha256', 'controlIntent', 'targetRequestId', 'createdAt', 'updatedAt',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  for (const key of ['recordId', 'requestId', 'status', 'event', 'text']) {
    requiredString(value[key], `${path}.${key}`, out, { maxLength: key === 'text' ? 100_000 : 16_384 });
  }
  if (typeof value.reason !== 'string' || value.reason.length > 80) {
    out.add(`${path}.reason`, 'bounded_string_required');
  }
  enumValue(value.status, ['cancelled', 'completed'], `${path}.status`, out);
  if (value.event !== 'agent:response') out.add(`${path}.event`, 'control_terminal_response_required');
  if (typeof value.sidecar !== 'boolean') out.add(`${path}.sidecar`, 'boolean_required');
  if (value.finalized !== true) out.add(`${path}.finalized`, 'control_terminal_finalized_required');
  if (value.blocked !== false) out.add(`${path}.blocked`, 'control_terminal_unblocked_required');
  if (value.controlIntent !== null && !['cancel', 'status'].includes(value.controlIntent)) {
    out.add(`${path}.controlIntent`, 'control_terminal_intent_invalid');
  }
  nullableString(value.targetRequestId, `${path}.targetRequestId`, out);
  sha256(value.textSha256, `${path}.textSha256`, out);
  if (typeof value.text === 'string') {
    const expectedDigest = crypto.createHash('sha256').update(value.text, 'utf8').digest('hex');
    if (value.textSha256 !== expectedDigest) out.add(`${path}.textSha256`, 'terminal_text_digest_mismatch');
  }
  for (const key of ['createdAt', 'updatedAt']) {
    isoInstant(value[key], `${path}.${key}`, out);
    validateTimestampNotAfter(value[key], capturedAt, `${path}.${key}`, out);
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    out.add(`${path}.updatedAt`, 'terminal_updated_before_created');
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      out.add(`${path}.${key}`, 'control_terminal_binding_mismatch');
    }
  }
}

function validateNoExecution(value, path, out, includeModel = true) {
  const keys = includeModel
    ? [
      'modelRoutingReceiptCount', 'actionTurnCount', 'taskBoundActionTurnCount',
      'actionReceiptCount', 'assistantToolCallCount',
    ]
    : [
      'actionTurnCount', 'taskBoundActionTurnCount', 'actionReceiptCount',
      'assistantToolCallCount',
    ];
  if (!strictObject(value, path, keys, keys, out)) return;
  for (const key of keys) {
    integer(value[key], `${path}.${key}`, out);
    const expected = key === 'actionTurnCount' ? 1 : 0;
    if (value[key] !== expected) {
      out.add(
        `${path}.${key}`,
        key === 'actionTurnCount'
          ? 'single_request_ledger_turn_required'
          : 'zero_execution_evidence_required',
      );
    }
  }
}

function validateControlProvider(value, path, out, capturedAt, requestId, turnNonce) {
  const keys = [
    'captureId', 'captureOrigin', 'recordId', 'routingSource', 'requestId', 'turnNonce', 'turnNonceSource',
    'provider', 'model', 'routingStatus', 'attemptStatus', 'errorCategory', 'digestProtection',
    'digestKeyId', 'evidenceAttestationSha256', 'payloadSha256', 'messagesSha256',
    'messageCount', 'messages', 'attemptStartedAt', 'totalExecutionMs',
    'cancellationRequestedAt', 'cancellationLatencyMs',
    'maximumCancellationLatencyMs', 'recordedAt',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  for (const key of ['captureId', 'recordId', 'requestId', 'turnNonce', 'provider', 'model']) {
    requiredString(value[key], `${path}.${key}`, out);
  }
  if (value.captureOrigin !== 'provider_dispatch_boundary') {
    out.add(`${path}.captureOrigin`, 'provider_dispatch_boundary_required');
  }
  if (value.routingSource !== 'chat') {
    out.add(`${path}.routingSource`, 'control_primary_chat_routing_source_required');
  }
  if (value.requestId !== requestId) out.add(`${path}.requestId`, 'control_request_binding_mismatch');
  if (value.turnNonce !== turnNonce) out.add(`${path}.turnNonce`, 'control_turn_nonce_mismatch');
  if (value.turnNonceSource !== 'accepted_user_message_id_hmac_attested_provider_slot') {
    out.add(`${path}.turnNonceSource`, 'control_turn_nonce_source_invalid');
  }
  for (const [key, expected] of [
    ['routingStatus', 'failed'],
    ['attemptStatus', 'failed'],
    ['errorCategory', 'cancelled'],
    ['digestProtection', 'installation_hmac_sha256_v1'],
  ]) {
    if (value[key] !== expected) out.add(`${path}.${key}`, 'control_provider_cancel_binding_mismatch');
  }
  for (const key of ['digestKeyId', 'evidenceAttestationSha256', 'payloadSha256', 'messagesSha256']) {
    sha256(value[key], `${path}.${key}`, out);
  }
  integer(value.messageCount, `${path}.messageCount`, out, 1);
  integer(value.cancellationLatencyMs, `${path}.cancellationLatencyMs`, out);
  integer(value.totalExecutionMs, `${path}.totalExecutionMs`, out);
  integer(value.maximumCancellationLatencyMs, `${path}.maximumCancellationLatencyMs`, out, 1);
  if (value.maximumCancellationLatencyMs !== 5_000) {
    out.add(`${path}.maximumCancellationLatencyMs`, 'control_cancellation_bound_mismatch');
  }
  if (Number.isSafeInteger(value.cancellationLatencyMs)
    && Number.isSafeInteger(value.maximumCancellationLatencyMs)
    && value.cancellationLatencyMs > value.maximumCancellationLatencyMs) {
    out.add(`${path}.cancellationLatencyMs`, 'control_cancellation_latency_exceeded');
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    out.add(`${path}.messages`, 'nonempty_array_required');
  } else {
    value.messages.forEach((message, index) => validateModelInputMessage(
      message,
      `${path}.messages[${index}]`,
      out,
      index,
    ));
    if (value.messageCount !== value.messages.length) {
      out.add(`${path}.messageCount`, 'model_message_count_mismatch');
    }
    const nonceSlots = value.messages.filter(message => message?.sourceMessageId === turnNonce);
    if (nonceSlots.length !== 1 || nonceSlots[0]?.role !== 'user') {
      out.add(`${path}.messages`, 'single_hmac_attested_turn_nonce_slot_required');
    }
    if (value.messages.some(message => message?.sourceMessageId && message.sourceMessageId !== turnNonce)) {
      out.add(`${path}.messages`, 'foreign_turn_nonce_present');
    }
  }
  for (const key of ['attemptStartedAt', 'cancellationRequestedAt', 'recordedAt']) {
    isoInstant(value[key], `${path}.${key}`, out);
    validateTimestampNotAfter(value[key], capturedAt, `${path}.${key}`, out);
  }
}

function validateControlTurn(value, path, out, capturedAt, expected) {
  const keys = [
    'requestId', 'relation', 'userMessage', 'assistantMessage', 'terminal',
    'targetRequestId', 'targetBinding', 'noExecution',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  requiredString(value.requestId, `${path}.requestId`, out);
  requiredString(value.targetRequestId, `${path}.targetRequestId`, out);
  enumValue(value.relation, ['status', 'cancel', 'repeat'], `${path}.relation`, out);
  enumValue(value.targetBinding, [
    'durable_terminal_status_target',
    'durable_cancellation_tombstone',
    'exact_adjacent_assistant_replay',
  ], `${path}.targetBinding`, out);
  if (value.requestId !== expected.requestId) out.add(`${path}.requestId`, 'control_phase_request_mismatch');
  if (value.relation !== expected.relation) out.add(`${path}.relation`, 'control_relation_mismatch');
  if (value.targetRequestId !== expected.targetRequestId) {
    out.add(`${path}.targetRequestId`, 'control_target_request_mismatch');
  }
  if (value.targetBinding !== expected.targetBinding) {
    out.add(`${path}.targetBinding`, 'control_target_binding_mismatch');
  }
  validateControlMessage(value.userMessage, `${path}.userMessage`, out, capturedAt, {
    requestId: expected.requestId,
    role: 'user',
    cognitiveIntent: expected.userIntent,
  });
  validateControlMessage(value.assistantMessage, `${path}.assistantMessage`, out, capturedAt, {
    requestId: expected.requestId,
    role: 'assistant',
    cognitiveIntent: expected.assistantIntent,
  });
  validateControlTerminal(value.terminal, `${path}.terminal`, out, capturedAt, {
    requestId: expected.requestId,
    status: 'completed',
    sidecar: expected.sidecar,
    reason: expected.reason,
    controlIntent: expected.controlIntent,
    targetRequestId: expected.terminalTargetRequestId,
  });
  if (value.terminal?.text !== value.assistantMessage?.text) {
    out.add(`${path}.terminal.text`, 'control_terminal_transcript_mismatch');
  }
  validateNoExecution(value.noExecution, `${path}.noExecution`, out, true);
}

function validateControlSequenceTruthSnapshotInternal(value, path, out, options = {}) {
  const keys = [
    'kind', 'schemaVersion', 'evidenceKind', 'snapshotId', 'scenarioId', 'acceptanceRunId',
    'capturedAt', 'buildIdentityDigest', 'conversation', 'longExecution', 'controls', 'repeatEquality',
  ];
  if (!strictObject(value, path, keys, keys, out)) return;
  if (value.kind !== CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND) out.add(`${path}.kind`, 'control_snapshot_kind_mismatch');
  if (value.schemaVersion !== CONTROL_SEQUENCE_TRUTH_SNAPSHOT_SCHEMA_VERSION) {
    out.add(`${path}.schemaVersion`, 'control_snapshot_schema_version_mismatch');
  }
  if (value.evidenceKind !== 'control_sequence') out.add(`${path}.evidenceKind`, 'control_evidence_kind_mismatch');
  requiredString(value.snapshotId, `${path}.snapshotId`, out);
  if (value.scenarioId !== 'control_stop_status_repeat') out.add(`${path}.scenarioId`, 'control_scenario_required');
  requiredString(value.acceptanceRunId, `${path}.acceptanceRunId`, out);
  isoInstant(value.capturedAt, `${path}.capturedAt`, out);
  sha256(value.buildIdentityDigest, `${path}.buildIdentityDigest`, out);

  const conversationKeys = ['recordId', 'conversationId', 'livePointerState', 'durableActionTaskCount'];
  if (strictObject(value.conversation, `${path}.conversation`, conversationKeys, conversationKeys, out)) {
    requiredString(value.conversation.recordId, `${path}.conversation.recordId`, out);
    requiredString(value.conversation.conversationId, `${path}.conversation.conversationId`, out);
    if (value.conversation.livePointerState !== 'cleared') {
      out.add(`${path}.conversation.livePointerState`, 'control_live_pointer_must_be_cleared');
    }
    integer(value.conversation.durableActionTaskCount, `${path}.conversation.durableActionTaskCount`, out);
    if (value.conversation.durableActionTaskCount !== 0) {
      out.add(`${path}.conversation.durableActionTaskCount`, 'control_task_identity_must_not_be_invented');
    }
  }

  const longKeys = [
    'requestId', 'userMessage', 'assistantMessage', 'terminal', 'providerOutbound', 'noToolExecution',
  ];
  if (strictObject(value.longExecution, `${path}.longExecution`, longKeys, longKeys, out)) {
    const longId = value.longExecution.requestId;
    requiredString(longId, `${path}.longExecution.requestId`, out);
    validateControlMessage(value.longExecution.userMessage, `${path}.longExecution.userMessage`, out, value.capturedAt, {
      requestId: longId,
      role: 'user',
    });
    validateControlMessage(value.longExecution.assistantMessage, `${path}.longExecution.assistantMessage`, out, value.capturedAt, {
      requestId: longId,
      role: 'assistant',
      cognitiveIntent: 'task_cancelled',
    });
    validateControlTerminal(value.longExecution.terminal, `${path}.longExecution.terminal`, out, value.capturedAt, {
      requestId: longId,
      status: 'cancelled',
      sidecar: false,
      reason: 'request_cancelled',
      controlIntent: null,
      targetRequestId: null,
    });
    if (value.longExecution.terminal?.text !== value.longExecution.assistantMessage?.text) {
      out.add(`${path}.longExecution.terminal.text`, 'control_terminal_transcript_mismatch');
    }
    validateControlProvider(
      value.longExecution.providerOutbound,
      `${path}.longExecution.providerOutbound`,
      out,
      value.capturedAt,
      longId,
      value.longExecution.userMessage?.messageId,
    );
    const provider = value.longExecution.providerOutbound;
    const recomputedCancellationMs = Date.parse(value.longExecution.terminal?.updatedAt)
      - Date.parse(provider?.cancellationRequestedAt);
    if (provider?.cancellationLatencyMs !== recomputedCancellationMs) {
      out.add(`${path}.longExecution.providerOutbound.cancellationLatencyMs`, 'control_cancellation_latency_mismatch');
    }
    if (Date.parse(provider?.recordedAt) > Date.parse(value.longExecution.terminal?.updatedAt)) {
      out.add(`${path}.longExecution.providerOutbound.recordedAt`, 'control_provider_after_terminal');
    }
    const recomputedTotalMs = Date.parse(value.longExecution.terminal?.updatedAt)
      - Date.parse(provider?.attemptStartedAt);
    if (provider?.totalExecutionMs !== recomputedTotalMs) {
      out.add(`${path}.longExecution.providerOutbound.totalExecutionMs`, 'control_total_execution_latency_mismatch');
    }
    validateNoExecution(value.longExecution.noToolExecution, `${path}.longExecution.noToolExecution`, out, false);
  }

  const controlsKeys = ['status', 'stop', 'repeat'];
  if (strictObject(value.controls, `${path}.controls`, controlsKeys, controlsKeys, out)) {
    const longId = value.longExecution?.requestId;
    const statusId = value.controls.status?.requestId;
    const stopId = value.controls.stop?.requestId;
    const repeatId = value.controls.repeat?.requestId;
    if (new Set([longId, statusId, stopId, repeatId].filter(Boolean)).size !== 4) {
      out.add(`${path}.controls`, 'control_phase_request_ids_must_be_unique');
    }
    validateControlTurn(value.controls.status, `${path}.controls.status`, out, value.capturedAt, {
      requestId: statusId,
      relation: 'status',
      targetRequestId: longId,
      targetBinding: 'durable_terminal_status_target',
      userIntent: 'task_status',
      assistantIntent: 'task_status',
      sidecar: true,
      reason: 'target_execution_status',
      controlIntent: 'status',
      terminalTargetRequestId: longId,
    });
    validateControlTurn(value.controls.stop, `${path}.controls.stop`, out, value.capturedAt, {
      requestId: stopId,
      relation: 'cancel',
      targetRequestId: longId,
      targetBinding: 'durable_cancellation_tombstone',
      userIntent: 'task_cancel',
      assistantIntent: 'task_cancel',
      sidecar: true,
      reason: 'cancelled_by_user',
      controlIntent: 'cancel',
      terminalTargetRequestId: longId,
    });
    validateControlTurn(value.controls.repeat, `${path}.controls.repeat`, out, value.capturedAt, {
      requestId: repeatId,
      relation: 'repeat',
      targetRequestId: statusId,
      targetBinding: 'exact_adjacent_assistant_replay',
      userIntent: undefined,
      assistantIntent: 'task_repeat',
      sidecar: false,
      reason: 'repeat_previous_reply',
      controlIntent: null,
      terminalTargetRequestId: null,
    });
    if (value.longExecution?.providerOutbound?.cancellationRequestedAt
      !== value.controls.stop?.terminal?.createdAt) {
      out.add(`${path}.longExecution.providerOutbound.cancellationRequestedAt`, 'control_stop_tombstone_time_mismatch');
    }
    if (Date.parse(value.controls.status?.terminal?.createdAt)
      < Date.parse(value.longExecution?.terminal?.updatedAt)) {
      out.add(`${path}.controls.status.terminal.createdAt`, 'control_status_before_target_terminal');
    }
    const transcriptIndexes = [
      value.longExecution?.userMessage?.transcriptIndex,
      value.controls.stop?.userMessage?.transcriptIndex,
      value.longExecution?.assistantMessage?.transcriptIndex,
      value.controls.stop?.assistantMessage?.transcriptIndex,
      value.controls.status?.userMessage?.transcriptIndex,
      value.controls.status?.assistantMessage?.transcriptIndex,
      value.controls.repeat?.userMessage?.transcriptIndex,
      value.controls.repeat?.assistantMessage?.transcriptIndex,
    ];
    if (transcriptIndexes.some((index, offset) => (
      !Number.isSafeInteger(index)
      || (offset > 0 && index <= transcriptIndexes[offset - 1])
    ))) out.add(`${path}.controls`, 'control_transcript_order_invalid');
    if (transcriptIndexes[3] + 1 !== transcriptIndexes[4]) {
      out.add(`${path}.controls.status.userMessage.transcriptIndex`, 'status_not_adjacent_to_cancel_tombstone');
    }
  }

  const equalityKeys = [
    'sourceRequestId', 'sourceMessageId', 'repeatedRequestId', 'repeatedMessageId',
    'exactTextSha256', 'exact',
  ];
  if (strictObject(value.repeatEquality, `${path}.repeatEquality`, equalityKeys, equalityKeys, out)) {
    for (const key of ['sourceRequestId', 'sourceMessageId', 'repeatedRequestId', 'repeatedMessageId']) {
      requiredString(value.repeatEquality[key], `${path}.repeatEquality.${key}`, out);
    }
    sha256(value.repeatEquality.exactTextSha256, `${path}.repeatEquality.exactTextSha256`, out);
    if (value.repeatEquality.exact !== true) out.add(`${path}.repeatEquality.exact`, 'exact_replay_required');
    const statusMessage = value.controls?.status?.assistantMessage;
    const repeatMessage = value.controls?.repeat?.assistantMessage;
    if (value.repeatEquality.sourceRequestId !== value.controls?.status?.requestId
      || value.repeatEquality.sourceMessageId !== statusMessage?.messageId
      || value.repeatEquality.repeatedRequestId !== value.controls?.repeat?.requestId
      || value.repeatEquality.repeatedMessageId !== repeatMessage?.messageId
      || value.repeatEquality.exactTextSha256 !== statusMessage?.textSha256
      || statusMessage?.text !== repeatMessage?.text
      || statusMessage?.transcriptIndex + 1 !== value.controls?.repeat?.userMessage?.transcriptIndex) {
      out.add(`${path}.repeatEquality`, 'exact_adjacent_reply_binding_mismatch');
    }
  }

  if (options.expectedScenarioId && value.scenarioId !== options.expectedScenarioId) {
    out.add(`${path}.scenarioId`, 'scenario_binding_mismatch');
  }
  if (options.expectedAcceptanceRunId && value.acceptanceRunId !== options.expectedAcceptanceRunId) {
    out.add(`${path}.acceptanceRunId`, 'run_binding_mismatch');
  }
  if (options.expectedBuildIdentityDigest && value.buildIdentityDigest !== options.expectedBuildIdentityDigest) {
    out.add(`${path}.buildIdentityDigest`, 'build_identity_binding_mismatch');
  }
}

function validateAnyTruthSnapshotInternal(value, path, out, options = {}) {
  if (value?.kind === CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND) {
    validateControlSequenceTruthSnapshotInternal(value, path, out, options);
    return;
  }
  validateTruthSnapshotInternal(value, path, out, options);
}

export function validateTaskTruthSnapshot(value, options = {}) {
  const out = collector();
  validateAnyTruthSnapshotInternal(value, '$', out, options);
  return out.issues.length ? { ok: false, issues: out.issues } : { ok: true, value };
}

export function assertTaskTruthSnapshot(value, options = {}) {
  const validation = validateTaskTruthSnapshot(value, options);
  if (!validation.ok) {
    throw new TaskRegressionArtifactError('task_truth_snapshot_invalid', validation.issues);
  }
  return value;
}

function validateCheck(value, path, out, scenario, snapshotIds) {
  const keys = ['checkId', 'passed', 'evidenceSnapshotIds'];
  if (!strictObject(value, path, keys, keys, out)) return;
  requiredString(value.checkId, `${path}.checkId`, out);
  if (!scenario.checks.includes(value.checkId)) out.add(`${path}.checkId`, 'unknown_scenario_check');
  if (typeof value.passed !== 'boolean') out.add(`${path}.passed`, 'boolean_required');
  if (!Array.isArray(value.evidenceSnapshotIds) || value.evidenceSnapshotIds.length === 0) {
    out.add(`${path}.evidenceSnapshotIds`, 'nonempty_array_required');
  } else {
    const seen = new Set();
    value.evidenceSnapshotIds.forEach((snapshotId, index) => {
      requiredString(snapshotId, `${path}.evidenceSnapshotIds[${index}]`, out);
      if (seen.has(snapshotId)) out.add(`${path}.evidenceSnapshotIds[${index}]`, 'duplicate_evidence_reference');
      seen.add(snapshotId);
      if (!snapshotIds.has(snapshotId)) out.add(`${path}.evidenceSnapshotIds[${index}]`, 'unknown_snapshot_reference');
    });
  }
}

function validateScenarioResultInternal(value, path, out, context) {
  const keys = ['scenarioId', 'snapshots', 'checks'];
  if (!strictObject(value, path, keys, keys, out)) return;
  if (!enumValue(value.scenarioId, TASK_REGRESSION_SCENARIO_IDS, `${path}.scenarioId`, out)) return;
  const scenario = SCENARIO_BY_ID.get(value.scenarioId);
  const snapshotIds = new Set();
  if (!Array.isArray(value.snapshots) || value.snapshots.length === 0) {
    out.add(`${path}.snapshots`, 'nonempty_array_required');
  } else {
    value.snapshots.forEach((snapshot, index) => {
      const snapshotPath = `${path}.snapshots[${index}]`;
      validateAnyTruthSnapshotInternal(snapshot, snapshotPath, out, {
        expectedScenarioId: value.scenarioId,
        expectedAcceptanceRunId: context.runId,
        expectedBuildIdentityDigest: context.buildIdentityDigest,
      });
      if (typeof snapshot?.snapshotId === 'string') {
        if (snapshotIds.has(snapshot.snapshotId)) out.add(`${snapshotPath}.snapshotId`, 'duplicate_snapshot_id');
        snapshotIds.add(snapshot.snapshotId);
      }
      if (context.startedAt && typeof snapshot?.capturedAt === 'string'
        && Date.parse(snapshot.capturedAt) < Date.parse(context.startedAt)) {
        out.add(`${snapshotPath}.capturedAt`, 'snapshot_before_run_start');
      }
      if (context.completedAt && typeof snapshot?.capturedAt === 'string'
        && Date.parse(snapshot.capturedAt) > Date.parse(context.completedAt)) {
        out.add(`${snapshotPath}.capturedAt`, 'snapshot_after_run_completion');
      }
    });
  }

  if (!Array.isArray(value.checks)) {
    out.add(`${path}.checks`, 'array_required');
    return;
  }
  const seenChecks = new Set();
  value.checks.forEach((check, index) => {
    validateCheck(check, `${path}.checks[${index}]`, out, scenario, snapshotIds);
    if (typeof check?.checkId === 'string') {
      if (seenChecks.has(check.checkId)) out.add(`${path}.checks[${index}].checkId`, 'duplicate_scenario_check');
      seenChecks.add(check.checkId);
    }
  });
  for (const checkId of scenario.checks) {
    if (!seenChecks.has(checkId)) out.add(`${path}.checks`, 'required_scenario_check_missing', checkId);
  }
}

function validateRunHeaderInternal(value, path, out) {
  const keys = [
    'kind', 'schemaVersion', 'runId', 'role', 'startedAt', 'completedAt',
    'buildIdentity', 'scenarioResults',
  ];
  if (!strictObject(value, path, keys, keys, out)) return null;
  if (value.kind !== TASK_REGRESSION_RUN_KIND) out.add(`${path}.kind`, 'run_kind_mismatch');
  if (value.schemaVersion !== TASK_REGRESSION_RUN_SCHEMA_VERSION) out.add(`${path}.schemaVersion`, 'run_schema_version_mismatch');
  requiredString(value.runId, `${path}.runId`, out);
  enumValue(value.role, ['baseline', 'candidate'], `${path}.role`, out);
  isoInstant(value.startedAt, `${path}.startedAt`, out);
  isoInstant(value.completedAt, `${path}.completedAt`, out);
  if (Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt))
    && Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    out.add(`${path}.completedAt`, 'run_completion_before_start');
  }
  validateBuildIdentityInternal(value.buildIdentity, `${path}.buildIdentity`, out);
  if (typeof value.buildIdentity?.collectedAt === 'string'
    && Number.isFinite(Date.parse(value.buildIdentity.collectedAt))
    && Number.isFinite(Date.parse(value.completedAt))
    && Date.parse(value.buildIdentity.collectedAt) > Date.parse(value.completedAt)) {
    out.add(`${path}.buildIdentity.collectedAt`, 'build_identity_collected_after_run');
  }
  try {
    return taskRegressionBuildIdentityDigest(value.buildIdentity);
  } catch {
    return null;
  }
}

function validateRunInternal(value, path, out) {
  const buildIdentityDigest = validateRunHeaderInternal(value, path, out);
  if (!isPlainObject(value)) return;
  if (!Array.isArray(value.scenarioResults)) {
    out.add(`${path}.scenarioResults`, 'array_required');
    return;
  }
  if (value.scenarioResults.length !== TASK_REGRESSION_SCENARIOS.length) {
    out.add(`${path}.scenarioResults`, 'exactly_eight_scenarios_required');
  }
  const seenScenarios = new Set();
  const allSnapshotIds = new Set();
  value.scenarioResults.forEach((scenarioResult, index) => {
    const resultPath = `${path}.scenarioResults[${index}]`;
    validateScenarioResultInternal(scenarioResult, resultPath, out, {
      runId: value.runId,
      buildIdentityDigest,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
    });
    if (typeof scenarioResult?.scenarioId === 'string') {
      if (seenScenarios.has(scenarioResult.scenarioId)) out.add(`${resultPath}.scenarioId`, 'duplicate_scenario_result');
      seenScenarios.add(scenarioResult.scenarioId);
    }
    if (Array.isArray(scenarioResult?.snapshots)) {
      for (const snapshot of scenarioResult.snapshots) {
        if (typeof snapshot?.snapshotId !== 'string') continue;
        if (allSnapshotIds.has(snapshot.snapshotId)) {
          out.add(`${resultPath}.snapshots`, 'snapshot_id_reused_across_scenarios');
        }
        allSnapshotIds.add(snapshot.snapshotId);
      }
    }
  });
  for (const scenario of TASK_REGRESSION_SCENARIOS) {
    if (!seenScenarios.has(scenario.id)) {
      out.add(`${path}.scenarioResults`, 'required_scenario_missing', scenario.id);
    }
  }
}

export function validateTaskRegressionRun(value) {
  const out = collector();
  validateRunInternal(value, '$', out);
  return out.issues.length ? { ok: false, issues: out.issues } : { ok: true, value };
}

export function assertTaskRegressionRun(value) {
  const validation = validateTaskRegressionRun(value);
  if (!validation.ok) {
    throw new TaskRegressionArtifactError('task_regression_run_invalid', validation.issues);
  }
  return value;
}

function validateRunHeader(value) {
  const out = collector();
  const buildIdentityDigest = validateRunHeaderInternal(value, '$', out);
  return { ok: out.issues.length === 0, issues: out.issues, buildIdentityDigest };
}

function summarizeScenario(run, scenario, buildIdentityDigest, headerValid) {
  const matching = Array.isArray(run?.scenarioResults)
    ? run.scenarioResults.filter(result => result?.scenarioId === scenario.id)
    : [];
  if (matching.length !== 1) {
    return {
      scenarioId: scenario.id,
      ordinal: scenario.ordinal,
      passed: false,
      snapshotCount: matching[0]?.snapshots?.length || 0,
      checkCount: matching[0]?.checks?.length || 0,
      passedCheckCount: 0,
      failedChecks: [...scenario.checks],
      evidenceFailures: [matching.length === 0 ? 'scenario_result_missing' : 'duplicate_scenario_result'],
    };
  }
  const result = matching[0];
  const out = collector();
  validateScenarioResultInternal(result, '$', out, {
    runId: run.runId,
    buildIdentityDigest,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  });
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const failedChecks = scenario.checks.filter(checkId => {
    const matchingChecks = checks.filter(check => check?.checkId === checkId);
    return matchingChecks.length !== 1 || matchingChecks[0].passed !== true;
  });
  const evidenceFailures = [...new Set(out.issues.map(issue => issue.code))].sort();
  if (!headerValid) evidenceFailures.unshift('run_header_invalid');
  return {
    scenarioId: scenario.id,
    ordinal: scenario.ordinal,
    passed: headerValid && evidenceFailures.length === 0 && failedChecks.length === 0,
    snapshotCount: Array.isArray(result.snapshots) ? result.snapshots.length : 0,
    checkCount: checks.length,
    passedCheckCount: scenario.checks.length - failedChecks.length,
    failedChecks,
    evidenceFailures,
  };
}

export function summarizeTaskRegressionRun(value) {
  const fullValidation = validateTaskRegressionRun(value);
  const header = validateRunHeader(value);
  const scenarios = TASK_REGRESSION_SCENARIOS.map(scenario => (
    summarizeScenario(value, scenario, header.buildIdentityDigest, header.ok)
  ));
  const passedScenarioCount = scenarios.filter(scenario => scenario.passed).length;
  return {
    kind: 'lumi.task-regression-run-summary',
    schemaVersion: 1,
    runId: typeof value?.runId === 'string' ? value.runId : null,
    role: value?.role === 'baseline' || value?.role === 'candidate' ? value.role : null,
    buildIdentityDigest: header.buildIdentityDigest,
    revision: typeof value?.buildIdentity?.revision === 'string' ? value.buildIdentity.revision : null,
    sourceDirty: typeof value?.buildIdentity?.sourceDirty === 'boolean' ? value.buildIdentity.sourceDirty : null,
    artifactValid: fullValidation.ok,
    overallPassed: fullValidation.ok && passedScenarioCount === TASK_REGRESSION_SCENARIOS.length,
    scenarioCount: TASK_REGRESSION_SCENARIOS.length,
    passedScenarioCount,
    failedScenarioCount: TASK_REGRESSION_SCENARIOS.length - passedScenarioCount,
    scenarios,
    validationIssues: fullValidation.ok ? [] : fullValidation.issues,
  };
}

function revisionMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const normalized = expected.trim().toLowerCase();
  return /^[a-f0-9]{7,64}$/u.test(normalized) && actual.toLowerCase().startsWith(normalized);
}

export function compareTaskRegressionRuns(baseline, candidate, options = {}) {
  const baselineSummary = summarizeTaskRegressionRun(baseline);
  const candidateSummary = summarizeTaskRegressionRun(candidate);
  const comparisonIssues = [];
  if (baseline?.role !== 'baseline') comparisonIssues.push('baseline_role_required');
  if (candidate?.role !== 'candidate') comparisonIssues.push('candidate_role_required');
  if (options.requireBaselineClean !== false && baseline?.buildIdentity?.sourceDirty !== false) {
    comparisonIssues.push('clean_baseline_required');
  }
  if (options.requireCandidateDirty === true && candidate?.buildIdentity?.sourceDirty !== true) {
    comparisonIssues.push('dirty_candidate_required');
  }
  if (options.expectedBaselineRevision
    && !revisionMatches(baseline?.buildIdentity?.revision, options.expectedBaselineRevision)) {
    comparisonIssues.push('baseline_revision_mismatch');
  }
  if (options.expectedCandidateRevision
    && !revisionMatches(candidate?.buildIdentity?.revision, options.expectedCandidateRevision)) {
    comparisonIssues.push('candidate_revision_mismatch');
  }
  if (!baselineSummary.buildIdentityDigest || !candidateSummary.buildIdentityDigest
    || baselineSummary.buildIdentityDigest === candidateSummary.buildIdentityDigest) {
    comparisonIssues.push('distinct_build_identities_required');
  }
  if (baseline?.buildIdentity?.sourceFingerprintSha256
    && baseline.buildIdentity.sourceFingerprintSha256 === candidate?.buildIdentity?.sourceFingerprintSha256) {
    comparisonIssues.push('distinct_source_fingerprints_required');
  }
  if (baseline?.buildIdentity?.runtimeFingerprintSha256
    && baseline.buildIdentity.runtimeFingerprintSha256 === candidate?.buildIdentity?.runtimeFingerprintSha256) {
    comparisonIssues.push('distinct_runtime_fingerprints_required');
  }

  const scenarios = TASK_REGRESSION_SCENARIOS.map(scenario => {
    const baselineScenario = baselineSummary.scenarios.find(item => item.scenarioId === scenario.id);
    const candidateScenario = candidateSummary.scenarios.find(item => item.scenarioId === scenario.id);
    let delta = 'unchanged_fail';
    if (baselineScenario.passed && candidateScenario.passed) delta = 'unchanged_pass';
    else if (!baselineScenario.passed && candidateScenario.passed) delta = 'improved';
    else if (baselineScenario.passed && !candidateScenario.passed) delta = 'regressed';
    return {
      scenarioId: scenario.id,
      ordinal: scenario.ordinal,
      baselinePassed: baselineScenario.passed,
      candidatePassed: candidateScenario.passed,
      delta,
      baselineEvidenceFailures: baselineScenario.evidenceFailures,
      candidateEvidenceFailures: candidateScenario.evidenceFailures,
      baselineFailedChecks: baselineScenario.failedChecks,
      candidateFailedChecks: candidateScenario.failedChecks,
    };
  });
  const improvedScenarioCount = scenarios.filter(item => item.delta === 'improved').length;
  const regressedScenarioCount = scenarios.filter(item => item.delta === 'regressed').length;
  const comparisonValid = baselineSummary.artifactValid
    && candidateSummary.artifactValid
    && comparisonIssues.length === 0;
  const comparedAt = options.comparedAt || new Date().toISOString();
  const timestampOut = collector();
  isoInstant(comparedAt, '$.comparedAt', timestampOut);
  if (timestampOut.issues.length) comparisonIssues.push('compared_at_invalid');
  return {
    kind: TASK_REGRESSION_COMPARISON_KIND,
    schemaVersion: TASK_REGRESSION_COMPARISON_SCHEMA_VERSION,
    comparedAt,
    comparisonValid: comparisonValid && timestampOut.issues.length === 0,
    overallPassed: comparisonValid
      && timestampOut.issues.length === 0
      && candidateSummary.overallPassed
      && regressedScenarioCount === 0,
    comparisonIssues,
    baseline: baselineSummary,
    candidate: candidateSummary,
    counts: {
      scenarioCount: TASK_REGRESSION_SCENARIOS.length,
      baselinePassed: baselineSummary.passedScenarioCount,
      candidatePassed: candidateSummary.passedScenarioCount,
      improved: improvedScenarioCount,
      regressed: regressedScenarioCount,
      unchangedPass: scenarios.filter(item => item.delta === 'unchanged_pass').length,
      unchangedFail: scenarios.filter(item => item.delta === 'unchanged_fail').length,
    },
    scenarios,
  };
}
