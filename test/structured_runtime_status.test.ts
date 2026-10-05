import { readImplementationSource } from './implementation_source';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildStructuredRuntimeStatus } from '../server/monitor/runtime_status';
import { listConversationFocusThreads } from '../server/conversation/focus_threads';
import { buildTaskAcceptanceProjections } from '../server/cognition/acceptance_evidence';

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
  it('counts autonomous blockers beyond the visible list and changes identity when hidden totals change', () => {
    const autonomousTasks = Array.from({ length: 12 }, (_, index) => ({ id: 'visible-' + index, userId: 'user-1',
      status: 'pending', title: 'Current work', createdAt: '2026-08-10T00:00:00Z' }));
    autonomousTasks.push({ id: 'hidden', userId: 'user-1', status: 'blocked', title: 'Old blocker', createdAt: '2026-08-09T00:00:00Z' });
    const db = { autonomousTasks }, input = { userId: 'user-1', domain: 'personal' as const };
    const first = buildStructuredRuntimeStatus(db, input);
    expect(first.durableWork).toHaveLength(12);
    expect(first.counts).toMatchObject({ autonomousActive: 12, durableBlocked: 1 });
    expect(first.attentionReasons).toContain('durable_work_blocked');
    autonomousTasks.push({ ...autonomousTasks[12], id: 'older-failure', status: 'failed' });
    const second = buildStructuredRuntimeStatus(db, input);
    expect(second.durableWork).toEqual(first.durableWork);
    expect(second.counts.durableBlocked).toBe(2);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(buildStructuredRuntimeStatus(db, { ...input, userId: 'other' }).counts.durableBlocked).toBe(0);
    expect(buildStructuredRuntimeStatus(db, { ...input, domain: 'work', orgId: 'org-a' }).durableWork).toEqual([]);
  });
  it('includes hidden receipt totals in snapshot identity without mutating persisted tasks or receipts', () => {
    const db = { conversationActionTasks: Array.from({ length: 13 }, (_, i) => task('task-' + i,
      { updatedAt: '2026-08-10T00:' + String(i).padStart(2, '0') + ':00Z' })),
      conversationActionReceipts: [receipt('task-0', 'verified_success')] };
    const first = buildStructuredRuntimeStatus(db, { userId: 'user-1', domain: 'personal' });
    db.conversationActionReceipts.push({ ...receipt('task-0', 'verified_success'), id: 'second-receipt' });
    const stored = JSON.stringify(db);
    const second = buildStructuredRuntimeStatus(db, { userId: 'user-1', domain: 'personal' });
    expect(second.tasks).toEqual(first.tasks);
    expect(second.counts.verifiedReceipts).toBe(2);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(JSON.stringify(db)).toBe(stored);
  });
  it('projects scoped task and receipt facts without raw payloads', () => {
    const db = {
      conversationActionTasks: [
        task('personal', { status: 'waiting_confirmation', activeRequestId: 'request-1' }),
        task('other-user', { userId: 'user-2' }),
        task('other-org', { domain: 'work', orgId: 'org-2' }),
      ],
      conversationActionReceipts: [receipt('personal', 'waiting_confirmation', 'unverified')],
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
      autonomousTasks: [{
        id: 'autonomous-blocked', userId: 'user-1', title: 'Autonomous work', status: 'blocked',
        checkpoint: { phase: 'verification' }, updatedAt: '2026-08-10T00:20:00.000Z',
      }],
    }, { userId: 'user-1', domain: 'personal' });

    expect(status.tasks).toHaveLength(12);
    expect(status.counts.verifiedReceipts).toBe(14);
    expect(status.counts.blockedTasks).toBe(1);
    expect(status.counts.durableBlocked).toBe(1);
    expect(status.attentionReasons).toContain('durable_work_blocked');
  });

  it('keeps the structural snapshot id stable across poll timestamps and metric timestamps', () => {
    const db = { conversationActionTasks: [task('stable')], conversationActionReceipts: [], autonomousTasks: [] };
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

  it('keeps runtime evidence in System Explorer and only projects active work into a floating widget', () => {
    const routes = readImplementationSource(path.join(process.cwd(), 'server/routes/system_routes.ts'), 'utf8');
    const desktop = readImplementationSource(path.join(process.cwd(), 'src/components/DesktopUI.tsx'), 'utf8');
    const chat = readImplementationSource(path.join(process.cwd(), 'src/components/AgentChatPage.tsx'), 'utf8');
    const explorer = readImplementationSource(path.join(process.cwd(), 'src/components/SystemExplorer.tsx'), 'utf8');
    expect(routes).toContain("router.get('/runtime/status', requireAuth");
    expect(routes).toContain('const scope = resolveDomain(req.user!)');
    expect(desktop).not.toContain('<WorkflowPanel');
    expect(desktop).not.toContain('runtimeStatus={structuredRuntimeStatus}');
    expect(chat).toContain('<ActiveTaskWidget');
    expect(chat).not.toContain('conversationPanelView');
    expect(chat).not.toContain('<FocusThreadPanel');
    expect(chat).not.toContain('<ConversationTaskLedger');
    expect(explorer).toContain('<RuntimeEvidencePanel');
    expect(explorer).toContain('<LumiScenePanel');
  });

  it('does not create a second visible task for a takeover receipt archive', () => {
    const db = {
      conversationActionTasks: [
        task('foreground', { status: 'executing' }),
        task('takeover-owned', {
          status: 'created', activeRequestId: '',
          context: JSON.stringify({ executionOwner: 'work_takeover', ownerTaskId: 'takeover-owned' }),
        }),
      ],
      conversationActionReceipts: [], autonomousTasks: [],
    };
    const scope = { userId: 'user-1', domain: 'personal' as const };
    const status = buildStructuredRuntimeStatus(db, scope);
    expect(status.tasks.map(item => item.taskId)).toEqual(['foreground']);
    expect(status.counts.activeTasks).toBe(1);
    expect(listConversationFocusThreads(db, scope).map(item => item.taskId)).toEqual(['foreground']);
    expect(buildTaskAcceptanceProjections(db, scope).map(item => item.taskId)).toEqual(['foreground']);
    expect(db.conversationActionTasks).toHaveLength(2);
  });
});
