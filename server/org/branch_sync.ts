import crypto from 'crypto';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import { authorizeOrganizationDevice, registerOrganizationDevice } from './resource_acl';

const SYNC_LEDGER_SETTING = 'org.branch.sync.ledger.v1';
const BRANCH_REGISTRY_SETTING = 'org.branch.registry.v1';
const MAX_BATCH_ITEMS = 1_000;
const MAX_LEDGER_BATCHES = 1_000;
const MAX_LEDGER_ITEMS = 20_000;
const MAX_TEXT_BYTES = 512 * 1024;

type BranchSyncKind = 'memory' | 'interaction' | 'agent';

export interface BranchSyncPayload {
  orgId: string;
  branchId: string;
  batchId: string;
  memories?: unknown[];
  interactions?: unknown[];
  agents?: unknown[];
}

export interface BranchSyncItemReceipt {
  kind: BranchSyncKind;
  sourceId: string;
  targetId: string;
  digest: string;
  outcome: 'inserted' | 'updated' | 'unchanged';
}

export interface BranchSyncReceipt {
  version: 1;
  receiptId: string;
  orgId: string;
  branchId: string;
  batchId: string;
  payloadDigest: string;
  verified: true;
  accepted: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  replayed: boolean;
  items: BranchSyncItemReceipt[];
  persistedAt: string;
}

interface BranchSyncLedgerItem {
  digest: string;
  targetId: string;
  updatedAt: string;
}

interface BranchSyncLedger {
  version: 1;
  batches: Record<string, BranchSyncReceipt>;
  batchOrder: string[];
  items: Record<string, BranchSyncLedgerItem>;
  itemOrder: string[];
}

interface BranchRegistration {
  branchId: string;
  orgId: string;
  userId: string;
  status: 'active';
  registeredAt: string;
  lastRegisteredAt: string;
}

interface NormalizedItem {
  kind: BranchSyncKind;
  sourceId: string;
  targetId: string;
  digest: string;
  value: Record<string, any>;
}

