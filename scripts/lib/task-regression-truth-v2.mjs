/**
 * Task-regression truth v2.
 *
 * This module is deliberately pure: it validates caller-owned JSON values and
 * derives adjudication results.  It does not read product state, use the
 * network, or accept a collector-authored `passed` value.
 */

export const TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND = 'lumi.task-regression-evidence-record';
export const TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND = 'lumi.task-regression-scenario-bundle';
export const TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION = 2;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/u;

export const TASK_REGRESSION_V2_OBSERVATION_KINDS = Object.freeze([
  'turn',
  'conversation_state',
  'action_set',
  'model_route',
  'model_noninvocation',
  'provider_attempt',
  'native_target',
  'target_correction',
  'channel_handoff',
  'stale_reclassification',
  'runtime_transition',
  'artifact_state',
  'absence_window',
]);

const RELATIONS = Object.freeze([
  'new', 'continue', 'correct', 'confirm', 'cancel', 'status', 'repeat', 'proposal',
]);
const TASK_STATUSES = Object.freeze([
  'created', 'planning', 'executing', 'waiting_confirmation', 'verifying',
  'completed', 'failed', 'cancelled', 'blocked',
]);
const TURN_TERMINAL_STATUSES = Object.freeze([
  'waiting_confirmation', 'completed', 'failed', 'cancelled', 'blocked',
]);
const RECEIPT_OUTCOMES = Object.freeze([
  'planned', 'running', 'waiting_confirmation', 'verified_success', 'failed',
  'cancelled', 'blocked', 'target_mismatch', 'forbidden', 'timeout', 'unknown_outcome',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/**
 * Scenario profiles are executable evidence contracts.  `notApplicable` is
 * documentary; `forbidden` is normative and its presence fails adjudication.
 */
export const TASK_REGRESSION_V2_SCENARIO_PROFILES = deepFreeze({
  cleanup_offer_then_cleanup: {
    phases: [
      {
        phaseId: 'offer', bindingKind: 'request',
        required: ['turn', 'action_set', 'model_route', 'provider_attempt'], forbidden: [],
        exactlyOneOf: [],
        action: { toolName: 'runtime_work_status', minimum: 1, maximum: 1, outcomes: ['verified_success'] },
        notApplicable: ['native_target'],
      },
      {
        phaseId: 'cleanup', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'action_set', 'model_noninvocation'],
        forbidden: ['model_route', 'provider_attempt'], exactlyOneOf: [],
        action: { toolName: 'runtime_work_cancel', minimum: 1, maximum: 1, outcomes: ['verified_success'] },
        notApplicable: ['native_target'],
      },
    ],
  },
  repeated_confirmation_exactly_once: {
    phases: [
      {
        phaseId: 'pending', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'action_set'], forbidden: [],
        exactlyOneOf: [['model_route', 'model_noninvocation']],
        action: {
          toolName: 'desktop_write_text_file', minimum: 1, maximum: 1,
          outcomes: ['waiting_confirmation'],
        },
        notApplicable: ['native_target'],
      },
      {
        phaseId: 'confirm_first', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'action_set', 'artifact_state', 'model_noninvocation'],
        forbidden: ['model_route'], exactlyOneOf: [],
        action: {
          toolName: 'desktop_write_text_file', minimum: 1, maximum: 1,
          outcomes: ['verified_success'],
        },
        notApplicable: ['native_target'],
      },
      {
        phaseId: 'confirm_repeat', bindingKind: 'request',
        required: ['turn', 'artifact_state', 'absence_window', 'model_noninvocation'],
        forbidden: ['action_set', 'model_route'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
    ],
  },
  wps_wrong_file_correction: {
    phases: [
      {
        phaseId: 'anchor', bindingKind: 'request',
        required: [
          'turn', 'action_set', 'native_target', 'artifact_state', 'model_route', 'provider_attempt',
        ],
        forbidden: [], exactlyOneOf: [],
        action: { toolName: 'desktop_active_window', minimum: 1, maximum: 1, outcomes: ['verified_success'] },
        notApplicable: [],
      },
      {
        phaseId: 'correction', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'model_route', 'provider_attempt'],
        forbidden: ['action_set'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'supply-filename', bindingKind: 'request',
        required: [
          'turn', 'conversation_state', 'action_set', 'native_target', 'artifact_state',
          'model_route', 'provider_attempt',
        ],
        forbidden: [], exactlyOneOf: [],
        action: { toolName: 'extract_document_text', minimum: 1, maximum: 1, outcomes: ['verified_success'] },
        notApplicable: [],
      },
    ],
  },
  displayed_result_stale_receipt: {
    phases: [
      {
        phaseId: 'display', bindingKind: 'request',
        required: ['turn', 'action_set', 'model_route', 'provider_attempt'], forbidden: [],
        exactlyOneOf: [],
        action: { toolName: 'read_file', minimum: 1, maximum: 1, outcomes: ['verified_success'] },
        notApplicable: ['native_target'],
      },
      {
        phaseId: 'inject_stale', bindingKind: 'system_event',
        required: ['stale_reclassification'], forbidden: ['turn', 'action_set', 'model_route'],
        exactlyOneOf: [], notApplicable: ['turn', 'action_set', 'native_target'],
      },
      {
        phaseId: 'continue', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'model_route', 'provider_attempt'], forbidden: [],
        exactlyOneOf: [],
        notApplicable: ['native_target'],
      },
    ],
  },
  control_stop_status_repeat: {
    phases: [
      {
        phaseId: 'long_start', bindingKind: 'request',
        required: ['turn', 'model_route', 'provider_attempt'], forbidden: ['action_set'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'stop', bindingKind: 'request',
        required: ['turn', 'model_noninvocation'], forbidden: ['action_set', 'model_route'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'status_after_cancel', bindingKind: 'request',
        required: ['turn', 'model_noninvocation'], forbidden: ['action_set', 'model_route'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'repeat_status', bindingKind: 'request',
        required: ['turn', 'absence_window', 'model_noninvocation'],
        forbidden: ['action_set', 'model_route'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
    ],
  },
  voice_to_text_continuation: {
    phases: [
      {
        phaseId: 'voice_start', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'action_set', 'model_route', 'provider_attempt'],
        forbidden: [], exactlyOneOf: [],
        action: { toolName: 'read_file', minimum: 1, maximum: 1, outcomes: ['failed'] },
        notApplicable: ['native_target'],
      },
      {
        phaseId: 'text_continue', bindingKind: 'request',
        required: [
          'turn', 'conversation_state', 'action_set', 'target_correction', 'channel_handoff',
          'model_route', 'provider_attempt',
        ],
        forbidden: [], exactlyOneOf: [],
        action: { toolName: 'read_file', minimum: 1, maximum: 1, outcomes: ['verified_success'] },
        notApplicable: ['native_target'],
      },
    ],
  },
  mid_task_restart_recovery: {
    phases: [
      {
        phaseId: 'prepare', bindingKind: 'request',
        required: [
          'turn', 'conversation_state', 'action_set', 'artifact_state',
          'model_route', 'provider_attempt',
        ],
        forbidden: [], exactlyOneOf: [],
        action: {
          toolName: 'desktop_write_text_file', minimum: 1, maximum: 1,
          outcomes: ['waiting_confirmation'],
        },
        notApplicable: ['native_target'],
      },
      {
        phaseId: 'restart', bindingKind: 'system_event',
        required: ['runtime_transition'], forbidden: ['turn', 'action_set'], exactlyOneOf: [],
        notApplicable: ['turn', 'action_set', 'native_target'],
      },
      {
        phaseId: 'recovered', bindingKind: 'system_event',
        required: ['conversation_state', 'runtime_transition'], forbidden: ['turn', 'action_set'],
        exactlyOneOf: [], notApplicable: ['turn', 'action_set', 'native_target'],
      },
      {
        phaseId: 'continue', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'action_set', 'artifact_state'], forbidden: [],
        exactlyOneOf: [['model_route', 'model_noninvocation']],
        action: {
          toolName: 'desktop_write_text_file', minimum: 1, maximum: 1,
          outcomes: ['verified_success'],
        },
        notApplicable: ['native_target'],
      },
    ],
  },
  primary_model_failover_lmstudio: {
    phases: [
      {
        phaseId: 'start', bindingKind: 'request',
        required: ['turn', 'conversation_state'], forbidden: ['action_set'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'primary_attempt_failed', bindingKind: 'system_event',
        required: ['provider_attempt'], forbidden: ['action_set'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'lmstudio_attempt_succeeded', bindingKind: 'system_event',
        required: ['provider_attempt', 'model_route'], forbidden: ['action_set'], exactlyOneOf: [],
        notApplicable: ['action_set', 'native_target'],
      },
      {
        phaseId: 'text_continue', bindingKind: 'request',
        required: ['turn', 'conversation_state', 'model_route', 'provider_attempt'],
        forbidden: ['action_set'],
        exactlyOneOf: [], notApplicable: ['action_set', 'native_target'],
      },
    ],
  },
});

export const TASK_REGRESSION_V2_SCENARIO_IDS = Object.freeze(
  Object.keys(TASK_REGRESSION_V2_SCENARIO_PROFILES),
);

const BINDING_SHAPES = deepFreeze({
  request: [
    'bindingKind', 'bindingId', 'requestId', 'conversationRef', 'turnNonceSha256', 'channel',
  ],
  system_event: [
    'bindingKind', 'bindingId', 'eventKind', 'eventNonceSha256', 'sourceBindingId',
  ],
  phase_transition: [
    'bindingKind', 'bindingId', 'fromPhaseId', 'toPhaseId', 'checkpointSha256',
  ],
});

const OBSERVATION_SHAPES = deepFreeze({
  turn: [
    'observationKind', 'requestRef', 'userMessageRef', 'assistantMessageRef', 'channel',
    'relation', 'targetTaskRef', 'targetRequestRef', 'terminalStatus', 'userVisibleReply',
  ],
  conversation_state: [
    'observationKind', 'tasks', 'pendingPointer', 'livePointer', 'pendingConfirmationCount',
  ],
  action_set: ['observationKind', 'requestRef', 'receipts'],
  model_route: [
    'observationKind', 'requestRef', 'routingReceiptRef', 'selectionMode', 'selectedProvider',
    'selectedModel', 'fallbackReason', 'attempts',
  ],
  model_noninvocation: ['observationKind', 'requestRef', 'executionOrigin', 'reasonCode'],
  provider_attempt: [
    'observationKind', 'requestRef', 'attemptOrdinal', 'endpointWitnessRef', 'provider', 'model',
    'status', 'httpStatus', 'errorCategory', 'requestSha256', 'turnNonceSha256',
    'responseSha256', 'visibleOutputCommitted',
  ],
  native_target: [
    'observationKind', 'coverageKind', 'applicationId', 'processName', 'windowTitleSha256',
    'documentTitle', 'documentIdentitySha256', 'source',
  ],
  target_correction: [
    'observationKind', 'sourceRequestRef', 'targetRequestRef', 'taskRef',
    'correctionMessageRef', 'previousTarget', 'replacementTarget',
    'previousTaskTargetSha256', 'replacementTaskTargetSha256', 'rejectedTargetSha256',
    'source',
  ],
  channel_handoff: [
    'observationKind', 'sourceRequestRef', 'targetRequestRef', 'sourceChannel', 'targetChannel',
    'captureMode', 'contextChainRef', 'sourceTaskRef', 'targetTaskRef', 'sourceMessageRefs',
    'targetMessageRef',
  ],
  stale_reclassification: [
    'observationKind', 'sourceReceiptRef', 'classifierInputSha256', 'mismatchDimension',
    'classification', 'archiveRef', 'sourceReceiptUnchanged', 'leaseReleased',
  ],
  runtime_transition: [
    'observationKind', 'restartScope', 'beforeEpochRef', 'afterEpochRef',
    'buildIdentitySha256', 'dataRootSha256', 'checkpointSha256',
  ],
  artifact_state: [
    'observationKind', 'artifactRef', 'exists', 'contentSha256', 'byteLength', 'mtimeMs',
    'identitySha256',
  ],
  absence_window: [
    'observationKind', 'assertion', 'startSequence', 'endSequence', 'sources',
    'matcherSha256', 'matchedRecordCount',
  ],
});

function branchSchema(discriminant, value, keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...keys],
    properties: Object.fromEntries(keys.map(key => [
      key,
      key === discriminant ? { const: value } : {},
    ])),
  };
}

/**
 * Exported JSON-Schema skeleton exposes the strict union surface.  The manual
 * validator below is authoritative for value ranges and cross-record joins.
 */
export const TASK_REGRESSION_EVIDENCE_RECORD_V2_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lumicore.local/schemas/task-regression-evidence-record.v2.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind', 'schemaVersion', 'evidenceId', 'runId', 'scenarioId', 'phaseId',
    'phaseOrdinal', 'monotonicSequence', 'capturedAt', 'binding', 'provenance', 'observation',
  ],
  properties: {
    kind: { const: TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND },
    schemaVersion: { const: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION },
    evidenceId: { type: 'string' },
    runId: { type: 'string' },
    scenarioId: { enum: TASK_REGRESSION_V2_SCENARIO_IDS },
    phaseId: { type: 'string' },
    phaseOrdinal: { type: 'integer', minimum: 1 },
    monotonicSequence: { type: 'integer', minimum: 1 },
    capturedAt: { type: 'string', format: 'date-time' },
    binding: {
      oneOf: Object.entries(BINDING_SHAPES)
        .map(([kind, keys]) => branchSchema('bindingKind', kind, keys)),
    },
    provenance: { type: 'object' },
    observation: {
      oneOf: Object.entries(OBSERVATION_SHAPES)
        .map(([kind, keys]) => branchSchema('observationKind', kind, keys)),
    },
  },
});

