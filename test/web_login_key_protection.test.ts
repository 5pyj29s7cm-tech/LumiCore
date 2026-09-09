import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDataPath } from '../server/config/data_path';
import { getWebLoginCredentialKey } from '../server/web_login/credential_key';
function fixture() {
  const filename = getDataPath(`synthetic-login-key-${Date.now()}-${Math.random()}/key`);
  const files = { ensurePrivateDirectory: vi.fn((directory: string) => { fs.mkdirSync(directory, { recursive: true }); }), writeTextAtomic: vi.fn((target: string, value: string) => fs.writeFileSync(target, value)) };
  return { filename, files };
}
describe('web login shared private persistence', () => {
  it('never writes a plain key when Windows protection fails', () => {
    const { filename, files } = fixture();
    expect(() => getWebLoginCredentialKey(filename, { platform: 'win32', files, protection: { protectKey: () => { throw new Error('synthetic DPAPI failure'); }, unprotectKey: vi.fn() } })).toThrow('synthetic DPAPI failure');
    expect(files.writeTextAtomic).not.toHaveBeenCalled(); expect(fs.existsSync(filename)).toBe(false);
  });
  it('migrates legacy bytes only after protect/unprotect verification succeeds', () => {
    const { filename, files } = fixture(); const key = Buffer.alloc(32, 7);
    fs.writeFileSync(filename, `plain:${key.toString('base64')}`);
    const protection = { protectKey: vi.fn(() => 'synthetic-protected'), unprotectKey: vi.fn(() => key) };
    expect(getWebLoginCredentialKey(filename, { platform: 'win32', files, protection })).toEqual(key);
    expect(fs.readFileSync(filename, 'utf8')).toBe('dpapi:synthetic-protected');
    expect(files.writeTextAtomic).toHaveBeenCalledWith(filename, 'dpapi:synthetic-protected', 0o600, false);
  });
  it('preserves the previous key if migration fails and rejects malformed key material', () => {
    const { filename, files } = fixture(); const value = `plain:${Buffer.alloc(32, 9).toString('base64')}`;
    fs.writeFileSync(filename, value);
    expect(() => getWebLoginCredentialKey(filename, { platform: 'win32', files, protection: { protectKey: () => { throw new Error('unavailable'); }, unprotectKey: vi.fn() } })).toThrow('unavailable');
    expect(fs.readFileSync(filename, 'utf8')).toBe(value);
    fs.writeFileSync(filename, 'plain:invalid');
    expect(() => getWebLoginCredentialKey(filename, { platform: 'linux', files })).toThrow('Invalid');
  });
});
