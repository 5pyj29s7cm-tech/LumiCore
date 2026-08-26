import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateRestartCheckpoint,
  validateRestartRecoveryEvidence,
} from '../scripts/formal-client-restart-recovery.mjs';
import {
  buildOwnedArtifactLayout,
  runtimeReceiptSignature,
} from '../scripts/formal-client-e2e.mjs';

const MARKER = 'LUMI-E2E-RESTART-0123456789abcdef';
const BUILD_ID = 'a'.repeat(40);
const DATA_ROOT = path.resolve(path.parse(process.cwd()).root, 'LumiE2ERestartData');

function fixture() {
  const layout = buildOwnedArtifactLayout(DATA_ROOT, MARKER);
  const task = {
    taskId: 'task-restart-1',
    revision: 3,
    status: 'waiting_confirmation',
    activeRequest: false,
    evidence: {
      latest: [{
        receiptId: 'receipt-pending-1',
        requestId: 'request-prepare-1',
        toolName: 'write_file',
        outcome: 'waiting_confirmation',
        verification: 'unverified',
      }],
    },
  };
  const checkpoint = {
    schemaVersion: 1,
    marker: MARKER,
    conversationId: 'conversation-restart-1',
    taskId: task.taskId,
    requestId: 'request-prepare-1',
    targetPath: layout.files[0],
    contentSha256: 'b'.repeat(64),
    buildId: BUILD_ID,
    runtimePid: 100,
    runtimeStartedAt: '2026-08-27T04:00:00.000Z',
    receiptSignature: runtimeReceiptSignature(task),
    preparedAt: '2026-08-27T04:01:00.000Z',
  };
  const messages = [
    {
      id: 'message-user-prepare',
      role: 'user',
      requestId: checkpoint.requestId,
      message: 'Create the confirmation-gated file.',
    },
    {
      id: 'message-assistant-prepare',
      role: 'assistant',
      requestId: checkpoint.requestId,
      message: 'The action is waiting for confirmation.',
    },
  ];
  const health = {
    runtime: {
      buildId: BUILD_ID,
      pid: 200,
      startedAt: '2026-08-27T04:02:00.000Z',
    },
  };
  return { checkpoint, health, layout, messages, task };
}

describe('formal restart-recovery E2E protocol', () => {
  it('accepts only a bounded, credential-free checkpoint projection', () => {
    const { checkpoint, layout } = fixture();
    const validation = validateRestartCheckpoint({
      ...checkpoint,
      token: 'must-not-survive',
      cookie: 'must-not-survive',
      desktopSessionProof: 'must-not-survive',
      payload: 'must-not-survive',
    }, DATA_ROOT);
    expect(validation.ok).toBe(true);
    expect(validation.layout?.root).toBe(layout.root);
    expect(Object.keys(validation.checkpoint)).not.toEqual(expect.arrayContaining([
      'token',
      'cookie',
      'desktopSessionProof',
      'payload',
      'toolResult',
    ]));
    expect(validateRestartCheckpoint({
      ...checkpoint,
      targetPath: path.join(DATA_ROOT, 'outside.txt'),
    }, DATA_ROOT).ok).toBe(false);
  });

  it('requires an observed restart and preserves task, transcript, and receipt identity', () => {
    const { checkpoint, health, messages, task } = fixture();
    expect(validateRestartRecoveryEvidence({ checkpoint, health, task, messages })).toMatchObject({
      ok: true,
      evidence: {
        previousRuntime: { pid: 100 },
        recoveredRuntime: { pid: 200 },
        turn: {
          taskId: 'task-restart-1',
          userMessageId: 'message-user-prepare',
          assistantMessageId: 'message-assistant-prepare',
          receiptIds: ['receipt-pending-1'],
        },
      },
    });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: {
        runtime: {
          buildId: BUILD_ID,
          pid: checkpoint.runtimePid,
          startedAt: checkpoint.runtimeStartedAt,
        },
      },
      task,
      messages,
    })).toEqual({ ok: false, code: 'runtime_restart_not_observed' });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health,
      task: { ...task, taskId: 'different-task' },
      messages,
    })).toEqual({ ok: false, code: 'restart_task_identity_lost' });
  });

  it('contains no process-launch or service-restart primitive and documents the two manual stages', () => {
    const script = path.resolve('scripts/formal-client-restart-recovery.mjs');
    const source = fs.readFileSync(script, 'utf8');
    expect(source).not.toMatch(/\b(?:execFileSync|execSync|spawn|fork|Start-Process|Restart-Service|Stop-Process)\s*\(/u);
    const help = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(help).toContain('Prepare:');
    expect(help).toContain('Verify:');
    expect(help).toContain('This script never restarts it.');
    expect(help).toContain('contains no token, cookie, desktop proof, file payload, or tool result');
  });

  it('keeps importable E2E modules free of Windows CRLF shebang parsing hazards', () => {
    for (const script of [
      path.resolve('scripts/formal-client-e2e.mjs'),
      path.resolve('scripts/formal-client-restart-recovery.mjs'),
    ]) {
      expect(fs.readFileSync(script, 'utf8')).not.toMatch(/^#!/u);
    }
  });
});
