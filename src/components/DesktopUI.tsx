import React, { useState, useEffect, useCallback, useRef, lazy, Suspense, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
import { GlobalNodeMap } from './GlobalNodeMap';
import { sounds } from '../services/soundService';
import {
  Rocket,
  Cpu,
  Globe,
  Settings as SettingsIcon,
  Shield,
  Zap,
  X,
  User as UserIcon,
  Search,
  Folder,
  FileText,
  Activity,
  Wifi,
  Volume2,
  VolumeX,
  Battery,
  Bluetooth,
  Moon,
  Minimize2,
  Maximize2,
  Minus,
  Square,
  ChevronRight,
  ArrowLeft,
  Bell,
  Disc,
  Headphones,
  BrainCircuit,
  Sparkles,
  Box,
  Wrench,
  MessageSquare,
  Castle,
  Brush,
  Play,
  Pause,
  Mic,
  Terminal as TerminalIcon,
  Music,
  Bot,
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
import { LocalAgentSphere } from './LocalAgentSphere';
import { VoicePicker } from './VoicePicker';
import { CursorGlow } from './CursorGlow';
import { DesktopOnboarding } from './DesktopOnboarding';
import { WorkModeSwitch } from './org/WorkModeSwitch';
import { PetAvatar } from './SpriteAnimator';
import { getDefaultPets } from '../pets/defaults';
import type { PetConfig } from '../pets/types';
import { useSocket } from '@/hooks/useSocket';
import { useAmbientPoller } from '@/hooks/useAmbientPoller';
import { useVoiceCall, type VoiceTranscriptMeta } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';
const NexusGlobe = lazy(() => import('./NexusGlobe/NexusGlobe').then(m => ({ default: m.NexusGlobe })));
const InkWorldLazy = lazy(() => import('./InkWorld').then(m => ({ default: m.InkWorld })));
import type { BackgroundWorkflowTask, WorkflowStep } from './WorkflowPanel';
import { useWakeWord } from '../hooks/useWakeWord';
import { ErrorBoundary } from './ErrorBoundary';
import { ToolConfirmDialog } from './ToolConfirmDialog';
import { appConfirm } from '@/lib/appConfirm';
import { designVoice, listVoices, synthesizeSpeech } from '@/services/voiceService';
import { setMusicLayerVisible, useMusicPlayerRuntime, useMusicPlayerSnapshot, useMusicVisible } from '../hooks/useMusicPlayer';
import { useVoiceprint } from '../hooks/useVoiceprint';
import { useFaceRecognition } from '../hooks/useFaceRecognition';
import { usePresence } from '../hooks/usePresence';
import { getSensorPermissionSnapshot, SENSOR_PERMISSIONS_CHANGED } from '@/services/sensorPermissionService';
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
  canAccessOrganizationWorkspaceView,
  listOrganizationWorkspaceViewsForRole,
  normalizeOrganizationWorkspaceView,
  type OrganizationWorkspaceView,
} from '../../shared/org_workspace';
import { queueOrganizationWorkspaceRoute } from '../lib/orgWorkspaceNavigation';

const AgentChatPage = lazy(() => import('./AgentChatPage').then(m => ({ default: m.AgentChatPage })));
const AutonomousFeed = lazy(() => import('./AutonomousFeed').then(m => ({ default: m.AutonomousFeed })));
const AvatarStudio = lazy(() => import('./AvatarStudio').then(m => ({ default: m.AvatarStudio })));
const ContributorNodePanel = lazy(() => import('./ContributorNodePanel').then(m => ({ default: m.ContributorNodePanel })));
const DeviceSyncCenter = lazy(() => import('./DeviceSyncCenter').then(m => ({ default: m.DeviceSyncCenter })));
const GitHubMCPBrowser = lazy(() => import('./GitHubMCPBrowser').then(m => ({ default: m.GitHubMCPBrowser })));
const KnowledgeBase = lazy(() => import('./KnowledgeBase').then(m => ({ default: m.KnowledgeBase })));
const MemoryAvatarLab = lazy(() => import('./MemoryAvatarLab').then(m => ({ default: m.MemoryAvatarLab })));
const MeshSyncSelector = lazy(() => import('./MeshSyncSelector').then(m => ({ default: m.MeshSyncSelector })));
const MusicCenter = lazy(() => import('./MusicCenter').then(m => ({ default: m.MusicCenter })));
const MusicMoodLayer = lazy(() => import('./MusicMoodLayer').then(m => ({ default: m.MusicMoodLayer })));
const NotificationCenter = lazy(() => import('./NotificationCenter').then(m => ({ default: m.NotificationCenter })));
const OrgPortal = lazy(() => import('./OrgPortal').then(m => ({ default: m.OrgPortal })));
const PersonalityEditor = lazy(() => import('./PersonalityEditor').then(m => ({ default: m.PersonalityEditor })));
const ReminderPanel = lazy(() => import('./ReminderPanel').then(m => ({ default: m.ReminderPanel })));
const RuntimeLogPanel = lazy(() => import('./RuntimeLogPanel').then(m => ({ default: m.RuntimeLogPanel })));
const Sanctuary = lazy(() => import('./Sanctuary').then(m => ({ default: m.Sanctuary })));
const Settings = lazy(() => import('./Settings').then(m => ({ default: m.Settings })));
const SkillCenter = lazy(() => import('./SkillCenter').then(m => ({ default: m.SkillCenter })));
const SubscriptionPanel = lazy(() => import('./SubscriptionPanel').then(m => ({ default: m.SubscriptionPanel })));
const SystemExplorer = lazy(() => import('./SystemExplorer').then(m => ({ default: m.SystemExplorer })));
const TeamHub = lazy(() => import('./TeamHub').then(m => ({ default: m.TeamHub })));
const TerminalWindow = lazy(() => import('./Terminal').then(m => ({ default: m.TerminalWindow })));
const TokenDashboard = lazy(() => import('./TokenDashboard').then(m => ({ default: m.TokenDashboard })));
const ToolPanel = lazy(() => import('./ToolPanel').then(m => ({ default: m.ToolPanel })));
const VoiceForge = lazy(() => import('./VoiceForge').then(m => ({ default: m.VoiceForge })));
const VoiceTrainingDialog = lazy(() => import('./VoiceTrainingDialog').then(m => ({ default: m.VoiceTrainingDialog })));
const WorkflowPanel = lazy(() => import('./WorkflowPanel'));

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
  const labels: Record<string, { zh: string; en: string }> = {
    analyze_code: { zh: '代码辅助', en: 'Code help' },
    debug_error: { zh: '错误分析', en: 'Debug error' },
    debug_trace: { zh: '堆栈定位', en: 'Trace debugging' },
    open_path: { zh: '打开文件路径', en: 'Open path' },
    summarize_url: { zh: '链接总结', en: 'Summarize URL' },
    create_presentation: { zh: '制作演示文稿', en: 'Create presentation' },
    write_document: { zh: '文档写作', en: 'Write document' },
    analyze_spreadsheet: { zh: '表格分析', en: 'Spreadsheet analysis' },
  };
  const resolved = action ? labels[action] : undefined;
  return resolved ? resolved[lang] : (action || (lang === 'zh' ? '继续处理' : 'Continue'));
}

