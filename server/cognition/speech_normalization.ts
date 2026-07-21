function comparisonKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function joinSpelledLatinTokens(value: string): string {
  return value.replace(/\b(?:[A-Za-z]\s+){1,7}[A-Za-z]\b/g, match => {
    const letters = match.match(/[A-Za-z]/g) || [];
    return letters.length >= 2 && letters.length <= 8 ? letters.join('') : match;
  });
}

function collapseRepeatedHalf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 4 || trimmed.length % 2 !== 0) return trimmed;
  const half = trimmed.length / 2;
  const left = trimmed.slice(0, half).trim();
  const right = trimmed.slice(half).trim();
  return comparisonKey(left) === comparisonKey(right) ? left : trimmed;
}

/**
 * Repairs provider-level transcript duplication without interpreting the
 * command itself. It only joins spelled Latin tokens and removes adjacent,
 * exactly repeated clauses, so application names and task semantics remain
 * open-ended rather than living in a hard-coded alias table.
 */
export function normalizeSpeechCommand(input: string): string {
  const normalized = joinSpelledLatinTokens(String(input || '').normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';

  const clauses = normalized.match(/[^\u3002\uff01\uff1f!?\uff1b;\uff0c,\n]+[\u3002\uff01\uff1f!?\uff1b;\uff0c,\n]*/gu) || [normalized];
  const kept: string[] = [];
  let previous = '';
  for (const clause of clauses) {
    const key = comparisonKey(clause);
    if (!key || key === previous) continue;
    kept.push(clause.trim());
    previous = key;
  }
  const collapsed = collapseRepeatedHalf(kept.join(' ').replace(/\s+([\u3002\uff01\uff1f!?\uff1b;\uff0c,])/gu, '$1'));
  return collapsed.replace(/([\u3002\uff01\uff1f!?\uff1b;\uff0c,])\1+/gu, '$1').trim();
}

export function speechCommandKey(input: string): string {
  return comparisonKey(normalizeSpeechCommand(input));
}
