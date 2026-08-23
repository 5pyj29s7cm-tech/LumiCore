import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceEvidenceSnapshot,
  buildCapabilityAcceptanceProjections,
  buildPublicAcceptanceSummary,
  buildTaskCompletionFeedback,
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

function actionReceipt(toolName: string, outcome: string, verification: string, createdAt: string) {
  return {
    id: `${toolName}:${createdAt}`,
    taskId: 'conversation-task',
    toolName,
    outcome,
    envelope: JSON.stringify({ verification: { status: verification } }),
    createdAt,
  };
}

describe('unified acceptance and evidence state', () => {
  it('separates registered, available, exercised, and verified capability states', () => {
    const states = buildCapabilityAcceptanceProjections({
      manifest: [
        manifest('registered-only', { executable: false }),
        manifest('available-only'),
        manifest('exercised-only'),
        manifest('verified-tool'),
        manifest('mcp-offline', { source: 'mcp', provider: 'offline-server' }),
      ],
      actionReceipts: [
        actionReceipt('exercised-only', 'failed', 'failed', '2026-08-23T00:00:00.000Z'),
        actionReceipt('verified-tool', 'verified_success', 'verified', '2026-08-23T00:00:01.000Z'),
      ],
      mcpHealth: { 'offline-server': { status: 'disconnected' } },
    });

    expect(Object.fromEntries(states.map(state => [state.toolName, state.stage]))).toEqual({
      'available-only': 'available',
      'exercised-only': 'exercised',
      'mcp-offline': 'registered',
      'registered-only': 'registered',
      'verified-tool': 'verified',
    });
    expect(states.find(state => state.toolName === 'mcp-offline')).toMatchObject({
      availability: 'unavailable',
      availabilityBasis: 'mcp_disconnected',
    });
  });

  it('reports zero model-graph and knowledge-quality samples as not exercised, never healthy', () => {
    const zero = evaluateRuntimeAcceptanceSubsystems({
      modelGraph: { compilations: 0, invalidGraphs: 0, arbitrations: 0, blockedArbitrations: 0 },
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
    expect(zero.modelGraph).toMatchObject({
      status: 'not_exercised',
      diagnosticCode: 'no_current_process_model_graph_sample',
    });
    expect(zero.knowledgeQuality).toMatchObject({
      status: 'not_exercised',
      diagnosticCode: 'no_current_process_knowledge_quality_sample',
      recallAt5: { status: 'unknown', value: null, sampleSize: 0 },
      citationAccuracy: { status: 'unknown', value: null, sampleSize: 0 },
    });

    const measuredZero = evaluateRuntimeAcceptanceSubsystems({
      modelGraph: { compilations: 1, invalidGraphs: 0, arbitrations: 1, blockedArbitrations: 0 },
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
    expect(measuredZero.modelGraph.status).toBe('verified');
    expect(measuredZero.knowledgeQuality.status).toBe('verified');
    expect(measuredZero.knowledgeQuality.recallAt5).toMatchObject({ status: 'measured', value: 0 });
    expect(measuredZero.knowledgeQuality.citationAccuracy).toMatchObject({ status: 'measured', value: 0 });
  });

  it('requires task-bound machine evidence for a completion receipt', () => {
    const receipt = buildTaskTerminalReceipt({
      taskId: 'task-accepted',
      runtime: 'background',
      outcome: 'completed',
      toolRecords: [terminalToolRecord()],
    });
    expect(validateCompletionTerminalReceipt(receipt, {
      taskId: 'task-accepted',
      runtime: 'background',
    })).toMatchObject({ accepted: true });
    expect(receipt).toMatchObject({ schemaVersion: 2 });
    expect(receipt.signature).toMatch(/^[a-f0-9]{64}$/);

    const tampered = {
      ...receipt,
      evidenceRefs: ['tool:invented-after-signing'],
    };
    expect(validateCompletionTerminalReceipt(tampered, {
      taskId: 'task-accepted',
      runtime: 'background',
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
      runtime: 'background',
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
      runtime: 'background',
    })).toMatchObject({
      accepted: false,
      diagnosticCode: 'terminal_receipt_integrity_invalid',
    });
    expect(validateCompletionTerminalReceipt(receipt, {
      taskId: 'different-task',
      runtime: 'background',
    })).toMatchObject({ accepted: false, diagnosticCode: 'terminal_receipt_identity_mismatch' });

    const proseOnly = buildTaskTerminalReceipt({
      taskId: 'task-prose-only',
      runtime: 'background',
      outcome: 'completed',
      reason: 'The model said it was done.',
    });
    expect(validateCompletionTerminalReceipt(proseOnly, {
      taskId: 'task-prose-only',
      runtime: 'background',
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
      taskId: 'background-accepted',
      runtime: 'background',
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
      backgroundDelegationTasks: [{
        id: 'background-accepted',
        userId: 'owner',
        title: 'Accepted task',
        prompt: 'Preserved goal',
        status: 'completed',
        context: { actionTaskId: 'action-plan-1', domain: 'personal' },
        checkpoint: { receiptIds: ['safe-evidence-id'] },
        terminalReceipt: acceptedReceipt,
        updatedAt: '2026-08-23T00:00:02.000Z',
      }, {
        id: 'legacy-complete',
        userId: 'owner',
        title: 'Legacy task',
        prompt: 'Legacy goal',
        status: 'completed',
        updatedAt: '2026-08-23T00:00:01.000Z',
      }],
      autonomousTasks: [{
        id: 'autonomy-blocked',
        userId: 'owner',
        title: 'Blocked task',
        description: 'Preserved autonomous goal',
        status: 'blocked',
        executionPlan: { planId: 'plan-1' },
        checkpoint: { receiptIds: ['prior-safe-receipt'] },
        terminalReceipt: blockedReceipt,
        error: 'The controlled runtime is unavailable.',
        updatedAt: '2026-08-23T00:00:03.000Z',
      }],
    };
    const snapshot = buildAcceptanceEvidenceSnapshot({
      db,
      manifest: [manifest('safe-tool')],
      capabilityMetrics: {},
      scope: { userId: 'owner', domain: 'personal' },
    });
    const accepted = snapshot.tasks.find(task => task.taskId === 'background-accepted');
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
    expect(serialized).not.toContain('background-accepted');
    expect(serialized).not.toContain('worker-a');
    expect(serialized).not.toContain('controlled runtime');
    expect((publicSummary as any).tasks).toBeUndefined();
    expect(buildTaskCompletionFeedback(blockedReceipt, 'Blocked task').incomplete).toHaveLength(1);
  });
});
