export const DESKTOP_WECHAT_WATCH_MESSAGES = {
  windowName: '微信',
  titles: {
    unreadDetected: '电脑版微信发现新消息',
    attentionLocate: '微信消息需要手动定位',
    attentionOpen: '微信消息需要你查看',
    draftReady: '微信回复草稿已准备',
    noReply: '微信消息已完成判断',
    replySent: '微信回复已发送',
  },
  unreadDetected: (contact?: string) => contact
    ? `电脑版微信发现“${contact}”有新消息，Lumi 正在等待安全时机读取。`
    : '电脑版微信发现新的未读消息，但暂时无法可靠识别联系人。',
  draftReady: (contact: string, highRisk: boolean) => highRisk
    ? `已读取“${contact}”的消息并准备回复草稿。内容涉及承诺或敏感事项，请确认后再发送。`
    : `已读取“${contact}”的消息并准备回复草稿，确认后即可发送。`,
  noReply: (contact: string) => `已读取“${contact}”的消息，当前内容不需要代你回复。`,
  attentionRequired: (contact?: string) => contact
    ? `发现“${contact}”有新消息，但后台读取没有取得可靠内容，请打开微信后再处理。`
    : '发现微信未读消息，但无法可靠定位具体会话，请打开微信后再处理。',
  replySent: (contact: string) => `已按你的确认向“${contact}”发送回复，并完成可见结果验证。`,
};
