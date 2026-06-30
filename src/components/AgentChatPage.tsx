import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, ArrowLeft, Ghost, Zap, Cpu, Sparkles, FileText, Mic, CheckCircle2, Pause, Play, Square, ChevronDown, ChevronRight, XCircle, Copy, Check, Paperclip, Image as ImageIcon, Download, MessageCircle, Briefcase, User } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useTTS } from '@/hooks/useTTS';
import { GlassCard, PulseCounter } from './SharedUI';
import { toast } from 'sonner';
import { FoundersSanctuary } from './FoundersSanctuary';
import * as conversationService from '@/services/conversationService';
import * as agentService from '@/services/agentService';
import { usePlatform } from '@/hooks/usePlatform';
import { runAgentLogic, AgentResponse } from '@/services/agentService';
import { useApp } from '@/contexts/AppContext';
import { VoiceCallButton } from './VoiceCallButton';
import { socketService } from '@/services/socketService';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useVoiceCloning } from '@/hooks/useVoiceCloning';
import { listVoices } from '@/services/voiceService';
import WorkflowPanel, { type BackgroundWorkflowTask, type WorkflowStep } from './WorkflowPanel';
import { WeChatSettings } from './WeChatSettings';
import type { FileEntry } from './MemoryTree';

const CHAT_HISTORY_LIMIT = 300;
const CHAT_RENDER_LIMIT = 80;
const CHAT_SEARCH_LIMIT = 200;
type WorkflowStatus = 'idle' | 'thinking' | 'background' | 'executing' | 'waiting_confirmation' | 'done' | 'error';

type ChatAttachment = {
  id: string;
  fileName: string;
  path?: string;
  content?: string | null;
  preview?: string | null;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'audio' | 'file';
  downloadUrl?: string;
};

type GeneratedFileLink = {
  id: string;
  fileName: string;
  path: string;
  url: string;
  kind: 'image' | 'document' | 'deck' | 'sheet' | 'pdf' | 'cad' | 'file';
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

function buildChatHistoryPayload(messages: any[]) {
  return messages.flatMap((m) => {
    const text = getDisplayText(m).trim();
    const attachmentSummary = Array.isArray(m.attachments) && m.attachments.length > 0
      ? `\n\n[Attachments]\n${m.attachments.map((item: ChatAttachment) => `- ${item.fileName}${item.kind === 'image' ? ' (image)' : item.kind === 'audio' ? ' (audio)' : ''}`).join('\n')}`
      : '';
    if (!text && !attachmentSummary) return [];
    if (m.type === 'tool') return [];
    if (['error', 'proactive'].includes(m.source)) return [];
    if (/^(Request failed|请求失败|出错了|Failed to route)/i.test(text)) return [];
    if (m.type === 'agent') return [{ role: 'assistant', content: text }];
    if (m.type === 'user' || m.type === 'file_context') return [{ role: 'user', content: `${text}${attachmentSummary}`.trim() }];
    return [];
  }).slice(-80);
}

function isImageFileName(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name || '');
}

function isAudioFileName(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('audio/')) || /\.(mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i.test(name || '');
}

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

