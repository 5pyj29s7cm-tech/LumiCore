import React, { useState, useEffect, useCallback, useRef, lazy, Suspense, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls, useMotionValue, useTransform } from 'motion/react';
import { GlobalNodeMap } from './GlobalNodeMap';
import { sounds } from '../services/soundService';
import {
  Rocket,
  Cpu,
  Settings as SettingsIcon,
  Shield,
  Zap,
  X,
  User as UserIcon,
  Search,
  FileText,
  Activity,
  Wifi,
  Volume2,
  VolumeX,
  Bluetooth,
  Moon,
  Minimize2,
  Maximize2,
  Minus,
  Square,
  ChevronRight,
  ArrowLeft,
  Bell,
  BrainCircuit,
  Sparkles,
  Box,
  Wrench,
  MessageSquare,
  Brush,
  Play,
  Pause,
  Mic,
  Terminal as TerminalIcon,
  Monitor,
  Trash2,
  RefreshCw,
  Circle,
  Calendar,
  Camera,
  Copy,
  Download,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { GlassCard } from './SharedUI';
import { VoicePicker } from './VoicePicker';
import { DesktopPersonalizationSoundPanel } from './DesktopPersonalizationSoundPanel';
import {
  BatteryIndicator,
  DayInkLandscape,
  MeetingModeButton,
  ThemeWidget,
} from './DesktopShellAuxiliary';
import { CursorGlow } from './CursorGlow';
import { WorkModeSwitch } from './org/WorkModeSwitch';
import { PetAvatar } from './SpriteAnimator';
import { getDefaultPets } from '../pets/defaults';
import type { PetConfig } from '../pets/types';
import { useSocket } from '@/hooks/useSocket';
import { useAmbientPoller } from '@/hooks/useAmbientPoller';
import { useVoiceCall, type VoiceTranscriptMeta } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';
import { describeAgentResponseDelivery } from '@/lib/agentResponseDelivery';
const LumiCoreAvatar = lazy(() => import('./LumiCoreAvatar').then(m => ({ default: m.LumiCoreAvatar })));
const MemoryAvatarLab = lazy(() => import('./MemoryAvatarLab').then(m => ({ default: m.MemoryAvatarLab })));
const Sanctuary = lazy(() => import('./Sanctuary').then(m => ({ default: m.Sanctuary })));
const InkWorldLazy = lazy(() => import('./InkWorld').then(m => ({ default: m.InkWorld })));
import {
  normalizeTaskCompletionFeedback,
  type WorkflowTask,
  type WorkflowStep,
} from './workflowTypes';
import type { CommandCenterView } from './commandCenterTypes';
import { useWakeWord } from '../hooks/useWakeWord';
import { ErrorBoundary } from './ErrorBoundary';
import { appConfirm } from '@/lib/appConfirm';
import { useVoiceprint } from '../hooks/useVoiceprint';
import { useFaceRecognition } from '../hooks/useFaceRecognition';
import { usePresence } from '../hooks/usePresence';
import {
  BACKGROUND_FACE_PRESENCE_CHANGED,
  BACKGROUND_FACE_PRESENCE_ENABLED_KEY,
  getSensorPermissionSnapshot,
  isBackgroundFacePresenceEnabled,
  isSensorEnabled,
  SENSOR_ACCESS_CHANGED,
  SENSOR_PERMISSIONS_CHANGED,
} from '@/services/sensorPermissionService';
import {
  archiveLegalMeetingToConsultationCase,
  clearLegalConsultationCaseId,
  getLegalCaseLabel,
  getLegalConsultationCase,
  getLegalConsultationCaseId,
  setLegalConsultationCaseId,
} from '@/lib/legalCaseStore';
import { PresenceIndicator } from './biometrics/PresenceIndicator';
import { systemService } from '@/services/systemService';
import { usePlatform } from '@/hooks/usePlatform';
import { apiFetch } from '@/services/apiClient';
import {
  canUseExternalCapabilitiesForSurface,
  createExternalCapabilityExecutionCorrelation,
  executeExternalCapabilityAction,
  fetchExternalCapabilities,
  getDesktopExternalCapabilities,
  type ExternalCapabilityAction,
  type ExternalCapabilityExecutionCorrelation,
  type ExternalCapabilityProjection,
} from '@/services/externalCapabilities';
import {
  canAccessOrganizationWorkspaceView,
  listOrganizationWorkspaceViewsForRole,
  normalizeOrganizationWorkspaceView,
  type OrganizationWorkspaceView,
} from '../../shared/org_workspace';
import {
  CLIENT_SETTINGS_SECTIONS,
  PERSONAL_CLIENT_LAUNCHER_IDS,
  PERSONAL_CLIENT_SURFACES,
  PERSONAL_CLIENT_SURFACE_ACTIONS,
  getOpenPersonalClientSurfaceIds,
  getPersonalClientSurfaceByAction,
  isComputerAdaptationSettingsTarget,
  normalizeClientSettingsSection,
} from '../../shared/client_surfaces';
import { queueOrganizationWorkspaceRoute } from '../lib/orgWorkspaceNavigation';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { desktopWorkflowCopy } from '../i18n/locales/desktopWorkflows';
import { externalCapabilityCopy } from '../i18n/locales/externalCapabilities';
import { chatAttachmentRequestMatchesScope, type ChatAttachmentRequest } from '@/lib/chatAttachmentReferences';
import {
  getDesktopDockPositionClassName,
  getDesktopChromeMetrics,
  getDesktopIconLayout,
  resolveDesktopWindowBounds,
  shouldUseCompactDesktopLayout,
  type ViewportSize,
} from '@/lib/desktopLayout';
import { isClientSurfaceRendered, waitForClientSurfaceRendered } from '../lib/clientSurfaceCommit';

const IDLE_AWAY_SECONDS = 5 * 60;
const RETURN_IDLE_SECONDS = 30;

// Full-screen utility surfaces can be opened from the Command Center.  Keep
// the origin explicit so closing an overlay returns to the surface the user
// came from instead of silently falling back to the personal desktop.
type SurfaceReturnTarget = 'home' | 'command-center';

const AgentChatPage = lazy(() => import('./AgentChatPage').then(m => ({ default: m.AgentChatPage })));
const AutonomousFeed = lazy(() => import('./AutonomousFeed').then(m => ({ default: m.AutonomousFeed })));
const AvatarStudio = lazy(() => import('./AvatarStudio').then(m => ({ default: m.AvatarStudio })));
const DesktopOnboarding = lazy(() => import('./DesktopOnboarding').then(m => ({ default: m.DesktopOnboarding })));
const ContributorNodePanel = lazy(() => import('./ContributorNodePanel').then(m => ({ default: m.ContributorNodePanel })));
const DeviceSyncCenter = lazy(() => import('./DeviceSyncCenter').then(m => ({ default: m.DeviceSyncCenter })));
const GitHubMCPBrowser = lazy(() => import('./GitHubMCPBrowser').then(m => ({ default: m.GitHubMCPBrowser })));
const KnowledgeBase = lazy(() => import('./KnowledgeBase').then(m => ({ default: m.KnowledgeBase })));
const MeshSyncSelector = lazy(() => import('./MeshSyncSelector').then(m => ({ default: m.MeshSyncSelector })));
const NotificationCenter = lazy(() => import('./NotificationCenter').then(m => ({ default: m.NotificationCenter })));
const OrgPortal = lazy(() => import('./OrgPortal').then(m => ({ default: m.OrgPortal })));
const PersonalityEditor = lazy(() => import('./PersonalityEditor').then(m => ({ default: m.PersonalityEditor })));
const ReminderPanel = lazy(() => import('./ReminderPanel').then(m => ({ default: m.ReminderPanel })));
const Settings = lazy(() => import('./Settings').then(m => ({ default: m.Settings })));
const SkillCenter = lazy(() => import('./SkillCenter').then(m => ({ default: m.SkillCenter })));
const SystemExplorer = lazy(() => import('./SystemExplorer').then(m => ({ default: m.SystemExplorer })));
const TerminalWindow = lazy(() => import('./Terminal').then(m => ({ default: m.TerminalWindow })));
const TokenDashboard = lazy(() => import('./TokenDashboard').then(m => ({ default: m.TokenDashboard })));
const ToolPanel = lazy(() => import('./ToolPanel').then(m => ({ default: m.ToolPanel })));
const VoiceTrainingDialog = lazy(() => import('./VoiceTrainingDialog').then(m => ({ default: m.VoiceTrainingDialog })));

type ProactiveChatDetail = {
  type?: string;
  message?: string;
  action?: string;
  proactiveContext?: Record<string, any>;
  context?: Record<string, any>;
  timestamp?: string;
};

interface ClientKnowledgeRuntimeState {
  domain: 'personal' | 'work';
  orgId: string;
  totalFiles: number;
  indexedFiles: number;
  partialFiles: number;
  pendingFiles: number;
  failedFiles: number;
  unsupportedFiles: number;
  orgArticles?: {
    total: number;
    published: number;
    indexed: number;
    missingIndex: number;
    stale: number;
  };
  refreshedAt: number;
  lastError: string;
}

function emptyKnowledgeRuntimeState(domain: 'personal' | 'work', orgId = ''): ClientKnowledgeRuntimeState {
  return {
    domain,
    orgId,
    totalFiles: 0,
    indexedFiles: 0,
    partialFiles: 0,
    pendingFiles: 0,
    failedFiles: 0,
    unsupportedFiles: 0,
    refreshedAt: 0,
    lastError: '',
  };
}

function proactiveActionLabel(action: string | undefined, lang: 'en' | 'zh'): string {
  const labels = desktopWorkflowCopy(lang).proactiveActions as Record<string, string>;
  return (action ? labels[action] : '') || action || uiMessage('desktop-ui.continue.5206d89b73', lang);
}

function compactProactivePreview(value: unknown): string {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

function formatProactiveChatPrefill(detail: ProactiveChatDetail, lang: 'en' | 'zh'): string {
  const message = String(detail.message || '').trim();
  const context = detail.proactiveContext || detail.context || {};
  const lines = [message || (uiMessage('desktop-ui.i-just-noticed-a-context.e82631aa13', (lang === 'zh') ? 'zh' : 'en'))];

  if (context.trigger === 'window_changed') {
    const appLabel = context.appLabel || context.processName || (uiMessage('desktop-ui.the-current-app.9ba27b3466', (lang === 'zh') ? 'zh' : 'en'));
    lines.push('');
    lines.push(formatUiMessage('desktop-ui.i-asked-because-you-switched.dca30b423a', { value0: appLabel }, (lang === 'zh') ? 'zh' : 'en'));
    if (context.windowTitle) {
      lines.push(formatUiMessage('desktop-ui.active-window-value0.39501f825f', { value0: context.windowTitle }, (lang === 'zh') ? 'zh' : 'en'));
    }
  } else if (context.trigger === 'clipboard_changed') {
    lines.push('');
    lines.push(uiMessage('desktop-ui.i-asked-because-i-noticed.e51083b4fa', (lang === 'zh') ? 'zh' : 'en'));
    const preview = compactProactivePreview(context.preview);
    if (preview) {
      lines.push(formatUiMessage('desktop-ui.context-preview-value0.ab9411a203', { value0: preview }, (lang === 'zh') ? 'zh' : 'en'));
    }
  }

  if (detail.action) {
    lines.push(formatUiMessage('desktop-ui.suggested-action-value0.35f751e5d4', { value0: proactiveActionLabel(detail.action, lang) }, (lang === 'zh') ? 'zh' : 'en'));
  }
  lines.push(uiMessage('desktop-ui.you-can-reply-yes-take.44dc1e9be5', (lang === 'zh') ? 'zh' : 'en'));
  return lines.join('\n');
}

function LazyPanelFallback({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[180px] w-full items-center justify-center text-white/35">
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-black uppercase tracking-[0.16em]">
        <RefreshCw size={13} className="animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function resolvePetPreference(pet: any): PetConfig | null {
  if (!pet) return null;
  if (pet.atlas && pet.spritesheet) return pet as PetConfig;
  const defaults = getDefaultPets();
  return defaults.find(d => d.id === pet.id) || null;
}

function serializePetPreference(pet: PetConfig | null) {
  if (!pet) return null;
  return {
    id: pet.id,
    name: pet.name,
    author: pet.author,
    atlas: pet.atlas,
    spritesheet: pet.spritesheet,
    thumbnail: pet.thumbnail,
    palette: pet.palette,
    tags: pet.tags,
  };
}

type ClientPermissionSnapshot = Record<string, string | boolean | number | null | undefined>;
type ClientRuntimeSnapshot = {
  autostartSupported?: boolean;
  autostartEnabled?: boolean;
  closeToBackground?: boolean;
  startedInBackground?: boolean;
  backendNodeRunning?: boolean;
  backendPythonRunning?: boolean;
  nodeRestarts?: number;
  pythonRestarts?: number;
  globalShortcut?: string;
  lastError?: string;
};

type DesktopWidgetFallbackState = {
  active: boolean;
  size?: { width: number; height: number };
  position?: { x: number; y: number };
  fullscreen?: boolean;
  maximized?: boolean;
};

declare global {
  interface Window {
    lumiElectron?: {
      getSystemInfo: () => Promise<{ platform: string; hostname: string; freeMemory: number }>;
      runCommand: (command: string) => Promise<{ success: boolean; output: string }>;
    };
  }
}

interface WindowProps {
  id: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClose: (id: string) => void;
  isActive: boolean;
  onFocus: (id: string) => void;
  onMinimize: (id: string) => void;
  onMinimizeComplete: (id: string) => void;
  isMinimized: boolean;
  t: any;
  colorClass?: string;
  width?: string | number;
  height?: string | number;
  zIndex?: number;
}

const getViewportSize = (): ViewportSize => {
  if (typeof window === 'undefined') return { width: 1280, height: 820 };
  const visualViewport = window.visualViewport;
  return {
    width: Math.min(window.innerWidth, visualViewport?.width ?? window.innerWidth),
    height: Math.min(window.innerHeight, visualViewport?.height ?? window.innerHeight),
  };
};

function useViewportSize() {
  const [viewport, setViewport] = useState<ViewportSize>(() => getViewportSize());

  useEffect(() => {
    let frame = 0;
    const updateViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewport(getViewportSize()));
    };

    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
    };
  }, []);

  return viewport;
}

const parseWindowLength = (value: string | number | undefined, fallback: number) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

