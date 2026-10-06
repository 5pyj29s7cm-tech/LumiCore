

export function compact(value: unknown, limit = 500): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function parseTaskTargetJson(value: unknown): unknown {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === 'string'; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

export function objectValue(value: unknown): Record<string, unknown> {
  const parsed = parseTaskTargetJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export function firstString(object: Record<string, unknown>, keys: string[], limit = 500): string {
  for (const key of keys) {
    const direct = object[key];
    if (typeof direct === 'string' || typeof direct === 'number') {
      const value = compact(direct, limit);
      if (value) return value;
    }
    const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
    const entry = Object.entries(object).find(([candidate]) => (
      candidate.replace(/[_-]/g, '').toLowerCase() === normalizedKey
    ));
    if (entry && (typeof entry[1] === 'string' || typeof entry[1] === 'number')) {
      const value = compact(entry[1], limit);
      if (value) return value;
    }
  }
  return '';
}

export function normalizedIdentity(value: unknown): string {
  return compact(value, 500)
    .replace(/[\\/]+/g, '/')
    .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '')
    .toLocaleLowerCase();
}

export function unique(values: unknown[], limit = 12): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const clean = compact(value, 500);
    const key = normalizedIdentity(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output.slice(-limit);
}

export function primaryTaskText(text: string): string {
  return String(text || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
}

export function capsuleTaskText(text: string): string {
  const raw = String(text || '');
  if (!/Current task capsule \(TaskCapsuleV1\):/i.test(raw)) return '';
  return ['goal', 'currentInstruction', 'target', 'targetApplication', 'targetObject', 'targetPath']
    .map(name => compact(raw.match(new RegExp(`(?:^|\\n)- ${name}:\\s*(.+)`, 'i'))?.[1], 700))
    .filter(Boolean)
    .join(' ');
}
