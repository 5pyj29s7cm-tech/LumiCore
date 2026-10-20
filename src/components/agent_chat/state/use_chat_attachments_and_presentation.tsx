import type { GeneratedFileLink, KnowledgeUpdateDetail, ChatFilePanelItem } from "../contracts";
import { getDisplayText } from "../history";
import { extractGeneratedFiles, generatedFileKind } from "../media_artifacts";
import { useConversationAttachments } from "../../../hooks/useConversationAttachments";
import { useCallback, useEffect, useMemo } from "react";
import { useGeneratedLibrary } from "@/hooks/useGeneratedLibrary";
import { archivedMediaArtifacts } from "@/lib/generatedLibrary";
import { saveFileResource } from "@/services/fileResource";
import { chatArtifactKind, makeChatArtifact } from "../../../../shared/chat_artifacts";
import { toast } from "sonner";
import type { ChatProgressTone } from "@/lib/chatProgress";
import type { FileEntry } from "../../MemoryTree";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import { isImageFileName, isAudioFileName } from "@/lib/chatAttachmentReferences";
import { buildChatConversationScopeKey } from "@/lib/chatConversationScope";
import { EMPTY_MEDIA_GENERATION_SOURCES } from "../../MediaGenerationStudio";
import type { MediaGenerationArtifact } from "@/lib/mediaGenerationArtifacts";
import type { useChatIdentityAndState } from './use_chat_identity_and_state';

