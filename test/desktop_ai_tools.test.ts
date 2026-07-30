import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerDesktopAiTools } from '../server/tools/definitions/desktop_ai_tools';

function createRegistry() {
  const registry = new ToolRegistry();
  registerDesktopAiTools(registry);
  return registry;
}

describe('desktop AI collaboration tools', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

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

  it('selects default targets from running desktop AI apps instead of fixed names', async () => {
    const registry = createRegistry();
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    let foreground = 'Lumi';

    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Return one short sentence.',
      send: false,
      useVirtualCursor: false,
    }, {
      desktopRelay: async (name, args) => {
        calls.push({ name, args });
        if (name === 'desktop_running_processes') {
          return JSON.stringify([{ name: 'ChatGPT.exe' }, { name: 'claude.exe' }]);
        }
        if (name === 'desktop_list_apps') return JSON.stringify([]);
        if (name === 'desktop_active_window') return JSON.stringify({ title: foreground, process_name: foreground });
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

    expect(result.targetSelection).toMatchObject({
      mode: 'detected',
      runningTargetIds: expect.arrayContaining(['chatgpt', 'claude']),
    });
    expect(result.results.map((item: any) => item.target)).toEqual(['chatgpt', 'claude']);
    expect(calls.some(call => call.name === 'desktop_open' && /workbuddy/i.test(String(call.args.target)))).toBe(false);
  });

  it('uses the local app index when desktop AI apps are installed but not running', async () => {
    const registry = createRegistry();
    let foreground = 'Lumi';

    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Prepare this question.',
      send: false,
      useVirtualCursor: false,
    }, {
      desktopRelay: async (name, args) => {
        if (name === 'desktop_running_processes') return JSON.stringify([]);
        if (name === 'desktop_list_apps') {
          return JSON.stringify([
            { app_id: 'codex', label: 'Codex', path: 'C:\\Users\\tester\\Desktop\\Codex.lnk' },
            { app_id: 'lmstudio', label: 'LM Studio', path: 'C:\\Apps\\LM Studio.exe' },
          ]);
        }
        if (name === 'desktop_active_window') return JSON.stringify({ title: foreground, process_name: foreground });
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

    expect(result.targetSelection).toMatchObject({
      mode: 'detected',
      installedTargetIds: expect.arrayContaining(['codex', 'lmstudio']),
    });
    expect(result.results.map((item: any) => item.target)).toEqual(['codex', 'lmstudio']);
  });

  it('plans source-grounded discovery for missing desktop AI targets', async () => {
    const registry = createRegistry();
    const raw = await registry.execute('desktop_ai_discovery_plan', {
      focus: 'Windows desktop AI coding tools',
    });
    const result = JSON.parse(raw);

    expect(result.focus).toBe('Windows desktop AI coding tools');
    expect(result.suggestedQueries.some((query: string) => query.includes('official site'))).toBe(true);
    expect(result.candidateSchema).toMatchObject({
      id: 'stable-lowercase-id',
      label: 'Human readable app/tool name',
    });
    expect(result.evaluationChecklist.join('\n')).toContain('desktop_ai_register_target');
    expect(result.boundary).toContain('does not install software');
  });

  it('registers confirmed desktop AI targets for later reuse', async () => {
    const registry = createRegistry();
    const userId = 'desktop_ai_registered_user';
    await registry.execute('desktop_ai_register_target', {
      id: 'windsurf',
      label: 'Windsurf',
      aliases: ['Codeium Windsurf'],
      openTargets: ['Windsurf', 'Windsurf.exe'],
      surface: 'developer_tool',
      sourceUrls: ['https://windsurf.com/'],
      notes: 'Source-grounded candidate from official site.',
    }, {
      userId,
      userConfirmed: true,
    });

    const listRaw = await registry.execute('desktop_ai_list_targets', {}, { userId });
    const list = JSON.parse(listRaw);
    const registered = list.targets.find((target: any) => target.id === 'windsurf');
    expect(registered).toMatchObject({
      label: 'Windsurf',
      source: 'registered',
      surface: 'developer_tool',
    });

    let foreground = 'Lumi';
    const askRaw = await registry.execute('desktop_ai_ask', {
      question: 'Give me a short implementation plan.',
      targets: ['windsurf'],
      send: false,
    }, {
      userId,
      desktopRelay: async (name, args) => {
        if (name === 'desktop_active_window') return JSON.stringify({ title: foreground, process_name: foreground });
        if (name === 'desktop_open') {
          foreground = 'Windsurf';
          return JSON.stringify({ ok: true, target: args.target });
        }
        if (name === 'desktop_clipboard_write') return 'Clipboard updated';
        if (name === 'desktop_keyboard_press') return `Pressed: ${args.key}`;
        return 'ok';
      },
    });
    const ask = JSON.parse(askRaw);

    expect(ask.preparedCount).toBe(1);
    expect(ask.results[0]).toMatchObject({
      target: 'windsurf',
      label: 'Windsurf',
      status: 'prepared',
    });
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
      requestConfirmation: async () => true,
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
    expect(result.submittedCount).toBe(2);
    expect(result.sentCount).toBe(0);
    expect(result.results.every((item: any) => item.status === 'submitted_unverified')).toBe(true);
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
      userConfirmed: true,
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

  it('prefers the official browser chat surface for browser AI targets', async () => {
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
    expect(opened).toEqual(['https://chatgpt.com/']);
    expect(result.results[0].openTarget).toBe('https://chatgpt.com/');
  });

  it('waits for a browser AI page title instead of falling back to a native sub-surface', async () => {
    const registry = createRegistry();
    const opened: string[] = [];
    let checksAfterOpen = 0;
    let openedBrowser = false;

    const raw = await registry.execute('desktop_ai_ask', {
      question: 'Prepare a concise question.',
      targets: ['chatgpt'],
      send: false,
      useVirtualCursor: false,
    }, {
      desktopRelay: async (name, args) => {
        if (name === 'desktop_open') {
          opened.push(String(args.target));
          openedBrowser = true;
          return `Opened: ${args.target}`;
        }
        if (name === 'desktop_active_window') {
          if (!openedBrowser) return JSON.stringify({ title: 'ChatGPT', process_name: 'ChatGPT.exe' });
          checksAfterOpen += 1;
          return checksAfterOpen < 3
            ? JSON.stringify({ title: 'Untitled - Browser', process_name: 'chrome.exe' })
            : JSON.stringify({ title: 'ChatGPT - Browser', process_name: 'chrome.exe', x: 100, y: 80, width: 1200, height: 800 });
        }
        if (name === 'desktop_clipboard_write') return 'Clipboard updated';
        if (name === 'desktop_keyboard_press') return `Pressed: ${args.key}`;
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.preparedCount).toBe(1);
    expect(opened).toEqual(['https://chatgpt.com/']);
    expect(result.results[0].activeWindow.process_name).toBe('chrome.exe');
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

  it('runs a multi-AI roundtable without pretending unverified submissions are answers', async () => {
    const registry = createRegistry();
    let foreground = 'Lumi';
    const raw = await registry.execute('desktop_ai_roundtable', {
      question: 'Compare two implementation approaches.',
      targets: ['workbuddy', 'codex'],
      initialWaitMs: 0,
      pollAttempts: 1,
    }, {
      userConfirmed: true,
      desktopRelay: async (name, args) => {
        if (name === 'desktop_active_window') return JSON.stringify({ title: foreground, process_name: foreground });
        if (name === 'desktop_open') {
          foreground = String(args.target || '');
          return JSON.stringify({ ok: true, target: args.target });
        }
        if (name === 'desktop_capture_screen') return JSON.stringify({ image_base64: 'abc', width: 100, height: 100, format: 'jpeg' });
        return 'ok';
      },
    });
    const result = JSON.parse(raw);

    expect(result.ask.submittedCount).toBe(2);
    expect(result.collectedCount).toBe(0);
    expect(result.needsVisionSetupCount).toBe(2);
    expect(result.synthesisInput).toEqual([]);
  });

  it('parses only structured, confident desktop answer evidence', async () => {
    const { detectDesktopAiAnswerBlocker, parseDesktopAiAnswerEvidence, parseDesktopAiInputEvidence } = await import('../server/tools/definitions/desktop_ai_tools');
    expect(parseDesktopAiAnswerEvidence('{"ready":true,"answerText":"Use approach A","confidence":0.87,"reason":"answer visible"}')).toMatchObject({
      ready: true,
      answerText: 'Use approach A',
    });
    expect(parseDesktopAiAnswerEvidence('{"ready":true,"answerText":"","confidence":0.9}').ready).toBe(false);
    expect(parseDesktopAiAnswerEvidence('still loading').ready).toBe(false);

    expect(parseDesktopAiInputEvidence('{"readyToAsk":true,"inputX":940,"inputY":720,"confidence":0.91,"surfaceKind":"general_chat","reason":"main composer visible"}')).toMatchObject({
      valid: true,
      ready: true,
      x: 940,
      y: 720,
      surfaceKind: 'general_chat',
    });
    expect(parseDesktopAiInputEvidence('{"readyToAsk":false,"inputX":null,"inputY":null,"confidence":0.94,"surfaceKind":"wrong_surface","reason":"request changes field"}')).toMatchObject({
      valid: true,
      ready: false,
      surfaceKind: 'wrong_surface',
    });
    expect(parseDesktopAiInputEvidence('not json').valid).toBe(false);
    expect(detectDesktopAiAnswerBlocker('登录界面可见，无助手回答内容')).toBe('login_required');
    expect(detectDesktopAiAnswerBlocker('Captcha or one-time code is required')).toBe('verification_required');
    expect(detectDesktopAiAnswerBlocker('No substantive assistant answer is visible yet')).toBeNull();
  });
});
