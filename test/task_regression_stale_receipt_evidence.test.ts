import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  addMessageIdempotent,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  setConversationActionExecutionStatus,
} from '../server/conversation/manager';
import {
  reclassifyManifestBoundStaleReceipt,
} from '../server/evidence/stale_receipt_reclassification';
import {
  classifyConversationReceiptOwnership,
} from '../server/conversation/receipt_ownership';

describe('manifest-bound stale receipt evidence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('uses the production stale path and preserves the newer live owner', async () => {
    const nonce = `${Date.now()}-${Math.random()}`;
    const userId = `task-regression-stale-${nonce}`;
    const displayRequestId = `request-stale-display-${nonce}`;
    const continueRequestId = `request-stale-continue-${nonce}`;
    const sourceReceiptId = `receipt-stale-source-${nonce}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');

    const displayUserMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '[LUMI_REGRESSION:S4] Read the isolated fixture.',
      requestId: displayRequestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    const oldTask = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '[LUMI_REGRESSION:S4] Read the isolated fixture.',
      requestId: displayRequestId,
      userMessageId: displayUserMessageId,
      toolPolicy: {
        allowedTools: ['read_file'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 4,
      },
      forceTask: true,
    });
    expect(oldTask.state?.taskId).toBeTruthy();
    const sourceAssistantMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'The isolated fixture was read.',
      requestId: displayRequestId,
      domain: 'personal',
      toolCalls: [{
        id: sourceReceiptId,
        taskId: oldTask.state!.taskId,
        turnId: displayRequestId,
        requestId: displayRequestId,
        idempotencyKey: `source-idempotency-${nonce}`,
        name: 'read_file',
        arguments: { path: `D:\\isolated\\fixture-${nonce}.txt` },
        result: JSON.stringify({ ok: true, status: 'verified', content: 'fixture' }),
        executionOrigin: 'model_selected',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Isolated fixture result recorded.',
        },
      }],
    });

    const continueUserMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '[LUMI_REGRESSION:S4:LIVE] Create the next isolated artifact after confirmation.',
      requestId: continueRequestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    const newTask = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '[LUMI_REGRESSION:S4:LIVE] Create the next isolated artifact after confirmation.',
      requestId: continueRequestId,
      userMessageId: continueUserMessageId,
      toolPolicy: {
        allowedTools: ['write_file'],
        requireConfirmation: ['write_file'],
        forbiddenTools: [],
        maxIterations: 4,
      },
      forceTask: true,
    });
    expect(newTask.state?.taskId).toBeTruthy();
    expect(newTask.state?.taskId).not.toBe(oldTask.state?.taskId);
    setConversationActionExecutionStatus(
      conversation.id,
      userId,
      'waiting_confirmation',
      {
        requestId: continueRequestId,
        blocker: 'Awaiting isolated regression confirmation.',
        assistantState: 'Awaiting isolated regression confirmation.',
      },
    );

    await expect(reclassifyManifestBoundStaleReceipt({
      acceptanceRunId: `task_regression_candidate_${nonce}`,
      buildIdentityDigest: 'a'.repeat(64),
      scenarioId: 'displayed_result_stale_receipt',
      userId,
      conversationId: conversation.id,
      displayRequestId,
      continueRequestId,
    })).rejects.toThrow('task_regression_stale_live_terminal_assistant_ambiguous');

    const continueAssistantMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Awaiting isolated regression confirmation.',
      requestId: continueRequestId,
      domain: 'personal',
      skipActionContinuation: true,
    });
    expect(continueAssistantMessageId).toBeTruthy();
    const terminalConversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    expect(terminalConversation.pendingActionContinuation).toBeUndefined();
    expect(terminalConversation.actionContinuationState).toMatchObject({
      taskId: newTask.state?.taskId,
      status: 'waiting_confirmation',
      unfinished: true,
    });

    const sourceBefore = (readDB().conversationActionReceipts || []).find((row: any) => (
      row.id === sourceReceiptId
    ));
    const sourceAssistantBefore = structuredClone(
      (readDB().interactions || []).find((row: any) => row.id === sourceAssistantMessageId),
    );
    const interactionCountBefore = (readDB().interactions || []).length;
    const liveBefore = getOrCreateActiveConversation(userId, 'lumi', 'personal', '')
      .actionContinuationState;
    expect(sourceBefore).toBeTruthy();
    expect(liveBefore).toMatchObject({
      taskId: newTask.state?.taskId,
      status: 'waiting_confirmation',
      unfinished: true,
    });

    const evidence = await reclassifyManifestBoundStaleReceipt({
      acceptanceRunId: `task_regression_candidate_${nonce}`,
      buildIdentityDigest: 'a'.repeat(64),
      scenarioId: 'displayed_result_stale_receipt',
      userId,
      conversationId: conversation.id,
      displayRequestId,
      continueRequestId,
    });

    expect(evidence).toMatchObject({
      kind: 'lumi.task-regression-stale-receipt-evidence',
      schemaVersion: 1,
      scenarioId: 'displayed_result_stale_receipt',
      conversationId: conversation.id,
      sourceReceipt: {
        recordId: sourceReceiptId,
        taskId: oldTask.state?.taskId,
        requestId: displayRequestId,
        toolName: 'read_file',
      },
      archive: {
        taskId: oldTask.state?.taskId,
        requestId: displayRequestId,
        toolName: 'read_file',
      },
      oldOwner: {
        taskId: oldTask.state?.taskId,
        requestId: displayRequestId,
        leaseReleased: true,
      },
      liveOwnerBefore: {
        taskId: newTask.state?.taskId,
        requestId: continueRequestId,
        status: 'waiting_confirmation',
      },
      liveOwnerAfter: {
        taskId: newTask.state?.taskId,
        requestId: continueRequestId,
        status: 'waiting_confirmation',
      },
      liveTaskAudit: {
        changedFields: [],
      },
      staleReclassification: {
        observationKind: 'stale_reclassification',
        sourceReceiptRef: sourceReceiptId,
        mismatchDimension: 'task_id',
        classification: 'stale',
        sourceReceiptUnchanged: true,
        leaseReleased: true,
      },
      invariants: {
        sourceReceiptUnchanged: true,
        newLiveTaskUnchanged: true,
        newLivePointerUnchanged: true,
        newPendingPointerUnchanged: true,
        archiveBoundToSourceTask: true,
      },
    });
    expect(evidence.archive.recordId).not.toBe(sourceReceiptId);
    expect(evidence.archive.lateAssistantMessageId).toBe(sourceAssistantMessageId);
    expect(evidence.staleReclassification.archiveRef).toBe(evidence.archive.recordId);
    expect(evidence.sourceReceipt.recordSha256After)
      .toBe(evidence.sourceReceipt.recordSha256Before);
    expect(evidence.liveOwnerAfter).toEqual(evidence.liveOwnerBefore);
    expect(evidence.liveTaskAudit.semanticSha256After)
      .toBe(evidence.liveTaskAudit.semanticSha256Before);
    expect(evidence.liveTaskAudit.recordSha256After)
      .toBe(evidence.liveTaskAudit.recordSha256Before);
    expect(evidence.staleReclassification.classifierInputSha256)
      .toMatch(/^[a-f0-9]{64}$/);

    const db = readDB();
    expect((db.interactions || [])).toHaveLength(interactionCountBefore);
    expect((db.interactions || []).find((row: any) => row.id === sourceAssistantMessageId))
      .toEqual(sourceAssistantBefore);
    const sourceAfter = (db.conversationActionReceipts || []).find((row: any) => (
      row.id === sourceReceiptId
    ));
    const archived = (db.conversationActionReceipts || []).find((row: any) => (
      row.id === evidence.archive.recordId
    ));
    expect(sourceAfter).toEqual(sourceBefore);
    expect(archived).toMatchObject({
      taskId: oldTask.state?.taskId,
      requestId: displayRequestId,
      toolName: 'read_file',
    });
    const hydratedLiveAfter = getOrCreateActiveConversation(userId, 'lumi', 'personal', '')
      .actionContinuationState;
    expect(hydratedLiveAfter).toMatchObject({
      taskId: liveBefore?.taskId,
      status: liveBefore?.status,
      unfinished: liveBefore?.unfinished,
      revision: liveBefore?.revision,
      activeRequestId: liveBefore?.activeRequestId,
      receipts: liveBefore?.receipts,
    });

    const currentReceiptId = `receipt-current-owner-${nonce}`;
    const unboundReceiptId = `receipt-unbound-owner-${nonce}`;
    const currentInteractionCount = (readDB().interactions || []).length;
    const currentAssistantMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Current-owner receipt replay fixture.',
      requestId: continueRequestId,
      domain: 'personal',
      toolCalls: [{
        id: currentReceiptId,
        taskId: newTask.state!.taskId,
        turnId: continueRequestId,
        requestId: continueRequestId,
        idempotencyKey: `current-owner-idempotency-${nonce}`,
        name: 'write_file',
        arguments: { path: `D:\\isolated\\current-${nonce}.txt`, content: 'current' },
        result: JSON.stringify({ ok: true, status: 'verified' }),
        executionOrigin: 'model_selected',
      }, {
        id: unboundReceiptId,
        idempotencyKey: `unbound-owner-idempotency-${nonce}`,
        name: 'write_file',
        arguments: { path: `D:\\isolated\\unbound-${nonce}.txt`, content: 'unbound' },
        result: JSON.stringify({ ok: true, status: 'verified' }),
        executionOrigin: 'model_selected',
      }],
    });
    const currentDb = readDB();
    expect(currentAssistantMessageId).toBe(continueAssistantMessageId);
    expect(currentDb.interactions || []).toHaveLength(currentInteractionCount);
    expect((currentDb.conversationActionReceipts || []).some((row: any) => (
      row.id === currentReceiptId || row.id === unboundReceiptId
    ))).toBe(false);
    const currentAssistant = (currentDb.interactions || []).find((row: any) => (
      row.id === currentAssistantMessageId
    ));
    expect(JSON.stringify(currentAssistant?.toolCalls || '')).not.toContain(currentReceiptId);
    expect(JSON.stringify(currentAssistant?.toolCalls || '')).not.toContain(unboundReceiptId);
  });

  it('classifies a current receipt without quarantining it as stale', () => {
    expect(classifyConversationReceiptOwnership({
      taskId: 'task-current',
      requestId: 'request-current',
    }, {
      taskId: 'task-current',
      requestId: 'request-current',
    })).toEqual({
      classification: 'current',
      mismatchDimensions: [],
    });
    expect(classifyConversationReceiptOwnership({
      taskId: 'task-old',
      requestId: 'request-old',
    }, {
      taskId: 'task-current',
      requestId: 'request-current',
    })).toEqual({
      classification: 'stale',
      mismatchDimensions: ['task_id', 'request_id'],
    });
  });
});
