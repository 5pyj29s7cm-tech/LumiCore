import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

function parseArgs(argv) {
  const args = {
    mode: 'lifecycle',
    distServer: path.join(root, 'desktop-resources', 'dist-server'),
    iterations: 50,
    durationHours: 24,
    pollMs: 30_000,
    timeoutMs: 45_000,
    baselineMs: Number(process.env.LUMI_COLD_START_BASELINE_MS || 0),
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--mode') args.mode = argv[++i];
    else if (value === '--dist-server') args.distServer = path.resolve(argv[++i]);
    else if (value === '--iterations') args.iterations = Number(argv[++i]);
    else if (value === '--duration-hours') args.durationHours = Number(argv[++i]);
    else if (value === '--poll-ms') args.pollMs = Number(argv[++i]);
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (value === '--baseline-ms') args.baselineMs = Number(argv[++i]);
    else if (value === '--keep') args.keep = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!['lifecycle', 'soak'].includes(args.mode)) throw new Error(`Unsupported mode: ${args.mode}`);
  if (args.iterations < 1 || args.durationHours <= 0 || args.pollMs < 100) throw new Error('Invalid reliability test limits');
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

async function waitForHealth(baseUrl, child, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`backend exited early with code ${child.exitCode ?? child.signalCode}`);
    try {
      const health = await fetchJson(`${baseUrl}/health`, 2000);
      if (health?.runtime?.version && health.runtime.version !== '0.0.0') return health;
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

async function startRuntime(args, runRoot, logPrefix) {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePath = path.join(args.distServer, nodeName);
  const entryPath = path.join(args.distServer, 'entry.cjs');
  if (!existsSync(nodePath) || !existsSync(entryPath)) throw new Error(`Packaged runtime missing under ${args.distServer}`);
  const port = await freePort();
  const stdoutPath = path.join(runRoot, `${logPrefix}.out.log`);
  const stderrPath = path.join(runRoot, `${logPrefix}.err.log`);
  const stdout = await fs.open(stdoutPath, 'a');
  const stderr = await fs.open(stderrPath, 'a');
  const dataRoot = path.join(runRoot, 'profile');
  const home = path.join(runRoot, 'home');
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const child = spawn(nodePath, [entryPath], {
    cwd: args.distServer,
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
      HOME: home,
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
    const runtime = await startRuntime(args, runRoot, `lifecycle-${String(index + 1).padStart(3, '0')}`);
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
  const result = { mode: 'lifecycle', ok: targetMs === null || p95Ms <= targetMs, buildId: runtimeMeta.buildId, version: runtimeMeta.version, iterations: args.iterations, startupMs, p95Ms, baselineMs: args.baselineMs || null, targetMs, orphanProcesses: 0, completedAt: new Date().toISOString() };
  if (!result.ok) throw Object.assign(new Error(`cold-start P95 ${p95Ms} ms exceeds 75% baseline target ${targetMs} ms`), { result });
  return result;
}

async function runSoak(args, runRoot, runtimeMeta) {
  const runtime = await startRuntime(args, runRoot, 'soak');
  let started = 0;
  let deadline = 0;
  let polls = 0;
  try {
    await waitForHealth(runtime.baseUrl, runtime.child, args.timeoutMs);
    started = Date.now();
    deadline = started + args.durationHours * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) throw new Error(`backend restarted/exited with ${runtime.child.exitCode ?? runtime.child.signalCode}`);
      const [health, mcp] = await Promise.all([fetchJson(`${runtime.baseUrl}/health`), fetchJson(`${runtime.baseUrl}/mcp/health`)]);
      if (health.status !== 'ok' || health.database?.dirty !== false || health.runtime?.buildId !== runtimeMeta.buildId) throw new Error('health or database invariant failed');
      const unhealthy = Object.entries(mcp.servers || {}).filter(([, state]) => Number(state.consecutiveCrashes || 0) > 0 || ['crashed', 'failed', 'restarting'].includes(state.status));
      if (unhealthy.length) throw new Error(`MCP crash state: ${JSON.stringify(unhealthy)}`);
      polls += 1;
      await new Promise(resolve => setTimeout(resolve, Math.min(args.pollMs, Math.max(0, deadline - Date.now()))));
    }
  } finally {
    await stopChild(runtime.child);
    await runtime.stdout.close();
    await runtime.stderr.close();
  }
  const logs = `${await fs.readFile(runtime.stdoutPath, 'utf8')}\n${await fs.readFile(runtime.stderrPath, 'utf8')}`;
  const unhandled = logs.match(/UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|uncaughtException/gi) || [];
  if (unhandled.length) throw new Error(`unhandled runtime exceptions found: ${unhandled.length}`);
  return { mode: 'soak', ok: true, buildId: runtimeMeta.buildId, version: runtimeMeta.version, requestedHours: args.durationHours, elapsedMs: Date.now() - started, polls, backendRestarts: 0, mcpConsecutiveCrashes: 0, databaseDirty: false, unhandledExceptions: 0, completedAt: new Date().toISOString() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeMetaPath = path.join(args.distServer, 'runtime-meta.json');
  if (!existsSync(runtimeMetaPath)) throw new Error(`Missing runtime metadata: ${runtimeMetaPath}`);
  const runtimeMeta = JSON.parse(await fs.readFile(runtimeMetaPath, 'utf8'));
  const runsRoot = path.join(root, '.codex-run');
  const runRoot = path.join(runsRoot, `runtime-${args.mode}-${Date.now()}`);
  await fs.mkdir(runRoot, { recursive: true });
  let result;
  try {
    result = args.mode === 'soak' ? await runSoak(args, runRoot, runtimeMeta) : await runLifecycle(args, runRoot, runtimeMeta);
    await checkSqlite(path.join(runRoot, 'profile', 'data', 'lumi.db'));
    result.sqliteIntegrity = true;
    result.foreignKeyViolations = 0;
  } catch (error) {
    result = error.result || { mode: args.mode, ok: false, buildId: runtimeMeta.buildId, version: runtimeMeta.version, error: error.message, completedAt: new Date().toISOString() };
    throw error;
  } finally {
    if (result) {
      const outputDir = path.join(root, 'artifacts', 'runtime-reliability');
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, `${args.mode}.json`), `${JSON.stringify(result, null, 2)}\n`);
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
