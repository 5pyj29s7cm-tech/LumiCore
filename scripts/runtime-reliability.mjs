import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

function parseArgs(argv) {
  const args = {
    mode: 'lifecycle',
    runtime: 'packaged',
    distServer: path.join(root, 'desktop-resources', 'dist-server'),
    sourceEntry: path.join(root, 'server.ts'),
    iterations: 50,
    durationHours: 2,
    minMixedRounds: 200,
    pollMs: 30_000,
    timeoutMs: 45_000,
    ttsFixtureDir: process.env.LUMI_TTS_RELIABILITY_FIXTURE_DIR
      ? path.resolve(process.env.LUMI_TTS_RELIABILITY_FIXTURE_DIR)
      : '',
    ttsProbeIntervalMs: 10 * 60_000,
    ttsProbeTimeoutMs: 3 * 60_000,
    baselineMs: Number(process.env.LUMI_COLD_START_BASELINE_MS || 0),
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--mode') args.mode = argv[++i];
    else if (value === '--runtime') args.runtime = argv[++i];
    else if (value === '--dist-server') args.distServer = path.resolve(argv[++i]);
    else if (value === '--source-entry') args.sourceEntry = path.resolve(argv[++i]);
    else if (value === '--iterations') args.iterations = Number(argv[++i]);
    else if (value === '--duration-hours') args.durationHours = Number(argv[++i]);
    else if (value === '--min-mixed-rounds') args.minMixedRounds = Number(argv[++i]);
    else if (value === '--poll-ms') args.pollMs = Number(argv[++i]);
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (value === '--tts-fixture-dir') args.ttsFixtureDir = path.resolve(argv[++i]);
    else if (value === '--tts-probe-interval-ms') args.ttsProbeIntervalMs = Number(argv[++i]);
    else if (value === '--tts-probe-timeout-ms') args.ttsProbeTimeoutMs = Number(argv[++i]);
    else if (value === '--baseline-ms') args.baselineMs = Number(argv[++i]);
    else if (value === '--keep') args.keep = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!['lifecycle', 'soak'].includes(args.mode)) throw new Error(`Unsupported mode: ${args.mode}`);
  if (!['packaged', 'source'].includes(args.runtime)) throw new Error(`Unsupported runtime: ${args.runtime}`);
  if (
    args.iterations < 1
    || args.durationHours <= 0
    || args.minMixedRounds < 1
    || args.pollMs < 100
    || args.ttsProbeIntervalMs < 1000
    || args.ttsProbeTimeoutMs < 1000
  ) throw new Error('Invalid reliability test limits');
  return args;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
}

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeTtsProbe(baseUrl, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/voice/synthesize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Lumi 稳定性测试。', provider: 'gptsovits', voiceId: 'default' }),
      signal: controller.signal,
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`GPT-SoVITS probe failed with ${response.status}`);
    if (body.length <= 44) throw new Error(`GPT-SoVITS probe returned an invalid audio payload (${body.length} bytes)`);
    return body.length;
  } finally {
    clearTimeout(timer);
  }
}

async function stageTtsFixture(fixtureRoot, dataDirectory) {
  if (!fixtureRoot) return null;
  const sourceSegments = path.join(fixtureRoot, 'segments');
  const entries = await fs.readdir(sourceSegments, { withFileTypes: true }).catch(() => []);
  const sourceName = entries
    .filter(entry => entry.isFile() && /\.wav$/i.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))[0];
  if (!sourceName) throw new Error(`No WAV reliability fixture found under ${sourceSegments}`);

  const destination = path.join(dataDirectory, 'voice_training');
  const destinationSegments = path.join(destination, 'segments');
  await fs.mkdir(destinationSegments, { recursive: true });
  await fs.copyFile(path.join(sourceSegments, sourceName), path.join(destinationSegments, 'segment_0000.wav'));
  // The probe validates process/runtime behavior, not voice quality. A fixed
  // transcript keeps private reference speech out of retained diagnostics.
  await fs.writeFile(path.join(destination, 'filelist.txt'), 'segment_0000.wav|reliability|ZH|稳定性测试参考音频。\n');
  return { sourceName };
}

async function scrubStagedTtsFixture(runRoot) {
  const voiceRoot = path.join(runRoot, 'profile', 'data', 'voice_training');
  await Promise.all([
    fs.rm(path.join(voiceRoot, 'segments', 'segment_0000.wav'), { force: true }),
    fs.rm(path.join(voiceRoot, 'filelist.txt'), { force: true }),
  ]);
}

