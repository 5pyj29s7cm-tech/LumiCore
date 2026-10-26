export type PublicExecutionLanguage = 'zh' | 'en';

export type PublicExecutionIssue =
  | 'confirmation_required'
  | 'target_changed'
  | 'desktop_busy'
  | 'user_active'
  | 'service_unavailable'
  | 'timed_out'
  | 'cancelled'
  | 'completed'
  | 'unverified';

// These are implementation-level verifier, relay, and receipt fragments. They
// may remain in structured logs, but must never become assistant prose or be
// learned again from conversation history.
// Field names and registered tool names are deliberately not signals here:
// ordinary technical answers must remain free to discuss requestId, taskId,
// idempotencyKey, terminalVerification, or desktop_open without being replaced.
// i18n-allow -- recognition only; this expression does not produce UI copy.
const INTERNAL_EXECUTION_LANGUAGE_RE = /(?:\[The historical reply|Lumi\s+(?:should|must)\b|Lumi\s*应该|本轮没有真实回执证明[^。！？\n]{0,12}工具|No receipt shows that tools were disabled|No successful (?:current-turn )?tool execution|without a current-turn tool receipt|No tool execution started|execution-status claim|Missing (?:core|verified|current-turn|in-app|desktop|client|content-read|action) evidence|tool-call protocol leaked|internal tool request|fictional tool-mode|claimed tool execution without matching tool records|Internal execution recovery|Desktop target application has not matched a fresh observation|Desktop execution ended as|\b(?:target_mismatch|execution_recovery_incomplete)\b|(?:^|\n)\s*(?:状态\s*[:：]\s*(?:受阻|失败|已完成)|Status\s*:\s*(?:blocked|failed|completed))|(?:^|\n)\s*(?:证据|具体阻塞|执行回馈)\s*[:：]|(?:^|\n)\s*(?:Evidence|Concrete blocker|Execution feedback)\s*:|(?:文件操作|桌面操作)\s*[（(]\s*失败\s*[:：]|暂时没有可核验的执行结果|后续窗口核验没有确认当前前台状态|我已保留(?:原目标|已有进度|已执行步骤)|我还不能说正在执行|这一轮没有记录到成功的真实工具执行|我需要先真正调用对应工具)/imu;

// i18n-allow -- recognition only; mapped to localized customer copy below.
const TARGET_CHANGED_RE = /target[_ ]?mismatch|fresh observation|active (?:window|target).{0,30}(?:changed|mismatch)|后续窗口核验|当前前台状态|窗口.{0,16}(?:不一致|变化|未确认)|目标.{0,16}(?:不一致|变化|未匹配)/iu;
const USER_ACTIVE_RE = /paused_for_user_activity|desktop_control_paused_for_user_activity|user activity|physical input|用户正在操作|检测到.{0,12}(?:鼠标|键盘|电脑)/iu;
const DESKTOP_BUSY_RE = /global desktop lease|desktop.{0,16}(?:busy|occupied)|lease.{0,16}(?:busy|occupied|conflict)|桌面控制.{0,12}(?:忙|占用)|控制权.{0,12}(?:占用|冲突)/iu;
const SERVICE_UNAVAILABLE_RE = /provider unavailable|service unavailable|connection refused|no desktop client|did not accept|not connected|连接.{0,12}(?:失败|不可用|中断)|服务.{0,12}(?:不可用|未启动)/iu;
const TIMEOUT_RE = /timed?\s*out|timeout|超时/iu;
const CANCELLED_RE = /cancelled|canceled|request_cancelled|已取消|已停止/iu;
const COMPLETED_RE = /(?:^|\n)\s*(?:状态\s*[:：]\s*已完成|Status\s*:\s*completed)/imu;

// i18n-allow -- old program envelopes and model-only confirmation prompts.
const INTERNAL_CONFIRMATION_RE = /(?:^|\n)\s*(?:这项操作还没有执行，需要你确认后才能继续。|Confirmation is required before this action can run\.|#{1,6}\s*Exact Pending Action Confirmation|Arguments \(secrets redacted\):|参数\s*[:：]\s*\{[^\n]*["'](?:task|max_steps|target_application)["']\s*:)/imu;

// Recognize protocol markup, not ordinary mentions of tool or field names.
const INTERNAL_TOOL_PROTOCOL_RE = /(?:<|&lt;)\s*\/?\s*(?:function_calls|tool_calls|invoke|parameter|tool_call|[A-Za-z][\w.-]*_[\w.-]+)(?=\s|\/?(?:>|&gt;)|$)/iu;

export function containsInternalToolProtocol(value: unknown): boolean {
  return INTERNAL_TOOL_PROTOCOL_RE.test(String(value || ''));
}

export function containsInternalExecutionLanguage(value: unknown): boolean {
  const text = String(value || '');
  return containsInternalToolProtocol(text) || INTERNAL_EXECUTION_LANGUAGE_RE.test(text) || INTERNAL_CONFIRMATION_RE.test(text);
}

export function classifyInternalExecutionIssue(value: unknown): PublicExecutionIssue {
  const text = String(value || '');
  if (INTERNAL_CONFIRMATION_RE.test(text)) return 'confirmation_required';
  if (TARGET_CHANGED_RE.test(text)) return 'target_changed';
  if (USER_ACTIVE_RE.test(text)) return 'user_active';
  if (DESKTOP_BUSY_RE.test(text)) return 'desktop_busy';
  if (SERVICE_UNAVAILABLE_RE.test(text)) return 'service_unavailable';
  if (TIMEOUT_RE.test(text)) return 'timed_out';
  if (CANCELLED_RE.test(text)) return 'cancelled';
  if (COMPLETED_RE.test(text)) return 'completed';
  return 'unverified';
}

/** Redact explicit tool-protocol blocks without rewriting ordinary prose. */
export function sanitizePublicExecutionText(
  value: unknown,
  _language?: PublicExecutionLanguage,
): string {
  const text = String(value || '');
  if (!text.trim()) return '';
  if (!containsInternalToolProtocol(text)) return text;
  const withoutProtocol = text.replace(/(?:<|&lt;)\s*(function_calls|tool_calls|invoke|parameter|tool_call|[A-Za-z][\w.-]*_[\w.-]+)(?=\s|\/?>|&gt;)[^>]*?(?:>|&gt;)[\s\S]*?(?:<|&lt;)\s*\/\s*\1\s*(?:>|&gt;)/giu, '')
    .replace(new RegExp(INTERNAL_TOOL_PROTOCOL_RE.source + '[\\s\\S]*$', 'iu'), '');
  return withoutProtocol.trim() ? withoutProtocol : '';
}

/** Exact runtime identities are private unless the original request or input source contains them. */
export function privateExecutionReferences(text: string, identities: readonly (string | undefined)[], originalText: readonly string[]): string[] {
  return identities.filter((id): id is string => Boolean(id && text.includes(id) && !originalText.some(source => source.includes(id))));
}

/** Exact-reference public text projection. Complete verified blocks survive inline private annotations. */
export function projectExecutionReferenceText(answer: string, privateReferences: readonly string[], verifiedText: readonly string[], metadataReferences: readonly string[] = []): string {
  const verifiedRanges = verifiedText.filter(text => text
    && !privateReferences.some(id => text.includes(id))).flatMap(text => {
      const ranges: { start: number; end: number }[] = [];
      for (let start = answer.indexOf(text); start >= 0; start = answer.indexOf(text, start + text.length)) {
        ranges.push({ start, end: start + text.length });
      }
      return ranges;
    }).sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce<{ start: number; end: number }[]>((ranges, range) => {
      const previous = ranges[ranges.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else ranges.push({ ...range });
      return ranges;
    }, []);
  let lineOffset = 0;
  const projected = privateReferences.length > 0
    ? answer.split('\n').flatMap(line => {
      const start = lineOffset, end = start + line.length;
      lineOffset = end + 1;
      if (!privateReferences.some(id => line.includes(id))) return [line];
      return verifiedRanges.filter(range => range.start < end && range.end > start)
        .map(range => answer.slice(Math.max(start, range.start), Math.min(end, range.end)));
    }).join('\n').trim()
    : answer;


  // Metadata annotations do not change completion or source verification. Exact
  // readback blocks remain untouched, including source text with these keys.
  if (!metadataReferences.length) return projected;
  const protectedText = verifiedText.filter(Boolean).sort((a, b) => b.length - a.length);
  const strip = (text: string) => {
    let clean = text;
    for (const reference of metadataReferences) {
      const literal = reference.replace(/[.*+?^$()|[\]{}\\]/gu, '\\$&');
      // i18n-allow -- remove an exact annotation and its empty grammatical wrapper.
      clean = clean.replace(new RegExp('[ \t]*' + '`' + literal + '`' + '（([^（）\r\n]+)）', 'gu'), '$1')
        .replace(new RegExp('(?:尚属)?[「“]' + literal + '[」”]', 'gu'), '')
        .replace(new RegExp('`' + literal + '`' + '(?:\\s*(?:为空|未启用))?', 'gu'), '');
      if (reference.includes('=') || /^https?:\/\/|_/u.test(reference)) clean = clean.replace(new RegExp(literal, 'gu'), '');
    }
    if (clean === text) return text;
    return clean.replace(/（[\s，、；]*）|\([\s,;]*\)/gu, '')
      .replace(/^\s*[-*]\s+[^:：\r\n]{1,24}[:：][ \t]*$/gmu, '')
      .replace(/^\s*#{1,6}[ \t]*$/gmu, '');
  };
  const protect = (text: string, index: number): string => {
    if (index >= protectedText.length) return strip(text);
    const source = protectedText[index], parts = text.split(source);
    return parts.length === 1 ? protect(text, index + 1) : parts.map(part => protect(part, index + 1)).join(source);
  };
  return protect(projected, 0).replace(/\n{3,}/gu, '\n\n').trim();
}
