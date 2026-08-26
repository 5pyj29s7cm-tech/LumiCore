import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { io as createSocketClient } from 'socket.io-client';
import { bootstrapDesktopTestSession } from './lib/desktop-bootstrap.mjs';

const INTERNAL_BLOCK_RE = /(?:No (?:successful|verified) current[- ]turn tool execution|这一轮没有记录到成功的真实工具执行|我还不能说正在执行|我需要先真正调用对应工具)/iu;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TERMINAL_BACKGROUND_STATUSES = new Set(['completed', 'blocked', 'failed', 'cancelled']);
const CONFIRMATION_TEXT_RE = /^(?:确认|确定|同意|继续执行|yes|confirm|confirmed|proceed)[。.!！\s]*$/iu;

export class E2EError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E2EError';
    this.code = code;
  }
}

export function isLoopbackBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function containsInternalExecutionBlock(value) {
  return INTERNAL_BLOCK_RE.test(String(value || ''));
}

export function parseWorkerReceiptCount(feedback) {
  const evidence = Array.isArray(feedback?.evidence) ? feedback.evidence : [];
  for (const item of evidence) {
    const match = String(item || '').match(/Worker receipts:\s*(\d+)/i);
    if (match) return Math.max(0, Number.parseInt(match[1], 10) || 0);
  }
  return 0;
}

