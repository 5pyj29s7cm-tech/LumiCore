import { describe, expect, it, vi } from 'vitest';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerInputTools } from '../server/tools/definitions/input_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

function registry(): ToolRegistry {
  const value = new ToolRegistry();
  registerDesktopTools(value);
  return value;
}

describe('desktop exact-target execution', () => {
  it('verifies a launch only after the foreground process matches the requested application', async () => {
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'desktop_open') return 'launch accepted';
      if (name === 'desktop_active_window') {
        return JSON.stringify({ title: 'Lumi - Google Chrome', process_name: 'chrome.exe' });
      }
      throw new Error(`unexpected relay ${name}`);
    });
    const record = await executeToolCall({
      registry: registry(),
      name: 'desktop_open',
      arguments: { target: 'Google Chrome' },
      context: { desktopRelay },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.envelope?.status).toBe('verified_success');
    expect(JSON.parse(record.result)).toMatchObject({
      status: 'verified',
      target: 'Google Chrome',
      targetMatched: true,
      actualTarget: { processName: 'chrome.exe' },
    });
    expect(desktopRelay).toHaveBeenNthCalledWith(1, 'desktop_open', {
      target: 'Google Chrome',
      application: '',
    });
  });

  it('returns target_mismatch when the OS foregrounds an alternative application', async () => {
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'desktop_open') return 'launch accepted';
      return JSON.stringify({ title: 'Document.docx - Microsoft Word', process_name: 'WINWORD.EXE' });
    });
    const record = await executeToolCall({
      registry: registry(),
      name: 'desktop_open',
      arguments: { target: 'WPS' },
      context: { desktopRelay },
    });

    expect(record.terminalVerification?.status).toBe('failed');
    expect(record.envelope?.status).toBe('target_mismatch');
    expect(JSON.parse(record.result)).toMatchObject({
      status: 'target_mismatch',
      target: 'WPS',
      targetMatched: false,
      actualTarget: { processName: 'WINWORD.EXE' },
    });
  }, 10_000);

  it('verifies NetEase Cloud Music from its native cloudmusic process', async () => {
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'desktop_open') return 'launch accepted';
      if (name === 'desktop_active_window') {
        return JSON.stringify({ title: '月牙儿 - Ice Paper', process_name: 'cloudmusic.exe' });
      }
      throw new Error(`unexpected relay ${name}`);
    });
    const record = await executeToolCall({
      registry: registry(),
      name: 'desktop_open',
      arguments: { target: '网易云音乐' },
      context: { desktopRelay },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      status: 'verified',
      targetMatched: true,
      actualTarget: { processName: 'cloudmusic.exe' },
    });
  });

  it('does not treat a launch acknowledgement without post-state observation as success', async () => {
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'desktop_open') return JSON.stringify({ ok: true, target: 'AutoCAD' });
      throw new Error('active-window probe disconnected');
    });
    const record = await executeToolCall({
      registry: registry(),
      name: 'desktop_open',
      arguments: { target: 'AutoCAD' },
      context: { desktopRelay },
    });

    expect(record.terminalVerification?.status).toBe('failed');
    expect(record.envelope?.status).toBe('failed');
    expect(JSON.parse(record.result)).toMatchObject({
      status: 'unverified',
      target: 'AutoCAD',
    });
  }, 10_000);

  it('blocks raw keyboard input unless the fresh foreground PID still matches', async () => {
    const value = registry();
    registerInputTools(value);
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'desktop_active_window') {
        return JSON.stringify({ title: 'Document - WPS Writer', process_name: 'wps.exe', pid: 42 });
      }
      if (name === 'desktop_keyboard_press') return 'key dispatched';
      throw new Error(`unexpected relay ${name}`);
    });

    const missingBinding = await executeToolCall({
      registry: value,
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+s' },
      context: { desktopRelay },
    });
    expect(missingBinding.envelope?.status).toBe('target_mismatch');
    expect(desktopRelay).not.toHaveBeenCalled();

    const wrongBinding = await executeToolCall({
      registry: value,
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+s', expectedProcessId: 99 },
      context: { desktopRelay },
    });
    expect(wrongBinding.envelope?.status).toBe('target_mismatch');

    const matched = await executeToolCall({
      registry: value,
      name: 'desktop_keyboard_press',
      arguments: { key: 'ctrl+s', expectedProcessId: 42 },
      context: { desktopRelay },
    });
    expect(matched.envelope?.status).toBe('verified_success');
    expect(JSON.parse(matched.result)).toMatchObject({
      status: 'verified',
      targetMatched: true,
      expectedProcessId: 42,
    });
  });
});
