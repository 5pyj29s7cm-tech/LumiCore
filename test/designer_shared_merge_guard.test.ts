import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  assertLegacyDesignerDataMerged, designerDataMergeReceiptPath,
  legalDataMergeReceiptPath, legacyLegalDataFingerprint, resolveMigratedDataFile,
} from '../server/config/data_path';

// Synthetic metadata and files only: these receipts do not assert real SQLite
// integrity, a real migration, or acceptance of any business operation.
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
let home: string;
const originalRoot = process.env.LUMI_DATA_DIR;
beforeEach(() => { home = fs.mkdtempSync(path.join(String(process.env.LUMI_TEST_TMPDIR || os.tmpdir()), 'designer-merge-guard-')); });
afterEach(() => {
  if (originalRoot === undefined) delete process.env.LUMI_DATA_DIR; else process.env.LUMI_DATA_DIR = originalRoot;
  if (path.dirname(home) !== path.resolve(String(process.env.LUMI_TEST_TMPDIR || os.tmpdir())) || !path.basename(home).startsWith('designer-merge-guard-')) throw Error('Unsafe synthetic cleanup');
  fs.rmSync(home, { recursive: true, force: true });
});

function fixture(sourceName = 'LumiCore-Designer', variant: 'designer' | 'legal' = 'designer') {
  const source = path.join(home, sourceName), target = path.join(home, 'LumiCore');
  const relative = `knowledge/${variant}-${sourceName}.txt`, body = `Original ${variant} fixture body`;
  write(path.join(source, 'data', relative), body);
  write(path.join(target, 'data', relative), body);
  write(path.join(target, 'data/lumi.db'), 'SYNTHETIC DATABASE MARKER');
  const manifestPath = path.join(home, 'private-backups', sourceName, 'maintenance-manifest.json');
  const manifest = { version: 1, phase: 'prepared', sourceVariant: variant, sourceRoot: source, targetRoot: target,
    inputDigest: 'a'.repeat(64), migratedFiles: [{ path: relative, sha256: hash(body) }] };
  const manifestRaw = JSON.stringify(manifest);
  write(manifestPath, manifestRaw);
  const receiptPath = variant === 'designer' ? designerDataMergeReceiptPath(source, target) : legalDataMergeReceiptPath(source, target);
  const receipt = { version: 1, phase: 'completed', sourceVariant: variant, sourceRoot: source, targetRoot: target,
    sourceFingerprint: legacyLegalDataFingerprint(source), inputDigest: manifest.inputDigest,
    maintenanceManifest: manifestPath, maintenanceManifestSha256: hash(manifestRaw) };
  write(receiptPath, JSON.stringify(receipt));
  return { source, target, relative, body, manifest, manifestPath, receipt, receiptPath };
}

it.each(['LumiCore-Designer', 'LumiOS-Designer'])('blocks shared startup when %s contains unreviewed history without changing it', name => {
  const source = path.join(home, name), file = path.join(source, 'data/history.txt'); write(file, 'History remains here');
  expect(() => assertLegacyDesignerDataMerged(home)).toThrow(/explicit reviewed merge/);
  expect(fs.readFileSync(file, 'utf8')).toBe('History remains here');
  expect(fs.existsSync(path.join(home, 'LumiCore'))).toBe(false);
});

it('allows empty legacy folders without creating a target database', () => {
  fs.mkdirSync(path.join(home, 'LumiCore-Designer/data'), { recursive: true });
  expect(() => assertLegacyDesignerDataMerged(home)).not.toThrow();
  expect(fs.existsSync(path.join(home, 'LumiCore'))).toBe(false);
});

it('accepts both old Designer namespaces only with their own bound manifests and fingerprints', () => {
  const first = fixture(), second = fixture('LumiOS-Designer');
  expect(() => assertLegacyDesignerDataMerged(home, first.target)).not.toThrow();
  for (const f of [first, second]) expect(resolveMigratedDataFile(path.join(f.source, 'data', f.relative), f.target)).toBe(path.join(f.target, 'data', f.relative));
});

