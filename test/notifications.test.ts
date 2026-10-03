import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import { mountAuthRoutes } from '../server/routes/auth';
import { mountNotificationRoutes, pushNotification } from '../server/routes/notifications';
import jwt from 'jsonwebtoken';

let url: string;
let cleanup: () => void;
let token: string;
let uid: string;

describe('Notifications API', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    mountNotificationRoutes(app.apiRouter);

    await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'notif_tester', password: 'pass123', phone: '13800003333' }),
    });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'notif_tester', password: 'pass123' }),
    });
    token = (await login.json()).token;
    uid = (jwt.decode(token) as any).uid;
  });

  afterAll(() => cleanup?.());

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Cookie': `token=${token}`,
    };
  }

  it('pushNotification adds and API lists them', async () => {
    pushNotification(uid, { type: 'test', title: 'Test 1', message: 'Hello' });
    pushNotification(uid, { type: 'warning', title: 'Test 2', message: 'Warning!' });

    const res = await fetch(`${url}/api/notifications`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.notifications.length).toBeGreaterThanOrEqual(2);
    expect(body.unreadCount).toBeGreaterThanOrEqual(2);
  });

  it('sorted newest first', async () => {
    const res = await fetch(`${url}/api/notifications`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    const ts = body.notifications.map((n: any) => n.timestamp);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
    }
  });

  it('mark all read', async () => {
    const res = await fetch(`${url}/api/notifications/read-all`, {
      method: 'POST', headers: headers(), signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.marked).toBeGreaterThanOrEqual(2);
    expect(body.ids.length).toBeGreaterThanOrEqual(2);

    const list = await fetch(`${url}/api/notifications`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const listBody = await list.json();
    expect(listBody.unreadCount).toBe(0);
  });

  it('clear all', async () => {
    pushNotification('another-user', { type: 'info', title: 'Private other', message: 'other' });
    const before = await (await fetch(`${url}/api/notifications`, { headers: headers() })).json();
    const cleared = await (await fetch(`${url}/api/notifications`, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(5000) })).json();
    expect(cleared.ids.sort()).toEqual(before.notifications.map((item: any) => item.id).sort());
    const otherToken = jwt.sign({ uid: 'another-user', role: 'user' }, JWT_SECRET);
    const other = await (await fetch(`${url}/api/notifications`, { headers: { Authorization: `Bearer ${otherToken}` } })).json();
    expect(other.notifications.map((item: any) => item.title)).toEqual(['Private other']);
    const list = await fetch(`${url}/api/notifications`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const listBody = await list.json();
    expect(listBody.notifications.length).toBe(0);
  });

  it('requires auth', async () => {
    const res = await fetch(`${url}/api/notifications`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(401);
  });
});
