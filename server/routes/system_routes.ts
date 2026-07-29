import { Router } from "express";
import jwt from "jsonwebtoken";
import os from "os";
import fs from "fs";
import path from "path";
import { readDB, writeDB, isDbDirty } from "../../db_layer";
import { logger } from "../../logger";
import { toolRegistry } from "../tools/registry";
import { scheduler } from "../scheduler";
import { classifyCloudError, getCloudHealth, recordFailure, resetCircuit } from "../cloud/core";
import { loadKeys, saveKeys, getKey, getAllKeyNames, isPersistableKeyName } from "../config/keys";
import { requireAuth, requireLocalRequest } from "../middleware/auth";
import { getLatencyStats } from "../monitor/latency_store";
import { mcpManager, getMCPConfig } from "../mcp";
import {
  getUserPreferredVision,
  isVisionProvider,
  upsertUserPreferredVision,
} from "../llm/vision_preferences";
import {
  getUserPreferredGenerationModels,
  isImageGenerationProvider,
  isVideoGenerationProvider,
  upsertUserPreferredGenerationModels,
} from "../llm/generation_preferences";
import {
  getUserPreferredWorldModel,
  getUserWorldModelPrefs,
  isWorldModelProvider,
  upsertUserWorldModelPrefs,
} from "../llm/world_preferences";
import {
  getUserRetrievalModelPreferences,
  upsertUserRetrievalModelPreferences,
} from "../llm/retrieval_model_preferences";
import { getUserPreferredLLM, upsertUserPreferredLLM } from "../llm/user_preferences";
import { getVoicePreference, setVoicePreference, type VoicePreference } from "../config/voice_preference";
import { getActiveSTTProvider, getActiveStreamingSTTProvider } from "../stt/adapter";
import { getActiveProvider as getActiveTTSProvider } from "../tts/adapter";
import { getGptSovitsRuntimeStatus } from "../tts/gptsovits_runtime";
import { getRuntimeQueueStatus as getGptSovitsQueueStatus } from "../tts/providers/gptsovits";
import { getVoiceprintRuntimeStatus } from "../biometrics/voiceprint_provider";
import { getToolRuntimeMetrics } from "../runtime/tool_metrics";
import { getCapabilityRuntimeMetrics } from "../runtime/capability_metrics";
import { getCapabilityRolloutStage } from "../cognition/capability_rollout";
import { getAdapterResilienceSnapshot } from "../tools/adapter_resilience";
import { getLocalModelConfig, refreshLocalModelConfig } from "../llm/local_models";
import { generateConfiguredEmbedding } from "../llm/embedding_provider";
import { rerankConfiguredDocuments } from "../llm/rerank_provider";
import { queryWindowsGpuName } from "../adapters/host_probe";
import { loadRuntimeBuildMetadata } from "../../shared/runtime_build_metadata";
import {
  testLLMProviderConnection,
  testVisionProviderConnection,
  type TestableModelRuntime,
} from "../llm/model_configuration";

export { testLLMProviderConnection, testVisionProviderConnection } from "../llm/model_configuration";

// Cached GPU detection — queried once
let _cachedGPU: { name?: string; util?: number } | null | undefined;
let systemStatsCache: { at: number; value: any } | null = null;
let systemStatsInFlight: Promise<any> | null = null;
const serverStartedAt = new Date().toISOString();

interface ProviderProbeRecord {
  provider: string;
  model: string;
  ok: boolean;
  testedAt: string;
  latencyMs?: number;
  error?: string;
  errorCategory?: string;
}

function providerProbeKey(provider: string): string {
  return `provider_probe_${provider}`;
}

function readProviderProbe(provider: string): ProviderProbeRecord | null {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((item: any) => item.key === providerProbeKey(provider));
    return setting?.value ? JSON.parse(setting.value) : null;
  } catch {
    return null;
  }
}

function saveProviderProbe(probe: ProviderProbeRecord): void {
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const key = providerProbeKey(probe.provider);
    const value = JSON.stringify(probe);
    const setting = db.settings.find((item: any) => item.key === key);
    if (setting) setting.value = value;
    else db.settings.push({ key, value });
    writeDB(db);
  } catch {}
}

const runtimeBuildMetadata = loadRuntimeBuildMetadata();

