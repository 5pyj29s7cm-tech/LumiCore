import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildScheduledExecutionId,
  buildScheduledProactiveInteractionId,
  buildScheduledTaskExecutionPlan,
} from '../server/scheduler';
import { persistScheduledCapabilityExecution } from '../server/conversation/action_ledger';
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

  it('plans and persists before invoking a handler and requires policy on every built-in task', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'scheduler.ts'), 'utf8');
    const runStart = source.indexOf('private async runTask');
    const runEnd = source.indexOf('private buildScheduledTaskRecord', runStart);
    const run = source.slice(runStart, runEnd);
    expect(run.indexOf('buildScheduledTaskExecutionPlan(task, startedAt)'))
      .toBeLessThan(run.indexOf('await task.handler()'));
    expect(run.indexOf("status: authorization.allowed ? 'executing' : 'blocked'"))
      .toBeLessThan(run.indexOf('await task.handler()'));
    expect(run).toContain("authorizeCapabilityPlanTool(plan, 'scheduler_task_handler')");
    expect(run).toContain("previous.status === 'executing'");
    expect(run).toContain('automatic replay for this slot is disabled');

    const registrations = source.match(/scheduler\.register\(\{/g) || [];
    const declarations = source.match(/executionClass:\s*'(?:maintenance|proactive_delivery|client_probe|autonomous_orchestration)'/g) || [];
    expect(registrations).toHaveLength(27);
    expect(declarations).toHaveLength(registrations.length);
  });
});
