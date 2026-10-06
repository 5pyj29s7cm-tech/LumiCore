import { INITIAL_SCHEMA_SQL } from './server/db/initial_schema';
import sqlite3 from 'sqlite3';
import { createTableSession, prepareTableCommit, isTableSession } from './server/db/table_session';
import { DATABASE_TABLES, DOCUMENT_COLLECTION_DEFAULTS, documentCollectionKey, loadDocumentCollections, type DatabaseTableName } from './server/db/table_catalog';
import { migrateSchema } from './server/db/migrations';
import fs from 'fs';
import path from 'path';
import { DatabaseSnapshots, databaseTarget, type SnapshotProjection } from './server/db/snapshot_changes';
import { hasCurrentMemoryEmbedding, parsePersistedMemoryEmbedding } from './server/memory/embedding_identity';
import bcrypt from 'bcryptjs';
import {
  assertSafeSqliteDataPath,
  getDataPath,
  getDataRoot,
  hasExplicitDataRoot,
} from './server/config/data_path';
import { prepareRuntimeDataRoot } from './server/runtime/data_root_preflight';
import { isolateLegacyGuardSummaryState } from './server/conversation/guard_history';
import {
  configureExternalCommitJournal,
  type ExternalCommitJournalAdapter,
  type ExternalCommitJournalEntry,
} from './server/tools/external_commit_journal';
import { sanitizeToolRecordsForPersistence } from './server/cognition/user_output_protection';
import {
  parseCompletionFeedbackFromPersistence,
  serializeCompletionFeedbackForPersistence,
} from './server/conversation/completion_feedback';

