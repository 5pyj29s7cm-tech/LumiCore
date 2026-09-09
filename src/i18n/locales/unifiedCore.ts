const COPY = {
  zh: {
    backgroundTitle: '后台工作',
    backgroundDetail: 'Lumi 的对话、办事与学习共用一个核心，无需选择模式。后台工作按已授权的流程、时段和用量限制运行。',
    enabled: '允许后台处理',
    enabledDetail: '运行已启用的学习流程和任务队列；关闭后仍可正常对话和主动交办任务。',
    idle: '仅在空闲时运行',
    idleDetail: '后台工作等待你空闲时再运行。',
    failed: '后台工作设置未保存，请重试。',
  },
  en: {
    backgroundTitle: 'Background work',
    backgroundDetail: 'Conversation, tasks and learning share one Lumi core. Background work follows authorized workflows, schedules and resource limits.',
    enabled: 'Allow background processing',
    enabledDetail: 'Run enabled learning workflows and task queues. Turning this off keeps conversation and direct requests available.',
    idle: 'Run only when idle',
    idleDetail: 'Background work waits until you are idle.',
    failed: 'Background settings could not be saved. Please retry.',
  },
};
export const unifiedCoreCopy = (locale: 'zh' | 'en') => COPY[locale];
