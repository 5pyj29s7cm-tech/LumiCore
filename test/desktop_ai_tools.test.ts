import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerDesktopAiTools } from '../server/tools/definitions/desktop_ai_tools';

function createRegistry() {
  const registry = new ToolRegistry();
  registerDesktopAiTools(registry);
  return registry;
}

describe('desktop AI collaboration tools', () => {
  it('lists common local and browser AI targets, not only WorkBuddy and Codex', async () => {
    const registry = createRegistry();
    const raw = await registry.execute('desktop_ai_list_targets', {});
    const result = JSON.parse(raw);

    expect(result.targets.map((target: any) => target.id)).toEqual(expect.arrayContaining([
      'workbuddy',
      'codex',
      'chatgpt',
      'claude',
      'gemini',
      'deepseek',
      'kimi',
      'doubao',
      'tongyi',
      'cursor',
      'copilot',
      'lmstudio',
      'ollama',
    ]));
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

  it('falls back from a named desktop app target to a browser AI URL', async () => {
    const registry = createRegistry();
    const opened: string[] = [];
    let foreground = 'Lumi';

    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Give me three concise naming options.',
      targets: ['chatgpt'],
      send: false,
    }, {
      desktopRelay: async (name, args) => {
        if (name === 'desktop_active_window') return JSON.stringify({ title: foreground, process_name: 'chrome' });
        if (name === 'desktop_open') {
          opened.push(String(args.target));
          foreground = String(args.target).startsWith('http') ? 'ChatGPT - Chrome' : 'Start menu';
          return JSON.stringify({ ok: true, target: args.target });
        }
        if (name === 'desktop_clipboard_write') return 'Clipboard updated';
        if (name === 'desktop_keyboard_press') return `Pressed: ${args.key}`;
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.preparedCount).toBe(1);
    expect(opened).toEqual(['ChatGPT', 'https://chatgpt.com/']);
    expect(result.results[0].openTarget).toBe('https://chatgpt.com/');
  });

  it('supports custom desktop AI targets without adding new code paths', async () => {
    const registry = createRegistry();
    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Summarize the attached note.',
      targets: ['my-ai'],
      customTargets: [{
        id: 'my-ai',
        label: 'My AI Tool',
        openTargets: ['My AI Tool'],
        aliases: ['My AI Tool'],
      }],
      send: false,
    }, {
      desktopRelay: async (name, args) => {
        if (name === 'desktop_active_window') return JSON.stringify({ title: String(args?.target || 'My AI Tool'), process_name: 'My AI Tool' });
        if (name === 'desktop_open') return JSON.stringify({ ok: true, target: args.target });
        if (name === 'desktop_clipboard_write') return 'Clipboard updated';
        if (name === 'desktop_keyboard_press') return `Pressed: ${args.key}`;
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.preparedCount).toBe(1);
    expect(result.results[0].target).toBe('my-ai');
    expect(result.results[0].label).toBe('My AI Tool');
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
