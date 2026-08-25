export const CN_EXECUTION_EVIDENCE_MESSAGES = {
  inventedToolMode: '实际上没有发生这个模式切换。Fetcher / System Diagnostics 不是需要用户切换的运行模式；本轮实际声明的工具列表才是准确状态。',
  inventedToolAvailability: '本轮没有真实回执证明“工具没打开”，也不存在需要你切换的“工具可用模式”。如果任务没有执行，Lumi 应该继续真实工具链，不能把内部路由问题推给你。',
  ledgerOnlyTaskCompletion: '任务账本只证明了记账或状态写回，不证明任务步骤已实际执行。本轮没有真实动作的已验证终态回执，不能将该步骤标记为完成。',
  recoveryExecutorDidNotStart: '\u6267\u884c\u5668\u4ecd\u672a\u9009\u62e9\u6216\u542f\u52a8\u53ef\u5b8c\u6210\u8be5\u4efb\u52a1\u7684\u5de5\u5177',
  recoveryNotCompleted: '\u8fd9\u9879\u4efb\u52a1\u8fd8\u6ca1\u6709\u6267\u884c\u6210\u529f\u3002',
  recoveryBlocker: (detail: string) => `\u5177\u4f53\u963b\u585e\uff1a${detail}\u3002`,
  recoveryRetained: '\u6211\u5df2\u4fdd\u7559\u539f\u76ee\u6807\u3001\u5df2\u6267\u884c\u6b65\u9aa4\u548c\u56de\u6267\uff1b\u4e0d\u4f1a\u628a\u8fd9\u6b21\u5931\u8d25\u8bf4\u6210\u5b8c\u6210\uff0c\u4e5f\u4e0d\u4f1a\u8981\u6c42\u4f60\u5904\u7406\u5185\u90e8\u6d41\u7a0b\u3002\u540e\u7eed\u6761\u4ef6\u6062\u590d\u540e\u53ef\u4ece\u5f53\u524d\u72b6\u6001\u7ee7\u7eed\u3002',
  recoveryNoVerifiableResult: '暂时没有拿到可确认的执行结果',
  recoveryActionDesktop: '桌面操作',
  recoveryActionBrowser: '浏览器操作',
  recoveryActionClient: '客户端操作',
  recoveryActionFile: '文件操作',
  recoveryActionVoice: '语音操作',
  recoveryActionCurrent: '当前操作',
  recoveryDesktopBusy: '桌面控制正被另一项操作占用',
  recoveryDesktopPaused: '检测到你正在操作桌面，自动控制已暂时停下',
  recoveryForegroundUnverified: '后续窗口核验没有确认当前前台状态',
  recoveryCapabilityMissing: '当前任务没有获得所需能力',
  recoveryServiceUnavailable: '相关服务暂时不可用',
  toolInvocationBudgetStopped: (planned: number, boundary: 'model_response' | 'turn', limit: number) => (
    `这轮工具调用已在执行前安全停止：计划调用 ${planned} 次，超过${boundary === 'model_response' ? '单次模型响应' : '本轮累计'}硬上限 ${limit} 次。`
  ),
  toolInvocationBudgetExecuted: (executed: number) => (
    `本轮已经调用 ${executed} 次；超出上限的整批调用均未执行。`
  ),
  toolInvocationBudgetEnumExpanded: '其中包含由枚举范围展开出的调用，展开后的数量同样受硬上限约束。',
  toolInvocationBudgetNextStep: '当前回执已保留。可以缩小处理范围，或在下一轮从已验证进度继续。',
} as const;
