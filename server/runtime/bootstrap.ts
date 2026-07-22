import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { readDB, writeDB, flushDB, ensureDatabaseInitialized, isDbDirty, pruneOldData } from "../../db_layer";
import { toolRegistry } from "../tools/registry";
import { registerAllTools } from "../tools/definitions/index";
import { mcpManager, registerMCPTools } from "../mcp";
import { scheduler, registerScheduledTasks } from "../scheduler";
import { runFirstBootExploration, isFirstBootComplete } from "../autonomy/system_explorer";
import { installProfessionAgents } from "../autonomy/profession_templates";
import bcrypt from "bcryptjs";
import { getLocalAdminPassword } from "../config/local_identity";
import { repairCorruptedOrganizationNames } from "../org/db";
import { startMessagingConnections, stopMessagingConnections } from "./messaging";
import { recoverOrphanedConversationActionExecutions } from "../conversation/manager";

interface BootstrapContext {
  server: any;
  io: any;
  PORT: number;
  HOST: string;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
    getOllama?: any; getLmStudio?: any; getArk?: any; getXiaomi?: any; getKimi?: any; getGlm?: any; getRelay?: any;
    refreshLocalModels?: () => Promise<{ ollama: boolean; lmstudio: boolean }>;
  };
  __dirname: string;
}

