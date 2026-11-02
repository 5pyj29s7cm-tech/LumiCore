import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flushDBOrThrow, querySQL, readDB } from '../db_layer';
import { addMember, createOrg } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { JWT_SECRET, makeApp } from './helpers';

describe('spatial and interior project workflow', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `interior-owner-${suffix}`;
  const memberId = `interior-member-${suffix}`;
  const viewerId = `interior-viewer-${suffix}`;
  const foreignId = `interior-foreign-${suffix}`;
  let orgId = '';
  let foreignOrgId = '';
  let baseUrl = '';
  let cleanup = () => {};

  function headers(userId: string, targetOrgId = orgId): Record<string, string> {
    const token = jwt.sign({ uid: userId, username: userId, role: 'user', orgId: targetOrgId }, JWT_SECRET);
    return { 'Content-Type': 'application/json', Cookie: `token=${token}` };
  }

  function personalHeaders(userId: string): Record<string, string> {
    const token = jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
    return { 'Content-Type': 'application/json', Cookie: `token=${token}` };
  }

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    mountOrgRoutes(app.apiRouter);
    const fileRoutes = await import('../routes/files');
    fileRoutes.configureKnowledgeFileRoutes({ llmGetters: {} });
    app.apiRouter.use('/', fileRoutes.default);

    orgId = createOrg(`Interior Projects ${suffix}`, `interior-projects-${suffix}`, ownerId).id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberId, 'member');
    addMember(orgId, viewerId, 'viewer');

    foreignOrgId = createOrg(`Foreign Interior ${suffix}`, `foreign-interior-${suffix}`, foreignId).id;
    addMember(foreignOrgId, foreignId, 'owner');
  });

  afterAll(() => cleanup());

  it('creates, lists, updates, and durably persists one shared project brief', async () => {
    const createdResponse = await fetch(`${baseUrl}/api/org/interior/projects`, {
      method: 'POST',
      headers: headers(memberId),
      body: JSON.stringify({
        name: 'Riverside Apartment',
        projectType: 'residential',
        brief: {
          location: 'Shanghai',
          area: '128 m2',
          occupants: 'Two adults and one child',
          budget: 'CNY 800,000',
          style: 'Warm natural materials',
          requirements: 'Open living and dining area; generous storage.',
          constraints: 'Existing structure and wet-area stacks remain.',
        },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created).toMatchObject({
      orgId,
      ownerUserId: memberId,
      name: 'Riverside Apartment',
      projectType: 'residential',
      status: 'brief',
      brief: { area: '128 m2', location: 'Shanghai' },
    });

    const viewerListResponse = await fetch(`${baseUrl}/api/org/interior/projects`, {
      headers: headers(viewerId),
    });
    expect(viewerListResponse.status).toBe(200);
    const viewerList = await viewerListResponse.json();
    expect(viewerList.projects).toHaveLength(1);
    expect(viewerList.projects[0].id).toBe(created.id);

    const updatedResponse = await fetch(`${baseUrl}/api/org/interior/projects/${created.id}`, {
      method: 'PUT',
      headers: headers(memberId),
      body: JSON.stringify({
        status: 'design',
        brief: { budget: 'CNY 900,000 including loose furniture' },
      }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json();
    expect(updated.status).toBe('design');
    expect(updated.brief).toMatchObject({
      location: 'Shanghai',
      area: '128 m2',
      budget: 'CNY 900,000 including loose furniture',
    });

    await flushDBOrThrow();
    const persisted = await querySQL<any>('SELECT status, payload FROM interior_projects WHERE id = ?', [created.id]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe('design');
    expect(JSON.parse(persisted[0].payload).brief.area).toBe('128 m2');
    expect(readDB().auditLog.filter((entry: any) => entry.resourceId === created.id).map((entry: any) => entry.action))
      .toEqual(['interior_project.created', 'interior_project.updated']);
  });

  it('enforces organization isolation and read-only viewer access', async () => {
    const createdResponse = await fetch(`${baseUrl}/api/org/interior/projects`, {
      method: 'POST',
      headers: headers(ownerId),
      body: JSON.stringify({ name: 'Private Office', projectType: 'office' }),
    });
    const created = await createdResponse.json();

    const viewerUpdate = await fetch(`${baseUrl}/api/org/interior/projects/${created.id}`, {
      method: 'PUT',
      headers: headers(viewerId),
      body: JSON.stringify({ name: 'Viewer overwrite' }),
    });
    expect(viewerUpdate.status).toBe(403);

    const foreignGet = await fetch(`${baseUrl}/api/org/interior/projects/${created.id}`, {
      headers: headers(foreignId, foreignOrgId),
    });
    expect(foreignGet.status).toBe(404);

    const foreignList = await fetch(`${baseUrl}/api/org/interior/projects`, {
      headers: headers(foreignId, foreignOrgId),
    });
    expect((await foreignList.json()).projects).toEqual([]);
  });

  it('uploads, categorizes, lists, and safely unlinks project files', async () => {
    const projectResponse = await fetch(`${baseUrl}/api/org/interior/projects`, {
      method: 'POST',
      headers: headers(memberId),
      body: JSON.stringify({ name: 'Site Survey Project', projectType: 'retail' }),
    });
    const project = await projectResponse.json();

    const form = new FormData();
    form.append('files', new Blob(['Measured plan notes: storefront width 8.4 m.']), 'survey-notes.txt');
    form.append('domain', 'work');
    form.append('interiorProjectId', project.id);
    form.append('interiorAssetCategory', 'floor-plan');
    const uploadResponse = await fetch(`${baseUrl}/api/files/upload?domain=work`, {
      method: 'POST',
      headers: { Cookie: headers(memberId).Cookie },
      body: form,
    });
    expect(uploadResponse.status).toBe(200);
    const upload = await uploadResponse.json();
    expect(upload.files[0].interiorProjectAsset).toMatchObject({
      orgId,
      projectId: project.id,
      displayName: 'survey-notes.txt',
      category: 'floor-plan',
      status: 'active',
    });
    const asset = upload.files[0].interiorProjectAsset;

    const listResponse = await fetch(`${baseUrl}/api/org/interior/projects/${project.id}/assets`, {
      headers: headers(viewerId),
    });
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).assets).toMatchObject([{ id: asset.id, category: 'floor-plan' }]);

    const viewerUpdate = await fetch(`${baseUrl}/api/org/interior/projects/${project.id}/assets/${asset.id}`, {
      method: 'PUT',
      headers: headers(viewerId),
      body: JSON.stringify({ category: 'site-photo' }),
    });
    expect(viewerUpdate.status).toBe(403);

    const updateResponse = await fetch(`${baseUrl}/api/org/interior/projects/${project.id}/assets/${asset.id}`, {
      method: 'PUT',
      headers: headers(memberId),
      body: JSON.stringify({ category: 'reference' }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).category).toBe('reference');

    const removeResponse = await fetch(`${baseUrl}/api/org/interior/projects/${project.id}/assets/${asset.id}`, {
      method: 'DELETE',
      headers: headers(memberId),
    });
    expect(removeResponse.status).toBe(200);
    expect(await removeResponse.json()).toMatchObject({ success: true, fileRetained: true });

    const emptyList = await fetch(`${baseUrl}/api/org/interior/projects/${project.id}/assets`, {
      headers: headers(memberId),
    });
    expect((await emptyList.json()).assets).toEqual([]);

    const retainedFile = await fetch(
      `${baseUrl}/api/files/info/${encodeURIComponent(asset.fileId)}?domain=work`,
      { headers: { Cookie: headers(memberId).Cookie } },
    );
    expect(retainedFile.status).toBe(200);

    await flushDBOrThrow();
    const persisted = await querySQL<any>('SELECT status, payload FROM interior_project_assets WHERE id = ?', [asset.id]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe('removed');
    expect(JSON.parse(persisted[0].payload).category).toBe('reference');
  });

  it('supports user-isolated personal projects and personal project assets without an organization', async () => {
    const personalOwner = `personal-designer-${suffix}`;
    const otherUser = `other-personal-designer-${suffix}`;
    const createdResponse = await fetch(`${baseUrl}/api/personal/interior/projects`, {
      method: 'POST',
      headers: personalHeaders(personalOwner),
      body: JSON.stringify({
        name: 'Personal Studio Project',
        projectType: 'residential',
        brief: { area: '96 m2', style: 'Warm minimal' },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const project = await createdResponse.json();
    expect(project).toMatchObject({
      orgId: `personal:${personalOwner}`,
      ownerUserId: personalOwner,
      name: 'Personal Studio Project',
    });

    const ownerList = await fetch(`${baseUrl}/api/personal/interior/projects`, {
      headers: personalHeaders(personalOwner),
    });
    expect((await ownerList.json()).projects).toMatchObject([{ id: project.id }]);

    const otherList = await fetch(`${baseUrl}/api/personal/interior/projects`, {
      headers: personalHeaders(otherUser),
    });
    expect((await otherList.json()).projects).toEqual([]);

    const foreignRead = await fetch(`${baseUrl}/api/personal/interior/projects/${project.id}`, {
      headers: personalHeaders(otherUser),
    });
    expect(foreignRead.status).toBe(404);

    const form = new FormData();
    form.append('files', new Blob(['Personal material reference']), 'personal-material.txt');
    form.append('domain', 'personal');
    form.append('interiorProjectId', project.id);
    form.append('interiorAssetCategory', 'material');
    const uploadResponse = await fetch(`${baseUrl}/api/files/upload?domain=personal`, {
      method: 'POST',
      headers: { Cookie: personalHeaders(personalOwner).Cookie },
      body: form,
    });
    expect(uploadResponse.status).toBe(200);
    const uploaded = await uploadResponse.json();
    expect(uploaded.files[0].interiorProjectAsset).toMatchObject({
      orgId: `personal:${personalOwner}`,
      projectId: project.id,
      category: 'material',
    });

    const assetsResponse = await fetch(`${baseUrl}/api/personal/interior/projects/${project.id}/assets`, {
      headers: personalHeaders(personalOwner),
    });
    expect(assetsResponse.status).toBe(200);
    expect((await assetsResponse.json()).assets).toMatchObject([{
      projectId: project.id,
      displayName: 'personal-material.txt',
      category: 'material',
    }]);

    const workSessionRead = await fetch(`${baseUrl}/api/personal/interior/projects`, {
      headers: headers(memberId),
    });
    expect(workSessionRead.status).toBe(409);
  });

  it('rejects invalid project types and oversized brief fields', async () => {
    const invalidType = await fetch(`${baseUrl}/api/org/interior/projects`, {
      method: 'POST',
      headers: headers(memberId),
      body: JSON.stringify({ name: 'Invalid Type', projectType: 'architecture' }),
    });
    expect(invalidType.status).toBe(400);

    const oversized = await fetch(`${baseUrl}/api/org/interior/projects`, {
      method: 'POST',
      headers: headers(memberId),
      body: JSON.stringify({ name: 'Oversized Brief', brief: { location: 'x'.repeat(241) } }),
    });
    expect(oversized.status).toBe(400);
  });
});
