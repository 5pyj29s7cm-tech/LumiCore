import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', () => ({
  makeLLMCall: mocks.makeLLMCall,
}));

vi.mock('../server/llm/adapter', () => ({
  parseScreenshotBase64: (value: string) => {
    const parsed = JSON.parse(value);
    return { base64: parsed.image_base64, mime: 'image/png' };
  },
}));

vi.mock('../server/llm/world_preferences', () => ({
  getUserPreferredWorldModel: () => ({
    provider: 'openai',
    model: 'vision-test',
  }),
}));

vi.mock('../server/llm/token_tracker', () => ({
  recordTokenUsage: vi.fn(),
}));

import {
  computerUseLoop,
  parseDesktopScreenGeometry,
  parseDesktopWindowFingerprint,
  sameDesktopWindow,
} from '../server/agents/computer_use';
import { ToolRegistry } from '../server/tools/registry';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';

function modelResult(text: string) {
  return {
    text,
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    },
  };
}

function createDesktopRelay() {
  let captures = 0;
  const relay = vi.fn(async (toolName: string) => {
    if (toolName === 'desktop_capture_screen') {
      captures += 1;
      return JSON.stringify({
        image_base64: `screen-${captures}`,
        format: 'png',
      });
    }
    return '';
  });
  return {
    relay,
    captures: () => captures,
  };
}