export function AgentChatPage({ t, user, agent, isOpen, onClose, prefillMessage, onPrefillConsumed }: { t: any; user: any; agent?: any; isOpen: boolean; onClose: () => void; prefillMessage?: string; onPrefillConsumed?: () => void }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [agentMetadata, setAgentMetadata] = useState<Partial<AgentResponse>>({});
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const { platform, isElectron } = usePlatform();
  const { aiConfig, orgConnection, workDomain } = useApp();
  const isWorkChat = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const activeDomain = isWorkChat ? 'work' : 'personal';
  const activeOrgId = isWorkChat ? orgConnection?.orgId : undefined;
  const activeDomainLabel = isWorkChat ? ui('公司域 Lumi', 'Company Lumi') : ui('个人 Lumi', 'Personal Lumi');
  const activeDomainDetail = isWorkChat
    ? ui('当前消息、附件、记忆和工具调用进入组织工作域。', 'Messages, attachments, memories, and tools are scoped to the organization.')
    : ui('当前消息只进入个人域，不写入组织知识和组织记忆。', 'Messages stay in your personal domain and do not write to organization knowledge or memory.');
  const socket = socketService.connect();
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>();
  const [voices, setVoices] = useState<any[]>([]);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showWeChatSettings, setShowWeChatSettings] = useState(false);
  const voicePickerRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [installedSkillNames, setInstalledSkillNames] = useState<string[]>([]);

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
    { id: 'chat', label: t.suggestChat || ui('随便聊聊', 'Just Chat'), prompt: ui('你好 Lumi，今天有什么有趣的发现吗？', 'Hi Lumi, any interesting discoveries today?'), show: true },
    { id: 'creative', label: t.suggestCreative || ui('生成一张图片', 'Generate Image'), prompt: ui('帮我生成一张星空下的赛博朋克城市图片', 'Generate an image of a cyberpunk city under a starry sky'), show: hasCreativeSkill },
    { id: 'fetch', label: t.suggestFetch || ui('总结网页内容', 'Summarize Webpage'), prompt: ui('帮我抓取这篇文章的内容并总结要点', 'Fetch this article and summarize the key points'), show: hasFetcher },
    { id: 'desktop', label: t.suggestDesktop || ui('桌面整理', 'Organize Desktop'), prompt: ui('帮我把桌面上的文件按日期整理一下', 'Organize the desktop files by date'), show: hasDesktop },
    { id: 'music', label: t.suggestMusic || ui('创作一首音乐', 'Create Music'), prompt: ui('帮我创作一首舒缓的钢琴曲，带有海浪的声音', 'Create a calm piano track with ocean wave ambience'), show: hasCreativeSkill },
  ];

  const visibleSuggestions = quickSuggestions.filter(s => s.show).slice(0, 4);

  const { callState, audioLevel, startCall, endCall, error: callError } = useVoiceCall({
    socket,
    onTranscript: (text, isFinal) => {
      if (isFinal) {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
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
  }, [selectedVoiceId]);

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

  const messageInputRef = useRef<HTMLInputElement>(null);
  const draftTextRef = useRef('');
  const [hasDraftText, setHasDraftText] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [optimizationProgress, setOptimizationProgress] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [knowledgeFiles, setKnowledgeFiles] = useState<FileEntry[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('idle');
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [backgroundWorkflowTasks, setBackgroundWorkflowTasks] = useState<BackgroundWorkflowTask[]>([]);
  const { speak, stop, pause, resume, isSpeaking, isPaused } = useTTS();
  const recognition = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentNameRef = useRef<string>('Lumi');
  const seenToolEventIds = useRef<Set<string>>(new Set());
  const seenWorkflowToolEvents = useRef<Set<string>>(new Set());
  const backgroundTaskStatusRef = useRef<Map<string, string>>(new Map());

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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showVoicePicker, showWeChatSettings]);

  const agentName = agent?.name || (t.lumiEssence || 'Lumi Essence');
  const agentCategory = agent?.category || (t.friend || 'friend');
  const agentId = agent?.id || 'lumi';
  const toolFailureHint = t.toolFailureHint || 'Check permission, adjust the request, or ask Lumi to retry.';
  const scopedConversationUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}domain=${encodeURIComponent(activeDomain)}&agentId=${encodeURIComponent(agentId)}`;
  }, [activeDomain, agentId]);
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

  const recentKnowledgeFiles = useMemo(() => knowledgeFiles.slice(0, 4), [knowledgeFiles]);
  const readyKnowledgeCount = useMemo(() => knowledgeFiles.filter(isKnowledgeReady).length, [isKnowledgeReady, knowledgeFiles]);
  const knowledgeStatusText = knowledgeFiles.length > 0
    ? ui(`${readyKnowledgeCount}/${knowledgeFiles.length} 个资料可用于对话`, `${readyKnowledgeCount}/${knowledgeFiles.length} knowledge files available`)
    : knowledgeLoading
      ? ui('正在同步资料库', 'Syncing knowledge')
      : ui('暂无资料', 'No knowledge files');
  const requestMeetingMode = useCallback(() => {
    window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode'));
  }, []);
  const isFounder = agentId === 'founder' || agentCategory === 'founder' || agentName.includes('Founder') || agentName.includes('创始人');

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

  const handleCopyMessage = useCallback(async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  }, []);

  const renderGeneratedFiles = useCallback((files: GeneratedFileLink[], align: 'start' | 'end' = 'start') => {
    if (files.length === 0) return null;
    const labelFor = (kind: GeneratedFileLink['kind']) => {
      if (kind === 'deck') return ui('演示文稿', 'Presentation');
      if (kind === 'sheet') return ui('表格', 'Spreadsheet');
      if (kind === 'pdf') return 'PDF';
      if (kind === 'cad') return 'CAD';
      if (kind === 'image') return ui('图片', 'Image');
      if (kind === 'document') return ui('文档', 'Document');
      return ui('文件', 'File');
    };

    return (
      <div className={`max-w-[92%] mb-3 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {files.map(file => (
          <a
            key={file.id}
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex min-w-0 max-w-[280px] items-center gap-3 rounded-2xl border border-emerald-400/15 bg-emerald-400/10 px-3 py-2.5 text-left transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15"
            title={file.path}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-200">
              {file.kind === 'image' ? <ImageIcon size={17} /> : <FileText size={17} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-white/80">{file.fileName}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-emerald-100/55">
                <Download size={11} />
                <span>{labelFor(file.kind)}</span>
              </div>
            </div>
          </a>
        ))}
      </div>
    );
  }, [isZh]);

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
      const userText = role === 'assistant' ? '' : (m.content || m.message || '');
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
    const conversationScopeKey = `${agentId}:${activeDomain}:${activeOrgId || ''}`;
    if (conversationScopeKey !== lastConversationScopeRef.current) {
      lastConversationScopeRef.current = conversationScopeKey;
      initialLoadDoneRef.current = false;
      setMessages([]);
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
            const msgRes = await fetch(scopedConversationUrl(`/api/conversations/${conv.id}/messages?limit=${CHAT_HISTORY_LIMIT}`));
            const msgData = await msgRes.json();
            if (msgData.messages && Array.isArray(msgData.messages)) {
              setMessages(normalizePersistedMessages(msgData.messages));
            }
          }
        })
        .catch(() => {});
  }, [agentId, isFounder, normalizePersistedMessages, scopedConversationUrl]);

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
  const initialLoadDoneRef = useRef(false);
  const lastConversationScopeRef = useRef<string>('');

  useEffect(() => {
    if (isFounder || !socket) return;

    const isCurrentChatEvent = (data?: { requestId?: string; source?: string }) => {
      if (data?.requestId) return data.requestId === activeChatRequestIdRef.current;
      if (data?.source && data.source !== 'chat') return false;
      return textChatActiveRef.current;
    };

    const onProactive = (data: { message: string; timestamp: string; requestId?: string; source?: string; type?: string; taskId?: string }) => {
      const proactiveType = data.type || data.taskId;
      if (proactiveType === 'greeting' && localStorage.getItem('lumi_allow_proactive_voice') !== 'true') return;
      if ((data.requestId || data.source) && !isCurrentChatEvent(data)) return;
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

    const onChunk = (data: { text: string; agentName: string; requestId?: string; source?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      if (streamingMsgId.current) {
        setMessages(prev => prev.map(m =>
          m.id === streamingMsgId.current ? { ...m, text: m.text + data.text } : m
        ));
      } else {
        const id = Date.now().toString();
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

    const onTool = (data: { correlationId?: string; name: string; args?: any; arguments?: any; result?: string; error?: string; requestId?: string; source?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const eventId = data.correlationId || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const args = data.arguments ?? data.args;
      const status = data.error ? 'error' : (data.result !== undefined ? 'done' : 'running');
      const phase = data.error !== undefined ? 'error' : data.result !== undefined ? 'result' : 'start';
      const nextMessage = {
        id: eventId,
        userName: data.name,
        text: data.error || data.result || '',
        timestamp: new Date().toISOString(),
        type: 'tool',
        toolName: data.name,
        toolArgs: args,
        toolResult: data.result,
        toolError: data.error,
        toolStatus: status,
      };

      setMessages(prev => {
        const existingIndex = prev.findIndex(m => m.id === eventId);
        if (existingIndex !== -1) {
          const updated = [...prev];
          updated[existingIndex] = { ...updated[existingIndex], ...nextMessage };
          return updated;
        }
        if (seenToolEventIds.current.has(eventId)) return prev;
        seenToolEventIds.current.add(eventId);
        return [...prev, nextMessage];
      });

      if (data.correlationId) {
        const workflowEventKey = `${data.correlationId}:${phase}`;
        if (seenWorkflowToolEvents.current.has(workflowEventKey)) return;
        seenWorkflowToolEvents.current.add(workflowEventKey);
      }

      setWorkflowStatus('executing');
      if (data.result !== undefined) {
        setWorkflowSteps(prev => [...prev, {
          id: `chat-tool-ok-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'tool_result',
          text: `${data.name} ${t.workflowToolDone || 'done'}`,
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

    const onConfirmTool = (data: { correlationId: string; name: string; arguments?: any; requestId?: string; source?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      setWorkflowStatus('waiting_confirmation');
      const argsSummary = data.arguments
        ? Object.entries(data.arguments).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : String(v).slice(0, 30)}`).join(', ')
        : '';
      setWorkflowSteps(prev => [...prev, {
        id: `chat-confirm-${data.correlationId || Date.now()}`,
        type: 'confirmation',
        text: `${t.workflowWaitingConfirm || 'Waiting for approval'}: ${data.name}`,
        detail: argsSummary || (t.workflowConfirmHint || 'Review the permission dialog to continue.'),
        time: Date.now(),
      }]);
    };

    const onResponse = (data: { text: string; agentName: string; source?: string; requestId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      setIsTyping(false);
      setWorkflowStatus('done');
      setWorkflowSteps(prev => [...prev, {
        id: `chat-resp-${Date.now()}`,
        type: 'response',
        text: t.workflowResponseReady || 'Response ready',
        detail: data.text?.slice(0, 100),
        time: Date.now(),
      }]);
      setTimeout(() => {
        setWorkflowStatus('idle');
        setWorkflowSteps([]);
        seenWorkflowToolEvents.current.clear();
      }, 5000);
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
          id: Date.now().toString(),
          text: data.text,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent'
        }]);
      }
      // Auto-speak disabled
    };

    const onStatus = (data: { status: string; requestId?: string; source?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      setIsTyping(data.status === "thinking");
      if (data.status === 'thinking') {
        setWorkflowStatus('thinking');
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
      } else if (data.status === 'idle') {
        setWorkflowStatus('done');
        setWorkflowSteps(prev => [...prev, {
          id: `chat-done-${Date.now()}`,
          type: 'response',
          text: t.workflowCompleted || 'Completed',
          time: Date.now(),
        }]);
        setTimeout(() => {
          setWorkflowStatus('idle');
          setWorkflowSteps([]);
          seenWorkflowToolEvents.current.clear();
        }, 5000);
      } else if (data.status === 'error') {
        setWorkflowStatus('error');
        setTimeout(() => {
          setWorkflowStatus('idle');
          setWorkflowSteps([]);
          seenWorkflowToolEvents.current.clear();
        }, 5000);
      }
      if (data.status === "idle" || data.status === "error") {
        // Drop partial streaming chunks that were never finalized
        if (streamingMsgId.current) {
          const sid = streamingMsgId.current;
          setMessages(prev => prev.filter(m => m.id !== sid));
          streamingMsgId.current = null;
        }
      }
    };

    const onError = (data: { message: string; code?: string; requestId?: string; source?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      setIsTyping(false);
      setWorkflowStatus('error');
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
      toast.error(message);
    };

    // conversation_updated: only reload for non-text-chat channels (voice, etc.)
    // Text chat state is managed live via agent:chunk/agent:response; API reload here
    // would replace messages with different ids, causing React to remount & re-animate them.
    const onConversationUpdated = (data: { conversationId: string; agentId: string; source?: string }) => {
      if (data.agentId !== agentId) return;
      if (data.source === 'chat' || textChatActiveRef.current) return;
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

    socket.on("agent:proactive", onProactive);
    socket.on("agent:delegation", onDelegation);
    socket.on("agent:background_task_update", onBackgroundTaskUpdate);
    socket.on("agent:chunk", onChunk);
    socket.on("agent:tool", onTool);
    socket.on("agent:tool_call", onTool);
    socket.on("agent:confirm_tool", onConfirmTool);
    socket.on("agent:response", onResponse);
    socket.on("agent:status", onStatus);
    socket.on("agent:error", onError);
    socket.on("chat:conversation_updated", onConversationUpdated);

    return () => {
      socket.off("agent:proactive", onProactive);
      socket.off("agent:delegation", onDelegation);
      socket.off("agent:background_task_update", onBackgroundTaskUpdate);
      socket.off("agent:chunk", onChunk);
      socket.off("agent:tool", onTool);
      socket.off("agent:tool_call", onTool);
      socket.off("agent:confirm_tool", onConfirmTool);
      socket.off("agent:response", onResponse);
      socket.off("agent:status", onStatus);
      socket.off("agent:error", onError);
      socket.off("chat:conversation_updated", onConversationUpdated);
      stop();
    };
  }, [speak, stop, isFounder, socket, normalizePersistedMessages, scopedConversationUrl]);

  useEffect(() => {
    // Scroll to bottom when messages change (new messages, initial load)
    if (scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [messages]);

  // Scroll to bottom on mount when messages first load
  useEffect(() => {
    if (messages.length > 0 && scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) return;
    setWorkflowStatus('idle');
    setWorkflowSteps([]);
    seenWorkflowToolEvents.current.clear();
  }, [isOpen]);

  const sendText = async (text: string, attachments: ChatAttachment[] = pendingAttachments) => {
    const trimmedText = text.trim();
    const outgoingAttachments = attachments.map(item => ({
      id: item.id,
      fileName: item.fileName,
      path: item.path,
      content: item.content || null,
      preview: item.preview || null,
      mimeType: item.mimeType || '',
      size: item.size || 0,
      kind: item.kind,
      downloadUrl: item.downloadUrl,
    }));
    if ((!trimmedText && outgoingAttachments.length === 0) || !user) return;
    const outgoingText = trimmedText || ui('请帮我看看这些附件。', 'Please review these attachments.');

    const userMsg = {
      id: Date.now().toString(),
      text: outgoingText,
      attachments: outgoingAttachments,
      userName: user.displayName || user.username || (t.chatUserFallback || 'User'),
      timestamp: new Date().toISOString(),
      type: 'user'
    };
    textChatActiveRef.current = true;
    seenWorkflowToolEvents.current.clear();
    setWorkflowStatus('thinking');
    setWorkflowSteps([{
      id: `chat-start-${Date.now()}`,
      type: 'thinking',
      text: t.workflowAnalyzing || 'Analyzing your request...',
      time: Date.now(),
    }]);

    setMessages(prev => [...prev, userMsg]);
    setDraftText('');
    setPendingAttachments(prev => prev.filter(item => !outgoingAttachments.some(sent => sent.id === item.id)));
    stop();
    setIsTyping(true);
    const requestId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeChatRequestIdRef.current = requestId;

    let resolved = false;
    let safetyTimer: ReturnType<typeof setTimeout>;
    let restFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrentResponse = (data?: { requestId?: string; source?: string }) => {
      if (data?.requestId) return data.requestId === requestId;
      if (data?.source && data.source !== 'chat') return false;
      return true;
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
      if (restFallbackTimer) clearTimeout(restFallbackTimer);
      cleanupSocketWaiters();
      setIsTyping(false);
      textChatActiveRef.current = false;
      if (activeChatRequestIdRef.current === requestId) activeChatRequestIdRef.current = null;
    };
    const onResponse = (data?: { requestId?: string; source?: string }) => { if (isCurrentResponse(data)) resolve(); };
    const onError = (data?: { requestId?: string; source?: string }) => { if (isCurrentResponse(data)) resolve(); };
    const onStatus = (data: { status: string; requestId?: string; source?: string }) => {
      if (!isCurrentResponse(data)) return;
      if (data.status === 'idle' || data.status === 'error') resolve();
    };
    safetyTimer = setTimeout(() => {
      if (!resolved) {
        streamingMsgId.current = null;
        resolve();
      }
    }, outgoingAttachments.length > 0 ? 60000 : 30000);

    socket.on('agent:response', onResponse);
    socket.on('agent:error', onError);
    socket.on('agent:status', onStatus);

    // Always try socket first
    socket.emit("agent:chat", {
      text: outgoingText,
      attachments: outgoingAttachments,
      history: buildChatHistoryPayload(messages),
      personalityId: 'lumi',
      category: agentCategory,
      agentId,
      domain: activeDomain,
      orgId: activeOrgId || null,
      source: 'chat',
      requestId,
    });

    // Parallel REST fallback after 5s if socket hasn't responded. It is text-only,
    // so attachment turns wait for the socket path that preserves file context.
    restFallbackTimer = outgoingAttachments.length === 0 ? setTimeout(async () => {
      if (resolved) return;
      try {
        const response = await runAgentLogic(outgoingText, { platform, aiConfig });
        if (resolved) return;
        resolve();
        setAgentMetadata(response);
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          text: response.text,
          userName: agentName,
          timestamp: new Date().toISOString(),
          type: 'agent'
        }]);
      } catch (err) {
        resolve();
        const message = t.failedToRouteNeuralMesh || "Failed to route through Neural Mesh.";
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: `${t.requestFailed || 'Request failed'}\n\n${message}`,
          userName: agentName,
          timestamp: new Date().toISOString(),
          type: 'agent',
          source: 'error',
        }]);
        toast.error(message);
      }
    }, 5000) : null;
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
          source: 'proactive',
        }];
      });
      onPrefillConsumed?.();
    }
  }, [prefillMessage, onPrefillConsumed]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    sendText(draftTextRef.current.trim(), pendingAttachments);
  };

  const toggleListening = () => {
    if (!recognition.current) {
      toast.error(t.speechNotSupported || "Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      recognition.current.stop();
    } else {
      stop(); // Stop TTS if speaking
      recognition.current.start();
      setIsListening(true);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadChatAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsOptimizing(true);
    setOptimizationProgress(30);

    const fileList = Array.from(files);
    const formData = new FormData();
    fileList.forEach(f => formData.append('files', f));

    try {
      formData.append('domain', activeDomain);
      if (activeDomain === 'work' && activeOrgId) formData.append('orgId', activeOrgId);

      const res = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        const attachments: ChatAttachment[] = (d.files || []).map((f: any) => {
          const fileName = f.name || f.displayName || f.id || 'attachment';
          const mimeType = f.mimeType || '';
          const kind: ChatAttachment['kind'] =
            f.kind === 'image' || isImageFileName(fileName, mimeType) ? 'image' :
            f.kind === 'audio' || isAudioFileName(fileName, mimeType) ? 'audio' :
            'file';
          return {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fileName,
            path: f.path,
            content: f.content || null,
            preview: f.preview || null,
            mimeType,
            size: f.rawSize || f.size || 0,
            kind,
            downloadUrl: f.id ? scopedFileUrl(`/api/files/download/${encodeURIComponent(f.id)}?inline=1`) : undefined,
          };
        });
        setPendingAttachments(prev => [...prev, ...attachments]);
        setOptimizationProgress(100);
        setTimeout(() => { setIsOptimizing(false); setOptimizationProgress(0); }, 500);
        if (attachments.length > 0) toast.success(ui('已添加到本条消息', 'Attached to this message'));
        notifyKnowledgeUpdated(attachments.map(item => ({ id: item.path || item.fileName, name: item.fileName, displayName: item.fileName })));
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
  };

  const removePendingAttachment = (id: string) => {
    setPendingAttachments(prev => prev.filter(item => item.id !== id));
  };

  if (isFounder) {
    return <FoundersSanctuary t={t} user={user} onBack={onClose} />;
  }

  const workflowHasExecution = workflowSteps.some(step =>
    step.type === 'background' ||
    step.type === 'confirmation' ||
    step.type === 'tool_start' ||
    step.type === 'tool_result' ||
    step.type === 'error'
  );
  const workflowPanelVisible =
    isOpen &&
    (workflowStatus !== 'idle' || workflowSteps.length > 0 || workflowHasExecution || backgroundWorkflowTasks.length > 0);
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
          className="fixed inset-0 z-[210] flex flex-col"
          style={{
            background: 'radial-gradient(ellipse at 50% 30%, #0a0f1e 0%, #060810 40%, #020205 100%)',
            willChange: 'opacity, transform',
          }}
        >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        onChange={(e) => { uploadChatAttachments(e.target.files); e.target.value = ''; }}
      />
      <WorkflowPanel
        visible={workflowPanelVisible}
        agentStatus={workflowStatus}
        steps={workflowSteps}
        t={t}
        placement="corner"
        backgroundTasks={backgroundWorkflowTasks}
        onCancelBackgroundTask={cancelBackgroundWorkflowTask}
      />
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
                  <h3 className="text-sm font-bold text-white">{ui('个人微信连接', 'Personal WeChat')}</h3>
                  <p className="mt-1 text-xs text-white/40">{ui('扫码后，Lumi 可以通过你的个人微信接收消息。', 'After scanning, Lumi can receive messages through your personal WeChat.')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowWeChatSettings(false)}
                  className="rounded-full p-1.5 text-white/35 transition-colors hover:bg-white/10 hover:text-white"
                  aria-label={ui('关闭', 'Close')}
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
    <div className="flex-1 max-w-[90rem] mx-auto w-full space-y-4 md:space-y-8 pb-32 md:pb-0 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-4 md:px-0 pt-6 flex-shrink-0">
        <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-3">
          <div className="relative">
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
          </div>

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
              title={ui('个人微信连接', 'Personal WeChat')}
              aria-label={ui('打开个人微信连接', 'Open personal WeChat connection')}
            >
              <MessageCircle className="h-4 w-4 md:h-5 md:w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={requestMeetingMode}
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-200 transition-all hover:border-cyan-300/35 hover:bg-cyan-400/15 md:h-10 md:w-10"
            title={ui('会议模式', 'Meeting mode')}
            aria-label={ui('打开会议模式', 'Open meeting mode')}
          >
            <FileText className="h-4 w-4 md:h-5 md:w-5" />
          </button>
          <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn border border-celestial-saturn/20">
            <Ghost className="w-4 h-4 md:w-5 md:h-5" />
          </div>
          <div className="text-right sm:text-left">
            <h2 className="text-base md:text-xl font-bold tracking-tight truncate max-w-[120px] sm:max-w-none flex items-center gap-2">
              {agentName}
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
            </h2>
            <p className="text-xs md:text-xs uppercase tracking-widest text-white/40 font-bold">{agentCategory}</p>
          </div>
        </div>
      </div>

      <div className="flex gap-3 flex-1 min-h-0">

        {/* Chat Panel */}
        <div className="flex-1 flex flex-col glass rounded-[2.5rem] md:rounded-[3rem] border-white/10 overflow-hidden shadow-2xl min-w-0">
          <div className="p-4 md:p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-celestial-nebula animate-ping' : 'bg-celestial-saturn animate-pulse'}`} />
              <span className="text-xs md:text-xs font-bold uppercase tracking-widest text-white/60">
                Neural Link
              </span>
              {(knowledgeFiles.length > 0 || knowledgeLoading) && (
                <div
                  className="ml-1 hidden min-w-0 items-center gap-1.5 rounded-full border border-emerald-400/15 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-100/75 sm:flex"
                  title={recentKnowledgeFiles.map(file => file.displayName || file.name || file.id).join('\n') || knowledgeStatusText}
                >
                  {knowledgeLoading ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                  <span className="max-w-[180px] truncate">{knowledgeStatusText}</span>
                </div>
              )}
              {isSpeaking && (
                <div className="flex items-center gap-3 ml-2 md:ml-4 scale-75 md:scale-100 origin-left">
                  <div className="flex items-end gap-1 h-4">
                    {[...Array(5)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{ height: [4, 16, 4] }}
                        transition={{ 
                          duration: 0.5 + Math.random() * 0.5, 
                          repeat: Infinity,
                          ease: "easeInOut"
                        }}
                        className="w-1 bg-celestial-nebula rounded-full"
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button 
                      onClick={isPaused ? resume : pause}
                      className="h-6 px-2 text-xs bg-white/10 text-white hover:bg-white/20 rounded-full border border-white/10 flex items-center gap-1"
                    >
                      {isPaused ? <Play size={10} /> : <Pause size={10} />}
                    </Button>
                    <Button 
                      onClick={stop}
                      className="h-6 px-2 text-xs bg-red-500/20 text-red-500 hover:bg-red-500/40 rounded-full border border-red-500/20 flex items-center gap-1"
                    >
                      <Square size={10} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
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
              </div>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4 md:space-y-6 custom-scrollbar"
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
                {ui(`已折叠 ${hiddenMessageCount} 条较早消息，可用搜索查看`, `${hiddenMessageCount} older messages hidden; use search to find them`)}
              </div>
            )}
            <AnimatePresence initial={false}>
              {displayMessages.map((msg) => (
                msg.type === 'file_context' ? null /* invisible context */ : msg.type === 'tool' ? (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-start"
                  >
                    <div className={`relative max-w-[85%] p-4 rounded-2xl text-xs ${
                      msg.toolStatus === 'error'
                        ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                        : msg.toolStatus === 'done'
                          ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                        : 'bg-amber-500/5 border border-amber-500/20 text-amber-400'
                    }`}>
                      <div className="flex items-center gap-2 mb-1">
                        {msg.toolStatus === 'error' ? (
                          <XCircle size={14} />
                        ) : msg.toolStatus === 'done' ? (
                          <CheckCircle2 size={14} />
                        ) : (
                          <Loader2 size={14} className="animate-spin" />
                        )}
                        <span className="font-bold uppercase tracking-widest text-xs">{msg.toolName}</span>
                      </div>
                      {msg.toolArgs && (
                        <div className="text-xs opacity-50 truncate max-w-[200px]">
                          {JSON.stringify(msg.toolArgs).slice(0, 80)}
                        </div>
                      )}
                      {msg.toolResult && (
                        <div className="text-xs text-green-400/70 mt-1 truncate max-w-[250px]">{msg.toolResult.slice(0, 150)}</div>
                      )}
                      {msg.toolError && (
                        <>
                          <div className="text-xs text-red-400/80 mt-1 break-words">{msg.toolError}</div>
                          <div className="text-xs text-red-300/50 mt-1">{toolFailureHint}</div>
                        </>
                      )}
                    </div>
                    {renderGeneratedFiles(extractGeneratedFiles([msg.toolResult, msg.text].filter(Boolean).join('\n')), 'start')}
                  </motion.div>
                ) : (
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

                  <div className={`relative group text-sm leading-relaxed ${
                    msg.type === 'agent'
                      ? 'max-w-[92%] md:max-w-[84%] rounded-[1.5rem] rounded-tl-none border border-white/10 bg-white/[0.055] p-5 text-white/85 shadow-xl shadow-black/10 md:p-6'
                      : 'max-w-[85%] rounded-3xl rounded-tr-none border border-white/10 bg-white/5 p-5 text-white/80'
                  }`}>
                    <div className={`markdown-body chat-message-markdown ${msg.type === 'agent' ? 'chat-message-markdown-agent' : 'chat-message-markdown-user'}`}>
                      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {getDisplayText(msg)}
                      </Markdown>
                    </div>
                    {getDisplayText(msg) && (
                      <button
                        onClick={() => handleCopyMessage(getDisplayText(msg), msg.id)}
                        className={`absolute top-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg hover:bg-white/10 ${
                          msg.type === 'agent' ? 'right-2' : 'left-2'
                        }`}
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
            {isTyping && (
              <div className="flex flex-col gap-3">
                <div className="flex gap-2 items-center text-celestial-saturn/40 text-xs font-bold uppercase tracking-widest">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  >
                    <Loader2 size={14} />
                  </motion.div>
                  {t.neuralProcessing || 'Neural Processing...'}
                </div>
                <div className="flex gap-1">
                  {[...Array(3)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ 
                        scale: [1, 1.5, 1],
                        opacity: [0.3, 1, 0.3]
                      }}
                      transition={{ 
                        duration: 1, 
                        repeat: Infinity, 
                        delay: i * 0.2 
                      }}
                      className="w-1.5 h-1.5 rounded-full bg-celestial-saturn"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-white/5 border-t border-white/5">
            {recentKnowledgeFiles.length > 0 && (
              <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-2xl border border-emerald-400/12 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-50/70">
                <div className="flex shrink-0 items-center gap-2 font-semibold text-emerald-100/80">
                  <FileText size={14} />
                  <span>{ui('最近资料', 'Recent knowledge')}</span>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {recentKnowledgeFiles.map(file => (
                    <span
                      key={file.id}
                      className={`max-w-[180px] truncate rounded-full border px-2.5 py-1 ${
                        isKnowledgeReady(file)
                          ? 'border-emerald-300/15 bg-emerald-300/10 text-emerald-50/75'
                          : 'border-amber-300/16 bg-amber-300/10 text-amber-50/70'
                      }`}
                      title={file.displayName || file.name || file.id}
                    >
                      {file.displayName || file.name || file.id}
                    </span>
                  ))}
                </div>
                <span className="shrink-0 text-[10px] font-black uppercase tracking-wider text-emerald-100/45">
                  {ui('聊天/语音', 'Chat/Voice')}
                </span>
              </div>
            )}
            {pendingAttachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {pendingAttachments.map(item => (
                  <div key={item.id} className="flex max-w-full items-center gap-2 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/70">
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
                    <button
                      type="button"
                      onClick={() => removePendingAttachment(item.id)}
                      className="ml-1 rounded-full p-0.5 text-white/30 transition-colors hover:bg-white/10 hover:text-white/70"
                      title={ui('移除附件', 'Remove attachment')}
                      aria-label={ui('移除附件', 'Remove attachment')}
                    >
                      <XCircle size={13} />
                    </button>
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
            <form onSubmit={handleSendMessage} className="relative flex gap-3">
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isTyping || isOptimizing}
                variant="ghost"
                className="h-12 w-12 shrink-0 rounded-2xl border border-white/10 bg-black/30 p-0 text-white/45 transition-all hover:border-celestial-saturn/30 hover:bg-celestial-saturn/10 hover:text-celestial-saturn disabled:opacity-40"
                title={ui('添加图片或文件', 'Attach image or file')}
                aria-label={ui('添加图片或文件', 'Attach image or file')}
              >
                {isOptimizing ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
              </Button>
              <div className="relative flex-1">
                <Input
                  ref={messageInputRef}
                  defaultValue=""
                  onChange={(e) => updateDraftText(e.target.value)}
                  placeholder={t.communicatePlaceholder || "Communicate with your essence..."}
                  className="bg-black/40 border-white/10 rounded-2xl py-6 pr-12 focus-visible:ring-celestial-saturn/50"
                />
                <Button
                  type="button"
                  onClick={toggleListening}
                  variant="ghost"
                  className={`absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0 rounded-full transition-colors ${
                    isListening ? 'text-celestial-mars bg-celestial-mars/20 animate-pulse' : 'text-white/40 hover:text-white'
                  }`}
                >
                  <Mic size={18} />
                </Button>
              </div>
              {isTyping ? (
                <Button
                  type="button"
                  onClick={() => { socket?.emit('agent:abort_chat'); setIsTyping(false); }}
                  className="bg-red-500 text-white rounded-2xl px-6 hover:scale-105 transition-transform"
                >
                  <Square size={20} />
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={!hasDraftText && pendingAttachments.length === 0}
                  className="bg-celestial-saturn text-black rounded-2xl px-6 hover:scale-105 transition-transform disabled:opacity-50 disabled:hover:scale-100"
                >
                  <Send size={20} />
                </Button>
              )}
            </form>
          </div>
        </div>

        {/* Info Sidebar */}
            <motion.div
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1], delay: 0.15 }}
              className="w-96 flex-shrink-0 space-y-4 overflow-y-auto custom-scrollbar">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1], delay: 0.2 }}>
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4 border-celestial-saturn/20" hoverEffect={false}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.activeCapabilities || 'Active Capabilities'}</h4>
              {isElectron && (
                <div className="px-2 py-0.5 rounded-full bg-celestial-saturn/20 text-xs text-celestial-saturn font-black">NODE_NATIVE</div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {(agentMetadata.capabilities || [t.neuralCore || 'Neural Core', t.webMesh || 'Web Mesh']).map((cap, i) => (
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
      </div>
    </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
