import { requiresMediaPlaybackAction } from "../action_contract";
import { isConfirmationBlockedToolRecord } from "../../tools/confirmation_block";
import { toolRecordTerminalPayload } from "../../tools/receipt_payload";
import type { ConversationActionContinuationState } from './contracts';
import { normalizeConversationActionState } from './state_normalization';
import { compact } from './history_values';

/**
 * The person at the computer can be the final visible-state verifier. This is
 * only accepted as a declarative correction for an unfinished task that
 * already has an actuation receipt; questions, negations, and bare praise do
 * not alter execution state.
 */
export function isUserObservedTaskCompletion(
  text: string,
  value: ConversationActionContinuationState | null | undefined,
): boolean {
  const state = normalizeConversationActionState(value);
  const clean = compact(text, 260);
  if (!state?.unfinished || !(state.receipts || []).length || !clean) return false;
  if (/[？?]/u.test(clean)) return false;
  if (requiresMediaPlaybackAction(state.goal)) {
    // An opened player is only an intermediate step. A person can report the
    // missing visible playback result, including when correcting unnecessary
    // later actions, without upgrading any machine receipt to "verified".
    const hasActuation = (state.receipts || []).some(receipt => {
      if (isConfirmationBlockedToolRecord(receipt)) return false;
      if (!/^(?:desktop_open|desktop_click|desktop_key(?:_press)?|desktop_type|keyboard_(?:press|type)|mouse_click|computer_use|browser_(?:click|navigate)|media_play)$/iu.test(receipt.name)) return false;
      if (receipt.outcome !== 'failure') return true;
      if (receipt.name !== 'computer_use') return false;
      // A failed final verification does not erase the computer-use actions
      // already performed. Only its structured post-execution candidate can
      // support a user's correction; a denied/unstarted call cannot do so.
      const payload = toolRecordTerminalPayload(receipt);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
      const result = payload as Record<string, unknown>;
      if (result.status !== 'unverified' || result.completionVerified !== false
        || !Number.isInteger(result.steps) || Number(result.steps) <= 0) return false;
      return (Array.isArray(result.lastActions) && result.lastActions.some(action => (
        typeof action === 'string' && /\bDONE_CANDIDATE\s*:/u.test(action)
      ))) || (result.resumeStrategy === 'observe_only'
        && typeof result.completionCandidate === 'string' && Boolean(result.completionCandidate.trim()));
    });
    if (!hasActuation) return false;
    // i18n-allow: Chinese user-observation recognition; not user-visible copy.
    if (/(?:如果|假如|要是|只要|一旦|倘若|是否|有没有|是不是)|(?:打开|播放|开播)[^，,。.!！；;]{0,12}(?:吗|么)(?=$|[，,。.!！；;\s])|\b(?:if|whether)\b/iu.test(clean)) return false;
    // i18n-allow: A quoted claim or uncertain impression is not the user's affirmative observation.
    if (/(?:你说|你声称|你以为|说是|据说|好像|似乎|可能|应该)[^，,。.!！；;]{0,32}(?:播放|开播)|(?:不是我要的|播错了|放错了|集数不对)/u.test(clean)) return false;
    // i18n-allow: Negative or superseding playback observations are not completion.
    if (/(?:没有|还没|并未|未|没|不)[^，,。.!！；;]{0,12}(?:播放|开播|放出来|声音)|(?:播放|播|放)(?:失败|不了|不出来|错了)|(?:后来|现在|又|已经)[^，,。.!！；;]{0,6}(?:停了|暂停|停止)|\b(?:not\s+playing|didn'?t\s+play|hasn'?t\s+(?:started|played)|stopped|paused)\b/iu.test(clean)) return false;
    // Do not swallow a new instruction that follows the correction.
    // i18n-allow: Chinese mixed correction/execution recognition.
    if (/(?:继续|重新|再|换|帮我|请)[^，,。.!！；;]{0,10}(?:打开|播放|点击|按下|关闭|发送|保存)|\b(?:now|then|please)\s+(?:play|open|send|save|close)\b/iu.test(clean)) return false;
    // i18n-allow: Concrete affirmative playback report, optionally followed by criticism.
    return /(?:你|它|实际|其实|确实|已经|刚才|刚刚|现在|我(?:看到|看见|听到)|视频|电影|动画|歌曲|音乐)[^，,。.!！；;]{0,70}(?:播放(?:起来|出来|上)?了|开始播放(?:了)?|正在播放|在播放了)(?=$|[，,。.!！；;\s])/u.test(clean)
      || /^(?:you|it|the\s+(?:video|movie|song|music))\s+[^.!?;]{0,60}(?:already\s+(?:started\s+)?playing|(?:opened\s+and\s+)?played|is\s+playing)(?:\s+it)?(?=$|[,;.!\s])/iu.test(clean);
  }
  // i18n-allow: Chinese user-observation recognition; not user-visible copy.
  if (/(?:没有|没|未|并未|不是|并不是|不算|并不)|\b(?:not|didn'?t|hasn'?t|isn'?t|wasn'?t)\b/iu.test(clean)) return false;
  const cnObservationCue = /(?:^|[，,\s])(?:你|它|这个|那个|消息|文件|文档|窗口|页面|软件|任务|实际|其实|确实|已经|刚才|刚刚|都)/u; // i18n-allow: Chinese input recognition.
  const cnCompletedAction = /(?:完成|做完|执行完|发(?:送)?(?:出)?(?:去)?|打开|保存|写入|生成|创建|关闭|最大化|最小化)(?:成功|好|完|出去|出来)?了[。！!\s]*$/u; // i18n-allow: Chinese input recognition.
  return (cnObservationCue.test(clean) && cnCompletedAction.test(clean))
    || /^(?:you|it|that|the\s+(?:message|file|window|task))\s+(?:already\s+)?(?:did|has|was|is)?[^.!?]{0,24}(?:completed|finished|sent|opened|saved|created|closed|maximized|minimized)(?:\s+successfully)?[.!\s]*$/iu.test(clean);
}
