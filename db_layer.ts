import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { getDataPath, getDataRoot } from './server/config/data_path';

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
migrateDataFromOldLocation();

const DB_PATH = getDataPath('lumi.db');

let db: sqlite3.Database | null = null;

const PERFORMANCE_INDEX_SQL = [
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
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_domain ON conversations(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user_domain ON canvas_sessions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_org ON canvas_sessions(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_memberships_user_status ON org_memberships(userId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_memberships_org_status ON org_memberships(orgId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_kb_articles_org_category ON org_kb_articles(orgId, category, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_kb_embeddings_article ON org_kb_embeddings(articleId)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_ts ON notifications(userId, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_org_ts ON audit_log(orgId, timestamp)`,
];
let memoryDB: any = null;
const SYSTEM_FLAGS_SETTING = '__lumi_system_flags';
const SYSTEM_SNAPSHOTS_SETTING = '__lumi_system_snapshots';

function parseJsonSetting<T>(settings: any[], key: string, fallback: T): T {
  const row = settings.find((s: any) => s.key === key);
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function settingsRowsWithSystemState(): any[][] {
  const settings = Array.isArray(memoryDB?.settings) ? memoryDB.settings : [];
  const rows = settings
    .filter((s: any) => s?.key !== SYSTEM_FLAGS_SETTING && s?.key !== SYSTEM_SNAPSHOTS_SETTING)
    .map((s: any) => [s.key, s.value]);

  if (memoryDB?.systemFlags && Object.keys(memoryDB.systemFlags).length > 0) {
    rows.push([SYSTEM_FLAGS_SETTING, JSON.stringify(memoryDB.systemFlags)]);
  }

  if (Array.isArray(memoryDB?.systemSnapshots) && memoryDB.systemSnapshots.length > 0) {
    rows.push([SYSTEM_SNAPSHOTS_SETTING, JSON.stringify(memoryDB.systemSnapshots.slice(-120))]);
  }

  return rows;
}

export async function initDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) { reject(err); return; }
      db!.run('PRAGMA foreign_keys = ON', async (err) => {
        if (err) { reject(err); return; }
        await createTables();
        await migrateSchema();
        await loadMemoryDB();
        resolve();
      });
    });
  });
}

function onAlter(err: Error | null) {
  if (
    err &&
    !err.message.includes('duplicate column name') &&
    !err.message.includes('already exists') &&
    !err.message.includes('no such table')
  ) {
    console.warn('[DB] Schema migration error:', err.message);
  }
}

// Add missing columns to existing tables (safe on old DB)
function migrateSchema(): Promise<void> {
  return new Promise((resolve) => {
    db!.serialize(() => {
    // Add 'phone' column to users if it doesn't exist (old DB lacks it)
    db!.run("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''", onAlter);
    // Add 'status' column to agents if it doesn't exist
    db!.run("ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'active'", onAlter);
    // Add 'role' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN role TEXT DEFAULT ''", onAlter);
    // Add 'personality' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN personality TEXT DEFAULT ''", onAlter);
    // Add 'mode' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN mode TEXT DEFAULT ''", onAlter);
    // Add 'toolCalls' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN toolCalls TEXT DEFAULT ''", onAlter);
    // Add 'conversationId' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN conversationId TEXT DEFAULT ''", onAlter);
    // Add agent framework columns
    db!.run("ALTER TABLE agents ADD COLUMN personalityId TEXT DEFAULT 'lumi'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN modelPreference TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN memoryScope TEXT DEFAULT 'shared'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN autonomyLevel TEXT DEFAULT 'reactive'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN runtimeConfig TEXT DEFAULT '{}'", onAlter);
    // Add runtime + externalCommand to agents
    db!.run("ALTER TABLE agents ADD COLUMN runtime TEXT DEFAULT 'internal'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN externalCommand TEXT DEFAULT ''", onAlter);
    // Add agentId to memories for agent-private memory
    db!.run("ALTER TABLE memories ADD COLUMN agentId TEXT DEFAULT ''", onAlter);
    // Add location to memories for spatial context
    db!.run("ALTER TABLE memories ADD COLUMN location TEXT DEFAULT ''", onAlter);
    // Org: domain + orgId for data classification
    db!.run("ALTER TABLE memories ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Add domain + orgId to conversations for personal/work isolation
    db!.run("ALTER TABLE conversations ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE conversations ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Canvas sessions: persisted workbench state with personal/work isolation
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
    )`, onAlter);
    db!.run("ALTER TABLE canvas_sessions ADD COLUMN edges TEXT NOT NULL DEFAULT '[]'", onAlter);
    db!.run("ALTER TABLE canvas_sessions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE canvas_sessions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Add memories table if it doesn't exist
    db!.run(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      sourceInteractionId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastRetrievedAt TEXT,
      retrieveCount INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'episodic',
      perspective TEXT NOT NULL DEFAULT 'owner_trait',
      importance REAL NOT NULL DEFAULT 0.3,
      parentId TEXT,
      agentId TEXT DEFAULT '',
      nodeType TEXT NOT NULL DEFAULT 'leaf',
      domain TEXT DEFAULT 'personal',
      orgId TEXT DEFAULT ''
    )`, onAlter);
    // Migrate: add new columns to existing memories table
    db!.run("ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN perspective TEXT NOT NULL DEFAULT 'owner_trait'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.3", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN parentId TEXT", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN nodeType TEXT NOT NULL DEFAULT 'leaf'", onAlter);
    // Add token_usage table if it doesn't exist
    db!.run(`CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      promptTokens INTEGER NOT NULL,
      completionTokens INTEGER NOT NULL,
      totalTokens INTEGER NOT NULL,
      mode TEXT DEFAULT 'chat',
      interactionId TEXT DEFAULT '',
      timestamp TEXT NOT NULL
    )`, onAlter);
    // Add cognitiveIntent and llmWasCalled columns to interactions
    db!.run("ALTER TABLE interactions ADD COLUMN cognitiveIntent TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN llmWasCalled INTEGER DEFAULT 0", onAlter);
    // Add reminders table if it doesn't exist
    db!.run(`CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      content TEXT NOT NULL,
      dueAt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sourceInteractionId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      firedAt TEXT
    )`, onAlter);
    // Indexes are recreated here and after every atomic table replacement.
    for (const sql of PERFORMANCE_INDEX_SQL) db!.run(sql, onAlter);
      db!.run('SELECT 1', () => resolve());
    });
  });
}

function createTables(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        balance REAL DEFAULT 0,
        phone TEXT DEFAULT '',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        config TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        userId TEXT,
        status TEXT DEFAULT 'active',
        personalityId TEXT DEFAULT 'lumi',
        modelPreference TEXT DEFAULT '',
        memoryScope TEXT DEFAULT 'shared',
        autonomyLevel TEXT DEFAULT 'reactive',
        runtimeConfig TEXT DEFAULT '{}',
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        module TEXT,
        message TEXT NOT NULL,
        response TEXT,
        role TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        mode TEXT DEFAULT '',
        toolCalls TEXT DEFAULT '',
        conversationId TEXT DEFAULT '',
        cognitiveIntent TEXT DEFAULT '',
        llmWasCalled INTEGER DEFAULT 0,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketplace_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        price REAL NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS founder_vision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        title TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        summary TEXT DEFAULT '',
        messageCount INTEGER DEFAULT 0,
        lastActiveAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS voice_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        voiceId TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        promptTokens INTEGER NOT NULL,
        completionTokens INTEGER NOT NULL,
        totalTokens INTEGER NOT NULL,
        mode TEXT DEFAULT 'chat',
        interactionId TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        ownerUid TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        name TEXT NOT NULL,
        parentId TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_memberships (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        departmentId TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        invitedBy TEXT,
        joinedAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(orgId, userId)
      );

      CREATE TABLE IF NOT EXISTS org_invitations (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        createdBy TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        departmentId TEXT,
        maxUses INTEGER DEFAULT 0,
        useCount INTEGER DEFAULT 0,
        expiresAt TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_kb_articles (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '[]',
        authorId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'published',
        viewCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_kb_embeddings (
        id TEXT PRIMARY KEY,
        articleId TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        content TEXT NOT NULL,
        modelName TEXT NOT NULL DEFAULT 'text-embedding-3-small',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_templates (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        config TEXT NOT NULL,
        icon TEXT DEFAULT 'Bot',
        version INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        authorId TEXT NOT NULL,
        reviewedBy TEXT,
        reviewComment TEXT,
        downloadCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        read INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        action TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        ipAddress TEXT,
        userAgent TEXT,
        timestamp TEXT NOT NULL
      );
    `;

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
  const tables = ['users', 'agents', 'interactions', 'marketplace_skills', 'skills', 'founder_vision'];
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
  const agentsRaw = await query<any>('SELECT * FROM agents');
  const interactionsRaw = await query<any>('SELECT * FROM interactions');
  const marketplaceSkills = await query<any>('SELECT * FROM marketplace_skills');
  const skills = await query<any>('SELECT * FROM skills');
  const founderVisionRow = await query<any>('SELECT content FROM founder_vision WHERE id = 1');
  const founderVision = founderVisionRow[0]?.content || '';

  // Load memories
  const memoriesRaw = await query<any>('SELECT * FROM memories');
  const memories = memoriesRaw.map((m: any) => ({
    ...m,
    keywords: m.keywords ? JSON.parse(m.keywords) : [],
  }));

  // Load reminders
  const remindersRaw = await query<any>('SELECT * FROM reminders');

  // Load conversations
  const conversationsRaw = await query<any>('SELECT * FROM conversations');
  const canvasSessionsRaw = await query<any>('SELECT * FROM canvas_sessions');

  // Load token usage
  const tokenUsageRaw = await query<any>('SELECT * FROM token_usage');

  // Load org tables
  const organizations = await query<any>('SELECT * FROM organizations');
  const departments = await query<any>('SELECT * FROM departments');
  const orgMemberships = await query<any>('SELECT * FROM org_memberships');
  const orgInvitations = await query<any>('SELECT * FROM org_invitations');
  const orgKbArticles = await query<any>('SELECT * FROM org_kb_articles');
  const orgKbEmbeddings = await query<any>('SELECT * FROM org_kb_embeddings');
  const agentTemplates = await query<any>('SELECT * FROM agent_templates');
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

  // Map old column names to the field names that server.ts expects
  const agents = agentsRaw.map((a: any) => ({
    ...a,
    ownerUid: a.userId || a.ownerUid,
    data: a.config || a.data || '{}',
    personalityId: a.personalityId || 'lumi',
    modelPreference: a.modelPreference || '',
    memoryScope: a.memoryScope || 'shared',
    autonomyLevel: a.autonomyLevel || 'reactive',
    runtimeConfig: a.runtimeConfig || '{}',
    domain: a.domain || 'personal',
    orgId: a.orgId || '',
  }));

  const interactions = interactionsRaw.map((i: any) => ({
    ...i,
    content: i.message || i.content || '',
    role: i.role || '',
    personality: i.personality || i.module || '',
    mode: i.mode || '',
    toolCalls: i.toolCalls ? JSON.parse(i.toolCalls) : undefined,
    conversationId: i.conversationId || '',
    cognitiveIntent: i.cognitiveIntent || '',
    llmWasCalled: i.llmWasCalled ? true : false,
    domain: i.domain || 'personal',
    orgId: i.orgId || '',
  }));

  memoryDB = {
    users,
    agents,
    interactions,
    marketplaceSkills,
    skills,
    founderVision,
    memories: (memories || []).map((m: any) => ({ ...m, domain: m.domain || 'personal', orgId: m.orgId || '' })),
    reminders: remindersRaw || [],
    conversations: (conversationsRaw || []).map((c: any) => ({ ...c, domain: c.domain || 'personal', orgId: c.orgId || '' })),
    canvas_sessions: (canvasSessionsRaw || []).map((s: any) => ({ ...s, edges: s.edges || '[]', domain: s.domain || 'personal', orgId: s.orgId || '' })),
    settings: settings || [],
    systemFlags: systemFlags || {},
    systemSnapshots: Array.isArray(systemSnapshots) ? systemSnapshots : [],
    voiceProfiles: voiceProfiles || {},
    tokenUsage: tokenUsageRaw || [],
    organizations: organizations || [],
    departments: departments || [],
    orgMemberships: orgMemberships || [],
    orgInvitations: orgInvitations || [],
    orgKbArticles: orgKbArticles || [],
    orgKbEmbeddings: orgKbEmbeddings || [],
    agentTemplates: agentTemplates || [],
    notifications: notifications || [],
    auditLog: auditLogEntries || [],
  };
}

function run(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db!.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve();
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

export function readDB(): any {
  if (!memoryDB) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return memoryDB;
}

// Prune old entries from memory + SQLite to prevent unbounded growth
export function pruneOldData(): void {
  if (!memoryDB || !db) return;
  const limits: Record<string, number> = { interactions: 20000, memories: 5000, tokenUsage: 5000 };
  const tableMap: Record<string, string> = { interactions: 'interactions', memories: 'memories', tokenUsage: 'token_usage' };
  for (const [key, max] of Object.entries(limits)) {
    const arr = memoryDB[key];
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
  dbDirty = true;
}

// Write lock to prevent concurrent SQLite transactions
let writeLock: Promise<void> = Promise.resolve();

let writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function writeDB(data: any): void {
  if (!db) {
    throw new Error('Database not initialized.');
  }
  memoryDB = data;
  dbDirty = true;

  // Debounce persistence: batch rapid writes into a single SQLite flush
  if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(() => {
    writeDebounceTimer = null;
    const previous = JSON.parse(JSON.stringify(memoryDB));
    const ready = writeLock.catch((err) => {
      console.error('[DB] Previous write failed:', err);
    });
    writeLock = ready
      .then(() => persistMemoryDB())
      .then(() => { dbDirty = false; })
      .catch((err) => {
        console.error('[DB] Failed to persist database:', err);
        memoryDB = previous;
      });
  }, 100);
}

/** Flush pending writes immediately — call before shutdown */
export async function flushDB(): Promise<void> {
  if (writeDebounceTimer) {
    clearTimeout(writeDebounceTimer);
    writeDebounceTimer = null;
  }
  try {
    await writeLock.catch((err) => {
      console.error('[DB] Previous write failed before flush:', err);
    });
    await persistMemoryDB();
    dbDirty = false;
  } catch (err) {
    console.error('[DB] flushDB failed:', err);
  }
}

let dbDirty = false;

export function isDbDirty(): boolean {
  return dbDirty;
}

/**
 * Persist all in-memory data to SQLite using an atomic write-via-temp-table pattern.
 * Data is written to temp tables first, then the original tables are atomically
 * replaced. If the process crashes mid-write, the original data is preserved.
 */
async function persistMemoryDB(): Promise<void> {
  // Table definitions: [tableName, createSQL (must match the schema), insertSQL, rowMapper]
  interface TableSpec {
    name: string;
    createSQL: string;
    insertSQL: string;
    rows: () => any[][];
  }

  const specs: TableSpec[] = [
    {
      name: 'users',
      createSQL: `CREATE TABLE _temp_users (uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'user', balance REAL DEFAULT 0, phone TEXT DEFAULT '', createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_users (uid, username, password, role, balance, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.users.map((u: any) => [u.uid, u.username, u.password, u.role, u.balance, u.phone || '', u.createdAt]),
    },
    {
      name: 'agents',
      createSQL: `CREATE TABLE _temp_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, config TEXT NOT NULL, createdAt TEXT NOT NULL, userId TEXT, status TEXT DEFAULT 'active', personalityId TEXT DEFAULT 'lumi', modelPreference TEXT DEFAULT '', memoryScope TEXT DEFAULT 'shared', autonomyLevel TEXT DEFAULT 'reactive', runtimeConfig TEXT DEFAULT '{}', runtime TEXT DEFAULT 'internal', externalCommand TEXT DEFAULT '', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_agents (id, name, category, config, createdAt, userId, status, personalityId, modelPreference, memoryScope, autonomyLevel, runtimeConfig, runtime, externalCommand, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.agents.map((a: any) => [a.id, a.name, a.category, a.data || a.config || '{}', a.createdAt, a.ownerUid || a.userId || null, a.status || 'active', a.personalityId || 'lumi', a.modelPreference || '', a.memoryScope || 'shared', a.autonomyLevel || 'reactive', a.runtimeConfig || '{}', a.runtime || 'internal', a.externalCommand || '', a.domain || 'personal', a.orgId || '']),
    },
    {
      name: 'interactions',
      createSQL: `CREATE TABLE _temp_interactions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, agentId TEXT, module TEXT, message TEXT NOT NULL, response TEXT, role TEXT DEFAULT '', personality TEXT DEFAULT '', mode TEXT DEFAULT '', toolCalls TEXT DEFAULT '', conversationId TEXT DEFAULT '', cognitiveIntent TEXT DEFAULT '', llmWasCalled INTEGER DEFAULT 0, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_interactions (id, userId, agentId, module, message, response, role, personality, mode, toolCalls, conversationId, cognitiveIntent, llmWasCalled, domain, orgId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.interactions.map((i: any) => [i.id, i.userId || 'unknown', i.agentId || null, i.personality || i.module || null, i.content || i.message || '', i.response || '', i.role || '', i.personality || '', i.mode || '', i.toolCalls ? JSON.stringify(i.toolCalls) : '', i.conversationId || '', i.cognitiveIntent || '', i.llmWasCalled ? 1 : 0, i.domain || 'personal', i.orgId || '', i.timestamp]),
    },
    {
      name: 'memories',
      createSQL: `CREATE TABLE _temp_memories (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0.5, sourceInteractionId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastRetrievedAt TEXT, retrieveCount INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'episodic', perspective TEXT NOT NULL DEFAULT 'owner_trait', importance REAL NOT NULL DEFAULT 0.3, parentId TEXT, agentId TEXT DEFAULT '', nodeType TEXT NOT NULL DEFAULT 'leaf', location TEXT DEFAULT '', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_memories (id, userId, type, content, keywords, confidence, sourceInteractionId, createdAt, updatedAt, lastRetrievedAt, retrieveCount, tier, perspective, importance, parentId, agentId, nodeType, location, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.memories || []).map((m: any) => [m.id, m.userId, m.type, m.content, JSON.stringify(m.keywords || []), m.confidence || 0.5, m.sourceInteractionId || '', m.createdAt, m.updatedAt, m.lastRetrievedAt, m.retrieveCount || 0, m.tier || 'episodic', m.perspective || 'owner_trait', m.importance ?? 0.3, m.parentId || null, m.agentId || '', m.nodeType || 'leaf', m.location || '', m.domain || 'personal', m.orgId || '']),
    },
    {
      name: 'reminders',
      createSQL: `CREATE TABLE _temp_reminders (id TEXT PRIMARY KEY, userId TEXT NOT NULL, content TEXT NOT NULL, dueAt TEXT, status TEXT NOT NULL DEFAULT 'pending', sourceInteractionId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, firedAt TEXT)`,
      insertSQL: `INSERT INTO _temp_reminders (id, userId, content, dueAt, status, sourceInteractionId, createdAt, firedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.reminders || []).map((r: any) => [r.id, r.userId, r.content, r.dueAt || null, r.status || 'pending', r.sourceInteractionId || '', r.createdAt, r.firedAt || null]),
    },
    {
      name: 'conversations',
      createSQL: `CREATE TABLE _temp_conversations (id TEXT PRIMARY KEY, userId TEXT NOT NULL, agentId TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'active', summary TEXT DEFAULT '', messageCount INTEGER DEFAULT 0, lastActiveAt TEXT NOT NULL, createdAt TEXT NOT NULL, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_conversations (id, userId, agentId, title, status, summary, messageCount, lastActiveAt, createdAt, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.conversations || []).map((c: any) => [c.id, c.userId, c.agentId || '', c.title || '', c.status || 'active', c.summary || '', c.messageCount || 0, c.lastActiveAt, c.createdAt, c.domain || 'personal', c.orgId || '']),
    },
    {
      name: 'canvas_sessions',
      createSQL: `CREATE TABLE _temp_canvas_sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', cards TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]', taskText TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_canvas_sessions (id, userId, title, cards, edges, taskText, status, domain, orgId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.canvas_sessions || []).map((s: any) => [s.id, s.userId, s.title || '', s.cards || '[]', s.edges || '[]', s.taskText || '', s.status || 'active', s.domain || 'personal', s.orgId || '', s.createdAt, s.updatedAt]),
    },
    {
      name: 'marketplace_skills',
      createSQL: `CREATE TABLE _temp_marketplace_skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, author TEXT NOT NULL, price REAL NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_marketplace_skills (id, name, author, price, description, category) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.marketplaceSkills.map((s: any) => [s.id, s.name, s.author, s.price, s.description, s.category]),
    },
    {
      name: 'skills',
      createSQL: `CREATE TABLE _temp_skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_skills (id, name, description) VALUES (?, ?, ?)`,
      rows: () => memoryDB.skills.map((s: any) => [s.id, s.name, s.description]),
    },
    {
      name: 'settings',
      createSQL: `CREATE TABLE _temp_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_settings (key, value) VALUES (?, ?)`,
      rows: settingsRowsWithSystemState,
    },
    {
      name: 'voice_profiles',
      createSQL: `CREATE TABLE _temp_voice_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, voiceId TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_voice_profiles (userId, voiceId, name, provider, createdAt) VALUES (?, ?, ?, ?, ?)`,
      rows: () => {
        const rows: any[][] = [];
        for (const [userId, profiles] of Object.entries(memoryDB.voiceProfiles || {})) {
          for (const vp of profiles as any[]) {
            rows.push([userId, vp.voiceId, vp.name, vp.provider, vp.createdAt]);
          }
        }
        return rows;
      },
    },
    {
      name: 'token_usage',
      createSQL: `CREATE TABLE _temp_token_usage (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, promptTokens INTEGER NOT NULL, completionTokens INTEGER NOT NULL, totalTokens INTEGER NOT NULL, mode TEXT DEFAULT 'chat', interactionId TEXT DEFAULT '', timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_token_usage (id, userId, provider, model, promptTokens, completionTokens, totalTokens, mode, interactionId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.tokenUsage || []).map((u: any) => [u.id, u.userId, u.provider, u.model, u.promptTokens, u.completionTokens, u.totalTokens, u.mode || 'chat', u.interactionId || '', u.timestamp]),
    },
    {
      name: 'organizations',
      createSQL: `CREATE TABLE _temp_organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, ownerUid TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_organizations (id, name, slug, ownerUid, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.organizations || []).map((o: any) => [o.id, o.name, o.slug, o.ownerUid, o.settings || '{}', o.createdAt, o.updatedAt]),
    },
    {
      name: 'departments',
      createSQL: `CREATE TABLE _temp_departments (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, name TEXT NOT NULL, parentId TEXT, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_departments (id, orgId, name, parentId, createdAt) VALUES (?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.departments || []).map((d: any) => [d.id, d.orgId, d.name, d.parentId || null, d.createdAt]),
    },
    {
      name: 'org_memberships',
      createSQL: `CREATE TABLE _temp_org_memberships (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', departmentId TEXT, status TEXT NOT NULL DEFAULT 'active', invitedBy TEXT, joinedAt TEXT, createdAt TEXT NOT NULL, UNIQUE(orgId, userId))`,
      insertSQL: `INSERT INTO _temp_org_memberships (id, orgId, userId, role, departmentId, status, invitedBy, joinedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgMemberships || []).map((m: any) => [m.id, m.orgId, m.userId, m.role || 'member', m.departmentId || null, m.status || 'active', m.invitedBy || null, m.joinedAt || null, m.createdAt]),
    },
    {
      name: 'org_invitations',
      createSQL: `CREATE TABLE _temp_org_invitations (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, code TEXT UNIQUE NOT NULL, createdBy TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', departmentId TEXT, maxUses INTEGER DEFAULT 0, useCount INTEGER DEFAULT 0, expiresAt TEXT, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_invitations (id, orgId, code, createdBy, role, departmentId, maxUses, useCount, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgInvitations || []).map((inv: any) => [inv.id, inv.orgId, inv.code, inv.createdBy, inv.role || 'member', inv.departmentId || null, inv.maxUses || 0, inv.useCount || 0, inv.expiresAt || null, inv.createdAt]),
    },
    {
      name: 'org_kb_articles',
      createSQL: `CREATE TABLE _temp_org_kb_articles (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT DEFAULT 'general', tags TEXT DEFAULT '[]', authorId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', viewCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_kb_articles (id, orgId, title, content, category, tags, authorId, status, viewCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgKbArticles || []).map((a: any) => [a.id, a.orgId, a.title, a.content, a.category || 'general', a.tags || '[]', a.authorId, a.status || 'published', a.viewCount || 0, a.createdAt, a.updatedAt]),
    },
    {
      name: 'org_kb_embeddings',
      createSQL: `CREATE TABLE _temp_org_kb_embeddings (id TEXT PRIMARY KEY, articleId TEXT NOT NULL, chunkIndex INTEGER NOT NULL, embedding TEXT NOT NULL, content TEXT NOT NULL, modelName TEXT NOT NULL DEFAULT 'text-embedding-3-small', createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_kb_embeddings (id, articleId, chunkIndex, embedding, content, modelName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgKbEmbeddings || []).map((e: any) => [e.id, e.articleId, e.chunkIndex, e.embedding, e.content, e.modelName || 'text-embedding-3-small', e.createdAt]),
    },
    {
      name: 'agent_templates',
      createSQL: `CREATE TABLE _temp_agent_templates (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, config TEXT NOT NULL, icon TEXT DEFAULT 'Bot', version INTEGER DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', authorId TEXT NOT NULL, reviewedBy TEXT, reviewComment TEXT, downloadCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_agent_templates (id, orgId, name, description, category, config, icon, version, status, authorId, reviewedBy, reviewComment, downloadCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.agentTemplates || []).map((t: any) => [t.id, t.orgId, t.name, t.description, t.category, t.config, t.icon || 'Bot', t.version || 1, t.status || 'draft', t.authorId, t.reviewedBy || null, t.reviewComment || null, t.downloadCount || 0, t.createdAt, t.updatedAt]),
    },
    {
      name: 'notifications',
      createSQL: `CREATE TABLE _temp_notifications (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL)`,
      insertSQL: `INSERT INTO _temp_notifications (id, userId, type, title, message, read, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.notifications || []).map((n: any) => [n.id, n.userId, n.type || 'info', n.title || '', n.message || '', n.read ? 1 : 0, n.timestamp]),
    },
    {
      name: 'audit_log',
      createSQL: `CREATE TABLE _temp_audit_log (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, userId TEXT NOT NULL, action TEXT NOT NULL, resourceType TEXT NOT NULL, resourceId TEXT NOT NULL, details TEXT DEFAULT '{}', ipAddress TEXT, userAgent TEXT, timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_audit_log (id, orgId, userId, action, resourceType, resourceId, details, ipAddress, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.auditLog || []).map((l: any) => [l.id, l.orgId, l.userId, l.action, l.resourceType, l.resourceId, l.details || '{}', l.ipAddress || null, l.userAgent || null, l.timestamp]),
    },
  ];

  // Special handling: founder_vision is a single row
  const founderSpec: TableSpec = {
    name: 'founder_vision',
    createSQL: `CREATE TABLE _temp_founder_vision (id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
    insertSQL: `INSERT INTO _temp_founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
    rows: () => memoryDB.founderVision ? [[1, memoryDB.founderVision, new Date().toISOString()]] : [],
  };

  const allSpecs = [...specs, founderSpec];

  await run('BEGIN TRANSACTION');
  try {
    // Phase 1: Create temp tables and populate them
    for (const spec of allSpecs) {
      await run(`DROP TABLE IF EXISTS _temp_${spec.name}`);
      await run(spec.createSQL);
      for (const row of spec.rows()) {
        await run(spec.insertSQL, row);
      }
    }

    // Phase 2: Drop original tables
    for (const spec of allSpecs) {
      await run(`DROP TABLE IF EXISTS ${spec.name}`);
    }

    // Phase 3: Rename temp tables to original names (atomic in SQLite within a transaction)
    for (const spec of allSpecs) {
      await run(`ALTER TABLE _temp_${spec.name} RENAME TO ${spec.name}`);
    }

    // Replacing tables drops their indexes. Recreate all query indexes in the
    // same transaction so no persisted snapshot is left unindexed.
    for (const sql of PERFORMANCE_INDEX_SQL) {
      await run(sql);
    }

    await run('COMMIT');
  } catch (err) {
    // On failure, clean up temp tables and rollback
    try {
      for (const spec of allSpecs) {
        await run(`DROP TABLE IF EXISTS _temp_${spec.name}`);
      }
    } catch {}
    await run('ROLLBACK');
    throw err;
  }
}

let initPromise: Promise<void> | null = null;
export function ensureDatabaseInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = initDatabase();
  }
  return initPromise;
}

export async function querySQL<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return query<T>(sql, params);
}

export async function runSQL(sql: string, params: any[] = []): Promise<void> {
  return run(sql, params);
}