function OSWindow({
  id,
  title,
  icon,
  children,
  onClose,
  isActive,
  onFocus,
  onMinimize,
  onMinimizeComplete,
  isMinimized,
  t,
  colorClass = 'from-celestial-mars to-celestial-saturn',
  width = 'auto',
  height = 'auto',
  zIndex = 10,
}: WindowProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [snapZone, setSnapZone] = useState<'none' | 'left' | 'right'>('none');
  const [isDragging, setIsDragging] = useState(false);
  const dragControls = useDragControls();
  const constrainRef = React.useRef<HTMLDivElement>(null);
  const viewport = useViewportSize();

  const chrome = getDesktopChromeMetrics(viewport);
  const bounds = resolveDesktopWindowBounds(
    viewport,
    parseWindowLength(width, Math.min(900, chrome.availableWidth)),
    parseWindowLength(height, Math.min(700, chrome.availableHeight)),
    isMaximized ? 'maximized' : snapZone,
  );

  return (
    <>
      {/* Invisible drag boundary fills the viewport so windows can be dragged freely */}
      <div ref={constrainRef} className="fixed inset-0 pointer-events-none z-0" />
      <motion.div
        data-lumi-rendered-surface={isMinimized ? undefined : id}
        drag={!isMaximized && !isMinimized}
        dragListener={false}
        dragControls={dragControls}
        dragElastic={0.1}
        dragTransition={{ bounceStiffness: 400, bounceDamping: 25 }}
        dragConstraints={constrainRef}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={(_e, info) => {
          setIsDragging(false);
          if (info.point.x < bounds.safeInset + 80) setSnapZone('left');
          else if (info.point.x > viewport.width - bounds.safeInset - 80) setSnapZone('right');
          else setSnapZone('none');
        }}
        initial={{
          opacity: 0,
          scale: 0.92,
          y: 12,
          filter: 'blur(0px)',
          width: bounds.width,
          height: bounds.height,
          top: bounds.top,
          left: bounds.left,
          x: 0,
        }}
        animate={isMinimized
          ? { opacity: 0, scale: 0.3, y: 40, filter: 'blur(4px)', transition: { duration: 0.25, ease: [0.4, 0, 1, 1] } }
          : {
              opacity: 1,
              scale: 1,
              y: 0,
              filter: 'blur(0px)',
              width: bounds.width,
              height: bounds.height,
              top: bounds.top,
              left: bounds.left,
              x: 0,
              transition: { type: 'spring', stiffness: 300, damping: 26, mass: 0.8 },
            }
        }
        onAnimationComplete={() => {
          if (isMinimized) onMinimizeComplete(id);
        }}
        exit={{ opacity: 0, scale: 0.85, y: 20, filter: 'blur(4px)', transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
        style={{
          zIndex: isMinimized ? zIndex - 100 : zIndex,
          position: 'fixed',
          maxWidth: `calc(100vw - ${bounds.safeInset * 2}px)`,
          maxHeight: `${bounds.availableHeight}px`,
        }}
        onClick={() => !isMinimized && onFocus(id)}
        className={`os-window pointer-events-auto overflow-hidden ${isMaximized ? 'rounded-2xl' : 'rounded-3xl'} ${isActive ? 'ring-1 ring-white/15' : ''} ${isMinimized ? 'pointer-events-none' : ''} ${isDragging ? 'is-dragging' : ''}`}
      >
        <div
          className="os-window-header cursor-move"
          onPointerDown={(event) => {
            if (isMaximized || isMinimized) return;
            if ((event.target as HTMLElement).closest('button')) return;
            dragControls.start(event);
          }}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) return;
            setSnapZone('none');
            setIsMaximized(prev => !prev);
          }}
        >
          <div className="flex min-w-0 items-center gap-3 select-none">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${colorClass} p-1.5 shadow-lg ring-1 ring-white/15 transition-transform`}>
              {React.isValidElement(icon)
                ? React.cloneElement(icon as React.ReactElement<any>, { size: 16, className: 'text-white' })
                : icon}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-black uppercase leading-none tracking-[0.16em] text-white/80">{title}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onMinimize(id); }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
              title={t.minimize || 'Minimize'}
            >
              <Minus size={15} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSnapZone('none');
                setIsMaximized(prev => !prev);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
              title={isMaximized ? (t.restore || 'Restore') : (t.maximize || 'Maximize')}
            >
              {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(id); }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-red-400/30 hover:bg-red-500/15 hover:text-red-100"
              title={t.close || 'Close'}
            >
              <X size={15} />
            </button>
          </div>
        </div>
        <div
          className="os-window-content bg-[#05050a]/98 backdrop-blur-3xl"
          style={isDragging ? { backdropFilter: 'none' } : undefined}
        >
          {children}
        </div>
      </motion.div>
    </>
  );
}

function ControlCenter({ isOpen, onClose, t, brightness, setBrightness, volume, setVolume, lang, setLang, toggleWindow }: {
  isOpen: boolean;
  onClose: () => void;
  t: any;
  brightness: number;
  setBrightness: (v: number) => void;
  volume: number;
  setVolume: (v: number) => void;
  lang: 'en' | 'zh';
  setLang: (l: 'en' | 'zh') => void;
  toggleWindow: (id: string) => void;
}) {
  const { selectedVoiceId, unreadCount } = useApp();

  if (!isOpen) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      className="lumi-control-center fixed right-6 top-12 z-[100] max-h-[calc(100dvh-3.5rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-[2.5rem] border border-white/10 p-6 shadow-[0_30px_70px_rgba(0,0,0,0.7)] backdrop-blur-3xl glass-dark"
    >
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xs font-black uppercase tracking-widest text-white/40">{t.nexusControl || 'Nexus Control'}</h3>
        <div className="flex bg-white/5 p-1 rounded-xl">
           <button 
            onClick={() => setLang('en')}
            className={`px-3 py-1 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${lang === 'en' ? 'bg-white text-black' : 'text-white/40'}`}
           >EN</button>
           <button 
            onClick={() => setLang('zh')}
            className={`px-3 py-1 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${lang === 'zh' ? 'bg-white text-black' : 'text-white/40'}`}
           >ZH</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="col-span-1 bg-white/5 rounded-2xl p-4 flex items-center justify-center gap-3">
             <button
               onClick={async () => {
                 try { const r = await fetch('/api/health'); if (r.ok) toast.info(t.serverOnline); else toast.info(t.serverDegraded); }
                 catch { toast.error(t.serverOffline); }
               }}
               className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white active:scale-95 transition-transform"
               title={t.wifi}
             ><Wifi size={18} /></button>
             <button
               onClick={() => toast.info(t.bluetoothRequiresDesktop)}
               className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white/40 active:scale-95 transition-transform"
               title={t.bluetooth}
             ><Bluetooth size={18} /></button>
        </div>
        <div className="col-span-1 bg-white/5 rounded-[1.5rem] p-5 flex flex-col justify-between">
           <div className="space-y-2">
             <div className="flex justify-between items-center text-xs font-bold text-white/40 uppercase">
               <span>{t.display || 'Display'}</span>
               <Moon size={12} className="text-blue-300/70" />
             </div>
             <div className="h-4 w-full bg-white/5 rounded-full relative group cursor-pointer" onClick={(e) => {
               const rect = e.currentTarget.getBoundingClientRect();
               const percent = (e.clientX - rect.left) / rect.width;
               const v = Math.min(100, Math.max(0, Math.round(percent * 100)));
               setBrightness(v);
               systemService.setBrightness(v);
             }}>
               <motion.div 
                 animate={{ width: `${brightness}%` }}
                 className="h-full bg-white/60 rounded-full" 
               />
             </div>
           </div>
           <div className="space-y-2">
             <div className="flex justify-between items-center text-xs font-bold text-white/40 uppercase">
               <span>{t.sound || 'Sound'}</span>
               <Volume2 size={12} />
             </div>
             <div className="h-4 w-full bg-white/5 rounded-full relative group cursor-pointer" onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const percent = (e.clientX - rect.left) / rect.width;
                const v = Math.min(100, Math.max(0, Math.round(percent * 100)));
                setVolume(v);
                systemService.setVolume(v);
             }}>
               <motion.div
                 animate={{ width: `${volume}%` }}
                 className="h-full bg-celestial-saturn rounded-full"
               />
             </div>
           </div>
        </div>
      </div>

      {/* Quick Access: Personality / Voice / LLM */}
      <div className="space-y-2 mb-6">
        <span className="text-xs font-black text-white/45 uppercase tracking-widest px-2">{t.aiCore || 'AI Core'}</span>
        <div className="space-y-1">
          {/* Voice selector */}
          <button
            onClick={() => { toggleWindow('voice'); onClose(); }}
            className="w-full flex items-center justify-between p-3 bg-white/5 rounded-xl hover:bg-white/10 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Volume2 size={14} className="text-pink-400" />
              <span className="text-xs font-bold text-white/70">{t.voiceLabel || 'Voice'}</span>
            </div>
            <span className="text-xs font-black text-pink-400 uppercase truncate max-w-[100px]">{selectedVoiceId || (t.defaultLabel || 'Default')}</span>
          </button>

          {/* Notifications shortcut */}
          <button
            onClick={() => { toggleWindow('notifications'); onClose(); }}
            className="w-full flex items-center justify-between p-3 bg-white/5 rounded-xl hover:bg-white/10 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Bell size={14} className="text-amber-400" />
              <span className="text-xs font-bold text-white/70">{t.notificationsLabel || 'Notifications'}</span>
            </div>
            <span className="text-xs font-black text-amber-400">{unreadCount} {t.unread || 'unread'}</span>
          </button>
        </div>
      </div>
      <div className="mt-6 pt-6 border-t border-white/5 flex items-center justify-between font-sans">
        <span className="text-xs font-bold text-white/45 tracking-widest uppercase">{t.desktopVersion || 'LumiCore v3.1.0'}</span>
        <button onClick={onClose} className="text-xs font-black text-celestial-saturn hover:underline uppercase tracking-widest">{t.closeNexus || 'Close Nexus'}</button>
      </div>
    </motion.div>
  );
}

interface DesktopIconProps {
  label: string;
  icon: React.ReactNode;
  colorClass: string;
  onClick: () => void;
}

interface DesktopIconDefinition {
  id: string;
  label?: string;
  labelKey?: string;
  icon: React.ReactNode;
  colorClass: string;
  windowId?: string;
  externalLaunch?: {
    capability: ExternalCapabilityProjection;
    action: ExternalCapabilityAction;
  };
}

function externalCapabilityDesktopIcon(icon: string | undefined): React.ReactNode {
  const normalized = String(icon || '').toLowerCase();
  if (/film|video|play|media/.test(normalized)) return <Play size={24} />;
  if (/document|file|text|contract|legal/.test(normalized)) return <FileText size={24} />;
  if (/spark|ai|magic|generate/.test(normalized)) return <Sparkles size={24} />;
  if (/tool|wrench|mcp|plugin/.test(normalized)) return <Wrench size={24} />;
  return <Box size={24} />;
}

function DesktopIcon({ label, icon, colorClass, onClick }: DesktopIconProps) {
  return (
    <div
      onDoubleClick={onClick}
      className="desktop-icon group cursor-pointer"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }}}
    >
      <div className={`desktop-icon-img bg-gradient-to-br ${colorClass} shadow-[0_10px_20px_-5px_rgba(0,0,0,0.5)]`}>
        <div className="text-white group-hover:rotate-12 transition-transform">
          {icon}
        </div>
      </div>
      <span className="desktop-icon-label">{label}</span>
    </div>
  );
}

function SensorPrimer({ isOpen, onContinue, t }: { isOpen: boolean; onContinue: () => void; t: any }) {
  if (!isOpen) return null;

  const items = [
    {
      icon: <Camera size={18} />,
      title: t.visualAwareness || 'Visual awareness',
      desc: t.visualAwarenessDesc || 'Camera access powers presence, face recognition, and gesture-aware desktop behavior.',
    },
    {
      icon: <Mic size={18} />,
      title: t.voiceAwareness || 'Voice awareness',
      desc: t.voiceAwarenessDesc || 'Microphone access powers voice calls, wake word detection, and optional voiceprint enrollment.',
    },
    {
      icon: <Shield size={18} />,
      title: t.localSensorProcessing || 'Local-first processing',
      desc: t.localSensorProcessingDesc || 'Sensor streams are used for the desktop client experience and biometric checks. You can review permissions in Settings.',
    },
  ];

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 pointer-events-auto">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/82 backdrop-blur-2xl"
        />
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18, scale: 0.96 }}
          className="relative w-full max-w-xl rounded-3xl border border-white/10 bg-[#080a10]/95 p-7 shadow-2xl"
        >
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-celestial-saturn/25 bg-celestial-saturn/12 text-celestial-saturn">
              <Shield size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-black uppercase tracking-[0.24em] text-white/35">
                {t.sensorPermissionIntro || 'Sensor permissions'}
              </div>
              <h2 className="mt-2 text-2xl font-black tracking-normal text-white">
                {t.sensorPrimerTitle || 'Enable Lumi desktop awareness'}
              </h2>
              <p className="mt-3 text-sm leading-7 text-white/56">
                {t.sensorPrimerDesc || 'Lumi uses local camera and microphone signals for presence, voice, and biometric features. The feature stays part of the desktop experience; this notice explains what will request permission first.'}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-3">
            {items.map(item => (
              <div key={item.title} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-white/70">
                  {item.icon}
                </div>
                <div>
                  <div className="text-sm font-black text-white/85">{item.title}</div>
                  <p className="mt-1 text-xs leading-5 text-white/45">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-7 flex justify-end">
            <button
              onClick={onContinue}
              className="flex h-11 items-center gap-2 rounded-2xl bg-white px-5 text-sm font-black text-black transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.continueToDesktop || 'Continue'}
              <ChevronRight size={17} />
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

function DesktopWidgetPanel({
  t,
  lang,
  selectedPet,
  equippedAccessories,
  petReaction,
  callState,
  audioLevel,
  transcript,
  operationMode,
  workDomain,
  wakeEnabled,
  wakeListening,
  wakeError,
  onStartVoice,
  onEndVoice,
  onExpand,
  onHide,
  onOpenPersonalization,
}: {
  t: any;
  lang: 'en' | 'zh';
  selectedPet: PetConfig | null;
  equippedAccessories: string[];
  petReaction: { animation: string; until: number } | null;
  callState: string;
  audioLevel: number;
  transcript: string;
  operationMode: OperationMode;
  workDomain: 'personal' | 'work';
  wakeEnabled: boolean;
  wakeListening: boolean;
  wakeError?: string | null;
  onStartVoice: () => void;
  onEndVoice: () => void;
  onExpand: () => void;
  onHide: () => void;
  onOpenPersonalization: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeDropHandledAtRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const isCallActive = callState !== 'idle';
  const widgetPet = selectedPet || getDefaultPets()[0] || null;
  const widgetAccessories = selectedPet ? equippedAccessories : [];
  const statusLabel = isCallActive
    ? (operationMode === 'meeting' ? (uiMessage('desktop-ui.meeting.984f831252', (lang === 'zh') ? 'zh' : 'en')) : callState)
    : wakeEnabled && wakeListening
      ? (uiMessage('desktop-ui.wake-ready.0bf5093bf8', (lang === 'zh') ? 'zh' : 'en'))
      : (uiMessage('desktop-ui.ready.0e6f84aaa2', (lang === 'zh') ? 'zh' : 'en'));
  const reactionAnimation = petReaction?.animation === 'jump' ? 'wave' : petReaction?.animation;
  const petAnimation = reactionAnimation ? reactionAnimation as any :
    callState === 'speaking' ? 'wave' :
    callState === 'listening' ? 'idle' :
    callState !== 'idle' ? 'wave' :
    dragActive || uploading ? 'wave' :
    'idle';
  const speechText = operationMode === 'meeting'
    ? (wakeError ? `Wake: ${wakeError}` : '')
    : transcript || (wakeError ? `Wake: ${wakeError}` : '');
  const showWidgetChrome = isCallActive || dragActive || uploading || Boolean(speechText);
  const chromeVisibility = showWidgetChrome
    ? 'opacity-100 pointer-events-auto'
    : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto';

  const uploadKnowledgeFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(file => formData.append('files', file));
      const res = await fetch(`/api/files/upload?domain=${encodeURIComponent(workDomain)}`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || (uiMessage('desktop-ui.upload-failed.89491ff4a3', (lang === 'zh') ? 'zh' : 'en')));
      const count = Array.isArray(data.files) ? data.files.length : files.length;
      toast.success(formatUiMessage('desktop-ui.fed-value0-file-s.8357f1bc3f', { value0: count }, (lang === 'zh') ? 'zh' : 'en'));
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: workDomain,
          files: (data.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.upload-failed.89491ff4a3', (lang === 'zh') ? 'zh' : 'en')));
    } finally {
      setUploading(false);
      setDragActive(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [lang, uploading, workDomain]);

  const uploadKnowledgePaths = useCallback(async (paths: string[]) => {
    const importPaths = paths.map(p => String(p || '').trim()).filter(Boolean);
    if (importPaths.length === 0 || uploading) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/files/import-paths?domain=${encodeURIComponent(workDomain)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lumi-Desktop-Import': 'file-drop' },
        body: JSON.stringify({ paths: importPaths }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || (uiMessage('desktop-ui.feed-failed.1e27b5712f', (lang === 'zh') ? 'zh' : 'en')));
      const count = Array.isArray(data.files) ? data.files.length : importPaths.length;
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      toast.success(
        formatUiMessage('desktop-ui.fed-value0-file-s-value1.167b70a2bd', { value0: count, value1: { en: skipped ? `, skipped ${skipped}` : '', zh: skipped ? `，跳过 ${skipped} 个` : '' } }, (lang === 'zh') ? 'zh' : 'en'),
      );
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: workDomain,
          files: (data.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.feed-failed.1e27b5712f', (lang === 'zh') ? 'zh' : 'en')));
    } finally {
      setUploading(false);
      setDragActive(false);
    }
  }, [lang, uploading, workDomain]);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setupDropListener = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (cancelled) return;
        unlisten = await getCurrentWindow().onDragDropEvent((event: any) => {
          const payload = event?.payload;
          if (payload?.type === 'over') {
            setDragActive(true);
            return;
          }
          if (payload?.type === 'drop') {
            nativeDropHandledAtRef.current = Date.now();
            setDragActive(false);
            const paths = Array.isArray(payload.paths) ? payload.paths : [];
            void uploadKnowledgePaths(paths);
            return;
          }
          setDragActive(false);
        });
        if (cancelled) unlisten?.();
      } catch {}
    };

    void setupDropListener();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [uploadKnowledgePaths]);

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (Date.now() - nativeDropHandledAtRef.current < 700) return;
    void uploadKnowledgeFiles(event.dataTransfer.files);
  };

  const handleWidgetDragStart = async (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-widget-action="true"]')) return;
    try {
      const windowApi = await import('@tauri-apps/api/window');
      await windowApi.getCurrentWindow().startDragging();
    } catch {}
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-transparent text-white">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void uploadKnowledgeFiles(event.currentTarget.files)}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="group relative h-full w-full overflow-hidden bg-transparent"
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPointerDown={handleWidgetDragStart}
      >
        <div data-tauri-drag-region className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing" />

        <AnimatePresence>
          {dragActive && (
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              className="absolute inset-5 z-40 flex items-center justify-center rounded-[28px] border border-cyan-300/35 bg-cyan-300/10 text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.16)] backdrop-blur-md"
            >
              <Upload size={30} />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          data-tauri-drag-region
          className={`absolute left-1/2 top-2 z-20 flex -translate-x-1/2 cursor-move items-center gap-1.5 rounded-full border border-white/8 bg-black/28 px-2.5 py-1 text-[10px] font-black text-white/65 shadow-lg backdrop-blur-lg transition-opacity duration-200 ${chromeVisibility}`}
        >
          <span className={`h-2 w-2 rounded-full ${isCallActive ? 'bg-celestial-saturn shadow-[0_0_14px_rgba(255,204,0,0.85)]' : 'bg-emerald-400'}`} />
          <span className="max-w-[104px] truncate">{statusLabel}</span>
        </motion.div>

        <AnimatePresence>
          {speechText && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              className={`absolute left-3 right-11 top-10 z-20 rounded-2xl border px-2.5 py-1.5 text-[11px] leading-4 shadow-xl backdrop-blur-lg ${
                wakeError && !transcript
                  ? 'border-red-300/18 bg-red-950/45 text-red-100/78'
                  : 'border-white/10 bg-black/42 text-white/72'
              }`}
            >
              <p className="line-clamp-2">{speechText}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className={`absolute right-1.5 top-12 z-30 flex flex-col gap-1.5 transition-opacity duration-200 ${chromeVisibility}`}>
          <button
            data-widget-action="true"
            onClick={onExpand}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-black/30 text-white/58 shadow-lg backdrop-blur-lg transition-colors hover:bg-white/12 hover:text-white"
            title={uiMessage('desktop-ui.expand-lumi.b72aee2f04', (lang === 'zh') ? 'zh' : 'en')}
          >
            <Maximize2 size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onOpenPersonalization}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-fuchsia-300/14 bg-fuchsia-300/9 text-fuchsia-100/72 shadow-lg backdrop-blur-lg transition-colors hover:bg-fuchsia-300/18 hover:text-white"
            title={t.personalization || 'Personalization'}
          >
            <Brush size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onHide}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-black/30 text-white/52 shadow-lg backdrop-blur-lg transition-colors hover:bg-white/12 hover:text-white"
            title={uiMessage('desktop-ui.hide-to-background.2db659458c', (lang === 'zh') ? 'zh' : 'en')}
          >
            <Minus size={14} />
          </button>
        </div>

        <div
          data-tauri-drag-region
          className="absolute left-1/2 top-[47%] z-10 flex h-40 w-40 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full transition-transform hover:scale-[1.03] active:cursor-grabbing active:scale-95"
          title={widgetPet?.name || (uiMessage('desktop-ui.drag-lumi.37ae7800b2', (lang === 'zh') ? 'zh' : 'en'))}
        >
          <motion.div
            className="absolute inset-7 rounded-full bg-cyan-200/7 blur-xl"
            animate={{
              scale: isCallActive ? [1, 1.12 + audioLevel * 0.35, 1] : 1,
              opacity: isCallActive ? [0.2, 0.5, 0.2] : 0,
            }}
            transition={{ duration: isCallActive ? 0.9 : 0.2, repeat: isCallActive ? Infinity : 0 }}
          />
          {widgetPet ? (
            <PetAvatar
              pet={widgetPet}
              animation={petAnimation}
              accessoryIds={widgetAccessories}
              scale={0.68}
              audioLevel={audioLevel}
              callState={callState}
              behavior="default"
            />
          ) : (
            <Sparkles size={54} className="text-celestial-saturn/80 drop-shadow-[0_0_18px_rgba(255,204,0,0.32)]" />
          )}
        </div>

        <div className={`absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 transition-opacity duration-200 ${chromeVisibility}`}>
          <button
            data-widget-action="true"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-cyan-300/18 bg-cyan-300/10 text-cyan-100 shadow-lg backdrop-blur-lg transition-colors hover:bg-cyan-300/20 disabled:opacity-60"
            title={uiMessage('desktop-ui.feed-files.f5edc50e24', (lang === 'zh') ? 'zh' : 'en')}
          >
            {uploading ? <RefreshCw size={17} className="animate-spin" /> : <Upload size={18} />}
          </button>
          <button
            data-widget-action="true"
            onClick={isCallActive ? onEndVoice : onStartVoice}
            className={`flex h-12 w-12 items-center justify-center rounded-full border shadow-xl backdrop-blur-lg transition-colors ${
              isCallActive
                ? 'border-red-300/32 bg-red-500/20 text-red-100 hover:bg-red-500/28'
                : 'border-celestial-saturn/28 bg-celestial-saturn/16 text-celestial-saturn hover:bg-celestial-saturn/24'
            }`}
            title={isCallActive ? (uiMessage('desktop-ui.end-voice.d265560105', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.voice.fee5489af0', (lang === 'zh') ? 'zh' : 'en'))}
          >
            <Mic size={20} className={isCallActive ? 'animate-pulse' : ''} />
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function KernelMonitorApp({ t, onAsk }: { t: any; onAsk?: (prompt: string) => void }) {
  const [data, setData] = useState<number[]>([]);
  const overviewRef = useRef<any>(null);
  const [stats, setStats] = useState({
    cpu: 0,
    cpuModel: '',
    logicalCpus: 0,
    physicalCpus: null as number | null,
    ram: { used: 0, total: 0, percent: 0 },
    platform: '', release: '', arch: '', hostname: '', uptime: 0,
    gpu: null as { name?: string; util?: number } | null,
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        if (!overviewRef.current) {
          const [response, nativeInfo] = await Promise.all([
            fetch('/api/system/stats'),
            systemService.getSystemStats(),
          ]);
          const serverInfo = response.ok ? await response.json() : {};
          overviewRef.current = nativeInfo?.memory_unit === 'bytes'
            ? {
                ...serverInfo,
                platform: nativeInfo.platform || serverInfo.platform,
                release: nativeInfo.release || serverInfo.release,
                arch: nativeInfo.arch || serverInfo.arch,
                hostname: nativeInfo.hostname || serverInfo.hostname,
                cpuModel: nativeInfo.cpu_model || serverInfo.cpuModel,
                logicalCpus: nativeInfo.logical_cpus || serverInfo.logicalCpus,
                physicalCpus: nativeInfo.cpus || serverInfo.physicalCpus,
              }
            : serverInfo;
        }
        const live = await systemService.getLiveStats();
        const overview = overviewRef.current || {};
        const sys = {
          cpu: live.cpu_percent || 0,
          cpuModel: overview.cpuModel || '',
          logicalCpus: overview.logicalCpus || overview.cpus || 0,
          physicalCpus: overview.physicalCpus ?? null,
          ram: {
            used: live.memory_used_gb || 0,
            total: live.memory_total_gb || 0,
            percent: live.memory_percent || 0,
          },
          platform: overview.platform || '',
          release: overview.release || '',
          arch: overview.arch || '',
          hostname: live.hostname || overview.hostname || '',
          uptime: live.uptime_seconds || overview.uptime || 0,
          gpu: (live.gpu_vendor || overview.gpu?.name)
            ? { name: live.gpu_vendor || overview.gpu?.name, util: live.gpu_utilization ?? overview.gpu?.util }
            : null,
        };
        setStats(sys);
        setData(prev => {
          const next = [...prev, sys.cpu || 0];
          return next.slice(-30);
        });
      } catch {}
    };
    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
  }, []);

  const chipLabel = stats.cpuModel || (stats.platform ? `${stats.platform.toUpperCase()}_${stats.arch.toUpperCase()}_NODE` : 'NEURAL_NODE');
  const uptimeFmt = stats.uptime ? `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m` : '';
  const loadStatus = stats.cpu > 80 ? 'WARN' : stats.cpu > 50 ? 'LOAD' : 'IDLE';

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-8 space-y-6 font-sans">
      <div className="flex justify-between items-center bg-black/40 p-5 rounded-[2rem] border border-white/5 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-celestial-saturn/10 flex items-center justify-center text-celestial-saturn border border-celestial-saturn/20 shadow-[0_0_20px_rgba(255,200,80,0.1)]">
            <Cpu size={24} />
          </div>
          <div>
            <div className="text-xs font-black text-white/40 uppercase tracking-widest leading-none mb-1">{stats.hostname || t.localIntelNode || 'Local Node'}</div>
            <div className="max-w-[min(50vw,38rem)] truncate text-lg font-black text-white tracking-tight" title={chipLabel}>{chipLabel}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-black text-celestial-saturn uppercase tracking-widest leading-none mb-1">{loadStatus} / {stats.physicalCpus || '?'} cores / {stats.logicalCpus} threads / {uptimeFmt}</div>
          <div className="text-xs font-mono text-white/40">{stats.release || ''} / CPU {stats.cpu}%</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          { label: t.neuralThroughput || 'CPU Load', value: `${stats.cpu}%`, bar: stats.cpu, color: 'bg-celestial-saturn' },
          { label: t.synapticLoad || 'Memory', value: `${stats.ram.used} / ${stats.ram.total} GB`, bar: stats.ram.percent, color: 'bg-emerald-500' },
          { label: 'GPU', value: stats.gpu?.name || (t.notDetected || 'Not detected'), bar: stats.gpu?.util || 0, color: 'bg-blue-500' }
        ].map((stat, i) => (
          <div key={i} className="p-5 bg-white/5 rounded-[2rem] border border-white/5 space-y-3 hover:bg-white/10 transition-colors cursor-default">
            <div className="text-[12px] font-black text-white/45 uppercase tracking-[0.2em]">{stat.label}</div>
            <div className="min-h-10 break-words text-base font-black text-white" title={String(stat.value)}>{stat.value}</div>
            <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${stat.bar}%` }} className={`h-full ${stat.color}`} />
            </div>
          </div>
        ))}
      </div>

      <div className="h-48 bg-black/40 rounded-[2.5rem] border border-white/5 p-6 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="w-full h-full" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
        </div>
        <div className="relative h-full flex items-end gap-1">
          {data.map((val, i) => (
            <motion.div
              key={i}
              initial={{ height: 0 }}
              animate={{ height: `${val}%` }}
              className="flex-1 bg-gradient-to-t from-celestial-saturn/40 to-celestial-saturn rounded-t-sm"
              style={{ minWidth: '4px' }}
            />
          ))}
        </div>
      </div>

      <div className="rounded-[2rem] border border-white/5 bg-black/20 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Monitor size={16} className="text-cyan-300" />
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-white/70">{t.computerAdaptation || 'Computer Adaptation'}</h3>
            <p className="mt-1 text-xs text-white/35">{t.kernelExploreMergedDesc || 'Runtime monitor and computer exploration are merged into this single kernel view.'}</p>
          </div>
        </div>
        <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
          <SystemExplorer t={t} onAsk={onAsk} />
        </Suspense>
      </div>

    </div>
  );
}
function Spotlight({ isOpen, onClose, onSelect, apps, t }: { isOpen: boolean; onClose: () => void; onSelect: (id: string) => void; apps: any[]; t: any }) {
  const [query, setQuery] = useState('');
  
  const filteredApps = apps.filter(app => 
    app.label.toLowerCase().includes(query.toLowerCase()) || 
    app.id.toLowerCase().includes(query.toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[15vh] px-4 pointer-events-auto"
      onClick={onClose}
    >
      <motion.div 
        initial={{ y: -20, scale: 0.95 }}
        animate={{ y: 0, scale: 1 }}
        className="w-full max-w-xl glass-dark border border-white/10 rounded-[2rem] overflow-hidden shadow-[0_50px_100px_rgba(0,0,0,0.8)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 flex items-center gap-4 border-b border-white/5">
          <Search size={24} className="text-white/40" />
          <input 
            autoFocus
            placeholder={t.searchNeuralHub || "Search Lumi Neural Hub..."}
            className="flex-1 bg-transparent border-none outline-none text-xl font-bold text-white placeholder:text-white/45"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className="px-2 py-1 bg-white/5 rounded text-xs font-black text-white/40 tracking-widest border border-white/5">ESC</div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
          {filteredApps.length > 0 ? (
            filteredApps.map(app => (
              <button
                key={app.id}
                onClick={() => { onSelect(app.id); onClose(); }}
                className="w-full p-4 flex items-center gap-4 hover:bg-white/5 rounded-2xl transition-colors text-left group"
              >
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${app.color} flex items-center justify-center p-2 shadow-lg`}>
                  {React.isValidElement(app.icon) ? React.cloneElement(app.icon, { size: 24 }) : app.icon}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-black text-white tracking-tight">{app.label}</div>
                  <div className="text-xs text-white/55 uppercase tracking-widest">{t.neuralApp || 'Neural Application'}</div>
                </div>
                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <ChevronRight size={16} className="text-white/40" />
                </div>
              </button>
            ))
          ) : (
             <div className="p-12 text-center text-white/45">
                <BrainCircuit size={48} className="mx-auto mb-4 opacity-10" />
                <p className="text-xs font-black uppercase tracking-widest">{t.noNeuralNodes || 'No neural nodes found'}</p>
             </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ExecutionWorkQueue({ t }: { t: any }) {
  const isZh = t?.langCode !== 'en';
  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-8">
      <section className="lumi-surface min-h-full rounded-3xl bg-black/20 p-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-black uppercase tracking-widest text-white/85">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn">
              <Calendar size={18} />
            </span>
            {uiMessage('desktop-ui.lumi-learning-absorption.63919d4e18', (isZh) ? 'zh' : 'en')}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/42">
            {uiMessage('desktop-ui.this-is-lumi-s-own.657323f25a', (isZh) ? 'zh' : 'en')}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.25fr]">
        <DailyPlans t={t} embedded />
        <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
          <AutonomousFeed expanded />
        </Suspense>
      </div>
      </section>
    </div>
  );
}

function DailyPlans({ t, embedded = false, onOpenQueue }: { t: any; embedded?: boolean; onOpenQueue?: () => void }) {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyPlanIds, setBusyPlanIds] = useState<string[]>([]);
  const isZh = t?.langCode !== 'en';
  const activeCount = plans.length;

  const loadPlans = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/plans?status=active', { credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Failed to load plans');
      setPlans((d.plans || [])
        .filter((p: any) => (p.source === 'lumi' || p.source === 'auto') && p.status !== 'done' && p.status !== 'completed' && p.status !== 'cancelled')
        .slice(0, 8));
    } catch (err: any) {
      toast.error(err?.message || (t.planLoadFailed || 'Failed to load plans'));
    } finally { setLoading(false); }
  }, [t.planLoadFailed]);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

  const deletePlan = async (id: string) => {
    setBusyPlanIds(prev => prev.includes(id) ? prev : [...prev, id]);
    try {
      const res = await fetch(`/api/plans/${id}`, { method: 'DELETE', credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Failed to delete plan');
      setPlans(prev => prev.filter(p => p.id !== id));
      toast.success(t.planDeleted || 'Plan deleted');
    } catch (err: any) {
      toast.error(err?.message || (t.planDeleteFailed || 'Failed to delete plan'));
    } finally {
      setBusyPlanIds(prev => prev.filter(planId => planId !== id));
    }
  };

  const getStepInfo = (plan: any) => {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const done = steps.filter((step: any) => step.status === 'done' || step.status === 'skipped').length;
    const activeStep = steps.find((step: any) => step.status === 'in_progress')
      || steps.find((step: any) => step.status === 'pending');
    const label = activeStep
      ? activeStep.status === 'in_progress'
        ? (uiMessage('desktop-ui.absorbing.9a2002c5f8', (isZh) ? 'zh' : 'en'))
        : activeStep.title
      : (uiMessage('desktop-ui.waiting-for-next-run.d3f6c83394', (isZh) ? 'zh' : 'en'));
    return { steps, done, label };
  };

  const formatUpdatedAt = (value?: string) => {
    if (!value) return '';
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return '';
    return time.toLocaleTimeString(isZh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <GlassCard
      className={`lumi-panel ${embedded ? 'h-full' : 'cursor-pointer hover:bg-white/[0.05]'} space-y-3 rounded-2xl bg-black/20 p-5 transition-colors`}
      onClick={onOpenQueue}
    >
      <div className="flex items-center justify-between">
        <div>
          <span className="text-[12px] font-black uppercase tracking-widest text-white/65 flex items-center gap-2">
            <Calendar size={12} className="text-celestial-saturn" />
            {embedded ? (uiMessage('desktop-ui.lumi-learning-plans.217854e552', (isZh) ? 'zh' : 'en')) : (uiMessage('desktop-ui.lumi-learning.e36f32b264', (isZh) ? 'zh' : 'en'))}
          </span>
          {!embedded && (
            <p className="mt-1 text-[11px] text-white/30">
              {activeCount > 0
                ? (formatUiMessage('desktop-ui.value0-learning-plan-value1.cb87ad5f27', { value0: activeCount, value1: { en: activeCount === 1 ? '' : 's', zh: '' } }, (isZh) ? 'zh' : 'en'))
                : (uiMessage('desktop-ui.no-learning-plans.0a25534ef8', (isZh) ? 'zh' : 'en'))}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenQueue && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenQueue(); }}
              className="lumi-button h-7 px-2 text-[10px]"
            >
              {uiMessage('desktop-ui.queue.9b6d779554', (isZh) ? 'zh' : 'en')}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-white/30 text-xs py-2">{uiMessage('desktop-ui.loading.586f5af819', (isZh) ? 'zh' : 'en')}</div>
      ) : plans.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-3 text-xs text-white/30">
          {uiMessage('desktop-ui.lumi-has-not-generated-learning.6c804f7045', (isZh) ? 'zh' : 'en')}
        </div>
      ) : (
        <div className="space-y-2">
          {plans.map((plan: any) => {
            const { steps, done, label } = getStepInfo(plan);
            const progress = steps.length > 0 ? `${done}/${steps.length}` : (uiMessage('desktop-ui.queued.bb6e139347', (isZh) ? 'zh' : 'en'));
            const updatedAt = formatUpdatedAt(plan.updatedAt);
            return (
              <div key={plan.id} className="group rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${plan.priority === 'critical' ? 'bg-red-300' : plan.priority === 'high' ? 'bg-orange-300' : plan.priority === 'medium' ? 'bg-amber-300' : 'bg-white/25'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-bold text-white/70">{plan.title}</span>
                      <span className="shrink-0 rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-2 py-0.5 text-[10px] font-bold text-celestial-saturn/80">
                        {progress}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-white/35">
                      <span className="truncate">{label}</span>
                      {updatedAt && <span className="shrink-0 font-mono">{updatedAt}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deletePlan(plan.id); }}
                    disabled={busyPlanIds.includes(plan.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/15 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-200 group-hover:opacity-100 disabled:opacity-30"
                    title={uiMessage('desktop-ui.remove-plan.1f9be63399', (isZh) ? 'zh' : 'en')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}

interface MeetingNote {
  id: string;
  text: string;
  time: number;
  speakerLabel?: string | null;
  speakerConfidence?: number;
  speakerSource?: string;
  speakerMatched?: boolean;
}

interface RefinedMeetingSegment {
  text?: string;
  beginMs?: number;
  endMs?: number;
  speakerId?: number | null;
  speakerLabel?: string | null;
}

export function DesktopUI({ 
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
    ? `org_${orgConnection?.orgId || 'pending'}`
    : `personal_${user?.uid || 'local'}`;
  const meetingStorageKeys = useMemo(() => ({
    startedAt: `lumi_meeting_started_at_${meetingPreferenceScopeKey}`,
    notes: `lumi_meeting_notes_${meetingPreferenceScopeKey}`,
    report: `lumi_meeting_report_${meetingPreferenceScopeKey}`,
  }), [meetingPreferenceScopeKey]);
  const canCustomizeLumiAppearance = workDomain !== 'work'
    || ['owner', 'admin'].includes(String(orgConnection?.orgRole || ''));

  const initialCommandCenterOpen = activeTab === 'chat' || activeTab === 'command-center';
  const initialWindowId = activeTab !== 'home' && activeTab !== 'knowledge' && !initialCommandCenterOpen ? activeTab : null;
  const [openWindows, setOpenWindows] = useState<string[]>(initialWindowId ? [initialWindowId] : []);
  const [minimizedWindows, setMinimizedWindows] = useState<string[]>([]);
  const [focusedWindow, setFocusedWindow] = useState<string | null>(initialWindowId);
  const [windowOrder, setWindowOrder] = useState<string[]>(initialWindowId ? [initialWindowId] : []);
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
  const [chatPrefill, setChatPrefill] = useState('');
  const [chatPrefillSource, setChatPrefillSource] = useState('proactive');
  const [chatAttachmentRequest, setChatAttachmentRequest] = useState<ChatAttachmentRequest | null>(null);
  const [sanctuaryOpen, setSanctuaryOpen] = useState(false);
  const [sanctuaryLoaded, setSanctuaryLoaded] = useState(false);
  const [sanctuaryAgent, setSanctuaryAgent] = useState<any>(null);
  const [memoryAvatars, setMemoryAvatars] = useState<any[]>([]);
  const [petReaction, setPetReaction] = useState<{ animation: string; until: number } | null>(null);
  const [activePersonality, setActivePersonality] = useState('lumi');
  const petReactionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [memoryLabOpen, setMemoryLabOpen] = useState(false);
  const surfaceReturnTargetRef = useRef<SurfaceReturnTarget>('home');

  const triggerPetReaction = (animation: string, ms: number = 1500) => {
    if (petReactionTimeout.current) clearTimeout(petReactionTimeout.current);
    setPetReaction({ animation, until: Date.now() + ms });
    petReactionTimeout.current = setTimeout(() => setPetReaction(null), ms);
  };

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

  const [theme, setTheme] = useState<string>('celestial');
  useEffect(() => {
    const themeForMode: Partial<Record<OperationMode, string>> = {
      chat: 'celestial',
      assistant: 'nebula',
      autonomous: 'cyber',
    };
    const nextTheme = themeForMode[operationMode];
    if (nextTheme && theme !== nextTheme) setTheme(nextTheme);
  }, [operationMode, theme]);
  const [clientPermissions, setClientPermissions] = useState<ClientPermissionSnapshot>({});
  const [clientRuntime, setClientRuntime] = useState<ClientRuntimeSnapshot>({});
  const [isControlCenterOpen, setIsControlCenterOpen] = useState(false);
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('general');
  const [personalizationSection, setPersonalizationSection] = useState<'appearance' | 'voice'>('appearance');
  const [brightness, setBrightness] = useState(85);
  const [volume, setVolume] = useState(60);
  const [time, setTime] = useState(new Date());
  const [isWallpaperMode, setIsWallpaperMode] = useState(false);
  const [isDesktopWidgetMode, setIsDesktopWidgetMode] = useState(false);
  const [isCompactWindowMode, setIsCompactWindowMode] = useState(false);
  const [externalCapabilities, setExternalCapabilities] = useState<ExternalCapabilityProjection[]>([]);
  const externalCapabilityLaunchesRef = useRef(new Set<string>());
  const externalCapabilityExecutionRequestsRef = useRef(new Map<string, ExternalCapabilityExecutionCorrelation>());
  const isWallpaperModeRef = useRef(false);
  const closeToBackgroundSyncRef = useRef(false);

  // Command Center and Wallpaper are both deliberate focus surfaces. Either
  // one is enough to keep Lumi above other apps; normal stacking returns only
  // after both have closed. Widget mode keeps its existing topmost contract.
  useEffect(() => {
    const shouldStayOnTop = chatOpen || isWallpaperMode || isDesktopWidgetMode;
    void systemService.setAlwaysOnTop(shouldStayOnTop).catch(error => {
      console.error('Failed to synchronize Lumi window level:', error);
    });
  }, [chatOpen, isDesktopWidgetMode, isWallpaperMode]);

  useEffect(() => () => {
    void systemService.setAlwaysOnTop(false).catch(() => {});
  }, []);
  const desktopWidgetFallbackRef = useRef<DesktopWidgetFallbackState | null>(null);
  const wallpaperAutomationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wallpaperWasEnabledBeforeAutomationRef = useRef(false);
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

  useEffect(() => {
    isWallpaperModeRef.current = isWallpaperMode;
    if (isWallpaperMode) setWallpaperWorkPromptVisible(false);
  }, [isWallpaperMode]);

  const syncWallpaperModeView = useCallback((enabled: boolean) => {
    isWallpaperModeRef.current = enabled;
    setIsWallpaperMode(enabled);
    systemService.syncWallpaperDocumentMode(enabled);
  }, []);

  useEffect(() => {
    if (chatOpen) setWallpaperWorkPromptVisible(false);
  }, [chatOpen]);

  const openCommandCenter = useCallback((view: CommandCenterView = 'office') => {
    // Command Center is the canonical parent surface.  Opening it always
    // dismisses utility overlays and consumes any previous return context.
    surfaceReturnTargetRef.current = 'home';
    setKnowledgeOpen(false);
    setMemoryLabOpen(false);
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    setCommandCenterView(view);
    setOpenWindows(previous => previous.filter(windowId => !['chat', 'command-center'].includes(windowId)));
    setMinimizedWindows(previous => previous.filter(windowId => !['chat', 'command-center'].includes(windowId)));
    setWindowOrder(previous => previous.filter(windowId => !['chat', 'command-center'].includes(windowId)));
    setFocusedWindow(previous => ['chat', 'command-center'].includes(previous || '') ? null : previous);
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
  }, [isTauri, setActiveTab]);

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
    // Only one full-screen surface owns focus at a time.
    setChatOpen(false);
    setChatPrefill('');
    setChatPrefillSource('proactive');
    setMemoryLabOpen(false);
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    setKnowledgeLoaded(true);
    setKnowledgeOpen(true);
    setActiveTab('knowledge');
  }, [inferSurfaceReturnTarget, setActiveTab]);

  const closeKnowledgeBase = useCallback(() => {
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

  // Memory Avatars are private, tool-free surfaces. Keep the list in the
  // shell so the command center can open an existing avatar, switch between
  // avatars, or start another distillation without being trapped on the first
  // one that was created.
  const loadMemoryAvatars = useCallback(async (): Promise<any[]> => {
    try {
      const res = await fetch('/api/memory-avatars', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const avatars = Array.isArray(data?.avatars) ? data.avatars : [];
        setMemoryAvatars(avatars);
        return avatars;
      }
    } catch {}
    return memoryAvatars;
  }, [memoryAvatars]);

  const openMemoryAvatar = useCallback(async (avatarId?: string, returnTarget?: SurfaceReturnTarget) => {
    try { sounds.playClick(); } catch {}
    // The right rail invokes this while the Command Center is still open;
    // direct desktop launches use the personal surface.  Avatar switching
    // from an already-open Sanctuary intentionally preserves its origin.
    if (returnTarget) {
      surfaceReturnTargetRef.current = returnTarget;
    } else if (chatOpen || activeTab === 'command-center') {
      surfaceReturnTargetRef.current = 'command-center';
    } else if (!sanctuaryOpen && !memoryLabOpen) {
      surfaceReturnTargetRef.current = 'home';
    }
    const avatars = await loadMemoryAvatars();
    const selected = avatarId
      ? avatars.find(avatar => avatar?.id === avatarId)
      : avatars[0];
    // A stale menu entry must never silently open another person's/avatar's
    // transcript.  Keep the current surface in place and let the next open
    // refresh the list instead of falling back to avatars[0].
    if (avatarId && !selected) return;
    // Memory Avatar is a separate fullscreen surface. Close the command
    // center and any other utility before presenting it so two focus traps
    // never stack.  The recorded origin is restored by closeMemoryAvatar.
    setChatOpen(false);
    setKnowledgeOpen(false);
    setChatPrefill('');
    setChatPrefillSource('proactive');
    setActiveTab('home');
    if (selected) {
      setSanctuaryAgent(selected);
      setSanctuaryLoaded(true);
      setSanctuaryOpen(true);
      setMemoryLabOpen(false);
      return;
    }
    setMemoryLabOpen(true);
  }, [activeTab, chatOpen, loadMemoryAvatars, memoryLabOpen, sanctuaryOpen, setActiveTab]);

  const openMemoryAvatarLab = useCallback((returnTarget?: SurfaceReturnTarget) => {
    if (returnTarget) {
      surfaceReturnTargetRef.current = returnTarget;
    } else if (!sanctuaryOpen && !memoryLabOpen && !(chatOpen || activeTab === 'command-center')) {
      surfaceReturnTargetRef.current = 'home';
    }
    setChatOpen(false);
    setKnowledgeOpen(false);
    setChatPrefill('');
    setChatPrefillSource('proactive');
    setActiveTab('home');
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    setMemoryLabOpen(true);
  }, [activeTab, chatOpen, memoryLabOpen, sanctuaryOpen, setActiveTab]);

  const closeMemoryAvatar = useCallback(() => {
    setMemoryLabOpen(false);
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    restoreSurfaceReturnTarget();
  }, [restoreSurfaceReturnTarget]);

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
    setChatPrefillSource('proactive_context');
    setChatPrefill(formatProactiveChatPrefill(detail, lang));
    openCommandCenter('office');
  }, [lang, openCommandCenter]);

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
  }, [lang, openCommandCenter, orgConnection?.connected, orgConnection?.orgId, workDomain]);

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
    { id: 'tools', labelKey: 'tools', icon: <Wrench size={24} />, colorClass: 'from-amber-500 to-orange-600', windowId: 'tools' },
    { id: 'skills', labelKey: 'skills', icon: <Sparkles size={24} />, colorClass: 'from-emerald-500 to-teal-600', windowId: 'skills' },
    { id: 'personalization', label: t.personalization || (uiMessage('desktop-ui.personalization.2c4d8e1f06', (lang === 'zh') ? 'zh' : 'en')), icon: <Brush size={24} />, colorClass: 'from-cyan-400 to-indigo-600', windowId: 'personalization' },
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
  }, [isTauri]);

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
  const showMcpPanel = false;
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'done' | 'error'>('idle');
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [pendingOperationMode, setPendingOperationMode] = useState<OperationMode | null>(null);
  const seenWorkflowToolEvents = useRef<Set<string>>(new Set());
  const autonomousTaskStatusRef = useRef<Map<string, string>>(new Map());
  const readMeetingItem = useCallback((scopedKey: string, legacyKey: string): string | null => (
    localStorage.getItem(scopedKey)
      ?? (workDomain === 'personal' ? localStorage.getItem(legacyKey) : null)
  ), [workDomain]);
  const [meetingNotesOpen, setMeetingNotesOpen] = useState(false);
  const [meetingPaused, setMeetingPaused] = useState(false);
  const [meetingStartedAt, setMeetingStartedAt] = useState<number | null>(() => {
    const saved = readMeetingItem(meetingStorageKeys.startedAt, 'lumi_meeting_started_at');
    return saved ? Number(saved) || null : null;
  });
  const [meetingNotes, setMeetingNotes] = useState<MeetingNote[]>(() => {
    try { return JSON.parse(readMeetingItem(meetingStorageKeys.notes, 'lumi_meeting_notes') || '[]'); } catch { return []; }
  });
  const [meetingSpeakerCount, setMeetingSpeakerCount] = useState(0);
  const [meetingReport, setMeetingReport] = useState<string>(() => readMeetingItem(meetingStorageKeys.report, 'lumi_meeting_report') || '');
  const [meetingReportGenerating, setMeetingReportGenerating] = useState(false);
  const [legalMeetingCaseTitle, setLegalMeetingCaseTitle] = useState(() => getLegalCaseLabel(getLegalConsultationCase()));
  const meetingModeRef = useRef(operationMode === 'meeting');
  const meetingPausedRef = useRef(meetingPaused);
  const meetingVoiceActiveRef = useRef(false);
  const lastMeetingTranscriptRef = useRef<{ text: string; at: number; speakerKey: string }>({ text: '', at: 0, speakerKey: '' });
  const lastLegalMeetingArchiveRef = useRef('');
  useEffect(() => {
    const savedStartedAt = readMeetingItem(meetingStorageKeys.startedAt, 'lumi_meeting_started_at');
    let savedNotes: MeetingNote[] = [];
    try {
      const parsed = JSON.parse(readMeetingItem(meetingStorageKeys.notes, 'lumi_meeting_notes') || '[]');
      savedNotes = Array.isArray(parsed) ? parsed : [];
    } catch {}
    setMeetingPaused(false);
    setMeetingStartedAt(savedStartedAt ? Number(savedStartedAt) || null : null);
    setMeetingNotes(savedNotes);
    setMeetingSpeakerCount(new Set(savedNotes.map(note => note.speakerLabel).filter(Boolean)).size);
    setMeetingReport(readMeetingItem(meetingStorageKeys.report, 'lumi_meeting_report') || '');
    setLegalMeetingCaseTitle(workDomain === 'personal' ? getLegalCaseLabel(getLegalConsultationCase()) : '');
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
    lastLegalMeetingArchiveRef.current = '';
  }, [
    meetingPreferenceScopeKey,
    meetingStorageKeys.notes,
    meetingStorageKeys.report,
    meetingStorageKeys.startedAt,
    readMeetingItem,
    workDomain,
  ]);
  useEffect(() => {
    meetingModeRef.current = operationMode === 'meeting';
  }, [operationMode]);
  useEffect(() => {
    meetingPausedRef.current = meetingPaused;
  }, [meetingPaused]);

  const persistMeetingNotes = useCallback((notes: MeetingNote[]) => {
    localStorage.setItem(meetingStorageKeys.notes, JSON.stringify(notes.slice(-300)));
  }, [meetingStorageKeys.notes]);

  const resetMeetingCapture = useCallback((startedAt = Date.now()) => {
    setMeetingPaused(false);
    setMeetingNotes([]);
    setMeetingSpeakerCount(0);
    setMeetingReport('');
    setMeetingStartedAt(startedAt);
    localStorage.setItem(meetingStorageKeys.notes, '[]');
    localStorage.removeItem(meetingStorageKeys.report);
    localStorage.setItem(meetingStorageKeys.startedAt, String(startedAt));
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
  }, [meetingStorageKeys]);

  const meetingSpeakerLabel = useCallback((note: Pick<MeetingNote, 'speakerLabel' | 'speakerMatched'>) => {
    if (note.speakerLabel) return note.speakerLabel;
    return uiMessage('desktop-ui.unknown-speaker.6e99efa536', (lang === 'zh') ? 'zh' : 'en');
  }, [lang]);

  const meetingNoteHasSpeakerInfo = useCallback((note: MeetingNote) => (
    note.speakerMatched !== undefined ||
    typeof note.speakerConfidence === 'number' ||
    Boolean(note.speakerLabel)
  ), []);

  const formatMeetingNoteForExport = useCallback((note: MeetingNote) => {
    const speaker = meetingNoteHasSpeakerInfo(note) ? `${meetingSpeakerLabel(note)}: ` : '';
    return `${speaker}${note.text}`;
  }, [meetingNoteHasSpeakerInfo, meetingSpeakerLabel]);

  const appendMeetingTranscript = useCallback((text: string, isFinal: boolean, meta?: VoiceTranscriptMeta) => {
    if (!meetingModeRef.current || meetingPausedRef.current || !isFinal) return;
    const clean = text.trim();
    if (!clean) return;
    const now = Date.now();
    const speakerConfidence = typeof meta?.speakerConfidence === 'number' ? meta.speakerConfidence : undefined;
    const speakerMatched = meta?.speakerMatched === true && Boolean(meta.speakerLabel);
    const speakerLabel = String(meta?.speakerLabel || '').trim() || null;
    const speakerKey = speakerLabel || (speakerMatched ? 'matched' : 'unknown');
    if (
      lastMeetingTranscriptRef.current.text === clean &&
      lastMeetingTranscriptRef.current.speakerKey === speakerKey &&
      now - lastMeetingTranscriptRef.current.at < 4000
    ) return;
    lastMeetingTranscriptRef.current = { text: clean, at: now, speakerKey };
    setMeetingReport('');
    localStorage.removeItem(meetingStorageKeys.report);
    setMeetingStartedAt(prev => {
      if (prev) return prev;
      localStorage.setItem(meetingStorageKeys.startedAt, String(now));
      return now;
    });
    setMeetingNotes(prev => {
      const next = [...prev, {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        text: clean,
        time: now,
        speakerLabel,
        speakerConfidence,
        speakerSource: meta?.speakerSource,
        speakerMatched,
      }];
      persistMeetingNotes(next);
      return next;
    });
  }, [meetingStorageKeys.report, meetingStorageKeys.startedAt, persistMeetingNotes]);

  const socket = useSocket();
  const applyRefinedMeetingTranscript = useCallback((data: { text?: string; provider?: string; model?: string; durationMs?: number; startedAt?: number; segments?: RefinedMeetingSegment[]; speakerCount?: number }) => {
    const clean = String(data.text || '').trim();
    if (!clean) return null;
    const now = Date.now();
    const startedAt = data.startedAt || meetingStartedAt || now;
    const speakerSource = data.provider ? `${data.provider}/${data.model || ''}` : 'dashscope';
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const nextFromSegments = segments
      .map((segment, index): MeetingNote | null => {
        const text = String(segment?.text || '').trim();
        if (!text) return null;
        const numericSpeaker = typeof segment.speakerId === 'number' ? segment.speakerId : null;
        const speakerLabel = String(segment.speakerLabel || (numericSpeaker !== null ? `\u8bf4\u8bdd\u4eba${numericSpeaker + 1}` : '')).trim();
        return {
          id: `refined-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          time: startedAt + Math.max(0, Number(segment.beginMs || 0)),
          speakerLabel: speakerLabel || null,
          speakerSource,
          speakerMatched: false,
        };
      })
      .filter((note): note is MeetingNote => Boolean(note));
    const next: MeetingNote[] = nextFromSegments.length > 0 ? nextFromSegments : [{
      id: `refined-${now}-${Math.random().toString(36).slice(2, 8)}`,
      text: clean,
      time: startedAt,
      speakerSource,
    }];
    setMeetingNotes(next);
    const separatedSpeakerCount = Number(data.speakerCount) || new Set(
      next.map(note => note.speakerLabel).filter(Boolean),
    ).size;
    setMeetingSpeakerCount(separatedSpeakerCount);
    persistMeetingNotes(next);
    setMeetingReport('');
    localStorage.removeItem(meetingStorageKeys.report);
    toast.success(uiMessage('desktop-ui.meeting-transcript-refined-with-the.0e4e859506', (lang === 'zh') ? 'zh' : 'en'));
    return next;
  }, [lang, meetingStartedAt, meetingStorageKeys.report, persistMeetingNotes]);

  const waitForMeetingRefinement = useCallback(() => new Promise<MeetingNote[] | null>((resolve) => {
    if (!socket?.connected) {
      resolve(null);
      return;
    }
    let settled = false;
    const cleanup = () => {
      socket.off('meeting:refined_transcript', onRefined);
      socket.off('meeting:refine_error', onError);
      socket.off('meeting:refine_status', onStatus);
      window.removeEventListener('lumi:domain-changed', onDomainChanged);
      window.clearTimeout(timeout);
    };
    const finish = (value: MeetingNote[] | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onStatus = (data?: { message?: string }) => {
      toast.info(data?.message || (uiMessage('desktop-ui.refining-the-meeting-recording-with.1e8a392145', (lang === 'zh') ? 'zh' : 'en')));
    };
    const onRefined = (data: { text?: string; provider?: string; model?: string; durationMs?: number; startedAt?: number; segments?: RefinedMeetingSegment[]; speakerCount?: number }) => {
      finish(applyRefinedMeetingTranscript(data));
    };
    const onError = (data: { message?: string }) => {
      toast.error(data?.message || (uiMessage('desktop-ui.high-accuracy-meeting-transcription-failed.06ae217f12', (lang === 'zh') ? 'zh' : 'en')));
      finish(null);
    };
    const onDomainChanged = () => finish(null);
    const timeout = window.setTimeout(() => {
      toast.error(uiMessage('desktop-ui.high-accuracy-meeting-transcription-timed.4ade09a115', (lang === 'zh') ? 'zh' : 'en'));
      finish(null);
    }, 60 * 60 * 1000);
    socket.once('meeting:refined_transcript', onRefined);
    socket.once('meeting:refine_error', onError);
    socket.on('meeting:refine_status', onStatus);
    window.addEventListener('lumi:domain-changed', onDomainChanged, { once: true });
  }), [applyRefinedMeetingTranscript, lang, socket]);

  useEffect(() => {
    if (knowledgeOpen) setKnowledgeLoaded(true);
  }, [knowledgeOpen]);

  useEffect(() => {
    if (chatOpen) setChatLoaded(true);
  }, [chatOpen]);

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

  useEffect(() => {
    if (activeVoiceScopeRef.current === meetingPreferenceScopeKey) return;
    activeVoiceScopeRef.current = meetingPreferenceScopeKey;
    meetingVoiceActiveRef.current = false;
    meetingStartAttemptRef.current = Date.now();
    if (callState !== 'idle') endCall();
    if (operationMode === 'meeting') setOperationMode('assistant');
  }, [callState, endCall, meetingPreferenceScopeKey, operationMode, setOperationMode]);

  const startStandardVoiceCall = useCallback(() => {
    void startCall(selectedVoiceId, activePersonality, activePersonality, getVoiceScopeOptions());
  }, [activePersonality, getVoiceScopeOptions, selectedVoiceId, startCall]);

  const stopMeetingAudio = useCallback((options: { refineTranscript?: boolean } = {}) => {
    setMeetingPaused(false);
    meetingVoiceActiveRef.current = false;
    if (operationMode === 'meeting') setOperationMode('assistant');
    if (callState !== 'idle') endCall({ refineTranscript: options.refineTranscript === true });
  }, [callState, endCall, operationMode, setOperationMode]);

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
        endCall();
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
      void startCall(selectedVoiceId, activePersonality, activePersonality, { ...getVoiceScopeOptions(), transcriptionOnly: true });
    }
  }, [activePersonality, callState, endCall, getVoiceScopeOptions, meetingPaused, meetingStorageKeys.startedAt, operationMode, selectedVoiceId, startCall]);
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
  }, [isTauri, sensorPrimerSeen, wakeEnabled]);

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
  }, [isTauri]);

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
  }, [isTauri]);

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
  useEffect(() => {
    if (!socket) return;
    const onIdleReport = (data: { idle_ms: number; idle_seconds: number }) => {
      const idleS = data.idle_seconds ?? (data.idle_ms / 1000);
      const wasAway = lastIdleRef.current > IDLE_AWAY_SECONDS;
      const isBack = idleS < RETURN_IDLE_SECONDS;
      const allowProactiveGreeting = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
      if (wasAway && isBack && !greetedRef.current && allowProactiveGreeting) {
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
  }, [socket]);

  useEffect(() => {
    if (callError) toast.error(callError);
  }, [callError]);

  const formatMeetingTime = useCallback((value: number) => {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, []);

  const buildMeetingMarkdown = useCallback(() => {
    const started = meetingStartedAt ? new Date(meetingStartedAt) : new Date();
    const lines = [
      `# Lumi Meeting Notes`,
      '',
      `Started: ${started.toLocaleString()}`,
      ...(legalMeetingCaseTitle ? [`Case: ${legalMeetingCaseTitle}`] : []),
      '',
      ...(meetingReport ? ['## Lumi Report', '', meetingReport, ''] : []),
      '## Transcript',
      '',
      ...meetingNotes.map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`),
      '',
    ];
    return lines.join('\n');
  }, [formatMeetingNoteForExport, formatMeetingTime, legalMeetingCaseTitle, meetingNotes, meetingReport, meetingStartedAt]);

  const buildFallbackMeetingReport = useCallback((notesOverride?: MeetingNote[]) => {
    const notesForReport = notesOverride || meetingNotes;
    const started = meetingStartedAt ? new Date(meetingStartedAt).toLocaleString() : new Date().toLocaleString();
    const legalCase = getLegalConsultationCase();
    const legalCaseTitle = legalCase ? getLegalCaseLabel(legalCase) : legalMeetingCaseTitle;
    const actionHints = notesForReport
      .filter(note => /(todo|action|next|follow|owner|deadline|需要|安排|确认|推进|负责|下周|明天|今天|完成|决定|风险|问题|证据|材料|开庭|上诉|法院|法官)/i.test(note.text))
      .slice(-8)
      .map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`);
    if (legalCaseTitle) {
      return [
        uiMessage('desktop-ui.lumi-legal-consultation-memo.10af7cc379', (lang === 'zh') ? 'zh' : 'en'),
        '',
        `${uiMessage('desktop-ui.case.8a53cf13fb', (lang === 'zh') ? 'zh' : 'en')}: ${legalCaseTitle}`,
        `${uiMessage('desktop-ui.started.364ae4adf2', (lang === 'zh') ? 'zh' : 'en')}: ${started}`,
        `${uiMessage('desktop-ui.transcript-items.8cb25feb7a', (lang === 'zh') ? 'zh' : 'en')}: ${notesForReport.length}`,
        '',
        `## ${uiMessage('desktop-ui.consultation-summary.5f868bd7fc', (lang === 'zh') ? 'zh' : 'en')}`,
        notesForReport.length > 0
          ? (formatUiMessage('desktop-ui.captured-value0-transcript-items-llm.bcf7f95e8c', { value0: notesForReport.length }, (lang === 'zh') ? 'zh' : 'en'))
          : (uiMessage('desktop-ui.no-transcript-was-captured-for.97f574a507', (lang === 'zh') ? 'zh' : 'en')),
        '',
        `## ${uiMessage('desktop-ui.fact-summary.9a77b99032', (lang === 'zh') ? 'zh' : 'en')}`,
        ...(notesForReport.slice(-6).map(note => `- ${formatMeetingNoteForExport(note)}`)),
        ...(notesForReport.length === 0 ? [`- ${uiMessage('desktop-ui.no-fact-summary-yet.d293f70162', (lang === 'zh') ? 'zh' : 'en')}`] : []),
        '',
        `## ${uiMessage('desktop-ui.issues.f9911a3802', (lang === 'zh') ? 'zh' : 'en')}`,
        `- ${uiMessage('desktop-ui.counsel-should-confirm-issues-against.7df3dafccd', (lang === 'zh') ? 'zh' : 'en')}`,
        '',
        `## ${uiMessage('desktop-ui.missing-materials.ad6cf1dcaa', (lang === 'zh') ? 'zh' : 'en')}`,
        ...(actionHints.length > 0 ? actionHints : [`- ${uiMessage('desktop-ui.no-clear-missing-materials-detected.b86e0b077d', (lang === 'zh') ? 'zh' : 'en')}`]),
        '',
        `## ${uiMessage('desktop-ui.next-steps.cfcab769f5', (lang === 'zh') ? 'zh' : 'en')}`,
        `- ${uiMessage('desktop-ui.review-the-transcript-and-add.1176eea1c1', (lang === 'zh') ? 'zh' : 'en')}`,
        '',
        `## ${uiMessage('desktop-ui.safety-boundary.0f86bb1e83', (lang === 'zh') ? 'zh' : 'en')}`,
        `- ${uiMessage('desktop-ui.this-memo-assists-legal-analysis.678ef98abe', (lang === 'zh') ? 'zh' : 'en')}`,
      ].join('\n');
    }
    return [
      uiMessage('desktop-ui.lumi-meeting-report.8f1af8ddfd', (lang === 'zh') ? 'zh' : 'en'),
      '',
      `${uiMessage('desktop-ui.started.364ae4adf2', (lang === 'zh') ? 'zh' : 'en')}: ${started}`,
      `${uiMessage('desktop-ui.transcript-items.8cb25feb7a', (lang === 'zh') ? 'zh' : 'en')}: ${notesForReport.length}`,
      '',
      `## ${uiMessage('desktop-ui.summary.6a1255c05e', (lang === 'zh') ? 'zh' : 'en')}`,
      notesForReport.length > 0
        ? (formatUiMessage('desktop-ui.captured-value0-transcript-items-llm.2d05f10a79', { value0: notesForReport.length }, (lang === 'zh') ? 'zh' : 'en'))
        : (uiMessage('desktop-ui.no-transcript-was-captured-for.2e5c4be8f2', (lang === 'zh') ? 'zh' : 'en')),
      '',
      `## ${uiMessage('desktop-ui.action-decision-signals.c44c197db8', (lang === 'zh') ? 'zh' : 'en')}`,
      ...(actionHints.length > 0 ? actionHints : [`- ${uiMessage('desktop-ui.no-clear-action-or-decision.0c5b66381b', (lang === 'zh') ? 'zh' : 'en')}`]),
      '',
      `## ${uiMessage('desktop-ui.suggestion.2ed069fe41', (lang === 'zh') ? 'zh' : 'en')}`,
      `- ${uiMessage('desktop-ui.review-the-transcript-manually-and.78769e1374', (lang === 'zh') ? 'zh' : 'en')}`,
    ].join('\n');
  }, [formatMeetingNoteForExport, formatMeetingTime, lang, legalMeetingCaseTitle, meetingNotes, meetingStartedAt]);

  const analyzeMeetingNotes = useCallback(async (endedAt = Date.now(), notesOverride?: MeetingNote[]) => {
    const notesForAnalysis = notesOverride || meetingNotes;
    if (notesForAnalysis.length === 0) {
      const fallback = buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(fallback);
      localStorage.setItem(meetingStorageKeys.report, fallback);
      toast.info(uiMessage('desktop-ui.no-transcript-captured-generated-an.b6e7d4d221', (lang === 'zh') ? 'zh' : 'en'));
      return fallback;
    }

    setMeetingReportGenerating(true);
    try {
      const legalCase = getLegalConsultationCase();
      const legalCaseId = legalCase?.id || getLegalConsultationCaseId();
      const workLegalScope = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
      const legalCaseTitle = legalCase ? getLegalCaseLabel(legalCase) : legalMeetingCaseTitle;
      const legalCaseForAnalysis = legalCaseTitle ? {
        id: legalCaseId,
        title: legalCase?.title || legalCaseTitle,
        caseNumber: legalCase?.caseNumber || '',
        party: legalCase?.party || '',
        cause: legalCase?.cause || '',
        court: legalCase?.court || '',
        judge: legalCase?.judge || '',
        stage: legalCase?.stage || '',
        notes: legalCase?.notes || '',
        domain: workDomain,
        orgId: workLegalScope ? orgConnection?.orgId : '',
      } : null;
      const res = await fetch('/api/meeting/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: aiConfig?.provider || 'gemini',
          model: aiConfig?.model,
          notes: notesForAnalysis,
          startedAt: meetingStartedAt,
          endedAt,
          language: lang,
          purpose: legalCaseForAnalysis ? 'legal_consultation' : 'meeting',
          domain: workLegalScope ? 'work' : 'personal',
          orgId: workLegalScope ? orgConnection?.orgId : undefined,
          legalCase: legalCaseForAnalysis || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to analyze meeting');
      const report = String(data.report || '').trim() || buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(report);
      localStorage.setItem(meetingStorageKeys.report, report);
      if (data.legalCaseArchived && workLegalScope && legalCaseId && notesForAnalysis.length > 0) {
        const lastNote = notesForAnalysis[notesForAnalysis.length - 1];
        const archiveKey = `${legalCaseId}:${meetingStartedAt || ''}:${lastNote?.id || notesForAnalysis.length}`;
        lastLegalMeetingArchiveRef.current = archiveKey;
        clearLegalConsultationCaseId();
        setLegalMeetingCaseTitle('');
        window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed'));
      }
      toast.success(uiMessage('desktop-ui.lumi-generated-the-meeting-report.ebfd03daff', (lang === 'zh') ? 'zh' : 'en'));
      return report;
    } catch (err: any) {
      const fallback = buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(fallback);
      localStorage.setItem(meetingStorageKeys.report, fallback);
      toast.error(err?.message || (uiMessage('desktop-ui.meeting-analysis-failed-generated-a.2106efcb98', (lang === 'zh') ? 'zh' : 'en')));
      return fallback;
    } finally {
      setMeetingReportGenerating(false);
    }
  }, [aiConfig?.model, aiConfig?.provider, buildFallbackMeetingReport, lang, legalMeetingCaseTitle, meetingNotes, meetingStartedAt, meetingStorageKeys.report, orgConnection?.connected, orgConnection?.orgId, workDomain]);

  const archiveLegalMeetingReport = useCallback(async (report: string, endedAt: number, notesOverride?: MeetingNote[]) => {
    const notesForArchive = notesOverride || meetingNotes;
    const consultationCaseId = getLegalConsultationCaseId();
    if (!consultationCaseId || notesForArchive.length === 0) return;
    const lastNote = notesForArchive[notesForArchive.length - 1];
    const archiveKey = `${consultationCaseId}:${meetingStartedAt || ''}:${lastNote?.id || notesForArchive.length}`;
    if (lastLegalMeetingArchiveRef.current === archiveKey) return;

    if (workDomain === 'work' && orgConnection?.connected) {
      const started = meetingStartedAt ? new Date(meetingStartedAt) : new Date(endedAt);
      const meetingCopy = desktopWorkflowCopy(lang).legalMeeting;
      const transcript = notesForArchive
        .map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`)
        .join('\n');
      const content = [
        `# ${meetingCopy.title} ${started.toLocaleString()}`,
        '',
        `## ${meetingCopy.lumiSummary}`,
        '',
        report,
        '',
        `## ${meetingCopy.rawTranscript}`,
        '',
        transcript,
        '',
        `## ${meetingCopy.safetyBoundary}`,
        '',
        meetingCopy.boundaryText,
      ].join('\n');
      try {
        const res = await fetch(`/api/org/legal/cases/${encodeURIComponent(consultationCaseId)}/materials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            type: 'consultation',
            title: `${meetingCopy.title} ${started.toLocaleString()}`,
            content,
            source: 'meeting',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to archive consultation');
        lastLegalMeetingArchiveRef.current = archiveKey;
        clearLegalConsultationCaseId();
        setLegalMeetingCaseTitle('');
        window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed'));
        toast.success(uiMessage('desktop-ui.consultation-archived-to-organization-case.0f5a7a5269', (lang === 'zh') ? 'zh' : 'en'));
        return;
      } catch (err: any) {
        toast.error(err?.message || (uiMessage('desktop-ui.failed-to-archive-consultation-to.7fac8fb2e5', (lang === 'zh') ? 'zh' : 'en')));
        return;
      }
    }

    const archived = archiveLegalMeetingToConsultationCase({
      report,
      notes: notesForArchive,
      startedAt: meetingStartedAt,
      endedAt,
    });
    if (!archived) {
      toast.error(uiMessage('desktop-ui.failed-to-archive-consultation-to.3a4ddc3b05', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    lastLegalMeetingArchiveRef.current = archiveKey;
    setLegalMeetingCaseTitle('');
    toast.success(formatUiMessage('desktop-ui.consultation-archived-to-case-value0.213430958c', { value0: getLegalCaseLabel(archived.caseFile) }, (lang === 'zh') ? 'zh' : 'en'));
  }, [formatMeetingNoteForExport, formatMeetingTime, lang, meetingNotes, meetingStartedAt, orgConnection?.connected, workDomain]);

  const endMeetingAndReport = useCallback(async () => {
    const endingScope = meetingPreferenceScopeKey;
    const endedAt = Date.now();
    setMeetingReportGenerating(true);
    const refinementPromise = callState !== 'idle' ? waitForMeetingRefinement() : Promise.resolve(null);
    stopMeetingAudio({ refineTranscript: true });
    setMeetingNotesOpen(true);
    const refinedNotes = await refinementPromise;
    if (activeVoiceScopeRef.current !== endingScope) {
      setMeetingReportGenerating(false);
      return;
    }
    const report = await analyzeMeetingNotes(endedAt, refinedNotes || undefined);
    if (activeVoiceScopeRef.current !== endingScope) return;
    await archiveLegalMeetingReport(report, endedAt, refinedNotes || undefined);
  }, [analyzeMeetingNotes, archiveLegalMeetingReport, callState, meetingPreferenceScopeKey, stopMeetingAudio, waitForMeetingRefinement]);

  const endVoiceCallFromUI = useCallback(() => {
    if (operationMode === 'meeting') {
      void endMeetingAndReport();
      return;
    }
    endCall();
  }, [endCall, endMeetingAndReport, operationMode]);

  const pauseMeetingCapture = useCallback(() => {
    setMeetingPaused(true);
    meetingVoiceActiveRef.current = false;
    meetingStartAttemptRef.current = 0;
    if (callState !== 'idle') endCall();
    toast.success(uiMessage('desktop-ui.meeting-capture-paused.01ffd43760', (lang === 'zh') ? 'zh' : 'en'));
  }, [callState, endCall, lang]);

  const resumeMeetingCapture = useCallback(() => {
    meetingStartAttemptRef.current = 0;
    setMeetingPaused(false);
    if (operationMode !== 'meeting') setOperationMode('meeting');
    setMeetingNotesOpen(true);
    toast.success(uiMessage('desktop-ui.meeting-capture-resumed.1fe9ed28f8', (lang === 'zh') ? 'zh' : 'en'));
  }, [lang, operationMode, setOperationMode]);

  const toggleMeetingCapturePaused = useCallback(() => {
    if (meetingPaused) {
      resumeMeetingCapture();
      return;
    }
    pauseMeetingCapture();
  }, [meetingPaused, pauseMeetingCapture, resumeMeetingCapture]);

  const copyMeetingNotes = useCallback(async () => {
    if (meetingNotes.length === 0) {
      toast.info(uiMessage('desktop-ui.no-meeting-notes-yet.8b36e2125c', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    try {
      await navigator.clipboard.writeText(buildMeetingMarkdown());
      toast.success(uiMessage('desktop-ui.meeting-notes-copied.57d4f4a1c3', (lang === 'zh') ? 'zh' : 'en'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.failed-to-copy-notes.1c8b4242e3', (lang === 'zh') ? 'zh' : 'en')));
    }
  }, [buildMeetingMarkdown, lang, meetingNotes.length]);

  const downloadMeetingNotes = useCallback(() => {
    if (meetingNotes.length === 0) {
      toast.info(uiMessage('desktop-ui.no-meeting-notes-yet.8b36e2125c', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    const blob = new Blob([buildMeetingMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date(meetingStartedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `lumi-meeting-${stamp}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(uiMessage('desktop-ui.meeting-notes-exported.27f3f8fb53', (lang === 'zh') ? 'zh' : 'en'));
  }, [buildMeetingMarkdown, lang, meetingNotes.length, meetingStartedAt]);

  const clearMeetingNotes = useCallback(() => {
    const now = Date.now();
    setMeetingNotes([]);
    setMeetingSpeakerCount(0);
    setMeetingReport('');
    setMeetingStartedAt(now);
    localStorage.setItem(meetingStorageKeys.notes, '[]');
    localStorage.removeItem(meetingStorageKeys.report);
    localStorage.setItem(meetingStorageKeys.startedAt, String(now));
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
    lastLegalMeetingArchiveRef.current = '';
    toast.success(uiMessage('desktop-ui.meeting-notes-cleared.935a6beea8', (lang === 'zh') ? 'zh' : 'en'));
  }, [lang, meetingStorageKeys]);

  const requestOperationModeChange = useCallback((nextMode: OperationMode) => {
    if (nextMode === operationMode) return;
    if (nextMode === 'meeting') {
      setPendingOperationMode(nextMode);
      return;
    }
    setOperationMode(nextMode);
  }, [operationMode, setOperationMode]);

  const confirmOperationModeChange = useCallback(() => {
    if (!pendingOperationMode) return;
    setOperationMode(pendingOperationMode);
    if (pendingOperationMode === 'meeting') {
      setMeetingPaused(false);
      setMeetingNotesOpen(true);
    }
    setPendingOperationMode(null);
  }, [pendingOperationMode, setOperationMode]);

  type MeetingModeRequestDetail = {
    confirmed?: boolean;
    resetNotes?: boolean;
    legalCaseId?: string;
    legalCaseTitle?: string;
    respond?: (payload?: unknown) => void;
    reject?: (message: string) => void;
  };

  const openMeetingMode = useCallback((detail: MeetingModeRequestDetail = {}) => {
    try {
      if (detail.resetNotes) resetMeetingCapture();
      if (detail.legalCaseId) setLegalConsultationCaseId(String(detail.legalCaseId));
      if (detail.legalCaseTitle) setLegalMeetingCaseTitle(String(detail.legalCaseTitle));
      else if (!getLegalConsultationCaseId()) setLegalMeetingCaseTitle('');

      if (detail.confirmed) {
        setMeetingPaused(false);
        setOperationMode('meeting');
        setMeetingNotesOpen(true);
        detail.respond?.({ ok: true, action: 'start_meeting_mode', mode: 'meeting' });
        return;
      }

      if (operationMode === 'meeting') {
        setMeetingNotesOpen(true);
        detail.respond?.({ ok: true, action: 'open_meeting_notes', mode: 'meeting' });
        return;
      }

      requestOperationModeChange('meeting');
    } catch (err: any) {
      detail.reject?.(err?.message || String(err));
    }
  }, [operationMode, requestOperationModeChange, resetMeetingCapture, setOperationMode]);

  useEffect(() => {
    const handler = (event: Event) => {
      openMeetingMode(((event as CustomEvent).detail || {}) as MeetingModeRequestDetail);
    };
    window.addEventListener('lumi:request-meeting-mode', handler);
    return () => window.removeEventListener('lumi:request-meeting-mode', handler);
  }, [openMeetingMode]);

  const openMeetingModeWithConfirm = useCallback(() => {
    if (operationMode === 'meeting') {
      setMeetingNotesOpen(true);
      return;
    }
    requestOperationModeChange('meeting');
  }, [operationMode, requestOperationModeChange]);

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
  }, [orgConnection?.connected, orgConnection?.orgId, workDomain]);

  useEffect(() => {
    void refreshKnowledgeRuntimeState();
    const interval = window.setInterval(() => void refreshKnowledgeRuntimeState(), 60000);
    return () => {
      knowledgeRefreshSequenceRef.current += 1;
      window.clearInterval(interval);
    };
  }, [refreshKnowledgeRuntimeState]);

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
  }, [orgConnection?.orgId]);

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
  }, [orgConnection?.orgId, orgConnection?.orgRole]);

  // Listen for org navigation events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab === 'home') {
        surfaceReturnTargetRef.current = 'home';
        setOpenWindows([]);
        setFocusedWindow(null);
        setWindowOrder([]);
        setKnowledgeOpen(false);
        setChatOpen(false);
        setMemoryLabOpen(false);
        setSanctuaryOpen(false);
        setSanctuaryAgent(null);
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
  }, [openCommandCenter, setActiveTab]);

  // Restore real system volume/brightness on mount
  useEffect(() => {
    systemService.getVolume().then(v => setVolume(v));
    systemService.getBrightness().then(b => setBrightness(b));
  }, []);

  const applyWallpaperMode = useCallback((enabled: boolean, options: { silent?: boolean; timeoutMs?: number } = {}) => {
    if (wallpaperAutomationTimerRef.current) {
      clearTimeout(wallpaperAutomationTimerRef.current);
      wallpaperAutomationTimerRef.current = null;
    }

    const previous = isWallpaperModeRef.current;
    syncWallpaperModeView(enabled);
    void systemService.setWallpaperMode(enabled).then(actual => {
      syncWallpaperModeView(actual);
    }).catch(error => {
      syncWallpaperModeView(previous);
      console.error('Wallpaper mode transition failed:', error);
      toast.error('Wallpaper mode could not be changed');
    });

    if (enabled && options.timeoutMs) {
      wallpaperAutomationTimerRef.current = setTimeout(() => {
        if (!wallpaperWasEnabledBeforeAutomationRef.current) {
          syncWallpaperModeView(false);
          void systemService.setWallpaperMode(false).then(actual => {
            syncWallpaperModeView(actual);
          }).catch(error => {
            console.error('Wallpaper mode restore failed:', error);
          });
        }
        wallpaperWasEnabledBeforeAutomationRef.current = false;
        wallpaperAutomationTimerRef.current = null;
        addNotification({
          type: 'system',
          title: 'Lumi',
          message: t.wallpaperAutoRestored || 'Wallpaper mode restored after desktop control timeout',
        });
      }, Math.max(15_000, options.timeoutMs));
    }

    if (!options.silent) {
      toast(enabled ? (t.wallpaperFusionActive || 'Wallpaper Fusion Active') : (t.standardFocusMode || 'Standard Desktop'), {
        icon: enabled ? <Sparkles className="text-celestial-saturn" /> : <Box className="text-white/40" />
      });
    }
  }, [t, addNotification, syncWallpaperModeView]);

  useEffect(() => {
    let disposed = false;
    let unlisten: undefined | (() => void);

    void systemService.getWallpaperMode()
      .then(enabled => {
        if (!disposed) syncWallpaperModeView(enabled);
      })
      .catch(error => console.error('Failed to read wallpaper mode:', error));

    const hasTauriRuntime = Boolean(
      (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__ || (window as any).__TAURI__,
    );
    if (hasTauriRuntime) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<{ enabled?: boolean }>('lumi:wallpaper-mode-changed', event => {
          if (!disposed) syncWallpaperModeView(Boolean(event.payload?.enabled));
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
  }, [syncWallpaperModeView]);

  const toggleWallpaperMode = useCallback(() => {
    applyWallpaperMode(!isWallpaperMode);
  }, [applyWallpaperMode, isWallpaperMode]);

  const dismissWallpaperWorkPrompt = useCallback(() => {
    setWallpaperWorkPromptVisible(false);
  }, []);

  const enterWallpaperFromWorkPrompt = useCallback(() => {
    dismissWallpaperWorkPrompt();
    applyWallpaperMode(true);
  }, [applyWallpaperMode, dismissWallpaperWorkPrompt]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean; timeoutMs?: number }>).detail || {};
      const enabled = Boolean(detail.enabled);
      if (enabled) {
        wallpaperWasEnabledBeforeAutomationRef.current = isWallpaperModeRef.current;
      } else if (wallpaperWasEnabledBeforeAutomationRef.current) {
        if (wallpaperAutomationTimerRef.current) {
          clearTimeout(wallpaperAutomationTimerRef.current);
          wallpaperAutomationTimerRef.current = null;
        }
        wallpaperWasEnabledBeforeAutomationRef.current = false;
        return;
      }

      applyWallpaperMode(enabled, {
        silent: true,
        timeoutMs: enabled ? detail.timeoutMs : undefined,
      });
      if (!enabled) wallpaperWasEnabledBeforeAutomationRef.current = false;
    };
    window.addEventListener('lumi:set-wallpaper-mode', handler);
    return () => {
      window.removeEventListener('lumi:set-wallpaper-mode', handler);
      if (wallpaperAutomationTimerRef.current) {
        clearTimeout(wallpaperAutomationTimerRef.current);
        wallpaperAutomationTimerRef.current = null;
      }
    };
  }, [applyWallpaperMode]);


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
  }, [socket, addNotification]);

  // Workflow status listener — agent:status, agent:tool_call, agent:response, agent:error
  useEffect(() => {
    if (!socket) return;

    let terminalResponseSeen = false;
    let activeForegroundRequestId: string | null = null;
    let activeForegroundSource: string | null = null;
    let terminalResetTimer: ReturnType<typeof setTimeout> | null = null;
    const workflowStepId = (prefix: string, seed?: string) =>
      `${prefix}-${seed || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    const onStatus = (data: { status: string; agentName?: string; phase?: string; detail?: string; source?: string; requestId?: string }) => {
      if (data.status === 'thinking') {
        if (isDetachedBackgroundEvent(data)) return;
        if (data.requestId && activeForegroundRequestId !== data.requestId) {
          activeForegroundRequestId = data.requestId;
          activeForegroundSource = data.source || null;
          setWorkflowSteps([]);
          seenWorkflowToolEvents.current.clear();
        } else if (!acceptsForegroundEvent(data, true)) return;
        terminalResponseSeen = false;
        if (terminalResetTimer) {
          clearTimeout(terminalResetTimer);
          terminalResetTimer = null;
        }
        const isBackground = data.phase === 'background';
        setAgentStatus(isBackground ? 'background' : 'thinking');
        setWorkflowSteps(prev => [...prev, {
          id: workflowStepId('thinking'),
          type: isBackground ? 'background' : 'thinking',
          text: isBackground
            ? (t.workflowBackgroundStep || 'Lumi is handling this in the background')
            : (t.workflowAnalyzing || 'Analyzing your request...'),
          detail: data.detail || (data.agentName && data.agentName !== 'Lumi' ? data.agentName : undefined),
          time: Date.now(),
        }]);
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
        if (terminalResetTimer) clearTimeout(terminalResetTimer);
        terminalResetTimer = setTimeout(() => {
          if (terminalRequestId && activeForegroundRequestId !== terminalRequestId) return;
          setAgentStatus('idle');
          setWorkflowSteps([]);
          activeForegroundRequestId = null;
          activeForegroundSource = null;
          terminalResetTimer = null;
        }, 5000);
      }
    };

    const onToolCall = (data: { correlationId?: string; name: string; arguments?: any; args?: any; result?: string; error?: string; source?: string; requestId?: string }) => {
      if (!acceptsForegroundEvent(data, true)) return;
      const toolArgs = data.arguments ?? data.args;
      const phase = data.error !== undefined ? 'error' : data.result !== undefined ? 'result' : 'start';
      if (data.correlationId) {
        const eventKey = `${data.correlationId}:${phase}`;
        if (seenWorkflowToolEvents.current.has(eventKey)) return;
        seenWorkflowToolEvents.current.add(eventKey);
      }
      if (data.error !== undefined) {
        setAgentStatus('executing');
        triggerPetReaction('failed', 2000);
        setWorkflowSteps(prev => [...prev, {
          id: `tool-err-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'error',
          text: `${data.name} ${t.workflowToolFailed || 'failed'}`,
          detail: data.error?.slice(0, 100),
          time: Date.now(),
        }]);
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
        setAgentStatus('executing');
        triggerPetReaction(resultFailed ? 'failed' : 'jump', resultFailed ? 2000 : 1200);
        setWorkflowSteps(prev => [...prev, {
          id: `tool-result-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: resultFailed ? 'error' : 'tool_result',
          text: resultFailed
            ? `${data.name} returned a blocked or failed result`
            : `${data.name} returned a result`,
          detail: data.result?.slice(0, 100),
          time: Date.now(),
        }]);
      } else {
        setAgentStatus('executing');
        const argsSummary = toolArgs
          ? Object.entries(toolArgs).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : String(v).slice(0, 30)}`).join(', ')
          : '';
        setWorkflowSteps(prev => [...prev, {
          id: `tool-start-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'tool_start',
          text: `${t.workflowCalling || 'Calling'} ${data.name}`,
          detail: argsSummary || undefined,
          time: Date.now(),
        }]);
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
      setWorkflowSteps(prev => [...prev, {
        id: workflowStepId('resp', data.requestId),
        type: responseBlocked ? 'error' : 'response',
        text: responseBlocked ? (t.workflowError || 'Processing blocked') : (t.workflowResponseReady || 'Response ready'),
        detail: describeAgentResponseDelivery(data, lang === 'zh'),
        time: Date.now(),
      }]);
      if (terminalResetTimer) clearTimeout(terminalResetTimer);
      terminalResetTimer = setTimeout(() => {
        if (terminalRequestId && activeForegroundRequestId !== terminalRequestId) return;
        setAgentStatus('idle');
        setWorkflowSteps([]);
        activeForegroundRequestId = null;
        activeForegroundSource = null;
        terminalResetTimer = null;
      }, 5000);
    };

    const onError = (data: { message: string; source?: string; requestId?: string }) => {
      if (!acceptsForegroundEvent(data, true)) return;
      const terminalRequestId = data.requestId || activeForegroundRequestId;
      setAgentStatus('error');
      setWorkflowSteps(prev => [...prev, {
        id: workflowStepId('err', data.requestId),
        type: 'error',
        text: t.workflowError || 'Processing failed',
        detail: data.message,
        time: Date.now(),
      }]);
      if (terminalResetTimer) clearTimeout(terminalResetTimer);
      terminalResetTimer = setTimeout(() => {
        if (terminalRequestId && activeForegroundRequestId !== terminalRequestId) return;
        setAgentStatus('idle');
        setWorkflowSteps([]);
        activeForegroundRequestId = null;
        activeForegroundSource = null;
        terminalResetTimer = null;
      }, 5000);
    };

    const onProactive = (data: { type?: string; taskId: string; message: string; timestamp: string }) => {
      const taskId = data.type || data.taskId || data.taskId;
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

    const normalizeAutonomousTask = (data: any, status: WorkflowTask['status']): WorkflowTask | null => {
      const raw = data?.task || data;
      const id = String(raw?.id || data?.taskId || '');
      if (!id) return null;
      return {
        id,
        title: raw?.title || data?.title || id,
        status: (raw?.status || status) as WorkflowTask['status'],
        toolCallsCount: Number(raw?.toolCallsCount || 0),
        error: raw?.error,
        resultPreview: raw?.resultPreview || raw?.result,
        updatedAt: raw?.updatedAt || raw?.timestamp,
        completionFeedback: normalizeTaskCompletionFeedback(raw?.completionFeedback || data?.completionFeedback),
      };
    };

    const recordAutonomousTaskStep = (task: WorkflowTask) => {
      const previousStatus = autonomousTaskStatusRef.current.get(task.id);
      if (previousStatus === task.status) return;
      autonomousTaskStatusRef.current.set(task.id, task.status);
      const isActive = task.status === 'queued' || task.status === 'running' || task.status === 'cancelling';
      const isFailed = task.status === 'failed';
      setAgentStatus(isActive ? 'background' : isFailed ? 'error' : 'done');
      setWorkflowSteps(prev => [...prev, {
        id: `autonomous-task-${task.id}-${task.status}-${Date.now()}`,
        type: isFailed ? 'error' : task.status === 'completed' ? 'response' : 'background',
        text: `${t.workflowAutonomousTask || 'Autonomous task'}: ${task.status}`,
        detail: task.title || task.id,
        time: Date.now(),
      }]);
    };

    const autonomousTaskListener = (status: WorkflowTask['status']) => (data: any) => {
      const task = normalizeAutonomousTask(data, status);
      if (task) recordAutonomousTaskStep(task);
    };
    const onAutonomousStarted = autonomousTaskListener('running');
    const onAutonomousPaused = autonomousTaskListener('paused');
    const onAutonomousRetry = autonomousTaskListener('queued');
    const onAutonomousCompleted = autonomousTaskListener('completed');
    const onAutonomousFailed = autonomousTaskListener('failed');
    const onAutonomousCancelled = autonomousTaskListener('cancelled');

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
    socket.on('autonomous:task_started', onAutonomousStarted);
    socket.on('autonomous:task_paused', onAutonomousPaused);
    socket.on('autonomous:task_retry_scheduled', onAutonomousRetry);
    socket.on('autonomous:task_completed', onAutonomousCompleted);
    socket.on('autonomous:task_failed', onAutonomousFailed);
    socket.on('autonomous:task_cancelled', onAutonomousCancelled);
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

    const onTokenUsageUpdate = (_data: { totalTokens: number; provider: string }) => {
      // Token usage updated — TokenDashboard handles REST polling, this is real-time supplement
    };
    socket.on('preferences:changed', onPreferencesChanged);
    socket.on('agent:notification', onAgentNotification);
    socket.on('wake:detected', onWakeDetected);
    socket.on('wake:error', onWakeError);
    socket.on('wake:started', onWakeStarted);
    socket.on('token:usage_update', onTokenUsageUpdate);

    return () => {
      socket.off('agent:status', onStatus);
      socket.off('autonomous:task_started', onAutonomousStarted);
      socket.off('autonomous:task_paused', onAutonomousPaused);
      socket.off('autonomous:task_retry_scheduled', onAutonomousRetry);
      socket.off('autonomous:task_completed', onAutonomousCompleted);
      socket.off('autonomous:task_failed', onAutonomousFailed);
      socket.off('autonomous:task_cancelled', onAutonomousCancelled);
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
      socket.off('token:usage_update', onTokenUsageUpdate);
      if (terminalResetTimer) clearTimeout(terminalResetTimer);
    };
  }, [
    addNotification,
    lang,
    orgConnection?.orgId,
    petStorageKeys,
    socket,
    t.workflowAnalyzing,
    t.workflowBackgroundStep,
    t.workflowAutonomousTask,
    t.workflowCalling,
    t.workflowError,
    t.workflowResponseReady,
    t.workflowToolFailed,
    workDomain,
  ]);

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
  }, [petStorageKeys]);

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
        setIsControlCenterOpen(false);
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
        setIsControlCenterOpen(false);
        if (isWallpaperMode) toggleWallpaperMode();
        return;
      }
      if (e.key === ' ' && !e.repeat) {
        if (isInputFocused()) return;
        if (isSearchOpen || isControlCenterOpen) return;
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
  }, [chatOpen, closeKnowledgeBase, closeMemoryAvatar, endCall, getVoiceScopeOptions, interrupt, isControlCenterOpen, isSearchOpen, isWallpaperMode, knowledgeOpen, memoryLabOpen, openCommandCenter, sanctuaryOpen, selectedVoiceId, startCall, startStandardVoiceCall, toggleWallpaperMode]);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSelectPet = (pet: PetConfig) => {
    if (!canCustomizeLumiAppearance) {
      toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    setSelectedPet(pet);
    savePetPrefsToServer(pet, equippedAccessories);
    toast.info(`${pet.name} ${t.avatarSetAsDesktop || 'set as desktop avatar'}`);
  };

  const toggleWindow = useCallback((tab: string) => {
    try { sounds.playClick(); } catch {}
    if (tab === 'avatar-studio') {
      setPersonalizationSection('appearance');
      tab = 'personalization';
    } else if (tab === 'sound') {
      setPersonalizationSection('voice');
      tab = 'personalization';
    }
    if (tab === 'home') {
      surfaceReturnTargetRef.current = 'home';
      setKnowledgeOpen(false);
      setMemoryLabOpen(false);
      setSanctuaryOpen(false);
      setSanctuaryAgent(null);
      setOpenWindows([]);
      setFocusedWindow(null);
      setActiveTab('home');
      return;
    }
    if (tab === 'org') {
      surfaceReturnTargetRef.current = 'home';
      setActiveTab('org');
      return;
    }
    if (tab === 'memory') {
      openKnowledgeBase();
      return;
    }
    if (tab === 'sync') {
      tab = 'devices';
    }
    if (tab === 'notifications') {
      surfaceReturnTargetRef.current = 'home';
      setIsNotificationPanelOpen(prev => !prev);
      setOpenWindows(prev => prev.filter(w => w !== 'notifications'));
      setMinimizedWindows(prev => prev.filter(w => w !== 'notifications'));
      setWindowOrder(prev => prev.filter(w => w !== 'notifications'));
      if (focusedWindow === 'notifications') setFocusedWindow(null);
      return;
    }

    // Knowledge base and Chat open fullscreen, not as windows
    if (tab === 'knowledge') {
      if (knowledgeOpen) closeKnowledgeBase();
      else openKnowledgeBase();
      return;
    }
    if (tab === 'chat' || tab === 'command-center') {
      openCommandCenter('office');
      return;
    }
    if (tab === 'memory-avatar') {
      void openMemoryAvatar();
      return;
    }
    if (openWindows.includes(tab)) {
      if (minimizedWindows.includes(tab)) {
        setMinimizedWindows(prev => prev.filter(w => w !== tab));
      }
      setFocusedWindow(tab);
      setWindowOrder(prev => [...prev.filter(w => w !== tab), tab]);
    } else {
      setOpenWindows(prev => prev.includes(tab) ? prev : [...prev, tab]);
      setFocusedWindow(tab);
      setWindowOrder(prev => [...prev, tab]);
    }
    setActiveTab(tab);
  }, [closeKnowledgeBase, focusedWindow, knowledgeOpen, minimizedWindows, openCommandCenter, openKnowledgeBase, openMemoryAvatar, openWindows, setActiveTab]);

  const closeWindow = useCallback((tab: string) => {
    try { sounds.playClick(); } catch {}
    const remainingOrder = windowOrder.filter(w => w !== tab);
    const nextFocusedWindow = remainingOrder.length > 0 ? remainingOrder[remainingOrder.length - 1] : null;
    setOpenWindows(prev => prev.filter(w => w !== tab));
    setMinimizedWindows(prev => prev.filter(w => w !== tab));
    setWindowOrder(remainingOrder);
    if (focusedWindow === tab) {
      setFocusedWindow(nextFocusedWindow);
      if (!nextFocusedWindow) setActiveTab('home');
    }
  }, [focusedWindow, setActiveTab, windowOrder]);

  const minimizeOsWindow = (tab: string) => {
    const remainingOrder = windowOrder.filter(w => w !== tab && !minimizedWindows.includes(w));
    setMinimizedWindows(prev => prev.includes(tab) ? prev : [...prev, tab]);
    if (focusedWindow === tab) {
      setFocusedWindow(remainingOrder.length > 0 ? remainingOrder[remainingOrder.length - 1] : null);
    }
  };

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
  }, []);

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
  }, []);

  const enterDesktopWidgetMode = useCallback(async () => {
    try { sounds.playClick(); } catch {}
    surfaceReturnTargetRef.current = 'home';
    setIsControlCenterOpen(false);
    setIsNotificationPanelOpen(false);
    setIsSearchOpen(false);
    setChatOpen(false);
    setKnowledgeOpen(false);
    setMemoryLabOpen(false);
    setSanctuaryOpen(false);
    setSanctuaryAgent(null);
    setOpenWindows([]);
    setMinimizedWindows([]);
    setFocusedWindow(null);
    setWindowOrder([]);
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
  }, [applyDesktopWidgetFallback, isTauri, lang, setActiveTab]);

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
      // Re-apply Lumi's independent Command Center / Wallpaper contract.
      await systemService.setAlwaysOnTop(chatOpen || isWallpaperModeRef.current).catch(() => {});
    }
    if (nextSurface) {
      window.setTimeout(() => toggleWindow(nextSurface), 120);
    }
  }, [chatOpen, isTauri, lang, restoreDesktopWidgetFallback, toggleWindow]);

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

  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<any>).detail || {};
      const action = String(detail.action || '');
      const target = String(detail.target || '');
      const mode = String(detail.mode || '');
      const task = String(detail.task || '');
      const section = String(detail.section || '');
      const confirmed = Boolean(detail.confirmed);
      const respond = typeof detail.respond === 'function' ? detail.respond : () => {};
      const reject = typeof detail.reject === 'function' ? detail.reject : () => {};

      const normalizeTarget = (value: string) => {
        if (value === 'memory') return 'knowledge';
        if (value === 'files') return 'knowledge';
        if (value === 'sync') return 'devices';
        if (value === 'avatar-studio' || value === 'sound') return 'personalization';
        if (value === 'world' || value === 'nexus' || value === 'nexus-view' || value === 'cloud-canvas') return 'nexus';
        if (value === 'chat' || value === 'command-center') return 'command-center';
        if (value === 'memory-avatar' || value === 'memory-avatars' || value === 'sanctuary') return 'memory-avatar';
        return value;
      };

      const openSurface = (value: string) => {
        if (value === 'avatar-studio') setPersonalizationSection('appearance');
        if (value === 'sound') setPersonalizationSection('voice');
        const windowId = normalizeTarget(value);
        if (!windowId) throw new Error('Client action requires a target surface');
        // Capture the origin before dismissing the current surface.  This is
        // what lets utility overlays opened by a Command Center action return
        // to that same office instead of the personal desktop.
        const returnTarget = inferSurfaceReturnTarget();
        if (isDesktopWidgetMode) {
          void exitDesktopWidgetMode(windowId);
          return;
        }

        if (windowId !== 'command-center') {
          setChatOpen(false);
          if (windowId !== 'knowledge') setKnowledgeOpen(false);
          if (windowId !== 'app-launcher') setIsSearchOpen(false);
          if (windowId !== 'nexus') setViewMode('personal');
        }

        if (windowId === 'home') {
          surfaceReturnTargetRef.current = 'home';
          setOpenWindows([]);
          setMinimizedWindows([]);
          setFocusedWindow(null);
          setWindowOrder([]);
          setKnowledgeOpen(false);
          setChatOpen(false);
          setMemoryLabOpen(false);
          setSanctuaryOpen(false);
          setSanctuaryAgent(null);
          setIsNotificationPanelOpen(false);
          setIsSearchOpen(false);
          setViewMode('personal');
          setActiveTab('home');
          return;
        }
        if (windowId === 'nexus') {
          surfaceReturnTargetRef.current = 'home';
          setNexusReturnTarget('home');
          setViewMode('world');
          setActiveTab('home');
          return;
        }
        if (windowId === 'app-launcher') {
          surfaceReturnTargetRef.current = 'home';
          setIsSearchOpen(true);
          return;
        }
        if (windowId === 'org') {
          surfaceReturnTargetRef.current = 'home';
          setActiveTab('org');
          return;
        }
        if (windowId === 'knowledge') {
          openKnowledgeBase(returnTarget);
          return;
        }
        if (windowId === 'command-center') {
          openCommandCenter('office');
          return;
        }
        if (windowId === 'memory-avatar') {
          void openMemoryAvatar(undefined, returnTarget);
          return;
        }
        if (windowId === 'notifications') {
          surfaceReturnTargetRef.current = 'home';
          setIsNotificationPanelOpen(true);
          setOpenWindows(prev => prev.filter(w => w !== 'notifications'));
          setMinimizedWindows(prev => prev.filter(w => w !== 'notifications'));
          setWindowOrder(prev => prev.filter(w => w !== 'notifications'));
          if (focusedWindow === 'notifications') setFocusedWindow(null);
          return;
        }
        surfaceReturnTargetRef.current = 'home';
        setOpenWindows(prev => prev.includes(windowId) ? prev : [...prev, windowId]);
        setMinimizedWindows(prev => prev.filter(w => w !== windowId));
        setFocusedWindow(windowId);
        setWindowOrder(prev => [...prev.filter(w => w !== windowId), windowId]);
        setActiveTab(windowId);
      };

        const getDemoTargetPoint = (value: string): { x: number; y: number } => {
          const windowId = normalizeTarget(value);
          const targetEl = Array.from(document.querySelectorAll<HTMLElement>('[data-lumi-target]'))
            .find(el => el.dataset.lumiTarget === windowId);
          if (targetEl) {
            const rect = targetEl.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
          const fallback: Record<string, { x: number; y: number }> = {
            home: { x: 82, y: 24 },
            org: { x: window.innerWidth / 2, y: 24 },
            plans: { x: window.innerWidth * 0.72, y: window.innerHeight * 0.42 },
          };
          return fallback[windowId] || { x: window.innerWidth / 2, y: window.innerHeight * 0.82 };
        };

        const animateDemoCursor = async (value: string) => {
          const point = getDemoTargetPoint(value);
          window.dispatchEvent(new CustomEvent('cursor-glow:show'));
          window.dispatchEvent(new CustomEvent('cursor-glow:update', { detail: point }));
          await new Promise(resolve => window.setTimeout(resolve, 540));
          window.dispatchEvent(new CustomEvent('cursor-glow:click', { detail: point }));
          await new Promise(resolve => window.setTimeout(resolve, 220));
        };

      const closeSurface = (value: string) => {
        const windowId = normalizeTarget(value);
        if (!windowId) throw new Error('close_client_surface requires target');
        if (windowId === 'knowledge') {
          closeKnowledgeBase();
          return;
        }
        if (windowId === 'command-center') {
          surfaceReturnTargetRef.current = 'home';
          setChatOpen(false);
          setKnowledgeOpen(false);
          setMemoryLabOpen(false);
          setSanctuaryOpen(false);
          setSanctuaryAgent(null);
          setChatPrefill('');
          setChatPrefillSource('proactive');
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
      };

      const setClientMode = (value: string) => {
        const allowed = ['chat', 'meeting', 'assistant', 'autonomous'];
        if (!allowed.includes(value)) throw new Error(`Unsupported mode: ${value}`);
        if (value === 'meeting' && !confirmed) {
          throw new Error(`${value} mode requires explicit user confirmation`);
        }
        setOperationMode(value as OperationMode);
        if (value === 'meeting') {
          setMeetingPaused(false);
          setMeetingNotesOpen(true);
        }
      };

      const openOrganizationSurface = async (
        requestedView: OrganizationWorkspaceView,
        requestedAction: string,
      ) => {
        if (orgConnection?.connected && !canAccessOrganizationWorkspaceView(orgConnection?.orgRole, requestedView)) {
          respond({
            ok: false,
            action: requestedAction,
            target: 'org',
            section: requestedView,
            reason: 'organization_role_not_allowed',
          });
          return;
        }
        queueOrganizationWorkspaceRoute(requestedView);
        if (orgConnection?.connected && workDomain !== 'work') {
          const switched = await switchDomain('work');
          if (!switched.success) {
            openSurface('org');
            respond({
              ok: false,
              action: requestedAction,
              target: 'org',
              section: requestedView,
              reason: switched.message || 'organization_domain_switch_failed',
            });
            return;
          }
        }
        openSurface('org');
        window.dispatchEvent(new CustomEvent('lumi:navigate', {
          detail: { tab: 'org', sub: requestedView },
        }));
        respond({
          ok: true,
          action: requestedAction,
          target: 'org',
          section: requestedView,
          domain: orgConnection?.connected ? 'work' : workDomain,
        });
      };

      try {
        if (action === 'refresh_model_configuration') {
          const roles = Array.isArray(detail.payload?.roles) ? detail.payload.roles : [];
          window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed', {
            detail: { roles },
          }));
          respond({ ok: true, action, roles });
          return;
        }
        if (action === 'refresh_client_state') {
          window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
          respond({
            ok: true,
            action,
            mode: operationMode,
            activeTab,
            openWindows,
            widgetMode: isDesktopWidgetMode,
            renderedSurfaces: [
              isClientSurfaceRendered('command-center') ? 'command-center' : null,
              isClientSurfaceRendered('chat') ? 'chat' : null,
            ].filter(Boolean),
          });
          return;
        }
        if (action === 'enter_widget_mode' || action === 'show_desktop_widget') {
          void enterDesktopWidgetMode();
          respond({ ok: true, action, widgetMode: true });
          return;
        }
        if (action === 'exit_widget_mode' || action === 'expand_from_widget') {
          void exitDesktopWidgetMode(target || undefined);
          respond({ ok: true, action, widgetMode: false, target: target || undefined });
          return;
        }
        if (action === 'demo_open_surface') {
          const surface = normalizeTarget(target || detail.surface || '');
          if (!surface) throw new Error('demo_open_surface requires target');
          void (async () => {
            try {
              await animateDemoCursor(surface);
              openSurface(surface);
              respond({ ok: true, action, target: surface });
            } catch (err: any) {
              reject(err?.message || String(err));
            }
          })();
          return;
        }
        if (action === 'close_client_surface') {
          closeSurface(target);
          respond({ ok: true, action, target });
          return;
        }
        if (action === 'set_client_mode') {
          setClientMode(mode);
          respond({ ok: true, action, mode });
          return;
        }
        if (action === 'open_personal_workspace') {
          if (workDomain !== 'personal') {
            const switched = await switchDomain('personal');
            if (!switched.success) {
              respond({
                ok: false,
                action,
                target: 'home',
                domain: workDomain,
                reason: switched.message || 'personal_domain_switch_failed',
              });
              return;
            }
          }
          openSurface('home');
          respond({ ok: true, action, target: 'home', domain: 'personal' });
          return;
        }
        if (action === 'open_settings') {
          if (isComputerAdaptationSettingsTarget(section)) {
            openSurface('kernel');
            respond({ ok: true, action, target: 'kernel', section: 'computer' });
            return;
          }
          const requestedSection = normalizeClientSettingsSection(section);
          if (!requestedSection) throw new Error(`Unknown settings section: ${section}`);
          setSettingsSection(requestedSection);
          openSurface('settings');
          respond({ ok: true, action, target: 'settings', section: requestedSection });
          return;
        }
        if (action === 'close_nexus') {
          setViewMode('personal');
          respond({ ok: true, action, target: 'nexus', viewMode: 'personal' });
          return;
        }
        if (action === 'start_meeting_mode') {
          if (!confirmed) throw new Error('start_meeting_mode requires explicit user confirmation');
          if (detail.resetNotes) resetMeetingCapture();
          if (detail.legalCaseId) setLegalConsultationCaseId(String(detail.legalCaseId));
          if (detail.legalCaseTitle) setLegalMeetingCaseTitle(String(detail.legalCaseTitle));
          else if (!getLegalConsultationCaseId()) setLegalMeetingCaseTitle('');
          setClientMode('meeting');
          respond({ ok: true, action, mode: 'meeting' });
          return;
        }
        if (action === 'end_meeting_mode') {
          if (!confirmed) throw new Error('end_meeting_mode requires explicit user confirmation');
          void endMeetingAndReport();
          respond({ ok: true, action, status: 'ending_and_generating_report' });
          return;
        }
        if (action === 'open_meeting_notes') {
          setMeetingNotesOpen(true);
          respond({ ok: true, action });
          return;
        }
        if (action === 'open_organization_workspace') {
          const requestedView = normalizeOrganizationWorkspaceView(section || (target !== 'org' ? target : '') || 'dashboard');
          if (!requestedView) throw new Error(`Unknown organization workspace section: ${section || target}`);
          await openOrganizationSurface(requestedView, action);
          return;
        }
        if (action === 'set_wallpaper_mode') {
          const enabled = Boolean(detail.enabled);
          if (enabled && !confirmed) throw new Error('set_wallpaper_mode requires explicit user confirmation');
          applyWallpaperMode(enabled);
          respond({ ok: true, action, enabled });
          return;
        }
        const registeredSurface = getPersonalClientSurfaceByAction(action);
        if (registeredSurface?.organizationView) {
          const requestedView = normalizeOrganizationWorkspaceView(
            registeredSurface.organizationViewByAction?.[action]
            || registeredSurface.organizationView,
          );
          if (!requestedView) throw new Error(`Unknown organization workspace section for action: ${action}`);
          await openOrganizationSurface(requestedView, action);
          return;
        }
        if (registeredSurface) {
          if (registeredSurface.settingsSection) setSettingsSection(registeredSurface.settingsSection);
          const requestedCommandView = registeredSurface.commandCenterViewByAction?.[action];
          if (requestedCommandView) {
            openCommandCenter(requestedCommandView);
            const rendered = await waitForClientSurfaceRendered('command-center');
            if (!rendered) {
              reject('Lumi command center state changed, but the visible surface did not render.');
              return;
            }
            window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
            respond({
              ok: true,
              action,
              target: registeredSurface.target,
              surface: registeredSurface.id,
              view: requestedCommandView,
              rendered: true,
            });
            return;
          }
          if (action === 'open_avatar_studio') setPersonalizationSection('appearance');
          if (action === 'open_sound_studio') setPersonalizationSection('voice');
          openSurface(registeredSurface.target);
          const requiresWindowCommit = ![
            'home',
            'nexus',
            'app-launcher',
            'org',
            'knowledge',
            'command-center',
            'notifications',
            'memory-avatar',
          ].includes(registeredSurface.target);
          if (requiresWindowCommit) {
            const rendered = await waitForClientSurfaceRendered(registeredSurface.target);
            if (!rendered) {
              reject(`Lumi client state changed, but ${registeredSurface.target} did not render visibly.`);
              return;
            }
            window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
          }
          respond({
            ok: true,
            action,
            target: registeredSurface.target,
            surface: registeredSurface.id,
            section: registeredSurface.settingsSection || '',
            rendered: requiresWindowCommit ? true : undefined,
          });
          return;
        }
        throw new Error(`Unsupported client action: ${action}`);
      } catch (err: any) {
        reject(err?.message || String(err));
      }
    };

    window.addEventListener('lumi:client-action', handler);
    return () => window.removeEventListener('lumi:client-action', handler);
  }, [
    activeTab,
    applyWallpaperMode,
    closeKnowledgeBase,
    closeMemoryAvatar,
    closeWindow,
    endMeetingAndReport,
    enterDesktopWidgetMode,
    exitDesktopWidgetMode,
    focusedWindow,
    isDesktopWidgetMode,
    inferSurfaceReturnTarget,
    openKnowledgeBase,
    openMemoryAvatar,
    openCommandCenter,
    openWindows,
    operationMode,
    orgConnection?.connected,
    orgConnection?.orgRole,
    resetMeetingCapture,
    setActiveTab,
    setOperationMode,
    setViewMode,
    switchDomain,
    workDomain,
  ]);

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
          workflowStepCount: workflowSteps.length,
          runningWorkflowSteps: workflowSteps.filter(step =>
            step.type === 'thinking' ||
            step.type === 'background' ||
            step.type === 'confirmation' ||
            step.type === 'tool_start'
          ).length,
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
    workflowSteps,
  ]);

  const appIcons = [
    { id: 'personality', label: t.personality || 'Personality Lab', icon: <UserIcon size={24} />, color: 'from-violet-500 to-fuchsia-600' },
    { id: 'kernel', label: t.kernelMonitor || 'Kernel Monitor', icon: <Activity size={24} />, color: 'from-orange-500 to-red-600' },
    { id: 'devices', label: t.devices || 'Devices', icon: <Cpu size={24} />, color: 'from-blue-600 to-cyan-400' },
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
    { id: 'personalization', label: t.personalization || 'Personalization', icon: <Brush size={24} />, color: 'from-cyan-400 to-indigo-600' },
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
      .filter(windowId => windowId !== 'chat' && windowId !== 'personalization' && !appIcons.some(app => app.id === windowId))
      .map(getWindowMeta),
  ];
  const operationModeOptions = [
    {
      id: 'meeting' as const,
      label: t.modeMeeting || (uiMessage('desktop-ui.meeting.e16a90b510', (lang === 'zh') ? 'zh' : 'en')),
      title: t.modeMeetingTitle || (uiMessage('desktop-ui.meeting-mode.958510fb80', (lang === 'zh') ? 'zh' : 'en')),
      description: t.modeMeetingDesc || (uiMessage('desktop-ui.starts-speech-to-text-records.eae4abc712', (lang === 'zh') ? 'zh' : 'en')),
      hint: t.modeMeetingHint || (uiMessage('desktop-ui.live-notes.578276ba0a', (lang === 'zh') ? 'zh' : 'en')),
      icon: <FileText size={16} />,
    },
    {
      id: 'chat' as const,
      label: t.modeChat || (uiMessage('desktop-ui.chat.1594b2f45c', (lang === 'zh') ? 'zh' : 'en')),
      title: t.modeChatTitle || (uiMessage('desktop-ui.chat-mode.fc9f4d73b6', (lang === 'zh') ? 'zh' : 'en')),
      description: t.modeChatDesc || (uiMessage('desktop-ui.pure-conversation-answers-and-discussion.10bb20f365', (lang === 'zh') ? 'zh' : 'en')),
      hint: t.modeChatHint || (uiMessage('desktop-ui.conversation-only.33f7067683', (lang === 'zh') ? 'zh' : 'en')),
      icon: <MessageSquare size={16} />,
    },
    {
      id: 'assistant' as const,
      label: t.modeAssistant || (uiMessage('desktop-ui.assistant.90c4ae600c', (lang === 'zh') ? 'zh' : 'en')),
      title: t.modeAssistantTitle || (uiMessage('desktop-ui.assistant-mode.cc5acf7cf6', (lang === 'zh') ? 'zh' : 'en')),
      description: t.modeAssistantDesc || (uiMessage('desktop-ui.user-present-full-permission-helper.fac834ab73', (lang === 'zh') ? 'zh' : 'en')),
      hint: t.modeAssistantHint || (uiMessage('desktop-ui.foreground-full-access.a5a81a90e7', (lang === 'zh') ? 'zh' : 'en')),
      icon: <Sparkles size={16} />,
    },
    {
      id: 'autonomous' as const,
      label: t.modeAutonomy || t.modeAutoExecute || (uiMessage('desktop-ui.autonomy.6aea974e38', (lang === 'zh') ? 'zh' : 'en')),
      title: t.modeAutonomyTitle || t.modeAutoExecuteTitle || (uiMessage('desktop-ui.autonomy-mode.f6d90bbb04', (lang === 'zh') ? 'zh' : 'en')),
      description: t.modeAutonomyDesc || t.modeAutoExecuteDesc || (uiMessage('desktop-ui.same-permissions-as-assistant-plus.ba90411459', (lang === 'zh') ? 'zh' : 'en')),
      hint: t.modeAutonomyHint || t.modeAutoExecuteHint || (uiMessage('desktop-ui.24h-autonomous-work.81b1d75d6b', (lang === 'zh') ? 'zh' : 'en')),
      icon: <Zap size={16} />,
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

  return (
    <div
      data-theme-scope="shell"
      data-appearance={resolvedAppearanceMode}
      data-view-mode={viewMode}
      data-ui-density={desktopChrome.density}
      data-compact-layout={isCompactDesktopLayout ? 'true' : 'false'}
      onContextMenu={handleShellContextMenu}
      className={`fixed inset-0 overflow-hidden cursor-default select-none transition-all duration-1000 ${resolvedAppearanceMode === 'light' ? 'lumi-light-shell' : 'lumi-dark-shell'} ${
      isWallpaperMode ? 'bg-transparent pointer-events-none' :
      resolvedAppearanceMode === 'light' ? 'bg-[#e9efe6]' :
      theme === 'celestial' ? 'bg-[#010103]' :
      theme === 'nebula' ? 'bg-[#050010]' :
      theme === 'cyber' ? 'bg-[#000808]' :
      'bg-black'
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
      <ControlCenter
        isOpen={isControlCenterOpen}
        onClose={() => setIsControlCenterOpen(false)}
        t={t}
        brightness={brightness}
        setBrightness={setBrightness}
        volume={volume}
        setVolume={setVolume}
        lang={lang}
        setLang={setLang}
        toggleWindow={toggleWindow}
      />
      {/* CRT Scanline / Noise Overlay */}
      <div className={`fixed inset-0 z-[1000] pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] select-none transition-opacity duration-500 ${isWallpaperMode ? 'opacity-0' : 'opacity-[0.03]'}`} />
      
      {/* Immersive Environment Layer (Wallpaper OS Foundation) */}
      <div 
        className={`fixed inset-0 z-0 overflow-hidden transition-all duration-1000 ${
          isWallpaperMode ? 'bg-transparent opacity-0' : resolvedAppearanceMode === 'light' ? 'bg-[#e9efe6] opacity-100' : 'bg-[#010103] opacity-100'
        }`}
      >
        <div className="absolute inset-0">
          {/* Warp Flash Overlay */}
          <motion.div 
            animate={{ 
              opacity: viewMode === 'world' ? [0, 0.4, 0] : 0,
            }}
            transition={{ duration: 0.8 }}
            className={`absolute inset-0 z-50 pointer-events-none ${
              theme === 'nebula' ? 'bg-purple-900' : theme === 'cyber' ? 'bg-emerald-900' : 'bg-white'
            }`}
          />

          {/* Global Node Map Background */}
          <div className="absolute inset-0 z-0 pointer-events-none">
             <GlobalNodeMap variant="subtle" />
          </div>

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
               <AnimatePresence mode="wait">
                {theme === 'celestial' && (
                  <motion.div 
                    key="celestial-wp"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: 1 }}
                    className="absolute inset-0"
                  >
                    {resolvedAppearanceMode === 'light' ? (
                      <DayInkLandscape variant="celestial" />
                    ) : (
                      <>
                        <div className="star-field opacity-20" />
                        <div className="undulating-bg opacity-30 scale-125" />
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/80" />
                      </>
                    )}
                  </motion.div>
                )}
                {theme === 'nebula' && (
                  <motion.div 
                    key="nebula-wp"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: 1 }}
                    className="absolute inset-0"
                  >
                    {resolvedAppearanceMode === 'light' ? (
                      <DayInkLandscape variant="nebula" />
                    ) : (
                      <>
                        <div className="star-field opacity-10" />
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(168,85,247,0.1)_0%,transparent_70%)]" />
                        <div className="absolute inset-0 bg-gradient-to-b from-black/0 to-black/60" />
                      </>
                    )}
                  </motion.div>
                )}
                {theme === 'cyber' && (
                  <motion.div 
                    key="cyber-wp"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: 1 }}
                    className="absolute inset-0"
                  >
                    {resolvedAppearanceMode === 'light' ? (
                      <DayInkLandscape variant="cyber" />
                    ) : (
                      <>
                        <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.05)_1px,transparent_1px)] bg-[size:40px_40px]" />
                        <div className="absolute inset-0 bg-gradient-to-b from-black/0 to-black/80" />
                      </>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>

        {/* Hyper-tunnel edges */}
        <div className={`absolute inset-0 pointer-events-none ${resolvedAppearanceMode === 'light' ? 'shadow-[inset_0_0_190px_rgba(72,88,74,0.20)]' : 'shadow-[inset_0_0_300px_rgba(0,0,0,1)]'}`} />
        
        {/* Brightness Overlay */}
        <div 
          className="absolute inset-0 pointer-events-none z-[1000] transition-opacity duration-300" 
          style={{ backgroundColor: 'black', opacity: (100 - brightness) / 100 * 0.7 }} 
        />
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
            <Suspense fallback={null}><InkWorldLazy theme={theme as 'celestial' | 'nebula' | 'cyber'} syncRate={syncRate} /></Suspense>
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
                onClick={() => {
                  setViewMode('personal');
                  if (nexusReturnTarget === 'command-center') openCommandCenter('office');
                }}
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
              onOpenOrganization={() => {
                surfaceReturnTargetRef.current = 'home';
                setChatOpen(false);
                setActiveTab('org');
              }}
              onCloseOrganization={() => {
                // The top-bar switch is the single way out of the full-screen
                // command center. Returning to Personal closes its overlay;
                // there is intentionally no second exit button in the chat.
                surfaceReturnTargetRef.current = 'home';
                setChatOpen(false);
                setKnowledgeOpen(false);
                setMemoryLabOpen(false);
                setSanctuaryOpen(false);
                setSanctuaryAgent(null);
                setChatPrefill('');
                setChatPrefillSource('proactive');
                setActiveTab('home');
              }}
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

            <button
              onClick={() => setIsControlCenterOpen(!isControlCenterOpen)}
              className="lumi-shell-clock flex items-center gap-3 px-3 py-1 bg-white/5 hover:bg-white/10 rounded-full border border-white/5 transition-all group"
            >
              <div className="flex flex-col items-end">
                <span className="text-[12px] font-black text-white/80 leading-none">{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="lumi-shell-date text-xs font-bold text-white/55 uppercase tracking-tighter">{time.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              </div>
              <Activity size={14} className="text-celestial-saturn group-hover:rotate-180 transition-transform duration-500" />
            </button>

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

        {/* Global Control Center handled at top level for proper click detection */}

        {/* Global Search */}
        <AnimatePresence>
          {isSearchOpen && (
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
          <div className="lumi-dock-separator h-8 w-px shrink-0 bg-white/10 mx-2" />
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
        style={{
          scale: personalScale,
          opacity: personalOpacity,
        }}
        className={`lumi-personal-surface absolute inset-0 z-[15] flex flex-col ${viewMode === 'world' ? 'pointer-events-none' : ''}`}
      >
        <div className="relative w-full h-full pointer-events-auto">
          {/* Central Interactive Entity */}
          <div className="lumi-core-stage absolute inset-0 flex items-center justify-center z-[15] pointer-events-none">
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
      <div className={`lumi-desktop-grid relative z-10 w-full h-full overflow-y-auto custom-scrollbar px-3 pb-24 pt-14 transition-all duration-1000 sm:px-6 sm:pt-16 md:p-12 md:pt-20 lg:p-16 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}>
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
              {/* Modern Widgets Grid */}
              <ThemeWidget
                t={t}
                lang={lang}
                theme={theme}
                setTheme={setTheme}
                operationMode={operationMode}
                onModeChange={requestOperationModeChange}
              />

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

      {/* MCP Live Activity — xiaozhi ⇄ Lumi */}
      <AnimatePresence>
        {showMcpPanel && mcpActivities.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-28 right-6 z-[60] w-72 pointer-events-auto"
          >
            <GlassCard className="p-4 rounded-2xl border-white/10 bg-black/70 backdrop-blur-2xl space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-[12px] font-black text-white/40 uppercase tracking-widest">{t.liveDeviceLabel || 'Live'} · xiaozhi ⇄ Lumi</span>
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
                {mcpActivities.slice(0, 5).map((act) => (
                  <div key={act.id} className="text-[12px] text-white/60 border-l-2 border-white/10 pl-2">
                    <span className="text-white/80 font-bold">{act.action === 'create_ppt' ? 'PPT' : act.action === 'chat' ? 'Chat' : act.action}</span>
                    {' · '}
                    <span className={act.status === 'completed' ? 'text-green-400' : act.status === 'failed' ? 'text-red-400' : 'text-celestial-saturn'}>
                      {act.status}
                    </span>
                    {act.message && <div className="text-white/55 truncate">{act.message.slice(0, 60)}</div>}
                    {act.title && <div className="text-white/50">{act.title} ({act.slidesCount} slides)</div>}
                    {act.path && <div className="text-green-400/60 truncate">Saved: {act.path.split('\\').pop()}</div>}
                    {act.toolCalls !== undefined && act.toolCalls > 0 && <div className="text-celestial-saturn/60">Used {act.toolCalls} tool(s)</div>}
                    {act.error && <div className="text-red-400/60 truncate">{act.error.slice(0, 80)}</div>}
                  </div>
                ))}
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>
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
      <div className="absolute inset-0 z-[20] pointer-events-none">
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
          {openWindows.map(windowId => {
            const size = getWindowSize(windowId);
            const orderIdx = windowOrder.indexOf(windowId);
            const meta = getWindowMeta(windowId);
            return (
              <OSWindow
                key={windowId}
                id={windowId}
                title={meta.label}
                icon={meta.icon}
                isActive={focusedWindow === windowId}
                isMinimized={minimizedWindows.includes(windowId)}
                zIndex={10 + (orderIdx >= 0 ? orderIdx : 0)}
                onFocus={(id) => {
                  setFocusedWindow(id);
                  setWindowOrder(prev => [...prev.filter(w => w !== id), id]);
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
                  {windowId === 'kernel' ? (
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
        <Suspense fallback={null}>
          <KnowledgeBase
            t={t}
            isOpen={knowledgeOpen}
            onClose={closeKnowledgeBase}
            domain={workDomain}
          />
        </Suspense>
      )}

      {/* Chat fullscreen overlay */}
      {chatLoaded && (
        <Suspense fallback={null}>
          <AgentChatPage
            t={t}
            user={user}
            isOpen={chatOpen}
            onClose={() => {
              surfaceReturnTargetRef.current = 'home';
              setChatOpen(false);
              setActiveTab('home');
              setChatPrefill('');
              setChatPrefillSource('proactive');
            }}
            layout="command-center"
            commandCenterView={commandCenterView}
            onCommandCenterViewChange={setCommandCenterView}
            onOpenNexus={() => {
              setChatOpen(false);
              setNexusReturnTarget('command-center');
              setViewMode('world');
              setActiveTab('home');
            }}
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
            prefillMessage={chatPrefill}
            prefillSource={chatPrefillSource}
            onPrefillConsumed={() => { setChatPrefill(''); setChatPrefillSource('proactive'); }}
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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="lumi-below-topbar fixed inset-x-0 bottom-0 z-[90] bg-celestial-deep overflow-auto"
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
                onEnterSanctuary={(avatar: any) => {
                  setMemoryAvatars(previous => [
                    ...previous.filter(existing => existing?.id !== avatar?.id),
                    avatar,
                  ]);
                  setMemoryLabOpen(false);
                  setSanctuaryAgent(avatar);
                  setSanctuaryLoaded(true);
                  setSanctuaryOpen(true);
                }}
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
