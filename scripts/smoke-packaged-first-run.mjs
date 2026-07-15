import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const args = {
    distServer: path.join(root, 'desktop-resources', 'dist-server'),
    keep: false,
    skillId: 'skill-admin-assistant',
    timeoutMs: 45000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dist-server') args.distServer = path.resolve(argv[++i]);
    else if (arg === '--skill-id') args.skillId = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/smoke-packaged-first-run.mjs [options]

Options:
  --dist-server <path>  Packaged dist-server directory. Defaults to desktop-resources/dist-server.
  --skill-id <id>       Marketplace skill to install. Defaults to skill-admin-assistant.
  --timeout-ms <ms>     Startup/connect timeout. Defaults to 45000.
  --keep               Keep the temporary smoke profile under .codex-run.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function nodeBinaryName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

async function assertPath(filePath, label = filePath) {
  if (!existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new Error(`${options.method || 'GET'} ${url} failed with ${res.status}: ${text.slice(0, 500)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(description, timeoutMs, intervalMs, fn) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

async function tail(filePath, lines = 80) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distServer = args.distServer;
  const nodePath = path.join(distServer, nodeBinaryName());
  const entryPath = path.join(distServer, 'entry.cjs');
  const serverBundle = path.join(distServer, 'server.mjs');
  const bundledSkillsDir = path.join(distServer, 'server', 'skills', 'bundled');
  const mcpFactoryConfig = path.join(distServer, 'server', 'mcp', 'config.example.json');
  const mcpRuntimeConfig = path.join(distServer, 'server', 'mcp', 'config.json');
  const tsxCli = path.join(distServer, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const larkSdkPkg = path.join(distServer, 'node_modules', '@larksuiteoapi', 'node-sdk', 'package.json');
  const mcpSdkPkg = path.join(distServer, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
  const zodPkg = path.join(distServer, 'node_modules', 'zod', 'package.json');

  await assertPath(distServer, 'packaged dist-server');
  await assertPath(nodePath, 'packaged Node runtime');
  await assertPath(entryPath, 'packaged entry.cjs');
  await assertPath(serverBundle, 'packaged server.mjs');
  await assertPath(bundledSkillsDir, 'bundled skills directory');
  await assertPath(mcpFactoryConfig, 'factory MCP config');
  await assertPath(tsxCli, 'packaged tsx CLI');
  await assertPath(larkSdkPkg, 'packaged Lark SDK');
  await assertPath(mcpSdkPkg, 'packaged MCP SDK');
  await assertPath(zodPkg, 'packaged zod');

  if (existsSync(mcpRuntimeConfig)) {
    throw new Error(`Packaged resources must not include user runtime MCP config: ${mcpRuntimeConfig}`);
  }

  const runRoot = path.join(root, '.codex-run', `packaged-first-run-${Date.now()}`);
  const homeDir = path.join(runRoot, 'home');
  const dataRoot = path.join(runRoot, 'data-root');
  const outLog = path.join(runRoot, 'backend.out.log');
  const errLog = path.join(runRoot, 'backend.err.log');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    LUMI_DESKTOP: '1',
    LUMI_DATA_DIR: dataRoot,
    USERPROFILE: homeDir,
    HOME: homeDir,
  };

  const out = await fs.open(outLog, 'a');
  const err = await fs.open(errLog, 'a');
  const child = spawn(nodePath, [entryPath], {
    cwd: distServer,
    env,
    stdio: ['ignore', out.fd, err.fd],
    windowsHide: true,
  });

  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });

  try {
    await waitFor('packaged backend health endpoint', args.timeoutMs, 500, async () => {
      if (childExited) throw new Error('backend process exited before becoming healthy');
      return fetchJson(`${baseUrl}/health`, { timeoutMs: 2000 });
    });

    const bootstrap = await fetchJson(`${baseUrl}/auth/bootstrap`, { timeoutMs: 15000 });
    if (!bootstrap?.success || !bootstrap?.token) {
      throw new Error(`Local identity bootstrap failed: ${JSON.stringify(bootstrap)}`);
    }
    const authHeaders = { Authorization: `Bearer ${bootstrap.token}` };

    const marketplace = await fetchJson(`${baseUrl}/marketplace/skills?lang=zh`, { timeoutMs: 8000 });
    if (!Array.isArray(marketplace) || marketplace.length < 20) {
      throw new Error(`Unexpected marketplace response. Skill count: ${Array.isArray(marketplace) ? marketplace.length : 'not-array'}`);
    }

    const skill = marketplace.find(item => item.id === args.skillId);
    if (!skill) throw new Error(`Marketplace skill not found: ${args.skillId}`);
    if (skill.installSource !== 'bundled') {
      throw new Error(`Smoke skill must be bundled. ${args.skillId} is ${skill.installSource}`);
    }

    const install = await fetchJson(`${baseUrl}/marketplace/skills/acquire`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skillId: skill.id,
        skillName: skill.name,
        installSource: skill.installSource,
        installPath: skill.installPath,
      }),
      timeoutMs: 30000,
    });
    if (!install.success) throw new Error(`Skill install failed: ${JSON.stringify(install)}`);

    const dirName = args.skillId.replace(/^skill-/i, '');
    const skillDir = path.join(homeDir, 'lumi_skills', dirName);
    const skillNodeModules = path.join(skillDir, 'node_modules');
    await assertPath(path.join(skillDir, 'package.json'), 'installed skill package');
    await assertPath(path.join(skillDir, 'index.ts'), 'installed skill entry');
    await assertPath(skillNodeModules, 'installed skill node_modules link');

    const connectedSkill = await waitFor(`${dirName} MCP connection`, args.timeoutMs, 1000, async () => {
      const skills = await fetchJson(`${baseUrl}/skills`, {
        headers: authHeaders,
        timeoutMs: 8000,
      });
      const items = Array.isArray(skills?.skills) ? skills.skills : [];
      return items.find(item => item.name === dirName && item.connected);
    });

    const marketplaceAfterInstall = await fetchJson(`${baseUrl}/marketplace/skills?lang=zh`, { timeoutMs: 8000 });
    const installedSkill = marketplaceAfterInstall.find(item => item.id === args.skillId);
    if (!installedSkill?.installed) {
      throw new Error(`Marketplace did not mark ${args.skillId} as installed`);
    }

    const runtimeConfigPath = path.join(dataRoot, 'data', 'mcp_config.json');
    await assertPath(runtimeConfigPath, 'generated runtime MCP config');

    const summary = {
      ok: true,
      distServer,
      port,
      marketplaceCount: marketplaceAfterInstall.length,
      installedSkill: {
        id: args.skillId,
        dirName,
        connected: Boolean(connectedSkill.connected),
        toolCount: connectedSkill.toolCount,
      },
      cleanup: args.keep ? 'kept' : 'removed',
      tempProfile: args.keep ? runRoot : undefined,
      logs: args.keep ? { stdout: outLog, stderr: errLog } : undefined,
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (errCaught) {
    console.error('[packaged-smoke] FAILED:', errCaught.message);
    console.error('\n--- backend stdout tail ---');
    console.error(await tail(outLog));
    console.error('\n--- backend stderr tail ---');
    console.error(await tail(errLog));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await out.close();
    await err.close();
    if (!args.keep && process.exitCode !== 1) {
      await fs.rm(runRoot, { recursive: true, force: true });
    } else {
      console.log(`[packaged-smoke] Kept temp profile: ${runRoot}`);
    }
  }
}

main().catch(err => {
  console.error('[packaged-smoke] Fatal:', err);
  process.exit(1);
});
