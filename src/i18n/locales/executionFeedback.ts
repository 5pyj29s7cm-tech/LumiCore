import type { Locale } from '../runtime';

const COPY = {
  en: {
    confirmation: 'Confirm the specific action shown above; execution will continue from this step.',
    cancelled: 'The task was stopped. Unfinished steps will not continue.',
    uncertainExternal: 'I cannot confirm whether the last external action took effect. I will not repeat it until the result is checked.',
    capabilityUnavailable: 'A connection or setting needed for this step is unavailable. Enable it in Settings, then try again.',
    targetChanged: 'This did not finish because the active window or target changed. Select the intended target, then try again.',
    retainedBlocker: 'This did not finish. Check the reason above, then try again when ready.',
    progressConfirmation: 'Waiting for your confirmation; execution will continue afterward.',
    progressBlocked: 'This did not finish. See the reply above for what to do next.',
  },
  zh: {
    confirmation: '请确认上方列出的具体操作；确认后会从当前步骤继续。',
    cancelled: '任务已停止，未完成的步骤不会继续。',
    uncertainExternal: '我暂时无法确认上一步是否已经生效。核对结果前，我不会重复执行。',
    capabilityUnavailable: '当前缺少完成这一步所需的连接或配置；在设置中启用后即可重试。',
    targetChanged: '这次还没完成，因为当前窗口或目标已经变化。请重新选中目标后重试。',
    retainedBlocker: '这次还没有完成。请根据上方原因处理后重试。',
    progressConfirmation: '等待你确认具体操作，确认后会继续。',
    progressBlocked: '这次还没有完成，请以上方回复中的原因和下一步为准。',
  },
} as const;

export function executionFeedbackCopy(locale: Locale) {
  return COPY[locale];
}
