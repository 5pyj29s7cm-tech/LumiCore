/** Native Wan2.2 clips are five seconds; Lumi composes longer requested outputs. */
export type VideoGenerationOptions = { sizes: readonly string[]; durations: readonly number[]; fixedDuration?: number };
const OFFICIAL_WAN_OPTIONS: VideoGenerationOptions = {
  sizes: ['1920x1080', '1080x1920', '1440x1440', '832x480', '480x832', '624x624', '1632x1248', '1248x1632'],
  durations: [5, 10, 15, 30, 60, 120], fixedDuration: 5,
};
export function videoGenerationOptions(selection?: { provider?: string; model?: string }): VideoGenerationOptions | null {
  return selection?.provider === 'relay' && /^aliyun\/Wan2\.2-(?:T2V|I2V)-A14B$/i.test(selection.model || '')
    ? OFFICIAL_WAN_OPTIONS : null;
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
