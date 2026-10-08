import { apiJson } from '@/services/apiClient';
import { videoGenerationOptions } from '../../../../shared/video_generation_options';
import type { MediaGenerationStudioProps } from '../../MediaGenerationStudio';
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { uiMessage } from "../../../i18n/uiMessages";
import type { MediaGenerationRequest, MediaGenerationSourceChange } from "../../MediaGenerationStudio";
import type { MediaGenerationArtifact, MediaGenerationKind } from "@/lib/mediaGenerationArtifacts";
import { normalizeStructuredMediaRequest } from "../../../../shared/media_generation";
import type { useChatRequestControls } from './use_chat_request_controls';

export function useChatMediaControls(previousBindings: ReturnType<typeof useChatRequestControls>) {
  const { refreshKnowledgeFiles, activeMediaGenerationRef, mediaStudioOpenRef, setMediaStudioMode, mediaStudioMode, mediaGenerationArtifactsRef, setMediaGenerationArtifacts, setMediaGeneration, isOpen, isOfficeCommandCenter, creationRequestId, onCreationRequestConsumed, setMediaSources, mediaSourceUploading, mediaSourceUploadTargetRef, isTyping, mediaGenerationText, mediaGenerationArtifactValidationRef, setMediaGenerationRetryRequest, isZh, sendText, setMediaSourceUploading, setChatSongOpen, chatSongWorkbenchRef, openChatFile, chatRequestLedgerRef, socket, chatViewWorkRef, setWorkflowStatus, pushChatProgress, chatTurnTimerGuardRef, chatExecutionSource, activeDomain, activeOrgId, attachmentConversationIdRef, prefillMessage, setMessages, agentName, prefillSource, onPrefillConsumed, draftTextRef, pendingAttachments, pendingAttachmentsRef, isListening, inputDictationActiveRef, localVoiceSession, setIsListening, recognition, isElectron, callState, selectedVoiceId, agentId, t, voiceSession } = previousBindings;


  const [mediaVideoOptions, setMediaVideoOptions] = useState<MediaGenerationStudioProps['videoOptions']>();
  const [mediaVideoOptionsLoading, setMediaVideoOptionsLoading] = useState(false);
  useEffect(() => {
    if (!isOpen || mediaStudioMode !== 'video') return;
    const controller = new AbortController();
    setMediaVideoOptions(undefined);
    setMediaVideoOptionsLoading(true);
    void apiJson<any>('/api/preferences/generation', { signal: controller.signal }).then(preferences => {
      if (!controller.signal.aborted) setMediaVideoOptions({ text_to_video: videoGenerationOptions(preferences.video), image_to_video: videoGenerationOptions(preferences.imageToVideo) });
    }).catch(error => {
      if (!controller.signal.aborted) setMediaGeneration({ status: 'error', detail: error.message });
    }).finally(() => { if (!controller.signal.aborted) setMediaVideoOptionsLoading(false); });
    return () => controller.abort();
  }, [activeDomain, activeOrgId, isOpen, mediaStudioMode, setMediaGeneration]);

  const isCreationLocked = useCallback(() => {
    const ledger = chatRequestLedgerRef.current;
    const mediaRequestId = activeMediaGenerationRef.current?.requestId;
    const ownMediaTask = mediaRequestId && ledger.has(mediaRequestId) ? 1 : 0;
    return ledger.size > ownMediaTask || (isTyping && !mediaRequestId);
  }, [activeMediaGenerationRef, chatRequestLedgerRef, isTyping]);

  const openMediaGenerationStudio = useCallback((mode: MediaGenerationKind) => {
    if (isCreationLocked()) return;
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
  }, [activeMediaGenerationRef, mediaGenerationArtifactsRef, mediaStudioOpenRef, refreshKnowledgeFiles, setMediaGeneration, setMediaGenerationArtifacts, setMediaStudioMode, isCreationLocked]);

  const creationLocked = isCreationLocked();
  const consumedCreationRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (creationLocked || !isOpen || !isOfficeCommandCenter || !creationRequestId || consumedCreationRequestRef.current === creationRequestId) return;
    consumedCreationRequestRef.current = creationRequestId;
    openMediaGenerationStudio('image');
    onCreationRequestConsumed?.(creationRequestId);
  }, [creationLocked, creationRequestId, isOfficeCommandCenter, isOpen, onCreationRequestConsumed, openMediaGenerationStudio]);

  const handleMediaSourceChange = useCallback((change: MediaGenerationSourceChange) => {
    const artifactId = change.value.trim() ? change.artifact?.id || '' : '';
    setMediaSources(current => {
      if (change.operation === 'image_to_video') return { ...current, referenceImage: change.value, referenceArtifactId: artifactId };
      if (change.slot === 'primary') return { ...current, primaryImage: change.value, primaryArtifactId: artifactId };
      return { ...current, referenceImages: change.value.trim() ? [change.value] : [], referenceArtifactIds: artifactId ? [artifactId] : [] };
    });
  }, [setMediaSources]);

  const generateMediaFromStudio = useCallback((request: MediaGenerationRequest) => {
    if (isCreationLocked() || activeMediaGenerationRef.current) {
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
  }, [activeMediaGenerationRef, isCreationLocked, isZh, mediaGenerationArtifactValidationRef, mediaGenerationArtifactsRef, mediaGenerationText.animateImage, mediaGenerationText.anotherTaskRunning, mediaGenerationText.editImage, mediaGenerationText.generateImage, mediaGenerationText.generateVideo, mediaGenerationText.requestNotCreated, mediaGenerationText.settingsMismatch, sendText, setMediaGeneration, setMediaGenerationArtifacts, setMediaGenerationRetryRequest]);

  const closeMediaGenerationStudio = useCallback(() => {
    mediaStudioOpenRef.current = false;
    mediaSourceUploadTargetRef.current = null;
    setMediaSourceUploading(false);
    setChatSongOpen(false);
    setMediaStudioMode(null);
  }, [mediaSourceUploadTargetRef, mediaStudioOpenRef, setChatSongOpen, setMediaSourceUploading, setMediaStudioMode]);

  const requestCloseCreativeStudio = useCallback(async () => {
    const workbench = chatSongWorkbenchRef.current;
    if (workbench && !await workbench.prepareToLeave()) {
      setChatSongOpen(true);
      return;
    }
    closeMediaGenerationStudio();
  }, [chatSongWorkbenchRef, closeMediaGenerationStudio, setChatSongOpen]);

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
  }, [mediaGenerationArtifactValidationRef, setMediaGeneration]);

  const markMediaGenerationArtifactFailed = useCallback((artifact: MediaGenerationArtifact) => {
    const validation = mediaGenerationArtifactValidationRef.current;
    if (!validation?.expectedIds.has(artifact.id)) return;
    validation.readyIds.delete(artifact.id);
    validation.failedIds.add(artifact.id);
    const remainingPossible = validation.expectedIds.size - validation.failedIds.size;
    if (!validation.contractValid || remainingPossible < validation.requiredCount) {
      setMediaGeneration({ status: 'error', detail: mediaGenerationText.artifactLoadFailed });
    }
  }, [mediaGenerationArtifactValidationRef, mediaGenerationText.artifactLoadFailed, setMediaGeneration]);

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
  }, [draftTextRef, isOpen, pendingAttachmentsRef, sendText]);

  const startVoiceSession = () => {
    const conversationId = attachmentConversationIdRef.current || undefined;
    if (voiceSession) voiceSession.onStart(conversationId);
    else void localVoiceSession.startCall(selectedVoiceId, 'lumi', agentId, {
      domain: activeDomain, orgId: activeOrgId, conversationId,
    });
  };

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
          conversationId: attachmentConversationIdRef.current || undefined,
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
  return {
    ...previousBindings, creationLocked, mediaVideoOptions, mediaVideoOptionsLoading, handleMediaSourceChange, requestCloseCreativeStudio, openMediaGenerationStudio, generateMediaFromStudio,
    closeMediaGenerationStudio, cancelActiveChat, openMediaGenerationArtifact, markMediaGenerationArtifactReady, markMediaGenerationArtifactFailed,
    handleSendMessage, toggleListening, startVoiceSession
  } as const;
}
