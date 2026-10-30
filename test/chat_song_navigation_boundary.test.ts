import { buildActionContract } from '../server/cognition/action_contract';
import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { hasRequestedArtifactMutation } from '../server/cognition/tool_intent';
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

it.each(['Return to chat', 'Return to the chat window', 'Open my settings', 'Open the memory avatars'])('accepts a complete English client operand with qualifiers: %s', text => {
  expect(normalizeActionIntent(text).kind).toBe('client_navigation');
});
it.each([
  'Returnto the chat window', 'Open mysettings', 'Open the memory avatars_backup',
  'Do not return to the chat window.', 'If I return to the chat window, explain what happens.',
  'The page says "Return to the chat window". Explain that label.',
  'Open the chat window in WeChat.', 'Open the settings page of https://example.invalid.',
])('does not expand client navigation into negation, quoted data or external operands: %s', text => {
  expect(normalizeActionIntent(text).kind).not.toBe('client_navigation');
});
it.each(['并修改对白', '并且编辑字幕', '并修订台词'])('retains a coordinated edit as production work after the existing handoff: %s', extra => {
  const text = existingVideo + extra;
  expect(hasRequestedArtifactMutation(text)).toBe(true);
  expect(buildActionContract(text)).toMatchObject({ kind: 'artifact_work', applies: true });
  expect(buildActionContract(text).artifactMode).not.toBe('retrieve');
});
it.each([
  existingVideo + '，不要修改对白。',
  '不要' + existingVideo.slice(1) + '并修改对白。',
  '假设' + existingVideo + '并修改对白，只解释这个例子。',
  '原文写着“' + existingVideo + '并修改对白”。请只解释这句话。',
  existingVideo + '，标题是“返回并修改对白”。',
  existingVideo + '并说明如何修改对白。',
  '请读取 "D:/fixtures/返回并修改对白.txt"。',
  '请把包含返回并修改说明的文件返回。',
  '请把包含附件返回并修改说明的文件返回。',
  '返回并修改是什么意思？',
  existingVideo + '并修改对白是什么意思？',
  existingVideo + '。返回并修改是一句标题。',
  existingVideo + '，不要修改任何内容。返回并修改是一句标题。',
  existingVideo + '，“这是原文”。返回并修改是一句标题。',
  existingVideo + '，然后取回并修改是什么意思？',
  existingVideo + '，不要重新保存成片。',
  '原文写着“重新保存成片”。请解释这句话。',
  '请取回重新保存的成片。',
])('does not authorize an edit from prohibited, quoted, hypothetical or descriptive text: %s', text => {
  expect(hasRequestedArtifactMutation(text)).toBe(false);
});
