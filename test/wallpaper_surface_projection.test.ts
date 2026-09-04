import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Wallpaper surface projection', () => {
  it('captures the surface used to enter Wallpaper and reports it to LumiCore', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const selfModel = source('server/client/self_model.ts');

    const service = source('src/services/systemService.ts');
    expect(service).toContain("export type WallpaperWorkspace = 'personal' | 'command-center' | 'organization'");
    expect(desktop).toContain("if (activeTab === 'org') return 'organization'");
    expect(desktop).toContain('|| knowledgeOpen');
    expect(desktop).toContain("|| activeTab === 'command-center'");
    expect(desktop).toContain('const [wallpaperWorkspace, setWallpaperWorkspace]');
    expect(desktop).toContain('if (currentWorkspace !== wallpaperWorkspaceRef.current)');
    expect(desktop).toContain('data-wallpaper-workspace={isWallpaperMode ? wallpaperWorkspace : undefined}');
    expect(desktop).toContain('wallpaperWorkspace: isWallpaperMode ? wallpaperWorkspace : undefined');
    expect(selfModel).toContain("wallpaperWorkspace?: WallpaperWorkspace");
    expect(selfModel).toContain('command-center workbench must continue the same current task');
    expect(selfModel).toContain('Never load or expose personal memories');
  });

  it('wallpaperizes each existing surface instead of adding a second navigation shell', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const chat = source('src/components/AgentChatPage.tsx');
    const organization = source('src/components/org/OrgHub.tsx');
    const styles = source('src/index.css');

    expect(desktop).not.toContain('WallpaperWorkbenchFrame');
    expect(desktop).toContain('data-wallpaper-source-surface="personal"');
    expect(desktop).toContain('data-wallpaper-tool="personal-core"');
    expect(desktop).toContain('data-wallpaper-tool="organization-portal"');
    expect(chat).toContain('data-wallpaper-tool="command-history"');
    expect(chat).toContain("data-wallpaper-tool={isOfficeCommandCenter ? 'command-dialogue' : undefined}");
    expect(chat).toContain('data-wallpaper-tool="command-tools"');
    expect(organization).toContain('data-wallpaper-tool="organization-navigation"');
    expect(organization).toContain('data-wallpaper-tool="organization-workspace"');
    expect(styles).toContain('Wallpaper is a transparent presentation of the surface it was entered');
    expect(styles).toContain('[data-wallpaper-workspace="command-center"] .lumi-chat-root');
    expect(styles).toContain('[data-wallpaper-workspace="organization"] .lumi-organization-fullscreen-surface');
    expect(styles).toContain('background: transparent !important');
    expect(styles).toContain('html[data-mode="light"] [data-wallpaper-presentation="workbench"][data-wallpaper-workspace="command-center"] .lumi-chat-root.lumi-work-surface');
  });

  it('keeps the user presentation interactive and reserves click-through for desktop control', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const service = source('src/services/systemService.ts');
    const rust = source('src-tauri/src/lib.rs');
    const socket = source('src/hooks/useSocket.ts');

    expect(service).toContain("export type WallpaperPresentation = 'workbench' | 'desktop-control'");
    expect(desktop).toContain("applyWallpaperMode(!isWallpaperMode, { presentation: 'workbench' })");
    expect(desktop).toContain("isWallpaperDesktopControl ? 'pointer-events-none' : ''");
    expect(desktop).toContain('data-wallpaper-exit');
    expect(socket).toContain("presentation: 'desktop-control'");
    expect(rust).toContain('WallpaperPresentation::Workbench => {');
    expect(rust).toContain('.set_ignore_cursor_events(false)');
    expect(rust).toContain('WallpaperPresentation::DesktopControl => {');
    expect(rust).toContain('.set_ignore_cursor_events(true)');
    expect(socket).toContain('const state = await dispatchWallpaperModeAction({');
    expect(socket).toContain('verified: true');
  });
});
