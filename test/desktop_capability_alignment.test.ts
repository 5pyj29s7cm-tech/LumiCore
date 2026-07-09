import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';

describe('desktop capability alignment', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('registers the desktop relay capabilities that Lumi advertises as direct tools', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerAllTools } = await import('../server/tools/definitions');

    const registry = new ToolRegistry();
    registerAllTools(registry);
    const toolNames = registry.getToolDeclarations().map(declaration => declaration.function.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'desktop_show_lumi_window',
      'desktop_idle_time',
      'desktop_poll_activity',
      'desktop_active_window',
      'desktop_running_processes',
      'desktop_capture_screen',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_click',
      'desktop_ui_invoke',
      'desktop_ui_type',
      'read_clipboard',
      'write_clipboard',
      'mouse_move',
      'mouse_click',
      'mouse_drag',
      'keyboard_type',
      'keyboard_press',
      'computer_use',
    ]));
  });

  it('lets vision computer use follow the active desktop/autonomy tool policy', async () => {
    const { resolveComputerUseSteps } = await import('../server/tools/definitions/computer_use_tool');

    expect(resolveComputerUseSteps({}, { toolPolicy: { maxIterations: 25 } })).toBe(25);
    expect(resolveComputerUseSteps({ max_steps: 40 }, { toolPolicy: { maxIterations: 50 } })).toBe(40);
    expect(resolveComputerUseSteps({ max_steps: 80 }, { toolPolicy: { maxIterations: 50 } })).toBe(50);
    expect(resolveComputerUseSteps({ max_steps: 40 }, { toolPolicy: { maxIterations: 25 } })).toBe(25);
  });

  it('keeps desktop/account automation available after removing the autonomous external-app gate', async () => {
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { getAdapterRegistry } = await import('../server/adapters/registry');

    saveGateConfig({ autonomyLevel: 'full', externalAppAutomationEnabled: false });
    const report = getAdapterRegistry({ includePlanned: false });
    const computerUse = report.adapters.find(adapter => adapter.id === 'automation.computer_use');
    const accountReuse = report.adapters.find(adapter => adapter.id === 'automation.account_session_reuse');

    expect(computerUse?.status).toBe('available');
    expect(computerUse?.requiresConfirmation).toBe(false);
    expect(computerUse?.diagnostics).toContain('externalAutomationGate=removed');
    expect(computerUse?.setup || []).toEqual([]);
    expect(accountReuse?.status).toBe('available');
    expect(accountReuse?.diagnostics).toContain('externalAutomationGate=removed');
    expect(accountReuse?.setup || []).toEqual([]);
  });
});