function compactProactivePreview(value: unknown): string {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

function formatProactiveChatPrefill(detail: ProactiveChatDetail, lang: 'en' | 'zh'): string {
  const message = String(detail.message || '').trim();
  const context = detail.proactiveContext || detail.context || {};
  const lines = [message || (lang === 'zh' ? '我刚刚注意到一个上下文变化。' : 'I just noticed a context change.')];

  if (context.trigger === 'window_changed') {
    const appLabel = context.appLabel || context.processName || (lang === 'zh' ? '当前应用' : 'the current app');
    lines.push('');
    lines.push(lang === 'zh'
      ? `我刚刚是因为你切到了 ${appLabel} 才问的。`
      : `I asked because you switched to ${appLabel}.`);
    if (context.windowTitle) {
      lines.push(lang === 'zh'
        ? `当前窗口：${context.windowTitle}`
        : `Active window: ${context.windowTitle}`);
    }
  } else if (context.trigger === 'clipboard_changed') {
    lines.push('');
    lines.push(lang === 'zh'
      ? '我刚刚是因为检测到剪贴板内容才问的。'
      : 'I asked because I noticed new clipboard content.');
    const preview = compactProactivePreview(context.preview);
    if (preview) {
      lines.push(lang === 'zh' ? `内容线索：${preview}` : `Context preview: ${preview}`);
    }
  }

  if (detail.action) {
    lines.push(lang === 'zh'
      ? `建议动作：${proactiveActionLabel(detail.action, lang)}`
      : `Suggested action: ${proactiveActionLabel(detail.action, lang)}`);
  }
  lines.push(lang === 'zh'
    ? '你可以直接回复“嗯，帮我看”，我会接着这个上下文处理。'
    : 'You can reply "yes, take a look" and I will continue from this context.');
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

type CustomerTakeoverStage = 'intake' | 'rules' | 'wechat' | 'result';
type DesignDeliveryStage = 'intake' | 'concept' | 'cad' | 'revit' | 'handoff' | 'result';
type EcommerceGrowthStage = 'intake' | 'diagnosis' | 'content' | 'tools' | 'publish' | 'result';
type CustomerTakeoverBrief = {
  customer: string;
  quote: string;
  amount: string;
  period: string;
  risk: string;
  status: string;
};

const DEFAULT_CUSTOMER_TAKEOVER_BRIEF: CustomerTakeoverBrief = {
  customer: '当前客户 / 当前线索',
  quote: '报价口径待确认',
  amount: '待确认',
  period: '待确认',
  risk: '价格、合同、交付周期和发送动作等待确认',
  status: '推进中',
};

function normalizeCustomerTakeoverBrief(input: any): CustomerTakeoverBrief {
  const source = input && typeof input === 'object' ? input : {};
  return {
    customer: String(source.customer || DEFAULT_CUSTOMER_TAKEOVER_BRIEF.customer),
    quote: String(source.quote || DEFAULT_CUSTOMER_TAKEOVER_BRIEF.quote),
    amount: String(source.amount || DEFAULT_CUSTOMER_TAKEOVER_BRIEF.amount),
    period: String(source.period || DEFAULT_CUSTOMER_TAKEOVER_BRIEF.period),
    risk: String(source.risk || DEFAULT_CUSTOMER_TAKEOVER_BRIEF.risk),
    status: String(source.status || DEFAULT_CUSTOMER_TAKEOVER_BRIEF.status),
  };
}

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

type ViewportSize = {
  width: number;
  height: number;
};

const getViewportSize = (): ViewportSize => {
  if (typeof window === 'undefined') return { width: 1280, height: 820 };
  return { width: window.innerWidth, height: window.innerHeight };
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
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateViewport);
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

const getDesktopIconLayout = (viewport: ViewportSize) => {
  const compact = viewport.width < 820 || viewport.height < 620;
  const startX = compact ? 8 : 40;
  const startY = compact ? 4 : 0;
  const cellWidth = compact ? 94 : 130;
  const cellHeight = compact ? 98 : 120;
  const widgetReserve = viewport.width >= 1280 ? 430 : 0;
  const availableWidth = Math.max(cellWidth, viewport.width - startX * 2 - widgetReserve);
  const columns = Math.max(2, Math.min(compact ? 3 : 4, Math.floor(availableWidth / cellWidth)));

  return { compact, startX, startY, cellWidth, cellHeight, columns };
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
  const constrainRef = React.useRef<HTMLDivElement>(null);
  const viewport = useViewportSize();

  const isSnapped = isMaximized || snapZone !== 'none';
  const compact = viewport.width < 820 || viewport.height < 640;
  const safeInset = compact ? 8 : 16;
  const topInset = compact ? 8 : 48;
  const bottomInset = compact ? 68 : 96;
  const availableWidth = Math.max(320, viewport.width - safeInset * 2);
  const availableHeight = Math.max(300, viewport.height - topInset - bottomInset);
  const roomyScale = viewport.width >= 1500 && viewport.height >= 850
    ? Math.min(1.18, viewport.width / 1600)
    : 1;
  const requestedWidth = parseWindowLength(width, Math.min(900, availableWidth)) * roomyScale;
  const requestedHeight = parseWindowLength(height, Math.min(700, availableHeight)) * Math.min(roomyScale, 1.12);
  const fittedWidth = Math.round(Math.min(requestedWidth, availableWidth));
  const fittedHeight = Math.round(Math.min(requestedHeight, availableHeight));
  const normalLeft = Math.max(safeInset, Math.round((viewport.width - fittedWidth) / 2));
  const normalTop = Math.max(topInset, Math.round(topInset + (availableHeight - fittedHeight) / 2));
  const snappedWidth = isMaximized || compact ? availableWidth : Math.floor(availableWidth / 2);
  const snappedLeft = isMaximized || snapZone === 'left'
    ? safeInset
    : safeInset + availableWidth - snappedWidth;
  const resolvedWidth = isSnapped ? snappedWidth : fittedWidth;
  const resolvedHeight = isSnapped ? availableHeight : fittedHeight;

  return (
    <>
      {/* Invisible drag boundary fills the viewport so windows can be dragged freely */}
      <div ref={constrainRef} className="fixed inset-0 pointer-events-none z-0" />
      <motion.div
        drag={!isMaximized && !isMinimized}
        dragElastic={0.1}
        dragTransition={{ bounceStiffness: 400, bounceDamping: 25 }}
        dragConstraints={constrainRef}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={(_e, info) => {
          setIsDragging(false);
          if (info.point.x < safeInset + 80) setSnapZone('left');
          else if (info.point.x > viewport.width - safeInset - 80) setSnapZone('right');
          else setSnapZone('none');
        }}
        initial={{
          opacity: 0,
          scale: 0.92,
          y: 12,
          filter: 'blur(0px)',
          width: resolvedWidth,
          height: resolvedHeight,
          top: isSnapped ? topInset : normalTop,
          left: isSnapped ? snappedLeft : normalLeft,
          x: 0,
        }}
        animate={isMinimized
          ? { opacity: 0, scale: 0.3, y: 40, filter: 'blur(4px)', transition: { duration: 0.25, ease: [0.4, 0, 1, 1] } }
          : {
              opacity: 1,
              scale: 1,
              y: 0,
              filter: 'blur(0px)',
              width: resolvedWidth,
              height: resolvedHeight,
              top: isSnapped ? topInset : normalTop,
              left: isSnapped ? snappedLeft : normalLeft,
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
          maxWidth: `calc(100vw - ${safeInset * 2}px)`,
          maxHeight: `${availableHeight}px`,
        }}
        onClick={() => !isMinimized && onFocus(id)}
        className={`os-window pointer-events-auto overflow-hidden ${isMaximized ? 'rounded-2xl' : 'rounded-3xl'} ${isActive ? 'ring-1 ring-white/15' : ''} ${isMinimized ? 'pointer-events-none' : ''} ${isDragging ? 'is-dragging' : ''}`}
      >
        <div
          className="os-window-header"
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
              onClick={(e) => { e.stopPropagation(); onClose(id); }}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-red-400/30 hover:bg-red-500/15 hover:text-red-100"
              title={t.close || 'Close'}
            >
              <X size={15} />
            </button>
          </div>
        </div>
        <div
          className="os-window-content bg-[#05050a]/98 backdrop-blur-3xl h-full"
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
      className="fixed top-12 right-6 w-80 glass-dark rounded-[2.5rem] p-6 z-[100] shadow-[0_30px_70px_rgba(0,0,0,0.7)] border border-white/10 backdrop-blur-3xl"
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
        <span className="text-xs font-bold text-white/45 tracking-widest uppercase">{t.desktopVersion || 'Lumi OS v3.0.0'}</span>
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
  onOpenKnowledge,
  onOpenAvatarStudio,
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
  onOpenKnowledge: () => void;
  onOpenAvatarStudio: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeDropHandledAtRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const isCallActive = callState !== 'idle';
  const widgetPet = selectedPet || getDefaultPets()[0] || null;
  const widgetAccessories = selectedPet ? equippedAccessories : [];
  const statusLabel = isCallActive
    ? (operationMode === 'meeting' ? (lang === 'zh' ? '会议记录中' : 'Meeting') : callState)
    : wakeEnabled && wakeListening
      ? (lang === 'zh' ? '唤醒待命' : 'Wake ready')
      : (lang === 'zh' ? '待命' : 'Ready');
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
      if (!res.ok) throw new Error(data.error || (lang === 'zh' ? '资料投喂失败' : 'Upload failed'));
      const count = Array.isArray(data.files) ? data.files.length : files.length;
      toast.success(lang === 'zh' ? `已投喂 ${count} 个资料` : `Fed ${count} file(s)`);
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: workDomain,
          files: (data.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
    } catch (err: any) {
      toast.error(err?.message || (lang === 'zh' ? '资料投喂失败' : 'Upload failed'));
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
      if (!res.ok) throw new Error(data.error || (lang === 'zh' ? '资料投喂失败' : 'Feed failed'));
      const count = Array.isArray(data.files) ? data.files.length : importPaths.length;
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      toast.success(
        lang === 'zh'
          ? `已投喂 ${count} 个资料${skipped ? `，跳过 ${skipped} 个` : ''}`
          : `Fed ${count} file(s)${skipped ? `, skipped ${skipped}` : ''}`,
      );
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: workDomain,
          files: (data.files || []).map((file: any) => ({ id: file.id, name: file.name, displayName: file.displayName })),
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
    } catch (err: any) {
      toast.error(err?.message || (lang === 'zh' ? '资料投喂失败' : 'Feed failed'));
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
            title={lang === 'zh' ? '展开 Lumi' : 'Expand Lumi'}
          >
            <Maximize2 size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onOpenAvatarStudio}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-fuchsia-300/14 bg-fuchsia-300/9 text-fuchsia-100/72 shadow-lg backdrop-blur-lg transition-colors hover:bg-fuchsia-300/18 hover:text-white"
            title={lang === 'zh' ? '形象设计室' : 'Avatar Studio'}
          >
            <Brush size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onOpenKnowledge}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-300/14 bg-cyan-300/9 text-cyan-100/72 shadow-lg backdrop-blur-lg transition-colors hover:bg-cyan-300/18 hover:text-white"
            title={lang === 'zh' ? '资料库' : 'Knowledge'}
          >
            <Folder size={14} />
          </button>
          <button
            data-widget-action="true"
            onClick={onHide}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-black/30 text-white/52 shadow-lg backdrop-blur-lg transition-colors hover:bg-white/12 hover:text-white"
            title={lang === 'zh' ? '隐藏到后台' : 'Hide to background'}
          >
            <Minus size={14} />
          </button>
        </div>

        <div
          data-tauri-drag-region
          className="absolute left-1/2 top-[47%] z-10 flex h-40 w-40 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full transition-transform hover:scale-[1.03] active:cursor-grabbing active:scale-95"
          title={widgetPet?.name || (lang === 'zh' ? '拖动 Lumi' : 'Drag Lumi')}
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
            title={lang === 'zh' ? '投喂资料' : 'Feed files'}
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
            title={isCallActive ? (lang === 'zh' ? '结束语音' : 'End voice') : (lang === 'zh' ? '语音交互' : 'Voice')}
          >
            <Mic size={20} className={isCallActive ? 'animate-pulse' : ''} />
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function KernelMonitorApp({ t }: { t: any }) {
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
          <SystemExplorer t={t} />
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

function EcommerceGrowthPanel({ stage, onClose }: { stage: EcommerceGrowthStage; onClose: () => void }) {
  const stageMeta: Record<EcommerceGrowthStage, { eyebrow: string; title: string; desc: string }> = {
    intake: {
      eyebrow: 'ECOMMERCE INTAKE',
      title: '电商接管任务已识别',
      desc: 'Lumi 正在把店铺、商品、账号和内容制作需求拆成可交付结果：诊断、内容矩阵、外部工具提示词、发布草稿和客服承接。',
    },
    diagnosis: {
      eyebrow: 'STORE DIAGNOSIS',
      title: '店铺增长作战室已生成',
      desc: '作战室和体检报告已经落到桌面交付包，展示目标人群、运营目标、确认边界和下一步动作。',
    },
    content: {
      eyebrow: 'CONTENT FACTORY',
      title: '短视频和图文资产已准备',
      desc: '内容矩阵、60 秒短视频脚本、图文种草结构和素材建议已生成，可交给 WPS、Excel 或运营同事继续处理。',
    },
    tools: {
      eyebrow: 'EXTERNAL TOOL CHAIN',
      title: '外部工具调度已开始',
      desc: '图片交给即梦或 Canva，视频交给可灵或剪映，发布进入创作平台和店铺后台，Lumi 负责拆任务、传提示词、回收结果。',
    },
    publish: {
      eyebrow: 'PUBLISH BOUNDARY',
      title: '发布草稿已准备，等待确认',
      desc: '标题、正文、标签、置顶评论和客服话术已准备，但真实发布、投流扣费、价格库存修改和发送微信默认都停在确认前。',
    },
    result: {
      eyebrow: 'RESULT READY',
      title: '电商增长交付包完成',
      desc: '店铺体检、内容矩阵、图文/视频提示词、发布页、客服话术、运营战报和验证记录已经形成可检查结果。',
    },
  };

  const stageOrder: EcommerceGrowthStage[] = ['intake', 'diagnosis', 'content', 'tools', 'publish', 'result'];
  const currentIndex = stageOrder.indexOf(stage);
  const meta = stageMeta[stage];
  const pipeline = [
    { key: 'intake' as EcommerceGrowthStage, label: '任务识别', value: '店铺 / 商品 / 账号', icon: <MessageSquare size={16} /> },
    { key: 'diagnosis' as EcommerceGrowthStage, label: '店铺体检', value: '作战室 + 诊断报告', icon: <Activity size={16} /> },
    { key: 'content' as EcommerceGrowthStage, label: '内容生产', value: '矩阵 + 脚本 + 图文', icon: <FileText size={16} /> },
    { key: 'tools' as EcommerceGrowthStage, label: '外部工具', value: '即梦 / 可灵 / 剪映', icon: <Globe size={16} /> },
    { key: 'publish' as EcommerceGrowthStage, label: '发布承接', value: '草稿等待确认', icon: <Upload size={16} /> },
  ];
  const resultItems = [
    ['店铺诊断', currentIndex >= 1 ? '已生成' : '准备中'],
    ['内容矩阵', currentIndex >= 2 ? '6 条选题' : '准备中'],
    ['视频脚本', currentIndex >= 2 ? '60 秒分镜' : '准备中'],
    ['图片提示词', currentIndex >= 3 ? '4 组提示词' : '准备中'],
    ['发布草稿', currentIndex >= 4 ? '停在确认前' : '准备中'],
    ['微信/客服', stage === 'result' ? '草稿已准备' : '默认不发送'],
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.97 }}
      transition={{ duration: 0.28 }}
      className="fixed inset-0 z-[260] flex items-center justify-center px-4 py-10 pointer-events-none"
    >
      <div className="pointer-events-auto w-[min(1060px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-fuchsia-300/18 bg-zinc-950/93 shadow-2xl shadow-fuchsia-950/25 backdrop-blur-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.28em] text-fuchsia-200">{meta.eyebrow}</div>
            <h3 className="mt-2 text-2xl font-black tracking-tight text-white">{meta.title}</h3>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/58">{meta.desc}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-3">
            {pipeline.map((item) => {
              const active = stage === 'result' || stageOrder.indexOf(item.key) <= currentIndex;
              return (
                <div
                  key={item.key}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                    active
                      ? 'border-fuchsia-300/18 bg-fuchsia-300/[0.075] text-fuchsia-50'
                      : 'border-white/8 bg-white/[0.025] text-white/35'
                  }`}
                >
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-fuchsia-300/12 text-fuchsia-200' : 'bg-white/5 text-white/30'}`}>
                    {item.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-black uppercase tracking-[0.16em]">{item.label}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-white/65">{item.value}</div>
                  </div>
                  <div className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-fuchsia-300 shadow-[0_0_16px_rgba(240,171,252,0.75)]' : 'bg-white/15'}`} />
                </div>
              );
            })}
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">GROWTH RESULT</div>
                <div className="mt-1 text-lg font-black text-white">电商增长交付结果</div>
              </div>
              <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-black uppercase tracking-widest text-emerald-200">
                {stage === 'result' ? 'READY' : 'RUNNING'}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {resultItems.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/[0.07] bg-white/[0.035] px-3 py-2.5">
                  <div className="text-[10px] font-black uppercase tracking-[0.16em] text-white/32">{label}</div>
                  <div className="mt-1 text-sm font-bold text-white/78">{value}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.08] px-3 py-3 text-sm leading-relaxed text-white/65">
              Lumi 已准备：店铺体检、短视频内容矩阵、图文种草包、图片/视频外部工具提示词、发布草稿、微信/客服接管话术和验证记录。真实发布、投流、改价改库存、发送消息仍等待确认。
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function CustomerTakeoverPanel({ stage, brief, onClose }: { stage: CustomerTakeoverStage; brief: CustomerTakeoverBrief; onClose: () => void }) {
  const stageMeta: Record<CustomerTakeoverStage, { eyebrow: string; title: string; desc: string }> = {
    intake: {
      eyebrow: 'CUSTOMER INTAKE',
      title: '微信线索已识别',
      desc: '客户正在询价，并要求正式报价。Lumi 将按用户规则进入客户推进流程。',
    },
    rules: {
      eyebrow: 'WORK RULES',
      title: '按授权边界接管',
      desc: '常规沟通、报价材料、跟进动作自动执行；价格底线、合同风险、最终责任判断再上报。',
    },
    wechat: {
      eyebrow: 'WECHAT DRAFT',
      title: '客户回复草稿已准备',
      desc: 'Lumi 已按用户风格生成微信回复，默认等待确认，不自动发送。',
    },
    result: {
      eyebrow: 'RESULT READY',
      title: '客户已推进到结果',
      desc: '标准版方案、报价、合同草案和项目启动清单已经形成，后续进入定金和启动流程。',
    },
  };

  const meta = stageMeta[stage];
  const pipeline = [
    { label: '微信线索识别', value: '已完成', icon: <MessageSquare size={16} /> },
    { label: '报价方案生成', value: brief.quote, icon: <FileText size={16} /> },
    { label: '客户资料补充', value: '行业与风险点已读取', icon: <Globe size={16} /> },
    { label: '微信回复草稿', value: '等待确认发送', icon: <Copy size={16} /> },
  ];
  const resultItems = [
    ['客户', brief.customer],
    ['状态', stage === 'result' ? brief.status : '推进中'],
    ['金额', brief.amount],
    ['合同草案', stage === 'result' ? '已生成' : '准备中'],
    ['周期', brief.period],
    ['风险点', brief.risk],
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.97 }}
      transition={{ duration: 0.28 }}
      className="fixed inset-0 z-[258] flex items-center justify-center px-4 py-10 pointer-events-none"
    >
      <div className="pointer-events-auto w-[min(960px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-cyan-300/20 bg-zinc-950/92 shadow-2xl shadow-cyan-950/30 backdrop-blur-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.28em] text-cyan-200">{meta.eyebrow}</div>
            <h3 className="mt-2 text-2xl font-black tracking-tight text-white">{meta.title}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">{meta.desc}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="grid gap-4 p-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-3">
            {pipeline.map((item, index) => {
              const active = stage === 'result' || index <= (stage === 'wechat' ? 3 : stage === 'rules' ? 1 : 0);
              return (
                <div
                  key={item.label}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                    active
                      ? 'border-cyan-300/18 bg-cyan-300/[0.075] text-cyan-50'
                      : 'border-white/8 bg-white/[0.025] text-white/35'
                  }`}
                >
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-cyan-300/12 text-cyan-200' : 'bg-white/5 text-white/30'}`}>
                    {item.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-black uppercase tracking-[0.16em]">{item.label}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-white/65">{item.value}</div>
                  </div>
                  <div className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-cyan-300 shadow-[0_0_16px_rgba(103,232,249,0.8)]' : 'bg-white/15'}`} />
                </div>
              );
            })}
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">CUSTOMER RESULT</div>
                <div className="mt-1 text-lg font-black text-white">客户推进结果</div>
              </div>
              <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-black uppercase tracking-widest text-emerald-200">
                {stage === 'result' ? 'READY' : 'RUNNING'}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {resultItems.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/[0.07] bg-white/[0.035] px-3 py-2.5">
                  <div className="text-[10px] font-black uppercase tracking-[0.16em] text-white/32">{label}</div>
                  <div className="mt-1 text-sm font-bold text-white/78">{value}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-lg border border-celestial-saturn/20 bg-celestial-saturn/[0.08] px-3 py-3 text-sm leading-relaxed text-white/65">
              Lumi 已生成：报价方案、合同草案、微信跟进草稿、项目启动清单。超出授权边界的发送和最终签约仍等待用户确认。
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function DesignDeliveryPanel({ stage, onClose }: { stage: DesignDeliveryStage; onClose: () => void }) {
  const stageMeta: Record<DesignDeliveryStage, { eyebrow: string; title: string; desc: string }> = {
    intake: {
      eyebrow: 'DESIGN INTAKE',
      title: '装修需求已接管',
      desc: 'Lumi 正在把微信或自然语言里的装修需求拆成户型、风格、预算、交付物、风险和下一步动作。',
    },
    concept: {
      eyebrow: 'CONCEPT PACKAGE',
      title: '方案、预算与汇报文件已生成',
      desc: '设计方案、预算材料清单、PPTX 汇报版和 PDF 交付版已落到本地文件，可直接打开查看。',
    },
    cad: {
      eyebrow: 'CAD HANDOFF',
      title: 'CAD 初稿与预览已生成',
      desc: 'Lumi 已创建 DXF 平面布置文件和 SVG 可视化预览，用于进入 CAD 软件继续深化。',
    },
    revit: {
      eyebrow: 'REVIT HANDOFF',
      title: 'Revit 交接数据已准备',
      desc: 'Dynamo 建模脚本和空间表已经生成，可作为 Revit 侧创建墙体、房间、标签和材料计划的入口。',
    },
    handoff: {
      eyebrow: 'WECHAT HANDOFF',
      title: '客户交付话术已准备',
      desc: 'Lumi 已把交付包摘要整理成微信草稿；默认只复制和填入，不自动发送，除非用户明确授权。',
    },
    result: {
      eyebrow: 'DELIVERY READY',
      title: '装修设计交付包完成',
      desc: '这一单已经整理好了。方案、预算、CAD、预览图、Revit 交接数据和微信话术都齐了，可以继续推进客户确认。',
    },
  };

  const meta = stageMeta[stage];
  const stageOrder: DesignDeliveryStage[] = ['intake', 'concept', 'cad', 'revit', 'handoff', 'result'];
  const currentIndex = stageOrder.indexOf(stage);
  const pipeline = [
    { key: 'intake' as DesignDeliveryStage, label: '需求识别', value: '客户目标 / 户型 / 预算', icon: <MessageSquare size={16} /> },
    { key: 'concept' as DesignDeliveryStage, label: '方案汇报', value: 'RTF + PPTX + PDF', icon: <FileText size={16} /> },
    { key: 'cad' as DesignDeliveryStage, label: 'CAD 初稿', value: 'DXF + SVG 预览', icon: <Brush size={16} /> },
    { key: 'revit' as DesignDeliveryStage, label: 'Revit 交接', value: 'Dynamo + 空间表', icon: <Box size={16} /> },
    { key: 'handoff' as DesignDeliveryStage, label: '微信交付', value: '草稿等待确认', icon: <Copy size={16} /> },
  ];
  const resultItems = [
    ['项目', '120 平三居室'],
    ['方案', stage === 'result' ? '已完成' : '生成中'],
    ['汇报', currentIndex >= 1 ? 'PPTX + PDF' : '准备中'],
    ['预算', '28 万控制线'],
    ['CAD', currentIndex >= 2 ? 'DXF + 预览图' : '准备中'],
    ['Revit', currentIndex >= 3 ? 'Dynamo 交接包' : '准备中'],
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.97 }}
      transition={{ duration: 0.28 }}
      className="fixed inset-0 z-[259] flex items-center justify-center px-4 py-10 pointer-events-none"
    >
      <div className="pointer-events-auto w-[min(1040px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-emerald-300/20 bg-zinc-950/93 shadow-2xl shadow-emerald-950/30 backdrop-blur-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.28em] text-emerald-200">{meta.eyebrow}</div>
            <h3 className="mt-2 text-2xl font-black tracking-tight text-white">{meta.title}</h3>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/58">{meta.desc}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-3">
            {pipeline.map((item) => {
              const active = stage === 'result' || stageOrder.indexOf(item.key) <= currentIndex;
              return (
                <div
                  key={item.key}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                    active
                      ? 'border-emerald-300/18 bg-emerald-300/[0.075] text-emerald-50'
                      : 'border-white/8 bg-white/[0.025] text-white/35'
                  }`}
                >
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-emerald-300/12 text-emerald-200' : 'bg-white/5 text-white/30'}`}>
                    {item.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-black uppercase tracking-[0.16em]">{item.label}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-white/65">{item.value}</div>
                  </div>
                  <div className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,0.8)]' : 'bg-white/15'}`} />
                </div>
              );
            })}
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.22em] text-white/35">DESIGN DELIVERY</div>
                <div className="mt-1 text-lg font-black text-white">本地交付结果</div>
              </div>
              <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-xs font-black uppercase tracking-widest text-cyan-200">
                {stage === 'result' ? 'DONE' : 'RUNNING'}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {resultItems.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/[0.07] bg-white/[0.035] px-3 py-2.5">
                  <div className="text-[10px] font-black uppercase tracking-[0.16em] text-white/32">{label}</div>
                  <div className="mt-1 text-sm font-bold text-white/78">{value}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-lg border border-emerald-300/18 bg-emerald-300/[0.07] px-3 py-3 text-sm leading-relaxed text-white/68">
              Lumi 当前阶段会把结果落到外部电脑系统：WPS / 编辑器查看方案，PPTX 用于汇报，PDF 用于客户确认，CAD 接收 DXF，Revit 侧接收 Dynamo 脚本和空间表，微信只准备交付草稿。
            </div>
          </div>
        </div>
      </div>
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
            {isZh ? 'Lumi 学习与吸收' : 'Lumi Learning & Absorption'}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/42">
            {isZh
              ? '这里是 Lumi 自己创建、执行和沉淀知识的学习流：她会从上下文、资料和记忆里持续吸收新东西。'
              : 'This is Lumi’s own learning stream: she creates plans, executes them, and absorbs reusable knowledge from context, files, and memory.'}
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

  const loadPlans = async () => {
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
  };

  useEffect(() => { loadPlans(); }, []);

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
        ? (isZh ? '吸收中' : 'Absorbing')
        : activeStep.title
      : (isZh ? '等待下一轮执行' : 'Waiting for next run');
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
            {embedded ? (isZh ? 'Lumi 学习计划' : 'Lumi Learning Plans') : (isZh ? 'Lumi 学习流' : 'Lumi Learning')}
          </span>
          {!embedded && (
            <p className="mt-1 text-[11px] text-white/30">
              {activeCount > 0
                ? (isZh ? `${activeCount} 个学习计划` : `${activeCount} learning plan${activeCount === 1 ? '' : 's'}`)
                : (isZh ? '暂无学习计划' : 'No learning plans')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenQueue && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenQueue(); }}
              className="lumi-button h-7 px-2 text-[10px]"
            >
              {isZh ? '队列' : 'Queue'}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-white/30 text-xs py-2">{isZh ? '加载中...' : 'Loading...'}</div>
      ) : plans.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-3 text-xs text-white/30">
          {isZh ? 'Lumi 还没有生成学习计划。进入自主模式并开启自动处理后，她会按最近上下文持续创建。' : 'Lumi has not generated learning plans yet. In autonomous mode with auto processing enabled, she will keep creating them from recent context.'}
        </div>
      ) : (
        <div className="space-y-2">
          {plans.map((plan: any) => {
            const { steps, done, label } = getStepInfo(plan);
            const progress = steps.length > 0 ? `${done}/${steps.length}` : (isZh ? '待沉淀' : 'queued');
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
                    title={isZh ? '移除计划' : 'Remove plan'}
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
  const [syncRate, setSyncRate] = useState(1);
  const cameraZ = useMotionValue(viewMode === 'personal' ? 0 : -800);

  useEffect(() => {
    cameraZ.set(viewMode === 'personal' ? 0 : -1000);
  }, [viewMode]);

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

  const [openWindows, setOpenWindows] = useState<string[]>(activeTab !== 'home' && activeTab !== 'knowledge' ? [activeTab] : []);
  const [minimizedWindows, setMinimizedWindows] = useState<string[]>([]);
  const [focusedWindow, setFocusedWindow] = useState<string | null>(activeTab !== 'home' && activeTab !== 'knowledge' ? activeTab : null);
  const [windowOrder, setWindowOrder] = useState<string[]>(activeTab !== 'home' && activeTab !== 'knowledge' ? [activeTab] : []);
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
  const [chatOpen, setChatOpen] = useState(false);
  const [chatLoaded, setChatLoaded] = useState(false);
  const [chatPrefill, setChatPrefill] = useState('');
  const [chatPrefillSource, setChatPrefillSource] = useState('proactive');
  const [sanctuaryOpen, setSanctuaryOpen] = useState(false);
  const [sanctuaryLoaded, setSanctuaryLoaded] = useState(false);
  const [sanctuaryAgent, setSanctuaryAgent] = useState<any>(null);
  const [petReaction, setPetReaction] = useState<{ animation: string; until: number } | null>(null);
  const [activePersonality, setActivePersonality] = useState('lumi');
  const petReactionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerPetReaction = (animation: string, ms: number = 1500) => {
    if (petReactionTimeout.current) clearTimeout(petReactionTimeout.current);
    setPetReaction({ animation, until: Date.now() + ms });
    petReactionTimeout.current = setTimeout(() => setPetReaction(null), ms);
  };

  const [memoryLabOpen, setMemoryLabOpen] = useState(false);
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
      toast.error(lang === 'zh' ? '只有组织所有者或管理员可以修改组织工作域形象' : 'Only an organization owner or administrator can change the organization workspace appearance');
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
      toast.error(err?.message || (lang === 'zh' ? '形象保存失败' : 'Appearance save failed'));
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
  const [brightness, setBrightness] = useState(85);
  const [volume, setVolume] = useState(60);
  const [time, setTime] = useState(new Date());
  const [isWallpaperMode, setIsWallpaperMode] = useState(false);
  const [isDesktopWidgetMode, setIsDesktopWidgetMode] = useState(false);
  const isWallpaperModeRef = useRef(false);
  const chatOpenRef = useRef(false);
  const closeToBackgroundSyncRef = useRef(false);
  const desktopWidgetFallbackRef = useRef<DesktopWidgetFallbackState | null>(null);
  const wallpaperAutomationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wallpaperWasEnabledBeforeAutomationRef = useRef(false);
  const wallpaperWorkPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewport = useViewportSize();
  const [wallpaperWorkPromptVisible, setWallpaperWorkPromptVisible] = useState(false);
  const [customerTakeoverStage, setCustomerTakeoverStage] = useState<CustomerTakeoverStage | null>(null);
  const [customerTakeoverBrief, setCustomerTakeoverBrief] = useState<CustomerTakeoverBrief>(DEFAULT_CUSTOMER_TAKEOVER_BRIEF);
  const [designDeliveryStage, setDesignDeliveryStage] = useState<DesignDeliveryStage | null>(null);
  const [ecommerceGrowthStage, setEcommerceGrowthStage] = useState<EcommerceGrowthStage | null>(null);
  const [wallpaper, setWallpaper] = useState<string>(() => localStorage.getItem('lumi_wallpaper_type') || 'celestial');
  const [wallpaperUrl, setWallpaperUrl] = useState<string>(() => localStorage.getItem('lumi_wallpaper_url') || '');
  const wallpaperInputRef = React.useRef<HTMLInputElement>(null);
  const desktopIconLayout = useMemo(() => getDesktopIconLayout(viewport), [viewport]);

  useEffect(() => {
    isWallpaperModeRef.current = isWallpaperMode;
    if (isWallpaperMode) setWallpaperWorkPromptVisible(false);
  }, [isWallpaperMode]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (chatOpen) setWallpaperWorkPromptVisible(false);
  }, [chatOpen]);

  const openProactiveChat = useCallback((detail: ProactiveChatDetail) => {
    setIsNotificationPanelOpen(false);
    setChatPrefillSource('proactive_context');
    setChatPrefill(formatProactiveChatPrefill(detail, lang));
    setChatOpen(true);
  }, [lang]);

  useEffect(() => {
    const handleOpenProactiveChat = (event: Event) => {
      openProactiveChat((event as CustomEvent<ProactiveChatDetail>).detail || {});
    };
    window.addEventListener('lumi:open-proactive-chat', handleOpenProactiveChat);
    return () => window.removeEventListener('lumi:open-proactive-chat', handleOpenProactiveChat);
  }, [openProactiveChat]);

  const getDefaultDesktopIconPosition = useCallback((index: number) => ({
    x: desktopIconLayout.startX + (index % desktopIconLayout.columns) * desktopIconLayout.cellWidth,
    y: desktopIconLayout.startY + Math.floor(index / desktopIconLayout.columns) * desktopIconLayout.cellHeight,
  }), [desktopIconLayout]);

  // Desktop icon layout: absolute positioning with viewport-aware columns.
  const desktopIcons = [
    { id: 'runtime-log', labelKey: 'runtimeLog', icon: <TerminalIcon size={24} />, colorClass: 'from-teal-500 to-cyan-600', windowId: 'runtime-log' },
    { id: 'tools', labelKey: 'tools', icon: <Wrench size={24} />, colorClass: 'from-amber-500 to-orange-600', windowId: 'tools' },
    { id: 'skills', labelKey: 'skills', icon: <Sparkles size={24} />, colorClass: 'from-emerald-500 to-teal-600', windowId: 'skills' },
    { id: 'team', labelKey: 'team', icon: <Bot size={24} />, colorClass: 'from-cyan-500 to-blue-600', windowId: 'team' },
    { id: 'memory-avatar', labelKey: 'memoryAvatars', icon: <Castle size={24} />, colorClass: 'from-fuchsia-500 to-purple-600', windowId: 'memory-avatar' },
    { id: 'avatar-studio', labelKey: 'avatarStudio', icon: <Brush size={24} />, colorClass: 'from-cyan-400 to-blue-600', windowId: 'avatar-studio' },
    { id: 'sound', labelKey: 'sound', icon: <Volume2 size={24} />, colorClass: 'from-sky-500 to-indigo-600', windowId: 'sound' },
    { id: 'music', labelKey: 'music', icon: <Music size={24} />, colorClass: 'from-red-500 to-pink-600', windowId: 'music-center' },
  ];
  const desktopIconAreaHeight = Math.max(
    desktopIconLayout.compact ? 300 : 400,
    Math.ceil(desktopIcons.length / desktopIconLayout.columns) * desktopIconLayout.cellHeight + desktopIconLayout.startY + 24,
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
  const handleWindowMaximize = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('toggle_maximize_window');
    } catch {}
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
        const status = await invoke<{ enabled?: boolean }>('get_desktop_widget_mode');
        if (!disposed) setIsDesktopWidgetMode(Boolean(status?.enabled));
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
  const finishSensorPrimer = useCallback(() => {
    localStorage.setItem('lumi_sensor_primer_seen', 'true');
    setSensorPrimerSeen(true);
  }, []);
  const [mcpActivities, setMcpActivities] = useState<Array<{
    id: string; device: string; action: string; status: string;
    message?: string; title?: string; path?: string; slidesCount?: number; toolCalls?: number; error?: string;
    time: number;
  }>>([]);
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'done' | 'error'>('idle');
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [backgroundWorkflowTasks, setBackgroundWorkflowTasks] = useState<BackgroundWorkflowTask[]>([]);
  const [pendingOperationMode, setPendingOperationMode] = useState<OperationMode | null>(null);
  const seenWorkflowToolEvents = useRef<Set<string>>(new Set());
  const backgroundTaskStatusRef = useRef<Map<string, string>>(new Map());
  const readMeetingItem = (scopedKey: string, legacyKey: string): string | null => (
    localStorage.getItem(scopedKey)
      ?? (workDomain === 'personal' ? localStorage.getItem(legacyKey) : null)
  );
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
  }, [meetingPreferenceScopeKey]);
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
    return lang === 'zh' ? '未知说话人' : 'Unknown speaker';
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
    toast.success(lang === 'zh' ? '\u4f1a\u8bae\u5df2\u7528\u9ad8\u7cbe\u5ea6\u6a21\u578b\u91cd\u65b0\u8f6c\u5199' : 'Meeting transcript refined with the high-accuracy model');
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
      toast.info(data?.message || (lang === 'zh' ? '\u6b63\u5728\u7528\u9ad8\u7cbe\u5ea6\u6a21\u578b\u91cd\u8f6c\u4f1a\u8bae\u5f55\u97f3...' : 'Refining the meeting recording with the high-accuracy model...'));
    };
    const onRefined = (data: { text?: string; provider?: string; model?: string; durationMs?: number; startedAt?: number; segments?: RefinedMeetingSegment[]; speakerCount?: number }) => {
      finish(applyRefinedMeetingTranscript(data));
    };
    const onError = (data: { message?: string }) => {
      toast.error(data?.message || (lang === 'zh' ? '\u9ad8\u7cbe\u5ea6\u4f1a\u8bae\u8f6c\u5199\u5931\u8d25\uff0c\u4fdd\u7559\u5b9e\u65f6\u7b14\u8bb0' : 'High-accuracy meeting transcription failed; keeping realtime notes'));
      finish(null);
    };
    const onDomainChanged = () => finish(null);
    const timeout = window.setTimeout(() => {
      toast.error(lang === 'zh' ? '\u9ad8\u7cbe\u5ea6\u4f1a\u8bae\u8f6c\u5199\u8d85\u65f6\uff0c\u4fdd\u7559\u5b9e\u65f6\u7b14\u8bb0' : 'High-accuracy meeting transcription timed out; keeping realtime notes');
      finish(null);
    }, 60 * 60 * 1000);
    socket.once('meeting:refined_transcript', onRefined);
    socket.once('meeting:refine_error', onError);
    socket.on('meeting:refine_status', onStatus);
    window.addEventListener('lumi:domain-changed', onDomainChanged, { once: true });
  }), [applyRefinedMeetingTranscript, lang, socket]);

  useMusicPlayerRuntime();
  const musicVisible = useMusicVisible();
  const [musicLayerLoaded, setMusicLayerLoaded] = useState(false);
  const musicSnapshot = useMusicPlayerSnapshot();

  useEffect(() => {
    if (knowledgeOpen) setKnowledgeLoaded(true);
  }, [knowledgeOpen]);

  useEffect(() => {
    if (chatOpen) setChatLoaded(true);
  }, [chatOpen]);

  useEffect(() => {
    if (sanctuaryOpen) setSanctuaryLoaded(true);
  }, [sanctuaryOpen]);

  useEffect(() => {
    if (musicVisible) setMusicLayerLoaded(true);
  }, [musicVisible]);

  const voiceprint = useVoiceprint({ socket });
  const ownerVoiceGateOpen = useCallback(() => {
    if (!voiceprint.templatesLoaded) return false;
    if (voiceprint.enrolledCount === 0) return true;
    if (!voiceprint.hasUsableTemplates) return false;
    return voiceprint.result.isOwnerSpeaking && voiceprint.result.confidence >= 0.68;
  }, [
    voiceprint.enrolledCount,
    voiceprint.hasUsableTemplates,
    voiceprint.result.confidence,
    voiceprint.result.isOwnerSpeaking,
    voiceprint.templatesLoaded,
  ]);
  useAmbientPoller(socket); // Ambient awareness: polls window, clipboard, idle state
  const { callState, audioLevel, startCall, startCallRef, endCall, error: callError, transcript, interrupt, toggleMute, isMuted, switchPersonality } = useVoiceCall({
    socket,
    onTranscript: appendMeetingTranscript,
    canInterruptFromVoice: ownerVoiceGateOpen,
    canSendMicAudio: ownerVoiceGateOpen,
  });
  const voiceScopeOptions = useMemo(() => (
    workDomain === 'work' && orgConnection?.connected && orgConnection?.orgId
      ? { domain: 'work' as const, orgId: orgConnection.orgId }
      : { domain: 'personal' as const }
  ), [orgConnection?.connected, orgConnection?.orgId, workDomain]);
  const getVoiceScopeOptions = useCallback(() => voiceScopeOptions, [voiceScopeOptions]);
  useEffect(() => {
    void voiceprint.loadTemplates();
  }, [voiceprint.loadTemplates]);
  useEffect(() => {
    if (!voiceprint.templatesLoaded || voiceprint.enrolledCount === 0 || !voiceprint.hasUsableTemplates) return;
    void voiceprint.startListening();
    return () => voiceprint.stopListening();
  }, [
    voiceprint.enrolledCount,
    voiceprint.hasUsableTemplates,
    voiceprint.startListening,
    voiceprint.stopListening,
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
  const runtimeLogOpenRef = useRef(openWindows.includes('runtime-log'));
  useEffect(() => { runtimeLogOpenRef.current = openWindows.includes('runtime-log'); }, [openWindows]);
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
      if (disposed) return;
      setClientPermissions({ ...snapshot });
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
    canSendWakeAudio: ownerVoiceGateOpen,
    isCallActive: () => callState !== 'idle',
    onInterrupt: () => interrupt(),
  });

  // ── Biometrics: voiceprint + face recognition + presence ──
  const faceRecognition = useFaceRecognition({ enabled: sensorPrimerSeen && workDomain === 'personal', socket });
  const presence = usePresence({
    socket,
    faceResult: faceRecognition.result,
    voiceprintResult: voiceprint.result,
    userId: workDomain === 'personal' ? user?.uid : undefined,
  });

  // Idle→active return greeting — listens for ambient idle reports and fires on return
  const lastIdleRef = useRef<number>(0);
  const greetedRef = useRef(false);
  const IDLE_AWAY_S = 5 * 60; // 5 min considered "away"
  const RETURN_S = 30;        // < 30s considered "back"
  useEffect(() => {
    if (!socket) return;
    const onIdleReport = (data: { idle_ms: number; idle_seconds: number }) => {
      const idleS = data.idle_seconds ?? (data.idle_ms / 1000);
      const wasAway = lastIdleRef.current > IDLE_AWAY_S;
      const isBack = idleS < RETURN_S;
      const allowProactiveGreeting = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
      if (wasAway && isBack && !greetedRef.current && allowProactiveGreeting) {
        greetedRef.current = true;
        // LLM-generated personalized greeting — server generates, TTS speaks
        socket.emit('greeting:generate', { scene: 'return' });
      }
      if (idleS >= IDLE_AWAY_S) {
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
        lang === 'zh' ? '# Lumi 律所会谈纪要' : '# Lumi Legal Consultation Memo',
        '',
        `${lang === 'zh' ? '案件' : 'Case'}: ${legalCaseTitle}`,
        `${lang === 'zh' ? '开始时间' : 'Started'}: ${started}`,
        `${lang === 'zh' ? '记录条数' : 'Transcript items'}: ${notesForReport.length}`,
        '',
        `## ${lang === 'zh' ? '会谈纪要' : 'Consultation Summary'}`,
        notesForReport.length > 0
          ? (lang === 'zh' ? `本次会谈共收录 ${notesForReport.length} 条转写。LLM 分析暂不可用，以下为本地基础整理。` : `Captured ${notesForReport.length} transcript items. LLM analysis was unavailable; this is a local structured memo.`)
          : (lang === 'zh' ? '本次会谈没有收录到可整理的转写。' : 'No transcript was captured for this consultation.'),
        '',
        `## ${lang === 'zh' ? '事实摘要' : 'Fact Summary'}`,
        ...(notesForReport.slice(-6).map(note => `- ${formatMeetingNoteForExport(note)}`)),
        ...(notesForReport.length === 0 ? [`- ${lang === 'zh' ? '暂无事实摘要。' : 'No fact summary yet.'}`] : []),
        '',
        `## ${lang === 'zh' ? '争议焦点' : 'Issues'}`,
        `- ${lang === 'zh' ? '请律师结合案由、证据和对方主张进一步确认。' : 'Counsel should confirm issues against claims, evidence, and procedural posture.'}`,
        '',
        `## ${lang === 'zh' ? '待补材料' : 'Missing Materials'}`,
        ...(actionHints.length > 0 ? actionHints : [`- ${lang === 'zh' ? '暂未检测到明确待补材料。' : 'No clear missing materials detected.'}`]),
        '',
        `## ${lang === 'zh' ? '下一步建议' : 'Next Steps'}`,
        `- ${lang === 'zh' ? '复核会谈转写，补充证据清单、责任人和期限。' : 'Review the transcript and add evidence list, owners, and deadlines.'}`,
        '',
        `## ${lang === 'zh' ? '安全边界' : 'Safety Boundary'}`,
        `- ${lang === 'zh' ? '本纪要仅辅助律师分析，最终法律意见和对外文书由执业律师确认。' : 'This memo assists legal analysis only; final legal advice and filings require licensed counsel review.'}`,
      ].join('\n');
    }
    return [
      lang === 'zh' ? '# Lumi 会议报告' : '# Lumi Meeting Report',
      '',
      `${lang === 'zh' ? '开始时间' : 'Started'}: ${started}`,
      `${lang === 'zh' ? '记录条数' : 'Transcript items'}: ${notesForReport.length}`,
      '',
      `## ${lang === 'zh' ? '会议摘要' : 'Summary'}`,
      notesForReport.length > 0
        ? (lang === 'zh' ? `本次会议共收录 ${notesForReport.length} 条转写。LLM 分析暂不可用，下面是基于转写的基础整理。` : `Captured ${notesForReport.length} transcript items. LLM analysis was unavailable, so this is a basic local report.`)
        : (lang === 'zh' ? '本次会议没有可整理的转写内容。' : 'No transcript was captured for this meeting.'),
      '',
      `## ${lang === 'zh' ? '待办/决策线索' : 'Action / Decision Signals'}`,
      ...(actionHints.length > 0 ? actionHints : [`- ${lang === 'zh' ? '未检测到明确待办或决策线索。' : 'No clear action or decision signals detected.'}`]),
      '',
      `## ${lang === 'zh' ? '建议' : 'Suggestion'}`,
      `- ${lang === 'zh' ? '建议人工复核转写，补充负责人、截止时间和最终决策。' : 'Review the transcript manually and add owners, deadlines, and final decisions.'}`,
    ].join('\n');
  }, [formatMeetingNoteForExport, formatMeetingTime, lang, legalMeetingCaseTitle, meetingNotes, meetingStartedAt]);

  const analyzeMeetingNotes = useCallback(async (endedAt = Date.now(), notesOverride?: MeetingNote[]) => {
    const notesForAnalysis = notesOverride || meetingNotes;
    if (notesForAnalysis.length === 0) {
      const fallback = buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(fallback);
      localStorage.setItem(meetingStorageKeys.report, fallback);
      toast.info(lang === 'zh' ? '会议没有收录到转写，已生成空会议报告' : 'No transcript captured; generated an empty meeting report');
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
      toast.success(lang === 'zh' ? 'Lumi 已整理会议报告' : 'Lumi generated the meeting report');
      return report;
    } catch (err: any) {
      const fallback = buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(fallback);
      localStorage.setItem(meetingStorageKeys.report, fallback);
      toast.error(err?.message || (lang === 'zh' ? '会议分析失败，已生成基础报告' : 'Meeting analysis failed; generated a basic report'));
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
      const transcript = notesForArchive
        .map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`)
        .join('\n');
      const content = [
        `# 当事人会谈 ${started.toLocaleString()}`,
        '',
        '## Lumi 会谈整理',
        '',
        report,
        '',
        '## 原始转写',
        '',
        transcript,
        '',
        '## 安全边界',
        '',
        '本记录用于辅助律师分析，最终法律意见与对外文书由执业律师确认。',
      ].join('\n');
      try {
        const res = await fetch(`/api/org/legal/cases/${encodeURIComponent(consultationCaseId)}/materials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            type: 'consultation',
            title: `当事人会谈 ${started.toLocaleString()}`,
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
        toast.success(lang === 'zh' ? '会谈已归档到组织案件' : 'Consultation archived to organization case');
        return;
      } catch (err: any) {
        toast.error(err?.message || (lang === 'zh' ? '会谈归档到组织案件失败' : 'Failed to archive consultation to organization case'));
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
      toast.error(lang === 'zh' ? '会谈归档失败，请检查当前案件' : 'Failed to archive consultation to the case');
      return;
    }
    lastLegalMeetingArchiveRef.current = archiveKey;
    setLegalMeetingCaseTitle('');
    toast.success(lang === 'zh' ? `会谈已归档到案件：${getLegalCaseLabel(archived.caseFile)}` : `Consultation archived to case: ${getLegalCaseLabel(archived.caseFile)}`);
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
    toast.success(lang === 'zh' ? '会议记录已暂停' : 'Meeting capture paused');
  }, [callState, endCall, lang]);

  const resumeMeetingCapture = useCallback(() => {
    meetingStartAttemptRef.current = 0;
    setMeetingPaused(false);
    if (operationMode !== 'meeting') setOperationMode('meeting');
    setMeetingNotesOpen(true);
    toast.success(lang === 'zh' ? '会议记录继续' : 'Meeting capture resumed');
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
      toast.info(lang === 'zh' ? '暂无会议笔记' : 'No meeting notes yet');
      return;
    }
    try {
      await navigator.clipboard.writeText(buildMeetingMarkdown());
      toast.success(lang === 'zh' ? '会议笔记已复制' : 'Meeting notes copied');
    } catch (err: any) {
      toast.error(err?.message || (lang === 'zh' ? '复制失败' : 'Failed to copy notes'));
    }
  }, [buildMeetingMarkdown, lang, meetingNotes.length]);

  const downloadMeetingNotes = useCallback(() => {
    if (meetingNotes.length === 0) {
      toast.info(lang === 'zh' ? '暂无会议笔记' : 'No meeting notes yet');
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
    toast.success(lang === 'zh' ? '会议笔记已导出' : 'Meeting notes exported');
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
    toast.success(lang === 'zh' ? '会议笔记已清空' : 'Meeting notes cleared');
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
        setOpenWindows([]);
        setFocusedWindow(null);
        setWindowOrder([]);
        setKnowledgeOpen(false);
        setChatOpen(false);
        setActiveTab('home');
        return;
      }
      if (detail?.tab) {
        if (detail.tab === 'org' && detail.sub) {
          queueOrganizationWorkspaceRoute(detail.sub, detail.articleId);
        }
        // Anyone can open the org tab — join/create/connect handled by OrgPortal
        setActiveTab(detail.tab);
      }
    };
    window.addEventListener('lumi:navigate', handler);
    return () => window.removeEventListener('lumi:navigate', handler);
  }, [setActiveTab]);

  // Listen for Memory Avatar Lab open request from AgentGenerator
  useEffect(() => {
    const handler = () => openMemoryAvatar();
    window.addEventListener('lumi:open-memory-lab', handler);
    return () => window.removeEventListener('lumi:open-memory-lab', handler);
  }, []);

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

    setIsWallpaperMode(enabled);
    void systemService.setWallpaperMode(enabled);

    if (enabled && options.timeoutMs) {
      wallpaperAutomationTimerRef.current = setTimeout(() => {
        if (!wallpaperWasEnabledBeforeAutomationRef.current) {
          setIsWallpaperMode(false);
          void systemService.setWallpaperMode(false);
        }
        wallpaperWasEnabledBeforeAutomationRef.current = false;
        wallpaperAutomationTimerRef.current = null;
        toast(t.wallpaperAutoRestored || 'Wallpaper mode restored after desktop control timeout', {
          icon: <Box className="text-white/40" />,
        });
      }, Math.max(15_000, options.timeoutMs));
    }

    if (!options.silent) {
      toast(enabled ? (t.wallpaperFusionActive || 'Wallpaper Fusion Active') : (t.standardFocusMode || 'Standard Desktop'), {
        icon: enabled ? <Sparkles className="text-celestial-saturn" /> : <Box className="text-white/40" />
      });
    }
  }, [t]);

  const toggleWallpaperMode = useCallback(() => {
    applyWallpaperMode(!isWallpaperMode);
  }, [applyWallpaperMode, isWallpaperMode]);

  const dismissWallpaperWorkPrompt = useCallback(() => {
    if (wallpaperWorkPromptTimerRef.current) {
      clearTimeout(wallpaperWorkPromptTimerRef.current);
      wallpaperWorkPromptTimerRef.current = null;
    }
    setWallpaperWorkPromptVisible(false);
  }, []);

  const showWallpaperWorkPrompt = useCallback(() => {
    if (isWallpaperModeRef.current || chatOpenRef.current) return;
    setWallpaperWorkPromptVisible(true);
    if (wallpaperWorkPromptTimerRef.current) {
      clearTimeout(wallpaperWorkPromptTimerRef.current);
    }
    wallpaperWorkPromptTimerRef.current = setTimeout(() => {
      setWallpaperWorkPromptVisible(false);
      wallpaperWorkPromptTimerRef.current = null;
    }, 14000);
  }, []);

  const enterWallpaperFromWorkPrompt = useCallback(() => {
    dismissWallpaperWorkPrompt();
    applyWallpaperMode(true);
  }, [applyWallpaperMode, dismissWallpaperWorkPrompt]);

  useEffect(() => {
    return () => {
      if (wallpaperWorkPromptTimerRef.current) {
        clearTimeout(wallpaperWorkPromptTimerRef.current);
        wallpaperWorkPromptTimerRef.current = null;
      }
    };
  }, []);

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
      setShowMcpPanel(true);
      setTimeout(() => {
        setMcpActivities(prev => {
          if (prev.length === 0 || Date.now() - prev[0].time > 8000) setShowMcpPanel(false);
          return prev;
        });
      }, 8000);
    };
    socket.on('mcp:activity', handler);
    return () => { socket.off('mcp:activity', handler); };
  }, [socket]);

  const upsertBackgroundWorkflowTask = useCallback((task: BackgroundWorkflowTask) => {
    if (!task?.id) return;
    setBackgroundWorkflowTasks(prev => {
      const existing = prev.findIndex(item => item.id === task.id);
      const nextTask = { ...prev[existing], ...task };
      const next = existing >= 0
        ? prev.map(item => item.id === task.id ? nextTask : item)
        : [nextTask, ...prev];
      return next.slice(0, 6);
    });

    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      window.setTimeout(() => {
        setBackgroundWorkflowTasks(prev => prev.filter(item => item.id !== task.id));
        backgroundTaskStatusRef.current.delete(task.id);
      }, 12000);
    }
  }, []);

  const cancelBackgroundWorkflowTask = useCallback((taskId: string) => {
    socket?.emit('agent:background_cancel', { taskId });
    setBackgroundWorkflowTasks(prev => prev.map(task =>
      task.id === taskId ? { ...task, status: 'cancelling' } : task
    ));
  }, [socket]);

  useEffect(() => {
    fetch('/api/autonomy/background-tasks', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!Array.isArray(data?.tasks)) return;
        data.tasks.slice(0, 6).forEach((task: BackgroundWorkflowTask) => upsertBackgroundWorkflowTask(task));
      })
      .catch(() => {});
  }, [upsertBackgroundWorkflowTask]);

  // Workflow status listener — agent:status, agent:tool_call, agent:response, agent:error
  useEffect(() => {
    if (!socket) return;

    const workflowStepId = (prefix: string, seed?: string) =>
      `${prefix}-${seed || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const onStatus = (data: { status: string; agentName?: string; phase?: string; detail?: string; source?: string }) => {
      if (data.status === 'thinking') {
        const isBackground = data.phase === 'background';
        if (isBackground && data.source !== 'chat') showWallpaperWorkPrompt();
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
        setAgentStatus('done');
        setWorkflowSteps(prev => [...prev, {
          id: workflowStepId('done'),
          type: 'response',
          text: t.workflowCompleted || 'Completed',
          time: Date.now(),
        }]);
        setTimeout(() => {
          setAgentStatus('idle');
          setWorkflowSteps([]);
        }, 5000);
      } else if (data.status === 'error') {
        setAgentStatus('error');
        setTimeout(() => {
          setAgentStatus('idle');
          setWorkflowSteps([]);
        }, 5000);
      }
    };

    const onToolCall = (data: { correlationId?: string; name: string; arguments?: any; args?: any; result?: string; error?: string; source?: string }) => {
      const toolArgs = data.arguments ?? data.args;
      const phase = data.error !== undefined ? 'error' : data.result !== undefined ? 'result' : 'start';
      if (data.correlationId) {
        const eventKey = `${data.correlationId}:${phase}`;
        if (seenWorkflowToolEvents.current.has(eventKey)) return;
        seenWorkflowToolEvents.current.add(eventKey);
      }
      if (data.source !== 'chat') showWallpaperWorkPrompt();
      if (data.result !== undefined) {
        setAgentStatus('executing');
        triggerPetReaction('jump', 1200);
        setWorkflowSteps(prev => [...prev, {
          id: `tool-ok-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'tool_result',
          text: `${data.name} ${t.workflowToolDone || 'done'}`,
          detail: data.result?.slice(0, 100),
          time: Date.now(),
        }]);
      } else if (data.error !== undefined) {
        setAgentStatus('executing');
        triggerPetReaction('failed', 2000);
        setWorkflowSteps(prev => [...prev, {
          id: `tool-err-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'error',
          text: `${data.name} ${t.workflowToolFailed || 'failed'}`,
          detail: data.error?.slice(0, 100),
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

    const onConfirmTool = (data: { correlationId: string; name: string; arguments?: any; source?: string }) => {
      console.warn(`[DesktopUI] Tool confirmation event suppressed without popup: ${data.name}`);
    };

    const onResponse = (data: { text: string; agentName?: string; source?: string; requestId?: string }) => {
      setWorkflowSteps(prev => [...prev, {
        id: workflowStepId('resp', data.requestId),
        type: 'response',
        text: t.workflowResponseReady || 'Response ready',
        detail: data.text?.slice(0, 100),
        time: Date.now(),
      }]);
    };

    const onError = (data: { message: string; source?: string; requestId?: string }) => {
      setAgentStatus('error');
      setWorkflowSteps(prev => [...prev, {
        id: workflowStepId('err', data.requestId),
        type: 'error',
        text: t.workflowError || 'Processing failed',
        detail: data.message,
        time: Date.now(),
      }]);
      setTimeout(() => {
        setAgentStatus('idle');
        setWorkflowSteps([]);
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

    const normalizeBackgroundTask = (data: any): BackgroundWorkflowTask | null => {
      const raw = data?.task || data;
      const id = String(raw?.id || data?.taskId || '');
      if (!id) return null;
      const workerNames = Array.isArray(raw?.workerNames)
        ? raw.workerNames
        : Array.isArray(raw?.workers)
          ? raw.workers.map((worker: any) => worker?.name || worker?.id).filter(Boolean)
          : [];
      return {
        id,
        title: raw?.title || data?.title || id,
        status: (raw?.status || 'queued') as BackgroundWorkflowTask['status'],
        workerNames,
        toolCallsCount: Number(raw?.toolCallsCount || 0),
        error: raw?.error,
        resultPreview: raw?.resultPreview,
        updatedAt: raw?.updatedAt,
      };
    };

    const recordBackgroundTaskStep = (task: BackgroundWorkflowTask) => {
      const previousStatus = backgroundTaskStatusRef.current.get(task.id);
      if (previousStatus === task.status) return;
      backgroundTaskStatusRef.current.set(task.id, task.status);
      const isActive = task.status === 'queued' || task.status === 'running' || task.status === 'cancelling';
      const isFailed = task.status === 'failed';
      setAgentStatus(isActive ? 'background' : isFailed ? 'error' : 'done');
      if (isActive) showWallpaperWorkPrompt();
      setWorkflowSteps(prev => [...prev, {
        id: `background-task-${task.id}-${task.status}-${Date.now()}`,
        type: isFailed ? 'error' : task.status === 'completed' ? 'response' : 'background',
        text: `${t.workflowBackgroundTask || 'Background task'}: ${task.status}`,
        detail: task.title || task.id,
        time: Date.now(),
      }]);
    };

    const onDelegation = (data: any) => {
      const task = normalizeBackgroundTask(data);
      if (!task) return;
      upsertBackgroundWorkflowTask(task);
      recordBackgroundTaskStep(task);
    };

    const onBackgroundTaskUpdate = (data: any) => {
      const task = normalizeBackgroundTask(data);
      if (!task) return;
      upsertBackgroundWorkflowTask(task);
      recordBackgroundTaskStep(task);
    };

    socket.on('agent:status', onStatus);
    socket.on('agent:delegation', onDelegation);
    socket.on('agent:background_task_update', onBackgroundTaskUpdate);
    socket.on('agent:tool_call', onToolCall);
    socket.on('agent:tool', onToolCall);
    socket.on('agent:confirm_tool', onConfirmTool);
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
        toast.info(lang === 'zh' ? '桌面形象已从另一设备同步' : 'Desktop avatar synced from another device');
      }
    };
    const onAgentPromoted = (data: { agentName: string; skillName?: string }) => {
      const msg = data.skillName
        ? `Agent "${data.agentName}" auto-promoted with skill "${data.skillName}"`
        : `Agent "${data.agentName}" has been auto-created`;
      addNotification({ type: 'system', title: 'Agent Promoted', message: msg });
      toast.info(msg, { duration: 5000 });
    };
    const onAgentNotification = (data: { type: string; level: string; message: string }) => {
      addNotification({ type: data.level === 'critical' ? 'warning' : data.level === 'warning' ? 'warning' : 'info', title: data.type || 'Lumi', message: data.message });
      if (data.level === 'critical') {
        toast.error(data.message, { duration: 10000 });
      } else if (data.level === 'warning') {
        toast.warning(data.message, { duration: 5000 });
      } else {
        toast(data.message, { duration: 5000 });
      }
    };

    const onWakeDetected = (data: { keyword: string }) => {
      addNotification({
        type: 'info',
        title: lang === 'zh' ? '唤醒词检测' : 'Wake Word Detected',
        message: lang === 'zh' ? `检测到唤醒词 "${data.keyword}"` : `Detected wake word "${data.keyword}"`,
      });
    };
    const onWakeError = (data: { message: string }) => {
      console.warn('[Wake] Error:', data.message);
    };
    const onWakeStarted = () => {
      addNotification({
        type: 'info',
        title: lang === 'zh' ? '语音唤醒' : 'Voice Wake',
        message: lang === 'zh' ? '语音唤醒服务已启动' : 'Voice wake service started',
      });
    };

    const onTokenUsageUpdate = (_data: { totalTokens: number; provider: string }) => {
      // Token usage updated — TokenDashboard handles REST polling, this is real-time supplement
    };
    const onTokenQuotaUpdate = (data: { used: number; cap: number; remaining: number }) => {
      const pct = data.used / data.cap;
      if (pct >= 0.9) {
        addNotification({
          type: 'warning',
          title: lang === 'zh' ? 'Token 配额告警' : 'Token Quota Alert',
          message: lang === 'zh'
            ? `已使用 ${Math.round(pct * 100)}%（${data.used.toLocaleString()} / ${data.cap.toLocaleString()}）`
            : `${Math.round(pct * 100)}% used (${data.used.toLocaleString()} / ${data.cap.toLocaleString()})`,
        });
      }
    };

    socket.on('preferences:changed', onPreferencesChanged);
    socket.on('agent:promoted', onAgentPromoted);
    socket.on('agent:notification', onAgentNotification);
    socket.on('wake:detected', onWakeDetected);
    socket.on('wake:error', onWakeError);
    socket.on('wake:started', onWakeStarted);
    socket.on('token:usage_update', onTokenUsageUpdate);
    socket.on('token:quota_update', onTokenQuotaUpdate);

    return () => {
      socket.off('agent:status', onStatus);
      socket.off('agent:delegation', onDelegation);
      socket.off('agent:background_task_update', onBackgroundTaskUpdate);
      socket.off('agent:tool_call', onToolCall);
      socket.off('agent:tool', onToolCall);
      socket.off('agent:confirm_tool', onConfirmTool);
      socket.off('agent:response', onResponse);
      socket.off('agent:error', onError);
      socket.off('agent:proactive', onProactive);
      socket.off('preferences:changed', onPreferencesChanged);
      socket.off('agent:promoted', onAgentPromoted);
      socket.off('agent:notification', onAgentNotification);
      socket.off('wake:detected', onWakeDetected);
      socket.off('wake:error', onWakeError);
      socket.off('wake:started', onWakeStarted);
      socket.off('token:usage_update', onTokenUsageUpdate);
      socket.off('token:quota_update', onTokenQuotaUpdate);
    };
  }, [socket, workDomain, orgConnection?.orgId, petStorageKeys]);

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
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
        setIsControlCenterOpen(false);
        if (isWallpaperMode) toggleWallpaperMode();
        return;
      }
      if (e.key === ' ' && !e.repeat) {
        if (isInputFocused()) return;
        if (runtimeLogOpenRef.current || isSearchOpen || isControlCenterOpen) return;
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
  }, [endCall, getVoiceScopeOptions, interrupt, isControlCenterOpen, isSearchOpen, isWallpaperMode, selectedVoiceId, startCall, toggleWallpaperMode]);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSelectPet = (pet: PetConfig) => {
    if (!canCustomizeLumiAppearance) {
      toast.error(lang === 'zh' ? '只有组织所有者或管理员可以修改组织工作域形象' : 'Only an organization owner or administrator can change the organization workspace appearance');
      return;
    }
    setSelectedPet(pet);
    savePetPrefsToServer(pet, equippedAccessories);
    toast.info(`${pet.name} ${t.avatarSetAsDesktop || 'set as desktop avatar'}`);
  };

  const openMemoryAvatar = async () => {
    try { sounds.playClick(); } catch {}
    try {
      const res = await fetch('/api/agents/sanctuaries');
      if (res.ok) {
        const data = await res.json();
        if (data.agents && data.agents.length > 0) {
          setSanctuaryAgent(data.agents[0]);
          setSanctuaryOpen(true);
          return;
        }
      }
    } catch {}
    setMemoryLabOpen(true);
  };

  const toggleWindow = (tab: string) => {
    try { sounds.playClick(); } catch {}
    if (tab === 'home') {
      setOpenWindows([]);
      setFocusedWindow(null);
      setActiveTab('home');
      return;
    }
    if (tab === 'org') {
      setActiveTab('org');
      return;
    }
    if (tab === 'memory') {
      setKnowledgeOpen(true);
      setActiveTab('knowledge');
      return;
    }
    if (tab === 'sync') {
      tab = 'devices';
    }
    if (tab === 'notifications') {
      setIsNotificationPanelOpen(prev => !prev);
      setOpenWindows(prev => prev.filter(w => w !== 'notifications'));
      setMinimizedWindows(prev => prev.filter(w => w !== 'notifications'));
      setWindowOrder(prev => prev.filter(w => w !== 'notifications'));
      if (focusedWindow === 'notifications') setFocusedWindow(null);
      return;
    }

    // Knowledge base and Chat open fullscreen, not as windows
    if (tab === 'knowledge') {
      setKnowledgeOpen(prev => !prev);
      return;
    }
    if (tab === 'chat') {
      setChatOpen(prev => !prev);
      setActiveTab(tab);
      return;
    }
    if (tab === 'memory-avatar') {
      openMemoryAvatar();
      return;
    }
    if (tab === 'avatar-studio') {
      // Opens as a normal window below
    }

    if (openWindows.includes(tab)) {
      if (minimizedWindows.includes(tab)) {
        setMinimizedWindows(prev => prev.filter(w => w !== tab));
      }
      setFocusedWindow(tab);
      setWindowOrder(prev => [...prev.filter(w => w !== tab), tab]);
    } else {
      setOpenWindows([...openWindows, tab]);
      setFocusedWindow(tab);
      setWindowOrder(prev => [...prev, tab]);
    }
    setActiveTab(tab);
  };

  const closeWindow = (tab: string) => {
    try { sounds.playClick(); } catch {}
    const nextWindows = openWindows.filter(w => w !== tab);
    setOpenWindows(nextWindows);
    setMinimizedWindows(prev => prev.filter(w => w !== tab));
    setWindowOrder(prev => prev.filter(w => w !== tab));
    if (focusedWindow === tab) {
      setFocusedWindow(nextWindows.length > 0 ? nextWindows[nextWindows.length - 1] : null);
      if (nextWindows.length === 0) setActiveTab('home');
    }
  };

  const applyDesktopWidgetFallback = async () => {
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
  };

  const restoreDesktopWidgetFallback = async () => {
    const fallback = desktopWidgetFallbackRef.current;
    desktopWidgetFallbackRef.current = null;
    const windowApi = await import('@tauri-apps/api/window');
    const appWindow = windowApi.getCurrentWindow();

    await appWindow.show().catch(() => {});
    await appWindow.setAlwaysOnTop(false).catch(() => {});
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
  };

  const enterDesktopWidgetMode = async () => {
    try { sounds.playClick(); } catch {}
    setIsControlCenterOpen(false);
    setIsNotificationPanelOpen(false);
    setIsSearchOpen(false);
    setChatOpen(false);
    setKnowledgeOpen(false);
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
          lang === 'zh'
            ? `无法进入桌面小组件：${fallbackMessage || nativeMessage || '窗口控制失败'}`
            : `Failed to enter widget mode: ${fallbackMessage || nativeMessage || 'window control failed'}`
        );
      }
    }
  };

  const exitDesktopWidgetMode = async (nextSurface?: string) => {
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
          toast.error(fallbackErr?.message || err?.message || (lang === 'zh' ? '无法展开 Lumi' : 'Failed to expand Lumi'));
        }
      }
    }
    if (nextSurface) {
      window.setTimeout(() => toggleWindow(nextSurface), 120);
    }
  };

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
        if (value === 'music') return 'music-center';
        if (value === 'memory') return 'knowledge';
        if (value === 'files') return 'knowledge';
        if (value === 'sync') return 'devices';
        if (value === 'world' || value === 'nexus' || value === 'nexus-view' || value === 'cloud-canvas') return 'nexus';
        return value;
      };

        const openSurface = (value: string) => {
          const windowId = normalizeTarget(value);
          if (!windowId) throw new Error('Client action requires a target surface');
        if (isDesktopWidgetMode) {
          void exitDesktopWidgetMode(windowId);
          return;
        }

        if (windowId === 'home') {
          setOpenWindows([]);
          setMinimizedWindows([]);
          setFocusedWindow(null);
          setWindowOrder([]);
          setKnowledgeOpen(false);
          setChatOpen(false);
          setIsNotificationPanelOpen(false);
          setViewMode('personal');
          setActiveTab('home');
          return;
        }
        if (windowId === 'nexus') {
          setViewMode('world');
          setActiveTab('home');
          return;
        }
        if (windowId === 'org') {
          setActiveTab('org');
          return;
        }
        if (windowId === 'knowledge') {
          setKnowledgeOpen(true);
          setActiveTab('knowledge');
          return;
        }
        if (windowId === 'chat') {
          setChatOpen(true);
          setActiveTab('chat');
          return;
        }
        if (windowId === 'notifications') {
          setIsNotificationPanelOpen(true);
          setOpenWindows(prev => prev.filter(w => w !== 'notifications'));
          setMinimizedWindows(prev => prev.filter(w => w !== 'notifications'));
          setWindowOrder(prev => prev.filter(w => w !== 'notifications'));
          if (focusedWindow === 'notifications') setFocusedWindow(null);
          return;
        }
        if (windowId === 'memory-avatar') {
          void openMemoryAvatar();
          return;
        }
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
        if (!windowId) throw new Error('close_app requires target');
        if (windowId === 'knowledge') {
          setKnowledgeOpen(false);
          return;
        }
        if (windowId === 'chat') {
          setChatOpen(false);
          return;
        }
        if (windowId === 'nexus') {
          setViewMode('personal');
          return;
        }
        if (windowId === 'notifications') {
          setIsNotificationPanelOpen(false);
          return;
        }
        if (windowId === 'org' && activeTab === 'org') {
          setActiveTab('home');
          return;
        }
        closeWindow(windowId);
      };

      const setClientMode = (value: string) => {
        if (value === 'music') {
          openSurface('music-center');
          return;
        }
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

      try {
        if (action === 'refresh_client_state') {
          window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
          respond({ ok: true, action, mode: operationMode, activeTab, openWindows, widgetMode: isDesktopWidgetMode });
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
        if (action === 'open_app') {
          if (isDesktopWidgetMode) void exitDesktopWidgetMode(target);
          else openSurface(target);
          respond({ ok: true, action, target });
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
        if (action === 'customer_takeover_panel' || action === 'demo_customer_takeover') {
          const stage = String(detail.stage || target || 'intake') as CustomerTakeoverStage;
          const allowedStages: CustomerTakeoverStage[] = ['intake', 'rules', 'wechat', 'result'];
          if (!allowedStages.includes(stage)) throw new Error(`Unsupported customer takeover stage: ${stage}`);
          setCustomerTakeoverBrief(normalizeCustomerTakeoverBrief(detail.brief || detail.customerBrief || detail.payload));
          setCustomerTakeoverStage(stage);
          setDesignDeliveryStage(null);
          setEcommerceGrowthStage(null);
          respond({ ok: true, action, stage });
          return;
        }
        if (action === 'close_customer_takeover_panel' || action === 'demo_close_customer_takeover') {
          setCustomerTakeoverStage(null);
          setCustomerTakeoverBrief(DEFAULT_CUSTOMER_TAKEOVER_BRIEF);
          respond({ ok: true, action });
          return;
        }
        if (action === 'design_delivery_panel' || action === 'demo_design_delivery') {
          const stage = String(detail.stage || target || 'intake') as DesignDeliveryStage;
          const allowedStages: DesignDeliveryStage[] = ['intake', 'concept', 'cad', 'revit', 'handoff', 'result'];
          if (!allowedStages.includes(stage)) throw new Error(`Unsupported design delivery stage: ${stage}`);
          setDesignDeliveryStage(stage);
          setCustomerTakeoverStage(null);
          setEcommerceGrowthStage(null);
          respond({ ok: true, action, stage });
          return;
        }
        if (action === 'close_design_delivery_panel' || action === 'demo_close_design_delivery') {
          setDesignDeliveryStage(null);
          respond({ ok: true, action });
          return;
        }
        if (action === 'ecommerce_growth_panel' || action === 'demo_ecommerce_growth') {
          const stage = String(detail.stage || target || 'intake') as EcommerceGrowthStage;
          const allowedStages: EcommerceGrowthStage[] = ['intake', 'diagnosis', 'content', 'tools', 'publish', 'result'];
          if (!allowedStages.includes(stage)) throw new Error(`Unsupported ecommerce growth stage: ${stage}`);
          setEcommerceGrowthStage(stage);
          setCustomerTakeoverStage(null);
          setDesignDeliveryStage(null);
          respond({ ok: true, action, stage });
          return;
        }
        if (action === 'close_ecommerce_growth_panel' || action === 'demo_close_ecommerce_growth') {
          setEcommerceGrowthStage(null);
          respond({ ok: true, action });
          return;
        }
        if (action === 'close_app') {
          closeSurface(target);
          respond({ ok: true, action, target });
          return;
        }
        if (action === 'set_mode' || action === 'set_client_mode') {
          setClientMode(mode);
          respond({ ok: true, action, mode });
          return;
        }
        if (action === 'focus_home') {
          openSurface('home');
          respond({ ok: true, action });
          return;
        }
        if (action === 'open_nexus') {
          setViewMode('world');
          setActiveTab('home');
          respond({ ok: true, action, target: 'nexus', viewMode: 'world' });
          return;
        }
        if (action === 'close_nexus') {
          setViewMode('personal');
          respond({ ok: true, action, target: 'nexus', viewMode: 'personal' });
          return;
        }
        if (action === 'open_music_center') {
          openSurface('music-center');
          respond({ ok: true, action, target: 'music-center', mode: operationMode });
          return;
        }
        if (action === 'show_music_layer' || action === 'hide_music_layer') {
          if (action === 'show_music_layer') {
            if (!musicSnapshot.track) {
              openSurface('music-center');
              respond({ ok: false, action, mode: operationMode, reason: 'music_track_required', target: 'music-center' });
              return;
            }
          }
          setMusicLayerVisible(action === 'show_music_layer');
          respond({ ok: true, action, mode: operationMode });
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
        if (action === 'open_runtime_log') {
          openSurface('runtime-log');
          respond({ ok: true, action, target: 'runtime-log' });
          return;
        }
        if (action === 'show_knowledge_base') {
          openSurface('knowledge');
          respond({ ok: true, action, target: 'knowledge' });
          return;
        }
        if (action === 'open_organization_workspace') {
          const requestedView = normalizeOrganizationWorkspaceView(section || (target !== 'org' ? target : '') || 'dashboard');
          if (!requestedView) throw new Error(`Unknown organization workspace section: ${section || target}`);
          if (orgConnection?.connected && !canAccessOrganizationWorkspaceView(orgConnection?.orgRole, requestedView)) {
            respond({
              ok: false,
              action,
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
                action,
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
            action,
            target: 'org',
            section: requestedView,
            domain: orgConnection?.connected ? 'work' : workDomain,
          });
          return;
        }
        if (action === 'open_files') {
          openSurface('knowledge');
          respond({ ok: true, action, target: 'knowledge' });
          return;
        }
        if (action === 'open_settings') {
          if (section === 'computer') {
            openSurface('kernel');
            respond({ ok: true, action, target: 'kernel' });
            return;
          }
          if (section) setSettingsSection(section);
          openSurface('settings');
          respond({ ok: true, action, target: 'settings', section });
          return;
        }
        if (action === 'open_computer_adaptation') {
          openSurface('kernel');
          respond({ ok: true, action, target: 'kernel' });
          return;
        }
        if (action === 'open_plans' || action === 'open_work_queue') {
          openSurface('plans');
          respond({ ok: true, action, target: 'plans' });
          return;
        }
        if (action === 'open_subscription' || action === 'open_activation' || action === 'open_billing') {
          openSurface('subscription');
          respond({ ok: true, action, target: 'subscription' });
          return;
        }
        if (action === 'open_avatar_studio') {
          openSurface('avatar-studio');
          respond({ ok: true, action, target: 'avatar-studio' });
          return;
        }
        if (action === 'open_sound_studio') {
          openSurface('sound');
          respond({ ok: true, action, target: 'sound' });
          return;
        }
        if (action === 'open_memory_avatar') {
          openSurface('memory-avatar');
          respond({ ok: true, action, target: 'memory-avatar' });
          return;
        }
        if (action === 'open_skills' || action === 'open_tools' || action === 'open_team' || action === 'open_chat') {
          const mapped = action === 'open_skills'
            ? 'skills'
            : action === 'open_tools'
              ? 'tools'
              : action === 'open_team'
                ? 'team'
                : 'chat';
          openSurface(mapped);
          respond({ ok: true, action, target: mapped });
          return;
        }
        if (action === 'set_wallpaper_mode') {
          const enabled = Boolean(detail.enabled);
          if (enabled && !confirmed) throw new Error('set_wallpaper_mode requires explicit user confirmation');
          applyWallpaperMode(enabled);
          respond({ ok: true, action, enabled });
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
    closeWindow,
    endMeetingAndReport,
    musicSnapshot.track,
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
        musicSnapshot.lastError ? { source: 'music', message: musicSnapshot.lastError, at: Date.now() } : null,
        clientRuntime.lastError ? { source: 'runtime', message: clientRuntime.lastError, at: Date.now() } : null,
      ].filter(Boolean);

      socket.emit('client:state', {
        platform: isTauri ? 'desktop' : 'web',
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
        windows: {
          open: openWindows,
          focused: focusedWindow,
          minimized: minimizedWindows,
        },
        surfaces: {
          knowledgeOpen,
          chatOpen,
          runtimeLogOpen: openWindows.includes('runtime-log'),
          meetingOpen: meetingNotesOpen,
          musicLayerVisible: musicVisible,
          wallpaperMode: isWallpaperMode,
          widgetMode: isDesktopWidgetMode,
          nexusOpen: viewMode === 'world',
          customerTakeoverOpen: Boolean(customerTakeoverStage),
          customerTakeoverStage,
          designDeliveryOpen: Boolean(designDeliveryStage),
          designDeliveryStage,
          ecommerceGrowthOpen: Boolean(ecommerceGrowthStage),
          ecommerceGrowthStage,
        },
        voice: {
          state: callState,
          muted: isMuted,
        },
        music: {
          visible: musicSnapshot.visible,
          isPlaying: musicSnapshot.isPlaying,
          trackName: musicSnapshot.track?.name || '',
          artists: musicSnapshot.track?.artists || [],
          album: musicSnapshot.track?.album || '',
          source: musicSnapshot.source,
          progress: musicSnapshot.progress,
          duration: musicSnapshot.duration,
          volume: musicSnapshot.volume,
          mood: musicSnapshot.mood,
          hasLyrics: musicSnapshot.lyrics.length > 0,
          layerVisible: musicVisible,
          lastError: musicSnapshot.lastError || '',
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
          open: openWindows.includes('runtime-log'),
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
    clientPermissions,
    clientRuntime,
    callError,
    customerTakeoverStage,
    designDeliveryStage,
    ecommerceGrowthStage,
    focusedWindow,
    agentStatus,
    isMuted,
    isTauri,
    isDesktopWidgetMode,
    isWallpaperMode,
    knowledgeOpen,
    mcpActivities.length,
    meetingNotes.length,
    meetingNotesOpen,
    meetingReport,
    meetingReportGenerating,
    meetingStartedAt,
    minimizedWindows,
    musicSnapshot,
    musicVisible,
    openWindows,
    operationMode,
    orgConnection?.connected,
    orgConnection?.orgId,
    orgConnection?.orgName,
    orgConnection?.orgRole,
    organizationWorkspaceView,
    reportedKnowledgeRuntimeState,
    socket,
    viewMode,
    workDomain,
    workflowSteps,
  ]);

  const appIcons = [
    { id: 'chat', label: t.chat || 'Chat', icon: <MessageSquare size={24} />, color: 'from-green-500 to-emerald-600' },
    { id: 'personality', label: t.personality || 'Personality Lab', icon: <UserIcon size={24} />, color: 'from-violet-500 to-fuchsia-600' },
    { id: 'kernel', label: t.kernelMonitor || 'Kernel Monitor', icon: <Activity size={24} />, color: 'from-orange-500 to-red-600' },
    { id: 'devices', label: t.devices || 'Devices', icon: <Cpu size={24} />, color: 'from-blue-600 to-cyan-400' },
    { id: 'settings', label: t.settings || 'OS Integrity', icon: <SettingsIcon size={24} />, color: 'from-gray-400 to-slate-600' },
  ];

  const desktopAppEntries = desktopIcons.map(def => ({
    id: def.windowId,
    label: (t as any)[def.labelKey] || def.labelKey,
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
    { id: 'plans', label: t.learningPlans || (lang === 'zh' ? '学习计划' : 'Learning Plans'), icon: <Calendar size={24} />, color: 'from-celestial-saturn to-orange-600' },
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
    if (windowId === 'music') return { w: '1050px', h: '720px' };
    if (windowId === 'music-center') return { w: '800px', h: '600px' };
    if (windowId === 'tools') return { w: '850px', h: '620px' };
    if (windowId === 'team') return { w: '900px', h: '700px' };
    if (windowId === 'github-mcp') return { w: '850px', h: '620px' };
    if (windowId === 'notifications') return { w: '700px', h: '550px' };
    if (windowId === 'reminders') return { w: '650px', h: '620px' };
    if (windowId === 'plans') return { w: '980px', h: '700px' };
    if (windowId === 'devices') return { w: '900px', h: '700px' };
    if (windowId === 'tokens') return { w: '800px', h: '620px' };
    if (windowId === 'skills') return { w: '900px', h: '700px' };
    if (windowId === 'subscription') return { w: '850px', h: '640px' };
    if (windowId === 'avatar-studio') return { w: '1050px', h: '720px' };
    if (windowId === 'sound') return { w: '900px', h: '700px' };
    if (windowId === 'terminal') return { w: '900px', h: '600px' };
    if (windowId === 'runtime-log') return { w: '980px', h: '680px' };
    return { w: '900px', h: '700px' };
  };
  const dockApps = [
    ...appIcons,
    ...openWindows
      .filter(windowId => !appIcons.some(app => app.id === windowId))
      .map(getWindowMeta),
  ];
  const operationModeOptions = [
    {
      id: 'meeting' as const,
      label: t.modeMeeting || (lang === 'zh' ? '会议' : 'Meeting'),
      title: t.modeMeetingTitle || (lang === 'zh' ? '会议模式' : 'Meeting mode'),
      description: t.modeMeetingDesc || (lang === 'zh' ? '自动开启语音转文字，收录会议笔记；结束后整理纪要、分析和报告。' : 'Starts speech-to-text, records meeting notes, then produces a summary, analysis, and report when ended.'),
      hint: t.modeMeetingHint || (lang === 'zh' ? '会议记录' : 'Live notes'),
      icon: <FileText size={16} />,
    },
    {
      id: 'chat' as const,
      label: t.modeChat || (lang === 'zh' ? '聊天' : 'Chat'),
      title: t.modeChatTitle || (lang === 'zh' ? '聊天模式' : 'Chat mode'),
      description: t.modeChatDesc || (lang === 'zh' ? '纯聊天，只回答、解释和讨论；不调用工具、不控制桌面、不打开外部软件。' : 'Pure conversation: answers and discussion only; no tools, desktop control, or external apps.'),
      hint: t.modeChatHint || (lang === 'zh' ? '纯聊天' : 'Conversation only'),
      icon: <MessageSquare size={16} />,
    },
    {
      id: 'assistant' as const,
      label: t.modeAssistant || (lang === 'zh' ? '助手' : 'Assistant'),
      title: t.modeAssistantTitle || (lang === 'zh' ? '助手模式' : 'Assistant mode'),
      description: t.modeAssistantDesc || (lang === 'zh' ? '人在场的全权限助理：可用工具、浏览器、文件、桌面和外部软件执行普通任务，少弹权限确认。' : 'User-present full-permission helper: tools, browser, files, desktop, and external apps with minimal permission prompts.'),
      hint: t.modeAssistantHint || (lang === 'zh' ? '现场全权限' : 'Foreground full access'),
      icon: <Sparkles size={16} />,
    },
    {
      id: 'autonomous' as const,
      label: t.modeAutonomy || t.modeAutoExecute || (lang === 'zh' ? '自主' : 'Autonomy'),
      title: t.modeAutonomyTitle || t.modeAutoExecuteTitle || (lang === 'zh' ? '自主模式' : 'Autonomy mode'),
      description: t.modeAutonomyDesc || t.modeAutoExecuteDesc || (lang === 'zh' ? '和助理模式同权限，但可以 24 小时自主运行、监控、整理吸收、学习和推进超长任务。' : 'Same permissions as Assistant, plus 24h autonomous running, monitoring, absorption, learning, and ultra-long task continuation.'),
      hint: t.modeAutonomyHint || t.modeAutoExecuteHint || (lang === 'zh' ? '24h 自主运行' : '24h autonomous work'),
      icon: <Zap size={16} />,
    },
  ];
  const pendingOperationModeOption = pendingOperationMode
    ? operationModeOptions.find(m => m.id === pendingOperationMode)
    : null;
  const workflowHasExecution = workflowSteps.some(step =>
    step.type === 'background' ||
    step.type === 'confirmation' ||
    step.type === 'tool_start' ||
    step.type === 'tool_result' ||
    step.type === 'error'
  );
  const workflowPanelVisible =
    !chatOpen && (
      agentStatus !== 'idle' ||
      workflowSteps.length > 0 ||
      workflowHasExecution ||
      backgroundWorkflowTasks.length > 0
    );

  const tutorialLabel = t.showTutorial || (lang === 'zh' ? '教程' : 'Tutorial');

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
        onOpenKnowledge={() => void exitDesktopWidgetMode('knowledge')}
        onOpenAvatarStudio={() => void exitDesktopWidgetMode('avatar-studio')}
      />
    );
  }

  return (
    <div
      data-theme-scope="shell"
      data-appearance={resolvedAppearanceMode}
      data-view-mode={viewMode}
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
                onClick={() => setViewMode('personal')}
                className="lumi-ink-return-button group px-10 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs font-black text-white/60 tracking-[0.4em] uppercase transition-all backdrop-blur-2xl hover:text-white hover:border-white/20"
              >
                {t.focusPersonalTerritory || 'Focus Personal Territory'}
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
          data-theme-scope={viewMode === 'world' ? 'dark' : undefined}
          className={`absolute top-0 inset-x-0 h-10 glass-dark border-b border-white/5 flex items-center px-6 pointer-events-auto backdrop-blur-md transition-all duration-1000 ${isWallpaperMode || musicVisible ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        >
          <div className="flex items-center gap-6 flex-1">
            <button data-lumi-target="home" onClick={() => toggleWindow('home')} className="flex items-center gap-2 group transition-all">
               <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-celestial-mars to-celestial-saturn flex items-center justify-center p-1 group-hover:rotate-12 transition-transform shadow-lg shadow-celestial-saturn/20">
                 <Rocket size={14} className="text-white" />
               </div>
               <span className="text-xs font-black tracking-widest uppercase text-white/60">{t.lumiOS || 'Lumi OS'}</span>
            </button>
            <div className="h-4 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowOnboarding(true)}
                className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-black uppercase tracking-widest text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                title={tutorialLabel}
              >
                <Sparkles size={12} />
                {tutorialLabel}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center">
            <WorkModeSwitch
              domain={workDomain}
              onSelectDomain={switchDomain}
              connected={orgConnection?.connected ?? false}
              organizationOpen={activeTab === 'org'}
              onOpenOrganization={() => setActiveTab('org')}
              onCloseOrganization={() => {
                if (activeTab === 'org') setActiveTab('home');
              }}
            />
          </div>

          <div className="flex items-center gap-6 flex-1 justify-end">
            <div className="flex items-center gap-4 text-white/55">
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
                  title={socket?.connected ? (lang === 'zh' ? '服务已连接' : 'Service connected') : (lang === 'zh' ? '服务未连接' : 'Service disconnected')}
               />
               {/* Volume mute toggle */}
                <button onClick={toggleMute} className="flex items-center gap-1 hover:text-white transition-colors" title={isMuted ? (lang === 'zh' ? '取消静音' : 'Unmute') : (lang === 'zh' ? '静音' : 'Mute')}>
                 {isMuted ? <VolumeX size={14} className="text-red-400" /> : <Volume2 size={14} />}
               </button>
               {/* Battery — real via navigator.getBattery() */}
                <BatteryIndicator lang={lang} />
               <button
                 onClick={toggleWallpaperMode}
                 className={`h-6 px-2 rounded-md border transition-all flex items-center gap-1 text-[12px] font-bold uppercase tracking-wider ${
                   isWallpaperMode
                     ? 'bg-celestial-saturn/20 text-celestial-saturn border-celestial-saturn/30'
                     : 'bg-white/5 border-white/5 text-white/55 hover:bg-white/10 hover:text-white'
                 }`}
                  title={isWallpaperMode ? (lang === 'zh' ? '退出壁纸模式' : 'Exit wallpaper mode') : (lang === 'zh' ? '壁纸模式' : 'Wallpaper mode')}
               >
                 <Zap size={10} className={isWallpaperMode ? 'animate-pulse' : ''} />
                 {isWallpaperMode ? 'Fusion' : (lang === 'zh' ? '壁纸' : 'Wallpaper')}
               </button>
            </div>

            <button
              onClick={() => setIsControlCenterOpen(!isControlCenterOpen)}
              className="flex items-center gap-3 px-3 py-1 bg-white/5 hover:bg-white/10 rounded-full border border-white/5 transition-all group"
            >
              <div className="flex flex-col items-end">
                <span className="text-[12px] font-black text-white/80 leading-none">{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-xs font-bold text-white/55 uppercase tracking-tighter">{time.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              </div>
              <Activity size={14} className="text-celestial-saturn group-hover:rotate-180 transition-transform duration-500" />
            </button>

            {/* Window Controls */}
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => void enterDesktopWidgetMode()}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={lang === 'zh' ? '收起为桌面小组件' : 'Desktop widget'}
              >
                <Minimize2 size={14} />
              </button>
              <button
                onClick={handleWindowMinimize}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={lang === 'zh' ? '最小化' : 'Minimize'}
              >
                <Minus size={14} />
              </button>
              <button
                onClick={handleWindowMaximize}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={lang === 'zh' ? '最大化' : 'Maximize'}
              >
                <Square size={12} />
              </button>
              <button
                onClick={handleWindowClose}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-red-500/80 transition-colors"
                title={lang === 'zh' ? '关闭' : 'Close'}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {isNotificationPanelOpen && !isWallpaperMode && !musicVisible && (
            <>
              <motion.button
                type="button"
                aria-label={lang === 'zh' ? '关闭通知' : 'Close notifications'}
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
          className={`lumi-dock absolute bottom-6 left-1/2 -translate-x-1/2 z-50 h-16 px-4 glass-dark rounded-[2.5rem] border border-white/10 flex items-center gap-2 shadow-2xl backdrop-blur-2xl transition-all duration-1000 ${isWallpaperMode || musicVisible ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'}`}
        >
          <button 
            onClick={() => setViewMode(viewMode === 'personal' ? 'world' : 'personal')}
            className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
              viewMode === 'world' ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            {viewMode === 'world' ? <Cpu size={24} /> : <Globe size={24} />}
            <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/80 rounded-lg text-xs font-black uppercase text-white opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              {viewMode === 'world' ? (t.personalView || 'Personal View') : (t.nexusView || 'Nexus View')}
            </div>
          </button>
          <button
            data-lumi-target="knowledge"
            onClick={() => setKnowledgeOpen(prev => !prev)}
            className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
              knowledgeOpen
                ? 'bg-gradient-to-br from-cyan-400 to-blue-600 text-white shadow-lg'
                : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white'
            }`}
          >
            <BrainCircuit size={24} />
            <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/80 rounded-lg text-xs font-black uppercase text-white opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              {t.knowledgeBase || 'Knowledge Base'}
            </div>
          </button>
          <div className="h-8 w-px bg-white/10 mx-2" />
          <AnimatePresence>
            {dockApps.map(app => {
              const isActive = openWindows.includes(app.id) || (app.id === 'chat' && chatOpen);
              return (
              <motion.button
                key={app.id}
                data-lumi-target={app.id}
                layoutId={`dock-${app.id}`}
                onClick={() => toggleWindow(app.id)}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
                  isActive
                    ? `bg-gradient-to-br ${app.id === focusedWindow || app.id === 'chat' ? app.color : 'from-white/10 to-white/5'} text-white shadow-lg ${minimizedWindows.includes(app.id) ? 'opacity-40 translate-y-2' : ''}`
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
          <div className="h-8 w-px bg-white/10 mx-2" />
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
        className={`absolute inset-0 z-[15] flex flex-col ${viewMode === 'world' ? 'pointer-events-none' : ''}`}
      >
        <div className="relative w-full h-full pointer-events-auto">
          {/* Central Interactive Entity — hidden when music layer is active */}
          <div className={`absolute inset-0 flex items-center justify-center z-[15] pointer-events-none ${musicVisible ? 'opacity-0 pointer-events-none' : ''}`}>
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 2, ease: "easeOut" }}
          className="relative pointer-events-auto scale-[0.82] opacity-95 transition-all"
        >
          <div className="lumi-core-shell relative flex flex-col items-center">
            {selectedPet ? (
              <div className="relative group flex flex-col items-center gap-3">
                <button
                  onClick={() => toggleWindow('avatar-studio')}
                  className={`cursor-pointer transition-all ${callState !== 'idle' ? 'animate-pulse' : ''}`}
                  title={lang === 'zh' ? `${selectedPet.name} - 点击打开形象设计室` : `${selectedPet.name} - open Avatar Studio`}
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
                      toast.error(lang === 'zh' ? '只有组织所有者或管理员可以修改组织工作域形象' : 'Only an organization owner or administrator can change the organization workspace appearance');
                      return;
                    }
                    setSelectedPet(null);
                    savePetPrefsToServer(null, equippedAccessories);
                    toast.info(lang === 'zh' ? '已切换回粒子人脸' : 'Switched back to particle face');
                  }}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-white/10 border border-white/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/30 hover:border-red-500/40"
                  title={lang === 'zh' ? '切换回粒子人脸' : 'Switch back to particle face'}
                >
                  <X size={10} className="text-white/60" />
                </button>
              </div>
            ) : (
              <>
              {/* Biometrics presence indicator — above particle sphere */}
            {workDomain === 'personal' && (
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 z-30">
                <PresenceIndicator
                  status={presence.status}
                  faceConfidence={faceRecognition.result.confidence}
                  voiceConfidence={voiceprint.result.confidence}
                />
              </div>
            )}
            <LocalAgentSphere
                t={t}
                sentiment={sphereSentiment}
                callState={callState}
                audioLevel={audioLevel}
                highPerformance={isTauri}
                isWallpaperMode={isWallpaperMode}
                reaction={petReaction?.animation || null}
                onStartCall={startStandardVoiceCall}
                onEndCall={endVoiceCallFromUI}
                onInterrupt={interrupt}
                onToggleMute={toggleMute}
                onMessage={() => {}}
                facePresent={faceRecognition.result.facePresent}
                gesturesDisabled={false}
                isLightMode={resolvedAppearanceMode === 'light'}
              />
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
                  {lang === 'zh' ? '正在监听 "Lumi"' : 'Listening for "Lumi"'}
                </div>
              )}
              {wakeEnabled && wakeWord.error && (
                <div className="mt-2 text-xs text-red-400/60 font-mono max-w-[200px] text-center leading-relaxed">
                  Wake: {wakeWord.error}
                </div>
              )}
              {wakeEnabled && !wakeWord.isListening && !wakeWord.error && callState === 'idle' && (
                <div className="mt-2 text-xs text-yellow-400/40 font-mono">
                  {lang === 'zh' ? '唤醒词初始化中...' : 'Wake word initializing...'}
                </div>
              )}
              {!wakeEnabled && callState === 'idle' && (
                <div className="mt-2 text-xs text-white/30 font-mono">
                  {lang === 'zh' ? '唤醒词未开启' : 'Wake word off'}
                </div>
              )}
              </>
            )}

            <div className={`flex flex-col items-center gap-4 mt-8 transition-all duration-1000 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}>
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
      <div className={`relative z-10 w-full h-full overflow-y-auto custom-scrollbar px-3 pb-24 pt-14 transition-all duration-1000 sm:px-6 sm:pt-16 md:p-12 md:pt-20 lg:p-16 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}>
        <div className="flex flex-col xl:flex-row justify-between items-start gap-6 xl:gap-12">
            <div className="relative flex-1 w-full" style={{ margin: 0, padding: 0, minHeight: desktopIconAreaHeight }}>
              {desktopIcons.map((def, i) => {
                const { x, y } = getDefaultDesktopIconPosition(i);
                const label = (t as any)[def.labelKey] || def.labelKey;
                const isIconOpen = openWindows.includes(def.windowId);
                const isIconFocused = focusedWindow === def.windowId;
                const handleClick = () => {
                  toggleWindow(def.windowId);
                };
                return (
                  <motion.div
                    key={def.id}
                    data-lumi-target={def.windowId}
                    onDoubleClick={handleClick}
                    onClick={handleClick}
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

            <div className="flex flex-col gap-6 w-full lg:w-96">
              {/* Modern Widgets Grid */}
              <ThemeWidget
                t={t}
                lang={lang}
                theme={theme}
                setTheme={setTheme}
                operationMode={operationMode}
                onModeChange={requestOperationModeChange}
              />

              {/* Daily Plans Widget */}
              <DailyPlans t={t} onOpenQueue={() => toggleWindow('plans')} />

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
                      {t.meetingMode || (lang === 'zh' ? '会议模式' : 'Meeting Mode')}
                    </h3>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                    {meetingPaused
                      ? (lang === 'zh' ? '会议记录已暂停，已有笔记会保留' : 'Meeting capture paused; existing notes are preserved')
                      : operationMode === 'meeting'
                      ? (lang === 'zh' ? '正在自动语音转文字并收录笔记' : 'Recording speech-to-text notes automatically')
                      : (lang === 'zh' ? '会议笔记已暂停' : 'Meeting notes paused')}
                  </p>
                  {legalMeetingCaseTitle && (
                    <p className="mt-1 text-[11px] leading-relaxed text-cyan-200/70">
                      {lang === 'zh' ? `归档到案件：${legalMeetingCaseTitle}` : `Archiving to case: ${legalMeetingCaseTitle}`}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={copyMeetingNotes}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                    title={lang === 'zh' ? '复制笔记' : 'Copy notes'}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    onClick={downloadMeetingNotes}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                    title={lang === 'zh' ? '导出 Markdown' : 'Export Markdown'}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => setMeetingNotesOpen(false)}
                    className="flex h-9 items-center justify-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-black uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:bg-cyan-400/15"
                    aria-label={lang === 'zh' ? '退出全屏，继续录制' : 'Exit fullscreen, keep recording'}
                    title={lang === 'zh' ? '退出全屏，继续录制' : 'Exit fullscreen, keep recording'}
                  >
                    <X size={15} />
                    <span>{lang === 'zh' ? '退出全屏' : 'Exit'}</span>
                  </button>
                </div>
              </div>

              <div className="mt-5 grid shrink-0 grid-cols-2 gap-2 text-center md:grid-cols-4 md:gap-3">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{lang === 'zh' ? '状态' : 'State'}</div>
                  <div className={`mt-1 text-xs font-bold ${meetingPaused ? 'text-amber-300' : 'text-cyan-300'}`}>
                    {meetingPaused ? 'Paused' : callState === 'idle' ? 'Idle' : callState}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{lang === 'zh' ? '条目' : 'Items'}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">{meetingNotes.length}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{lang === 'zh' ? '说话人' : 'Speakers'}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">{meetingSpeakerCount || '-'}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{lang === 'zh' ? '时长' : 'Time'}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">
                    {meetingStartedAt ? `${Math.max(0, Math.floor((time.getTime() - meetingStartedAt) / 60000))}m` : '0m'}
                  </div>
                </div>
              </div>

              <div className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 custom-scrollbar">
                {meetingReportGenerating && (
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-xs font-bold text-cyan-200">
                    {lang === 'zh' ? 'Lumi 正在整理会议报告...' : 'Lumi is preparing the meeting report...'}
                  </div>
                )}
                {meetingReport && !meetingReportGenerating && (
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3">
                    <div className="text-[10px] font-black uppercase tracking-widest text-cyan-300/80">
                      {lang === 'zh' ? 'Lumi 会议报告' : 'Lumi Report'}
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-white/75 font-sans">{meetingReport}</pre>
                  </div>
                )}
                {meetingNotes.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs leading-relaxed text-white/35">
                    {lang === 'zh' ? '进入会议模式后，说话内容会自动出现在这里。' : 'Speech captured in meeting mode will appear here automatically.'}
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
                  <span>{meetingPaused ? (lang === 'zh' ? '继续记录' : 'Resume') : (lang === 'zh' ? '暂停记录' : 'Pause')}</span>
                </button>
                <button
                  onClick={() => void endMeetingAndReport()}
                  disabled={meetingReportGenerating}
                  className="flex-1 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-black uppercase tracking-widest text-cyan-200 transition-colors hover:bg-cyan-400/15"
                >
                  {meetingReportGenerating
                    ? (lang === 'zh' ? '整理中' : 'Preparing')
                    : (lang === 'zh' ? '结束会议并整理' : 'End & Report')}
                </button>
                <button
                  onClick={clearMeetingNotes}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-black uppercase tracking-widest text-white/40 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {lang === 'zh' ? '清空' : 'Clear'}
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
                      : (t.modeAutoConfirmNote || (lang === 'zh' ? '自主模式可以使用工具、运行日志、团队、命令和桌面控制；进度会可见，敏感操作仍会确认。' : 'Autonomy can use tools, run logs, teams, commands, and desktop control with visible progress and confirmations for sensitive actions.'))}
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

      {workflowPanelVisible && !customerTakeoverStage && !designDeliveryStage && !ecommerceGrowthStage && (
        <Suspense fallback={null}>
          <WorkflowPanel
            visible={true}
            agentStatus={agentStatus}
            steps={workflowSteps}
            t={t}
            placement={isWallpaperMode ? 'center' : 'corner'}
            backgroundTasks={backgroundWorkflowTasks}
            onCancelBackgroundTask={cancelBackgroundWorkflowTask}
          />
        </Suspense>
      )}
      <AnimatePresence>
        {customerTakeoverStage && (
          <CustomerTakeoverPanel
            stage={customerTakeoverStage}
            brief={customerTakeoverBrief}
            onClose={() => {
              setCustomerTakeoverStage(null);
              setCustomerTakeoverBrief(DEFAULT_CUSTOMER_TAKEOVER_BRIEF);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {designDeliveryStage && (
          <DesignDeliveryPanel
            stage={designDeliveryStage}
            onClose={() => setDesignDeliveryStage(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {ecommerceGrowthStage && (
          <EcommerceGrowthPanel
            stage={ecommerceGrowthStage}
            onClose={() => setEcommerceGrowthStage(null)}
          />
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
                  {t.wallpaperWorkPromptTitle || (lang === 'zh' ? '进入原生桌面协作' : 'Native desktop handoff')}
                </div>
                <div className="mt-0.5 truncate text-xs font-medium text-white/55">
                  {t.wallpaperWorkPromptDesc || (lang === 'zh' ? 'Lumi 已开始工作，可以直接转入壁纸模式。' : 'Lumi has started working and can move into wallpaper mode.')}
                </div>
              </div>
              <button
                onClick={enterWallpaperFromWorkPrompt}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/15 px-3 py-2 text-xs font-black uppercase tracking-widest text-cyan-100 transition-colors hover:bg-cyan-300/25"
              >
                <Zap size={13} />
                {t.enterWallpaper || (lang === 'zh' ? '进入壁纸' : 'Enter')}
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
        <DesktopOnboarding 
          isOpen={showOnboarding && sensorPrimerSeen}
          onFinish={() => {
            setShowOnboarding(false);
            localStorage.setItem('lumi_onboarding_seen', 'true');
          }}
          t={t}
        />
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
                onMinimize={(id) => setMinimizedWindows(prev => [...prev, id])}
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
                    <KernelMonitorApp t={t} />
                  ) : windowId === 'settings' ? (
                    <Settings t={t} lang={lang} setLang={setLang} activeSection={settingsSection} onSectionChange={setSettingsSection} />
                  ) : windowId === 'music' ? (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-8 animate-in zoom-in-95 duration-500">
                      <div className="relative">
                        <Disc size={120} className="text-celestial-saturn animate-[spin_8s_linear_infinite]" />
                        <Headphones size={40} className="absolute -bottom-4 -right-4 text-white p-2 bg-black rounded-full" />
                      </div>
                      <div className="space-y-2">
                        <h2 className="text-3xl font-black uppercase tracking-tighter text-white">{t.mediaCenter || 'Media Center'}</h2>
                        <p className="text-white/40 max-w-md text-sm">{t.mediaCenterDesc || 'Voice synthesis, media playback, and audio settings.'}</p>
                      </div>
                      <div className="flex gap-4">
                        <button onClick={() => { toggleWindow('settings'); setSettingsSection('voice'); }} className="px-6 py-3 bg-celestial-saturn/10 border border-celestial-saturn/30 rounded-2xl text-xs font-black uppercase tracking-widest text-celestial-saturn hover:bg-celestial-saturn/20 transition-all">
                          {t.voiceForge || 'Voice Forge'}
                        </button>
                        <button onClick={() => { toggleWindow('settings'); setSettingsSection('voice-services'); }} className="px-6 py-3 bg-white/5 border border-white/10 rounded-2xl text-xs font-black uppercase tracking-widest text-white/40 hover:bg-white/10 transition-all">
                          {t.mediaServices || 'Media Services'}
                        </button>
                      </div>
                    </div>
                  ) : windowId === 'music-center' ? (
                    <MusicCenter isOpen={true} onClose={() => closeWindow('music-center')} t={t} />
                  ) : windowId === 'personality' ? (
                    <PersonalityEditor t={t} />
                  ) : windowId === 'tools' ? (
                    <ToolPanel />
                  ) : windowId === 'team' ? (
                    <TeamHub t={t} />
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
                  ) : windowId === 'runtime-log' ? (
                    <RuntimeLogPanel t={t} />
                  ) : windowId === 'devices' ? (
                    <DeviceSyncCenter t={t} />
                  ) : windowId === 'tokens' ? (
                    <TokenDashboard />
                  ) : windowId === 'skills' ? (
                    <SkillCenter t={t} lang={lang} />
                  ) : windowId === 'subscription' ? (
                    <SubscriptionPanel t={t} />
                  ) : windowId === 'avatar-studio' ? (
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
                          toast.error(lang === 'zh' ? '只有组织所有者或管理员可以修改组织工作域形象' : 'Only an organization owner or administrator can change the organization workspace appearance');
                          return;
                        }
                        setEquippedAccessories(ids);
                        savePetPrefsToServer(selectedPet, ids);
                      }}
                      onResetToSphere={() => {
                        if (!canCustomizeLumiAppearance) {
                          toast.error(lang === 'zh' ? '只有组织所有者或管理员可以修改组织工作域形象' : 'Only an organization owner or administrator can change the organization workspace appearance');
                          return;
                        }
                        setSelectedPet(null);
                        savePetPrefsToServer(null, equippedAccessories);
                        toast.info(lang === 'zh' ? '已切换回原始圆球' : 'Switched back to the default sphere');
                      }}
                    />
                  ) : windowId === 'sound' ? (
                    <SoundPanel t={t} onOpenAvatarStudio={() => toggleWindow('avatar-studio')} />
                  ) : windowId === 'terminal' ? (
                    <TerminalWindow t={t} onClose={() => closeWindow('terminal')} isActive={focusedWindow === 'terminal'} />
                  ) : windowId === 'chat' ? (
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
            onClose={() => setKnowledgeOpen(false)}
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
            onClose={() => { setChatOpen(false); setChatPrefill(''); setChatPrefillSource('proactive'); }}
            prefillMessage={chatPrefill}
            prefillSource={chatPrefillSource}
            onPrefillConsumed={() => { setChatPrefill(''); setChatPrefillSource('proactive'); }}
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
                        : (t.modeAutoConfirmNote || 'Autonomy can use tools, run logs, teams, commands, and desktop control with visible progress and confirmations for sensitive actions.')}
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
            className="fixed inset-0 z-[220] bg-celestial-deep overflow-auto"
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

      {/* Sanctuary — fullscreen immersive memory avatar space */}
      {sanctuaryLoaded && (
        <Suspense fallback={null}>
          <Sanctuary
            agent={sanctuaryAgent}
            isOpen={sanctuaryOpen}
            onClose={() => { setSanctuaryOpen(false); setSanctuaryAgent(null); }}
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
                onClick={() => setMemoryLabOpen(false)}
                className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
              >
                <ArrowLeft size={18} />
              </button>
            </div>
            <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
              <MemoryAvatarLab
                t={t}
                onEnterSanctuary={(agent: any) => {
                  setMemoryLabOpen(false);
                  setSanctuaryAgent(agent);
                  setSanctuaryOpen(true);
                }}
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      <ToolConfirmDialog socket={socket} isWallpaperMode={isWallpaperMode} />
      {musicLayerLoaded && (
        <Suspense fallback={null}>
          <MusicMoodLayer />
        </Suspense>
      )}

    </div>
  );
}

function SoundPanel({ t, onOpenAvatarStudio }: { t?: any; onOpenAvatarStudio?: () => void }) {
  const { selectedVoiceId } = useApp();
  const [designPrompt, setDesignPrompt] = useState('');
  const [designName, setDesignName] = useState('');
  const [designing, setDesigning] = useState(false);
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const [voices, setVoices] = useState<{ cloned: any[]; premade: any[] }>({ cloned: [], premade: [] });
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    listVoices()
      .then(d => setVoices({ cloned: d.cloned || [], premade: d.premade || [] }))
      .catch(() => {});
  }, [voiceRefresh]);

  const handlePlay = async (voice: any, text?: string) => {
    const voiceId = typeof voice === 'string' ? voice : voice.voiceId;
    const provider = typeof voice === 'string' ? undefined : voice.provider;
    const model = typeof voice === 'string' ? undefined : voice.model;
    if (playingId === voiceId) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    try {
      const previewBuffer = await synthesizeSpeech(text || '你好，这是我的声音。Hello, this is my voice.', voiceId, provider, model);
      const previewBlob = new Blob([previewBuffer], { type: 'audio/mp3' });
      const previewUrl = URL.createObjectURL(previewBlob);
      const previewAudio = new Audio(previewUrl);
      audioRef.current = previewAudio;
      previewAudio.onended = () => { setPlayingId(null); URL.revokeObjectURL(previewUrl); };
      await previewAudio.play();
      setPlayingId(voiceId);
    } catch { toast.error('Playback failed'); }
  };

  const handleDesign = async () => {
    if (!designPrompt.trim() || !designName.trim()) return;
    setDesigning(true);
    try {
      const designed = await designVoice(designPrompt.trim(), designName.trim());
      toast.success(`Voice "${designed.name}" created`);
      setDesignPrompt('');
      setDesignName('');
      setVoiceRefresh(n => n + 1);
    } catch (err: any) {
      toast.error(err.message || 'Voice design failed');
    } finally {
      setDesigning(false);
    }
  };

  const voiceIdentitySteps = [
    {
      id: 'design',
      label: t?.voiceFlowDesign || 'Design',
      desc: t?.voiceFlowDesignDesc || 'Generate a voice from description',
      active: designing,
      done: voices.cloned.length + voices.premade.length > 0,
    },
    {
      id: 'clone',
      label: t?.voiceFlowClone || 'Clone',
      desc: t?.voiceFlowCloneDesc || 'Record or upload real samples',
      active: false,
      done: voices.cloned.length > 0,
    },
    {
      id: 'select',
      label: t?.voiceFlowSelect || 'Enable',
      desc: t?.voiceFlowSelectDesc || 'Choose Lumi voice',
      active: false,
      done: Boolean(selectedVoiceId),
    },
    {
      id: 'avatar',
      label: t?.voiceFlowAvatar || 'Avatar',
      desc: t?.voiceFlowAvatarDesc || 'Match voice with appearance',
      active: false,
      done: false,
    },
  ];

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
      <div className="flex items-center gap-3 shrink-0">
        <div className="p-3 bg-gradient-to-br from-sky-500 to-indigo-600 rounded-2xl shadow-lg">
          <Volume2 size={24} className="text-white" />
        </div>
        <div>
          <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">{t?.voiceStudio || 'Voice Studio'}</h3>
          <p className="text-xs text-white/55 uppercase tracking-widest">{t?.voiceStudioDesc || 'Cloning & Design'}</p>
        </div>
        <div className="ml-auto">
          <VoicePicker t={t} direction="down" refreshTrigger={voiceRefresh} />
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-4 gap-2 rounded-2xl border border-white/5 bg-white/[0.02] p-2">
        {voiceIdentitySteps.map((step, index) => (
          <button
            key={step.id}
            onClick={step.id === 'avatar' ? onOpenAvatarStudio : undefined}
            disabled={step.id !== 'avatar'}
            className={`group min-w-0 rounded-xl border px-3 py-2 text-left transition-colors ${
              step.done
                ? 'border-emerald-400/20 bg-emerald-400/10'
                : step.active
                  ? 'border-sky-400/30 bg-sky-400/10'
                  : step.id === 'avatar'
                    ? 'border-cyan-400/20 bg-cyan-400/10 hover:bg-cyan-400/20'
                    : 'border-white/5 bg-black/20'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${
                step.done ? 'bg-emerald-300 text-black' : step.active ? 'bg-sky-300 text-black' : 'bg-white/10 text-white/45'
              }`}>
                {step.done ? '✓' : index + 1}
              </span>
              <span className="truncate text-[11px] font-black uppercase tracking-[0.12em] text-white/72">{step.label}</span>
            </div>
            <p className="mt-1 truncate text-[10px] font-semibold text-white/35">{step.desc}</p>
          </button>
        ))}
      </div>

      <div className="flex-1 grid grid-cols-2 gap-4 overflow-hidden">
        {/* Left: Create */}
        <div className="overflow-y-auto scrollbar-hide space-y-4">
          {/* Voice Design — text → voice */}
          <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4 space-y-4">
            <h4 className="text-xs font-black uppercase tracking-widest text-white/55">{t?.voiceDesignTab || 'Voice Design'}</h4>
            <p className="text-xs text-white/40">{t?.voiceDesignDesc || 'Describe the voice you want, and AI will generate it. No audio sample needed.'}</p>
            <label className="text-xs font-black uppercase text-white/55">{t?.voiceDesignPrompt || 'Voice Description'}</label>
            <textarea
              value={designPrompt}
              onChange={e => setDesignPrompt(e.target.value)}
              placeholder={t?.voiceDesignPlaceholder || 'e.g. A warm, gentle female voice with a soft tone...'}
              className="w-full h-20 bg-black/40 border border-white/10 rounded-2xl p-3 text-sm text-white/80 outline-none focus:border-sky-500/50 resize-none"
            />
            <label className="text-xs font-black uppercase text-white/55">{t?.voiceDesignName || 'Voice Name'}</label>
            <input
              value={designName}
              onChange={e => setDesignName(e.target.value)}
              placeholder="e.g. Storyteller_v1"
              className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-sm text-white/80 outline-none focus:border-sky-500/50"
            />
            <button
              onClick={handleDesign}
              disabled={designing || !designPrompt.trim() || !designName.trim()}
              className="w-full py-3 bg-sky-500/20 border border-sky-500/30 rounded-2xl text-sm font-black uppercase tracking-widest text-sky-400 hover:bg-sky-500/30 disabled:opacity-70 disabled:cursor-not-allowed transition-all relative overflow-hidden"
            >
              {designing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-sky-400/30 border-t-sky-400 rounded-full animate-spin" />
                  {t?.generating || 'Generating...'}
                </span>
              ) : (
                t?.generateVoice || 'Generate Voice'
              )}
            </button>
            {designing && (
              <div className="h-0.5 w-full bg-white/5 rounded-full overflow-hidden mt-1">
                <motion.div
                  className="h-full bg-gradient-to-r from-sky-400 to-indigo-400"
                  initial={{ width: '0%' }}
                  animate={{ width: '100%' }}
                  transition={{ duration: 8, ease: 'easeInOut' }}
                />
              </div>
            )}
          </div>

          {/* Voice Cloning — record/upload */}
          <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4">
            <h4 className="text-xs font-black uppercase tracking-widest text-white/55 mb-4">{t?.voiceCloning || 'Voice Cloning'}</h4>
            <Suspense fallback={<LazyPanelFallback label={t?.loading || 'Loading'} />}>
              <VoiceForge t={t} compact onCloneSuccess={() => setVoiceRefresh(n => n + 1)} />
            </Suspense>
          </div>
        </div>

        {/* Right: Voice List */}
        <div className="overflow-y-auto scrollbar-hide rounded-2xl bg-white/[0.02] border border-white/5 p-4 space-y-6">
          {voices.cloned.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-xs font-black uppercase tracking-[0.3em] text-white/40">{t?.clonedVoices || 'Cloned Voices'}</h4>
              <div className="space-y-2">
                {voices.cloned.map((v: any) => (
                  <VoiceCard key={v.voiceId} voice={v} isCloned isPlaying={playingId === v.voiceId} onPlay={() => handlePlay(v)} />
                ))}
              </div>
            </section>
          )}
          <section className="space-y-3">
            <h4 className="text-xs font-black uppercase tracking-[0.3em] text-white/40">{t?.premadeVoices || 'Premade Voices'}</h4>
            <div className="space-y-2">
              {voices.premade.map((v: any) => (
                <VoiceCard key={v.voiceId} voice={v} isPlaying={playingId === v.voiceId} onPlay={() => handlePlay(v)} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function VoiceCard({ voice, isCloned, isPlaying, onPlay }: { voice: any; isCloned?: boolean; isPlaying?: boolean; onPlay: () => void }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl transition-all group ${
      isPlaying ? 'bg-sky-500/10 border border-sky-500/20' : 'bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06]'
    }`}>
      <button
        onClick={onPlay}
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
          isPlaying ? 'bg-sky-500 text-white' : 'bg-white/10 text-white/50 group-hover:text-white'
        }`}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-white/80 truncate">{voice.name}</div>
        <div className="text-[10px] text-white/40 uppercase">{voice.language || voice.provider || ''}</div>
      </div>
      {isCloned && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />}
    </div>
  );
}

function BatteryIndicator({ lang = 'zh' }: { lang?: 'en' | 'zh' }) {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState(false);

  useEffect(() => {
    const nav = navigator as any;
    if (nav.getBattery) {
      nav.getBattery().then((b: any) => {
        setLevel(Math.round(b.level * 100));
        setCharging(b.charging);
        b.addEventListener('levelchange', () => setLevel(Math.round(b.level * 100)));
        b.addEventListener('chargingchange', () => setCharging(b.charging));
      }).catch(() => setLevel(null));
    }
  }, []);

  if (level === null) return <Battery size={14} />;

  return (
    <div
      className="flex items-center gap-1"
      title={lang === 'zh' ? `电池 ${level}%${charging ? ' (充电中)' : ''}` : `Battery ${level}%${charging ? ' (charging)' : ''}`}
    >
      <Battery size={14} className={level <= 20 ? 'text-red-400' : level <= 50 ? 'text-yellow-400' : ''} />
      <span className="text-xs font-bold">{level}%</span>
    </div>
  );
}

function MeetingModeButton({
  t,
  lang,
  active,
  live,
  onClick,
}: {
  t?: any;
  lang: 'en' | 'zh';
  active: boolean;
  live: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-[156px] items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-xs font-black uppercase tracking-[0.16em] transition-all ${
        active
          ? 'border-cyan-400/30 bg-cyan-400/15 text-cyan-100 shadow-[0_12px_32px_rgba(34,211,238,0.12)]'
          : 'border-white/10 bg-white/[0.035] text-white/45 hover:bg-white/[0.075] hover:text-white/75'
      }`}
      title={t?.modeMeetingTitle || (lang === 'zh' ? '会议模式' : 'Meeting mode')}
    >
      <span className={`h-2 w-2 rounded-full ${live ? 'bg-cyan-300 animate-pulse' : active ? 'bg-cyan-300' : 'bg-white/25'}`} />
      <FileText size={14} />
      <span>{t?.modeMeeting || (lang === 'zh' ? '会议' : 'Meeting')}</span>
    </button>
  );
}

function DayInkLandscape({ variant }: { variant: 'celestial' | 'nebula' | 'cyber' }) {
  return (
    <div className="lumi-day-landscape" data-day-variant={variant} aria-hidden="true">
      <div className="lumi-day-paper" />
      <div className="lumi-day-mist lumi-day-mist-back" />
      <div className="lumi-day-mountains lumi-day-mountains-back" />
      <div className="lumi-day-mountains lumi-day-mountains-mid" />
      <div className="lumi-day-ground" />
      <div className="lumi-day-ink-lines" />
      <div className="lumi-day-vignette" />
    </div>
  );
}

function ThemeWidget({
  t,
  lang,
  theme,
  setTheme,
  operationMode,
  onModeChange,
}: {
  t?: any;
  lang: 'en' | 'zh';
  theme: string;
  setTheme: (value: string) => void;
  operationMode: OperationMode;
  onModeChange: (mode: OperationMode) => void;
}) {
  const themeOptions = [
    {
      id: 'celestial',
      label: t?.celestial || 'Celestial',
      mode: 'chat' as OperationMode,
      modeLabel: t?.modeChat || (lang === 'zh' ? '聊天' : 'Chat'),
      accessLabel: lang === 'zh' ? '纯聊天' : 'Chat Only',
      icon: <Sparkles size={16} />,
      glow: 'from-celestial-saturn/35 to-cyan-300/20',
      orb: 'from-celestial-saturn to-cyan-200',
      line: 'bg-celestial-saturn',
    },
    {
      id: 'nebula',
      label: t?.nebula || 'Nebula',
      mode: 'assistant' as OperationMode,
      modeLabel: t?.modeAssistant || (lang === 'zh' ? '助手' : 'Assistant'),
      accessLabel: lang === 'zh' ? '现场全权限' : 'Foreground Full Access',
      icon: <Moon size={16} />,
      glow: 'from-indigo-500/35 to-fuchsia-400/20',
      orb: 'from-indigo-500 to-fuchsia-400',
      line: 'bg-indigo-400',
    },
    {
      id: 'cyber',
      label: t?.cyber || 'Cyber',
      mode: 'autonomous' as OperationMode,
      modeLabel: t?.modeAutonomy || t?.modeAutoExecute || (lang === 'zh' ? '自主' : 'Autonomy'),
      accessLabel: lang === 'zh' ? '24h 自主运行' : '24h Autonomous',
      icon: <Zap size={16} />,
      glow: 'from-emerald-400/30 to-teal-300/20',
      orb: 'from-emerald-400 to-teal-300',
      line: 'bg-emerald-400',
    },
  ];

  return (
    <GlassCard className="lumi-mode-panel rounded-[1.6rem] border-white/5 bg-black/20 p-3">
      <div className="grid grid-cols-3 gap-3">
        {themeOptions.map((option) => {
          const active = theme === option.id && operationMode === option.mode;
          const visualActive = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                if (option.mode !== 'autonomous' || operationMode === 'autonomous') {
                  setTheme(option.id);
                }
                onModeChange(option.mode);
                sounds.playPulse();
              }}
              className={`lumi-mode-card group relative min-h-[134px] overflow-hidden rounded-[1.25rem] border p-3 text-left transition-all ${
                active
                  ? 'border-white/20 bg-white/[0.10] shadow-[0_18px_45px_rgba(0,0,0,0.28)]'
                  : visualActive
                    ? 'border-white/10 bg-white/[0.06]'
                    : 'border-white/5 bg-black/20 hover:bg-white/[0.05]'
              }`}
            >
              <div className={`lumi-mode-card-glow absolute inset-0 bg-gradient-to-br ${option.glow} transition-opacity group-hover:opacity-80 ${visualActive ? 'opacity-100' : 'opacity-40'}`} />
              <div className="relative flex h-full flex-col justify-between">
                <div className="flex items-start justify-between gap-2">
                  <div className={`lumi-mode-orb flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${option.orb} text-black shadow-lg`}>
                    {option.icon}
                  </div>
                  <span className={`h-2 w-2 rounded-full ${active ? option.line : 'bg-white/20'}`} />
                </div>
                <div>
                  <div className="text-[11px] font-black uppercase tracking-[0.14em] text-white/85">
                    {option.label}
                  </div>
                  <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/45">
                    {option.modeLabel}
                  </div>
                  <div className="mt-2 min-h-[22px] rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-white/70">
                    {option.accessLabel}
                  </div>
                  <div className="mt-2 h-1 rounded-full bg-white/10">
                    <motion.div
                      animate={{ width: active ? '100%' : visualActive ? '64%' : '28%' }}
                      className={`h-full rounded-full ${option.line}`}
                    />
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </GlassCard>
  );
}


