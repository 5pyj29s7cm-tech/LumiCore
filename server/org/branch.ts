import { isPublicNetworkAddress as isPublicCompanyAddress } from '../utils/public_network_address';
export { isPublicCompanyAddress };
/**
 * Employee-side organization branch connection manager.
 *
 * Branch identity, pending sync batches, acknowledgement fingerprints and the
 * KB cache are persisted in the normal settings table. A sync batch is removed
 * only after the company server returns (or can later reproduce) a verified
 * durable receipt for the exact immutable payload.
 */

import { randomUUID } from 'crypto';
import { branchSyncDigest as digest } from './branch_protocol';
import type { BranchSyncPayload, BranchSyncItemReceipt, BranchSyncReceipt as ProtocolReceipt } from './branch_protocol';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { runtimeBackgroundWork } from '../runtime/shutdown_work';

const BRANCH_STATE_SETTING = 'org.branch.client.state.v2';
const OFFLINE_QUEUE_SETTING = 'org.branch.client.offline_queue.v2';
const SYNC_INDEX_SETTING = 'org.branch.client.sync_index.v2';
const KB_CACHE_SETTING = 'org.branch.client.kb_cache.v1';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_OFFLINE_ACTIONS = 1_000;
// Protocol limit enforced by the company branch ingest API.
const MAX_SYNC_BATCH_ITEMS = 1_000;

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
}

type BranchSyncRequest = SyncPayload & Pick<BranchSyncPayload, 'orgId' | 'branchId' | 'batchId'>;
type BranchSyncReceipt = Pick<ProtocolReceipt,
  'version' | 'receiptId' | 'orgId' | 'branchId' | 'batchId' | 'payloadDigest' | 'verified' | 'accepted' | 'items' | 'persistedAt'>;

interface OfflineAction {
  id: string;
  type: 'sync' | 'kb_query';
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

let branchState: BranchState | null = null;
interface SyncDrainResult { synced: number; flushed: number; errors: string[] }
let syncInFlight: Promise<SyncDrainResult> | null = null;
let syncIncludesUnsynced = false;
let connectionGeneration = 0;
let pendingConnection: AbortController | null = null;

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSetting<T>(key: string, fallback: T): T {
  try {
    const raw = (readDatabaseTables(["interactions","memories","settings","branchState"]).settings || []).find((item: any) => item?.key === key)?.value;
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
    try { return (readDatabaseTables(["interactions","memories","settings","branchState"]) as any).branchState; } catch { return null; }
  })();
  branchState = normalizeSavedState(saved) || normalizeSavedState(legacy) || newBranchState();
  saveBranchState();
  return branchState;
}

function saveBranchState(): void {
  try {
    const db = readDatabaseTables(["interactions","memories","settings","branchState"]);
    writeSetting(db, BRANCH_STATE_SETTING, bs());
    commitDatabaseTables(db);
  } catch {
    // The runtime may ask for public state before database initialization.
  }
}

function itemKey(kind: BranchSyncItemReceipt['kind'], sourceId: string): string {
  return `${kind}:${sourceId}`;
}

function getOfflineQueue(): OfflineAction[] {
  const queue = readSetting<unknown>(OFFLINE_QUEUE_SETTING, []);
  if (!Array.isArray(queue)) return [];
  return queue.filter(isObject).filter((item: any) => ['sync', 'kb_query'].includes(String(item.type))).map((item: any) => ({
    id: String(item.id || randomUUID()),
    type: item.type,
    payload: item.payload,
    state: ['pending', 'unknown', 'blocked'].includes(String(item.state)) ? item.state : 'pending',
    attempts: Math.max(0, Math.trunc(Number(item.attempts) || 0)),
    lastError: String(item.lastError || ''),
    queuedAt: String(item.queuedAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || item.queuedAt || new Date().toISOString()),
  })) as OfflineAction[];
}

function saveOfflineQueue(queue: OfflineAction[]): void {
  if (queue.length > MAX_OFFLINE_ACTIONS) throw new Error('Organization offline queue capacity exceeded; existing batches were retained');
  const db = readDatabaseTables(["interactions","memories","settings","branchState"]);
  writeSetting(db, OFFLINE_QUEUE_SETTING, queue);
  commitDatabaseTables(db);
}

