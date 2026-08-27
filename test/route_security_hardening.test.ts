import { promises as dns } from 'node:dns';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_SESSION_HEADER,
  issueDesktopSessionProof,
} from '../server/config/desktop_bootstrap';
import { deviceRegistry } from '../server/devices';
import { getMCPConfig, mcpManager } from '../server/mcp';
import { connectToOrg, isPublicCompanyAddress, validateCompanyEndpoint } from '../server/org/branch';
import { mountBranchConnectionRoutes } from '../server/routes/branch_routes';
import { mountDeviceRoutes } from '../server/routes/device_routes';
import { mountMiscRoutes } from '../server/routes/misc_routes';
import { mountSkillRoutes } from '../server/routes/skill_routes';
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';

const userId = `route-security-user-${Date.now()}`;
const otherUserId = `route-security-other-${Date.now()}`;
const userToken = jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
const otherUserToken = jwt.sign({ uid: otherUserId, username: otherUserId, role: 'user' }, JWT_SECRET);
const adminToken = jwt.sign({ uid: 'route-security-admin', username: 'admin', role: 'admin' }, JWT_SECRET);

function nativeIdentity(pid: number) {
  const startedAtUnixMs = Math.floor((Date.now() - 30_000) / 1_000) * 1_000;
  return {
    schemaVersion: 1 as const,
    clientKind: 'tauri' as const,
    pid,
    startedAtUnixMs,
    startedAt: new Date(startedAtUnixMs).toISOString(),
    executablePath: process.platform === 'win32' ? 'C:\\LumiCore\\lumi-core.exe' : '/opt/LumiCore/lumi-core',
    executableSha256: 'd'.repeat(64),
    binaryHashUnavailable: false,
    buildId: 'b'.repeat(40),
    buildIdSemantics: 'baseline_commit' as const,
    sourceFingerprint: 'e'.repeat(64),
    sourceDirty: false,
    appVersion: '3.1.0',
    trustLevel: 'proof_bound_local_claim' as const,
    osAttested: false as const,
    webviewProfileTrustLevel: 'unbound' as const,
  };
}

function auth(token: string, json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
  };
}

