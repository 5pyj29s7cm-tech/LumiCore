export const EXTERNAL_APP_MESSAGES = {
  reusingWindow: '正在复用已运行的微信窗口。',
  locatingChat: (contact: string) => '正在微信里定位聊天: ' + contact,
  readingChat: '正在读取微信聊天可见内容。',
  focusingInput: '正在用虚拟光标聚焦微信输入区。',
  sendingMessage: '正在粘贴并发送微信消息。',
  checkingMessage: '正在确认消息已出现在微信聊天中。',
  sendingBoundFile: '正在通过已绑定的个人微信会话发送文件。',
  sendingFile: (name: string) => '正在粘贴并发送文件: ' + name,
  wechatTitle: '微信',
};

export function buildMessageDraft(args: Record<string, any>): string {
  const explicitDraft = String(args.draft || '').trim();
  if (explicitDraft) return explicitDraft;

  const context = String(args.context || '').trim();
  const intent = String(args.intent || '').trim();
  const tone = String(args.tone || 'warm and concise').trim();
  const source = `${intent}\n${context}`;
  const formal = /formal|\u6b63\u5f0f|\u5ba2\u6c14|\u793c\u8c8c/i.test(tone);
  const concise = /concise|\u7b80\u77ed|\u7b80\u6d01/i.test(tone);

  if (/(?:\u665a\u5b89|\u65e9\u70b9\u4f11\u606f|\bgood\s*night\b)/i.test(source)) {
    return formal
      ? '\u665a\u5b89\uff0c\u795d\u60a8\u4eca\u665a\u597d\u597d\u4f11\u606f\u3002'
      : '\u665a\u5b89\uff0c\u65e9\u70b9\u4f11\u606f\u3002';
  }

  if (/(?:\u8c22\u8c22|\u611f\u8c22|\bthanks?\b)/i.test(source)) {
    return formal
      ? '\u6536\u5230\uff0c\u8c22\u8c22\u60a8\uff0c\u6211\u4f1a\u5c3d\u5feb\u5904\u7406\u5e76\u540c\u6b65\u8fdb\u5c55\u3002'
      : '\u6536\u5230\uff0c\u8c22\u8c22\uff0c\u6211\u5148\u5904\u7406\uff0c\u6709\u8fdb\u5c55\u9a6c\u4e0a\u540c\u6b65\u3002';
  }

  const topic = (context || intent)
    .replace(/\s+/g, ' ')
    .replace(/(?:\u5f53\u524d\u662f\u538b\u6d4b|\u4e0d\u8981\u5b9e\u9645\u53d1\u9001)[^。.!?\n]*/gu, '')
    .trim()
    .slice(0, concise ? 80 : 140);

  if (topic) {
    return formal
      ? `\u60a8\u597d\uff0c\u5173\u4e8e\u201c${topic}\u201d\uff0c\u6211\u5df2\u6536\u5230\uff0c\u4f1a\u5c3d\u5feb\u5904\u7406\u5e76\u540c\u6b65\u8fdb\u5c55\u3002`
      : `\u6536\u5230\uff0c\u5173\u4e8e\u201c${topic}\u201d\uff0c\u6211\u5148\u5904\u7406\uff0c\u6709\u8fdb\u5c55\u9a6c\u4e0a\u540c\u6b65\u3002`;
  }

  return formal
    ? '\u60a8\u597d\uff0c\u6211\u5df2\u6536\u5230\uff0c\u4f1a\u5c3d\u5feb\u5904\u7406\u5e76\u540c\u6b65\u8fdb\u5c55\u3002'
    : '\u6536\u5230\uff0c\u6211\u5148\u5904\u7406\uff0c\u6709\u8fdb\u5c55\u9a6c\u4e0a\u540c\u6b65\u3002';
}
