import { useDesktopWindows } from "../useDesktopWindows";
import { useViewportSize } from "../window_shell";
import { type ClientKnowledgeRuntimeState, emptyKnowledgeRuntimeState, resolvePetPreference, serializePetPreference, type ClientPermissionSnapshot, type ClientRuntimeSnapshot } from "../runtime_state";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useMotionValue, useTransform } from "motion/react";
import { toast } from "sonner";
import type { PetConfig } from "../../../pets/types";
import { useApp } from "@/contexts/AppContext";
import type { CommandCenterView } from "../../commandCenterTypes";
import { systemService, type WallpaperPresentation, type WallpaperWorkspace } from "@/services/systemService";
import { usePlatform } from "@/hooks/usePlatform";
import { canUseExternalCapabilitiesForSurface, createExternalCapabilityExecutionCorrelation, executeExternalCapabilityAction, fetchExternalCapabilities, type ExternalCapabilityAction, type ExternalCapabilityExecutionCorrelation, type ExternalCapabilityProjection } from "@/services/externalCapabilities";
import { listOrganizationWorkspaceViewsForRole, type OrganizationWorkspaceView } from "../../../../shared/org_workspace";
import { uiMessage } from "../../../i18n/uiMessages";
import { externalCapabilityCopy } from "../../../i18n/locales/externalCapabilities";
import type { ChatAttachmentRequest } from "@/lib/chatAttachmentReferences";
import { getDesktopDockPositionClassName, getDesktopChromeMetrics, getDesktopIconLayout, shouldUseCompactDesktopLayout } from "@/lib/desktopLayout";
import type { SurfaceReturnTarget } from './shared';

