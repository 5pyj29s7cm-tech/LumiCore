import { apiFetch } from '@/services/apiClient';
import type { MediaGenerationSourceOperation } from '@/lib/mediaGenerationArtifacts';
import type { MediaGenerationSourceSlot } from '../../MediaGenerationStudio';
import { AgentChatView } from "../AgentChatView";
import type { ChatAttachment, ChatFilePanelItem } from "../contracts";
import React, { useCallback, useEffect, useRef } from "react";
import type { ChatViewWorkRegistry } from "@/lib/chatViewWork";
import { type ChatUploadKind, type ChatUploadSource } from "@/lib/chatAttachmentUploads";
import { FileText, Mic, Check, Paperclip, Image as ImageIcon, ExternalLink } from "lucide-react";
import { makeChatArtifact } from "../../../../shared/chat_artifacts";
import { toast } from "sonner";
import { FoundersSanctuary } from "../../FoundersSanctuary";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import { MAX_CHAT_ATTACHMENTS, chatAttachmentIdentity, chatAttachmentRequestMatchesScope, createChatAttachmentReference, mergeChatAttachmentReferences, mergePendingChatAttachments, mapImportedChatAttachments } from "@/lib/chatAttachmentReferences";
import type { MediaGenerationArtifact } from "@/lib/mediaGenerationArtifacts";
import type { useChatMediaControls } from './use_chat_media_controls';
import { CHAT_RENDER_LIMIT } from './shared';

