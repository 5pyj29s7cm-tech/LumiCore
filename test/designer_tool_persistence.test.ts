import './helpers';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as DB from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerDesignProjectTools } from '../server/tools/definitions/design_project_tools';
import { createInteriorProject, getActiveInteriorProject, listInteriorProjects, personalInteriorProjectScope, setActiveInteriorProject } from '../server/design/projects';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { runSerializedMutation } from '../server/persistence/durable_scope_mutation';

beforeAll(async () => { await DB.initDatabase(); });
afterEach(() => vi.restoreAllMocks());
function tools() { const registry = new ToolRegistry(); registerDesignProjectTools(registry); return registry; }

it('does not issue a verified create receipt when saving fails, and preserves another owner', async () => {
  const userId = 'tool-create-failure'; const own = personalInteriorProjectScope(userId);
  const other = personalInteriorProjectScope('other-tool-owner');
  vi.spyOn(DB, 'flushDBOrThrow').mockImplementationOnce(async () => {
    createInteriorProject(other, 'other-tool-owner', { name: 'Concurrent retained brief' });
    throw new Error('Synthetic disk failure');
  });
  const record = await executeToolCall({ registry: tools(), name: 'interior_design_project_create', arguments: { name: 'Unsaved project' }, context: { userId, domain: 'personal', requestId: 'request-save-failure' } });
  expect(record.terminalVerification?.status).not.toBe('verified');
  expect(listInteriorProjects(own)).toEqual([]);
  expect(getActiveInteriorProject(own, userId)).toBeNull();
  expect(listInteriorProjects(other).map(project => project.name)).toContain('Concurrent retained brief');
});

it('restores the previous active project when a selection cannot be saved', async () => {
  const userId = 'tool-select-failure', own = personalInteriorProjectScope(userId);
  const first = createInteriorProject(own, userId, { name: 'Previous selection' });
  const second = createInteriorProject(own, userId, { name: 'New selection' });
  setActiveInteriorProject(own, userId, first.id); await DB.flushDBOrThrow();
  vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic selection save failure'));
  await expect(tools().get('interior_design_project_select')!.handler({ projectId: second.id }, { userId, domain: 'personal' })).rejects.toThrow(/save failure/);
  expect(getActiveInteriorProject(own, userId)?.id).toBe(first.id);
});

it('waits for the durable save before returning persisted true', async () => {
  const original = DB.flushDBOrThrow; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const save = vi.spyOn(DB, 'flushDBOrThrow').mockImplementationOnce(async () => { await barrier; await original(); });
  let published = false;
  const pending = tools().get('interior_design_project_create')!.handler({ name: 'Barrier project' }, { userId: 'tool-barrier', domain: 'personal' }).then(value => { published = true; return value; });
  try { await vi.waitFor(() => expect(save).toHaveBeenCalledOnce(), { timeout: 500 }); expect(published).toBe(false); }
  finally { release(); }
  const result = JSON.parse(await pending); expect(result.persisted).toBe(true);
  expect((await DB.querySQL<any>('SELECT id FROM interior_projects WHERE id = ?', [result.project.id]))[0]?.id).toBe(result.project.id);
});

it('rechecks membership after waiting for the project scope lock', async () => {
  const userId = 'tool-revoked'; const org = createOrg('Synthetic tool studio', 'tool-studio-' + crypto.randomUUID(), userId); addMember(org.id, userId, 'owner');
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const lock = runSerializedMutation('interior-project:' + org.id, () => barrier);
  const pending = tools().get('interior_design_project_create')!.handler({ name: 'Revoked project' }, { userId, domain: 'work', orgId: org.id });
  const outcome = pending.then(() => 'published', () => 'rejected');
  removeMember(org.id, userId); release(); await lock;
  expect(await outcome).toBe('rejected'); expect(listInteriorProjects(org.id)).toEqual([]);
});
