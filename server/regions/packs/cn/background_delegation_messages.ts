export const CN_BACKGROUND_DELEGATION_MESSAGES = {
  noWorker: '后台执行单元暂时不可用，这个任务没有开始。你可以让我留在当前对话里继续处理。',
  cancelled: '后台任务已取消。',
  failed: (detail: string) => `后台任务没有完成：${detail || '执行链路未返回结果'}。`,
  completedTitle: '后台任务已完成',
  failedTitle: '后台任务未完成',
  completedInTaskCenter: '后台任务已完成，结果已放进任务中心，没有打断当前对话。',
  failedInTaskCenter: '后台任务没有完成，详情已放进任务中心，没有打断当前对话。',
  recoveredResult: (title: string, detail: string) => `\u540e\u53f0\u4efb\u52a1\u5df2\u6062\u590d\u5e76\u5b8c\u6210\uff1a${title}\n\n${detail || '\u540e\u53f0\u5b50 agent \u6ca1\u6709\u8fd4\u56de\u8be6\u7ec6\u7ed3\u679c\u3002'}`,
  recoveredCompletedTitle: '\u540e\u53f0\u4efb\u52a1\u5df2\u6062\u590d\u5b8c\u6210',
  recoveredBlockedTitle: '\u540e\u53f0\u4efb\u52a1\u6062\u590d\u540e\u4ecd\u53d7\u963b',
  recoveryFailedTitle: '\u540e\u53f0\u4efb\u52a1\u6062\u590d\u5931\u8d25',
} as const;
