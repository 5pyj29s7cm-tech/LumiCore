import { describe, expect, it } from 'vitest';
import fs from 'fs';

describe('desktop bundle budget gate', () => {
  it('enforces the 750 KiB initial gzip budget and rejects heavy preloads', () => {
    const script = fs.readFileSync('scripts/check-desktop-bundle-budget.mjs', 'utf8');
    expect(script).toContain('750 * 1024');
    expect(script).toContain("path.resolve(root, 'dist/desktop')");
    expect(script).toContain("path.resolve(root, 'dist')");
    for (const forbidden of ['vendor-r3-', 'vendor-picovoice', 'vendor-mediapipe', 'vendor-terminal', 'OrbitControls']) {
      expect(script).toContain(forbidden);
    }
  });

  it('keeps heavy feature libraries out of manual shared chunks', () => {
    const config = fs.readFileSync('vite.config.ts', 'utf8');
    expect(config).not.toMatch(/return ['"]vendor-(?:r3|picovoice|mediapipe|terminal)/);
  });
});
