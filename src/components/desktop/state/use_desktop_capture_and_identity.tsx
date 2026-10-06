import { useMeetingTranscript } from "../useMeetingTranscript";
import { type DesktopIconDefinition, externalCapabilityDesktopIcon } from "../launcher";
import { type ProactiveChatDetail, formatProactiveChatPrefill } from "../proactive_presentation";
import { businessWorkbenchCopy } from "../../../i18n/locales/businessWorkbench";
import { BriefcaseBusiness } from "lucide-react";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { sounds } from "../../../services/soundService";
import { Sparkles, Wrench } from "lucide-react";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { useAmbientPoller } from "@/hooks/useAmbientPoller";
import { useVoiceCall } from "@/hooks/useVoiceCall";
import type { OperationMode } from "@/contexts/AppContext";
import { useVoiceprint } from "../../../hooks/useVoiceprint";
import { BACKGROUND_FACE_PRESENCE_CHANGED, BACKGROUND_FACE_PRESENCE_ENABLED_KEY, isBackgroundFacePresenceEnabled, isSensorEnabled, SENSOR_ACCESS_CHANGED } from "@/services/sensorPermissionService";
import { memoryAvatarService } from "@/services/memoryAvatarService";
import { getDesktopExternalCapabilities } from "@/services/externalCapabilities";
import { uiMessage } from "../../../i18n/uiMessages";
import { desktopWorkflowCopy } from "../../../i18n/locales/desktopWorkflows";
import { chatAttachmentRequestMatchesScope, type ChatAttachmentRequest } from "@/lib/chatAttachmentReferences";
import type { useDesktopSurfaceState } from './use_desktop_surface_state';
import type { SurfaceReturnTarget } from './shared';

export function useDesktopCaptureAndIdentity(previousBindings: ReturnType<typeof useDesktopSurfaceState>) {
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
