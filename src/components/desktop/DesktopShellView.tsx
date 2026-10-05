

import { LazyPanelFallback, OSWindow } from "./window_shell";
import { LumiCoreAvatar } from "./widget";
import { SensorPrimer } from "./sensor_primer";
import { KernelMonitorApp } from "./kernel_monitor";
import { type DesktopIconDefinition, Spotlight } from "./launcher";
import { ExecutionWorkQueue } from "./daily_plans";
import { type MeetingNote } from "./runtime_state";
import { type ProactiveChatDetail } from "./proactive_presentation";

import React, { Suspense } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';

import { KnowledgeBaseEntry } from "../KnowledgeBaseEntry";
import { Rocket, Zap, X, User as UserIcon, Search, Volume2, VolumeX, Minimize2, Minus, Square, ChevronRight, ArrowLeft, Bell, Sparkles, Brush, Play, Pause, Mic, Copy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { GlassCard } from "../SharedUI";
import { VoicePicker } from "../VoicePicker";
import { DesktopPersonalizationSoundPanel } from "../DesktopPersonalizationSoundPanel";
import { BatteryIndicator, DayInkLandscape, MeetingModeButton } from "../DesktopShellAuxiliary";
import { CursorGlow } from "../CursorGlow";
import { DesktopDeviceWidget } from "../DesktopDeviceWidget";
import { WorkModeSwitch } from "../org/WorkModeSwitch";
import { PetAvatar } from "../SpriteAnimator";
import type { PetConfig } from "../../pets/types";
import { useSocket } from '@/hooks/useSocket';

import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';
import type { CommandCenterView } from "../commandCenterTypes";
import { useWakeWord } from "../../hooks/useWakeWord";
import { useVoiceprint } from "../../hooks/useVoiceprint";
import { useFaceRecognition } from "../../hooks/useFaceRecognition";
import { usePresence } from "../../hooks/usePresence";

import { PresenceIndicator } from "../biometrics/PresenceIndicator";
import { type WallpaperPresentation, type WallpaperWorkspace } from '@/services/systemService';

import { type ExternalCapabilityAction, type ExternalCapabilityProjection } from '@/services/externalCapabilities';

import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";

import { type ChatAttachmentRequest } from '@/lib/chatAttachmentReferences';
import { getDesktopChromeMetrics } from '@/lib/desktopLayout';

import { InkWorldLazy, MeshSyncSelector, ContributorNodePanel, NotificationCenter, DesktopOnboarding, VoiceTrainingDialog, BusinessWorkbench, Settings, PersonalityEditor, ToolPanel, GitHubMCPBrowser, ReminderPanel, DeviceSyncCenter, TokenDashboard, SkillCenter, AvatarStudio, TerminalWindow, AgentChatPage, OrgPortal, Sanctuary, MemoryAvatarLab } from "./surface_components";

type SurfaceReturnTarget = "home" | "command-center";

type DesktopShellViewInput = {
resolvedAppearanceMode: "light" | "dark";
viewMode: "personal" | "world";
desktopChrome: ReturnType<typeof getDesktopChromeMetrics>;
isCompactDesktopLayout: boolean;
isWallpaperMode: boolean;
wallpaperPresentation: WallpaperPresentation;
wallpaperWorkspace: WallpaperWorkspace;
handleShellContextMenu: (e: React.MouseEvent) => void;
isWallpaperDesktopControl: boolean;
wallpaper: string;
wallpaperUrl: string;
wallpaperInputRef: React.RefObject<HTMLInputElement>;
handleWallpaperUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
isWallpaperWorkbench: boolean;
applyWallpaperMode: (enabled: boolean, options?: { silent?: boolean; timeoutMs?: number; presentation?: WallpaperPresentation; workspace?: WallpaperWorkspace; }) => Promise<{ enabled: boolean; presentation: WallpaperPresentation; workspace: WallpaperWorkspace; }>;
lang: "en" | "zh";
personalScale: import("motion/react").MotionValue<number>;
personalOpacity: import("motion/react").MotionValue<number>;
syncRate: number;
t: any;
nexusReturnTarget: "command-center" | "home";
openCommandCenter: (view?: CommandCenterView) => void;
setSyncRate: React.Dispatch<React.SetStateAction<number>>;
handleTopbarPointerDown: (event: React.PointerEvent<HTMLDivElement>) => Promise<void>;
toggleWindow: (tab: string) => void;
openSurface: (target: string, returnTarget?: SurfaceReturnTarget) => void;
closeSurface: (target: string) => void;
setShowOnboarding: React.Dispatch<React.SetStateAction<boolean>>;
tutorialLabel: any;
workDomain: "personal" | "work";
switchDomain: ReturnType<typeof useApp>["switchDomain"];
orgConnection: ReturnType<typeof useApp>["orgConnection"];
activeTab: string;
setActiveTab: (tab: string) => void;
setMemoryLabOpen: React.Dispatch<React.SetStateAction<boolean>>;
setSanctuaryOpen: React.Dispatch<React.SetStateAction<boolean>>;
setSanctuaryAgent: React.Dispatch<any>;
setChatPrefill: React.Dispatch<React.SetStateAction<{ text: string; source: string; }>>;
chatOpen: boolean;
knowledgeOpen: boolean;
memoryLabOpen: boolean;
sanctuaryOpen: boolean;
setIsSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
setIsNotificationPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
isNotificationPanelOpen: boolean;
unreadCount: number;
socket: ReturnType<typeof useSocket>;
toggleMute: () => void;
isMuted: boolean;
toggleWallpaperMode: () => void;
time: Date;
enterDesktopWidgetMode: () => Promise<void>;
handleWindowMinimize: () => Promise<void>;
handleWindowMaximize: () => Promise<void>;
isCompactWindowMode: boolean;
handleWindowClose: () => Promise<void>;
openProactiveChat: (detail: ProactiveChatDetail) => void;
isSearchOpen: boolean;
allAppEntries: Array<{id: string; label: any; icon: React.ReactNode; color: string}>;
dockPositionClassName: string;
dockApps: Array<{id: string; label: any; icon: React.ReactNode; color: string}>;
openWindows: string[];
focusedWindow: string;
minimizedWindows: string[];
user: any;
onLogin: () => void;
selectedPet: PetConfig;
setPersonalizationSection: React.Dispatch<React.SetStateAction<"voice" | "appearance">>;
callState: ReturnType<typeof useVoiceCall>["callState"];
petReaction: { animation: string; until: number; };
equippedAccessories: string[];
audioLevel: number;
startStandardVoiceCall: () => void;
endVoiceCallFromUI: () => void;
operationMode: OperationMode;
openMeetingModeWithConfirm: () => void;
canCustomizeLumiAppearance: boolean;
setSelectedPet: React.Dispatch<React.SetStateAction<PetConfig>>;
savePetPrefsToServer: (pet: PetConfig | null, accessories: string[]) => Promise<boolean>;
facePresenceRequested: boolean;
faceRecognition: ReturnType<typeof useFaceRecognition>;
presence: ReturnType<typeof usePresence>;
voiceprint: ReturnType<typeof useVoiceprint>;
sphereSentiment: "default" | "excited" | "focused";
isTauri: boolean;
interrupt: () => void;
wakeEnabled: boolean;
wakeWord: ReturnType<typeof useWakeWord>;
transcript: string;
desktopIconAreaHeight: number;
desktopIcons: DesktopIconDefinition[];
getDefaultDesktopIconPosition: (index: number) => { x: number; y: number; };
launchExternalCapability: (capability: ExternalCapabilityProjection, action: ExternalCapabilityAction) => Promise<void>;
notifications: ReturnType<typeof useApp>["notifications"];
meetingNotesOpen: boolean;
meetingPaused: boolean;
legalMeetingCaseTitle: string;
copyMeetingNotes: () => Promise<void>;
downloadMeetingNotes: () => void;
setMeetingNotesOpen: React.Dispatch<React.SetStateAction<boolean>>;
meetingNotes: MeetingNote[];
meetingSpeakerCount: number;
meetingStartedAt: number;
meetingReportGenerating: boolean;
meetingReport: string;
formatMeetingTime: (value: number) => string;
meetingNoteHasSpeakerInfo: (note: MeetingNote) => boolean;
meetingSpeakerLabel: (note: Pick<MeetingNote, "speakerLabel" | "speakerMatched">) => string;
toggleMeetingCapturePaused: () => void;
endMeetingAndReport: () => Promise<void>;
clearMeetingNotes: () => void;
pendingOperationModeOption: {id: "meeting"; label: React.ReactNode; title: React.ReactNode; description: React.ReactNode; hint: React.ReactNode; icon: React.ReactNode};
setPendingOperationMode: React.Dispatch<React.SetStateAction<OperationMode>>;
pendingOperationMode: OperationMode | null;
confirmOperationModeChange: () => void;
wallpaperWorkPromptVisible: boolean;
enterWallpaperFromWorkPrompt: () => void;
dismissWallpaperWorkPrompt: () => void;
sensorPrimerSeen: boolean;
finishSensorPrimer: () => void;
showOnboarding: boolean;
askComputerProfileQuestion: (prompt: string) => void;
isTrainingOpen: boolean;
setIsTrainingOpen: React.Dispatch<React.SetStateAction<boolean>>;
getWindowSize: (windowId: string) => { w: string; h: string; };
getWindowMeta: (windowId: string) => { id: string; label: any; icon: React.ReactNode; color: string; } | { id: string; label: any; icon: React.JSX.Element; color: string; };
setFocusedWindow: React.Dispatch<React.SetStateAction<string>>;
setOpenWindows: React.Dispatch<React.SetStateAction<string[]>>;
minimizeOsWindow: (tab: string) => void;
closeWindow: (tab: string) => void;
openKnowledgeBase: (returnTarget?: SurfaceReturnTarget) => void;
setCreationRequestId: React.Dispatch<React.SetStateAction<string>>;
openMemoryAvatar: (avatarId?: string, returnTarget?: SurfaceReturnTarget) => Promise<void>;
setLang: (l: "en" | "zh") => void;
settingsSection: string;
setSettingsSection: React.Dispatch<React.SetStateAction<string>>;
canUseExternalCapabilities: boolean;
personalizationSection: "voice" | "appearance";
petPreferenceScopeKey: string;
handleSelectPet: (pet: PetConfig) => void;
setEquippedAccessories: React.Dispatch<React.SetStateAction<string[]>>;
renderTabContent: (tab: string) => React.ReactNode;
knowledgeLoaded: boolean;
closeKnowledgeBase: () => void;
chatLoaded: boolean;
commandCenterView: CommandCenterView;
setCommandCenterView: React.Dispatch<React.SetStateAction<CommandCenterView>>;
callError: string;
chatPrefill: { text: string; source: string; };
creationRequestId: string;
chatAttachmentRequest: ChatAttachmentRequest;
setChatAttachmentRequest: React.Dispatch<React.SetStateAction<ChatAttachmentRequest>>;
sanctuaryLoaded: boolean;
sanctuaryAgent: any;
closeMemoryAvatar: () => void;
memoryAvatars: any[];
openMemoryAvatarLab: (returnTarget?: SurfaceReturnTarget) => void;
setMemoryAvatars: React.Dispatch<React.SetStateAction<any[]>>;
enterCreatedMemoryAvatar: (avatar: any) => void;
};
export function DesktopShellView({ resolvedAppearanceMode, viewMode, desktopChrome, isCompactDesktopLayout, isWallpaperMode, wallpaperPresentation, wallpaperWorkspace, handleShellContextMenu, isWallpaperDesktopControl, wallpaper, wallpaperUrl, wallpaperInputRef, handleWallpaperUpload, isWallpaperWorkbench, applyWallpaperMode, lang, personalScale, personalOpacity, syncRate, t, nexusReturnTarget, openCommandCenter, setSyncRate, handleTopbarPointerDown, toggleWindow, openSurface, closeSurface, setShowOnboarding, tutorialLabel, workDomain, switchDomain, orgConnection, activeTab, setActiveTab, setMemoryLabOpen, setSanctuaryOpen, setSanctuaryAgent, setChatPrefill, chatOpen, knowledgeOpen, memoryLabOpen, sanctuaryOpen, setIsSearchOpen, setIsNotificationPanelOpen, isNotificationPanelOpen, unreadCount, socket, toggleMute, isMuted, toggleWallpaperMode, time, enterDesktopWidgetMode, handleWindowMinimize, handleWindowMaximize, isCompactWindowMode, handleWindowClose, openProactiveChat, isSearchOpen, allAppEntries, dockPositionClassName, dockApps, openWindows, focusedWindow, minimizedWindows, user, onLogin, selectedPet, setPersonalizationSection, callState, petReaction, equippedAccessories, audioLevel, startStandardVoiceCall, endVoiceCallFromUI, operationMode, openMeetingModeWithConfirm, canCustomizeLumiAppearance, setSelectedPet, savePetPrefsToServer, facePresenceRequested, faceRecognition, presence, voiceprint, sphereSentiment, isTauri, interrupt, wakeEnabled, wakeWord, transcript, desktopIconAreaHeight, desktopIcons, getDefaultDesktopIconPosition, launchExternalCapability, notifications, meetingNotesOpen, meetingPaused, legalMeetingCaseTitle, copyMeetingNotes, downloadMeetingNotes, setMeetingNotesOpen, meetingNotes, meetingSpeakerCount, meetingStartedAt, meetingReportGenerating, meetingReport, formatMeetingTime, meetingNoteHasSpeakerInfo, meetingSpeakerLabel, toggleMeetingCapturePaused, endMeetingAndReport, clearMeetingNotes, pendingOperationModeOption, setPendingOperationMode, pendingOperationMode, confirmOperationModeChange, wallpaperWorkPromptVisible, enterWallpaperFromWorkPrompt, dismissWallpaperWorkPrompt, sensorPrimerSeen, finishSensorPrimer, showOnboarding, askComputerProfileQuestion, isTrainingOpen, setIsTrainingOpen, getWindowSize, getWindowMeta, setFocusedWindow, setOpenWindows, minimizeOsWindow, closeWindow, openKnowledgeBase, setCreationRequestId, openMemoryAvatar, setLang, settingsSection, setSettingsSection, canUseExternalCapabilities, personalizationSection, petPreferenceScopeKey, handleSelectPet, setEquippedAccessories, renderTabContent, knowledgeLoaded, closeKnowledgeBase, chatLoaded, commandCenterView, setCommandCenterView, callError, chatPrefill, creationRequestId, chatAttachmentRequest, setChatAttachmentRequest, sanctuaryLoaded, sanctuaryAgent, closeMemoryAvatar, memoryAvatars, openMemoryAvatarLab, setMemoryAvatars, enterCreatedMemoryAvatar }: DesktopShellViewInput) {

  return (
    <div
      data-theme-scope="shell"
      data-appearance={resolvedAppearanceMode}
      data-view-mode={viewMode}
      data-ui-density={desktopChrome.density}
      data-compact-layout={isCompactDesktopLayout ? 'true' : 'false'}
      data-wallpaper-presentation={isWallpaperMode ? wallpaperPresentation : undefined}
      data-wallpaper-workspace={isWallpaperMode ? wallpaperWorkspace : undefined}
      onContextMenu={handleShellContextMenu}
      className={`fixed inset-0 overflow-hidden cursor-default select-none transition-all duration-1000 ${resolvedAppearanceMode === 'light' ? 'lumi-light-shell' : 'lumi-dark-shell'} ${
      isWallpaperMode ? `bg-transparent ${isWallpaperDesktopControl ? 'pointer-events-none' : ''}` :
      resolvedAppearanceMode === 'light' ? 'bg-[#f8fbff]' : 'bg-[#010103]'
    }`}
      style={{
        ...(wallpaper === 'custom' && wallpaperUrl && !isWallpaperMode ? {
          backgroundImage: `url(${wallpaperUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        } : {}),
      }}
    >
      <input ref={wallpaperInputRef} type="file" accept="image/*" onChange={handleWallpaperUpload} className="hidden" />
      {isWallpaperWorkbench && (
        <motion.button
          data-wallpaper-exit
          type="button"
          initial={{ opacity: 0, scale: 0.86 }}
          animate={{ opacity: 1, scale: 1 }}
          onClick={() => { void applyWallpaperMode(false, { presentation: 'workbench' }); }}
          className="fixed right-4 top-4 z-[220] flex h-9 w-9 items-center justify-center rounded-full border border-cyan-300/20 bg-black/25 text-white/55 shadow-lg backdrop-blur-xl transition-colors hover:border-cyan-200/45 hover:bg-black/40 hover:text-white"
          title={uiMessage('desktop-ui.exit-wallpaper-mode.9b9dd6514d', (lang === 'zh') ? 'zh' : 'en')}
          aria-label={uiMessage('desktop-ui.exit-wallpaper-mode.9b9dd6514d', (lang === 'zh') ? 'zh' : 'en')}
        >
          <X size={15} />
        </motion.button>
      )}
      {/* CRT Scanline / Noise Overlay */}
      <div className={`fixed inset-0 z-[1000] pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] select-none transition-opacity duration-500 ${isWallpaperMode ? 'opacity-0' : 'opacity-[0.03]'}`} />

      {/* Immersive Environment Layer (Wallpaper OS Foundation) */}
      <div
        className={`fixed inset-0 z-0 overflow-hidden transition-all duration-1000 ${
          isWallpaperMode ? 'bg-transparent opacity-0' : resolvedAppearanceMode === 'light' ? 'bg-[#f8fbff] opacity-100' : 'bg-[#010103] opacity-100'
        }`}
      >
        <div className="absolute inset-0">
          {/* Warp Flash Overlay */}
          <motion.div
            animate={{
              opacity: viewMode === 'world' ? [0, 0.4, 0] : 0,
            }}
            transition={{ duration: 0.8 }}
            className="absolute inset-0 z-50 pointer-events-none bg-white"
          />

          {/* Personal Desktop Wallpaper Layer */}
          <motion.div
            style={{
              scale: personalScale,
              opacity: personalOpacity,
              z: 500
            }}
            className="absolute inset-0 pointer-events-none"
          >
            <div className="absolute inset-0">
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ duration: 1 }}
                className="absolute inset-0"
              >
                {resolvedAppearanceMode === 'light' ? (
                  <DayInkLandscape />
                ) : (
                  <>
                    <div className="star-field opacity-20" />
                    <div className="undulating-bg opacity-30 scale-125" />
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/80" />
                  </>
                )}
              </motion.div>
            </div>
          </motion.div>
        </div>

        {/* Hyper-tunnel edges */}
        <div className={`absolute inset-0 pointer-events-none ${resolvedAppearanceMode === 'light' ? 'shadow-[inset_0_0_140px_rgba(73,109,142,0.045)]' : 'shadow-[inset_0_0_300px_rgba(0,0,0,1)]'}`} />

      </div>

      {/* Nexus Globe — WebGL 3D Earth with constellation + globe + neural layers */}
      <AnimatePresence>
        {viewMode === 'world' && (
          <motion.div
            data-theme-scope="dark"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.2 }}
            className="lumi-ink-view fixed inset-0 z-0 overflow-hidden"
          >
            <Suspense fallback={null}><InkWorldLazy syncRate={syncRate} /></Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Nexus View HUD (Floating Content that only shows in Nexus mode) */}
      <AnimatePresence>
        {viewMode === 'world' && (
          <motion.div
            data-theme-scope="dark"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="lumi-ink-hud fixed inset-0 z-20 flex items-center justify-center pointer-events-none"
          >
            <div className="relative z-10 text-center space-y-8 pointer-events-auto">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <h2 className="lumi-ink-title text-6xl font-black text-white/90 tracking-[1.2rem] uppercase drop-shadow-[0_0_30px_rgba(255,255,255,0.1)]">{t.nexusTitle || 'Nexus'}</h2>
                <div className="mt-4 flex items-center justify-center gap-4">
                  <div className="h-px w-12 bg-gradient-to-r from-transparent to-celestial-saturn/50" />
                  <p className="text-xs text-celestial-saturn font-black tracking-[0.8em] uppercase">{t.distributedOSCore || 'Distributed OS Core'}</p>
                  <div className="h-px w-12 bg-gradient-to-l from-transparent to-celestial-saturn/50" />
                </div>
              </motion.div>

              <motion.button
                onClick={() => closeSurface('nexus')}
                className="lumi-ink-return-button group px-10 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs font-black text-white/60 tracking-[0.4em] uppercase transition-all backdrop-blur-2xl hover:text-white hover:border-white/20"
              >
                {nexusReturnTarget === 'command-center'
                  ? `${t.back || 'Back'} · ${uiMessage('command-center.title.c5bb6d0f01')}`
                  : (t.focusPersonalTerritory || 'Focus Personal Territory')}
              </motion.button>
            </div>

            <div className="absolute left-8 top-24 flex flex-col gap-3 pointer-events-auto">
              <Suspense fallback={null}>
                <MeshSyncSelector t={t} syncRate={syncRate} onSyncRateChange={setSyncRate} />
                <ContributorNodePanel t={t} />
              </Suspense>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="fixed inset-0 z-[100] pointer-events-none">
        {/* Top Status Bar */}
        <div
          data-tauri-drag-region
          data-theme-scope={viewMode === 'world' ? 'dark' : undefined}
          inert={isWallpaperMode ? true : undefined}
          aria-hidden={isWallpaperMode ? true : undefined}
          onPointerDown={(event) => void handleTopbarPointerDown(event)}
          className={`lumi-shell-topbar absolute top-0 inset-x-0 h-10 glass-dark border-b border-white/5 flex items-center px-6 pointer-events-auto backdrop-blur-md transition-all duration-1000 ${isWallpaperMode ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        >
          <div className="lumi-shell-topbar-left flex min-w-0 items-center gap-6">
            <button data-lumi-target="home" onClick={() => toggleWindow('home')} className="flex items-center gap-2 group transition-all">
               <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-celestial-mars to-celestial-saturn flex items-center justify-center p-1 group-hover:rotate-12 transition-transform shadow-lg shadow-celestial-saturn/20">
                 <Rocket size={14} className="text-white" />
               </div>
               <span className="lumi-shell-brand-label text-xs font-black tracking-widest uppercase text-white/60">{t.lumiCore || 'LumiCore'}</span>
            </button>
            <div className="lumi-shell-optional h-4 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowOnboarding(true)}
                className="lumi-shell-tutorial flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-black uppercase tracking-widest text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                title={tutorialLabel}
              >
                <Sparkles size={12} />
                <span className="lumi-shell-tutorial-label">{tutorialLabel}</span>
              </button>
            </div>
          </div>

          <div className="lumi-shell-topbar-center flex items-center justify-center">
            <WorkModeSwitch
              domain={workDomain}
              onSelectDomain={switchDomain}
              connected={orgConnection?.connected ?? false}
              organizationOpen={activeTab === 'org'}
              onOpenOrganization={() => openSurface('org')}
              onCloseOrganization={() => closeSurface('command-center')}
              commandCenterOpen={chatOpen || knowledgeOpen || memoryLabOpen || sanctuaryOpen}
              onOpenCommandCenter={() => openCommandCenter('office')}
            />
          </div>

          <div className="lumi-shell-topbar-right flex min-w-0 items-center gap-6 justify-end">
            <div className="lumi-shell-status-actions flex items-center gap-4 text-white/55">
               <div className="flex items-center gap-1" onClick={() => setIsSearchOpen(true)}><Search size={14} className="hover:text-white transition-colors cursor-pointer" /></div>
               <button
                 onClick={() => setIsNotificationPanelOpen(prev => !prev)}
                 className={`flex items-center gap-1 relative transition-colors ${isNotificationPanelOpen ? 'text-white' : 'hover:text-white'}`}
                 aria-expanded={isNotificationPanelOpen}
                 aria-label={t.notificationsLabel || 'Notifications'}
               >
                  <Bell size={14} />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-red-500 text-xs font-black flex items-center justify-center text-white">
                     {unreadCount > 9 ? '9+' : unreadCount}
                   </span>
                 )}
               </button>
               {/* Server connection status */}
               <span
                 className={`w-2 h-2 rounded-full ${socket?.connected ? 'bg-green-400 shadow-[0_0_6px] shadow-green-400/60' : 'bg-red-400 animate-pulse'}`}
                  title={socket?.connected ? (uiMessage('desktop-ui.service-connected.23cf85600c', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.service-disconnected.0511526fe1', (lang === 'zh') ? 'zh' : 'en'))}
               />
               {/* Volume mute toggle */}
                <button onClick={toggleMute} className="flex items-center gap-1 hover:text-white transition-colors" title={isMuted ? (uiMessage('desktop-ui.unmute.acb9917a71', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.mute.060982be3f', (lang === 'zh') ? 'zh' : 'en'))}>
                 {isMuted ? <VolumeX size={14} className="text-red-400" /> : <Volume2 size={14} />}
               </button>
               {/* Battery — real via navigator.getBattery() */}
               <span className="lumi-shell-battery"><BatteryIndicator lang={lang} /></span>
               <button
                 onClick={toggleWallpaperMode}
                 className={`lumi-shell-wallpaper h-6 px-2 rounded-md border transition-all flex items-center gap-1 text-[12px] font-bold uppercase tracking-wider ${
                   isWallpaperMode
                     ? 'bg-celestial-saturn/20 text-celestial-saturn border-celestial-saturn/30'
                     : 'bg-white/5 border-white/5 text-white/55 hover:bg-white/10 hover:text-white'
                 }`}
                  title={isWallpaperMode ? (uiMessage('desktop-ui.exit-wallpaper-mode.9b9dd6514d', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.wallpaper-mode.eb93c52005', (lang === 'zh') ? 'zh' : 'en'))}
               >
                 <Zap size={10} className={isWallpaperMode ? 'animate-pulse' : ''} />
                 <span className="lumi-shell-wallpaper-label">{isWallpaperMode ? 'Fusion' : 'Wallpaper'}</span>
               </button>
            </div>

            <time
              dateTime={time.toISOString()}
              className="lumi-shell-clock px-3 py-1 text-[12px] font-black tabular-nums text-white/80"
            >
              {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>

            {/* Window Controls */}
            <div className="lumi-shell-window-controls flex items-center gap-1 ml-2">
              <button
                onClick={() => void enterDesktopWidgetMode()}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={uiMessage('desktop-ui.desktop-widget.2a3b83969d', (lang === 'zh') ? 'zh' : 'en')}
              >
                <Minimize2 size={14} />
              </button>
              <button
                onClick={handleWindowMinimize}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={uiMessage('desktop-ui.minimize.17dd85f90b', (lang === 'zh') ? 'zh' : 'en')}
              >
                <Minus size={14} />
              </button>
              <button
                onClick={handleWindowMaximize}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={uiMessage(
                  isCompactWindowMode
                    ? 'desktop-ui.maximize.17e771fac7'
                    : 'desktop-ui.compact-window.6b67a41d2e',
                  (lang === 'zh') ? 'zh' : 'en',
                )}
                aria-pressed={isCompactWindowMode}
              >
                <Square size={12} />
              </button>
              <button
                onClick={handleWindowClose}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-red-500/80 transition-colors"
                title={uiMessage('desktop-ui.close.6cf4a7773a', (lang === 'zh') ? 'zh' : 'en')}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {isNotificationPanelOpen && !isWallpaperMode && (
            <>
              <motion.button
                type="button"
                aria-label={uiMessage('desktop-ui.close-notifications.e2705e5af4', (lang === 'zh') ? 'zh' : 'en')}
                className="fixed inset-x-0 bottom-0 top-10 z-[101] cursor-default pointer-events-auto bg-transparent"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsNotificationPanelOpen(false)}
              />
              <motion.div
                initial={{ opacity: 0, y: -18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -18, scale: 0.98 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className={`fixed right-6 top-12 z-[102] h-[min(560px,calc(100vh-4.5rem))] w-[430px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border shadow-2xl pointer-events-auto ${
                  resolvedAppearanceMode === 'light'
                    ? 'border-emerald-900/10 bg-white/95 shadow-slate-900/10'
                    : 'border-white/10 bg-zinc-950/95 shadow-black/50'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
                  <NotificationCenter
                    onChatMessage={openProactiveChat}
                  />
                </Suspense>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Global Search */}
        <AnimatePresence>
          {isSearchOpen && !isWallpaperMode && (
            <Spotlight
              isOpen={isSearchOpen}
              onClose={() => setIsSearchOpen(false)}
              onSelect={toggleWindow}
              apps={allAppEntries}
              t={t}
            />
          )}
        </AnimatePresence>

        {/* Bottom Taskbar / Dock */}
        <div
          data-theme-scope={viewMode === 'world' ? 'dark' : undefined}
          className={`lumi-dock absolute bottom-6 ${dockPositionClassName} z-50 h-16 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden px-4 glass-dark rounded-[2.5rem] border border-white/10 flex items-center gap-2 shadow-2xl backdrop-blur-2xl transition-all duration-1000 ${
            isWallpaperMode || chatOpen || knowledgeOpen || activeTab === 'org'
              ? 'opacity-0 pointer-events-none'
              : 'opacity-100 pointer-events-auto'
          }`}
        >
          <AnimatePresence>
            {dockApps.map(app => {
              const isActive = openWindows.includes(app.id) || (app.id === 'command-center' && chatOpen);
              return (
              <motion.button
                key={app.id}
                data-lumi-target={app.id}
                aria-label={app.label}
                layoutId={`dock-${app.id}`}
                onClick={() => toggleWindow(app.id)}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
                  isActive
                    ? `bg-gradient-to-br ${app.id === focusedWindow || app.id === 'command-center' ? app.color : 'from-white/10 to-white/5'} text-white shadow-lg ${minimizedWindows.includes(app.id) ? 'opacity-40 translate-y-2' : ''}`
                    : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                {app.icon}
                {isActive && (
                  <motion.div
                    layoutId={`indicator-${app.id}`}
                    className={`absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full ${minimizedWindows.includes(app.id) ? 'w-3 h-0.5 bg-white/40' : 'w-1 h-1 bg-white'}`}
                  />
                )}
                {/* Taskbar Preview Tooltip */}
                {isActive && !minimizedWindows.includes(app.id) && (
                   <div className="absolute -top-28 left-1/2 -translate-x-1/2 w-36 bg-black/90 border border-white/10 rounded-xl overflow-hidden opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none shadow-2xl">
                      <div className="p-3 flex items-center gap-2 border-b border-white/5">
                        <div className="w-6 h-6 rounded-lg bg-white/10 flex items-center justify-center">
                          <span className="scale-75">{app.icon}</span>
                        </div>
                        <span className="text-xs font-bold text-white/80 truncate">{app.label}</span>
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-[12px] text-white/55 leading-tight">
                          {focusedWindow === app.id ? (t.activeFocused || 'Active — focused') : (t.openInBackground || 'Open in background')}
                        </p>
                      </div>
                   </div>
                )}
                <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/80 rounded-lg text-xs font-black uppercase text-white opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  {app.label}
                </div>
              </motion.button>
              );
            })}
          </AnimatePresence>
          {user ? (
            <button
              onClick={() => toggleWindow('profile')}
              className="w-12 h-12 rounded-2xl overflow-hidden border-2 border-white/10 hover:border-celestial-saturn/50 bg-white/5 flex items-center justify-center transition-all group"
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <UserIcon size={20} className="text-white/40 group-hover:text-white/80 transition-colors" />
              )}
            </button>
          ) : (
            <button
              onClick={onLogin}
              className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 hover:border-celestial-saturn/30 transition-all flex items-center justify-center group"
            >
              <UserIcon size={20} className="group-hover:text-celestial-saturn transition-colors" />
            </button>
          )}
        </div>
      </div>

      {/* Main OS Content Layer (Personal Desktop Surface) */}
      <motion.div
        data-wallpaper-source-surface="personal"
        inert={isWallpaperMode && (isWallpaperDesktopControl || wallpaperWorkspace !== 'personal') ? true : undefined}
        aria-hidden={isWallpaperMode && (isWallpaperDesktopControl || wallpaperWorkspace !== 'personal') ? true : undefined}
        style={{
          scale: personalScale,
          opacity: personalOpacity,
        }}
        className={`lumi-personal-surface absolute inset-0 z-[15] flex flex-col ${viewMode === 'world' ? 'pointer-events-none' : ''}`}
      >
        <div className="relative w-full h-full pointer-events-auto">
          {/* Central Interactive Entity */}
          <div data-wallpaper-tool="personal-core" className="lumi-core-stage absolute inset-0 flex items-center justify-center z-[15] pointer-events-none">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 2, ease: "easeOut" }}
          className="lumi-core-entity relative pointer-events-auto scale-[0.82] opacity-95 transition-all"
        >
          <div className="lumi-core-shell relative flex flex-col items-center">
            {selectedPet ? (
              <div className="relative group flex flex-col items-center gap-3">
                <button
                  onClick={() => {
                    setPersonalizationSection('appearance');
                    toggleWindow('personalization');
                  }}
                  className={`cursor-pointer transition-all ${callState !== 'idle' ? 'animate-pulse' : ''}`}
                  title={`${selectedPet.name} · ${t.personalization || 'Personalization'}`}
                >
                  <PetAvatar
                    pet={selectedPet}
                    animation={
                      petReaction ? petReaction.animation as any :
                      callState === 'speaking' ? 'wave' :
                      callState === 'listening' ? 'idle' :
                      callState !== 'idle' ? 'jump' : 'idle'
                    }
                    accessoryIds={equippedAccessories}
                    scale={1.2}
                    audioLevel={audioLevel}
                    callState={callState}
                    behavior={
                      'playful'
                    }
                  />
                </button>
                {/* Voice call button below pet */}
                <button
                  onClick={callState === 'idle' ? startStandardVoiceCall : endVoiceCallFromUI}
                  className={`w-12 h-12 rounded-full border transition-all flex items-center justify-center ${
                    callState !== 'idle'
                      ? 'bg-red-500/20 border-red-500/40 text-red-400'
                      : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {callState !== 'idle' ? <Mic size={20} className="animate-pulse" /> : <Mic size={20} />}
                </button>
                <MeetingModeButton
                  t={t}
                  lang={lang}
                  active={operationMode === 'meeting'}
                  live={operationMode === 'meeting' && callState !== 'idle'}
                  onClick={openMeetingModeWithConfirm}
                />
                {/* Reset to sphere button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canCustomizeLumiAppearance) {
                      toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
                      return;
                    }
                    setSelectedPet(null);
                    savePetPrefsToServer(null, equippedAccessories);
                    toast.info(uiMessage('desktop-ui.switched-back-to-particle-face.d909fcb03c', (lang === 'zh') ? 'zh' : 'en'));
                  }}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-white/10 border border-white/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/30 hover:border-red-500/40"
                  title={uiMessage('desktop-ui.switch-back-to-particle-face.711fb73491', (lang === 'zh') ? 'zh' : 'en')}
                >
                  <X size={10} className="text-white/60" />
                </button>
              </div>
            ) : (
              <>
              {/* Biometrics presence indicator — above particle sphere */}
            {facePresenceRequested && faceRecognition.hasTemplates && (
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 z-30">
                <PresenceIndicator
                  status={presence.status}
                  faceConfidence={faceRecognition.result.confidence}
                  voiceConfidence={voiceprint.result.confidence}
                />
              </div>
            )}
            <Suspense fallback={<div className="h-[210px] w-[210px] rounded-full border border-white/10 bg-white/[0.02] animate-pulse" />}>
              <LumiCoreAvatar
                t={t}
                lang={lang}
                sentiment={sphereSentiment}
                callState={callState}
                audioLevel={audioLevel}
                isMuted={isMuted}
                highPerformance={isTauri}
                isWallpaperMode={isWallpaperMode}
                reaction={petReaction?.animation || null}
                facePresent={faceRecognition.result.facePresent}
                onStartCall={startStandardVoiceCall}
                onEndCall={endVoiceCallFromUI}
                onInterrupt={interrupt}
                onToggleMute={toggleMute}
                isLightMode={resolvedAppearanceMode === 'light'}
              />
            </Suspense>
              <div className="mt-2">
                <MeetingModeButton
                  t={t}
                  lang={lang}
                  active={operationMode === 'meeting'}
                  live={operationMode === 'meeting' && callState !== 'idle'}
                  onClick={openMeetingModeWithConfirm}
                />
              </div>
              {wakeEnabled && wakeWord.isListening && callState === 'idle' && (
                <div className="mt-2 text-xs text-white/45 uppercase tracking-[0.25em] font-mono">
                  {uiMessage('desktop-ui.listening-for-lumi.9b7354ccfe', (lang === 'zh') ? 'zh' : 'en')}
                </div>
              )}
              {wakeEnabled && wakeWord.error && (
                <div className="mt-2 text-xs text-red-400/60 font-mono max-w-[200px] text-center leading-relaxed">
                  Wake: {wakeWord.error}
                </div>
              )}
              {wakeEnabled && !wakeWord.isListening && !wakeWord.error && callState === 'idle' && (
                <div className="mt-2 text-xs text-yellow-400/40 font-mono">
                  {uiMessage('desktop-ui.wake-word-initializing.a269c0c408', (lang === 'zh') ? 'zh' : 'en')}
                </div>
              )}
              {!wakeEnabled && callState === 'idle' && (
                <div className="mt-2 text-xs text-white/30 font-mono">
                  {uiMessage('desktop-ui.wake-word-off.d249204cdf', (lang === 'zh') ? 'zh' : 'en')}
                </div>
              )}
              </>
            )}

            <div className={`lumi-core-secondary flex flex-col items-center gap-4 mt-8 transition-all duration-1000 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}>
              <VoicePicker t={t} />

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full"
              >
                 <div className="flex flex-col items-center gap-1 group">
                   <span className="text-xs font-black tracking-[0.4em] text-white/40 uppercase group-hover:text-celestial-saturn transition-colors">
                     {callState === 'idle' ? (t.lumiNeuralCore || 'Lumi Neural Core') : `${callState.toUpperCase()} ${t.sessionActive || 'SESSION'}`}
                   </span>
                   <div className="flex gap-1">
                     {callState !== 'idle' ? (
                       [1,2,3,4,5].map(i => (
                         <motion.div
                           key={i}
                           className="w-1 bg-celestial-saturn rounded-full"
                           animate={{ height: [8, 16 + audioLevel * 20, 8] }}
                           transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                         />
                       ))
                     ) : (
                       [1,2,3].map(i => <div key={i} className="w-1 h-1 rounded-full bg-celestial-saturn/40 animate-pulse" style={{ animationDelay: `${i*0.2}s` }} />)
                     )}
                   </div>

                   <AnimatePresence>
                      {operationMode !== 'meeting' && callState !== 'idle' && transcript && (
                       <motion.div
                         initial={{ opacity: 0, y: 20 }}
                         animate={{ opacity: 1, y: 0 }}
                         exit={{ opacity: 0, scale: 0.9 }}
                         className="mt-6 w-fit max-w-[min(92vw,32rem)] px-6 py-4 bg-white/5 backdrop-blur-3xl border border-white/10 rounded-2xl text-center shadow-2xl"
                       >
                         <p className="max-w-full whitespace-normal break-words text-white/80 text-sm font-medium leading-relaxed italic">
                           "{transcript}"
                         </p>
                         <div className="mt-2 flex justify-center gap-1">
                            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-pulse" />
                            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-pulse delay-75" />
                            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-pulse delay-150" />
                         </div>
                       </motion.div>
                     )}
                   </AnimatePresence>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Desktop Grid & Widgets */}
      <div
        inert={isWallpaperMode ? true : undefined}
        aria-hidden={isWallpaperMode ? true : undefined}
        className={`lumi-desktop-grid relative z-10 w-full h-full overflow-y-auto custom-scrollbar px-3 pb-24 pt-14 transition-all duration-1000 sm:px-6 sm:pt-16 md:p-12 md:pt-20 lg:p-16 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}
      >
        <div className="lumi-desktop-grid-layout flex flex-col xl:flex-row justify-between items-start gap-6 xl:gap-12">
            <div className="lumi-desktop-icon-canvas relative flex-1 w-full" style={{ margin: 0, padding: 0, minHeight: desktopIconAreaHeight }}>
              {desktopIcons.map((def, i) => {
                const { x, y } = getDefaultDesktopIconPosition(i);
                const label = def.label || (def.labelKey ? (t as any)[def.labelKey] || def.labelKey : def.id);
                const windowId = def.windowId || '';
                const isIconOpen = Boolean(windowId) && (openWindows.includes(windowId) || (windowId === 'command-center' && chatOpen));
                const isIconFocused = Boolean(windowId) && (focusedWindow === windowId || (windowId === 'command-center' && chatOpen));
                const handleClick = () => {
                  if (def.externalLaunch) {
                    void launchExternalCapability(def.externalLaunch.capability, def.externalLaunch.action);
                    return;
                  }
                  if (windowId) toggleWindow(windowId);
                };
                return (
                  <motion.div
                    key={def.id}
                    data-lumi-target={windowId || def.id}
                    onDoubleClick={def.externalLaunch ? event => { event.preventDefault(); event.stopPropagation(); } : handleClick}
                    onClick={event => {
                      if (def.externalLaunch && event.detail > 1) return;
                      handleClick();
                    }}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    style={{ position: 'absolute', left: x, top: y }}
                    className={`desktop-icon group z-10 select-none cursor-pointer ${isIconOpen ? 'desktop-icon-open' : ''} ${isIconFocused ? 'desktop-icon-focused' : ''}`}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
                    }}
                  >
                    <div className={`desktop-icon-img bg-gradient-to-br ${def.colorClass} shadow-[0_10px_20px_-5px_rgba(0,0,0,0.5)]`}>
                      <div className="text-white group-hover:rotate-12 transition-transform">
                        {def.icon}
                      </div>
                    </div>
                    <span className="desktop-icon-label">{label}</span>
                  </motion.div>
                );
              })}
            </div>

            <div className="lumi-desktop-widget-rail flex flex-col gap-6 w-full lg:w-96">
              <DesktopDeviceWidget lang={lang} socket={socket} onOpen={() => toggleWindow('devices')} />

              {/* Notification Preview */}
              {false && notifications.filter(n => !n.read).length > 0 && (
                <GlassCard className="p-5 rounded-[2rem] space-y-2 border-white/5 bg-black/30 backdrop-blur-3xl cursor-pointer hover:bg-white/[0.06] transition-all" onClick={() => toggleWindow('notifications')}>
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-black uppercase tracking-widest text-white/55 flex items-center gap-2">
                      <Bell size={12} className="text-amber-400" /> {t.recent || 'Recent'} ({unreadCount} {t.unread || 'unread'})
                    </h4>
                    <ChevronRight size={12} className="text-white/45" />
                  </div>
                  <div className="space-y-1">
                    {notifications.filter(n => !n.read).slice(0, 3).map(n => (
                      <div key={n.id} className="text-[12px] text-white/50 truncate">
                        <span className="text-white/70 font-bold">{n.title}</span> — {n.message}
                      </div>
                    ))}
                  </div>
                </GlassCard>
              )}

            </div>
        </div>
      </div>

      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
        {meetingNotesOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.25, 0.1, 0.25, 1] }}
            className={`fixed inset-0 z-[100000] pointer-events-auto overflow-hidden ${
              resolvedAppearanceMode === 'light' ? 'bg-[#f4f7f2] text-slate-900' : 'bg-[#020711] text-white'
            }`}
            style={{
              background: resolvedAppearanceMode === 'light'
                ? 'radial-gradient(circle at 16% 12%, rgba(16,185,129,0.10) 0%, transparent 30%), radial-gradient(circle at 82% 18%, rgba(59,130,246,0.08) 0%, transparent 32%), linear-gradient(145deg, #f8fbf5 0%, #eef5ef 46%, #e8eef1 100%)'
                : 'radial-gradient(circle at 16% 12%, rgba(34,211,238,0.22) 0%, transparent 30%), radial-gradient(circle at 82% 18%, rgba(56,189,248,0.13) 0%, transparent 32%), linear-gradient(145deg, #020711 0%, #03111c 46%, #010203 100%)',
            }}
          >
            <GlassCard
              hoverEffect={false}
              className="flex h-full w-full flex-col overflow-hidden rounded-none border-0 bg-transparent p-4 shadow-none backdrop-blur-2xl md:p-8"
            >
              <div className="flex shrink-0 items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${operationMode === 'meeting' && !meetingPaused && callState !== 'idle' ? 'bg-cyan-400 animate-pulse' : meetingPaused ? 'bg-amber-300' : 'bg-white/25'}`} />
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/80">
                      {t.meetingMode || (uiMessage('desktop-ui.meeting-mode.59774a9431', (lang === 'zh') ? 'zh' : 'en'))}
                    </h3>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                    {meetingPaused
                      ? (uiMessage('desktop-ui.meeting-capture-paused-existing-notes.9184207c36', (lang === 'zh') ? 'zh' : 'en'))
                      : operationMode === 'meeting'
                      ? (uiMessage('desktop-ui.recording-speech-to-text-notes.d1c840bc80', (lang === 'zh') ? 'zh' : 'en'))
                      : (uiMessage('desktop-ui.meeting-notes-paused.dbdda568f0', (lang === 'zh') ? 'zh' : 'en'))}
                  </p>
                  {legalMeetingCaseTitle && (
                    <p className="mt-1 text-[11px] leading-relaxed text-cyan-200/70">
                      {formatUiMessage('desktop-ui.archiving-to-case-value0.df7656835b', { value0: legalMeetingCaseTitle }, (lang === 'zh') ? 'zh' : 'en')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={copyMeetingNotes}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                    title={uiMessage('desktop-ui.copy-notes.61d380527a', (lang === 'zh') ? 'zh' : 'en')}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    onClick={downloadMeetingNotes}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                    title={uiMessage('desktop-ui.export-markdown.7ef9dff097', (lang === 'zh') ? 'zh' : 'en')}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => setMeetingNotesOpen(false)}
                    className="flex h-9 items-center justify-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-black uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:bg-cyan-400/15"
                    aria-label={uiMessage('desktop-ui.exit-fullscreen-keep-recording.5b39c4c75a', (lang === 'zh') ? 'zh' : 'en')}
                    title={uiMessage('desktop-ui.exit-fullscreen-keep-recording.5b39c4c75a', (lang === 'zh') ? 'zh' : 'en')}
                  >
                    <X size={15} />
                    <span>{uiMessage('desktop-ui.exit.a32b11f87a', (lang === 'zh') ? 'zh' : 'en')}</span>
                  </button>
                </div>
              </div>

              <div className="mt-5 grid shrink-0 grid-cols-2 gap-2 text-center md:grid-cols-4 md:gap-3">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.state.91c2d4012c', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className={`mt-1 text-xs font-bold ${meetingPaused ? 'text-amber-300' : 'text-cyan-300'}`}>
                    {meetingPaused ? 'Paused' : callState === 'idle' ? 'Idle' : callState}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.items.81a207be82', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">{meetingNotes.length}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.speakers.28c4329526', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">{meetingSpeakerCount || '-'}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.time.8a72c3e2a2', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">
                    {meetingStartedAt ? `${Math.max(0, Math.floor((time.getTime() - meetingStartedAt) / 60000))}m` : '0m'}
                  </div>
                </div>
              </div>

              <div className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 custom-scrollbar">
                {meetingReportGenerating && (
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-xs font-bold text-cyan-200">
                    {uiMessage('desktop-ui.lumi-is-preparing-the-meeting.b2bd78cdbc', (lang === 'zh') ? 'zh' : 'en')}
                  </div>
                )}
                {meetingReport && !meetingReportGenerating && (
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3">
                    <div className="text-[10px] font-black uppercase tracking-widest text-cyan-300/80">
                      {uiMessage('desktop-ui.lumi-report.3edec8f8b6', (lang === 'zh') ? 'zh' : 'en')}
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-white/75 font-sans">{meetingReport}</pre>
                  </div>
                )}
                {meetingNotes.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs leading-relaxed text-white/35">
                    {uiMessage('desktop-ui.speech-captured-in-meeting-mode.4372ef7c18', (lang === 'zh') ? 'zh' : 'en')}
                  </div>
                ) : (
                  meetingNotes.slice(-80).reverse().map(note => (
                    <div key={note.id} className="border-l border-cyan-400/25 pl-3">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest text-cyan-300/70">
                        <span>{formatMeetingTime(note.time)}</span>
                        {meetingNoteHasSpeakerInfo(note) && (
                          <span
                            className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${
                              note.speakerMatched
                                ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
                                : 'border-white/10 bg-white/5 text-white/35'
                            }`}
                          >
                            {meetingSpeakerLabel(note)}
                            {typeof note.speakerConfidence === 'number'
                              ? ` ${Math.round(note.speakerConfidence * 100)}%`
                              : ''}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-white/70">{note.text}</p>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-5 flex shrink-0 flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row">
                <button
                  onClick={toggleMeetingCapturePaused}
                  disabled={meetingReportGenerating}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-black uppercase tracking-widest transition-colors ${
                    meetingPaused
                      ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15'
                      : 'border-amber-400/25 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {meetingPaused ? <Play size={14} /> : <Pause size={14} />}
                  <span>{meetingPaused ? (uiMessage('desktop-ui.resume.20a567499d', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.pause.e9b4be6e7c', (lang === 'zh') ? 'zh' : 'en'))}</span>
                </button>
                <button
                  onClick={() => void endMeetingAndReport()}
                  disabled={meetingReportGenerating}
                  className="flex-1 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-black uppercase tracking-widest text-cyan-200 transition-colors hover:bg-cyan-400/15"
                >
                  {meetingReportGenerating
                    ? (uiMessage('desktop-ui.preparing.47ac61c0ae', (lang === 'zh') ? 'zh' : 'en'))
                    : (uiMessage('desktop-ui.end-report.86a5ea4d29', (lang === 'zh') ? 'zh' : 'en'))}
                </button>
                <button
                  onClick={clearMeetingNotes}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-black uppercase tracking-widest text-white/40 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {uiMessage('desktop-ui.clear.684270d636', (lang === 'zh') ? 'zh' : 'en')}
                </button>
              </div>
            </GlassCard>
          </motion.div>
        )}
        </AnimatePresence>,
        document.body
      )}

      {/* Workflow Status Panel — breathing lights + step log */}
      <AnimatePresence>
        {pendingOperationModeOption && !chatOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={`fixed inset-0 z-[99990] flex items-center justify-center px-4 backdrop-blur-sm ${
              resolvedAppearanceMode === 'light' ? 'bg-slate-100/70' : 'bg-black/55'
            }`}
            onClick={() => setPendingOperationMode(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.96 }}
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-md rounded-2xl border p-5 shadow-2xl ${
                resolvedAppearanceMode === 'light'
                  ? 'border-emerald-900/10 bg-white/95 text-slate-900 shadow-slate-900/10'
                  : 'border-cyan-400/20 bg-zinc-950/95 text-white'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300">
                  {pendingOperationModeOption.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-black uppercase tracking-[0.18em] text-cyan-300">
                    {t.confirmModeSwitch || 'Confirm mode switch'}
                  </div>
                  <h3 className="mt-1 text-lg font-black text-white">{pendingOperationModeOption.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">{pendingOperationModeOption.description}</p>
                  <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs leading-relaxed text-white/45">
                    {pendingOperationMode === 'meeting'
                      ? (t.modeMeetingConfirmNote || 'Meeting mode starts microphone speech-to-text, records notes, and can generate a report when you end it.')
                      : (t.modeAutoConfirmNote || (uiMessage('desktop-ui.autonomy-can-use-tools-run.7fe5da7b61', (lang === 'zh') ? 'zh' : 'en')))}
                  </div>
                </div>
              </div>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  onClick={() => setPendingOperationMode(null)}
                  className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-black uppercase tracking-widest text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {t.cancel || 'Cancel'}
                </button>
                <button
                  onClick={confirmOperationModeChange}
                  className="rounded-lg border border-cyan-400/25 bg-cyan-400/15 px-4 py-2 text-xs font-black uppercase tracking-widest text-cyan-200 transition-colors hover:bg-cyan-400/25"
                >
                  {t.enterMode || 'Enter mode'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <CursorGlow />
      <AnimatePresence>
        {wallpaperWorkPromptVisible && !isWallpaperMode && !chatOpen && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={{ duration: 0.24 }}
            className="fixed bottom-28 left-1/2 z-[265] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 pointer-events-auto"
          >
            <div className="flex items-center gap-3 rounded-2xl border border-cyan-400/20 bg-zinc-950/92 px-3 py-3 shadow-2xl shadow-cyan-950/30 backdrop-blur-2xl sm:px-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
                <Zap size={17} className="animate-pulse" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-black uppercase tracking-[0.18em] text-cyan-200">
                  {t.wallpaperWorkPromptTitle || (uiMessage('desktop-ui.native-desktop-handoff.ce61ef3fc2', (lang === 'zh') ? 'zh' : 'en'))}
                </div>
                <div className="mt-0.5 truncate text-xs font-medium text-white/55">
                  {t.wallpaperWorkPromptDesc || (uiMessage('desktop-ui.lumi-has-started-working-and.da348f5f67', (lang === 'zh') ? 'zh' : 'en'))}
                </div>
              </div>
              <button
                onClick={enterWallpaperFromWorkPrompt}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/15 px-3 py-2 text-xs font-black uppercase tracking-widest text-cyan-100 transition-colors hover:bg-cyan-300/25"
              >
                <Zap size={13} />
                {t.enterWallpaper || (uiMessage('desktop-ui.enter.744e33700e', (lang === 'zh') ? 'zh' : 'en'))}
              </button>
              <button
                onClick={dismissWallpaperWorkPrompt}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                aria-label={t.close || 'Close'}
              >
                <X size={14} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className={`absolute inset-0 z-[20] pointer-events-none transition-opacity duration-500 ${isWallpaperMode ? 'opacity-0' : 'opacity-100'}`}>
        <SensorPrimer
          isOpen={!sensorPrimerSeen}
          onContinue={finishSensorPrimer}
          t={t}
        />
        {showOnboarding && sensorPrimerSeen && (
          <Suspense fallback={null}>
            <DesktopOnboarding
              isOpen
              onAsk={askComputerProfileQuestion}
              onFinish={() => {
                setShowOnboarding(false);
                localStorage.setItem('lumi_onboarding_seen', 'true');
              }}
              t={t}
            />
          </Suspense>
        )}
        {isTrainingOpen && (
          <Suspense fallback={null}>
            <VoiceTrainingDialog
              isOpen={isTrainingOpen}
              onClose={() => setIsTrainingOpen(false)}
              onSuccess={() => window.dispatchEvent(new CustomEvent('lumi:voice-updated'))}
            />
          </Suspense>
        )}
        <AnimatePresence>
          {openWindows.map((windowId, orderIdx) => {
            const size = getWindowSize(windowId);
            const meta = getWindowMeta(windowId);
            return (
              <OSWindow
                key={windowId}
                id={windowId}
                title={meta.label}
                icon={meta.icon}
                isActive={focusedWindow === windowId}
                isMinimized={minimizedWindows.includes(windowId)}
                zIndex={10 + orderIdx}
                onFocus={(id) => {
                  setFocusedWindow(id);
                  setOpenWindows(prev => prev.includes(id) ? [...prev.filter(w => w !== id), id] : prev);
                }}
                onMinimize={minimizeOsWindow}
                onMinimizeComplete={(id) => {
                  // Window stays in DOM, just mark animation complete
                }}
                onClose={() => closeWindow(windowId)}
                colorClass={meta.color}
                width={size.w}
                height={size.h}
                t={t}
              >
                <div className="os-window-body custom-scrollbar">
                  <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
                  {windowId === 'business' ? (
                    <BusinessWorkbench lang={lang} domain={workDomain} onOpenSettings={() => toggleWindow('settings')} onOpenKnowledge={openKnowledgeBase} onOpenSkills={() => toggleWindow('skills')}
                      onOpenCreation={() => { setCreationRequestId(crypto.randomUUID()); openCommandCenter('office'); }}
                      onOpenDigitalHuman={() => { void openMemoryAvatar(undefined, 'home'); }} />
                  ) : windowId === 'kernel' ? (
                    <KernelMonitorApp t={t} onAsk={askComputerProfileQuestion} />
                  ) : windowId === 'settings' ? (
                    <Settings t={t} lang={lang} setLang={setLang} activeSection={settingsSection} onSectionChange={setSettingsSection} />
                  ) : windowId === 'personality' ? (
                    <PersonalityEditor t={t} />
                  ) : windowId === 'tools' ? (
                    <ToolPanel />
                  ) : windowId === 'github-mcp' ? (
                    <GitHubMCPBrowser t={t} />
                  ) : windowId === 'notifications' ? (
                    <NotificationCenter
                      onChatMessage={(item) => {
                        closeWindow('notifications');
                        openProactiveChat(item);
                      }}
                    />
                  ) : windowId === 'reminders' ? (
                    <ReminderPanel t={t} />
                  ) : windowId === 'plans' ? (
                    <ExecutionWorkQueue t={t} />
                  ) : windowId === 'devices' ? (
                    <DeviceSyncCenter t={t} />
                  ) : windowId === 'tokens' ? (
                    <TokenDashboard />
                  ) : windowId === 'skills' ? (
                    <SkillCenter
                      t={t}
                      lang={lang}
                      canUseExternalCapabilities={canUseExternalCapabilities}
                      canReviewExternalCapabilities={Boolean(isTauri && user?.role === 'admin' && workDomain === 'personal')}
                    />
                  ) : windowId === 'personalization' ? (
                    <div className="flex h-full min-h-0 flex-col gap-3">
                      <div className="grid shrink-0 grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-black/20 p-1.5" role="tablist" aria-label={t.personalization || 'Personalization'}>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={personalizationSection === 'appearance'}
                          onClick={() => setPersonalizationSection('appearance')}
                          className={`flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${personalizationSection === 'appearance' ? 'bg-cyan-400/18 text-cyan-100' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/75'}`}
                        >
                          <Brush size={15} />
                          {t.avatarStudio || 'Avatar Studio'}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={personalizationSection === 'voice'}
                          onClick={() => setPersonalizationSection('voice')}
                          className={`flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${personalizationSection === 'voice' ? 'bg-indigo-400/18 text-indigo-100' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/75'}`}
                        >
                          <Volume2 size={15} />
                          {t.sound || 'Sound'}
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {personalizationSection === 'appearance' ? (
                          <AvatarStudio
                            key={petPreferenceScopeKey}
                            t={t}
                            lang={lang}
                            storageScope={petPreferenceScopeKey}
                            selectedPetId={selectedPet?.id}
                            onSelectPet={handleSelectPet}
                            equippedAccessories={equippedAccessories}
                            onChangeAccessories={(ids) => {
                              if (!canCustomizeLumiAppearance) {
                                toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
                                return;
                              }
                              setEquippedAccessories(ids);
                              savePetPrefsToServer(selectedPet, ids);
                            }}
                            onResetToSphere={() => {
                              if (!canCustomizeLumiAppearance) {
                                toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
                                return;
                              }
                              setSelectedPet(null);
                              savePetPrefsToServer(null, equippedAccessories);
                              toast.info(uiMessage('desktop-ui.switched-back-to-the-default.97edb4815a', (lang === 'zh') ? 'zh' : 'en'));
                            }}
                          />
                        ) : (
                          <DesktopPersonalizationSoundPanel
                            t={t}
                            onOpenAppearance={() => setPersonalizationSection('appearance')}
                            onOpenVoiceSettings={() => {
                              setSettingsSection('voice-model');
                              toggleWindow('settings');
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ) : windowId === 'terminal' ? (
                    <TerminalWindow t={t} onClose={() => closeWindow('terminal')} isActive={focusedWindow === 'terminal'} />
                  ) : windowId === 'chat' || windowId === 'command-center' ? (
                    // Chat is now fullscreen overlay — this case should not be reached
                    null
                  ) : renderTabContent(windowId)}
                  </Suspense>
                </div>
              </OSWindow>
            );
          })}
        </AnimatePresence>
      </div>

        </div>
      </motion.div>

      {/* Knowledge Base fullscreen overlay */}
      {knowledgeLoaded && (
          <KnowledgeBaseEntry
            scopeKey={`${user?.uid || 'guest'}:${workDomain}:${orgConnection?.orgId || ''}`}
            t={t}
            isOpen={knowledgeOpen}
            onClose={closeKnowledgeBase}
            domain={workDomain}
          />
      )}

      {/* Chat fullscreen overlay */}
      {chatLoaded && (
        <Suspense fallback={null}>
          <AgentChatPage
            t={t}
            user={user}
            isOpen={chatOpen}
            onClose={() => closeSurface('command-center')}
            layout="command-center"
            commandCenterView={commandCenterView}
            onCommandCenterViewChange={setCommandCenterView}
            onOpenNexus={() => openSurface('nexus', 'command-center')}
            onOpenMemoryAvatar={() => { void openMemoryAvatar(); }}
            onOpenKnowledge={() => {
              openKnowledgeBase('command-center');
            }}
            voiceSession={{
              callState,
              audioLevel,
              error: callError,
              onStart: startStandardVoiceCall,
              onEnd: endVoiceCallFromUI,
            }}
            prefillMessage={chatPrefill?.text || ''}
            creationRequestId={creationRequestId || undefined}
            onCreationRequestConsumed={(requestId) => setCreationRequestId(current => current === requestId ? null : current)}
            prefillSource={chatPrefill?.source || 'proactive'}
            onPrefillConsumed={() => { setChatPrefill(null); }}
            attachmentRequest={chatAttachmentRequest || undefined}
            onAttachmentRequestConsumed={(requestId) => {
              setChatAttachmentRequest(current => current?.requestId === requestId ? null : current);
            }}
          />
        </Suspense>
      )}
      {chatOpen && typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {pendingOperationModeOption && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`fixed inset-0 z-[100010] flex items-center justify-center px-4 backdrop-blur-sm ${
                resolvedAppearanceMode === 'light' ? 'bg-slate-100/70' : 'bg-black/55'
              }`}
              onClick={() => setPendingOperationMode(null)}
            >
              <motion.div
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.96 }}
                onClick={(e) => e.stopPropagation()}
                className={`w-full max-w-md rounded-2xl border p-5 shadow-2xl ${
                  resolvedAppearanceMode === 'light'
                    ? 'border-emerald-900/10 bg-white/95 text-slate-900 shadow-slate-900/10'
                    : 'border-cyan-400/20 bg-zinc-950/95 text-white'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300">
                    {pendingOperationModeOption.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-cyan-300">
                      {t.confirmModeSwitch || 'Confirm mode switch'}
                    </div>
                    <h3 className="mt-1 text-lg font-black text-white">{pendingOperationModeOption.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-white/60">{pendingOperationModeOption.description}</p>
                    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs leading-relaxed text-white/45">
                      {pendingOperationMode === 'meeting'
                        ? (t.modeMeetingConfirmNote || 'Meeting mode starts microphone speech-to-text, records notes, and can generate a report when you end it.')
                        : (t.modeAutoConfirmNote || 'Autonomy can use tools, run logs, commands, and desktop control with visible progress and confirmations for sensitive actions.')}
                    </div>
                  </div>
                </div>
                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setPendingOperationMode(null)}
                    className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-black uppercase tracking-widest text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    {t.cancel || 'Cancel'}
                  </button>
                  <button
                    onClick={confirmOperationModeChange}
                    className="rounded-lg border border-cyan-400/25 bg-cyan-400/15 px-4 py-2 text-xs font-black uppercase tracking-widest text-cyan-200 transition-colors hover:bg-cyan-400/25"
                  >
                    {t.enterMode || 'Enter mode'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Org Workbench fullscreen overlay — available to all logged-in users */}
      <AnimatePresence>
        {activeTab === 'org' && (
          <motion.div
            data-wallpaper-source-surface="organization"
            data-wallpaper-tool="organization-portal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className={`lumi-organization-fullscreen-surface lumi-below-topbar fixed inset-x-0 bottom-0 z-[90] bg-celestial-deep overflow-auto ${isWallpaperWorkbench ? 'lumi-organization-wallpaper' : ''}`}
          >
            <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
              <OrgPortal
                initialMode={orgConnection?.connected ? 'select' : 'create'}
                onBack={() => setActiveTab('home')}
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sanctuary — fullscreen private Memory Avatar conversation */}
      {sanctuaryLoaded && (
        <Suspense fallback={null}>
          <Sanctuary
            agent={sanctuaryAgent}
            lang={lang}
            isOpen={sanctuaryOpen}
            onClose={closeMemoryAvatar}
            avatars={memoryAvatars}
            onSelectAvatar={(avatarId) => { void openMemoryAvatar(avatarId); }}
            onCreateAnother={openMemoryAvatarLab}
            onAvatarUpdated={(avatar) => {
              setMemoryAvatars(previous => previous.map(existing => existing.id === avatar.id ? avatar : existing));
              setSanctuaryAgent(previous => previous?.id === avatar.id ? avatar : previous);
            }}
            onAvatarArchived={(avatarId) => {
              const remaining = memoryAvatars.filter(avatar => avatar.id !== avatarId);
              setMemoryAvatars(remaining);
              setSanctuaryAgent(remaining[0] || null);
              if (remaining.length === 0) { setSanctuaryOpen(false); setMemoryLabOpen(true); }
            }}
          />
        </Suspense>
      )}

      {/* Memory Avatar Lab fullscreen overlay */}
      <AnimatePresence>
        {memoryLabOpen && (
          <motion.div
            initial={{ clipPath: 'circle(0% at 50% 95%)', opacity: 0 }}
            animate={{ clipPath: 'circle(150% at 50% 95%)', opacity: 1 }}
            exit={{ clipPath: 'circle(0% at 50% 95%)', opacity: 0 }}
            transition={{ duration: 0.55, ease: [0.25, 0.1, 0.25, 1] }}
            className="fixed inset-0 z-[215]"
            style={{ background: 'radial-gradient(ellipse at 50% 30%, #12081a 0%, #0a0510 40%, #020205 100%)' }}
          >
            <div className="absolute top-4 left-4 z-10">
              <button
                onClick={closeMemoryAvatar}
                className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
              >
                <ArrowLeft size={18} />
              </button>
            </div>
            <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
              <MemoryAvatarLab
                t={t}
                lang={lang}
                onEnterSanctuary={enterCreatedMemoryAvatar}
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
