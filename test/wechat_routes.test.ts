import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import { mountAuthRoutes } from '../server/routes/auth';

let url = '';
let cleanup = () => {};
let token = '';
let createWeChatRoutes: typeof import('../server/messaging/wechat-routes').createWeChatRoutes;
let bindings: typeof import('../server/messaging/bindings');

function headers() {
  return {
    'Content-Type': 'application/json',
    'Cookie': `token=${token}`,
  };
}

describe('personal WeChat routes', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    ({ createWeChatRoutes } = await import('../server/messaging/wechat-routes'));
    bindings = await import('../server/messaging/bindings');
    app.apiRouter.use('/', createWeChatRoutes({
      botToken: '',
      botId: '',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      enabled: false,
    }));

    const username = `wechat_route_${Date.now()}`;
    await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pass123', phone: '13800004444' }),
    });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pass123' }),
    });
    token = (await login.json()).token;
  });

  beforeEach(() => bindings.resetMessagingBindingsForTest());

  afterAll(() => {
    bindings.resetMessagingBindingsForTest();
    cleanup();
  });

  it('creates, reports, and removes a personal binding without an organization', async () => {
    const codeResponse = await fetch(`${url}/api/wechat/bindings/code`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ scope: 'personal' }),
    });
    const codeBody = await codeResponse.json();
    expect(codeResponse.status).toBe(200);
    expect(codeBody).toMatchObject({ scope: 'personal' });
    expect(codeBody.code).toMatch(/^[A-F0-9]{12}$/);

    const pendingStatus = await fetch(`${url}/api/wechat/status`, { headers: headers() }).then(res => res.json());
    expect(pendingStatus).toMatchObject({
      personalBound: false,
      pendingPersonalBinding: { code: codeBody.code, expiresAt: codeBody.expiresAt },
    });

    const binding = bindings.consumeBindingCode(
      'wechat',
      codeBody.code,
      'wx-route-user',
      'wx-route-user',
      'private',
    );
    expect(binding?.domain).toBe('personal');

    const statusResponse = await fetch(`${url}/api/wechat/status`, { headers: headers() });
    const status = await statusResponse.json();
    expect(status).toMatchObject({
      configured: false,
      listening: false,
      personalBound: true,
    });
    expect(status.personalBinding.platformUserId).toBe('wx-route-user');

    const removeResponse = await fetch(
      `${url}/api/wechat/bindings/${encodeURIComponent(binding!.id)}?scope=personal`,
      { method: 'DELETE', headers: headers() },
    );
    expect(await removeResponse.json()).toEqual({ success: true });

    const finalStatus = await fetch(`${url}/api/wechat/status`, { headers: headers() }).then(res => res.json());
    expect(finalStatus.personalBound).toBe(false);
  });

  it('requires authentication for binding and status endpoints', async () => {
    const status = await fetch(`${url}/api/wechat/status`);
    const code = await fetch(`${url}/api/wechat/bindings/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'personal' }),
    });
    expect(status.status).toBe(401);
    expect(code.status).toBe(401);
  });
});
