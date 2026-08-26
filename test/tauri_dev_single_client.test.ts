import { describe, expect, it } from 'vitest';

import {
  collectProcessTreePids,
  collectStaleClientPids,
  isProjectDebugClient,
} from '../scripts/prepare-tauri-dev.mjs';

const debugExe = 'D:\\LumiCore\\src-tauri\\target\\debug\\lumi-core.exe';
const legacyDebugExe = 'D:\\LumiCore\\src-tauri\\target\\debug\\lumi-os.exe';

describe('tauri dev stale client cleanup', () => {
  it('matches only this project debug Lumi client', () => {
    expect(isProjectDebugClient({
      Name: 'lumi-core.exe',
      ExecutablePath: debugExe,
    }, debugExe)).toBe(true);

    expect(isProjectDebugClient({
      Name: 'lumi-core.exe',
      ExecutablePath: 'C:\\Program Files\\LumiCore\\lumi-core.exe',
    }, debugExe)).toBe(false);

    expect(isProjectDebugClient({
      Name: 'msedgewebview2.exe',
      ExecutablePath: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe',
    }, debugExe)).toBe(false);
  });

  it('recognizes the legacy debug binary only at the same project path', () => {
    expect(isProjectDebugClient({
      Name: 'lumi-os.exe',
      ExecutablePath: legacyDebugExe,
    }, legacyDebugExe)).toBe(true);

    expect(isProjectDebugClient({
      Name: 'lumi-os.exe',
      ExecutablePath: 'C:\\Program Files\\LumiOS\\lumi-os.exe',
    }, legacyDebugExe)).toBe(false);
  });

  it('collects stale debug client process trees without unrelated processes', () => {
    const processes = [
      { ProcessId: 10, ParentProcessId: 1, Name: 'lumi-core.exe', ExecutablePath: debugExe },
      { ProcessId: 11, ParentProcessId: 10, Name: 'msedgewebview2.exe', ExecutablePath: 'C:\\WebView\\msedgewebview2.exe' },
      { ProcessId: 12, ParentProcessId: 11, Name: 'msedgewebview2.exe', ExecutablePath: 'C:\\WebView\\msedgewebview2.exe' },
      { ProcessId: 20, ParentProcessId: 1, Name: 'lumi-core.exe', ExecutablePath: 'C:\\Program Files\\LumiCore\\lumi-core.exe' },
      { ProcessId: 21, ParentProcessId: 20, Name: 'msedgewebview2.exe', ExecutablePath: 'C:\\WebView\\msedgewebview2.exe' },
      { ProcessId: 30, ParentProcessId: 1, Name: 'node.exe', ExecutablePath: 'D:\\node.exe' },
    ];

    expect(collectStaleClientPids(processes, debugExe)).toEqual([12, 11, 10]);
  });

  it('returns process trees in child-first order', () => {
    const processes = [
      { ProcessId: 1, ParentProcessId: 0 },
      { ProcessId: 2, ParentProcessId: 1 },
      { ProcessId: 3, ParentProcessId: 2 },
      { ProcessId: 4, ParentProcessId: 1 },
    ];

    expect(collectProcessTreePids(processes, [1])).toEqual([3, 2, 4, 1]);
  });
});
