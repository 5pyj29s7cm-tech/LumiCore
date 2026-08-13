import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('command center CSS maintenance budget', () => {
  it('keeps a dedicated duplicate-selector gate in the desktop build', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const script = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'check-command-center-css.mjs'),
      'utf8',
    );

    expect(packageJson.scripts['check:command-center-css']).toBe('node scripts/check-command-center-css.mjs');
    expect(packageJson.scripts['build:desktop-ui']).toContain('check:command-center-css');
    expect(script).toContain('blocked: command-center style overrides grew beyond the audited baseline');
  });
});
