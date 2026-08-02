import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB, writeDB } from '../db_layer';
import {
  connectToOrg,
  flushOfflineQueue,
  getBranchState,
  getOfflineQueueLength,
  syncWorkData,
} from '../server/org/branch';
import * as OrgDB from '../server/org/db';
import { mountBranchRoutes } from '../server/org/main_api';
import { JWT_SECRET, makeApp } from './helpers';

let cleanup = () => {};
let baseUrl = '';
let orgId = '';
const userId = `branch-client-user-${Date.now()}`;

function userToken(): string {
  return jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
}

function appendWorkMemory(id: string, content: string): void {
  const db = readDB();
  const now = new Date().toISOString();
  db.memories.push({
    id,
    userId,
    type: 'episodic',
    content,
    keywords: ['branch-client'],
    confidence: 0.9,
    sourceInteractionId: '',
    createdAt: now,
    updatedAt: now,
    tier: 'episodic',
    perspective: 'owner_trait',
    importance: 0.8,
    nodeType: 'leaf',
    domain: 'work',
    orgId,
  });
  writeDB(db);
}

function setting(key: string): any {
  const row = readDB().settings.find((item: any) => item.key === key);
  return row ? JSON.parse(row.value) : undefined;
}

describe('employee organization branch client durability', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    mountBranchRoutes(app.apiRouter);
    orgId = OrgDB.createOrg('Employee Branch Client', `branch-client-${Date.now()}`, userId).id;
    OrgDB.addMember(orgId, userId, 'member');
  });

  afterAll(() => cleanup());

  it('persists its stable branch identity and stores only the scoped branch token', async () => {
    const personalToken = userToken();
    const result = await connectToOrg(orgId, baseUrl, personalToken);
    expect(result).toEqual({ success: true });

    const state = getBranchState();
    expect(state.branchId).toMatch(/^branch_/);
    expect(state.orgId).toBe(orgId);
    expect(state.connectionToken).toBeTruthy();
    expect(state.connectionToken).not.toBe(personalToken);
    expect(jwt.verify(state.connectionToken!, JWT_SECRET)).toMatchObject({
      uid: userId,
      orgId,
      branchId: state.branchId,
      tokenType: 'organization_branch',
    });
    expect(setting('org.branch.client.state.v2')).toMatchObject({
      branchId: state.branchId,
      orgId,
      status: 'connected',
    });
  });

  it('reconciles a committed batch by receipt when the response is lost', async () => {
    appendWorkMemory('local-client-memory-committed', 'This batch commits before its response is lost.');
    const realFetch = globalThis.fetch;
    let droppedResponses = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/branch/ingest') && init?.method === 'POST') {
        const response = await realFetch(input, init);
        await response.arrayBuffer();
        droppedResponses += 1;
        throw new TypeError('simulated socket drop after commit');
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const result = await syncWorkData();
      expect(result.errors).toEqual([]);
      expect(result.synced).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(droppedResponses).toBe(1);
    expect(getOfflineQueueLength()).toBe(0);
    const index = setting('org.branch.client.sync_index.v2');
    expect(index['memory:local-client-memory-committed']).toMatchObject({
      digest: expect.any(String),
      receiptId: expect.any(String),
      targetId: expect.any(String),
    });
  });

  it('keeps an unconfirmed batch unknown and never blindly resends it', async () => {
    appendWorkMemory('local-client-memory-unknown', 'This request never reaches the company server.');
    const realFetch = globalThis.fetch;
    let ingestAttempts = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/branch/ingest') && init?.method === 'POST') {
        ingestAttempts += 1;
        throw new TypeError('simulated disconnect before send');
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const first = await syncWorkData();
      expect(first.synced).toBe(0);
      expect(first.errors.join(' ')).toContain('unknown');
      expect(getOfflineQueueLength()).toBe(1);

      const retry = await flushOfflineQueue();
      expect(retry.flushed).toBe(0);
      expect(retry.errors.join(' ')).toContain('unknown');
      expect(ingestAttempts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }

    const queue = setting('org.branch.client.offline_queue.v2');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: 'sync', state: 'unknown', attempts: 1 });
    expect(queue[0].payload.memories.some((item: any) => item.id === 'local-client-memory-unknown')).toBe(true);
  });

  it('keeps the client state and unknown batch across a database restart', async () => {
    const branchId = getBranchState().branchId;
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();

    expect(setting('org.branch.client.state.v2')).toMatchObject({ branchId, orgId });
    expect(setting('org.branch.client.offline_queue.v2')).toMatchObject([
      expect.objectContaining({ type: 'sync', state: 'unknown' }),
    ]);
  });
});
