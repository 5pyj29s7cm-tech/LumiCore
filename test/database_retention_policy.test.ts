import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('database retention policy', () => {
  it('never prunes durable memories by an arbitrary row limit', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'db_layer.ts'), 'utf8');
    const start = source.indexOf('export function pruneOldData');
    const end = source.indexOf('// Write lock to prevent concurrent SQLite transactions', start);
    const implementation = source.slice(start, end);

    expect(implementation).toContain('interactions: 20000');
    expect(implementation).toContain('tokenUsage: 5000');
    expect(implementation).not.toMatch(/memories\s*:/);
    expect(implementation).not.toMatch(/memories['"]\s*[,}]/);
  });
});
