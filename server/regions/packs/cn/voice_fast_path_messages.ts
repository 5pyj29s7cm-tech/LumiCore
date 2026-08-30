const INTERNAL_EXECUTION_DETAIL_RE = /(?:No successful (?:current-turn )?tool execution|这一轮没有.{0,40}(?:真实)?工具执行|我还不能说正在执行|先真正调用对应工具|\ballowedTools\b|\bappTarget\b|\bUI\s*evidence\b|work product guard|action contract|Required completion evidence|Preferred tools|Verification tools|tool route|tool protocol|Maximum tool call iterations|<\/?function_calls?>|<invoke\b)/i;

export function isInternalExecutionDetail(value: string): boolean {
  return INTERNAL_EXECUTION_DETAIL_RE.test(String(value || ''));
}

export function formatCnToolFailureDetail(error: string): string {
  const raw = String(error || '').trim();
  if (!raw) return '系统没有返回可核实的失败原因。';
  if (/previous runtime ended|pending confirmation expired/i.test(raw)) {
    return '上一次客户端运行结束时任务尚未收尾，已停在最后一个可验证步骤，可以从这里继续。';
  }
  if (isInternalExecutionDetail(raw)) {
    return '这一步没有拿到可执行的入口或可验证的结果，已停止，没有冒充完成。';
  }
  if (/forbidden|not in allowedTools/i.test(raw)) return '当前任务路由没有授权所需的执行工具。';
  if (/requested WeChat conversation was not verified|conversation-selection/i.test(raw)) {
    return '联系人搜索后没有确认进入目标聊天窗口；为避免误发，已在粘贴和回车前停止。';
  }
  if (/Recipient pronoun could not be resolved/i.test(raw)) return '“他/她”没有解析到明确的微信联系人；为避免发错人，没有搜索或发送。';
  if (/WeChat is not the foreground|no longer foreground|did not leave WeChat in the foreground/i.test(raw)) {
    return '微信没有保持在前台，已停止后续操作。';
  }
  if (/access denied.{0,160}account is in good standing|account is in good standing.{0,160}access denied/i.test(raw)) {
    return '桌面视觉核验服务拒绝了请求；请检查当前视觉模型账号状态、余额和访问权限，恢复后再重试。';
  }
  if (/timed?\s*out|timeout/i.test(raw)) {
    return '桌面操作在等待启动或窗口回执时超时，已停止本次执行，没有重复打开。';
  }
  if (/not found|cannot find|could not find|ENOENT/i.test(raw)) return '系统没有找到对应的应用、文件或网址入口。';
  if (/[㐀-鿿]/u.test(raw) && !/(?:锟斤拷|鈥|Ã|â€|�)/u.test(raw)) return raw.slice(0, 180);
  return '系统返回执行失败，但原始错误不是可直接展示的中文信息。';
}

const CLIENT_ACTION_LABELS: Readonly<Record<string, string>> = {
  open_chat: '聊天界面',
  open_command_center: '指挥中心',
  open_nexus: 'OS 核心',
  open_skills: '技能大厅',
  show_knowledge_base: '知识库',
  open_computer_adaptation: '运行日志',
  open_notifications: '通知中心',
  open_reminders: '提醒面板',
  open_settings: '设置',
  focus_home: '主界面',
};

export function formatCnClientActionTargetLabel(action: string, fallback = ''): string {
  return CLIENT_ACTION_LABELS[String(action || '').trim()] || fallback || 'Lumi 界面';
}

