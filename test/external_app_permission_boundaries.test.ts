import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';

describe('external app permission boundaries', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    await initDatabase();
    saveGateConfig({
      autonomyLevel: 'reactive',
      autoProcessEnabled: false,
      externalAppAutomationEnabled: false,
      messagingSendRequiresConfirmation: true,
    });
  });

  it('allows confirmed foreground browser opening when the legacy external automation flag is off', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];

    const raw = await registry.execute('browser_open_task', {
      url: 'example.com',
      open: true,
    }, {
      requestConfirmation: async () => true,
      desktopRelay: async (name, args) => {
        relayCalls.push({ name, args });
        return 'opened';
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.target).toBe('https://example.com');
    expect(result.opened).toBe(true);
    expect(relayCalls).toEqual([{ name: 'desktop_open', args: { target: 'https://example.com' } }]);
  });

  it('allows confirmed draft clipboard preparation without treating it as external app automation', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];

    const raw = await registry.execute('wechat_copy_reply_draft', {
      draft: 'Received. I will prepare the plan first.',
      openWechat: false,
    }, {
      requestConfirmation: async () => true,
      desktopRelay: async (name, args) => {
        relayCalls.push({ name, args });
        return 'copied';
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.copied).toBe(true);
    expect(result.opened).toBe(false);
    expect(relayCalls).toEqual([{ name: 'desktop_clipboard_write', args: { text: 'Received. I will prepare the plan first.' } }]);
  });

  it('allows autonomous external app control when the legacy external automation flag is off', async () => {
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    saveGateConfig({ autonomyLevel: 'full', externalAppAutomationEnabled: false });

    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];

    const raw = await registry.execute('browser_open_task', {
      url: 'example.com',
      open: true,
    }, {
      autonomous: true,
      userConfirmed: true,
      desktopRelay: async (name, args) => {
        relayCalls.push({ name, args });
        return 'opened';
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.opened).toBe(true);
    expect(relayCalls).toEqual([{ name: 'desktop_open', args: { target: 'https://example.com' } }]);
  });

  it('still blocks autonomous work in reactive mode', async () => {
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    saveGateConfig({ autonomyLevel: 'reactive', externalAppAutomationEnabled: false });

    const registry = new ToolRegistry();
    registerExternalAppTools(registry);

    await expect(registry.execute('browser_open_task', {
      url: 'example.com',
      open: true,
    }, {
      autonomous: true,
      userConfirmed: true,
      desktopRelay: async () => 'opened',
    } as any)).rejects.toThrow(/Autonomous work is disabled in reactive mode/);
  });
});
