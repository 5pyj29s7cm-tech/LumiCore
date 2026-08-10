import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildStructuredRuntimeStatus } from '../server/monitor/runtime_status';

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: `conv-${id}`,
    userId: 'user-1',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: 'desktop_operation',
    operation: 'mutate',
    goal: `Goal ${id}`,
    target: 'report.pdf',
    status: 'completed',
    blocker: '',
    activeRequestId: '',
    completionSource: 'tool_receipt',
    context: '{}',
    revision: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:01:00.000Z',
    completedAt: '2026-08-10T00:01:00.000Z',
    ...overrides,
  };
}

function receipt(taskId: string, outcome: string, verification = 'verified') {
  return {
    id: `receipt-${taskId}`,
    taskId,
    conversationId: `conv-${taskId}`,
    turnId: 'turn-1',
    requestId: 'request-1',
    idempotencyKey: '0123456789abcdef-private-tail',
    toolName: 'desktop_open',
    targetIdentity: 'report.pdf',
    inputDigest: 'private-input-digest',
    envelope: JSON.stringify({
      status: outcome,
      result: { privatePayload: 'must-not-leak' },
      error: 'private tool error',
      verification: { status: verification, reason: 'private reason' },
    }),
    outcome,
    createdAt: '2026-08-10T00:01:00.000Z',
  };
}

describe('structured runtime status', () => {
  it('projects scoped task and receipt facts without raw payloads', () => {
    const db = {
      conversationActionTasks: [
        task('personal', { status: 'waiting_confirmation', activeRequestId: 'request-1' }),
        task('other-user', { userId: 'user-2' }),
        task('other-org', { domain: 'work', orgId: 'org-2' }),
      ],
      conversationActionReceipts: [receipt('personal', 'waiting_confirmation', 'unverified')],
      backgroundDelegationTasks: [],
      autonomousTasks: [],
    };
    const status = buildStructuredRuntimeStatus(db, {
      userId: 'user-1',
      domain: 'personal',
      now: '2026-08-10T00:02:00.000Z',
    });

    expect(status.level).toBe('attention');
    expect(status.counts.waitingConfirmation).toBe(1);
    expect(status.tasks.map(item => item.taskId)).toEqual(['personal']);
    expect(status.tasks[0].evidence.latest[0]).toMatchObject({
      toolName: 'desktop_open',
      outcome: 'waiting_confirmation',
      idempotencyRef: '0123456789abcdef',
    });
    expect(JSON.stringify(status)).not.toContain('must-not-leak');
    expect(JSON.stringify(status)).not.toContain('private tool error');
    expect(JSON.stringify(status)).not.toContain('private-input-digest');
  });

  it('counts all scoped evidence even when the visible task list is bounded', () => {
    const completed = Array.from({ length: 14 }, (_, index) => task(`done-${index}`, {
      updatedAt: `2026-08-10T00:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const blocked = task('blocked-old', {
      status: 'blocked',
      blocker: 'Needs a verified target',
      completedAt: '',
      updatedAt: '2026-08-09T00:00:00.000Z',
    });
    const status = buildStructuredRuntimeStatus({
      conversationActionTasks: [...completed, blocked],
      conversationActionReceipts: completed.map(item => receipt(item.id, 'verified_success')),
      backgroundDelegationTasks: [{
        id: 'background-blocked', userId: 'user-1', title: 'Background work', status: 'blocked',
        context: { domain: 'personal' }, updatedAt: '2026-08-10T00:20:00.000Z',
      }],
      autonomousTasks: [],
    }, { userId: 'user-1', domain: 'personal' });

    expect(status.tasks).toHaveLength(12);
    expect(status.counts.verifiedReceipts).toBe(14);
    expect(status.counts.blockedTasks).toBe(1);
    expect(status.counts.durableBlocked).toBe(1);
    expect(status.attentionReasons).toContain('durable_work_blocked');
  });

  it('keeps the structural snapshot id stable across poll timestamps and metric timestamps', () => {
    const db = { conversationActionTasks: [task('stable')], conversationActionReceipts: [], backgroundDelegationTasks: [], autonomousTasks: [] };
    const first = buildStructuredRuntimeStatus(db, {
      userId: 'user-1', domain: 'personal', now: '2026-08-10T00:00:00.000Z',
      runtime: { toolMetrics: { generatedAt: 'first' } },
    });
    const second = buildStructuredRuntimeStatus(db, {
      userId: 'user-1', domain: 'personal', now: '2026-08-10T00:01:00.000Z',
      runtime: { toolMetrics: { generatedAt: 'second' } },
    });
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it('mounts an authenticated scope-derived endpoint and visible evidence surfaces', () => {
    const routes = readFileSync(path.join(process.cwd(), 'server/routes/system_routes.ts'), 'utf8');
    const desktop = readFileSync(path.join(process.cwd(), 'src/components/DesktopUI.tsx'), 'utf8');
    const explorer = readFileSync(path.join(process.cwd(), 'src/components/SystemExplorer.tsx'), 'utf8');
    expect(routes).toContain("router.get('/runtime/status', requireAuth");
    expect(routes).toContain('const scope = resolveDomain(req.user!)');
    expect(desktop).toContain('runtimeStatus={structuredRuntimeStatus}');
    expect(explorer).toContain('<RuntimeEvidencePanel');
  });
});
