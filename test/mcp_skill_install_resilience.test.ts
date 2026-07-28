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
  vi.useRealTimers();
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
  it('retries a crashed server with exponential backoff and opens the circuit after five failures', async () => {
    vi.useFakeTimers();
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    manager.saveConfig({
      unstable: {
        command: 'unstable-mcp',
        args: [],
        enabled: true,
        source: 'external',
      },
    });
    const connectServer = vi.fn().mockRejectedValue(new Error('injected MCP crash'));
    (manager as any).connectServer = connectServer;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    (manager as any).recordStartupFailure('unstable', new Error('initial MCP crash'));
    expect(manager.getServerHealth().unstable).toMatchObject({
      status: 'restarting',
      consecutiveCrashes: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000);

    expect(connectServer).toHaveBeenCalledTimes(5);
    expect(manager.getServerHealth().unstable).toMatchObject({
      status: 'failed',
      consecutiveCrashes: 5,
      lastError: 'injected MCP crash',
    });
    expect((manager as any).crashTrackers.get('unstable').restartTimer).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/giving up/i));
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  it('backfills factory MCP capability declarations without changing user enablement', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const configPath = path.join(tempHome, 'data', 'mcp_config.json');
    const manager = new MCPClientManager(configPath);
    manager.saveConfig({
      playwright: {
        command: 'custom-playwright-command',
        args: ['--user-profile'],
        enabled: true,
        source: 'external',
      },
    });

    expect(manager.syncFactoryCapabilityMetadata()).toContain('playwright');
    expect(manager.getConfig().playwright).toMatchObject({
      command: 'custom-playwright-command',
      args: ['--user-profile'],
      enabled: true,
      capabilityDefault: {
        operation: 'mutate',
        risk: 'high',
        lane: 'web',
        trust: 'third-party',
      },
    });
    expect(manager.getConfig().playwright.capabilityDefault?.sideEffects.map(effect => effect.type)).toEqual([
      'network_read',
      'credential_access',
      'external_state_change',
      'external_communication',
    ]);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.migrations.mcpCapabilityDeclarationsV1).toBe(1);
    expect(manager.syncFactoryCapabilityMetadata()).toEqual([]);
  });

  it('registers cached process tools as available without keeping every skill process resident', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    manager.saveConfig({
      'cad-drafting': {
        command: 'npx',
        args: ['tsx', '~/lumi_skills/cad-drafting/index.ts'],
        enabled: true,
        source: 'local',
        cachedTools: [{
          serverName: 'cad-drafting',
          name: 'mcp_cad-drafting_autocad_playback_file',
          description: 'Visible AutoCAD playback',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    });

    const tools = await manager.connectAll();

    expect(tools.map(tool => tool.name)).toEqual(['mcp_cad-drafting_autocad_playback_file']);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getAvailableServers()).toEqual(['cad-drafting']);
    expect(manager.getServerHealth()['cad-drafting'].status).toBe('idle');
  });

  it('throws MCP protocol error results instead of returning them as successful tool text', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'AutoCAD operation 1 failed.' }],
    });
    (manager as any).servers.set('broken', {
      client: { callTool },
      transport: {},
      config: { enabled: true },
    });

    await expect(manager.callTool('mcp_broken_draw', {})).rejects.toThrow('AutoCAD operation 1 failed.');
    expect(callTool).toHaveBeenCalledWith({ name: 'draw', arguments: {} });
  });

  it('passes the registry timeout budget through to long-running MCP calls', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"completed"}' }],
    });
    (manager as any).servers.set('cad-drafting', {
      client: { callTool },
      transport: {},
      config: { enabled: true },
    });

    await expect(manager.callTool(
      'mcp_cad-drafting_autocad_playback_file',
      { operationsPath: 'C:\\CAD\\plan_operations.json' },
      { timeoutMs: 30 * 60_000 },
    )).resolves.toContain('completed');
    expect(callTool).toHaveBeenCalledWith(
      {
        name: 'autocad_playback_file',
        arguments: { operationsPath: 'C:\\CAD\\plan_operations.json' },
      },
      undefined,
      { timeout: 30 * 60_000, maxTotalTimeout: 30 * 60_000 },
    );
  });

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

  it('promotes an explicitly approved generated draft into an installed managed skill', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const draftSource = path.join(tempHome, 'approved-draft');
    fs.mkdirSync(draftSource, { recursive: true });
    fs.writeFileSync(path.join(draftSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(draftSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-approved-draft',
      version: '1.0.0',
      lumi: {
        autoGenerated: true,
        status: 'draft',
        skillName: 'approved-draft',
        toolCount: 1,
      },
    }));

    const approvedAt = new Date(0).toISOString();
    const installed = await manager.installSkillValidated('approved-draft', draftSource, {
      approvedGeneratedDraft: {
        approvedAt,
        review: {
          status: 'draft',
          staticCheck: { passed: true, findings: [] },
          trialRun: { passed: true, note: 'isolated startup passed' },
          requiresUserApproval: true,
        },
      },
    });

    const installedPackage = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json'), 'utf8'),
    );
    expect(installedPackage.lumi).toMatchObject({
      autoGenerated: false,
      generatedByLumi: true,
      status: 'installed',
      approvedAt,
    });
    expect(manager.getConfig()['approved-draft']).toMatchObject({
      autoGenerated: false,
      enabled: true,
      source: 'local',
    });
  });

  it('syncs newer managed bundled skills before MCP startup without downgrading them', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const originalSource = path.join(tempHome, 'original-bundle');
    const bundledRoot = path.join(tempHome, 'bundled');
    const upgradeSource = path.join(bundledRoot, 'cad-drafting');
    fs.mkdirSync(originalSource, { recursive: true });
    fs.writeFileSync(path.join(originalSource, 'index.ts'), 'export const build = "old";\n');
    fs.writeFileSync(path.join(originalSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.5.0',
      lumi: { toolCount: 1 },
    }));
    manager.installSkill('cad-drafting', originalSource);

    fs.mkdirSync(upgradeSource, { recursive: true });
    fs.writeFileSync(path.join(upgradeSource, 'index.ts'), 'export const build = "new";\n');
    fs.writeFileSync(path.join(upgradeSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.6.0',
      lumi: { toolCount: 1 },
    }));

    expect(manager.syncBundledSkillUpgrades(bundledRoot)).toEqual([{
      name: 'cad-drafting',
      fromVersion: '1.5.0',
      toVersion: '1.6.0',
    }]);
    const installedDir = path.join(tempHome, 'lumi_skills', 'cad-drafting');
    expect(fs.readFileSync(path.join(installedDir, 'index.ts'), 'utf-8')).toContain('"new"');
    expect(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf-8')).lumi.installedVersion).toBe('1.6.0');

    fs.writeFileSync(path.join(upgradeSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.4.0',
      lumi: { toolCount: 1 },
    }));
    expect(manager.syncBundledSkillUpgrades(bundledRoot)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf-8')).version).toBe('1.6.0');
  });

  it('refreshes official capability metadata without forcing a bundled code upgrade', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const originalSource = path.join(tempHome, 'original-capability-bundle');
    const bundledRoot = path.join(tempHome, 'bundled-capability-metadata');
    const bundledSource = path.join(bundledRoot, 'cad-drafting');
    fs.mkdirSync(originalSource, { recursive: true });
    fs.writeFileSync(path.join(originalSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(originalSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.6.1',
      lumi: { toolCount: 1 },
    }));
    manager.installSkill('cad-drafting', originalSource);

    const capabilityDefault = {
      operation: 'create',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['terminal receipt'],
        limitations: ['Planning is not drawing completion.'],
      },
      trust: 'official',
    };
    const toolCapabilities = {
      autocad_new_document: {
        operation: 'mutate',
        risk: 'high',
        sideEffects: [{ type: 'desktop_control', scope: 'AutoCAD drawing', reversible: false }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['status'],
          requiredValues: { status: 'completed' },
          successSignals: ['visible document'],
          limitations: ['Requires AutoCAD.'],
        },
        trust: 'official',
      },
    };
    fs.mkdirSync(bundledSource, { recursive: true });
    fs.writeFileSync(path.join(bundledSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(bundledSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.6.1',
      lumi: { toolCount: 1, capabilityDefault, toolCapabilities },
    }));

    expect(manager.syncBundledSkillUpgrades(bundledRoot)).toEqual([]);
    expect(manager.getConfig()['cad-drafting']).toMatchObject({
      capabilityDefault,
      toolCapabilities,
    });
  });
});
