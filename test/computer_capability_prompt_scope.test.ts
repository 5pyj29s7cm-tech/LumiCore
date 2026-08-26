import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { value: { systemFlags: {}, systemSnapshots: [] } as any },
  readDB: vi.fn(),
  writeDB: vi.fn(),
}));

vi.mock('../db_layer', () => ({
  readDB: mocks.readDB,
  writeDB: mocks.writeDB,
}));

import {
  deriveComputerCapabilityProfile,
  setSystemExplorationConsent,
  type SystemSnapshot,
} from '../server/autonomy/system_explorer';
import { formatComputerCapabilityProfileForPrompt } from '../server/client/desktop_awareness';

function snapshot(): SystemSnapshot {
  const base: SystemSnapshot = {
    id: 'scoped-profile',
    timestamp: '2026-08-26T00:00:00.000Z',
    type: 'first_boot',
    computerScope: 'lumi_server_host',
    hardware: {
      platform: 'win32',
      arch: 'x64',
      hostname: 'private-hostname',
      cpus: { model: 'Verified CPU', cores: 8, threads: 16 },
      totalMemoryGB: 32,
      gpus: ['Verified GPU'],
      disks: [{ name: 'C', totalGB: 1000, freeGB: 500, fsType: 'NTFS' }],
    },
    software: {
      osVersion: 'Windows Verified',
      installedApps: ['Visual Studio Code', 'Ollama'],
      startupPrograms: [],
      runningServices: [],
    },
    filesystem: {
      homeDir: 'C:\\Users\\Private',
      desktopFiles: 1,
      documentsFiles: 2,
      downloadsFiles: 3,
      totalUserFiles: 6,
      largeDirs: [],
      fileCountScope: 'desktop_documents_downloads',
      fileCountMaxDepth: 2,
    },
    network: { hostname: 'private-hostname', interfaces: [], ipAddresses: [] },
    peripherals: {
      displays: [], audioDevices: [], cameras: [], printers: [], usbDevices: [],
    },
    runtimes: {
      git: 'git version 2.50.0',
      node: 'v24.0.0',
      python: 'Python 3.13.0',
      wslDistributions: [],
      localAiRuntimes: ['Ollama'],
    },
  };
  base.capabilityProfile = deriveComputerCapabilityProfile(base);
  return base;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.value = { systemFlags: {}, systemSnapshots: [snapshot()] };
  mocks.readDB.mockImplementation(() => mocks.state.value);
  mocks.writeDB.mockImplementation(value => { mocks.state.value = value; });
});

describe('computer capability prompt scope', () => {
  it('does not expose host facts before consent or to another signed-in user', () => {
    const beforeConsent = formatComputerCapabilityProfileForPrompt('owner');
    expect(beforeConsent).toContain('has not been authorized for this user');
    expect(beforeConsent).not.toContain('Verified CPU');

    setSystemExplorationConsent(true, 'owner');
    const owner = formatComputerCapabilityProfileForPrompt('owner');
    const otherUser = formatComputerCapabilityProfileForPrompt('other-user');

    expect(owner).toContain('Verified CPU');
    expect(owner).toContain('Software development and repository work [verified-ready');
    expect(owner).toContain('Separate ready, needs setup, and unavailable/unknown');
    expect(otherUser).toContain('has not been authorized for this user');
    expect(otherUser).not.toContain('Verified CPU');
  });

  it('keeps a legacy profile for UI/history without injecting it into an ordinary user prompt', () => {
    mocks.state.value.systemFlags.firstBootExplored = true;

    const legacyPrompt = formatComputerCapabilityProfileForPrompt('legacy-local-admin');
    expect(legacyPrompt).toContain('has not been authorized for this user');
    expect(legacyPrompt).not.toContain('Verified CPU');

    setSystemExplorationConsent(true, 'legacy-local-admin');
    expect(formatComputerCapabilityProfileForPrompt('legacy-local-admin')).toContain('Verified CPU');
  });
});
