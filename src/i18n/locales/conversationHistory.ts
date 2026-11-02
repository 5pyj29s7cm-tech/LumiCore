export function conversationHistoryCopy(isZh: boolean) {
  return isZh ? {
    title: '会话记录', loaded: '已加载', total: '共', conversations: '个会话',
    newConversation: '新建会话', refresh: '刷新会话列表',
    search: '搜索全部会话', searchHint: '搜索全部会话正文', clear: '清除搜索',
    recent: '最近会话', matches: '匹配会话', matchingContent: '匹配正文', searchLimit: '显示前 500 条正文匹配，可缩小关键词范围',
    current: '当前', untitled: '未命名会话', messages: '条消息', noMessages: '暂无摘要', retrySearch: '重试搜索',
    loading: '正在加载会话…', searching: '正在搜索全部会话…', empty: '还没有会话', emptyHint: '新建会话，开始交流。',
    noMatches: '没有找到相关会话', noMatchesHint: '换一个关键词试试。', retry: '重试', loadMore: '加载更多会话',
    loadingMore: '正在加载更多…', allLoaded: '已显示全部会话', searchFailed: '搜索失败，请重试', loadFailed: '会话列表加载失败',
  } : {
    title: 'Conversations', loaded: 'Loaded', total: 'Total', conversations: 'conversations',
    newConversation: 'New conversation', refresh: 'Refresh conversations',
    search: 'Search all conversations', searchHint: 'Search all conversation content', clear: 'Clear search',
    recent: 'Recent conversations', matches: 'Matching conversations', matchingContent: 'Matching content', searchLimit: 'Showing the first 500 matching messages. Refine your search for more.',
    current: 'Current', untitled: 'Untitled conversation', messages: 'messages', noMessages: 'No preview', retrySearch: 'Retry search',
    loading: 'Loading conversations…', searching: 'Searching all conversations…', empty: 'No conversations yet', emptyHint: 'Start a new conversation.',
    noMatches: 'No matching conversations', noMatchesHint: 'Try a different keyword.', retry: 'Try again', loadMore: 'Load more conversations',
    loadingMore: 'Loading more…', allLoaded: 'All conversations loaded', searchFailed: 'Search failed. Please try again.', loadFailed: 'Could not load conversations',
  };
}
