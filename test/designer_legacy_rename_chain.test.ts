import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { designerDataMergeReceiptPath, legacyLegalDataFingerprint, resolveMigratedDataFile } from '../server/config/data_path';
import { normalizePathIdentity } from '../shared/file_identity';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const rootHash = (root: string) => hash(normalizePathIdentity(path.resolve(root)));
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(String(process.env.LUMI_TEST_TMPDIR || os.tmpdir()), 'rename-chain-')); });
afterEach(() => {
  if (path.dirname(home) !== path.resolve(String(process.env.LUMI_TEST_TMPDIR || os.tmpdir())) || !path.basename(home).startsWith('rename-chain-')) throw Error('Unsafe fixture cleanup');
  fs.rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const old = path.join(home, 'LumiOS-Designer'), source = path.join(home, 'LumiCore-Designer'), target = path.join(home, 'LumiCore');
  const relative = 'generated/synthetic-cad.dxf', oldFile = path.join(old, 'data', relative), sourceFile = path.join(source, 'data', relative), targetFile = path.join(target, 'data', relative);
  for (const f of [sourceFile, targetFile]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'SYNTHETIC CAD'); }
  const preparedPath = path.join(source, 'runtime/product-data-migration.json'), verifiedPath = path.join(source, 'runtime/product-data-migration-verified.json');
  const prepared = { version: 1, product: 'Lumi Designer', migrationId: 'r'.repeat(40), phase: 'prepared', method: 'atomic_directory_rename', migratedFrom: old, migratedTo: source, sourceRootDigest: rootHash(old), targetRootDigest: rootHash(source), preparedAt: '2026-10-30T00:00:00.000Z' };
  const verified = { version: 1, product: 'Lumi Designer', migrationReceipt: 'product-data-migration.json', migrationId: prepared.migrationId, migrationReceiptSha256: '', quickCheck: 'ok', databaseBytes: 4096, userCount: 1, conversationCount: 1, interactionCount: 2, verifiedAt: '2026-10-30T00:01:00.000Z' };
  const rewritePair = () => { write(preparedPath, prepared); verified.migrationReceiptSha256 = hash(fs.readFileSync(preparedPath, 'utf8')); write(verifiedPath, verified); };
  rewritePair();
  const manifestPath = path.join(home, 'private-backup/maintenance-manifest.json');
  const manifest = { version: 1, sourceVariant: 'designer', sourceRoot: source, targetRoot: target, inputDigest: 'a'.repeat(64), migratedFiles: [{ path: relative, sha256: hash('SYNTHETIC CAD') }] };
  write(manifestPath, manifest);
  const receiptPath = designerDataMergeReceiptPath(source, target);
  const receipt = { version: 1, phase: 'completed', sourceVariant: 'designer', sourceRoot: source, targetRoot: target, inputDigest: manifest.inputDigest, sourceFingerprint: legacyLegalDataFingerprint(source), maintenanceManifest: manifestPath, maintenanceManifestSha256: hash(fs.readFileSync(manifestPath, 'utf8')) };
  write(receiptPath, receipt);
  return { old, source, target, oldFile, sourceFile, targetFile, prepared, verified, preparedPath, verifiedPath, rewritePair, manifestPath, receiptPath, receipt };
}

it('resolves only the verified rename plus completed reviewed merge after the old path disappeared', () => {
  const f = fixture(); expect(fs.existsSync(f.oldFile)).toBe(false);
  expect(resolveMigratedDataFile(f.oldFile, f.target)).toBe(f.targetFile);
  expect(resolveMigratedDataFile(f.sourceFile, f.target)).toBe(f.targetFile);
});

it.each(['prepared-bytes', 'verified-id', 'wrong-product', 'wrong-from', 'wrong-to', 'wrong-method', 'missing-prepared', 'missing-verified', 'missing-intermediate-root', 'recreated-old-root', 'linked-runtime', 'merge-manifest', 'merge-phase', 'changed-source', 'changed-target'] as const)('rejects a broken migration chain: %s', kind => {
  const f = fixture();
  if (kind === 'prepared-bytes') fs.appendFileSync(f.preparedPath, ' ');
  if (kind === 'verified-id') { f.verified.migrationId = 's'.repeat(40); write(f.verifiedPath, f.verified); }
  if (kind === 'wrong-product') { f.prepared.product = f.verified.product = 'LumiCore'; f.rewritePair(); }
  if (kind === 'wrong-from') { f.prepared.migratedFrom = path.join(home, 'unrelated'); f.prepared.sourceRootDigest = rootHash(f.prepared.migratedFrom); f.rewritePair(); }
  if (kind === 'wrong-to') { f.prepared.migratedTo = path.join(home, 'unrelated'); f.prepared.targetRootDigest = rootHash(f.prepared.migratedTo); f.rewritePair(); }
  if (kind === 'wrong-method') { f.prepared.method = 'copy'; f.rewritePair(); }
  if (kind === 'missing-prepared') fs.unlinkSync(f.preparedPath);
  if (kind === 'missing-verified') fs.unlinkSync(f.verifiedPath);
  if (kind === 'missing-intermediate-root') fs.renameSync(f.source, path.join(home, 'offline-designer-backup'));
  if (kind === 'recreated-old-root') fs.mkdirSync(f.old);
  if (kind === 'linked-runtime') { const dir = path.join(f.source, 'runtime'), other = path.join(home, 'redirected-runtime'); fs.renameSync(dir, other); fs.symlinkSync(other, dir, 'junction'); }
  if (kind === 'merge-manifest') fs.appendFileSync(f.manifestPath, ' ');
  if (kind === 'merge-phase') { f.receipt.phase = 'prepared'; write(f.receiptPath, f.receipt); }
  if (kind === 'changed-source') fs.appendFileSync(f.sourceFile, ' changed');
  if (kind === 'changed-target') fs.appendFileSync(f.targetFile, ' changed');
  expect(() => resolveMigratedDataFile(f.oldFile, f.target)).toThrow();
});

it('does not treat a similarly named directory as a Designer migration alias', () => {
  const f = fixture(), other = path.join(home, 'LumiOS-Designer-copy/data/generated/synthetic-cad.dxf');
  expect(resolveMigratedDataFile(other, f.target)).toBe(other);
});
