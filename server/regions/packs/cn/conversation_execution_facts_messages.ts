export const CN_CONVERSATION_EXECUTION_FACT_MESSAGES = {
  unnamedOpenTarget: '请求的目标',
  noVerifiedOpen: '我查了这段会话的执行记录，没有找到已验证成功的打开回执。',
  verifiedOpen: (target: string) => `是，刚才已经打开了${target}，打开动作有已验证回执。`,
  laterObservationIncomplete: '后续窗口焦点核验没有完成，但这不应否定已经完成的打开动作。',
  noPriorTurnToolReceipt: '上一轮没有记录到工具调用回执。',
  priorTurnTools: (items: Array<{ name: string; outcome: 'success' | 'failed' }>) => (
    `上一轮确实调用了工具：${items.map(item => `${item.name}（${item.outcome === 'success' ? '成功' : '失败'}）`).join('、')}。`
  ),
  taskStatus: (status: string) => `任务状态：${status || '回执未记录'}。`,
  observedWindowTitle: (title: string) => `观察到的窗口标题：${title || '回执未记录'}。`,
} as const;
