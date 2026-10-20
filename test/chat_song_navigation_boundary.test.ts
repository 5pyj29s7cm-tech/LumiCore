import { buildActionContract } from '../server/cognition/action_contract';
import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
it.each(['open chat', 'Return to the chat window', '返回聊天窗口', '打开设置页面'])('preserves a real UI navigation: %s', text => {
  expect(normalizeActionIntent(text).kind).toBe('client_navigation');
});
it.each(['Return the existing video for chat-song project 00000000-0000-4000-8000-000000000001, revision 3, as an attachment. Do not regenerate or modify any file.',
  '请取回聊天唱歌工程 00000000-0000-4000-8000-000000000001 第3版已有成片，作为视频附件返回。不要重新生成或修改任何文件。',
  'Return the file containing chat_history to me.', 'Show the document describing profile_settings.'])('does not turn a compound identifier into a UI target: %s', text => {
  expect(normalizeActionIntent(text).kind).not.toBe('client_navigation');
});

const existingVideo = '请把已有工程 00000000-0000-4000-8000-000000000001 第3版的视频附件返回';
it.each(['并播放视频', '并下载到桌面', '并发给张三', '并重新生成视频', '并修改对白', '并把另一份视频也返回', '并发布到抖音'])('retrieval cannot discharge an additional positive obligation: %s', extra => {
  expect(buildActionContract(existingVideo + extra).artifactMode).not.toBe('retrieve');
});
