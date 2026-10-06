import { useDesktopWindows } from './desktop/useDesktopWindows';
import { useClientSurfaceActions, normalizeDesktopSurfaceTarget as normalizeTarget } from './desktop/useClientSurfaceActions';

import { DesktopShellView } from "./desktop/DesktopShellView";
import { useMeetingWorkflow } from "./desktop/useMeetingWorkflow";
import { useMeetingTranscript } from "./desktop/useMeetingTranscript";
import { useViewportSize } from "./desktop/window_shell";
import { type DesktopWidgetFallbackState, DesktopWidgetPanel } from "./desktop/widget";

import { type DesktopIconDefinition, externalCapabilityDesktopIcon } from "./desktop/launcher";

import { type ClientKnowledgeRuntimeState, emptyKnowledgeRuntimeState, resolvePetPreference, serializePetPreference, type ClientPermissionSnapshot, type ClientRuntimeSnapshot } from "./desktop/runtime_state";
import { type ProactiveChatDetail, formatProactiveChatPrefill } from "./desktop/proactive_presentation";
import { businessWorkbenchCopy } from '../i18n/locales/businessWorkbench';
import { BriefcaseBusiness } from 'lucide-react';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';

import { useMotionValue, useTransform } from 'motion/react';
import { sounds } from '../services/soundService';

import { Cpu, Settings as SettingsIcon, User as UserIcon, FileText, Activity, Volume2, Bell, BrainCircuit, Sparkles, Box, Wrench, Brush, Terminal as TerminalIcon, RefreshCw, Circle, Calendar } from 'lucide-react';
import { toast } from 'sonner';

import type { PetConfig } from '../pets/types';
import { useSocket } from '@/hooks/useSocket';
import { useAmbientPoller } from '@/hooks/useAmbientPoller';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';

import type { CommandCenterView } from './commandCenterTypes';
import { useWakeWord } from '../hooks/useWakeWord';
import { useVoiceprint } from '../hooks/useVoiceprint';
import { useFaceRecognition } from '../hooks/useFaceRecognition';
import { usePresence } from '../hooks/usePresence';
import { BACKGROUND_FACE_PRESENCE_CHANGED, BACKGROUND_FACE_PRESENCE_ENABLED_KEY, getSensorPermissionSnapshot, isBackgroundFacePresenceEnabled, isSensorEnabled, SENSOR_ACCESS_CHANGED, SENSOR_PERMISSIONS_CHANGED } from '@/services/sensorPermissionService';

import { systemService, type WallpaperPresentation, type WallpaperWorkspace } from '@/services/systemService';
import { usePlatform } from '@/hooks/usePlatform';
import { apiFetch } from '@/services/apiClient';
import { memoryAvatarService } from '@/services/memoryAvatarService';
import { canUseExternalCapabilitiesForSurface, createExternalCapabilityExecutionCorrelation, executeExternalCapabilityAction, fetchExternalCapabilities, getDesktopExternalCapabilities, type ExternalCapabilityAction, type ExternalCapabilityExecutionCorrelation, type ExternalCapabilityProjection } from '@/services/externalCapabilities';
import { canAccessOrganizationWorkspaceView, listOrganizationWorkspaceViewsForRole, normalizeOrganizationWorkspaceView, type OrganizationWorkspaceView } from '../../shared/org_workspace';
import { CLIENT_SETTINGS_SECTIONS, PERSONAL_CLIENT_LAUNCHER_IDS, PERSONAL_CLIENT_SURFACES, PERSONAL_CLIENT_SURFACE_ACTIONS, getOpenPersonalClientSurfaceIds } from '../../shared/client_surfaces';
import { queueOrganizationWorkspaceRoute } from '../lib/orgWorkspaceNavigation';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { desktopWorkflowCopy } from '../i18n/locales/desktopWorkflows';
import { externalCapabilityCopy } from '../i18n/locales/externalCapabilities';
import { chatAttachmentRequestMatchesScope, type ChatAttachmentRequest } from '@/lib/chatAttachmentReferences';
import { getDesktopDockPositionClassName, getDesktopChromeMetrics, getDesktopIconLayout, shouldUseCompactDesktopLayout } from '@/lib/desktopLayout';

const IDLE_AWAY_SECONDS = 5 * 60;
const RETURN_IDLE_SECONDS = 30;

// Full-screen utility surfaces can be opened from the Command Center.  Keep
// the origin explicit so closing an overlay returns to the surface the user
// came from instead of silently falling back to the personal desktop.
type SurfaceReturnTarget = 'home' | 'command-center';

declare global {
  interface Window {
    lumiElectron?: {
      getSystemInfo: () => Promise<{ platform: string; hostname: string; freeMemory: number }>;
      runCommand: (command: string) => Promise<{ success: boolean; output: string }>;
    };
  }
}

function useDesktopSurfaceState({
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
  const { selectedVoiceId, unreadCount, notifications, addNotification, orgConnection, workDomain, switchDomain, operationMode, setOperationMode, aiConfig, resolvedAppearanceMode } = useApp();
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
  const desktopWidgetFallbackRef = useRef<DesktopWidgetFallbackState | null>(null);
  const wallpaperAutomationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wallpaperBeforeAutomationRef = useRef<{
    enabled: boolean;
    presentation: WallpaperPresentation;
    workspace: WallpaperWorkspace;
  } | null>(null);
  const viewport = useViewportSize();
  const [wallpaperWorkPromptVisible, setWallpaperWorkPromptVisible] = useState(false);
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
    if (isWallpaperMode) setWallpaperWorkPromptVisible(false);
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

  useEffect(() => {
    if (chatOpen) setWallpaperWorkPromptVisible(false);
  }, [chatOpen]);

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
    wallpaperBeforeAutomationRef, addNotification, t, isWallpaperMode, setWallpaperWorkPromptVisible,
    triggerPetReaction, petPrefsSavingRef, setSelectedPet, petStorageKeys, setEquippedAccessories, sanctuaryOpen,
    memoryLabOpen, closeKnowledgeBase, isWallpaperWorkbench, isSearchOpen, setTime, canCustomizeLumiAppearance,
    savePetPrefsToServer, equippedAccessories, setPersonalizationSection, openKnowledgeBase, setNexusReturnTarget,
    nexusReturnTarget, activeTab, desktopWidgetFallbackRef, openWindows, switchDomain, setSettingsSection,
    clientRuntime, viewMode, focusedWindow, settingsSection, commandCenterView, isNotificationPanelOpen,
    organizationWorkspaceView, clientPermissions, availableOrganizationWorkspaceViews, reportedKnowledgeRuntimeState,
    minimizedWindows, wallpaperPresentation, wallpaperWorkspace, selectedPet, petReaction, resolvedAppearanceMode,
    desktopChrome, isCompactDesktopLayout, isWallpaperDesktopControl, wallpaper, wallpaperUrl, wallpaperInputRef,
    personalScale, personalOpacity, syncRate, setSyncRate, unreadCount, time, isCompactWindowMode,
    dockPositionClassName, onLogin, launchExternalCapability, notifications, wallpaperWorkPromptVisible,
    askComputerProfileQuestion, setCreationRequestId, setLang, personalizationSection, petPreferenceScopeKey,
    renderTabContent, knowledgeLoaded, chatLoaded, setCommandCenterView, chatPrefill, creationRequestId,
    chatAttachmentRequest, sanctuaryLoaded, sanctuaryAgent
  } as const;
}

