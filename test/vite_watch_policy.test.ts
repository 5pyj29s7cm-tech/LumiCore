import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(async () => ({ middlewares: 'vite-middlewares' })),
}));

vi.mock('vite', () => ({
  createServer: createServerMock,
}));

import { setupStatic } from '../server/runtime/static';
import {
  createViteWatchIgnored,
  shouldIgnoreViteWatchPath,
  VITE_WATCH_IGNORED_ROOTS,
} from '../vite.watch-policy';

const projectRoot = 'D:\\LumiCore';

describe('Vite development watcher policy', () => {
  beforeEach(() => {
    createServerMock.mockClear();
  });

  it.each([
    'D:\\LumiCore\\src-tauri\\target',
    'D:\\LumiCore\\src-tauri\\target\\debug\\build\\crate\\out',
    'D:\\LumiCore\\src-tauri\\gen\\schemas',
    'D:\\LumiCore\\local-tts\\cosyvoice\\models\\speaker',
    'D:\\LumiCore\\.codex-run\\sessions\\active',
    'D:\\LumiCore\\desktop-resources\\gpt-sovits-src',
    'D:\\LumiCore\\gpt-sovits-src\\GPT_SoVITS\\pretrained_models',
    'D:\\LumiCore\\data\\voice_training\\speaker',
    'D:\\LumiCore\\dist-server\\chunks',
    'D:\\LumiCore\\server\\runtime',
    'src-tauri/target/debug',
    'local-tts/cosyvoice/models',
  ])('ignores non-HMR generated, model, runtime, and backend path %s', watchedPath => {
    expect(shouldIgnoreViteWatchPath(watchedPath, projectRoot)).toBe(true);
  });

  it.each([
    'D:\\LumiCore\\src\\components\\DesktopUI.tsx',
    'D:\\LumiCore\\public\\icons\\icon.png',
    'D:\\LumiCore\\index.html',
    'D:\\LumiCore\\vite.config.ts',
    'D:\\LumiCore\\vite.watch-policy.ts',
    'D:\\LumiCore\\server.ts',
    'src/components/DesktopUI.tsx',
    'public/icons/icon.png',
  ])('keeps frontend HMR and root configuration path %s visible', watchedPath => {
    expect(shouldIgnoreViteWatchPath(watchedPath, projectRoot)).toBe(false);
  });

  it('does not ignore similarly named paths outside the project or frontend source', () => {
    expect(shouldIgnoreViteWatchPath('D:\\another-project\\local-tts\\model', projectRoot)).toBe(false);
    expect(shouldIgnoreViteWatchPath('D:\\LumiCore\\src\\server\\client.ts', projectRoot)).toBe(false);
    expect(shouldIgnoreViteWatchPath('D:\\LumiCore\\public\\data\\fixture.json', projectRoot)).toBe(false);
  });

  it('covers every measured high-cardinality root without broad src/public exclusions', () => {
    expect(VITE_WATCH_IGNORED_ROOTS).toEqual(expect.arrayContaining([
      'src-tauri/target',
      'local-tts',
      '.codex-run',
      'desktop-resources',
      'server',
    ]));
    expect(VITE_WATCH_IGNORED_ROOTS).not.toContain('src');
    expect(VITE_WATCH_IGNORED_ROOTS).not.toContain('public');
  });

  it('passes the exclusion policy to the middleware server before startup', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const app = { use: vi.fn() };

    try {
      await setupStatic(
        app as never,
        path.join(process.cwd(), 'server.ts'),
        process.cwd(),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    expect(createServerMock).toHaveBeenCalledTimes(1);
    const inlineConfig = (createServerMock.mock.calls as unknown[][])[0]?.[0] as {
      server?: { watch?: { ignored?: (watchedPath: string) => boolean } };
    };
    const ignored = inlineConfig.server?.watch?.ignored;
    expect(ignored).toEqual(expect.any(Function));
    expect(ignored?.(path.join(process.cwd(), 'src-tauri', 'target'))).toBe(true);
    expect(ignored?.(path.join(process.cwd(), 'local-tts', 'cosyvoice'))).toBe(true);
    expect(ignored?.(path.join(process.cwd(), 'src', 'components', 'DesktopUI.tsx'))).toBe(false);
    expect(app.use).toHaveBeenCalledWith('vite-middlewares');
  });

  it('creates a reusable chokidar matcher', () => {
    const ignored = createViteWatchIgnored(projectRoot);
    expect(ignored('D:\\LumiCore\\desktop-resources')).toBe(true);
    expect(ignored('D:\\LumiCore\\public')).toBe(false);
  });
});
