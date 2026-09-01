import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeToolCall, executeToolCallOrThrow } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { toolRecordSucceeded } from '../server/cognition/task_execution_ledger';
import { encodeToolResult } from '../server/tools/result_envelope';
import { ToolLifecyclePersistenceError } from '../server/llm/adapter';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';

afterEach(() => {
  vi.useRealTimers();
});

function registryWithTool() {
  const registry = new ToolRegistry();
  const handler = vi.fn(async (args: Record<string, any>) => JSON.stringify({
    ok: true,
    status: 'observed',
    target: args.target,
  }));
  registry.register({
    name: 'read_demo',
    description: 'Read a demo target.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        apiToken: { type: 'string' },
      },
      required: ['target'],
    },
    permission: 'public',
    securityLevel: 'safe',
    evidence: {
      capability: 'demo_read',
      operation: 'observe',
      assurance: 'observed',
      subjectArgument: 'target',
    },
    handler,
  });
  return { registry, handler };
}

function registryWithTargetPolicyTools() {
  const registry = new ToolRegistry();
  const handlers = {
    read_file: vi.fn(async (args: Record<string, any>) => JSON.stringify({
      ok: true,
      status: 'observed',
      path: args.path,
    })),
    desktop_run_command: vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' })),
    python_exec: vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' })),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    const structuredRead = name === 'read_file';
    const successStatus = structuredRead ? 'observed' : 'completed';
    registry.register({
      name,
      description: structuredRead ? 'Read one exact structured file.' : 'Execute a general process.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: `test.target-policy.${name}`,
        family: 'target-policy-test',
        lane: structuredRead ? 'files' : 'system',
        operation: structuredRead ? 'observe' : 'mutate',
        risk: 'low',
        sideEffects: [{
          type: structuredRead ? 'local_read' : 'process_execution',
          scope: structuredRead ? 'one local file' : 'local process',
          reversible: true,
        }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok', 'status'],
          requiredValues: { ok: true },
          successStatuses: [successStatus],
          successSignals: ['test adapter receipt'],
          limitations: [],
        },
      },
      handler,
    });
  }
  return { registry, handlers };
}

