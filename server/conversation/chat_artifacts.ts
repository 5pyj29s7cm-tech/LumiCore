import { createHash } from 'node:crypto';
import { readDatabaseTables } from '../../db_layer';
import { privateExecutionReferences, projectExecutionReferenceText } from '../../shared/public_execution_language';
import { inspectPersistedToolExecutionReceipt } from '../tools/persisted_execution_receipt';
import { getCanonicalToolExecutionInputDigests } from '../tools/canonical_execution_record';
import { sanitizeToolRecordsForPersistence } from '../cognition/user_output_protection';
import { digest } from './ledger/serialization';
import { makeChatArtifact, type ChatArtifact } from '../../shared/chat_artifacts';
import { artifactPathFromRecord, isArtifactDeliveryRecord, isArtifactProducerRecord, isArtifactReaderRecord, artifactReadbackText, artifactReadbackTextSources, artifactRecordMatchesTurn, sameArtifactPath } from '../tools/artifact_evidence';
import { parseNestedJson, parseReceiptObject, toolRecordSucceeded, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { buildMediaArtifactReceipt } from '../socket/media_artifact_receipt';
import type { ToolExecutionRecord } from '../tools/types';
import path from 'node:path';
import fs from 'node:fs';
import { getGeneratedOutputDir } from '../config/data_path';


/** Declared output collections attach files without changing task completion. */
function declaredArtifactCollectionPaths(record: ToolExecutionRecord): string[] {
  const capability = record.capability;
  const verification = capability?.verification;
  if (record.terminalVerification?.status !== 'verified' || !toolRecordSucceeded(record)
    || (record.envelope && record.envelope.status !== 'verified_success')
    || !['create', 'mutate'].includes(capability?.operation || '')
    || !capability?.sideEffects.some(effect => effect.type === 'local_write')) return [];
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (!payload || (payload.ok !== true && payload.success !== true)) return [];
  const fields = new Set([...(verification?.requiredArtifactCollections || []),
    ...(verification?.requiredFields.includes('artifacts') ? ['artifacts'] : [])]);
  return [...fields].flatMap(field => {
    const collection = field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object'
      && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)
      ? (value as Record<string, unknown>)[key] : undefined, payload);
    if (!Array.isArray(collection) || !collection.length) return [];
    const outputs = collection.map(item => typeof item === 'string' ? item : item?.path);
    if (!outputs.every((output): output is string => {
      if (typeof output !== 'string' || !path.isAbsolute(output)) return false;
      try { const stat = fs.statSync(output); return stat.isFile() && stat.size > 0; }
      catch { return false; }
    })) return [];
    return outputs;
  });
}

/** Only server-owned terminal tool evidence can attach a local file to a chat. */
export function collectTechnicalChatArtifacts(value: unknown, conversationId?: string): ChatArtifact[] {
  const records = parseNestedJson(value);
  if (!Array.isArray(records)) return [];
  const paths = new Set<string>();
  const expanded = records.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as ToolExecutionRecord;
    const payload = parseReceiptObject(toolRecordTerminalPayload(record));
    if (!['get_workflow_run', 'run_workflow'].includes(record.name) || record.error || raw.outcome === 'failure'
      || record.terminalVerification?.status !== 'verified' || payload?.ok !== true
      || payload.success === false || payload.error || payload.reconciliationRequired
      || payload.status !== 'completed' || !payload.runId || !payload.workflowId
      || !(payload.totalSteps > 0 && payload.completedSteps === payload.totalSteps)) return [raw];
    // These are the workflow runtime's verified step outputs, not arbitrary
    // nested tool text. Input reads and model-only paths are never producers.
    const outputs = Array.isArray(payload.outputs) ? payload.outputs.slice(-20) : [];
    return [raw, ...outputs.filter(output => output?.status === 'verified' && typeof output.capabilityId === 'string')
      .map(output => ({ name: output.capabilityId, arguments: {}, result: typeof output.result === 'string'
        ? output.result : JSON.stringify(output.result), receipt: output.receipt, terminalVerification: record.terminalVerification }))];
  });
  for (const raw of expanded) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as ToolExecutionRecord;
    if (record.error || raw.outcome === 'failure') continue;
    const result = toolRecordTerminalPayload(record);
    const payload = parseReceiptObject(result);
    if (payload && (payload.ok === false || payload.success === false || payload.error
      || /^(failed|error|cancelled|canceled|pending|waiting_confirmation|unknown_outcome)$/i.test(String(payload.status || '')))) continue;
    for (const output of declaredArtifactCollectionPaths(record)) paths.add(output);
    const media = buildMediaArtifactReceipt(record.name, record.arguments, result);
    if (media) {
      for (const artifact of media.artifacts) if (artifact.path) paths.add(artifact.path);
    } else if (record.name === 'external_cli_run' && record.terminalVerification?.status === 'verified'
      && payload?.ok === true && payload.status === 'completed' && payload.exitCode === 0 && payload.runId && Array.isArray(payload.artifacts)) {
      for (const artifact of payload.artifacts.slice(0, 24)) {
        if (typeof artifact?.path === 'string' && artifact.size > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256 || '')) paths.add(artifact.path);
      }
    } else if (record.terminalVerification?.status === 'verified' && isArtifactDeliveryRecord(record)) {
      const output = artifactPathFromRecord(record);
      if (output && (/^[a-z]:[\\/]/i.test(output) || output.startsWith('/'))) paths.add(output);
    }
  }
  const normalized: string[] = [];
  for (let filePath of paths) {
    if (filePath.startsWith('/lumi_output/')) {
      const root = getGeneratedOutputDir();
      filePath = path.resolve(root, filePath.slice('/lumi_output/'.length));
      const relative = path.relative(root, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    }
    if (!normalized.some(other => sameArtifactPath(other, filePath))) normalized.push(filePath);
  }
  return normalized.map(filePath => makeChatArtifact(filePath, conversationId));
}

