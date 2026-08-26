import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildScheduledExecutionId,
  buildScheduledProactiveInteractionId,
  buildScheduledTaskExecutionPlan,
  resolveScheduledUserIds,
} from '../server/scheduler';
import {
  compactLegacyScheduledCapabilityExecutions,
  getScheduledCapabilityExecutionStatus,
  persistScheduledCapabilityExecution,
} from '../server/conversation/action_ledger';
import { evaluateCapabilityRollout } from '../server/cognition/capability_rollout';
import type { ToolExecutionRecord } from '../server/tools/types';

function verifiedRecord(plan: ReturnType<typeof buildScheduledTaskExecutionPlan>): ToolExecutionRecord {
  const node = plan.nodes.find(candidate => candidate.toolName === 'scheduler_task_handler')!;
  const receipt = { status: 'verified', verified: true, scheduledTaskId: plan.intent.target };
  return {
    name: 'scheduler_task_handler',
    taskId: plan.taskId,
    turnId: plan.taskId,
    requestId: plan.taskId,
    idempotencyKey: `${plan.taskId}:scheduler_task_handler:verified`,
    arguments: { scheduledTaskId: plan.intent.target, executionId: plan.taskId },
    result: JSON.stringify(receipt),
    receipt,
    capability: {
      capabilityId: node.capabilityId,
      lane: node.lane,
      operation: node.operation,
      risk: node.risk,
      sideEffects: node.sideEffects,
      verification: node.verification,
    },
    terminalVerification: {
      status: 'verified',
      strategy: 'terminal_receipt',
      reason: 'test receipt',
    },
  };
}

