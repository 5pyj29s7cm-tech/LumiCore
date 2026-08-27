import './helpers';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

vi.mock('../server/llm/local_models', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/local_models')>();
  return {
    ...actual,
    ensureLocalModelReady: vi.fn(async (_provider: string, model: string) => model),
    runLocalModelInference: vi.fn(async (
      _provider: string,
      execute: () => Promise<unknown>,
    ) => execute()),
  };
});

vi.mock('../server/memory', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/memory')>();
  return {
    ...actual,
    queryMemories: vi.fn(() => []),
    queryMemoriesVector: vi.fn(async () => []),
    extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
  };
});

vi.mock('../server/agents/rag', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/agents/rag')>();
  return { ...actual, retrieveChunks: vi.fn(async () => []) };
});

vi.mock('../server/conversation/summary_scheduler', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/conversation/summary_scheduler')>();
  return { ...actual, scheduleConversationSummary: vi.fn() };
});

import { initDatabase, readDB } from '../db_layer';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { getConversationActionStateByTaskId } from '../server/conversation/action_ledger';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { getEvidenceKeyMaterial } from '../server/evidence/evidence_identity';
import {
  getMessages,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';
import { listModelRoutingReceipts } from '../server/llm/model_routing_receipts';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { registerChatHandler } from '../server/socket/chat';
import { getChatExecution } from '../server/socket/chat_execution_registry';
import {
  clearAllPendingConfirmationsForTests,
  getPendingConfirmation,
} from '../server/tools/pending_confirmation';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

const ATTEMPT_TIMEOUTS = {
  requestMs: 250,
  firstByteMs: 250,
  semanticContentMs: 250,
  idleMs: 250,
  absoluteMs: 1_000,
};

function privateDigest(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item as Record<string, unknown>)
      .sort()
      .map(key => [key, stable((item as Record<string, unknown>)[key])]));
  };
  return crypto.createHmac('sha256', getEvidenceKeyMaterial().key)
    .update('lumi.provider-outbound.private-digest.v1\0', 'utf8')
    .update(JSON.stringify(stable(value)), 'utf8')
    .digest('hex');
}

function payloadToolNames(payload: any): string[] {
  return (payload?.tools || []).map((tool: any) => String(tool?.function?.name || ''));
}

