export type PublicExecutionLanguage = 'zh' | 'en';

export type PublicExecutionIssue =
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
const INTERNAL_EXECUTION_LANGUAGE_RE = /(?:No successful (?:current-turn )?tool execution|without a current-turn tool receipt|No tool execution started|execution-status claim|Missing (?:core|verified|current-turn|in-app|desktop|client|content-read|action) evidence|tool-call protocol leaked|internal tool request|fictional tool-mode|claimed tool execution without matching tool records|Internal execution recovery|Desktop target application has not matched a fresh observation|Desktop execution ended as|\b(?:target_mismatch|execution_recovery_incomplete)\b|(?:^|\n)\s*(?:状态\s*[:：]\s*(?:受阻|失败|已完成)|Status\s*:\s*(?:blocked|failed|completed))|(?:^|\n)\s*(?:证据|具体阻塞|执行回馈)\s*[:：]|(?:^|\n)\s*(?:Evidence|Concrete blocker|Execution feedback)\s*:|(?:文件操作|桌面操作)\s*[（(]\s*失败\s*[:：]|暂时没有可核验的执行结果|后续窗口核验没有确认当前前台状态|我已保留(?:原目标|已有进度|已执行步骤)|(?:执行|工具|终态|回读|验收)回执|我还不能说正在执行|这一轮没有记录到成功的真实工具执行|我需要先真正调用对应工具)/imu;

// i18n-allow -- recognition only; mapped to localized customer copy below.
const TARGET_CHANGED_RE = /target[_ ]?mismatch|fresh observation|active (?:window|target).{0,30}(?:changed|mismatch)|后续窗口核验|当前前台状态|窗口.{0,16}(?:不一致|变化|未确认)|目标.{0,16}(?:不一致|变化|未匹配)/iu;
const USER_ACTIVE_RE = /paused_for_user_activity|desktop_control_paused_for_user_activity|user activity|physical input|用户正在操作|检测到.{0,12}(?:鼠标|键盘|电脑)/iu;
const DESKTOP_BUSY_RE = /global desktop lease|desktop.{0,16}(?:busy|occupied)|lease.{0,16}(?:busy|occupied|conflict)|桌面控制.{0,12}(?:忙|占用)|控制权.{0,12}(?:占用|冲突)/iu;
const SERVICE_UNAVAILABLE_RE = /provider unavailable|service unavailable|connection refused|no desktop client|did not accept|not connected|连接.{0,12}(?:失败|不可用|中断)|服务.{0,12}(?:不可用|未启动)/iu;
const TIMEOUT_RE = /timed?\s*out|timeout|超时/iu;
const CANCELLED_RE = /cancelled|canceled|request_cancelled|已取消|已停止/iu;
const COMPLETED_RE = /(?:^|\n)\s*(?:状态\s*[:：]\s*已完成|Status\s*:\s*completed)/imu;

function inferLanguage(value: string, requested?: PublicExecutionLanguage): PublicExecutionLanguage {
  if (requested) return requested;
  return /[\u3400-\u9fff]/u.test(value) ? 'zh' : 'en';
}

export function containsInternalExecutionLanguage(value: unknown): boolean {
  return INTERNAL_EXECUTION_LANGUAGE_RE.test(String(value || ''));
}

export function classifyInternalExecutionIssue(value: unknown): PublicExecutionIssue {
  const text = String(value || '');
  if (TARGET_CHANGED_RE.test(text)) return 'target_changed';
  if (USER_ACTIVE_RE.test(text)) return 'user_active';
  if (DESKTOP_BUSY_RE.test(text)) return 'desktop_busy';
  if (SERVICE_UNAVAILABLE_RE.test(text)) return 'service_unavailable';
  if (TIMEOUT_RE.test(text)) return 'timed_out';
  if (CANCELLED_RE.test(text)) return 'cancelled';
  if (COMPLETED_RE.test(text)) return 'completed';
  return 'unverified';
}

/**
 * Converts leaked runtime diagnostics into short customer language. Clean
 * assistant prose is returned byte-for-byte so this is safe as a last-mile
 * display boundary as well as a legacy-history migration.
 */
export function sanitizePublicExecutionText(
  value: unknown,
  language?: PublicExecutionLanguage,
): string {
  const text = String(value || '').trim();
  if (!text || !containsInternalExecutionLanguage(text)) return text;
  const locale = inferLanguage(text, language);
  const issue = classifyInternalExecutionIssue(text);
  if (locale === 'zh') {
    // i18n-allow -- canonical Simplified Chinese customer copy.
    if (issue === 'target_changed') return '刚才没有完成，因为操作后的窗口和目标不一致。请把目标窗口保持在前台，再让我重试。';
    if (issue === 'user_active') return '检测到你正在操作电脑，我先暂停了这一步，避免和你抢控制。你说“继续”后我会接着做。';
    if (issue === 'desktop_busy') return '桌面控制正被另一项操作占用，所以这一步还没完成。等当前操作结束后可以直接重试。';
    if (issue === 'service_unavailable') return '我现在没能连接到桌面操作功能，所以这一步没有完成。连接恢复后可以直接重试。';
    if (issue === 'timed_out') return '这一步等待太久仍没有结果，已经安全停止。你可以直接让我重试。';
    if (issue === 'cancelled') return '这项操作已经停止，未完成的步骤不会继续。';
    if (issue === 'completed') return '这一步已经完成。';
    return '刚才没有完成，我没有拿到能确认结果的反馈。你可以直接让我重试。';
  }
  if (issue === 'target_changed') return 'That did not finish because the window no longer matched the target. Keep the target window in front, then ask me to retry.';
  if (issue === 'user_active') return 'I paused this step while you were using the computer so I would not interfere. Say “continue” when you want me to resume.';
  if (issue === 'desktop_busy') return 'Desktop control is busy with another operation, so this step did not finish. Retry after that operation ends.';
  if (issue === 'service_unavailable') return 'I could not reach desktop control, so this step did not finish. You can retry when the connection is back.';
  if (issue === 'timed_out') return 'This step waited too long without a result and stopped safely. You can ask me to retry.';
  if (issue === 'cancelled') return 'This operation was stopped. Unfinished steps will not continue.';
  if (issue === 'completed') return 'This step is complete.';
  return 'That did not finish because I could not confirm the result. You can ask me to retry.';
}
