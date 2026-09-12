/** Shared playback intent for conversational speech and desktop routing. */
export function isMediaPauseRequest(value: string): boolean {
  const text = String(value || '').normalize('NFKC').trim();
  // i18n-allow: Explicit player pause intent; task cancellation and questions stay separate.
  if (!text || /(?:不要|别|不用|无需|为什么|怎么|如何|如果)|\b(?:don't|do not|why|how|if)\b/iu.test(text)) return false;
  return /(?:暂停|停止播放|pause|stop playing)/iu.test(text)
    // i18n-allow: Requested media surface recognition, never user-visible copy.
    && /(?:音乐|歌曲|视频|电影|播放器|网易云|QQ音乐|酷狗)|\b(?:music|song|video|movie|player|Spotify|CloudMusic|NetEase)\b/iu.test(text);
}

export function isVideoPlaybackRequest(value: string): boolean {
  const text = String(value || '').normalize('NFKC').trim();
  // i18n-allow: Multilingual input recognition, never user-visible copy.
  if (!text || isMediaPauseRequest(text) || /(?:不要|别|不用|无需|禁止).{0,12}(?:放|播|看)|^(?:解释|介绍|为什么|怎么|如何)|\b(?:do not|don't|explain|why|how)\b/iu.test(text)) return false;
  // i18n-allow: Media surfaces and imperative wording, never output.
  const surface = /(?:爱奇艺|优酷|腾讯视频|哔哩哔哩|芒果TV|播放器|视频|电影|电视剧|动画片)|\b(?:iqiyi|youku|youtube|netflix|bilibili|video|movie|episode)\b/iu.test(text);
  // A title-only viewing request need not repeat the word "video". Exclude
  // documents, UI inspection and questions; resolve the requested title from
  // search/player evidence, never a hard-coded show-specific script.
  const requestedTitle = text.match(/^(?:请)?(?:我要|我想|帮我|给我)看\s*[《“"]?([^。！？!?\n]{1,60})[》”"]?[。！!]*$/u)?.[1]; // i18n-allow: Chinese title-only viewing input.
  const titleOnly = Boolean(requestedTitle && !/(?:文件|文档|资料|代码|目录|文件夹|报告|表格|图片|照片|户型|图纸|设计|日志|设置|状态|结果|进度|权限|能力|账户|账号|余额|账单|屏幕|桌面|窗口|页面|看|怎么|如何|为什么|你|我|他|她|它|这个|那个|刚才|之前|\.\w{1,5}\b)/u.test(requestedTitle)); // i18n-allow: Non-media viewing targets remain on their own routes.
  // Require both a media surface and an action: mentioning a service alone
  // cannot authorize playback, and '放' in placement instructions is unrelated.
  // i18n-allow: Multilingual imperative playback recognition.
  const action = /(?:播放|放(?:吧|一下|一集|第|个|《)|(?:帮我|给我|用|通过).{0,24}放|(?:我要|我想|帮我|给我)看)|\b(?:play|resume|put on|start playing)\b/iu.test(text);
  return action && (surface || titleOnly);
}
