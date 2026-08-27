import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLocalAcceptanceHarnessIdentity } from '../scripts/lib/desktop-bootstrap.mjs';

describe('desktop bootstrap acceptance harness identity', () => {
  it('reports the real Node process without impersonating the Tauri client', async () => {
    const identity = await buildLocalAcceptanceHarnessIdentity(process.cwd());
    expect(identity).toMatchObject({
      schemaVersion: 1,
      clientKind: 'local_acceptance_harness',
      pid: process.pid,
      buildIdSemantics: 'baseline_commit',
      binaryHashUnavailable: false,
    });
    expect(path.isAbsolute(identity.executablePath)).toBe(true);
    expect(identity.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.buildId).toMatch(/^[a-f0-9]{40}$/);
    expect(identity.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof identity.sourceDirty).toBe('boolean');
    expect(identity).not.toHaveProperty('trustLevel');
    expect(identity).not.toHaveProperty('osAttested');
  });
});
