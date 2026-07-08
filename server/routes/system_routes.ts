import { Router } from "express";
import jwt from "jsonwebtoken";
import os from "os";
import fs from "fs";
import path from "path";
import { readDB, writeDB, isDbDirty } from "../../db_layer";
import { logger } from "../../logger";
import { toolRegistry } from "../tools/registry";
import { scheduler } from "../scheduler";
import { getCloudHealth } from "../cloud/core";
import { loadKeys, saveKeys, getKey, getAllKeyNames, isPersistableKeyName } from "../config/keys";
import { requireAuth, requireOrgMember, requireOrgRole } from "../middleware/auth";
import { getLatencyStats } from "../monitor/latency_store";
import { mcpManager, getMCPConfig } from "../mcp";
import { DEFAULT_VISION_MODELS } from "../llm/vision_preferences";
import { getOrgPreferredLLM, getUserPreferredLLM, upsertOrgPreferredLLM } from "../llm/user_preferences";
import { getVoicePreference, setVoicePreference, type VoicePreference } from "../config/voice_preference";
import { getActiveSTTProvider } from "../stt/adapter";
import { getActiveProvider as getActiveTTSProvider } from "../tts/adapter";

// Cached GPU detection — queried once
let _cachedGPU: { name?: string; util?: number } | null | undefined;
const serverStartedAt = new Date().toISOString();

function readPackageMeta(): { name?: string; version?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
  } catch {
    return {};
  }
}

const packageMeta = readPackageMeta();

function getRuntimeVersionInfo() {
  return {
    name: packageMeta.name || "lumiOS",
    version: process.env.LUMI_VERSION || packageMeta.version || "0.0.0",
    buildId: process.env.LUMI_BUILD_ID || process.env.GIT_COMMIT || null,
    pid: process.pid,
    startedAt: serverStartedAt,
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
  };
}

function tailLogFile(filePath: string, maxLines: number): string[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function collectRuntimeLogSources() {
  const cwd = process.cwd();
  const candidates: string[] = [];
  const addFile = (filePath: string) => {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) candidates.push(filePath);
  };
  const addMatchingFiles = (dir: string, pattern: RegExp) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) addFile(path.join(dir, entry.name));
    }
  };

  addMatchingFiles(path.join(cwd, ".codex-run"), /^lumi-tauri-.*\.(out|err)\.log$/);
  addMatchingFiles(path.join(cwd, "logs"), /\.log$/i);
  addFile(path.join(cwd, "server_output.log"));
  addFile(path.join(cwd, "server_startup.log"));

  return [...new Set(candidates)]
    .map(filePath => {
      const stat = fs.statSync(filePath);
      return {
        id: path.relative(cwd, filePath).replace(/\\/g, "/"),
        path: path.relative(cwd, filePath).replace(/\\/g, "/"),
        name: path.basename(filePath),
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size,
        filePath,
      };
    })
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
    .slice(0, 8);
}

function getUserIdFromRequest(req: any, jwtSecret: string): string {
  let uid = 'anonymous';
  const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (token) {
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      uid = decoded.uid || 'anonymous';
    } catch {}
  }
  return uid;
}

