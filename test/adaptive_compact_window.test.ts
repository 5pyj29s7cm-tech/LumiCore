import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('adaptive compact client window', () => {
  it('allows the normal Tauri client to shrink to the supported responsive floor', () => {
    for (const configPath of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.automation.conf.json']) {
      const config = JSON.parse(source(configPath));
      const mainWindow = config.app.windows[0];
      expect(mainWindow.minWidth).toBe(520);
      expect(mainWindow.minHeight).toBe(460);
      expect(mainWindow.resizable).toBe(true);
    }
  });

  it('runs the compiled compact-layout gate for every normal Tauri build', () => {
    const config = JSON.parse(source('src-tauri/tauri.conf.json'));
    expect(config.build.beforeBuildCommand).toBe('npm run build:desktop');
  });

  it('uses a DPI-aware native compact-window toggle with durable restore state', () => {
    const rust = source('src-tauri/src/lib.rs');

    expect(rust).toContain('struct CompactWindowState');
    expect(rust).toContain('fn compact_window_metrics');
    expect(rust).toContain('monitor.scale_factor().max(0.1)');
    expect(rust).toContain('let work_area = monitor.work_area()');
    expect(rust).toContain('set_size(tauri::LogicalSize::new(width as f64, height as f64))');
    expect(rust).toContain('fn toggle_compact_window_mode');
    expect(rust).toContain('fn exit_compact_window_mode');
    expect(rust).toContain('.manage(Mutex::new(CompactWindowState::default()))');
  });

  it('keeps the desktop widget control and places compact-window toggle on the maximize control', () => {
    const desktop = source('src/components/DesktopUI.tsx');

    expect(desktop).toContain('onClick={() => void enterDesktopWidgetMode()}');
    expect(desktop).toContain("invoke<{ enabled?: boolean }>('toggle_compact_window_mode')");
    expect(desktop).toContain("await invoke('minimize_window')");
    expect(desktop).toContain("await invoke('close_window')");
    expect(desktop).not.toContain("await invoke('toggle_maximize_window')");
    expect(desktop).toContain('data-tauri-drag-region');
    expect(desktop).toContain('getCurrentWindow().startDragging()');
    expect(desktop).toContain('onPointerDown={(event) => void handleTopbarPointerDown(event)}');
    expect(desktop).toContain('data-compact-layout={isCompactDesktopLayout');
    expect(desktop).toContain('data-ui-density={desktopChrome.density}');
    expect(desktop).toContain('getDesktopDockPositionClassName(isCompactDesktopLayout)');
    expect(desktop).toContain('<Square size={12} />');
    expect(desktop).toContain("isWallpaperMode || chatOpen || knowledgeOpen || activeTab === 'org'");
    expect(desktop).toContain('aria-pressed={isCompactWindowMode}');
  });

  it('keeps core full-surface views below the shared title bar and responsive at mini density', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const chat = source('src/components/AgentChatPage.tsx');
    const knowledge = source('src/components/KnowledgeBase.tsx');
    const org = source('src/components/org/OrgHub.tsx');
    const css = source('src/index.css');

    expect(desktop).toContain('lumi-below-topbar fixed inset-x-0 bottom-0 z-[90] bg-celestial-deep');
    expect(chat).toContain('lumi-chat-root lumi-below-topbar');
    expect(chat).toContain('hidden w-80 flex-shrink-0');
    expect(knowledge).toContain('lumi-below-topbar fixed inset-x-0 bottom-0 z-[90]');
    expect(org).toContain('lumi-org-sidebar');
    expect(desktop).toContain('lumi-desktop-widget-rail');
    expect(css).toContain('[data-compact-layout="true"] .lumi-desktop-widget-rail');
    expect(css).toContain('grid-template-columns: 350px minmax(0, 1fr) 320px');
    expect(css).toContain('max-height: calc(100vh - 116px)');
    expect(css).not.toMatch(/\[data-compact-layout="true"\] \.lumi-desktop-widget-rail \{\s*display: none/);
    expect(css).toContain('[data-compact-layout="true"] .lumi-core-stage');
    expect(css).toMatch(/\[data-compact-layout="true"\] \.lumi-core-secondary \{[\s\S]*?display: flex/);
    expect(css).toContain('[data-compact-layout="true"] .lumi-dock');
    expect(css).toContain('justify-content: safe center');
    expect(css).not.toContain('translate: none !important');
    expect(css).not.toContain('min-height: calc(200vh - 116px)');
    expect(css).not.toContain('margin-top: calc(100vh - 250px)');
    expect(css).toContain('grid-template-columns: 260px minmax(0, 1fr) 280px');
    expect(css).toContain('grid-template-rows: minmax(360px, calc(100dvh - 110px)) auto');
    expect(css).toContain('[data-ui-density="mini"] .lumi-shell-topbar');
    expect(css).toContain('.lumi-shell-topbar-center');
    expect(css).toContain('.lumi-shell-window-controls');
    expect(css).toContain('@media (max-width: 820px), (max-height: 700px)');
  });
});
