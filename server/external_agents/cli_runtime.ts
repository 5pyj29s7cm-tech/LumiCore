import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolContext } from '../tools/types';
import { getDataPath, getGeneratedOutputDir } from '../config/data_path';
import { ensurePrivateRuntimeDirectory } from '../config/runtime_file_security';
import { requireNotStrict } from '../config/privacy';
import { classifyExternalCliIntent, isExternalCliDelegation } from '../cognition/external_cli_intent';
import { runCliProcess, type CliProcessInput, type CliProcessResult } from './cli_process';

export type ExternalCliProvider = 'codex' | 'claude';
export type ExternalCliAccess = 'read-only' | 'workspace-write';
type Launch = { executable: string; prefix: string[] };
export interface ExternalCliRun {
  runId: string; provider: ExternalCliProvider; sessionId?: string; owner: string;
  cwd: string; outputDirectory: string; access: ExternalCliAccess;
  taskId: string; conversationId: string; parentRunId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  startedAt: string; completedAt?: string; response?: string; error?: string;
  exitCode?: number | null; artifacts?: Array<{ path: string; size: number; sha256: string }>;
}
interface Dependencies {
  runProcess?: (input: CliProcessInput) => Promise<CliProcessResult>;
  resolveLaunch?: (provider: ExternalCliProvider) => Launch | undefined;
}
const activeWorkspaces = new Set<string>();
const activeRuns = new Set<string>();
const MAX_MS = 15 * 60_000;
const isId = (value: string) => /^[a-zA-Z0-9_-]{8,100}$/.test(value);
export function sanitizeCliText(value: string): string {
  return value.replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]');
}
function assertHost(context?: ToolContext): asserts context is ToolContext {
  if (!context?.userId || !(context.executionBoundary === 'trusted_local' && context.localExecution === true
    || context.executionBoundary === 'trusted_system' && context.systemExecution === true)) {
    throw new Error('External CLI execution requires an authenticated local Lumi host context.');
  }
  if (context.desktopPlatform && context.desktopPlatform !== process.platform) throw new Error('External CLI must run on the same host as this Lumi backend.');
}
function ownerKey(context: ToolContext): string {
  return createHash('sha256').update(JSON.stringify([context.userId, context.domain || 'personal', context.orgId || ''])).digest('hex');
}
function stateDirectory(context: ToolContext): string {
  return ensurePrivateRuntimeDirectory(getDataPath(path.join('external-agents', ownerKey(context))));
}
function saveRun(run: ExternalCliRun, context: ToolContext): void {
  const target = path.join(stateDirectory(context), `${run.runId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(run), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, target); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function loadRun(runId: string, context: ToolContext): ExternalCliRun {
  if (!isId(runId)) throw new Error('Invalid Lumi external run ID.');
  const file = path.join(stateDirectory(context), `${runId}.json`);
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error('External run is unavailable in this user/workspace scope.');
  const run: ExternalCliRun = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (run.runId !== runId || run.owner !== ownerKey(context)) throw new Error('External run ownership mismatch.');
  if (run.status === 'running' && !activeRuns.has(runId)) {
    run.status = 'interrupted'; run.error = 'Lumi restarted before observing the CLI result. Do not assume the task completed.';
  }
  return run;
}

/** Only fixed CLI executables/node entry points; prompts never become shell code. */
export function resolveCliLaunch(provider: ExternalCliProvider): Launch | undefined {
  const override = process.env[provider === 'codex' ? 'LUMI_CODEX_CLI_PATH' : 'LUMI_CLAUDE_CLI_PATH'];
  const roots = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const appData = process.env.APPDATA || path.join(os.homedir(), '.local');
  const npmPackage = provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js';
  const candidates = override ? [override] : [
    path.join(local, 'LumiCore', 'cli-tools', provider, 'node_modules', npmPackage),
    ...(provider === 'claude' ? [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')] : []),
    ...roots.flatMap(root => [path.join(root, provider + (process.platform === 'win32' ? '.exe' : '')), path.join(root, 'node_modules', npmPackage)]),
    path.join(appData, 'npm', 'node_modules', npmPackage),
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || /\.(cmd|bat|ps1)$/i.test(candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const executable = fs.realpathSync(candidate);
    return /\.[cm]?js$/i.test(executable) ? { executable: process.execPath, prefix: [executable] } : { executable, prefix: [] };
  }
  return undefined;
}
function cliEnvironment(provider: ExternalCliProvider): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const base = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC|HOMEDRIVE|HOMEPATH|USER|USERNAME|LANG|LC_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  const auth = provider === 'codex' ? /^(?:CODEX_HOME|CODEX_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL)$/ : /^(?:CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL)$/;
  for (const [key, value] of Object.entries(process.env)) if (base.test(key) || auth.test(key)) env[key] = value;
  return env;
}
export function buildCliArgs(provider: ExternalCliProvider, access: ExternalCliAccess, cwd: string, sessionId?: string, outputDirectory?: string): string[] {
  if (sessionId && !isId(sessionId)) throw new Error('Invalid external CLI session ID.');
  if (provider === 'codex') {
    // Sandbox is a global override so it is also applied to exec resume.
    return ['-c', `sandbox_mode="${access}"`, ...(access === 'workspace-write' && outputDirectory ? ['--add-dir', outputDirectory] : []), 'exec', ...(sessionId ? ['resume', sessionId] : []), '--skip-git-repo-check', '--json', '-'];
  }
  return ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', access === 'read-only' ? 'dontAsk' : 'acceptEdits',
    '--tools', access === 'read-only' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
    '--allowedTools', access === 'read-only' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
    ...(access === 'workspace-write' && outputDirectory ? ['--add-dir', outputDirectory] : []), ...(sessionId ? ['--resume', sessionId] : [])];
}
export interface CliStreamState { sessionId?: string; terminal: boolean; failed: boolean; response: string; error?: string; progress: string[] }
export function consumeCliEvent(provider: ExternalCliProvider, line: string, state: CliStreamState): void {
  let event: any; try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== 'object') return;
  if (provider === 'codex') {
    if (event.type === 'thread.started' && isId(String(event.thread_id || ''))) state.sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') state.response = String(event.item.text || '');
    if (/^item\./.test(event.type || '') && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item?.type)) {
      state.progress.push(`${event.type === 'item.completed' ? '完成' : '正在执行'}：${event.item.type}`);
    }
    if (event.type === 'turn.completed') state.terminal = true;
    if (event.type === 'turn.failed') { state.failed = true; state.error = String(event.error?.message || 'Codex failed'); }
    // Codex also emits error events for recoverable transport reconnects. A
    // later turn.completed + exit 0 is authoritative; do not poison that turn.
    if (event.type === 'error') { state.error = String(event.message || event.error?.message || 'Codex transport error'); state.progress.push(sanitizeCliText(state.error).slice(0, 180)); }
  } else {
    if (event.session_id && isId(String(event.session_id))) state.sessionId = event.session_id;
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'text') state.response += String(block.text || '') + '\n';
        if (block.type === 'tool_use') state.progress.push(`正在执行：${String(block.name || 'tool').slice(0, 80)}`);
      }
    }
    if (event.type === 'result') {
      state.terminal = true;
      state.failed = event.is_error === true || event.subtype !== 'success';
      if (typeof event.result === 'string') state.response = event.result;
      if (state.failed) state.error = String(event.result || event.errors?.join('; ') || event.subtype || 'Claude failed');
    }
  }
  state.response = state.response.slice(-128000);
  state.progress = state.progress.slice(-2000);
}
function snapshotOutputs(root: string): Map<string, { path: string; size: number; sha256: string }> {
  const result = new Map<string, { path: string; size: number; sha256: string }>();
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('Agent output directory was redirected.');
  let visited = 0;
  const visit = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 1000) return;
      if (item.isSymbolicLink() || item.name.startsWith('.') || /^(?:node_modules|target|dist)$/.test(item.name)) continue;
      const file = path.join(dir, item.name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file, depth + 1); continue; }
      if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024 || stat.nlink > 1) continue;
      const real = fs.realpathSync(file);
      if (real !== file || !real.startsWith(root + path.sep)) continue;
      const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      result.set(real, { path: real, size: stat.size, sha256 });
      if (result.size >= 100) return;
    }
  };
  visit(root, 0); return result;
}

export async function inspectExternalClis(context?: ToolContext, deps: Dependencies = {}): Promise<string> {
  assertHost(context);
  const runner = deps.runProcess || runCliProcess;
  const targets = [];
  for (const provider of ['codex', 'claude'] as const) {
    const launch = (deps.resolveLaunch || resolveCliLaunch)(provider);
    if (!launch) { targets.push({ provider, installed: false, ready: false, status: 'not_installed' }); continue; }
    const common = { executable: launch.executable, cwd: os.homedir(), timeoutMs: 12000, env: cliEnvironment(provider), signal: context.executionSignal, isCancelled: context.isCancelled };
    const version = await runner({ ...common, args: [...launch.prefix, '--version'] });
    const auth = await runner({ ...common, args: [...launch.prefix, ...(provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'])] });
    let loggedIn = provider === 'codex' && auth.exitCode === 0 && /logged in/i.test(auth.stdout + auth.stderr);
    if (provider === 'claude') { try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch {} }
    targets.push({ provider, installed: true, ready: version.exitCode === 0 && loggedIn && !auth.failure,
      version: sanitizeCliText(version.stdout.trim()).slice(0, 100), executable: launch.prefix[0] || launch.executable,
      status: auth.failure || (loggedIn ? 'ready' : /configuration|unknown variant/i.test(auth.stderr) ? 'config_error' : 'login_required'),
      ...(!loggedIn ? { diagnostic: sanitizeCliText(auth.stderr || auth.stdout).slice(0, 700) } : {}) });
  }
  return JSON.stringify({ ok: true, status: 'completed', targets, note: 'CLI authentication/configuration is separate from Lumi model routing. Readiness does not verify model quota or an actual task.' });
}

export async function getExternalCliRun(args: Record<string, any>, context?: ToolContext): Promise<string> {
  assertHost(context);
  const run = loadRun(String(args.runId || ''), context);
  const { owner: _owner, sessionId: _session, ...visible } = run;
  return JSON.stringify({ ok: run.status === 'completed' || run.status === 'running', ...visible });
}

export async function executeExternalCli(args: Record<string, any>, context?: ToolContext, deps: Dependencies = {}): Promise<string> {
  assertHost(context); requireNotStrict('External Codex/Claude CLI');
  if (context.executionSignal?.aborted || context.isCancelled?.()) return JSON.stringify({ ok: false, status: 'cancelled' });
  const provider = String(args.provider || '') as ExternalCliProvider;
  if (!['codex', 'claude'].includes(provider)) throw new Error('Choose codex or claude explicitly.');
  const prompt = String(args.prompt || '').trim();
  if (!prompt || prompt.length > 48000) throw new Error('Provide a non-empty, bounded task prompt (maximum 48000 characters).');
  const prior = args.resumeRunId ? loadRun(String(args.resumeRunId), context) : undefined;
  const intent = context.routedTaskText || context.actionIntent || '';
  if (!isExternalCliDelegation(intent)
    && !(prior && context.trustedActionContinuation && classifyExternalCliIntent(intent) === 'none')) {
    throw new Error('The user has not requested external CLI delegation for this task.');
  }
  const namedProviders = ['codex', 'claude'].filter(name => new RegExp(name, 'i').test(intent));
  if (namedProviders.length === 1 && namedProviders[0] !== provider) throw new Error('The CLI provider must match the provider requested by the user.');
  if (prior && (prior.provider !== provider || !prior.sessionId || ['running', 'interrupted'].includes(prior.status))) throw new Error('This run cannot be resumed: provider/session mismatch or prior execution has not settled.');
  const cwdInput = String(args.cwd || prior?.cwd || '').trim();
  if (!cwdInput || !path.isAbsolute(cwdInput)) throw new Error('An explicit absolute working directory is required.');
  const cwd = fs.realpathSync(cwdInput);
  if (!fs.statSync(cwd).isDirectory() || cwd === path.parse(cwd).root) throw new Error('Choose a specific project/work folder, not a drive root.');
  if (prior && cwd !== prior.cwd) throw new Error('Resume must keep the same working directory. Start a new run for another project.');
  const anchoredPath = context.acceptedTaskTarget?.target.path;
  if (anchoredPath && path.isAbsolute(anchoredPath)) {
    const target = fs.existsSync(anchoredPath) ? fs.realpathSync(anchoredPath) : path.resolve(anchoredPath);
    const relative = path.relative(cwd, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('The accepted task file lies outside this CLI workspace. Choose its actual project directory.');
  }
  const access = String(args.access || prior?.access || 'read-only') as ExternalCliAccess;
  if (!['read-only', 'workspace-write'].includes(access)) throw new Error('Unsupported CLI access mode.');
  const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  if ([...activeWorkspaces].some(active => active === key || active.startsWith(key + path.sep) || key.startsWith(active + path.sep))) return JSON.stringify({ ok: false, status: 'blocked', error: 'Another external CLI is using this workspace. Continue/cancel that Lumi task before starting another.' });
  const launch = (deps.resolveLaunch || resolveCliLaunch)(provider);
  if (!launch) return JSON.stringify({ ok: false, status: 'blocked', error: `${provider} CLI is not installed. Use external_cli_status to inspect.` });
  const runId = randomUUID();
  const outputDirectory = prior?.outputDirectory || ensurePrivateRuntimeDirectory(path.join(getGeneratedOutputDir(), 'external-agent', ownerKey(context), runId));
  const run: ExternalCliRun = { runId, provider, owner: ownerKey(context), cwd, outputDirectory, access,
    taskId: context.taskId || '', conversationId: context.conversationId || '', status: 'running', startedAt: new Date().toISOString(),
    ...(prior ? { parentRunId: prior.runId, sessionId: prior.sessionId } : {}) };
  const state: CliStreamState = { sessionId: prior?.sessionId, terminal: false, failed: false, response: '', progress: [] };
  const before = snapshotOutputs(outputDirectory);
  activeWorkspaces.add(key); activeRuns.add(runId);
  try {
    saveRun(run, context);
    context.onProgress?.(`${provider === 'codex' ? 'Codex CLI' : 'Claude Code'} 已开始${prior ? '继续' : '处理'}任务。`);
    const runner = deps.runProcess || runCliProcess;
    let progressCount = 0;
    const result = await runner({ executable: launch.executable,
      args: [...launch.prefix, ...buildCliArgs(provider, access, cwd, prior?.sessionId, outputDirectory)], cwd,
      input: `Lumi owns the parent task. Work only on this delegated request in ${cwd}. Do not spawn or delegate to another agent. Do not push, publish, install services, or send messages. Report unfinished work and failures truthfully.\nAccess: ${access}. ${access === 'read-only' ? 'Do not modify files or execute shell commands.' : 'Place shareable deliverables in the output directory below; source edits belong in this workspace.'}\n${anchoredPath ? `Canonical task target (do not substitute another file): ${anchoredPath}\n` : ''}Lumi output directory: ${outputDirectory}\nReturn a concise account of actions, validation, and deliverable paths. A model claim alone is not proof of completion.\n\nUSER TASK / NECESSARY CONTEXT:\n${prompt}\n`,
      env: cliEnvironment(provider), timeoutMs: Math.min(MAX_MS, Math.max(1000, Number(args.timeoutMs) || MAX_MS)),
      signal: context.executionSignal, isCancelled: context.isCancelled,
      onLine: line => {
        consumeCliEvent(provider, line, state);
        if (state.sessionId && run.sessionId !== state.sessionId) { run.sessionId = state.sessionId; saveRun(run, context); }
        if (state.progress.length > progressCount) { progressCount = state.progress.length; context.onProgress?.(`${provider}: ${state.progress.at(-1)}`); }
      },
    });
    run.exitCode = result.exitCode; run.sessionId = state.sessionId; run.response = sanitizeCliText(state.response).trim();
    run.status = result.failure === 'cancelled' ? 'cancelled' : result.failure === 'timed_out' ? 'timed_out'
      : result.exitCode === 0 && !result.failure && state.terminal && !state.failed && run.response ? 'completed' : 'failed';
    if (run.status !== 'completed') run.error = sanitizeCliText(state.error || result.stderr || result.failure || 'CLI ended without a successful terminal result.').slice(0, 1800);
    run.artifacts = [...snapshotOutputs(outputDirectory).values()].filter(file => before.get(file.path)?.sha256 !== file.sha256).slice(0, 24);
  } catch (error: any) {
    run.status = 'failed'; run.error = sanitizeCliText(String(error?.message || error)).slice(0, 1800);
  } finally {
    run.completedAt = new Date().toISOString();
    try { saveRun(run, context); } finally { activeRuns.delete(runId); activeWorkspaces.delete(key); }
  }
  const { owner: _owner, sessionId: _session, ...visible } = run;
  return JSON.stringify({ ok: run.status === 'completed', ...visible, response: run.response?.slice(0, 24000), responseTruncated: (run.response?.length || 0) > 24000,
    verificationScope: 'CLI terminal response and changed output-file bytes only; source edits and business correctness still need Lumi verification.',
    ...(['cancelled', 'timed_out', 'failed'].includes(run.status) ? { note: 'Partial actions may have occurred; inspect the recorded run before retrying.' } : {}) });
}
