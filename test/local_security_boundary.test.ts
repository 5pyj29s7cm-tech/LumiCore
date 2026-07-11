import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.sequential('Local security boundary', () => {
  const originalHost = process.env.HOST;
  const originalOrigins = process.env.CORS_ORIGINS;
  let originalJwt: string | undefined;
  let originalPassword: string | undefined;

  beforeAll(async () => {
    await import('./helpers');
    originalJwt = process.env.JWT_SECRET;
    originalPassword = process.env.AUTO_LOGIN_PASSWORD;
  });

  afterAll(() => {
    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;
    if (originalOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = originalOrigins;
    if (originalJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwt;
    if (originalPassword === undefined) delete process.env.AUTO_LOGIN_PASSWORD;
    else process.env.AUTO_LOGIN_PASSWORD = originalPassword;
  });

  it('binds local installs to loopback unless HOST is explicitly configured', async () => {
    const { resolveBindHost } = await import('../server/runtime/core');
    delete process.env.HOST;
    expect(resolveBindHost()).toBe('127.0.0.1');
    process.env.HOST = '0.0.0.0';
    expect(resolveBindHost()).toBe('0.0.0.0');
  });

  it('allows desktop/local origins and rejects arbitrary web origins by default', async () => {
    const { isAllowedClientOrigin } = await import('../server/runtime/core');
    delete process.env.CORS_ORIGINS;
    expect(isAllowedClientOrigin(undefined)).toBe(true);
    expect(isAllowedClientOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedClientOrigin('http://localhost:1420')).toBe(true);
    expect(isAllowedClientOrigin('tauri://localhost')).toBe(true);
    expect(isAllowedClientOrigin('http://tauri.localhost')).toBe(true);
    expect(isAllowedClientOrigin('https://attacker.example')).toBe(false);
  });

  it('generates a persistent unpredictable identity when env overrides are absent', async () => {
    const identity = await import('../server/config/local_identity');
    delete process.env.JWT_SECRET;
    delete process.env.AUTO_LOGIN_PASSWORD;
    identity.resetLocalIdentityCacheForTests();

    const firstSecret = identity.getJwtSecret();
    const firstPassword = identity.getLocalAdminPassword();
    expect(firstSecret.length).toBeGreaterThanOrEqual(32);
    expect(firstPassword.length).toBeGreaterThanOrEqual(24);
    expect(firstSecret).not.toContain('lumiOS_default');
    expect(firstPassword).not.toContain('lumi_admin');

    identity.resetLocalIdentityCacheForTests();
    expect(identity.getJwtSecret()).toBe(firstSecret);
    expect(identity.getLocalAdminPassword()).toBe(firstPassword);
  });

  it('limits silent identity bootstrap to loopback clients', async () => {
    const { isLoopbackAddress } = await import('../server/config/local_identity');
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.15.20.25')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('10.0.0.8')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
