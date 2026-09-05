import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), 'privacy-config-'));
  vi.stubEnv('LUMI_DATA_DIR', root);
  vi.stubEnv('LUMI_PRIVACY', 'standard');
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('persisted privacy mode', () => {
  it('defaults off, saves durably, and changes only after a new runtime loads it', async () => {
    let privacy = await import('../server/config/privacy');
    expect(privacy.getPrivacyMode()).toBe('standard');
    privacy.savePrivacyMode('strict');
    expect(privacy.getConfiguredPrivacyMode()).toBe('strict');
    expect(privacy.getPrivacyMode()).toBe('standard');
    vi.resetModules();
    privacy = await import('../server/config/privacy');
    expect(privacy.getPrivacyMode()).toBe('strict');
    privacy.savePrivacyMode('standard');
    expect(privacy.getPrivacyMode()).toBe('strict');
    vi.resetModules();
    expect((await import('../server/config/privacy')).getPrivacyMode()).toBe('standard');
  });

  it('cannot turn off an environment-enforced mode', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const privacy = await import('../server/config/privacy');
    expect(privacy.getPrivacyMode()).toBe('strict');
    expect(() => privacy.savePrivacyMode('standard')).toThrow(/enforced/);
  });

  it('does not report a failed disk write as saved and keeps the old preference', async () => {
    const privacy = await import('../server/config/privacy');
    privacy.savePrivacyMode('strict');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure'); });
    expect(() => privacy.savePrivacyMode('standard')).toThrow('disk failure');
    expect(privacy.getConfiguredPrivacyMode()).toBe('strict');
    expect(fs.readdirSync(path.join(root, 'data')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails closed if the saved preference is damaged', async () => {
    const privacy = await import('../server/config/privacy');
    privacy.savePrivacyMode('strict');
    fs.writeFileSync(path.join(root, 'data', 'privacy.json'), '{broken');
    vi.resetModules();
    expect((await import('../server/config/privacy')).getPrivacyMode).toThrow(/Cannot read privacy/);
  });

  it('checks actual local endpoints and forbids redirects without fetching remote data', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const privacy = await import('../server/config/privacy');
    for (const url of ['http://127.0.0.1:1234/v1', 'http://localhost:11434', 'http://[::1]:1234', 'http://[::ffff:127.0.0.1]']) {
      expect(() => privacy.requireLocalEndpoint(url)).not.toThrow();
    }
    for (const url of ['https://example.test', 'http://localhost.example.test', 'http://192.168.1.2', 'file:///tmp/a', 'http://user@localhost', 'http://[::ffff:192.168.1.2]']) {
      expect(() => privacy.requireLocalEndpoint(url)).toThrow(/Privacy/);
    }
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    expect(() => privacy.localPrivacyFetch('https://example.test/private')).toThrow(/Privacy/);
    expect(transport).not.toHaveBeenCalled();
    await privacy.localPrivacyFetch('http://127.0.0.1:1234/v1', { method: 'POST', redirect: 'follow', body: 'private prompt' });
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
});
