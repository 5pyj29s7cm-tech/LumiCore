import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let temporaryRoot: string | undefined;
afterEach(() => {
  vi.doUnmock('os');
  vi.doUnmock('dotenv/config');
  vi.doUnmock('../server/runtime/data_root_preflight');
  vi.doUnmock('../server');
  vi.resetModules();
  vi.unstubAllEnvs();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('privacy startup respects the dotenv data root', () => {
  it.each([
    { defaultMode: 'standard', configuredMode: 'strict' },
    { defaultMode: 'strict', configuredMode: 'standard' },
  ])('loads $configuredMode from the configured root before freezing, ignoring $defaultMode in the default root', async ({ defaultMode, configuredMode }) => {
    temporaryRoot = fs.mkdtempSync(path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), 'privacy-startup-'));
    const syntheticHome = path.join(temporaryRoot, 'home');
    const defaultRoot = path.join(syntheticHome, 'LumiCore');
    const configuredRoot = path.join(temporaryRoot, 'configured-root');
    for (const [directory, mode] of [[defaultRoot, defaultMode], [configuredRoot, configuredMode]]) {
      fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'data', 'privacy.json'), JSON.stringify({ version: 1, mode }));
    }
    const dotenvPath = path.join(temporaryRoot, 'synthetic.env');
    fs.writeFileSync(dotenvPath, `LUMI_DATA_DIR="${configuredRoot.replace(/\\/g, '/')}"\n`);
    vi.stubEnv('LUMI_DATA_DIR', undefined);
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    vi.stubEnv('DOTENV_CONFIG_PATH', dotenvPath);
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();

    const actualOs = await vi.importActual<typeof import('os')>('os');
    vi.doMock('os', () => ({ ...actualOs, default: { ...actualOs, homedir: () => syntheticHome }, homedir: () => syntheticHome }));
    const events: string[] = [];
    let preflightRoot: string | undefined;
    let activeMode: string | undefined;
    let configuredAtServer: string | undefined;
    vi.doMock('dotenv/config', async () => {
      const dotenv = await import('dotenv');
      dotenv.config({ path: dotenvPath, quiet: true });
      events.push('dotenv');
      return {};
    });
    vi.doMock('../server/runtime/data_root_preflight', () => ({
      prepareRuntimeDataRoot: () => { preflightRoot = process.env.LUMI_DATA_DIR; events.push('preflight'); },
    }));
    // Replace the complete server graph; retain its dotenv import ordering so
    // the old late load would freeze the wrong root before this callback runs.
    vi.doMock('../server', async () => {
      await import('dotenv/config');
      const privacy = await import('../server/config/privacy');
      activeMode = privacy.getPrivacyMode();
      configuredAtServer = privacy.getConfiguredPrivacyMode();
      events.push('server');
      return {};
    });
    await import('../server/runtime/server_entry');
    expect(events).toEqual(['dotenv', 'preflight', 'server']);
    expect(path.resolve(preflightRoot || '')).toBe(configuredRoot);
    expect(activeMode).toBe(configuredMode);
    expect(configuredAtServer).toBe(configuredMode);
  });
});
