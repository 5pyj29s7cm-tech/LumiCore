import { getBootstrapMarketplaceSkills, BOOTSTRAP_FOUNDER_VISION } from '../regions/resources/bootstrap_seeds';
import type sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { INITIAL_SCHEMA_SQL } from './initial_schema';
import type { DatabaseSqlWriteSession } from './sql_session';
import { assertSafeSqliteDataPath, getDataPath, getDataRoot, hasExplicitDataRoot } from '../config/data_path';
import { prepareRuntimeDataRoot } from '../runtime/data_root_preflight';

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
export function prepareDatabaseRuntime(): string {
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

/**
 * Retire the old local Agent/team persistence without erasing the one
 * user-facing capability that used to be stored in that table: Memory
 * Avatars.  The migration is deliberately explicit and fail-closed: legacy
 * rows are copied first, and only then are the team-runtime tables removed.
 */
export async function migrateRetiredLocalAgentTables({ query, run }: DatabaseSqlWriteSession): Promise<void> {
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

export function createTables(db: sqlite3.Database, session: DatabaseSqlWriteSession): Promise<void> {
  return new Promise((resolve, reject) => {
    // One checked schema operation owns every initial table creation.
    const sql = `CREATE TABLE IF NOT EXISTS canvas_sessions (
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
    );
    ${INITIAL_SCHEMA_SQL}`;

    db.exec(sql, (err) => {
      if (err) { reject(err); return; }
      insertInitialData(session).then(resolve).catch(reject);
    });
  });
}

async function insertInitialData({ query, run }: DatabaseSqlWriteSession): Promise<void> {
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
    const defaultSkills = getBootstrapMarketplaceSkills();
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
      [1, BOOTSTRAP_FOUNDER_VISION, new Date().toISOString()]
    );
  }
}