export const CN_VOICE_FAST_PATH_MESSAGES = {
  genericToolAction: '请求的操作',
  audible: '能听见。你说。',
  opening: (target: string) => `正在打开${target}。`,
  opened: (target: string) => `已打开${target}。`,
  partialOpen: (target: string) => `已打开${target}，但后续操作还没有验证成功。`,
  postOpenObservationIncomplete: '后续窗口焦点核验没有完成，但这不影响已经完成的打开动作。',
  partialArtifact: (path: string) => `文件已生成：${path}。但没有在目标应用中完成对应操作。`,
  openFailed: (target: string, error: string) => `这次没能打开${target}：${formatCnToolFailureDetail(error)}`,
  openReceiptMissing: (target: string) => `这次没有拿到${target}的启动回执。`,
  openConfirmedByUser: '好，已经打开了。',
  interruptedActivity: (task: string) => `刚才在处理“${task}”，被你打断后还没有完成。`,
  idleActivity: '现在没有正在执行的任务，我在听你说。',
  confirmationExecuted: '已执行你刚刚确认的操作。',
  confirmationFailed: (error: string) => `已收到确认，但这次执行失败：${formatCnToolFailureDetail(error)}`,
  operationModeStatus: (mode: string) => {
    const labels: Record<string, string> = {
      chat: '聊天模式',
      assistant: '助理模式',
      autonomous: '自主模式',
      meeting: '会议模式',
    };
    return `当前是${labels[mode] || labels.assistant}。`;
  },
  operationModeChanged: (mode: string) => {
    const labels: Record<string, string> = {
      chat: '聊天模式',
      assistant: '助理模式',
      autonomous: '自主模式',
      meeting: '会议模式',
    };
    return `已切到${labels[mode] || labels.assistant}。`;
  },
  knowledgeStats: (raw: string, error?: string) => {
    if (error) return `这次没能读取知识库统计：${formatCnToolFailureDetail(error)}`;
    try {
      const stats = JSON.parse(String(raw || '{}'));
      const total = Number(stats.totalFiles || 0);
      const indexed = Number(stats.indexedFiles || 0);
      const partial = Number(stats.partialFiles || 0);
      const failed = Number(stats.failedFiles || 0);
      const files = Array.isArray(stats.files) ? stats.files : [];
      const pending = files.filter((file: any) => String(file?.status || '') === 'pending').length;
      const names = files
        .map((file: any) => String(file?.name || '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const blocked = files
        .filter((file: any) => Array.isArray(file?.blockers) && file.blockers.length > 0)
        .slice(0, 3)
        .map((file: any) => `${String(file?.name || '未命名文件')}：${file.blockers.join('、')}`);
      const status = total > 0
        ? `，其中已索引${indexed}个${pending ? `、待索引${pending}个` : ''}${partial ? `、部分索引${partial}个` : ''}${failed ? `、异常${failed}个` : ''}`
        : '';
      const availability = total === 0
        ? '当前知识库为空'
        : indexed === total && failed === 0 && blocked.length === 0
          ? '当前知识库可用'
          : indexed > 0
            ? '当前知识库部分可用'
            : '当前知识库尚不可用';
      return `${availability}，共有${total}个文件${status}${names.length ? `。文件包括：${names.join('、')}` : '。'}${blocked.length ? `。当前阻塞：${blocked.join('；')}` : '。当前没有文件级错误或阻塞记录。'}`;
    } catch {
      return '这次没有拿到可解析的知识库统计结果。';
    }
  },
  readingKnowledgeStats: '正在读取知识库统计。',
} as const;

export const CN_VOICE_WORK_MESSAGES = {
  workAccepted: '已收到任务，正在分析并准备执行。',
  queuedWork: '收到，这个操作已经排在当前任务后面，当前任务完成后我会自动接着执行。',
  coordinatingParallelWork: '正在协调并行任务',
  executingCurrentStep: '正在执行当前步骤',
  currentStep: '执行当前步骤',
  drawingStep: '处理图纸',
  webStep: '处理网页',
  messageStep: '处理消息',
  researchStep: '查找资料',
  documentStep: '整理文件',
  desktopStep: '操作桌面',
  clientStep: '检查客户端',
  completedStep: (label: string) => `刚完成${label}`,
  failedStep: (label: string) => `${label}时遇到了问题`,
  runningStep: (label: string) => `正在${label}`,
  progressWithStep: (step: string) => `还在继续，当前${step}。`,
  coordinatingTask: (task: string) => `还在继续，正在并行处理${task || '这个任务'}。`,
  continuingTask: (task: string) => `还在继续处理${task || '这个任务'}，没有停。`,
  modelRoutesUnavailable: '当前配置的模型暂时都不可用，这次处理没有完成。检查模型服务或余额后，可以直接重试。',
  processingFailed: '这次没有完成处理，已经停止，你可以直接继续说。',
  processingTimedOut: '这次处理超时，已经停止，不会在后台继续。',
} as const;

export const CN_TASK_EXECUTION_MESSAGES = {
  persistenceUnknown: '本轮最终状态未能可靠保存，我没有把它标记为完成。若刚才涉及外部操作，请先核对实际结果后再重试。',
  noResumableTask: '现在没有可续接的工作任务。',
  goalWithCurrentStep: (goal: string, step: string) => `${goal}；当前步骤：${step}`,
  completed: (goal: string, receiptCount: number) => `“${goal}”已完成${receiptCount ? `，已核对${receiptCount}个执行回执` : ''}。`,
  completedFromUserObservation: (goal: string) => `好，以你看到的桌面结果为准，“${goal}”记为已完成。`,
  waitingConfirmation: (goal: string) => `“${goal}”正在等你确认下一步；确认后会续接原任务，不会重新路由。`,
  reconfirmationRequired: (goal: string) => `“${goal}”上次等待确认的具体操作只存在于已结束的客户端进程中，重启后无法安全恢复，所以我没有执行旧操作。请让我重新生成并展示这一步的目标、参数和影响；你审阅新提议后再确认。`,
  blocked: (goal: string, detail: string) => `“${goal}”还没完成。最后阻塞在：${detail}任务上下文已经保留，你可以让我从这一步继续，不需要重新描述。`,
  executing: (goal: string, receiptCount: number) => `“${goal}”还在执行链上${receiptCount ? `，已完成${receiptCount}个可验证步骤` : ''}。`,
  activeWithoutReceipt: '当前任务仍在执行，暂时还没有终态回执。',
  cancelled: '已停止当前任务，未完成的步骤不会继续执行。',
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

export const CN_RESULT_GROUNDING_MESSAGES = {
  desktopObservationLabel: '桌面状态读取',
  priorDiagnosticUnsupported: '刚才没有可核实的客户端自检工具回执。我不能把延迟解释成“在跑自检”；只能确认那一轮没有记录到客户端自检。',
  clientStateProtocolBlocked: '我还没有读取到当前客户端状态，不能把内部工具请求当作回答。',
  toolProtocolBlocked: '这轮工具请求没有被执行，内部协议文本已拦截。',
  unverifiedExecutionActivity: '这轮没有启动新的执行任务；刚才的回复混入了旧任务内容。',
  actionNotStarted: '这轮没有任何工具执行回执；刚才只说了方案，实际还没开始。不能把计划当成执行结果。',
  desktopSoftwareShortcutCount: (count: number) => `桌面上有 ${count} 个软件快捷方式。`,
  desktopSnapshotIntro: '本轮桌面状态读取已完成，结果来自当前桌面客户端的本次采样。',
  processSnapshot: (count: number, names: string[]) => `运行快照：已读取 ${count} 条活跃进程记录${names.length ? `，前几项为 ${names.join('、')}` : ''}。`,
  processSnapshotCaveat: '这是一次瞬时采样；仅凭这次结果，不能判定内存泄漏、程序卡死或长期稳定性。',
  wpsExactTextWritten: (documentName: string, requestedText: string) => `已在可见 WPS 文档“${documentName}”中精确写入：${requestedText}`,
  wpsBlankDocumentCreated: (documentName: string) => `已在 WPS 中新建可见空白文档“${documentName}”。`,
  wpsWindow: (windowTitle: string) => `窗口：${windowTitle}`,
  wpsProcess: (processId: number) => `进程：wps.exe (PID ${processId})`,
  wpsUnsaved: '当前未保存。',
} as const;

export const CN_VOICE_QUICK_WORK_MESSAGES = {
  readingRuntimeWork: (cancelling: boolean) => cancelling ? '正在停止当前工作。' : '正在查看当前工作。',
  runtimeReadFailed: '这次没能读取任务状态，没有擅自报告成功。',
  runtimeCancellationResultMissing: '这次没有可展示的任务停止结果。',
  noActiveWork: '当前没有正在运行的工作。',
  runtimeCleanupOffer: (count: number) => `当前有 ${count} 项后台工作仍可撤回。要不要我帮你清理这些后台任务？`,
  runtimeStatusWithOffer: (summary: string) => `${summary}\n要不要我帮你清理这些后台任务？`,
  workCancelling: (count: number) => `已发出停止指令，${count} 项工作正在收尾。`,
  workCancelled: (count: number) => `已停止 ${count} 项工作。`,
  activeWork: (count: number, titles: string[]) => `当前有 ${count} 项工作在运行${titles.length ? `：${titles.join('、')}` : '。'}`,
  runtimeReceiptInvalid: '任务状态回执无法验证，我不会把它说成已完成。',
  readingProcesses: '正在读取当前运行进程。',
  processReadFailed: '这次没能读取当前运行进程。',
  processSummary: (entryCount: number, uniqueCount: number) => `当前快照返回 ${entryCount} 个进程条目，合并后有 ${uniqueCount} 个不同进程名。`,
  processExamples: (names: string) => `其中包括：${names}。`,
  processSnapshotCaveat: '这是有上限的进程快照，不等同于打开的软件数。',
  processReceiptInvalid: '已读取当前运行进程，但返回格式无法统计。',
  adjustingWindow: '正在调整窗口。',
  windowControlFailed: '这次没能调整窗口，并没有冒充成功。',
  windowActionLabels: {
    maximize: '最大化',
    minimize: '最小化',
    restore: '还原',
  } as const,
  windowAdjusted: (label: string, target: string) => `已${label}${target || '当前窗口'}。`,
  windowTargetMismatch: '目标窗口没有在前台，我没有操作其他窗口。',
  windowNotVerified: '窗口状态没有验证成功。',
  windowReceiptInvalid: '窗口操作回执无法验证。',
} as const;

export const CN_ACTION_CONTRACT_BLOCKERS = {
  taskControl: (failure: string) => failure
    ? `这次没能读取或停止当前任务：${failure}。`
    : '这次没有拿到当前任务状态的可验证结果，所以没有冒充成功。',
  messagingRead: (failure: string) => failure
    ? `这次没能读取当前聊天：${failure}。`
    : '这次还没有读到并验证当前聊天的可见内容。',
  cadDrafting: (failure: string) => failure
    ? `这次还没有完成 AutoCAD 前台绘图：${failure}。`
    : '这次还没有完成并验证 AutoCAD 前台绘图。',
  generic: (failure: string) => [
    failure ? `这一步还没有完成：${failure}。` : '这一步还没有拿到可验证的执行结果。',
    '我没有把未执行或未验证的动作说成已经完成。',
  ].join('\n'),
} as const;
