import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import * as OrgDB from '../server/org/db';
import { mountAgentRoutes } from '../server/routes/agent_routes';
import { addMessage, getOrCreateActiveConversation } from '../server/conversation/manager';

describe('organization team agent boundaries', () => {
  let cleanup = () => {};
  let baseUrl = '';
  let orgId = '';
  let agentId = '';
  const ownerId = `agent-org-owner-${Date.now()}`;
  const memberA = `agent-org-member-a-${Date.now()}`;
  const memberB = `agent-org-member-b-${Date.now()}`;
  const viewerId = `agent-org-viewer-${Date.now()}`;

  function token(userId: string, work = true): string {
    return jwt.sign({
      uid: userId,
      username: userId,
      role: 'user',
      ...(work ? { orgId } : {}),
    }, JWT_SECRET);
  }

  function headers(userId: string, work = true): Record<string, string> {
    return { 'Content-Type': 'application/json', Cookie: `token=${token(userId, work)}` };
  }

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    const org = OrgDB.createOrg('Agent Scope Org', `agent-scope-${Date.now()}`, ownerId);
    orgId = org.id;
    OrgDB.addMember(orgId, ownerId, 'owner');
    OrgDB.addMember(orgId, memberA, 'member');
    OrgDB.addMember(orgId, memberB, 'member');
    OrgDB.addMember(orgId, viewerId, 'viewer');
    mountAgentRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);
  });

  afterAll(() => cleanup());

  it('keeps viewers read-only while members can create organization agents', async () => {
    const viewer = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: headers(viewerId),
      body: JSON.stringify({ name: 'Viewer Agent' }),
    });
    expect(viewer.status).toBe(403);

    const created = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: headers(memberA),
      body: JSON.stringify({ name: 'Member Agent', skillTags: ['legal'] }),
    });
    expect(created.ok).toBe(true);
    const agent = await created.json();
    agentId = agent.id;
    expect(agent).toMatchObject({ ownerUid: memberA, domain: 'work', orgId });
  });

  it('lets creators and administrators manage an agent but not unrelated members', async () => {
    const unrelated = await fetch(`${baseUrl}/api/agents/${agentId}`, {
      method: 'PUT',
      headers: headers(memberB),
      body: JSON.stringify({ name: 'Unauthorized rename' }),
    });
    expect(unrelated.status).toBe(404);

    const owner = await fetch(`${baseUrl}/api/agents/${agentId}`, {
      method: 'PUT',
      headers: headers(ownerId),
      body: JSON.stringify({ name: 'Owner approved name' }),
    });
    expect(owner.ok).toBe(true);
    expect((await owner.json()).name).toBe('Owner approved name');
  });

  it('does not expose organization agents or personal history across Lumi domains', async () => {
    const personalList = await fetch(`${baseUrl}/api/agents`, { headers: headers(memberA, false) });
    expect(personalList.ok).toBe(true);
    expect((await personalList.json()).some((agent: any) => agent.id === agentId)).toBe(false);

    const personalConversation = getOrCreateActiveConversation(ownerId, 'lumi', 'personal', '');
    addMessage({
      userId: ownerId,
      agentId: 'lumi',
      conversationId: personalConversation.id,
      role: 'user',
      content: 'personal-only-history-marker',
      domain: 'personal',
      orgId: '',
    });

    const workHistory = await fetch(`${baseUrl}/api/agents/lumi/history`, { headers: headers(ownerId) });
    expect(workHistory.ok).toBe(true);
    expect(JSON.stringify(await workHistory.json())).not.toContain('personal-only-history-marker');
  });
});
