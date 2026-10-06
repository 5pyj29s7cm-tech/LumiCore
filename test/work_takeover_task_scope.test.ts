import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ value: undefined as string | undefined, writes: 0 }));
vi.mock('../server/persistence/settings_repository', () => ({
  readSettingRecord: (key: string) => storage.value === undefined ? undefined : { key, value: storage.value },
  writeSetting: (_key: string, value: string) => { storage.value = value; storage.writes++; },
}));
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkTakeoverTools } from '../server/tools/definitions/work_takeover_tools';
import { createWorkTakeoverTask, getScopedWorkTakeoverTask, getWorkTakeoverTask, listWorkTakeoverTasks } from '../server/work_takeover/tasks';
import { runWorkTakeoverCapabilityReuseProbe } from '../server/work_takeover/capability_reuse_probe';
import { normalizeWorkTakeoverExecutionMode } from '../server/work_takeover/execution_planner';

const userId = 'scope-owner';
const personal = { userId, domain: 'personal', orgId: '' };
const organization = { userId, domain: 'work', orgId: 'org-a' };
function fixture() {
  const local = createWorkTakeoverTask({ ...personal, category: 'general_work', title: 'Personal task', priority: 10, nextActions: ['Read personal notes'] });
  const own = createWorkTakeoverTask({ ...organization, category: 'general_work', title: 'Organization A', priority: 70 });
  const other = createWorkTakeoverTask({ userId, domain: 'work', orgId: 'org-b', category: 'general_work', title: 'Organization B', priority: 99 });
  storage.writes = 0;
  const registry = new ToolRegistry(); registerWorkTakeoverTools(registry);
  return { local, own, other, registry };
}
beforeAll(async () => { const { initDatabase } = await import('../db_layer'); await initDatabase(); });
beforeEach(() => { storage.value = undefined; storage.writes = 0; });

describe('scoped work takeover task selection', () => {
  it('selects the highest-priority task within the exact current surface', () => {
    const { local, own, other } = fixture();
    expect(getScopedWorkTakeoverTask(personal)?.id).toBe(local.id);
    expect(getScopedWorkTakeoverTask(organization)?.id).toBe(own.id);
    expect(getScopedWorkTakeoverTask(personal, other.id)).toBeNull();
    expect(getScopedWorkTakeoverTask(organization, other.id)).toBeNull();
    expect(getScopedWorkTakeoverTask({ ...organization, orgId: '' })).toBeNull();
    expect(getScopedWorkTakeoverTask({ ...personal, userId: 'different' }, local.id)).toBeNull();
    expect(listWorkTakeoverTasks({ userId, domain: 'work', orgId: '' })).toEqual([]);
  });

  it('continues the personal task instead of the higher-priority organization task', async () => {
    const { local, other, registry } = fixture();
    const result = JSON.parse(await registry.get('work_takeover_task_continue')!.handler({}, personal));
    expect(result.task.id).toBe(local.id); expect(result.task.status).toBe('in_progress');
    expect(getWorkTakeoverTask(userId, other.id)?.status).toBe('queued');
    expect(storage.writes).toBe(1);
  });

  it.each(['work_takeover_task_get', 'work_takeover_task_update', 'work_takeover_task_continue',
    'work_takeover_task_orchestrate', 'work_takeover_task_execute_step', 'work_takeover_task_advance',
    'work_takeover_task_export_packet', 'work_takeover_task_verify_result', 'work_takeover_task_autorun',
    'work_takeover_task_run_suggested_tool', 'work_takeover_evidence_start', 'work_takeover_evidence_update',
    'work_takeover_evidence_status', 'work_takeover_evidence_promote', 'work_takeover_capability_reuse_probe'])
    ('rejects the other organization before reading, writing, clipboard or adapter work: %s', async name => {
      const { other, registry } = fixture(); const desktopRelay = vi.fn(); const before = storage.value;
      await expect(registry.get(name)!.handler({ id: other.id, status: 'cancelled', toolName: 'read_file',
        message: 'Do not create a replacement task', fromClipboard: true, exportPacket: false, record: false },
        { ...organization, desktopRelay })).rejects.toThrow(/current scope/);
      expect(storage.value).toBe(before); expect(storage.writes).toBe(0); expect(desktopRelay).not.toHaveBeenCalled();
    });

  it('rejects an unknown explicit ID instead of creating or selecting a replacement task', async () => {
    const { registry } = fixture(); const before = storage.value;
    for (const name of ['work_takeover_task_autorun', 'work_takeover_capability_reuse_probe']) {
      await expect(registry.get(name)!.handler({ id: 'missing-id', message: 'A new message', exportPacket: false }, personal))
        .rejects.toThrow(/current scope/);
    }
    expect(storage.value).toBe(before); expect(storage.writes).toBe(0);
  });

  it('requires an organization before the direct probe can read the clipboard or create a task', async () => {
    fixture(); const before = storage.value; const desktopRelay = vi.fn();
    await expect(runWorkTakeoverCapabilityReuseProbe({ userId, domain: 'work', orgId: '',
      message: 'A new message', fromClipboard: true, desktopRelay })).rejects.toThrow(/organization scope/);
    expect(storage.value).toBe(before); expect(desktopRelay).not.toHaveBeenCalled();
  });

  it.each([['plan_only', 'plan_only'], ['visible_external_work', 'visible_external_work'],
    ['prepare_work', 'prepare_work'], ['unknown', 'prepare_work'], [undefined, 'prepare_work']])
    ('shares execution mode normalization: %s', (input, expected) => {
      expect(normalizeWorkTakeoverExecutionMode(input)).toBe(expected);
    });
});
