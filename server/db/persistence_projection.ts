import type { SnapshotProjection } from './snapshot_changes';
import { DOCUMENT_COLLECTION_DEFAULTS, documentCollectionKey } from './table_catalog';
import { hasCurrentMemoryEmbedding } from '../memory/embedding_identity';
import { serializeCompletionFeedbackForPersistence } from '../conversation/completion_feedback';
import { SYSTEM_FLAGS_SETTING, SYSTEM_SNAPSHOTS_SETTING, legacyActionContinuationStates, serializeStoredToolCalls, serializeStoredActionContinuationState } from './persistence_codecs';

/** Table projections share one transaction; schema belongs to initialization/migrations. */
export interface PersistenceTableSpec extends SnapshotProjection {
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

export function buildPersistenceTableSpecs(readRoot: () => any): PersistenceTableSpec[] {
  function* settingsRowsWithSystemState(items?: any[]): Iterable<any[]> {
    const settings = items || (Array.isArray(readRoot()?.settings) ? readRoot().settings : []);
    for (const setting of settings) {
      if (setting?.key !== SYSTEM_FLAGS_SETTING && setting?.key !== SYSTEM_SNAPSHOTS_SETTING && !Object.keys(DOCUMENT_COLLECTION_DEFAULTS).some(name => setting?.key === documentCollectionKey(name))) yield [setting.key, setting.value];
    }

    if (!items) yield* systemStateRows();
  }

  function* systemStateRows(): Iterable<any[]> {
    for (const [name, fallback] of Object.entries(DOCUMENT_COLLECTION_DEFAULTS)) {
      const value = readRoot()?.[name] ?? fallback;
      if (JSON.stringify(value) !== JSON.stringify(fallback)) yield [documentCollectionKey(name), JSON.stringify(value)];
    }
    if (readRoot()?.systemFlags && Object.keys(readRoot().systemFlags).length > 0) {
      yield [SYSTEM_FLAGS_SETTING, JSON.stringify(readRoot().systemFlags)];
    }

    if (Array.isArray(readRoot()?.systemSnapshots) && readRoot().systemSnapshots.length > 0) {
      yield [SYSTEM_SNAPSHOTS_SETTING, JSON.stringify(readRoot().systemSnapshots.slice(-120))];
    }

  }

  function arrayTable(
    name: string, source: string, columns: string, project: (row: any) => any[],
  ): PersistenceTableSpec {
    const placeholders = columns.split(', ').map(() => '?').join(', ');
    return {
      name, source,
      insertSQL: 'INSERT INTO ' + name + ' (' + columns + ') VALUES (' + placeholders + ')',
      *rows(items = readRoot()[source] || []) {
        for (const row of items) yield project(row);
      },
    };
  }

  const specs: PersistenceTableSpec[] = [
    arrayTable("users", "users",
      "uid, username, password, role, balance, phone, createdAt",
      (u: any) => [u.uid, u.username, u.password, u.role, u.balance, u.phone || '', u.createdAt]),
    arrayTable("interactions", "interactions",
      "id, userId, agentId, module, message, response, role, personality, mode, toolCalls, conversationId, cognitiveIntent, llmWasCalled, completionFeedback, domain, orgId, source, channel, externalMessageId, routeSequence, receivedAt, requestId, nativeDeviceId, executionSessionId, nativeClientIdentitySha256, audioInputKind, syntheticAudio, captureSessionId, sttReceiptId, contextChainId, previousRequestId, timestamp",
      (i: any) => [i.id, i.userId || 'unknown', i.agentId || null, i.personality || i.module || null, i.content || i.message || '', i.response || '', i.role || '', i.personality || '', i.mode || '', serializeStoredToolCalls(i.toolCalls, i.mode), i.conversationId || '', i.cognitiveIntent || '', i.llmWasCalled ? 1 : 0, serializeCompletionFeedbackForPersistence(i.completionFeedback), i.domain || 'personal', i.orgId || '', i.source || '', i.channel || '', i.externalMessageId || '', Number.isFinite(i.routeSequence) ? i.routeSequence : null, i.receivedAt || '', i.requestId || i.externalMessageId || '', i.nativeDeviceId || '', i.executionSessionId || '', i.nativeClientIdentitySha256 || '', i.audioInputKind || '', i.syntheticAudio === true ? 1 : i.syntheticAudio === false ? 0 : null, i.captureSessionId || '', i.sttReceiptId || '', i.contextChainId || '', i.previousRequestId || '', i.timestamp]),
    arrayTable("memories", "memories",
      "id, userId, type, content, keywords, confidence, sourceInteractionId, createdAt, updatedAt, lastRetrievedAt, retrieveCount, tier, perspective, importance, parentId, agentId, nodeType, location, domain, orgId, embedding, embeddingNamespace, embeddingContentHash",
      (m: any) => { const indexed = hasCurrentMemoryEmbedding(m); return [m.id, m.userId, m.type, m.content, JSON.stringify(m.keywords || []), m.confidence || 0.5, m.sourceInteractionId || '', m.createdAt, m.updatedAt, m.lastRetrievedAt, m.retrieveCount || 0, m.tier || 'episodic', m.perspective || 'owner_trait', m.importance ?? 0.3, m.parentId || null, m.agentId || '', m.nodeType || 'leaf', m.location || '', m.domain || 'personal', m.orgId || '', indexed ? JSON.stringify(m.embedding) : null, indexed ? JSON.stringify(m.embeddingNamespace) : null, indexed ? m.embeddingContentHash : null]; }),
    arrayTable("memory_avatars", "memoryAvatars",
      "id, userId, name, relationshipType, status, payload, createdAt, updatedAt",
      (avatar: any) => [
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
      ]),
    arrayTable("reminders", "reminders",
      "id, userId, content, dueAt, status, sourceInteractionId, createdAt, firedAt, domain, orgId",
      (r: any) => [r.id, r.userId, r.content, r.dueAt || null, r.status || 'pending', r.sourceInteractionId || '', r.createdAt, r.firedAt || null, r.domain || 'personal', r.orgId || '']),
    arrayTable("conversations", "conversations",
      "id, userId, agentId, title, status, summary, summaryChain, lastSummaryMessageCount, actionContinuationState, messageCount, lastActiveAt, createdAt, domain, orgId",
      (c: any) => [c.id, c.userId, c.agentId || '', c.title || '', c.status || 'active', c.summary || '', JSON.stringify(Array.isArray(c.summaryChain) ? c.summaryChain : []), Number.isFinite(Number(c.lastSummaryMessageCount)) ? Math.floor(Number(c.lastSummaryMessageCount)) : -1, serializeStoredActionContinuationState(legacyActionContinuationStates.get(c)), c.messageCount || 0, c.lastActiveAt, c.createdAt, c.domain || 'personal', c.orgId || '']),
    arrayTable("conversation_action_tasks", "conversationActionTasks",
      "id, conversationId, userId, domain, orgId, parentTaskId, rootUserMessageId, intentKind, operation, goal, target, status, blocker, activeRequestId, completionSource, context, revision, createdAt, updatedAt, completedAt",
      (t: any) => [t.id, t.conversationId, t.userId, t.domain || 'personal', t.orgId || '', t.parentTaskId || '', t.rootUserMessageId || '', t.intentKind || 'none', t.operation || 'read', t.goal || '', t.target || '', t.status || 'planning', t.blocker || '', t.activeRequestId || '', t.completionSource || '', typeof t.context === 'string' ? t.context : JSON.stringify(t.context || {}), Number(t.revision) || 1, t.createdAt, t.updatedAt, t.completedAt || '']),
    arrayTable("conversation_action_turns", "conversationActionTurns",
      "id, conversationId, userId, domain, orgId, requestId, userMessageId, taskId, channel, source, status, leaseOwnerId, leaseEpoch, leaseAcquiredAt, leaseHeartbeatAt, leaseExpiresAt, terminalMessageId, terminalReason, recoveryReason, recoveredAt, revision, createdAt, updatedAt, terminalAt",
      (turn: any) => [turn.id, turn.conversationId, turn.userId, turn.domain || 'personal', turn.orgId || '', turn.requestId || '', turn.userMessageId || '', turn.taskId || '', turn.channel || '', turn.source || '', turn.status || 'accepted', turn.leaseOwnerId || '', turn.leaseEpoch || '', turn.leaseAcquiredAt || '', turn.leaseHeartbeatAt || '', turn.leaseExpiresAt || '', turn.terminalMessageId || '', turn.terminalReason || '', turn.recoveryReason || '', turn.recoveredAt || '', Number(turn.revision) || 1, turn.createdAt, turn.updatedAt, turn.terminalAt || '']),
    arrayTable("conversation_action_receipts", "conversationActionReceipts",
      "id, taskId, conversationId, turnId, requestId, turnRowId, externalMessageId, modelRoutingReceiptId, executionOrigin, idempotencyKey, toolName, targetIdentity, inputDigest, envelope, outcome, createdAt",
      (r: any) => [r.id, r.taskId, r.conversationId, r.turnId || '', r.requestId || '', r.turnRowId || '', r.externalMessageId || '', r.modelRoutingReceiptId || '', r.executionOrigin || '', r.idempotencyKey || '', r.toolName || '', r.targetIdentity || '', r.inputDigest || '', typeof r.envelope === 'string' ? r.envelope : JSON.stringify(r.envelope || {}), r.outcome || 'failed', r.createdAt]),
    arrayTable("model_routing_receipts", "modelRoutingReceipts",
      "id, userId, domain, orgId, conversationId, requestId, nativeDeviceId, executionSessionId, nativeClientIdentitySha256, audioInputKind, syntheticAudio, captureSessionId, sttReceiptId, contextChainId, previousRequestId, interactionId, source, status, requestedProvider, requestedModel, selectionMode, selectedProvider, selectedModel, fallbackReason, attempts, startedAt, completedAt, durationMs",
      (receipt: any) => [
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
      ]),
    arrayTable("read_only_tool_patterns", "readOnlyToolPatterns",
      "id, userId, domain, orgId, confidence, successCount, updatedAt, payload",
      (pattern: any) => [
        pattern.id,
        pattern.userId,
        pattern.domain || 'personal',
        pattern.orgId || '',
        Number(pattern.confidence) || 0,
        Number(pattern.successCount) || 0,
        persistenceTimestamp(pattern.updatedAt, pattern.createdAt),
        JSON.stringify(pattern),
      ]),
    arrayTable("command_center_plans", "commandCenterPlans",
      "id, userId, domain, orgId, conversationId, kind, title, instruction, cadence, timeOfDay, dayOfWeek, dayOfMonth, status, nextRunAt, lastRunAt, lastRuntimeTaskId, createdAt, updatedAt, membershipAuthorization, authorizationBlockedReason",
      (plan: any) => [
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
      ]),
    arrayTable("autonomous_tasks", "autonomousTasks",
      "id, userId, status, leaseExpiresAt, updatedAt, payload",
      (task: any) => [
        task.id,
        task.userId,
        task.status || 'pending',
        task.leaseExpiresAt || '',
        persistenceTimestamp(task.updatedAt, task.createdAt),
        JSON.stringify(task),
      ]),
    arrayTable("external_ai_history_sources", "externalAiHistorySources",
      "id, userId, domain, orgId, sourceKind, status, updatedAt, payload",
      (source: any) => [
        source.id,
        source.userId,
        source.domain || 'personal',
        source.orgId || '',
        source.sourceKind,
        source.status || 'active',
        persistenceTimestamp(source.updatedAt, source.createdAt),
        JSON.stringify(source),
      ]),
    arrayTable("external_ai_history_sync_jobs", "externalAiHistorySyncJobs",
      "id, sourceId, userId, status, nextCursor, updatedAt, payload",
      (job: any) => [
        job.id,
        job.sourceId,
        job.userId,
        job.status || 'pending',
        job.nextCursor || '',
        persistenceTimestamp(job.updatedAt, job.createdAt),
        JSON.stringify(job),
      ]),
    arrayTable("external_ai_history_conversations", "externalAiHistoryConversations",
      "id, sourceId, userId, externalConversationId, updatedAt, payload",
      (conversation: any) => [
        conversation.id,
        conversation.sourceId,
        conversation.userId,
        conversation.externalConversationId,
        persistenceTimestamp(conversation.updatedAt, conversation.createdAt),
        JSON.stringify(conversation),
      ]),
    arrayTable("external_ai_history_messages", "externalAiHistoryMessages",
      "id, sourceId, conversationId, userId, externalMessageId, contentDigest, messageAt, updatedAt, payload",
      (message: any) => [
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
    arrayTable("external_ai_history_attachments", "externalAiHistoryAttachments",
      "id, sourceId, messageId, userId, externalAttachmentId, contentDigest, updatedAt, payload",
      (attachment: any) => [
        attachment.id,
        attachment.sourceId,
        attachment.messageId,
        attachment.userId,
        attachment.externalAttachmentId,
        attachment.contentDigest || '',
        persistenceTimestamp(attachment.updatedAt, attachment.createdAt),
        JSON.stringify(attachment),
      ]),
    arrayTable("extension_publishers", "extensionPublishers",
      "fingerprint, publisherId, status, updatedAt, payload",
      (publisher: any) => [
        publisher.fingerprint,
        publisher.publisherId,
        publisher.status || 'trusted',
        persistenceTimestamp(publisher.updatedAt, publisher.createdAt),
        JSON.stringify(publisher),
      ]),
    arrayTable("extension_revisions", "extensionRevisions",
      "id, extensionId, userId, version, kind, status, manifestDigest, signerFingerprint, updatedAt, payload",
      (revision: any) => [
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
    arrayTable("extension_activation_receipts", "extensionActivationReceipts",
      "id, extensionId, revisionId, status, createdAt, payload",
      (receipt: any) => [
        receipt.id,
        receipt.extensionId,
        receipt.revisionId,
        receipt.status || 'unknown',
        persistenceTimestamp(receipt.createdAt),
        JSON.stringify(receipt),
      ]),
    arrayTable("external_capability_packages", "externalCapabilityPackages",
      "id, ownerUserId, capabilityId, version, status, packageDigest, updatedAt, payload",
      (capability: any) => [
        capability.id,
        capability.ownerUserId,
        capability.capabilityId,
        capability.version,
        capability.status || 'reviewed',
        capability.packageDigest,
        persistenceTimestamp(capability.updatedAt, capability.createdAt),
        JSON.stringify(capability),
      ]),
    arrayTable("external_capability_receipts", "externalCapabilityReceipts",
      "id, packageRowId, ownerUserId, capabilityId, actionId, kind, status, createdAt, payload",
      (receipt: any) => [
        receipt.id,
        receipt.packageRowId,
        receipt.ownerUserId,
        receipt.capabilityId,
        receipt.actionId || '',
        receipt.kind,
        receipt.status || 'unknown',
        persistenceTimestamp(receipt.createdAt),
        JSON.stringify(receipt),
      ]),
    arrayTable("canvas_sessions", "canvas_sessions",
      "id, userId, title, cards, edges, taskText, status, domain, orgId, createdAt, updatedAt",
      (s: any) => [s.id, s.userId, s.title || '', s.cards || '[]', s.edges || '[]', s.taskText || '', s.status || 'active', s.domain || 'personal', s.orgId || '', s.createdAt, s.updatedAt]),
    arrayTable("marketplace_skills", "marketplaceSkills",
      "id, name, author, price, description, category",
      (s: any) => [s.id, s.name, s.author, s.price, s.description, s.category]),
    arrayTable("skills", "skills",
      "id, name, description",
      (s: any) => [s.id, s.name, s.description]),
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
        for (const [userId, profiles] of Object.entries(readRoot().voiceProfiles || {})) {
          for (const vp of profiles as any[]) yield [userId, vp.voiceId, vp.name, vp.provider, vp.createdAt];
        }
      },
    },
    arrayTable("token_usage", "tokenUsage",
      "id, userId, provider, model, promptTokens, completionTokens, totalTokens, mode, interactionId, timestamp",
      (u: any) => [u.id, u.userId, u.provider, u.model, u.promptTokens, u.completionTokens, u.totalTokens, u.mode || 'chat', u.interactionId || '', u.timestamp]),
    arrayTable("organizations", "organizations",
      "id, name, slug, ownerUid, settings, createdAt, updatedAt",
      (o: any) => [o.id, o.name, o.slug, o.ownerUid, o.settings || '{}', o.createdAt, o.updatedAt]),
    arrayTable("departments", "departments",
      "id, orgId, name, parentId, createdAt",
      (d: any) => [d.id, d.orgId, d.name, d.parentId || null, d.createdAt]),
    arrayTable("org_memberships", "orgMemberships",
      "id, orgId, userId, role, departmentId, status, invitedBy, joinedAt, createdAt",
      (m: any) => [m.id, m.orgId, m.userId, m.role || 'member', m.departmentId || null, m.status || 'active', m.invitedBy || null, m.joinedAt || null, m.createdAt]),
    arrayTable("org_positions", "orgPositions",
      "id, orgId, departmentId, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.departmentId || null, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_work_routing_rules", "orgWorkRoutingRules",
      "id, orgId, enabled, priority, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.enabled === false ? 0 : 1, Number(item.priority) || 0, JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_work_items", "orgWorkItems",
      "id, orgId, idempotencyKey, requestId, source, requesterUserId, conversationId, taskId, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.idempotencyKey, item.requestId, item.source, item.requesterUserId, item.conversationId || '', item.taskId || '', item.status, JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_work_approvals", "orgWorkApprovals",
      "id, orgId, workItemId, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.workItemId, item.status, JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_work_handoffs", "orgWorkHandoffs",
      "id, orgId, workItemId, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.workItemId, item.status, JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_resource_policies", "orgResourcePolicies",
      "id, orgId, resourceType, resourceId, classification, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.resourceType, item.resourceId, item.classification || 'organization', item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_resource_grants", "orgResourceGrants",
      "id, orgId, resourceType, resourceId, subjectType, subjectId, effect, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.resourceType, item.resourceId, item.subjectType, item.subjectId, item.effect || 'allow', JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_credential_references", "orgCredentialReferences",
      "id, orgId, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_devices", "orgDevices",
      "id, orgId, branchId, userId, status, payload, createdAt, updatedAt",
      (item: any) => [item.id, item.orgId, item.branchId, item.userId, item.status || 'active', JSON.stringify(item), item.createdAt, item.updatedAt]),
    arrayTable("org_invitations", "orgInvitations",
      "id, orgId, code, createdBy, role, departmentId, maxUses, useCount, expiresAt, createdAt",
      (inv: any) => [inv.id, inv.orgId, inv.code, inv.createdBy, inv.role || 'member', inv.departmentId || null, inv.maxUses || 0, inv.useCount || 0, inv.expiresAt || null, inv.createdAt]),
    arrayTable("org_kb_articles", "orgKbArticles",
      "id, orgId, title, content, category, tags, authorId, status, viewCount, createdAt, updatedAt, ingestionManifest",
      (a: any) => [a.id, a.orgId, a.title, a.content, a.category || 'general', a.tags || '[]', a.authorId, a.status || 'published', a.viewCount || 0, a.createdAt, a.updatedAt, a.ingestionManifest || '{}']),
    arrayTable("org_kb_embeddings", "orgKbEmbeddings",
      "id, articleId, chunkIndex, embedding, content, modelName, createdAt",
      (e: any) => [e.id, e.articleId, e.chunkIndex, e.embedding, e.content, e.modelName || 'text-embedding-3-small', e.createdAt]),
    arrayTable("notifications", "notifications",
      "id, userId, type, title, message, read, timestamp",
      (n: any) => [n.id, n.userId, n.type || 'info', n.title || '', n.message || '', n.read ? 1 : 0, n.timestamp]),
    arrayTable("audit_log", "auditLog",
      "id, orgId, userId, action, resourceType, resourceId, details, ipAddress, userAgent, timestamp",
      (l: any) => [l.id, l.orgId, l.userId, l.action, l.resourceType, l.resourceId, l.details || '{}', l.ipAddress || null, l.userAgent || null, l.timestamp]),
  ];

  // Special handling: founder_vision is a single row
  const founderSpec: PersistenceTableSpec = {
    name: 'founder_vision',
    dependencies: ['founderVision', 'founderVisionUpdatedAt'],
    insertSQL: `INSERT INTO founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
    rows: () => readRoot().founderVision
      ? [[1, readRoot().founderVision, persistenceTimestamp(readRoot().founderVisionUpdatedAt)]]
      : [],
  };

  return [...specs, founderSpec];
}
