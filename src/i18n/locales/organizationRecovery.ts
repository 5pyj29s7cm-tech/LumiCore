const copy = {
  en: {
    previous: 'Previous page', next: 'Next page', retry: 'Retry', page: 'Page',
    historyError: 'Conversation history could not be loaded. Your current messages and draft are unchanged.',
    retryHistory: 'Retry history', stop: 'Stop this request',
    cancelling: 'Cancellation requested; waiting for the final result.',
    cancelUnknown: 'Cancellation was not confirmed. You can retry stopping this request.',
    cancelFailed: 'The request could not be stopped. You can retry.',
    recovering: 'The request has ended; recovering its final result.',
    recoveryFailed: 'The final result could not be recovered. You can retry.',
  },
  zh: {
    previous: '上一页', next: '下一页', retry: '重试', page: '第',
    historyError: '对话历史加载失败，当前消息和草稿已保留。',
    retryHistory: '重试加载历史', stop: '停止本次请求',
    cancelling: '已请求取消，正在等待最终结果。',
    cancelUnknown: '尚未确认取消结果，可以重试停止本次请求。',
    cancelFailed: '未能停止本次请求，可以重试。',
    recovering: '本次请求已结束，正在恢复最终结果。',
    recoveryFailed: '最终结果恢复失败，可以重试。',
  },
};

export function organizationRecoveryCopy(language: string) {
  return language === 'en' ? copy.en : copy.zh;
}
