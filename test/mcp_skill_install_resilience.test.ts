import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ORIGINAL_LUMI_DATA_DIR = process.env.LUMI_DATA_DIR;

let tempHome = '';

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;
type ExecHandler = (command: string, options: any, callback: ExecCallback) => void;
type ExecFileHandler = (file: string, args: string[], options: any, callback: ExecCallback) => void;

function makeExec(handler: ExecHandler) {
  return vi.fn((command: string, options: any, callback?: ExecCallback) => {
    const cb = (typeof options === 'function' ? options : callback) as ExecCallback;
    queueMicrotask(() => handler(String(command), options, cb));
    return { pid: 1234, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null } as any;
  });
}

function makeExecFile(handler: ExecFileHandler) {
  return vi.fn((file: string, args: string[], options: any, callback?: ExecCallback) => {
    const cb = (typeof options === 'function' ? options : callback) as ExecCallback;
    queueMicrotask(() => handler(String(file), Array.isArray(args) ? args.map(String) : [], options, cb));
    return { pid: 1234, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null } as any;
  });
}

async function importClientWithExec(
  execMock: ReturnType<typeof makeExec>,
  execFileMock = makeExecFile((_file, _args, _options, callback) => callback(null, '', '')),
) {
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
    return { ...actual, exec: execMock, execFile: execFileMock };
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
    const execMock = makeExec((_command, _options, callback) => {
      callback(new Error('dependency boom'), '', 'dependency boom');
    });
    const execFileMock = makeExecFile((file, args, _options, callback) => {
      expect(file).toBe('git');
      expect(args.slice(0, 4)).toEqual(['clone', '--depth', '1', repoUrl]);
      const dest = args[4];
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
        name: 'failing-skill',
        version: '1.0.0',
        lumi: { toolCount: 1 },
      }, null, 2));
      callback(null, '', '');
    });
    const { MCPClientManager } = await importClientWithExec(execMock, execFileMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));

    await expect(manager.installFromGitHub(repoUrl)).rejects.toThrow('dependency boom');

    expect(execFileMock).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(tempHome, 'lumi_skills', 'failing-skill'))).toBe(false);
  });

  it('rejects unsupported GitHub URLs before cloning', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const execFileMock = makeExecFile((_file, _args, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock, execFileMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));

    await expect(manager.installFromGitHub('https://github.com/acme/bad.git";calc"')).rejects.toThrow('Unsupported GitHub repository URL');

    expect(execFileMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
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

  it('normalizes local skill names inside the skills directory', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const sourceDir = path.join(tempHome, 'source-skill');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
      name: 'lumi-skill-safe-name',
      version: '1.0.0',
      lumi: { toolCount: 1 },
    }, null, 2));

    const destDir = manager.installSkill('../Unsafe Skill', sourceDir);

    expect(destDir).toBe(path.join(tempHome, 'lumi_skills', 'unsafe-skill'));
    expect(fs.existsSync(path.join(tempHome, 'unsafe-skill'))).toBe(false);
    expect(manager.getConfig()['unsafe-skill']).toBeTruthy();
  });

  it('publishes validated local skills atomically and leaves no failed workspace', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const validSource = path.join(tempHome, 'valid-source');
    fs.mkdirSync(validSource, { recursive: true });
    fs.writeFileSync(path.join(validSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(validSource, 'package.json'), JSON.stringify({
      name: 'atomic-skill', version: '1.0.0', lumi: { toolCount: 1 },
    }));

    const installed = await manager.installSkillValidated('atomic-skill', validSource);
    expect(installed).toBe(path.join(tempHome, 'lumi_skills', 'atomic-skill'));
    expect(manager.getConfig()['atomic-skill']).toBeTruthy();

    const invalidSource = path.join(tempHome, 'invalid-source');
    fs.mkdirSync(invalidSource, { recursive: true });
    fs.writeFileSync(path.join(invalidSource, 'package.json'), JSON.stringify({ name: 'broken' }));
    await expect(manager.installSkillValidated('broken', invalidSource)).rejects.toThrow(/index\.ts|runCommand/);
    expect(fs.existsSync(path.join(tempHome, 'lumi_skills', 'broken'))).toBe(false);
    expect(fs.readdirSync(path.join(tempHome, 'lumi_skills')).some(name => name.startsWith('.staging-broken-'))).toBe(false);
  });
});
