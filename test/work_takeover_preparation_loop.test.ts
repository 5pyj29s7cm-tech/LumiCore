import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ value: undefined as string | undefined, writes: 0 }));
vi.mock('../server/persistence/settings_repository', () => ({
  readSettingRecord: (key: string) => storage.value === undefined ? undefined : { key, value: storage.value },
  writeSetting: (_key: string, value: string) => { storage.value = value; storage.writes++; },
}));
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkTakeoverTools } from '../server/tools/definitions/work_takeover_tools';
import { createWorkTakeoverTask, getWorkTakeoverTask } from '../server/work_takeover/tasks';
import { boundedWorkTakeoverSteps, runWorkTakeoverPreparation } from '../server/work_takeover/preparation_loop';
import { getWorkTakeoverExecutionProgress, planWorkTakeoverExecution } from '../server/work_takeover/execution_planner';
import { runWorkTakeoverCapabilityReuseProbe } from '../server/work_takeover/capability_reuse_probe';
const scope = { userId: 'loop-owner', domain: 'personal', orgId: '' };
function fixture() {
  const task = createWorkTakeoverTask({ ...scope, category: 'general_work', title: 'Prepare notes', summary: '整理已有资料和清单', nextActions: ['整理资料'] });
  storage.writes = 0;
  return task;
}
beforeAll(async () => { const { initDatabase } = await import('../db_layer'); await initDatabase(); });
beforeEach(() => { storage.value = undefined; storage.writes = 0; });
describe('one bounded local preparation loop', () => {
  it.each(['work_takeover_task_autorun', 'work_takeover_capability_reuse_probe'])('does not prepare the same step repeatedly without recording: %s', async name => {
    const task = fixture(), before = storage.value;
    const registry = new ToolRegistry(); registerWorkTakeoverTools(registry);
    const result = JSON.parse(await registry.get(name)!.handler({ id: task.id, record: false, exportPacket: false, maxSteps: 5 }, scope));
    expect(result.executions).toHaveLength(1);
    expect(result.progress).toEqual(getWorkTakeoverExecutionProgress(task, planWorkTakeoverExecution(task)));
    expect(result.task).toEqual(task); expect(storage.value).toBe(before); expect(storage.writes).toBe(0);
    if (name === 'work_takeover_task_autorun') expect(result.report.stopReasons).toEqual(['step_not_recorded']);
  });
  it('records distinct steps once and reports the completed safe loop', () => {
    const task = fixture();
    const result = runWorkTakeoverPreparation(task, { mode: 'prepare_work', maxSteps: 6, record: true, stopOnConfirmation: false });
    const stepIds = result.executions.map(item => item.step.id);
    expect(stepIds.length).toBeGreaterThan(1); expect(new Set(stepIds).size).toBe(stepIds.length);
    expect(result.progress.complete).toBe(true); expect(result.stopReasons).toEqual(['safe_steps_complete']);
    expect(storage.writes).toBe(stepIds.length); expect(getWorkTakeoverTask(scope.userId, task.id)).toEqual(result.task);
  });
  it('stops once the prepared step reaches a confirmation boundary', () => {
    const task = createWorkTakeoverTask({ ...scope, category: 'customer', summary: 'Prepare customer follow-up and quote', nextActions: ['Review quote'] });
    storage.writes = 0;
    const result = runWorkTakeoverPreparation(task, { mode: 'prepare_work', maxSteps: 6, record: true, stopOnConfirmation: true });
    expect(result.executions.at(-1)?.status).toBe('waiting_confirmation'); expect(result.stopReasons).toEqual(['waiting_confirmation']);
    expect(result.task.status).toBe('waiting_confirmation'); expect(storage.writes).toBe(result.executions.length);
  });
  it('records a blocker once and stops', () => {
    const task = createWorkTakeoverTask({ ...scope, category: 'unknown' }); storage.writes = 0;
    const result = runWorkTakeoverPreparation(task, { mode: 'prepare_work', maxSteps: 6, record: true, stopOnConfirmation: false });
    expect(result.executions).toHaveLength(1); expect(result.stopReasons).toEqual(['blocked']);
    expect(result.task.status).toBe('blocked'); expect(storage.writes).toBe(1);
  });
  it.each(['cancelled', 'delivered'] as const)('never prepares a terminal task even without recording: %s', status => {
    const task = createWorkTakeoverTask({ ...scope, category: 'general_work', summary: 'Read notes', status });
    const before = storage.value; storage.writes = 0;
    expect(() => runWorkTakeoverPreparation(task, { mode: 'prepare_work', maxSteps: 6, record: false, stopOnConfirmation: true })).toThrow('terminal');
    expect(storage.value).toBe(before); expect(storage.writes).toBe(0);
  });
  it('honors zero requested probe steps without inventing preparation progress', async () => {
    const task = fixture(), before = storage.value;
    const result = await runWorkTakeoverCapabilityReuseProbe({ ...scope, id: task.id, maxSteps: 0, record: false, exportPacket: false });
    expect(result.executions).toEqual([]); expect(result.task).toEqual(task);
    expect(storage.value).toBe(before); expect(storage.writes).toBe(0);
  });
  it('can disable the probe loop while retaining a read-only plan', async () => {
    const task = fixture(), before = storage.value;
    const result = await runWorkTakeoverCapabilityReuseProbe({ ...scope, id: task.id, runSafeLoop: false, maxSteps: 5, record: false, exportPacket: false });
    expect(result.executions).toEqual([]); expect(result.plan.taskId).toBe(task.id); expect(storage.value).toBe(before);
  });
  it.each([[undefined, 2], [NaN, 2], [Infinity, 2], [0, 0], [-5, 0], [2.9, 2], [100, 5]])('normalizes finite integer step budgets: %s', (value, expected) => {
    expect(boundedWorkTakeoverSteps(value, 2, 5)).toBe(expected);
  });
});
