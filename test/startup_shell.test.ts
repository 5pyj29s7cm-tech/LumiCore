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

  it('merges macOS camera and microphone permission prompts at bundle time', () => {
    const tauriConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));
    const plistPath = path.join(process.cwd(), 'src-tauri', tauriConfig.bundle.macOS.infoPlist);
    const infoPlist = fs.readFileSync(plistPath, 'utf8');
    const macBuildWorkflow = fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/build-macos.yml'),
      'utf8',
    );

    expect(infoPlist).toContain('<key>NSCameraUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSMicrophoneUsageDescription</key>');
    expect(infoPlist).not.toContain('<key>CFBundleVersion</key>');
    expect(infoPlist).not.toContain('<key>CFBundleExecutable</key>');
    expect(macBuildWorkflow).toContain("Print :NSCameraUsageDescription");
    expect(macBuildWorkflow).toContain("Print :NSMicrophoneUsageDescription");
    expect(macBuildWorkflow).toContain('CFBundleShortVersionString');
  });

  it('tracks the replacement backend after a supervised restart', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'launcher.ts'), 'utf8');
    expect(launcher).toContain('currentChild = restartServer()');
    expect(launcher).toContain('scheduleServerRestart(500)');
    expect(launcher).toContain('scheduleServerRestart(delay)');
    expect(launcher).not.toContain('setTimeout(() => restartServer()');
  });

  it('keeps the CommonJS Lark SDK outside the ESM server bundle and packages it', () => {
    const buildScript = fs.readFileSync(path.join(process.cwd(), 'scripts/build-server.mjs'), 'utf8');
    const resourceScript = fs.readFileSync(path.join(process.cwd(), 'scripts/prepare-desktop-resources.mjs'), 'utf8');
    const packagedSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts/smoke-packaged-first-run.mjs'), 'utf8');

    expect(buildScript).toContain("'@larksuiteoapi/node-sdk'");
    expect(resourceScript).toContain("'@larksuiteoapi/node-sdk'");
    expect(packagedSmoke).toContain("'packaged Lark SDK'");
  });
});
