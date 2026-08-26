import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.JWT_SECRET = 'background-supervisor-test-secret';
  return {
    runOrchestratedTask: vi.fn(),
    flushDBOrThrow: vi.fn<() => Promise<void>>(),
    addMessage: vi.fn(() => 'background-result-message'),
    getConversationModelExecutionRecovery: vi.fn(() => null as any),
    persistConversationModelExecutionCheckpoint: vi.fn(() => true),
    persistConversationModelExecutionResult: vi.fn(() => true),
    pushNotification: vi.fn(),
    finalizeLumiResponse: vi.fn(() => ({ text: 'Verified background result.', blocked: false, reason: '' })),
    dbState: {
      value: {
        backgroundDelegationTasks: [] as any[],
        conversationActionTasks: [] as any[],
        conversationActionReceipts: [] as any[],
      } as any,
    },
    readDB: vi.fn(),
    writeDB: vi.fn(),
  };
});

vi.mock('../server/agents/orchestrator', () => ({
  runOrchestratedTask: mocks.runOrchestratedTask,
  isTerminalOrchestrationToolEvent: (record: any) => (
    record.lifecycle !== 'adapter_started'
    && (record.result !== undefined || record.error !== undefined)
  ),
}));

vi.mock('../server/conversation/manager', () => ({
  addMessage: mocks.addMessage,
  getConversationModelExecutionRecovery: mocks.getConversationModelExecutionRecovery,
  persistConversationModelExecutionCheckpoint: mocks.persistConversationModelExecutionCheckpoint,
  persistConversationModelExecutionResult: mocks.persistConversationModelExecutionResult,
}));

vi.mock('../server/routes/notifications', () => ({
  pushNotification: mocks.pushNotification,
}));

vi.mock('../server/cognition/result_finalizer', () => ({
  finalizeLumiResponse: mocks.finalizeLumiResponse,
}));

vi.mock('../server/cognition/execution_guard_recovery', () => ({
  sanitizeExecutionResponseForDelivery: (value: unknown) => value,
}));

vi.mock('../db_layer', () => ({
  flushDBOrThrow: mocks.flushDBOrThrow,
  readDB: mocks.readDB,
  writeDB: mocks.writeDB,
}));

import {
  listBackgroundTasks,
  registerBackgroundTask,
  requestCancelBackgroundTask,
  requestPauseBackgroundTask,
  resetBackgroundTasksForTest,
  type BackgroundDelegationContext,
} from '../server/agents/background_tasks';
import { executeRecoveredTask } from '../server/agents/background_task_supervisor';

type EmittedEvent = { room: string; event: string; payload: any };

function socketRecorder(): { io: any; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  return {
    events,
    io: {
      to(room: string) {
        return {
          emit(event: string, payload: any) {
            events.push({ room, event, payload });
          },
        };
      },
    },
  };
}

function registerTask(id: string, context?: BackgroundDelegationContext) {
  const scopedContext = context || {
    conversationId: 'background-conversation',
    domain: 'personal' as const,
  };
  return registerBackgroundTask({
    id,
    userId: 'background-owner',
    title: 'Controlled background task',
    prompt: 'Complete the controlled background task.',
    context: { ...scopedContext, actionTaskId: id },
  });
}