describe('unified tool execution engine', () => {
  it('blocks adapter start when the shared pipeline marked the turn conversational', async () => {
    const { registry, handler } = registryWithTool();
    const record = await executeToolCall({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
      context: {
        actionIntent: '你发消息给我时不要一坨丢过来',
        currentTurnExecutionRequested: false,
      },
    });

    expect(record.error).toMatch(/current turn is conversational/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('blocks a stale desktop target before the adapter can legitimize it with a receipt', async () => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const desktopRelay = vi.fn(async () => JSON.stringify({ ok: true, status: 'verified' }));
    const record = await executeToolCall({
      registry,
      name: 'desktop_open',
      arguments: { target: 'https://wenshu.court.gov.cn' },
      context: {
        actionIntent: '打开网易云音乐并播放一首歌',
        routedTaskText: '打开网易云音乐并播放一首歌',
        currentTurnExecutionRequested: true,
        desktopRelay,
      },
    });

    expect(record.error).toMatch(/does not match the current task target/i);
    expect(desktopRelay).not.toHaveBeenCalled();
  });

  it('uses recovered target context only for the exact trusted durable task', async () => {
    const registry = new ToolRegistry();
    registerDesktopTools(registry);
    const desktopRelay = vi.fn(async () => JSON.stringify({ ok: true, status: 'verified' }));
    const routedTaskText = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- taskId: task_music',
      '- followupIntent: execute',
      '- goal: 打开网易云音乐并播放一首歌',
    ].join('\n');
    const record = await executeToolCall({
      registry,
      name: 'desktop_open',
      arguments: { target: 'https://wenshu.court.gov.cn' },
      context: {
        taskId: 'task_music',
        actionIntent: '继续',
        routedTaskText,
        currentTurnExecutionRequested: true,
        trustedActionContinuation: true,
        desktopRelay,
      },
    });

    expect(record.error).toMatch(/does not match the current task target/i);
    expect(desktopRelay).not.toHaveBeenCalled();
  });

  it('enforces the server target anchor when the caller omits preflight', async () => {
    const { registry, handlers } = registryWithTargetPolicyTools();
    const anchoredPath = path.join(os.homedir(), 'Desktop', 'quarterly-report.docx');
    const otherPath = path.join(os.homedir(), 'Documents', 'private-config.json');

    const record = await executeToolCall({
      registry,
      name: 'read_file',
      arguments: { path: otherPath },
      context: {
        routedTaskText: `Analyze the file ${anchoredPath}.`,
      },
    });

    expect(record.error).toMatch(/target does not match the anchored file/i);
    expect(handlers.read_file).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['desktop_run_command', { command: 'type C:\\Users\\Administrator\\Documents\\private.txt' }],
    ['python_exec', { code: 'open(r"C:\\Users\\Administrator\\Documents\\private.txt").read()' }],
  ])('blocks %s as an alternate file-read path even when caller preflight allows it', async (name, args) => {
    const { registry, handlers } = registryWithTargetPolicyTools();
    const anchoredPath = path.join(os.homedir(), 'Desktop', 'quarterly-report.docx');

    const record = await executeToolCall({
      registry,
      name,
      arguments: args,
      context: {
        userConfirmed: true,
        routedTaskText: `Analyze the file ${anchoredPath}.`,
      },
      preflight: () => ({ allowed: true, arguments: args }),
    });

    expect(record.error).toMatch(/general command, script, interpreter/i);
    expect(handlers[name as keyof typeof handlers]).toHaveBeenCalledTimes(0);
  });

  it('allows a structured read only after canonical path matching and pins adapter args to the anchor', async () => {
    const { registry, handlers } = registryWithTargetPolicyTools();
    const anchoredPath = path.join(os.homedir(), 'Desktop', 'quarterly-report.docx');
    const equivalentPath = path.join(os.homedir(), 'Desktop', 'temporary', '..', 'quarterly-report.docx');

    const record = await executeToolCall({
      registry,
      name: 'read_file',
      arguments: { path: equivalentPath },
      context: {
        routedTaskText: `Analyze the file ${anchoredPath}.`,
      },
    });

    expect(record.error).toBeUndefined();
    expect(handlers.read_file).toHaveBeenCalledWith(
      { path: anchoredPath },
      expect.anything(),
    );
    expect(record.arguments).toEqual({ path: anchoredPath });
    expect(record.terminalVerification?.status).toBe('verified');
  });

  it('applies POSIX absolute target anchors independently of the server host', async () => {
    const { registry, handlers } = registryWithTargetPolicyTools();
    const anchoredPath = '/home/alice/Desktop/quarterly-report.docx';
    const equivalentPath = '/home/alice/Desktop/temporary/../quarterly-report.docx';

    const record = await executeToolCall({
      registry,
      name: 'read_file',
      arguments: { path: equivalentPath },
      context: {
        routedTaskText: `Analyze the file ${anchoredPath}.`,
      },
    });

    expect(record.error).toBeUndefined();
    expect(handlers.read_file).toHaveBeenCalledWith(
      { path: anchoredPath },
      expect.anything(),
    );
    expect(record.arguments).toEqual({ path: anchoredPath });
  });

  it('returns one redacted evidence-bearing receipt for successful execution', async () => {
    const { registry, handler } = registryWithTool();
    const onToolStart = vi.fn();
    const record = await executeToolCall({
      registry,
      id: 'call-1',
      name: 'read_demo',
      arguments: { target: 'desktop', apiToken: 'secret-value' },
      context: { onToolStart },
    });

    expect(record.arguments).toEqual({ target: 'desktop', apiToken: '[redacted]' });
    expect(record.evidence).toEqual({
      capability: 'demo_read',
      operation: 'observe',
      assurance: 'observed',
      scope: ['desktop'],
    });
    expect(toolRecordSucceeded(record)).toBe(true);
    expect(handler).toHaveBeenCalledWith(
      { target: 'desktop', apiToken: 'secret-value' },
      expect.anything(),
    );
    expect(onToolStart).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'read_demo',
      arguments: { target: 'desktop', apiToken: '[redacted]' },
    });
  });

  it('records policy and preflight failures instead of leaking divergent throw paths', async () => {
    const { registry, handler } = registryWithTool();
    const preflight = await executeToolCall({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
      preflight: () => ({ allowed: false, reason: 'Target is stale.' }),
    });
    const forbidden = await executeToolCall({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
      context: {
        toolPolicy: {
          allowedTools: [],
          forbiddenTools: ['*'],
          requireConfirmation: [],
          maxIterations: 0,
        },
      },
    });

    expect(preflight.error).toBe('Target is stale.');
    expect(forbidden.error).toMatch(/forbidden/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps string-or-throw callers on the same receipt-producing execution path', async () => {
    const { registry } = registryWithTool();
    await expect(executeToolCallOrThrow({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
    })).resolves.toContain('"ok":true');
    await expect(executeToolCallOrThrow({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
      preflight: () => ({ allowed: false, reason: 'blocked before start' }),
    })).rejects.toMatchObject({
      message: 'blocked before start',
      toolRecord: expect.objectContaining({
        name: 'read_demo',
        error: 'blocked before start',
      }),
    });
  });

  it('throws when execution returned but terminal verification did not pass', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'unverified_demo',
      description: 'Returns a relay result without post-state evidence.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'demo.unverified',
        family: 'demo',
        lane: 'client',
        operation: 'mutate',
        risk: 'low',
        sideEffects: [{ type: 'desktop_control', scope: 'test state', reversible: true }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['verified post-state'],
          limitations: [],
        },
      },
      handler: async () => JSON.stringify({ ok: true, status: 'relayed' }),
    });

    const record = await executeToolCall({ registry, name: 'unverified_demo' });
    expect(record.envelope?.status).toBe('failed');
    await expect(executeToolCallOrThrow({ registry, name: 'unverified_demo' })).rejects.toMatchObject({
      message: expect.stringMatching(/no verified post-action state/i),
      toolRecord: expect.objectContaining({
        terminalVerification: expect.objectContaining({ status: 'unverified' }),
      }),
    });
  });

  it('verifies a statusless structured receipt from an inferred read-only capability', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_native_items',
      description: 'Read native items.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      evidence: {
        capability: 'native.items.read',
        operation: 'observe',
        assurance: 'observed',
      },
      handler: async () => JSON.stringify([{ id: 'item-1', name: 'Native item' }]),
    });

    const record = await executeToolCall({ registry, name: 'read_native_items' });
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.envelope?.status).toBe('verified_success');
  });

  it('separates backward-compatible human output from the terminal receipt', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'enveloped_demo',
      description: 'Returns readable content plus exact terminal evidence.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'demo.enveloped',
        family: 'demo',
        lane: 'industry',
        operation: 'mutate',
        risk: 'medium',
        sideEffects: [{ type: 'local_state_change', scope: 'test state', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok', 'status', 'persisted'],
          requiredValues: { ok: true, persisted: true },
          successStatuses: ['updated'],
          successSignals: ['persisted receipt'],
          limitations: [],
        },
      },
      handler: async () => encodeToolResult('Readable result\n- Item ID: demo-1', {
        ok: true,
        status: 'updated',
        persisted: true,
      }),
    });

    const direct = await registry.execute('enveloped_demo', {});
    expect(direct).toContain('Readable result\n- Item ID: demo-1');

    const record = await executeToolCall({ registry, name: 'enveloped_demo' });
    expect(record.result).toBe('Readable result\n- Item ID: demo-1');
    expect(record.result).not.toContain('LUMI_TOOL_RECEIPT');
    expect(record.receipt).toEqual({ ok: true, status: 'updated', persisted: true });
    expect(record.terminalVerification?.status).toBe('verified');
  });

  it('never retries a timed-out read while its original pinned handler is still pending', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let rejectFirst!: (error: Error) => void;
    const handler = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, status: 'observed' }));
    registry.register({
      name: 'mcp_registry_timeout_read_test',
      description: 'Read-only timeout fence integration test.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'test.registry.timeout.read',
        family: 'test',
        lane: 'knowledge',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'network_read', scope: 'test endpoint', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok', 'status'],
          requiredValues: { ok: true },
          successStatuses: ['observed'],
          successSignals: ['read receipt'],
          limitations: [],
        },
      },
      handler,
    });

    const execution = executeToolCall({ registry, name: 'mcp_registry_timeout_read_test' });
    let settled = false;
    void execution.finally(() => { settled = true; }).catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    rejectFirst(new Error('transport closed after cancellation'));
    await vi.advanceTimersByTimeAsync(250);
    const record = await execution;

    expect(handler).toHaveBeenCalledTimes(2);
    expect(record.adapterSettlements).toEqual([
      expect.objectContaining({ attempt: 1, status: 'rejected', timedOut: true }),
      expect.objectContaining({ attempt: 2, status: 'fulfilled', timedOut: false }),
    ]);
    expect(record.envelope?.status).toBe('verified_success');
  });

  it('keeps an explicitly idempotent local mutation fenced as unknown until its handler settles', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let rejectHandler!: (error: Error) => void;
    const handler = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    registry.register({
      name: 'local_mutation_timeout_fence_test',
      description: 'Local mutation timeout fence integration test.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
      permission: 'public',
      securityLevel: 'confirm',
      capability: {
        id: 'test.registry.timeout.local-mutation',
        family: 'test',
        lane: 'files',
        operation: 'mutate',
        risk: 'medium',
        sideEffects: [{ type: 'local_state_change', scope: 'test state', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['mutation receipt'],
          limitations: [],
        },
      },
      handler,
    });
    const context = { userConfirmed: true, idempotencyKey: 'local-mutation-timeout-key' };

    const args = { target: 'local-state-a' };
    const first = registry.execute('local_mutation_timeout_fence_test', args, context);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(registry.execute(
      'local_mutation_timeout_fence_test',
      { target: 'local-state-b' },
      context,
    )).rejects.toThrow(/target mismatch.*idempotency key/i);
    const duplicate = registry.execute('local_mutation_timeout_fence_test', args, context);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);

    rejectHandler(new Error('local adapter cancelled'));
    await expect(first).rejects.toMatchObject({
      name: 'ToolHandlerSettledAfterTimeoutError',
      toolExecutionTimedOut: true,
      handlerSettlement: 'rejected',
    });
    await expect(duplicate).rejects.toMatchObject({
      name: 'ToolHandlerSettledAfterTimeoutError',
      handlerSettlement: 'rejected',
    });
    await expect(registry.execute('local_mutation_timeout_fence_test', args, context))
      .rejects.toThrow(/unknown prior outcome.*automatic resend was stopped/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('scopes a local side-effect fence by user, domain, and organization while retaining same-scope single-flight', async () => {
    const registry = new ToolRegistry();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let invocation = 0;
    const handler = vi.fn(async () => {
      invocation += 1;
      const currentInvocation = invocation;
      if (currentInvocation === 1) await firstGate;
      return JSON.stringify({ ok: true, status: 'updated', invocation: currentInvocation });
    });
    registry.register({
      name: 'local_mutation_scoped_fence_test',
      description: 'Scoped local mutation fence integration test.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
      permission: 'public',
      securityLevel: 'confirm',
      capability: {
        id: 'test.registry.scoped.local-mutation',
        family: 'test',
        lane: 'files',
        operation: 'mutate',
        risk: 'medium',
        sideEffects: [{ type: 'local_state_change', scope: 'test state', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['mutation receipt'],
          limitations: [],
        },
      },
      handler,
    });

    const args = { target: 'shared-local-state' };
    const sameScope = {
      userConfirmed: true,
      idempotencyKey: 'same-logical-local-mutation',
      userId: 'user-a',
      domain: 'work' as const,
      orgId: 'org-a',
    };
    const first = registry.execute('local_mutation_scoped_fence_test', args, sameScope);
    await Promise.resolve();
    const concurrentDuplicate = registry.execute('local_mutation_scoped_fence_test', args, sameScope);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);

    releaseFirst();
    const [firstResult, duplicateResult] = await Promise.all([first, concurrentDuplicate]);
    expect(duplicateResult).toBe(firstResult);
    expect(JSON.parse(firstResult).invocation).toBe(1);

    const otherUser = await registry.execute('local_mutation_scoped_fence_test', args, {
      ...sameScope,
      userId: 'user-b',
    });
    const otherOrganization = await registry.execute('local_mutation_scoped_fence_test', args, {
      ...sameScope,
      orgId: 'org-b',
    });
    const otherDomain = await registry.execute('local_mutation_scoped_fence_test', args, {
      ...sameScope,
      domain: 'personal' as const,
      orgId: '',
    });

    expect(JSON.parse(otherUser).invocation).toBe(2);
    expect(JSON.parse(otherOrganization).invocation).toBe(3);
    expect(JSON.parse(otherDomain).invocation).toBe(4);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('directly propagates branded adapter-start persistence failures without manufacturing a record', async () => {
    const { registry, handler } = registryWithTool();
    const failure = new ToolLifecyclePersistenceError(new Error('durable adapter-start write failed'));

    await expect(executeToolCall({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
      context: { onAdapterStart: async () => { throw failure; } },
    })).rejects.toBe(failure);
    expect(handler).not.toHaveBeenCalled();
  });

  it('directly propagates branded settlement persistence failures after the real handler settles', async () => {
    const { registry, handler } = registryWithTool();
    const failure = new ToolLifecyclePersistenceError(new Error('durable settlement write failed'));

    await expect(executeToolCall({
      registry,
      name: 'read_demo',
      arguments: { target: 'desktop' },
      context: { onAdapterSettlement: async () => { throw failure; } },
    })).rejects.toBe(failure);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not let a provider handler spoof the lifecycle-persistence control path', async () => {
    const registry = new ToolRegistry();
    const spoof = new Error('provider failure');
    spoof.name = 'ToolLifecyclePersistenceError';
    registry.register({
      name: 'read_lifecycle_name_spoof',
      description: 'Provider error-name spoof test.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      evidence: {
        capability: 'test.lifecycle-name-spoof',
        operation: 'observe',
        assurance: 'observed',
      },
      handler: async () => { throw spoof; },
    });

    await expect(executeToolCall({ registry, name: 'read_lifecycle_name_spoof' }))
      .resolves.toMatchObject({ error: 'provider failure' });
  });
});
