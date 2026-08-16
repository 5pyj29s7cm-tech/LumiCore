export interface ConversationCorrectionRecord {
  role?: string;
  message?: string;
  response?: string;
}

interface ExactReplacement {
  from: string;
  to: string;
}

const EXACT_REPLACEMENT_CUE = /(?:其他|其它|其余|剩下的?)(?:内容)?(?:都)?不变|只(?:改|替换|换)(?:这|该)?(?:一处|一个|部分)|leave\s+(?:everything|the\s+rest)\s+(?:else\s+)?unchanged/iu;

function stripWrappingQuotes(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^[“”"‘’']+|[“”"‘’']+$/gu, '')
    .trim();
}

function parseExactReplacement(text: string): ExactReplacement | null {
  const input = String(text || '').trim();
  if (!input || !EXACT_REPLACEMENT_CUE.test(input)) return null;

  const quoted = input.match(
    /(?:把|将)\s*[“"‘']([^”"’']{1,120})[”"’']\s*(?:改成|改为|换成|替换为)\s*[“"‘']([^”"’']{1,120})[”"’']/u,
  );
  if (quoted) {
    const from = stripWrappingQuotes(quoted[1]);
    const to = stripWrappingQuotes(quoted[2]);
    return from && to && from !== to ? { from, to } : null;
  }

  const plain = input.match(
    /(?:把|将)\s*(.{1,120}?)\s*(?:改成|改为|换成|替换为)\s*(.{1,120}?)(?=[，,。；;]|(?:其他|其它|其余|剩下的?)|只(?:改|替换|换)|$)/u,
  );
  if (plain) {
    const from = stripWrappingQuotes(plain[1]);
    const to = stripWrappingQuotes(plain[2]);
    return from && to && from !== to ? { from, to } : null;
  }

  const english = input.match(
    /replace\s+[“"']?(.{1,120}?)[”"']?\s+with\s+[“"']?(.{1,120}?)[”"']?(?=[,.;]|\s+and\s+leave|$)/iu,
  );
  if (!english) return null;
  const from = stripWrappingQuotes(english[1]);
  const to = stripWrappingQuotes(english[2]);
  return from && to && from !== to ? { from, to } : null;
}

function recordText(record: ConversationCorrectionRecord): string {
  const message = String(record.message || '').trim();
  if (message) return message;
  return String(record.response || '').trim();
}

function sentenceContaining(text: string, needle: string): string {
  const index = text.lastIndexOf(needle);
  if (index < 0) return '';

  const boundary = /[。！？!?\n]/u;
  let start = index;
  while (start > 0 && !boundary.test(text[start - 1])) start -= 1;
  let end = index + needle.length;
  while (end < text.length && !boundary.test(text[end])) end += 1;
  if (end < text.length) end += 1;

  return text
    .slice(start, end)
    .trim()
    .replace(/^[-*•\d.、)）\s]+/u, '')
    .trim();
}

/**
 * Apply a narrowly scoped conversational correction without asking a model to
 * paraphrase the surrounding facts. This is intentionally limited to explicit
 * "only change this; keep everything else unchanged" instructions.
 */
export function resolveExactConversationCorrection(
  userText: string,
  history: ConversationCorrectionRecord[],
): string | null {
  const replacement = parseExactReplacement(userText);
  if (!replacement) return null;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const record = history[index];
    if (!record || !['assistant', 'user'].includes(String(record.role || ''))) continue;
    const source = recordText(record);
    if (!source.includes(replacement.from)) continue;
    const sentence = sentenceContaining(source, replacement.from);
    if (!sentence) continue;
    return sentence.split(replacement.from).join(replacement.to);
  }

  return null;
}