export class BranchSyncValidationError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'BranchSyncValidationError';
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, maxLength = 4_000): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new BranchSyncValidationError(`${field} is required`);
  if (normalized.length > maxLength) {
    throw new BranchSyncValidationError(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value: unknown, maxLength = 4_000): string {
  return String(value || '').trim().slice(0, maxLength);
}

function validateStableId(value: unknown, field: string): string {
  const id = boundedString(value, field, 240);
  if (!/^[\p{L}\p{N}._:@/-]+$/u.test(id)) {
    throw new BranchSyncValidationError(`${field} contains unsupported characters`);
  }
  return id;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter(key => !key.startsWith('_synced'))
      .sort()
      .map(key => [key, canonicalize(value[key])]),
  );
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function targetId(branchId: string, kind: BranchSyncKind, sourceId: string): string {
  const suffix = crypto.createHash('sha256').update(`${branchId}\0${kind}\0${sourceId}`).digest('hex').slice(0, 32);
  return `branch_${kind}_${suffix}`;
}

function referenceId(branchId: string, kind: BranchSyncKind, sourceId: unknown): string {
  const source = String(sourceId || '').trim();
  return source ? targetId(branchId, kind, source) : '';
}

function parseKeywords(value: unknown): string[] {
  let current: any = value;
  if (typeof current === 'string') {
    try { current = JSON.parse(current); } catch { current = current.split(/[,，]/); }
  }
  return Array.from(new Set(
    (Array.isArray(current) ? current : [])
      .map(item => optionalString(item, 120))
      .filter(Boolean),
  )).slice(0, 80);
}

function parseToolCalls(value: unknown): any[] | undefined {
  let current = value;
  if (typeof current === 'string' && current.trim()) {
    try { current = JSON.parse(current); } catch { return undefined; }
  }
  if (!Array.isArray(current)) return undefined;
  return current.slice(0, 80).map(item => canonicalize(item));
}

function assertItemScope(
  item: Record<string, any>,
  input: { orgId: string; userId: string; kind: BranchSyncKind; index: number },
): void {
  if (item.domain !== 'work' || String(item.orgId || '') !== input.orgId) {
    throw new BranchSyncValidationError(`${input.kind}[${input.index}] is outside the registered organization work domain`, 403);
  }
  const claimedUserId = String(item.userId || item.ownerUid || '').trim();
  if (claimedUserId && claimedUserId !== input.userId) {
    throw new BranchSyncValidationError(`${input.kind}[${input.index}] claims a different user identity`, 403);
  }
}

function normalizeMemory(
  raw: unknown,
  index: number,
  context: { orgId: string; branchId: string; userId: string },
): NormalizedItem {
  if (!isObject(raw)) throw new BranchSyncValidationError(`memory[${index}] must be an object`);
  assertItemScope(raw, { ...context, kind: 'memory', index });
  const sourceId = validateStableId(raw.id, `memory[${index}].id`);
  const content = boundedString(raw.content, `memory[${index}].content`, MAX_TEXT_BYTES);
  const createdAt = optionalString(raw.createdAt, 80) || new Date().toISOString();
  const updatedAt = optionalString(raw.updatedAt, 80) || createdAt;
  const value = {
    id: targetId(context.branchId, 'memory', sourceId),
    userId: context.userId,
    type: optionalString(raw.type, 80) || 'episodic',
    content,
    keywords: parseKeywords(raw.keywords),
    confidence: Math.max(0, Math.min(Number(raw.confidence) || 0.5, 1)),
    sourceInteractionId: referenceId(context.branchId, 'interaction', raw.sourceInteractionId),
    createdAt,
    updatedAt,
    lastRetrievedAt: optionalString(raw.lastRetrievedAt, 80) || null,
    retrieveCount: Math.max(0, Math.trunc(Number(raw.retrieveCount) || 0)),
    tier: optionalString(raw.tier, 80) || 'episodic',
    perspective: optionalString(raw.perspective, 80) || 'owner_trait',
    importance: Math.max(0, Math.min(Number(raw.importance) || 0.3, 1)),
    parentId: referenceId(context.branchId, 'memory', raw.parentId) || null,
    agentId: referenceId(context.branchId, 'agent', raw.agentId),
    nodeType: optionalString(raw.nodeType, 40) || 'leaf',
    location: optionalString(raw.location, 300),
    domain: 'work',
    orgId: context.orgId,
  };
  return { kind: 'memory', sourceId, targetId: value.id, digest: digest(raw), value };
}

function normalizeInteraction(
  raw: unknown,
  index: number,
  context: { orgId: string; branchId: string; userId: string },
): NormalizedItem {
  if (!isObject(raw)) throw new BranchSyncValidationError(`interaction[${index}] must be an object`);
  assertItemScope(raw, { ...context, kind: 'interaction', index });
  const sourceId = validateStableId(raw.id, `interaction[${index}].id`);
  const content = boundedString(raw.content || raw.message, `interaction[${index}].message`, MAX_TEXT_BYTES);
  const timestamp = optionalString(raw.timestamp || raw.createdAt, 80) || new Date().toISOString();
  const value = {
    id: targetId(context.branchId, 'interaction', sourceId),
    userId: context.userId,
    agentId: referenceId(context.branchId, 'agent', raw.agentId) || null,
    module: optionalString(raw.module || raw.personality, 120),
    content,
    message: content,
    response: optionalString(raw.response, MAX_TEXT_BYTES),
    role: optionalString(raw.role, 40),
    personality: optionalString(raw.personality || raw.module, 120),
    mode: optionalString(raw.mode, 80),
    toolCalls: parseToolCalls(raw.toolCalls),
    conversationId: referenceId(context.branchId, 'interaction', `conversation:${String(raw.conversationId || sourceId)}`),
    cognitiveIntent: optionalString(raw.cognitiveIntent, 400),
    llmWasCalled: Boolean(raw.llmWasCalled),
    domain: 'work',
    orgId: context.orgId,
    source: `organization_branch:${context.branchId}`,
    channel: optionalString(raw.channel, 80) || 'organization_branch',
    externalMessageId: optionalString(raw.externalMessageId, 240),
    routeSequence: Number.isFinite(Number(raw.routeSequence)) ? Math.trunc(Number(raw.routeSequence)) : undefined,
    receivedAt: optionalString(raw.receivedAt, 80),
    timestamp,
  };
  return { kind: 'interaction', sourceId, targetId: value.id, digest: digest(raw), value };
}

function normalizeAgent(
  raw: unknown,
  index: number,
  context: { orgId: string; branchId: string; userId: string },
): NormalizedItem {
  if (!isObject(raw)) throw new BranchSyncValidationError(`agent[${index}] must be an object`);
  assertItemScope(raw, { ...context, kind: 'agent', index });
  const sourceId = validateStableId(raw.id, `agent[${index}].id`);
  const rawConfig = raw.data ?? raw.config ?? {};
  const config = typeof rawConfig === 'string' ? rawConfig : JSON.stringify(canonicalize(rawConfig));
  if (Buffer.byteLength(config, 'utf8') > MAX_TEXT_BYTES) {
    throw new BranchSyncValidationError(`agent[${index}].config exceeds the size limit`);
  }
  const value = {
    id: targetId(context.branchId, 'agent', sourceId),
    ownerUid: context.userId,
    userId: context.userId,
    name: boundedString(raw.name, `agent[${index}].name`, 160),
    category: optionalString(raw.category, 120) || 'organization',
    data: config || '{}',
    config: config || '{}',
    createdAt: optionalString(raw.createdAt, 80) || new Date().toISOString(),
    status: raw.status === 'offline' ? 'offline' : 'active',
    personalityId: optionalString(raw.personalityId, 120) || 'lumi',
    modelPreference: optionalString(raw.modelPreference, 240),
    memoryScope: raw.memoryScope === 'private' ? 'private' : 'shared',
    autonomyLevel: ['reactive', 'scheduled', 'autonomous'].includes(String(raw.autonomyLevel))
      ? raw.autonomyLevel
      : 'reactive',
    runtimeConfig: '{}',
    // A branch must never upload an executable command for the company server.
    runtime: 'internal',
    externalCommand: '',
    domain: 'work',
    orgId: context.orgId,
  };
  return { kind: 'agent', sourceId, targetId: value.id, digest: digest(raw), value };
}

function parseSetting<T>(db: any, key: string, fallback: T): T {
  const raw = (db.settings || []).find((item: any) => item?.key === key)?.value;
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function writeSetting(db: any, key: string, value: unknown): void {
  if (!Array.isArray(db.settings)) db.settings = [];
  const serialized = JSON.stringify(value);
  const existing = db.settings.find((item: any) => item?.key === key);
  if (existing) existing.value = serialized;
  else db.settings.push({ key, value: serialized });
}

function loadLedger(db: any): BranchSyncLedger {
  const parsed = parseSetting<Partial<BranchSyncLedger>>(db, SYNC_LEDGER_SETTING, {});
  return {
    version: 1,
    batches: isObject(parsed.batches) ? parsed.batches as Record<string, BranchSyncReceipt> : {},
    batchOrder: Array.isArray(parsed.batchOrder) ? parsed.batchOrder.map(String) : [],
    items: isObject(parsed.items) ? parsed.items as Record<string, BranchSyncLedgerItem> : {},
    itemOrder: Array.isArray(parsed.itemOrder) ? parsed.itemOrder.map(String) : [],
  };
}

export function getBranchSyncReceipt(input: {
  orgId: string;
  branchId: string;
  batchId: string;
}): BranchSyncReceipt | null {
  const orgId = validateStableId(input.orgId, 'orgId');
  const branchId = validateStableId(input.branchId, 'branchId');
  const batchId = validateStableId(input.batchId, 'batchId');
  const ledger = loadLedger(readDB());
  return ledger.batches[`${orgId}:${branchId}:${batchId}`] || null;
}

export async function persistBranchRegistration(input: {
  orgId: string;
  branchId: string;
  userId: string;
}): Promise<BranchRegistration> {
  const orgId = validateStableId(input.orgId, 'orgId');
  const branchId = validateStableId(input.branchId, 'branchId');
  const userId = validateStableId(input.userId, 'userId');
  const db = readDB();
  const registry = parseSetting<Record<string, BranchRegistration>>(db, BRANCH_REGISTRY_SETTING, {});
  const existing = registry[branchId];
  if (existing && (existing.orgId !== orgId || existing.userId !== userId)) {
    throw new BranchSyncValidationError(
      'This immutable branch identity is already registered to another organization member',
      409,
    );
  }
  registerOrganizationDevice({ orgId, branchId, userId });

  const now = new Date().toISOString();
  const registration: BranchRegistration = existing
    ? { ...existing, status: 'active', lastRegisteredAt: now }
    : { branchId, orgId, userId, status: 'active', registeredAt: now, lastRegisteredAt: now };
  registry[branchId] = registration;
  writeSetting(db, BRANCH_REGISTRY_SETTING, registry);
  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  db.auditLog.push({
    id: crypto.randomUUID(),
    orgId,
    userId,
    action: existing ? 'branch.session.refreshed' : 'branch.registered',
    resourceType: 'branch',
    resourceId: branchId,
    details: JSON.stringify({ branchId }),
    ipAddress: null,
    userAgent: null,
    timestamp: now,
  });
  writeDB(db);
  await flushDBOrThrow();
  return registration;
}

function trimLedger(ledger: BranchSyncLedger): void {
  ledger.batchOrder = Array.from(new Set(ledger.batchOrder)).slice(-MAX_LEDGER_BATCHES);
  const retainedBatches = new Set(ledger.batchOrder);
  for (const key of Object.keys(ledger.batches)) {
    if (!retainedBatches.has(key)) delete ledger.batches[key];
  }
  ledger.itemOrder = Array.from(new Set(ledger.itemOrder)).slice(-MAX_LEDGER_ITEMS);
  const retainedItems = new Set(ledger.itemOrder);
  for (const key of Object.keys(ledger.items)) {
    if (!retainedItems.has(key)) delete ledger.items[key];
  }
}

function upsertById(values: any[], item: NormalizedItem): 'inserted' | 'updated' {
  const index = values.findIndex(candidate => candidate?.id === item.targetId);
  if (index < 0) {
    values.push(item.value);
    return 'inserted';
  }
  values[index] = item.value;
  return 'updated';
}

function restoreSnapshot(db: any, snapshot: Record<string, any>): void {
  db.memories = snapshot.memories;
  db.interactions = snapshot.interactions;
  db.agents = snapshot.agents;
  db.settings = snapshot.settings;
  db.auditLog = snapshot.auditLog;
  writeDB(db);
}

export async function persistBranchSyncBatch(input: {
  payload: BranchSyncPayload;
  authenticatedUserId: string;
  authenticatedOrgId: string;
  authenticatedBranchId: string;
}): Promise<BranchSyncReceipt> {
  const orgId = validateStableId(input.payload.orgId, 'orgId');
  const branchId = validateStableId(input.payload.branchId, 'branchId');
  const batchId = validateStableId(input.payload.batchId, 'batchId');
  if (orgId !== input.authenticatedOrgId || branchId !== input.authenticatedBranchId) {
    throw new BranchSyncValidationError('Branch sync scope does not match the authenticated branch session', 403);
  }
  authorizeOrganizationDevice({
    orgId,
    branchId,
    userId: input.authenticatedUserId,
    permission: 'sync_write',
  });

  const memories = Array.isArray(input.payload.memories) ? input.payload.memories : [];
  const interactions = Array.isArray(input.payload.interactions) ? input.payload.interactions : [];
  const agents = Array.isArray(input.payload.agents) ? input.payload.agents : [];
  const total = memories.length + interactions.length + agents.length;
  if (total > MAX_BATCH_ITEMS) {
    throw new BranchSyncValidationError(`Branch sync batch exceeds ${MAX_BATCH_ITEMS} items`);
  }

  const context = { orgId, branchId, userId: input.authenticatedUserId };
  const normalized = [
    ...agents.map((item, index) => normalizeAgent(item, index, context)),
    ...interactions.map((item, index) => normalizeInteraction(item, index, context)),
    ...memories.map((item, index) => normalizeMemory(item, index, context)),
  ];
  const payloadDigest = digest(normalized.map(item => ({ kind: item.kind, sourceId: item.sourceId, digest: item.digest })));
  const batchKey = `${orgId}:${branchId}:${batchId}`;
  const db = readDB();
  const ledger = loadLedger(db);
  const existing = ledger.batches[batchKey];
  if (existing) {
    if (existing.payloadDigest !== payloadDigest) {
      throw new BranchSyncValidationError('The batchId was already used with a different payload', 409);
    }
    return { ...existing, replayed: true };
  }

  const snapshot = {
    memories: db.memories,
    interactions: db.interactions,
    agents: db.agents,
    settings: db.settings,
    auditLog: db.auditLog,
  };
  db.memories = [...(db.memories || [])];
  db.interactions = [...(db.interactions || [])];
  db.agents = [...(db.agents || [])];
  db.settings = (db.settings || []).map((item: any) => ({ ...item }));
  db.auditLog = [...(db.auditLog || [])];

  const persistedAt = new Date().toISOString();
  const itemReceipts: BranchSyncItemReceipt[] = [];
  for (const item of normalized) {
    const itemKey = `${orgId}:${branchId}:${item.kind}:${item.sourceId}`;
    const previous = ledger.items[itemKey];
    let outcome: BranchSyncItemReceipt['outcome'];
    if (previous?.digest === item.digest && previous.targetId === item.targetId) {
      outcome = 'unchanged';
    } else {
      const collection = item.kind === 'memory'
        ? db.memories
        : item.kind === 'interaction'
          ? db.interactions
          : db.agents;
      outcome = upsertById(collection, item);
    }
    ledger.items[itemKey] = { digest: item.digest, targetId: item.targetId, updatedAt: persistedAt };
    ledger.itemOrder.push(itemKey);
    itemReceipts.push({
      kind: item.kind,
      sourceId: item.sourceId,
      targetId: item.targetId,
      digest: item.digest,
      outcome,
    });
  }

  const receipt: BranchSyncReceipt = {
    version: 1,
    receiptId: crypto.randomUUID(),
    orgId,
    branchId,
    batchId,
    payloadDigest,
    verified: true,
    accepted: itemReceipts.length,
    inserted: itemReceipts.filter(item => item.outcome === 'inserted').length,
    updated: itemReceipts.filter(item => item.outcome === 'updated').length,
    unchanged: itemReceipts.filter(item => item.outcome === 'unchanged').length,
    rejected: 0,
    replayed: false,
    items: itemReceipts,
    persistedAt,
  };
  ledger.batches[batchKey] = receipt;
  ledger.batchOrder.push(batchKey);
  trimLedger(ledger);
  writeSetting(db, SYNC_LEDGER_SETTING, ledger);
  db.auditLog.push({
    id: crypto.randomUUID(),
    orgId,
    userId: input.authenticatedUserId,
    action: 'branch.sync.persisted',
    resourceType: 'branch_sync_batch',
    resourceId: batchId,
    details: JSON.stringify({
      branchId,
      payloadDigest,
      accepted: receipt.accepted,
      inserted: receipt.inserted,
      updated: receipt.updated,
      unchanged: receipt.unchanged,
    }),
    ipAddress: null,
    userAgent: null,
    timestamp: persistedAt,
  });

  try {
    writeDB(db);
    await flushDBOrThrow();
    return receipt;
  } catch (error) {
    restoreSnapshot(db, snapshot);
    throw error;
  }
}
