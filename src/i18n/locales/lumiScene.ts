import { getLocale, type Locale } from '../runtime';

const copy = {
  en: {
    title: 'Lumi Scene',
    syncing: 'Syncing semantic scene',
    unavailable: 'Semantic scene is temporarily unavailable',
    revision: 'Revision',
    labels: {
      'runtime.overall': 'Runtime state',
      'runtime.metrics': 'Live metrics',
      'runtime.active': 'Active tasks',
      'runtime.waiting': 'Awaiting approval',
      'runtime.blocked': 'Blocked tasks',
      'runtime.verified': 'Verified receipts',
      'runtime.background': 'Background work',
      'runtime.tasks': 'Task evidence',
      'runtime.safety': 'Safety boundaries',
      'runtime.safety.external_confirmation': 'External commits require bound confirmation',
      'runtime.safety.unknown_replay': 'Unknown external outcomes cannot be replayed blindly',
      'runtime.safety.payloads_excluded': 'Sensitive payloads are excluded',
    },
  },
  zh: {
    title: 'Lumi Scene',
    syncing: '正在同步语义界面',
    unavailable: '语义界面暂时不可用',
    revision: '版本',
    labels: {
      'runtime.overall': '运行状态',
      'runtime.metrics': '实时指标',
      'runtime.active': '执行中任务',
      'runtime.waiting': '等待确认',
      'runtime.blocked': '受阻任务',
      'runtime.verified': '已验证回执',
      'runtime.background': '后台工作',
      'runtime.tasks': '任务证据',
      'runtime.safety': '安全边界',
      'runtime.safety.external_confirmation': '外部提交必须绑定确认',
      'runtime.safety.unknown_replay': '外部结果未知时禁止盲目重放',
      'runtime.safety.payloads_excluded': '敏感正文不会进入 Scene',
    },
  },
} as const;

export function lumiSceneCopy(locale: Locale = getLocale()) {
  return copy[locale];
}