function installSuccessfulOrchestration(options: {
  emitPrivateCheckpoint?: boolean;
  afterPrivateCheckpoint?: () => void;
} = {}): void {
  mocks.runOrchestratedTask.mockImplementation(async (
    _prompt: string,
    _context: unknown,
    _config: unknown,
    _getters: unknown,
    _onProgress: unknown,
    onTool?: (record: any, meta: any) => Promise<void>,
    onCheckpoint?: (checkpoint: any) => Promise<void>,
  ) => {
    const executionTaskId = String((_context as any)?.taskId || 'controlled-task');
    const meta = { subTaskId: 'subtask-1', agentId: 'worker-1', agentName: 'Worker' };
    await onTool?.({
      id: 'controlled-tool-receipt',
      name: 'controlled_background_probe',
      arguments: { target: 'safe' },
      adapterStarted: true,
      lifecycle: 'adapter_started',
    }, meta);
    await onTool?.({
      id: 'controlled-tool-receipt',
      name: 'controlled_background_probe',
      arguments: { target: 'safe' },
      result: JSON.stringify({ ok: true }),
      adapterStarted: true,
      lifecycle: 'terminal',
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Controlled tool result verified.',
      },
    }, meta);
    if (options.emitPrivateCheckpoint) {
      await onCheckpoint?.({
        phase: 'wave_completed',
        executionGraph: {
          graphId: 'controlled-graph',
          taskId: executionTaskId,
          nodes: [{ nodeId: 'subtask-1' }],
        },
        nodeReceipts: [{ nodeId: 'subtask-1' }],
        completedNodeIds: ['subtask-1'],
        privateNodeHandoffs: [{
          graphId: 'controlled-graph',
          taskId: executionTaskId,
          nodeId: 'subtask-1',
          outputDigest: '1'.repeat(64),
          outputSummary: 'PRIVATE_BACKGROUND_HANDOFF',
          evidenceKind: 'tool_terminal_verification',
        }],
      });
      options.afterPrivateCheckpoint?.();
    }
    return {
      responseText: 'Controlled task completed.',
      llmWasCalled: true,
      workflowResult: {
        subTaskResults: [{ subTaskId: 'subtask-1', output: 'done', agentId: 'worker-1', status: 'succeeded' }],
        aggregatedOutput: 'Controlled task completed.',
        totalAgentsUsed: 1,
        executionGraph: { graphId: 'controlled-graph', taskId: executionTaskId, nodes: [] },
        nodeReceipts: [],
      },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbState.value = {
    backgroundDelegationTasks: [],
    conversationActionTasks: [],
    conversationActionReceipts: [],
  };
  mocks.readDB.mockImplementation(() => mocks.dbState.value);
  mocks.writeDB.mockImplementation((db: any) => { mocks.dbState.value = db; });
  mocks.flushDBOrThrow.mockResolvedValue(undefined);
  mocks.addMessage.mockReturnValue('background-result-message');
  mocks.getConversationModelExecutionRecovery.mockReturnValue(null);
  mocks.persistConversationModelExecutionCheckpoint.mockReturnValue(true);
  mocks.persistConversationModelExecutionResult.mockReturnValue(true);
  mocks.finalizeLumiResponse.mockReturnValue({ text: 'Verified background result.', blocked: false, reason: '' });
  resetBackgroundTasksForTest({ clearPersisted: true, markHydrated: true });
  installSuccessfulOrchestration();
});

describe('background supervisor execution boundaries', () => {
  it('blocks a legacy task whose background and action identities diverge before orchestration', async () => {
    const task = registerBackgroundTask({
      id: 'legacy-background-id',
      userId: 'background-owner',
      title: 'Legacy identity mismatch',
      prompt: 'Do not execute this mismatched task.',
      context: {
        conversationId: 'legacy-background-conversation',
        actionTaskId: 'different-action-id',
        domain: 'personal',
      },
    });
    const { io } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(listBackgroundTasks()[0]).toMatchObject({
      id: 'legacy-background-id',
      status: 'blocked',
      error: expect.stringContaining('actionTaskId must equal'),
    });
    expect(mocks.runOrchestratedTask).not.toHaveBeenCalled();
  });

  it('accepts graph-only terminal evidence when the claimed/action/graph task identity is unified', async () => {
    mocks.runOrchestratedTask.mockImplementation(async (
      _prompt: string,
      context: any,
    ) => {
      const taskId = String(context.taskId);
      const graphId = 'identity-bound-graph';
      const nodeReceipt = {
        graphId,
        taskId,
        nodeId: 'identity-node',
        status: 'succeeded',
        agentId: 'identity-worker',
        dependencyReceiptIds: [],
        startedAt: '2026-08-26T00:00:00.000Z',
        completedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1_000,
        nodeFingerprint: '1'.repeat(64),
        outputDigest: '2'.repeat(64),
        outputSummary: 'Identity-bound verified result.',
        evidenceKind: 'tool_terminal_verification',
        evidenceRefs: ['tool:identity-terminal'],
        verified: true,
      };
      return {
        responseText: 'Identity-bound verified result.',
        llmWasCalled: true,
        workflowResult: {
          subTaskResults: [{ subTaskId: 'identity-node', output: 'Identity-bound verified result.', agentId: 'identity-worker', status: 'succeeded' }],
          aggregatedOutput: 'Identity-bound verified result.',
          totalAgentsUsed: 1,
          executionGraph: { graphId, taskId, nodes: [] },
          nodeReceipts: [nodeReceipt],
          arbitrationReceipt: {
            graphId,
            taskId,
            policy: 'aggregate_verified',
            status: 'succeeded',
            verification: 'verified',
            selectedNodeIds: ['identity-node'],
            verifiedNodeIds: ['identity-node'],
            consideredNodeIds: ['identity-node'],
            outputDigest: '3'.repeat(64),
            completedAt: '2026-08-26T00:00:01.000Z',
          },
        },
      };
    });
    const task = registerTask('identity-bound-task', {
      conversationId: 'background-conversation',
      domain: 'personal',
      dataRoutingPolicy: 'local_only',
    });
    const { io } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(mocks.runOrchestratedTask.mock.calls[0][1]).toMatchObject({
      taskId: task.id,
      dataRoutingPolicy: 'local_only',
    });
    expect(listBackgroundTasks()[0]).toMatchObject({
      id: task.id,
      status: 'completed',
      terminalReceipt: {
        taskId: task.id,
        verification: 'verified',
        evidenceKind: 'model_graph',
      },
    });
  });

  it('fails closed for a work task without orgId and emits no personal event or notification', async () => {
    const task = registerTask('malformed-work-scope', {
      conversationId: 'work-conversation',
      actionTaskId: 'work-action',
      domain: 'work',
    });
    const { io, events } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(listBackgroundTasks()[0]).toMatchObject({
      id: task.id,
      status: 'blocked',
      error: expect.stringContaining('work domain requires a non-empty orgId'),
    });
    expect(mocks.runOrchestratedTask).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(mocks.flushDBOrThrow).toHaveBeenCalledOnce();
  });

  it('uses only the member-private org room for valid work tasks and keeps work content out of org broadcasts and personal notifications', async () => {
    const task = registerTask('valid-work-scope', {
      conversationId: 'work-conversation',
      actionTaskId: 'work-action',
      domain: 'work',
      orgId: 'org-safe',
    });
    const { io, events } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(listBackgroundTasks()[0].status).toBe('completed');
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map(event => event.room))).toEqual(new Set([
      'user:background-owner:org:org-safe',
    ]));
    expect(events.some(event => event.room === 'org:org-safe')).toBe(false);
    expect(events.some(event => event.room === 'user:another-member:org:org-safe')).toBe(false);
    expect(mocks.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'work',
      orgId: 'org-safe',
    }));
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });

  it('persists an adapter-start unknown-outcome fence and replaces it with the same terminal receipt id', async () => {
    const recoveredGraph = { graphId: 'recovered-graph', taskId: 'adapter-fence', nodes: [] };
    mocks.getConversationModelExecutionRecovery.mockReturnValue({ graph: recoveredGraph, receipts: [] });
    const task = registerTask('adapter-fence');
    const { io } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    const settled = listBackgroundTasks()[0];
    expect(settled.status).toBe('completed');
    expect(settled.checkpoint?.receipts).toEqual([
      expect.objectContaining({ id: 'controlled-tool-receipt', status: 'success', verificationStatus: 'verified' }),
    ]);
    expect(settled.checkpoint?.receipts?.some(receipt => receipt.status === 'unknown_outcome')).toBe(false);
    expect(mocks.runOrchestratedTask.mock.calls[0][1]).toMatchObject({
      resumeExecutionGraph: recoveredGraph,
    });
  });

  it('sends private checkpoint handoffs only to conversation persistence, not background projections', async () => {
    const persistenceOrder: string[] = [];
    mocks.persistConversationModelExecutionCheckpoint.mockImplementation(() => {
      persistenceOrder.push('manager-persisted');
      return true;
    });
    mocks.flushDBOrThrow.mockImplementation(async () => {
      persistenceOrder.push('strict-flush');
    });
    installSuccessfulOrchestration({
      emitPrivateCheckpoint: true,
      afterPrivateCheckpoint: () => persistenceOrder.push('orchestrator-continued'),
    });
    const task = registerTask('private-checkpoint');
    const { io, events } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(mocks.persistConversationModelExecutionCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      privateNodeHandoffs: [expect.objectContaining({
        nodeId: 'subtask-1',
        outputSummary: 'PRIVATE_BACKGROUND_HANDOFF',
      })],
    }));
    expect(JSON.stringify(listBackgroundTasks())).not.toContain('PRIVATE_BACKGROUND_HANDOFF');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_BACKGROUND_HANDOFF');
    const persistedAt = persistenceOrder.indexOf('manager-persisted');
    const continuedAt = persistenceOrder.indexOf('orchestrator-continued');
    expect(persistedAt).toBeGreaterThanOrEqual(0);
    expect(continuedAt).toBeGreaterThan(persistedAt);
    expect(persistenceOrder.slice(persistedAt + 1, continuedAt)).toContain('strict-flush');
  });

  it('retains the unknown-outcome fence and blocks recovery when an adapter never emits a terminal receipt', async () => {
    mocks.runOrchestratedTask.mockImplementation(async (
      _prompt: string,
      _context: unknown,
      _config: unknown,
      _getters: unknown,
      _onProgress: unknown,
      onTool?: (record: any, meta: any) => Promise<void>,
    ) => {
      await onTool?.({
        id: 'uncertain-tool-receipt',
        name: 'external_commit_probe',
        arguments: { target: 'external' },
        adapterStarted: true,
        lifecycle: 'adapter_started',
      }, { subTaskId: 'subtask-1', agentId: 'worker-1', agentName: 'Worker' });
      throw new Error('Worker transport closed after adapter start');
    });
    const task = registerTask('adapter-unknown');
    const { io } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    const settled = listBackgroundTasks()[0];
    expect(settled.status).toBe('blocked');
    expect(settled.recovery?.lastFailureClass).toBe('unknown_outcome');
    expect(settled.checkpoint?.receipts).toEqual([
      expect.objectContaining({
        id: 'uncertain-tool-receipt',
        status: 'unknown_outcome',
        verificationStatus: 'unverified',
      }),
    ]);
  });

  it.each([
    ['paused', requestPauseBackgroundTask],
    ['cancelled', requestCancelBackgroundTask],
  ] as const)('honors a %s race at the final checkpoint without sending a blocked final', async (expected, request) => {
    const task = registerTask(`race-${expected}`);
    let flushCount = 0;
    mocks.flushDBOrThrow.mockImplementation(async () => {
      flushCount += 1;
      if (flushCount === 5) request(task.id, task.userId);
    });
    const { io, events } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(listBackgroundTasks()[0].status).toBe(expected);
    expect(events.some(event => event.event === 'agent:response')).toBe(false);
    expect(events.some(event => (
      event.event === 'agent:background_task_update'
      && event.payload.task.status === expected
    ))).toBe(true);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });

  it('does not start orchestration when the initial checkpoint strict flush fails', async () => {
    const task = registerTask('initial-flush-failure');
    mocks.flushDBOrThrow.mockRejectedValue(new Error('durable storage unavailable'));
    const { io, events } = socketRecorder();

    await expect(executeRecoveredTask(task, io, {} as any)).rejects.toThrow('durable storage unavailable');

    expect(mocks.runOrchestratedTask).not.toHaveBeenCalled();
    expect(events.some(event => event.event === 'agent:response')).toBe(false);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });

  it('refuses completion when the final conversation model result cannot be persisted', async () => {
    mocks.persistConversationModelExecutionResult.mockReturnValue(false);
    const task = registerTask('model-result-persistence-failure');
    const { io, events } = socketRecorder();

    await executeRecoveredTask(task, io, {} as any);

    expect(listBackgroundTasks()[0].status).not.toBe('completed');
    expect(events.some(event => (
      event.event === 'agent:response' && event.payload.completionFeedback?.status === 'completed'
    ))).toBe(false);
  });

  it('does not publish a final response when strict terminal settlement persistence fails', async () => {
    const task = registerTask('terminal-settlement-flush-failure');
    let flushCount = 0;
    mocks.flushDBOrThrow.mockImplementation(async () => {
      flushCount += 1;
      if (flushCount === 6) throw new Error('terminal storage flush failed');
    });
    const { io, events } = socketRecorder();

    await expect(executeRecoveredTask(task, io, {} as any))
      .rejects.toThrow('Terminal background settlement was not durably persisted');

    expect(events.some(event => event.event === 'agent:response')).toBe(false);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });
});