export interface PublicArtifactContext {
  userId?: string; conversationId?: string; taskId?: string; requestId?: string;
  domain?: 'personal' | 'work'; orgId?: string;
  originalText?: string[];
}
export interface ArtifactContentSnapshot { path: string; sha256: string; text?: string; observedIds?: string[] }
export interface ArchivedArtifactDisclosureEvidence {
  version: 1; sha256: string; taskId: string; requestId: string; producerId: string; readbackId?: string;
  privateIds: string[]; literalIds: string[];
}
export interface ArtifactReadVersion {
  path: string; taskId: string; requestId: string; sha256: string;
  privateReferences: string[];
}

/** The caller supplies only verified server records. No files, receipts, or task state are changed. */
export function projectPublicArtifactDelivery(input: {
  artifacts: ChatArtifact[]; records: ToolExecutionRecord[]; originalText?: string[];
  snapshots?: ArtifactContentSnapshot[]; text?: string; progress?: { evidence?: string[] };
  originalTextByRequest?: Record<string, string[]>;
  privateIdsByRequest?: Record<string, string[]>;
  archiveEvidence?: ArchivedArtifactDisclosureEvidence;
  versions?: ArtifactReadVersion[];
}) {
  const records = input.records;
  const versions: ArtifactReadVersion[] = [...(input.versions || [])];
  for (const [index, producer] of records.entries()) {
    if (!isArtifactProducerRecord(producer)) continue;
    const output = artifactPathFromRecord(producer);
    if (!output) continue;
    const scoped = records.filter(record => artifactRecordMatchesTurn(record, producer));
    const requests = [...(input.originalText || []), ...(input.originalTextByRequest?.[producer.requestId || ''] || [])];
    const original = [...requests, ...artifactReadbackTextSources(scoped, requests).sourceText];
    const ids = [...scoped.flatMap(record => [record.id, record.taskId, record.requestId]), ...(input.privateIdsByRequest?.[producer.requestId || ''] || [])];
    const actual = input.snapshots?.find(item => sameArtifactPath(item.path, output));
    if (actual && (actual.observedIds || actual.text !== undefined && createHash('sha256').update(actual.text, 'utf8').digest('hex') === actual.sha256)) {
      const privateReferences = privateExecutionReferences(actual.text ?? actual.observedIds!.filter(id => ids.includes(id)).join('\n'), ids, original);
      if (privateReferences.length) versions.push({ path: output, taskId: producer.taskId || '', requestId: producer.requestId || '', sha256: actual.sha256, privateReferences });
    }
    if (input.versions) continue;
    const next = records.findIndex((record, candidate) => candidate > index && isArtifactProducerRecord(record)
      && sameArtifactPath(output, artifactPathFromRecord(record)));
    const readback = records.slice(index + 1, next < 0 ? undefined : next).find(record => record.name === 'read_file'
      && isArtifactReaderRecord(record) && sameArtifactPath(output, artifactPathFromRecord(record))
      && artifactRecordMatchesTurn(record, producer));
    if (!readback) continue;
    const payload = parseReceiptObject(toolRecordTerminalPayload(readback));
    let text = artifactReadbackText(readback);
    const digest = payload?.kind === 'text_readback_metadata' && /^[a-f0-9]{64}$/.test(payload.contentDigest || '')
      ? payload.contentDigest as string : text !== undefined ? createHash('sha256').update(text, 'utf8').digest('hex') : '';
    const snapshot = input.snapshots?.find(item => sameArtifactPath(item.path, output) && item.sha256 === digest);
    if (text === undefined) text = snapshot?.text;
    if (!digest || text === undefined || createHash('sha256').update(text, 'utf8').digest('hex') !== digest) continue;
    versions.push({ path: output, taskId: producer.taskId || '', requestId: producer.requestId || '', sha256: digest,
      privateReferences: privateExecutionReferences(text, ids, original) });
  }
  const archived = input.archiveEvidence;
  if (isObservedArchivedArtifactEvidence(archived)) for (const artifact of input.artifacts) {
    versions.push({ path: artifact.path, taskId: archived.taskId, requestId: archived.requestId, sha256: archived.sha256,
      privateReferences: privateExecutionReferences(archived.privateIds.join('\n'), archived.privateIds, archived.literalIds) });
  }
  const withheldPaths = input.artifacts.filter(artifact => {
    const snapshot = input.snapshots?.find(item => sameArtifactPath(item.path, artifact.path));
    const related = versions.filter(version => sameArtifactPath(version.path, artifact.path));
    if (!related.some(version => version.privateReferences.length)) return false;
    // A later clean overwrite has a different observed digest. It cannot wash the previous snapshot.
    return !snapshot || !related.some(version => version.sha256 === snapshot.sha256 && !version.privateReferences.length);
  }).map(artifact => artifact.path);
  const omitPaths = (value: string) => omitWithheldArtifactPaths(value, withheldPaths);
  return {
    artifacts: input.artifacts.filter(artifact => !withheldPaths.some(file => sameArtifactPath(file, artifact.path))),
    text: omitPaths(input.text || ''),
    ...(input.progress ? { progress: { ...input.progress, ...(input.progress.evidence
      ? { evidence: input.progress.evidence.map(omitPaths).filter(Boolean) } : {}) } } : {}),
    withheldPaths, versions, deliveryBlocked: withheldPaths.length > 0,
  };
}

