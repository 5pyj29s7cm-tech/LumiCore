#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { io as createSocketClient } from 'socket.io-client';
import { bootstrapDesktopTestSession } from './lib/desktop-bootstrap.mjs';
import {
  E2EError,
  buildLifecycleTurnEvidence,
  buildOwnedArtifactLayout,
  cleanOwnedArtifactLayout,
  currentGitHead,
  evidenceTextHash,
  fetchJson,
  isLoopbackBaseUrl,
  isPathInside,
  persistedMessages,
  pollRuntimeTaskByMarker,
  requireCondition,
  runTurn,
  runtimeReceiptSignature,
  runtimeStatus,
  validateCancellationLeaseRelease,
  validateStatusQueryNoReplay,
  waitForSocketReady,
} from './formal-client-e2e.mjs';

const CHECKPOINT_SCHEMA_VERSION = 1;

function usage() {
  return [
    'Formal Lumi restart-recovery E2E (safe two-stage protocol).',
    '',
    'Prepare:',
    '  node scripts/formal-client-restart-recovery.mjs prepare --confirm-live-e2e --data-root <absolute-path>',
    '',
    'Then restart the Lumi service/client yourself. This script never restarts it.',
    '',
    'Verify:',
    '  node scripts/formal-client-restart-recovery.mjs verify --confirm-live-e2e --data-root <absolute-path>',
    '',
    'Options:',
    '  --base-url <url>           default http://127.0.0.1:3000/api',
    '  --expected-build-id <sha>  default current git HEAD (prepare) or checkpoint build (verify)',
    '  --timeout-ms <ms>          default 180000',
    '  --checkpoint <path>        default <data-root>/formal-client-e2e-restart-checkpoint.json',
    '  --help',
    '',
    'The checkpoint contains no token, cookie, desktop proof, file payload, or tool result.',
  ].join('\n');
}

function parseArgs(argv) {
  const mode = argv[0];
  const args = {
    mode,
    baseUrl: 'http://127.0.0.1:3000/api',
    dataRoot: '',
    checkpoint: '',
    expectedBuildId: '',
    timeoutMs: 180_000,
    confirmed: false,
    help: argv.includes('--help') || argv.includes('-h'),
  };
  if (args.help) return args;
  if (!['prepare', 'verify'].includes(mode)) throw new E2EError('restart_mode_required');
  const valueFlags = new Set(['--base-url', '--data-root', '--checkpoint', '--expected-build-id', '--timeout-ms']);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new E2EError('invalid_arguments');
      index += 1;
      if (flag === '--base-url') args.baseUrl = value;
      if (flag === '--data-root') args.dataRoot = value;
      if (flag === '--checkpoint') args.checkpoint = value;
      if (flag === '--expected-build-id') args.expectedBuildId = value;
      if (flag === '--timeout-ms') args.timeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (flag === '--confirm-live-e2e') args.confirmed = true;
    else throw new E2EError('invalid_arguments');
  }
  if (!args.confirmed) throw new E2EError('live_confirmation_required');
  if (!args.dataRoot || !path.isAbsolute(args.dataRoot)) throw new E2EError('absolute_data_root_required');
  if (!isLoopbackBaseUrl(args.baseUrl)) throw new E2EError('loopback_api_required');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000 || args.timeoutMs > 900_000) {
    throw new E2EError('invalid_timeout');
  }
  args.baseUrl = String(args.baseUrl).replace(/\/$/, '');
  args.dataRoot = path.resolve(args.dataRoot);
  args.checkpoint = path.resolve(args.checkpoint || path.join(args.dataRoot, 'formal-client-e2e-restart-checkpoint.json'));
  if (!isPathInside(args.dataRoot, args.checkpoint)) throw new E2EError('restart_checkpoint_outside_data_root');
  return args;
}

function stableCheckpoint(value) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    marker: String(value.marker || ''),
    conversationId: String(value.conversationId || ''),
    taskId: String(value.taskId || ''),
    requestId: String(value.requestId || ''),
    targetPath: String(value.targetPath || ''),
    contentSha256: String(value.contentSha256 || ''),
    buildId: String(value.buildId || ''),
    runtimePid: Number(value.runtimePid) || 0,
    runtimeStartedAt: String(value.runtimeStartedAt || ''),
    receiptSignature: String(value.receiptSignature || ''),
    preparedAt: String(value.preparedAt || ''),
  };
}

