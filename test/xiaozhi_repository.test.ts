import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptedXiaozhiRepository } from '../server/devices/xiaozhi_repository';
import type { XiaozhiPrivateBinding } from '../server/devices/xiaozhi_mcp_gateway';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-xiaozhi-store-')); dirs.push(dir); const file = path.join(dir, 'bindings.enc.json');
  return { file, repository: new EncryptedXiaozhiRepository({ filePath: file, secret: () => 'offline-installation-key' }) }; }
function binding(): XiaozhiPrivateBinding { return { id: 'fixture-binding', ownerUid: 'private-owner-uid', deviceId: 'aa:bb:cc:dd:ee:ff', clientId: 'private-client-id', publicBaseUrl: 'http://192.168.50.10:17840', createdAt: 1000, pairingExpiresAt: 301000, pairedAt: null,
  bootstrapSecret: '1'.repeat(64), deviceSecret: '2'.repeat(64), bridgeSecret: '3'.repeat(64) }; }
describe('Xiaozhi installation-bound encrypted repository', () => {
  it('round-trips full private bindings without persisting owners or credentials as plaintext', () => {
    const { file, repository } = fixture(); expect(repository.load()).toEqual([]); repository.save([binding()]);
    const disk = fs.readFileSync(file, 'utf8');
    for (const secret of [binding().ownerUid, binding().deviceId, binding().clientId!, binding().bootstrapSecret, binding().deviceSecret, binding().bridgeSecret]) expect(disk).not.toContain(secret);
    expect(repository.load()).toEqual([binding()]); const changed = binding(); changed.pairedAt = 2000; repository.save([changed]); expect(repository.load()).toEqual([changed]);
    repository.save([]); expect(repository.load()).toEqual([]); expect(fs.readdirSync(path.dirname(file))).toEqual(['bindings.enc.json']);
  });
  it('rejects a different installation key or corrupted ciphertext and preserves the original file', () => {
    const { file, repository } = fixture(); repository.save([binding()]); const original = fs.readFileSync(file, 'utf8');
    expect(() => new EncryptedXiaozhiRepository({ filePath: file, secret: () => 'different-installation' }).load()).toThrow(/preserved/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original); const outer = JSON.parse(original); outer.ciphertext = (outer.ciphertext[0] === 'A' ? 'B' : 'A') + outer.ciphertext.slice(1); fs.writeFileSync(file, JSON.stringify(outer));
    const corrupted = fs.readFileSync(file, 'utf8'); expect(() => repository.load()).toThrow(/preserved/); expect(fs.readFileSync(file, 'utf8')).toBe(corrupted);
  });
  it('keeps the previous durable state when atomic replacement fails and removes only its temporary file', () => {
    const { file, repository } = fixture(); repository.save([binding()]); const original = fs.readFileSync(file, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('fixture rename failure'); });
    expect(() => repository.save([])).toThrow('fixture rename failure'); expect(fs.readFileSync(file, 'utf8')).toBe(original); expect(repository.load()).toEqual([binding()]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['bindings.enc.json']);
  });
  it('refuses malformed private records before replacing an existing encrypted store', () => {
    const { file, repository } = fixture(); repository.save([binding()]); const original = fs.readFileSync(file, 'utf8');
    expect(() => repository.save([{ ...binding(), ownerUid: '' }])).toThrow(/Invalid/); expect(() => repository.save([binding(), binding()])).toThrow(/Invalid/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
