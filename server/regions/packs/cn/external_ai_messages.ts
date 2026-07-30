export const CN_EXTERNAL_AI_MESSAGES = {
  sessionStatus: (status: string, sessionId: string) => `外部 AI 协同状态：${status}（会话 ${sessionId}）`,
  lateArchiveSuffix: '，迟到回执已归档',
  answeredTarget: (label: string, source: string, lateSuffix: string, answer: string) => (
    `- ${label}：已回答；来源 ${source}${lateSuffix}\n  ${answer}`
  ),
  targetState: (label: string, status: string, source: string, detail: string) => (
    `- ${label}：${status}；来源 ${source}${detail ? `；${detail}` : ''}`
  ),
  summary: (input: {
    answered: number;
    pending: number;
    blocked: number;
    failed: number;
    late: number;
  }) => (
    `汇总：回答 ${input.answered}，等待/结果未知 ${input.pending}，阻塞 ${input.blocked}，失败 ${input.failed}`
    + `${input.late ? `，迟到归档 ${input.late}` : ''}。未回答目标不会被伪装成已完成，也不会自动换路重发。`
  ),
  historySyncStatus: (targetId: string, status: string, sourceKind: string, jobId: string) => (
    `外部 AI 历史同步：${status}；目标 ${targetId}；来源 ${sourceKind}；任务 ${jobId}。`
  ),
  historyCounts: (inserted: number, updated: number, skipped: number, conflicted: number, attachments: number, pages: number) => (
    `本次回执：新增 ${inserted}，更新 ${updated}，去重跳过 ${skipped}，内容冲突 ${conflicted}，附件 ${attachments}，处理 ${pages} 页。`
  ),
  historyCompleteness: (completeness: string, nextCursor: string) => (
    `完整性：${completeness}${nextCursor ? `；可从游标 ${nextCursor} 继续` : ''}。`
  ),
  historyBlocker: (detail: string) => `同步未完成：${detail}`,
  historyLimitations: (limitations: string) => `限制：${limitations}`,
  historyQueryHeader: (targetId: string, count: number, completeness: string) => (
    `已从 ${targetId} 的本地授权历史中读取 ${count} 条消息；完整性：${completeness}。`
  ),
  historyMessage: (role: string, content: string, messageId: string) => (
    `- ${role}（${messageId}）：${content}`
  ),
  historySourceState: (status: string, sourceId: string, targetId: string) => (
    `外部 AI 历史来源：${status}；目标 ${targetId}；来源 ID ${sourceId}。`
  ),
  historyNoSources: '当前作用域没有已授权的外部 AI 历史来源。',
  historyLedgerCounts: (conversations: number, messages: number, attachments: number, jobs: number) => (
    `本地账本：会话 ${conversations}，消息 ${messages}，附件 ${attachments}，同步任务 ${jobs}。`
  ),
};