export function validateRestartCheckpoint(value, dataRoot) {
  const checkpoint = stableCheckpoint(value || {});
  const layout = checkpoint.marker
    ? buildOwnedArtifactLayout(dataRoot, checkpoint.marker)
    : null;
  const valid = Number(value?.schemaVersion) === CHECKPOINT_SCHEMA_VERSION
    && /^LUMI-E2E-RESTART-[a-f0-9]{16}$/i.test(checkpoint.marker)
    && Boolean(checkpoint.conversationId && checkpoint.taskId && checkpoint.requestId)
    && /^[a-f0-9]{7,64}$/i.test(checkpoint.buildId)
    && checkpoint.runtimePid > 0
    && Number.isFinite(new Date(checkpoint.runtimeStartedAt).getTime())
    && Number.isFinite(new Date(checkpoint.preparedAt).getTime())
    && /^[a-f0-9]{64}$/i.test(checkpoint.contentSha256)
    && Boolean(checkpoint.receiptSignature)
    && Boolean(layout && layout.files.includes(path.resolve(checkpoint.targetPath)));
  return valid ? { ok: true, checkpoint, layout } : { ok: false, checkpoint, layout: null };
}

export function validateRestartRecoveryEvidence({ checkpoint, health, task, messages }) {
  if (String(health?.runtime?.buildId || '') !== checkpoint?.buildId) {
    return { ok: false, code: 'restart_build_mismatch' };
  }
  const restarted = Number(health?.runtime?.pid) !== Number(checkpoint?.runtimePid)
    || String(health?.runtime?.startedAt || '') !== String(checkpoint?.runtimeStartedAt || '');
  if (!restarted) return { ok: false, code: 'runtime_restart_not_observed' };
  if (!task || task.taskId !== checkpoint?.taskId) return { ok: false, code: 'restart_task_identity_lost' };
  if (task.status !== 'waiting_confirmation' || task.activeRequest !== false) {
    return { ok: false, code: 'restart_task_not_recovered' };
  }
  if (runtimeReceiptSignature(task) !== checkpoint?.receiptSignature) {
    return { ok: false, code: 'restart_receipt_identity_changed' };
  }
  const turnEvidence = buildLifecycleTurnEvidence({
    messages,
    requestId: checkpoint?.requestId,
    runtimeTask: task,
  });
  if (!turnEvidence.userMessageId || !turnEvidence.assistantMessageId || turnEvidence.receiptIds.length === 0) {
    return { ok: false, code: 'restart_transcript_evidence_missing' };
  }
  return {
    ok: true,
    code: '',
    evidence: {
      previousRuntime: {
        pid: checkpoint.runtimePid,
        startedAt: checkpoint.runtimeStartedAt,
      },
      recoveredRuntime: {
        pid: Number(health.runtime.pid),
        startedAt: String(health.runtime.startedAt || ''),
      },
      turn: turnEvidence,
    },
  };
}

