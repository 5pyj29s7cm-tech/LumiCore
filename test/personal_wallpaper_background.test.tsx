// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/components/ClientSurface', () => ({ ClientSurface: () => null }));
vi.mock('../src/components/desktop/shell_chrome_view', () => ({ renderShellChrome: () => null }));
vi.mock('../src/components/desktop/core_stage_view', () => ({ renderDesktopCoreStage: () => null }));
vi.mock('../src/components/desktop/desktop_grid_view', () => ({ renderDesktopGrid: () => null }));
vi.mock('../src/components/desktop/meeting_workspace_view', () => ({ renderMeetingWorkspace: () => null }));
vi.mock('../src/components/desktop/desktop_windows_view', () => ({ renderDesktopWindows: () => null }));
vi.mock('../src/components/desktop/DesktopModeSwitch', () => ({ DesktopModeSwitch: () => null }));
vi.mock('../src/components/desktop/surface_components', () => ({ OrgPortal: () => null }));
vi.mock('../src/components/KnowledgeBaseEntry', () => ({ KnowledgeBaseEntry: () => null }));
vi.mock('../src/components/DesktopShellAuxiliary', () => ({ DayInkLandscape: () => null }));
vi.mock('../src/components/CursorGlow', () => ({ CursorGlow: () => null }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: { div: ({ children }: any) => <div>{children}</div>, button: ({ children }: any) => <button>{children}</button> },
}));
import { DesktopShellView, type DesktopShellViewInput } from '../src/components/desktop/DesktopShellView';

afterEach(cleanup);
function input(appearance: 'light' | 'dark', overrides: Partial<DesktopShellViewInput> = {}): DesktopShellViewInput {
  return { resolvedAppearanceMode: appearance, viewMode: 'personal', activeTab: 'home', desktopChrome: { density: 'normal' },
    isWallpaperMode: false, wallpaperPresentation: 'workbench', wallpaperWorkspace: 'personal', isWallpaperWorkbench: false,
    isWallpaperDesktopControl: false, wallpaper: 'custom', wallpaperUrl: 'https://fixture.invalid/background.jpg',
    t: {}, lang: 'en', personalScale: 1, personalOpacity: 1, openWindows: [], minimizedWindows: [],
    memoryAvatars: [], ...overrides } as unknown as DesktopShellViewInput;
}

for (const appearance of ['light', 'dark'] as const) {
  it.each(['personal', 'command-center', 'organization'] as const)(`keeps ${appearance} workbench wallpaper transparent in %s and restores the normal background`, workspace => {
    const ordinary = input(appearance, { activeTab: workspace === 'organization' ? 'org' : 'home' });
    const page = render(<DesktopShellView {...ordinary} />);
    let shell = page.container.firstElementChild as HTMLElement;
    if (workspace !== 'organization') {
      expect(shell.dataset.personalBackground).toBe(appearance === 'light' ? 'white' : 'black');
      expect(shell.style.backgroundColor).toBe(appearance === 'light' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
    }
    page.rerender(<DesktopShellView {...input(appearance, { ...ordinary, isWallpaperMode: true, isWallpaperWorkbench: true, wallpaperWorkspace: workspace })} />);
    shell = page.container.firstElementChild as HTMLElement;
    expect(shell.dataset.wallpaperPresentation).toBe('workbench');
    expect(shell.dataset.wallpaperWorkspace).toBe(workspace);
    expect(shell.hasAttribute('data-personal-background')).toBe(false);
    expect(shell.style.backgroundColor).toBe('');
    expect(shell.style.backgroundImage).toBe('');
    expect(shell.classList.contains('bg-transparent')).toBe(true);
    expect(shell.classList.contains('pointer-events-none')).toBe(false);
    page.rerender(<DesktopShellView {...ordinary} />);
    shell = page.container.firstElementChild as HTMLElement;
    expect(shell.hasAttribute('data-wallpaper-presentation')).toBe(false);
    if (workspace !== 'organization') expect(shell.dataset.personalBackground).toBe(appearance === 'light' ? 'white' : 'black');
  });
  it(`keeps ${appearance} desktop-control transparent and click-through`, () => {
    const page = render(<DesktopShellView {...input(appearance, { isWallpaperMode: true, wallpaperPresentation: 'desktop-control', isWallpaperDesktopControl: true })} />);
    const shell = page.container.firstElementChild as HTMLElement;
    expect(shell.hasAttribute('data-personal-background')).toBe(false);
    expect(shell.style.backgroundColor).toBe('');
    expect(shell.classList.contains('bg-transparent')).toBe(true);
    expect(shell.classList.contains('pointer-events-none')).toBe(true);
  });
}