describe('route security hardening', () => {
  let baseUrl = '';
  let cleanup = () => {};
  let originalMcpConfig: ReturnType<typeof getMCPConfig> = {};
  let ownDeviceId = '';
  let otherDeviceId = '';
  let adminDesktopSessionProof = '';

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    mountBranchConnectionRoutes(app.apiRouter, JWT_SECRET);
    mountDeviceRoutes(app.apiRouter, JWT_SECRET);
    mountSkillRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS, { emit: () => {} } as any);
    mountMiscRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);

    ownDeviceId = deviceRegistry.register(userId, 'route-security-user-socket', {
      name: 'User desktop',
      deviceFingerprint: 'route-security-user-device',
      domain: 'personal',
      orgId: '',
      nativeClientIdentity: nativeIdentity(51_001),
    }).id;
    otherDeviceId = deviceRegistry.register(otherUserId, 'route-security-other-socket', {
      name: 'Other desktop',
      deviceFingerprint: 'route-security-other-device',
      domain: 'personal',
      orgId: '',
    }).id;
    deviceRegistry.registerMcpDevice('unscoped-remote', 'mcp_remote', { audio: true });
    const adminIdentity = nativeIdentity(51_101);
    deviceRegistry.register('route-security-admin', 'route-security-admin-socket', {
      name: 'Admin desktop',
      deviceFingerprint: 'route-security-admin-device',
      domain: 'personal',
      orgId: '',
      nativeClientIdentity: adminIdentity,
    });
    const {
      startedAt: _startedAt,
      trustLevel: _trustLevel,
      osAttested: _osAttested,
      webviewProfileTrustLevel: _webviewProfileTrustLevel,
      ...adminIdentityClaim
    } = adminIdentity;
    adminDesktopSessionProof = issueDesktopSessionProof(
      'route-security-admin',
      adminIdentityClaim,
    ).proof;

    originalMcpConfig = getMCPConfig();
    mcpManager.saveConfig({
      ...originalMcpConfig,
      security_fixture: {
        enabled: false,
        source: 'external',
        description: 'Fixture skill (disabled after startup failure: bearer secret detail)',
        toolCount: 3,
        generatedFrom: 'private-conversation-id',
        requiresApiKey: true,
        apiKeyEnv: 'PRIVATE_FIXTURE_API_KEY',
        apiKeyUrl: 'https://console.example.test/private',
      },
    });
  });

  afterAll(() => {
    mcpManager.saveConfig(originalMcpConfig);
    cleanup();
  });

  it('gates device-level branch state and mutation to a local administrator', async () => {
    const anonymous = await fetch(`${baseUrl}/api/branch/state`);
    expect(anonymous.status).toBe(401);

    const ordinary = await fetch(`${baseUrl}/api/branch/state`, { headers: auth(userToken) });
    expect(ordinary.status).toBe(403);

    const administrator = await fetch(`${baseUrl}/api/branch/state`, { headers: auth(adminToken) });
    expect(administrator.status).toBe(200);

    const unsafeConnect = await fetch(`${baseUrl}/api/branch/connect`, {
      method: 'POST',
      headers: auth(adminToken, true),
      body: JSON.stringify({ orgId: 'org-unsafe', companyUrl: 'http://127.0.0.1:3000', token: 'secret' }),
    });
    expect(unsafeConnect.status).toBe(400);
    expect((await unsafeConnect.json()).error).toMatch(/https|public network/i);
  });

  it('rejects loopback, private, link-local, metadata, reserved DNS answers, and redirects by policy', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.4.5', '192.168.1.5', '169.254.169.254', '::1', '::ffff:7f00:1', 'fe80::1', 'fd00::1']) {
      expect(isPublicCompanyAddress(address), address).toBe(false);
    }
    expect(isPublicCompanyAddress('8.8.8.8')).toBe(true);
    await expect(validateCompanyEndpoint('http://example.com')).rejects.toThrow(/https/i);
    await expect(validateCompanyEndpoint('https://127.0.0.1')).rejects.toThrow(/blocked|public/i);

    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ] as any);
    await expect(validateCompanyEndpoint('https://branch.example')).rejects.toThrow(/blocked/i);
    lookup.mockRestore();

    const publicLookup = vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as any);
    const fetchRedirect = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://redirected.example/api/branch/register' },
    }));
    const redirected = await connectToOrg('redirect-test-org', 'https://branch.example', 'must-not-forward');
    expect(redirected.success).toBe(false);
    expect(redirected.error).toMatch(/redirect/i);
    expect(fetchRedirect).toHaveBeenCalledWith(
      'https://branch.example/api/branch/register',
      expect.objectContaining({ redirect: 'manual' }),
    );
    fetchRedirect.mockRestore();
    publicLookup.mockRestore();
  });

  it('requires login for devices and isolates listing and pairing by owner and domain', async () => {
    expect((await fetch(`${baseUrl}/api/devices`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: ownDeviceId }),
    })).status).toBe(401);

    const list = await fetch(`${baseUrl}/api/devices`, { headers: auth(userToken) });
    expect(list.status).toBe(200);
    const listBody: any = await list.json();
    expect(listBody.devices.map((device: any) => device.id)).toEqual([ownDeviceId]);
    expect(listBody.devices[0]).not.toHaveProperty('nativeClientIdentity');
    expect(JSON.stringify(listBody.devices[0])).not.toContain('executablePath');
    expect(listBody.devices.some((device: any) => device.id === otherDeviceId || device.id.startsWith('mcp_'))).toBe(false);

    const crossUserPair = await fetch(`${baseUrl}/api/devices/pair`, {
      method: 'POST',
      headers: auth(userToken, true),
      body: JSON.stringify({ deviceId: otherDeviceId }),
    });
    expect(crossUserPair.status).toBe(404);

    const paired = await fetch(`${baseUrl}/api/devices/pair`, {
      method: 'POST',
      headers: auth(userToken, true),
      body: JSON.stringify({ deviceId: ownDeviceId }),
    });
    expect(paired.status).toBe(200);
    expect((await paired.json()).pairedDeviceIds).toEqual([ownDeviceId]);

    const otherList = await fetch(`${baseUrl}/api/devices`, { headers: auth(otherUserToken) });
    expect((await otherList.json()).pairedDeviceIds).toEqual([]);

    const unpaired = await fetch(`${baseUrl}/api/devices/pair/${encodeURIComponent(ownDeviceId)}`, {
      method: 'DELETE',
      headers: auth(userToken),
    });
    expect(unpaired.status).toBe(200);
  });

  it('keeps native process evidence behind local admin and desktop-session proof', async () => {
    const ordinary = await fetch(`${baseUrl}/api/devices/native-client-evidence`, {
      headers: auth(userToken),
    });
    expect(ordinary.status).toBe(403);

    const adminWithoutProof = await fetch(`${baseUrl}/api/devices/native-client-evidence`, {
      headers: auth(adminToken),
    });
    expect(adminWithoutProof.status).toBe(403);

    const adminWithInvalidProof = await fetch(`${baseUrl}/api/devices/native-client-evidence`, {
      headers: {
        ...auth(adminToken),
        [DESKTOP_SESSION_HEADER]: 'invalid-desktop-proof',
      },
    });
    expect(adminWithInvalidProof.status).toBe(403);

    const accepted = await fetch(`${baseUrl}/api/devices/native-client-evidence`, {
      headers: {
        ...auth(adminToken),
        [DESKTOP_SESSION_HEADER]: adminDesktopSessionProof,
      },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    const body: any = await accepted.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({
      type: 'desktop',
      status: 'online',
      nativeClientIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      nativeClientIdentity: {
        clientKind: 'tauri',
        pid: 51_101,
        buildId: 'b'.repeat(40),
      },
    });
    expect(body.devices[0]).not.toHaveProperty('userId');
    expect(body.devices[0]).not.toHaveProperty('ipAddress');
  });

  it('protects founder/admin configuration and authenticates bounded feedback', async () => {
    expect((await fetch(`${baseUrl}/api/founder/vision`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/founder/vision`, { headers: auth(userToken) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/founder/vision`, { headers: auth(adminToken) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/config`, { headers: auth(userToken) })).status).toBe(403);

    const anonymousFeedback = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'anonymous' }),
    });
    expect(anonymousFeedback.status).toBe(401);

    const oversized = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: auth(userToken, true),
      body: JSON.stringify({ message: 'x'.repeat(4_001) }),
    });
    expect(oversized.status).toBe(400);

    const accepted = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: auth(userToken, true),
      body: JSON.stringify({ message: 'A bounded authenticated report' }),
    });
    expect(accepted.status).toBe(200);

    // The canonical /chat route is mounted by chat_routes; misc_routes must not
    // install a second, weaker organization-scope implementation.
    const duplicateChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: auth(userToken, true),
      body: JSON.stringify({ messages: [] }),
    });
    expect(duplicateChat.status).toBe(404);
  });

  it('returns only redacted skill status to normal users and reserves diagnostics for local admins', async () => {
    const ordinary = await fetch(`${baseUrl}/api/skills`, { headers: auth(userToken) });
    expect(ordinary.status).toBe(200);
    const ordinarySkill = (await ordinary.json()).skills.find((skill: any) => skill.name === 'security_fixture');
    expect(ordinarySkill).toMatchObject({ name: 'security_fixture', requiresApiKey: true });
    expect(ordinarySkill.description).not.toContain('bearer secret detail');
    expect(ordinarySkill).not.toHaveProperty('startupError');
    expect(ordinarySkill).not.toHaveProperty('generatedFrom');
    expect(ordinarySkill).not.toHaveProperty('apiKeyEnv');
    expect(ordinarySkill).not.toHaveProperty('apiKeyUrl');

    const administrator = await fetch(`${baseUrl}/api/skills`, { headers: auth(adminToken) });
    expect(administrator.status).toBe(200);
    const adminSkill = (await administrator.json()).skills.find((skill: any) => skill.name === 'security_fixture');
    expect(adminSkill).toMatchObject({
      startupError: 'bearer secret detail',
      generatedFrom: 'private-conversation-id',
      apiKeyEnv: 'PRIVATE_FIXTURE_API_KEY',
    });
  });
});