function writeCheckpointExclusive(checkpointPath, checkpoint) {
  if (fs.existsSync(checkpointPath)) throw new E2EError('restart_checkpoint_exists');
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(stableCheckpoint(checkpoint), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, checkpointPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readCheckpoint(checkpointPath, dataRoot) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch {
    throw new E2EError('restart_checkpoint_unreadable');
  }
  const validated = validateRestartCheckpoint(parsed, dataRoot);
  if (!validated.ok) throw new E2EError('restart_checkpoint_invalid');
  return validated;
}

async function connect(baseUrl, token, desktopSessionProof) {
  const socket = createSocketClient(new URL(baseUrl).origin, {
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    transports: ['websocket'],
    auth: { token, desktopSessionProof },
  });
  const boundary = await waitForSocketReady(socket, 15_000);
  requireCondition(boundary?.trustedLocalExecution === true, 'trusted_local_boundary_required');
  return socket;
}

async function bootstrap(args) {
  const session = await bootstrapDesktopTestSession(args.baseUrl, args.dataRoot, { timeoutMs: 15_000 });
  const token = String(session?.token || '');
  const desktopSessionProof = String(session?.desktopSessionProof || '');
  requireCondition(token && desktopSessionProof, 'desktop_bootstrap_invalid');
  const health = await fetchJson(args.baseUrl, '/health', { token, query: { details: 1 } });
  requireCondition(health?.status === 'ok', 'runtime_health_failed');
  return { token, desktopSessionProof, health };
}

async function prepare(args) {
  if (fs.existsSync(args.checkpoint)) throw new E2EError('restart_checkpoint_exists');
  const marker = `LUMI-E2E-RESTART-${crypto.randomBytes(8).toString('hex')}`;
  const layout = buildOwnedArtifactLayout(args.dataRoot, marker);
  const targetPath = layout.files[0];
  const content = `${marker}:pending-across-restart`;
  let token = '';
  let socket = null;
  let conversationId = '';
  let prepared = false;
  try {
    const boot = await bootstrap(args);
    token = boot.token;
    const expectedBuildId = args.expectedBuildId || currentGitHead();
    requireCondition(/^[a-f0-9]{7,64}$/i.test(expectedBuildId), 'expected_build_id_required');
    requireCondition(String(boot.health?.runtime?.buildId || '') === expectedBuildId, 'runtime_build_mismatch');
    socket = await connect(args.baseUrl, token, boot.desktopSessionProof);
    const created = await fetchJson(args.baseUrl, '/conversations/new', {
      token,
      method: 'POST',
      body: { agentId: 'lumi', domain: 'personal' },
      query: { domain: 'personal' },
    });
    conversationId = String(created?.conversation?.id || '');
    requireCondition(conversationId, 'conversation_create_failed');
    const requestId = `e2e-${marker.toLowerCase()}-prepare`;
    await runTurn(socket, {
      requestId,
      conversationId,
      timeoutMs: args.timeoutMs,
      text: `[${marker}] 创建确认门控文件 ${targetPath}，内容严格写成 ${content}。必须调用 write_file 并等待确认，不得自行确认。`,
    });
    const [{ task }, messages] = await Promise.all([
      pollRuntimeTaskByMarker(args.baseUrl, token, marker, args.timeoutMs),
      persistedMessages(args.baseUrl, token, conversationId),
    ]);
    const turnEvidence = buildLifecycleTurnEvidence({ messages, requestId, runtimeTask: task });
    requireCondition(task.status === 'waiting_confirmation', 'restart_prepare_not_waiting_confirmation');
    requireCondition(task.activeRequest === false, 'restart_prepare_lease_not_yielded');
    requireCondition(turnEvidence.userMessageId && turnEvidence.assistantMessageId, 'restart_prepare_transcript_missing');
    requireCondition(turnEvidence.receiptIds.length > 0, 'restart_prepare_receipt_missing');
    requireCondition(!fs.existsSync(targetPath), 'restart_prepare_artifact_created');
    const checkpoint = stableCheckpoint({
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      marker,
      conversationId,
      taskId: task.taskId,
      requestId,
      targetPath,
      contentSha256: evidenceTextHash(content),
      buildId: expectedBuildId,
      runtimePid: boot.health.runtime.pid,
      runtimeStartedAt: boot.health.runtime.startedAt,
      receiptSignature: runtimeReceiptSignature(task),
      preparedAt: new Date().toISOString(),
    });
    requireCondition(
      validateRestartCheckpoint(checkpoint, args.dataRoot).ok,
      'restart_checkpoint_evidence_invalid',
    );
    writeCheckpointExclusive(args.checkpoint, checkpoint);
    prepared = true;
    return {
      ok: true,
      phase: 'prepare',
      restartRequired: true,
      restartPerformedByScript: false,
      checkpointPath: args.checkpoint,
      evidence: {
        taskId: task.taskId,
        requestId,
        receiptIds: turnEvidence.receiptIds,
        userMessageId: turnEvidence.userMessageId,
        assistantMessageId: turnEvidence.assistantMessageId,
        replyHash: turnEvidence.userFacingReply.sha256,
        contentSha256: checkpoint.contentSha256,
        runtimePid: checkpoint.runtimePid,
        runtimeStartedAt: checkpoint.runtimeStartedAt,
      },
      nextStep: 'Restart Lumi yourself, then run the verify command.',
    };
  } finally {
    try { socket?.disconnect(); } catch {}
    if (!prepared) {
      let cleanupFailed = false;
      if (conversationId && token) {
        try {
          const deleted = await fetchJson(args.baseUrl, `/conversations/${encodeURIComponent(conversationId)}`, {
            token,
            method: 'DELETE',
            query: { domain: 'personal' },
          });
          if (deleted?.success === false) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      if (fs.existsSync(args.checkpoint)) {
        try { fs.unlinkSync(args.checkpoint); } catch { cleanupFailed = true; }
      }
      if (!cleanOwnedArtifactLayout(layout).ok) cleanupFailed = true;
      if (cleanupFailed) throw new E2EError('restart_prepare_cleanup_failed');
    }
  }
}

async function verify(args) {
  const validated = readCheckpoint(args.checkpoint, args.dataRoot);
  const { checkpoint, layout } = validated;
  let token = '';
  let socket = null;
  let verificationCompleted = false;
  let result = null;
  try {
    const boot = await bootstrap(args);
    token = boot.token;
    if (args.expectedBuildId) requireCondition(boot.health.runtime.buildId === args.expectedBuildId, 'runtime_build_mismatch');
    socket = await connect(args.baseUrl, token, boot.desktopSessionProof);
    await fetchJson(args.baseUrl, `/conversations/${encodeURIComponent(checkpoint.conversationId)}/activate`, {
      token,
      method: 'POST',
      body: { agentId: 'lumi' },
      query: { domain: 'personal' },
    });
    const [runtime, messages] = await Promise.all([
      runtimeStatus(args.baseUrl, token),
      persistedMessages(args.baseUrl, token, checkpoint.conversationId),
    ]);
    const recoveredTask = runtime?.tasks?.find(task => task?.taskId === checkpoint.taskId) || null;
    const recovered = validateRestartRecoveryEvidence({
      checkpoint,
      health: boot.health,
      task: recoveredTask,
      messages,
    });
    requireCondition(recovered.ok, recovered.code);
    requireCondition(!fs.existsSync(checkpoint.targetPath), 'restart_recovery_artifact_created');

    const statusRequestId = `e2e-${checkpoint.marker.toLowerCase()}-verify-status`;
    const statusTurn = await runTurn(socket, {
      requestId: statusRequestId,
      conversationId: checkpoint.conversationId,
      timeoutMs: args.timeoutMs,
      text: '这个任务完成了吗？只报告恢复后的持久状态，不要执行、确认或重放任何动作。',
    });
    const statusSnapshot = await pollRuntimeTaskByMarker(args.baseUrl, token, checkpoint.marker, args.timeoutMs);
    const statusMessages = await persistedMessages(args.baseUrl, token, checkpoint.conversationId);
    const statusEvidence = buildLifecycleTurnEvidence({
      messages: statusMessages,
      requestId: statusRequestId,
      runtimeTask: statusSnapshot.task,
    });
    const statusValidation = validateStatusQueryNoReplay({
      beforeTask: recoveredTask,
      afterTask: statusSnapshot.task,
      turnEvidence: statusEvidence,
      toolEventCount: statusTurn.toolEvents.length,
    });
    requireCondition(statusValidation.ok, statusValidation.code);

    const cancelRequestId = `e2e-${checkpoint.marker.toLowerCase()}-verify-cancel`;
    await runTurn(socket, {
      requestId: cancelRequestId,
      conversationId: checkpoint.conversationId,
      timeoutMs: args.timeoutMs,
      text: '取消这个任务。',
    });
    const cancelled = await pollRuntimeTaskByMarker(
      args.baseUrl,
      token,
      checkpoint.marker,
      args.timeoutMs,
      task => task.status === 'cancelled' && task.activeRequest === false,
    );
    const cancelMessages = await persistedMessages(args.baseUrl, token, checkpoint.conversationId);
    const cancelEvidence = buildLifecycleTurnEvidence({
      messages: cancelMessages,
      requestId: cancelRequestId,
      runtimeTask: cancelled.task,
    });
    const cancelValidation = validateCancellationLeaseRelease({
      beforeTask: statusSnapshot.task,
      afterTask: cancelled.task,
      turnEvidence: cancelEvidence,
    });
    requireCondition(cancelValidation.ok, cancelValidation.code);
    requireCondition(!fs.existsSync(checkpoint.targetPath), 'restart_cancel_artifact_created');

    result = {
      ok: true,
      phase: 'verify',
      restartObserved: true,
      restartPerformedByScript: false,
      evidence: {
        ...recovered.evidence,
        statusQuery: statusEvidence,
        cancellation: cancelEvidence,
        finalStatus: cancelled.task.status,
        activeLease: cancelled.task.activeRequest,
      },
      cleanup: { conversationDeleted: false, checkpointRemoved: false, ownedArtifactsRemoved: false },
    };
    verificationCompleted = true;
    return result;
  } finally {
    try { socket?.disconnect(); } catch {}
    if (verificationCompleted && token) {
      let cleanupFailed = false;
      try {
        const deleted = await fetchJson(args.baseUrl, `/conversations/${encodeURIComponent(checkpoint.conversationId)}`, {
          token,
          method: 'DELETE',
          query: { domain: 'personal' },
        });
        if (deleted?.success === false) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
      try {
        if (fs.existsSync(args.checkpoint)) fs.unlinkSync(args.checkpoint);
      } catch {
        cleanupFailed = true;
      }
      const artifactCleanup = cleanOwnedArtifactLayout(layout);
      if (!artifactCleanup.ok) cleanupFailed = true;
      if (cleanupFailed) throw new E2EError('restart_verify_cleanup_failed');
      if (result) {
        result.cleanup = {
          conversationDeleted: true,
          checkpointRemoved: true,
          ownedArtifactsRemoved: true,
        };
      }
    } else {
      const artifactCleanup = cleanOwnedArtifactLayout(layout);
      if (!artifactCleanup.ok) throw new E2EError('restart_verify_cleanup_failed');
    }
  }
}

async function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    result = args.mode === 'prepare' ? await prepare(args) : await verify(args);
  } catch (error) {
    result = {
      ok: false,
      phase: process.argv[2] || 'unknown',
      failedCheck: error instanceof E2EError ? error.code : 'unexpected_restart_e2e_failure',
      restartPerformedByScript: false,
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
