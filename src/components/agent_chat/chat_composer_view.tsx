import { ChatAttachmentUploadStatus } from "../ChatAttachmentUploadStatus";
import { FileResourceImage } from "../FileResourceMedia";
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, FileText, Mic, Square, XCircle, Check, Paperclip, Image as ImageIcon, Briefcase, FolderOpen, Upload } from 'lucide-react';
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { chatAttachmentIdentity } from '@/lib/chatAttachmentReferences';
import type { AgentChatViewInput } from './AgentChatView';

export function renderChatComposer({ isOfficeCommandCenter, chatInputPanelStyle, conversationAttachments, clearConversationAttachmentContext, pendingAttachments, removePendingAttachment, isOptimizing, attachmentUploadFailures, isZh, runChatAttachmentUpload, chatUploadsRef, setAttachmentUploadFailures, optimizationProgress, handleSendMessage, attachmentMenuRef, setShowAttachmentMenu, isTyping, showAttachmentMenu, referenceableChatFiles, pendingAttachmentKeys, referenceChatFile, knowledgeLoading, fileInputRef, messageInputRef, updateDraftText, t, chatInputStyle, toggleListening, isListening, cancelActiveChat, conversationTransitionPending, hasDraftText, chatAccentTheme }: Pick<AgentChatViewInput, "isOfficeCommandCenter" | "chatInputPanelStyle" | "conversationAttachments" | "clearConversationAttachmentContext" | "pendingAttachments" | "removePendingAttachment" | "isOptimizing" | "attachmentUploadFailures" | "isZh" | "runChatAttachmentUpload" | "chatUploadsRef" | "setAttachmentUploadFailures" | "optimizationProgress" | "handleSendMessage" | "attachmentMenuRef" | "setShowAttachmentMenu" | "isTyping" | "showAttachmentMenu" | "referenceableChatFiles" | "pendingAttachmentKeys" | "referenceChatFile" | "knowledgeLoading" | "fileInputRef" | "messageInputRef" | "updateDraftText" | "t" | "chatInputStyle" | "toggleListening" | "isListening" | "cancelActiveChat" | "conversationTransitionPending" | "hasDraftText" | "chatAccentTheme">) {
  return (
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
  );
}
