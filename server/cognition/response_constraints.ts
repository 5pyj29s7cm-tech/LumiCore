export interface ExplicitSentenceCountConstraint {
  expected: number;
  actual: number;
}

const CN_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseRequestedCount(value: string): number | null {
  const normalized = String(value || '').trim();
  const parsed = /^\d+$/u.test(normalized) ? Number(normalized) : CN_NUMBERS[normalized];
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
}

export function countResponseSentences(responseText: string): number {
  return String(responseText || '')
    .split(/[。！？!?]+/u)
    .map(part => part.trim())
    .filter(Boolean)
    .length;
}

export function getExplicitSentenceCountConstraint(
  taskText: string,
  responseText: string,
): ExplicitSentenceCountConstraint | null {
  const match = String(taskText || '').match(
    /(?:严格|总共|只能|只用|仅用|请用|回答(?:为|成)?)[^。！？!?\n]{0,12}?([一二两三四五六七八九十]|\d{1,2})句(?:话)?/u,
  );
  if (!match) return null;
  const expected = parseRequestedCount(match[1]);
  if (!expected) return null;
  return { expected, actual: countResponseSentences(responseText) };
}

export function sentenceCountCorrectionInstruction(expected: number): string {
  return `重写上一条回答，完整满足用户要求。最终回答必须严格为 ${expected} 句话：不能少答任何问题，也不能增加第 ${expected + 1} 句话。只输出重写后的最终回答。`;
}
