import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop optional bundle budget', () => {
  it('keeps heavy feature families out of preload and gives each a growth ceiling', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'check-desktop-bundle-budget.mjs'),
      'utf8',
    );

    expect(source).toContain('forbidden heavy desktop preload');
    expect(source).toContain('wake-word optional chunk');
    expect(source).toContain('3D optional chunk');
    expect(source).toContain('terminal optional chunk');
    expect(source).toContain('vision optional chunk');
  });

  it('does not force lazy markdown rendering into a shared eager chunk', () => {
    const viteConfig = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfig).not.toContain("return 'vendor-markdown'");
  });
});