async function waitForHealth(baseUrl, child, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`backend exited early with code ${child.exitCode ?? child.signalCode}`);
    try {
      const health = await fetchJson(`${baseUrl}/health`, 2000);
      if (
        health?.runtime?.version
        && health.runtime.version !== '0.0.0'
        && health.status === 'ok'
        && health.database?.dirty === false
      ) return health;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`health timeout: ${lastError?.message || 'unknown error'}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    throw new Error(`backend ${child.pid} required a forced kill`);
  }
}

async function startRuntime(args, runRoot, logPrefix, runtimeMeta) {
  let nodePath;
  let childArgs;
  let runtimeCwd;
  if (args.runtime === 'source') {
    const tsxPath = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!existsSync(tsxPath)) throw new Error(`Source runtime requires tsx at ${tsxPath}`);
    if (!existsSync(args.sourceEntry)) throw new Error(`Source runtime entry missing: ${args.sourceEntry}`);
    nodePath = process.execPath;
    childArgs = [tsxPath, args.sourceEntry];
    runtimeCwd = root;
  } else {
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    nodePath = path.join(args.distServer, nodeName);
    const entryPath = path.join(args.distServer, 'entry.cjs');
    if (!existsSync(nodePath) || !existsSync(entryPath)) throw new Error(`Packaged runtime missing under ${args.distServer}`);
    childArgs = [entryPath];
    runtimeCwd = args.distServer;
  }
  const port = await freePort();
  const stdoutPath = path.join(runRoot, `${logPrefix}.out.log`);
  const stderrPath = path.join(runRoot, `${logPrefix}.err.log`);
  const stdout = await fs.open(stdoutPath, 'a');
  const stderr = await fs.open(stderrPath, 'a');
  const dataRoot = path.join(runRoot, 'profile');
  const home = path.join(runRoot, 'home');
  const dataDirectory = path.join(dataRoot, 'data');
  await fs.mkdir(dataDirectory, { recursive: true });
  // Source runs execute from the repository root, where a developer may have
  // legacy data/.  This marker keeps reliability probes isolated from it.
  await fs.writeFile(path.join(dataDirectory, '.migration_skip'), '', { flag: 'a' });
  await stageTtsFixture(args.ttsFixtureDir, dataDirectory);
  await fs.mkdir(home, { recursive: true });
  const child = spawn(nodePath, childArgs, {
    cwd: runtimeCwd,
    windowsHide: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LUMI_DESKTOP: '1',
      LUMI_DATA_DIR: dataRoot,
      LUMI_LOG_FILE: path.join(dataRoot, 'logs', 'server.log'),
      USERPROFILE: home,
      LUMI_RELIABILITY_HOME: home,
      ...(args.runtime === 'source' ? {
        LUMI_BUILD_ID: runtimeMeta.buildId,
        LUMI_VERSION: runtimeMeta.version,
        LUMI_BUILT_AT: runtimeMeta.builtAt,
        LUMI_RELEASE_CHANNEL: 'internal-source',
      } : {}),
    },
  });
  return { child, baseUrl: `http://127.0.0.1:${port}/api`, stdout, stderr, stdoutPath, stderrPath, dataRoot };
}

function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

async function checkSqlite(databasePath) {
  const sqlite3 = (await import('sqlite3')).default;
  const db = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(handle));
  });
  try {
    const all = sql => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
    const integrity = await all('PRAGMA integrity_check');
    const foreignKeys = await all('PRAGMA foreign_key_check');
    if (integrity.length !== 1 || String(integrity[0].integrity_check).toLowerCase() !== 'ok' || foreignKeys.length > 0) {
      throw new Error(`SQLite integrity failed: ${JSON.stringify({ integrity, foreignKeys })}`);
    }
  } finally {
    await new Promise(resolve => db.close(() => resolve()));
  }
}