function scheduleFirstBootExploration(delayMs = 30000) {
  const timer = setTimeout(() => {
    try {
      if (!isFirstBootComplete()) {
        console.log('[Bootstrap] First boot detected - running system exploration after server startup...');
        const snapshot = runFirstBootExploration();
        console.log(`[Bootstrap] Exploration complete: ${snapshot.hardware.cpus.model}, ${snapshot.hardware.totalMemoryGB}GB RAM, ${snapshot.software.installedApps.length} apps, ${snapshot.filesystem.totalUserFiles} user files`);
        const installed = installProfessionAgents();
        if (installed > 0) console.log(`[Bootstrap] Installed ${installed} profession agents`);
      }
    } catch (err) {
      console.warn('[Bootstrap] System exploration failed:', (err as Error).message);
    }
  }, delayMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

function schedulePostStartupFlush(delayMs: number) {
  const timer = setTimeout(() => {
    if (!isDbDirty()) return;
    flushDB()
      .then(() => console.log(`[Bootstrap] Database flushed after startup writes (${delayMs}ms)`))
      .catch((err: any) => console.warn('[Bootstrap] Post-startup database flush failed:', err?.message || err));
  }, delayMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

export async function bootstrap(ctx: BootstrapContext) {
  const { server, io, PORT, HOST, jwtSecret, llm, __dirname } = ctx;

  if (!jwtSecret) {
    console.error('FATAL: JWT_SECRET environment variable is not set.');
    process.exit(1);
  }

  try {
    await ensureDatabaseInitialized();
    console.log('Database initialized successfully');
    const recoveredTasks = recoverOrphanedConversationActionExecutions();
    if (recoveredTasks > 0) {
      console.warn(`[Bootstrap] Recovered ${recoveredTasks} orphaned conversation task lease(s)`);
    }
    if (llm.refreshLocalModels) {
      const localModels = await llm.refreshLocalModels();
      console.log(`[LLM] Local runtime ready — Ollama=${localModels.ollama}, LM Studio=${localModels.lmstudio}`);
    }
    const repairedOrgNames = repairCorruptedOrganizationNames();
    if (repairedOrgNames > 0) {
      console.warn(`[Bootstrap] Repaired ${repairedOrgNames} corrupted organization name(s)`);
    }
    pruneOldData();
    await flushDB();
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }

  // Auto-create admin account for local/desktop use
  const adminPassword = getLocalAdminPassword();
  if (adminPassword) {
    try {
      const db = readDB();
      const adminExists = db.users.find((u: any) => u.username === 'admin');
      if (!adminExists) {
        db.users.push({
          uid: Math.random().toString(36).substring(2, 15),
          username: 'admin',
          password: await bcrypt.hash(adminPassword, 10),
          phone: '+00000000000',
          role: 'admin',
          balance: 999.0,
          createdAt: new Date().toISOString(),
        });
        writeDB(db);
        console.log('[Bootstrap] Admin account created');
      }
    } catch (err) {
      console.warn('[Bootstrap] Failed to ensure admin account:', (err as Error).message);
    }
  }

  // Register all agent tools
  registerAllTools(toolRegistry, { getDeepSeek: llm.getDeepSeek, getGemini: llm.getGemini, getOpenAI: llm.getOpenAI, getAnthropic: llm.getAnthropic, getQwen: llm.getQwen });
  console.log(`[Tools] Registered ${toolRegistry.list().length} built-in tools`);

  // Register MCP tools (non-blocking)
  registerMCPTools(io).then(mcpTools => {
    if (mcpTools.length > 0) {
      console.log(`[MCP] Registered ${mcpTools.length} MCP tools (total: ${toolRegistry.list().length})`);
    }
  }).catch(err => {
    console.warn('[MCP] Tool registration warning:', err.message);
  });

  // Start GPT-SoVITS API server (optional)
  let gptSovitsProcess: ChildProcess | null = null;
  const gptSovitsDir = path.join(__dirname, 'gpt-sovits-src');
  const pythonExe = path.join(gptSovitsDir, 'venv/Scripts/python.exe');
  const apiPy = path.join(gptSovitsDir, 'api_v2.py');
  if (fs.existsSync(pythonExe) && fs.existsSync(apiPy)) {
    console.log('[GPT-SoVITS] Starting API server...');
    gptSovitsProcess = spawn(pythonExe, [
      apiPy,
      '-a', '127.0.0.1',
      '-p', '9880',
      '-c', 'GPT_SoVITS/configs/tts_infer.yaml',
    ], {
      cwd: gptSovitsDir,
      stdio: 'pipe',
    });
    gptSovitsProcess.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[GPT-SoVITS] ${line}`);
    });
    gptSovitsProcess.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.warn(`[GPT-SoVITS] ${line}`);
    });
    gptSovitsProcess.on('error', (err) => {
      console.warn('[GPT-SoVITS] Process error:', err.message);
      gptSovitsProcess = null;
    });
    gptSovitsProcess.on('exit', (code) => {
      if (code && code !== 0) console.warn(`[GPT-SoVITS] Exited with code ${code}`);
      gptSovitsProcess = null;
    });
  } else {
    console.log('[GPT-SoVITS] Not found — TTS will use cloud providers only.');
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] Port ${PORT} is already in use. Please close the other process and try again.`);
    } else {
      console.error('[FATAL] Server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    void startMessagingConnections().catch((err: any) => {
      console.warn('[Messaging] Long-connection startup failed:', err?.message || err);
    });
    scheduler.setIO(io);
    registerScheduledTasks(llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen, llm.getOllama, llm.getLmStudio, llm.getArk, llm.getXiaomi, llm.getKimi, llm.getGlm, llm.getRelay);

    // Clean up stale ephemeral agents on startup
    try {
      const db = readDB();
      if (db.agents) {
        const before = db.agents.length;
        db.agents = db.agents.filter((a: any) => !a.id.startsWith('ephemeral_'));
        if (before !== db.agents.length) {
          writeDB(db);
          console.log(`[Bootstrap] Cleaned ${before - db.agents.length} ephemeral agents`);
        }
      }
    } catch {}

    // Auto-install legal and design agent templates to all orgs
    import('../legal/templates').then(({ installLegalTemplates }) => {
      const db2 = readDB();
      const orgs = (db2 as any).organizations || [];
      let total = 0;
      for (const org of orgs) {
        total += installLegalTemplates(org.id);
      }
      if (total > 0) console.log(`[Org] Installed ${total} legal agent templates across ${orgs.length} org(s)`);
    }).catch((err: any) => {
      console.warn('[Org] Failed to install legal templates:', err.message);
    });

    import('../design/templates').then(({ installDesignTemplates }) => {
      const db2 = readDB();
      const orgs = (db2 as any).organizations || [];
      let total = 0;
      for (const org of orgs) {
        total += installDesignTemplates(org.id);
      }
      if (total > 0) console.log(`[Org] Installed ${total} design agent templates across ${orgs.length} org(s)`);
    }).catch((err: any) => {
      console.warn('[Org] Failed to install design templates:', err.message);
    });

    scheduleFirstBootExploration();
    schedulePostStartupFlush(5_000);
    schedulePostStartupFlush(30_000);
  });

  // Cleanup on exit
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log('[Shutdown] Cleaning up...');
    scheduler.stop();
    try {
      await stopMessagingConnections();
      console.log('[Messaging] Long connections stopped');
    } catch (err: any) {
      console.warn('[Messaging] Shutdown error:', err?.message || err);
    }
    try {
      await flushDB();
      console.log('[Shutdown] Database flushed');
    } catch {}
    try {
      await mcpManager.disconnectAll();
      console.log('[MCP] All servers disconnected');
    } catch (err: any) {
      console.warn('[MCP] Disconnect error:', err.message);
    }
    if (gptSovitsProcess && !gptSovitsProcess.killed) {
      console.log('[GPT-SoVITS] Stopping API server...');
      gptSovitsProcess.kill();
    }
  };
  process.on('SIGINT', () => { cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { cleanup().then(() => process.exit(0)); });
}