function useDesktopCaptureAndIdentity(previousBindings: ReturnType<typeof useDesktopSurfaceState>) {
  const { memoryAvatarOwnerScope, memoryAvatarOwnerRef, memoryAvatarListOwnerRef, setMemoryAvatars, memoryAvatars, memoryAvatarOpenGenerationRef, memoryAvatarSurfaceGeneration, setMemoryLabOpen, setSanctuaryAgent, setSanctuaryLoaded, setSanctuaryOpen, inferSurfaceReturnTarget, surfaceReturnTargetRef, dismissUtilitySurfaces, setIsSearchOpen, setViewMode, setActiveTab, restoreSurfaceReturnTarget, isTauri, openCommandCenter, setIsNotificationPanelOpen, setChatPrefill, lang, workDomain, orgConnection, setChatAttachmentRequest, setKnowledgeOpen, desktopIconLayout, desktopIconColumns, canUseExternalCapabilities, externalCapabilities, setWallpaperUrl, setWallpaper, setIsCompactWindowMode, setIsDesktopWidgetMode, meetingStorageKeys, meetingPreferenceScopeKey, operationMode, knowledgeOpen, setKnowledgeLoaded, chatOpen, setChatLoaded, user, selectedVoiceId, volume, setOperationMode } = previousBindings;


  // Memory Avatars are private, tool-free surfaces. Keep the list in the
  // shell so the command center can open an existing avatar, switch between
  // avatars, or start another distillation without being trapped on the first
  // one that was created.
  const loadMemoryAvatars = useCallback(async (): Promise<any[]> => {
    const ownerId = memoryAvatarOwnerScope.userId;
    if (!ownerId) return [];
    try {
      const data = await memoryAvatarService.list();
      if (memoryAvatarOwnerRef.current !== memoryAvatarOwnerScope) return [];
      memoryAvatarListOwnerRef.current = ownerId;
      setMemoryAvatars(data.avatars);
      return data.avatars;
    } catch {}
    return memoryAvatarOwnerRef.current === memoryAvatarOwnerScope && memoryAvatarListOwnerRef.current === ownerId ? memoryAvatars : [];
  }, [memoryAvatarOwnerScope, memoryAvatarOwnerRef, memoryAvatarListOwnerRef, memoryAvatars, setMemoryAvatars]);

  const enterCreatedMemoryAvatar = useCallback((avatar: any) => {
    // Exit animations can keep a closed lab mounted. Its late request must not
    // reopen a surface that was closed, replaced, or belongs to an old login.
    if (memoryAvatarOwnerRef.current !== memoryAvatarOwnerScope
      || memoryAvatarOpenGenerationRef.current !== memoryAvatarSurfaceGeneration) return;
    setMemoryAvatars(previous => [...previous.filter(existing => existing?.id !== avatar?.id), avatar]);
    setMemoryLabOpen(false);
    setSanctuaryAgent(avatar);
    setSanctuaryLoaded(true);
    setSanctuaryOpen(true);
  }, [memoryAvatarOpenGenerationRef, memoryAvatarOwnerRef, memoryAvatarOwnerScope, memoryAvatarSurfaceGeneration, setMemoryAvatars, setMemoryLabOpen, setSanctuaryAgent, setSanctuaryLoaded, setSanctuaryOpen]);

  const openMemoryAvatar = useCallback(async (avatarId?: string, returnTarget?: SurfaceReturnTarget) => {
    const openGeneration = ++memoryAvatarOpenGenerationRef.current;
    try { sounds.playClick(); } catch {}
    const origin = returnTarget || inferSurfaceReturnTarget();
    const avatars = await loadMemoryAvatars();
    if (openGeneration !== memoryAvatarOpenGenerationRef.current) return;
    const selected = avatarId
      ? avatars.find(avatar => avatar?.id === avatarId)
      : avatars[0];
    // A stale menu entry must never silently open another person's/avatar's
    // transcript.  Keep the current surface in place and let the next open
    // refresh the list instead of falling back to avatars[0].
    if (avatarId && !selected) return;
    surfaceReturnTargetRef.current = origin;
    dismissUtilitySurfaces('memory-avatar');
    setIsSearchOpen(false);
    setViewMode('personal');
    setActiveTab('home');
    setSanctuaryAgent(selected || null);
    if (selected) setSanctuaryLoaded(true);
    setSanctuaryOpen(Boolean(selected));
    setMemoryLabOpen(!selected);
  }, [dismissUtilitySurfaces, inferSurfaceReturnTarget, loadMemoryAvatars, memoryAvatarOpenGenerationRef, setActiveTab, setIsSearchOpen, setMemoryLabOpen, setSanctuaryAgent, setSanctuaryLoaded, setSanctuaryOpen, setViewMode, surfaceReturnTargetRef]);

  const openMemoryAvatarLab = useCallback((returnTarget?: SurfaceReturnTarget) => {
    memoryAvatarOpenGenerationRef.current++;
    surfaceReturnTargetRef.current = returnTarget || inferSurfaceReturnTarget();
    dismissUtilitySurfaces('memory-avatar');
    setIsSearchOpen(false);
    setViewMode('personal');
    setActiveTab('home');
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    setMemoryLabOpen(true);
  }, [dismissUtilitySurfaces, inferSurfaceReturnTarget, memoryAvatarOpenGenerationRef, setActiveTab, setIsSearchOpen, setMemoryLabOpen, setSanctuaryAgent, setSanctuaryOpen, setViewMode, surfaceReturnTargetRef]);

  const closeMemoryAvatar = useCallback(() => {
    memoryAvatarOpenGenerationRef.current++;
    setMemoryLabOpen(false);
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    restoreSurfaceReturnTarget();
  }, [memoryAvatarOpenGenerationRef, restoreSurfaceReturnTarget, setMemoryLabOpen, setSanctuaryAgent, setSanctuaryOpen]);

  useEffect(() => {
    const handler = () => { void openMemoryAvatar(undefined, 'home'); };
    window.addEventListener('lumi:open-memory-lab', handler);
    return () => window.removeEventListener('lumi:open-memory-lab', handler);
  }, [openMemoryAvatar]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: undefined | (() => void);

    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('lumi:open-command-center', () => {
        if (!disposed) openCommandCenter('office');
      }))
      .then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isTauri, openCommandCenter]);

  const openProactiveChat = useCallback((detail: ProactiveChatDetail) => {
    setIsNotificationPanelOpen(false);
    setChatPrefill({ text: formatProactiveChatPrefill(detail, lang), source: 'proactive_context' });
    openCommandCenter('office');
  }, [lang, openCommandCenter, setChatPrefill, setIsNotificationPanelOpen]);

  useEffect(() => {
    const handleOpenProactiveChat = (event: Event) => {
      openProactiveChat((event as CustomEvent<ProactiveChatDetail>).detail || {});
    };
    window.addEventListener('lumi:open-proactive-chat', handleOpenProactiveChat);
    return () => window.removeEventListener('lumi:open-proactive-chat', handleOpenProactiveChat);
  }, [openProactiveChat]);

  useEffect(() => {
    const handleFileReference = (event: Event) => {
      const detail = (event as CustomEvent<ChatAttachmentRequest>).detail;
      if (!detail?.requestId || !detail.fileName) return;
      const activeDomain = workDomain === 'work' && orgConnection?.connected && orgConnection?.orgId
        ? 'work'
        : 'personal';
      const scopeMatches = chatAttachmentRequestMatchesScope(detail, activeDomain, orgConnection?.orgId);
      if (!scopeMatches) {
        toast.error(uiMessage('desktop-ui.file-reference-scope-mismatch.2962eb0cbf', lang));
        return;
      }
      setChatAttachmentRequest(detail);
      setKnowledgeOpen(false);
      openCommandCenter('office');
    };
    window.addEventListener('lumi:reference-file-in-chat', handleFileReference);
    return () => window.removeEventListener('lumi:reference-file-in-chat', handleFileReference);
  }, [lang, openCommandCenter, orgConnection?.connected, orgConnection?.orgId, setChatAttachmentRequest, setKnowledgeOpen, workDomain]);

  const getDefaultDesktopIconPosition = useCallback((index: number) => ({
    x: desktopIconLayout.startX + (index % desktopIconColumns) * desktopIconLayout.cellWidth,
    y: desktopIconLayout.startY + Math.floor(index / desktopIconColumns) * desktopIconLayout.cellHeight,
  }), [desktopIconColumns, desktopIconLayout]);

  // Desktop icon layout: absolute positioning with viewport-aware columns.
  const reviewedExternalDesktopIcons: DesktopIconDefinition[] = (canUseExternalCapabilities ? getDesktopExternalCapabilities(externalCapabilities) : []).map(({ capability, action }, index) => ({
    id: `external-capability:${capability.id}`,
    label: capability.presentation.label || capability.name,
    icon: externalCapabilityDesktopIcon(capability.presentation.icon || action.icon),
    colorClass: [
      'from-cyan-500 to-blue-700',
      'from-violet-500 to-indigo-700',
      'from-emerald-500 to-teal-700',
      'from-amber-500 to-orange-700',
    ][index % 4],
    externalLaunch: { capability, action },
  }));
  const desktopIcons: DesktopIconDefinition[] = [
    { id: 'business', label: businessWorkbenchCopy[lang === 'en' ? 'en' : 'zh'].title, icon: <BriefcaseBusiness size={24} />, colorClass: 'from-emerald-500 to-cyan-600', windowId: 'business' },
    { id: 'tools', labelKey: 'tools', icon: <Wrench size={24} />, colorClass: 'from-amber-500 to-orange-600', windowId: 'tools' },
    { id: 'skills', labelKey: 'skills', icon: <Sparkles size={24} />, colorClass: 'from-emerald-500 to-teal-600', windowId: 'skills' },
    ...reviewedExternalDesktopIcons,
  ];
  const desktopIconAreaHeight = Math.max(
    desktopIconLayout.compact ? 300 : 400,
    Math.ceil(desktopIcons.length / desktopIconColumns) * desktopIconLayout.cellHeight + desktopIconLayout.startY + 24,
  );

  const handleWallpaperUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      setWallpaperUrl(url);
      setWallpaper('custom');
      localStorage.setItem('lumi_wallpaper_type', 'custom');
      localStorage.setItem('lumi_wallpaper_url', url);
    };
    reader.readAsDataURL(file);
  };

  const handleWindowMinimize = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('minimize_window');
    } catch {}
  };
  const handleTopbarPointerDown = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !isTauri) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [role="button"], [data-no-window-drag="true"]')) return;
    try {
      const windowApi = await import('@tauri-apps/api/window');
      await windowApi.getCurrentWindow().startDragging();
    } catch {}
  };
  const handleWindowMaximize = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<{ enabled?: boolean }>('toggle_compact_window_mode');
      setIsCompactWindowMode(Boolean(status?.enabled));
    } catch (err: any) {
      toast.error(err?.message || desktopWorkflowCopy(lang).common.windowControlFailed);
    }
  };
  const handleWindowClose = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_window');
    } catch {}
  };

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    const syncWidgetMode = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const [widgetStatus, compactStatus] = await Promise.all([
          invoke<{ enabled?: boolean }>('get_desktop_widget_mode'),
          invoke<{ enabled?: boolean }>('get_compact_window_mode'),
        ]);
        if (!disposed) {
          setIsDesktopWidgetMode(Boolean(widgetStatus?.enabled));
          setIsCompactWindowMode(Boolean(compactStatus?.enabled));
        }
      } catch {}
    };
    void syncWidgetMode();
    return () => { disposed = true; };
  }, [isTauri, setIsCompactWindowMode, setIsDesktopWidgetMode]);

  const [isTrainingOpen, setIsTrainingOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return localStorage.getItem('lumi_onboarding_seen') !== 'true';
  });
  const [sensorPrimerSeen, setSensorPrimerSeen] = useState(() => {
    return localStorage.getItem('lumi_sensor_primer_seen') === 'true';
  });
  const [backgroundFaceRecognitionOptedIn, setBackgroundFaceRecognitionOptedIn] = useState(() => (
    isBackgroundFacePresenceEnabled(localStorage)
  ));
  const [cameraAccessEnabled, setCameraAccessEnabled] = useState(() => isSensorEnabled('camera'));
  useEffect(() => {
    const refreshFacePresenceAccess = () => {
      setBackgroundFaceRecognitionOptedIn(isBackgroundFacePresenceEnabled(localStorage));
      setCameraAccessEnabled(isSensorEnabled('camera'));
    };
    const onStorage = (event: StorageEvent) => {
      if (
        !event.key ||
        event.key === BACKGROUND_FACE_PRESENCE_ENABLED_KEY ||
        event.key === 'lumi_camera_enabled'
      ) {
        refreshFacePresenceAccess();
      }
    };
    window.addEventListener(BACKGROUND_FACE_PRESENCE_CHANGED, refreshFacePresenceAccess);
    window.addEventListener(SENSOR_ACCESS_CHANGED, refreshFacePresenceAccess);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(BACKGROUND_FACE_PRESENCE_CHANGED, refreshFacePresenceAccess);
      window.removeEventListener(SENSOR_ACCESS_CHANGED, refreshFacePresenceAccess);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const finishSensorPrimer = useCallback(() => {
    localStorage.setItem('lumi_sensor_primer_seen', 'true');
    setSensorPrimerSeen(true);
  }, []);
  const [mcpActivities, setMcpActivities] = useState<Array<{
    id: string; device: string; action: string; status: string;
    message?: string; title?: string; path?: string; slidesCount?: number; toolCalls?: number; error?: string;
    time: number;
  }>>([]);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'done' | 'error'>('idle');
  const [pendingOperationMode, setPendingOperationMode] = useState<OperationMode | null>(null);
  const seenWorkflowToolEvents = useRef<Set<string>>(new Set());

  const socket = useSocket();
  const { appendMeetingTranscript, meetingCaptureResetRef, meetingVoiceActiveRef, setMeetingPaused, meetingIdentityRef, meetingPaused, setMeetingStartedAt, meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingNotes, formatMeetingNoteForExport, setMeetingReport, setMeetingReportGenerating, lastLegalMeetingArchiveRef, setLegalMeetingCaseTitle, waitForMeetingRefinement, setMeetingNotesOpen, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount, lastMeetingTranscriptRef, resetMeetingCapture, meetingModeRef, meetingNotesOpen, meetingReportGenerating, meetingSpeakerCount, meetingNoteHasSpeakerInfo, meetingSpeakerLabel } = useMeetingTranscript({ workDomain, meetingStorageKeys, meetingPreferenceScopeKey, operationMode, lang, socket });

  useEffect(() => {
    if (knowledgeOpen) setKnowledgeLoaded(true);
  }, [knowledgeOpen, setKnowledgeLoaded]);

  useEffect(() => {
    if (chatOpen) setChatLoaded(true);
  }, [chatOpen, setChatLoaded]);

  const voiceprint = useVoiceprint({ socket });
  const loadVoiceprintTemplates = voiceprint.loadTemplates;
  const startVoiceprintListening = voiceprint.startListening;
  const stopVoiceprintListening = voiceprint.stopListening;
  const ownerVoiceGateOpen = useCallback(() => {
    if (!voiceprint.templatesLoaded) return false;
    if (voiceprint.enrolledCount === 0) return true;
    if (!voiceprint.hasUsableTemplates) return false;
    return Boolean(
      voiceprint.result.isOwnerSpeaking
      && voiceprint.result.confidence >= (voiceprint.result.source === 'speechbrain' ? 0.66 : 0.82)
      && Number(voiceprint.result.frameCount || 0) >= 3
      && (
        voiceprint.result.source === 'speechbrain'
        || Number(voiceprint.result.quality || 0) >= 0.55
      )
    );
  }, [
    voiceprint.enrolledCount,
    voiceprint.hasUsableTemplates,
    voiceprint.result.confidence,
    voiceprint.result.frameCount,
    voiceprint.result.isOwnerSpeaking,
    voiceprint.result.quality,
    voiceprint.result.source,
    voiceprint.templatesLoaded,
  ]);
  useAmbientPoller(socket); // Ambient awareness: polls window, clipboard, idle state
  const { callState, audioLevel, startCall, startCallRef, switchVoice, endCall, error: callError, transcript, interrupt, toggleMute, isMuted, switchPersonality } = useVoiceCall({
    socket,
    onTranscript: appendMeetingTranscript,
    proactive: {
      userId: String(user?.uid || ''), domain: workDomain,
      orgId: workDomain === 'work' ? orgConnection?.orgId : '',
      voiceId: selectedVoiceId, outputMuted: volume <= 0,
    },
  });
  const voiceScopeOptions = useMemo(() => (
    workDomain === 'work' && orgConnection?.connected && orgConnection?.orgId
      ? { domain: 'work' as const, orgId: orgConnection.orgId }
      : { domain: 'personal' as const }
  ), [orgConnection?.connected, orgConnection?.orgId, workDomain]);
  const getVoiceScopeOptions = useCallback(() => voiceScopeOptions, [voiceScopeOptions]);
  useEffect(() => {
    switchVoice(selectedVoiceId);
  }, [selectedVoiceId, switchVoice]);
  useEffect(() => {
    void loadVoiceprintTemplates();
  }, [loadVoiceprintTemplates]);
  useEffect(() => {
    if (!voiceprint.templatesLoaded || voiceprint.enrolledCount === 0 || !voiceprint.hasUsableTemplates) return;
    void startVoiceprintListening();
    return () => stopVoiceprintListening();
  }, [
    startVoiceprintListening,
    stopVoiceprintListening,
    voiceprint.enrolledCount,
    voiceprint.hasUsableTemplates,
    voiceprint.templatesLoaded,
  ]);
  const meetingStartAttemptRef = useRef(0);
  const activeVoiceScopeRef = useRef(meetingPreferenceScopeKey);
  meetingCaptureResetRef.current = previousMeetingId => {
    socket?.emit('meeting:discard', { meetingId: previousMeetingId });
    meetingStartAttemptRef.current = 0;
    if (meetingVoiceActiveRef.current && callState !== 'idle') endCall();
  };

  useEffect(() => {
    if (activeVoiceScopeRef.current === meetingPreferenceScopeKey) return;
    activeVoiceScopeRef.current = meetingPreferenceScopeKey;
    meetingVoiceActiveRef.current = false;
    meetingStartAttemptRef.current = Date.now();
    if (callState !== 'idle') endCall();
    if (operationMode === 'meeting') setOperationMode('assistant');
  }, [callState, endCall, meetingPreferenceScopeKey, meetingVoiceActiveRef, operationMode, setOperationMode]);

  const startStandardVoiceCall = useCallback(() => {
    void startCall(selectedVoiceId, 'lumi', 'lumi', getVoiceScopeOptions());
  }, [getVoiceScopeOptions, selectedVoiceId, startCall]);

  const stopMeetingAudio = useCallback((options: { refineTranscript?: boolean; refinementId?: string } = {}) => {
    setMeetingPaused(false);
    meetingVoiceActiveRef.current = false;
    if (operationMode === 'meeting') setOperationMode('assistant');
    if (callState !== 'idle') endCall({ refineTranscript: options.refineTranscript === true, refinementId: options.refinementId });
    else if (options.refineTranscript) socket?.emit('meeting:refine', { meetingId: meetingIdentityRef.current.meetingId, refinementId: options.refinementId });
  }, [callState, endCall, meetingIdentityRef, meetingVoiceActiveRef, operationMode, setMeetingPaused, setOperationMode, socket]);

  useEffect(() => {
    if (operationMode !== 'meeting') {
      if (meetingPaused) setMeetingPaused(false);
      if (meetingVoiceActiveRef.current && callState !== 'idle') {
        meetingVoiceActiveRef.current = false;
        endCall();
      }
      return;
    }

    if (meetingPaused) {
      if (meetingVoiceActiveRef.current && callState !== 'idle') {
        meetingVoiceActiveRef.current = false;
        endCall({ preserveMeeting: true });
      }
      return;
    }

    setMeetingStartedAt(prev => {
      if (prev) return prev;
      const now = Date.now();
      localStorage.setItem(meetingStorageKeys.startedAt, String(now));
      return now;
    });

    if (callState === 'idle') {
      const now = Date.now();
      if (now - meetingStartAttemptRef.current < 3000) return;
      meetingStartAttemptRef.current = now;
      meetingVoiceActiveRef.current = true;
      void startCall(selectedVoiceId, 'lumi', 'lumi', { ...getVoiceScopeOptions(), transcriptionOnly: true, meetingId: meetingIdentityRef.current.meetingId });
    }
  }, [callState, endCall, getVoiceScopeOptions, meetingIdentityRef, meetingPaused, meetingStorageKeys.startedAt, meetingVoiceActiveRef, operationMode, selectedVoiceId, setMeetingPaused, setMeetingStartedAt, startCall]);
  // Spacebar push-to-talk: track whether this call was started by spacebar
  const isSpacebarRecording = useRef(false);
  const callStateRef = useRef(callState);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  // Wake word detection — server-side Qwen ASR (DASHSCOPE_API_KEY), falls back to Picovoice
  // Default off — user must explicitly enable in Settings to avoid continuous ASR charges
  const [wakeEnabled, setWakeEnabled] = useState(() => localStorage.getItem('lumi_wake_word_enabled') === 'true');
  useEffect(() => {
    const syncWakeSetting = () => {
      setWakeEnabled(localStorage.getItem('lumi_wake_word_enabled') === 'true');
    };
    const onSettingChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.key === 'lumi_wake_word_enabled') setWakeEnabled(detail.value === true || detail.value === 'true');
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'lumi_wake_word_enabled') syncWakeSetting();
    };
    window.addEventListener('lumi:setting-changed', onSettingChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('lumi:setting-changed', onSettingChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return {
    ...previousBindings, wakeEnabled, sensorPrimerSeen, socket, startCallRef, voiceScopeOptions, ownerVoiceGateOpen, callState, interrupt,
    backgroundFaceRecognitionOptedIn, cameraAccessEnabled, voiceprint, isMuted, callError, meetingStartedAt, legalMeetingCaseTitle, meetingReport,
    meetingNotes, formatMeetingNoteForExport, meetingIdentityRef, setMeetingReport, setMeetingReportGenerating, lastLegalMeetingArchiveRef,
    setLegalMeetingCaseTitle, waitForMeetingRefinement, stopMeetingAudio, setMeetingNotesOpen, endCall, setMeetingPaused, meetingVoiceActiveRef,
    meetingStartAttemptRef, meetingPaused, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount, setMeetingStartedAt, lastMeetingTranscriptRef,
    setPendingOperationMode, pendingOperationMode, resetMeetingCapture, setMcpActivities, setAgentStatus, seenWorkflowToolEvents, callStateRef,
    startStandardVoiceCall, closeMemoryAvatar, meetingModeRef, startCall, getVoiceScopeOptions, isSpacebarRecording, openMemoryAvatar, meetingNotesOpen,
    meetingReportGenerating, agentStatus, mcpActivities, desktopIcons, audioLevel, transcript, handleWallpaperUpload, handleTopbarPointerDown,
    setShowOnboarding, toggleMute, handleWindowMinimize, handleWindowMaximize, handleWindowClose, openProactiveChat, desktopIconAreaHeight,
    getDefaultDesktopIconPosition, meetingSpeakerCount, meetingNoteHasSpeakerInfo, meetingSpeakerLabel, finishSensorPrimer, showOnboarding, isTrainingOpen,
    setIsTrainingOpen, openMemoryAvatarLab, enterCreatedMemoryAvatar
  } as const;
}

function useDesktopRuntimeAndPreferences(previousBindings: ReturnType<typeof useDesktopCaptureAndIdentity>) {
  const { isTauri, wakeEnabled, sensorPrimerSeen, setClientPermissions, setClientRuntime, closeToBackgroundSyncRef, socket, startCallRef, selectedVoiceId, voiceScopeOptions, ownerVoiceGateOpen, callState, interrupt, backgroundFaceRecognitionOptedIn, cameraAccessEnabled, workDomain, voiceprint, user, isMuted, volume, callError, meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingNotes, formatMeetingNoteForExport, lang, meetingIdentityRef, setMeetingReport, meetingStorageKeys, setMeetingReportGenerating, orgConnection, aiConfig, lastLegalMeetingArchiveRef, setLegalMeetingCaseTitle, waitForMeetingRefinement, stopMeetingAudio, setMeetingNotesOpen, operationMode, endCall, setMeetingPaused, meetingVoiceActiveRef, meetingStartAttemptRef, setOperationMode, meetingPaused, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount, setMeetingStartedAt, lastMeetingTranscriptRef, setPendingOperationMode, pendingOperationMode, resetMeetingCapture, knowledgeRefreshSequenceRef, setKnowledgeRuntimeState, setOrganizationWorkspaceView, surfaceReturnTargetRef, windowCommand, dismissUtilitySurfaces, setActiveTab, openCommandCenter, setVolume } = previousBindings;


  useEffect(() => {
    let disposed = false;

    const refreshPermissions = async () => {
      const snapshot = await getSensorPermissionSnapshot({
        desktopAutomation: isTauri ? 'available' : 'unavailable',
        wakeWordEnabled: wakeEnabled,
        sensorPrimerSeen,
        biometricsPrimerSeen: sensorPrimerSeen,
      });
      let nativeDesktop: ClientPermissionSnapshot = {};
      if (isTauri) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const status = await invoke<Record<string, string | boolean | number | null>>(
            'get_desktop_capability_status',
          );
          nativeDesktop = {
            native_platform: status.platform || 'desktop',
            native_shell_available: status.shell_available,
            native_app_discovery_available: status.app_discovery_available,
            native_app_launch_available: status.app_launch_available,
            native_screen_capture_available: status.screen_capture_available,
            native_input_available: status.input_available,
            accessibility_permission: status.accessibility_permission,
            screen_recording_permission: status.screen_recording_permission,
          };
        } catch {
          nativeDesktop = {
            native_platform: 'desktop',
            accessibility_permission: 'unknown',
            screen_recording_permission: 'unknown',
          };
        }
      }
      if (disposed) return;
      setClientPermissions({ ...snapshot, ...nativeDesktop });
    };

    void refreshPermissions();
    const onSensorChange = () => void refreshPermissions();
    window.addEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
    window.addEventListener('visibilitychange', onSensorChange);
    const interval = window.setInterval(refreshPermissions, 30000);
    return () => {
      disposed = true;
      window.removeEventListener(SENSOR_PERMISSIONS_CHANGED, onSensorChange);
      window.removeEventListener('visibilitychange', onSensorChange);
      window.clearInterval(interval);
    };
  }, [isTauri, sensorPrimerSeen, setClientPermissions, wakeEnabled]);

  useEffect(() => {
    if (!isTauri) {
      setClientRuntime({ lastError: 'Native runtime unavailable outside desktop client' });
      return;
    }
    let disposed = false;
    const refreshRuntime = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status: any = await invoke('get_runtime_resilience_status');
        if (disposed) return;
        setClientRuntime({
          autostartSupported: Boolean(status.autostart_supported),
          autostartEnabled: Boolean(status.autostart_enabled),
          closeToBackground: Boolean(status.close_to_background),
          startedInBackground: Boolean(status.started_in_background),
          backendNodeRunning: Boolean(status.backend_node_running),
          backendPythonRunning: Boolean(status.backend_python_running),
          nodeRestarts: Number(status.node_restarts || 0),
          pythonRestarts: Number(status.python_restarts || 0),
          globalShortcut: String(status.global_shortcut || 'Alt+Space'),
          lastError: '',
        });
      } catch (err: any) {
        if (disposed) return;
        setClientRuntime({ lastError: err?.message || 'Native runtime status unavailable' });
      }
    };
    void refreshRuntime();
    const interval = window.setInterval(refreshRuntime, 30000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [isTauri, setClientRuntime]);

  useEffect(() => {
    if (!isTauri || closeToBackgroundSyncRef.current) return;
    closeToBackgroundSyncRef.current = true;
    const syncClosePreference = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status: any = await invoke('get_runtime_resilience_status');
        const saved = localStorage.getItem('lumi_close_to_background');
        if (status?.started_in_background) {
          localStorage.setItem('lumi_close_to_background', 'true');
          await invoke('set_close_to_background', { enabled: true });
        } else if (saved === 'true' || saved === 'false') {
          await invoke('set_close_to_background', { enabled: saved === 'true' });
        }
      } catch {}
    };
    void syncClosePreference();
  }, [closeToBackgroundSyncRef, isTauri]);

  const wakeWord = useWakeWord({
    socket,
    startCallRef,
    enabled: wakeEnabled,
    keyword: 'Lumi',
    voiceId: selectedVoiceId,
    personalityId: 'lumi',
    agentId: 'lumi',
    startCallOptions: voiceScopeOptions,
    onDetection: () => sounds.playWakeChime(),
    canAcceptWake: ownerVoiceGateOpen,
    isCallActive: () => callState !== 'idle',
    onInterrupt: () => interrupt(),
  });

  // ── Biometrics: voiceprint + face recognition + presence ──
  const facePresenceRequested = (
    backgroundFaceRecognitionOptedIn &&
    cameraAccessEnabled &&
    workDomain === 'personal'
  );
  const faceRecognition = useFaceRecognition({
    enabled: facePresenceRequested && callState === 'idle',
    socket,
  });
  const presence = usePresence({
    enabled: facePresenceRequested && faceRecognition.hasTemplates,
    socket,
    faceResult: faceRecognition.result,
    voiceprintResult: voiceprint.result,
    userId: workDomain === 'personal' ? user?.uid : undefined,
  });

  // Idle→active return greeting — listens for ambient idle reports and fires on return
  const lastIdleRef = useRef<number>(0);
  const greetedRef = useRef(false);
  useEffect(() => { lastIdleRef.current = 0; greetedRef.current = false; }, [socket, user?.uid, workDomain]);
  useEffect(() => {
    if (!socket) return;
    const onIdleReport = (data: { idle_ms: number; idle_seconds: number }) => {
      const idleS = data.idle_seconds ?? (data.idle_ms / 1000);
      const wasAway = lastIdleRef.current > IDLE_AWAY_SECONDS;
      const isBack = idleS < RETURN_IDLE_SECONDS;
      const allowProactiveGreeting = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
      if (wasAway && isBack && !greetedRef.current && allowProactiveGreeting && callState === 'idle' && !isMuted && volume > 0 && workDomain === 'personal') {
        greetedRef.current = true;
        // LLM-generated personalized greeting — server generates, TTS speaks
        socket.emit('greeting:generate', { scene: 'return' });
      }
      if (idleS >= IDLE_AWAY_SECONDS) {
        greetedRef.current = false;
      }
      lastIdleRef.current = idleS;
    };
    socket.on('ambient:idle_echo', onIdleReport);
    return () => { socket.off('ambient:idle_echo', onIdleReport); };
  }, [socket, callState, isMuted, volume, workDomain, user?.uid]);

  useEffect(() => {
    if (callError) toast.error(callError);
  }, [callError]);
  const { endMeetingAndReport, endVoiceCallFromUI, openMeetingModeWithConfirm, copyMeetingNotes, downloadMeetingNotes, formatMeetingTime, toggleMeetingCapturePaused, clearMeetingNotes, confirmOperationModeChange } = useMeetingWorkflow({
    meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingNotes, formatMeetingNoteForExport, lang,
    meetingIdentityRef, setMeetingReport, meetingStorageKeys, setMeetingReportGenerating, workDomain, orgConnection,
    aiConfig, lastLegalMeetingArchiveRef, setLegalMeetingCaseTitle, user, waitForMeetingRefinement, stopMeetingAudio,
    setMeetingNotesOpen, operationMode, endCall, setMeetingPaused, meetingVoiceActiveRef, meetingStartAttemptRef,
    callState, setOperationMode, meetingPaused, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount,
    setMeetingStartedAt, lastMeetingTranscriptRef, setPendingOperationMode, pendingOperationMode,
    resetMeetingCapture
  });

  const refreshKnowledgeRuntimeState = useCallback(async () => {
    const sequence = ++knowledgeRefreshSequenceRef.current;
    const domain: 'personal' | 'work' = workDomain === 'work' ? 'work' : 'personal';
    const orgId = domain === 'work' ? orgConnection?.orgId || '' : '';
    const next = emptyKnowledgeRuntimeState(domain, orgId);
    const errors: string[] = [];

    if (domain === 'work' && (!orgConnection?.connected || !orgId)) {
      next.refreshedAt = Date.now();
      next.lastError = 'organization_context_unavailable';
      if (sequence === knowledgeRefreshSequenceRef.current) setKnowledgeRuntimeState(next);
      return;
    }

    try {
      const query = new URLSearchParams({ domain });
      if (orgId) query.set('orgId', orgId);
      const response = await apiFetch(`/api/files/list?${query.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `knowledge_files_${response.status}`);
      const files = Array.isArray(payload?.files) ? payload.files : [];
      next.totalFiles = files.length;
      for (const file of files) {
        const status = String(file?.extractionStatus || file?.status || 'ready').toLowerCase();
        if (file?.syncError && status !== 'partial') next.failedFiles += 1;
        else if (status === 'indexed') next.indexedFiles += 1;
        else if (status === 'partial') next.partialFiles += 1;
        else if (status === 'failed') next.failedFiles += 1;
        else if (status === 'unsupported') next.unsupportedFiles += 1;
        else next.pendingFiles += 1;
      }
    } catch (error: any) {
      errors.push(error?.message || String(error));
    }

    if (domain === 'work') {
      try {
        const response = await apiFetch('/api/org/kb/stats');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || `organization_knowledge_${response.status}`);
        next.orgArticles = {
          total: Number(payload?.totalArticles || 0),
          published: Number(payload?.publishedArticles || 0),
          indexed: Number(payload?.indexedArticles || 0),
          missingIndex: Number(payload?.missingIndexArticles || 0),
          stale: Number(payload?.staleArticles || 0),
        };
      } catch (error: any) {
        errors.push(error?.message || String(error));
      }
    }

    next.refreshedAt = Date.now();
    next.lastError = errors.join('; ');
    if (sequence === knowledgeRefreshSequenceRef.current) setKnowledgeRuntimeState(next);
  }, [knowledgeRefreshSequenceRef, orgConnection?.connected, orgConnection?.orgId, setKnowledgeRuntimeState, workDomain]);

  useEffect(() => {
    void refreshKnowledgeRuntimeState();
    const interval = window.setInterval(() => void refreshKnowledgeRuntimeState(), 60000);
    return () => {
      knowledgeRefreshSequenceRef.current += 1;
      window.clearInterval(interval);
    };
  }, [knowledgeRefreshSequenceRef, refreshKnowledgeRuntimeState]);

  useEffect(() => {
    let delayedRefresh: number | null = null;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.domain && detail.domain !== workDomain) return;
      if (workDomain === 'work' && detail.orgId && detail.orgId !== orgConnection?.orgId) return;
      void refreshKnowledgeRuntimeState();
      if (delayedRefresh !== null) window.clearTimeout(delayedRefresh);
      delayedRefresh = window.setTimeout(() => void refreshKnowledgeRuntimeState(), 1800);
    };
    window.addEventListener('lumi:knowledge-updated', handler);
    return () => {
      window.removeEventListener('lumi:knowledge-updated', handler);
      if (delayedRefresh !== null) window.clearTimeout(delayedRefresh);
    };
  }, [orgConnection?.orgId, refreshKnowledgeRuntimeState, workDomain]);

  useEffect(() => {
    setOrganizationWorkspaceView('dashboard');
  }, [orgConnection?.orgId, setOrganizationWorkspaceView]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.orgId && detail.orgId !== orgConnection?.orgId) return;
      const view = normalizeOrganizationWorkspaceView(detail.activeView);
      if (view && canAccessOrganizationWorkspaceView(orgConnection?.orgRole, view)) {
        setOrganizationWorkspaceView(view);
      }
    };
    window.addEventListener('lumi:org-view-changed', handler);
    return () => window.removeEventListener('lumi:org-view-changed', handler);
  }, [orgConnection?.orgId, orgConnection?.orgRole, setOrganizationWorkspaceView]);

  // Listen for org navigation events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab === 'home') {
        surfaceReturnTargetRef.current = 'home';
        windowCommand('reset');
        dismissUtilitySurfaces();
        setActiveTab('home');
        return;
      }
      if (detail?.tab) {
        if (detail.tab === 'org' && detail.sub) {
          queueOrganizationWorkspaceRoute(detail.sub, detail.articleId);
        }
        if (detail.tab === 'chat' || detail.tab === 'command-center') {
          openCommandCenter('office');
          return;
        }
        // Anyone can open the org tab — join/create/connect handled by OrgPortal
        setActiveTab(detail.tab);
      }
    };
    window.addEventListener('lumi:navigate', handler);
    return () => window.removeEventListener('lumi:navigate', handler);
  }, [dismissUtilitySurfaces, openCommandCenter, setActiveTab, surfaceReturnTargetRef, windowCommand]);

  // Read system volume for voice output and proactive greetings.
  useEffect(() => {
    systemService.getVolume().then(setVolume).catch(() => setVolume(null));
  }, [setVolume]);
  return {
    ...previousBindings, endMeetingAndReport, wakeWord, endVoiceCallFromUI, openMeetingModeWithConfirm, facePresenceRequested, faceRecognition, presence,
    copyMeetingNotes, downloadMeetingNotes, formatMeetingTime, toggleMeetingCapturePaused, clearMeetingNotes, confirmOperationModeChange
  } as const;
}

function useDesktopWallpaper(previousBindings: ReturnType<typeof useDesktopRuntimeAndPreferences>) {
  const { wallpaperAutomationTimerRef, wallpaperPresentationRef, inferWallpaperWorkspace, wallpaperWorkspaceRef, isWallpaperModeRef, syncWallpaperModeView, wallpaperNativeTransitionDepthRef, chatOpen, isDesktopWidgetMode, wallpaperBeforeAutomationRef, addNotification, t, isWallpaperMode, setWallpaperWorkPromptVisible, socket, setMcpActivities } = previousBindings;


  const applyWallpaperMode = useCallback(async (
    enabled: boolean,
    options: {
      silent?: boolean;
      timeoutMs?: number;
      presentation?: WallpaperPresentation;
      workspace?: WallpaperWorkspace;
    } = {},
  ) => {
    if (wallpaperAutomationTimerRef.current) {
      clearTimeout(wallpaperAutomationTimerRef.current);
      wallpaperAutomationTimerRef.current = null;
    }

    const requestedPresentation = options.presentation
      || (enabled ? 'workbench' : wallpaperPresentationRef.current);
    const requestedWorkspace = options.workspace
      || (enabled && requestedPresentation === 'workbench'
        ? inferWallpaperWorkspace()
        : wallpaperWorkspaceRef.current);
    const previous = {
      enabled: isWallpaperModeRef.current,
      presentation: wallpaperPresentationRef.current,
      workspace: wallpaperWorkspaceRef.current,
    };
    syncWallpaperModeView(enabled, requestedPresentation, requestedWorkspace);
    let resolvedState = {
      enabled,
      presentation: requestedPresentation,
      workspace: requestedWorkspace,
    };

    try {
      wallpaperNativeTransitionDepthRef.current += 1;
      const actual = await systemService.setWallpaperMode(
        enabled,
        requestedPresentation,
        requestedWorkspace,
      );
      resolvedState = actual;
      syncWallpaperModeView(actual.enabled, actual.presentation, actual.workspace);
      await systemService.setAlwaysOnTop(
        actual.enabled
          ? actual.presentation === 'desktop-control'
          : chatOpen || isDesktopWidgetMode,
      );
    } catch (error) {
      syncWallpaperModeView(previous.enabled, previous.presentation, previous.workspace);
      await systemService.setAlwaysOnTop(
        previous.enabled
          ? previous.presentation === 'desktop-control'
          : chatOpen || isDesktopWidgetMode,
      ).catch(() => {});
      console.error('Wallpaper mode transition failed:', error);
      toast.error('Wallpaper mode could not be changed');
      throw error;
    } finally {
      wallpaperNativeTransitionDepthRef.current = Math.max(
        0,
        wallpaperNativeTransitionDepthRef.current - 1,
      );
    }

    if (enabled && requestedPresentation === 'desktop-control' && options.timeoutMs) {
      wallpaperAutomationTimerRef.current = setTimeout(() => {
        const restore = wallpaperBeforeAutomationRef.current || {
          enabled: false,
          presentation: 'workbench' as WallpaperPresentation,
          workspace: wallpaperWorkspaceRef.current,
        };
        wallpaperAutomationTimerRef.current = null;
        wallpaperNativeTransitionDepthRef.current += 1;
        void systemService.setWallpaperMode(restore.enabled, restore.presentation, restore.workspace)
          .then(actual => {
            wallpaperBeforeAutomationRef.current = null;
            syncWallpaperModeView(actual.enabled, actual.presentation, actual.workspace);
            void systemService.setAlwaysOnTop(
              actual.enabled
                ? actual.presentation === 'desktop-control'
                : chatOpen || isDesktopWidgetMode,
            ).catch(() => {});
            addNotification({
              type: 'system',
              title: 'Lumi',
              message: t.wallpaperAutoRestored || 'Wallpaper mode restored after desktop control timeout',
            });
          })
          .catch(async error => {
            console.error('Wallpaper mode restore failed:', error);
            try {
              const safeState = await systemService.setWallpaperMode(false, 'workbench', restore.workspace);
              wallpaperBeforeAutomationRef.current = null;
              syncWallpaperModeView(safeState.enabled, safeState.presentation, safeState.workspace);
              await systemService.setAlwaysOnTop(chatOpen || isDesktopWidgetMode).catch(() => {});
            } catch (safeExitError) {
              console.error('Wallpaper mode safe exit failed:', safeExitError);
              addNotification({
                type: 'warning',
                title: 'Lumi',
                message: 'Desktop-control wallpaper could not be restored automatically.',
              });
            }
          })
          .finally(() => {
            wallpaperNativeTransitionDepthRef.current = Math.max(
              0,
              wallpaperNativeTransitionDepthRef.current - 1,
            );
          });
      }, Math.max(15_000, options.timeoutMs));
    }

    if (!options.silent) {
      toast(enabled ? (t.wallpaperFusionActive || 'Wallpaper Fusion Active') : (t.standardFocusMode || 'Standard Desktop'), {
        icon: enabled ? <Sparkles className="text-celestial-saturn" /> : <Box className="text-white/40" />
      });
    }
    return resolvedState;
  }, [wallpaperAutomationTimerRef, wallpaperPresentationRef, inferWallpaperWorkspace, wallpaperWorkspaceRef, isWallpaperModeRef, syncWallpaperModeView, wallpaperNativeTransitionDepthRef, chatOpen, isDesktopWidgetMode, wallpaperBeforeAutomationRef, addNotification, t.wallpaperAutoRestored, t.wallpaperFusionActive, t.standardFocusMode]);

  useEffect(() => {
    let disposed = false;
    let unlisten: undefined | (() => void);

    void systemService.getWallpaperMode()
      .then(state => {
        if (!disposed) syncWallpaperModeView(state.enabled, state.presentation, state.workspace);
      })
      .catch(error => console.error('Failed to read wallpaper mode:', error));

    const hasTauriRuntime = Boolean(
      (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__ || (window as any).__TAURI__,
    );
    if (hasTauriRuntime) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<{
          enabled?: boolean;
          presentation?: WallpaperPresentation;
          workspace?: WallpaperWorkspace;
        }>('lumi:wallpaper-mode-changed', event => {
          if (!disposed) {
            const enabled = Boolean(event.payload?.enabled);
            if (!enabled && wallpaperNativeTransitionDepthRef.current === 0) {
              if (wallpaperAutomationTimerRef.current) {
                clearTimeout(wallpaperAutomationTimerRef.current);
                wallpaperAutomationTimerRef.current = null;
              }
              wallpaperBeforeAutomationRef.current = null;
            }
            syncWallpaperModeView(
              enabled,
              event.payload?.presentation || wallpaperPresentationRef.current,
              event.payload?.workspace || wallpaperWorkspaceRef.current,
            );
          }
        }))
        .then(stop => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(error => console.error('Failed to listen for wallpaper mode changes:', error));
    }

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [syncWallpaperModeView, wallpaperAutomationTimerRef, wallpaperBeforeAutomationRef, wallpaperNativeTransitionDepthRef, wallpaperPresentationRef, wallpaperWorkspaceRef]);

  useEffect(() => () => {
    if (!isWallpaperModeRef.current || wallpaperPresentationRef.current !== 'desktop-control') return;
    const restore = wallpaperBeforeAutomationRef.current || {
      enabled: false,
      presentation: 'workbench' as WallpaperPresentation,
      workspace: wallpaperWorkspaceRef.current,
    };
    wallpaperBeforeAutomationRef.current = null;
    void systemService.setWallpaperMode(
      restore.enabled,
      restore.presentation,
      restore.workspace,
    ).catch(error => console.error('Failed to safely exit desktop-control wallpaper:', error));
  }, [isWallpaperModeRef, wallpaperBeforeAutomationRef, wallpaperPresentationRef, wallpaperWorkspaceRef]);

  const toggleWallpaperMode = useCallback(() => {
    void applyWallpaperMode(!isWallpaperMode, { presentation: 'workbench' });
  }, [applyWallpaperMode, isWallpaperMode]);

  const dismissWallpaperWorkPrompt = useCallback(() => {
    setWallpaperWorkPromptVisible(false);
  }, [setWallpaperWorkPromptVisible]);

  const enterWallpaperFromWorkPrompt = useCallback(() => {
    dismissWallpaperWorkPrompt();
    void applyWallpaperMode(true, { presentation: 'workbench' });
  }, [applyWallpaperMode, dismissWallpaperWorkPrompt]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        enabled?: boolean;
        timeoutMs?: number;
        respond?: (result: any) => void;
        reject?: (message: string) => void;
      }>).detail || {};
      void (async () => {
        const enabled = Boolean(detail.enabled);
        const capturedRestore = enabled && !wallpaperBeforeAutomationRef.current;
        try {
          if (capturedRestore) {
            wallpaperBeforeAutomationRef.current = {
              enabled: isWallpaperModeRef.current,
              presentation: wallpaperPresentationRef.current,
              workspace: wallpaperWorkspaceRef.current,
            };
          } else if (!enabled && wallpaperBeforeAutomationRef.current) {
            const restore = wallpaperBeforeAutomationRef.current;
            if (wallpaperAutomationTimerRef.current) {
              clearTimeout(wallpaperAutomationTimerRef.current);
              wallpaperAutomationTimerRef.current = null;
            }
            const restored = await applyWallpaperMode(restore.enabled, {
              silent: true,
              presentation: restore.presentation,
              workspace: restore.workspace,
            });
            wallpaperBeforeAutomationRef.current = null;
            detail.respond?.(restored);
            return;
          }

          const result = await applyWallpaperMode(enabled, {
            silent: true,
            presentation: 'desktop-control',
            timeoutMs: enabled ? detail.timeoutMs : undefined,
          });
          if (!enabled) wallpaperBeforeAutomationRef.current = null;
          detail.respond?.(result);
        } catch (error: any) {
          if (capturedRestore) wallpaperBeforeAutomationRef.current = null;
          detail.reject?.(error?.message || String(error));
        }
      })();
    };
    window.addEventListener('lumi:set-wallpaper-mode', handler);
    return () => {
      window.removeEventListener('lumi:set-wallpaper-mode', handler);
      if (wallpaperAutomationTimerRef.current) {
        clearTimeout(wallpaperAutomationTimerRef.current);
        wallpaperAutomationTimerRef.current = null;
      }
    };
  }, [applyWallpaperMode, isWallpaperModeRef, wallpaperAutomationTimerRef, wallpaperBeforeAutomationRef, wallpaperPresentationRef, wallpaperWorkspaceRef]);

  // MCP Live Activity socket listener
  useEffect(() => {
    if (!socket) return;
    const handler = (data: any) => {
      const activity = { ...data, id: Date.now().toString(), time: Date.now() };
      setMcpActivities(prev => [activity, ...prev].slice(0, 20));
      const status = String(data?.status || '').toLowerCase();
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(status)) {
        addNotification({
          type: status === 'completed' ? 'success' : 'warning',
          title: data?.title || data?.action || 'MCP',
          message: data?.error || data?.message || data?.path || status,
        });
      }
    };
    socket.on('mcp:activity', handler);
    return () => { socket.off('mcp:activity', handler); };
  }, [socket, addNotification, setMcpActivities]);
  return {
    ...previousBindings, toggleWallpaperMode, applyWallpaperMode, enterWallpaperFromWorkPrompt, dismissWallpaperWorkPrompt
  } as const;
}

function useDesktopNotificationsAndShortcuts(previousBindings: ReturnType<typeof useDesktopWallpaper>) {
  const { socket, setAgentStatus, seenWorkflowToolEvents, triggerPetReaction, petPrefsSavingRef, workDomain, orgConnection, setSelectedPet, petStorageKeys, setEquippedAccessories, addNotification, lang, chatOpen, setIsSearchOpen, setIsNotificationPanelOpen, openCommandCenter, callStateRef, startStandardVoiceCall, endCall, sanctuaryOpen, memoryLabOpen, closeMemoryAvatar, knowledgeOpen, closeKnowledgeBase, isWallpaperWorkbench, toggleWallpaperMode, isSearchOpen, meetingModeRef, interrupt, startCall, selectedVoiceId, getVoiceScopeOptions, isSpacebarRecording, setTime } = previousBindings;


  // Workflow status listener — agent:status, agent:tool_call, agent:response, agent:error
  useEffect(() => {
    if (!socket) return;

    let terminalResponseSeen = false;
    let activeForegroundRequestId: string | null = null;
    let activeForegroundSource: string | null = null;
    let terminalResetTimer: ReturnType<typeof setTimeout> | null = null;
    const isDetachedBackgroundEvent = (data: { source?: string }) =>
      /^(?:background|proactive|scheduler)/i.test(String(data.source || ''));
    const acceptsForegroundEvent = (data: { requestId?: string; source?: string }, claim = false) => {
      if (isDetachedBackgroundEvent(data)) return false;
      const requestId = String(data.requestId || '').trim();
      const source = String(data.source || '').trim() || null;
      if (!requestId) {
        if (activeForegroundRequestId && source && activeForegroundSource && source !== activeForegroundSource) return false;
        if (claim && !activeForegroundSource) activeForegroundSource = source;
        return true;
      }
      if (!activeForegroundRequestId) {
        if (claim) {
          activeForegroundRequestId = requestId;
          activeForegroundSource = source;
        }
        return claim;
      }
      return activeForegroundRequestId === requestId;
    };

    const scheduleTerminalReset = (terminalRequestId: string | null) => {
      if (terminalResetTimer) clearTimeout(terminalResetTimer);
      terminalResetTimer = setTimeout(() => {
        if (terminalRequestId && activeForegroundRequestId !== terminalRequestId) return;
        setAgentStatus('idle');
        activeForegroundRequestId = null;
        activeForegroundSource = null;
        terminalResetTimer = null;
      }, 5000);
    };

    const onStatus = (data: { status: string; agentName?: string; phase?: string; detail?: string; source?: string; requestId?: string }) => {
      if (data.status === 'thinking') {
        if (isDetachedBackgroundEvent(data)) return;
        if (data.requestId && activeForegroundRequestId !== data.requestId) {
          activeForegroundRequestId = data.requestId;
          activeForegroundSource = data.source || null;
          seenWorkflowToolEvents.current.clear();
        } else if (!acceptsForegroundEvent(data, true)) return;
        terminalResponseSeen = false;
        if (terminalResetTimer) {
          clearTimeout(terminalResetTimer);
          terminalResetTimer = null;
        }
        const isBackground = data.phase === 'background';
        setAgentStatus(isBackground ? 'background' : 'thinking');
      } else if (data.status === 'idle') {
        if (!acceptsForegroundEvent(data)) return;
        // "idle" is a transport/pipeline state, not evidence that user work completed.
        // A finalized agent:response event owns the semantic done/blocked state.
        if (!terminalResponseSeen) setAgentStatus('idle');
      } else if (data.status === 'error') {
        if (!acceptsForegroundEvent(data, true)) return;
        terminalResponseSeen = true;
        const terminalRequestId = data.requestId || activeForegroundRequestId;
        setAgentStatus('error');
        scheduleTerminalReset(terminalRequestId);
      }
    };

    const onToolCall = (data: { correlationId?: string; name: string; arguments?: any; args?: any; result?: string; error?: string; source?: string; requestId?: string }) => {
      if (!acceptsForegroundEvent(data, true)) return;
      const phase = data.error !== undefined ? 'error' : data.result !== undefined ? 'result' : 'start';
      if (data.correlationId) {
        const eventKey = `${data.correlationId}:${phase}`;
        if (seenWorkflowToolEvents.current.has(eventKey)) return;
        seenWorkflowToolEvents.current.add(eventKey);
      }
      setAgentStatus('executing');
      if (data.error !== undefined) {
        triggerPetReaction('failed', 2000);
      } else if (data.result !== undefined) {
        let structured: Record<string, unknown> | null = null;
        let parsed: unknown = String(data.result || '').trim();
        for (let attempt = 0; attempt < 3 && typeof parsed === 'string' && parsed; attempt += 1) {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            parsed = null;
          }
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          structured = parsed as Record<string, unknown>;
        }
        const status = typeof structured?.status === 'string'
          ? structured.status.trim().toLowerCase()
          : '';
        const resultFailed = (
          structured?.ok === false
          || structured?.success === false
          || structured?.verified === false
          || ['blocked', 'cancelled', 'canceled', 'error', 'failed', 'timeout', 'timed_out'].includes(status)
        );
        triggerPetReaction(resultFailed ? 'failed' : 'jump', resultFailed ? 2000 : 1200);
      }
    };

    const onResponse = (data: {
      text: string;
      agentName?: string;
      source?: string;
      requestId?: string;
      finalized?: boolean;
      blocked?: boolean;
      reason?: string;
    }) => {
      if (!acceptsForegroundEvent(data, true)) return;
      const terminalReason = String(data.reason || '').trim().toLowerCase();
      const responseBlocked = (
        data.finalized !== true
        || data.blocked === true
        || !String(data.text || '').trim()
        || ['cancelled', 'canceled', 'voiceprint_rejected'].includes(terminalReason)
      );
      terminalResponseSeen = true;
      const terminalRequestId = data.requestId || activeForegroundRequestId;
      setAgentStatus(responseBlocked ? 'error' : 'done');
      scheduleTerminalReset(terminalRequestId);
    };

    const onError = (data: { message: string; source?: string; requestId?: string }) => {
      if (!acceptsForegroundEvent(data, true)) return;
      const terminalRequestId = data.requestId || activeForegroundRequestId;
      setAgentStatus('error');
      scheduleTerminalReset(terminalRequestId);
    };

    const onProactive = (data: { type?: string; taskId: string; message: string; timestamp: string }) => {
      const taskId = data.type || data.taskId;
      if (taskId === 'greeting' && localStorage.getItem('lumi_allow_proactive_voice') !== 'true') return;
      // Trigger pet reaction
      switch (taskId) {
        case 'reminder_check': triggerPetReaction('wave', 2000); break;
        case 'daily_summary': triggerPetReaction('wave', 2000); break;
        case 'evening_wrapup': triggerPetReaction('wave', 2000); break;
        case 'memory_decay': triggerPetReaction('jump', 1500); break;
        case 'behavioral_analysis': triggerPetReaction('jump', 1500); break;
        default: triggerPetReaction('jump', 1200); break;
      }
    };

    // AutonomousFeed and CommandCenter own background task projections.
    // These events cannot settle or replace the foreground conversation.

    const onDesktopControlState = (data: any) => {
      const id = `desktop-control-${String(data?.leaseId || data?.taskId || 'current')}`;
      const status = String(data?.status || '');
      if (status === 'released' || status === 'expired') {
        toast.dismiss(id);
        return;
      }
      if (status === 'paused') {
        toast.warning('Lumi paused desktop control because user activity or a higher-priority task was detected.', { id, duration: 6000 });
        return;
      }
      if (status === 'waiting') {
        toast('Desktop control is waiting for the current owner to finish.', { id, duration: 4000 });
        return;
      }
      if (status === 'active') {
        toast('Lumi is controlling the desktop for the active task.', { id, duration: 2500 });
      }
    };

    socket.on('agent:status', onStatus);
    socket.on('agent:desktop_control_state', onDesktopControlState);
    socket.on('agent:tool_call', onToolCall);
    socket.on('agent:tool', onToolCall);
    socket.on('agent:response', onResponse);
    socket.on('agent:error', onError);
    socket.on('agent:proactive', onProactive);
    const onPreferencesChanged = (data: { key: string; value: any; domain?: string; orgId?: string }) => {
      if (petPrefsSavingRef.current) return; // ignore our own changes
      if (data.domain && data.domain !== workDomain) return;
      if (data.domain === 'work' && data.orgId !== orgConnection?.orgId) return;
      if (data.key === 'pet' && data.value) {
        const { pet, accessories } = data.value;
        if (pet) {
          const resolved = resolvePetPreference(pet);
          if (resolved) {
            setSelectedPet(resolved);
            localStorage.setItem(petStorageKeys.pet, JSON.stringify(serializePetPreference(resolved)));
          }
        } else {
          setSelectedPet(null);
          localStorage.removeItem(petStorageKeys.pet);
        }
        if (accessories) {
          setEquippedAccessories(accessories);
          localStorage.setItem(petStorageKeys.accessories, JSON.stringify(accessories));
        }
        addNotification({
          type: 'system',
          title: 'Lumi',
          message: uiMessage('desktop-ui.desktop-avatar-synced-from-another.6c2486fffe', (lang === 'zh') ? 'zh' : 'en'),
        });
      }
    };
    const onAgentNotification = (data: { type: string; level: string; message: string }) => {
      addNotification({ type: data.level === 'critical' ? 'warning' : data.level === 'warning' ? 'warning' : 'info', title: data.type || 'Lumi', message: data.message });
    };

    const onWakeDetected = (data: { keyword: string }) => {
      addNotification({
        type: 'info',
        title: uiMessage('desktop-ui.wake-word-detected.3b2cda12ab', (lang === 'zh') ? 'zh' : 'en'),
        message: formatUiMessage('desktop-ui.detected-wake-word-value0.5617ff6dc9', { value0: data.keyword }, (lang === 'zh') ? 'zh' : 'en'),
      });
    };
    const onWakeError = (data: { message: string }) => {
      console.warn('[Wake] Error:', data.message);
    };
    const onWakeStarted = () => {
      addNotification({
        type: 'info',
        title: uiMessage('desktop-ui.voice-wake.a96c749ad3', (lang === 'zh') ? 'zh' : 'en'),
        message: uiMessage('desktop-ui.voice-wake-service-started.c82b9ac02d', (lang === 'zh') ? 'zh' : 'en'),
      });
    };

    socket.on('preferences:changed', onPreferencesChanged);
    socket.on('agent:notification', onAgentNotification);
    socket.on('wake:detected', onWakeDetected);
    socket.on('wake:error', onWakeError);
    socket.on('wake:started', onWakeStarted);

    return () => {
      socket.off('agent:status', onStatus);
      socket.off('agent:desktop_control_state', onDesktopControlState);
      socket.off('agent:tool_call', onToolCall);
      socket.off('agent:tool', onToolCall);
      socket.off('agent:response', onResponse);
      socket.off('agent:error', onError);
      socket.off('agent:proactive', onProactive);
      socket.off('preferences:changed', onPreferencesChanged);
      socket.off('agent:notification', onAgentNotification);
      socket.off('wake:detected', onWakeDetected);
      socket.off('wake:error', onWakeError);
      socket.off('wake:started', onWakeStarted);
      if (terminalResetTimer) clearTimeout(terminalResetTimer);
    };
  }, [addNotification, lang, orgConnection?.orgId, petPrefsSavingRef, petStorageKeys, seenWorkflowToolEvents, setAgentStatus, setEquippedAccessories, setSelectedPet, socket, triggerPetReaction, workDomain]);

  // Fetch pet preferences from server on mount (cross-device sync source of truth)
  useEffect(() => {
    const fetchPrefs = async () => {
      setSelectedPet(null);
      setEquippedAccessories([]);
      try {
        const res = await fetch('/api/preferences/pet', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.pet) {
            const resolved = resolvePetPreference(data.pet);
            if (resolved) {
              setSelectedPet(resolved);
              localStorage.setItem(petStorageKeys.pet, JSON.stringify(serializePetPreference(resolved)));
            }
          } else {
            localStorage.removeItem(petStorageKeys.pet);
          }
          const accessories = Array.isArray(data.accessories) ? data.accessories : [];
          setEquippedAccessories(accessories);
          localStorage.setItem(petStorageKeys.accessories, JSON.stringify(accessories));
        }
      } catch {}
    };
    fetchPrefs();
  }, [petStorageKeys, setEquippedAccessories, setSelectedPet]);

  useEffect(() => {
    const isInputFocused = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = (el as HTMLElement).tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (chatOpen && e.key === 'F6') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('lumi:focus-command-input'));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        setIsSearchOpen(false);
        setIsNotificationPanelOpen(false);
        openCommandCenter('office');
        return;
      }
      if (chatOpen && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('lumi:new-conversation'));
        return;
      }
      if (chatOpen && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'v' && !isInputFocused()) {
        e.preventDefault();
        void (async () => {
          let text = '';
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            text = await invoke<string>('get_clipboard_text');
          } catch {
            try {
              text = await navigator.clipboard.readText();
            } catch {}
          }
          if (text) window.dispatchEvent(new CustomEvent('lumi:replace-command-input', { detail: { text } }));
        })();
        return;
      }
      if (
        chatOpen
        && e.key === 'Enter'
        && !e.metaKey
        && !e.ctrlKey
        && !e.altKey
        && !e.shiftKey
        && !isInputFocused()
        && !['BUTTON', 'A'].includes((document.activeElement as HTMLElement | null)?.tagName || '')
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('lumi:submit-command-input'));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (callStateRef.current === 'idle') startStandardVoiceCall();
        else endCall();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        // Utility surfaces opened from the Command Center must unwind to
        // their recorded origin.  Handling them here prevents the global
        // Escape path from dropping the user onto Personal by accident.
        if (sanctuaryOpen || memoryLabOpen) {
          e.preventDefault();
          closeMemoryAvatar();
          return;
        }
        if (knowledgeOpen) {
          e.preventDefault();
          closeKnowledgeBase();
          return;
        }
        setIsSearchOpen(false);
        if (isWallpaperWorkbench) toggleWallpaperMode();
        return;
      }
      if (e.key === ' ' && !e.repeat) {
        if (isInputFocused()) return;
        if (isSearchOpen) return;
        if (meetingModeRef.current) return;
        e.preventDefault();
        const cs = callStateRef.current;
        if (cs === 'speaking') {
          interrupt();
          startCall(selectedVoiceId, 'lumi', 'lumi', getVoiceScopeOptions());
          isSpacebarRecording.current = true;
        } else if (cs === 'idle') {
          startCall(selectedVoiceId, 'lumi', 'lumi', getVoiceScopeOptions());
          isSpacebarRecording.current = true;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && isSpacebarRecording.current) {
        isSpacebarRecording.current = false;
        endCall();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [callStateRef, chatOpen, closeKnowledgeBase, closeMemoryAvatar, endCall, getVoiceScopeOptions, interrupt, isSearchOpen, isSpacebarRecording, isWallpaperWorkbench, knowledgeOpen, meetingModeRef, memoryLabOpen, openCommandCenter, sanctuaryOpen, selectedVoiceId, setIsNotificationPanelOpen, setIsSearchOpen, startCall, startStandardVoiceCall, toggleWallpaperMode]);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [setTime]);
  return {
    ...previousBindings
  } as const;
}

function useDesktopSurfaceControls(previousBindings: ReturnType<typeof useDesktopNotificationsAndShortcuts>) {
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

function useDesktopPresentation(previousBindings: ReturnType<typeof useDesktopSurfaceControls>) {
  const { t, desktopIcons, lang, openWindows, chatOpen, pendingOperationMode, isDesktopWidgetMode, selectedPet, equippedAccessories, petReaction, callState, audioLevel, transcript, operationMode, workDomain, wakeEnabled, wakeWord, startStandardVoiceCall, endVoiceCallFromUI, exitDesktopWidgetMode, hideDesktopWidgetMode, resolvedAppearanceMode, viewMode, desktopChrome, isCompactDesktopLayout, isWallpaperMode, wallpaperPresentation, wallpaperWorkspace, isWallpaperDesktopControl, wallpaper, wallpaperUrl, wallpaperInputRef, handleWallpaperUpload, isWallpaperWorkbench, applyWallpaperMode, personalScale, personalOpacity, syncRate, nexusReturnTarget, openCommandCenter, setSyncRate, handleTopbarPointerDown, toggleWindow, openSurface, closeSurface, setShowOnboarding, switchDomain, orgConnection, activeTab, setActiveTab, setMemoryLabOpen, setSanctuaryOpen, setSanctuaryAgent, setChatPrefill, knowledgeOpen, memoryLabOpen, sanctuaryOpen, setIsSearchOpen, setIsNotificationPanelOpen, isNotificationPanelOpen, unreadCount, socket, toggleMute, isMuted, toggleWallpaperMode, time, enterDesktopWidgetMode, handleWindowMinimize, handleWindowMaximize, isCompactWindowMode, handleWindowClose, openProactiveChat, isSearchOpen, dockPositionClassName, focusedWindow, minimizedWindows, user, onLogin, setPersonalizationSection, openMeetingModeWithConfirm, canCustomizeLumiAppearance, setSelectedPet, savePetPrefsToServer, facePresenceRequested, faceRecognition, presence, voiceprint, isTauri, interrupt, desktopIconAreaHeight, getDefaultDesktopIconPosition, launchExternalCapability, notifications, meetingNotesOpen, meetingPaused, legalMeetingCaseTitle, copyMeetingNotes, downloadMeetingNotes, setMeetingNotesOpen, meetingNotes, meetingSpeakerCount, meetingStartedAt, meetingReportGenerating, meetingReport, formatMeetingTime, meetingNoteHasSpeakerInfo, meetingSpeakerLabel, toggleMeetingCapturePaused, endMeetingAndReport, clearMeetingNotes, setPendingOperationMode, confirmOperationModeChange, wallpaperWorkPromptVisible, enterWallpaperFromWorkPrompt, dismissWallpaperWorkPrompt, sensorPrimerSeen, finishSensorPrimer, showOnboarding, askComputerProfileQuestion, isTrainingOpen, setIsTrainingOpen, focusOsWindow, minimizeOsWindow, closeWindow, openKnowledgeBase, setCreationRequestId, openMemoryAvatar, setLang, settingsSection, setSettingsSection, canUseExternalCapabilities, personalizationSection, petPreferenceScopeKey, handleSelectPet, setEquippedAccessories, renderTabContent, knowledgeLoaded, closeKnowledgeBase, chatLoaded, commandCenterView, setCommandCenterView, callError, chatPrefill, creationRequestId, chatAttachmentRequest, setChatAttachmentRequest, sanctuaryLoaded, sanctuaryAgent, closeMemoryAvatar, memoryAvatars, openMemoryAvatarLab, setMemoryAvatars, enterCreatedMemoryAvatar } = previousBindings;


  const appIcons = [
    { id: 'personality', label: t.personality || 'Personality Lab', icon: <UserIcon size={24} />, color: 'from-violet-500 to-fuchsia-600' },
    { id: 'kernel', label: t.kernelMonitor || 'Kernel Monitor', icon: <Activity size={24} />, color: 'from-orange-500 to-red-600' },
    { id: 'devices', label: t.devices || 'Devices', icon: <Cpu size={24} />, color: 'from-blue-600 to-cyan-400' },
    { id: 'personalization', label: t.personalization || 'Personalization', icon: <Brush size={24} />, color: 'from-cyan-400 to-indigo-600' },
    { id: 'settings', label: t.settings || 'OS Integrity', icon: <SettingsIcon size={24} />, color: 'from-gray-400 to-slate-600' },
  ];

  const desktopAppEntries = desktopIcons.filter(def => Boolean(def.windowId)).map(def => ({
    id: def.windowId!,
    label: def.label || (def.labelKey ? (t as any)[def.labelKey] || def.labelKey : def.id),
    icon: def.icon,
    color: def.colorClass,
  }));
  const utilityAppEntries = [
    { id: 'knowledge', label: t.knowledgeBase || 'Knowledge Base', icon: <BrainCircuit size={24} />, color: 'from-cyan-400 to-blue-600' },
    { id: 'notifications', label: t.notificationsLabel || 'Notifications', icon: <Bell size={24} />, color: 'from-amber-500 to-orange-600' },
    { id: 'terminal', label: t.terminal || 'Terminal', icon: <TerminalIcon size={24} />, color: 'from-green-500 to-emerald-600' },
    { id: 'voice', label: t.voiceLabel || 'Voice', icon: <Volume2 size={24} />, color: 'from-pink-500 to-rose-600' },
    { id: 'memory', label: t.memory || 'Memory', icon: <BrainCircuit size={24} />, color: 'from-cyan-500 to-blue-600' },
    { id: 'mcp', label: t.mcp || 'MCP', icon: <Wrench size={24} />, color: 'from-purple-500 to-violet-600' },
    { id: 'sync', label: t.sync || 'Sync', icon: <RefreshCw size={24} />, color: 'from-blue-500 to-indigo-600' },
    { id: 'reminders', label: t.reminders || 'Reminders', icon: <Calendar size={24} />, color: 'from-amber-500 to-orange-600' },
    { id: 'plans', label: t.learningPlans || (uiMessage('desktop-ui.learning-plans.5a08a014b3', (lang === 'zh') ? 'zh' : 'en')), icon: <Calendar size={24} />, color: 'from-celestial-saturn to-orange-600' },
    { id: 'tokens', label: t.tokens || 'Tokens', icon: <Circle size={24} />, color: 'from-celestial-mars to-celestial-saturn' },
    { id: 'profile', label: t.profile || 'Profile', icon: <UserIcon size={24} />, color: 'from-white/30 to-white/10' },
  ];
  const allAppEntries = [...appIcons, ...desktopAppEntries, ...utilityAppEntries]
    .filter((entry, index, list) => list.findIndex(other => other.id === entry.id) === index);
  const getWindowMeta = (windowId: string) => allAppEntries.find(entry => entry.id === windowId) || {
    id: windowId,
    label: windowId,
    icon: <Circle size={24} />,
    color: 'from-celestial-mars to-celestial-saturn',
  };

  const sphereSentiment =
    openWindows.includes('kernel') ? 'excited' :
    chatOpen ? 'focused' : 'default';

  const getWindowSize = (windowId: string) => {
    if (windowId === 'business') return { w: '1180px', h: '800px' };
    if (windowId === 'settings') return { w: '1050px', h: '720px' };
    if (windowId === 'knowledge') return { w: '1100px', h: '750px' };
    if (windowId === 'kernel') return { w: '1050px', h: '720px' };
    if (windowId === 'personality') return { w: '1050px', h: '720px' };
    if (windowId === 'generate') return { w: '1050px', h: '720px' };
    if (windowId === 'tools') return { w: '850px', h: '620px' };
    if (windowId === 'github-mcp') return { w: '850px', h: '620px' };
    if (windowId === 'notifications') return { w: '700px', h: '550px' };
    if (windowId === 'reminders') return { w: '650px', h: '620px' };
    if (windowId === 'plans') return { w: '980px', h: '700px' };
    if (windowId === 'devices') return { w: '900px', h: '700px' };
    if (windowId === 'tokens') return { w: '800px', h: '620px' };
    if (windowId === 'skills') return { w: '900px', h: '700px' };
    if (windowId === 'personalization') return { w: '1050px', h: '720px' };
    if (windowId === 'terminal') return { w: '900px', h: '600px' };
    return { w: '900px', h: '700px' };
  };
  const dockApps = [
    ...appIcons,
    ...openWindows
      .filter(windowId => windowId !== 'chat' && !appIcons.some(app => app.id === windowId))
      .map(getWindowMeta),
  ].filter(app => app.id !== 'devices');
  const operationModeOptions = [
    {
      id: 'meeting' as const,
      label: t.modeMeeting || (uiMessage('desktop-ui.meeting.e16a90b510', (lang === 'zh') ? 'zh' : 'en')),
      title: t.modeMeetingTitle || (uiMessage('desktop-ui.meeting-mode.958510fb80', (lang === 'zh') ? 'zh' : 'en')),
      description: t.modeMeetingDesc || (uiMessage('desktop-ui.starts-speech-to-text-records.eae4abc712', (lang === 'zh') ? 'zh' : 'en')),
      hint: t.modeMeetingHint || (uiMessage('desktop-ui.live-notes.578276ba0a', (lang === 'zh') ? 'zh' : 'en')),
      icon: <FileText size={16} />,
    },
  ];
  const pendingOperationModeOption = pendingOperationMode
    ? operationModeOptions.find(m => m.id === pendingOperationMode)
    : null;
  const tutorialLabel = t.showTutorial || (uiMessage('desktop-ui.tutorial.67f6f569ce', (lang === 'zh') ? 'zh' : 'en'));

  const handleShellContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
    e.preventDefault();
  }, []);

  if (isDesktopWidgetMode) {
    return (
      <DesktopWidgetPanel
        t={t}
        lang={lang}
        selectedPet={selectedPet}
        equippedAccessories={equippedAccessories}
        petReaction={petReaction}
        callState={callState}
        audioLevel={audioLevel}
        transcript={transcript}
        operationMode={operationMode}
        workDomain={workDomain}
        wakeEnabled={wakeEnabled}
        wakeListening={wakeWord.isListening}
        wakeError={wakeWord.error}
        onStartVoice={startStandardVoiceCall}
        onEndVoice={endVoiceCallFromUI}
        onExpand={() => void exitDesktopWidgetMode()}
        onHide={() => void hideDesktopWidgetMode()}
          onOpenPersonalization={() => void exitDesktopWidgetMode('personalization')}
      />
    );
  }
  return <DesktopShellView {...{
    resolvedAppearanceMode, viewMode, desktopChrome, isCompactDesktopLayout, isWallpaperMode, wallpaperPresentation,
    wallpaperWorkspace, handleShellContextMenu, isWallpaperDesktopControl, wallpaper, wallpaperUrl,
    wallpaperInputRef, handleWallpaperUpload, isWallpaperWorkbench, applyWallpaperMode, lang, personalScale,
    personalOpacity, syncRate, t, nexusReturnTarget, openCommandCenter, setSyncRate, handleTopbarPointerDown,
    toggleWindow, openSurface, closeSurface, setShowOnboarding, tutorialLabel, workDomain, switchDomain,
    orgConnection, activeTab, setActiveTab, setMemoryLabOpen, setSanctuaryOpen, setSanctuaryAgent, setChatPrefill,
    chatOpen, knowledgeOpen, memoryLabOpen, sanctuaryOpen, setIsSearchOpen, setIsNotificationPanelOpen,
    isNotificationPanelOpen, unreadCount, socket, toggleMute, isMuted, toggleWallpaperMode, time,
    enterDesktopWidgetMode, handleWindowMinimize, handleWindowMaximize, isCompactWindowMode, handleWindowClose,
    openProactiveChat, isSearchOpen, allAppEntries, dockPositionClassName, dockApps, openWindows, focusedWindow,
    minimizedWindows, user, onLogin, selectedPet, setPersonalizationSection, callState, petReaction,
    equippedAccessories, audioLevel, startStandardVoiceCall, endVoiceCallFromUI, operationMode,
    openMeetingModeWithConfirm, canCustomizeLumiAppearance, setSelectedPet, savePetPrefsToServer,
    facePresenceRequested, faceRecognition, presence, voiceprint, sphereSentiment, isTauri, interrupt, wakeEnabled,
    wakeWord, transcript, desktopIconAreaHeight, desktopIcons, getDefaultDesktopIconPosition,
    launchExternalCapability, notifications, meetingNotesOpen, meetingPaused, legalMeetingCaseTitle,
    copyMeetingNotes, downloadMeetingNotes, setMeetingNotesOpen, meetingNotes, meetingSpeakerCount, meetingStartedAt,
    meetingReportGenerating, meetingReport, formatMeetingTime, meetingNoteHasSpeakerInfo, meetingSpeakerLabel,
    toggleMeetingCapturePaused, endMeetingAndReport, clearMeetingNotes, pendingOperationModeOption,
    setPendingOperationMode, pendingOperationMode, confirmOperationModeChange, wallpaperWorkPromptVisible,
    enterWallpaperFromWorkPrompt, dismissWallpaperWorkPrompt, sensorPrimerSeen, finishSensorPrimer, showOnboarding,
    askComputerProfileQuestion, isTrainingOpen, setIsTrainingOpen, getWindowSize, getWindowMeta, focusOsWindow,
    minimizeOsWindow, closeWindow, openKnowledgeBase, setCreationRequestId, openMemoryAvatar, setLang,
    settingsSection, setSettingsSection, canUseExternalCapabilities, personalizationSection, petPreferenceScopeKey,
    handleSelectPet, setEquippedAccessories, renderTabContent, knowledgeLoaded, closeKnowledgeBase, chatLoaded,
    commandCenterView, setCommandCenterView, callError, chatPrefill, creationRequestId, chatAttachmentRequest,
    setChatAttachmentRequest, sanctuaryLoaded, sanctuaryAgent, closeMemoryAvatar, memoryAvatars, openMemoryAvatarLab,
    setMemoryAvatars, enterCreatedMemoryAvatar
  }} />;
}

export function DesktopUI(props: Parameters<typeof useDesktopSurfaceState>[0]) {
  const state0 = useDesktopSurfaceState(props);
  const state1 = useDesktopCaptureAndIdentity(state0);
  const state2 = useDesktopRuntimeAndPreferences(state1);
  const state3 = useDesktopWallpaper(state2);
  const state4 = useDesktopNotificationsAndShortcuts(state3);
  const state5 = useDesktopSurfaceControls(state4);
  return useDesktopPresentation(state5);
}
