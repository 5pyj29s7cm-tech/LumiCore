/** Read-only questions about this Lumi's current model, not advice or changes. */
export function isModelConfigurationReadRequest(text: string): boolean {
  const value = String(text || '').trim();
  if (value.length > 160 || /\n/.test(value)) return false;
  // i18n-allow: Chinese input recognition, not user-visible copy.
  if (/(?:换成|切换|改成|推荐|比较|哪个好|什么是|怎么配置|如何配置|然后|并且)|\b(?:switch|change|recommend|compare|how to|then)\b/iu.test(value)) return false;
  // i18n-allow: Chinese input recognition, not user-visible copy.
  return /^(?:请|帮我|查一下|看一下|告诉我|你|lumi|现在|当前|正在|用|使用|调用|的|是|在|\s)*(?:什么|哪个|哪种)(?:大语言|语言|聊天|推理)?模型(?:啊|呢|呀|吗|[？?。.!\s])*$/iu.test(value)
    // i18n-allow: Chinese input recognition, not user-visible copy.
    || /^(?:请)?(?:查看|读取|查一下|看一下|告诉我)(?:你|lumi|当前|现在|的|\s)*(?:聊天|推理)?模型(?:配置|设置)?[？?。.!\s]*$/iu.test(value)
    || /^(?:what|which)\s+(?:AI\s+)?model\s+(?:are you(?: using)?|do you use|is (?:active|configured))(?:\s+(?:now|currently))?[?.!\s]*$/iu.test(value);
}
