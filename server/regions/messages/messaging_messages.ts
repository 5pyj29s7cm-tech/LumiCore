import { formatCnToolFailureDetail } from './voice_fast_path_messages';

export const CN_MESSAGING_MESSAGES = {
  executionCheckRejected: "本步执行校验未通过，已停止处理。请重新确认目标。",
  textSendAction: '\u5fae\u4fe1\u6587\u5b57\u53d1\u9001',
  fileSendAction: '\u5fae\u4fe1\u6587\u4ef6\u6295\u9012',
  unverifiedDelivery: '\u6211\u4e0d\u4f1a\u628a\u672a\u786e\u8ba4\u7684\u6587\u5b57\u6216\u6587\u4ef6\u6295\u9012\u8bf4\u6210\u5df2\u5b8c\u6210\uff1b\u9700\u8981\u4ee5\u901a\u9053\u56de\u6267\u6216\u53ef\u89c1\u53d1\u9001\u8bc1\u636e\u9a8c\u6536\u3002',
} as const;

export function formatCnMessagingContractBlocker(failure = ''): string {
  const detail = String(failure || '').trim().replace(/[。.!?！？]+$/u, '');
  return detail ? detail + '。' : '没有收到消息或文件发送成功的确认，程序未返回具体失败原因。';
}

export function formatCnVoiceWeChatSendResult(contact: string, message: string, verified: boolean): string {
  if (verified) {
    return contact
      ? `\u5df2\u5728\u524d\u53f0\u5fae\u4fe1\u91cc\u53d1\u9001\u7ed9${contact}\uff1a${message}`
      : `\u5df2\u5728\u524d\u53f0\u5fae\u4fe1\u5f53\u524d\u804a\u5929\u91cc\u53d1\u9001\uff1a${message}`;
  }
  return contact
    ? `\u6ca1\u6709\u786e\u8ba4\u53d1\u9001\u7ed9${contact}\u6210\u529f\uff1a\u672a\u770b\u5230\u5339\u914d\u7684\u65b0\u6d88\u606f\u6c14\u6ce1\u3002`
    : '\u6ca1\u6709\u786e\u8ba4\u53d1\u9001\u6210\u529f\uff1a\u672a\u770b\u5230\u5339\u914d\u7684\u65b0\u6d88\u606f\u6c14\u6ce1\u3002';
}

export function formatCnVoiceWeChatSendError(error: string): string {
  return `\u8fd9\u6b21\u6ca1\u6709\u53d1\u9001\uff1a${formatCnToolFailureDetail(error)}`;
}