function waitForRequestEvent<T extends Record<string, any>>(
  socket: ClientSocket,
  event: string,
  requestId: string,
  timeoutMs = 12_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event} (${requestId})`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (String(payload?.requestId || '') !== requestId) return;
      clearTimeout(timeout);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function waitForForegroundRelease(input: {
  userId: string;
  source: string;
  conversationId: string;
  requestId: string;
  taskId: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (input.timeoutMs || 5_000);
  let latest: Record<string, any> = {};
  while (Date.now() < deadline) {
    const db = readDB();
    const actionState = getConversationActionStateByTaskId(db, input);
    const actionTurn = getConversationActionTurn(input);
    const conversation = (db.conversations || []).find((row: any) => (
      row.id === input.conversationId && row.userId === input.userId
    ));
    const execution = getChatExecution({
      userId: input.userId,
      domain: 'personal',
      orgId: '',
      source: input.source,
      conversationId: input.conversationId,
    }, input.requestId);
    latest = { db, actionState, actionTurn, conversation, execution };
    if (
      actionState?.status === 'completed'
      && actionState.unfinished === false
      && !String(actionState.activeRequestId || '')
      && actionTurn?.status === 'terminal'
      && !String(actionTurn.leaseOwnerId || '')
      && !conversation?.actionContinuationState
      && execution?.terminal === true
      && execution.status === 'completed'
      && getPendingConfirmation(input.userId) === null
    ) return latest;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const recomputed = latest.actionState
    ? taskCompletionFromReceipts(
        latest.actionState.goal,
        latest.actionState.receipts || [],
      )
    : null;
  const contract = latest.actionState
    ? buildActionContract(latest.actionState.goal)
    : null;
  throw new Error(`Foreground release did not converge: ${JSON.stringify({
    taskStatus: latest.actionState?.status,
    unfinished: latest.actionState?.unfinished,
    activeRequestId: latest.actionState?.activeRequestId,
    blocker: latest.actionState?.latestBlocker,
    goal: latest.actionState?.goal,
    receipts: (latest.actionState?.receipts || []).map((receipt: any) => ({
      name: receipt.name,
      outcome: receipt.outcome,
      arguments: receipt.arguments,
      result: String(receipt.result || '').slice(0, 180),
      terminalVerification: receipt.terminalVerification,
    })),
    contract: contract && { kind: contract.kind, label: contract.label },
    recomputedCompletion: recomputed,
    recomputedCoreEvidence: contract && recomputed
      ? hasCoreActionEvidence(contract, recomputed.records, latest.actionState.goal)
      : null,
    turnStatus: latest.actionTurn?.status,
    leaseOwnerId: latest.actionTurn?.leaseOwnerId,
    terminalReason: latest.actionTurn?.terminalReason,
    livePointer: latest.conversation?.actionContinuationState?.taskId,
    executionStatus: latest.execution?.status,
  })}`);
}

function streamChunk(input: {
  text?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, any> };
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}) {
  return (async function* responseStream() {
    if (input.toolCall) {
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: input.toolCall.id,
              function: {
                name: input.toolCall.name,
                arguments: JSON.stringify(input.toolCall.arguments),
              },
            }],
          },
        }],
        usage: input.usage,
      };
      return;
    }
    yield {
      choices: [{ delta: { content: input.text || '' } }],
      usage: input.usage,
    };
  })();
}

describe('Chat/task model failover continuity', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `s8-chat-task-${suffix}`;
  const requestId = `s8-chat-request-${suffix}`;
  const source = 'acceptance-s8-chat';
  const primaryModel = `s8-primary-${suffix}`;
  const fallbackModel = `s8-lmstudio-${suffix}`;
  const sentinel = `S8_CHAT_TASK_VERIFIED_${suffix}`;
  const fixturePath = path.join(
    String(process.env.LUMI_DATA_DIR || ''),
    `s8-chat-task-${suffix}.txt`,
  );
  const userText = `What exact marker is inside ${fixturePath}? Please inspect the actual file with read_file before answering.`;

  let conversationId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;
  const primaryPayloads: any[] = [];
  const fallbackPayloads: any[] = [];
  const clientEvents: Array<{ event: string; payload: Record<string, any> }> = [];

  const primaryCreate = vi.fn(async (payload: any) => {
    primaryPayloads.push(structuredClone(payload));
    const error = new Error('ECONNREFUSED deterministic S8 Chat primary provider failure');
    (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    throw error;
  });

  const fallbackCreate = vi.fn(async (payload: any) => {
    fallbackPayloads.push(structuredClone(payload));
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const hasVerifiedToolResult = messages.some((message: any) => (
      message?.role === 'tool'
      && String(message?.content || '').includes(sentinel)
    ));
    if (!hasVerifiedToolResult) {
      const declaredNames = (payload?.tools || [])
        .map((tool: any) => String(tool?.function?.name || ''));
      if (!declaredNames.includes('read_file')) {
        throw new Error(`S8 Chat route did not expose read_file: ${declaredNames.join(',')}`);
      }
      return streamChunk({
        toolCall: {
          id: `s8-chat-read-${suffix}`,
          name: 'read_file',
          arguments: { path: fixturePath },
        },
        usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 },
      });
    }
    return streamChunk({
      text: `The exact verified marker is ${sentinel}.`,
      usage: { prompt_tokens: 28, completion_tokens: 9, total_tokens: 37 },
    });
  });

  beforeAll(async () => {
    await initDatabase();
    resetCircuit();
    clearAllPendingConfirmationsForTests();
    fs.writeFileSync(fixturePath, sentinel, 'utf8');
    if (!toolRegistry.get('read_file')) registerAllTools(toolRegistry);

    upsertUserPreferredLLM(userId, {
      provider: 'deepseek',
      model: primaryModel,
      selectionMode: 'ordered_fallback',
      fallbackCandidates: [{ provider: 'lmstudio', model: fallbackModel }],
      allowCloudFallback: true,
    });
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;

    const primary = { chat: { completions: { create: primaryCreate } } };
    const lmstudio = { chat: { completions: { create: fallbackCreate } } };
    httpServer = createServer();
    io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    io.on('connection', serverSocket => {
      serverSocket.data.authenticatedUserId = userId;
      serverSocket.data.authenticatedRole = 'admin';
      serverSocket.data.trustedLocalExecution = true;
      serverSocket.join(`user:${userId}:personal`);
      registerChatHandler(
        serverSocket,
        {
          getDeepSeek: () => primary,
          getGemini: () => null,
          getOpenAI: () => null,
          getAnthropic: () => null,
          getQwen: () => null,
          getOllama: () => null,
          isOllamaAvailable: () => false,
          getLmStudio: () => lmstudio,
          isLmStudioAvailable: () => true,
          getArk: () => null,
          getXiaomi: () => null,
          getKimi: () => null,
          getGlm: () => null,
          getRelay: () => null,
        },
        () => ({
          audio: false,
          visual: false,
          spatial: false,
          haptic: false,
          holographic: false,
          activeDeviceTypes: [],
          deviceCount: 0,
        }),
        () => userId,
        io,
      );
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to bind isolated S8 Chat server');
    }
    client = createSocketClient(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
    });
    client.onAny((event, payload) => {
      if (payload && typeof payload === 'object') clientEvents.push({ event, payload });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting isolated S8 Chat client')), 5_000);
      client.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.once('connect_error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });

  afterEach(() => {
    resetCircuit();
  });

  afterAll(async () => {
    clearAllPendingConfirmationsForTests();
    client?.disconnect();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    if (httpServer?.listening) {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
  });

  it('falls back to LM Studio inside one durable Chat task and releases every foreground owner', async () => {
    const terminalPromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      requestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: userText,
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source,
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });

    const terminal = await terminalPromise;
    expect(terminal).toMatchObject({
      requestId,
      conversationId,
      finalized: true,
      blocked: false,
      text: `The exact verified marker is ${sentinel}.`,
    });
    expect(terminal.text).not.toMatch(/No successful current-turn tool execution|这一轮没有记录到成功|model routes unavailable|processing failed/i);

    expect(primaryCreate).toHaveBeenCalledTimes(2);
    expect(fallbackCreate).toHaveBeenCalledTimes(2);
    expect(primaryPayloads).toHaveLength(2);
    expect(fallbackPayloads).toHaveLength(2);
    expect(primaryPayloads.every(payload => payload.model === primaryModel)).toBe(true);
    expect(fallbackPayloads.every(payload => payload.model === fallbackModel)).toBe(true);
    const routeNames = (clientEvents.find(event => event.event === 'agent:tool_route')?.payload?.toolNames || [])
      .map((name: unknown) => String(name));
    const primaryToolNames = payloadToolNames(primaryPayloads[0]);
    expect(routeNames.length).toBeGreaterThan(0);
    expect(primaryToolNames).toEqual(routeNames);
    expect(primaryPayloads.every(payload => (
      JSON.stringify(payloadToolNames(payload)) === JSON.stringify(primaryToolNames)
    ))).toBe(true);
    expect(fallbackPayloads.every(payload => payloadToolNames(payload)[0] === 'read_file')).toBe(true);
    expect(fallbackPayloads.every(payload => (
      payloadToolNames(payload).includes('client_capability_manifest')
      && payloadToolNames(payload).length < primaryToolNames.length
      && JSON.stringify(payloadToolNames(payload)) === JSON.stringify(
        primaryToolNames.filter(name => payloadToolNames(payload).includes(name)),
      )
    ))).toBe(true);
    expect(JSON.stringify(fallbackPayloads[0].messages)).not.toContain(sentinel);
    expect(JSON.stringify(fallbackPayloads[1].messages)).toContain(sentinel);
    expect(fallbackPayloads[1].messages.some((message: any) => message.role === 'tool')).toBe(true);
    const fallbackAssistant = fallbackPayloads[1].messages.find((message: any) => (
      message.role === 'assistant' && Array.isArray(message.tool_calls)
    ));
    const fallbackReceipt = fallbackPayloads[1].messages.find((message: any) => message.role === 'tool');
    expect(fallbackAssistant?.tool_calls?.[0]?.id).toBe(fallbackReceipt?.tool_call_id);

    const db = readDB();
    const assistant = (db.interactions || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.role === 'assistant'
      && String(row.requestId || row.externalMessageId || '') === requestId
    ));
    expect(assistant).toBeDefined();
    expect(String(assistant.message || assistant.content || '')).toBe(terminal.text);
    expect(assistant.toolCalls).toHaveLength(1);
    const toolRecord = assistant.toolCalls[0];
    expect(toolRecord).toMatchObject({
      name: 'read_file',
      arguments: { path: fixturePath },
      requestId,
      turnId: requestId,
      taskId: expect.any(String),
      modelRoutingReceiptId: expect.any(String),
      executionOrigin: 'model_selected',
      terminalVerification: { status: 'verified' },
    });
    expect(String(toolRecord.result || '')).toContain(sentinel);

    const taskId = String(toolRecord.taskId || '');
    expect(taskId).toBeTruthy();
    expect(terminal.taskRelation).toMatchObject({ taskId });
    expect(terminal.completionFeedback).toMatchObject({
      status: 'completed',
      evidence: expect.arrayContaining([expect.stringMatching(/read_file/)]),
      blockers: [],
      incomplete: [],
    });
    const converged = await waitForForegroundRelease({
      conversationId,
      userId,
      taskId,
      requestId,
      source,
    });
    const persistedActionState = converged.actionState;
    expect(persistedActionState).toMatchObject({
      taskId,
      status: 'completed',
      unfinished: false,
    });
    expect(String(persistedActionState.activeRequestId || '')).toBe('');

    expect(converged.conversation?.actionContinuationState ?? null).toBeNull();
    expect(converged.actionTurn).toMatchObject({
      taskId,
      status: 'terminal',
      leaseOwnerId: '',
      terminalMessageId: assistant.id,
    });
    expect(getPendingConfirmation(userId)).toBeNull();
    expect(converged.execution).toMatchObject({
      terminal: true,
      status: 'completed',
      terminalEvent: {
        event: 'agent:response',
        payload: {
          requestId,
          text: `The exact verified marker is ${sentinel}.`,
          blocked: false,
        },
      },
    });

    const receipts = listModelRoutingReceipts(userId, 10, { conversationId, requestId })
      .filter(receipt => receipt.source === 'chat');
    expect(receipts).toHaveLength(2);
    expect(receipts.every(receipt => (
      receipt.status === 'succeeded'
      && receipt.requestedProvider === 'deepseek'
      && receipt.requestedModel === primaryModel
      && receipt.selectedProvider === 'lmstudio'
      && receipt.selectedModel === fallbackModel
      && receipt.fallbackReason === 'provider_unreachable'
      && receipt.attempts.length === 2
      && receipt.attempts[0].provider === 'deepseek'
      && receipt.attempts[0].status === 'failed'
      && receipt.attempts[0].reason === 'provider_unreachable'
      && receipt.attempts[0].visibleOutputCommitted === false
      && receipt.attempts[1].provider === 'lmstudio'
      && receipt.attempts[1].status === 'succeeded'
    ))).toBe(true);
    expect(receipts.some(receipt => receipt.id === toolRecord.modelRoutingReceiptId)).toBe(true);
    const planningReceipt = receipts.find(receipt => receipt.id === toolRecord.modelRoutingReceiptId);
    const finalReceipt = receipts.find(receipt => receipt.id !== toolRecord.modelRoutingReceiptId);
    expect(planningReceipt).toBeDefined();
    expect(finalReceipt).toBeDefined();
    for (const [receipt, index] of [[planningReceipt!, 0], [finalReceipt!, 1]] as const) {
      expect(receipt.attempts[0].outboundMessagesEvidence?.messagesSha256)
        .toBe(privateDigest({ system: null, messages: primaryPayloads[index].messages }));
      expect(receipt.attempts[0].outboundMessagesEvidence?.toolDeclarationsSha256)
        .toBe(privateDigest(primaryPayloads[index].tools || []));
      expect(receipt.attempts[0].outboundMessagesEvidence?.toolDeclarationCount)
        .toBe(primaryToolNames.length);
      expect(receipt.attempts[1].outboundMessagesEvidence?.messagesSha256)
        .toBe(privateDigest({ system: null, messages: fallbackPayloads[index].messages }));
      expect(receipt.attempts[1].outboundMessagesEvidence?.toolDeclarationsSha256)
        .toBe(privateDigest(fallbackPayloads[index].tools || []));
      expect(receipt.attempts[1].outboundMessagesEvidence?.toolDeclarationCount)
        .toBe(payloadToolNames(fallbackPayloads[index]).length);
    }
    expect(planningReceipt!.attempts[1].outboundMessagesEvidence?.totalToolResultCount).toBe(0);
    expect(finalReceipt!.attempts[1].outboundMessagesEvidence?.totalToolResultCount).toBeGreaterThan(0);

    const currentMessages = getMessages(conversationId, 20);
    expect(currentMessages.some(row => (
      row.role === 'assistant'
      && row.requestId === requestId
      && String(row.message || '') === terminal.text
    ))).toBe(true);
    expect(currentMessages.some(row => (
      row.role === 'assistant'
      && /No successful current-turn tool execution|这一轮没有记录到成功/i.test(
        String(row.message || ''),
      )
    ))).toBe(false);
    expect(clientEvents.filter(event => event.event === 'agent:error' && event.payload?.requestId === requestId)).toEqual([]);
  }, 20_000);
});
