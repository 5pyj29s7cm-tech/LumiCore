import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceEvidenceSnapshot,
  buildCapabilityAcceptanceProjections,
  buildForegroundTaskCompletionFeedback,
  buildPublicAcceptanceSummary,
  buildTaskCompletionFeedback,
  buildTaskAcceptanceProjections,
  buildTaskTerminalReceipt,
  evaluateRuntimeAcceptanceSubsystems,
  validateCompletionTerminalReceipt,
} from '../server/cognition/acceptance_evidence';
import type { ToolExecutionRecord } from '../server/tools/types';

function manifest(toolName: string, overrides: Record<string, unknown> = {}) {
  return {
    toolName,
    capabilityId: `test.${toolName}`,
    source: 'builtin',
    provider: '',
    executable: true,
    deprecated: false,
    ...overrides,
  } as any;
}

function terminalToolRecord(id = 'receipt-1'): ToolExecutionRecord {
  return {
    id,
    name: 'controlled_probe',
    arguments: {},
    result: JSON.stringify({ ok: true, status: 'verified' }),
    terminalVerification: {
      status: 'verified',
      strategy: 'terminal_receipt',
      reason: 'Controlled probe verified.',
    },
  };
}

function actionReceipt(
  toolName: string,
  outcome: string,
  verification: string,
  createdAt: string,
  basis: 'terminal_verification' | 'compatibility_inference' | null = 'terminal_verification',
  taskId = 'conversation-task',
) {
  const turnId = `turn:${taskId}`;
  const requestId = `request:${taskId}`;
  const idempotencyKey = `${taskId}:${toolName}`;
  return {
    id: `${toolName}:${createdAt}`,
    taskId,
    turnId,
    requestId,
    idempotencyKey,
    toolName,
    targetIdentity: '',
    outcome,
    envelope: JSON.stringify({
      version: 1,
      status: outcome,
      toolName,
      taskId,
      turnId,
      requestId,
      idempotencyKey,
      targetIdentity: '',
      completedAt: createdAt,
      verification: { status: verification, ...(basis ? { basis } : {}) },
    }),
    createdAt,
  };
}

