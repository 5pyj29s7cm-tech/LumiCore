import './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { mountMemoryRoutes } from '../server/routes/memory_routes';
import {
  addMemory,
  queryMemories,
  removeMemory,
} from '../server/memory/store';
import * as OrgDB from '../server/org/db';

describe('memory route scope and stable evidence identity', () => {
  let cleanup = () => {};
  let baseUrl = '';
  const userId = `memory-route-scope-${Date.now()}`;
  let orgId = '';
  const createdIds: string[] = [];
  let personalId = '';
  let workId = '';
  let likedId = '';
  let dislikedId = '';

  function token(work: boolean): string {
    return jwt.sign({ uid: userId, ...(work ? { orgId } : {}) }, JWT_SECRET);
  }

  function headers(work: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${token(work)}`,
      'Content-Type': 'application/json',
    };
  }

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    mountMemoryRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);
    orgId = OrgDB.createOrg(
      'Memory Route Scope Test',
      `memory-route-scope-${Date.now()}`,
      userId,
    ).id;
    OrgDB.addMember(orgId, userId, 'owner');

    const personal = addMemory({
      userId,
      type: 'fact',
      content: 'Personal memory must remain in the personal domain.',
      keywords: ['personal'],
      confidence: 0.8,
      sourceInteractionId: 'memory-route-scope-test',
    }, { domain: 'personal', source: 'manual', userApproved: true });
    personalId = personal.id;

    const work = addMemory({
      userId,
      type: 'fact',
      content: 'Organization memory must remain in the work domain.',
      keywords: ['organization'],
      confidence: 0.8,
      sourceInteractionId: 'memory-route-scope-test',
    }, {
      domain: 'work',
      orgId,
      source: 'manual',
      privacyClass: 'organization',
      userApproved: true,
    });
    workId = work.id;

    const common = {
      userId,
      type: 'preference' as const,
      keywords: ['coffee'],
      confidence: 0.8,
      sourceInteractionId: 'memory-route-conflict-test',
    };
    likedId = addMemory({ ...common, content: 'User likes dark coffee every morning.' }, {
      domain: 'personal', source: 'manual', userApproved: true,
    }).id;
    dislikedId = addMemory({ ...common, content: 'User dislikes dark coffee every morning.' }, {
      domain: 'personal', source: 'manual', userApproved: true,
    }).id;
    createdIds.push(personalId, workId, likedId, dislikedId);
  });

  afterAll(() => {
    for (const id of createdIds) removeMemory(id);
    if (orgId) OrgDB.deleteOrg(orgId);
    cleanup();
  });

  it('rejects cross-domain update, delete, tier, and protection mutations', async () => {
    const update = await fetch(`${baseUrl}/api/memories/${personalId}`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({ content: 'Cross-domain overwrite' }),
    });
    expect(update.status).toBe(404);

    const deletion = await fetch(`${baseUrl}/api/memories/${workId}`, {
      method: 'DELETE',
      headers: headers(false),
    });
    expect(deletion.status).toBe(404);

    const tier = await fetch(`${baseUrl}/api/memory/${personalId}/tier`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({ tier: 'growth' }),
    });
    expect(tier.status).toBe(404);

    const protect = await fetch(`${baseUrl}/api/memory/${personalId}/protect`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({}),
    });
    expect(protect.status).toBe(404);

    const personal = queryMemories({ userId, domain: 'personal', minConfidence: 0, limit: 20 })
      .find(memory => memory.id === personalId);
    const work = queryMemories({ userId, domain: 'work', orgId, minConfidence: 0, limit: 20 })
      .find(memory => memory.id === workId);
    expect(personal?.content).toContain('Personal memory');
    expect(work?.content).toContain('Organization memory');
  });

  it('keeps the memory ID and evidence links stable across lifecycle changes', async () => {
    const tier = await fetch(`${baseUrl}/api/memory/${likedId}/tier`, {
      method: 'PUT',
      headers: headers(false),
      body: JSON.stringify({ tier: 'growth' }),
    });
    expect(tier.ok).toBe(true);
    const tierBody = await tier.json();
    expect(tierBody.memory).toMatchObject({ id: likedId, tier: 'growth' });
    expect(tierBody.memory.conflict.relatedMemoryIds).toContain(dislikedId);

    const protect = await fetch(`${baseUrl}/api/memory/${likedId}/protect`, {
      method: 'PUT',
      headers: headers(false),
      body: JSON.stringify({}),
    });
    expect(protect.ok).toBe(true);
    const protectBody = await protect.json();
    expect(protectBody.memory).toMatchObject({ id: likedId, tier: 'core_identity' });
    expect(protectBody.memory.conflict.relatedMemoryIds).toContain(dislikedId);
  });

  it('requires the exact scope to resolve a conflict and cleans links on route deletion', async () => {
    const crossScope = await fetch(`${baseUrl}/api/memory/${likedId}/conflict/resolve`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ resolution: 'prefer_one', chosenMemoryId: dislikedId }),
    });
    expect(crossScope.status).toBe(404);

    const resolution = await fetch(`${baseUrl}/api/memory/${likedId}/conflict/resolve`, {
      method: 'POST',
      headers: headers(false),
      body: JSON.stringify({ resolution: 'prefer_one', chosenMemoryId: dislikedId }),
    });
    expect(resolution.ok).toBe(true);
    expect((await resolution.json()).memories.every((memory: any) => (
      memory.conflict.status === 'resolved' && memory.conflict.chosenMemoryId === dislikedId
    ))).toBe(true);

    const deletion = await fetch(`${baseUrl}/api/memories/${likedId}`, {
      method: 'DELETE',
      headers: headers(false),
    });
    expect(deletion.ok).toBe(true);
    const survivor = queryMemories({ userId, domain: 'personal', minConfidence: 0, limit: 20 })
      .find(memory => memory.id === dislikedId);
    expect(survivor?.conflict).toMatchObject({
      status: 'resolved',
      resolution: 'related_removed',
      relatedMemoryIds: [],
    });
  });
});
