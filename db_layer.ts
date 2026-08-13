import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDataPath, getDataRoot } from './server/config/data_path';
import { isolateLegacyGuardSummaryState } from './server/conversation/guard_history';
import {
  configureExternalCommitJournal,
  type ExternalCommitJournalAdapter,
  type ExternalCommitJournalEntry,
} from './server/tools/external_commit_journal';

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
  `CREATE INDEX IF NOT EXISTS idx_action_tasks_conversation_updated ON conversation_action_tasks(conversationId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_action_tasks_user_status ON conversation_action_tasks(userId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_action_receipts_task_created ON conversation_action_receipts(taskId, createdAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_receipts_idempotency ON conversation_action_receipts(taskId, idempotencyKey, toolName, outcome)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_user_completed ON model_routing_receipts(userId, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_conversation_completed ON model_routing_receipts(conversationId, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_request ON model_routing_receipts(requestId)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_selected ON model_routing_receipts(selectedProvider, selectedModel, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_read_only_tool_patterns_scope ON read_only_tool_patterns(userId, domain, orgId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_background_tasks_user_status ON background_delegation_tasks(userId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_background_tasks_lease ON background_delegation_tasks(status, leaseExpiresAt)`,
  `CREATE INDEX IF NOT EXISTS idx_command_center_plans_scope_status ON command_center_plans(userId, domain, orgId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_command_center_plans_due ON command_center_plans(status, nextRunAt)`,
  `CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_user_status ON autonomous_tasks(userId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_lease ON autonomous_tasks(status, leaseExpiresAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_commit_journal_task ON external_commit_journal(taskId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_sessions_user_updated ON external_ai_sessions(userId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_sessions_task ON external_ai_sessions(taskId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_dispatches_session_status ON external_ai_dispatches(sessionId, status, updatedAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_ai_dispatches_idempotency ON external_ai_dispatches(idempotencyKey)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_answers_session_received ON external_ai_answers(sessionId, receivedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_history_sources_user_status ON external_ai_history_sources(userId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_history_sources_scope ON external_ai_history_sources(userId, domain, orgId, sourceKind)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_history_jobs_source_status ON external_ai_history_sync_jobs(sourceId, status, updatedAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_ai_history_conversations_identity ON external_ai_history_conversations(sourceId, externalConversationId)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_history_conversations_user_updated ON external_ai_history_conversations(userId, updatedAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_ai_history_messages_identity ON external_ai_history_messages(sourceId, externalMessageId)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_history_messages_conversation_time ON external_ai_history_messages(conversationId, messageAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_ai_history_attachments_identity ON external_ai_history_attachments(sourceId, externalAttachmentId)`,
  `CREATE INDEX IF NOT EXISTS idx_external_ai_history_attachments_message ON external_ai_history_attachments(messageId, updatedAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_revisions_identity ON extension_revisions(extensionId, version)`,
  `CREATE INDEX IF NOT EXISTS idx_extension_revisions_active ON extension_revisions(extensionId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_extension_publishers_status ON extension_publishers(status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_extension_receipts_extension_created ON extension_activation_receipts(extensionId, createdAt)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user_domain ON canvas_sessions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_org ON canvas_sessions(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_memberships_user_status ON org_memberships(userId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_memberships_org_status ON org_memberships(orgId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_positions_org_status ON org_positions(orgId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_work_rules_org_enabled ON org_work_routing_rules(orgId, enabled, priority)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_org_work_items_idempotency ON org_work_items(orgId, idempotencyKey)`,
  `CREATE INDEX IF NOT EXISTS idx_org_work_items_org_status ON org_work_items(orgId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_org_work_items_task ON org_work_items(orgId, taskId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_work_approvals_org_status ON org_work_approvals(orgId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_org_work_approvals_item ON org_work_approvals(orgId, workItemId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_work_handoffs_item ON org_work_handoffs(orgId, workItemId, updatedAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_org_resource_policy_identity ON org_resource_policies(orgId, resourceType, resourceId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_resource_policies_scope ON org_resource_policies(orgId, resourceType, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_resource_grants_resource ON org_resource_grants(orgId, resourceType, resourceId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_resource_grants_subject ON org_resource_grants(orgId, subjectType, subjectId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_credential_references_org_status ON org_credential_references(orgId, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_org_devices_branch ON org_devices(branchId)`,
  `CREATE INDEX IF NOT EXISTS idx_org_devices_org_status ON org_devices(orgId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_org_kb_articles_org_category ON org_kb_articles(orgId, category, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_kb_embeddings_article ON org_kb_embeddings(articleId)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_ts ON notifications(userId, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_org_ts ON audit_log(orgId, timestamp)`,
];
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

