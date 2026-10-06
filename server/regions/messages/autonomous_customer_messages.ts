export const CN_AUTONOMOUS_CUSTOMER_MESSAGES = {
  completed: '这项自主任务已经完成。',
  retrying: '这项自主任务暂时没有完成，我会保留进度并稍后继续。',
  cancelled: '这项自主任务已经停止。',
  failed: '这项自主任务暂时没有完成。你可以稍后让我重试。',
  finalizationPending: '工作已执行，但最终状态未保存成功。保存恢复后会确认完成，无需重新执行。',
} as const;
