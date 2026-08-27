import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import {
  PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
  PORTABLE_STORE_SNAPSHOT_KIND,
  PortableExternalEvidenceError,
  assertPortableEvidenceDataRoot,
  normalizePortableEvidenceManifest,
  phaseBindingFromManifest,
  portableEvidenceDataRootIdentity,
  portableEvidenceSha256,
  portablePhaseNonceRequestTag,
  signPortableEvidenceRecord,
  stablePortableEvidenceJson,
} from './portable-external-evidence.mjs';

const SAFE_SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROBE_TABLES = Object.freeze([
  'interactions',
  'conversations',
  'conversation_action_turns',
  'conversation_action_tasks',
  'conversation_action_receipts',
  'model_routing_receipts',
  'pending_tool_confirmations',
  'chat_execution_terminal_receipts',
]);

function fail(code, details, cause) {
  throw new PortableExternalEvidenceError(code, details, cause);
}

function quoteIdentifier(value) {
  const text = String(value || '');
  if (!SAFE_SQL_IDENTIFIER_RE.test(text)) fail('portable_store_identifier_invalid', { value: text });
  return `"${text}"`;
}

function isPathInside(basePath, candidatePath, allowEqual = false) {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  if (!relative) return allowEqual;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeFileMetadata(filename, code) {
  let metadata;
  try { metadata = fs.lstatSync(filename); } catch (error) { fail(code, undefined, error); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(code);
  return metadata;
}

function safeDirectoryMetadata(filename, code) {
  let metadata;
  try { metadata = fs.lstatSync(filename); } catch (error) { fail(code, undefined, error); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  return metadata;
}

function captureSafeFileIdentity(filename, code) {
  const metadata = safeFileMetadata(filename, code);
  const canonical = fs.realpathSync.native(filename);
  const canonicalMetadata = safeFileMetadata(canonical, code);
  if (metadata.dev !== canonicalMetadata.dev
    || metadata.ino !== canonicalMetadata.ino
    || metadata.size !== canonicalMetadata.size) {
    fail(code);
  }
  return {
    filename: path.resolve(filename),
    canonical,
    dev: canonicalMetadata.dev,
    ino: canonicalMetadata.ino,
    size: canonicalMetadata.size,
    nlink: canonicalMetadata.nlink,
    modifiedAt: canonicalMetadata.mtime.toISOString(),
  };
}

function assertSafeFileIdentityUnchanged(identity, code) {
  const current = captureSafeFileIdentity(identity.filename, code);
  if (current.canonical !== identity.canonical
    || current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.size !== identity.size
    || current.nlink !== 1) {
    fail(code);
  }
  return current;
}

function captureSqliteFileSet(databasePath, canonicalDataDirectory) {
  const identities = new Map();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${databasePath}${suffix}`;
    if (!fs.existsSync(candidate)) continue;
    const code = suffix ? 'portable_store_sqlite_sidecar_invalid' : 'portable_store_database_invalid';
    const identity = captureSafeFileIdentity(candidate, code);
    if (!isPathInside(canonicalDataDirectory, identity.canonical)) {
      fail(suffix ? 'portable_store_sqlite_sidecar_escape' : 'portable_store_database_escape');
    }
    identities.set(candidate, identity);
  }
  if (!identities.has(databasePath)) fail('portable_store_database_invalid');
  return identities;
}

function assertSqliteFileSetStable(before, databasePath, canonicalDataDirectory) {
  for (const identity of before.values()) {
    assertSafeFileIdentityUnchanged(identity, 'portable_store_sqlite_file_identity_changed');
  }
  const current = captureSqliteFileSet(databasePath, canonicalDataDirectory);
  for (const [filename, identity] of before.entries()) {
    const after = current.get(filename);
    if (!after || after.canonical !== identity.canonical || after.dev !== identity.dev
      || after.ino !== identity.ino || after.size !== identity.size) {
      fail('portable_store_sqlite_file_identity_changed');
    }
  }
  return current;
}

function sqliteOpenReadonly(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, error => {
      if (error) reject(error);
      else resolve(database);
    });
  });
}

function sqliteAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function sqliteGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

function sqliteExec(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sqliteClose(database) {
  return new Promise((resolve, reject) => {
    database.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class PortableReadonlySqlite {
  constructor(database) {
    this.database = database;
    this.columns = new Map();
    this.tables = null;
  }

  async initialize() {
    // query_only is connection-local and OPEN_READONLY prevents all durable
    // mutation even if a future query is accidentally broadened.
    await sqliteExec(this.database, 'PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN;');
    const rows = await sqliteAll(
      this.database,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
    );
    this.tables = new Set(rows.map(row => String(row.name || '')));
    return this;
  }

  hasTable(table) {
    if (!PROBE_TABLES.includes(table)) fail('portable_store_table_not_allowlisted', { table });
    return this.tables?.has(table) === true;
  }

  async tableColumns(table) {
    if (!this.hasTable(table)) return new Set();
    if (this.columns.has(table)) return this.columns.get(table);
    const rows = await sqliteAll(this.database, `PRAGMA table_info(${quoteIdentifier(table)})`);
    const columns = new Set(rows.map(row => String(row.name || '')));
    this.columns.set(table, columns);
    return columns;
  }

  async exactRows(table, filters, options = {}) {
    if (!this.hasTable(table)) {
      return { state: 'unsupported', table, reason: 'table_missing', rowCount: 0, rows: [] };
    }
    const columns = await this.tableColumns(table);
    const missingColumns = Object.keys(filters).filter(column => !columns.has(column));
    const requiredColumns = Array.isArray(options.requiredColumns) ? options.requiredColumns : [];
    for (const column of requiredColumns) {
      if (!columns.has(column) && !missingColumns.includes(column)) missingColumns.push(column);
    }
    if (missingColumns.length > 0) {
      return {
        state: 'unsupported',
        table,
        reason: 'selector_or_projection_column_missing',
        missingColumns: missingColumns.sort((left, right) => left.localeCompare(right)),
        rowCount: 0,
        rows: [],
      };
    }
    const entries = Object.entries(filters);
    if (entries.length === 0) fail('portable_store_exact_filter_required', { table });
    const where = entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(' AND ');
    const orderColumn = columns.has('id') ? 'id' : [...columns].sort()[0];
    const rows = await sqliteAll(
      this.database,
      `SELECT * FROM ${quoteIdentifier(table)} WHERE ${where} ORDER BY ${quoteIdentifier(orderColumn)} ASC`,
      entries.map(([, value]) => value),
    );
    const projected = rows.map(row => options.project ? options.project(row, columns) : row);
    if (rows.length === 0) return { state: 'missing', table, rowCount: 0, rows: [] };
    if (options.expectSingle === true && rows.length !== 1) {
      return { state: 'ambiguous', table, rowCount: rows.length, rows: projected };
    }
    return { state: 'present', table, rowCount: rows.length, rows: projected };
  }

  async dataVersion() {
    const row = await sqliteGet(this.database, 'PRAGMA data_version');
    return Math.max(0, Number(row?.data_version) || 0);
  }

  async schemaVersion() {
    const row = await sqliteGet(this.database, 'PRAGMA schema_version');
    return Math.max(0, Number(row?.schema_version) || 0);
  }

  async close() {
    try { await sqliteExec(this.database, 'ROLLBACK;'); } catch {}
    await sqliteClose(this.database);
  }
}

function stringValue(row, column) {
  return String(row?.[column] ?? '');
}

function integerValue(row, column) {
  const value = Number(row?.[column]);
  return Number.isSafeInteger(value) ? value : 0;
}

function hashText(value) {
  const text = String(value ?? '');
  return { characters: text.length, sha256: portableEvidenceSha256(text) };
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

function parseJsonProjection(value) {
  const text = String(value ?? '').trim();
  if (!text) return { state: 'cleared', value: null, serializedSha256: portableEvidenceSha256('') };
  try {
    return { state: 'present', value: JSON.parse(text), serializedSha256: portableEvidenceSha256(text) };
  } catch {
    return { state: 'invalid', value: null, serializedSha256: portableEvidenceSha256(text) };
  }
}

function projectToolCalls(value) {
  const parsed = parseJsonProjection(value);
  if (parsed.state === 'invalid') return { state: 'invalid', records: [], sha256: parsed.serializedSha256 };
  const calls = Array.isArray(parsed.value) ? parsed.value : [];
  return {
    state: calls.length > 0 ? 'present' : 'cleared',
    sha256: parsed.serializedSha256,
    records: calls.map(call => ({
      name: String(call?.name || ''),
      taskId: String(call?.taskId || ''),
      requestId: String(call?.requestId || ''),
      executionOrigin: String(call?.executionOrigin || ''),
      terminalVerificationStatus: String(call?.terminalVerification?.status || ''),
      argumentsSha256: portableEvidenceSha256(call?.arguments || {}),
      resultSha256: portableEvidenceSha256(String(call?.result || '')),
      hasError: Boolean(call?.error),
    })),
  };
}

function projectInteraction(row, columns, providerMarker) {
  const message = columns.has('message') ? stringValue(row, 'message') : '';
  const response = columns.has('response') ? stringValue(row, 'response') : '';
  const displayed = response || message;
  return {
    id: stringValue(row, 'id'),
    requestId: stringValue(row, 'requestId'),
    conversationId: stringValue(row, 'conversationId'),
    userId: stringValue(row, 'userId'),
    role: stringValue(row, 'role'),
    timestamp: stringValue(row, 'timestamp'),
    routeSequence: columns.has('routeSequence') ? integerValue(row, 'routeSequence') : 0,
    displayedText: hashText(displayed),
    message: hashText(message),
    response: hashText(response),
    llmWasCalled: columns.has('llmWasCalled') ? Number(row.llmWasCalled) === 1 : null,
    cognitiveIntent: columns.has('cognitiveIntent') ? stringValue(row, 'cognitiveIntent') : '',
    providerMarkerCount: countOccurrences(message, providerMarker),
    toolCalls: columns.has('toolCalls')
      ? projectToolCalls(row.toolCalls)
      : { state: 'unsupported', records: [], sha256: '' },
  };
}

function acceptedUserRowObservation(interactions, phase) {
  if (interactions.state !== 'present') {
    return { state: interactions.state, rowCount: 0, rows: [], reason: 'interaction_rows_unavailable' };
  }
  const userRows = interactions.rows.filter(row => row.role === 'user');
  if (userRows.length === 0) {
    return { state: 'missing', rowCount: 0, rows: [], reason: 'accepted_user_row_missing' };
  }
  if (userRows.length !== 1) {
    return {
      state: 'ambiguous',
      rowCount: userRows.length,
      rows: userRows,
      reason: 'multiple_exact_user_rows',
    };
  }
  if (userRows[0].requestId !== phase.requestId) {
    return {
      state: 'invalid',
      rowCount: 1,
      rows: userRows,
      reason: 'accepted_user_request_id_mismatch',
    };
  }
  const markerCount = Number(userRows[0].providerMarkerCount) || 0;
  if (markerCount === 0) {
    const requestNonceTag = portablePhaseNonceRequestTag(phase.phaseNonce);
    if (
      phase.requirements.providerWitness === false
      && phase.requestId.endsWith(`_${requestNonceTag}`)
    ) {
      return {
        state: 'present',
        rowCount: 1,
        rows: userRows,
        bindingMode: 'exact_request_id_with_manifest_nonce_tag',
        providerMarkerCount: 0,
        requestIdSha256: portableEvidenceSha256(phase.requestId),
        phaseNonceSha256: portableEvidenceSha256(phase.phaseNonce),
        requestNonceTagSha256: portableEvidenceSha256(requestNonceTag),
      };
    }
    return {
      state: 'invalid',
      rowCount: 1,
      rows: userRows,
      reason: 'provider_marker_missing_from_accepted_user_row',
      expectedProviderMarkerSha256: portableEvidenceSha256(phase.providerMarker),
    };
  }
  if (markerCount !== 1) {
    return {
      state: 'ambiguous',
      rowCount: 1,
      rows: userRows,
      reason: 'provider_marker_repeated_in_accepted_user_row',
      providerMarkerCount: markerCount,
      expectedProviderMarkerSha256: portableEvidenceSha256(phase.providerMarker),
    };
  }
  return {
    state: 'present',
    rowCount: 1,
    rows: userRows,
    providerMarkerCount: 1,
    providerMarkerSha256: portableEvidenceSha256(phase.providerMarker),
    phaseNonceSha256: portableEvidenceSha256(phase.phaseNonce),
  };
}

function projectConversation(row, columns) {
  return {
    id: stringValue(row, 'id'),
    userId: stringValue(row, 'userId'),
    status: columns.has('status') ? stringValue(row, 'status') : '',
    actionContinuationState: columns.has('actionContinuationState')
      ? parseJsonProjection(row.actionContinuationState)
      : { state: 'unsupported', value: null, serializedSha256: '' },
  };
}

function projectTurn(row) {
  return {
    id: stringValue(row, 'id'),
    conversationId: stringValue(row, 'conversationId'),
    userId: stringValue(row, 'userId'),
    requestId: stringValue(row, 'requestId'),
    userMessageId: stringValue(row, 'userMessageId'),
    taskId: stringValue(row, 'taskId'),
    status: stringValue(row, 'status'),
    terminalMessageId: stringValue(row, 'terminalMessageId'),
    terminalReason: stringValue(row, 'terminalReason'),
    leaseOwnerIdSha256: portableEvidenceSha256(stringValue(row, 'leaseOwnerId')),
    leaseEpochSha256: portableEvidenceSha256(stringValue(row, 'leaseEpoch')),
    leaseExpiresAt: stringValue(row, 'leaseExpiresAt'),
    revision: integerValue(row, 'revision'),
    createdAt: stringValue(row, 'createdAt'),
    updatedAt: stringValue(row, 'updatedAt'),
    terminalAt: stringValue(row, 'terminalAt'),
  };
}

function projectTask(row) {
  return {
    taskId: stringValue(row, 'id'),
    conversationId: stringValue(row, 'conversationId'),
    userId: stringValue(row, 'userId'),
    rootUserMessageId: stringValue(row, 'rootUserMessageId'),
    intentKind: stringValue(row, 'intentKind'),
    operation: stringValue(row, 'operation'),
    status: stringValue(row, 'status'),
    activeRequestId: stringValue(row, 'activeRequestId'),
    completionSource: stringValue(row, 'completionSource'),
    goal: hashText(stringValue(row, 'goal')),
    target: hashText(stringValue(row, 'target')),
    contextSha256: portableEvidenceSha256(stringValue(row, 'context')),
    revision: integerValue(row, 'revision'),
    createdAt: stringValue(row, 'createdAt'),
    updatedAt: stringValue(row, 'updatedAt'),
    completedAt: stringValue(row, 'completedAt'),
  };
}

function projectReceipt(row) {
  return {
    receiptId: stringValue(row, 'id'),
    taskId: stringValue(row, 'taskId'),
    conversationId: stringValue(row, 'conversationId'),
    turnId: stringValue(row, 'turnId'),
    requestId: stringValue(row, 'requestId'),
    idempotencyKeySha256: portableEvidenceSha256(stringValue(row, 'idempotencyKey')),
    toolName: stringValue(row, 'toolName'),
    targetIdentitySha256: portableEvidenceSha256(stringValue(row, 'targetIdentity')),
    inputDigest: stringValue(row, 'inputDigest'),
    envelopeSha256: portableEvidenceSha256(stringValue(row, 'envelope')),
    outcome: stringValue(row, 'outcome'),
    createdAt: stringValue(row, 'createdAt'),
  };
}

function projectRouting(row) {
  const attempts = stringValue(row, 'attempts');
  let attemptCount = 0;
  try {
    const parsed = JSON.parse(attempts || '[]');
    attemptCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {}
  return {
    id: stringValue(row, 'id'),
    conversationId: stringValue(row, 'conversationId'),
    requestId: stringValue(row, 'requestId'),
    status: stringValue(row, 'status'),
    requestedProvider: stringValue(row, 'requestedProvider'),
    requestedModel: stringValue(row, 'requestedModel'),
    selectedProvider: stringValue(row, 'selectedProvider'),
    selectedModel: stringValue(row, 'selectedModel'),
    selectionMode: stringValue(row, 'selectionMode'),
    fallbackReason: stringValue(row, 'fallbackReason'),
    attemptCount,
    attemptsSha256: portableEvidenceSha256(attempts),
    startedAt: stringValue(row, 'startedAt'),
    completedAt: stringValue(row, 'completedAt'),
    durationMs: integerValue(row, 'durationMs'),
  };
}

function projectPending(row) {
  return {
    id: stringValue(row, 'id'),
    revision: integerValue(row, 'revision'),
    status: stringValue(row, 'status'),
    userId: stringValue(row, 'userId'),
    channelId: stringValue(row, 'channelId'),
    taskId: stringValue(row, 'taskId'),
    originRequestId: stringValue(row, 'originRequestId'),
    toolName: stringValue(row, 'toolName'),
    argsHash: stringValue(row, 'argsHash'),
    targetSha256: portableEvidenceSha256(stringValue(row, 'target')),
    payloadDigest: stringValue(row, 'payloadDigest'),
    safeArgsSha256: portableEvidenceSha256(stringValue(row, 'safeArgs')),
    actionIntent: stringValue(row, 'actionIntent'),
    createdAt: stringValue(row, 'createdAt'),
    updatedAt: stringValue(row, 'updatedAt'),
    expiresAt: Number(row?.expiresAt) || 0,
  };
}

function projectChatExecutionReceipt(row) {
  const parsed = parseJsonProjection(row?.payload);
  const payload = parsed.state === 'present' && parsed.value && typeof parsed.value === 'object'
    ? parsed.value : {};
  const taskBinding = payload.taskBinding && typeof payload.taskBinding === 'object'
    ? payload.taskBinding
    : payload.taskRelation && typeof payload.taskRelation === 'object'
      ? payload.taskRelation
      : {};
  return {
    userId: stringValue(row, 'userId'),
    domain: stringValue(row, 'domain'),
    orgId: stringValue(row, 'orgId'),
    source: stringValue(row, 'source'),
    conversationId: stringValue(row, 'conversationId'),
    requestId: stringValue(row, 'requestId'),
    status: stringValue(row, 'status'),
    event: stringValue(row, 'event'),
    createdAt: stringValue(row, 'createdAt'),
    updatedAt: stringValue(row, 'updatedAt'),
    expiresAt: stringValue(row, 'expiresAt'),
    payload: {
      state: parsed.state,
      serializedSha256: parsed.serializedSha256,
      sidecar: payload.sidecar === true,
      finalized: payload.finalized === true,
      blocked: payload.blocked === true,
      reason: String(payload.reason || ''),
      controlIntent: String(payload.controlIntent || ''),
      targetRequestId: String(payload.targetRequestId || ''),
      taskBinding: {
        taskId: String(taskBinding.taskId || ''),
        revision: Number.isFinite(Number(taskBinding.revision))
          ? Math.max(0, Math.trunc(Number(taskBinding.revision))) : null,
        targetRequestId: String(taskBinding.targetRequestId || ''),
      },
      text: hashText(String(payload.text || payload.message || '')),
    },
  };
}

function livePointerObservation(conversation) {
  if (conversation.state !== 'present') {
    return {
      state: conversation.state,
      reason: conversation.reason || 'conversation_not_exactly_present',
    };
  }
  const parsed = conversation.rows[0]?.actionContinuationState;
  if (!parsed || parsed.state === 'unsupported') return { state: 'unsupported' };
  if (parsed.state === 'invalid') return { state: 'invalid', serializedSha256: parsed.serializedSha256 };
  const pointer = parsed.value;
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)
    || !String(pointer.taskId || '').trim()) {
    return { state: 'cleared', serializedSha256: parsed.serializedSha256 };
  }
  return {
    state: 'present',
    taskId: String(pointer.taskId || ''),
    requestId: String(pointer.activeRequestId || ''),
    status: String(pointer.status || ''),
    unfinished: pointer.unfinished === true,
    revision: Math.max(0, Number(pointer.revision) || 0),
    serializedSha256: parsed.serializedSha256,
  };
}

function taskObservation(turn, queriedTask) {
  if (turn.state === 'ambiguous' || turn.state === 'unsupported') {
    return { state: turn.state, reason: 'turn_not_exactly_selectable', rows: [] };
  }
  if (turn.state === 'missing') return { state: 'missing', reason: 'turn_missing', rows: [] };
  const taskId = String(turn.rows[0]?.taskId || '');
  if (!taskId) return { state: 'cleared', reason: 'turn_task_id_cleared', rows: [] };
  if (!queriedTask) return { state: 'missing', reason: 'task_query_not_run', expectedTaskId: taskId, rows: [] };
  if (queriedTask.state === 'missing') {
    return { ...queriedTask, expectedTaskId: taskId, reason: 'referenced_task_missing' };
  }
  return queriedTask;
}

function pendingObservation(rows) {
  if (rows.state !== 'present') return rows;
  const pendingRows = rows.rows.filter(row => row.status === 'pending');
  if (pendingRows.length > 1) {
    return { ...rows, state: 'ambiguous', activePendingCount: pendingRows.length };
  }
  if (pendingRows.length === 0) return { ...rows, state: 'cleared', activePendingCount: 0 };
  return { ...rows, state: 'present', activePendingCount: 1 };
}

function assistantReplyObservation(interactions) {
  if (interactions.state !== 'present') return { state: interactions.state, rowCount: 0, rows: [] };
  const rows = interactions.rows.filter(row => row.role === 'assistant');
  if (rows.length === 0) return { state: 'missing', rowCount: 0, rows: [] };
  if (rows.length > 1) return { state: 'ambiguous', rowCount: rows.length, rows };
  return { state: 'present', rowCount: 1, rows };
}

function issuePaths(value, prefix = '') {
  const issues = [];
  if (!value || typeof value !== 'object') return issues;
  if (['ambiguous', 'invalid', 'unsupported'].includes(value.state)) {
    issues.push(`${prefix || 'observation'}:${value.state}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'rows' || key === 'state') continue;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      issues.push(...issuePaths(item, prefix ? `${prefix}.${key}` : key));
    }
  }
  return issues;
}