/** One server-owned request snapshot and local indexes; no durable or process-global cache. */
export function capturePublicArtifactEvidenceSnapshot(currentRecords: readonly ToolExecutionRecord[] = [], currentContext: PublicArtifactContext = {}) {
  const db = readDatabaseTables(['conversationActionTasks', 'conversationActionTurns', 'conversationActionReceipts', 'interactions']);
  const tasks = new Map<string, any>((db.conversationActionTasks || []).map((task: any) => [task.id, task]));
  const scopeKey = (taskId: string, requestId: string) => JSON.stringify([taskId, requestId]);
  const ownerKey = (row: any, requestId: string) => JSON.stringify([row.userId, row.conversationId, row.domain || 'personal', row.orgId || '', requestId]);
  const turns = new Map<string, any[]>(), originals = new Map<string, string[]>(), metadata = new Map<string, ToolExecutionRecord[]>();
  const rowKeys = (row: { id?: string; idempotencyKey?: string; name?: string; toolName?: string }) => [row.id, row.idempotencyKey].filter(Boolean).map(id => JSON.stringify([row.name || row.toolName, id]));
  const addMetadata = (record: ToolExecutionRecord) => { for (const key of rowKeys(record)) { const values = metadata.get(key) || []; values.push(record); metadata.set(key, values); } };
  for (const turn of db.conversationActionTurns || []) { const key = scopeKey(turn.taskId, turn.requestId), values = turns.get(key) || []; values.push(turn); turns.set(key, values); }
  for (const task of tasks.values()) {
    const stored = parseReceiptObject(task.context);
    for (const record of Array.isArray(stored?.actionState?.receipts) ? stored.actionState.receipts : []) if (record && typeof record === 'object') addMetadata(record);
  }
  // Current records have not necessarily reached terminal message storage yet.
  // Only the engine's unmodified in-process brand may supplement this request;
  // its persisted representation must still match the durable row below.
  if (currentContext.taskId && currentContext.requestId) for (const record of currentRecords) {
    if (record.taskId !== currentContext.taskId || record.requestId !== currentContext.requestId
      || !getCanonicalToolExecutionInputDigests(record)?.argumentsDigest) continue;
    const persisted = sanitizeToolRecordsForPersistence([record])?.[0] as ToolExecutionRecord | undefined;
    if (persisted) addMetadata(persisted);
  }
  const userMessages = new Map<string, any>();
  for (const message of db.interactions || []) {
    const genuineUser = message.role === 'user' || (!message.role && typeof message.response === 'string');
    if (genuineUser) {
      userMessages.set(message.id, message);
      const key = ownerKey(message, message.requestId || ''), values = originals.get(key) || [];
      values.push(String(message.message || message.content || '')); originals.set(key, values);
    }
    const messageRecords = parseNestedJson(message.toolCalls);
    for (const record of Array.isArray(messageRecords) ? messageRecords : []) if (record && typeof record === 'object') {
      const task = tasks.get(record.taskId);
      if (task && ownerKey(task, record.requestId || '') === ownerKey(message, message.requestId || record.requestId || '')) addMetadata(record);
    }
  }
  const byIdentity = new Map<string, ToolExecutionRecord[]>(), byScope = new Map<string, ToolExecutionRecord[]>();
  const privateByScope = new Map<string, string[]>();
  const byTask = new Map<string, ToolExecutionRecord[]>(), byUser = new Map<string, ToolExecutionRecord[]>(), byOrg = new Map<string, ToolExecutionRecord[]>(), byConversation = new Map<string, ToolExecutionRecord[]>();
  for (const row of db.conversationActionReceipts || []) {
    const task = tasks.get(row.taskId), candidates = turns.get(scopeKey(row.taskId, row.requestId)) || [];
    const owned = candidates.filter(turn => ownerKey(turn, row.requestId) === ownerKey(task || {}, row.requestId));
    if (!task || owned.length !== 1 || row.conversationId !== task.conversationId) continue;
    const inspected = inspectPersistedToolExecutionReceipt(row, { rowTaskId: task.id, envelopeTaskId: task.id,
      requestId: row.requestId, ...(row.turnRowId ? { turnRowId: owned[0].id } : {}), toolName: row.toolName, outcome: row.outcome });
    if (!inspected.valid) continue;
    const envelope = inspected.envelope!;
    const stored = rowKeys(row).flatMap(key => metadata.get(key) || []).find(record => record.name === row.toolName
      && record.taskId === row.taskId && record.requestId === row.requestId && row.idempotencyKey && record.idempotencyKey === row.idempotencyKey
      && row.inputDigest && digest(record.arguments || {}) === row.inputDigest);
    // Reconstruct every target/result from the durable row. Raw JSON path/target/capability never chooses an output or source exception.
    const record: ToolExecutionRecord = { id: stored?.id || row.id, idempotencyKey: row.idempotencyKey, name: row.toolName,
      taskId: row.taskId, requestId: row.requestId, turnId: row.turnId, ...(row.turnRowId ? { turnRowId: row.turnRowId } : {}),
      arguments: row.toolName === 'read_file' || row.toolName === 'write_file' ? { path: row.targetIdentity } : { target: row.targetIdentity },
      result: typeof envelope.result === 'string' ? envelope.result : stored?.result || JSON.stringify(envelope.result ?? ''),
      receipt: envelope.result ?? stored?.receipt, envelope, ...(stored?.capability ? { capability: stored.capability } : {}),
      ...(stored?.adapterStarted === true ? { adapterStarted: true } : {}),
      terminalVerification: { status: inspected.explicitlyTerminalVerified ? 'verified' : envelope.verification.status, strategy: 'terminal_receipt', reason: envelope.verification.reason } };
    for (const key of new Set([...rowKeys(row), ...rowKeys(record)])) { const values = byIdentity.get(key) || []; values.push(record); byIdentity.set(key, values); }
    const scope = scopeKey(row.taskId, row.requestId);
    privateByScope.set(scope, [...new Set([...(privateByScope.get(scope) || []), row.id, record.id, row.taskId, row.requestId])]);
    // Private identity is not a success receipt: failed/pending calls never become artifact evidence.
    if (!inspected.explicitlyTerminalVerified || envelope.status !== 'verified_success') continue;
    const values = byScope.get(scope) || []; values.push(record); byScope.set(scope, values);
    for (const [index, key] of [[byTask, task.id], [byUser, task.userId], [byOrg, task.orgId || ''], [byConversation, task.conversationId]] as const) {
      const records = index.get(key) || []; records.push(record); index.set(key, records);
    }
  }
  const matches = (task: any, context: PublicArtifactContext) => task && (!context.userId || task.userId === context.userId)
    && (!context.conversationId || task.conversationId === context.conversationId) && (!context.taskId || task.id === context.taskId)
    && (!context.domain || (task.domain || 'personal') === context.domain) && (!context.orgId || task.orgId === context.orgId);
  const originalFor = (task: any, requestId: string) => {
    const result = [...(originals.get(ownerKey(task, requestId)) || [])], root = userMessages.get(task.rootUserMessageId);
    if (root && ownerKey(root, '') === ownerKey(task, '')) result.push(String(root.message || root.content || ''));
    return result;
  };
  const preparedScopes = new Map<string, { records: ToolExecutionRecord[]; originalText: string[]; originalTextByRequest: Record<string, string[]>; privateIds: string[]; privateIdsByRequest: Record<string, string[]>; versions: ArtifactReadVersion[] }>();
  return { tasks, matches,
    hasAcceptedTurn(taskId: string, requestId: string, context: PublicArtifactContext) {
      const task = tasks.get(taskId), owned = (turns.get(scopeKey(taskId, requestId)) || []).filter(turn => ownerKey(turn, requestId) === ownerKey(task || {}, requestId));
      return matches(task, context) && owned.length === 1;
    },
    scopeEvidence(context: PublicArtifactContext) {
      const exactKey = context.taskId && context.requestId && matches(tasks.get(context.taskId), context) ? scopeKey(context.taskId, context.requestId) : '';
      if (exactKey && preparedScopes.has(exactKey)) return preparedScopes.get(exactKey)!;
      const candidates = context.taskId && context.requestId ? byScope.get(scopeKey(context.taskId, context.requestId)) || []
        : context.taskId ? byTask.get(context.taskId) || [] : context.conversationId ? byConversation.get(context.conversationId) || []
        : context.userId ? byUser.get(context.userId) || [] : context.orgId ? byOrg.get(context.orgId) || [] : [];
      const records = candidates.filter(record => matches(tasks.get(record.taskId!), context) && (!context.requestId || record.requestId === context.requestId));
      const originalTextByRequest: Record<string, string[]> = {};
      for (const record of records) originalTextByRequest[record.requestId!] = originalFor(tasks.get(record.taskId!), record.requestId!);
      const privateIdsByRequest: Record<string, string[]> = {};
      for (const record of records) privateIdsByRequest[record.requestId!] = privateByScope.get(scopeKey(record.taskId!, record.requestId!)) || [];
      if (exactKey) {
        privateIdsByRequest[context.requestId!] = privateByScope.get(exactKey) || [];
        originalTextByRequest[context.requestId!] = originalFor(tasks.get(context.taskId!), context.requestId!);
      }
      const evidence = { records, originalText: context.originalText || [], originalTextByRequest, privateIdsByRequest, privateIds: Object.values(privateIdsByRequest).flat() };
      const result = { ...evidence, versions: projectPublicArtifactDelivery({ artifacts: [], ...evidence }).versions };
      if (exactKey) preparedScopes.set(exactKey, result);
      return result;
    },
    resolve(value: unknown, context: PublicArtifactContext) {
      const parsed = parseNestedJson(value), raw = Array.isArray(parsed) ? parsed.filter((record): record is ToolExecutionRecord => Boolean(record && typeof record === 'object')) : [];
      const modern = Boolean(context.requestId || context.taskId || raw.some(record => record.taskId || record.requestId || record.envelope?.version === 1));
      const matched = raw.flatMap(record => {
        const candidates = [...new Set(rowKeys(record).flatMap(key => byIdentity.get(key) || []))].filter(item => item.name === record.name
          && (!record.idempotencyKey || item.idempotencyKey === record.idempotencyKey)
          && (!record.taskId || item.taskId === record.taskId) && (!record.requestId || item.requestId === record.requestId)
          && (!context.requestId || item.requestId === context.requestId) && matches(tasks.get(item.taskId!), context));
        return candidates.length === 1 ? [candidates[0]] : [];
      });
      const scopes = new Set(matched.map(record => scopeKey(record.taskId!, record.requestId!)));
      const selected = matched.filter(record => (byScope.get(scopeKey(record.taskId!, record.requestId!)) || []).includes(record));
      const records = [...scopes].flatMap(scope => byScope.get(scope) || []), originalTextByRequest: Record<string, string[]> = {};
      for (const record of [...records, ...matched]) originalTextByRequest[record.requestId!] = originalFor(tasks.get(record.taskId!), record.requestId!);
      const privateIdsByRequest: Record<string, string[]> = {};
      for (const record of [...records, ...matched]) privateIdsByRequest[record.requestId!] = privateByScope.get(scopeKey(record.taskId!, record.requestId!)) || [];
      return { records, selected, legacy: modern ? [] : raw, originalText: context.originalText || [], originalTextByRequest, privateIdsByRequest, privateIds: Object.values(privateIdsByRequest).flat() };
    },
  };
}
export type PublicArtifactEvidenceSnapshot = ReturnType<typeof capturePublicArtifactEvidenceSnapshot>;
export function publicArtifactEvidence(value: unknown, context: PublicArtifactContext = {}, snapshot = capturePublicArtifactEvidenceSnapshot(Array.isArray(value) ? value : [], context)) {
  return snapshot.resolve(value, context);
}

