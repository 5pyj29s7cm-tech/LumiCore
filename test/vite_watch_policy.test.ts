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

const projectRoot = 'D:\\lumiOS';

describe('Vite development watcher policy', () => {
  beforeEach(() => {
    createServerMock.mockClear();
  });

  it.each([
    'D:\\lumiOS\\src-tauri\\target',
    'D:\\lumiOS\\src-tauri\\target\\debug\\build\\crate\\out',
    'D:\\lumiOS\\src-tauri\\gen\\schemas',
    'D:\\lumiOS\\local-tts\\cosyvoice\\models\\speaker',
    'D:\\lumiOS\\.codex-run\\sessions\\active',
    'D:\\lumiOS\\desktop-resources\\gpt-sovits-src',
    'D:\\lumiOS\\gpt-sovits-src\\GPT_SoVITS\\pretrained_models',
    'D:\\lumiOS\\data\\voice_training\\speaker',
    'D:\\lumiOS\\dist-server\\chunks',
    'D:\\lumiOS\\server\\runtime',
    'src-tauri/target/debug',
    'local-tts/cosyvoice/models',
  ])('ignores non-HMR generated, model, runtime, and backend path %s', watchedPath => {
    expect(shouldIgnoreViteWatchPath(watchedPath, projectRoot)).toBe(true);
  });

  it.each([
    'D:\\lumiOS\\src\\components\\DesktopUI.tsx',
    'D:\\lumiOS\\public\\icons\\icon.png',
    'D:\\lumiOS\\index.html',
    'D:\\lumiOS\\vite.config.ts',
    'D:\\lumiOS\\vite.watch-policy.ts',
    'D:\\lumiOS\\server.ts',
    'src/components/DesktopUI.tsx',
    'public/icons/icon.png',
  ])('keeps frontend HMR and root configuration path %s visible', watchedPath => {
    expect(shouldIgnoreViteWatchPath(watchedPath, projectRoot)).toBe(false);
  });

  it('does not ignore similarly named paths outside the project or frontend source', () => {
    expect(shouldIgnoreViteWatchPath('D:\\another-project\\local-tts\\model', projectRoot)).toBe(false);
    expect(shouldIgnoreViteWatchPath('D:\\lumiOS\\src\\server\\client.ts', projectRoot)).toBe(false);
    expect(shouldIgnoreViteWatchPath('D:\\lumiOS\\public\\data\\fixture.json', projectRoot)).toBe(false);
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
    expect(ignored('D:\\lumiOS\\desktop-resources')).toBe(true);
    expect(ignored('D:\\lumiOS\\public')).toBe(false);
  });
});
