import type { GeneratedFileLink, KnowledgeUpdateDetail } from "../contracts";
import { stripStoredAttachmentSummary } from "../history";
import { extractPersistedMediaArtifacts } from "../media_artifacts";
import { getSelectedTextWithin } from "../appearance";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FileResourceVideo } from "../../FileResourceMedia";
import { FileText, Image as ImageIcon, Video, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { normalizeTaskCompletionFeedback } from "../../workflowTypes";
import { uiMessage } from "../../../i18n/uiMessages";
import { CN_FOUNDER_ALIASES } from "../../../i18n/regions/cn/recognition";
import { chatAttachmentIdentity } from "@/lib/chatAttachmentReferences";
import { hasInternalAgentExecutionDetail, sanitizeAgentResponseTextForDisplay } from "@/lib/agentResponseDelivery";
import { chatExecutionStorageKey, ownedPendingChatExecutions, type ChatRecoveryOwner } from "@/lib/chatExecutionRecovery";
import { resolveChatExecutionEvent } from "@/lib/conversationSync";
import { takeChatStreamBucket, removePersistedPendingChatExecution, upsertPersistedPendingChatExecution, type PersistedPendingChatExecution } from "@/lib/chatEventReceipts";
import type { useChatAttachmentsAndPresentation } from './use_chat_attachments_and_presentation';
import { CHAT_SEARCH_LIMIT } from './shared';

export function useChatHistoryAndRequests(previousBindings: ReturnType<typeof useChatAttachmentsAndPresentation>) {
  const { pendingAttachments, chatFileSections, agentId, agentCategory, agentName, isOpen, refreshKnowledgeFiles, activeDomain, activeOrgId, socket, agentNameRef, recognition, setDraftText, setIsListening, t, setCopiedId, mediaGenerationText, openChatFile, searchQuery, messages, searchResults, user, isZh, setSearchResults, setIsSearchingHistory, setSearchError, scopedConversationUrl, chatExecutionSource, attachmentConversationIdRef, activeMediaGenerationRef, chatExecutionWatchesRef, terminalReceiptsRef, chatRequestLedgerRef, chatTurnUiMetaRef, chatTurnTimerGuardRef, currentTurnUiMetaRef, resetMediaGenerationSurface, setIsTyping, setWorkflowStatus, clearChatProgress, seenWorkflowToolEvents, setMessages, bindAttachmentContextToConversation } = previousBindings;

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

  useEffect(() => { agentNameRef.current = agentName; }, [agentName, agentNameRef]);

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
  }, [recognition, setDraftText, setIsListening, t.speechNotSupported]);

  const handleCopyMessage = useCallback(async (text: string, id: string, container?: HTMLElement | null) => {
    try {
      await navigator.clipboard.writeText(getSelectedTextWithin(container) || text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  }, [setCopiedId]);

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
  }, [user?.displayName, user?.username, t.chatUserFallback, agentNameRef, isZh]);

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
  }, [agentId, isFounder, normalizePersistedMessages, scopedConversationUrl, searchQuery, setIsSearchingHistory, setSearchError, setSearchResults]);

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
  }, [activeExecutionStorageKey, chatRecoveryUserId, chatExecutionSource, activeDomain, activeOrgId, attachmentConversationIdRef, activeMediaGenerationRef, recoveryOwner]);
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
    for (const watch of chatExecutionWatchesRef.current.values()) watch.dispose();
    chatExecutionWatchesRef.current.clear();
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
  }, [chatExecutionWatchesRef, clearPersistedExecution, terminalReceiptsRef, chatRequestLedgerRef, chatTurnUiMetaRef, chatTurnTimerGuardRef, currentTurnUiMetaRef, resetMediaGenerationSurface, setIsTyping, setWorkflowStatus, clearChatProgress, seenWorkflowToolEvents]);

  const dropRequestStream = useCallback((requestId?: string) => {
    const id = takeChatStreamBucket(streamingMsgIdsRef.current, streamingRawTextRef.current, requestId);
    if (id) setMessages(prev => prev.filter(message => message.id !== id));
  }, [setMessages]);
  const resumeForegroundRequest = useCallback((requestId: string) => {
    const nextMeta = chatTurnUiMetaRef.current.get(requestId);
    currentTurnUiMetaRef.current = nextMeta || { hadTool: false, needsEvidence: false, finalization: null };
    setWorkflowStatus('thinking');
  }, [chatTurnUiMetaRef, currentTurnUiMetaRef, setWorkflowStatus]);


  const settleTrackedChatRequest = useCallback((requestId?: string) => {
    const normalizedRequestId = String(requestId || '').trim();
    chatExecutionWatchesRef.current.get(normalizedRequestId)?.dispose();
    chatExecutionWatchesRef.current.delete(normalizedRequestId);
    const previousForeground = chatRequestLedgerRef.current.foreground;
    chatTurnUiMetaRef.current.delete(normalizedRequestId);
    const result = chatRequestLedgerRef.current.settle(normalizedRequestId);
    clearPersistedExecution(normalizedRequestId || undefined);
    if (result.foregroundRequestId && result.foregroundRequestId !== previousForeground) {
      chatTurnTimerGuardRef.current.begin(result.foregroundRequestId);
      resumeForegroundRequest(result.foregroundRequestId);
    }
    return result;
  }, [chatExecutionWatchesRef, chatRequestLedgerRef, chatTurnTimerGuardRef, chatTurnUiMetaRef, clearPersistedExecution, resumeForegroundRequest]);
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
  }, [attachmentConversationIdRef, bindAttachmentContextToConversation, chatExecutionSource, chatRequestLedgerRef, persistActiveExecution]);
  return {
    ...previousBindings, lastConversationScopeRef, initialLoadDoneRef, detachPreviousExecution, isFounder, normalizePersistedMessages,
    acceptChatExecutionEvent, streamingRawTextRef, streamingMsgIdsRef, settleTrackedChatRequest, dropRequestStream, clearPersistedExecution,
    activeExecutionStorageKey, recoveryOwner, lastResumedRequestIdsRef, persistActiveExecution, pendingAttachmentKeys, searchDisplayMessages,
    requestMeetingMode, renderGeneratedFiles, handleCopyMessage, referenceableChatFiles
  } as const;
}
