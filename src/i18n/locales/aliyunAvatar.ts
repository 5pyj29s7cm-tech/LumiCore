const zh = {
  title: '阿里云数字人', hint: '选择“云渲染音频驱动”项目。画面由阿里云生成，对话、记忆和声音沿用 Lumi。先在阿里云创建或选择形象并发布项目，再把对应编号填在这里。',
  console: '打开阿里云数字人控制台', keyId: 'AccessKey ID', secret: 'AccessKey Secret', project: '当前人物的项目 ID（配置 ID）', instance: '服务实例 ID',
  enabled: '此人物使用阿里云形象', consent: '我有权使用此形象，同意将回复音频交给阿里云生成画面，并使用我的服务额度。',
  savedKey: '阿里云密钥已保存。留空可沿用；更换时请同时填写两项。', noKey: '尚未保存阿里云密钥。密钥只在本机后台加密保存。',
  save: '保存阿里云设置', clear: '移除阿里云密钥', saved: '设置已保存，尚需实际连接验证效果。', error: '设置未确认保存，请重新读取后再试。',
  loadError: '阿里云设置读取失败。', retry: '重新读取', busy: '正在处理…', strict: '严格隐私模式下不可启用云端数字人。',
  cleanup: '有阿里云会话未确认关闭。请核对控制台会话；重试关闭只针对本机创建的会话，不会关闭其他会话。',
  retryCleanup: '重试关闭本机创建的会话', did: '原 D-ID 设置', live: '使用阿里云真人形象', liveHint: '使用此人物绑定的阿里云项目和服务额度，播报音频会交给阿里云生成画面。',
  callConsent: '我有权使用此人物形象，同意将本次通话的回复音频交给阿里云，并使用其服务额度。',
};
const en: typeof zh = {
  title: 'Alibaba Cloud avatar', hint: 'Use a cloud-rendered, audio-driven project. Alibaba Cloud renders the video; Lumi keeps the conversation, memory and voice. Create or select a likeness, publish the project, then enter its IDs here.',
  console: 'Open Alibaba Cloud avatar console', keyId: 'AccessKey ID', secret: 'AccessKey Secret', project: 'Project ID (configuration ID) for this person', instance: 'Service instance ID',
  enabled: 'Use Alibaba Cloud for this person', consent: 'I have permission to use this likeness and consent to sending reply audio to Alibaba Cloud, using my service credits.',
  savedKey: 'Credentials saved. Leave both fields blank to keep them, or fill both to replace them.', noKey: 'No credentials saved. They are encrypted by the local backend.',
  save: 'Save Alibaba Cloud settings', clear: 'Remove Alibaba Cloud credentials', saved: 'Settings saved. A real connection is still needed to verify rendering.', error: 'Saving was not confirmed. Reload before trying again.',
  loadError: 'Could not load Alibaba Cloud settings.', retry: 'Reload', busy: 'Working…', strict: 'Cloud avatars are unavailable in strict privacy mode.',
  cleanup: 'Some Alibaba Cloud sessions are not confirmed closed. Check the console. Cleanup targets only sessions created here, never unrelated sessions.',
  retryCleanup: 'Retry closing sessions created here', did: 'Previous D-ID settings', live: 'Use Alibaba Cloud portrait', liveHint: 'Uses this person’s Alibaba Cloud project and service credits. Speech audio is sent to Alibaba Cloud for rendering.',
  callConsent: 'I have permission to use this likeness and consent to sending reply audio to Alibaba Cloud during this call, using its service credits.',
};
export const aliyunAvatarCopy = (locale: 'zh' | 'en') => locale === 'en' ? en : zh;
