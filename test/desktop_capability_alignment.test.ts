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
      'desktop_ai_list_targets',
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
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

  it('keeps desktop awareness split across local machine, visible desktop, and background runtime', async () => {
    const { formatDesktopAwarenessForPrompt } = await import('../server/client/desktop_awareness');

    const prompt = formatDesktopAwarenessForPrompt();

    expect(prompt).toContain('Local Machine, Desktop, And Background Runtime Awareness');
    expect(prompt).toContain('local machine identity');
    expect(prompt).toContain('Visible desktop awareness');
    expect(prompt).toContain('Background runtime awareness');
    expect(prompt).toContain('client_get_state');
    expect(prompt).toContain('client_health_check');
    expect(prompt).toContain('A hidden window, a live backend process, and an autonomous workflow are different states');
  });

  it('surfaces local machine and background runtime awareness in the adapter registry', async () => {
    const { getAdapterRegistry } = await import('../server/adapters/registry');
    const report = getAdapterRegistry({
      includePlanned: false,
      clientState: {
        platform: 'desktop',
        updatedAt: Date.now(),
        runtime: {
          autostartEnabled: true,
          closeToBackground: true,
          startedInBackground: true,
          backendNodeRunning: true,
        },
      },
    });

    const localMachine = report.adapters.find(adapter => adapter.id === 'system.local_machine_awareness');
    const backgroundRuntime = report.adapters.find(adapter => adapter.id === 'system.background_runtime_awareness');

    expect(localMachine?.status).toBe('available');
    expect(localMachine?.requiresConfirmation).toBe(false);
    expect(localMachine?.actions).toEqual(expect.arrayContaining([
      'desktop_system_info',
      'desktop_list_apps',
      'desktop_list_files',
      'desktop_path_info',
      'desktop_running_processes',
      'desktop_active_window',
      'desktop_capture_screen',
    ]));
    expect(localMachine?.safety).toContain('Observation only');
    expect(backgroundRuntime?.status).toBe('ready');
    expect(backgroundRuntime?.requiresConfirmation).toBe(false);
    expect(backgroundRuntime?.diagnostics).toEqual(expect.arrayContaining([
      'autostart=true',
      'closeToBackground=true',
      'startedInBackground=true',
      'backendNode=running',
    ]));
    expect(backgroundRuntime?.notes).toContain('24-hour availability');
    expect(backgroundRuntime?.safety).toContain('Hidden-to-background');
    expect(backgroundRuntime?.safety).toContain('do not need per-tool permission popups');
  });

  it('advertises virtual cursor relay as available for controlled foreground WeChat sends', async () => {
    const { getAdapterRegistry } = await import('../server/adapters/registry');
    const { getClientCapabilities } = await import('../server/client/self_model');

    const report = getAdapterRegistry({ includePlanned: false });
    const computerUse = report.adapters.find(adapter => adapter.id === 'automation.computer_use');
    const visibleExecution = getClientCapabilities().find(capability => capability.id === 'system.visible_execution');

    expect(computerUse?.notes).toContain('foreground WeChat sends');
    expect(visibleExecution?.notes).toContain('foreground WeChat sends');
    expect(computerUse?.notes).toContain('desktop_cursor_glow_*');
    expect(visibleExecution?.notes).toContain('desktop_mouse_click_at');
  });

  it('advertises WeChat foreground send capability without treating ordinary sends as handoff-only', async () => {
    const { getClientCapabilities } = await import('../server/client/self_model');

    const wechat = getClientCapabilities().find(capability => capability.id === 'external.messaging');

    expect(wechat?.actions).toContain('wechat_send_message');
    expect(wechat?.actions).toContain('wechat_read_recent_chat');
    expect(wechat?.actions).toContain('desktop_mouse_click_at');
    expect(wechat?.notes).toContain('ordinary foreground user-requested WeChat messages');
    expect(wechat?.notes).toContain('Reading, drafting, and sending are separate capabilities');
    expect(wechat?.notes).toContain('virtual cursor path');
  });
});
