import { Router } from "express";
import jwt from "jsonwebtoken";
import os from "os";
import fs from "fs";
import path from "path";
import { getDatabasePersistenceStatus, readDB, writeDB, isDbDirty } from "../../db_layer";
import { logger } from "../../logger";
import { getDataRoot } from "../config/data_path";
import { toolRegistry } from "../tools/registry";
import { scheduler } from "../scheduler";
import { classifyCloudError, getCloudHealth, recordFailure, resetCircuit } from "../cloud/core";
import { loadKeys, saveKeys, getKey, getAllKeyNames, isPersistableKeyName } from "../config/keys";
import { parseDoubaoSpeechCredentials } from "../config/doubao_speech";
import { optionalAuth, requireAdmin, requireAuth, requireLocalRequest, resolveDomain } from "../middleware/auth";
import { isLoopbackAddress } from "../config/local_identity";
import { getLatencyStats } from "../monitor/latency_store";
import { getVoiceLatencyStats } from "../monitor/voice_latency_store";
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
import { listModelRoutingReceipts } from "../llm/model_routing_receipts";
import {
  assessProviderAvailability,
  saveProviderProbe,
} from "../llm/provider_health";
import { getVoicePreference, setVoicePreference, type VoicePreference } from "../config/voice_preference";
import { getActiveSTTProvider, getActiveStreamingSTTProvider } from "../stt/adapter";
import { getActiveProvider as getActiveTTSProvider } from "../tts/adapter";
import { probeDoubaoStreamingConnection } from "../stt/providers/ark_stream";
import {
  getConfiguredDoubaoTtsDetails,
  synthesizeSpeech as synthesizeDoubaoSpeech,
} from "../tts/providers/ark";
import { getGptSovitsRuntimeStatus } from "../tts/gptsovits_runtime";
import { getRuntimeQueueStatus as getGptSovitsQueueStatus } from "../tts/providers/gptsovits";
import { getVoiceprintRuntimeStatus } from "../biometrics/voiceprint_provider";
import { getToolRuntimeMetrics } from "../runtime/tool_metrics";
import { getCapabilityRuntimeMetrics } from "../runtime/capability_metrics";
import { getUnifiedRuntimeSupervisorStatus } from "../runtime/unified_supervisor";
import { readOnlyContextCache } from "../context/read_only_cache";
import { getCapabilityRolloutStage } from "../cognition/capability_rollout";
import { getAdapterResilienceSnapshot } from "../tools/adapter_resilience";
import { getLocalModelConfig, getLocalModelQueueSnapshot, refreshLocalModelConfig } from "../llm/local_models";
import { generateConfiguredEmbedding } from "../llm/embedding_provider";
import { rerankConfiguredDocuments } from "../llm/rerank_provider";
import { queryWindowsGpuName } from "../adapters/host_probe";
import { loadRuntimeBuildMetadata } from "../../shared/runtime_build_metadata";
import {
  applyLumiOfficialModelConfiguration,
  isLumiOfficialApiConfigured,
  testLLMProviderConnection,
  testLumiModelFailoverConfiguration,
  testLumiModelConfiguration,
  testVisionProviderConnection,
  type TestableModelRuntime,
} from "../llm/model_configuration";
import { getDesktopControlRuntimeSnapshot } from "../desktop/control_lease";
import { listRegisteredProviders } from '../extensions/registry';
import { buildStructuredRuntimeStatus } from '../monitor/runtime_status';
import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';
import { relayConfigured } from '../relay/config';
import {
  buildAcceptanceEvidenceSnapshot,
  buildPublicAcceptanceSummary,
} from '../cognition/acceptance_evidence';

export { testLLMProviderConnection, testVisionProviderConnection } from "../llm/model_configuration";

// Cached GPU detection — queried once
let _cachedGPU: { name?: string; util?: number } | null | undefined;
let systemStatsCache: { at: number; value: any } | null = null;
let systemStatsInFlight: Promise<any> | null = null;
const serverStartedAt = new Date().toISOString();

const runtimeBuildMetadata = loadRuntimeBuildMetadata();

