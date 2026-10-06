import { renderShellChrome } from './shell_chrome_view';
import { renderDesktopCoreStage } from './core_stage_view';
import { renderDesktopGrid } from './desktop_grid_view';
import { renderMeetingWorkspace } from './meeting_workspace_view';
import { renderDesktopWindows } from './desktop_windows_view';

import { LazyPanelFallback } from "./window_shell";

import { type DesktopIconDefinition } from "./launcher";

import { type MeetingNote } from "./runtime_state";
import { type ProactiveChatDetail } from "./proactive_presentation";

import React, { Suspense } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';

import { KnowledgeBaseEntry } from "../KnowledgeBaseEntry";
import { Zap, X, ArrowLeft } from 'lucide-react';

import { DayInkLandscape } from "../DesktopShellAuxiliary";
import { CursorGlow } from "../CursorGlow";

import type { PetConfig } from "../../pets/types";
import { useSocket } from '@/hooks/useSocket';

import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';
import type { CommandCenterView } from "../commandCenterTypes";
import { useWakeWord } from "../../hooks/useWakeWord";
import { useVoiceprint } from "../../hooks/useVoiceprint";
import { useFaceRecognition } from "../../hooks/useFaceRecognition";
import { usePresence } from "../../hooks/usePresence";

import { type WallpaperPresentation, type WallpaperWorkspace } from '@/services/systemService';

import { type ExternalCapabilityAction, type ExternalCapabilityProjection } from '@/services/externalCapabilities';

import { uiMessage } from "../../i18n/uiMessages";

import { type ChatAttachmentRequest } from '@/lib/chatAttachmentReferences';
import { getDesktopChromeMetrics } from '@/lib/desktopLayout';

import { InkWorldLazy, MeshSyncSelector, ContributorNodePanel, AgentChatPage, OrgPortal, Sanctuary, MemoryAvatarLab } from "./surface_components";

type SurfaceReturnTarget = "home" | "command-center";

export type DesktopShellViewInput = {
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
startStandardVoiceCall: (conversationId?: string) => void;
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
focusOsWindow: (tab: string) => void;
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
export function DesktopShellView(input: DesktopShellViewInput) {
  const { resolvedAppearanceMode, viewMode, desktopChrome, isCompactDesktopLayout, isWallpaperMode, wallpaperPresentation, wallpaperWorkspace, handleShellContextMenu, isWallpaperDesktopControl, wallpaper, wallpaperUrl, wallpaperInputRef, handleWallpaperUpload, isWallpaperWorkbench, applyWallpaperMode, lang, personalScale, personalOpacity, syncRate, t, nexusReturnTarget, setSyncRate, openSurface, closeSurface, workDomain, orgConnection, activeTab, setActiveTab, setMemoryLabOpen, setSanctuaryOpen, setSanctuaryAgent, setChatPrefill, chatOpen, knowledgeOpen, memoryLabOpen, sanctuaryOpen, user, startStandardVoiceCall, endVoiceCallFromUI, pendingOperationModeOption, setPendingOperationMode, pendingOperationMode, confirmOperationModeChange, wallpaperWorkPromptVisible, enterWallpaperFromWorkPrompt, dismissWallpaperWorkPrompt, openKnowledgeBase, setCreationRequestId, openMemoryAvatar, knowledgeLoaded, closeKnowledgeBase, chatLoaded, commandCenterView, setCommandCenterView, callError, chatPrefill, creationRequestId, chatAttachmentRequest, setChatAttachmentRequest, sanctuaryLoaded, sanctuaryAgent, closeMemoryAvatar, memoryAvatars, openMemoryAvatarLab, setMemoryAvatars, enterCreatedMemoryAvatar, callState, audioLevel } = input;

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

      {renderShellChrome(input)}

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
          {renderDesktopCoreStage(input)}

      {/* Desktop Grid & Widgets */}
      {renderDesktopGrid(input)}

      {typeof document !== 'undefined' && createPortal(
        renderMeetingWorkspace(input),
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
      {renderDesktopWindows(input)}

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