async function observePhase(database, manifest, phase, capturedAt, source) {
  const selector = {
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  };
  const { binding } = phaseBindingFromManifest(manifest, selector);
  const interactions = await database.exactRows('interactions', {
    userId: phase.userId,
    conversationId: phase.conversationId,
    requestId: phase.requestId,
  }, {
    requiredColumns: ['id', 'role', 'message'],
    project: (row, columns) => projectInteraction(row, columns, phase.providerMarker),
  });
  const conversation = await database.exactRows('conversations', {
    id: phase.conversationId,
    userId: phase.userId,
  }, {
    expectSingle: true,
    requiredColumns: ['id', 'userId', 'actionContinuationState'],
    project: projectConversation,
  });
  const turn = await database.exactRows('conversation_action_turns', {
    conversationId: phase.conversationId,
    userId: phase.userId,
    requestId: phase.requestId,
  }, {
    expectSingle: true,
    requiredColumns: ['id', 'taskId', 'status'],
    project: projectTurn,
  });

  const exactTaskId = turn.state === 'present' ? String(turn.rows[0]?.taskId || '') : '';
  const queriedTask = exactTaskId
    ? await database.exactRows('conversation_action_tasks', {
        id: exactTaskId,
        conversationId: phase.conversationId,
        userId: phase.userId,
      }, {
        expectSingle: true,
        requiredColumns: ['id', 'status', 'goal'],
        project: projectTask,
      })
    : null;

  const receiptColumns = await database.tableColumns('conversation_action_receipts');
  const receiptFilters = receiptColumns.has('conversationId')
    ? { conversationId: phase.conversationId, requestId: phase.requestId }
    : { requestId: phase.requestId };
  const receipts = await database.exactRows('conversation_action_receipts', receiptFilters, {
    requiredColumns: ['id', 'taskId', 'requestId', 'toolName', 'outcome'],
    project: projectReceipt,
  });

  const routingColumns = await database.tableColumns('model_routing_receipts');
  const routingFilters = routingColumns.has('conversationId')
    ? { conversationId: phase.conversationId, requestId: phase.requestId }
    : { requestId: phase.requestId };
  const routing = await database.exactRows('model_routing_receipts', routingFilters, {
    requiredColumns: ['id', 'requestId', 'status', 'attempts'],
    project: projectRouting,
  });

  const pending = pendingObservation(await database.exactRows('pending_tool_confirmations', {
    userId: phase.userId,
    channelId: phase.channelId,
    originRequestId: phase.requestId,
  }, {
    requiredColumns: ['id', 'status', 'taskId', 'toolName'],
    project: projectPending,
  }));

  const chatExecutionReceipt = await database.exactRows('chat_execution_terminal_receipts', {
    userId: phase.userId,
    conversationId: phase.conversationId,
    requestId: phase.requestId,
  }, {
    expectSingle: true,
    requiredColumns: ['status', 'event', 'payload', 'source', 'updatedAt'],
    project: projectChatExecutionReceipt,
  });

  const observations = {
    interactions,
    acceptedUserRow: acceptedUserRowObservation(interactions, phase),
    assistantReplies: assistantReplyObservation(interactions),
    conversation,
    livePointer: livePointerObservation(conversation),
    turn,
    task: taskObservation(turn, queriedTask),
    receipts,
    pending,
    routing,
    chatExecutionReceipt,
  };
  // Chat execution receipts are an additional lifecycle diagnostic. Older
  // baselines and minimal evidence fixtures may not have this newer table, so
  // its absence must not retroactively invalidate the established portable
  // store structural contract.
  const { chatExecutionReceipt: _chatExecutionReceipt, ...structuralObservations } = observations;
  const markerJoinIssue = observations.acceptedUserRow.state === 'present'
    ? []
    : [`acceptedUserRow:${observations.acceptedUserRow.state}`];
  const issues = [...new Set([...issuePaths(structuralObservations), ...markerJoinIssue])]
    .sort((left, right) => left.localeCompare(right));
  const expectedToolReceiptCount = phase.expectedToolName && receipts.state === 'present'
    ? receipts.rows.filter(row => row.toolName === phase.expectedToolName).length
    : null;
  return {
    kind: PORTABLE_STORE_SNAPSHOT_KIND,
    schemaVersion: PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
    manifestDigest: manifest.manifestDigest,
    binding,
    capturedAt,
    source,
    selectionPolicy: 'exact_conversation_user_request_only_no_latest_wins',
    observations,
    expectedToolName: phase.expectedToolName,
    expectedToolReceiptCount,
    structurallyComplete: issues.length === 0,
    structuralIssues: issues,
  };
}

