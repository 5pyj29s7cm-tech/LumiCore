import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, flushDB, initDatabase, readDB, writeDB } from '../db_layer';
import {
  configureExternalAiCollaborationRuntimeForTests,
  executeExternalAiCollaboration,
  getExternalAiSessionSnapshot,
  recoverInterruptedExternalAiCollaborations,
  resetExternalAiCollaborationForTests,
} from '../server/agents/external_ai_collaboration';
import { registerExternalAiCollaborationTools } from '../server/tools/definitions/external_ai_collaboration_tools';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';

let testSequence = 0;

function nextKey(label: string): string {
  testSequence += 1;
  return `${label}-${Date.now()}-${testSequence}`;
}

function registerAdapter(
  registry: ToolRegistry,
  input: {
    name: string;
    source: 'mcp' | 'adapter';
    provider: string;
    handler: (args: Record<string, any>) => Promise<string>;
  },
) {
  registry.register({
    name: input.name,
    description: `${input.provider} external AI adapter`,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        sessionId: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      required: ['question'],
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: {
      id: input.name,
      family: input.source === 'adapter' ? 'external-ai-browser' : 'external-ai',
      lane: 'agents',
      source: input.source,
      provider: input.provider,
      operation: 'communicate',
      risk: 'high',
      tags: [input.provider, 'external-ai', input.source === 'adapter' ? 'browser-dom' : 'mcp'],
      sideEffects: [{ type: 'external_communication', scope: input.provider, reversible: false }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['answerText'],
        successSignals: ['answer returned'],
        limitations: [],
      },
    },
    handler: input.handler,
  });
}

function confirmedContext(idempotencyKey: string, extras: Record<string, any> = {}) {
  return {
    userId: 'external-ai-collaboration-user',
    taskId: nextKey('external-ai-task'),
    requestId: nextKey('external-ai-request'),
    idempotencyKey,
    userConfirmed: true,
    domain: 'personal' as const,
    ...extras,
  };
}

