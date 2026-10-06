import { ChatExecutionWatch } from '@/lib/chatExecutionWatch';
import { useConversationTransitions } from "./agent_chat/useConversationTransitions";
import { AgentChatView } from "./agent_chat/AgentChatView";
import { type GeneratedFileLink, type AgentChatVoiceSession, type ChatAttachment, type ConversationHistoryItem, type ConversationHistoryContextMenu, type WorkflowStatus, type ChatTurnUiMeta, type KnowledgeUpdateDetail, type ChatFilePanelItem, type ChatExecutionSnapshot, type ChatSendOptions } from "./agent_chat/contracts";
export { type AgentChatVoiceSession } from "./agent_chat/contracts";
import { makeChatMessageId, getDisplayText, stripStoredAttachmentSummary, buildChatHistoryPayload } from "./agent_chat/history";
export { buildChatHistoryPayload } from "./agent_chat/history";
import { extractGeneratedFiles, generatedFileKind, extractPersistedMediaArtifacts, MEDIA_GENERATION_TOOL_NAMES, isExpectedMediaGenerationTool } from "./agent_chat/media_artifacts";
import { CHAT_LIGHT_THEME, CHAT_NEUTRAL_THEME, getSelectedTextWithin } from "./agent_chat/appearance";
import { useConversationAttachments } from '../hooks/useConversationAttachments';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSongWorkbenchHandle } from './ChatSongWorkbench';
import { ChatViewWorkRegistry } from '@/lib/chatViewWork';
import { useGeneratedLibrary } from '@/hooks/useGeneratedLibrary';
import { archivedMediaArtifacts } from '@/lib/generatedLibrary';
import { listenForNativeChatFileDrop, ChatAttachmentUploads, type ChatUploadFailure, type ChatUploadKind, type ChatUploadSource } from '@/lib/chatAttachmentUploads';

import { chatAttachmentCopy } from '../i18n/locales/chatAttachments';
import { FileResourceVideo } from './FileResourceMedia';
import { saveFileResource } from '@/services/fileResource';

import { useReducedMotion } from 'motion/react';
import { Sparkles, FileText, Mic, Check, Paperclip, Image as ImageIcon, Video, ExternalLink } from 'lucide-react';
import { type ChatPreviewFile } from './ChatFilePreview';

import { chatArtifactKind, makeChatArtifact, type ChatArtifact } from '../../shared/chat_artifacts';

import { projectAgentActivity } from '@/lib/agentStatusTruth';

import { toast } from 'sonner';
import { useAppConfirm } from '@/lib/appConfirm';
import { FoundersSanctuary } from './FoundersSanctuary';
import { usePlatform } from '@/hooks/usePlatform';
import { useApp } from '@/contexts/AppContext';

import { socketService } from '@/services/socketService';
import { LUMI_VOICE_TRANSCRIPT_EVENT, useVoiceCall, type VoiceTranscriptEventDetail } from '@/hooks/useVoiceCall';
import { listVoices, VOICE_PROVIDER_CHANGED_EVENT } from '@/services/voiceService';
import { describeToolProgress, describeTurnCompletionProgress, needsVisibleToolEvidence, type ChatProgressLine, type ChatResponseFinalization, type ChatProgressTone } from '@/lib/chatProgress';
import { normalizeTaskCompletionFeedback } from './workflowTypes';

import type { FileEntry } from './MemoryTree';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { CN_FOUNDER_ALIASES } from '../i18n/regions/cn/recognition';
import { MAX_CHAT_ATTACHMENTS, isImageFileName, isAudioFileName, serializeChatAttachment, chatAttachmentIdentity, chatAttachmentRequestMatchesScope, createChatAttachmentReference, mergeChatAttachmentReferences, mergePendingChatAttachments, mapImportedChatAttachments, type ChatAttachmentRequest } from '@/lib/chatAttachmentReferences';
import { describeAgentResponseDelivery, hasInternalAgentExecutionDetail, isFinalizedSuccessfulResponse, isTerminalAgentStatus, sanitizeAgentStreamingTextForDisplay, sanitizeAgentResponseTextForDisplay, shouldDisplayAgentResponse } from '@/lib/agentResponseDelivery';
import { buildChatConversationScopeKey } from '@/lib/chatConversationScope';
import { chatExecutionStorageKey, ownedPendingChatExecutions, type ChatRecoveryOwner } from '@/lib/chatExecutionRecovery';
import { resolveChatExecutionEvent, shouldApplyInitialConversationMessages, shouldReloadPersistedConversation } from '@/lib/conversationSync';
import { ChatTerminalReceiptLedger, ChatRequestLedger, ChatTurnTimerGuard, finalizeStreamedChatMessage, takeChatStreamBucket, removePersistedPendingChatExecution, upsertPersistedPendingChatExecution, type PersistedPendingChatExecution } from '@/lib/chatEventReceipts';
import { ChatTaskRelationLedger, type ServerTaskRelationEvent } from '@/lib/chatTaskRelations';

import type { CommandCenterView } from './commandCenterTypes';

import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';

import { commandCenterPlannerCopy } from '@/i18n/locales/commandCenterPlanner';
import { mediaGenerationCopy } from '@/i18n/locales/mediaGeneration';
import { EMPTY_MEDIA_GENERATION_SOURCES, type MediaGenerationRequest, type MediaGenerationSourceChange, type MediaGenerationSourceSlot, type MediaGenerationStudioStatus } from './MediaGenerationStudio';
import { extractMediaGenerationArtifacts, mediaGenerationArgumentsMatch, mediaGenerationReceiptSettingsMatch, resolveMediaGenerationOperation, type MediaGenerationArtifact, type MediaGenerationExpectation, type MediaGenerationKind, type MediaGenerationSourceOperation } from '@/lib/mediaGenerationArtifacts';
import { normalizeStructuredMediaRequest } from '../../shared/media_generation';

const CHAT_HISTORY_LIMIT = 300;
const CHAT_RENDER_LIMIT = 80;
const CHAT_SEARCH_LIMIT = 200;

const ACTIVE_CHAT_EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;

