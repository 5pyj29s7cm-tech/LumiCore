import { Memory } from '../types';

function semanticMemoryKey(memory: Memory): string {
  return String(memory.content || '')
    .toLowerCase()
    .replace(/^\[[^\]]{1,80}\]\s*/u, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 1000);
}

export function dedupeMemoriesInRankOrder<T>(
  candidates: T[], memoryFor: (candidate: T) => Memory,
): T[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const memory = memoryFor(candidate), key = semanticMemoryKey(memory) || memory.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Match CJK characters for language-aware tokenization
const CJK_RE = /[一-鿿㐀-䶿]/;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // Extract CJK character bigrams (overlapping pairs: 名字 → 名字)
  let cjkRun = '';
  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      cjkRun += ch;
      if (cjkRun.length >= 2) {
        tokens.push(cjkRun.slice(-2));
      }
    } else {
      if (cjkRun.length === 1) tokens.push(cjkRun); // lone CJK char
      cjkRun = '';
    }
  }
  if (cjkRun.length === 1) tokens.push(cjkRun);
  // Also split by whitespace for English/numbers
  const words = lower.split(/[\s,，。！？、；：""''（）\(\)\[\]【】]+/).filter(w => w.length > 1);
  for (const w of words) {
    if (!CJK_RE.test(w)) tokens.push(w);
    else if (w.length > 2) tokens.push(w); // keep full CJK words too
  }
  return [...new Set(tokens)];
}

// Negation patterns in Chinese and English
const NEGATION_PATTERNS = [
  /不[^过论妨仅管只论止断愧外必再会]/u, /没[有想]/u, /别/u, /否/u, /非/u,
  /\bnot\b/i, /\bdon'?t\b/i, /\bnever\b/i, /\bno\b/i, /\bcan'?t\b/i, /\bwon'?t\b/i,
];

// Common polarity-flip pairs: positive → negative
const POLARITY_PAIRS: [RegExp, string][] = [
  [/\b(?:like|likes|liked|love|loves|loved)\b/gi, 'dislike|dislikes|disliked|hate|hates|hated|does not like|do not like'],
  [/喜欢|爱|享受|热爱/g, '讨厌|恨|厌恶|反感'],
  [/好|棒|优秀|出色|赞/g, '差|烂|糟糕|坏|垃圾'],
  [/快|迅速|高效/g, '慢|缓慢|拖沓'],
  [/简单|容易/g, '复杂|困难'],
  [/美|漂亮|好看/g, '丑|难看'],
  [/有用|方便|实用/g, '没用|不便|鸡肋'],
  [/开启|打开|启用|使用/g, '关闭|禁用|停用|不用'],
  [/经常|一直|总是/g, '从不|很少|偶尔'],
];

/**
 * Extract key semantic units from text — CJK bigrams + normalized English words,
 * with negation markers preserved for polarity-aware comparison.
 */
function semanticTokens(text: string): { tokens: Set<string>; negated: Set<string> } {
  const base = tokenize(text);
  const tokens = new Set(base);
  const negated = new Set<string>();

  // Detect negated tokens: if a negation word appears within ±3 chars of a token
  const lower = text.toLowerCase();
  for (const negPat of NEGATION_PATTERNS) {
    const match = lower.match(negPat);
    if (match && match.index !== undefined) {
      const negPos = match.index;
      // Mark tokens near the negation as negated
      for (const t of base) {
        const tpos = lower.indexOf(t);
        if (tpos >= 0 && Math.abs(tpos - negPos) <= 8) {
          negated.add(t);
        }
      }
    }
  }

  return { tokens, negated };
}

/** Check if high-overlap texts have opposite polarity (contradiction) */
function hasPolarityConflict(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();

  for (const [posPat, negList] of POLARITY_PAIRS) {
    posPat.lastIndex = 0;
    const negPats = negList.split('|');
    const aHasPos = posPat.test(lowerA);
    posPat.lastIndex = 0;
    const bHasPos = posPat.test(lowerB);

    for (const negStr of negPats) {
      const negRe = new RegExp(negStr, 'i');
      const aHasNeg = negRe.test(lowerA);
      const bHasNeg = negRe.test(lowerB);

      // One text is positive, the other negative → contradiction
      if ((aHasPos && bHasNeg) || (aHasNeg && bHasPos)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Improved content similarity: combines fast lexical overlap with
 * negation-aware semantic comparison. Returns [score, hasContradiction].
 */
export function contentSimilarity(a: string, b: string): number {
  const { tokens: tokA, negated: negA } = semanticTokens(a);
  const { tokens: tokB, negated: negB } = semanticTokens(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;

  // Core lexical overlap (Jaccard with negation penalty)
  let overlap = 0;
  let negOverlap = 0;
  for (const w of tokA) {
    if (tokB.has(w)) {
      overlap++;
      // If one side is negated but the other isn't, reduce effective overlap
      if ((negA.has(w) && !negB.has(w)) || (!negA.has(w) && negB.has(w))) {
        negOverlap++;
      }
    }
  }

  const baseScore = overlap / Math.max(tokA.size, tokB.size);
  // Penalize negated overlaps — they indicate opposite meanings
  const penalty = overlap > 0 ? (negOverlap / overlap) * 0.5 : 0;
  return Math.max(0, baseScore - penalty);
}

/** Check if a new memory contradicts any existing memories for the same user */
export function findContradictions(
  newContent: string,
  existingMemories: Memory[],
): Memory[] {
  const contradictions: Memory[] = [];
  const lower = newContent.toLowerCase();

  for (const existing of existingMemories) {

    const sim = contentSimilarity(newContent, existing.content);
    // Only check for contradiction when there's meaningful overlap
    if (sim < 0.35) continue;

    if (hasPolarityConflict(lower, existing.content.toLowerCase())) {
      contradictions.push(existing);
    }
  }

  return contradictions;
}

export function dedupeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 10);
}