function getSyncIndex(): SyncIndex {
  const index = readSetting<unknown>(SYNC_INDEX_SETTING, {});
  return isObject(index) ? index as SyncIndex : {};
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
  init.signal?.throwIfAborted();
  const safeUrl = await validateCompanyEndpoint(url);
  init.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(safeUrl, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Company endpoint redirects are disabled to protect branch credentials');
    }
    return response;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
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
  const db = readDatabaseTables(["interactions","memories","settings","branchState"]);
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
  commitDatabaseTables(db);
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
  const db = readDatabaseTables(["interactions","memories","settings","branchState"]);
  const index = getSyncIndex();
  const select = (kind: BranchSyncItemReceipt['kind'], values: any[] = []) => values.filter(item => {
    if (item?.domain !== 'work' || item?.orgId !== orgId || !item?.id) return false;
    return index[itemKey(kind, String(item.id))]?.digest !== digest(item);
  });
  return {
    memories: select('memory', db.memories),
    interactions: select('interaction', db.interactions),
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
    } satisfies BranchSyncRequest,
    state: 'pending',
    attempts: 0,
    lastError: '',
    queuedAt: now,
    updatedAt: now,
  };
}

function createSyncActions(orgId: string, branchId: string, payload: SyncPayload): OfflineAction[] {
  const actions: OfflineAction[] = [];
  let memoryOffset = 0;
  let interactionOffset = 0;
  while (memoryOffset < payload.memories.length || interactionOffset < payload.interactions.length) {
    const memories = payload.memories.slice(memoryOffset, memoryOffset + MAX_SYNC_BATCH_ITEMS);
    const interactions = payload.interactions.slice(interactionOffset, interactionOffset + MAX_SYNC_BATCH_ITEMS - memories.length);
    memoryOffset += memories.length;
    interactionOffset += interactions.length;
    actions.push(createSyncAction(orgId, branchId, { memories, interactions }));
  }
  return actions;
}

async function splitUnacceptedOversizedActions(): Promise<void> {
  const queue = getOfflineQueue();
  let changed = false;
  const migrated = queue.flatMap(action => {
    const payload = action.payload as BranchSyncRequest;
    if (action.type !== 'sync' || payload?.orgId !== bs().orgId || payload?.branchId !== bs().branchId) return [action];
    const memories = Array.isArray(payload.memories) ? payload.memories : [];
    const interactions = Array.isArray(payload.interactions) ? payload.interactions : [];
    // Only a never-sent batch or an explicit protocol rejection proves that
    // replacing its identity is safe. An unknown outcome must be reconciled.
    const definitelyUnaccepted = (action.state === 'pending' && action.attempts === 0)
      || (action.state === 'blocked' && /^Branch sync batch exceeds 1000 items$/.test(action.lastError));
    if (!definitelyUnaccepted || memories.length + interactions.length <= MAX_SYNC_BATCH_ITEMS) return [action];
    changed = true;
    return createSyncActions(payload.orgId, payload.branchId, { memories, interactions });
  });
  if (!changed) return;
  saveOfflineQueue(migrated);
  await flushDBOrThrow();
}

export function getBranchState(): Readonly<BranchState> {
  return bs();
}