function parseStoredToolCalls(value: unknown): any[] | undefined {
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

function serializeStoredToolCalls(value: unknown): string {
  const records = parseStoredToolCalls(value);
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

function parseJsonArrayValue(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

export function initDatabase(): Promise<void> {
  if (db && memoryDB) return Promise.resolve();
  if (initPromise) return initPromise;
  const pending = new Promise<void>((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) { reject(err); return; }
      // Runtime services and parallel diagnostics can briefly overlap on the
      // same local database. Wait for the active writer instead of surfacing a
      // transient SQLITE_BUSY failure to the client or test harness.
      db!.configure('busyTimeout', 5000);
      db!.run('PRAGMA foreign_keys = ON', async (err) => {
        if (err) { reject(err); return; }
        try {
          await createTables();
          await migrateSchema();
          await loadMemoryDB();
          resolve();
        } catch (error) {
          // sqlite callbacks do not observe rejected async callback promises.
          // Always settle the outer initialization promise instead of leaving
          // callers hanging until their own timeout with an unhandled rejection.
          reject(error);
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
    db!.run("ALTER TABLE agents ADD COLUMN skillTags TEXT NOT NULL DEFAULT '[]'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN knowledgeDomains TEXT NOT NULL DEFAULT '[]'", onAlter);
    // Add agentId to memories for agent-private memory
    db!.run("ALTER TABLE memories ADD COLUMN agentId TEXT DEFAULT ''", onAlter);
    // Add location to memories for spatial context
    db!.run("ALTER TABLE memories ADD COLUMN location TEXT DEFAULT ''", onAlter);
    // Org: domain + orgId for data classification
    db!.run("ALTER TABLE memories ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN source TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN channel TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN externalMessageId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN routeSequence INTEGER", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN receivedAt TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Add domain + orgId to conversations for personal/work isolation
    db!.run("ALTER TABLE conversations ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE conversations ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Durable auto-summary cadence and bounded summary history. -1 marks rows
    // created before this migration so the manager can infer a safe baseline.
    db!.run("ALTER TABLE conversations ADD COLUMN summaryChain TEXT DEFAULT '[]'", onAlter);
    db!.run("ALTER TABLE conversations ADD COLUMN lastSummaryMessageCount INTEGER DEFAULT -1", onAlter);
    db!.run("ALTER TABLE conversations ADD COLUMN actionContinuationState TEXT DEFAULT '{}'", onAlter);
    db!.run("ALTER TABLE conversation_action_tasks ADD COLUMN context TEXT NOT NULL DEFAULT '{}'", onAlter);
    db!.run("ALTER TABLE model_routing_receipts ADD COLUMN conversationId TEXT NOT NULL DEFAULT ''", onAlter);
    db!.run("ALTER TABLE model_routing_receipts ADD COLUMN requestId TEXT NOT NULL DEFAULT ''", onAlter);
    db!.run("ALTER TABLE model_routing_receipts ADD COLUMN interactionId TEXT NOT NULL DEFAULT ''", onAlter);
    db!.run("ALTER TABLE model_routing_receipts ADD COLUMN source TEXT NOT NULL DEFAULT ''", onAlter);
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
    db!.run("ALTER TABLE org_kb_articles ADD COLUMN ingestionManifest TEXT NOT NULL DEFAULT '{}'", onAlter);
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
        runtime TEXT DEFAULT 'internal',
        externalCommand TEXT DEFAULT '',
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT '',
        skillTags TEXT NOT NULL DEFAULT '[]',
        knowledgeDomains TEXT NOT NULL DEFAULT '[]'
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
        source TEXT DEFAULT '',
        channel TEXT DEFAULT '',
        externalMessageId TEXT DEFAULT '',
        routeSequence INTEGER,
        receivedAt TEXT DEFAULT '',
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
        summaryChain TEXT DEFAULT '[]',
        lastSummaryMessageCount INTEGER DEFAULT -1,
        actionContinuationState TEXT DEFAULT '{}',
        messageCount INTEGER DEFAULT 0,
        lastActiveAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS conversation_action_tasks (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        userId TEXT NOT NULL,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT '',
        parentTaskId TEXT DEFAULT '',
        rootUserMessageId TEXT DEFAULT '',
        intentKind TEXT NOT NULL DEFAULT 'none',
        operation TEXT NOT NULL DEFAULT 'read',
        goal TEXT NOT NULL,
        target TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planning',
        blocker TEXT DEFAULT '',
        activeRequestId TEXT DEFAULT '',
        completionSource TEXT DEFAULT '',
        context TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS conversation_action_receipts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        turnId TEXT DEFAULT '',
        requestId TEXT DEFAULT '',
        idempotencyKey TEXT NOT NULL,
        toolName TEXT NOT NULL,
        targetIdentity TEXT DEFAULT '',
        inputDigest TEXT DEFAULT '',
        envelope TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_routing_receipts (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        conversationId TEXT NOT NULL DEFAULT '',
        requestId TEXT NOT NULL DEFAULT '',
        interactionId TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        requestedProvider TEXT NOT NULL,
        requestedModel TEXT NOT NULL,
        selectionMode TEXT NOT NULL,
        selectedProvider TEXT NOT NULL DEFAULT '',
        selectedModel TEXT NOT NULL DEFAULT '',
        fallbackReason TEXT NOT NULL DEFAULT '',
        attempts TEXT NOT NULL DEFAULT '[]',
        startedAt TEXT NOT NULL,
        completedAt TEXT NOT NULL,
        durationMs INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS read_only_tool_patterns (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        successCount INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS background_delegation_tasks (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        status TEXT NOT NULL,
        leaseExpiresAt TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS command_center_plans (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        conversationId TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        cadence TEXT NOT NULL DEFAULT 'none',
        timeOfDay TEXT NOT NULL DEFAULT '09:00',
        dayOfWeek INTEGER NOT NULL DEFAULT 1,
        dayOfMonth INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        nextRunAt TEXT NOT NULL DEFAULT '',
        lastRunAt TEXT NOT NULL DEFAULT '',
        lastRuntimeTaskId TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS autonomous_tasks (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        status TEXT NOT NULL,
        leaseExpiresAt TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_commit_journal (
        idempotencyKey TEXT PRIMARY KEY,
        taskId TEXT DEFAULT '',
        userId TEXT DEFAULT '',
        toolName TEXT NOT NULL,
        inputDigest TEXT NOT NULL,
        state TEXT NOT NULL,
        replayResult TEXT NOT NULL DEFAULT '',
        claimToken TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_ai_sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        taskId TEXT NOT NULL DEFAULT '',
        conversationId TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_dispatches (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        userId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        status TEXT NOT NULL,
        routeKind TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL UNIQUE,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_answers (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        dispatchId TEXT NOT NULL,
        userId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        receivedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_sources (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        sourceKind TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_sync_jobs (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        status TEXT NOT NULL,
        nextCursor TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_conversations (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        externalConversationId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(sourceId, externalConversationId)
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_messages (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        userId TEXT NOT NULL,
        externalMessageId TEXT NOT NULL,
        contentDigest TEXT NOT NULL,
        messageAt TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(sourceId, externalMessageId)
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_attachments (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        userId TEXT NOT NULL,
        externalAttachmentId TEXT NOT NULL,
        contentDigest TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(sourceId, externalAttachmentId)
      );

      CREATE TABLE IF NOT EXISTS extension_publishers (
        fingerprint TEXT PRIMARY KEY,
        publisherId TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS extension_revisions (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        userId TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        manifestDigest TEXT NOT NULL,
        signerFingerprint TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(extensionId, version)
      );

      CREATE TABLE IF NOT EXISTS extension_activation_receipts (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        revisionId TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
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

      CREATE TABLE IF NOT EXISTS org_positions (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        departmentId TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_work_routing_rules (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_work_items (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL,
        requestId TEXT NOT NULL,
        source TEXT NOT NULL,
        requesterUserId TEXT NOT NULL,
        conversationId TEXT NOT NULL DEFAULT '',
        taskId TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(orgId, idempotencyKey)
      );

      CREATE TABLE IF NOT EXISTS org_work_approvals (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        workItemId TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_work_handoffs (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        workItemId TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_resource_policies (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT 'organization',
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(orgId, resourceType, resourceId)
      );

      CREATE TABLE IF NOT EXISTS org_resource_grants (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        subjectType TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        effect TEXT NOT NULL DEFAULT 'allow',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_credential_references (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_devices (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        branchId TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
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
        updatedAt TEXT NOT NULL,
        ingestionManifest TEXT NOT NULL DEFAULT '{}'
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
  const founderVisionRow = await query<any>('SELECT content, updatedAt FROM founder_vision WHERE id = 1');
  const founderVision = founderVisionRow[0]?.content || '';
  const founderVisionUpdatedAt = founderVisionRow[0]?.updatedAt || new Date(0).toISOString();

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
  const conversationActionTasks = await query<any>('SELECT * FROM conversation_action_tasks');
  const conversationActionReceipts = await query<any>('SELECT * FROM conversation_action_receipts');
  const modelRoutingReceiptsRaw = await query<any>('SELECT * FROM model_routing_receipts');
  const readOnlyToolPatternsRaw = await query<any>('SELECT * FROM read_only_tool_patterns');
  const backgroundDelegationTasksRaw = await query<any>('SELECT * FROM background_delegation_tasks');
  const commandCenterPlansRaw = await query<any>('SELECT * FROM command_center_plans');
  const autonomousTasksRaw = await query<any>('SELECT * FROM autonomous_tasks');
  const externalAiSessionsRaw = await query<any>('SELECT * FROM external_ai_sessions');
  const externalAiDispatchesRaw = await query<any>('SELECT * FROM external_ai_dispatches');
  const externalAiAnswersRaw = await query<any>('SELECT * FROM external_ai_answers');
  const externalAiHistorySourcesRaw = await query<any>('SELECT * FROM external_ai_history_sources');
  const externalAiHistorySyncJobsRaw = await query<any>('SELECT * FROM external_ai_history_sync_jobs');
  const externalAiHistoryConversationsRaw = await query<any>('SELECT * FROM external_ai_history_conversations');
  const externalAiHistoryMessagesRaw = await query<any>('SELECT * FROM external_ai_history_messages');
  const externalAiHistoryAttachmentsRaw = await query<any>('SELECT * FROM external_ai_history_attachments');
  const extensionPublishersRaw = await query<any>('SELECT * FROM extension_publishers');
  const extensionRevisionsRaw = await query<any>('SELECT * FROM extension_revisions');
  const extensionActivationReceiptsRaw = await query<any>('SELECT * FROM extension_activation_receipts');
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
    skillTags: parseJsonArrayValue(a.skillTags).map(item => String(item || '').trim()).filter(Boolean),
    knowledgeDomains: parseJsonArrayValue(a.knowledgeDomains).map(item => String(item || '').trim()).filter(Boolean),
  }));

  const interactions = interactionsRaw.map((i: any) => ({
    ...i,
    content: i.message || i.content || '',
    role: i.role || '',
    personality: i.personality || i.module || '',
    mode: i.mode || '',
    toolCalls: parseStoredToolCalls(i.toolCalls),
    conversationId: i.conversationId || '',
    cognitiveIntent: i.cognitiveIntent || '',
    llmWasCalled: i.llmWasCalled ? true : false,
    domain: i.domain || 'personal',
    orgId: i.orgId || '',
    source: i.source || '',
    channel: i.channel || '',
    externalMessageId: i.externalMessageId || '',
    routeSequence: Number.isFinite(i.routeSequence) ? Number(i.routeSequence) : undefined,
    receivedAt: i.receivedAt || '',
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
    users,
    agents,
    interactions,
    marketplaceSkills,
    skills,
    founderVision,
    founderVisionUpdatedAt,
    memories: (memories || []).map((m: any) => ({ ...m, domain: m.domain || 'personal', orgId: m.orgId || '' })),
    reminders: remindersRaw || [],
    conversations,
    conversationActionTasks: conversationActionTasks || [],
    conversationActionReceipts: conversationActionReceipts || [],
    modelRoutingReceipts: (modelRoutingReceiptsRaw || []).map((receipt: any) => ({
      ...receipt,
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
    backgroundDelegationTasks: (backgroundDelegationTasksRaw || []).flatMap((row: any) => {
      try {
        const task = JSON.parse(row.payload || '{}');
        return task && typeof task === 'object' ? [{ ...task, id: row.id, userId: row.userId, status: row.status, leaseExpiresAt: row.leaseExpiresAt || '', updatedAt: row.updatedAt }] : [];
      } catch { return []; }
    }),
    commandCenterPlans: commandCenterPlansRaw || [],
    autonomousTasks: (autonomousTasksRaw || []).flatMap((row: any) => {
      try {
        const task = JSON.parse(row.payload || '{}');
        return task && typeof task === 'object' ? [{ ...task, id: row.id, userId: row.userId, status: row.status, leaseExpiresAt: row.leaseExpiresAt || '', updatedAt: row.updatedAt }] : [];
      } catch { return []; }
    }),
    externalAiSessions: (externalAiSessionsRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, userId: row.userId, taskId: row.taskId || '', conversationId: row.conversationId || '', status: row.status, updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    externalAiDispatches: (externalAiDispatchesRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, sessionId: row.sessionId, userId: row.userId, targetId: row.targetId, status: row.status, routeKind: row.routeKind, idempotencyKey: row.idempotencyKey, updatedAt: row.updatedAt }]
          : [];
      } catch { return []; }
    }),
    externalAiAnswers: (externalAiAnswersRaw || []).flatMap((row: any) => {
      try {
        const payload = JSON.parse(row.payload || '{}');
        return payload && typeof payload === 'object'
          ? [{ ...payload, id: row.id, sessionId: row.sessionId, dispatchId: row.dispatchId, userId: row.userId, targetId: row.targetId, receivedAt: row.receivedAt }]
          : [];
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
    agentTemplates: agentTemplates || [],
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

// Prune high-volume telemetry from memory + SQLite to prevent unbounded
// growth. Durable memories are deliberately excluded: count-based deletion
// would silently erase knowledge and identity without considering tier,
// importance, consolidation state, or user retention policy.
export function pruneOldData(): void {
  if (!memoryDB || !db) return;
  const limits: Record<string, number> = { interactions: 20000, tokenUsage: 5000 };
  const tableMap: Record<string, string> = { interactions: 'interactions', tokenUsage: 'token_usage' };
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
  recordDatabaseDirty();
}

// Write lock to prevent concurrent SQLite transactions
let writeLock: Promise<void> = Promise.resolve();

function withDatabaseWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const scheduled = writeLock.catch((error) => {
    console.error('[DB] Previous write failed before durable journal operation:', error);
  }).then(operation);
  writeLock = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

let writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let writeRevision = 0;
let persistedRevision = 0;
let writeInFlight = false;
let dirtySinceMs = 0;
let lastSuccessfulFlushAt = '';
let lastPersistenceError = '';
let persistenceTableDigests = new Map<string, string>();
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
  if (writeDebounceTimer || writeInFlight) return;
  writeDebounceTimer = setTimeout(() => {
    writeDebounceTimer = null;
    if (writeInFlight || persistedRevision >= writeRevision) return;

    const targetRevision = writeRevision;
    writeInFlight = true;
    const ready = writeLock.catch((err) => {
      console.error('[DB] Previous write failed:', err);
    });
    writeLock = ready
      .then(() => persistMemoryDB())
      .then(() => {
        persistedRevision = Math.max(persistedRevision, targetRevision);
        recordSuccessfulDatabaseFlush();
      })
      .catch((err) => {
        // persistMemoryDB writes through a transaction and does not mutate the
        // in-memory source of truth. Keeping that live object is both safer and
        // dramatically cheaper than cloning the complete database on every
        // chat/voice event (large tool receipts previously exhausted V8 heap).
        recordDatabaseFlushFailure(err);
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
  if (!db) {
    throw new Error('Database not initialized.');
  }
  memoryDB = data;
  recordDatabaseDirty();
  writeRevision += 1;

  // Keep at most one full snapshot write in flight. Rapid message, memory and
  // voice updates are coalesced into the next revision instead of queuing a
  // chain of expensive whole-database rewrites behind SQLite.
  scheduleDatabaseFlush(100);
}

async function flushDatabaseStrict(): Promise<void> {
  if (writeDebounceTimer) {
    clearTimeout(writeDebounceTimer);
    writeDebounceTimer = null;
  }
  await writeLock;
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

/**
 * Durability boundary for transactional registries. Unlike the normal
 * best-effort flush, this propagates persistence failures so the caller can
 * restore its prior in-memory/runtime state.
 */
export async function flushDBOrThrow(): Promise<void> {
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
    totalTableWrites,
    totalSkippedTableWrites,
  };
}

/** Flush pending work and release the SQLite handle (tests and graceful shutdown). */
export async function closeDatabase(): Promise<void> {
  await flushDB();
  if (writeDebounceTimer) {
    clearTimeout(writeDebounceTimer);
    writeDebounceTimer = null;
  }
  await writeLock.catch((err) => {
    console.error('[DB] Previous write failed before close:', err);
  });

  const closingDb = db;
  db = null;
  memoryDB = null;
  initPromise = null;
  writeLock = Promise.resolve();
  writeRevision = 0;
  persistedRevision = 0;
  writeInFlight = false;
  dirtySinceMs = 0;
  lastSuccessfulFlushAt = '';
  lastPersistenceError = '';
  persistenceTableDigests = new Map();
  lastFlushTables = [];
  totalTableWrites = 0;
  totalSkippedTableWrites = 0;
  dbDirty = false;
  configureExternalCommitJournal(null);

  if (!closingDb) return;
  await new Promise<void>((resolve, reject) => {
    closingDb.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Persist all in-memory data to SQLite using an atomic write-via-temp-table pattern.
 * Data is written to temp tables first, then the original tables are atomically
 * replaced. If the process crashes mid-write, the original data is preserved.
 */
interface PersistenceTableSpec {
  name: string;
  createSQL: string;
  insertSQL: string;
  rows: () => any[][];
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
      createSQL: `CREATE TABLE _temp_users (uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'user', balance REAL DEFAULT 0, phone TEXT DEFAULT '', createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_users (uid, username, password, role, balance, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.users.map((u: any) => [u.uid, u.username, u.password, u.role, u.balance, u.phone || '', u.createdAt]),
    },
    {
      name: 'agents',
      createSQL: `CREATE TABLE _temp_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, config TEXT NOT NULL, createdAt TEXT NOT NULL, userId TEXT, status TEXT DEFAULT 'active', personalityId TEXT DEFAULT 'lumi', modelPreference TEXT DEFAULT '', memoryScope TEXT DEFAULT 'shared', autonomyLevel TEXT DEFAULT 'reactive', runtimeConfig TEXT DEFAULT '{}', runtime TEXT DEFAULT 'internal', externalCommand TEXT DEFAULT '', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', skillTags TEXT NOT NULL DEFAULT '[]', knowledgeDomains TEXT NOT NULL DEFAULT '[]')`,
      insertSQL: `INSERT INTO _temp_agents (id, name, category, config, createdAt, userId, status, personalityId, modelPreference, memoryScope, autonomyLevel, runtimeConfig, runtime, externalCommand, domain, orgId, skillTags, knowledgeDomains) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.agents.map((a: any) => [a.id, a.name, a.category, a.data || a.config || '{}', a.createdAt, a.ownerUid || a.userId || null, a.status || 'active', a.personalityId || 'lumi', a.modelPreference || '', a.memoryScope || 'shared', a.autonomyLevel || 'reactive', a.runtimeConfig || '{}', a.runtime || 'internal', a.externalCommand || '', a.domain || 'personal', a.orgId || '', JSON.stringify(Array.isArray(a.skillTags) ? a.skillTags : []), JSON.stringify(Array.isArray(a.knowledgeDomains) ? a.knowledgeDomains : [])]),
    },
    {
      name: 'interactions',
      createSQL: `CREATE TABLE _temp_interactions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, agentId TEXT, module TEXT, message TEXT NOT NULL, response TEXT, role TEXT DEFAULT '', personality TEXT DEFAULT '', mode TEXT DEFAULT '', toolCalls TEXT DEFAULT '', conversationId TEXT DEFAULT '', cognitiveIntent TEXT DEFAULT '', llmWasCalled INTEGER DEFAULT 0, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', source TEXT DEFAULT '', channel TEXT DEFAULT '', externalMessageId TEXT DEFAULT '', routeSequence INTEGER, receivedAt TEXT DEFAULT '', timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_interactions (id, userId, agentId, module, message, response, role, personality, mode, toolCalls, conversationId, cognitiveIntent, llmWasCalled, domain, orgId, source, channel, externalMessageId, routeSequence, receivedAt, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.interactions.map((i: any) => [i.id, i.userId || 'unknown', i.agentId || null, i.personality || i.module || null, i.content || i.message || '', i.response || '', i.role || '', i.personality || '', i.mode || '', serializeStoredToolCalls(i.toolCalls), i.conversationId || '', i.cognitiveIntent || '', i.llmWasCalled ? 1 : 0, i.domain || 'personal', i.orgId || '', i.source || '', i.channel || '', i.externalMessageId || '', Number.isFinite(i.routeSequence) ? i.routeSequence : null, i.receivedAt || '', i.timestamp]),
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
      createSQL: `CREATE TABLE _temp_conversations (id TEXT PRIMARY KEY, userId TEXT NOT NULL, agentId TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'active', summary TEXT DEFAULT '', summaryChain TEXT DEFAULT '[]', lastSummaryMessageCount INTEGER DEFAULT -1, actionContinuationState TEXT DEFAULT '{}', messageCount INTEGER DEFAULT 0, lastActiveAt TEXT NOT NULL, createdAt TEXT NOT NULL, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_conversations (id, userId, agentId, title, status, summary, summaryChain, lastSummaryMessageCount, actionContinuationState, messageCount, lastActiveAt, createdAt, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.conversations || []).map((c: any) => [c.id, c.userId, c.agentId || '', c.title || '', c.status || 'active', c.summary || '', JSON.stringify(Array.isArray(c.summaryChain) ? c.summaryChain : []), Number.isFinite(Number(c.lastSummaryMessageCount)) ? Math.floor(Number(c.lastSummaryMessageCount)) : -1, serializeStoredActionContinuationState(legacyActionContinuationStates.get(c)), c.messageCount || 0, c.lastActiveAt, c.createdAt, c.domain || 'personal', c.orgId || '']),
    },
    {
      name: 'conversation_action_tasks',
      createSQL: `CREATE TABLE _temp_conversation_action_tasks (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, userId TEXT NOT NULL, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', parentTaskId TEXT DEFAULT '', rootUserMessageId TEXT DEFAULT '', intentKind TEXT NOT NULL DEFAULT 'none', operation TEXT NOT NULL DEFAULT 'read', goal TEXT NOT NULL, target TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'planning', blocker TEXT DEFAULT '', activeRequestId TEXT DEFAULT '', completionSource TEXT DEFAULT '', context TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_conversation_action_tasks (id, conversationId, userId, domain, orgId, parentTaskId, rootUserMessageId, intentKind, operation, goal, target, status, blocker, activeRequestId, completionSource, context, revision, createdAt, updatedAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.conversationActionTasks || []).map((t: any) => [t.id, t.conversationId, t.userId, t.domain || 'personal', t.orgId || '', t.parentTaskId || '', t.rootUserMessageId || '', t.intentKind || 'none', t.operation || 'read', t.goal || '', t.target || '', t.status || 'planning', t.blocker || '', t.activeRequestId || '', t.completionSource || '', typeof t.context === 'string' ? t.context : JSON.stringify(t.context || {}), Number(t.revision) || 1, t.createdAt, t.updatedAt, t.completedAt || '']),
    },
    {
      name: 'conversation_action_receipts',
      createSQL: `CREATE TABLE _temp_conversation_action_receipts (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, conversationId TEXT NOT NULL, turnId TEXT DEFAULT '', requestId TEXT DEFAULT '', idempotencyKey TEXT NOT NULL, toolName TEXT NOT NULL, targetIdentity TEXT DEFAULT '', inputDigest TEXT DEFAULT '', envelope TEXT NOT NULL DEFAULT '{}', outcome TEXT NOT NULL, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_conversation_action_receipts (id, taskId, conversationId, turnId, requestId, idempotencyKey, toolName, targetIdentity, inputDigest, envelope, outcome, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.conversationActionReceipts || []).map((r: any) => [r.id, r.taskId, r.conversationId, r.turnId || '', r.requestId || '', r.idempotencyKey || '', r.toolName || '', r.targetIdentity || '', r.inputDigest || '', typeof r.envelope === 'string' ? r.envelope : JSON.stringify(r.envelope || {}), r.outcome || 'failed', r.createdAt]),
    },
    {
      name: 'model_routing_receipts',
      createSQL: `CREATE TABLE _temp_model_routing_receipts (id TEXT PRIMARY KEY, userId TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'personal', orgId TEXT NOT NULL DEFAULT '', conversationId TEXT NOT NULL DEFAULT '', requestId TEXT NOT NULL DEFAULT '', interactionId TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, requestedProvider TEXT NOT NULL, requestedModel TEXT NOT NULL, selectionMode TEXT NOT NULL, selectedProvider TEXT NOT NULL DEFAULT '', selectedModel TEXT NOT NULL DEFAULT '', fallbackReason TEXT NOT NULL DEFAULT '', attempts TEXT NOT NULL DEFAULT '[]', startedAt TEXT NOT NULL, completedAt TEXT NOT NULL, durationMs INTEGER NOT NULL DEFAULT 0)`,
      insertSQL: `INSERT INTO _temp_model_routing_receipts (id, userId, domain, orgId, conversationId, requestId, interactionId, source, status, requestedProvider, requestedModel, selectionMode, selectedProvider, selectedModel, fallbackReason, attempts, startedAt, completedAt, durationMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.modelRoutingReceipts || []).map((receipt: any) => [
        receipt.id,
        receipt.userId || 'anonymous',
        receipt.domain || 'personal',
        receipt.orgId || '',
        receipt.conversationId || '',
        receipt.requestId || '',
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
      ]),
    },
    {
      name: 'read_only_tool_patterns',
      createSQL: `CREATE TABLE _temp_read_only_tool_patterns (id TEXT PRIMARY KEY, userId TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'personal', orgId TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0, successCount INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_read_only_tool_patterns (id, userId, domain, orgId, confidence, successCount, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.readOnlyToolPatterns || []).map((pattern: any) => [
        pattern.id,
        pattern.userId,
        pattern.domain || 'personal',
        pattern.orgId || '',
        Number(pattern.confidence) || 0,
        Number(pattern.successCount) || 0,
        persistenceTimestamp(pattern.updatedAt, pattern.createdAt),
        JSON.stringify(pattern),
      ]),
    },
    {
      name: 'background_delegation_tasks',
      createSQL: `CREATE TABLE _temp_background_delegation_tasks (id TEXT PRIMARY KEY, userId TEXT NOT NULL, status TEXT NOT NULL, leaseExpiresAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_background_delegation_tasks (id, userId, status, leaseExpiresAt, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.backgroundDelegationTasks || []).map((task: any) => [
        task.id,
        task.userId,
        task.status || 'queued',
        task.leaseExpiresAt || '',
        persistenceTimestamp(task.updatedAt, task.createdAt),
        JSON.stringify(task),
      ]),
    },
    {
      name: 'command_center_plans',
      createSQL: `CREATE TABLE _temp_command_center_plans (id TEXT PRIMARY KEY, userId TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'personal', orgId TEXT NOT NULL DEFAULT '', conversationId TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL, cadence TEXT NOT NULL DEFAULT 'none', timeOfDay TEXT NOT NULL DEFAULT '09:00', dayOfWeek INTEGER NOT NULL DEFAULT 1, dayOfMonth INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', nextRunAt TEXT NOT NULL DEFAULT '', lastRunAt TEXT NOT NULL DEFAULT '', lastRuntimeTaskId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_command_center_plans (id, userId, domain, orgId, conversationId, kind, title, instruction, cadence, timeOfDay, dayOfWeek, dayOfMonth, status, nextRunAt, lastRunAt, lastRuntimeTaskId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.commandCenterPlans || []).map((plan: any) => [
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
      ]),
    },
    {
      name: 'autonomous_tasks',
      createSQL: `CREATE TABLE _temp_autonomous_tasks (id TEXT PRIMARY KEY, userId TEXT NOT NULL, status TEXT NOT NULL, leaseExpiresAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_autonomous_tasks (id, userId, status, leaseExpiresAt, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.autonomousTasks || []).map((task: any) => [
        task.id,
        task.userId,
        task.status || 'pending',
        task.leaseExpiresAt || '',
        persistenceTimestamp(task.updatedAt, task.createdAt),
        JSON.stringify(task),
      ]),
    },
    {
      name: 'external_ai_sessions',
      createSQL: `CREATE TABLE _temp_external_ai_sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, taskId TEXT NOT NULL DEFAULT '', conversationId TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_external_ai_sessions (id, userId, taskId, conversationId, status, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiSessions || []).map((session: any) => [
        session.id,
        session.userId,
        session.taskId || '',
        session.conversationId || '',
        session.status || 'active',
        persistenceTimestamp(session.updatedAt, session.createdAt),
        JSON.stringify(session),
      ]),
    },
    {
      name: 'external_ai_dispatches',
      createSQL: `CREATE TABLE _temp_external_ai_dispatches (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, userId TEXT NOT NULL, targetId TEXT NOT NULL, status TEXT NOT NULL, routeKind TEXT NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_external_ai_dispatches (id, sessionId, userId, targetId, status, routeKind, idempotencyKey, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiDispatches || []).map((dispatch: any) => [
        dispatch.id,
        dispatch.sessionId,
        dispatch.userId,
        dispatch.targetId,
        dispatch.status || 'planned',
        dispatch.routeKind || 'desktop_visual',
        dispatch.idempotencyKey,
        persistenceTimestamp(dispatch.updatedAt, dispatch.createdAt),
        JSON.stringify(dispatch),
      ]),
    },
    {
      name: 'external_ai_answers',
      createSQL: `CREATE TABLE _temp_external_ai_answers (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, dispatchId TEXT NOT NULL, userId TEXT NOT NULL, targetId TEXT NOT NULL, receivedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_external_ai_answers (id, sessionId, dispatchId, userId, targetId, receivedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiAnswers || []).map((answer: any) => [
        answer.id,
        answer.sessionId,
        answer.dispatchId,
        answer.userId,
        answer.targetId,
        persistenceTimestamp(answer.receivedAt),
        JSON.stringify(answer),
      ]),
    },
    {
      name: 'external_ai_history_sources',
      createSQL: `CREATE TABLE _temp_external_ai_history_sources (id TEXT PRIMARY KEY, userId TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'personal', orgId TEXT NOT NULL DEFAULT '', sourceKind TEXT NOT NULL, status TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_external_ai_history_sources (id, userId, domain, orgId, sourceKind, status, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiHistorySources || []).map((source: any) => [
        source.id,
        source.userId,
        source.domain || 'personal',
        source.orgId || '',
        source.sourceKind,
        source.status || 'active',
        persistenceTimestamp(source.updatedAt, source.createdAt),
        JSON.stringify(source),
      ]),
    },
    {
      name: 'external_ai_history_sync_jobs',
      createSQL: `CREATE TABLE _temp_external_ai_history_sync_jobs (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, userId TEXT NOT NULL, status TEXT NOT NULL, nextCursor TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_external_ai_history_sync_jobs (id, sourceId, userId, status, nextCursor, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiHistorySyncJobs || []).map((job: any) => [
        job.id,
        job.sourceId,
        job.userId,
        job.status || 'pending',
        job.nextCursor || '',
        persistenceTimestamp(job.updatedAt, job.createdAt),
        JSON.stringify(job),
      ]),
    },
    {
      name: 'external_ai_history_conversations',
      createSQL: `CREATE TABLE _temp_external_ai_history_conversations (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, userId TEXT NOT NULL, externalConversationId TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', UNIQUE(sourceId, externalConversationId))`,
      insertSQL: `INSERT INTO _temp_external_ai_history_conversations (id, sourceId, userId, externalConversationId, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiHistoryConversations || []).map((conversation: any) => [
        conversation.id,
        conversation.sourceId,
        conversation.userId,
        conversation.externalConversationId,
        persistenceTimestamp(conversation.updatedAt, conversation.createdAt),
        JSON.stringify(conversation),
      ]),
    },
    {
      name: 'external_ai_history_messages',
      createSQL: `CREATE TABLE _temp_external_ai_history_messages (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, conversationId TEXT NOT NULL, userId TEXT NOT NULL, externalMessageId TEXT NOT NULL, contentDigest TEXT NOT NULL, messageAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', UNIQUE(sourceId, externalMessageId))`,
      insertSQL: `INSERT INTO _temp_external_ai_history_messages (id, sourceId, conversationId, userId, externalMessageId, contentDigest, messageAt, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiHistoryMessages || []).map((message: any) => [
        message.id,
        message.sourceId,
        message.conversationId,
        message.userId,
        message.externalMessageId,
        message.contentDigest || '',
        message.messageAt || '',
        persistenceTimestamp(message.updatedAt, message.createdAt),
        JSON.stringify(message),
      ]),
    },
    {
      name: 'external_ai_history_attachments',
      createSQL: `CREATE TABLE _temp_external_ai_history_attachments (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, messageId TEXT NOT NULL, userId TEXT NOT NULL, externalAttachmentId TEXT NOT NULL, contentDigest TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', UNIQUE(sourceId, externalAttachmentId))`,
      insertSQL: `INSERT INTO _temp_external_ai_history_attachments (id, sourceId, messageId, userId, externalAttachmentId, contentDigest, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.externalAiHistoryAttachments || []).map((attachment: any) => [
        attachment.id,
        attachment.sourceId,
        attachment.messageId,
        attachment.userId,
        attachment.externalAttachmentId,
        attachment.contentDigest || '',
        persistenceTimestamp(attachment.updatedAt, attachment.createdAt),
        JSON.stringify(attachment),
      ]),
    },
    {
      name: 'extension_publishers',
      createSQL: `CREATE TABLE _temp_extension_publishers (fingerprint TEXT PRIMARY KEY, publisherId TEXT NOT NULL, status TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_extension_publishers (fingerprint, publisherId, status, updatedAt, payload) VALUES (?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.extensionPublishers || []).map((publisher: any) => [
        publisher.fingerprint,
        publisher.publisherId,
        publisher.status || 'trusted',
        persistenceTimestamp(publisher.updatedAt, publisher.createdAt),
        JSON.stringify(publisher),
      ]),
    },
    {
      name: 'extension_revisions',
      createSQL: `CREATE TABLE _temp_extension_revisions (id TEXT PRIMARY KEY, extensionId TEXT NOT NULL, userId TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, manifestDigest TEXT NOT NULL, signerFingerprint TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', UNIQUE(extensionId, version))`,
      insertSQL: `INSERT INTO _temp_extension_revisions (id, extensionId, userId, version, kind, status, manifestDigest, signerFingerprint, updatedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.extensionRevisions || []).map((revision: any) => [
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
      ]),
    },
    {
      name: 'extension_activation_receipts',
      createSQL: `CREATE TABLE _temp_extension_activation_receipts (id TEXT PRIMARY KEY, extensionId TEXT NOT NULL, revisionId TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_extension_activation_receipts (id, extensionId, revisionId, status, createdAt, payload) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.extensionActivationReceipts || []).map((receipt: any) => [
        receipt.id,
        receipt.extensionId,
        receipt.revisionId,
        receipt.status || 'unknown',
        persistenceTimestamp(receipt.createdAt),
        JSON.stringify(receipt),
      ]),
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
      name: 'org_positions',
      createSQL: `CREATE TABLE _temp_org_positions (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, departmentId TEXT, status TEXT NOT NULL DEFAULT 'active', payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_positions (id, orgId, departmentId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgPositions || []).map((item: any) => [item.id, item.orgId, item.departmentId || null, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_work_routing_rules',
      createSQL: `CREATE TABLE _temp_org_work_routing_rules (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_work_routing_rules (id, orgId, enabled, priority, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgWorkRoutingRules || []).map((item: any) => [item.id, item.orgId, item.enabled === false ? 0 : 1, Number(item.priority) || 0, JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_work_items',
      createSQL: `CREATE TABLE _temp_org_work_items (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, idempotencyKey TEXT NOT NULL, requestId TEXT NOT NULL, source TEXT NOT NULL, requesterUserId TEXT NOT NULL, conversationId TEXT NOT NULL DEFAULT '', taskId TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(orgId, idempotencyKey))`,
      insertSQL: `INSERT INTO _temp_org_work_items (id, orgId, idempotencyKey, requestId, source, requesterUserId, conversationId, taskId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgWorkItems || []).map((item: any) => [item.id, item.orgId, item.idempotencyKey, item.requestId, item.source, item.requesterUserId, item.conversationId || '', item.taskId || '', item.status, JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_work_approvals',
      createSQL: `CREATE TABLE _temp_org_work_approvals (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, workItemId TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_work_approvals (id, orgId, workItemId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgWorkApprovals || []).map((item: any) => [item.id, item.orgId, item.workItemId, item.status, JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_work_handoffs',
      createSQL: `CREATE TABLE _temp_org_work_handoffs (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, workItemId TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_work_handoffs (id, orgId, workItemId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgWorkHandoffs || []).map((item: any) => [item.id, item.orgId, item.workItemId, item.status, JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_resource_policies',
      createSQL: `CREATE TABLE _temp_org_resource_policies (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, resourceType TEXT NOT NULL, resourceId TEXT NOT NULL, classification TEXT NOT NULL DEFAULT 'organization', status TEXT NOT NULL DEFAULT 'active', payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(orgId, resourceType, resourceId))`,
      insertSQL: `INSERT INTO _temp_org_resource_policies (id, orgId, resourceType, resourceId, classification, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgResourcePolicies || []).map((item: any) => [item.id, item.orgId, item.resourceType, item.resourceId, item.classification || 'organization', item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_resource_grants',
      createSQL: `CREATE TABLE _temp_org_resource_grants (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, resourceType TEXT NOT NULL, resourceId TEXT NOT NULL, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, effect TEXT NOT NULL DEFAULT 'allow', payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_resource_grants (id, orgId, resourceType, resourceId, subjectType, subjectId, effect, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgResourceGrants || []).map((item: any) => [item.id, item.orgId, item.resourceType, item.resourceId, item.subjectType, item.subjectId, item.effect || 'allow', JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_credential_references',
      createSQL: `CREATE TABLE _temp_org_credential_references (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_credential_references (id, orgId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgCredentialReferences || []).map((item: any) => [item.id, item.orgId, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_devices',
      createSQL: `CREATE TABLE _temp_org_devices (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, branchId TEXT NOT NULL UNIQUE, userId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', payload TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_devices (id, orgId, branchId, userId, status, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgDevices || []).map((item: any) => [item.id, item.orgId, item.branchId, item.userId, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    },
    {
      name: 'org_invitations',
      createSQL: `CREATE TABLE _temp_org_invitations (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, code TEXT UNIQUE NOT NULL, createdBy TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', departmentId TEXT, maxUses INTEGER DEFAULT 0, useCount INTEGER DEFAULT 0, expiresAt TEXT, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_invitations (id, orgId, code, createdBy, role, departmentId, maxUses, useCount, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgInvitations || []).map((inv: any) => [inv.id, inv.orgId, inv.code, inv.createdBy, inv.role || 'member', inv.departmentId || null, inv.maxUses || 0, inv.useCount || 0, inv.expiresAt || null, inv.createdAt]),
    },
    {
      name: 'org_kb_articles',
      createSQL: `CREATE TABLE _temp_org_kb_articles (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT DEFAULT 'general', tags TEXT DEFAULT '[]', authorId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', viewCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ingestionManifest TEXT NOT NULL DEFAULT '{}')`,
      insertSQL: `INSERT INTO _temp_org_kb_articles (id, orgId, title, content, category, tags, authorId, status, viewCount, createdAt, updatedAt, ingestionManifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgKbArticles || []).map((a: any) => [a.id, a.orgId, a.title, a.content, a.category || 'general', a.tags || '[]', a.authorId, a.status || 'published', a.viewCount || 0, a.createdAt, a.updatedAt, a.ingestionManifest || '{}']),
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
  const founderSpec: PersistenceTableSpec = {
    name: 'founder_vision',
    createSQL: `CREATE TABLE _temp_founder_vision (id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
    insertSQL: `INSERT INTO _temp_founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
    rows: () => memoryDB.founderVision
      ? [[1, memoryDB.founderVision, persistenceTimestamp(memoryDB.founderVisionUpdatedAt)]]
      : [],
  };

  return [...specs, founderSpec];
}

function digestPersistenceRows(rows: any[][]): string {
  const hash = createHash('sha256');
  hash.update(String(rows.length));
  for (const row of rows) {
    hash.update('\n');
    hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

function seedPersistenceTableDigests(): void {
  const next = new Map<string, string>();
  for (const spec of buildPersistenceTableSpecs()) {
    next.set(spec.name, digestPersistenceRows(spec.rows()));
  }
  persistenceTableDigests = next;
}

/**
 * Persist only tables whose exact serialized rows changed since the last
 * durable snapshot. The changed set is still replaced atomically in one
 * transaction, preserving the previous crash/rollback semantics without
 * rebuilding unrelated high-volume tables on every chat or scheduler write.
 */
async function persistMemoryDB(): Promise<void> {
  const allSpecs = buildPersistenceTableSpecs();
  const changed: Array<{ spec: PersistenceTableSpec; rows: any[][]; digest: string }> = [];
  for (const spec of allSpecs) {
    const rows = spec.rows();
    const digest = digestPersistenceRows(rows);
    if (persistenceTableDigests.get(spec.name) !== digest) changed.push({ spec, rows, digest });
  }
  totalSkippedTableWrites += allSpecs.length - changed.length;
  if (changed.length === 0) {
    lastFlushTables = [];
    return;
  }

  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Phase 1: Create temp tables and populate them
    for (const { spec, rows } of changed) {
      await run(`DROP TABLE IF EXISTS _temp_${spec.name}`);
      await run(spec.createSQL);
      for (const row of rows) {
        await run(spec.insertSQL, row);
      }
    }

    // Phase 2: Drop original tables
    for (const { spec } of changed) {
      await run(`DROP TABLE IF EXISTS ${spec.name}`);
    }

    // Phase 3: Rename temp tables to original names (atomic in SQLite within a transaction)
    for (const { spec } of changed) {
      await run(`ALTER TABLE _temp_${spec.name} RENAME TO ${spec.name}`);
    }

    // Replacing tables drops their indexes. Recreate all query indexes in the
    // same transaction so no persisted snapshot is left unindexed.
    for (const sql of PERFORMANCE_INDEX_SQL) {
      await run(sql);
    }

    await run('COMMIT');
    for (const { spec, digest } of changed) persistenceTableDigests.set(spec.name, digest);
    lastFlushTables = changed.map(({ spec }) => spec.name);
    totalTableWrites += changed.length;
  } catch (err) {
    // Preserve the original failure. A failed/externally interrupted BEGIN or
    // COMMIT must not be replaced by "no transaction is active" from cleanup.
    try { await run('ROLLBACK'); } catch {}
    try {
      for (const { spec } of changed) {
        await run(`DROP TABLE IF EXISTS _temp_${spec.name}`);
      }
    } catch {}
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
  return query<T>(sql, params);
}

export async function runSQL(sql: string, params: any[] = []): Promise<void> {
  return run(sql, params);
}
