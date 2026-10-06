

export function normalizeClientActionTarget(value?: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();
  const aliases: Record<string, string> = {
    sanctuary: 'memory-avatar',
    memory: 'knowledge',
    home: 'home',
    main: 'home',
    'main-screen': 'home',
    chat: 'command-center',
    'command-center': 'command-center',
    command: 'command-center',
    tools: 'tools',
    tool: 'tools',
    plans: 'plans',
    plan: 'plans',
    planner: 'plans',
    'work-queue': 'plans',
    org: 'org',
    organization: 'org',
    workspace: 'org',
    'org-workspace': 'org',
    launcher: 'app-launcher',
    spotlight: 'app-launcher',
    search: 'app-launcher',
    personality: 'personality',
    'personality-lab': 'personality',
    notifications: 'notifications',
    notification: 'notifications',
    reminders: 'reminders',
    reminder: 'reminders',
    devices: 'devices',
    device: 'devices',
    'device-sync': 'devices',
    terminal: 'terminal',
    tokens: 'tokens',
    usage: 'tokens',
    profile: 'profile',
    mcp: 'mcp',
    'mcp-settings': 'mcp',
    voice: 'voice',
    'voice-forge': 'voice',
    'github-mcp': 'github-mcp',
    generate: 'generate',
    'skill-generator': 'generate',
    ecosystem: 'ecosystem',
    docs: 'docs',
    documentation: 'docs',
    founders: 'founders',
    personalization: 'personalization',
    personalize: 'personalization',
    'avatar-studio': 'personalization',
    avatar: 'personalization',
    'sound-studio': 'personalization',
    sound: 'personalization',
    'memory-avatar': 'memory-avatar',
    'memory-avatars': 'memory-avatar',
    'memory avatar': 'memory-avatar',
    'memory avatars': 'memory-avatar',
    'memory sanctuary': 'memory-avatar',
    'memory-sanctuary': 'memory-avatar',
    'memory territory': 'memory-avatar',
    'memory-territory': 'memory-avatar',
    '\u8bb0\u5fc6\u9886\u5730': 'memory-avatar', // i18n-allow: Chinese client-surface input alias; not user-visible copy.
    '\u8bb0\u5fc6\u5316\u8eab': 'memory-avatar', // i18n-allow: Chinese client-surface input alias; not user-visible copy.
    '\u8bb0\u5fc6\u5934\u50cf': 'memory-avatar', // i18n-allow: Chinese client-surface input alias; not user-visible copy.
    '\u8bb0\u5fc6\u7a7a\u95f4': 'memory-avatar', // i18n-allow: Chinese client-surface input alias; not user-visible copy.
    files: 'knowledge',
    file: 'knowledge',
    sync: 'devices',
    computer: 'kernel',
    adaptation: 'kernel',
    'computer-adaptation': 'kernel',
    widget: 'widget',
    'desktop-widget': 'widget',
    'desktop-widget-mode': 'widget',
    nexus: 'nexus',
    world: 'nexus',
    'world-view': 'nexus',
    'nexus-view': 'nexus',
    'cloud-canvas': 'nexus',
    'central-world': 'nexus',
    '中枢': 'nexus', // i18n-allow: Client surface input alias; not display copy.
    '中枢世界': 'nexus', // i18n-allow: Client surface input alias; not display copy.
    '桌面小组件': 'widget', // i18n-allow: Client surface input alias; not display copy.
    '小组件': 'widget', // i18n-allow: Client surface input alias; not display copy.
    '主屏幕': 'home', // i18n-allow: Client surface input alias; not display copy.
    '主页': 'home', // i18n-allow: Client surface input alias; not display copy.
    '首页': 'home', // i18n-allow: Client surface input alias; not display copy.
    '聊天': 'command-center', // i18n-allow: Client surface input alias; not display copy.
    '聊天窗口': 'command-center', // i18n-allow: Client surface input alias; not display copy.
    '应用启动器': 'app-launcher', // i18n-allow: Client surface input alias; not display copy.
    '应用搜索': 'app-launcher', // i18n-allow: Client surface input alias; not display copy.
    '人格': 'personality', // i18n-allow: Client surface input alias; not display copy.
    '人格实验室': 'personality', // i18n-allow: Client surface input alias; not display copy.
    '工具': 'tools', // i18n-allow: Client surface input alias; not display copy.
    '工具面板': 'tools', // i18n-allow: Client surface input alias; not display copy.
    '个性化': 'personalization', // i18n-allow: Chinese client-surface input alias; not user-visible copy.
    '形象': 'personalization', // i18n-allow: Client surface input alias; not display copy.
    '头像': 'personalization', // i18n-allow: Client surface input alias; not display copy.
    '头像工作室': 'personalization', // i18n-allow: Client surface input alias; not display copy.
    '形象设计室': 'personalization', // i18n-allow: Chinese legacy client-surface input alias; not user-visible copy.
    '声音': 'personalization', // i18n-allow: Client surface input alias; not display copy.
    '声音工作室': 'personalization', // i18n-allow: Client surface input alias; not display copy.
    '组织': 'org', // i18n-allow: Client surface input alias; not display copy.
    '组织空间': 'org', // i18n-allow: Client surface input alias; not display copy.
    '组织工作区': 'org', // i18n-allow: Client surface input alias; not display copy.
    '计划': 'plans', // i18n-allow: Client surface input alias; not display copy.
    '计划面板': 'plans', // i18n-allow: Client surface input alias; not display copy.
    '工作队列': 'plans', // i18n-allow: Client surface input alias; not display copy.
    '通知': 'notifications', // i18n-allow: Client surface input alias; not display copy.
    '通知面板': 'notifications', // i18n-allow: Client surface input alias; not display copy.
    '通知窗口': 'notifications', // i18n-allow: Client surface input alias; not display copy.
    '提醒': 'reminders', // i18n-allow: Client surface input alias; not display copy.
    '提醒面板': 'reminders', // i18n-allow: Client surface input alias; not display copy.
    '提醒窗口': 'reminders', // i18n-allow: Client surface input alias; not display copy.
    '设备': 'devices', // i18n-allow: Client surface input alias; not display copy.
    '设备同步': 'devices', // i18n-allow: Client surface input alias; not display copy.
    '终端': 'terminal', // i18n-allow: Client surface input alias; not display copy.
    '用量': 'tokens', // i18n-allow: Client surface input alias; not display copy.
    '令牌用量': 'tokens', // i18n-allow: Client surface input alias; not display copy.
    '个人资料': 'profile', // i18n-allow: Client surface input alias; not display copy.
    '语音工坊': 'voice', // i18n-allow: Client surface input alias; not display copy.
    '声音克隆': 'voice', // i18n-allow: Client surface input alias; not display copy.
    '技能生成': 'generate', // i18n-allow: Client surface input alias; not display copy.
    '能力生态': 'ecosystem', // i18n-allow: Chinese client-surface input alias.
    '文档': 'docs', // i18n-allow: Client surface input alias; not display copy.
    '创始人空间': 'founders', // i18n-allow: Client surface input alias; not display copy.
    '电脑适配中心': 'kernel', // i18n-allow: Client surface input alias; not display copy.
    '计算机适配中心': 'kernel', // i18n-allow: Client surface input alias; not display copy.
    '电脑适配': 'kernel', // i18n-allow: Client surface input alias; not display copy.
    log: 'runtime-log',
    logs: 'runtime-log',
    runtime: 'runtime-log',
    settings: 'settings',
    '设置': 'settings', // i18n-allow: Client surface input alias; not display copy.
    '运行日志': 'runtime-log', // i18n-allow: Client surface input alias; not display copy.
    '日志': 'runtime-log', // i18n-allow: Client surface input alias; not display copy.
    '知识库': 'knowledge', // i18n-allow: Client surface input alias; not display copy.
    '文件中心': 'knowledge', // i18n-allow: Client surface input alias; not display copy.
    '文件管理器': 'knowledge', // i18n-allow: Client surface input alias; not display copy.
  };
  return aliases[normalized] || normalized;
}
