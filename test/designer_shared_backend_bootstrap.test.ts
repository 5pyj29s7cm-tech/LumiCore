import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import * as database from '../db_layer';
import { mountAuthRoutes } from '../server/routes/auth';
import { getDataRoot, designerDataMergeReceiptPath, legacyLegalDataFingerprint } from '../server/config/data_path';
import { initializeDesktopBootstrapProof, getDesktopBootstrapProofPath, DESKTOP_BOOTSTRAP_HEADER } from '../server/config/desktop_bootstrap';

let app: Awaited<ReturnType<typeof makeApp>>;
const homes: string[] = [];
const identity = { schemaVersion: 1, clientKind: 'local_acceptance_harness', pid: process.pid, startedAtUnixMs: Date.now() - 1000,
  executablePath: process.execPath, executableSha256: 'd'.repeat(64), binaryHashUnavailable: false, buildId: 'c'.repeat(40),
  buildIdSemantics: 'baseline_commit', sourceFingerprint: 'e'.repeat(64), sourceDirty: false, appVersion: '3.1.1' };
beforeAll(async () => { app = await makeApp(); mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS); });
afterAll(() => app.cleanup());
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) {
    if (path.dirname(home) !== path.dirname(getDataRoot()) || !path.basename(home).startsWith('designer-bootstrap-')) throw Error('Unsafe fixture cleanup');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
function history(valid = false) {
  const home = fs.mkdtempSync(path.join(path.dirname(getDataRoot()), 'designer-bootstrap-')); homes.push(home);
  const source = path.join(home, 'LumiCore-Designer'), target = getDataRoot();
  fs.mkdirSync(path.join(source, 'data'), { recursive: true }); fs.writeFileSync(path.join(source, 'data/history.txt'), 'SYNTHETIC HISTORY');
  if (valid) {
    const manifestPath = path.join(home, 'private-backup/maintenance-manifest.json'); fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const raw = JSON.stringify({ version: 1, phase: 'prepared', sourceVariant: 'designer', sourceRoot: source, targetRoot: target, inputDigest: 'a'.repeat(64), migratedFiles: [] });
    fs.writeFileSync(manifestPath, raw);
    const receiptPath = designerDataMergeReceiptPath(source, target); fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify({ version: 1, phase: 'completed', sourceVariant: 'designer', sourceRoot: source, targetRoot: target,
      sourceFingerprint: legacyLegalDataFingerprint(source), inputDigest: 'a'.repeat(64), maintenanceManifest: manifestPath,
      maintenanceManifestSha256: crypto.createHash('sha256').update(raw).digest('hex') }));
  }
  vi.spyOn(os, 'homedir').mockReturnValue(home); return { home, source };
}
async function bootstrap(product = 'com.lumiai.designer', withProof = true) {
  initializeDesktopBootstrapProof();
  const before = JSON.parse(fs.readFileSync(getDesktopBootstrapProofPath(), 'utf8')).proof;
  const response = await fetch(app.url + '/api/auth/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(withProof ? { [DESKTOP_BOOTSTRAP_HEADER]: before } : {}) },
    body: JSON.stringify({ nativeClientIdentity: identity, sharedBackendReuse: true, nativeProductIdentifier: product }) });
  const data = await response.json() as Record<string, unknown>;
  return { status: response.status, data, rotated: before !== JSON.parse(fs.readFileSync(getDesktopBootstrapProofPath(), 'utf8')).proof };
}

it('rejects Designer shared reuse before reading users or issuing a session when its history is unreviewed', async () => {
  const { source } = history(); const reads = vi.spyOn(database, 'readDatabaseTables');
  const response = await bootstrap();
  expect(response.status).toBe(409); expect(response.data.code).toBe('DESIGNER_DATA_MERGE_REQUIRED');
  expect(response.data.token).toBeUndefined(); expect(response.data.desktopSessionProof).toBeUndefined();
  expect(response.rotated).toBe(true); expect(reads).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(source, 'data/history.txt'), 'utf8')).toBe('SYNTHETIC HISTORY');
});

it('checks the native one-time proof before inspecting legacy history or reading users', async () => {
  history(); const reads = vi.spyOn(database, 'readDatabaseTables'), homeReads = vi.spyOn(os, 'homedir'); homeReads.mockClear();
  const response = await bootstrap('com.lumiai.designer', false);
  expect(response.status).toBe(403); expect(response.rotated).toBe(false);
  expect(homeReads).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
  expect(response.data.token).toBeUndefined(); expect(response.data.desktopSessionProof).toBeUndefined();
});

it('allows reviewed Designer reuse and preserves the original native/session handoff', async () => {
  history(true); const response = await bootstrap();
  expect(response.status).toBe(200); expect(response.data.success).toBe(true); expect(response.rotated).toBe(true);
  expect(response.data.nativeClientIdentity).toMatchObject({ pid: process.pid, clientKind: identity.clientKind });
  expect(typeof response.data.token).toBe('string'); expect(typeof response.data.desktopSessionProof).toBe('string');
});

it('rejects changed source history after a reviewed merge without inspecting users', async () => {
  const { source } = history(true); fs.writeFileSync(path.join(source, 'data/new.txt'), 'New history');
  const reads = vi.spyOn(database, 'readDatabaseTables'), response = await bootstrap();
  expect(response.status).toBe(409); expect(response.data.code).toBe('DESIGNER_DATA_MERGE_REQUIRED'); expect(reads).not.toHaveBeenCalled();
});

it('does not apply the Designer history guard to Main reuse', async () => {
  history(); const response = await bootstrap('com.lumiai.os');
  expect(response.status).toBe(200); expect(response.data.success).toBe(true); expect(response.rotated).toBe(true);
});
