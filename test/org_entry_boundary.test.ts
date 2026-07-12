import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('standalone organization entry boundary', () => {
  it('gates the organization entry through an organization-only portal', () => {
    const entry = read('src/entries/org.tsx');
    expect(entry).toContain("import('../components/OrgPortal')");
    expect(entry).toContain('<OrgPortal orgOnly />');
    expect(entry).not.toContain('<OrgHub />');
  });

  it('does not expose personal-domain controls in organization-only mode', () => {
    const portal = read('src/components/OrgPortal.tsx');
    const hub = read('src/components/org/OrgHub.tsx');
    expect(portal).toContain('<OrgHub allowPersonalDomain={!orgOnly} />');
    expect(hub).toContain('allowPersonalDomain && (');
    expect(hub).toContain('if (switchBusy || !allowPersonalDomain) return;');
  });
});