export function useDesktopSurfaceState({
  t,
  user,
  lang,
  setLang,
  activeTab,
  setActiveTab,
  onLogin,
  renderTabContent
}: {
  t: any;
  user: any;
  lang: 'en' | 'zh';
  setLang: (l: 'en' | 'zh') => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onLogin: () => void;
  renderTabContent: (tab: string) => React.ReactNode;
}) {

  // Camera and Environment state
  const [viewMode, setViewMode] = useState<'personal' | 'world'>('personal');
  const [nexusReturnTarget, setNexusReturnTarget] = useState<'home' | 'command-center'>('home');
  const [syncRate, setSyncRate] = useState(1);
  const cameraZ = useMotionValue(viewMode === 'personal' ? 0 : -800);

  useEffect(() => {
    cameraZ.set(viewMode === 'personal' ? 0 : -1000);
  }, [cameraZ, viewMode]);

  // Biometrics: face recognition + voiceprint activated via useFaceRecognition / useVoiceprint

  const personalScale = useTransform(cameraZ, [0, -1000], [1, 0.4]);
  const personalOpacity = useTransform(cameraZ, [0, -400], [1, 0]);
  const { isTauri } = usePlatform();
  const { selectedVoiceId, unreadCount, notifications, addNotification, orgConnection, workDomain, switchDomain, operationMode, setOperationMode, desktopExecutionPreference, setDesktopExecutionPreference, aiConfig, resolvedAppearanceMode } = useApp();
  const petPreferenceScopeKey = workDomain === 'work'
    ? `org_${orgConnection?.orgId || 'pending'}`
    : `personal_${user?.uid || 'local'}`;
  const petStorageKeys = useMemo(() => ({
    pet: `lumi_selected_pet_${petPreferenceScopeKey}`,
    accessories: `lumi_accessories_${petPreferenceScopeKey}`,
  }), [petPreferenceScopeKey]);
  const meetingPreferenceScopeKey = workDomain === 'work'
    ? `org_${orgConnection?.orgId || 'pending'}_user_${user?.uid || 'local'}`
    : `personal_${user?.uid || 'local'}`;
  const meetingStorageKeys = useMemo(() => ({
    identity: `lumi_meeting_identity_${meetingPreferenceScopeKey}`,
    startedAt: `lumi_meeting_started_at_${meetingPreferenceScopeKey}`,
    notes: `lumi_meeting_notes_${meetingPreferenceScopeKey}`,
    report: `lumi_meeting_report_${meetingPreferenceScopeKey}`,
  }), [meetingPreferenceScopeKey]);
  const canCustomizeLumiAppearance = workDomain !== 'work'
    || ['owner', 'admin'].includes(String(orgConnection?.orgRole || ''));

  const initialCommandCenterOpen = activeTab === 'chat' || activeTab === 'command-center';
  const initialWindowId = activeTab !== 'home' && activeTab !== 'knowledge' && !initialCommandCenterOpen ? activeTab : null;
  const { openWindows, minimizedWindows, focusedWindow, command: windowCommand } = useDesktopWindows(initialWindowId);
  const [knowledgeOpen, setKnowledgeOpen] = useState(activeTab === 'knowledge');
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(activeTab === 'knowledge');
  const [organizationWorkspaceView, setOrganizationWorkspaceView] = useState<OrganizationWorkspaceView>('dashboard');
  const availableOrganizationWorkspaceViews = useMemo(
    () => listOrganizationWorkspaceViewsForRole(orgConnection?.orgRole),
    [orgConnection?.orgRole],
  );
  const [knowledgeRuntimeState, setKnowledgeRuntimeState] = useState<ClientKnowledgeRuntimeState>(() => (
    emptyKnowledgeRuntimeState(
      workDomain === 'work' ? 'work' : 'personal',
      workDomain === 'work' ? orgConnection?.orgId || '' : '',
    )
  ));
  const reportedKnowledgeRuntimeState = useMemo(() => {
    const expectedDomain = workDomain === 'work' ? 'work' : 'personal';
    const expectedOrgId = expectedDomain === 'work' ? orgConnection?.orgId || '' : '';
    if (knowledgeRuntimeState.domain === expectedDomain && knowledgeRuntimeState.orgId === expectedOrgId) {
      return knowledgeRuntimeState;
    }
    return {
      ...emptyKnowledgeRuntimeState(expectedDomain, expectedOrgId),
      lastError: 'knowledge_inventory_refreshing',
    };
  }, [knowledgeRuntimeState, orgConnection?.orgId, workDomain]);
  const knowledgeRefreshSequenceRef = useRef(0);
  const [chatOpen, setChatOpen] = useState(initialCommandCenterOpen);
  const [chatLoaded, setChatLoaded] = useState(initialCommandCenterOpen);
  const [commandCenterView, setCommandCenterView] = useState<CommandCenterView>('office');
  const [chatPrefill, setChatPrefill] = useState<{ text: string; source: string } | null>(null);
  const [creationRequestId, setCreationRequestId] = useState<string | null>(null);
  const [chatAttachmentRequest, setChatAttachmentRequest] = useState<ChatAttachmentRequest | null>(null);
  const [sanctuaryOpen, setSanctuaryOpen] = useState(false);
  const [sanctuaryLoaded, setSanctuaryLoaded] = useState(false);
  const [sanctuaryAgent, setSanctuaryAgent] = useState<any>(null);
  const [memoryAvatars, setMemoryAvatars] = useState<any[]>([]);
  const memoryAvatarOwnerScope = useMemo(() => ({ userId: String(user?.uid || '') }), [user?.uid]);
  const memoryAvatarOwnerRef = useRef(memoryAvatarOwnerScope);
  const memoryAvatarListOwnerRef = useRef('');
  const memoryAvatarOpenGenerationRef = useRef(0);
  memoryAvatarOwnerRef.current = memoryAvatarOwnerScope;
  const memoryAvatarSurfaceGeneration = memoryAvatarOpenGenerationRef.current;
  useEffect(() => {
    memoryAvatarOpenGenerationRef.current++;
    memoryAvatarListOwnerRef.current = '';
    setMemoryAvatars([]);
    setSanctuaryAgent(null);
    setSanctuaryOpen(false);
    setMemoryLabOpen(false);
  }, [user?.uid]);
  const [petReaction, setPetReaction] = useState<{ animation: string; until: number } | null>(null);
  const petReactionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [memoryLabOpen, setMemoryLabOpen] = useState(false);
  const surfaceReturnTargetRef = useRef<SurfaceReturnTarget>('home');

  const triggerPetReaction = useCallback((animation: string, ms: number = 1500) => {
    if (petReactionTimeout.current) clearTimeout(petReactionTimeout.current);
    setPetReaction({ animation, until: Date.now() + ms });
    petReactionTimeout.current = setTimeout(() => setPetReaction(null), ms);
  }, []);

  const [equippedAccessories, setEquippedAccessories] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(petStorageKeys.accessories)
        || (workDomain === 'personal' ? localStorage.getItem('lumi_accessories_personal') : null)
        || (workDomain === 'personal' ? localStorage.getItem('lumi_accessories') : null);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [selectedPet, setSelectedPet] = useState<PetConfig | null>(() => {
    try {
      const saved = localStorage.getItem(petStorageKeys.pet)
        || (workDomain === 'personal' ? localStorage.getItem('lumi_selected_pet_personal') : null)
        || (workDomain === 'personal' ? localStorage.getItem('lumi_selected_pet') : null);
      if (saved) {
        const parsed = JSON.parse(saved);
        return resolvePetPreference(parsed);
      }
    } catch {}
    return null;
  });

  // Ref to prevent echoing our own preference changes back via socket
  const petPrefsSavingRef = useRef(false);
  const savePetPrefsToServer = useCallback(async (pet: PetConfig | null, accessories: string[]) => {
    if (!canCustomizeLumiAppearance) {
      toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
      return false;
    }
    const storedPet = serializePetPreference(pet);
    petPrefsSavingRef.current = true;
    try {
      const response = await fetch('/api/preferences/pet', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pet: storedPet,
          accessories,
        }),
        credentials: 'include',
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Appearance save failed (${response.status})`);
      }
      localStorage.setItem(petStorageKeys.accessories, JSON.stringify(accessories));
      if (storedPet) localStorage.setItem(petStorageKeys.pet, JSON.stringify(storedPet));
      else localStorage.removeItem(petStorageKeys.pet);
      return true;
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.appearance-save-failed.384eab961c', (lang === 'zh') ? 'zh' : 'en')));
      return false;
    } finally {
      setTimeout(() => { petPrefsSavingRef.current = false; }, 500);
    }
  }, [canCustomizeLumiAppearance, lang, petStorageKeys]);

  const [clientPermissions, setClientPermissions] = useState<ClientPermissionSnapshot>({});
  const [clientRuntime, setClientRuntime] = useState<ClientRuntimeSnapshot>({});
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('general');
  const [personalizationSection, setPersonalizationSection] = useState<'appearance' | 'voice'>('appearance');
  const [volume, setVolume] = useState<number | null>(null);
  const [time, setTime] = useState(new Date());
  const [isWallpaperMode, setIsWallpaperMode] = useState(false);
  const [wallpaperPresentation, setWallpaperPresentation] = useState<WallpaperPresentation>('workbench');
  const [wallpaperWorkspace, setWallpaperWorkspace] = useState<WallpaperWorkspace>('personal');
  const [isDesktopWidgetMode, setIsDesktopWidgetMode] = useState(false);
  const [isCompactWindowMode, setIsCompactWindowMode] = useState(false);
  const [externalCapabilities, setExternalCapabilities] = useState<ExternalCapabilityProjection[]>([]);
  const externalCapabilityLaunchesRef = useRef(new Set<string>());
  const externalCapabilityExecutionRequestsRef = useRef(new Map<string, ExternalCapabilityExecutionCorrelation>());
  const isWallpaperModeRef = useRef(false);
  const wallpaperPresentationRef = useRef<WallpaperPresentation>('workbench');
  const wallpaperWorkspaceRef = useRef<WallpaperWorkspace>('personal');
  const wallpaperNativeTransitionDepthRef = useRef(0);
  const closeToBackgroundSyncRef = useRef(false);

  // Command Center remains a deliberate focus surface. Only the controlled
  // desktop overlay stays above other apps; the interactive workbench behaves
  // like a normal full-screen workspace and must not trap the user on top.
  useEffect(() => {
    const shouldStayOnTop = (!isWallpaperMode && chatOpen)
      || (isWallpaperMode && wallpaperPresentation === 'desktop-control')
      || isDesktopWidgetMode;
    void systemService.setAlwaysOnTop(shouldStayOnTop).catch(error => {
      console.error('Failed to synchronize Lumi window level:', error);
    });
  }, [chatOpen, isDesktopWidgetMode, isWallpaperMode, wallpaperPresentation]);

  useEffect(() => () => {
    void systemService.setAlwaysOnTop(false).catch(() => {});
  }, []);
  const wallpaperAutomationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wallpaperBeforeAutomationRef = useRef<{
    enabled: boolean;
    presentation: WallpaperPresentation;
    workspace: WallpaperWorkspace;
  } | null>(null);
  const viewport = useViewportSize();
  const [wallpaper, setWallpaper] = useState<string>(() => localStorage.getItem('lumi_wallpaper_type') || 'celestial');
  const [wallpaperUrl, setWallpaperUrl] = useState<string>(() => localStorage.getItem('lumi_wallpaper_url') || '');
  const wallpaperInputRef = React.useRef<HTMLInputElement>(null);
  const desktopChrome = useMemo(() => getDesktopChromeMetrics(viewport), [viewport]);
  const desktopIconLayout = useMemo(() => getDesktopIconLayout(viewport), [viewport]);
  const isCompactDesktopLayout = useMemo(() => shouldUseCompactDesktopLayout(viewport), [viewport]);
  const dockPositionClassName = getDesktopDockPositionClassName(isCompactDesktopLayout);
  const desktopIconColumns = 3;
  const canUseExternalCapabilities = canUseExternalCapabilitiesForSurface({
    isTauri,
    workDomain,
    userId: user?.uid,
  });

  const refreshExternalCapabilities = useCallback(async () => {
    if (!canUseExternalCapabilities) {
      setExternalCapabilities([]);
      return;
    }
    try {
      setExternalCapabilities(await fetchExternalCapabilities());
    } catch {
      // The desktop remains usable when the optional reviewed-capability
      // projection is unavailable. Skill Hall exposes the actionable error.
      setExternalCapabilities([]);
    }
  }, [canUseExternalCapabilities]);

  useEffect(() => {
    void refreshExternalCapabilities();
    const refresh = () => { void refreshExternalCapabilities(); };
    window.addEventListener('lumi:external-capabilities-changed', refresh);
    return () => window.removeEventListener('lumi:external-capabilities-changed', refresh);
  }, [refreshExternalCapabilities]);

  const launchExternalCapability = useCallback(async (
    capability: ExternalCapabilityProjection,
    action: ExternalCapabilityAction,
  ) => {
    if (!canUseExternalCapabilities) return;
    const key = `${capability.id}:${action.id}`;
    if (externalCapabilityLaunchesRef.current.has(key)) return;
    const copy = externalCapabilityCopy(lang);
    if (action.requiresConfirmation && !window.confirm(copy.launchConfirm(capability.name))) return;
    const correlation = externalCapabilityExecutionRequestsRef.current.get(key)
      || createExternalCapabilityExecutionCorrelation();
    externalCapabilityExecutionRequestsRef.current.set(key, correlation);
    externalCapabilityLaunchesRef.current.add(key);
    try {
      await executeExternalCapabilityAction(capability.id, action.id, {}, correlation);
      externalCapabilityExecutionRequestsRef.current.delete(key);
      toast.success(copy.launchCompleted(capability.name));
      void refreshExternalCapabilities();
    } catch (error: any) {
      toast.error(error?.message || copy.loadFailed);
    } finally {
      externalCapabilityLaunchesRef.current.delete(key);
    }
  }, [canUseExternalCapabilities, lang, refreshExternalCapabilities]);

  const inferWallpaperWorkspace = useCallback((): WallpaperWorkspace => {
    if (activeTab === 'org') return 'organization';
    if (
      chatOpen
      || knowledgeOpen
      || memoryLabOpen
      || sanctuaryOpen
      || activeTab === 'chat'
      || activeTab === 'command-center'
    ) return 'command-center';
    return 'personal';
  }, [activeTab, chatOpen, knowledgeOpen, memoryLabOpen, sanctuaryOpen]);
  const isWallpaperDesktopControl = isWallpaperMode && wallpaperPresentation === 'desktop-control';
  const isWallpaperWorkbench = isWallpaperMode && wallpaperPresentation === 'workbench';

  useEffect(() => {
    isWallpaperModeRef.current = isWallpaperMode;
  }, [isWallpaperMode]);

  const syncWallpaperModeView = useCallback((
    enabled: boolean,
    presentation: WallpaperPresentation = wallpaperPresentationRef.current,
    workspace: WallpaperWorkspace = wallpaperWorkspaceRef.current,
  ) => {
    isWallpaperModeRef.current = enabled;
    wallpaperPresentationRef.current = presentation;
    wallpaperWorkspaceRef.current = workspace;
    setIsWallpaperMode(enabled);
    setWallpaperPresentation(presentation);
    setWallpaperWorkspace(workspace);
    systemService.syncWallpaperDocumentMode(enabled, presentation, workspace);
    window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
  }, []);

  useEffect(() => {
    if (!isWallpaperWorkbench) return;
    const currentWorkspace = inferWallpaperWorkspace();
    if (currentWorkspace !== wallpaperWorkspaceRef.current) {
      syncWallpaperModeView(true, 'workbench', currentWorkspace);
    }
  }, [inferWallpaperWorkspace, isWallpaperWorkbench, syncWallpaperModeView]);


  const dismissUtilitySurfaces = useCallback((keep?: 'command-center' | 'knowledge' | 'memory-avatar') => {
    if (keep !== 'command-center') {
      setChatOpen(false);
      setChatPrefill(null);
    }
    if (keep !== 'knowledge') setKnowledgeOpen(false);
    if (keep !== 'memory-avatar') {
      memoryAvatarOpenGenerationRef.current++;
      setMemoryLabOpen(false);
      setSanctuaryOpen(false);
      setSanctuaryAgent(null);
    }
  }, []);

  const openCommandCenter = useCallback((view: CommandCenterView = 'office') => {
    // Command Center is the canonical parent surface.  Opening it always
    // dismisses utility overlays and consumes any previous return context.
    surfaceReturnTargetRef.current = 'home';
    dismissUtilitySurfaces('command-center');
    setIsSearchOpen(false);
    setViewMode('personal');
    setCommandCenterView(view);
    windowCommand('remove', 'chat', 'command-center');
    setChatLoaded(true);
    setChatOpen(true);
    setActiveTab('command-center');
    window.setTimeout(() => {
      void (async () => {
        if (isTauri) {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const { getCurrentWebview } = await import('@tauri-apps/api/webview');
            await getCurrentWindow().setFocus();
            await getCurrentWebview().setFocus();
          } catch {}
        }
        window.dispatchEvent(new CustomEvent('lumi:focus-command-input'));
      })();
    }, 80);
  }, [dismissUtilitySurfaces, isTauri, setActiveTab, windowCommand]);

  const inferSurfaceReturnTarget = useCallback((): SurfaceReturnTarget => {
    if (chatOpen || activeTab === 'command-center') return 'command-center';
    // A utility surface can open another utility surface (for example the
    // knowledge base can open Memory Avatar).  At that point the chat flag is
    // deliberately false, so infer from the origin already recorded rather
    // than treating the second hop as a fresh desktop launch.
    if (knowledgeOpen || memoryLabOpen || sanctuaryOpen) {
      return surfaceReturnTargetRef.current;
    }
    return 'home';
  }, [activeTab, chatOpen, knowledgeOpen, memoryLabOpen, sanctuaryOpen]);

  const restoreSurfaceReturnTarget = useCallback(() => {
    const target = surfaceReturnTargetRef.current;
    surfaceReturnTargetRef.current = 'home';
    if (target === 'command-center') {
      openCommandCenter('office');
      return;
    }
    setActiveTab('home');
  }, [openCommandCenter, setActiveTab]);

  const openKnowledgeBase = useCallback((returnTarget?: SurfaceReturnTarget) => {
    surfaceReturnTargetRef.current = returnTarget || inferSurfaceReturnTarget();
    dismissUtilitySurfaces('knowledge');
    setIsSearchOpen(false);
    setViewMode('personal');
    setKnowledgeLoaded(true);
    setKnowledgeOpen(true);
    setActiveTab('knowledge');
  }, [dismissUtilitySurfaces, inferSurfaceReturnTarget, setActiveTab]);

  const closeKnowledgeBase = useCallback(() => {
    memoryAvatarOpenGenerationRef.current++;
    setKnowledgeOpen(false);
    restoreSurfaceReturnTarget();
  }, [restoreSurfaceReturnTarget]);

  const askComputerProfileQuestion = useCallback((prompt: string) => {
    const text = String(prompt || '').trim();
    if (!text) return;
    openCommandCenter('office');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('lumi:replace-command-input', { detail: { text } }));
      window.dispatchEvent(new CustomEvent('lumi:submit-command-input'));
    }, 120);
  }, [openCommandCenter]);
  return {
    memoryAvatarOwnerScope, memoryAvatarOwnerRef, memoryAvatarListOwnerRef, setMemoryAvatars, memoryAvatars,
    memoryAvatarOpenGenerationRef, memoryAvatarSurfaceGeneration, setMemoryLabOpen, setSanctuaryAgent,
    setSanctuaryLoaded, setSanctuaryOpen, inferSurfaceReturnTarget, surfaceReturnTargetRef, dismissUtilitySurfaces,
    setIsSearchOpen, setViewMode, setActiveTab, restoreSurfaceReturnTarget, isTauri, openCommandCenter,
    setIsNotificationPanelOpen, setChatPrefill, lang, workDomain, orgConnection, setChatAttachmentRequest,
    setKnowledgeOpen, desktopIconLayout, desktopIconColumns, canUseExternalCapabilities, externalCapabilities,
    setWallpaperUrl, setWallpaper, setIsCompactWindowMode, setIsDesktopWidgetMode, meetingStorageKeys,
    meetingPreferenceScopeKey, operationMode, knowledgeOpen, setKnowledgeLoaded, chatOpen, setChatLoaded, user,
    selectedVoiceId, volume, setOperationMode, setClientPermissions, setClientRuntime, closeToBackgroundSyncRef,
    aiConfig, knowledgeRefreshSequenceRef, setKnowledgeRuntimeState, setOrganizationWorkspaceView, windowCommand,
    setVolume, wallpaperAutomationTimerRef, wallpaperPresentationRef, inferWallpaperWorkspace, wallpaperWorkspaceRef,
    isWallpaperModeRef, syncWallpaperModeView, wallpaperNativeTransitionDepthRef, isDesktopWidgetMode,
    wallpaperBeforeAutomationRef, addNotification, t, isWallpaperMode, desktopExecutionPreference, setDesktopExecutionPreference,
    triggerPetReaction, petPrefsSavingRef, setSelectedPet, petStorageKeys, setEquippedAccessories, sanctuaryOpen,
    memoryLabOpen, closeKnowledgeBase, isWallpaperWorkbench, isSearchOpen, setTime, canCustomizeLumiAppearance,
    savePetPrefsToServer, equippedAccessories, setPersonalizationSection, openKnowledgeBase, setNexusReturnTarget,
    nexusReturnTarget, activeTab, openWindows, switchDomain, setSettingsSection,
    clientRuntime, viewMode, focusedWindow, settingsSection, commandCenterView, isNotificationPanelOpen,
    organizationWorkspaceView, clientPermissions, availableOrganizationWorkspaceViews, reportedKnowledgeRuntimeState,
    minimizedWindows, wallpaperPresentation, wallpaperWorkspace, selectedPet, petReaction, resolvedAppearanceMode,
    desktopChrome, isCompactDesktopLayout, isWallpaperDesktopControl, wallpaper, wallpaperUrl, wallpaperInputRef,
    personalScale, personalOpacity, syncRate, setSyncRate, unreadCount, time, isCompactWindowMode,
    dockPositionClassName, onLogin, launchExternalCapability, notifications, askComputerProfileQuestion, setCreationRequestId, setLang, personalizationSection, petPreferenceScopeKey,
    renderTabContent, knowledgeLoaded, chatLoaded, setCommandCenterView, chatPrefill, creationRequestId,
    chatAttachmentRequest, sanctuaryLoaded, sanctuaryAgent
  } as const;
}