it.each(['manifest-bytes', 'receipt-variant', 'manifest-variant', 'source-root', 'target-root', 'input-digest', 'source-changed', 'target-db-missing'] as const)('refuses inconsistent Designer receipt/manifest: %s', kind => {
  const f = fixture();
  if (kind === 'manifest-bytes') write(f.manifestPath, JSON.stringify({ ...f.manifest, extra: 'changed' }));
  if (kind === 'receipt-variant') f.receipt.sourceVariant = 'legal';
  if (kind === 'manifest-variant') { const raw = JSON.stringify({ ...f.manifest, sourceVariant: 'legal' }); write(f.manifestPath, raw); f.receipt.maintenanceManifestSha256 = hash(raw); }
  if (kind === 'source-root') f.receipt.sourceRoot = path.join(home, 'unrelated-source');
  if (kind === 'target-root') f.receipt.targetRoot = path.join(home, 'unrelated-target');
  if (kind === 'input-digest') f.receipt.inputDigest = 'b'.repeat(64);
  if (kind === 'source-changed') write(path.join(f.source, 'data/new-after-merge.txt'), 'New source history');
  if (kind === 'target-db-missing') fs.unlinkSync(path.join(f.target, 'data/lumi.db'));
  write(f.receiptPath, JSON.stringify(f.receipt));
  expect(() => assertLegacyDesignerDataMerged(home, f.target)).toThrow();
});

it('preserves verified Legal remapping alongside Designer remapping', () => {
  const designer = fixture(), legal = fixture('LumiCore-Legal', 'legal');
  for (const f of [designer, legal]) expect(resolveMigratedDataFile(path.join(f.source, 'data', f.relative), f.target)).toBe(path.join(f.target, 'data', f.relative));
  const unrelated = path.join(home, 'independent.txt'); write(unrelated, 'Unrelated');
  expect(resolveMigratedDataFile(unrelated, designer.target)).toBe(unrelated);
});

it('does not allow a receipt in the Legal namespace to satisfy the Designer startup guard', () => {
  const f = fixture();
  fs.renameSync(f.receiptPath, (() => { const file = legalDataMergeReceiptPath(f.source, f.target); fs.mkdirSync(path.dirname(file), { recursive: true }); return file; })());
  expect(() => assertLegacyDesignerDataMerged(home, f.target)).toThrow(/explicit reviewed merge/);
});

it('refuses old Designer file reads without a reviewed remap even when the source file exists', () => {
  const f = fixture(); fs.unlinkSync(f.receiptPath);
  expect(() => resolveMigratedDataFile(path.join(f.source, 'data', f.relative), f.target)).toThrow(/explicit reviewed merge/);
});

it.each(['changed-target', 'unlisted-file', 'target-link'] as const)('refuses a file that does not match the exact reviewed destination: %s', kind => {
  const f = fixture(); let relative = f.relative;
  if (kind === 'changed-target') write(path.join(f.target, 'data', relative), 'Changed target bytes');
  if (kind === 'unlisted-file') { relative = 'unlisted.txt'; write(path.join(f.target, 'data', relative), 'Not in manifest'); }
  if (kind === 'target-link') {
    const original = path.join(f.target, 'data/knowledge'), moved = path.join(home, 'outside-files');
    fs.renameSync(original, moved); fs.symlinkSync(moved, original, 'junction');
  }
  expect(() => resolveMigratedDataFile(path.join(f.source, 'data', relative), f.target)).toThrow();
});

it('retains direct file access for an explicitly selected old Designer root without requiring shared migration', () => {
  const f = fixture(); process.env.LUMI_DATA_DIR = ` ${f.source} `; fs.unlinkSync(f.receiptPath);
  expect(resolveMigratedDataFile(path.join(f.source, 'data', f.relative), f.source)).toBe(path.join(f.source, 'data', f.relative));
  expect(() => assertLegacyDesignerDataMerged(home, f.source)).not.toThrow();
});
