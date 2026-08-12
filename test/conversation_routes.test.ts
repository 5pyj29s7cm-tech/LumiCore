import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';

let url = '';
let cleanup = () => {};
let token = '';

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

describe('conversation session routes', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    const [{ mountAuthRoutes }, { mountConversationRoutes }] = await Promise.all([
      import('../server/routes/auth'),
      import('../server/routes/conversations'),
    ]);
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    mountConversationRoutes(app.apiRouter, JWT_SECRET);

    const username = `conversation_route_${Date.now()}`;
    await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pass123', phone: '13800005555' }),
    });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pass123' }),
    });
    token = String((await login.json()).token || '');
  });

  afterAll(() => cleanup());

  it('creates a new conversation and restores a previous one through the HTTP API', async () => {
    const firstResponse = await fetch(`${url}/api/conversations/new?domain=personal&agentId=lumi`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ agentId: 'lumi', domain: 'personal' }),
    });
    const first = await firstResponse.json();
    expect(firstResponse.status).toBe(201);
    expect(first.conversation).toMatchObject({ agentId: 'lumi', status: 'active', domain: 'personal' });

    const secondResponse = await fetch(`${url}/api/conversations/new?domain=personal&agentId=lumi`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ agentId: 'lumi', domain: 'personal' }),
    });
    const second = await secondResponse.json();
    expect(secondResponse.status).toBe(201);
    expect(second.conversation.id).not.toBe(first.conversation.id);

    const activateResponse = await fetch(
      `${url}/api/conversations/${encodeURIComponent(first.conversation.id)}/activate?domain=personal&agentId=lumi`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ agentId: 'lumi', domain: 'personal' }),
      },
    );
    const activated = await activateResponse.json();
    expect(activateResponse.status).toBe(200);
    expect(activated.conversation).toMatchObject({ id: first.conversation.id, status: 'active' });

    const historyResponse = await fetch(`${url}/api/conversations?domain=personal&agentId=lumi`, {
      headers: headers(),
    });
    const history = await historyResponse.json();
    expect(historyResponse.status).toBe(200);
    expect(history.conversations.map((item: any) => item.id)).toEqual(expect.arrayContaining([
      first.conversation.id,
      second.conversation.id,
    ]));
    expect(history.conversations.find((item: any) => item.id === first.conversation.id)?.status).toBe('active');
    expect(history.conversations.find((item: any) => item.id === second.conversation.id)?.status).toBe('closed');
  });

  it('protects new and activate operations with authentication', async () => {
    const createResponse = await fetch(`${url}/api/conversations/new`, { method: 'POST' });
    const activateResponse = await fetch(`${url}/api/conversations/not-found/activate`, { method: 'POST' });
    expect(createResponse.status).toBe(401);
    expect(activateResponse.status).toBe(401);
  });
});
