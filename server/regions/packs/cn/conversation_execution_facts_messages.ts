export const CN_CONVERSATION_EXECUTION_FACT_MESSAGES = {
  unnamedOpenTarget: '请求的目标',
  noVerifiedOpen: '我查了这段会话的执行记录，没有找到已验证成功的打开回执。',
  verifiedOpen: (target: string) => `是，刚才已经打开了${target}，打开动作有已验证回执。`,
  laterObservationIncomplete: '后续窗口焦点核验没有完成，但这不应否定已经完成的打开动作。',
  noPriorTurnToolReceipt: '上一轮没有记录到工具调用回执。',
  noPriorFailureReceipt: '上一轮没有记录到可核实的失败回执，所以不能凭旧任务状态猜测失败原因。',
  failedAt: (action: string, detail: string) => `刚才失败在${action}：${detail}`,
  failureActionVision: '视觉识别',
  failureActionMessaging: '消息发送',
  failureActionFileRead: '文件读取',
  failureActionOpen: '打开目标',
  failureActionDesktop: '桌面操作',
  failureActionGeneric: '这一步操作',
  priorTurnTools: (items: Array<{ name: string; outcome: 'success' | 'failed' }>) => (
    `上一轮确实调用了工具：${items.map(item => `${item.name}（${item.outcome === 'success' ? '成功' : '失败'}）`).join('、')}。`
  ),
  taskStatus: (status: string) => `任务状态：${status || '回执未记录'}。`,
  observedWindowTitle: (title: string) => `观察到的窗口标题：${title || '回执未记录'}。`,
  noVerifiedPriorFileRead: '上一轮没有找到与当前消息严格绑定的已验证单文件读取回执，因此我不会猜测文件或字段值。',
  ambiguousPriorFileRead: '上一轮读取了多个文件，现有回执不能唯一确定你指的是哪一个。',
  priorFileReadFacts: (
    target: string,
    fields: Array<{ name: string; value: string }>,
    missingFields: string[],
  ) => [
    `刚才读取的是 \`${target}\`。`,
    ...fields.map(field => `- ${field.name}：\`${field.value}\``),
    missingFields.length > 0
      ? `该次已验证读取结果中没有记录字段：${missingFields.join('、')}。`
      : '',
  ].filter(Boolean).join('\n'),
} as const;
