import { type ChatAttachment } from "./contracts";
import { getCustomerDisplayText } from "./history";
import { extractGeneratedFiles } from "./media_artifacts";
import { FileResourceImage, FileResourceVideo } from "../FileResourceMedia";
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Sparkles, FileText, Mic, CheckCircle2, ChevronRight, XCircle, Copy, Check, Image as ImageIcon } from 'lucide-react';
import { ChatMessageMarkdown } from "../ChatMessageMarkdown";
import { type ChatArtifact } from "../../../shared/chat_artifacts";
import { TaskCompletionFeedbackDetails } from "../TaskCompletionFeedbackDetails";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { extractMediaGenerationArtifacts } from '@/lib/mediaGenerationArtifacts';
import type { AgentChatViewInput } from './AgentChatView';
import { mediaGenerationCopy } from '@/i18n/locales/mediaGeneration';

export function renderChatMessageFeed({ scrollRef, isOfficeCommandCenter, messages, searchQuery, t, visibleSuggestions, sendText, searchError, isSearchingHistory, searchDisplayMessages, hiddenMessageCount, displayMessages, isZh, openMediaGenerationArtifact, renderGeneratedFiles, openChatFile, chatAccentTheme, resolvedAppearanceMode, attachmentConversationIdRef, setPreviewFile, handleCopyMessage, copiedId, isTyping, chatProgressLines, workflowStatus }: Pick<AgentChatViewInput, "scrollRef" | "isOfficeCommandCenter" | "messages" | "searchQuery" | "t" | "visibleSuggestions" | "sendText" | "searchError" | "isSearchingHistory" | "searchDisplayMessages" | "hiddenMessageCount" | "displayMessages" | "isZh" | "openMediaGenerationArtifact" | "renderGeneratedFiles" | "openChatFile" | "chatAccentTheme" | "resolvedAppearanceMode" | "attachmentConversationIdRef" | "setPreviewFile" | "handleCopyMessage" | "copiedId" | "isTyping" | "chatProgressLines" | "workflowStatus">) {
  return (
<div
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
                          <div key={artifact.id} className="max-w-md space-y-2">
                          <FileResourceVideo
                            src={artifact.url}
                            controls
                            preload="metadata"
                            className="aspect-video w-full max-w-md rounded-2xl border-2 border-white/10 bg-black/45 object-contain shadow-lg"
                          />
                          <button type="button" onClick={() => openMediaGenerationArtifact(artifact)} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs">{mediaGenerationCopy(isZh ? 'zh' : 'en').viewVideo}</button>
                          </div>
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
          </div>
  );
}
