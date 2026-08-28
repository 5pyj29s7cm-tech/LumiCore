// LumiCore unified server. Personal and organization work domains share one client.
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";

const IS_DESKTOP_RUNTIME = process.env.LUMI_DESKTOP === '1';
const DESKTOP_LOG_FILE = process.env.LUMI_LOG_FILE || (
  IS_DESKTOP_RUNTIME
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LumiCore', 'server.log')
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
import { getGeneratedOutputDir } from "./server/config/data_path";
import { requireAdmin, requireAuth, requireLocalRequest } from "./server/middleware/auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, server, io, apiRouter, PORT, HOST, JWT_SECRET, getCookieOptions } = createApp();
const llm = createLLMRuntime();

// ── Static serve for lumi_output (charts, images, generated files) ──
app.use('/lumi_output', requireAuth, requireAdmin, requireLocalRequest, express.static(getGeneratedOutputDir()));

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
apiRouter.use("/", lapRoutes);

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

async function start() {
  await setupStatic(app, __filename, __dirname);
  await bootstrap({ server, io, PORT, HOST, jwtSecret: JWT_SECRET, llm, __dirname });
}

start().catch((err) => {
  console.error('[FATAL] Server startup failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
