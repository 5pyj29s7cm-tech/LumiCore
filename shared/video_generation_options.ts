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
