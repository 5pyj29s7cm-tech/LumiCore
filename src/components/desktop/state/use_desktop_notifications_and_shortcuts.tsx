import { resolvePetPreference, serializePetPreference } from "../runtime_state";
import { useEffect } from "react";
import { toast } from "sonner";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import type { useDesktopWallpaper } from './use_desktop_wallpaper';

export function useDesktopNotificationsAndShortcuts(previousBindings: ReturnType<typeof useDesktopWallpaper>) {
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
