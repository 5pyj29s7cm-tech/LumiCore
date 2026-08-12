import './helpers';
import { describe, expect, it } from 'vitest';
import { createHash, createPublicKey } from 'crypto';
import { loadOrCreateLAPIdentity } from '../server/lap/identity';

describe('LAP local identity', () => {
  it('persists a stable Ed25519 public identity without exposing the private key', () => {
    const first = loadOrCreateLAPIdentity();
    const second = loadOrCreateLAPIdentity();

    expect(second.agentId).toBe(first.agentId);
    expect(second.userId).toBe(first.userId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.publicKey).not.toContain('PRIVATE KEY');
    expect(createPublicKey(first.publicKey).asymmetricKeyType).toBe('ed25519');
    expect(createHash('sha256').update(first.publicKey).digest('hex')).toHaveLength(64);
  });
});
