/** Shared playback intent for conversational speech and desktop routing. */
export function isVideoPlaybackRequest(value: string): boolean {
  const text = String(value || '').normalize('NFKC').trim();
  // i18n-allow: Multilingual input recognition, never user-visible copy.
  if (!text || /(?:不要|别|不用|无需|禁止).{0,12}(?:放|播|看)|^(?:解释|介绍|为什么|怎么|如何)|\b(?:do not|don't|explain|why|how)\b/iu.test(text)) return false;
  // i18n-allow: Media surfaces and imperative wording, never output.
  const surface = /(?:爱奇艺|优酷|腾讯视频|哔哩哔哩|芒果TV|播放器|视频|电影|电视剧|动画片)|\b(?:iqiyi|youku|youtube|netflix|bilibili|video|movie|episode)\b/iu.test(text);
  // Require both a media surface and an action: mentioning a service alone
  // cannot authorize playback, and '放' in placement instructions is unrelated.
  // i18n-allow: Multilingual imperative playback recognition.
  const action = /(?:播放|放(?:吧|一下|一集|第|个|《)|(?:帮我|给我|用|通过).{0,24}放|(?:我要|我想|帮我|给我)看)|\b(?:play|resume|put on|start playing)\b/iu.test(text);
  return surface && action;
}
