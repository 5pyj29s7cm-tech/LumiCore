import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readDB, writeDB } from '../../db_layer';
import { runWithVision, parseScreenshotBase64 } from '../llm/adapter';
import { ensureLocalModelReady, getLocalModelConfig, type LocalModelProvider } from '../llm/local_models';
import {
  DEFAULT_VISION_MODELS,
  getUserPreferredVision,
  type VisionProvider,
} from '../llm/vision_preferences';
import type { NormalizedMessage } from '../llm/providers';
import type { CapabilityManifestEntry, ToolContext } from '../tools/types';

export type ExternalAiHistorySourceKind = 'connector' | 'export' | 'authorized_session' | 'desktop_visible';
export type ExternalAiHistoryScope =
  | 'conversation_list'
  | 'message_metadata'
  | 'message_content'
  | 'attachment_metadata'
  | 'attachment_content';
export type ExternalAiHistoryCompleteness = 'complete' | 'incremental' | 'partial' | 'partial_visible' | 'unknown';
export type ExternalAiHistorySourceStatus = 'active' | 'revoked' | 'expired';
export type ExternalAiHistoryJobStatus = 'pending' | 'running' | 'partial' | 'completed' | 'interrupted' | 'blocked' | 'failed';

const ALL_SCOPES = new Set<ExternalAiHistoryScope>([
  'conversation_list',
  'message_metadata',
  'message_content',
  'attachment_metadata',
  'attachment_content',
]);
const EXPORT_MAX_BYTES = Math.max(1_048_576, Number(process.env.LUMI_EXTERNAL_AI_EXPORT_MAX_BYTES) || 64 * 1024 * 1024);
const MAX_PAGE_SIZE = 200;
const MAX_PAGES_PER_RUN = 50;
const syncExecutions = new Map<string, Promise<string>>();

export interface ExternalAiHistorySource {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  sourceKind: ExternalAiHistorySourceKind;
  targetId: string;
  status: ExternalAiHistorySourceStatus;
  scopes: ExternalAiHistoryScope[];
  allowAllConversations: boolean;
  allowedConversationIds: string[];
  connectorToolName?: string;
  exportPath?: string;
  sessionProfileId?: string;
  allowCloudVision: boolean;
  since?: string;
  until?: string;
  expiresAt?: string;
  authorizationDigest: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  lastSyncAt?: string;
  lastMessageAt?: string;
  lastJobId?: string;
}

export interface ExternalAiHistorySourceEvidence {
  sourceId: string;
  sourceKind: ExternalAiHistorySourceKind;
  targetId: string;
  fetchedAt: string;
  pageCursor: string;
  pageNumber: number;
  completeness: ExternalAiHistoryCompleteness;
  connectorToolName?: string;
  exportPathDigest?: string;
  sessionProfileId?: string;
  screenshotDigest?: string;
  activeWindow?: unknown;
  extractionProvider?: string;
  extractionModel?: string;
  limitations: string[];
}

export interface ExternalAiHistorySyncJob {
  id: string;
  sourceId: string;
  userId: string;
  status: ExternalAiHistoryJobStatus;
  nextCursor: string;
  pageCount: number;
  counts: {
    inserted: number;
    updated: number;
    skipped: number;
    conflicted: number;
    attachments: number;
  };
  completeness: ExternalAiHistoryCompleteness;
  limitations: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  blocker?: string;
  error?: string;
}

export interface ExternalAiHistoryConversation {
  id: string;
  sourceId: string;
  userId: string;
  externalConversationId: string;
  title: string;
  createdAt?: string;
  messageCount: number;
  sourceEvidence: ExternalAiHistorySourceEvidence;
  updatedAt: string;
}

export interface ExternalAiHistoryMessage {
  id: string;
  sourceId: string;
  conversationId: string;
  userId: string;
  externalMessageId: string;
  sourceExternalMessageId: string;
  role: string;
  content: string;
  contentDigest: string;
  messageAt: string;
  version: number;
  conflict: boolean;
  sourceEvidence: ExternalAiHistorySourceEvidence;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAiHistoryAttachment {
  id: string;
  sourceId: string;
  messageId: string;
  userId: string;
  externalAttachmentId: string;
  sourceExternalAttachmentId: string;
  name: string;
  mimeType: string;
  size?: number;
  sourceUrl?: string;
  localPath?: string;
  textContent?: string;
  contentDigest: string;
  sourceEvidence: ExternalAiHistorySourceEvidence;
  createdAt: string;
  updatedAt: string;
}

interface RawAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  sourceUrl?: string;
  localPath?: string;
  textContent?: string;
}

interface RawMessage {
  id?: string;
  role?: string;
  content?: string;
  createdAt?: string;
  attachments?: RawAttachment[];
}

interface RawConversation {
  id?: string;
  title?: string;
  createdAt?: string;
  messages?: RawMessage[];
}

interface ExternalAiHistoryPage {
  conversations: RawConversation[];
  nextCursor: string;
  hasMore: boolean;
  completeness: ExternalAiHistoryCompleteness;
  limitations: string[];
  evidence?: Partial<ExternalAiHistorySourceEvidence>;
}

interface ExternalAiHistoryRuntimeOverrides {
  connector?: (
    source: ExternalAiHistorySource,
    cursor: string,
    pageSize: number,
    context?: ToolContext,
  ) => Promise<unknown>;
  desktopVisible?: (source: ExternalAiHistorySource, context?: ToolContext) => Promise<ExternalAiHistoryPage>;
}

let runtimeOverrides: ExternalAiHistoryRuntimeOverrides | null = null;

export function configureExternalAiHistoryRuntimeForTests(overrides: ExternalAiHistoryRuntimeOverrides | null): void {
  runtimeOverrides = overrides;
}