export function artifactContentSnapshot(file: string, identities: readonly string[] = [], requireSHA = false): ArtifactContentSnapshot | undefined {
  let descriptor: number | undefined;
  try {
    const before = fs.statSync(file);
    if (before.size <= 100 * 1024) {
      const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
      return { path: file, sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(Buffer.from(text, 'utf8').equals(bytes) ? { text, observedIds: identities.filter(id => text.includes(id)) } : {}) };
    }
    // Large files contribute only exact negative UTF8 observations, never a
    // native-read receipt or a full source body. Memory is bounded per chunk.
    const ids = [...new Set(identities.filter(Boolean))];
    if (!ids.length && !requireSHA) return undefined;
    descriptor = fs.openSync(file, 'r');
    const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
    const chunk = Buffer.alloc(64 * 1024), present = new Set<string>(), overlap = ids.reduce((max, id) => Math.max(max, id.length), 0) - 1;
    let tail = '', valid = true;
    for (let length = fs.readSync(descriptor, chunk, 0, chunk.length, null); length > 0; length = fs.readSync(descriptor, chunk, 0, chunk.length, null)) {
      const bytes = chunk.subarray(0, length); hash.update(bytes);
      if (valid) try {
        const text = tail + decoder.decode(bytes, { stream: true });
        for (const id of ids) if (text.includes(id)) present.add(id);
        tail = overlap > 0 ? text.slice(-overlap) : '';
      } catch { valid = false; if (!requireSHA) return undefined; }
    }
    if (valid) try { const text = tail + decoder.decode(); for (const id of ids) if (text.includes(id)) present.add(id); } catch { valid = false; }
    const after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) return undefined;
    return { path: file, sha256: hash.digest('hex'), ...(valid ? { observedIds: [...present] } : {}) };
  } catch { return undefined; } finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
}