function sanitizedProviderError(error: unknown): string {
  return String((error as any)?.message || error || 'Connection test failed')
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

export function getRuntimeVersionInfo() {
  return {
    name: runtimeBuildMetadata.name,
    version: runtimeBuildMetadata.version,
    buildId: runtimeBuildMetadata.buildId,
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

async function collectSystemStatsSnapshot() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpuList = os.cpus();
  const snap1 = cpuList.map(cpu => ({ total: sumTimes(cpu.times), idle: cpu.times.idle }));
  await new Promise(resolve => setTimeout(resolve, 200));
  const snap2 = os.cpus().map(cpu => ({ total: sumTimes(cpu.times), idle: cpu.times.idle }));
  const cpuPercent = Math.round(
    snap1.reduce((sum, first, index) => {
      const second = snap2[index];
      if (!second) return sum;
      const totalDelta = second.total - first.total;
      const idleDelta = second.idle - first.idle;
      return totalDelta > 0 ? sum + ((totalDelta - idleDelta) / totalDelta) * 100 : sum;
    }, 0) / Math.max(1, snap1.length),
  );

  if (_cachedGPU === undefined) {
    _cachedGPU = null;
    if (process.platform === 'win32') {
      const output = queryWindowsGpuName();
      if (output) _cachedGPU = { name: output };
    }
  }

  return {
    computerScope: 'lumi_server_host',
    cpu: Math.max(0, Math.min(100, cpuPercent)),
    cpuModel: cpuList[0]?.model?.trim() || '',
    logicalCpus: cpuList.length,
    physicalCpus: null,
    gpu: _cachedGPU,
    ram: {
      used: Math.round(usedMem / 1024 / 1024 / 1024 * 10) / 10,
      total: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: cpuList.length,
    uptime: Math.round(os.uptime()),
  };
}

export async function getSystemStatsSnapshot() {
  if (systemStatsCache && Date.now() - systemStatsCache.at < 1000) return systemStatsCache.value;
  if (!systemStatsInFlight) {
    systemStatsInFlight = collectSystemStatsSnapshot()
      .then(value => {
        systemStatsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => { systemStatsInFlight = null; });
  }
  return systemStatsInFlight;
}

export function mountSystemRoutes(router: Router, jwtSecret: string, io?: any, llm: TestableModelRuntime = {}) {
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
      const memory = process.memoryUsage();
      const toolMetrics = getToolRuntimeMetrics();
      const capabilityMetrics = getCapabilityRuntimeMetrics();
      const ollama = getLocalModelConfig('ollama');
      const lmstudio = getLocalModelConfig('lmstudio');
      res.json({
        status: isDbDirty() ? "degraded" : "ok",
        timestamp: new Date().toISOString(),
        runtime: getRuntimeVersionInfo(),
        database: {
          users: db.users.length,
          agents: db.agents.length,
          interactions: db.interactions.length,
          dirty: isDbDirty(),
          actionTasks: (db.conversationActionTasks || []).length,
          actionReceipts: (db.conversationActionReceipts || []).length,
          functionalProbe: 'read_ok',
        },
        process: {
          uptimeSec: Math.round(process.uptime()),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
        },
        tools: toolMetrics,
        capabilities: {
          ...capabilityMetrics,
          rollout: {
            stage: getCapabilityRolloutStage(),
            rollbackExternalDisabled: /^(?:1|true|yes|on)$/i.test(
              String(process.env.LUMI_CAPABILITY_ROLLBACK_DISABLE_EXTERNAL || ''),
            ),
          },
        },
        adapterResilience: getAdapterResilienceSnapshot(),
        queues: {
          toolCallsInFlight: toolMetrics.totals.inFlight,
          voiceprint: getVoiceprintRuntimeStatus(),
          gptSovits: getGptSovitsQueueStatus(),
        },
        supervisedRuntimes: {
          gptSovits: getGptSovitsRuntimeStatus(),
          voiceprint: getVoiceprintRuntimeStatus(),
        },
        functionalProbes: {
          databaseRead: true,
          registeredTools: toolRegistry.list().length,
          mcp: mcpManager.getServerHealth(),
          localModels: {
            ollama: {
              reachable: ollama.detected,
              baseUrl: ollama.baseUrl,
              modelCount: ollama.models.length,
              lastChecked: ollama.updatedAt,
              error: ollama.lastError || '',
            },
            lmstudio: {
              reachable: lmstudio.detected,
              baseUrl: lmstudio.baseUrl,
              modelCount: lmstudio.models.length,
              lastChecked: lmstudio.updatedAt,
              error: lmstudio.lastError || '',
            },
          },
        },
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

  // Explicit functional probe for local OpenAI-compatible runtimes. This is
  // separate from the cheap cached /health response so monitoring can choose
  // when to incur a network probe.
  router.get("/llm/local/health", requireLocalRequest, async (_req, res) => {
    const current = {
      ollama: getLocalModelConfig('ollama'),
      lmstudio: getLocalModelConfig('lmstudio'),
    };
    const [ollama, lmstudio] = await Promise.all([
      refreshLocalModelConfig('ollama', current.ollama.baseUrl, { timeoutMs: 2500 }),
      refreshLocalModelConfig('lmstudio', current.lmstudio.baseUrl, { timeoutMs: 2500 }),
    ]);
    const status = ollama.detected || lmstudio.detected ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
      status,
      checkedAt: new Date().toISOString(),
      providers: { ollama, lmstudio },
    });
  });

  router.get("/voice/active-provider", requireAuth, (_req, res) => {
    const pref = getVoicePreference();
    res.json({
      pref,
      active: {
        stt: getActiveSTTProvider({ requireHealthy: true }),
        streamingStt: getActiveStreamingSTTProvider({ requireHealthy: true }),
        tts: getActiveTTSProvider({ requireHealthy: true }),
      },
    });
  });

  router.post("/voice/provider", requireAuth, requireLocalRequest, (req, res) => {
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
        stt: getActiveSTTProvider({ requireHealthy: true }),
        streamingStt: getActiveStreamingSTTProvider({ requireHealthy: true }),
        tts: getActiveTTSProvider({ requireHealthy: true }),
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
      const ollamaConfig = getLocalModelConfig('ollama');
      const lmstudioConfig = getLocalModelConfig('lmstudio');
      const status = (provider: string, configured: boolean, model: string) => ({
        available: configured,
        configured,
        model,
        lastProbe: readProviderProbe(provider),
      });
      res.json({
        providers: {
          deepseek: status('deepseek', envOrStore('DEEPSEEK_API_KEY'), process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'),
          gemini: status('gemini', envOrStore('GEMINI_API_KEY'), process.env.GEMINI_MODEL || 'gemini-2.0-flash'),
          openai: status('openai', envOrStore('OPENAI_API_KEY'), process.env.OPENAI_MODEL || 'gpt-4o'),
          anthropic: status('anthropic', envOrStore('ANTHROPIC_API_KEY'), process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'),
          qwen: status('qwen', envOrStore('QWEN_API_KEY') || envOrStore('DASHSCOPE_API_KEY'), process.env.QWEN_MODEL || 'qwen-plus'),
          ark: status('ark', envOrStore('ARK_API_KEY'), process.env.ARK_MODEL || 'doubao-seed-2-0-lite-260215'),
          xiaomi: status('xiaomi', envOrStore('XIAOMI_API_KEY'), process.env.XIAOMI_MODEL || 'mimo-v2.5-pro'),
          kimi: status('kimi', envOrStore('KIMI_API_KEY'), process.env.KIMI_MODEL || 'moonshot-v1-8k'),
          glm: status('glm', envOrStore('GLM_API_KEY'), process.env.GLM_MODEL || 'glm-5.1'),
          relay: status('relay', envOrStore('RELAY_API_KEY') && envOrStore('RELAY_BASE_URL'), process.env.RELAY_MODEL || 'openai-compatible'),
          ollama: status('ollama', ollamaConfig.detected, ollamaConfig.models[0] || 'local'),
          lmstudio: status('lmstudio', lmstudioConfig.detected, lmstudioConfig.models[0] || 'local'),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load provider status' });
    }
  });

  // LLM connection test
  router.post("/llm/test", requireLocalRequest, async (req, res) => {
    const { provider, model } = req.body || {};
    const providerId = String(provider || '');
    const modelId = typeof model === 'string' ? model : undefined;
    try {
      const result = await testLLMProviderConnection(providerId, modelId, llm);
      resetCircuit(result.provider);
      saveProviderProbe({
        provider: result.provider,
        model: result.model,
        ok: true,
        testedAt: new Date().toISOString(),
        latencyMs: result.latencyMs,
      });
      res.json(result);
    } catch (err: any) {
      const message = sanitizedProviderError(err);
      const classified = classifyCloudError(err instanceof Error ? err : new Error(message), providerId);
      if (providerId) {
        recordFailure(providerId, undefined, err instanceof Error ? err : new Error(message), { openImmediately: true });
        saveProviderProbe({
          provider: providerId,
          model: String(modelId || ''),
          ok: false,
          testedAt: new Date().toISOString(),
          error: message,
          errorCategory: classified.category,
        });
      }
      const configurationError = /not configured|not currently reachable|unsupported provider|valid model/i.test(message);
      res.status(configurationError ? 400 : 502).json({ ok: false, provider, model, error: message });
    }
  });

  router.post("/vision/test", requireLocalRequest, async (req, res) => {
    const provider = String(req.body?.provider || '');
    const model = String(req.body?.model || '');
    try {
      res.json(await testVisionProviderConnection(provider, model, llm));
    } catch (err: any) {
      const message = sanitizedProviderError(err);
      const configurationError = /not configured|not currently reachable|unsupported vision provider|valid vision model/i.test(message);
      res.status(configurationError ? 400 : 502).json({ ok: false, provider, model, error: message });
    }
  });

  router.post("/retrieval-model/test", requireLocalRequest, async (req, res) => {
    const uid = getUserIdFromRequest(req, jwtSecret);
    try {
      const startedAt = Date.now();
      const preferences = getUserRetrievalModelPreferences(uid);
      const embeddingStartedAt = Date.now();
      const result = await generateConfiguredEmbedding('Lumi retrieval model connection test', uid);
      let rerank: Record<string, unknown> = { enabled: false };
      if (preferences.rerank.enabled) {
        const rerankStartedAt = Date.now();
        const ranked = await rerankConfiguredDocuments(
          'Which passage describes semantic knowledge retrieval?',
          [
            'Semantic retrieval recalls passages by meaning and context.',
            'A video generation model creates moving images from prompts.',
          ],
          uid,
          2,
        );
        rerank = {
          enabled: true,
          provider: ranked.provider,
          model: ranked.model,
          results: ranked.items.length,
          latencyMs: Date.now() - rerankStartedAt,
        };
      }
      return res.json({
        ok: true,
        provider: result.provider,
        model: result.model,
        dimensions: result.vector.length,
        embedding: {
          provider: result.provider,
          model: result.model,
          dimensions: result.vector.length,
          latencyMs: Date.now() - embeddingStartedAt,
        },
        rerank,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err: any) {
      const message = sanitizedProviderError(err);
      return res.status(502).json({ ok: false, error: message });
    }
  });

  // API Keys — read/write user-configured keys
  // LLM model preferences — read/write per user
  router.put("/preferences/llm", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      const updated = upsertUserPreferredLLM(uid, req.body || {});
      res.json({ success: true, ...updated, scope: 'lumi', organizationOverridesSupported: false });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/preferences/llm", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json({
        ...getUserPreferredLLM(uid),
        scope: 'lumi',
        sharedAcrossPersonalAndOrganizationDomains: true,
        organizationOverridesSupported: false,
      });
    } catch {
      res.json({ provider: '', model: '', models: {}, scope: 'lumi', organizationOverridesSupported: false });
    }
  });

  router.put("/preferences/vision", (req, res) => {
    try {
      if (!isVisionProvider(req.body?.provider)) {
        return res.status(400).json({ error: 'Invalid vision provider' });
      }
      const uid = getUserIdFromRequest(req, jwtSecret);
      const updated = upsertUserPreferredVision(uid, req.body || {});
      res.json({ success: true, ...updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/preferences/vision", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      return res.json(getUserPreferredVision(uid));
    } catch {
      res.json(getUserPreferredVision('anonymous'));
    }
  });

  router.put("/preferences/generation", (req, res) => {
    try {
      const imageProvider = req.body?.image?.provider;
      const videoProvider = req.body?.video?.provider;
      if (!isImageGenerationProvider(imageProvider) || !isVideoGenerationProvider(videoProvider)) {
        return res.status(400).json({ error: 'Invalid generation model provider' });
      }
      const uid = getUserIdFromRequest(req, jwtSecret);
      const prefs = upsertUserPreferredGenerationModels(uid, req.body);
      res.json({ success: true, ...prefs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/preferences/generation", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json(getUserPreferredGenerationModels(uid));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/preferences/world", (req, res) => {
    try {
      if (!isWorldModelProvider(req.body?.provider)) {
        return res.status(400).json({ error: 'Invalid world model provider' });
      }
      const uid = getUserIdFromRequest(req, jwtSecret);
      const prefs = upsertUserWorldModelPrefs(uid, req.body);
      res.json({ success: true, ...prefs, resolved: getUserPreferredWorldModel(uid) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/preferences/world", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json({ ...getUserWorldModelPrefs(uid), resolved: getUserPreferredWorldModel(uid) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/preferences/retrieval-model", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json(upsertUserRetrievalModelPreferences(uid, req.body));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/preferences/retrieval-model", (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json(getUserRetrievalModelPreferences(uid));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      res.json(await getSystemStatsSnapshot());
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
    res.json(getLocalModelConfig('ollama'));
  });

  // PUT: save Ollama URL and trigger re-detection
  router.put("/ollama/config", requireLocalRequest, async (req, res) => {
    try {
      const { baseUrl } = req.body || {};
      const result = await refreshLocalModelConfig('ollama', baseUrl, { timeoutMs: 5000 });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: sanitizedProviderError(err) });
    }
  });

  // ── LM Studio local model config ──
  // GET: return saved LM Studio URL + detection status
  router.get("/lmstudio/config", (_req, res) => {
    res.json(getLocalModelConfig('lmstudio'));
  });

  // PUT: save LM Studio URL and trigger re-detection
  router.put("/lmstudio/config", requireLocalRequest, async (req, res) => {
    try {
      const { baseUrl } = req.body || {};
      const result = await refreshLocalModelConfig('lmstudio', baseUrl, { timeoutMs: 5000 });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: sanitizedProviderError(err) });
    }
  });
}