// Auto-migrate data from old location (project directory) to user directory on first run
function migrateDataFromOldLocation() {
  const oldDir = path.join(process.cwd(), 'data');
  const newDir = path.join(getDataRoot(), 'data');
  if (!fs.existsSync(oldDir)) return;
  if (fs.existsSync(newDir)) {
    const files = fs.readdirSync(newDir).filter(f => f !== '.gitkeep');
    if (files.length > 0) return; // already has data, skip
  }
  console.log('[Data] Migrating from', oldDir, 'to', newDir);
  try {
    fs.mkdirSync(newDir, { recursive: true });
    for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
      const src = path.join(oldDir, entry.name);
      const dest = path.join(newDir, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    console.log('[Data] Migration complete —', newDir);
  } catch (err) {
    console.warn('[Data] Migration failed (non-fatal):', (err as Error).message);
  }
}

let databaseRuntimePrepared = false;
let databasePath = '';

/**
 * Importing database-backed tool definitions must remain side-effect free.
 * Build-time capability inventory imports those modules only to register
 * metadata, so acquire the process lease and inspect legacy data only when a
 * caller actually initializes persistence.
 */
function prepareDatabaseRuntime(): string {
  if (databaseRuntimePrepared) return databasePath;
  // Production persistence is process-exclusive per canonical Lumi data
  // root. This also remains the fallback for direct initDatabase() callers
  // that did not enter through runtime/server_entry.ts.
  prepareRuntimeDataRoot();
  // An explicit data root is an isolation boundary (tests, containers,
  // managed deployments). Never import cwd data into it implicitly.
  if (!hasExplicitDataRoot()) migrateDataFromOldLocation();
  databasePath = getDataPath('lumi.db');
  assertSafeSqliteDataPath(databasePath);
  databaseRuntimePrepared = true;
  return databasePath;
}

let db: sqlite3.Database | null = null;
let startupQuickCheckPassed = false;


let memoryDB: any = null;
const SYSTEM_FLAGS_SETTING = '__lumi_system_flags';
const SYSTEM_SNAPSHOTS_SETTING = '__lumi_system_snapshots';
// One-version compatibility snapshot. Legacy continuation data can be read and
// migrated, but new task state is persisted only in conversation_action_*.
// Keeping the original value outside the mutable conversation projection stops
// normal database flushes from writing new state back into the legacy column.
const legacyActionContinuationStates = new WeakMap<object, Record<string, any> | undefined>();

export interface LegacySummaryPersistenceRepair {
  id: string;
  summary: string;
  summaryChain: string[];
  lastSummaryMessageCount: number;
}

type LegacySummaryRepairWriter = (
  repair: LegacySummaryPersistenceRepair,
  complete: (error?: Error | null) => void,
) => void;

function parseScheduledDeliveryMetadata(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const metadata = parsed as Record<string, any>;
  const safeId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512;
  if (!safeId(metadata.executionId) || !safeId(metadata.scheduledTaskId)) return undefined;
  const result: Record<string, unknown> = { executionId: metadata.executionId, scheduledTaskId: metadata.scheduledTaskId };
  if (metadata.reminderIds !== undefined) {
    if (!Array.isArray(metadata.reminderIds) || !metadata.reminderIds.length || metadata.reminderIds.length > 10
      || !metadata.reminderIds.every(safeId) || new Set(metadata.reminderIds).size !== metadata.reminderIds.length) return undefined;
    result.reminderIds = metadata.reminderIds;
  }
  if (metadata.proactiveVoiceDispatch !== undefined) {
    const dispatch = metadata.proactiveVoiceDispatch;
    if (!dispatch || !safeId(dispatch.reservation) || typeof dispatch.reservedAt !== 'string'
      || !Number.isFinite(Date.parse(dispatch.reservedAt))) return undefined;
    result.proactiveVoiceDispatch = { reservation: dispatch.reservation, reservedAt: dispatch.reservedAt };
  }
  return result;
}

function parseStoredToolCalls(value: unknown, mode?: string): any[] | string | undefined {
  if (mode === 'proactive') {
    const metadata = parseScheduledDeliveryMetadata(value);
    if (metadata) return JSON.stringify(metadata);
  }
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(current) ? current : undefined;
}

function serializeStoredToolCalls(value: unknown, mode?: string): string {
  if (mode === 'proactive') {
    const metadata = parseScheduledDeliveryMetadata(value);
    if (metadata) return JSON.stringify(metadata);
  }
  const records = sanitizeToolRecordsForPersistence(value);
  return records?.length ? JSON.stringify(records) : '';
}

function compactStoredContinuationValue(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Persist the conversation-scoped task ledger. V2 deliberately includes the
 * pre-tool planning/confirmation state so a restart cannot erase the task or
 * turn the user's later “确认/继续” into an unrelated chat message.
 */
function parseStoredActionContinuationState(value: unknown): Record<string, any> | undefined {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return undefined;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const raw = parsed as Record<string, any>;
  const goal = compactStoredContinuationValue(raw.goal, 700);
  const evidenceTools = Array.from(new Set(
    (Array.isArray(raw.evidenceTools) ? raw.evidenceTools : [])
      .map((name: unknown) => compactStoredContinuationValue(name, 120))
      .filter(Boolean),
  )).slice(-10);
  const version = Number(raw.version);
  if ((version !== 1 && version !== 2) || !goal) return undefined;
  // Legacy v1 pointers were evidence-only. V2 also persists planning and
  // confirmation state before the first tool runs, so an empty evidence list
  // is valid and necessary for cross-turn task continuity.
  if (version === 1 && evidenceTools.length === 0) return undefined;

  const sourcePaths = Array.from(new Set(
    (Array.isArray(raw.sourcePaths) ? raw.sourcePaths : [])
      .map((item: unknown) => compactStoredContinuationValue(item, 500))
      .filter(Boolean),
  )).slice(0, 8);
  const toolSummaries = Array.from(new Set(
    (Array.isArray(raw.toolSummaries) ? raw.toolSummaries : [])
      .map((item: unknown) => compactStoredContinuationValue(item, 700))
      .filter(Boolean),
  )).slice(-10);

  const policy = raw.policySnapshot && typeof raw.policySnapshot === 'object'
    ? raw.policySnapshot as Record<string, any>
    : null;
  const policySnapshot = policy
    ? {
        allowedTools: Array.from(new Set(
          (Array.isArray(policy.allowedTools) ? policy.allowedTools : [])
            .map((item: unknown) => compactStoredContinuationValue(item, 160))
            .filter(Boolean),
        )).slice(0, 160),
        requireConfirmation: Array.from(new Set(
          (Array.isArray(policy.requireConfirmation) ? policy.requireConfirmation : [])
            .map((item: unknown) => compactStoredContinuationValue(item, 160))
            .filter(Boolean),
        )).slice(0, 160),
        forbiddenTools: Array.from(new Set(
          (Array.isArray(policy.forbiddenTools) ? policy.forbiddenTools : [])
            .map((item: unknown) => compactStoredContinuationValue(item, 160))
            .filter(Boolean),
        )).slice(0, 160),
        maxIterations: Math.max(1, Math.min(Number(policy.maxIterations) || 5, 40)),
      }
    : undefined;
  const receipts = (Array.isArray(raw.receipts) ? raw.receipts : [])
    .map((receipt: any) => {
      const name = compactStoredContinuationValue(receipt?.name, 160);
      const key = compactStoredContinuationValue(receipt?.key, 1000);
      if (!name || !key) return null;
      return {
        id: compactStoredContinuationValue(receipt?.id, 180) || key,
        key,
        name,
        arguments: receipt?.arguments && typeof receipt.arguments === 'object' && !Array.isArray(receipt.arguments)
          ? receipt.arguments
          : {},
        result: compactStoredContinuationValue(receipt?.result, 3000),
        error: compactStoredContinuationValue(receipt?.error, 700),
        outcome: receipt?.outcome === 'success' ? 'success' : 'failure',
        recordedAt: compactStoredContinuationValue(receipt?.recordedAt, 80) || new Date(0).toISOString(),
      };
    })
    .filter(Boolean)
    .slice(-40);
  const status = ['planning', 'executing', 'waiting_confirmation', 'blocked', 'completed', 'cancelled']
    .includes(compactStoredContinuationValue(raw.status, 40))
    ? compactStoredContinuationValue(raw.status, 40)
    : Boolean(raw.unfinished) ? 'blocked' : 'completed';

  return {
    version,
    ...(version === 2 ? {
      taskId: compactStoredContinuationValue(raw.taskId, 180) || undefined,
      status,
      policySnapshot,
      receipts,
      activeRequestId: compactStoredContinuationValue(raw.activeRequestId, 180) || undefined,
      supersededTaskId: compactStoredContinuationValue(raw.supersededTaskId, 180) || undefined,
      revision: Math.max(0, Math.trunc(Number(raw.revision) || 0)),
    } : {}),
    goal,
    latestInstruction: compactStoredContinuationValue(raw.latestInstruction || goal, 700),
    ...(compactStoredContinuationValue(raw.latestInstructionRef, 180)
      ? { latestInstructionRef: compactStoredContinuationValue(raw.latestInstructionRef, 180) }
      : {}),
    appTarget: compactStoredContinuationValue(raw.appTarget, 160),
    sourcePaths,
    latestBlocker: compactStoredContinuationValue(raw.latestBlocker, 380),
    unfinished: Boolean(raw.unfinished),
    evidenceTools,
    assistantState: compactStoredContinuationValue(raw.assistantState, 700),
    toolSummaries,
    updatedAt: compactStoredContinuationValue(raw.updatedAt, 80) || new Date(0).toISOString(),
    ...(compactStoredContinuationValue(raw.evidenceMessageId, 160)
      ? { evidenceMessageId: compactStoredContinuationValue(raw.evidenceMessageId, 160) }
      : {}),
  };
}

function serializeStoredActionContinuationState(value: unknown): string {
  const state = parseStoredActionContinuationState(value);
  return state ? JSON.stringify(state) : '{}';
}

function parseJsonSetting<T>(settings: any[], key: string, fallback: T): T {
  const row = settings.find((s: any) => s.key === key);
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function parsePayloadRows(rows: any[]): any[] {
  return (rows || []).flatMap((row: any) => {
    try {
      const payload = JSON.parse(row.payload || '{}');
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? [{
            ...payload,
            id: row.id,
            orgId: row.orgId,
            ...(row.status !== undefined ? { status: row.status } : {}),
            ...(row.enabled !== undefined ? { enabled: Boolean(row.enabled) } : {}),
            ...(row.priority !== undefined ? { priority: Number(row.priority) || 0 } : {}),
            ...(row.idempotencyKey !== undefined ? { idempotencyKey: row.idempotencyKey } : {}),
            ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
            ...(row.source !== undefined ? { source: row.source } : {}),
            ...(row.requesterUserId !== undefined ? { requesterUserId: row.requesterUserId } : {}),
            ...(row.conversationId !== undefined ? { conversationId: row.conversationId } : {}),
            ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
            ...(row.workItemId !== undefined ? { workItemId: row.workItemId } : {}),
            createdAt: row.createdAt || payload.createdAt,
            updatedAt: row.updatedAt || payload.updatedAt,
          }]
        : [];
    } catch {
      return [];
    }
  });
}

function* settingsRowsWithSystemState(items?: any[]): Iterable<any[]> {
  const settings = items || (Array.isArray(memoryDB?.settings) ? memoryDB.settings : []);
  for (const setting of settings) {
    if (setting?.key !== SYSTEM_FLAGS_SETTING && setting?.key !== SYSTEM_SNAPSHOTS_SETTING && !Object.keys(DOCUMENT_COLLECTION_DEFAULTS).some(name => setting?.key === documentCollectionKey(name))) yield [setting.key, setting.value];
  }

  if (!items) yield* systemStateRows();
}

function* systemStateRows(): Iterable<any[]> {
  for (const [name, fallback] of Object.entries(DOCUMENT_COLLECTION_DEFAULTS)) {
    const value = memoryDB?.[name] ?? fallback;
    if (JSON.stringify(value) !== JSON.stringify(fallback)) yield [documentCollectionKey(name), JSON.stringify(value)];
  }
  if (memoryDB?.systemFlags && Object.keys(memoryDB.systemFlags).length > 0) {
    yield [SYSTEM_FLAGS_SETTING, JSON.stringify(memoryDB.systemFlags)];
  }

  if (Array.isArray(memoryDB?.systemSnapshots) && memoryDB.systemSnapshots.length > 0) {
    yield [SYSTEM_SNAPSHOTS_SETTING, JSON.stringify(memoryDB.systemSnapshots.slice(-120))];
  }

}

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
          await createTables();
          await migrateSchema(db!);
          await migrateRetiredLocalAgentTables();
          await requireSqliteQuickCheck('after');
          await loadMemoryDB();
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

/**
 * Retire the old local Agent/team persistence without erasing the one
 * user-facing capability that used to be stored in that table: Memory
 * Avatars.  The migration is deliberately explicit and fail-closed: legacy
 * rows are copied first, and only then are the team-runtime tables removed.
 */
async function migrateRetiredLocalAgentTables(): Promise<void> {
  const tableRows = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agents', 'agent_templates', 'background_delegation_tasks', 'external_ai_sessions', 'external_ai_dispatches', 'external_ai_answers')",
  );
  const existing = new Set(tableRows.map(row => String(row.name || '')));

  if (existing.has('agents')) {
    const legacyAgents = await query<any>('SELECT * FROM agents');
    for (const legacy of legacyAgents) {
      const parseObject = (value: unknown): Record<string, any> => {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
        if (typeof value !== 'string') return {};
        try {
          const parsed = JSON.parse(value || '{}');
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
          return {};
        }
      };
      // The legacy route stored the sanctuary marker and identity fields on
      // the Agent row, while MemoryAvatarLab put personality/evidence/seeds
      // inside the data column. Merge both shapes before retiring the table.
      const config = {
        ...parseObject(legacy.config),
        ...parseObject(legacy.data),
      };

      // Sanctuary records were the only old Agent records that represented a
      // personal memory companion.  Do not resurrect ordinary workers,
      // external runtimes, or team templates.
      const isMemoryAvatar = legacy.territory === 'sanctuary'
        || config.territory === 'sanctuary'
        || legacy.distilledFrom === 'chat_records'
        || config.distilledFrom === 'chat_records'
        || (legacy.memoryScope === 'private' && Boolean(config.personalityConfig));
      if (!isMemoryAvatar) continue;

      const id = String(legacy.id || '').trim();
      const userId = String(legacy.userId || '').trim();
      if (!id || !userId) continue;
      const now = new Date().toISOString();
      const relationshipType = String(config.relationshipType || legacy.relationshipType || legacy.category || 'close_friend').trim() || 'close_friend';
      const payload = {
        ...config,
        personalityConfig: config.personalityConfig || {},
        evidenceMap: Array.isArray(config.evidenceMap) ? config.evidenceMap : [],
        seedMemories: Array.isArray(config.seedMemories) ? config.seedMemories : [],
        narrative: String(config.narrative || ''),
        isFrozen: config.isFrozen !== false && legacy.isFrozen !== false,
      };
      await run(
        `INSERT OR IGNORE INTO memory_avatars (id, userId, name, relationshipType, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        [id, userId, String(legacy.name || 'Memory').trim() || 'Memory', relationshipType, JSON.stringify(payload), legacy.createdAt || now, now],
      );

      // Older versions kept seed memories only inside the Agent config. Make
      // them durable and private to this avatar before dropping the legacy
      // table. INSERT OR IGNORE makes a repeated startup migration safe.
      const seeds = Array.isArray(config.seedMemories) ? config.seedMemories : [];
      for (let index = 0; index < seeds.length; index += 1) {
        const seed = seeds[index];
        if (!seed || typeof seed !== 'object' || !String(seed.content || '').trim()) continue;
        const memoryId = `memory-avatar-seed-${id}-${index}`;
        const createdAt = String(legacy.createdAt || now);
        await run(
          `INSERT OR IGNORE INTO memories (id, userId, type, content, keywords, confidence, sourceInteractionId, createdAt, updatedAt, lastRetrievedAt, retrieveCount, tier, perspective, importance, parentId, agentId, nodeType, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'semantic', 'owner_trait', 0.8, NULL, ?, 'leaf', 'personal', '')`,
          [
            memoryId,
            userId,
            ['preference', 'fact', 'habit', 'knowledge'].includes(String(seed.type)) ? String(seed.type) : 'fact',
            String(seed.content).slice(0, 1000),
            JSON.stringify(Array.isArray(seed.keywords) ? seed.keywords.slice(0, 12) : []),
            Math.min(0.95, Math.max(0.1, Number(seed.confidence) || 0.6)),
            `memory-avatar-import:${id}`,
            createdAt,
            createdAt,
            id,
          ],
        );
      }
    }
  }

  // LAP has its own scoped protocol storage and is intentionally unaffected.
  for (const table of [
    'agents',
    'agent_templates',
    'background_delegation_tasks',
    'external_ai_sessions',
    'external_ai_dispatches',
    'external_ai_answers',
  ]) {
    if (existing.has(table)) await run(`DROP TABLE IF EXISTS ${table}`);
  }
}


function createTables(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sql = INITIAL_SCHEMA_SQL;

    // Canvas sessions — infinite canvas workbench
    db!.run(`CREATE TABLE IF NOT EXISTS canvas_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      cards TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      taskText TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      domain TEXT DEFAULT 'personal',
      orgId TEXT DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);

    db!.exec(sql, (err) => {
      if (err) { reject(err); return; }
      insertInitialData().then(resolve).catch(reject);
    });
  });
}

async function insertInitialData(): Promise<void> {
  const tables = ['users', 'interactions', 'marketplace_skills', 'skills', 'founder_vision'];
  const counts: { [table: string]: number } = {};

  for (const table of tables) {
    const count = await query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
    counts[table] = count[0]?.cnt ?? 0;
  }

  if (counts.users === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const now = new Date().toISOString();
    await run(
      `INSERT INTO users (uid, username, password, role, balance, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['admin-uid', 'admin', hashedPassword, 'admin', 1000, '', now]
    );
  }

  if (counts.marketplace_skills === 0) {
    const defaultSkills = [
      ['skill-1', '财务报表分析 LoRA', 'LumiNode_01', 50, '针对企业财务报表的深度微调权重，支持自动化对账与异常检测。', 'Finance'],
      ['skill-2', '创意剧本创作 LoRA', 'CreativeMind', 30, '专注于科幻与悬疑风格的剧本创作，具备极强的逻辑连贯性。', 'Creative'],
      ['skill-3', '医疗辅助诊断 LoRA', 'HealthGuard', 100, '基于公开医疗数据集微调，辅助识别常见病症与用药建议。', 'Medical']
    ];
    for (const skill of defaultSkills) {
      await run(`INSERT INTO marketplace_skills (id, name, author, price, description, category) VALUES (?, ?, ?, ?, ?, ?)`, skill);
    }
  }

  if (counts.skills === 0) {
    const coreSkills = [
      ['vision', 'Vision Core', 'Advanced image recognition and spatial awareness.'],
      ['logic', 'Logic Engine', 'Complex reasoning and mathematical problem solving.'],
      ['empathy', 'Empathy Module', 'Emotional intelligence and nuanced conversation.']
    ];
    for (const skill of coreSkills) {
      await run(`INSERT INTO skills (id, name, description) VALUES (?, ?, ?)`, skill);
    }
  }

  if (counts.founder_vision === 0) {
    await run(
      `INSERT INTO founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
      [1, 'LumiAI 旨在构建一个去中心化的智能协议。我们追求空间存在感、边缘计算与数据主权。通过分布式节点，每一个用户都能拥有真正属于自己的、可进化的数字生命。', new Date().toISOString()]
    );
  }
}

// Load database and map old column names to field names server.ts expects
async function loadMemoryDB(): Promise<void> {
  const users = await query<any>('SELECT * FROM users');
  const interactionsRaw = await query<any>('SELECT * FROM interactions');
  const marketplaceSkills = await query<any>('SELECT * FROM marketplace_skills');
  const skills = await query<any>('SELECT * FROM skills');
  const founderVisionRow = await query<any>('SELECT content, updatedAt FROM founder_vision WHERE id = 1');
  const founderVision = founderVisionRow[0]?.content || '';
  const founderVisionUpdatedAt = founderVisionRow[0]?.updatedAt || new Date(0).toISOString();

  // Load memories
  const memoriesRaw = await query<any>('SELECT * FROM memories');
  const memories = memoriesRaw.map((m: any) => {
    const memory = { ...m, keywords: m.keywords ? JSON.parse(m.keywords) : [] };
    return { ...memory, ...parsePersistedMemoryEmbedding(memory) };
  });
  const memoryAvatarsRaw = await query<any>('SELECT * FROM memory_avatars');
  const memoryAvatars = memoryAvatarsRaw.map((row: any) => {
    let payload: Record<string, any> = {};
    try {
      const parsed = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : row.payload;
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch {}
    return {
      ...row,
      payload,
      personalityConfig: payload.personalityConfig || {},
      evidenceMap: Array.isArray(payload.evidenceMap) ? payload.evidenceMap : [],
      seedMemories: Array.isArray(payload.seedMemories) ? payload.seedMemories : [],
      isFrozen: payload.isFrozen !== false,
    };
  });

  // Load reminders
  const remindersRaw = await query<any>('SELECT * FROM reminders');

  // Load conversations
  const conversationsRaw = await query<any>('SELECT * FROM conversations');
  const conversationActionTasks = await query<any>('SELECT * FROM conversation_action_tasks');
  const conversationActionTurns = await query<any>('SELECT * FROM conversation_action_turns');
  const conversationActionReceipts = await query<any>('SELECT * FROM conversation_action_receipts');
  const modelRoutingReceiptsRaw = await query<any>('SELECT * FROM model_routing_receipts');
  const readOnlyToolPatternsRaw = await query<any>('SELECT * FROM read_only_tool_patterns');
  const commandCenterPlansRaw = await query<any>('SELECT * FROM command_center_plans');
  const autonomousTasksRaw = await query<any>('SELECT * FROM autonomous_tasks');
  const externalAiHistorySourcesRaw = await query<any>('SELECT * FROM external_ai_history_sources');
  const externalAiHistorySyncJobsRaw = await query<any>('SELECT * FROM external_ai_history_sync_jobs');
  const externalAiHistoryConversationsRaw = await query<any>('SELECT * FROM external_ai_history_conversations');
  const externalAiHistoryMessagesRaw = await query<any>('SELECT * FROM external_ai_history_messages');
  const externalAiHistoryAttachmentsRaw = await query<any>('SELECT * FROM external_ai_history_attachments');
  const extensionPublishersRaw = await query<any>('SELECT * FROM extension_publishers');
  const extensionRevisionsRaw = await query<any>('SELECT * FROM extension_revisions');
  const extensionActivationReceiptsRaw = await query<any>('SELECT * FROM extension_activation_receipts');
  const externalCapabilityPackagesRaw = await query<any>('SELECT * FROM external_capability_packages');
  const externalCapabilityReceiptsRaw = await query<any>('SELECT * FROM external_capability_receipts');
  const canvasSessionsRaw = await query<any>('SELECT * FROM canvas_sessions');

  // Load token usage
  const tokenUsageRaw = await query<any>('SELECT * FROM token_usage');

  // Load org tables
  const organizations = await query<any>('SELECT * FROM organizations');
  const departments = await query<any>('SELECT * FROM departments');
  const orgMemberships = await query<any>('SELECT * FROM org_memberships');
  const orgPositionsRaw = await query<any>('SELECT * FROM org_positions');
  const orgWorkRoutingRulesRaw = await query<any>('SELECT * FROM org_work_routing_rules');
  const orgWorkItemsRaw = await query<any>('SELECT * FROM org_work_items');
  const orgWorkApprovalsRaw = await query<any>('SELECT * FROM org_work_approvals');
  const orgWorkHandoffsRaw = await query<any>('SELECT * FROM org_work_handoffs');
  const orgResourcePoliciesRaw = await query<any>('SELECT * FROM org_resource_policies');
  const orgResourceGrantsRaw = await query<any>('SELECT * FROM org_resource_grants');
  const orgCredentialReferencesRaw = await query<any>('SELECT * FROM org_credential_references');
  const orgDevicesRaw = await query<any>('SELECT * FROM org_devices');
  const orgInvitations = await query<any>('SELECT * FROM org_invitations');
  const orgKbArticles = await query<any>('SELECT * FROM org_kb_articles');
  const orgKbEmbeddings = await query<any>('SELECT * FROM org_kb_embeddings');
  const notificationsRaw = await query<any>('SELECT * FROM notifications');
  const notifications = notificationsRaw.map((n: any) => ({
    ...n,
    read: !!n.read,
  }));
  const auditLogEntries = await query<any>('SELECT * FROM audit_log');

  // Load settings
  const settingsRaw = await query<any>('SELECT * FROM settings');
  const settings = settingsRaw.map((s: any) => ({ key: s.key, value: s.value }));
  const systemFlags = parseJsonSetting(settings, SYSTEM_FLAGS_SETTING, {});
  const systemSnapshots = parseJsonSetting<any[]>(settings, SYSTEM_SNAPSHOTS_SETTING, []);

  // Load voice profiles and reconstruct userId-keyed map
  const voiceProfilesRaw = await query<any>('SELECT * FROM voice_profiles');
  const voiceProfiles: Record<string, any[]> = {};
  for (const vp of voiceProfilesRaw) {
    if (!voiceProfiles[vp.userId]) voiceProfiles[vp.userId] = [];
    voiceProfiles[vp.userId].push({
      voiceId: vp.voiceId,
      name: vp.name,
      provider: vp.provider,
      createdAt: vp.createdAt,
    });
  }

  const interactions = interactionsRaw.map((i: any) => ({
    ...i,
    content: i.message || i.content || '',
    role: i.role || '',
    personality: i.personality || i.module || '',
    mode: i.mode || '',
    toolCalls: parseStoredToolCalls(i.toolCalls, i.mode),
    conversationId: i.conversationId || '',
    cognitiveIntent: i.cognitiveIntent || '',
    llmWasCalled: i.llmWasCalled ? true : false,
    completionFeedback: parseCompletionFeedbackFromPersistence(i.completionFeedback),
    domain: i.domain || 'personal',
    orgId: i.orgId || '',
    source: i.source || '',
    channel: i.channel || '',
    externalMessageId: i.externalMessageId || '',
    routeSequence: Number.isFinite(i.routeSequence) ? Number(i.routeSequence) : undefined,
    receivedAt: i.receivedAt || '',
    requestId: i.requestId || i.externalMessageId || '',
    nativeDeviceId: i.nativeDeviceId || '',
    executionSessionId: i.executionSessionId || '',
    nativeClientIdentitySha256: i.nativeClientIdentitySha256 || '',
    audioInputKind: i.audioInputKind || '',
    syntheticAudio: i.syntheticAudio === 1 ? true : i.syntheticAudio === 0 ? false : undefined,
    captureSessionId: i.captureSessionId || '',
    sttReceiptId: i.sttReceiptId || '',
    contextChainId: i.contextChainId || '',
    previousRequestId: i.previousRequestId || '',
  }));

  const legacySummaryRepairs: LegacySummaryPersistenceRepair[] = [];
  const conversations = (conversationsRaw || []).map((c: any) => {
    let summaryChain: string[] = [];
    if (Array.isArray(c.summaryChain)) {
      summaryChain = c.summaryChain.map((item: unknown) => String(item || '').trim()).filter(Boolean);
    } else if (typeof c.summaryChain === 'string' && c.summaryChain.trim()) {
      try {
        const parsed = JSON.parse(c.summaryChain);
        if (Array.isArray(parsed)) {
          summaryChain = parsed.map((item: unknown) => String(item || '').trim()).filter(Boolean);
        }
      } catch { /* Invalid legacy data is treated as an empty chain. */ }
    }
    const isolatedSummary = isolateLegacyGuardSummaryState({
      summary: c.summary,
      summaryChain,
      lastSummaryMessageCount: c.lastSummaryMessageCount,
    });
    if (isolatedSummary.changed) {
      legacySummaryRepairs.push({
        id: String(c.id || ''),
        summary: isolatedSummary.summary,
        summaryChain: isolatedSummary.summaryChain,
        lastSummaryMessageCount: isolatedSummary.lastSummaryMessageCount,
      });
    }
    const legacyActionContinuationState = parseStoredActionContinuationState(c.actionContinuationState);
    const conversation = {
      ...c,
      summary: isolatedSummary.summary,
      summaryChain: isolatedSummary.summaryChain,
      lastSummaryMessageCount: isolatedSummary.lastSummaryMessageCount,
      actionContinuationState: legacyActionContinuationState,
      domain: c.domain || 'personal',
      orgId: c.orgId || '',
    };
    legacyActionContinuationStates.set(conversation, legacyActionContinuationState);
    return conversation;
  });

  memoryDB = {
    ...loadDocumentCollections(settings || []),
    users,
    interactions,
    marketplaceSkills,
    skills,
    founderVision,
    founderVisionUpdatedAt,
    memories: (memories || []).map((m: any) => ({ ...m, domain: m.domain || 'personal', orgId: m.orgId || '' })),
    memoryAvatars,
    reminders: remindersRaw || [],
    conversations,
    conversationActionTasks: conversationActionTasks || [],
    conversationActionTurns: conversationActionTurns || [],
    conversationActionReceipts: conversationActionReceipts || [],
    modelRoutingReceipts: (modelRoutingReceiptsRaw || []).map((receipt: any) => ({
      ...receipt,
      syntheticAudio: receipt.syntheticAudio === 1
        ? true
        : receipt.syntheticAudio === 0 ? false : undefined,
      attempts: (() => {
        try { return JSON.parse(receipt.attempts || '[]'); } catch { return []; }
      })(),
    })),
    readOnlyToolPatterns: (readOnlyToolPatternsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{
              ...payload,
              id: row.id,
              userId: row.userId,
              domain: row.domain || 'personal',
              orgId: row.orgId || '',
              confidence: Number(row.confidence) || 0,
              successCount: Number(row.successCount) || 0,
              updatedAt: row.updatedAt,
            }]
          : [];
      } catch { return []; }
    }),
    commandCenterPlans: (commandCenterPlansRaw || []).map((row: any) => {
      let membershipAuthorization;
      try { membershipAuthorization = JSON.parse(row.membershipAuthorization || 'null') || undefined; } catch { /* Missing or invalid authority fails closed. */ }
      return { ...row, membershipAuthorization };
    }),
    autonomousTasks: (autonomousTasksRaw || []).flatMap((row: any) => {
      try {
        const task = JSON.parse(row.payload || '{}');
        return task && typeof task === 'object' ? [{ ...task, id: row.id, userId: row.userId, status: row.status, leaseExpiresAt: row.leaseExpiresAt || '', updatedAt: row.updatedAt }] : [];
      } catch { return []; }
    }),
    externalAiHistorySources: (externalAiHistorySourcesRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, userId: row.userId, domain: row.domain || 'personal', orgId: row.orgId || '', sourceKind: row.sourceKind, status: row.status, updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    externalAiHistorySyncJobs: (externalAiHistorySyncJobsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, sourceId: row.sourceId, userId: row.userId, status: row.status, nextCursor: row.nextCursor || '', updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    externalAiHistoryConversations: (externalAiHistoryConversationsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, sourceId: row.sourceId, userId: row.userId, externalConversationId: row.externalConversationId, updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    externalAiHistoryMessages: (externalAiHistoryMessagesRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, sourceId: row.sourceId, conversationId: row.conversationId, userId: row.userId, externalMessageId: row.externalMessageId, contentDigest: row.contentDigest, messageAt: row.messageAt || '', updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    externalAiHistoryAttachments: (externalAiHistoryAttachmentsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, sourceId: row.sourceId, messageId: row.messageId, userId: row.userId, externalAttachmentId: row.externalAttachmentId, contentDigest: row.contentDigest || '', updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    extensionPublishers: (extensionPublishersRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, fingerprint: row.fingerprint, publisherId: row.publisherId, status: row.status, updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    extensionRevisions: (extensionRevisionsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{
              ...payload,
              id: row.id,
              extensionId: row.extensionId,
              userId: row.userId,
              version: row.version,
              kind: row.kind,
              status: row.status,
              manifestDigest: row.manifestDigest,
              signerFingerprint: row.signerFingerprint,
              updatedAt: row.updatedAt,
            }]
          : [];
      } catch { return []; }
    }),
    extensionActivationReceipts: (extensionActivationReceiptsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, extensionId: row.extensionId, revisionId: row.revisionId, status: row.status, createdAt: row.createdAt }]
          : [];
      } catch { return []; }
    }),
    externalCapabilityPackages: (externalCapabilityPackagesRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{
              ...payload,
              id: row.id,
              ownerUserId: row.ownerUserId,
              capabilityId: row.capabilityId,
              version: row.version,
              status: row.status,
              packageDigest: row.packageDigest,
              updatedAt: row.updatedAt,
            }]
          : [];
      } catch { return []; }
    }),
    externalCapabilityReceipts: (externalCapabilityReceiptsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{
              ...payload,
              id: row.id,
              packageRowId: row.packageRowId,
              ownerUserId: row.ownerUserId,
              capabilityId: row.capabilityId,
              actionId: row.actionId || '',
              kind: row.kind,
              status: row.status,
              createdAt: row.createdAt,
            }]
          : [];
      } catch { return []; }
    }),
    canvas_sessions: (canvasSessionsRaw || []).map((s: any) => ({ ...s, edges: s.edges || '[]', domain: s.domain || 'personal', orgId: s.orgId || '' })),
    settings: settings || [],
    systemFlags: systemFlags || {},
    systemSnapshots: Array.isArray(systemSnapshots) ? systemSnapshots : [],
    voiceProfiles: voiceProfiles || {},
    tokenUsage: tokenUsageRaw || [],
    organizations: organizations || [],
    departments: departments || [],
    orgMemberships: orgMemberships || [],
    orgPositions: parsePayloadRows(orgPositionsRaw),
    orgWorkRoutingRules: parsePayloadRows(orgWorkRoutingRulesRaw),
    orgWorkItems: parsePayloadRows(orgWorkItemsRaw),
    orgWorkApprovals: parsePayloadRows(orgWorkApprovalsRaw),
    orgWorkHandoffs: parsePayloadRows(orgWorkHandoffsRaw),
    orgResourcePolicies: parsePayloadRows(orgResourcePoliciesRaw),
    orgResourceGrants: parsePayloadRows(orgResourceGrantsRaw),
    orgCredentialReferences: parsePayloadRows(orgCredentialReferencesRaw),
    orgDevices: parsePayloadRows(orgDevicesRaw),
    orgInvitations: orgInvitations || [],
    orgKbArticles: orgKbArticles || [],
    orgKbEmbeddings: orgKbEmbeddings || [],
    notifications: notifications || [],
    auditLog: auditLogEntries || [],
  };

  seedPersistenceTableDigests();

  configureSqliteExternalCommitJournal();

  // Prompt safety is already guaranteed by the sanitized in-memory rows.
  // Persist the cleanup opportunistically without making a writable database
  // a startup dependency (tests, shutdown races, and recovery mounts may be
  // temporarily read-only).
  persistLegacySummaryRepairsBestEffort(legacySummaryRepairs);
}

