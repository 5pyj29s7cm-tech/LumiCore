export const CN_BACKGROUND_DELEGATION_MESSAGES = {
  noWorker: '后台执行单元暂时不可用，这个任务没有开始。你可以让我留在当前对话里继续处理。',
  cancelled: '后台任务已取消。',
  failed: (detail: string) => `后台任务没有完成：${detail || '执行链路未返回结果'}。`,
  completedTitle: '后台任务已完成',
  failedTitle: '后台任务未完成',
  completedInTaskCenter: '后台任务已完成，结果已放进任务中心，没有打断当前对话。',
  failedInTaskCenter: '后台任务没有完成，详情已放进任务中心，没有打断当前对话。',
} as const;
