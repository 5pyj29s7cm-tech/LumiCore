export const CN_EXECUTION_EVIDENCE_MESSAGES = {
  inventedToolMode: '实际上没有发生这个模式切换。Fetcher / System Diagnostics 不是需要用户切换的运行模式；本轮实际声明的工具列表才是准确状态。',
  inventedToolAvailability: '本轮没有真实回执证明“工具没打开”，也不存在需要你切换的“工具可用模式”。如果任务没有执行，Lumi 应该继续真实工具链，不能把内部路由问题推给你。',
  ledgerOnlyTaskCompletion: '任务账本只证明了记账或状态写回，不证明任务步骤已实际执行。本轮没有真实动作的已验证终态回执，不能将该步骤标记为完成。',
  recoveryExecutorDidNotStart: '\u6267\u884c\u5668\u4ecd\u672a\u9009\u62e9\u6216\u542f\u52a8\u53ef\u5b8c\u6210\u8be5\u4efb\u52a1\u7684\u5de5\u5177',
  recoveryNotCompleted: '\u8fd9\u9879\u4efb\u52a1\u8fd8\u6ca1\u6709\u6267\u884c\u6210\u529f\u3002',
  recoveryBlocker: (detail: string) => `\u5177\u4f53\u963b\u585e\uff1a${detail}\u3002`,
  recoveryRetained: '\u6211\u5df2\u4fdd\u7559\u539f\u76ee\u6807\u3001\u5df2\u6267\u884c\u6b65\u9aa4\u548c\u56de\u6267\uff1b\u4e0d\u4f1a\u628a\u8fd9\u6b21\u5931\u8d25\u8bf4\u6210\u5b8c\u6210\uff0c\u4e5f\u4e0d\u4f1a\u8981\u6c42\u4f60\u5904\u7406\u5185\u90e8\u6d41\u7a0b\u3002\u540e\u7eed\u6761\u4ef6\u6062\u590d\u540e\u53ef\u4ece\u5f53\u524d\u72b6\u6001\u7ee7\u7eed\u3002',
} as const;
