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
    expect(rust).toMatch(/#\[cfg\(target_os = "macos"\)\]\n\s+let _ = window\.set_skip_taskbar\(false\);/);
    expect(rust).toContain('"Exit Wallpaper Mode"');
    expect(rust).toContain('tauri::RunEvent::Reopen { .. }');
    expect(rust).toContain('show_main_window_impl(app, "macos_reopen");');
    expect(rust).toContain('tauri_plugin_single_instance::init(|app, _args, _cwd|');
    expect(rust).toContain('show_main_window_impl(app, "single_instance");');
    expect(rust).toContain('"lumi:wallpaper-mode-changed"');
    expect(rust).toContain('get_wallpaper_mode');
  });

  it('separates the interactive workbench from desktop-control click-through', () => {
    const rust = source('src-tauri/src/lib.rs');
    const service = source('src/services/systemService.ts');

    expect(service).toContain("export type WallpaperPresentation = 'workbench' | 'desktop-control'");
    expect(service).toContain("export type WallpaperWorkspace = 'personal' | 'command-center' | 'organization'");
    expect(service).toContain("presentation: WallpaperPresentation = 'workbench'");
    expect(service).toContain('document.documentElement.dataset.wallpaperPresentation = presentation');
    expect(service).toContain('delete document.documentElement.dataset.wallpaperPresentation');
    expect(service).toContain("invoke<WallpaperModeState | null>('set_wallpaper_mode', {");

    expect(rust).toContain('#[serde(rename_all = "kebab-case")]');
    expect(rust).toContain('WallpaperPresentation::Workbench => {');
    expect(rust).toContain('WallpaperPresentation::DesktopControl => {');
    expect(rust).toContain('.set_fullscreen(true)');
    expect(rust).toContain('.set_ignore_cursor_events(true)');
    expect(rust).toContain('.set_ignore_cursor_events(false)');
    expect(rust).toContain('apply_wallpaper_mode(false, None, None, wallpaper_state.inner(), &window)');
    expect(rust).toContain('workspace: WallpaperWorkspace');
  });

  it('synchronizes native restoration and keeps the visible label in English', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const service = source('src/services/systemService.ts');
    const messages = JSON.parse(source('src/i18n/locales/ui.generated.json'));

    expect(service).toContain("invoke<WallpaperModeState>('get_wallpaper_mode')");
    expect(desktop).toContain("}>('lumi:wallpaper-mode-changed'");
    expect(desktop).toContain('workspace?: WallpaperWorkspace;');
    expect(desktop).toContain("isWallpaperMode ? 'Fusion' : 'Wallpaper'");
    expect(messages['desktop-ui.wallpaper.b2aa8da019'].zh).toBe('Wallpaper');
  });
});
