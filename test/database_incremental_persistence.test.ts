import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('incremental database persistence', () => {
  it('keeps atomic replacement scoped to tables whose serialized rows changed', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'db_layer.ts'), 'utf8');

    expect(source).toContain('persistenceTableDigests.get(spec.name) !== digest');
    expect(source).toContain('const STABLE_PERSISTENCE_TIMESTAMP = new Date(0).toISOString()');
    expect(source).not.toContain('updatedAt || pattern.createdAt || new Date().toISOString()');
    expect(source).toContain('for (const { spec, rows } of changed)');
    expect(source).toContain("lastFlushTables = changed.map(({ spec }) => spec.name)");
    expect(source).not.toContain('for (const spec of allSpecs) {\n      await run(`DROP TABLE IF EXISTS ${spec.name}`)');
  });

  it('retains a stable founder timestamp instead of making every flush dirty', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'db_layer.ts'), 'utf8');
    const routes = fs.readFileSync(
      path.join(process.cwd(), 'server', 'routes', 'misc_routes.ts'),
      'utf8',
    );

    expect(source).toContain('persistenceTimestamp(memoryDB.founderVisionUpdatedAt)');
    expect(routes).toContain('db.founderVisionUpdatedAt = updatedAt');
    expect(routes).toContain('await flushDBOrThrow()');
    expect(routes).not.toContain('INSERT OR REPLACE INTO founder_vision');
  });
});
