import { createSqliteCommitJournal } from './server/db/sqlite_commit_journal';
import { createSqliteOperations } from './server/db/sqlite_operations';
import sqlite3 from 'sqlite3';
import { createTableSession, prepareTableCommit, isTableSession } from './server/db/table_session';
import { DATABASE_TABLES, type DatabaseTableName } from './server/db/table_catalog';
import { migrateSchema } from './server/db/migrations';
import { DatabaseSnapshots, databaseTarget } from './server/db/snapshot_changes';
import { createTables, migrateRetiredLocalAgentTables, prepareDatabaseRuntime } from './server/db/startup';
import { hydrateDatabaseProjection } from './server/db/hydrate';
import { buildPersistenceTableSpecs, type PersistenceTableSpec } from './server/db/persistence_projection';
import type { LegacySummaryPersistenceRepair, LegacySummaryRepairWriter } from './server/db/persistence_codecs';
import type { DatabaseSqlWriteSession } from './server/db/sql_session';
export type { LegacySummaryPersistenceRepair } from './server/db/persistence_codecs';
export type { DatabaseSqlWriteSession } from './server/db/sql_session';
import { configureExternalCommitJournal } from './server/tools/external_commit_journal';

let db: sqlite3.Database | null = null;
const { query, run, insertSnapshotRows } = createSqliteOperations(() => db!);
let startupQuickCheckPassed = false;

let memoryDB: any = null;

/**
 * Persistence is cleanup, not a prerequisite for safe conversation reads.
 * The in-memory row has already been isolated before this is called, so a
 * read-only/closing database must never reject or delay initialization.
 * Exported for a focused failure-boundary regression test.
 */
export function persistLegacySummaryRepairsBestEffort(
  repairs: LegacySummaryPersistenceRepair[],
  injectedWriter?: LegacySummaryRepairWriter,
): void {
  if (!repairs.length) return;
  const targetDb = db;
  let warned = false;
  const reportFailure = (error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn('[DB] Legacy guard-summary cleanup could not be persisted; in-memory isolation remains active:', error);
  };
  const writer: LegacySummaryRepairWriter = injectedWriter || ((repair, complete) => {
    if (!targetDb) {
      complete(new Error('Database is unavailable.'));
      return;
    }
    targetDb.run(
      `UPDATE conversations
       SET summary = ?, summaryChain = ?, lastSummaryMessageCount = ?
       WHERE id = ? AND lastSummaryMessageCount < 0`,
      [
        repair.summary,
        JSON.stringify(repair.summaryChain),
        repair.lastSummaryMessageCount,
        repair.id,
      ],
      complete,
    );
  });

  for (const repair of repairs) {
    try {
      writer(repair, error => {
        if (error) reportFailure(error);
      });
    } catch (error) {
      reportFailure(error);
    }
  }
}

let initPromise: Promise<void> | null = null;

async function requireSqliteQuickCheck(phase: 'before' | 'after'): Promise<void> {
  const integrityRows = await query<Record<string, unknown>>('PRAGMA quick_check');
  const integrityValues = integrityRows.flatMap(row => Object.values(row));
  if (integrityValues.length !== 1 || String(integrityValues[0]).toLowerCase() !== 'ok') {
    throw new Error(`SQLite quick_check rejected the LumiCore data store ${phase} startup schema writes.`);
  }
}

