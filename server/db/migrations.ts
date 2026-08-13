// Versioned database migrations — replaces the old silently-failing ALTER TABLE approach
import sqlite3 from 'sqlite3';

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, description: 'Add phone to users', sql: `ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''` },
  { version: 2, description: 'Add status to agents', sql: `ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'active'` },
  { version: 3, description: 'Add role to interactions', sql: `ALTER TABLE interactions ADD COLUMN role TEXT DEFAULT ''` },
  { version: 4, description: 'Add personality to interactions', sql: `ALTER TABLE interactions ADD COLUMN personality TEXT DEFAULT ''` },
  { version: 5, description: 'Add mode to interactions', sql: `ALTER TABLE interactions ADD COLUMN mode TEXT DEFAULT ''` },
  { version: 6, description: 'Add toolCalls to interactions', sql: `ALTER TABLE interactions ADD COLUMN toolCalls TEXT DEFAULT ''` },
  { version: 7, description: 'Add conversationId to interactions', sql: `ALTER TABLE interactions ADD COLUMN conversationId TEXT DEFAULT ''` },
  { version: 8, description: 'Add agent framework columns', sql: `ALTER TABLE agents ADD COLUMN personalityId TEXT DEFAULT 'lumi'` },
  { version: 9, description: 'Add modelPreference to agents', sql: `ALTER TABLE agents ADD COLUMN modelPreference TEXT DEFAULT ''` },
  { version: 10, description: 'Add memoryScope to agents', sql: `ALTER TABLE agents ADD COLUMN memoryScope TEXT DEFAULT 'shared'` },
  { version: 11, description: 'Add autonomyLevel to agents', sql: `ALTER TABLE agents ADD COLUMN autonomyLevel TEXT DEFAULT 'reactive'` },
  { version: 12, description: 'Add runtimeConfig to agents', sql: `ALTER TABLE agents ADD COLUMN runtimeConfig TEXT DEFAULT '{}'` },
  { version: 13, description: 'Add agentId to memories', sql: `ALTER TABLE memories ADD COLUMN agentId TEXT DEFAULT ''` },
  { version: 14, description: 'Add location to memories', sql: `ALTER TABLE memories ADD COLUMN location TEXT DEFAULT ''` },
  { version: 15, description: 'Add domain to memories', sql: `ALTER TABLE memories ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 16, description: 'Add orgId to memories', sql: `ALTER TABLE memories ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 17, description: 'Add domain to interactions', sql: `ALTER TABLE interactions ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 18, description: 'Add orgId to interactions', sql: `ALTER TABLE interactions ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 19, description: 'Add domain to agents', sql: `ALTER TABLE agents ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 20, description: 'Add orgId to agents', sql: `ALTER TABLE agents ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 21, description: 'Create memories table', sql: `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0.5,
    sourceInteractionId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    lastRetrievedAt TEXT, retrieveCount INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'episodic', perspective TEXT NOT NULL DEFAULT 'owner_trait',
    importance REAL NOT NULL DEFAULT 0.3, parentId TEXT, agentId TEXT DEFAULT '',
    nodeType TEXT NOT NULL DEFAULT 'leaf', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT ''
  )` },
  { version: 22, description: 'Add tier to memories', sql: `ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'` },
  { version: 23, description: 'Add perspective to memories', sql: `ALTER TABLE memories ADD COLUMN perspective TEXT NOT NULL DEFAULT 'owner_trait'` },
  { version: 24, description: 'Add importance to memories', sql: `ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.3` },
  { version: 25, description: 'Add parentId to memories', sql: `ALTER TABLE memories ADD COLUMN parentId TEXT` },
  { version: 26, description: 'Add nodeType to memories', sql: `ALTER TABLE memories ADD COLUMN nodeType TEXT NOT NULL DEFAULT 'leaf'` },
  { version: 27, description: 'Create token_usage table', sql: `CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    promptTokens INTEGER NOT NULL, completionTokens INTEGER NOT NULL, totalTokens INTEGER NOT NULL,
    mode TEXT DEFAULT 'chat', interactionId TEXT DEFAULT '', timestamp TEXT NOT NULL
  )` },
  { version: 28, description: 'Add cognitiveIntent to interactions', sql: `ALTER TABLE interactions ADD COLUMN cognitiveIntent TEXT DEFAULT ''` },
  { version: 29, description: 'Add llmWasCalled to interactions', sql: `ALTER TABLE interactions ADD COLUMN llmWasCalled INTEGER DEFAULT 0` },
  { version: 31, description: 'Create contacts table', sql: `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL,
    relationship TEXT DEFAULT 'other', tags TEXT DEFAULT '[]',
    notes TEXT DEFAULT '', traits TEXT DEFAULT '', preferences TEXT DEFAULT '',
    lastContacted TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )` },
  { version: 30, description: 'Create reminders table', sql: `CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, content TEXT NOT NULL, dueAt TEXT,
    status TEXT NOT NULL DEFAULT 'pending', sourceInteractionId TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL, firedAt TEXT
  )` },
  { version: 32, description: 'Create canvas_sessions table', sql: `CREATE TABLE IF NOT EXISTS canvas_sessions (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    cards TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]',
    taskText TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )` },
  { version: 33, description: 'Add edges to canvas_sessions', sql: `ALTER TABLE canvas_sessions ADD COLUMN edges TEXT NOT NULL DEFAULT '[]'` },
  { version: 34, description: 'Add domain to canvas_sessions', sql: `ALTER TABLE canvas_sessions ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 35, description: 'Add orgId to canvas_sessions', sql: `ALTER TABLE canvas_sessions ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 36, description: 'Add verifiable ingestion manifest to organization knowledge articles', sql: `ALTER TABLE org_kb_articles ADD COLUMN ingestionManifest TEXT NOT NULL DEFAULT '{}'` },
  { version: 37, description: 'Create command center plans', sql: `CREATE TABLE IF NOT EXISTS command_center_plans (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'personal',
    orgId TEXT NOT NULL DEFAULT '', conversationId TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL,
    cadence TEXT NOT NULL DEFAULT 'none', timeOfDay TEXT NOT NULL DEFAULT '09:00',
    dayOfWeek INTEGER NOT NULL DEFAULT 1, dayOfMonth INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active', nextRunAt TEXT NOT NULL DEFAULT '',
    lastRunAt TEXT NOT NULL DEFAULT '', lastRuntimeTaskId TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )` },
];

