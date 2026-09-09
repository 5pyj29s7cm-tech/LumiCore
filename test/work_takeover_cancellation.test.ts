import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkTakeoverTools } from '../server/tools/definitions/work_takeover_tools';
import { createWorkTakeoverTask, getWorkTakeoverTask, updateWorkTakeoverTask } from '../server/work_takeover/tasks';
import { cancelRuntimeWork, getRuntimeWorkSnapshot } from '../server/runtime/work_control';

const bridge = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../server/tools/execution_engine', async importOriginal => ({
  ...await importOriginal<typeof import('../server/tools/execution_engine')>(),
  executeToolCall: bridge.execute,
}));
vi.mock('../server/work_takeover/execution_planner', async importOriginal => ({
  ...await importOriginal<typeof import('../server/work_takeover/execution_planner')>(),
  planWorkTakeoverExecution: () => ({ steps: [{ id: 'observe', suggestedTools: ['fake_read'] }], nextStep: { id: 'observe', suggestedTools: ['fake_read'] } }),
}));

describe('takeover execution owns its accepted task revision', () => {
  beforeAll(async () => { await initDatabase(); });

  it.each(['success', 'failure'])('does not revive a cancelled task after a late %s', async outcome => {
    const registry = new ToolRegistry();
    registerWorkTakeoverTools(registry);
    const userId = `takeover-cancel-${outcome}`;
    const task = createWorkTakeoverTask({ userId, category: 'general_work', title: 'Controlled adapter' });
    let finish!: (value: any) => void;
    let fail!: (reason: Error) => void;
    const pending = new Promise<any>((resolve, reject) => { finish = resolve; fail = reject; });
    let signal: AbortSignal | undefined;
    bridge.execute.mockImplementationOnce(({ context }) => { signal = context.executionSignal; return pending; });
    const operation = registry.get('work_takeover_task_run_suggested_tool')!.handler({ id: task.id, toolName: 'fake_read' }, { userId });
    const settled = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(false));
    const cancellation = cancelRuntimeWork({ userId, taskId: task.id, kinds: ['takeover'], scope: { domain: 'personal' } });
    expect(cancellation).toMatchObject({ status: 'cancelling', cancelledTaskIds: [], cancellingTaskIds: [task.id] });
    expect(cancellation.items[0]).toMatchObject({ status: 'cancelling', phase: 'cancelling', cancellationRequested: true, evidence: { terminal: false } });
    expect(signal?.aborted).toBe(true);
    expect(cancelRuntimeWork({ userId, taskId: task.id, kinds: ['takeover'], scope: { domain: 'personal' } })).toMatchObject({ status: 'cancelling', failedCount: 0 });
    if (outcome === 'success') finish({ name: 'fake_read', result: '{"ok":true}', arguments: {}, taskId: task.id, terminalVerification: { status: 'verified', reason: 'synthetic receipt' } }); else fail(new Error('Adapter failed late'));
    await settled;
    expect(getWorkTakeoverTask(userId, task.id)).toMatchObject({ status: 'cancelled', artifacts: [] });
    expect(getWorkTakeoverTask(userId, task.id)?.metadata.workTakeoverToolRuns).toBeUndefined();
    expect(getRuntimeWorkSnapshot(userId, ['takeover'], { domain: 'personal' }).items[0]).toMatchObject({ status: 'cancelled', phase: 'cancelled', evidence: { terminal: true } });
  });

  it('rejects concurrent execution and stale result writes after plan changes', async () => {
    const registry = new ToolRegistry();
    registerWorkTakeoverTools(registry);
    const userId = 'takeover-revision';
    const task = createWorkTakeoverTask({ userId, category: 'general_work' });
    let finish!: (value: any) => void;
    bridge.execute.mockImplementationOnce(() => new Promise<any>(resolve => { finish = resolve; }));
    const handler = registry.get('work_takeover_task_run_suggested_tool')!.handler;
    const first = handler({ id: task.id, toolName: 'fake_read' }, { userId });
    const settled = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(handler({ id: task.id, toolName: 'fake_read' }, { userId })).rejects.toThrow(/active executor/);
    updateWorkTakeoverTask(userId, task.id, { nextActions: ['Changed plan'] });
    finish({ name: 'fake_read', result: 'old plan result', arguments: {}, taskId: task.id, terminalVerification: { status: 'verified', reason: 'synthetic receipt' } });
    await settled;
    expect(() => updateWorkTakeoverTask(userId, task.id, { expectedRevision: task.revision, result: 'stale' })).toThrow(/changed/);
    expect(getWorkTakeoverTask(userId, task.id)?.nextActions).toEqual(['Changed plan']);
  });

  it('rejects resuming a terminal task at the storage boundary', () => {
    const task = createWorkTakeoverTask({ userId: 'terminal-user', category: 'general_work', status: 'cancelled' });
    expect(() => updateWorkTakeoverTask(task.userId, task.id, { status: 'in_progress' })).toThrow(/terminal/);
  });
});
