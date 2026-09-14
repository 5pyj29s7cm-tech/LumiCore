/** Shared routing only: execution still belongs to the canonical Lumi task. */
export function isExternalCliRequest(value: string): boolean {
  const text = String(value || '').replace(/(?:[a-z]:[\\/]|https?:\/\/|(?:^|\s)(?:~|\.)?\/)[^\s"'<>，。；！？]+/giu, ' ');
  if (/(?:聊天记录|历史对话|同步历史|history|chat logs?|聊天窗口|桌面端|网页端|desktop app|browser app)/iu.test(text)) return false;
  if (/(?:不要|别|不使用|不用|不调用|do not|don't).{0,12}(?:codex|claude)/iu.test(text)) return false;
  return /(?:codex\s*cli|claude\s*code|claude\s*cli|外部\s*cli)/iu.test(text)
    || /(?:让|用|调用|交给|委派|请|继续|use|ask|delegate|resume).{0,12}(?:codex|claude)/iu.test(text)
    || /(?:codex|claude).{0,16}(?:检查|审查|审计|修复|修改|处理|执行|继续|review|fix|run)/iu.test(text);
}
