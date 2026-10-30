export const organizationRemediationCopy = (lang: string) => lang === 'en' ? {
  retry: 'Retry loading', discovery: 'Organization connection could not be checked. The saved connection has been preserved.',
  invalidArticles: 'The knowledge server returned an invalid article list.', configError: 'Configuration or status could not be loaded.',
  older: 'Load older messages', conversations: 'Organization conversations', newChat: 'New conversation', moreConversations: 'More conversations',
} : {
  retry: '重新读取', discovery: '无法确认组织连接，已保留原有连接信息。',
  invalidArticles: '知识库返回的文章列表格式不正确。', configError: '配置或连接状态读取失败。',
  older: '读取更早消息', conversations: '组织会话', newChat: '新建会话', moreConversations: '更多会话',
};
