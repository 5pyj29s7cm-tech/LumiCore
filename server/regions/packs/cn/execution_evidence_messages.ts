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
  recoveryActionMessage: '消息发送',
  recoveryEvidenceUnavailable: '暂时没有可核验的执行结果',
  recoveryEvidenceVerified: '已验证',
  recoveryEvidenceFailed: '失败',
  recoveryEvidenceUnverified: '未验证',
  recoveryStatus: (status: string) => `状态：${status}。`,
  recoveryStatusCompleted: '已完成',
  recoveryStatusFailed: '失败',
  recoveryStatusBlocked: '受阻',
  recoveryEvidence: (evidence: string) => `证据：${evidence}。`,
  recoveryNextFailed: '下一步：保留已有回执，修复具体失败后再续执行。',
  recoveryNextBlocked: '下一步：保留已有进度，先核验目标状态再继续。',
  recoveryConversationClarification: '我需要确认你的意图：这是普通对话，还是希望我对某个具体目标执行操作？如果要执行，请告诉我目标和希望发生的动作。',
  recoveryDesktopBusy: '桌面控制正被另一项操作占用',
  recoveryDesktopPaused: '检测到你正在操作桌面，自动控制已暂时停下',
  recoveryForegroundUnverified: '后续窗口核验没有确认当前前台状态',
  recoveryCapabilityMissing: '当前任务没有获得所需能力',
  recoveryServiceUnavailable: '相关服务暂时不可用',
  currentAuthoringNeedsExactFile: (target: string) => (
    `\u6211\u770b\u5230\u524d\u53f0\u662f\u300c${target}\u300d\uff0c\u4f46\u8def\u5f84\u4ecd\u672a\u77e5\uff0c\u6211\u5c1a\u672a\u8bfb\u53d6\u8be5\u6587\u4ef6\u3002\u8bf7\u5148\u4fdd\u5b58\u6587\u6863\uff0c\u6216\u76f4\u63a5\u628a\u6587\u4ef6\u53d1\u7ed9\u6211\uff0c\u6211\u5c31\u80fd\u7ee7\u7eed\u5206\u6790\u3002`
  ),
  currentAuthoringWrongForeground: (target: string) => (
    `\u6211\u73b0\u5728\u770b\u5230\u7684\u524d\u53f0\u7a97\u53e3\u662f\u300c${target}\u300d\uff0c\u4e0d\u662f\u53ef\u8bfb\u53d6\u7684 WPS\u3001Word\u3001Excel \u6216 PowerPoint \u6587\u6863\u3002\u8bf7\u5148\u628a\u8981\u5206\u6790\u7684\u6587\u6863\u5207\u5230\u524d\u53f0\uff0c\u6216\u76f4\u63a5\u628a\u6587\u4ef6\u53d1\u7ed9\u6211\u3002`
  ),
  currentAuthoringMissingForeground: '\u6211\u8fd8\u6ca1\u6709\u8bc6\u522b\u5230\u524d\u53f0\u6587\u6863\u7a97\u53e3\u3002\u8bf7\u5148\u628a\u8981\u5206\u6790\u7684\u6587\u6863\u5207\u5230\u524d\u53f0\uff0c\u6216\u76f4\u63a5\u628a\u6587\u4ef6\u53d1\u7ed9\u6211\u3002',
  compactMessagingReadNotCompleted: '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002\u5f53\u524d\u804a\u5929\u5185\u5bb9\u8fd8\u6ca1\u6709\u786e\u8ba4\uff0c\u4e0d\u80fd\u8bf4\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9\u3002',
  compactUnconfirmedFinalResult: '\u6211\u8fd8\u6ca1\u6709\u786e\u8ba4\u6700\u7ec8\u7ed3\u679c\u3002',
  compactNotCompleted: (detail: string) => `\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002${detail}`,
  visualModelAvailable: '\u89c6\u89c9\u6a21\u578b\u5f53\u524d\u53ef\u7528\uff0c\u521a\u624d\u7684\u5b9e\u6d4b\u5df2\u7ecf\u8fd4\u56de\u4e86\u53ef\u8bfb\u7ed3\u679c\u3002',
  visualProbeSucceeded: '\u89c6\u89c9\u5b9e\u6d4b\u6210\u529f\u3002',
  visualModelBillingUnavailable: '\u89c6\u89c9\u6a21\u578b\u5f53\u524d\u4e0d\u53ef\u7528\uff1a\u670d\u52a1\u5546\u56e0\u8d26\u53f7\u6b20\u8d39\u6216\u8d26\u6237\u72b6\u6001\u5f02\u5e38\u62d2\u7edd\u4e86\u8bf7\u6c42\u3002\u6062\u590d\u8d26\u53f7\u540e\u518d\u8bd5\u5373\u53ef\u3002',
  visualModelUnconfigured: '\u5f53\u524d\u6ca1\u6709\u914d\u7f6e\u53ef\u7528\u7684\u89c6\u89c9\u6a21\u578b\u3002\u5728\u8bbe\u7f6e\u4e2d\u9009\u62e9\u5e76\u4fdd\u5b58\u4e00\u4e2a\u89c6\u89c9\u6a21\u578b\u540e\u518d\u8bd5\u3002',
  visualProbeInterrupted: '\u521a\u624d\u7684\u89c6\u89c9\u68c0\u67e5\u88ab\u524d\u53f0\u64cd\u4f5c\u6253\u65ad\u4e86\uff0c\u8fd9\u6b21\u8fd8\u4e0d\u80fd\u786e\u8ba4\u6a21\u578b\u53ef\u7528\u3002',
  visualProbeUnconfirmed: '\u89c6\u89c9\u6a21\u578b\u8fd9\u6b21\u6ca1\u6709\u8fd4\u56de\u53ef\u7528\u7ed3\u679c\uff0c\u76ee\u524d\u8fd8\u4e0d\u80fd\u786e\u8ba4\u5b83\u53ef\u7528\u3002',
  genericMusicPlayer: '\u97f3\u4e50\u64ad\u653e\u5668',
  mediaPlaybackActive: (label: string) => `\u5df2\u6253\u5f00${label}\uff0c\u97f3\u4e50\u6b63\u5728\u64ad\u653e\u3002`,
  mediaPlaybackConfirmed: '\u64ad\u653e\u72b6\u6001\u5df2\u786e\u8ba4\u3002',
  mediaOpenedPlaybackUnconfirmed: (label: string) => (
    `\u5df2\u6253\u5f00${label}\uff0c\u4f46\u8fd8\u4e0d\u80fd\u786e\u8ba4\u97f3\u4e50\u5df2\u7ecf\u5f00\u59cb\u64ad\u653e\u3002\u521a\u624d\u7684\u6309\u952e\u53ea\u80fd\u786e\u8ba4\u8f93\u5165\u5df2\u9001\u8fbe\uff0c\u65e0\u6cd5\u533a\u5206\u662f\u64ad\u653e\u8fd8\u662f\u6682\u505c\u3002`
  ),
  mediaOpenAndPlaybackUnconfirmed: (label: string) => (
    `\u8fd9\u6b21\u8fd8\u6ca1\u6709\u786e\u8ba4${label}\u5df2\u6253\u5f00\uff0c\u97f3\u4e50\u4e5f\u6ca1\u6709\u786e\u8ba4\u5f00\u59cb\u64ad\u653e\u3002`
  ),
  desktopObservedOpen: (label: string) => `\u5df2\u6253\u5f00${label}\u3002`,
  desktopObservedOpenReason: '\u76ee\u6807\u9875\u9762\u6216\u7a97\u53e3\u5df2\u5728\u540c\u8f6e\u684c\u9762\u7ed3\u679c\u4e2d\u786e\u8ba4\u3002',
  toolInvocationBudgetStopped: (planned: number, boundary: 'model_response' | 'turn', limit: number) => (
    `这轮工具调用已在执行前安全停止：计划调用 ${planned} 次，超过${boundary === 'model_response' ? '单次模型响应' : '本轮累计'}硬上限 ${limit} 次。`
  ),
  toolInvocationBudgetExecuted: (executed: number) => (
    `本轮已经调用 ${executed} 次；超出上限的整批调用均未执行。`
  ),
  toolInvocationBudgetEnumExpanded: '其中包含由枚举范围展开出的调用，展开后的数量同样受硬上限约束。',
  toolInvocationBudgetNextStep: '当前回执已保留。可以缩小处理范围，或在下一轮从已验证进度继续。',
} as const;