describe('unified acceptance and evidence state', () => {
  it('lists only successful verified tools as completion evidence', () => {
    const receipt = buildTaskTerminalReceipt({
      taskId: 'mixed-tool-outcome',
      runtime: 'conversation',
      outcome: 'completed',
      toolRecords: [{
        id: 'failed-core-tool',
        name: 'runtime_work_cancel',
        arguments: {},
        result: '',
        error: 'Cancellation failed.',
        terminalVerification: {
          status: 'failed',
          strategy: 'terminal_receipt',
          reason: 'Cancellation failed.',
        },
      }, terminalToolRecord('verified-observation')],
    });
    const feedback = buildTaskCompletionFeedback(receipt, 'Mixed tool task');

    expect(receipt.toolNames).toEqual(['controlled_probe']);
    expect(feedback.evidence).toEqual(['Verified tool receipts: controlled_probe']);
    expect(feedback.evidence.join(' ')).not.toContain('runtime_work_cancel');
  });

  it('accepts an explicitly verified receipt-only tool record as terminal evidence', () => {
    const receipt = buildTaskTerminalReceipt({
      taskId: 'receipt-only-task',
      runtime: 'conversation',
      outcome: 'completed',
      toolRecords: [{
        id: 'receipt-only-tool',
        name: 'runtime_work_status',
        arguments: {},
        result: '',
        receipt: JSON.stringify(JSON.stringify({ ok: true, status: 'idle', activeCount: 0 })),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The runtime ledger was read.',
        },
      }],
    });

    expect(receipt).toMatchObject({
      verification: 'verified',
      toolNames: ['runtime_work_status'],
    });
  });

  it('does not report task cancellation complete from unrelated verified reads', () => {
    const feedback = buildForegroundTaskCompletionFeedback({
      taskId: 'failed-cleanup-task',
      taskLabel: '\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1',
      toolRecords: [{
        id: 'cancel-failed',
        name: 'runtime_work_cancel',
        arguments: {},
        result: '',
        error: 'Cancellation failed.',
        terminalVerification: {
          status: 'failed',
          strategy: 'terminal_receipt',
          reason: 'Cancellation failed.',
        },
      }, {
        id: 'directory-read-succeeded',
        name: 'list_directory',
        arguments: { path: '.' },
        result: JSON.stringify({ ok: true, entries: ['entry.cjs'] }),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Directory listing returned.',
        },
      }],
    });

    expect(feedback).toMatchObject({
      status: 'blocked',
      completed: [],
    });
    expect(feedback?.evidence.join(' ')).not.toContain('Verified tool receipts');
  });
  it('separates registered, available, exercised, and verified capability states', () => {
    const states = buildCapabilityAcceptanceProjections({
      manifest: [
        manifest('registered-only', { executable: false }),
        manifest('available-only'),
        manifest('exercised-only'),
        manifest('verified-tool'),
        manifest('legacy-inferred'),
        manifest('metric-only'),
        manifest('mcp-offline', { source: 'mcp', provider: 'offline-server' }),
      ],
      actionReceipts: [
        actionReceipt('exercised-only', 'failed', 'failed', '2026-08-23T00:00:00.000Z'),
        actionReceipt('verified-tool', 'verified_success', 'verified', '2026-08-23T00:00:01.000Z'),
        actionReceipt('legacy-inferred', 'verified_success', 'verified', '2026-08-23T00:00:02.000Z', null),
      ],
      toolMetrics: {
        'metric-only': { calls: 3, outcomes: { verified_success: 3 } },
      },
      mcpHealth: { 'offline-server': { status: 'disconnected' } },
    });

    expect(Object.fromEntries(states.map(state => [state.toolName, state.stage]))).toEqual({
      'available-only': 'available',
      'exercised-only': 'exercised',
      'legacy-inferred': 'exercised',
      'metric-only': 'exercised',
      'mcp-offline': 'registered',
      'registered-only': 'registered',
      'verified-tool': 'verified',
    });
    expect(states.find(state => state.toolName === 'mcp-offline')).toMatchObject({
      availability: 'unavailable',
      availabilityBasis: 'mcp_disconnected',
    });
    expect(states.find(state => state.toolName === 'legacy-inferred')).toMatchObject({
      exercised: true,
      verified: false,
      verifiedCount: 0,
    });
    expect(states.find(state => state.toolName === 'metric-only')).toMatchObject({
      exerciseCount: 3,
      verified: false,
      verifiedCount: 0,
    });
  });

  it('does not promote a capability from a self-declared verification object with a mismatched durable envelope', () => {
    const forged = actionReceipt(
      'forged-capability',
      'verified_success',
      'verified',
      '2026-08-23T00:00:03.000Z',
    );
    const mismatchedEnvelope = JSON.parse(forged.envelope);
    mismatchedEnvelope.toolName = 'different-tool';
    const states = buildCapabilityAcceptanceProjections({
      manifest: [manifest('forged-capability')],
      actionReceipts: [
        { ...forged, envelope: JSON.stringify(mismatchedEnvelope) },
        {
          id: 'status-only-forgery',
          taskId: 'status-only-task',
          turnId: 'status-only-turn',
          requestId: 'status-only-request',
          idempotencyKey: 'status-only-key',
          toolName: 'forged-capability',
          targetIdentity: '',
          outcome: 'verified_success',
          envelope: JSON.stringify({
            verification: { status: 'verified', basis: 'terminal_verification' },
          }),
          createdAt: '2026-08-23T00:00:04.000Z',
        },
      ],
    });

    expect(states[0]).toMatchObject({
      exercised: true,
      verified: false,
      verifiedCount: 0,
      stage: 'exercised',
    });
  });

  it('reports zero knowledge-quality samples as not exercised, never healthy', () => {
    const zero = evaluateRuntimeAcceptanceSubsystems({
      knowledge: {
        evaluations: 0,
        verified: 0,
        unverified: 0,
        expectedItems: 0,
        citationChecks: 0,
        aggregateRecallAt5: null,
        aggregateCitationAccuracy: null,
      },
    });
    expect(zero.knowledgeQuality).toMatchObject({
      status: 'not_exercised',
      diagnosticCode: 'no_current_process_knowledge_quality_sample',
      recallAt5: { status: 'unknown', value: null, sampleSize: 0 },
      citationAccuracy: { status: 'unknown', value: null, sampleSize: 0 },
    });

    const measuredZero = evaluateRuntimeAcceptanceSubsystems({
      knowledge: {
        evaluations: 1,
        verified: 1,
        unverified: 0,
        expectedItems: 2,
        citationChecks: 2,
        aggregateRecallAt5: 0,
        aggregateCitationAccuracy: 0,
      },
    });
    expect(measuredZero.knowledgeQuality.status).toBe('verified');
    expect(measuredZero.knowledgeQuality.recallAt5).toMatchObject({ status: 'measured', value: 0 });
    expect(measuredZero.knowledgeQuality.citationAccuracy).toMatchObject({ status: 'measured', value: 0 });
  });

  it('accepts conversation completion only from explicitly terminal-verified receipt envelopes', () => {
    const conversationTask = (id: string) => ({
      id,
      conversationId: 'conversation-1',
      userId: 'owner',
      goal: 'Run the controlled action',
      status: 'completed',
      context: '{}',
      updatedAt: '2026-08-23T00:00:01.000Z',
    });
    const explicit = {
      ...actionReceipt('controlled_probe', 'verified_success', 'verified', '2026-08-23T00:00:01.000Z', 'terminal_verification', 'conversation-explicit'),
      id: 'explicit-receipt',
    };
    const inferred = {
      ...actionReceipt('controlled_probe', 'verified_success', 'verified', '2026-08-23T00:00:02.000Z', 'compatibility_inference', 'conversation-inferred'),
      id: 'inferred-receipt',
    };
    const projections = buildTaskAcceptanceProjections({
      conversationActionTasks: [
        conversationTask('conversation-explicit'),
        conversationTask('conversation-inferred'),
      ],
      conversationActionReceipts: [explicit, inferred],
    });

    expect(projections.find(task => task.taskId === 'conversation-explicit')).toMatchObject({
      accepted: true,
      terminalVerification: 'verified',
      diagnosticCode: 'accepted',
    });
    expect(projections.find(task => task.taskId === 'conversation-inferred')).toMatchObject({
      accepted: false,
      terminalVerification: 'unverified',
      diagnosticCode: 'completed_with_unverified_terminal_receipt',
    });
  });

  it('rejects conversation receipts when any durable execution identity or status disagrees with the envelope', () => {
    const conversationTask = (id: string) => ({
      id,
      conversationId: 'conversation-1',
      userId: 'owner',
      goal: 'Run the controlled action',
      status: 'completed',
      context: '{}',
      updatedAt: '2026-08-23T00:00:10.000Z',
    });
    const mismatchCases = [
      ['task', (envelope: any) => { envelope.taskId = 'different-task'; }],
      ['turn', (envelope: any) => { envelope.turnId = 'different-turn'; }],
      ['request', (envelope: any) => { envelope.requestId = 'different-request'; }],
      ['tool', (envelope: any) => { envelope.toolName = 'different-tool'; }],
      ['outcome', (envelope: any) => { envelope.status = 'failed'; }],
      ['idempotency', (envelope: any) => { envelope.idempotencyKey = 'different-key'; }],
      ['target', (envelope: any) => { envelope.targetIdentity = 'different-target'; }],
    ] as const;
    const tasks: any[] = [];
    const receipts = mismatchCases.map(([suffix, mutate], index) => {
      const taskId = `conversation-mismatch-${suffix}`;
      tasks.push(conversationTask(taskId));
      const receipt = actionReceipt(
        'controlled_probe',
        'verified_success',
        'verified',
        `2026-08-23T00:00:${String(index + 10).padStart(2, '0')}.000Z`,
        'terminal_verification',
        taskId,
      );
      const envelope = JSON.parse(receipt.envelope);
      mutate(envelope);
      return { ...receipt, envelope: JSON.stringify(envelope) };
    });

    const projections = buildTaskAcceptanceProjections({
      conversationActionTasks: tasks,
      conversationActionReceipts: receipts,
    });
    expect(projections).toHaveLength(mismatchCases.length);
    expect(projections.every(task => (
      task.accepted === false
      && task.terminalVerification === 'unverified'
      && task.diagnosticCode === 'completed_with_unverified_terminal_receipt'
    ))).toBe(true);
  });

  it('requires task-bound machine evidence for a completion receipt', () => {
    const receipt = buildTaskTerminalReceipt({
      taskId: 'task-accepted',
      runtime: 'autonomous',
      outcome: 'completed',
      toolRecords: [terminalToolRecord()],
    });
    expect(validateCompletionTerminalReceipt(receipt, {
      taskId: 'task-accepted',
      runtime: 'autonomous',
    })).toMatchObject({ accepted: true });
    expect(receipt).toMatchObject({ schemaVersion: 3 });
    expect(receipt.signature).toMatch(/^[a-f0-9]{64}$/);

    const tampered = {
      ...receipt,
      evidenceRefs: ['tool:invented-after-signing'],
    };
    expect(validateCompletionTerminalReceipt(tampered, {
      taskId: 'task-accepted',
      runtime: 'autonomous',
    })).toMatchObject({
      accepted: false,
      diagnosticCode: 'terminal_receipt_integrity_invalid',
    });
    expect(buildTaskCompletionFeedback(tampered, 'Tampered task').status).not.toBe('completed');

    const withForgedField = {
      ...receipt,
      modelClaimedSuccess: true,
    } as any;
    expect(validateCompletionTerminalReceipt(withForgedField, {
      taskId: 'task-accepted',
      runtime: 'autonomous',
    })).toMatchObject({
      accepted: false,
      diagnosticCode: 'terminal_receipt_integrity_invalid',
    });

    const legacyUnsigned = {
      ...receipt,
      schemaVersion: 1,
    } as any;
    delete legacyUnsigned.signature;
    expect(validateCompletionTerminalReceipt(legacyUnsigned, {
      taskId: 'task-accepted',
      runtime: 'autonomous',
    })).toMatchObject({
      accepted: false,
      diagnosticCode: 'terminal_receipt_integrity_invalid',
    });
    expect(validateCompletionTerminalReceipt(receipt, {
      taskId: 'different-task',
      runtime: 'autonomous',
    })).toMatchObject({ accepted: false, diagnosticCode: 'terminal_receipt_identity_mismatch' });

    const proseOnly = buildTaskTerminalReceipt({
      taskId: 'task-prose-only',
      runtime: 'autonomous',
      outcome: 'completed',
      reason: 'The model said it was done.',
    });
    expect(validateCompletionTerminalReceipt(proseOnly, {
      taskId: 'task-prose-only',
      runtime: 'autonomous',
    })).toMatchObject({ accepted: false, diagnosticCode: 'missing_verified_terminal_evidence' });

    const observedOnly = buildTaskTerminalReceipt({
      taskId: 'task-observed-only',
      runtime: 'autonomous',
      outcome: 'completed',
      toolRecords: [{
        id: 'unverified-receipt',
        name: 'controlled_probe',
        arguments: {},
        result: JSON.stringify({ ok: true }),
      }],
    });
    expect(validateCompletionTerminalReceipt(observedOnly, {
      taskId: 'task-observed-only',
      runtime: 'autonomous',
    })).toMatchObject({
      accepted: false,
      reason: '1 terminal tool execution(s) lacked verified terminal evidence.',
    });
    expect(buildTaskCompletionFeedback(observedOnly, 'Observed task').evidence).toEqual([
      'Observed terminal tool receipts: controlled_probe',
    ]);
  });

  it('projects durable continuity and explicit completion feedback without raw payloads', () => {
    const acceptedReceipt = buildTaskTerminalReceipt({
      taskId: 'autonomy-accepted',
      runtime: 'autonomous',
      outcome: 'completed',
      toolRecords: [terminalToolRecord('safe-evidence-id')],
    });
    const blockedReceipt = buildTaskTerminalReceipt({
      taskId: 'autonomy-blocked',
      runtime: 'autonomous',
      outcome: 'blocked',
      reasonCode: 'runtime_dependency_unavailable',
      reason: 'The controlled runtime is unavailable.',
      evidenceRefs: ['prior-safe-receipt'],
    });
    const db = {
      conversationActionTasks: [],
      conversationActionReceipts: [],
      autonomousTasks: [
        {
          id: 'autonomy-accepted',
          userId: 'owner',
          title: 'Accepted task',
          description: 'Preserved goal',
          status: 'completed',
          domain: 'personal',
          executionPlan: { planId: 'action-plan-1' },
          checkpoint: { receiptIds: ['safe-evidence-id'] },
          terminalReceipt: acceptedReceipt,
          updatedAt: '2026-08-23T00:00:02.000Z',
        },
        {
          id: 'legacy-complete',
          userId: 'owner',
          title: 'Legacy task',
          description: 'Legacy goal',
          status: 'completed',
          domain: 'personal',
          updatedAt: '2026-08-23T00:00:01.000Z',
        },
        {
          id: 'autonomy-blocked',
          userId: 'owner',
          title: 'Blocked task',
          description: 'Preserved autonomous goal',
          status: 'blocked',
          domain: 'personal',
          executionPlan: { planId: 'plan-1' },
          checkpoint: { receiptIds: ['prior-safe-receipt'] },
          terminalReceipt: blockedReceipt,
          error: 'The controlled runtime is unavailable.',
          updatedAt: '2026-08-23T00:00:03.000Z',
        },
      ],
    };
    const snapshot = buildAcceptanceEvidenceSnapshot({
      db,
      manifest: [manifest('safe-tool')],
      capabilityMetrics: {},
      scope: { userId: 'owner', domain: 'personal' },
    });
    const accepted = snapshot.tasks.find(task => task.taskId === 'autonomy-accepted');
    expect(accepted).toMatchObject({
      accepted: true,
      terminalReceiptPresent: true,
      continuity: {
        goalPreserved: true,
        planPreserved: true,
        receiptLedgerPreserved: true,
        blockerPreserved: true,
      },
      completionFeedback: { status: 'completed', blockers: [], incomplete: [] },
    });
    expect(snapshot.tasks.find(task => task.taskId === 'legacy-complete')).toMatchObject({
      accepted: false,
      terminalReceiptPresent: false,
      diagnosticCode: 'completed_without_terminal_receipt',
    });
    const blocked = snapshot.tasks.find(task => task.taskId === 'autonomy-blocked');
    expect(blocked?.completionFeedback).toMatchObject({
      status: 'blocked',
      completed: [],
      blockers: ['The controlled runtime is unavailable.'],
    });
    expect(blocked?.completionFeedback.nextSteps[0]).toContain('Restore the unavailable runtime dependency');

    const publicSummary = buildPublicAcceptanceSummary(snapshot);
    const serialized = JSON.stringify(publicSummary);
    expect(serialized).not.toContain('autonomy-accepted');
    expect(serialized).not.toContain('controlled runtime');
    expect((publicSummary as any).tasks).toBeUndefined();
    expect(buildTaskCompletionFeedback(blockedReceipt, 'Blocked task').incomplete).toHaveLength(1);
  });

  it('binds compact scheduler acceptance to the latest execution outcome and a verified checkpoint', () => {
    const target = 'controlled-probe';
    const schedulerTask = (
      id: string,
      currentStatus: string,
      options: { capabilityId?: string } = {},
    ) => {
      const executionId = `slot-${id}`;
      const capabilityId = options.capabilityId || `lumi.scheduler.${target}`;
      return {
        id,
        conversationId: `scheduler:${target}`,
        userId: 'system',
        goal: `Audit declared scheduled task ${target}`,
        target,
        status: 'completed',
        updatedAt: '2026-08-26T12:00:00.000Z',
        context: JSON.stringify({
          source: 'scheduler',
          scheduledTaskId: target,
          compactAudit: true,
          executionPlan: {
            planId: `plan-${id}`,
            taskId: executionId,
            intent: { kind: 'scheduled_task', target },
            nodes: [{
              nodeId: `handler-${id}`,
              toolName: 'scheduler_task_handler',
              capabilityId,
              executionRole: 'adapter',
              verificationStrategy: 'terminal_receipt',
            }],
            expectedEvidence: [{
              nodeId: `handler-${id}`,
              capabilityId,
              strategy: 'terminal_receipt',
              required: true,
              requiredFields: ['status', 'verified', 'scheduledTaskId'],
              requiredValues: { status: 'verified', verified: true, scheduledTaskId: target },
            }],
          },
          schedulerAudit: {
            currentExecution: {
              executionId,
              status: currentStatus,
              startedAt: '2026-08-26T11:59:59.000Z',
              completedAt: '2026-08-26T12:00:00.000Z',
            },
          },
        }),
      };
    };
    const checkpoint = (
      taskId: string,
      options: {
        executionId?: string;
        envelopeTaskId?: string;
        requestId?: string;
        toolName?: string;
        target?: string;
        basis?: 'terminal_verification' | 'compatibility_inference';
      } = {},
    ) => {
      const executionId = options.executionId || `slot-${taskId}`;
      const requestId = options.requestId || executionId;
      const toolName = options.toolName || 'scheduler_task_handler';
      const receiptTarget = options.target || target;
      const idempotencyKey = `${taskId}:${executionId}:${toolName}`;
      return {
        id: `checkpoint-${taskId}`,
        taskId,
        turnId: executionId,
        requestId,
        idempotencyKey,
        toolName,
        targetIdentity: receiptTarget,
        outcome: 'verified_success',
        envelope: JSON.stringify({
          version: 1,
          status: 'verified_success',
          toolName,
          taskId: options.envelopeTaskId || executionId,
          turnId: executionId,
          requestId,
          idempotencyKey,
          targetIdentity: receiptTarget,
          completedAt: '2026-08-26T06:00:00.000Z',
          result: { status: 'verified', verified: true, scheduledTaskId: receiptTarget },
          verification: {
            status: 'verified',
            basis: options.basis || 'terminal_verification',
          },
        }),
        createdAt: '2026-08-26T06:00:00.000Z',
      };
    };
    const projections = buildTaskAcceptanceProjections({
      conversationActionTasks: [
        schedulerTask('scheduler_audit_verified', 'verified'),
        schedulerTask('scheduler_audit_unknown', 'unknown'),
        schedulerTask('scheduler_audit_no_checkpoint', 'verified'),
        schedulerTask('scheduler_audit_stale_checkpoint', 'verified'),
        schedulerTask('scheduler_audit_wrong_tool', 'verified'),
        schedulerTask('scheduler_audit_wrong_target', 'verified'),
        schedulerTask('scheduler_audit_inferred', 'verified'),
        schedulerTask('scheduler_audit_partial_identity', 'verified'),
        schedulerTask('scheduler_audit_wrong_envelope_task', 'verified'),
        schedulerTask('scheduler_audit_wrong_capability', 'verified', { capabilityId: 'lumi.scheduler.some-other-task' }),
      ],
      conversationActionReceipts: [
        checkpoint('scheduler_audit_verified'),
        checkpoint('scheduler_audit_unknown'),
        checkpoint('scheduler_audit_stale_checkpoint', { executionId: 'slot-an-older-run' }),
        checkpoint('scheduler_audit_wrong_tool', { toolName: 'some_other_tool' }),
        checkpoint('scheduler_audit_wrong_target', { target: 'some-other-task' }),
        checkpoint('scheduler_audit_inferred', { basis: 'compatibility_inference' }),
        checkpoint('scheduler_audit_partial_identity', { requestId: 'a-different-request' }),
        checkpoint('scheduler_audit_wrong_envelope_task', { envelopeTaskId: 'a-different-task' }),
        checkpoint('scheduler_audit_wrong_capability'),
      ],
    });

    expect(projections.find(task => task.taskId === 'scheduler_audit_verified')).toMatchObject({
      runtime: 'scheduler',
      status: 'completed',
      accepted: true,
      terminalVerification: 'verified',
      diagnosticCode: 'scheduler_compact_checkpoint_verified',
    });
    expect(projections.find(task => task.taskId === 'scheduler_audit_unknown')).toMatchObject({
      runtime: 'scheduler',
      status: 'unknown',
      accepted: false,
      terminalVerification: 'failed',
      diagnosticCode: 'scheduler_compact_unknown',
    });
    expect(projections.find(task => task.taskId === 'scheduler_audit_no_checkpoint')).toMatchObject({
      runtime: 'scheduler',
      status: 'completed',
      accepted: false,
      terminalReceiptPresent: false,
      diagnosticCode: 'scheduler_compact_checkpoint_missing',
    });
    expect(projections.find(task => task.taskId === 'scheduler_audit_stale_checkpoint')).toMatchObject({
      runtime: 'scheduler',
      status: 'completed',
      accepted: false,
      terminalReceiptPresent: false,
      terminalVerification: 'missing',
      diagnosticCode: 'scheduler_compact_checkpoint_missing',
    });
    for (const taskId of [
      'scheduler_audit_wrong_tool',
      'scheduler_audit_wrong_target',
      'scheduler_audit_inferred',
      'scheduler_audit_partial_identity',
      'scheduler_audit_wrong_envelope_task',
      'scheduler_audit_wrong_capability',
    ]) {
      expect(projections.find(task => task.taskId === taskId)).toMatchObject({
        runtime: 'scheduler',
        status: 'completed',
        accepted: false,
        terminalReceiptPresent: true,
        terminalVerification: 'unverified',
        diagnosticCode: 'scheduler_compact_checkpoint_unverified',
      });
    }
  });

  it('builds foreground feedback only from a real task lifecycle or tool receipt', () => {
    expect(buildForegroundTaskCompletionFeedback({
      taskId: 'plain-chat',
      taskLabel: 'How are you?',
    })).toBeUndefined();

    expect(buildForegroundTaskCompletionFeedback({
      taskId: 'foreground-success',
      taskLabel: 'Run the controlled probe',
      toolRecords: [terminalToolRecord('foreground-receipt')],
    })).toMatchObject({
      status: 'completed',
      incomplete: [],
      blockers: [],
      evidence: ['Verified tool receipts: controlled_probe'],
    });

    expect(buildForegroundTaskCompletionFeedback({
      taskId: 'foreground-blocked',
      taskLabel: 'Open the unavailable application',
      blocked: true,
      reason: 'The application is unavailable.',
    })).toMatchObject({
      status: 'blocked',
      completed: [],
      blockers: ['The application is unavailable.'],
    });

    expect(buildForegroundTaskCompletionFeedback({
      taskId: 'foreground-confirmation',
      taskLabel: 'Send the message',
      status: 'waiting_confirmation',
    })).toMatchObject({
      status: 'working',
      incomplete: ['Send the message is waiting for confirmation.'],
      nextSteps: ['Approve or reject the pending action to continue.'],
    });

    expect(buildForegroundTaskCompletionFeedback({
      taskId: 'foreground-cancelled',
      taskLabel: 'Research the topic',
      toolRecords: [terminalToolRecord('cancelled-before-completion')],
      status: 'cancelled',
      reason: 'Cancelled by the user.',
    })).toMatchObject({
      status: 'cancelled',
      completed: [],
      incomplete: ['Research the topic is not verified complete.'],
    });

    expect(buildForegroundTaskCompletionFeedback({
      taskId: 'foreground-persistence-unknown',
      taskLabel: 'Research the topic',
      toolRecords: [terminalToolRecord('unflushed-result')],
      status: 'persistence_unknown',
      reason: 'The terminal state could not be persisted.',
    })).toMatchObject({
      status: 'blocked',
      completed: [],
      blockers: ['The terminal state could not be persisted.'],
    });

  });
});
