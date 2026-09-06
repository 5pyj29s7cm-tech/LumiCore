import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { hasMediaPlaybackEvidence, requiresMediaPlaybackAction } from './action_contract';

/** Early termination is narrower than the general playback routing contract.
 * Unknown grammar and extra requested work keep the ordinary tool loop. */
function isSimplePlaybackGoal(task: string): boolean {
  const text = task.normalize('NFKC').trim().replace(/[。.!！]+$/u, '').trim();
  if (!requiresMediaPlaybackAction(text) || /[\r\n]/u.test(text)) return false;
  // i18n-allow: Bounded playback command grammar and application aliases.
  const player = '(?:爱奇艺|优酷|腾讯视频|哔哩哔哩|芒果TV|网易云(?:音乐)?|QQ\\s*音乐|酷狗(?:音乐)?|播放器|Spotify|Apple\\s+Music|NetEase(?:\\s+Cloud\\s+Music)?|CloudMusic|iQIYI|YouTube|Netflix|Bilibili)';
  // i18n-allow: Opening/focusing the player is preparation, not a second goal.
  const chinese = new RegExp(`^(?:(?:请|麻烦|帮我|给我|直接|现在|马上)\\s*)*(?:(?:用|通过|在)\\s*${player}\\s*(?:里|中)?\\s*)?(?:(?:打开|启动|聚焦)\\s*${player}\\s*(?:并|然后|再|，|,)\\s*)?(?:播放|放一?首|听一?首|继续播放|放一下|放)(.+)$`, 'iu');
  const english = new RegExp(`^(?:please\\s+)?(?:(?:open|launch|focus)\\s+${player}\\s+(?:and|then)\\s+)?(?:play|resume|listen\\s+to|put\\s+on)\\s+(.+)$`, 'iu');
  const tail = (text.match(chinese)?.[1] || text.match(english)?.[1] || '').trim();
  if (!tail) return false;
  // Do not interpret action-like words inside a quoted programme/song title
  // as another instruction. Outside it, reject any additional action clause.
  const remaining = tail.replace(/[《“"]([^》”"\n]+)[》”"]/gu, 'media');
  // i18n-allow: Extra operations and sequencing are deliberately excluded from early stopping.
  return !/[，,；;。!?！？]|(?:然后|之后|接着|再|同时|顺便|并且|并|播放后|播完|结束后|截图|截屏|发送|分享|音量|全屏|定时|下载|保存|暂停|循环|倍速|字幕|录屏|投屏|关闭|退出|收藏|点赞|评论|静音|后台|小声|大声|切换|打开|分钟|小时|秒后)|\b(?:and|then|after|before|also|screenshot|capture|send|share|volume|fullscreen|full\s+screen|schedule|download|save|pause|repeat|loop|speed|subtitle|record|cast|close|exit|mute|background|minutes?|hours?|seconds?)\b/iu.test(remaining);
}

export function hasCompletedCurrentSimplePlayback(
  task: string, records: ToolExecutionRecord[], context?: Pick<ToolContext, 'requestId' | 'taskId'>,
): boolean {
  const requestId = String(context?.requestId || '').trim();
  const taskId = String(context?.taskId || '').trim();
  if (!requestId || !taskId || !isSimplePlaybackGoal(task)) return false;
  const current = records.filter(record => {
    const requestIds = [record.requestId, record.turnId, record.envelope?.requestId, record.envelope?.turnId].filter(Boolean);
    const taskIds = [record.taskId, record.envelope?.taskId].filter(Boolean);
    return requestIds.length > 0 && requestIds.every(value => value === requestId)
      && taskIds.length > 0 && taskIds.every(value => value === taskId)
      && (record as ToolExecutionRecord & { receiptScopeConflict?: boolean }).receiptScopeConflict !== true;
  });
  return hasMediaPlaybackEvidence(current, task, { requestId, taskId });
}
