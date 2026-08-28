import {
  readDB,
  writeDB,
  flushDB,
  ensureDatabaseInitialized,
  isDbDirty,
  pruneOldData,
  requireDatabaseStartupQuickCheck,
} from "../../db_layer";
import { toolRegistry } from "../tools/registry";
import { registerAllTools } from "../tools/definitions/index";
import { mcpManager, registerMCPTools } from "../mcp";
import { scheduler, registerScheduledTasks } from "../scheduler";
import {
  isFirstBootComplete,
  isSystemExplorationAllowed,
  persistFirstBootExploration,
} from "../autonomy/system_explorer";
import { initializeDesktopBootstrapProof } from "../config/desktop_bootstrap";
import { markLegacyProductDataMigrationVerified } from "../config/data_path";
import { repairCorruptedOrganizationNames } from "../org/db";
import { startMessagingConnections, stopMessagingConnections } from "./messaging";
import { recoverOrphanedConversationActionExecutions } from "../conversation/manager";
import { stopGptSovitsRuntime } from "../tts/gptsovits_runtime";
import { stopVoiceprintRuntime } from "../biometrics/voiceprint_provider";
import {
  collectSystemSnapshotInWorker,
  stopSystemExplorationWorker,
} from "./system_exploration_worker";
import { hydrateAutonomousTasksFromDb } from "../autonomy/task_queue";
import {
  persistWorkflowRuntimeBarrier,
  reconcileExpiredWorkflowRuns,
  startWorkflowRuntimeMaintenance,
} from "../workflows/runtime";
import { recoverInterruptedExternalAiHistorySyncs } from "../agents/external_ai_history_sync";
import { hydrateActiveExtensions } from "../extensions/registry";
import { runScheduledReadOnlyPrewarm, readOnlyContextCache } from "../context/read_only_cache";
import { getGptSovitsRuntimeStatus } from "../tts/gptsovits_runtime";
import { getVoiceprintRuntimeStatus } from "../biometrics/voiceprint_provider";
import {
  setUnifiedRuntimeSupervisor,
  UnifiedRuntimeSupervisor,
} from "./unified_supervisor";
import {
  initializeChatExecutionRegistryPersistence,
  waitForChatExecutionPersistence,
} from "../socket/chat_execution_registry";
import { installRuntimeFileLogger } from './file_logger';
import { ensurePendingConfirmationPersistenceInitialized } from '../tools/pending_confirmation_repository';

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

let unifiedRuntimeSupervisor: UnifiedRuntimeSupervisor | null = null;

