import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('host skill REST scope boundary', () => {
  it('keeps every host skill mutation on the personal administrator surface', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/routes/skill_routes.ts'), 'utf8');
    for (const route of [
      'router.post("/skills/generate"',
      'router.post("/skills/install"',
      'router.post("/skills/:name/repair"',
      'router.delete("/skills/broken"',
      'router.delete("/skills/:name"',
      'router.post("/skills/:name/enable"',
      'router.post("/skills/:name/disable"',
    ]) {
      const start = source.indexOf(route);
      expect(start, route).toBeGreaterThanOrEqual(0);
      expect(source.slice(start, start + 260), route).toContain('requirePersonalHostSkillScope');
    }
  });

  it('binds generated-skill approval nonces to domain and organization scope', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/routes/skill_routes.ts'), 'utf8');
    expect(source).toContain('domain: scope.domain');
    expect(source).toContain("orgId: scope.orgId || ''");
    expect(source).toContain('approval.domain !== scope.domain');
    expect(source).toContain("approval.orgId !== (scope.orgId || '')");
  });

  it('keeps Skill Hall acquisition on the same personal-only boundary', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/routes/marketplace_routes.ts'), 'utf8');
    const start = source.indexOf('router.post("/marketplace/skills/acquire"');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 320)).toContain('requirePersonalMarketplaceMutation');
  });
});
