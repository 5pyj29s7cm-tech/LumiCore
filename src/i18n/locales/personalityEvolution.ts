import { getLocale, type Locale } from '../runtime';

const PERSONALITY_EVOLUTION_COPY = {
  en: {
    retry: 'Retry',
    noChange: 'No new evolution was produced.',
    unconfirmed: 'The change was not confirmed. Refresh before trying again.',
    dimensions: {
      analytical: 'Analytical',
      intuitive: 'Intuitive',
      systematic: 'Systematic',
      creative: 'Creative',
      warmth: 'Warmth',
      directness: 'Direct',
      playfulness: 'Playful',
      formality: 'Formal',
    },
  },
  zh: {
    retry: '重试',
    noChange: '本次没有产生新的进化。',
    unconfirmed: '未确认修改结果，请刷新后再试。',
    dimensions: {
      analytical: '分析',
      intuitive: '直觉',
      systematic: '系统',
      creative: '创造',
      warmth: '温度',
      directness: '直接',
      playfulness: '趣味',
      formality: '正式',
    },
  },
} as const;

export function personalityEvolutionCopy(locale: Locale = getLocale()) {
  return PERSONALITY_EVOLUTION_COPY[locale];
}
