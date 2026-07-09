/**
 * Lightweight language detection for Chinese vs English mixed input.
 * No dependencies — pure regex heuristics.
 */

export type DetectedLanguage = 'zh' | 'en' | 'mixed';

const CHINESE_CONTEXT_HINTS = [
  '我', '你', '他', '她', '它', '们',
  '的', '了', '吗', '呢', '吧', '是', '在', '有', '和',
  '怎么', '如何', '为什么', '为啥', '帮我', '请', '能不能', '可以',
  '修复', '报错', '问题', '中文', '英文', '回复', '消息',
];

function containsChineseContextHint(text: string): boolean {
  return CHINESE_CONTEXT_HINTS.some(hint => text.includes(hint));
}

/** Detect dominant language from raw user input text */
export function detectLanguage(text: string): DetectedLanguage {
  const stripped = text.replace(/[\s\d\p{P}]/gu, '');
  if (stripped.length === 0) return 'en';

  let cjk = 0;
  let latin = 0;

  for (const ch of stripped) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) || // CJK Unified
      (code >= 0x3400 && code <= 0x4DBF) || // CJK Extension A
      (code >= 0x20000 && code <= 0x2A6DF)  // CJK Extension B
    ) {
      cjk++;
    } else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      latin++;
    }
  }

  const total = cjk + latin;
  if (total === 0) return 'en';

  const cjkRatio = cjk / total;
  if (cjk > 0 && containsChineseContextHint(text)) return 'zh';
  if (cjk >= 2 && cjkRatio >= 0.2) return 'zh';
  if (cjkRatio > 0.55) return 'zh';
  if (cjkRatio < 0.15) return 'en';
  return 'mixed';
}

/** Get the recommended response language based on input */
export function getResponseLanguage(userText?: string): string {
  if (!userText) return 'Simplified Chinese by default, unless the user explicitly asks for another language';
  const lang = detectLanguage(userText);
  if (lang === 'zh') return 'Simplified Chinese';
  if (lang === 'en') return 'English';
  return 'the same language as the user, preferring Simplified Chinese when Chinese appears in the message';
}

/** Prompt overlay that keeps the assistant's answer language aligned with the user. */
export function buildResponseLanguageInstruction(userText?: string): string {
  const responseLang = getResponseLanguage(userText);
  return [
    '## Response Language',
    `The latest user message should be answered in ${responseLang}.`,
    'If the latest user message contains Chinese, reply in natural Simplified Chinese unless the user explicitly requests another language.',
    'Do not switch to English just because system, tool, memory, or file context is written in English.',
    'Keep internal tool names, protocol fields, and execution policy semantics in canonical English, but localize user-visible status, progress, blockers, and errors into the user-facing language.',
  ].join('\n');
}
