const INTERNAL_EXECUTION_DETAIL_RE = /(?:No successful (?:current-turn )?tool execution|这一轮没有.{0,40}(?:真实)?工具执行|我还不能说正在执行|先真正调用对应工具|\ballowedTools\b|\bappTarget\b|\bUI\s*evidence\b|work product guard|action contract|Required completion evidence|Preferred tools|Verification tools|tool route|tool protocol|Maximum tool call iterations|<\/?function_calls?>|<invoke\b)/i;

export const CN_MODEL_FAILURE_BEFORE_EXECUTION = '这次模型调用失败，未发起新的操作。原任务和失败记录仍然保留，可以重试。';

export function formatCnMediaGenerationFailure(errors: string[]): string {
  const details = [...new Set(errors.map(formatCnToolFailureDetail))];
  const retry = errors.some(error => /timed?\s*out|timeout|outcome is unknown/i.test(error))
    ? '先核对本次请求的服务端状态，再决定是否重试，避免重复生成。'
    : '可以按失败原因检查配置后重试。';
  return `本次生成没有完成。${details.join('\n')}\n${retry}`;
}

export function isInternalExecutionDetail(value: string): boolean {
  return INTERNAL_EXECUTION_DETAIL_RE.test(String(value || ''));
}

export function formatCnToolFailureDetail(error: string): string {
  const raw = String(error || '').trim();
  if (raw === 'model_failed_before_tool_execution') return '本轮模型调用失败，未发起新的操作；原任务仍未完成。';
  if (!raw || /^(?:undefined|null|unknown|\[object Object\])$/iu.test(raw)) {
    return '系统没有返回可核实的失败原因。';
  }
  if (/Lumi Official API request/i.test(raw)) {
    if (/模型不存在|未启用|model.{0,30}(?:not found|not exist|disabled|unavailable)/iu.test(raw)) return '当前选择的生成模型不存在或未启用，官方接口拒绝了这次请求；请核对生成模型配置。';
    if (/IP infringement/i.test(raw)) return '图片服务拒绝了这次请求，返回的原因是疑似侵犯知识产权；没有返回图片。';
    const timeoutMs = raw.match(/timed out after (\d+)ms/i)?.[1];
    if (timeoutMs) return `官方接口等待 ${Number(timeoutMs) / 1000} 秒后超时，没有收到生成结果，不能确认服务端是否仍在处理。`;
  }
  const httpStatus = raw.match(/\bHTTP\s+([1-5]\d{2})\b/iu)?.[1]
    || raw.match(/\bstatus(?:\s+code)?\s*[:=]?\s*([1-5]\d{2})\b|\b([1-5]\d{2})\s+status(?:\s+code)?\b/iu)?.slice(1).find(Boolean);
  if (httpStatus && /(?:no\s+body|empty\s+(?:body|response)|without\s+(?:a\s+)?(?:body|message))/iu.test(raw)) {
    return `服务返回 HTTP ${httpStatus}，但没有提供错误正文。`;
  }
  if (
    httpStatus
    && /(?:ocr|vision|visual|图像|视觉|识别)/iu.test(raw)
    && !/account is in good standing|overdue[- ]?payment|insufficient (?:balance|credit)/iu.test(raw)
  ) {
    return `视觉识别服务返回 HTTP ${httpStatus}，这次没有取得可用的识别结果。`;
  }
  if (/\bAbortError\b|operation was aborted|request was aborted/iu.test(raw)) {
    return '这次请求被新的输入或停止操作打断，旧请求已经结束。';
  }
  if (/previous runtime ended|pending confirmation expired/i.test(raw)) {
    return '上一次客户端运行结束时任务尚未收尾，已停在最后一个可验证步骤，可以从这里继续。';
  }
  if (/target[_ ]?mismatch|fingerprint changed|window\/display fingerprint|target application has not matched a fresh observation/i.test(raw)) {
    return '操作后看到的窗口与目标不一致。为避免继续操作错窗口，这一步已经停下。';
  }
  if (/global desktop lease|desktop.*(?:busy|occupied)/i.test(raw)) {
    return '桌面控制正被另一项操作占用，这一步没有继续。';
  }
  if (/paused_for_user_activity|desktop control is paused/i.test(raw)) {
    return '检测到你正在操作电脑，自动控制已经暂时停下。';
  }
  if (/provider unavailable|service unavailable|connection refused/i.test(raw)) {
    return '这一步需要的服务暂时不可用。';
  }
  if (isInternalExecutionDetail(raw)) {
    return '这一步没有拿到可执行的入口或可验证的结果，已停止，没有冒充完成。';
  }
  if (/forbidden|not in allowedTools|not (?:declared|allowed)|allowlist/i.test(raw)) return '当前任务没有取得所需的操作能力。';
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
    return '等待结果超时，本次执行已停止；尚不能确认服务端是否仍在处理。';
  }
  if (/not found|cannot find|could not find|ENOENT/i.test(raw)) return '系统没有找到对应的应用、文件或网址入口。';
  return '这次操作没有完成，未取得可用结果。';
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
  opened: (target: string) => `已打开${target}。`,
  partialOpen: (target: string) => `已打开${target}，但后续操作还没有验证成功。`,
  postOpenObservationIncomplete: '后续窗口焦点核验没有完成，但这不影响已经完成的打开动作。',
  partialArtifact: (path: string) => `文件已生成：${path}。但没有在目标应用中完成对应操作。`,
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
  privacyRestricted: '严格模式已停用云端 AI 和自动工具。请选用已就绪的本地模型；如果要恢复官网 API，请到“设置 → 隐私与安全”关闭严格模式，并完全退出后重新启动主程序。',
  processingFailed: '这次没有完成处理，已经停止，你可以直接继续说。',
  processingTimedOut: '这次处理超时，已经停止，不会在后台继续。',
} as const;

