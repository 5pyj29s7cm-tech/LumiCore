export function desktopModeCopy(lang: 'zh' | 'en') {
  return lang === 'zh' ? {
    saveUnconfirmed: '模式切换未确认，请检查连接后重试',
    label: '程序模式', internal: '内部模式', external: '外部模式',
    internalHint: '内部模式：优先使用程序内部能力', externalHint: '外部模式：默认使用视觉与真实桌面操作',
  } : {
    saveUnconfirmed: 'Mode change was not confirmed. Check the connection and retry.',
    label: 'Application mode', internal: 'Internal mode', external: 'External mode',
    internalHint: 'Internal: prefer in-app capabilities', externalHint: 'External: prefer visual and real desktop operation',
  };
}
