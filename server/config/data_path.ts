// Centralized data directory resolver.
// All persisted files (DB, keys, config, voice samples, KB) live here.
// Default: ~/LumiCore/data/ — survives code/upgrade overwrites.
// Existing ~/LumiOS data is moved in place under an exclusive backend lease
// before SQLite is opened on first LumiCore startup.
// Override: set LUMI_DATA_DIR env var.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ensurePrivateRuntimeDirectory, restrictOwnerAccess } from './runtime_file_security';

const ENV_KEY = 'LUMI_DATA_DIR';
const TEST_ROOT_ENV_KEY = 'LUMI_TEST_TMPDIR';
const PRODUCT_DATA_DIRECTORY = 'LumiCore';
const LEGACY_PRODUCT_DATA_DIRECTORY = 'LumiOS';

let cachedTestDataRoot: string | null = null;

function testDataRoot(): string {
  if (cachedTestDataRoot) return cachedTestDataRoot;

  const tempBase = process.env[TEST_ROOT_ENV_KEY] || os.tmpdir();
  const root = path.join(tempBase, 'lumi-core-tests', String(process.pid));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // db_layer performs a one-time legacy migration when this marker is absent.
  // Test workers must start empty instead of copying a developer's real data.
  const migrationMarker = path.join(dataDir, '.migration_skip');
  if (!fs.existsSync(migrationMarker)) fs.writeFileSync(migrationMarker, '');

  cachedTestDataRoot = root;
  return root;
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function pathExistsOrThrow(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

function readDirectoryState(directory: string): 'missing' | 'empty' | 'populated' {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (isMissingError(error)) return 'missing';
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`LumiCore data path is not a safe directory: ${directory}`);
  }
  return fs.readdirSync(directory).length === 0 ? 'empty' : 'populated';
}

/** Resolve the product's current default without mutating either data root. */
export function resolveDefaultDataRoot(homeDirectory = os.homedir()): string {
  return path.resolve(homeDirectory, PRODUCT_DATA_DIRECTORY);
}

export interface LegacyDataRootMigrationClaim {
  releaseAt(dataRoot: string): boolean;
}

export type ClaimLegacyDataRoot = (legacyRoot: string, currentRoot: string) => LegacyDataRootMigrationClaim;

interface ProductDataMigrationReceipt {
  version: 1;
  product: 'LumiCore';
  migrationId: string;
  phase: 'prepared';
  method: 'atomic_directory_rename';
  migratedFrom: string;
  migratedTo: string;
  sourceRootDigest: string;
  targetRootDigest: string;
  preparedAt: string;
}

interface ProductDataMigrationVerificationReceipt {
  version: 1;
  product: 'LumiCore';
  migrationReceipt: 'product-data-migration.json';
  migrationId: string;
  migrationReceiptSha256: string;
  quickCheck: 'ok';
  databaseBytes: number;
  userCount: number;
  conversationCount: number;
  interactionCount: number;
  verifiedAt: string;
}

function normalizeRoot(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function digestRoot(value: string): string {
  return crypto.createHash('sha256').update(normalizeRoot(value), 'utf8').digest('hex');
}

function safeFileContents(filename: string, kind: string, maximumBytes = 16 * 1024): string {
  const before = fs.lstatSync(filename);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size <= 0
    || before.size > maximumBytes
    || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
  ) throw new Error(`${kind} is not a safe regular file.`);

  const descriptor = fs.openSync(filename, 'r');
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size !== before.size
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) throw new Error(`${kind} changed while it was being verified.`);
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch {
    // Windows does not support opening a directory handle through fs.openSync.
  }
}

