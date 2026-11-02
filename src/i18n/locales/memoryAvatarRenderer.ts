const copy = {
  zh: {
    checking: '正在准备人物画面…',
    characterLoading: '正在加载人物画面…',
    environmentLoading: '正在加载室内背景…',
    characterFailed: '人物资源未能加载，可重试。对话仍可继续。',
    environmentFailed: '室内背景未能加载，可重试。已加载的人物及对话仍可使用。',
    characterTimeout: '人物资源加载超时，可重试。对话仍可继续。',
    environmentTimeout: '室内背景加载超时，可重试。已加载的人物及对话仍可使用。',
    contextLost: '图形连接已中断，可重新加载形象。对话仍可继续。',
    rendererFailed: '人物画面未能初始化，可重新加载形象。对话仍可继续。',
    retry: '重新加载形象',
  },
  en: {
    checking: 'Preparing the avatar view…',
    characterLoading: 'Loading the avatar view…',
    environmentLoading: 'Loading the room…',
    characterFailed: 'The character resources could not load. Retry when ready; the conversation remains available.',
    environmentFailed: 'The room could not load. Retry when ready; any loaded character and the conversation remain available.',
    characterTimeout: 'The character resources timed out. Retry when ready; the conversation remains available.',
    environmentTimeout: 'The room timed out. Retry when ready; any loaded character and the conversation remain available.',
    contextLost: 'The graphics connection was lost. Reload the avatar; the conversation remains available.',
    rendererFailed: 'The avatar view could not initialize. Reload the avatar; the conversation remains available.',
    retry: 'Retry avatar loading',
  },
};

export const memoryAvatarRendererCopy = (locale: 'zh' | 'en') => copy[locale];