describe('external AI collaboration routing and receipts', () => {
  beforeEach(async () => {
    await initDatabase();
    resetExternalCommitRuntimeCacheForTests();
    resetExternalAiCollaborationForTests({ clearPersisted: true });
    await flushDB();
  });

  afterEach(async () => {
    vi.useRealTimers();
    configureExternalAiCollaborationRuntimeForTests(null);
    resetExternalCommitRuntimeCacheForTests();
    resetExternalAiCollaborationForTests({ clearPersisted: true });
    await flushDB();
  });

  it('prefers a configured API over MCP and desktop routes and persists source evidence', async () => {
    const registry = new ToolRegistry();
    const mcpHandler = vi.fn(async () => JSON.stringify({ answerText: 'MCP must not run.' }));
    registerAdapter(registry, {
      name: 'chatgpt_mcp_ask_test',
      source: 'mcp',
      provider: 'chatgpt-mcp',
      handler: mcpHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const api = vi.fn(async () => 'API answer with evidence.');
    configureExternalAiCollaborationRuntimeForTests({ api });
    const desktopRelay = vi.fn(async () => 'desktop must not run');
    const context = confirmedContext(nextKey('api-priority'), { desktopRelay });

    const raw = await registry.execute('external_ai_collaborate', {
      question: 'Compare two approaches.',
      targets: ['chatgpt'],
    }, context);
    const result = JSON.parse(raw);

    expect(result.status).toBe('answered');
    expect(result.counts).toMatchObject({ targets: 1, answered: 1, pending: 0 });
    expect(result.results[0]).toMatchObject({
      targetId: 'chatgpt',
      routeKind: 'api',
      status: 'answered',
      answerText: 'API answer with evidence.',
      sourceEvidence: {
        routeKind: 'api',
        targetId: 'chatgpt',
        provider: 'openai',
      },
    });
    expect(result.results[0].sourceEvidence.responseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(api).toHaveBeenCalledTimes(1);
    expect(mcpHandler).not.toHaveBeenCalled();
    expect(desktopRelay).not.toHaveBeenCalled();

    const snapshot = getExternalAiSessionSnapshot(result.sessionId, context.userId);
    expect(snapshot.answers[0]).toMatchObject({ targetId: 'chatgpt', late: false });
  });

  it('uses MCP before a healthy CLI and structured browser adapter', async () => {
    const registry = new ToolRegistry();
    const mcpHandler = vi.fn(async () => JSON.stringify({
      status: 'answered',
      answerText: 'Claude MCP answer.',
      sessionId: 'claude-session-1',
      messageId: 'claude-message-1',
    }));
    const browserHandler = vi.fn(async () => JSON.stringify({ answerText: 'Browser must not run.' }));
    registerAdapter(registry, {
      name: 'claude_mcp_ask_test',
      source: 'mcp',
      provider: 'claude-mcp',
      handler: mcpHandler,
    });
    registerAdapter(registry, {
      name: 'claude_browser_ask_test',
      source: 'adapter',
      provider: 'claude-browser',
      handler: browserHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const db = readDB();
    db.agents.push({
      id: nextKey('claude-cli'),
      name: 'Claude CLI',
      category: 'external',
      runtime: 'external',
      externalCommand: 'claude-agent --task {task}',
      status: 'active',
      healthStatus: 'online',
      externalRuntimeAuthorizedAt: new Date().toISOString(),
      ownerUid: 'external-ai-collaboration-user',
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    const cli = vi.fn(async () => ({ success: true, output: 'CLI must not run.', exitCode: 0, durationMs: 1 }));
    configureExternalAiCollaborationRuntimeForTests({ cli });
    const context = confirmedContext(nextKey('mcp-priority'), { desktopRelay: vi.fn() });

    const result = JSON.parse(await registry.execute('external_ai_collaborate', {
      question: 'Review this design.',
      targets: ['claude'],
    }, context));

    expect(result.results[0]).toMatchObject({
      routeKind: 'mcp',
      status: 'answered',
      externalSessionId: 'claude-session-1',
      externalMessageId: 'claude-message-1',
      answerText: 'Claude MCP answer.',
    });
    expect(result.results[0].routeAttempts.map((item: any) => item.routeKind)).toEqual(['api', 'mcp']);
    expect(mcpHandler).toHaveBeenCalledTimes(1);
    expect(cli).not.toHaveBeenCalled();
    expect(browserHandler).not.toHaveBeenCalled();
  });

  it('uses a healthy configured CLI before a structured browser or desktop route', async () => {
    const registry = new ToolRegistry();
    const browserHandler = vi.fn(async () => JSON.stringify({ answerText: 'Browser must not run.' }));
    registerAdapter(registry, {
      name: 'hermes_test_browser_ask',
      source: 'adapter',
      provider: 'hermes-test-browser',
      handler: browserHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const db = readDB();
    db.agents.push({
      id: nextKey('hermes-test-cli'),
      name: 'Hermes Test Agent',
      category: 'external',
      runtime: 'external',
      externalCommand: 'hermes chat --task {task}',
      status: 'active',
      healthStatus: 'online',
      externalRuntimeAuthorizedAt: new Date().toISOString(),
      ownerUid: 'external-ai-collaboration-user',
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    const cli = vi.fn(async () => ({ success: true, output: 'CLI answer.', exitCode: 0, durationMs: 8 }));
    configureExternalAiCollaborationRuntimeForTests({ cli });
    const desktopRelay = vi.fn();
    const context = confirmedContext(nextKey('cli-priority'), { desktopRelay });

    const result = JSON.parse(await registry.execute('external_ai_collaborate', {
      question: 'Give an independent review.',
      targets: ['hermes-test'],
    }, context));

    expect(result.results[0]).toMatchObject({
      targetId: 'hermes-test',
      routeKind: 'cli',
      status: 'answered',
      answerText: 'CLI answer.',
    });
    expect(cli).toHaveBeenCalledTimes(1);
    expect(browserHandler).not.toHaveBeenCalled();
    expect(desktopRelay).not.toHaveBeenCalled();
  });

  it('uses a structured browser adapter before desktop visual fallback', async () => {
    const registry = new ToolRegistry();
    const browserHandler = vi.fn(async () => JSON.stringify({
      answerText: 'Structured browser answer.',
      conversationId: 'browser-conversation',
      messageId: 'browser-message',
    }));
    registerAdapter(registry, {
      name: 'perplexity_browser_ask_test',
      source: 'adapter',
      provider: 'perplexity-browser',
      handler: browserHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const desktopRelay = vi.fn();
    const context = confirmedContext(nextKey('browser-priority'), { desktopRelay });

    const result = JSON.parse(await registry.execute('external_ai_collaborate', {
      question: 'Find the strongest counterargument.',
      targets: ['perplexity'],
    }, context));

    expect(result.results[0]).toMatchObject({
      routeKind: 'structured_browser',
      status: 'answered',
      answerText: 'Structured browser answer.',
      externalSessionId: 'browser-conversation',
      externalMessageId: 'browser-message',
    });
    expect(browserHandler).toHaveBeenCalledTimes(1);
    expect(desktopRelay).not.toHaveBeenCalled();
  });

  it('uses desktop visual as the last route and never repeats the same submission key', async () => {
    const registry = new ToolRegistry();
    registerExternalAiCollaborationTools(registry);
    let foreground = 'Lumi';
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const desktopRelay = vi.fn(async (name: string, args: Record<string, any>) => {
      calls.push({ name, args });
      if (name === 'desktop_active_window') {
        return JSON.stringify({ title: foreground, process_name: foreground, x: 0, y: 0, width: 1200, height: 800 });
      }
      if (name === 'desktop_open') {
        foreground = 'WorkBuddy';
        return JSON.stringify({ ok: true, target: args.target });
      }
      if (name === 'desktop_capture_screen') return JSON.stringify({ image_base64: 'abc', width: 100, height: 100, format: 'jpeg' });
      return 'ok';
    });
    const idempotencyKey = nextKey('desktop-idempotency');
    const context = confirmedContext(idempotencyKey, { desktopRelay });
    const args = { question: 'Answer only once.', targets: ['workbuddy'] };

    const first = JSON.parse(await registry.execute('external_ai_collaborate', args, context));
    const submitCount = calls.filter(call => call.name === 'desktop_keyboard_press' && call.args.key === 'enter').length;
    const replay = JSON.parse(await registry.execute('external_ai_collaborate', args, context));

    expect(first.status).toBe('waiting');
    expect(first.results[0]).toMatchObject({ routeKind: 'desktop_visual', status: 'submitted' });
    expect(submitCount).toBe(1);
    expect(calls.filter(call => call.name === 'desktop_keyboard_press' && call.args.key === 'enter')).toHaveLength(1);
    expect(replay).toMatchObject({
      verificationStatus: 'verified',
      sessionId: first.sessionId,
      questionDigest: first.questionDigest,
    });
  });

  it('keeps verified answers when another target fails and never falls through after an uncertain API attempt', async () => {
    const registry = new ToolRegistry();
    const mcpHandler = vi.fn(async () => JSON.stringify({ answerText: 'Unsafe fallback answer.' }));
    registerAdapter(registry, {
      name: 'claude_mcp_fallback_must_not_run',
      source: 'mcp',
      provider: 'claude-mcp',
      handler: mcpHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const api = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === 'claude') throw new Error('socket disconnected after request write');
      return 'ChatGPT independent answer.';
    });
    configureExternalAiCollaborationRuntimeForTests({ api });
    const context = confirmedContext(nextKey('partial-failure'), { desktopRelay: vi.fn() });

    const result = JSON.parse(await registry.execute('external_ai_collaborate', {
      question: 'Evaluate the proposal independently.',
      targets: ['chatgpt', 'claude'],
    }, context));

    expect(result.counts).toMatchObject({ targets: 2, answered: 1, pending: 1 });
    expect(result.results.find((item: any) => item.targetId === 'chatgpt')).toMatchObject({
      status: 'answered', answerText: 'ChatGPT independent answer.',
    });
    expect(result.results.find((item: any) => item.targetId === 'claude')).toMatchObject({
      routeKind: 'api', status: 'unknown',
    });
    expect(mcpHandler).not.toHaveBeenCalled();
  });

  it('coalesces concurrent duplicate target submissions before either caller receives a result', async () => {
    let release!: (answer: string) => void;
    const api = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    configureExternalAiCollaborationRuntimeForTests({ api });
    const context = confirmedContext(nextKey('concurrent-duplicate'));
    const args = { question: 'Submit this target exactly once.', targets: ['chatgpt'] };

    const first = executeExternalAiCollaboration(args, context);
    const second = executeExternalAiCollaboration(args, context);
    await Promise.resolve();
    expect(api).toHaveBeenCalledTimes(1);
    release('One coalesced answer.');

    const [firstResult, secondResult] = (await Promise.all([first, second])).map(raw => JSON.parse(raw));
    expect(firstResult.sessionId).toBe(secondResult.sessionId);
    expect(firstResult.results[0]).toMatchObject({ status: 'answered', answerText: 'One coalesced answer.' });
    expect(secondResult.results[0]).toMatchObject({ status: 'answered', answerText: 'One coalesced answer.' });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('rejects an MCP candidate that declares effects beyond an external AI prompt submission', async () => {
    const registry = new ToolRegistry();
    const unsafeHandler = vi.fn(async () => JSON.stringify({ answerText: 'Unsafe adapter ran.' }));
    registry.register({
      name: 'guarded_ai_mcp_mutating_ask',
      description: 'guarded-ai MCP adapter with unrelated mutation effects',
      parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      permission: 'user',
      securityLevel: 'confirm',
      capability: {
        id: 'guarded-ai.mcp.mutating-ask',
        family: 'external-ai',
        lane: 'agents',
        source: 'mcp',
        provider: 'guarded-ai-mcp',
        operation: 'communicate',
        risk: 'high',
        sideEffects: [
          { type: 'external_communication', scope: 'guarded-ai', reversible: false },
          { type: 'external_state_change', scope: 'unrelated account settings', reversible: false },
        ],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['answerText'],
          successSignals: ['answer returned'],
          limitations: [],
        },
      },
      handler: unsafeHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const db = readDB();
    db.agents.push({
      id: nextKey('guarded-ai-cli'),
      name: 'Guarded AI CLI',
      category: 'external',
      runtime: 'external',
      externalCommand: 'guarded-ai --task {task}',
      status: 'active',
      healthStatus: 'online',
      externalRuntimeAuthorizedAt: new Date().toISOString(),
      ownerUid: 'external-ai-collaboration-user',
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    const cli = vi.fn(async () => ({ success: true, output: 'Safe CLI answer.', exitCode: 0, durationMs: 1 }));
    configureExternalAiCollaborationRuntimeForTests({ cli });
    const context = confirmedContext(nextKey('unsafe-adapter-filter'), { toolRegistry: registry });

    const result = JSON.parse(await executeExternalAiCollaboration({
      question: 'Use only an ask-scoped adapter.',
      targets: ['guarded-ai'],
    }, context));

    expect(result.results[0]).toMatchObject({ routeKind: 'cli', status: 'answered', answerText: 'Safe CLI answer.' });
    expect(unsafeHandler).not.toHaveBeenCalled();
    expect(cli).toHaveBeenCalledTimes(1);
  });

  it('collects a pending MCP answer through its read-only collector without resubmitting', async () => {
    const registry = new ToolRegistry();
    const askHandler = vi.fn(async () => JSON.stringify({
      status: 'submitted',
      sessionId: 'research-session-1',
      requestId: 'research-request-1',
    }));
    const collectHandler = vi.fn(async (args: Record<string, any>) => JSON.stringify({
      status: 'answered',
      answerText: 'Collected answer from the original request.',
      sessionId: args.sessionId,
      messageId: args.requestId,
    }));
    registerAdapter(registry, {
      name: 'research_ai_mcp_ask',
      source: 'mcp',
      provider: 'research-ai-mcp',
      handler: askHandler,
    });
    registry.register({
      name: 'research_ai_mcp_collect_answer',
      description: 'Collect result for research-ai-mcp',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          requestId: { type: 'string' },
        },
        required: ['sessionId', 'requestId'],
      },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: 'research-ai-mcp.collect',
        family: 'external-ai',
        lane: 'agents',
        source: 'mcp',
        provider: 'research-ai-mcp',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'network_read', scope: 'research AI result', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['answerText'],
          successSignals: ['answer returned'],
          limitations: [],
        },
      },
      handler: collectHandler,
    });
    registerExternalAiCollaborationTools(registry);
    const context = confirmedContext(nextKey('mcp-collector'));
    const initial = JSON.parse(await registry.execute('external_ai_collaborate', {
      question: 'Run an asynchronous review.',
      targets: ['research-ai'],
    }, context));
    expect(initial.results[0]).toMatchObject({
      routeKind: 'mcp', status: 'submitted', externalSessionId: 'research-session-1', externalMessageId: 'research-request-1',
    });

    const collected = JSON.parse(await registry.execute('external_ai_collect_answers', {
      sessionId: initial.sessionId,
    }, { ...context, idempotencyKey: nextKey('mcp-collector-read') }));

    expect(collected.status).toBe('answered');
    expect(collected.answers[0]).toMatchObject({
      answerText: 'Collected answer from the original request.',
      targetId: 'research-ai',
    });
    expect(askHandler).toHaveBeenCalledTimes(1);
    expect(collectHandler).toHaveBeenCalledTimes(1);
    expect(collectHandler).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'research-session-1',
      requestId: 'research-request-1',
    }), expect.anything());
  });

  it('archives an answer that arrives after the target timeout without resending', async () => {
    vi.useFakeTimers();
    let resolveApi!: (value: string) => void;
    const api = vi.fn(() => new Promise<string>(resolve => { resolveApi = resolve; }));
    configureExternalAiCollaborationRuntimeForTests({ api });
    const context = confirmedContext(nextKey('late-answer'));
    const execution = executeExternalAiCollaboration({
      question: 'Return after the timeout.',
      targets: ['chatgpt'],
      targetTimeoutMs: 1_000,
    }, context);
    await vi.advanceTimersByTimeAsync(1_001);
    const first = JSON.parse(await execution);

    expect(first.results[0].status).toBe('unknown');
    expect(first.counts).toMatchObject({ answered: 0, pending: 1 });
    resolveApi('Late but attributable answer.');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const snapshot = getExternalAiSessionSnapshot(first.sessionId, context.userId);
    expect(snapshot.counts).toMatchObject({ answered: 1, pending: 0, lateAnswers: 1 });
    expect(snapshot.answers[0]).toMatchObject({
      answerText: 'Late but attributable answer.',
      late: true,
      targetId: 'chatgpt',
    });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('preserves sessions, dispatches, and answer evidence across a database restart', async () => {
    configureExternalAiCollaborationRuntimeForTests({ api: async () => 'Restart-safe answer.' });
    const context = confirmedContext(nextKey('restart-session'));
    const result = JSON.parse(await executeExternalAiCollaboration({
      question: 'Persist this collaboration.',
      targets: ['chatgpt'],
    }, context));
    await flushDB();
    await closeDatabase();
    resetExternalAiCollaborationForTests();
    await initDatabase();

    const snapshot = getExternalAiSessionSnapshot(result.sessionId, context.userId);
    expect(snapshot.session).toMatchObject({
      id: result.sessionId,
      taskId: context.taskId,
      status: 'answered',
    });
    expect(snapshot.dispatches[0]).toMatchObject({ routeKind: 'api', status: 'answered' });
    expect(snapshot.answers[0]).toMatchObject({ answerText: 'Restart-safe answer.', late: false });
  });

  it('replays the persistent collaboration session after restart without calling the target again', async () => {
    const api = vi.fn(async () => 'One provider call only.');
    configureExternalAiCollaborationRuntimeForTests({ api });
    const args = { question: 'Deduplicate across restart.', targets: ['chatgpt'] };
    const context = confirmedContext(nextKey('restart-journal'));
    const firstRegistry = new ToolRegistry();
    registerExternalAiCollaborationTools(firstRegistry);
    const first = JSON.parse(await firstRegistry.execute('external_ai_collaborate', args, context));
    await flushDB();
    await closeDatabase();
    resetExternalCommitRuntimeCacheForTests();
    resetExternalAiCollaborationForTests();
    await initDatabase();

    const restartedRegistry = new ToolRegistry();
    registerExternalAiCollaborationTools(restartedRegistry);
    const replay = JSON.parse(await restartedRegistry.execute('external_ai_collaborate', args, context));
    expect(api).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      verificationStatus: 'verified',
      deduplicated: true,
      sessionId: first.sessionId,
      taskId: context.taskId,
      questionDigest: first.questionDigest,
    });
  });

  it('marks an interrupted submission unknown after restart and does not invoke it again', async () => {
    const api = vi.fn(async () => 'Initial answer used to create the durable rows.');
    configureExternalAiCollaborationRuntimeForTests({ api });
    const context = confirmedContext(nextKey('restart-interrupted'));
    const result = JSON.parse(await executeExternalAiCollaboration({
      question: 'Never resend this after restart.',
      targets: ['chatgpt'],
    }, context));
    const db = readDB();
    const dispatch = db.externalAiDispatches.find((item: any) => item.sessionId === result.sessionId);
    dispatch.status = 'submitting';
    dispatch.answerId = undefined;
    dispatch.answerDigest = undefined;
    db.externalAiAnswers = db.externalAiAnswers.filter((item: any) => item.sessionId !== result.sessionId);
    writeDB(db);
    await flushDB();
    await closeDatabase();
    resetExternalAiCollaborationForTests();
    await initDatabase();

    expect(recoverInterruptedExternalAiCollaborations()).toBe(1);
    const recovered = getExternalAiSessionSnapshot(result.sessionId, context.userId);
    expect(recovered.dispatches[0]).toMatchObject({
      status: 'unknown',
      error: expect.stringMatching(/restart.*automatic resend is blocked/i),
    });
    expect(recovered.counts).toMatchObject({ answered: 0, pending: 1 });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a session id for another task, question, or target set', async () => {
    configureExternalAiCollaborationRuntimeForTests({ api: async () => 'Bound answer.' });
    const context = confirmedContext(nextKey('session-binding'));
    const first = JSON.parse(await executeExternalAiCollaboration({
      question: 'Immutable question.',
      targets: ['chatgpt'],
      sessionId: 'fixed-external-ai-session',
    }, context));
    expect(first.status).toBe('answered');

    await expect(executeExternalAiCollaboration({
      question: 'Changed question.',
      targets: ['chatgpt'],
      sessionId: 'fixed-external-ai-session',
    }, context)).rejects.toThrow(/session target mismatch/i);

    await expect(executeExternalAiCollaboration({
      question: 'Immutable question.',
      targets: ['chatgpt'],
      sessionId: 'fixed-external-ai-session',
    }, { ...context, conversationId: 'another-conversation' })).rejects.toThrow(/session target mismatch/i);
  });
});
