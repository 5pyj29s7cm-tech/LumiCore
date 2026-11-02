import { useMemo, useState } from 'react';
import { Loader2, Plus, History, Search, X, RefreshCw, MessageSquare, AlertCircle, ChevronDown } from 'lucide-react';
import type { AgentChatViewInput } from './AgentChatView';
import type { ConversationHistoryItem } from './contracts';
import { conversationHistoryCopy } from '@/i18n/locales/conversationHistory';
import { matchingSnippet, useConversationHistorySearch } from './conversation_history_search';
import './conversation_history_rail.css';

type HistoryRailProps = Pick<AgentChatViewInput,
  'conversationHistory' |
  'startNewTextConversation' | 'isCreatingConversation' | 'restoringConversationId' | 'conversationHistoryListRef' |
  'handleConversationHistoryScroll' | 'conversationHistoryLoading' | 'conversationHistoryLoadingMore' |
  'orderedConversationHistory' | 'attachmentConversationIdRef' | 'restoreTextConversation' | 'setConversationContextMenu' |
  'isZh' | 'conversationHistoryHasMore' | 'refreshConversationHistory' | 'loadMoreConversationHistory' |
  'conversationHistoryError' | 'scopedConversationUrl'>;

type HistoryRow = {
  id: string;
  title: string;
  preview: string;
  timestamp?: string;
  messageCount?: number;
};

function formatHistoryTime(timestamp: string | undefined, isZh: boolean) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fromHeader(conversation: ConversationHistoryItem, untitled: string): HistoryRow {
  return {
    id: conversation.id,
    title: conversation.displayTitle || conversation.title || conversation.preview || untitled,
    preview: conversation.preview || '',
    timestamp: conversation.lastActiveAt || conversation.createdAt,
    messageCount: conversation.messageCount,
  };
}

