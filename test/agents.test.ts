import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET, COOKIE_OPTS, LLM_GETTERS } from './helpers';
import { mountAuthRoutes } from '../server/routes/auth';
import { mountAgentRoutes } from '../server/routes/agent_routes';

let url: string;
let cleanup: () => void;
let token: string;
let agentId: string;
const adminToken = jwt.sign({ uid: 'agent-admin', username: 'agent-admin', role: 'admin' }, JWT_SECRET);

describe('Agent CRUD', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    mountAgentRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);

    // Register + login
    await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'agent_tester', password: 'pass123', phone: '13800002222' }),
    });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'agent_tester', password: 'pass123', phone: '13800002222' }),
    });
    token = (await login.json()).token;
  });

  afterAll(() => cleanup?.());

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Cookie': `token=${token}`,
    };
  }

  function adminHeaders() {
    return { 'Content-Type': 'application/json', 'Cookie': `token=${adminToken}` };
  }

  it('creates an agent', async () => {
    const res = await fetch(`${url}/api/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'Test Agent', category: 'assistant', personalityId: 'lumi', memoryScope: 'shared', autonomyLevel: 'reactive' }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Test Agent');
    agentId = body.id;
  });

  it('lists agents', async () => {
    const res = await fetch(`${url}/api/agents`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.find((a: any) => a.id === agentId)).toBeDefined();
  });

  it('updates an agent', async () => {
    const res = await fetch(`${url}/api/agents/${agentId}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ name: 'Updated Agent', autonomyLevel: 'full', skillTags: ['coding'] }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.name).toBe('Updated Agent');
    expect(body.autonomyLevel).toBe('full');
  });

  it('rejects update of non-existent agent', async () => {
    const res = await fetch(`${url}/api/agents/nope-123`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ name: 'Nope' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(404);
  });

  it('creates and tests an external agent', async () => {
    const command = `node -e "console.log('external-ok ' + process.argv.slice(1).join(' '))" {task}`;
    const create = await fetch(`${url}/api/agents`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        name: 'CLI Agent',
        category: 'analysis',
        runtime: 'external',
        externalCommand: command,
        skillTags: ['analysis', 'cli'],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const created = await create.json();
    expect(create.status).toBe(200);
    expect(created.runtime).toBe('external');
    expect(created.skillTags).toEqual(['analysis', 'cli']);
    expect(created.healthStatus).toBe('untested');

    const test = await fetch(`${url}/api/agents/${created.id}/test`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ task: 'ping' }),
      signal: AbortSignal.timeout(10000),
    });
    const tested = await test.json();
    expect(test.status).toBe(200);
    expect(tested.ok).toBe(true);
    expect(tested.agent.healthStatus).toBe('online');
    expect(tested.agent.lastRunOutput).toContain('external-ok');

    const updatedCommand = `node -e "console.log('external-v2 ' + process.argv.slice(1).join(' '))" {task}`;
    const update = await fetch(`${url}/api/agents/${created.id}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ externalCommand: updatedCommand }),
      signal: AbortSignal.timeout(5000),
    });
    const updated = await update.json();
    expect(update.status).toBe(200);
    expect(updated.healthStatus).toBe('untested');
    expect(updated.lastRunOutput).toBeUndefined();

    await fetch(`${url}/api/agents/${created.id}`, { method: 'DELETE', headers: adminHeaders(), signal: AbortSignal.timeout(5000) });
  });

  it('rejects unsafe external agent commands', async () => {
    const res = await fetch(`${url}/api/agents`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        name: 'Unsafe CLI Agent',
        runtime: 'external',
        externalCommand: 'shutdown /s /t 0 {task}',
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain('blocked pattern');

    const chained = await fetch(`${url}/api/agents`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        name: 'Chained CLI Agent',
        runtime: 'external',
        externalCommand: 'echo ok && echo bad {task}',
      }),
      signal: AbortSignal.timeout(5000),
    });
    const chainedBody = await chained.json();
    expect(chained.status).toBe(400);
    expect(chainedBody.error).toContain('shell control token');
  });

  it('deletes the agent', async () => {
    const res = await fetch(`${url}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);

    const list = await fetch(`${url}/api/agents`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const listBody = await list.json();
    expect(listBody.find((a: any) => a.id === agentId)).toBeUndefined();
  });

  it('rejects unauthenticated access', async () => {
    const res = await fetch(`${url}/api/agents`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(401);
  });
});
