import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  flushDBOrThrow,
  initDatabase,
  querySQL,
  readDB,
} from '../db_layer';
import {
  addMessageIdempotent,
  getMessages,
} from '../server/conversation/manager';
import { listModelRoutingReceipts } from '../server/llm/model_routing_receipts';
import { makeLLMCall } from '../server/llm/providers';

const binding = {
  nativeDeviceId: 'dev_native-binding-user_personal_fingerprint_native_41001_1787600000000',
  executionSessionId: '7'.repeat(64),
  nativeClientIdentitySha256: '8'.repeat(64),
};
const voiceProvenance = {
  ...binding,
  audioInputKind: 'physical_microphone' as const,
  syntheticAudio: false as const,
  captureSessionId: 'capture-native-persistence-0001',
  sttReceiptId: 'stt_00000000-0000-4000-8000-000000000001',
  contextChainId: '9'.repeat(64),
  previousRequestId: '',
};

describe('native request binding persistence', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `native-binding-user-${suffix}`;
  const conversationId = `native-binding-conversation-${suffix}`;

  beforeAll(async () => {
    await initDatabase();
    const db = readDB();
    db.conversations ||= [];
    db.conversations.push({
      id: conversationId,
      userId,
      agentId: 'lumi',
      title: 'Native request binding persistence',
      status: 'active',
      summary: '',
      messageCount: 0,
      lastActiveAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      domain: 'personal',
      orgId: '',
    });
  });

  it('persists the complete message binding and request identity across a database restart', async () => {
    const requestId = `native-message-request-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'Native-bound response.',
      source: 'chat',
      channel: 'chat',
      requestId,
      ...binding,
    });
    await flushDBOrThrow();

    const persisted = await querySQL<any>(
      `SELECT requestId, nativeDeviceId, executionSessionId, nativeClientIdentitySha256
       FROM interactions WHERE id = ? LIMIT 1`,
      [messageId],
    );
    expect(persisted[0]).toEqual({ requestId, ...binding });

    await closeDatabase();
    await initDatabase();
    expect(getMessages(conversationId).find(message => message.id === messageId)).toMatchObject({
      requestId,
      ...binding,
    });
  });

  it('propagates the same binding through the real model provider receipt path and survives restart', async () => {
    const requestId = `native-routing-request-${suffix}`;
    const response = await makeLLMCall(
      [{ role: 'user', content: 'Return a bound result.' }],
      [],
      {
        provider: 'deepseek',
        model: 'native-binding-model',
        userId,
        conversationId,
        requestId,
        interactionId: `native-routing-interaction-${suffix}`,
        source: 'chat',
        selectionMode: 'pinned',
        noImplicitFailover: true,
        ...binding,
      },
      () => ({
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { role: 'assistant', content: 'bound result' } }],
            }),
          },
        },
      }),
      () => null,
    );
    expect(response.text).toBe('bound result');
    await flushDBOrThrow();

    const receipt = listModelRoutingReceipts(userId, 1, { requestId })[0];
    expect(receipt).toMatchObject({ requestId, ...binding, status: 'succeeded' });
    const persisted = await querySQL<any>(
      `SELECT nativeDeviceId, executionSessionId, nativeClientIdentitySha256
       FROM model_routing_receipts WHERE id = ? LIMIT 1`,
      [receipt.id],
    );
    expect(persisted[0]).toEqual(binding);

    await closeDatabase();
    await initDatabase();
    expect(listModelRoutingReceipts(userId, 1, { requestId })[0]).toMatchObject({
      requestId,
      ...binding,
      status: 'succeeded',
    });
  });

  it('drops a partial tuple instead of persisting misleading native provenance', async () => {
    const requestId = `native-partial-request-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'Unbound response.',
      source: 'chat',
      channel: 'chat',
      requestId,
      nativeDeviceId: binding.nativeDeviceId,
      executionSessionId: binding.executionSessionId,
    });
    await flushDBOrThrow();
    const rows = await querySQL<any>(
      `SELECT nativeDeviceId, executionSessionId, nativeClientIdentitySha256
       FROM interactions WHERE id = ? LIMIT 1`,
      [messageId],
    );
    expect(rows[0]).toEqual({
      nativeDeviceId: '',
      executionSessionId: '',
      nativeClientIdentitySha256: '',
    });
  });

  it('persists one complete physical microphone/STT chain on both transcript and routing receipt', async () => {
    const requestId = `native-voice-request-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '这是从正式客户端麦克风进入的测试文本。',
      source: 'voice',
      channel: 'voice',
      requestId,
      ...voiceProvenance,
    });
    await makeLLMCall(
      [{ role: 'user', content: 'Return one voice-bound result.' }],
      [],
      {
        provider: 'deepseek',
        model: 'native-voice-binding-model',
        userId,
        conversationId,
        requestId,
        interactionId: `native-voice-routing-${suffix}`,
        source: 'voice',
        selectionMode: 'pinned',
        noImplicitFailover: true,
        ...voiceProvenance,
      },
      () => ({
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { role: 'assistant', content: 'voice bound' } }],
            }),
          },
        },
      }),
      () => null,
    );
    await flushDBOrThrow();

    const messageRows = await querySQL<any>(
      `SELECT audioInputKind, syntheticAudio, captureSessionId, sttReceiptId,
              contextChainId, previousRequestId
       FROM interactions WHERE id = ? LIMIT 1`,
      [messageId],
    );
    expect(messageRows[0]).toEqual({
      audioInputKind: 'physical_microphone',
      syntheticAudio: 0,
      captureSessionId: voiceProvenance.captureSessionId,
      sttReceiptId: voiceProvenance.sttReceiptId,
      contextChainId: voiceProvenance.contextChainId,
      previousRequestId: '',
    });
    const receipt = listModelRoutingReceipts(userId, 1, { requestId })[0];
    expect(receipt).toMatchObject(voiceProvenance);

    await closeDatabase();
    await initDatabase();
    expect(getMessages(conversationId).find(message => message.id === messageId)).toMatchObject(
      voiceProvenance,
    );
    expect(listModelRoutingReceipts(userId, 1, { requestId })[0]).toMatchObject(
      voiceProvenance,
    );
  });

  it('persists an explicit synthetic accepted transcript marker without native provenance', async () => {
    const requestId = `synthetic-voice-request-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '这是隔离 S6 接受的合成转写。',
      source: 'voice',
      channel: 'voice',
      mode: 'voice',
      requestId,
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
    });
    await flushDBOrThrow();

    const rows = await querySQL<any>(
      `SELECT audioInputKind, syntheticAudio, captureSessionId, sttReceiptId,
              contextChainId, nativeDeviceId, executionSessionId, nativeClientIdentitySha256
       FROM interactions WHERE id = ? LIMIT 1`,
      [messageId],
    );
    expect(rows[0]).toEqual({
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: 1,
      captureSessionId: '',
      sttReceiptId: '',
      contextChainId: '',
      nativeDeviceId: '',
      executionSessionId: '',
      nativeClientIdentitySha256: '',
    });

    await closeDatabase();
    await initDatabase();
    expect(getMessages(conversationId).find(message => message.id === messageId)).toMatchObject({
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
      captureSessionId: '',
      sttReceiptId: '',
      contextChainId: '',
      nativeDeviceId: '',
      executionSessionId: '',
      nativeClientIdentitySha256: '',
    });
  });
});
