import { getLocale, type Locale } from '../runtime';

const PERSONALITY_EVOLUTION_COPY = {
  en: {
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