async function runLifecycle(args, runRoot, runtimeMeta) {
  const startupMs = [];
  for (let index = 0; index < args.iterations; index += 1) {
    const started = performance.now();
    const runtime = await startRuntime(args, runRoot, `lifecycle-${String(index + 1).padStart(3, '0')}`, runtimeMeta);
    try {
      const health = await waitForHealth(runtime.baseUrl, runtime.child, args.timeoutMs);
      if (health.database?.dirty !== false || health.runtime?.buildId !== runtimeMeta.buildId) throw new Error('runtime identity or database state changed');
      startupMs.push(Math.round(performance.now() - started));
      const handshake = await fetch(`http://127.0.0.1:${new URL(runtime.baseUrl).port}/socket.io/?EIO=4&transport=polling`).then(response => response.text());
      if (!handshake.startsWith('0{')) throw new Error('Socket.IO handshake failed');
    } finally {
      await stopChild(runtime.child);
      await runtime.stdout.close();
      await runtime.stderr.close();
    }
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) throw new Error(`orphan backend process after iteration ${index + 1}`);
    console.log(`[lifecycle] ${index + 1}/${args.iterations}: ${startupMs.at(-1)} ms`);
  }
  const p95Ms = percentile95(startupMs);
  const targetMs = args.baselineMs > 0 ? Math.floor(args.baselineMs * 0.75) : null;
  const result = { mode: 'lifecycle', runtimeKind: args.runtime, ok: targetMs === null || p95Ms <= targetMs, buildId: runtimeMeta.buildId, version: runtimeMeta.version, iterations: args.iterations, startupMs, p95Ms, baselineMs: args.baselineMs || null, targetMs, orphanProcesses: 0, completedAt: new Date().toISOString() };
  if (!result.ok) throw Object.assign(new Error(`cold-start P95 ${p95Ms} ms exceeds 75% baseline target ${targetMs} ms`), { result });
  return result;
}