/**
 * Open the isolated SQLite store with OPEN_READONLY and collect every declared
 * phase in one read transaction. The function never imports db_layer.ts,
 * never starts the backend and never falls back to a newest/latest row.
 */
export async function probePortablePassiveStore(options) {
  const manifest = normalizePortableEvidenceManifest(options?.manifest);
  const identity = portableEvidenceDataRootIdentity(options?.dataRoot);
  if (identity.sha256 !== manifest.dataRootIdentitySha256) {
    fail('portable_store_data_root_manifest_mismatch');
  }
  const dataRoot = assertPortableEvidenceDataRoot(identity.canonical);
  const dataDirectory = path.join(dataRoot, 'data');
  safeDirectoryMetadata(dataDirectory, 'portable_store_data_directory_invalid');
  const canonicalDataDirectory = fs.realpathSync.native(dataDirectory);
  if (!isPathInside(dataRoot, canonicalDataDirectory)) fail('portable_store_data_directory_escape');
  const databasePath = path.join(canonicalDataDirectory, 'lumi.db');
  const sqliteFilesBeforeOpen = captureSqliteFileSet(databasePath, canonicalDataDirectory);
  const databaseIdentity = sqliteFilesBeforeOpen.get(databasePath);
  const canonicalDatabasePath = databaseIdentity.canonical;

  let database;
  try {
    database = new PortableReadonlySqlite(await sqliteOpenReadonly(canonicalDatabasePath));
    // Re-resolve immediately after SQLite opens the path. A hard-link swap or
    // replacement between validation and open is therefore rejected before a
    // query is issued.
    assertSqliteFileSetStable(sqliteFilesBeforeOpen, databasePath, canonicalDataDirectory);
    await database.initialize();
    const capturedAt = new Date(options?.capturedAt || Date.now()).toISOString();
    const source = {
      mode: 'sqlite_open_readonly_query_only_transaction',
      databasePathSha256: portableEvidenceSha256(canonicalDatabasePath),
      databaseBytesBefore: databaseIdentity.size,
      databaseModifiedAtBefore: databaseIdentity.modifiedAt,
      databaseDevice: databaseIdentity.dev,
      databaseInode: databaseIdentity.ino,
      databaseLinkCount: databaseIdentity.nlink,
      sqliteDataVersion: await database.dataVersion(),
      sqliteSchemaVersion: await database.schemaVersion(),
      dataRootIdentitySha256: identity.sha256,
    };
    const snapshots = [];
    for (const phase of manifest.phases) {
      snapshots.push(signPortableEvidenceRecord(
        await observePhase(database, manifest, phase, capturedAt, source),
        options?.hmacKey,
      ));
    }
    assertSqliteFileSetStable(sqliteFilesBeforeOpen, databasePath, canonicalDataDirectory);
    return signPortableEvidenceRecord({
      kind: 'lumi.portable-passive-store-probe-result',
      schemaVersion: PORTABLE_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
      manifestDigest: manifest.manifestDigest,
      source,
      snapshots,
      snapshotsSha256: portableEvidenceSha256(snapshots),
      selectionPolicy: 'all_manifest_phases_exactly_once_no_latest_wins',
    }, options?.hmacKey);
  } catch (error) {
    if (error instanceof PortableExternalEvidenceError) throw error;
    fail('portable_store_probe_failed', undefined, error);
  } finally {
    if (database) await database.close();
  }
}

export function summarizePortableStoreObservation(snapshot) {
  const observations = snapshot?.observations || {};
  return {
    bindingDigest: String(snapshot?.binding?.bindingDigest || ''),
    requestId: String(snapshot?.binding?.requestId || ''),
    states: Object.fromEntries(Object.entries(observations).map(([key, value]) => [key, value?.state || ''])),
    structuralIssues: Array.isArray(snapshot?.structuralIssues) ? [...snapshot.structuralIssues] : [],
    digest: portableEvidenceSha256(stablePortableEvidenceJson(snapshot)),
  };
}
