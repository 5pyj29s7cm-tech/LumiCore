import { describe, expect, it } from 'vitest';
import {
  finalizeNativeUiActionResult,
  getNativeUiAdapter,
  runNativeUiAction,
} from '../server/external_control/native_ui';
import { getProductivityAdapter } from '../server/adapters/productivity';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

describe('cross-platform capability contract', () => {
  it('keeps one desktop semantic capability definition with platform adapters', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);

    const nativeUiCapabilities = registry.getCapabilityManifest()
      .filter(entry => entry.capabilityId.startsWith('desktop.native_ui.'));

    expect(nativeUiCapabilities.map(entry => entry.toolName).sort()).toEqual([
      'desktop_ui_click',
      'desktop_ui_focus',
      'desktop_ui_invoke',
      'desktop_ui_snapshot',
      'desktop_ui_type',
    ]);
    for (const entry of nativeUiCapabilities) {
      expect(entry.lane).toBe('desktop');
      expect(entry.source).toBe('adapter');
      expect(entry.adapter?.id).toBe('desktop.native');
      expect(entry.adapter?.implementations).toEqual({
        windows: 'windows-uia',
        macos: 'macos-accessibility',
      });
    }
  });

  it('selects only the implementation at the operating-system boundary', () => {
    const windows = getNativeUiAdapter('win32');
    const macos = getNativeUiAdapter('darwin');

    expect(windows).toMatchObject({ id: 'windows-uia', platform: 'win32' });
    expect(macos).toMatchObject({ id: 'macos-accessibility', platform: 'darwin' });
    expect(Object.keys(windows || {}).sort()).toEqual(Object.keys(macos || {}).sort());
    expect(getNativeUiAdapter('linux')).toBeNull();
  });

  it('fails native UI actuation closed without a fresh process or window binding', async () => {
    await expect(runNativeUiAction({
      action: 'click',
      name: 'Save',
    })).resolves.toMatchObject({
      status: 'target_mismatch',
      targetMatched: false,
    });
  });

  it('turns a stale native UI selection into a target mismatch receipt', () => {
    expect(finalizeNativeUiActionResult(
      { action: 'click', name: 'Save', processId: 42 },
      { status: 'ok', selectedBefore: { processId: 99, name: 'Save' } },
    )).toMatchObject({
      status: 'target_mismatch',
      targetMatched: false,
      expectedTarget: { processId: 42 },
    });
  });

  it('keeps calendar and mail semantics identical across Windows and macOS adapters', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const tools = new Set([
      'calendar_today',
      'upcoming_events',
      'send_email',
      'recent_emails',
      'calendar_create',
      'calendar_modify',
      'calendar_delete',
    ]);
    const capabilities = registry.getCapabilityManifest().filter(entry => tools.has(entry.toolName));

    expect(capabilities).toHaveLength(tools.size);
    for (const entry of capabilities) {
      expect(entry.adapter?.id).toBe('productivity.calendar-mail');
      expect(entry.adapter?.implementations).toEqual({
        windows: 'windows.outlook_com',
        macos: 'macos.calendar_mail_jxa',
      });
    }

    const windows = getProductivityAdapter('win32');
    const macos = getProductivityAdapter('darwin');
    expect(windows).toMatchObject({ id: 'windows.outlook_com', platform: 'windows' });
    expect(macos).toMatchObject({ id: 'macos.calendar_mail_jxa', platform: 'macos' });
    expect(Object.keys(windows).sort()).toEqual(Object.keys(macos).sort());
    expect(() => getProductivityAdapter('linux')).toThrow(/not available/i);
  });

  it('uses one presentation capability and a platform-neutral file adapter', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const presentation = registry.getCapabilityManifestEntry('create_ppt');

    expect(presentation?.capabilityId).toBe('office.presentation.create');
    expect(presentation?.adapter).toEqual({
      id: 'office.presentation-file',
      operations: ['presentation.create'],
      implementations: {
        windows: 'node.pptxgenjs',
        macos: 'node.pptxgenjs',
      },
    });
  });
});