describe('scheduler capability execution protocol', () => {
  it('runs proactive/background work only for registered users', () => {
    const db = {
      users: [
        { uid: 'admin-uid', role: 'admin' },
        { uid: 'member-uid', role: 'member' },
      ],
      memories: [
        { userId: 'agent-id-1' },
        { userId: 'mcp_remote' },
        { userId: 'unknown' },
      ],
      interactions: [
        { userId: 'anonymous' },
        { userId: 'agent-id-2' },
      ],
    };

    expect(resolveScheduledUserIds(db)).toEqual(['admin-uid', 'member-uid']);
    expect(resolveScheduledUserIds({ users: [], memories: [{ userId: 'agent-id' }] }))
      .toEqual(['anonymous']);
  });

  it('builds a stable, local-only semantic plan for each schedule slot', () => {
    const at = new Date('2026-07-29T01:02:03.000Z');
    const task = {
      id: 'daily_summary',
      cron: 'daily_9am',
      executionClass: 'proactive_delivery' as const,
    };
    const plan = buildScheduledTaskExecutionPlan(task, at);

    expect(plan.taskId).toBe(buildScheduledExecutionId(task.id, task.cron, at));
    expect(plan.intent).toMatchObject({
      kind: 'scheduled_task',
      target: 'daily_summary',
      sideEffectClass: 'local_write',
      rule: 'declared-scheduler-policy',
    });
    expect(plan.risk).toMatchObject({ requiresConfirmation: false, failClosed: false });
    expect(plan.decisionAuthority).toBe('semantic_planner');
    expect(plan.scriptAuthority).toBe('adapter_only');
    expect(plan.nodes.find(node => node.toolName === 'scheduler_task_handler')).toMatchObject({
      capabilityId: 'lumi.scheduler.daily_summary',
      executionRole: 'adapter',
      operation: 'communicate',
    });
    expect(plan.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ condition: 'selected' }),
      expect.objectContaining({ condition: 'success' }),
      expect.objectContaining({ condition: 'verified' }),
    ]));
    expect(JSON.stringify(plan)).not.toContain('external_commit');
    const adapter = plan.nodes.find(node => node.toolName === 'scheduler_task_handler')!;
    expect(evaluateCapabilityRollout(plan, adapter, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'shadow' } as NodeJS.ProcessEnv))
      .toMatchObject({ allowed: false, stage: 'shadow' });
  });

  it('deduplicates interval execution and proactive interaction identities', () => {
    const first = new Date('2026-07-29T01:02:01.000Z');
    const sameSlot = new Date('2026-07-29T01:02:09.999Z');
    const nextSlot = new Date('2026-07-29T01:02:10.000Z');
    expect(buildScheduledExecutionId('ambient_activity_poll', 'every_10s', first))
      .toBe(buildScheduledExecutionId('ambient_activity_poll', 'every_10s', sameSlot));
    expect(buildScheduledExecutionId('ambient_activity_poll', 'every_10s', first))
      .not.toBe(buildScheduledExecutionId('ambient_activity_poll', 'every_10s', nextSlot));

    const scope = { userId: 'owner', domain: 'personal' as const, orgId: '' };
    const executionId = buildScheduledExecutionId('daily_summary', 'daily_9am', first);
    expect(buildScheduledProactiveInteractionId(executionId, 0, scope))
      .toBe(buildScheduledProactiveInteractionId(executionId, 0, scope));
    expect(buildScheduledProactiveInteractionId(executionId, 0, scope))
      .not.toBe(buildScheduledProactiveInteractionId(executionId, 1, scope));
  });

  it('persists the sanitized plan and terminal receipt without downgrading completion', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const plan = buildScheduledTaskExecutionPlan({
      id: 'memory_decay',
      cron: 'every_6h',
      executionClass: 'maintenance',
    }, new Date('2026-07-29T06:00:00.000Z'));

    persistScheduledCapabilityExecution(db, {
      scheduledTaskId: 'memory_decay',
      plan,
      status: 'executing',
      now: '2026-07-29T06:00:00.000Z',
    });
    const completed = persistScheduledCapabilityExecution(db, {
      scheduledTaskId: 'memory_decay',
      plan,
      status: 'completed',
      records: [verifiedRecord(plan)],
      now: '2026-07-29T06:00:01.000Z',
    });
    const replay = persistScheduledCapabilityExecution(db, {
      scheduledTaskId: 'memory_decay',
      plan,
      status: 'blocked',
      blocker: 'late duplicate',
      now: '2026-07-29T06:00:02.000Z',
    });

    expect(completed.status).toBe('completed');
    expect(replay.status).toBe('completed');
    expect(replay.blocker).toBe('');
    expect(db.conversationActionTasks).toHaveLength(1);
    expect(db.conversationActionReceipts).toHaveLength(1);
    expect(db.conversationActionReceipts[0]).toMatchObject({
      taskId: plan.taskId,
      toolName: 'scheduler_task_handler',
      outcome: 'verified_success',
    });
    const context = typeof replay.context === 'string' ? JSON.parse(replay.context) : replay.context;
    expect(context.source).toBe('scheduler');
    expect(context.executionPlan.intent.payload).toBe('');
    expect(context.executionPlan.scriptAuthority).toBe('adapter_only');
  });

  it('keeps high-frequency successful probes in one bounded audit task', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    for (let index = 0; index < 200; index += 1) {
      const startedAt = new Date(Date.parse('2026-08-07T00:00:00.000Z') + index * 10_000);
      const plan = buildScheduledTaskExecutionPlan({
        id: 'ambient_activity_poll',
        cron: 'every_10s',
        executionClass: 'client_probe',
      }, startedAt);
      persistScheduledCapabilityExecution(db, {
        scheduledTaskId: 'ambient_activity_poll',
        plan,
        status: 'executing',
        compactAudit: true,
        now: startedAt.toISOString(),
      });
      persistScheduledCapabilityExecution(db, {
        scheduledTaskId: 'ambient_activity_poll',
        plan,
        status: 'completed',
        records: [verifiedRecord(plan)],
        compactAudit: true,
        now: new Date(startedAt.getTime() + 500).toISOString(),
      });
    }

    expect(db.conversationActionTasks).toHaveLength(1);
    expect(db.conversationActionReceipts.length).toBeLessThanOrEqual(4);
    const context = JSON.parse(db.conversationActionTasks[0].context);
    expect(context.schedulerAudit).toMatchObject({
      totalExecutions: 200,
      completedCount: 200,
      failedCount: 0,
      lastOutcome: 'verified',
    });
    expect(context.schedulerAudit.recentExecutions).toHaveLength(36);
    const lastExecutionId = context.schedulerAudit.currentExecution.executionId;
    expect(getScheduledCapabilityExecutionStatus(db, {
      scheduledTaskId: 'ambient_activity_poll',
      executionId: lastExecutionId,
    })).toBe('verified');
  });

  it('keeps all scheduled task summaries bounded while preserving abnormal receipts', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    for (const scheduledTaskId of ['reminder_check', 'autonomous_work_cycle', 'memory_consolidation']) {
      for (let index = 0; index < 80; index += 1) {
        const startedAt = new Date(Date.parse('2026-08-07T00:00:00.000Z') + index * 5 * 60_000);
        const task = {
          id: scheduledTaskId,
          cron: 'every_5m',
          executionClass: scheduledTaskId === 'reminder_check'
            ? 'proactive_delivery' as const
            : scheduledTaskId === 'autonomous_work_cycle'
              ? 'autonomous_orchestration' as const
              : 'maintenance' as const,
        };
        const plan = buildScheduledTaskExecutionPlan(task, startedAt);
        persistScheduledCapabilityExecution(db, {
          scheduledTaskId,
          plan,
          status: 'executing',
          compactAudit: true,
          now: startedAt.toISOString(),
        });
        persistScheduledCapabilityExecution(db, {
          scheduledTaskId,
          plan,
          status: 'completed',
          records: [verifiedRecord(plan)],
          compactAudit: true,
          now: new Date(startedAt.getTime() + 250).toISOString(),
        });
      }
    }

    expect(db.conversationActionTasks).toHaveLength(3);
    expect(db.conversationActionReceipts.length).toBeLessThanOrEqual(6);
    for (const task of db.conversationActionTasks) {
      const audit = JSON.parse(task.context).schedulerAudit;
      expect(audit.totalExecutions).toBe(80);
      expect(audit.completedCount).toBe(80);
      expect(audit.recentExecutions).toHaveLength(36);
    }

    const abnormalTask = {
      id: 'reminder_check',
      cron: 'every_5m',
      executionClass: 'proactive_delivery' as const,
    };
    const abnormalPlan = buildScheduledTaskExecutionPlan(abnormalTask, new Date('2026-08-08T00:00:00.000Z'));
    const abnormalRecord = verifiedRecord(abnormalPlan);
    abnormalRecord.error = 'scheduler_handler_failed';
    abnormalRecord.receipt = { status: 'failed', verified: false };
    persistScheduledCapabilityExecution(db, {
      scheduledTaskId: abnormalTask.id,
      plan: abnormalPlan,
      status: 'blocked',
      blocker: 'handler failed',
      records: [abnormalRecord],
      compactAudit: true,
      now: '2026-08-08T00:00:01.000Z',
    });
    expect(db.conversationActionReceipts.some((receipt: any) => receipt.outcome === 'failed')).toBe(true);
  });

  it('compacts only legacy verified probe rows and preserves abnormal evidence', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const scheduledTaskId = 'reminder_check';
    const makeTask = (id: string, status: string, at: string) => ({
      id,
      conversationId: `scheduler:${scheduledTaskId}`,
      userId: 'system',
      domain: 'personal',
      orgId: '',
      parentTaskId: '',
      rootUserMessageId: '',
      intentKind: 'scheduled_task',
      operation: 'communicate',
      goal: 'legacy scheduler run',
      target: scheduledTaskId,
      status,
      blocker: status === 'blocked' ? 'failure kept' : '',
      activeRequestId: '',
      completionSource: status === 'completed' ? 'tool_receipt' : '',
      context: '{}',
      revision: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: status === 'completed' ? at : '',
    });
    for (let index = 0; index < 3; index += 1) {
      const id = `legacy-ok-${index}`;
      const at = `2026-08-07T00:0${index}:00.000Z`;
      db.conversationActionTasks.push(makeTask(id, 'completed', at));
      db.conversationActionReceipts.push({
        id: `receipt-${id}`,
        taskId: id,
        conversationId: `scheduler:${scheduledTaskId}`,
        turnId: id,
        requestId: id,
        idempotencyKey: id,
        toolName: 'scheduler_task_handler',
        targetIdentity: scheduledTaskId,
        inputDigest: id,
        envelope: '{}',
        outcome: 'verified_success',
        createdAt: at,
      });
    }
    db.conversationActionTasks.push(makeTask('legacy-failed', 'blocked', '2026-08-07T00:04:00.000Z'));
    db.conversationActionReceipts.push({
      id: 'receipt-legacy-failed',
      taskId: 'legacy-failed',
      conversationId: `scheduler:${scheduledTaskId}`,
      turnId: 'legacy-failed',
      requestId: 'legacy-failed',
      idempotencyKey: 'legacy-failed',
      toolName: 'scheduler_task_handler',
      targetIdentity: scheduledTaskId,
      inputDigest: 'failed',
      envelope: '{}',
      outcome: 'failed',
      createdAt: '2026-08-07T00:04:00.000Z',
    });

    expect(compactLegacyScheduledCapabilityExecutions(db)).toEqual({
      tasksRemoved: 3,
      receiptsRemoved: 3,
      summariesUpdated: 1,
    });
    expect(db.conversationActionTasks.some((task: any) => task.id === 'legacy-failed')).toBe(true);
    expect(db.conversationActionReceipts).toEqual([
      expect.objectContaining({ id: 'receipt-legacy-failed', outcome: 'failed' }),
    ]);
    const summary = db.conversationActionTasks.find((task: any) => task.target === scheduledTaskId && task.id !== 'legacy-failed');
    expect(JSON.parse(summary.context).schedulerAudit).toMatchObject({
      totalExecutions: 3,
      completedCount: 3,
      compactedReceiptCount: 3,
      receiptOutcomeCounts: { verified_success: 3 },
    });
  });

  it('plans and persists before invoking a handler and requires policy on every built-in task', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'scheduler.ts'), 'utf8');
    const runStart = source.indexOf('private async runTask');
    const runEnd = source.indexOf('private async executeTaskHandler', runStart);
    const run = source.slice(runStart, runEnd);
    expect(run.indexOf('buildScheduledTaskExecutionPlan(task, startedAt)'))
      .toBeLessThan(run.indexOf('await this.executeTaskHandler(task, plan, execution)'));
    expect(run.indexOf("status: authorization.allowed ? 'executing' : 'blocked'"))
      .toBeLessThan(run.indexOf('await this.executeTaskHandler(task, plan, execution)'));
    expect(run).toContain("authorizeCapabilityPlanTool(plan, 'scheduler_task_handler')");
    expect(run).toContain("previousStatus === 'executing'");
    expect(run).toContain("const compactAudit = task.auditMode !== 'full'");
    expect(run).toContain('compactAudit,');
    expect(run).toContain('automatic replay for this slot is disabled');
    expect(run).toContain('durability');
    expect(run.indexOf("lastStatus: 'completed'"))
      .toBeLessThan(run.indexOf('this.persistDbWithRuntimeState(completedDb, completedTask, userDeliveryDeclared, execution)'));
    expect(run.indexOf('this.persistDbWithRuntimeState(completedDb, completedTask, userDeliveryDeclared, execution)'))
      .toBeLessThan(run.indexOf('task.lastStatus = completedTask.lastStatus'));

    const registrations = source.match(/scheduler\.register\(\{/g) || [];
    const declarations = source.match(/executionClass:\s*'(?:maintenance|proactive_delivery|client_probe|autonomous_orchestration)'/g) || [];
    expect(registrations).toHaveLength(28);
    expect(declarations).toHaveLength(registrations.length);
  });
});