function scheduleFirstBootExploration(runtimeDir: string, delayMs = 30000) {
  const timer = setTimeout(() => {
    if (isFirstBootComplete()) return;
    if (!isSystemExplorationAllowed()) {
      console.log('[Bootstrap] First-boot exploration is waiting for local-admin authorization.');
      return;
    }
    console.log('[Bootstrap] First boot detected - running system exploration in an isolated worker...');
    void collectSystemSnapshotInWorker(runtimeDir)
      .then(snapshot => {
        if (isFirstBootComplete()) return;
        if (!isSystemExplorationAllowed()) {
          console.log('[Bootstrap] Discarded first-boot exploration because authorization was revoked.');
          return;
        }
        persistFirstBootExploration(snapshot);
        console.log(`[Bootstrap] Exploration complete: ${snapshot.hardware.cpus.model}, ${snapshot.hardware.totalMemoryGB}GB RAM, ${snapshot.software.installedApps.length} apps, ${snapshot.filesystem.totalUserFiles} user files`);
      })
      .catch((err: Error) => {
        console.warn('[Bootstrap] System exploration failed:', err.message);
      });
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
  const runtimeLogPath = installRuntimeFileLogger();
  if (runtimeLogPath) console.log(`[RuntimeLog] Writing sanitized diagnostics to ${runtimeLogPath}`);

  if (!jwtSecret) {
    console.error('FATAL: JWT_SECRET environment variable is not set.');
    process.exit(1);
  }

  try {
    // Rotate the native desktop handoff on every backend start. The HTTP
    // bootstrap route remains fail-closed until this succeeds.
    initializeDesktopBootstrapProof();
    await ensureDatabaseInitialized();
    const initializedDb = readDB();
    const migrationCounts = {
      quickCheck: requireDatabaseStartupQuickCheck(),
      // A migrated database must expose all three durable collections. Using
      // -1 makes a missing collection fail closed instead of recording a
      // misleading zero count; non-migrated roots return before validation.
      userCount: Array.isArray(initializedDb.users) ? initializedDb.users.length : -1,
      conversationCount: Array.isArray(initializedDb.conversations) ? initializedDb.conversations.length : -1,
      interactionCount: Array.isArray(initializedDb.interactions) ? initializedDb.interactions.length : -1,
    } as const;
    if (markLegacyProductDataMigrationVerified(migrationCounts)) {
      console.log(
        `[Data] LumiCore product data migration passed SQLite quick_check; recorded post-startup rows users=${migrationCounts.userCount}, conversations=${migrationCounts.conversationCount}, interactions=${migrationCounts.interactionCount}.`,
      );
    }
    const recoveredChatReceipts = await initializeChatExecutionRegistryPersistence();
    const recoveredPendingConfirmations = await ensurePendingConfirmationPersistenceInitialized();
    console.log('Database initialized successfully');
    if (recoveredChatReceipts > 0) {
      console.log(`[Bootstrap] Recovered ${recoveredChatReceipts} terminal chat execution receipt(s)`);
    }
    if (recoveredPendingConfirmations > 0) {
      console.log(`[Bootstrap] Recovered ${recoveredPendingConfirmations} encrypted pending confirmation(s)`);
    }
    const recoveredAutonomousTasks = hydrateAutonomousTasksFromDb(true);
    const reconciledWorkflowRuns = reconcileExpiredWorkflowRuns(new Date(), { recoverAllRunning: true });
    if (reconciledWorkflowRuns > 0) await persistWorkflowRuntimeBarrier();
    startWorkflowRuntimeMaintenance();
    const recoveredExternalAiHistorySyncs = recoverInterruptedExternalAiHistorySyncs();
    if (recoveredAutonomousTasks > 0) {
      console.warn(
        `[Bootstrap] Recovered ${recoveredAutonomousTasks} autonomous LumiCore task lease(s).`,
      );
    }
    if (reconciledWorkflowRuns > 0) {
      console.warn(`[Bootstrap] Blocked ${reconciledWorkflowRuns} expired workflow run(s) pending read-only reconciliation.`);
    }
    if (recoveredExternalAiHistorySyncs > 0) {
      console.warn(`[Bootstrap] Recovered ${recoveredExternalAiHistorySyncs} external AI history sync(s) at their last durable cursor.`);
    }
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

  // Register LumiCore capabilities.
  registerAllTools(toolRegistry, { getDeepSeek: llm.getDeepSeek, getGemini: llm.getGemini, getOpenAI: llm.getOpenAI, getAnthropic: llm.getAnthropic, getQwen: llm.getQwen });
  console.log(`[Tools] Registered ${toolRegistry.list().length} built-in tools`);
  const extensionHydration = await hydrateActiveExtensions(toolRegistry);
  if (extensionHydration.activated > 0 || extensionHydration.failed > 0) {
    console.log(`[Extensions] Active=${extensionHydration.activated}, boot-failed=${extensionHydration.failed}`);
  }
  for (const error of extensionHydration.errors) console.warn(`[Extensions] ${error}`);
  registerMCPTools(io).then(mcpTools => {
    if (mcpTools.length > 0) {
      console.log(`[MCP] Registered ${mcpTools.length} MCP tools (total: ${toolRegistry.list().length})`);
    }
  }).catch(err => {
    console.warn('[MCP] Tool registration warning:', err.message);
  });

  unifiedRuntimeSupervisor = new UnifiedRuntimeSupervisor([
    {
      id: 'read-only-context-prewarm',
      intervalMs: 15_000,
      timeoutMs: 2_000,
      run: () => runScheduledReadOnlyPrewarm({ deadlineMs: 1_500, maxJobs: 8 }),
    },
    {
      id: 'runtime-resource-observation',
      intervalMs: 5_000,
      timeoutMs: 1_000,
      run: () => ({
        registeredTools: toolRegistry.list().length,
        databaseReadable: Boolean(readDB()),
        readOnlyCache: readOnlyContextCache.metrics(),
        gptSovits: getGptSovitsRuntimeStatus(),
        voiceprint: getVoiceprintRuntimeStatus(),
      }),
    },
  ]);
  setUnifiedRuntimeSupervisor(unifiedRuntimeSupervisor);
  unifiedRuntimeSupervisor.start();

  // GPT-SoVITS is supervised and started on first synthesis request. Keeping
  // the multi-gigabyte model resident while voice is idle is no longer the
  // backend bootstrap default.

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

    scheduleFirstBootExploration(__dirname);
    schedulePostStartupFlush(5_000);
    schedulePostStartupFlush(30_000);
  });

  // Cleanup on exit
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log('[Shutdown] Cleaning up...');
    stopSystemExplorationWorker();
    scheduler.stop();
    unifiedRuntimeSupervisor?.stop();
    unifiedRuntimeSupervisor = null;
    setUnifiedRuntimeSupervisor(null);
    try {
      await stopMessagingConnections();
      console.log('[Messaging] Long connections stopped');
    } catch (err: any) {
      console.warn('[Messaging] Shutdown error:', err?.message || err);
    }
    try {
      await waitForChatExecutionPersistence();
      await flushDB();
      console.log('[Shutdown] Database flushed');
    } catch {}
    try {
      await mcpManager.disconnectAll();
      console.log('[MCP] All servers disconnected');
    } catch (err: any) {
      console.warn('[MCP] Disconnect error:', err.message);
    }
    stopGptSovitsRuntime();
    await stopVoiceprintRuntime();
  };
  process.on('SIGINT', () => { cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { cleanup().then(() => process.exit(0)); });
}
