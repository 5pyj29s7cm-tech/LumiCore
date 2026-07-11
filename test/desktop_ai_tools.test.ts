import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerDesktopAiTools } from '../server/tools/definitions/desktop_ai_tools';

function createRegistry() {
  const registry = new ToolRegistry();
  registerDesktopAiTools(registry);
  return registry;
}

describe('desktop AI collaboration tools', () => {
  it('lists WorkBuddy and Codex as local desktop AI targets', async () => {
    const registry = createRegistry();
    const raw = await registry.execute('desktop_ai_list_targets', {});
    const result = JSON.parse(raw);

    expect(result.targets.map((target: any) => target.id)).toEqual(expect.arrayContaining(['workbuddy', 'codex']));
    expect(result.boundary).toContain('Desktop-only targets');
  });

  it('sends the same question to WorkBuddy and Codex through foreground windows', async () => {
    const registry = createRegistry();
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    let foreground = 'Lumi';

    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Compare two product naming options.',
      targets: ['workbuddy', 'codex'],
      send: true,
    }, {
      desktopRelay: async (name, args) => {
        calls.push({ name, args });
        if (name === 'desktop_active_window') {
          return JSON.stringify({ title: foreground, process_name: foreground });
        }
        if (name === 'desktop_open') {
          foreground = String(args.target || '');
          return JSON.stringify({ ok: true, target: args.target });
        }
        if (name === 'desktop_clipboard_write') return 'Clipboard updated';
        if (name === 'desktop_keyboard_press') return `Pressed: ${args.key}`;
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.sentCount).toBe(2);
    expect(result.results.map((item: any) => item.target)).toEqual(['workbuddy', 'codex']);
    expect(calls.filter(call => call.name === 'desktop_clipboard_write')).toHaveLength(2);
    expect(calls.filter(call => call.name === 'desktop_keyboard_press' && call.args.key === 'enter')).toHaveLength(2);
  });

  it('does not paste into an unverified foreground app', async () => {
    const registry = createRegistry();
    const calls: string[] = [];

    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Please answer this.',
      targets: ['codex'],
      openIfNeeded: false,
    }, {
      desktopRelay: async (name) => {
        calls.push(name);
        if (name === 'desktop_active_window') return JSON.stringify({ title: 'Notepad', process_name: 'notepad' });
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.blockedCount).toBe(1);
    expect(calls).not.toContain('desktop_clipboard_write');
    expect(calls).not.toContain('desktop_keyboard_press');
  });

  it('collects screenshot evidence but reports when no vision provider is configured', async () => {
    const registry = createRegistry();
    const raw = await registry.execute('desktop_ai_collect_answer', {
      target: 'codex',
    }, {
      desktopRelay: async (name) => {
        if (name === 'desktop_active_window') return JSON.stringify({ title: 'Codex', process_name: 'Codex' });
        if (name === 'desktop_capture_screen') return JSON.stringify({ image_base64: 'abc', width: 100, height: 100, format: 'jpeg' });
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.status).toBe('needs_vision_setup');
    expect(result.screenshotCaptured).toBe(true);
    expect(result.answerText).toBeNull();
  });
});