export function ConversationHistoryRail(props: HistoryRailProps) {
  const {
    conversationHistory, orderedConversationHistory, startNewTextConversation, isCreatingConversation,
    restoringConversationId, conversationHistoryListRef, handleConversationHistoryScroll,
    conversationHistoryLoading, conversationHistoryLoadingMore, attachmentConversationIdRef,
    restoreTextConversation, setConversationContextMenu, isZh, conversationHistoryHasMore,
    refreshConversationHistory, loadMoreConversationHistory, conversationHistoryError, scopedConversationUrl,
  } = props;
  const copy = conversationHistoryCopy(isZh);
  const [query, setQuery] = useState('');
  const [searchRetry, setSearchRetry] = useState(0);
  const search = useConversationHistorySearch(query, scopedConversationUrl, searchRetry);
  const searching = Boolean(query.trim());
  const rows = useMemo(() => {
    if (!searching) return orderedConversationHistory.map(item => fromHeader(item, copy.untitled));
    const headers = new Map(conversationHistory.map(item => [item.id, item]));
    const seen = new Set<string>();
    return search.results.flatMap(match => {
      if (seen.has(match.conversationId)) return [];
      seen.add(match.conversationId);
      const header = headers.get(match.conversationId);
      const firstLine = match.message.split(/\r?\n/).find(line => line.trim())?.trim() || copy.untitled;
      return [{
        id: match.conversationId,
        title: header ? fromHeader(header, copy.untitled).title : firstLine,
        preview: matchingSnippet(match.message, query),
        timestamp: header?.lastActiveAt || header?.createdAt || match.timestamp,
        messageCount: header?.messageCount,
      }];
    });
  }, [searching, orderedConversationHistory, conversationHistory, search.results, query, copy.untitled]);
  const busy = isCreatingConversation || Boolean(restoringConversationId);
  const error = searching ? search.error : conversationHistoryError;
  const loading = searching ? search.loading : conversationHistoryLoading && rows.length === 0;
  const retry = () => searching ? setSearchRetry(value => value + 1) : void refreshConversationHistory();

  return (
    <aside
      data-command-center-history-rail
      data-wallpaper-tool="command-history"
      className="lumi-command-center-history-rail lumi-history-panel"
      aria-label={copy.title}
    >
      <div className="lumi-command-center-history-rail-header lumi-history-header">
        <div className="lumi-history-heading"><History size={17} /><h2>{copy.title}</h2></div>
        <div className="lumi-history-header-actions">
          <button type="button" className="lumi-history-icon-button" onClick={() => { void refreshConversationHistory(); if (searching) setSearchRetry(value => value + 1); }} disabled={conversationHistoryLoading || conversationHistoryLoadingMore} title={copy.refresh} aria-label={copy.refresh}>
            <RefreshCw size={14} className={conversationHistoryLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      <div className="lumi-history-controls">
        <button type="button" data-command-center-new-conversation className="lumi-history-new" onClick={() => void startNewTextConversation()} disabled={busy} aria-label={copy.newConversation}>
          {isCreatingConversation ? <Loader2 size={16} className="animate-spin" /> : <Plus size={17} />}<span>{copy.newConversation}</span>
        </button>
        <div className="lumi-history-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy.searchHint} aria-label={copy.search} autoComplete="off" spellCheck={false} />
          {query && <button type="button" className="lumi-history-clear" onClick={() => setQuery('')} aria-label={copy.clear}><X size={13} /></button>}
        </div>
      </div>
      <div className="lumi-history-section-label" aria-live="polite">
        <span>{searching ? copy.matches : copy.recent}</span>
        <span>{searching ? rows.length + ' ' + copy.conversations : (conversationHistoryHasMore ? copy.loaded : copy.total) + ' ' + conversationHistory.length}</span>
      </div>
      <div ref={searching ? undefined : conversationHistoryListRef} onScroll={searching ? undefined : handleConversationHistoryScroll} className="lumi-command-center-history-list lumi-history-list custom-scrollbar" aria-busy={loading || conversationHistoryLoadingMore}>
        {error && <div className="lumi-history-error" role="alert"><AlertCircle size={15} /><div><strong>{searching ? copy.searchFailed : copy.loadFailed}</strong><span>{error}</span><button type="button" onClick={retry} aria-label={searching ? copy.retrySearch : copy.refresh}>{copy.retry}</button></div></div>}
        {loading ? <div className="lumi-history-empty" role="status"><Loader2 size={22} className="animate-spin" /><p>{searching ? copy.searching : copy.loading}</p></div> : rows.length === 0 && !error ? (
          <div className="lumi-history-empty"><MessageSquare size={26} /><strong>{searching ? copy.noMatches : copy.empty}</strong><p>{searching ? copy.noMatchesHint : copy.emptyHint}</p></div>
        ) : rows.map(conversation => {
          const current = conversation.id === attachmentConversationIdRef.current;
          return (
            <button key={conversation.id} type="button" aria-haspopup="menu" aria-current={current ? 'true' : undefined} onClick={() => void restoreTextConversation(conversation.id)}
              onContextMenu={event => { event.preventDefault(); setConversationContextMenu({ conversationId: conversation.id, x: Math.min(event.clientX, Math.max(12, window.innerWidth - 236)), y: Math.min(event.clientY, Math.max(12, window.innerHeight - 86)) }); }}
              disabled={busy} data-command-center-history-item className={'lumi-command-center-history-item lumi-history-row' + (current ? ' lumi-command-center-history-item--current' : '')}>
              <div className="lumi-history-row-title-line">
                <span className="lumi-command-center-history-item-title lumi-history-row-title" title={conversation.title}>{conversation.title}</span>
                {(restoringConversationId === conversation.id || current) && <span className="lumi-history-row-status">{restoringConversationId === conversation.id ? <Loader2 size={12} className="animate-spin" /> : <span className="lumi-command-center-history-current-badge">{copy.current}</span>}</span>}
              </div>
              <span className="lumi-command-center-history-item-preview lumi-history-row-preview">{conversation.preview || copy.noMessages}</span>
              <span className="lumi-command-center-history-item-meta lumi-history-row-meta"><span>{typeof conversation.messageCount === 'number' ? conversation.messageCount + ' ' + copy.messages : copy.matchingContent}</span><time dateTime={conversation.timestamp}>{formatHistoryTime(conversation.timestamp, isZh)}</time></span>
            </button>
          );
        })}
        {searching && search.capped && !loading && <p className="lumi-history-footer-note">{copy.searchLimit}</p>}
        {!searching && rows.length > 0 && (conversationHistoryHasMore ? <button type="button" className="lumi-history-load-more" onClick={() => void loadMoreConversationHistory()} disabled={conversationHistoryLoadingMore || conversationHistoryLoading} aria-label={copy.loadMore}>{conversationHistoryLoadingMore ? <Loader2 size={14} className="animate-spin" /> : <ChevronDown size={14} />}<span>{conversationHistoryLoadingMore ? copy.loadingMore : copy.loadMore}</span></button> : <p className="lumi-history-footer-note">{copy.allLoaded}</p>)}
      </div>

    </aside>
  );
}
