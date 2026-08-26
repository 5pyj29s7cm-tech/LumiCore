import './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDB, writeDB } from '../db_layer';
import { queryMemories, removeMemory } from '../server/memory/store';
import * as OrgDB from '../server/org/db';
import { mountMemoryRoutes } from '../server/routes/memory_routes';
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';

type PrivateMemoryRoute = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
};

const privateMemoryRoutes: PrivateMemoryRoute[] = [
  { method: 'GET', path: '/memories' },
  { method: 'POST', path: '/memories', body: { type: 'fact', content: 'blocked' } },
  { method: 'PUT', path: '/memories/missing', body: { content: 'blocked' } },
  { method: 'DELETE', path: '/memories/missing' },
  { method: 'POST', path: '/memory/analyze-behavior', body: {} },
  { method: 'GET', path: '/reminders' },
  { method: 'POST', path: '/reminders', body: { content: 'blocked' } },
  { method: 'PUT', path: '/reminders/missing', body: { content: 'blocked' } },
  { method: 'DELETE', path: '/reminders/missing' },
  { method: 'POST', path: '/memory/consolidate', body: {} },
  { method: 'POST', path: '/memory/self-reflect', body: {} },
  { method: 'GET', path: '/memory/growth' },
  { method: 'POST', path: '/memory/missing/conflict/resolve', body: { resolution: 'keep_both' } },
  { method: 'GET', path: '/memory/tiers' },
  { method: 'PUT', path: '/memory/missing/tier', body: { tier: 'growth' } },
  { method: 'GET', path: '/memory/tree' },
  { method: 'PUT', path: '/memory/missing/move', body: { parentId: null } },
  { method: 'POST', path: '/memory/auto-organize', body: {} },
  { method: 'PUT', path: '/memory/missing/protect', body: {} },
  { method: 'GET', path: '/memory/narrative?topic=blocked' },
  { method: 'GET', path: '/memory/timeline' },
];

describe('memory route authentication boundary', () => {
  let cleanup = () => {};
  let baseUrl = '';
  const userId = `memory-security-user-${Date.now()}`;
  const anonymousInteractionIds: string[] = [];
  const userInteractionIds: string[] = [];
  const workInteractionIds: string[] = [];
  const createdMemoryIds: string[] = [];
  let anonymousMemoryBaseline = 0;
  let orgId = '';

  const personalToken = jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);

  function workToken(): string {
    return jwt.sign({ uid: userId, username: userId, role: 'user', orgId }, JWT_SECRET);
  }

  function branchToken(): string {
    return jwt.sign({
      uid: userId,
      username: userId,
      role: 'user',
      orgId,
      branchId: 'branch-memory-security',
      tokenType: 'organization_branch',
    }, JWT_SECRET);
  }

  async function request(route: PrivateMemoryRoute, token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (route.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}/api${route.path}`, {
      method: route.method,
      headers,
      ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
    });
  }

  function seedInteractions(targetUserId: string, domain: 'personal' | 'work', targetOrgId: string): string[] {
    const db = readDB();
    const ids = Array.from({ length: 12 }, (_, index) => `memory-security-${targetUserId}-${domain}-${index}-${Date.now()}`);
    db.interactions ||= [];
    for (const [index, id] of ids.entries()) {
      db.interactions.push({
        id,
        userId: targetUserId,
        domain,
        orgId: targetOrgId,
        content: `security behavior pattern alpha beta gamma ${index}`,
        role: 'user',
        toolCalls: [{ name: 'security_probe' }],
        timestamp: new Date(2026, 0, (index % 4) + 1, 9, index).toISOString(),
      });
    }
    writeDB(db);
    return ids;
  }

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    mountMemoryRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);

    orgId = OrgDB.createOrg(
      'Memory Security Test',
      `memory-security-${Date.now()}`,
      userId,
    ).id;
    OrgDB.addMember(orgId, userId, 'owner');
    anonymousInteractionIds.push(...seedInteractions('anonymous', 'personal', ''));
    userInteractionIds.push(...seedInteractions(userId, 'personal', ''));
    workInteractionIds.push(...seedInteractions(userId, 'work', orgId));
    anonymousMemoryBaseline = queryMemories({
      userId: 'anonymous',
      domain: 'personal',
      orgId: '',
      minConfidence: 0,
      limit: 100,
    }).length;
  });

  afterAll(() => {
    const db = readDB();
    const interactionIds = new Set([
      ...anonymousInteractionIds,
      ...userInteractionIds,
      ...workInteractionIds,
    ]);
    db.interactions = (db.interactions || []).filter((item: any) => !interactionIds.has(item.id));
    writeDB(db);
    for (const id of createdMemoryIds) removeMemory(id);
    if (orgId) OrgDB.deleteOrg(orgId);
    cleanup();
  });

  it('requires a user session on every private memory, reminder, and analysis endpoint', async () => {
    for (const route of privateMemoryRoutes) {
      const response = await request(route);
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
    expect(queryMemories({
      userId: 'anonymous',
      domain: 'personal',
      orgId: '',
      minConfidence: 0,
      limit: 100,
    })).toHaveLength(anonymousMemoryBaseline);
  });

  it('keeps the non-sensitive firewall policy readable without a session', async () => {
    const response = await fetch(`${baseUrl}/api/memory/firewall/policy`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.any(Object));
  });

  it('rejects organization branch tokens on every private memory endpoint', async () => {
    for (const route of privateMemoryRoutes) {
      const response = await request(route, branchToken());
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'A user session is required for this operation.',
      });
    }
  });

  it('does not create anonymous habit memory and preserves authenticated personal analysis', async () => {
    const anonymousBefore = queryMemories({
      userId: 'anonymous',
      domain: 'personal',
      orgId: '',
      minConfidence: 0,
      limit: 100,
    }).length;
    expect(anonymousBefore).toBe(anonymousMemoryBaseline);

    const rejected = await request(privateMemoryRoutes.find(route => route.path === '/memory/analyze-behavior')!);
    expect(rejected.status).toBe(401);
    expect(queryMemories({
      userId: 'anonymous',
      domain: 'personal',
      orgId: '',
      minConfidence: 0,
      limit: 100,
    })).toHaveLength(anonymousBefore);

    const accepted = await request(
      privateMemoryRoutes.find(route => route.path === '/memory/analyze-behavior')!,
      personalToken,
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).patternsFound).toBeGreaterThan(0);
    const created = queryMemories({
      userId,
      domain: 'personal',
      orgId: '',
      minConfidence: 0,
      limit: 100,
    }).filter(memory => memory.type === 'habit');
    expect(created.length).toBeGreaterThan(0);
    createdMemoryIds.push(...created.map(memory => memory.id));
  });

  it('uses the authenticated work scope and revalidates active membership', async () => {
    const accepted = await request(
      privateMemoryRoutes.find(route => route.path === '/memory/analyze-behavior')!,
      workToken(),
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).patternsFound).toBeGreaterThan(0);
    const created = queryMemories({
      userId,
      domain: 'work',
      orgId,
      minConfidence: 0,
      limit: 100,
    }).filter(memory => memory.type === 'habit');
    expect(created.length).toBeGreaterThan(0);
    expect(created.every(memory => memory.orgId === orgId && memory.domain === 'work')).toBe(true);
    createdMemoryIds.push(...created.map(memory => memory.id));

    OrgDB.setMemberStatus(orgId, userId, 'suspended');
    for (const route of privateMemoryRoutes) {
      const response = await request(route, workToken());
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'Active organization membership required.',
      });
    }
  });
});