describe('computer use completion verification', () => {
  beforeEach(() => {
    mocks.makeLLMCall.mockReset();
  });

  it('does not accept the first visual-model done action as completion evidence', async () => {
    mocks.makeLLMCall.mockResolvedValueOnce(modelResult(JSON.stringify({
      action: 'done',
      message: 'The app looks open.',
    })));
    const desktop = createDesktopRelay();
    const progress: string[] = [];

    const result = await computerUseLoop('Open the requested app', {
      desktopRelay: desktop.relay,
      llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 1,
      onProgress: message => progress.push(message),
    });

    expect(desktop.captures()).toBe(1);
    expect(result).not.toContain('"status":"verified"');
    expect(progress.some(message => message.includes('完成候选'))).toBe(true);
    expect(progress).not.toContain('[1/1] 完成');
  });

  it('accepts done only after a fresh screenshot produces a second done observation', async () => {
    mocks.makeLLMCall
      .mockResolvedValueOnce(modelResult(JSON.stringify({
        action: 'done',
        message: 'The target window is visible.',
      })))
      .mockResolvedValueOnce(modelResult(JSON.stringify({
        action: 'done',
        message: 'The same target window is still visible.',
      })));
    const desktop = createDesktopRelay();
    const progress: string[] = [];

    const result = await computerUseLoop('Open the requested app', {
      desktopRelay: desktop.relay,
      llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 2,
      onProgress: message => progress.push(message),
    });

    expect(desktop.captures()).toBe(2);
    expect(JSON.parse(result)).toMatchObject({
      ok: true,
      status: 'verified',
      completionVerified: true,
      observations: 2,
    });
    expect(progress.some(message => message.includes('新截图复核完成'))).toBe(true);
    expect(progress.some(message => /]\s*完成$/.test(message))).toBe(false);
  });

  it('returns a verified blocker instead of completion evidence when done reports failure', async () => {
    mocks.makeLLMCall
      .mockResolvedValueOnce(modelResult(JSON.stringify({
        action: 'done',
        message: 'Could not complete: the target button is disabled.',
      })))
      .mockResolvedValueOnce(modelResult(JSON.stringify({
        action: 'done',
        message: 'Could not complete: the target button is still disabled.',
      })));
    const desktop = createDesktopRelay();

    const result = await computerUseLoop('Submit the form', {
      desktopRelay: desktop.relay,
      llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 2,
    });

    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      status: 'blocked',
      completionVerified: false,
      observations: 2,
    });
  });

  it('compares native window ids before weaker process and geometry evidence', () => {
    const first = parseDesktopWindowFingerprint(JSON.stringify({
      window_id: '101', title: 'Document A', process_name: 'editor.exe', pid: 44, x: 0, y: 0, width: 800, height: 600,
    }));
    const renamed = parseDesktopWindowFingerprint(JSON.stringify({
      window_id: '101', title: 'Document A *', process_name: 'editor.exe', pid: 44, x: 0, y: 0, width: 800, height: 600,
    }));
    const other = parseDesktopWindowFingerprint(JSON.stringify({
      window_id: '202', title: 'Document B', process_name: 'editor.exe', pid: 44, x: 0, y: 0, width: 800, height: 600,
    }));

    expect(first).not.toBeNull();
    expect(renamed).not.toBeNull();
    expect(other).not.toBeNull();
    expect(sameDesktopWindow(first!, renamed!)).toBe(true);
    expect(sameDesktopWindow(first!, other!)).toBe(false);
  });

  it('preserves virtual-desktop origins for multi-monitor screenshots', async () => {
    expect(parseDesktopScreenGeometry(JSON.stringify({
      screen_x: -1920, screen_y: -200, width: 3840, height: 1280,
    }))).toEqual({ screenX: -1920, screenY: -200, width: 3840, height: 1280, inputWidth: 3840, inputHeight: 1280 });

    mocks.makeLLMCall.mockResolvedValueOnce(modelResult(JSON.stringify({
      action: 'click', x: 100, y: 250,
    })));
    const clickArgs: Array<Record<string, any>> = [];
    const relay = vi.fn(async (toolName: string, args: Record<string, any>) => {
      if (toolName === 'desktop_capture_screen') {
        return JSON.stringify({
          image_base64: 'screen', format: 'png', screen_x: -1920, screen_y: -200, width: 3840, height: 1280,
        });
      }
      if (toolName === 'desktop_active_window') {
        return JSON.stringify({ window_id: 'stable-window', title: 'Editor', process_name: 'editor.exe', pid: 10 });
      }
      if (toolName === 'desktop_mouse_click_at') clickArgs.push(args);
      return '';
    });

    await computerUseLoop('Click the visible target', {
      desktopRelay: relay,
      llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 1,
    });

    expect(clickArgs).toEqual([{ x: -1820, y: 50, button: 'left' }]);
  });

  it('maps Retina screenshot pixels into native macOS input coordinates', async () => {
    mocks.makeLLMCall.mockResolvedValueOnce(modelResult(JSON.stringify({
      action: 'click', x: 1000, y: 500,
    })));
    const clickArgs: Array<Record<string, any>> = [];
    const relay = vi.fn(async (toolName: string, args: Record<string, any>) => {
      if (toolName === 'desktop_capture_screen') {
        return JSON.stringify({
          image_base64: 'screen', format: 'png', width: 3840, height: 2160,
          input_width: 1920, input_height: 1080,
        });
      }
      if (toolName === 'desktop_active_window') {
        return JSON.stringify({ window_id: 'stable-window', title: 'AutoCAD', process_name: 'AutoCAD', pid: 10 });
      }
      if (toolName === 'desktop_mouse_click_at') clickArgs.push(args);
      return '';
    });

    await computerUseLoop('Click the visible AutoCAD command', {
      desktopRelay: relay,
      llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 1,
    });

    expect(clickArgs).toEqual([{ x: 500, y: 250, button: 'left' }]);
  });

  it('skips a planned input action when the foreground window changes during model latency', async () => {
    mocks.makeLLMCall.mockResolvedValueOnce(modelResult(JSON.stringify({
      action: 'type',
      text: 'must-not-land-in-another-window',
    })));
    let activeChecks = 0;
    const calls: string[] = [];
    const relay = vi.fn(async (toolName: string) => {
      calls.push(toolName);
      if (toolName === 'desktop_capture_screen') {
        return JSON.stringify({ image_base64: 'screen', format: 'png' });
      }
      if (toolName === 'desktop_active_window') {
        activeChecks += 1;
        return JSON.stringify(activeChecks < 3
          ? { window_id: 'window-a', title: 'Editor', process_name: 'editor.exe', pid: 10 }
          : { window_id: 'window-b', title: 'Chat', process_name: 'chat.exe', pid: 20 });
      }
      return '';
    });

    await computerUseLoop('Type into the editor', {
      desktopRelay: relay,
      llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 1,
    });

    expect(calls).not.toContain('desktop_keyboard_type');
    expect(calls).toContain('desktop_active_window');
  });

  it('prevents two computer-use loops from controlling the same desktop concurrently', async () => {
    let releaseModel!: (value: ReturnType<typeof modelResult>) => void;
    mocks.makeLLMCall.mockImplementationOnce(() => new Promise(resolve => {
      releaseModel = resolve;
    }));
    const registry = new ToolRegistry();
    registerComputerUseTool(registry);
    const desktop = createDesktopRelay();
    const context = {
      userId: 'desktop-lease-user',
      desktopRelay: desktop.relay,
      llmGetters: { getDeepSeek: () => null, getGemini: () => null, getOpenAI: () => ({}) },
    };

    const first = registry.execute('computer_use', { task: 'First task', max_steps: 1 }, context);
    await vi.waitFor(() => expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1));

    await expect(registry.execute('computer_use', { task: 'Second task', max_steps: 1 }, context))
      .rejects.toThrow(/already active/);

    releaseModel(modelResult(JSON.stringify({ action: 'done', message: 'First observation.' })));
    await first;
  });
});
