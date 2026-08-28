import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB } from '../db_layer';
import { mountBranchRoutes } from '../server/org/main_api';
import * as OrgDB from '../server/org/db';
import { mountBranchConnectionRoutes } from '../server/routes/branch_routes';
import { JWT_SECRET, makeApp } from './helpers';
import { updateOrganizationDevice } from '../server/org/resource_acl';

let cleanup = () => {};
let baseUrl = '';
let orgId = '';
let otherOrgId = '';
let branchToken = '';
const userId = `branch-sync-user-${Date.now()}`;
const adminId = `branch-sync-admin-${Date.now()}`;
const branchId = `branch_test_${Date.now()}`;
const batchId = `batch_test_${Date.now()}`;
const payloadTimestamp = new Date().toISOString();

function userToken(): string {
  return jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
}

function tokenFor(uid: string): string {
  return jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET);
}

async function registerBranch(): Promise<Response> {
  return fetch(`${baseUrl}/api/branch/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken()}` },
    body: JSON.stringify({ orgId, branchId }),
  });
}

function syncPayload(content = 'Remember the verified organization decision') {
  const timestamp = payloadTimestamp;
  return {
    orgId,
    branchId,
    batchId,
    interactions: [{
      id: 'local-interaction-1',
      userId,
      agentId: 'lumi',
      message: 'Create the organization drawing',
      response: 'Created with a verified receipt',
      conversationId: 'local-conversation-1',
      domain: 'work',
      orgId,
      timestamp,
    }],
    memories: [{
      id: 'local-memory-1',
      userId,
      content,
      keywords: ['organization', 'verified'],
      sourceInteractionId: 'local-interaction-1',
      agentId: 'lumi',
      domain: 'work',
      orgId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  };
}

async function postSync(payload: any, token = branchToken): Promise<Response> {
  return fetch(`${baseUrl}/api/branch/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

describe('durable organization branch sync', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    // Match the real application order: employee routes are mounted first.
    mountBranchConnectionRoutes(app.apiRouter, JWT_SECRET);
    mountBranchRoutes(app.apiRouter);

    orgId = OrgDB.createOrg('Branch Sync Organization', `branch-sync-${Date.now()}`, userId).id;
    otherOrgId = OrgDB.createOrg('Other Organization', `branch-other-${Date.now()}`, 'other-owner').id;
    OrgDB.addMember(orgId, userId, 'member');
    OrgDB.addMember(orgId, adminId, 'admin');
    OrgDB.addMember(otherOrgId, 'other-owner', 'owner');
    const response = await registerBranch();
    expect(response.status).toBe(200);
    const body: any = await response.json();
    branchToken = body.branchToken;
  });

  afterAll(() => cleanup());

  it('issues an immutable organization and branch scoped session', () => {
    const decoded: any = jwt.verify(branchToken, JWT_SECRET);
    expect(decoded).toMatchObject({
      uid: userId,
      orgId,
      branchId,
      tokenType: 'organization_branch',
    });
  });

  it('does not accept a user token for data sync or a branch token for registration', async () => {
    const userSync = await postSync(syncPayload(), userToken());
    expect(userSync.status).toBe(403);

    const branchRegistration = await fetch(`${baseUrl}/api/branch/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${branchToken}` },
      body: JSON.stringify({ orgId, branchId: `${branchId}_other` }),
    });
    expect(branchRegistration.status).toBe(403);

    const employeeSyncRoute = await fetch(`${baseUrl}/api/branch/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${branchToken}` },
    });
    expect(employeeSyncRoute.status).toBe(403);
  });

  it('does not allow another organization member to claim the immutable branch identity', async () => {
    const response = await fetch(`${baseUrl}/api/branch/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('other-owner')}` },
      body: JSON.stringify({ orgId: otherOrgId, branchId }),
    });
    expect(response.status).toBe(409);
  });

  it('persists all accepted records before returning a verified receipt', async () => {
    const response = await postSync(syncPayload());
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.receipt).toMatchObject({
      orgId,
      branchId,
      batchId,
      verified: true,
      accepted: 2,
      inserted: 2,
      rejected: 0,
      replayed: false,
    });
    expect(body.receipt.items).toHaveLength(2);

    const db = readDB();
    const interactionReceipt = body.receipt.items.find((item: any) => item.kind === 'interaction');
    const memoryReceipt = body.receipt.items.find((item: any) => item.kind === 'memory');
    const importedInteraction = db.interactions.find((item: any) => item.id === interactionReceipt.targetId);
    const importedMemory = db.memories.find((item: any) => item.id === memoryReceipt.targetId);

    expect(importedInteraction).toMatchObject({ userId, orgId, domain: 'work' });
    expect(importedMemory).toMatchObject({ userId, orgId, domain: 'work' });
    expect(importedInteraction.agentId).toBe('lumi');
    expect(importedMemory.agentId).toBe('lumi');
    expect(importedMemory.sourceInteractionId).toBe(interactionReceipt.targetId);
  });

  it('replays the same immutable batch without duplicating records', async () => {
    const before = {
      interactions: readDB().interactions.length,
      memories: readDB().memories.length,
    };
    const response = await postSync(syncPayload());
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.receipt.replayed).toBe(true);
    expect({
      interactions: readDB().interactions.length,
      memories: readDB().memories.length,
    }).toEqual(before);

    const receiptResponse = await fetch(
      `${baseUrl}/api/branch/ingest/receipts/${encodeURIComponent(batchId)}`,
      { headers: { Authorization: `Bearer ${branchToken}` } },
    );
    expect(receiptResponse.status).toBe(200);
    const receiptBody: any = await receiptResponse.json();
    expect(receiptBody.receipt).toMatchObject({ batchId, verified: true });
  });

  it('blocks batch mutation and cross-organization claims', async () => {
    const mutated = await postSync(syncPayload('Changed after the batch was committed'));
    expect(mutated.status).toBe(409);

    const crossOrg = syncPayload();
    crossOrg.batchId = `${batchId}_cross_org`;
    crossOrg.memories[0].orgId = otherOrgId;
    const rejected = await postSync(crossOrg);
    expect(rejected.status).toBe(403);
    expect(readDB().memories.some((item: any) => item.orgId === otherOrgId && item.userId === userId)).toBe(false);
  });

  it('survives a database close and restart with records and receipt ledger intact', async () => {
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();

    const db = readDB();
    expect(db.interactions.some((item: any) => item.orgId === orgId && item.domain === 'work')).toBe(true);
    expect(db.memories.some((item: any) => item.orgId === orgId && item.domain === 'work')).toBe(true);
    const ledgerSetting = db.settings.find((item: any) => item.key === 'org.branch.sync.ledger.v1');
    expect(ledgerSetting).toBeTruthy();
    const ledger = JSON.parse(ledgerSetting.value);
    expect(ledger.batches[`${orgId}:${branchId}:${batchId}`]).toMatchObject({ verified: true, accepted: 2 });
    const registrySetting = db.settings.find((item: any) => item.key === 'org.branch.registry.v1');
    expect(JSON.parse(registrySetting.value)[branchId]).toMatchObject({ orgId, userId, status: 'active' });
  });

  it('blocks sync and self-registration after an administrator revokes the exact device', async () => {
    const device = readDB().orgDevices.find((item: any) => item.orgId === orgId && item.branchId === branchId);
    expect(device).toBeTruthy();
    updateOrganizationDevice({
      orgId,
      actorUserId: adminId,
      deviceId: device.id,
      status: 'revoked',
    });

    const rejectedSync = await postSync({ ...syncPayload(), batchId: `${batchId}_after_revoke` });
    expect(rejectedSync.status).toBe(403);
    expect((await rejectedSync.json()).error).toMatch(/not active|revoked/i);

    const rejectedRegistration = await registerBranch();
    expect(rejectedRegistration.status).toBe(403);
    expect((await rejectedRegistration.json()).error).toMatch(/revoked/i);
  });
});