export function useChatAttachmentsAndPresentation(previousBindings: ReturnType<typeof useChatIdentityAndState>) {
  const { isCreationWorkspace, chatExecutionSource, mediaStudioOpenRef, activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaGenerationArtifactValidationRef, setMediaStudioMode, setMediaGenerationArtifacts, setMediaGeneration, setMediaGenerationRetryRequest, setMediaSourceArtifacts, setMediaSources, setMediaSourceUploading, mediaSourceUploadTargetRef, isOpen, isOfficeCommandCenter, pendingAttachmentsRef, pendingAttachments, inputDictationActiveRef, localCallState, endLocalVoiceSession, setIsListening, chatProgressClearTimerRef, lastChatProgressTextRef, setChatProgressLines, chatTurnTimerGuardRef, setWorkflowStatus, seenWorkflowToolEvents, draftTextRef, setHasDraftText, messageInputRef, showVoicePicker, setShowVoicePicker, showWeChatSettings, setShowWeChatSettings, showAttachmentMenu, setShowAttachmentMenu, conversationHistoryOpen, setConversationHistoryOpen, conversationContextMenu, setConversationContextMenu, agent, t, user, agentId, activeDomain, activeOrgId, chatViewWorkRef, chatUploadsRef, setAttachmentUploadFailures, setIsOptimizing, setOptimizationProgress, setPreviewFile, messages, mediaSourceArtifacts, mediaGenerationArtifacts, platform } = previousBindings;


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
  }, [activeMediaGenerationRef, mediaGenerationArtifactValidationRef, mediaGenerationArtifactsRef, mediaSourceUploadTargetRef, mediaStudioOpenRef, setMediaGeneration, setMediaGenerationArtifacts, setMediaGenerationRetryRequest, setMediaSourceArtifacts, setMediaSourceUploading, setMediaSources, setMediaStudioMode]);

  useEffect(() => {
    if (!isCreationWorkspace && (!isOpen || !isOfficeCommandCenter)) {
      resetMediaGenerationSurface();
    }
  }, [isCreationWorkspace, isOfficeCommandCenter, isOpen, resetMediaGenerationSurface]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments, pendingAttachmentsRef]);

  useEffect(() => {
    if (inputDictationActiveRef.current && localCallState === 'idle') {
      inputDictationActiveRef.current = false;
      endLocalVoiceSession();
      setIsListening(false);
    }
  }, [endLocalVoiceSession, inputDictationActiveRef, localCallState, setIsListening]);

  const clearChatProgress = useCallback(() => {
    if (chatProgressClearTimerRef.current) {
      clearTimeout(chatProgressClearTimerRef.current);
      chatProgressClearTimerRef.current = null;
    }
    lastChatProgressTextRef.current = '';
    setChatProgressLines([]);
  }, [chatProgressClearTimerRef, lastChatProgressTextRef, setChatProgressLines]);

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
  }, [chatProgressClearTimerRef, lastChatProgressTextRef, setChatProgressLines]);

  const finishChatProgress = useCallback((text: string, tone: ChatProgressTone = 'done') => {
    pushChatProgress(text, tone);
    if (chatProgressClearTimerRef.current) clearTimeout(chatProgressClearTimerRef.current);
    chatProgressClearTimerRef.current = setTimeout(() => {
      lastChatProgressTextRef.current = '';
      setChatProgressLines([]);
      chatProgressClearTimerRef.current = null;
    }, 4200);
  }, [chatProgressClearTimerRef, lastChatProgressTextRef, pushChatProgress, setChatProgressLines]);

  const scheduleWorkflowReset = useCallback((requestId?: string) => {
    chatTurnTimerGuardRef.current.schedule(String(requestId || ''), 5000, () => {
      setWorkflowStatus('idle');
      seenWorkflowToolEvents.current.clear();
    });
  }, [chatTurnTimerGuardRef, seenWorkflowToolEvents, setWorkflowStatus]);

  useEffect(() => () => {
    if (chatProgressClearTimerRef.current) clearTimeout(chatProgressClearTimerRef.current);
    chatTurnTimerGuardRef.current.dispose();
  }, [chatProgressClearTimerRef, chatTurnTimerGuardRef]);

  const updateDraftText = useCallback((value: string) => {
    draftTextRef.current = value;
    const nextHasDraft = value.trim().length > 0;
    setHasDraftText(prev => prev === nextHasDraft ? prev : nextHasDraft);
  }, [draftTextRef, setHasDraftText]);

  const setDraftText = useCallback((value: string) => {
    updateDraftText(value);
    if (messageInputRef.current) messageInputRef.current.value = value;
  }, [messageInputRef, updateDraftText]);

  useEffect(() => {
    if (!isOpen || isCreationWorkspace) return;
    const replaceCommandInput = (event: Event) => {
      const text = String((event as CustomEvent<{ text?: string }>).detail?.text || '');
      if (!text) return;
      setDraftText(text);
      messageInputRef.current?.focus();
    };
    window.addEventListener('lumi:replace-command-input', replaceCommandInput);
    return () => window.removeEventListener('lumi:replace-command-input', replaceCommandInput);
  }, [isCreationWorkspace, isOpen, messageInputRef, setDraftText]);

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
  }, [conversationContextMenu, conversationHistoryOpen, setConversationContextMenu, setConversationHistoryOpen, setShowAttachmentMenu, setShowVoicePicker, setShowWeChatSettings, showAttachmentMenu, showVoicePicker, showWeChatSettings]);

  const agentName = agent?.name || (t.lumiEssence || 'Lumi Essence');
  const agentCategory = agent?.category || (t.friend || 'friend');
  const attachmentContextStoragePrefix = `lumi_chat_attachment_context:${user?.id || user?.username || 'anonymous'}:${buildChatConversationScopeKey(agentId, activeDomain, activeOrgId)}${isCreationWorkspace ? `:${chatExecutionSource}` : ''}`;
  const invalidateChatViewWork = useCallback(() => {
    chatViewWorkRef.current.invalidate();
    chatUploadsRef.current.reset();
    setAttachmentUploadFailures([]);
    setIsOptimizing(false);
    setOptimizationProgress(0);
    setMediaSourceUploading(false);
    mediaSourceUploadTargetRef.current = null;
  }, [chatUploadsRef, chatViewWorkRef, mediaSourceUploadTargetRef, setAttachmentUploadFailures, setIsOptimizing, setMediaSourceUploading, setOptimizationProgress]);
  const resetAttachmentConversationView = useCallback(() => {
    invalidateChatViewWork();
    setPreviewFile(null);
  }, [invalidateChatViewWork, setPreviewFile]);
  const { conversationAttachments, conversationAttachmentsRef, attachmentConversationIdRef,
    bindAttachmentContextToConversation, rememberConversationAttachments, clearConversationAttachments: clearStoredAttachments,
  } = useConversationAttachments(attachmentContextStoragePrefix, resetAttachmentConversationView);
  const scopedConversationUrl = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}domain=${encodeURIComponent(activeDomain)}&agentId=${encodeURIComponent(agentId)}${isCreationWorkspace ? '&surface=creation' : ''}`;
  }, [activeDomain, agentId, isCreationWorkspace]);
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
      ...mediaSourceArtifacts.slice().reverse(),
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
    }).slice(0, 24);
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
  }, [attachmentConversationIdRef, scopedFileUrl, setPreviewFile]);

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
  return {
    ...previousBindings, chatFileSections, agentCategory, agentName, refreshKnowledgeFiles, setDraftText, openChatFile, scopedConversationUrl,
    attachmentConversationIdRef, resetMediaGenerationSurface, clearChatProgress, bindAttachmentContextToConversation, invalidateChatViewWork,
    attachmentContextStoragePrefix, pushChatProgress, finishChatProgress, scheduleWorkflowReset, rememberConversationAttachments, clearStoredAttachments,
    conversationAttachmentsRef, scopedFileUrl, notifyKnowledgeUpdated, fileKindLabel, openChatFileInSystem, libraryMediaArtifacts, knowledgeLoading,
    knowledgeFailed, availableMediaSourceArtifacts, knowledgeFiles, knowledgeStatusText, conversationAttachments, updateDraftText
  } as const;
}
