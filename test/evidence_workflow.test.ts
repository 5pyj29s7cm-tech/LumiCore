import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  createEvidenceWorkflow,
  getEvidenceWorkflowCompletion,
  getNextEvidenceWorkflowStep,
  normalizeEvidenceWorkflow,
  promoteEvidenceWorkflowStages,
  transitionEvidenceWorkflowStep,
  type EvidenceWorkflowStepBlueprint,
} from '../shared/evidence_workflow';
import { createWorkTakeoverTask, getWorkTakeoverTask } from '../server/work_takeover/tasks';
import {
  getTaskEvidenceWorkflow,
  recoverTaskEvidenceWorkflow,
  startTaskEvidenceWorkflow,
  transitionTaskEvidenceWorkflowStep,
} from '../server/work_takeover/evidence_workflow';

const blueprints: EvidenceWorkflowStepBlueprint[] = [
  {
    id: 'source-preflight',
    label: 'Source preflight',
    stage: 'quick',
    order: 0,
    executionMode: 'automatic',
    tool: 'source_status',
    targetIdentity: 'synthetic-source',
    requiredEvidence: ['source configuration receipt'],
  },
  {
    id: 'quick-scan',
    label: 'Quick scan',
    stage: 'quick',
    order: 1,
    executionMode: 'automatic',
    tool: 'source_scan',
    targetIdentity: 'synthetic-source',
    requiredEvidence: ['query receipt'],
  },
  {
    id: 'manual-review',
    label: 'Human review',
    stage: 'deep',
    order: 2,
    executionMode: 'manual',
    verificationRequired: false,
  },
];