export function evidenceTextHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parseToolCalls(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageTransport(message) {
  return String(message?.channel || message?.source || message?.mode || '').trim().toLowerCase();
}

export function findRuntimeTaskByMarker(runtime, marker) {
  return (Array.isArray(runtime?.tasks) ? runtime.tasks : []).find(task => (
    String(task?.goal || '').includes(String(marker || ''))
  )) || null;
}

export function runtimeReceiptSignature(task) {
  return (Array.isArray(task?.evidence?.latest) ? task.evidence.latest : [])
    .map(receipt => [
      String(receipt?.receiptId || ''),
      String(receipt?.requestId || ''),
      String(receipt?.toolName || ''),
      String(receipt?.outcome || ''),
      String(receipt?.verification || ''),
    ].join(':'))
    .sort()
    .join('|');
}

export function buildLifecycleTurnEvidence({ messages, requestId, runtimeTask }) {
  const records = Array.isArray(messages) ? messages : [];
  const user = records.find(message => message?.role === 'user' && message?.requestId === requestId);
  const assistant = records.find(message => message?.role === 'assistant' && message?.requestId === requestId);
  const reply = messageText(assistant);
  const receipts = (Array.isArray(runtimeTask?.evidence?.latest) ? runtimeTask.evidence.latest : [])
    .filter(receipt => receipt?.requestId === requestId);
  return {
    requestId: String(requestId || ''),
    taskId: String(runtimeTask?.taskId || ''),
    taskRevision: Math.max(0, Number(runtimeTask?.revision) || 0),
    taskStatus: String(runtimeTask?.status || ''),
    userMessageId: String(user?.id || ''),
    assistantMessageId: String(assistant?.id || ''),
    receiptIds: receipts.map(receipt => String(receipt?.receiptId || '')).filter(Boolean),
    receiptTools: receipts.map(receipt => String(receipt?.toolName || '')).filter(Boolean),
    receiptLedger: {
      signature: runtimeReceiptSignature(runtimeTask),
      total: Math.max(0, Number(runtimeTask?.evidence?.total)
        || (Array.isArray(runtimeTask?.evidence?.latest) ? runtimeTask.evidence.latest.length : 0)),
    },
    userFacingReply: {
      persisted: Boolean(assistant && reply),
      sha256: evidenceTextHash(reply),
      characterCount: reply.length,
      internalGuardLeaked: containsInternalExecutionBlock(reply),
    },
  };
}

export function validateCorrectionLifecycleEvidence(items) {
  const evidence = Array.isArray(items) ? items : [];
  if (evidence.length !== 4) return { ok: false, code: 'task_correction_evidence_count_invalid' };
  const taskIds = new Set(evidence.map(item => String(item?.taskId || '')).filter(Boolean));
  if (taskIds.size !== 1) return { ok: false, code: 'task_correction_identity_changed' };
  if (evidence.some(item => !item?.requestId || !item?.userMessageId || !item?.assistantMessageId)) {
    return { ok: false, code: 'task_correction_transcript_evidence_missing' };
  }
  if (evidence.some(item => !item?.userFacingReply?.persisted || item?.userFacingReply?.internalGuardLeaked)) {
    return { ok: false, code: 'task_correction_reply_evidence_invalid' };
  }
  for (let index = 1; index < evidence.length; index += 1) {
    if (Number(evidence[index]?.taskRevision) <= Number(evidence[index - 1]?.taskRevision)) {
      return { ok: false, code: 'task_correction_revision_not_advanced' };
    }
  }
  return { ok: true, code: '', taskId: [...taskIds][0], corrections: 3 };
}

export function validateStatusQueryNoReplay({ beforeTask, afterTask, turnEvidence, toolEventCount }) {
  if (!beforeTask?.taskId || beforeTask.taskId !== afterTask?.taskId) {
    return { ok: false, code: 'status_query_task_identity_changed' };
  }
  if (runtimeReceiptSignature(beforeTask) !== runtimeReceiptSignature(afterTask)) {
    return { ok: false, code: 'status_query_replayed_receipt' };
  }
  if (Number(toolEventCount) !== 0 || (turnEvidence?.receiptIds || []).length !== 0) {
    return { ok: false, code: 'status_query_executed_tool' };
  }
  if (!turnEvidence?.userFacingReply?.persisted || turnEvidence?.userFacingReply?.internalGuardLeaked) {
    return { ok: false, code: 'status_query_reply_evidence_invalid' };
  }
  return { ok: true, code: '' };
}

export function validateCancellationLeaseRelease({ beforeTask, afterTask, turnEvidence }) {
  if (!beforeTask?.taskId || beforeTask.taskId !== afterTask?.taskId) {
    return { ok: false, code: 'task_cancel_identity_changed' };
  }
  if (afterTask?.status !== 'cancelled') return { ok: false, code: 'task_cancel_not_terminal' };
  if (afterTask?.activeRequest !== false) return { ok: false, code: 'task_cancel_lease_not_released' };
  if (!turnEvidence?.userFacingReply?.persisted || turnEvidence?.userFacingReply?.internalGuardLeaked) {
    return { ok: false, code: 'task_cancel_reply_evidence_invalid' };
  }
  return { ok: true, code: '' };
}

export function validateManualVoiceConfirmationEvidence({
  messages,
  task,
  taskId,
  toolName,
  expectedPath,
  since,
}) {
  const sinceMs = new Date(since || 0).getTime();
  const records = (Array.isArray(messages) ? messages : []).filter(message => {
    const timestamp = new Date(message?.timestamp || 0).getTime();
    return !Number.isFinite(sinceMs) || timestamp >= sinceMs;
  });
  const voiceUser = records.find(message => (
    message?.role === 'user'
    && /voice/.test(messageTransport(message))
    && CONFIRMATION_TEXT_RE.test(messageText(message))
  ));
  const voiceAssistant = records.find(message => (
    message?.role === 'assistant'
    && /voice/.test(messageTransport(message))
    && parseToolCalls(message?.toolCalls).some(call => (
      call?.name === toolName
      && String(call?.taskId || '') === String(taskId || '')
      && !call?.error
      && call?.terminalVerification?.status === 'verified'
      && String(call?.arguments?.path || call?.arguments?.filePath || '') === String(expectedPath || '')
    ))
  ));
  const receipt = (Array.isArray(task?.evidence?.latest) ? task.evidence.latest : []).find(item => (
    item?.taskId === taskId
    && item?.toolName === toolName
    && item?.verification === 'verified'
    && voiceAssistant?.requestId
    && item?.requestId === voiceAssistant.requestId
  ));
  if (!voiceUser) return { ok: false, code: 'manual_voice_confirmation_user_evidence_missing' };
  if (!voiceAssistant) return { ok: false, code: 'manual_voice_confirmation_assistant_evidence_missing' };
  if (!receipt) return { ok: false, code: 'manual_voice_confirmation_receipt_missing' };
  if (!['completed', 'verifying'].includes(String(task?.status || '')) || task?.activeRequest !== false) {
    return { ok: false, code: 'manual_voice_confirmation_task_not_settled' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      taskId,
      voiceUserMessageId: String(voiceUser.id || ''),
      voiceAssistantMessageId: String(voiceAssistant.id || ''),
      requestId: String(voiceAssistant.requestId || ''),
      receiptId: String(receipt.receiptId || ''),
      userFacingReplyHash: evidenceTextHash(messageText(voiceAssistant)),
    },
  };
}

export function validatePersistedConversationScope({ conversationId, activated, active }) {
  const expected = String(conversationId || '');
  const activatedId = String(activated?.conversation?.id || '');
  const activeId = String(active?.activeConversation?.id || '');
  if (!expected || activatedId !== expected || activeId !== expected) {
    return { ok: false, code: 'manual_voice_conversation_scope_not_active' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      domain: 'personal',
      conversationId: expected,
      activatedConversationId: activatedId,
      activeApiConversationId: activeId,
    },
  };
}

export function validateRoutingTrace(value, { allowProviderProbe = false } = {}) {
  if (!value || value.ok !== true) return { ok: false, fallbackObserved: false, attemptCount: 0 };
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  if (attempts.length === 0) {
    return {
      ok: allowProviderProbe && (
        String(value.verification || '').startsWith('live_')
        || (
          Boolean(String(value.provider || '').trim())
          && Boolean(String(value.model || '').trim())
          && Number.isFinite(Number(value.latencyMs))
        )
      ),
      fallbackObserved: false,
      attemptCount: 0,
    };
  }
  const validStatuses = new Set(['succeeded', 'failed', 'skipped']);
  if (attempts.some(attempt => !validStatuses.has(String(attempt?.status || '')))) {
    return { ok: false, fallbackObserved: false, attemptCount: attempts.length };
  }
  const selectedIndex = attempts.findIndex(attempt => (
    attempt?.status === 'succeeded'
    && String(attempt.provider || '') === String(value.selectedProvider || value.provider || '')
    && String(attempt.model || '') === String(value.selectedModel || value.model || '')
  ));
  const succeeded = selectedIndex >= 0;
  const fallbackObserved = succeeded && (
    selectedIndex > 0
    || attempts.slice(0, selectedIndex).some(attempt => ['failed', 'skipped'].includes(attempt.status))
  );
  const fallbackConsistent = !fallbackObserved || Boolean(String(value.fallbackReason || '').trim());
  return { ok: succeeded && fallbackConsistent, fallbackObserved, attemptCount: attempts.length };
}

export function isVerifiedForcedFailoverProbe(value) {
  const trace = validateRoutingTrace(value);
  const attempts = Array.isArray(value?.attempts) ? value.attempts : [];
  const first = attempts[0];
  return Boolean(
    value?.verification === 'live_forced_primary_failure_failover'
    && trace.ok
    && trace.fallbackObserved
    && first?.provider === '__lumi_forced_unavailable_primary__'
    && first?.status === 'failed'
    && first?.reason === 'unsupported_provider_or_model'
    && value?.fallbackReason === 'unsupported_provider_or_model'
    && attempts.some(attempt => (
      attempt?.status === 'succeeded'
      && attempt?.provider !== '__lumi_forced_unavailable_primary__'
    ))
  );
}

function usage() {
  return [
    'Formal Lumi native-client E2E (safe, local-only).',
    '',
    'Usage:',
    '  node scripts/formal-client-e2e.mjs --confirm-live-e2e --data-root <absolute-path> [options]',
    '',
    'Options:',
    '  --base-url <url>              API base; default http://127.0.0.1:3000/api',
    '  --expected-build-id <sha>     Exact runtime build; default current git HEAD',
    '  --timeout-ms <ms>             Foreground turn timeout; default 180000',
    '  --background-timeout-ms <ms>  Background terminal timeout; default 600000',
    '  --manual-gate-timeout-ms <ms>  Human microphone gate timeout; default 300000',
    '  --skip-desktop                Skip native desktop observation',
    '  --skip-multi-agent            Skip durable multi-Agent acceptance',
    '  --manual-voice-confirmation   Wait for a human to say the confirmation in the real client',
    '  --keep-conversation           Keep the E2E-owned conversation',
    '  --help                        Show this help without touching the runtime',
    '',
    'The script refuses non-loopback URLs. It never emits synthetic voice/STT events.',
    'Without --manual-voice-confirmation, microphone/cross-channel voice remains an explicit manual gate.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1:3000/api',
    timeoutMs: 180_000,
    backgroundTimeoutMs: 600_000,
    manualGateTimeoutMs: 300_000,
    skipDesktop: false,
    skipMultiAgent: false,
    keepConversation: false,
    manualVoiceConfirmation: false,
    confirmed: false,
    help: false,
    dataRoot: '',
    expectedBuildId: '',
  };
  const valueFlags = new Set(['--base-url', '--data-root', '--expected-build-id', '--timeout-ms', '--background-timeout-ms', '--manual-gate-timeout-ms']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new E2EError('invalid_arguments');
      index += 1;
      if (flag === '--base-url') args.baseUrl = value;
      if (flag === '--data-root') args.dataRoot = value;
      if (flag === '--expected-build-id') args.expectedBuildId = value;
      if (flag === '--timeout-ms') args.timeoutMs = Number.parseInt(value, 10);
      if (flag === '--background-timeout-ms') args.backgroundTimeoutMs = Number.parseInt(value, 10);
      if (flag === '--manual-gate-timeout-ms') args.manualGateTimeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (flag === '--confirm-live-e2e') args.confirmed = true;
    else if (flag === '--skip-desktop') args.skipDesktop = true;
    else if (flag === '--skip-multi-agent') args.skipMultiAgent = true;
    else if (flag === '--manual-voice-confirmation') args.manualVoiceConfirmation = true;
    else if (flag === '--keep-conversation') args.keepConversation = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new E2EError('invalid_arguments');
  }
  if (args.help) return args;
  if (!args.confirmed) throw new E2EError('live_confirmation_required');
  if (!args.dataRoot || !path.isAbsolute(args.dataRoot)) throw new E2EError('absolute_data_root_required');
  if (!isLoopbackBaseUrl(args.baseUrl)) throw new E2EError('loopback_api_required');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000 || args.timeoutMs > 900_000) throw new E2EError('invalid_timeout');
  if (!Number.isFinite(args.backgroundTimeoutMs) || args.backgroundTimeoutMs < 30_000 || args.backgroundTimeoutMs > 1_800_000) throw new E2EError('invalid_background_timeout');
  if (!Number.isFinite(args.manualGateTimeoutMs) || args.manualGateTimeoutMs < 30_000 || args.manualGateTimeoutMs > 1_800_000) throw new E2EError('invalid_manual_gate_timeout');
  args.baseUrl = String(args.baseUrl).replace(/\/$/, '');
  return args;
}