export function publicChatArtifactDelivery(value: unknown, conversationId?: string,
  context: PublicArtifactContext & { text?: string; progress?: { evidence?: string[] } } = {},
  evidenceSnapshot = capturePublicArtifactEvidenceSnapshot(Array.isArray(value) ? value : [], context)) {
  const evidence = publicArtifactEvidence(value, { ...context, conversationId: conversationId || context.conversationId }, evidenceSnapshot);
  const artifacts = collectTechnicalChatArtifacts([...evidence.selected, ...evidence.legacy], conversationId);
  const requests = [...evidence.originalText, ...Object.values(evidence.originalTextByRequest).flat()];
  const { sourceText, verifiedText } = artifactReadbackTextSources(evidence.records, requests);
  const originals = [...requests, ...sourceText];
  const privateIds = evidence.privateIds;
  const references = privateExecutionReferences(context.text || '', privateIds, originals);
  const projection = projectPublicArtifactDelivery({ artifacts, ...evidence,
    snapshots: artifacts.filter(artifact => evidence.records.some(record => isArtifactProducerRecord(record)
      && sameArtifactPath(artifact.path, artifactPathFromRecord(record)))).map(artifact => artifactContentSnapshot(artifact.path, privateIds)).filter((item): item is ArtifactContentSnapshot => Boolean(item)),
    text: projectExecutionReferenceText(context.text || '', references, verifiedText), progress: context.progress });
  return { ...projection, deliveryBlocked: projection.deliveryBlocked || references.length > 0 };
}

