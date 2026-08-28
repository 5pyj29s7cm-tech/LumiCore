import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitChatTerminalBoundary } from '../server/socket/chat_terminal_boundary';
import {
  beginChatExecution,
  getChatExecution,
  initializeChatExecutionRegistryPersistence,
  recordChatExecutionTerminalEventDurably,
  resetChatExecutionRegistryForTests,
  type ChatExecutionPersistenceAdapter,
  type ChatExecutionScope,
  type PersistedChatExecutionReceipt,
} from '../server/socket/chat_execution_registry';
import {
  sanitizeVoiceAgentErrorPayload,
  voiceDurabilityUnknownText,
} from '../server/socket/voice_durability';

afterEach(() => {
  resetChatExecutionRegistryForTests();
  vi.restoreAllMocks();
});

function voiceReceiptMemory() {
  const rows: PersistedChatExecutionReceipt[] = [];
  const adapter: ChatExecutionPersistenceAdapter = {
    async loadRecoverable(nowIso) {
      return rows.filter(row => row.expiresAt > nowIso).map(row => structuredClone(row));
    },
    async upsert(receipt) {
      const index = rows.findIndex(row => row.requestId === receipt.requestId);
      if (index >= 0) rows.splice(index, 1, structuredClone(receipt));
      else rows.push(structuredClone(receipt));
    },
    async purgeExpired() {},
  };
  return { adapter, rows };
}

describe('voice durability', () => {
  it('keeps public voice errors fixed and free of internal exception text', () => {
    expect(sanitizeVoiceAgentErrorPayload()).toEqual({
      code: 'VOICE_EXECUTION_FAILED',
      message: 'The voice request could not be completed.',
    });
    expect(voiceDurabilityUnknownText()).not.toContain('stack');
  });

  it('publishes text and speech only after state, message, flush, and strict receipt', async () => {
    const order: string[] = [];
    const committed = await commitChatTerminalBoundary({
      persistTerminalState: () => { order.push('task_state'); },
      persistAssistantMessage: () => { order.push('assistant_message'); },
      flush: async () => { order.push('flush'); },
      persistTerminalReceipt: async () => {
        order.push('terminal_receipt');
        return true;
      },
      persistUnknownReceipt: async () => {
        order.push('unknown_receipt');
        return true;
      },
      publishCommitted: () => {
        order.push('publish_text');
        order.push('queue_speech');
      },
      publishUnknown: () => { order.push('publish_unknown'); },
    });

    expect(committed).toBe(true);
    expect(order).toEqual([
      'task_state',
      'assistant_message',
      'flush',
      'terminal_receipt',
      'publish_text',
      'queue_speech',
    ]);
  });

  it('publishes only persistence_unknown when the voice DB flush fails', async () => {
    const order: string[] = [];
    const committed = await commitChatTerminalBoundary({
      persistTerminalState: () => { order.push('task_state'); },
      persistAssistantMessage: () => { order.push('assistant_message'); },
      flush: async () => {
        order.push('flush_failed');
        throw new Error('disk unavailable');
      },
      persistTerminalReceipt: async () => {
        order.push('success_receipt');
        return true;
      },
      persistUnknownReceipt: async () => {
        order.push('unknown_receipt');
        return true;
      },
      publishCommitted: () => { order.push('publish_success'); },
      publishUnknown: () => { order.push('publish_unknown'); },
    });

    expect(committed).toBe(false);
    expect(order).toEqual([
      'task_state',
      'assistant_message',
      'flush_failed',
      'unknown_receipt',
      'publish_unknown',
    ]);
  });

  it('deduplicates a terminal owner and recovers the exact voice receipt after restart', async () => {
    const persistence = voiceReceiptMemory();
    const scope: ChatExecutionScope = {
      userId: 'voice-user',
      domain: 'personal',
      source: 'voice',
      conversationId: 'voice-conversation',
    };
    await initializeChatExecutionRegistryPersistence(persistence.adapter, Date.now());
    beginChatExecution(scope, 'voice-request-1');
    await expect(recordChatExecutionTerminalEventDurably(
      scope,
      'voice-request-1',
      'agent:response',
      { text: 'verified voice result', finalized: true, blocked: false },
      { text: voiceDurabilityUnknownText() },
    )).resolves.toBe(true);
    await expect(recordChatExecutionTerminalEventDurably(
      scope,
      'voice-request-1',
      'agent:response',
      { text: 'must not replay', finalized: true, blocked: false },
      { text: voiceDurabilityUnknownText() },
    )).resolves.toBe(false);

    resetChatExecutionRegistryForTests();
    await initializeChatExecutionRegistryPersistence(persistence.adapter, Date.now());
    expect(getChatExecution(scope, 'voice-request-1')).toMatchObject({
      terminal: true,
      status: 'completed',
      terminalEvent: { payload: { text: 'verified voice result' } },
    });
  });

  it('routes every in-turn terminal through the strict fence before speech', () => {
    const source = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');

    expect(source.match(/await commitVoiceTerminal\(\{/g)?.length || 0).toBeGreaterThanOrEqual(10);
    expect(source).not.toMatch(/emitAgent\(["']agent:response["']/);
    expect(source).not.toMatch(/emitAgent\(["']agent:error["']/);
    expect(source.match(/persistVoiceAssistantMessage\(/g)?.length || 0).toBe(1);
    expect(source.match(/queueFinalizedSpeech\(/g)?.length || 0).toBe(1);
    expect(source).toContain('flush: flushDBOrThrow');
    expect(source).toContain('recordChatExecutionTerminalEventDurably(');
    expect(source).toContain('recordChatExecutionPersistenceUnknownDurably(');
    expect(source).toContain('getChatExecution({');
    expect(source).not.toContain('executeWorkflow(');
    expect(source).not.toContain('socket.emit("audio:error", { message: err.message });');
    const strictHelper = source.slice(
      source.indexOf('const commitVoiceTerminal = async'),
      source.indexOf('const maxIterations =', source.indexOf('const commitVoiceTerminal = async')),
    );
    const dispositionAt = strictHelper.indexOf('terminalTaskDisposition: input.blocked');
    expect(dispositionAt).toBeGreaterThan(strictHelper.indexOf('persistVoiceAssistantMessage('));
    expect(strictHelper).not.toContain('settleConversationActionExecutionRequest(');
    expect(strictHelper.indexOf('flush: flushDBOrThrow')).toBeGreaterThan(dispositionAt);
    expect(source).toContain("socket.on('audio:cancel_turn', async");
    expect(source).toContain('await commitActiveVoiceCancellation(session, {');
    expect(source).toContain('publish: false');
  });

  it('keeps the immediate voice-switch acknowledgement path intact', () => {
    const source = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');
    const handler = source.slice(
      source.indexOf("socket.on('audio:switch-voice'"),
      source.indexOf('let chunkCount', source.indexOf("socket.on('audio:switch-voice'")),
    );
    expect(handler.indexOf('applyVoiceSwitchRequest(')).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf("socket.emit('audio:voice_changed'"))
      .toBeGreaterThan(handler.indexOf('applyVoiceSwitchRequest('));
  });
});
