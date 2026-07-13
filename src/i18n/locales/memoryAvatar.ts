import { getLocale, type Locale } from '../runtime';

const MEMORY_AVATAR_COPY = {
  en: {
    relationships: {
      close_friend: { label: 'Close Friend', desc: 'Best friend and confidant' },
      family: { label: 'Family', desc: 'Family, elders, siblings' },
      lover: { label: 'Partner', desc: 'Past or present romantic partner' },
      mentor: { label: 'Mentor', desc: 'Teacher, guide, or mentor' },
      colleague: { label: 'Colleague', desc: 'Work partner or teammate' },
    },
    dimensions: { analytical: 'Analytical', intuitive: 'Intuitive', systematic: 'Systematic', creative: 'Creative', warmth: 'Warmth', directness: 'Direct', playfulness: 'Playful', formality: 'Formal' },
    evidence: { verbatim: 'Quote', artifact: 'Fact', impression: 'Inferred' },
    memoryLabel: 'Memory',
    audioRecordHeader: 'Voice record',
    transcriptionFailed: 'Audio transcription failed',
  },
  zh: {
    relationships: {
      close_friend: { label: '挚友', desc: '最好的朋友、知心人' },
      family: { label: '亲人', desc: '家人、长辈、兄弟姐妹' },
      lover: { label: '恋人', desc: '曾经或现在的爱人' },
      mentor: { label: '导师', desc: '老师、师父、引路人' },
      colleague: { label: '同事', desc: '并肩工作的伙伴' },
    },
    dimensions: { analytical: '分析', intuitive: '直觉', systematic: '系统', creative: '创造', warmth: '温度', directness: '直接', playfulness: '趣味', formality: '正式' },
    evidence: { verbatim: '原话', artifact: '事实', impression: '推测' },
    memoryLabel: '记忆',
    audioRecordHeader: '语音记录',
    transcriptionFailed: '语音转录失败',
  },
} as const;

export function memoryAvatarCopy(locale: Locale = getLocale()) {
  return MEMORY_AVATAR_COPY[locale];
}
