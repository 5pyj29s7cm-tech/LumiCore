import './helpers';
import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import {
  buildProviderOutboundMessagesEvidence,
  normalizeProviderOutboundMessagesEvidence,
} from '../server/llm/outbound_message_evidence';
import { getEvidenceKeyMaterial } from '../server/evidence/evidence_identity';

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

function sha256Stable(value: unknown): string {
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

function providerGetters(input: {
  deepseek?: any;
  lmstudio?: any;
}) {
  return [
    () => input.deepseek || null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => input.lmstudio || null,
  ] as const;
}

const deadlines = {
  requestMs: 100,
  firstByteMs: 100,
  semanticContentMs: 100,
  idleMs: 100,
  absoluteMs: 500,
};

describe('provider outbound message evidence', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  afterEach(() => {
    resetCircuit();
    vi.clearAllMocks();
  });

  it('hashes each exact formatted content slot, preserves normalized role order, and stores no text', () => {
    const messages = [
      { role: 'system', content: 'system instruction' },
      { role: 'user', content: '不是这个文件，改成桌面上的合同.docx' },
      { role: 'model', parts: [{ text: 'I will use the corrected target.' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'file_read', response: { content: 'ok' } } }] },
    ];
    const evidence = buildProviderOutboundMessagesEvidence({
      provider: 'gemini',
      model: 'gemini-test',
      requestFormat: 'gemini',
      messages,
      toolDeclarations: [{
        functionDeclarations: [{
          name: 'file_read',
          description: 'https://private.example/signed',
          parameters: { path: 'secret' },
        }],
      }],
      sourceMessageId: 'message-known-correction',
      sourceMessageIndex: 1,
    });

    expect(evidence.messages.map(item => ({ index: item.index, role: item.role }))).toEqual([
      { index: 0, role: 'system' },
      { index: 1, role: 'user' },
      { index: 2, role: 'assistant' },
      { index: 3, role: 'tool' },
    ]);
    expect(evidence.messages[1]).toMatchObject({
      sourceMessageId: 'message-known-correction',
      contentSha256: sha256Stable(messages[1].content),
      payloadSha256: sha256Stable(messages[1]),
      textCharCount: messages[1].content.length,
    });
    const changed = buildProviderOutboundMessagesEvidence({
      provider: 'gemini',
      model: 'gemini-test',
      requestFormat: 'gemini',
      messages: [
        messages[0],
        { ...messages[1], content: `${messages[1].content}。` },
        messages[2],
        messages[3],
      ],
      toolDeclarations: [],
    });
    expect(changed.messages[1].contentSha256).not.toBe(evidence.messages[1].contentSha256);
    expect(JSON.stringify(evidence)).not.toContain(messages[1].content);
    expect(JSON.stringify(evidence)).not.toContain('合同.docx');
    expect(JSON.stringify(evidence)).not.toContain('secret');
    expect(JSON.stringify(evidence)).not.toContain('https://private.example/signed');
    expect(evidence.digestProtection).toBe('installation_hmac_sha256_v1');
    expect(normalizeProviderOutboundMessagesEvidence(evidence)).toEqual(evidence);
    const unknownTopLevel = { ...evidence, rawText: messages[1].content };
    expect(normalizeProviderOutboundMessagesEvidence(unknownTopLevel)).toBeNull();
    const unknownMessageField = structuredClone(evidence) as any;
    unknownMessageField.messages[0].apiKey = 'should-never-persist';
    expect(normalizeProviderOutboundMessagesEvidence(unknownMessageField)).toBeNull();
    const tampered = structuredClone(evidence);
    tampered.messagesSha256 = 'f'.repeat(64);
    expect(normalizeProviderOutboundMessagesEvidence(tampered)).toBeNull();
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'unknown-role-model',
      requestFormat: 'openai_compatible',
      messages: [{ role: 'developer', content: 'must fail closed' }],
    })).toThrow('provider_outbound_evidence_role_invalid');
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'invalid-format-model',
      requestFormat: 'other' as any,
      messages: [],
    })).toThrow('provider_outbound_evidence_request_format_invalid');
    const circular: Record<string, unknown> = { role: 'user', content: 'loop' };
    circular.self = circular;
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'circular-model',
      requestFormat: 'openai_compatible',
      messages: [circular],
    })).toThrow('provider_outbound_evidence_circular_value');
    let tooDeep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 100; index += 1) tooDeep = { nested: tooDeep };
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'deep-model',
      requestFormat: 'openai_compatible',
      messages: [{ role: 'user', content: tooDeep }],
    })).toThrow('provider_outbound_evidence_depth_exceeded');
    class ExoticArray extends Array<unknown> {
      toJSON() { return ['wire-value-differs']; }
    }
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'array-to-json-model',
      requestFormat: 'openai_compatible',
      messages: [{ role: 'user', content: new ExoticArray('evidence-value') }],
    })).toThrow('provider_outbound_evidence_object_unsupported');
    const hiddenToJson: Record<string, unknown> = { text: 'evidence-value' };
    Object.defineProperty(hiddenToJson, 'toJSON', {
      enumerable: false,
      value: () => ({ text: 'wire-value-differs' }),
    });
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'hidden-to-json-model',
      requestFormat: 'openai_compatible',
      messages: [{ role: 'user', content: hiddenToJson }],
    })).toThrow('provider_outbound_evidence_property_unsupported');
    const accessorContent: Record<string, unknown> = {};
    Object.defineProperty(accessorContent, 'text', {
      enumerable: true,
      get: () => 'wire-value',
    });
    expect(() => buildProviderOutboundMessagesEvidence({
      provider: 'custom',
      model: 'accessor-model',
      requestFormat: 'openai_compatible',
      messages: [{ role: 'user', content: accessorContent }],
    })).toThrow('provider_outbound_evidence_property_unsupported');
  });

  it('persists actual formatted payload evidence for a direct success and ignores caller-shaped config data', async () => {
    const userId = `outbound-direct-${crypto.randomUUID()}`;
    let actualPayload: any;
    const deepseek = {
      chat: { completions: { create: vi.fn(async (payload: any) => {
        actualPayload = structuredClone(payload);
        return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
      }) } },
    };
    const { makeLLMCall } = await import('../server/llm/providers');
    const result = await makeLLMCall(
      [
        { role: 'system', content: 'bounded system instruction' },
        { role: 'user', content: 'private correction payload', sourceMessageId: 'message-direct-evidence' },
      ],
      [],
      {
        provider: 'deepseek',
        model: 'direct-evidence-model',
        userId,
        conversationId: 'conversation-direct-evidence',
        requestId: 'request-direct-evidence',
        selectionMode: 'pinned',
        attemptTimeouts: deadlines,
        // Deliberately shaped like evidence: this field is not part of the
        // config contract and must never replace adapter-derived evidence.
        outboundMessagesEvidence: {
          messagesSha256: 'f'.repeat(64),
          messages: [{ sourceMessageId: 'caller-forged-message-id' }],
        },
      } as any,
      ...providerGetters({ deepseek }),
    );

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-direct-evidence' })[0];
    const evidence = receipt.attempts[0].outboundMessagesEvidence!;
    expect(evidence.messagesSha256).toBe(sha256Stable({ system: null, messages: actualPayload.messages }));
    expect(evidence.messages.map(item => item.role)).toEqual(actualPayload.messages.map((item: any) => item.role));
    expect(evidence.messages[1].contentSha256).toBe(sha256Stable(actualPayload.messages[1].content));
    expect(evidence.messages.map(item => item.sourceMessageId)).toEqual([
      null,
      'message-direct-evidence',
    ]);
    expect(evidence.messagesSha256).not.toBe('f'.repeat(64));
    expect(JSON.stringify(evidence)).not.toContain('private correction payload');
    expect(JSON.stringify(evidence)).not.toContain('caller-forged-message-id');
    expect(JSON.stringify(actualPayload)).not.toContain('sourceMessageId');
    expect(JSON.stringify(actualPayload)).not.toContain('message-direct-evidence');
    expect(result).not.toHaveProperty('_providerOutboundMessagesEvidence');
  });

  it('binds sourceMessageId to the real user slot instead of a tool-result fallback encoded as user', async () => {
    const userId = `outbound-source-slot-${crypto.randomUUID()}`;
    const deepseek = {
      chat: { completions: { create: vi.fn(async () => ({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      })) } },
    };
    const { makeLLMCall } = await import('../server/llm/providers');
    await makeLLMCall(
      [
        { role: 'user', content: 'the accepted durable user turn', sourceMessageId: 'message-source-slot' },
        {
          role: 'assistant',
          content: 'working',
          toolCalls: [{ id: 'call-1', name: 'file_read', arguments: { path: 'x' } }],
        },
        { role: 'tool', name: 'file_read', content: 'fallback tool result without call id' },
      ],
      [],
      {
        provider: 'deepseek',
        model: 'source-slot-model',
        userId,
        conversationId: 'conversation-source-slot',
        requestId: 'request-source-slot',
        selectionMode: 'pinned',
        attemptTimeouts: deadlines,
      },
      ...providerGetters({ deepseek }),
    );

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-source-slot' })[0];
    const messages = receipt.attempts[0].outboundMessagesEvidence?.messages || [];
    expect(messages.map(message => ({ role: message.role, sourceMessageId: message.sourceMessageId })))
      .toEqual([
        { role: 'user', sourceMessageId: 'message-source-slot' },
        { role: 'assistant', sourceMessageId: null },
        { role: 'user', sourceMessageId: null },
      ]);
  });

  it('persists provider-bound evidence for a real streaming adapter call', async () => {
    const userId = `outbound-stream-${crypto.randomUUID()}`;
    const deepseek = {
      chat: { completions: { create: vi.fn(async () => (async function* stream() {
        yield { choices: [{ delta: { content: 'streamed evidence' } }] };
      })()) } },
    };
    const { makeLLMCallStreaming } = await import('../server/llm/providers');
    const chunks: string[] = [];
    const result = await makeLLMCallStreaming(
      [{ role: 'user', content: 'capture the streaming request boundary', sourceMessageId: 'message-stream-evidence' }],
      [],
      {
        provider: 'deepseek',
        model: 'stream-evidence-model',
        userId,
        conversationId: 'conversation-stream-evidence',
        requestId: 'request-stream-evidence',
        selectionMode: 'pinned',
        attemptTimeouts: deadlines,
      },
      chunk => chunks.push(chunk),
      ...providerGetters({ deepseek }),
    );

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-stream-evidence' })[0];
    expect(result.text).toBe('streamed evidence');
    expect(chunks.join('')).toBe('streamed evidence');
    expect(receipt.attempts[0].outboundMessagesEvidence).toMatchObject({
      provider: 'deepseek',
      model: 'stream-evidence-model',
      source: 'provider_adapter_outbound_request',
      digestProtection: 'installation_hmac_sha256_v1',
      messages: [expect.objectContaining({ sourceMessageId: 'message-stream-evidence' })],
    });
  });

  it('keeps synthetic recovery user instructions from stealing durable source provenance', async () => {
    const sourceMessageId = 'message-recovery-source';
    const messages = [
      { role: 'user' as const, content: 'accepted durable instruction', sourceMessageId },
      { role: 'assistant' as const, content: 'incomplete first answer' },
      { role: 'user' as const, content: 'synthetic server recovery instruction' },
    ];
    const providers = [
      {
        provider: 'deepseek',
        client: {
          chat: { completions: { create: vi.fn(async () => ({
            choices: [{ message: { role: 'assistant', content: 'recovered' } }],
          })) } },
        },
      },
      {
        provider: 'gemini',
        client: {
          getGenerativeModel: vi.fn(() => ({
            generateContent: vi.fn(async () => ({
              candidates: [{ content: { parts: [{ text: 'recovered' }] } }],
            })),
          })),
        },
      },
      {
        provider: 'anthropic',
        client: {
          messages: { create: vi.fn(async () => ({
            content: [{ type: 'text', text: 'recovered' }],
          })) },
        },
      },
    ] as const;
    const { makeLLMCall } = await import('../server/llm/providers');
    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');

    for (const item of providers) {
      const userId = `outbound-recovery-${item.provider}-${crypto.randomUUID()}`;
      const requestId = `request-recovery-${item.provider}`;
      await makeLLMCall(
        messages,
        [],
        {
          provider: item.provider,
          model: `${item.provider}-recovery-model`,
          userId,
          conversationId: `conversation-recovery-${item.provider}`,
          requestId,
          selectionMode: 'pinned',
          attemptTimeouts: deadlines,
        },
        () => item.provider === 'deepseek' ? item.client : null,
        () => item.provider === 'gemini' ? item.client : null,
        () => null,
        () => item.provider === 'anthropic' ? item.client : null,
      );
      const receipt = listModelRoutingReceipts(userId, 10, { requestId })[0];
      const evidenceMessages = receipt.attempts[0].outboundMessagesEvidence?.messages || [];
      expect(evidenceMessages.filter(message => message.sourceMessageId === sourceMessageId))
        .toHaveLength(1);
      expect(evidenceMessages.findIndex(message => message.sourceMessageId === sourceMessageId))
        .toBeLessThan(evidenceMessages.length - 1);
      expect(evidenceMessages.at(-1)?.sourceMessageId).toBeNull();
    }
  });

  it('persists separate real payload evidence for a failed primary and successful LM Studio continuation', async () => {
    const userId = `outbound-failover-${crypto.randomUUID()}`;
    const captured: Record<string, any> = {};
    const deepseek = {
      chat: { completions: { create: vi.fn(async (payload: any) => {
        captured.deepseek = structuredClone(payload);
        throw new Error('402 Payment Required: insufficient balance');
      }) } },
    };
    const lmstudio = {
      chat: { completions: { create: vi.fn(async (payload: any) => {
        captured.lmstudio = structuredClone(payload);
        return { choices: [{ message: { role: 'assistant', content: 'continued locally' } }] };
      }) } },
    };
    const { makeLLMCall } = await import('../server/llm/providers');
    const result = await makeLLMCall(
      [{ role: 'user', content: 'continue the exact task after primary failure', sourceMessageId: 'message-failover-evidence' }],
      [],
      {
        provider: 'deepseek',
        model: 'primary-model',
        userId,
        conversationId: 'conversation-failover-evidence',
        requestId: 'request-failover-evidence',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'lmstudio', model: 'local-fallback-model' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      ...providerGetters({ deepseek, lmstudio }),
    );

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-failover-evidence' })[0];
    expect(result.text).toBe('continued locally');
    expect(receipt.attempts).toHaveLength(2);
    expect(receipt.attempts.map(attempt => ({
      provider: attempt.provider,
      status: attempt.status,
      evidenceProvider: attempt.outboundMessagesEvidence?.provider,
    }))).toEqual([
      { provider: 'deepseek', status: 'failed', evidenceProvider: 'deepseek' },
      { provider: 'lmstudio', status: 'succeeded', evidenceProvider: 'lmstudio' },
    ]);
    for (const attempt of receipt.attempts) {
      const payload = captured[attempt.provider];
      expect(attempt.outboundMessagesEvidence?.messagesSha256)
        .toBe(sha256Stable({ system: null, messages: payload.messages }));
      expect(attempt.outboundMessagesEvidence?.messages[0].contentSha256)
        .toBe(sha256Stable(payload.messages[0].content));
      expect(attempt.outboundMessagesEvidence?.messages[0].sourceMessageId)
        .toBe('message-failover-evidence');
    }
  });

  it('retains adapter evidence when a provider returns an empty semantic response', async () => {
    const userId = `outbound-empty-${crypto.randomUUID()}`;
    const deepseek = {
      chat: { completions: { create: vi.fn(async () => ({
        choices: [{ message: { role: 'assistant', content: '' } }],
      })) } },
    };
    const lmstudio = {
      chat: { completions: { create: vi.fn(async () => ({
        choices: [{ message: { role: 'assistant', content: 'fallback after empty response' } }],
      })) } },
    };
    const { makeLLMCall } = await import('../server/llm/providers');
    const result = await makeLLMCall(
      [{ role: 'user', content: 'continue after an empty response', sourceMessageId: 'message-empty-evidence' }],
      [],
      {
        provider: 'deepseek',
        model: 'empty-primary',
        userId,
        conversationId: 'conversation-empty-evidence',
        requestId: 'request-empty-evidence',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'lmstudio', model: 'empty-fallback' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      ...providerGetters({ deepseek, lmstudio }),
    );

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-empty-evidence' })[0];
    expect(result.text).toBe('fallback after empty response');
    expect(receipt.attempts).toHaveLength(2);
    expect(receipt.attempts[0]).toMatchObject({
      provider: 'deepseek',
      status: 'failed',
      reason: 'empty_response',
    });
    expect(receipt.attempts[0].outboundMessagesEvidence).toMatchObject({
      provider: 'deepseek',
      source: 'provider_adapter_outbound_request',
    });
    expect(receipt.attempts[1].outboundMessagesEvidence).toMatchObject({
      provider: 'lmstudio',
      source: 'provider_adapter_outbound_request',
    });
  });

  it('preserves prior attempts and the cancelled attempt evidence when fallback is aborted', async () => {
    const userId = `outbound-abort-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const deepseek = {
      chat: { completions: { create: vi.fn(async () => {
        throw new Error('402 Payment Required: primary unavailable');
      }) } },
    };
    const lmstudio = {
      chat: { completions: { create: vi.fn(async (_payload: any, options?: { signal?: AbortSignal }) => (
        new Promise((_resolve, reject) => {
          const fail = () => reject(options?.signal?.reason
            || new DOMException('cancelled', 'AbortError'));
          if (options?.signal?.aborted) fail();
          else options?.signal?.addEventListener('abort', fail, { once: true });
        })
      )) } },
    };
    const { makeLLMCall } = await import('../server/llm/providers');
    const pending = makeLLMCall(
      [{ role: 'user', content: 'cancel only after fallback starts', sourceMessageId: 'message-abort-evidence' }],
      [],
      {
        provider: 'deepseek',
        model: 'abort-primary',
        userId,
        conversationId: 'conversation-abort-evidence',
        requestId: 'request-abort-evidence',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'lmstudio', model: 'abort-fallback' }],
        allowCloudFallback: true,
        signal: controller.signal,
        attemptTimeouts: deadlines,
      },
      ...providerGetters({ deepseek, lmstudio }),
    );
    await vi.waitFor(() => expect(lmstudio.chat.completions.create).toHaveBeenCalled());
    controller.abort(new DOMException('cancelled by test', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-abort-evidence' })[0];
    expect(receipt.fallbackReason).toBe('cancelled');
    expect(receipt.attempts.map(attempt => ({
      provider: attempt.provider,
      status: attempt.status,
      evidence: attempt.outboundMessagesEvidence?.source,
    }))).toEqual([
      { provider: 'deepseek', status: 'failed', evidence: 'provider_adapter_outbound_request' },
      { provider: 'lmstudio', status: 'failed', evidence: 'provider_adapter_outbound_request' },
    ]);
  });

  it('retains outbound evidence on every attempted route when all providers fail', async () => {
    const userId = `outbound-all-failed-${crypto.randomUUID()}`;
    const captured: Record<string, any> = {};
    const deepseek = {
      chat: { completions: { create: vi.fn(async (payload: any) => {
        captured.deepseek = structuredClone(payload);
        throw new Error('402 Payment Required: primary unavailable');
      }) } },
    };
    const lmstudio = {
      chat: { completions: { create: vi.fn(async (payload: any) => {
        captured.lmstudio = structuredClone(payload);
        throw new Error('401 Unauthorized: local fallback unavailable');
      }) } },
    };
    const { makeLLMCall } = await import('../server/llm/providers');
    await expect(makeLLMCall(
      [{ role: 'user', content: 'retain evidence even when all routes fail', sourceMessageId: 'message-all-failed-evidence' }],
      [],
      {
        provider: 'deepseek',
        model: 'all-failed-primary',
        userId,
        conversationId: 'conversation-all-failed-evidence',
        requestId: 'request-all-failed-evidence',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'lmstudio', model: 'all-failed-local' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      ...providerGetters({ deepseek, lmstudio }),
    )).rejects.toThrow('local fallback unavailable');

    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-all-failed-evidence' })[0];
    expect(receipt.status).toBe('failed');
    expect(receipt.attempts.map(attempt => ({
      provider: attempt.provider,
      status: attempt.status,
      evidence: attempt.outboundMessagesEvidence?.source,
    }))).toEqual([
      { provider: 'deepseek', status: 'failed', evidence: 'provider_adapter_outbound_request' },
      { provider: 'lmstudio', status: 'failed', evidence: 'provider_adapter_outbound_request' },
    ]);
    for (const attempt of receipt.attempts) {
      expect(attempt.outboundMessagesEvidence?.messagesSha256)
        .toBe(sha256Stable({ system: null, messages: captured[attempt.provider].messages }));
      expect(attempt.outboundMessagesEvidence?.messages[0].sourceMessageId)
        .toBe('message-all-failed-evidence');
    }
  });

  it('retains a late twentieth route attempt and rejects evidence bound to another candidate', async () => {
    const userId = `outbound-long-route-${crypto.randomUUID()}`;
    const finalEvidence = buildProviderOutboundMessagesEvidence({
      provider: 'deepseek',
      model: 'candidate-20',
      requestFormat: 'openai_compatible',
      messages: [{ role: 'user', content: 'late route success' }],
      sourceMessageId: 'message-long-route',
      sourceMessageIndex: 0,
    });
    const attempts = Array.from({ length: 20 }, (_, index) => ({
      provider: 'deepseek',
      model: `candidate-${index + 1}`,
      status: index === 19 ? 'succeeded' as const : 'failed' as const,
      ...(index === 19 ? { outboundMessagesEvidence: finalEvidence } : {}),
    }));
    const {
      listModelRoutingReceipts,
      persistModelRoutingReceipt,
    } = await import('../server/llm/model_routing_receipts');
    persistModelRoutingReceipt({
      userId,
      domain: 'personal',
      orgId: '',
      conversationId: 'conversation-long-route',
      requestId: 'request-long-route',
      interactionId: '',
      source: 'test',
      status: 'succeeded',
      requestedProvider: 'auto',
      requestedModel: 'auto',
      selectionMode: 'auto',
      selectedProvider: 'deepseek',
      selectedModel: 'candidate-20',
      fallbackReason: 'candidate_failed',
      attempts,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
    });
    const receipt = listModelRoutingReceipts(userId, 10, { requestId: 'request-long-route' })[0];
    expect(receipt.attempts).toHaveLength(20);
    expect(receipt.attempts[19].outboundMessagesEvidence).toEqual(finalEvidence);

    expect(() => persistModelRoutingReceipt({
      userId,
      domain: 'personal',
      orgId: '',
      conversationId: 'conversation-mismatch',
      requestId: 'request-mismatch',
      interactionId: '',
      source: 'test',
      status: 'succeeded',
      requestedProvider: 'deepseek',
      requestedModel: 'different-candidate',
      selectionMode: 'pinned',
      selectedProvider: 'deepseek',
      selectedModel: 'different-candidate',
      fallbackReason: '',
      attempts: [{
        provider: 'deepseek',
        model: 'different-candidate',
        status: 'succeeded',
        outboundMessagesEvidence: finalEvidence,
      }],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
    })).toThrow('model_routing_outbound_evidence_attempt_mismatch');
  });
});
