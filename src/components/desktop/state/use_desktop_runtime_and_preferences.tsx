import { useMeetingWorkflow } from "../useMeetingWorkflow";
import { emptyKnowledgeRuntimeState, type ClientPermissionSnapshot } from "../runtime_state";
import { useEffect, useCallback, useRef } from "react";
import { sounds } from "../../../services/soundService";
import { toast } from "sonner";
import { useWakeWord } from "../../../hooks/useWakeWord";
import { useFaceRecognition } from "../../../hooks/useFaceRecognition";
import { usePresence } from "../../../hooks/usePresence";
import { getSensorPermissionSnapshot, SENSOR_PERMISSIONS_CHANGED } from "@/services/sensorPermissionService";
import { systemService } from "@/services/systemService";
import { apiFetch } from "@/services/apiClient";
import { canAccessOrganizationWorkspaceView, normalizeOrganizationWorkspaceView } from "../../../../shared/org_workspace";
import { queueOrganizationWorkspaceRoute } from "../../../lib/orgWorkspaceNavigation";
import type { useDesktopCaptureAndIdentity } from './use_desktop_capture_and_identity';
import { IDLE_AWAY_SECONDS, RETURN_IDLE_SECONDS } from './shared';

export function useDesktopRuntimeAndPreferences(previousBindings: ReturnType<typeof useDesktopCaptureAndIdentity>) {
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
