/**
 * Employee-side organization branch connection manager.
 *
 * Branch identity, pending sync batches, acknowledgement fingerprints and the
 * KB cache are persisted in the normal settings table. A sync batch is removed
 * only after the company server returns (or can later reproduce) a verified
 * durable receipt for the exact immutable payload.
 */

import { createHash, randomUUID } from 'crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';

const BRANCH_STATE_SETTING = 'org.branch.client.state.v2';
const OFFLINE_QUEUE_SETTING = 'org.branch.client.offline_queue.v2';
const SYNC_INDEX_SETTING = 'org.branch.client.sync_index.v2';
const KB_CACHE_SETTING = 'org.branch.client.kb_cache.v1';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_OFFLINE_ACTIONS = 1_000;

export type BranchStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface BranchState {
  branchId: string;
  orgId: string | null;
  companyUrl: string | null;
  connectionToken: string | null;
  status: BranchStatus;
  currentDomain: 'personal' | 'work';
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface SyncPayload {
  memories: any[];
  interactions: any[];
  agents: any[];
}

interface BranchSyncRequest extends SyncPayload {
  orgId: string;
  branchId: string;
  batchId: string;
}

interface BranchSyncItemReceipt {
  kind: 'memory' | 'interaction' | 'agent';
  sourceId: string;
  targetId: string;
  digest: string;
  outcome: 'inserted' | 'updated' | 'unchanged';
}

interface BranchSyncReceipt {
  version: 1;
  receiptId: string;
  orgId: string;
  branchId: string;
  batchId: string;
  payloadDigest: string;
  verified: true;
  accepted: number;
  items: BranchSyncItemReceipt[];
  persistedAt: string;
}

interface OfflineAction {
  id: string;
  type: 'sync' | 'agent_action' | 'kb_query';
  payload: any;
  state: 'pending' | 'unknown' | 'blocked';
  attempts: number;
  lastError: string;
  queuedAt: string;
  updatedAt: string;
}

interface SyncIndexEntry {
  digest: string;
  targetId: string;
  receiptId: string;
  syncedAt: string;
}

type SyncIndex = Record<string, SyncIndexEntry>;

interface CachedArticle {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  cachedAt: string;
}

let branchState: BranchState | null = null;
let syncInFlight: Promise<{ synced: number; errors: string[] }> | null = null;

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSetting<T>(key: string, fallback: T): T {
  try {
    const raw = (readDB().settings || []).find((item: any) => item?.key === key)?.value;
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeSetting(db: any, key: string, value: unknown): void {
  if (!Array.isArray(db.settings)) db.settings = [];
  const serialized = JSON.stringify(value);
  const existing = db.settings.find((item: any) => item?.key === key);
  if (existing) existing.value = serialized;
  else db.settings.push({ key, value: serialized });
}

function newBranchState(): BranchState {
  return {
    branchId: `branch_${randomUUID()}`,
    orgId: null,
    companyUrl: null,
    connectionToken: null,
    status: 'disconnected',
    currentDomain: 'personal',
    lastSyncAt: null,
    lastHeartbeatAt: null,
  };
}

function normalizeSavedState(saved: unknown): BranchState | null {
  if (!isObject(saved)) return null;
  const fallback = newBranchState();
  const branchId = String(saved.branchId || fallback.branchId).trim();
  return {
    branchId: /^[A-Za-z0-9._:@/-]{8,240}$/.test(branchId) ? branchId : fallback.branchId,
    orgId: saved.orgId ? String(saved.orgId) : null,
    companyUrl: saved.companyUrl ? String(saved.companyUrl).replace(/\/+$/, '') : null,
    connectionToken: saved.connectionToken ? String(saved.connectionToken) : null,
    status: ['disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(String(saved.status))
      ? saved.status as BranchStatus
      : 'disconnected',
    currentDomain: saved.currentDomain === 'work' ? 'work' : 'personal',
    lastSyncAt: saved.lastSyncAt ? String(saved.lastSyncAt) : null,
    lastHeartbeatAt: saved.lastHeartbeatAt ? String(saved.lastHeartbeatAt) : null,
  };
}

function bs(): BranchState {
  if (branchState) return branchState;
  const saved = readSetting<unknown>(BRANCH_STATE_SETTING, null);
  const legacy = (() => {
    try { return (readDB() as any).branchState; } catch { return null; }
  })();
  branchState = normalizeSavedState(saved) || normalizeSavedState(legacy) || newBranchState();
  saveBranchState();
  return branchState;
}

function saveBranchState(): void {
  try {
    const db = readDB();
    writeSetting(db, BRANCH_STATE_SETTING, bs());
    writeDB(db);
  } catch {
    // The runtime may ask for public state before database initialization.
  }
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
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function itemKey(kind: BranchSyncItemReceipt['kind'], sourceId: string): string {
  return `${kind}:${sourceId}`;
}

function getOfflineQueue(): OfflineAction[] {
  const queue = readSetting<unknown>(OFFLINE_QUEUE_SETTING, []);
  if (!Array.isArray(queue)) return [];
  return queue.filter(isObject).map((item: any) => ({
    id: String(item.id || randomUUID()),
    type: ['sync', 'agent_action', 'kb_query'].includes(String(item.type)) ? item.type : 'agent_action',
    payload: item.payload,
    state: ['pending', 'unknown', 'blocked'].includes(String(item.state)) ? item.state : 'pending',
    attempts: Math.max(0, Math.trunc(Number(item.attempts) || 0)),
    lastError: String(item.lastError || ''),
    queuedAt: String(item.queuedAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || item.queuedAt || new Date().toISOString()),
  })).slice(-MAX_OFFLINE_ACTIONS) as OfflineAction[];
}

function saveOfflineQueue(queue: OfflineAction[]): void {
  const db = readDB();
  writeSetting(db, OFFLINE_QUEUE_SETTING, queue.slice(-MAX_OFFLINE_ACTIONS));
  writeDB(db);
}

function getSyncIndex(): SyncIndex {
  const index = readSetting<unknown>(SYNC_INDEX_SETTING, {});
  return isObject(index) ? index as SyncIndex : {};
}

function ipv4Number(address: string): number | null {
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return octets.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function ipv4InCidr(address: string, network: string, prefix: number): boolean {
  const candidate = ipv4Number(address);
  const base = ipv4Number(network);
  if (candidate === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (candidate & mask) === (base & mask);
}

/** Fail-closed address classification used before any branch credential leaves the host. */
export function isPublicCompanyAddress(address: string): boolean {
  const normalized = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) {
    return ![
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([network, prefix]) => ipv4InCidr(normalized, String(network), Number(prefix)));
  }
  if (family !== 6) return false;
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('::ffff:')) return false; // mapped IPv4, including hexadecimal forms
  if (/^(?:fc|fd)/.test(normalized)) return false; // unique-local
  if (/^fe[89ab]/.test(normalized)) return false; // link-local
  if (/^ff/.test(normalized)) return false; // multicast
  if (!/^[23]/.test(normalized)) return false; // only global-unicast space
  if (/^(?:2001:0*:|2002:|3fff:)/.test(normalized)) return false; // transition/documentation ranges
  if (/^2001:db8(?::|$)/.test(normalized)) return false; // documentation
  return true;
}

function normalizeCompanyUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Company URL must use HTTPS');
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('Company URL must not contain credentials, a query, or a fragment');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
  ) {
    throw new Error('Company URL must use a public network host');
  }
  return url.toString().replace(/\/$/, '');
}

export async function validateCompanyEndpoint(value: string): Promise<string> {
  const normalized = normalizeCompanyUrl(value);
  const url = new URL(normalized);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(result => !isPublicCompanyAddress(result.address))) {
    throw new Error('Company URL resolved to a blocked private, loopback, link-local, or reserved address');
  }
  return normalized;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const safeUrl = await validateCompanyEndpoint(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(safeUrl, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Company endpoint redirects are disabled to protect branch credentials');
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body: any = await response.json().catch(() => null);
  return String(body?.error || response.statusText || fallback);
}

function receiptMatches(request: BranchSyncRequest, receipt: unknown): receipt is BranchSyncReceipt {
  if (!isObject(receipt) || receipt.verified !== true) return false;
  if (receipt.orgId !== request.orgId || receipt.branchId !== request.branchId || receipt.batchId !== request.batchId) return false;
  const expected = [
    ...request.memories.map(item => ({ kind: 'memory' as const, sourceId: String(item.id), digest: digest(item) })),
    ...request.interactions.map(item => ({ kind: 'interaction' as const, sourceId: String(item.id), digest: digest(item) })),
    ...request.agents.map(item => ({ kind: 'agent' as const, sourceId: String(item.id), digest: digest(item) })),
  ];
  if (Number(receipt.accepted) !== expected.length || !Array.isArray(receipt.items) || receipt.items.length !== expected.length) {
    return false;
  }
  const actual = new Map(receipt.items.map((item: any) => [itemKey(item.kind, String(item.sourceId)), item]));
  return expected.every(item => {
    const matched = actual.get(itemKey(item.kind, item.sourceId));
    return matched?.digest === item.digest && Boolean(matched?.targetId);
  });
}

async function acknowledgeReceipt(action: OfflineAction, receipt: BranchSyncReceipt): Promise<number> {
  const request = action.payload as BranchSyncRequest;
  if (!receiptMatches(request, receipt)) throw new Error('Company receipt does not match the immutable sync batch');
  const db = readDB();
  const index = getSyncIndex();
  for (const item of receipt.items) {
    index[itemKey(item.kind, item.sourceId)] = {
      digest: item.digest,
      targetId: item.targetId,
      receiptId: receipt.receiptId,
      syncedAt: receipt.persistedAt,
    };
  }
  const queue = getOfflineQueue().filter(candidate => candidate.id !== action.id);
  writeSetting(db, SYNC_INDEX_SETTING, index);
  writeSetting(db, OFFLINE_QUEUE_SETTING, queue);
  bs().lastSyncAt = receipt.persistedAt;
  writeSetting(db, BRANCH_STATE_SETTING, bs());
  writeDB(db);
  await flushDBOrThrow();
  return receipt.accepted;
}

function updateQueuedAction(action: OfflineAction, update: Partial<OfflineAction>): void {
  const queue = getOfflineQueue();
  const index = queue.findIndex(candidate => candidate.id === action.id);
  if (index < 0) return;
  queue[index] = { ...queue[index], ...update, updatedAt: new Date().toISOString() };
  saveOfflineQueue(queue);
}

async function lookupReceipt(action: OfflineAction): Promise<BranchSyncReceipt | null> {
  const state = bs();
  const request = action.payload as BranchSyncRequest;
  if (!state.companyUrl || !state.connectionToken) return null;
  const response = await fetchWithTimeout(
    `${state.companyUrl}/api/branch/ingest/receipts/${encodeURIComponent(request.batchId)}`,
    { headers: { Authorization: `Bearer ${state.connectionToken}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await responseError(response, 'Receipt query failed'));
  const body: any = await response.json();
  return body?.receipt || null;
}

async function executeSyncAction(action: OfflineAction): Promise<{ synced: number; errors: string[] }> {
  const state = bs();
  const request = action.payload as BranchSyncRequest;
  if (!state.companyUrl || !state.connectionToken || !state.orgId) {
    return { synced: 0, errors: ['Not connected to organization'] };
  }
  if (request.orgId !== state.orgId || request.branchId !== state.branchId) {
    updateQueuedAction(action, { state: 'blocked', lastError: 'Queued sync scope no longer matches this branch session' });
    return { synced: 0, errors: ['Queued sync scope no longer matches this branch session'] };
  }

  if (action.state === 'unknown') {
    try {
      const receipt = await lookupReceipt(action);
      if (!receipt) return { synced: 0, errors: ['Sync result remains unknown; automatic resend is stopped'] };
      return { synced: await acknowledgeReceipt(action, receipt), errors: [] };
    } catch (error: any) {
      return { synced: 0, errors: [`Unable to reconcile unknown sync result: ${error?.message || error}`] };
    }
  }
  if (action.state === 'blocked') return { synced: 0, errors: [action.lastError || 'Sync action is blocked'] };

  updateQueuedAction(action, { attempts: action.attempts + 1, lastError: '' });
  try {
    const response = await fetchWithTimeout(`${state.companyUrl}/api/branch/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.connectionToken}`,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await responseError(response, 'Sync rejected');
      updateQueuedAction(action, {
        state: response.status >= 400 && response.status < 500 ? 'blocked' : 'pending',
        lastError: message,
      });
      return { synced: 0, errors: [message] };
    }
    const body: any = await response.json();
    return { synced: await acknowledgeReceipt(action, body?.receipt), errors: [] };
  } catch (error: any) {
    updateQueuedAction(action, {
      state: 'unknown',
      lastError: String(error?.message || error || 'Network result unknown'),
    });
    try {
      const receipt = await lookupReceipt(action);
      if (receipt) return { synced: await acknowledgeReceipt(action, receipt), errors: [] };
    } catch {
      // The original immutable batch remains recorded as unknown for later reconciliation.
    }
    return { synced: 0, errors: ['Sync result unknown; automatic resend stopped until the receipt can be verified'] };
  }
}

function unsyncedPayload(orgId: string): SyncPayload {
  const db = readDB();
  const index = getSyncIndex();
  const select = (kind: BranchSyncItemReceipt['kind'], values: any[] = []) => values.filter(item => {
    if (item?.domain !== 'work' || item?.orgId !== orgId || !item?.id) return false;
    return index[itemKey(kind, String(item.id))]?.digest !== digest(item);
  });
  return {
    memories: select('memory', db.memories),
    interactions: select('interaction', db.interactions),
    agents: select('agent', db.agents),
  };
}

function createSyncAction(orgId: string, branchId: string, payload: SyncPayload): OfflineAction {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type: 'sync',
    payload: {
      orgId,
      branchId,
      batchId: `batch_${randomUUID()}`,
      memories: payload.memories,
      interactions: payload.interactions,
      agents: payload.agents,
    } satisfies BranchSyncRequest,
    state: 'pending',
    attempts: 0,
    lastError: '',
    queuedAt: now,
    updatedAt: now,
  };
}

export function getBranchState(): Readonly<BranchState> {
  return bs();
}

export async function connectToOrg(
  orgId: string,
  companyUrl: string,
  token: string,
): Promise<{ success: boolean; error?: string }> {
  const state = bs();
  state.status = 'connecting';
  saveBranchState();
  try {
    // The immutable branch ID must reach disk before it is registered remotely.
    await flushDBOrThrow();
    const normalizedUrl = normalizeCompanyUrl(companyUrl);
    const response = await fetchWithTimeout(`${normalizedUrl}/api/branch/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId, branchId: state.branchId }),
    });
    if (!response.ok) {
      state.status = 'error';
      saveBranchState();
      return { success: false, error: await responseError(response, 'Registration failed') };
    }
    const body: any = await response.json();
    if (
      !body?.branchToken
      || body.branchId !== state.branchId
      || body.org?.id !== orgId
    ) {
      state.status = 'error';
      saveBranchState();
      return { success: false, error: 'Company returned a mismatched branch identity' };
    }
    state.orgId = orgId;
    state.companyUrl = normalizedUrl;
    state.connectionToken = String(body.branchToken);
    state.status = 'connected';
    state.lastHeartbeatAt = new Date().toISOString();
    saveBranchState();
    await flushDBOrThrow();
    void pullKbCache();
    void flushOfflineQueue();
    return { success: true };
  } catch (error: any) {
    state.status = 'error';
    saveBranchState();
    return { success: false, error: String(error?.message || error) };
  }
}

export function disconnectFromOrg(): void {
  const state = bs();
  state.orgId = null;
  state.companyUrl = null;
  state.connectionToken = null;
  state.status = 'disconnected';
  state.currentDomain = 'personal';
  saveBranchState();
}

export function switchDomain(domain: 'personal' | 'work'): void {
  bs().currentDomain = domain;
  saveBranchState();
}

export function getCurrentDomain(): 'personal' | 'work' {
  return bs().currentDomain;
}

export function isWorkDomain(): boolean {
  return bs().currentDomain === 'work' && bs().status === 'connected';
}

async function runSyncWorkData(): Promise<{ synced: number; errors: string[] }> {
  const state = bs();
  if (!state.companyUrl || !state.connectionToken || !state.orgId) {
    return { synced: 0, errors: ['Not connected to organization'] };
  }
  const queued = getOfflineQueue().find(action => action.type === 'sync');
  if (queued) return executeSyncAction(queued);

  const payload = unsyncedPayload(state.orgId);
  const total = payload.memories.length + payload.interactions.length + payload.agents.length;
  if (total === 0) return { synced: 0, errors: [] };
  const action = createSyncAction(state.orgId, state.branchId, payload);
  saveOfflineQueue([...getOfflineQueue(), action]);
  await flushDBOrThrow();
  return executeSyncAction(action);
}

export function syncWorkData(): Promise<{ synced: number; errors: string[] }> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSyncWorkData().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

let kbCache: CachedArticle[] | null = null;

function getKbCache(): CachedArticle[] {
  if (kbCache) return kbCache;
  const saved = readSetting<unknown>(KB_CACHE_SETTING, []);
  kbCache = Array.isArray(saved) ? saved.filter(isObject) as CachedArticle[] : [];
  return kbCache;
}

export async function pullKbCache(): Promise<number> {
  const state = bs();
  if (!state.companyUrl || !state.connectionToken) return 0;
  try {
    const response = await fetchWithTimeout(`${state.companyUrl}/api/branch/kb-cache`, {
      headers: { Authorization: `Bearer ${state.connectionToken}` },
    });
    if (!response.ok) return 0;
    const body: any = await response.json();
    const now = new Date().toISOString();
    kbCache = (Array.isArray(body?.articles) ? body.articles : []).map((article: any) => ({
      id: String(article.id || ''),
      title: String(article.title || ''),
      content: String(article.content || ''),
      category: String(article.category || ''),
      tags: String(article.tags || ''),
      cachedAt: now,
    }));
    const db = readDB();
    writeSetting(db, KB_CACHE_SETTING, kbCache);
    writeDB(db);
    return kbCache.length;
  } catch {
    return 0;
  }
}

export function searchKbCache(query: string): CachedArticle[] {
  const normalized = query.toLowerCase();
  return getKbCache().filter(article =>
    article.title.toLowerCase().includes(normalized)
    || article.content.toLowerCase().includes(normalized)
    || article.tags.toLowerCase().includes(normalized),
  );
}

export function getKbCacheStats(): { count: number; lastUpdated: string | null } {
  const cache = getKbCache();
  const timestamps = cache.map(article => article.cachedAt).sort();
  return { count: cache.length, lastUpdated: timestamps.at(-1) || null };
}

export function queueOfflineAction(type: OfflineAction['type'], payload: any): void {
  const queue = getOfflineQueue();
  if (type === 'sync') {
    const batchId = String(payload?.batchId || '');
    if (batchId && queue.some(action => action.type === 'sync' && action.payload?.batchId === batchId)) return;
  }
  const now = new Date().toISOString();
  queue.push({
    id: randomUUID(),
    type,
    payload,
    state: 'pending',
    attempts: 0,
    lastError: '',
    queuedAt: now,
    updatedAt: now,
  });
  saveOfflineQueue(queue);
}

export async function flushOfflineQueue(): Promise<{ flushed: number; errors: string[] }> {
  if (!bs().companyUrl || !bs().connectionToken) return { flushed: 0, errors: ['Not connected'] };
  let flushed = 0;
  const errors: string[] = [];
  for (const action of getOfflineQueue()) {
    if (action.type === 'sync') {
      const result = await executeSyncAction(action);
      if (result.errors.length === 0) flushed += 1;
      else errors.push(...result.errors.map(error => `[sync] ${error}`));
      continue;
    }
    if (action.type === 'kb_query') {
      saveOfflineQueue(getOfflineQueue().filter(candidate => candidate.id !== action.id));
      flushed += 1;
      continue;
    }
    errors.push('[agent_action] No durable organization agent-action executor is registered');
    updateQueuedAction(action, { state: 'blocked', lastError: errors.at(-1) || '' });
  }
  return { flushed, errors };
}

export function getOfflineQueueLength(): number {
  return getOfflineQueue().length;
}

export async function checkConnection(): Promise<BranchStatus> {
  const state = bs();
  if (!state.companyUrl || !state.connectionToken) {
    state.status = 'disconnected';
    saveBranchState();
    return state.status;
  }
  try {
    const response = await fetchWithTimeout(`${state.companyUrl}/api/branch/status`, {
      headers: { Authorization: `Bearer ${state.connectionToken}` },
    }, 5_000);
    if (response.ok) {
      const body: any = await response.json();
      if (body?.branchId !== state.branchId || body?.orgId !== state.orgId) {
        state.status = 'error';
      } else {
        state.status = 'connected';
        state.lastHeartbeatAt = new Date().toISOString();
      }
    } else if (response.status === 401 || response.status === 403) {
      state.status = 'error';
      state.connectionToken = null;
    } else {
      state.status = 'reconnecting';
    }
  } catch {
    state.status = 'reconnecting';
  }
  saveBranchState();
  return state.status;
}

let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(intervalMs = 30_000): void {
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(async () => {
    if (bs().status === 'connected' && bs().currentDomain === 'work') {
      await syncWorkData();
      await checkConnection();
    }
  }, intervalMs);
}

export function stopAutoSync(): void {
  if (!autoSyncTimer) return;
  clearInterval(autoSyncTimer);
  autoSyncTimer = null;
}