export const TASK_REGRESSION_SCENARIO_BUNDLE_V2_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://lumicore.local/schemas/task-regression-scenario-bundle.v2.json',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'schemaVersion', 'bundleId', 'runId', 'scenarioId', 'coverageMode', 'evidence'],
  properties: {
    kind: { const: TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND },
    schemaVersion: { const: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION },
    bundleId: { type: 'string' },
    runId: { type: 'string' },
    scenarioId: { enum: TASK_REGRESSION_V2_SCENARIO_IDS },
    coverageMode: { enum: ['portable_external', 'isolated_backend', 'formal_native'] },
    evidence: { type: 'array', minItems: 1, items: TASK_REGRESSION_EVIDENCE_RECORD_V2_SCHEMA },
  },
});

export class TaskRegressionTruthV2Error extends Error {
  constructor(code, issues = []) {
    super(code);
    this.name = 'TaskRegressionTruthV2Error';
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

function strictObject(value, path, keys, out) {
  if (!isPlainObject(value)) {
    out.add(path, 'object_required');
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) out.add(`${path}.${key}`, 'unknown_property');
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) out.add(`${path}.${key}`, 'required');
  }
  return true;
}

function requiredString(value, path, out, maximum = 16_384) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum) {
    out.add(path, 'nonempty_trimmed_string_required');
    return false;
  }
  return true;
}

function identifier(value, path, out) {
  if (!requiredString(value, path, out, 240)) return false;
  if (!ID_RE.test(value)) {
    out.add(path, 'identifier_invalid');
    return false;
  }
  return true;
}

function nullableIdentifier(value, path, out) {
  return value === null ? true : identifier(value, path, out);
}

