import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, ArrowLeft, Ghost, Zap, Cpu, Sparkles, FileText, Mic, CheckCircle2, Square, ChevronDown, ChevronRight, XCircle, Copy, Check, Paperclip, Image as ImageIcon, MessageCircle, Briefcase, User, ExternalLink, FolderOpen, Upload, Plus, History } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { GlassCard, PulseCounter } from './SharedUI';
import { toast } from 'sonner';
import { FoundersSanctuary } from './FoundersSanctuary';
import { usePlatform } from '@/hooks/usePlatform';
import { useApp } from '@/contexts/AppContext';
import { VoiceCallButton } from './VoiceCallButton';
import { socketService } from '@/services/socketService';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useVoiceCloning } from '@/hooks/useVoiceCloning';
import { listVoices } from '@/services/voiceService';
import {
  describeToolProgress,
  describeTurnCompletionProgress,
  needsVisibleToolEvidence,
  type ChatProgressLine,
  type ChatResponseFinalization,
  type ChatProgressTone,
} from '@/lib/chatProgress';
import type { BackgroundWorkflowTask, WorkflowStep } from './workflowTypes';
import { WeChatSettings } from './WeChatSettings';
import type { FileEntry } from './MemoryTree';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { CN_FOUNDER_ALIASES } from '../i18n/regions/cn/recognition';
import {
  MAX_CHAT_ATTACHMENTS,
  chatAttachmentIdentity,
  chatAttachmentRequestMatchesScope,
  createChatAttachmentReference,
  mergeChatAttachmentReferences,
  parseChatAttachmentContext,
  serializeChatAttachmentContext,
  type ChatAttachmentReference,
  type ChatAttachmentRequest,
} from '@/lib/chatAttachmentReferences';
import {
  isFinalizedSuccessfulResponse,
  isTerminalAgentStatus,
  shouldDisplayAgentResponse,
} from '@/lib/agentResponseDelivery';
import { buildChatConversationScopeKey } from '@/lib/chatConversationScope';
import { useFocusThreads } from '@/hooks/useFocusThreads';
import { CommandCenterPanel } from './CommandCenterPanel';
import type { CommandCenterView } from './commandCenterTypes';
import { ActiveTaskWidget } from './ActiveTaskWidget';
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';

const CHAT_HISTORY_LIMIT = 300;
const CHAT_RENDER_LIMIT = 80;
const CHAT_SEARCH_LIMIT = 200;
type WorkflowStatus = 'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'cancelling' | 'cancelled' | 'done' | 'error';

type ChatExecutionSnapshot = {
  requestId: string;
  source: string;
  status: 'acknowledged' | 'planning' | 'executing' | 'waiting_confirmation' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  createdAt: string;
  updatedAt: string;
  terminal: boolean;
  terminalEvent?: { event: string; payload: Record<string, any> };
};

type PersistedChatExecution = {
  requestId: string;
  source: 'chat';
  domain: 'personal' | 'work';
  orgId?: string;
  conversationId?: string;
  startedAt: string;
};

type ConversationHistoryItem = {
  id: string;
  displayTitle?: string;
  title?: string;
  preview?: string;
  status: 'active' | 'paused' | 'closed';
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
};

const ACTIVE_CHAT_EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;

function makeChatMessageId(prefix = 'msg'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type ChatAttachment = ChatAttachmentReference;

type GeneratedFileLink = {
  id: string;
  fileName: string;
  path: string;
  url: string;
  kind: 'image' | 'document' | 'deck' | 'sheet' | 'pdf' | 'cad' | 'file';
};

type ChatFilePanelItem = {
  id: string;
  fileName: string;
  subtitle: string;
  kind: GeneratedFileLink['kind'] | ChatAttachment['kind'];
  source: 'pending' | 'generated' | 'knowledge';
  fileId?: string;
  path?: string;
  openUrl?: string;
  saveUrl?: string;
  status?: string;
  mimeType?: string;
  size?: number;
};

type KnowledgeUpdateDetail = {
  domain?: 'personal' | 'work';
  orgId?: string;
  files?: Array<{ id?: string; name?: string; displayName?: string }>;
};

function getDisplayText(message: any): string {
  if (typeof message?.text === 'string') return message.text;
  if (message?.text == null) return '';
  return String(message.text);
}

const ASSISTANT_HISTORY_NOISE_RE =
  /我还没有真正开始读取或审查|我还不能说这件事已经完成|没有记录到成功的工具执行|真正读取时|Completion claim|Maximum tool call iterations|Action Constitution|local_write action requires confirmation|已经落到(?:桌面|电脑|文件)|结果包已经|交付包已经|真实接管|WPS\s*表格|剪映已打开|微信已打开|文件生成也卡在权限确认|工具调用一直在跑/i;

function shouldOmitAssistantHistoryMessage(message: any, text: string): boolean {
  const role = String(message?.role || '').toLowerCase();
  const type = String(message?.type || '').toLowerCase();
  const isAssistantLike = role === 'assistant' || type === 'agent';
  return isAssistantLike && ASSISTANT_HISTORY_NOISE_RE.test(text);
}

function stripStoredAttachmentSummary(value: string): string {
  return String(value || '')
    .replace(/\n{0,2}\[Attachments\][\s\S]*$/i, '')
    .trim();
}

function buildChatHistoryPayload(messages: any[]) {
  return messages.flatMap((m) => {
    const text = getDisplayText(m).trim();
    if (!text) return [];
    if (m.type === 'tool') return [];
    if (['error', 'proactive'].includes(m.source)) return [];
    if (/^(Request failed|请求失败|出错了|Failed to route)/i.test(text)) return [];
    if (shouldOmitAssistantHistoryMessage(m, text)) return [];
    if (m.type === 'agent') return [{ role: 'assistant', content: text }];
    if (m.type === 'user' || m.type === 'file_context') return [{ role: 'user', content: text }];
    return [];
  }).slice(-80);
}

function isImageFileName(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name || '');
}

function isAudioFileName(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('audio/')) || /\.(mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i.test(name || '');
}

function extractAudioTranscript(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const marker = 'transcript:';
  const index = raw.toLowerCase().indexOf(marker);
  const transcript = index >= 0 ? raw.slice(index + marker.length).trim() : raw;
  return transcript || null;
}

function serializeChatAttachment(item: ChatAttachment): ChatAttachment {
  return {
    id: item.id,
    fileName: item.fileName,
    path: item.path,
    content: item.content || null,
    preview: item.preview || null,
    mimeType: item.mimeType || '',
    size: item.size || 0,
    kind: item.kind,
    fileId: item.fileId || '',
    downloadUrl: item.downloadUrl,
    transcript: item.transcript || null,
    transcriptionStatus: item.transcriptionStatus || '',
    transcriptionError: item.transcriptionError || null,
    transcriptionProvider: item.transcriptionProvider || '',
    transcriptionModel: item.transcriptionModel || '',
  };
}

function getSelectedTextWithin(container?: HTMLElement | null): string {
  if (typeof window === 'undefined') return '';
  const selection = window.getSelection?.();
  const text = selection?.toString().trim() || '';
  if (!selection || !text) return '';
  if (!container) return text;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && container.contains(anchor)) || (focus && container.contains(focus))) return text;
  return '';
}

const CHAT_ACCENT_THEMES = [
  {
    id: 'saturn',
    label: 'Saturn',
    saturn: '#ffcc00',
    glow: '#00ffff',
    nebula: '#ff2d55',
    mars: '#ff4d4d',
    background: 'radial-gradient(circle at 18% 12%, rgba(255,204,0,0.24) 0%, transparent 28%), radial-gradient(circle at 82% 22%, rgba(0,255,255,0.14) 0%, transparent 30%), linear-gradient(145deg, #11100a 0%, #060810 46%, #020205 100%)',
    panel: 'linear-gradient(180deg, rgba(34,28,8,0.82) 0%, rgba(7,9,18,0.92) 100%)',
    panelBorder: 'rgba(255, 204, 0, 0.32)',
    panelShadow: '0 26px 80px rgba(255, 204, 0, 0.13), 0 0 0 1px rgba(255,255,255,0.04)',
    header: 'linear-gradient(90deg, rgba(255,204,0,0.16), rgba(0,255,255,0.07))',
    progress: 'linear-gradient(90deg, rgba(255,204,0,0.18), rgba(0,0,0,0.18))',
    agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.072), rgba(255,204,0,0.055))',
    userBubble: 'linear-gradient(135deg, rgba(255,204,0,0.23), rgba(0,255,255,0.08))',
    inputPanel: 'linear-gradient(90deg, rgba(255,204,0,0.12), rgba(0,0,0,0.32))',
    input: 'rgba(18, 14, 4, 0.72)',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    saturn: '#22d3ee',
    glow: '#a78bfa',
    nebula: '#38bdf8',
    mars: '#fb7185',
    background: 'radial-gradient(circle at 20% 12%, rgba(34,211,238,0.30) 0%, transparent 30%), radial-gradient(circle at 84% 16%, rgba(167,139,250,0.22) 0%, transparent 32%), linear-gradient(145deg, #061924 0%, #07101f 48%, #020205 100%)',
    panel: 'linear-gradient(180deg, rgba(5,35,49,0.84) 0%, rgba(5,9,20,0.92) 100%)',
    panelBorder: 'rgba(34, 211, 238, 0.40)',
    panelShadow: '0 26px 80px rgba(34, 211, 238, 0.16), 0 0 0 1px rgba(167,139,250,0.10)',
    header: 'linear-gradient(90deg, rgba(34,211,238,0.18), rgba(167,139,250,0.12))',
    progress: 'linear-gradient(90deg, rgba(34,211,238,0.20), rgba(20,9,44,0.20))',
    agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.07), rgba(34,211,238,0.06))',
    userBubble: 'linear-gradient(135deg, rgba(34,211,238,0.24), rgba(167,139,250,0.13))',
    inputPanel: 'linear-gradient(90deg, rgba(34,211,238,0.13), rgba(4,9,20,0.35))',
    input: 'rgba(4, 22, 34, 0.76)',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    saturn: '#34d399',
    glow: '#5eead4',
    nebula: '#84cc16',
    mars: '#f97316',
    background: 'radial-gradient(circle at 18% 12%, rgba(52,211,153,0.28) 0%, transparent 30%), radial-gradient(circle at 82% 20%, rgba(249,115,22,0.15) 0%, transparent 30%), linear-gradient(145deg, #071d14 0%, #07130f 46%, #020205 100%)',
    panel: 'linear-gradient(180deg, rgba(6,40,27,0.84) 0%, rgba(4,12,10,0.93) 100%)',
    panelBorder: 'rgba(52, 211, 153, 0.40)',
    panelShadow: '0 26px 80px rgba(52, 211, 153, 0.15), 0 0 0 1px rgba(249,115,22,0.08)',
    header: 'linear-gradient(90deg, rgba(52,211,153,0.17), rgba(249,115,22,0.08))',
    progress: 'linear-gradient(90deg, rgba(52,211,153,0.19), rgba(4,14,10,0.22))',
    agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.066), rgba(52,211,153,0.058))',
    userBubble: 'linear-gradient(135deg, rgba(52,211,153,0.25), rgba(94,234,212,0.10))',
    inputPanel: 'linear-gradient(90deg, rgba(52,211,153,0.13), rgba(4,12,10,0.36))',
    input: 'rgba(4, 26, 18, 0.76)',
  },
  {
    id: 'rose',
    label: 'Rose',
    saturn: '#fb7185',
    glow: '#f0abfc',
    nebula: '#f472b6',
    mars: '#f97316',
    background: 'radial-gradient(circle at 20% 12%, rgba(251,113,133,0.30) 0%, transparent 29%), radial-gradient(circle at 82% 18%, rgba(240,171,252,0.19) 0%, transparent 30%), linear-gradient(145deg, #2b0a17 0%, #130713 46%, #020205 100%)',
    panel: 'linear-gradient(180deg, rgba(45,9,24,0.84) 0%, rgba(15,7,16,0.93) 100%)',
    panelBorder: 'rgba(251, 113, 133, 0.42)',
    panelShadow: '0 26px 80px rgba(251, 113, 133, 0.16), 0 0 0 1px rgba(240,171,252,0.09)',
    header: 'linear-gradient(90deg, rgba(251,113,133,0.18), rgba(240,171,252,0.10))',
    progress: 'linear-gradient(90deg, rgba(251,113,133,0.20), rgba(23,7,22,0.22))',
    agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.068), rgba(251,113,133,0.060))',
    userBubble: 'linear-gradient(135deg, rgba(251,113,133,0.26), rgba(240,171,252,0.12))',
    inputPanel: 'linear-gradient(90deg, rgba(251,113,133,0.14), rgba(15,7,16,0.36))',
    input: 'rgba(36, 8, 20, 0.76)',
  },
] as const;

const CHAT_NEUTRAL_THEME = {
  id: 'neutral',
  label: 'Neutral',
  saturn: '#e5e7eb',
  glow: '#f8fafc',
  nebula: '#cbd5e1',
  mars: '#f87171',
  background: 'linear-gradient(145deg, rgba(10,12,16,0.96) 0%, rgba(4,6,10,0.98) 48%, rgba(1,2,5,1) 100%)',
  panel: 'linear-gradient(180deg, rgba(18,20,26,0.86) 0%, rgba(7,9,14,0.94) 100%)',
  panelBorder: 'rgba(255, 255, 255, 0.14)',
  panelShadow: '0 26px 80px rgba(0, 0, 0, 0.34), 0 0 0 1px rgba(255,255,255,0.04)',
  header: 'linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))',
  progress: 'linear-gradient(90deg, rgba(255,255,255,0.07), rgba(0,0,0,0.18))',
  agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.045))',
  userBubble: 'linear-gradient(135deg, rgba(255,255,255,0.105), rgba(255,255,255,0.055))',
  inputPanel: 'linear-gradient(90deg, rgba(255,255,255,0.06), rgba(0,0,0,0.30))',
  input: 'rgba(6, 8, 12, 0.76)',
} as const;

const CHAT_LIGHT_THEME = {
  id: 'light',
  label: 'Light',
  saturn: '#167a5f',
  glow: '#0ea5a3',
  nebula: '#2563eb',
  mars: '#dc2626',
  background: 'radial-gradient(circle at 18% 12%, rgba(22,122,95,0.10) 0%, transparent 30%), radial-gradient(circle at 82% 18%, rgba(37,99,235,0.07) 0%, transparent 34%), linear-gradient(145deg, #fbfcf8 0%, #f4f7f2 48%, #eef3ef 100%)',
  panel: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.90) 100%)',
  panelBorder: 'rgba(30, 66, 49, 0.13)',
  panelShadow: '0 26px 80px rgba(31, 46, 39, 0.10), 0 0 0 1px rgba(255,255,255,0.72)',
  header: 'linear-gradient(90deg, rgba(255,255,255,0.94), rgba(242,248,244,0.88))',
  progress: 'linear-gradient(90deg, rgba(22,122,95,0.09), rgba(255,255,255,0.82))',
  agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(249,252,249,0.95))',
  userBubble: 'linear-gradient(135deg, rgba(232,246,240,0.98), rgba(242,248,255,0.92))',
  inputPanel: 'linear-gradient(90deg, rgba(255,255,255,0.95), rgba(246,250,247,0.92))',
  input: 'rgba(255,255,255,0.98)',
} as const;

const CHAT_ATTACHMENT_ACCEPT = [
  '.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff',
  '.mp3,.mpeg,.wav,.m4a,.ogg,.oga,.flac,.aac,.wma,.webm',
  '.txt,.md,.json,.csv,.pdf,.docx,.xlsx,.xls,.pptx,.ppt,.rtf,.ts,.tsx,.js,.jsx,.py,.html,.css,.yaml,.yml,.xml,.log',
].join(',');

const GENERATED_FILE_EXTS = 'docx|pptx|xlsx|xls|pdf|txt|md|csv|json|png|jpe?g|webp|gif|svg|html|dxf|dwg';
const WINDOWS_GENERATED_FILE_RE = new RegExp(`[A-Za-z]:\\\\[^\\n\\r"'<>|]+?\\.(?:${GENERATED_FILE_EXTS})\\b`, 'gi');
const LUMI_OUTPUT_FILE_RE = new RegExp(`/lumi_output/[^\\s\\])"'<>]+?\\.(?:${GENERATED_FILE_EXTS})\\b`, 'gi');

function generatedFileKind(fileName: string): GeneratedFileLink['kind'] {
  const lower = fileName.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(lower)) return 'image';
  if (/\.pptx?$/i.test(lower)) return 'deck';
  if (/\.xlsx?$/i.test(lower)) return 'sheet';
  if (/\.pdf$/i.test(lower)) return 'pdf';
  if (/\.(dxf|dwg)$/i.test(lower)) return 'cad';
  if (/\.(docx?|txt|md|csv|json|html)$/i.test(lower)) return 'document';
  return 'file';
}

function buildGeneratedFileUrl(filePath: string): string {
  if (filePath.startsWith('/lumi_output/')) return filePath;
  return `/api/files/generated?path=${encodeURIComponent(filePath)}`;
}