async function runSoak(args, runRoot, runtimeMeta) {
  const runtime = await startRuntime(args, runRoot, 'soak', runtimeMeta);
  let started = 0;
  let deadline = 0;
  let polls = 0;
  let mixedRounds = 0;
  let functionalCalls = 0;
  let maxToolQueue = 0;
  let maxTtsQueue = 0;
  let maxVoiceprintQueue = 0;
  let maxToolErrorRate = 0;
  let maxToolTimeoutRate = 0;
  let maxGptSovitsBudgetExceeded = 0;
  let maxVoiceprintBudgetExceeded = 0;
  let databaseDirtyObservations = 0;
  let gptSovitsInstalled = false;
  let ttsFixtureReady = false;
  let ttsProbeCount = 0;
  let ttsProbeAudioBytes = 0;
  let ttsProbeError = '';
  let nextTtsProbeAt = 0;
  let authToken = '';
  let idleReclamationVerified = false;
  let finalHealth = null;
  const ttsWorkingSetSamples = [];
  try {
    const initialHealth = await waitForHealth(runtime.baseUrl, runtime.child, args.timeoutMs);
    finalHealth = initialHealth;
    gptSovitsInstalled = initialHealth.supervisedRuntimes?.gptSovits?.installed === true;
    ttsFixtureReady = Boolean(args.ttsFixtureDir);
    if (gptSovitsInstalled && ttsFixtureReady) {
      const auth = await fetchJson(`${runtime.baseUrl}/auth/bootstrap`, 10_000);
      authToken = String(auth.token || '');
      if (!authToken) throw new Error('Local reliability identity bootstrap did not return a token');
      try {
        ttsProbeAudioBytes += await synthesizeTtsProbe(runtime.baseUrl, authToken, args.ttsProbeTimeoutMs);
        ttsProbeCount += 1;
        functionalCalls += 1;
      } catch (error) {
        ttsProbeError = error?.message || String(error);
      }
      nextTtsProbeAt = Date.now() + args.ttsProbeIntervalMs;
    }
    started = Date.now();
    deadline = started + args.durationHours * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) throw new Error(`backend restarted/exited with ${runtime.child.exitCode ?? runtime.child.signalCode}`);
      if (authToken && Date.now() >= nextTtsProbeAt) {
        try {
          ttsProbeAudioBytes += await synthesizeTtsProbe(runtime.baseUrl, authToken, args.ttsProbeTimeoutMs);
          ttsProbeCount += 1;
          functionalCalls += 1;
          ttsProbeError = '';
        } catch (error) {
          ttsProbeError = error?.message || String(error);
        }
        nextTtsProbeAt = Date.now() + args.ttsProbeIntervalMs;
      }
      const [health, mcp, providers, marketplace, socketHandshake] = await Promise.all([
        fetchJson(`${runtime.baseUrl}/health`),
        fetchJson(`${runtime.baseUrl}/mcp/health`),
        fetchJson(`${runtime.baseUrl}/llm/providers`),
        fetchJson(`${runtime.baseUrl}/marketplace/skills?lang=zh`),
        fetch(`http://127.0.0.1:${new URL(runtime.baseUrl).port}/socket.io/?EIO=4&transport=polling`).then(response => response.text()),
      ]);
      if (!['ok', 'degraded'].includes(health.status) || health.runtime?.buildId !== runtimeMeta.buildId) {
        throw new Error('health or runtime identity invariant failed');
      }
      if (health.database?.dirty === true) databaseDirtyObservations += 1;
      if (!socketHandshake.startsWith('0{')) throw new Error('Socket.IO mixed-round handshake failed');
      if (!providers?.providers || !Array.isArray(marketplace) || marketplace.length < 48) throw new Error('provider/marketplace functional probe failed');
      const unhealthy = Object.entries(mcp.servers || {}).filter(([, state]) => Number(state.consecutiveCrashes || 0) > 0 || ['crashed', 'failed', 'restarting'].includes(state.status));
      if (unhealthy.length) throw new Error(`MCP crash state: ${JSON.stringify(unhealthy)}`);
      polls += 1;
      mixedRounds += 1;
      functionalCalls += 5;
      finalHealth = health;
      maxToolQueue = Math.max(maxToolQueue, Number(health.queues?.toolCallsInFlight || 0));
      maxTtsQueue = Math.max(maxTtsQueue, Number(health.queues?.gptSovits?.queueLength || 0));
      maxVoiceprintQueue = Math.max(maxVoiceprintQueue, Number(health.queues?.voiceprint?.queueLength || 0));
      maxToolErrorRate = Math.max(maxToolErrorRate, Number(health.tools?.totals?.errorRate || 0));
      maxToolTimeoutRate = Math.max(maxToolTimeoutRate, Number(health.tools?.totals?.timeoutRate || 0));
      const gptRuntime = health.supervisedRuntimes?.gptSovits || {};
      const voiceprintRuntime = health.supervisedRuntimes?.voiceprint || {};
      gptSovitsInstalled ||= gptRuntime.installed === true;
      maxGptSovitsBudgetExceeded = Math.max(maxGptSovitsBudgetExceeded, Number(gptRuntime.resources?.budgetExceededCount || 0));
      maxVoiceprintBudgetExceeded = Math.max(maxVoiceprintBudgetExceeded, Number(voiceprintRuntime.resources?.budgetExceededCount || 0));
      const ttsRssBytes = Number(gptRuntime.resources?.rssBytes || 0);
      if (ttsRssBytes > 0) ttsWorkingSetSamples.push({ at: Date.now(), rssBytes: ttsRssBytes });
      await new Promise(resolve => setTimeout(resolve, Math.min(args.pollMs, Math.max(0, deadline - Date.now()))));
    }

    if (!gptSovitsInstalled) {
      idleReclamationVerified = true;
    } else if (ttsProbeCount > 0) {
      const lastStatus = finalHealth?.supervisedRuntimes?.gptSovits || {};
      const idleTimeoutMs = Number(lastStatus.idleTimeoutMs || 0);
      const idleDeadline = Date.now() + idleTimeoutMs + 30_000;
      while (Date.now() < idleDeadline) {
        const health = await fetchJson(`${runtime.baseUrl}/health`);
        finalHealth = health;
        const status = health.supervisedRuntimes?.gptSovits || {};
        if (status.owned !== true && status.ready !== true && status.starting !== true) {
          idleReclamationVerified = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(2_000, Math.max(0, idleDeadline - Date.now()))));
      }
    }
    finalHealth = await waitForHealth(runtime.baseUrl, runtime.child, args.timeoutMs);
  } finally {
    await stopChild(runtime.child);
    await runtime.stdout.close();
    await runtime.stderr.close();
  }
  const logs = `${await fs.readFile(runtime.stdoutPath, 'utf8')}\n${await fs.readFile(runtime.stderrPath, 'utf8')}`;
  const unhandled = logs.match(/UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|uncaughtException/gi) || [];
  if (unhandled.length) throw new Error(`unhandled runtime exceptions found: ${unhandled.length}`);
  const lastHourStart = deadline - 60 * 60 * 1000;
  const lastHourSamples = ttsWorkingSetSamples.filter(sample => sample.at >= lastHourStart);
  const ttsLastHourGrowthRate = lastHourSamples.length >= 2 && lastHourSamples[0].rssBytes > 0
    ? Number(((lastHourSamples.at(-1).rssBytes - lastHourSamples[0].rssBytes) / lastHourSamples[0].rssBytes).toFixed(4))
    : null;
  const gptRuntime = finalHealth?.supervisedRuntimes?.gptSovits || {};
  const voiceprintRuntime = finalHealth?.supervisedRuntimes?.voiceprint || {};
  const voiceprintIdleExpired = voiceprintRuntime.running === true && voiceprintRuntime.resources?.sampledAt
    ? Date.now() - Date.parse(voiceprintRuntime.resources.sampledAt) >= Number(voiceprintRuntime.idleTimeoutMs || 0)
    : false;
  const result = {
    mode: 'soak',
    runtimeKind: args.runtime,
    ok: true,
    buildId: runtimeMeta.buildId,
    version: runtimeMeta.version,
    requestedHours: args.durationHours,
    elapsedMs: Date.now() - started,
    polls,
    mixedRounds,
    functionalCalls,
    requiredMixedRounds: args.minMixedRounds,
    healthProbeInterruptions: 0,
    maxQueues: { tools: maxToolQueue, gptSovits: maxTtsQueue, voiceprint: maxVoiceprintQueue },
    maxToolErrorRate,
    maxToolTimeoutRate,
    ttsCoverage: !gptSovitsInstalled
      ? 'not_installed'
      : !ttsFixtureReady
        ? 'missing_fixture'
        : ttsProbeCount > 0 && ttsWorkingSetSamples.length >= 2
          ? 'observed'
          : 'missing_workload',
    ttsProbeCount,
    ttsProbeAudioBytes,
    ttsProbeError: ttsProbeError || null,
    ttsWorkingSetSamples: ttsWorkingSetSamples.length,
    ttsLastHourGrowthRate,
    sidecarBudgetExceeded: { gptSovits: maxGptSovitsBudgetExceeded, voiceprint: maxVoiceprintBudgetExceeded },
    idleReclamationVerified: idleReclamationVerified && !voiceprintIdleExpired,
    databaseDirtyObservations,
    backendRestarts: 0,
    mcpConsecutiveCrashes: 0,
    databaseDirty: finalHealth?.database?.dirty === true,
    unhandledExceptions: 0,
    completedAt: new Date().toISOString(),
  };
  const ttsStable = result.ttsCoverage === 'not_installed'
    || (result.ttsCoverage === 'observed' && result.ttsLastHourGrowthRate !== null && result.ttsLastHourGrowthRate <= 0.1);
  if (
    mixedRounds < args.minMixedRounds
    || maxGptSovitsBudgetExceeded > 0
    || maxVoiceprintBudgetExceeded > 0
    || !result.idleReclamationVerified
    || !ttsStable
  ) {
    result.ok = false;
    throw Object.assign(new Error('runtime soak acceptance thresholds were not met'), { result });
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let runtimeMeta;
  if (args.runtime === 'source') {
    const packageMeta = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const buildId = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    runtimeMeta = {
      schemaVersion: 1,
      name: packageMeta.name,
      version: packageMeta.version,
      buildId,
      builtAt: new Date().toISOString(),
      channel: 'internal-source',
    };
  } else {
    const runtimeMetaPath = path.join(args.distServer, 'runtime-meta.json');
    if (!existsSync(runtimeMetaPath)) throw new Error(`Missing runtime metadata: ${runtimeMetaPath}`);
    runtimeMeta = JSON.parse(await fs.readFile(runtimeMetaPath, 'utf8'));
  }
  const runsRoot = path.join(root, '.codex-run');
  const runRoot = path.join(runsRoot, `runtime-${args.runtime}-${args.mode}-${Date.now()}`);
  await fs.mkdir(runRoot, { recursive: true });
  let result;
  try {
    result = args.mode === 'soak' ? await runSoak(args, runRoot, runtimeMeta) : await runLifecycle(args, runRoot, runtimeMeta);
    await checkSqlite(path.join(runRoot, 'profile', 'data', 'lumi.db'));
    result.sqliteIntegrity = true;
    result.foreignKeyViolations = 0;
  } catch (error) {
    result = error.result || { mode: args.mode, runtimeKind: args.runtime, ok: false, buildId: runtimeMeta.buildId, version: runtimeMeta.version, error: error.message, completedAt: new Date().toISOString() };
    throw error;
  } finally {
    if (args.ttsFixtureDir) await scrubStagedTtsFixture(runRoot);
    if (result) {
      const outputDir = path.join(root, 'artifacts', 'runtime-reliability');
      await fs.mkdir(outputDir, { recursive: true });
      const outputName = args.runtime === 'packaged' ? `${args.mode}.json` : `${args.mode}-source.json`;
      await fs.writeFile(path.join(outputDir, outputName), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result, null, 2));
    }
    if (!args.keep && result?.ok && path.resolve(runRoot).startsWith(`${path.resolve(runsRoot)}${path.sep}`)) {
      await fs.rm(runRoot, { recursive: true, force: true });
    } else {
      console.log(`[runtime-reliability] logs kept at ${runRoot}`);
    }
  }
}

main().catch(error => {
  console.error(`[runtime-reliability] ${error.message}`);
  process.exit(1);
});
