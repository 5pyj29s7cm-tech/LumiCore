// LumiOS unified server. Personal and organization work domains share one client.
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";

const IS_DESKTOP_RUNTIME = process.env.LUMI_DESKTOP === '1';
const DESKTOP_LOG_FILE = process.env.LUMI_LOG_FILE || (
  IS_DESKTOP_RUNTIME
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LumiOS', 'server.log')
    : ''
);
const MAX_DESKTOP_LOG_BYTES = 8 * 1024 * 1024;

function stringifyLogPart(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendRuntimeLog(level: string, values: unknown[]): void {
  if (!DESKTOP_LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(DESKTOP_LOG_FILE), { recursive: true });
    try {
      const stat = fs.existsSync(DESKTOP_LOG_FILE) ? fs.statSync(DESKTOP_LOG_FILE) : null;
      if (stat && stat.size > MAX_DESKTOP_LOG_BYTES) {
        const rotated = `${DESKTOP_LOG_FILE}.1`;
        try { fs.rmSync(rotated, { force: true }); } catch {}
        try { fs.renameSync(DESKTOP_LOG_FILE, rotated); } catch {}
      }
    } catch {}
    fs.appendFileSync(
      DESKTOP_LOG_FILE,
      `[${new Date().toISOString()}] [${level}] ${values.map(stringifyLogPart).join(' ')}\n`,
      'utf8',
    );
  } catch {}
}

if (DESKTOP_LOG_FILE) {
  process.env.LUMI_LOG_FILE = DESKTOP_LOG_FILE;
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    appendRuntimeLog('INFO', args);
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    appendRuntimeLog('WARN', args);
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    appendRuntimeLog('ERROR', args);
    originalError(...args);
  };
}

// ── Global exception handlers (must be first — before any async setup) ──
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  if (!IS_DESKTOP_RUNTIME || process.env.LUMI_EXIT_ON_UNCAUGHT_EXCEPTION === '1') {
    process.exit(1);
  }
  console.error('[DesktopRuntime] Keeping local backend alive after uncaught exception.');
});
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
  if (reason instanceof Error) console.error(reason.stack);
  if (!IS_DESKTOP_RUNTIME || process.env.LUMI_EXIT_ON_UNHANDLED_REJECTION === '1') {
    process.exit(1);
  }
  console.error('[DesktopRuntime] Keeping local backend alive after unhandled rejection.');
});

import { fileURLToPath } from "url";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import express from "express";
import { createApp } from "./server/runtime/core";
import { createLLMRuntime } from "./server/runtime/llm";
import { mountAllRoutes } from "./server/runtime/routes";
import { initSocketRuntime } from "./server/runtime/socket";
import { setupMcpServer } from "./server/runtime/mcp_server";
import { setupMessaging } from "./server/runtime/messaging";
import { setupStatic } from "./server/runtime/static";
import { bootstrap } from "./server/runtime/bootstrap";
import { lapRoutes } from "./server/lap/routes";
import voiceRoutes from "./routes/voice";
import fileRoutes, { configureKnowledgeFileRoutes } from "./routes/files";
import { subscriptionRoutes } from "./server/subscription/routes";
import {
  configureNcmCredentials,
  normalizeNcmAppId as normalizeStoredNcmAppId,
  normalizeNcmPrivateKey as normalizeStoredNcmPrivateKey,
  runNcmCliAsync as runStoredNcmCli,
} from "./server/music/ncm_cli";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, server, io, apiRouter, PORT, HOST, JWT_SECRET, getCookieOptions } = createApp();
const llm = createLLMRuntime();

// ── Static serve for lumi_output (charts, images, generated files) ──
app.use('/lumi_output', express.static(path.join(process.cwd(), 'lumi_output')));

// ── Shared routes (both roles) ──
mountAllRoutes({ apiRouter, jwtSecret: JWT_SECRET, llm, getCookieOptions, io });
configureKnowledgeFileRoutes({
  llmGetters: {
    getDeepSeek: llm.getDeepSeek,
    getGemini: llm.getGemini,
    getOpenAI: llm.getOpenAI,
    getAnthropic: llm.getAnthropic,
    getQwen: llm.getQwen,
    getOllama: llm.getOllama,
    getLmStudio: llm.getLmStudio,
    getArk: llm.getArk,
    getXiaomi: llm.getXiaomi,
    getKimi: llm.getKimi,
    getGlm: llm.getGlm,
    getRelay: llm.getRelay,
  },
});
apiRouter.use("/", voiceRoutes);
apiRouter.use("/", fileRoutes);
apiRouter.use("/", subscriptionRoutes);
apiRouter.use("/", lapRoutes);

