import './helpers';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { getEvidenceKeyMaterial } from '../server/evidence/evidence_identity';
import { runWithTools } from '../server/llm/adapter';
import { listModelRoutingReceipts } from '../server/llm/model_routing_receipts';
import { capabilityContract, capabilityEvidence } from '../server/tools/capability_contracts';
import { ToolRegistry } from '../server/tools/registry';

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

function payloadText(payload: any): string {
  return JSON.stringify(payload?.messages || []);
}

describe('model failover tool continuity', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  afterEach(() => {
    resetCircuit();
    vi.clearAllMocks();
  });

  it('keeps primary failure, LM Studio tool execution, and final reply on one task/request chain', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userId = `s8-failover-${suffix}`;
    const conversationId = `s8-conversation-${suffix}`;
    const taskId = `s8-task-${suffix}`;
    const requestId = `s8-request-${suffix}`;
    const interactionId = `s8-interaction-${suffix}`;
    const sourceMessageId = `s8-user-message-${suffix}`;
    const primaryModel = `s8-primary-${suffix}`;
    const fallbackModel = `s8-lmstudio-${suffix}`;
    const toolName = `s8_continuity_probe_${suffix.replace(/[^a-z0-9_]/gi, '_')}`;
    const sentinel = `s8 verified sentinel ${suffix}`;
    const fixturePath = path.join(
      String(process.env.LUMI_DATA_DIR || ''),
      `s8-continuity-${suffix}.txt`,
    );
    fs.writeFileSync(fixturePath, sentinel, 'utf8');

    const toolHandler = vi.fn(async (args: Record<string, any>) => {
      const content = fs.readFileSync(String(args.path || ''), 'utf8');
      return JSON.stringify({
        ok: true,
        status: 'verified',
        path: String(args.path || ''),
        content,
        contentMatched: content === String(args.expected || ''),
        byteLength: Buffer.byteLength(content, 'utf8'),
      });
    });
    const registry = new ToolRegistry();
    registry.register({
      name: toolName,
      description: 'Read the isolated S8 fixture and return a verified continuity receipt.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          expected: { type: 'string' },
        },
        required: ['path', 'expected'],
      },
      handler: toolHandler,
      permission: 'public',
      securityLevel: 'safe',
      capability: capabilityContract({
        id: 'test.s8.continuity.probe',
        family: 'test',
        lane: 'files',
        operation: 'test',
        risk: 'low',
        sideEffects: [{ type: 'local_read', scope: 'isolated S8 test fixture', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok', 'status', 'path', 'content', 'contentMatched', 'byteLength'],
          requiredValues: { ok: true, status: 'verified', contentMatched: true },
          successStatuses: ['verified'],
          requiredArtifacts: ['path'],
          successSignals: ['the isolated fixture exists and its exact sentinel was returned'],
          limitations: ['This capability is scoped to the isolated Vitest data root.'],
        },
      }),
      evidence: capabilityEvidence({
        id: 'test.s8.continuity.probe',
        operation: 'test',
        subjectArgument: 'path',
      }),
    });

    const primaryPayloads: any[] = [];
    const fallbackPayloads: any[] = [];
    const primaryCreate = vi.fn(async (payload: any) => {
      primaryPayloads.push(structuredClone(payload));
      throw new Error('ECONNREFUSED deterministic S8 primary provider failure');
    });
    const fallbackCreate = vi.fn(async (payload: any) => {
      fallbackPayloads.push(structuredClone(payload));
      if (fallbackPayloads.length === 1) {
        return (async function* toolPlan() {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `s8-tool-call-${suffix}`,
                  function: {
                    name: toolName,
                    arguments: JSON.stringify({ path: fixturePath, expected: sentinel }),
                  },
                }],
              },
            }],
            usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
          };
        })();
      }
      return (async function* finalReply() {
        yield {
          choices: [{ delta: { content: `S8 continuity result: ${sentinel}.` } }],
          usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 },
        };
      })();
    });
    const primary = { chat: { completions: { create: primaryCreate } } };
    const lmstudio = { chat: { completions: { create: fallbackCreate } } };
    const visibleChunks: string[] = [];

    const result = await runWithTools(
      [{
        role: 'user',
        content: 'Run exactly one isolated S8 continuity probe and report its exact verified sentinel.',
        sourceMessageId,
      }],
      registry,
      {
        provider: 'deepseek',
        model: primaryModel,
        userId,
        domain: 'personal',
        orgId: '',
        conversationId,
        requestId,
        interactionId,
        source: 'chat',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'lmstudio', model: fallbackModel }],
        allowCloudFallback: true,
        attemptTimeouts: ATTEMPT_TIMEOUTS,
        modelWaitBudgetMs: 5_000,
      },
      undefined,
      3,
      () => primary,
      () => null,
      () => null,
      () => null,
      () => null,
      chunk => visibleChunks.push(chunk),
      {
        userId,
        authenticated: true,
        authRole: 'admin',
        localExecution: true,
        executionBoundary: 'trusted_local',
        taskId,
        conversationId,
        turnId: requestId,
        requestId,
        domain: 'personal',
        orgId: '',
        source: 'chat',
        actionIntent: 'Run exactly one isolated S8 continuity probe.',
        routedTaskText: 'Run exactly one isolated S8 continuity probe and report its exact verified sentinel.',
        toolPolicy: {
          allowedTools: [toolName],
          requireConfirmation: [],
          forbiddenTools: [],
          maxIterations: 3,
        },
        modelToolProjection: {
          toolNames: [toolName],
          maxTools: 1,
          allowDynamicDiscovery: false,
        },
      },
      () => null,
      () => lmstudio,
    );

    expect(result.text).toBe(`S8 continuity result: ${sentinel}.`);
    expect(visibleChunks).toEqual([`S8 continuity result: ${sentinel}.`]);
    expect(primaryCreate).toHaveBeenCalledTimes(2);
    expect(fallbackCreate).toHaveBeenCalledTimes(2);
    expect(toolHandler).toHaveBeenCalledTimes(1);
    expect(primaryPayloads).toHaveLength(2);
    expect(fallbackPayloads).toHaveLength(2);
    expect(primaryPayloads.every(payload => payload.model === primaryModel && payload.stream === true)).toBe(true);
    expect(fallbackPayloads.every(payload => payload.model === fallbackModel && payload.stream === true)).toBe(true);
    expect(primaryPayloads.slice(0, 1).every(payload => !payloadText(payload).includes(sentinel))).toBe(true);
    expect(fallbackPayloads.slice(0, 1).every(payload => !payloadText(payload).includes(sentinel))).toBe(true);
    expect(payloadText(primaryPayloads[1])).toContain(sentinel);
    expect(payloadText(fallbackPayloads[1])).toContain(sentinel);
    expect(primaryPayloads[1].messages.some((message: any) => message.role === 'tool')).toBe(true);
    expect(fallbackPayloads[1].messages.some((message: any) => message.role === 'tool')).toBe(true);

    expect(result.toolCalls).toHaveLength(1);
    const toolRecord = result.toolCalls[0];
    expect(toolRecord).toMatchObject({
      taskId,
      turnId: requestId,
      requestId,
      name: toolName,
      arguments: { path: fixturePath, expected: sentinel },
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt' },
      envelope: {
        taskId,
        turnId: requestId,
        requestId,
        status: 'verified_success',
      },
      modelRoutingReceiptId: expect.any(String),
      executionOrigin: 'model_selected',
    });
    expect(JSON.parse(toolRecord.result)).toMatchObject({
      ok: true,
      status: 'verified',
      path: fixturePath,
      content: sentinel,
      contentMatched: true,
    });

    const receipts = listModelRoutingReceipts(userId, 10, { conversationId, requestId });
    expect(receipts).toHaveLength(2);
    expect(receipts.every(receipt => (
      receipt.status === 'succeeded'
      && receipt.conversationId === conversationId
      && receipt.requestId === requestId
      && receipt.interactionId === interactionId
      && receipt.source === 'chat'
      && receipt.requestedProvider === 'deepseek'
      && receipt.requestedModel === primaryModel
      && receipt.selectedProvider === 'lmstudio'
      && receipt.selectedModel === fallbackModel
      && receipt.fallbackReason === 'provider_unreachable'
    ))).toBe(true);
    expect(receipts.every(receipt => (
      receipt.attempts.length === 2
      && receipt.attempts[0].provider === 'deepseek'
      && receipt.attempts[0].status === 'failed'
      && receipt.attempts[0].reason === 'provider_unreachable'
      && receipt.attempts[0].visibleOutputCommitted === false
      && receipt.attempts[1].provider === 'lmstudio'
      && receipt.attempts[1].status === 'succeeded'
    ))).toBe(true);

    const planningReceipt = receipts.find(receipt => receipt.id === toolRecord.modelRoutingReceiptId);
    expect(planningReceipt).toBeDefined();
    const finalReceipt = receipts.find(receipt => receipt.id !== toolRecord.modelRoutingReceiptId);
    expect(finalReceipt).toBeDefined();
    for (const [receipt, index] of [[planningReceipt!, 0], [finalReceipt!, 1]] as const) {
      expect(receipt.attempts[0].outboundMessagesEvidence?.messagesSha256)
        .toBe(privateDigest({ system: null, messages: primaryPayloads[index].messages }));
      expect(receipt.attempts[1].outboundMessagesEvidence?.messagesSha256)
        .toBe(privateDigest({ system: null, messages: fallbackPayloads[index].messages }));
      expect(receipt.attempts[0].outboundMessagesEvidence).toMatchObject({
        provider: 'deepseek',
        model: primaryModel,
        source: 'provider_adapter_outbound_request',
      });
      expect(receipt.attempts[1].outboundMessagesEvidence).toMatchObject({
        provider: 'lmstudio',
        model: fallbackModel,
        source: 'provider_adapter_outbound_request',
      });
    }
    expect(planningReceipt!.attempts[1].outboundMessagesEvidence?.totalToolResultCount).toBe(0);
    expect(finalReceipt!.attempts[1].outboundMessagesEvidence?.totalToolResultCount).toBeGreaterThan(0);
    expect(result.usageRecords).toEqual([
      expect.objectContaining({
        provider: 'lmstudio',
        model: fallbackModel,
        requestedProvider: 'deepseek',
        requestedModel: primaryModel,
        selectionMode: 'ordered_fallback',
        fallbackReason: 'provider_unreachable',
        totalTokens: 14,
      }),
      expect.objectContaining({
        provider: 'lmstudio',
        model: fallbackModel,
        requestedProvider: 'deepseek',
        requestedModel: primaryModel,
        selectionMode: 'ordered_fallback',
        fallbackReason: 'provider_unreachable',
        totalTokens: 24,
      }),
    ]);
  });
});
