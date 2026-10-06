import { useClientSurfaceActions, normalizeDesktopSurfaceTarget as normalizeTarget } from "../useClientSurfaceActions";
import { useEffect, useCallback } from "react";
import { sounds } from "../../../services/soundService";
import { toast } from "sonner";
import type { PetConfig } from "../../../pets/types";
import { systemService } from "@/services/systemService";
import { CLIENT_SETTINGS_SECTIONS, PERSONAL_CLIENT_LAUNCHER_IDS, PERSONAL_CLIENT_SURFACES, PERSONAL_CLIENT_SURFACE_ACTIONS, getOpenPersonalClientSurfaceIds } from "../../../../shared/client_surfaces";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import { desktopWorkflowCopy } from "../../../i18n/locales/desktopWorkflows";
import type { useDesktopNotificationsAndShortcuts } from './use_desktop_notifications_and_shortcuts';
import type { SurfaceReturnTarget } from './shared';

export function useDesktopSurfaceControls(previousBindings: ReturnType<typeof useDesktopNotificationsAndShortcuts>) {
  const { canCustomizeLumiAppearance, lang, setSelectedPet, savePetPrefsToServer, equippedAccessories, t, setIsNotificationPanelOpen, windowCommand, setPersonalizationSection, openKnowledgeBase, openCommandCenter, openMemoryAvatar, inferSurfaceReturnTarget, dismissUtilitySurfaces, surfaceReturnTargetRef, setIsSearchOpen, setViewMode, setActiveTab, setNexusReturnTarget, knowledgeOpen, closeKnowledgeBase, closeMemoryAvatar, nexusReturnTarget, activeTab, desktopWidgetFallbackRef, setIsDesktopWidgetMode, isTauri, isWallpaperModeRef, chatOpen, wallpaperPresentationRef, applyWallpaperMode, endMeetingAndReport, isDesktopWidgetMode, openWindows, operationMode, orgConnection, resetMeetingCapture, setOperationMode, switchDomain, workDomain, setMeetingPaused, setMeetingNotesOpen, setLegalMeetingCaseTitle, setSettingsSection, socket, callError, clientRuntime, viewMode, focusedWindow, settingsSection, isSearchOpen, memoryLabOpen, sanctuaryOpen, commandCenterView, isNotificationPanelOpen, meetingNotesOpen, isWallpaperMode, organizationWorkspaceView, clientPermissions, availableOrganizationWorkspaceViews, reportedKnowledgeRuntimeState, minimizedWindows, wallpaperPresentation, wallpaperWorkspace, callState, isMuted, meetingPaused, meetingNotes, meetingReport, meetingStartedAt, meetingReportGenerating, agentStatus, mcpActivities } = previousBindings;


  const handleSelectPet = (pet: PetConfig) => {
    if (!canCustomizeLumiAppearance) {
      toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    setSelectedPet(pet);
    savePetPrefsToServer(pet, equippedAccessories);
    toast.info(`${pet.name} ${t.avatarSetAsDesktop || 'set as desktop avatar'}`);
  };

  const setNotificationSurface = useCallback((open?: boolean) => {
    setIsNotificationPanelOpen(previous => open ?? !previous);
    windowCommand('remove', 'notifications');
  }, [setIsNotificationPanelOpen, windowCommand]);

  const openSurface = useCallback((value: string, returnTarget?: SurfaceReturnTarget) => {
    if (value === 'avatar-studio') setPersonalizationSection('appearance');
    if (value === 'sound') setPersonalizationSection('voice');
    const windowId = normalizeTarget(value);
    if (!windowId) throw new Error('Client action requires a target surface');
    if (windowId === 'knowledge') { openKnowledgeBase(returnTarget); return; }
    if (windowId === 'command-center') { openCommandCenter('office'); return; }
    if (windowId === 'memory-avatar') { void openMemoryAvatar(undefined, returnTarget); return; }

    const nexusOrigin = windowId === 'nexus' ? returnTarget || inferSurfaceReturnTarget() : 'home';
    dismissUtilitySurfaces();
    surfaceReturnTargetRef.current = 'home';
    setIsSearchOpen(windowId === 'app-launcher');
    setViewMode(windowId === 'nexus' ? 'world' : 'personal');
    if (windowId === 'home') {
      windowCommand('reset');
      setIsNotificationPanelOpen(false);
      setActiveTab('home');
      return;
    }
    if (windowId === 'nexus') { setNexusReturnTarget(nexusOrigin); setActiveTab('home'); return; }
    if (windowId === 'app-launcher') return;
    if (windowId === 'org') { setActiveTab('org'); return; }
    if (windowId === 'notifications') { setNotificationSurface(true); return; }
    windowCommand('open', windowId);
    setActiveTab(windowId);
  }, [dismissUtilitySurfaces, inferSurfaceReturnTarget, openCommandCenter, openKnowledgeBase, openMemoryAvatar, setActiveTab, setIsNotificationPanelOpen, setIsSearchOpen, setNexusReturnTarget, setNotificationSurface, setPersonalizationSection, setViewMode, surfaceReturnTargetRef, windowCommand]);

  const toggleWindow = useCallback((tab: string) => {
    try { sounds.playClick(); } catch {}
    if (tab === 'notifications') { setNotificationSurface(); return; }
    if (tab === 'knowledge' && knowledgeOpen) { closeKnowledgeBase(); return; }
    openSurface(tab);
  }, [closeKnowledgeBase, knowledgeOpen, openSurface, setNotificationSurface]);

  const closeWindow = useCallback((tab: string) => {
    try { sounds.playClick(); } catch {}
    if (windowCommand('close', tab)) setActiveTab('home');
  }, [setActiveTab, windowCommand]);

  const focusOsWindow = useCallback((tab: string) => { windowCommand('focus', tab); }, [windowCommand]);

  const closeSurface = useCallback((value: string) => {
    const windowId = normalizeTarget(value);
    if (!windowId) throw new Error('close_client_surface requires target');
    if (windowId === 'knowledge') {
      closeKnowledgeBase();
      return;
    }
    if (windowId === 'command-center') {
      surfaceReturnTargetRef.current = 'home';
      dismissUtilitySurfaces();
      setActiveTab('home');
      return;
    }
    if (windowId === 'memory-avatar') {
      closeMemoryAvatar();
      return;
    }
    if (windowId === 'nexus') {
      setNexusReturnTarget('home');
      setViewMode('personal');
      if (nexusReturnTarget === 'command-center') openCommandCenter('office');
      return;
    }
    if (windowId === 'app-launcher') {
      surfaceReturnTargetRef.current = 'home';
      setIsSearchOpen(false);
      return;
    }
    if (windowId === 'notifications') {
      surfaceReturnTargetRef.current = 'home';
      setIsNotificationPanelOpen(false);
      return;
    }
    if (windowId === 'org' && activeTab === 'org') {
      surfaceReturnTargetRef.current = 'home';
      setActiveTab('home');
      return;
    }
    closeWindow(windowId);
  }, [activeTab, closeKnowledgeBase, closeMemoryAvatar, closeWindow, dismissUtilitySurfaces, nexusReturnTarget, openCommandCenter, setActiveTab, setIsNotificationPanelOpen, setIsSearchOpen, setNexusReturnTarget, setViewMode, surfaceReturnTargetRef]);

  const minimizeOsWindow = useCallback((tab: string) => { windowCommand('minimize', tab); }, [windowCommand]);

  const applyDesktopWidgetFallback = useCallback(async () => {
    const windowApi = await import('@tauri-apps/api/window');
    const appWindow = windowApi.getCurrentWindow();

    if (!desktopWidgetFallbackRef.current?.active) {
      const [size, position, fullscreen, maximized] = await Promise.all([
        appWindow.outerSize().catch(() => undefined),
        appWindow.outerPosition().catch(() => undefined),
        appWindow.isFullscreen().catch(() => false),
        appWindow.isMaximized().catch(() => false),
      ]);
      desktopWidgetFallbackRef.current = {
        active: true,
        size: size ? { width: size.width, height: size.height } : undefined,
        position: position ? { x: position.x, y: position.y } : undefined,
        fullscreen,
        maximized,
      };
    }

    const widgetWidth = 240;
    const widgetHeight = 285;
    const margin = 18;
    const currentMonitor = await windowApi.currentMonitor().catch(() => null);
    const primaryMonitor = currentMonitor || await windowApi.primaryMonitor().catch(() => null);
    const scaleFactor = primaryMonitor?.scaleFactor || window.devicePixelRatio || 1;
    const workArea = primaryMonitor?.workArea;
    const monitorPosition = workArea?.position || primaryMonitor?.position;
    const monitorSize = workArea?.size || primaryMonitor?.size;
    const physicalWidth = widgetWidth * scaleFactor;
    const physicalHeight = widgetHeight * scaleFactor;
    const fallbackLeft = Number((window.screen as any).availLeft || 0);
    const fallbackTop = Number((window.screen as any).availTop || 0);
    const fallbackWidth = Number(window.screen.availWidth || widgetWidth);
    const fallbackHeight = Number(window.screen.availHeight || widgetHeight);
    const physicalX = monitorPosition && monitorSize
      ? monitorPosition.x + monitorSize.width - physicalWidth - margin * scaleFactor
      : (fallbackLeft + fallbackWidth - widgetWidth - margin) * scaleFactor;
    const physicalY = monitorPosition && monitorSize
      ? monitorPosition.y + monitorSize.height - physicalHeight - margin * scaleFactor
      : (fallbackTop + fallbackHeight - widgetHeight - margin) * scaleFactor;

    await appWindow.show().catch(() => {});
    await appWindow.setFullscreen(false).catch(() => {});
    await appWindow.unmaximize().catch(() => {});
    await appWindow.setMinSize(new windowApi.LogicalSize(210, 250)).catch(() => {});
    await appWindow.setResizable(false).catch(() => {});
    await appWindow.setDecorations(false).catch(() => {});
    await appWindow.setShadow(false).catch(() => {});
    await appWindow.setSkipTaskbar(true).catch(() => {});
    await appWindow.setAlwaysOnTop(true).catch(() => {});
    await appWindow.setSize(new windowApi.LogicalSize(widgetWidth, widgetHeight));
    await appWindow.setPosition(new windowApi.PhysicalPosition(Math.round(physicalX), Math.round(physicalY)));
    await appWindow.setFocus().catch(() => {});
  }, [desktopWidgetFallbackRef]);

  const restoreDesktopWidgetFallback = useCallback(async () => {
    const fallback = desktopWidgetFallbackRef.current;
    desktopWidgetFallbackRef.current = null;
    const windowApi = await import('@tauri-apps/api/window');
    const appWindow = windowApi.getCurrentWindow();

    await appWindow.show().catch(() => {});
    await appWindow.setSkipTaskbar(false).catch(() => {});
    await appWindow.setShadow(false).catch(() => {});
    await appWindow.setResizable(true).catch(() => {});
    await appWindow.setDecorations(false).catch(() => {});
    await appWindow.setMinSize(new windowApi.LogicalSize(960, 640)).catch(() => {});

    if (fallback?.fullscreen) {
      await appWindow.setFullscreen(true).catch(() => {});
    } else {
      await appWindow.setFullscreen(false).catch(() => {});
      if (fallback?.size) {
        await appWindow.setSize(new windowApi.PhysicalSize(fallback.size.width, fallback.size.height)).catch(() => {});
      } else {
        await appWindow.setSize(new windowApi.LogicalSize(1280, 820)).catch(() => {});
      }
      if (fallback?.position) {
        await appWindow.setPosition(new windowApi.PhysicalPosition(fallback.position.x, fallback.position.y)).catch(() => {});
      }
      if (fallback?.maximized) {
        await appWindow.maximize().catch(() => {});
      }
    }
    await appWindow.setFocus().catch(() => {});
  }, [desktopWidgetFallbackRef]);

  const enterDesktopWidgetMode = useCallback(async () => {
    try { sounds.playClick(); } catch {}
    surfaceReturnTargetRef.current = 'home';
    setIsNotificationPanelOpen(false);
    setIsSearchOpen(false);
    dismissUtilitySurfaces();
    windowCommand('reset');
    setActiveTab('home');
    setIsDesktopWidgetMode(true);
    if (isTauri) {
      let nativeError: any = null;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('enter_desktop_widget_mode');
        desktopWidgetFallbackRef.current = null;
        return;
      } catch (err: any) {
        nativeError = err;
      }
      try {
        await applyDesktopWidgetFallback();
      } catch (fallbackErr: any) {
        setIsDesktopWidgetMode(false);
        const nativeMessage = nativeError?.message || String(nativeError || '');
        const fallbackMessage = fallbackErr?.message || String(fallbackErr || '');
        toast.error(
          formatUiMessage('desktop-ui.failed-to-enter-widget-mode.65fdcea9fd', { value0: fallbackMessage || nativeMessage || desktopWorkflowCopy(lang).common.windowControlFailed }, (lang === 'zh') ? 'zh' : 'en')
        );
      }
    }
  }, [applyDesktopWidgetFallback, desktopWidgetFallbackRef, dismissUtilitySurfaces, isTauri, lang, setActiveTab, setIsDesktopWidgetMode, setIsNotificationPanelOpen, setIsSearchOpen, surfaceReturnTargetRef, windowCommand]);

  const exitDesktopWidgetMode = useCallback(async (nextSurface?: string) => {
    try { sounds.playClick(); } catch {}
    setIsDesktopWidgetMode(false);
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('exit_desktop_widget_mode');
        desktopWidgetFallbackRef.current = null;
      } catch (err: any) {
        try {
          await restoreDesktopWidgetFallback();
        } catch (fallbackErr: any) {
          toast.error(fallbackErr?.message || err?.message || (uiMessage('desktop-ui.failed-to-expand-lumi.3f04f30125', (lang === 'zh') ? 'zh' : 'en')));
        }
      }
      // Native and fallback widget exit both restore ordinary window flags.
      // Re-apply Command Center / controlled desktop overlay stacking. The
      // user-facing workbench intentionally keeps ordinary window stacking.
      await systemService.setAlwaysOnTop(
        (!isWallpaperModeRef.current && chatOpen)
          || (isWallpaperModeRef.current && wallpaperPresentationRef.current === 'desktop-control'),
      ).catch(() => {});
    }
    if (nextSurface) {
      window.setTimeout(() => toggleWindow(nextSurface), 120);
    }
  }, [chatOpen, desktopWidgetFallbackRef, isTauri, isWallpaperModeRef, lang, restoreDesktopWidgetFallback, setIsDesktopWidgetMode, toggleWindow, wallpaperPresentationRef]);

  const hideDesktopWidgetMode = async () => {
    try { sounds.playClick(); } catch {}
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('hide_to_background');
        return;
      } catch {}
    }
    setIsDesktopWidgetMode(false);
  };

  useClientSurfaceActions({
    activeTab, applyWallpaperMode, closeSurface, endMeetingAndReport, enterDesktopWidgetMode, exitDesktopWidgetMode, isDesktopWidgetMode, openCommandCenter, openSurface, openWindows, operationMode, orgConnection, resetMeetingCapture, setOperationMode, switchDomain, workDomain, setMeetingPaused, setMeetingNotesOpen, setLegalMeetingCaseTitle, setSettingsSection, setPersonalizationSection
  });

  useEffect(() => {
    if (!socket) return;
    const sendState = () => {
      const recentErrors = [
        callError ? { source: 'voice', message: callError, at: Date.now() } : null,
        clientRuntime.lastError ? { source: 'runtime', message: clientRuntime.lastError, at: Date.now() } : null,
      ].filter(Boolean);
      const openSurfaceIds = getOpenPersonalClientSurfaceIds({
        activeTab,
        viewMode,
        workDomain,
        focusedWindow,
        openWindows,
        settingsSection,
        appLauncherOpen: isSearchOpen,
        knowledgeOpen,
        chatOpen,
        commandCenterOpen: chatOpen || knowledgeOpen || memoryLabOpen || sanctuaryOpen,
        commandCenterView,
        notificationsOpen: isNotificationPanelOpen,
        memoryAvatarOpen: memoryLabOpen || sanctuaryOpen,
        meetingOpen: meetingNotesOpen || operationMode === 'meeting',
        wallpaperMode: isWallpaperMode,
        widgetMode: isDesktopWidgetMode,
        organizationWorkspaceVisible: activeTab === 'org' && workDomain === 'work' && Boolean(orgConnection?.connected),
        organizationWorkspaceView,
      });

      socket.emit('client:state', {
        platform: String(clientPermissions.native_platform || (isTauri ? 'desktop' : 'web')),
        mode: operationMode,
        activeTab,
        viewMode,
        workDomain,
        org: {
          connected: Boolean(orgConnection?.connected),
          id: orgConnection?.orgId || '',
          name: orgConnection?.orgName || '',
          role: orgConnection?.orgRole || '',
        },
        orgWorkspace: {
          activeView: workDomain === 'work' && orgConnection?.connected ? organizationWorkspaceView : '',
          availableViews: availableOrganizationWorkspaceViews,
          visible: activeTab === 'org' && workDomain === 'work' && Boolean(orgConnection?.connected),
        },
        knowledge: reportedKnowledgeRuntimeState,
        settings: {
          activeSection: settingsSection,
        },
        uiManifest: {
          surfaceIds: PERSONAL_CLIENT_SURFACES.map(surface => surface.id),
          actions: PERSONAL_CLIENT_SURFACE_ACTIONS,
          settingsSections: CLIENT_SETTINGS_SECTIONS.map(section => section.id),
          launcherIds: PERSONAL_CLIENT_LAUNCHER_IDS,
        },
        windows: {
          open: openWindows,
          focused: focusedWindow,
          minimized: minimizedWindows,
        },
        surfaces: {
          appLauncherOpen: isSearchOpen,
          knowledgeOpen,
          chatOpen,
          commandCenterOpen: chatOpen || knowledgeOpen || memoryLabOpen || sanctuaryOpen,
          commandCenterView,
          notificationsOpen: isNotificationPanelOpen,
          memoryAvatarOpen: memoryLabOpen || sanctuaryOpen,
          runtimeLogOpen: openWindows.includes('kernel'),
          meetingOpen: meetingNotesOpen,
          wallpaperMode: isWallpaperMode,
          wallpaperPresentation: isWallpaperMode ? wallpaperPresentation : undefined,
          wallpaperWorkspace: isWallpaperMode ? wallpaperWorkspace : undefined,
          widgetMode: isDesktopWidgetMode,
          nexusOpen: viewMode === 'world',
          openSurfaceIds,
        },
        voice: {
          state: callState,
          muted: isMuted,
        },
        meeting: {
          active: operationMode === 'meeting',
          paused: meetingPaused,
          noteCount: meetingNotes.length,
          hasReport: Boolean(meetingReport),
          startedAt: meetingStartedAt,
          reportGenerating: meetingReportGenerating,
        },
        runtimeLog: {
          open: openWindows.includes('kernel'),
          status: clientRuntime.lastError ? 'attention' : 'ready',
          lastError: clientRuntime.lastError || '',
        },
        permissions: clientPermissions,
        tools: {
          agentStatus,
          mcpActivityCount: mcpActivities.length,
        },
        runtime: clientRuntime,
        errors: recentErrors,
      });
    };
    sendState();
    const interval = setInterval(sendState, 10000);
    window.addEventListener('lumi:client-state-refresh', sendState);
    return () => {
      clearInterval(interval);
      window.removeEventListener('lumi:client-state-refresh', sendState);
    };
  }, [
    activeTab,
    availableOrganizationWorkspaceViews,
    callState,
    chatOpen,
    commandCenterView,
    clientPermissions,
    clientRuntime,
    callError,
    focusedWindow,
    agentStatus,
    isMuted,
    isTauri,
    isDesktopWidgetMode,
    isNotificationPanelOpen,
    isSearchOpen,
    isWallpaperMode,
    wallpaperPresentation,
    wallpaperWorkspace,
    knowledgeOpen,
    memoryLabOpen,
    mcpActivities.length,
    meetingNotes.length,
    meetingNotesOpen,
    meetingPaused,
    meetingReport,
    meetingReportGenerating,
    meetingStartedAt,
    minimizedWindows,
    openWindows,
    operationMode,
    orgConnection?.connected,
    orgConnection?.orgId,
    orgConnection?.orgName,
    orgConnection?.orgRole,
    organizationWorkspaceView,
    reportedKnowledgeRuntimeState,
    sanctuaryOpen,
    socket,
    settingsSection,
    viewMode,
    workDomain,
  ]);
  return {
    ...previousBindings, exitDesktopWidgetMode, hideDesktopWidgetMode, toggleWindow, openSurface, closeSurface, enterDesktopWidgetMode, focusOsWindow,
    minimizeOsWindow, closeWindow, handleSelectPet
  } as const;
}
