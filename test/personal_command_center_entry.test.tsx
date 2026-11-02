// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDesktopCoreStage } from '../src/components/desktop/core_stage_view';
import { renderShellChrome } from '../src/components/desktop/shell_chrome_view';
import { renderChatPanelHeader } from '../src/components/agent_chat/chat_panel_header_view';
import { DesktopModeSwitch } from '../src/components/desktop/DesktopModeSwitch';
import { setLocale } from '../src/i18n/runtime';
import { uiMessage } from '../src/i18n/uiMessages';

vi.mock('../src/components/desktop/widget', () => ({ LumiCoreAvatar: ({ onStartCall }: { onStartCall: () => void }) => <button onClick={onStartCall}>Voice call</button> }));
vi.mock('../src/components/VoicePicker', () => ({ VoicePicker: () => null }));
vi.mock('../src/components/SpriteAnimator', () => ({ PetAvatar: () => <span>Pet avatar</span> }));
vi.mock('../src/components/biometrics/PresenceIndicator', () => ({ PresenceIndicator: () => null }));
vi.mock('../src/components/DesktopShellAuxiliary', () => ({ BatteryIndicator: () => null,
  MeetingModeButton: ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>Meeting</button> }));
vi.mock('../src/components/desktop/window_shell', () => ({ LazyPanelFallback: () => null }));
vi.mock('../src/components/desktop/launcher', () => ({ Spotlight: () => null }));
vi.mock('../src/components/desktop/surface_components', () => ({ NotificationCenter: () => null }));
vi.mock('../src/components/ClientSurface', () => ({ ClientSurface: () => null }));
vi.mock('../src/components/VoiceCallButton', () => ({ VoiceCallButton: () => null }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({}) }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: { div: ({ children }: React.PropsWithChildren) => <div>{children}</div>, button: ({ children }: React.PropsWithChildren) => <button>{children}</button> } }));

afterEach(() => { cleanup(); setLocale('en'); });

describe('personal page keeps the command center as the execution-mode entry', () => {
  it.each(['sphere', 'pet'] as const)('does not show internal/external mode buttons below the personal %s', kind => {
    const setPreference = vi.fn(async () => true);
    const startVoice = vi.fn();
    const meeting = vi.fn();
    const props = {
      selectedPet: kind === 'pet' ? { id: 'fixture-pet', name: 'Fixture pet' } : null,
      callState: 'idle', t: {}, equippedAccessories: [], lang: 'en', operationMode: 'assistant',
      facePresenceRequested: false, faceRecognition: { result: { facePresent: false } },
      wakeEnabled: false, wakeWord: {}, resolvedAppearanceMode: 'dark',
      desktopExecutionPreference: 'external', setDesktopExecutionPreference: setPreference,
      startStandardVoiceCall: startVoice, openMeetingModeWithConfirm: meeting,
    } as unknown as Parameters<typeof renderDesktopCoreStage>[0];
    render(renderDesktopCoreStage(props));
    expect(screen.queryByRole('button', { name: 'Internal mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'External mode' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Application mode' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting' }));
    expect(meeting).toHaveBeenCalledOnce();
    if (kind === 'sphere') {
      fireEvent.click(screen.getByRole('button', { name: 'Voice call' }));
      expect(startVoice).toHaveBeenCalledOnce();
    }
    expect(setPreference).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh'] as const)('keeps the real personal topbar command-center button and its original action in %s', lang => {
    setLocale(lang);
    const openCommandCenter = vi.fn();
    const switchDomain = vi.fn();
    const openSurface = vi.fn();
    const props = { viewMode: 'personal', isWallpaperMode: false, t: {}, tutorialLabel: 'Help',
      workDomain: 'personal', orgConnection: null, activeTab: 'home', openCommandCenter, switchDomain, openSurface,
      lang, time: new Date('2026-11-02T00:00:00Z'), unreadCount: 0, dockApps: [], openWindows: [], minimizedWindows: [],
      resolvedAppearanceMode: 'dark', isSearchOpen: false, isNotificationPanelOpen: false,
    } as unknown as Parameters<typeof renderShellChrome>[0];
    const page = render(renderShellChrome(props));
    const button = screen.getByRole('button', { name: uiMessage('command-center.open.9d87f7d2c1', lang) });
    expect(button.textContent).toContain(lang === 'zh' ? '指挥中心' : 'Lumi Command');
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    expect(page.container.querySelector('[data-desktop-mode-switch]')).toBeNull();
    fireEvent.click(button);
    expect(openCommandCenter).toHaveBeenCalledExactlyOnceWith('office');
    expect(switchDomain).not.toHaveBeenCalled();
    expect(openSurface).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh'] as const)('keeps acknowledged mode selection in the real command-center header in %s', async lang => {
    const setPreference = vi.fn(async () => true);
    const props = { isOfficeCommandCenter: true, operationModeMeta: {}, agentName: 'Fixture', agentCategory: 'Assistant',
      OperationModeIcon: () => null, activeDomainLabel: 'Personal', knowledgeFiles: [], voices: [],
      callState: 'idle', activeDomain: 'personal', commandCenterPlannerText: {},
      desktopModeControl: <DesktopModeSwitch preference="external" setPreference={setPreference} lang={lang} appearance="dark" />,
    } as unknown as Parameters<typeof renderChatPanelHeader>[0];
    render(renderChatPanelHeader(props));
    const internal = screen.getByRole('button', { name: lang === 'zh' ? '内部模式' : 'Internal mode' });
    const external = screen.getByRole('button', { name: lang === 'zh' ? '外部模式' : 'External mode' });
    expect(external.getAttribute('aria-pressed')).toBe('true');
    expect(internal.getAttribute('aria-pressed')).toBe('false');
    expect(setPreference).not.toHaveBeenCalled();
    fireEvent.click(internal);
    await waitFor(() => expect(setPreference).toHaveBeenCalledExactlyOnceWith('internal'));
    expect(external.getAttribute('aria-pressed')).toBe('true');
  });
});