function run(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db!.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Bound native binding memory while amortizing statement preparation. */
async function insertSnapshotRows(sql: string, rows: any[][]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 512) {
    await insertSnapshotBatch(sql, rows.slice(offset, offset + 512));
  }
}

/** Reuse one prepared statement within the caller's atomic snapshot transaction. */
function insertSnapshotBatch(sql: string, rows: any[][]): Promise<void> {
  if (rows.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const statement = db!.prepare(sql, prepareError => {
      if (prepareError) {
        statement.finalize(() => reject(prepareError));
        return;
      }
      let firstError: Error | null = null;
      // sqlite3 serializes operations on a Statement. Queue its rows together
      // rather than re-preparing SQL and making a JS/native round trip for
      // every row. Finalize waits for every queued callback before settling,
      // so a rejected row still rolls back the whole surrounding transaction.
      try {
        for (const row of rows) {
          statement.run(row, error => { if (error && !firstError) firstError = error; });
        }
      } catch (error) {
        firstError ||= error instanceof Error ? error : new Error(String(error));
      }
      statement.finalize(error => {
        if (firstError || error) reject(firstError || error);
        else resolve();
      });
    });
  });
}

function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db!.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
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

export interface DatabaseSqlWriteSession {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<void>;
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
  const adapter: ExternalCommitJournalAdapter = {
    async lookup(idempotencyKey) {
      return withDatabaseWriteLock(async () => {
        const rows = await query<ExternalCommitJournalEntry>(
          'SELECT * FROM external_commit_journal WHERE idempotencyKey = ? LIMIT 1',
          [idempotencyKey],
        );
        return rows[0] || null;
      });
    },
    async claim(entry) {
      return withDatabaseWriteLock(async () => {
        await run(
          `INSERT OR IGNORE INTO external_commit_journal
            (idempotencyKey, taskId, userId, toolName, inputDigest, state, replayResult, claimToken, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.idempotencyKey,
            entry.taskId,
            entry.userId,
            entry.toolName,
            entry.inputDigest,
            entry.state,
            entry.replayResult,
            entry.claimToken,
            entry.createdAt,
            entry.updatedAt,
          ],
        );
        const rows = await query<ExternalCommitJournalEntry>(
          'SELECT * FROM external_commit_journal WHERE idempotencyKey = ? LIMIT 1',
          [entry.idempotencyKey],
        );
        const persisted = rows[0];
        if (!persisted) throw new Error('External commit journal claim was not persisted.');
        return {
          claimed: persisted.claimToken === entry.claimToken,
          entry: persisted,
        };
      });
    },
    async settle(input) {
      return withDatabaseWriteLock(async () => {
        const claimClause = input.recoverExisting ? '' : ' AND claimToken = ?';
        const params: any[] = [
          input.state,
          input.replayResult,
          input.updatedAt,
          input.idempotencyKey,
        ];
        if (!input.recoverExisting) params.push(input.claimToken);
        await run(
          `UPDATE external_commit_journal
           SET state = ?, replayResult = ?, updatedAt = ?
           WHERE idempotencyKey = ?${claimClause}`,
          params,
        );
        const rows = await query<ExternalCommitJournalEntry>(
          'SELECT * FROM external_commit_journal WHERE idempotencyKey = ? LIMIT 1',
          [input.idempotencyKey],
        );
        return rows[0]?.state === input.state
          && rows[0]?.replayResult === input.replayResult;
      });
    },
  };
  configureExternalCommitJournal(adapter);
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

/** Table projections share one transaction; schema belongs to initialization/migrations. */
interface PersistenceTableSpec extends SnapshotProjection {
  insertSQL: string;
}

const STABLE_PERSISTENCE_TIMESTAMP = new Date(0).toISOString();

function persistenceTimestamp(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return STABLE_PERSISTENCE_TIMESTAMP;
}

function buildPersistenceTableSpecs(): PersistenceTableSpec[] {
  const specs: PersistenceTableSpec[] = [
    {
      name: 'users',
      insertSQL: `INSERT INTO users (uid, username, password, role, balance, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'users',
      *rows(items = memoryDB.users || []) { for (const u of items) { yield [u.uid, u.username, u.password, u.role, u.balance, u.phone || '', u.createdAt]; } },
    },
    {
      name: 'interactions',
      insertSQL: `INSERT INTO interactions (id, userId, agentId, module, message, response, role, personality, mode, toolCalls, conversationId, cognitiveIntent, llmWasCalled, completionFeedback, domain, orgId, source, channel, externalMessageId, routeSequence, receivedAt, requestId, nativeDeviceId, executionSessionId, nativeClientIdentitySha256, audioInputKind, syntheticAudio, captureSessionId, sttReceiptId, contextChainId, previousRequestId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'interactions',
      *rows(items = memoryDB.interactions || []) { for (const i of items) { yield [i.id, i.userId || 'unknown', i.agentId || null, i.personality || i.module || null, i.content || i.message || '', i.response || '', i.role || '', i.personality || '', i.mode || '', serializeStoredToolCalls(i.toolCalls, i.mode), i.conversationId || '', i.cognitiveIntent || '', i.llmWasCalled ? 1 : 0, serializeCompletionFeedbackForPersistence(i.completionFeedback), i.domain || 'personal', i.orgId || '', i.source || '', i.channel || '', i.externalMessageId || '', Number.isFinite(i.routeSequence) ? i.routeSequence : null, i.receivedAt || '', i.requestId || i.externalMessageId || '', i.nativeDeviceId || '', i.executionSessionId || '', i.nativeClientIdentitySha256 || '', i.audioInputKind || '', i.syntheticAudio === true ? 1 : i.syntheticAudio === false ? 0 : null, i.captureSessionId || '', i.sttReceiptId || '', i.contextChainId || '', i.previousRequestId || '', i.timestamp]; } },
    },
    {
      name: 'memories',
      insertSQL: `INSERT INTO memories (id, userId, type, content, keywords, confidence, sourceInteractionId, createdAt, updatedAt, lastRetrievedAt, retrieveCount, tier, perspective, importance, parentId, agentId, nodeType, location, domain, orgId, embedding, embeddingNamespace, embeddingContentHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'memories',
      *rows(items = memoryDB.memories || []) { for (const m of items) {
        const indexed = hasCurrentMemoryEmbedding(m);
        yield [m.id, m.userId, m.type, m.content, JSON.stringify(m.keywords || []), m.confidence || 0.5, m.sourceInteractionId || '', m.createdAt, m.updatedAt, m.lastRetrievedAt, m.retrieveCount || 0, m.tier || 'episodic', m.perspective || 'owner_trait', m.importance ?? 0.3, m.parentId || null, m.agentId || '', m.nodeType || 'leaf', m.location || '', m.domain || 'personal', m.orgId || '', indexed ? JSON.stringify(m.embedding) : null, indexed ? JSON.stringify(m.embeddingNamespace) : null, indexed ? m.embeddingContentHash : null];
      } },
    },
    {
      name: 'memory_avatars',
      insertSQL: `INSERT INTO memory_avatars (id, userId, name, relationshipType, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'memoryAvatars',
      *rows(items = memoryDB.memoryAvatars || []) { for (const avatar of items) { yield [
        avatar.id,
        avatar.userId,
        avatar.name || 'Memory',
        avatar.relationshipType || 'close_friend',
        avatar.status || 'active',
        JSON.stringify({
          ...(avatar.payload && typeof avatar.payload === 'object' ? avatar.payload : {}),
          personalityConfig: avatar.personalityConfig || avatar.payload?.personalityConfig || {},
          evidenceMap: Array.isArray(avatar.evidenceMap) ? avatar.evidenceMap : (avatar.payload?.evidenceMap || []),
          seedMemories: Array.isArray(avatar.seedMemories) ? avatar.seedMemories : (avatar.payload?.seedMemories || []),
          narrative: avatar.narrative || avatar.payload?.narrative || '',
          isFrozen: avatar.isFrozen !== false,
        }),
        persistenceTimestamp(avatar.createdAt),
        persistenceTimestamp(avatar.updatedAt, avatar.createdAt),
      ]; } },
    },
    {
      name: 'reminders',
      insertSQL: `INSERT INTO reminders (id, userId, content, dueAt, status, sourceInteractionId, createdAt, firedAt, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'reminders',
      *rows(items = memoryDB.reminders || []) { for (const r of items) { yield [r.id, r.userId, r.content, r.dueAt || null, r.status || 'pending', r.sourceInteractionId || '', r.createdAt, r.firedAt || null, r.domain || 'personal', r.orgId || '']; } },
    },
    {
      name: 'conversations',
      insertSQL: `INSERT INTO conversations (id, userId, agentId, title, status, summary, summaryChain, lastSummaryMessageCount, actionContinuationState, messageCount, lastActiveAt, createdAt, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'conversations',
      *rows(items = memoryDB.conversations || []) { for (const c of items) { yield [c.id, c.userId, c.agentId || '', c.title || '', c.status || 'active', c.summary || '', JSON.stringify(Array.isArray(c.summaryChain) ? c.summaryChain : []), Number.isFinite(Number(c.lastSummaryMessageCount)) ? Math.floor(Number(c.lastSummaryMessageCount)) : -1, serializeStoredActionContinuationState(legacyActionContinuationStates.get(c)), c.messageCount || 0, c.lastActiveAt, c.createdAt, c.domain || 'personal', c.orgId || '']; } },
    },
    {
      name: 'conversation_action_tasks',
      insertSQL: `INSERT INTO conversation_action_tasks (id, conversationId, userId, domain, orgId, parentTaskId, rootUserMessageId, intentKind, operation, goal, target, status, blocker, activeRequestId, completionSource, context, revision, createdAt, updatedAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'conversationActionTasks',
      *rows(items = memoryDB.conversationActionTasks || []) { for (const t of items) { yield [t.id, t.conversationId, t.userId, t.domain || 'personal', t.orgId || '', t.parentTaskId || '', t.rootUserMessageId || '', t.intentKind || 'none', t.operation || 'read', t.goal || '', t.target || '', t.status || 'planning', t.blocker || '', t.activeRequestId || '', t.completionSource || '', typeof t.context === 'string' ? t.context : JSON.stringify(t.context || {}), Number(t.revision) || 1, t.createdAt, t.updatedAt, t.completedAt || '']; } },
    },
    {
      name: 'conversation_action_turns',
      insertSQL: `INSERT INTO conversation_action_turns (id, conversationId, userId, domain, orgId, requestId, userMessageId, taskId, channel, source, status, leaseOwnerId, leaseEpoch, leaseAcquiredAt, leaseHeartbeatAt, leaseExpiresAt, terminalMessageId, terminalReason, recoveryReason, recoveredAt, revision, createdAt, updatedAt, terminalAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'conversationActionTurns',
      *rows(items = memoryDB.conversationActionTurns || []) { for (const turn of items) { yield [turn.id, turn.conversationId, turn.userId, turn.domain || 'personal', turn.orgId || '', turn.requestId || '', turn.userMessageId || '', turn.taskId || '', turn.channel || '', turn.source || '', turn.status || 'accepted', turn.leaseOwnerId || '', turn.leaseEpoch || '', turn.leaseAcquiredAt || '', turn.leaseHeartbeatAt || '', turn.leaseExpiresAt || '', turn.terminalMessageId || '', turn.terminalReason || '', turn.recoveryReason || '', turn.recoveredAt || '', Number(turn.revision) || 1, turn.createdAt, turn.updatedAt, turn.terminalAt || '']; } },
    },
    {
      name: 'conversation_action_receipts',
      insertSQL: `INSERT INTO conversation_action_receipts (id, taskId, conversationId, turnId, requestId, turnRowId, externalMessageId, modelRoutingReceiptId, executionOrigin, idempotencyKey, toolName, targetIdentity, inputDigest, envelope, outcome, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'conversationActionReceipts',
      *rows(items = memoryDB.conversationActionReceipts || []) { for (const r of items) { yield [r.id, r.taskId, r.conversationId, r.turnId || '', r.requestId || '', r.turnRowId || '', r.externalMessageId || '', r.modelRoutingReceiptId || '', r.executionOrigin || '', r.idempotencyKey || '', r.toolName || '', r.targetIdentity || '', r.inputDigest || '', typeof r.envelope === 'string' ? r.envelope : JSON.stringify(r.envelope || {}), r.outcome || 'failed', r.createdAt]; } },
    },
    {
      name: 'model_routing_receipts',
      insertSQL: `INSERT INTO model_routing_receipts (id, userId, domain, orgId, conversationId, requestId, nativeDeviceId, executionSessionId, nativeClientIdentitySha256, audioInputKind, syntheticAudio, captureSessionId, sttReceiptId, contextChainId, previousRequestId, interactionId, source, status, requestedProvider, requestedModel, selectionMode, selectedProvider, selectedModel, fallbackReason, attempts, startedAt, completedAt, durationMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'modelRoutingReceipts',
      *rows(items = memoryDB.modelRoutingReceipts || []) { for (const receipt of items) { yield [
        receipt.id,
        receipt.userId || 'anonymous',
        receipt.domain || 'personal',
        receipt.orgId || '',
        receipt.conversationId || '',
        receipt.requestId || '',
        receipt.nativeDeviceId || '',
        receipt.executionSessionId || '',
        receipt.nativeClientIdentitySha256 || '',
        receipt.audioInputKind || '',
        receipt.syntheticAudio === true ? 1 : receipt.syntheticAudio === false ? 0 : null,
        receipt.captureSessionId || '',
        receipt.sttReceiptId || '',
        receipt.contextChainId || '',
        receipt.previousRequestId || '',
        receipt.interactionId || '',
        receipt.source || '',
        receipt.status || 'failed',
        receipt.requestedProvider || '',
        receipt.requestedModel || '',
        receipt.selectionMode || 'pinned',
        receipt.selectedProvider || '',
        receipt.selectedModel || '',
        receipt.fallbackReason || '',
        JSON.stringify(Array.isArray(receipt.attempts) ? receipt.attempts : []),
        receipt.startedAt,
        receipt.completedAt,
        Number(receipt.durationMs) || 0,
      ]; } },
    },
    {
      name: 'read_only_tool_patterns',
      insertSQL: `INSERT INTO read_only_tool_patterns (id, userId, domain, orgId, confidence, successCount, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'readOnlyToolPatterns',
      *rows(items = memoryDB.readOnlyToolPatterns || []) { for (const pattern of items) { yield [
        pattern.id,
        pattern.userId,
        pattern.domain || 'personal',
        pattern.orgId || '',
        Number(pattern.confidence) || 0,
        Number(pattern.successCount) || 0,
        persistenceTimestamp(pattern.updatedAt, pattern.createdAt),
        JSON.stringify(pattern),
      ]; } },
    },
    {
      name: 'command_center_plans',
      insertSQL: `INSERT INTO command_center_plans (id, userId, domain, orgId, conversationId, kind, title, instruction, cadence, timeOfDay, dayOfWeek, dayOfMonth, status, nextRunAt, lastRunAt, lastRuntimeTaskId, createdAt, updatedAt, membershipAuthorization, authorizationBlockedReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'commandCenterPlans',
      *rows(items = memoryDB.commandCenterPlans || []) { for (const plan of items) { yield [
        plan.id,
        plan.userId,
        plan.domain || 'personal',
        plan.orgId || '',
        plan.conversationId || '',
        plan.kind || 'daily_task',
        plan.title || '',
        plan.instruction || '',
        plan.cadence || 'none',
        plan.timeOfDay || '09:00',
        Number(plan.dayOfWeek) || 0,
        Number(plan.dayOfMonth) || 1,
        plan.status || 'active',
        plan.nextRunAt || '',
        plan.lastRunAt || '',
        plan.lastRuntimeTaskId || '',
        plan.createdAt,
        plan.updatedAt,
        plan.membershipAuthorization ? JSON.stringify(plan.membershipAuthorization) : '',
        plan.authorizationBlockedReason || '',
      ]; } },
    },
    {
      name: 'autonomous_tasks',
      insertSQL: `INSERT INTO autonomous_tasks (id, userId, status, leaseExpiresAt, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      source: 'autonomousTasks',
      *rows(items = memoryDB.autonomousTasks || []) { for (const task of items) { yield [
        task.id,
        task.userId,
        task.status || 'pending',
        task.leaseExpiresAt || '',
        persistenceTimestamp(task.updatedAt, task.createdAt),
        JSON.stringify(task),
      ]; } },
    },
    {
      name: 'external_ai_history_sources',
      insertSQL: `INSERT INTO external_ai_history_sources (id, userId, domain, orgId, sourceKind, status, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'externalAiHistorySources',
      *rows(items = memoryDB.externalAiHistorySources || []) { for (const source of items) { yield [
        source.id,
        source.userId,
        source.domain || 'personal',
        source.orgId || '',
        source.sourceKind,
        source.status || 'active',
        persistenceTimestamp(source.updatedAt, source.createdAt),
        JSON.stringify(source),
      ]; } },
    },
    {
      name: 'external_ai_history_sync_jobs',
      insertSQL: `INSERT INTO external_ai_history_sync_jobs (id, sourceId, userId, status, nextCursor, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'externalAiHistorySyncJobs',
      *rows(items = memoryDB.externalAiHistorySyncJobs || []) { for (const job of items) { yield [
        job.id,
        job.sourceId,
        job.userId,
        job.status || 'pending',
        job.nextCursor || '',
        persistenceTimestamp(job.updatedAt, job.createdAt),
        JSON.stringify(job),
      ]; } },
    },
    {
      name: 'external_ai_history_conversations',
      insertSQL: `INSERT INTO external_ai_history_conversations (id, sourceId, userId, externalConversationId, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      source: 'externalAiHistoryConversations',
      *rows(items = memoryDB.externalAiHistoryConversations || []) { for (const conversation of items) { yield [
        conversation.id,
        conversation.sourceId,
        conversation.userId,
        conversation.externalConversationId,
        persistenceTimestamp(conversation.updatedAt, conversation.createdAt),
        JSON.stringify(conversation),
      ]; } },
    },
    {
      name: 'external_ai_history_messages',
      insertSQL: `INSERT INTO external_ai_history_messages (id, sourceId, conversationId, userId, externalMessageId, contentDigest, messageAt, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'externalAiHistoryMessages',
      *rows(items = memoryDB.externalAiHistoryMessages || []) { for (const message of items) { yield [
        message.id,
        message.sourceId,
        message.conversationId,
        message.userId,
        message.externalMessageId,
        message.contentDigest || '',
        message.messageAt || '',
        persistenceTimestamp(message.updatedAt, message.createdAt),
        JSON.stringify(message),
      ]; } },
    },
    {
      name: 'external_ai_history_attachments',
      insertSQL: `INSERT INTO external_ai_history_attachments (id, sourceId, messageId, userId, externalAttachmentId, contentDigest, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'externalAiHistoryAttachments',
      *rows(items = memoryDB.externalAiHistoryAttachments || []) { for (const attachment of items) { yield [
        attachment.id,
        attachment.sourceId,
        attachment.messageId,
        attachment.userId,
        attachment.externalAttachmentId,
        attachment.contentDigest || '',
        persistenceTimestamp(attachment.updatedAt, attachment.createdAt),
        JSON.stringify(attachment),
      ]; } },
    },
    {
      name: 'extension_publishers',
      insertSQL: `INSERT INTO extension_publishers (fingerprint, publisherId, status, updatedAt, payload) VALUES (?, ?, ?, ?, ?)`,
      source: 'extensionPublishers',
      *rows(items = memoryDB.extensionPublishers || []) { for (const publisher of items) { yield [
        publisher.fingerprint,
        publisher.publisherId,
        publisher.status || 'trusted',
        persistenceTimestamp(publisher.updatedAt, publisher.createdAt),
        JSON.stringify(publisher),
      ]; } },
    },
    {
      name: 'extension_revisions',
      insertSQL: `INSERT INTO extension_revisions (id, extensionId, userId, version, kind, status, manifestDigest, signerFingerprint, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'extensionRevisions',
      *rows(items = memoryDB.extensionRevisions || []) { for (const revision of items) { yield [
        revision.id,
        revision.extensionId,
        revision.userId,
        revision.version,
        revision.kind || 'plugin',
        revision.status || 'staged',
        revision.manifestDigest,
        revision.signerFingerprint,
        persistenceTimestamp(revision.updatedAt, revision.createdAt),
        JSON.stringify(revision),
      ]; } },
    },
    {
      name: 'extension_activation_receipts',
      insertSQL: `INSERT INTO extension_activation_receipts (id, extensionId, revisionId, status, createdAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      source: 'extensionActivationReceipts',
      *rows(items = memoryDB.extensionActivationReceipts || []) { for (const receipt of items) { yield [
        receipt.id,
        receipt.extensionId,
        receipt.revisionId,
        receipt.status || 'unknown',
        persistenceTimestamp(receipt.createdAt),
        JSON.stringify(receipt),
      ]; } },
    },
    {
      name: 'external_capability_packages',
      insertSQL: `INSERT INTO external_capability_packages (id, ownerUserId, capabilityId, version, status, packageDigest, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'externalCapabilityPackages',
      *rows(items = memoryDB.externalCapabilityPackages || []) { for (const capability of items) { yield [
        capability.id,
        capability.ownerUserId,
        capability.capabilityId,
        capability.version,
        capability.status || 'reviewed',
        capability.packageDigest,
        persistenceTimestamp(capability.updatedAt, capability.createdAt),
        JSON.stringify(capability),
      ]; } },
    },
    {
      name: 'external_capability_receipts',
      insertSQL: `INSERT INTO external_capability_receipts (id, packageRowId, ownerUserId, capabilityId, actionId, kind, status, createdAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'externalCapabilityReceipts',
      *rows(items = memoryDB.externalCapabilityReceipts || []) { for (const receipt of items) { yield [
        receipt.id,
        receipt.packageRowId,
        receipt.ownerUserId,
        receipt.capabilityId,
        receipt.actionId || '',
        receipt.kind,
        receipt.status || 'unknown',
        persistenceTimestamp(receipt.createdAt),
        JSON.stringify(receipt),
      ]; } },
    },
    {
      name: 'canvas_sessions',
      insertSQL: `INSERT INTO canvas_sessions (id, userId, title, cards, edges, taskText, status, domain, orgId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'canvas_sessions',
      *rows(items = memoryDB.canvas_sessions || []) { for (const s of items) { yield [s.id, s.userId, s.title || '', s.cards || '[]', s.edges || '[]', s.taskText || '', s.status || 'active', s.domain || 'personal', s.orgId || '', s.createdAt, s.updatedAt]; } },
    },
    {
      name: 'marketplace_skills',
      insertSQL: `INSERT INTO marketplace_skills (id, name, author, price, description, category) VALUES (?, ?, ?, ?, ?, ?)`,
      source: 'marketplaceSkills',
      *rows(items = memoryDB.marketplaceSkills || []) { for (const s of items) { yield [s.id, s.name, s.author, s.price, s.description, s.category]; } },
    },
    {
      name: 'skills',
      insertSQL: `INSERT INTO skills (id, name, description) VALUES (?, ?, ?)`,
      source: 'skills',
      *rows(items = memoryDB.skills || []) { for (const s of items) { yield [s.id, s.name, s.description]; } },
    },
    {
      name: 'settings',
      insertSQL: `INSERT INTO settings (key, value) VALUES (?, ?)`,
      source: 'settings',
      dependencies: ['systemFlags', 'systemSnapshots', ...Object.keys(DOCUMENT_COLLECTION_DEFAULTS)],
      extraRows: systemStateRows,
      rows: settingsRowsWithSystemState,
    },
    {
      name: 'voice_profiles',
      dependencies: ['voiceProfiles'],
      insertSQL: `INSERT INTO voice_profiles (userId, voiceId, name, provider, createdAt) VALUES (?, ?, ?, ?, ?)`,
      *rows() {
        for (const [userId, profiles] of Object.entries(memoryDB.voiceProfiles || {})) {
          for (const vp of profiles as any[]) yield [userId, vp.voiceId, vp.name, vp.provider, vp.createdAt];
        }
      },
    },
    {
      name: 'token_usage',
      insertSQL: `INSERT INTO token_usage (id, userId, provider, model, promptTokens, completionTokens, totalTokens, mode, interactionId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'tokenUsage',
      *rows(items = memoryDB.tokenUsage || []) { for (const u of items) { yield [u.id, u.userId, u.provider, u.model, u.promptTokens, u.completionTokens, u.totalTokens, u.mode || 'chat', u.interactionId || '', u.timestamp]; } },
    },
    {
      name: 'organizations',
      insertSQL: `INSERT INTO organizations (id, name, slug, ownerUid, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'organizations',
      *rows(items = memoryDB.organizations || []) { for (const o of items) { yield [o.id, o.name, o.slug, o.ownerUid, o.settings || '{}', o.createdAt, o.updatedAt]; } },
    },
    {
      name: 'departments',
      insertSQL: `INSERT INTO departments (id, orgId, name, parentId, createdAt) VALUES (?, ?, ?, ?, ?)`,
      source: 'departments',
      *rows(items = memoryDB.departments || []) { for (const d of items) { yield [d.id, d.orgId, d.name, d.parentId || null, d.createdAt]; } },
    },
    {
      name: 'org_memberships',
      insertSQL: `INSERT INTO org_memberships (id, orgId, userId, role, departmentId, status, invitedBy, joinedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgMemberships',
      *rows(items = memoryDB.orgMemberships || []) { for (const m of items) { yield [m.id, m.orgId, m.userId, m.role || 'member', m.departmentId || null, m.status || 'active', m.invitedBy || null, m.joinedAt || null, m.createdAt]; } },
    },
    {
      name: 'org_positions',
      insertSQL: `INSERT INTO org_positions (id, orgId, departmentId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgPositions',
      *rows(items = memoryDB.orgPositions || []) { for (const item of items) { yield [item.id, item.orgId, item.departmentId || null, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_work_routing_rules',
      insertSQL: `INSERT INTO org_work_routing_rules (id, orgId, enabled, priority, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgWorkRoutingRules',
      *rows(items = memoryDB.orgWorkRoutingRules || []) { for (const item of items) { yield [item.id, item.orgId, item.enabled === false ? 0 : 1, Number(item.priority) || 0, JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_work_items',
      insertSQL: `INSERT INTO org_work_items (id, orgId, idempotencyKey, requestId, source, requesterUserId, conversationId, taskId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgWorkItems',
      *rows(items = memoryDB.orgWorkItems || []) { for (const item of items) { yield [item.id, item.orgId, item.idempotencyKey, item.requestId, item.source, item.requesterUserId, item.conversationId || '', item.taskId || '', item.status, JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_work_approvals',
      insertSQL: `INSERT INTO org_work_approvals (id, orgId, workItemId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgWorkApprovals',
      *rows(items = memoryDB.orgWorkApprovals || []) { for (const item of items) { yield [item.id, item.orgId, item.workItemId, item.status, JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_work_handoffs',
      insertSQL: `INSERT INTO org_work_handoffs (id, orgId, workItemId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgWorkHandoffs',
      *rows(items = memoryDB.orgWorkHandoffs || []) { for (const item of items) { yield [item.id, item.orgId, item.workItemId, item.status, JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_resource_policies',
      insertSQL: `INSERT INTO org_resource_policies (id, orgId, resourceType, resourceId, classification, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgResourcePolicies',
      *rows(items = memoryDB.orgResourcePolicies || []) { for (const item of items) { yield [item.id, item.orgId, item.resourceType, item.resourceId, item.classification || 'organization', item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_resource_grants',
      insertSQL: `INSERT INTO org_resource_grants (id, orgId, resourceType, resourceId, subjectType, subjectId, effect, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgResourceGrants',
      *rows(items = memoryDB.orgResourceGrants || []) { for (const item of items) { yield [item.id, item.orgId, item.resourceType, item.resourceId, item.subjectType, item.subjectId, item.effect || 'allow', JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_credential_references',
      insertSQL: `INSERT INTO org_credential_references (id, orgId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      source: 'orgCredentialReferences',
      *rows(items = memoryDB.orgCredentialReferences || []) { for (const item of items) { yield [item.id, item.orgId, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_devices',
      insertSQL: `INSERT INTO org_devices (id, orgId, branchId, userId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgDevices',
      *rows(items = memoryDB.orgDevices || []) { for (const item of items) { yield [item.id, item.orgId, item.branchId, item.userId, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]; } },
    },
    {
      name: 'org_invitations',
      insertSQL: `INSERT INTO org_invitations (id, orgId, code, createdBy, role, departmentId, maxUses, useCount, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgInvitations',
      *rows(items = memoryDB.orgInvitations || []) { for (const inv of items) { yield [inv.id, inv.orgId, inv.code, inv.createdBy, inv.role || 'member', inv.departmentId || null, inv.maxUses || 0, inv.useCount || 0, inv.expiresAt || null, inv.createdAt]; } },
    },
    {
      name: 'org_kb_articles',
      insertSQL: `INSERT INTO org_kb_articles (id, orgId, title, content, category, tags, authorId, status, viewCount, createdAt, updatedAt, ingestionManifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgKbArticles',
      *rows(items = memoryDB.orgKbArticles || []) { for (const a of items) { yield [a.id, a.orgId, a.title, a.content, a.category || 'general', a.tags || '[]', a.authorId, a.status || 'published', a.viewCount || 0, a.createdAt, a.updatedAt, a.ingestionManifest || '{}']; } },
    },
    {
      name: 'org_kb_embeddings',
      insertSQL: `INSERT INTO org_kb_embeddings (id, articleId, chunkIndex, embedding, content, modelName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'orgKbEmbeddings',
      *rows(items = memoryDB.orgKbEmbeddings || []) { for (const e of items) { yield [e.id, e.articleId, e.chunkIndex, e.embedding, e.content, e.modelName || 'text-embedding-3-small', e.createdAt]; } },
    },
    {
      name: 'notifications',
      insertSQL: `INSERT INTO notifications (id, userId, type, title, message, read, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      source: 'notifications',
      *rows(items = memoryDB.notifications || []) { for (const n of items) { yield [n.id, n.userId, n.type || 'info', n.title || '', n.message || '', n.read ? 1 : 0, n.timestamp]; } },
    },
    {
      name: 'audit_log',
      insertSQL: `INSERT INTO audit_log (id, orgId, userId, action, resourceType, resourceId, details, ipAddress, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source: 'auditLog',
      *rows(items = memoryDB.auditLog || []) { for (const l of items) { yield [l.id, l.orgId, l.userId, l.action, l.resourceType, l.resourceId, l.details || '{}', l.ipAddress || null, l.userAgent || null, l.timestamp]; } },
    },
  ];

  // Special handling: founder_vision is a single row
  const founderSpec: PersistenceTableSpec = {
    name: 'founder_vision',
    dependencies: ['founderVision', 'founderVisionUpdatedAt'],
    insertSQL: `INSERT INTO founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
    rows: () => memoryDB.founderVision
      ? [[1, memoryDB.founderVision, persistenceTimestamp(memoryDB.founderVisionUpdatedAt)]]
      : [],
  };

  return [...specs, founderSpec];
}

function seedPersistenceTableDigests(): void {
  databaseSnapshots = new DatabaseSnapshots(memoryDB, buildPersistenceTableSpecs());
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
