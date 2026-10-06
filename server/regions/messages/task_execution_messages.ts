export const CN_TASK_EXECUTION_MESSAGES = {
  persistenceUnknown: '本轮最终状态未能可靠保存，我没有把它标记为完成。若刚才涉及外部操作，请先核对实际结果后再重试。',
  cancellationOutcomeUnknown: '已停止继续执行，已完成的步骤会保留。但还有已开始的操作未返回可靠结果，请先核对实际情况后再重试。',
  noResumableTask: '现在没有可续接的工作任务。',
  goalWithCurrentStep: (goal: string, step: string) => `${goal}；当前步骤：${step}`,
  completed: (goal: string, receiptCount: number) => `“${goal}”已完成${receiptCount ? `，已核对${receiptCount}个执行回执` : ''}。`,
  completedFromUserObservation: (goal: string) => `好，以你看到的桌面结果为准，“${goal}”记为已完成。`,
  waitingConfirmation: (goal: string) => `“${goal}”正在等你确认下一步；确认后会续接原任务，不会重新路由。`,
  reconfirmationRequired: (goal: string) => `“${goal}”上次等待确认的具体操作只存在于已结束的客户端进程中，重启后无法安全恢复，所以我没有执行旧操作。请让我重新生成并展示这一步的目标、参数和影响；你审阅新提议后再确认。`,
  blocked: (goal: string, detail: string) => `“${goal}”还没完成。最后阻塞在：${detail}任务上下文已经保留，你可以让我从这一步继续，不需要重新描述。`,
  executing: (goal: string, receiptCount: number) => `“${goal}”还在执行链上${receiptCount ? `，已完成${receiptCount}个可验证步骤` : ''}。`,
  resumableNotRunning: (goal: string, receiptCount: number) => `“${goal}”的任务上下文仍然保留${receiptCount ? `，已有${receiptCount}个可验证步骤` : ''}，但当前没有正在运行的执行请求。`,
  activeWithoutReceipt: '当前任务仍在执行，暂时还没有终态回执。',
  cancelled: '已停止当前任务，未完成的步骤不会继续执行。',
  statusCancelled: (goal: string) => `“${goal || '刚才的任务'}”已经停止，未完成的步骤不会继续。`,
  statusFreshConfirmation: (goal: string) => `“${goal}”上次的确认已经失效，我没有执行旧操作。需要重新生成并展示这一步；请审阅新提议后再确认。`,
  statusWaitingConfirmation: (goal: string) => `“${goal}”正在等你确认。确认后会接着完成剩余步骤。`,
  statusFailed: (goal: string, detail: string, completedSteps: number) => (
    `“${goal}”还没完成：${detail}。${completedSteps ? '已经完成的部分不会重做，' : ''}你说“继续”就会从这里重试。`
  ),
  statusCompleted: (goal: string) => `“${goal}”已完成。`,
  statusActive: (goal: string, completedSteps: number) => (
    `“${goal}”正在处理${completedSteps ? `，已经完成 ${completedSteps} 个步骤` : ''}。有结果后我会直接告诉你。`
  ),
  statusResumable: (goal: string, completedSteps: number) => (
    `“${goal}”还没完成，目前也没有在后台运行。${completedSteps ? '已经完成的部分不会重做，' : ''}你说“继续”就能从这里接上。`
  ),
  terminalCannotCancel: (goal: string, status: string) => status === 'completed'
    ? `“${goal || '刚才的任务'}”已经完成，取消不会撤销已经发生并记录的结果；我没有再次执行任何操作。`
    : `“${goal || '刚才的任务'}”已经处于${status === 'cancelled' ? '已取消' : '终态'}，没有可继续停止的步骤；我没有再次执行任何操作。`,
  staleControl: '这条控制请求对应的任务已经变化，我没有停止后来开始的任务。',
  noPendingConfirmation: '没有新的待确认动作；不会重复执行。',
  noRepeatableReply: '上一条没有可复述的 Lumi 回复。',
  actionTurnBusy: '上一条任务仍在收尾；这条新指令没有并入旧任务，也没有开始执行。请等上一条结束后再试。',
  queueWaitTimedOut: '等待上一条任务收尾超时；这条指令没有开始执行，也没有并入旧任务。你可以先说“停止”，或稍后直接重试。',
  cancellationSettlementTimedOut: '已经向旧任务发出停止信号，但它没有在限定时间内确认退出。我不会把它误报为“已停止”；可以稍后查询状态或重试。',
  actionTurnStale: '这条指令对应的会话记录已经失效；我没有执行，也没有把它并入其他任务。请重新发送一次。',
  confirmationFailed: (detail: string) => `确认的操作执行失败：${detail}`,
  confirmationExecuted: '已执行刚才确认的操作。',
  feedback: {
    noBlocker: '目前没有新的阻塞。',
    noUserAction: '暂时不需要你操作。',
    continueAndVerify: '继续当前未完成步骤，并在拿到可验证回执后更新状态。',
    cancelledBlocker: '任务已按你的要求停止。',
    restartAfterCancel: '如需恢复，请重新说明要继续的目标。',
    exactConfirmationUnavailable: '原确认动作的精确参数已经不可安全恢复。',
    reviewFreshConfirmation: '请先审阅重新生成的操作目标、参数和影响，再确认。',
    regenerateConfirmation: '重新生成并展示确认提议，不会重放旧动作。',
    replanFailedStep: '收到重试或纠正后，保留已成功回执并从失败步骤重新规划。',
    requestRetryOrCorrection: '你可以直接说“重试”或补充纠正，不需要重述整个任务。',
    terminalSettled: '任务已经终态收尾。',
    waitForInstruction: '等待你的下一条指令。',
    waitingAtConfirmation: '执行停在一次性确认边界，没有重复执行。',
    reviewCurrentConfirmation: '请审阅当前展示的目标、参数和影响后确认或取消。',
    resumeExactAction: '确认后直接恢复已保存的精确动作并验证结果。',
    resumeBlockedStep: '收到继续、重试或纠正后，保留已成功回执并从这个阻塞步骤继续。',
    resumeStoredTask: '收到“继续”或具体纠正后，从已保留的任务断点重新取得执行权。',
    format: (input: {
      activity: string;
      target: string;
      completedSteps: number;
      blocker: string;
      userAction: string;
      nextStep: string;
    }) => [
      `正在做什么：${input.activity}`,
      `当前目标：${input.target || '未记录具体目标'}。`,
      `已完成什么：${input.completedSteps ? `${input.completedSteps} 个可验证步骤` : '暂时没有可验证步骤'}。`,
      `卡在哪里：${input.blocker}`,
      `是否需要你操作：${input.userAction}`,
      `下一步：${input.nextStep}`,
    ].join('\n'),
  },
} as const;