/** Public files are a projection; raw successful output receipts remain available to the archive engine. */
export function collectChatArtifacts(value: unknown, conversationId?: string): ChatArtifact[] {
  return publicChatArtifactDelivery(value, conversationId).artifacts;
}

/** Rebuild only this server-owned execution scope; serialized client envelopes are never authority. */
export function publicArtifactSnapshotDelivery(snapshot: ArtifactContentSnapshot | undefined,
  sourcePath: string, context: PublicArtifactContext, expectedArchiveSHA?: string, archiveEvidence?: ArchivedArtifactDisclosureEvidence,
  evidenceSnapshot?: PublicArtifactEvidenceSnapshot, metadataOnly = false) {
  const bound = isArchivedArtifactEvidence(archiveEvidence) && archiveEvidence.taskId === context.taskId
    && archiveEvidence.requestId === context.requestId && archiveEvidence.sha256 === expectedArchiveSHA;
  const observed = bound && isObservedArchivedArtifactEvidence(archiveEvidence);
  const evidence = metadataOnly || observed ? { records: [], originalText: [], originalTextByRequest: {}, versions: [] }
    : (evidenceSnapshot || capturePublicArtifactEvidenceSnapshot()).scopeEvidence(context);
  const projection = projectPublicArtifactDelivery({ artifacts: [makeChatArtifact(sourcePath)], ...evidence,
    snapshots: snapshot ? [{ ...snapshot, path: sourcePath }] : [],
    ...(archiveEvidence && archiveEvidence.taskId === context.taskId && archiveEvidence.requestId === context.requestId
      && archiveEvidence.sha256 === expectedArchiveSHA ? { archiveEvidence } : {}) });
  const relatedPollution = projection.versions.some(version => sameArtifactPath(version.path, sourcePath) && version.privateReferences.length > 0);
  return { ...projection, deliveryBlocked: projection.deliveryBlocked
    || Boolean(!metadataOnly && (relatedPollution || bound) && expectedArchiveSHA && snapshot?.sha256 !== expectedArchiveSHA) };
}

