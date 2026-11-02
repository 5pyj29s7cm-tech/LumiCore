const COPY = {
  zh: {
    title: '记忆领地', loading: '正在读取人物列表…', lazyLoading: '正在打开记忆领地…',
    load: '人物列表读取失败。请重试，或返回原界面。',
    timeout: '读取人物列表超时。请检查本地服务后重试。',
    unauthorized: '当前登录无法读取人物列表。请返回检查登录状态后重试。',
    personalScope: '记忆领地仅在个人工作区可用。请返回切换到个人工作区后重试。',
    invalid: '人物列表返回内容未通过校验，尚未打开任何人物。',
    missing: '未找到指定人物，未切换到其他人物。请刷新后重试。',
    retry: '重新读取', cancel: '取消', back: '返回',
  },
  en: {
    title: 'Memory Territory', loading: 'Loading people…', lazyLoading: 'Opening Memory Territory…',
    load: 'The people list could not be loaded. Retry or return to the previous screen.',
    timeout: 'Loading people timed out. Check the local service and retry.',
    unauthorized: 'This sign-in cannot read the people list. Return and check your sign-in before retrying.',
    personalScope: 'Memory Territory is available in the personal workspace only. Return, switch to your personal workspace, and retry.',
    invalid: 'The people list did not pass validation. No person has been opened.',
    missing: 'The requested person was not found. No other person was opened. Refresh and retry.',
    retry: 'Reload people', cancel: 'Cancel', back: 'Back',
  },
} as const;

export const memoryAvatarEntryCopy = (locale: 'zh' | 'en') => COPY[locale];
