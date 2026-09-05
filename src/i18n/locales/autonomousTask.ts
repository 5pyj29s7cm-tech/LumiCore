import type { Locale } from '../runtime';

const COPY = {
  en: {
    completed: 'This autonomous task is complete.',
    cancelled: 'This autonomous task was stopped.',
    failed: 'This autonomous task did not finish. You can ask me to retry later.',
  },
  zh: {
    completed: '这项自主任务已经完成。',
    cancelled: '这项自主任务已经停止。',
    failed: '这项自主任务暂时没有完成。你可以稍后让我重试。',
  },
} as const;

export function autonomousTaskCopy(locale: Locale) {
  return COPY[locale];
}