/** The same projection owns live replies and server-loaded history cards/prose. */
export function projectPublicArtifactPayload<T extends Record<string, any>>(payload: T, records: unknown,
  conversationId?: string, context: PublicArtifactContext = {}, evidenceSnapshot = capturePublicArtifactEvidenceSnapshot(Array.isArray(records) ? records : [], context)): T & { fileArtifacts: ChatArtifact[]; blocked?: boolean; reason?: string } {
  const projection = publicChatArtifactDelivery(records, conversationId, { ...context,
    text: String(payload.text || ''), progress: payload.artifactProgress }, evidenceSnapshot);
  const cleanText = (text: string) => omitWithheldArtifactPaths(text, projection.withheldPaths);
  const feedback = payload.completionFeedback;
  return { ...payload, ...(payload.text !== undefined ? { text: projection.text } : {}),
    fileArtifacts: projection.artifacts,
    ...(projection.progress ? { artifactProgress: projection.progress } : {}),
    ...(projection.deliveryBlocked ? { blocked: feedback && feedback.status !== 'completed' ? payload.blocked === true : true,
      reason: payload.blocked || (feedback && feedback.status !== 'completed') ? payload.reason : 'execution_recovery_incomplete',
      ...(feedback && typeof feedback === 'object' ? { completionFeedback: { ...feedback,
        ...(feedback.status === 'completed' ? { status: 'blocked' } : {}),
        ...Object.fromEntries(['completed', 'evidence', 'incomplete', 'blockers', 'nextSteps'].filter(key => Array.isArray(feedback[key]))
          .map(key => [key, feedback[key].map((text: unknown) => typeof text === 'string' ? cleanText(text) : text).filter(Boolean)])),
      } } : {}) } : {}),
  };
}

