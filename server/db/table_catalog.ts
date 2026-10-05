/** Existing SQL projections plus explicitly persisted former transient collections. */
export const DATABASE_TABLES = ["users","interactions","memories","memoryAvatars","reminders","conversations","conversationActionTasks","conversationActionTurns","conversationActionReceipts","modelRoutingReceipts","readOnlyToolPatterns","commandCenterPlans","autonomousTasks","externalAiHistorySources","externalAiHistorySyncJobs","externalAiHistoryConversations","externalAiHistoryMessages","externalAiHistoryAttachments","extensionPublishers","extensionRevisions","extensionActivationReceipts","externalCapabilityPackages","externalCapabilityReceipts","canvas_sessions","marketplaceSkills","skills","settings","systemFlags","systemSnapshots","voiceProfiles","tokenUsage","organizations","departments","orgMemberships","orgPositions","orgWorkRoutingRules","orgWorkItems","orgWorkApprovals","orgWorkHandoffs","orgResourcePolicies","orgResourceGrants","orgCredentialReferences","orgDevices","orgInvitations","orgKbArticles","orgKbEmbeddings","notifications","auditLog","founderVision","founderVisionUpdatedAt","workflows","contacts","plans","professionProfiles","autonomousWorkflows","migrations","communitySkills","skillDownloads","skillRatings","memoryAssociations","branchState","skillTranslations","knowledgeFiles","workProductPlans","workTakeoverTasks"] as const;
export type DatabaseTableName = typeof DATABASE_TABLES[number];
export const DOCUMENT_COLLECTION_DEFAULTS = {
  "workflows": [],
  "contacts": [],
  "plans": [],
  "professionProfiles": [],
  "autonomousWorkflows": [],
  "migrations": {},
  "communitySkills": [],
  "skillDownloads": {},
  "skillRatings": [],
  "memoryAssociations": [],
  "branchState": null,
  "skillTranslations": {},
  "knowledgeFiles": [],
  "workProductPlans": [],
  "workTakeoverTasks": []
} as Record<string, any>;
export const documentCollectionKey = (name: string) => '__lumi_collection:' + name;
export function loadDocumentCollections(settings: {key:string;value:string}[]): Record<string, any> {
  return Object.fromEntries(Object.entries(DOCUMENT_COLLECTION_DEFAULTS).map(([name, fallback]) => {
    let value = fallback;
    try { const stored = settings.find(row => row.key === documentCollectionKey(name)); if (stored) { const parsed = JSON.parse(stored.value); if (Array.isArray(fallback) ? Array.isArray(parsed) : fallback === null ? parsed === null || typeof parsed === 'object' : parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } } catch { /* Invalid legacy data never grants a wider scope. */ }
    return [name, structuredClone(value)];
  }));
}