export function initDatabase(): Promise<void> {
  if (db && memoryDB) return Promise.resolve();
  if (initPromise) return initPromise;
  const dbPath = prepareDatabaseRuntime();
  const pending = new Promise<void>((resolve, reject) => {
    const rejectAndClose = (error: unknown) => {
      startupQuickCheckPassed = false;
      memoryDB = null;
      const failedDatabase = db;
      db = null;
      if (!failedDatabase) {
        reject(error);
        return;
      }
      failedDatabase.close(() => reject(error));
    };
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) { rejectAndClose(err); return; }
      // Runtime services and parallel diagnostics can briefly overlap on the
      // same local database. Wait for the active writer instead of surfacing a
      // transient SQLITE_BUSY failure to the client or test harness.
      db!.configure('busyTimeout', 5000);
      db!.run('PRAGMA foreign_keys = ON', async (err) => {
        if (err) { rejectAndClose(err); return; }
        try {
          await requireSqliteQuickCheck('before');
          await createTables(db!, { query, run });
          await migrateSchema(db!);
          await migrateRetiredLocalAgentTables({ query, run });
          await requireSqliteQuickCheck('after');
          const restored = await hydrateDatabaseProjection(query);
          memoryDB = restored.data;
          seedPersistenceTableDigests();
          configureSqliteExternalCommitJournal();
          persistLegacySummaryRepairsBestEffort(restored.legacySummaryRepairs);
          startupQuickCheckPassed = true;
          resolve();
        } catch (error) {
          // sqlite callbacks do not observe rejected async callback promises.
          // Always settle the outer initialization promise instead of leaving
          // callers hanging until their own timeout with an unhandled rejection.
          rejectAndClose(error);
        }
      });
    });
  });
  initPromise = pending.catch(error => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/** Select named tables only; the result is detached and writes must be committed explicitly. */
export function readDatabaseTables<T extends DatabaseTableName>(tables: readonly T[]): Record<T, any> {
  if (!memoryDB) throw new Error('Database not initialized. Call initDatabase() first.');
  if (tables.some(table => !DATABASE_TABLES.includes(table))) throw new Error('Unknown database table');
  return createTableSession(memoryDB, tables);
}

/** Accept table deltas atomically without adopting a caller-owned full database root. */
export function commitDatabaseTables(data: unknown): void {
  if (databaseClosing) throw new Error('Database is closing; new writes are not accepted.');
  if (!db || !memoryDB) throw new Error('Database not initialized.');
  const staged = prepareTableCommit(data, databaseSnapshots!.view);
  if (!Object.keys(staged.changes).length) return;
  for (const [key, value] of Object.entries(staged.changes)) databaseSnapshots!.view[key] = value;
  staged.accept();
  recordDatabaseDirty();
  writeRevision += 1;
  scheduleDatabaseFlush();
}

export function readDB(): any {
  if (!memoryDB) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return databaseSnapshots!.view;
}

export function requireDatabaseStartupQuickCheck(): 'ok' {
  if (!startupQuickCheckPassed || !memoryDB) {
    throw new Error('SQLite startup integrity verification is not available.');
  }
  return 'ok';
}

// Prune high-volume telemetry from memory + SQLite to prevent unbounded
// growth. Durable memories are deliberately excluded: count-based deletion
// would silently erase knowledge and identity without considering tier,
// importance, consolidation state, or user retention policy.
export function pruneOldData(): void {
  if (!memoryDB || !db) return;
  const limits: Record<string, number> = { interactions: 20000, tokenUsage: 5000 };
  const tableMap: Record<string, string> = { interactions: 'interactions', tokenUsage: 'token_usage' };
  for (const [key, max] of Object.entries(limits)) {
    const arr = readDB()[key];
    if (arr && arr.length > max) {
      const excess = arr.length - max;
      const removed = arr.splice(0, excess); // trim oldest entries
      try {
        for (const entry of removed) {
          const id = entry.id || entry.uid || entry.interactionId;
          if (id) db!.run(`DELETE FROM ${tableMap[key]} WHERE id = ?`, [id]);
        }
      } catch { /* best-effort, memory is already trimmed */ }
      console.log(`[DB] Pruned ${excess} old ${key} (${max} kept)`);
    }
  }
  recordDatabaseDirty();
}

// Write lock to prevent concurrent SQLite transactions
let writeLock: Promise<void> = Promise.resolve();
let databaseClosing = false;
let databaseClosePromise: Promise<void> | null = null;

function withDatabaseWriteLock<T>(operation: () => Promise<T>, duringClose = false): Promise<T> {
  if (databaseClosing && !duringClose) {
    return Promise.reject(new Error('Database is closing; new writes are not accepted.'));
  }
  const scheduled = writeLock.catch((error) => {
    console.error('[DB] Previous write failed before durable journal operation:', error);
  }).then(operation);
  writeLock = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

/**
 * Serialize an auxiliary SQLite write sequence with the whole-database
 * snapshot transaction. Callers receive raw operations that are safe to use
 * inside this lock; using the public runSQL helper here would deadlock.
 */
export function withDatabaseSqlWriteLock<T>(
  operation: (session: DatabaseSqlWriteSession) => Promise<T>,
): Promise<T> {
  return withDatabaseWriteLock(() => operation({ query, run }));
}

let writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let writeRevision = 0;
let persistedRevision = 0;
let writeInFlight = false;
let dirtySinceMs = 0;
let lastSuccessfulFlushAt = '';
let lastPersistenceError = '';
let databaseSnapshots: DatabaseSnapshots | null = null;
const UPSERT_PERSISTENCE_TABLES = new Set(['interactions', 'memories', 'token_usage']);
let lastFlushTables: string[] = [];
let totalTableWrites = 0;
let totalSkippedTableWrites = 0;

function recordDatabaseDirty(): void {
  if (!dirtySinceMs) dirtySinceMs = Date.now();
  dbDirty = true;
}

function recordSuccessfulDatabaseFlush(): void {
  lastSuccessfulFlushAt = new Date().toISOString();
  lastPersistenceError = '';
  if (persistedRevision >= writeRevision) {
    dbDirty = false;
    dirtySinceMs = 0;
  }
}

function recordDatabaseFlushFailure(error: unknown): void {
  recordDatabaseDirty();
  lastPersistenceError = error instanceof Error ? error.message : String(error || 'Unknown persistence failure');
}

function scheduleDatabaseFlush(delayMs = 100): void {
  if (databaseClosing || writeDebounceTimer || writeInFlight) return;
  writeDebounceTimer = setTimeout(() => {
    writeDebounceTimer = null;
    if (writeInFlight || persistedRevision >= writeRevision) return;

    writeInFlight = true;
    const ready = writeLock.catch((err) => {
      console.error('[DB] Previous write failed:', err);
    });
    writeLock = ready
      .then(flushPendingDatabaseLocked)
      .catch((err) => {
        console.error('[DB] Failed to persist database:', err);
      })
      .finally(() => {
        writeInFlight = false;
        if (persistedRevision < writeRevision) scheduleDatabaseFlush(250);
      });
  }, delayMs);
}

function configureSqliteExternalCommitJournal(): void {
  configureExternalCommitJournal(createSqliteCommitJournal(withDatabaseSqlWriteLock));
}

export function writeDB(data: any): void {
  if (isTableSession(data)) { commitDatabaseTables(data); return; }
  if (databaseClosing) throw new Error('Database is closing; new writes are not accepted.');
  if (!db) {
    throw new Error('Database not initialized.');
  }
  databaseSnapshots!.adopt(data);
  memoryDB = databaseTarget(data);
  recordDatabaseDirty();
  writeRevision += 1;

  // Coalesce rapid message, memory and voice updates into the next durable
  // revision instead of queuing parallel SQLite writes.
  scheduleDatabaseFlush(100);
}

async function flushPendingDatabaseLocked(): Promise<void> {
  if (persistedRevision < writeRevision || dbDirty) {
    const targetRevision = writeRevision;
    writeInFlight = true;
    try {
      await persistMemoryDB();
      persistedRevision = Math.max(persistedRevision, targetRevision);
      recordSuccessfulDatabaseFlush();
    } catch (error) {
      recordDatabaseFlushFailure(error);
      throw error;
    }
  }
}

async function flushDatabaseStrict(): Promise<void> {
  if (writeDebounceTimer) {
    clearTimeout(writeDebounceTimer);
    writeDebounceTimer = null;
  }
  await withDatabaseWriteLock(flushPendingDatabaseLocked);
}

/**
 * Durability boundary for transactional registries. Propagates persistence
 * failures so the caller can restore its prior in-memory/runtime state.
 */
export async function flushDBOrThrow(): Promise<void> {
  if (databaseClosePromise) return databaseClosePromise;
  try {
    await flushDatabaseStrict();
  } finally {
    writeInFlight = false;
    if (persistedRevision < writeRevision) scheduleDatabaseFlush(100);
  }
}

/** Flush pending writes immediately — call before shutdown */
export async function flushDB(): Promise<void> {
  try {
    await flushDBOrThrow();
  } catch (err) {
    recordDatabaseFlushFailure(err);
    console.error('[DB] flushDB failed:', err);
    throw err;
  }
}

let dbDirty = false;

export function isDbDirty(): boolean {
  return dbDirty;
}

/**
 * A short dirty window is normal because writes are deliberately coalesced.
 * Health only degrades after a real persistence error or a sustained backlog.
 */
export function getDatabasePersistenceStatus(nowMs = Date.now()): {
  pending: boolean;
  writeInFlight: boolean;
  lagMs: number;
  degraded: boolean;
  lastSuccessfulFlushAt: string;
  lastError: string;
  lastFlushTables: string[];
  lastComparedRows: number;
  lastScannedRows: number;
  totalTableWrites: number;
  totalSkippedTableWrites: number;
} {
  const pending = dbDirty || persistedRevision < writeRevision;
  const lagMs = pending && dirtySinceMs ? Math.max(0, nowMs - dirtySinceMs) : 0;
  return {
    pending,
    writeInFlight,
    lagMs,
    degraded: Boolean(lastPersistenceError) || lagMs >= 30_000,
    lastSuccessfulFlushAt,
    lastError: lastPersistenceError,
    lastFlushTables: [...lastFlushTables],
    lastComparedRows: databaseSnapshots?.comparedRows || 0,
    lastScannedRows: databaseSnapshots?.scannedRows || 0,
    totalTableWrites,
    totalSkippedTableWrites,
  };
}

/** Flush pending work and release the SQLite handle (tests and graceful shutdown). */
export function closeDatabase(): Promise<void> {
  if (databaseClosePromise) return databaseClosePromise;
  if (!db) return Promise.resolve();
  // Seal writes synchronously. Previously admitted SQL operations finish under
  // the same lock before the final snapshot and SQLite close. On any failure
  // the live handle, snapshot and revisions stay available for a later retry.
  databaseClosing = true;
  if (writeDebounceTimer) {
    clearTimeout(writeDebounceTimer);
    writeDebounceTimer = null;
  }
  databaseClosePromise = withDatabaseWriteLock(async () => {
    await flushPendingDatabaseLocked();
    const closingDb = db;
    if (closingDb) {
      await new Promise<void>((resolve, reject) => {
        closingDb.close(err => err ? reject(err) : resolve());
      });
    }
    db = null;
    memoryDB = null;
    startupQuickCheckPassed = false;
    initPromise = null;
    writeRevision = 0;
    persistedRevision = 0;
    writeInFlight = false;
    dirtySinceMs = 0;
    lastSuccessfulFlushAt = '';
    lastPersistenceError = '';
    databaseSnapshots = null;
    lastFlushTables = [];
    totalTableWrites = 0;
    totalSkippedTableWrites = 0;
    dbDirty = false;
    configureExternalCommitJournal(null);

  }, true).catch(error => {
    recordDatabaseFlushFailure(error);
    throw error;
  }).finally(() => {
    databaseClosing = false;
    databaseClosePromise = null;
    writeInFlight = false;
    if (db && persistedRevision < writeRevision) scheduleDatabaseFlush(100);
  });
  return databaseClosePromise;
}

function seedPersistenceTableDigests(): void {
  databaseSnapshots = new DatabaseSnapshots(memoryDB, buildPersistenceTableSpecs(() => memoryDB));
}

/** Capture only changed/externally aliased rows; publish changes after the shared COMMIT. */
async function persistMemoryDB(): Promise<void> {
  const snapshot = databaseSnapshots!.capture();
  const changed = snapshot.tables;
  totalSkippedTableWrites += snapshot.total - changed.length;
  if (changed.length === 0) {
    snapshot.commit(); lastFlushTables = []; return;
  }

  try {
    await run('BEGIN IMMEDIATE TRANSACTION');
    // Preserve schema, indexes and constraints; all data changes commit together.
    for (const { spec: projection, rows, deletions } of changed) {
      const spec = projection as PersistenceTableSpec;
      if (deletions) {
        const columns = spec.insertSQL.match(/\(([^)]+)\)\s+VALUES/i)![1].split(',').map(column => column.trim());
        const upsert = UPSERT_PERSISTENCE_TABLES.has(spec.name);
        // Delete changed rows together so secondary unique values can be exchanged.
        const removed = upsert ? deletions : [...deletions, ...rows.map(row => [row[0]])];
        await insertSnapshotRows(`DELETE FROM ${spec.name} WHERE ${columns[0]} = ?`, removed);
        await insertSnapshotRows(spec.insertSQL + (upsert
          ? ' ON CONFLICT(id) DO UPDATE SET ' + columns.slice(1).map(column => `${column}=excluded.${column}`).join(', ') : ''), rows);
        continue;
      }
      await run(`DELETE FROM ${spec.name}`);
      await insertSnapshotRows(spec.insertSQL, rows);
    }

    await run('COMMIT');
    snapshot.commit();
    lastFlushTables = changed.map(({ spec }) => spec.name);
    totalTableWrites += changed.length;
  } catch (err) {
    snapshot.rollback();
    // Preserve the original failure. A failed/externally interrupted BEGIN or
    // COMMIT must not be replaced by "no transaction is active" from cleanup.
    try { await run('ROLLBACK'); } catch {}
    throw err;
  }
}

export function ensureDatabaseInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = initDatabase();
  }
  return initPromise;
}

export async function querySQL<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  // Admit the read to the same queue: waiting on an earlier lock alone lets
  // a later replacement transaction expose its intermediate DELETE state.
  return withDatabaseWriteLock(() => query<T>(sql, params));
}

export async function runSQL(sql: string, params: any[] = []): Promise<void> {
  return withDatabaseWriteLock(() => run(sql, params));
}
