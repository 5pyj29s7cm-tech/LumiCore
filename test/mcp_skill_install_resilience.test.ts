import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBundledSkillIdentity } from '../server/marketplace/official_identity';

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
  process.env.LUMI_DATA_DIR = path.join(tempHome, 'LumiCore');

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
  it('does not seed the legacy online Playwright npx runtime', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));

    expect(manager.getConfig()).not.toHaveProperty('playwright');
  });

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
      filesystem: {
        command: 'custom-filesystem-command',
        args: ['--user-profile'],
        enabled: true,
        source: 'external',
      },
    });

    expect(manager.syncFactoryCapabilityMetadata()).toContain('filesystem');
    expect(manager.getConfig().filesystem).toMatchObject({
      command: 'custom-filesystem-command',
      args: ['--user-profile'],
      enabled: true,
      capabilityDefault: {
        operation: 'mutate',
        risk: 'high',
        lane: 'files',
        trust: 'third-party',
      },
    });
    expect(manager.getConfig().filesystem.capabilityDefault?.sideEffects.map(effect => effect.type)).toEqual([
      'local_read',
      'local_write',
    ]);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.migrations.mcpCapabilityDeclarationsV1).toBe(1);
    expect(manager.syncFactoryCapabilityMetadata()).toEqual([]);
  });

  it('registers cached process tools as available without keeping every skill process resident', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager, mcpServerConfigFingerprint } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const serverConfig = {
      command: process.execPath,
      args: ['C:\\approved\\cad-drafting-server.js'],
      enabled: true,
      source: 'external' as const,
    };
    manager.saveConfig({
      'cad-drafting': {
        ...serverConfig,
        cachedTools: [{
          serverName: 'cad-drafting',
          name: 'mcp_cad-drafting_autocad_playback_file',
          description: 'Visible AutoCAD playback',
          inputSchema: { type: 'object', properties: {} },
        }],
        cachedToolsFingerprint: mcpServerConfigFingerprint(serverConfig),
      },
    });

    const tools = await manager.connectAll();

    expect(tools.map(tool => tool.name)).toEqual(['mcp_cad-drafting_autocad_playback_file']);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getAvailableServers()).toEqual(['cad-drafting']);
    expect(manager.getRoutableServers()).toEqual(['cad-drafting']);
    expect(manager.getServerHealth()['cad-drafting'].status).toBe('idle');
  });

  it('does not publish cached tools from a legacy enabled npx download runner', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager, mcpServerConfigFingerprint } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const serverConfig = {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.79'],
      enabled: true,
      source: 'external' as const,
      transport: 'stdio' as const,
    };
    manager.saveConfig({
      playwright: {
        ...serverConfig,
        cachedTools: [{
          serverName: 'playwright',
          name: 'mcp_playwright_browser_open',
          rawName: 'browser_open',
          inputSchema: { type: 'object', properties: {} },
        }],
        cachedToolsFingerprint: mcpServerConfigFingerprint(serverConfig),
      },
    });
    const connect = vi.spyOn(manager as any, 'ensureServerConnected');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(manager.connectAll()).resolves.toEqual([]);

    expect(connect).not.toHaveBeenCalled();
    expect(manager.getAvailableServers()).toEqual([]);
    expect(manager.getRoutableServers()).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/unsafe package runner/i));
  });

  it('does not route a cached inventory without the exact current config fingerprint', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    manager.saveConfig({
      stale_server: {
        command: 'node',
        args: ['stale-server.js'],
        enabled: true,
        source: 'external',
        transport: 'stdio',
        cachedTools: [{
          serverName: 'stale_server',
          name: 'mcp_stale_server_old_action',
          rawName: 'old_action',
          inputSchema: { type: 'object', properties: {} },
        }],
        cachedToolsFingerprint: 'not-the-current-config-fingerprint',
      },
    });
    const connect = vi.spyOn(manager as any, 'ensureServerConnected')
      .mockRejectedValue(new Error('synthetic live discovery unavailable'));

    const tools = await manager.connectAll();

    expect(connect).toHaveBeenCalledWith('stale_server', expect.any(Object));
    expect(tools).toEqual([]);
    expect(manager.getRoutableServers()).toEqual([]);
    expect(manager.getServerHealth().stale_server.status).toBe('disconnected');
  });

  it('does not trust cached tools from an unsigned local Skill runtime', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager, mcpServerConfigFingerprint } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const skillDir = path.join(tempHome, 'lumi_skills', 'unsigned-cache');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(skillDir, 'package.json'), JSON.stringify({
      name: 'lumi-skill-unsigned-cache',
      version: '1.0.0',
      lumi: { status: 'active' },
    }));
    const serverConfig = {
      command: 'npx',
      args: ['tsx', '~/lumi_skills/unsigned-cache/index.ts'],
      enabled: true,
      source: 'local' as const,
      transport: 'stdio' as const,
    };
    manager.saveConfig({
      'unsigned-cache': {
        ...serverConfig,
        cachedTools: [{
          serverName: 'unsigned-cache',
          name: 'mcp_unsigned-cache_unreviewed_action',
          rawName: 'unreviewed_action',
          inputSchema: { type: 'object', properties: {} },
        }],
        cachedToolsFingerprint: mcpServerConfigFingerprint(serverConfig),
      },
    });
    const connect = vi.spyOn(manager as any, 'ensureServerConnected');

    const tools = await manager.connectAll();

    expect(tools).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(manager.getRoutableServers()).toEqual([]);
    expect(manager.getServerHealth()['unsigned-cache'].status).toBe('failed');
  });

  it('does not auto-register or connect a directory-only local package on restart', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    manager.saveConfig({});
    const packageDir = path.join(tempHome, 'lumi_skills', 'directory-only');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'directory-only',
      version: '1.0.0',
      lumi: { status: 'active' },
    }));
    const connect = vi.spyOn(manager as any, 'ensureServerConnected');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const tools = await manager.connectAll();

    expect(tools).toEqual([]);
    expect(manager.getConfig()).not.toHaveProperty('directory-only');
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getAvailableServers()).toEqual([]);
    expect(manager.getRoutableServers()).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('package present without an approved local runtime configuration'));
    expect(execMock).not.toHaveBeenCalled();
  });

  it('does not repair a broken third-party skill from mutable npm or repository metadata', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const skillDir = path.join(tempHome, 'lumi_skills', 'mutable-third-party');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'package.json'), JSON.stringify({
      name: 'mutable-third-party',
      lumi: {
        npmPackage: '@vendor/latest-skill',
        repoUrl: 'https://github.com/vendor/latest-skill.git',
      },
    }));
    manager.saveConfig({
      'mutable-third-party': {
        command: 'node',
        args: ['missing.js'],
        enabled: true,
        source: 'local',
      },
    });

    const result = await manager.repairSkill('mutable-third-party');

    expect(result).toMatchObject({
      success: false,
      reason: expect.stringContaining('immutable staged package proposal'),
      reviewRequired: true,
      requiredFlow: 'immutable_package_proposal',
    });
    expect(execMock).not.toHaveBeenCalled();
    expect(fs.existsSync(skillDir)).toBe(true);
  });

  it('refuses pure restart when a local skill lacks a signed runtime identity', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager, mcpRegistryToolName } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const skillDir = path.join(tempHome, 'lumi_skills', 'restart-only');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(skillDir, 'package.json'), JSON.stringify({
      name: 'restart-only',
      dependencies: { 'mutable-package': 'latest' },
      lumi: { status: 'active' },
    }));
    manager.saveConfig({
      'restart-only': {
        command: 'node',
        args: ['index.ts'],
        enabled: true,
        source: 'local',
        installationState: 'active',
      },
    });
    const tools = [{
      serverName: 'restart-only',
      rawName: 'probe',
      name: mcpRegistryToolName('restart-only', 'probe'),
      inputSchema: { type: 'object', properties: {} },
    }];
    const restart = vi.spyOn(manager, 'restartServer').mockResolvedValue(tools);

    const result = await manager.repairSkill('restart-only');

    expect(result).toMatchObject({ success: false, reviewRequired: true });
    expect(result.reason).toMatch(/identit/i);
    expect(restart).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('refuses legacy non-transactional bundled repair and requires explicit reinstall', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager, mcpRegistryToolName } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    manager.saveConfig({
      'desktop-automation': {
        command: 'node',
        args: ['missing.js'],
        enabled: true,
        source: 'local',
        installationState: 'active',
      },
    });
    const tools = [{
      serverName: 'desktop-automation',
      rawName: 'probe',
      name: mcpRegistryToolName('desktop-automation', 'probe'),
      inputSchema: { type: 'object', properties: {} },
    }];
    vi.spyOn(manager, 'restartServer').mockResolvedValue(tools);

    const result = await manager.repairSkill('desktop-automation');
    const installDir = path.join(tempHome, 'lumi_skills', 'desktop-automation');

    expect(result).toMatchObject({ success: false, reviewRequired: true });
    expect(result.reason).toMatch(/non-transactional|install the official Skill Hall/i);
    expect(fs.existsSync(installDir)).toBe(false);
  });

  it('rebinds an unchanged signed bundled skill after only its host runtime digest changes', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager, mcpRegistryToolName } = await importClientWithExec(execMock);
    const { signManagedSkillIdentity } = await import('../server/marketplace/official_identity');
    const { getJwtSecret } = await import('../server/config/local_identity');
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const skillName = 'content-ops';
    const source = path.resolve('server', 'skills', 'bundled', skillName);
    const installed = manager.installSkill(skillName, source, false, {
      managedSkill: createBundledSkillIdentity(`skill-${skillName}`, source),
    });
    const config = manager.getConfig();
    const staleUnsigned = JSON.parse(JSON.stringify(config[skillName].managedSkill));
    const staleRuntimeFile = staleUnsigned.runtime.files.find(
      (file: { path: string }) => file.path.endsWith(path.join('node_modules', 'fast-uri')),
    );
    expect(staleRuntimeFile).toBeTruthy();
    staleRuntimeFile.digest = `sha256:${'0'.repeat(64)}`;
    delete staleUnsigned.signature;
    const staleIdentity = signManagedSkillIdentity(staleUnsigned, getJwtSecret());
    config[skillName].managedSkill = staleIdentity;
    manager.saveConfig(config);
    const installedPackagePath = path.join(installed, 'package.json');
    const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
    installedPackage.lumi.managedSkill = staleIdentity;
    fs.writeFileSync(installedPackagePath, `${JSON.stringify(installedPackage, null, 2)}\n`);
    expect(() => manager.assertLocalSkillRuntimeIdentity(skillName, config[skillName]))
      .toThrow(/runtime file changed/i);

    const tools = [{
      serverName: skillName,
      rawName: 'probe',
      name: mcpRegistryToolName(skillName, 'probe'),
      inputSchema: { type: 'object', properties: {} },
    }];
    const restart = vi.spyOn(manager, 'restartServer').mockResolvedValue(tools);

    const result = await manager.repairSkill(skillName);

    expect(result).toMatchObject({
      success: true,
      action: 'runtime_rebound',
      directory: installed,
      toolCount: 1,
      tools,
    });
    expect(restart).toHaveBeenCalledWith(skillName);
    const reboundConfig = manager.getConfig()[skillName];
    const reboundPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
    expect(reboundPackage.lumi.managedSkill).toEqual(reboundConfig.managedSkill);
    expect(reboundConfig.managedSkill.signature).not.toBe(staleIdentity.signature);
    expect(() => manager.assertLocalSkillRuntimeIdentity(skillName, reboundConfig)).not.toThrow();
  });

  it('rolls back both managed identities and the full server config when rebound restart fails', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const { signManagedSkillIdentity } = await import('../server/marketplace/official_identity');
    const { getJwtSecret } = await import('../server/config/local_identity');
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const skillName = 'content-ops';
    const source = path.resolve('server', 'skills', 'bundled', skillName);
    const installed = manager.installSkill(skillName, source, false, {
      managedSkill: createBundledSkillIdentity(`skill-${skillName}`, source),
    });
    const config = manager.getConfig();
    const staleUnsigned = JSON.parse(JSON.stringify(config[skillName].managedSkill));
    const staleRuntimeFile = staleUnsigned.runtime.files.find(
      (file: { path: string }) => file.path.endsWith(path.join('node_modules', 'fast-uri')),
    );
    expect(staleRuntimeFile).toBeTruthy();
    staleRuntimeFile.digest = `sha256:${'0'.repeat(64)}`;
    delete staleUnsigned.signature;
    const staleIdentity = signManagedSkillIdentity(staleUnsigned, getJwtSecret());
    config[skillName].managedSkill = staleIdentity;
    config[skillName].cachedTools = [{
      serverName: skillName,
      rawName: 'old_probe',
      name: 'mcp_content-ops_old_probe',
      inputSchema: { type: 'object', properties: {} },
    }];
    config[skillName].cachedToolsFingerprint = 'old-fingerprint';
    config[skillName].cachedToolsAttestation = 'old-attestation';
    manager.saveConfig(config);
    const installedPackagePath = path.join(installed, 'package.json');
    const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
    installedPackage.lumi.managedSkill = staleIdentity;
    fs.writeFileSync(installedPackagePath, `${JSON.stringify(installedPackage, null, 2)}\n`);
    const previousServerConfig = structuredClone(config[skillName]);
    vi.spyOn(manager, 'restartServer').mockRejectedValue(new Error('injected restart failure'));

    await expect(manager.repairSkill(skillName)).rejects.toThrow(
      /restart failed after host-runtime rebind.*rolled back.*injected restart failure/i,
    );

    const rolledBackConfig = manager.getConfig()[skillName];
    const rolledBackPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
    expect(rolledBackConfig).toEqual(previousServerConfig);
    expect(rolledBackPackage.lumi.managedSkill).toEqual(staleIdentity);
    expect(() => manager.assertLocalSkillRuntimeIdentity(skillName, rolledBackConfig))
      .toThrow(/runtime file changed/i);
  });

  it.each(['generated identity', 'command drift', 'content drift'] as const)(
    'does not use bundled host-runtime rebinding for %s',
    async (scenario) => {
      const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
      const { MCPClientManager } = await importClientWithExec(execMock);
      const {
        createGeneratedSkillIdentity,
        signManagedSkillIdentity,
      } = await import('../server/marketplace/official_identity');
      const { getJwtSecret } = await import('../server/config/local_identity');
      const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
      const skillName = 'content-ops';
      const source = path.resolve('server', 'skills', 'bundled', skillName);
      const sourceIdentity = scenario === 'generated identity'
        ? createGeneratedSkillIdentity(skillName, source, 'sha256:reviewed-generated-fixture')
        : createBundledSkillIdentity(`skill-${skillName}`, source);
      const installed = manager.installSkill(skillName, source, false, { managedSkill: sourceIdentity });
      const config = manager.getConfig();
      const installedPackagePath = path.join(installed, 'package.json');

      if (scenario === 'generated identity') {
        const staleUnsigned = JSON.parse(JSON.stringify(config[skillName].managedSkill));
        const staleRuntimeFile = staleUnsigned.runtime.files.find(
          (file: { path: string }) => file.path.endsWith(path.join('node_modules', 'fast-uri')),
        );
        expect(staleRuntimeFile).toBeTruthy();
        staleRuntimeFile.digest = `sha256:${'0'.repeat(64)}`;
        delete staleUnsigned.signature;
        const staleIdentity = signManagedSkillIdentity(staleUnsigned, getJwtSecret());
        config[skillName].managedSkill = staleIdentity;
        const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
        installedPackage.lumi.managedSkill = staleIdentity;
        fs.writeFileSync(installedPackagePath, `${JSON.stringify(installedPackage, null, 2)}\n`);
      } else if (scenario === 'command drift') {
        config[skillName].command = path.join(tempHome, 'unapproved-node.exe');
      } else {
        fs.appendFileSync(path.join(installed, 'index.ts'), '\n// unapproved content drift\n');
      }
      manager.saveConfig(config);
      const restart = vi.spyOn(manager, 'restartServer').mockResolvedValue([]);

      const result = await manager.repairSkill(skillName);

      expect(result).toMatchObject({ success: false, reviewRequired: true });
      expect(restart).not.toHaveBeenCalled();
      expect(manager.getConfig()[skillName].managedSkill).toEqual(config[skillName].managedSkill);
    },
  );

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

  it('withdraws and closes an MCP runtime when a tool exceeds its wall timeout', async () => {
    vi.useFakeTimers();
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const close = vi.fn().mockResolvedValue(undefined);
    const callTool = vi.fn().mockReturnValue(new Promise(() => undefined));
    const config = { enabled: true, source: 'external' as const };
    manager.saveConfig({ hanging: config });
    (manager as any).servers.set('hanging', {
      client: { callTool },
      transport: { close },
      config,
    });

    const pending = manager.callToolForServer('hanging', 'never_returns', {}, { timeoutMs: 1_000 });
    const rejection = expect(pending).rejects.toThrow(/wall timeout/i);
    await vi.advanceTimersByTimeAsync(1_001);
    await rejection;

    expect(close).toHaveBeenCalledTimes(1);
    expect((manager as any).servers.has('hanging')).toBe(false);
  });

  it('actively closes a transport when the MCP initialize handshake times out', async () => {
    vi.useFakeTimers();
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const connect = vi.spyOn(Client.prototype, 'connect').mockReturnValue(new Promise(() => undefined) as any);
    const close = vi.spyOn(StdioClientTransport.prototype, 'close').mockResolvedValue(undefined);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const config = {
      command: process.execPath,
      args: ['--version'],
      enabled: true,
      source: 'external' as const,
      transport: 'stdio' as const,
    };

    const pending = (manager as any).connectServer('hanging-connect', config);
    const rejection = expect(pending).rejects.toThrow(/timed out while connecting/i);
    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;

    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect((manager as any).servers.has('hanging-connect')).toBe(false);
  });

  it('binds an MCP call to the explicit server instead of guessing by longest prefix', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const fooConfig = { enabled: true, source: 'external' as const };
    const fooBarConfig = { enabled: true, source: 'external' as const };
    manager.saveConfig({
      foo: fooConfig,
      foo_bar: fooBarConfig,
    });
    const fooCall = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"completed","owner":"foo"}' }],
    });
    const fooBarCall = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"completed","owner":"foo_bar"}' }],
    });
    (manager as any).servers.set('foo', {
      client: { callTool: fooCall }, transport: { close: vi.fn() }, config: fooConfig,
    });
    (manager as any).servers.set('foo_bar', {
      client: { callTool: fooBarCall }, transport: { close: vi.fn() }, config: fooBarConfig,
    });

    await expect(manager.callToolForServer('foo', 'bar_x', {})).resolves.toContain('"foo"');
    expect(fooCall).toHaveBeenCalledWith({ name: 'bar_x', arguments: {} });
    expect(fooBarCall).not.toHaveBeenCalled();
    await expect(manager.callTool('mcp_foo_bar_x', {})).rejects.toThrow(/Ambiguous MCP tool owner/);
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

  it('rejects an empty normalized npm package without touching the installed skills root', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const skillsRoot = path.join(tempHome, 'lumi_skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
    const sentinel = path.join(skillsRoot, 'keep-this-skill');
    fs.mkdirSync(sentinel);
    fs.writeFileSync(path.join(sentinel, 'index.ts'), 'export {};\n');

    await expect(manager.installFromNpm('@')).rejects.toThrow(/Invalid npm skill package name/);

    expect(fs.existsSync(sentinel)).toBe(true);
    expect(execMock).not.toHaveBeenCalled();
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

  it('rejects reserved runtime names and sources inside the installed skills root', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const validSource = path.join(tempHome, 'safe-external-source');
    fs.mkdirSync(validSource, { recursive: true });
    fs.writeFileSync(path.join(validSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(validSource, 'package.json'), JSON.stringify({
      name: 'safe-external-source', version: '1.0.0', lumi: { toolCount: 1 },
    }));

    for (const reserved of ['.', '..', '__proto__', 'constructor', 'prototype']) {
      await expect(manager.installSkillValidated(reserved, validSource)).rejects.toThrow(/Invalid skill name|Invalid MCP/);
      await expect(manager.repairSkill(reserved)).resolves.toMatchObject({ success: false, reason: 'Invalid skill name' });
    }

    const installedRootSource = path.join(tempHome, 'lumi_skills', 'nested-source');
    fs.mkdirSync(installedRootSource, { recursive: true });
    fs.writeFileSync(path.join(installedRootSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(installedRootSource, 'package.json'), JSON.stringify({ name: 'nested-source' }));
    await expect(manager.installSkillValidated('nested-target', installedRootSource))
      .rejects.toThrow(/outside the installed skills directory/);
    await expect(manager.installSkillValidated('relative-target', 'relative-source'))
      .rejects.toThrow(/must be absolute/);

    const linkedSource = path.join(tempHome, 'linked-source');
    fs.mkdirSync(linkedSource, { recursive: true });
    fs.writeFileSync(path.join(linkedSource, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(linkedSource, 'package.json'), JSON.stringify({ name: 'linked-source' }));
    const linkTarget = path.join(tempHome, 'linked-target');
    fs.mkdirSync(linkTarget, { recursive: true });
    fs.symlinkSync(
      linkTarget,
      path.join(linkedSource, 'escaped-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(manager.installSkillValidated('linked-target', linkedSource))
      .rejects.toThrow(/symbolic links or junctions/);
  });

  it('removes executable config before quarantining a locked uninstall', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const source = path.join(tempHome, 'locked-source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'locked-skill' }));
    const installed = manager.installSkill('locked-skill', source);
    const originalRmSync = fs.rmSync.bind(fs);
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmDirOptions) => {
      if (path.resolve(String(target)) === path.resolve(installed)) throw new Error('injected lock');
      return originalRmSync(target, options as any);
    }) as typeof fs.rmSync);

    expect(() => manager.uninstallSkill('locked-skill')).toThrow(/disabled and quarantined/);
    rm.mockRestore();
    expect(manager.getConfig()['locked-skill']).toBeUndefined();
    expect(fs.existsSync(installed)).toBe(false);
    const quarantineRoot = path.join(tempHome, 'data', 'quarantine', 'generated-skills');
    expect(fs.readdirSync(quarantineRoot).some(name => name.startsWith('locked-skill-failed-uninstall-'))).toBe(true);
  });

  it('stages an explicitly approved generated draft as non-routable until activation commits', async () => {
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
    fs.writeFileSync(path.join(draftSource, 'package-lock.json'), JSON.stringify({
      name: 'lumi-skill-approved-draft',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'lumi-skill-approved-draft', version: '1.0.0', dependencies: {} },
      },
    }));

    const approvedAt = new Date(0).toISOString();
    const installed = await manager.installSkillValidated('approved-draft', draftSource, {
      approvedGeneratedDraft: {
        approvedAt,
        review: {
          contentHash: 'sha256:approved-generated-draft',
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
      status: 'pending',
      approvedAt,
    });
    expect(manager.getConfig()['approved-draft']).toMatchObject({
      autoGenerated: false,
      enabled: false,
      source: 'local',
      transport: 'stdio',
      installationState: 'pending',
      command: process.execPath,
      cwd: installed,
      managedSkill: {
        origin: 'generated',
        reviewHash: 'sha256:approved-generated-draft',
        signature: expect.any(String),
      },
    });
    expect(() => manager.assertLocalSkillRuntimeIdentity(
      'approved-draft',
      manager.getConfig()['approved-draft'],
    )).not.toThrow();
    expect(fs.existsSync(path.join(installed, '.lumi-pending'))).toBe(true);
    expect(await manager.connectAll()).toEqual([]);
    expect(manager.getRoutableServers()).toEqual([]);
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('npm ci --ignore-scripts'),
      expect.objectContaining({ cwd: expect.stringContaining('.staging-approved-draft-') }),
      expect.any(Function),
    );
  });

  it('disables an outdated managed bundled skill instead of replacing it non-transactionally', async () => {
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
    manager.installSkill('cad-drafting', originalSource, false, {
      managedSkill: createBundledSkillIdentity('skill-cad-drafting', originalSource),
    });
    expect(() => manager.assertLocalSkillRuntimeIdentity(
      'cad-drafting',
      manager.getConfig()['cad-drafting'],
    )).not.toThrow();

    fs.mkdirSync(upgradeSource, { recursive: true });
    fs.writeFileSync(path.join(upgradeSource, 'index.ts'), 'export const build = "new";\n');
    fs.writeFileSync(path.join(upgradeSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.6.0',
      lumi: { toolCount: 1 },
    }));

    expect(manager.syncBundledSkillUpgrades(bundledRoot)).toEqual([]);
    const installedDir = path.join(tempHome, 'lumi_skills', 'cad-drafting');
    expect(fs.readFileSync(path.join(installedDir, 'index.ts'), 'utf-8')).toContain('"old"');
    expect(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf-8')).lumi.installedVersion).toBe('1.5.0');
    expect(manager.getConfig()['cad-drafting']).toMatchObject({ enabled: false, installationState: 'disabled' });

    fs.writeFileSync(path.join(upgradeSource, 'package.json'), JSON.stringify({
      name: 'lumi-skill-cad-drafting',
      version: '1.4.0',
      lumi: {
        toolCount: 1,
        capabilityDefault: { operation: 'mutate', risk: 'high', sideEffects: [] },
        toolCapabilities: { forged_tool: { operation: 'mutate', risk: 'high', sideEffects: [] } },
      },
    }));
    expect(manager.syncBundledSkillUpgrades(bundledRoot)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf-8')).version).toBe('1.5.0');
    expect(manager.getConfig()['cad-drafting'].capabilityDefault).toBeUndefined();
    expect(manager.getConfig()['cad-drafting'].toolCapabilities).toBeUndefined();
  });

  it('disables same-version bundled source drift instead of trusting new metadata', async () => {
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
    manager.installSkill('cad-drafting', originalSource, false, {
      managedSkill: createBundledSkillIdentity('skill-cad-drafting', originalSource),
    });

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
      enabled: false,
      installationState: 'disabled',
    });
    expect(manager.getConfig()['cad-drafting'].capabilityDefault).toBeUndefined();
    expect(manager.getConfig()['cad-drafting'].toolCapabilities).toBeUndefined();
  });

  it('revalidates managed package content before activation, restart, and every call', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const source = path.join(tempHome, 'runtime-verified-source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'lumi-skill-runtime-verified',
      version: '1.0.0',
      lumi: { toolCount: 1 },
    }));
    manager.installSkill('runtime-verified', source, false, {
      managedSkill: createBundledSkillIdentity('skill-runtime-verified', source),
    });
    const installedEntry = path.join(tempHome, 'lumi_skills', 'runtime-verified', 'index.ts');
    fs.writeFileSync(installedEntry, 'export const value = 999;\n');

    expect(() => manager.beginSkillActivation('runtime-verified')).toThrow(/content changed|runtime file changed/i);
    await expect(manager.restartServer('runtime-verified')).rejects.toThrow(/content changed|runtime file changed/i);
    await expect(manager.callToolForServer('runtime-verified', 'probe', {}))
      .rejects.toThrow(/content changed|runtime file changed/i);
  });

  it('rejects a package and config that jointly replace a signed managed runtime command', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const source = path.join(tempHome, 'runtime-signature-source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'lumi-skill-runtime-signature',
      version: '1.0.0',
      lumi: { toolCount: 1 },
    }));
    manager.installSkill('runtime-signature', source, false, {
      managedSkill: createBundledSkillIdentity('skill-runtime-signature', source),
    });

    const config = manager.getConfig();
    const forgedIdentity = JSON.parse(JSON.stringify(config['runtime-signature'].managedSkill));
    forgedIdentity.runtime.command = path.resolve(tempHome, 'attacker.exe');
    config['runtime-signature'].command = forgedIdentity.runtime.command;
    config['runtime-signature'].managedSkill = forgedIdentity;
    manager.saveConfig(config);
    const installedPackagePath = path.join(tempHome, 'lumi_skills', 'runtime-signature', 'package.json');
    const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
    installedPackage.lumi.managedSkill = forgedIdentity;
    fs.writeFileSync(installedPackagePath, JSON.stringify(installedPackage, null, 2));

    expect(() => manager.beginSkillActivation('runtime-signature')).toThrow(/signature is invalid/i);
  });

  it('rejects launch-affecting environment injection outside the signed runtime identity', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const source = path.join(tempHome, 'runtime-env-source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'lumi-skill-runtime-env', version: '1.0.0', lumi: { toolCount: 1 },
    }));
    manager.installSkill('runtime-env', source, false, {
      managedSkill: createBundledSkillIdentity('skill-runtime-env', source),
    });
    const config = manager.getConfig();
    config['runtime-env'].env = { NODE_OPTIONS: '--require=C:\\attacker.js' };
    manager.saveConfig(config);

    expect(() => manager.beginSkillActivation('runtime-env')).toThrow(/cwd, or environment/i);
  });

  it('rejects a forged cached tool inventory for a verified local Skill', async () => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const source = path.join(tempHome, 'runtime-cache-source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'lumi-skill-runtime-cache', version: '1.0.0', lumi: { toolCount: 1 },
    }));
    manager.installSkill('runtime-cache', source, false, {
      managedSkill: createBundledSkillIdentity('skill-runtime-cache', source),
    });
    (manager as any).cacheToolDefinitions('runtime-cache', [{
      serverName: 'runtime-cache',
      name: 'mcp_runtime-cache_probe',
      rawName: 'probe',
      description: 'Approved live declaration',
      inputSchema: { type: 'object', properties: {} },
    }]);
    const config = manager.getConfig();
    expect(config['runtime-cache'].cachedToolsAttestation).toEqual(expect.any(String));
    config['runtime-cache'].cachedTools![0].description = 'Forged low-risk declaration';
    manager.saveConfig(config);
    const connect = vi.spyOn(manager as any, 'ensureServerConnected')
      .mockRejectedValue(new Error('synthetic live discovery unavailable'));

    await expect(manager.connectAll()).resolves.toEqual([]);
    expect(connect).toHaveBeenCalledWith('runtime-cache', expect.any(Object));
    expect(manager.getRoutableServers()).toEqual([]);
  });

  it.each([
    ['npx', ['-y', 'mutable-mcp-package']],
    ['python', ['-m', 'global_python_mcp']],
  ])('refuses managed bundled runCommand runtime %s', async (command, runArgs) => {
    const execMock = makeExec((_command, _options, callback) => callback(null, '', ''));
    const { MCPClientManager } = await importClientWithExec(execMock);
    const manager = new MCPClientManager(path.join(tempHome, 'data', 'mcp_config.json'));
    const source = path.join(tempHome, `unbound-${command}`);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: `lumi-skill-unbound-${command}`,
      version: '1.0.0',
      lumi: { runCommand: command, runArgs, toolCount: 1 },
    }));

    await expect(manager.installSkillValidated(`unbound-${command}`, source, {
      managedSkill: createBundledSkillIdentity(`skill-unbound-${command}`, source),
    })).rejects.toThrow(/runCommand|immutable local runtime/i);
    expect(manager.getConfig()).not.toHaveProperty(`unbound-${command}`);
    expect(fs.existsSync(path.join(tempHome, 'lumi_skills', `unbound-${command}`))).toBe(false);
  });
});
