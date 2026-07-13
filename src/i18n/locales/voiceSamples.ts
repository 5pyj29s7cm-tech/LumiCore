const VOICE_SAMPLE_TEXTS: Record<string, string> = {
  en: 'Hello, this is my voice sample.',
  zh: '你好，这是我的声音样本。',
  ja: 'こんにちは、これは私の声のサンプルです。',
  ko: '안녕하세요, 이것은 제 음성 샘플입니다.',
};

export function voiceSampleText(language?: string): string {
  const normalized = String(language || 'en').trim().toLowerCase().split(/[-_]/)[0];
  return VOICE_SAMPLE_TEXTS[normalized] || VOICE_SAMPLE_TEXTS.en;
}
