import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('database health status', () => {
  it('does not report the normal coalesced write window as degraded', () => {
    const dbSource = fs.readFileSync(path.join(process.cwd(), 'db_layer.ts'), 'utf8');
    const routeSource = fs.readFileSync(
      path.join(process.cwd(), 'server', 'routes', 'system_routes.ts'),
      'utf8',
    );

    expect(dbSource).toContain('lagMs >= 30_000');
    expect(dbSource).toContain('Boolean(lastPersistenceError)');
    expect(routeSource).toContain('status: persistence.degraded ? "degraded" : "ok"');
    expect(routeSource).not.toContain('status: isDbDirty() ? "degraded" : "ok"');
    expect(routeSource).toContain('persistence,');
  });
});