function sha256(value, path, out, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    out.add(path, 'sha256_required');
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

function nullableInteger(value, path, out, minimum = 0) {
  return value === null ? true : integer(value, path, out, minimum);
}

function enumValue(value, allowed, path, out) {
  if (!allowed.includes(value)) {
    out.add(path, 'enum_value_required', `expected one of: ${allowed.join(', ')}`);
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

function validateReply(value, path, out) {
  if (value === null) return;
  const keys = ['messageRef', 'textSha256', 'textCharCount', 'recordedAt'];
  if (!strictObject(value, path, keys, out)) return;
  identifier(value.messageRef, `${path}.messageRef`, out);
  sha256(value.textSha256, `${path}.textSha256`, out);
  integer(value.textCharCount, `${path}.textCharCount`, out);
  isoInstant(value.recordedAt, `${path}.recordedAt`, out);
}

function validatePointer(value, path, out) {
  const keys = ['state', 'taskRef', 'requestRef', 'revision'];
  if (!strictObject(value, path, keys, out)) return;
  enumValue(value.state, ['set', 'cleared', 'missing', 'conflict'], `${path}.state`, out);
  nullableIdentifier(value.taskRef, `${path}.taskRef`, out);
  nullableIdentifier(value.requestRef, `${path}.requestRef`, out);
  nullableInteger(value.revision, `${path}.revision`, out);
  if (value.state === 'set' && value.taskRef === null) out.add(`${path}.taskRef`, 'set_pointer_owner_required');
  if ((value.state === 'cleared' || value.state === 'missing')
    && (value.taskRef !== null || value.requestRef !== null)) {
    out.add(path, 'ownerless_pointer_must_not_have_owner');
  }
}

function validateTask(value, path, out) {
  const keys = [
    'taskRef', 'status', 'revision', 'activeRequestRef', 'goalSha256', 'targetSha256',
    'capsuleRevision',
  ];
  if (!strictObject(value, path, keys, out)) return;
  identifier(value.taskRef, `${path}.taskRef`, out);
  enumValue(value.status, TASK_STATUSES, `${path}.status`, out);
  integer(value.revision, `${path}.revision`, out);
  nullableIdentifier(value.activeRequestRef, `${path}.activeRequestRef`, out);
  sha256(value.goalSha256, `${path}.goalSha256`, out);
  sha256(value.targetSha256, `${path}.targetSha256`, out);
  nullableInteger(value.capsuleRevision, `${path}.capsuleRevision`, out);
}

function validateTarget(value, path, out) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    out.add(path, 'object_required');
    return;
  }
  const kind = value.targetKind;
  const shapes = {
    filesystem: ['targetKind', 'canonicalPathHmac', 'displayName', 'source'],
    application_document: [
      'targetKind', 'applicationId', 'processName', 'windowTitleSha256', 'documentTitle',
      'canonicalPathHmac', 'source',
    ],
    runtime_work_set: ['targetKind', 'workSetSha256', 'workCount', 'source'],
    none: ['targetKind', 'reasonCode'],
  };
  if (!Object.prototype.hasOwnProperty.call(shapes, kind)) {
    out.add(`${path}.targetKind`, 'target_discriminant_invalid');
    return;
  }
  if (!strictObject(value, path, shapes[kind], out)) return;
  if (kind === 'filesystem') {
    sha256(value.canonicalPathHmac, `${path}.canonicalPathHmac`, out);
    requiredString(value.displayName, `${path}.displayName`, out, 500);
    requiredString(value.source, `${path}.source`, out, 120);
  } else if (kind === 'application_document') {
    requiredString(value.applicationId, `${path}.applicationId`, out, 120);
    requiredString(value.processName, `${path}.processName`, out, 240);
    sha256(value.windowTitleSha256, `${path}.windowTitleSha256`, out);
    requiredString(value.documentTitle, `${path}.documentTitle`, out, 500);
    sha256(value.canonicalPathHmac, `${path}.canonicalPathHmac`, out, { nullable: true });
    requiredString(value.source, `${path}.source`, out, 120);
  } else if (kind === 'runtime_work_set') {
    sha256(value.workSetSha256, `${path}.workSetSha256`, out);
    integer(value.workCount, `${path}.workCount`, out);
    requiredString(value.source, `${path}.source`, out, 120);
  } else {
    requiredString(value.reasonCode, `${path}.reasonCode`, out, 120);
  }
}

function validateReceipt(value, path, out) {
  const keys = [
    'receiptRef', 'taskRef', 'requestRef', 'toolName', 'outcome', 'idempotencyKeySha256',
    'inputSha256', 'executionOrigin', 'target',
  ];
  if (!strictObject(value, path, keys, out)) return;
  identifier(value.receiptRef, `${path}.receiptRef`, out);
  identifier(value.taskRef, `${path}.taskRef`, out);
  identifier(value.requestRef, `${path}.requestRef`, out);
  requiredString(value.toolName, `${path}.toolName`, out, 240);
  enumValue(value.outcome, RECEIPT_OUTCOMES, `${path}.outcome`, out);
  sha256(value.idempotencyKeySha256, `${path}.idempotencyKeySha256`, out);
  sha256(value.inputSha256, `${path}.inputSha256`, out);
  enumValue(
    value.executionOrigin,
    ['model_tool_call', 'confirmed_action_resume', 'deterministic_route', 'recovery'],
    `${path}.executionOrigin`,
    out,
  );
  validateTarget(value.target, `${path}.target`, out);
}

function validateAttempt(value, path, out) {
  const keys = [
    'attemptOrdinal', 'provider', 'model', 'status', 'errorCategory',
    'visibleOutputCommitted', 'outboundEvidenceSha256', 'providerWitnessRef',
  ];
  if (!strictObject(value, path, keys, out)) return;
  integer(value.attemptOrdinal, `${path}.attemptOrdinal`, out, 1);
  requiredString(value.provider, `${path}.provider`, out, 120);
  requiredString(value.model, `${path}.model`, out, 240);
  enumValue(value.status, ['succeeded', 'failed', 'skipped'], `${path}.status`, out);
  if (value.errorCategory !== null) requiredString(value.errorCategory, `${path}.errorCategory`, out, 120);
  if (typeof value.visibleOutputCommitted !== 'boolean') out.add(`${path}.visibleOutputCommitted`, 'boolean_required');
  sha256(value.outboundEvidenceSha256, `${path}.outboundEvidenceSha256`, out, { nullable: true });
  nullableIdentifier(value.providerWitnessRef, `${path}.providerWitnessRef`, out);
}

function validateObservation(value, path, out) {
  if (!isPlainObject(value)) {
    out.add(path, 'object_required');
    return;
  }
  const kind = value.observationKind;
  const shape = OBSERVATION_SHAPES[kind];
  if (!shape) {
    out.add(`${path}.observationKind`, 'observation_discriminant_invalid');
    return;
  }
  if (!strictObject(value, path, shape, out)) return;

  if (kind === 'turn') {
    identifier(value.requestRef, `${path}.requestRef`, out);
    identifier(value.userMessageRef, `${path}.userMessageRef`, out);
    nullableIdentifier(value.assistantMessageRef, `${path}.assistantMessageRef`, out);
    enumValue(value.channel, ['text', 'voice', 'task'], `${path}.channel`, out);
    enumValue(value.relation, RELATIONS, `${path}.relation`, out);
    nullableIdentifier(value.targetTaskRef, `${path}.targetTaskRef`, out);
    nullableIdentifier(value.targetRequestRef, `${path}.targetRequestRef`, out);
    enumValue(value.terminalStatus, TURN_TERMINAL_STATUSES, `${path}.terminalStatus`, out);
    validateReply(value.userVisibleReply, `${path}.userVisibleReply`, out);
  } else if (kind === 'conversation_state') {
    if (!Array.isArray(value.tasks)) out.add(`${path}.tasks`, 'array_required');
    else {
      const seen = new Set();
      value.tasks.forEach((task, index) => {
        validateTask(task, `${path}.tasks[${index}]`, out);
        const taskRef = typeof task?.taskRef === 'string' ? task.taskRef : '';
        if (taskRef && seen.has(taskRef)) out.add(`${path}.tasks[${index}].taskRef`, 'duplicate_task_ref');
        seen.add(taskRef);
      });
    }
    validatePointer(value.pendingPointer, `${path}.pendingPointer`, out);
    validatePointer(value.livePointer, `${path}.livePointer`, out);
    integer(value.pendingConfirmationCount, `${path}.pendingConfirmationCount`, out);
  } else if (kind === 'action_set') {
    identifier(value.requestRef, `${path}.requestRef`, out);
    if (!Array.isArray(value.receipts)) out.add(`${path}.receipts`, 'array_required');
    else {
      const seen = new Set();
      value.receipts.forEach((receipt, index) => {
        validateReceipt(receipt, `${path}.receipts[${index}]`, out);
        const receiptRef = typeof receipt?.receiptRef === 'string' ? receipt.receiptRef : '';
        if (receiptRef && seen.has(receiptRef)) {
          out.add(`${path}.receipts[${index}].receiptRef`, 'duplicate_receipt_ref');
        }
        seen.add(receiptRef);
        if (receipt?.requestRef !== value.requestRef) {
          out.add(`${path}.receipts[${index}].requestRef`, 'action_set_request_binding_mismatch');
        }
      });
    }
  } else if (kind === 'model_route') {
    identifier(value.requestRef, `${path}.requestRef`, out);
    identifier(value.routingReceiptRef, `${path}.routingReceiptRef`, out);
    enumValue(value.selectionMode, ['pinned', 'ordered_fallback', 'auto'], `${path}.selectionMode`, out);
    requiredString(value.selectedProvider, `${path}.selectedProvider`, out, 120);
    requiredString(value.selectedModel, `${path}.selectedModel`, out, 240);
    if (value.fallbackReason !== null) requiredString(value.fallbackReason, `${path}.fallbackReason`, out, 500);
    if (!Array.isArray(value.attempts) || value.attempts.length === 0) {
      out.add(`${path}.attempts`, 'nonempty_array_required');
    } else {
      const ordinals = new Set();
      value.attempts.forEach((attempt, index) => {
        validateAttempt(attempt, `${path}.attempts[${index}]`, out);
        if (ordinals.has(attempt?.attemptOrdinal)) {
          out.add(`${path}.attempts[${index}].attemptOrdinal`, 'duplicate_attempt_ordinal');
        }
        ordinals.add(attempt?.attemptOrdinal);
      });
    }
  } else if (kind === 'model_noninvocation') {
    identifier(value.requestRef, `${path}.requestRef`, out);
    enumValue(
      value.executionOrigin,
      ['confirmed_action_resume', 'deterministic_route', 'request_only_control'],
      `${path}.executionOrigin`,
      out,
    );
    requiredString(value.reasonCode, `${path}.reasonCode`, out, 160);
  } else if (kind === 'provider_attempt') {
    identifier(value.requestRef, `${path}.requestRef`, out);
    integer(value.attemptOrdinal, `${path}.attemptOrdinal`, out, 1);
    identifier(value.endpointWitnessRef, `${path}.endpointWitnessRef`, out);
    requiredString(value.provider, `${path}.provider`, out, 120);
    requiredString(value.model, `${path}.model`, out, 240);
    enumValue(value.status, ['succeeded', 'failed'], `${path}.status`, out);
    integer(value.httpStatus, `${path}.httpStatus`, out);
    if (value.errorCategory !== null) requiredString(value.errorCategory, `${path}.errorCategory`, out, 120);
    sha256(value.requestSha256, `${path}.requestSha256`, out);
    sha256(value.turnNonceSha256, `${path}.turnNonceSha256`, out);
    sha256(value.responseSha256, `${path}.responseSha256`, out);
    if (typeof value.visibleOutputCommitted !== 'boolean') out.add(`${path}.visibleOutputCommitted`, 'boolean_required');
  } else if (kind === 'native_target') {
    enumValue(value.coverageKind, ['synthetic_adapter', 'real_native'], `${path}.coverageKind`, out);
    for (const key of ['applicationId', 'processName', 'documentTitle', 'source']) {
      requiredString(value[key], `${path}.${key}`, out, key === 'documentTitle' ? 500 : 240);
    }
    sha256(value.windowTitleSha256, `${path}.windowTitleSha256`, out);
    sha256(value.documentIdentitySha256, `${path}.documentIdentitySha256`, out);
  } else if (kind === 'target_correction') {
    for (const key of ['sourceRequestRef', 'targetRequestRef', 'taskRef', 'correctionMessageRef']) {
      identifier(value[key], `${path}.${key}`, out);
    }
    validateTarget(value.previousTarget, `${path}.previousTarget`, out);
    validateTarget(value.replacementTarget, `${path}.replacementTarget`, out);
    sha256(value.previousTaskTargetSha256, `${path}.previousTaskTargetSha256`, out);
    sha256(value.replacementTaskTargetSha256, `${path}.replacementTaskTargetSha256`, out);
    sha256(value.rejectedTargetSha256, `${path}.rejectedTargetSha256`, out);
    enumValue(value.source, ['user_correction'], `${path}.source`, out);
  } else if (kind === 'channel_handoff') {
    for (const key of ['sourceRequestRef', 'targetRequestRef']) identifier(value[key], `${path}.${key}`, out);
    enumValue(value.sourceChannel, ['voice'], `${path}.sourceChannel`, out);
    enumValue(value.targetChannel, ['text'], `${path}.targetChannel`, out);
    enumValue(
      value.captureMode,
      ['synthetic_accepted_transcript'],
      `${path}.captureMode`,
      out,
    );
    nullableIdentifier(value.contextChainRef, `${path}.contextChainRef`, out);
    nullableIdentifier(value.sourceTaskRef, `${path}.sourceTaskRef`, out);
    nullableIdentifier(value.targetTaskRef, `${path}.targetTaskRef`, out);
    identifier(value.targetMessageRef, `${path}.targetMessageRef`, out);
    if (!Array.isArray(value.sourceMessageRefs) || value.sourceMessageRefs.length < 2) {
      out.add(`${path}.sourceMessageRefs`, 'at_least_two_source_messages_required');
    } else {
      value.sourceMessageRefs.forEach((item, index) => identifier(item, `${path}.sourceMessageRefs[${index}]`, out));
    }
  } else if (kind === 'stale_reclassification') {
    identifier(value.sourceReceiptRef, `${path}.sourceReceiptRef`, out);
    sha256(value.classifierInputSha256, `${path}.classifierInputSha256`, out);
    enumValue(value.mismatchDimension, ['task_id', 'request_id', 'task_revision'], `${path}.mismatchDimension`, out);
    enumValue(value.classification, ['stale'], `${path}.classification`, out);
    identifier(value.archiveRef, `${path}.archiveRef`, out);
    if (value.sourceReceiptUnchanged !== true) out.add(`${path}.sourceReceiptUnchanged`, 'source_receipt_must_remain_unchanged');
    if (value.leaseReleased !== true) out.add(`${path}.leaseReleased`, 'stale_transition_must_release_lease');
  } else if (kind === 'runtime_transition') {
    enumValue(value.restartScope, ['backend-only', 'client-only', 'both'], `${path}.restartScope`, out);
    identifier(value.beforeEpochRef, `${path}.beforeEpochRef`, out);
    identifier(value.afterEpochRef, `${path}.afterEpochRef`, out);
    if (value.beforeEpochRef === value.afterEpochRef) out.add(path, 'runtime_epoch_must_change');
    sha256(value.buildIdentitySha256, `${path}.buildIdentitySha256`, out);
    sha256(value.dataRootSha256, `${path}.dataRootSha256`, out);
    sha256(value.checkpointSha256, `${path}.checkpointSha256`, out);
  } else if (kind === 'artifact_state') {
    identifier(value.artifactRef, `${path}.artifactRef`, out);
    if (typeof value.exists !== 'boolean') out.add(`${path}.exists`, 'boolean_required');
    sha256(value.contentSha256, `${path}.contentSha256`, out, { nullable: true });
    integer(value.byteLength, `${path}.byteLength`, out);
    nullableInteger(value.mtimeMs, `${path}.mtimeMs`, out);
    sha256(value.identitySha256, `${path}.identitySha256`, out, { nullable: true });
    if (!value.exists && (value.contentSha256 !== null || value.byteLength !== 0
      || value.mtimeMs !== null || value.identitySha256 !== null)) {
      out.add(path, 'absent_artifact_must_not_have_identity');
    }
  } else if (kind === 'absence_window') {
    requiredString(value.assertion, `${path}.assertion`, out, 160);
    integer(value.startSequence, `${path}.startSequence`, out, 1);
    integer(value.endSequence, `${path}.endSequence`, out, 1);
    if (Number.isSafeInteger(value.startSequence) && Number.isSafeInteger(value.endSequence)
      && value.endSequence < value.startSequence) out.add(path, 'absence_window_reversed');
    if (!Array.isArray(value.sources) || value.sources.length < 2) {
      out.add(`${path}.sources`, 'at_least_two_absence_sources_required');
    } else {
      const seen = new Set();
      value.sources.forEach((source, index) => {
        requiredString(source, `${path}.sources[${index}]`, out, 120);
        if (seen.has(source)) out.add(`${path}.sources[${index}]`, 'duplicate_absence_source');
        seen.add(source);
      });
    }
    sha256(value.matcherSha256, `${path}.matcherSha256`, out);
    integer(value.matchedRecordCount, `${path}.matchedRecordCount`, out);
  }
}

function validateBinding(value, path, out) {
  if (!isPlainObject(value)) {
    out.add(path, 'object_required');
    return;
  }
  const kind = value.bindingKind;
  const shape = BINDING_SHAPES[kind];
  if (!shape) {
    out.add(`${path}.bindingKind`, 'binding_discriminant_invalid');
    return;
  }
  if (!strictObject(value, path, shape, out)) return;
  identifier(value.bindingId, `${path}.bindingId`, out);
  if (kind === 'request') {
    identifier(value.requestId, `${path}.requestId`, out);
    identifier(value.conversationRef, `${path}.conversationRef`, out);
    sha256(value.turnNonceSha256, `${path}.turnNonceSha256`, out);
    enumValue(value.channel, ['text', 'voice', 'task'], `${path}.channel`, out);
  } else if (kind === 'system_event') {
    enumValue(
      value.eventKind,
      [
        'stale_reclassification', 'backend_restart', 'post_restart_recovery',
        'primary_model_attempt', 'fallback_model_attempt',
      ],
      `${path}.eventKind`,
      out,
    );
    sha256(value.eventNonceSha256, `${path}.eventNonceSha256`, out);
    nullableIdentifier(value.sourceBindingId, `${path}.sourceBindingId`, out);
  } else {
    identifier(value.fromPhaseId, `${path}.fromPhaseId`, out);
    identifier(value.toPhaseId, `${path}.toPhaseId`, out);
    sha256(value.checkpointSha256, `${path}.checkpointSha256`, out);
  }
}

function validateProvenance(value, path, out) {
  const keys = ['lane', 'collector', 'collectorArtifactSha256', 'recordSha256', 'attestation'];
  if (!strictObject(value, path, keys, out)) return;
  enumValue(value.lane, ['portable_external', 'runtime_internal', 'formal_native'], `${path}.lane`, out);
  enumValue(
    value.collector,
    [
      'runner_socket', 'passive_store_probe', 'provider_witness', 'filesystem_witness',
      'runtime_truth', 'native_witness', 'adjudication_controller',
    ],
    `${path}.collector`,
    out,
  );
  sha256(value.collectorArtifactSha256, `${path}.collectorArtifactSha256`, out);
  sha256(value.recordSha256, `${path}.recordSha256`, out);
  if (!isPlainObject(value.attestation)) {
    out.add(`${path}.attestation`, 'object_required');
    return;
  }
  if (value.attestation.kind === 'controller_ed25519_v1') {
    const attestationKeys = ['kind', 'keyId', 'signature'];
    if (!strictObject(value.attestation, `${path}.attestation`, attestationKeys, out)) return;
    sha256(value.attestation.keyId, `${path}.attestation.keyId`, out);
    requiredString(value.attestation.signature, `${path}.attestation.signature`, out, 1024);
  } else if (value.attestation.kind === 'installation_hmac_sha256_v1') {
    const attestationKeys = ['kind', 'keyId', 'mac'];
    if (!strictObject(value.attestation, `${path}.attestation`, attestationKeys, out)) return;
    sha256(value.attestation.keyId, `${path}.attestation.keyId`, out);
    sha256(value.attestation.mac, `${path}.attestation.mac`, out);
  } else {
    out.add(`${path}.attestation.kind`, 'attestation_discriminant_invalid');
  }
}

function validateEvidenceRecordInternal(value, path, out) {
  const keys = [
    'kind', 'schemaVersion', 'evidenceId', 'runId', 'scenarioId', 'phaseId',
    'phaseOrdinal', 'monotonicSequence', 'capturedAt', 'binding', 'provenance', 'observation',
  ];
  if (!strictObject(value, path, keys, out)) return;
  if (value.kind !== TASK_REGRESSION_EVIDENCE_RECORD_V2_KIND) out.add(`${path}.kind`, 'evidence_kind_mismatch');
  if (value.schemaVersion !== TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION) {
    out.add(`${path}.schemaVersion`, 'evidence_schema_version_mismatch');
  }
  identifier(value.evidenceId, `${path}.evidenceId`, out);
  identifier(value.runId, `${path}.runId`, out);
  enumValue(value.scenarioId, TASK_REGRESSION_V2_SCENARIO_IDS, `${path}.scenarioId`, out);
  identifier(value.phaseId, `${path}.phaseId`, out);
  integer(value.phaseOrdinal, `${path}.phaseOrdinal`, out, 1);
  integer(value.monotonicSequence, `${path}.monotonicSequence`, out, 1);
  isoInstant(value.capturedAt, `${path}.capturedAt`, out);
  validateBinding(value.binding, `${path}.binding`, out);
  validateProvenance(value.provenance, `${path}.provenance`, out);
  validateObservation(value.observation, `${path}.observation`, out);

  const requestId = value.binding?.bindingKind === 'request' ? value.binding.requestId : null;
  const observationRequestRef = [
    'turn', 'action_set', 'model_route', 'model_noninvocation', 'provider_attempt',
  ].includes(value.observation?.observationKind)
    ? value.observation.requestRef
    : null;
  if (requestId && observationRequestRef && requestId !== observationRequestRef) {
    out.add(`${path}.observation.requestRef`, 'request_binding_mismatch');
  }
}

export function validateTaskRegressionEvidenceRecordV2(value) {
  const out = collector();
  validateEvidenceRecordInternal(value, '$', out);
  return out.issues.length ? { ok: false, issues: out.issues } : { ok: true, value };
}

export function assertTaskRegressionEvidenceRecordV2(value) {
  const result = validateTaskRegressionEvidenceRecordV2(value);
  if (!result.ok) throw new TaskRegressionTruthV2Error('task_regression_evidence_v2_invalid', result.issues);
  return value;
}

function addCheck(checks, checkId, issues, evidenceIds = []) {
  checks.push({
    checkId,
    passed: issues.length === 0,
    evidenceIds: [...new Set(evidenceIds)].sort(),
    failureCodes: [...new Set(issues.map(issue => issue.code))].sort(),
  });
}

function phaseEvidence(records, phaseId, observationKind) {
  return records.filter(record => record?.phaseId === phaseId
    && (!observationKind || record?.observation?.observationKind === observationKind));
}

function validatePhaseContract(bundle, profile, records, out, checks) {
  for (let index = 0; index < profile.phases.length; index += 1) {
    const phase = profile.phases[index];
    const phasePath = `$.phase[${phase.phaseId}]`;
    const phaseIssuesStart = out.issues.length;
    const selected = phaseEvidence(records, phase.phaseId);
    const kinds = selected.map(record => record.observation?.observationKind);
    const evidenceIds = selected.map(record => record.evidenceId).filter(Boolean);
    if (selected.length === 0) out.add(phasePath, 'required_phase_missing');
    for (const record of selected) {
      if (record.binding?.bindingKind !== phase.bindingKind) {
        out.add(`${phasePath}.binding`, 'phase_binding_kind_mismatch');
      }
      if (record.phaseOrdinal !== index + 1) {
        out.add(`${phasePath}.phaseOrdinal`, 'phase_ordinal_mismatch');
      }
    }
    for (const kind of phase.required || []) {
      if (!kinds.includes(kind)) out.add(phasePath, 'required_phase_evidence_missing', kind);
    }
    for (const kind of phase.forbidden || []) {
      if (kinds.includes(kind)) out.add(phasePath, 'forbidden_phase_evidence_present', kind);
    }
    for (const alternatives of phase.exactlyOneOf || []) {
      const present = alternatives.filter(kind => kinds.includes(kind));
      if (present.length !== 1) {
        out.add(phasePath, 'phase_evidence_exactly_one_required', alternatives.join('|'));
      }
    }
    if (phase.action) {
      const receipts = phaseEvidence(records, phase.phaseId, 'action_set')
        .flatMap(record => Array.isArray(record.observation?.receipts) ? record.observation.receipts : [])
        .filter(receipt => receipt?.toolName === phase.action.toolName);
      if (receipts.length < phase.action.minimum) {
        out.add(phasePath, 'required_action_receipt_missing', phase.action.toolName);
      }
      if (receipts.length > phase.action.maximum) {
        out.add(
          phasePath,
          phase.action.maximum === 1 ? 'ambiguous_receipt_binding' : 'action_receipt_cardinality_exceeded',
          phase.action.toolName,
        );
      }
      receipts.forEach(receipt => {
        if (!phase.action.outcomes.includes(receipt?.outcome)) {
          out.add(phasePath, 'action_receipt_outcome_mismatch', receipt?.outcome || '');
        }
      });
    }
    addCheck(
      checks,
      `phase:${phase.phaseId}:evidence_contract`,
      out.issues.slice(phaseIssuesStart),
      evidenceIds,
    );
  }

  for (let index = 1; index < profile.phases.length; index += 1) {
    const prior = phaseEvidence(records, profile.phases[index - 1].phaseId);
    const current = phaseEvidence(records, profile.phases[index].phaseId);
    if (!prior.length || !current.length) continue;
    const priorMaximum = Math.max(...prior.map(record => record.monotonicSequence));
    const currentMinimum = Math.min(...current.map(record => record.monotonicSequence));
    if (priorMaximum >= currentMinimum) {
      out.add(`$.phase[${profile.phases[index].phaseId}]`, 'phase_sequence_not_monotonic');
    }
  }
}

function exactPhaseObservation(records, phaseId, observationKind, out, failureCode) {
  const selected = phaseEvidence(records, phaseId, observationKind);
  if (selected.length !== 1) {
    out.add(`$.phase[${phaseId}].${observationKind}`, failureCode);
    return null;
  }
  return selected[0];
}

function exactActionReceipt(records, phaseId, toolName, out, failureCode) {
  const action = exactPhaseObservation(
    records,
    phaseId,
    'action_set',
    out,
    `${failureCode}_action_set_cardinality_invalid`,
  );
  const receipts = Array.isArray(action?.observation?.receipts) ? action.observation.receipts : [];
  const matching = receipts.filter(receipt => receipt?.toolName === toolName);
  if (receipts.length !== 1 || matching.length !== 1) {
    out.add(`$.phase[${phaseId}].action_set`, `${failureCode}_receipt_cardinality_invalid`);
    return null;
  }
  return matching[0];
}

function validatePhaseBindingCohesion(records, phaseIds, out) {
  const bindings = new Map();
  for (const phaseId of phaseIds) {
    const selected = phaseEvidence(records, phaseId);
    if (!selected.length) continue;
    const binding = selected[0]?.binding || null;
    bindings.set(phaseId, binding);
    const expected = canonicalJson(binding);
    if (selected.some(record => canonicalJson(record?.binding) !== expected)) {
      out.add(`$.phase[${phaseId}].binding`, 'phase_binding_identity_mismatch');
    }
    if (binding?.bindingKind === 'request') {
      for (const record of selected) {
        if (record.observation?.observationKind === 'turn'
          && record.observation?.channel !== binding.channel) {
          out.add(`$.phase[${phaseId}].turn.channel`, 'turn_binding_channel_mismatch');
        }
        if (record.observation?.observationKind === 'channel_handoff'
          && record.observation?.targetRequestRef !== binding.requestId) {
          out.add(
            `$.phase[${phaseId}].channel_handoff.targetRequestRef`,
            'handoff_target_binding_mismatch',
          );
        }
      }
    }
  }
  return bindings;
}

function validateModelProviderJoin({
  routeRecord,
  providerRecords,
  requestBinding,
  requestRef,
  path,
  out,
}) {
  const route = routeRecord?.observation;
  const providers = providerRecords.filter(Boolean);
  const attempts = Array.isArray(route?.attempts) ? route.attempts : [];
  let invalid = false;
  if (!route || route.observationKind !== 'model_route'
    || route.requestRef !== requestRef
    || requestBinding?.bindingKind !== 'request'
    || requestBinding.requestId !== requestRef
    || attempts.length === 0
    || providers.length !== attempts.length) {
    invalid = true;
  }
  const usedProviderEvidence = new Set();
  for (const attempt of attempts) {
    const matches = providers.filter(record => {
      const provider = record?.observation;
      return provider?.requestRef === requestRef
        && provider?.attemptOrdinal === attempt?.attemptOrdinal
        && provider?.endpointWitnessRef === attempt?.providerWitnessRef
        && provider?.provider === attempt?.provider
        && provider?.model === attempt?.model;
    });
    if (matches.length !== 1) {
      invalid = true;
      continue;
    }
    const match = matches[0];
    usedProviderEvidence.add(match.evidenceId);
    const provider = match.observation;
    if (provider.status !== attempt.status
      || provider.errorCategory !== attempt.errorCategory
      || provider.visibleOutputCommitted !== attempt.visibleOutputCommitted
      || provider.requestSha256 !== attempt.outboundEvidenceSha256
      || provider.turnNonceSha256 !== requestBinding.turnNonceSha256) {
      invalid = true;
    }
  }
  const selectedAttempts = attempts.filter(attempt => (
    attempt?.status === 'succeeded'
      && attempt?.provider === route?.selectedProvider
      && attempt?.model === route?.selectedModel
  ));
  if (selectedAttempts.length !== 1 || usedProviderEvidence.size !== providers.length) invalid = true;
  if (invalid) out.add(path, 'model_provider_request_marker_join_invalid');
  return !invalid;
}

function validateRequestPhaseModel(records, phaseId, bindings, out) {
  const route = exactPhaseObservation(
    records,
    phaseId,
    'model_route',
    out,
    'model_route_cardinality_invalid',
  );
  const providers = phaseEvidence(records, phaseId, 'provider_attempt');
  const binding = bindings.get(phaseId);
  return validateModelProviderJoin({
    routeRecord: route,
    providerRecords: providers,
    requestBinding: binding,
    requestRef: binding?.requestId,
    path: `$.phase[${phaseId}].model_route`,
    out,
  });
}

function taskFromState(stateRecord, taskRef, out, path, failureCode) {
  const tasks = Array.isArray(stateRecord?.observation?.tasks) ? stateRecord.observation.tasks : [];
  const matches = tasks.filter(task => task?.taskRef === taskRef);
  if (!taskRef || matches.length !== 1) {
    out.add(path, failureCode);
    return null;
  }
  return matches[0];
}

function pointerIs(pointer, state, taskRef = null, requestRef = null) {
  return pointer?.state === state
    && pointer?.taskRef === taskRef
    && pointer?.requestRef === requestRef;
}

function sameTarget(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sameArtifact(left, right) {
  return ['artifactRef', 'exists', 'contentSha256', 'byteLength', 'mtimeMs', 'identitySha256']
    .every(key => left?.[key] === right?.[key]);
}

function receiptBindsTurn(receipt, turn) {
  return Boolean(receipt && turn)
    && receipt.requestRef === turn.requestRef
    && receipt.taskRef === turn.targetTaskRef;
}

function validateS1Semantics(records, out, checks) {
  const start = out.issues.length;
  const bindings = validatePhaseBindingCohesion(records, ['offer', 'cleanup'], out);
  const offerRecord = exactPhaseObservation(
    records, 'offer', 'turn', out, 'cleanup_offer_turn_cardinality_invalid',
  );
  const cleanupRecord = exactPhaseObservation(
    records, 'cleanup', 'turn', out, 'cleanup_acceptance_turn_cardinality_invalid',
  );
  const offer = offerRecord?.observation;
  const cleanup = cleanupRecord?.observation;
  const statusReceipt = exactActionReceipt(
    records, 'offer', 'runtime_work_status', out, 'cleanup_offer_status',
  );
  const cancelReceipt = exactActionReceipt(
    records, 'cleanup', 'runtime_work_cancel', out, 'cleanup_execution',
  );

  if (!['new', 'status'].includes(offer?.relation)
    || offer?.terminalStatus !== 'completed'
    || !offer?.userVisibleReply
    || !receiptBindsTurn(statusReceipt, offer)) {
    out.add('$.phase[offer]', 'cleanup_offer_turn_receipt_binding_invalid');
  }
  if (cleanup?.relation !== 'confirm'
    || cleanup?.targetRequestRef !== offer?.requestRef
    || cleanup?.terminalStatus !== 'completed'
    || !cleanup?.userVisibleReply
    || !receiptBindsTurn(cancelReceipt, cleanup)) {
    out.add('$.phase[cleanup]', 'cleanup_acceptance_binding_invalid');
  }
  if (statusReceipt?.executionOrigin !== 'model_tool_call'
    || statusReceipt?.outcome !== 'verified_success'
    || statusReceipt?.target?.targetKind !== 'runtime_work_set'
    || statusReceipt?.target?.workCount < 1) {
    out.add('$.phase[offer].action_set', 'cleanup_offer_verified_work_set_missing');
  }
  if (cancelReceipt?.executionOrigin !== 'deterministic_route'
    || cancelReceipt?.outcome !== 'verified_success'
    || cancelReceipt?.target?.targetKind !== 'runtime_work_set'
    || cancelReceipt?.target?.workSetSha256 !== statusReceipt?.target?.workSetSha256
    || cancelReceipt?.target?.workCount !== statusReceipt?.target?.workCount) {
    out.add('$.phase[cleanup].action_set', 'cleanup_frozen_work_set_join_invalid');
  }

  const cleanupNoninvocation = exactPhaseObservation(
    records,
    'cleanup',
    'model_noninvocation',
    out,
    'cleanup_model_noninvocation_cardinality_invalid',
  );
  if (cleanupNoninvocation?.observation?.requestRef !== cleanup?.requestRef
    || cleanupNoninvocation?.observation?.executionOrigin !== 'deterministic_route') {
    out.add('$.phase[cleanup].model_noninvocation', 'cleanup_must_resume_without_model');
  }

  const cleanupState = exactPhaseObservation(
    records,
    'cleanup',
    'conversation_state',
    out,
    'cleanup_conversation_state_cardinality_invalid',
  );
  const task = taskFromState(
    cleanupState,
    cancelReceipt?.taskRef,
    out,
    '$.phase[cleanup].conversation_state.tasks',
    'cleanup_task_receipt_join_invalid',
  );
  if (task && (task.status !== 'completed' || task.activeRequestRef !== null)) {
    out.add('$.phase[cleanup].conversation_state.tasks', 'cleanup_task_terminal_state_invalid');
  }
  if (cleanupState && (
    !pointerIs(cleanupState.observation?.pendingPointer, 'cleared')
      || !pointerIs(cleanupState.observation?.livePointer, 'cleared')
      || cleanupState.observation?.pendingConfirmationCount !== 0
  )) {
    out.add('$.phase[cleanup].conversation_state', 'cleanup_terminal_pointer_not_released');
  }

  validateRequestPhaseModel(records, 'offer', bindings, out);
  if (bindings.get('offer')?.conversationRef !== bindings.get('cleanup')?.conversationRef) {
    out.add('$.phase[cleanup].binding.conversationRef', 'cleanup_offer_conversation_join_invalid');
  }
  addCheck(
    checks,
    'verified_cleanup_offer_frozen_set_once',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function validateS3Semantics(records, out, checks) {
  const start = out.issues.length;
  const phaseIds = ['anchor', 'correction', 'supply-filename'];
  const bindings = validatePhaseBindingCohesion(records, phaseIds, out);
  const turns = Object.fromEntries(phaseIds.map(phaseId => [
    phaseId,
    exactPhaseObservation(
      records, phaseId, 'turn', out, `wps_${phaseId}_turn_cardinality_invalid`,
    )?.observation,
  ]));
  const anchorReceipt = exactActionReceipt(
    records, 'anchor', 'desktop_active_window', out, 'wps_anchor',
  );
  const readReceipt = exactActionReceipt(
    records, 'supply-filename', 'extract_document_text', out, 'wps_corrected_read',
  );
  const taskRef = turns.anchor?.targetTaskRef;

  if (turns.anchor?.relation !== 'new'
    || turns.anchor?.targetRequestRef !== null
    || turns.anchor?.terminalStatus !== 'completed'
    || !receiptBindsTurn(anchorReceipt, turns.anchor)) {
    out.add('$.phase[anchor]', 'wps_anchor_turn_receipt_binding_invalid');
  }
  if (turns.correction?.relation !== 'correct'
    || turns.correction?.targetTaskRef !== taskRef
    || turns.correction?.targetRequestRef !== turns.anchor?.requestRef) {
    out.add('$.phase[correction]', 'wps_correction_task_request_join_invalid');
  }
  if (!['correct', 'continue'].includes(turns['supply-filename']?.relation)
    || turns['supply-filename']?.targetTaskRef !== taskRef
    || turns['supply-filename']?.targetRequestRef !== turns.correction?.requestRef
    || turns['supply-filename']?.terminalStatus !== 'completed'
    || !receiptBindsTurn(readReceipt, turns['supply-filename'])) {
    out.add('$.phase[supply-filename]', 'wps_corrected_read_task_request_join_invalid');
  }
  if (anchorReceipt?.outcome !== 'verified_success'
    || anchorReceipt?.target?.targetKind !== 'application_document'
    || readReceipt?.outcome !== 'verified_success'
    || !['filesystem', 'application_document'].includes(readReceipt?.target?.targetKind)
    || sameTarget(anchorReceipt?.target, readReceipt?.target)) {
    out.add('$.target', 'wps_wrong_and_correct_target_evidence_invalid');
  }

  const anchorNative = exactPhaseObservation(
    records, 'anchor', 'native_target', out, 'wps_anchor_native_target_cardinality_invalid',
  )?.observation;
  const correctedNative = exactPhaseObservation(
    records,
    'supply-filename',
    'native_target',
    out,
    'wps_corrected_native_target_cardinality_invalid',
  )?.observation;
  const anchorTarget = anchorReceipt?.target;
  if (!anchorNative
    || anchorTarget?.applicationId !== anchorNative.applicationId
    || anchorTarget?.processName !== anchorNative.processName
    || anchorTarget?.windowTitleSha256 !== anchorNative.windowTitleSha256
    || anchorTarget?.documentTitle !== anchorNative.documentTitle
    || anchorTarget?.canonicalPathHmac !== anchorNative.documentIdentitySha256) {
    out.add('$.phase[anchor].native_target', 'wps_anchor_native_receipt_join_invalid');
  }
  const correctedIdentity = readReceipt?.target?.canonicalPathHmac;
  const correctedTargetMatchesNative = readReceipt?.target?.targetKind === 'filesystem'
    ? readReceipt.target.displayName === correctedNative?.documentTitle
    : readReceipt?.target?.applicationId === correctedNative?.applicationId
      && readReceipt?.target?.processName === correctedNative?.processName
      && readReceipt?.target?.windowTitleSha256 === correctedNative?.windowTitleSha256
      && readReceipt?.target?.documentTitle === correctedNative?.documentTitle;
  if (!correctedNative
    || correctedIdentity !== correctedNative.documentIdentitySha256
    || correctedNative.applicationId !== anchorNative?.applicationId
    || correctedNative.processName !== anchorNative?.processName
    || !correctedTargetMatchesNative) {
    out.add('$.phase[supply-filename].native_target', 'wps_corrected_native_receipt_join_invalid');
  }

  const wrongBefore = exactPhaseObservation(
    records, 'anchor', 'artifact_state', out, 'wps_wrong_artifact_before_cardinality_invalid',
  )?.observation;
  const wrongAfter = exactPhaseObservation(
    records,
    'supply-filename',
    'artifact_state',
    out,
    'wps_wrong_artifact_after_cardinality_invalid',
  )?.observation;
  if (!wrongBefore?.exists
    || wrongBefore.identitySha256 !== anchorTarget?.canonicalPathHmac
    || !sameArtifact(wrongBefore, wrongAfter)) {
    out.add('$.artifact', 'wps_wrong_file_unchanged_proof_invalid');
  }

  const correctionState = exactPhaseObservation(
    records,
    'correction',
    'conversation_state',
    out,
    'wps_correction_state_cardinality_invalid',
  );
  const finalState = exactPhaseObservation(
    records,
    'supply-filename',
    'conversation_state',
    out,
    'wps_final_state_cardinality_invalid',
  );
  const correctionTask = taskFromState(
    correctionState,
    taskRef,
    out,
    '$.phase[correction].conversation_state.tasks',
    'wps_correction_task_missing',
  );
  const finalTask = taskFromState(
    finalState,
    taskRef,
    out,
    '$.phase[supply-filename].conversation_state.tasks',
    'wps_final_task_missing',
  );
  if (!correctionTask
    || correctionTask.status !== 'executing'
    || correctionTask.activeRequestRef !== turns.correction?.requestRef
    || !pointerIs(
      correctionState?.observation?.livePointer,
      'set',
      taskRef,
      turns.correction?.requestRef,
    )) {
    out.add('$.phase[correction].conversation_state', 'wps_correction_live_task_binding_invalid');
  }
  if (!finalTask
    || finalTask.status !== 'completed'
    || finalTask.activeRequestRef !== null
    || !pointerIs(finalState?.observation?.livePointer, 'cleared')
    || !pointerIs(finalState?.observation?.pendingPointer, 'cleared')
    || finalState?.observation?.pendingConfirmationCount !== 0) {
    out.add('$.phase[supply-filename].conversation_state', 'wps_final_task_state_invalid');
  }
  if (correctionTask && finalTask && correctionTask.goalSha256 !== finalTask.goalSha256) {
    out.add('$.task.goalSha256', 'wps_task_goal_continuity_invalid');
  }
  if (phaseIds.some(phaseId => bindings.get(phaseId)?.conversationRef
    !== bindings.get('anchor')?.conversationRef)) {
    out.add('$.binding.conversationRef', 'wps_conversation_continuity_invalid');
  }
  phaseIds.forEach(phaseId => validateRequestPhaseModel(records, phaseId, bindings, out));
  addCheck(
    checks,
    'wps_wrong_target_corrected_same_task',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function validateS4Semantics(records, out, checks) {
  const start = out.issues.length;
  const phaseIds = ['display', 'inject_stale', 'continue'];
  const bindings = validatePhaseBindingCohesion(records, phaseIds, out);
  const displayRecord = exactPhaseObservation(
    records, 'display', 'turn', out, 'stale_display_turn_cardinality_invalid',
  );
  const continueRecord = exactPhaseObservation(
    records, 'continue', 'turn', out, 'stale_continue_turn_cardinality_invalid',
  );
  const display = displayRecord?.observation;
  const continuation = continueRecord?.observation;
  const receipt = exactActionReceipt(records, 'display', 'read_file', out, 'stale_display');
  const staleRecord = exactPhaseObservation(
    records,
    'inject_stale',
    'stale_reclassification',
    out,
    'stale_reclassification_cardinality_invalid',
  );
  const stale = staleRecord?.observation;

  if (display?.relation !== 'new'
    || display?.terminalStatus !== 'completed'
    || !display?.userVisibleReply
    || !receiptBindsTurn(receipt, display)
    || receipt?.outcome !== 'verified_success') {
    out.add('$.phase[display]', 'displayed_result_receipt_reply_binding_invalid');
  }
  if (bindings.get('inject_stale')?.sourceBindingId !== bindings.get('display')?.bindingId
    || stale?.sourceReceiptRef !== receipt?.receiptRef
    || stale?.classification !== 'stale'
    || stale?.sourceReceiptUnchanged !== true
    || stale?.leaseReleased !== true) {
    out.add('$.phase[inject_stale]', 'stale_receipt_source_binding_invalid');
  }
  if (!['new', 'continue'].includes(continuation?.relation)
    || !continuation?.targetTaskRef
    || (continuation?.relation === 'continue'
      && continuation?.targetRequestRef !== display?.requestRef)
    || (continuation?.relation === 'new' && continuation?.targetRequestRef !== null)) {
    out.add('$.phase[continue]', 'stale_followup_request_relation_invalid');
  }

  const state = exactPhaseObservation(
    records,
    'continue',
    'conversation_state',
    out,
    'stale_followup_state_cardinality_invalid',
  );
  const task = taskFromState(
    state,
    continuation?.targetTaskRef,
    out,
    '$.phase[continue].conversation_state.tasks',
    'stale_followup_task_missing',
  );
  const waiting = continuation?.terminalStatus === 'waiting_confirmation'
    && task?.status === 'waiting_confirmation'
    && task?.activeRequestRef === continuation?.requestRef
    && pointerIs(
      state?.observation?.livePointer,
      'set',
      continuation?.targetTaskRef,
      continuation?.requestRef,
    )
    && pointerIs(
      state?.observation?.pendingPointer,
      'set',
      continuation?.targetTaskRef,
      continuation?.requestRef,
    )
    && state?.observation?.pendingConfirmationCount === 1;
  const completed = continuation?.terminalStatus === 'completed'
    && task?.status === 'completed'
    && task?.activeRequestRef === null
    && pointerIs(state?.observation?.livePointer, 'cleared')
    && pointerIs(state?.observation?.pendingPointer, 'cleared')
    && state?.observation?.pendingConfirmationCount === 0;
  if (!waiting && !completed) {
    out.add('$.phase[continue].conversation_state', 'stale_followup_not_routable_after_release');
  }
  if (bindings.get('display')?.conversationRef !== bindings.get('continue')?.conversationRef) {
    out.add('$.phase[continue].binding.conversationRef', 'stale_followup_conversation_join_invalid');
  }
  validateRequestPhaseModel(records, 'display', bindings, out);
  validateRequestPhaseModel(records, 'continue', bindings, out);
  addCheck(
    checks,
    'displayed_result_stale_receipt_released',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function validateS6Semantics(records, out, checks) {
  const start = out.issues.length;
  const phaseIds = ['voice_start', 'text_continue'];
  const bindings = validatePhaseBindingCohesion(records, phaseIds, out);
  const voiceRecord = exactPhaseObservation(
    records, 'voice_start', 'turn', out, 'voice_start_turn_cardinality_invalid',
  );
  const textRecord = exactPhaseObservation(
    records, 'text_continue', 'turn', out, 'voice_text_turn_cardinality_invalid',
  );
  const voice = voiceRecord?.observation;
  const text = textRecord?.observation;
  const voiceReceipt = exactActionReceipt(records, 'voice_start', 'read_file', out, 'voice_read');
  const textReceipt = exactActionReceipt(records, 'text_continue', 'read_file', out, 'text_read');
  const taskRef = voice?.targetTaskRef;

  if (bindings.get('voice_start')?.channel !== 'voice'
    || voice?.channel !== 'voice'
    || voice?.relation !== 'new'
    || voice?.terminalStatus !== 'blocked'
    || !receiptBindsTurn(voiceReceipt, voice)
    || voiceReceipt?.outcome !== 'failed') {
    out.add('$.phase[voice_start]', 'voice_failed_turn_receipt_binding_invalid');
  }
  if (bindings.get('text_continue')?.channel !== 'text'
    || text?.channel !== 'text'
    || text?.relation !== 'continue'
    || text?.targetTaskRef !== taskRef
    || text?.targetRequestRef !== voice?.requestRef
    || text?.terminalStatus !== 'completed'
    || !receiptBindsTurn(textReceipt, text)
    || textReceipt?.outcome !== 'verified_success') {
    out.add('$.phase[text_continue]', 'voice_text_continuation_binding_invalid');
  }
  if (voiceReceipt?.toolName !== 'read_file'
    || textReceipt?.toolName !== 'read_file'
    || voiceReceipt?.target?.targetKind !== 'filesystem'
    || textReceipt?.target?.targetKind !== 'filesystem'
    || voiceReceipt?.inputSha256 === textReceipt?.inputSha256
    || sameTarget(voiceReceipt?.target, textReceipt?.target)) {
    out.add('$.action', 'voice_text_corrected_target_transition_invalid');
  }

  const correctionRecord = exactPhaseObservation(
    records,
    'text_continue',
    'target_correction',
    out,
    'voice_text_target_correction_cardinality_invalid',
  );
  const correction = correctionRecord?.observation;
  if (correction?.sourceRequestRef !== voice?.requestRef
    || correction?.targetRequestRef !== text?.requestRef
    || correction?.taskRef !== taskRef
    || correction?.correctionMessageRef !== text?.userMessageRef
    || correction?.source !== 'user_correction'
    || !sameTarget(correction?.previousTarget, voiceReceipt?.target)
    || !sameTarget(correction?.replacementTarget, textReceipt?.target)
    || correction?.previousTaskTargetSha256 === correction?.replacementTaskTargetSha256
    || correction?.rejectedTargetSha256 !== correction?.previousTaskTargetSha256) {
    out.add('$.phase[text_continue].target_correction', 'voice_text_target_correction_join_invalid');
  }

  const handoffRecord = exactPhaseObservation(
    records,
    'text_continue',
    'channel_handoff',
    out,
    'voice_text_handoff_cardinality_invalid',
  );
  const handoff = handoffRecord?.observation;
  if (handoff?.sourceRequestRef !== voice?.requestRef
    || handoff?.targetRequestRef !== text?.requestRef
    || handoff?.sourceTaskRef !== taskRef
    || handoff?.targetTaskRef !== taskRef
    || handoff?.sourceChannel !== 'voice'
    || handoff?.targetChannel !== 'text'
    || handoff?.captureMode !== 'synthetic_accepted_transcript'
    || handoff?.targetMessageRef !== text?.userMessageRef
    || !handoff?.sourceMessageRefs?.includes(voice?.userMessageRef)
    || !handoff?.sourceMessageRefs?.includes(voice?.assistantMessageRef)) {
    out.add('$.phase[text_continue].channel_handoff', 'voice_text_handoff_join_invalid');
  }

  const voiceState = exactPhaseObservation(
    records,
    'voice_start',
    'conversation_state',
    out,
    'voice_state_cardinality_invalid',
  );
  const textState = exactPhaseObservation(
    records,
    'text_continue',
    'conversation_state',
    out,
    'text_state_cardinality_invalid',
  );
  const voiceTask = taskFromState(
    voiceState,
    taskRef,
    out,
    '$.phase[voice_start].conversation_state.tasks',
    'voice_task_missing',
  );
  const textTask = taskFromState(
    textState,
    taskRef,
    out,
    '$.phase[text_continue].conversation_state.tasks',
    'text_continuation_task_missing',
  );
  const voiceLiveRequest = voiceState?.observation?.livePointer?.requestRef;
  if (!voiceTask
    || voiceTask.status !== 'blocked'
    || voiceTask.activeRequestRef !== null
    || !pointerIs(voiceState?.observation?.pendingPointer, 'cleared')
    || !pointerIs(
      voiceState?.observation?.livePointer,
      'set',
      taskRef,
      voiceLiveRequest,
    )
    || ![null, voice?.requestRef].includes(voiceLiveRequest)
    || voiceState?.observation?.pendingConfirmationCount !== 0) {
    out.add('$.phase[voice_start].conversation_state', 'voice_blocked_task_state_invalid');
  }
  if (!textTask
    || textTask.status !== 'completed'
    || textTask.activeRequestRef !== null
    || !pointerIs(textState?.observation?.pendingPointer, 'cleared')
    || !pointerIs(textState?.observation?.livePointer, 'cleared')
    || textState?.observation?.pendingConfirmationCount !== 0) {
    out.add('$.phase[text_continue].conversation_state', 'text_continuation_terminal_state_invalid');
  }
  if (voiceTask && textTask && (
    voiceTask.goalSha256 !== textTask.goalSha256
      || voiceTask.targetSha256 === textTask.targetSha256
      || textTask.capsuleRevision <= voiceTask.capsuleRevision
      || correction?.previousTaskTargetSha256 !== voiceTask.targetSha256
      || correction?.replacementTaskTargetSha256 !== textTask.targetSha256
  )) {
    out.add('$.task', 'voice_text_task_capsule_continuity_invalid');
  }
  if (bindings.get('voice_start')?.conversationRef !== bindings.get('text_continue')?.conversationRef) {
    out.add('$.binding.conversationRef', 'voice_text_conversation_join_invalid');
  }
  phaseIds.forEach(phaseId => validateRequestPhaseModel(records, phaseId, bindings, out));
  addCheck(
    checks,
    'voice_failure_text_same_task_recovery',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function validateS7Semantics(records, out, checks) {
  const start = out.issues.length;
  const phaseIds = ['prepare', 'restart', 'recovered', 'continue'];
  const bindings = validatePhaseBindingCohesion(records, phaseIds, out);
  const prepareRecord = exactPhaseObservation(
    records, 'prepare', 'turn', out, 'restart_prepare_turn_cardinality_invalid',
  );
  const continueRecord = exactPhaseObservation(
    records, 'continue', 'turn', out, 'restart_continue_turn_cardinality_invalid',
  );
  const prepare = prepareRecord?.observation;
  const continuation = continueRecord?.observation;
  const pendingReceipt = exactActionReceipt(
    records, 'prepare', 'desktop_write_text_file', out, 'restart_pending_action',
  );
  const completedReceipt = exactActionReceipt(
    records, 'continue', 'desktop_write_text_file', out, 'restart_completed_action',
  );
  const taskRef = prepare?.targetTaskRef;

  if (prepare?.relation !== 'new'
    || prepare?.terminalStatus !== 'waiting_confirmation'
    || !receiptBindsTurn(pendingReceipt, prepare)
    || pendingReceipt?.outcome !== 'waiting_confirmation') {
    out.add('$.phase[prepare]', 'restart_pending_turn_receipt_binding_invalid');
  }
  if (continuation?.relation !== 'confirm'
    || continuation?.targetTaskRef !== taskRef
    || continuation?.targetRequestRef !== prepare?.requestRef
    || continuation?.terminalStatus !== 'completed'
    || !receiptBindsTurn(completedReceipt, continuation)
    || completedReceipt?.outcome !== 'verified_success') {
    out.add('$.phase[continue]', 'restart_confirmation_turn_receipt_binding_invalid');
  }
  if (pendingReceipt?.taskRef !== completedReceipt?.taskRef
    || pendingReceipt?.idempotencyKeySha256 !== completedReceipt?.idempotencyKeySha256
    || pendingReceipt?.inputSha256 !== completedReceipt?.inputSha256
    || !sameTarget(pendingReceipt?.target, completedReceipt?.target)
    || completedReceipt?.executionOrigin !== 'confirmed_action_resume') {
    out.add('$.action', 'restart_exact_pending_action_join_invalid');
  }

  const restartRecord = exactPhaseObservation(
    records, 'restart', 'runtime_transition', out, 'restart_transition_cardinality_invalid',
  );
  const recoveredRecord = exactPhaseObservation(
    records, 'recovered', 'runtime_transition', out, 'recovered_transition_cardinality_invalid',
  );
  const restart = restartRecord?.observation;
  const recovered = recoveredRecord?.observation;
  if (bindings.get('restart')?.eventKind !== 'backend_restart'
    || bindings.get('restart')?.sourceBindingId !== bindings.get('prepare')?.bindingId
    || bindings.get('recovered')?.eventKind !== 'post_restart_recovery'
    || bindings.get('recovered')?.sourceBindingId !== bindings.get('restart')?.bindingId) {
    out.add('$.runtime.binding', 'restart_event_source_binding_invalid');
  }
  const transitionKeys = [
    'restartScope', 'beforeEpochRef', 'afterEpochRef', 'buildIdentitySha256',
    'dataRootSha256', 'checkpointSha256',
  ];
  if (!restart || !recovered
    || transitionKeys.some(key => restart?.[key] !== recovered?.[key])) {
    out.add('$.runtime.transition', 'restart_recovery_checkpoint_join_invalid');
  }

  const prepareState = exactPhaseObservation(
    records,
    'prepare',
    'conversation_state',
    out,
    'restart_prepare_state_cardinality_invalid',
  );
  const recoveredState = exactPhaseObservation(
    records,
    'recovered',
    'conversation_state',
    out,
    'restart_recovered_state_cardinality_invalid',
  );
  const finalState = exactPhaseObservation(
    records,
    'continue',
    'conversation_state',
    out,
    'restart_final_state_cardinality_invalid',
  );
  const prepareTask = taskFromState(
    prepareState,
    taskRef,
    out,
    '$.phase[prepare].conversation_state.tasks',
    'restart_prepare_task_missing',
  );
  const recoveredTask = taskFromState(
    recoveredState,
    taskRef,
    out,
    '$.phase[recovered].conversation_state.tasks',
    'restart_recovered_task_missing',
  );
  const finalTask = taskFromState(
    finalState,
    taskRef,
    out,
    '$.phase[continue].conversation_state.tasks',
    'restart_final_task_missing',
  );
  if (!prepareTask
    || prepareTask.status !== 'waiting_confirmation'
    || prepareTask.activeRequestRef !== prepare?.requestRef
    || !pointerIs(prepareState?.observation?.pendingPointer, 'set', taskRef, prepare?.requestRef)
    || !pointerIs(prepareState?.observation?.livePointer, 'set', taskRef, prepare?.requestRef)
    || prepareState?.observation?.pendingConfirmationCount !== 1) {
    out.add('$.phase[prepare].conversation_state', 'restart_prepare_pending_state_invalid');
  }
  const recoveredPendingRequest = recoveredState?.observation?.pendingPointer?.requestRef;
  const recoveredLiveRequest = recoveredState?.observation?.livePointer?.requestRef;
  if (!recoveredTask
    || recoveredTask.status !== 'waiting_confirmation'
    || recoveredTask.activeRequestRef !== null
    || !pointerIs(
      recoveredState?.observation?.pendingPointer,
      'set',
      taskRef,
      recoveredPendingRequest,
    )
    || !pointerIs(
      recoveredState?.observation?.livePointer,
      'set',
      taskRef,
      recoveredLiveRequest,
    )
    || ![null, prepare?.requestRef].includes(recoveredPendingRequest)
    || ![null, prepare?.requestRef].includes(recoveredLiveRequest)
    || recoveredState?.observation?.pendingConfirmationCount !== 1) {
    out.add('$.phase[recovered].conversation_state', 'restart_recovered_pending_state_invalid');
  }
  if (!finalTask
    || finalTask.status !== 'completed'
    || finalTask.activeRequestRef !== null
    || !pointerIs(finalState?.observation?.pendingPointer, 'cleared')
    || !pointerIs(finalState?.observation?.livePointer, 'cleared')
    || finalState?.observation?.pendingConfirmationCount !== 0) {
    out.add('$.phase[continue].conversation_state', 'restart_final_state_invalid');
  }
  if (prepareTask && recoveredTask && finalTask && (
    prepareTask.goalSha256 !== recoveredTask.goalSha256
      || prepareTask.goalSha256 !== finalTask.goalSha256
      || prepareTask.targetSha256 !== recoveredTask.targetSha256
      || prepareTask.targetSha256 !== finalTask.targetSha256
      || recoveredTask.revision < prepareTask.revision
      || finalTask.revision < recoveredTask.revision
  )) {
    out.add('$.task', 'restart_task_capsule_continuity_invalid');
  }

  const beforeArtifact = exactPhaseObservation(
    records, 'prepare', 'artifact_state', out, 'restart_before_artifact_cardinality_invalid',
  )?.observation;
  const afterArtifact = exactPhaseObservation(
    records, 'continue', 'artifact_state', out, 'restart_after_artifact_cardinality_invalid',
  )?.observation;
  if (beforeArtifact?.exists !== false
    || afterArtifact?.exists !== true
    || beforeArtifact?.artifactRef !== afterArtifact?.artifactRef
    || afterArtifact?.identitySha256 !== completedReceipt?.target?.canonicalPathHmac) {
    out.add('$.artifact', 'restart_artifact_transition_invalid');
  }
  if (phaseIds.some(phaseId => bindings.get(phaseId)?.bindingKind === 'request'
    && bindings.get(phaseId)?.conversationRef !== bindings.get('prepare')?.conversationRef)) {
    out.add('$.binding.conversationRef', 'restart_conversation_join_invalid');
  }
  validateRequestPhaseModel(records, 'prepare', bindings, out);
  const continueRoute = phaseEvidence(records, 'continue', 'model_route');
  if (continueRoute.length === 1) {
    validateRequestPhaseModel(records, 'continue', bindings, out);
  } else {
    const noninvocation = exactPhaseObservation(
      records,
      'continue',
      'model_noninvocation',
      out,
      'restart_continue_noninvocation_cardinality_invalid',
    );
    if (noninvocation?.observation?.executionOrigin !== 'confirmed_action_resume'
      || noninvocation?.observation?.requestRef !== continuation?.requestRef) {
      out.add('$.phase[continue].model_noninvocation', 'restart_confirm_resume_origin_invalid');
    }
  }
  addCheck(
    checks,
    'restart_same_task_exact_action_recovered',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function isLmStudioProvider(value) {
  return typeof value === 'string' && /^lm[_ .-]*studio$/iu.test(value.trim());
}

function validateS8Semantics(records, out, checks) {
  const start = out.issues.length;
  const phaseIds = [
    'start', 'primary_attempt_failed', 'lmstudio_attempt_succeeded', 'text_continue',
  ];
  const bindings = validatePhaseBindingCohesion(records, phaseIds, out);
  const startRecord = exactPhaseObservation(
    records, 'start', 'turn', out, 'failover_start_turn_cardinality_invalid',
  );
  const continueRecord = exactPhaseObservation(
    records, 'text_continue', 'turn', out, 'failover_continue_turn_cardinality_invalid',
  );
  const initial = startRecord?.observation;
  const continuation = continueRecord?.observation;
  const taskRef = initial?.targetTaskRef;

  if (initial?.relation !== 'new'
    || initial?.terminalStatus !== 'blocked'
    || initial?.targetRequestRef !== null) {
    out.add('$.phase[start]', 'failover_start_task_binding_invalid');
  }
  if (continuation?.relation !== 'continue'
    || continuation?.targetTaskRef !== taskRef
    || continuation?.targetRequestRef !== initial?.requestRef
    || continuation?.terminalStatus !== 'completed') {
    out.add('$.phase[text_continue]', 'failover_same_task_continuation_invalid');
  }

  const primaryRecord = exactPhaseObservation(
    records,
    'primary_attempt_failed',
    'provider_attempt',
    out,
    'primary_provider_attempt_cardinality_invalid',
  );
  const fallbackProviderRecord = exactPhaseObservation(
    records,
    'lmstudio_attempt_succeeded',
    'provider_attempt',
    out,
    'lmstudio_provider_attempt_cardinality_invalid',
  );
  const fallbackRouteRecord = exactPhaseObservation(
    records,
    'lmstudio_attempt_succeeded',
    'model_route',
    out,
    'lmstudio_route_cardinality_invalid',
  );
  const primary = primaryRecord?.observation;
  const fallbackProvider = fallbackProviderRecord?.observation;
  const fallbackRoute = fallbackRouteRecord?.observation;
  if (bindings.get('primary_attempt_failed')?.eventKind !== 'primary_model_attempt'
    || bindings.get('primary_attempt_failed')?.sourceBindingId !== bindings.get('start')?.bindingId
    || bindings.get('lmstudio_attempt_succeeded')?.eventKind !== 'fallback_model_attempt'
    || bindings.get('lmstudio_attempt_succeeded')?.sourceBindingId
      !== bindings.get('primary_attempt_failed')?.bindingId) {
    out.add('$.failover.binding', 'failover_event_source_binding_invalid');
  }
  if (primary?.requestRef !== initial?.requestRef
    || primary?.status !== 'failed'
    || primary?.visibleOutputCommitted !== false
    || !primary?.errorCategory
    || isLmStudioProvider(primary?.provider)
    || fallbackProvider?.requestRef !== initial?.requestRef
    || fallbackProvider?.status !== 'succeeded'
    || !isLmStudioProvider(fallbackProvider?.provider)
    || !isLmStudioProvider(fallbackRoute?.selectedProvider)
    || fallbackRoute?.selectedProvider !== fallbackProvider?.provider
    || fallbackRoute?.selectedModel !== fallbackProvider?.model
    || fallbackRoute?.selectionMode !== 'ordered_fallback'
    || !fallbackRoute?.fallbackReason) {
    out.add('$.failover', 'primary_failure_lmstudio_selection_invalid');
  }
  validateModelProviderJoin({
    routeRecord: fallbackRouteRecord,
    providerRecords: [primaryRecord, fallbackProviderRecord],
    requestBinding: bindings.get('start'),
    requestRef: initial?.requestRef,
    path: '$.phase[lmstudio_attempt_succeeded].model_route',
    out,
  });

  const initialState = exactPhaseObservation(
    records, 'start', 'conversation_state', out, 'failover_start_state_cardinality_invalid',
  );
  const finalState = exactPhaseObservation(
    records,
    'text_continue',
    'conversation_state',
    out,
    'failover_final_state_cardinality_invalid',
  );
  const initialTask = taskFromState(
    initialState,
    taskRef,
    out,
    '$.phase[start].conversation_state.tasks',
    'failover_start_task_missing',
  );
  const finalTask = taskFromState(
    finalState,
    taskRef,
    out,
    '$.phase[text_continue].conversation_state.tasks',
    'failover_final_task_missing',
  );
  const initialLiveRequest = initialState?.observation?.livePointer?.requestRef;
  if (!initialTask
    || initialTask.status !== 'blocked'
    || initialTask.activeRequestRef !== null
    || !pointerIs(initialState?.observation?.pendingPointer, 'cleared')
    || !pointerIs(initialState?.observation?.livePointer, 'set', taskRef, initialLiveRequest)
    || ![null, initial?.requestRef].includes(initialLiveRequest)
    || initialState?.observation?.pendingConfirmationCount !== 0) {
    out.add('$.phase[start].conversation_state', 'failover_blocked_task_state_invalid');
  }
  if (!finalTask
    || finalTask.status !== 'completed'
    || finalTask.activeRequestRef !== null
    || !pointerIs(finalState?.observation?.pendingPointer, 'cleared')
    || !pointerIs(finalState?.observation?.livePointer, 'cleared')
    || finalState?.observation?.pendingConfirmationCount !== 0) {
    out.add('$.phase[text_continue].conversation_state', 'failover_final_task_state_invalid');
  }
  if (initialTask && finalTask && (
    initialTask.goalSha256 !== finalTask.goalSha256
      || initialTask.targetSha256 !== finalTask.targetSha256
      || finalTask.capsuleRevision < initialTask.capsuleRevision
  )) {
    out.add('$.task', 'failover_task_capsule_continuity_invalid');
  }
  if (bindings.get('start')?.conversationRef !== bindings.get('text_continue')?.conversationRef) {
    out.add('$.binding.conversationRef', 'failover_conversation_join_invalid');
  }

  validateRequestPhaseModel(records, 'text_continue', bindings, out);
  const continueRoute = phaseEvidence(records, 'text_continue', 'model_route')[0]?.observation;
  if (!isLmStudioProvider(continueRoute?.selectedProvider)
    || continueRoute?.selectedProvider !== fallbackProvider?.provider
    || continueRoute?.selectedModel !== fallbackProvider?.model) {
    out.add('$.phase[text_continue].model_route', 'failover_continuation_model_mismatch');
  }
  addCheck(
    checks,
    'primary_failure_lmstudio_same_task_continuation',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function validateS2Semantics(records, out, checks) {
  const start = out.issues.length;
  const relationByPhase = new Map(records
    .filter(record => record.observation?.observationKind === 'turn')
    .map(record => [record.phaseId, record.observation.relation]));
  if (relationByPhase.get('confirm_first') !== 'confirm') {
    out.add('$.phase[confirm_first]', 'first_confirmation_relation_invalid');
  }
  if (!['confirm', 'repeat'].includes(relationByPhase.get('confirm_repeat'))) {
    out.add('$.phase[confirm_repeat]', 'repeated_confirmation_relation_invalid');
  }
  const pendingReceipts = phaseEvidence(records, 'pending', 'action_set')
    .flatMap(record => Array.isArray(record.observation?.receipts) ? record.observation.receipts : [])
    .filter(receipt => receipt?.toolName === 'desktop_write_text_file');
  const firstReceipts = phaseEvidence(records, 'confirm_first', 'action_set')
    .flatMap(record => Array.isArray(record.observation?.receipts) ? record.observation.receipts : [])
    .filter(receipt => receipt?.toolName === 'desktop_write_text_file');
  if (pendingReceipts.length === 1 && firstReceipts.length === 1) {
    const pending = pendingReceipts[0];
    const first = firstReceipts[0];
    for (const key of ['taskRef', 'idempotencyKeySha256', 'inputSha256']) {
      if (pending?.[key] !== first?.[key]) {
        out.add(`$.phase[confirm_first].${key}`, 'confirmation_action_join_mismatch');
      }
    }
    if (canonicalJson(pending?.target) !== canonicalJson(first?.target)) {
      out.add('$.phase[confirm_first].target', 'confirmation_action_target_mismatch');
    }
    if (first?.executionOrigin !== 'confirmed_action_resume') {
      out.add('$.phase[confirm_first].executionOrigin', 'confirmation_resume_origin_required');
    }
  }
  const absence = phaseEvidence(records, 'confirm_repeat', 'absence_window');
  const requiredAbsenceSources = [
    'passive_task_store',
    'passive_receipt_store',
    'socket_tool_events',
    'filesystem_witness',
  ];
  if (absence.length !== 1
    || absence[0].observation?.assertion !== 'no_new_task_or_tool_execution'
    || absence[0].observation?.matchedRecordCount !== 0
    || requiredAbsenceSources.some(source => !absence[0].observation?.sources?.includes(source))) {
    out.add('$.phase[confirm_repeat]', 'duplicate_confirmation_absence_proof_invalid');
  }
  const repeatNoninvocations = phaseEvidence(records, 'confirm_repeat', 'model_noninvocation');
  if (repeatNoninvocations.length !== 1
    || repeatNoninvocations[0].observation?.executionOrigin !== 'request_only_control') {
    out.add('$.phase[confirm_repeat]', 'duplicate_confirmation_noninvocation_proof_invalid');
  }
  const firstArtifacts = phaseEvidence(records, 'confirm_first', 'artifact_state');
  const repeatArtifacts = phaseEvidence(records, 'confirm_repeat', 'artifact_state');
  if (firstArtifacts.length !== 1 || repeatArtifacts.length !== 1) {
    out.add('$.artifact', 'exact_artifact_pair_required');
  } else {
    const left = firstArtifacts[0].observation;
    const right = repeatArtifacts[0].observation;
    for (const key of ['artifactRef', 'exists', 'contentSha256', 'byteLength', 'mtimeMs', 'identitySha256']) {
      if (left?.[key] !== right?.[key]) out.add(`$.artifact.${key}`, 'artifact_changed_after_repeat');
    }
  }
  addCheck(
    checks,
    'duplicate_confirmation_idempotent',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

function validateS5Semantics(records, out, checks) {
  const start = out.issues.length;
  const expectedRelations = {
    long_start: 'new',
    stop: 'cancel',
    status_after_cancel: 'status',
    repeat_status: 'repeat',
  };
  for (const [phaseId, relation] of Object.entries(expectedRelations)) {
    const turns = phaseEvidence(records, phaseId, 'turn');
    if (turns.length !== 1) out.add(`$.phase[${phaseId}]`, 'control_turn_cardinality_invalid');
    else if (turns[0].observation?.relation !== relation) {
      out.add(`$.phase[${phaseId}]`, 'control_turn_relation_invalid', relation);
    }
  }
  const turnFor = phaseId => phaseEvidence(records, phaseId, 'turn')[0]?.observation || null;
  const longTurn = turnFor('long_start');
  const stopTurn = turnFor('stop');
  const statusTurn = turnFor('status_after_cancel');
  const repeatTurn = turnFor('repeat_status');
  if (longTurn?.targetRequestRef !== null || longTurn?.terminalStatus !== 'cancelled') {
    out.add('$.phase[long_start]', 'long_turn_cancelled_terminal_invalid');
  }
  const longRequestRef = longTurn?.requestRef;
  for (const [phaseId, turn] of [['stop', stopTurn], ['status_after_cancel', statusTurn]]) {
    if (!longRequestRef || turn?.targetRequestRef !== longRequestRef) {
      out.add(`$.phase[${phaseId}].targetRequestRef`, 'control_target_request_mismatch');
    }
    if (turn?.terminalStatus !== 'completed') {
      out.add(`$.phase[${phaseId}].terminalStatus`, 'control_sidecar_terminal_must_complete');
    }
  }
  if (!statusTurn?.requestRef || repeatTurn?.targetRequestRef !== statusTurn.requestRef) {
    out.add('$.phase[repeat_status].targetRequestRef', 'control_target_request_mismatch');
  }
  if (repeatTurn?.terminalStatus !== 'completed') {
    out.add('$.phase[repeat_status].terminalStatus', 'control_sidecar_terminal_must_complete');
  }
  if (!statusTurn?.userVisibleReply?.textSha256
    || repeatTurn?.userVisibleReply?.textSha256 !== statusTurn.userVisibleReply.textSha256) {
    out.add('$.phase[repeat_status].userVisibleReply.textSha256', 'control_repeat_reply_mismatch');
  }
  for (const phaseId of ['stop', 'status_after_cancel', 'repeat_status']) {
    const noninvocations = phaseEvidence(records, phaseId, 'model_noninvocation');
    if (noninvocations.length !== 1
      || noninvocations[0].observation?.executionOrigin !== 'request_only_control') {
      out.add(`$.phase[${phaseId}]`, 'control_model_noninvocation_required');
    }
  }
  const longRoutes = phaseEvidence(records, 'long_start', 'model_route');
  const longProviders = phaseEvidence(records, 'long_start', 'provider_attempt');
  const cancelledRouteAttempts = longRoutes.flatMap(record => record.observation?.attempts || [])
    .filter(attempt => attempt?.status === 'failed'
      && attempt?.errorCategory === 'cancelled'
      && attempt?.visibleOutputCommitted === false
      && Boolean(attempt?.outboundEvidenceSha256)
      && Boolean(attempt?.providerWitnessRef));
  const cancelledProviderAttempts = longProviders.filter(record => (
    record.observation?.status === 'failed'
    && record.observation?.errorCategory === 'cancelled'
    && record.observation?.visibleOutputCommitted === false
    && record.observation?.turnNonceSha256 === record.binding?.turnNonceSha256
  ));
  if (longRoutes.length !== 1 || cancelledRouteAttempts.length < 1
    || longProviders.length !== 1 || cancelledProviderAttempts.length !== 1) {
    out.add('$.phase[long_start]', 'cancelled_model_provider_evidence_incomplete');
  }
  const absence = phaseEvidence(records, 'repeat_status', 'absence_window');
  if (absence.length !== 1
    || absence[0].observation?.assertion !== 'no_new_task_or_tool_execution'
    || absence[0].observation?.matchedRecordCount !== 0) {
    out.add('$.phase[repeat_status]', 'control_repeat_absence_proof_invalid');
  }
  addCheck(
    checks,
    'request_only_control_sequence',
    out.issues.slice(start),
    records.map(record => record.evidenceId),
  );
}

export function validateTaskRegressionScenarioBundleV2(value) {
  const out = collector();
  const checks = [];
  const bundleKeys = ['kind', 'schemaVersion', 'bundleId', 'runId', 'scenarioId', 'coverageMode', 'evidence'];
  if (!strictObject(value, '$', bundleKeys, out)) {
    return { ok: false, valid: false, passed: false, issues: out.issues, checks };
  }
  if (value.kind !== TASK_REGRESSION_SCENARIO_BUNDLE_V2_KIND) out.add('$.kind', 'bundle_kind_mismatch');
  if (value.schemaVersion !== TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION) {
    out.add('$.schemaVersion', 'bundle_schema_version_mismatch');
  }
  identifier(value.bundleId, '$.bundleId', out);
  identifier(value.runId, '$.runId', out);
  enumValue(value.scenarioId, TASK_REGRESSION_V2_SCENARIO_IDS, '$.scenarioId', out);
  enumValue(value.coverageMode, ['portable_external', 'isolated_backend', 'formal_native'], '$.coverageMode', out);
  const profile = TASK_REGRESSION_V2_SCENARIO_PROFILES[value.scenarioId];
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    out.add('$.evidence', 'nonempty_array_required');
  }
  const records = Array.isArray(value.evidence) ? value.evidence : [];
  const evidenceIds = new Set();
  const monotonicSequences = new Set();
  records.forEach((record, index) => {
    const path = `$.evidence[${index}]`;
    validateEvidenceRecordInternal(record, path, out);
    if (record?.runId !== value.runId) out.add(`${path}.runId`, 'bundle_run_binding_mismatch');
    if (record?.scenarioId !== value.scenarioId) out.add(`${path}.scenarioId`, 'bundle_scenario_binding_mismatch');
    if (typeof record?.evidenceId === 'string') {
      if (evidenceIds.has(record.evidenceId)) out.add(`${path}.evidenceId`, 'duplicate_evidence_id');
      evidenceIds.add(record.evidenceId);
    }
    if (Number.isSafeInteger(record?.monotonicSequence)) {
      if (monotonicSequences.has(record.monotonicSequence)) {
        out.add(`${path}.monotonicSequence`, 'duplicate_monotonic_sequence');
      }
      monotonicSequences.add(record.monotonicSequence);
    }
    if (profile && !profile.phases.some(phase => phase.phaseId === record?.phaseId)) {
      out.add(`${path}.phaseId`, 'unknown_scenario_phase');
    }
  });

  const structuralIssueCount = out.issues.length;
  if (profile) validatePhaseContract(value, profile, records, out, checks);
  if (value.scenarioId === 'cleanup_offer_then_cleanup') {
    validateS1Semantics(records, out, checks);
  } else if (value.scenarioId === 'repeated_confirmation_exactly_once') {
    validateS2Semantics(records, out, checks);
  } else if (value.scenarioId === 'wps_wrong_file_correction') {
    validateS3Semantics(records, out, checks);
  } else if (value.scenarioId === 'displayed_result_stale_receipt') {
    validateS4Semantics(records, out, checks);
  } else if (value.scenarioId === 'control_stop_status_repeat') {
    validateS5Semantics(records, out, checks);
  } else if (value.scenarioId === 'voice_to_text_continuation') {
    validateS6Semantics(records, out, checks);
  } else if (value.scenarioId === 'mid_task_restart_recovery') {
    validateS7Semantics(records, out, checks);
  } else if (value.scenarioId === 'primary_model_failover_lmstudio') {
    validateS8Semantics(records, out, checks);
  }
  const valid = structuralIssueCount === 0;
  const passed = valid && out.issues.length === 0 && checks.every(check => check.passed);
  return {
    ok: passed,
    valid,
    passed,
    issues: out.issues,
    checks,
    adjudicationSource: 'task_regression_truth_v2_validator',
  };
}

export function assertTaskRegressionScenarioBundleV2(value) {
  const result = validateTaskRegressionScenarioBundleV2(value);
  if (!result.ok) throw new TaskRegressionTruthV2Error('task_regression_scenario_bundle_v2_invalid', result.issues);
  return value;
}
