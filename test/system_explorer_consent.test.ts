import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { value: { systemFlags: {} } as any },
  readDB: vi.fn(),
  writeDB: vi.fn(),
}));

vi.mock('../db_layer', () => ({
  readDB: mocks.readDB,
  writeDB: mocks.writeDB,
}));

import {
  getSystemExplorationConsent,
  isSystemExplorationAllowed,
  persistFirstBootExploration,
  setSystemExplorationConsent,
} from '../server/autonomy/system_explorer';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.value = { systemFlags: {} };
  mocks.readDB.mockImplementation(() => mocks.state.value);
  mocks.writeDB.mockImplementation(value => { mocks.state.value = value; });
});

describe('system exploration consent', () => {
  it('does not authorize a new installation before a local-admin decision', () => {
    expect(getSystemExplorationConsent()).toEqual({ version: 1, status: 'not_decided' });
    expect(isSystemExplorationAllowed()).toBe(false);
    expect(mocks.writeDB).not.toHaveBeenCalled();
  });

  it('persists an explicit grant without broadening what the scanner may collect', () => {
    const consent = setSystemExplorationConsent(true, 'local-admin');
    expect(consent).toMatchObject({
      version: 1,
      status: 'granted',
      grantedByUserId: 'local-admin',
      updatedAt: expect.any(String),
    });
    expect(isSystemExplorationAllowed()).toBe(true);
    expect(mocks.state.value.systemFlags.systemExplorationConsent).toEqual(consent);
  });

  it('lets an explicit decline override a legacy local scan', () => {
    mocks.state.value.systemFlags.firstBootExplored = true;
    expect(getSystemExplorationConsent().status).toBe('legacy_local_scan');
    expect(isSystemExplorationAllowed()).toBe(true);

    setSystemExplorationConsent(false, 'local-admin');
    expect(getSystemExplorationConsent().status).toBe('declined');
    expect(isSystemExplorationAllowed()).toBe(false);
  });

  it('persists machine evidence without inferring or writing a profession profile', () => {
    setSystemExplorationConsent(true, 'local-admin');
    const snapshot = {
      id: 'explore_test',
      timestamp: '2026-08-26T00:00:00.000Z',
      type: 'first_boot' as const,
      computerScope: 'lumi_server_host' as const,
      hardware: {
        platform: 'win32',
        arch: 'x64',
        hostname: 'test-host',
        cpus: { model: 'Test CPU', cores: 8, threads: 16 },
        totalMemoryGB: 32,
        gpus: [],
        disks: [],
      },
      software: {
        osVersion: 'Windows Test',
        installedApps: ['Adobe Photoshop', 'Microsoft Excel'],
        startupPrograms: [],
        runningServices: [],
      },
      filesystem: {
        homeDir: 'test',
        desktopFiles: 0,
        documentsFiles: 0,
        downloadsFiles: 0,
        totalUserFiles: 0,
        largeDirs: [],
        fileCountScope: 'desktop_documents_downloads' as const,
        fileCountMaxDepth: 2,
      },
      network: { hostname: 'test-host', interfaces: [], ipAddresses: [] },
    };

    persistFirstBootExploration(snapshot);

    expect(mocks.state.value.systemSnapshots).toEqual([snapshot]);
    expect(mocks.state.value).not.toHaveProperty('professionProfiles');
    expect(mocks.state.value.systemFlags).not.toHaveProperty('professionProfiles');
  });
});
