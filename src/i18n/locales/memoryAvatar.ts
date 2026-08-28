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
    labTitle: 'Memory Avatar Lab',
    qq: 'QQ',
    plain: 'Plain text',
    youLabel: 'You',
    memoryLabel: 'Memory',
    audioRecordHeader: 'Voice record',
    transcriptionFailed: 'Audio transcription failed',
    uploadChatLogFirst: 'Please upload a chat log first',
    distillationFailed: 'Distillation failed',
    memoryAvatarCreationFailed: 'Memory avatar creation failed',
    creationFailed: 'Creation failed',
    distilledPersonality: (name: string, count: number) => `Distilled personality for "${name}" — ${count} memories extracted`,
    sanctuaryCreatedFor: (name: string) => `Sanctuary created for "${name}"`,
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
    labTitle: '记忆化身实验室',
    qq: 'QQ',
    plain: '纯文本',
    youLabel: '你',
    memoryLabel: '记忆',
    audioRecordHeader: '语音记录',
    transcriptionFailed: '语音转录失败',
    uploadChatLogFirst: '请先上传聊天记录',
    distillationFailed: '人格蒸馏失败',
    memoryAvatarCreationFailed: '记忆化身创建失败',
    creationFailed: '创建失败',
    distilledPersonality: (name: string, count: number) => `已从“${name}”蒸馏人格，提取 ${count} 条记忆`,
    sanctuaryCreatedFor: (name: string) => `已为“${name}”创建专属领地`,
  },
} as const;

export function memoryAvatarCopy(locale: Locale = getLocale()) {
  return MEMORY_AVATAR_COPY[locale];
}
