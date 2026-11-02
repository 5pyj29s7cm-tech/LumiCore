const COPY = {
  zh: {
    retry: '重新加载面板',
    retryHint: '重试仅重新加载此面板，不会重复发送消息或开始直播。持续失败时请返回。',
    modules: {
      scene: { loading: '正在加载人物画面…', failed: '人物画面暂时无法加载。', timeout: '加载人物画面超时。', hint: '文字对话、人物选择和离开入口仍可使用。', back: '离开记忆领地' },
      portrait: { loading: '正在加载肖像画面…', failed: '肖像画面暂时无法加载。', timeout: '加载肖像画面超时。', hint: '文字对话、人物选择和离开入口仍可使用。', back: '离开记忆领地' },
      profile: { loading: '正在打开人物资料…', failed: '人物资料面板暂时无法加载。', timeout: '打开人物资料超时。', hint: '可以返回对话；尚未修改人物资料。', back: '返回对话' },
      live: { loading: '正在打开直播工作台…', failed: '直播工作台暂时无法加载。', timeout: '打开直播工作台超时。', hint: '可以返回记忆领地；尚未开始直播。', back: '返回记忆领地' },
    },
  },
  en: {
    retry: 'Reload panel',
    retryHint: 'Retry only reloads this panel. It does not resend messages or start a live session. Go back if loading keeps failing.',
    modules: {
      scene: { loading: 'Loading the character view…', failed: 'The character view could not be loaded.', timeout: 'Loading the character view timed out.', hint: 'Text chat, people selection and Leave are still available.', back: 'Leave Memory Territory' },
      portrait: { loading: 'Loading the portrait view…', failed: 'The portrait view could not be loaded.', timeout: 'Loading the portrait view timed out.', hint: 'Text chat, people selection and Leave are still available.', back: 'Leave Memory Territory' },
      profile: { loading: 'Opening the person profile…', failed: 'The person profile could not be loaded.', timeout: 'Opening the person profile timed out.', hint: 'You can return to the conversation. No profile changes have been made.', back: 'Back to conversation' },
      live: { loading: 'Opening the live workbench…', failed: 'The live workbench could not be loaded.', timeout: 'Opening the live workbench timed out.', hint: 'You can return to Memory Territory. No live session has started.', back: 'Back to Memory Territory' },
    },
  },
} as const;

export type SanctuaryModuleKind = keyof typeof COPY.en.modules;
export const sanctuaryModulesCopy = (locale: 'zh' | 'en') => COPY[locale];
