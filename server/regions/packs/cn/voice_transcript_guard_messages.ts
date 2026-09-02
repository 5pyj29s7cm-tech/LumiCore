export const CN_VOICE_TRANSCRIPT_GUARD_MESSAGES = Object.freeze({
  devicePromptContamination:
    '刚才的语音像混入了设备提示音，我没有执行。请只说一遍你要我做的事。',
  truncatedAction:
    '刚才这句话像是没说完整，我没有执行。请再说一遍具体要操作什么。',
});

/** Region-owned input recognition; these expressions are never output. */
export function isCnQuotedOrDiscussedText(text: string): boolean {
  return /(?:翻译|解释|改写|润色|引用|原文|这句|这段|英文|什么意思|怎么说)/u.test(text);
}

export function isCnBareAction(compact: string): boolean {
  return /^(?:请|麻烦|帮我|给我|替我)?(?:打开|关闭|删除|发送|运行|执行|创建|读取|查看|检查|分析|修改|保存|上传|下载|切换|设置)(?:一下|下)?$/u.test(compact);
}

export function containsCnAction(text: string): boolean {
  return /(?:打开|关闭|删除|发送|运行|执行|创建|读取|查看|检查|分析|修改|保存|上传|下载|切换|设置)/u.test(text);
}

export function endsWithCnDanglingConnector(text: string): boolean {
  return /(?:然后|并且|以及|接着|再|把|将|给|到|在|用)\s*[，,。.!！？?]*$/u.test(text);
}
