export const CN_DURABLE_EXECUTION_MESSAGES = {
  modelFailure:
    '本轮没有生成可靠回复，也没有据此执行新操作。请直接重试当前消息。',
  capabilityCandidatePersistenceLabel: '候选记录持久化',
  capabilityCandidatePersistenceDetail:
    '候选已记录，但数据库写入不构成能力验证；必须经过真实实验和终态回执后才能晋级为可复用能力。',
  noExecutableToolResult:
    '本次请求尚未完成，暂未取得可确认的处理结果。已有信息不需要重复提供。',
  verifiedStatus: '已验证',
  unverifiedStatus: '尚未确认完成',
  recoveryBudgetExhausted:
    '本次请求尚未全部完成。',
  resumeFromVerifiedArtifacts:
    '以上文件已生成；本次请求尚未全部完成。',
  resumeWithoutVerifiedArtifacts:
    '可能已生成文件，但尚未确认可交付成果。',
  terminalVerificationPassed: '已通过终态核验',
  verifiedCheckpointHeading: '已核验的执行结果：',
  verifiedCheckpointContinuation: '当前进度与回执仍可用于继续后续步骤。',
} as const;


export const CN_TOOL_LOOP_MESSAGES = {
  lumiClientNotOperated: "我还没有真正操作 Lumi 客户端。刚才没有拿到成功的客户端状态读取或界面动作记录；下一步我需要先读取状态，再执行对应的客户端动作，并按验证结果告诉你。",
  desktopActionUnverified: "我还没有拿到可确认的桌面动作结果。下一步我需要继续打开、聚焦或检查真实窗口，看到窗口/进程验证后再告诉你完成。",
  promisedActionNotStarted: "我刚才没有真正执行成功：没有记录到对应工具的成功结果。下一步我需要重新调用真实工具，并在聊天窗里同步处理进度。",
  toolIterationLimit: "这轮工具处理次数到上限了，我还没来得及整理成最终结论。你可以直接让我继续，我会从已经执行到的位置接着处理，不会假装已经完成。",
  noVerifiedGeneratedFile: "这轮没有检测到已生成的可验证文件。请让我继续当前请求，或重新指定要处理的文件/路径。",
  confirmationRequired: "这一步被本地安全边界拦住了，需要你确认后才能继续。我不会把需要确认的动作说成已经完成。",
  databaseTool: "数据库查询",
  filesystemTool: "文件系统访问",
  desktopTool: "桌面控制",
  browserTool: "网页/浏览器操作",
  messagingTool: "消息操作",
  installationTool: "安装/技能操作",
  statusTool: "状态检查",
  controlledTool: "任务处理",
  confirmationBlockedProgress: "我开始处理了，但中途卡在需要你确认的安全边界上，还没有完成这件事。",
  confirmationOnlyPendingAction: "回复“确认”只会授权这一个待执行动作；确认前我不会把它说成已经完成。",
  notCompletedStatus: "未成功",
  progressHeading: "这轮进展：",
  verifiedArtifactsHeading: "已确认的产物：",
  blockedStep: (labels: string) => `卡住的步骤：${labels}。`,
  alreadyChecked: (labels: string) => `已经检查过：${labels}。`,
} as const;