export function omitWithheldArtifactPaths(value: string, withheldPaths: readonly string[]): string {
    let result = value;
    for (const file of withheldPaths) {
      const relative = path.relative(getGeneratedOutputDir(), file);
      const outputAlias = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? '/lumi_output/' + relative.replace(/\\/g, '/') : '';
      const variants = [file, file.replace(/\\/g, '/'), file.replace(/\//g, '\\'), file.replace(/\\/g, '\\\\'), outputAlias].filter(Boolean);
      const aliases = new Set(variants.flatMap(value => [value, encodeURIComponent(value), new URLSearchParams({ path: value }).toString().slice(5)]));
      for (const alias of aliases) if (alias) result = result.split(alias).join('');
    }
    return result;
}

/** Private provenance only: exact identities and proven literal exceptions, never raw prompts or source text. */
export function captureArchivedArtifactDisclosureEvidence(record: ToolExecutionRecord, context: PublicArtifactContext,
  sha256: string, outputPath: string, prior?: ArchivedArtifactDisclosureEvidence,
  evidenceSnapshot = capturePublicArtifactEvidenceSnapshot([record], context), snapshotFile?: string): ArchivedArtifactDisclosureEvidence | undefined {
  const task = evidenceSnapshot.tasks.get(record.taskId || '');
  if (!task || !evidenceSnapshot.hasAcceptedTurn(task.id, record.requestId || '', context)
    || record.requestId !== context.requestId || !record.id || record.adapterStarted !== true || record.terminalVerification?.status !== 'verified'
    || !/^[a-f0-9]{64}$/.test(sha256) || !(isArtifactProducerRecord(record)
      ? collectTechnicalChatArtifacts([record], context.conversationId).some(artifact => sameArtifactPath(outputPath, artifact.path))
      : sameArtifactPath(outputPath, artifactPathFromRecord(record)))) return prior;
  const evidence = evidenceSnapshot.scopeEvidence(context);
  const scoped = [...evidence.records, record];
  const ids = [...new Set([...evidence.privateIds, ...scoped.flatMap(item => [item.id, item.taskId, item.requestId])].filter((id): id is string => Boolean(id)))];
  const requests = evidence.originalTextByRequest[record.requestId || ''] || [];
  const original = [...requests, ...artifactReadbackTextSources(scoped, requests).sourceText];
  if (!prior) {
    if (!isArtifactProducerRecord(record)) return undefined;
    const snapshot = snapshotFile ? artifactContentSnapshot(snapshotFile, ids) : undefined;
    const present = snapshot?.sha256 === sha256 ? snapshot.observedIds || [] : [];
    return { version: 1, sha256, taskId: task.id, requestId: record.requestId!, producerId: record.id,
      privateIds: present, literalIds: present.filter(id => original.some(text => text.includes(id))) };
  }
  if (snapshotFile && prior.sha256 === sha256 && prior.taskId === record.taskId && prior.requestId === record.requestId
    && prior.producerId === record.id && isArtifactProducerRecord(record)) {
    const snapshot = artifactContentSnapshot(snapshotFile, ids);
    if (snapshot?.sha256 !== sha256) return prior;
    const present = snapshot.observedIds || [];
    return { ...prior, privateIds: [...new Set([...prior.privateIds, ...present])],
      literalIds: [...new Set([...prior.literalIds, ...present.filter(id => original.some(text => text.includes(id)))])] };
  }
  if (prior.readbackId || prior.sha256 !== sha256 || prior.taskId !== record.taskId || prior.requestId !== record.requestId
    || record.name !== 'read_file' || !evidence.records.some(item => item.id === prior.producerId && isArtifactProducerRecord(item))) return prior;
  const body = artifactReadbackText(record);
  if (body === undefined || createHash('sha256').update(body, 'utf8').digest('hex') !== sha256) return prior;
  const presentIds = ids.filter(id => body.includes(id));
  return { ...prior, readbackId: record.id, privateIds: presentIds, literalIds: presentIds.filter(id => original.some(text => text.includes(id))) };
}

/** Private immutable observation. A negative copied snapshot can deny delivery without inventing a native readback. */
function isArchivedArtifactEvidence(value: ArchivedArtifactDisclosureEvidence | undefined): value is ArchivedArtifactDisclosureEvidence {
  return Boolean(value?.version === 1 && [value.producerId, value.taskId, value.requestId].every(id => typeof id === 'string' && Boolean(id))
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && Array.isArray(value.privateIds) && value.privateIds.every(id => typeof id === 'string' && Boolean(id))
    && Array.isArray(value.literalIds) && value.literalIds.every(id => value.privateIds.includes(id)));
}

/** Empty identifiers without an independent native readback do not prove complete safety. */
export function isObservedArchivedArtifactEvidence(value: ArchivedArtifactDisclosureEvidence | undefined): value is ArchivedArtifactDisclosureEvidence {
  return isArchivedArtifactEvidence(value) && (typeof value.readbackId === 'string' && Boolean(value.readbackId)
    || privateExecutionReferences(value.privateIds.join('\n'), value.privateIds, value.literalIds).length > 0);
}
export function isCompleteArchivedArtifactEvidence(value: ArchivedArtifactDisclosureEvidence | undefined): value is ArchivedArtifactDisclosureEvidence & { readbackId: string } {
  return isArchivedArtifactEvidence(value) && typeof value.readbackId === 'string' && Boolean(value.readbackId);
}
