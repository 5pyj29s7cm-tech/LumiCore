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
import { extractSourceExpression } from './source_expression';

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
  it.each([
    ['weekly', 'every_7d', 7, 400, 10, 0.95, 'week_2026-10-02'],
    ['monthly', '1 0 1 * *', 30, 600, 15, 0.97, 'month_2026-10'],
    ['yearly', '0 0 1 1 *', 365, 800, 20, 1, 'year_2026'],
  ] as const)('keeps %s review scope, budgets, metadata and per-user failure isolation', async (depth, cron, days, maxTokens, topicLimit, importance, keyword) => {
    const now = Date.parse('2026-10-02T10:00:00Z'), cutoff = now - days * 86400000;
    class Clock extends Date { constructor(value: any = now) { super(value); } static now() { return now; } }
    const tasks: any[] = [], prompts: any[] = [], calls: any[] = [], saved: any[] = [];
    const rows = [{}, { createdAt: new Date(cutoff - 1).toISOString(), type: 'preference' }, { domain: 'work' }, { orgId: 'organization' }, { userId: 'other' }, { avatarId: 'private' }]
      .map(override => ({ userId: 'owner', createdAt: new Date(cutoff).toISOString(), type: 'fact', keywords: Array.from({ length: 25 }, (_, i) => `topic-${i}`), ...override }));
    const getters = Array.from({ length: 12 }, () => () => null);
    const register = extractSourceExpression('server/scheduler.ts', 'registerScheduledTasks', {
      scheduler: { register: (task: any) => tasks.push(task) }, createReminderCheckTask: () => ({ id: 'reminder-fixture' }), Date: Clock,
      resolveScheduledUserIds: () => ['failed', 'owner', 'no-config', 'empty'],
      readDB: () => ({ memories: rows, interactions: rows.map(row => ({ ...row, timestamp: row.createdAt })), conversations: [{ userId: 'owner', status: 'active' }, { userId: 'owner', domain: 'work', status: 'active' }] }),
      personalityRegistry: { getForUser: (_: string, uid: string) => uid === 'no-config' ? null : { name: uid, version: '3' }, getEvolutionHistory: () => [{ timestamp: new Date(cutoff).toISOString() }, { timestamp: new Date(cutoff - 1).toISOString() }] },
      isMemoryAvatarScoped: (row: any) => Boolean(row.avatarId), loadEmotionalState: () => ({ connection: 0.8 }),
      generateReviewPrompt: (context: any) => { prompts.push(context); return context.personalityName; },
      getUserPreferredLLMConfig: (userId: string, options: any) => ({ userId, ...options }),
      makeLLMCall: async (_messages: any, _tools: any, config: any, ...actualGetters: any[]) => {
        expect(actualGetters).toEqual(getters); calls.push(config);
        if (config.userId === 'failed') throw new Error('synthetic provider failure');
        return { text: config.userId === 'empty' ? '   ' : '  Review narrative.  ' };
      },
      require: (name: string) => { expect(name).toBe('./memory'); return { addMemory: (...args: any[]) => saved.push(args) }; },
      console: { log: () => {}, error: () => {} }, redactSchedulerDiagnostic: String,
    });
    register(...getters);
    const task = tasks.find(candidate => candidate.id === `${depth}_review`);
    expect(task).toMatchObject({ cron, quiet: true, lastRun: null, executionClass: 'maintenance' });
    expect(await task.handler()).toBe('[owner] Review narrative.');
    expect(calls.map(call => call.userId)).toEqual(['failed', 'owner', 'empty']);
    expect(calls.every(call => call.maxTokens === maxTokens && call.domain === 'personal' && call.orgId === '' && call.source === `scheduler_${depth}_review`)).toBe(true);
    expect(prompts.find(context => context.personalityName === 'owner')).toMatchObject({ depth, newMemoryCount: 1, newInteractionCount: 2, totalFacts: 1, totalPreferences: 1, activeConversations: 1, topMemoryTopics: rows[0].keywords.slice(0, topicLimit), evolutionSteps: [{ timestamp: new Date(cutoff).toISOString() }] });
    expect(saved).toEqual([[expect.objectContaining({ userId: 'owner', type: 'knowledge', content: `[${depth[0].toUpperCase() + depth.slice(1)} Review 2026-10-02] Review narrative.`, keywords: [`${depth}_review`, keyword], sourceInteractionId: `${depth}_review_scheduler` }),
      { tier: 'growth', perspective: 'lumi_self', importance, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' }]]);
  });

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
    const runStart = source.indexOf('private async runAdmittedTask');
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

    const registrations = source.match(/scheduler\.register\((?:\{|createReminderCheckTask\(\))/g) || [];
    const declarations = source.match(/executionClass:\s*'(?:maintenance|proactive_delivery|client_probe|autonomous_orchestration)'/g) || [];
    expect(registrations.length).toBeGreaterThan(0);
    expect(declarations).toHaveLength(registrations.length);
  });
});