// ── NetEase ncm-cli login ──
let ncmLoginPolling: ReturnType<typeof setTimeout> | null = null;
let ncmLoginQrUrl: string | null = null;
let ncmLoginDone = false;
const execFileP = promisify(execFile);

async function runNcmCli(args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  const result = await runStoredNcmCli(args, timeout);
  if (!result.ok) throw new Error(result.error || result.stderr || result.stdout || 'ncm-cli failed');
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}
async function checkNcmLoginStatus(timeout = 8000): Promise<boolean> {
  try {
    const check = await runNcmCli(['login', '--check', '--output', 'json'], timeout);
    const data = JSON.parse(check.stdout || '{}');
    ncmLoginDone = isNcmLoggedInPayload(data);
    if (ncmLoginDone) {
      ncmLoginQrUrl = null;
      if (ncmLoginPolling) {
        clearInterval(ncmLoginPolling);
        ncmLoginPolling = null;
      }
    }
  } catch {
    // Keep the last known in-memory state if ncm-cli cannot answer right now.
  }
  return ncmLoginDone;
}

function extractNcmQrUrl(data: any): string | null {
  return data?.qrCodeUrl
    || data?.clickableUrl
    || data?.qrUrl
    || data?.url
    || data?.data?.qrCodeUrl
    || data?.data?.clickableUrl
    || data?.data?.qrUrl
    || data?.data?.url
    || null;
}

function isNcmLoggedInPayload(data: any): boolean {
  return Boolean(
    data?.success
    || data?.done
    || data?.loggedIn
    || data?.isLogin
    || data?.login
    || data?.data?.success
    || data?.data?.done
    || data?.data?.loggedIn
    || data?.data?.isLogin
    || data?.data?.profile
    || data?.account
    || data?.profile,
  );
}

