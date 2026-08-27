import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io as connectSocketIo } from 'socket.io-client';
import {
  REQUIRED_FORMAL_DATA_ROOT_DENYLIST,
  portableEvidenceDataRootIdentity,
  portableEvidenceSha256,
  signPortableEvidenceRecord,
  stablePortableEvidenceJson,
} from './portable-external-evidence.mjs';
import { portablePairedFixturePlanSha256 } from './portable-paired-barrier.mjs';
import {
  TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
  TASK_REGRESSION_V2_SCENARIO_IDS,
  TASK_REGRESSION_V2_SCENARIO_PROFILES,
} from './task-regression-truth-v2.mjs';

export const PORTABLE_PAIRED_CONTROLLER_PLAN_KIND = 'lumi.portable-paired-controller-plan';
export const PORTABLE_PAIRED_CONTROLLER_PLAN_SCHEMA_VERSION = 1;
export const PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID = 'control_stop_status_repeat';
export const PORTABLE_PAIRED_CONTROLLER_BASELINE_REVISION =
  '28c08cdafaef83c536150129329c6f8541d13c95';

const LOOPBACK_HOST = '127.0.0.1';
const SHA256_RE = /^[a-f0-9]{64}$/u;
const GIT_REVISION_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ROLE_SET = new Set(['baseline', 'candidate']);
const SAFE_PARENT_ENV = Object.freeze([
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
]);
const SECRET_ENV_RE = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)(?:$|_)/iu;
const CONTROLLER_PHASES = Object.freeze([
  {
    phaseId: 'long_start',
    turnOrdinal: 1,
    text: '这是一个可取消的隔离长任务。请等待后再只给出一句结果，不要调用任何工具。',
    providerWitness: true,
  },
  {
    phaseId: 'stop',
    turnOrdinal: 2,
    text: '停止',
    providerWitness: false,
  },
  {
    phaseId: 'status_after_cancel',
    turnOrdinal: 3,
    text: '你在干啥',
    providerWitness: false,
  },
  {
    phaseId: 'repeat_status',
    turnOrdinal: 4,
    text: '怎么说',
    providerWitness: false,
  },
]);