export function AgentChatPage({
  t,
  user,
  agent,
  isOpen,
  onClose,
  prefillMessage,
  prefillSource = 'proactive',
  onPrefillConsumed,
  creationRequestId,
  onCreationRequestConsumed,
  attachmentRequest,
  onAttachmentRequestConsumed,
  layout = 'standalone',
  commandCenterView = 'office',
  onCommandCenterViewChange,
  onOpenNexus,
  onOpenMemoryAvatar,
  onOpenKnowledge,
  voiceSession,
}: {
  t: any;
  user: any;
  agent?: any;
  isOpen: boolean;
  onClose: () => void;
  prefillMessage?: string;
  prefillSource?: string;
  onPrefillConsumed?: () => void;
  creationRequestId?: string;
  onCreationRequestConsumed?: (requestId: string) => void;
  attachmentRequest?: ChatAttachmentRequest;
  onAttachmentRequestConsumed?: (requestId: string) => void;
  layout?: 'standalone' | 'command-center';
  commandCenterView?: CommandCenterView;
  onCommandCenterViewChange?: (view: CommandCenterView) => void;
  onOpenNexus?: () => void;
  /** Open the Memory Avatar surface from the command-center right rail. */
  onOpenMemoryAvatar?: () => void;
  /** Open the scoped knowledge base from the command-center right rail. */
  onOpenKnowledge?: () => void;
  /** Desktop command center reuses the shell's single microphone session. */
  voiceSession?: AgentChatVoiceSession;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [messages, setMessageState] = useState<any[]>([]);
  const messagesRef = useRef<any[]>([]);
  const messagesRevisionRef = useRef(0);
  const historyRefreshRevisionRef = useRef(0);
  const chatViewWorkRef = useRef(new ChatViewWorkRegistry());
  const chatUploadsRef = useRef(new ChatAttachmentUploads());
  const setMessages = useCallback((update: React.SetStateAction<any[]>) => {
    const next = typeof update === 'function' ? update(messagesRef.current) : update;
    messagesRevisionRef.current += 1;
    messagesRef.current = next;
    setMessageState(next);
  }, []);
  useEffect(() => () => { chatViewWorkRef.current.invalidate(); chatUploadsRef.current.reset(); for (const detach of activeChatViewDetachersRef.current.values()) detach(); activeChatViewDetachersRef.current.clear(); }, []);
  const isOfficeCommandCenter = layout === 'command-center' && commandCenterView === 'office';
  const isCommandCenterUtility = layout === 'command-center' && !isOfficeCommandCenter;
  const chatExecutionSource = layout === 'command-center' ? 'command-center-chat' : 'chat';
  const isZh = t?.langCode !== 'en';
  const attachmentUploadText = chatAttachmentCopy(isZh);
  const commandCenterPlannerText = commandCenterPlannerCopy(isZh ? 'zh' : 'en');
  const mediaGenerationText = mediaGenerationCopy(isZh ? 'zh' : 'en');
  const { platform, isElectron } = usePlatform();
  const {
    orgConnection,
    workDomain,
    operationMode,
    resolvedAppearanceMode,
    selectedVoiceId,
    setSelectedVoiceId,
    getSelectedVoiceIdForProvider,
  } = useApp();
  const isWorkChat = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const activeDomain = isWorkChat ? 'work' : 'personal';
  const appConfirm = useAppConfirm(JSON.stringify([isOpen, user?.uid, activeDomain, agent?.id]));
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
      label: 'Lumi',
      detail: 'Lumi',
      badgeClass: 'border-celestial-saturn/30 bg-celestial-saturn/12 text-celestial-saturn',
      subtleClass: 'border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn/85',
      dotClass: 'bg-celestial-saturn',
      Icon: Sparkles,
    };
  })();
  const OperationModeIcon = operationModeMeta.Icon;
  const socket = socketService.connect();
  const {
    status: runtimeStatus,
    loading: runtimeStatusLoading,
    error: runtimeStatusError,
    refresh: refreshRuntimeStatus,
  } = useRuntimeStatus({
    userId: user?.uid,
    enabled: isOpen && isOfficeCommandCenter && Boolean(user),
    scopeKey: `${activeDomain}:${activeDomain === 'work' ? activeOrgId || '' : ''}`,
  });
  const [voices, setVoices] = useState<any[]>([]);
  const [voiceProviderRevision, setVoiceProviderRevision] = useState(0);
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
  const usesSharedVoiceSession = Boolean(voiceSession);

  // Keep the callback identity stable for the lifetime of the local voice
  // session.  The voice hook owns socket listeners in an effect; passing an
  // inline callback here used to tear those listeners down and recreate them
  // on every chat-state render, leaving a small window in which an
  // `audio:response` packet could be missed.
  const handleLocalVoiceTranscript = useCallback((text: string, isFinal: boolean) => {
    if (!isFinal) return;
    if (inputDictationActiveRef.current) {
      const transcript = String(text || '').trim();
      if (transcript) {
        const current = draftTextRef.current.trim();
        const next = [current, transcript].filter(Boolean).join('\n');
        draftTextRef.current = next;
        if (messageInputRef.current) messageInputRef.current.value = next;
        setHasDraftText(next.trim().length > 0);
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
  }, [setMessages, user?.displayName, user?.username]);

  const localVoiceSession = useVoiceCall({
    socket,
    disabled: usesSharedVoiceSession,
    onTranscript: handleLocalVoiceTranscript,
  });
  const callState = voiceSession?.callState ?? localVoiceSession.callState;
  const audioLevel = voiceSession?.audioLevel ?? localVoiceSession.audioLevel;
  const callError = voiceSession?.error ?? localVoiceSession.error;
  const localCallState = localVoiceSession.callState;
  const endLocalVoiceSession = localVoiceSession.endCall;
  const switchLocalVoice = localVoiceSession.switchVoice;
  const startVoiceSession = voiceSession?.onStart
    ?? (() => {
      void localVoiceSession.startCall(
        selectedVoiceId,
        'lumi',
        agentId,
        { domain: activeDomain, orgId: activeOrgId },
      );
    });
  const endVoiceSession = voiceSession?.onEnd ?? (() => localVoiceSession.endCall());
  const lastSharedTranscriptRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (!usesSharedVoiceSession || !isOpen) return;
    const onSharedTranscript = (event: Event) => {
      const detail = (event as CustomEvent<VoiceTranscriptEventDetail>).detail;
      const text = String(detail?.text || '').trim();
      if (!detail?.isFinal || !text || inputDictationActiveRef.current) return;
      const key = text.toLocaleLowerCase();
      const now = Date.now();
      if (
        lastSharedTranscriptRef.current?.key === key
        && now - lastSharedTranscriptRef.current.at < 1500
      ) return;
      lastSharedTranscriptRef.current = { key, at: now };
      setMessages(prev => [...prev, {
        id: makeChatMessageId('voice'),
        text,
        userName: user?.displayName || user?.username || 'You',
        timestamp: new Date().toISOString(),
        type: 'user',
        source: 'voice',
      }]);
    };
    window.addEventListener(LUMI_VOICE_TRANSCRIPT_EVENT, onSharedTranscript);
    return () => window.removeEventListener(LUMI_VOICE_TRANSCRIPT_EVENT, onSharedTranscript);
  }, [isOpen, setMessages, user?.displayName, user?.username, usesSharedVoiceSession]);

  useEffect(() => {
    listVoices().then(data => {
      const all = [...data.cloned, ...data.premade];
      setVoices(all);
      const selectable = all.filter(voice => voice.status !== 'training' && voice.status !== 'failed');
      const rememberedVoiceId = data.provider ? getSelectedVoiceIdForProvider(data.provider) : undefined;
      const preferredVoice = selectable.find(voice => voice.voiceId === rememberedVoiceId)
        || selectable.find(voice => voice.voiceId === selectedVoiceId)
        || selectable[0];
      if (preferredVoice && preferredVoice.voiceId !== selectedVoiceId) {
        setSelectedVoiceId(preferredVoice.voiceId, preferredVoice.provider || data.provider || undefined);
      }
    }).catch(err => toast.error(t.failedToLoadVoices || 'Failed to load voices'));
  }, [
    activeDomain,
    activeOrgId,
    getSelectedVoiceIdForProvider,
    selectedVoiceId,
    setSelectedVoiceId,
    t.failedToLoadVoices,
    voiceProviderRevision,
  ]);

  useEffect(() => {
    switchLocalVoice(selectedVoiceId);
  }, [selectedVoiceId, switchLocalVoice]);

  useEffect(() => {
    const handleProviderChanged = () => setVoiceProviderRevision(value => value + 1);
    window.addEventListener(VOICE_PROVIDER_CHANGED_EVENT, handleProviderChanged);
    return () => window.removeEventListener(VOICE_PROVIDER_CHANGED_EVENT, handleProviderChanged);
  }, []);

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
  const mediaStudioOpenRef = useRef(false);
  const draftTextRef = useRef('');
  const [hasDraftText, setHasDraftText] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [attachmentUploadFailures, setAttachmentUploadFailures] = useState<ChatUploadFailure[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [optimizationProgress, setOptimizationProgress] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      if (!mediaStudioOpenRef.current) messageInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let focusFrame: number | null = null;
    const focusCommandInput = () => {
      if (mediaStudioOpenRef.current) return;
      messageInputRef.current?.focus({ preventScroll: true });
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        focusFrame = null;
        messageInputRef.current?.focus({ preventScroll: true });
      });
    };
    const restoreVisibleCommandInput = () => {
      if (document.visibilityState === 'visible') focusCommandInput();
    };
    window.addEventListener('lumi:focus-command-input', focusCommandInput);
    window.addEventListener('focus', focusCommandInput);
    document.addEventListener('visibilitychange', restoreVisibleCommandInput);
    return () => {
      window.removeEventListener('lumi:focus-command-input', focusCommandInput);
      window.removeEventListener('focus', focusCommandInput);
      document.removeEventListener('visibilitychange', restoreVisibleCommandInput);
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    };
  }, [isOpen]);
  const [previewFile, setPreviewFile] = useState<ChatPreviewFile | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const nativeDropHandledAtRef = useRef(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  // Reserve the transcript synchronously: React state alone leaves a same-tick
  // send/new/history shortcut able to submit against the previous conversation.
  const conversationTransitionRef = useRef<symbol | null>(null);
  const [conversationTransitionPending, setConversationTransitionPending] = useState(false);
  const [conversationHistoryOpen, setConversationHistoryOpen] = useState(true);
  // The history rail stays mounted at the left edge, but its selector deck
  // retracts until the user points at it or tabs into it.
  const [conversationHistorySelectorExpanded, setConversationHistorySelectorExpanded] = useState(false);
  const [commandCenterPlannerOpen, setCommandCenterPlannerOpen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryItem[]>([]);
  const [conversationHistoryLoading, setConversationHistoryLoading] = useState(false);
  const [conversationHistoryLoadingMore, setConversationHistoryLoadingMore] = useState(false);
  const [conversationHistoryHasMore, setConversationHistoryHasMore] = useState(true);
  const [restoringConversationId, setRestoringConversationId] = useState('');
  const [deletingConversationId, setDeletingConversationId] = useState('');
  const [conversationContextMenu, setConversationContextMenu] = useState<ConversationHistoryContextMenu | null>(null);
  const [mediaStudioMode, setMediaStudioMode] = useState<MediaGenerationKind | null>(null);
  const [chatSongOpen, setChatSongOpen] = useState(false);
  const chatSongWorkbenchRef = useRef<ChatSongWorkbenchHandle>(null);
  const [{ status: mediaGenerationStatus, detail: mediaGenerationDetail }, setMediaGeneration] =
    useState<{ status: MediaGenerationStudioStatus; detail: string }>({ status: 'idle', detail: '' });
  const [mediaGenerationArtifacts, setMediaGenerationArtifacts] = useState<MediaGenerationArtifact[]>([]);
  const [mediaGenerationRetryRequest, setMediaGenerationRetryRequest] = useState<MediaGenerationRequest | null>(null);
  const [mediaSourceArtifacts, setMediaSourceArtifacts] = useState<MediaGenerationArtifact[]>([]);
  const [mediaSources, setMediaSources] = useState(EMPTY_MEDIA_GENERATION_SOURCES);
  const [mediaSourceUploading, setMediaSourceUploading] = useState(false);
  const mediaSourceFileInputRef = useRef<HTMLInputElement>(null);
  const mediaSourceUploadTargetRef = useRef<{
    operation: MediaGenerationSourceOperation;
    slot: MediaGenerationSourceSlot;
  } | null>(null);
  const activeMediaGenerationRef = useRef<{
    requestId: string;
    mode: MediaGenerationKind;
    request: MediaGenerationExpectation;
  } | null>(null);
  const mediaGenerationArtifactsRef = useRef<MediaGenerationArtifact[]>([]);
  const mediaGenerationArtifactValidationRef = useRef<{
    expectedIds: Set<string>;
    readyIds: Set<string>;
    failedIds: Set<string>;
    requiredCount: number;
    contractValid: boolean;
    finalized: boolean;
    terminalSucceeded: boolean;
    terminalBlocked: boolean;
  } | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('idle');
  const [chatProgressLines, setChatProgressLines] = useState<ChatProgressLine[]>([]);
  const recognition = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentNameRef = useRef<string>('Lumi');
  const seenWorkflowToolEvents = useRef<Set<string>>(new Set());
  const lastChatProgressTextRef = useRef('');
  const chatProgressClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The foreground view points to the request's metadata instead of copying its fields.
  const currentTurnUiMetaRef = useRef<ChatTurnUiMeta>({ hadTool: false, needsEvidence: false, finalization: null });
  const activeChatViewDetachersRef = useRef(new Map<string, () => void>());
  const terminalReceiptsRef = useRef(new ChatTerminalReceiptLedger());
  const chatRequestLedgerRef = useRef(new ChatRequestLedger());
  const taskRelationLedgerRef = useRef(new ChatTaskRelationLedger());
  const chatTurnTimerGuardRef = useRef(new ChatTurnTimerGuard());
  const chatTurnUiMetaRef = useRef(new Map<string, ChatTurnUiMeta>());
  const conversationHistoryListRef = useRef<HTMLDivElement>(null);
  const conversationHistoryOffsetRef = useRef(0);
  const conversationHistoryHasMoreRef = useRef(true);
  const conversationHistoryLoadingRef = useRef(false);
  const conversationHistoryRequestRef = useRef(0);

  const resetMediaGenerationSurface = useCallback(() => {
    mediaStudioOpenRef.current = false;
    activeMediaGenerationRef.current = null;
    mediaGenerationArtifactsRef.current = [];
    mediaGenerationArtifactValidationRef.current = null;
    setMediaStudioMode(null);
    setMediaGenerationArtifacts([]);
    setMediaGeneration({ status: 'idle', detail: '' });
    setMediaGenerationRetryRequest(null);
    setMediaSourceArtifacts([]);
    setMediaSources(EMPTY_MEDIA_GENERATION_SOURCES);
    setMediaSourceUploading(false);
    mediaSourceUploadTargetRef.current = null;
  }, []);

  useEffect(() => {
    if (!isOpen || !isOfficeCommandCenter) {
      resetMediaGenerationSurface();
    }
  }, [isOfficeCommandCenter, isOpen, resetMediaGenerationSurface]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    if (inputDictationActiveRef.current && localCallState === 'idle') {
      inputDictationActiveRef.current = false;
      endLocalVoiceSession();
      setIsListening(false);
    }
  }, [endLocalVoiceSession, localCallState]);

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

  const scheduleWorkflowReset = useCallback((requestId?: string) => {
    chatTurnTimerGuardRef.current.schedule(String(requestId || ''), 5000, () => {
      setWorkflowStatus('idle');
      seenWorkflowToolEvents.current.clear();
    });
  }, []);

  useEffect(() => () => {
    if (chatProgressClearTimerRef.current) clearTimeout(chatProgressClearTimerRef.current);
    chatTurnTimerGuardRef.current.dispose();
  }, []);

  const updateDraftText = useCallback((value: string) => {
    draftTextRef.current = value;
    const nextHasDraft = value.trim().length > 0;
    setHasDraftText(prev => prev === nextHasDraft ? prev : nextHasDraft);
  }, []);

  const setDraftText = useCallback((value: string) => {
    updateDraftText(value);
    if (messageInputRef.current) messageInputRef.current.value = value;
  }, [updateDraftText]);

  useEffect(() => {
    if (!isOpen) return;
    const pasteIntoCommandInput = (event: ClipboardEvent) => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text || !messageInputRef.current) return;
      event.preventDefault();
      setDraftText(`${messageInputRef.current.value || ''}${text}`);
      messageInputRef.current.focus();
    };
    window.addEventListener('paste', pasteIntoCommandInput);
    return () => window.removeEventListener('paste', pasteIntoCommandInput);
  }, [isOpen, setDraftText]);

  useEffect(() => {
    if (!isOpen) return;
    const replaceCommandInput = (event: Event) => {
      const text = String((event as CustomEvent<{ text?: string }>).detail?.text || '');
      if (!text) return;
      setDraftText(text);
      messageInputRef.current?.focus();
    };
    window.addEventListener('lumi:replace-command-input', replaceCommandInput);
    return () => window.removeEventListener('lumi:replace-command-input', replaceCommandInput);
  }, [isOpen, setDraftText]);

  // Escape to close panels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showVoicePicker) setShowVoicePicker(false);
        if (showWeChatSettings) setShowWeChatSettings(false);
        if (showAttachmentMenu) setShowAttachmentMenu(false);
        if (conversationHistoryOpen) setConversationHistoryOpen(false);
        if (conversationContextMenu) setConversationContextMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversationContextMenu, conversationHistoryOpen, showAttachmentMenu, showVoicePicker, showWeChatSettings]);

  const agentName = agent?.name || (t.lumiEssence || 'Lumi Essence');
  const agentCategory = agent?.category || (t.friend || 'friend');
  const agentId = agent?.id || 'lumi';
  const attachmentContextStoragePrefix = `lumi_chat_attachment_context:${user?.id || user?.username || 'anonymous'}:${buildChatConversationScopeKey(agentId, activeDomain, activeOrgId)}`;
  const invalidateChatViewWork = useCallback(() => {
    chatViewWorkRef.current.invalidate();
    chatUploadsRef.current.reset();
    setAttachmentUploadFailures([]);
    setIsOptimizing(false);
    setOptimizationProgress(0);
    setMediaSourceUploading(false);
    mediaSourceUploadTargetRef.current = null;
  }, []);
  const resetAttachmentConversationView = useCallback(() => {
    invalidateChatViewWork();
    setPreviewFile(null);
  }, [invalidateChatViewWork]);
  const { conversationAttachments, conversationAttachmentsRef, attachmentConversationIdRef,
    bindAttachmentContextToConversation, rememberConversationAttachments, clearConversationAttachments: clearStoredAttachments,
  } = useConversationAttachments(attachmentContextStoragePrefix, resetAttachmentConversationView);
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
  const { files: knowledgeFiles, loading: knowledgeLoading, failed: knowledgeFailed, refresh: refreshKnowledgeFiles } = useGeneratedLibrary(
    JSON.stringify([user?.uid, activeDomain, activeOrgId]), scopedFileUrl,
  );
  const libraryMediaArtifacts = useMemo(() => archivedMediaArtifacts(knowledgeFiles, scopedFileUrl), [knowledgeFiles, scopedFileUrl]);
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
    if (file.archiveId) return true;
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
      collected.push(...(message.fileArtifacts || []), ...extractGeneratedFiles(text, message.conversationId));
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
  const availableMediaSourceArtifacts = useMemo(() => {
    const collected = [
      ...mediaSourceArtifacts,
      ...mediaGenerationArtifacts,
      ...messages.flatMap(message => Array.isArray(message?.mediaArtifacts) ? message.mediaArtifacts : []),
      ...libraryMediaArtifacts,
    ].filter((artifact): artifact is MediaGenerationArtifact => artifact?.kind === 'image' && Boolean(artifact.url));
    const seen = new Set<string>();
    return collected.filter(artifact => {
      const key = `${artifact.path || ''}\u001f${artifact.url}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(-24).reverse();
  }, [libraryMediaArtifacts, mediaGenerationArtifacts, mediaSourceArtifacts, messages]);

  const openNativeFilePath = useCallback(async (target?: string | null): Promise<boolean> => {
    if (platform !== 'tauri' || !target) return false;
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ success: boolean; output: string }>('open_item', { target });
    if (!result?.success) throw new Error(result?.output || 'Open file failed');
    return true;
  }, [platform]);

  const openChatFileInSystem = useCallback(async (file: Pick<ChatFilePanelItem, 'fileName' | 'fileId' | 'path' | 'openUrl' | 'saveUrl'>) => {
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
        await saveFileResource(fallbackUrl, file.fileName);
      } catch (err: any) {
        toast.error(err?.message || uiMessage('agent-chat-page.could-not-open-preview-link.99248ef9e6'));
      }
    }
  }, [openNativeFilePath, scopedFileUrl]);

  const openChatFile = useCallback(async (file: Pick<ChatFilePanelItem, 'fileName' | 'fileId' | 'path' | 'openUrl' | 'saveUrl'>) => {
    const url = file.openUrl || file.saveUrl || (file.fileId
      ? scopedFileUrl(`/api/files/download/${encodeURIComponent(file.fileId)}?inline=1`)
      : file.path ? makeChatArtifact(file.path, attachmentConversationIdRef.current).url : '');
    if (url) setPreviewFile({ fileName: file.fileName, path: file.path, url });
  }, [attachmentConversationIdRef, scopedFileUrl]);

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

    const archived: ChatFilePanelItem[] = knowledgeFiles.filter(file => file.archiveId).map(file => ({
      id: `archived-${file.archiveId}`, fileId: file.id, fileName: file.displayName || file.name,
      subtitle: uiMessage('agent-chat-page.generated-by-lumi.27ac470b2c'),
      kind: chatArtifactKind(file.name), source: 'generated', path: file.path, size: file.rawSize,
      openUrl: scopedFileUrl(`/api/files/download/${encodeURIComponent(file.id)}?inline=1`),
      saveUrl: scopedFileUrl(`/api/files/download/${encodeURIComponent(file.id)}`),
    }));
    const generated: ChatFilePanelItem[] = [...archived, ...generatedChatFiles.filter(file => !archived.some(item => item.fileName === file.fileName)).map(file => ({
      id: `generated-panel-${file.id}`,
      fileName: file.fileName,
      subtitle: uiMessage('agent-chat-page.generated-by-lumi.27ac470b2c'),
      kind: file.kind,
      source: 'generated' as const,
      path: file.path,
      openUrl: file.url,
      saveUrl: file.url,
    }))].slice(0, 12);

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
    return () => {
      window.removeEventListener('lumi:knowledge-updated', onKnowledgeUpdated);
    };
  }, [activeDomain, activeOrgId, isFounder, isOpen, refreshKnowledgeFiles]);

  useEffect(() => {
    if (!socket || !isOpen || isFounder) return;
    socket.on('memories:changed', refreshKnowledgeFiles);
    socket.on('chat:conversation_updated', refreshKnowledgeFiles);
    return () => {
      socket.off('memories:changed', refreshKnowledgeFiles);
      socket.off('chat:conversation_updated', refreshKnowledgeFiles);
    };
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
      if (kind === 'video') return mediaGenerationText.video;
      if (kind === 'document') return uiMessage('agent-chat-page.document.c4e0476ce2');
      return uiMessage('agent-chat-page.file.9588151a85');
    };

    return (
      <div className={`max-w-[92%] mb-3 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {files.map(file => (
          <div
            key={file.id}
            className={`group flex min-w-0 max-w-[360px] gap-2 overflow-hidden rounded-2xl border border-emerald-400/15 bg-emerald-400/10 text-left transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15 ${
              file.kind === 'video' ? 'w-full flex-col p-2' : 'items-center px-3 py-2.5'
            }`}
            title={file.path}
          >
            {file.kind === 'video' && (
              <FileResourceVideo
                src={file.url}
                controls
                preload="metadata"
                className="aspect-video w-full rounded-xl bg-black/45 object-contain"
              />
            )}
            <button
              type="button"
              onClick={() => openChatFile({ fileName: file.fileName, path: file.path, openUrl: file.url, saveUrl: file.url })}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-200">
              {file.kind === 'image' ? <ImageIcon size={17} /> : file.kind === 'video' ? <Video size={17} /> : <FileText size={17} />}
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
  }, [mediaGenerationText, openChatFile]);

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
      if ((!message.text || !String(message.text).trim()) && !message.mediaArtifacts?.length && !message.fileArtifacts?.length) return;
      normalized.push(message);
    };

    rawMessages.forEach((m: any, index: number) => {
      const baseId = m.id || `persisted-${index}`;
      const timestamp = m.timestamp || m.createdAt || new Date().toISOString();
      const role = m.role || '';
      const userText = role === 'assistant' ? '' : stripStoredAttachmentSummary(m.content || m.message || '');
      const storedAssistantText = role === 'assistant'
        ? (m.content || m.message || m.response || '')
        : (m.response || '');
      const legacyExecutionReport = Boolean(
        storedAssistantText && hasInternalAgentExecutionDetail(storedAssistantText),
      );
      const assistantText = sanitizeAgentResponseTextForDisplay(
        storedAssistantText,
        isZh ? 'zh' : 'en',
      );

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

      const mediaArtifacts = extractPersistedMediaArtifacts(m);
      if (assistantText || mediaArtifacts.length || m.fileArtifacts?.length) {
        const completionFeedback = normalizeTaskCompletionFeedback(m.completionFeedback);
        pushMessage({
          id: `${baseId}-assistant`,
          text: assistantText,
          userName: agentDisplayName,
          timestamp,
          type: 'agent',
          mode: m.mode,
          ...(legacyExecutionReport ? { legacyExecutionReport: true } : {}),
          ...(completionFeedback ? { completionFeedback } : {}),
          ...(mediaArtifacts.length ? { mediaArtifacts } : {}),
          fileArtifacts: m.fileArtifacts || [],
          conversationId: m.conversationId,
        });
      }
    });

    const seen = new Set<string>();
    return normalized.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [isZh, user?.displayName, user?.username, t.chatUserFallback]);

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

  const streamingMsgIdsRef = useRef(new Map<string, string>());
  const streamingRawTextRef = useRef(new Map<string, string>());
  const lastResumedRequestIdsRef = useRef(new Set<string>());
  const initialLoadDoneRef = useRef(false);
  const lastConversationScopeRef = useRef<string>('');
  const chatRecoveryUserId = String(user?.uid || '').trim();
  const recoveryOwner = useMemo<ChatRecoveryOwner>(() => ({
    userId: chatRecoveryUserId, agentId, domain: activeDomain, orgId: activeOrgId, source: chatExecutionSource,
  }), [chatRecoveryUserId, agentId, activeDomain, activeOrgId, chatExecutionSource]);
  const activeExecutionStorageKey = chatExecutionStorageKey(recoveryOwner);
  const persistActiveExecution = useCallback((requestId: string) => {
    if (!activeExecutionStorageKey) return;
    try {
      const execution: PersistedPendingChatExecution = {
        userId: chatRecoveryUserId,
        requestId,
        source: chatExecutionSource,
        domain: activeDomain,
        orgId: activeOrgId || undefined,
        conversationId: attachmentConversationIdRef.current || undefined,
        startedAt: new Date().toISOString(),
        ...(activeMediaGenerationRef.current?.requestId === requestId
          ? { mediaGeneration: { ...activeMediaGenerationRef.current.request } }
          : {}),
      };
      const current = { version: 2, pending: ownedPendingChatExecutions(
        JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null'), recoveryOwner,
      ) };
      localStorage.setItem(
        activeExecutionStorageKey,
        JSON.stringify(upsertPersistedPendingChatExecution(current, execution)),
      );
    } catch {}
  }, [attachmentConversationIdRef, activeDomain, activeExecutionStorageKey, activeOrgId, chatExecutionSource, chatRecoveryUserId, recoveryOwner]);
  const clearPersistedExecution = useCallback((requestId?: string) => {
    if (!activeExecutionStorageKey) return;
    try {
      if (!requestId) return localStorage.removeItem(activeExecutionStorageKey);
      const current = JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null');
      const next = removePersistedPendingChatExecution(current, requestId);
      if (next.pending.length > 0) localStorage.setItem(activeExecutionStorageKey, JSON.stringify(next));
      else localStorage.removeItem(activeExecutionStorageKey);
    } catch {}
  }, [activeExecutionStorageKey]);
  const detachPreviousExecution = useCallback((clearStored = true, clearReceipts = false) => {
    for (const detach of activeChatViewDetachersRef.current.values()) detach();
    activeChatViewDetachersRef.current.clear();
    if (clearStored) clearPersistedExecution();
    if (clearReceipts) terminalReceiptsRef.current.clear();
    chatRequestLedgerRef.current.clear();
    chatTurnUiMetaRef.current.clear();
    lastResumedRequestIdsRef.current.clear();
    streamingMsgIdsRef.current.clear();
    streamingRawTextRef.current.clear();
    chatTurnTimerGuardRef.current.invalidate();
    currentTurnUiMetaRef.current = { hadTool: false, needsEvidence: false, finalization: null };
    resetMediaGenerationSurface();
    setIsTyping(false);
    setWorkflowStatus('idle');
    clearChatProgress();
    seenWorkflowToolEvents.current.clear();
  }, [clearPersistedExecution, clearChatProgress, resetMediaGenerationSurface]);

  const dropRequestStream = useCallback((requestId?: string) => {
    const id = takeChatStreamBucket(streamingMsgIdsRef.current, streamingRawTextRef.current, requestId);
    if (id) setMessages(prev => prev.filter(message => message.id !== id));
  }, [setMessages]);
  const resumeForegroundRequest = useCallback((requestId: string) => {
    const nextMeta = chatTurnUiMetaRef.current.get(requestId);
    currentTurnUiMetaRef.current = nextMeta || { hadTool: false, needsEvidence: false, finalization: null };
    setWorkflowStatus('thinking');
  }, []);


  const settleTrackedChatRequest = useCallback((requestId?: string) => {
    const normalizedRequestId = String(requestId || '').trim();
    activeChatViewDetachersRef.current.get(normalizedRequestId)?.();
    activeChatViewDetachersRef.current.delete(normalizedRequestId);
    const previousForeground = chatRequestLedgerRef.current.foreground;
    chatTurnUiMetaRef.current.delete(normalizedRequestId);
    const result = chatRequestLedgerRef.current.settle(normalizedRequestId);
    clearPersistedExecution(normalizedRequestId || undefined);
    if (result.foregroundRequestId && result.foregroundRequestId !== previousForeground) {
      chatTurnTimerGuardRef.current.begin(result.foregroundRequestId);
      resumeForegroundRequest(result.foregroundRequestId);
    }
    return result;
  }, [clearPersistedExecution, resumeForegroundRequest]);
  const acceptChatExecutionEvent = useCallback((
    data?: { requestId?: string; source?: string; conversationId?: string },
    expectedRequestId?: string | null,
  ) => {
    const eventRequestId = String(data?.requestId || '').trim();
    const resolvedExpectedRequestId = expectedRequestId !== undefined
      ? expectedRequestId
      : eventRequestId && chatRequestLedgerRef.current.has(eventRequestId)
        ? eventRequestId
        : chatRequestLedgerRef.current.foreground;
    const resolution = resolveChatExecutionEvent({
      event: data,
      currentConversationId: attachmentConversationIdRef.current,
      expectedRequestId: resolvedExpectedRequestId,
      expectedSource: chatExecutionSource,
      textChatActive: chatRequestLedgerRef.current.size > 0,
    });
    if (!resolution.accepted) return false;
    if (resolution.adoptedConversationId) {
      bindAttachmentContextToConversation(resolution.adoptedConversationId, { carryCurrent: true });
      if (resolvedExpectedRequestId && chatRequestLedgerRef.current.has(resolvedExpectedRequestId)) {
        persistActiveExecution(resolvedExpectedRequestId);
      }
    }
    return true;
  }, [attachmentConversationIdRef, bindAttachmentContextToConversation, chatExecutionSource, persistActiveExecution]);

  useEffect(() => {
    if (!agentId) return;

    // On user/agent/domain switch, reset and reload
    const conversationScopeKey = `${user?.uid || user?.id || user?.username || 'anonymous'}:${buildChatConversationScopeKey(agentId, activeDomain, activeOrgId)}`;
    if (conversationScopeKey !== lastConversationScopeRef.current) {
      invalidateChatViewWork();
      setIsCreatingConversation(false);
      setRestoringConversationId('');
      lastConversationScopeRef.current = conversationScopeKey;
      initialLoadDoneRef.current = false;
      detachPreviousExecution(false, true);
      try {
        // Remove the pre-fix scope-only key, which could contain plaintext and
        // could incorrectly survive into a different conversation.
        localStorage.removeItem(attachmentContextStoragePrefix);
      } catch {}
      setMessages([]);
      setPendingAttachments([]);
      pendingAttachmentsRef.current = [];
      bindAttachmentContextToConversation('');
    }

    // Only load once; do not overwrite live conversation.
    if (isFounder || initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;

    const initialConversationId = attachmentConversationIdRef.current;
    const initialMessageCount = messagesRef.current.length;
    const transition = Symbol('initial-conversation');
    conversationTransitionRef.current = transition;
    setConversationTransitionPending(true);
    let cancelled = false;

    // Load the single active conversation messages. The request may resolve
    // after the user has already started a live turn or switched transcripts;
    // in that case the persisted snapshot must not replace the visible chat.
    void (async () => {
      try {
        const activeResponse = await fetch(scopedConversationUrl('/api/conversations/active'));
        const data = await activeResponse.json();
        const conversationId = String(data.activeConversation?.id || '').trim();
        if (!conversationId) return;
        if (
          cancelled
          || lastConversationScopeRef.current !== conversationScopeKey
          || chatRequestLedgerRef.current.size > 0
          || attachmentConversationIdRef.current !== initialConversationId
          || messagesRef.current.length !== initialMessageCount
        ) return;

        bindAttachmentContextToConversation(conversationId);
        const msgRes = await fetch(scopedConversationUrl(`/api/conversations/${conversationId}/messages?limit=${CHAT_HISTORY_LIMIT}`));
        const msgData = await msgRes.json();
        if (!Array.isArray(msgData.messages)) return;
        if (!shouldApplyInitialConversationMessages({
          cancelled,
          expectedScopeKey: conversationScopeKey,
          currentScopeKey: lastConversationScopeRef.current,
          loadedConversationId: conversationId,
          currentConversationId: attachmentConversationIdRef.current,
          activeRequestId: chatRequestLedgerRef.current.foreground,
          textChatActive: chatRequestLedgerRef.current.size > 0,
          messageCountAtStart: initialMessageCount,
          currentMessageCount: messagesRef.current.length,
        })) return;
        const persistedMessages = normalizePersistedMessages(msgData.messages);
        setMessages(persistedMessages);
      } catch {} finally {
        if (conversationTransitionRef.current === transition) {
          conversationTransitionRef.current = null;
          setConversationTransitionPending(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (conversationTransitionRef.current === transition) {
        conversationTransitionRef.current = null;
        setConversationTransitionPending(false);
      }
    };
  }, [attachmentConversationIdRef, activeDomain, activeOrgId, agentId, attachmentContextStoragePrefix, bindAttachmentContextToConversation, invalidateChatViewWork, isFounder, normalizePersistedMessages, detachPreviousExecution, scopedConversationUrl, setMessages, user?.uid, user?.id, user?.username]);

  useEffect(() => {
    if (isFounder || !socket) return;

    const isCurrentChatEvent = (data?: { requestId?: string; source?: string; conversationId?: string }) => (
      acceptChatExecutionEvent(data)
    );

    const recordTaskRelation = (data?: ServerTaskRelationEvent) => {
      if (!data) return;
      taskRelationLedgerRef.current.record(data);
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
      const publicMessage = sanitizeAgentResponseTextForDisplay(data.message, isZh ? 'zh' : 'en');
      if (!publicMessage) return;
      setMessages(prev => {
        if (prev.some(m => m.text === publicMessage && m.type === 'agent')) return prev;
        return [...prev, {
          id: `proactive-${Date.now()}`,
          text: publicMessage,
          userName: agentName,
          timestamp: data.timestamp || new Date().toISOString(),
          type: 'agent',
          source: 'proactive',
        }];
      });
    };

    const onChunk = (data: { text: string; agentName: string; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const streamKey = String(data.requestId || '__legacy__');
      const rawText = `${streamingRawTextRef.current.get(streamKey) || ''}${data.text}`;
      streamingRawTextRef.current.set(streamKey, rawText);
      const publicText = sanitizeAgentStreamingTextForDisplay(rawText, isZh ? 'zh' : 'en');
      if (!publicText) return;
      const currentStreamId = streamingMsgIdsRef.current.get(streamKey);
      if (currentStreamId) {
        const sid = currentStreamId;
        setMessages(prev => prev.map(m =>
          m.id === sid ? { ...m, text: publicText } : m
        ));
      } else {
        const id = makeChatMessageId('stream');
        streamingMsgIdsRef.current.set(streamKey, id);
        setMessages(prev => [...prev, {
          id,
          text: publicText,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent'
        }]);
      }
    };

    const receiveMediaArtifacts = (
      receipt: unknown,
      active: NonNullable<typeof activeMediaGenerationRef.current>,
      merge = true,
    ): boolean => {
      const incoming = extractMediaGenerationArtifacts(receipt, active.mode)
        .filter(artifact => artifact.kind === active.mode)
        .map(artifact => ({ ...artifact, requestId: active.requestId, operation: resolveMediaGenerationOperation(active.request) }));
      if (!incoming.length) return false;
      const artifacts = merge ? [...mediaGenerationArtifactsRef.current, ...incoming].filter((artifact, index, all) => (
        all.findIndex(candidate => candidate.kind === artifact.kind && candidate.url === artifact.url) === index
      )) : incoming;
      const prior = merge ? mediaGenerationArtifactValidationRef.current : null;
      const expectedIds = new Set(artifacts.map(artifact => artifact.id));
      const requiredCount = active.mode === 'image' ? Math.max(1, Number(active.request.count) || 1) : 1;
      const contractValid = artifacts.length >= requiredCount;
      mediaGenerationArtifactValidationRef.current = {
        expectedIds,
        readyIds: new Set([...(prior?.readyIds || [])].filter(id => expectedIds.has(id))),
        failedIds: new Set([...(prior?.failedIds || [])].filter(id => expectedIds.has(id))),
        requiredCount,
        contractValid,
        finalized: prior?.finalized || false,
        terminalSucceeded: prior?.terminalSucceeded || false,
        terminalBlocked: prior?.terminalBlocked || false,
      };
      mediaGenerationArtifactsRef.current = artifacts;
      setMediaGenerationArtifacts(artifacts);
      setMediaGeneration({ status: contractValid ? 'generating' : 'error', detail: contractValid ? mediaGenerationText.validatingArtifact : mediaGenerationText.artifactCountMismatch });
      return true;
    };

    const onTool = (data: { correlationId?: string; name: string; args?: any; arguments?: any; result?: string; artifactReceipt?: unknown; error?: string; publicText?: string; requestId?: string; source?: string; conversationId?: string; taskRelation?: unknown }) => {
      if (!isCurrentChatEvent(data)) return;
      recordTaskRelation(data);
      const requestId = String(data.requestId || '').trim();
      const args = data.arguments ?? data.args;
      const phase = data.error !== undefined
        ? 'error'
        : data.artifactReceipt !== undefined || data.result !== undefined
          ? 'result'
          : 'start';
      const eventRequestKey = requestId || '__legacy__';
      const workflowEventKey = data.correlationId
        ? `${eventRequestKey}:${data.correlationId}:${phase}`
        : `${eventRequestKey}:${data.name}:${phase}:${String(data.result ?? data.error ?? '').slice(0, 120)}`;
      if (seenWorkflowToolEvents.current.has(workflowEventKey)) return;
      seenWorkflowToolEvents.current.add(workflowEventKey);

      const activeMediaGeneration = activeMediaGenerationRef.current;
      const mediaToolBelongsToActiveRequest = activeMediaGeneration?.requestId === requestId
        && MEDIA_GENERATION_TOOL_NAMES.has(data.name);
      if (
        mediaToolBelongsToActiveRequest
        && activeMediaGeneration
        && !isExpectedMediaGenerationTool(activeMediaGeneration.request, data.name)
      ) {
        mediaGenerationArtifactValidationRef.current = null;
        setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
      }
      if (
        mediaToolBelongsToActiveRequest
        && activeMediaGeneration
        && isExpectedMediaGenerationTool(activeMediaGeneration.request, data.name)
      ) {
        if (data.error !== undefined) {
          mediaGenerationArtifactValidationRef.current = null;
          setMediaGeneration({ status: 'error', detail: mediaGenerationText.toolFailed });
        } else if (data.artifactReceipt !== undefined || data.result !== undefined) {
          if (!mediaGenerationArgumentsMatch(activeMediaGeneration.request, args)) {
            mediaGenerationArtifactValidationRef.current = null;
            setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
          } else if (!receiveMediaArtifacts(data.artifactReceipt ?? data.result, activeMediaGeneration)) {
            mediaGenerationArtifactValidationRef.current = null;
            setMediaGeneration({ status: 'generating', detail: mediaGenerationText.toolReturnedNoArtifact });
          }
        } else {
          setMediaGeneration({ status: 'generating', detail: '' });
        }
      }

      const turnMeta = chatTurnUiMetaRef.current.get(requestId);
      if (turnMeta) turnMeta.hadTool = true;
      if (!requestId || chatRequestLedgerRef.current.foreground === requestId) {
        currentTurnUiMetaRef.current.hadTool = true;
      }
      if (requestId && chatRequestLedgerRef.current.foreground !== requestId) return;
      setWorkflowStatus('executing');
      const customerToolText = sanitizeAgentResponseTextForDisplay(
        data.publicText || describeToolProgress(data.name, phase, isZh),
        isZh ? 'zh' : 'en',
      );
      pushChatProgress(customerToolText, phase === 'error' ? 'error' : 'tool');
    };

    const onProgress = (data: { text?: string; publicText?: string; tone?: ChatProgressTone; requestId?: string; source?: string; conversationId?: string }) => {
      if (!isCurrentChatEvent(data)) return;
      const requestId = String(data.requestId || '').trim();
      if (!requestId || chatRequestLedgerRef.current.foreground === requestId) {
        pushChatProgress(sanitizeAgentResponseTextForDisplay(data.publicText || data.text || '', isZh ? 'zh' : 'en'), data.tone || 'tool');
      }
      if (activeMediaGenerationRef.current?.requestId === requestId && data.text?.trim()) {
        setMediaGeneration({ status: 'generating', detail: data.text.trim() });
      }
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
      sidecar?: boolean;
      taskRelation?: unknown;
      completionFeedback?: unknown;
      artifactReceipt?: unknown;
      fileArtifacts?: ChatArtifact[];
    }) => {
      if (!isCurrentChatEvent(data)) return;
      recordTaskRelation(data);
      if (!terminalReceiptsRef.current.claim(data)) return;
      const requestId = String(data.requestId || '').trim();
      const turnMeta = chatTurnUiMetaRef.current.get(requestId);
      const streamId = takeChatStreamBucket(streamingMsgIdsRef.current, streamingRawTextRef.current, requestId);
      const tracked = settleTrackedChatRequest(requestId);
      const hasRemainingRequests = tracked.remaining > 0;
      const completionFeedback = normalizeTaskCompletionFeedback(data.completionFeedback);
      const responseTerminalReason = String(data.reason || '').trim().toLowerCase();
      const responseWasCancelled = responseTerminalReason === 'cancelled' || responseTerminalReason === 'canceled';
      const responseReceipt = data.artifactReceipt && typeof data.artifactReceipt === 'object'
        ? data.artifactReceipt as Record<string, any>
        : null;
      const responseOperation: MediaGenerationArtifact['operation'] = responseReceipt?.toolName === 'ai_edit_image'
        ? 'image_edit'
        : responseReceipt?.toolName === 'generate_video'
          ? (responseReceipt?.settings?.hasReference ? 'image_to_video' : 'text_to_video')
          : responseReceipt?.toolName === 'generate_image'
            ? 'text_to_image'
            : undefined;
      const responseMediaArtifacts = extractMediaGenerationArtifacts(data.artifactReceipt).map(artifact => ({
        ...artifact,
        requestId,
        ...(responseOperation ? { operation: responseOperation } : {}),
      }));
      const responseFileArtifacts = Array.isArray(data.fileArtifacts) ? data.fileArtifacts : [];
      setIsTyping(hasRemainingRequests);

      const mediaReceiptDisplayable = (responseMediaArtifacts.length > 0 || responseFileArtifacts.length > 0) && isFinalizedSuccessfulResponse(data);
      const displayable = shouldDisplayAgentResponse(data) || mediaReceiptDisplayable;
      const deliveredText = sanitizeAgentResponseTextForDisplay(
        data.text?.trim() || (mediaReceiptDisplayable ? mediaGenerationText.mediaCompleted : ''),
        isZh ? 'zh' : 'en',
      );
      if (streamId) {
        if (displayable && deliveredText) {
          // Capture the id before deleting its request bucket. React may run
          // this updater after the handler returns.
          setMessages(prev => finalizeStreamedChatMessage(prev, streamId, deliveredText).map(message => (
            message.id === streamId
              ? {
                  ...message,
                  ...(completionFeedback ? { completionFeedback } : {}),
                  ...(responseMediaArtifacts.length ? { mediaArtifacts: responseMediaArtifacts } : {}),
                  fileArtifacts: responseFileArtifacts,
                  conversationId: data.conversationId,
                }
              : message
          )));
        } else if (!displayable) {
          setMessages(prev => prev.filter(message => message.id !== streamId));
        }
      } else if (displayable && deliveredText) {
        setMessages(prev => [...prev, {
          id: makeChatMessageId('agent'),
          text: deliveredText,
          userName: data.agentName,
          timestamp: new Date().toISOString(),
          type: 'agent',
          ...(completionFeedback ? { completionFeedback } : {}),
          ...(responseMediaArtifacts.length ? { mediaArtifacts: responseMediaArtifacts } : {}),
          fileArtifacts: responseFileArtifacts,
          conversationId: data.conversationId,
        }]);
      }

      const activeMediaGeneration = activeMediaGenerationRef.current;
      if (activeMediaGeneration?.requestId === requestId) {
        // Only an agent:tool result can complete the studio. Model-authored
        // response text may describe an artifact, but is not execution proof.
        let hasArtifact = mediaGenerationArtifactsRef.current.some(
          artifact => artifact.kind === activeMediaGeneration.mode,
        );
        let replayReceiptRejected = false;
        if (data.artifactReceipt !== undefined && !mediaGenerationReceiptSettingsMatch(activeMediaGeneration.request, data.artifactReceipt)) {
          replayReceiptRejected = true;
          setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
        } else if (!hasArtifact && data.artifactReceipt !== undefined) {
          hasArtifact = receiveMediaArtifacts(data.artifactReceipt, activeMediaGeneration, false);
        }
        const validation = mediaGenerationArtifactValidationRef.current;
        const terminalSucceeded = isFinalizedSuccessfulResponse(data);
        if (!terminalSucceeded) {
          if (validation) {
            validation.finalized = true;
            validation.terminalSucceeded = false;
            validation.terminalBlocked = Boolean(data.blocked);
          }
          setMediaGeneration({ status: responseWasCancelled ? 'cancelled' : 'error', detail: responseWasCancelled
            ? mediaGenerationText.statusCancelled
            : describeAgentResponseDelivery({
                ...data,
                text: data.text || mediaGenerationText.taskBlocked,
              }, isZh) });
        } else if (replayReceiptRejected) {
          // Preserve the exact settings mismatch reported above.
        } else if (!hasArtifact || !validation?.contractValid) {
          setMediaGeneration({ status: 'error', detail: mediaGenerationText.taskEndedNoArtifact });
        } else {
          validation.finalized = true;
          validation.terminalSucceeded = true;
          validation.terminalBlocked = false;
          if (validation.readyIds.size >= validation.requiredCount) {
            setMediaGeneration({ status: 'completed', detail: '' });
          } else {
            setMediaGeneration({ status: 'generating', detail: mediaGenerationText.validatingArtifact });
          }
        }
        activeMediaGenerationRef.current = null;
      }

      if (hasRemainingRequests) {
        // Every terminal owns only its own UI bucket. This applies to an
        // ordinary FIFO predecessor as well as a sidecar.
        return;
      }

      const finalization: ChatResponseFinalization = {
        finalized: data.finalized,
        blocked: data.blocked,
        reason: data.reason,
      };
      currentTurnUiMetaRef.current = turnMeta || currentTurnUiMetaRef.current;
      currentTurnUiMetaRef.current.finalization = finalization;
      if (!displayable) {
        setWorkflowStatus('error');
        const rejected = describeTurnCompletionProgress(
          isZh,
          turnMeta?.hadTool ?? currentTurnUiMetaRef.current.hadTool,
          true,
          { finalized: false, blocked: true, reason: data.reason },
        );
        finishChatProgress(rejected.text, rejected.tone);
        scheduleWorkflowReset(data.requestId);
        return;
      }
      const finalizedSuccess = isFinalizedSuccessfulResponse(data);
      const wasCancelled = responseWasCancelled;
      setWorkflowStatus(
        wasCancelled
          ? 'cancelled'
          : data.blocked ? 'error' : finalizedSuccess ? 'done' : 'idle'
      );
      const completion = describeTurnCompletionProgress(
        isZh,
        turnMeta?.hadTool ?? currentTurnUiMetaRef.current.hadTool,
        turnMeta?.needsEvidence ?? currentTurnUiMetaRef.current.needsEvidence,
        finalization,
      );
      finishChatProgress(completion.text, completion.tone);
      if (data.blocked || finalizedSuccess) scheduleWorkflowReset(data.requestId);
      // Auto-speak disabled
    };

    const onStatus = (data: { status: string; requestId?: string; source?: string; conversationId?: string; taskRelation?: unknown; executionAccepted?: boolean }) => {
      if (!isCurrentChatEvent(data)) return;
      recordTaskRelation(data);
      const activeStatus = ['queued', 'replacing', 'acknowledged', 'planning', 'thinking', 'responding', 'executing', 'waiting_confirmation', 'cancelling'].includes(data.status);
      const terminalStatus = isTerminalAgentStatus(data.status);
      const terminalTracking = terminalStatus
        ? settleTrackedChatRequest(data.requestId)
        : null;
      setIsTyping(activeStatus || chatRequestLedgerRef.current.size > 0 || Boolean(terminalTracking?.remaining));
      const requestId = String(data.requestId || '').trim();
      if (data.status === 'cancelling' && activeMediaGenerationRef.current?.requestId === requestId) {
        setMediaGeneration({ status: 'cancelling', detail: mediaGenerationText.statusCancelling });
      }
      if (!terminalStatus && requestId && requestId !== chatRequestLedgerRef.current.foreground) return;
      const turnMeta = chatTurnUiMetaRef.current.get(requestId);
      const activity = projectAgentActivity(data.status, {
        executionAccepted: data.executionAccepted,
        hasToolEvidence: turnMeta?.hadTool ?? currentTurnUiMetaRef.current.hadTool,
      });
      if (activity === 'thinking') {
        setWorkflowStatus('thinking');
        pushChatProgress(uiMessage('agent-chat-page.i-am-figuring-out-how.017a8f967e', (isZh) ? 'zh' : 'en'), 'thinking');
      } else if (activity === 'executing') {
        setWorkflowStatus('executing');
      } else if (activity === 'waiting_confirmation') {
        setWorkflowStatus('waiting_confirmation');
      } else if (activity === 'cancelling') {
        setWorkflowStatus('cancelling');
      } else if (data.status === 'idle') {
        if (!terminalTracking?.remaining) {
          setIsTyping(false);
          if (!currentTurnUiMetaRef.current.finalization) {
            setWorkflowStatus('idle');
            clearChatProgress();
            seenWorkflowToolEvents.current.clear();
          }
        }
      } else if (isTerminalAgentStatus(data.status)) {
        if (activeMediaGenerationRef.current?.requestId === String(data.requestId || '').trim()) {
          const cancelled = data.status === 'cancelled' || data.status === 'canceled';
          setMediaGeneration({ status: cancelled ? 'cancelled' : 'error', detail: cancelled ? mediaGenerationText.statusCancelled : mediaGenerationText.taskFailed });
          activeMediaGenerationRef.current = null;
        }
        if (!terminalTracking?.remaining) {
          setIsTyping(false);
          setWorkflowStatus('error');
          finishChatProgress(
            uiMessage('agent-chat-page.something-went-wrong-i-am.01c198a67b', (isZh) ? 'zh' : 'en'),
            'error'
          );
          scheduleWorkflowReset(data.requestId);
        }
      }
      if (terminalStatus) {
        // Drop partial streaming chunks that were never finalized
        dropRequestStream(data.requestId);
      }
    };

    const onError = (data: { message: string; code?: string; requestId?: string; source?: string; conversationId?: string; sidecar?: boolean }) => {
      if (!isCurrentChatEvent(data)) return;
      if (!terminalReceiptsRef.current.claim(data)) return;
      const message = sanitizeAgentResponseTextForDisplay(
        data.message || (t.failedToRouteNeuralMesh || 'Failed to route through Neural Mesh.'),
        isZh ? 'zh' : 'en',
      );
      if (activeMediaGenerationRef.current?.requestId === String(data.requestId || '').trim()) {
        setMediaGeneration({ status: 'error', detail: message || mediaGenerationText.taskFailed });
        activeMediaGenerationRef.current = null;
      }
      const tracked = settleTrackedChatRequest(data.requestId);
      const hasRemainingRequests = tracked.remaining > 0;
      setIsTyping(hasRemainingRequests);
      if (!hasRemainingRequests) {
        setWorkflowStatus('error');
        finishChatProgress(
          uiMessage('agent-chat-page.something-went-wrong-i-am.01c198a67b', (isZh) ? 'zh' : 'en'),
          'error'
        );
        scheduleWorkflowReset(data.requestId);
      }
      dropRequestStream(data.requestId);
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

    const onTaskRelation = (data: ServerTaskRelationEvent) => {
      const eventSource = String(data?.source || '').trim();
      const eventConversationId = String(data?.conversationId || '').trim();
      const currentConversationId = attachmentConversationIdRef.current;
      if (eventSource && eventSource !== chatExecutionSource) return;
      if (currentConversationId && eventConversationId && eventConversationId !== currentConversationId) return;
      if (!currentConversationId && eventConversationId) {
        bindAttachmentContextToConversation(eventConversationId, { carryCurrent: true });
      }
      recordTaskRelation(data);
    };

    // conversation_updated: only reload for non-text-chat channels (voice, etc.)
    // Text chat state is managed live via agent:chunk/agent:response; API reload here
    // would replace messages with different ids, causing React to remount & re-animate them.
    const onConversationUpdated = (data: {
      conversationId: string;
      agentId: string;
      source?: string;
      requestId?: string;
      originSocketId?: string;
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
      if (!shouldReloadPersistedConversation({
        event: data,
        currentConversationId,
        currentSocketId: socket.id,
        activeRequestId: chatRequestLedgerRef.current.foreground,
      })) return;
      const work = chatViewWorkRef.current.begin();
      const messageRevision = messagesRevisionRef.current;
      const refreshRevision = ++historyRefreshRevisionRef.current;
      fetch(scopedConversationUrl(`/api/conversations/${data.conversationId}/messages?limit=${CHAT_HISTORY_LIMIT}`), { signal: work.signal })
        .then(r => r.json())
        .then(result => {
          if (!work.isCurrent()
            || data.conversationId !== attachmentConversationIdRef.current
            || refreshRevision !== historyRefreshRevisionRef.current
            || messageRevision !== messagesRevisionRef.current
            || chatRequestLedgerRef.current.size > 0) return;
          if (result.messages && Array.isArray(result.messages)) {
            streamingMsgIdsRef.current.clear();
            streamingRawTextRef.current.clear();
            setMessages(normalizePersistedMessages(result.messages));
          }
        })
        .catch(() => {})
        .finally(() => work.finish());
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
    socket.on("agent:desktop_control_state", onDesktopControlState);
    socket.on("agent:chunk", onChunk);
    socket.on("agent:progress", onProgress);
    socket.on("agent:tool", onTool);
    socket.on("agent:tool_call", onTool);
    socket.on("agent:response", onResponse);
    socket.on("agent:status", onStatus);
    socket.on("agent:task_relation", onTaskRelation);
    socket.on("agent:error", onError);
    socket.on("chat:conversation_updated", onConversationUpdated);

    return () => {
      socket.off("agent:proactive", onProactive);
      socket.off("agent:desktop_control_state", onDesktopControlState);
      socket.off("agent:chunk", onChunk);
      socket.off("agent:progress", onProgress);
      socket.off("agent:tool", onTool);
      socket.off("agent:tool_call", onTool);
      socket.off("agent:response", onResponse);
      socket.off("agent:status", onStatus);
      socket.off("agent:task_relation", onTaskRelation);
      socket.off("agent:error", onError);
      socket.off("chat:conversation_updated", onConversationUpdated);
    };
  }, [
    attachmentConversationIdRef,
    activeDomain,
    activeOrgId,
    acceptChatExecutionEvent,
    agentId,
    agentName,
    bindAttachmentContextToConversation,
    chatExecutionSource,
    clearChatProgress,
    clearPersistedExecution,
    dropRequestStream,
    finishChatProgress,
    isFounder,
    isZh,
    mediaGenerationText,
    normalizePersistedMessages,
    pushChatProgress,
    scheduleWorkflowReset,
    scopedConversationUrl,
    setMessages,
    settleTrackedChatRequest,
    socket,
    t.failedToRouteNeuralMesh,
    t.requestFailed,
    t.workflowAnalyzing,
    t.workflowError,
  ]);

  useEffect(() => {
    if (isFounder || !socket) return;

    let disposed = false;
    let recoveryAttempt = 0;
    const resumeActiveExecution = async () => {
      if (!activeExecutionStorageKey) return;
      const attempt = ++recoveryAttempt;
      let ownsView = chatViewWorkRef.current.capture();
      const isCurrentRecovery = () => !disposed && attempt === recoveryAttempt && ownsView();
      let pending: PersistedPendingChatExecution[] = [];
      try {
        // Legacy keys have no verifiable user owner; only the v3 key is read.
        localStorage.removeItem(`lumi_active_chat_execution:${agentId}:${activeDomain}:${activeOrgId || ''}`);
        pending = ownedPendingChatExecutions(
          JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null'),
          recoveryOwner,
        );
      } catch {
        localStorage.removeItem(activeExecutionStorageKey);
      }
      pending = pending.filter((execution) => {
        const startedAt = Date.parse(execution.startedAt);
        const valid = Number.isFinite(startedAt)
          && Date.now() - startedAt <= ACTIVE_CHAT_EXECUTION_TTL_MS;
        if (!valid) clearPersistedExecution(execution.requestId);
        return valid;
      });
      if (pending.length === 0) return;

      const mediaExecution = isOfficeCommandCenter
        ? [...pending].reverse().find(execution => execution.mediaGeneration)
        : undefined;
      for (const execution of pending) {
        if (!chatRequestLedgerRef.current.has(execution.requestId)) {
          chatRequestLedgerRef.current.begin(execution.requestId);
        }
      }
      chatTurnTimerGuardRef.current.begin(chatRequestLedgerRef.current.foreground);
      setIsTyping(true);
      if (pending.some(execution => !lastResumedRequestIdsRef.current.has(execution.requestId))) {
        pending.forEach(execution => lastResumedRequestIdsRef.current.add(execution.requestId));
        pushChatProgress(uiMessage('agent-chat-page.restoring-task-state.0fb759a4dc', isZh ? 'zh' : 'en'), 'thinking');
      }

      let fallbackConversationId = String(attachmentConversationIdRef.current || '').trim();
      if (!fallbackConversationId && pending.some(execution => !execution.conversationId)) {
        try {
          const activeResponse = await fetch(scopedConversationUrl('/api/conversations/active'), { credentials: 'include' });
          const activeData = await activeResponse.json();
          if (!isCurrentRecovery()) return;
          fallbackConversationId = String(activeData.activeConversation?.id || '').trim();
          if (fallbackConversationId && !attachmentConversationIdRef.current) {
            bindAttachmentContextToConversation(fallbackConversationId, { carryCurrent: true });
            // This recovery itself adopted the server's conversation; later
            // user navigation must still invalidate its acknowledgement.
            ownsView = chatViewWorkRef.current.capture();
            const stored = JSON.parse(localStorage.getItem(activeExecutionStorageKey) || 'null');
            let updated = { version: 2 as const, pending: ownedPendingChatExecutions(stored, recoveryOwner) };
            for (const execution of pending) {
              if (!execution.conversationId) updated = upsertPersistedPendingChatExecution(updated, { ...execution, conversationId: fallbackConversationId });
            }
            localStorage.setItem(activeExecutionStorageKey, JSON.stringify(updated));
          }
        } catch {}
      }

      if (!isCurrentRecovery()) return;
      for (const execution of pending) {
        const recoveryConversationId = String(
          execution.conversationId || fallbackConversationId || '',
        ).trim();
        socket.emit('agent:execution_resume', {
          requestId: execution.requestId,
          source: execution.source || chatExecutionSource,
          domain: execution.domain,
          orgId: execution.orgId || null,
          conversationId: recoveryConversationId || undefined,
        }, (result?: { ok?: boolean; snapshot?: ChatExecutionSnapshot; error?: string }) => {
          if (!isCurrentRecovery() || !chatRequestLedgerRef.current.has(execution.requestId)) return;
          const snapshot = result?.snapshot;
          if (!result?.ok || !snapshot || snapshot.requestId !== execution.requestId || snapshot.source !== execution.source) {
            if (activeMediaGenerationRef.current?.requestId === execution.requestId) resetMediaGenerationSurface();
            const tracked = settleTrackedChatRequest(execution.requestId);
            setIsTyping(tracked.remaining > 0);
            if (tracked.remaining === 0) {
              setWorkflowStatus('error');
              pushChatProgress(
                result?.error || uiMessage('agent-chat-page.previous-task-not-recoverable.17e6ad375c', isZh ? 'zh' : 'en'),
                'error',
              );
            }
            return;
          }
          // Restore local references only after this user's exact execution
          // has been found by the authenticated backend.
          if (mediaExecution?.requestId === execution.requestId && mediaExecution.mediaGeneration) {
            const request = mediaExecution.mediaGeneration;
            activeMediaGenerationRef.current = { requestId: execution.requestId, mode: request.mode, request };
            mediaStudioOpenRef.current = true;
            mediaGenerationArtifactsRef.current = [];
            mediaGenerationArtifactValidationRef.current = null;
            setMediaGenerationArtifacts([]);
            setMediaGeneration({ status: 'generating', detail: mediaGenerationText.statusGenerating });
            setMediaStudioMode(request.mode);
            setMediaSources({
              primaryImage: request.primaryImage || '', primaryArtifactId: request.primaryArtifactId || '',
              referenceImages: request.referenceImages || [], referenceArtifactIds: request.referenceArtifactIds || [],
              referenceImage: request.referenceImage || '', referenceArtifactId: request.referenceArtifactId || '',
            });
          }
          if (snapshot.terminal || execution.requestId !== chatRequestLedgerRef.current.foreground) return;
          if (snapshot.status === 'waiting_confirmation') setWorkflowStatus('waiting_confirmation');
          else if (snapshot.status === 'cancelling') setWorkflowStatus('cancelling');
          else if (snapshot.status === 'executing') setWorkflowStatus('executing');
          else setWorkflowStatus('thinking');
          setIsTyping(chatRequestLedgerRef.current.size > 0);
        });
      }
    };

    socket.on('connect', resumeActiveExecution);
    if (socket.connected) resumeActiveExecution();
    return () => { disposed = true; socket.off('connect', resumeActiveExecution); };
  }, [attachmentConversationIdRef, activeDomain, activeExecutionStorageKey, activeOrgId, agentId, bindAttachmentContextToConversation, chatExecutionSource, clearPersistedExecution, isFounder, isOfficeCommandCenter, isZh, mediaGenerationText.statusGenerating, pushChatProgress, recoveryOwner, resetMediaGenerationSurface, scopedConversationUrl, settleTrackedChatRequest, socket]);
  const { handleConversationHistorySelectorBlur, startNewTextConversation, handleConversationHistoryScroll, orderedConversationHistory, restoreTextConversation, toggleConversationHistory, deleteConversationFromHistory } = useConversationTransitions({ conversationTransitionRef, isCreatingConversation, restoringConversationId, setConversationTransitionPending, setIsCreatingConversation, invalidateChatViewWork, chatViewWorkRef, scopedConversationUrl, activeDomain, detachPreviousExecution, bindAttachmentContextToConversation, setConversationHistory, setMessages, setPendingAttachments, pendingAttachmentsRef, setSearchQuery, setSearchResults, setSearchError, messageInputRef, agentId, isOpen, conversationHistoryLoadingRef, conversationHistoryHasMoreRef, conversationHistoryRequestRef, conversationHistoryOffsetRef, setConversationHistoryLoadingMore, setConversationHistoryLoading, setConversationHistoryHasMore, setConversationHistorySelectorExpanded, activeOrgId, conversationHistoryOpen, isOfficeCommandCenter, conversationHistory, conversationHistorySelectorExpanded, conversationHistoryHasMore, conversationHistoryListRef, setConversationHistoryOpen, attachmentConversationIdRef, setRestoringConversationId, normalizePersistedMessages, deletingConversationId, t, isZh, setConversationContextMenu, appConfirm, setDeletingConversationId });

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
    clearChatProgress();
    seenWorkflowToolEvents.current.clear();
  }, [clearChatProgress, isOpen]);

  const rememberAttachmentContext = useCallback((attachments: ChatAttachment[]) => {
    const reusable = attachments
      .filter(item => item.path || item.transcript || item.content || item.preview)
      .map(serializeChatAttachment);
    if (reusable.length === 0) return;
    rememberConversationAttachments(reusable);
  }, [rememberConversationAttachments]);

  const clearConversationAttachmentContext = useCallback(() => {
    clearStoredAttachments();
    toast.success(uiMessage('agent-chat-page.session-materials-cleared.53bea199b2'));
  }, [clearStoredAttachments]);

  const sendText = useCallback(async (
    text: string,
    attachments: ChatAttachment[] = pendingAttachments,
    options: ChatSendOptions = {},
  ) => {
    // All entry points (form, Enter, shell command, suggested text) use this
    // synchronous barrier, including the interval before React re-renders.
    if (conversationTransitionRef.current) return;
    if (chatUploadsRef.current.busy || chatUploadsRef.current.canRetry) {
      toast.info(chatUploadsRef.current.busy ? attachmentUploadText.processing : attachmentUploadText.failed);
      return;
    }
    const trimmedText = text.trim();
    const directAttachments = attachments.map(serializeChatAttachment);
    const reusableConversationAttachments = options.includeConversationAttachments === false
      ? []
      : conversationAttachmentsRef.current.map(serializeChatAttachment);
    const attachmentMerge = mergeChatAttachmentReferences(
      reusableConversationAttachments,
      directAttachments,
    );
    const outgoingAttachments = attachmentMerge.attachments;
    const reusedConversationAttachmentContext =
      options.includeConversationAttachments !== false
      && conversationAttachmentsRef.current.length > 0
      && directAttachments.length === 0;
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
    const requestId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    options.onRequestCreated?.(requestId);
    const wasIdle = chatRequestLedgerRef.current.size === 0;
    chatTurnUiMetaRef.current.set(requestId, {
      hadTool: false,
      needsEvidence: needsVisibleToolEvidence(outgoingText, outgoingAttachments.length > 0),
      finalization: null,
    });
    if (wasIdle) {
      currentTurnUiMetaRef.current = chatTurnUiMetaRef.current.get(requestId)!;
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
    }

    setMessages(prev => {
      const base = prev.length >= priorMessages.length ? prev : priorMessages;
      return [...base, userMsg];
    });
    setDraftText('');
    setPendingAttachments(prev => {
      const next = prev.filter(item => !outgoingAttachments.some(sent => sent.id === item.id));
      pendingAttachmentsRef.current = next;
      return next;
    });
    if (outgoingAttachments.length > 0) rememberAttachmentContext(outgoingAttachments);
    setIsTyping(true);
    const { controlTargetRequestId } = chatRequestLedgerRef.current.begin(requestId);
    const taskControlTarget = taskRelationLedgerRef.current.controlTarget({
      conversationId: attachmentConversationIdRef.current,
      foregroundRequestId: controlTargetRequestId,
    });
    if (wasIdle) chatTurnTimerGuardRef.current.begin(requestId);
    persistActiveExecution(requestId);

    const watcher = new ChatExecutionWatch({
      requestId, source: chatExecutionSource, firstProbeMs: outgoingAttachments.length > 0 ? 180000 : 120000,
      probe: reply => socket.emit('agent:execution_resume', {
        requestId, source: chatExecutionSource, domain: activeDomain, orgId: activeOrgId || null,
        conversationId: attachmentConversationIdRef.current || undefined,
      }, reply),
      onEvent: (event, error) => {
        const terminal = event === 'rejected' || event === 'no_ack' || event === 'lost';
        const foreground = chatRequestLedgerRef.current.foreground === requestId;
        const detail = error || ({
          rejected: uiMessage('agent-chat-page.the-backend-did-not-accept.44d78fa21a', isZh ? 'zh' : 'en'),
          no_ack: uiMessage('agent-chat-page.the-backend-has-not-acknowledged.4a6f380020', isZh ? 'zh' : 'en'),
          ack_timeout: uiMessage('agent-chat-page.the-backend-has-not-acknowledged.4a6f380020', isZh ? 'zh' : 'en'),
          lost: uiMessage('agent-chat-page.backend-lost-task.8bbc4d5800', isZh ? 'zh' : 'en'),
          acknowledged: uiMessage('agent-chat-page.the-backend-has-received-this.859b50e7ed', isZh ? 'zh' : 'en'),
          working: uiMessage('agent-chat-page.the-backend-has-accepted-this.aa53249e15', isZh ? 'zh' : 'en'),
          probe_timeout: socket.connected
            ? uiMessage('agent-chat-page.rechecking-task-state.7d8729d39f', isZh ? 'zh' : 'en')
            : uiMessage('agent-chat-page.connection-lost-task-will-resume.52cd95319f', isZh ? 'zh' : 'en'),
        }[event]);
        if (foreground) {
          if (terminal || event === 'ack_timeout') setWorkflowStatus('error');
          pushChatProgress(detail, terminal || event === 'ack_timeout' ? 'error' : 'thinking');
        }
        if (activeMediaGenerationRef.current?.requestId === requestId) {
          if (event === 'acknowledged') setMediaGeneration({ status: 'submitting', detail: '' });
          else if (terminal || event === 'ack_timeout') {
            setMediaGeneration({ status: 'error', detail: error || (event === 'lost' ? mediaGenerationText.backendLostTask
              : event === 'rejected' ? mediaGenerationText.backendRejected : mediaGenerationText.backendNoAck) });
            if (terminal) activeMediaGenerationRef.current = null;
          }
        }
        if (terminal) {
          dropRequestStream(requestId);
          const tracked = settleTrackedChatRequest(requestId);
          setIsTyping(tracked.remaining > 0);
        }
      },
    });
    activeChatViewDetachersRef.current.set(requestId, () => watcher.dispose());

    const chatPayload = {
      text: outgoingText,
      attachments: outgoingAttachments,
      history: buildChatHistoryPayload(priorMessages),
      personalityId: 'lumi',
      category: agentCategory,
      agentId,
      domain: activeDomain,
      orgId: activeOrgId || null,
      source: chatExecutionSource,
      operationMode,
      ...(options.mediaRequest ? { mediaRequest: options.mediaRequest } : {}),
      requestId,
      controlTargetRequestId: taskControlTarget.controlTargetRequestId || undefined,
      controlTargetTaskId: taskControlTarget.controlTargetTaskId,
      controlTargetRevision: taskControlTarget.controlTargetRevision,
      conversationId: attachmentConversationIdRef.current || undefined,
    };

    socket.emit("agent:chat", chatPayload, (ack?: { ok?: boolean; error?: string }) => watcher.acknowledge(ack));

    // No frontend AI fallback here. If the realtime backend is down, show the
    // connection problem instead of generating a second, inconsistent answer.
    return requestId;
  }, [
    attachmentConversationIdRef, conversationAttachmentsRef,
    attachmentUploadText,
    activeDomain,
    activeOrgId,
    agentCategory,
    agentId,
    chatExecutionSource,
    clearChatProgress,
    dropRequestStream,
    isZh,
    mediaGenerationText,
    messages,
    operationMode,
    pendingAttachments,
    persistActiveExecution,
    pushChatProgress,
    rememberAttachmentContext,
    setDraftText,
    setMessages,
    settleTrackedChatRequest,
    socket,
    t.chatUserFallback,
    user,
  ]);

  const openMediaGenerationStudio = useCallback((mode: MediaGenerationKind) => {
    void refreshKnowledgeFiles();
    const activeRequest = activeMediaGenerationRef.current;
    mediaStudioOpenRef.current = true;
    if (activeRequest) {
      // Reopening AI Creation returns to the active request, keeping its
      // status and artifacts attached to the matching media type.
      setMediaStudioMode(activeRequest.mode);
      return;
    }
    const hasSameKindArtifacts = mediaGenerationArtifactsRef.current.some(artifact => artifact.kind === mode);
    if (!hasSameKindArtifacts) {
      mediaGenerationArtifactsRef.current = [];
      setMediaGenerationArtifacts([]);
      setMediaGeneration({ status: 'idle', detail: '' });
    }
    setMediaStudioMode(mode);
  }, [refreshKnowledgeFiles]);

  const consumedCreationRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !isOfficeCommandCenter || !creationRequestId || consumedCreationRequestRef.current === creationRequestId) return;
    consumedCreationRequestRef.current = creationRequestId;
    openMediaGenerationStudio('image');
    onCreationRequestConsumed?.(creationRequestId);
  }, [creationRequestId, isOfficeCommandCenter, isOpen, onCreationRequestConsumed, openMediaGenerationStudio]);

  const handleMediaSourceChange = useCallback((change: MediaGenerationSourceChange) => {
    const artifactId = change.value.trim() ? change.artifact?.id || '' : '';
    setMediaSources(current => {
      if (change.operation === 'image_to_video') return { ...current, referenceImage: change.value, referenceArtifactId: artifactId };
      if (change.slot === 'primary') return { ...current, primaryImage: change.value, primaryArtifactId: artifactId };
      return { ...current, referenceImages: change.value.trim() ? [change.value] : [], referenceArtifactIds: artifactId ? [artifactId] : [] };
    });
  }, []);

  const requestMediaSourceImage = useCallback((
    operation: MediaGenerationSourceOperation,
    slot: MediaGenerationSourceSlot,
  ) => {
    if (mediaSourceUploading) return;
    mediaSourceUploadTargetRef.current = { operation, slot };
    mediaSourceFileInputRef.current?.click();
  }, [mediaSourceUploading]);

  const generateMediaFromStudio = useCallback((request: MediaGenerationRequest) => {
    if (isTyping || activeMediaGenerationRef.current) {
      setMediaGeneration({ status: 'error', detail: mediaGenerationText.anotherTaskRunning });
      return;
    }
    const mediaRequest = normalizeStructuredMediaRequest(request);
    if (!mediaRequest) {
      setMediaGeneration({ status: 'error', detail: mediaGenerationText.settingsMismatch });
      return;
    }

    mediaGenerationArtifactsRef.current = [];
    mediaGenerationArtifactValidationRef.current = null;
    setMediaGenerationArtifacts([]);
    setMediaGeneration({ status: 'submitting', detail: '' });
    setMediaGenerationRetryRequest(request);
    const requestActionLabel = request.operation === 'text_to_image'
      ? mediaGenerationText.generateImage
      : request.operation === 'image_edit'
        ? mediaGenerationText.editImage
        : request.operation === 'image_to_video'
          ? mediaGenerationText.animateImage
          : mediaGenerationText.generateVideo;
    const requestText = `${requestActionLabel}${isZh ? '：' : ': '}${request.prompt}`;
    void sendText(requestText, [], {
      mediaRequest,
      includeConversationAttachments: false,
      onRequestCreated: requestId => {
        activeMediaGenerationRef.current = {
          requestId,
          mode: request.mode,
          request: {
            mode: request.mode,
            operation: request.operation,
            size: request.size,
            ...(request.operation === 'text_to_image'
              ? { count: request.count || 1 }
              : request.operation === 'image_edit'
                ? {
                    primaryImage: request.primaryImage,
                    referenceImages: request.referenceImages,
                    primaryArtifactId: request.primaryArtifactId,
                    referenceArtifactIds: request.referenceArtifactIds,
                  }
                : {
                    duration: request.duration || 6,
                    ...(request.operation === 'image_to_video'
                      ? {
                          referenceImage: request.referenceImage,
                          referenceArtifactId: request.referenceArtifactId,
                        }
                      : {}),
                  }),
          },
        };
      },
    }).then(requestId => {
      if (requestId) return;
      activeMediaGenerationRef.current = null;
      setMediaGeneration({ status: 'error', detail: mediaGenerationText.requestNotCreated });
    });
  }, [isTyping, isZh, mediaGenerationText, sendText]);

  const closeMediaGenerationStudio = useCallback(() => {
    mediaStudioOpenRef.current = false;
    mediaSourceUploadTargetRef.current = null;
    setMediaSourceUploading(false);
    setChatSongOpen(false);
    setMediaStudioMode(null);
  }, []);

  const requestCloseCreativeStudio = useCallback(async () => {
    const workbench = chatSongWorkbenchRef.current;
    if (workbench && !await workbench.prepareToLeave()) {
      setChatSongOpen(true);
      return;
    }
    closeMediaGenerationStudio();
  }, [closeMediaGenerationStudio]);

  const markMediaGenerationArtifactReady = useCallback((artifact: MediaGenerationArtifact) => {
    const validation = mediaGenerationArtifactValidationRef.current;
    if (!validation?.expectedIds.has(artifact.id) || !validation.contractValid) return;
    validation.failedIds.delete(artifact.id);
    validation.readyIds.add(artifact.id);
    if (
      validation.finalized
      && validation.terminalSucceeded
      && !validation.terminalBlocked
      && validation.readyIds.size >= validation.requiredCount
    ) {
      setMediaGeneration({ status: 'completed', detail: '' });
    }
  }, []);

  const markMediaGenerationArtifactFailed = useCallback((artifact: MediaGenerationArtifact) => {
    const validation = mediaGenerationArtifactValidationRef.current;
    if (!validation?.expectedIds.has(artifact.id)) return;
    validation.readyIds.delete(artifact.id);
    validation.failedIds.add(artifact.id);
    const remainingPossible = validation.expectedIds.size - validation.failedIds.size;
    if (!validation.contractValid || remainingPossible < validation.requiredCount) {
      setMediaGeneration({ status: 'error', detail: mediaGenerationText.artifactLoadFailed });
    }
  }, [mediaGenerationText.artifactLoadFailed]);

  const openMediaGenerationArtifact = useCallback((artifact: MediaGenerationArtifact) => {
    void openChatFile({
      fileName: artifact.fileName || (artifact.kind === 'image' ? 'generated-image' : 'generated-video'),
      path: artifact.path,
      openUrl: artifact.url,
      saveUrl: artifact.url,
    });
  }, [openChatFile]);

  const cancelActiveChat = () => {
    const requestId = chatRequestLedgerRef.current.foreground;
    if (!socket || !requestId) {
      if (activeMediaGenerationRef.current) {
        setMediaGeneration({ status: 'error', detail: mediaGenerationText.backendLostTask });
      }
      return;
    }
    const ownsView = chatViewWorkRef.current.capture();
    const ownsRequest = () => ownsView() && chatRequestLedgerRef.current.foreground === requestId;
    setWorkflowStatus('cancelling');
    pushChatProgress(uiMessage('agent-chat-page.cancelling-task.18c33c6327', isZh ? 'zh' : 'en'), 'thinking');
    let acknowledged = false;
    chatTurnTimerGuardRef.current.schedule(requestId, 8000, () => {
      if (acknowledged || !ownsRequest()) return;
      setWorkflowStatus('error');
      if (activeMediaGenerationRef.current?.requestId === requestId) {
        setMediaGeneration({ status: 'error', detail: mediaGenerationText.taskFailed });
      }
      pushChatProgress(
        socket.connected
          ? uiMessage('agent-chat-page.cancellation-not-confirmed.990f6802e1', isZh ? 'zh' : 'en')
          : uiMessage('agent-chat-page.connection-lost-recheck-task.6c0952c278', isZh ? 'zh' : 'en'),
        'error',
      );
    });
    socket.emit('agent:abort_chat', {
      requestId,
      source: chatExecutionSource,
      domain: activeDomain,
      orgId: activeOrgId || null,
      conversationId: attachmentConversationIdRef.current || undefined,
    }, (result?: { ok?: boolean; error?: string }) => {
      acknowledged = true;
      if (!ownsRequest()) return;
      if (!result?.ok) {
        setWorkflowStatus('error');
        if (activeMediaGenerationRef.current?.requestId === requestId) {
          setMediaGeneration({ status: 'error', detail: result?.error || mediaGenerationText.taskFailed });
        }
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
  }, [agentName, onPrefillConsumed, prefillMessage, prefillSource, setMessages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    sendText(draftTextRef.current.trim(), pendingAttachments);
  };

  useEffect(() => {
    if (!isOpen) return;
    const submitCommandInput = () => {
      sendText(draftTextRef.current.trim(), pendingAttachmentsRef.current);
    };
    window.addEventListener('lumi:submit-command-input', submitCommandInput);
    return () => window.removeEventListener('lumi:submit-command-input', submitCommandInput);
  }, [isOpen, sendText]);

  const toggleListening = () => {
    if (isListening) {
      if (inputDictationActiveRef.current) {
        inputDictationActiveRef.current = false;
        localVoiceSession.endCall();
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
        localVoiceSession.startCall(selectedVoiceId, 'lumi', agentId, {
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
    const result = mergePendingChatAttachments(conversationAttachmentsRef.current, pendingAttachmentsRef.current, incoming);
    if (result.added.length > 0) {
      pendingAttachmentsRef.current = result.attachments;
      setPendingAttachments(result.attachments);
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
  }, [conversationAttachmentsRef]);

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

  const acceptImportedChatFiles = useCallback((files: any[], skippedCount: number, work: ReturnType<ChatViewWorkRegistry['begin']>) => {
    if (!work.isCurrent()) return;
    const attachments = mapImportedChatAttachments(files, scopedFileUrl);
    const mergeResult = appendPendingAttachments(attachments, { announce: false });
    const addedAttachments = mergeResult.added;
    setOptimizationProgress(100);
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
  }, [appendPendingAttachments, scopedFileUrl, notifyKnowledgeUpdated, setDraftText]);

  const runChatAttachmentUpload = useCallback(async (
    kind: ChatUploadKind, sources: ChatUploadSource[], retry = false,
  ) => {
    if ((!retry && sources.length === 0) || chatUploadsRef.current.busy) return;
    const occupiedCount = mergeChatAttachmentReferences(
      conversationAttachmentsRef.current, pendingAttachmentsRef.current,
    ).attachments.length;
    const remainingSlots = MAX_CHAT_ATTACHMENTS - occupiedCount;
    if (remainingSlots <= 0) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
      return;
    }
    const attempt = chatUploadsRef.current.begin(kind, sources, remainingSlots, retry);
    if (!attempt) return;
    setIsOptimizing(true);
    setAttachmentUploadFailures([]);
    setOptimizationProgress(30);
    const work = chatViewWorkRef.current.begin();
    if (!retry && sources.length > attempt.items.length) {
      toast.error(formatUiMessage('agent-chat-page.up-to-value0-files-can.349aa29325', { value0: MAX_CHAT_ATTACHMENTS }));
    }
    try {
      const uploadItemIds = attempt.items.map(item => item.id);
      let response: Response;
      if (attempt.batch.kind === 'files') {
        const formData = new FormData();
        attempt.items.forEach(item => formData.append('files', item.source as File));
        formData.append('domain', activeDomain);
        if (activeDomain === 'work' && activeOrgId) formData.append('orgId', activeOrgId);
        formData.append('uploadBatchId', attempt.batch.id);
        formData.append('uploadItemIds', JSON.stringify(uploadItemIds));
        response = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include', signal: work.signal });
      } else {
        response = await fetch(scopedFileUrl('/api/files/import-paths'), {
          signal: work.signal, method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Lumi-Desktop-Import': 'file-drop' },
          body: JSON.stringify({ paths: attempt.items.map(item => item.source), uploadBatchId: attempt.batch.id, uploadItemIds }),
        });
      }
      const payload = await response.json().catch(() => ({}));
      if (!work.isCurrent()) return;
      const failures = chatUploadsRef.current.complete(attempt, payload, t.uploadFailed || attachmentUploadText.unknown);
      setAttachmentUploadFailures(failures);
      if (Array.isArray(payload.files) && payload.files.length > 0) acceptImportedChatFiles(payload.files, 0, work);
      if (!response.ok && failures.length === 0) toast.error(payload.error || t.uploadFailed || attachmentUploadText.unknown);
    } catch (error: any) {
      if (!work.isCurrent()) return;
      setAttachmentUploadFailures(chatUploadsRef.current.complete(attempt, null, error?.message || t.chatConnError || attachmentUploadText.unknown));
    } finally {
      chatUploadsRef.current.finish(attempt);
      if (work.isCurrent()) { setIsOptimizing(false); setOptimizationProgress(0); }
      work.finish();
    }
  }, [conversationAttachmentsRef, acceptImportedChatFiles, activeDomain, activeOrgId, attachmentUploadText, scopedFileUrl, t.chatConnError, t.uploadFailed]);

  const uploadChatAttachments = useCallback(async (files: FileList | null) => {
    await runChatAttachmentUpload('files', Array.from(files || []));
  }, [runChatAttachmentUpload]);

  const uploadMediaSourceImage = useCallback(async (files: FileList | null) => {
    const target = mediaSourceUploadTargetRef.current;
    const file = files?.[0];
    if (!target || !file || mediaSourceUploading) return;
    if (!file.type.startsWith('image/') && !/\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name)) {
      toast.error(mediaGenerationText.chooseImageFile);
      mediaSourceUploadTargetRef.current = null;
      return;
    }

    setMediaSourceUploading(true);
    const work = chatViewWorkRef.current.begin();
    const formData = new FormData();
    formData.append('files', file);
    formData.append('domain', activeDomain);
    if (activeDomain === 'work' && activeOrgId) formData.append('orgId', activeOrgId);
    try {
      const response = await fetch('/api/files/upload', {
        signal: work.signal,
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({}));
      if (!work.isCurrent() || mediaSourceUploadTargetRef.current !== target) return;
      if (!response.ok) throw new Error(payload?.error || t.uploadFailed || 'Upload failed');
      const uploaded = Array.isArray(payload?.files) ? payload.files[0] : null;
      const sourcePath = String(uploaded?.path || '').trim();
      if (!uploaded || !sourcePath) throw new Error(mediaGenerationText.uploadMissingPath);
      const fileName = String(uploaded.displayName || uploaded.name || file.name || 'source-image');
      const artifact: MediaGenerationArtifact = {
        id: `source-image-${String(uploaded.id || fileName)}-${Date.now()}`,
        kind: 'image',
        url: uploaded.id
          ? scopedFileUrl(`/api/files/download/${encodeURIComponent(String(uploaded.id))}?inline=1`)
          : scopedFileUrl(makeChatArtifact(sourcePath).url),
        path: sourcePath,
        fileName,
      };
      setMediaSourceArtifacts(previous => [
        ...previous.filter(item => item.path !== artifact.path && item.url !== artifact.url),
        artifact,
      ].slice(-24));
      handleMediaSourceChange({
        operation: target.operation,
        slot: target.slot,
        value: sourcePath,
        artifact,
      });
      notifyKnowledgeUpdated([{ id: uploaded.id || sourcePath, name: fileName, displayName: fileName }]);
      toast.success(mediaGenerationText.sourceImageLoaded);
    } catch (error: any) {
      if (work.isCurrent() && mediaSourceUploadTargetRef.current === target) toast.error(error?.message || t.chatConnError || 'Image upload failed');
    } finally {
      if (work.isCurrent() && mediaSourceUploadTargetRef.current === target) {
        setMediaSourceUploading(false);
        mediaSourceUploadTargetRef.current = null;
      }
      work.finish();
    }
  }, [activeDomain, activeOrgId, handleMediaSourceChange, mediaGenerationText, mediaSourceUploading, notifyKnowledgeUpdated, scopedFileUrl, t.chatConnError, t.uploadFailed]);

  const importChatAttachmentPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths.map(item => String(item || '').trim()).filter(Boolean))];
    await runChatAttachmentUpload('paths', uniquePaths);
  }, [runChatAttachmentUpload]);

  useEffect(() => {
    if (!isOpen) return;
    return listenForNativeChatFileDrop(setIsDraggingFiles, nativeDropHandledAtRef, importChatAttachmentPaths);
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
  return <AgentChatView {...{ isOpen, previewFile, isZh, setPreviewFile, openChatFileInSystem, layout, commandCenterView, resolvedAppearanceMode, prefersReducedMotion, handleChatDragOver, handleChatDragLeave, handleChatDrop, chatAccentTheme, fileInputRef, uploadChatAttachments, mediaSourceFileInputRef, uploadMediaSourceImage, isOfficeCommandCenter, mediaStudioMode, isTyping, mediaSourceUploading, mediaGenerationStatus, mediaGenerationDetail, mediaGenerationArtifacts, libraryMediaArtifacts, knowledgeLoading, knowledgeFailed, refreshKnowledgeFiles, appendPendingAttachments, requestCloseCreativeStudio, availableMediaSourceArtifacts, mediaSources, mediaGenerationRetryRequest, openMediaGenerationStudio, handleMediaSourceChange, requestMediaSourceImage, isWorkChat, setChatSongOpen, chatSongOpen, user, chatSongWorkbenchRef, knowledgeFiles, generateMediaFromStudio, sendText, closeMediaGenerationStudio, setMediaGeneration, mediaGenerationText, cancelActiveChat, openMediaGenerationArtifact, markMediaGenerationArtifactReady, markMediaGenerationArtifactFailed, isDraggingFiles, showWeChatSettings, setShowWeChatSettings, t, isCommandCenterUtility, onCommandCenterViewChange, onOpenNexus, onClose, setShowVoicePicker, showVoicePicker, voices, selectedVoiceId, voicePickerRef, setSelectedVoiceId, callState, audioLevel, startVoiceSession, endVoiceSession, activeDomain, requestMeetingMode, agentName, operationModeMeta, OperationModeIcon, activeDomainDetail, activeDomainLabel, agentCategory, runtimeStatus, runtimeStatusLoading, runtimeStatusError, refreshRuntimeStatus, workflowTaskActive, workflowStatus, chatProgressStatusText, conversationHistoryOpen, conversationHistorySelectorExpanded, setConversationHistorySelectorExpanded, handleConversationHistorySelectorBlur, conversationHistory, startNewTextConversation, isCreatingConversation, restoringConversationId, conversationHistoryListRef, handleConversationHistoryScroll, conversationHistoryLoading, conversationHistoryLoadingMore, orderedConversationHistory, attachmentConversationIdRef, restoreTextConversation, setConversationContextMenu, conversationHistoryHasMore, toggleConversationHistory, chatPanelStyle, chatHeaderStyle, knowledgeStatusText, setCommandCenterPlannerOpen, commandCenterPlannerOpen, commandCenterPlannerText, searchQuery, setSearchQuery, setSearchResults, setSearchError, setDraftText, messageInputRef, scrollRef, messages, visibleSuggestions, searchError, isSearchingHistory, searchDisplayMessages, hiddenMessageCount, displayMessages, renderGeneratedFiles, openChatFile, handleCopyMessage, copiedId, chatProgressLines, chatInputPanelStyle, conversationAttachments, clearConversationAttachmentContext, pendingAttachments, removePendingAttachment, isOptimizing, attachmentUploadFailures, runChatAttachmentUpload, chatUploadsRef, setAttachmentUploadFailures, optimizationProgress, handleSendMessage, attachmentMenuRef, setShowAttachmentMenu, showAttachmentMenu, referenceableChatFiles, pendingAttachmentKeys, referenceChatFile, updateDraftText, chatInputStyle, toggleListening, isListening, conversationTransitionPending, hasDraftText, onOpenMemoryAvatar, onOpenKnowledge, chatFileSections, renderChatFileRow, isElectron, activeCapabilities, conversationContextMenu, deletingConversationId, deleteConversationFromHistory }} />;

}
