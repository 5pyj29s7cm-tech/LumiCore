/** Native Wan2.2 clips are five seconds; Lumi composes longer requested outputs. */
export type VideoGenerationOptions = { sizes: readonly string[]; durations: readonly number[]; fixedDuration?: number };
const OFFICIAL_WAN2_OPTIONS: VideoGenerationOptions = {
  sizes: ['1920x1080', '1080x1920', '1440x1440', '832x480', '480x832', '624x624', '1632x1248', '1248x1632'],
  durations: [5, 10, 15, 30, 60, 120], fixedDuration: 5,
};
// Gateway /docs: Wan3 uses native 2–30 second outputs and 480P/720P/1080P sizes.
const OFFICIAL_WAN3_OPTIONS: VideoGenerationOptions = {
  sizes: ['1920x1080', '1080x1920', '1280x720', '720x1280', '832x480', '480x832', '624x624'],
  durations: Array.from({ length: 29 }, (_, index) => index + 2),
};
export function videoGenerationOptions(selection?: { provider?: string; model?: string }): VideoGenerationOptions | null {
  if (selection?.provider !== 'relay') return null;
  if (/^aliyun\/Wan2\.2-(?:T2V|I2V)-A14B$/i.test(selection.model || '')) return OFFICIAL_WAN2_OPTIONS;
  return /^aliyun\/wan3\.0-video(?:-prime)?$/i.test(selection.model || '') ? OFFICIAL_WAN3_OPTIONS : null;
}

/** Parse requested seconds once for both execution and result validation. */
export function requestedVideoDuration(text: string): number | undefined {
  // i18n-allow: Chinese and English duration input, not user-visible copy.
  const match = text.match(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+|半)\s*(秒钟?|分钟|seconds?|secs?\b|s\b|minutes?|mins?\b)/iu);
  if (!match) return undefined;
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let value = Number(match[1]);
  if (match[1] === '半') value = 0.5;
  else if (!Number.isFinite(value)) {
    let total = 0, digit = 0;
    for (const char of match[1]) {
      if (char === '十' || char === '百') { total += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
      else digit = digits[char];
    }
    value = total + digit;
  }
  return value * (/^(?:分钟|minutes?|mins?)$/iu.test(match[2]) ? 60 : 1);
}

/** Explicit audio requirements are checked against the saved file, without adding another execution route. */
export function requestedVideoAudio(text: string): boolean {
  // i18n-allow: Audio requirement and negation input recognition, not user-visible copy.
  const positive = text.replace(/(?:不要|无需|不需要|不要求|不加|不带|不用|去掉|去除|没有|无)\s*(?:任何|背景|英文|中文|英语|额外)?(?:声音|音轨|音效|配音|旁白|音乐)|\b(?:without|no|do not(?: need| add| include| generate)?|don't(?: need| add| include| generate)?)\s+(?:(?:any|background|English|extra)\s+)?(?:audio|sound(?: effects)?|voice[ -]?over|music|narration|soundtrack)\b/giu, '');
  // i18n-allow: Explicit native audio, voice, music and sound-effects requests.
  return /有声(?:视频|成片)?|声画同步|(?:带|包含|需要|要|有|保留|加入|加上|配上).{0,10}(?:声音|音轨|音效|配音|旁白|音乐)|(?:英文|中文|英语|国语|男声|女声).{0,6}(?:配音|旁白)|\b(?:with|include|including|needs?|add|retain|preserve)\b[^.!?\n,;]{0,50}\b(?:sound|audio|voice[ -]?over|music|narration|soundtrack|dialogue)\b|\b(?:English|spoken|native|synchronized)\s+(?:audio|voice[ -]?over|narration|dialogue)\b/iu.test(positive);
}
