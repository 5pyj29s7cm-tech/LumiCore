import type sqlite3 from 'sqlite3';

// Startup and persistence rebuilds share the same schema/index definitions.
export const PERFORMANCE_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_interactions_user_conv ON interactions(userId, conversationId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_type_tier ON memories(userId, type, tier)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(userId, agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_avatars_user_status ON memory_avatars(userId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_parent ON memories(userId, parentId)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_status ON conversations(userId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_user_ts ON token_usage(userId, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_domain ON memories(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_user_domain ON interactions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_org ON interactions(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_request ON interactions(requestId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_voice_chain ON interactions(contextChainId, captureSessionId, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_domain ON conversations(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_action_tasks_conversation_updated ON conversation_action_tasks(conversationId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_action_tasks_user_status ON conversation_action_tasks(userId, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_turns_request_identity ON conversation_action_turns(conversationId, userId, requestId)`,
  `CREATE INDEX IF NOT EXISTS idx_action_turns_conversation_status ON conversation_action_turns(conversationId, userId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_action_turns_lease_expiry ON conversation_action_turns(status, leaseExpiresAt)`,
  `CREATE INDEX IF NOT EXISTS idx_action_turns_task_updated ON conversation_action_turns(taskId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_action_receipts_task_created ON conversation_action_receipts(taskId, createdAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_receipts_idempotency ON conversation_action_receipts(taskId, idempotencyKey, toolName, outcome)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_user_completed ON model_routing_receipts(userId, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_conversation_completed ON model_routing_receipts(conversationId, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_request ON model_routing_receipts(requestId)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_selected ON model_routing_receipts(selectedProvider, selectedModel, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_native_session ON model_routing_receipts(nativeDeviceId, executionSessionId)`,
  `CREATE INDEX IF NOT EXISTS idx_model_routing_voice_chain ON model_routing_receipts(contextChainId, captureSessionId, completedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_execution_receipts_expiry ON chat_execution_terminal_receipts(expiresAt)`,
  `CREATE INDEX IF NOT EXISTS idx_read_only_tool_patterns_scope ON read_only_tool_patterns(userId, domain, orgId, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_command_center_plans_scope_status ON command_center_plans(userId, domain, orgId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_command_center_plans_due ON command_center_plans(status, nextRunAt)`,
  `CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_user_status ON autonomous_tasks(userId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_lease ON autonomous_tasks(status, leaseExpiresAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_commit_journal_task ON external_commit_journal(taskId, updatedAt)`,
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
  `CREATE INDEX IF NOT EXISTS idx_external_capability_packages_owner_status ON external_capability_packages(ownerUserId, status, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_capability_packages_identity ON external_capability_packages(ownerUserId, capabilityId, version)`,
  `CREATE INDEX IF NOT EXISTS idx_external_capability_receipts_package_created ON external_capability_receipts(packageRowId, createdAt)`,
  `CREATE INDEX IF NOT EXISTS idx_external_capability_receipts_owner_action ON external_capability_receipts(ownerUserId, capabilityId, actionId, createdAt)`,
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

/** Requires the base tables created by initDatabase before legacy column upgrades. */
// Add missing columns to existing tables (safe on old DB)
export function migrateSchema(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    let migrationError: Error | null = null;
    const onAlter = (err: Error | null) => {
      // Replaying an already-added column is expected; a missing table,
      // locked database, or invalid statement must fail startup visibly.
      if (err && !err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
        migrationError ||= err;
      }
    };
    database.serialize(() => {
    // The table must exist before its legacy column upgrades are replayed.
    database.run(`CREATE TABLE IF NOT EXISTS memories (
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
      embedding TEXT,
      embeddingNamespace TEXT,
      embeddingContentHash TEXT,
      domain TEXT DEFAULT 'personal',
      orgId TEXT DEFAULT ''
    )`, onAlter);
    // Add 'phone' column to users if it doesn't exist (old DB lacks it)
    database.run("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''", onAlter);
    // Add 'role' column to interactions if it doesn't exist
    database.run("ALTER TABLE interactions ADD COLUMN role TEXT DEFAULT ''", onAlter);
    // Add 'personality' column to interactions if it doesn't exist
    database.run("ALTER TABLE interactions ADD COLUMN personality TEXT DEFAULT ''", onAlter);
    // Add 'mode' column to interactions if it doesn't exist
    database.run("ALTER TABLE interactions ADD COLUMN mode TEXT DEFAULT ''", onAlter);
    // Add 'toolCalls' column to interactions if it doesn't exist
    database.run("ALTER TABLE interactions ADD COLUMN toolCalls TEXT DEFAULT ''", onAlter);
    // Add 'conversationId' column to interactions if it doesn't exist
    database.run("ALTER TABLE interactions ADD COLUMN conversationId TEXT DEFAULT ''", onAlter);
    // Keep the stable Lumi identity key used by conversations and knowledge.
    database.run("ALTER TABLE memories ADD COLUMN agentId TEXT DEFAULT ''", onAlter);
    // Add location to memories for spatial context
    database.run("ALTER TABLE memories ADD COLUMN location TEXT DEFAULT ''", onAlter);
    // Org: domain + orgId for data classification
    database.run("ALTER TABLE memories ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN source TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN channel TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN externalMessageId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN routeSequence INTEGER", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN receivedAt TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN requestId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN nativeDeviceId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN executionSessionId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN nativeClientIdentitySha256 TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN audioInputKind TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN syntheticAudio INTEGER", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN captureSessionId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN sttReceiptId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN contextChainId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN previousRequestId TEXT DEFAULT ''", onAlter);
    // Add domain + orgId to conversations for personal/work isolation
    database.run("ALTER TABLE conversations ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    database.run("ALTER TABLE conversations ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Durable auto-summary cadence and bounded summary history. -1 marks rows
    // created before this migration so the manager can infer a safe baseline.
    database.run("ALTER TABLE conversations ADD COLUMN summaryChain TEXT DEFAULT '[]'", onAlter);
    database.run("ALTER TABLE conversations ADD COLUMN lastSummaryMessageCount INTEGER DEFAULT -1", onAlter);
    database.run("ALTER TABLE conversations ADD COLUMN actionContinuationState TEXT DEFAULT '{}'", onAlter);
    database.run("ALTER TABLE conversation_action_tasks ADD COLUMN context TEXT NOT NULL DEFAULT '{}'", onAlter);
    // Preserve the immutable tool-selection provenance across backend restarts.
    // Never reconstruct this binding from requestId: one request may own both
    // a preflight route and the actual tool-planning route.
    database.run("ALTER TABLE conversation_action_receipts ADD COLUMN modelRoutingReceiptId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE conversation_action_receipts ADD COLUMN executionOrigin TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN conversationId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN requestId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN interactionId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN source TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN nativeDeviceId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN executionSessionId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN nativeClientIdentitySha256 TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN audioInputKind TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN syntheticAudio INTEGER", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN captureSessionId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN sttReceiptId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN contextChainId TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE model_routing_receipts ADD COLUMN previousRequestId TEXT NOT NULL DEFAULT ''", onAlter);
    // Canvas sessions: persisted workbench state with personal/work isolation
    database.run(`CREATE TABLE IF NOT EXISTS canvas_sessions (
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
    database.run("ALTER TABLE canvas_sessions ADD COLUMN edges TEXT NOT NULL DEFAULT '[]'", onAlter);
    database.run("ALTER TABLE canvas_sessions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    database.run("ALTER TABLE canvas_sessions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE org_kb_articles ADD COLUMN ingestionManifest TEXT NOT NULL DEFAULT '{}'", onAlter);
    // Memory Avatars are a personal, single-persona feature. They are kept
    // outside the retired local Agent/team tables so removing team
    // orchestration cannot remove a user's private memory companion.
    database.run(`CREATE TABLE IF NOT EXISTS memory_avatars (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      relationshipType TEXT NOT NULL DEFAULT 'close_friend',
      status TEXT NOT NULL DEFAULT 'active',
      payload TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`, onAlter);
    // Migrate: add new columns to existing memories table
    database.run("ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN perspective TEXT NOT NULL DEFAULT 'owner_trait'", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.3", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN parentId TEXT", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN nodeType TEXT NOT NULL DEFAULT 'leaf'", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN embedding TEXT", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN embeddingNamespace TEXT", onAlter);
    database.run("ALTER TABLE memories ADD COLUMN embeddingContentHash TEXT", onAlter);
    // Add token_usage table if it doesn't exist
    database.run(`CREATE TABLE IF NOT EXISTS token_usage (
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
    database.run("ALTER TABLE interactions ADD COLUMN cognitiveIntent TEXT DEFAULT ''", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN llmWasCalled INTEGER DEFAULT 0", onAlter);
    database.run("ALTER TABLE interactions ADD COLUMN completionFeedback TEXT DEFAULT ''", onAlter);
    // Add reminders table if it doesn't exist
    database.run(`CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      content TEXT NOT NULL,
      dueAt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sourceInteractionId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      firedAt TEXT
    )`, onAlter);
    database.run("ALTER TABLE reminders ADD COLUMN domain TEXT NOT NULL DEFAULT 'personal'", onAlter);
    database.run("ALTER TABLE reminders ADD COLUMN orgId TEXT NOT NULL DEFAULT ''", onAlter);
    // Legacy scheduled plans retain their content, but gain no implicit authority.
    database.run("ALTER TABLE command_center_plans ADD COLUMN membershipAuthorization TEXT NOT NULL DEFAULT ''", onAlter);
    database.run("ALTER TABLE command_center_plans ADD COLUMN authorizationBlockedReason TEXT NOT NULL DEFAULT ''", onAlter);
    // Indexes are recreated here and after every atomic table replacement.
    for (const sql of PERFORMANCE_INDEX_SQL) database.run(sql, onAlter);
      database.run('SELECT 1', (err: Error | null) => {
        if (migrationError || err) reject(migrationError || err);
        else resolve();
      });
    });
  });
}
