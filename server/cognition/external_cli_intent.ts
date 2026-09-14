export type ExternalCliIntent = 'none' | 'explain' | 'inspect' | 'delegate';

/** Classify the requested work, not just the presence of a CLI name. */
export function classifyExternalCliIntent(value: string): ExternalCliIntent {
  const text = String(value || '').replace(/(?:[a-z]:[\\/]|https?:\/\/|(?:^|\s)(?:~|\.)?\/)[^\s"'<>，。；！？]+/giu, ' ');
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
  if (/(?:聊天记录|历史对话|同步历史|history|chat logs?|聊天窗口|桌面端|网页端|desktop app|browser app)/iu.test(text)) return 'none';
  if (/(?:不要|别|不使用|不用|不调用|do not|don't).{0,12}(?:codex|claude)/iu.test(text)) return 'none';
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
  const named = /(?:codex\s*cli|claude\s*code|claude\s*cli|外部\s*cli)/iu.test(text)
    || /(?:让|用|调用|交给|委派|请|继续|use|ask|delegate|resume).{0,12}(?:codex|claude)/iu.test(text)
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
    || /(?:codex|claude).{0,16}(?:检查|审查|审计|修复|修改|处理|执行|继续|review|fix|run)/iu.test(text);
  if (!named) return 'none';
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
  const capabilityOnly = text.replace(/(?:codex|claude)(?:\s*(?:code|cli))?|外部\s*cli/giu, '').replace(/[\s，,。.!！?？]/gu, '');
  if (/^(?:(?:你|lumi|现在|目前|本机|本地|已经|能够|能不能|能|可不可以|可以|是否|支持|会不会|会|控制|调用|使用|运行|执行|连接|接入|和|或|吗|呢|了)|(?:can|could|you|lumi|currently|use|control|call|run|invoke|connect|to|and|or))+$/iu.test(capabilityOnly)
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
    && /能|可以|是否|支持|会不会|吗|can|could/iu.test(capabilityOnly)) return 'inspect';
  // A concrete job remains a request even when politely phrased as a question.
  // Installation/login/version inspection itself is not a delegated job.
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
  const withoutStatus = text.replace(/(?:运行|执行|run(?:ning)?)\s*(?:状态|status)/giu, '状态').replace(/(?:检查|查看|查询|确认|核对|检测|check|inspect)\s*(?:(?:一下|本机|本地|的|是否|已经|能否|有没有|能不能|can|the|local|installed|ready|authenticated)|(?:codex|claude)(?:\s*(?:code|cli))?|\s)*(?:状态|版本|安装|登录|登陆|配置|可用|调用|控制|status|version|installation|authentication|availability)/giu, ' ');
  const job = /(?:修复|修改|审查|审计|编写|写入|生成|创建|重构|删除|构建|编译|执行|运行|继续|进行测试|检查.{0,16}(?:项目|代码|文件)|\b(?:fix|edit|review|audit|write|generate|create|refactor|delete|build|execute|run|resume|continue|test)\b)/iu.test(withoutStatus);
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
  const explanation = /(?:是什么|什么意思|怎么(?:用|调用|接入|工作)|如何(?:使用|调用|接入)|(?:能|可以).{0,8}做什么|有什么功能|用法|原理|区别|what\s+(?:is|can)|how\s+(?:does|do|to)|explain)/iu.test(text);
  if (explanation && !/(?:帮我|替我|现在|直接|请你|please|for me).{0,30}(?:修复|修改|检查|执行|运行|fix|edit|check|run)/iu.test(text)) return 'explain';
  if (job) return 'delegate';
  // i18n-allow: Multilingual CLI request recognition; these literals are not output copy.
  if (/(?:能|可以|支持|会不会|是否|有没有|检查|查看|查询|确认|核对|检测|安装|登录|登陆|状态|版本|可用|can\b|could\b|available|ready|status|version|installed|authenticated|check\b)/iu.test(text)) return 'inspect';
  if (/(?:调用|交给|委派|让|use\b|ask\b|delegate\b)/iu.test(text)) return 'delegate';
  // A bare name supplies neither a task nor authority to start a CLI process.
  return 'explain';
}

/** Routing visibility is separate from permission to submit a task. */
export function isExternalCliRequest(value: string): boolean {
  return ['inspect', 'delegate'].includes(classifyExternalCliIntent(value));
}

export function isExternalCliDelegation(value: string): boolean {
  return classifyExternalCliIntent(value) === 'delegate';
}

export function externalCliToolsForIntent(value: string): string[] {
  return classifyExternalCliIntent(value) === 'inspect' ? ['external_cli_status']
    : isExternalCliDelegation(value) ? ['external_cli_run', 'external_cli_status', 'external_cli_get_run'] : [];
}

export function requestedCliProviders(value: string): Array<'codex' | 'claude'> {
  return (['codex', 'claude'] as const).filter(name => new RegExp(name, 'iu').test(value));
}