function sanitizedProviderError(error: unknown): string {
  return String((error as any)?.message || error || 'Connection test failed')
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

function publicModelRoutingFailure(error: unknown): Record<string, unknown> | null {
  const routing = (error as any)?.routing;
  if (!routing || !Array.isArray(routing.attempts)) return null;
  return {
    error: 'No configured model route is currently available.',
    requestedProvider: String(routing.requestedProvider || ''),
    requestedModel: String(routing.requestedModel || ''),
    selectionMode: String(routing.selectionMode || ''),
    fallbackReason: String(routing.fallbackReason || ''),
    attempts: routing.attempts.slice(0, 12).map((attempt: any) => ({
      provider: String(attempt?.provider || ''),
      model: String(attempt?.model || ''),
      status: String(attempt?.status || ''),
      reason: String(attempt?.reason || ''),
      errorCategory: String(attempt?.errorCategory || ''),
      durationMs: Math.max(0, Math.trunc(Number(attempt?.durationMs) || 0)),
    })),
  };
}

const PROTECTED_ENDPOINT_KEY_RE = /(?:_BASE_URL|_MCP_URL|_WEBHOOK_URL)$/;
const USER_SCOPED_SETTING_KEYS = new Set(['tool_overrides']);

function scopedUserSettingKey(userId: string, key: string): string {
  return `user_setting:${String(userId || '').trim()}:${key}`;
}

function normalizeUserSetting(key: string, value: unknown): unknown {
  if (key !== 'tool_overrides' || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Unsupported or invalid user setting.');
  }
  const normalized: Record<string, { enabled: boolean; securityLevel?: 'safe' | 'confirm' }> = {};
  for (const [toolName, raw] of Object.entries(value as Record<string, any>).slice(0, 500)) {
    const name = String(toolName || '').trim().slice(0, 180);
    if (!name || !raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.enabled !== 'boolean') continue;
    const securityLevel = raw.securityLevel === 'safe' || raw.securityLevel === 'confirm'
      ? raw.securityLevel
      : undefined;
    normalized[name] = { enabled: raw.enabled, ...(securityLevel ? { securityLevel } : {}) };
  }
  return normalized;
}

function validateProtectedEndpointSetting(name: string, value: string): string | null {
  if (!PROTECTED_ENDPOINT_KEY_RE.test(name) || !value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${name} must be a valid absolute HTTP(S) URL.`;
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return `${name} must not contain embedded credentials or a URL fragment.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `${name} must use HTTPS, or HTTP for a loopback service.`;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    return `${name} must use HTTPS unless it targets a loopback service.`;
  }
  return null;
}

export function getRuntimeVersionInfo() {
  return {
    name: runtimeBuildMetadata.name,
    version: runtimeBuildMetadata.version,
    buildId: runtimeBuildMetadata.buildId,
    sourceFingerprint: runtimeBuildMetadata.sourceFingerprint,
    sourceDirty: runtimeBuildMetadata.sourceDirty,
    pid: process.pid,
    startedAt: serverStartedAt,
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
  };
}

const MAX_RUNTIME_LOG_TAIL_BYTES = 512 * 1024;

/** Read only a bounded suffix so a large diagnostic file cannot block the API. */
export async function tailLogFile(
  filePath: string,
  maxLines: number,
  maxBytes = MAX_RUNTIME_LOG_TAIL_BYTES,
): Promise<string[]> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const boundedLines = Math.min(Math.max(Math.trunc(Number(maxLines)) || 1, 1), 600);
    const boundedBytes = Math.min(
      Math.max(Math.trunc(Number(maxBytes)) || MAX_RUNTIME_LOG_TAIL_BYTES, 1),
      MAX_RUNTIME_LOG_TAIL_BYTES,
    );
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, boundedBytes);
    if (bytesToRead <= 0) return [];
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstCompleteLine = raw.indexOf('\n');
      raw = firstCompleteLine >= 0 ? raw.slice(firstCompleteLine + 1) : '';
    }
    return raw.split(/\r?\n/).filter(Boolean).slice(-boundedLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
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
  addMatchingFiles(path.join(getDataRoot(), "runtime"), /^server-\d{8}(?:-\d{3})?\.log$/i);
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

  router.get("/runtime/logs", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const maxLines = Math.min(Math.max(Number(req.query.lines) || 240, 40), 600);
      const sources = await Promise.all(collectRuntimeLogSources().map(async source => ({
        id: source.id,
        path: source.path,
        name: source.name,
        modifiedAt: source.modifiedAt,
        size: source.size,
        lines: await tailLogFile(source.filePath, maxLines),
      })));
      res.json({
        runtime: getRuntimeVersionInfo(),
        generatedAt: new Date().toISOString(),
        sources,
      });
    } catch {
      res.status(500).json({ error: 'Runtime diagnostics are temporarily unavailable' });
    }
  });

  // Health Check
  router.get("/health", optionalAuth, (req, res) => {
    try {
      const persistence = getDatabasePersistenceStatus();
      const detailed = /^(?:1|true|yes)$/i.test(String(req.query.details || ''));
      if (!detailed) {
        return res.json({
          status: persistence.degraded ? 'degraded' : 'ok',
          timestamp: new Date().toISOString(),
          runtime: {
            name: runtimeBuildMetadata.name,
            version: runtimeBuildMetadata.version,
            buildId: runtimeBuildMetadata.buildId,
          },
          database: {
            dirty: isDbDirty(),
            persistence: { degraded: persistence.degraded },
          },
        });
      }
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        return res.status(403).json({ error: 'Detailed health is available only from the local Lumi desktop client.' });
      }
      const db = readDB();
      const memory = process.memoryUsage();
      const toolMetrics = getToolRuntimeMetrics();
      const capabilityMetrics = getCapabilityRuntimeMetrics();
      const ollama = getLocalModelConfig('ollama');
      const lmstudio = getLocalModelConfig('lmstudio');
      const autonomousTasks = Array.isArray(db.autonomousTasks) ? db.autonomousTasks : [];
      const externalAiHistorySources = Array.isArray(db.externalAiHistorySources) ? db.externalAiHistorySources : [];
      const externalAiHistorySyncJobs = Array.isArray(db.externalAiHistorySyncJobs) ? db.externalAiHistorySyncJobs : [];
      const externalAiHistoryMessages = Array.isArray(db.externalAiHistoryMessages) ? db.externalAiHistoryMessages : [];
      const extensionRevisions = Array.isArray(db.extensionRevisions) ? db.extensionRevisions : [];
      const extensionReceipts = Array.isArray(db.extensionActivationReceipts) ? db.extensionActivationReceipts : [];
      const mcpHealth = mcpManager.getServerHealth();
      const acceptance = buildAcceptanceEvidenceSnapshot({
        db,
        manifest: toolRegistry.getCapabilityManifest(),
        toolMetrics: toolMetrics.tools,
        capabilityMetrics,
        mcpHealth,
      });
      const countTaskStatuses = (tasks: any[]) => tasks.reduce((counts: Record<string, number>, task: any) => {
        const status = String(task?.status || 'unknown');
        counts[status] = (counts[status] || 0) + 1;
        return counts;
      }, {});
      res.json({
        status: persistence.degraded ? "degraded" : "ok",
        timestamp: new Date().toISOString(),
        runtime: getRuntimeVersionInfo(),
        database: {
          users: db.users.length,
          interactions: db.interactions.length,
          dirty: isDbDirty(),
          persistence,
          actionTasks: (db.conversationActionTasks || []).length,
          actionReceipts: (db.conversationActionReceipts || []).length,
          extensionRevisions: extensionRevisions.length,
          extensionActivationReceipts: extensionReceipts.length,
          autonomousTasks: autonomousTasks.length,
          externalAiHistorySources: externalAiHistorySources.length,
          externalAiHistorySyncJobs: externalAiHistorySyncJobs.length,
          externalAiHistoryMessages: externalAiHistoryMessages.length,
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
          acceptance: buildPublicAcceptanceSummary(acceptance),
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
          desktopControl: getDesktopControlRuntimeSnapshot(),
          voiceprint: getVoiceprintRuntimeStatus(),
          gptSovits: getGptSovitsQueueStatus(),
          localModels: {
            ollama: getLocalModelQueueSnapshot('ollama'),
            lmstudio: getLocalModelQueueSnapshot('lmstudio'),
          },
          durableWork: {
            autonomy: countTaskStatuses(autonomousTasks),
            externalAiHistorySources: countTaskStatuses(externalAiHistorySources),
            externalAiHistorySyncJobs: countTaskStatuses(externalAiHistorySyncJobs),
            extensions: countTaskStatuses(extensionRevisions),
          },
        },
        supervisedRuntimes: {
          unified: getUnifiedRuntimeSupervisorStatus(),
          gptSovits: getGptSovitsRuntimeStatus(),
          voiceprint: getVoiceprintRuntimeStatus(),
        },
        readOnlyContextCache: readOnlyContextCache.metrics(),
        functionalProbes: {
          databaseRead: true,
          registeredTools: toolRegistry.list().length,
          extensionProviders: listRegisteredProviders().map(({ userId: _userId, ...provider }) => provider),
          mcp: mcpHealth,
          localModels: {
            ollama: {
              reachable: ollama.serviceReachable === true,
              inferenceHealthy: ollama.inferenceHealthy === true,
              healthStatus: ollama.healthStatus,
              baseUrl: ollama.baseUrl,
              modelCount: ollama.models.length,
              lastChecked: ollama.updatedAt,
              lastInferenceAt: ollama.lastInferenceAt,
              lastInferenceLatencyMs: ollama.lastInferenceLatencyMs,
              consecutiveFailures: ollama.consecutiveFailures || 0,
              nextRetryAt: ollama.nextRetryAt,
              error: ollama.lastError || '',
            },
            lmstudio: {
              reachable: lmstudio.serviceReachable === true,
              inferenceHealthy: lmstudio.inferenceHealthy === true,
              healthStatus: lmstudio.healthStatus,
              baseUrl: lmstudio.baseUrl,
              modelCount: lmstudio.models.length,
              lastChecked: lmstudio.updatedAt,
              lastInferenceAt: lmstudio.lastInferenceAt,
              lastInferenceLatencyMs: lmstudio.lastInferenceLatencyMs,
              consecutiveFailures: lmstudio.consecutiveFailures || 0,
              nextRetryAt: lmstudio.nextRetryAt,
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
  router.get("/cloud/health", requireAuth, (_req, res) => {
    try { res.json(getCloudHealth()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Authenticated, scope-isolated projection of what Lumi is actually doing.
  // Raw tool inputs/results never cross this boundary; the UI receives only
  // durable task identities, policy state, receipt outcomes and aggregate
  // runtime metrics.
  router.get('/runtime/status', requireAuth, (req, res) => {
    try {
      const scope = resolveDomain(req.user!);
      const toolMetrics = getToolRuntimeMetrics();
      const db = readDB();
      const capabilityMetrics = getCapabilityRuntimeMetrics();
      const runtimeStatus = buildStructuredRuntimeStatus(db, {
        userId: req.user!.uid,
        domain: scope.domain,
        orgId: scope.orgId,
        runtime: {
          toolMetrics: toolMetrics.totals,
          capabilityMetrics,
          voiceLatency: getVoiceLatencyStats(),
          supervisor: getUnifiedRuntimeSupervisorStatus(),
          readOnlyContextCache: readOnlyContextCache.metrics(),
        },
      });
      const acceptance = buildAcceptanceEvidenceSnapshot({
        db,
        manifest: toolRegistry.getCapabilityManifest(),
        toolMetrics: toolMetrics.tools,
        capabilityMetrics,
        mcpHealth: mcpManager.getServerHealth(),
        scope: {
          userId: req.user!.uid,
          domain: scope.domain,
          orgId: scope.orgId,
        },
      });
      res.json({ ...runtimeStatus, acceptance });
    } catch (error: any) {
      logger.error('Structured runtime status failed', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Explicit functional probe for local OpenAI-compatible runtimes. This is
  // separate from the cheap cached /health response so monitoring can choose
  // when to incur a network probe.
  router.get("/llm/local/health", requireAuth, requireAdmin, requireLocalRequest, async (_req, res) => {
    const current = {
      ollama: getLocalModelConfig('ollama'),
      lmstudio: getLocalModelConfig('lmstudio'),
    };
    const [ollama, lmstudio] = await Promise.all([
      refreshLocalModelConfig('ollama', current.ollama.baseUrl, { timeoutMs: 2500, inferenceTimeoutMs: 20_000 }),
      refreshLocalModelConfig('lmstudio', current.lmstudio.baseUrl, { timeoutMs: 2500, inferenceTimeoutMs: 20_000 }),
    ]);
    const status = ollama.detected || lmstudio.detected ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
      status,
      checkedAt: new Date().toISOString(),
      providers: {
        ollama: { ...ollama, queue: getLocalModelQueueSnapshot('ollama') },
        lmstudio: { ...lmstudio, queue: getLocalModelQueueSnapshot('lmstudio') },
      },
    });
  });

  router.get("/voice/active-provider", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
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

  router.post("/voice/doubao/probe", requireAuth, requireAdmin, requireLocalRequest, async (_req, res) => {
    const ttsDetails = getConfiguredDoubaoTtsDetails();
    if (!ttsDetails.credentialMode || !ttsDetails.voiceId) {
      return res.status(400).json({
        ok: false,
        error: 'Doubao Speech is not configured. Save a new-console API Key value first.',
      });
    }

    const startedAt = Date.now();
    const [streamingStt, speechSynthesis] = await Promise.allSettled([
      probeDoubaoStreamingConnection({ timeoutMs: 10_000, language: 'zh-CN' }),
      synthesizeDoubaoSpeech(
        'Lumi Doubao speech connection test.',
        ttsDetails.voiceId,
        AbortSignal.timeout(20_000),
      ).then(result => {
        if (result.audioBuffer.length < 256) throw new Error('Doubao TTS returned too little audio data to verify synthesis');
        return {
          ok: true as const,
          endpoint: ttsDetails.endpoint,
          resourceId: ttsDetails.resourceId,
          voiceId: ttsDetails.voiceId,
          format: result.format,
          audioBytes: result.audioBuffer.length,
        };
      }),
    ]);

    const failureMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason || 'Unknown error');
    const result = {
      ok: streamingStt.status === 'fulfilled' && speechSynthesis.status === 'fulfilled',
      credentialMode: ttsDetails.credentialMode,
      fallbackUsed: false,
      streamingStt: streamingStt.status === 'fulfilled'
        ? streamingStt.value
        : { ok: false, error: failureMessage(streamingStt.reason) },
      speechSynthesis: speechSynthesis.status === 'fulfilled'
        ? speechSynthesis.value
        : { ok: false, error: failureMessage(speechSynthesis.reason) },
      latencyMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
    };
    return res.status(result.ok ? 200 : 502).json(result);
  });

  router.post("/voice/provider", requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
    const { stt, tts } = req.body || {};
    const allowedStt = new Set<VoicePreference['stt']>(['auto', 'local-whisper', 'qwen', 'ark', 'whisper', 'relay']);
    const allowedTts = new Set<VoicePreference['tts']>(['auto', 'local-cosyvoice', 'gptsovits', 'cosyvoice', 'ark', 'relay']);
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
  router.get("/tools", requireAuth, (_req, res) => {
    const tools = toolRegistry.list().map(t => ({
      name: t.name,
      description: t.description.slice(0, 80),
      permission: t.permission,
      securityLevel: t.securityLevel,
    }));
    res.json(tools);
  });

  router.get("/scheduler/tasks", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    res.json({ tasks: scheduler.listTasks() });
  });

  router.post("/scheduler/tasks/:id/toggle", requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
    const { id } = req.params;
    const result = scheduler.toggleTask(id);
    if (!result.found) {
      return res.status(404).json({ error: `Task "${id}" not found` });
    }
    res.json({ id, enabled: result.enabled });
  });

  router.post("/scheduler/tasks/:id/reconcile", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    const { id } = req.params;
    const resolution = req.body?.resolution;
    if (!['confirmed_no_side_effect', 'accepted_unknown_outcome'].includes(resolution)) {
      return res.status(400).json({
        error: 'resolution must be confirmed_no_side_effect or accepted_unknown_outcome',
      });
    }
    const result = await scheduler.reconcileTask(id, resolution);
    if (!result.found) return res.status(404).json({ error: `Task "${id}" not found` });
    if (!result.reconciled) {
      return res.status(409).json({ id, ...result });
    }
    return res.json({ id, ...result });
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
        u.userId === decoded.uid &&
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
  router.get("/llm/providers", requireAuth, (_req, res) => {
    try {
      const stored = loadKeys();
      const envOrStore = (envKey: string, storeKey: string = envKey) =>
        !!(process.env[envKey] && process.env[envKey]!.length > 0) || !!stored[storeKey];
      const ollamaConfig = getLocalModelConfig('ollama');
      const lmstudioConfig = getLocalModelConfig('lmstudio');
      const extensionProviders = listRegisteredProviders().map(({ userId: _userId, ...provider }) => provider);
      const status = (
        provider: string,
        configured: boolean,
        model: string,
        runtimeHealthy = false,
      ) => ({
        ...assessProviderAvailability({ provider, configured, model, runtimeHealthy }),
        model,
      });
      const dynamicProviders = Object.fromEntries(extensionProviders.map(provider => {
        const providerId = String(provider.id);
        const model = String(provider.defaultModel || '');
        return [providerId, {
          ...status(providerId, provider.configured === true, model),
          local: provider.local === true,
          extension: true,
          version: provider.version,
          models: provider.models,
          compatibility: provider.compatibility,
          manifestDigest: provider.manifestDigest,
          signerFingerprint: provider.signerFingerprint,
        }];
      }));
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
          relay: status(
            'relay',
            relayConfigured(),
            process.env.RELAY_REASONING_MODEL || process.env.RELAY_MODEL || 'aliyun/qwen-plus',
          ),
          ollama: status('ollama', ollamaConfig.detected, ollamaConfig.models[0] || 'local', ollamaConfig.detected),
          lmstudio: status('lmstudio', lmstudioConfig.detected, lmstudioConfig.models[0] || 'local', lmstudioConfig.detected),
          ...dynamicProviders,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load provider status' });
    }
  });

  // LLM connection test
  router.post("/llm/test", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
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

  router.post("/llm/route/test", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    const uid = getUserIdFromRequest(req, jwtSecret);
    try {
      res.json(req.body?.probe === 'forced_primary_failure'
        ? await testLumiModelFailoverConfiguration(uid, llm)
        : await testLumiModelConfiguration(uid, 'reasoning', llm));
    } catch (err: any) {
      const message = sanitizedProviderError(err);
      const configurationError = /not configured|not currently reachable|unsupported provider|valid model/i.test(message);
      const routingFailure = publicModelRoutingFailure(err);
      res.status(configurationError && !routingFailure ? 400 : 502).json({
        ok: false,
        ...(routingFailure || { error: message }),
      });
    }
  });

  router.post("/vision/test", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
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

  router.post("/retrieval-model/test", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
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
  router.put("/preferences/llm", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      const updated = upsertUserPreferredLLM(uid, req.body || {});
      res.json({ success: true, ...updated, scope: 'lumi', organizationOverridesSupported: false });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/preferences/llm", requireAuth, (req, res) => {
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

  router.get("/preferences/llm/routing-receipts", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10);
      const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
      res.json({
        receipts: listModelRoutingReceipts(uid, limit, {
          conversationId: typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined,
          requestId: typeof req.query.requestId === 'string' ? req.query.requestId : undefined,
          interactionId: typeof req.query.interactionId === 'string' ? req.query.interactionId : undefined,
        }),
      });
    } catch (err: any) {
      res.status(500).json({ error: sanitizedProviderError(err) });
    }
  });

  /**
   * Apply the configured Lumi official API to every role with a real runtime
   * adapter. This is deliberately one server-side operation rather than a
   * series of browser PUTs, so the response is an auditable per-role receipt
   * and an unexpected write failure can roll the preference set back.
   */
  // Applying the official endpoint changes the instance-wide voice provider
  // preference as well as the signed-in user's model roles. Keep it local and
  // administrator-only, just like credential writes and live provider probes.
  router.post("/preferences/official/apply", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    const uid = getUserIdFromRequest(req, jwtSecret);
    try {
      const result = await applyLumiOfficialModelConfiguration(uid);
      return res.json(result);
    } catch (err: any) {
      const message = sanitizedProviderError(err);
      const notConfigured = /not configured|RELAY_API_KEY|RELAY_BASE_URL/i.test(message);
      return res.status(notConfigured ? 400 : 500).json({
        ok: false,
        provider: 'relay',
        configured: isLumiOfficialApiConfigured(uid),
        ...(notConfigured ? { code: 'OFFICIAL_API_NOT_CONFIGURED' } : {}),
        applied: [],
        skipped: [],
        failed: [],
        error: message,
      });
    }
  });

  router.put("/preferences/vision", requireAuth, (req, res) => {
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

  router.get("/preferences/vision", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      return res.json(getUserPreferredVision(uid));
    } catch {
      res.json(getUserPreferredVision('anonymous'));
    }
  });

  router.put("/preferences/generation", requireAuth, (req, res) => {
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

  router.get("/preferences/generation", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json(getUserPreferredGenerationModels(uid));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/preferences/world", requireAuth, (req, res) => {
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

  router.get("/preferences/world", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json({ ...getUserWorldModelPrefs(uid), resolved: getUserPreferredWorldModel(uid) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/preferences/retrieval-model", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json(upsertUserRetrievalModelPreferences(uid, req.body));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/preferences/retrieval-model", requireAuth, (req, res) => {
    try {
      const uid = getUserIdFromRequest(req, jwtSecret);
      res.json(getUserRetrievalModelPreferences(uid));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/settings/keys", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      const stored = loadKeys();
      const masked: Record<string, boolean> = {};
      for (const name of getAllKeyNames()) {
        const configured = process.env[name] || stored[name];
        masked[name] = name === 'DOUBAO_SPEECH_KEY'
          ? parseDoubaoSpeechCredentials(configured) !== null
          : !!configured;
      }
      res.json(masked);
    } catch (err: any) {
      logger.error(`Failed to load key status: ${redactDiagnosticSecrets(err?.message || err).slice(0, 500)}`);
      res.status(500).json({ error: 'Failed to load key status' });
    }
  });

  router.post("/settings/keys", requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
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
        if (k === 'DOUBAO_SPEECH_KEY' && v.trim().length > 0 && !parseDoubaoSpeechCredentials(v)) {
          return res.status(400).json({
            error: 'DOUBAO_SPEECH_KEY only accepts a new-console API Key value. Legacy AppID:AccessToken is not supported.',
          });
        }
        const endpointError = validateProtectedEndpointSetting(k, v.trim());
        if (endpointError) {
          return res.status(400).json({ error: endpointError });
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
      logger.error(`Failed to save key settings: ${redactDiagnosticSecrets(err?.message || err).slice(0, 500)}`);
      res.status(500).json({ error: 'Failed to save key settings' });
    }
  });

  // Generic settings store — for tool overrides, security prefs, etc.
  router.post("/settings", requireAuth, (req, res) => {
    try {
      const { key, value } = req.body || {};
      if (!key || typeof key !== 'string' || value === undefined || !USER_SCOPED_SETTING_KEYS.has(key)) {
        return res.status(400).json({ error: 'key and value required' });
      }
      const normalized = normalizeUserSetting(key, value);
      const persistedKey = scopedUserSettingKey(req.user!.uid, key);
      const db = readDB();
      if (!db.settings) db.settings = [];
      const idx = db.settings.findIndex((s: any) => s.key === persistedKey);
      if (idx >= 0) {
        db.settings[idx].value = JSON.stringify(normalized);
      } else {
        db.settings.push({ key: persistedKey, value: JSON.stringify(normalized) });
      }
      writeDB(db);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/settings/:key", requireAuth, (req, res) => {
    try {
      if (!USER_SCOPED_SETTING_KEYS.has(req.params.key)) {
        return res.status(404).json({ error: 'Unknown user setting' });
      }
      const db = readDB();
      const persistedKey = scopedUserSettingKey(req.user!.uid, req.params.key);
      const row = (db.settings || []).find((s: any) => s.key === persistedKey);
      res.json(row ? JSON.parse(row.value) : null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System stats — real-time CPU / memory / platform info
  router.get("/system/stats", requireAuth, async (_req: any, res: any) => {
    try {
      res.json(await getSystemStatsSnapshot());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // Latency stats
  router.get("/monitor/latency", requireAuth, (_req: any, res: any) => {
    res.json({ ...getLatencyStats(), voice: getVoiceLatencyStats() });
  });

  // Ecosystem stats
  router.get("/ecosystem/stats", requireAuth, requireAdmin, requireLocalRequest, (_req: any, res: any) => {
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
        interactionCount: (db.interactions || []).length,
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
  router.get("/ollama/config", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    res.json(getLocalModelConfig('ollama'));
  });

  // PUT: save Ollama URL and trigger re-detection
  router.put("/ollama/config", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
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
  router.get("/lmstudio/config", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    res.json(getLocalModelConfig('lmstudio'));
  });

  // PUT: save LM Studio URL and trigger re-detection
  router.put("/lmstudio/config", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const { baseUrl } = req.body || {};
      const result = await refreshLocalModelConfig('lmstudio', baseUrl, { timeoutMs: 5000 });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: sanitizedProviderError(err) });
    }
  });
}
