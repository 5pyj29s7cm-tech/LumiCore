import type { MergeChatAttachmentsResult, ChatAttachmentReference } from "@/lib/chatAttachmentReferences";
import { type GeneratedFileLink, type ChatAttachment, type ConversationHistoryItem, type ConversationHistoryContextMenu, type WorkflowStatus, type ChatFilePanelItem, type ChatSendOptions } from "./contracts";
import { getCustomerDisplayText } from "./history";
import { extractGeneratedFiles } from "./media_artifacts";
import { CHAT_LIGHT_THEME, CHAT_NEUTRAL_THEME } from "./appearance";
import { useConversationAttachments } from "../../hooks/useConversationAttachments";
import React from 'react';
import type { ChatSongWorkbenchHandle } from "../ChatSongWorkbench";

import { ChatAttachmentUploads, type ChatUploadFailure, type ChatUploadKind, type ChatUploadSource } from '@/lib/chatAttachmentUploads';
import { ChatAttachmentUploadStatus } from "../ChatAttachmentUploadStatus";

import { FileResourceImage, FileResourceVideo } from "../FileResourceMedia";

import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, ArrowLeft, Ghost, Castle, Zap, Cpu, Sparkles, FileText, Mic, CheckCircle2, Square, ChevronDown, ChevronRight, XCircle, Copy, Check, Paperclip, Image as ImageIcon, MessageCircle, Briefcase, User, FolderOpen, Upload, Plus, History, CalendarClock, Trash2 } from 'lucide-react';
import { ChatFilePreview, type ChatPreviewFile } from "../ChatFilePreview";
import { ChatMessageMarkdown } from "../ChatMessageMarkdown";
import { type ChatArtifact } from "../../../shared/chat_artifacts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { GlassCard } from "../SharedUI";

import { VoiceCallButton } from "../VoiceCallButton";

import { useVoiceCall } from '@/hooks/useVoiceCall';

import { type ChatProgressLine } from '@/lib/chatProgress';

import { TaskCompletionFeedbackDetails } from "../TaskCompletionFeedbackDetails";
import { WeChatSettings } from "../WeChatSettings";
import type { FileEntry } from "../MemoryTree";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";

import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentIdentity, createChatAttachmentReference } from '@/lib/chatAttachmentReferences';

import { CommandCenterPanel } from "../CommandCenterPanel";
import type { CommandCenterView } from "../commandCenterTypes";
import { ActiveTaskWidget } from "../ActiveTaskWidget";
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { CommandCenterPlanner } from "../CommandCenterPlanner";
import { commandCenterPlannerCopy } from '@/i18n/locales/commandCenterPlanner';
import { mediaGenerationCopy } from '@/i18n/locales/mediaGeneration';
import { MediaGenerationStudio, type MediaGenerationRequest, type MediaGenerationSourceChange, type MediaGenerationSourceSlot, type MediaGenerationStudioStatus } from "../MediaGenerationStudio";
import { extractMediaGenerationArtifacts, type MediaGenerationArtifact, type MediaGenerationKind, type MediaGenerationSourceOperation } from '@/lib/mediaGenerationArtifacts';

