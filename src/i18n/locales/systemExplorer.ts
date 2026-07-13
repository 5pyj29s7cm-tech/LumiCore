import { getLocale, type Locale } from '../runtime';

const SYSTEM_EXPLORER_COPY = {
  en: {
    appGroups: { browser: 'Browser', vscode: 'VS Code', git: 'Git', node: 'Node.js', python: 'Python', wps: 'WPS / Office', wechat: 'WeChat / enterprise messaging', cad: 'CAD', ai_apps: 'Local AI apps', netease: 'NetEase Cloud Music' },
    permissions: { microphone: 'Microphone', camera: 'Camera', notifications: 'Notifications', desktopAutomation: 'Desktop control' },
    limitReachedSuffix: ', limit reached',
    unknown: 'unknown',
  },
  zh: {
    appGroups: { browser: '浏览器', vscode: 'VS Code', git: 'Git', node: 'Node.js', python: 'Python', wps: 'WPS / Office', wechat: '微信 / 企业通讯', cad: 'CAD', ai_apps: '本地 AI 应用', netease: '网易云音乐' },
    permissions: { microphone: '麦克风', camera: '摄像头', notifications: '通知', desktopAutomation: '桌面控制' },
    limitReachedSuffix: '，已达到上限',
    unknown: '未知',
  },
} as const;

export function systemExplorerCopy(locale: Locale = getLocale()) {
  return SYSTEM_EXPLORER_COPY[locale];
}