async function syncStoredNcmCredentials(timeout = 10000): Promise<{ ok: boolean; error?: string }> {
  try {
    const { getKey } = await import('./server/config/keys');
    const appId = normalizeStoredNcmAppId(getKey('NETEASE_APP_ID'));
    const privateKey = normalizeStoredNcmPrivateKey(getKey('NETEASE_PRIVATE_KEY'));
    if (!appId || !privateKey) return { ok: false, error: 'NetEase credentials are not saved.' };
    await configureNcmCredentials(appId, privateKey, timeout);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Configure ncm-cli credentials (appId + privateKey from developer.music.163.com)
apiRouter.post('/ncm/configure', async (req, res) => {
  try {
    const { appId, privateKey } = req.body || {};
    const safeAppId = normalizeStoredNcmAppId(appId);
    const safePrivateKey = normalizeStoredNcmPrivateKey(privateKey);
    if (!safeAppId || !safePrivateKey) {
      return res.json({ success: false, error: 'appId and privateKey are required' });
    }
    await configureNcmCredentials(safeAppId, safePrivateKey, 10000);
    const { saveKeys } = await import('./server/config/keys');
    saveKeys({ NETEASE_APP_ID: safeAppId, NETEASE_PRIVATE_KEY: safePrivateKey });
    console.log('[NCM] Credentials configured.');
    res.json({ success: true });
  } catch (e: any) {
    res.json({ success: false, error: e.message || String(e) });
  }
});

apiRouter.get('/ncm/configure/status', async (_req, res) => {
  let hasStoredKeys = false;
  let syncError = '';
  try {
    const { getKey } = await import('./server/config/keys');
    const appId = normalizeStoredNcmAppId(getKey('NETEASE_APP_ID'));
    const privateKey = normalizeStoredNcmPrivateKey(getKey('NETEASE_PRIVATE_KEY'));
    hasStoredKeys = Boolean(appId && privateKey);
    if (appId && privateKey) {
      const synced = await syncStoredNcmCredentials(10000);
      if (!synced.ok) {
        syncError = synced.error || '';
        console.warn('[NCM] Stored credentials exist but ncm-cli configure failed:', syncError);
      }
    }
    const envConfigured = Boolean(
      normalizeStoredNcmAppId(process.env.NETEASE_APP_ID)
      && normalizeStoredNcmPrivateKey(process.env.NETEASE_PRIVATE_KEY),
    );
    res.json({
      configured: hasStoredKeys || envConfigured,
      synced: envConfigured && !syncError,
      error: syncError || undefined,
    });
  } catch {
    res.json({ configured: hasStoredKeys, synced: false, error: syncError || undefined });
  }
});

apiRouter.post('/ncm/login', async (_req, res) => {
  try {
    const synced = await syncStoredNcmCredentials(10000);
    if (!synced.ok) console.warn('[NCM] Login requested before credentials synced:', synced.error);
    if (await checkNcmLoginStatus(8000)) {
      return res.json({ success: true, done: true, qrUrl: null });
    }
    const result = await runNcmCli(['login', '--background', '--output', 'json'], 15000);
    const data = JSON.parse(result.stdout || '{}');
    ncmLoginQrUrl = extractNcmQrUrl(data);
    if (!ncmLoginQrUrl) {
      return res.json({
        success: false,
        done: false,
        error: data.message || data.error || 'NetEase login did not return a QR URL.',
      });
    }
    ncmLoginDone = false;

    // Poll login status every 3s
    if (ncmLoginPolling) clearInterval(ncmLoginPolling);
    ncmLoginPolling = setInterval(async () => {
      try {
        await checkNcmLoginStatus(8000);
      } catch {}
    }, 3000);

    res.json({ success: true, qrUrl: ncmLoginQrUrl });
  } catch (e: any) {
    res.json({ success: false, error: e.message || String(e) });
  }
});

// On startup: configure ncm-cli (mpv path + credentials), then check login
(async () => {
  try {
    const fs = await import('fs');

    // Configure mpv player path so ncm-cli can find it
    const mpvPath = process.env.MPV_PATH
      || (fs.existsSync('C:/Program Files/MPV Player/mpv.exe') ? 'C:/Program Files/MPV Player/mpv.exe' : 'mpv');
    await runNcmCli(['config', 'set', 'player', mpvPath], 10000).catch(() => {});
    console.log(`[NCM] Player configured: ${mpvPath}`);

    await syncStoredNcmCredentials(10000).catch(() => {});
    if (await checkNcmLoginStatus(10000)) {
      console.log('[NCM] Already logged in from previous session.');
    }
  } catch {}
})();

// ── Auto-detect mpv for ncm-cli playback ──
(async () => {
  const fs = await import('fs');
  try {
    // Check if mpv is already configured
    const { stdout: existingPlayer } = await runNcmCli(['config', 'get', 'player'], 8000);
    if (existingPlayer.includes('mpv') || existingPlayer.includes('orpheus')) {
      console.log('[NCM] Player already configured:', existingPlayer.trim());
      return;
    }
  } catch {
    // config get failed — no player set, detect and configure
  }
  try {
    // Find mpv in PATH or common install locations
    try {
      await execFileP(process.platform === 'win32' ? 'where.exe' : 'which', ['mpv'], { timeout: 5000, windowsHide: true });
      await runNcmCli(['config', 'set', 'player', 'mpv'], 8000);
      console.log('[NCM] Auto-configured player: mpv');
      return;
    } catch {
      // mpv is not in PATH; continue with common install locations.
    }
    // Check common Windows install path
    if (process.platform === 'win32') {
      if (fs.existsSync('C:\\Program Files\\MPV Player\\mpv.exe')) {
        // Add to PATH for current process
        process.env.PATH = (process.env.PATH || '') + ';C:\\Program Files\\MPV Player';
        await runNcmCli(['config', 'set', 'player', 'mpv'], 8000);
        console.log('[NCM] Auto-configured player: mpv (C:\\Program Files\\MPV Player)');
        return;
      }
    }
    console.log('[NCM] mpv not found — music playback unavailable. Install mpv from https://mpv.io');
  } catch (e: any) {
    console.warn('[NCM] Failed to auto-configure player:', e.message || String(e));
  }
})();

apiRouter.get('/ncm/login/status', async (_req, res) => {
  const done = await checkNcmLoginStatus(8000);
  res.json({ done, qrUrl: ncmLoginQrUrl });
});

// ── Org routes ──
// Organization routes are always mounted for the work domain in the unified client.
{
  const { mountOrgRoutes } = await import("./server/org/routes");
  mountOrgRoutes(apiRouter, io);
  const { mountBranchRoutes } = await import("./server/org/main_api");
  const { attachOrgWs } = await import("./server/org/ws_sync");
  mountBranchRoutes(apiRouter);
  attachOrgWs(io);
  console.log('[Org] Routes mounted at /api/org/*');
  console.log('[Org] Branch API mounted at /api/branch/*');
  console.log('[Org] WebSocket sync attached');
}

// ── Infrastructure ──
setupMessaging(apiRouter, llm, io);
setupMcpServer(app, server, io, llm, path.join(__dirname, 'server'));
initSocketRuntime({ io, jwtSecret: JWT_SECRET, llm });

// Cleanup mpv on exit so music stops when server shuts down
process.on('exit', () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/IM', 'mpv.exe'], { timeout: 3000, stdio: 'ignore' });
    }
  } catch {}
});
// SIGINT/SIGTERM are handled by bootstrap.ts with proper cleanup + flushDB

async function start() {
  await setupStatic(app, __filename, __dirname);
  await bootstrap({ server, io, PORT, HOST, jwtSecret: JWT_SECRET, llm, __dirname });
}

start().catch((err) => {
  console.error('[FATAL] Server startup failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
