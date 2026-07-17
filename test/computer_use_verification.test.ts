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

import { computerUseLoop } from '../server/agents/computer_use';

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
});
