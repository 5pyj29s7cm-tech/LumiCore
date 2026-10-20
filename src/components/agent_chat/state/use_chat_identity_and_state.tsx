import { CREATION_EXECUTION_SOURCE } from '../../../../shared/creation_workspace';
import type { ChatExecutionWatch } from '@/lib/chatExecutionWatch';
import type { AgentChatVoiceSession, ChatAttachment, ConversationHistoryItem, ConversationHistoryContextMenu, WorkflowStatus, ChatTurnUiMeta } from "../contracts";
import { makeChatMessageId } from "../history";
import { CHAT_LIGHT_THEME, CHAT_NEUTRAL_THEME } from "../appearance";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSongWorkbenchHandle } from "../../ChatSongWorkbench";
import { ChatViewWorkRegistry } from "@/lib/chatViewWork";
import { ChatAttachmentUploads, type ChatUploadFailure } from "@/lib/chatAttachmentUploads";
import { chatAttachmentCopy } from "../../../i18n/locales/chatAttachments";
import { useReducedMotion } from "motion/react";
import { Sparkles, FileText } from "lucide-react";
import type { ChatPreviewFile } from "../../ChatFilePreview";
import { toast } from "sonner";
import { useAppConfirm } from "@/lib/appConfirm";
import { usePlatform } from "@/hooks/usePlatform";
import { useApp } from "@/contexts/AppContext";
import { socketService } from "@/services/socketService";
import { LUMI_VOICE_TRANSCRIPT_EVENT, useVoiceCall, type VoiceTranscriptEventDetail } from "@/hooks/useVoiceCall";
import { listVoices, VOICE_PROVIDER_CHANGED_EVENT } from "@/services/voiceService";
import type { ChatProgressLine } from "@/lib/chatProgress";
import { uiMessage } from "../../../i18n/uiMessages";
import type { ChatAttachmentRequest } from "@/lib/chatAttachmentReferences";
import { ChatTerminalReceiptLedger, ChatRequestLedger, ChatTurnTimerGuard } from "@/lib/chatEventReceipts";
import { ChatTaskRelationLedger } from "@/lib/chatTaskRelations";
import type { CommandCenterView } from "../../commandCenterTypes";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { commandCenterPlannerCopy } from "@/i18n/locales/commandCenterPlanner";
import { mediaGenerationCopy } from "@/i18n/locales/mediaGeneration";
import { EMPTY_MEDIA_GENERATION_SOURCES, type MediaGenerationRequest, type MediaGenerationSourceSlot, type MediaGenerationStudioStatus } from "../../MediaGenerationStudio";
import type { MediaGenerationArtifact, MediaGenerationExpectation, MediaGenerationKind, MediaGenerationSourceOperation } from "@/lib/mediaGenerationArtifacts";

