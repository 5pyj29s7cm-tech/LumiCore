import { Loader2, Plus, History } from 'lucide-react';
import type { AgentChatViewInput } from './AgentChatView';

export function renderConversationHistoryRail({ conversationHistorySelectorExpanded, setConversationHistorySelectorExpanded, handleConversationHistorySelectorBlur, t, conversationHistory, startNewTextConversation, isCreatingConversation, restoringConversationId, conversationHistoryListRef, handleConversationHistoryScroll, conversationHistoryLoading, conversationHistoryLoadingMore, orderedConversationHistory, attachmentConversationIdRef, restoreTextConversation, setConversationContextMenu, isZh, conversationHistoryHasMore }: Pick<AgentChatViewInput, "conversationHistorySelectorExpanded" | "setConversationHistorySelectorExpanded" | "handleConversationHistorySelectorBlur" | "t" | "conversationHistory" | "startNewTextConversation" | "isCreatingConversation" | "restoringConversationId" | "conversationHistoryListRef" | "handleConversationHistoryScroll" | "conversationHistoryLoading" | "conversationHistoryLoadingMore" | "orderedConversationHistory" | "attachmentConversationIdRef" | "restoreTextConversation" | "setConversationContextMenu" | "isZh" | "conversationHistoryHasMore">) {
  return (
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
  );
}
