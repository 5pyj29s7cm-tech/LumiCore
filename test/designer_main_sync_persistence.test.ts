import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as DB from '../db_layer';
import { makeApp, JWT_SECRET } from './helpers';
import { mountInteriorProjectRoutes } from '../server/design/project_routes';
import { createInteriorProject, getActiveInteriorProject, getInteriorProject, listInteriorProjects, personalInteriorProjectScope, setActiveInteriorProject } from '../server/design/projects';
import { createInteriorProjectAsset } from '../server/design/project_assets';
import { hydrateDatabaseProjection } from '../server/db/hydrate';

describe('designer projects on the main scoped persistence runtime', () => {
  let url = '', cleanup = () => {};
  const headers = (uid: string) => ({ 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET)}` });
  beforeAll(async () => {
    const app = await makeApp(); url = app.url; cleanup = app.cleanup;
    mountInteriorProjectRoutes(app.apiRouter);
  });
  afterAll(() => cleanup());
  afterEach(() => vi.restoreAllMocks());

  it('rolls back a failed personal create and active selection without losing another user write', async () => {
    const owner = 'sync-save-failure', scope = personalInteriorProjectScope(owner);
    const original = createInteriorProject(scope, owner, { name: 'Saved brief' });
    setActiveInteriorProject(scope, owner, original.id);
    await DB.flushDBOrThrow();
    const other = 'sync-concurrent', otherScope = personalInteriorProjectScope(other);
    vi.spyOn(DB, 'flushDBOrThrow').mockImplementationOnce(async () => {
      const concurrent = createInteriorProject(otherScope, other, { name: 'Other user brief' });
      setActiveInteriorProject(otherScope, other, concurrent.id);
      throw new Error('Synthetic disk write failure');
    });
    const response = await fetch(`${url}/api/personal/interior/projects`, {
      method: 'POST', headers: headers(owner), body: JSON.stringify({ name: 'Unsaved new brief' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    expect(listInteriorProjects(scope).map(project => project.name)).toEqual(['Saved brief']);
    expect(getActiveInteriorProject(scope, owner)?.id).toBe(original.id);
    expect(getActiveInteriorProject(otherScope, other)?.name).toBe('Other user brief');
  });

  it('does not publish success before the save barrier', async () => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const flush = DB.flushDBOrThrow;
    vi.spyOn(DB, 'flushDBOrThrow').mockImplementationOnce(async () => { entered(); await barrier; await flush(); });
    let received = false;
    const request = fetch(`${url}/api/personal/interior/projects`, {
      method: 'POST', headers: headers('sync-barrier'), body: JSON.stringify({ name: 'Save barrier brief' }),
    }).then(response => { received = true; return response; });
    await waiting;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(received).toBe(false);
    release();
    const response = await request;
    expect(response.status).toBe(201);
    const project = await response.json();
    expect((await DB.querySQL<any>('SELECT id FROM interior_projects WHERE id = ?', [project.id]))[0]?.id).toBe(project.id);
  });

  it('hydrates legacy designer SQL rows, attachments and active selections through the new main projection', async () => {
    const owner = 'sync-hydration', scope = personalInteriorProjectScope(owner);
    const project = createInteriorProject(scope, owner, { name: 'Retained design', brief: { area: '88 m2' } });
    setActiveInteriorProject(scope, owner, project.id);
    const asset = createInteriorProjectAsset({ orgId: scope, projectId: project.id, fileId: 'legacy-plan.dxf', displayName: 'Measured plan', uploadedBy: owner, category: 'cad' });
    await DB.flushDBOrThrow();
    const reloaded = await hydrateDatabaseProjection(DB.querySQL);
    expect(reloaded.data.interiorProjects.find((item: any) => item.id === project.id)).toEqual(getInteriorProject(scope, project.id));
    expect(reloaded.data.interiorProjectAssets.find((item: any) => item.id === asset.id)).toEqual(asset);
    const selections = JSON.parse(reloaded.data.settings.find((item: any) => item.key === 'interior_active_projects_v1').value);
    expect(selections[`${scope}::${owner}`]).toBe(project.id);
  });
});