export function useChatIdentityAndState({
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
  onReferenceArtifact,
  desktopModeControl,
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
  layout?: 'standalone' | 'command-center' | 'creation';
  commandCenterView?: CommandCenterView;
  onCommandCenterViewChange?: (view: CommandCenterView) => void;
  onOpenNexus?: () => void;
  /** Open the Memory Avatar surface from the command-center right rail. */
  onOpenMemoryAvatar?: () => void;
  /** Open the scoped knowledge base from the command-center right rail. */
  onOpenKnowledge?: () => void;
  /** Desktop command center reuses the shell's single microphone session. */
  voiceSession?: AgentChatVoiceSession;
  onReferenceArtifact?: (artifact: MediaGenerationArtifact) => void;
  desktopModeControl?: React.ReactNode;
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
  const chatExecutionWatchesRef = useRef(new Map<string, ChatExecutionWatch>());
  useEffect(() => () => { chatViewWorkRef.current.invalidate(); chatUploadsRef.current.reset(); for (const watch of chatExecutionWatchesRef.current.values()) watch.dispose(); chatExecutionWatchesRef.current.clear(); }, []);
  const isCreationWorkspace = layout === 'creation';
  const isOfficeCommandCenter = isCreationWorkspace || (layout === 'command-center' && commandCenterView === 'office');
  const isCommandCenterUtility = layout === 'command-center' && !isOfficeCommandCenter;
  const chatExecutionSource = isCreationWorkspace ? CREATION_EXECUTION_SOURCE : layout === 'command-center' ? 'command-center-chat' : 'chat';
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
    enabled: isOpen && isOfficeCommandCenter && !isCreationWorkspace && Boolean(user),
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
  const messageInputRef = useRef<HTMLInputElement>(null);
  const mediaStudioOpenRef = useRef(false);
  const draftTextRef = useRef('');
  const [hasDraftText, setHasDraftText] = useState(false);
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
    disabled: usesSharedVoiceSession || isCreationWorkspace,
    onTranscript: handleLocalVoiceTranscript,
  });
  const callState = voiceSession?.callState ?? localVoiceSession.callState;
  const audioLevel = voiceSession?.audioLevel ?? localVoiceSession.audioLevel;
  const callError = voiceSession?.error ?? localVoiceSession.error;
  const localCallState = localVoiceSession.callState;
  const endLocalVoiceSession = localVoiceSession.endCall;
  const switchLocalVoice = localVoiceSession.switchVoice;
  const agentId = agent?.id || 'lumi';
  const endVoiceSession = voiceSession?.onEnd ?? (() => localVoiceSession.endCall());
  const lastSharedTranscriptRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (!usesSharedVoiceSession || !isOpen || isCreationWorkspace) return;
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
  }, [isOpen, setMessages, user?.displayName, user?.username, usesSharedVoiceSession, isCreationWorkspace]);

  useEffect(() => {
    if (isCreationWorkspace) return;
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
    }).catch(() => toast.error(t.failedToLoadVoices || 'Failed to load voices'));
  }, [
    activeDomain,
    activeOrgId,
    getSelectedVoiceIdForProvider,
    selectedVoiceId,
    setSelectedVoiceId,
    t.failedToLoadVoices,
    voiceProviderRevision, isCreationWorkspace,
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

  const [isTyping, setIsTyping] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [attachmentUploadFailures, setAttachmentUploadFailures] = useState<ChatUploadFailure[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [optimizationProgress, setOptimizationProgress] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);

  useEffect(() => {
    if (!isOpen || isCreationWorkspace) return;
    const frame = requestAnimationFrame(() => {
      if (!mediaStudioOpenRef.current) messageInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isCreationWorkspace]);

  useEffect(() => {
    if (!isOpen || isCreationWorkspace) return;
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
  }, [isOpen, isCreationWorkspace]);
  const [previewFile, setPreviewFile] = useState<ChatPreviewFile | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
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
  const currentTurnUiMetaRef = useRef<ChatTurnUiMeta>({ hadTool: false, finalization: null });
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
  return {
    mediaStudioOpenRef, activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef,
    setMediaStudioMode, setMediaGenerationArtifacts, setMediaGeneration, setMediaGenerationRetryRequest,
    setMediaSourceArtifacts, setMediaSources, setMediaSourceUploading, mediaSourceUploadTargetRef, isOpen,
    isOfficeCommandCenter, pendingAttachmentsRef, pendingAttachments, inputDictationActiveRef, localCallState,
    endLocalVoiceSession, setIsListening, chatProgressClearTimerRef, lastChatProgressTextRef, setChatProgressLines,
    chatTurnTimerGuardRef, setWorkflowStatus, seenWorkflowToolEvents, draftTextRef, setHasDraftText, messageInputRef,
    showVoicePicker, setShowVoicePicker, showWeChatSettings, setShowWeChatSettings, showAttachmentMenu,
    setShowAttachmentMenu, conversationHistoryOpen, setConversationHistoryOpen, conversationContextMenu,
    setConversationContextMenu, agent, t, user, agentId, activeDomain, activeOrgId, chatViewWorkRef, chatUploadsRef,
    setAttachmentUploadFailures, setIsOptimizing, setOptimizationProgress, setPreviewFile, messages,
    mediaSourceArtifacts, mediaGenerationArtifacts, platform, socket, agentNameRef, recognition, setCopiedId,
    mediaGenerationText, searchQuery, searchResults, isZh, setSearchResults, setIsSearchingHistory, setSearchError,
    chatExecutionSource, chatExecutionWatchesRef, terminalReceiptsRef, chatRequestLedgerRef, chatTurnUiMetaRef,
    currentTurnUiMetaRef, setIsTyping, setMessages, setIsCreatingConversation, setRestoringConversationId,
    setPendingAttachments, messagesRef, conversationTransitionRef, setConversationTransitionPending,
    taskRelationLedgerRef, messagesRevisionRef, historyRefreshRevisionRef, isCreatingConversation,
    restoringConversationId, setConversationHistory, setSearchQuery, conversationHistoryLoadingRef,
    conversationHistoryHasMoreRef, conversationHistoryRequestRef, conversationHistoryOffsetRef,
    setConversationHistoryLoadingMore, setConversationHistoryLoading, setConversationHistoryHasMore,
    setConversationHistorySelectorExpanded, conversationHistory, conversationHistorySelectorExpanded,
    conversationHistoryHasMore, conversationHistoryListRef, deletingConversationId, appConfirm,
    setDeletingConversationId, scrollRef, chatProgressLines, attachmentUploadText, operationMode, creationRequestId, isCreationWorkspace, onReferenceArtifact,
    onCreationRequestConsumed, mediaSourceUploading, isTyping, setChatSongOpen,
    chatSongWorkbenchRef, prefillMessage, prefillSource, onPrefillConsumed, isListening, localVoiceSession,
    isElectron, callState, selectedVoiceId, attachmentRequest, onAttachmentRequestConsumed, setIsDraggingFiles,
    onClose, workflowStatus, chatAccentTheme, previewFile, layout, commandCenterView,
    resolvedAppearanceMode, prefersReducedMotion, mediaStudioMode, mediaGenerationStatus, mediaGenerationDetail,
    mediaSources, mediaGenerationRetryRequest, isWorkChat, chatSongOpen, isDraggingFiles, isCommandCenterUtility,
    onCommandCenterViewChange, onOpenNexus, voices, voicePickerRef, setSelectedVoiceId, audioLevel,
    voiceSession, endVoiceSession, operationModeMeta, OperationModeIcon, activeDomainDetail, activeDomainLabel,
    runtimeStatus, runtimeStatusLoading, runtimeStatusError, refreshRuntimeStatus, conversationHistoryLoading,
    conversationHistoryLoadingMore, setCommandCenterPlannerOpen, commandCenterPlannerOpen, commandCenterPlannerText,
    visibleSuggestions, searchError, isSearchingHistory, copiedId, isOptimizing, attachmentUploadFailures,
    optimizationProgress, attachmentMenuRef, conversationTransitionPending, hasDraftText, onOpenMemoryAvatar,
    onOpenKnowledge, activeCapabilities, desktopModeControl
  } as const;
}
