import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ORIGINAL_LUMI_DATA_DIR = process.env.LUMI_DATA_DIR;

let tempHome = '';

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;
type ExecHandler = (command: string, options: any, callback: ExecCallback) => void;

function makeExec(handler: ExecHandler) {
  return vi.fn((command: string, options: any, callback?: ExecCallback) => {
    const cb = (typeof options === 'function' ? options : callback) as ExecCallback;
    queueMicrotask(() => handler(String(command), options, cb));
    return { pid: 1234, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null } as any;
  });
}

async function importClientWithExec(execMock: ReturnType<typeof makeExec>) {
  vi.resetModules();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_mcp_install_'));
  process.env.LUMI_DATA_DIR = path.join(tempHome, 'LumiOS');

  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    const mocked = { ...actual, homedir: () => tempHome };
    return { ...actual, default: mocked, homedir: () => tempHome };
  });
  vi.doMock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    return { ...actual, exec: execMock };
  });

  return import('../server/mcp/client');
}

afterEach(() => {
  if (ORIGINAL_LUMI_DATA_DIR === undefined) delete process.env.LUMI_DATA_DIR;
  else process.env.LUMI_DATA_DIR = ORIGINAL_LUMI_DATA_DIR;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('os');
  vi.doUnmock('child_process');
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  tempHome = '';
});

describe('MCP skill install resilience', () => {
  it('removes the npm skill workspace when dependency install fails', async () => {
    const execMock = makeExec((_command, _options, callback) => {
      callback(new Error('registry unavailable'), '', 'registry unavailable');
    });
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));

    await expect(manager.installFromNpm('@scope/bad-skill')).rejects.toThrow('registry unavailable');

    expect(fs.existsSync(path.join(tempHome, 'lumi_skills', 'scope-bad-skill'))).toBe(false);
  });

  it('removes the GitHub checkout when npm install fails after clone', async () => {
    const repoUrl = 'https://github.com/acme/failing-skill.git';
    const execMock = makeExec((command, _options, callback) => {
      if (command.startsWith('git clone')) {
        const dest = command.match(/"([^"]+)"\s*$/)?.[1];
        if (!dest) return callback(new Error('missing clone destination'), '', '');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
          name: 'failing-skill',
          version: '1.0.0',
          lumi: { toolCount: 1 },
        }, null, 2));
        return callback(null, '', '');
      }
      callback(new Error('dependency boom'), '', 'dependency boom');
    });
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));

    await expect(manager.installFromGitHub(repoUrl)).rejects.toThrow('dependency boom');

    expect(fs.existsSync(path.join(tempHome, 'lumi_skills', 'failing-skill'))).toBe(false);
  });

  it('keeps npm skills that need keys disabled and explicit in MCP config', async () => {
    const npmPackage = '@vendor/keyed-skill';
    const execMock = makeExec((_command, options, callback) => {
      const depDir = path.join(options.cwd, 'node_modules', '@vendor', 'keyed-skill');
      fs.mkdirSync(depDir, { recursive: true });
      fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({
        name: npmPackage,
        version: '1.0.0',
        description: 'Needs E2B',
        lumi: {
          runCommand: 'npx',
          runArgs: ['-y', npmPackage],
          requiresApiKey: true,
          apiKeyEnv: 'E2B_API_KEY',
          apiKeyUrl: 'https://e2b.dev',
          toolCount: 2,
        },
      }, null, 2));
      callback(null, '', '');
    });
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));

    await manager.installFromNpm(npmPackage);

    const config = manager.getConfig()['vendor-keyed-skill'];
    expect(config.enabled).toBe(false);
    expect(config.requiresApiKey).toBe(true);
    expect(config.apiKeyEnv).toBe('E2B_API_KEY');
    expect(config.apiKeyUrl).toBe('https://e2b.dev');
  });

  it('keeps local index skills that need keys disabled and explicit in MCP config', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const sourceDir = path.join(tempHome, 'source-skill');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
      name: 'lumi-skill-keyed-local',
      version: '1.0.0',
      description: 'Local keyed skill',
      lumi: {
        requiresApiKey: true,
        apiKeyEnv: 'SILICONFLOW_API_KEY',
        apiKeyUrl: 'https://cloud.siliconflow.cn',
        envKeys: ['SILICONFLOW_API_KEY'],
        toolCount: 1,
      },
    }, null, 2));

    manager.installSkill('keyed-local', sourceDir);

    const config = manager.getConfig()['keyed-local'];
    expect(config.enabled).toBe(false);
    expect(config.requiresApiKey).toBe(true);
    expect(config.apiKeyEnv).toBe('SILICONFLOW_API_KEY');
    expect(config.env).toEqual({ SILICONFLOW_API_KEY: '${SILICONFLOW_API_KEY}' });
  });
});