export const CN_RESULT_GROUNDING_MESSAGES = {
  artifactSavedReadback: (path: string) => `已保存并回读文件：${path}`,
  artifactReadbackHeading: '回读结果：',
  artifactReadbackExcerpt: (limit: number) => `这里只展示回读内容的前 ${limit} 个字符。`,
  desktopObservationLabel: '桌面状态读取',
  priorDiagnosticUnsupported: '刚才没有可核实的客户端自检工具回执。我不能把延迟解释成“在跑自检”；只能确认那一轮没有记录到客户端自检。',
  clientStateProtocolBlocked: '我还没有读取到当前客户端状态，不能把内部工具请求当作回答。',
  toolProtocolBlocked: '这轮工具请求没有被执行，内部协议文本已拦截。',
  unverifiedExecutionActivity: '这轮没有启动新的执行任务；刚才的回复混入了旧任务内容。',
  actionNotStarted: '这轮没有任何工具执行回执；刚才只说了方案，实际还没开始。不能把计划当成执行结果。',
  executionEndedWithoutCompletion: '这一轮操作已经结束，但还没有证据证明目标完成；不会继续显示“正在执行”。',
  desktopSoftwareShortcutCount: (count: number) => `桌面上有 ${count} 个软件快捷方式。`,
  desktopSnapshotIntro: '桌面信息已经更新。',
  desktopUnknownWindow: '未知窗口',
  desktopActiveWindowReadOnly: (title: string, processName: string) => (
    `当前前台窗口是「${title}」${processName ? `（${processName}）` : ''}；我只查看了窗口信息，没有进行其他操作。`
  ),
  desktopPartialRead: '我只读取到了部分桌面信息。',
  desktopUnavailableReadCount: (count: number) => `有 ${count} 项信息暂时没能读取。`,
  desktopReadOnly: '我只读取了信息，没有点击、输入、切换窗口、打开应用或修改内容。',
  processSnapshot: (count: number, names: string[]) => `当前读取到 ${count} 个运行中的进程${names.length ? `，其中包括 ${names.join('、')}` : ''}。`,
  processSnapshotCaveat: '这只是当前状态，不能单独用来判断内存泄漏、程序卡死或长期稳定性。',
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