function nowIso(): string {
  return new Date().toISOString();
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function normalizeId(value: unknown, limit = 160): string {
  return String(value || '').trim().slice(0, limit);
}

function canonicalTargetId(value: unknown): string {
  return normalizeId(value, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseDate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(timestamp).toISOString();
  }
  const text = normalizeId(value, 64);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date value: ${text}`);
  return new Date(timestamp).toISOString();
}

function arrays(db: any): {
  sources: ExternalAiHistorySource[];
  jobs: ExternalAiHistorySyncJob[];
  conversations: ExternalAiHistoryConversation[];
  messages: ExternalAiHistoryMessage[];
  attachments: ExternalAiHistoryAttachment[];
} {
  if (!Array.isArray(db.externalAiHistorySources)) db.externalAiHistorySources = [];
  if (!Array.isArray(db.externalAiHistorySyncJobs)) db.externalAiHistorySyncJobs = [];
  if (!Array.isArray(db.externalAiHistoryConversations)) db.externalAiHistoryConversations = [];
  if (!Array.isArray(db.externalAiHistoryMessages)) db.externalAiHistoryMessages = [];
  if (!Array.isArray(db.externalAiHistoryAttachments)) db.externalAiHistoryAttachments = [];
  return {
    sources: db.externalAiHistorySources,
    jobs: db.externalAiHistorySyncJobs,
    conversations: db.externalAiHistoryConversations,
    messages: db.externalAiHistoryMessages,
    attachments: db.externalAiHistoryAttachments,
  };
}

function contextScope(context?: ToolContext): { userId: string; domain: 'personal' | 'work'; orgId: string } {
  return {
    userId: normalizeId(context?.userId || 'anonymous', 160),
    domain: context?.domain === 'work' ? 'work' : 'personal',
    orgId: context?.domain === 'work' ? normalizeId(context?.orgId, 160) : '',
  };
}

function sourceBelongsToContext(source: ExternalAiHistorySource, context?: ToolContext): boolean {
  const scope = contextScope(context);
  return source.userId === scope.userId && source.domain === scope.domain && source.orgId === scope.orgId;
}

function rejectSecrets(value: unknown, pathName = 'source'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:token|secret|password|cookie|authorization|api[_-]?key|credential)/i.test(key)) {
      throw new Error(`${pathName}.${key} is not allowed. Register only a connector name or authorized session profile id; credentials stay in the provider credential store.`);
    }
    if (child && typeof child === 'object') rejectSecrets(child, `${pathName}.${key}`);
  }
}

function normalizeScopes(value: unknown): ExternalAiHistoryScope[] {
  const requested = Array.isArray(value) ? value : [];
  const scopes = [...new Set(requested.map(item => normalizeId(item, 80))
    .filter((item): item is ExternalAiHistoryScope => ALL_SCOPES.has(item as ExternalAiHistoryScope)))];
  if (!scopes.includes('conversation_list') || !scopes.includes('message_metadata')) {
    throw new Error('History authorization requires conversation_list and message_metadata scopes.');
  }
  if (scopes.includes('attachment_content') && !scopes.includes('attachment_metadata')) {
    throw new Error('attachment_content requires attachment_metadata scope.');
  }
  return scopes;
}

function sourceBinding(input: Omit<ExternalAiHistorySource, 'id' | 'status' | 'authorizationDigest' | 'createdAt' | 'updatedAt'>): Record<string, unknown> {
  return {
    userId: input.userId,
    domain: input.domain,
    orgId: input.orgId,
    sourceKind: input.sourceKind,
    targetId: input.targetId,
    scopes: [...input.scopes].sort(),
    allowAllConversations: input.allowAllConversations,
    allowedConversationIds: [...input.allowedConversationIds].sort(),
    connectorToolName: input.connectorToolName || '',
    exportPath: input.exportPath || '',
    sessionProfileId: input.sessionProfileId || '',
    allowCloudVision: input.allowCloudVision,
    since: input.since || '',
    until: input.until || '',
    expiresAt: input.expiresAt || '',
  };
}

function sourceIsUsable(source: ExternalAiHistorySource): { ok: boolean; blocker?: string } {
  if (source.status === 'revoked') return { ok: false, blocker: 'authorization_revoked' };
  if (source.expiresAt && Date.parse(source.expiresAt) <= Date.now()) {
    source.status = 'expired';
    source.updatedAt = nowIso();
    return { ok: false, blocker: 'authorization_expired' };
  }
  if (source.status !== 'active') return { ok: false, blocker: `source_${source.status}` };
  return { ok: true };
}

export function registerExternalAiHistorySource(args: Record<string, any>, context?: ToolContext): string {
  if (context?.userConfirmed !== true) throw new Error('Registering an external AI history source requires explicit confirmation.');
  rejectSecrets(args);
  const scope = contextScope(context);
  const sourceKind = normalizeId(args.sourceKind, 40) as ExternalAiHistorySourceKind;
  if (!['connector', 'export', 'authorized_session', 'desktop_visible'].includes(sourceKind)) {
    throw new Error('sourceKind must be connector, export, authorized_session, or desktop_visible.');
  }
  const targetId = canonicalTargetId(args.targetId || args.target);
  if (!targetId) throw new Error('targetId is required.');
  const scopes = normalizeScopes(args.scopes);
  const allowAllConversations = args.allowAllConversations === true;
  const allowedConversationIds = [...new Set((Array.isArray(args.allowedConversationIds) ? args.allowedConversationIds : [])
    .map((item: unknown) => normalizeId(item, 240)).filter(Boolean))];
  if (!allowAllConversations && allowedConversationIds.length === 0) {
    throw new Error('Authorize either allowAllConversations=true or at least one allowedConversationIds entry.');
  }
  const connectorToolName = normalizeId(args.connectorToolName, 160) || undefined;
  const sessionProfileId = normalizeId(args.sessionProfileId, 160) || undefined;
  let exportPath: string | undefined;
  if (sourceKind === 'export') {
    const rawPath = normalizeId(args.exportPath, 2_048);
    if (!rawPath) throw new Error('exportPath is required for export sources.');
    exportPath = path.resolve(rawPath);
  } else if (args.exportPath) {
    throw new Error('exportPath is only valid for export sources.');
  }
  if (sourceKind === 'connector' && !connectorToolName) throw new Error('connectorToolName is required for connector sources.');
  if (sourceKind === 'authorized_session' && (!connectorToolName || !sessionProfileId)) {
    throw new Error('authorized_session requires both connectorToolName and sessionProfileId.');
  }
  if (sourceKind === 'desktop_visible' && !scopes.includes('message_content')) {
    throw new Error('desktop_visible sources require message_content scope because visible extraction cannot separate content from metadata.');
  }
  const expiresAt = parseDate(args.expiresAt);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error('expiresAt must be in the future.');
  const draft = {
    userId: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
    sourceKind,
    targetId,
    scopes,
    allowAllConversations,
    allowedConversationIds,
    ...(connectorToolName ? { connectorToolName } : {}),
    ...(exportPath ? { exportPath } : {}),
    ...(sessionProfileId ? { sessionProfileId } : {}),
    allowCloudVision: args.allowCloudVision === true,
    ...(parseDate(args.since) ? { since: parseDate(args.since) } : {}),
    ...(parseDate(args.until) ? { until: parseDate(args.until) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
  const authorizationDigest = digest(sourceBinding(draft));
  const db = readDB();
  const { sources } = arrays(db);
  const existing = sources.find(source => source.authorizationDigest === authorizationDigest && source.status === 'active');
  if (existing) {
    return JSON.stringify({ ok: true, status: 'already_registered', sourceId: existing.id, authorizationDigest, source: publicSource(existing) }, null, 2);
  }
  const now = nowIso();
  const source: ExternalAiHistorySource = {
    id: `external_history_source_${randomUUID()}`,
    ...draft,
    status: 'active',
    authorizationDigest,
    createdAt: now,
    updatedAt: now,
  };
  sources.push(source);
  writeDB(db);
  return JSON.stringify({
    ok: true,
    verified: true,
    verificationStatus: 'verified',
    status: 'registered',
    sourceId: source.id,
    authorizationDigest,
    source: publicSource(source),
  }, null, 2);
}

function publicSource(source: ExternalAiHistorySource): Record<string, unknown> {
  return {
    ...source,
    ...(source.exportPath ? { exportPath: source.exportPath, exportPathDigest: digest(source.exportPath) } : {}),
    credentialsStored: false,
  };
}

export function listExternalAiHistorySources(_args: Record<string, any>, context?: ToolContext): string {
  const db = readDB();
  const sources = arrays(db).sources.filter(source => sourceBelongsToContext(source, context));
  for (const source of sources) sourceIsUsable(source);
  return JSON.stringify({ ok: true, status: 'listed', sources: sources.map(publicSource), count: sources.length }, null, 2);
}

export function revokeExternalAiHistorySource(args: Record<string, any>, context?: ToolContext): string {
  if (context?.userConfirmed !== true) throw new Error('Revoking an external AI history authorization requires explicit confirmation.');
  const db = readDB();
  const sourceId = normalizeId(args.sourceId, 200);
  const source = arrays(db).sources.find(item => item.id === sourceId && sourceBelongsToContext(item, context));
  if (!source) throw new Error('External AI history source was not found in this user/domain scope.');
  if (source.status !== 'revoked') {
    source.status = 'revoked';
    source.revokedAt = nowIso();
    source.updatedAt = source.revokedAt;
    writeDB(db);
  }
  return JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', status: 'revoked', sourceId }, null, 2);
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => typeof item === 'string' ? item : normalizeId(asObject(item).text, 1_000_000)).filter(Boolean).join('\n');
  }
  const object = asObject(value);
  if (Array.isArray(object.parts)) return object.parts.map((part: unknown) => typeof part === 'string' ? part : normalizeId(asObject(part).text, 1_000_000)).filter(Boolean).join('\n');
  return normalizeId(object.text, 1_000_000);
}

function normalizeAttachment(value: unknown): RawAttachment {
  const item = asObject(value);
  return {
    id: normalizeId(item.id || item.attachmentId || item.fileId, 300) || undefined,
    name: normalizeId(item.name || item.filename, 500) || undefined,
    mimeType: normalizeId(item.mimeType || item.mime_type || item.type, 200) || undefined,
    ...(Number.isFinite(Number(item.size)) ? { size: Math.max(0, Number(item.size)) } : {}),
    sourceUrl: normalizeId(item.sourceUrl || item.url, 2_048) || undefined,
    localPath: normalizeId(item.localPath || item.path, 2_048) || undefined,
    textContent: typeof item.textContent === 'string' ? item.textContent.slice(0, 1_000_000) : undefined,
  };
}

function normalizeMessage(value: unknown): RawMessage {
  const item = asObject(value);
  return {
    id: normalizeId(item.id || item.messageId || item.externalMessageId, 300) || undefined,
    role: normalizeId(item.role || item.author?.role || 'unknown', 80) || 'unknown',
    content: stringifyContent(item.content ?? item.text ?? item.message),
    createdAt: parseDate(item.createdAt || item.created_at || item.timestamp || item.create_time),
    attachments: asArray(item.attachments).map(normalizeAttachment),
  };
}

function normalizeConversation(value: unknown): RawConversation {
  const item = asObject(value);
  return {
    id: normalizeId(item.id || item.conversationId || item.externalConversationId, 300) || undefined,
    title: normalizeId(item.title || item.name, 500) || undefined,
    createdAt: parseDate(item.createdAt || item.created_at || item.create_time),
    messages: asArray(item.messages).map(normalizeMessage),
  };
}

function parsePage(value: unknown): ExternalAiHistoryPage {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const object = asObject(parsed);
  const root = asObject(object.data && !object.conversations ? object.data : object);
  const rawConversations = Array.isArray(root.conversations) ? root.conversations : Array.isArray(parsed) ? parsed : [];
  return {
    conversations: rawConversations.map(normalizeConversation),
    nextCursor: normalizeId(root.nextCursor ?? root.next_cursor ?? root.cursor, 1_000),
    hasMore: root.hasMore === true || root.has_more === true,
    completeness: ['complete', 'incremental', 'partial', 'partial_visible', 'unknown'].includes(root.completeness)
      ? root.completeness as ExternalAiHistoryCompleteness
      : root.hasMore === true || root.has_more === true ? 'incremental' : 'unknown',
    limitations: asArray(root.limitations).map(item => normalizeId(item, 500)).filter(Boolean),
    evidence: asObject(root.evidence),
  };
}

function parseChatGptExportConversation(value: unknown): RawConversation {
  const item = asObject(value);
  const mapping = asObject(item.mapping);
  const nodes = Object.entries(mapping).map(([nodeId, rawNode]) => {
    const node = asObject(rawNode);
    const message = asObject(node.message);
    return { nodeId, message, createdAt: Number(message.create_time || node.create_time || 0) };
  }).filter(node => Object.keys(node.message).length > 0)
    .sort((left, right) => left.createdAt - right.createdAt);
  return {
    id: normalizeId(item.id || item.conversation_id, 300) || undefined,
    title: normalizeId(item.title, 500) || undefined,
    createdAt: parseDate(item.create_time ? Number(item.create_time) * 1000 : undefined),
    messages: nodes.map(node => ({
      id: normalizeId(node.message.id || node.nodeId, 300) || undefined,
      role: normalizeId(node.message.author?.role || 'unknown', 80),
      content: stringifyContent(node.message.content),
      createdAt: parseDate(node.createdAt ? node.createdAt * 1000 : undefined),
      attachments: [
        ...asArray(node.message.metadata?.attachments),
        ...asArray(node.message.metadata?.content_references),
      ].map(normalizeAttachment),
    })),
  };
}

async function readExportPage(source: ExternalAiHistorySource, cursor: string, pageSize: number): Promise<ExternalAiHistoryPage> {
  const exactPath = path.resolve(String(source.exportPath || ''));
  if (!exactPath || exactPath !== source.exportPath) throw new Error('The confirmed export path binding is invalid.');
  const stat = await fs.stat(exactPath);
  if (!stat.isFile()) throw new Error('The confirmed export path is not a file.');
  if (stat.size > EXPORT_MAX_BYTES) throw new Error(`Export exceeds the ${EXPORT_MAX_BYTES}-byte safety limit.`);
  if (path.extname(exactPath).toLowerCase() !== '.json') throw new Error('Only JSON external AI exports are currently supported.');
  const parsed = JSON.parse(await fs.readFile(exactPath, 'utf8'));
  const raw = Array.isArray(parsed) ? parsed : asArray(asObject(parsed).conversations);
  const isChatGpt = raw.some(item => Boolean(asObject(item).mapping));
  const conversations = raw.map(item => isChatGpt ? parseChatGptExportConversation(item) : normalizeConversation(item));
  const offset = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
  const page = conversations.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return {
    conversations: page,
    nextCursor: next < conversations.length ? String(next) : '',
    hasMore: next < conversations.length,
    completeness: next < conversations.length ? 'incremental' : 'complete',
    limitations: ['Completeness reflects the confirmed export file only; deleted or non-exported provider history cannot be inferred.'],
    evidence: { exportPathDigest: digest(exactPath) },
  };
}

function validateHistoryAdapter(source: ExternalAiHistorySource, context?: ToolContext): CapabilityManifestEntry {
  const toolName = String(source.connectorToolName || '');
  if (!toolName || /^external_ai_history_/i.test(toolName)) throw new Error('The registered history adapter is invalid.');
  const entry = context?.toolRegistry?.getCapabilityManifestEntry(toolName, context.toolPolicy, context);
  if (!entry || !entry.executable) throw new Error(`Authorized history adapter ${toolName} is unavailable.`);
  if (!['mcp', 'adapter'].includes(entry.source)) throw new Error('History connectors must be registered MCP or structured adapter capabilities.');
  if (entry.operation !== 'observe') throw new Error('History connectors must declare an observe-only operation.');
  if (entry.sideEffects.some(effect => [
    'external_communication', 'external_state_change', 'local_write', 'local_state_change', 'process_execution', 'installation', 'desktop_control',
  ].includes(effect.type))) {
    throw new Error('History connector was rejected because its manifest declares mutation, communication, process, installation, or desktop-control side effects.');
  }
  const targetTerms = [entry.toolName, entry.provider || '', entry.family, entry.description, ...entry.routingTerms].join(' ').toLowerCase();
  if (!targetTerms.includes(source.targetId.toLowerCase())) throw new Error('History connector target does not match the immutable source target.');
  return entry;
}

async function readConnectorPage(
  source: ExternalAiHistorySource,
  cursor: string,
  pageSize: number,
  context?: ToolContext,
): Promise<ExternalAiHistoryPage> {
  if (runtimeOverrides?.connector) return parsePage(await runtimeOverrides.connector(source, cursor, pageSize, context));
  validateHistoryAdapter(source, context);
  const raw = await context!.toolRegistry!.execute(source.connectorToolName!, {
    operation: 'history_read',
    sourceId: source.id,
    targetId: source.targetId,
    cursor,
    limit: pageSize,
    scopes: source.scopes,
    allowedConversationIds: source.allowAllConversations ? [] : source.allowedConversationIds,
    allowAllConversations: source.allowAllConversations,
    since: source.lastMessageAt || source.since || '',
    until: source.until || '',
    includeAttachments: source.scopes.includes('attachment_metadata'),
    sessionProfileId: source.sessionProfileId || '',
  }, {
    ...(context || {}),
    taskId: context?.taskId || `external-history-sync:${source.id}`,
    idempotencyKey: `external-history-read:${source.id}:${digest(cursor || 'start').slice(0, 24)}`,
    userConfirmed: true,
  });
  return parsePage(raw);
}

function getterAvailable(provider: VisionProvider, context?: ToolContext): boolean {
  const getters = context?.llmGetters;
  if (!getters) return false;
  const getter = ({
    openai: getters.getOpenAI,
    gemini: getters.getGemini,
    ark: getters.getArk,
    qwen: getters.getQwen,
    ollama: getters.getOllama,
    lmstudio: getters.getLmStudio,
    relay: getters.getRelay,
  } as Record<VisionProvider, (() => any) | undefined>)[provider];
  if (!getter) return false;
  try { return Boolean(getter()); } catch { return false; }
}

async function chooseDesktopVision(source: ExternalAiHistorySource, context?: ToolContext): Promise<{ provider: VisionProvider; model: string }> {
  const preference = getUserPreferredVision(context?.userId || 'anonymous');
  const localOrder: LocalModelProvider[] = preference.provider === 'lmstudio'
    ? ['lmstudio', 'ollama']
    : ['ollama', 'lmstudio'];
  for (const provider of localOrder) {
    if (!getterAvailable(provider, context)) continue;
    const config = getLocalModelConfig(provider);
    const preferredModel = preference.provider === provider ? preference.model : '';
    const candidate = preferredModel || config.models.find(model => /(?:vision|vl|llava|bakllava|minicpm)/i.test(model)) || DEFAULT_VISION_MODELS[provider];
    try {
      const ready = await ensureLocalModelReady(provider, candidate, { inferenceTimeoutMs: 30_000 });
      return { provider, model: ready.model };
    } catch { /* Try the next explicitly local provider. */ }
  }
  if (source.allowCloudVision && !['ollama', 'lmstudio'].includes(preference.provider) && getterAvailable(preference.provider, context)) {
    return { provider: preference.provider, model: preference.model || DEFAULT_VISION_MODELS[preference.provider] };
  }
  throw new Error('No healthy local vision model is available. Desktop-visible history remains unread; cloud vision was not authorized for this source.');
}

export async function resolveExternalAiHistoryDesktopVisionForTests(
  source: ExternalAiHistorySource,
  context?: ToolContext,
): Promise<{ provider: VisionProvider; model: string }> {
  return chooseDesktopVision(source, context);
}

function parseJsonObject(text: string): Record<string, any> {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return asObject(JSON.parse(trimmed));
}

async function readDesktopVisiblePage(source: ExternalAiHistorySource, context?: ToolContext): Promise<ExternalAiHistoryPage> {
  if (runtimeOverrides?.desktopVisible) return runtimeOverrides.desktopVisible(source, context);
  if (!context?.desktopRelay) throw new Error('Desktop-visible history requires an attached desktop relay.');
  const activeWindowRaw = await context.desktopRelay('desktop_active_window', {});
  let activeWindow: unknown = activeWindowRaw;
  try { activeWindow = JSON.parse(activeWindowRaw); } catch { /* Keep opaque receipt. */ }
  const activeIdentity = JSON.stringify(activeWindow).toLowerCase();
  if (!activeIdentity.includes(source.targetId.toLowerCase())) {
    throw new Error(`The visible foreground window does not match the authorized target ${source.targetId}.`);
  }
  const captureRaw = await context.desktopRelay('desktop_capture_screen', { quality: 82 });
  const { base64, mime } = parseScreenshotBase64(captureRaw);
  if (!base64) throw new Error('Desktop screenshot capture returned no image.');
  const vision = await chooseDesktopVision(source, context);
  const messages: NormalizedMessage[] = [
    {
      role: 'system',
      content: 'Read only the currently visible external-AI chat history. Never infer hidden, scrolled-off, collapsed, deleted, or unloaded content. Return strict JSON.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `Target: ${source.targetId}`,
            'Extract the visible conversation title/id if shown and every fully or partially visible message in order.',
            'Preserve visible message ids/timestamps when present; otherwise omit them. Mark truncated text literally with [visible text truncated].',
            'Return {"conversations":[{"id":"visible id or visible-current","title":"","messages":[{"id":"","role":"user|assistant|system|unknown","content":"","createdAt":""}]}],"limitations":["..."]}.',
          ].join('\n'),
        },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
      ],
    },
  ];
  const getters = context.llmGetters;
  if (!getters) throw new Error('Vision model getters are unavailable.');
  const raw = await runWithVision(messages, {
    provider: vision.provider,
    model: vision.model,
    userId: context.userId,
    domain: context.domain,
    orgId: context.orgId,
    conversationId: context.conversationId,
    requestId: context.requestId,
    source: 'external_ai_history_desktop_visible',
    responseFormat: 'json_object',
    selectionMode: 'pinned',
    allowCloudFallback: false,
    maxTokens: 3_000,
  }, getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen,
  getters.getOllama, getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay);
  const parsed = parsePage(parseJsonObject(raw));
  return {
    ...parsed,
    nextCursor: '',
    hasMore: false,
    completeness: 'partial_visible',
    limitations: [...new Set([
      ...parsed.limitations,
      'Only the current visible viewport was read; no automatic scrolling occurred.',
      'Hidden, collapsed, deleted, unloaded, and off-screen history is not represented.',
    ])],
    evidence: {
      screenshotDigest: digest(base64),
      activeWindow,
      extractionProvider: vision.provider,
      extractionModel: vision.model,
    },
  };
}

function conversationAllowed(source: ExternalAiHistorySource, externalConversationId: string): boolean {
  return source.allowAllConversations || source.allowedConversationIds.includes(externalConversationId);
}

function evidenceForPage(
  source: ExternalAiHistorySource,
  cursor: string,
  pageNumber: number,
  page: ExternalAiHistoryPage,
): ExternalAiHistorySourceEvidence {
  return {
    sourceId: source.id,
    sourceKind: source.sourceKind,
    targetId: source.targetId,
    fetchedAt: nowIso(),
    pageCursor: cursor,
    pageNumber,
    completeness: page.completeness,
    ...(source.connectorToolName ? { connectorToolName: source.connectorToolName } : {}),
    ...(source.exportPath ? { exportPathDigest: digest(source.exportPath) } : {}),
    ...(source.sessionProfileId ? { sessionProfileId: source.sessionProfileId } : {}),
    ...page.evidence,
    limitations: [...new Set(page.limitations)],
  };
}

function applyPage(
  db: any,
  source: ExternalAiHistorySource,
  page: ExternalAiHistoryPage,
  evidence: ExternalAiHistorySourceEvidence,
  job: ExternalAiHistorySyncJob,
): void {
  const store = arrays(db);
  for (const rawConversation of page.conversations) {
    const externalConversationId = normalizeId(rawConversation.id, 300)
      || `derived-${digest([source.id, rawConversation.title || '', rawConversation.createdAt || '', rawConversation.messages?.length || 0]).slice(0, 40)}`;
    if (!conversationAllowed(source, externalConversationId)) {
      job.limitations.push(`Conversation ${externalConversationId} was outside the authorized conversation scope and was skipped.`);
      continue;
    }
    const conversationIdentity = digest([source.id, externalConversationId]).slice(0, 48);
    let conversation = store.conversations.find(item => item.sourceId === source.id && item.externalConversationId === externalConversationId);
    if (!conversation) {
      conversation = {
        id: `external_history_conversation_${conversationIdentity}`,
        sourceId: source.id,
        userId: source.userId,
        externalConversationId,
        title: normalizeId(rawConversation.title, 500),
        ...(rawConversation.createdAt ? { createdAt: rawConversation.createdAt } : {}),
        messageCount: 0,
        sourceEvidence: evidence,
        updatedAt: nowIso(),
      };
      store.conversations.push(conversation);
    } else {
      conversation.title = normalizeId(rawConversation.title, 500) || conversation.title;
      conversation.sourceEvidence = evidence;
      conversation.updatedAt = nowIso();
    }
    for (const rawMessage of rawConversation.messages || []) {
      const sourceExternalMessageId = normalizeId(rawMessage.id, 300)
        || `derived-${digest([externalConversationId, rawMessage.role || '', rawMessage.createdAt || '', rawMessage.content || '']).slice(0, 48)}`;
      const externalMessageId = `${externalConversationId}:${sourceExternalMessageId}`;
      const content = source.scopes.includes('message_content') ? String(rawMessage.content || '') : '';
      const messageAt = rawMessage.createdAt || '';
      if (source.since && messageAt && Date.parse(messageAt) < Date.parse(source.since)) continue;
      if (source.until && messageAt && Date.parse(messageAt) > Date.parse(source.until)) continue;
      const contentDigest = digest({ role: rawMessage.role || 'unknown', content, messageAt });
      let message = store.messages.find(item => item.sourceId === source.id && item.externalMessageId === externalMessageId);
      if (!message) {
        const now = nowIso();
        message = {
          id: `external_history_message_${digest([source.id, externalMessageId]).slice(0, 48)}`,
          sourceId: source.id,
          conversationId: conversation.id,
          userId: source.userId,
          externalMessageId,
          sourceExternalMessageId,
          role: normalizeId(rawMessage.role || 'unknown', 80),
          content,
          contentDigest,
          messageAt,
          version: 1,
          conflict: false,
          sourceEvidence: evidence,
          createdAt: now,
          updatedAt: now,
        };
        store.messages.push(message);
        job.counts.inserted += 1;
      } else if (message.contentDigest === contentDigest) {
        message.sourceEvidence = evidence;
        message.updatedAt = nowIso();
        job.counts.skipped += 1;
      } else {
        message.role = normalizeId(rawMessage.role || message.role, 80);
        message.content = content;
        message.contentDigest = contentDigest;
        message.messageAt = messageAt;
        message.version = Math.max(1, Number(message.version) || 1) + 1;
        message.conflict = true;
        message.sourceEvidence = evidence;
        message.updatedAt = nowIso();
        job.counts.updated += 1;
        job.counts.conflicted += 1;
      }
      if (messageAt && (!source.lastMessageAt || Date.parse(messageAt) > Date.parse(source.lastMessageAt))) source.lastMessageAt = messageAt;
      if (!source.scopes.includes('attachment_metadata')) continue;
      for (const rawAttachment of rawMessage.attachments || []) {
        const sourceExternalAttachmentId = normalizeId(rawAttachment.id, 300)
          || `derived-${digest([externalMessageId, rawAttachment.name || '', rawAttachment.mimeType || '', rawAttachment.size || 0]).slice(0, 48)}`;
        const externalAttachmentId = `${externalMessageId}:${sourceExternalAttachmentId}`;
        const textContent = source.scopes.includes('attachment_content') ? String(rawAttachment.textContent || '').slice(0, 1_000_000) : '';
        const contentDigestValue = digest({
          name: rawAttachment.name || '', mimeType: rawAttachment.mimeType || '', size: rawAttachment.size || 0,
          sourceUrl: rawAttachment.sourceUrl || '', localPath: rawAttachment.localPath || '', textContent,
        });
        let attachment = store.attachments.find(item => item.sourceId === source.id && item.externalAttachmentId === externalAttachmentId);
        if (!attachment) {
          const now = nowIso();
          attachment = {
            id: `external_history_attachment_${digest([source.id, externalAttachmentId]).slice(0, 48)}`,
            sourceId: source.id,
            messageId: message.id,
            userId: source.userId,
            externalAttachmentId,
            sourceExternalAttachmentId,
            name: normalizeId(rawAttachment.name, 500),
            mimeType: normalizeId(rawAttachment.mimeType, 200),
            ...(Number.isFinite(rawAttachment.size) ? { size: rawAttachment.size } : {}),
            ...(rawAttachment.sourceUrl ? { sourceUrl: rawAttachment.sourceUrl } : {}),
            ...(rawAttachment.localPath ? { localPath: rawAttachment.localPath } : {}),
            ...(textContent ? { textContent } : {}),
            contentDigest: contentDigestValue,
            sourceEvidence: evidence,
            createdAt: now,
            updatedAt: now,
          };
          store.attachments.push(attachment);
          job.counts.attachments += 1;
        } else if (attachment.contentDigest !== contentDigestValue) {
          Object.assign(attachment, {
            name: normalizeId(rawAttachment.name, 500),
            mimeType: normalizeId(rawAttachment.mimeType, 200),
            size: rawAttachment.size,
            sourceUrl: rawAttachment.sourceUrl,
            localPath: rawAttachment.localPath,
            textContent: textContent || undefined,
            contentDigest: contentDigestValue,
            sourceEvidence: evidence,
            updatedAt: nowIso(),
          });
          job.counts.attachments += 1;
        }
      }
    }
    conversation.messageCount = store.messages.filter(message => message.conversationId === conversation!.id).length;
  }
}

async function fetchPage(
  source: ExternalAiHistorySource,
  cursor: string,
  pageSize: number,
  context?: ToolContext,
): Promise<ExternalAiHistoryPage> {
  if (source.sourceKind === 'export') return readExportPage(source, cursor, pageSize);
  if (source.sourceKind === 'desktop_visible') return readDesktopVisiblePage(source, context);
  return readConnectorPage(source, cursor, pageSize, context);
}

function jobReceipt(job: ExternalAiHistorySyncJob, source: ExternalAiHistorySource): string {
  return JSON.stringify({
    ok: ['completed', 'partial'].includes(job.status),
    verified: true,
    verificationStatus: 'verified',
    status: job.status,
    sourceId: source.id,
    jobId: job.id,
    authorizationDigest: source.authorizationDigest,
    sourceKind: source.sourceKind,
    targetId: source.targetId,
    scopes: source.scopes,
    counts: job.counts,
    pageCount: job.pageCount,
    nextCursor: job.nextCursor,
    completeness: job.completeness,
    limitations: [...new Set(job.limitations)],
    blocker: job.blocker || null,
    error: job.error || null,
    note: source.sourceKind === 'desktop_visible'
      ? 'Desktop-visible history is explicitly partial and contains only the captured foreground viewport.'
      : 'History is attributed to the confirmed source and constrained by its immutable authorization scope.',
  }, null, 2);
}

async function runSync(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const db = readDB();
  const store = arrays(db);
  const sourceId = normalizeId(args.sourceId, 200);
  const source = store.sources.find(item => item.id === sourceId && sourceBelongsToContext(item, context));
  if (!source) throw new Error('External AI history source was not found in this user/domain scope.');
  const usability = sourceIsUsable(source);
  const requestedJobId = normalizeId(args.jobId, 200);
  let job = requestedJobId
    ? store.jobs.find(item => item.id === requestedJobId && item.sourceId === source.id && item.userId === source.userId)
    : undefined;
  if (requestedJobId && !job) throw new Error('The requested history sync job was not found for this source.');
  if (!job) {
    const now = nowIso();
    job = {
      id: `external_history_job_${randomUUID()}`,
      sourceId: source.id,
      userId: source.userId,
      status: 'pending',
      nextCursor: '',
      pageCount: 0,
      counts: { inserted: 0, updated: 0, skipped: 0, conflicted: 0, attachments: 0 },
      completeness: 'unknown',
      limitations: [],
      startedAt: now,
      updatedAt: now,
    };
    store.jobs.push(job);
  }
  if (!usability.ok) {
    job.status = 'blocked';
    job.blocker = usability.blocker;
    job.updatedAt = nowIso();
    writeDB(db);
    return jobReceipt(job, source);
  }
  if (job.status === 'completed' && args.restart !== true) return jobReceipt(job, source);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(args.pageSize) || 50)));
  const maxPages = Math.max(1, Math.min(MAX_PAGES_PER_RUN, Math.trunc(Number(args.maxPages) || 10)));
  job.status = 'running';
  job.blocker = undefined;
  job.error = undefined;
  job.updatedAt = nowIso();
  source.lastJobId = job.id;
  source.updatedAt = job.updatedAt;
  writeDB(db);
  try {
    for (let runPage = 0; runPage < maxPages; runPage += 1) {
      const cursor = job.nextCursor;
      const page = await fetchPage(source, cursor, pageSize, context);
      job.pageCount += 1;
      const evidence = evidenceForPage(source, cursor, job.pageCount, page);
      applyPage(db, source, page, evidence, job);
      job.nextCursor = page.nextCursor;
      job.completeness = page.completeness;
      job.limitations.push(...page.limitations);
      job.updatedAt = nowIso();
      source.updatedAt = job.updatedAt;
      writeDB(db); // Durable checkpoint after every page.
      if (!page.hasMore) {
        job.status = 'completed';
        job.completedAt = nowIso();
        job.nextCursor = '';
        source.lastSyncAt = job.completedAt;
        source.updatedAt = job.completedAt;
        writeDB(db);
        return jobReceipt(job, source);
      }
      if (!page.nextCursor || page.nextCursor === cursor) throw new Error('History adapter reported more pages without advancing its cursor.');
    }
    job.status = 'partial';
    job.completeness = job.completeness === 'partial_visible' ? 'partial_visible' : 'incremental';
    job.limitations.push(`This run stopped at the configured ${maxPages}-page bound and can resume from nextCursor.`);
    job.updatedAt = nowIso();
    writeDB(db);
    return jobReceipt(job, source);
  } catch (error: any) {
    job.status = /authorization|scope|foreground window|local vision|unavailable|observe-only|read-only|manifest|rejected/i.test(String(error?.message || error)) ? 'blocked' : 'failed';
    job.blocker = job.status === 'blocked' ? 'authorized_source_unavailable' : undefined;
    job.error = String(error?.message || error || 'History synchronization failed').slice(0, 1_000);
    job.updatedAt = nowIso();
    writeDB(db);
    return jobReceipt(job, source);
  }
}

export async function syncExternalAiHistory(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const sourceId = normalizeId(args.sourceId, 200);
  const key = `${contextScope(context).userId}:${contextScope(context).domain}:${contextScope(context).orgId}:${sourceId}:${normalizeId(args.jobId, 200)}`;
  const running = syncExecutions.get(key);
  if (running) return running;
  const execution = runSync(args, context).finally(() => syncExecutions.delete(key));
  syncExecutions.set(key, execution);
  return execution;
}

export function externalAiHistoryStatus(args: Record<string, any>, context?: ToolContext): string {
  const db = readDB();
  const store = arrays(db);
  const sourceId = normalizeId(args.sourceId, 200);
  const jobId = normalizeId(args.jobId, 200);
  const source = store.sources.find(item => item.id === sourceId && sourceBelongsToContext(item, context));
  if (!source) throw new Error('External AI history source was not found in this user/domain scope.');
  sourceIsUsable(source);
  const jobs = store.jobs.filter(job => job.sourceId === source.id && (!jobId || job.id === jobId));
  const conversationIds = new Set(store.conversations.filter(item => item.sourceId === source.id).map(item => item.id));
  return JSON.stringify({
    ok: true,
    status: source.status,
    source: publicSource(source),
    jobs,
    counts: {
      jobs: jobs.length,
      conversations: conversationIds.size,
      messages: store.messages.filter(item => item.sourceId === source.id).length,
      attachments: store.attachments.filter(item => item.sourceId === source.id).length,
    },
  }, null, 2);
}

export function queryExternalAiHistory(args: Record<string, any>, context?: ToolContext): string {
  const db = readDB();
  const store = arrays(db);
  const sourceId = normalizeId(args.sourceId, 200);
  const source = store.sources.find(item => item.id === sourceId && sourceBelongsToContext(item, context));
  if (!source) throw new Error('External AI history source was not found in this user/domain scope.');
  const externalConversationId = normalizeId(args.externalConversationId, 300);
  const query = normalizeId(args.query, 2_000).toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit) || 50)));
  const allowedConversationRecords = store.conversations.filter(conversation => (
    conversation.sourceId === source.id
    && (!externalConversationId || conversation.externalConversationId === externalConversationId)
  ));
  const allowedIds = new Set(allowedConversationRecords.map(item => item.id));
  const messages = store.messages.filter(message => (
    message.sourceId === source.id
    && allowedIds.has(message.conversationId)
    && (!query || `${message.role} ${message.content}`.toLowerCase().includes(query))
  )).sort((left, right) => String(left.messageAt || left.createdAt).localeCompare(String(right.messageAt || right.createdAt))).slice(-limit);
  const messageIds = new Set(messages.map(message => message.id));
  const attachments = store.attachments.filter(attachment => messageIds.has(attachment.messageId));
  return JSON.stringify({
    ok: true,
    status: 'queried',
    sourceId,
    sourceKind: source.sourceKind,
    targetId: source.targetId,
    authorizationDigest: source.authorizationDigest,
    conversations: allowedConversationRecords,
    messages,
    attachments,
    count: messages.length,
    completeness: source.sourceKind === 'desktop_visible' ? 'partial_visible' : 'source_bounded',
    limitations: source.sourceKind === 'desktop_visible'
      ? ['Only previously captured visible viewports are searchable.']
      : ['Results are limited to the confirmed source, authorization scope, and synchronized pages.'],
  }, null, 2);
}

export function recoverInterruptedExternalAiHistorySyncs(): number {
  let db: any;
  try { db = readDB(); } catch { return 0; }
  const store = arrays(db);
  let recovered = 0;
  for (const job of store.jobs) {
    if (job.status !== 'running') continue;
    job.status = 'interrupted';
    job.blocker = 'process_restarted_resume_from_checkpoint';
    job.updatedAt = nowIso();
    recovered += 1;
  }
  if (recovered > 0) writeDB(db);
  return recovered;
}

export function resetExternalAiHistoryForTests(options: { clearPersisted?: boolean } = {}): void {
  syncExecutions.clear();
  runtimeOverrides = null;
  if (!options.clearPersisted) return;
  let db: any;
  try { db = readDB(); } catch { return; }
  db.externalAiHistorySources = [];
  db.externalAiHistorySyncJobs = [];
  db.externalAiHistoryConversations = [];
  db.externalAiHistoryMessages = [];
  db.externalAiHistoryAttachments = [];
  writeDB(db);
}
