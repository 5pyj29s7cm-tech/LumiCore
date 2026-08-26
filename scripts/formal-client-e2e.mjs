#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { io as createSocketClient } from 'socket.io-client';
import { bootstrapDesktopTestSession } from './lib/desktop-bootstrap.mjs';

const INTERNAL_BLOCK_RE = /(?:No (?:successful|verified) current[- ]turn tool execution|这一轮没有记录到成功的真实工具执行|我还不能说正在执行|我需要先真正调用对应工具)/iu;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TERMINAL_BACKGROUND_STATUSES = new Set(['completed', 'blocked', 'failed', 'cancelled']);

class E2EError extends Error {
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
    '  --skip-desktop                Skip native desktop observation',
    '  --skip-multi-agent            Skip durable multi-Agent acceptance',
    '  --keep-conversation           Keep the E2E-owned conversation',
    '  --help                        Show this help without touching the runtime',
    '',
    'The script refuses non-loopback URLs and emits only aggregate pass/fail data.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1:3000/api',
    timeoutMs: 180_000,
    backgroundTimeoutMs: 600_000,
    skipDesktop: false,
    skipMultiAgent: false,
    keepConversation: false,
    confirmed: false,
    help: false,
    dataRoot: '',
    expectedBuildId: '',
  };
  const valueFlags = new Set(['--base-url', '--data-root', '--expected-build-id', '--timeout-ms', '--background-timeout-ms']);
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
      continue;
    }
    if (flag === '--confirm-live-e2e') args.confirmed = true;
    else if (flag === '--skip-desktop') args.skipDesktop = true;
    else if (flag === '--skip-multi-agent') args.skipMultiAgent = true;
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
  args.baseUrl = String(args.baseUrl).replace(/\/$/, '');
  return args;
}

function currentGitHead() {
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

async function fetchJson(baseUrl, pathname, { token = '', method = 'GET', body, timeoutMs = 30_000, query } = {}) {
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

function waitForSocketReady(socket, timeoutMs) {
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

async function runTurn(socket, input) {
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

async function persistedMessages(baseUrl, token, conversationId) {
  const body = await fetchJson(baseUrl, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
    token,
    query: { domain: 'personal', limit: 200 },
  });
  return Array.isArray(body?.messages) ? body.messages : [];
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

function requireCondition(condition, code) {
  if (!condition) throw new E2EError(code);
}

async function runFormalE2E(args) {
  const expectedBuildId = args.expectedBuildId || process.env.LUMI_EXPECT_BUILD_ID || currentGitHead();
  requireCondition(/^[a-f0-9]{7,64}$/i.test(expectedBuildId), 'expected_build_id_required');
  const runMarker = `LUMI-E2E-${crypto.randomBytes(8).toString('hex')}`;
  const requestId = phase => `e2e-${runMarker.toLowerCase()}-${phase}`;
  const summary = {
    ok: false,
    runtime: { healthy: false, buildMatches: false, sourceClean: false },
    socket: { trustedLocal: false, registeredByHarness: false },
    checks: {},
    cleanup: { conversationDeleted: false, backgroundAuditRetained: false },
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

    summary.ok = true;
    return summary;
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
  } catch (error) {
    summary = {
      ok: false,
      failedCheck: error instanceof E2EError ? error.code : 'unexpected_e2e_failure',
      cleanup: summary.cleanup || { conversationDeleted: false, backgroundAuditRetained: false },
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
