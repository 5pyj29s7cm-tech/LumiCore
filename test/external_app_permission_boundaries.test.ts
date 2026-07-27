import './helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

describe('external app permission boundaries', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    await initDatabase();
    saveGateConfig({
      autonomyLevel: 'reactive',
      autoProcessEnabled: false,
      messagingSendRequiresConfirmation: true,
    });
  });

  it('allows foreground browser opening without the legacy external automation flag or a permission popup', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];
    let confirmationCalls = 0;

    const raw = await registry.execute('browser_open_task', {
      url: 'example.com',
      open: true,
    }, {
      requestConfirmation: async () => {
        confirmationCalls++;
        return true;
      },
      desktopRelay: async (name, args) => {
        relayCalls.push({ name, args });
        return 'opened';
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.target).toBe('https://example.com');
    expect(result.opened).toBe(true);
    expect(confirmationCalls).toBe(0);
    expect(relayCalls).toEqual([{ name: 'desktop_open', args: { target: 'https://example.com' } }]);
  });

  it('allows draft clipboard preparation without treating it as external app automation or a permission popup', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];
    let confirmationCalls = 0;

    const raw = await registry.execute('wechat_copy_reply_draft', {
      draft: 'Received. I will prepare the plan first.',
      openWechat: false,
    }, {
      requestConfirmation: async () => {
        confirmationCalls++;
        return true;
      },
      desktopRelay: async (name, args) => {
        relayCalls.push({ name, args });
        return 'copied';
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.copied).toBe(true);
    expect(result.opened).toBe(false);
    expect(confirmationCalls).toBe(0);
    expect(relayCalls).toEqual([{ name: 'desktop_clipboard_write', args: { text: 'Received. I will prepare the plan first.' } }]);
  });

  it('allows autonomous external app control when the legacy external automation flag is off', async () => {
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    saveGateConfig({ autonomyLevel: 'full' });

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
    saveGateConfig({ autonomyLevel: 'reactive' });

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

  it('prepares direct human message drafts instead of process notes', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);

    const raw = await registry.execute('wechat_prepare_reply', {
      contact: '\u963f\u9646',
      context: '\u7528\u6237\u60f3\u53d1\u4e00\u6761\u7b80\u77ed\u7684\u665a\u5b89\u6d88\u606f\u3002',
      intent: '\u8868\u8fbe\u665a\u5b89\u548c\u5173\u5fc3',
      tone: '\u6e29\u6696\u3001\u7b80\u77ed',
    });

    const result = JSON.parse(raw);
    expect(result.sendAllowed).toBe(false);
    expect(result.draft).toContain('\u665a\u5b89');
    expect(result.draft).not.toContain('\u6309\u201c');
    expect(result.draft).not.toContain('\u5173\u952e\u70b9');
  });

  it('treats sparse foreground WeChat UI text as readable chat evidence', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: string[] = [];

    const raw = await registry.execute('wechat_read_recent_chat', {
      contact: '\u963f\u9646',
      maxMessages: 6,
    }, {
      desktopRelay: async (name, args) => {
        relayCalls.push(name);
        if (name === 'desktop_open') return JSON.stringify({ ok: true, target: args.target, reusedRunningWindow: true });
        if (name === 'desktop_active_window') {
          return JSON.stringify({
            title: '\u5fae\u4fe1',
            processName: 'Weixin.exe',
            bounds: { x: 120, y: 80, width: 1100, height: 780 },
          });
        }
        if (name === 'desktop_ui_snapshot') {
          return [
            'Window: \u5fae\u4fe1',
            '[1] Text: \u963f\u9646',
            '[2] Text: \u597d\u7684',
            '[3] Text: \u665a\u4e0a\u89c1',
            '[4] Edit: \u8f93\u5165\u6d88\u606f',
          ].join('\n');
        }
        if (name === 'desktop_capture_screen') return 'data:image/png;base64,iVBORw0KGgo=';
        return JSON.stringify({ ok: true });
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.read).toBe(true);
    expect(result.method).toBe('foreground_wechat_search_ui_snapshot');
    expect(relayCalls).toContain('desktop_ui_snapshot');
    expect(relayCalls).not.toContain('wechat_send_message');
  });

  it('uses nested desktop window bounds for the WeChat virtual cursor point', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];

    const raw = await registry.execute('wechat_send_message', {
      message: '\u665a\u5b89',
      useSearch: false,
      useVirtualCursor: true,
    }, {
      requestConfirmation: async () => true,
      desktopRelay: async (name, args) => {
        relayCalls.push({ name, args });
        if (name === 'desktop_open') return JSON.stringify({ ok: true, target: args.target, reusedRunningWindow: true });
        if (name === 'desktop_active_window') {
          return JSON.stringify({
            title: '\u5fae\u4fe1',
            processName: 'Weixin.exe',
            bounds: { x: 120, y: 80, width: 1100, height: 780 },
          });
        }
        return JSON.stringify({ ok: true });
      },
    } as any);

    const result = JSON.parse(raw);
    expect(result.sent).toBe(false);
    expect(result.verificationStatus).toBe('uncertain');
    expect(result.method).toBe('virtual_cursor_clipboard_paste_send');
    expect(result.inputPoint).toEqual({ x: 758, y: 764 });
    expect(relayCalls.some(call => call.name === 'desktop_mouse_click_at')).toBe(true);
    expect(relayCalls.find(call => call.name === 'desktop_cursor_glow_update')?.args).toEqual({ x: 758, y: 764 });
  });

  it('requires confirmation then uses the member personal desktop relay for a verified organization-to-WeChat file transfer', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerExternalAppTools } = await import('../server/tools/definitions/external_app_tools');
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const { createOrg, addMember } = await import('../server/org/db');
    const userId = `wechat-file-owner-${Date.now()}-${Math.random()}`;
    const orgId = createOrg('WeChat File Boundary', `wechat-file-boundary-${Date.now()}-${Math.random()}`, userId).id;
    addMember(orgId, userId, 'owner');
    const filePath = path.join(os.tmpdir(), `lumi-wechat-file-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'file transfer evidence', 'utf8');
    const relayCalls: Array<{ name: string; args: Record<string, any> }> = [];
    let snapshotCount = 0;
    let confirmationCount = 0;

    try {
      const raw = await registry.execute('wechat_send_file', {
        filePath,
        contact: '文件传输助手',
      }, {
        userId,
        domain: 'work',
        orgId,
        source: 'feishu_bot',
        actionIntent: '把这个文件附件发给我的微信',
        supervisedExternalCommits: true,
        requestConfirmation: async () => {
          confirmationCount += 1;
          return true;
        },
        desktopRelay: async () => { throw new Error('work desktop relay must not be used'); },
        personalDesktopRelay: async (name, args) => {
          relayCalls.push({ name, args });
          if (name === 'desktop_open') return JSON.stringify({ ok: true, reusedRunningWindow: true });
          if (name === 'desktop_active_window') {
            return JSON.stringify({
              title: '微信',
              processName: 'Weixin.exe',
              bounds: { x: 100, y: 60, width: 1000, height: 760 },
            });
          }
          if (name === 'desktop_ui_snapshot') {
            snapshotCount++;
            return snapshotCount > 1 ? `new outgoing file ${path.basename(filePath)}` : 'existing chat content';
          }
          return JSON.stringify({ ok: true });
        },
      } as any);

      const result = JSON.parse(raw);
      expect(result.sent).toBe(true);
      expect(confirmationCount).toBe(1);
      expect(result.verificationMethod).toBe('uia_filename');
      expect(relayCalls.find(call => call.name === 'desktop_clipboard_write_files')?.args)
        .toEqual({ paths: [filePath] });
      expect(relayCalls.some(call => call.name === 'desktop_keyboard_press' && call.args.key === 'ctrl+v')).toBe(true);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it('accepts only confident structured visual evidence for a WeChat send', async () => {
    const { parseWeChatSendVisionVerification } = await import('../server/tools/definitions/external_app_tools');

    expect(parseWeChatSendVisionVerification('{"sent":true,"confidence":0.91,"reason":"outgoing bubble visible"}')).toMatchObject({
      sent: true,
      confidence: 0.91,
    });
    expect(parseWeChatSendVisionVerification('{"sent":true,"confidence":0.4,"reason":"input text only"}').sent).toBe(false);
    expect(parseWeChatSendVisionVerification('looks sent').sent).toBe(false);
  });
});
