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
  persistVoiceWorkflowCheckpointDurably,
  sanitizeVoiceAgentErrorPayload,
  VoiceWorkflowCheckpointError,
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

describe('voice workflow durability', () => {
  const graph = {
    graphId: 'voice-graph-1',
    taskId: 'voice-task-1',
    nodes: [],
    arbitration: 'first_verified',
  } as any;
  const recoveredReceipt = {
    graphId: 'voice-graph-1',
    taskId: 'voice-task-1',
    nodeId: 'recovered-node',
  } as any;
  const waveReceipt = {
    graphId: 'voice-graph-1',
    taskId: 'voice-task-1',
    nodeId: 'wave-node',
  } as any;

  it('persists the private handoff and receipts, then flushes before continuing', async () => {
    const order: string[] = [];
    const privateNodeHandoffs = [{
      graphId: graph.graphId,
      taskId: graph.taskId,
      nodeId: 'wave-node',
      outputDigest: 'a'.repeat(64),
      outputSummary: 'PRIVATE_VOICE_HANDOFF',
      evidenceKind: 'validated_model_output' as const,
    }];

    await persistVoiceWorkflowCheckpointDurably({
      conversationId: 'voice-conversation-1',
      userId: 'voice-user',
      taskId: graph.taskId,
      checkpoint: {
        phase: 'wave_completed',
        executionGraph: graph,
        nodeReceipts: [waveReceipt],
        privateNodeHandoffs,
        completedNodeIds: ['wave-node'],
      },
    }, {
      persist: input => {
        order.push(`persist:${input.nodeReceipts[0]?.nodeId}`);
        expect(input.privateNodeHandoffs).toEqual(privateNodeHandoffs);
        return true;
      },
      flush: async () => { order.push('flush'); },
    });

    expect(order).toEqual(['persist:wave-node', 'flush']);
  });

  it('preserves verified restart receipts at the compiled fence', async () => {
    const persisted: any[] = [];
    await persistVoiceWorkflowCheckpointDurably({
      conversationId: 'voice-conversation-1',
      userId: 'voice-user',
      taskId: graph.taskId,
      resumeNodeReceipts: [recoveredReceipt],
      checkpoint: {
        phase: 'compiled',
        executionGraph: graph,
        nodeReceipts: [],
        privateNodeHandoffs: [],
        completedNodeIds: [],
      },
    }, {
      persist: input => {
        persisted.push(input);
        return true;
      },
      flush: async () => undefined,
    });

    expect(persisted[0].nodeReceipts).toEqual([recoveredReceipt]);
    expect(persisted[0].privateNodeHandoffs).toBeUndefined();
  });

  it('fails closed when checkpoint persistence or its flush fails', async () => {
    const flush = vi.fn(async () => undefined);
    await expect(persistVoiceWorkflowCheckpointDurably({
      conversationId: 'voice-conversation-1',
      userId: 'voice-user',
      taskId: graph.taskId,
      checkpoint: {
        phase: 'compiled',
        executionGraph: graph,
        nodeReceipts: [],
        privateNodeHandoffs: [],
        completedNodeIds: [],
      },
    }, {
      persist: () => false,
      flush,
    })).rejects.toBeInstanceOf(VoiceWorkflowCheckpointError);
    expect(flush).not.toHaveBeenCalled();

    await expect(persistVoiceWorkflowCheckpointDurably({
      conversationId: 'voice-conversation-1',
      userId: 'voice-user',
      taskId: graph.taskId,
      checkpoint: {
        phase: 'wave_completed',
        executionGraph: graph,
        nodeReceipts: [waveReceipt],
        privateNodeHandoffs: [],
        completedNodeIds: ['wave-node'],
      },
    }, {
      persist: () => true,
      flush: async () => { throw new Error('disk unavailable'); },
    })).rejects.toBeInstanceOf(VoiceWorkflowCheckpointError);
  });

  it('keeps public voice errors fixed and free of internal exception text', () => {
    expect(sanitizeVoiceAgentErrorPayload()).toEqual({
      code: 'VOICE_EXECUTION_FAILED',
      message: 'The voice request could not be completed.',
    });
    expect(voiceDurabilityUnknownText()).not.toContain('stack');
  });
});

describe('voice terminal ordering and recovery', () => {
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
      terminalEvent: {
        payload: { text: 'verified voice result' },
      },
    });
  });
});

describe('voice terminal wiring', () => {
  it('routes every in-turn terminal through the strict fence before speech', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'server/socket/voice.ts'),
      'utf8',
    );

    expect(source.match(/await commitVoiceTerminal\(\{/g)?.length || 0).toBeGreaterThanOrEqual(13);
    expect(source).not.toMatch(/emitAgent\(["']agent:response["']/);
    expect(source).not.toMatch(/emitAgent\(["']agent:error["']/);
    expect(source.match(/persistVoiceAssistantMessage\(/g)?.length || 0).toBe(1);
    expect(source.match(/queueFinalizedSpeech\(/g)?.length || 0).toBe(1);
    expect(source).toContain('flush: flushDBOrThrow');
    expect(source).toContain('recordChatExecutionTerminalEventDurably(');
    expect(source).toContain('recordChatExecutionPersistenceUnknownDurably(');
    expect(source).toContain('await persistVoiceWorkflowCheckpointDurably({');
    expect(source).toContain('if (e instanceof VoiceWorkflowCheckpointError || voiceWorkflowCheckpointed) throw e;');
    expect(source).toContain('resumeNodeReceipts: voiceModelRecovery?.receipts');
    expect(source).toContain('getChatExecution({');
    expect(source).not.toContain('socket.emit("audio:error", { message: err.message });');
    const strictHelper = source.slice(
      source.indexOf('const commitVoiceTerminal = async'),
      source.indexOf('const maxIterations =', source.indexOf('const commitVoiceTerminal = async')),
    );
    const dispositionAt = strictHelper.indexOf('terminalTaskDisposition: input.blocked');
    expect(dispositionAt).toBeGreaterThan(strictHelper.indexOf('persistVoiceAssistantMessage('));
    expect(strictHelper).not.toContain('settleConversationActionExecutionRequest(');
    expect(strictHelper.indexOf('flush: flushDBOrThrow'))
      .toBeGreaterThan(dispositionAt);
    expect(source).toContain("socket.on('audio:cancel_turn', async");
    expect(source).toContain('await commitActiveVoiceCancellation(session, {');
    expect(source).toContain('publish: false');
    const bindingFailure = source.slice(
      source.indexOf("if ('bindingFailure' in actionTaskExecution)"),
      source.indexOf("if (actionTaskExecution.state?.taskId)", source.indexOf("if ('bindingFailure' in actionTaskExecution)")),
    );
    expect(bindingFailure).toContain('await commitChatTerminalBoundary({');
    expect(bindingFailure.indexOf('flush: flushDBOrThrow'))
      .toBeLessThan(bindingFailure.indexOf('synthesizeSpeech(staleText'));
  });

  it('keeps the immediate voice-switch acknowledgement path intact', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'server/socket/voice.ts'),
      'utf8',
    );
    const handler = source.slice(
      source.indexOf("socket.on('audio:switch-voice'"),
      source.indexOf('let chunkCount', source.indexOf("socket.on('audio:switch-voice'")),
    );
    expect(handler.indexOf('applyVoiceSwitchRequest(')).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf("socket.emit('audio:voice_changed'"))
      .toBeGreaterThan(handler.indexOf('applyVoiceSwitchRequest('));
  });
});
