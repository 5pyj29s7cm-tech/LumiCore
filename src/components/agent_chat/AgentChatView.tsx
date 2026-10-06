import { renderChatToolbar } from './chat_toolbar_view';
import { renderConversationHistoryRail } from './conversation_history_rail_view';
import { renderChatPanelHeader } from './chat_panel_header_view';
import { renderChatMessageFeed } from './chat_message_feed_view';
import { renderChatComposer } from './chat_composer_view';
import { renderChatActivityRail } from './chat_activity_rail_view';
import type { MergeChatAttachmentsResult, ChatAttachmentReference } from "@/lib/chatAttachmentReferences";
import { type GeneratedFileLink, type ChatAttachment, type ConversationHistoryItem, type ConversationHistoryContextMenu, type WorkflowStatus, type ChatFilePanelItem, type ChatSendOptions } from "./contracts";

import { CHAT_LIGHT_THEME, CHAT_NEUTRAL_THEME } from "./appearance";
import { useConversationAttachments } from "../../hooks/useConversationAttachments";
import React from 'react';
import type { ChatSongWorkbenchHandle } from "../ChatSongWorkbench";

import { ChatAttachmentUploads, type ChatUploadFailure, type ChatUploadKind, type ChatUploadSource } from '@/lib/chatAttachmentUploads';

import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Castle, Cpu, Sparkles, XCircle, FolderOpen, Upload, History, Trash2 } from 'lucide-react';
import { ChatFilePreview, type ChatPreviewFile } from "../ChatFilePreview";

import { useVoiceCall } from '@/hooks/useVoiceCall';

import { type ChatProgressLine } from '@/lib/chatProgress';

import { WeChatSettings } from "../WeChatSettings";
import type { FileEntry } from "../MemoryTree";
import { uiMessage } from "../../i18n/uiMessages";

import { CHAT_ATTACHMENT_ACCEPT, createChatAttachmentReference } from '@/lib/chatAttachmentReferences';

import { CommandCenterPanel } from "../CommandCenterPanel";
import type { CommandCenterView } from "../commandCenterTypes";
import { ActiveTaskWidget } from "../ActiveTaskWidget";
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { CommandCenterPlanner } from "../CommandCenterPlanner";
import { commandCenterPlannerCopy } from '@/i18n/locales/commandCenterPlanner';
import { mediaGenerationCopy } from '@/i18n/locales/mediaGeneration';
import { MediaGenerationStudio, type MediaGenerationRequest, type MediaGenerationSourceChange, type MediaGenerationSourceSlot, type MediaGenerationStudioStatus } from "../MediaGenerationStudio";
import { type MediaGenerationArtifact, type MediaGenerationKind, type MediaGenerationSourceOperation } from '@/lib/mediaGenerationArtifacts';

const ChatSongWorkbench = React.lazy(() => import('../ChatSongWorkbench'));
export type AgentChatViewInput = {
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
export function AgentChatView(input: AgentChatViewInput) {
  const { isOpen, previewFile, isZh, setPreviewFile, openChatFileInSystem, layout, commandCenterView, resolvedAppearanceMode, prefersReducedMotion, handleChatDragOver, handleChatDragLeave, handleChatDrop, chatAccentTheme, fileInputRef, uploadChatAttachments, mediaSourceFileInputRef, uploadMediaSourceImage, isOfficeCommandCenter, mediaStudioMode, isTyping, mediaSourceUploading, mediaGenerationStatus, mediaGenerationDetail, mediaGenerationArtifacts, libraryMediaArtifacts, knowledgeLoading, knowledgeFailed, refreshKnowledgeFiles, appendPendingAttachments, requestCloseCreativeStudio, availableMediaSourceArtifacts, mediaSources, mediaGenerationRetryRequest, openMediaGenerationStudio, handleMediaSourceChange, requestMediaSourceImage, isWorkChat, setChatSongOpen, chatSongOpen, user, chatSongWorkbenchRef, knowledgeFiles, generateMediaFromStudio, sendText, closeMediaGenerationStudio, setMediaGeneration, mediaGenerationText, cancelActiveChat, openMediaGenerationArtifact, markMediaGenerationArtifactReady, markMediaGenerationArtifactFailed, isDraggingFiles, showWeChatSettings, setShowWeChatSettings, t, isCommandCenterUtility, onCommandCenterViewChange, onOpenNexus, runtimeStatus, runtimeStatusLoading, runtimeStatusError, refreshRuntimeStatus, workflowTaskActive, workflowStatus, chatProgressStatusText, conversationHistoryOpen, toggleConversationHistory, chatPanelStyle, commandCenterPlannerOpen, attachmentConversationIdRef, setDraftText, setCommandCenterPlannerOpen, messageInputRef, onOpenMemoryAvatar, onOpenKnowledge, knowledgeStatusText, conversationContextMenu, setConversationContextMenu, deletingConversationId, deleteConversationFromHistory } = input;

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
      renderChatToolbar(input)
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
          renderConversationHistoryRail(input)
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
          {renderChatPanelHeader(input)}
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
          ) : (renderChatMessageFeed(input))}

          {renderChatComposer(input)}
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
            {renderChatActivityRail(input)}
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
