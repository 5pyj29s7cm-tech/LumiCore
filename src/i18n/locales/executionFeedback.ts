import type { Locale } from '../runtime';

const COPY = {
  en: {
    confirmation: 'Confirm the specific action shown above; execution will continue from this step.',
    cancelled: 'The task was cancelled; its context and receipts were retained.',
    uncertainExternal: 'The prior external action has an uncertain outcome; verify it before retrying to avoid duplication.',
    capabilityUnavailable: 'The required tool or connection is unavailable; enable it in Settings, then retry this step.',
    retainedBlocker: 'This step is not complete; the original goal, completed steps, and receipts were retained.',
    progressConfirmation: 'Waiting for your confirmation; execution will continue afterward.',
    progressBlocked: 'The current step is not complete; its context and receipts were retained.',
  },
  zh: {
    confirmation: '请确认上方列出的具体操作；确认后会从当前步骤继续。',
    cancelled: '任务已取消，已有上下文和回执已保留。',
    uncertainExternal: '上一步是否已对外生效尚未确认；需要先核对结果，避免重复执行。',
    capabilityUnavailable: '当前缺少所需工具或连接；在设置中启用后即可从本步重试。',
    retainedBlocker: '这一步尚未完成；原目标、已执行步骤和回执已保留。',
    progressConfirmation: '等待你确认具体操作，确认后会继续。',
    progressBlocked: '当前步骤尚未完成，上下文和回执已保留。',
  },
} as const;

export function executionFeedbackCopy(locale: Locale) {
  return COPY[locale];
}
