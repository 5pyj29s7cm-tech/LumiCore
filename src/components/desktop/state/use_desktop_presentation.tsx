import { DesktopShellView } from "../DesktopShellView";
import { DesktopWidgetPanel } from "../widget";
import React, { useCallback } from "react";
import { Cpu, Settings as SettingsIcon, User as UserIcon, FileText, Activity, Volume2, Bell, BrainCircuit, Wrench, Brush, Terminal as TerminalIcon, RefreshCw, Circle, Calendar } from "lucide-react";
import { uiMessage } from "../../../i18n/uiMessages";
import type { useDesktopSurfaceControls } from './use_desktop_surface_controls';

export function useDesktopPresentation(previousBindings: ReturnType<typeof useDesktopSurfaceControls>) {
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
