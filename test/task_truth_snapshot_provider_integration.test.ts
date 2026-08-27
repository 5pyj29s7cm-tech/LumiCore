import './helpers';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  flushDBOrThrow,
  initDatabase,
  readDB,
  writeDB,
} from '../db_layer';
import {
  appendConversationActionReceipts,
  syncConversationActionTaskLedger,
} from '../server/conversation/action_ledger';
import {
  bindConversationActionTurnTask,
} from '../server/conversation/action_turn_ledger';
import {
  addMessageIdempotent,
} from '../server/conversation/manager';
import {
  buildTaskTruthSnapshotFromSources,
  captureTaskTruthSnapshot,
  type BuildTaskTruthSnapshotInput,
} from '../server/evidence/task_truth_snapshot';
import { listModelRoutingReceipts } from '../server/llm/model_routing_receipts';
import { makeLLMCall } from '../server/llm/providers';
import { validateTaskTruthSnapshot } from '../scripts/lib/task-regression-matrix.mjs';

const deadlines = {
  requestMs: 100,
  firstByteMs: 100,
  semanticContentMs: 100,
  idleMs: 100,
  absoluteMs: 500,
};

describe('provider receipt to task truth snapshot integration', () => {
  const suffix = crypto.randomUUID();
  const userId = `truth-provider-user-${suffix}`;
  const conversationId = `truth-provider-conversation-${suffix}`;
  const requestId = `truth-provider-request-${suffix}`;
  const taskId = `truth-provider-task-${suffix}`;
  const receiptId = `truth-provider-tool-receipt-${suffix}`;
  const target = 'D:/Desktop/confirmed-integration.pptx';
  const provider = 'deepseek';
  const model = 'truth-provider-integration-model';
  const scenarioId = 'wps_wrong_file_correction';
  const acceptanceRunId = `truth-provider-run-${suffix}`;
  const buildIdentityDigest = 'e'.repeat(64);
  let userMessageId = '';
  let assistantMessageId = '';
  let routingReceiptId = '';
  let providerPayload: any;

  function sourceInput(db: any, snapshotId: string): BuildTaskTruthSnapshotInput {
    return {
      db,
      snapshotId,
      scenarioId,
      acceptanceRunId,
      buildIdentityDigest,
      userId,
      conversationId,
      requestId,
      taskId,
      replyMessageId: assistantMessageId,
      receiptId,
      routingReceiptId,
      capturedAt: new Date().toISOString(),
    };
  }

  beforeAll(async () => {
    await initDatabase();
    const now = new Date().toISOString();
    const db = readDB();
    db.conversations ||= [];
    db.conversations.push({
      id: conversationId,
      userId,
      agentId: 'lumi',
      title: 'Provider evidence integration',
      status: 'active',
      summary: '',
      messageCount: 0,
      lastActiveAt: now,
      createdAt: now,
      domain: 'personal',
      orgId: '',
    });
    writeDB(db);

    userMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '不是上一份，请读取并核对 confirmed-integration.pptx。',
      source: 'chat',
      channel: 'chat',
      requestId,
      skipActionContinuation: true,
      timestamp: now,
    });

    const currentDb = readDB();
    const conversation = currentDb.conversations.find((row: any) => (
      row.id === conversationId && row.userId === userId
    ));
    const task = syncConversationActionTaskLedger(currentDb, {
      conversation,
      state: {
        version: 2,
        taskId,
        goal: 'Read and verify the corrected WPS presentation target.',
        latestInstruction: 'Read confirmed-integration.pptx.',
        status: 'completed',
        unfinished: false,
        updatedAt: now,
        sourcePaths: [target],
        evidenceTools: ['wps_read_active_document'],
        assistantState: 'The corrected presentation was read and verified.',
        toolSummaries: [],
        receipts: [],
        completionSource: 'tool_receipt',
      } as any,
      rootUserMessageId: userMessageId,
      currentUserMessageId: userMessageId,
      userText: 'Read and verify the corrected WPS presentation target.',
      now,
    });
    expect(task).not.toBeNull();
    const bound = bindConversationActionTurnTask({
      conversationId,
      userId,
      requestId,
      taskId,
      now,
    });
    expect(bound.bound).toBe(true);

    appendConversationActionReceipts(currentDb, {
      task: task!,
      records: [{
        id: receiptId,
        taskId,
        turnId: userMessageId,
        requestId,
        name: 'wps_read_active_document',
        arguments: { path: target },
        result: JSON.stringify({ ok: true, path: target, targetMatched: true }),
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'The adapter readback matched the exact corrected path.',
        },
      }],
      turnId: userMessageId,
      requestId,
      now,
    });
    writeDB(currentDb);

    const response = await makeLLMCall(
      [
        { role: 'system', content: 'Use only the persisted target evidence.' },
        {
          role: 'user',
          content: 'Read the corrected confirmed-integration.pptx target.',
          sourceMessageId: userMessageId,
        },
      ],
      [],
      {
        provider,
        model,
        userId,
        conversationId,
        requestId,
        interactionId: userMessageId,
        source: 'chat',
        selectionMode: 'pinned',
        noImplicitFailover: true,
        attemptTimeouts: deadlines,
      },
      () => ({
        chat: {
          completions: {
            create: async (payload: any) => {
              providerPayload = structuredClone(payload);
              return {
                choices: [{
                  message: {
                    role: 'assistant',
                    content: '已读取并核对 confirmed-integration.pptx。',
                  },
                }],
              };
            },
          },
        },
      }),
      () => null,
    );
    expect(response.text).toBe('已读取并核对 confirmed-integration.pptx。');
    expect(response.routingReceiptId).toBeTruthy();

    assistantMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: response.text!,
      source: 'chat',
      channel: 'chat',
      requestId,
      skipActionContinuation: true,
      llmWasCalled: true,
    });

    const routingReceipt = listModelRoutingReceipts(userId, 10, { requestId })[0];
    expect(routingReceipt).toBeDefined();
    routingReceiptId = routingReceipt.id;
    expect(response.routingReceiptId).toBe(routingReceiptId);
    await flushDBOrThrow();

    // Re-open the isolated database so the collector cannot pass by observing
    // only transient in-memory objects.
    await closeDatabase();
    await initDatabase();
  });

  it('captures and validates one fully persisted provider/task/request/tool chain', async () => {
    const snapshot = await captureTaskTruthSnapshot({
      snapshotId: `truth-provider-positive-${suffix}`,
      scenarioId,
      acceptanceRunId,
      buildIdentityDigest,
      userId,
      conversationId,
      requestId,
      taskId,
      replyMessageId: assistantMessageId,
      receiptId,
      routingReceiptId,
      capturedAt: new Date().toISOString(),
    });

    expect(providerPayload.messages.map((message: any) => message.role)).toEqual([
      'system',
      'user',
    ]);
    expect(providerPayload.messages[1].content).toBe(
      'Read the corrected confirmed-integration.pptx target.',
    );
    expect(snapshot).toMatchObject({
      userVisibleReply: { messageId: assistantMessageId },
      task: { taskId, status: 'completed' },
      request: { requestId, taskId, status: 'succeeded' },
      receipt: {
        recordId: receiptId,
        receiptId,
        requestId,
        taskId,
        status: 'succeeded',
        toolName: 'wps_read_active_document',
      },
      toolTarget: {
        recordId: receiptId,
        requestId,
        taskId,
        targetId: target,
      },
      modelActualInput: {
        recordId: routingReceiptId,
        requestId,
        taskId,
        provider,
        model,
        captureOrigin: 'provider_dispatch_boundary',
        modelInvoked: true,
      },
    });
    expect(snapshot.pointers.pending.state).toBe('cleared');
    expect(snapshot.pointers.live.state).toBe('cleared');
    expect(snapshot.modelActualInput.captureOrigin).toBe('provider_dispatch_boundary');
    if (snapshot.modelActualInput.captureOrigin !== 'provider_dispatch_boundary') {
      throw new Error('expected_provider_dispatch_boundary');
    }
    expect(snapshot.modelActualInput.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        sourceMessageId: userMessageId,
      }),
    ]));
    expect(validateTaskTruthSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it.each([
    ['provider', 'task_truth_snapshot_model_provider_mismatch'],
    ['model', 'task_truth_snapshot_model_name_mismatch'],
  ] as const)('rejects a forged persisted attempt %s', (field, errorCode) => {
    const forgedDb = structuredClone(readDB());
    const routingReceipt = forgedDb.modelRoutingReceipts.find((row: any) => (
      row.id === routingReceiptId
    ));
    const succeededAttempt = routingReceipt.attempts.find((attempt: any) => (
      attempt.status === 'succeeded'
    ));
    succeededAttempt[field] = `forged-${field}`;

    expect(() => buildTaskTruthSnapshotFromSources(
      sourceInput(forgedDb, `truth-provider-forged-${field}-${suffix}`),
    )).toThrow(errorCode);
  });

  it('rejects a forged provider source row that is no longer a durable user turn', () => {
    const forgedDb = structuredClone(readDB());
    const sourceRow = forgedDb.interactions.find((row: any) => row.id === userMessageId);
    sourceRow.role = 'assistant';

    expect(() => buildTaskTruthSnapshotFromSources(
      sourceInput(forgedDb, `truth-provider-forged-source-${suffix}`),
    )).toThrow('task_truth_snapshot_model_source_record_missing');
  });
});
