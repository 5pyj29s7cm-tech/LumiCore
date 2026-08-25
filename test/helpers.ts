// Test helper — creates an isolated Express app for testing specific routes.
// Guards against the top-level migration in db_layer.ts by pre-creating the temp dir.

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import { afterAll } from 'vitest';

const testTempBase = process.env.LUMI_TEST_TMPDIR || os.tmpdir();
const tmpRoot = path.join(testTempBase, `lumi_test_${crypto.randomUUID().slice(0, 8)}`);
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, '.migration_skip'), '');
process.env.LUMI_DATA_DIR = tmpRoot;
process.env.JWT_SECRET = 'test-jwt-test-jwt'; // match JWT_SECRET constant below

function cleanupTempRoot(): void {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// Some suites do not create an HTTP app and therefore never call cleanup().
// Close SQLite before removing the directory because Windows locks open files.
afterAll(async () => {
  try {
    const { closeDatabase } = await import('../db_layer');
    await closeDatabase();
  } finally {
    cleanupTempRoot();
  }
});
process.once('exit', cleanupTempRoot);

let dbReady: Promise<void> | null = null;

const SAFE_TEST_PORT_MIN = 20_000;
const SAFE_TEST_PORT_MAX_EXCLUSIVE = 45_000;

async function listenOnFetchSafePort(server: http.Server): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = crypto.randomInt(SAFE_TEST_PORT_MIN, SAFE_TEST_PORT_MAX_EXCLUSIVE);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Unable to allocate a fetch-safe test port after 64 attempts');
}

function ensureDb(): Promise<void> {
  if (!dbReady) {
    dbReady = import('../db_layer').then(m => m.initDatabase());
  }
  return dbReady;
}

export async function makeApp(): Promise<{
  app: express.Express;
  apiRouter: express.Router;
  server: http.Server;
  url: string;
  cleanup: () => void;
}> {
  await ensureDb();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  const apiRouter = express.Router();
  apiRouter.use((_req: any, res: any, next: any) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
  });

  // Express error handler (catch async errors)
  apiRouter.use((err: any, _req: any, res: any, _next: any) => {
    console.error('[Test API Error]', err?.message || err);
    res.status(500).json({ error: err?.message || 'Internal server error' });
  });

  app.use('/api', apiRouter);

  const server = http.createServer(app);
  const port = await listenOnFetchSafePort(server);

  return {
    app,
    apiRouter,
    server,
    url: `http://127.0.0.1:${port}`,
    cleanup: () => {
      server.close();
      cleanupTempRoot();
    },
  };
}

// ── Auth helpers ──
export const JWT_SECRET = 'test-jwt-test-jwt';
export const COOKIE_OPTS = () =>
  ({ httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 86400000 });

export const STUB_LLM = () => ({}) as any;
export const LLM_GETTERS = {
  getDeepSeek: STUB_LLM,
  getGemini: STUB_LLM,
  getOpenAI: STUB_LLM,
  getAnthropic: STUB_LLM,
  getQwen: STUB_LLM,
  getArk: STUB_LLM,
};