export async function connectToOrg(
  orgId: string,
  companyUrl: string,
  token: string,
): Promise<{ success: boolean; error?: string }> {
  const generation = ++connectionGeneration;
  pendingConnection?.abort(new Error('Organization connection was superseded'));
  const controller = new AbortController();
  pendingConnection = controller;
  const assertCurrent = () => {
    if (generation !== connectionGeneration || controller.signal.aborted) throw new Error('Organization connection was superseded or disconnected');
  };
  const state = bs();
  state.status = 'connecting';
  saveBranchState();
  try {
    // The immutable branch ID must reach disk before it is registered remotely.
    await flushDBOrThrow();
    assertCurrent();
    const normalizedUrl = normalizeCompanyUrl(companyUrl);
    const response = await fetchWithTimeout(`${normalizedUrl}/api/branch/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId, branchId: state.branchId }),
      signal: controller.signal,
    });
    assertCurrent();
    if (!response.ok) {
      const error = await responseError(response, 'Registration failed');
      assertCurrent();
      state.status = 'error';
      saveBranchState();
      return { success: false, error };
    }
    const body: any = await response.json();
    assertCurrent();
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
    assertCurrent();
    void runtimeBackgroundWork.track(pullKbCache());
    void runtimeBackgroundWork.track(flushOfflineQueue()).catch(error => console.warn('[Org] Pending sync remains queued:', error?.message || error));
    return { success: true };
  } catch (error: any) {
    if (generation === connectionGeneration) {
      state.status = 'error';
      saveBranchState();
    }
    return { success: false, error: String(error?.message || error) };
  } finally {
    if (pendingConnection === controller) pendingConnection = null;
  }
}

export function disconnectFromOrg(): void {
  connectionGeneration++;
  pendingConnection?.abort(new Error('Organization connection was disconnected'));
  pendingConnection = null;
  const state = bs();
  state.orgId = null;
  state.companyUrl = null;
  state.connectionToken = null;
  state.status = 'disconnected';
  state.currentDomain = 'personal';
  saveBranchState();
}

async function runSyncWorkData(includeUnsynced: boolean): Promise<SyncDrainResult> {
  const generation = connectionGeneration;
  const state = bs();
  if (!state.companyUrl || !state.connectionToken || !state.orgId) {
    return { synced: 0, flushed: 0, errors: ['Not connected to organization'] };
  }
  if (includeUnsynced && !getOfflineQueue().some(action => action.type === 'sync')) {
    const actions = createSyncActions(state.orgId, state.branchId, unsyncedPayload(state.orgId));
    if (actions.length) saveOfflineQueue([...getOfflineQueue(), ...actions]);
  }
  await splitUnacceptedOversizedActions();
  // Includes already queued batches: an earlier persistence failure must never
  // let a subsequent call send a newly generated identity before it is durable.
  await flushDBOrThrow();
  let synced = 0;
  let flushed = 0;
  for (const action of getOfflineQueue()) {
    if (generation !== connectionGeneration) return { synced, flushed, errors: ['Organization connection changed during sync'] };
    if (action.type === 'sync') {
      const result = await executeSyncAction(action);
      synced += result.synced;
      if (result.errors.length) return { synced, flushed, errors: result.errors };
    } else {
      saveOfflineQueue(getOfflineQueue().filter(candidate => candidate.id !== action.id));
    }
    flushed++;
  }
  return { synced, flushed, errors: [] };
}

function drainSyncQueue(includeUnsynced: boolean): Promise<SyncDrainResult> {
  if (syncInFlight) {
    if (includeUnsynced && !syncIncludesUnsynced) {
      return syncInFlight.then(result => result.errors.length ? result : drainSyncQueue(true));
    }
    return syncInFlight;
  }
  syncIncludesUnsynced = includeUnsynced;
  syncInFlight = runSyncWorkData(includeUnsynced).finally(() => { syncInFlight = null; });
  return syncInFlight;
}

export async function syncWorkData(): Promise<{ synced: number; errors: string[] }> {
  const { synced, errors } = await drainSyncQueue(true);
  return { synced, errors };
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
    const kbCache = (Array.isArray(body?.articles) ? body.articles : []).map((article: any) => ({
      id: String(article.id || ''),
      title: String(article.title || ''),
      content: String(article.content || ''),
      category: String(article.category || ''),
      tags: String(article.tags || ''),
      cachedAt: now,
    }));
    const db = readDatabaseTables(["interactions","memories","settings","branchState"]);
    writeSetting(db, KB_CACHE_SETTING, kbCache);
    commitDatabaseTables(db);
    return kbCache.length;
  } catch {
    return 0;
  }
}

export async function flushOfflineQueue(): Promise<{ flushed: number; errors: string[] }> {
  const { flushed, errors } = await drainSyncQueue(false);
  return { flushed, errors };
}

export function getOfflineQueueLength(): number {
  return getOfflineQueue().length;
}
