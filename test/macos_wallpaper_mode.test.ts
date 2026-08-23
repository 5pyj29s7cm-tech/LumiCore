import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => fs
  .readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

describe('macOS wallpaper mode recovery', () => {
  it('enables the native transparent-window capability required by macOS', () => {
    const config = JSON.parse(source('src-tauri/tauri.conf.json'));
    expect(config.app.macOSPrivateApi).toBe(true);
    expect(config.app.windows[0].transparent).toBe(true);
  });

  it('keeps native recovery paths available while the main window is click-through', () => {
    const rust = source('src-tauri/src/lib.rs');
    expect(rust).toContain('#[cfg(target_os = "macos")]\n        let _ = window.set_skip_taskbar(false);');
    expect(rust).toContain('"Exit Wallpaper Mode"');
    expect(rust).toContain('tauri::RunEvent::Reopen { .. }');
    expect(rust).toContain('show_main_window_impl(app, "macos_reopen");');
    expect(rust).toContain('tauri_plugin_single_instance::init(|app, _args, _cwd|');
    expect(rust).toContain('show_main_window_impl(app, "single_instance");');
    expect(rust).toContain('"lumi:wallpaper-mode-changed"');
    expect(rust).toContain('get_wallpaper_mode');
  });

  it('synchronizes native restoration and keeps the visible label in English', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const service = source('src/services/systemService.ts');
    const messages = JSON.parse(source('src/i18n/locales/ui.generated.json'));

    expect(service).toContain("invoke<WallpaperModeState>('get_wallpaper_mode')");
    expect(desktop).toContain("listen<{ enabled?: boolean }>('lumi:wallpaper-mode-changed'");
    expect(desktop).toContain("isWallpaperMode ? 'Fusion' : 'Wallpaper'");
    expect(messages['desktop-ui.wallpaper.b2aa8da019'].zh).toBe('Wallpaper');
  });
});
