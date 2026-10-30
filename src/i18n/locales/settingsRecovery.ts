const copy = {
  en: {
    retry: 'Retry', refresh: 'Refresh', loading: 'Loading…', failed: 'Could not load the latest data. Retry to confirm the current state.',
    terminalTimeout: 'Terminal did not become ready. Press Enter to retry.', terminalDisconnected: 'Disconnected. Reconnect, then press Enter to retry.', compatible: 'Compatible', incompatible: 'Incompatible',
    stale: 'Previously loaded data may be out of date.', previous: 'Previous page', next: 'Next page', docsFallback: 'Remote documentation could not be loaded. Built-in guidance remains available.',
    publishFailed: 'Publishing failed. Retry from the same skill after checking the error.', publishSuccess: 'Skill discovery metadata published. This does not install or activate executable code.', publishMissing: 'This skill is no longer in the installed list.',
    extensions: 'Signed extension providers', signed: 'Signed', noModel: 'No default model', compatibilityUnknown: 'Compatibility unknown', credentialsReady: 'Credentials saved', credentialsMissing: 'Credentials missing', available: 'Available', unavailable: 'Unavailable',
    extensionHelp: 'Installation, permission review, rollback and disabling use the extension registry and saved receipts. Credentials remain in the local credential store.',
    voiceInfo: 'Capability overview only. Availability is shown by the active provider below; no voice call is made by these cards.',
    connectionCheck: 'Check saved configuration', connectionHelp: 'Checks saved credential presence on this device only. Token format, remote connectivity and permissions remain unverified. It does not contact GitHub, Notion or Figma or execute a workflow. Use the corresponding approved tool with an explicit task after setup.',
    configured: 'Credential saved — service not verified', missing: 'Credential not saved', nativeFailed: 'The native setting was not confirmed. Retry before relying on it.',
    biometricFailed: 'Could not load enrolled biometrics. Retry to confirm the list.', deleteFailed: 'Deletion was not confirmed. Refresh the list before retrying.',
  },
  zh: {
    retry: '重试', refresh: '刷新', loading: '正在加载…', failed: '无法读取最新数据，请重试确认当前状态。',
    terminalTimeout: '终端尚未就绪，请按 Enter 重试。', terminalDisconnected: '连接已断开，请重新连接后按 Enter 重试。', compatible: '兼容', incompatible: '不兼容',
    stale: '先前读取的数据可能已过期。', previous: '上一页', next: '下一页', docsFallback: '远程文档读取失败，仍可查看内置说明。',
    publishFailed: '发布失败。请检查错误后从同一技能重试。', publishSuccess: '技能发现元数据已发布，不代表已安装或激活可执行代码。', publishMissing: '已安装列表中已找不到此技能。',
    extensions: '已签名扩展提供商', signed: '已签名', noModel: '未设置默认模型', compatibilityUnknown: '兼容性未知', credentialsReady: '凭据已保存', credentialsMissing: '缺少凭据', available: '可用', unavailable: '不可用',
    extensionHelp: '安装、权限审核、回滚和停用使用扩展注册表及持久化回执。凭据保留在本地凭据存储中。',
    voiceInfo: '这里只介绍能力；实际可用性以下方活动提供商状态为准，这些卡片不会发起语音调用。',
    connectionCheck: '检查已保存配置', connectionHelp: '仅检查本机是否已保存凭据；令牌格式、远程连通性和权限仍未验证。不会联系 GitHub、Notion 或 Figma，也不执行业务。配置后需通过对应的已批准工具提交明确任务。',
    configured: '凭据已保存，服务未验证', missing: '尚未保存凭据', nativeFailed: '原生设置尚未确认，请重试后再依赖此设置。',
    biometricFailed: '已登记生物识别信息读取失败，请重试确认列表。', deleteFailed: '删除尚未确认，请刷新列表后再重试。',
  },
};
export const settingsRecoveryCopy = (lang?: string) => copy[lang === 'en' ? 'en' : 'zh'];
