import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowed: true,
  firstBootComplete: false,
  collect: vi.fn(),
  persistFirst: vi.fn(),
  persistDaily: vi.fn(),
}));

vi.mock('../server/middleware/auth', () => {
  const pass = (req: any, _res: any, next: any) => {
    req.user ||= { uid: 'local-admin', orgId: '' };
    next();
  };
  return { requireAuth: pass, requireAdmin: pass, requireLocalRequest: pass };
});

vi.mock('../server/autonomy/system_explorer', () => ({
  getLatestExploration: () => null,
  getExplorationHistory: () => [],
  isFirstBootComplete: () => mocks.firstBootComplete,
  getSystemExplorationConsent: () => ({ version: 1, status: mocks.allowed ? 'granted' : 'not_decided' }),
  setSystemExplorationConsent: (granted: boolean) => ({ version: 1, status: granted ? 'granted' : 'declined' }),
  isSystemExplorationAllowed: () => mocks.allowed,
  getSystemInspectionPolicy: () => ({
    version: 1,
    fileContentsRead: false,
    fileNamesPersisted: false,
    browserHistoryRead: false,
    credentialsRead: false,
    uniqueHardwareIdsPersisted: false,
    collectedCategories: ['operating_system'],
  }),
  persistFirstBootExploration: mocks.persistFirst,
  persistDailyExploration: mocks.persistDaily,
}));

vi.mock('../server/runtime/system_exploration_worker', () => ({
  collectSystemSnapshotInWorker: mocks.collect,
  resolveSystemExplorationRuntimeDir: () => 'resolved-system-exploration-runtime',
  SystemExplorationAlreadyRunningError: class extends Error {
    code = 'system_exploration_already_running';
  },
}));

vi.mock('../server/autonomy/professions', () => ({
  getProfessionProfile: () => [],
  buildProfessionOverlay: () => ({}),
  detectProfession: () => [],
  saveProfessionProfile: vi.fn(),
}));
vi.mock('../server/autonomy/profession_templates', () => ({
  installProfessionAgents: () => 0,
  getProfessionTemplates: () => [],
}));
vi.mock('../server/autonomy/planner', () => ({
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
  updatePlanStep: vi.fn(),
  listPlans: () => [],
  getPlan: vi.fn(),
  deletePlan: vi.fn(),
  getTodayPlanSummary: () => ({}),
}));
vi.mock('../server/org/db', () => ({ getMember: () => null }));
vi.mock('../db_layer', () => ({ readDB: () => ({}) }));

import { mountExploreRoutes } from '../server/routes/plan_explore_routes';

const snapshot = {
  id: 'explore_worker',
  timestamp: '2026-08-26T00:00:00.000Z',
  type: 'first_boot',
  computerScope: 'lumi_server_host',
  hardware: { hostname: 'test-host', cpus: { model: 'CPU', cores: 4, threads: 8 }, totalMemoryGB: 16, gpus: [], disks: [] },
  software: { osVersion: 'Test OS', installedApps: [], startupPrograms: [], runningServices: [] },
  filesystem: { homeDir: 'test', desktopFiles: 0, documentsFiles: 0, downloadsFiles: 0, totalUserFiles: 0, largeDirs: [], fileCountScope: 'desktop_documents_downloads', fileCountMaxDepth: 2 },
  network: { hostname: 'test-host', interfaces: [], ipAddresses: [] },
  inspectionPolicy: { version: 1 },
};

let server: http.Server | null = null;

beforeEach(() => {
  mocks.allowed = true;
  mocks.firstBootComplete = false;
  vi.clearAllMocks();
  mocks.persistFirst.mockImplementation(value => value);
  mocks.persistDaily.mockImplementation(value => value);
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function startServer(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  const router = Router();
  mountExploreRoutes(router);
  app.use('/api', router);
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('computer exploration HTTP isolation', () => {
  it('keeps the backend responsive while the worker scan is pending', async () => {
    let resolveWorker!: (value: typeof snapshot) => void;
    mocks.collect.mockImplementation(() => new Promise(resolve => { resolveWorker = resolve; }));
    const baseUrl = await startServer();

    const scanResponsePromise = fetch(`${baseUrl}/api/explore/scan`, { method: 'POST' });
    await vi.waitFor(() => expect(mocks.collect).toHaveBeenCalledWith('resolved-system-exploration-runtime'));

    const ping = await fetch(`${baseUrl}/ping`);
    expect(await ping.json()).toEqual({ ok: true });

    resolveWorker(snapshot);
    const scanResponse = await scanResponsePromise;
    expect(scanResponse.status).toBe(200);
    expect(await scanResponse.json()).toMatchObject({ scanned: true, snapshot: { id: 'explore_worker' } });
    expect(mocks.persistFirst).toHaveBeenCalledWith(snapshot);
    expect(mocks.persistDaily).not.toHaveBeenCalled();
  });

  it('exposes the inspection policy before consent and refuses to start a scan', async () => {
    mocks.allowed = false;
    const baseUrl = await startServer();

    const statusResponse = await fetch(`${baseUrl}/api/explore/status`);
    expect(await statusResponse.json()).toMatchObject({
      authorized: false,
      consent: { status: 'not_decided' },
      inspectionPolicy: { version: 1, fileContentsRead: false },
    });
    const scanResponse = await fetch(`${baseUrl}/api/explore/scan`, { method: 'POST' });
    expect(scanResponse.status).toBe(403);
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('discards a completed worker snapshot when consent is revoked before persistence', async () => {
    let resolveWorker!: (value: typeof snapshot) => void;
    mocks.collect.mockImplementation(() => new Promise(resolve => { resolveWorker = resolve; }));
    const baseUrl = await startServer();

    const scanResponsePromise = fetch(`${baseUrl}/api/explore/scan`, { method: 'POST' });
    await vi.waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(1));
    mocks.allowed = false;
    resolveWorker(snapshot);

    const scanResponse = await scanResponsePromise;
    expect(scanResponse.status).toBe(403);
    expect(mocks.persistFirst).not.toHaveBeenCalled();
    expect(mocks.persistDaily).not.toHaveBeenCalled();
  });
});