export function useChatUploadsAndView(previousBindings: ReturnType<typeof useChatMediaControls>) {
  const { onReferenceArtifact, conversationAttachmentsRef, pendingAttachmentsRef, setPendingAttachments, isOpen, attachmentRequest, activeDomain, activeOrgId, setShowAttachmentMenu, messageInputRef, onAttachmentRequestConsumed, scopedFileUrl, setOptimizationProgress, draftTextRef, setDraftText, notifyKnowledgeUpdated, chatUploadsRef, setIsOptimizing, setAttachmentUploadFailures, chatViewWorkRef, t, attachmentUploadText, mediaSourceUploadTargetRef, mediaSourceUploading, mediaGenerationText, setMediaSourceUploading, setMediaSourceArtifacts, handleMediaSourceChange, setIsDraggingFiles, pendingAttachmentKeys, fileKindLabel, openChatFile, isFounder, user, onClose, chatProgressLines, workflowStatus, isZh, isTyping, chatAccentTheme, searchQuery, searchDisplayMessages, messages, previewFile, setPreviewFile, openChatFileInSystem, layout, commandCenterView, resolvedAppearanceMode, prefersReducedMotion, isOfficeCommandCenter, mediaStudioMode, mediaVideoOptions, mediaVideoOptionsLoading, mediaGenerationStatus, mediaGenerationDetail, mediaGenerationArtifacts, libraryMediaArtifacts, knowledgeLoading, knowledgeFailed, refreshKnowledgeFiles, requestCloseCreativeStudio, availableMediaSourceArtifacts, mediaSources, mediaGenerationRetryRequest, openMediaGenerationStudio, isWorkChat, setChatSongOpen, chatSongOpen, chatSongWorkbenchRef, knowledgeFiles, generateMediaFromStudio, checkMediaGenerationStatus, sendText, closeMediaGenerationStudio, setMediaGeneration, cancelActiveChat, openMediaGenerationArtifact, markMediaGenerationArtifactReady, markMediaGenerationArtifactFailed, isDraggingFiles, showWeChatSettings, setShowWeChatSettings, isCommandCenterUtility, onCommandCenterViewChange, onOpenNexus, setShowVoicePicker, showVoicePicker, voices, selectedVoiceId, voicePickerRef, setSelectedVoiceId, callState, audioLevel, startVoiceSession, endVoiceSession, requestMeetingMode, agentName, operationModeMeta, OperationModeIcon, activeDomainDetail, activeDomainLabel, agentCategory, runtimeStatus, runtimeStatusLoading, runtimeStatusError, refreshRuntimeStatus, conversationHistoryOpen, conversationHistorySelectorExpanded, setConversationHistorySelectorExpanded, handleConversationHistorySelectorBlur, conversationHistory, startNewTextConversation, isCreatingConversation, restoringConversationId, conversationHistoryListRef, handleConversationHistoryScroll, conversationHistoryLoading, conversationHistoryLoadingMore, orderedConversationHistory, attachmentConversationIdRef, restoreTextConversation, setConversationContextMenu, conversationHistoryHasMore, toggleConversationHistory, knowledgeStatusText, setCommandCenterPlannerOpen, commandCenterPlannerOpen, commandCenterPlannerText, setSearchQuery, setSearchResults, setSearchError, scrollRef, visibleSuggestions, searchError, isSearchingHistory, renderGeneratedFiles, handleCopyMessage, copiedId, conversationAttachments, clearConversationAttachmentContext, pendingAttachments, isOptimizing, attachmentUploadFailures, optimizationProgress, handleSendMessage, attachmentMenuRef, showAttachmentMenu, referenceableChatFiles, updateDraftText, toggleListening, isListening, conversationTransitionPending, hasDraftText, onOpenMemoryAvatar, onOpenKnowledge, chatFileSections, isElectron, activeCapabilities, conversationContextMenu, deletingConversationId, deleteConversationFromHistory } = previousBindings;


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
  }, [conversationAttachmentsRef, pendingAttachmentsRef, setPendingAttachments]);

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
  }, [activeDomain, activeOrgId, appendPendingAttachments, attachmentRequest, isOpen, messageInputRef, onAttachmentRequestConsumed, setShowAttachmentMenu]);

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
  }, [scopedFileUrl, appendPendingAttachments, setOptimizationProgress, notifyKnowledgeUpdated, draftTextRef, setDraftText]);

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
      const formData = new FormData();
      attempt.items.forEach(item => formData.append('files', item.source as File));
      formData.append('domain', activeDomain);
      if (activeDomain === 'work' && activeOrgId) formData.append('orgId', activeOrgId);
      formData.append('uploadBatchId', attempt.batch.id);
      formData.append('uploadItemIds', JSON.stringify(uploadItemIds));
      const response = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include', signal: work.signal });
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
  }, [chatUploadsRef, conversationAttachmentsRef, pendingAttachmentsRef, setIsOptimizing, setAttachmentUploadFailures, setOptimizationProgress, chatViewWorkRef, t.uploadFailed, t.chatConnError, attachmentUploadText.unknown, acceptImportedChatFiles, activeDomain, activeOrgId]);

  const uploadChatAttachments = useCallback(async (files: FileList | null) => {
    await runChatAttachmentUpload('files', Array.from(files || []));
  }, [runChatAttachmentUpload]);

  useEffect(() => {
    if (!isOpen || layout === 'creation' || mediaStudioMode) return;
    const pasteIntoCommandInput = (event: ClipboardEvent) => {
      const input = messageInputRef.current;
      const active = document.activeElement;
      if (!input || (active && active !== input && active !== document.body && active !== document.documentElement)) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) files.push(...Array.from(event.clipboardData?.items || [])
        .map(item => item.kind === 'file' ? item.getAsFile() : null)
        .filter((file): file is File => Boolean(file)));
      if (files.length) {
        event.preventDefault();
        input.focus();
        void runChatAttachmentUpload('files', files);
        return;
      }
      if (active === input) return;
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text) return;
      event.preventDefault();
      setDraftText(`${input.value || ''}${text}`);
      input.focus();
    };
    window.addEventListener('paste', pasteIntoCommandInput);
    return () => window.removeEventListener('paste', pasteIntoCommandInput);
  }, [isOpen, layout, mediaStudioMode, messageInputRef, runChatAttachmentUpload, setDraftText]);

  const uploadMediaSourceImage = useCallback(async (operation: MediaGenerationSourceOperation, slot: MediaGenerationSourceSlot, files: File[]) => {
    const file = files?.[0];
    if (!file || mediaSourceUploading || mediaSourceUploadTargetRef.current) return;
    const target = { operation, slot };
    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type) && !/\.(?:png|jpe?g|webp|gif)$/i.test(file.name)) {
      toast.error(mediaGenerationText.chooseImageFile);
      mediaSourceUploadTargetRef.current = null;
      return;
    }

    if (file.size > 20 * 1024 * 1024) { toast.error(mediaGenerationText.sourceImageTooLarge); return; }
    mediaSourceUploadTargetRef.current = target;
    setMediaSourceUploading(true);
    const work = chatViewWorkRef.current.begin();
    const formData = new FormData();
    formData.append('files', file);
    formData.append('purpose', 'media_source');
    formData.append('domain', activeDomain);
    if (activeDomain === 'work' && activeOrgId) formData.append('orgId', activeOrgId);
    try {
      const response = await apiFetch('/api/files/upload', {
        signal: work.signal,
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({}));
      if (!work.isCurrent() || mediaSourceUploadTargetRef.current !== target) return;
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || payload?.failed?.[0]?.error || t.uploadFailed || 'Upload failed');
      const uploaded = Array.isArray(payload?.files) ? payload.files[0] : null;
      const sourcePath = String(uploaded?.path || '').trim();
      if (!uploaded || !sourcePath) throw new Error(mediaGenerationText.uploadMissingPath);
      const fileName = String(uploaded.displayName || uploaded.name || file.name || 'source-image');
      const artifact: MediaGenerationArtifact = {
        id: `source-image-${String(uploaded.id || fileName)}-${Date.now()}`,
        kind: 'image',
        fileId: uploaded.id ? String(uploaded.id) : undefined,
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
  }, [activeDomain, activeOrgId, chatViewWorkRef, handleMediaSourceChange, mediaGenerationText.chooseImageFile, mediaGenerationText.sourceImageTooLarge, mediaGenerationText.sourceImageLoaded, mediaGenerationText.uploadMissingPath, mediaSourceUploadTargetRef, mediaSourceUploading, notifyKnowledgeUpdated, scopedFileUrl, setMediaSourceArtifacts, setMediaSourceUploading, t.chatConnError, t.uploadFailed]);

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
  }, [appendPendingAttachments, setShowAttachmentMenu]);

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
    return <FoundersSanctuary t={t} onBack={onClose} />;
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
  return <AgentChatView desktopModeControl={previousBindings.desktopModeControl} {...{
    isOpen, previewFile, isZh, setPreviewFile, openChatFileInSystem, layout, commandCenterView,
    resolvedAppearanceMode, prefersReducedMotion, handleChatDragOver, handleChatDragLeave, handleChatDrop,
    chatAccentTheme, fileInputRef, uploadChatAttachments, uploadMediaSourceImage,
    onReferenceArtifact, isOfficeCommandCenter, mediaStudioMode, isTyping, mediaSourceUploading, mediaVideoOptions, mediaVideoOptionsLoading, mediaGenerationStatus,
    mediaGenerationDetail, mediaGenerationArtifacts, libraryMediaArtifacts, knowledgeLoading, knowledgeFailed,
    refreshKnowledgeFiles, appendPendingAttachments, requestCloseCreativeStudio, availableMediaSourceArtifacts,
    mediaSources, mediaGenerationRetryRequest, openMediaGenerationStudio, handleMediaSourceChange,
    isWorkChat, setChatSongOpen, chatSongOpen, user, chatSongWorkbenchRef, knowledgeFiles,
    generateMediaFromStudio, checkMediaGenerationStatus, sendText, closeMediaGenerationStudio, setMediaGeneration, mediaGenerationText,
    cancelActiveChat, openMediaGenerationArtifact, markMediaGenerationArtifactReady,
    markMediaGenerationArtifactFailed, isDraggingFiles, showWeChatSettings, setShowWeChatSettings, t,
    isCommandCenterUtility, onCommandCenterViewChange, onOpenNexus, onClose, setShowVoicePicker, showVoicePicker,
    voices, selectedVoiceId, voicePickerRef, setSelectedVoiceId, callState, audioLevel, startVoiceSession,
    endVoiceSession, activeDomain, requestMeetingMode, agentName, operationModeMeta, OperationModeIcon,
    activeDomainDetail, activeDomainLabel, agentCategory, runtimeStatus, runtimeStatusLoading, runtimeStatusError,
    refreshRuntimeStatus, workflowTaskActive, workflowStatus, chatProgressStatusText, conversationHistoryOpen,
    conversationHistorySelectorExpanded, setConversationHistorySelectorExpanded,
    handleConversationHistorySelectorBlur, conversationHistory, startNewTextConversation, isCreatingConversation,
    restoringConversationId, conversationHistoryListRef, handleConversationHistoryScroll, conversationHistoryLoading,
    conversationHistoryLoadingMore, orderedConversationHistory, attachmentConversationIdRef, restoreTextConversation,
    setConversationContextMenu, conversationHistoryHasMore, toggleConversationHistory, chatPanelStyle,
    chatHeaderStyle, knowledgeStatusText, setCommandCenterPlannerOpen, commandCenterPlannerOpen,
    commandCenterPlannerText, searchQuery, setSearchQuery, setSearchResults, setSearchError, setDraftText,
    messageInputRef, scrollRef, messages, visibleSuggestions, searchError, isSearchingHistory, searchDisplayMessages,
    hiddenMessageCount, displayMessages, renderGeneratedFiles, openChatFile, handleCopyMessage, copiedId,
    chatProgressLines, chatInputPanelStyle, conversationAttachments, clearConversationAttachmentContext,
    pendingAttachments, removePendingAttachment, isOptimizing, attachmentUploadFailures, runChatAttachmentUpload,
    chatUploadsRef, setAttachmentUploadFailures, optimizationProgress, handleSendMessage, attachmentMenuRef,
    setShowAttachmentMenu, showAttachmentMenu, referenceableChatFiles, pendingAttachmentKeys, referenceChatFile,
    updateDraftText, chatInputStyle, toggleListening, isListening, conversationTransitionPending, hasDraftText,
    onOpenMemoryAvatar, onOpenKnowledge, chatFileSections, renderChatFileRow, isElectron, activeCapabilities,
    conversationContextMenu, deletingConversationId, deleteConversationFromHistory
  }} />;
}
