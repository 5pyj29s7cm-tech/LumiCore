import type { Locale } from '../runtime';

const COPY = {
  en: {
    title: 'Execution feedback',
    details: 'Task details',
    backgroundWork: 'Background work',
    backgroundWorkDetail: 'Durable task outcomes backed by terminal receipts.',
    noBackgroundWork: 'No background task is recorded yet.',
    completed: 'Completed items',
    evidence: 'Machine evidence',
    incomplete: 'Incomplete items',
    blockers: 'Blockers',
    nextSteps: 'Next steps',
    result: 'Result',
    error: 'Error',
    workers: 'Workers',
    updated: 'Updated',
    empty: {
      completed: 'No completed item recorded.',
      evidence: 'No machine evidence recorded.',
      incomplete: 'No incomplete item recorded.',
      blockers: 'No blocker recorded.',
      nextSteps: 'No next step recorded.',
    },
    status: {
      completed: 'Verified complete',
      blocked: 'Blocked',
      failed: 'Failed',
      cancelled: 'Cancelled',
      working: 'Working',
      unknown: 'Unknown',
    },
  },
  zh: {
    title: '执行反馈',
    details: '任务详情',
    backgroundWork: '后台任务',
    backgroundWorkDetail: '由终态回执支撑的持久任务结果。',
    noBackgroundWork: '尚无后台任务记录。',
    completed: '已完成项',
    evidence: '机器证据',
    incomplete: '未完成项',
    blockers: '阻塞项',
    nextSteps: '下一步',
    result: '结果',
    error: '错误',
    workers: '执行者',
    updated: '更新时间',
    empty: {
      completed: '暂无已完成项。',
      evidence: '暂无机器证据。',
      incomplete: '暂无未完成项。',
      blockers: '暂无阻塞项。',
      nextSteps: '暂无下一步。',
    },
    status: {
      completed: '已验证完成',
      blocked: '已阻塞',
      failed: '失败',
      cancelled: '已取消',
      working: '执行中',
      unknown: '未知',
    },
  },
} as const;

export function taskCompletionFeedbackCopy(locale: Locale) {
  return COPY[locale];
}