export class PortablePairedControllerRuntimeError extends Error {
  constructor(code, details = {}, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'PortablePairedControllerRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details, cause) {
  throw new PortablePairedControllerRuntimeError(code, details, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exactKeys(value, allowed, required, code) {
  if (!isPlainObject(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    fail(code, { keys: keys.sort() });
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, code) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) fail(code);
  return selected;
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  if (!SAFE_ROLE_SET.has(role)) fail('portable_paired_controller_role_invalid');
  return role;
}

function normalizeWindowsPath(value) {
  return path.win32.resolve(String(value || '').replaceAll('/', '\\'))
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US');
}

function windowsPathInside(base, candidate) {
  const normalizedBase = normalizeWindowsPath(base);
  const normalizedCandidate = normalizeWindowsPath(candidate);
  return normalizedCandidate === normalizedBase
    || normalizedCandidate.startsWith(`${normalizedBase}\\`);
}

function assertNotFormalDataPath(value) {
  if (process.platform !== 'win32') return;
  if (REQUIRED_FORMAL_DATA_ROOT_DENYLIST.some(root => windowsPathInside(root, value))) {
    fail('portable_paired_controller_formal_data_path_forbidden');
  }
}

function safeDirectory(value, code) {
  const absolute = path.resolve(String(value || ''));
  assertNotFormalDataPath(absolute);
  let metadata;
  try { metadata = fs.lstatSync(absolute); } catch (error) { fail(code, {}, error); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  const canonical = fs.realpathSync.native(absolute);
  assertNotFormalDataPath(canonical);
  return canonical;
}

function safeRegularFile(value, code) {
  const absolute = path.resolve(String(value || ''));
  let metadata;
  try { metadata = fs.lstatSync(absolute); } catch (error) { fail(code, {}, error); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(code);
  const canonical = fs.realpathSync.native(absolute);
  const canonicalMetadata = fs.lstatSync(canonical);
  if (!canonicalMetadata.isFile() || canonicalMetadata.nlink !== 1) fail(code);
  return { absolute, canonical, metadata: canonicalMetadata };
}

function profileSha256() {
  return portableEvidenceSha256({
    kind: 'lumi.task-regression-truth-v2-profile',
    schemaVersion: TASK_REGRESSION_TRUTH_V2_SCHEMA_VERSION,
    scenarioIds: TASK_REGRESSION_V2_SCENARIO_IDS,
    profiles: TASK_REGRESSION_V2_SCENARIO_PROFILES,
  });
}

function normalizeRunNonce(value) {
  const nonce = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{16,96}$/u.test(nonce)) {
    fail('portable_paired_controller_run_nonce_invalid');
  }
  return nonce;
}

export function createPortablePairedControllerFrozenPlan(options = {}) {
  const value = exactKeys(
    options,
    ['runNonce', 'turnMs', 'providerMs', 'passiveStoreMs', 'settleMs', 'startupMs', 'longProviderDelayMs'],
    ['runNonce'],
    'portable_paired_controller_plan_options_invalid',
  );
  const runNonce = normalizeRunNonce(value.runNonce);
  const timeoutPolicy = {
    turnMs: boundedInteger(value.turnMs, 30_000, 1_000, 120_000, 'portable_paired_controller_timeout_invalid'),
    providerMs: boundedInteger(value.providerMs, 12_000, 1_000, 120_000, 'portable_paired_controller_timeout_invalid'),
    passiveStoreMs: boundedInteger(value.passiveStoreMs, 15_000, 1_000, 120_000, 'portable_paired_controller_timeout_invalid'),
    settleMs: boundedInteger(value.settleMs, 150, 0, 10_000, 'portable_paired_controller_timeout_invalid'),
  };
  const executionPolicy = {
    startupMs: boundedInteger(value.startupMs, 120_000, 10_000, 300_000, 'portable_paired_controller_timeout_invalid'),
    longProviderDelayMs: boundedInteger(
      value.longProviderDelayMs,
      15_000,
      timeoutPolicy.providerMs + 1,
      120_000,
      'portable_paired_controller_delay_invalid',
    ),
  };
  const phases = CONTROLLER_PHASES.map(phase => ({
    scenarioId: PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID,
    phaseId: phase.phaseId,
    turnOrdinal: phase.turnOrdinal,
    unmarkedUserTextSha256: portableEvidenceSha256(phase.text),
    expectedToolName: '',
    requirements: {
      passiveStore: true,
      providerWitness: phase.providerWitness,
    },
  }));
  const fixture = {
    logicalPath: '~/Desktop/portable-control-sentinel.txt',
    content: `PORTABLE_CONTROL_SENTINEL_${runNonce}`,
  };
  const fixtureProjection = {
    logicalPath: fixture.logicalPath,
    contentSha256: portableEvidenceSha256(fixture.content),
    byteLength: Buffer.byteLength(fixture.content, 'utf8'),
  };
  const fixturePlanSha256 = portablePairedFixturePlanSha256({ phases });
  const coverageSha256 = portableEvidenceSha256(phases);
  const core = {
    kind: PORTABLE_PAIRED_CONTROLLER_PLAN_KIND,
    schemaVersion: PORTABLE_PAIRED_CONTROLLER_PLAN_SCHEMA_VERSION,
    scenarioId: PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID,
    scenarioCoverage: 'complete_four_phase_truth_v2_profile',
    profileSha256: profileSha256(),
    fixturePlanSha256,
    fixturePayloadSha256: portableEvidenceSha256(fixtureProjection),
    timeoutPolicySha256: portableEvidenceSha256(timeoutPolicy),
    coverageSha256,
    timeoutPolicy,
    executionPolicy,
    phases,
    fixture: fixtureProjection,
  };
  const result = {
    ...core,
    planSha256: portableEvidenceSha256(core),
  };
  Object.defineProperties(result, {
    phaseInputs: {
      enumerable: false,
      value: Object.freeze(Object.fromEntries(CONTROLLER_PHASES.map(phase => [
        phase.phaseId,
        phase.text,
      ]))),
    },
    fixtureContent: { enumerable: false, value: fixture.content },
    toJSON: { enumerable: false, value: () => coreWithDigest(result) },
  });
  return deepFreeze(result);
}

function coreWithDigest(plan) {
  return Object.fromEntries(Object.entries(plan));
}

function assertLoopbackProviderBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { fail('portable_paired_controller_provider_url_invalid'); }
  if (parsed.protocol !== 'http:'
    || parsed.hostname !== LOOPBACK_HOST
    || !parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password) {
    fail('portable_paired_controller_provider_url_invalid');
  }
  return parsed.origin;
}

export function buildPortablePairedBackendEnvironment(input) {
  const value = exactKeys(
    input,
    ['role', 'sandbox', 'port', 'providerBaseUrl'],
    ['role', 'sandbox', 'port', 'providerBaseUrl'],
    'portable_paired_controller_environment_invalid',
  );
  const role = normalizeRole(value.role);
  const port = boundedInteger(value.port, undefined, 1, 65_535, 'portable_paired_controller_port_invalid');
  const providerBaseUrl = assertLoopbackProviderBaseUrl(value.providerBaseUrl);
  const sandbox = value.sandbox;
  for (const field of ['home', 'appData', 'localAppData', 'temporary', 'dataRoot', 'logs', 'dotenvPath', 'emptyDist']) {
    if (!path.isAbsolute(String(sandbox?.[field] || ''))) fail('portable_paired_controller_environment_invalid');
    assertNotFormalDataPath(sandbox[field]);
  }
  const env = {};
  for (const key of SAFE_PARENT_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = process.env.PATH || process.env.Path || '';
  env.Path = process.env.Path || process.env.PATH || '';
  env.HOME = sandbox.home;
  env.USERPROFILE = sandbox.home;
  env.APPDATA = sandbox.appData;
  env.LOCALAPPDATA = sandbox.localAppData;
  env.TEMP = sandbox.temporary;
  env.TMP = sandbox.temporary;
  env.NODE_ENV = 'production';
  env.HOST = LOOPBACK_HOST;
  env.PORT = String(port);
  env.LUMI_DATA_DIR = sandbox.dataRoot;
  env.LUMI_LOG_FILE = path.join(sandbox.logs, 'backend.log');
  env.LUMI_RUNTIME_META_FILE = path.join(sandbox.logs, 'runtime-meta.json');
  env.LUMI_FRONTEND_DIST = sandbox.emptyDist;
  env.LUMI_DESKTOP = '0';
  env.LUMI_AUTO_KILL_OLD_PROCESS = '0';
  env.LUMI_ENFORCE_DATA_ROOT_LEASE = '1';
  env.LUMI_DISABLE_QWEN_FILE_STT = '1';
  env.DISABLE_HMR = 'true';
  env.DOTENV_CONFIG_PATH = sandbox.dotenvPath;
  env.DOTENV_CONFIG_QUIET = 'true';
  env.OPENAI_API_KEY = `portable-paired-local-${role}`;
  env.OPENAI_BASE_URL = `${providerBaseUrl}/v1`;
  env.OPENAI_MODEL = 'lumi-portable-paired-stub-v1';
  const ownedSecrets = new Set(['OPENAI_API_KEY']);
  if (Object.keys(env).some(key => SECRET_ENV_RE.test(key) && !ownedSecrets.has(key))) {
    fail('portable_paired_controller_environment_secret_invalid');
  }
  for (const forbidden of [
    'LUMI_TASK_REGRESSION_EVIDENCE_MODE',
    'LUMI_TASK_REGRESSION_ACCEPTANCE_RUN_ID',
    'LUMI_TASK_REGRESSION_PROOF_SHA256',
    'LUMI_TASK_REGRESSION_DESKTOP_RELAY_PROOF_SHA256',
  ]) {
    if (Object.hasOwn(env, forbidden)) fail('portable_paired_controller_candidate_endpoint_env_forbidden');
  }
  return env;
}

export function buildPortablePairedBackendLaunch(options) {
  const role = normalizeRole(options?.role);
  const sandboxRoot = safeDirectory(
    options?.sandbox?.root,
    'portable_paired_controller_sandbox_root_invalid',
  );
  const dotenvIdentity = safeRegularFile(
    options?.sandbox?.dotenvPath,
    'portable_paired_controller_dotenv_invalid',
  );
  const relativeDotenv = path.relative(sandboxRoot, dotenvIdentity.canonical);
  if (
    !relativeDotenv
    || relativeDotenv.startsWith('..')
    || path.isAbsolute(relativeDotenv)
    || dotenvIdentity.metadata.size !== 0
  ) fail('portable_paired_controller_dotenv_invalid');
  const entryIdentity = safeRegularFile(
    options?.target?.entry,
    'portable_paired_controller_server_entry_invalid',
  );
  const loaderIdentity = safeRegularFile(
    options?.target?.tsxLoader,
    'portable_paired_controller_target_dependencies_missing',
  );
  const env = buildPortablePairedBackendEnvironment({
    role,
    sandbox: options.sandbox,
    port: options.port,
    providerBaseUrl: options.providerBaseUrl,
  });
  if (fs.realpathSync.native(path.resolve(env.DOTENV_CONFIG_PATH)) !== dotenvIdentity.canonical) {
    fail('portable_paired_controller_dotenv_invalid');
  }
  return {
    argv: [
      '--import',
      pathToFileURL(loaderIdentity.canonical).href,
      entryIdentity.canonical,
    ],
    cwd: sandboxRoot,
    env,
    isolation: {
      sandboxCwd: true,
      worktreeCwdUsed: false,
      ownedEmptyDotenv: true,
      cwdSha256: portableEvidenceSha256(sandboxRoot),
      dotenvConfigPathSha256: portableEvidenceSha256(dotenvIdentity.canonical),
    },
  };
}

function git(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    fail('portable_paired_controller_git_failed', { args }, error);
  }
}

export function inspectPortablePairedWorktree(input) {
  const value = exactKeys(
    input,
    ['role', 'worktree', 'expectedRevision'],
    ['role', 'worktree'],
    'portable_paired_controller_worktree_input_invalid',
  );
  const role = normalizeRole(value.role);
  const root = safeDirectory(value.worktree, 'portable_paired_controller_worktree_invalid');
  const repositoryRoot = safeDirectory(
    git(root, ['rev-parse', '--show-toplevel']),
    'portable_paired_controller_worktree_invalid',
  );
  if (repositoryRoot !== root) fail('portable_paired_controller_worktree_root_required');
  const revision = git(root, ['rev-parse', 'HEAD']).toLowerCase();
  if (!GIT_REVISION_RE.test(revision)) fail('portable_paired_controller_revision_invalid');
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (role === 'baseline') {
    const expectedRevision = String(value.expectedRevision || PORTABLE_PAIRED_CONTROLLER_BASELINE_REVISION)
      .trim().toLowerCase();
    if (revision !== expectedRevision) {
      fail('portable_paired_controller_baseline_revision_mismatch', { revision, expectedRevision });
    }
    if (status) fail('portable_paired_controller_clean_baseline_required');
  }
  const packageIdentity = safeRegularFile(
    path.join(root, 'package.json'),
    'portable_paired_controller_package_invalid',
  );
  const entryCandidates = role === 'candidate'
    ? [path.join(root, 'server', 'runtime', 'server_entry.ts'), path.join(root, 'server.ts')]
    : [path.join(root, 'server.ts'), path.join(root, 'server', 'runtime', 'server_entry.ts')];
  const entryIdentity = entryCandidates.map(candidate => {
    try { return safeRegularFile(candidate, 'portable_paired_controller_server_entry_invalid'); } catch { return null; }
  }).find(Boolean);
  if (!entryIdentity) fail('portable_paired_controller_server_entry_invalid');
  const targetRequire = createRequire(packageIdentity.canonical);
  let tsxLoader;
  try {
    tsxLoader = targetRequire.resolve('tsx');
    targetRequire.resolve('sqlite3');
    targetRequire.resolve('socket.io');
    targetRequire.resolve('openai');
  } catch (error) {
    fail('portable_paired_controller_target_dependencies_missing', { role }, error);
  }
  return deepFreeze({
    role,
    root,
    revision,
    clean: status.length === 0,
    statusSha256: portableEvidenceSha256(status),
    packagePath: packageIdentity.canonical,
    entry: entryIdentity.canonical,
    entrySha256: portableEvidenceSha256(fs.readFileSync(entryIdentity.canonical)),
    tsxLoader,
  });
}

export function createPortablePairedSandbox(options = {}) {
  const value = exactKeys(options, ['tempBase', 'plan'], ['plan'], 'portable_paired_controller_sandbox_invalid');
  const tempBase = safeDirectory(value.tempBase || os.tmpdir(), 'portable_paired_controller_temp_base_invalid');
  const root = fs.mkdtempSync(path.join(tempBase, 'lumi-portable-paired-controller-'));
  const sides = {};
  try {
    for (const role of ['baseline', 'candidate']) {
      const sideRoot = path.join(root, role);
      const home = path.join(sideRoot, 'home');
      const appData = path.join(sideRoot, 'appdata', 'roaming');
      const localAppData = path.join(sideRoot, 'appdata', 'local');
      const temporary = path.join(sideRoot, 'tmp');
      const dataRoot = path.join(sideRoot, 'profile');
      const logs = path.join(sideRoot, 'logs');
      const emptyDist = path.join(sideRoot, 'empty-dist');
      for (const directory of [home, appData, localAppData, temporary, dataRoot, logs, emptyDist, path.join(home, 'Desktop')]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const dotenvPath = path.join(sideRoot, 'empty.env');
      fs.writeFileSync(dotenvPath, '', { encoding: 'utf8', flag: 'wx' });
      const fixturePath = path.join(home, 'Desktop', 'portable-control-sentinel.txt');
      fs.writeFileSync(fixturePath, value.plan.fixtureContent, { encoding: 'utf8', flag: 'wx' });
      const dataRootIdentity = portableEvidenceDataRootIdentity(dataRoot);
      sides[role] = {
        role,
        root: sideRoot,
        home,
        appData,
        localAppData,
        temporary,
        dataRoot,
        logs,
        emptyDist,
        dotenvPath,
        fixturePath,
        dataRootIdentity,
      };
    }
    if (sides.baseline.dataRootIdentity.sha256 === sides.candidate.dataRootIdentity.sha256) {
      fail('portable_paired_controller_distinct_data_roots_required');
    }
    return { root, tempBase, sides };
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export function removePortablePairedSandbox(sandbox) {
  const root = path.resolve(String(sandbox?.root || ''));
  const tempBase = path.resolve(String(sandbox?.tempBase || ''));
  const relative = path.relative(tempBase, root);
  if (!relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || !path.basename(root).startsWith('lumi-portable-paired-controller-')) {
    fail('portable_paired_controller_cleanup_boundary_invalid');
  }
  fs.rmSync(root, { recursive: true, force: true });
  return !fs.existsSync(root);
}

export async function reservePortableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  if (!port) fail('portable_paired_controller_port_reservation_failed');
  return port;
}

function compactLog(previous, chunk) {
  const next = `${previous}${String(chunk || '')}`;
  return next.length <= 32_768 ? next : next.slice(-32_768);
}

async function fetchJsonUrl(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
  try {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(url, {
      method: options.method || 'GET', headers, body, signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { rawTextSha256: portableEvidenceSha256(text) }; }
    }
    if (!response.ok) {
      fail('portable_paired_controller_http_failed', {
        status: response.status,
        pathname: new URL(url).pathname,
        responseKeys: isPlainObject(parsed) ? Object.keys(parsed).sort() : [],
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof PortablePairedControllerRuntimeError) throw error;
    fail('portable_paired_controller_http_failed', { pathname: new URL(url).pathname }, error);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBackend(runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      fail('portable_paired_controller_backend_exited', {
        role: runtime.role,
        exitCode: runtime.child.exitCode,
        stderrSha256: portableEvidenceSha256(runtime.stderr),
      });
    }
    try {
      const health = await fetchJsonUrl(`${runtime.baseUrl}/api/health`, { timeoutMs: 1_500 });
      if (health?.status === 'ok' || health?.status === 'degraded') return health;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fail('portable_paired_controller_backend_start_timeout', {
    role: runtime.role,
    stderrSha256: portableEvidenceSha256(runtime.stderr),
  });
}

export async function startPortablePairedBackend(options) {
  const role = normalizeRole(options?.role);
  const target = options?.target;
  const port = options?.port || await reservePortableLoopbackPort();
  const launch = buildPortablePairedBackendLaunch({
    role,
    target,
    sandbox: options.sandbox,
    port,
    providerBaseUrl: options?.providerBaseUrl,
  });
  const child = spawn(process.execPath, launch.argv, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const runtime = {
    role,
    target,
    port,
    origin: `http://${LOOPBACK_HOST}:${port}`,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    child,
    stdout: '',
    stderr: '',
    startedAt: new Date().toISOString(),
    launchIsolation: launch.isolation,
  };
  child.stdout?.on('data', chunk => { runtime.stdout = compactLog(runtime.stdout, chunk); });
  child.stderr?.on('data', chunk => { runtime.stderr = compactLog(runtime.stderr, chunk); });
  child.on('error', error => { runtime.stderr = compactLog(runtime.stderr, error?.stack || error?.message); });
  try {
    runtime.health = await waitForBackend(runtime, options?.startupMs || 120_000);
    const version = await fetchJsonUrl(`${runtime.baseUrl}/api/version`, { timeoutMs: 5_000 });
    if (Number(version?.pid) !== child.pid || !Number.isFinite(Date.parse(String(version?.startedAt || '')))) {
      fail('portable_paired_controller_backend_identity_invalid', { role });
    }
    runtime.processIdentity = {
      pid: Number(version.pid),
      startedAt: String(version.startedAt),
      identitySha256: portableEvidenceSha256([Number(version.pid), String(version.startedAt)]),
    };
    return runtime;
  } catch (error) {
    await stopPortablePairedBackend(runtime).catch(() => {});
    throw error;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const finish = value => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    child.once('exit', onExit);
  });
}

export async function stopPortablePairedBackend(runtime) {
  if (!runtime?.child) return true;
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return true;
  runtime.child.kill('SIGTERM');
  if (await waitForChildExit(runtime.child, 5_000)) return true;
  runtime.child.kill('SIGKILL');
  return waitForChildExit(runtime.child, 5_000);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map(item => typeof item === 'string' ? item : String(item?.text || item?.content || '')).join('\n');
}

function writeOpenAiTextResponse(response, body, text) {
  const model = String(body?.model || 'lumi-portable-paired-stub-v1');
  const id = `chatcmpl_${crypto.randomBytes(8).toString('hex')}`;
  if (body?.stream === true) {
    const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    send({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    });
    send({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function providerCaptureProjection(raw, body, role, receivedAt) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const latestUserText = messageText(
    [...messages].reverse().find(message => message?.role === 'user')?.content,
  );
  return {
    role,
    receivedAt,
    rawPayloadSha256: portableEvidenceSha256(raw),
    messageCount: messages.length,
    messagesSha256: portableEvidenceSha256(messages),
    model: String(body?.model || ''),
    stream: body?.stream === true,
    declaredTools: [...new Set((Array.isArray(body?.tools) ? body.tools : [])
      .map(tool => String(tool?.function?.name || tool?.name || '').trim())
      .filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    latestUserTextSha256: portableEvidenceSha256(latestUserText),
  };
}

function providerLatestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messageText([...messages].reverse().find(message => message?.role === 'user')?.content);
}

function writePortableClassifierResponse(response, body) {
  writeOpenAiTextResponse(
    response,
    body,
    '{"category":"command","confidence":0.99,"entities":{}}',
  );
}

export async function startPortablePairedProviderStub(options) {
  const role = normalizeRole(options?.role);
  const sockets = new Set();
  const timers = new Set();
  const requests = [];
  const protocolViolations = [];
  const waiters = new Set();
  let armed = null;
  const notifyWaiters = () => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate()) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${LOOPBACK_HOST}`);
    if (request.method === 'GET' && requestUrl.pathname === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'lumi-portable-paired-stub-v1', object: 'model' }],
      }));
      return;
    }
    if (request.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk);
    });
    request.on('end', () => {
      if (bytes > 4 * 1024 * 1024) {
        response.writeHead(413, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'request too large' } }));
        return;
      }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      const receivedAt = new Date().toISOString();
      const capture = providerCaptureProjection(raw, body, role, receivedAt);
      capture.captureOrdinal = requests.length + 1;
      capture.phaseId = '';
      capture.bindingDigest = '';
      capture.auxiliary = true;
      requests.push(capture);
      if (!armed) {
        capture.preArm = true;
        writeOpenAiTextResponse(response, body, 'portable provider not armed');
        notifyWaiters();
        return;
      }
      const payloadText = raw.toString('utf8');
      const latestUserText = providerLatestUserText(body);
      const markedCurrentPhases = armed.kit.manifest.phases.filter(
        phase => latestUserText.includes(phase.providerMarker),
      );
      const unmarkedCurrentPhases = markedCurrentPhases.length === 0
        ? armed.kit.manifest.phases.filter(
          phase => portableEvidenceSha256(latestUserText) === phase.unmarkedUserTextSha256,
        )
        : [];
      const currentPhases = markedCurrentPhases.length > 0
        ? markedCurrentPhases
        : unmarkedCurrentPhases;
      if (currentPhases.length === 0) {
        if (body?.stream === true) {
          writeOpenAiTextResponse(response, body, 'portable auxiliary response');
        } else {
          writePortableClassifierResponse(response, body);
        }
        notifyWaiters();
        return;
      }
      if (currentPhases.length !== 1) {
        protocolViolations.push({
          code: 'provider_current_turn_marker_cardinality_invalid',
          rawPayloadSha256: capture.rawPayloadSha256,
          matchedBindingDigests: currentPhases.map(phase => phase.bindingDigest),
        });
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'portable provider marker invalid' } }));
        notifyWaiters();
        return;
      }
      const phase = currentPhases[0];
      capture.phaseId = phase.phaseId;
      capture.bindingDigest = phase.bindingDigest;
      capture.auxiliary = false;
      capture.providerStage = body?.stream === true ? 'answer' : 'intent_classifier';
      if (phase.requirements?.providerWitness === true) {
        try {
          const matched = armed.kit.hooks.observeProviderPayload({ role, payload: raw });
          if (matched.bindingDigest !== phase.bindingDigest) {
            fail('portable_paired_controller_provider_binding_mismatch');
          }
          const providerRequestNonce = `provider_${role}_${capture.captureOrdinal}_${crypto.randomBytes(12).toString('hex')}`;
          armed.kit.collector.captureProviderRequest(matched.selector, raw, { providerRequestNonce });
          capture.providerRequestNonceSha256 = portableEvidenceSha256(providerRequestNonce);
        } catch (error) {
          protocolViolations.push({
            code: String(error?.code || 'provider_capture_failed'),
            rawPayloadSha256: capture.rawPayloadSha256,
          });
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'portable provider capture failed' } }));
          notifyWaiters();
          return;
        }
      }
      if (phase.phaseId !== 'long_start') {
        capture.unexpectedModelInvocation = true;
        if (body?.stream === true) {
          writeOpenAiTextResponse(response, body, 'unexpected control-path model invocation');
        } else {
          writePortableClassifierResponse(response, body);
        }
        notifyWaiters();
        return;
      }
      if (body?.stream !== true) {
        capture.deliveredAt = new Date().toISOString();
        writePortableClassifierResponse(response, body);
        notifyWaiters();
        return;
      }
      capture.scheduledDelayMs = armed.plan.executionPolicy.longProviderDelayMs;
      const deliver = () => {
        timers.delete(timer);
        if (response.destroyed || response.writableEnded) return;
        capture.deliveredAt = new Date().toISOString();
        writeOpenAiTextResponse(response, body, 'portable long task completed without cancellation');
        notifyWaiters();
      };
      const timer = setTimeout(deliver, capture.scheduledDelayMs);
      timers.add(timer);
      const markAborted = () => {
        if (capture.deliveredAt || capture.abortedAt) return;
        clearTimeout(timer);
        timers.delete(timer);
        capture.abortedAt = new Date().toISOString();
        notifyWaiters();
      };
      request.once('aborted', markAborted);
      response.once('close', markAborted);
      notifyWaiters();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) fail('portable_paired_controller_provider_start_failed');
  return {
    role,
    port,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    requests,
    protocolViolations,
    arm(input) {
      if (armed) fail('portable_paired_controller_provider_already_armed');
      if (input?.kit?.role !== role || input?.plan?.kind !== PORTABLE_PAIRED_CONTROLLER_PLAN_KIND) {
        fail('portable_paired_controller_provider_arm_invalid');
      }
      armed = { kit: input.kit, plan: input.plan };
    },
    waitForPhase(phaseId, timeoutMs) {
      const predicate = () => requests.some(item => item.phaseId === phaseId);
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new PortablePairedControllerRuntimeError(
            'portable_paired_controller_provider_phase_timeout',
            { role, phaseId },
          ));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    waitForDelayedPhase(phaseId, timeoutMs) {
      const predicate = () => requests.some(item => (
        item.phaseId === phaseId
        && item.providerStage === 'answer'
        && item.scheduledDelayMs > 0
      ));
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new PortablePairedControllerRuntimeError(
            'portable_paired_controller_provider_delayed_phase_timeout',
            { role, phaseId },
          ));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new PortablePairedControllerRuntimeError('portable_paired_controller_provider_closed'));
      }
      waiters.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function registerPortablePairedUser(runtime, role) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const response = await fetchJsonUrl(`${runtime.baseUrl}/api/auth/register`, {
    method: 'POST',
    body: {
      username: `portable_${role}_${nonce}`,
      password: `Pp!${crypto.randomBytes(18).toString('base64url')}`,
      phone: `199${crypto.randomInt(10_000_000, 99_999_999)}`,
    },
    timeoutMs: 20_000,
  });
  const token = String(response?.token || '');
  const userId = String(response?.user?.uid || '');
  if (!token || !userId) fail('portable_paired_controller_registration_invalid', { role });
  return { token, userId };
}

export async function configurePortablePairedModel(runtime, token) {
  const result = await fetchJsonUrl(`${runtime.baseUrl}/api/preferences/llm`, {
    method: 'PUT',
    token,
    body: {
      provider: 'openai',
      model: 'lumi-portable-paired-stub-v1',
      models: { openai: 'lumi-portable-paired-stub-v1' },
      selectionMode: 'pinned',
      fallbackCandidates: [],
      allowCloudFallback: false,
    },
    timeoutMs: 10_000,
  });
  if (result?.provider !== 'openai'
    || result?.model !== 'lumi-portable-paired-stub-v1'
    || result?.selectionMode !== 'pinned') {
    fail('portable_paired_controller_model_preference_invalid', { role: runtime.role });
  }
  return {
    provider: result.provider,
    model: result.model,
    selectionMode: result.selectionMode,
  };
}

export async function createPortablePairedConversation(runtime, token) {
  const result = await fetchJsonUrl(`${runtime.baseUrl}/api/conversations/new`, {
    method: 'POST', token, body: { agentId: 'lumi' }, timeoutMs: 10_000,
  });
  const conversationId = String(result?.conversation?.id || '');
  if (!conversationId) fail('portable_paired_controller_conversation_invalid', { role: runtime.role });
  return conversationId;
}

function projectSocketEvent(event, payload, sequence) {
  const text = String(payload?.text || payload?.message || payload?.response || '');
  return {
    sequence,
    event: String(event || ''),
    observedAt: new Date().toISOString(),
    requestId: String(payload?.requestId || ''),
    targetRequestId: String(payload?.targetRequestId || ''),
    taskId: String(payload?.taskId || ''),
    status: String(payload?.status || ''),
    reason: String(payload?.reason || ''),
    controlIntent: String(payload?.controlIntent || ''),
    finalized: payload?.finalized === true,
    blocked: payload?.blocked === true,
    textCharCount: text.length,
    textSha256: portableEvidenceSha256(text),
  };
}

export async function createPortablePairedSocketSession(options) {
  const runtime = options?.runtime;
  const token = String(options?.token || '');
  const turnMs = boundedInteger(options?.turnMs, 30_000, 1_000, 120_000, 'portable_paired_controller_timeout_invalid');
  if (!runtime?.origin || !token) fail('portable_paired_controller_socket_options_invalid');
  const socket = connectSocketIo(runtime.origin, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: Math.min(turnMs, 20_000),
  });
  const events = [];
  const turns = new Map();
  let sequence = 0;
  socket.onAny((event, payload) => {
    sequence += 1;
    const projected = projectSocketEvent(event, payload, sequence);
    events.push(projected);
    if (!['agent:response', 'agent:error'].includes(event)) return;
    const requestId = String(payload?.requestId || '');
    const turn = turns.get(requestId);
    if (!turn || turn.terminal) return;
    turn.terminal = {
      ...projected,
      rawText: String(payload?.text || payload?.message || payload?.response || ''),
    };
    clearTimeout(turn.timer);
    turn.resolve(turn.terminal);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PortablePairedControllerRuntimeError(
      'portable_paired_controller_socket_connect_timeout',
      { role: runtime.role },
    )), Math.min(turnMs, 20_000));
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      reject(new PortablePairedControllerRuntimeError(
        'portable_paired_controller_socket_connect_failed',
        { role: runtime.role, errorName: String(error?.name || '') },
      ));
    });
  });
  return {
    role: runtime.role,
    events,
    startTurn(input) {
      const requestId = String(input?.requestId || '').trim();
      const conversationId = String(input?.conversationId || '').trim();
      const text = String(input?.text || '');
      if (!requestId || !conversationId || !text || turns.has(requestId)) {
        fail('portable_paired_controller_turn_input_invalid', { role: runtime.role });
      }
      let resolveTerminal;
      let rejectTerminal;
      const terminalPromise = new Promise((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      });
      const turn = {
        requestId,
        terminal: null,
        resolve: resolveTerminal,
        reject: rejectTerminal,
        timer: setTimeout(() => {
          turns.delete(requestId);
          rejectTerminal(new PortablePairedControllerRuntimeError(
            'portable_paired_controller_turn_timeout',
            { role: runtime.role, requestId },
          ));
        }, input?.timeoutMs || turnMs),
      };
      turns.set(requestId, turn);
      const ackPromise = new Promise((resolve, reject) => {
        const ackTimer = setTimeout(() => reject(new PortablePairedControllerRuntimeError(
          'portable_paired_controller_ack_timeout',
          { role: runtime.role, requestId },
        )), Math.min(input?.timeoutMs || turnMs, 15_000));
        socket.emit('agent:chat', {
          text,
          history: [],
          personalityId: 'lumi',
          agentId: 'lumi',
          domain: 'personal',
          mode: 'assistant',
          operationMode: 'assistant',
          source: 'portable-paired-controller',
          requestId,
          conversationId,
        }, ack => {
          clearTimeout(ackTimer);
          const normalized = {
            ok: ack?.ok === true,
            requestId: String(ack?.requestId || ''),
            error: String(ack?.error || ''),
          };
          if (!normalized.ok || normalized.requestId !== requestId) {
            reject(new PortablePairedControllerRuntimeError(
              'portable_paired_controller_ack_invalid',
              { role: runtime.role, requestId },
            ));
            return;
          }
          resolve(normalized);
        });
      });
      return {
        requestId,
        ackPromise,
        async done() {
          const terminal = await terminalPromise;
          turns.delete(requestId);
          return terminal;
        },
      };
    },
    async runTurn(input) {
      const turn = this.startTurn(input);
      const ack = await turn.ackPromise;
      const terminal = await turn.done();
      return { requestId: turn.requestId, ack, terminal };
    },
    close() {
      for (const turn of turns.values()) {
        clearTimeout(turn.timer);
        turn.reject(new PortablePairedControllerRuntimeError(
          'portable_paired_controller_socket_closed',
          { role: runtime.role, requestId: turn.requestId },
        ));
      }
      turns.clear();
      socket.disconnect();
    },
  };
}

export function capturePortableFilesystemFixture(filename) {
  const identity = safeRegularFile(filename, 'portable_paired_controller_fixture_invalid');
  const bytes = fs.readFileSync(identity.canonical);
  return {
    contentSha256: portableEvidenceSha256(bytes),
    byteLength: bytes.length,
    modifiedAt: identity.metadata.mtime.toISOString(),
    device: identity.metadata.dev,
    inode: identity.metadata.ino,
    linkCount: identity.metadata.nlink,
    pathSha256: portableEvidenceSha256(identity.canonical),
  };
}

export function createSignedPortableFilesystemWitness(input, hmacKey) {
  const before = input?.before;
  const after = input?.after;
  const unchanged = before?.contentSha256 === after?.contentSha256
    && before?.byteLength === after?.byteLength
    && before?.device === after?.device
    && before?.inode === after?.inode
    && before?.linkCount === 1
    && after?.linkCount === 1;
  return signPortableEvidenceRecord({
    kind: 'lumi.portable-paired-filesystem-witness',
    schemaVersion: 1,
    role: normalizeRole(input?.role),
    runId: String(input?.runId || ''),
    fixturePlanSha256: String(input?.fixturePlanSha256 || ''),
    fixturePayloadSha256: String(input?.fixturePayloadSha256 || ''),
    logicalPathSha256: portableEvidenceSha256(String(input?.logicalPath || '')),
    before,
    after,
    unchanged,
    observation: 'sealed_fixture_identity_before_and_after_full_scenario',
  }, hmacKey);
}

export function createSignedPortableSocketWitness(input, hmacKey) {
  const events = Array.isArray(input?.events) ? input.events : [];
  return signPortableEvidenceRecord({
    kind: 'lumi.portable-paired-socket-witness',
    schemaVersion: 1,
    role: normalizeRole(input?.role),
    runId: String(input?.runId || ''),
    scenarioId: PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID,
    eventCount: events.length,
    eventsSha256: portableEvidenceSha256(events),
    events,
    selectionPolicy: 'exact_request_id_terminal_events_only_no_latest_wins',
  }, hmacKey);
}

export function portablePairedRuntimeModulePath() {
  return fileURLToPath(import.meta.url);
}