function extractGeneratedFiles(text: string): GeneratedFileLink[] {
  const canExposeFiles =
    /(?:Verified generated files|Generated and verified these files exist|Audio transcription result|Text file:|Output file:|Saved to:|已生成)/i.test(text || '');
  if (!canExposeFiles) return [];

  const seen = new Set<string>();
  const candidates = [
    ...(text.match(WINDOWS_GENERATED_FILE_RE) || []),
    ...(text.match(LUMI_OUTPUT_FILE_RE) || []),
  ];

  return candidates
    .map(raw => raw.trim().replace(/[)\].,;，。；]+$/g, ''))
    .filter(filePath => {
      const key = filePath.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(filePath => {
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      return {
        id: `generated-${filePath}`,
        fileName,
        path: filePath,
        url: buildGeneratedFileUrl(filePath),
        kind: generatedFileKind(fileName),
      };
    });
}

export function AgentChatPage({
  t,
  user,
  agent,
  isOpen,
  onClose,
  prefillMessage,
  prefillSource = 'proactive',
  onPrefillConsumed,
  attachmentRequest,
  onAttachmentRequestConsumed,
  layout = 'standalone',
  commandCenterView = 'office',
  onCommandCenterViewChange,
  onOpenNexus,
}: {
  t: any;
  user: any;
  agent?: any;
  isOpen: boolean;
  onClose: () => void;
  prefillMessage?: string;
  prefillSource?: string;
  onPrefillConsumed?: () => void;
  attachmentRequest?: ChatAttachmentRequest;
  onAttachmentRequestConsumed?: (requestId: string) => void;
  layout?: 'standalone' | 'command-center';
  commandCenterView?: CommandCenterView;
  onCommandCenterViewChange?: (view: CommandCenterView) => void;
  onOpenNexus?: () => void;
}) {
  const [messages, setMessages] = useState<any[]>([]);
  const isOfficeCommandCenter = layout === 'command-center' && (commandCenterView === 'office' || commandCenterView === 'team');
  const isCommandCenterUtility = layout === 'command-center' && !isOfficeCommandCenter;
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const { platform, isElectron } = usePlatform();
  const { orgConnection, workDomain, operationMode, resolvedAppearanceMode } = useApp();
  const isWorkChat = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const activeDomain = isWorkChat ? 'work' : 'personal';
  const activeOrgId = isWorkChat ? orgConnection?.orgId : undefined;
  const activeDomainLabel = isWorkChat ? uiMessage('agent-chat-page.lumi-work-workspace.87c39acadf') : uiMessage('agent-chat-page.lumi-personal-workspace.25d2bcfab7');
  const activeDomainDetail = isWorkChat
    ? uiMessage('agent-chat-page.messages-attachments-memories-and-tools.84b41176b1')
    : uiMessage('agent-chat-page.messages-stay-in-your-personal.5e15655a2c');
  const activeCapabilities = [
    isWorkChat ? uiMessage('agent-chat-page.org-memory.8fef7743d2') : (t.neuralCore || 'Neural Core'),
    isWorkChat ? uiMessage('agent-chat-page.knowledge-base.3b55921264') : (t.webMesh || 'Web Mesh'),
    isElectron ? uiMessage('agent-chat-page.local-node.da9f577e7d') : uiMessage('agent-chat-page.browser-channel.61c3c86e02'),
  ];
  const operationModeMeta = (() => {
    if (operationMode === 'chat') {
      return {
        label: t.modeChat || uiMessage('agent-chat-page.chat.1594b2f45c'),
        detail: t.modeChatHint || uiMessage('agent-chat-page.conversation-only.33f7067683'),
        badgeClass: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
        subtleClass: 'border-emerald-400/15 bg-emerald-400/10 text-emerald-100/75',
        dotClass: 'bg-emerald-300',
        Icon: MessageCircle,
      };
    }
    if (operationMode === 'autonomous') {
      return {
        label: t.modeAutonomy || t.modeAutoExecute || uiMessage('agent-chat-page.autonomy.6aea974e38'),
        detail: t.modeAutonomyHint || t.modeAutoExecuteHint || uiMessage('agent-chat-page.24h-autonomous-work.81b1d75d6b'),
        badgeClass: 'border-cyan-300/30 bg-cyan-400/12 text-cyan-100',
        subtleClass: 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100/80',
        dotClass: 'bg-cyan-300 animate-pulse',
        Icon: Zap,
      };
    }
    if (operationMode === 'meeting') {
      return {
        label: t.modeMeeting || uiMessage('agent-chat-page.meeting.e16a90b510'),
        detail: t.modeMeetingHint || uiMessage('agent-chat-page.live-notes.578276ba0a'),
        badgeClass: 'border-blue-300/30 bg-blue-400/12 text-blue-100',
        subtleClass: 'border-blue-300/20 bg-blue-400/10 text-blue-100/80',
        dotClass: 'bg-blue-300 animate-pulse',
        Icon: FileText,
      };
    }
    return {
      label: t.modeAssistant || uiMessage('agent-chat-page.assistant.4a363bbe1a'),
      detail: t.modeAssistantHint || uiMessage('agent-chat-page.foreground-full-access.a5a81a90e7'),
      badgeClass: 'border-celestial-saturn/30 bg-celestial-saturn/12 text-celestial-saturn',
      subtleClass: 'border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn/85',
      dotClass: 'bg-celestial-saturn',
      Icon: Sparkles,
    };
  })();
  const OperationModeIcon = operationModeMeta.Icon;
  const socket = socketService.connect();
  const { threads: focusThreads } = useFocusThreads({
    domain: activeDomain,
    orgId: activeOrgId,
    enabled: isOpen && Boolean(user),
  });
  const {
    status: runtimeStatus,
    loading: runtimeStatusLoading,
    error: runtimeStatusError,
    refresh: refreshRuntimeStatus,
  } = useRuntimeStatus({
    enabled: isOpen && isOfficeCommandCenter && Boolean(user),
    scopeKey: `${activeDomain}:${activeDomain === 'work' ? activeOrgId || '' : ''}`,
  });
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>();
  const [voices, setVoices] = useState<any[]>([]);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showWeChatSettings, setShowWeChatSettings] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const voicePickerRef = useRef<HTMLDivElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [installedSkillNames, setInstalledSkillNames] = useState<string[]>([]);
  const inputDictationActiveRef = useRef(false);
  const chatAccentTheme = resolvedAppearanceMode === 'light' ? CHAT_LIGHT_THEME : CHAT_NEUTRAL_THEME;

  // Fetch installed skills to generate dynamic suggestions
  useEffect(() => {
    fetch('/api/skills').then(r => r.json()).then(data => {
      setInstalledSkillNames((data.skills || []).map((s: any) => s.name?.toLowerCase?.() || ''));
    }).catch(() => {});
  }, []);

  const hasCreativeSkill = installedSkillNames.some((n: string) => ['minimax', 'pixelle', 'video-editor', 'video editor'].some(k => n.includes(k)));
  const hasFetcher = installedSkillNames.some((n: string) => ['fetcher', 'web'].some(k => n.includes(k)));
  const hasDesktop = installedSkillNames.some((n: string) => ['desktop', 'commander'].some(k => n.includes(k)));

  const quickSuggestions = [
    { id: 'chat', label: t.suggestChat || uiMessage('agent-chat-page.just-chat.7c27608f4f'), prompt: uiMessage('agent-chat-page.hi-lumi-any-interesting-discoveries.7f551f39b3'), show: true },
    { id: 'creative', label: t.suggestCreative || uiMessage('agent-chat-page.generate-image.bc8f1ebf69'), prompt: uiMessage('agent-chat-page.generate-an-image-of-a.c9d2d59ffd'), show: hasCreativeSkill },
    { id: 'fetch', label: t.suggestFetch || uiMessage('agent-chat-page.summarize-webpage.5a4d1f82b7'), prompt: uiMessage('agent-chat-page.fetch-this-article-and-summarize.56b2a4e0a2'), show: hasFetcher },
    { id: 'desktop', label: t.suggestDesktop || uiMessage('agent-chat-page.organize-desktop.7b61137114'), prompt: uiMessage('agent-chat-page.organize-the-desktop-files-by.6e88097cfe'), show: hasDesktop },
    { id: 'music', label: t.suggestMusic || uiMessage('agent-chat-page.create-music.b1c541ba28'), prompt: uiMessage('agent-chat-page.create-a-calm-piano-track.4d8e126213'), show: hasCreativeSkill },
  ];

  const visibleSuggestions = quickSuggestions.filter(s => s.show).slice(0, 4);

  const { callState, audioLevel, startCall, endCall, error: callError } = useVoiceCall({
    socket,
    onTranscript: (text, isFinal) => {
      if (isFinal) {
        if (inputDictationActiveRef.current) {
          const transcript = String(text || '').trim();
          if (transcript) {
            const current = draftTextRef.current.trim();
            setDraftText([current, transcript].filter(Boolean).join('\n'));
          }
          return;
        }
        setMessages(prev => [...prev, {
          id: makeChatMessageId('voice'),
          text,
          userName: user?.displayName || user?.username || 'You',
          timestamp: new Date().toISOString(),
          type: 'user',
          source: 'voice',
        }]);
      }
    },
  });

  useEffect(() => {
    listVoices().then(data => {
      const all = [...data.cloned, ...data.premade];
      setVoices(all);
      if (all.length > 0 && !selectedVoiceId) {
        setSelectedVoiceId(all[0].voiceId);
      }
    }).catch(err => toast.error(t.failedToLoadVoices || 'Failed to load voices'));
  }, [selectedVoiceId, t.failedToLoadVoices]);

  useEffect(() => {
    if (callError) toast.error(callError);
  }, [callError]);

  // Click outside to close voice picker
  useEffect(() => {
    if (!showVoicePicker) return;
    const onClick = (e: MouseEvent) => {
      if (voicePickerRef.current && !voicePickerRef.current.contains(e.target as Node)) {
        setShowVoicePicker(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showVoicePicker]);

  useEffect(() => {
    if (!showAttachmentMenu) return;
    const onClick = (event: MouseEvent) => {
      if (attachmentMenuRef.current && !attachmentMenuRef.current.contains(event.target as Node)) {
        setShowAttachmentMenu(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showAttachmentMenu]);

  const messageInputRef = useRef<HTMLInputElement>(null);
  const draftTextRef = useRef('');
  const [hasDraftText, setHasDraftText] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [optimizationProgress, setOptimizationProgress] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);
  const [conversationAttachments, setConversationAttachments] = useState<ChatAttachment[]>([]);
  const conversationAttachmentsRef = useRef<ChatAttachment[]>([]);
  const attachmentConversationIdRef = useRef('');
  const [attachmentContextStorageKey, setAttachmentContextStorageKey] = useState('');
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const nativeDropHandledAtRef = useRef(0);
  const [knowledgeFiles, setKnowledgeFiles] = useState<FileEntry[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [conversationHistoryOpen, setConversationHistoryOpen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryItem[]>([]);
  const [conversationHistoryLoading, setConversationHistoryLoading] = useState(false);
  const [restoringConversationId, setRestoringConversationId] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('idle');
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [backgroundWorkflowTasks, setBackgroundWorkflowTasks] = useState<BackgroundWorkflowTask[]>([]);
  const [chatProgressLines, setChatProgressLines] = useState<ChatProgressLine[]>([]);
  const recognition = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentNameRef = useRef<string>('Lumi');
  const seenWorkflowToolEvents = useRef<Set<string>>(new Set());
  const backgroundTaskStatusRef = useRef<Map<string, string>>(new Map());
  const lastChatProgressTextRef = useRef('');
  const chatProgressClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRequestHadToolRef = useRef(false);
  const currentRequestNeedsEvidenceRef = useRef(false);
  const currentResponseFinalizationRef = useRef<ChatResponseFinalization | null>(null);
  const messagesRef = useRef<any[]>([]);
  const activeChatViewDetachRef = useRef<(() => void) | null>(null);
  const conversationHistoryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    if (inputDictationActiveRef.current && callState === 'idle') {
      inputDictationActiveRef.current = false;
      endCall();
      setIsListening(false);
    }
  }, [callState, endCall]);

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

  const clearChatProgress = useCallback(() => {
    if (chatProgressClearTimerRef.current) {
      clearTimeout(chatProgressClearTimerRef.current);
      chatProgressClearTimerRef.current = null;
    }
    lastChatProgressTextRef.current = '';
    setChatProgressLines([]);
  }, []);

  const pushChatProgress = useCallback((text: string, tone: ChatProgressTone = 'thinking') => {
    const clean = String(text || '').trim();
    if (!clean || lastChatProgressTextRef.current === clean) return;
    lastChatProgressTextRef.current = clean;
    if (chatProgressClearTimerRef.current) {
      clearTimeout(chatProgressClearTimerRef.current);
      chatProgressClearTimerRef.current = null;
    }
    const now = Date.now();
    setChatProgressLines(prev => [
      ...prev,
      {
        id: `chat-progress-${now}-${Math.random().toString(36).slice(2, 6)}`,
        text: clean,
        tone,
        time: now,
      },
    ].slice(-4));
  }, []);

  const finishChatProgress = useCallback((text: string, tone: ChatProgressTone = 'done') => {
    pushChatProgress(text, tone);
    if (chatProgressClearTimerRef.current) clearTimeout(chatProgressClearTimerRef.current);
    chatProgressClearTimerRef.current = setTimeout(() => {
      lastChatProgressTextRef.current = '';
      setChatProgressLines([]);
      chatProgressClearTimerRef.current = null;
    }, 4200);
  }, [pushChatProgress]);

  useEffect(() => () => {
    if (chatProgressClearTimerRef.current) clearTimeout(chatProgressClearTimerRef.current);
  }, []);

  const cancelBackgroundWorkflowTask = useCallback((taskId: string) => {
    socket?.emit('agent:background_cancel', { taskId });
    setBackgroundWorkflowTasks(prev => prev.map(task =>
      task.id === taskId ? { ...task, status: 'cancelling' } : task
    ));
  }, [socket]);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/autonomy/background-tasks', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!Array.isArray(data?.tasks)) return;
        data.tasks.slice(0, 6).forEach((task: BackgroundWorkflowTask) => upsertBackgroundWorkflowTask(task));
      })
      .catch(() => {});
  }, [isOpen, upsertBackgroundWorkflowTask]);

  const updateDraftText = useCallback((value: string) => {
    draftTextRef.current = value;
    const nextHasDraft = value.trim().length > 0;
    setHasDraftText(prev => prev === nextHasDraft ? prev : nextHasDraft);
  }, []);

  const setDraftText = useCallback((value: string) => {
    updateDraftText(value);
    if (messageInputRef.current) messageInputRef.current.value = value;
  }, [updateDraftText]);

  // Escape to close panels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showVoicePicker) setShowVoicePicker(false);
        if (showWeChatSettings) setShowWeChatSettings(false);
        if (showAttachmentMenu) setShowAttachmentMenu(false);
        if (conversationHistoryOpen) setConversationHistoryOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversationHistoryOpen, showAttachmentMenu, showVoicePicker, showWeChatSettings]);

  const agentName = agent?.name || (t.lumiEssence || 'Lumi Essence');
  const agentCategory = agent?.category || (t.friend || 'friend');
  const agentId = agent?.id || 'lumi';
  const attachmentContextStoragePrefix = `lumi_chat_attachment_context:${user?.id || user?.username || 'anonymous'}:${buildChatConversationScopeKey(agentId, activeDomain, activeOrgId)}`;
  const bindAttachmentContextToConversation = useCallback((
    conversationId: string,
    options: { carryCurrent?: boolean } = {},
  ) => {
    const nextConversationId = String(conversationId || '').trim();
    if (!nextConversationId) {
      attachmentConversationIdRef.current = '';
      setAttachmentContextStorageKey('');
      conversationAttachmentsRef.current = [];
      setConversationAttachments([]);
      return;
    }
    if (attachmentConversationIdRef.current === nextConversationId) return;
    const nextStorageKey = `${attachmentContextStoragePrefix}:${nextConversationId}`;
    let nextAttachments = options.carryCurrent ? conversationAttachmentsRef.current : [];
    if (!options.carryCurrent) {
      try {
        nextAttachments = parseChatAttachmentContext(localStorage.getItem(nextStorageKey));
        if (nextAttachments.length === 0) localStorage.removeItem(nextStorageKey);
      } catch {
        nextAttachments = [];
      }
    }
    attachmentConversationIdRef.current = nextConversationId;
    setAttachmentContextStorageKey(nextStorageKey);
    conversationAttachmentsRef.current = nextAttachments;
    setConversationAttachments(nextAttachments);
    if (options.carryCurrent && nextAttachments.length > 0) {
      try {
        localStorage.setItem(nextStorageKey, serializeChatAttachmentContext(nextAttachments));
      } catch {}
    }
  }, [attachmentContextStoragePrefix]);
  useEffect(() => {
    const onConversationClosed = (event: Event) => {
      const closedConversationId = String((event as CustomEvent<{ conversationId?: string }>).detail?.conversationId || '');
      if (!closedConversationId || closedConversationId !== attachmentConversationIdRef.current) return;
      try {
        localStorage.removeItem(`${attachmentContextStoragePrefix}:${closedConversationId}`);
      } catch {}
      bindAttachmentContextToConversation('');
    };
    window.addEventListener('lumi:conversation-closed', onConversationClosed);
    return () => window.removeEventListener('lumi:conversation-closed', onConversationClosed);
  }, [attachmentContextStoragePrefix, bindAttachmentContextToConversation]);
  const scopedConversationUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}domain=${encodeURIComponent(activeDomain)}&agentId=${encodeURIComponent(agentId)}`;
  }, [activeDomain, agentId]);
  useEffect(() => {
    if (!conversationHistoryOpen) return;
    const onClick = (event: MouseEvent) => {
      if (conversationHistoryRef.current && !conversationHistoryRef.current.contains(event.target as Node)) {
        setConversationHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [conversationHistoryOpen]);
  const scopedFileUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    const orgScope = activeDomain === 'work' && activeOrgId
      ? `&orgId=${encodeURIComponent(activeOrgId)}`
      : '';
    return `${path}${separator}domain=${encodeURIComponent(activeDomain)}${orgScope}`;
  }, [activeDomain, activeOrgId]);
  const refreshKnowledgeFiles = useCallback(async () => {
    setKnowledgeLoading(true);
    try {
      const res = await fetch(scopedFileUrl('/api/files/list'), { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data.files) ? data.files as FileEntry[] : [];
      setKnowledgeFiles([...list].sort((a, b) =>
        new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime(),
      ));
    } catch {
      // Knowledge status is a convenience surface; chat itself should stay usable.
    } finally {
      setKnowledgeLoading(false);
    }
  }, [scopedFileUrl]);
  const notifyKnowledgeUpdated = useCallback((files?: Array<{ id?: string; name?: string; displayName?: string }>) => {
    const detail: KnowledgeUpdateDetail = {
      domain: activeDomain,
      orgId: activeOrgId || undefined,
      files,
    };
    window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', { detail }));
    window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
  }, [activeDomain, activeOrgId]);

  const isKnowledgeReady = useCallback((file: FileEntry) => {
    const status = String(file.extractionStatus || file.status || '');
    if (status === 'indexed' || status === 'partial') return true;
    const targetAgentId = activeDomain === 'work' ? 'org-kb' : 'lumi';
    return Array.isArray(file.agentIds) && file.agentIds.includes(targetAgentId);
  }, [activeDomain]);

  const readyKnowledgeCount = useMemo(() => knowledgeFiles.filter(isKnowledgeReady).length, [isKnowledgeReady, knowledgeFiles]);
  const knowledgeStatusText = knowledgeFiles.length > 0
    ? formatUiMessage('agent-chat-page.value0-value1-knowledge-files-available.ff2ac54c48', { value0: readyKnowledgeCount, value1: knowledgeFiles.length })
    : knowledgeLoading
      ? uiMessage('agent-chat-page.syncing-knowledge.21a09d4faa')
      : uiMessage('agent-chat-page.no-knowledge-files.40ce139e3c');
  const fileKindLabel = useCallback((kind: ChatFilePanelItem['kind']) => {
    if (kind === 'deck') return uiMessage('agent-chat-page.presentation.1c730b18ce');
    if (kind === 'sheet') return uiMessage('agent-chat-page.spreadsheet.93f365c65d');
    if (kind === 'pdf') return 'PDF';
    if (kind === 'cad') return 'CAD';
    if (kind === 'image') return uiMessage('agent-chat-page.image.07bb82eb07');
    if (kind === 'audio') return uiMessage('agent-chat-page.audio.2fd1cbe8ae');
    if (kind === 'document') return uiMessage('agent-chat-page.document.c4e0476ce2');
    return uiMessage('agent-chat-page.file.9588151a85');
  }, []);
  const generatedChatFiles = useMemo(() => {
    const collected: GeneratedFileLink[] = [];
    for (const message of messages) {
      const text = getDisplayText(message);
      if (!text) continue;
      collected.push(...extractGeneratedFiles(text));
    }

    const seen = new Set<string>();
    const uniqueRecent: GeneratedFileLink[] = [];
    for (const file of [...collected].reverse()) {
      const key = file.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueRecent.push(file);
      if (uniqueRecent.length >= 10) break;
    }
    return uniqueRecent;
  }, [messages]);

  const openNativeFilePath = useCallback(async (target?: string | null): Promise<boolean> => {
    if (platform !== 'tauri' || !target) return false;
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ success: boolean; output: string }>('open_item', { target });
    if (!result?.success) throw new Error(result?.output || 'Open file failed');
    return true;
  }, [platform]);

  const openChatFile = useCallback(async (file: Pick<ChatFilePanelItem, 'fileName' | 'fileId' | 'path' | 'openUrl' | 'saveUrl'>) => {
    const payload = file.fileId
      ? { id: file.fileId }
      : file.path
        ? { path: file.path }
        : null;

    if (file.path) {
      try {
        const openedNatively = await openNativeFilePath(file.path);
        if (openedNatively) {
          toast.success(formatUiMessage('agent-chat-page.opened-value0.4bd8105ea5', { value0: file.path }));
          return;
        }
      } catch (err: any) {
        console.debug('[AgentChat] Native file open failed; falling back to server open:', err?.message || err);
      }
    }

    if (payload) {
      try {
        const res = await fetch(scopedFileUrl('/api/files/open'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || 'Open file failed');
        }
        const data = await res.json().catch(() => ({}));
        toast.success(formatUiMessage('agent-chat-page.requested-system-open-value0.43fcf5747f', { value0: data.path || file.fileName }));
        return;
      } catch (err: any) {
        if (!file.openUrl && !file.saveUrl) {
          toast.error(err?.message || uiMessage('agent-chat-page.failed-to-open-file.8c8df8ffc5'));
          return;
        }
        toast.error(uiMessage('agent-chat-page.default-app-failed-opening-the.56984c4d66'));
      }
    }

    const fallbackUrl = file.openUrl || file.saveUrl;
    if (fallbackUrl && typeof window !== 'undefined') {
      try {
        window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      } catch (err: any) {
        toast.error(err?.message || uiMessage('agent-chat-page.could-not-open-preview-link.99248ef9e6'));
      }
    }
  }, [openNativeFilePath, scopedFileUrl]);

  const chatFileSections = useMemo(() => {
    const pending: ChatFilePanelItem[] = pendingAttachments.map(item => ({
      id: `pending-${item.id}`,
      fileName: item.fileName,
      subtitle: item.transcript ? uiMessage('agent-chat-page.transcribed-attachment.08a3fe2e67') : uiMessage('agent-chat-page.current-attachment.6500636ab4'),
      kind: item.kind,
      source: 'pending',
      fileId: item.fileId,
      path: item.path,
      openUrl: item.downloadUrl,
      saveUrl: item.fileId ? scopedFileUrl(`/api/files/download/${encodeURIComponent(item.fileId)}`) : item.downloadUrl,
      status: item.transcript ? 'STT' : undefined,
      mimeType: item.mimeType,
      size: item.size,
    }));

    const generated: ChatFilePanelItem[] = generatedChatFiles.map(file => ({
      id: `generated-panel-${file.id}`,
      fileName: file.fileName,
      subtitle: uiMessage('agent-chat-page.generated-by-lumi.27ac470b2c'),
      kind: file.kind,
      source: 'generated',
      path: file.path,
      openUrl: file.url,
      saveUrl: file.url,
    }));

    const knowledge: ChatFilePanelItem[] = knowledgeFiles.slice(0, 12).map(file => {
      const fileName = file.displayName || file.name || file.id;
      const kind: ChatFilePanelItem['kind'] = isImageFileName(fileName)
        ? 'image'
        : isAudioFileName(fileName)
          ? 'audio'
          : generatedFileKind(fileName);
      const ready = isKnowledgeReady(file);
      return {
        id: `knowledge-${file.id}`,
        fileName,
        subtitle: ready ? uiMessage('agent-chat-page.available-for-chat.46797753d0') : uiMessage('agent-chat-page.knowledge-file.890340ad5c'),
        kind,
        source: 'knowledge',
        fileId: file.id,
        path: file.path,
        openUrl: scopedFileUrl(`/api/files/download/${encodeURIComponent(file.id)}?inline=1`),
        saveUrl: scopedFileUrl(`/api/files/download/${encodeURIComponent(file.id)}`),
        status: ready ? undefined : (file.extractionStatus || file.status),
        size: file.rawSize,
      };
    });

    return { pending, generated, knowledge };
  }, [generatedChatFiles, isKnowledgeReady, knowledgeFiles, pendingAttachments, scopedFileUrl]);
  const pendingAttachmentKeys = useMemo(
    () => new Set(pendingAttachments.map(chatAttachmentIdentity)),
    [pendingAttachments],
  );
  const referenceableChatFiles = useMemo(
    () => [...chatFileSections.generated, ...chatFileSections.knowledge].slice(0, 8),
    [chatFileSections.generated, chatFileSections.knowledge],
  );
  const requestMeetingMode = useCallback(() => {
    window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode'));
  }, []);
  const isFounder = agentId === 'founder'
    || agentCategory === 'founder'
    || agentName.includes('Founder')
    || CN_FOUNDER_ALIASES.some(alias => agentName.includes(alias));

  useEffect(() => {
    if (!isOpen || isFounder) return;
    void refreshKnowledgeFiles();

    const onKnowledgeUpdated = (event: Event) => {
      const detail = (event as CustomEvent<KnowledgeUpdateDetail>).detail || {};
      if (detail.domain && detail.domain !== activeDomain) return;
      if (detail.orgId && activeOrgId && detail.orgId !== activeOrgId) return;
      void refreshKnowledgeFiles();
    };

    window.addEventListener('lumi:knowledge-updated', onKnowledgeUpdated);
    window.addEventListener('lumi:client-state-refresh', onKnowledgeUpdated);
    return () => {
      window.removeEventListener('lumi:knowledge-updated', onKnowledgeUpdated);
      window.removeEventListener('lumi:client-state-refresh', onKnowledgeUpdated);
    };
  }, [activeDomain, activeOrgId, isFounder, isOpen, refreshKnowledgeFiles]);

  useEffect(() => {
    if (!socket || !isOpen || isFounder) return;
    socket.on('memories:changed', refreshKnowledgeFiles);
    return () => { socket.off('memories:changed', refreshKnowledgeFiles); };
  }, [isFounder, isOpen, refreshKnowledgeFiles, socket]);

  useEffect(() => { agentNameRef.current = agentName; }, [agentName]);

  useEffect(() => {
    // Initialize Speech Recognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognition.current = new SpeechRecognition();
      recognition.current.continuous = false;
      recognition.current.interimResults = false;
      recognition.current.lang = 'zh-CN'; // Default to Chinese, can be dynamic

      recognition.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setDraftText(transcript);
        setIsListening(false);
      };

      recognition.current.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
        toast.error(`${t.speechNotSupported || 'Speech recognition error'}: ${event.error}`);
      };

      recognition.current.onend = () => {
        setIsListening(false);
      };
    }
  }, [setDraftText, t.speechNotSupported]);

  const handleCopyMessage = useCallback(async (text: string, id: string, container?: HTMLElement | null) => {
    try {
      await navigator.clipboard.writeText(getSelectedTextWithin(container) || text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  }, []);

  const renderGeneratedFiles = useCallback((files: GeneratedFileLink[], align: 'start' | 'end' = 'start') => {
    if (files.length === 0) return null;
    const labelFor = (kind: GeneratedFileLink['kind']) => {
      if (kind === 'deck') return uiMessage('agent-chat-page.presentation.1c730b18ce');
      if (kind === 'sheet') return uiMessage('agent-chat-page.spreadsheet.93f365c65d');
      if (kind === 'pdf') return 'PDF';
      if (kind === 'cad') return 'CAD';
      if (kind === 'image') return uiMessage('agent-chat-page.image.07bb82eb07');
      if (kind === 'document') return uiMessage('agent-chat-page.document.c4e0476ce2');
      return uiMessage('agent-chat-page.file.9588151a85');
    };

    return (
      <div className={`max-w-[92%] mb-3 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {files.map(file => (
          <div
            key={file.id}
            className="group flex min-w-0 max-w-[300px] items-center gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-400/10 px-3 py-2.5 text-left transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15"
            title={file.path}
          >
            <button
              type="button"
              onClick={() => openChatFile({ fileName: file.fileName, path: file.path, openUrl: file.url, saveUrl: file.url })}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-200">
              {file.kind === 'image' ? <ImageIcon size={17} /> : <FileText size={17} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-white/80">{file.fileName}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-emerald-100/55">
                <ExternalLink size={11} />
                <span>{labelFor(file.kind)}</span>
              </div>
            </div>
            </button>
          </div>
        ))}
      </div>
    );
  }, [openChatFile]);

  const buildSearchDisplayMessages = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return messages;

    const localMatches = messages.filter(m =>
      m.text && String(m.text).toLowerCase().includes(query)
    );
    const seen = new Set<string>();
    const merged = [...localMatches, ...searchResults].filter((m) => {
      const key = `${m.id || ''}|${m.timestamp || ''}|${m.type || ''}|${m.text || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return merged;
  }, [messages, searchQuery, searchResults]);

  const searchDisplayMessages = buildSearchDisplayMessages();

  const normalizePersistedMessages = useCallback((rawMessages: any[]) => {
    const normalized: any[] = [];
    const userName = user?.displayName || user?.username || (t.chatUserFallback || 'User');
    const agentDisplayName = agentNameRef.current || 'Lumi';

    const pushMessage = (message: any) => {
      if (!message.text || !String(message.text).trim()) return;
      normalized.push(message);
    };

    rawMessages.forEach((m: any, index: number) => {
      const baseId = m.id || `persisted-${index}`;
      const timestamp = m.timestamp || m.createdAt || new Date().toISOString();
      const role = m.role || '';
      const userText = role === 'assistant' ? '' : stripStoredAttachmentSummary(m.content || m.message || '');
      const assistantText = role === 'assistant'
        ? (m.content || m.message || m.response || '')
        : (m.response || '');

      if (role !== 'tool' && userText) {
        pushMessage({
          id: `${baseId}-user`,
          text: userText,
          userName,
          timestamp,
          type: 'user',
          mode: m.mode,
        });
      }

      if (assistantText) {
        pushMessage({
          id: `${baseId}-assistant`,
          text: assistantText,
          userName: agentDisplayName,
          timestamp,
          type: 'agent',
          mode: m.mode,
        });
      }
    });

    const seen = new Set<string>();
    return normalized.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [user?.displayName, user?.username, t.chatUserFallback]);

  useEffect(() => {
    if (!agentId || isFounder) return;

    // On agent/domain switch, reset and reload
    const conversationScopeKey = `${user?.id || user?.username || 'anonymous'}:${buildChatConversationScopeKey(agentId, activeDomain, activeOrgId)}`;
    if (conversationScopeKey !== lastConversationScopeRef.current) {
      lastConversationScopeRef.current = conversationScopeKey;
      initialLoadDoneRef.current = false;
      try {
        // Remove the pre-fix scope-only key, which could contain plaintext and
        // could incorrectly survive into a different conversation.
        localStorage.removeItem(attachmentContextStoragePrefix);
      } catch {}
      setMessages([]);
      messagesRef.current = [];
      setPendingAttachments([]);
      pendingAttachmentsRef.current = [];
      bindAttachmentContextToConversation('');
    }

    // Only load once; do not overwrite live conversation.
    if (initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;

    // Load the single active conversation messages
    fetch(scopedConversationUrl('/api/conversations/active'))
        .then(r => r.json())
        .then(async (data) => {
          const conv = data.activeConversation;
          if (conv) {
            bindAttachmentContextToConversation(conv.id);
            const msgRes = await fetch(scopedConversationUrl(`/api/conversations/${conv.id}/messages?limit=${CHAT_HISTORY_LIMIT}`));
            const msgData = await msgRes.json();
            if (msgData.messages && Array.isArray(msgData.messages)) {
              setMessages(normalizePersistedMessages(msgData.messages));
            }
          }
        })
        .catch(() => {});
  }, [activeDomain, activeOrgId, agentId, attachmentContextStoragePrefix, bindAttachmentContextToConversation, isFounder, normalizePersistedMessages, scopedConversationUrl, user?.id, user?.username]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !agentId || isFounder) {
      setSearchResults([]);
      setIsSearchingHistory(false);
      setSearchError('');
      return;
    }

    let cancelled = false;
    setIsSearchingHistory(true);
    setSearchError('');

    const timer = setTimeout(() => {
      fetch(scopedConversationUrl(`/api/conversations/search?q=${encodeURIComponent(query)}&limit=${CHAT_SEARCH_LIMIT}`))
        .then(async r => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || 'Search failed');
          if (!cancelled) {
            setSearchResults(normalizePersistedMessages(data.results || []));
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchError(err?.message || 'Search failed');
          }
        })
        .finally(() => {
          if (!cancelled) setIsSearchingHistory(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agentId, isFounder, normalizePersistedMessages, scopedConversationUrl, searchQuery]);

  const streamingMsgId = useRef<string | null>(null);
  const textChatActiveRef = useRef(false);
  const activeChatRequestIdRef = useRef<string | null>(null);
  const lastResumedRequestIdRef = useRef<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const lastConversationScopeRef = useRef<string>('');
  const activeExecutionStorageKey = `lumi_active_chat_execution:${agentId}:${activeDomain}:${activeOrgId || ''}`;
  const persistActiveExecution = useCallback((requestId: string) => {
    try {
      const execution: PersistedChatExecution = {
        requestId,
        source: 'chat',
        domain: activeDomain,
        orgId: activeOrgId || undefined,
        conversationId: attachmentConversationIdRef.current || undefined,
        startedAt: new Date().toISOString(),
      };
      localStorage.setItem(activeExecutionStorageKey, JSON.stringify(execution));
    } catch {}
  }, [activeDomain, activeExecutionStorageKey, activeOrgId]);
  const clearPersistedExecution = useCallback((requestId?: string) => {
    try {
      if (requestId) {
        const current = JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null') as PersistedChatExecution | null;
        if (current?.requestId && current.requestId !== requestId) return;
      }
      localStorage.removeItem(activeExecutionStorageKey);
    } catch {}
  }, [activeExecutionStorageKey]);

  useEffect(() => {
    if (isFounder || !socket) return;

    const isCurrentChatEvent = (data?: { requestId?: string; source?: string; conversationId?: string }) => {
      if (data?.conversationId && data.conversationId !== attachmentConversationIdRef.current) return false;
      const activeRequestId = activeChatRequestIdRef.current;
      if (activeRequestId) return data?.requestId === activeRequestId;
      if (data?.requestId) return false;
      if (data?.source && data.source !== 'chat') return false;
      return textChatActiveRef.current;
    };

    const onProactive = (data: {
      message: string;
      timestamp: string;
      requestId?: string;
      conversationId?: string;
      source?: string;
      type?: string;
      taskId?: string;
      finalized?: boolean;
      blocked?: boolean;
      reason?: string;
    }) => {
      const proactiveType = data.type || data.taskId;
      if (proactiveType === 'greeting' && localStorage.getItem('lumi_allow_proactive_voice') !== 'true') return;
      if ((data.requestId || data.source) && !isCurrentChatEvent(data)) return;
      if (!shouldDisplayAgentResponse({ ...data, text: data.message })) return;
      setMessages(prev => {
        if (prev.some(m => m.text === data.message && m.type === 'agent')) return prev;
        return [...prev, {
          id: `proactive-${Date.now()}`,
          text: data.message,
          userName: agentName,
          timestamp: data.timestamp || new Date().toISOString(),
          type: 'agent',
          source: 'proactive',
        }];
      });
    };

    const onChunk = (data: { text: string; agentName: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      if (streamingMsgId.current) {
        setMessages(prev => prev.map(m =>
          m.id === streamingMsgId.current ? { ...m, text: m.text + data.text } : m
        ));
      } else {
        const id = makeChatMessageId('stream');
        streamingMsgId.current = id;
        setMessages(prev => [...prev, {
          id,
          text: data.text,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent'
        }]);
      }
    };

    const onTool = (data: { correlationId?: string; name: string; args?: any; arguments?: any; result?: string; error?: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const args = data.arguments ?? data.args;
      const phase = data.error !== undefined ? 'error' : data.result !== undefined ? 'result' : 'start';
      const workflowEventKey = data.correlationId
        ? `${data.correlationId}:${phase}`
        : `${data.name}:${phase}:${String(data.result ?? data.error ?? '').slice(0, 120)}`;
      if (seenWorkflowToolEvents.current.has(workflowEventKey)) return;
      seenWorkflowToolEvents.current.add(workflowEventKey);

      setWorkflowStatus('executing');
      currentRequestHadToolRef.current = true;
      pushChatProgress(describeToolProgress(data.name, phase, isZh), phase === 'error' ? 'error' : 'tool');
      if (data.result !== undefined) {
        setWorkflowSteps(prev => [...prev, {
          id: `chat-tool-ok-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'tool_result',
          text: `${data.name}: ${uiMessage('chat-progress.tool-returned-result-awaiting-task-verification.4f8d02cb71', (isZh) ? 'zh' : 'en')}`,
          detail: data.result?.slice(0, 100),
          time: Date.now(),
        }]);
      } else if (data.error !== undefined) {
        setWorkflowSteps(prev => [...prev, {
          id: `chat-tool-err-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'error',
          text: `${data.name} ${t.workflowToolFailed || 'failed'}`,
          detail: data.error?.slice(0, 100),
          time: Date.now(),
        }]);
      } else {
        const argsSummary = args
          ? Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : String(v).slice(0, 30)}`).join(', ')
          : '';
        setWorkflowSteps(prev => [...prev, {
          id: `chat-tool-start-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'tool_start',
          text: `${t.workflowCalling || 'Calling'} ${data.name}`,
          detail: argsSummary || undefined,
          time: Date.now(),
        }]);
      }
    };

    const onProgress = (data: { text?: string; tone?: ChatProgressTone; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      pushChatProgress(data.text || '', data.tone || 'tool');
    };

    const onResponse = (data: {
      text: string;
      agentName: string;
      source?: string;
      requestId?: string;
      conversationId?: string;
      finalized?: boolean;
      blocked?: boolean;
      reason?: string;
    }) => {
      if (!isCurrentChatEvent(data)) return;
      clearPersistedExecution(data.requestId);
      if (!data.requestId || activeChatRequestIdRef.current === data.requestId) {
        activeChatRequestIdRef.current = null;
        textChatActiveRef.current = false;
      }
      const finalization: ChatResponseFinalization = {
        finalized: data.finalized,
        blocked: data.blocked,
        reason: data.reason,
      };
      currentResponseFinalizationRef.current = finalization;
      setIsTyping(false);
      if (!shouldDisplayAgentResponse(data)) {
        setWorkflowStatus('error');
        const rejected = describeTurnCompletionProgress(
          isZh,
          currentRequestHadToolRef.current,
          true,
          { finalized: false, blocked: true, reason: data.reason },
        );
        finishChatProgress(rejected.text, rejected.tone);
        setWorkflowSteps(prev => [...prev, {
          id: makeChatMessageId('chat-rejected'),
          type: 'error',
          text: t.workflowError || 'Processing blocked',
          detail: data.reason,
          time: Date.now(),
        }]);
        if (streamingMsgId.current) {
          const sid = streamingMsgId.current;
          setMessages(prev => prev.filter(m => m.id !== sid));
          streamingMsgId.current = null;
        }
        setTimeout(() => {
          setWorkflowStatus('idle');
          setWorkflowSteps([]);
          seenWorkflowToolEvents.current.clear();
        }, 5000);
        return;
      }
      const finalizedSuccess = isFinalizedSuccessfulResponse(data);
      const terminalReason = String(data.reason || '').trim().toLowerCase();
      const wasCancelled = terminalReason === 'cancelled' || terminalReason === 'canceled';
      setWorkflowStatus(
        wasCancelled
          ? 'cancelled'
          : data.blocked ? 'error' : finalizedSuccess ? 'done' : 'idle'
      );
      const completion = describeTurnCompletionProgress(
        isZh,
        currentRequestHadToolRef.current,
        currentRequestNeedsEvidenceRef.current,
        finalization,
      );
      finishChatProgress(completion.text, completion.tone);
      if (data.blocked || finalizedSuccess) {
        setWorkflowSteps(prev => [...prev, {
          id: makeChatMessageId('chat-resp'),
          type: data.blocked && !wasCancelled ? 'error' : 'response',
          text: wasCancelled
            ? uiMessage('agent-chat-page.execution-cancelled.4ec843f670', isZh ? 'zh' : 'en')
            : data.blocked ? (t.workflowError || 'Processing blocked') : (t.workflowResponseReady || 'Response ready'),
          detail: (data.reason || data.text)?.slice(0, 100),
          time: Date.now(),
        }]);
        setTimeout(() => {
          setWorkflowStatus('idle');
          setWorkflowSteps([]);
          seenWorkflowToolEvents.current.clear();
        }, 5000);
      }
      if (streamingMsgId.current) {
        // Finalize streamed message; keep chunked text if response text is empty.
        const finalText = (data.text && data.text.trim()) ? data.text : null;
        setMessages(prev => prev.map(m =>
          m.id === streamingMsgId.current
            ? { ...m, text: finalText || m.text }
            : m
        ));
        streamingMsgId.current = null;
      } else if (data.text && data.text.trim()) {
        // No streaming; add as new message only if non-empty.
        setMessages(prev => [...prev, {
          id: makeChatMessageId('agent'),
          text: data.text,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent'
        }]);
      }
      // Auto-speak disabled
    };

    const onStatus = (data: { status: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const activeStatus = ['thinking', 'responding', 'executing', 'waiting_confirmation', 'cancelling'].includes(data.status);
      setIsTyping(activeStatus);
      if (data.status === 'thinking') {
        setWorkflowStatus('thinking');
        pushChatProgress(uiMessage('agent-chat-page.i-am-figuring-out-how.017a8f967e', (isZh) ? 'zh' : 'en'), 'thinking');
        setWorkflowSteps(prev => {
          const last = prev[prev.length - 1];
          if (last?.type === 'thinking' && Date.now() - last.time < 1200) return prev;
          return [...prev, {
            id: `chat-thinking-${Date.now()}`,
            type: 'thinking',
            text: t.workflowAnalyzing || 'Analyzing your request...',
            time: Date.now(),
          }];
        });
      } else if (data.status === 'responding' || data.status === 'executing') {
        setWorkflowStatus('executing');
      } else if (data.status === 'waiting_confirmation') {
        setWorkflowStatus('waiting_confirmation');
      } else if (data.status === 'cancelling') {
        setWorkflowStatus('cancelling');
      } else if (data.status === 'idle') {
        setIsTyping(false);
        if (currentResponseFinalizationRef.current) return;
        setWorkflowStatus('idle');
        clearChatProgress();
        setWorkflowSteps([]);
        seenWorkflowToolEvents.current.clear();
      } else if (isTerminalAgentStatus(data.status)) {
        setIsTyping(false);
        setWorkflowStatus('error');
        finishChatProgress(
          uiMessage('agent-chat-page.something-went-wrong-i-am.01c198a67b', (isZh) ? 'zh' : 'en'),
          'error'
        );
        setTimeout(() => {
          setWorkflowStatus('idle');
          setWorkflowSteps([]);
          seenWorkflowToolEvents.current.clear();
        }, 5000);
      }
      if (isTerminalAgentStatus(data.status)) {
        // Drop partial streaming chunks that were never finalized
        if (streamingMsgId.current) {
          const sid = streamingMsgId.current;
          setMessages(prev => prev.filter(m => m.id !== sid));
          streamingMsgId.current = null;
        }
      }
    };

    const onError = (data: { message: string; code?: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      clearPersistedExecution(data.requestId);
      if (!data.requestId || activeChatRequestIdRef.current === data.requestId) {
        activeChatRequestIdRef.current = null;
        textChatActiveRef.current = false;
      }
      setIsTyping(false);
      setWorkflowStatus('error');
      finishChatProgress(
        uiMessage('agent-chat-page.something-went-wrong-i-am.01c198a67b', (isZh) ? 'zh' : 'en'),
        'error'
      );
      setWorkflowSteps(prev => [...prev, {
        id: `chat-err-${Date.now()}`,
        type: 'error',
        text: t.workflowError || 'Processing failed',
        detail: data.message,
        time: Date.now(),
      }]);
      setTimeout(() => {
        setWorkflowStatus('idle');
        setWorkflowSteps([]);
        seenWorkflowToolEvents.current.clear();
      }, 5000);
      if (streamingMsgId.current) {
        const sid = streamingMsgId.current;
        setMessages(prev => prev.filter(m => m.id !== sid));
        streamingMsgId.current = null;
      }
      const message = data.message || (t.failedToRouteNeuralMesh || 'Failed to route through Neural Mesh.');
      setMessages(prev => {
        const text = `${t.requestFailed || 'Request failed'}\n\n${message}`;
        if (prev.some(m => m.type === 'agent' && m.text === text)) return prev;
        return [...prev, {
          id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          userName: agentNameRef.current || 'Lumi',
          timestamp: new Date().toISOString(),
          type: 'agent',
          source: 'error',
        }];
      });
    };

    // conversation_updated: only reload for non-text-chat channels (voice, etc.)
    // Text chat state is managed live via agent:chunk/agent:response; API reload here
    // would replace messages with different ids, causing React to remount & re-animate them.
    const onConversationUpdated = (data: {
      conversationId: string;
      agentId: string;
      source?: string;
      rolledOver?: boolean;
      previousConversationId?: string;
    }) => {
      if (data.agentId !== agentId) return;
      const currentConversationId = attachmentConversationIdRef.current;
      const isCurrentRollover = data.rolledOver === true
        && Boolean(currentConversationId)
        && data.previousConversationId === currentConversationId;
      if (data.conversationId && data.conversationId !== currentConversationId && (isCurrentRollover || !currentConversationId)) {
        bindAttachmentContextToConversation(data.conversationId, {
          carryCurrent: isCurrentRollover,
        });
      }
      if (currentConversationId && data.conversationId !== currentConversationId && !isCurrentRollover) return;
      const isExternalMessagingSync = /^(wechat|feishu|wecom)_bot$/.test(String(data.source || ''));
      if (data.source === 'chat' || (textChatActiveRef.current && !isExternalMessagingSync)) return;
      if (streamingMsgId.current) streamingMsgId.current = null;
      fetch(scopedConversationUrl(`/api/conversations/${data.conversationId}/messages?limit=${CHAT_HISTORY_LIMIT}`))
        .then(r => r.json())
        .then(result => {
          if (result.messages && Array.isArray(result.messages)) {
            setMessages(normalizePersistedMessages(result.messages));
          }
        })
        .catch(() => {});
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
      setWorkflowStatus(isActive ? 'background' : isFailed ? 'error' : 'done');
      setWorkflowSteps(prev => [...prev, {
        id: `chat-background-task-${task.id}-${task.status}-${Date.now()}`,
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

    const onDesktopControlState = (data: any) => {
      const id = `desktop-control-${String(data?.leaseId || data?.taskId || 'current')}`;
      const status = String(data?.status || '');
      if (status === 'released' || status === 'expired') {
        toast.dismiss(id);
      } else if (status === 'paused') {
        toast.warning('Lumi paused desktop control because user activity or a higher-priority task was detected.', { id, duration: 6000 });
      } else if (status === 'waiting') {
        toast('Desktop control is waiting for the current owner to finish.', { id, duration: 4000 });
      } else if (status === 'active') {
        toast('Lumi is controlling the desktop for the active task.', { id, duration: 2500 });
      }
    };

    socket.on("agent:proactive", onProactive);
    socket.on("agent:delegation", onDelegation);
    socket.on("agent:background_task_update", onBackgroundTaskUpdate);
    socket.on("agent:desktop_control_state", onDesktopControlState);
    socket.on("agent:chunk", onChunk);
    socket.on("agent:progress", onProgress);
    socket.on("agent:tool", onTool);
    socket.on("agent:tool_call", onTool);
    socket.on("agent:response", onResponse);
    socket.on("agent:status", onStatus);
    socket.on("agent:error", onError);
    socket.on("chat:conversation_updated", onConversationUpdated);

    return () => {
      socket.off("agent:proactive", onProactive);
      socket.off("agent:delegation", onDelegation);
      socket.off("agent:background_task_update", onBackgroundTaskUpdate);
      socket.off("agent:desktop_control_state", onDesktopControlState);
      socket.off("agent:chunk", onChunk);
      socket.off("agent:progress", onProgress);
      socket.off("agent:tool", onTool);
      socket.off("agent:tool_call", onTool);
      socket.off("agent:response", onResponse);
      socket.off("agent:status", onStatus);
      socket.off("agent:error", onError);
      socket.off("chat:conversation_updated", onConversationUpdated);
    };
  }, [
    activeDomain,
    activeOrgId,
    agentId,
    agentName,
    bindAttachmentContextToConversation,
    clearChatProgress,
    clearPersistedExecution,
    finishChatProgress,
    isFounder,
    isZh,
    normalizePersistedMessages,
    pushChatProgress,
    scopedConversationUrl,
    socket,
    t.failedToRouteNeuralMesh,
    t.requestFailed,
    t.workflowAnalyzing,
    t.workflowBackgroundTask,
    t.workflowCalling,
    t.workflowError,
    t.workflowResponseReady,
    t.workflowToolFailed,
    upsertBackgroundWorkflowTask,
  ]);

  useEffect(() => {
    if (isFounder || !socket) return;

    const resumeActiveExecution = () => {
      let persisted: PersistedChatExecution | null = null;
      try {
        persisted = JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null');
      } catch {
        localStorage.removeItem(activeExecutionStorageKey);
      }
      if (!persisted?.requestId) return;

      const startedAt = Date.parse(persisted.startedAt);
      if (!Number.isFinite(startedAt) || Date.now() - startedAt > ACTIVE_CHAT_EXECUTION_TTL_MS) {
        clearPersistedExecution(persisted.requestId);
        return;
      }

      activeChatRequestIdRef.current = persisted.requestId;
      textChatActiveRef.current = true;
      setIsTyping(true);
      if (lastResumedRequestIdRef.current !== persisted.requestId) {
        lastResumedRequestIdRef.current = persisted.requestId;
        pushChatProgress(uiMessage('agent-chat-page.restoring-task-state.0fb759a4dc', isZh ? 'zh' : 'en'), 'thinking');
      }

      socket.emit('agent:execution_resume', {
        requestId: persisted.requestId,
        source: 'chat',
        domain: persisted.domain,
        orgId: persisted.orgId || null,
        conversationId: persisted.conversationId,
      }, (result?: { ok?: boolean; snapshot?: ChatExecutionSnapshot; error?: string }) => {
        if (activeChatRequestIdRef.current !== persisted?.requestId) return;
        const snapshot = result?.snapshot;
        if (!result?.ok || !snapshot) {
          clearPersistedExecution(persisted?.requestId);
          activeChatRequestIdRef.current = null;
          textChatActiveRef.current = false;
          setIsTyping(false);
          setWorkflowStatus('error');
          pushChatProgress(
            result?.error || uiMessage('agent-chat-page.previous-task-not-recoverable.17e6ad375c', isZh ? 'zh' : 'en'),
            'error',
          );
          return;
        }

        if (snapshot.terminal) return; // The server replays the terminal event.
        if (snapshot.status === 'waiting_confirmation') setWorkflowStatus('waiting_confirmation');
        else if (snapshot.status === 'cancelling') setWorkflowStatus('cancelling');
        else if (snapshot.status === 'executing') setWorkflowStatus('executing');
        else setWorkflowStatus('thinking');
      });
    };

    socket.on('connect', resumeActiveExecution);
    if (socket.connected) resumeActiveExecution();
    return () => { socket.off('connect', resumeActiveExecution); };
  }, [activeExecutionStorageKey, clearPersistedExecution, isFounder, isZh, pushChatProgress, socket]);

  const startNewTextConversation = useCallback(async () => {
    if (isCreatingConversation) return;
    setIsCreatingConversation(true);
    try {
      const response = await fetch(scopedConversationUrl('/api/conversations/new'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, domain: activeDomain }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.conversation?.id) {
        throw new Error(result?.error || 'Unable to create a new conversation');
      }

      // Detach the text surface from the previous execution without cancelling
      // its durable task. Any late receipt remains attached to the archived
      // conversation and the task widget continues to report its real status.
      activeChatViewDetachRef.current?.();
      clearPersistedExecution();
      activeChatRequestIdRef.current = null;
      textChatActiveRef.current = false;
      lastResumedRequestIdRef.current = null;
      streamingMsgId.current = null;
      currentResponseFinalizationRef.current = null;
      bindAttachmentContextToConversation(result.conversation.id);
      setConversationHistoryOpen(false);
      setConversationHistory(previous => [result.conversation, ...previous.filter(item => item.id !== result.conversation.id)]);
      setMessages([]);
      messagesRef.current = [];
      setPendingAttachments([]);
      pendingAttachmentsRef.current = [];
      setDraftText('');
      setSearchQuery('');
      setSearchResults([]);
      setSearchError('');
      setIsTyping(false);
      setWorkflowStatus('idle');
      setWorkflowSteps([]);
      clearChatProgress();
      seenWorkflowToolEvents.current.clear();
      requestAnimationFrame(() => messageInputRef.current?.focus());
    } catch (error: any) {
      toast.error(error?.message || 'Unable to create a new conversation');
    } finally {
      setIsCreatingConversation(false);
    }
  }, [activeDomain, agentId, bindAttachmentContextToConversation, clearChatProgress, clearPersistedExecution, isCreatingConversation, scopedConversationUrl, setDraftText]);

  const loadConversationHistory = useCallback(async () => {
    setConversationHistoryLoading(true);
    try {
      const response = await fetch(scopedConversationUrl('/api/conversations?limit=40'), { credentials: 'include' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Unable to load conversation history');
      setConversationHistory(Array.isArray(result?.conversations) ? result.conversations : []);
    } catch (error: any) {
      toast.error(error?.message || 'Unable to load conversation history');
    } finally {
      setConversationHistoryLoading(false);
    }
  }, [scopedConversationUrl]);

  const toggleConversationHistory = useCallback(() => {
    setConversationHistoryOpen(current => {
      const next = !current;
      if (next) void loadConversationHistory();
      return next;
    });
  }, [loadConversationHistory]);

  const restoreTextConversation = useCallback(async (conversationId: string) => {
    if (!conversationId || restoringConversationId) return;
    if (conversationId === attachmentConversationIdRef.current) {
      setConversationHistoryOpen(false);
      return;
    }
    setRestoringConversationId(conversationId);
    try {
      const activateResponse = await fetch(scopedConversationUrl(`/api/conversations/${encodeURIComponent(conversationId)}/activate`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, domain: activeDomain }),
      });
      const activateResult = await activateResponse.json().catch(() => ({}));
      if (!activateResponse.ok || !activateResult?.conversation?.id) {
        throw new Error(activateResult?.error || 'Unable to open this conversation');
      }
      const messageResponse = await fetch(
        scopedConversationUrl(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${CHAT_HISTORY_LIMIT}`),
        { credentials: 'include' },
      );
      const messageResult = await messageResponse.json().catch(() => ({}));
      if (!messageResponse.ok) throw new Error(messageResult?.error || 'Unable to load this conversation');

      // Switching transcripts only detaches this chat surface. Durable tasks
      // keep running and remain visible exclusively in the task widget.
      activeChatViewDetachRef.current?.();
      clearPersistedExecution();
      activeChatRequestIdRef.current = null;
      textChatActiveRef.current = false;
      lastResumedRequestIdRef.current = null;
      streamingMsgId.current = null;
      currentResponseFinalizationRef.current = null;
      bindAttachmentContextToConversation(conversationId);
      const restoredMessages = normalizePersistedMessages(Array.isArray(messageResult?.messages) ? messageResult.messages : []);
      setMessages(restoredMessages);
      messagesRef.current = restoredMessages;
      setPendingAttachments([]);
      pendingAttachmentsRef.current = [];
      setDraftText('');
      setSearchQuery('');
      setSearchResults([]);
      setSearchError('');
      setIsTyping(false);
      setWorkflowStatus('idle');
      setWorkflowSteps([]);
      clearChatProgress();
      seenWorkflowToolEvents.current.clear();
      setConversationHistory(previous => previous.map(item => ({
        ...item,
        status: item.id === conversationId ? 'active' : item.status === 'active' ? 'closed' : item.status,
      })));
      setConversationHistoryOpen(false);
      requestAnimationFrame(() => messageInputRef.current?.focus());
    } catch (error: any) {
      toast.error(error?.message || 'Unable to open this conversation');
    } finally {
      setRestoringConversationId('');
    }
  }, [activeDomain, agentId, bindAttachmentContextToConversation, clearChatProgress, clearPersistedExecution, normalizePersistedMessages, restoringConversationId, scopedConversationUrl, setDraftText]);

  useEffect(() => {
    // Scroll to bottom when messages change (new messages, initial load)
    if (scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [chatProgressLines.length, messages]);

  // Scroll to bottom on mount when messages first load
  useEffect(() => {
    if (messages.length > 0 && scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [isOpen, messages.length]);

  useEffect(() => {
    if (isOpen) return;
    setWorkflowStatus('idle');
    setWorkflowSteps([]);
    clearChatProgress();
    currentRequestHadToolRef.current = false;
    currentRequestNeedsEvidenceRef.current = false;
    currentResponseFinalizationRef.current = null;
    seenWorkflowToolEvents.current.clear();
  }, [clearChatProgress, isOpen]);

  const rememberAttachmentContext = useCallback((attachments: ChatAttachment[]) => {
    const reusable = attachments
      .filter(item => item.path || item.transcript || item.content || item.preview)
      .map(serializeChatAttachment);
    if (reusable.length === 0) return;
    const merged = mergeChatAttachmentReferences(conversationAttachmentsRef.current, reusable).attachments;
    conversationAttachmentsRef.current = merged;
    setConversationAttachments(merged);
    if (attachmentContextStorageKey) {
      try {
        localStorage.setItem(attachmentContextStorageKey, serializeChatAttachmentContext(merged));
      } catch {}
    }
  }, [attachmentContextStorageKey]);

  const clearConversationAttachmentContext = useCallback(() => {
    conversationAttachmentsRef.current = [];
    setConversationAttachments([]);
    if (attachmentContextStorageKey) {
      try {
        localStorage.removeItem(attachmentContextStorageKey);
      } catch {}
    }
    toast.success(uiMessage('agent-chat-page.session-materials-cleared.53bea199b2'));
  }, [attachmentContextStorageKey]);

  const sendText = async (text: string, attachments: ChatAttachment[] = pendingAttachments) => {
    const trimmedText = text.trim();
    const directAttachments = attachments.map(serializeChatAttachment);
    const attachmentMerge = mergeChatAttachmentReferences(
      conversationAttachmentsRef.current.map(serializeChatAttachment),
      directAttachments,
    );
    const outgoingAttachments = attachmentMerge.attachments;
    const reusedConversationAttachmentContext =
      conversationAttachmentsRef.current.length > 0 && directAttachments.length === 0;
    if (attachmentMerge.overflowCount > 0) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
    }
    if ((!trimmedText && outgoingAttachments.length === 0) || !user) return;
    const outgoingText = trimmedText || uiMessage('agent-chat-page.please-review-these-attachments.6b61a7fa38');

    const userMsg = {
      id: makeChatMessageId('user'),
      text: outgoingText,
      attachments: directAttachments,
      userName: user.displayName || user.username || (t.chatUserFallback || 'User'),
      timestamp: new Date().toISOString(),
      type: 'user'
    };
    const priorMessages = messagesRef.current.length > 0 ? messagesRef.current : messages;
    textChatActiveRef.current = true;
    seenWorkflowToolEvents.current.clear();
    currentRequestHadToolRef.current = false;
    currentRequestNeedsEvidenceRef.current = needsVisibleToolEvidence(outgoingText, outgoingAttachments.length > 0);
    currentResponseFinalizationRef.current = null;
    clearChatProgress();
    pushChatProgress(
      reusedConversationAttachmentContext
        ? uiMessage('agent-chat-page.using-session-materials.66f4979b61', (isZh) ? 'zh' : 'en')
        : outgoingAttachments.length > 0
        ? (uiMessage('agent-chat-page.i-am-checking-your-attachments.79cfe8a290', (isZh) ? 'zh' : 'en'))
        : (uiMessage('agent-chat-page.i-am-checking-your-request.05a5e81231', (isZh) ? 'zh' : 'en')),
      'thinking'
    );
    setWorkflowStatus('thinking');
    setWorkflowSteps([{
      id: makeChatMessageId('chat-start'),
      type: 'thinking',
      text: t.workflowAnalyzing || 'Analyzing your request...',
      time: Date.now(),
    }]);

    setMessages(prev => {
      const base = prev.length >= priorMessages.length ? prev : priorMessages;
      const next = [...base, userMsg];
      messagesRef.current = next;
      return next;
    });
    setDraftText('');
    setPendingAttachments(prev => {
      const next = prev.filter(item => !outgoingAttachments.some(sent => sent.id === item.id));
      pendingAttachmentsRef.current = next;
      return next;
    });
    if (outgoingAttachments.length > 0) rememberAttachmentContext(outgoingAttachments);
    setIsTyping(true);
    const requestId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeChatRequestIdRef.current = requestId;
    persistActiveExecution(requestId);

    let resolved = false;
    let safetyTimer: ReturnType<typeof setTimeout>;
    let resumeProbeTimer: ReturnType<typeof setTimeout> | null = null;
    let socketAckTimer: ReturnType<typeof setTimeout> | null = null;
    let socketAcknowledged = false;
    let lastProbeStatus = '';
    activeChatViewDetachRef.current = () => {
      resolved = true;
      clearTimeout(safetyTimer);
      if (resumeProbeTimer) clearTimeout(resumeProbeTimer);
      if (socketAckTimer) clearTimeout(socketAckTimer);
      cleanupSocketWaiters();
    };
    const requestConversationId = attachmentConversationIdRef.current;
    const isCurrentResponse = (data?: { requestId?: string; source?: string; conversationId?: string }) => {
      if (data?.conversationId && data.conversationId !== requestConversationId) return false;
      if (data?.requestId) return data.requestId === requestId;
      if (activeChatRequestIdRef.current) return false;
      if (data?.source && data.source !== 'chat') return false;
      return textChatActiveRef.current;
    };
    const cleanupSocketWaiters = () => {
      socket.off('agent:response', onResponse);
      socket.off('agent:error', onError);
      socket.off('agent:status', onStatus);
    };
    const resolve = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimer);
      if (resumeProbeTimer) clearTimeout(resumeProbeTimer);
      if (socketAckTimer) clearTimeout(socketAckTimer);
      cleanupSocketWaiters();
      if (activeChatViewDetachRef.current) activeChatViewDetachRef.current = null;
      setIsTyping(false);
      textChatActiveRef.current = false;
      clearPersistedExecution(requestId);
      if (activeChatRequestIdRef.current === requestId) activeChatRequestIdRef.current = null;
    };
    const onResponse = (data?: { requestId?: string; source?: string; conversationId?: string }) => { if (isCurrentResponse(data)) resolve(); };
    const onError = (data?: { requestId?: string; source?: string; conversationId?: string }) => { if (isCurrentResponse(data)) resolve(); };
    const onStatus = (data: { status: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentResponse(data)) return;
      if (data.status === 'idle' || data.status === 'error') resolve();
    };
    const scheduleExecutionProbe = (delayMs: number) => {
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        if (resolved) return;
        if (!socketAcknowledged) {
          streamingMsgId.current = null;
          resolve();
          return;
        }

        let probeSettled = false;
        resumeProbeTimer = setTimeout(() => {
          if (probeSettled || resolved) return;
          probeSettled = true;
          pushChatProgress(
            socket.connected
              ? uiMessage('agent-chat-page.rechecking-task-state.7d8729d39f', isZh ? 'zh' : 'en')
              : uiMessage('agent-chat-page.connection-lost-task-will-resume.52cd95319f', isZh ? 'zh' : 'en'),
            'thinking',
          );
          scheduleExecutionProbe(30000);
        }, 10000);

        socket.emit('agent:execution_resume', {
          requestId,
          source: 'chat',
          domain: activeDomain,
          orgId: activeOrgId || null,
          conversationId: attachmentConversationIdRef.current || undefined,
        }, (result?: { ok?: boolean; snapshot?: ChatExecutionSnapshot; error?: string }) => {
          if (probeSettled || resolved) return;
          probeSettled = true;
          if (resumeProbeTimer) {
            clearTimeout(resumeProbeTimer);
            resumeProbeTimer = null;
          }
          if (!result?.ok || !result.snapshot) {
            setWorkflowStatus('error');
            pushChatProgress(
              result?.error || uiMessage('agent-chat-page.backend-lost-task.8bbc4d5800', isZh ? 'zh' : 'en'),
              'error',
            );
            streamingMsgId.current = null;
            resolve();
            return;
          }
          if (result.snapshot.terminal) return; // Terminal event is replayed by the server.
          if (result.snapshot.status !== lastProbeStatus) {
            lastProbeStatus = result.snapshot.status;
            pushChatProgress(
              uiMessage('agent-chat-page.the-backend-has-accepted-this.aa53249e15', (isZh) ? 'zh' : 'en'),
              'thinking',
            );
          }
          scheduleExecutionProbe(30000);
        });
      }, delayMs);
    };
    scheduleExecutionProbe(outgoingAttachments.length > 0 ? 180000 : 120000);

    socket.on('agent:response', onResponse);
    socket.on('agent:error', onError);
    socket.on('agent:status', onStatus);

    const chatPayload = {
      text: outgoingText,
      attachments: outgoingAttachments,
      history: buildChatHistoryPayload(priorMessages),
      personalityId: 'lumi',
      category: agentCategory,
      agentId,
      domain: activeDomain,
      orgId: activeOrgId || null,
      source: 'chat',
      operationMode,
      requestId,
      conversationId: attachmentConversationIdRef.current || undefined,
    };

    socketAckTimer = setTimeout(() => {
      if (resolved || socketAcknowledged) return;
      setWorkflowStatus('error');
      pushChatProgress(
        uiMessage('agent-chat-page.the-backend-has-not-acknowledged.4a6f380020', (isZh) ? 'zh' : 'en'),
        'error'
      );
      setWorkflowSteps(prev => [...prev, {
        id: `chat-ack-timeout-${Date.now()}`,
        type: 'error',
        text: uiMessage('agent-chat-page.backend-did-not-acknowledge-receipt.02f7aa3200', (isZh) ? 'zh' : 'en'),
        detail: socket.connected ? undefined : (uiMessage('agent-chat-page.socket-is-currently-disconnected.8f04ddd3b7', (isZh) ? 'zh' : 'en')),
        time: Date.now(),
      }]);
    }, 5000);

    // Always try socket first. The ack lets the UI distinguish "received and working"
    // from "message only exists optimistically in the frontend".
    socket.emit("agent:chat", chatPayload, (ack?: { ok?: boolean; error?: string }) => {
      socketAcknowledged = Boolean(ack?.ok);
      if (socketAckTimer) {
        clearTimeout(socketAckTimer);
        socketAckTimer = null;
      }
      if (resolved) return;
      if (ack?.ok) {
        pushChatProgress(uiMessage('agent-chat-page.the-backend-has-received-this.859b50e7ed', (isZh) ? 'zh' : 'en'), 'thinking');
      } else {
        setWorkflowStatus('error');
        pushChatProgress(
          ack?.error || (uiMessage('agent-chat-page.the-backend-did-not-accept.44d78fa21a', (isZh) ? 'zh' : 'en')),
          'error'
        );
        resolve();
      }
    });

    // No frontend AI fallback here. If the realtime backend is down, show the
    // connection problem instead of generating a second, inconsistent answer.
  };

  const cancelActiveChat = () => {
    const requestId = activeChatRequestIdRef.current;
    if (!socket || !requestId) return;
    setWorkflowStatus('cancelling');
    pushChatProgress(uiMessage('agent-chat-page.cancelling-task.18c33c6327', isZh ? 'zh' : 'en'), 'thinking');
    let acknowledged = false;
    const ackTimer = window.setTimeout(() => {
      if (acknowledged || activeChatRequestIdRef.current !== requestId) return;
      setWorkflowStatus('error');
      pushChatProgress(
        socket.connected
          ? uiMessage('agent-chat-page.cancellation-not-confirmed.990f6802e1', isZh ? 'zh' : 'en')
          : uiMessage('agent-chat-page.connection-lost-recheck-task.6c0952c278', isZh ? 'zh' : 'en'),
        'error',
      );
    }, 8000);
    socket.emit('agent:abort_chat', {
      requestId,
      source: 'chat',
      domain: activeDomain,
      orgId: activeOrgId || null,
      conversationId: attachmentConversationIdRef.current || undefined,
    }, (result?: { ok?: boolean; error?: string }) => {
      acknowledged = true;
      window.clearTimeout(ackTimer);
      if (activeChatRequestIdRef.current !== requestId) return;
      if (!result?.ok) {
        setWorkflowStatus('error');
        pushChatProgress(
          result?.error || uiMessage('agent-chat-page.unable-to-cancel-task.08547685ab', isZh ? 'zh' : 'en'),
          'error',
        );
      }
    });
  };

  // When prefillMessage comes from notification center, show it as a Lumi message
  const sentRef = useRef<string>('');
  useEffect(() => {
    if (prefillMessage && prefillMessage !== sentRef.current) {
      sentRef.current = prefillMessage;
      setMessages(prev => {
        if (prev.some(m => m.text === prefillMessage && m.type === 'agent')) return prev;
        return [...prev, {
          id: `proactive-${Date.now()}`,
          text: prefillMessage,
          userName: agentName,
          timestamp: new Date().toISOString(),
          type: 'agent',
          source: prefillSource,
        }];
      });
      onPrefillConsumed?.();
    }
  }, [agentName, onPrefillConsumed, prefillMessage, prefillSource]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    sendText(draftTextRef.current.trim(), pendingAttachments);
  };

  const toggleListening = () => {
    if (isListening) {
      if (inputDictationActiveRef.current) {
        inputDictationActiveRef.current = false;
        endCall();
        setIsListening(false);
        return;
      }
      recognition.current?.stop();
    } else {
      const useBackendDictation = isElectron || !recognition.current;
      if (useBackendDictation) {
        if (callState !== 'idle') {
          toast.error(uiMessage('agent-chat-page.voice-is-already-active-end.361c5fb6e4'));
          return;
        }
        inputDictationActiveRef.current = true;
        setIsListening(true);
        startCall(selectedVoiceId, 'lumi', agentId, {
          transcriptionOnly: true,
          domain: activeDomain,
          orgId: activeOrgId,
        }).catch((err: any) => {
          inputDictationActiveRef.current = false;
          setIsListening(false);
          toast.error(err?.message || t.speechNotSupported || 'Speech recognition failed');
        });
        return;
      }
      recognition.current.start();
      setIsListening(true);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const appendPendingAttachments = useCallback((
    incoming: ChatAttachment[],
    options: { announce?: boolean } = {},
  ) => {
    const occupied = mergeChatAttachmentReferences(
      conversationAttachmentsRef.current,
      pendingAttachmentsRef.current,
    ).attachments;
    const availability = mergeChatAttachmentReferences(occupied, incoming);
    const pendingMerge = mergeChatAttachmentReferences(pendingAttachmentsRef.current, availability.added);
    const result = {
      ...pendingMerge,
      duplicateCount: availability.duplicateCount,
      overflowCount: availability.overflowCount,
    };
    if (result.added.length > 0) {
      pendingAttachmentsRef.current = result.attachments;
      setPendingAttachments(result.attachments);
    }
    if (result.added.length > 0) {
      if (options.announce !== false) {
        toast.success(uiMessage('agent-chat-page.attached-to-this-message.d0b87d258c'));
      }
    } else if (result.duplicateCount > 0 && options.announce !== false) {
      toast.info(uiMessage('agent-chat-page.file-already-attached.24544e870a'));
    }
    if (result.overflowCount > 0) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
    }
    return result;
  }, []);

  useEffect(() => {
    if (!isOpen || !attachmentRequest?.requestId) return;
    const scopeMatches = chatAttachmentRequestMatchesScope(attachmentRequest, activeDomain, activeOrgId);
    if (scopeMatches) {
      appendPendingAttachments([createChatAttachmentReference(attachmentRequest)]);
      setShowAttachmentMenu(false);
      requestAnimationFrame(() => messageInputRef.current?.focus());
    } else {
      toast.error(uiMessage('agent-chat-page.file-reference-scope-mismatch.7655432d8b'));
    }
    onAttachmentRequestConsumed?.(attachmentRequest.requestId);
  }, [activeDomain, activeOrgId, appendPendingAttachments, attachmentRequest, isOpen, onAttachmentRequestConsumed]);

  const mapImportedFilesToAttachments = useCallback((files: any[]): ChatAttachment[] => (
    files.map((f: any) => {
      const fileName = f.name || f.displayName || f.id || 'attachment';
      const mimeType = f.mimeType || '';
      const kind: ChatAttachment['kind'] =
        f.kind === 'image' || isImageFileName(fileName, mimeType) ? 'image' :
        f.kind === 'audio' || isAudioFileName(fileName, mimeType) ? 'audio' :
        'file';
      const transcript = kind === 'audio'
        ? extractAudioTranscript(f.transcript || f.content || f.preview || null)
        : null;
      return createChatAttachmentReference({
        fileId: f.id || fileName,
        fileName,
        path: f.path,
        content: f.content || null,
        preview: f.preview || null,
        mimeType,
        rawSize: f.rawSize || f.size || 0,
        kind,
        downloadUrl: f.id ? scopedFileUrl(`/api/files/download/${encodeURIComponent(f.id)}?inline=1`) : undefined,
        transcript,
        transcriptionStatus: f.extractionStatus || (transcript ? 'indexed' : ''),
        transcriptionError: f.extractionError || f.syncError || null,
        transcriptionProvider: f.extractionProvider || undefined,
        transcriptionModel: f.extractionModel || undefined,
      });
    })
  ), [scopedFileUrl]);

  const acceptImportedChatFiles = useCallback((files: any[], skippedCount = 0) => {
    const attachments = mapImportedFilesToAttachments(files);
    const mergeResult = appendPendingAttachments(attachments, { announce: false });
    const addedAttachments = mergeResult.added;
    setOptimizationProgress(100);
    window.setTimeout(() => { setIsOptimizing(false); setOptimizationProgress(0); }, 500);
    const audioTranscripts = addedAttachments
      .filter(item => item.kind === 'audio' && item.transcript)
      .map(item => `${item.fileName}:\n${item.transcript}`);
    if (audioTranscripts.length > 0) {
      const current = draftTextRef.current.trim();
      setDraftText([current, audioTranscripts.join('\n\n')].filter(Boolean).join('\n\n'));
      toast.success(uiMessage('agent-chat-page.audio-transcript-inserted-into-the.cd2c9c3972'));
    } else if (addedAttachments.some(item => item.kind === 'audio' && item.transcriptionError)) {
      const failed = addedAttachments.find(item => item.kind === 'audio' && item.transcriptionError);
      toast.error(failed?.transcriptionError || uiMessage('agent-chat-page.audio-transcription-failed.becab97e32'));
    } else if (addedAttachments.length > 0) {
      toast.success(uiMessage('agent-chat-page.attached-to-this-message.d0b87d258c'));
    }
    if (skippedCount > 0) {
      toast.info(formatUiMessage('agent-chat-page.some-dropped-files-skipped.d3df0abf37', { value0: skippedCount }));
    }
    notifyKnowledgeUpdated(attachments.map(item => ({ id: item.path || item.fileName, name: item.fileName, displayName: item.fileName })));
  }, [appendPendingAttachments, mapImportedFilesToAttachments, notifyKnowledgeUpdated, setDraftText]);

  const uploadChatAttachments = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || isOptimizing) return;
    const occupiedCount = mergeChatAttachmentReferences(
      conversationAttachmentsRef.current,
      pendingAttachmentsRef.current,
    ).attachments.length;
    const remainingSlots = MAX_CHAT_ATTACHMENTS - occupiedCount;
    if (remainingSlots <= 0) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
      return;
    }
    setIsOptimizing(true);
    setOptimizationProgress(30);

    const fileList = Array.from(files).slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
    }
    const formData = new FormData();
    fileList.forEach(f => formData.append('files', f));

    try {
      formData.append('domain', activeDomain);
      if (activeDomain === 'work' && activeOrgId) formData.append('orgId', activeOrgId);

      const res = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        acceptImportedChatFiles(d.files || []);
      } else {
        setIsOptimizing(false);
        setOptimizationProgress(0);
        try {
          const err = await res.json();
          toast.error(err.error || (t.uploadFailed || 'Upload failed'));
        } catch {
          toast.error(t.uploadFailed || 'Upload failed');
        }
      }
    } catch {
      setIsOptimizing(false);
      setOptimizationProgress(0);
      toast.error(t.chatConnError || 'Connection error during upload');
    }
  }, [acceptImportedChatFiles, activeDomain, activeOrgId, isOptimizing, t.chatConnError, t.uploadFailed]);

  const importChatAttachmentPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths.map(item => String(item || '').trim()).filter(Boolean))];
    if (uniquePaths.length === 0 || isOptimizing) return;
    const occupiedCount = mergeChatAttachmentReferences(
      conversationAttachmentsRef.current,
      pendingAttachmentsRef.current,
    ).attachments.length;
    const remainingSlots = MAX_CHAT_ATTACHMENTS - occupiedCount;
    if (remainingSlots <= 0) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
      return;
    }
    setIsOptimizing(true);
    setOptimizationProgress(30);
    try {
      const importPaths = uniquePaths.slice(0, remainingSlots);
      const res = await fetch(scopedFileUrl('/api/files/import-paths'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lumi-Desktop-Import': 'file-drop' },
        body: JSON.stringify({ paths: importPaths }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t.uploadFailed || 'Upload failed');
      acceptImportedChatFiles(data.files || [], (data.skipped || []).length + Math.max(0, uniquePaths.length - importPaths.length));
    } catch (error: any) {
      setIsOptimizing(false);
      setOptimizationProgress(0);
      toast.error(error?.message || t.chatConnError || 'Connection error during upload');
    }
  }, [acceptImportedChatFiles, isOptimizing, scopedFileUrl, t.chatConnError, t.uploadFailed]);

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const setupDropListener = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (cancelled) return;
        unlisten = await getCurrentWindow().onDragDropEvent((event: any) => {
          const payload = event?.payload;
          if (payload?.type === 'enter' || payload?.type === 'over') {
            setIsDraggingFiles(true);
            return;
          }
          if (payload?.type === 'drop') {
            nativeDropHandledAtRef.current = Date.now();
            setIsDraggingFiles(false);
            void importChatAttachmentPaths(Array.isArray(payload.paths) ? payload.paths : []);
            return;
          }
          setIsDraggingFiles(false);
        });
        if (cancelled) unlisten?.();
      } catch {}
    };
    void setupDropListener();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [importChatAttachmentPaths, isOpen]);

  const handleChatDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingFiles(true);
  };

  const handleChatDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) setIsDraggingFiles(false);
  };

  const handleChatDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingFiles(false);
    if (Date.now() - nativeDropHandledAtRef.current < 700) return;
    void uploadChatAttachments(event.dataTransfer.files);
  };

  const removePendingAttachment = (id: string) => {
    setPendingAttachments(prev => {
      const next = prev.filter(item => item.id !== id);
      pendingAttachmentsRef.current = next;
      return next;
    });
  };

  const referenceChatFile = useCallback((item: ChatFilePanelItem) => {
    if (item.source === 'pending') return;
    const attachment = createChatAttachmentReference({
      fileId: item.fileId,
      fileName: item.fileName,
      path: item.path,
      mimeType: item.mimeType,
      size: item.size,
      kind: item.kind,
      openUrl: item.openUrl,
      saveUrl: item.saveUrl,
    });
    const result = appendPendingAttachments([attachment]);
    if (result.added.length > 0) setShowAttachmentMenu(false);
  }, [appendPendingAttachments]);

  const renderChatFileRow = (item: ChatFilePanelItem) => {
    const isAttached = item.source === 'pending' || pendingAttachmentKeys.has(chatAttachmentIdentity(item));
    return (
      <div
        key={item.id}
        className={`group flex items-center gap-2 rounded-2xl border px-2.5 py-2 transition-colors ${
          isAttached
            ? 'border-emerald-300/20 bg-emerald-400/[0.08]'
            : 'border-white/10 bg-black/25 hover:border-emerald-300/25 hover:bg-emerald-400/10'
        }`}
        title={item.path || item.fileName}
      >
        <button
          type="button"
          onClick={() => referenceChatFile(item)}
          disabled={isAttached}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
          title={isAttached
            ? uiMessage('agent-chat-page.file-already-attached.24544e870a')
            : uiMessage('agent-chat-page.reference-file-in-message.5ed1d9986a')}
          aria-label={isAttached
            ? uiMessage('agent-chat-page.file-already-attached.24544e870a')
            : uiMessage('agent-chat-page.reference-file-in-message.5ed1d9986a')}
        >
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
            isAttached ? 'bg-emerald-300/12 text-emerald-100' : 'bg-white/[0.06] text-white/58 group-hover:text-emerald-100'
          }`}>
            {item.kind === 'image' ? <ImageIcon size={15} /> : item.kind === 'audio' ? <Mic size={15} /> : <FileText size={15} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-white/78">{item.fileName}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-white/38">
              {isAttached ? <Check size={10} className="shrink-0 text-emerald-200/75" /> : <Paperclip size={10} className="shrink-0" />}
              <span className="truncate">{item.subtitle || fileKindLabel(item.kind)}</span>
              {item.status && (
                <span className="shrink-0 rounded-full border border-white/10 px-1.5 py-0.5 text-[9px] uppercase text-white/38">
                  {item.status}
                </span>
              )}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => void openChatFile(item)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white/30 transition-colors hover:bg-white/10 hover:text-white/75"
          title={uiMessage('agent-chat-page.open-file.01b8938ac4')}
          aria-label={uiMessage('agent-chat-page.open-file.01b8938ac4')}
        >
          <ExternalLink size={13} />
        </button>
      </div>
    );
  };

  if (isFounder) {
    return <FoundersSanctuary t={t} user={user} onBack={onClose} />;
  }

  const latestChatProgressLine = chatProgressLines[chatProgressLines.length - 1];
  const workflowTaskActive = ['executing', 'waiting_confirmation', 'background', 'cancelling'].includes(workflowStatus);
  const workflowStatusText =
    workflowStatus === 'thinking' ? (t.workflowAnalyzing || 'Analyzing') :
    workflowStatus === 'executing' ? (t.workflowExecuting || 'Executing tools') :
    workflowStatus === 'waiting_confirmation' ? (t.workflowWaitingConfirm || 'Waiting for approval') :
    workflowStatus === 'cancelling' ? uiMessage('agent-chat-page.cancelling.7163e20e93', isZh ? 'zh' : 'en') :
    workflowStatus === 'cancelled' ? uiMessage('agent-chat-page.execution-cancelled.4ec843f670', isZh ? 'zh' : 'en') :
    workflowStatus === 'background' ? (t.workflowBackground || 'Working in background') :
    workflowStatus === 'done' ? (t.workflowDone || 'Done') :
    workflowStatus === 'error' ? (t.workflowError || 'Error') :
    isTyping ? (t.neuralProcessing || 'Processing') :
    (t.workflowIdle || 'Idle');
  const chatProgressStatusText =
    latestChatProgressLine?.text ||
    (workflowStatus === 'background'
      ? (uiMessage('agent-chat-page.i-am-continuing-this-in.3d1e9bcbcd', (isZh) ? 'zh' : 'en'))
      : isTyping
        ? (uiMessage('agent-chat-page.i-am-figuring-out-how.017a8f967e', (isZh) ? 'zh' : 'en'))
        : workflowStatusText);
  const chatPanelStyle: React.CSSProperties = {
    background: chatAccentTheme.panel,
    borderColor: chatAccentTheme.panelBorder,
    boxShadow: chatAccentTheme.panelShadow,
  };
  const chatHeaderStyle: React.CSSProperties = {
    background: chatAccentTheme.header,
    borderBottomColor: chatAccentTheme.panelBorder,
  };
  const chatInputPanelStyle: React.CSSProperties = {
    background: chatAccentTheme.inputPanel,
    borderTopColor: chatAccentTheme.panelBorder,
  };
  const chatInputStyle: React.CSSProperties = {
    background: chatAccentTheme.input,
    borderColor: chatAccentTheme.panelBorder,
    boxShadow: `0 0 0 1px ${chatAccentTheme.panelBorder}`,
  };
  const displayMessages = searchQuery.trim()
    ? searchDisplayMessages
    : messages.length > CHAT_RENDER_LIMIT
      ? messages.slice(-CHAT_RENDER_LIMIT)
      : messages;
  const hiddenMessageCount = searchQuery.trim()
    ? 0
    : Math.max(0, messages.length - displayMessages.length);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.99 }}
          transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          className="lumi-chat-root lumi-below-topbar lumi-work-surface fixed inset-x-0 bottom-0 z-[90] flex flex-col"
          onDragEnter={handleChatDragOver}
          onDragOver={handleChatDragOver}
          onDragLeave={handleChatDragLeave}
          onDrop={handleChatDrop}
          style={{
            background: chatAccentTheme.background,
            '--color-celestial-saturn': chatAccentTheme.saturn,
            '--color-celestial-glow': chatAccentTheme.glow,
            '--color-celestial-nebula': chatAccentTheme.nebula,
            '--color-celestial-mars': chatAccentTheme.mars,
            willChange: 'opacity, transform',
          } as React.CSSProperties}
        >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        onChange={(e) => { void uploadChatAttachments(e.target.files); e.target.value = ''; }}
      />
      <AnimatePresence>
        {isDraggingFiles && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-4 z-[225] flex items-center justify-center rounded-[2rem] border-2 border-dashed border-cyan-200/55 bg-[#07131a]/90 shadow-[0_0_70px_rgba(34,211,238,0.18)] backdrop-blur-xl"
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-3xl border border-cyan-200/25 bg-cyan-200/10 text-cyan-100">
                <Upload size={30} />
              </span>
              <div>
                <div className="text-base font-bold text-white/90">{uiMessage('agent-chat-page.drop-files-to-chat.5ea87cc147')}</div>
                <div className="mt-1 text-xs text-white/48">{uiMessage('agent-chat-page.dropped-files-become-session-materials.193cb17bd7')}</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showWeChatSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[230] flex items-start justify-center bg-black/60 px-4 pt-20 backdrop-blur-sm"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowWeChatSettings(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#080b12]/95 shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div>
                  <h3 className="text-sm font-bold text-white">{uiMessage('agent-chat-page.personal-wechat.153d58f0e9')}</h3>
                  <p className="mt-1 text-xs text-white/40">{uiMessage('agent-chat-page.after-qr-authorization-and-one.a49fcea5c7')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowWeChatSettings(false)}
                  className="rounded-full p-1.5 text-white/35 transition-colors hover:bg-white/10 hover:text-white"
                  aria-label={uiMessage('agent-chat-page.close.6cf4a7773a')}
                >
                  <XCircle size={18} />
                </button>
              </div>
              <div className="p-5">
                <WeChatSettings t={t} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    <div className={`lumi-chat-layout relative mx-auto flex w-full flex-1 flex-col overflow-hidden ${layout === 'command-center' ? 'max-w-none' : 'max-w-[90rem] space-y-4 pb-32 md:space-y-8 md:pb-0'}`}>
      {isCommandCenterUtility && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="absolute inset-3 z-20"
        >
          <CommandCenterPanel
            t={t}
            view={commandCenterView}
            onViewChange={onCommandCenterViewChange || (() => {})}
            onOpenNexus={onOpenNexus}
          />
        </motion.div>
      )}

      {!isCommandCenterUtility && (
      <div className={`lumi-chat-toolbar relative z-[55] flex flex-shrink-0 items-center justify-between ${
        isOfficeCommandCenter
          ? 'h-14 border-b border-white/[0.07] bg-[#03070d]/92 px-4 shadow-[0_1px_0_rgba(255,255,255,0.025)]'
          : 'px-4 pt-6 md:px-0'
      }`}>
        <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
        >
          <ArrowLeft size={18} />
        </button>
        </div>
        <div className={`lumi-chat-toolbar-actions flex min-w-0 items-center ${isOfficeCommandCenter ? 'gap-1.5' : 'gap-3'}`}>
          {!isOfficeCommandCenter && <div className="lumi-chat-voice-picker relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowVoicePicker(!showVoicePicker)}
              className="text-xs font-black uppercase tracking-widest text-white/40 flex items-center gap-2 hover:text-celestial-saturn transition-colors"
            >
              {voices.find(v => v.voiceId === selectedVoiceId)?.name || (t.selectVoice || 'Select Voice')}
              <ChevronDown size={12} />
            </Button>
            
            <AnimatePresence>
              {showVoicePicker && (
                <motion.div
                  ref={voicePickerRef}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute top-full left-0 mt-2 w-48 bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl p-2 z-50 shadow-2xl max-h-64 overflow-y-auto custom-scrollbar"
                >
                  {voices.map(v => (
                    <button
                      key={v.voiceId}
                      onClick={() => {
                        setSelectedVoiceId(v.voiceId);
                        setShowVoicePicker(false);
                      }}
                      className={`w-full text-left p-2 rounded-xl text-xs font-bold uppercase transition-all ${
                        selectedVoiceId === v.voiceId ? 'bg-celestial-saturn text-black' : 'text-white/60 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {v.name}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>}

          <VoiceCallButton
            callState={callState}
            audioLevel={audioLevel}
            onStart={() => startCall(selectedVoiceId, 'lumi', agentId, { domain: activeDomain, orgId: activeOrgId })}
            onEnd={endCall}
            hasVoice={voices.length > 0}
          />
          {activeDomain === 'personal' && (
            <button
              type="button"
              onClick={() => setShowWeChatSettings(true)}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-200 transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15 md:h-10 md:w-10"
              title={uiMessage('agent-chat-page.personal-wechat.153d58f0e9')}
              aria-label={uiMessage('agent-chat-page.open-personal-wechat-connection.24ff73324a')}
            >
              <MessageCircle className="h-4 w-4 md:h-5 md:w-5" />
            </button>
          )}
          {!isOfficeCommandCenter && <button
            type="button"
            onClick={requestMeetingMode}
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-200 transition-all hover:border-cyan-300/35 hover:bg-cyan-400/15 md:h-10 md:w-10"
            title={uiMessage('agent-chat-page.meeting-mode.958510fb80')}
            aria-label={uiMessage('agent-chat-page.open-meeting-mode.3aabc87fcb')}
          >
            <FileText className="h-4 w-4 md:h-5 md:w-5" />
          </button>}
          <div className="lumi-chat-agent-mark flex h-8 w-8 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/20 text-celestial-saturn md:h-10 md:w-10">
            <Ghost className="w-4 h-4 md:w-5 md:h-5" />
          </div>
          <div className="lumi-chat-agent-identity min-w-0 text-right sm:text-left">
            <div className="flex max-w-[52vw] flex-wrap items-center justify-end gap-1.5 sm:max-w-none sm:justify-start">
              <h2 className="min-w-0 truncate text-base font-bold tracking-tight md:text-xl">
                {agentName}
              </h2>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${operationModeMeta.badgeClass}`}
                title={operationModeMeta.detail}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${operationModeMeta.dotClass}`} />
                <OperationModeIcon size={11} />
                {operationModeMeta.label}
              </span>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  isWorkChat
                    ? 'border-blue-500/30 bg-blue-500/15 text-blue-300'
                    : 'border-white/10 bg-white/5 text-white/45'
                }`}
                title={activeDomainDetail}
              >
                {isWorkChat ? <Briefcase size={11} /> : <User size={11} />}
                {activeDomainLabel}
              </span>
            </div>
            <p className="text-xs md:text-xs uppercase tracking-widest text-white/40 font-bold">{agentCategory}</p>
          </div>
        </div>
      </div>
      )}

      {!isCommandCenterUtility && <div className={`relative z-20 flex min-h-0 flex-1 ${
        isOfficeCommandCenter ? 'lumi-command-center-workspace overflow-hidden' : 'gap-3'
      }`}>

        {isOfficeCommandCenter && (
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35 }}
            className="lumi-command-center-office relative min-h-0 min-w-0 flex-1 overflow-hidden border-r border-white/[0.08]"
          >
            <div className="absolute inset-0">
              <CommandCenterPanel
                t={t}
                view="office"
                onViewChange={onCommandCenterViewChange || (() => {})}
                onOpenNexus={onOpenNexus}
                runtimeStatusOverride={{
                  status: runtimeStatus,
                  loading: runtimeStatusLoading,
                  error: runtimeStatusError,
                  refresh: refreshRuntimeStatus,
                }}
              />
            </div>
            <ActiveTaskWidget
              status={runtimeStatus}
              focusThreads={focusThreads}
              backgroundTasks={backgroundWorkflowTasks}
              workflowActive={workflowTaskActive}
              workflowStatus={workflowStatus}
              progressText={chatProgressStatusText}
              isZh={isZh}
            />
          </motion.section>
        )}

        {/* Chat Panel */}
        <>
        <div
          className={`lumi-chat-panel flex min-h-0 min-w-0 flex-col overflow-hidden ${
            isOfficeCommandCenter
              ? 'lumi-command-center-chat-rail w-[clamp(420px,30vw,560px)] shrink-0 border-0 bg-[#070b12]'
              : 'glass flex-1 rounded-[2.5rem] border shadow-2xl md:rounded-[3rem]'
          }`}
          style={isOfficeCommandCenter ? { ...chatPanelStyle, boxShadow: 'none' } : chatPanelStyle}
        >
          <div
            className={`lumi-chat-panel-header flex items-center justify-between border-b ${isOfficeCommandCenter ? 'px-5 py-3.5' : 'p-4 md:p-6'}`}
            style={chatHeaderStyle}
          >
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-celestial-saturn animate-pulse" />
              <span className="text-xs md:text-xs font-bold uppercase tracking-widest text-white/60">
                Neural Link
              </span>
              <div
                className={`items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${operationModeMeta.subtleClass} ${isOfficeCommandCenter ? 'hidden' : 'inline-flex'}`}
                title={operationModeMeta.detail}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${operationModeMeta.dotClass}`} />
                <OperationModeIcon size={11} />
                <span>{operationModeMeta.label}</span>
              </div>
              {!isOfficeCommandCenter && (knowledgeFiles.length > 0 || knowledgeLoading) && (
                <div
                  className="ml-1 hidden min-w-0 items-center gap-1.5 rounded-full border border-emerald-400/15 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-100/75 sm:flex"
                  title={knowledgeStatusText}
                >
                  {knowledgeLoading ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                  <span className="max-w-[180px] truncate">{knowledgeStatusText}</span>
                </div>
              )}
            </div>
            <div ref={conversationHistoryRef} className="lumi-chat-history-search relative flex items-center gap-2">
              {isOfficeCommandCenter && (
                <button
                  type="button"
                  onClick={toggleConversationHistory}
                  className={`flex h-8 w-8 items-center justify-center rounded-xl border transition-colors ${
                    conversationHistoryOpen
                      ? 'border-cyan-300/30 bg-cyan-300/[0.10] text-cyan-100'
                      : 'border-white/10 bg-white/[0.04] text-white/45 hover:border-cyan-300/25 hover:bg-cyan-300/[0.08] hover:text-cyan-100'
                  }`}
                  title={t.selectPreviousConversation || 'Select previous conversation'}
                  aria-label={t.selectPreviousConversation || 'Select previous conversation'}
                  aria-expanded={conversationHistoryOpen}
                >
                  {conversationHistoryLoading ? <Loader2 size={14} className="animate-spin" /> : <History size={15} />}
                </button>
              )}
              {isOfficeCommandCenter && (
                <button
                  type="button"
                  onClick={() => void startNewTextConversation()}
                  disabled={isCreatingConversation}
                  className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/45 transition-colors hover:border-cyan-300/25 hover:bg-cyan-300/[0.08] hover:text-cyan-100 disabled:cursor-wait disabled:opacity-50"
                  title={t.newConversationHint || t.newConversation || 'New conversation'}
                  aria-label={t.newConversation || 'New conversation'}
                >
                  {isCreatingConversation ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} />}
                </button>
              )}
              <AnimatePresence>
                {isOfficeCommandCenter && conversationHistoryOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    className="absolute right-0 top-10 z-[80] w-[min(320px,calc(100vw-4rem))] overflow-hidden rounded-2xl border border-cyan-300/15 bg-[#07101a]/98 shadow-2xl shadow-black/55 backdrop-blur-2xl"
                  >
                    <div className="border-b border-white/[0.07] px-3 py-2.5">
                      <div className="text-[11px] font-bold text-white/75">{t.previousConversations || 'Previous conversations'}</div>
                      <div className="mt-0.5 text-[9px] text-white/30">{t.continuePreviousConversation || 'Select one to continue its chat'}</div>
                    </div>
                    <div className="custom-scrollbar max-h-[360px] overflow-y-auto p-1.5">
                      {conversationHistoryLoading && conversationHistory.length === 0 ? (
                        <div className="flex items-center justify-center py-8 text-white/35"><Loader2 size={16} className="animate-spin" /></div>
                      ) : conversationHistory.length === 0 ? (
                        <div className="px-3 py-8 text-center text-[11px] text-white/35">{t.noConversations || 'No conversations yet'}</div>
                      ) : conversationHistory.map(conversation => {
                        const current = conversation.id === attachmentConversationIdRef.current;
                        const title = conversation.displayTitle || conversation.title || conversation.preview || t.untitled || 'Untitled';
                        return (
                          <button
                            key={conversation.id}
                            type="button"
                            onClick={() => void restoreTextConversation(conversation.id)}
                            disabled={Boolean(restoringConversationId)}
                            className={`group w-full rounded-xl px-3 py-2.5 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${
                              current ? 'bg-cyan-300/[0.10]' : 'hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[11px] font-semibold text-white/75">{title}</span>
                              {restoringConversationId === conversation.id ? (
                                <Loader2 size={11} className="shrink-0 animate-spin text-cyan-200" />
                              ) : current ? (
                                <span className="shrink-0 rounded-full bg-cyan-300/[0.12] px-1.5 py-0.5 text-[8px] font-bold text-cyan-100/75">{t.currentConversation || 'Current'}</span>
                              ) : null}
                            </div>
                            {conversation.preview && <div className="mt-1 truncate text-[10px] text-white/34">{conversation.preview}</div>}
                            <div className="mt-1.5 flex items-center justify-between text-[9px] text-white/24">
                              <span>{conversation.messageCount || 0} {t.messageCountLabel || 'messages'}</span>
                              <span>{new Date(conversation.lastActiveAt || conversation.createdAt).toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {!isOfficeCommandCenter && <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search saved history..."
                  className="h-7 w-40 px-3 py-0 text-xs bg-white/5 border border-white/10 rounded-full text-white/60 placeholder:text-white/20 outline-none focus:border-white/20 focus:bg-white/[0.07] transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchError(''); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                  >
                    <XCircle size={12} />
                  </button>
                )}
              </div>}
            </div>
          </div>
          <div
            ref={scrollRef}
            className={`flex-1 overflow-y-auto custom-scrollbar ${isOfficeCommandCenter ? 'space-y-5 px-5 py-4' : 'space-y-4 p-4 md:space-y-6 md:p-8'}`}
          >
            {messages.length === 0 && !searchQuery.trim() && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-8 px-4">
                <div className="space-y-3 opacity-20">
                  <Sparkles size={64} className="text-celestial-saturn mx-auto" />
                  <p className="text-lg font-medium">{t.awakePrompt || 'Your agent has awakened.'}<br/>{t.awakePromptSub || 'Begin the first conversation.'}</p>
                </div>
                {visibleSuggestions.length > 0 && (
                  <div className="space-y-3 max-w-md w-full">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-white/45 font-bold">
                      <Sparkles size={12} />
                      {t.tryThese || 'Try these'}
                    </div>
                    <div className="grid gap-2">
                      {visibleSuggestions.map(s => (
                        <button
                          key={s.id}
                          onClick={() => sendText(s.prompt)}
                          className="flex items-center justify-between p-4 rounded-2xl bg-white/5 border border-white/10 text-sm text-white/60 hover:text-celestial-saturn hover:border-celestial-saturn/30 hover:bg-celestial-saturn/5 transition-all text-left group"
                        >
                          <span>{s.label}</span>
                          <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-celestial-saturn" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {searchQuery.trim() && (
              <div className={`text-[10px] font-mono uppercase tracking-wider text-center ${searchError ? 'text-red-300/70' : 'text-white/30'}`}>
                {isSearchingHistory
                  ? 'Searching saved history...'
                  : searchError
                    ? searchError
                    : `${searchDisplayMessages.length} matches`}
              </div>
            )}
            {searchQuery.trim() && !isSearchingHistory && !searchError && searchDisplayMessages.length === 0 && (
              <div className="h-full flex items-center justify-center text-center text-xs text-white/30">
                No saved conversation records match.
              </div>
            )}
            {hiddenMessageCount > 0 && (
              <div className="text-center text-[10px] font-mono uppercase tracking-wider text-white/25">
                {formatUiMessage('agent-chat-page.value0-older-messages-hidden-use.3f41a4ca89', { value0: hiddenMessageCount })}
              </div>
            )}
            <AnimatePresence initial={false}>
              {displayMessages.map((msg) => (
                msg.type === 'file_context' || msg.type === 'tool' ? null /* invisible context; chat keeps the user-facing progress while detailed receipts stay in System Explorer */ : (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex flex-col ${msg.type === 'agent' ? 'items-start' : 'items-end'}`}
                >
                  {/* Image / file previews */}
                  {(() => {
                    const messageText = getDisplayText(msg);
                    let imageUrls: string[] = [];
                    try {
                      const parsed = JSON.parse(messageText || '');
                      if (parsed.images && Array.isArray(parsed.images)) imageUrls = parsed.images;
                      if (parsed.image_base64) imageUrls = [`data:image/png;base64,${parsed.image_base64}`];
                    } catch {}
                    const generatedFiles = extractGeneratedFiles(messageText);
                    if (imageUrls.length === 0 && generatedFiles.length === 0) return null;
                    return (
                      <div className="max-w-[85%] mb-1 space-y-2">
                        {imageUrls.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {imageUrls.map((url, i) => (
                              <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                                className="block w-36 h-36 rounded-2xl overflow-hidden border-2 border-white/10 hover:border-celestial-saturn/60 transition-all shadow-lg">
                                <img src={url} alt={`Generated ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                              </a>
                            ))}
                          </div>
                        )}
                        {renderGeneratedFiles(generatedFiles, msg.type === 'agent' ? 'start' : 'end')}
                      </div>
                    );
                  })()}

                  {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                    <div className={`max-w-[85%] mb-2 flex flex-wrap gap-2 ${msg.type === 'agent' ? '' : 'justify-end'}`}>
                      {msg.attachments.map((item: ChatAttachment) => {
                        const card = (
                          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-white/65">
                            {item.kind === 'image' && item.downloadUrl ? (
                              <img src={item.downloadUrl} alt={item.fileName} className="h-8 w-8 rounded-lg object-cover" loading="lazy" />
                            ) : item.kind === 'image' ? (
                              <ImageIcon size={16} className="text-celestial-saturn" />
                            ) : item.kind === 'audio' ? (
                              <Mic size={16} className="text-celestial-saturn" />
                            ) : (
                              <FileText size={16} className="text-white/45" />
                            )}
                            <span className="max-w-[180px] truncate">{item.fileName}</span>
                          </div>
                        );
                        return item.downloadUrl ? (
                          <a key={item.id} href={item.downloadUrl} target="_blank" rel="noopener noreferrer" className="transition-opacity hover:opacity-80">
                            {card}
                          </a>
                        ) : (
                          <div key={item.id}>{card}</div>
                        );
                      })}
                    </div>
                  )}

                  <div data-chat-message-bubble className={`relative group select-text leading-relaxed ${
                    msg.type === 'agent'
                      ? 'max-w-[92%] text-[15px] md:max-w-[80%] xl:max-w-[76%] rounded-[1.5rem] rounded-tl-none border border-white/10 bg-white/[0.055] p-5 text-white/85 shadow-xl shadow-black/10 md:p-6'
                      : 'max-w-[85%] text-sm rounded-3xl rounded-tr-none border border-white/10 bg-white/5 p-5 text-white/80'
                  }`}
                    style={{
                      background: msg.type === 'agent' ? chatAccentTheme.agentBubble : chatAccentTheme.userBubble,
                      borderColor: msg.type === 'agent' ? 'rgba(255,255,255,0.12)' : chatAccentTheme.panelBorder,
                      boxShadow: msg.type === 'agent'
                        ? (resolvedAppearanceMode === 'light' ? '0 16px 40px rgba(31,46,39,0.08)' : '0 16px 40px rgba(0,0,0,0.18)')
                        : `0 16px 42px ${chatAccentTheme.panelBorder}`,
                    }}
                  >
                    <div className={`markdown-body chat-message-markdown select-text ${msg.type === 'agent' ? 'chat-message-markdown-agent' : 'chat-message-markdown-user'}`}>
                      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {getDisplayText(msg)}
                      </Markdown>
                    </div>
                    {getDisplayText(msg) && (
                      <button
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => handleCopyMessage(
                          getDisplayText(msg),
                          msg.id,
                          event.currentTarget.closest('[data-chat-message-bubble]') as HTMLElement | null,
                        )}
                        className={`absolute top-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg hover:bg-white/10 ${
                          msg.type === 'agent' ? 'right-2' : 'left-2'
                        }`}
                        title={uiMessage('agent-chat-page.copy-selection-or-the-whole.063df0e978')}
                        aria-label={uiMessage('agent-chat-page.copy-selection-or-the-whole.063df0e978')}
                      >
                        {copiedId === msg.id ? (
                          <Check size={12} className="text-green-400" />
                        ) : (
                          <Copy size={12} className="text-white/55 hover:text-white/70" />
                        )}
                      </button>
                    )}
                  </div>
                  <span className="text-[12px] uppercase tracking-widest opacity-30 mt-2 px-3">
                    {msg.userName} - {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </motion.div>
              )))}
            </AnimatePresence>
            {(isTyping || chatProgressLines.length > 0) && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-start"
              >
                <div className="max-w-[92%] md:max-w-[78%] rounded-[1.35rem] rounded-tl-none border border-white/10 bg-white/[0.045] px-4 py-3 shadow-xl shadow-black/10">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/35">
                    {workflowStatus === 'done' ? (
                      <CheckCircle2 size={13} className="text-emerald-300" />
                    ) : workflowStatus === 'error' ? (
                      <XCircle size={13} className="text-red-300" />
                    ) : (
                      <Loader2 size={13} className="animate-spin text-celestial-saturn" />
                    )}
                    {uiMessage('agent-chat-page.lumi-is-working.98a841ddde', (isZh) ? 'zh' : 'en')}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {(chatProgressLines.length > 0
                      ? chatProgressLines.slice(-3)
                      : [{ id: 'chat-progress-fallback', text: uiMessage('agent-chat-page.i-am-figuring-out-how.017a8f967e', (isZh) ? 'zh' : 'en'), tone: 'thinking', time: Date.now() }]
                    ).map((line, index, list) => (
                      <div
                        key={line.id}
                        className={`text-sm leading-relaxed ${
                          line.tone === 'error'
                            ? 'text-red-100/80'
                            : line.tone === 'done'
                              ? 'text-emerald-100/80'
                              : index === list.length - 1
                                ? 'text-white/78'
                                : 'text-white/43'
                        }`}
                      >
                        {line.text}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </div>

          <div
            className={`lumi-chat-composer border-t ${isOfficeCommandCenter ? 'p-4' : 'p-6'}`}
            style={chatInputPanelStyle}
          >
            {conversationAttachments.length > 0 && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-cyan-200/15 bg-cyan-200/[0.055] px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5 text-xs text-cyan-50/72">
                  <Briefcase size={14} className="shrink-0 text-cyan-200/70" />
                  <span className="truncate">
                    {formatUiMessage('agent-chat-page.session-materials-active.f044bfab71', { value0: conversationAttachments.length })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={clearConversationAttachmentContext}
                  className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-white/38 transition-colors hover:bg-white/[0.07] hover:text-white/70"
                  title={uiMessage('agent-chat-page.clear-session-materials.d06ef7bb05')}
                >
                  {uiMessage('agent-chat-page.clear.25b4e5dc64')}
                </button>
              </div>
            )}
            {pendingAttachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {pendingAttachments.map(item => (
                  <div key={item.id} className="flex max-w-full flex-col gap-1.5 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/70">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.kind === 'image' && item.downloadUrl ? (
                        <img src={item.downloadUrl} alt={item.fileName} className="h-8 w-8 rounded-lg object-cover" />
                      ) : item.kind === 'image' ? (
                        <ImageIcon size={16} className="shrink-0 text-celestial-saturn" />
                      ) : item.kind === 'audio' ? (
                        <Mic size={16} className="shrink-0 text-celestial-saturn" />
                      ) : (
                        <FileText size={16} className="shrink-0 text-white/45" />
                      )}
                      <span className="max-w-[220px] truncate">{item.fileName}</span>
                      {item.kind === 'audio' && item.transcript && (
                        <span className="rounded-full border border-emerald-300/15 bg-emerald-300/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-100/80">
                          STT
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removePendingAttachment(item.id)}
                        className="ml-1 rounded-full p-0.5 text-white/30 transition-colors hover:bg-white/10 hover:text-white/70"
                        title={uiMessage('agent-chat-page.remove-attachment.10963433c4')}
                        aria-label={uiMessage('agent-chat-page.remove-attachment.10963433c4')}
                      >
                        <XCircle size={13} />
                      </button>
                    </div>
                    {item.kind === 'audio' && item.transcript && (
                      <div className="max-h-10 max-w-[520px] overflow-hidden text-xs leading-5 text-emerald-50/60">
                        {item.transcript}
                      </div>
                    )}
                    {item.kind === 'audio' && !item.transcript && item.transcriptionError && (
                      <div className="max-w-[520px] truncate text-xs text-red-200/70">
                        {item.transcriptionError}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isOptimizing && (
              <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-white/5">
                <motion.div
                  className="h-full bg-celestial-saturn"
                  initial={{ width: 0 }}
                  animate={{ width: `${optimizationProgress}%` }}
                />
              </div>
            )}
            <form onSubmit={handleSendMessage} className="lumi-chat-composer-row relative flex gap-3">
              <div ref={attachmentMenuRef} className="relative shrink-0">
                <Button
                  type="button"
                  onClick={() => setShowAttachmentMenu(value => !value)}
                  disabled={isTyping || isOptimizing}
                  variant="ghost"
                  className={`lumi-chat-attachment-button h-12 w-12 shrink-0 rounded-2xl border bg-black/30 p-0 transition-all disabled:opacity-40 ${
                    showAttachmentMenu
                      ? 'border-celestial-saturn/35 bg-celestial-saturn/10 text-celestial-saturn'
                      : 'border-white/10 text-white/45 hover:border-celestial-saturn/30 hover:bg-celestial-saturn/10 hover:text-celestial-saturn'
                  }`}
                  title={uiMessage('agent-chat-page.add-file-to-message.50db7cd91e')}
                  aria-label={uiMessage('agent-chat-page.add-file-to-message.50db7cd91e')}
                  aria-expanded={showAttachmentMenu}
                >
                  {isOptimizing ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                </Button>
                <AnimatePresence>
                  {showAttachmentMenu && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ duration: 0.14 }}
                      className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/96 shadow-2xl backdrop-blur-2xl"
                    >
                      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5 text-[11px] font-bold text-white/55">
                        <FolderOpen size={13} />
                        <span>{uiMessage('agent-chat-page.reference-existing-file.6fa56c6cba')}</span>
                      </div>
                      <div className="max-h-64 overflow-y-auto p-1.5 custom-scrollbar">
                        {referenceableChatFiles.map(item => {
                          const attached = pendingAttachmentKeys.has(chatAttachmentIdentity(item));
                          return (
                            <button
                              key={`attach-menu-${item.id}`}
                              type="button"
                              onClick={() => referenceChatFile(item)}
                              disabled={attached}
                              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.07] disabled:cursor-default disabled:bg-emerald-300/[0.06]"
                              title={item.path || item.fileName}
                            >
                              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                                attached ? 'bg-emerald-300/12 text-emerald-100' : 'bg-white/[0.06] text-white/50'
                              }`}>
                                {attached ? <Check size={13} /> : item.kind === 'image' ? <ImageIcon size={13} /> : item.kind === 'audio' ? <Mic size={13} /> : <FileText size={13} />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-semibold text-white/75">{item.fileName}</span>
                                <span className="mt-0.5 block truncate text-[10px] text-white/35">{item.subtitle}</span>
                              </span>
                            </button>
                          );
                        })}
                        {referenceableChatFiles.length === 0 && (
                          <div className="px-3 py-4 text-center text-xs text-white/35">
                            {knowledgeLoading
                              ? uiMessage('agent-chat-page.syncing-knowledge.21a09d4faa')
                              : uiMessage('agent-chat-page.no-existing-files.84d0f3dc9e')}
                          </div>
                        )}
                      </div>
                      <div className="border-t border-white/[0.07] p-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setShowAttachmentMenu(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/85"
                        >
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-white/55">
                            <Upload size={13} />
                          </span>
                          <span>{uiMessage('agent-chat-page.import-new-file-from-computer.45aa481ab4')}</span>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div className="relative flex-1">
                <Input
                  ref={messageInputRef}
                  defaultValue=""
                  onChange={(e) => updateDraftText(e.target.value)}
                  placeholder={t.communicatePlaceholder || "Communicate with your essence..."}
                  className="bg-black/40 border-white/10 rounded-2xl py-6 pr-12 focus-visible:ring-celestial-saturn/50"
                  style={chatInputStyle}
                />
                <Button
                  type="button"
                  onClick={toggleListening}
                  variant="ghost"
                  className={`absolute right-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full p-0 transition-colors ${isOfficeCommandCenter ? 'hidden' : ''} ${
                    isListening ? 'text-celestial-mars bg-celestial-mars/20 animate-pulse' : 'text-white/40 hover:text-white'
                  }`}
                >
                  <Mic size={18} />
                </Button>
              </div>
              {isTyping ? (
                <Button
                  type="button"
                  onClick={cancelActiveChat}
                  className="lumi-chat-send bg-red-500 text-white rounded-2xl px-6 hover:scale-105 transition-transform"
                >
                  <Square size={20} />
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={!hasDraftText && pendingAttachments.length === 0}
                  className="lumi-chat-send bg-celestial-saturn text-black rounded-2xl px-6 hover:scale-105 transition-transform disabled:opacity-50 disabled:hover:scale-100"
                  style={{
                    backgroundColor: chatAccentTheme.saturn,
                    boxShadow: `0 12px 34px ${chatAccentTheme.panelBorder}`,
                  }}
                >
                  <Send size={20} />
                </Button>
              )}
            </form>
          </div>
        </div>
        </>

        {/* Command Center or standalone chat information */}
        {layout === 'command-center' ? null : (
          <>
        {/* Info Sidebar */}
            <motion.div
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1], delay: 0.15 }}
              className="hidden w-80 flex-shrink-0 space-y-4 overflow-y-auto custom-scrollbar xl:block 2xl:w-96">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.16 }}>
          <GlassCard className="p-5 rounded-[2rem] space-y-4 border-emerald-400/20" hoverEffect={false}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/45">
                  <FolderOpen size={14} />
                  {uiMessage('agent-chat-page.chat-files.bfc05d58f7')}
                </h4>
                <p className="mt-1 truncate text-[11px] text-white/32">{knowledgeStatusText}</p>
              </div>
              <button
                type="button"
                onClick={() => void refreshKnowledgeFiles()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
                title={uiMessage('agent-chat-page.refresh-files.7b90fd0f8a')}
                aria-label={uiMessage('agent-chat-page.refresh-files.7b90fd0f8a')}
              >
                {knowledgeLoading ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
              </button>
            </div>

            <div className="max-h-[22rem] space-y-3 overflow-y-auto pr-1 custom-scrollbar">
              {chatFileSections.pending.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('agent-chat-page.current-attachments.9deb8aeeb4')}</div>
                  {chatFileSections.pending.map(renderChatFileRow)}
                </div>
              )}
              {chatFileSections.generated.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('agent-chat-page.generated-files.f3b9745393')}</div>
                  {chatFileSections.generated.map(renderChatFileRow)}
                </div>
              )}
              {chatFileSections.knowledge.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('agent-chat-page.knowledge-files.cc19d1427e')}</div>
                  {chatFileSections.knowledge.map(renderChatFileRow)}
                </div>
              )}
              {chatFileSections.pending.length === 0 && chatFileSections.generated.length === 0 && chatFileSections.knowledge.length === 0 && (
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-4 text-center text-xs text-white/35">
                  {uiMessage('agent-chat-page.no-files-available-yet.6ac4767777')}
                </div>
              )}
            </div>
          </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.2 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4 border-celestial-saturn/20" hoverEffect={false}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.activeCapabilities || 'Active Capabilities'}</h4>
              {isElectron && (
                <div className="px-2 py-0.5 rounded-full bg-celestial-saturn/20 text-xs text-celestial-saturn font-black">NODE_NATIVE</div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {activeCapabilities.map((cap, i) => (
                <div key={i} className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/5 text-xs text-white/60 font-bold flex items-center gap-2">
                  <div className="w-1 h-1 rounded-full bg-celestial-saturn" />
                  {cap}
                </div>
              ))}
            </div>
          </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.36 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.agentStats || 'Agent Stats'}</h4>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 flex items-center gap-2"><Cpu size={14}/> {t.logicEngine || 'Logic Engine'}</span>
                <span className="text-sm font-bold text-celestial-saturn">v1.0.2</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 flex items-center gap-2"><Zap size={14}/> {t.syncSpeed || 'Sync Speed'}</span>
                <span className="text-sm font-bold text-celestial-mars">8.4ms</span>
              </div>
            </div>
          </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.44 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.neuralMeshStatus || 'Neural Mesh Status'}</h4>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-bold">{t.encryptedLinkActive || 'Encrypted Link Active'}</span>
            </div>
            <p className="text-xs text-white/40 leading-relaxed">
              {t.agentSyncDesc || 'Your agent is currently synchronized with the local node. All interactions are stored in your private neural cloud.'}
            </p>
          </GlassCard>
          </motion.div>
            </motion.div>
          </>
        )}
      </div>}
    </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
