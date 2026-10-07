import { loadDocumentCollections } from './table_catalog';
import { parsePersistedMemoryEmbedding } from '../memory/embedding_identity';
import { isolateLegacyGuardSummaryState } from '../conversation/guard_history';
import { parseCompletionFeedbackFromPersistence } from '../conversation/completion_feedback';
import type { DatabaseSqlWriteSession } from './sql_session';
import { SYSTEM_FLAGS_SETTING, SYSTEM_SNAPSHOTS_SETTING, legacyActionContinuationStates, parseJsonSetting, parseStoredToolCalls, parseStoredActionContinuationState, type LegacySummaryPersistenceRepair } from './persistence_codecs';

function projectPayloadRows(rows: any[], project: (row: any, payload: any) => any, rejectArrays = false): any[] {
  return (rows || []).flatMap(row => {
    try {
      const payload = JSON.parse(row.payload || '{}');
      return payload && typeof payload === 'object' && (!rejectArrays || !Array.isArray(payload))
        ? [project(row, payload)] : [];
    } catch { return []; }
  });
}

function parsePayloadRows(rows: any[]): any[] {
  return projectPayloadRows(rows, (row, payload) => ({
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
          }), true);
}

// Load database and map old column names to field names server.ts expects
export async function hydrateDatabaseProjection(query: DatabaseSqlWriteSession['query']): Promise<{ data: any; legacySummaryRepairs: LegacySummaryPersistenceRepair[] }> {
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

  const data = {
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
    readOnlyToolPatterns: projectPayloadRows(readOnlyToolPatternsRaw, (row, payload) => ({
              ...payload,
              id: row.id,
              userId: row.userId,
              domain: row.domain || 'personal',
              orgId: row.orgId || '',
              confidence: Number(row.confidence) || 0,
              successCount: Number(row.successCount) || 0,
              updatedAt: row.updatedAt,
            })),
    commandCenterPlans: (commandCenterPlansRaw || []).map((row: any) => {
      let membershipAuthorization;
      try { membershipAuthorization = JSON.parse(row.membershipAuthorization || 'null') || undefined; } catch { /* Missing or invalid authority fails closed. */ }
      return { ...row, membershipAuthorization };
    }),
    autonomousTasks: projectPayloadRows(autonomousTasksRaw, (row, task) => ({ ...task, id: row.id, userId: row.userId, status: row.status, leaseExpiresAt: row.leaseExpiresAt || '', updatedAt: row.updatedAt })),
    externalAiHistorySources: projectPayloadRows(externalAiHistorySourcesRaw, (row, payload) => ({ ...payload, id: row.id, userId: row.userId, domain: row.domain || 'personal', orgId: row.orgId || '', sourceKind: row.sourceKind, status: row.status, updatedAt: row.updatedAt })),
    externalAiHistorySyncJobs: projectPayloadRows(externalAiHistorySyncJobsRaw, (row, payload) => ({ ...payload, id: row.id, sourceId: row.sourceId, userId: row.userId, status: row.status, nextCursor: row.nextCursor || '', updatedAt: row.updatedAt })),
    externalAiHistoryConversations: projectPayloadRows(externalAiHistoryConversationsRaw, (row, payload) => ({ ...payload, id: row.id, sourceId: row.sourceId, userId: row.userId, externalConversationId: row.externalConversationId, updatedAt: row.updatedAt })),
    externalAiHistoryMessages: projectPayloadRows(externalAiHistoryMessagesRaw, (row, payload) => ({ ...payload, id: row.id, sourceId: row.sourceId, conversationId: row.conversationId, userId: row.userId, externalMessageId: row.externalMessageId, contentDigest: row.contentDigest, messageAt: row.messageAt || '', updatedAt: row.updatedAt })),
    externalAiHistoryAttachments: projectPayloadRows(externalAiHistoryAttachmentsRaw, (row, payload) => ({ ...payload, id: row.id, sourceId: row.sourceId, messageId: row.messageId, userId: row.userId, externalAttachmentId: row.externalAttachmentId, contentDigest: row.contentDigest || '', updatedAt: row.updatedAt })),
    extensionPublishers: projectPayloadRows(extensionPublishersRaw, (row, payload) => ({ ...payload, fingerprint: row.fingerprint, publisherId: row.publisherId, status: row.status, updatedAt: row.updatedAt })),
    extensionRevisions: projectPayloadRows(extensionRevisionsRaw, (row, payload) => ({
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
            })),
    extensionActivationReceipts: projectPayloadRows(extensionActivationReceiptsRaw, (row, payload) => ({ ...payload, id: row.id, extensionId: row.extensionId, revisionId: row.revisionId, status: row.status, createdAt: row.createdAt })),
    externalCapabilityPackages: projectPayloadRows(externalCapabilityPackagesRaw, (row, payload) => ({
              ...payload,
              id: row.id,
              ownerUserId: row.ownerUserId,
              capabilityId: row.capabilityId,
              version: row.version,
              status: row.status,
              packageDigest: row.packageDigest,
              updatedAt: row.updatedAt,
            })),
    externalCapabilityReceipts: projectPayloadRows(externalCapabilityReceiptsRaw, (row, payload) => ({
              ...payload,
              id: row.id,
              packageRowId: row.packageRowId,
              ownerUserId: row.ownerUserId,
              capabilityId: row.capabilityId,
              actionId: row.actionId || '',
              kind: row.kind,
              status: row.status,
              createdAt: row.createdAt,
            })),
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

  return { data, legacySummaryRepairs };
}
