import { getLocale, type Locale } from '../runtime';

const SYSTEM_EXPLORER_COPY = {
  en: {
    appGroups: { browser: 'Browser', vscode: 'VS Code', git: 'Git', node: 'Node.js', python: 'Python', wps: 'WPS / Office', wechat: 'WeChat / enterprise messaging', cad: 'CAD', ai_apps: 'Local AI apps', netease: 'NetEase Cloud Music' },
    permissions: { microphone: 'Microphone', camera: 'Camera', notifications: 'Notifications', desktopAutomation: 'Desktop control' },
    limitReachedSuffix: ', limit reached',
    applicationBundles: 'macOS app bundles',
    unknown: 'unknown',
    desktop: {
      ready: 'Desktop shell, app discovery, screen capture, and input control passed readiness checks.',
      partial: 'Desktop shell and app launch are available, but full visual control is not ready.',
      unavailable: 'Desktop automation requires the native Lumi desktop client.',
      accessibility: 'Accessibility',
      screenRecording: 'Screen Recording',
      granted: 'granted',
      required: 'required',
      unknown: 'unknown',
    },
    runtime: {
      node: 'Bundled Node',
      python: 'System Python',
    },
    mcp: {
      summary: (enabled: number, total: number, connected: number, tools: number) => `${enabled}/${total} enabled, ${connected} connected, ${tools} tools registered.`,
      reconnect: 'Enabled MCP services are not connected. Use built-in desktop file tools for local files and review MCP runtime details.',
    },
    knowledge: {
      ready: (files: number, indexed: number) => `Knowledge storage is reachable: ${files} file(s), ${indexed} indexed.`,
      unavailable: 'Knowledge storage health could not be verified.',
    },
  },
  zh: {
    appGroups: { browser: '浏览器', vscode: 'VS Code', git: 'Git', node: 'Node.js', python: 'Python', wps: 'WPS / Office', wechat: '微信 / 企业通讯', cad: 'CAD', ai_apps: '本地 AI 应用', netease: '网易云音乐' },
    permissions: { microphone: '麦克风', camera: '摄像头', notifications: '通知', desktopAutomation: '桌面控制' },
    limitReachedSuffix: '，已达到上限',
    applicationBundles: 'macOS 应用包',
    unknown: '未知',
    desktop: {
      ready: '桌面壳、应用发现、屏幕捕获和输入控制均已通过就绪检查。',
      partial: '桌面壳和应用启动可用，但完整视觉控制尚未就绪。',
      unavailable: '桌面自动化需要 Lumi 原生桌面客户端。',
      accessibility: '辅助功能',
      screenRecording: '屏幕录制',
      granted: '已授权',
      required: '需要授权',
      unknown: '未知',
    },
    runtime: {
      node: '内置 Node',
      python: '系统 Python',
    },
    mcp: {
      summary: (enabled: number, total: number, connected: number, tools: number) => `已启用 ${enabled}/${total} 个，已连接 ${connected} 个，注册 ${tools} 个工具。`,
      reconnect: '已启用的 MCP 服务尚未连接。本地文件请使用内置桌面文件工具，并检查 MCP 运行详情。',
    },
    knowledge: {
      ready: (files: number, indexed: number) => `知识库存储可访问：${files} 个文件，${indexed} 个已索引。`,
      unavailable: '未能验证知识库存储健康状态。',
    },
  },
} as const;

export function systemExplorerCopy(locale: Locale = getLocale()) {
  return SYSTEM_EXPLORER_COPY[locale];
}