const ChatSongWorkbench = React.lazy(() => import('../ChatSongWorkbench'));
type AgentChatViewInput = {
isOpen: boolean;
previewFile: ChatPreviewFile;
isZh: boolean;
setPreviewFile: React.Dispatch<React.SetStateAction<ChatPreviewFile>>;
openChatFileInSystem: (file: Pick<ChatFilePanelItem, "fileName" | "fileId" | "path" | "openUrl" | "saveUrl">) => Promise<void>;
layout: "standalone" | "command-center";
commandCenterView: CommandCenterView;
resolvedAppearanceMode: "light" | "dark";
prefersReducedMotion: boolean;
handleChatDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
handleChatDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
handleChatDrop: (event: React.DragEvent<HTMLDivElement>) => void;
chatAccentTheme: typeof CHAT_LIGHT_THEME | typeof CHAT_NEUTRAL_THEME;
fileInputRef: React.RefObject<HTMLInputElement>;
uploadChatAttachments: (files: FileList | null) => Promise<void>;
mediaSourceFileInputRef: React.RefObject<HTMLInputElement>;
uploadMediaSourceImage: (files: FileList | null) => Promise<void>;
isOfficeCommandCenter: boolean;
mediaStudioMode: MediaGenerationKind;
isTyping: boolean;
mediaSourceUploading: boolean;
mediaGenerationStatus: MediaGenerationStudioStatus;
mediaGenerationDetail: string;
mediaGenerationArtifacts: MediaGenerationArtifact[];
libraryMediaArtifacts: MediaGenerationArtifact[];
knowledgeLoading: boolean;
knowledgeFailed: boolean;
refreshKnowledgeFiles: () => Promise<void>;
appendPendingAttachments: (incoming: ChatAttachment[], options?: { announce?: boolean; }) => MergeChatAttachmentsResult;
requestCloseCreativeStudio: () => Promise<void>;
availableMediaSourceArtifacts: MediaGenerationArtifact[];
mediaSources: Required<Pick<MediaGenerationRequest, "primaryImage" | "referenceImages" | "referenceImage" | "primaryArtifactId" | "referenceArtifactIds" | "referenceArtifactId">>;
mediaGenerationRetryRequest: MediaGenerationRequest;
openMediaGenerationStudio: (mode: MediaGenerationKind) => void;
handleMediaSourceChange: (change: MediaGenerationSourceChange) => void;
requestMediaSourceImage: (operation: MediaGenerationSourceOperation, slot: MediaGenerationSourceSlot) => void;
isWorkChat: boolean;
setChatSongOpen: React.Dispatch<React.SetStateAction<boolean>>;
chatSongOpen: boolean;
user: any;
chatSongWorkbenchRef: React.RefObject<ChatSongWorkbenchHandle>;
knowledgeFiles: FileEntry[];
generateMediaFromStudio: (request: MediaGenerationRequest) => void;
sendText: (text: string, attachments?: ChatAttachment[], options?: ChatSendOptions) => Promise<string>;
closeMediaGenerationStudio: () => void;
setMediaGeneration: React.Dispatch<React.SetStateAction<{ status: MediaGenerationStudioStatus; detail: string; }>>;
mediaGenerationText: ReturnType<typeof mediaGenerationCopy>;
cancelActiveChat: () => void;
openMediaGenerationArtifact: (artifact: MediaGenerationArtifact) => void;
markMediaGenerationArtifactReady: (artifact: MediaGenerationArtifact) => void;
markMediaGenerationArtifactFailed: (artifact: MediaGenerationArtifact) => void;
isDraggingFiles: boolean;
showWeChatSettings: boolean;
setShowWeChatSettings: React.Dispatch<React.SetStateAction<boolean>>;
t: any;
isCommandCenterUtility: boolean;
onCommandCenterViewChange: (view: CommandCenterView) => void;
onOpenNexus: () => void;
onClose: () => void;
setShowVoicePicker: React.Dispatch<React.SetStateAction<boolean>>;
showVoicePicker: boolean;
voices: any[];
selectedVoiceId: string;
voicePickerRef: React.RefObject<HTMLDivElement>;
setSelectedVoiceId: (id: string, provider?: string) => void;
callState: ReturnType<typeof useVoiceCall>["callState"];
audioLevel: number;
startVoiceSession: () => void;
endVoiceSession: () => void;
activeDomain: "personal" | "work";
requestMeetingMode: () => void;
agentName: any;
operationModeMeta: {label: React.ReactNode; detail: string; badgeClass: string; subtleClass: string; dotClass: string; Icon: typeof Sparkles};
OperationModeIcon: typeof Sparkles;
activeDomainDetail: string;
activeDomainLabel: string;
agentCategory: any;
runtimeStatus: ReturnType<typeof useRuntimeStatus>["status"];
runtimeStatusLoading: boolean;
runtimeStatusError: string;
refreshRuntimeStatus: () => Promise<void>;
workflowTaskActive: boolean;
workflowStatus: WorkflowStatus;
chatProgressStatusText: any;
conversationHistoryOpen: boolean;
conversationHistorySelectorExpanded: boolean;
setConversationHistorySelectorExpanded: React.Dispatch<React.SetStateAction<boolean>>;
handleConversationHistorySelectorBlur: (event: React.FocusEvent<HTMLElement>) => void;
conversationHistory: ConversationHistoryItem[];
startNewTextConversation: () => Promise<void>;
isCreatingConversation: boolean;
restoringConversationId: string;
conversationHistoryListRef: React.RefObject<HTMLDivElement>;
handleConversationHistoryScroll: (event: React.UIEvent<HTMLDivElement>) => void;
conversationHistoryLoading: boolean;
conversationHistoryLoadingMore: boolean;
orderedConversationHistory: ConversationHistoryItem[];
attachmentConversationIdRef: React.RefObject<string>;
restoreTextConversation: (conversationId: string) => Promise<void>;
setConversationContextMenu: React.Dispatch<React.SetStateAction<ConversationHistoryContextMenu>>;
conversationHistoryHasMore: boolean;
toggleConversationHistory: () => void;
chatPanelStyle: React.CSSProperties;
chatHeaderStyle: React.CSSProperties;
knowledgeStatusText: string;
setCommandCenterPlannerOpen: React.Dispatch<React.SetStateAction<boolean>>;
commandCenterPlannerOpen: boolean;
commandCenterPlannerText: ReturnType<typeof commandCenterPlannerCopy>;
searchQuery: string;
setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
setSearchResults: React.Dispatch<React.SetStateAction<any[]>>;
setSearchError: React.Dispatch<React.SetStateAction<string>>;
setDraftText: (value: string) => void;
messageInputRef: React.RefObject<HTMLInputElement>;
scrollRef: React.RefObject<HTMLDivElement>;
messages: any[];
visibleSuggestions: { id: string; label: any; prompt: string; show: boolean; }[];
searchError: string;
isSearchingHistory: boolean;
searchDisplayMessages: any[];
hiddenMessageCount: number;
displayMessages: any[];
renderGeneratedFiles: (files: GeneratedFileLink[], align?: "start" | "end") => React.JSX.Element;
openChatFile: (file: Pick<ChatFilePanelItem, "fileName" | "fileId" | "path" | "openUrl" | "saveUrl">) => Promise<void>;
handleCopyMessage: (text: string, id: string, container?: HTMLElement | null) => Promise<void>;
copiedId: string;
chatProgressLines: ChatProgressLine[];
chatInputPanelStyle: React.CSSProperties;
conversationAttachments: ReturnType<typeof useConversationAttachments>["conversationAttachments"];
clearConversationAttachmentContext: () => void;
pendingAttachments: ChatAttachmentReference[];
removePendingAttachment: (id: string) => void;
isOptimizing: boolean;
attachmentUploadFailures: ChatUploadFailure[];
runChatAttachmentUpload: (kind: ChatUploadKind, sources: ChatUploadSource[], retry?: boolean) => Promise<void>;
chatUploadsRef: React.RefObject<ChatAttachmentUploads>;
setAttachmentUploadFailures: React.Dispatch<React.SetStateAction<ChatUploadFailure[]>>;
optimizationProgress: number;
handleSendMessage: (e: React.FormEvent) => void;
attachmentMenuRef: React.RefObject<HTMLDivElement>;
setShowAttachmentMenu: React.Dispatch<React.SetStateAction<boolean>>;
showAttachmentMenu: boolean;
referenceableChatFiles: ChatFilePanelItem[];
pendingAttachmentKeys: Set<string>;
referenceChatFile: (item: ChatFilePanelItem) => void;
updateDraftText: (value: string) => void;
chatInputStyle: React.CSSProperties;
toggleListening: () => void;
isListening: boolean;
conversationTransitionPending: boolean;
hasDraftText: boolean;
onOpenMemoryAvatar: () => void;
onOpenKnowledge: () => void;
chatFileSections: { pending: ChatFilePanelItem[]; generated: ChatFilePanelItem[]; knowledge: ChatFilePanelItem[]; };
renderChatFileRow: (item: ChatFilePanelItem) => React.JSX.Element;
isElectron: boolean;
activeCapabilities: any[];
conversationContextMenu: ConversationHistoryContextMenu;
deletingConversationId: string;
deleteConversationFromHistory: (conversationId: string) => Promise<void>;
};
export function AgentChatView({ isOpen, previewFile, isZh, setPreviewFile, openChatFileInSystem, layout, commandCenterView, resolvedAppearanceMode, prefersReducedMotion, handleChatDragOver, handleChatDragLeave, handleChatDrop, chatAccentTheme, fileInputRef, uploadChatAttachments, mediaSourceFileInputRef, uploadMediaSourceImage, isOfficeCommandCenter, mediaStudioMode, isTyping, mediaSourceUploading, mediaGenerationStatus, mediaGenerationDetail, mediaGenerationArtifacts, libraryMediaArtifacts, knowledgeLoading, knowledgeFailed, refreshKnowledgeFiles, appendPendingAttachments, requestCloseCreativeStudio, availableMediaSourceArtifacts, mediaSources, mediaGenerationRetryRequest, openMediaGenerationStudio, handleMediaSourceChange, requestMediaSourceImage, isWorkChat, setChatSongOpen, chatSongOpen, user, chatSongWorkbenchRef, knowledgeFiles, generateMediaFromStudio, sendText, closeMediaGenerationStudio, setMediaGeneration, mediaGenerationText, cancelActiveChat, openMediaGenerationArtifact, markMediaGenerationArtifactReady, markMediaGenerationArtifactFailed, isDraggingFiles, showWeChatSettings, setShowWeChatSettings, t, isCommandCenterUtility, onCommandCenterViewChange, onOpenNexus, onClose, setShowVoicePicker, showVoicePicker, voices, selectedVoiceId, voicePickerRef, setSelectedVoiceId, callState, audioLevel, startVoiceSession, endVoiceSession, activeDomain, requestMeetingMode, agentName, operationModeMeta, OperationModeIcon, activeDomainDetail, activeDomainLabel, agentCategory, runtimeStatus, runtimeStatusLoading, runtimeStatusError, refreshRuntimeStatus, workflowTaskActive, workflowStatus, chatProgressStatusText, conversationHistoryOpen, conversationHistorySelectorExpanded, setConversationHistorySelectorExpanded, handleConversationHistorySelectorBlur, conversationHistory, startNewTextConversation, isCreatingConversation, restoringConversationId, conversationHistoryListRef, handleConversationHistoryScroll, conversationHistoryLoading, conversationHistoryLoadingMore, orderedConversationHistory, attachmentConversationIdRef, restoreTextConversation, setConversationContextMenu, conversationHistoryHasMore, toggleConversationHistory, chatPanelStyle, chatHeaderStyle, knowledgeStatusText, setCommandCenterPlannerOpen, commandCenterPlannerOpen, commandCenterPlannerText, searchQuery, setSearchQuery, setSearchResults, setSearchError, setDraftText, messageInputRef, scrollRef, messages, visibleSuggestions, searchError, isSearchingHistory, searchDisplayMessages, hiddenMessageCount, displayMessages, renderGeneratedFiles, openChatFile, handleCopyMessage, copiedId, chatProgressLines, chatInputPanelStyle, conversationAttachments, clearConversationAttachmentContext, pendingAttachments, removePendingAttachment, isOptimizing, attachmentUploadFailures, runChatAttachmentUpload, chatUploadsRef, setAttachmentUploadFailures, optimizationProgress, handleSendMessage, attachmentMenuRef, setShowAttachmentMenu, showAttachmentMenu, referenceableChatFiles, pendingAttachmentKeys, referenceChatFile, updateDraftText, chatInputStyle, toggleListening, isListening, conversationTransitionPending, hasDraftText, onOpenMemoryAvatar, onOpenKnowledge, chatFileSections, renderChatFileRow, isElectron, activeCapabilities, conversationContextMenu, deletingConversationId, deleteConversationFromHistory }: AgentChatViewInput) {

  return (
    <AnimatePresence>
      {isOpen && previewFile && <ChatFilePreview key={previewFile.url} file={previewFile} isZh={isZh}
        onClose={() => setPreviewFile(null)}
        onOpenSystem={() => openChatFileInSystem({ fileName: previewFile.fileName, path: previewFile.path, openUrl: previewFile.url, saveUrl: previewFile.url })} />}
      {isOpen && (
        <motion.div
          data-lumi-rendered-surface={layout === 'command-center' ? 'command-center' : 'chat'}
          data-lumi-command-center-view={layout === 'command-center' ? commandCenterView : undefined}
          data-command-center-appearance={layout === 'command-center' ? resolvedAppearanceMode : undefined}
          initial={prefersReducedMotion ? false : layout === 'command-center'
            ? { opacity: 0, scale: 0.94, x: '-2.5%' }
            : { opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1, x: 0 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.99 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.28, ease: [0.25, 0.1, 0.25, 1] }}
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
            '--lumi-chat-background': chatAccentTheme.background,
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
      <input
        type="file"
        ref={mediaSourceFileInputRef}
        className="hidden"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff"
        onChange={(event) => {
          void uploadMediaSourceImage(event.target.files);
          event.target.value = '';
        }}
      />
      <AnimatePresence>
        {isOfficeCommandCenter && mediaStudioMode && (
          <motion.div
            data-media-generation-studio
            initial={prefersReducedMotion ? false : { opacity: 0, x: '3%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: '3%' }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute inset-0 z-[214]"
          >
            <MediaGenerationStudio
              mode={mediaStudioMode}
              locale={isZh ? 'zh' : 'en'}
              busy={isTyping || mediaSourceUploading || mediaGenerationStatus === 'submitting' || mediaGenerationStatus === 'generating' || mediaGenerationStatus === 'cancelling'}
              status={mediaGenerationStatus}
              statusDetail={mediaGenerationDetail}
              artifacts={mediaGenerationArtifacts.filter(artifact => artifact.kind === mediaStudioMode)}
              libraryArtifacts={libraryMediaArtifacts}
              libraryLoading={knowledgeLoading}
              libraryFailed={knowledgeFailed}
              onRefreshLibrary={refreshKnowledgeFiles}
              onReferenceArtifact={artifact => {
                const result = appendPendingAttachments([createChatAttachmentReference({
                  fileId: artifact.fileId, fileName: artifact.fileName, path: artifact.path,
                  kind: artifact.kind === 'image' ? 'image' : 'file', openUrl: artifact.url,
                })]);
                if (result.added.length) void requestCloseCreativeStudio();
              }}
              sourceArtifacts={availableMediaSourceArtifacts}
              {...mediaSources}
              retryRequest={mediaGenerationRetryRequest}
              onModeChange={openMediaGenerationStudio}
              onSourceChange={handleMediaSourceChange}
              onRequestSourceImage={requestMediaSourceImage}
              onClose={() => { void requestCloseCreativeStudio(); }}
              onOpenChatSong={!isWorkChat ? () => { void refreshKnowledgeFiles(); setChatSongOpen(true); } : undefined}
              chatSongActive={chatSongOpen && !isWorkChat}
              onSelectMedia={mode => { setChatSongOpen(false); openMediaGenerationStudio(mode); }}
              chatSongContent={!isWorkChat && <React.Suspense fallback={<div role="status" className="m-auto text-white/50"><Loader2 className="animate-spin" /></div>}>
                <ChatSongWorkbench
                  key={user?.uid}
                  ref={chatSongWorkbenchRef}
                  embedded
                  locale={isZh ? 'zh' : 'en'}
                  files={knowledgeFiles}
                  libraryFailed={knowledgeFailed}
                  busy={isTyping || mediaGenerationStatus === 'submitting' || mediaGenerationStatus === 'generating' || mediaGenerationStatus === 'cancelling'}
                  onRefreshLibrary={refreshKnowledgeFiles}
                  onClose={() => setChatSongOpen(false)}
                  onGenerate={request => {
                    setChatSongOpen(false);
                    openMediaGenerationStudio(request.mode);
                    generateMediaFromStudio(request);
                  }}
                  onTask={async prompt => {
                    const requestId = await sendText(prompt, [], { includeConversationAttachments: false });
                    if (requestId) closeMediaGenerationStudio();
                    return requestId;
                  }}
                />
              </React.Suspense>}
              onGenerate={generateMediaFromStudio}
              onCancel={() => {
                setMediaGeneration({ status: 'cancelling', detail: mediaGenerationText.statusCancelling });
                cancelActiveChat();
              }}
              onRetry={generateMediaFromStudio}
              onOpenArtifact={openMediaGenerationArtifact}
              onContinueEdit={() => {
                setMediaGeneration({ status: 'idle', detail: '' });
              }}
              onUseAsVideoReference={() => {
                setMediaGeneration({ status: 'idle', detail: '' });
              }}
              onArtifactReady={markMediaGenerationArtifactReady}
              onArtifactError={markMediaGenerationArtifactFailed}
            />
          </motion.div>
        )}
      </AnimatePresence>
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

      {!isCommandCenterUtility && !isOfficeCommandCenter && (
      <div className={`lumi-chat-toolbar relative z-[55] flex flex-shrink-0 items-center justify-between ${
        isOfficeCommandCenter
          ? 'h-14 border-b border-white/[0.07] bg-[#03070d]/92 px-4 shadow-[0_1px_0_rgba(255,255,255,0.025)]'
          : 'px-4 pt-6 md:px-0'
      }`}>
        <div className="flex shrink-0 items-center gap-2">
        {!isOfficeCommandCenter && <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
          aria-label={t.back || uiMessage('org-portal.back.5db5cac55e', isZh ? 'zh' : 'en')}
        >
          <ArrowLeft size={18} />
        </button>}
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
                        setSelectedVoiceId(v.voiceId, v.provider);
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
            onStart={startVoiceSession}
            onEnd={endVoiceSession}
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
        isOfficeCommandCenter ? 'lumi-command-center-workspace lumi-command-center-layered overflow-hidden' : 'gap-3'
      }`}>

        {isOfficeCommandCenter && (
          <motion.section
            data-command-center-cosmos-stage
            data-wallpaper-tool="command-core"
            initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.82, x: '-7%' }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.48, ease: [0.2, 0.75, 0.2, 1] }}
            className="lumi-command-center-office lumi-command-center-cosmos-stage relative min-h-0 min-w-0 flex-1 overflow-hidden lumi-command-center-office--orbital"
          >
            <div className="absolute inset-0">
              <CommandCenterPanel
                t={t}
                view="office"
                backgroundOnly
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
            <div className="lumi-command-center-background-task-widget" aria-hidden="true">
              <ActiveTaskWidget
                status={runtimeStatus}
                workflowActive={workflowTaskActive}
                workflowStatus={workflowStatus}
                progressText={chatProgressStatusText}
                isZh={isZh}
              />
            </div>
          </motion.section>
        )}

        {/* Chat Panel and the command-center destination rail. */}
        <div data-wallpaper-tool={isOfficeCommandCenter ? 'command-workspace' : undefined} className={isOfficeCommandCenter ? 'lumi-command-center-conversation-layout relative z-20 flex min-h-0 w-full flex-1' : 'contents'}>
        {isOfficeCommandCenter && conversationHistoryOpen && (
          <aside
            data-command-center-history-rail
            data-wallpaper-tool="command-history"
            data-command-center-history-selector
            data-command-center-history-selector-expanded={conversationHistorySelectorExpanded ? 'true' : 'false'}
            onMouseEnter={() => setConversationHistorySelectorExpanded(true)}
            onMouseLeave={() => setConversationHistorySelectorExpanded(false)}
            onFocusCapture={() => setConversationHistorySelectorExpanded(true)}
            onBlurCapture={handleConversationHistorySelectorBlur}
            className={`lumi-command-center-history-rail relative z-30 flex min-h-0 shrink-0 flex-col ${conversationHistorySelectorExpanded ? 'lumi-command-center-history-rail--expanded' : ''}`}
            aria-label={t.previousConversations || 'Conversation history'}
            aria-expanded={conversationHistorySelectorExpanded}
          >
            <div className="lumi-command-center-history-rail-header flex shrink-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <History size={14} className="shrink-0 text-cyan-200/75" />
                <span className="lumi-command-center-history-selector-mark" aria-hidden="true"><span /><span /><span /></span>
                <span className="truncate text-[11px] font-black uppercase tracking-[0.14em] text-white/65">
                  {t.previousConversations || 'Conversation history'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className="font-mono text-[9px] text-white/28" aria-live="polite">{conversationHistory.length}</span>
                <button
                  type="button"
                  data-command-center-new-conversation
                  onClick={() => void startNewTextConversation()}
                  disabled={isCreatingConversation || Boolean(restoringConversationId)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-white/38 transition-colors hover:border-cyan-300/25 hover:bg-cyan-300/[0.08] hover:text-cyan-100 disabled:cursor-wait disabled:opacity-50"
                  title={t.newConversationHint || t.newConversation || 'New conversation'}
                  aria-label={t.newConversation || 'New conversation'}
                >
                  {isCreatingConversation ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
                </button>
              </div>
            </div>
            <div
              ref={conversationHistoryListRef}
              onScroll={handleConversationHistoryScroll}
              className="lumi-command-center-history-list custom-scrollbar min-h-0 flex-1 overflow-y-auto"
              aria-busy={conversationHistoryLoading || conversationHistoryLoadingMore}
            >
              {conversationHistoryLoading && conversationHistory.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-white/35"><Loader2 size={16} className="animate-spin" /></div>
              ) : conversationHistory.length === 0 ? (
                <div className="px-2 py-8 text-center text-[11px] text-white/35">{t.noConversations || 'No conversations yet'}</div>
              ) : (
                <>
                  {orderedConversationHistory.map(conversation => {
                    const current = conversation.id === attachmentConversationIdRef.current;
                    const title = conversation.displayTitle || conversation.title || conversation.preview || t.untitled || 'Untitled';
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        aria-haspopup="menu"
                        onClick={() => void restoreTextConversation(conversation.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setConversationContextMenu({
                            conversationId: conversation.id,
                            x: Math.min(event.clientX, Math.max(12, window.innerWidth - 236)),
                            y: Math.min(event.clientY, Math.max(12, window.innerHeight - 86)),
                          });
                        }}
                        disabled={Boolean(restoringConversationId) || isCreatingConversation}
                        data-command-center-history-item
                        className={`lumi-command-center-history-item group mb-1 w-full rounded-xl px-3 py-2.5 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${
                          current ? 'lumi-command-center-history-item--current bg-cyan-300/[0.10]' : 'hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="lumi-command-center-history-item-marker" aria-hidden="true"><span /></span>
                            <span className="lumi-command-center-history-item-title min-w-0 truncate text-[11px] font-semibold text-white/75">{title}</span>
                          </span>
                          {restoringConversationId === conversation.id ? (
                            <Loader2 size={11} className="shrink-0 animate-spin text-cyan-200" />
                          ) : current ? (
                            <span className="lumi-command-center-history-current-badge shrink-0 rounded-full bg-cyan-300/[0.12] px-1.5 py-0.5 text-[8px] font-bold text-cyan-100/75">{t.currentConversation || 'Current'}</span>
                          ) : null}
                        </div>
                        {conversation.preview && <div className="lumi-command-center-history-item-preview mt-1 truncate text-[10px] text-white/34">{conversation.preview}</div>}
                        <div className="lumi-command-center-history-item-meta mt-1.5 flex items-center justify-between text-[9px] text-white/24">
                          <span>{conversation.messageCount || 0} {t.messageCountLabel || 'messages'}</span>
                          <span>{new Date(conversation.lastActiveAt || conversation.createdAt).toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </button>
                    );
                  })}
                  {conversationHistoryLoadingMore && (
                    <div className="flex items-center justify-center gap-2 py-3 text-[10px] text-cyan-100/45">
                      <Loader2 size={13} className="animate-spin" />
                      <span>{t.loading || 'Loading more'}</span>
                    </div>
                  )}
                  {!conversationHistoryHasMore && (
                    <div className="px-2 py-3 text-center text-[9px] uppercase tracking-[0.14em] text-white/22">
                      {t.allConversationsLoaded || 'All conversations loaded'}
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
        {isOfficeCommandCenter && !conversationHistoryOpen && (
          <aside
            data-command-center-history-rail-collapsed
            className="lumi-command-center-history-rail-collapsed relative z-30 flex shrink-0 items-start justify-center"
            aria-label={t.selectPreviousConversation || 'Show conversation history'}
          >
            <button
              type="button"
              data-command-center-history-toggle
              onClick={toggleConversationHistory}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/[0.06] text-cyan-100/70 transition-colors hover:border-cyan-200/40 hover:bg-cyan-300/[0.12] hover:text-cyan-50"
              title={t.selectPreviousConversation || 'Show conversation history'}
              aria-label={t.selectPreviousConversation || 'Show conversation history'}
            >
              <History size={15} />
            </button>
          </aside>
        )}
        <motion.div
          data-wallpaper-tool={isOfficeCommandCenter ? 'command-dialogue' : undefined}
          data-command-center-chat-rail={isOfficeCommandCenter ? 'true' : undefined}
          initial={isOfficeCommandCenter && !prefersReducedMotion ? { opacity: 0, x: '100%' } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.46, ease: [0.2, 0.75, 0.2, 1], delay: isOfficeCommandCenter && !prefersReducedMotion ? 0.08 : 0 }}
          className={`lumi-chat-panel flex min-h-0 min-w-0 flex-col overflow-hidden ${
            isOfficeCommandCenter
              ? 'lumi-command-center-chat-rail lumi-command-center-chat-rail--entering relative z-20 min-w-0 flex-1 border-0 bg-transparent'
              : 'glass flex-1 rounded-[2.5rem] border shadow-2xl md:rounded-[3rem]'
          }`}
          style={isOfficeCommandCenter
            ? { ...chatPanelStyle, background: 'transparent', boxShadow: 'none', borderColor: 'transparent' }
            : chatPanelStyle}
        >
          <div
            className={`lumi-chat-panel-header flex items-center justify-between ${isOfficeCommandCenter ? 'border-0 bg-transparent px-5 py-3.5' : 'border-b p-4 md:p-6'}`}
            style={isOfficeCommandCenter
              ? { ...chatHeaderStyle, background: 'transparent', borderBottomColor: 'transparent' }
              : chatHeaderStyle}
          >
            <div className="flex min-w-0 items-center gap-3">
              {isOfficeCommandCenter && (
                <div
                  data-command-center-integrated-identity
                  className="flex min-w-0 items-center gap-2.5"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/15 text-celestial-saturn">
                    <Ghost className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="max-w-[24vw] truncate text-sm font-bold tracking-tight text-white/90">{agentName}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${operationModeMeta.badgeClass}`}>
                        {operationModeMeta.label}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[9px] font-bold uppercase tracking-[0.14em] text-white/38">
                      {agentCategory} · {activeDomainLabel}
                    </div>
                  </div>
                </div>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-celestial-saturn animate-pulse" />
                <span className="text-xs font-bold uppercase tracking-widest text-white/60">
                  Neural Link
                </span>
              </div>
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
            <div className="lumi-chat-history-search relative flex items-center gap-2">
              {isOfficeCommandCenter && (
                <VoiceCallButton
                  callState={callState}
                  audioLevel={audioLevel}
                  onStart={startVoiceSession}
                  onEnd={endVoiceSession}
                  hasVoice={voices.length > 0}
                  className="lumi-command-center-integrated-voice scale-[0.72] origin-right"
                />
              )}
              {isOfficeCommandCenter && activeDomain === 'personal' && (
                <button
                  type="button"
                  onClick={() => setShowWeChatSettings(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-200 transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15 md:h-9 md:w-9"
                  title={uiMessage('agent-chat-page.personal-wechat.153d58f0e9')}
                  aria-label={uiMessage('agent-chat-page.open-personal-wechat-connection.24ff73324a')}
                >
                  <MessageCircle className="h-4 w-4" />
                </button>
              )}
              {isOfficeCommandCenter && (
                <button
                  type="button"
                  onClick={() => setCommandCenterPlannerOpen(value => !value)}
                  className={`flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[9px] font-bold transition-colors ${
                    commandCenterPlannerOpen
                      ? 'border-cyan-300/30 bg-cyan-300/[0.10] text-cyan-50'
                      : 'border-white/10 bg-white/[0.04] text-white/45 hover:border-cyan-300/25 hover:text-cyan-100'
                  }`}
                  title={commandCenterPlannerText.plannerButtonTitle}
                  aria-pressed={commandCenterPlannerOpen}
                >
                  <CalendarClock size={13} />
                  <span>{commandCenterPlannerText.plannerButton}</span>
                </button>
              )}
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
          {isOfficeCommandCenter && commandCenterPlannerOpen ? (
            <CommandCenterPlanner
              isZh={isZh}
              conversationId={attachmentConversationIdRef.current}
              onDiscuss={(prompt) => {
                setDraftText(prompt);
                setCommandCenterPlannerOpen(false);
                window.setTimeout(() => messageInputRef.current?.focus(), 0);
              }}
            />
          ) : (<div
            ref={scrollRef}
             className={`flex-1 overflow-y-auto custom-scrollbar ${isOfficeCommandCenter ? 'lumi-command-center-chat-scroll space-y-5 px-5 py-4' : 'space-y-4 p-4 md:space-y-6 md:p-8'}`}
          >
            {messages.length === 0 && !searchQuery.trim() && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-8 px-4">
                <div className="space-y-3 opacity-20">
                  <Sparkles size={64} className="text-celestial-saturn mx-auto" />
                  <p className="text-lg font-medium">{t.awakePrompt || 'LumiCore is ready.'}<br/>{t.awakePromptSub || 'Begin the first conversation.'}</p>
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
                  data-command-center-message-type={isOfficeCommandCenter ? (msg.type === 'agent' ? 'agent' : 'user') : undefined}
                  className={`flex flex-col ${isOfficeCommandCenter ? `lumi-command-center-message-row w-full ${msg.type === 'agent' ? 'items-start' : 'items-end'}` : msg.type === 'agent' ? 'items-start' : 'items-end'}`}
                  style={isOfficeCommandCenter ? {
                    width: '100%',
                    alignItems: msg.type === 'agent' ? 'flex-start' : 'flex-end',
                  } : undefined}
                >
                  {/* Image / file previews */}
                  {(() => {
                    const messageText = getCustomerDisplayText(msg, isZh);
                    const receiptMedia = Array.isArray(msg.mediaArtifacts)
                      ? msg.mediaArtifacts.filter((artifact: any) => artifact?.url && (artifact.kind === 'image' || artifact.kind === 'video'))
                      : [];
                    const embeddedMedia = [...receiptMedia, ...extractMediaGenerationArtifacts(messageText)].filter((artifact, index, all) => (
                      all.findIndex(candidate => candidate.kind === artifact.kind && candidate.url === artifact.url) === index
                    ));
                    const embeddedImages = embeddedMedia.filter(artifact => artifact.kind === 'image');
                    const embeddedVideos = embeddedMedia.filter(artifact => artifact.kind === 'video');
                    const allFiles: ChatArtifact[] = [...(msg.fileArtifacts || []), ...extractGeneratedFiles(messageText, msg.conversationId)];
                    const generatedFiles = allFiles.filter((file, index) =>
                      !embeddedMedia.some(media => media.path === file.path)
                      && allFiles.findIndex(other => other.path === file.path) === index);
                    if (embeddedMedia.length === 0 && generatedFiles.length === 0) return null;
                    return (
                      <div className="max-w-[85%] mb-1 space-y-2">
                        {embeddedImages.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {embeddedImages.map((artifact, i) => (
                              <button key={artifact.id} type="button" onClick={() => openMediaGenerationArtifact(artifact)}
                                className="block w-36 h-36 rounded-2xl overflow-hidden border-2 border-white/10 hover:border-celestial-saturn/60 transition-all shadow-lg">
                                <FileResourceImage src={artifact.url} alt={`Generated ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                              </button>
                            ))}
                          </div>
                        )}
                        {embeddedVideos.map(artifact => (
                          <FileResourceVideo
                            key={artifact.id}
                            src={artifact.url}
                            controls
                            preload="metadata"
                            className="aspect-video w-full max-w-md rounded-2xl border-2 border-white/10 bg-black/45 object-contain shadow-lg"
                          />
                        ))}
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
                              <FileResourceImage src={item.downloadUrl} alt={item.fileName} className="h-8 w-8 rounded-lg object-cover" loading="lazy" />
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
                          <button key={item.id} type="button" onClick={() => void openChatFile({ fileName: item.fileName, fileId: item.fileId, path: item.path, openUrl: item.downloadUrl })} className="transition-opacity hover:opacity-80">
                            {card}
                          </button>
                        ) : (
                          <div key={item.id}>{card}</div>
                        );
                      })}
                    </div>
                  )}

                  <div data-chat-message-bubble className={`relative group select-text leading-relaxed ${
                    isOfficeCommandCenter
                      ? `lumi-command-center-message-text max-w-[92%] text-[15px] text-left md:max-w-[80%] xl:max-w-[76%] ${msg.type === 'agent' ? 'self-start text-white/85' : 'self-end text-white/78'}`
                      : msg.type === 'agent'
                        ? 'max-w-[92%] text-[15px] md:max-w-[80%] xl:max-w-[76%] rounded-[1.5rem] rounded-tl-none border border-white/10 bg-white/[0.055] p-5 text-white/85 shadow-xl shadow-black/10 md:p-6'
                        : 'max-w-[85%] text-sm rounded-3xl rounded-tr-none border border-white/10 bg-white/5 p-5 text-white/80'
                  }`}
                    style={isOfficeCommandCenter ? {
                      width: 'fit-content',
                      alignSelf: msg.type === 'agent' ? 'flex-start' : 'flex-end',
                    } : {
                      background: msg.type === 'agent' ? chatAccentTheme.agentBubble : chatAccentTheme.userBubble,
                      borderColor: msg.type === 'agent' ? 'rgba(255,255,255,0.12)' : chatAccentTheme.panelBorder,
                      boxShadow: msg.type === 'agent'
                        ? (resolvedAppearanceMode === 'light' ? '0 16px 40px rgba(31,46,39,0.08)' : '0 16px 40px rgba(0,0,0,0.18)')
                        : `0 16px 42px ${chatAccentTheme.panelBorder}`,
                    }}
                  >
                    <div className={`markdown-body chat-message-markdown select-text ${msg.type === 'agent' ? 'chat-message-markdown-agent' : 'chat-message-markdown-user'}`}>
                      <ChatMessageMarkdown conversationId={msg.conversationId || attachmentConversationIdRef.current} onPreview={setPreviewFile}>
                        {getCustomerDisplayText(msg, isZh)}
                      </ChatMessageMarkdown>
                    </div>
                    {msg.type === 'agent' && msg.completionFeedback && (
                      <TaskCompletionFeedbackDetails
                        feedback={msg.completionFeedback}
                        locale={isZh ? 'zh' : 'en'}
                        variant="chat"
                        className={isOfficeCommandCenter ? 'lumi-command-center-task-feedback mt-3' : 'mt-3'}
                      />
                    )}
                    {getCustomerDisplayText(msg, isZh) && (
                      <button
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => handleCopyMessage(
                          getCustomerDisplayText(msg, isZh),
                          msg.id,
                          event.currentTarget.closest('[data-chat-message-bubble]') as HTMLElement | null,
                        )}
                         className={`absolute top-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg hover:bg-white/10 ${
                           isOfficeCommandCenter ? 'right-0' : msg.type === 'agent' ? 'right-2' : 'left-2'
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
                  <span
                    className={`text-[12px] uppercase tracking-widest opacity-30 mt-2 px-3 ${isOfficeCommandCenter ? 'lumi-command-center-message-meta' : ''}`}
                    style={isOfficeCommandCenter ? { alignSelf: msg.type === 'agent' ? 'flex-start' : 'flex-end' } : undefined}
                  >
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
                <div className={isOfficeCommandCenter
                  ? 'lumi-command-center-progress-text max-w-[92%] md:max-w-[78%] text-sm leading-relaxed'
                  : 'max-w-[92%] md:max-w-[78%] rounded-[1.35rem] rounded-tl-none border border-white/10 bg-white/[0.045] px-4 py-3 shadow-xl shadow-black/10'}>
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
          </div>)}

          <div
            className={`lumi-chat-composer ${isOfficeCommandCenter ? 'border-0 bg-transparent p-4' : 'border-t p-6'}`}
            style={isOfficeCommandCenter
              ? { ...chatInputPanelStyle, background: 'transparent', borderTopColor: 'transparent' }
              : chatInputPanelStyle}
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
                        <FileResourceImage src={item.downloadUrl} alt={item.fileName} className="h-8 w-8 rounded-lg object-cover" />
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
            <ChatAttachmentUploadStatus
              busy={isOptimizing}
              failures={attachmentUploadFailures}
              isZh={isZh}
              onRetry={() => { void runChatAttachmentUpload('files', [], true); }}
              onDismiss={() => { chatUploadsRef.current.reset(); setAttachmentUploadFailures([]); }}
            />
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
                  title={uiMessage('agent-chat-page.dictation-text-only.a17d39c4e2', isZh ? 'zh' : 'en')}
                  aria-label={uiMessage('agent-chat-page.dictation-text-only.a17d39c4e2', isZh ? 'zh' : 'en')}
                  className={`absolute right-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full p-0 transition-colors ${
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
                  disabled={conversationTransitionPending || isOptimizing || attachmentUploadFailures.length > 0 || (!hasDraftText && pendingAttachments.length === 0)}
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
        </motion.div>
        {isOfficeCommandCenter && (
          <aside
            data-command-center-switcher
            data-command-center-right-rail="true"
            data-wallpaper-tool="command-tools"
            className="lumi-command-center-switcher relative z-30 flex shrink-0 flex-col justify-center gap-3"
            aria-label={uiMessage('command-center.switcher.4b7c2d1e09', isZh ? 'zh' : 'en')}
          >
            {onOpenMemoryAvatar && (
              <button
                type="button"
                data-memory-avatar-switch
                onClick={onOpenMemoryAvatar}
                className="lumi-command-center-switcher-button lumi-command-center-memory-avatar-switch group flex items-center gap-3 rounded-2xl border border-fuchsia-300/20 bg-fuchsia-300/[0.08] px-3 py-3 text-left text-fuchsia-50/80 transition-all hover:-translate-x-1 hover:border-fuchsia-200/45 hover:bg-fuchsia-300/[0.16] hover:text-white"
                title={t.memoryAvatars || uiMessage('agent-chat-page.memory-avatar.8c4e1f7a20', isZh ? 'zh' : 'en')}
                aria-label={t.memoryAvatars || uiMessage('agent-chat-page.open-memory-avatar.2d7a9c4e16', isZh ? 'zh' : 'en')}
              >
                <span className="lumi-command-center-switcher-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-fuchsia-200/20 bg-fuchsia-200/10 text-fuchsia-100 transition-transform group-hover:scale-105">
                  <Castle className="h-5 w-5" />
                </span>
                <span className="lumi-command-center-switcher-copy min-w-0">
                  <span className="block text-xs font-black uppercase tracking-[0.12em]">{t.memoryAvatars || uiMessage('agent-chat-page.memory-avatar.8c4e1f7a20', isZh ? 'zh' : 'en')}</span>
                  <span className="mt-1 block text-[10px] text-fuchsia-100/45">{uiMessage('command-center.memory-avatar-hint.6a1d9e3c20', isZh ? 'zh' : 'en')}</span>
                </span>
              </button>
            )}
            {onOpenNexus && (
              <button
                type="button"
                data-lumi-core-switch
                onClick={onOpenNexus}
                className="lumi-command-center-switcher-button group flex items-center gap-3 rounded-2xl border border-violet-300/20 bg-violet-300/[0.08] px-3 py-3 text-left text-violet-50/80 transition-all hover:-translate-x-1 hover:border-violet-200/45 hover:bg-violet-300/[0.16] hover:text-white"
                title={uiMessage('command-center.inner-realm.4d8f2a1c09', isZh ? 'zh' : 'en')}
                aria-label={uiMessage('command-center.inner-realm.4d8f2a1c09', isZh ? 'zh' : 'en')}
              >
                <span className="lumi-command-center-switcher-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-200/20 bg-violet-200/10 text-violet-100 transition-transform group-hover:scale-105">
                  <Cpu className="h-5 w-5" />
                </span>
                <span className="lumi-command-center-switcher-copy min-w-0">
                  <span className="block text-xs font-black tracking-[0.12em]">{uiMessage('command-center.inner-realm.4d8f2a1c09', isZh ? 'zh' : 'en')}</span>
                  <span className="mt-1 block text-[10px] text-violet-100/45">{uiMessage('command-center.lumicore-hint.8f2d4c1a09', isZh ? 'zh' : 'en')}</span>
                </span>
              </button>
            )}
            {onOpenKnowledge && (
              <button
                type="button"
                data-knowledge-base-switch
                onClick={onOpenKnowledge}
                className="lumi-command-center-switcher-button lumi-command-center-knowledge-switch group flex items-center gap-3 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.08] px-3 py-3 text-left text-cyan-50/80 transition-all hover:-translate-x-1 hover:border-cyan-200/45 hover:bg-cyan-300/[0.16] hover:text-white"
                title={uiMessage('desktop-ui.knowledge.610ef22cae', isZh ? 'zh' : 'en')}
                aria-label={uiMessage('desktop-ui.knowledge.610ef22cae', isZh ? 'zh' : 'en')}
              >
                <span className="lumi-command-center-switcher-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-200/20 bg-cyan-200/10 text-cyan-100 transition-transform group-hover:scale-105">
                  <FolderOpen className="h-5 w-5" />
                </span>
                <span className="lumi-command-center-switcher-copy min-w-0">
                  <span className="block text-xs font-black tracking-[0.12em]">{t.knowledgeBase || uiMessage('desktop-ui.knowledge.610ef22cae', isZh ? 'zh' : 'en')}</span>
                  <span className="mt-1 block truncate text-[10px] text-cyan-100/45">{knowledgeStatusText}</span>
                </span>
              </button>
            )}
            <button
              type="button"
              data-ai-creation-switch
              onClick={() => openMediaGenerationStudio('image')}
              className="lumi-command-center-switcher-button lumi-command-center-ai-creation-switch group flex items-center gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-3 text-left text-amber-50/80 transition-all hover:-translate-x-1 hover:border-amber-200/45 hover:bg-amber-300/[0.16] hover:text-white"
              title={mediaGenerationText.aiCreation}
              aria-label={mediaGenerationText.openAiCreation}
            >
              <span className="lumi-command-center-switcher-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-200/20 bg-amber-200/10 text-amber-100 transition-transform group-hover:scale-105">
                <Sparkles className="h-5 w-5" />
              </span>
              <span className="lumi-command-center-switcher-copy min-w-0">
                <span className="block text-xs font-black tracking-[0.12em]">{mediaGenerationText.aiCreation}</span>
                <span className="mt-1 block truncate text-[10px] text-amber-100/45">{mediaGenerationText.aiCreationHint}</span>
              </span>
            </button>
          </aside>
        )}
        </div>

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
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.agentStats || 'LumiCore Stats'}</h4>
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
              {t.agentSyncDesc || 'LumiCore is synchronized with the local node. All interactions remain in your private memory store.'}
            </p>
          </GlassCard>
          </motion.div>
            </motion.div>
          </>
        )}
      </div>}
    </div>
        {conversationContextMenu && typeof document !== 'undefined' && createPortal(
          <>
            <button
              type="button"
              className="fixed inset-0 z-[240] cursor-default bg-transparent"
              aria-label={t.close || 'Close'}
              onClick={() => setConversationContextMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setConversationContextMenu(null);
              }}
            />
            <div
              data-command-center-conversation-context-menu
              role="menu"
              className="fixed z-[241] min-w-48 overflow-hidden rounded-xl border border-white/15 bg-[#0a1019]/95 p-1 shadow-2xl backdrop-blur-xl"
              style={{ left: conversationContextMenu.x, top: conversationContextMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-red-100/80 transition-colors hover:bg-red-400/12 hover:text-red-50 disabled:cursor-wait disabled:opacity-50"
                disabled={Boolean(deletingConversationId)}
                onClick={() => void deleteConversationFromHistory(conversationContextMenu.conversationId)}
              >
                {deletingConversationId === conversationContextMenu.conversationId ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                <span>{t.delete || uiMessage('org-settings.delete.5b875326d1', isZh ? 'zh' : 'en')}</span>
              </button>
            </div>
          </>,
          document.body,
        )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