// Indexes are safe to create repeatedly
export const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_interactions_user_conv ON interactions(userId, conversationId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_type_tier ON memories(userId, type, tier)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(userId, agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_parent ON memories(userId, parentId)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_status ON conversations(userId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_user_ts ON token_usage(userId, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_domain ON memories(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_user_domain ON interactions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_org ON interactions(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_user_domain ON agents(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user ON canvas_sessions(userId)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user_domain ON canvas_sessions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_org ON canvas_sessions(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_command_center_plans_scope_status ON command_center_plans(userId, domain, orgId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_command_center_plans_due ON command_center_plans(status, nextRunAt)`,
];

export function runMigrations(db: sqlite3.Database): Promise<number[]> {
  return new Promise((resolve) => {
    // Create version table
    db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`, () => {
      db.get(`SELECT MAX(version) as current FROM schema_version`, (err, row: any) => {
        const current = row?.current || 0;
        const pending = MIGRATIONS.filter(m => m.version > current);
        const applied: number[] = [];

        if (pending.length === 0) {
          resolve(applied);
          return;
        }

        function applyNext(i: number) {
          if (i >= pending.length) { resolve(applied); return; }
          const m = pending[i];
          db.run(m.sql, (err) => {
            if (err) {
              // Column/table already exists — record version anyway to avoid re-running
              if (err.message?.includes('duplicate column') || err.message?.includes('already exists')) {
                db.run(`INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)`, [m.version, new Date().toISOString()], () => {
                  applyNext(i + 1);
                });
              } else {
                console.error(`[Migration v${m.version}] ${m.description} FAILED:`, err.message);
                applyNext(i + 1);
              }
            } else {
              db.run(`INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)`, [m.version, new Date().toISOString()], () => {
                applied.push(m.version);
                console.log(`[Migration v${m.version}] ${m.description}`);
                applyNext(i + 1);
              });
            }
          });
        }
        applyNext(0);
      });
    });
  });
}

export function createIndexes(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => {
    function applyNext(i: number) {
      if (i >= INDEXES.length) { resolve(); return; }
      db.run(INDEXES[i], () => applyNext(i + 1));
    }
    applyNext(0);
  });
}
