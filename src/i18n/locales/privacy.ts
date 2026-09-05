import type { Locale } from '../runtime';

const COPY = {
  zh: {
    title: '严格模式',
    defaultOff: '默认关闭 · 重启后生效',
    cloudEffect: '官网 API、云端 AI 和联网语音不可用。',
    toolsEffect: '暂停自动工具执行，包括本地文件操作。',
    localEffect: '保留本地模型对话、已就绪的本地语音及安全上传解析。本地能力未就绪时会提示不可用，不转到云端。',
    noLaunch: '开启开关不会下载模型，也不会启动 LM Studio 等本机模型程序。',
    shared: '这项设置影响连接到此服务的所有客户端，不限制其他程序的网络访问。',
    current: '当前生效',
    strict: '严格模式',
    standard: '标准模式',
    loading: '正在读取后端设置…',
    unknown: '当前状态未知',
    saving: '正在保存…',
    refresh: '重新读取',
    restart: '已保存。完全退出并重新启动主程序后生效；当前运行模式尚未改变。',
    saved: '已保存，与当前运行模式一致，无需重启。',
    locked: '运行环境强制启用了严格模式，无法在这里关闭。',
    restricted: '此服务的隐私设置只能由本机个人工作区的管理员修改。当前为只读。',
    loadFailed: '未能读取后端隐私设置，请重新读取后再操作。',
    saveFailed: '未能确认保存结果，仍显示上次确认的设置。请重新读取后再试。',
  },
  en: {
    title: 'Strict mode',
    defaultOff: 'Off by default · Takes effect after restart',
    cloudEffect: 'The official API, cloud AI, and online speech services are unavailable.',
    toolsEffect: 'Automatic tool execution is paused, including local file operations.',
    localEffect: 'Local model chat, ready-to-use local speech, and safe upload parsing remain available. If a local capability is not ready, Lumi reports it as unavailable instead of switching to the cloud.',
    noLaunch: 'Enabling this switch does not download models or start LM Studio or another local model application.',
    shared: 'This setting affects every client connected to this service. It does not restrict network access by other applications.',
    current: 'Currently active',
    strict: 'Strict mode',
    standard: 'Standard mode',
    loading: 'Reading backend settings…',
    unknown: 'Current status is unknown',
    saving: 'Saving…',
    refresh: 'Reload settings',
    restart: 'Saved. Fully quit and restart the main application to apply this change. The current runtime mode has not changed.',
    saved: 'Saved. The setting matches the current runtime mode; no restart is needed.',
    locked: 'Strict mode is enforced by the runtime environment and cannot be disabled here.',
    restricted: 'Only a local administrator in the personal workspace can change this service setting. Your view is read-only.',
    loadFailed: 'Unable to read backend privacy settings. Reload them before making a change.',
    saveFailed: 'The save could not be confirmed. The last confirmed setting is still shown. Reload settings before trying again.',
  },
} as const;

export function privacyCopy(locale: Locale) {
  return COPY[locale];
}