function publishJsonExclusive(targetPath: string, value: unknown, kind: string): void {
  const runtimeDir = ensurePrivateRuntimeDirectory(path.dirname(targetPath));
  const temporaryPath = path.join(
    runtimeDir,
    `.product-data-migration-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    restrictOwnerAccess(temporaryPath);
    try {
      // Hard-link publication is atomic and never overwrites an existing
      // receipt. It is intentionally the same local-filesystem requirement as
      // the backend data-root lease.
      fs.linkSync(temporaryPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new Error(`${kind} already exists and must be verified before reuse.`);
      }
      throw error;
    }
    fsyncDirectoryBestEffort(runtimeDir);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function validateMigrationReceipt(
  value: unknown,
  legacyRoot: string,
  currentRoot: string,
): ProductDataMigrationReceipt {
  const receipt = value as Partial<ProductDataMigrationReceipt> | null;
  if (
    !receipt
    || receipt.version !== 1
    || receipt.product !== 'LumiCore'
    || !/^[A-Za-z0-9_-]{32,128}$/.test(String(receipt.migrationId || ''))
    || receipt.phase !== 'prepared'
    || receipt.method !== 'atomic_directory_rename'
    || normalizeRoot(String(receipt.migratedFrom || '')) !== normalizeRoot(legacyRoot)
    || normalizeRoot(String(receipt.migratedTo || '')) !== normalizeRoot(currentRoot)
    || receipt.sourceRootDigest !== digestRoot(legacyRoot)
    || receipt.targetRootDigest !== digestRoot(currentRoot)
    || typeof receipt.preparedAt !== 'string'
    || receipt.preparedAt.length > 64
    || !Number.isFinite(Date.parse(receipt.preparedAt))
  ) throw new Error('LumiCore product data migration receipt does not match the expected atomic rename.');
  return receipt as ProductDataMigrationReceipt;
}

function readMigrationReceipt(receiptRoot: string, legacyRoot: string, currentRoot: string): {
  receipt: ProductDataMigrationReceipt;
  digest: string;
} {
  const receiptPath = path.join(receiptRoot, 'runtime', 'product-data-migration.json');
  const serialized = safeFileContents(receiptPath, 'LumiCore product data migration receipt');
  const receipt = validateMigrationReceipt(JSON.parse(serialized) as unknown, legacyRoot, currentRoot);
  return {
    receipt,
    digest: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function validateMigrationVerificationReceipt(
  value: unknown,
  migration: { receipt: ProductDataMigrationReceipt; digest: string },
): ProductDataMigrationVerificationReceipt {
  const existing = value as Partial<ProductDataMigrationVerificationReceipt> | null;
  if (
    !existing
    || existing.version !== 1
    || existing.product !== 'LumiCore'
    || existing.migrationReceipt !== 'product-data-migration.json'
    || existing.migrationId !== migration.receipt.migrationId
    || existing.migrationReceiptSha256 !== migration.digest
    || existing.quickCheck !== 'ok'
    || !Number.isSafeInteger(existing.databaseBytes)
    || Number(existing.databaseBytes) <= 0
    || !Number.isSafeInteger(existing.userCount)
    || Number(existing.userCount) < 0
    || !Number.isSafeInteger(existing.conversationCount)
    || Number(existing.conversationCount) < 0
    || !Number.isSafeInteger(existing.interactionCount)
    || Number(existing.interactionCount) < 0
    || typeof existing.verifiedAt !== 'string'
    || existing.verifiedAt.length > 64
    || !Number.isFinite(Date.parse(existing.verifiedAt))
  ) throw new Error('Existing LumiCore product data migration verification receipt is invalid.');
  return existing as ProductDataMigrationVerificationReceipt;
}

/** Validate immutable migration receipts before SQLite can be opened or changed. */
export function preflightProductDataMigrationReceipts(dataRoot = getDataRoot()): boolean {
  const currentRoot = path.resolve(dataRoot);
  const migrationReceiptPath = path.join(currentRoot, 'runtime', 'product-data-migration.json');
  if (!pathExistsOrThrow(migrationReceiptPath)) return false;
  const legacyRoot = path.join(path.dirname(currentRoot), LEGACY_PRODUCT_DATA_DIRECTORY);
  const migration = readMigrationReceipt(currentRoot, legacyRoot, currentRoot);
  const verificationPath = path.join(currentRoot, 'runtime', 'product-data-migration-verified.json');
  if (pathExistsOrThrow(verificationPath)) {
    validateMigrationVerificationReceipt(
      JSON.parse(safeFileContents(
        verificationPath,
        'LumiCore product data migration verification receipt',
      )) as unknown,
      migration,
    );
  }
  return true;
}

function ensurePreparedMigrationReceipt(legacyRoot: string, currentRoot: string): ProductDataMigrationReceipt {
  const receiptPath = path.join(legacyRoot, 'runtime', 'product-data-migration.json');
  try {
    return readMigrationReceipt(legacyRoot, legacyRoot, currentRoot).receipt;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  const receipt: ProductDataMigrationReceipt = {
    version: 1,
    product: 'LumiCore',
    migrationId: crypto.randomBytes(32).toString('base64url'),
    phase: 'prepared',
    method: 'atomic_directory_rename',
    migratedFrom: legacyRoot,
    migratedTo: currentRoot,
    sourceRootDigest: digestRoot(legacyRoot),
    targetRootDigest: digestRoot(currentRoot),
    preparedAt: new Date().toISOString(),
  };
  publishJsonExclusive(receiptPath, receipt, 'LumiCore product data migration receipt');
  return receipt;
}

/**
 * Perform the one-time product rename under a live lease on the legacy root.
 * The caller must use the same lease protocol as the backend, which closes the
 * race with an older LumiOS process. No files are copied and non-empty roots
 * are never merged.
 */
export function migrateLegacyProductDataRoot(
  claimLegacyRoot: ClaimLegacyDataRoot,
  homeDirectory = os.homedir(),
): string {
  const currentRoot = resolveDefaultDataRoot(homeDirectory);
  const legacyRoot = path.resolve(homeDirectory, LEGACY_PRODUCT_DATA_DIRECTORY);
  const currentState = readDirectoryState(currentRoot);
  const legacyState = readDirectoryState(legacyRoot);

  if (legacyState === 'missing') return currentRoot;
  if (legacyState === 'empty' && currentState !== 'missing') {
    fs.rmdirSync(legacyRoot);
    return currentRoot;
  }
  if (currentState === 'populated') {
    throw new Error(
      `LumiCore data migration stopped because both directories contain data: ${currentRoot} and ${legacyRoot}`,
    );
  }

  const claim = claimLegacyRoot(legacyRoot, currentRoot);
  let claimRoot = legacyRoot;
  let operationError: unknown;
  try {
    // Re-check after acquiring the lease; another new process may have won the
    // migration before this process acquired ownership.
    const latestLegacyState = readDirectoryState(legacyRoot);
    const latestCurrentState = readDirectoryState(currentRoot);
    if (latestLegacyState === 'missing') return currentRoot;
    if (latestCurrentState === 'populated') {
      throw new Error(
        `LumiCore data migration stopped because both directories contain data: ${currentRoot} and ${legacyRoot}`,
      );
    }
    if (latestCurrentState === 'empty') {
      fs.rmdirSync(currentRoot);
    }
    // Publish the immutable, resumable receipt while the migration lease still
    // lives at the source. The receipt then moves atomically with the root, so
    // a crash immediately after rename cannot lose the fact of migration.
    ensurePreparedMigrationReceipt(legacyRoot, currentRoot);
    try {
      fs.renameSync(legacyRoot, currentRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EXDEV') {
        throw new Error('LumiCore product data migration requires an atomic same-volume directory rename.');
      }
      throw error;
    }
    claimRoot = currentRoot;
    fsyncDirectoryBestEffort(path.dirname(currentRoot));
    return currentRoot;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const released = claim.releaseAt(claimRoot);
    if (!released && operationError === undefined) {
      throw new Error('LumiCore data migration could not release its exclusive legacy-root lease');
    }
  }
}

export function markLegacyProductDataMigrationVerified(details: {
  quickCheck: 'ok';
  userCount: number;
  conversationCount: number;
  interactionCount: number;
}, dataRoot = getDataRoot()): boolean {
  const currentRoot = path.resolve(dataRoot);
  const runtimeDir = path.join(currentRoot, 'runtime');
  const migrationReceiptPath = path.join(runtimeDir, 'product-data-migration.json');
  if (!pathExistsOrThrow(migrationReceiptPath)) return false;
  if (details.quickCheck !== 'ok') throw new Error('LumiCore migration verification requires SQLite quick_check=ok.');
  for (const count of [details.userCount, details.conversationCount, details.interactionCount]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('LumiCore migration verification counts must be non-negative integers.');
    }
  }
  const legacyRoot = path.join(path.dirname(currentRoot), LEGACY_PRODUCT_DATA_DIRECTORY);
  const migration = readMigrationReceipt(currentRoot, legacyRoot, currentRoot);

  const databasePath = path.join(currentRoot, 'data', 'lumi.db');
  assertSafeSqliteDataPath(databasePath, currentRoot);
  const databaseMetadata = fs.lstatSync(databasePath);
  const verificationPath = path.join(runtimeDir, 'product-data-migration-verified.json');
  const verification = {
    version: 1,
    product: 'LumiCore',
    migrationReceipt: 'product-data-migration.json',
    migrationId: migration.receipt.migrationId,
    migrationReceiptSha256: migration.digest,
    quickCheck: 'ok',
    databaseBytes: databaseMetadata.size,
    userCount: details.userCount,
    conversationCount: details.conversationCount,
    interactionCount: details.interactionCount,
    verifiedAt: new Date().toISOString(),
  };

  const validateExistingVerification = (): void => {
    validateMigrationVerificationReceipt(
      JSON.parse(safeFileContents(
        verificationPath,
        'LumiCore product data migration verification receipt',
      )) as unknown,
      migration,
    );
  };

  if (pathExistsOrThrow(verificationPath)) {
    validateExistingVerification();
    return false;
  }
  try {
    publishJsonExclusive(
      verificationPath,
      verification,
      'LumiCore product data migration verification receipt',
    );
    return true;
  } catch (error) {
    if (!pathExistsOrThrow(verificationPath)) throw error;
    validateExistingVerification();
    return false;
  }
}

function configuredDataRoot(): string | null {
  const configured = process.env[ENV_KEY]?.trim() || '';
  if (!configured) return null;
  if (!path.isAbsolute(configured)) {
    throw new Error('LUMI_DATA_DIR must be an absolute path so native and Node runtimes share one data root.');
  }
  return path.normalize(configured);
}

export function hasExplicitDataRoot(): boolean {
  return configuredDataRoot() !== null;
}

function defaultDataRoot(): string {
  if (process.env.NODE_ENV === 'test') return testDataRoot();
  return resolveDefaultDataRoot();
}

export function getDataRoot(): string {
  return configuredDataRoot() || defaultDataRoot();
}

export function assertSafeSqliteDataPath(databasePath: string, dataRoot = getDataRoot()): void {
  const resolvedRoot = path.resolve(dataRoot);
  const resolvedDatabase = path.resolve(databasePath);
  const expectedDataDirectory = path.join(resolvedRoot, 'data');
  if (path.dirname(resolvedDatabase) !== expectedDataDirectory) {
    throw new Error('SQLite database path escaped the Lumi data directory.');
  }
  const rootMetadata = fs.lstatSync(resolvedRoot);
  const dataMetadata = fs.lstatSync(expectedDataDirectory);
  if (
    !rootMetadata.isDirectory()
    || rootMetadata.isSymbolicLink()
    || !dataMetadata.isDirectory()
    || dataMetadata.isSymbolicLink()
  ) throw new Error('Lumi SQLite data root must not use a symbolic link or junction.');

  for (const candidate of [resolvedDatabase, `${resolvedDatabase}-wal`, `${resolvedDatabase}-shm`, `${resolvedDatabase}-journal`]) {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(candidate);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Lumi SQLite files must be real regular files.');
    }
  }
}

export function getDataPath(relativePath: string): string {
  const full = path.join(getDataRoot(), 'data', relativePath);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return full;
}

export function getDataDirectory(relativePath: string): string {
  const full = path.join(getDataRoot(), 'data', relativePath);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  return full;
}

export function getGeneratedOutputDir(): string {
  return getDataDirectory('generated');
}
