export function formatCnToolFailureDetail(error: string): string {
  const raw = String(error || '').trim();
  if (!raw) return '系统没有返回可核实的失败原因。';
  if (/forbidden|not in allowedTools/i.test(raw)) return '当前任务路由没有授权所需的执行工具。';
  if (/requested WeChat conversation was not verified|conversation-selection/i.test(raw)) {
    return '联系人搜索后没有确认进入目标聊天窗口；为避免误发，已在粘贴和回车前停止。';
  }
  if (/Recipient pronoun could not be resolved/i.test(raw)) return '“他/她”没有解析到明确的微信联系人；为避免发错人，没有搜索或发送。';
  if (/WeChat is not the foreground|no longer foreground|did not leave WeChat in the foreground/i.test(raw)) {
    return '微信没有保持在前台，已停止后续操作。';
  }
  if (/not found|cannot find|could not find|ENOENT/i.test(raw)) return '系统没有找到对应的应用、文件或网址入口。';
  if (/[㐀-鿿]/u.test(raw) && !/(?:锟斤拷|鈥|Ã|â€|�)/u.test(raw)) return raw.slice(0, 180);
  return '系统返回执行失败，但原始错误不是可直接展示的中文信息。';
}

export const CN_VOICE_FAST_PATH_MESSAGES = {
  audible: '能听见。你说。',
  opening: (target: string) => `正在打开${target}。`,
  opened: (target: string) => `已打开${target}。`,
  openFailed: (target: string, error: string) => `这次没能打开${target}：${formatCnToolFailureDetail(error)}`,
  openReceiptMissing: (target: string) => `这次没有拿到${target}的启动回执。`,
  openConfirmedByUser: '好，已经打开了。',
  interruptedActivity: (task: string) => `刚才在处理“${task}”，被你打断后还没有完成。`,
  operationModeStatus: (mode: string) => {
    const labels: Record<string, string> = {
      chat: '聊天模式',
      assistant: '助理模式',
      autonomous: '自主模式',
      meeting: '会议模式',
    };
    return `当前是${labels[mode] || labels.assistant}。`;
  },
  knowledgeStats: (raw: string, error?: string) => {
    if (error) return `这次没能读取知识库统计：${formatCnToolFailureDetail(error)}`;
    try {
      const stats = JSON.parse(String(raw || '{}'));
      const total = Number(stats.totalFiles || 0);
      const indexed = Number(stats.indexedFiles || 0);
      const partial = Number(stats.partialFiles || 0);
      const failed = Number(stats.failedFiles || 0);
      const names = (Array.isArray(stats.files) ? stats.files : [])
        .map((file: any) => String(file?.name || '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const status = total > 0
        ? `，其中已索引${indexed}个${partial ? `、部分索引${partial}个` : ''}${failed ? `、异常${failed}个` : ''}`
        : '';
      return `知识库现在有${total}个文件${status}${names.length ? `。最近的文件包括：${names.join('、')}` : '。'}`;
    } catch {
      return '这次没有拿到可解析的知识库统计结果。';
    }
  },
  readingKnowledgeStats: '正在读取知识库统计。',
} as const;

export const CN_VOICE_WORK_MESSAGES = {
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
} as const;

export const CN_RESULT_GROUNDING_MESSAGES = {
  priorDiagnosticUnsupported: '刚才没有可核实的客户端自检工具回执。我不能把延迟解释成“在跑自检”；只能确认那一轮没有记录到客户端自检。',
  clientStateProtocolBlocked: '我还没有读取到当前客户端状态，不能把内部工具请求当作回答。',
  toolProtocolBlocked: '这轮工具请求没有被执行，内部协议文本已拦截。',
  desktopSoftwareShortcutCount: (count: number) => `桌面上有 ${count} 个软件快捷方式。`,
  desktopSnapshotIntro: '本轮桌面状态读取已完成，结果来自当前桌面客户端的本次采样。',
  processSnapshot: (count: number, names: string[]) => `运行快照：已读取 ${count} 条活跃进程记录${names.length ? `，前几项为 ${names.join('、')}` : ''}。`,
  processSnapshotCaveat: '这是一次瞬时采样；仅凭这次结果，不能判定内存泄漏、程序卡死或长期稳定性。',
} as const;
