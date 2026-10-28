import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { randomUUID } from 'node:crypto';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';
import { resolveModelVisibleToolNames } from '../server/llm/tool_loop/runtime_activation';
import type { ToolExecutionRecord } from '../server/tools/types';
import type { ToolContext, ToolDefinition } from '../server/tools/types';
import { registerLocalDeviceTools } from '../server/tools/definitions/local_device_tools';

beforeAll(async () => { await initDatabase(); });
function fixture() {
  const registry = new ToolRegistry();
  const handlers = { device_signal: vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' })), dispatch_notice: vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' })) };
  for (const [name, effect, operation] of [
    ['device_signal', 'external_state_change', 'mutate'],
    ['dispatch_notice', 'external_communication', 'communicate'],
    ['local_settings_update', 'local_state_change', 'mutate'],
    ['write_file', 'local_write', 'create'],
    ['opaque_runner', 'process_execution', 'mutate'],
    ['read_status', 'local_read', 'observe'],
    ['client_capability_manifest', 'local_read', 'observe'],
  ] as const) {
    registry.register({ name, description: name.replaceAll('_', ' '), permission: 'user', securityLevel: effect.startsWith('external_') ? 'confirm' : 'safe',
      parameters: { type: 'object', properties: { target: { type: 'string' } } },
      capability: { id: 'test.' + name, family: 'generic-action', lane: 'system', operation, risk: 'medium',
        sideEffects: [{ type: effect, scope: 'declared fixture target', reversible: !effect.startsWith('external_') }],
        verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok','status'], requiredValues: { ok: true, status: 'completed' }, successStatuses: ['completed'], successSignals: ['fixture receipt'], limitations: [] } },
      handler: handlers[name] ?? (async () => JSON.stringify({ ok: true, status: 'completed' })),
    } as ToolDefinition);
  }
  return { registry, handlers };
}
function pipeline(registry: ToolRegistry, text: string) {
  return buildLumiExecutionPipeline({ dispatch: { userId: 'scoped-local-mutation', text, channel: 'chat', source: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry, executionBoundary: 'trusted_local' });
}

describe('local mutation restrictions do not revoke distinct external action proposals', () => {
  it.each([
    ['device_signal', '请执行 device_signal。不要修改文件或本机设置。'],
    ['dispatch_notice', 'Send a dispatch_notice to the selected target. Do not modify local files or settings.'],
    ['dispatch_notice', '只读取原文件，随后发送摘要。不要修改原文件。'],
  ] as const)('keeps %s declarable and confirmation-bound while denying local and opaque writes', async (name, text) => {
    const { registry, handlers } = fixture();
    const result = pipeline(registry, text);
    expect(result.execution.promptOverlay).toContain('Current-turn local-write boundary');
    expect(result.execution.promptOverlay).not.toContain('Current-turn read-only boundary');
    expect(result.execution.promptOverlay).not.toContain('do not create, edit, save, send, submit, control');
    expect(result.turnIntent.promptOverlay).not.toContain('Do not write, resume prior work, or mutate state');
    const manifest = registry.getCapabilityManifest(result.authorizationPolicy);
    expect(manifest.find(entry => entry.toolName === name)).toMatchObject({ executable: true, effectiveSecurityLevel: 'confirm', requiresConfirmation: true });
    for (const denied of ['local_settings_update', 'write_file', 'opaque_runner']) expect(result.authorizationPolicy.forbiddenTools).toContain(denied);
    expect(registry.getToolDeclarationsForPolicy(result.authorizationPolicy).map(tool => tool.function.name)).toContain(name);
    const discoveryContext: ToolContext = { toolPolicy: result.authorizationPolicy, modelToolProjection: { toolNames: ['client_capability_manifest'], maxTools: 3, allowDynamicDiscovery: true, discoveryToolName: 'client_capability_manifest' } };
    const discovered = resolveModelVisibleToolNames(discoveryContext, [{ name: 'client_capability_manifest', arguments: { query: name },
      result: JSON.stringify({ capabilities: manifest.filter(entry => entry.toolName === name).map(entry => ({ ...entry, executableThisTurn: entry.executable })) }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'fixture manifest receipt' } } as ToolExecutionRecord], registry);
    expect(registry.getToolDeclarationsForPolicy(result.authorizationPolicy, { context: discoveryContext, visibleToolNames: discovered }).map(tool => tool.function.name)).toContain(name);
    let decide!: (approved: boolean) => void;
    const decision = new Promise<boolean>(resolve => { decide = resolve; });
    const proposal = vi.fn(async () => decision);
    const context: ToolContext = { userId: 'scoped-local-mutation', authenticated: true, localExecution: true, executionBoundary: 'trusted_local', source: 'chat',
      taskId: randomUUID(), requestId: randomUUID(), toolPolicy: result.authorizationPolicy, requestConfirmation: proposal };
    const pending = registry.execute(name, { target: 'exact fixture target' }, context);
    await vi.waitFor(() => expect(proposal).toHaveBeenCalledOnce());
    expect(proposal.mock.calls[0].slice(0, 2)).toEqual([name, { target: 'exact fixture target' }]);
    expect(handlers[name]).not.toHaveBeenCalled();
    decide(false);
    expect(await pending).toContain('requires user confirmation and was not approved');
    expect(handlers[name]).not.toHaveBeenCalled();
    const approved = await registry.execute(name, { target: 'exact fixture target' }, { ...context, taskId: randomUUID(), requestId: randomUUID(), requestConfirmation: async () => true });
    expect(approved).toContain('completed');
    expect(handlers[name]).toHaveBeenCalledOnce();
  });

  it.each([
    '只读检查设备状态，不要执行任何动作。',
    'Read-only inspection; do not execute any further actions.',
    '读取状态，不要修改文件，也不要发送或提交。',
  ])('retains whole-turn/external prohibitions: %s', text => {
    const { registry } = fixture(); const result = pipeline(registry, text);
    const declared = registry.getToolDeclarationsForPolicy(result.authorizationPolicy).map(tool => tool.function.name);
    expect(declared).not.toContain('device_signal'); expect(declared).not.toContain('dispatch_notice'); expect(declared).not.toContain('write_file');
  });

  it('keeps an explicit personality denial stronger than a local-only limit', () => {
    const { registry } = fixture();
    const result = buildLumiExecutionPipeline({ dispatch: { userId: 'scoped-local-mutation', text: '执行 device_signal，不要修改文件。', channel: 'chat', source: 'chat', targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: ['device_signal'], requireConfirmation: [], maxIterations: 5 }, executionBoundary: 'trusted_local' });
    expect(registry.getToolDeclarationsForPolicy(result.authorizationPolicy).map(tool => tool.function.name)).not.toContain('device_signal');
  });

  it('reproduces the real installed-printer instruction without invoking any device adapter', () => {
    const registry = new ToolRegistry(); registerLocalDeviceTools(registry);
    const result = pipeline(registry, '请使用已安装的 Windows 打印队列“Fixture physical network queue”打印一张 Lumi 内置测试页，只提交一次。完成后返回实际打印任务编号，并使用同一队列与任务编号读取该任务的状态。不要打印其他内容，不要修改队列或默认打印机设置。');
    expect(result.execution.promptOverlay).toContain('Current-turn local-write boundary');
    expect(result.execution.promptOverlay).not.toContain('Current-turn read-only boundary');
    expect(result.turnIntent.promptOverlay).not.toContain('Do not write, resume prior work, or mutate state');
    const manifest = registry.getCapabilityManifest(result.authorizationPolicy);
    expect(manifest.find(entry => entry.toolName === 'printer_print_test_page')).toMatchObject({ executable: true, requiresConfirmation: true });
    expect(registry.getToolDeclarationsForPolicy(result.authorizationPolicy).map(tool => tool.function.name)).toContain('printer_print_test_page');
  });
});