function sumTimes(times: Record<string, number>): number {
  return (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
}

export function mountSystemRoutes(router: Router, jwtSecret: string, io?: any) {
  router.get("/version", (_req, res) => {
    res.json(getRuntimeVersionInfo());
  });

  router.get("/runtime/logs", requireAuth, (req, res) => {
    const maxLines = Math.min(Math.max(Number(req.query.lines) || 240, 40), 600);
    const sources = collectRuntimeLogSources().map(source => ({
      id: source.id,
      path: source.path,
      name: source.name,
      modifiedAt: source.modifiedAt,
      size: source.size,
      lines: tailLogFile(source.filePath, maxLines),
    }));
    res.json({
      runtime: getRuntimeVersionInfo(),
      generatedAt: new Date().toISOString(),
      sources,
    });
  });

  // Health Check
  router.get("/health", (req, res) => {
    try {
      const db = readDB();
      res.json({
        status: isDbDirty() ? "degraded" : "ok",
        timestamp: new Date().toISOString(),
        runtime: getRuntimeVersionInfo(),
        database: {
          users: db.users.length,
          agents: db.agents.length,
          interactions: db.interactions.length,
          dirty: isDbDirty(),
        }
      });
    } catch (error: any) {
      logger.error("Health check failed", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Cloud provider health — circuit breaker + fallback status
  router.get("/cloud/health", (_req, res) => {
    try { res.json(getCloudHealth()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get("/voice/active-provider", (_req, res) => {
    const pref = getVoicePreference();
    res.json({
      pref,
      active: {
        stt: getActiveSTTProvider(),
        tts: getActiveTTSProvider(),
      },
    });
  });

  router.post("/voice/provider", (req, res) => {
    const { stt, tts } = req.body || {};
    const allowedStt = new Set<VoicePreference['stt']>(['auto', 'local-whisper', 'qwen', 'ark', 'whisper']);
    const allowedTts = new Set<VoicePreference['tts']>(['auto', 'local-cosyvoice', 'gptsovits', 'cosyvoice', 'ark']);
    const next: Partial<VoicePreference> = {};

    if (stt !== undefined) {
      if (!allowedStt.has(stt)) return res.status(400).json({ error: 'Invalid STT provider' });
      next.stt = stt;
    }
    if (tts !== undefined) {
      if (!allowedTts.has(tts)) return res.status(400).json({ error: 'Invalid TTS provider' });
      next.tts = tts;
    }

    const pref = setVoicePreference(next);
    res.json({
      success: true,
      pref,
      active: {
        stt: getActiveSTTProvider(),
        tts: getActiveTTSProvider(),
      },
    });
  });

  // Tool list for security config
  router.get("/tools", (_req, res) => {
    const tools = toolRegistry.list().map(t => ({
      name: t.name,
      description: t.description.slice(0, 80),
      permission: t.permission,
      securityLevel: t.securityLevel,
    }));
    res.json(tools);
  });

  router.get("/scheduler/tasks", requireAuth, (_req, res) => {
    res.json({ tasks: scheduler.listTasks() });
  });

  router.post("/scheduler/tasks/:id/toggle", requireAuth, (req, res) => {
    const { id } = req.params;
    const result = scheduler.toggleTask(id);
    if (!result.found) {
      return res.status(404).json({ error: `Task "${id}" not found` });
    }
    res.json({ id, enabled: result.enabled });
  });

  // Token usage aggregation
  router.get("/llm/usage", (req, res) => {
    let token = req.cookies.token;
    // Fallback: WebView2 may not send httpOnly cookies, check Authorization header
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7);
    }
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const days = parseInt(req.query.days as string) || 30;
      const providerFilter = req.query.provider as string | undefined;
      const db = readDB();
      const allUsage: any[] = db.tokenUsage || [];
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const filtered = allUsage.filter((u: any) =>
        (u.userId === decoded.uid || u.userId === 'anonymous') &&
        u.timestamp >= cutoff &&
        (!providerFilter || u.provider === providerFilter)
      );

      // Per-provider totals
      const byProvider: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number; calls: number }> = {};
      const dailyMap: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number }> = {};

      for (const u of filtered) {
        if (!byProvider[u.provider]) {
          byProvider[u.provider] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
        }
        byProvider[u.provider].promptTokens += u.promptTokens || 0;
        byProvider[u.provider].completionTokens += u.completionTokens || 0;
        byProvider[u.provider].totalTokens += u.totalTokens || 0;
        byProvider[u.provider].calls += 1;

        const day = u.timestamp.slice(0, 10);
        if (!dailyMap[day]) {
          dailyMap[day] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        }
        dailyMap[day].promptTokens += u.promptTokens || 0;
        dailyMap[day].completionTokens += u.completionTokens || 0;
        dailyMap[day].totalTokens += u.totalTokens || 0;
      }

      const daily = Object.entries(dailyMap)
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const grandTotal = filtered.reduce((sum: number, u: any) => sum + (u.totalTokens || 0), 0);

      res.json({ byProvider, daily, grandTotal, days, recordCount: filtered.length });
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // Provider status
  router.get("/llm/providers", (_req, res) => {
    try {
      const stored = loadKeys();
      const envOrStore = (envKey: string, storeKey: string = envKey) =>
        !!(process.env[envKey] && process.env[envKey]!.length > 0) || !!stored[storeKey];
      // Check local model configs
      let ollamaAvailable = false;
      let lmstudioAvailable = false;
      try {
        const db = readDB();
        const os = (db.settings || []).find((s: any) => s.key === 'ollama_config');
        if (os) ollamaAvailable = !!JSON.parse(os.value).detected;
        const ls = (db.settings || []).find((s: any) => s.key === 'lmstudio_config');
        if (ls) lmstudioAvailable = !!JSON.parse(ls.value).detected;
      } catch {}
      res.json({
        providers: {
          deepseek: { available: envOrStore('DEEPSEEK_API_KEY'), model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' },
          gemini: { available: envOrStore('GEMINI_API_KEY'), model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' },
          openai: { available: envOrStore('OPENAI_API_KEY'), model: process.env.OPENAI_MODEL || 'gpt-4o' },
          anthropic: { available: envOrStore('ANTHROPIC_API_KEY'), model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' },
          qwen: { available: envOrStore('QWEN_API_KEY') || envOrStore('DASHSCOPE_API_KEY'), model: process.env.QWEN_MODEL || 'qwen-plus' },
          ark: { available: envOrStore('ARK_API_KEY'), model: process.env.ARK_MODEL || 'doubao-1-5-pro-32k' },
          xiaomi: { available: envOrStore('XIAOMI_API_KEY'), model: process.env.XIAOMI_MODEL || 'xiaomi-chat' },
          kimi: { available: envOrStore('KIMI_API_KEY'), model: process.env.KIMI_MODEL || 'moonshot-v1-8k' },
          glm: { available: envOrStore('GLM_API_KEY'), model: process.env.GLM_MODEL || 'glm-4-plus' },
          relay: { available: envOrStore('RELAY_API_KEY') && envOrStore('RELAY_BASE_URL'), model: process.env.RELAY_MODEL || 'openai-compatible' },
          ollama: { available: ollamaAvailable, model: 'local' },
          lmstudio: { available: lmstudioAvailable, model: 'local' },
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load provider status' });
    }
  });

  // LLM connection test
  router.post("/llm/test", async (req, res) => {
    const { provider, apiKey } = req.body || {};
    try {
      const stored = loadKeys();
      const keyMap: Record<string, string | undefined> = {
        deepseek: apiKey || process.env.DEEPSEEK_API_KEY || stored.DEEPSEEK_API_KEY,
        gemini: apiKey || process.env.GEMINI_API_KEY || stored.GEMINI_API_KEY,
        openai: apiKey || process.env.OPENAI_API_KEY || stored.OPENAI_API_KEY,
        anthropic: apiKey || process.env.ANTHROPIC_API_KEY || stored.ANTHROPIC_API_KEY,
        qwen: apiKey || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || stored.QWEN_API_KEY || stored.DASHSCOPE_API_KEY,
        ark: apiKey || process.env.ARK_API_KEY || stored.ARK_API_KEY,
        xiaomi: apiKey || process.env.XIAOMI_API_KEY || stored.XIAOMI_API_KEY,
        kimi: apiKey || process.env.KIMI_API_KEY || stored.KIMI_API_KEY,
        glm: apiKey || process.env.GLM_API_KEY || stored.GLM_API_KEY,
      };
      const key = keyMap[provider];
      if (!key) {
        return res.status(400).json({ error: `No API key configured for ${provider}. Add it in Settings → API Matrix or Voice Services.` });
      }
      res.json({ ok: true, provider, message: 'API key configured' });
    } catch (err: any) {
      res.status(500).json({ error: err.message?.slice(0, 200) || 'Connection check failed' });
    }
  });

  // API Keys — read/write user-configured keys
  // LLM model preferences — read/write per user
  router.put("/preferences/llm", (req, res) => {
    try {
      const { provider, models } = req.body || {};
      if (!provider || !models || typeof models !== 'object') {
        return res.status(400).json({ error: 'Invalid payload' });
      }
      // Extract user ID from JWT cookie or header
      let uid = 'anonymous';
      const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
      if (token) {
        try {
          const decoded: any = jwt.verify(token, jwtSecret);
          uid = decoded.uid || 'anonymous';
        } catch {}
      }
      const db = readDB();
      const key = `llm_prefs_${uid}`;
      const payload = { provider, models, updatedAt: new Date().toISOString() };
      const existing = (db.settings || []).findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        (db.settings as any[])[existing].value = JSON.stringify(payload);
      } else {
        if (!db.settings) (db as any).settings = [];
        db.settings.push({ key, value: JSON.stringify(payload) });
      }
      writeDB(db);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/preferences/llm", (req, res) => {
    try {
      let uid = 'anonymous';
      const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
      if (token) {
        try {
          const decoded: any = jwt.verify(token, jwtSecret);
          uid = decoded.uid || 'anonymous';
        } catch {}
      }
      const key = `llm_prefs_${uid}`;
      const db = readDB();
      const row = (db.settings || []).find((s: any) => s.key === key);
      res.json(row ? JSON.parse(row.value) : { provider: '', models: {} });
    } catch {
      res.json({ provider: '', models: {} });
    }
  });

  router.get("/preferences/org-llm", requireAuth, requireOrgMember, (req, res) => {
    try {
      const orgId = req.user!.orgId!;
      const orgPrefs = getOrgPreferredLLM(orgId);
      if (orgPrefs?.configured) {
        return res.json({
          inheritPersonal: false,
          configured: true,
          provider: orgPrefs.provider,
          model: orgPrefs.model,
          models: orgPrefs.models,
          source: 'organization',
        });
      }
      const personal = getUserPreferredLLM(req.user!.uid);
      res.json({
        inheritPersonal: true,
        configured: false,
        provider: personal.provider,
        model: personal.model,
        models: {},
        inheritedProvider: personal.provider,
        inheritedModel: personal.model,
        source: 'personal',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/preferences/org-llm", requireAuth, requireOrgRole('owner', 'admin'), (req, res) => {
    try {
      const { inheritPersonal, provider, models } = req.body || {};
      const updated = upsertOrgPreferredLLM(req.user!.orgId!, {
        inheritPersonal: inheritPersonal === true,
        provider,
        models,
      });
      if (!updated.configured) {
        const personal = getUserPreferredLLM(req.user!.uid);
        return res.json({
          success: true,
          inheritPersonal: true,
          configured: false,
          provider: personal.provider,
          model: personal.model,
          models: {},
          inheritedProvider: personal.provider,
          inheritedModel: personal.model,
          source: 'personal',
        });
      }
      res.json({
        success: true,
        inheritPersonal: false,
        configured: updated.configured,
        provider: updated.provider,
        model: updated.model,
        models: updated.models,
        source: 'organization',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/preferences/vision", (req, res) => {
    try {
      const { provider, model, models } = req.body || {};
      const allowed = new Set(Object.keys(DEFAULT_VISION_MODELS));
      if (!provider || !allowed.has(provider)) {
        return res.status(400).json({ error: 'Invalid vision provider' });
      }
      const uid = getUserIdFromRequest(req, jwtSecret);
      const normalizedModels = models && typeof models === 'object' ? models : {};
      const payload = {
        provider,
        model: model || normalizedModels[provider] || (DEFAULT_VISION_MODELS as Record<string, string>)[provider],
        models: {
          ...normalizedModels,
          [provider]: model || normalizedModels[provider] || (DEFAULT_VISION_MODELS as Record<string, string>)[provider],
        },
        updatedAt: new Date().toISOString(),
      };
      const db = readDB();
      const key = `vision_prefs_${uid}`;
      if (!db.settings) (db as any).settings = [];
      const idx = (db.settings || []).findIndex((s: any) => s.key === key);
      if (idx >= 0) {
        (db.settings as any[])[idx].value = JSON.stringify(payload);
      } else {
        db.settings.push({ key, value: JSON.stringify(payload) });
      }
      writeDB(db);
      res.json({ success: true, ...payload });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/preferences/vision", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      const key = `vision_prefs_${uid}`;
      const db = readDB();
      const row = (db.settings || []).find((s: any) => s.key === key);
      if (row?.value) return res.json(JSON.parse(row.value));
      return res.json({ provider: 'openai', model: DEFAULT_VISION_MODELS.openai, models: {} });
    } catch {
      res.json({ provider: 'openai', model: DEFAULT_VISION_MODELS.openai, models: {} });
    }
  });

  router.get("/settings/keys", (_req, res) => {
    try {
      const stored = loadKeys();
      const masked: Record<string, boolean> = {};
      for (const name of getAllKeyNames()) {
        masked[name] = !!(process.env[name] || stored[name]);
      }
      res.json(masked);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load key status' });
    }
  });

  router.post("/settings/keys", (req, res) => {
    try {
      const { keys } = req.body || {};
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
        return res.status(400).json({ error: 'Invalid keys payload' });
      }
      const toSave: Record<string, string> = {};
      const toDelete: string[] = [];
      const ignored: string[] = [];
      for (const [k, v] of Object.entries(keys)) {
        if (!isPersistableKeyName(k) || typeof v !== 'string') {
          ignored.push(k);
          continue;
        }
        if (v.trim().length > 0) {
          toSave[k] = v.trim();
        } else {
          toDelete.push(k);
        }
      }
      if (ignored.length > 0 && Object.keys(toSave).length === 0 && toDelete.length === 0) {
        return res.status(400).json({
          error: `Unsupported key name(s): ${ignored.join(', ')}`,
          ignored,
        });
      }
      // For explicit deletes, pass empty strings to saveKeys so they get removed
      for (const k of toDelete) {
        toSave[k] = '';
      }
      saveKeys(toSave);
      res.json({
        success: true,
        saved: Object.keys(toSave).filter(k => !toDelete.includes(k)),
        deleted: toDelete,
        ignored,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save key settings' });
    }
  });

  // Generic settings store — for tool overrides, security prefs, etc.
  router.post("/settings", requireAuth, (req, res) => {
    try {
      const { key, value } = req.body || {};
      if (!key || typeof key !== 'string' || value === undefined) {
        return res.status(400).json({ error: 'key and value required' });
      }
      const db = readDB();
      if (!db.settings) db.settings = [];
      const idx = db.settings.findIndex((s: any) => s.key === key);
      if (idx >= 0) {
        db.settings[idx].value = JSON.stringify(value);
      } else {
        db.settings.push({ key, value: JSON.stringify(value) });
      }
      writeDB(db);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/settings/:key", requireAuth, (req, res) => {
    try {
      const db = readDB();
      const row = (db.settings || []).find((s: any) => s.key === req.params.key);
      res.json(row ? JSON.parse(row.value) : null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System stats — real-time CPU / memory / platform info
  router.get("/system/stats", async (_req: any, res: any) => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPercent = Math.round((usedMem / totalMem) * 100);

      // CPU: delta between two snapshots for real-time usage (like Task Manager)
      const snap1 = os.cpus().map(c => ({ total: sumTimes(c.times), idle: c.times.idle }));
      await new Promise(r => setTimeout(r, 200));
      const snap2 = os.cpus().map(c => ({ total: sumTimes(c.times), idle: c.times.idle }));
      const cpuPercent = Math.round(
        snap1.reduce((sum, s1, i) => {
          const s2 = snap2[i];
          const totalDelta = s2.total - s1.total;
          const idleDelta = s2.idle - s1.idle;
          if (totalDelta <= 0) return sum;
          return sum + ((totalDelta - idleDelta) / totalDelta) * 100;
        }, 0) / snap1.length
      );

      // GPU: detect once, cache forever
      if (_cachedGPU === undefined) {
        _cachedGPU = null;
        if (process.platform === 'win32') {
          try {
            const { execSync } = await import('child_process');
            const psCmd = `Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Idd|Indirect|Mirror|Virtual' } | Select-Object -First 1 -ExpandProperty Name`;
            const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 5000, encoding: 'utf-8' });
            const trimmed = out.trim();
            if (trimmed) _cachedGPU = { name: trimmed };
          } catch {}
        }
      }

      res.json({
        cpu: cpuPercent,
        gpu: _cachedGPU,
        ram: { used: Math.round(usedMem / 1024 / 1024 / 1024 * 10) / 10, total: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10, percent: memPercent },
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpus: os.cpus().length,
        uptime: Math.round(os.uptime()),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // Latency stats
  router.get("/monitor/latency", (_req: any, res: any) => {
    res.json(getLatencyStats());
  });

  // Ecosystem stats
  router.get("/ecosystem/stats", (_req: any, res: any) => {
    try {
      const db = readDB();
      const mcpCfg = getMCPConfig();
      const allServers = Object.entries(mcpCfg);
      const enabledServers = allServers.filter(([, c]) => c.enabled);
      const connectedServers = mcpManager.getConnectedServers();
      const allUsage: any[] = db.tokenUsage || [];
      let tokenTotal = 0, dailyTokens = 0;
      for (const u of allUsage) { tokenTotal += u.totalTokens || 0; dailyTokens += u.totalTokens || 0; }
      res.json({
        skillCount: allServers.length, enabledSkillCount: enabledServers.length,
        connectedSkillCount: connectedServers.length, toolCount: toolRegistry.list().length,
        agentCount: (db.agents || []).length, interactionCount: (db.interactions || []).length,
        conversationCount: (db.conversations || []).length,
        deviceCount: io ? io.engine.clientsCount : 0,
        ramTotal: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
        tokenTotal, dailyTokens,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get("/modules/products", (_req, res) => {
    res.json([
      { id: 1, category: "核心设备", name: "全息显示载体", icon: "Hologram", price: "¥8999", description: "核心设备：打破屏幕限制，将 AI 实体化为三维全息影像。", specs: ["4K 全息投影", "实时神经合成", "手势交互"] },
      { id: 2, category: "核心设备", name: "智能桌面台灯", icon: "Lamp", price: "¥1299", description: "多模态交互：集成视觉传感器，根据环境与心情自动调节光谱。", specs: ["视觉追踪", "环境感知", "无级调光"] },
      { id: 14, category: "核心设备", name: "Order 协调主机", icon: "Cpu", price: "¥5999", description: "Lumi 自研独立主机品牌", specs: ["L1 神经处理器", "200T AI 算力", "私有化部署"] },
      { id: 4, category: "智能穿戴", name: "隐私保护眼镜", icon: "Glasses", price: "¥2499", description: "AR 增强现实，硬件级隐私遮蔽。", specs: ["AR 导航", "隐私滤镜", "超轻量"] },
      { id: 5, category: "智能穿戴", name: "生理健康戒指", icon: "Ring", price: "¥1599", description: "全天候监测血氧、心率与压力。", specs: ["钛合金", "7天续航", "医疗级传感器"] },
      { id: 10, category: "AI 陪伴", name: "AI 毛绒伴侣", icon: "Rabbit", price: "¥499", description: "内置 Lumi 神经核心的睡前伴侣。", specs: ["深度语义理解", "多语言陪练", "情绪监控"] },
      { id: 3, category: "AI 陪伴", name: "桌面手机机器人", icon: "Base", price: "¥899", description: "让手机进化为物理载体。", specs: ["无线快充", "多模态拟人", "全向追踪"] },
    ]);
  });

  router.get("/modules/docs", (_req, res) => {
    res.json({
      title: "文档中心", sections: [
        { id: 2, title: "API 参考", content: "完整的 RESTful API，支持多种 AI 模型。所有请求通过本地加密隧道传输。" },
        { id: 3, title: "最佳实践", content: "在提示词中包含具体上下文，LumiAI 自动结合本地知识库进行检索增强。" },
        { id: 4, title: "分布式协议", content: "去中心化节点架构，桌面端作为算力中心，移动端作为感知终端。" },
        { id: 5, title: "数据共享协议", content: "严格本地优先数据共享协议，只有明确授权时才与对等节点共享。" }
      ]
    });
  });

  // ── Ollama local model config ──
  // GET: return saved Ollama URL + detection status
  router.get("/ollama/config", (_req, res) => {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'ollama_config');
      const config = setting ? JSON.parse(setting.value) : {};
      res.json({
        baseUrl: config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        detected: !!config.detected,
        models: config.models || [],
      });
    } catch { res.json({ baseUrl: 'http://localhost:11434', detected: false, models: [] }); }
  });

  // PUT: save Ollama URL and trigger re-detection
  router.put("/ollama/config", async (req, res) => {
    try {
      const { baseUrl } = req.body || {};
      const url = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');

      // Try detecting models at the new URL
      let detected = false;
      let models: string[] = [];
      try {
        const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as any;
          models = (data.models || []).map((m: any) => m.name);
          detected = models.length > 0;
        }
      } catch { /* detection failed */ }

      const payload = { baseUrl: url, detected, models, updatedAt: new Date().toISOString() };
      const db = readDB();
      const key = 'ollama_config';
      const existing = (db.settings || []).findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = JSON.stringify(payload);
      } else {
        if (!db.settings) (db as any).settings = [];
        db.settings.push({ key, value: JSON.stringify(payload) });
      }
      writeDB(db);

      res.json({ baseUrl: url, detected, models });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── LM Studio local model config ──
  // GET: return saved LM Studio URL + detection status
  router.get("/lmstudio/config", (_req, res) => {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'lmstudio_config');
      const config = setting ? JSON.parse(setting.value) : {};
      res.json({
        baseUrl: config.baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234',
        detected: !!config.detected,
        models: config.models || [],
      });
    } catch { res.json({ baseUrl: 'http://localhost:1234', detected: false, models: [] }); }
  });

  // PUT: save LM Studio URL and trigger re-detection
  router.put("/lmstudio/config", async (req, res) => {
    try {
      const { baseUrl } = req.body || {};
      const url = (baseUrl || 'http://localhost:1234').replace(/\/+$/, '');

      let detected = false;
      let models: string[] = [];
      try {
        const resp = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as any;
          models = (data.data || []).map((m: any) => m.id);
          detected = models.length > 0;
        }
      } catch { /* detection failed */ }

      const payload = { baseUrl: url, detected, models, updatedAt: new Date().toISOString() };
      const db = readDB();
      const key = 'lmstudio_config';
      const existing = (db.settings || []).findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = JSON.stringify(payload);
      } else {
        if (!db.settings) (db as any).settings = [];
        db.settings.push({ key, value: JSON.stringify(payload) });
      }
      writeDB(db);

      res.json({ baseUrl: url, detected, models });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