export function currentGitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function apiUrl(baseUrl, pathname, query = {}) {
  const url = new URL(`${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

export async function fetchJson(baseUrl, pathname, { token = '', method = 'GET', body, timeoutMs = 30_000, query } = {}) {
  let response;
  try {
    response = await fetch(apiUrl(baseUrl, pathname, query), {
      method,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new E2EError('local_api_unreachable');
  }
  let parsed = {};
  try { parsed = await response.json(); } catch {}
  if (!response.ok) throw new E2EError(`local_api_http_${response.status}`);
  return parsed;
}

export function waitForSocketReady(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let boundary = null;
    const timer = setTimeout(() => finish(new E2EError('socket_ready_timeout')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      socket.off('runtime:execution_boundary', onBoundary);
    };
    const finish = error => {
      cleanup();
      if (error) reject(error);
      else resolve(boundary);
    };
    const maybeFinish = () => {
      if (connected && boundary) finish();
    };
    const onConnect = () => { connected = true; maybeFinish(); };
    const onError = () => finish(new E2EError('socket_auth_failed'));
    const onBoundary = payload => { boundary = payload; maybeFinish(); };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
    socket.on('runtime:execution_boundary', onBoundary);
    socket.connect();
  });
}

function emitChatAck(socket, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    socket.timeout(Math.min(timeoutMs, 30_000)).emit('agent:chat', payload, (error, ack) => {
      if (error || ack?.ok !== true || ack?.requestId !== payload.requestId) {
        reject(new E2EError('chat_ack_failed'));
        return;
      }
      resolve(ack);
    });
  });
}

export async function runTurn(socket, input) {
  const toolEvents = [];
  const delegations = [];
  let settled = false;
  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new E2EError('chat_terminal_timeout')), input.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('agent:response', onResponse);
      socket.off('agent:error', onError);
      socket.off('agent:tool_call', onTool);
      socket.off('agent:tool', onTool);
      socket.off('agent:delegation', onDelegation);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const matches = payload => payload?.requestId === input.requestId;
    const onTool = payload => {
      if (!matches(payload)) return;
      toolEvents.push({
        name: String(payload?.name || payload?.toolName || ''),
        hasResult: Boolean(String(payload?.result || '').trim()),
        hasError: Boolean(payload?.error),
      });
    };
    const onDelegation = payload => {
      if (!matches(payload)) return;
      delegations.push({
        taskId: String(payload?.taskId || payload?.task?.id || ''),
        workerCount: Array.isArray(payload?.workers) ? payload.workers.length : 0,
      });
    };
    const onError = payload => {
      if (matches(payload)) finish(new E2EError('chat_agent_error'));
    };
    const onResponse = payload => {
      if (matches(payload) && payload?.finalized === true) finish(null, payload);
    };
    socket.on('agent:response', onResponse);
    socket.on('agent:error', onError);
    socket.on('agent:tool_call', onTool);
    socket.on('agent:tool', onTool);
    socket.on('agent:delegation', onDelegation);
  });
  const ackPromise = emitChatAck(socket, {
    text: input.text,
    history: [],
    agentId: 'lumi',
    personalityId: 'lumi',
    domain: 'personal',
    source: 'e2e-formal-client',
    requestId: input.requestId,
    conversationId: input.conversationId,
  }, input.timeoutMs);
  try {
    const [response] = await Promise.all([responsePromise, ackPromise]);
    return { response, toolEvents, delegations };
  } catch (error) {
    if (!settled) settled = true;
    throw error;
  }
}

function messageText(message) {
  return String(message?.message || message?.content || message?.response || '');
}

function findAssistant(messages, requestId) {
  return (Array.isArray(messages) ? messages : []).find(message => (
    message?.role === 'assistant' && message?.requestId === requestId
  ));
}

export async function persistedMessages(baseUrl, token, conversationId) {
  const body = await fetchJson(baseUrl, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
    token,
    query: { domain: 'personal', limit: 200 },
  });
  return Array.isArray(body?.messages) ? body.messages : [];
}

export function isPathInside(basePath, candidatePath) {
  const base = path.resolve(String(basePath || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(base, candidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function buildOwnedArtifactLayout(dataRoot, runMarker) {
  const rawBase = String(dataRoot || '').trim();
  const marker = String(runMarker || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  if (!rawBase || !path.isAbsolute(rawBase) || !marker) throw new E2EError('e2e_artifact_root_invalid');
  const base = path.resolve(rawBase);
  const parent = path.resolve(base, 'formal-client-e2e-artifacts');
  const root = path.resolve(parent, marker);
  if (!isPathInside(base, parent) || !isPathInside(parent, root)) {
    throw new E2EError('e2e_artifact_scope_invalid');
  }
  const files = [
    'target-0.txt',
    'target-1.txt',
    'target-2.txt',
    'target-final.txt',
    'manual-voice-confirmation.txt',
  ].map(name => path.resolve(root, name));
  if (files.some(file => !isPathInside(root, file))) throw new E2EError('e2e_artifact_scope_invalid');
  return { base, parent, root, files };
}

export function cleanOwnedArtifactLayout(layout) {
  const failed = [];
  for (const file of layout?.files || []) {
    try {
      if (!isPathInside(layout.root, file)) throw new Error('outside-owned-root');
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      failed.push(file);
    }
  }
  for (const directory of [layout?.root, layout?.parent]) {
    if (!directory) continue;
    try {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      failed.push(directory);
    }
  }
  return { ok: failed.length === 0, failedCount: failed.length };
}

export async function runtimeStatus(baseUrl, token) {
  return fetchJson(baseUrl, '/runtime/status', { token, query: { domain: 'personal' } });
}

export async function pollRuntimeTaskByMarker(baseUrl, token, marker, timeoutMs, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const runtime = await runtimeStatus(baseUrl, token);
    latest = findRuntimeTaskByMarker(runtime, marker);
    if (latest && predicate(latest)) return { runtime, task: latest };
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new E2EError(latest ? 'task_lifecycle_state_timeout' : 'task_lifecycle_not_persisted');
}

async function captureLifecycleTurn(baseUrl, token, conversationId, marker, requestId, timeoutMs) {
  const [{ task }, messages] = await Promise.all([
    pollRuntimeTaskByMarker(baseUrl, token, marker, timeoutMs),
    persistedMessages(baseUrl, token, conversationId),
  ]);
  const evidence = buildLifecycleTurnEvidence({ messages, requestId, runtimeTask: task });
  requireCondition(evidence.userMessageId, 'task_lifecycle_user_message_missing');
  requireCondition(evidence.assistantMessageId, 'task_lifecycle_assistant_message_missing');
  requireCondition(evidence.userFacingReply.persisted, 'task_lifecycle_reply_missing');
  requireCondition(!evidence.userFacingReply.internalGuardLeaked, 'task_lifecycle_internal_guard_leaked');
  return { task, evidence };
}

async function routingReceiptCheck(baseUrl, token, requestId) {
  const body = await fetchJson(baseUrl, '/preferences/llm/routing-receipts', {
    token,
    query: { requestId, limit: 20 },
  });
  const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
  const succeeded = receipts.filter(receipt => receipt?.status === 'succeeded');
  const checks = succeeded.map(receipt => validateRoutingTrace({ ...receipt, ok: true }));
  if (checks.length === 0 || checks.some(check => !check.ok)) throw new E2EError('routing_receipt_invalid');
  return {
    receiptCount: succeeded.length,
    fallbackObserved: checks.some(check => check.fallbackObserved),
  };
}

async function pollBackground(baseUrl, token, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fetchJson(baseUrl, '/autonomy/background-tasks', {
      token,
      query: { domain: 'personal', limit: 200 },
    });
    const task = (Array.isArray(body?.tasks) ? body.tasks : []).find(candidate => candidate?.id === taskId);
    if (task && TERMINAL_BACKGROUND_STATUSES.has(String(task.status || ''))) return task;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new E2EError('background_terminal_timeout');
}

export function requireCondition(condition, code) {
  if (!condition) throw new E2EError(code);
}

async function runTaskLifecycleAcceptance({
  baseUrl,
  token,
  socket,
  conversationId,
  runMarker,
  requestId,
  timeoutMs,
  artifactLayout,
}) {
  const content = `${runMarker}:task-lifecycle-confirmation-gate`;
  const turns = [
    {
      phase: 'task-create',
      text: `[${runMarker}] 创建一个仅用于正式 E2E 的确认门控文件 ${artifactLayout.files[0]}，内容严格写成 ${content}。必须调用 write_file，但不要代替用户确认；到确认边界立即停止。`,
    },
    {
      phase: 'task-correction-1',
      text: `不是 ${artifactLayout.files[0]}，把同一个任务的目标改成 ${artifactLayout.files[1]}，内容保持不变；不要沿用或重试旧目标。`,
    },
    {
      phase: 'task-correction-2',
      text: `再纠正一次：不要 ${artifactLayout.files[1]}，改成 ${artifactLayout.files[2]}，仍是同一个任务且内容不变。`,
    },
    {
      phase: 'task-correction-3',
      text: `最后一次纠正：拒绝 ${artifactLayout.files[2]}，最终目标是 ${artifactLayout.files[3]}，内容不变；等待我的确认。`,
    },
  ];
  const correctionEvidence = [];
  let taskId = '';
  for (const turn of turns) {
    const id = requestId(turn.phase);
    await runTurn(socket, {
      requestId: id,
      conversationId,
      timeoutMs,
      text: turn.text,
    });
    const captured = await captureLifecycleTurn(baseUrl, token, conversationId, runMarker, id, timeoutMs);
    requireCondition(captured.task.status === 'waiting_confirmation', `${turn.phase}_not_waiting_confirmation`);
    requireCondition(captured.task.activeRequest === false, `${turn.phase}_lease_not_yielded`);
    requireCondition(captured.evidence.receiptIds.length > 0, `${turn.phase}_receipt_missing`);
    if (taskId) requireCondition(captured.task.taskId === taskId, 'task_correction_identity_changed');
    taskId = captured.task.taskId;
    correctionEvidence.push(captured.evidence);
  }
  const correctionValidation = validateCorrectionLifecycleEvidence(correctionEvidence);
  requireCondition(correctionValidation.ok, correctionValidation.code);
  requireCondition(artifactLayout.files.every(file => !fs.existsSync(file)), 'unconfirmed_artifact_created');

  const beforeStatus = (await pollRuntimeTaskByMarker(baseUrl, token, runMarker, timeoutMs)).task;
  const statusId = requestId('task-status');
  const statusTurn = await runTurn(socket, {
    requestId: statusId,
    conversationId,
    timeoutMs,
    text: '这个任务完成了吗？只报告当前持久状态，不要执行、确认或重放任何动作。',
  });
  const statusCaptured = await captureLifecycleTurn(baseUrl, token, conversationId, runMarker, statusId, timeoutMs);
  const statusValidation = validateStatusQueryNoReplay({
    beforeTask: beforeStatus,
    afterTask: statusCaptured.task,
    turnEvidence: statusCaptured.evidence,
    toolEventCount: statusTurn.toolEvents.length,
  });
  requireCondition(statusValidation.ok, statusValidation.code);
  requireCondition(artifactLayout.files.every(file => !fs.existsSync(file)), 'status_query_created_artifact');

  const cancelId = requestId('task-cancel');
  await runTurn(socket, {
    requestId: cancelId,
    conversationId,
    timeoutMs,
    text: '取消这个任务。',
  });
  const cancelled = await pollRuntimeTaskByMarker(
    baseUrl,
    token,
    runMarker,
    timeoutMs,
    task => task.status === 'cancelled' && task.activeRequest === false,
  );
  const cancelMessages = await persistedMessages(baseUrl, token, conversationId);
  const cancelEvidence = buildLifecycleTurnEvidence({
    messages: cancelMessages,
    requestId: cancelId,
    runtimeTask: cancelled.task,
  });
  const cancelValidation = validateCancellationLeaseRelease({
    beforeTask: statusCaptured.task,
    afterTask: cancelled.task,
    turnEvidence: cancelEvidence,
  });
  requireCondition(cancelValidation.ok, cancelValidation.code);
  requireCondition(artifactLayout.files.every(file => !fs.existsSync(file)), 'cancelled_task_created_artifact');

  return {
    passed: true,
    taskId,
    correctionCount: 3,
    turns: correctionEvidence,
    statusQuery: {
      ...statusCaptured.evidence,
      receiptSignatureBefore: runtimeReceiptSignature(beforeStatus),
      receiptSignatureAfter: runtimeReceiptSignature(statusCaptured.task),
    },
    cancellation: {
      ...cancelEvidence,
      receiptSignatureBefore: runtimeReceiptSignature(statusCaptured.task),
      receiptSignatureAfter: runtimeReceiptSignature(cancelled.task),
    },
    finalStatus: cancelled.task.status,
    activeLease: cancelled.task.activeRequest,
    artifactContentSha256: evidenceTextHash(content),
  };
}

async function runManualVoiceConfirmationGate({
  baseUrl,
  token,
  socket,
  conversationId,
  runMarker,
  requestId,
  timeoutMs,
  manualGateTimeoutMs,
  artifactLayout,
}) {
  const marker = `${runMarker}-VOICE-GATE`;
  const targetPath = artifactLayout.files[4];
  const content = `${marker}:human-microphone-confirmation`;
  const pendingRequestId = requestId('manual-voice-pending');
  await runTurn(socket, {
    requestId: pendingRequestId,
    conversationId,
    timeoutMs,
    text: `[${marker}] 创建确认门控文件 ${targetPath}，内容严格写成 ${content}。必须调用 write_file 并等待确认，不得自行确认。`,
  });
  const pending = await captureLifecycleTurn(
    baseUrl,
    token,
    conversationId,
    marker,
    pendingRequestId,
    timeoutMs,
  );
  requireCondition(pending.task.status === 'waiting_confirmation', 'manual_voice_pending_not_persisted');
  requireCondition(pending.task.activeRequest === false, 'manual_voice_pending_lease_not_yielded');
  requireCondition(pending.evidence.receiptIds.length > 0, 'manual_voice_pending_receipt_missing');
  requireCondition(!fs.existsSync(targetPath), 'manual_voice_artifact_created_before_confirmation');

  const activated = await fetchJson(
    baseUrl,
    `/conversations/${encodeURIComponent(conversationId)}/activate`,
    {
      token,
      method: 'POST',
      body: { agentId: 'lumi' },
      query: { domain: 'personal' },
    },
  );
  const active = await fetchJson(baseUrl, '/conversations/active', {
    token,
    query: { domain: 'personal', agentId: 'lumi' },
  });
  const scopeValidation = validatePersistedConversationScope({ conversationId, activated, active });
  requireCondition(scopeValidation.ok, scopeValidation.code);

  const since = new Date().toISOString();
  process.stderr.write([
    '',
    'MANUAL GATE REQUIRED — no synthetic voice/STT event will be emitted.',
    'In the real Lumi client, use the physical microphone and say “确认” once.',
    `The script will wait up to ${manualGateTimeoutMs} ms for persisted voice-channel evidence.`,
    '',
  ].join('\n'));

  const deadline = Date.now() + manualGateTimeoutMs;
  let lastCode = 'manual_voice_confirmation_timeout';
  while (Date.now() < deadline) {
    const [messages, runtime] = await Promise.all([
      persistedMessages(baseUrl, token, conversationId),
      runtimeStatus(baseUrl, token),
    ]);
    const task = findRuntimeTaskByMarker(runtime, marker);
    const validation = validateManualVoiceConfirmationEvidence({
      messages,
      task,
      taskId: pending.task.taskId,
      toolName: 'write_file',
      expectedPath: targetPath,
      since,
    });
    if (validation.ok) {
      requireCondition(fs.existsSync(targetPath), 'manual_voice_artifact_missing');
      const actual = fs.readFileSync(targetPath, 'utf8');
      requireCondition(actual === content, 'manual_voice_artifact_content_mismatch');
      return {
        passed: true,
        humanMicrophoneRequired: true,
        syntheticSttEmitted: false,
        pending: pending.evidence,
        confirmation: validation.evidence,
        persistedScope: scopeValidation.evidence,
        artifactContentSha256: evidenceTextHash(actual),
      };
    }
    lastCode = validation.code;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new E2EError(lastCode || 'manual_voice_confirmation_timeout');
}

async function runFormalE2E(args) {
  const expectedBuildId = args.expectedBuildId || process.env.LUMI_EXPECT_BUILD_ID || currentGitHead();
  requireCondition(/^[a-f0-9]{7,64}$/i.test(expectedBuildId), 'expected_build_id_required');
  const runMarker = `LUMI-E2E-${crypto.randomBytes(8).toString('hex')}`;
  const requestId = phase => `e2e-${runMarker.toLowerCase()}-${phase}`;
  const artifactLayout = buildOwnedArtifactLayout(args.dataRoot, runMarker);
  const summary = {
    ok: false,
    fullAcceptance: false,
    runtime: { healthy: false, buildMatches: false, sourceClean: false },
    socket: { trustedLocal: false, registeredByHarness: false },
    checks: {},
    manualGates: {
      microphoneVoiceConfirmation: {
        required: true,
        status: args.manualVoiceConfirmation ? 'pending' : 'not_run',
        syntheticSttEmitted: false,
        claimedVoiceTurns: 0,
      },
    },
    cleanup: {
      conversationDeleted: false,
      backgroundAuditRetained: false,
      ownedArtifactFilesRemoved: false,
      ownedArtifactCleanupFailedCount: 0,
    },
  };
  let token = '';
  let desktopSessionProof = '';
  let conversationId = '';
  let socket = null;
  let backgroundCreated = false;
  try {
    const bootstrap = await bootstrapDesktopTestSession(args.baseUrl, args.dataRoot, { timeoutMs: 15_000 });
    token = String(bootstrap?.token || '');
    desktopSessionProof = String(bootstrap?.desktopSessionProof || '');
    requireCondition(token && desktopSessionProof, 'desktop_bootstrap_invalid');

    const health = await fetchJson(args.baseUrl, '/health', { token, query: { details: 1 } });
    summary.runtime.healthy = health?.status === 'ok' && health?.database?.persistence?.degraded !== true;
    summary.runtime.buildMatches = String(health?.runtime?.buildId || '') === expectedBuildId;
    summary.runtime.sourceClean = health?.runtime?.sourceDirty === false;
    requireCondition(summary.runtime.healthy, 'runtime_health_failed');
    requireCondition(summary.runtime.buildMatches, 'runtime_build_mismatch');
    requireCondition(summary.runtime.sourceClean, 'runtime_source_dirty');

    socket = createSocketClient(new URL(args.baseUrl).origin, {
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      transports: ['websocket'],
      auth: { token, desktopSessionProof },
    });
    const boundary = await waitForSocketReady(socket, 15_000);
    summary.socket.trustedLocal = boundary?.trustedLocalExecution === true;
    requireCondition(summary.socket.trustedLocal, 'trusted_local_boundary_required');

    if (!args.skipDesktop) {
      const devices = await fetchJson(args.baseUrl, '/devices', { token });
      const nativeReady = (Array.isArray(devices?.devices) ? devices.devices : []).some(device => (
        device?.type === 'desktop' && device?.status === 'online' && Boolean(device?.socketId)
      ));
      requireCondition(nativeReady, 'native_desktop_not_connected');
    }

    const created = await fetchJson(args.baseUrl, '/conversations/new', {
      token,
      method: 'POST',
      body: { agentId: 'lumi', domain: 'personal' },
      query: { domain: 'personal' },
    });
    conversationId = String(created?.conversation?.id || '');
    requireCondition(conversationId, 'conversation_create_failed');

    const cupCode = `cup-${crypto.randomBytes(5).toString('hex')}`;
    const firstId = requestId('natural');
    const first = await runTurn(socket, {
      requestId: firstId,
      conversationId,
      timeoutMs: args.timeoutMs,
      text: `[${runMarker}] 这是虚构的上下文验收，不需要任何工具。请记住杯子代号 ${cupCode}，只简短确认已经记住。`,
    });
    requireCondition(first.toolEvents.length === 0, 'natural_chat_used_tool');
    requireCondition(!first.response?.blocked && !containsInternalExecutionBlock(first.response?.text), 'natural_chat_internal_block');
    requireCondition(first.response?.completionFeedback === undefined, 'natural_chat_fake_task_feedback');
    let messages = await persistedMessages(args.baseUrl, token, conversationId);
    const firstPersisted = findAssistant(messages, firstId);
    requireCondition(firstPersisted && !containsInternalExecutionBlock(messageText(firstPersisted)), 'natural_chat_not_persisted');
    requireCondition(firstPersisted?.completionFeedback === undefined, 'natural_chat_feedback_persisted');
    const firstRouting = await routingReceiptCheck(args.baseUrl, token, firstId);
    summary.checks.naturalChat = { passed: true, toolEvents: 0, feedbackAbsent: true };

    const secondId = requestId('context');
    const second = await runTurn(socket, {
      requestId: secondId,
      conversationId,
      timeoutMs: args.timeoutMs,
      text: '继续保持不调用工具。刚才杯子的代号是什么？只回复代号。',
    });
    requireCondition(!second.response?.blocked && !containsInternalExecutionBlock(second.response?.text), 'context_turn_internal_block');
    requireCondition(String(second.response?.text || '').includes(cupCode), 'history_empty_context_lost');
    messages = await persistedMessages(args.baseUrl, token, conversationId);
    const secondPersisted = findAssistant(messages, secondId);
    requireCondition(secondPersisted && messageText(secondPersisted).includes(cupCode), 'context_turn_not_persisted');
    const secondRouting = await routingReceiptCheck(args.baseUrl, token, secondId);
    summary.checks.contextContinuity = { passed: true, clientHistoryItems: 0, persisted: true };

    const routeTest = await fetchJson(args.baseUrl, '/llm/route/test', { token, method: 'POST', body: {} });
    const routeProbe = validateRoutingTrace(routeTest, { allowProviderProbe: true });
    requireCondition(routeProbe.ok, 'model_route_probe_invalid');
    const forcedFailover = await fetchJson(args.baseUrl, '/llm/route/test', {
      token,
      method: 'POST',
      body: { probe: 'forced_primary_failure' },
    });
    requireCondition(isVerifiedForcedFailoverProbe(forcedFailover), 'model_forced_failover_not_verified');
    summary.checks.modelRouting = {
      passed: true,
      fallbackConfigured: true,
      fallbackObserved: true,
      forcedPrimaryFailureVerified: true,
      receiptCount: firstRouting.receiptCount + secondRouting.receiptCount,
    };

    summary.checks.taskLifecycle = await runTaskLifecycleAcceptance({
      baseUrl: args.baseUrl,
      token,
      socket,
      conversationId,
      runMarker,
      requestId,
      timeoutMs: args.timeoutMs,
      artifactLayout,
    });

    if (!args.skipDesktop) {
      const desktopId = requestId('desktop');
      const desktop = await runTurn(socket, {
        requestId: desktopId,
        conversationId,
        timeoutMs: args.timeoutMs,
        text: `[${runMarker}] 这是正式客户端只读 E2E 验收。请实际查看当前前台窗口，必须调用 desktop_active_window，然后只说明已完成只读观察；不要点击、输入或修改任何内容。`,
      });
      const desktopEvents = desktop.toolEvents.filter(event => event.name === 'desktop_active_window');
      requireCondition(desktopEvents.some(event => event.hasResult && !event.hasError), 'desktop_observation_receipt_missing');
      requireCondition(!desktop.response?.blocked && !containsInternalExecutionBlock(desktop.response?.text), 'desktop_observation_blocked');
      messages = await persistedMessages(args.baseUrl, token, conversationId);
      const persisted = findAssistant(messages, desktopId);
      const toolCalls = Array.isArray(persisted?.toolCalls) ? persisted.toolCalls : [];
      const verifiedTool = toolCalls.some(call => (
        call?.name === 'desktop_active_window'
        && !call?.error
        && call?.terminalVerification?.status === 'verified'
      ));
      requireCondition(verifiedTool, 'desktop_terminal_verification_not_persisted');
      requireCondition(persisted?.completionFeedback?.status === 'completed', 'desktop_feedback_not_persisted');
      summary.checks.desktopObservation = { passed: true, verifiedReceipt: true };
    }

    if (!args.skipMultiAgent) {
      const multiId = requestId('multi-agent');
      const multi = await runTurn(socket, {
        requestId: multiId,
        conversationId,
        timeoutMs: args.timeoutMs,
        text: `[${runMarker}] 请把下面完全虚构、只读、禁止文件/网络/桌面工具的文本交给至少两个子 Agent 并行处理：甲说蓝色方块在圆形左边；乙说圆形在蓝色方块右边。一个子 Agent 提炼等价关系，另一个检查是否矛盾，最后合并为三条简短结论。只分析这段文本，不修改任何数据。`,
      });
      const delegation = multi.delegations.find(item => item.taskId);
      requireCondition(delegation?.taskId, 'multi_agent_delegation_missing');
      requireCondition(multi.response?.completionFeedback?.status === 'working', 'multi_agent_working_feedback_missing');
      backgroundCreated = true;
      const task = await pollBackground(args.baseUrl, token, delegation.taskId, args.backgroundTimeoutMs);
      requireCondition(task?.status === 'completed', 'multi_agent_not_completed');
      requireCondition(Array.isArray(task?.workerNames) && task.workerNames.length >= 2, 'multi_agent_assignments_missing');
      const verifiedWorkers = parseWorkerReceiptCount(task?.completionFeedback);
      requireCondition(verifiedWorkers >= 2, 'multi_agent_worker_receipts_missing');
      requireCondition(task?.completionFeedback?.status === 'completed', 'multi_agent_feedback_not_persisted');
      requireCondition((task?.completionFeedback?.evidence || []).some(item => /model-graph arbitration/i.test(String(item))), 'multi_agent_graph_receipt_missing');

      const runtime = await fetchJson(args.baseUrl, '/runtime/status', { token, query: { domain: 'personal' } });
      const accepted = (Array.isArray(runtime?.acceptance?.tasks) ? runtime.acceptance.tasks : []).find(item => (
        item?.runtime === 'background' && item?.taskId === delegation.taskId
      ));
      requireCondition(accepted?.accepted === true, 'multi_agent_acceptance_failed');
      requireCondition(accepted?.terminalReceiptPresent === true && accepted?.terminalVerification === 'verified', 'multi_agent_terminal_receipt_invalid');
      requireCondition(Object.values(accepted?.continuity || {}).every(Boolean), 'multi_agent_continuity_incomplete');
      const actionTask = (Array.isArray(runtime?.tasks) ? runtime.tasks : []).find(item => (
        String(item?.goal || '').includes(runMarker)
      ));
      requireCondition(actionTask && actionTask.activeRequest === false, 'terminal_action_lease_not_released');
      const durable = (Array.isArray(runtime?.durableWork) ? runtime.durableWork : []).find(item => (
        item?.runtime === 'background' && item?.taskId === delegation.taskId
      ));
      requireCondition(durable?.status === 'completed', 'terminal_background_not_persisted');
      summary.checks.multiAgent = {
        passed: true,
        assignedWorkers: task.workerNames.length,
        verifiedWorkerReceipts: verifiedWorkers,
        terminalReceipt: true,
        accepted: true,
      };
      summary.checks.terminalPersistence = {
        passed: true,
        activeLease: false,
        completionFeedback: true,
      };
      summary.cleanup.backgroundAuditRetained = true;
    }

    if (args.manualVoiceConfirmation) {
      summary.manualGates.microphoneVoiceConfirmation = {
        required: true,
        status: 'passed',
        syntheticSttEmitted: false,
        claimedVoiceTurns: 1,
        evidence: await runManualVoiceConfirmationGate({
          baseUrl: args.baseUrl,
          token,
          socket,
          conversationId,
          runMarker,
          requestId,
          timeoutMs: args.timeoutMs,
          manualGateTimeoutMs: args.manualGateTimeoutMs,
          artifactLayout,
        }),
      };
    }

    summary.ok = true;
    summary.fullAcceptance = summary.manualGates.microphoneVoiceConfirmation.status === 'passed';
    return summary;
  } catch (error) {
    if (error && typeof error === 'object') error.e2eSummary = summary;
    throw error;
  } finally {
    try { socket?.disconnect(); } catch {}
    if (conversationId && !args.keepConversation && token) {
      try {
        const deleted = await fetchJson(args.baseUrl, `/conversations/${encodeURIComponent(conversationId)}`, {
          token,
          method: 'DELETE',
          query: { domain: 'personal' },
        });
        summary.cleanup.conversationDeleted = deleted?.success === true;
      } catch {
        summary.cleanup.conversationDeleted = false;
      }
    }
    if (args.keepConversation) summary.cleanup.conversationDeleted = false;
    if (backgroundCreated) summary.cleanup.backgroundAuditRetained = true;
    const artifactCleanup = cleanOwnedArtifactLayout(artifactLayout);
    summary.cleanup.ownedArtifactFilesRemoved = artifactCleanup.ok;
    summary.cleanup.ownedArtifactCleanupFailedCount = artifactCleanup.failedCount;
    if (!artifactCleanup.ok) {
      summary.ok = false;
      summary.fullAcceptance = false;
      summary.failedCheck = 'e2e_artifact_cleanup_failed';
    }
    token = '';
    desktopSessionProof = '';
  }
}

async function main() {
  let summary = { ok: false, failedCheck: 'unknown', cleanup: { conversationDeleted: false, backgroundAuditRetained: false } };
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    summary = await runFormalE2E(args);
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    const retained = error && typeof error === 'object' && error.e2eSummary
      ? error.e2eSummary
      : summary;
    const primaryFailure = error instanceof E2EError ? error.code : 'unexpected_e2e_failure';
    const cleanupFailure = retained.failedCheck === 'e2e_artifact_cleanup_failed';
    summary = {
      ...retained,
      ok: false,
      fullAcceptance: false,
      failedCheck: cleanupFailure ? retained.failedCheck : primaryFailure,
      ...(cleanupFailure ? { primaryFailure } : {}),
      cleanup: retained.cleanup || {
        conversationDeleted: false,
        backgroundAuditRetained: false,
        ownedArtifactFilesRemoved: false,
        ownedArtifactCleanupFailedCount: 0,
      },
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