function seedVerifiedReceipt(input: {
  userId: string;
  takeoverTaskId: string;
  targetIdentity?: string;
  domain?: string;
  orgId?: string;
  toolName: string;
  receiptId: string;
  createdAt: string;
}): void {
  const db = readDB();
  if (!Array.isArray(db.conversationActionTasks)) db.conversationActionTasks = [];
  if (!Array.isArray(db.conversationActionReceipts)) db.conversationActionReceipts = [];
  const actionTaskId = `action-${input.receiptId}`;
  db.conversationActionTasks.push({
    id: actionTaskId,
    conversationId: `conversation-${input.receiptId}`,
    userId: input.userId,
    domain: input.domain || 'personal',
    orgId: input.orgId || '',
    status: 'completed',
    context: { taskId: input.takeoverTaskId },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  db.conversationActionReceipts.push({
    id: input.receiptId,
    taskId: actionTaskId,
    conversationId: `conversation-${input.receiptId}`,
    turnId: `turn-${input.receiptId}`,
    requestId: `request-${input.receiptId}`,
    idempotencyKey: `idempotency-${input.receiptId}`,
    toolName: input.toolName,
    targetIdentity: input.targetIdentity || 'synthetic-source',
    inputDigest: '',
    envelope: JSON.stringify({
      version: 1,
      status: 'verified_success',
      taskId: actionTaskId,
      turnId: `turn-${input.receiptId}`,
      requestId: `request-${input.receiptId}`,
      idempotencyKey: `idempotency-${input.receiptId}`,
      targetIdentity: input.targetIdentity || 'synthetic-source',
      completedAt: input.createdAt,
      verification: { status: 'verified', basis: 'terminal_verification' },
      toolName: input.toolName,
    }),
    outcome: 'verified_success',
    createdAt: input.createdAt,
  });
  writeDB(db);
}

describe('generic evidence workflow', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('runs a verified quick workflow and can expand into a deeper stage', () => {
    let workflow = createEvidenceWorkflow({
      id: 'workflow-1',
      definitionId: 'source-investigation',
      taskId: 'task-1',
      blueprints,
      stagesInScope: ['quick'],
      now: '2026-08-09T00:00:00.000Z',
    });
    expect(getNextEvidenceWorkflowStep(workflow)?.id).toBe('source-preflight');
    expect(workflow.steps.find(step => step.id === 'source-preflight')?.verificationRequired).toBe(true);

    workflow = transitionEvidenceWorkflowStep(workflow, 'source-preflight', { status: 'running' });
    workflow = transitionEvidenceWorkflowStep(workflow, 'source-preflight', {
      status: 'completed',
      verificationStatus: 'verified',
      receiptIds: ['receipt-source'],
      outputSummary: 'Source is configured.',
    });
    workflow = transitionEvidenceWorkflowStep(workflow, 'quick-scan', { status: 'running' });
    workflow = transitionEvidenceWorkflowStep(workflow, 'quick-scan', {
      status: 'completed',
      verificationStatus: 'verified',
      receiptIds: ['receipt-scan'],
      outputSummary: 'Scan returned evidence.',
    });

    expect(workflow.status).toBe('completed');
    expect(getEvidenceWorkflowCompletion(workflow)).toEqual({ done: 2, total: 2, percent: 100, verified: 2 });
    workflow = promoteEvidenceWorkflowStages(workflow, ['deep']);
    expect(workflow.status).toBe('ready');
    expect(getNextEvidenceWorkflowStep(workflow)?.id).toBe('manual-review');
  });

  it('refuses to claim completion without a verified receipt', () => {
    let workflow = createEvidenceWorkflow({
      definitionId: 'receipt-guard',
      taskId: 'task-2',
      blueprints,
      stagesInScope: ['quick'],
    });
    workflow = transitionEvidenceWorkflowStep(workflow, 'source-preflight', { status: 'running' });
    expect(() => transitionEvidenceWorkflowStep(workflow, 'source-preflight', {
      status: 'completed',
      outputSummary: 'Model says it finished.',
    })).toThrow(/verified receipt/i);
  });

  it('recovers interrupted work and downgrades unverified persisted completion', () => {
    let workflow = createEvidenceWorkflow({
      definitionId: 'restart-safe',
      taskId: 'task-3',
      blueprints,
      stagesInScope: ['quick'],
    });
    workflow = transitionEvidenceWorkflowStep(workflow, 'source-preflight', { status: 'running' });
    const persisted = JSON.parse(JSON.stringify(workflow));
    persisted.steps[1].status = 'completed';
    persisted.steps[1].verificationStatus = 'pending';
    persisted.steps[1].receiptIds = [];

    const restored = normalizeEvidenceWorkflow(persisted, blueprints);
    expect(restored?.steps.find(step => step.id === 'source-preflight')).toMatchObject({ status: 'pending' });
    expect(restored?.steps.find(step => step.id === 'quick-scan')).toMatchObject({
      status: 'failed',
      blocker: expect.stringMatching(/lacked a verified receipt/i),
    });
    expect(restored?.status).toBe('blocked');
  });

  it('persists evidence progress inside the existing work takeover task ledger', () => {
    const userId = `evidence-user-${Date.now()}-${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: 'Reusable evidence investigation',
      summary: 'Collect and verify source evidence.',
    });
    const started = startTaskEvidenceWorkflow({
      userId,
      taskId: task.id,
      definitionId: 'generic-evidence-investigation',
      blueprints,
      stagesInScope: ['quick'],
    });
    expect(started.task.status).toBe('in_progress');
    expect(getTaskEvidenceWorkflow(started.task)?.taskId).toBe(task.id);
    const receiptId = `receipt-persisted-${Date.now()}`;
    seedVerifiedReceipt({
      userId,
      takeoverTaskId: task.id,
      toolName: 'source_status',
      receiptId,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    transitionTaskEvidenceWorkflowStep({
      userId,
      taskId: task.id,
      stepId: 'source-preflight',
      status: 'running',
    });
    transitionTaskEvidenceWorkflowStep({
      userId,
      taskId: task.id,
      stepId: 'source-preflight',
      status: 'completed',
      receiptIds: [receiptId],
      outputSummary: 'Verified source capability.',
    });

    const persisted = getWorkTakeoverTask(userId, task.id);
    expect(persisted).toBeTruthy();
    expect(getTaskEvidenceWorkflow(persisted!)?.steps.find(step => step.id === 'source-preflight')).toMatchObject({
      status: 'completed',
      verificationStatus: 'verified',
      receiptIds: [receiptId],
    });
  });

  it('rejects invented receipts and refuses to reopen terminal tasks', () => {
    const userId = `evidence-guard-user-${Date.now()}-${Math.random()}`;
    const activeTask = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: 'Receipt validation task',
    });
    startTaskEvidenceWorkflow({
      userId,
      taskId: activeTask.id,
      definitionId: 'receipt-validation',
      blueprints,
      stagesInScope: ['quick'],
    });
    transitionTaskEvidenceWorkflowStep({
      userId,
      taskId: activeTask.id,
      stepId: 'source-preflight',
      status: 'running',
    });
    expect(() => transitionTaskEvidenceWorkflowStep({
      userId,
      taskId: activeTask.id,
      stepId: 'source-preflight',
      status: 'completed',
      receiptIds: ['invented-receipt'],
    })).toThrow(/rejected unverified or out-of-scope receipt/i);

    const deliveredTask = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: 'Already delivered task',
      status: 'delivered',
    });
    expect(() => startTaskEvidenceWorkflow({
      userId,
      taskId: deliveredTask.id,
      definitionId: 'terminal-guard',
      blueprints,
    })).toThrow(/cannot modify terminal task/i);
  });

  it('downgrades a persisted completion when its action receipt disappears before recovery', () => {
    const userId = `evidence-recovery-user-${Date.now()}-${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: 'Recovery receipt audit',
    });
    startTaskEvidenceWorkflow({
      userId,
      taskId: task.id,
      definitionId: 'recovery-receipt-audit',
      blueprints,
      stagesInScope: ['quick'],
    });
    const receiptId = `receipt-recovery-${Date.now()}`;
    seedVerifiedReceipt({
      userId,
      takeoverTaskId: task.id,
      toolName: 'source_status',
      receiptId,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    transitionTaskEvidenceWorkflowStep({
      userId,
      taskId: task.id,
      stepId: 'source-preflight',
      status: 'running',
    });
    transitionTaskEvidenceWorkflowStep({
      userId,
      taskId: task.id,
      stepId: 'source-preflight',
      status: 'completed',
      receiptIds: [receiptId],
    });

    const db = readDB();
    db.conversationActionReceipts = db.conversationActionReceipts.filter((receipt: any) => receipt.id !== receiptId);
    writeDB(db);

    const recovered = recoverTaskEvidenceWorkflow({ userId, taskId: task.id, blueprints });
    expect(recovered.workflow.steps.find(step => step.id === 'source-preflight')).toMatchObject({
      status: 'failed',
      verificationStatus: 'rejected',
      receiptIds: [],
    });
    expect(recovered.workflow.status).toBe('blocked');
  });

  it('rejects another task, a different target within this task, and missing target declarations', () => {
    const userId = `evidence-binding-${Date.now()}`;
    const task = createWorkTakeoverTask({ userId, category: 'general_work', title: 'Exact target' });
    startTaskEvidenceWorkflow({ userId, taskId: task.id, definitionId: 'target', blueprints });
    transitionTaskEvidenceWorkflowStep({ userId, taskId: task.id, stepId: 'source-preflight', status: 'running' });
    for (const [receiptId, takeoverTaskId, targetIdentity] of [
      ['wrong-task', 'another-takeover', 'synthetic-source'],
      ['wrong-target', task.id, 'another-source'],
    ]) {
      seedVerifiedReceipt({ userId, takeoverTaskId, targetIdentity, toolName: 'source_status', receiptId, createdAt: new Date(Date.now() + 1000).toISOString() });
      expect(() => transitionTaskEvidenceWorkflowStep({ userId, taskId: task.id, stepId: 'source-preflight', status: 'completed', receiptIds: [receiptId] })).toThrow(/out-of-scope/);
    }
    const noTarget = createWorkTakeoverTask({ userId, category: 'general_work', title: 'Undeclared target' });
    startTaskEvidenceWorkflow({ userId, taskId: noTarget.id, definitionId: 'legacy', blueprints: blueprints.map(step => ({ ...step, targetIdentity: undefined })) });
    transitionTaskEvidenceWorkflowStep({ userId, taskId: noTarget.id, stepId: 'source-preflight', status: 'running' });
    seedVerifiedReceipt({ userId, takeoverTaskId: noTarget.id, toolName: 'source_status', receiptId: 'undeclared', createdAt: new Date(Date.now() + 1000).toISOString() });
    expect(() => transitionTaskEvidenceWorkflowStep({ userId, taskId: noTarget.id, stepId: 'source-preflight', status: 'completed', receiptIds: ['undeclared'] })).toThrow(/out-of-scope/);
  });
});
