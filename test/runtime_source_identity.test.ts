import { describe, expect, it } from 'vitest';
import { fingerprintSourceSnapshot } from '../scripts/lib/source-identity.mjs';

describe('runtime source identity', () => {
  it('is deterministic while binding tracked and untracked source content', () => {
    const base = {
      head: 'abc123',
      status: Buffer.from(' M server.ts\0?? security/policy.json\0'),
      diff: Buffer.from('diff --git a/server.ts b/server.ts'),
      untracked: [{ path: 'security/policy.json', content: Buffer.from('{"ok":true}') }],
    };
    const fingerprint = fingerprintSourceSnapshot(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintSourceSnapshot(base)).toBe(fingerprint);
    expect(fingerprintSourceSnapshot({
      ...base,
      untracked: [{ path: 'security/policy.json', content: Buffer.from('{"ok":false}') }],
    })).not.toBe(fingerprint);
  });

  it('does not depend on untracked input ordering', () => {
    const common = { head: 'abc123', status: Buffer.from('?? a\0?? b\0') };
    const left = fingerprintSourceSnapshot({
      ...common,
      untracked: [
        { path: 'b', content: Buffer.from('2') },
        { path: 'a', content: Buffer.from('1') },
      ],
    });
    const right = fingerprintSourceSnapshot({
      ...common,
      untracked: [
        { path: 'a', content: Buffer.from('1') },
        { path: 'b', content: Buffer.from('2') },
      ],
    });
    expect(left).toBe(right);
  });
});
