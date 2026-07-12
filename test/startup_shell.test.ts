import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('desktop startup shell', () => {
  it('paints a dark first frame before React mounts', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('id="lumi-preload"');
    expect(html).toContain('background: #080a0d');
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('uses one truthful startup sequence without the old white flash', () => {
    const desktopEntry = fs.readFileSync(path.join(process.cwd(), 'src/entries/desktop.tsx'), 'utf8');
    const desktopUi = fs.readFileSync(path.join(process.cwd(), 'src/components/DesktopUI.tsx'), 'utf8');
    const startup = fs.readFileSync(path.join(process.cwd(), 'src/components/StartupSequence.tsx'), 'utf8');

    expect(desktopEntry).toContain('<StartupSequence ready={!shell.loading} />');
    expect(desktopUi).not.toContain('HardcoreBootSequence');
    expect(startup).not.toContain('Core Temperature');
    expect(startup).not.toContain('absolute inset-0 bg-white');
  });

  it('keeps the native window hidden until the dark webview shell has loaded', () => {
    const tauriConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const rustEntry = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');

    expect(tauriConfig.app.windows[0].visible).toBe(false);
    expect(rustEntry).toContain('.on_page_load(move |webview, payload|');
    expect(rustEntry).toContain('PageLoadEvent::Finished');
    expect(rustEntry).toContain('webview.window().show()');
  });

  it('tracks the replacement backend after a supervised restart', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'launcher.ts'), 'utf8');
    expect(launcher).toContain('currentChild = restartServer()');
    expect(launcher).toContain('scheduleServerRestart(500)');
    expect(launcher).toContain('scheduleServerRestart(delay)');
    expect(launcher).not.toContain('setTimeout(() => restartServer()');
  });
});
