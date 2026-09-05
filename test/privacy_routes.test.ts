import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import jwt from 'jsonwebtoken';
import { mountPrivacyRoutes } from '../server/routes/privacy_routes';
import { getPrivacyMode, getConfiguredPrivacyMode } from '../server/config/privacy';

let url: string;
let cleanup: () => void;
const token = (claims: Record<string, unknown> = {}) => jwt.sign({ uid: 'privacy-admin', role: 'admin', ...claims }, JWT_SECRET);
const headers = (claims: Record<string, unknown> = {}) => ({ Authorization: `Bearer ${token(claims)}`, 'Content-Type': 'application/json' });
const update = (mode: unknown, customHeaders: Record<string, string> = headers()) => fetch(`${url}/api/privacy`, {
  method: 'PUT', headers: customHeaders, body: JSON.stringify({ mode }),
});

beforeAll(async () => {
  vi.stubEnv('LUMI_PRIVACY', 'standard');
  const app = await makeApp();
  url = app.url;
  cleanup = app.cleanup;
  mountPrivacyRoutes(app.apiRouter);
});
afterAll(() => { cleanup?.(); vi.unstubAllEnvs(); });
afterEach(() => vi.stubEnv('LUMI_PRIVACY', 'standard'));

describe('privacy settings authorization and state', () => {
  it('requires login and allows an ordinary user to view but not modify', async () => {
    expect((await fetch(`${url}/api/privacy`)).status).toBe(401);
    const read = await fetch(`${url}/api/privacy`, { headers: headers({ role: 'user' }) });
    expect(await read.json()).toMatchObject({ mode: 'standard', canManage: false, restartRequired: false });
    expect((await update('strict', headers({ role: 'user' }))).status).toBe(403);
  });

  it('rejects branch, organization and forwarded remote writes', async () => {
    expect((await update('strict', headers({ tokenType: 'organization_branch', orgId: 'test-org', branchId: 'test-branch' }))).status).toBe(403);
    expect((await update('strict', headers({ orgId: 'test-org' }))).status).toBe(403);
    expect((await update('strict', { ...headers(), 'X-Forwarded-For': '203.0.113.1' })).status).toBe(403);
    expect(getConfiguredPrivacyMode()).toBe('standard');
  });

  it('validates values and reports a pending restart after an authorized save', async () => {
    expect((await update('anything')) .status).toBe(400);
    const write = await update('strict');
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ mode: 'standard', configuredMode: 'strict', restartRequired: true, canManage: true });
    expect(getPrivacyMode()).toBe('standard');
    expect((await fetch(`${url}/api/privacy`, { headers: headers() })).headers.get('cache-control')).toBe('no-store');
    expect(await (await update('standard')).json()).toMatchObject({ restartRequired: false });
  });

  it('reports a locked setting and rejects overriding it', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const read = await fetch(`${url}/api/privacy`, { headers: headers() });
    expect(await read.json()).toMatchObject({ mode: 'strict', configuredMode: 'strict', locked: true });
    expect((await update('standard')).status).toBe(409);
  });
});
