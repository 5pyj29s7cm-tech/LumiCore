const en = {
  animationSpeed: 'Animation speed', retry: 'Retry', loading: 'Loading…',
  timeout: 'The request timed out. Reload the current state before trying again.',
  catalogError: 'The voice catalog could not be loaded. Configuration is unknown.',
  retryHistory: 'Retry archive sync (no speech)',
  ingestPartial: 'Processing is incomplete or unverified. Review extraction and coverage before relying on this knowledge.',
  deleteContact: 'Delete this contact?', cancel: 'Cancel', confirmDelete: 'Confirm deletion',
  previous: 'Previous', next: 'Next', page: (page: number, total: number) => `Page ${page} · ${total} contacts`,
};
const zh: typeof en = {
  animationSpeed: '动画速度', retry: '重试', loading: '加载中…',
  timeout: '请求已超时。请先重新读取当前状态，再决定是否继续操作。',
  catalogError: '声音列表加载失败，当前配置状态未知。',
  retryHistory: '重试档案同步（不发声）',
  ingestPartial: '处理尚未完成或未核验。请检查提取状态和覆盖情况后再使用这些知识。',
  deleteContact: '确定删除这个联系人？', cancel: '取消', confirmDelete: '确认删除',
  previous: '上一页', next: '下一页', page: (page, total) => `第 ${page} 页 · 共 ${total} 位联系人`,
};
export const personalCompletenessCopy = (lang?: string) => lang === 'en' ? en : zh;
