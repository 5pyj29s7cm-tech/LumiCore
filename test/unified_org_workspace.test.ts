import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('unified organization workspace boundary', () => {
  it('does not ship a standalone organization client or server role', () => {
    const pkg = JSON.parse(read('package.json'));
    const vite = read('vite.config.ts');
    const server = read('server.ts');
    const compose = read('docker-compose.yml');

    expect(fs.existsSync(path.join(root, 'index.org.html'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/entries/org.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'server/runtime/role.ts'))).toBe(false);
    expect(pkg.scripts['dev:org']).toBeUndefined();
    expect(pkg.scripts['dev:org:direct']).toBeUndefined();
    expect(vite).not.toContain('index.org.html');
    expect(server).not.toContain('resolveRole');
    expect(compose).not.toContain('lumi-org');
    expect(compose).not.toContain('LUMI_ROLE');
  });

  it('keeps the organization portal in the main desktop and web clients', () => {
    const desktop = read('src/entries/desktop.tsx');
    const web = read('src/entries/web.tsx');
    const portal = read('src/components/OrgPortal.tsx');
    const hub = read('src/components/org/OrgHub.tsx');

    expect(desktop).toContain("case 'org'");
    expect(desktop).toContain('<OrgPortal />');
    expect(web).toContain("case 'org'");
    expect(web).toContain('<OrgPortal />');
    expect(portal).toContain("await switchDomain('work')");
    expect(portal).toContain('<OrgHub />');
    expect(hub).toContain("switchDomain('personal')");
  });

  it('keeps native desktop window controls visible above the organization workbench', () => {
    const desktopUi = read('src/components/DesktopUI.tsx');

    expect(desktopUi).toContain('lumi-shell-topbar absolute top-0 inset-x-0 h-10');
    expect(desktopUi).toContain('fixed inset-x-0 bottom-0 top-10 z-[90] bg-celestial-deep overflow-auto');
    expect(desktopUi).not.toContain('fixed inset-0 z-[220] bg-celestial-deep overflow-auto');
  });
});
