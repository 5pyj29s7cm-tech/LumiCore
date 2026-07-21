export const CN_EXECUTION_EVIDENCE_MESSAGES = {
  inventedToolMode: '实际上没有发生这个模式切换。Fetcher / System Diagnostics 不是需要用户切换的运行模式；本轮实际声明的工具列表才是准确状态。',
  inventedToolAvailability: '本轮没有真实回执证明“工具没打开”，也不存在需要你切换的“工具可用模式”。如果任务没有执行，Lumi 应该继续真实工具链，不能把内部路由问题推给你。',
} as const;

